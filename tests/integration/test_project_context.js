const { test } = require('node:test');
const assert = require('node:assert/strict');
const ChatState = require('../../js/state.js');
const ProjectContext = require('../../js/project-context.js');

function createHarness({ config = {}, connected = true, cwd = '/repo', files = {}, approval = false, readTool = true } = {}) {
  const state = ChatState.createStore();
  if (connected) state.set('mcp', { status: 'connected', serverInfo: { cwd } });
  const calls = [];
  const tool = { name: 'read_file', isAvailable: () => true };
  const agentCore = {
    registry: { getTool: name => (readTool && name === 'read_file' ? tool : null) },
    executor: {
      async executeToolCall(call) {
        const args = JSON.parse(call.function.arguments);
        calls.push(args);
        const file = files[args.path];
        if (file instanceof Error) return { success: false, error: file.message };
        const payload = file === undefined
          ? { success: false, error: `File '${args.path}' does not exist.` }
          : (typeof file === 'string' ? { success: true, content: file, truncated: false } : file);
        return { success: true, result: { content: JSON.stringify(payload) } };
      }
    }
  };
  const security = { evaluateAuthorization: () => (approval ? { status: 'ask', requiresApproval: true } : { status: 'allow', requiresApproval: false }) };
  const context = ProjectContext.createProjectContext({
    state,
    config: { get: () => ({ projectMode: true, projectDeclined: [], ...config }) },
    agentCore,
    security
  });
  return { state, context, calls };
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
  const { context, calls, state } = createHarness({ approval: true, files: { '/repo/ZEROCHAT.md': 'rules' } });
  await context.refresh();
  assert.equal(state.get('project').status, 'no_access');
  assert.equal(calls.length, 0);
});

test('ProjectContext.refresh - sin ZEROCHAT.md queda missing', async () => {
  const { context, state } = createHarness();
  await context.refresh();
  assert.equal(state.get('project').status, 'missing');
  assert.equal(state.get('project').cwd, '/repo');
});

test('ProjectContext.refresh - lee normas y estado con límite de tamaño', async () => {
  const { context, calls, state } = createHarness({
    files: {
      '/repo/ZEROCHAT.md': { success: true, content: 'Project rules: AGENTS.md', truncated: true },
      '/repo/.zerochat/state.md': '- Next step: tests'
    }
  });
  await context.refresh();
  const project = state.get('project');
  assert.equal(project.status, 'ready');
  assert.deepEqual(project.rules, { content: 'Project rules: AGENTS.md', truncated: true });
  assert.deepEqual(project.state, { content: '- Next step: tests', truncated: false });
  assert.deepEqual(calls.map(args => [args.path, args.max_bytes]), [
    ['/repo/ZEROCHAT.md', ProjectContext.MAX_FILE_BYTES],
    ['/repo/.zerochat/state.md', ProjectContext.MAX_FILE_BYTES]
  ]);
  assert.match(ProjectContext.buildPromptBlock(project), /- Next step: tests/);
});

test('ProjectContext.refresh - state.md es opcional', async () => {
  const { context, state } = createHarness({ files: { '/repo/ZEROCHAT.md': 'rules' } });
  await context.refresh();
  assert.equal(state.get('project').status, 'ready');
  assert.equal(state.get('project').state.content, '');
});

test('ProjectContext.refresh - un fallo de lectura distinto de inexistente queda error y avisa', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const { context, state } = createHarness({ files: { '/repo/ZEROCHAT.md': { success: false, error: 'Permission denied' } } });
  await context.refresh();
  assert.equal(state.get('project').status, 'error');
  assert.equal(state.get('project').error, 'Permission denied');
  assert.equal(console.warn.mock.callCount(), 1);
});

test('ProjectContext.refresh - solo publica el resultado de la llamada más reciente', async () => {
  const harness = createHarness({ files: { '/repo/ZEROCHAT.md': 'rules' } });
  const first = harness.context.refresh();
  harness.state.set('mcp', { status: 'disconnected', serverInfo: null });
  const second = harness.context.refresh();
  await Promise.all([first, second]);
  assert.equal(harness.state.get('project').status, 'unavailable');
});
