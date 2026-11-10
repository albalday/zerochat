const test = require('node:test');
const assert = require('node:assert/strict');
const RunNode = require('../../js/run-node.js');
const RunMode = require('../../js/run-mode.js');
const MCP = require('../../js/mcp.js');
const ToolSecurity = require('../../js/tool-security.js');

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
    'ChatBuiltinExecuteJavascriptTool',
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

  assert.ok(globalThis.ChatSandbox);
  const sandboxRes = await globalThis.ChatSandbox.execute();
  assert.equal(sandboxRes.error, 'Sandbox not supported in headless environment');
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


