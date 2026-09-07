const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const AgentCore = require('../js/agent-core.js');
const ContextManager = require('../js/context-manager.js');
const State = require('../js/state.js');
const I18n = require('../js/i18n.js');
const UIReasoning = require('../js/ui-reasoning.js');
const AgentCheckpointTool = require('../js/tools/builtin/agent-checkpoint.tool.js');

test('AgentCheckpoint Tool - Cumple con el contrato declarativo, registro y defaultEnabled: false', () => {
  const tool = AgentCheckpointTool.createTool(AgentCore.Tool);
  const validation = AgentCore.validateToolContract(tool);

  assert.equal(validation.valid, true, `Validación de contrato fallida: ${validation.errors.join(' ')}`);
  assert.equal(tool.name, 'agent_checkpoint');
  assert.equal(tool.category, 'agent');
  assert.equal(tool.settings.defaultEnabled, false, 'agent_checkpoint debe estar desactivado por defecto');
  assert.ok(tool.aliases.includes('checkpoint'));
  assert.ok(tool.parameters.properties.findings);
  assert.ok(tool.parameters.properties.ready_to_respond);
});

test('AgentCheckpoint Tool - ChatState tiene agent_checkpoint desactivado por defecto', () => {
  const store = State.createStore();
  const state = store.getState();
  assert.equal(state.config.enabledTools.agent_checkpoint, false, 'enabledTools.agent_checkpoint debe ser false en el estado inicial');
});

test('AgentCheckpoint Tool - getActiveDefinitions excluye agent_checkpoint por defecto y lo incluye al activarlo', () => {
  const defsDefault = AgentCore.registry.getActiveDefinitions({
    enabledTools: { agent_checkpoint: false }
  });
  const hasCheckpointDefault = defsDefault.some(d => d.function?.name === 'agent_checkpoint');
  assert.equal(hasCheckpointDefault, false, 'No debe incluirse cuando está desactivado');

  const defsEnabled = AgentCore.registry.getActiveDefinitions({
    enabledTools: { agent_checkpoint: true }
  });
  const hasCheckpointEnabled = defsEnabled.some(d => d.function?.name === 'agent_checkpoint');
  assert.equal(hasCheckpointEnabled, true, 'Debe incluirse cuando está activado explícitamente');
});

test('AgentCheckpoint Tool - Consejos de RAG mencionan la activación del punto de control en es y en', () => {
  const tipEs = I18n.TRANSLATIONS.es.rag_active_tip_desc;
  const tipEn = I18n.TRANSLATIONS.en.rag_active_tip_desc;

  assert.ok(tipEs.includes('agent_checkpoint'), 'El consejo en español debe mencionar agent_checkpoint');
  assert.ok(tipEs.includes('Punto de Control'), 'El consejo en español debe mencionar Punto de Control');

  assert.ok(tipEn.includes('agent_checkpoint'), 'El consejo en inglés debe mencionar agent_checkpoint');
  assert.ok(tipEn.includes('Agent Checkpoint'), 'El consejo en inglés debe mencionar Agent Checkpoint');
});

test('AgentCheckpoint Tool - UIReasoning syncCheckpointToggle sincroniza y notifica cambios', () => {
  let toggledValue = null;
  const mockCheckbox = {
    checked: false,
    _listeners: {},
    addEventListener(event, handler) {
      this._listeners[event] = handler;
    },
    dispatchEvent(event) {
      if (this._listeners[event]) this._listeners[event]({ target: this });
    }
  };

  const mockElements = {
    chkReasoningAgentCheckpoint: mockCheckbox
  };

  UIReasoning.syncCheckpointToggle(mockElements, false, (val) => { toggledValue = val; });
  assert.equal(mockCheckbox.checked, false);

  UIReasoning.syncCheckpointToggle(mockElements, true, (val) => { toggledValue = val; });
  assert.equal(mockCheckbox.checked, true);

  mockCheckbox.checked = false;
  mockCheckbox.dispatchEvent('change');
  assert.equal(toggledValue, false);
});

