const test = require('node:test');
const assert = require('node:assert/strict');
const { ApiError } = require('../src/utils/api-error');
const { episodeNumbers } = require('../src/services/content.helpers');

function service(name, overrides = {}) {
  const paths = ['../src/utils/http', '../src/utils/browser', 'axios', `../src/services/${name}.service`].map(require.resolve);
  const saved = new Map(paths.map(path => [path, require.cache[path]]));
  const http = require('../src/utils/http');
  require.cache[paths[0]] = { id: paths[0], filename: paths[0], loaded: true, exports: { ...http, fetchHtml: overrides.fetchHtml || (async () => '') } };
  require.cache[paths[1]] = { id: paths[1], filename: paths[1], loaded: true, exports: { scrapeWithPage: overrides.scrapeWithPage || (async () => { throw new Error('Unexpected browser fallback'); }) } };
  if (overrides.axios) require.cache[paths[2]] = { id: paths[2], filename: paths[2], loaded: true, exports: overrides.axios };
  delete require.cache[paths[3]];
  const result = require(paths[3]);
  for (const [path, cached] of saved) {
    if (cached) require.cache[path] = cached;
    else delete require.cache[path];
  }
  return result;
}

const heading = '<h1 class="m-b-5">El niño</h1>';
const card = '<a class="Posters-link" href="/pelicula/el-nino" data-title="El niño"></a>';

test('episode numbers reject precision loss instead of requesting a different episode', () => {
  assert.throws(() => episodeNumbers(Number.MAX_SAFE_INTEGER + 1, 1), { statusCode: 400 });
  assert.throws(() => episodeNumbers(1, '9999999999999999999999'), { statusCode: 400 });
});

test('PelisPlus rejects external content links while allowing external poster hosts', async () => {
  const api = service('pelisplus', { fetchHtml: async () => card + '<a class="Posters-link" href="https://other.example/pelicula/el-nino" data-title="Other"></a>' });
  const result = await api.searchContent('El niño');
  assert.equal(result.length, 1);
  assert.equal(result[0].url, 'https://www.pelisplushd.la/pelicula/el-nino');
});

test('PelisPlus distinguishes a valid empty source listing from a challenge or changed page', async () => {
  const empty = service('pelisplus', { fetchHtml: async () => '<div class="Posters"></div>' });
  assert.deepEqual(await empty.searchContent('Unknown'), []);
  const challenge = service('pelisplus', { fetchHtml: async () => '<title>Just a moment</title><p>Checking your browser</p>' });
  await assert.rejects(challenge.searchContent('Unknown'), { statusCode: 503 });
  await assert.rejects(challenge.getCatalog('movie'), { statusCode: 503 });
});

test('PelisPlus final pagination page cannot loop on a previous numbered link', async () => {
  const api = service('pelisplus', { fetchHtml: async () => `${card}<ul class="pagination"><li class="page-item"><a href="?page=1">1</a></li><li class="page-item"><a href="?page=2">2</a></li><li class="page-item active"><span>3</span></li><li class="page-item"><a href="?page=2" rel="prev">Anterior</a></li></ul>` });
  assert.equal((await api.getCatalog('movie', '', 3)).hasNextPage, false);
});

test('PelisPlus ignores disabled/external next links and recognizes a larger page', async () => {
  const html = `${card}<div class="pagination"><li class="disabled"><a rel="next" href="?page=4">Next</a></li><a rel="next" href="https://ads.example/peliculas?page=5">5</a></div>`;
  assert.equal((await service('pelisplus', { fetchHtml: async () => html }).getCatalog('movie', '', 3)).hasNextPage, false);
  assert.equal((await service('pelisplus', { fetchHtml: async () => html.replace('</div>', '<a href="?page=4">4</a></div>') }).getCatalog('movie', '', 3)).hasNextPage, true);
});

test('PelisPlus metadata falls back from an anime shell to its own season list', async () => {
  const requests = [];
  const api = service('pelisplus', { fetchHtml: async url => {
    requests.push(url);
    return url.includes('/anime/') ? heading : `${heading}<a href="/serie/el-nino/temporada/1/capitulo/3">Capítulo 3</a><a href="/anime/unrelated/temporada/2/capitulo/1">Otra serie</a><a href="https://other.example/serie/el-nino/temporada/4/capitulo/1">Externo</a>`;
  } });
  const info = await api.getContentInfo('el-nino', 'anime');
  assert.equal(requests.length, 2);
  assert.equal(info.seasons.length, 1);
  assert.deepEqual(info.seasons[0].episodes.map(episode => episode.number), [3]);
  assert.equal(info.url, 'https://www.pelisplushd.la/serie/el-nino');
});

test('PelisPlus preserves actual upstream404 responses after checking both episode routes', async () => {
  const api = service('pelisplus', { fetchHtml: async () => { throw Object.assign(new ApiError(502, 'Upstream error'), { upstreamStatus: 404 }); } });
  await assert.rejects(api.getContentInfo('missing', 'anime'), { statusCode: 404 });
  await assert.rejects(api.getEpisodeServers('missing', 1, 1, 'anime'), { statusCode: 404 });
});

