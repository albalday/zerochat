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

// Declaraciones de funciones, funciones flecha y métodos de clase.
const DEFINITION = /^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(|^\s*(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)|^ {4}(?:async\s+)?([a-zA-Z_$][\w$]*)\s*\([^)]*\)\s*\{\s*$/gm;
// Entrada de una lista de exportación: «nombre,» o «nombre: nombre,».
const isExportEntry = (line, name) => new RegExp(`^\\s*${escapeRegExp(name)}\\s*(?::\\s*${escapeRegExp(name)}\\s*)?,?\\s*$`).test(line);

test('Higiene - no hay funciones sin uso ni exportadas solo para las pruebas', () => {
  const offenders = [];
  for (const [file, source] of SOURCES) {
    const others = [...[...SOURCES].filter(([other]) => other !== file).map(([, text]) => text), ...OTHER_CONSUMERS];
    for (const match of source.matchAll(DEFINITION)) {
      const name = match[1] || match[2] || match[3];
      if (name === 'constructor' || others.some(text => countWord(text, name) > 0)) continue;
      const definitionIndex = match.index + match[0].indexOf(name);
      const uses = [...source.matchAll(new RegExp(`(?<![\\w$.])${escapeRegExp(name)}(?![\\w$])`, 'g'))]
        .filter(use => use.index !== definitionIndex)
        .filter(use => {
          const start = source.lastIndexOf('\n', use.index) + 1;
          const end = source.indexOf('\n', use.index);
          return !isExportEntry(source.slice(start, end === -1 ? undefined : end), name);
        });
      const memberUses = (source.match(new RegExp(`\\.${escapeRegExp(name)}(?![\\w$])`, 'g')) || []).length;
      if (uses.length === 0 && memberUses === 0) offenders.push(`${relative(file)}:${lineOf(source, match.index + 1)} ${name}`);
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

test('Higiene - las pruebas en Node no cargan un DOM simulado: lo que usa el DOM se prueba en navegador', () => {
  const DOM_LIBRARIES = ['happy-dom', 'jsdom', 'linkedom'];
  const { dependencies = {}, devDependencies = {} } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(DOM_LIBRARIES.filter(name => name in dependencies || name in devDependencies), []);

  const nodeTests = ['unit', 'integration', 'architecture', 'infrastructure', 'helpers']
    .flatMap(dir => listSourceFiles(path.join(ROOT, 'tests', dir)));
  const loadsDom = nodeTests.filter(file => DOM_LIBRARIES.some(name => fs.readFileSync(file, 'utf8').includes(`require('${name}')`)));
  assert.deepEqual(loadsDom.map(relative), []);
});

test('Higiene - el código no usa proxies ni lectores públicos de terceros', () => {
  // Política de M21/M23: las peticiones web van directas desde el navegador o por el backend local.
  const PUBLIC_PROXY = /r\.jina\.ai|allorigins|corsproxy|cors-anywhere|thingproxy|api\.codetabs\.com/i;
  const sources = [...listSourceFiles(JS_DIR), ...listSourceFiles(path.join(ROOT, 'py'), '.py')];
  assert.deepEqual(sources.filter(file => PUBLIC_PROXY.test(fs.readFileSync(file, 'utf8'))).map(relative), []);
});
