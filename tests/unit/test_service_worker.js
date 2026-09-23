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
  assert.match(swContent, /\/zerochat\/heartbeat/, 'Debe excluir el endpoint de heartbeat');
  assert.match(swContent, /\/zerochat\/external/, 'Debe excluir el endpoint de servidores externos');
});

test('Service Worker - todos los scripts y hojas de estilo de zerochat.html están en PRECACHE_ASSETS', () => {
  const rootDir = path.resolve(__dirname, '../..');
  const htmlContent = fs.readFileSync(path.join(rootDir, 'zerochat.html'), 'utf8');
  const swContent = fs.readFileSync(path.join(rootDir, 'sw.js'), 'utf8');

  const match = swContent.match(/const\s+PRECACHE_ASSETS\s*=\s*\[([\s\S]*?)\];/);
  assert.ok(match, 'Debe encontrarse el array PRECACHE_ASSETS');

  const precached = new Set(
    match[1]
      .split(',')
      .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean)
  );

  const scriptMatches = [...htmlContent.matchAll(/<script\s+[^>]*src="([^"]+)"/g)].map(m => './' + m[1]);
  for (const script of scriptMatches) {
    assert.ok(precached.has(script), `El script de zerochat.html debe estar en PRECACHE_ASSETS: ${script}`);
  }

  const cssMatches = [...htmlContent.matchAll(/<link\s+[^>]*href="([^"]+\.css)"/g)].map(m => './' + m[1]);
  for (const css of cssMatches) {
    assert.ok(precached.has(css), `La hoja de estilos de zerochat.html debe estar en PRECACHE_ASSETS: ${css}`);
  }
});

test('Service Worker - el handler de fetch intercepta la ruta publicada de GitHub Pages y excluye endpoints de API', () => {
  const vm = require('node:vm');
  const swPath = path.resolve(__dirname, '../../sw.js');
  const swCode = fs.readFileSync(swPath, 'utf8');

  function initWorker(origin) {
    const listeners = {};
    const context = {
      self: {
        location: { origin },
        addEventListener: (type, fn) => { listeners[type] = fn; },
        skipWaiting: () => {},
        clients: { claim: () => {} }
      },
      URL,
      caches: {
        open: () => Promise.resolve({
          match: () => Promise.resolve(null)
        })
      },
      fetch: () => Promise.resolve({ status: 200, type: 'basic', clone: () => ({}) })
    };
    vm.createContext(context);
    vm.runInContext(swCode, context);
    return listeners;
  }

  function simulateFetch(listeners, url, method = 'GET') {
    let responded = false;
    const event = {
      request: { url, method },
      respondWith: (promise) => {
        responded = true;
      }
    };
    listeners.fetch(event);
    return responded;
  }

  // 1. Escenario GitHub Pages: origin = https://albalday.github.io, subdirectorio /zerochat/
  const ghWorker = initWorker('https://albalday.github.io');
  assert.equal(
    simulateFetch(ghWorker, 'https://albalday.github.io/zerochat/zerochat.html'),
    true,
    'Debe interceptar zerochat.html en subdirectorio de producción'
  );
  assert.equal(
    simulateFetch(ghWorker, 'https://albalday.github.io/zerochat/js/app.js'),
    true,
    'Debe interceptar js/app.js en subdirectorio de producción'
  );
  assert.equal(
    simulateFetch(ghWorker, 'https://albalday.github.io/zerochat/css/styles.css'),
    true,
    'Debe interceptar CSS en subdirectorio de producción'
  );
  assert.equal(
    simulateFetch(ghWorker, 'https://albalday.github.io/zerochat/heartbeat'),
    false,
    'Debe excluir heartbeat'
  );
  assert.equal(
    simulateFetch(ghWorker, 'https://albalday.github.io/zerochat/external/servers'),
    false,
    'Debe excluir llamadas a servidores externos'
  );
  assert.equal(
    simulateFetch(ghWorker, 'https://api.openai.com/v1/chat/completions'),
    false,
    'Debe omitir llamadas cross-origin'
  );

  // 2. Escenario Servidor Local: origin = http://127.0.0.1:8000
  const localWorker = initWorker('http://127.0.0.1:8000');
  assert.equal(
    simulateFetch(localWorker, 'http://127.0.0.1:8000/zerochat.html'),
    true,
    'Debe interceptar zerochat.html en el servidor local'
  );
  assert.equal(
    simulateFetch(localWorker, 'http://127.0.0.1:8000/js/app.js'),
    true,
    'Debe interceptar js/app.js en el servidor local'
  );
  assert.equal(
    simulateFetch(localWorker, 'http://127.0.0.1:8000/zerochat/heartbeat'),
    false,
    'Debe excluir /zerochat/heartbeat local'
  );
  assert.equal(
    simulateFetch(localWorker, 'http://127.0.0.1:8000/mcp/external'),
    false,
    'Debe excluir /mcp local'
  );
  assert.equal(
    simulateFetch(localWorker, 'http://127.0.0.1:8000/api/tools'),
    false,
    'Debe excluir /api local'
  );
  assert.equal(
    simulateFetch(localWorker, 'http://127.0.0.1:8000/sse'),
    false,
    'Debe excluir /sse local'
  );
  assert.equal(
    simulateFetch(localWorker, 'http://127.0.0.1:8000/zerochat.html', 'POST'),
    false,
    'Debe ignorar peticiones POST'
  );
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

