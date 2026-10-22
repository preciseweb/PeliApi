const cheerio = require('cheerio');
const { fetchHtml } = require('../utils/http');
const { scrapeWithPage } = require('../utils/browser');
const { ApiError } = require('../utils/api-error');
const { cleanText, cleanTitle, absoluteUrl, sourceUrl, serverKey, uniqueServers, normalizeSlug, encodedSlug, episodeNumbers, repairMetadata } = require('./content.helpers');

const BASE_URL = (process.env.CUEVANA_DOMAIN || 'https://ww9.cuevana3.to').replace(/\/+$/, '');

// Most Cuevana pages render their metadata and embeds in HTML. Avoid requiring a
// Chromium process for those pages; retain browser fallback for challenges only.
async function readContent(url, parse) {
  try {
    const html = await fetchHtml(url);
    const result = parse(cheerio.load(html));
    if (result !== null) return result;
  } catch (error) {
    if ((error.upstreamStatus || error.statusCode) === 404) throw new ApiError(404, 'Contenido no encontrado en Cuevana3');
    if (![403, 429, 503].includes(error.upstreamStatus || error.statusCode)) throw error;
  }
  const rendered = await scrapeWithPage(url, () => document.documentElement.outerHTML);
  // Preserve compatibility with browser adapters which already extract metadata.
  if (rendered && typeof rendered === 'object') return rendered;
  const result = typeof rendered === 'string' ? parse(cheerio.load(rendered)) : null;
  if (result === null) throw new ApiError(503, 'Cuevana3 no devolvió una página de contenido válida');
  return result;
}

function contentSlug(href) {
  const url = sourceUrl(href, BASE_URL);
  if (!url) return '';
  // ej: "2225/scary-movie-2" o "serie/como-peces-dorados"
  const path = new URL(url).pathname.replace(/^\/+|\/+$/g, '');
  if (!/^(?:serie|anime|pelicula|\d+)\/[^/]+$/.test(path)) return '';
  try { return normalizeSlug(path, { nested: true }); } catch { return ''; }
}

function parseSearch($) {
  const cards = $('.MovieList .TPost, .MovieList li, .TPost');
  if (!cards.length && !$('.MovieList, .NoResults, .no-results').length
    && !/no se (?:encontraron|han encontrado) resultados|sin resultados/i.test($('main, #content').text())) return null;
  const results = [];
  cards.each((_, element) => {
    const card = $(element);
    const link = card.find('a').first();
    const url = sourceUrl(link.attr('href') || '', BASE_URL);
    const slug = contentSlug(url);
    const title = cleanTitle(card.find('.Title').first().text());
    if (!slug || !title) return;
    const image = card.find('img').first();
    results.push({
      id: slug, slug, title, url,
      type: slug.startsWith('serie/') ? 'series' : slug.startsWith('anime/') ? 'anime' : 'movie',
      poster: absoluteUrl(image.attr('data-src') || image.attr('src') || '', BASE_URL),
      rating: cleanText(card.find('.Vote').first().text()) || null,
      year: cleanText(card.find('.Year').first().text()).match(/(?:18|19|20|21)\d{2}/)?.[0] || null,
    });
  });
  // De-duplicar resultados por slug
  return [...new Map(results.map(item => [item.slug, item])).values()];
}

/**
 * Busca contenido en Cuevana3 usando Puppeteer
 */
async function searchContent(query) {
  if (typeof query !== 'string' || !query.trim()) throw new ApiError(400, "El parametro de busqueda 's' o 'q' es requerido");
  const url = `${BASE_URL}/?s=${encodeURIComponent(query.trim())}`;
  const response = await readContent(url, parseSearch);
  return repairMetadata(response || []).map(item => ({ ...item, title: cleanTitle(item.title) }));
}

