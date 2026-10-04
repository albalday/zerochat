const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const JS_DIR = path.resolve(__dirname, '../../js');
// Asignación directa de un literal (comillas o plantilla) a una propiedad de texto visible.
const TEXT_ASSIGNMENT = /\.(textContent|innerText|placeholder|title)\s*=\s*(['`])((?:(?!\2).)*)\2/g;
// Términos técnicos que no se traducen: unidades y métodos HTTP.
const UNTRANSLATED_TERMS = /\b(tok|POST|GET)\b/g;

function listSourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'vendor' ? [] : listSourceFiles(fullPath);
    return entry.name.endsWith('.js') && entry.name !== 'i18n.js' ? [fullPath] : [];
  });
}

test('ChatI18n - el texto visible asignado desde JavaScript no usa literales sin traducir', () => {
  const offenders = [];
  for (const file of listSourceFiles(JS_DIR)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(TEXT_ASSIGNMENT)) {
      const text = match[3].replace(/\$\{[^}]*\}/g, '').replace(UNTRANSLATED_TERMS, '');
      if (/\p{L}{2,}/u.test(text)) {
        const line = source.slice(0, match.index).split('\n').length;
        offenders.push(`${path.relative(JS_DIR, file)}:${line} ${match[0]}`);
      }
    }
  }

  assert.deepEqual(offenders, [], `Usa claves de ChatI18n en lugar de literales:\n${offenders.join('\n')}`);
});
