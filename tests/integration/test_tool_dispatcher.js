const test = require('node:test');
const assert = require('node:assert/strict');

// Cargar módulos
const AgentCore = require('../../js/agent-core.js');
const { createCardView } = require('../helpers/turn-view.js');

test('ToolDispatcher - cada invocación recibe un invocationId propio en su contexto', async () => {
  const seen = [];
  AgentCore.registry.registerTool(new AgentCore.Tool({
    definition: { name: 'probe_invocation_id', description: 'Probe', parameters: { type: 'object', properties: {} } },
    execute: async (_args, context) => { seen.push(context.invocationId); return { success: true }; },
    result: { toModel: () => 'ok' }
  }));
  const toolCall = { id: 'call_probe', type: 'function', function: { name: 'probe_invocation_id', arguments: '{}' } };
  const cards = createCardView();
  await AgentCore.dispatchToolCall(toolCall, { cards });
  await AgentCore.dispatchToolCall(toolCall);
  assert.equal(seen.length, 2);
  assert.equal(cards.opened[0].invocationId, seen[0], 'La tarjeta lleva el invocationId de su ejecución');
  assert.ok(seen.every(id => typeof id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(id)));
  assert.notEqual(seen[0], seen[1]);
});
