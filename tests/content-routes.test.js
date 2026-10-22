const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { ApiError } = require('../src/utils/api-error');

async function createApi(t, failInfo = false, searchResults = {}) {
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
