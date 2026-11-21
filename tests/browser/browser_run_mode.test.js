const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestBrowser, closeGlobalBrowser, startStaticServer, stopStaticServer } = require('../helpers/browser-env.js');

// Ejecución en servidor desde la interfaz web: switch, pasos grabados y reanudación en bandeja HITL.

const BACKEND_PORT = 6391;
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'POST, OPTIONS'
};

describe('Browser UI - ejecución en servidor', { concurrency: 2 }, () => {
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

  test('Browser UI - Ejecutar en servidor con perfil de servidor: switch, pasos grabados, cambio de chat y reanudación de permisos y ask_user', async () => {
    const page = await browser.newPage();
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
        serverId: 'srv-run-mode-test',
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
            id: 'profile:server',
            name: 'server',
            hasApiKey: false,
            updatedAt: 1000,
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
          conversation_updated_at: savedConversations.get(params.conversation_id)?.updatedAt ?? null
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
      window.ChatState.get('mcp').status === 'connected' &&
      window.ChatProfileRepository.get('profile:server') !== null);

    await page.evaluate(async () => {
      await window.ChatUIProfiles.activateConnectionProfile('profile:server');
      window.ChatUIProfiles.setServerMode(true);
    });
    assert.equal(await page.locator('#active-profile-trigger.server-mode').count(), 1);
    assert.equal((await page.locator('#active-profile-name').textContent()).trim(), 'server');
    await page.locator('#user-input').fill('Analiza el repositorio');
    await page.locator('#btn-send').click();

    await page.waitForFunction(() => document.querySelector('.server-run-live-wrapper') !== null);
    const activeConvId = await page.evaluate(() => window.ChatState.get('sessions').activeId);
    assert.equal(startCalls.length, 1);
    assert.equal(startCalls[0].conversation_id, activeConvId);
    assert.equal(startCalls[0].profile, 'server');

    // Un paso que la ejecución graba llega con el siguiente latido: la página recarga la conversación grabada.
    const runningRecord = savedConversations.get(activeConvId);
    runningRecord.history.push({ id: 'srv_step_1', role: 'assistant', content: 'Analizando **código**' });
    runningRecord.updatedAt += 1000;
    currentFocusRun = { ...currentFocusRun, conversation_updated_at: runningRecord.updatedAt };
    await page.evaluate(() => window.ChatMCP.manager.readLiveState());
    await page.waitForFunction(() => document.querySelector('.message-wrapper.assistant:not(.server-run-live-wrapper) strong')?.textContent === 'código');
    const liveView = await page.evaluate(() => ({
      banner: document.querySelector('.server-run-banner-title')?.textContent,
      step: document.querySelector('.server-run-step')?.textContent,
      heartbeatActive: window.ChatMCP.manager.liveWatchAbort !== null,
      sendDisabled: document.getElementById('btn-send').disabled,
      stopVisible: !document.getElementById('btn-stop-stream').hidden,
      sidebarRunningIcon: Boolean(document.querySelector(`.sidebar-chat-item[data-session-id="${window.ChatState.get('sessions').activeId}"] .sidebar-chat-status-icon.running`))
    }));
    assert.deepEqual(liveView, {
      banner: 'Ejecutándose en el servidor: tarea srv_run_1',
      step: '1',
      heartbeatActive: true,
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

    // Al pulsar "Permitir una vez", retira el paso pausado y relanza la ejecución en el servidor con esa decisión.
    await page.locator('.tool-card-auth-prompt .btn-auth-allow-once').click();
    await page.waitForFunction(() => document.querySelector('.server-run-live-wrapper') !== null);
    assert.equal(startCalls.length, 2);
    // La decisión viaja con los argumentos de la llamada aprobada: solo vale para ella.
    assert.deepEqual(startCalls[1].tool_security.tool_decision, { toolName: 'write_file', args: { path: 'out.txt', content: 'hola' }, decision: 'allow_once' });

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

    // Crear una nueva conversación: conserva el modo y perfil de servidor activo
    await page.locator('#btn-sidebar-new-chat').click();
    await page.waitForFunction(id => window.ChatState.get('sessions').activeId !== id, activeConvId);
    assert.equal(await page.evaluate(() => window.ChatUIProfiles.isServerMode()), true);
    assert.equal(await page.locator('#active-profile-trigger.server-mode').count(), 1);
    assert.equal(await page.evaluate(() => window.ChatConfig.getActive().activeProfile?.name), 'server');

    // Desactivar modo servidor en el borrador para probar la recuperación desde el historial
    await page.evaluate(() => window.ChatUIProfiles.setServerMode(false));
    assert.equal(await page.evaluate(() => window.ChatUIProfiles.isServerMode()), false);
    assert.equal(await page.locator('#active-profile-trigger.server-mode').count(), 0);

    // Recuperar la conversación lanzada al servidor desde el historial: activa modo servidor y recupera su perfil
    await page.locator(`.sidebar-chat-item[data-session-id="${activeConvId}"]`).click();
    await page.waitForFunction(() => window.ChatUIProfiles.isServerMode());
    assert.equal(await page.locator('#active-profile-trigger.server-mode').count(), 1);
    const restoredServerProfile = await page.evaluate(() => window.ChatConfig.getActive().activeProfile?.name);
    assert.equal(restoredServerProfile, 'server');

    // Crear un nuevo chat conserva el modo y perfil de servidor elegido y no sobrescribe el chat previo
    await page.locator('#btn-sidebar-new-chat').click();
    await page.waitForFunction(id => window.ChatState.get('sessions').activeId !== id, activeConvId);
    assert.equal(await page.evaluate(() => window.ChatUIProfiles.isServerMode()), true);
    assert.equal(await page.locator('#active-profile-trigger.server-mode').count(), 1);
    const newConvId = await page.evaluate(() => window.ChatState.get('sessions').activeId);

    // Enviar mensaje en modo servidor
    await page.locator('#user-input').fill('Prompt en chat nuevo');
    await page.locator('#btn-send').click();
    await page.waitForFunction(() => document.querySelector('.server-run-live-wrapper') !== null);

    // Comprobar que la ejecución en servidor se lanzó con newConvId, no con activeConvId
    assert.equal(startCalls.length, 4);
    const lastStartCall = startCalls.at(-1);
    assert.equal(lastStartCall?.conversation_id, newConvId);
    assert.notEqual(lastStartCall?.conversation_id, activeConvId);

    // Comprobar que activeConvId sigue intacta en el almacenamiento
    assert.equal(savedConversations.get(activeConvId).history.at(-1).content, 'Staging');
  });
});
