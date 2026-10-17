const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestBrowser, closeGlobalBrowser, startStaticServer, stopStaticServer } = require('../helpers/browser-env.js');

// Modo ejecución (zerochat.py --prompt) sobre la aplicación real: el servidor local se simula en
// la red de la página y el proveedor en ChatAPI.streamChatCompletion.

const RUN_ID = 'run-id-for-browser-tests-0123456789';
const BACKEND_PORT = 6391;
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS'
};

/** Servidor local falso: registra las llamadas zerochat/run/* y retiene el prompt hasta `release`. */
async function routeBackend(page, prompt) {
  const calls = [];
  let release;
  const released = new Promise(resolve => { release = resolve; });
  const json = (route, body) => route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route(`http://127.0.0.1:${BACKEND_PORT}/**`, async route => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    if (request.method() === 'GET') return json(route, { ok: true, cwd: '/tmp/run', jobs: [] });
    const { id, method, params } = JSON.parse(request.postData());
    const reply = result => json(route, { jsonrpc: '2.0', id, result });
    if (method === 'initialize') {
      return reply({ protocolVersion: '2024-11-05', serverInfo: { name: 'ZeroChat Local Server', version: '9.5', cwd: '/tmp/run', os: 'linux' }, capabilities: { tools: {} } });
    }
    if (method === 'tools/list') {
      return reply({ tools: [{ name: 'demo_action', description: 'Demo action', inputSchema: { type: 'object', properties: {} } }] });
    }
    if (method === 'zerochat/external/status') return reply({ host: 'running', servers: [] });
    if (method.startsWith('zerochat/run/')) {
      calls.push({ method, params });
      if (method === 'zerochat/run/prompt') {
        await released;
        return reply({ prompt });
      }
      return reply({ ok: true });
    }
    return json(route, { jsonrpc: '2.0', id, error: { code: -32601, message: `Unsupported ${method}` } });
  });
  return { calls, release };
}

/** Abre la interfaz como la abre el modo ejecución, con window.close() registrado en vez de cerrar. */
async function openRun(browser, server, prompt) {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    window.close = () => { window.__closed = true; };
  });
  const backend = await routeBackend(page, prompt);
  const fragment = new URLSearchParams({ token: 'run-token', host: '127.0.0.1', port: String(BACKEND_PORT), run: RUN_ID });
  await page.goto(`http://127.0.0.1:${server.address().port}/zerochat.html#${fragment}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.ChatState.get('mcp').status === 'connected');
  return { page, backend };
}

const resultOf = backend => backend.calls.find(call => call.method === 'zerochat/run/result')?.params;
const progressOf = backend => backend.calls.filter(call => call.method === 'zerochat/run/progress').map(call => call.params);

describe('Browser UI - modo ejecución desatendida', { concurrency: 2 }, () => {
  after(async () => {
    await closeGlobalBrowser();
  });

  test('Browser UI - el modo ejecución envía el prompt en una conversación nueva, informa del progreso, deniega la aprobación, cierra los diálogos y devuelve la respuesta final', async () => {
    const server = await startStaticServer();
    const browser = await createTestBrowser();
    try {
      const { page, backend } = await openRun(browser, server, 'Resume el proyecto');
      assert.equal(page.url().includes('run-token') || page.url().includes(RUN_ID), false, 'el fragmento se limpia');
      await page.evaluate(() => {
        window.ChatConfig.updateRuntime({ model: 'test-model', apiUrl: 'http://127.0.0.1:9/v1', apiType: 'openai', activeProfile: null });
        let calls = 0;
        window.ChatAPI.streamChatCompletion = async params => {
          calls += 1;
          if (calls === 1) {
            params.onChunk?.('Voy a usar una herramienta', 'Voy a usar una herramienta', null);
            return { accumulatedText: '', toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'demo_action', arguments: '{}' } }], stats: null };
          }
          // Un diálogo durante la ejecución no la bloquea.
          await window.ChatDialogs.confirm('¿Continuar?');
          const denied = params.messages.some(message => message.role === 'tool' && /denied/i.test(message.content));
          return { accumulatedText: denied ? 'Respuesta final sin la herramienta' : 'herramienta ejecutada', toolCalls: null, stats: null };
        };
      });
      backend.release();
      await page.waitForFunction(() => window.__closed === true);

      assert.deepEqual(resultOf(backend), { run_id: RUN_ID, text: 'Respuesta final sin la herramienta' });
      assert.ok(backend.calls.every(call => call.params.run_id === RUN_ID));
      const kinds = progressOf(backend).map(event => event.kind);
      for (const kind of ['step', 'stream', 'tool', 'approval_denied', 'dialog']) assert.ok(kinds.includes(kind), `progreso ${kind}: ${kinds}`);
      assert.match(progressOf(backend).find(event => event.kind === 'dialog').text, /¿Continuar\?/);
      const messages = await page.evaluate(() => window.ChatState.get('messages').map(message => ({ role: message.role, content: message.content })));
      assert.deepEqual(messages.filter(message => message.role === 'user').map(message => message.content), ['Resume el proyecto']);
      assert.equal(messages.at(-1).content, 'Respuesta final sin la herramienta');
      assert.equal(await page.evaluate(() => (window.ChatState.get('ui').notices || []).length), 0);
    } finally {
      await browser.close();
      await stopStaticServer(server);
    }
  });

  test('Browser UI - el modo ejecución devuelve el error de generación', async () => {
    const server = await startStaticServer();
    const browser = await createTestBrowser();
    try {
      const { page, backend } = await openRun(browser, server, 'Hola');
      await page.evaluate(() => {
        window.ChatConfig.updateRuntime({ model: 'test-model', apiUrl: 'http://127.0.0.1:9/v1', apiType: 'openai', activeProfile: null });
        window.ChatAPI.streamChatCompletion = async () => { throw new Error('Provider unavailable'); };
      });
      backend.release();
      await page.waitForFunction(() => window.__closed === true);
      assert.deepEqual(resultOf(backend), { run_id: RUN_ID, error: 'Provider unavailable' });
    } finally {
      await browser.close();
      await stopStaticServer(server);
    }
  });
});
