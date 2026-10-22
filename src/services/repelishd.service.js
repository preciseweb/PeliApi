const cheerio = require("cheerio");
const { fetchHtml, decodeHtmlBuffer } = require("../utils/http");
const { cleanText, cleanTitle, absoluteUrl, sourceUrl, serverKey, uniqueServers, normalizeSlug, encodedSlug, episodeNumbers } = require("./content.helpers");
const { ApiError } = require("../utils/api-error");
const { getContentSignal } = require('../utils/content-cache');
const axios = require("axios");

const BASE_URL = (process.env.REPELISHD_DOMAIN || "https://repelishd.ceo").replace(/\/+$/, '');

/**
 * Normaliza las URLs para que siempre sean absolutas
 */
function getAbsoluteUrl(path) {
  return absoluteUrl(path, BASE_URL);
}

/**
 * Busca películas en RePelisHD usando la consulta POST de DLE
 */
async function searchContent(query) {
  if (typeof query !== 'string' || !query.trim()) {
    throw new ApiError(400, "El parametro de busqueda 's' o 'q' es requerido");
  }

  query = query.trim();
  const url = `${BASE_URL}/index.php?do=search`;
  const postData = `do=search&subaction=search&story=${encodeURIComponent(query)}`;

  try {
    const response = await axios.post(url, postData, {
      timeout: 15000,
      signal: getContentSignal(),
      responseType: "arraybuffer",
      transformResponse: [],
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        Referer: `${BASE_URL}/`,
      },
    });

    const $ = cheerio.load(decodeHtmlBuffer(response.data, response.headers?.["content-type"]));
    if (!$('#dle-content').length) throw new ApiError(503, 'RePelisHD no devolvió una página de búsqueda válida');
    const results = [];

    // En DLE, los resultados de búsqueda están contenidos dentro de div#dle-content
    $("#dle-content article.item").each((_, element) => {
      const el = $(element);
      const posterDiv = el.find(".poster");
      const posterLink = posterDiv.find("a");
      const href = posterLink.attr("href") || "";
      const img = posterDiv.find("img");
      const poster = getAbsoluteUrl(img.attr("data-src") || img.attr("src") || "");
      
      const titleLink = el.find(".data h3 a");
      const title = cleanTitle(titleLink.text());

      const ratingText = posterDiv.find(".rating").text().trim();
      const rating = ratingText ? ratingText : null;
      
      const yearText = el.find(".data span, .poster span").text().trim();
      const year = yearText.match(/(?:18|19|20|21)\d{2}/)?.[0] || null;

      const path = sourceUrl(href, BASE_URL);
      const match = path && new URL(path).pathname.match(/^\/ver-pelicula\/([^/]+)\.html\/?$/);
      let slug = "";
      try { if (match) slug = normalizeSlug(match[1]); } catch {}

      if (slug && title) {
        results.push({
          id: slug,
          slug,
          title,
          poster,
          rating,
          year,
          type: "movie",
          url: getAbsoluteUrl(href),
        });
      }
    });

    // De-duplicar resultados por slug
    const uniqueResults = [];
    const seen = new Set();
    for (const r of results) {
      if (!seen.has(r.slug)) {
        seen.add(r.slug);
        uniqueResults.push(r);
      }
    }

    return uniqueResults;
  } catch (error) {
    console.error("Error in RePelisHD searchContent:", error.message);
    const signal = getContentSignal();
    if (signal?.aborted) throw signal.reason;
    // A failed source is different from a legitimate search with zero results.
    // Preserve the failure so aggregation can report an outage accurately.
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, 'RePelisHD no respondió a la búsqueda', error.message);
  }
}

/**
 * Obtiene la información detallada y los servidores de una película en RePelisHD
 */
