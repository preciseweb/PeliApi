const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { Readable, Writable, PassThrough } = require('node:stream');

function fixture({ htmlResponse = false, emptySlugs = [], source = null, env = {}, responseFactory = null, ffmpegFactory = null, resolvedUrl = null } = {}) {
  const calls = [];
  const responses = [];
  const removed = [];
  let now = 100000;
  class Clock extends Date { static now() { return now; } }
  const filename = require.resolve('../src/services/download.service');
  const fromService = createRequire(filename);
  const ffmpeg = ffmpegFactory || (() => { throw new Error('FFmpeg must never run during unit tests'); });
  ffmpeg.setFfmpegPath = () => {};
  const provider = {
    async getContentInfo(slug, type) {
      calls.push({ slug, type });
      return { servers: emptySlugs.includes(slug) ? [] : [{ server: 'test', name: 'Test', language: 'Latino', embedUrl: 'https://video.example/file.mp4' }] };
    },
    async getEpisodeServers(slug, season, episode, type) {
      calls.push({ slug, season, episode, type });
      if (source) await source;
      return { servers: episode === 2 ? [] : [{ server: 'test', name: 'Test', language: 'Latino', embedUrl: 'https://video.example/file.mp4' }] };
    },
  };
  const mocks = {
    'node:fs': {
      mkdirSync() {},
      createWriteStream: () => new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
      promises: { unlink: async target => { removed.push(target); }, stat: async () => ({ size: 512 * 1024 }) },
    },
    axios: { async get() {
      const stream = responseFactory ? responseFactory() : Readable.from([Buffer.alloc(512 * 1024)]);
      responses.push(stream);
      return { headers: { 'content-type': htmlResponse ? 'text/html' : 'video/mp4', 'content-length': String(512 * 1024) }, data: stream };
    } },
    'ffmpeg-static': '/not-executed/ffmpeg',
    'fluent-ffmpeg': ffmpeg,
    './pelisplus.service': provider, './repelishd.service': provider, './cuevana.service': provider,
    '../utils/resolvers': { resolveEmbedUrl: async url => resolvedUrl || url },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, require: name => mocks[name] || fromService(name), process: { env, cwd: () => '/virtual' }, console: { log() {} }, URL, Buffer, AbortController, queueMicrotask, setTimeout, clearTimeout, Date: Clock }, { filename });
  return { api: module.exports, calls, responses, removed, advance: milliseconds => { now += milliseconds; } };
}
async function settled(api, id) {
  for (let i = 0; i < 15; i++) {
    const item = api.getDownload(id);
    if (item.status === 'completed' || item.status === 'failed') return item;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('Mock transfer did not settle');
}

test('download snapshots include the filename consumed by the CLI', async () => {
  const { api } = fixture();
  const created = api.createDownload({ url: 'https://www.pelisplushd.la/pelicula/example' }, 'https://api.example');
  const result = await settled(api, created.downloadId);
  assert.equal(result.status, 'completed');
  assert.match(result.fileName, /^example-movie-test-[a-f0-9]+\.mp4$/);
  assert.equal(result.downloadUrl, `https://api.example/downloads/${result.fileName}`);
});

test('download lookup preserves encoded provider slugs and anime episode type', async () => {
  const { api, calls } = fixture();
  const movie = api.createDownload({ url: 'https://www.pelisplushd.la/pelicula/el-ni%C3%B1o' }, 'https://api.example');
  await settled(api, movie.downloadId);
  assert.equal(calls[0].slug, 'el-ni%C3%B1o');
  const anime = api.createDownload({ url: 'https://www.pelisplushd.la/anime/ni%C3%B1o/temporada/0/capitulo/1' }, 'https://api.example');
  await settled(api, anime.downloadId);
  assert.equal(calls[1].slug, 'ni%C3%B1o');
  assert.equal(calls[1].type, 'anime');
  assert.equal(calls[1].season, 0);
});

test('rejected non-video HTTP streams are destroyed instead of keeping their socket alive', async () => {
  const { api, responses } = fixture({ htmlResponse: true });
  const created = api.createDownload({ url: 'https://www.pelisplushd.la/pelicula/example' }, 'https://api.example');
  const result = await settled(api, created.downloadId);
  assert.equal(result.status, 'failed');
  assert.equal(responses.length, 1);
  assert.equal(responses[0].destroyed, true);
});

test('batches deduplicate integer episodes, retain season zero and finish mixed outcomes', async () => {
  const { api, calls } = fixture();
  const batch = api.createBatch({ mediaUrl: 'https://www.pelisplushd.la/anime/title?tracking=kept', season: 0, episodes: [1, '1', 2, 1.5, -3, Infinity] }, 'https://api.example');
  assert.equal(batch.total, 2);
  for (const item of batch.items) await settled(api, item.downloadId);
  const result = api.getBatch(batch.batchId);
  assert.equal(result.status, 'completed');
  assert.equal(result.progress, 100);
  assert.equal(result.completed, 1);
  assert.equal(result.failed, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].season, 0);
  assert.equal(calls[1].episode, 2);
});

