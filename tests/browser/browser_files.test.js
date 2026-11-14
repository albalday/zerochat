const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestBrowser, closeGlobalBrowser, startStaticServer, stopStaticServer } = require('../helpers/browser-env.js');

const BACKEND = 'http://127.0.0.1:6399';
const PROJECT = '/home/yo/app';

/**
 * Página de ficheros contra un servidor falso: `handle(method, params, headers)` devuelve el resultado
 * JSON-RPC o lanza `{ code, message }` como error.
 */
async function openFilesPage(handle, { session = true, query = `?project=${encodeURIComponent(PROJECT)}` } = {}) {
  const server = await startStaticServer();
  const browser = await createTestBrowser();
  const context = await browser.newContext();
  const calls = [];
  await context.route(`${BACKEND}/**`, async route => {
    const request = route.request();
    const body = JSON.parse(request.postData() || '{}');
    calls.push({ method: body.method, params: body.params, headers: request.headers() });
    try {
      const result = await handle(body.method, body.params || {});
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result }) });
    } catch (error) {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: body.id, error }) });
    }
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const base = `http://127.0.0.1:${server.address().port}/files.html`;
  if (session) {
    await page.goto(base, { waitUntil: 'load' });
    await page.evaluate(url => window.ChatStorage.setBackendSession({ token: 'tok-prueba', url }), BACKEND);
  }
  await page.goto(base + query, { waitUntil: 'load' });
  return {
    page,
    calls,
    errors,
    base,
    close: async () => {
      await browser.close();
      await stopStaticServer(server);
    }
  };
}

const statusText = page => page.locator('#files-status').textContent();

describe('Browser UI - navegador de ficheros', { concurrency: 2 }, () => {
  after(async () => {
    await closeGlobalBrowser();
  });

  test('Browser UI - la página de ficheros explica por qué no puede mostrar el proyecto', async () => {
    const noProject = await openFilesPage(() => ({}), { query: '' });
    try {
      assert.match(await statusText(noProject.page), /Falta el proyecto/);
      assert.equal(noProject.calls.length, 0);
    } finally {
      await noProject.close();
    }
    const noSession = await openFilesPage(() => ({}), { session: false });
    try {
      assert.match(await statusText(noSession.page), /No hay sesión con el servidor local/);
      assert.equal(await noSession.page.locator('#files-project').textContent(), 'app');
    } finally {
      await noSession.close();
    }
    const gone = await openFilesPage(() => { throw { code: -32003, message: 'gone' }; });
    try {
      await gone.page.waitForFunction(() => /ya no existe/.test(document.getElementById('files-status').textContent));
      // Cada petición lleva el token de la sesión y el proyecto de la URL.
      const [call] = gone.calls;
      assert.deepEqual([call.method, call.params, call.headers['x-zerochat-token'], decodeURIComponent(call.headers['x-zerochat-project'])],
        ['zerochat/files/list', { path: '' }, 'tok-prueba', PROJECT]);
      assert.deepEqual(gone.errors, []);
    } finally {
      await gone.close();
    }
  });
});
