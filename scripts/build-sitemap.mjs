#!/usr/bin/env node
// Genera sitemap.xml (solo <loc>) a partir de las páginas públicas del sitio de GitHub Pages.
// La lista de páginas es la misma que valida tests/architecture/test_help_pages.js.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE_URL = 'https://albalday.github.io/zerochat/';
export const SITEMAP_PATH = path.join(ROOT_DIR, 'sitemap.xml');

const listHtml = dir => fs.readdirSync(path.join(ROOT_DIR, dir))
  .filter(name => name.endsWith('.html'))
  .sort()
  .map(name => `${dir}/${name}`);

// Rutas relativas a la raíz del repositorio de cada página pública.
export function listPublicPages() {
  return ['index.html', 'zerochat.html', ...listHtml('help'), ...listHtml('help/en')];
}

function pageUrl(page) {
  return SITE_URL + (page === 'index.html' ? '' : page);
}

export function renderSitemap() {
  const urls = listPublicPages().map(page => `  <url><loc>${pageUrl(page)}</loc></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  fs.writeFileSync(SITEMAP_PATH, renderSitemap(), 'utf8');
  console.log(`✔ sitemap.xml generado con ${listPublicPages().length} páginas`);
}
