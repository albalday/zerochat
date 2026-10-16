const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT_DIR = path.resolve(__dirname, '../..');
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

let browserPromise = null;

const CHROMIUM_LAUNCH_OPTIONS = {
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage']
};

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch(CHROMIUM_LAUNCH_OPTIONS);
  }
  const browser = await browserPromise;
  if (!browser.isConnected()) {
    browserPromise = chromium.launch(CHROMIUM_LAUNCH_OPTIONS);
    return browserPromise;
  }
  return browser;
}

async function closeGlobalBrowser() {
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close().catch(() => {});
    browserPromise = null;
  }
}

// La interfaz arranca en el idioma del navegador: las pruebas fijan español salvo que pidan otro.
async function createTestBrowser() {
  const realBrowser = await getBrowser();
  const contexts = [];
  return {
    async newContext(options) {
      const context = await realBrowser.newContext({ locale: 'es-ES', ...options });
      contexts.push(context);
      return context;
    },
    async newPage(options) {
      const context = await realBrowser.newContext({ locale: 'es-ES', ...options });
      contexts.push(context);
      return context.newPage();
    },
    async close() {
      await Promise.all(contexts.map(ctx => ctx.close().catch(() => {})));
    }
  };
}

async function seedConnectionProfiles(page) {
  await page.addInitScript(() => {
    localStorage.setItem('zerochat_profiles_v1', JSON.stringify({
      schemaVersion: 1,
      profiles: [
        { id: 'profile:local', name: 'Local chat', settings: { apiUrl: 'http://localhost:1234/v1', apiType: 'openai', model: 'google/gemma-4-26b-a4b-qat', enableContextCache: true } },
        { id: 'profile:remote', name: 'Remoto chat', settings: { apiUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiType: 'gemini', model: 'gemini-3.8-flash', enableContextCache: true } }
      ]
    }));
  });
}

function getIndexUrl() {
  return 'file://' + path.resolve(__dirname, '../../zerochat.html');
}

// init() marca zerochat-ready sin esperar a loadSessionsFromStorage(), que después reinicializa la
// conversación y vuelve a pintar los mensajes; el historial inicial (system_root) indica que terminó.
async function waitForAppReady(page) {
  await page.waitForFunction(() => document.documentElement.classList.contains('zerochat-ready') &&
    window.ChatState.get('messages').length > 0);
}

/**
 * Abre una conversación ya guardada en IndexedDB como lo haría el usuario: recarga la página para
 * que la barra lateral liste las sesiones guardadas y pulsa la entrada de la sesión.
 */
async function openSavedSession(page, sessionId) {
  await page.reload({ waitUntil: 'load' });
  await waitForAppReady(page);
  await page.locator(`.sidebar-chat-item[data-session-id="${sessionId}"]`).evaluate(item => item.click());
  await page.waitForFunction(id => window.ChatState.get('sessions').activeId === id, sessionId);
}

// Servidor estático para los casos que necesitan un origen HTTP real (cookies, service worker, CSP de iframes).
async function startStaticServer() {
  const server = http.createServer((req, res) => {
    const parsedUrl = new URL(req.url, 'http://127.0.0.1');
    const relPath = parsedUrl.pathname === '/' ? 'zerochat.html' : parsedUrl.pathname.replace(/^\//, '');
    const target = path.join(ROOT_DIR, relPath);
    if (!target.startsWith(ROOT_DIR + path.sep) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': CONTENT_TYPES[path.extname(target)] || 'application/octet-stream' });
    res.end(fs.readFileSync(target));
  });
  server.keepAliveTimeout = 0;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
}

async function stopStaticServer(server) {
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

/**
 * Ejecuta una prueba sobre una página de la aplicación ya lista, garantizando
 * el cierre y la limpieza del contexto y browser al finalizar.
 */
async function withTestApp(optionsOrFn, maybeFn) {
  const options = typeof optionsOrFn === 'function' ? {} : (optionsOrFn || {});
  const fn = typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn;
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage(options);
    if (options.seedProfiles) {
      await seedConnectionProfiles(page);
    }
    if (options.initScript) {
      await page.addInitScript(options.initScript);
    }
    if (!options.skipGoto) {
      await page.goto(options.url || getIndexUrl(), { waitUntil: 'load' });
      if (!options.skipReady) {
        await waitForAppReady(page);
      }
    }
    return await fn(page, browser);
  } finally {
    await browser.close();
  }
}

module.exports = {
  getBrowser,
  closeGlobalBrowser,
  createTestBrowser,
  withTestApp,
  seedConnectionProfiles,
  getIndexUrl,
  waitForAppReady,
  openSavedSession,
  startStaticServer,
  stopStaticServer
};
