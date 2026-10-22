const { ApiError } = require('../utils/api-error');
const { repairText } = require('../utils/text');

function cleanText(value) {
  return repairText(value == null ? '' : String(value)).replace(/\s+/g, ' ').trim();
}

function cleanTitle(value) {
  let title = cleanText(value);
  const suffix = /\s+online(?:\s+gratis)?(?:\s+(?:full\s+)?hd)?\s*$/i;
  if (suffix.test(title)) title = title.replace(/^ver\s+/i, '').replace(suffix, '');
  return title.trim();
}

function absoluteUrl(value, base) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value.trim(), base);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

// Content and pagination links belong to their source. Mirror URLs deliberately
// use absoluteUrl instead, because video hosts are expected to be external.
function sourceUrl(value, base) {
  const url = absoluteUrl(value, base);
  if (!url) return '';
  const source = new URL(base);
  const candidate = new URL(url);
  return candidate.hostname.replace(/^www\./i, '') === source.hostname.replace(/^www\./i, '')
    && candidate.port === source.port ? url : '';
}

function serverKey(name, url) {
  const label = cleanText(name).toLowerCase().replace(/[^a-z0-9]/g, '');
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch {}
  const value = `${label} ${host}`;
  if (/streamwish/.test(value)) return 'streamwish';
  if (/voe/.test(value)) return 'voesx';
  if (/streamtape/.test(value)) return 'streamtape';
  if (/netu|hqq|waaw/.test(value)) return 'netu';
  if (/vidhide/.test(value)) return 'vidhide';
  if (/filelions/.test(value)) return 'filelions';
  if (/mixdrop/.test(value)) return 'mixdrop';
  if (/doodstream|dood/.test(value)) return 'doodstream';
  if (/dropload|dr0pstream/.test(value)) return 'dropload';
  return label && label !== 'desconocido' ? label : 'unknown';
}

function uniqueServers(servers) {
  const seen = new Set();
  return servers.filter(server => {
    const key = `${server.embedUrl}\n${cleanText(server.language).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()}`;
    if (!server.embedUrl || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Decode path segments once, then encode only when constructing a request URL.
function normalizeSlug(value, { nested = false, prefixes = [] } = {}) {
  if (typeof value !== 'string' || !value.trim() || value.length > 1800) throw new ApiError(400, 'El slug del contenido no es válido');
  let segments;
  try { segments = value.trim().replace(/^\/+|\/+$/g, '').split('/').map(decodeURIComponent); }
  catch { throw new ApiError(400, 'El slug del contenido no es válido'); }
  if (prefixes.includes(segments[0])) segments.shift();
  if (!segments.length || (!nested && segments.length !== 1) || segments.some(segment => !segment || segment === '.' || segment === '..' || /[\\/?#%\u0000-\u001f\u007f]/.test(segment))) {
    throw new ApiError(400, 'El slug del contenido no es válido');
  }
  return segments.join('/');
}

function encodedSlug(slug) {
  return slug.split('/').map(encodeURIComponent).join('/');
}

function episodeNumbers(season, episode) {
  const seasonNumber = Number(season);
  const episodeNumber = Number(episode);
  if (!Number.isSafeInteger(seasonNumber) || seasonNumber < 0 || !Number.isSafeInteger(episodeNumber) || episodeNumber < 1) {
    throw new ApiError(400, 'La temporada y el episodio deben ser números válidos');
  }
  return { seasonNumber, episodeNumber };
}

function uniqueText(values) {
  const seen = new Set();
  return values.map(cleanText).filter(value => {
    const key = value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Metadata repair is deliberately limited to text. URLs, slugs and tokens remain unchanged.
function repairMetadata(value) {
  if (Array.isArray(value)) return value.map(repairMetadata);
  if (!value || typeof value !== 'object') return value;
  const result = { ...value };
  for (const key of ['title', 'originalTitle', 'synopsis', 'name', 'language']) {
    if (typeof result[key] === 'string') result[key] = cleanText(result[key]);
  }
  for (const key of ['genres', 'seasons', 'episodes', 'servers']) {
    if (Array.isArray(result[key])) result[key] = result[key].map(repairMetadata);
  }
  for (const key of ['cast', 'directors']) {
    if (Array.isArray(result[key])) result[key] = uniqueText(result[key]);
  }
  return result;
}

module.exports = { cleanText, cleanTitle, absoluteUrl, sourceUrl, serverKey, uniqueServers, normalizeSlug, encodedSlug, episodeNumbers, uniqueText, repairMetadata };