test('PelisPlus parses the rating displayed by the current source layout', async () => {
  const info = await service('pelisplus', { fetchHtml: async () => `${heading}<span class="font-size-18 text-info text-semibold ion-md-star">8.7/10</span>` }).getContentInfo('el-nino');
  assert.equal(info.rating, '8.7/10');
});

test('PelisPlus never invents DUB/SUB labels when source language is missing or ambiguous', async () => {
  const html = `${heading}<div class="divseason">Temporada 1</div><div class="divseason">Latino</div><div class="divseason">Subtitulado</div><ul class="TbVideoNv"><li data-id="1">Voe</li></ul><div id="link_url"><span lid="1" url="https://voe.sx/e/one"></span><span lid="2" data-language="Subtitulado" url="https://voe.sx/e/two"></span></div><li class="playurl" data-url="https://streamwish.to/e/three"><a>Streamwish</a></li>`;
  const info = await service('pelisplus', { fetchHtml: async () => html }).getContentInfo('el-nino');
  assert.deepEqual(info.servers.map(server => server.language), ['Desconocido', 'Subtitulado', 'Desconocido']);
  assert.equal(info.servers[1].server, 'voesx');
});

test('PelisPlus accepts absolute genre links and strips query/trailing slash from slugs', async () => {
  const html = '<a href="https://www.pelisplushd.la/generos/ciencia-ficci%C3%B3n/?page=1">Ciencia ficción</a><a href="https://other.example/generos/ad">Ad</a>';
  const genres = await service('pelisplus', { fetchHtml: async () => html }).getGenres();
  assert.deepEqual(genres, [{ name: 'Ciencia ficción', slug: 'ciencia-ficción' }]);
});

test('RePelisHD distinguishes a failed source from a valid empty search', async () => {
  const failing = service('repelishd', { axios: { post: async () => { throw new Error('ENOTFOUND'); } } });
  await assert.rejects(failing.searchContent('El niño'), { statusCode: 503 });
  const empty = service('repelishd', { axios: { post: async () => ({ data: Buffer.from('<div id="dle-content">Sin resultados</div>'), headers: {} }) } });
  assert.deepEqual(await empty.searchContent('El niño'), []);
  const parked = service('repelishd', { axios: { post: async () => ({ data: Buffer.from('<h1>Domain for sale</h1>'), headers: {} }) } });
  await assert.rejects(parked.searchContent('El niño'), { statusCode: 503 });
});

test('RePelisHD chooses lazy poster and finds the resolver after an unrelated iframe', async () => {
  const requests = [];
  const api = service('repelishd', { fetchHtml: async url => {
    requests.push(url);
    return url.includes('verhdlink.cam') ? '<ul class="latino"><li data-link="//voe.sx/e/token?token=%2F%2B">VOE</li></ul>' : '<h1>El niño</h1><div class="poster"><img src="/placeholder.gif" data-src="/real.jpg"></div><iframe src="https://trailers.example/watch"></iframe><iframe data-src="https://verhdlink.cam/player/123"></iframe>';
  } });
  const result = await api.getContentInfo('ver-pelicula/el-nino.html/');
  assert.equal(result.poster, 'https://repelishd.ceo/real.jpg');
  assert.equal(requests.length, 2);
  assert.equal(result.servers[0].server, 'voesx');
  assert.equal(result.servers[0].embedUrl, 'https://voe.sx/e/token?token=%2F%2B');
});

test('RePelisHD preserves a resolver outage as an error instead of playable zero mirrors', async () => {
  const api = service('repelishd', { fetchHtml: async url => {
    if (url.includes('verhdlink.cam')) throw new ApiError(504, 'Deadline');
    return '<h1>El niño</h1><iframe src="https://verhdlink.cam/player/123"></iframe>';
  } });
  await assert.rejects(api.getContentInfo('el-nino'), { statusCode: 504 });
});

const cuevanaSearch = '<div class="MovieList"><li><article class="TPost"><a href="/2225/el-ni%C3%B1o"><img data-src="//images.example/real.jpg" src="/loading.gif"><h2 class="Title">VER El niÃ±o Online Gratis HD</h2><span class="Year">2024</span></a></article></li><li class="TPost"><a href="https://other.example/2225/wrong"><h2 class="Title">Wrong</h2></a></li></div>';
const cuevanaMovie = `<h1 class="Title">El niÃ±o</h1><div class="Image"><img data-src="/real.jpg" src="/loading.gif"></div><ul class="InfoList"><li>Película</li><li>2024</li><li><a href="/genero/accion/">AcciÃ³n</a></li></ul><div class="Description"><p>Aventura espaÃ±ola.</p></div><ul class="TPlayerNv"><li class="open_submenu">Español Latino CALIDAD HD<ul><li data-TPlayerNv="dub">1 - Streamwish</li><li data-target="#missing">2 - No disponible</li></ul></li><li class="open_submenu">Subtitulado<ul><li><a href="#sub">1 - VOE</a></li></ul></li></ul><div class="TPlayerTb" id="sub"><iframe data-src="https://voe.sx/e/sub?token=%2F%2B&amp;a=1"></iframe></div><div class="TPlayerTb" id="dub"><iframe data-src="https://streamwish.to/e/dub?token=%2F%2B"></iframe></div>`;

