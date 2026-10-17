const { test } = require('node:test');
const assert = require('node:assert/strict');
const ChatState = require('../../js/state.js');
const ProjectContext = require('../../js/project-context.js');

function createHarness({ config = {}, connected = true, cwd = '/repo', files = {}, approval = false, readTool = true, writeTool = true, directoryTool = false, directoryError = null, security: securityOverride = null } = {}) {
  const state = ChatState.createStore();
  if (connected) state.set('mcp', { status: 'connected', serverInfo: { cwd } });
  const calls = [];
  const tool = { name: 'read_file', isAvailable: () => true };
  const agentCore = {
    registry: {
      getTool: name => {
        if (readTool && name === 'read_file') return tool;
        if (writeTool && name === 'write_file') return { name: 'write_file', isAvailable: () => true };
        return null;
      }
    },
    executor: {
      async executeToolCall(call) {
        const args = JSON.parse(call.function.arguments);
        calls.push(args);
        const file = files[args.path];
        if (file instanceof Error) return { success: false, error: file.message, result: null };
        const payload = file === undefined
          ? { success: false, error: `File '${args.path}' does not exist.` }
          : (typeof file === 'string' ? { success: true, content: file, truncated: false } : file);
        // Igual que McpToolProvider con el servidor local: success: false del JSON llega como isError.
        const ok = payload.success !== false;
        return { success: ok, result: { success: ok, isError: !ok, content: JSON.stringify(payload) } };
      }
    }
  };
  const security = securityOverride || {
    rules: [],
    evaluateAuthorization: () => (approval ? { status: 'ask', requiresApproval: true } : { status: 'allow', requiresApproval: false }),
    addDirectoryRule(rule) { this.rules.push(rule); }
  };
  const directoryRequests = [];
  const mcp = directoryTool ? {
    async setProjectDirectory(path) {
      directoryRequests.push(path);
      if (directoryError) throw new Error(directoryError);
      return { cwd: path, previous_cwd: cwd };
    }
  } : {};
  const context = ProjectContext.createProjectContext({
    state,
    config: { getActive: () => ({ projectMode: true, projectDeclined: [], ...config }) },
    agentCore,
    security,
    mcp
  });
  return { state, context, calls, security, directoryRequests };
}

test('ProjectContext.refresh - desactivado no lee ficheros', async () => {
  const { context, calls, state } = createHarness({ config: { projectMode: false } });
  await context.refresh();
  assert.equal(state.get('project').status, 'disabled');
  assert.equal(calls.length, 0);
});

test('ProjectContext.refresh - sin servidor local o sin read_file queda unavailable', async () => {
  const offline = createHarness({ connected: false });
  await offline.context.refresh();
  assert.equal(offline.state.get('project').status, 'unavailable');

  const noTool = createHarness({ readTool: false });
  await noTool.context.refresh();
  assert.equal(noTool.state.get('project').status, 'unavailable');
  assert.equal(noTool.calls.length, 0);
});

test('ProjectContext.refresh - un proyecto rechazado no se lee', async () => {
  const { context, calls, state } = createHarness({ config: { projectDeclined: ['/repo'] } });
  await context.refresh();
  assert.equal(state.get('project').status, 'declined');
  assert.equal(calls.length, 0);
});

test('ProjectContext.refresh - si la política exige aprobación no ejecuta ni pregunta', async () => {
  const { context, calls, state } = createHarness({ approval: true, files: { '/repo/.zerochat/task.py': 'helper' } });
  await context.refresh();
  assert.equal(state.get('project').status, 'no_access');
  assert.equal(calls.length, 0);
});

test('ProjectContext.refresh - sin .zerochat/task.py queda missing', async () => {
  const { context, state } = createHarness();
  await context.refresh();
  assert.equal(state.get('project').status, 'missing');
  assert.equal(state.get('project').cwd, '/repo');
});

test('ProjectContext.refresh - lee normas y estado con límite de tamaño', async () => {
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
  assert.deepEqual(calls.map(args => [args.path, args.max_bytes]), [
    ['/repo/.zerochat/task.py', ProjectContext.MAX_FILE_BYTES],
    ['/repo/.zerochat/state.md', ProjectContext.MAX_FILE_BYTES],
    ['/repo/AGENTS.md', ProjectContext.MAX_FILE_BYTES]
  ]);
  assert.match(ProjectContext.buildPromptBlock(project), /- Next task: M1-T2 tests/);
});