test('AgentCheckpoint Tool - Ejecución con ready_to_respond: true (conclude)', async () => {
  const tool = AgentCheckpointTool.createTool(AgentCore.Tool);
  let compactCalled = false;

  const args = {
    findings: 'Se confirmó que el ratio de liquidez es 1.45 y la deuda neta bajó un 12%.',
    ready_to_respond: true
  };

  const context = {
    compactHistory: () => { compactCalled = true; }
  };

  const result = await tool.execute(args, context);

  assert.equal(result.success, true);
  assert.equal(result.action, 'conclude');
  assert.equal(result.status, 'acknowledged');
  assert.equal(result.findings, args.findings);
  assert.ok(result.guidance.includes('respuesta final'));
  assert.equal(compactCalled, true, 'Debe invocar context.compactHistory');

  const serialized = tool.serializeResultForModel(args, result);
  assert.ok(serialized.includes('conclude'));
  assert.ok(serialized.includes(args.findings));
});

test('AgentCheckpoint Tool - Ejecución con ready_to_respond: false (continue)', async () => {
  const tool = AgentCheckpointTool.createTool(AgentCore.Tool);
  let compactedArgs = null;

  const args = {
    findings: 'Se obtuvo el balance del año 2023.',
    missing_info: 'Falta el desglose por trimestres del 2024.',
    next_action: 'search_knowledge_base(query="desglose trimestres 2024")',
    ready_to_respond: false
  };

  const context = {
    compactHistory: (info) => { compactedArgs = info; }
  };

  const result = await tool.execute(args, context);

  assert.equal(result.success, true);
  assert.equal(result.action, 'continue');
  assert.equal(result.missing_info, args.missing_info);
  assert.equal(result.next_action, args.next_action);
  assert.ok(result.guidance.includes(args.next_action));
  assert.deepEqual(compactedArgs, { findings: args.findings, isReady: false });
});

test('ContextManager - compactToolHistory compacta mensajes de herramientas conservando tool_call_id', () => {
  const messages = [
    { id: 'msg_1', role: 'user', content: 'Analiza el documento y compara ventas.' },
    {
      id: 'msg_2',
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_rag_1', function: { name: 'search_knowledge_base', arguments: '{"query":"ventas"}' } }]
    },
    {
      id: 'msg_3',
      role: 'tool',
      tool_call_id: 'call_rag_1',
      name: 'search_knowledge_base',
      content: 'A'.repeat(5000) // Payload extenso de 5000 chars
    },
    {
      id: 'msg_4',
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_cp_1', function: { name: 'agent_checkpoint', arguments: '{"findings":"Ventas subieron 10%","ready_to_respond":true}' } }]
    },
    {
      id: 'msg_5',
      role: 'tool',
      tool_call_id: 'call_cp_1',
      name: 'agent_checkpoint',
      content: JSON.stringify({ success: true, action: 'conclude', findings: 'Ventas subieron 10%' })
    }
  ];

  const compacted = ContextManager.compactToolHistory(messages);

  assert.equal(compacted.length, messages.length);
  assert.equal(compacted[0].content, messages[0].content);
  assert.equal(compacted[1].tool_calls[0].id, 'call_rag_1');

  // El mensaje tool extenso debe haber sido compactado
  assert.equal(compacted[2].role, 'tool');
  assert.equal(compacted[2].tool_call_id, 'call_rag_1');
  assert.equal(compacted[2].name, 'search_knowledge_base');
  assert.ok(compacted[2].content.length < 300);
  assert.ok(compacted[2].content.includes('compactada en punto de control'));
  assert.equal(compacted[2]._compactedByCheckpoint, true);

  // El mensaje de agent_checkpoint no debe ser truncado
  assert.equal(compacted[4].name, 'agent_checkpoint');
  assert.ok(compacted[4].content.includes('Ventas subieron 10%'));
});
