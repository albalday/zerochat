const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Higiene de estilos: tokens definidos y usados, sin respaldos que nunca se aplican, y elementos
// ocultos con el atributo hidden en lugar de estilos en línea.

const ROOT = path.resolve(__dirname, '../..');

function listFiles(dir, extension) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'vendor' ? [] : listFiles(fullPath, extension);
    return entry.name.endsWith(extension) ? [fullPath] : [];
  });
}

const read = file => fs.readFileSync(file, 'utf8');
const relative = file => path.relative(ROOT, file);
const CSS = new Map(listFiles(path.join(ROOT, 'css'), '.css').map(file => [file, read(file)]));
const JS = new Map(listFiles(path.join(ROOT, 'js'), '.js').map(file => [file, read(file)]));
const HTML = read(path.join(ROOT, 'zerochat.html'));
const allCss = [...CSS.values()].join('\n');
const allJs = [...JS.values()].join('\n');

const tokenDefinitions = new Set([...read(path.join(ROOT, 'css/tokens.css')).matchAll(/(--[\w-]+)\s*:/g)].map(match => match[1]));
const cssDefinitions = new Set([...allCss.matchAll(/(--[\w-]+)\s*:/g)].map(match => match[1]));
// Propiedades que fija JavaScript con style.setProperty().
const jsDefinitions = new Set([...allJs.matchAll(/setProperty\(\s*'(--[\w-]+)'/g)].map(match => match[1]));
const uses = [...(allCss + allJs + HTML).matchAll(/var\((--[\w-]+)/g)].map(match => match[1]);

test('Estilos - toda variable CSS usada está definida y todo token definido se usa', () => {
  const undefinedVars = [...new Set(uses)].filter(name => !cssDefinitions.has(name) && !jsDefinitions.has(name));
  assert.deepEqual(undefinedVars, [], `Variables sin definir: ${undefinedVars.join(', ')}`);
  const used = new Set(uses);
  const unusedTokens = [...cssDefinitions].filter(name => !used.has(name));
  assert.deepEqual(unusedTokens, [], `Tokens sin uso: ${unusedTokens.join(', ')}`);
});

test('Estilos - los tokens siempre definidos no llevan valor de respaldo en var()', () => {
  const offenders = [];
  for (const [file, source] of CSS) {
    for (const match of source.matchAll(/var\((--[\w-]+)\s*,/g)) {
      if (tokenDefinitions.has(match[1])) offenders.push(`${relative(file)}: ${match[1]}`);
    }
  }
  assert.deepEqual(offenders, []);
});

// La hoja de impresión fija colores de papel que no dependen del tema activo.
test('Estilos - los colores solo se definen en tokens.css', () => {
  const offenders = [];
  for (const [file, source] of CSS) {
    if (/tokens\.css$|print\.css$/.test(file)) continue;
    const lines = source.replace(/url\([^)]*\)/g, 'url()').split('\n');
    lines.forEach((line, index) => {
      if (/#[0-9a-fA-F]{3,8}\b|rgba?\(\s*\d|hsla?\(\s*\d|:\s*(white|black)\s*[;!]/.test(line)) offenders.push(`${relative(file)}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, []);
});

test('Estilos - los elementos se ocultan con hidden, no con style.display ni estilos en línea', () => {
  const offenders = [];
  for (const [file, source] of JS) {
    if (/\.style\.display\b/.test(source)) offenders.push(`${relative(file)}: style.display`);
    // Solo se admite el color de cada serie de un gráfico, que depende de los datos.
    for (const match of source.matchAll(/style="([^"$]*)/g)) {
      if (!match[1].startsWith('background-color:')) offenders.push(`${relative(file)}: style="${match[1]}"`);
    }
  }
  if (/\sstyle="/.test(HTML)) offenders.push('zerochat.html: style="…"');
  for (const [file, source] of CSS) {
    if (/\[style[*^$~|]?=/.test(source)) offenders.push(`${relative(file)}: selector [style]`);
  }
  assert.deepEqual(offenders, []);
});

// Clases que el código compone con un prefijo y un estado (`debug-entry-${type}`), en lugar de
// citarlas literalmente.
const DYNAMIC_CLASS_PREFIXES = ['active-', 'align-', 'btn-profile-item-', 'cap-badge-', 'debug-entry-', 'mcp-status-', 'status-'];

test('Estilos - toda clase o id de un selector CSS aparece en el HTML o en JavaScript', () => {
  const consumers = `${HTML}\n${allJs}`;
  for (const prefix of DYNAMIC_CLASS_PREFIXES) assert.ok(consumers.includes(`${prefix}\${`), `Prefijo sin composición: ${prefix}`);
  const offenders = new Set();
  for (const [file, source] of CSS) {
    const clean = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/url\([^)]*\)/g, '').replace(/"[^"]*"|'[^']*'/g, '""');
    for (const [, selector] of clean.matchAll(/([^{}]+)\{/g)) {
      if (/^\s*@/.test(selector)) continue;
      for (const [, , name] of selector.matchAll(/([.#])(-?[_a-zA-Z][\w-]*)/g)) {
        if (DYNAMIC_CLASS_PREFIXES.some(prefix => name.startsWith(prefix))) continue;
        if (!new RegExp(`(?<![\\w-])${name}(?![\\w-])`).test(consumers)) offenders.add(`${relative(file)}: ${name}`);
      }
    }
  }
  assert.deepEqual([...offenders], [], 'Selectores sin consumidores: retira la regla o compón la clase con un prefijo declarado');
});
