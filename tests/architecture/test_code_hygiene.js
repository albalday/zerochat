const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { listSourceFiles } = require('../helpers/source-files');

// Higiene del código fuente: dependencias resueltas con la infraestructura común, sin
// funciones ni variables que nadie use. Las pruebas no cuentan como uso.

const ROOT = path.resolve(__dirname, '../..');
const JS_DIR = path.join(ROOT, 'js');

const SOURCES = new Map(listSourceFiles(JS_DIR).map(file => [file, fs.readFileSync(file, 'utf8')]));
const OTHER_CONSUMERS = [path.join(ROOT, 'zerochat.html'), path.join(ROOT, 'sw.js')].map(file => fs.readFileSync(file, 'utf8'));
const relative = file => path.relative(ROOT, file);
const lineOf = (source, index) => source.slice(0, index).split('\n').length;
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const countWord = (text, name) => (text.match(new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`, 'g')) || []).length;

test('Higiene - las dependencias se resuelven con ChatUtils.resolveDep, no con window y require a mano', () => {
  const offenders = [];
  for (const [file, source] of SOURCES) {
    if (file.endsWith(`${path.sep}utils.js`)) continue;
    source.split('\n').forEach((line, index) => {
      if (/window\.(Chat|ZeroChat)\w*|window\[/.test(line) && /require\(/.test(line)) {
        offenders.push(`${relative(file)}:${index + 1}`);
      }
    });
    for (const match of source.matchAll(/\n {2}function (get[A-Z]\w*)\(\) \{\n([\s\S]*?)\n {2}\}\n/g)) {
      if (/window\.(Chat|ZeroChat)/.test(match[2]) && /require\(/.test(match[2])) {
        offenders.push(`${relative(file)}:${lineOf(source, match.index + 1)} ${match[1]}()`);
      }
    }
  }
  assert.deepEqual(offenders, [], `Usa resolveDep(globalName, modulePath):\n${offenders.join('\n')}`);
});

// Declaraciones de funciones, funciones flecha, clases y métodos de clase.
const DEFINITION = /^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(|^\s*(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)|^ {4}(?:async\s+)?([a-zA-Z_$][\w$]*)\s*\([^)]*\)\s*\{\s*$|^\s*class\s+([A-Za-z_$][\w$]*)\b/gm;

/**
 * Indica si la aparición de `name` en `index` es solo su entrada en el objeto que exporta la fábrica
 * UMD (`return { … };` final), como `name` o `name: name`: exportarse no es usarse. Una entrada
 * `clave: name` sí es un uso, porque la aplicación llama a `clave` (p. ej. `execute` de una herramienta).
 */
function isExportEntry(source, index, name) {
  const start = source.lastIndexOf('\n  return {');
  if (start === -1 || index < start || index > source.indexOf('\n  };', start)) return false;
  const lineStart = source.lastIndexOf('\n', index) + 1;
  const lineEnd = source.indexOf('\n', index);
  const entries = source.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).split(',').map(entry => entry.trim()).filter(Boolean);
  return entries.some(entry => entry === name || new RegExp(`^${escapeRegExp(name)}\\s*:\\s*${escapeRegExp(name)}$`).test(entry));
}

// Una función o clase que la aplicación no ejecuta es código muerto aunque una prueba la use: las
// pruebas no cuentan como uso y exportarla no la mantiene viva (tests/README.md, sección 6).
test('Higiene - no hay funciones ni clases que la aplicación no ejecute', () => {
  const offenders = [];
  for (const [file, source] of SOURCES) {
    const others = [...[...SOURCES].filter(([other]) => other !== file).map(([, text]) => text), ...OTHER_CONSUMERS];
    for (const match of source.matchAll(DEFINITION)) {
      const name = match[1] || match[2] || match[3] || match[4];
      if (name === 'constructor' || others.some(text => countWord(text, name) > 0)) continue;
      const definitionIndex = match.index + match[0].indexOf(name);
      const uses = [...source.matchAll(new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`, 'g'))]
        .filter(use => use.index !== definitionIndex && !isExportEntry(source, use.index, name));
      if (uses.length === 0) offenders.push(`${relative(file)}:${lineOf(source, match.index + 1)} ${name}`);
    }
  }
  assert.deepEqual(offenders, [], `Elimina el código muerto o úsalo:\n${offenders.join('\n')}`);
});

test('Higiene - no hay variables declaradas que nadie lea', () => {
  const offenders = [];
  for (const [file, source] of SOURCES) {
    const names = [];
    for (const match of source.matchAll(/^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm)) names.push([match[1], match.index]);
    for (const match of source.matchAll(/^\s*(?:const|let)\s*\{([^}=]*)\}\s*=/gm)) {
      for (const part of match[1].split(',')) {
        const name = part.split(':').pop().split('=')[0].trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) names.push([name, match.index]);
      }
    }
    for (const [name, index] of names) {
      // El prefijo _ marca una variable que se descarta a propósito (p. ej. al quitar una propiedad).
      if (!name.startsWith('_') && countWord(source, name) <= 1) offenders.push(`${relative(file)}:${lineOf(source, index + 1)} ${name}`);
    }
  }
  assert.deepEqual(offenders, [], `Variables sin uso:\n${offenders.join('\n')}`);
});

// Parámetros de la fábrica UMD y constantes obtenidas con resolveDep: módulos que zerochat.html carga
// siempre antes, así que ni ellos ni sus miembros exportados necesitan guardas.
function moduleBindings(source) {
  const factory = source.match(/\}\)\([^\n]*?,\s*function\s*\(([^)]*)\)/);
  const params = factory ? factory[1].split(',').map(name => name.trim()).filter(Boolean) : [];
  const resolved = [...source.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*resolveDep\(/g)].map(match => match[1]);
  return [...params, ...resolved];
}

test('Higiene - sin guardas sobre módulos que siempre están cargados', () => {
  const offenders = [];
  for (const [file, source] of SOURCES) {
    for (const name of moduleBindings(source)) {
      const id = escapeRegExp(name);
      const guard = new RegExp(`(?<![\\w$.])(?:${id}(?:\\.[\\w$]+)?\\?\\.|typeof\\s+${id}\\b)`, 'g');
      for (const match of source.matchAll(guard)) offenders.push(`${relative(file)}:${lineOf(source, match.index)} ${match[0]}`);
    }
  }
  assert.deepEqual(offenders, [], `Usa el módulo directamente, sin ?. ni typeof:\n${offenders.join('\n')}`);
});
