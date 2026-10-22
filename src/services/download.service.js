const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { pipeline } = require("node:stream/promises");
const axios = require("axios");
const ffmpegPath = require("ffmpeg-static");
const ffmpeg = require("fluent-ffmpeg");
ffmpeg.setFfmpegPath(ffmpegPath);

const { ApiError } = require("../utils/api-error");
const pelisplusService = require("./pelisplus.service");
const repelishdService = require("./repelishd.service");
const cuevanaService = require("./cuevana.service");
const { resolveEmbedUrl } = require("../utils/resolvers");
const { runWithContentSignal } = require('../utils/content-cache');

const downloadStore = new Map();
const batchStore = new Map();
const downloadJobs = new Map();
const downloadQueue = [];
const activeJobs = new Set();
let runningDownloads = 0;
let shuttingDown = false;
let cleanupPromise = null;

function boundedSetting(name, fallback, min, max) {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
}

const DOWNLOAD_CONCURRENCY = boundedSetting('DOWNLOAD_CONCURRENCY', 1, 1, 4);
const DOWNLOAD_MAX_QUEUED = boundedSetting('DOWNLOAD_MAX_QUEUED', 20, 0, 100);
const DOWNLOAD_HISTORY_LIMIT = boundedSetting('DOWNLOAD_HISTORY_LIMIT', 200, 1, 2000);
const DOWNLOAD_HISTORY_TTL_MS = boundedSetting('DOWNLOAD_HISTORY_TTL_MS', 86400000, 1000, 604800000);

function terminal(record) {
  return record.status === 'completed' || record.status === 'failed';
}

function pruneHistory() {
  const expires = Date.now() - DOWNLOAD_HISTORY_TTL_MS;
  for (const store of [downloadStore, batchStore]) {
    const completed = [];
    for (const [id, record] of store) {
      if (store === downloadStore && downloadJobs.has(id)) continue;
      const finishedAt = record.completedAt || (terminal(record) ? record.updatedAt : 0);
      if (!finishedAt) continue;
      if (finishedAt <= expires) store.delete(id);
      else completed.push([id, finishedAt]);
    }
    completed.sort((a, b) => a[1] - b[1]);
    for (let index = 0; index < completed.length - DOWNLOAD_HISTORY_LIMIT; index++) store.delete(completed[index][0]);
  }
}

function ensureDownloadCapacity(required = 1) {
  if (shuttingDown) throw new ApiError(503, 'El servicio de descargas se está cerrando');
  pruneHistory();
  if (required > DOWNLOAD_CONCURRENCY + DOWNLOAD_MAX_QUEUED - downloadJobs.size) {
    throw new ApiError(429, 'La cola de descargas está llena. Reintenta cuando termine una descarga.');
  }
}

function checkJob(job) {
  if (job.controller.signal.aborted) throw job.controller.signal.reason || new Error('Descarga cancelada');
}

async function waitForJob(job, work) {
  checkJob(job);
  let onAbort;
  const interrupted = new Promise((_, reject) => {
    onAbort = () => reject(job.controller.signal.reason || new Error('Descarga cancelada'));
    job.controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([work, interrupted]); }
  finally { job.controller.signal.removeEventListener('abort', onAbort); }
}

function finishJob(job) {
  const { record } = job;
  if (record.batchItem) {
    record.batchItem.snapshot = {
      status: record.status, progress: record.progress, downloadUrl: record.downloadUrl, error: record.error,
    };
    const batch = record.batch;
    if (batch.items.every(item => item.snapshot && terminal(item.snapshot))) batch.completedAt = Date.now();
  }
  downloadJobs.delete(record.downloadId);
  pruneHistory();
}

function drainDownloads() {
  while (!shuttingDown && runningDownloads < DOWNLOAD_CONCURRENCY && downloadQueue.length) {
    const job = downloadQueue.shift();
    runningDownloads++;
    const work = runWithContentSignal(job.controller.signal, () => runDownload(job.record, job.payload, job));
    const tracked = work.finally(async () => {
      for (const file of job.partialFiles) await removeFileIfExists(file);
      runningDownloads--;
      activeJobs.delete(tracked);
      finishJob(job);
      drainDownloads();
    });
    activeJobs.add(tracked);
  }
}

// Stop queued work immediately and cancel active sockets/processes. Completed
// files stay on disk; retention removes only terminal tracking metadata.
function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  shuttingDown = true;
  const error = new Error('Descarga cancelada al cerrar el servicio');
  for (const job of downloadQueue.splice(0)) {
    job.controller.abort(error);
    job.record.status = 'failed';
    job.record.progress = 0;
    job.record.error = error.message;
    job.record.updatedAt = Date.now();
    finishJob(job);
  }
  for (const job of downloadJobs.values()) {
    job.controller.abort(error);
    for (const stream of job.streams) stream.destroy();
    for (const command of job.commands) {
      try { command.kill('SIGKILL'); } catch (_error) { /* Command already exited. */ }
    }
  }
  cleanupPromise = (async () => {
    let timer;
    try {
      await Promise.race([
        Promise.allSettled([...activeJobs]),
        new Promise(resolve => { timer = setTimeout(resolve, 3000); }),
      ]);
    } finally { clearTimeout(timer); }
  })();
  return cleanupPromise;
}