test('ProjectContext.refresh - sin AGENTS.md el proyecto sigue activo y el bloque pide crearlo', async () => {
  const { context, state } = createHarness({ files: { '/repo/.zerochat/task.py': 'helper', '/repo/.zerochat/state.md': 'state' } });
  await context.refresh();
  const project = state.get('project');
  assert.equal(project.status, 'ready');
  assert.equal(project.rules.content, '');
  assert.match(ProjectContext.buildPromptBlock(project), /AGENTS\.md does not exist/);
});

test('ProjectContext.refresh - un fallo de lectura distinto de inexistente queda error y avisa', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const { context, state } = createHarness({ files: { '/repo/.zerochat/task.py': { success: false, error: 'Permission denied' } } });
  await context.refresh();
  assert.equal(state.get('project').status, 'error');
  assert.equal(state.get('project').error, 'Permission denied');
  assert.equal(console.warn.mock.callCount(), 1);
});

test('ProjectContext.refresh - si la lectura de state.md falla, es denegada o queda unavailable, no lee AGENTS.md', async (t) => {
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
  assert.deepEqual(harnessErr.calls.map(c => c.path), [
    '/repo/.zerochat/task.py',
    '/repo/.zerochat/state.md'
  ], 'No debe intentar leer AGENTS.md si falla state.md');

  // Denegado en state.md
  const harnessDenied = createHarness({
    files: {
      '/repo/.zerochat/task.py': 'helper',
      '/repo/.zerochat/state.md': 'state',
      '/repo/AGENTS.md': 'rules'
    },
    security: {
      evaluateAuthorization: (tool, args) => {
        if (args.path.endsWith('state.md')) return { status: 'deny', requiresApproval: false };
        return { status: 'allow', requiresApproval: false };
      }
    }
  });
  await harnessDenied.context.refresh();
  assert.equal(harnessDenied.state.get('project').status, 'no_access');
  assert.deepEqual(harnessDenied.calls.map(c => c.path), [
    '/repo/.zerochat/task.py'
  ]);

  // Unavailable en state.md
  let availableQueries = 0;
  const toolDynamic = {
    name: 'read_file',
    isAvailable: () => {
      availableQueries++;
      // Disponible para preliminar y task.py, no disponible para state.md
      return availableQueries <= 2;
    }
  };
  const harnessUnavail = createHarness({
    files: {
      '/repo/.zerochat/task.py': 'helper',
      '/repo/.zerochat/state.md': 'state',
      '/repo/AGENTS.md': 'rules'
    }
  });
  harnessUnavail.context = ProjectContext.createProjectContext({
    state: harnessUnavail.state,
    config: { getActive: () => ({ projectMode: true, projectDeclined: [] }) },
    agentCore: {
      registry: { getTool: name => (name === 'read_file' ? toolDynamic : null) },
      executor: harnessErr.context ? { executeToolCall: async () => ({ success: true, result: { success: true, isError: false, content: JSON.stringify({ success: true, content: 'ok' }) } }) } : null
    },
    security: { evaluateAuthorization: () => ({ status: 'allow', requiresApproval: false }) }
  });
  await harnessUnavail.context.refresh();
  assert.equal(harnessUnavail.state.get('project').status, 'unavailable');
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
  assert.match(log.prompts[0], /repository at \/repo/);
});

test('ProjectContext.initialize - cancelar no concede permisos ni envía nada', async () => {
  const { context, security } = createHarness();
  await context.refresh();
  const { log, callbacks } = initCallbacks({ accept: false });
  assert.deepEqual(await context.initialize(callbacks), { ok: false, reason: 'cancelled' });
  assert.deepEqual(security.rules, []);
  assert.equal(log.prompts.length, 0);
});

test('ProjectContext.initialize - revalida el proyecto tras la confirmación', async () => {
  const { context, state, security } = createHarness();
  await context.refresh();
  const { log, callbacks } = initCallbacks({ onConfirm: () => state.setProjectContext({ cwd: '/other' }) });
  assert.deepEqual(await context.initialize(callbacks), { ok: false, reason: 'state-changed' });
  assert.deepEqual(security.rules, []);
  assert.equal(log.prompts.length, 0);
});

