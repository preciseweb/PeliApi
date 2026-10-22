const express = require("express");
const { dailyRateLimit } = require("../middlewares/rate-limit");
const pelisplusService = require("../services/pelisplus.service");
const cuevanaService = require("../services/cuevana.service");
const repelishdService = require("../services/repelishd.service");
const downloadService = require("../services/download.service");
const { resolveEmbedUrl } = require("../utils/resolvers");
const { ApiError } = require("../utils/api-error");
const { episodeNumbers } = require("../services/content.helpers");

const router = express.Router();

function asyncHandler(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (error) {
      next(error);
    }
  };
}

// Aplicar middlewares globales de límites de tráfico (sin requerimiento de API Key)
router.use(dailyRateLimit);

const { normalizeSlug, cleanTitle } = require("../services/content.helpers");
const { createContentCache } = require("../utils/content-cache");
const contentCache = createContentCache();
const services = { pelisplus: pelisplusService, repelishd: repelishdService, cuevana3: cuevanaService };

function scalar(value, label, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !value.trim()) throw new ApiError(400, `${label} no válido`);
  return value.trim();
}

function providerFor(req, slug = "") {
  const requested = scalar(req.query.provider, "Proveedor", "");
  if (requested) {
    if (!Object.hasOwn(services, requested)) throw new ApiError(400, "Proveedor no válido");
    return requested;
  }
  if (slug.startsWith("ver-pelicula/") || slug.includes("-online-espanol")) return "repelishd";
  if (slug.includes("/") && !/^(?:pelicula|serie|anime)\//.test(slug)) return "cuevana3";
  return "pelisplus";
}

function contentType(value, fallback, allowed = ["movie", "series", "anime"]) {
  const type = scalar(value, "Tipo de contenido", fallback);
  if (!allowed.includes(type)) throw new ApiError(400, "Tipo de contenido no válido");
  return type;
}

function cachedRead(prepare) {
  return asyncHandler(async (req, res) => {
    const { key, lifetime, load } = prepare(req);
    const result = await contentCache.get(JSON.stringify(key), lifetime, load);
    res.set("Cache-Control", "no-store");
    res.status(200).json({ success: true, ...result });
  });
}

async function searchProviders(query, requestedProvider, requestedType) {
  let successfulSearches = 0;
  const search = async provider => {
    try {
      const results = await services[provider].searchContent(query);
      if (!Array.isArray(results)) throw new ApiError(502, "Respuesta de búsqueda no válida");
      successfulSearches += 1;
      const seen = new Set();
      return results.filter(item => {
        if (!item || typeof item.title !== "string" || typeof item.slug !== "string" || !item.slug) return false;
        if (requestedType && (item.type === "movie") !== (requestedType === "movie")) return false;
        const key = `${item.type || ""}:${item.slug}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return Boolean(cleanTitle(item.title));
      }).map(item => ({ ...item, title: cleanTitle(item.title), provider }));
    } catch (error) {
      console.error(`Error buscando en ${provider}:`, error.message);
      return [];
    }
  };
  // Lightweight sources run in parallel; browser fallback is used only when
  // no source returned results. An explicit provider never changes identity.
  let data;
  if (requestedProvider) data = await search(requestedProvider);
  else {
    // RePelisHD only publishes movies. Episode searches must not wait for a
    // source that cannot supply the requested series or anime.
    const [ppData, rpData] = await Promise.all([
      search("pelisplus"), requestedType && requestedType !== "movie" ? [] : search("repelishd"),
    ]);
    data = [...rpData, ...ppData];
  }
  if (!requestedProvider && !data.length) data = await search("cuevana3");
  if (!data.length && successfulSearches === 0) {
    throw new ApiError(503, "Los proveedores de búsqueda no respondieron. Reintenta en unos minutos.");
  }
  const titleKey = value => cleanTitle(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const needle = titleKey(query);
  const score = title => {
    const key = titleKey(title);
    return key === needle ? 0 : key.startsWith(needle) ? 1 : key.includes(needle) ? 2 : 3;
  };
  data.sort((a, b) => score(a.title) - score(b.title));
  const providers = new Set(data.map(item => item.provider));
  return { data, source: providers.size === 1 ? data[0].provider : requestedProvider || "aggregate" };
}

/**
 * Buscar contenido (películas, series, anime)
 * GET /search?s=avatar o GET /search?q=avatar; provider es opcional.
 */
router.get("/search", cachedRead(req => {
  const query = scalar(req.query.s ?? req.query.q, "El parámetro de búsqueda 's' o 'q'", "").normalize("NFC");
  if (!query || query.length > 200) throw new ApiError(400, "El parametro de busqueda 's' o 'q' es requerido");
  const provider = req.query.provider === undefined ? "" : providerFor(req);
  const type = req.query.type === undefined ? "" : contentType(req.query.type, "");
  return { key: ["search", query, provider, type], lifetime: 60000, load: () => searchProviders(query, provider, type) };
}));

/**
 * Obtener catálogo filtrado por tipo, género y página
 * GET /catalog?type=movie&genre=accion&page=1
 */
router.get("/catalog", cachedRead(req => {
  const type = contentType(req.query.type, "movie");
  const genre = req.query.genre === undefined || req.query.genre === "" ? "" : normalizeSlug(scalar(req.query.genre, "Género"));
  const page = Number(scalar(req.query.page, "Página", "1"));
  if (!Number.isSafeInteger(page) || page < 1) throw new ApiError(400, "Página no válida");
  return { key: ["catalog", type, genre, page], lifetime: 60000, load: async () => {
    // El catálogo se sirve de PelisPlus porque Cuevana3 no tiene endpoints estructurados.
    const data = await pelisplusService.getCatalog(type, genre, page);
    if (!data || !Array.isArray(data.items)) throw new ApiError(502, "El proveedor devolvió un catálogo no válido");
    return { data: { ...data, items: data.items.map(item => ({ ...item, provider: "pelisplus" })) }, source: "pelisplus" };
  } };
}));

/** Obtener géneros disponibles. GET /genres */
router.get("/genres", cachedRead(() => ({
  key: ["genres"], lifetime: 600000,
  load: async () => ({ data: await pelisplusService.getGenres(), source: "pelisplus" }),
})));

/**
 * Obtener detalles y servidores de reproducción de una película o serie
 * GET /info/:slug?type=movie
 */
router.get("/info/*", cachedRead(req => {
  const slug = normalizeSlug(req.params[0], { nested: true });
  const fallback = slug.startsWith("anime/") ? "anime" : slug.startsWith("serie/") ? "series" : "movie";
  const type = contentType(req.query.type, fallback);
  const provider = providerFor(req, slug);
  return { key: ["info", provider, type, slug], lifetime: type === "movie" ? 20000 : 60000, load: async () => {
    // A slug belongs to its provider. Reusing it on a different site can return
    // another title or an empty page; callers must select a confirmed match.
    const data = await services[provider].getContentInfo(slug, type);
    if (!data || typeof data !== "object") throw new ApiError(502, "El proveedor devolvió una ficha no válida");
    return { data: { ...data, provider }, source: provider };
  } };
}));

/**
 * Obtener servidores de reproducción para un capítulo de una serie o anime
 * GET /servers?slug=breaking-bad&season=1&episode=1
 */
router.get("/servers", cachedRead(req => {
  const slug = normalizeSlug(scalar(req.query.slug ?? req.query.serieSlug, "El slug de la serie"), { nested: true });
  const { seasonNumber: season, episodeNumber: episode } = episodeNumbers(
    scalar(req.query.season, "Temporada", "1"), scalar(req.query.episode, "Episodio", "1")
  );
  if (!Number.isSafeInteger(season) || !Number.isSafeInteger(episode)) throw new ApiError(400, "Temporada o episodio no válido");
  const type = contentType(req.query.type, slug.startsWith("anime/") ? "anime" : "series", ["series", "anime"]);
  const provider = providerFor(req, slug);
  return { key: ["servers", provider, type, slug, season, episode], lifetime: 15000, load: async () => {
    const data = await services[provider].getEpisodeServers(slug, season, episode, type);
    if (!data || !Array.isArray(data.servers)) throw new ApiError(502, "El proveedor devolvió servidores no válidos");
    return { data, source: provider };
  } };
}));

/**
 * Resolver una URL de embed a enlace directo de video (.mp4, .m3u8)
 * GET /resolve?url=https://streamwish.to/e/xxx
 */
router.get(
  "/resolve",
  asyncHandler(async (req, res) => {
    const embedUrl = req.query.url;
    const parentUrl = req.query.parentUrl || null;
    if (!embedUrl) {
      throw new ApiError(400, "Se requiere el parametro 'url' del embed");
    }

    const directUrl = await resolveEmbedUrl(embedUrl, parentUrl);
    res.status(200).json({
      success: true,
      data: {
        embedUrl,
        directUrl,
      },
      source: "pelisplus",
    });
  })
);

/**
 * Iniciar la descarga de una película o capítulo de serie
 * POST /download
 * Body: { url: "https://www.pelisplushd.la/pelicula/xxx", variant: "Latino", preferredServer: "streamwish" }
 */
router.post(
  "/download",
  asyncHandler(async (req, res) => {
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const data = downloadService.createDownload(req.body || {}, baseUrl);

    res.status(200).json({
      success: true,
      data,
      source: "pelisplus",
    });
  })
);

/**
 * Obtener estado de una descarga específica
 * GET /download/:id
 */
router.get(
  "/download/:id",
  asyncHandler(async (req, res) => {
    const data = downloadService.getDownload(req.params.id);

    res.status(200).json({
      success: true,
      data,
      source: "pelisplus",
    });
  })
);

/**
 * Iniciar descargas en lote (batch) para múltiples capítulos de una serie
 * POST /batch
 * Body: { mediaUrl: "https://www.pelisplushd.la/serie/xxx", season: 1, episodes: [1, 2, 3], variant: "Latino" }
 */
router.post(
  "/batch",
  asyncHandler(async (req, res) => {
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const data = downloadService.createBatch(req.body || {}, baseUrl);

    res.status(200).json({
      success: true,
      data,
      source: "pelisplus",
    });
  })
);

/**
 * Obtener estado de una descarga en lote específica
 * GET /batch/:id
 */
router.get(
  "/batch/:id",
  asyncHandler(async (req, res) => {
    const data = downloadService.getBatch(req.params.id);

    res.status(200).json({
      success: true,
      data,
      source: "pelisplus",
    });
  })
);

module.exports = router;
