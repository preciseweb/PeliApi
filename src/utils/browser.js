const fs = require("node:fs");
const puppeteer = require("puppeteer");
const { ApiError } = require("./api-error");
const { getContentSignal } = require("./content-cache");

function boundedNumber(value, fallback, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.min(Math.floor(parsed), maximum) : fallback;
}

let browserInstance = null;
let browserLaunch = null;
let browserGeneration = 0;
let closing = false;

// Simple Semaphore / Concurrency Limiter. Bound both running work and waiters;
// otherwise a missing Chrome installation or a stalled page grows the queue.
let activePages = 0;
const MAX_CONCURRENT_PAGES = boundedNumber(process.env.MAX_CONCURRENT_PAGES, 1, 4);
const MAX_QUEUED_PAGES = boundedNumber(process.env.MAX_QUEUED_PAGES, 8, 64);
const PAGE_QUEUE_TIMEOUT = boundedNumber(process.env.PAGE_QUEUE_TIMEOUT_MS, 5000, 10000);
const PAGE_TIMEOUT = boundedNumber(process.env.BROWSER_REQUEST_TIMEOUT_MS, 25000, 25000);
const queue = [];
const pages = new Set();

function unavailable(message = "El navegador de extracción no está disponible") {
  return new ApiError(503, message);
}

function claimSlot() {
  activePages++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activePages--;
    while (queue.length && activePages < MAX_CONCURRENT_PAGES) queue.shift().grant();
  };
}

function acquireSlot(signal) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  if (closing) return Promise.reject(unavailable());
  if (activePages < MAX_CONCURRENT_PAGES) return Promise.resolve(claimSlot());
  if (queue.length >= MAX_QUEUED_PAGES) {
    return Promise.reject(unavailable("El navegador está ocupado. Reintenta en unos segundos."));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const index = queue.indexOf(entry);
      if (index !== -1) queue.splice(index, 1);
      if (error) reject(error);
      else resolve(claimSlot());
    };
    const onAbort = () => finish(signal.reason);
    const entry = { grant: () => finish(), reject: finish };
    const timer = setTimeout(() => finish(unavailable("El navegador está ocupado. Reintenta en unos segundos.")), PAGE_QUEUE_TIMEOUT);
    queue.push(entry);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function isConnected(browser) {
  return Boolean(browser && (typeof browser.isConnected === "function" ? browser.isConnected() : browser.connected));
}

async function executableAvailable() {
  try {
    const executable = process.env.PUPPETEER_EXECUTABLE_PATH || await puppeteer.executablePath();
    return typeof executable === "string" && fs.existsSync(executable);
  } catch (_error) {
    return false;
  }
}

async function waitAtMost(promise, timeout, error) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(error), timeout);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

async function closeBrowser(browser) {
  if (!browser) return;
  if (browserInstance === browser) browserInstance = null;
  try {
    await waitAtMost(browser.close(), 2000, unavailable());
  } catch (_error) {
    try { browser.process()?.kill("SIGKILL"); } catch (_killError) { /* Process already stopped. */ }
  }
}

async function getBrowser() {
  if (closing) throw unavailable();
  if (isConnected(browserInstance)) return browserInstance;
  browserInstance = null;
  if (browserLaunch) return browserLaunch;
  // PUPPETEER_SKIP_CHROMIUM_DOWNLOAD is common on Render. Fail immediately
  // instead of repeating expensive failed launches for every search fallback.
  const generation = browserGeneration;
  const launch = Promise.resolve().then(async () => {
    if (!await executableAvailable()) throw unavailable("Chrome no está instalado; este proveedor requiere un navegador de extracción");
    if (generation !== browserGeneration || closing) throw unavailable();
    return puppeteer.launch({
    headless: true,
    timeout: 10000,
    protocolTimeout: PAGE_TIMEOUT,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--disable-gpu",
      "--no-zygote",
      "--disable-background-networking",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-breakpad",
      "--disable-component-extensions-with-background-pages",
      "--disable-extensions",
      "--disable-features=TranslateUI,BlinkGenPropertyTrees",
      "--disable-renderer-backgrounding",
      "--metrics-recording-only"
    ]
    });
  }).then(async (browser) => {
    if (generation !== browserGeneration || closing) {
      await closeBrowser(browser);
      throw unavailable();
    }
    browserInstance = browser;
    browser.once("disconnected", () => { if (browserInstance === browser) browserInstance = null; });
    return browser;
  }).catch((error) => {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, "No se pudo iniciar el navegador de extracción", error.message);
  });
  browserLaunch = launch;
  try {
    return await launch;
  } finally {
    if (browserLaunch === launch) browserLaunch = null;
  }
}