const DEBUG_MODE = process.env.DEBUG_DOWNLOAD === "true";

function debugLog(server, message, data) {
  if (!DEBUG_MODE) {
    return;
  }
  const timestamp = new Date().toISOString();
  const header = `[${timestamp}] [${server}] ${message}`;
  if (data) {
    console.log(header, typeof data === "string" ? data.slice(0, 500) : data);
  } else {
    console.log(header);
  }
}

const DEFAULT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "*/*",
};

const SERVER_PRIORITY = ["streamwish", "voesx", "streamtape", "netu", "vidhide"];

function getDownloadsDir() {
  const configuredPath = process.env.DOWNLOADS_DIR || "downloads";
  const targetPath = path.resolve(process.cwd(), configuredPath);
  fs.mkdirSync(targetPath, { recursive: true });
  return targetPath;
}

function safeFilePart(value) {
  return (value || "")
    .toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function extractEpisodeNumber(url) {
  if (!url) return null;
  const match = url.match(/capitulo\/(\d+)/i);
  if (match) return Number(match[1]);
  return null;
}

function extractAnimeSlug(url) {
  if (!url) return "content";
  const parts = url.split("/").filter(Boolean);
  const typeIndex = parts.findIndex((p) => p === "serie" || p === "pelicula" || p === "anime");
  if (typeIndex !== -1 && parts[typeIndex + 1]) {
    // Provider identities are not filenames: keep Unicode and percent escapes intact.
    return parts[typeIndex + 1].split(/[?#]/, 1)[0];
  }
  return "content";
}

function getExtensionFromUrl(url) {
  try {
    const pathname = new URL(url).pathname || "";
    const ext = path.extname(pathname).toLowerCase();
    if ([".mp4", ".mkv", ".avi", ".mov", ".webm"].includes(ext)) {
      return ext;
    }
  } catch (_error) {
    // Ignore parse errors
  }
  return ".mp4";
}

function getRefererForUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}/`;
  } catch (_error) {
    return "https://www.pelisplushd.la/";
  }
}

function chooseCandidateLinks(servers, variant, preferredServer) {
  const preferredToken = safeFilePart(preferredServer);
  const seen = new Set();
  const deduped = [];

  for (const item of servers) {
    if (!item || typeof item.embedUrl !== "string" || !item.embedUrl.trim()) {
      continue;
    }

    const key = item.embedUrl.trim();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push({
      server: item.server || "unknown",
      name: item.name || "Unknown",
      url: key,
      language: item.language || "Latino",
    });
  }

  deduped.sort((a, b) => {
    const serverA = safeFilePart(a.server);
    const serverB = safeFilePart(b.server);

    const preferredBonusA = preferredToken && serverA.includes(preferredToken) ? -100 : 0;
    const preferredBonusB = preferredToken && serverB.includes(preferredToken) ? -100 : 0;

    const langBonusA = variant && a.language.toLowerCase().includes(variant.toLowerCase()) ? -50 : 0;
    const langBonusB = variant && b.language.toLowerCase().includes(variant.toLowerCase()) ? -50 : 0;

    const priorityA = SERVER_PRIORITY.findIndex((token) => serverA.includes(token));
    const priorityB = SERVER_PRIORITY.findIndex((token) => serverB.includes(token));
    const resolvedA = priorityA === -1 ? 999 : priorityA;
    const resolvedB = priorityB === -1 ? 999 : priorityB;

    return resolvedA + preferredBonusA + langBonusA - (resolvedB + preferredBonusB + langBonusB);
  });

  return deduped;
}

function makeDownloadFilename(record, sourceUrl, serverName) {
  const slug = safeFilePart(extractAnimeSlug(record.url)) || 'content';
  const episodeNumber = extractEpisodeNumber(record.url);
  const ext = getExtensionFromUrl(sourceUrl);
  const serverToken = safeFilePart(serverName || "server");
  const suffix = record.downloadId.split("-")[0];
  const episodeLabel = Number.isFinite(episodeNumber) ? `ep${episodeNumber}` : "movie";

  return `${slug}-${episodeLabel}-${serverToken}-${suffix}${ext}`;
}

async function removeFileIfExists(targetPath) {
  try {
    await fs.promises.unlink(targetPath);
  } catch (_error) {
    // Ignore missing files
  }
}

function ensureDirectLikeContent(contentType, url) {
  const lowered = (contentType || "").toLowerCase();
  if (/(text\/html|application\/json|application\/javascript|text\/plain)/i.test(lowered)) {
    throw new Error(`El servidor devolvio contenido no descargable (${lowered || "desconocido"}) para ${url}`);
  }
}

function resolveDirectDownloadUrl(rawUrl, serverName) {
  if (!rawUrl || typeof rawUrl !== "string") {
    return rawUrl;
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (_error) {
    return rawUrl;
  }

  const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
  const serverToken = safeFilePart(serverName || "");

  if (host.includes("pixeldrain.com") || serverToken.includes("pdrain") || serverToken.includes("pixeldrain")) {
    const pathParts = parsed.pathname.split("/").filter(Boolean);
    const isFileApi = pathParts[0] === "api" && pathParts[1] === "file" && pathParts[2];
    const isUserShare = pathParts[0] === "u" && pathParts[1];

    const fileId = isFileApi ? pathParts[2] : isUserShare ? pathParts[1] : null;
    if (fileId) {
      return `https://pixeldrain.com/api/file/${fileId}?download`;
    }
  }

  return rawUrl;
}

