const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ChatState = require('../../js/state.js');
const ChatConfig = require('../../js/config-store.js');
const AgentCore = require('../../js/agent-core.js');
const ToolSecurity = require('../../js/tool-security.js');
const MCP = require('../../js/mcp.js');
const ProjectContext = require('../../js/project-context.js');

// ProjectContext usa los singletons reales; el arnés sustituye solo lo que en Node no existe
// (servidor local, herramientas MCP) o lo que el caso fija (configuración, autorización).
test.afterEach(() => {
  mock.restoreAll();
  localStorage.clear();
});

function contextResponse(files, cwd, decide) {
  const helperPath = `${cwd}/.zerochat/task.py`;
  if (decide({ path: helperPath }) !== 'allow') return { status: 'denied' };
  const helper = files[helperPath];
  if (helper === undefined) return { status: 'missing' };
  if (helper instanceof Error) throw helper;
  if (typeof helper === 'object' && helper.success === false) return { status: 'error', error: helper.error };

  const statePath = `${cwd}/.zerochat/state.md`;
  if (decide({ path: statePath }) !== 'allow') return { status: 'denied' };
  const rawState = files[statePath];
  if (rawState instanceof Error) throw rawState;
  if (typeof rawState === 'object' && rawState.success === false) return { status: 'error', error: rawState.error };
  const toEntry = val => {
    if (!val) return { content: '', truncated: false };
    return typeof val === 'string' ? { content: val, truncated: false } : { content: val.content || '', truncated: Boolean(val.truncated) };
  };
  const rulesPath = `${cwd}/AGENTS.md`;
  const rawRules = decide({ path: rulesPath }) === 'allow' ? files[rulesPath] : null;
  return {
    status: 'ok',
    rules: rawRules && typeof rawRules === 'object' && rawRules.success === false ? { content: '', truncated: false } : toEntry(rawRules),
    state: toEntry(rawState)
  };
}

function mockTemplateFetch() {
  const templatesDir = path.resolve(__dirname, '../../templates/project');
  mock.method(globalThis, 'fetch', async url => {
    const prefix = 'templates/project/';
    if (!String(url).startsWith(prefix)) return { ok: false, status: 404, text: async () => '' };
    const filePath = path.join(templatesDir, String(url).slice(prefix.length));
    return { ok: true, status: 200, text: async () => fs.readFileSync(filePath, 'utf-8') };
  });
}

function createHarness({ config = {}, connected = true, cwd = '/repo', files = {}, approval = false, readTool = true, writeTool = true, directoryError = null, authorize = null, realSecurity = false, snapshot = null } = {}) {
  // Un caso puede crear varios arneses: se restaura antes para no apilar sustituciones.
  mock.restoreAll();
  mockTemplateFetch();
  ChatState.set('mcp', connected ? { status: 'connected', serverInfo: { cwd } } : { status: 'disconnected', serverInfo: null });
  ChatState.setProjectContext({ cwd: '', status: 'disabled' });
  MCP.manager.projectSnapshot = snapshot ? { cwd, data: snapshot } : null;
  mock.method(ChatConfig, 'getActive', () => ({ projectMode: true, projectDeclined: [], ...config }));
  const calls = [];
  mock.method(AgentCore.registry, 'getTool', name => {
    if (readTool && name === 'read_file') return { name: 'read_file', isAvailable: () => true };
    if (writeTool && name === 'write_file') return { name: 'write_file', isAvailable: () => true };
    return null;
  });
  const decide = authorize || (() => (approval ? 'ask' : 'allow'));
  mock.method(MCP.manager, 'requestExternalControl', async (method, params) => {
    calls.push({ method, params });
    if (method === 'zerochat/project/context') {
      return contextResponse(files, cwd, decide);
    }
    return {};
  });
  const security = ToolSecurity.manager;
  const rules = [];
  if (!realSecurity) {
    mock.method(security, 'addDirectoryRule', rule => { rules.push(rule); });
  }
  const directoryRequests = [];
  mock.method(MCP.manager, 'setProjectDirectory', async path => {
    directoryRequests.push(path);
    if (directoryError) throw new Error(directoryError);
    return { cwd: path, previous_cwd: cwd };
  });
  return { state: ChatState, context: ProjectContext, calls, security: { rules }, directoryRequests };
}