function parseServers($) {
  const servers = [];
  const panels = $('.TPlayerTb').toArray();
  const panelsById = new Map(panels.map(element => [$(element).attr('id'), element]));
  const menus = $('.TPlayerNv > li.open_submenu');
  let iframeIndex = 0;

  function add(button, language) {
    const targetElement = button.is('[data-tplayernv], [data-target], [href]') ? button : button.find('[data-tplayernv], [data-target], a[href]').first();
    const href = targetElement.attr('href') || '';
    const target = targetElement.attr('data-tplayernv') || targetElement.attr('data-target') || (href.startsWith('#') ? href : '');
    const targetId = target.replace(/^#/, '');
    // Explicit tab identities survive missing/reordered panels. Never substitute
    // another language's iframe when a declared target does not exist.
    const panel = target && !target.includes('/') ? panelsById.get(targetId) : panels[iframeIndex];
    iframeIndex++;
    if (!panel) return;
    const iframe = $(panel).find('iframe').first();
    const embedUrl = absoluteUrl(iframe.attr('data-src') || iframe.attr('src') || '', BASE_URL);
    if (!embedUrl) return;
    const fullName = cleanText(button.text());
    const name = cleanText(fullName.replace(/^\d+\s*[-.:]\s*/, '')) || cleanText(iframe.attr('title')) || 'Desconocido';
    servers.push({ name, server: serverKey(name, embedUrl), language: language || 'Desconocido', embedUrl });
  }

  menus.each((_, element) => {
    const menu = $(element);
    const label = menu.clone();
    label.children('ul, .sub-menu, .dropdown-menu').remove();
    const language = cleanText(label.text()).split(/CALIDAD/i)[0].trim() || cleanText(menu.find('img').first().attr('alt')) || 'Desconocido';
    menu.find('ul li, .clili').filter((_, button) => !$(button).find('li, .clili').length).each((_, button) => add($(button), language));
  });
  if (!menus.length) {
    const buttons = $('.TPlayerNv li').filter((_, element) => !$(element).find('li').length);
    buttons.each((_, element) => add($(element), cleanText($(element).attr('data-language'))));
    if (!buttons.length) {
      for (const panel of panels) {
        const iframe = $(panel).find('iframe').first();
        const embedUrl = absoluteUrl(iframe.attr('data-src') || iframe.attr('src') || '', BASE_URL);
        if (!embedUrl) continue;
        const name = cleanText($(panel).attr('data-server') || iframe.attr('title')) || 'Desconocido';
        servers.push({ name, server: serverKey(name, embedUrl), language: cleanText($(panel).attr('data-language')) || 'Desconocido', embedUrl });
      }
    }
  }
  return uniqueServers(servers);
}

function parseSeasons($, slug) {
  const seasonsMap = new Map();
  const owner = slug.replace(/^(?:serie|anime)\//, '');
  $('a[href*="/episodio/"]').each((_, element) => {
    const href = sourceUrl($(element).attr('href') || '', BASE_URL);
    const match = href && new URL(href).pathname.match(/^\/episodio\/(.+)-(\d+)x(\d+)\/?$/);
    if (!match) return;
    let episodeOwner;
    try { episodeOwner = normalizeSlug(match[1], { nested: true }); } catch { return; }
    const season = Number(match[2]);
    const number = Number(match[3]);
    if (episodeOwner !== owner || !Number.isSafeInteger(season) || !Number.isSafeInteger(number) || number < 1) return;
    if (!seasonsMap.has(season)) seasonsMap.set(season, new Map());
    if (!seasonsMap.get(season).has(number)) seasonsMap.get(season).set(number, {
      number, title: cleanText($(element).text()) || `Episodio ${number}`, url: href, season,
    });
  });
  return [...seasonsMap].map(([number, episodes]) => ({ number, name: `Temporada ${number}`, episodes: [...episodes.values()].sort((a, b) => a.number - b.number) })).sort((a, b) => a.number - b.number);
}

/**
 * Obtiene la información detallada de una película o serie de Cuevana3
 */
async function getContentInfo(slug, type = 'movie') {
  if (!['movie', 'series', 'anime'].includes(type)) throw new ApiError(400, 'El tipo de contenido no es válido');
  slug = normalizeSlug(slug, { nested: true });
  const url = `${BASE_URL}/${encodedSlug(slug)}`;
  const result = await readContent(url, $ => {
    const title = cleanTitle($('h1.Title').first().text());
    if (!title) return null;
    // Check type inside browser by checking page structure or url pattern
    const isSeriesPage = /^(?:serie|anime)\//.test(slug) || type !== 'movie';
    const image = $('.Image img').first();
    const info = {
      title, originalTitle: title,
      synopsis: cleanText($('.Description p, .Description').first().text()),
      poster: absoluteUrl(image.attr('data-src') || image.attr('src') || '', BASE_URL),
      year: cleanText($('.InfoList li, .InfoList .Date, .Year').text()).match(/(?:18|19|20|21)\d{2}/)?.[0] || null,
      rating: cleanText($('.percircle, .Vote').first().text()) || null,
      genres: [], cast: [], directors: [], url,
    };
    // Parsear géneros
    $('.InfoList a[href*="/genero/"], .Description a[href*="/genero/"], .Genres a[href*="/genero/"]').each((_, element) => {
      const name = cleanText($(element).text());
      const href = sourceUrl($(element).attr('href'), BASE_URL);
      const match = href && new URL(href).pathname.match(/^\/genero\/([^/]+)\/?$/);
      if (name && match && !info.genres.some(genre => genre.name === name)) info.genres.push({ name, slug: match[1] });
    });
    if (!isSeriesPage) {
      // Parsear servidores de reproducción
      info.servers = parseServers($);
    } else {
      // Parsear temporadas y capítulos para series
      info.seasons = parseSeasons($, slug);
    }
    return info;
  });
  if (!cleanText(result?.title)) throw new ApiError(404, 'Contenido no encontrado en Cuevana3');
  return repairMetadata({ ...result, title: cleanTitle(result.title), id: slug, slug, type });
}

/**
 * Obtiene los servidores y URLs de reproducción de un episodio específico de Cuevana3
 */
async function getEpisodeServers(serieSlug, seasonNumber, episodeNumber) {
  // Los capítulos en Cuevana3 tienen la estructura /episodio/slug-temporadaxcapitulo
  serieSlug = normalizeSlug(serieSlug, { nested: true });
  ({ seasonNumber, episodeNumber } = episodeNumbers(seasonNumber, episodeNumber));
  const coreSlug = serieSlug.replace(/^(?:serie|anime)\//, '');
  const url = `${BASE_URL}/episodio/${encodedSlug(coreSlug)}-${seasonNumber}x${episodeNumber}`;
  const result = await readContent(url, $ => {
    if (!$('h1.Title, .TPlayerNv, .TPlayerTb').length) return null;
    return { servers: parseServers($) };
  });
  return { serieSlug, season: seasonNumber, episode: episodeNumber, servers: repairMetadata(result?.servers || []), url };
}

module.exports = { searchContent, getContentInfo, getEpisodeServers };
