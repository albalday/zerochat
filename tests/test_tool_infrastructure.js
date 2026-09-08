const test = require('node:test');
const assert = require('node:assert/strict');

const ToolRuntime = require('../js/tools/tool-runtime.js');
const ToolManifest = require('../js/tools/tool-manifest.js');
const AgentCore = require('../js/agent-core.js');

test('Tool infrastructure - crea un contexto estándar con servicios inyectables', () => {
  const sandbox = { execute: () => ({ success: true }) };
  const context = ToolRuntime.createToolExecutionContext({
    lang: 'en',
    signal: 'signal_test',
    config: { enabledTools: { test_tool: true } }
  }, { sandbox });

  assert.equal(context.language, 'en');
  assert.equal(context.signal, 'signal_test');
  assert.equal(context.services.sandbox, sandbox);
  assert.equal(context.config.enabledTools.test_tool, true);
  assert.ok(Object.prototype.hasOwnProperty.call(context.services, 'webSearch'));
});

test('Tool infrastructure - manifiesto registra módulos por id sin duplicados', () => {
  const manifest = new ToolManifest.ToolModuleManifest({ id: 'test' });
  const toolModule = { id: 'example_tool' };

  assert.equal(manifest.register(toolModule), toolModule);
  assert.equal(manifest.has('example_tool'), true);
  assert.equal(manifest.get('example_tool'), toolModule);
  assert.deepEqual(manifest.list(), [toolModule]);
  assert.throws(() => manifest.register(toolModule), /ya está registrado/);
  assert.throws(() => manifest.register({}), /id válido/);
});

test('Tool infrastructure - el ejecutor entrega el contexto estándar a la tool', async () => {
  const registry = new AgentCore.ToolRegistry();
  const sandbox = { execute: () => ({ success: true }) };
  registry.registerTool(new AgentCore.Tool({
    name: 'context_probe',
    description: 'Comprueba el contexto estándar.',
    parameters: { type: 'object', properties: {} },
    settings: { showInSettings: false },
    execute: async (_args, context) => ({
      success: true,
      language: context.language,
      hasSandbox: context.services.sandbox === sandbox
    })
  }));

  const result = await new AgentCore.ToolExecutor(registry).executeToolCall({
    function: { name: 'context_probe', arguments: '{}' }
  }, { lang: 'en', services: { sandbox } });

  assert.equal(result.result.language, 'en');
  assert.equal(result.result.hasSandbox, true);
});

test('Tool infrastructure - registra read_knowledge_image solo con RAG activo', () => {
  const tool = AgentCore.registry.getTool('read_knowledge_image');
  assert.ok(tool);
  assert.equal(tool.isAvailable({}), false);
  assert.equal(tool.isAvailable({ activeRagBranchId: 'branch_1' }), true);
  assert.match(tool.description, /native vision/);
});
