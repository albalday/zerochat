const test = require('node:test');
const assert = require('node:assert/strict');

const AgentCore = require('../../js/agent-core.js');
const ChatAPI = require('../../js/api.js');
const ToolSecurity = require('../../js/tool-security.js');

const { Tool, ToolRegistry, ToolExecutor, AgentRuntime } = AgentCore;

// Como al conectar el backend local, que informa de su directorio de trabajo.
ToolSecurity.manager.setStartupDirectory('/home/user/proj');
const delegateTask = AgentCore.registry.getTool('delegate_task');

function localTool(name, execute = async () => ({ success: true }), mcpServerId = 'mcp_proxy') {
  return new Tool({
    definition: { name, description: `Local ${name}` },
    category: 'mcp',
    metadata: { mcpServerId, mcpServerName: 'ZeroChat', originalName: name },
    settings: { showInSettings: false },
    execute
  });
}

function call(id, name, args = {}) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

const isSubagentRequest = messages => messages.some(message =>
  typeof message.content === 'string' && message.content.startsWith('[Subagent task]'));

/** Sustituye la red: `respond` recibe cada petición al proveedor. */
function stubApi(t, respond) {
  t.mock.method(ChatAPI, 'streamChatCompletion', respond);
}

/**
 * Agente principal y subagente sobre el mismo registro, sin perfiles. Las herramientas
 * ofrecidas son todas las del registro, como hace la aplicación con resolveToolDefinitions.
 */
function createHarness(executed) {
  const registry = new ToolRegistry();
  registry.unregisterProvider('builtin');
  registry.registerTool(localTool('read_file', async args => {
    executed.push(`read_file:${args.path}`);
    return { success: true, content: 'export const answer = 42;' };
  }));
  registry.registerTool(localTool('write_file', async () => {
    executed.push('write_file');
    return { success: true };
  }));
  const executor = new ToolExecutor(registry);
  const runtime = new AgentRuntime({ registry, executor });
  const services = {
    agent: { registry, executor, runtime },
    profiles: { list: () => [] },
    engine: { createHistorySummarizer: () => async () => 'summary' }
  };
  const resolveToolDefinitions = () => registry.listTools().map(tool => tool.getDefinition());
  return { registry, runtime, services, context: { services, resolveToolDefinitions } };
}

test('delegate_task - solo ofrece al subagente herramientas de lectura', async t => {
  const registry = new ToolRegistry();
  for (const name of ['read_file', 'list_directory', 'search_files', 'get_diagnostics', 'write_file', 'edit_file', 'run_command', 'check_command', 'browser_action']) {
    registry.registerTool(localTool(name));
  }
  registry.registerTool(localTool('remote_read_file', undefined, 'remote_server'));
  const offered = [];
  stubApi(t, async params => {
    offered.push(...params.tools.map(definition => definition.function.name));
    return { accumulatedText: 'Informe', toolCalls: [] };
  });

  const result = await delegateTask.execute({ task: 'Investigate' }, {
    services: { agent: { registry, executor: new ToolExecutor(registry), runtime: new AgentRuntime({ registry, executor: new ToolExecutor(registry) }) }, profiles: { list: () => [] } },
    resolveToolDefinitions: () => registry.listTools().map(tool => tool.getDefinition())
  });

  assert.equal(result.success, true);
  assert.deepEqual(offered.sort(), [
    'download_doc', 'download_image', 'execute_javascript', 'fetch_web_page', 'get_diagnostics', 'list_directory', 'list_documents',
    'read_file', 'read_knowledge_chunk', 'read_knowledge_image', 'search_files', 'search_knowledge_base', 'search_web'
  ], 'Fuera quedan las que escriben, ask_user, render_chart, delegate_task y los MCP externos');
});

