const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createContentCache } = require('../src/utils/content-cache');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fakeBrowser() {
  const browser = new EventEmitter();
  browser.live = true;
  browser.closed = 0;
  browser.created = [];
  browser.isConnected = () => browser.live;
  browser.process = () => ({ kill: () => { browser.live = false; browser.killed = true; } });
  browser.close = async () => { browser.closed++; browser.live = false; browser.emit('disconnected'); };
  browser.newPage = async () => {
    const page = new EventEmitter();
    page.closed = 0;
    page.setDefaultTimeout = () => {};
    page.setDefaultNavigationTimeout = () => {};
    page.close = async () => { page.closed++; };
    browser.created.push(page);
    return page;
  };
  return browser;
}

function loadBrowser(t, options = {}) {
  const modulePath = require.resolve('../src/utils/browser');
  const puppeteerPath = require.resolve('puppeteer');
  const saved = new Map([modulePath, puppeteerPath].map(key => [key, require.cache[key]]));
  const env = ['MAX_CONCURRENT_PAGES', 'MAX_QUEUED_PAGES', 'PAGE_QUEUE_TIMEOUT_MS', 'PUPPETEER_EXECUTABLE_PATH'];
  const previous = Object.fromEntries(env.map(key => [key, process.env[key]]));
  process.env.MAX_CONCURRENT_PAGES = '1';
  process.env.MAX_QUEUED_PAGES = '1';
  process.env.PAGE_QUEUE_TIMEOUT_MS = '250';
  delete process.env.PUPPETEER_EXECUTABLE_PATH;
  const browser = options.browser || fakeBrowser();
  let launches = 0;
  const puppeteer = {
    executablePath: async () => options.missing ? '/missing/chrome-fixture' : process.execPath,
    launch: async (...args) => { launches++; return options.launch ? options.launch(...args) : browser; },
  };
  const listeners = process.listeners('exit');
  require.cache[puppeteerPath] = { id: puppeteerPath, filename: puppeteerPath, loaded: true, exports: puppeteer };
  delete require.cache[modulePath];
  const api = require(modulePath);
  for (const [key, cached] of saved) { if (cached) require.cache[key] = cached; else delete require.cache[key]; }
  const added = process.listeners('exit').filter(listener => !listeners.includes(listener));
  t.after(async () => {
    await api.cleanup();
    for (const listener of added) process.removeListener('exit', listener);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  return { ...api, browser, launches: () => launches };
}

test('missing Chrome fails immediately without launching or retaining queue slots', async t => {
  const api = loadBrowser(t, { missing: true });
  await assert.rejects(api.withPage(() => 'never'), { statusCode: 503 });
  await assert.rejects(api.getBrowser(), { statusCode: 503 });
  assert.equal(api.launches(), 0);
  assert.equal((await api.getBrowserStatus()).activePages, 0);
  assert.equal((await api.getBrowserStatus()).queuedPages, 0);
  assert.equal((await api.getBrowserStatus()).available, false);
});

test('concurrent browser requests share a single launch', async t => {
  const launch = deferred();
  const browser = fakeBrowser();
  const api = loadBrowser(t, { launch: () => launch.promise });
  const requests = [api.getBrowser(), api.getBrowser(), api.getBrowser()];
  launch.resolve(browser);
  const results = await Promise.all(requests);
  assert.ok(results.every(value => value === browser));
  assert.equal(api.launches(), 1);
  await api.cleanup();
  assert.equal(browser.closed, 1);
});

test('a failed extraction closes its page and releases the slot for the next request', async t => {
  const api = loadBrowser(t);
  await assert.rejects(api.withPage(() => { throw new Error('fixture extraction'); }), /fixture extraction/);
  assert.equal(api.browser.created[0].closed, 1);
  assert.equal(await api.withPage(() => 'next'), 'next');
  assert.equal((await api.getBrowserStatus()).activePages, 0);
  assert.equal(api.browser.created[1].closed, 1);
});

test('the browser queue has a fixed capacity and does not grow with more requests', async t => {
  const api = loadBrowser(t);
  const release = deferred();
  const entered = deferred();
  const first = api.withPage(() => { entered.resolve(); return release.promise; });
  await entered.promise;
  const second = api.withPage(() => 'queued');
  await assert.rejects(api.withPage(() => 'overflow'), { statusCode: 503 });
  assert.equal((await api.getBrowserStatus()).queuedPages, 1);
  release.resolve('first');
  assert.deepEqual(await Promise.all([first, second]), ['first', 'queued']);
  assert.equal((await api.getBrowserStatus()).queuedPages, 0);
});

test('an expired content request leaves the browser queue before a slot opens', async t => {
  const api = loadBrowser(t);
  const release = deferred();
  const entered = deferred();
  const first = api.withPage(() => { entered.resolve(); return release.promise; });
  await entered.promise;
  const cache = createContentCache({ timeoutMs: 60 });
  await assert.rejects(cache.get('queued', 0, () => api.withPage(() => 'must not run')), { statusCode: 504 });
  assert.equal((await api.getBrowserStatus()).queuedPages, 0);
  release.resolve();
  await first;
  assert.equal(api.browser.created.length, 1);
});

test('the total deadline closes a page with a never-ending evaluation', async t => {
  const api = loadBrowser(t);
  await assert.rejects(api.withPage(() => new Promise(() => {}), { timeoutMs: 40 }), { statusCode: 504 });
  assert.equal(api.browser.created[0].closed, 1);
  assert.equal((await api.getBrowserStatus()).activePages, 0);
});

test('a stuck newPage call closes the browser and releases capacity', async t => {
  const browser = fakeBrowser();
  browser.newPage = () => new Promise(() => {});
  const api = loadBrowser(t, { browser });
  await assert.rejects(api.withPage(() => 'never', { timeoutMs: 40 }), { statusCode: 504 });
  assert.equal(browser.closed, 1);
  assert.equal((await api.getBrowserStatus()).activePages, 0);
});

test('cleanup also closes a browser whose launch finishes after shutdown', async t => {
  const launch = deferred();
  const entered = deferred();
  const browser = fakeBrowser();
  const api = loadBrowser(t, { launch: () => { entered.resolve(); return launch.promise; } });
  const pending = api.getBrowser();
  await entered.promise;
  await api.cleanup();
  launch.resolve(browser);
  await assert.rejects(pending, { statusCode: 503 });
  assert.equal(browser.closed, 1);
});

test('a renderer that refuses page.close is reclaimed by closing the browser', async t => {
  const api = loadBrowser(t);
  await api.withPage(page => { page.close = () => new Promise(() => {}); return 'done'; });
  assert.equal(api.browser.closed, 1);
  assert.equal((await api.getBrowserStatus()).activePages, 0);
});
