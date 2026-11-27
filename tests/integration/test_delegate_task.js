const test = require('node:test');
const assert = require('node:assert/strict');

const AgentCore = require('../../js/agent-core.js');
const ChatAPI = require('../../js/api.js');

const { Tool, ToolRegistry, ToolExecutor, AgentRuntime } = AgentCore;

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

/** Una nativa de lectura (por su nombre) sin red ni efectos. */
function readTool(name, execute) {
  return new Tool({ definition: { name, description: `Native ${name}` }, settings: { showInSettings: false }, execute });
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
  registry.registerTool(readTool('fetch_web_page', async args => {
    executed.push(`fetch_web_page:${args.url}`);
    return { success: true, content: 'answer = 42' };
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
  return { registry, runtime, services, context: { services, agent: { resolveToolDefinitions } } };
}

test('delegate_task - solo ofrece al subagente herramientas nativas de lectura', async t => {
  const registry = new ToolRegistry();
  for (const name of ['read_file', 'write_file', 'run_command', 'browser_action']) registry.registerTool(localTool(name));
  registry.registerTool(localTool('remote_read_file', undefined, 'remote_server'));
  const offered = [];
  stubApi(t, async params => {
    offered.push(...params.tools.map(definition => definition.function.name));
    return { accumulatedText: 'Informe', toolCalls: [] };
  });

  const result = await delegateTask.execute({ task: 'Investigate' }, {
    services: { agent: { registry, executor: new ToolExecutor(registry), runtime: new AgentRuntime({ registry, executor: new ToolExecutor(registry) }) }, profiles: { list: () => [] } },
    agent: { resolveToolDefinitions: () => registry.listTools().map(tool => tool.getDefinition()) }
  });

  assert.equal(result.success, true);
  assert.deepEqual(offered.sort(), [
    'download_doc', 'download_image', 'execute_javascript', 'fetch_web_page', 'list_documents',
    'read_knowledge_chunk', 'read_knowledge_image', 'search_knowledge_base', 'search_web'
  ], 'Fuera quedan las que escriben, ask_user, render_chart, delegate_task y toda MCP, local o externa');
});

test('delegate_task - el subagente trabaja con contexto propio y devuelve solo su informe', async t => {
  // Recorrido completo por el agente real: la nativa de lectura no sale a la red y la de escritura se registra en su
  // registro y se retira al terminar.
  const executed = [];
  const fetchTool = AgentCore.registry.getTool('fetch_web_page');
  t.mock.method(fetchTool, 'execute', async args => { executed.push(`fetch_web_page:${args.url}`); return { success: true, content: 'answer = 42' }; });
  const writeTool = localTool('write_file', async () => { executed.push('write_file'); return { success: true }; });
  AgentCore.registry.registerTool(writeTool);
  t.after(() => AgentCore.registry.unregisterTool(writeTool.name));
  const runtime = AgentCore.runtime;
  const context = { resolveToolDefinitions: () => [fetchTool, writeTool, delegateTask].map(tool => tool.getDefinition()) };
  const controller = new AbortController();
  const subagentRequests = [];
  let parentRequests = 0;

  stubApi(t, async params => {
    if (isSubagentRequest(params.messages)) {
      subagentRequests.push({ ...params, messages: [...params.messages] });
      assert.equal(params.signal, controller.signal, 'El subagente hereda la cancelación del agente principal');
      if (subagentRequests.length === 1) {
        return { accumulatedText: 'Leo la página.', toolCalls: [call('s1', 'fetch_web_page', { url: 'https://a.test' }), call('s2', 'write_file', { path: 'a.js' })], stats: null };
      }
      return { accumulatedText: 'answer vale 42 (https://a.test).', toolCalls: [], stats: null };
    }
    parentRequests++;
    if (parentRequests === 1) {
      return { accumulatedText: '', toolCalls: [call('p1', 'delegate_task', { task: 'Find the value of answer in https://a.test.' })], stats: null };
    }
    return { accumulatedText: 'Vale 42.', toolCalls: [], stats: null };
  });

  const result = await runtime.execute({
    ...context,
    signal: controller.signal,
    messages: [{ role: 'user', content: 'Conversación privada del agente principal' }]
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.finalText, 'Vale 42.');
  assert.deepEqual(executed, ['fetch_web_page:https://a.test'], 'write_file nunca se ejecuta aunque el subagente la pida');

  const firstSubRequest = subagentRequests[0];
  assert.deepEqual(firstSubRequest.tools.map(definition => definition.function.name), ['fetch_web_page']);
  assert.equal(firstSubRequest.messages.length, 1, 'El subagente no ve la conversación principal');
  assert.match(firstSubRequest.messages[0].content, /Task:\nFind the value of answer in https:\/\/a\.test\.$/);

  const deniedWrite = subagentRequests[1].messages.find(message => message.role === 'tool' && message.name === 'write_file');
  assert.match(deniedWrite.content, /not available in this conversation/);

  const delegated = result.history.find(message => message.role === 'tool' && message.name === 'delegate_task');
  assert.equal(delegated.content, 'answer vale 42 (https://a.test).', 'Al agente principal solo llega el informe');
  assert.equal(result.history.some(message => message.name === 'fetch_web_page'), false);
});

test('delegate_task - valida encargo, herramientas requeridas, fallos del proveedor y truncado del informe', async t => {
  const { registry, context } = createHarness([]);
  let requests = 0;
  let respond = async () => ({ accumulatedText: 'x', toolCalls: [] });
  stubApi(t, params => { requests++; return respond(params); });

  assert.match((await delegateTask.execute({ task: '  ' }, context)).error, /non-empty/);
  assert.match((await delegateTask.execute({ task: 'x'.repeat(8001) }, context)).error, /must not exceed/);

  respond = async () => ({ accumulatedText: '   ', toolCalls: [] });
  const empty = await delegateTask.execute({ task: 'Investigate' }, context);
  assert.equal(empty.success, false);
  assert.match(delegateTask.toModel({}, empty), /"success":false[\s\S]*without a report/);

  respond = async ({ onError }) => { onError(new Error('quota exceeded')); return null; };
  assert.deepEqual(await delegateTask.execute({ task: 'Investigate' }, context), { success: false, error: 'quota exceeded' });

  respond = async () => ({ accumulatedText: 'r'.repeat(25000), toolCalls: [] });
  const long = await delegateTask.execute({ task: 'Investigate' }, context);
  assert.equal(long.success, true);
  assert.match(long.report, /\[Report truncated at 20000 characters\.\]$/);

  const countBeforeNoTools = requests;
  registry.unregisterTool('fetch_web_page');
  const noTools = await delegateTask.execute({ task: 'Investigate' }, context);
  assert.equal(noTools.success, false);
  assert.match(noTools.error, /No read-only tools/);
  assert.equal(requests, countBeforeNoTools);
});

test('delegate_task - usa el perfil Subagente si existe, si no el principal, y falla explícitamente si es ilegible', async t => {
  const { services, context } = createHarness([]);
  const loaded = [];
  const summarizers = [];
  const profile = {
    id: 'profile:Subagente',
    name: ' subAGENTE ',
    settings: { apiUrl: 'http://sub/v1', apiType: 'openai', apiKey: 'sub-key', model: 'sub-model', temperature: '0.2', reasoningEffort: 'low' }
  };
  services.profiles = {
    list: () => [{ id: 'profile:Main', name: 'Main', settings: {} }, { id: profile.id, name: profile.name, settings: {} }],
    load: async id => { loaded.push(id); return structuredClone(profile); }
  };
  services.engine = { createHistorySummarizer: options => { summarizers.push(options); return async () => 'summary'; } };
  const requests = [];
  const prepareCalls = [];
  t.mock.method(ChatAPI, 'fetchServerModels', async () => ({
    success: true,
    models: [{ id: 'sub-model', details: { context_length: 65536 } }]
  }));
  stubApi(t, async params => { requests.push(params); return { accumulatedText: 'Informe', toolCalls: [] }; });

  const mainContext = {
    ...context,
    agent: {
      ...context.agent,
      apiUrl: 'http://main/v1', apiType: 'anthropic', apiKey: 'main-key', model: 'main-model', temperature: '0.9',
      contextOptions: { totalContextLimit: 200000, summarizerAddendum: 'addendum' },
      prepareMessages: (msgs, extra) => { prepareCalls.push(extra); return msgs; }
    }
  };
  assert.equal((await delegateTask.execute({ task: 'Investigate' }, mainContext)).success, true);
  assert.deepEqual(loaded, ['profile:Subagente']);
  assert.equal(requests[0].model, 'sub-model');
  assert.equal(requests[0].apiKey, 'sub-key');
  assert.equal(summarizers.length, 1);
  assert.equal(summarizers[0].model, 'sub-model');
  assert.equal(prepareCalls[0].totalContextLimit, 65536, 'El subagente resuelve y propaga su límite de contexto real');

  // Sin perfil Subagente recurre al principal
  services.profiles = { list: () => [{ id: 'profile:Main', name: 'Main', settings: {} }], load: async () => assert.fail('No debe cargar') };
  assert.equal((await delegateTask.execute({ task: 'Investigate' }, mainContext)).success, true);
  assert.equal(requests[1].model, 'main-model');
  assert.equal(requests[1].apiKey, 'main-key');

  // Perfiles ilegibles o incompletos fallan sin silenciar
  const subagentList = () => [{ id: 'profile:Subagent', name: 'Subagent', settings: {} }];
  services.profiles = { list: subagentList, load: async () => { throw new Error('the local server did not answer'); } };
  assert.match((await delegateTask.execute({ task: 'Investigate' }, mainContext)).error, /"Subagent" profile could not be loaded: the local server did not answer/);

  services.profiles = { list: subagentList, load: async () => ({ settings: { apiUrl: 'http://sub/v1', apiType: 'openai', model: '' } }) };
  assert.match((await delegateTask.execute({ task: 'Investigate' }, mainContext)).error, /"Subagent" profile is incomplete: missing model\./);

  services.profiles = { list: () => { throw new Error('corrupt storage'); } };
  assert.match((await delegateTask.execute({ task: 'Investigate' }, mainContext)).error, /profiles could not be read: corrupt storage/);
  assert.equal(requests.length, 2);
});