test('delegate_task - el subagente trabaja con contexto propio y devuelve solo su informe', async t => {
  // Recorrido completo por el agente real: las herramientas del servidor local se registran en
  // su registro y se retiran al terminar.
  const executed = [];
  const fakeTools = [
    localTool('read_file', async args => { executed.push(`read_file:${args.path}`); return { success: true, content: 'export const answer = 42;' }; }),
    localTool('write_file', async () => { executed.push('write_file'); return { success: true }; })
  ];
  fakeTools.forEach(tool => AgentCore.registry.registerTool(tool));
  t.after(() => fakeTools.forEach(tool => AgentCore.registry.unregisterTool(tool.name)));
  const runtime = AgentCore.runtime;
  const context = { resolveToolDefinitions: () => [...fakeTools, delegateTask].map(tool => tool.getDefinition()) };
  const controller = new AbortController();
  const subagentRequests = [];
  let parentRequests = 0;

  stubApi(t, async params => {
    if (isSubagentRequest(params.messages)) {
      subagentRequests.push({ ...params, messages: [...params.messages] });
      assert.equal(params.signal, controller.signal, 'El subagente hereda la cancelación del agente principal');
      if (subagentRequests.length === 1) {
        return { accumulatedText: 'Leo el fichero.', toolCalls: [call('s1', 'read_file', { path: 'a.js' }), call('s2', 'write_file', { path: 'a.js' })], stats: null };
      }
      return { accumulatedText: 'answer vale 42 (a.js:1).', toolCalls: [], stats: null };
    }
    parentRequests++;
    if (parentRequests === 1) {
      return { accumulatedText: '', toolCalls: [call('p1', 'delegate_task', { task: 'Find the value of answer in a.js.' })], stats: null };
    }
    return { accumulatedText: 'Vale 42.', toolCalls: [], stats: null };
  });

  const result = await runtime.execute({
    ...context,
    signal: controller.signal,
    messages: [{ role: 'user', content: 'Conversación privada del agente principal' }],
    appendFinalMessage: true
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.finalText, 'Vale 42.');
  assert.deepEqual(executed, ['read_file:a.js'], 'write_file nunca se ejecuta aunque el subagente la pida');

  const firstSubRequest = subagentRequests[0];
  assert.deepEqual(firstSubRequest.tools.map(definition => definition.function.name), ['read_file']);
  assert.equal(firstSubRequest.messages.length, 1, 'El subagente no ve la conversación principal');
  assert.match(firstSubRequest.messages[0].content, /Task:\nFind the value of answer in a\.js\.$/);

  const deniedWrite = subagentRequests[1].messages.find(message => message.role === 'tool' && message.name === 'write_file');
  assert.match(deniedWrite.content, /not available to the subagent/);

  const delegated = result.history.find(message => message.role === 'tool' && message.name === 'delegate_task');
  assert.equal(delegated.content, 'answer vale 42 (a.js:1).', 'Al agente principal solo llega el informe');
  assert.equal(result.history.some(message => message.name === 'read_file'), false);
});

test('delegate_task - valida el encargo y no arranca sin herramientas de lectura', async t => {
  const { registry, context } = createHarness([]);
  let requests = 0;
  stubApi(t, async () => { requests++; return { accumulatedText: 'x', toolCalls: [] }; });

  assert.match((await delegateTask.execute({ task: '  ' }, context)).error, /non-empty/);
  assert.match((await delegateTask.execute({ task: 'x'.repeat(8001) }, context)).error, /must not exceed/);

  registry.unregisterTool('read_file');
  const noTools = await delegateTask.execute({ task: 'Investigate' }, context);
  assert.equal(noTools.success, false);
  assert.match(noTools.error, /No read-only tools/);
  assert.equal(requests, 0);
});

test('delegate_task - un informe vacío o un error del proveedor se devuelven como fallo', async t => {
  const { context } = createHarness([]);
  let respond = async () => ({ accumulatedText: '   ', toolCalls: [] });
  stubApi(t, params => respond(params));

  const empty = await delegateTask.execute({ task: 'Investigate' }, context);
  assert.equal(empty.success, false);
  assert.match(delegateTask.toModel({}, empty), /"success":false[\s\S]*without a report/);

  respond = async ({ onError }) => { onError(new Error('quota exceeded')); return null; };
  assert.deepEqual(await delegateTask.execute({ task: 'Investigate' }, context), { success: false, error: 'quota exceeded' });

  respond = async () => ({ accumulatedText: 'r'.repeat(25000), toolCalls: [] });
  const long = await delegateTask.execute({ task: 'Investigate' }, context);
  assert.equal(long.success, true);
  assert.match(long.report, /\[Report truncated at 20000 characters\.\]$/);
});

test('delegate_task - un perfil «Subagente» da al subagente su propio modelo', async t => {
  const { services, context } = createHarness([]);
  const loaded = [];
  const summarizers = [];
  const profile = {
    id: 'profile:Subagente',
    name: ' subAGENTE ',
    settings: { apiUrl: 'http://sub/v1', apiType: 'openai', apiKey: 'sub-key', model: 'sub-model', temperature: '0.2', reasoningEffort: 'low', contextLimitOverride: 32000 }
  };
  services.profiles = { list: () => [{ id: 'profile:Main', name: 'Main', settings: {} }, { id: profile.id, name: profile.name, settings: {} }] };
  services.profilesUI = { loadProfileUnlocked: async id => { loaded.push(id); return structuredClone(profile); } };
  services.engine = { createHistorySummarizer: options => { summarizers.push(options); return async () => 'summary'; } };
  const requests = [];
  stubApi(t, async params => { requests.push(params); return { accumulatedText: 'Informe', toolCalls: [] }; });
  const result = await delegateTask.execute({ task: 'Investigate' }, {
    ...context,
    apiUrl: 'http://main/v1', apiType: 'anthropic', apiKey: 'main-key', model: 'main-model', temperature: '0.9',
    contextOptions: { totalContextLimit: 200000, summarizerAddendum: 'addendum' }
  });

  assert.equal(result.success, true);
  assert.deepEqual(loaded, ['profile:Subagente']);
  const [request] = requests;
  assert.deepEqual(
    { apiUrl: request.apiUrl, apiType: request.apiType, apiKey: request.apiKey, model: request.model },
    { apiUrl: 'http://sub/v1', apiType: 'openai', apiKey: 'sub-key', model: 'sub-model' }
  );
  assert.equal(summarizers.length, 1, 'La compactación del subagente usa la conexión del perfil');
  assert.equal(summarizers[0].model, 'sub-model');
  assert.equal(summarizers[0].apiKey, 'sub-key');
});

test('delegate_task - sin perfil «Subagente» usa el modelo principal; uno ilegible o incompleto es un error', async t => {
  const { services, context } = createHarness([]);
  const requests = [];
  stubApi(t, async params => { requests.push(params); return { accumulatedText: 'Informe', toolCalls: [] }; });
  const mainContext = { ...context, apiUrl: 'http://main/v1', apiType: 'openai', apiKey: 'main-key', model: 'main-model' };

  services.profiles = { list: () => [{ id: 'profile:Main', name: 'Main', settings: {} }] };
  services.profilesUI = { loadProfileUnlocked: async () => assert.fail('No debe cargar perfiles') };
  assert.equal((await delegateTask.execute({ task: 'Investigate' }, mainContext)).success, true);
  assert.equal(requests[0].model, 'main-model');
  assert.equal(requests[0].apiKey, 'main-key');

  services.profiles = { list: () => [{ id: 'profile:Subagent', name: 'Subagent', settings: {} }] };
  services.profilesUI = { loadProfileUnlocked: async () => { throw new Error('Password required'); } };
  const failed = await delegateTask.execute({ task: 'Investigate' }, mainContext);
  assert.equal(failed.success, false);
  assert.match(failed.error, /"Subagent" profile could not be loaded: Password required/);

  services.profilesUI = { loadProfileUnlocked: async () => ({ settings: { apiUrl: 'http://sub/v1', apiType: 'openai', model: '' } }) };
  assert.match((await delegateTask.execute({ task: 'Investigate' }, mainContext)).error, /"Subagent" profile is incomplete: missing model\./);

  services.profiles = { list: () => { throw new Error('corrupt storage'); } };
  assert.match((await delegateTask.execute({ task: 'Investigate' }, mainContext)).error, /profiles could not be read: corrupt storage/);
  assert.equal(requests.length, 1, 'No recurre en silencio al modelo principal');
});
