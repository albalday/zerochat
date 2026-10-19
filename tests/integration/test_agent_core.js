const test = require('node:test');
const assert = require('node:assert/strict');

const AgentCore = require('../../js/agent-core.js');
const ConfigStore = require('../../js/config-store.js');

const { Tool, ToolRegistry, ToolExecutor } = AgentCore;
const makeTool = ({ name, description, parameters, ...options }) => new Tool({ definition: { name, description, parameters }, ...options });
const call = (name, args = {}) => ({ id: `call_${name}`, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });

test('AgentCore - el registro resuelve las nativas por nombre y por alias', () => {
  const registry = new ToolRegistry();

  for (const name of ['execute_javascript', 'search_web', 'fetch_web_page', 'download_doc', 'render_chart']) {
    assert.equal(registry.getTool(name).name, name);
  }
  // Alias declarados, con o sin guiones bajos, en mayúsculas o con guiones.
  assert.equal(registry.getTool('executejs').name, 'execute_javascript');
  assert.equal(registry.getTool('run_js').name, 'execute_javascript');
  assert.equal(registry.getTool('eval_javascript').name, 'execute_javascript');
  assert.equal(registry.getTool('searchweb').name, 'search_web');
  assert.equal(registry.getTool('duckduckgo').name, 'search_web');
  assert.equal(registry.getTool('Search-Web').name, 'search_web');
  assert.equal(registry.getTool('fetchwebpage').name, 'fetch_web_page');
  assert.equal(registry.getTool('downloaddoc').name, 'download_doc');
  assert.equal(registry.getTool('download_pdf').name, 'download_doc');
  assert.equal(registry.getTool('downloadpdf').name, 'download_doc');
  assert.equal(registry.getTool('renderchart').name, 'render_chart');
  assert.equal(registry.getTool('buscar_en_documentos').name, 'search_knowledge_base');
  assert.equal(registry.getTool('unknown_tool'), null);

  const jsDef = registry.getActiveDefinitions(ConfigStore.normalize({})).find(d => d.function.name === 'execute_javascript');
  assert.equal(jsDef.type, 'function');
  assert.ok(jsDef.function.parameters.required.includes('code'));
});

test('AgentCore - MCP conserva identificadores que solo difieren por mayúsculas', () => {
  const registry = new ToolRegistry();
  const upper = makeTool({ name: 'composio_SEARCH', category: 'mcp', execute: async () => ({}) });
  const lower = makeTool({ name: 'composio_search', category: 'mcp', execute: async () => ({}) });

  registry.registerTool(upper);
  registry.registerTool(lower);

  assert.equal(registry.getTool('composio_SEARCH'), upper);
  assert.equal(registry.getTool('composio_search'), lower);
  assert.equal(registry.getTool('COMPOSIO_SEARCH'), null);
  registry.unregisterTool('composio_SEARCH');
  assert.equal(registry.getTool('composio_SEARCH'), null);
  assert.equal(registry.getTool('composio_search'), lower);
});

test('AgentCore - ToolExecutor bloquea MCP directo sin autorización explícita', async () => {
  const registry = new ToolRegistry();
  registry.registerTool(makeTool({ name: 'mcp_blocked_run', category: 'mcp', execute: async () => ({ success: true }) }));

  const result = await new ToolExecutor(registry).executeToolCall(call('mcp_blocked_run'));

  assert.equal(result.success, false);
  assert.match(result.error, /explicit user authorization/i);
});

test('AgentCore - ToolExecutor captura errores, herramientas inexistentes y argumentos no JSON sin ejecutar la herramienta', async () => {
  let executed = false;
  const registry = new ToolRegistry();
  registry.registerTool(makeTool({ name: 'failing_tool', execute: async () => { throw new Error('Fallo crítico simulado'); } }));
  registry.registerTool(makeTool({ name: 'guarded_tool', execute: async () => { executed = true; return { success: true }; } }));
  const executor = new ToolExecutor(registry);

  const failRes = await executor.executeToolCall(call('failing_tool'));
  assert.equal(failRes.success, false);
  assert.equal(failRes.error, 'Fallo crítico simulado');
  assert.ok(failRes.executionTimeMs >= 0);

  const notFoundRes = await executor.executeToolCall(call('non_existent_tool'));
  assert.equal(notFoundRes.success, false);
  assert.match(notFoundRes.error, /not registered/);

  const badArgs = await executor.executeToolCall(call('guarded_tool', 'code = "alert(1)'));
  assert.equal(executed, false);
  assert.equal(badArgs.success, false);
  assert.match(badArgs.error, /Invalid tool arguments/);

  assert.equal(executor.parseArguments('url: "https://example.com"'), null);
  assert.equal(executor.parseArguments('[1, 2]'), null);
  assert.equal(executor.parseArguments('"texto"'), null);
  assert.deepEqual(executor.parseArguments(''), {});
  assert.deepEqual(executor.parseArguments('{"a":1}'), { a: 1 });
});

test('AgentCore - ToolExecutor no ejecuta una herramienta tras cancelar el turno', async () => {
  let executed = false;
  const registry = new ToolRegistry();
  registry.registerTool(makeTool({ name: 'slow_tool', execute: async () => { executed = true; return { success: true }; } }));
  const controller = new AbortController();
  controller.abort();

  const res = await new ToolExecutor(registry).executeToolCall(call('slow_tool'), { signal: controller.signal });

  assert.equal(executed, false);
  assert.equal(res.success, false);
  assert.match(res.error, /cancelled/i);
});