test('ProjectContext.refresh - estados previos (desactivado, sin servidor o read_file, rechazado, missing, no_access)', async () => {
  const disabled = createHarness({ config: { projectMode: false } });
  await disabled.context.refresh();
  assert.equal(disabled.state.get('project').status, 'disabled');
  assert.equal(disabled.calls.length, 0);

  const offline = createHarness({ connected: false });
  await offline.context.refresh();
  assert.equal(offline.state.get('project').status, 'unavailable');

  const noTool = createHarness({ readTool: false });
  await noTool.context.refresh();
  assert.equal(noTool.state.get('project').status, 'unavailable');
  assert.equal(noTool.calls.length, 0);

  const declined = createHarness({ config: { projectDeclined: ['/repo'] } });
  await declined.context.refresh();
  assert.equal(declined.state.get('project').status, 'declined');
  assert.equal(declined.calls.length, 0);

  const ask = createHarness({ approval: true, files: { '/repo/.zerochat/task.py': 'helper' } });
  await ask.context.refresh();
  assert.equal(ask.state.get('project').status, 'no_access');
  assert.equal(ask.calls.length, 1);

  const missing = createHarness();
  await missing.context.refresh();
  assert.equal(missing.state.get('project').status, 'missing');
  assert.equal(missing.state.get('project').cwd, '/repo');
});

test('ProjectContext.refresh - lee normas y estado en una sola llamada zerochat/project/context, o usa la instantánea de initialize/set_directory', async () => {
  const { context, calls, state } = createHarness({
    files: {
      '/repo/.zerochat/task.py': '# helper',
      '/repo/AGENTS.md': { success: true, content: '# Rules', truncated: true },
      '/repo/.zerochat/state.md': '- Next task: M1-T2 tests'
    }
  });
  await context.refresh();
  const project = state.get('project');
  assert.equal(project.status, 'ready');
  assert.deepEqual(project.rules, { content: '# Rules', truncated: true });
  assert.deepEqual(project.state, { content: '- Next task: M1-T2 tests', truncated: false });
  assert.deepEqual(calls, [{ method: 'zerochat/project/context', params: {} }]);
  assert.match(ProjectContext.buildPromptBlock(project), /- Next task: M1-T2 tests/);

  // Si initialize o set_directory entregó la instantánea del proyecto, refresh la consume sin llamar por red
  const fromSnapshot = createHarness({
    snapshot: {
      status: 'ok',
      rules: { content: '# Rules from init', truncated: false },
      state: { content: '- Next task: M1-T3', truncated: false }
    }
  });
  await fromSnapshot.context.refresh();
  assert.equal(fromSnapshot.calls.length, 0);
  assert.equal(fromSnapshot.state.get('project').rules.content, '# Rules from init');
});

test('ProjectContext.refresh - sin AGENTS.md el proyecto sigue activo y el bloque pide crearlo', async () => {
  const { context, state } = createHarness({ files: { '/repo/.zerochat/task.py': 'helper', '/repo/.zerochat/state.md': 'state' } });
  await context.refresh();
  const project = state.get('project');
  assert.equal(project.status, 'ready');
  assert.equal(project.rules.content, '');
  assert.match(ProjectContext.buildPromptBlock(project), /AGENTS\.md does not exist/);
});

test('ProjectContext.refresh - si la lectura de state.md falla, es denegada o queda unavailable, no publica estado listo', async (t) => {
  t.mock.method(console, 'warn', () => {});
  // Error en state.md
  const harnessErr = createHarness({
    files: {
      '/repo/.zerochat/task.py': 'helper',
      '/repo/.zerochat/state.md': { success: false, error: 'Disk read error' },
      '/repo/AGENTS.md': 'rules'
    }
  });
  await harnessErr.context.refresh();
  assert.equal(harnessErr.state.get('project').status, 'error');
  assert.equal(harnessErr.calls.length, 1);

  // Denegado en state.md
  const harnessDenied = createHarness({
    files: {
      '/repo/.zerochat/task.py': 'helper',
      '/repo/.zerochat/state.md': 'state',
      '/repo/AGENTS.md': 'rules'
    },
    authorize: args => (args.path.endsWith('state.md') ? 'deny' : 'allow')
  });
  await harnessDenied.context.refresh();
  assert.equal(harnessDenied.state.get('project').status, 'no_access');
  assert.equal(harnessDenied.calls.length, 1);

  // Unavailable al terminar la petición
  let availableQueries = 0;
  const toolDynamic = {
    name: 'read_file',
    isAvailable: () => {
      availableQueries++;
      return availableQueries <= 1;
    }
  };
  const harnessUnavail = createHarness({
    files: {
      '/repo/.zerochat/task.py': 'helper',
      '/repo/.zerochat/state.md': 'state',
      '/repo/AGENTS.md': 'rules'
    }
  });
  mock.method(AgentCore.registry, 'getTool', name => (name === 'read_file' ? toolDynamic : null));
  await harnessUnavail.context.refresh();
  assert.equal(harnessUnavail.state.get('project').status, 'unavailable');

  // Fallo de transporte y fallo de lectura en .zerochat/task.py quedan en estado error
  for (const taskFile of [{ success: false, error: 'Permission denied' }, new Error('connection reset')]) {
    const errHarness = createHarness({ files: { '/repo/.zerochat/task.py': taskFile } });
    await errHarness.context.refresh();
    assert.equal(errHarness.state.get('project').status, 'error');
    assert.equal(errHarness.state.get('project').error, taskFile.error || taskFile.message);
  }
});

