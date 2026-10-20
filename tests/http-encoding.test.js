const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { decodeHtmlBuffer, fetchHtml, fetchHtmlWithHeaders } = require("../src/utils/http");

test("decodes UTF-8 HTML without damaging correct Unicode, URLs or inline scripts", () => {
  const html = '<meta charset="utf-8"><h1>Películas: acción, 日本語 😀</h1><script>const token="dÃ­a%2Fabc";</script>';
  assert.equal(decodeHtmlBuffer(Buffer.from(html), "text/html; charset=UTF-8"), html);
  assert.equal(decodeHtmlBuffer(Buffer.from(html)), html);
  // Already decoded strings must not pass through a second byte conversion.
  assert.equal(decodeHtmlBuffer(html, "text/html;charset=windows-1252"), html);
});

test("honors legacy transport and HTML charsets before metadata extraction", () => {
  const spanish = "<h1>Películas: acción y niños</h1>";
  assert.equal(decodeHtmlBuffer(Buffer.from(spanish, "latin1"), "text/html; charset=iso-8859-1"), spanish);
  const meta = '<META http-equiv="Content-Type" content="text/html; charset=windows-1252">';
  assert.equal(decodeHtmlBuffer(Buffer.concat([Buffer.from(meta), Buffer.from(spanish, "latin1")])), meta + spanish);
  assert.equal(decodeHtmlBuffer(Buffer.from([0x80, 0x20, 0x93, 0x41, 0x94]), "text/html;charset=windows-1252"), "€ “A”");
  assert.equal(decodeHtmlBuffer(Buffer.from([0x93, 0xfa, 0x96, 0x7b]), "text/html;charset=shift_jis"), "日本");
});

test("BOM takes priority and both UTF-16 byte orders are supported", () => {
  const text = "<h1>Acción 日本語</h1>";
  const utf8 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]);
  assert.equal(decodeHtmlBuffer(utf8, "text/html;charset=windows-1252"), text);
  const littleEndian = Buffer.from("\ufeff" + text, "utf16le");
  assert.equal(decodeHtmlBuffer(littleEndian, "text/html;charset=utf-8"), text);
  assert.equal(decodeHtmlBuffer(Buffer.from(littleEndian).swap16()), text);
});

test("ignores unsupported declarations, comments and script literals when finding HTML charset", () => {
  const html = '<!-- <meta charset="windows-1252"> --><script>const example=\'<meta charset="windows-1252">\';</script><meta charset="UTF-8"><h1>Acción</h1>';
  assert.equal(decodeHtmlBuffer(Buffer.from(html), "text/html;charset=unknown-encoding"), html);
  // Incorrect UTF-8 headers on legacy pages must not destroy their accented bytes.
  assert.equal(decodeHtmlBuffer(Buffer.from("acción", "latin1"), "text/html;charset=utf-8"), "acción");
  assert.equal(decodeHtmlBuffer(Buffer.alloc(0)), "");
  assert.equal(decodeHtmlBuffer(null), "");
});

test("an isolated legacy byte does not re-encode correct UTF-8 content in the rest of the document", () => {
  const before = '<h1>Películas 日本語 😀</h1><script>const token="acción%2Fab";</script><p>';
  const after = "</p><h2>Fantasía</h2>";
  const bytes = Buffer.concat([Buffer.from(before), Buffer.from("acción del día", "latin1"), Buffer.from(after)]);
  assert.equal(decodeHtmlBuffer(bytes, "text/html;charset=UTF-8"), before + "acción del día" + after);
});

test("fetchHtml requests bytes and preserves transport decoding and referer contracts", async () => {
  const html = '<meta charset="windows-1252"><h1>Acción del día</h1><script>const token="a%2Fb%3D";</script>';
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.headers);
    response.setHeader("Content-Type", "text/html;charset=windows-1252");
    response.setHeader("X-Source", "fixture");
    response.end(Buffer.from(html, "latin1"));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const url = `http://127.0.0.1:${server.address().port}/fixture`;
    assert.equal(await fetchHtml(url, { "X-Fixture": "first" }), html);
    const result = await fetchHtmlWithHeaders(url, "https://catalog.example/serie", { "X-Fixture": "second" });
    assert.equal(result.html, html);
    assert.equal(result.headers["x-source"], "fixture");
    assert.equal(requests[0]["x-fixture"], "first");
    assert.equal(requests[1].referer, "https://catalog.example/serie");
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
