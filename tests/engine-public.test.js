const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const requests = require('../public/content-requests');

class Element {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.children = [];
    this.attributes = {};
    this.style = {};
    this.textContent = '';
    this.listeners = new Map();
    const names = new Set();
    this.classList = { add: (...values) => values.forEach(value => names.add(value)), remove: (...values) => values.forEach(value => names.delete(value)), contains: value => names.has(value), toggle: value => names.has(value) ? names.delete(value) : names.add(value) };
  }
  set innerHTML(value) { this.children = []; this.html = value; }
  get innerHTML() { return this.html || ''; }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  append(...children) { children.forEach(child => this.appendChild(child)); }
  replaceChild(next, previous) { this.children[this.children.indexOf(previous)] = next; next.parentNode = this; previous.parentNode = null; }
  remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; }
  cloneNode() { const copy = new Element(this.tagName); copy.attributes = { ...this.attributes }; return copy; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  querySelector() { return new Element(); }
  querySelectorAll() { return []; }
  scrollIntoView() {}
  getBoundingClientRect() { return { top: 400, bottom: 500 }; }
}
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function fixture() {
  const nodes = new Map();
  const calls = [];
  const frames = [];
  const document = {
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); },
    querySelectorAll() { return []; },
    addEventListener() {},
    createElement: tag => new Element(tag),
    createTextNode: text => ({ textContent: text }),
    body: new Element('body'),
  };
  const context = vm.createContext({
    document,
    window: { addEventListener() {}, innerHeight: 800 },
    URL, URLSearchParams, AbortController, PeliRequests: requests,
    setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {},
    requestAnimationFrame: callback => frames.push(callback),
    console: { error() {}, log() {} },
    fetch: (url, options) => {
      const pending = deferred();
      calls.push({ url, options, ...pending });
      return pending.promise;
    },
  });
  new Element().appendChild(document.getElementById('player-iframe'));
  const source = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');
  vm.runInContext(source + '\n globalThis.ui = {state, loadMediaDetails, closeDetailsModal, fetchEpisodeServers, apiFetch, performSearch, loadFilteredCatalog, playEmbedVideo, schedulePaginationCheck};', context);
  const reply = (call, data) => call.resolve({ ok: true, json: async () => ({ success: true, data }) });
  return { ui: context.ui, context, nodes, calls, frames, reply };
}
const movie = slug => ({ slug, title: slug, type: 'movie', provider: 'pelisplus', url: `https://catalog.example/pelicula/${slug}` });

test('public details keep latest title and never restore servers from a previous selection', async () => {
  const f = fixture();
  const rendered = [];
  f.context.renderServers = servers => rendered.push(servers);
  const oldFrame = f.nodes.get('player-iframe');
  oldFrame.src = 'https://video.example/old';
  const first = f.ui.loadMediaDetails(movie('one'));
  const second = f.ui.loadMediaDetails(movie('two'));
  assert.equal(oldFrame.parentNode, null);
  assert.equal(f.ui.state.selectedMedia, null);
  f.reply(f.calls[1], { ...movie('two'), servers: [{ name: 'two' }] });
  await second;
  f.reply(f.calls[0], { ...movie('one'), servers: [{ name: 'one' }] });
  await first;
  assert.equal(f.ui.state.selectedMedia.slug, 'two');
  assert.equal(f.nodes.get('details-title').textContent, 'two');
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0][0].name, 'two');
});

test('closing public details invalidates a pending response and releases the previous iframe', async () => {
  const f = fixture();
  const pending = f.ui.loadMediaDetails(movie('one'));
  f.ui.closeDetailsModal();
  f.reply(f.calls[0], { ...movie('one'), servers: [{ name: 'one' }] });
  await pending;
  assert.equal(f.ui.state.selectedMedia, null);
  assert.equal(f.nodes.get('details-panel').classList.contains('hidden'), true);
  assert.equal(f.nodes.get('video-player-container').classList.contains('hidden'), true);
});

