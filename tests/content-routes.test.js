const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { ApiError } = require('../src/utils/api-error');

async function createApi(t, failInfo = false, searchResults = {}, serviceOverrides = {}) {
  const calls = [];
  const searchContent = provider => async query => {
    calls.push(['search', provider, query]);
    if (searchResults[provider] instanceof Error) throw searchResults[provider];
    return searchResults[provider] || [];
  };
  const replacements = {
    '../src/services/pelisplus.service': {
      searchContent: searchContent('pelisplus'),
      getContentInfo: async (...args) => { calls.push(['info', ...args]); if (failInfo) throw new ApiError(400, 'Slug no válido'); return { title: 'El niño' }; },
      getEpisodeServers: async (...args) => { calls.push(['servers', ...args]); return { servers: [] }; },
    },
    '../src/services/repelishd.service': { searchContent: searchContent('repelishd'), getContentInfo: async () => { calls.push(['fallback']); return {}; } },
    '../src/services/cuevana.service': { searchContent: searchContent('cuevana3') },
    '../src/services/download.service': {},
    '../src/utils/resolvers': {},
    '../src/middlewares/rate-limit': { dailyRateLimit: (_req, _res, next) => next() },
  };
  const saved = new Map();
  for (const [provider, overrides] of Object.entries(serviceOverrides)) {
    Object.assign(replacements[`../src/services/${provider}.service`], overrides);
  }
  for (const [name, exports] of Object.entries(replacements)) {
    const key = require.resolve(name); saved.set(key, require.cache[key]);
    require.cache[key] = { id: key, filename: key, loaded: true, exports };
  }
  const routePath = require.resolve('../src/routes/content.routes');
  delete require.cache[routePath];
  const router = require(routePath);
  for (const [key, cached] of saved) { if (cached) require.cache[key] = cached; else delete require.cache[key]; }
  delete require.cache[routePath];
  const app = express();
  app.use('/api', router);
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ success: false, message: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { calls, base: `http://127.0.0.1:${server.address().port}/api` };
}

test('info API passes Unicode and nested anime identity without double decoding', async t => {
  const api = await createApi(t);
  const response = await fetch(`${api.base}/info/anime/ni%C3%B1o?type=anime&provider=pelisplus`);
  assert.equal(response.status, 200);
  assert.deepEqual(api.calls, [['info', 'anime/niño', 'anime']]);
  assert.equal((await response.json()).data.provider, 'pelisplus');
});

test('servers API preserves season zero and forwards anime type and prefixed slug', async t => {
  const api = await createApi(t);
  const response = await fetch(`${api.base}/servers?slug=anime%2Fni%C3%B1o&type=anime&season=0&episode=1`);
  assert.equal(response.status, 200);
  assert.deepEqual(api.calls, [['servers', 'anime/niño', 0, 1, 'anime']]);
});

test('invalid episode numbers, providers and types fail before scraping', async t => {
  const api = await createApi(t);
  for (const suffix of ['/servers?slug=test&season=-1', '/servers?slug=test&episode=1.5', '/servers?slug=test&type=movie', '/info/test?provider=unknown', '/info/test?type=unknown']) {
    const response = await fetch(api.base + suffix);
    assert.equal(response.status, 400, suffix);
  }
  assert.deepEqual(api.calls, []);
});

test('invalid slug does not cascade into unrelated provider requests', async t => {
  const api = await createApi(t, true);
  const response = await fetch(`${api.base}/info/test?provider=pelisplus`);
  assert.equal(response.status, 400);
  assert.deepEqual(api.calls, [['info', 'test', 'movie']]);
});

test('search returns 503 when every provider fails without exposing upstream errors', async t => {
  const api = await createApi(t, false, {
    pelisplus: new Error('Source timeout: https://source.example/private'),
    repelishd: new Error('Connection refused'),
    cuevana3: new Error('Browser unavailable'),
  });
  const response = await fetch(`${api.base}/search?q=El%20ni%C3%B1o`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    success: false,
    message: 'Los proveedores de búsqueda no respondieron. Reintenta en unos minutos.',
  });
  assert.deepEqual(api.calls.map(call => call[1]), ['pelisplus', 'repelishd', 'cuevana3']);
});

test('search preserves a legitimate empty result when one provider responds', async t => {
  const api = await createApi(t, false, {
    pelisplus: [],
    repelishd: new Error('Source unavailable'),
    cuevana3: new Error('Browser unavailable'),
  });
  const response = await fetch(`${api.base}/search?s=Sin%20coincidencias`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.success, true);
  assert.deepEqual(body.data, []);
  assert.deepEqual(api.calls.map(call => call[1]), ['pelisplus', 'repelishd', 'cuevana3']);
});

test('search keeps successful alternative results when another provider fails', async t => {
  const api = await createApi(t, false, {
    pelisplus: new Error('Source unavailable'),
    repelishd: [{ title: 'El niño', slug: 'el-niño' }],
  });
  const response = await fetch(`${api.base}/search?q=El%20ni%C3%B1o`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    success: true,
    data: [{ title: 'El niño', slug: 'el-niño', provider: 'repelishd' }],
    source: 'repelishd',
  });
  assert.deepEqual(api.calls.map(call => call[1]), ['pelisplus', 'repelishd']);
});

