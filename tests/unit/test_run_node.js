const test = require('node:test');
const assert = require('node:assert/strict');
const RunNode = require('../../js/run-node.js');
const RunMode = require('../../js/run-mode.js');
const MCP = require('../../js/mcp.js');
const ToolSecurity = require('../../js/tool-security.js');
const State = require('../../js/state.js');
const Engine = require('../../js/chat-engine.js');

test('RunNode - parseRunArgs extrae parámetros desde URL, --url, fragmento y flags con host por defecto', () => {
  assert.deepEqual(
    RunNode.parseRunArgs(['http://127.0.0.1:9090/zerochat.html#token=sec_tok&host=127.0.0.2&port=9090&run=run_xyz']),
    { host: '127.0.0.2', port: 9090, token: 'sec_tok', runId: 'run_xyz' }
  );
  assert.deepEqual(
    RunNode.parseRunArgs(['--host', 'localhost', '--port', '4545', '--token', 'tok_abc', '--run', 'run_123']),
    { host: 'localhost', port: 4545, token: 'tok_abc', runId: 'run_123' }
  );
  const fromFlag = RunNode.parseRunArgs(['--url', 'http://127.0.0.1:3000/#token=t1&port=3000&run=r1']);
  assert.deepEqual([fromFlag.port, fromFlag.token, fromFlag.runId], [3000, 't1', 'r1']);
  const fromHash = RunNode.parseRunArgs(['#token=t2&port=3001&run=r2&host=127.0.0.3']);
  assert.deepEqual([fromHash.host, fromHash.port, fromHash.token, fromHash.runId], ['127.0.0.3', 3001, 't2', 'r2']);
  const withDefaultHost = RunNode.parseRunArgs(['--port', '8080', '--token', 't', '--run', 'r']);
  assert.deepEqual([withDefaultHost.host, withDefaultHost.port], ['127.0.0.1', 8080]);
});

test('RunNode - startHeadlessRun valida parámetros y orquesta la conexión con RunMode', async t => {
  await assert.rejects(() => RunNode.startHeadlessRun([]), /Missing required run parameters/);
  await assert.rejects(() => RunNode.startHeadlessRun(['--port', '8080']), /Missing required run parameters/);

  let connectCalled = false;
  let receivedRunId = null;
  t.mock.method(MCP.manager, 'connectProxy', async options => {
    connectCalled = true;
    assert.equal(options.url, 'http://127.0.0.1:8181/');
    assert.equal(options.token, 'test_token');
    return { success: true };
  });
  t.mock.method(RunMode, 'start', async (runId, options) => {
    receivedRunId = runId;
    for (const fn of ['connectBackend', 'activateSessionProfile', 'submitComposerText', 'exportConversation', 'switchToSession', 'startNewSession']) {
      assert.equal(typeof options[fn], 'function');
    }
    assert.equal((await options.startupConnection).success, true);
    return { ok: true };
  });

  const result = await RunNode.startHeadlessRun(['--host', '127.0.0.1', '--port', '8181', '--token', 'test_token', '--run', 'run_target_id']);
  assert.equal(connectCalled, true);
  assert.equal(receivedRunId, 'run_target_id');
  assert.deepEqual(result, { ok: true });
});

test('RunNode - expone herramientas/tarjetas de Node e inhabilita las de UI/conocimiento', async () => {
  for (const globalName of [
    'ChatBuiltinListDocumentsTool', 'ChatBuiltinSearchKnowledgeBaseTool', 'ChatBuiltinReadKnowledgeChunkTool',
    'ChatBuiltinReadKnowledgeImageTool', 'ChatBuiltinWaitTool'
  ]) {
    const tool = globalThis[globalName];
    assert.ok(tool, `${globalName} debe estar registrado en globalThis`);
    assert.equal(tool.isAvailable(), false);
    assert.equal(tool.settings.showInSettings, false);
    assert.equal((await tool.execute()).error, 'Tool not supported in headless environment');
  }

  const chartTool = globalThis.ChatBuiltinRenderChartTool;
  const chartArgs = { type: 'bar', title: 'Ventas trimestrales', labels: ['Q1'], datasets: [{ label: '2026', data: [100] }] };
  const chartRes = await chartTool.execute(chartArgs);
  assert.deepEqual(chartRes, { success: true, type: 'bar', title: 'Ventas trimestrales' });
  assert.match(chartTool.result.toMarkdown(chartArgs, chartRes), /render_chart[\s\S]*Ventas trimestrales/);

  const jsTool = globalThis.ChatBuiltinExecuteJavascriptTool;
  const jsRes = await jsTool.execute({ code: 'return 19 + 23;' }, { services: { sandbox: globalThis.ChatSandbox } });
  assert.equal(jsTool.result.toModel({ code: 'return 19 + 23;' }, jsRes), '42');

  const view = globalThis.ChatCommandCard.createView();
  assert.equal(typeof view.createLiveCard, 'function');
  assert.equal(typeof view.renderHistoryCard, 'function');
  assert.deepEqual(globalThis.ChatCommandCard.parseResult('{"status": "running", "job_id": 12}'), { status: 'running', job_id: 12 });
  assert.equal(globalThis.ChatCommandCard.isFailure({ status: 'exited', exitCode: 1 }), true);
  assert.equal(globalThis.ChatCommandCard.isFailure({ status: 'exited', exitCode: 0 }), false);
});