test('ProjectContext.initialize - sin write_file o fuera de missing no hace nada', async () => {
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

test('ProjectContext.initialize - la regla concedida permite escribir en .zerochat y no en el resto del proyecto', async () => {
  const ChatToolSecurity = require('../../js/tool-security.js');
  const manager = new ChatToolSecurity.ToolSecurityManager({ storageKey: 'test_project_init_rule' });
  manager.setStartupDirectory('/repo');
  const { context } = createHarness({ security: manager });
  await context.refresh();
  const result = await context.initialize(initCallbacks().callbacks);
  assert.equal(result.ok, true);

  const writeTool = { id: 'write_file', name: 'write_file', category: 'mcp', metadata: { originalName: 'write_file' } };
  assert.equal(manager.evaluateAuthorization(writeTool, { path: '/repo/.zerochat/state.md' }).requiresApproval, false);
  assert.equal(manager.evaluateAuthorization(writeTool, { path: '/repo/AGENTS.md' }).requiresApproval, true);
  assert.equal(manager.evaluateAuthorization(writeTool, { path: '/repo/.zerochat/../AGENTS.md' }).requiresApproval, true);
  assert.equal(manager.evaluateAuthorization(writeTool, { path: '/repo/.zerochat-other/x' }).requiresApproval, true);
});

test('ProjectContext.refresh - un fallo de transporte sin contenido queda error con su motivo', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const { context, state } = createHarness({ files: { '/repo/.zerochat/task.py': new Error('connection reset') } });
  await context.refresh();
  assert.equal(state.get('project').status, 'error');
  assert.equal(state.get('project').error, 'connection reset');
});


test('ProjectContext.changeDirectory - pide al servidor el directorio escrito', async () => {
  const { context, directoryRequests } = createHarness({ directoryTool: true });
  assert.equal(context.canChangeDirectory(), true);
  const asked = [];
  const result = await context.changeDirectory({ askPath: cwd => { asked.push(cwd); return '  /other  '; } });
  assert.deepEqual(result, { ok: true, cwd: '/other' });
  assert.deepEqual(asked, ['/repo']);
  assert.deepEqual(directoryRequests, ['/other']);
});

test('ProjectContext.changeDirectory - cancelar, la misma ruta o un cambio de estado no piden nada', async () => {
  const cancelled = createHarness({ directoryTool: true });
  assert.deepEqual(await cancelled.context.changeDirectory({ askPath: () => null }), { ok: false, reason: 'cancelled' });
  assert.deepEqual(await cancelled.context.changeDirectory({ askPath: () => '/repo' }), { ok: false, reason: 'cancelled' });
  assert.equal(cancelled.directoryRequests.length, 0);

  const moved = createHarness({ directoryTool: true });
  const askPath = () => { moved.state.set('mcp', { status: 'connected', serverInfo: { cwd: '/elsewhere' } }); return '/other'; };
  assert.deepEqual(await moved.context.changeDirectory({ askPath }), { ok: false, reason: 'state-changed' });
  let busy = false;
  assert.deepEqual(await moved.context.changeDirectory({ askPath: () => { busy = true; return '/other'; }, isBusy: () => busy }), { ok: false, reason: 'state-changed' });
  assert.equal(moved.directoryRequests.length, 0);
});

test('ProjectContext.changeDirectory - sin servidor local o generando no pregunta', async () => {
  const askPath = () => { throw new Error('no debe preguntar'); };
  for (const harness of [createHarness({ directoryTool: false }), createHarness({ directoryTool: true, connected: false })]) {
    assert.equal(harness.context.canChangeDirectory(), false);
    assert.deepEqual(await harness.context.changeDirectory({ askPath }), { ok: false, reason: 'unavailable' });
  }
  const busy = createHarness({ directoryTool: true });
  assert.deepEqual(await busy.context.changeDirectory({ askPath, isBusy: () => true }), { ok: false, reason: 'unavailable' });
  await assert.rejects(() => busy.context.changeDirectory({}), TypeError);
});