async function downloadHlsVideo(finalUrl, filePath, record, candidate, job) {
  checkJob(job);
  record.status = "downloading";
  record.currentServer = candidate.server;
  record.sourceUrl = finalUrl;
  record.totalBytes = null;
  record.downloadedBytes = 0;
  record.progress = 1;
  record.updatedAt = Date.now();

  const referer = getRefererForUrl(candidate.url || record.url || finalUrl);
  const command = ffmpeg(finalUrl);
  job.commands.add(command);
  let onAbort;
  try {
    await new Promise((resolve, reject) => {
      onAbort = () => {
        try { command.kill('SIGKILL'); } catch (_error) { /* Command already exited. */ }
        reject(job.controller.signal.reason || new Error('Descarga cancelada'));
      };
      job.controller.signal.addEventListener('abort', onAbort, { once: true });
      command
        .inputOptions([
          "-headers",
          `User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36\r\nReferer: ${referer}\r\n`,
        ])
        .outputOptions(["-c copy", "-bsf:a aac_adtstoasc"])
        .output(filePath)
        .on("start", () => {
          if (job.controller.signal.aborted) return;
          record.status = "downloading";
          record.progress = 1;
          record.updatedAt = Date.now();
        })
        .on("progress", (progress) => {
          if (job.controller.signal.aborted) return;
          if (progress.percent && progress.percent > 0) record.progress = Math.max(1, Math.min(99, Math.floor(progress.percent)));
          else record.progress = Math.min(90, record.progress + 1);
          record.updatedAt = Date.now();
        })
        .on("error", err => reject(new Error(`Transferencia fallida en ${candidate.server} (HLS): ${err.message}`)))
        .on("end", resolve)
        .run();
    });
  } finally {
    job.controller.signal.removeEventListener('abort', onAbort);
    job.commands.delete(command);
  }
}

