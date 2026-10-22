const axios = require("axios");
const http = require("node:http");
const https = require("node:https");
const { URL } = require("node:url");
const { TextDecoder } = require("node:util");
const { ApiError } = require("./api-error");
const { getContentSignal } = require("./content-cache");

const DEFAULT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "*/*",
};

const HTML_HEADERS = {
  "User-Agent": DEFAULT_HEADERS["User-Agent"],
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
};

function supportedCharset(value) {
  if (!value) return "";
  try {
    return new TextDecoder(value).encoding;
  } catch (_error) {
    return "";
  }
}

function decodeUtf8OrLegacy(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (_error) {
    // Keep every valid UTF-8 sequence intact. A single legacy accent in an old
    // page must not change correctly encoded titles, scripts or URL tokens.
    const legacy = new TextDecoder("windows-1252");
    const fragments = [];
    let start = 0;
    for (let index = 0; index < bytes.length;) {
      const first = bytes[index];
      if (first < 0x80) { index++; continue; }
      const length = first >= 0xc2 && first <= 0xdf ? 2
        : first >= 0xe0 && first <= 0xef ? 3 : first >= 0xf0 && first <= 0xf4 ? 4 : 0;
      let valid = length > 0 && index + length <= bytes.length;
      for (let offset = 1; valid && offset < length; offset++) {
        valid = bytes[index + offset] >= 0x80 && bytes[index + offset] <= 0xbf;
      }
      const second = bytes[index + 1];
      if ((first === 0xe0 && second < 0xa0) || (first === 0xed && second > 0x9f)
        || (first === 0xf0 && second < 0x90) || (first === 0xf4 && second > 0x8f)) valid = false;
      if (valid) { index += length; continue; }
      fragments.push(bytes.subarray(start, index).toString("utf8"), legacy.decode(bytes.subarray(index, index + 1)));
      start = ++index;
    }
    fragments.push(bytes.subarray(start).toString("utf8"));
    return fragments.join("");
  }
}

/** Decode transport bytes before parsing HTML. Metadata repair is deliberately
 * separate: replacing characters throughout HTML can corrupt scripts and URLs. */
function decodeHtmlBuffer(value, contentType = "") {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  const bytes = Buffer.isBuffer(value) ? value
    : ArrayBuffer.isView(value) ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
      : Buffer.from(value);
  if (bytes.length === 0) return "";

  // A byte-order mark is stronger evidence than a conflicting server header.
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return decodeUtf8OrLegacy(bytes.subarray(3));
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);

  const charset = /charset\s*=\s*["']?\s*([^\s;"'>]+)/i;
  let encoding = supportedCharset(String(contentType).match(charset)?.[1]);
  if (!encoding) {
    const prefix = bytes.subarray(0, 8192).toString("latin1")
      .replace(/<!--[\s\S]*?-->/g, "").replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "");
    for (const meta of prefix.match(/<meta\b[^>]*>/gi) || []) {
      encoding = supportedCharset(meta.match(charset)?.[1]);
      if (encoding) break;
    }
  }
  if (encoding && encoding !== "utf-8") return new TextDecoder(encoding).decode(bytes);
  return decodeUtf8OrLegacy(bytes);
}

// Reuse upstream connections without allowing a stalled source to consume an
// unbounded number of sockets. No response cache is kept here: signed embeds
// and pages fetched with different headers must never share transport results.
const agentOptions = {
  keepAlive: true,
  maxSockets: 8,
  maxTotalSockets: 32,
  maxFreeSockets: 4,
  timeout: 30000,
};
const httpAgent = new http.Agent(agentOptions);
const httpsAgent = new https.Agent(agentOptions);

function requestLimit(value, fallback, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.min(Math.floor(parsed), maximum) : fallback;
}

