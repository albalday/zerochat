const test = require('node:test');
const assert = require('node:assert/strict');

const AgentCore = require('../../js/agent-core.js');

test('Tool contract - exige el contrato declarativo sin aliases legacy', () => {
  const tool = new AgentCore.Tool({
    name: 'legacy_echo',
    description: 'Devuelve el texto recibido.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text']
    },
    settings: { showInSettings: true, defaultEnabled: false },
    execute: async ({ text }) => ({ success: true, text })
  });

  const validation = AgentCore.validateToolContract(tool);
  assert.equal(validation.valid, true, validation.errors.join(' '));
  assert.equal(tool.contractVersion, AgentCore.TOOL_CONTRACT_VERSION);
  assert.equal(tool.settings.defaultEnabled, false);
  assert.equal(tool.ui, undefined);
  assert.deepEqual(tool.getDefinition().function.parameters.required, ['text']);
});

test('Tool contract - acepta la API declarativa para futuras tools autocontenidas', async () => {
  const registry = new AgentCore.ToolRegistry();
  const tool = new AgentCore.Tool({
    definition: {
      name: 'contract_echo',
      description: 'Devuelve el texto con una serialización propia.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text']
      }
    },
    settings: { showInSettings: false },
    execute: async ({ text }) => ({ success: true, value: text }),
    result: {
      toModel: (_args, result) => result.value,
      toMarkdown: (_args, result) => `> ${result.value}`
    }
  });

  registry.registerTool(tool);
  const execution = await new AgentCore.ToolExecutor(registry).executeToolCall({
    function: { name: 'contract_echo', arguments: '{"text":"hola"}' }
  });

  assert.equal(execution.success, true);
  assert.equal(execution.outcome.ok, true);
  assert.equal(execution.outcome.data.value, 'hola');
  assert.equal(execution.outcome.meta.toolId, 'contract_echo');
  assert.equal(tool.serializeResultForModel({}, execution.result, execution.outcome), 'hola');
  assert.equal(tool.formatDispatchMarkdown({}, execution.result), '> hola');
});

test('Tool contract - rechaza módulos incompletos antes de registrarlos', () => {
  const registry = new AgentCore.ToolRegistry();
  const invalidTool = { id: 'invalid', name: 'invalid' };

  const validation = AgentCore.validateToolContract(invalidTool);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.length > 0);
  assert.throws(() => registry.registerTool(invalidTool), /Contrato de herramienta inválido/);
});

test('Tool contract - normaliza errores y herramientas no encontradas', async () => {
  const registry = new AgentCore.ToolRegistry();
  const execution = await new AgentCore.ToolExecutor(registry).executeToolCall({
    function: { name: 'missing_contract_tool', arguments: '{}' }
  });

  assert.equal(execution.success, false);
  assert.equal(execution.outcome.ok, false);
  assert.match(execution.outcome.error, /no encontrada/i);
  assert.equal(execution.outcome.meta.toolName, 'missing_contract_tool');
});

test('Tool contract - el dispatcher delega serialización y exportación en la tool', async () => {
  const registry = new AgentCore.ToolRegistry();
  registry.registerTool(new AgentCore.Tool({
    name: 'delegated_result',
    description: 'Comprueba la delegación de resultados.',
    parameters: { type: 'object', properties: {} },
    settings: { showInSettings: false },
    execute: async () => ({ success: true, payload: 42 }),
    result: {
      toModel: (_args, result) => `model:${result.payload}`,
      toMarkdown: (_args, result) => `> export:${result.payload}`
    }
  }));

  const response = await new AgentCore.ToolExecutor(registry).dispatchToolCall({
    function: { name: 'delegated_result', arguments: '{}' }
  });

  assert.equal(response.resultText, 'model:42');
  assert.equal(response.markdownBlock, '> export:42');
});