async function downloadFromUrl(record, candidate, job) {
  checkJob(job);
  let finalUrl = resolveDirectDownloadUrl(candidate.url, candidate.server);
  finalUrl = await waitForJob(job, resolveEmbedUrl(finalUrl, record.url));
  checkJob(job);
  if (!finalUrl) {
    throw new Error(`No se pudo resolver enlace directo en ${candidate.server}`);
  }
  const downloadsDir = getDownloadsDir();
  const fileName = makeDownloadFilename(record, finalUrl, candidate.server);
  const filePath = path.join(downloadsDir, fileName);
  job.partialFiles.add(filePath);

  const referer = getRefererForUrl(candidate.url || record.url || finalUrl);
  const isHls = finalUrl.toLowerCase().includes(".m3u8") || /hls/i.test(candidate.server);

  if (isHls) {
    await downloadHlsVideo(finalUrl, filePath, record, candidate, job);
  } else {
    let response;
    try {
      const timeout = Number(process.env.DOWNLOAD_REQUEST_TIMEOUT_MS || 120000);
      response = await axios.get(finalUrl, {
        responseType: "stream",
        timeout,
        maxRedirects: 5,
        signal: job.controller.signal,
        headers: {
          ...DEFAULT_HEADERS,
          Referer: referer,
        },
        validateStatus: (status) => status >= 200 && status < 400,
      });
    } catch (error) {
      throw new Error(`No se pudo abrir enlace ${candidate.server}: ${error.message}`);
    }

    job.streams.add(response.data);
    if (job.controller.signal.aborted) response.data.destroy();
    checkJob(job);
    const contentType = response.headers["content-type"] || "";
    try {
      ensureDirectLikeContent(contentType, finalUrl);
    } catch (error) {
      // A rejected HTML/JSON response still owns an open socket until destroyed.
      response.data.destroy();
      throw error;
    }

    const totalBytesRaw = Number(response.headers["content-length"] || 0);
    const totalBytes = Number.isFinite(totalBytesRaw) && totalBytesRaw > 0 ? totalBytesRaw : null;

    record.status = "downloading";
    record.currentServer = candidate.server;
    record.sourceUrl = finalUrl;
    record.totalBytes = totalBytes;
    record.downloadedBytes = 0;
    record.progress = 1;
    record.updatedAt = Date.now();

    const writer = fs.createWriteStream(filePath, { flags: "w" });
    job.streams.add(writer);

    response.data.on("data", (chunk) => {
      if (job.controller.signal.aborted) return;
      if (!Buffer.isBuffer(chunk)) {
        return;
      }

      record.downloadedBytes += chunk.length;
      record.updatedAt = Date.now();

      if (record.totalBytes && record.totalBytes > 0) {
        const pct = Math.floor((record.downloadedBytes / record.totalBytes) * 100);
        record.progress = Math.max(1, Math.min(99, pct));
        return;
      }

      record.progress = Math.min(90, record.progress + 1);
    });

    try {
      await pipeline(response.data, writer, { signal: job.controller.signal });
    } catch (error) {
      await removeFileIfExists(filePath);
      throw new Error(`Transferencia fallida en ${candidate.server}: ${error.message}`);
    } finally {
      job.streams.delete(response.data);
      job.streams.delete(writer);
    }
  }

  checkJob(job);
  const stat = await fs.promises.stat(filePath);
  if (!stat.size || stat.size < 512 * 1024) {
    await removeFileIfExists(filePath);
    throw new Error(`Archivo invalido en ${candidate.server}: tamano demasiado pequeno`);
  }

  checkJob(job);
  job.partialFiles.delete(filePath);
  record.status = "completed";
  record.progress = 100;
  record.fileName = fileName;
  record.filePath = filePath;
  record.fileSize = String(stat.size);
  record.downloadUrl = `${record.baseUrl}/downloads/${fileName}`;
  record.completedAt = Date.now();
  record.error = null;
}

