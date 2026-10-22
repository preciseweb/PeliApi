const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function fixture(answers, { service = {}, provider = {} } = {}) {
  const filename = require.resolve('../descargador');
  const fromCli = createRequire(filename);
  const events = new Map();
  const polls = [];
  const lines = [];
  const state = { cleanups: 0, downloadCleanups: 0, exit: null, downloads: 0 };
  class Bar { start() {} update() {} stop() {} create() { return new Bar(); } }
  const mocks = {
    prompts: async () => answers.shift() || {},
    'cli-progress': { SingleBar: Bar, MultiBar: Bar, Presets: { shades_classic: {} } },
    './src/services/pelisplus.service': provider, './src/services/repelishd.service': {}, './src/services/cuevana.service': {},
    './src/utils/browser': { cleanup: async () => { state.cleanups++; } },
    './src/services/download.service': {
      createDownload() { state.downloads++; return { id: 'mock-id', downloadId: 'mock-id' }; },
      getDownload() { return { status: 'completed', progress: 100, fileName: 'movie.mp4' }; },
      getDownloadsDir() { return '/virtual/downloads'; },
      async cleanup() { state.downloadCleanups++; },
      ...service,
    },
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: name => mocks[name] || fromCli(name),
    process: { once: (name, callback) => events.set(name, callback), exit: code => { state.exit = code; } },
    console: { log: line => lines.push(line), error: line => lines.push(line) },
    setInterval: callback => { polls.push(callback); return polls.length; }, clearInterval() {},
  }, { filename });
  return { events, polls, lines, state };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('cancelled CLI closes its reusable browser without starting work', async () => {
  const f = fixture([{}]);
  await tick();
  assert.equal(f.state.cleanups, 1);
  assert.equal(f.state.downloadCleanups, 1);
  assert.equal(f.state.downloads, 0);
});

test('CLI keeps browser alive during work, then closes it and prints a portable filename', async () => {
  const f = fixture([{ mode: 'direct' }, { url: 'https://catalog.example/pelicula/example' }]);
  await tick();
  assert.equal(f.state.cleanups, 0);
  assert.equal(f.state.downloads, 1);
  assert.equal(f.polls.length, 1);
  f.polls[0]();
  await tick();
  assert.equal(f.state.cleanups, 1);
  assert.equal(f.state.downloadCleanups, 1);
  assert.ok(f.lines.some(line => line.includes('/virtual/downloads/movie.mp4')));
});

test('CLI owns interruption handlers and cleans up before terminating', async () => {
  const f = fixture([{ mode: 'direct' }, { url: 'https://catalog.example/pelicula/example' }]);
  await tick();
  f.events.get('SIGINT')();
  await tick();
  assert.equal(f.state.cleanups, 1);
  assert.equal(f.state.downloadCleanups, 1);
  assert.equal(f.state.exit, 130);
});


test('CLI feeds every selected episode as bounded queue slots become available', async () => {
  const item = { slug: 'series', title: 'Series', type: 'series', url: 'https://catalog.example/serie/series', provider: 'pelisplus' };
  const season = { number: 1, episodes: [1, 2, 3].map(number => ({ number, url: `https://catalog.example/serie/series/temporada/1/capitulo/${number}` })) };
  const accepted = [];
  let active = null;
  const f = fixture([
    { mode: 'search' }, { prov: 'pelisplus' }, { query: 'series' }, { selectedItem: item },
    { selectedSeason: season }, { targetEpisodes: 'todos' }, { variant: 'Latino' },
  ], {
    provider: { searchContent: async () => [item], getContentInfo: async () => ({ seasons: [season] }) },
    service: {
      createDownload(payload) {
        if (active) { const error = new Error('Queue full'); error.statusCode = 429; throw error; }
        accepted.push(payload.url);
        active = 'id-' + accepted.length;
        return { id: active, downloadId: active };
      },
      getDownload() { active = null; return { status: 'completed', progress: 100 }; },
    },
  });
  await tick();
  assert.equal(accepted.length, 1);
  assert.equal(f.state.cleanups, 0);
  f.polls[0]();
  assert.equal(accepted.length, 2);
  f.polls[0]();
  assert.equal(accepted.length, 3);
  f.polls[0]();
  await tick();
  assert.equal(f.state.cleanups, 1);
  assert.equal(f.state.downloadCleanups, 1);
  assert.ok(f.lines.some(line => line.includes('3 completadas, 0 fallidas')));
});