function untilAborted(promise, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) { promise.catch(() => {}); reject(signal.reason); return; }
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(value => {
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    }, error => {
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });
  });
}

async function closePage(page, browser) {
  pages.delete(page);
  try {
    // Do not evaluate window.stop(): a stuck renderer can also hang evaluate.
    await waitAtMost(page.close({ runBeforeUnload: false }), 1500, unavailable());
  } catch (_error) {
    await closeBrowser(browser);
  }
}

async function withPage(callback, options = {}) {
  const controller = new AbortController();
  const signal = controller.signal;
  const parentSignal = getContentSignal();
  const abortParent = () => controller.abort(parentSignal.reason);
  if (parentSignal?.aborted) abortParent();
  else parentSignal?.addEventListener("abort", abortParent, { once: true });
  const timeout = boundedNumber(options.timeoutMs, PAGE_TIMEOUT, 25000);
  const timer = setTimeout(() => controller.abort(new ApiError(504, "El proveedor no respondió a tiempo")), timeout);
  let release;
  let browser;
  let page;
  try {
    release = await acquireSlot(signal);
    const work = (async () => {
      browser = await getBrowser();
      if (signal.aborted) throw signal.reason;
      const createdPage = await browser.newPage();
      if (signal.aborted) {
        await closePage(createdPage, browser);
        throw signal.reason;
      }
      page = createdPage;
      pages.add(page);
      page.setDefaultTimeout(timeout);
      page.setDefaultNavigationTimeout(timeout);
      return callback(page);
    })();
    return await untilAborted(work, signal);
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", abortParent);
    if (page) await closePage(page, browser);
    else if (signal.aborted && browser) await closeBrowser(browser);
    release?.();
  }
}

async function readPage(url, scraperFn) {
  return withPage(async (page) => {
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      const type = request.resourceType();
      const action = ["image", "stylesheet", "font", "media"].includes(type) ? "abort" : "continue";
      try { Promise.resolve(request[action]()).catch(() => {}); }
      catch (_error) { /* Navigation may close between interception and handling. */ }
    });
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT });
    if (response && response.status() >= 400) throw new ApiError(502, "El proveedor devolvió un error al obtener el contenido");
    return scraperFn ? page.evaluate(scraperFn) : page.content();
  });
}

async function fetchPageContent(url) {
  return readPage(url);
}

async function scrapeWithPage(url, scraperFn) {
  return readPage(url, scraperFn);
}

async function cleanup() {
  if (closing) return;
  closing = true;
  browserGeneration++;
  for (const entry of [...queue]) entry.reject(unavailable());
  const browser = browserInstance;
  browserInstance = null;
  try {
    await closeBrowser(browser);
  } finally {
    pages.clear();
    closing = false;
  }
}

async function getBrowserStatus() {
  return {
    available: await executableAvailable(),
    connected: isConnected(browserInstance),
    activePages,
    queuedPages: queue.length,
    maxConcurrentPages: MAX_CONCURRENT_PAGES,
  };
}

// A synchronous final safeguard also covers CLI use. Applications own their
// SIGINT/SIGTERM handlers so importing this utility never exits a host server.
process.once("exit", () => {
  try { browserInstance?.process()?.kill("SIGKILL"); } catch (_error) { /* Process already stopped. */ }
});

module.exports = { getBrowser, fetchPageContent, scrapeWithPage, withPage, cleanup, getBrowserStatus };
