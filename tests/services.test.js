const test = require('node:test');
const assert = require('node:assert/strict');
const { ApiError } = require('../src/utils/api-error');
const helpers = require('../src/services/content.helpers');

function service(name, overrides = {}) {
  const httpPath = require.resolve('../src/utils/http');
  const browserPath = require.resolve('../src/utils/browser');
  const axiosPath = require.resolve('axios');
  const servicePath = require.resolve(`../src/services/${name}.service`);
  const saved = new Map([httpPath, browserPath, axiosPath, servicePath].map(key => [key, require.cache[key]]));
  const http = require('../src/utils/http');
  require.cache[httpPath] = { id: httpPath, filename: httpPath, loaded: true, exports: { ...http, fetchHtml: overrides.fetchHtml || (async () => '') } };
  require.cache[browserPath] = { id: browserPath, filename: browserPath, loaded: true, exports: { scrapeWithPage: overrides.scrapeWithPage || (async () => null) } };
  if (overrides.axios) require.cache[axiosPath] = { id: axiosPath, filename: axiosPath, loaded: true, exports: overrides.axios };
  delete require.cache[servicePath];
  const result = require(servicePath);
  for (const [key, cached] of saved) {
    if (cached) require.cache[key] = cached;
    else delete require.cache[key];
  }
  return result;
}

const heading = '<h1 class="m-b-5">Película del niño</h1>';
const cards = `
  <a class="Posters-link" href="/pelicula/ni%C3%B1o?campaign=kept" data-title="VER El niÃ±o Online Gratis HD"><img class="Posters-img" data-src="//images.example/ni%C3%B1o.jpg"><span class="rating"><span>8.5/10</span></span></a>
  <a class="Posters-link" href="/pelicula/ni%C3%B1o" data-title="VER El niÃ±o Online Gratis HD"></a>
  <a class="Posters-link" href="/anime/ni%C3%B1o" data-title="VER El niÃ±o Online Gratis HD"></a>
  <a class="Posters-link" href="javascript:alert(1)" data-title="Bad"></a>`;

test('metadata repair keeps URL bytes and preserves Unicode slugs and special season zero', () => {
  const url = 'https://video.example/e/token?value=Ã±&encoded=%2F%2B';
  const result = helpers.repairMetadata({ title: 'El niÃ±o', url, slug: 'ni%C3%B1o', servers: [{ name: 'EspaÃ±ol', embedUrl: url }], directors: ['José', '', 'José'] });
  assert.equal(result.title, 'El niño');
  assert.equal(result.url, url);
  assert.equal(result.slug, 'ni%C3%B1o');
  assert.equal(result.servers[0].embedUrl, url);
  assert.deepEqual(result.directors, ['José']);
  assert.equal(helpers.normalizeSlug('anime/ni%C3%B1o', { prefixes: ['anime'] }), 'niño');
  assert.equal(helpers.encodedSlug('serie/niño'), 'serie/ni%C3%B1o');
  assert.deepEqual(helpers.episodeNumbers(0, 1), { seasonNumber: 0, episodeNumber: 1 });
  for (const slug of ['../secret', 'abc%2Fdef', 'abc%252Fdef', '%ZZ']) assert.throws(() => helpers.normalizeSlug(slug), { statusCode: 400 });
});

test('PelisPlus search cleans titles, deduplicates per type and encodes Unicode query once', async () => {
  const requests = [];
  const api = service('pelisplus', { fetchHtml: async url => { requests.push(url); return cards; } });
  const results = await api.searchContent('El niño & él');
  assert.equal(requests[0], 'https://www.pelisplushd.la/search?s=El%20ni%C3%B1o%20%26%20%C3%A9l');
  assert.equal(results.length, 2);
  assert.equal(results[0].title, 'El niño');
  assert.equal(results[0].slug, 'niño');
  assert.equal(results[0].poster, 'https://images.example/ni%C3%B1o.jpg');
  assert.equal(results[1].type, 'anime');
});

