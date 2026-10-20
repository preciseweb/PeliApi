const test = require("node:test");
const assert = require("node:assert/strict");
const { repairText } = require("../src/utils/text");

test("repairs Spanish mojibake in metadata and repeated encoding layers", () => {
  assert.equal(repairText("dÃ­a, acciÃ³n, pelÃ­cula, niÃ±os y EspaÃ±a"), "día, acción, película, niños y España");
  assert.equal(repairText("El dÃƒÂ­a de la acciÃƒÂ³n"), "El día de la acción");
  assert.equal(repairText("Â¡QuÃ© pelÃ­cula! Â¿CÃ³mo estÃ¡s?"), "¡Qué película! ¿Cómo estás?");
  assert.equal(repairText("comillas â€œdoblesâ€\u009d y guiÃ³n â€”"), "comillas “dobles” y guión —");
});

test("repairs damaged fragments without re-encoding correct Unicode around them", () => {
  const original = "日本語 y español: acción, dÃ­a y niÃ±os 😀; Ângela y Ångström";
  assert.equal(repairText(original), "日本語 y español: acción, día y niños 😀; Ângela y Ångström");
  assert.equal(repairText("日本語, æ—¥æœ¬èªž y ðŸ˜€"), "日本語, 日本語 y 😀");
  const correct = "Películas, acción y fantasía: El niño, pingüino, ÁÉÍÓÚ, ¡sí!, ¿qué?, 日本語, 中文, 한글, 😀, € 10 — …";
  assert.equal(repairText(correct), correct);
});

test("decodes text entities before repairing metadata, including nested escaped entities", () => {
  assert.equal(repairText("Acci&#xC3;&#xB3;n &amp; fantas&iacute;a &ndash; ni&ntilde;os"), "Acción & fantasía – niños");
  assert.equal(repairText("&amp;#xC3;&amp;#xB1; &Aacute; &iquest; &unknown; &#x110000;"), "ñ Á ¿ &unknown; &#x110000;");
  assert.equal(repairText("&#128; 10 &#x1F600;"), "€ 10 😀");
});

test("does not rewrite signed URLs, opaque tokens, HTML attributes or scripts", () => {
  const url = "https://video.example/e/acciÃ³n?token=dÃ­a&amp;signature=abc%2F%3D+def";
  assert.equal(repairText(url), url);
  assert.equal(repairText(`La acciÃ³n está en ${url} y termina otro dÃ­a.`), `La acción está en ${url} y termina otro día.`);
  const payload = '<script>const name="dÃ­a"; const url="https://example/e?sig=abc&amp;x=1";</script>';
  assert.equal(repairText(payload), payload);
  assert.equal(repairText('<a title="dÃ­a" href="/acciÃ³n">acciÃ³n</a>'), '<a title="dÃ­a" href="/acciÃ³n">acción</a>');
  assert.equal(repairText("dÃ­a token=dÃ­a signature='acciÃ³n' fin niÃ±os"), "día token=dÃ­a signature='acciÃ³n' fin niños");
});

test("keeps invalid byte sequences untouched and is stable across repeated normalization", () => {
  for (const value of ["día", "acciÃ³n", "El dÃƒÂ­a", "Ã", "Â", "â€", "à¥", "\ufffd", "&unknown;"]) {
    const repaired = repairText(value);
    assert.equal(repairText(repaired), repaired);
  }
  assert.equal(repairText("Ã Â â€ à¥ \ufffd"), "Ã Â â€ à¥ \ufffd");
  assert.equal(repairText(null), "");
  assert.equal(repairText(undefined), "");
});