async function runDownload(record, payload, job) {
  record.status = "preparing";
  record.updatedAt = Date.now();

  const variant = record.variant || "Latino"; // Latino, Subtitulado, Español
  const preferredServer = payload?.preferredServer;

  try {
    let servers = [];
    const url = record.url;

    // Detectar proveedor a partir de la URL
    let provider = "pelisplus";
    if (url.includes("repelishd") || url.includes("/ver-pelicula/")) {
      provider = "repelishd";
    } else if (url.includes("cuevana") || url.includes("ww9.cuevana3.to") || (url.includes("/") && !url.includes("pelicula") && !url.includes("serie") && !url.includes("anime"))) {
      provider = "cuevana3";
    }

    if (provider === "repelishd") {
      const slug = url.split("/ver-pelicula/").pop().replace(".html", "");
      const info = await waitForJob(job, repelishdService.getContentInfo(slug, "movie"));
      servers = info.servers || [];
    } else if (provider === "cuevana3") {
      if (url.includes("/serie/") || url.includes("/anime/") || url.includes("/episodio/")) {
        // En Cuevana, el slug del capítulo suele extraerse de la URL: /episodio/slug-temporadaxcapitulo
        const isEpisodePage = url.includes("/episodio/");
        let slug = "";
        let season = 1;
        let episode = 1;
        
        if (isEpisodePage) {
          const epPart = url.split("/episodio/").pop().split("/")[0];
          const match = epPart.match(/(.+)-(\d+)x(\d+)$/);
          if (match) {
            slug = `serie/${match[1]}`;
            season = Number(match[2]);
            episode = Number(match[3]);
          } else {
            slug = epPart;
          }
        } else {
          slug = url.split("cuevana3.to/").pop().split("/")[0];
          const match = url.match(/(\d+)x(\d+)$/);
          if (match) {
            season = Number(match[1]);
            episode = Number(match[2]);
          }
        }
        const info = await waitForJob(job, cuevanaService.getEpisodeServers(slug, season, episode));
        servers = info.servers || [];
      } else {
        const slug = url.split("cuevana3.to/").pop().split("/")[0];
        const info = await waitForJob(job, cuevanaService.getContentInfo(slug, "movie"));
        servers = info.servers || [];
      }
    } else {
      // PelisPlus
      if (url.includes("/pelicula/")) {
        const slug = extractAnimeSlug(url);
        const info = await waitForJob(job, pelisplusService.getContentInfo(slug, "movie"));
        servers = info.servers || [];
      } else if (url.includes("/serie/") || url.includes("/anime/")) {
        const slug = extractAnimeSlug(url);
        const seasonMatch = url.match(/temporada\/(\d+)/i);
        const episodeMatch = url.match(/capitulo\/(\d+)/i);

        const season = seasonMatch ? Number(seasonMatch[1]) : 1;
        const episode = episodeMatch ? Number(episodeMatch[1]) : 1;

        const info = await waitForJob(job, pelisplusService.getEpisodeServers(slug, season, episode, url.includes('/anime/') ? 'anime' : 'series'));
        servers = info.servers || [];
      } else {
        throw new Error("URL de proveedor no soportada o invalida");
      }
    }

    checkJob(job);
    const candidates = chooseCandidateLinks(servers, variant, preferredServer);

    if (candidates.length === 0) {
      throw new Error("No se encontraron enlaces para descarga real");
    }

    const errors = [];
    for (const candidate of candidates) {
      checkJob(job);
      try {
        record.status = "preparing";
        record.currentServer = candidate.server;
        record.updatedAt = Date.now();

        await downloadFromUrl(record, candidate, job);
        return;
      } catch (error) {
        if (job.controller.signal.aborted) throw job.controller.signal.reason || error;
        errors.push(`${candidate.server}: ${error.message}`);
      }
    }

    throw new Error(`Todos los servidores fallaron. ${errors.join(" | ")}`);
  } catch (error) {
    record.status = "failed";
    record.progress = 0;
    record.error = error.message || "Error desconocido en descarga";
    record.updatedAt = Date.now();
  }
}

function createDownload(payload, baseUrl) {
  if (!payload || typeof payload.url !== "string" || !payload.url.trim()) {
    throw new ApiError(400, "Se requiere el parametro url en el body");
  }

  ensureDownloadCapacity();
  const downloadId = randomUUID();
  const record = {
    downloadId,
    status: "queued",
    progress: 0,
    url: payload.url.trim(),
    quality: payload.quality || "auto",
    variant: payload.variant || "Latino",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    baseUrl,
    error: null,
    downloadUrl: null,
    fileSize: null,
    fileName: null,
    downloadedBytes: 0,
    totalBytes: null,
    sourceUrl: null,
    currentServer: null,
  };

  downloadStore.set(downloadId, record);

  const job = { record, payload, controller: new AbortController(), streams: new Set(), commands: new Set(), partialFiles: new Set() };
  downloadJobs.set(downloadId, job);
  downloadQueue.push(job);
  queueMicrotask(drainDownloads);

  return {
    id: downloadId,
    downloadId,
    status: record.status,
    statusUrl: `/api/pelisplus/download/${downloadId}`,
    url: record.url,
    quality: record.quality,
    variant: record.variant,
  };
}

function getDownload(downloadId) {
  pruneHistory();
  const record = downloadStore.get(downloadId);
  if (!record) {
    throw new ApiError(404, "Descarga no encontrada");
  }

  return {
    id: record.downloadId,
    downloadId: record.downloadId,
    status: record.status,
    progress: record.progress,
    url: record.url,
    quality: record.quality,
    variant: record.variant,
    downloadUrl: record.downloadUrl,
    fileSize: record.fileSize,
    fileName: record.fileName,
    sourceUrl: record.sourceUrl,
    currentServer: record.currentServer,
    downloadedBytes: record.downloadedBytes,
    totalBytes: record.totalBytes,
    error: record.error,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    completedAt: record.completedAt || null,
  };
}

