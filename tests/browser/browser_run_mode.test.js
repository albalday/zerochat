const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestBrowser, closeGlobalBrowser, startStaticServer, stopStaticServer, seedConnectionProfiles } = require('../helpers/browser-env.js');

// Modo ejecución (zerochat.py --prompt) sobre la aplicación real: el servidor local se simula en
// la red de la página y el proveedor en ChatAPI.streamChatCompletion.

const RUN_ID = 'run-id-for-browser-tests-0123456789';
const BACKEND_PORT = 6391;
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'POST, OPTIONS'
};

/**
 * Servidor local falso: registra las llamadas zerochat/run/* y los servicios MCP externos que se
 * arrancan, y retiene el prompt hasta `release`.
 */
async function routeBackend(page, prompt, { profile, exportFormat, keepPage = false, allowDangerous = false, externalServers = [], conversationId = null, toolSecurity = null, initialConversation = null } = {}) {
  const calls = [];
  const started = [];
  const saved = [];
  let release;
  const released = new Promise(resolve => { release = resolve; });
  let receiveResult;
  const resultReceived = new Promise(resolve => { receiveResult = resolve; });
  const liveState = () => ({ cwd: '/tmp/run', jobs: [], exit_on_close: true, servers: externalServers });
  const json = (route, body) => route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route(`http://127.0.0.1:${BACKEND_PORT}/**`, async route => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const { id, method, params } = JSON.parse(request.postData());
    const reply = result => json(route, { jsonrpc: '2.0', id, result });
    if (method === 'initialize') {
      return reply({
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'ZeroChat Local Server', version: '9.5', cwd: '/tmp/run', os: 'linux' },
        capabilities: { tools: {} },
        liveState: liveState()
      });
    }
    if (method === 'zerochat/heartbeat') return reply(liveState());
    if (method === 'zerochat/conversations/list') {
      return reply({ conversations: initialConversation ? [{ id: initialConversation.id, title: initialConversation.title, updatedAt: Date.now(), messageCount: initialConversation.history.length }] : [] });
    }
    if (method === 'zerochat/conversations/get') {
      return reply({ conversation: initialConversation && initialConversation.id === params.id ? initialConversation : null });
    }
    if (method === 'zerochat/conversations/save') {
      saved.push(params);
      return reply({ conversation: params.conversation });
    }
    if (method === 'tools/list') {
      return reply({ tools: ['demo_action', 'write_file', 'run_command'].map(name => ({ name, description: name, inputSchema: { type: 'object', properties: {} } })) });
    }
    if (method === 'zerochat/external/servers/start') {
      started.push({ id: params.serverId, remember: params.remember, ...(params.browser ? { browser: params.browser } : {}) });
      externalServers.find(server => server.id === params.serverId).status = 'running';
      return reply({ servers: externalServers });
    }
    if (method.startsWith('zerochat/run/')) {
      calls.push({ method, params });
      if (method === 'zerochat/run/prompt') {
        await released;
        return reply({
          prompt,
          conversation_id: conversationId,
          profile: profile ?? null,
          export: exportFormat ?? null,
          keep_page: keepPage,
          allow_dangerous_tools: allowDangerous,
          tool_security: toolSecurity
        });
      }
      if (method === 'zerochat/run/result') receiveResult();
      return reply({ ok: true });
    }
    return json(route, { jsonrpc: '2.0', id, error: { code: -32601, message: `Unsupported ${method}` } });
  });
  return { calls, started, saved, release, resultReceived };
}

