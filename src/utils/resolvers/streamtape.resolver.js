const { axiosGet, UA_FIREFOX, cheerio } = require('../resolver-helpers');

// Streamtape builds links with string concatenations and substring/slice calls.
// Parse only that bounded grammar; never execute JavaScript supplied by a host.
function parseLinkExpression(expression) {
  if (typeof expression !== 'string' || expression.length > 8192) return null;
  let index = 0;
  function space() { while (/\s/.test(expression[index] || '') && index < expression.length) index++; }
  function expect(token) {
    space();
    if (!expression.startsWith(token, index)) throw new Error('Unsupported link expression');
    index += token.length;
  }
  function integer() {
    space();
    const match = /^[+-]?\d{1,5}/.exec(expression.slice(index));
    if (!match) throw new Error('Invalid substring position');
    index += match[0].length;
    return Number(match[0]);
  }
  function stringLiteral() {
    const quote = expression[index++];
    let value = '';
    while (index < expression.length) {
      let character = expression[index++];
      if (character === quote) return value;
      if (character === '\\') {
        const escape = expression[index++];
        if (escape === 'x' || escape === 'u') {
          const length = escape === 'x' ? 2 : 4;
          const code = expression.slice(index, index + length);
          if (!new RegExp('^[0-9a-f]{' + length + '}$', 'i').test(code)) throw new Error('Invalid escape');
          character = String.fromCharCode(parseInt(code, 16));
          index += length;
        } else {
          const escapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' };
          if (escape === undefined) throw new Error('Incomplete escape');
          character = escapes[escape] ?? escape;
        }
      } else if (character === '\n' || character === '\r') throw new Error('Unterminated string');
      value += character;
    }
    throw new Error('Unterminated string');
  }
  function term(depth) {
    if (depth > 16) throw new Error('Expression nesting limit');
    space();
    let value;
    if (expression[index] === '\'' || expression[index] === '"') value = stringLiteral();
    else { expect('('); value = concatenate(depth + 1); expect(')'); }
    space();
    while (expression[index] === '.') {
      index++;
      const method = /^(substring|slice)\s*\(/.exec(expression.slice(index));
      if (!method) throw new Error('Unsupported string operation');
      index += method[0].length;
      const start = integer();
      space();
      let end;
      if (expression[index] === ',') { index++; end = integer(); }
      expect(')');
      value = value[method[1]](start, end);
      space();
    }
    return value;
  }
  function concatenate(depth = 0) {
    let value = term(depth);
    space();
    while (expression[index] === '+') {
      index++;
      value += term(depth);
      space();
    }
    return value;
  }
  try {
    const result = concatenate();
    space();
    if (expression[index] === ';') { index++; space(); }
    return index === expression.length ? result : null;
  } catch { return null; }
}

async function checkSTLink(url) {
  try {
    const res = await axiosGet(url, {
      method: 'HEAD',
      headers: {
        'User-Agent': UA_FIREFOX,
        'Referer': 'https://streamtape.com/'
      },
      timeout: 6000,
      maxRedirects: 0,
      validateStatus: () => true
    });

    const contentType = res.headers['content-type'] || '';
    if (contentType.includes('application/json')) {
      return null;
    }

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers['location'];
      if (location) {
        const target = new URL(location, url);
        return /^https?:$/.test(target.protocol) ? target.href : null;
      }
    }
  } catch (e) {
    console.error('[ST RESOLVER] Error en HEAD validation:', e.message);
    return null;
  }
  return null;
}

async function extractStreamtape(pageUrl) {
  console.log(`[ST RESOLVER] Resolviendo: ${pageUrl}`);
  try {
    let html;
    try {
      const res = await axiosGet(pageUrl, {
        headers: { 'User-Agent': UA_FIREFOX },
        timeout: 8000
      });
      html = res.data;
    } catch (e) {
      console.error('[ST RESOLVER] Error descargando página:', e.message);
      return null;
    }

    const $ = cheerio.load(html);
    const scriptElems = $('script').toArray();

    for (const el of scriptElems) {
      const scriptContent = $(el).html();
      if (!scriptContent) continue;

      const regex = /document\.getElementById\(['"]([^'"]+)['"]\)\.innerHTML\s*=\s*(.+);/g;
      let match;

      while ((match = regex.exec(scriptContent)) !== null) {
        const link = parseLinkExpression(match[2]);

        if (!link) continue;

        let fullLink = link;
        if (fullLink.startsWith('//')) {
          fullLink = 'https:' + fullLink;
        } else if (fullLink.startsWith('/')) {
          fullLink = 'https://streamtape.com' + fullLink;
        }

        // Validar y obtener la redirección real
        const validUrl = await checkSTLink(fullLink);
        if (validUrl) {
          console.log('[ST RESOLVER] URL directa resuelta exitosamente:', validUrl);
          return validUrl;
        }
      }
    }

    console.log('[ST RESOLVER] No se encontró ningún enlace válido');
    return null;
  } catch (e) {
    console.error('[ST RESOLVER] Error general:', e.message);
    return null;
  }
}

module.exports = { extractStreamtape, parseLinkExpression };
