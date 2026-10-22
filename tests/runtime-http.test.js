const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { fetchHtml, fetchHtmlWithHeaders } = require('../src/utils/http');
const { createContentCache } = require('../src/utils/content-cache');

function configure(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
}

async function fixture(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('a continuously streaming HTML response cannot bypass the total request deadline', async t => {
  configure(t, { REQUEST_TIMEOUT_MS: '120' });
  let confirmClosed;
  const closed = new Promise(resolve => { confirmClosed = resolve; });
  const url = await fixture(t, (_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.write('<h1>');
    const interval = setInterval(() => response.write('x'), 15);
    response.on('close', () => { clearInterval(interval); confirmClosed(); });
  });
  const started = Date.now();
  await assert.rejects(fetchHtml(url), { statusCode: 504 });
  assert.ok(Date.now() - started < 1200, 'the stream must not reset the complete deadline');
  let deadline;
  try {
    await Promise.race([closed, new Promise((_resolve, reject) => {
      deadline = setTimeout(() => reject(new Error('upstream connection stayed open')), 1000);
    })]);
  } finally {
    clearTimeout(deadline);
  }
});

test('content deadline aborts the upstream socket instead of leaving background HTML work', async t => {
  configure(t, { REQUEST_TIMEOUT_MS: '3000' });
  let closed = false;
  const url = await fixture(t, request => request.on('close', () => { closed = true; }));
  const cache = createContentCache({ timeoutMs: 100 });
  await assert.rejects(cache.get('slow', 0, () => fetchHtml(url)), { statusCode: 504 });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(closed, true);
});

test('oversized HTML is rejected without leaking the upstream URL in the public error', async t => {
  configure(t, { MAX_HTML_BYTES: '1024' });
  const url = await fixture(t, (_request, response) => response.end('x'.repeat(8192)));
  await assert.rejects(fetchHtml(`${url}/private?token=fixture-secret`), error => {
    assert.equal(error.statusCode, 502);
    assert.ok(!error.message.includes('fixture-secret'));
    assert.ok(!error.message.includes(url));
    return true;
  });
});

test('HTTP errors expose a machine-readable status only to provider adapters', async t => {
  const url = await fixture(t, (_request, response) => { response.statusCode = 503; response.end('challenge'); });
  await assert.rejects(fetchHtmlWithHeaders(url), error => error.statusCode === 502 && error.upstreamStatus === 503);
});

test('invalid request timeout settings keep the working default and redirects are bounded', async t => {
  configure(t, { REQUEST_TIMEOUT_MS: 'invalid', MAX_HTML_BYTES: '-1' });
  let requests = 0;
  const url = await fixture(t, (request, response) => {
    requests++;
    if (request.url === '/loop') { response.writeHead(302, { Location: '/loop' }); response.end(); }
    else response.end('<h1>Acción</h1>');
  });
  assert.equal(await fetchHtml(url), '<h1>Acción</h1>');
  await assert.rejects(fetchHtml(`${url}/loop`), { statusCode: 502 });
  assert.equal(requests, 7);
});