test('ProjectContext.refresh - solo publica el resultado de la llamada más reciente', async () => {
  const harness = createHarness({ files: { '/repo/.zerochat/task.py': 'helper' } });
  const first = harness.context.refresh();
  harness.state.set('mcp', { status: 'disconnected', serverInfo: null });
  const second = harness.context.refresh();
  await Promise.all([first, second]);
  assert.equal(harness.state.get('project').status, 'unavailable');
});

function initCallbacks({ accept = true, onConfirm } = {}) {
  const log = { prompts: [], confirms: [], conversations: 0 };
  return {
    log,
    callbacks: {
      askConfirmation: async details => { log.confirms.push(details); await onConfirm?.(); return accept; },
      startConversation: async () => { log.conversations++; },
      sendPrompt: async prompt => { log.prompts.push(prompt); },
      isBusy: () => false
    }
  };
}

test('ProjectContext.initialize - tras confirmar concede solo .zerochat y envía el arranque', async () => {
  const { context, state, security } = createHarness();
  await context.refresh();
  assert.equal(state.get('project').status, 'missing');
  assert.equal(context.canInitialize(), true);

  const { log, callbacks } = initCallbacks();
  const result = await context.initialize(callbacks);
  assert.deepEqual(result, { ok: true, rule: 'RW:/repo/.zerochat' });
  assert.deepEqual(security.rules, ['RW:/repo/.zerochat']);
  assert.deepEqual(log.confirms, [{ cwd: '/repo', rule: 'RW:/repo/.zerochat' }]);
  assert.equal(log.conversations, 1);
  assert.equal(log.prompts.length, 1);
  assert.match(log.prompts[0], /^Use (Spanish|English) for all messages to the user/);
  assert.match(log.prompts[0], /git init/);
  assert.match(log.prompts[0], /directory at \/repo/);

  const agentHarness = createHarness();
  await agentHarness.context.refresh();
  const agentInit = initCallbacks();
  const agentResult = await agentHarness.context.initialize({ ...agentInit.callbacks, template: 'agent' });
  assert.deepEqual(agentResult, { ok: true, rule: 'RW:/repo/.zerochat' });
  assert.equal(agentInit.log.prompts.length, 1);
  assert.match(agentInit.log.prompts[0], /^Use (Spanish|English) for all messages to the user/);
  assert.match(agentInit.log.prompts[0], /Initialize project mode for the directory at \/repo/);
  assert.match(agentInit.log.prompts[0], /zerochat --run-file/);
  assert.match(agentInit.log.prompts[0], /agents\/template\.sh/);
});

test('ProjectContext.initialize - cancelar, cambiar de estado o sin herramientas/missing no concede permisos', async () => {
  const { context, security } = createHarness();
  await context.refresh();
  const { log, callbacks } = initCallbacks({ accept: false });
  assert.deepEqual(await context.initialize(callbacks), { ok: false, reason: 'cancelled' });
  assert.deepEqual(security.rules, []);
  assert.equal(log.prompts.length, 0);

  const changed = createHarness();
  await changed.context.refresh();
  const { log: log2, callbacks: cb2 } = initCallbacks({ onConfirm: () => changed.state.setProjectContext({ cwd: '/other' }) });
  assert.deepEqual(await changed.context.initialize(cb2), { ok: false, reason: 'state-changed' });
  assert.deepEqual(changed.security.rules, []);
  assert.equal(log2.prompts.length, 0);

  const noWrite = createHarness({ writeTool: false });
  await noWrite.context.refresh();
  assert.equal(noWrite.context.canInitialize(), false);
  const first = initCallbacks();
  assert.deepEqual(await noWrite.context.initialize(first.callbacks), { ok: false, reason: 'unavailable' });
  assert.equal(first.log.confirms.length, 0);

  const ready = createHarness({ files: { '/repo/.zerochat/task.py': 'helper' } });
  await ready.context.refresh();
  const second = initCallbacks();
  assert.deepEqual(await ready.context.initialize(second.callbacks), { ok: false, reason: 'unavailable' });
  assert.equal(second.log.confirms.length, 0);
});

