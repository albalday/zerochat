const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const JS_DIR = path.resolve(__dirname, '../../js');
// Un catch sin cuerpo oculta el error; debe registrarlo, propagarlo o explicar con un comentario por qué lo ignora.
const EMPTY_CATCH = /catch\s*(\([^)]*\))?\s*\{\s*\}/g;

function listSourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'vendor' ? [] : listSourceFiles(fullPath);
    return entry.name.endsWith('.js') ? [fullPath] : [];
  });
}

test('Errores - ningún módulo usa bloques catch vacíos', () => {
  const offenders = [];
  for (const file of listSourceFiles(JS_DIR)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(EMPTY_CATCH)) {
      const line = source.slice(0, match.index).split('\n').length;
      offenders.push(`${path.relative(JS_DIR, file)}:${line}`);
    }
  }

  assert.deepEqual(offenders, [], `Registra, propaga o justifica con un comentario el error en:\n${offenders.join('\n')}`);
});