test('invalid batch seasons, protocols and fractional-only episode lists do not start work', () => {
  const { api, calls } = fixture();
  const payload = { mediaUrl: 'https://www.pelisplushd.la/anime/title', episodes: [1] };
  for (const season of [-1, 1.5, 'wrong']) assert.throws(() => api.createBatch({ ...payload, season }, 'https://api.example'), { statusCode: 400 });
  assert.throws(() => api.createBatch({ ...payload, mediaUrl: 'file:///tmp/title' }, 'https://api.example'), { statusCode: 400 });
  assert.throws(() => api.createBatch({ ...payload, episodes: [1.5] }, 'https://api.example'), { statusCode: 400 });
  assert.equal(calls.length, 0);
});

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const tick = () => new Promise(resolve => setImmediate(resolve));

test('download queue bounds running and queued work, rejects excess jobs and cancels waiting jobs', async () => {
  const source = deferred();
  const f = fixture({ source: source.promise, env: { DOWNLOAD_CONCURRENCY: '1', DOWNLOAD_MAX_QUEUED: '1' } });
  const url = 'https://www.pelisplushd.la/anime/title/temporada/1/capitulo/1';
  const first = f.api.createDownload({ url }, 'https://api.example');
  const second = f.api.createDownload({ url }, 'https://api.example');
  assert.equal(first.status, 'queued');
  assert.equal(second.status, 'queued');
  assert.throws(() => f.api.createDownload({ url }, 'https://api.example'), { statusCode: 429 });
  await tick();
  assert.equal(f.calls.length, 1, 'only one provider operation starts');
  assert.equal(f.api.getDownload(second.downloadId).status, 'queued');
  assert.throws(() => f.api.createBatch({ mediaUrl: 'https://www.pelisplushd.la/anime/other', episodes: [1, 2] }, 'https://api.example'), { statusCode: 429 });
  await f.api.cleanup();
  assert.equal(f.api.getDownload(first.downloadId).status, 'failed');
  assert.equal(f.api.getDownload(second.downloadId).status, 'failed');
  assert.equal(f.calls.length, 1, 'shutdown never starts queued work');
  assert.throws(() => f.api.createDownload({ url }, 'https://api.example'), { statusCode: 503 });
});

test('download queue starts the next item after a terminal job releases its slot', async () => {
  const source = deferred();
  const f = fixture({ source: source.promise, env: { DOWNLOAD_CONCURRENCY: '1', DOWNLOAD_MAX_QUEUED: '2' } });
  const created = [1, 2, 3].map(episode => f.api.createDownload({ url: `https://www.pelisplushd.la/anime/title/temporada/1/capitulo/${episode}` }, 'https://api.example'));
  await tick();
  assert.equal(f.calls.length, 1);
  source.resolve();
  for (const item of created) await settled(f.api, item.downloadId);
  assert.deepEqual(f.calls.map(call => call.episode), [1, 2, 3]);
});

