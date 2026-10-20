const test = require('node:test');
const assert = require('node:assert/strict');
const requests = require('../public/content-requests');

test('info preserves Unicode and nested, already-encoded provider slugs', () => {
  const item = { slug: 'serie/La%20Casa-%C3%81rbol', provider: 'cuevana3', type: 'series' };
  const url = new URL(requests.info(item), 'https://app.example');
  assert.equal(url.pathname, '/info/serie/La%20Casa-%C3%81rbol');
  assert.equal(url.searchParams.get('provider'), 'cuevana3');
  assert.equal(url.searchParams.get('type'), 'series');
  assert.equal(requests.info({ ...item, slug: 'serie/La Casa-Árbol' }), requests.info(item));
});

test('query punctuation cannot alter the info path or inject query parameters', () => {
  const url = new URL(requests.info({ slug: "el-día?test=1&provider=other#corte", type: 'movie', provider: 'pelisplus' }), 'https://app.example');
  assert.equal(decodeURIComponent(url.pathname.slice('/info/'.length)), 'el-día?test=1&provider=other#corte');
  assert.equal(url.searchParams.get('provider'), 'pelisplus');
  assert.equal(url.hash, '');
});

test('episode queries preserve accents, punctuation, provider and anime specials', () => {
  const item = { slug: 'café-&-acción', type: 'anime', provider: 'pelisplus' };
  const url = new URL(requests.servers(item, 0, 1), 'https://app.example');
  assert.equal(url.searchParams.get('slug'), item.slug);
  assert.equal(url.searchParams.get('season'), '0');
  assert.equal(url.searchParams.get('episode'), '1');
  assert.equal(url.searchParams.get('type'), 'anime');
  assert.equal(url.searchParams.get('provider'), 'pelisplus');
});
