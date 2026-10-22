const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// Ayuda bilingüe (AGENTS.md §1 y §6): cada página de help/ tiene su traducción en help/en/, las dos se
// enlazan entre sí y citan la misma serie major.x que package.json. Las páginas públicas del sitio tienen
// título y descripción propios, y sitemap.xml es el que genera npm run build:sitemap.

const ROOT = path.resolve(__dirname, '../..');
const HELP_DIR = path.join(ROOT, 'help');
const EN_DIR = path.join(HELP_DIR, 'en');
const MAJOR = require(path.join(ROOT, 'package.json')).version.split('.')[0];
const listPages = dir => fs.readdirSync(dir).filter(name => name.endsWith('.html')).sort();
const read = file => fs.readFileSync(file, 'utf8');
const loadSitemap = () => import(pathToFileURL(path.join(ROOT, 'scripts/build-sitemap.mjs')).href);

test('Ayuda - cada página tiene su traducción al inglés y ninguna sobra', () => {
  assert.deepEqual(listPages(EN_DIR), listPages(HELP_DIR));
});

test('Ayuda - cada página declara su idioma y enlaza con su traducción', () => {
  const offenders = [];
  for (const name of listPages(HELP_DIR)) {
    const es = read(path.join(HELP_DIR, name));
    const en = read(path.join(EN_DIR, name));
    if (!es.includes('<html lang="es">')) offenders.push(`help/${name}: lang="es"`);
    if (!en.includes('<html lang="en">')) offenders.push(`help/en/${name}: lang="en"`);
    if (!es.includes(`href="en/${name}"`)) offenders.push(`help/${name}: enlace a en/${name}`);
    if (!en.includes(`href="../${name}"`)) offenders.push(`help/en/${name}: enlace a ../${name}`);
  }
  assert.deepEqual(offenders, []);
});

test('Ayuda - la serie de versión coincide con package.json', () => {
  const offenders = [];
  for (const file of [...listPages(HELP_DIR).map(name => path.join(HELP_DIR, name)), ...listPages(EN_DIR).map(name => path.join(EN_DIR, name))]) {
    const source = read(file);
    for (const match of source.matchAll(/(?:ZeroChat|Versión|Version)(?: ·)? (\d+)\.x/g)) {
      if (match[1] !== MAJOR) offenders.push(`${path.relative(ROOT, file)}: ${match[0]}`);
    }
  }
  assert.deepEqual(offenders, [], `La ayuda debe citar la serie ${MAJOR}.x:\n${offenders.join('\n')}`);
});

test('Sitio - cada página pública tiene un título y una descripción únicos', async () => {
  const { listPublicPages } = await loadSitemap();
  const offenders = [];
  const seen = { title: new Map(), description: new Map() };
  for (const page of listPublicPages()) {
    const source = read(path.join(ROOT, page));
    const values = {
      title: [...source.matchAll(/<title>([^<]*)<\/title>/g)].map(match => match[1].trim()),
      description: [...source.matchAll(/<meta name="description" content="([^"]*)">/g)].map(match => match[1].trim())
    };
    for (const [kind, found] of Object.entries(values)) {
      if (found.length !== 1 || !found[0]) { offenders.push(`${page}: ${found.length} ${kind}`); continue; }
      if (seen[kind].has(found[0])) offenders.push(`${page}: ${kind} repetido de ${seen[kind].get(found[0])}`);
      else seen[kind].set(found[0], page);
    }
  }
  assert.deepEqual(offenders, []);
});

test('Sitio - sitemap.xml coincide con el generado (npm run build:sitemap)', async () => {
  const { renderSitemap, SITEMAP_PATH } = await loadSitemap();
  assert.equal(read(SITEMAP_PATH), renderSitemap());
});
