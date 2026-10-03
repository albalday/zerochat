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

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true });
  }
  const browser = await browserPromise;
  if (!browser.isConnected()) {
    browserPromise = chromium.launch({ headless: true });
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

async function createTestBrowser() {
  const realBrowser = await getBrowser();
  const contexts = [];
  return {
    async newContext(options) {
      const context = await realBrowser.newContext(options);
      contexts.push(context);
      return context;
    },
    async newPage(options) {
      const context = await realBrowser.newContext(options);
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

module.exports = {
  getBrowser,
  closeGlobalBrowser,
  createTestBrowser,
  seedConnectionProfiles,
  getIndexUrl,
  waitForAppReady,
  startStaticServer,
  stopStaticServer
};
