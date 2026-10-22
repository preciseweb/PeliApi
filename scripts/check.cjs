const { readdirSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { execFileSync } = require('node:child_process');

const root = resolve(__dirname, '..');
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'libs' ? [] : files(path);
    return /\.(?:js|cjs)$/.test(entry.name) ? [path] : [];
  });
}
const sources = ['src', 'public', 'scripts', 'tests'].flatMap(directory => files(join(root, directory)));
sources.push(join(root, 'descargador.js'), join(root, '.puppeteerrc.cjs'));
for (const file of sources) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
console.log(`Sintaxis correcta: ${sources.length} archivos.`);
