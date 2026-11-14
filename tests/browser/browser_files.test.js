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

  test('Browser UI - la lista de ficheros pone las carpetas primero y se recorre con las migas y el botón Atrás', async () => {
    const tree = {
      '': [
        { name: 'src', type: 'dir', size: null, modified: Date.UTC(2026, 10, 1) },
        { name: 'README.md', type: 'file', size: 2048, modified: Date.UTC(2026, 10, 2) }
      ],
      src: [{ name: 'util', type: 'dir', size: null, modified: Date.UTC(2026, 10, 3) }],
      'src/util': []
    };
    const files = await openFilesPage((method, params) => ({ path: params.path, entries: tree[params.path], total: tree[params.path].length, truncated: false }));
    const { page } = files;
    try {
      const rows = () => page.locator('#files-list .files-entry').evaluateAll(items => items.map(item => ({
        name: item.querySelector('.files-entry-name').textContent,
        link: item.querySelector('.files-entry-name').tagName === 'A',
        icon: Boolean(item.querySelector('.files-entry-icon svg')),
        size: item.querySelector('.files-entry-size').textContent
      })));
      const crumbs = () => page.locator('#files-breadcrumbs').evaluate(nav => Array.from(nav.querySelectorAll('.files-crumb'), node => node.textContent));
      await page.waitForFunction(() => document.querySelectorAll('#files-list .files-entry').length === 2);
      assert.deepEqual(await rows(), [
        { name: 'src', link: true, icon: true, size: '' },
        { name: 'README.md', link: false, icon: false, size: '2 KB' }
      ]);
      assert.deepEqual(await crumbs(), ['app']);

      await page.locator('#files-list a.files-entry-name', { hasText: 'src' }).click();
      await page.waitForFunction(() => document.querySelector('#files-list .files-entry-name')?.textContent === 'util');
      await page.locator('#files-list a.files-entry-name', { hasText: 'util' }).click();
      await page.waitForFunction(() => /vacía/.test(document.getElementById('files-status').textContent));
      assert.match(page.url(), /path=src%2Futil$/);
      assert.deepEqual(await crumbs(), ['app', 'src', 'util']);

      // Las migas suben, y Atrás vuelve a la carpeta anterior.
      await page.locator('#files-breadcrumbs .files-crumb', { hasText: 'src' }).click();
      await page.waitForFunction(() => document.querySelector('#files-list .files-entry-name')?.textContent === 'util');
      await page.goBack();
      await page.waitForFunction(() => /vacía/.test(document.getElementById('files-status').textContent));
      assert.match(page.url(), /path=src%2Futil$/);
      assert.deepEqual(files.calls.map(call => call.params.path), ['', 'src', 'src/util', 'src', 'src/util']);
      assert.deepEqual(files.errors, []);
    } finally {
      await files.close();
    }
  });

  test('Browser UI - un fichero de texto se abre en otra pestaña y uno binario se descarga', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 250, 251]);
    const files = await openFilesPage((method, params) => {
      if (method === 'zerochat/files/list') {
        return { path: '', total: 2, truncated: false, entries: [
          { name: 'README.md', type: 'file', size: 7, modified: Date.UTC(2026, 10, 2) },
          { name: 'logo.png', type: 'file', size: png.length, modified: Date.UTC(2026, 10, 2) }
        ] };
      }
      if (method === 'zerochat/files/read') {
        return params.path === 'README.md' ? { path: 'README.md', size: 7, binary: false, text: '# Hola\n' } : { path: params.path, size: png.length, binary: true };
      }
      // Dos páginas: el cliente las une en orden.
      const half = params.offset === 0 ? png.subarray(0, 6) : png.subarray(6);
      return { path: params.path, name: 'logo.png', size: png.length, data: half.toString('base64'), next: params.offset + half.length, done: params.offset > 0 };
    });
    const { page } = files;
    try {
      await page.waitForFunction(() => document.querySelectorAll('#files-list button[data-file]').length === 2);
      const [popup] = await Promise.all([page.waitForEvent('popup'), page.locator('button[data-file="README.md"]').click()]);
      await popup.waitForURL(/^blob:/);
      assert.equal(await popup.evaluate(() => document.body.innerText), '# Hola\n');
      await popup.close();

      const [download] = await Promise.all([page.waitForEvent('download'), page.locator('button[data-file="logo.png"]').click()]);
      assert.equal(download.suggestedFilename(), 'logo.png');
      const stream = await download.createReadStream();
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      assert.deepEqual(Buffer.concat(chunks), png);
      assert.deepEqual(files.calls.filter(call => call.method === 'zerochat/files/download').map(call => call.params.offset), [0, 6]);
      assert.deepEqual(files.errors, []);
    } finally {
      await files.close();
    }
  });
});
