const { TextDecoder } = require("node:util");

// Windows-1252 characters for bytes 0x80–0x9f. Undefined entries retain their C1 code point.
const WINDOWS_1252 = "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ";
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const ENTITIES = {
  amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: "\u00a0",
  aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú",
  Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú",
  ntilde: "ñ", Ntilde: "Ñ", uuml: "ü", Uuml: "Ü", iquest: "¿", iexcl: "¡",
  agrave: "à", egrave: "è", igrave: "ì", ograve: "ò", ugrave: "ù",
  acirc: "â", ecirc: "ê", icirc: "î", ocirc: "ô", ucirc: "û",
  atilde: "ã", Atilde: "Ã", otilde: "õ", Otilde: "Õ", ccedil: "ç", Ccedil: "Ç",
  auml: "ä", Auml: "Ä", ouml: "ö", Ouml: "Ö", euml: "ë", Euml: "Ë",
  iuml: "ï", Iuml: "Ï", yuml: "ÿ", Yuml: "Ÿ", szlig: "ß",
  laquo: "«", raquo: "»", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  ndash: "–", mdash: "—", hellip: "…", euro: "€", pound: "£", yen: "¥",
  copy: "©", reg: "®", trade: "™", bull: "•", middot: "·",
};

function legacyByte(character) {
  const code = character.codePointAt(0);
  if (code <= 255) return code;
  const index = WINDOWS_1252.indexOf(character);
  return index === -1 ? -1 : index + 128;
}

function decodeEntities(text) {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z][a-z\d]+);/gi, (entity, name) => {
    if (name[0] !== "#") return ENTITIES[name] ?? entity;
    const code = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    if (!code || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return entity;
    return code >= 128 && code <= 159 ? WINDOWS_1252[code - 128] : String.fromCodePoint(code);
  });
}

function repairFragment(text) {
  // Work on valid UTF-8 byte sequences, not entire words. Correct Unicode around
  // damaged text must survive, including accents, Japanese titles and emoji.
  for (let pass = 0; pass < 4; pass++) {
    const source = decodeEntities(text);
    const characters = Array.from(source);
    let result = "";
    for (let index = 0; index < characters.length; index++) {
      const first = legacyByte(characters[index]);
      const length = first >= 0xc2 && first <= 0xdf ? 2
        : first >= 0xe0 && first <= 0xef ? 3 : first >= 0xf0 && first <= 0xf4 ? 4 : 0;
      const bytes = length ? [first] : [];
      for (let offset = 1; offset < length && index + offset < characters.length; offset++) {
        const byte = legacyByte(characters[index + offset]);
        if (byte < 0x80 || byte > 0xbf) break;
        bytes.push(byte);
      }
      if (length && bytes.length === length) {
        try {
          const repaired = UTF8.decode(new Uint8Array(bytes));
          result += repaired;
          index += length - 1;
          continue;
        } catch (_error) {
          // Invalid, overlong and surrogate sequences are not evidence of mojibake.
        }
      }
      result += characters[index];
    }
    if (result === text) return text;
    text = result;
  }
  return text;
}

/** Repair human-readable metadata only. Do not apply this to HTML documents,
 * JavaScript, signed media URLs or opaque API payloads. URLs and common token
 * assignments embedded in metadata are retained byte-for-byte. */
function repairText(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  const protectedText = /<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>|<[^>]*>|(?:[a-z][a-z\d+.-]*:\/\/|\/\/|(?:mailto|magnet|data):)[^\s<>"']+|\b(?:token|signature|sig|api[_-]?key|auth|jwt|policy)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s<>]+)/gi;
  let result = "";
  let end = 0;
  for (const match of text.matchAll(protectedText)) {
    result += repairFragment(text.slice(end, match.index)) + match[0];
    end = match.index + match[0].length;
  }
  return result + repairFragment(text.slice(end));
}

module.exports = { repairText };
