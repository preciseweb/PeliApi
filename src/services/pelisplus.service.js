const cheerio = require("cheerio");
const { fetchHtml } = require("../utils/http");
const { ApiError } = require("../utils/api-error");
const { cleanText, cleanTitle, absoluteUrl, normalizeSlug, encodedSlug, episodeNumbers, uniqueText } = require("./content.helpers");

const BASE_URL = process.env.PELISPLUS_DOMAIN || "https://www.pelisplushd.la";

/**
 * Normaliza las URLs para que siempre apunten a nuestro dominio o sean absolutas
 */
function getAbsoluteUrl(path) {
  return absoluteUrl(path, BASE_URL);
}

/**
 * Obtiene el tipo del contenido (movie, series, anime) a partir del path
 */
function detectTypeFromPath(path) {
  if (!path) return "movie";
  if (path.includes("/pelicula/")) return "movie";
  if (path.includes("/serie/")) return "series";
  if (path.includes("/anime/")) return "anime";
  return "movie";
}

/**
 * Extrae el slug a partir del path de PelisPlus
 */
function extractSlugFromPath(path) {
  // Ejemplos:
  // /pelicula/el-padrino -> "el-padrino"
  // /serie/breaking-bad -> "breaking-bad"
  // /anime/naruto -> "naruto"
  const url = getAbsoluteUrl(path);
  if (!url) return '';
  const parts = new URL(url).pathname.split('/').filter(Boolean);
  if (!['pelicula', 'serie', 'anime'].includes(parts[0]) || parts.length !== 2) return '';
  try { return normalizeSlug(parts[1]); } catch { return ''; }
}

/**
 * Busca contenido en PelisPlus
 */
async function searchContent(query) {
  if (!query) {
    throw new ApiError(400, "El parametro de busqueda 's' o 'q' es requerido");
  }

  const url = `${BASE_URL}/search?s=${encodeURIComponent(query)}`;
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const results = [];

  $("a.Posters-link").each((_, element) => {
    const el = $(element);
    const href = el.attr("href") || "";
    const title = cleanTitle(el.attr("data-title") || el.find(".listing-content p").text());
    const poster = getAbsoluteUrl(el.find("img.Posters-img").attr("data-src") || el.find("img.Posters-img").attr("src") || "");
    const ratingText = el.find(".rating span").text().trim();
    const rating = ratingText ? ratingText.split("/")[0] : null;
    const type = detectTypeFromPath(href);
    const slug = extractSlugFromPath(href);

    if (slug && title) {
      results.push({
        id: slug,
        slug,
        title,
        poster,
        rating,
        type,
        url: getAbsoluteUrl(href),
      });
    }
  });

  return [...results.reduce((unique, item) => {
    const key = `${item.type}:${item.slug}`;
    if (!unique.has(key)) unique.set(key, item);
    return unique;
  }, new Map()).values()];
}

/**
 * Obtiene el catalogo por tipo (movies, series, anime), genero, año, etc.
 */
async function getCatalog(type = "movie", genre = "", page = 1) {
  let path = "";
  if (genre) {
    path = `/generos/${encodedSlug(normalizeSlug(genre))}`;
  } else {
    switch (type) {
      case "series":
        path = "/series";
        break;
      case "anime":
        path = "/animes";
        break;
      case "movie":
      default:
        path = "/peliculas";
        break;
    }
  }

  if (!["movie", "series", "anime"].includes(type) || !Number.isInteger(Number(page)) || Number(page) < 1) throw new ApiError(400, "El tipo o la página del catálogo no son válidos");
  const separator = path.includes("?") ? "&" : "?";
  const url = `${BASE_URL}${path}${separator}page=${page}`;
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const items = [];

  $("a.Posters-link").each((_, element) => {
    const el = $(element);
    const href = el.attr("href") || "";
    const title = cleanTitle(el.attr("data-title") || el.find(".listing-content p").text());
    const poster = getAbsoluteUrl(el.find("img.Posters-img").attr("data-src") || el.find("img.Posters-img").attr("src") || "");
    const ratingText = el.find(".rating span").text().trim();
    const rating = ratingText ? ratingText.split("/")[0] : null;
    const contentType = detectTypeFromPath(href);
    const slug = extractSlugFromPath(href);

    if (slug && title) {
      items.push({
        id: slug,
        slug,
        title,
        poster,
        rating,
        type: contentType,
        url: getAbsoluteUrl(href),
      });
    }
  });

  // Paginación
  const hasNextPage = $(".pagination a[rel='next']").length > 0 || $(".pagination .page-item:last-child:not(.disabled) a").length > 0;

  return {
    items: [...items.reduce((unique, item) => {
      const key = `${item.type}:${item.slug}`;
      if (!unique.has(key)) unique.set(key, item);
      return unique;
    }, new Map()).values()],
    page: Number(page),
    hasNextPage,
  };
}

