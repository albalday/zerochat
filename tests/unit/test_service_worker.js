const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Service Worker - sw.js existe, define CACHE_NAME y lista activos críticos', () => {
  const swPath = path.resolve(__dirname, '../../sw.js');
  assert.ok(fs.existsSync(swPath), 'sw.js debe existir en la raíz del proyecto');

  const swContent = fs.readFileSync(swPath, 'utf8');
  assert.match(swContent, /const\s+CACHE_NAME\s*=\s*'zerochat-v[^']+'/, 'Debe definir CACHE_NAME versionado');
  assert.match(swContent, /PRECACHE_ASSETS\s*=\s*\[/, 'Debe declarar PRECACHE_ASSETS');

  // Extraer lista de assets
  const match = swContent.match(/const\s+PRECACHE_ASSETS\s*=\s*\[([\s\S]*?)\];/);
  assert.ok(match, 'Debe encontrarse el array PRECACHE_ASSETS');

  const assets = match[1]
    .split(',')
    .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(s => s && s !== './');

  const rootDir = path.resolve(__dirname, '../..');
  for (const asset of assets) {
    const rel = asset.replace(/^\.\//, '');
    const fullPath = path.join(rootDir, rel);
    assert.ok(fs.existsSync(fullPath), `El activo precacheado debe existir en disco: ${asset}`);
  }
});

test('Service Worker - gestiona eventos install, activate y fetch con Stale-While-Revalidate', () => {
  const swPath = path.resolve(__dirname, '../../sw.js');
  const swContent = fs.readFileSync(swPath, 'utf8');

  assert.match(swContent, /self\.addEventListener\('install'/, 'Debe registrar listener de install');
  assert.match(swContent, /self\.addEventListener\('activate'/, 'Debe registrar listener de activate');
  assert.match(swContent, /self\.addEventListener\('fetch'/, 'Debe registrar listener de fetch');
  assert.match(swContent, /caches\.delete/, 'activate debe purgar caches obsoletas');
  assert.match(swContent, /skipWaiting\(\)/, 'install debe llamar a skipWaiting');
  assert.match(swContent, /clients\.claim\(\)/, 'activate debe reclamar clientes');

  // Comprobar que no intercepta peticiones que no sean GET
  assert.match(swContent, /req\.method\s*!==\s*'GET'/, 'Debe omitir peticiones no GET');
  // Comprobar que no intercepta peticiones cruzadas
  assert.match(swContent, /url\.origin\s*!==\s*self\.location\.origin/, 'Debe omitir peticiones cross-origin');
  // Comprobar exclusión de endpoints dinámicos
  assert.match(swContent, /\/api/, 'Debe excluir endpoints de API');
  assert.match(swContent, /\/mcp/, 'Debe excluir endpoints de MCP');
});

test('PWA Manifest - manifest.webmanifest es válido y define propiedades obligatorias', () => {
  const manifestPath = path.resolve(__dirname, '../../manifest.webmanifest');
  assert.ok(fs.existsSync(manifestPath), 'manifest.webmanifest debe existir');

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.name, 'ZeroChat');
  assert.equal(manifest.short_name, 'ZeroChat');
  assert.equal(manifest.start_url, './zerochat.html');
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.theme_color, 'Debe declarar theme_color');
  assert.ok(manifest.background_color, 'Debe declarar background_color');
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0, 'Debe definir iconos');
});