function createBatch(payload, baseUrl) {
  const mediaUrl = (payload?.mediaUrl || payload?.animeUrl || "").toString().trim();
  const episodes = Array.isArray(payload?.episodes) ? payload.episodes : [];

  if (!mediaUrl) {
    throw new ApiError(400, "Se requiere mediaUrl en el body");
  }

  if (episodes.length === 0) {
    throw new ApiError(400, "Se requiere un arreglo de episodes con al menos un elemento");
  }

  const normalizedEpisodes = [...new Set(episodes
    .map((item) => Number(item))
    .filter((item) => Number.isSafeInteger(item) && item > 0))];

  if (normalizedEpisodes.length === 0) {
    throw new ApiError(400, "episodes debe contener numeros de episodio validos");
  }

  const season = Number(payload?.season ?? 1);
  if (!Number.isSafeInteger(season) || season < 0) {
    throw new ApiError(400, "season debe ser un numero entero mayor o igual que cero");
  }
  let media;
  try { media = new URL(mediaUrl); } catch { throw new ApiError(400, "mediaUrl debe ser una URL HTTP valida"); }
  if (!/^https?:$/.test(media.protocol)) throw new ApiError(400, "mediaUrl debe ser una URL HTTP valida");

  ensureDownloadCapacity(normalizedEpisodes.length);
  const batchId = randomUUID();
  const entries = normalizedEpisodes.map((episodeNumber) => {
    let episodeUrl = "";
    if (mediaUrl.includes("cuevana") || mediaUrl.includes("ww9.cuevana3.to")) {
      const coreSlug = media.pathname.replace(/\/$/, "").split("/").pop();
      episodeUrl = `https://ww9.cuevana3.to/episodio/${coreSlug}-${season}x${episodeNumber}`;
    } else {
      // PelisPlus
      const target = new URL(media);
      target.pathname = `${target.pathname.replace(/\/$/, "")}/temporada/${season}/capitulo/${episodeNumber}`;
      episodeUrl = target.href;
    }
    const created = createDownload(
      {
        url: episodeUrl,
        quality: payload.quality || "auto",
        variant: payload.variant || "Latino",
        preferredServer: payload.preferredServer,
      },
      baseUrl
    );

    return {
      episode: episodeNumber,
      downloadId: created.downloadId,
      status: created.status,
    };
  });

  const batch = {
    batchId,
    mediaUrl,
    season,
    quality: payload.quality || "auto",
    variant: payload.variant || "Latino",
    createdAt: Date.now(),
    items: entries,
  };

  batchStore.set(batchId, batch);
  for (const item of entries) {
    const record = downloadStore.get(item.downloadId);
    record.batch = batch;
    record.batchItem = item;
  }

  return {
    batchId,
    status: "queued",
    total: entries.length,
    statusUrl: `/api/pelisplus/batch/${batchId}`,
    items: entries,
  };
}

function getBatch(batchId) {
  pruneHistory();
  const batch = batchStore.get(batchId);
  if (!batch) {
    throw new ApiError(404, "Batch no encontrado");
  }

  const items = batch.items.map((item) => {
    // Keep a small terminal snapshot so metadata eviction cannot break a batch.
    const snapshot = downloadStore.get(item.downloadId) || item.snapshot;
    return {
      episode: item.episode,
      downloadId: item.downloadId,
      status: snapshot.status,
      progress: snapshot.progress,
      downloadUrl: snapshot.downloadUrl,
      error: snapshot.error,
    };
  });

  const total = items.length;
  const completed = items.filter((item) => item.status === "completed").length;
  const failed = items.filter((item) => item.status === "failed").length;
  const settled = completed + failed;
  const progress = total > 0 ? Math.round((settled / total) * 100) : 0;

  return {
    batchId,
    // A mixed result is terminal too; failure counts remain available to clients.
    status: failed === total ? "failed" : settled === total ? "completed" : "downloading",
    progress,
    total,
    completed,
    failed,
    items,
  };
}

module.exports = {
  createDownload,
  getDownload,
  createBatch,
  getBatch,
  getDownloadsDir,
  cleanup,
};
