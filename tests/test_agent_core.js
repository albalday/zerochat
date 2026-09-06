const test = require('node:test');
const assert = require('node:assert/strict');

// Cargar módulos
const AgentCoreModule = require('../js/agent-core.js');

test('AgentCore - Tool & ToolRegistry registro y resolución de herramientas y alias', () => {
  const registry = new AgentCoreModule.ToolRegistry();

  // Comprobar que las herramientas nativas están registradas
  assert.ok(registry.hasTool('execute_javascript'));
  assert.ok(registry.hasTool('search_web'));
  assert.ok(registry.hasTool('fetch_web_page'));
  assert.ok(registry.hasTool('download_pdf'));
  assert.ok(registry.hasTool('render_chart'));

  // Comprobar resolución por alias
  assert.equal(registry.getTool('executejs').name, 'execute_javascript');
  assert.equal(registry.getTool('run_js').name, 'execute_javascript');
  assert.equal(registry.getTool('searchweb').name, 'search_web');
  assert.equal(registry.getTool('fetchwebpage').name, 'fetch_web_page');
  assert.equal(registry.getTool('downloadpdf').name, 'download_pdf');
  assert.equal(registry.getTool('renderchart').name, 'render_chart');

  // Comprobar generación de esquemas Function Calling
  const defs = registry.getDefinitions();
  assert.ok(defs.length >= 5);
  const jsDef = defs.find(d => d.function.name === 'execute_javascript');
  assert.ok(jsDef);
  assert.equal(jsDef.type, 'function');
  assert.ok(jsDef.function.parameters.required.includes('code'));
});

test('AgentCore - Registro de herramientas personalizadas (ToolProvider preparado para MCP)', async () => {
  const registry = new AgentCoreModule.ToolRegistry();

  class CustomMcpMockProvider extends AgentCoreModule.BaseToolProvider {
    constructor() {
      super({ id: 'mcp_filesystem', name: 'MCP Filesystem Provider' });
    }
    getTools() {
      return [
        new AgentCoreModule.Tool({
          name: 'read_file',
          description: 'Lee un archivo del sistema de archivos mediante MCP',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Ruta al archivo' }
            },
            required: ['path']
          },
          category: 'mcp',
          execute: async (args) => {
            return { success: true, content: `Contenido de ${args.path}` };
          }
        })
      ];
    }
  }

  registry.registerProvider(new CustomMcpMockProvider());

  assert.ok(registry.hasTool('read_file'));
  const executor = new AgentCoreModule.ToolExecutor(registry);

  const res = await executor.executeToolCall({
    id: 'call_mcp_1',
    type: 'function',
    function: {
      name: 'read_file',
      arguments: JSON.stringify({ path: '/home/user/test.txt' })
    }
  });

  assert.equal(res.success, true);
  assert.equal(res.result.content, 'Contenido de /home/user/test.txt');
  assert.equal(res.toolName, 'read_file');
});

test('AgentCore - ToolExecutor parseo tolerante de argumentos y captura de errores', async () => {
  const registry = new AgentCoreModule.ToolRegistry();

  // Registrar herramienta con error forzado
  registry.registerTool(new AgentCoreModule.Tool({
    name: 'failing_tool',
    description: 'Herramienta que lanza un error deliberado',
    execute: async () => {
      throw new Error('Fallo crítico simulado');
    }
  }));

  const executor = new AgentCoreModule.ToolExecutor(registry);

  // 1. Herramienta que falla -> no debe romper el proceso, debe devolver error capturado
  const failRes = await executor.executeToolCall({
    id: 'call_fail',
    function: { name: 'failing_tool', arguments: '{}' }
  });
  assert.equal(failRes.success, false);
  assert.equal(failRes.error, 'Fallo crítico simulado');
  assert.ok(failRes.executionTimeMs >= 0);

  // 2. Herramienta no existente
  const notFoundRes = await executor.executeToolCall({
    id: 'call_unknown',
    function: { name: 'non_existent_tool', arguments: '{}' }
  });
  assert.equal(notFoundRes.success, false);
  assert.match(notFoundRes.error, /no encontrada/i);

  // 3. Parseo tolerante de argumentos con sintaxis no estricta
  const parsed1 = executor.parseArguments('url: "https://example.com"');
  assert.equal(parsed1.url, 'https://example.com');

  const parsed2 = executor.parseArguments('code = "console.log(123)"');
  assert.equal(parsed2.code, 'console.log(123)');
});

test('AgentCore - Cancelación de ejecución de herramientas mediante AbortSignal', async () => {
  const registry = new AgentCoreModule.ToolRegistry();
  registry.registerTool(new AgentCoreModule.Tool({
    name: 'slow_tool',
    execute: async (args, ctx) => {
      if (ctx.signal && ctx.signal.aborted) throw new Error('Abortado');
      return { success: true };
    }
  }));

  const executor = new AgentCoreModule.ToolExecutor(registry);
  const controller = new AbortController();
  controller.abort(); // Cancelar inmediatamente

  const res = await executor.executeToolCall({
    id: 'call_cancel',
    function: { name: 'slow_tool', arguments: '{}' }
  }, { signal: controller.signal });

  assert.equal(res.success, false);
  assert.match(res.error, /cancelada/i);
});

