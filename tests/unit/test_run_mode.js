const test = require('node:test');
const assert = require('node:assert/strict');
const RunMode = require('../../js/run-mode.js');
const MCP = require('../../js/mcp.js');
const Profiles = require('../../js/profile-repository.js');
const State = require('../../js/state.js');
const Config = require('../../js/config-store.js');
const ToolCards = require('../../js/tool-cards.js');

test('RunMode.createProgressReporter limita el streaming al intervalo y envía siempre los demás avisos', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 10_000 });
  const sent = [];
  const report = RunMode.createProgressReporter(event => sent.push(event));
  report({ kind: 'stream', text: 's1' });
  t.mock.timers.tick(500);
  report({ kind: 'stream', text: 's1b' });
  report({ kind: 'tool', text: 'tool' });
  t.mock.timers.tick(1499);
  report({ kind: 'stream', text: 's2' });
  t.mock.timers.tick(1);
  report({ kind: 'stream', text: 's3' });
  report({ kind: 'status', text: 'status' });
  assert.deepEqual(sent.map(event => event.text), ['s1', 'tool', 's3', 'status']);
});

test('RunMode.pendingAskUserQuestion toma la pregunta de ask_user de los mensajes tool del final del turno', () => {
  const askCall = (id, question) => ({ id, type: 'function', function: { name: 'ask_user', arguments: JSON.stringify({ question, options: ['A', 'B'] }) } });
  const readCall = { id: 'r1', type: 'function', function: { name: 'read_file', arguments: '{}' } };
  const tool = (id, name) => ({ role: 'tool', tool_call_id: id, name, content: '{}' });
  const user = { role: 'user', content: 'hola' };
  const rows = [
    [[user, { role: 'assistant', tool_calls: [askCall('a1', ' ¿Sigo? ')] }, tool('a1', 'ask_user')], '¿Sigo?'],
    // Varias herramientas en el mismo paso: ask_user no tiene que ser la última.
    [[user, { role: 'assistant', tool_calls: [askCall('a1', '¿Cuál?'), readCall] }, tool('a1', 'ask_user'), tool('r1', 'read_file')], '¿Cuál?'],
    // Un ask_user de un turno anterior, ya contestado, no cuenta.
    [[user, { role: 'assistant', tool_calls: [askCall('a1', '¿Cuál?')] }, tool('a1', 'ask_user'), user, { role: 'assistant', content: 'Hecho' }], null],
    [[user, { role: 'assistant', tool_calls: [readCall] }, tool('r1', 'read_file')], null],
    [[user, { role: 'assistant', tool_calls: [{ id: 'a1', function: { name: 'ask_user', arguments: 'no json' } }] }, tool('a1', 'ask_user')], 'ask_user'],
    [[], null]
  ];
  for (const [messages, expected] of rows) assert.equal(RunMode.pendingAskUserQuestion(messages), expected, JSON.stringify(messages));
});

test('RunMode.answerToolApprovals aprueba todas las herramientas en la sesión', t => {
  const ToolCards = require('../../js/tool-cards.js');
  let responder = null;
  t.mock.method(ToolCards, 'setAuthorizationResponder', fn => { responder = fn; });
  const events = [];
  RunMode.answerToolApprovals(event => events.push(event));
  const tools = ['read_file', 'run_command', 'write_file', 'edit_file'];
  assert.deepEqual(tools.map(name => [name, responder(name)]), tools.map(name => [name, 'allow_session']));
  assert.deepEqual(events, tools.map(name => ({ kind: 'approval_allowed', text: name })));
});

test('RunMode - pendingToolApproval y prepareConversationForContinuation detectan y retiran pasos con awaitingApproval', () => {
  const tool = (name, content) => ({ role: 'tool', name, content });
  const user = { role: 'user', content: 'hola' };
  const rows = [
    [[user, tool('write_file', JSON.stringify({ success: false, awaitingApproval: true }))], 'write_file'],
    [[user, tool('read_file', '{}'), tool('run_command', JSON.stringify({ awaitingApproval: true }))], 'run_command'],
    [[user, tool('write_file', JSON.stringify({ awaitingApproval: true })), user, { role: 'assistant', content: 'ok' }], null],
    [[user, tool('write_file', JSON.stringify({ success: true }))], null],
    [[user, tool('write_file', 'not json')], null],
    [[], null]
  ];
  for (const [messages, expected] of rows) {
    assert.equal(RunMode.pendingToolApproval(messages), expected, JSON.stringify(messages));
  }

  const assistantCall = { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'write_file' } }] };
  const toolPending = { role: 'tool', tool_call_id: 'c1', name: 'write_file', content: JSON.stringify({ awaitingApproval: true }) };
  assert.deepEqual(RunMode.prepareConversationForContinuation([user, assistantCall, toolPending]), [user]);
  const normalHistory = [user, { role: 'assistant', content: 'respuesta' }];
  assert.deepEqual(RunMode.prepareConversationForContinuation(normalHistory), normalHistory);
});

