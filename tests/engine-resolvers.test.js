const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLinkExpression } = require('../src/utils/resolvers/streamtape.resolver');

function loadResolver(overrides = {}) {
  const modulePath = require.resolve('../src/utils/resolvers');
  const dependencies = {
    '../src/utils/browser': { withPage: overrides.withPage || (async () => null) },
    '../src/utils/http': { fetchHtmlWithHeaders: async () => ({ html: '', headers: {} }), findFirstUrl: () => null, isLikelyVideoUrl: () => false, normalizeExtractedUrl: value => value },
    '../src/utils/resolvers/streamwish.resolver': { extractStreamwish: overrides.streamwish || (async () => null) },
    '../src/utils/resolvers/streamtape.resolver': { extractStreamtape: async () => null },
    '../src/utils/resolvers/voe.resolver': { extractVoe: async () => null },
    '../src/utils/resolvers/ytdlp.resolver': { isAvailable: false },
  };
  const saved = new Map();
  saved.set(modulePath, require.cache[modulePath]);
  for (const [name, exports] of Object.entries(dependencies)) {
    const key = require.resolve(name);
    saved.set(key, require.cache[key]);
    require.cache[key] = { id: key, filename: key, loaded: true, exports };
  }
  delete require.cache[modulePath];
  const result = require(modulePath);
  for (const [key, value] of saved) {
    if (value) require.cache[key] = value;
    else delete require.cache[key];
  }
  return result;
}

test('Streamtape string parser preserves concatenations, escapes and actual substring semantics', () => {
  assert.equal(parseLinkExpression("'//streamtape.com/get_video?id=abc&token=' + ('XXraw%2Ftoken').substring(2)"), '//streamtape.com/get_video?id=abc&token=raw%2Ftoken');
  assert.equal(parseLinkExpression("('prefix' + 'value').slice(6) + '\\x26k=\\u00f1'"), 'value&k=ñ');
  assert.equal(parseLinkExpression("'abcdef'.substring(5, 2) + 'abcdef'.slice(-2);"), 'cdeef');
  assert.equal(parseLinkExpression("'quoted\\\'token' + ''"), "quoted'token");
});

test('Streamtape string parser never executes host JavaScript or accepts unbounded expressions', () => {
  global.__peliapiResolverExecuted = false;
  for (const expression of [
    "(global.__peliapiResolverExecuted = true, 'https://video.example/video.mp4')",
    "'safe'.constructor.constructor('global.__peliapiResolverExecuted = true')()",
    "'safe'; global.__peliapiResolverExecuted = true",
    "'safe' + process.env.SECRET",
    '(' .repeat(40) + "'x'" + ')'.repeat(40),
    "'" + 'x'.repeat(9000) + "'",
  ]) assert.equal(parseLinkExpression(expression), null);
  assert.equal(global.__peliapiResolverExecuted, false);
  delete global.__peliapiResolverExecuted;
});

test('already direct video URLs return unchanged without a resolver, request or browser', async () => {
  let launches = 0;
  let extractions = 0;
  const api = loadResolver({ withPage: async () => { launches++; }, streamwish: async () => { extractions++; } });
  for (const url of ['https://cdn.example/movie.mp4?token=%2Fraw%2B&x=Ã±', 'https://cdn.example/MASTER.M3U8?signature=untouched', 'https://cdn.example/video.webm']) assert.equal(await api.resolveEmbedUrl(url), url);
  assert.equal(launches, 0);
  assert.equal(extractions, 0);
  assert.equal(await api.resolveEmbedUrl('javascript:alert(1)'), null);
});

test('protected embed browser fallback runs only once after static extraction fails', async () => {
  let attempts = 0;
  const api = loadResolver({ withPage: async () => { attempts++; return null; } });
  const url = 'https://streamwish.example/e/unavailable?token=%2Fraw';
  assert.equal(await api.resolveEmbedUrl(url), url);
  assert.equal(attempts, 1);
});

test('Puppeteer resolver uses controlled withPage and propagates navigation failure to its cleanup', async () => {
  let callbackRan = false;
  let cleanupRan = false;
  const page = {
    async setUserAgent() {}, async setExtraHTTPHeaders() {}, async setRequestInterception() {}, on() {},
    async goto() { throw new Error('navigation timeout'); },
  };
  const api = loadResolver({ withPage: async callback => {
    try { callbackRan = true; return await callback(page); }
    finally { cleanupRan = true; }
  } });
  assert.equal(await api.resolveEmbedWithPuppeteer('https://embed.example/e/one'), null);
  assert.equal(callbackRan, true);
  assert.equal(cleanupRan, true);
});
