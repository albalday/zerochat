const test = require('node:test');
const assert = require('node:assert/strict');
const RunNode = require('../../js/run-node.js');
const RunMode = require('../../js/run-mode.js');
const MCP = require('../../js/mcp.js');
const ToolSecurity = require('../../js/tool-security.js');
const State = require('../../js/state.js');
const Engine = require('../../js/chat-engine.js');

test('RunNode - parseRunArgs extrae parámetros desde URL con fragmento', () => {
  const url = 'http://127.0.0.1:9090/zerochat.html#token=sec_tok&host=127.0.0.2&port=9090&run=run_xyz';
  const parsed = RunNode.parseRunArgs([url]);

  assert.equal(parsed.host, '127.0.0.2');
  assert.equal(parsed.port, 9090);
  assert.equal(parsed.token, 'sec_tok');
  assert.equal(parsed.runId, 'run_xyz');
});

test('RunNode - parseRunArgs extrae parámetros desde flags CLI independientes', () => {
  const flags = ['--host', 'localhost', '--port', '4545', '--token', 'tok_abc', '--run', 'run_123'];
  const parsed = RunNode.parseRunArgs(flags);

  assert.equal(parsed.host, 'localhost');
  assert.equal(parsed.port, 4545);
  assert.equal(parsed.token, 'tok_abc');
  assert.equal(parsed.runId, 'run_123');
});

test('RunNode - parseRunArgs soporta flag --url y fragmento directo', () => {
  const fromFlag = RunNode.parseRunArgs(['--url', 'http://127.0.0.1:3000/#token=t1&port=3000&run=r1']);
  assert.equal(fromFlag.port, 3000);
  assert.equal(fromFlag.token, 't1');
  assert.equal(fromFlag.runId, 'r1');

  const fromHash = RunNode.parseRunArgs(['#token=t2&port=3001&run=r2&host=127.0.0.3']);
  assert.equal(fromHash.host, '127.0.0.3');
  assert.equal(fromHash.port, 3001);
  assert.equal(fromHash.token, 't2');
  assert.equal(fromHash.runId, 'r2');
});

test('RunNode - parseRunArgs usa host por defecto cuando no se especifica', () => {
  const parsed = RunNode.parseRunArgs(['--port', '8080', '--token', 't', '--run', 'r']);
  assert.equal(parsed.host, '127.0.0.1');
  assert.equal(parsed.port, 8080);
});

test('RunNode - startHeadlessRun rechaza parámetros incompletos', async () => {
  await assert.rejects(
    () => RunNode.startHeadlessRun([]),
    /Missing required run parameters/
  );
  await assert.rejects(
    () => RunNode.startHeadlessRun(['--port', '8080']),
    /Missing required run parameters/
  );
});

test('RunNode - startHeadlessRun orquesta la conexión y arranca RunMode', async t => {
  let connectCalled = false;
  let runModeStartCalled = false;
  let receivedRunId = null;

  t.mock.method(MCP.manager, 'connectProxy', async options => {
    connectCalled = true;
    assert.equal(options.url, 'http://127.0.0.1:8181/');
    assert.equal(options.token, 'test_token');
    return { success: true };
  });

  t.mock.method(ToolSecurity.manager, 'setSessionToken', token => {
    assert.equal(token, 'test_token');
  });

  t.mock.method(RunMode, 'start', async (runId, options) => {
    runModeStartCalled = true;
    receivedRunId = runId;
    assert.equal(typeof options.connectBackend, 'function');
    assert.equal(typeof options.activateSessionProfile, 'function');
    assert.equal(typeof options.submitComposerText, 'function');
    assert.equal(typeof options.stopGeneration, 'function');
    assert.equal(typeof options.exportConversation, 'function');
    assert.equal(typeof options.switchToSession, 'function');
    const conn = await options.startupConnection;
    assert.equal(conn.success, true);
    return { ok: true };
  });

  const result = await RunNode.startHeadlessRun([
    '--host', '127.0.0.1',
    '--port', '8181',
    '--token', 'test_token',
    '--run', 'run_target_id'
  ]);

  assert.equal(connectCalled, true);
  assert.equal(runModeStartCalled, true);
  assert.equal(receivedRunId, 'run_target_id');
  assert.deepEqual(result, { ok: true });
});