test('RunMode.start - ciclo completo: nueva conversación, límites, needs_input, exportación y reanudación', async t => {
  const prevWindow = globalThis.window;
  let closedCount = 0;
  globalThis.window = { close: () => { closedCount += 1; } };
  t.after(() => {
    if (prevWindow === undefined) delete globalThis.window;
    else globalThis.window = prevWindow;
    Profiles.clearSessionProfile();
    State.replaceConversation({ sessionId: 'reset', messages: [], sessions: [] });
  });

  async function runScenario({ promptPayload, submitResult, afterSubmitMessages = [] }) {
    const calls = [];
    let activated = null;
    let startedNew = null;
    let switched = null;
    let submitted = null;

    t.mock.method(MCP.manager, 'reconcileProjectServers', async () => {});
    t.mock.method(MCP.manager, 'requestExternalControl', async (method, params) => {
      calls.push({ method, params });
      if (method === 'zerochat/run/prompt') return promptPayload;
      if (method === 'zerochat/run/profile') return { profile: { id: params.id, name: 'local', settings: { apiKey: 'sk' } } };
      return { ok: true };
    });

    await RunMode.start('run_test_id_123456', {
      startupConnection: Promise.resolve({ success: true }),
      connectBackend: async () => ({ success: true }),
      activateSessionProfile: async id => { activated = id; },
      submitComposerText: async (text, opts) => {
        submitted = { text, opts };
        State.replaceMessages(afterSubmitMessages);
        return submitResult;
      },
      exportConversation: async fmt => `exported:${fmt}`,
      switchToSession: async id => { switched = id; },
      startNewSession: async id => { startedNew = id; }
    });
    return { calls, activated, startedNew, switched, submitted };
  }

  // 1. Nueva conversación con perfil, exportación y respuesta final.
  const ok = await runScenario({
    promptPayload: {
      prompt: 'Hola',
      profile: 'local',
      profiles: [{ id: 'p1', name: 'local', settings: {} }],
      export: 'md',
      new_conversation_id: 'session_nueva_1',
      max_steps: 5,
      project_mode: false
    },
    submitResult: { text: 'Listo' },
    afterSubmitMessages: [{ role: 'user', content: 'Hola' }, { role: 'assistant', content: 'Listo' }]
  });
  assert.equal(ok.startedNew, 'session_nueva_1');
  assert.equal(ok.activated, 'p1');
  assert.equal(ok.submitted.opts.maxSteps, 5);
  assert.equal(Config.getActive().projectMode, false, '--run-file sin projectMode no inyecta las normas del proyecto');
  assert.deepEqual(ok.calls.find(c => c.method === 'zerochat/run/export')?.params, { run_id: 'run_test_id_123456', content: 'exported:md' });
  assert.deepEqual(ok.calls.find(c => c.method === 'zerochat/run/result')?.params, { run_id: 'run_test_id_123456', text: 'Listo' });

  // 2. Límite de pasos; projectMode true vuelve a inyectarlas.
  const limit = await runScenario({
    promptPayload: { prompt: 'Lee', new_conversation_id: 'session_lim', max_steps: 2, project_mode: true },
    submitResult: { limit: 'steps' },
    afterSubmitMessages: [{ role: 'user', content: 'Lee' }, { role: 'tool', content: '{}' }]
  });
  assert.deepEqual(limit.calls.find(c => c.method === 'zerochat/run/result')?.params, { run_id: 'run_test_id_123456', limit: 'steps' });
  assert.equal(Config.getActive().projectMode, true);

  // 3. Pausa por ask_user.
  const ask = await runScenario({
    promptPayload: { prompt: 'Pregunta', new_conversation_id: 'session_ask' },
    submitResult: { text: '' },
    afterSubmitMessages: [
      { role: 'user', content: 'Pregunta' },
      { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'ask_user', arguments: '{"question":"¿A o B?"}' } }] },
      { role: 'tool', tool_call_id: 'c1', name: 'ask_user', content: '{}' }
    ]
  });
  assert.deepEqual(ask.calls.find(c => c.method === 'zerochat/run/result')?.params, {
    run_id: 'run_test_id_123456', needs_input: { kind: 'ask_user', text: '¿A o B?' }
  });

  // 4. Reanudación de conversación pausada en tool_approval: retira el paso pendiente y vuelve a pausar si pide otro permiso.
  State.replaceMessages([
    { role: 'user', content: 'Haz algo' },
    { role: 'assistant', tool_calls: [{ id: 'c0', function: { name: 'write_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c0', name: 'write_file', content: JSON.stringify({ awaitingApproval: true }) }
  ]);
  const resume = await runScenario({
    promptPayload: { conversation_id: 'conv_resume' },
    submitResult: { text: '' },
    afterSubmitMessages: [
      { role: 'user', content: 'Haz algo' },
      { role: 'tool', name: 'run_command', content: JSON.stringify({ awaitingApproval: true }) }
    ]
  });
  assert.equal(resume.switched, 'conv_resume');
  assert.equal(resume.submitted.opts.resume, true);
  assert.deepEqual(resume.calls.find(c => c.method === 'zerochat/run/result')?.params, {
    run_id: 'run_test_id_123456', needs_input: { kind: 'tool_approval', text: 'run_command' }
  });
  assert.equal(closedCount, 4);
});