test('a failed provider never receives another provider slug through an information or episode cascade', async t => {
  const calls = [];
  const api = await createApi(t, false, {}, {
    pelisplus: {
      getContentInfo: async () => { calls.push('pelisplus-info'); throw new ApiError(504, 'Timeout'); },
      getEpisodeServers: async () => { calls.push('pelisplus-episode'); throw new ApiError(404, 'Episodio no disponible'); },
    },
    repelishd: { getContentInfo: async () => { calls.push('wrong-remake'); return { title: 'Otro título' }; } },
    cuevana: { getContentInfo: async () => { calls.push('wrong-cuevana-slug'); return { title: 'Otro título' }; } },
  });
  assert.equal((await fetch(`${api.base}/info/unique-slug?provider=pelisplus`)).status, 504);
  assert.equal((await fetch(`${api.base}/servers?slug=unique-slug&provider=pelisplus`)).status, 404);
  assert.deepEqual(calls, ['pelisplus-info', 'pelisplus-episode']);
});

test('scoped search keeps provider identity and mixed search reports aggregate while preserving both sources', async t => {
  const api = await createApi(t, false, {
    pelisplus: [{ title: 'VER El niÃ±o Online Gratis HD', slug: 'pp', type: 'movie' }, { title: 'El niño', slug: 'pp', type: 'movie' }],
    repelishd: [{ title: 'El niño', slug: 'rp', type: 'movie' }],
  });
  const mixed = await (await fetch(`${api.base}/search?q=El%20ni%C3%B1o`)).json();
  assert.equal(mixed.source, 'aggregate');
  assert.equal(mixed.data.length, 2);
  assert.ok(mixed.data.every(item => item.title === 'El niño'));
  assert.deepEqual(new Set(mixed.data.map(item => item.provider)), new Set(['pelisplus', 'repelishd']));
  api.calls.length = 0;
  const scoped = await (await fetch(`${api.base}/search?q=El%20ni%C3%B1o&provider=pelisplus`)).json();
  assert.deepEqual(api.calls, [['search', 'pelisplus', 'El niño']]);
  assert.equal(scoped.source, 'pelisplus');
  assert.deepEqual(scoped.data.map(item => item.slug), ['pp']);
});

test('identical readers share searches and cache successful results without sharing different provider keys', async t => {
  let calls = 0;
  let release;
  const api = await createApi(t, false, {}, {
    pelisplus: { searchContent: () => { calls++; return new Promise(resolve => { release = resolve; }); } },
  });
  const path = `${api.base}/search?q=Avatar&provider=pelisplus`;
  const first = fetch(path);
  const second = fetch(path);
  while (!release) await new Promise(resolve => setTimeout(resolve, 1));
  release([{ title: 'Avatar', slug: 'avatar' }]);
  assert.ok((await Promise.all([first, second])).every(response => response.ok));
  assert.equal((await fetch(path)).status, 200);
  assert.equal(calls, 1);
  assert.equal((await fetch(`${api.base}/search?q=Avatar&provider=repelishd`)).status, 200);
  assert.deepEqual(api.calls, [['search', 'repelishd', 'Avatar']]);
});

test('invalid arrays, unsafe pagination and traversal are rejected before any provider runs', async t => {
  const api = await createApi(t);
  for (const path of [
    '/catalog?type=movie&type=series', '/catalog?page=9007199254740992', '/catalog?page=0',
    '/catalog?genre=..%2Fprivate', '/servers?slug=x&episode=1&episode=2',
    '/servers?slug=x&season=9007199254740992', '/info/%252e%252e?provider=pelisplus',
    '/search?q=x&provider=constructor', '/search?q=x&q=y',
  ]) assert.equal((await fetch(api.base + path)).status, 400, path);
  assert.deepEqual(api.calls, []);
});

test('an upstream failure is not cached and the same title can recover immediately', async t => {
  let fail = true;
  const api = await createApi(t, false, {}, {
    pelisplus: { searchContent: async () => {
      if (fail) { fail = false; throw new ApiError(502, 'Source offline'); }
      return [{ title: 'Avatar', slug: 'avatar' }];
    } },
  });
  const path = `${api.base}/search?q=Avatar&provider=pelisplus`;
  assert.equal((await fetch(path)).status, 503);
  const recovered = await fetch(path);
  assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).data[0].slug, 'avatar');
});

test('episode searches skip movie-only sources and retain both series and anime identities', async t => {
  const api = await createApi(t, false, {
    pelisplus: [
      { title: 'Attack on Titan', slug: 'aot', type: 'anime' },
      { title: 'Attack on Titan', slug: 'aot', type: 'series' },
      { title: 'Attack on Titan', slug: 'aot-movie', type: 'movie' },
    ],
    repelishd: [{ title: 'Attack on Titan', slug: 'aot-remake', type: 'movie' }],
  });
  const episodeSearch = await (await fetch(`${api.base}/search?q=Attack%20on%20Titan&type=anime`)).json();
  assert.deepEqual(api.calls, [['search', 'pelisplus', 'Attack on Titan']]);
  assert.deepEqual(episodeSearch.data.map(item => item.type), ['anime', 'series']);
  api.calls.length = 0;
  const movieSearch = await (await fetch(`${api.base}/search?q=Attack%20on%20Titan&type=movie`)).json();
  assert.deepEqual(api.calls.map(call => call[1]), ['pelisplus', 'repelishd']);
  assert.ok(movieSearch.data.every(item => item.type === 'movie'));
  assert.equal((await fetch(`${api.base}/search?q=Attack&type=unknown`)).status, 400);
});
