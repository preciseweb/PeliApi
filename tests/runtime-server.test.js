const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { once } = require('node:events');
const { requireApiKey } = require('../src/middlewares/auth');
const { dailyRateLimit } = require('../src/middlewares/rate-limit');

function configure(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const previous = process.env[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
}

function authenticate(header, query = {}) {
  const request = { header: () => header, query };
  let error;
  requireApiKey(request, {}, value => { error = value; });
  return { request, error };
}

function quota(apiKey) {
  const headers = {};
  let error;
  dailyRateLimit({ apiKey }, { setHeader: (name, value) => { headers[name] = value; } }, value => { error = value; });
  return { headers, error };
}

test('auth only bypasses configured keys when DISABLE_AUTH is explicitly true', t => {
  configure(t, { DISABLE_AUTH: 'false', API_KEYS: 'fixture-one,fixture-two' });
  assert.equal(authenticate().error.statusCode, 401);
  assert.equal(authenticate('wrong').error.statusCode, 401);
  assert.equal(authenticate('fixture-one').error, undefined);
  assert.equal(authenticate('', { apiKey: 'fixture-two' }).request.apiKey, 'fixture-two');
  assert.equal(authenticate('', { apiKey: ['fixture-two'] }).error.statusCode, 401);
  process.env.DISABLE_AUTH = ' TRUE ';
  assert.equal(authenticate().request.apiKey, 'local-dev');
});

test('enabled auth fails closed if no keys were configured', t => {
  configure(t, { DISABLE_AUTH: 'false', API_KEYS: '' });
  assert.equal(authenticate('any-key').error.statusCode, 503);
});

test('daily quota returns a retry time and invalid numeric settings keep a finite limit', t => {
  configure(t, { DISABLE_RATE_LIMIT: 'false', DAILY_REQUEST_LIMIT: '1' });
  assert.equal(quota('fixture-once').error, undefined);
  const exceeded = quota('fixture-once');
  assert.equal(exceeded.error.statusCode, 429);
  assert.equal(exceeded.headers['X-RateLimit-Remaining'], '0');
  assert.ok(Number(exceeded.headers['Retry-After']) > 0);
  process.env.DAILY_REQUEST_LIMIT = 'NaN';
  assert.equal(quota('fixture-invalid').headers['X-RateLimit-Limit'], '100');
  process.env.DISABLE_RATE_LIMIT = ' TRUE ';
  assert.equal(quota('fixture-once').error, undefined);
});

test('importing the server never opens a port or probes external programs', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ['-e', "require('./src/server'); process.stdout.write('imported')"], {
    cwd: require('node:path').resolve(__dirname, '..'),
    env: { ...process.env, NODE_ENV: 'test', YTDLP_ENABLED: 'false' },
    timeout: 3000,
  });
  assert.equal(stdout, 'imported');
});

test('health and static API description remain public, content routes enforce auth and disabled limits stay disabled', async t => {
  configure(t, { NODE_ENV: 'test', DISABLE_AUTH: 'false', API_KEYS: 'fixture-server-key', DISABLE_RATE_LIMIT: 'true' });
  const { startServer } = require('../src/server');
  const server = startServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  const body = await health.json();
  assert.equal(body.status, 'ok');
  assert.equal(typeof body.browser.available, 'boolean');
  assert.equal(typeof body.chromeProcesses, 'number');
  for (let index = 0; index < 25; index++) assert.equal((await fetch(`${base}/api`)).status, 200);
  for (const route of ['/api/v1/content/unknown', '/api/pelisplus/unknown']) {
    assert.equal((await fetch(base + route)).status, 401);
    assert.equal((await fetch(base + route, { headers: { 'X-API-Key': 'wrong' } })).status, 401);
    assert.equal((await fetch(base + route, { headers: { 'X-API-Key': 'fixture-server-key' } })).status, 404);
  }
  process.env.DISABLE_AUTH = 'true';
  for (let index = 0; index < 8; index++) {
    assert.equal((await fetch(`${base}/api/v1/content/search?q=`)).status, 400, 'disabled scrape quota must allow more than five reads');
  }
  process.env.DISABLE_RATE_LIMIT = 'false';
  const statuses = [];
  for (let index = 0; index < 21; index++) statuses.push((await fetch(`${base}/api`)).status);
  assert.equal(statuses.at(-1), 429);
});

test('the executable server shuts down cleanly on SIGTERM', async t => {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: require('node:path').resolve(__dirname, '..'),
    env: { ...process.env, PORT: '0', NODE_ENV: 'test', YTDLP_ENABLED: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let output = '';
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('server startup timed out')), 3000);
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes('PeliApi listening')) { clearTimeout(deadline); resolve(); }
    });
    child.once('error', reject);
    child.once('exit', code => { clearTimeout(deadline); reject(new Error(`server exited early: ${code}`)); });
  });
  const stopped = once(child, 'exit');
  child.kill('SIGTERM');
  const [code, signal] = await stopped;
  assert.equal(code, 0);
  assert.equal(signal, null);
});

test('shutdown watchdog survives finished HTTP cleanup when an unrelated handle stays alive', async t => {
  const script = `
    const { startServer, registerShutdown } = require('./src/server');
    const server = startServer({ port: 0, host: '127.0.0.1' });
    registerShutdown(server, { timeoutMs: 80 });
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['-e', script], {
    cwd: require('node:path').resolve(__dirname, '..'),
    env: { ...process.env, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let output = '';
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('server startup timed out')), 3000);
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes('PeliApi listening')) { clearTimeout(deadline); resolve(); }
    });
    child.once('error', reject);
    child.once('exit', code => { clearTimeout(deadline); reject(new Error(`server exited early: ${code}`)); });
  });
  const stopped = once(child, 'exit');
  const started = Date.now();
  child.kill('SIGTERM');
  const [code, signal] = await stopped;
  assert.equal(code, 0);
  assert.equal(signal, null);
  assert.ok(Date.now() - started < 1500, 'background handles must not defeat the shutdown deadline');
});
