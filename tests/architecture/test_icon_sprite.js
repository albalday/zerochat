const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');

function listJsFiles(dirPath) {
  return fs.readdirSync(dirPath, { withFileTypes: true }).flatMap(entry => {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) return listJsFiles(entryPath);
    return entry.name.endsWith('.js') ? [entryPath] : [];
  });
}

function collectSpriteUses() {
  const sources = [path.join(ROOT, 'zerochat.html'), ...listJsFiles(path.join(ROOT, 'js'))];
  const uses = new Map();
  for (const filePath of sources) {
    const content = fs.readFileSync(filePath, 'utf8');
    for (const match of content.matchAll(/href="#(icon-[a-z0-9-]+)"/g)) {
      if (!uses.has(match[1])) uses.set(match[1], path.relative(ROOT, filePath));
    }
  }
  return uses;
}

const html = fs.readFileSync(path.join(ROOT, 'zerochat.html'), 'utf8');
const symbols = new Set([...html.matchAll(/<symbol id="(icon-[a-z0-9-]+)"/g)].map(match => match[1]));
const uses = collectSpriteUses();

test('Sprite de iconos - cada referencia #icon-* existe en el sprite de zerochat.html', () => {
  const missing = [...uses].filter(([id]) => !symbols.has(id)).map(([id, file]) => `${id} (${file})`);
  assert.deepEqual(missing, [], `Referencias a símbolos inexistentes: ${missing.join(', ')}`);
});

test('Sprite de iconos - el sprite no declara símbolos sin uso', () => {
  const unused = [...symbols].filter(id => !uses.has(id));
  assert.deepEqual(unused, [], `Símbolos del sprite sin uso: ${unused.join(', ')}`);
});

const Icons = require(path.join(ROOT, 'js/icons.js'));
const normalizeSvg = markup => markup.replace(/\s+/g, ' ').replace(/> </g, '><').trim();
const consumerSources = [path.join(ROOT, 'zerochat.html'), ...listJsFiles(path.join(ROOT, 'js'))]
  .filter(filePath => filePath !== path.join(ROOT, 'js/icons.js'))
  .map(filePath => ({ file: path.relative(ROOT, filePath), content: fs.readFileSync(filePath, 'utf8') }));

test('ChatIcons - cada glifo del catálogo tiene al menos un consumidor', () => {
  const unused = Icons.list().filter(name => !consumerSources.some(({ content }) =>
    content.includes(`'${name}'`) || content.includes(`"icon-${name}"`) || content.includes(`#icon-${name}"`)));
  assert.deepEqual(unused, [], `Glifos de ChatIcons sin uso: ${unused.join(', ')}`);
});

test('ChatIcons - no se duplican glifos del catálogo como SVG en línea', () => {
  const glyphs = new Map(Object.entries(Icons.GLYPHS).map(([name, glyph]) => [normalizeSvg(glyph), name]));
  const duplicates = consumerSources
    .filter(({ file }) => file.startsWith('js/'))
    .flatMap(({ file, content }) => [...content.matchAll(/<svg[^>]*>([\s\S]*?)<\/svg>/g)]
      .filter(match => glyphs.has(normalizeSvg(match[1])))
      .map(match => `${file}: ${glyphs.get(normalizeSvg(match[1]))}`));
  assert.deepEqual(duplicates, [], `Usa ChatIcons.get en lugar de SVG en línea: ${duplicates.join(', ')}`);
});