test('RunNode - switchToSession y submitComposerText preservan serverRun y profileId', async t => {
  let capturedOptions = null;
  t.mock.method(MCP.manager, 'connectProxy', async () => ({ success: true }));
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
          project: '/repo/demo',
          serverRun: true
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
  assert.equal(sessionEntry.project, '/repo/demo');

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
});

test('RunNode - startNewSession guarda project, title y createdAt del proyecto conectado y omite general', async t => {
  let capturedOptions = null;
  t.mock.method(MCP.manager, 'connectProxy', async () => ({ success: true }));
  t.mock.method(RunMode, 'start', async (_runId, opts) => {
    capturedOptions = opts;
    return { ok: true };
  });

  await RunNode.startHeadlessRun([
    '--port', '8283',
    '--token', 'test_tok',
    '--run', 'run_new_session_project'
  ]);

  const savedPayloads = [];
  t.mock.method(MCP.manager, 'requestExternalControl', async (method, params) => {
    if (method === 'zerochat/conversations/save') savedPayloads.push(params);
    return { success: true };
  });
  t.mock.method(Engine, 'executeAgentTurnLoop', async ({ chatHistory }) => ({
    chatHistory: [...chatHistory, { id: 'm2', role: 'assistant', content: 'ok' }],
    finalAssistantText: 'ok'
  }));

  State.set('mcp', { status: 'connected', serverInfo: { cwd: '/repo/proyecto-a', noProjectDir: '/home/u/zerochat/general' } });
  t.after(() => State.set('mcp', { status: 'disconnected', serverInfo: null }));
  capturedOptions.startNewSession('session_prompt_proj');
  await capturedOptions.submitComposerText('Revisa el estado del repo');

  assert.equal(savedPayloads[0].conversation.id, 'session_prompt_proj');
  assert.equal(savedPayloads[0].conversation.project, '/repo/proyecto-a');
  assert.equal(savedPayloads[0].conversation.title, 'Revisa el estado del repo');
  assert.equal(typeof savedPayloads[0].conversation.createdAt, 'number');

  State.set('mcp', { status: 'connected', serverInfo: { cwd: '/home/u/zerochat/general', noProjectDir: '/home/u/zerochat/general' } });
  capturedOptions.startNewSession('session_prompt_general');
  await capturedOptions.submitComposerText('Hola en general');

  assert.equal(savedPayloads[1].conversation.id, 'session_prompt_general');
  assert.equal('project' in savedPayloads[1].conversation, false);
});



test('RunNode - submitComposerText pasa al bucle la carpeta del proyecto y, con projectMode, sus normas y estado como la interfaz', async t => {
  const ProjectContext = require('../../js/project-context.js');
  const Config = require('../../js/config-store.js');
  let capturedOptions = null;
  t.mock.method(MCP.manager, 'connectProxy', async () => ({ success: true }));
  t.mock.method(RunMode, 'start', async (_runId, opts) => {
    capturedOptions = opts;
    return { ok: true };
  });
  await RunNode.startHeadlessRun(['--port', '8284', '--token', 'test_tok', '--run', 'run_project_context']);

  t.mock.method(MCP.manager, 'requestExternalControl', async () => ({ success: true }));
  const project = { cwd: '/repo/proyecto-b', status: 'ready', rules: { content: 'Normas', truncated: false }, state: { content: 'Estado', truncated: false } };
  const refresh = t.mock.method(ProjectContext, 'refresh', async () => {
    State.setProjectContext(project);
    return project;
  });
  const loops = [];
  t.mock.method(Engine, 'executeAgentTurnLoop', async params => {
    loops.push({ projectContext: params.projectContext, projectDirectory: params.projectDirectory });
    return { chatHistory: [...params.chatHistory, { id: 'a', role: 'assistant', content: 'ok' }], finalAssistantText: 'ok' };
  });
  State.set('mcp', { status: 'connected', serverInfo: { cwd: '/repo/proyecto-b', noProjectDir: '/home/u/zerochat/general' } });
  const previousProjectMode = Config.getActive().projectMode;
  t.after(() => {
    State.set('mcp', { status: 'disconnected', serverInfo: null });
    Config.updateRuntime({ projectMode: previousProjectMode });
  });

  Config.updateRuntime({ projectMode: false });
  capturedOptions.startNewSession('session_sin_modo');
  await capturedOptions.submitComposerText('Sin modo proyecto');
  Config.updateRuntime({ projectMode: true });
  capturedOptions.startNewSession('session_con_modo');
  await capturedOptions.submitComposerText('Con modo proyecto');

  assert.equal(refresh.mock.callCount(), 1, 'Solo con projectMode lee las normas y el estado antes del turno');
  assert.deepEqual(loops[0], { projectContext: null, projectDirectory: '/repo/proyecto-b' });
  assert.equal(loops[1].projectDirectory, '/repo/proyecto-b');
  assert.equal(loops[1].projectContext.rules.content, 'Normas');
  assert.equal(loops[1].projectContext.state.content, 'Estado');
});