test('ProjectContext.initialize - registra la regla real para permitir escribir en .zerochat', async () => {
  const manager = ToolSecurity.manager;
  const mockClient = {
    async request(method, params) {
      if (method === 'zerochat/security/update') {
        return { policies: { directoryRules: params.addDirectoryRules || [] } };
      }
      return {};
    }
  };
  manager.setMcpClient(mockClient);
  manager.applyPolicies({ directoryRules: [] });
  const { context } = createHarness({ realSecurity: true });
  await context.refresh();
  const result = await context.initialize(initCallbacks().callbacks);
  assert.equal(result.ok, true);
  assert.ok(manager.getDirectoryRules().includes('RW:/repo/.zerochat'));
});


test('ProjectContext.changeDirectory - pide el directorio al servidor y respeta cancelación, cambio de estado o indisponibilidad', async () => {
  const { context, directoryRequests } = createHarness();
  assert.equal(context.canChangeDirectory(), true);
  const asked = [];
  assert.deepEqual(await context.changeDirectory({ askPath: cwd => { asked.push(cwd); return '  /other  '; } }), { ok: true, cwd: '/other' });
  assert.deepEqual(asked, ['/repo']);
  assert.deepEqual(directoryRequests, ['/other']);

  const cancelled = createHarness();
  assert.deepEqual(await cancelled.context.changeDirectory({ askPath: () => null }), { ok: false, reason: 'cancelled' });
  assert.deepEqual(await cancelled.context.changeDirectory({ askPath: () => '/repo' }), { ok: false, reason: 'cancelled' });
  assert.equal(cancelled.directoryRequests.length, 0);

  const moved = createHarness();
  const askPath = () => { moved.state.set('mcp', { status: 'connected', serverInfo: { cwd: '/elsewhere' } }); return '/other'; };
  assert.deepEqual(await moved.context.changeDirectory({ askPath }), { ok: false, reason: 'state-changed' });
  let busy = false;
  assert.deepEqual(await moved.context.changeDirectory({ askPath: () => { busy = true; return '/other'; }, isBusy: () => busy }), { ok: false, reason: 'state-changed' });
  assert.equal(moved.directoryRequests.length, 0);

  const neverAsk = () => { throw new Error('no debe preguntar'); };
  const offline = createHarness({ connected: false });
  assert.equal(offline.context.canChangeDirectory(), false);
  assert.deepEqual(await offline.context.changeDirectory({ askPath: neverAsk }), { ok: false, reason: 'unavailable' });
  const busyH = createHarness();
  assert.deepEqual(await busyH.context.changeDirectory({ askPath: neverAsk, isBusy: () => true }), { ok: false, reason: 'unavailable' });
  await assert.rejects(() => busyH.context.changeDirectory({}), TypeError);
});

test('ProjectContext.compact - lanza el prompt tras confirmación y respeta cancelación, cambio de estado o indisponibilidad', async () => {
  const { state, context } = createHarness();
  state.setProjectContext({ status: 'ready', cwd: '/repo' });
  assert.equal(context.canCompact(), true);

  const confirmations = [];
  const prompts = [];
  let conversationStarted = false;
  const result = await context.compact({
    askConfirmation: details => { confirmations.push(details); return true; },
    startConversation: () => { conversationStarted = true; },
    sendPrompt: prompt => { prompts.push(prompt); }
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(confirmations, [{ cwd: '/repo', name: 'repo' }]);
  assert.equal(conversationStarted, true);
  assert.match(prompts[0], /Perform project memory housekeeping/);

  assert.deepEqual(await context.compact({ askConfirmation: () => false, sendPrompt: () => { throw new Error('no debe enviar'); } }), { ok: false, reason: 'cancelled' });
  let busy = false;
  assert.deepEqual(await context.compact({ askConfirmation: () => { busy = true; return true; }, isBusy: () => busy, sendPrompt: () => { throw new Error('no debe enviar'); } }), { ok: false, reason: 'state-changed' });

  const noWrite = createHarness({ writeTool: false });
  noWrite.state.setProjectContext({ status: 'ready', cwd: '/repo' });
  assert.equal(noWrite.context.canCompact(), false);
  assert.deepEqual(await noWrite.context.compact({ askConfirmation: () => true, sendPrompt: () => {} }), { ok: false, reason: 'unavailable' });
  const notReady = createHarness();
  notReady.state.setProjectContext({ status: 'missing', cwd: '/repo' });
  assert.deepEqual(await notReady.context.compact({ askConfirmation: () => true, sendPrompt: () => {} }), { ok: false, reason: 'unavailable' });
});
