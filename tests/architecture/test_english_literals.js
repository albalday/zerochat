const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { listSourceFiles } = require('../helpers/source-files');

// js/README.md §5: los mensajes que el código inyecta en la conversación se redactan en inglés, y el
// texto de la interfaz sale de ChatI18n. Fuera de js/i18n.js ningún literal de cadena lleva
// caracteres propios del español. El marcado HTML queda fuera: su texto se traduce con data-i18n.

const JS_DIR = path.resolve(__dirname, '../../js');
const SPANISH = /[áéíóúñ¿¡ÁÉÍÓÚÑ]/;
const MARKUP = /<\/?[a-z][^>]*>/i;

// i18n.js es el diccionario: sus textos son los traducidos.
const listAppSources = dir => listSourceFiles(dir).filter(file => path.basename(file) !== 'i18n.js');

// Literales de cadena de un fuente JS: comillas y tramos de texto de plantillas (sin ${…}).
function stringLiterals(src) {
  const out = [];
  let i = 0;
  let prev = '';
  const regexAllowed = () => !prev || /[(,=:[!&|?{};+\-*%<>~^]$/.test(prev) || /\b(?:return|typeof|case|in|of|void|delete|throw|new|else|do)$/.test(prev);
  function skipString(q) {
    const start = i++;
    while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; }
    out.push({ index: start, text: src.slice(start + 1, i) });
    i++;
  }
  function skipRegex() {
    i++;
    let inClass = false;
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) break;
      else if (c === '\n') break;
      i++;
    }
    i++;
    while (/[a-z]/i.test(src[i] || '')) i++;
  }
  function skipTemplate() {
    let start = ++i;
    while (i < src.length && src[i] !== '`') {
      if (src[i] === '\\') { i += 2; continue; }
      if (src[i] === '$' && src[i + 1] === '{') {
        out.push({ index: start - 1, text: src.slice(start, i) });
        i += 2;
        code('}');
        start = i;
        continue;
      }
      i++;
    }
    out.push({ index: start - 1, text: src.slice(start, i) });
    i++;
  }
  function code(close) {
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      const d = src[i + 1];
      if (c === '/' && d === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
      if (c === '/' && d === '*') { const end = src.indexOf('*/', i + 2); i = end < 0 ? src.length : end + 2; continue; }
      if (c === "'" || c === '"') { skipString(c); prev = 'a'; continue; }
      if (c === '`') { skipTemplate(); prev = 'a'; continue; }
      if (c === '/' && regexAllowed()) { skipRegex(); prev = 'a'; continue; }
      if (c === '{') depth++;
      if (c === '}') { if (close && depth === 0) { i++; return; } depth--; }
      if (/\s/.test(c)) { i++; continue; }
      if (/[\w$]/.test(c)) { const m = src.slice(i).match(/^[\w$]+/)[0]; prev = m; i += m.length; continue; }
      prev = c;
      i++;
    }
  }
  code(null);
  return out;
}

test('Textos - fuera de i18n.js ningún literal de cadena está en español', () => {
  const offenders = [];
  for (const file of listAppSources(JS_DIR)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const { index, text } of stringLiterals(source)) {
      if (SPANISH.test(text) && !MARKUP.test(text)) {
        offenders.push(`${path.relative(JS_DIR, file)}:${source.slice(0, index).split('\n').length} ${text.slice(0, 80)}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `Redacta en inglés los mensajes para el modelo y usa ChatI18n para la interfaz:\n${offenders.join('\n')}`);
});