test('PelisPlus catalog keeps movie/series/anime routes, metadata and page validation', async () => {
  const requests = [];
  const api = service('pelisplus', { fetchHtml: async url => { requests.push(url); return cards + '<div class="pagination"><a rel="next"></a></div>'; } });
  for (const type of ['movie', 'series', 'anime']) assert.equal((await api.getCatalog(type, '', 2)).hasNextPage, true);
  assert.deepEqual(requests.map(url => new URL(url).pathname), ['/peliculas', '/series', '/animes']);
  assert.equal((await api.getCatalog('movie', 'ciencia-ficci%C3%B3n')).items[0].title, 'El niño');
  assert.equal(new URL(requests.at(-1)).pathname, '/generos/ciencia-ficci%C3%B3n');
  await assert.rejects(api.getCatalog('unknown'), { statusCode: 400 });
  await assert.rejects(api.getCatalog('movie', '', -1), { statusCode: 400 });
});

test('PelisPlus information excludes navigation genres and deduplicates clean metadata', async () => {
  const html = `${heading}<img class="img-fluid d-block mx-auto m-b-30" src="https://images.example/poster.jpg">
    <nav><a href="/generos/terror">Terror</a></nav><div class="dropdown-menu"><a href="/generos/drama">Drama</a></div>
    <p class="text-opacity">@\n El niÃ±o</p><p class="text-large">Aventura espaÃ±ola.</p><span class="font-size-18 text-info">2024</span>
    <div class="sectionDetail"><a href="/generos/accion">AcciÃ³n</a><a href="/generos/acci%C3%B3n">Acción</a></div>
    <div class="sectionDetail">Director: <a>JosÃ© García</a><a>José García</a><a> </a></div>
    <div class="sectionDetail">Actores: <a>MarÃ­a</a><a>María</a></div>`;
  const api = service('pelisplus', { fetchHtml: async () => html });
  const info = await api.getContentInfo('pelicula/ni%C3%B1o');
  assert.equal(info.slug, 'niño');
  assert.equal(info.originalTitle, 'El niño');
  assert.equal(info.synopsis, 'Aventura española.');
  assert.equal(info.poster, 'https://images.example/poster.jpg');
  assert.deepEqual(info.genres, [{ name: 'Acción', slug: 'accion' }]);
  assert.deepEqual(info.directors, ['José García']);
  assert.deepEqual(info.cast, ['María']);
});

test('PelisPlus episodes survive nonadjacent lists and deduplicate seasons in numeric order', async () => {
  const html = `${heading}<div class="divseason">Temporada 1</div><div>Separador</div><section>
    <a href="/anime/ni%C3%B1o/temporada/2/capitulo/10">CapÃ­tulo 10</a>
    <a href="/anime/ni%C3%B1o/temporada/1/capitulo/2">CapÃ­tulo 2</a>
    <a href="/anime/ni%C3%B1o/temporada/0/capitulo/1">Especial</a>
    <a href="/anime/ni%C3%B1o/temporada/1/capitulo/1">Inicio</a>
    <a href="/anime/ni%C3%B1o/temporada/1/capitulo/1">Duplicado</a></section>`;
  const requests = [];
  const api = service('pelisplus', { fetchHtml: async url => { requests.push(url); return html; } });
  const info = await api.getContentInfo('ni%C3%B1o', 'anime');
  assert.equal(requests[0], 'https://www.pelisplushd.la/anime/ni%C3%B1o');
  assert.deepEqual(info.seasons.map(season => season.number), [0, 1, 2]);
  assert.deepEqual(info.seasons[1].episodes.map(episode => episode.number), [1, 2]);
  assert.equal(info.seasons[2].episodes[0].title, 'Capítulo 10');
});