test('public episode responses cannot replace newer episode servers or loading state', async () => {
  const f = fixture();
  const rendered = [];
  f.context.renderServers = servers => rendered.push(servers);
  f.ui.state.selectedMedia = { ...movie('attack-on-titan'), type: 'anime' };
  f.ui.state.activeEpisode = 3;
  const first = f.ui.fetchEpisodeServers({ number: 3 });
  f.ui.state.activeEpisode = 4;
  const second = f.ui.fetchEpisodeServers({ number: 4 });
  f.reply(f.calls[0], { servers: [{ name: 'episode 3' }] });
  await first;
  assert.equal(f.nodes.get('servers-loading').classList.contains('hidden'), false);
  f.reply(f.calls[1], { servers: [{ name: 'episode 4' }] });
  await second;
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0][0].name, 'episode 4');
  assert.equal(f.nodes.get('servers-loading').classList.contains('hidden'), true);
});

test('hero and details share an identical GET without aborting each other', async () => {
  const f = fixture();
  const first = f.ui.apiFetch('/info/shared?type=movie');
  const second = f.ui.apiFetch('/info/shared?type=movie');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].options.signal.aborted, false);
  f.reply(f.calls[0], { title: 'Shared' });
  assert.equal((await first).title, 'Shared');
  assert.equal((await second).title, 'Shared');
  const third = f.ui.apiFetch('/info/shared?type=movie');
  assert.equal(f.calls.length, 2);
  f.reply(f.calls[1], { title: 'Fresh' });
  assert.equal((await third).title, 'Fresh');
});

test('public searches keep the latest results when different queries finish out of order', async () => {
  const f = fixture();
  f.context.displayResults = () => {};
  const first = f.ui.performSearch('one');
  const second = f.ui.performSearch('two');
  f.reply(f.calls[1], [movie('two')]);
  await second;
  f.reply(f.calls[0], [movie('one')]);
  await first;
  assert.equal(f.ui.state.results[0].slug, 'two');
});

test('public catalog ignores stale filters and retries a failed page without skipping it', async () => {
  const f = fixture();
  f.context.displayResults = () => {};
  f.ui.state.filters.type = 'movie';
  const movies = f.ui.loadFilteredCatalog();
  f.ui.state.filters.type = 'anime';
  const anime = f.ui.loadFilteredCatalog();
  f.reply(f.calls[1], { items: [{ ...movie('new'), type: 'anime' }], hasNextPage: true });
  await anime;
  f.reply(f.calls[0], { items: [movie('old')], hasNextPage: true });
  await movies;
  assert.equal(f.ui.state.results[0].slug, 'new');
  const failingPage = f.ui.loadFilteredCatalog(false);
  assert.match(f.calls[2].url, /page=2$/);
  f.calls[2].reject(new Error('offline'));
  await failingPage;
  assert.equal(f.ui.state.currentPage, 1);
  const retryButton = f.nodes.get('results-empty').children.at(-1);
  assert.equal(retryButton.textContent, 'Reintentar');
  retryButton.listeners.get('click')();
  assert.match(f.calls[3].url, /page=2$/);
  f.reply(f.calls[3], { items: [{ ...movie('next'), type: 'anime' }], hasNextPage: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.ui.state.currentPage, 2);
  assert.equal(f.ui.state.results.length, 2);
});

test('public pagination rechecks a sentinel that stays visible after rendering', async () => {
  const f = fixture();
  f.context.displayResults = () => {};
  f.ui.state.filters.type = 'movie';
  const first = f.ui.loadFilteredCatalog();
  f.reply(f.calls[0], { items: [movie('one')], hasNextPage: true });
  await first;
  f.frames.shift()();
  assert.equal(f.calls.length, 2);
  assert.match(f.calls[1].url, /page=2$/);
  f.reply(f.calls[1], { items: [movie('one')], hasNextPage: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.ui.state.hasNextPage, false, 'repeated upstream pages stop automatic pagination');
  assert.equal(f.ui.state.results.length, 1);
});

test('public playback rejects non-HTTP embeds and replaces the browsing context for each valid server', () => {
  const f = fixture();
  f.ui.state.selectedMedia = movie('one');
  const old = f.nodes.get('player-iframe');
  f.ui.playEmbedVideo('javascript:alert(1)', 'bad', 'Latino');
  assert.notEqual(old.parentNode, null);
  f.ui.playEmbedVideo('https://video.example/e/a?token=%2Fraw', 'one', 'Latino');
  assert.equal(old.parentNode, null);
  const firstFrame = old.parentNode;
  assert.equal(f.nodes.get('video-player-container').classList.contains('hidden'), false);
  assert.equal(firstFrame, null);
});