test('AgentCore - Detección y detención de bucles infinitos en el agente', () => {
  const agent = new AgentCoreModule.AgentCore();

  const tc1 = { function: { name: 'search_web', arguments: '{"query":"ceuta"}' } };
  const tc2 = { function: { name: 'search_web', arguments: '{"query":"ceuta"}' } };
  const tc3 = { function: { name: 'search_web', arguments: '{"query":"ceuta"}' } };
  const tcDiff = { function: { name: 'search_web', arguments: '{"query":"melilla"}' } };

  assert.equal(agent.getToolCallFingerprint(tc1), agent.getToolCallFingerprint(tc2));
  assert.notEqual(agent.getToolCallFingerprint(tc1), agent.getToolCallFingerprint(tcDiff));
});

test('AgentCore - Formal Tools Interface (listToolsForUI, getActiveDefinitions, getActivePromptGuide)', () => {
  const registry = new AgentCoreModule.ToolRegistry();

  // 1. listToolsForUI devuelve sólo las herramientas configurables en la UI
  const uiTools = registry.listToolsForUI();
  assert.ok(uiTools.length >= 5);
  const ids = uiTools.map(t => t.id);
  assert.ok(ids.includes('execute_javascript'));
  assert.ok(ids.includes('search_web'));
  assert.ok(ids.includes('fetch_web_page'));
  assert.ok(ids.includes('download_pdf'));
  assert.ok(ids.includes('render_chart'));
  // Herramientas RAG no deben aparecer en la UI de settings
  assert.ok(!ids.includes('list_documents'));

  // 2. getActiveDefinitions filtra según appConfig.enabledTools
  const allDefs = registry.getActiveDefinitions({
    enabledTools: {
      execute_javascript: true,
      search_web: true,
      fetch_web_page: true,
      download_pdf: true,
      render_chart: true
    }
  });
  const allNames = allDefs.map(d => d.function.name);
  assert.ok(allNames.includes('execute_javascript'));
  assert.ok(allNames.includes('search_web'));
  assert.ok(allNames.includes('fetch_web_page'));
  assert.ok(allNames.includes('download_pdf'));
  assert.ok(allNames.includes('render_chart'));

  // Desactivar search_web y download_pdf
  const filteredDefs = registry.getActiveDefinitions({
    enabledTools: {
      execute_javascript: true,
      search_web: false,
      fetch_web_page: true,
      download_pdf: false,
      render_chart: true
    }
  });
  const filteredNames = filteredDefs.map(d => d.function.name);
  assert.ok(!filteredNames.includes('search_web'));
  assert.ok(!filteredNames.includes('download_pdf'));
  assert.ok(filteredNames.includes('execute_javascript'));
  assert.ok(filteredNames.includes('fetch_web_page'));
  assert.ok(filteredNames.includes('render_chart'));

  // 3. getActivePromptGuide genera la guía textual dinámica en español e inglés
  const guideEs = registry.getActivePromptGuide({
    enabledTools: {
      execute_javascript: true,
      search_web: false,
      fetch_web_page: true,
      download_pdf: false,
      render_chart: true
    }
  }, 'es');
  assert.match(guideEs, /execute_javascript/);
  assert.match(guideEs, /fetch_web_page/);
  assert.doesNotMatch(guideEs, /search_web/);
  assert.doesNotMatch(guideEs, /download_pdf/);
  assert.match(guideEs, /HERRAMIENTAS Y FUNCIONES DISPONIBLES/);

  const guideEn = registry.getActivePromptGuide({
    enabledTools: {
      execute_javascript: true,
      search_web: true,
      fetch_web_page: false,
      download_pdf: false,
      render_chart: false
    }
  }, 'en');
  assert.match(guideEn, /AVAILABLE TOOLS AND FUNCTIONS/);
  assert.match(guideEn, /execute_javascript/);
  assert.match(guideEn, /search_web/);
  assert.doesNotMatch(guideEn, /fetch_web_page/);
});

test('AgentCore - Tool y ToolExecutor propagan displayMode a executionContext, meta y outcome', async () => {
  let receivedContext = null;
  const toolExpanded = new AgentCoreModule.Tool({
    name: 'custom_chart',
    description: 'Herramienta de prueba con displayMode expanded',
    displayMode: 'expanded',
    execute: async (args, context) => {
      receivedContext = context;
      return { success: true, chart: true };
    }
  });

  assert.equal(toolExpanded.displayMode, 'expanded');
  assert.equal(toolExpanded.view?.displayMode, 'expanded');

  const registry = new AgentCoreModule.ToolRegistry();
  registry.registerTool(toolExpanded);

  const executor = new AgentCoreModule.ToolExecutor(registry);
  const result = await executor.executeToolCall({
    function: { name: 'custom_chart', arguments: '{}' }
  });

  assert.equal(result.success, true);
  assert.equal(result.displayMode, 'expanded');
  assert.equal(result.outcome?.meta?.displayMode, 'expanded');
  assert.equal(receivedContext?.displayMode, 'expanded');
});