/** Abre la interfaz como la abre el modo ejecución, con window.close() registrado en vez de cerrar. */
async function openRun(browser, server, prompt, { seedProfiles = false, profileSettings = null, browserTool = null, ...runOptions } = {}) {
  const page = await browser.newPage();
  if (seedProfiles) await seedConnectionProfiles(page);
  if (browserTool) {
    // Herramienta de navegación de Ajustes › Navegador, guardada en la configuración del cliente.
    await page.addInitScript(browser => localStorage.setItem('zerochat_runtime_config_v2', JSON.stringify({ browser })), browserTool);
  }
  if (profileSettings) {
    await page.addInitScript(settings => {
      const document = JSON.parse(localStorage.getItem('zerochat_profiles_v1'));
      Object.assign(document.profiles.find(profile => profile.id === 'profile:local').settings, settings);
      localStorage.setItem('zerochat_profiles_v1', JSON.stringify(document));
    }, profileSettings);
  }
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
  // Un servidor y un navegador para todo el bloque: cada página abre su propio contexto aislado.
  let server;
  let browser;

  before(async () => {
    server = await startStaticServer();
    browser = await createTestBrowser();
  });

  after(async () => {
    await browser?.close();
    if (server) await stopStaticServer(server);
    await closeGlobalBrowser();
  });

  test('Browser UI - el modo ejecución envía el prompt en una conversación nueva, informa del progreso, aprueba para la sesión salvo las herramientas peligrosas y devuelve la respuesta final', async () => {
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
    // El responder contesta sin clic: las tarjetas no quedan esperando autorización.
    assert.deepEqual(await page.evaluate(() => ({
      cards: document.querySelectorAll('#messages-list .tool-execution-card').length,
      waiting: document.querySelectorAll('#messages-list .tool-card-auth-prompt, #messages-list .tool-card-auth-active, #messages-list .status-pending-auth').length
    })), { cards: 2, waiting: 0 });
    const messages = await page.evaluate(() => window.ChatState.get('messages').map(message => ({ role: message.role, content: message.content })));
    assert.deepEqual(messages.filter(message => message.role === 'user').map(message => message.content), ['Resume el proyecto']);
    assert.equal(messages.at(-1).content, 'Respuesta final');
    assert.equal(await page.evaluate(() => (window.ChatState.get('ui').notices || []).length), 0);
    assert.equal(await page.evaluate(() => window.ChatStorage.getBackendSession()), null, 'la conexión de la ejecución no se guarda en la cookie de las demás pestañas');
  });

  test('Browser UI - el modo ejecución usa el perfil pedido solo en esa página, rechaza uno inexistente y aprueba las herramientas peligrosas si se permiten', async () => {
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
    assert.deepEqual(resultOf(missing.backend), { run_id: RUN_ID, error: 'Profile not found: No existe' });
  });

  test('Browser UI - el modo ejecución arranca solo los servicios MCP del perfil y Playwright MCP si es la herramienta de navegación o el perfil lo exige, y falla si alguno no está configurado', async () => {
    const externalServers = () => ['memory', 'github', 'playwright'].map(id => ({ id, displayName: { es: id, en: id }, status: 'stopped', enabled: false }));
    const run = await openRun(browser, server, 'Hola', { profile: 'Local chat', seedProfiles: true, profileSettings: { mcpServers: ['memory'] }, browserTool: 'playwright', externalServers: externalServers() });
    await run.page.evaluate(() => {
      window.ChatAPI.streamChatCompletion = async () => ({ accumulatedText: 'ok', toolCalls: null, stats: null });
    });
    run.backend.release();
    await run.page.waitForFunction(() => window.__closed === true);
    assert.deepEqual(resultOf(run.backend), { run_id: RUN_ID, text: 'ok' });
    assert.deepEqual(run.backend.started, [{ id: 'memory', remember: false }, { id: 'playwright', remember: false }], 'solo arranca los servicios del perfil y Playwright MCP, sin guardarlos como activos');

    // Un perfil que exige Playwright MCP lo arranca con su navegador aunque Ajustes no lo elija.
    const required = { mode: 'own', engine: 'firefox' };
    const forced = await openRun(browser, server, 'Hola', { profile: 'Local chat', seedProfiles: true, profileSettings: { playwrightBrowser: required }, externalServers: externalServers() });
    await forced.page.evaluate(() => {
      window.ChatAPI.streamChatCompletion = async () => ({ accumulatedText: 'ok', toolCalls: null, stats: null });
    });
    forced.backend.release();
    await forced.page.waitForFunction(() => window.__closed === true);
    assert.deepEqual(forced.backend.started, [{ id: 'playwright', remember: false, browser: required }]);

    const missing = await openRun(browser, server, 'Hola', { profile: 'Local chat', seedProfiles: true, profileSettings: { mcpServers: ['memory', 'ghost'] }, externalServers: externalServers() });
    missing.backend.release();
    await missing.page.waitForFunction(() => window.__closed === true);
    assert.deepEqual(resultOf(missing.backend), { run_id: RUN_ID, error: 'MCP servers of the profile are not available: ghost' });
  });

  test('Browser UI - el modo ejecución exporta la conversación en HTML como se ve en el chat, devuelve el error de generación y deja la página abierta con keep_page', async () => {
    const { page, backend } = await openRun(browser, server, 'Hola', { exportFormat: 'html', keepPage: true });
    await page.evaluate(() => {
      window.ChatConfig.updateRuntime({ model: 'test-model', apiUrl: 'http://127.0.0.1:9/v1', apiType: 'openai', activeProfile: null });
      window.ChatAPI.streamChatCompletion = async () => { throw new Error('Provider unavailable'); };
    });
    backend.release();
    await backend.resultReceived;
    assert.deepEqual(resultOf(backend), { run_id: RUN_ID, error: 'Provider unavailable' });
    const exportCall = backend.calls.find(call => call.method === 'zerochat/run/export');
    assert.ok(backend.calls.indexOf(exportCall) < backend.calls.findIndex(call => call.method === 'zerochat/run/result'), 'la exportación llega antes del resultado');
    assert.equal(await page.evaluate(() => window.__closed === true), false, 'keep_page no cierra la página');

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
  });

  test('Browser UI - el modo ejecución termina con error cuando un diálogo o ask_user preguntan al usuario', async () => {
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
  });

  test('Browser UI - el modo ejecución con conversation_id reanuda un paso pausado con allow_once (un solo uso) y devuelve needs_input al volver a pedir permiso', async () => {
    const initialConversation = {
      id: 'conv_resume_e2e',
      title: 'Conversación pausada',
      createdAt: 1000,
      updatedAt: 2000,
      history: [
        { id: 'u1', role: 'user', content: 'Escribe dos archivos' },
        {
          id: 'a1',
          role: 'assistant',
          content: 'Primer intento',
          tool_calls: [{ id: 'c_prev', type: 'function', function: { name: 'write_file', arguments: '{"path":"a.txt","content":"1"}' } }]
        },
        {
          id: 't1',
          role: 'tool',
          tool_call_id: 'c_prev',
          name: 'write_file',
          content: JSON.stringify({ success: false, awaitingApproval: true })
        }
      ]
    };
    const { page, backend } = await openRun(browser, server, null, {
      conversationId: 'conv_resume_e2e',
      initialConversation,
      toolSecurity: { allow_once: ['write_file'] }
    });
    await page.evaluate(() => {
      window.ChatConfig.updateRuntime({ model: 'test-model', apiUrl: 'http://127.0.0.1:9/v1', apiType: 'openai', activeProfile: null });
      let step = 0;
      window.ChatAPI.streamChatCompletion = async () => {
        step += 1;
        if (step === 1) {
          return {
            accumulatedText: 'Escribiendo el primero',
            toolCalls: [{ id: 'call_w1', type: 'function', function: { name: 'write_file', arguments: '{"path":"a.txt","content":"1"}' } }],
            stats: null
          };
        }
        // En el segundo paso vuelve a llamar a write_file: allow_once ya se consumió y debe pausar con needs_input.
        return {
          accumulatedText: 'Intentando el segundo',
          toolCalls: [{ id: 'call_w2', type: 'function', function: { name: 'write_file', arguments: '{"path":"b.txt","content":"2"}' } }],
          stats: null
        };
      };
    });
    backend.release();
    await page.waitForFunction(() => window.__closed === true);

    assert.deepEqual(resultOf(backend), {
      run_id: RUN_ID,
      needs_input: { kind: 'tool_approval', text: 'write_file' }
    });
    assert.ok(backend.saved.length >= 1, 'guarda la conversación actualizada en el servidor antes de terminar');
    const lastSavedMessages = backend.saved.at(-1).messages;
    assert.equal(lastSavedMessages.at(-1).role, 'tool');
    assert.equal(JSON.parse(lastSavedMessages.at(-1).content).awaitingApproval, true);
  });

  test('Browser UI - Ejecutar en servidor con perfil Z-*: switch, progreso en vivo, cambio de chat y reanudación de permisos y ask_user', async () => {
    const page = await browser.newPage();
    await seedConnectionProfiles(page);
    const savedConversations = new Map();
    const startCalls = [];
    const cancelCalls = [];
    let currentRuns = [];
    let currentFocusRun = null;

    const json = (route, body) => route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify(body) });
    await page.route(`http://127.0.0.1:${BACKEND_PORT}/**`, async route => {
      const request = route.request();
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      const { id, method, params } = JSON.parse(request.postData());
      const reply = result => json(route, { jsonrpc: '2.0', id, result });
      const liveState = () => ({
        cwd: '/tmp/run',
        jobs: [],
        exit_on_close: true,
        servers: [],
        runs: currentRuns,
        focus_run: currentFocusRun
      });
      if (method === 'initialize') {
        return reply({
          protocolVersion: '2024-11-05',
          serverInfo: { name: 'ZeroChat Local Server', version: '9.5', cwd: '/tmp/run', os: 'linux' },
          capabilities: { tools: {} },
          liveState: liveState()
        });
      }
      if (method === 'zerochat/heartbeat') return reply(liveState());
      if (method === 'zerochat/profiles/list') {
        return reply({
          profiles: [{
            id: 'general:z-server',
            name: 'server',
            general: true,
            settings: { apiUrl: 'http://127.0.0.1:9/v1', apiType: 'openai', model: 'server-model' }
          }]
        });
      }
      if (method === 'zerochat/conversations/list') {
        const list = [...savedConversations.values()].map(({ history: _h, ...meta }) => meta);
        return reply({ conversations: list });
      }
      if (method === 'zerochat/conversations/get') {
        return reply({ conversation: savedConversations.get(params.id) || null });
      }
      if (method === 'zerochat/conversations/save') {
        const record = { ...params.conversation, history: params.messages || params.conversation.history || [] };
        savedConversations.set(record.id, record);
        return reply({ conversation: record });
      }
      if (method === 'zerochat/conversations/delete') {
        savedConversations.delete(params.id);
        return reply({ deleted: true });
      }
      if (method === 'tools/list') {
        return reply({
          tools: ['run_command', 'write_file'].map(name => ({
            name,
            description: name,
            inputSchema: { type: 'object', properties: {} }
          }))
        });
      }
      if (method === 'zerochat/run/start') {
        startCalls.push(params);
        const runId = `srv_run_${startCalls.length}`;
        currentRuns = [{ conversation_id: params.conversation_id, run_id: runId, status: 'running' }];
        currentFocusRun = {
          conversation_id: params.conversation_id,
          run_id: runId,
          status: 'running',
          step_text: '1',
          assistant_text: 'Analizando **código**',
          reasoning_text: 'Revisando módulos'
        };
        return reply({ run_id: runId, conversation_id: params.conversation_id, status: 'running' });
      }
      if (method === 'zerochat/run/cancel') {
        cancelCalls.push(params);
        currentRuns = currentRuns.filter(r => r.conversation_id !== params.conversation_id);
        if (currentFocusRun?.conversation_id === params.conversation_id) currentFocusRun = null;
        return reply({ cancelled: true });
      }
      return json(route, { jsonrpc: '2.0', id, error: { code: -32601, message: `Unsupported ${method}` } });
    });

    const fragment = new URLSearchParams({ token: 'srv-token', host: '127.0.0.1', port: String(BACKEND_PORT) });
    await page.goto(`http://127.0.0.1:${server.address().port}/zerochat.html#${fragment}`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.documentElement.classList.contains('zerochat-ready') &&
      window.ChatState.get('mcp').status === 'connected');

    // Con backend conectado no hay slider independiente en cabecera; todo se gestiona en perfiles
    assert.equal(await page.locator('#server-run-control').count(), 0);

    await page.evaluate(() => window.ChatUIProfiles.setServerMode(true, 'server'));
    assert.equal(await page.locator('#active-profile-trigger.server-mode').count(), 1);
    assert.equal(await page.locator('#active-profile-trigger .profile-icon use').getAttribute('href'), '#icon-zap');
    assert.equal((await page.locator('#active-profile-name').textContent()).trim(), 'server');
    await page.locator('#user-input').fill('Analiza el repositorio');
    await page.locator('#btn-send').click();

    await page.waitForFunction(() => document.querySelector('.server-run-live-wrapper') !== null);
    const activeConvId = await page.evaluate(() => window.ChatState.get('sessions').activeId);
    assert.equal(startCalls.length, 1);
    assert.equal(startCalls[0].conversation_id, activeConvId);
    assert.equal(startCalls[0].profile, 'server');

    // Al llegar el siguiente latido con focus_run se muestran el banner, el paso, el razonamiento y el Markdown.
    await page.evaluate(() => window.ChatMCP.manager.readLiveState());
    const liveView = await page.evaluate(() => ({
      banner: document.querySelector('.server-run-banner-title')?.textContent,
      step: document.querySelector('.server-run-step')?.textContent,
      thought: document.querySelector('.server-run-thought .thought-content')?.textContent,
      assistantBold: document.querySelector('.server-run-assistant-block strong')?.textContent,
      sendDisabled: document.getElementById('btn-send').disabled,
      stopVisible: !document.getElementById('btn-stop-stream').hidden,
      sidebarRunningIcon: Boolean(document.querySelector(`.sidebar-chat-item[data-session-id="${window.ChatState.get('sessions').activeId}"] .sidebar-chat-status-icon.running`))
    }));
    assert.deepEqual(liveView, {
      banner: 'Ejecutándose en el servidor: tarea srv_run_1',
      step: '1',
      thought: 'Revisando módulos',
      assistantBold: 'código',
      sendDisabled: true,
      stopVisible: true,
      sidebarRunningIcon: true
    });

    // Permite abrir una conversación nueva mientras la primera sigue corriendo en el servidor.
    await page.evaluate(() => document.getElementById('btn-sidebar-new-chat').click());
    await page.waitForFunction(prevId => window.ChatState.get('sessions').activeId !== prevId, activeConvId);
    const newSessionView = await page.evaluate(() => ({
      liveWrapper: Boolean(document.querySelector('.server-run-live-wrapper')),
      sendDisabled: document.getElementById('btn-send').disabled,
      stopHidden: document.getElementById('btn-stop-stream').hidden
    }));
    assert.deepEqual(newSessionView, { liveWrapper: false, sendDisabled: false, stopHidden: true });

    // Volver a la conversación en ejecución restaura su vista en vivo y bloqueo de envío.
    await page.locator(`.sidebar-chat-item[data-session-id="${activeConvId}"]`).evaluate(el => el.click());
    await page.waitForFunction(id => window.ChatState.get('sessions').activeId === id, activeConvId);
    assert.equal(await page.locator('.server-run-live-wrapper').count(), 1);

    // La ejecución en el servidor se pausa pidiendo permiso de write_file (needs_input).
    const convRecord = savedConversations.get(activeConvId);
    convRecord.history.push(
      {
        id: 'msg_ast_1_turn_0_assistant',
        role: 'assistant',
        content: 'Necesito escribir un archivo.',
        tool_calls: [{ id: 'call_w1', type: 'function', function: { name: 'write_file', arguments: '{"path":"out.txt","content":"hola"}' } }]
      },
      {
        id: 'msg_ast_1_turn_0_tool_call_w1',
        role: 'tool',
        tool_call_id: 'call_w1',
        name: 'write_file',
        content: JSON.stringify({ success: false, awaitingApproval: true, error: 'Execution paused waiting for user authorization.' })
      }
    );
    currentRuns = [{ conversation_id: activeConvId, run_id: 'srv_run_1', status: 'needs_input' }];
    currentFocusRun = {
      conversation_id: activeConvId,
      run_id: 'srv_run_1',
      status: 'needs_input',
      pending: { kind: 'tool_approval', text: 'write_file' }
    };
    await page.evaluate(() => window.ChatMCP.manager.readLiveState());
    await page.waitForFunction(() => document.querySelector('.tool-card-auth-prompt .btn-auth-allow-once') !== null);

    const pausedView = await page.evaluate(id => ({
      liveWrapper: Boolean(document.querySelector('.server-run-live-wrapper')),
      needsInputIcon: Boolean(document.querySelector(`.sidebar-chat-item[data-session-id="${id}"] .sidebar-chat-status-icon.needs-input`)),
      authPrompt: Boolean(document.querySelector('.tool-card-auth-prompt'))
    }), activeConvId);
    assert.deepEqual(pausedView, { liveWrapper: false, needsInputIcon: true, authPrompt: true });

    // Al pulsar "Permitir una vez", retira el paso pausado y relanza la ejecución en el servidor con allow_once.
    await page.locator('.tool-card-auth-prompt .btn-auth-allow-once').click();
    await page.waitForFunction(() => document.querySelector('.server-run-live-wrapper') !== null);
    assert.equal(startCalls.length, 2);
    assert.deepEqual(startCalls[1].tool_security.allow_once, ['write_file']);

    // Ahora el servidor pausa en ask_user y el usuario responde pulsando una opción.
    const convAfterResume = savedConversations.get(activeConvId);
    convAfterResume.history.push(
      {
        id: 'msg_ast_2_turn_0_assistant',
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_ask_1', type: 'function', function: { name: 'ask_user', arguments: JSON.stringify({ question: '¿Qué entorno usar?', options: [{ label: 'Producción' }, { label: 'Staging' }] }) } }]
      },
      {
        id: 'msg_ast_2_turn_0_tool_call_ask_1',
        role: 'tool',
        tool_call_id: 'call_ask_1',
        name: 'ask_user',
        content: JSON.stringify({ success: true, endTurn: true, question: '¿Qué entorno usar?', options: [{ label: 'Producción' }, { label: 'Staging' }] })
      }
    );
    currentRuns = [{ conversation_id: activeConvId, run_id: 'srv_run_2', status: 'needs_input' }];
    currentFocusRun = {
      conversation_id: activeConvId,
      run_id: 'srv_run_2',
      status: 'needs_input',
      pending: { kind: 'ask_user', text: '¿Qué entorno usar?' }
    };
    await page.evaluate(() => window.ChatMCP.manager.readLiveState());
    await page.waitForFunction(() => {
      const btn = document.querySelector('.ask-user-option[data-ask-option="Staging"]');
      return btn && !btn.disabled;
    });
    await page.locator('.ask-user-option[data-ask-option="Staging"]').click();
    await page.waitForFunction(() => document.querySelector('.server-run-live-wrapper') !== null);
    assert.equal(startCalls.length, 3);
    assert.equal(savedConversations.get(activeConvId).history.at(-1).content, 'Staging');

    // Completar la ejecución en el servidor
    currentRuns = [];
    currentFocusRun = null;
    await page.evaluate(() => window.ChatMCP.manager.readLiveState());
    await page.waitForFunction(() => document.querySelector('.server-run-live-wrapper') === null);

    // Crear una nueva conversación local: desactiva el modo servidor
    await page.locator('#btn-sidebar-new-chat').click();
    await page.waitForFunction(id => window.ChatState.get('sessions').activeId !== id, activeConvId);
    assert.equal(await page.evaluate(() => window.ChatUIProfiles.isServerMode()), false);
    assert.equal(await page.locator('#active-profile-trigger.server-mode').count(), 0);

    // Recuperar la conversación lanzada al servidor desde el historial: activa modo servidor y recupera su perfil
    await page.locator(`.sidebar-chat-item[data-session-id="${activeConvId}"]`).click();
    await page.waitForFunction(() => window.ChatUIProfiles.isServerMode());
    assert.equal(await page.locator('#active-profile-trigger.server-mode').count(), 1);
    const restoredServerProfile = await page.evaluate(() => window.ChatUIProfiles.getSelectedServerProfile());
    assert.equal(restoredServerProfile, 'server');
  });
});