test('Cuevana static searches work without Chromium and reject cross-source links', async () => {
  const requests = [];
  const api = service('cuevana', { fetchHtml: async url => { requests.push(url); return cuevanaSearch; } });
  const result = await api.searchContent('El niño & él');
  assert.equal(requests[0], 'https://ww9.cuevana3.to/?s=El%20ni%C3%B1o%20%26%20%C3%A9l');
  assert.equal(result.length, 1);
  assert.equal(result[0].slug, '2225/el-niño');
  assert.equal(result[0].title, 'El niño');
  assert.equal(result[0].poster, 'https://images.example/real.jpg');
});

test('Cuevana maps server tabs by identity instead of DOM order and preserves tokens/languages', async () => {
  const result = await service('cuevana', { fetchHtml: async () => cuevanaMovie }).getContentInfo('2225/el-ni%C3%B1o');
  assert.equal(result.title, 'El niño');
  assert.equal(result.year, '2024');
  assert.equal(result.poster, 'https://ww9.cuevana3.to/real.jpg');
  assert.deepEqual(result.servers.map(server => [server.server, server.language]), [['streamwish', 'Español Latino'], ['voesx', 'Subtitulado']]);
  assert.equal(result.servers[0].embedUrl, 'https://streamwish.to/e/dub?token=%2F%2B');
  assert.equal(result.servers[1].embedUrl, 'https://voe.sx/e/sub?token=%2F%2B&a=1');
});

test('Cuevana keeps own season zero and numeric episode order, excluding recommendations', async () => {
  const html = '<h1 class="Title">El niño</h1><a href="/episodio/el-ni%C3%B1o-2x10">Diez</a><a href="/episodio/el-ni%C3%B1o-0x1">Especial</a><a href="/episodio/el-ni%C3%B1o-2x2">Dos</a><a href="/episodio/otra-serie-9x1">Otra serie</a><a href="https://other.example/episodio/el-ni%C3%B1o-9x1">Externo</a>';
  const result = await service('cuevana', { fetchHtml: async () => html }).getContentInfo('anime/el-ni%C3%B1o', 'anime');
  assert.deepEqual(result.seasons.map(season => season.number), [0, 2]);
  assert.deepEqual(result.seasons[1].episodes.map(episode => episode.number), [2, 10]);
});

test('Cuevana parses an unlabeled static episode player without inventing its language', async () => {
  const requests = [];
  const api = service('cuevana', { fetchHtml: async url => { requests.push(url); return '<div class="TPlayerTb"><iframe title="Filelions" data-src="https://filelions.to/v/abc"></iframe></div>'; } });
  const result = await api.getEpisodeServers('anime/el-ni%C3%B1o', 0, 3);
  assert.equal(requests[0], 'https://ww9.cuevana3.to/episodio/el-ni%C3%B1o-0x3');
  assert.equal(result.servers[0].language, 'Desconocido');
  assert.equal(result.servers[0].server, 'filelions');
});

test('Cuevana uses one browser fallback for challenges, but never for DNS/timeout/404', async () => {
  let browsers = 0;
  const challenge = Object.assign(new ApiError(502, 'Upstream error'), { upstreamStatus: 403 });
  const fallback = service('cuevana', { fetchHtml: async () => { throw challenge; }, scrapeWithPage: async () => { browsers++; return cuevanaSearch; } });
  assert.equal((await fallback.searchContent('El niño')).length, 1);
  assert.equal(browsers, 1);
  for (const status of [502, 504, 404]) {
    const error = status === 404 ? Object.assign(new ApiError(502, 'Missing'), { upstreamStatus: 404 }) : new ApiError(status, 'Network unavailable');
    const api = service('cuevana', { fetchHtml: async () => { throw error; }, scrapeWithPage: async () => { browsers++; return cuevanaSearch; } });
    await assert.rejects(api.getContentInfo('2225/el-niño'), { statusCode: status });
  }
  assert.equal(browsers, 1);
});

test('Cuevana reports invalid/challenge pages as failures and real empty searches as empty', async () => {
  const invalid = service('cuevana', { fetchHtml: async () => '<h1>Just a moment</h1>', scrapeWithPage: async () => '<h1>Just a moment</h1>' });
  await assert.rejects(invalid.searchContent('El niño'), { statusCode: 503 });
  const empty = service('cuevana', { fetchHtml: async () => '<main><div class="MovieList"></div><p>No se encontraron resultados</p></main>' });
  assert.deepEqual(await empty.searchContent('No existe'), []);
});
