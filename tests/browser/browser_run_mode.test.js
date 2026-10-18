const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestBrowser, closeGlobalBrowser, startStaticServer, stopStaticServer, seedConnectionProfiles } = require('../helpers/browser-env.js');

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
async function routeBackend(page, prompt, { profile, exportFormat, keepOpen = false, allowDangerous = false } = {}) {
  const calls = [];
  let release;
  const released = new Promise(resolve => { release = resolve; });
  let receiveResult;
  const resultReceived = new Promise(resolve => { receiveResult = resolve; });
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
      return reply({ tools: ['demo_action', 'write_file', 'run_command'].map(name => ({ name, description: name, inputSchema: { type: 'object', properties: {} } })) });
    }
    if (method === 'zerochat/external/status') return reply({ host: 'running', servers: [] });
    if (method.startsWith('zerochat/run/')) {
      calls.push({ method, params });
      if (method === 'zerochat/run/prompt') {
        await released;
        return reply({ prompt, profile: profile ?? null, export: exportFormat ?? null, keep_open: keepOpen, allow_dangerous_tools: allowDangerous });
      }
      if (method === 'zerochat/run/result') receiveResult();
      return reply({ ok: true });
    }
    return json(route, { jsonrpc: '2.0', id, error: { code: -32601, message: `Unsupported ${method}` } });
  });
  return { calls, release, resultReceived };
}

