const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { listSourceFiles } = require('../helpers/source-files');

const JS_DIR = path.resolve(__dirname, '../../js');
// Asignación directa de un literal (comillas o plantilla) a una propiedad de texto visible.
const TEXT_ASSIGNMENT = /\.(textContent|innerText|placeholder|title)\s*=\s*(['`])((?:(?!\2).)*)\2/g;
// Términos técnicos que no se traducen: unidades y métodos HTTP.
const UNTRANSLATED_TERMS = /\b(tok|POST|GET)\b/g;

// i18n.js es el diccionario: sus textos son los traducidos.
const listAppSources = dir => listSourceFiles(dir).filter(file => path.basename(file) !== 'i18n.js');

test('ChatI18n - el texto visible asignado desde JavaScript no usa literales sin traducir', () => {
  const offenders = [];
  for (const file of listAppSources(JS_DIR)) {
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

// t() devuelve la propia clave si falta la traducción, así que un literal tras «||» nunca se usa.
const UNREACHABLE_FALLBACK = /(?<![\w$])(?:t|tFn|translate|translator)\(\s*'[\w.]+'(?:\s*,(?:[^()]|\([^()]*\))*)?\)\s*\|\|\s*['"`]/g;

test('ChatI18n - no hay textos alternativos tras t(), que nunca se usarían', () => {
  const offenders = [];
  for (const file of listAppSources(JS_DIR)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(UNREACHABLE_FALLBACK)) {
      offenders.push(`${path.relative(JS_DIR, file)}:${source.slice(0, match.index).split('\n').length}`);
    }
  }
  assert.deepEqual(offenders, [], `Quita el texto alternativo; la clave debe existir en ambos idiomas:\n${offenders.join('\n')}`);
});

// Claves que el código compone con un prefijo y un estado, en lugar de citarlas literalmente.
const DYNAMIC_KEY_PREFIXES = ['notice_', 'project_status_', 'project_action_', 'mcp_status_', 'mcp_external_status_', 'profile_browser_'];

test('ChatI18n - toda clave de los diccionarios se usa', () => {
  const { TRANSLATIONS } = require('../../js/i18n.js');
  const i18nSource = fs.readFileSync(path.join(JS_DIR, 'i18n.js'), 'utf8');
  const corpus = [
    ...listAppSources(JS_DIR).map(file => fs.readFileSync(file, 'utf8')),
    fs.readFileSync(path.resolve(JS_DIR, '../zerochat.html'), 'utf8'),
    i18nSource.slice(i18nSource.indexOf('function t('))
  ].join('\n');

  const stalePrefixes = DYNAMIC_KEY_PREFIXES.filter(prefix => !new RegExp(`['"\`]${prefix}(?:\\$\\{|['"\`]\\s*\\+)`).test(corpus));
  assert.deepEqual(stalePrefixes, [], 'Cada prefijo dinámico debe seguir componiéndose en el código');

  const unused = Object.keys(TRANSLATIONS.es)
    .filter(key => !new RegExp(`['"\`]${key}['"\`]`).test(corpus))
    .filter(key => !DYNAMIC_KEY_PREFIXES.some(prefix => key.startsWith(prefix)));
  assert.deepEqual(unused, [], `Claves sin uso en es y en:\n${unused.join('\n')}`);
});