async function requestHtml(url, headers) {
  const timeout = requestLimit(process.env.REQUEST_TIMEOUT_MS, 15000, 25000);
  const maxBytes = requestLimit(process.env.MAX_HTML_BYTES, 8 * 1024 * 1024, 32 * 1024 * 1024);
  // Axios' socket timeout alone does not bound a response that keeps sending
  // bytes or redirects. The signal limits the complete upstream transaction.
  const controller = new AbortController();
  const signal = controller.signal;
  const contentSignal = getContentSignal();
  const abortContent = () => controller.abort(contentSignal.reason);
  if (contentSignal?.aborted) abortContent();
  else contentSignal?.addEventListener("abort", abortContent, { once: true });
  const deadline = setTimeout(() => controller.abort(), timeout);
  deadline.unref?.();
  try {
    const response = await axios.get(url, {
      timeout,
      signal,
      headers,
      httpAgent,
      httpsAgent,
      responseType: "arraybuffer",
      transformResponse: [],
      maxContentLength: maxBytes,
      maxBodyLength: maxBytes,
      maxRedirects: 5,
      validateStatus: (status) => status >= 200 && status < 300,
    });
    return { html: decodeHtmlBuffer(response.data, response.headers?.["content-type"]), headers: response.headers };
  } catch (error) {
    const timedOut = signal.aborted || error.code === "ECONNABORTED" || error.code === "ETIMEDOUT";
    const failure = new ApiError(timedOut ? 504 : 502,
      timedOut ? "El proveedor no respondió a tiempo" : "No se pudo obtener el contenido del proveedor",
      error.message);
    // Provider adapters may distinguish an anti-bot response from transport
    // failure without exposing upstream URLs or credentials in public errors.
    failure.upstreamStatus = error.response?.status;
    throw failure;
  } finally {
    clearTimeout(deadline);
    contentSignal?.removeEventListener("abort", abortContent);
  }
}

async function fetchHtml(url, customHeaders = {}) {
  const response = await requestHtml(url, { ...HTML_HEADERS, ...customHeaders });
  return response.html;
}

async function fetchHtmlWithHeaders(url, referer, customHeaders = {}) {
  const headers = { ...HTML_HEADERS, ...customHeaders };
  if (referer) headers.Referer = referer;
  return requestHtml(url, headers);
}

function resolveAbsoluteUrl(base, relative) {
  if (!relative) return "";
  try {
    return new URL(relative, base).href;
  } catch (_e) {
    return relative;
  }
}

function normalizeExtractedUrl(value) {
  if (!value || typeof value !== "string") {
    return null;
  }

  return value
    .replace(/\\u0026/g, "&")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&")
    .replace(/%3A/gi, ":")
    .replace(/%2F/gi, "/")
    .replace(/%3F/gi, "?")
    .replace(/%3D/gi, "=")
    .trim();
}

function decodeIfEncoded(url) {
  if (!url || typeof url !== "string") {
    return url;
  }

  try {
    if (url.includes("%") && url.match(/%[0-9A-Fa-f]{2}/)) {
      return decodeURIComponent(url);
    }
  } catch (_e) {
    // Ignore decode errors
  }
  return url;
}

function isLikelyVideoUrl(url) {
  if (!url || typeof url !== "string") {
    return false;
  }

  const lower = url.toLowerCase();
  const excludePatterns = [
    "cloudflareinsights",
    "google-analytics",
    "googletagmanager",
    "facebook.net",
    "beacon.min.js",
    ".js?",
    "analytics",
    "pixel",
    "bigbuckbunny",
    "test-videos",
    "sample-video",
    "placeholder",
  ];

  for (const pattern of excludePatterns) {
    if (lower.includes(pattern)) {
      return false;
    }
  }

  return (
    /\.(mp4|m3u8)$/i.test(url) ||
    lower.includes("video") ||
    lower.includes("stream") ||
    lower.includes(".mp4") ||
    lower.includes(".m3u8")
  );
}

function findFirstUrl(payload, patterns) {
  if (!payload || typeof payload !== "string") {
    return null;
  }

  for (const pattern of patterns) {
    try {
      const match = payload.match(pattern);
      if (match && match[1]) {
        const candidate = normalizeExtractedUrl(match[1]);
        if (candidate && isLikelyVideoUrl(candidate)) {
          return decodeIfEncoded(candidate);
        }
      }
    } catch (_e) {
      // Skip invalid patterns silently
    }
  }

  // Fallback: try to find any URL-like pattern with .m3u8 or .mp4
  const urlMatch = payload.match(/(https?:\/\/[^\s"'<>]+\.(?:m3u8|mp4)[^\s"'<>]*)/i);
  if (urlMatch && urlMatch[1]) {
    const candidate = normalizeExtractedUrl(urlMatch[1]);
    if (isLikelyVideoUrl(candidate)) {
      return decodeIfEncoded(candidate);
    }
  }

  return null;
}

module.exports = {
  DEFAULT_HEADERS,
  HTML_HEADERS,
  fetchHtml,
  fetchHtmlWithHeaders,
  decodeHtmlBuffer,
  resolveAbsoluteUrl,
  normalizeExtractedUrl,
  decodeIfEncoded,
  isLikelyVideoUrl,
  findFirstUrl,
};