test('PelisPlus anime fallback handles older series URLs without double encoding', async () => {
  const requests = [];
  const api = service('pelisplus', { fetchHtml: async url => {
    requests.push(url);
    if (url.includes('/anime/')) throw new ApiError(404, 'Not found');
    return heading;
  } });
  const info = await api.getContentInfo('ni%C3%B1o', 'anime');
  assert.deepEqual(requests, ['https://www.pelisplushd.la/anime/ni%C3%B1o', 'https://www.pelisplushd.la/serie/ni%C3%B1o']);
  assert.equal(info.type, 'anime');
});

test('PelisPlus combines modern and classic servers, preserving languages, tokens and season zero', async () => {
  const requests = [];
  const token = 'https://video.example/e/a?token=raw%2Fkept&amp;s=1';
  const html = `${heading}<div class="divseason">EspaÃ±ol Latino</div><ul class="TbVideoNv"><li data-id="1">Voe</li></ul>
    <div id="link_url"><span lid="1" url="${token}"></span></div>
    <li class="playurl" data-url="${token}" data-name="Español Latino"><a>Voe</a></li>
    <li class="playurl" data-url="https://video.example/e/sub" data-name="Subtitulado"><a>Streamwish</a></li>
    <li class="playurl" data-url="javascript:alert(1)" data-name="Latino"></li>`;
  const api = service('pelisplus', { fetchHtml: async url => { requests.push(url); return html; } });
  const episode = await api.getEpisodeServers('anime/ni%C3%B1o', 0, 1, 'anime');
  assert.equal(requests[0], 'https://www.pelisplushd.la/anime/ni%C3%B1o/temporada/0/capitulo/1');
  assert.equal(episode.season, 0);
  assert.equal(episode.servers.length, 2);
  assert.equal(episode.servers[0].language, 'Español Latino');
  assert.equal(episode.servers[0].embedUrl, 'https://video.example/e/a?token=raw%2Fkept&s=1');
  await assert.rejects(api.getEpisodeServers('../bad', 1, 1), { statusCode: 400 });
  await assert.rejects(api.getEpisodeServers('fine', 1.5, 1), { statusCode: 400 });
});

test('RePelisHD search decodes raw POST bytes and rejects unrelated links', async () => {
  let options;
  const html = '<div id="dle-content"><article class="item"><div class="poster"><a href="/ver-pelicula/ni%C3%B1o.html"><img src="/poster.jpg"></a></div><div class="data"><h3><a>El niÃ±o</a></h3><span>HD 2024</span></div></article><article class="item"><div class="poster"><a href="/about"></a></div><div class="data"><h3><a>About</a></h3></div></article></div>';
  const api = service('repelishd', { axios: { post: async (url, body, supplied) => { options = supplied; return { data: Buffer.from(html), headers: { 'content-type': 'text/html; charset=utf-8' } }; } } });
  const results = await api.searchContent('niño');
  assert.equal(options.responseType, 'arraybuffer');
  assert.deepEqual(options.transformResponse, []);
  assert.equal(results.length, 1);
  assert.equal(results[0].title, 'El niño');
  assert.equal(results[0].slug, 'niño');
  assert.equal(results[0].year, '2024');
});

test('RePelisHD details retain only content genres and valid distinct mirrors', async () => {
  const requests = [];
  const main = '<h1>El niÃ±o online HD</h1><nav><a href="/genero/terror">Terror</a></nav><div class="info">2024</div><div class="description"><p>Historia espaÃ±ola</p><a href="/genero/accion">AcciÃ³n</a><a href="/genero/accion">Acción</a></div><iframe data-src="//verhdlink.cam/player/xyz"></iframe>';
  const mirror = '<ul class="latino"><li data-link="//streamwish.to/e/xyz?token=raw%2Fkept">Streamwish</li><li data-link="//streamwish.to/e/xyz?token=raw%2Fkept">Streamwish</li><li data-link="javascript:alert(1)">Bad</li></ul>';
  const api = service('repelishd', { fetchHtml: async (url, headers) => { requests.push({ url, headers }); return url.includes('verhdlink.cam') ? mirror : main; } });
  const info = await api.getContentInfo('ni%C3%B1o');
  assert.equal(requests[0].url, 'https://repelishd.ceo/ver-pelicula/ni%C3%B1o.html');
  assert.equal(requests[1].headers.Referer, requests[0].url);
  assert.equal(info.title, 'El niño');
  assert.equal(info.synopsis, 'Historia española');
  assert.equal(info.year, '2024');
  assert.deepEqual(info.genres, [{ name: 'Acción', slug: 'accion' }]);
  assert.equal(info.servers.length, 1);
  assert.equal(info.servers[0].embedUrl, 'https://streamwish.to/e/xyz?token=raw%2Fkept');
  await assert.rejects(api.getContentInfo('series-title', 'series'), { statusCode: 404 });
  await assert.rejects(api.getEpisodeServers('series-title', 1, 1), { statusCode: 404 });
});

