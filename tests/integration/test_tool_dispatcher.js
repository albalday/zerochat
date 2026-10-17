const test = require('node:test');
const assert = require('node:assert/strict');

// Cargar módulos
const AgentCore = require('../../js/agent-core.js');
const { createCardView } = require('../helpers/turn-view.js');

test('ToolDispatcher - getActiveDefinitions excluye todas las herramientas RAG si RAG no está activo', () => {
  const defsWithoutRag = AgentCore.registry.getActiveDefinitions({
    activeRagBranchIds: []
  });

  const listDocsTool = defsWithoutRag.find(d => d.function?.name === 'list_documents');
  const searchKbTool = defsWithoutRag.find(d => d.function?.name === 'search_knowledge_base');
  const readChunkTool = defsWithoutRag.find(d => d.function?.name === 'read_knowledge_chunk');

  assert.equal(listDocsTool, undefined, 'list_documents NO debe enviarse si RAG está inactivo');
  assert.equal(searchKbTool, undefined, 'search_knowledge_base NO debe enviarse si RAG está inactivo');
  assert.equal(readChunkTool, undefined, 'read_knowledge_chunk NO debe enviarse si RAG está inactivo');

  const defsWithRag = AgentCore.registry.getActiveDefinitions({
    activeRagBranchIds: ['branch_123']
  });

  const listDocsActive = defsWithRag.find(d => d.function?.name === 'list_documents');
  const searchKbActive = defsWithRag.find(d => d.function?.name === 'search_knowledge_base');
  const readChunkActive = defsWithRag.find(d => d.function?.name === 'read_knowledge_chunk');

  assert.ok(listDocsActive, 'list_documents DEBE enviarse cuando RAG está activo');
  assert.ok(searchKbActive, 'search_knowledge_base DEBE enviarse cuando RAG está activo');
  assert.ok(readChunkActive, 'read_knowledge_chunk DEBE enviarse cuando RAG está activo');
});


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