/** Abre la interfaz como la abre el modo ejecución, con window.close() registrado en vez de cerrar. */
async function openRun(browser, server, prompt, { seedProfiles = false, ...runOptions } = {}) {
  const page = await browser.newPage();
  if (seedProfiles) await seedConnectionProfiles(page);
  await page.addInitScript(() => {
    window.close = () => { window.__closed = true; };
  });
  const backend = await routeBackend(page, prompt, runOptions);
  const fragment = new URLSearchParams({ token: 'run-token', host: '127.0.0.1', port: String(BACKEND_PORT), run: RUN_ID });
  await page.goto(`http://127.0.0.1:${server.address().port}/zerochat.html#${fragment}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.ChatState.get('mcp').status === 'connected');
  return { page, backend };
}

const resultOf = backend => backend.calls.find(call => call.method === 'zerochat/run/result')?.params;
const progressOf = backend => backend.calls.filter(call => call.method === 'zerochat/run/progress').map(call => call.params);
const approvalsOf = backend => progressOf(backend).filter(event => event.kind.startsWith('approval_')).map(event => `${event.kind}:${event.text}`).sort();

describe('Browser UI - modo ejecución desatendida', { concurrency: 2 }, () => {
  after(async () => {
    await closeGlobalBrowser();
  });

  test('Browser UI - el modo ejecución envía el prompt en una conversación nueva, informa del progreso, aprueba para la sesión salvo las herramientas peligrosas y devuelve la respuesta final', async () => {
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
            params.onChunk?.('Voy a usar herramientas', 'Voy a usar herramientas', null);
            return { accumulatedText: '', toolCalls: [
              { id: 'call_1', type: 'function', function: { name: 'demo_action', arguments: '{}' } },
              { id: 'call_2', type: 'function', function: { name: 'write_file', arguments: '{"path":"a.txt","content":"x"}' } }
            ], stats: null };
          }
          return { accumulatedText: 'Respuesta final', toolCalls: null, stats: null };
        };
      });
      backend.release();
      await page.waitForFunction(() => window.__closed === true);

      assert.deepEqual(resultOf(backend), { run_id: RUN_ID, text: 'Respuesta final' });
      assert.ok(backend.calls.every(call => call.params.run_id === RUN_ID));
      const kinds = progressOf(backend).map(event => event.kind);
      for (const kind of ['step', 'stream', 'tool']) assert.ok(kinds.includes(kind), `progreso ${kind}: ${kinds}`);
      assert.deepEqual(approvalsOf(backend), ['approval_allowed:demo_action', 'approval_denied:write_file']);
      const messages = await page.evaluate(() => window.ChatState.get('messages').map(message => ({ role: message.role, content: message.content })));
      assert.deepEqual(messages.filter(message => message.role === 'user').map(message => message.content), ['Resume el proyecto']);
      assert.equal(messages.at(-1).content, 'Respuesta final');
      assert.equal(await page.evaluate(() => (window.ChatState.get('ui').notices || []).length), 0);
      assert.equal(await page.evaluate(() => window.ChatStorage.getBackendSession()), null, 'la conexión de la ejecución no se guarda en la cookie de las demás pestañas');
    } finally {
      await browser.close();
      await stopStaticServer(server);
    }
  });

  test('Browser UI - el modo ejecución usa el perfil pedido solo en esa página, rechaza uno inexistente y aprueba las herramientas peligrosas si se permiten', async () => {
    const server = await startStaticServer();
    const browser = await createTestBrowser();
    try {
      const { page, backend } = await openRun(browser, server, 'Hola', { profile: 'Local chat', seedProfiles: true, allowDangerous: true });
      const storedBefore = await page.evaluate(() => window.ChatStorage.loadRuntimeConfigV2()?.activeProfile?.id);
      await page.evaluate(() => {
        window.ChatAPI.streamChatCompletion = async params => {
          window.__model = params.model;
          if (!params.messages.some(message => message.role === 'tool')) return { accumulatedText: '', toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'run_command', arguments: '{"command":"ls"}' } }], stats: null };
          return { accumulatedText: 'ok', toolCalls: null, stats: null };
        };
      });
      backend.release();
      await page.waitForFunction(() => window.__closed === true);
      assert.deepEqual(resultOf(backend), { run_id: RUN_ID, text: 'ok' });
      assert.equal(await page.evaluate(() => window.__model), 'google/gemma-4-26b-a4b-qat');
      assert.deepEqual(approvalsOf(backend), ['approval_allowed:run_command']);
      assert.equal(await page.evaluate(() => window.ChatConfig.getActive().activeProfile.id), 'profile:local');
      assert.notEqual(storedBefore, 'profile:local');
      assert.equal(await page.evaluate(() => window.ChatStorage.loadRuntimeConfigV2()?.activeProfile?.id), storedBefore, 'el perfil activo guardado no cambia');

      const missing = await openRun(browser, server, 'Hola', { profile: 'No existe', seedProfiles: true });
      missing.backend.release();
      await missing.page.waitForFunction(() => window.__closed === true);
      assert.deepEqual(resultOf(missing.backend), { run_id: RUN_ID, error: 'Connection profile not found: No existe' });
    } finally {
      await browser.close();
      await stopStaticServer(server);
    }
  });

  test('Browser UI - el modo ejecución exporta la conversación en HTML como se ve en el chat, devuelve el error de generación y deja la página abierta con keep_open', async () => {
    const server = await startStaticServer();
    const browser = await createTestBrowser();
    try {
      const { page, backend } = await openRun(browser, server, 'Hola', { exportFormat: 'html', keepOpen: true });
      await page.evaluate(() => {
        window.ChatConfig.updateRuntime({ model: 'test-model', apiUrl: 'http://127.0.0.1:9/v1', apiType: 'openai', activeProfile: null });
        window.ChatAPI.streamChatCompletion = async () => { throw new Error('Provider unavailable'); };
      });
      backend.release();
      await backend.resultReceived;
      assert.deepEqual(resultOf(backend), { run_id: RUN_ID, error: 'Provider unavailable' });
      const exportCall = backend.calls.find(call => call.method === 'zerochat/run/export');
      assert.ok(backend.calls.indexOf(exportCall) < backend.calls.findIndex(call => call.method === 'zerochat/run/result'), 'la exportación llega antes del resultado');
      assert.equal(await page.evaluate(() => window.__closed === true), false, 'keep_open no cierra la página');

      // El HTML exportado se abre solo, sin scripts, con el aspecto del chat y desplazamiento normal.
      const html = exportCall.params.content;
      assert.doesNotMatch(html, /<script/i);
      const expected = await page.evaluate(() => {
        const bubble = document.querySelector('.message-row.user .message-content');
        return { theme: document.documentElement.dataset.theme, background: getComputedStyle(bubble).backgroundColor };
      });
      const exported = await browser.newPage();
      await exported.setContent(html);
      const view = await exported.evaluate(() => {
        const bubble = document.querySelector('.message-row.user .message-content');
        const icon = document.querySelector('.messages-list use');
        return {
          theme: document.documentElement.dataset.theme,
          user: bubble.textContent.trim(),
          background: getComputedStyle(bubble).backgroundColor,
          overflow: getComputedStyle(document.body).overflowY,
          actions: document.querySelectorAll('.message-actions').length,
          iconResolved: !icon || Boolean(document.getElementById(icon.getAttribute('href').slice(1)))
        };
      });
      assert.deepEqual(view, { theme: expected.theme, user: 'Hola', background: expected.background, overflow: 'visible', actions: 0, iconResolved: true });
    } finally {
      await browser.close();
      await stopStaticServer(server);
    }
  });

  test('Browser UI - el modo ejecución termina con error cuando un diálogo o ask_user preguntan al usuario', async () => {
    const server = await startStaticServer();
    const browser = await createTestBrowser();
    try {
      const dialog = await openRun(browser, server, 'Hola');
      await dialog.page.evaluate(() => {
        window.ChatConfig.updateRuntime({ model: 'test-model', apiUrl: 'http://127.0.0.1:9/v1', apiType: 'openai', activeProfile: null });
        window.ChatAPI.streamChatCompletion = async () => {
          await window.ChatDialogs.confirm('¿Continuar?', { title: 'Confirmar' });
          return { accumulatedText: 'no debe llegar', toolCalls: null, stats: null };
        };
      });
      dialog.backend.release();
      await dialog.page.waitForFunction(() => window.__closed === true);
      assert.deepEqual(resultOf(dialog.backend), { run_id: RUN_ID, error: 'The run needs the user: Confirmar: ¿Continuar?' });

      const ask = await openRun(browser, server, 'Hola');
      await ask.page.evaluate(() => {
        window.ChatConfig.updateRuntime({ model: 'test-model', apiUrl: 'http://127.0.0.1:9/v1', apiType: 'openai', activeProfile: null });
        window.ChatAPI.streamChatCompletion = async () => ({
          accumulatedText: '',
          toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'ask_user', arguments: '{"question":"¿A o B?","options":["A","B"]}' } }],
          stats: null
        });
      });
      ask.backend.release();
      await ask.page.waitForFunction(() => window.__closed === true);
      assert.deepEqual(resultOf(ask.backend), { run_id: RUN_ID, error: 'The run needs the user: ¿A o B?' });
    } finally {
      await browser.close();
      await stopStaticServer(server);
    }
  });
});
