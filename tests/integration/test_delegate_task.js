const test = require('node:test');
const assert = require('node:assert/strict');

const AgentCore = require('../../js/agent-core.js');
const DelegateTaskTool = require('../../js/tools/builtin/delegate-task.tool.js');

const { Tool, ToolRegistry, ToolExecutor, AgentRuntime } = AgentCore;

function localTool(name, execute) {
  return new Tool({
    id: name,
    name,
    description: `Local ${name}`,
    parameters: { type: 'object', properties: {} },
    category: 'mcp',
    metadata: { mcpServerId: 'mcp_proxy', mcpServerName: 'ZeroChat', originalName: name },
    settings: { showInSettings: false },
    execute
  });
}

function call(id, name, args = {}) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

const isSubagentRequest = messages => messages.some(message =>
  typeof message.content === 'string' && message.content.startsWith('[Subagent task]'));

/** Agente principal y subagente sobre el mismo registro, con permisos que no piden confirmación. */
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
  const services = { agent: { registry, executor, runtime } };
  return { registry, runtime, services };
}

test('delegate_task - solo ofrece al subagente herramientas de lectura', () => {
  const builtin = name => ({ name, category: 'builtin' });
  for (const name of ['search_web', 'fetch_web_page', 'download_pdf', 'execute_javascript', 'list_documents', 'search_knowledge_base', 'read_knowledge_chunk', 'read_knowledge_image']) {
    assert.equal(DelegateTaskTool.isReadOnlyTool(builtin(name)), true, name);
  }
  for (const name of ['delegate_task', 'ask_user', 'render_chart']) {
    assert.equal(DelegateTaskTool.isReadOnlyTool(builtin(name)), false, name);
  }
  const local = (name, mcpServerId = 'mcp_proxy') => ({ name, category: 'mcp', metadata: { mcpServerId } });
  for (const name of ['read_file', 'list_directory', 'search_files', 'get_diagnostics']) {
    assert.equal(DelegateTaskTool.isReadOnlyTool(local(name)), true, name);
  }
  for (const name of ['write_file', 'edit_file', 'run_command', 'check_command', 'browser_action']) {
    assert.equal(DelegateTaskTool.isReadOnlyTool(local(name)), false, name);
  }
  assert.equal(DelegateTaskTool.isReadOnlyTool(local('read_file', 'remote_server')), false, 'Un MCP externo no se considera de lectura');
  assert.equal(DelegateTaskTool.isReadOnlyTool(null), false);
});