async function getContentInfo(slug, type = "movie") {
  if (!slug) {
    throw new ApiError(400, "El slug del contenido es requerido");
  }

  if (type !== "movie") throw new ApiError(404, "RePelisHD no ofrece episodios de series o anime");
  slug = normalizeSlug(typeof slug === 'string' ? slug.replace(/\.html\/?$/, '') : slug, { prefixes: ["ver-pelicula"] });
  const path = `/ver-pelicula/${encodedSlug(slug)}.html`;
  const url = `${BASE_URL}${path}`;
  
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const title = cleanTitle($("h1").not(".text").first().text() || $(".title").first().text());
  if (!title) {
    throw new ApiError(404, "Contenido no encontrado en RePelisHD");
  }

  const synopsis = cleanText($(".description p").text() || $(".description").first().text());
  const poster = getAbsoluteUrl($(".poster img").first().attr("data-src") || $(".poster img").first().attr("src") || "");

  let year = null;
  const yearMatch = ($("meta[property=\"video:release_date\"]").attr("content") || $(".meta, .info, time").text()).match(/(?:18|19|20|21)\d{2}/);
  if (yearMatch) year = yearMatch[0];

  let rating = $(".starstruck-rating, .dt_rating_vgs").first().text().trim() || null;

  const genres = [];
  $('a[href*="/genero/"]').each((_, el) => {
    if ($(el).closest("nav, header, footer, .navbar, .menu, .dropdown-menu").length) return;
    const text = cleanText($(el).text());
    const href = sourceUrl($(el).attr('href') || '', BASE_URL);
    const path = href && new URL(href).pathname.match(/^\/genero\/([^/]+)\/?$/);
    if (!path) return;
    let gSlug;
    try { gSlug = normalizeSlug(path[1]); } catch { return; }
    if (text && !genres.some(g => g.name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase() === text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase())) {
      genres.push({ name: text, slug: gSlug });
    }
  });

  const contentInfo = {
    id: slug,
    slug,
    title,
    originalTitle: title,
    synopsis,
    poster,
    rating,
    year,
    genres,
    cast: [],
    directors: [],
    type: "movie",
    url,
  };

  const servers = [];
  
  // Buscar iframe del resolver en la página de RePelisHD
  const iframeSrc = $('iframe').toArray().map(element => getAbsoluteUrl($(element).attr('data-src') || $(element).attr('src') || ''))
    .find(src => src && /(^|\.)verhdlink\.cam$/i.test(new URL(src).hostname)) || '';
  if (iframeSrc && /(^|\.)verhdlink\.cam$/i.test(new URL(iframeSrc).hostname)) {
    try {
      // Cargar el player resolver enviando cabecera Referer
      const resolverHtml = await fetchHtml(iframeSrc, { Referer: url });
      const r$ = cheerio.load(resolverHtml);

      // Idiomas: Latino, Castellano, Subtitulado
      const languages = [
        { key: "latino", label: "Latino" },
        { key: "castellano", label: "Castellano" },
        { key: "subtitulado", label: "Subtitulado" }
      ];

      for (const lang of languages) {
        r$(`ul.${lang.key} li`).each((_, el) => {
          const mirror = r$(el);
          const dataLink = mirror.attr("data-link") || "";
          let text = cleanText(mirror.text()).toLowerCase();

          if (dataLink) {
            let embedUrl = absoluteUrl(dataLink, iframeSrc);
            if (!embedUrl) return;
            if (embedUrl.startsWith("//")) {
              embedUrl = `https:${embedUrl}`;
            }

            // Identificar clave del servidor y nombre descriptivo
            let key = serverKey(text, embedUrl);
            let serverName = "Directo";

            if (text.includes("dropload") || embedUrl.includes("dr0pstream") || embedUrl.includes("dropload")) {
              key = "dropload";
              serverName = "Dropload";
            } else if (text.includes("mixdrop") || embedUrl.includes("mixdrop")) {
              key = "mixdrop";
              serverName = "Mixdrop";
            } else if (text.includes("doodstream") || text.includes("dood") || embedUrl.includes("dood")) {
              key = "doodstream";
              serverName = "Doodstream";
            } else if (text.includes("streamwish") || embedUrl.includes("streamwish")) {
              key = "streamwish";
              serverName = "Streamwish";
            } else if (text.includes("fullhd") || text.includes("4k") || text.includes("server 4k")) {
              key = "server4k";
              serverName = "Server 4K";
            }

            servers.push({
              name: serverName === 'Directo' ? cleanText(mirror.text()) || 'Desconocido' : serverName,
              server: key,
              language: lang.label,
              embedUrl,
            });
          }
        });
      }
    } catch (err) {
      console.error("Error fetching player mirrors from verhdlink resolver:", err.message);
      // Metadata without its mirrors used to look like a successful playable
      // result. Keep the resolver failure visible so clients can retry/select.
      if (err instanceof ApiError) throw err;
      throw new ApiError(503, 'No se pudieron obtener los servidores de RePelisHD', err.message);
    }
  }

  contentInfo.servers = uniqueServers(servers);
  return contentInfo;
}

/**
 * Placeholder para compatibilidad con series
 */
async function getEpisodeServers(serieSlug, seasonNumber, episodeNumber) {
  episodeNumbers(seasonNumber, episodeNumber);
  throw new ApiError(404, 'RePelisHD no ofrece episodios de series o anime');
}

module.exports = {
  searchContent,
  getContentInfo,
  getEpisodeServers,
};