test('shutdown destroys an active transfer, removes partial output and stops queued downloads', async () => {
  const f = fixture({ responseFactory: () => new PassThrough() });
  const payload = { url: 'https://www.pelisplushd.la/pelicula/example' };
  const first = f.api.createDownload(payload, 'https://api.example');
  const second = f.api.createDownload(payload, 'https://api.example');
  await tick();
  assert.equal(f.responses.length, 1);
  assert.equal(f.api.getDownload(first.downloadId).status, 'downloading');
  await f.api.cleanup();
  assert.equal(f.responses[0].destroyed, true);
  assert.equal(f.api.getDownload(first.downloadId).status, 'failed');
  assert.equal(f.api.getDownload(second.downloadId).status, 'failed');
  assert.ok(f.removed.some(file => file.endsWith('.mp4')));
  assert.equal(f.calls.length, 1);
});

test('shutdown terminates an active FFmpeg command and removes only its partial output', async () => {
  const events = new Map();
  let kills = 0;
  const command = {
    inputOptions() { return this; }, outputOptions() { return this; }, output() { return this; },
    on(name, callback) { events.set(name, callback); return this; },
    run() { events.get('start')?.(); return this; },
    kill(signal) { assert.equal(signal, 'SIGKILL'); kills++; return this; },
  };
  const f = fixture({ ffmpegFactory: () => command, resolvedUrl: 'https://video.example/stream.m3u8' });
  const first = f.api.createDownload({ url: 'https://www.pelisplushd.la/pelicula/example' }, 'https://api.example');
  await tick();
  assert.equal(f.api.getDownload(first.downloadId).status, 'downloading');
  await f.api.cleanup();
  assert.ok(kills >= 1);
  assert.equal(f.api.getDownload(first.downloadId).status, 'failed');
  assert.ok(f.removed.some(file => file.endsWith('.mp4')));
});

test('terminal metadata has a fixed limit and TTL while completed files remain untouched', async () => {
  const f = fixture({ env: { DOWNLOAD_HISTORY_LIMIT: '1', DOWNLOAD_HISTORY_TTL_MS: '1000' } });
  const payload = { url: 'https://www.pelisplushd.la/pelicula/example' };
  const first = f.api.createDownload(payload, 'https://api.example');
  await settled(f.api, first.downloadId);
  await tick();
  f.advance(10);
  const second = f.api.createDownload(payload, 'https://api.example');
  await settled(f.api, second.downloadId);
  await tick();
  assert.throws(() => f.api.getDownload(first.downloadId), { statusCode: 404 });
  assert.equal(f.api.getDownload(second.downloadId).status, 'completed');
  f.advance(1001);
  assert.throws(() => f.api.getDownload(second.downloadId), { statusCode: 404 });
  await f.api.cleanup();
  assert.equal(f.removed.length, 0, 'metadata retention and shutdown never delete completed downloads');
});

test('batch terminal snapshots survive child metadata eviction and expire with their own TTL', async () => {
  const f = fixture({ env: { DOWNLOAD_HISTORY_LIMIT: '1', DOWNLOAD_HISTORY_TTL_MS: '1000' } });
  const batch = f.api.createBatch({ mediaUrl: 'https://www.pelisplushd.la/anime/title', episodes: [1, 2] }, 'https://api.example');
  for (let i = 0; i < 15 && f.api.getBatch(batch.batchId).status === 'downloading'; i++) await tick();
  const result = f.api.getBatch(batch.batchId);
  assert.equal(result.status, 'completed');
  assert.equal(result.completed, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.items.length, 2);
  assert.throws(() => f.api.getDownload(batch.items[0].downloadId), { statusCode: 404 });
  f.advance(1001);
  assert.throws(() => f.api.getBatch(batch.batchId), { statusCode: 404 });
});