test('Cuevana repairs nested metadata after browser extraction and preserves encoded URLs', async () => {
  const requests = [];
  const token = 'https://video.example/e/a?key=%2F%2BÃ±';
  const api = service('cuevana', { scrapeWithPage: async url => {
    requests.push(url);
    if (url.includes('?s=')) return [{ title: 'VER El niÃ±o Online Gratis HD', slug: '123/ni%C3%B1o', url: token }];
    return { title: 'El niÃ±o', synopsis: 'Aventura espaÃ±ola', directors: ['JosÃ©', 'José', ''], servers: [{ name: 'EspaÃ±ol', language: 'EspaÃ±ol Latino', embedUrl: token }] };
  } });
  assert.equal((await api.searchContent('niño'))[0].title, 'El niño');
  const info = await api.getContentInfo('123/ni%C3%B1o');
  assert.equal(requests[1], 'https://ww9.cuevana3.to/123/ni%C3%B1o');
  assert.equal(info.title, 'El niño');
  assert.deepEqual(info.directors, ['José']);
  assert.equal(info.servers[0].embedUrl, token);
  assert.equal(info.servers[0].language, 'Español Latino');
});

test('Cuevana anime episode routes remove anime prefix and support special season zero', async () => {
  const requests = [];
  const api = service('cuevana', { scrapeWithPage: async url => { requests.push(url); return { servers: [{ name: 'EspaÃ±ol', embedUrl: 'https://video.example/e/1' }] }; } });
  const result = await api.getEpisodeServers('anime/ni%C3%B1o', 0, 2);
  assert.equal(requests[0], 'https://ww9.cuevana3.to/episodio/ni%C3%B1o-0x2');
  assert.equal(result.season, 0);
  assert.equal(result.servers[0].name, 'Español');
  await assert.rejects(api.getEpisodeServers('fine', -1, 1), { statusCode: 400 });
  await assert.rejects(service('cuevana').getContentInfo('missing'), { statusCode: 404 });
});

test('PelisPlus tries the alternate anime route when a valid page has no servers', async () => {
  const requests = [];
  const api = service('pelisplus', { fetchHtml: async url => {
    requests.push(url);
    return url.includes('/anime/') ? heading : `${heading}<li class="playurl" data-url="https://video.example/e/real" data-name="Latino"><a>Voe</a></li>`;
  } });
  const episode = await api.getEpisodeServers('attack-on-titan', 1, 1, 'anime');
  assert.equal(requests.length, 2);
  assert.ok(requests[0].includes('/anime/attack-on-titan/'));
  assert.ok(requests[1].includes('/serie/attack-on-titan/'));
  assert.equal(episode.servers.length, 1);
  assert.equal(episode.servers[0].embedUrl, 'https://video.example/e/real');
});

test('PelisPlus retains an existing empty episode when neither route exposes servers', async () => {
  const api = service('pelisplus', { fetchHtml: async () => heading });
  const episode = await api.getEpisodeServers('empty-anime', 1, 1, 'anime');
  assert.equal(episode.servers.length, 0);
  assert.ok(episode.url.includes('/anime/empty-anime/'));
});