/**
 * Obtiene la información detallada de una película o serie
 */
async function getContentInfo(slug, type = "movie") {
  if (!slug) {
    throw new ApiError(400, "El slug del contenido es requerido");
  }

  if (!['movie', 'series', 'anime'].includes(type)) throw new ApiError(400, 'El tipo de contenido no es válido');
  slug = normalizeSlug(slug, { prefixes: ['pelicula', 'serie', 'anime'] });
  const prefixes = type === 'movie' ? ['pelicula'] : type === 'anime' ? ['anime', 'serie'] : ['serie', 'anime'];
  let url, $, lastError;
  for (const prefix of prefixes) {
    url = `${BASE_URL}/${prefix}/${encodedSlug(slug)}`;
    try {
      $ = cheerio.load(await fetchHtml(url));
      if ($('h1.m-b-5, .font-size-26.font-weight-bold').first().text().trim()) break;
      throw new ApiError(404, 'Contenido no encontrado en PelisPlus');
    } catch (error) { lastError = error; $ = null; }
  }
  if (!$) throw lastError;

  const title = cleanTitle($("h1.m-b-5").first().text() || $(".font-size-26.font-weight-bold").first().text());
  if (!title) {
    throw new ApiError(404, "Contenido no encontrado en PelisPlus");
  }

  const originalTitle = cleanText($("p.text-opacity").first().text()).replace(/^@\s*/, "");
  const synopsis = cleanText($(".text-large").first().text() || $("#synopsis").first().text());
  const posterImage = $(".poster img, .movie-poster img, img.img-fluid.m-b-15, img.img-fluid.m-b-30, img.img-fluid.rounded").first();
  const poster = getAbsoluteUrl(posterImage.attr("data-src") || posterImage.attr("src") || $("meta[property=\"og:image\"]").attr("content") || "");
  const ratingVal = $(".font-size-36.font-weight-bold").text().trim();
  const rating = ratingVal ? ratingVal : null;
  const yearMatch = $(".font-size-18.text-info").text().trim().match(/\d{4}/);
  const year = yearMatch ? yearMatch[0] : null;

  const genres = [];
  $("a[href*='/generos/']").each((_, el) => {
    if ($(el).closest('nav, header, footer, .navbar, .dropdown-menu, .nav-item').length) return;
    const text = cleanText($(el).text());
    const href = getAbsoluteUrl($(el).attr('href') || '');
    if (!href) return;
    const gSlug = new URL(href).pathname.split('/').filter(Boolean).pop();
    const key = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    if (text && !genres.some(genre => genre.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase() === key)) genres.push({ name: text, slug: gSlug });
  });

  // Metadatos adicionales (elenco, director). Ignore wrappers containing nested fields.
  const cast = [];
  const directors = [];
  $(".sectionDetail").each((_, el) => {
    const field = $(el);
    if (field.find('.sectionDetail').length) return;
    const text = cleanText(field.text());
    const names = field.find('a').map((_, link) => cleanText($(link).text())).get();
    if (/Director(?:a|es)?\s*:/i.test(text)) directors.push(...names);
    else if (/(?:Elenco|Actores|Reparto)\s*:/i.test(text)) cast.push(...names);
  });

  const contentInfo = {
    id: slug,
    slug,
    title,
    originalTitle,
    synopsis,
    poster,
    rating,
    year,
    genres,
    cast: uniqueText(cast),
    directors: uniqueText(directors),
    type,
    url,
  };

  if (type === "movie") {
    // Si es película, obtenemos los servidores de reproducción de una vez
    contentInfo.servers = parseServers($);
  } else {
    // Si es serie, obtenemos la estructura de temporadas y capítulos
    contentInfo.seasons = [];
    
    // Las series suelen estructurar temporadas en paneles o listas.
    // Read every episode link, even when .divseason exists without an adjacent ul.
    const seasonsMap = new Map();
    $("a[href*='/temporada/']").each((_, epLink) => {
      const epHref = getAbsoluteUrl($(epLink).attr('href') || '');
      const match = epHref.match(/\/temporada\/(\d+)\/capitulo\/(\d+)(?:[/?#]|$)/i);
      if (!match) return;
      const season = Number(match[1]);
      const number = Number(match[2]);
      if (number < 1) return;
      if (!seasonsMap.has(season)) seasonsMap.set(season, new Map());
      const episodes = seasonsMap.get(season);
      if (!episodes.has(number)) episodes.set(number, {
        number, title: cleanText($(epLink).text()) || `Episodio ${number}`, url: epHref, season,
      });
    });
    contentInfo.seasons = [...seasonsMap].map(([number, episodes]) => ({
      number, name: `Temporada ${number}`, episodes: [...episodes.values()].sort((a, b) => a.number - b.number),
    })).sort((a, b) => a.number - b.number);
  }

  return contentInfo;
}

/**
 * Obtiene los servidores y URLs de reproducción de un episodio específico
 */
async function getEpisodeServers(serieSlug, seasonNumber, episodeNumber, type = 'series') {
  serieSlug = normalizeSlug(serieSlug, { prefixes: ['serie', 'anime'] });
  ({ seasonNumber, episodeNumber } = episodeNumbers(seasonNumber, episodeNumber));
  if (!['series', 'anime'].includes(type)) throw new ApiError(400, 'El tipo de episodio no es válido');
  const prefixes = type === 'anime' ? ['anime', 'serie'] : ['serie', 'anime'];
  let lastError;
  let emptyEpisode;
  for (const prefix of prefixes) {
    const url = `${BASE_URL}/${prefix}/${encodedSlug(serieSlug)}/temporada/${seasonNumber}/capitulo/${episodeNumber}`;
    try {
      const $ = cheerio.load(await fetchHtml(url));
      const title = cleanTitle($('h1.m-b-5, .font-size-26.font-weight-bold').first().text());
      const servers = parseServers($);
      if (!title && !servers.length) throw new ApiError(404, 'Episodio no encontrado en PelisPlus');
      const result = { serieSlug, season: seasonNumber, episode: episodeNumber, title, servers, url };
      if (servers.length) return result;
      // Some anime paths return a valid heading but keep the embeds under /serie/.
      // Try the other route before declaring that an existing episode has no links.
      if (!emptyEpisode) emptyEpisode = result;
    } catch (error) { lastError = error; }
  }
  if (emptyEpisode) return emptyEpisode;
  throw lastError;
}

/**
 * Parsea los servidores de la página cargada en Cheerio ($)
 */
function parseServers($) {
  const servers = [];

  // Método 1: Estilo moderno con #link_url span + .TbVideoNv li (usado en series/capítulos)
  if ($("#link_url span").length > 0) {
    const generalLanguage = cleanText($(".divseason").first().text()) || "Latino";

    const serverNamesMap = new Map();
    $(".TbVideoNv li, .VideoPlayer li").each((_, liEl) => {
      const li = $(liEl);
      const id = li.attr("data-id") || li.attr("lid") || "";
      const name = cleanText(li.text());
      if (id && name) {
        serverNamesMap.set(id, name);
      }
    });

    $("#link_url span").each((_, spanEl) => {
      const span = $(spanEl);
      const lid = span.attr("lid") || "";
      const embedUrl = getAbsoluteUrl(span.attr("url") || span.attr("data-url") || "");
      const name = serverNamesMap.get(lid) || "Desconocido";

      if (embedUrl) {
        let serverKey = name.toLowerCase().replace(/[^a-z0-9]/g, "");
        if (serverKey.includes("streamwish") || embedUrl.includes("streamwish")) serverKey = "streamwish";
        else if (serverKey.includes("voesx") || serverKey.includes("voe") || embedUrl.includes("voe.sx")) serverKey = "voesx";
        else if (serverKey.includes("streamtape") || embedUrl.includes("streamtape")) serverKey = "streamtape";
        else if (serverKey.includes("netu") || serverKey.includes("hqq") || embedUrl.includes("hqq") || embedUrl.includes("waaw") || embedUrl.includes("netu")) serverKey = "netu";
        else if (serverKey.includes("vidhide") || embedUrl.includes("vidhide")) serverKey = "vidhide";

        servers.push({
          name: name,
          server: serverKey,
          language: cleanText(span.attr("data-name") || span.attr("data-language") || generalLanguage),
          embedUrl: embedUrl,
        });
      }
    });
  }

  // Método 2: Estilo clásico con li.playurl (usado en películas)
  {
    $("li.playurl").each((_, el) => {
      const element = $(el);
      const embedUrl = getAbsoluteUrl(element.attr("data-url") || "");
      const language = cleanText(element.attr("data-name")) || "Subtitulado";
      const name = cleanText(element.find("a").text() || element.text()) || "Desconocido";

      if (embedUrl) {
        let serverKey = name.toLowerCase().replace(/[^a-z0-9]/g, "");
        if (serverKey.includes("streamwish") || embedUrl.includes("streamwish")) serverKey = "streamwish";
        else if (serverKey.includes("voesx") || serverKey.includes("voe") || embedUrl.includes("voe.sx")) serverKey = "voesx";
        else if (serverKey.includes("streamtape") || embedUrl.includes("streamtape")) serverKey = "streamtape";
        else if (serverKey.includes("netu") || serverKey.includes("hqq") || embedUrl.includes("hqq") || embedUrl.includes("waaw") || embedUrl.includes("netu")) serverKey = "netu";
        else if (serverKey.includes("vidhide") || embedUrl.includes("vidhide")) serverKey = "vidhide";

        servers.push({
          name: name,
          server: serverKey,
          language: language,
          embedUrl: embedUrl,
        });
      }
    });
  }

  return [...new Map(servers.map(server => [`${server.embedUrl}\n${server.language}`, server])).values()];
}

/**
 * Obtiene la lista completa de géneros disponibles
 */
async function getGenres() {
  const html = await fetchHtml(BASE_URL);
  const $ = cheerio.load(html);
  const genres = [];

  $("a[href^='/generos/']").each((_, el) => {
    const text = cleanText($(el).text());
    const slug = $(el).attr("href").split("/").pop();
    if (text && !genres.some((g) => g.slug === slug)) {
      genres.push({ name: text, slug });
    }
  });

  // Fallback si no parseó nada de la home (por ej. si está detrás de un Cloudflare simple)
  if (genres.length === 0) {
    const staticGenres = [
      { name: "Acción", slug: "accion" },
      { name: "Animación", slug: "animacion" },
      { name: "Aventura", slug: "aventura" },
      { name: "Ciencia Ficción", slug: "ciencia-ficcion" },
      { name: "Comedia", slug: "comedia" },
      { name: "Drama", slug: "drama" },
      { name: "Fantasía", slug: "fantasia" },
      { name: "Romance", slug: "romance" },
      { name: "Terror", slug: "terror" },
      { name: "Suspenso", slug: "suspenso" },
      { name: "Anime", slug: "anime" },
    ];
    return staticGenres;
  }

  return genres.sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = {
  searchContent,
  getCatalog,
  getContentInfo,
  getEpisodeServers,
  getGenres,
};
