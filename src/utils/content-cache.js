const { AsyncLocalStorage } = require('node:async_hooks');
const { ApiError } = require('./api-error');

const contentContext = new AsyncLocalStorage();

function getContentSignal() {
  return contentContext.getStore();
}

function runWithContentSignal(signal, load) {
  return contentContext.run(signal, load);
}

/** Share identical reads, retain only successful responses and bound both maps.
 * Each shared operation has its own deadline; one disconnected caller must not
 * cancel the result that another caller is still waiting for. */
function createContentCache({ maxEntries = 120, maxPending = 32, timeoutMs = 25000, now = Date.now } = {}) {
  if (![maxEntries, maxPending, timeoutMs].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new TypeError('La capacidad y el plazo de la caché deben ser enteros positivos.');
  }
  const entries = new Map();
  const pending = new Map();

  async function get(key, lifetime, load) {
    const saved = entries.get(key);
    if (saved && saved.expires > now()) {
      entries.delete(key);
      entries.set(key, saved);
      return saved.value;
    }
    entries.delete(key);
    if (pending.has(key)) return pending.get(key);
    if (pending.size >= maxPending) {
      throw new ApiError(503, 'La API está ocupada. Reintenta en unos segundos.');
    }

    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new ApiError(504, 'El proveedor tardó demasiado en responder. Vuelve a intentar.');
        controller.abort(error);
        reject(error);
      }, timeoutMs);
    });
    const work = contentContext.run(controller.signal, () => Promise.resolve().then(load));
    const request = Promise.race([work, deadline]).then(value => {
      if (lifetime > 0) {
        // Purge expired entries before evicting a recently used live response.
        for (const [entryKey, entry] of entries) if (entry.expires <= now()) entries.delete(entryKey);
        while (entries.size >= maxEntries) entries.delete(entries.keys().next().value);
        entries.set(key, { value, expires: now() + lifetime });
      }
      return value;
    }).finally(() => {
      clearTimeout(timer);
      pending.delete(key);
    });
    pending.set(key, request);
    return request;
  }

  return { get };
}

module.exports = { createContentCache, getContentSignal, runWithContentSignal };