test('AgentCore - el despacho serializa el resultado y el Markdown con el contrato de la herramienta', async () => {
  const registry = new ToolRegistry();
  registry.registerTool(makeTool({
    name: 'delegated_result',
    execute: async () => ({ success: true, payload: 42 }),
    result: {
      toModel: (_args, result) => `model:${result.payload}`,
      toMarkdown: (_args, result) => `> export:${result.payload}`
    }
  }));
  registry.registerTool(makeTool({ name: 'default_result', execute: async () => ({ success: true, value: 'x' }) }));
  const executor = new ToolExecutor(registry);

  const custom = await executor.dispatchToolCall(call('delegated_result'));
  assert.equal(custom.resultText, 'model:42');
  assert.equal(custom.markdownBlock, '> export:42');

  const fallback = await executor.dispatchToolCall(call('default_result'));
  assert.equal(fallback.resultText, '{"success":true,"value":"x"}');
  assert.match(fallback.markdownBlock, /\*\*default_result\*\*/);
});

test('AgentCore - la detección de bucles ignora el orden de las claves pero no el de las llamadas', () => {
  const agent = AgentCore.runtime;
  const tc1 = { function: { name: 'search_web', arguments: '{"query":"ceuta"}' } };
  const tcDiff = { function: { name: 'search_web', arguments: '{"query":"melilla"}' } };
  const tcOrdered = { function: { name: 'search_web', arguments: '{"query":"ceuta","filters":{"language":"es","year":2026}}' } };
  const tcReordered = { function: { name: 'search_web', arguments: '{"filters":{"year":2026,"language":"es"},"query":"ceuta"}' } };

  assert.equal(agent.getToolCallFingerprint(tc1), agent.getToolCallFingerprint({ function: { ...tc1.function } }));
  assert.notEqual(agent.getToolCallFingerprint(tc1), agent.getToolCallFingerprint(tcDiff));
  assert.equal(agent.getToolCallFingerprint(tcOrdered), agent.getToolCallFingerprint(tcReordered));
  assert.notEqual(agent.getToolBatchFingerprint([tc1, tcDiff]), agent.getToolBatchFingerprint([tcDiff, tc1]));
});

test('AgentCore - las definiciones y la guía del prompt siguen los interruptores y la disponibilidad', () => {
  const registry = new ToolRegistry();
  const config = enabledTools => ConfigStore.normalize({ enabledTools });

  const names = registry.getActiveDefinitions(config({ search_web: false, download_doc: false })).map(d => d.function.name);
  assert.ok(names.includes('execute_javascript'));
  assert.ok(names.includes('fetch_web_page'));
  assert.ok(!names.includes('search_web'));
  assert.ok(!names.includes('download_doc'));
  // Las de conocimiento local no tienen interruptor: dependen de que haya ramas RAG activas.
  assert.ok(!names.includes('list_documents'));
  const ragNames = registry.getActiveDefinitions(ConfigStore.normalize({ activeRagBranchIds: ['branch_1'] })).map(d => d.function.name);
  for (const name of ['list_documents', 'search_knowledge_base', 'read_knowledge_chunk', 'read_knowledge_image']) {
    assert.ok(ragNames.includes(name), name);
  }

  const guide = registry.getActivePromptGuide(config({ search_web: false, download_doc: false }));
  assert.match(guide, /AVAILABLE TOOLS AND FUNCTIONS/);
  assert.match(guide, /execute_javascript/);
  assert.doesNotMatch(guide, /search_web/);
  assert.match(guide, new RegExp(AgentCore.TOOL_WORKFLOW_INSTRUCTION.slice(0, 30).replace(/[*]/g, '\\*')));

  // La herramienta de navegación de Ajustes › Navegador: browser_action o Playwright MCP, nunca los
  // dos, aunque el interruptor general de browser_action esté apagado.
  registry.registerTool(makeTool({ name: 'browser_action', category: 'mcp', settings: { showInSettings: true }, metadata: { mcpServerId: 'mcp_proxy' }, execute: async () => '' }));
  registry.registerTool(makeTool({ name: 'playwright_browser_click', category: 'mcp', settings: { showInSettings: true }, metadata: { mcpServerId: 'playwright' }, execute: async () => '' }));
  const browserTools = browser => registry.getActiveDefinitions(ConfigStore.normalize({ browser, enabledTools: { browser_action: false } }))
    .map(d => d.function.name).filter(name => ['browser_action', 'playwright_browser_click'].includes(name));
  assert.deepEqual(browserTools('browser_action'), ['browser_action']);
  assert.deepEqual(browserTools('playwright'), ['playwright_browser_click']);
  assert.deepEqual(browserTools('none'), []);
  assert.deepEqual(browserTools('otro'), ['browser_action'], 'Un valor desconocido toma el predeterminado');
  // El perfil que exige Playwright MCP manda sobre la herramienta de Ajustes; uno no válido no exige nada.
  const profileTools = playwrightBrowser => registry.getActiveDefinitions(ConfigStore.normalize({ browser: 'none', playwrightBrowser }))
    .map(d => d.function.name).filter(name => ['browser_action', 'playwright_browser_click'].includes(name));
  assert.deepEqual(profileTools({ mode: 'user', userBrowser: 'chromium' }), ['playwright_browser_click']);
  assert.deepEqual(profileTools({ mode: 'own', engine: 'opera' }), []);
});
