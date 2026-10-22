const test = require('node:test');
const assert = require('node:assert/strict');
const { createContentCache, getContentSignal } = require('../src/utils/content-cache');

test('identical concurrent reads share one operation and distinct episode identities do not collide', async () => {
  const cache = createContentCache();
  let calls = 0;
  let release;
  const load = () => { calls++; return new Promise(resolve => { release = resolve; }); };
  const first = cache.get('pelisplus:anime:1:3', 1000, load);
  const second = cache.get('pelisplus:anime:1:3', 1000, load);
  await Promise.resolve();
  assert.equal(calls, 1);
  release({ servers: ['episode 3'] });
  assert.deepEqual(await Promise.all([first, second]), [{ servers: ['episode 3'] }, { servers: ['episode 3'] }]);
  assert.deepEqual(await cache.get('pelisplus:anime:1:4', 1000, async () => ({ servers: ['episode 4'] })), { servers: ['episode 4'] });
  assert.deepEqual(await cache.get('cuevana3:anime:1:3', 1000, async () => ({ servers: ['other provider'] })), { servers: ['other provider'] });
});

test('cache expires short-lived embeds, evicts least recently read entries and never stores failures', async () => {
  let clock = 0;
  const cache = createContentCache({ maxEntries: 2, now: () => clock });
  const calls = [];
  const read = key => cache.get(key, 20, async () => { calls.push(key); return `${key}:${calls.length}`; });
  assert.equal(await read('a'), 'a:1');
  await read('b');
  assert.equal(await read('a'), 'a:1');
  await read('c');
  assert.equal(await read('b'), 'b:4');
  clock = 21;
  assert.equal(await read('b'), 'b:5');
  await assert.rejects(cache.get('failure', 100, async () => { throw new Error('offline'); }), /offline/);
  assert.equal(await cache.get('failure', 100, async () => 'recovered'), 'recovered');
});

test('pending work is bounded while another viewer can still join an identical read', async () => {
  const cache = createContentCache({ maxPending: 1 });
  let release;
  const first = cache.get('a', 0, () => new Promise(resolve => { release = resolve; }));
  const joined = cache.get('a', 0, () => { throw new Error('duplicate'); });
  await assert.rejects(cache.get('b', 0, async () => 'b'), { statusCode: 503 });
  release('a');
  assert.deepEqual(await Promise.all([first, joined]), ['a', 'a']);
  assert.equal(await cache.get('b', 0, async () => 'b'), 'b');
});

test('deadline aborts upstream work, releases pending capacity and allows a fresh retry', async () => {
  const cache = createContentCache({ maxPending: 1, timeoutMs: 15 });
  let aborted = false;
  await assert.rejects(cache.get('slow', 1000, () => new Promise((_resolve, reject) => {
    const signal = getContentSignal();
    signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
  })), { statusCode: 504 });
  assert.equal(aborted, true);
  assert.equal(getContentSignal(), undefined);
  assert.equal(await cache.get('slow', 1000, async () => 'retry'), 'retry');
});

test('each simultaneous provider read has an independent cancellation context', async () => {
  const cache = createContentCache();
  const signals = [];
  await Promise.all(['a', 'b'].map(key => cache.get(key, 0, async () => {
    await Promise.resolve();
    signals.push(getContentSignal());
  })));
  assert.equal(signals.length, 2);
  assert.ok(signals.every(signal => signal instanceof AbortSignal && !signal.aborted));
  assert.notEqual(signals[0], signals[1]);
});
