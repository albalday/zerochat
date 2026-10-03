const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Service Worker - PRECACHE_ASSETS existe en disco e incluye todos los scripts y estilos de zerochat.html', () => {
  const rootDir = path.resolve(__dirname, '../..');
  const swContent = fs.readFileSync(path.join(rootDir, 'sw.js'), 'utf8');
  const htmlContent = fs.readFileSync(path.join(rootDir, 'zerochat.html'), 'utf8');
  assert.match(swContent, /const\s+CACHE_NAME\s*=\s*'zerochat-v[^']+'/, 'Debe definir CACHE_NAME versionado');
  assert.match(swContent, /caches\.delete/, 'activate debe purgar caches obsoletas');

  const match = swContent.match(/const\s+PRECACHE_ASSETS\s*=\s*\[([\s\S]*?)\];/);
  assert.ok(match, 'Debe encontrarse el array PRECACHE_ASSETS');
  const precached = new Set(match[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean));
  for (const asset of precached) {
    if (asset === './') continue;
    assert.ok(fs.existsSync(path.join(rootDir, asset.replace(/^\.\//, ''))), `El activo precacheado debe existir en disco: ${asset}`);
  }
  const referenced = [
    ...[...htmlContent.matchAll(/<script\s+[^>]*src="([^"]+)"/g)].map(m => './' + m[1]),
    ...[...htmlContent.matchAll(/<link\s+[^>]*href="([^"]+\.css)"/g)].map(m => './' + m[1])
  ];
  for (const asset of referenced) {
    assert.ok(precached.has(asset), `El recurso de zerochat.html debe estar en PRECACHE_ASSETS: ${asset}`);
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
    simulateFetch(ghWorker, 'https://albalday.github.io/zerochat/css/base.css'),
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


test('Service Worker - install falla si algún recurso del precache no se descarga', async () => {
  const vm = require('node:vm');
  const swCode = fs.readFileSync(path.resolve(__dirname, '../../sw.js'), 'utf8');

  async function runInstall(addAll) {
    const listeners = {};
    let skipped = false;
    const context = {
      self: {
        location: { origin: 'https://albalday.github.io' },
        addEventListener: (type, fn) => { listeners[type] = fn; },
        skipWaiting: () => { skipped = true; },
        clients: { claim: () => {} }
      },
      URL,
      Request: class { constructor(url, init) { this.url = url; this.cache = init?.cache; } },
      caches: { open: () => Promise.resolve({ addAll }) },
      fetch: () => Promise.reject(new Error('fetch no esperado'))
    };
    vm.createContext(context);
    vm.runInContext(swCode, context);
    let installPromise;
    listeners.install({ waitUntil: (promise) => { installPromise = promise; } });
    await installPromise.catch(() => {});
    return { installPromise, skipped };
  }

  let requested = [];
  const ok = await runInstall(async (requests) => { requested = requests; });
  await ok.installPromise;
  assert.equal(ok.skipped, true);
  assert.ok(requested.length > 1);
  assert.ok(requested.every(req => req.cache === 'no-cache'));
  // La raíz no es la aplicación y el servidor local la protege con token: rompería la instalación.
  assert.ok(!requested.some(req => req.url === './'));

  const failed = await runInstall(async () => { throw new TypeError('Request failed'); });
  await assert.rejects(failed.installPromise, /Request failed/);
  assert.equal(failed.skipped, false);
});