test('delegate_task - el subagente trabaja con contexto propio y devuelve solo su informe', async () => {
  const executed = [];
  const { registry, runtime, services } = createHarness(executed);
  registry.registerTool(DelegateTaskTool.createTool(Tool));
  const controller = new AbortController();
  const subagentRequests = [];
  let parentRequests = 0;

  const api = {
    streamChatCompletion: async params => {
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
    }
  };

  const result = await runtime.execute({
    api,
    services,
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

test('delegate_task - valida el encargo y no arranca sin herramientas de lectura', async () => {
  const executed = [];
  const { registry, services } = createHarness(executed);
  const tool = DelegateTaskTool.createTool(Tool);
  let requests = 0;
  const api = { streamChatCompletion: async () => { requests++; return { accumulatedText: 'x', toolCalls: [] }; } };

  assert.match((await tool.execute({ task: '  ' }, { services, api })).error, /non-empty/);
  assert.match((await tool.execute({ task: 'x'.repeat(8001) }, { services, api })).error, /must not exceed/);

  registry.unregisterTool('read_file');
  const noTools = await tool.execute({ task: 'Investigate' }, { services, api });
  assert.equal(noTools.success, false);
  assert.match(noTools.error, /No read-only tools/);
  assert.equal(requests, 0);
});

test('delegate_task - un informe vacío o un error del proveedor se devuelven como fallo', async () => {
  const { services } = createHarness([]);
  const tool = DelegateTaskTool.createTool(Tool);

  const empty = await tool.execute({ task: 'Investigate' }, {
    services,
    api: { streamChatCompletion: async () => ({ accumulatedText: '   ', toolCalls: [] }) }
  });
  assert.equal(empty.success, false);
  assert.match(tool.result.toModel({}, empty), /"success":false[\s\S]*without a report/);

  const failed = await tool.execute({ task: 'Investigate' }, {
    services,
    api: { streamChatCompletion: async ({ onError }) => { onError(new Error('quota exceeded')); return null; } }
  });
  assert.deepEqual(failed, { success: false, error: 'quota exceeded' });

  const long = await tool.execute({ task: 'Investigate' }, {
    services,
    api: { streamChatCompletion: async () => ({ accumulatedText: 'r'.repeat(25000), toolCalls: [] }) }
  });
  assert.equal(long.success, true);
  assert.match(long.report, /\[Report truncated at 20000 characters\.\]$/);
});

test('delegate_task - la tarjeta escapa el encargo y el historial restaura el informe o el error', () => {
  const fakeDoc = { createElement: () => ({ className: '', innerHTML: '', querySelector: () => null }) };
  const ui = { document: fakeDoc, t: key => key, markdown: require('../../js/markdown.js') };
  const card = DelegateTaskTool.view.createLiveCard({ task: '<img src=x onerror=alert(1)>' }, ui);
  assert.equal(card.innerHTML.includes('<img src=x'), false);
  assert.match(card.innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(card.innerHTML, /subagent-steps/);

  const tool = DelegateTaskTool.createTool(Tool);
  assert.equal(tool.result.toModel({}, { success: true, report: 'Informe' }), 'Informe');
  assert.match(tool.formatDispatchMarkdown({ task: 'Primera línea\nSegunda' }, { success: true, report: 'Informe' }), /delegate_task\*\*: Primera línea\n/);
  assert.match(tool.formatDispatchMarkdown({}, { success: false, error: 'boom' }), /error: boom/);
});

test('delegate_task - un perfil de conexión «Subagente» da al subagente su propio modelo', async () => {
  const { services } = createHarness([]);
  const tool = DelegateTaskTool.createTool(Tool);
  const loaded = [];
  const summarizers = [];
  const profile = {
    id: 'profile:Subagente',
    name: ' subAGENTE ',
    settings: { apiUrl: 'http://sub/v1', apiType: 'openai', apiKey: 'sub-key', model: 'sub-model', temperature: '0.2', reasoningEffort: 'low', reasoningTransport: 'auto', contextLimitOverride: 32000 }
  };
  services.profiles = { list: () => [{ id: 'profile:Main', name: 'Main', settings: {} }, { id: profile.id, name: profile.name, settings: {} }] };
  services.profilesUI = { loadProfileUnlocked: async id => { loaded.push(id); return structuredClone(profile); } };
  services.engine = { createHistorySummarizer: options => { summarizers.push(options); return async () => 'summary'; } };
  const requests = [];
  const result = await tool.execute({ task: 'Investigate' }, {
    services,
    apiUrl: 'http://main/v1', apiType: 'anthropic', apiKey: 'main-key', model: 'main-model', temperature: '0.9',
    contextOptions: { totalContextLimit: 200000, summarizerAddendum: 'addendum' },
    api: { streamChatCompletion: async params => { requests.push(params); return { accumulatedText: 'Informe', toolCalls: [] }; } }
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

test('delegate_task - sin perfil «Subagente» usa el modelo principal; uno ilegible o incompleto es un error', async () => {
  const { services } = createHarness([]);
  const tool = DelegateTaskTool.createTool(Tool);
  const requests = [];
  const api = { streamChatCompletion: async params => { requests.push(params); return { accumulatedText: 'Informe', toolCalls: [] }; } };
  const mainContext = { services, api, apiUrl: 'http://main/v1', apiType: 'openai', apiKey: 'main-key', model: 'main-model' };

  services.profiles = { list: () => [{ id: 'profile:Main', name: 'Main', settings: {} }] };
  services.profilesUI = { loadProfileUnlocked: async () => assert.fail('No debe cargar perfiles') };
  assert.equal((await tool.execute({ task: 'Investigate' }, mainContext)).success, true);
  assert.equal(requests[0].model, 'main-model');
  assert.equal(requests[0].apiKey, 'main-key');

  services.profiles = { list: () => [{ id: 'profile:Subagent', name: 'Subagent', settings: {} }] };
  services.profilesUI = { loadProfileUnlocked: async () => { throw new Error('Password required'); } };
  const failed = await tool.execute({ task: 'Investigate' }, mainContext);
  assert.equal(failed.success, false);
  assert.match(failed.error, /"Subagent" connection profile could not be loaded: Password required/);

  services.profilesUI = { loadProfileUnlocked: async () => ({ settings: { apiUrl: 'http://sub/v1', apiType: 'openai', model: '' } }) };
  assert.match((await tool.execute({ task: 'Investigate' }, mainContext)).error, /"Subagent" connection profile is incomplete: missing model\./);

  services.profiles = { list: () => { throw new Error('corrupt storage'); } };
  assert.match((await tool.execute({ task: 'Investigate' }, mainContext)).error, /connection profiles could not be read: corrupt storage/);
  assert.equal(requests.length, 1, 'No recurre en silencio al modelo principal');
});