test('RunNode - herramientas excluidas de Node se declaran no disponibles y devuelven error limpio al ejecutarse', async () => {
  const disabledToolGlobals = [
    'ChatBuiltinRenderChartTool',
    'ChatBuiltinListDocumentsTool',
    'ChatBuiltinSearchKnowledgeBaseTool',
    'ChatBuiltinReadKnowledgeChunkTool',
    'ChatBuiltinReadKnowledgeImageTool'
  ];

  for (const globalName of disabledToolGlobals) {
    const tool = globalThis[globalName];
    assert.ok(tool, `${globalName} debe estar registrado en globalThis`);
    assert.equal(tool.isAvailable(), false, `${globalName} debe declarar isAvailable() === false`);
    assert.equal(tool.settings.showInSettings, false);
    const res = await tool.execute();
    assert.equal(res.error, 'Tool not supported in headless environment');
  }
});

test('RunNode - execute_javascript y ChatSandbox están habilitados y ejecutan cálculos en Node', async () => {
  const tool = globalThis.ChatBuiltinExecuteJavascriptTool;
  assert.ok(tool, 'ChatBuiltinExecuteJavascriptTool debe estar registrado');
  assert.equal(tool.definition.name, 'execute_javascript');
  assert.ok(globalThis.ChatSandbox, 'ChatSandbox debe estar registrado');

  const context = {
    services: {
      sandbox: globalThis.ChatSandbox
    }
  };
  const execRes = await tool.execute({ code: 'return 19 + 23;' }, context);
  assert.equal(execRes.success, true);
  assert.equal(execRes.result, '42');
  assert.equal(tool.result.toModel({ code: 'return 19 + 23;' }, execRes), '42');
});

test('RunNode - ChatCommandCard está registrado en globalThis y parseResult extrae estado de run_command', () => {
  assert.ok(globalThis.ChatCommandCard, 'ChatCommandCard debe estar registrado para el descubrimiento de run_command');
  const view = globalThis.ChatCommandCard.createView();
  assert.equal(typeof view.createLiveCard, 'function');
  assert.equal(typeof view.renderHistoryCard, 'function');

  assert.equal(globalThis.ChatCommandCard.parseResult(null), null);
  assert.equal(globalThis.ChatCommandCard.parseResult('not-json'), null);
  assert.deepEqual(globalThis.ChatCommandCard.parseResult('{"status": "running", "job_id": 12}'), { status: 'running', job_id: 12 });
  assert.equal(globalThis.ChatCommandCard.isFailure({ status: 'exited', exitCode: 1 }), true);
  assert.equal(globalThis.ChatCommandCard.isFailure({ status: 'exited', exitCode: 0 }), false);
});

test('RunNode - switchToSession y submitComposerText preservan serverRun, profileId y extra', async t => {
  let capturedOptions = null;
  t.mock.method(MCP.manager, 'connectProxy', async () => ({ success: true }));
  t.mock.method(ToolSecurity.manager, 'setSessionToken', () => {});
  t.mock.method(RunMode, 'start', async (_runId, opts) => {
    capturedOptions = opts;
    return { ok: true };
  });

  await RunNode.startHeadlessRun([
    '--port', '8282',
    '--token', 'test_tok',
    '--run', 'run_preserve_test'
  ]);

  assert.ok(capturedOptions);

  let savedPayload = null;
  t.mock.method(MCP.manager, 'requestExternalControl', async (method, params) => {
    if (method === 'zerochat/conversations/get') {
      return {
        conversation: {
          id: 'conv_server_preserve',
          title: 'Charla persistente',
          createdAt: 1000,
          updatedAt: 2000,
          profileId: 'perfil_remoto',
          serverRun: true,
          extra: { server_run: true, profile_id: 'perfil_remoto' }
        }
      };
    }
    if (method === 'zerochat/conversations/save') {
      savedPayload = params;
      return { success: true };
    }
    return null;
  });

  await capturedOptions.switchToSession('conv_server_preserve');
  const sessionEntry = State.get('sessions')?.list?.find(s => s.id === 'conv_server_preserve');
  assert.ok(sessionEntry);
  assert.equal(sessionEntry.serverRun, true);
  assert.equal(sessionEntry.profileId, 'perfil_remoto');
  assert.equal(sessionEntry.extra?.server_run, true);

  t.mock.method(Engine, 'executeAgentTurnLoop', async () => {
    return {
      chatHistory: [{ id: 'm1', role: 'user', content: 'test' }, { id: 'm2', role: 'assistant', content: 'ok' }],
      finalAssistantText: 'ok'
    };
  });

  await capturedOptions.submitComposerText('test', { resume: true });
  assert.ok(savedPayload);
  assert.equal(savedPayload.conversation.id, 'conv_server_preserve');
  assert.equal(savedPayload.conversation.serverRun, true);
  assert.equal(savedPayload.conversation.profileId, 'perfil_remoto');
  assert.equal(savedPayload.conversation.extra?.server_run, true);
});


