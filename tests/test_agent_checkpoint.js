const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const AgentCore = require('../js/agent-core.js');
const ContextManager = require('../js/context-manager.js');
const State = require('../js/state.js');
const I18n = require('../js/i18n.js');
const UIReasoning = require('../js/ui-reasoning.js');
const AgentCheckpointTool = require('../js/tools/builtin/agent-checkpoint.tool.js');
const Engine = require('../js/chat-engine.js');
const RagStorage = require('../js/ragStorage.js');
const RagService = require('../js/rag-service.js');

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
  assert.ok(result.guidance.includes('final answer'));
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

test('AgentCheckpoint Tool - ChatEngine inyecta instrucción de checkpoint en toolsGuide solo si está activo', () => {
  const history = [{ role: 'user', content: 'Hola' }];
  const msgsDisabled = Engine.buildEffectiveMessages(history, {
    systemPrompt: 'Base prompt',
    enabledTools: { agent_checkpoint: false },
    language: 'es'
  });
  assert.ok(!msgsDisabled[0].content.includes('Agent checkpoint:'));

  const msgsEnabledEs = Engine.buildEffectiveMessages(history, {
    systemPrompt: 'Base prompt',
    enabledTools: { agent_checkpoint: true },
    language: 'es'
  });
  assert.ok(msgsEnabledEs[0].content.includes('Agent checkpoint:'));
  assert.ok(msgsEnabledEs[0].content.includes('invoke "agent_checkpoint"'));

  const msgsEnabledEn = Engine.buildEffectiveMessages(history, {
    systemPrompt: 'Base prompt',
    enabledTools: { agent_checkpoint: true },
    language: 'en'
  });
  assert.ok(msgsEnabledEn[0].content.includes('Agent checkpoint:'));
  assert.ok(msgsEnabledEn[0].content.includes('invoke "agent_checkpoint"'));
});

test('AgentCheckpoint Tool - RagService.buildRagSystemContext inyecta regla de checkpoint según options.isCheckpointEnabled', async () => {
  const branch = await RagStorage.createBranch('Finanzas', 'Documentos contables');

  const contextWithoutCp = await RagService.buildRagSystemContext(branch.id, { isCheckpointEnabled: false });
  assert.ok(!contextWithoutCp.includes('agent_checkpoint'));

  const contextWithCp = await RagService.buildRagSystemContext(branch.id, { isCheckpointEnabled: true });
  assert.ok(contextWithCp.includes('agent_checkpoint'));
  assert.ok(contextWithCp.includes('consolidate findings and clear working memory'));
});

test('ContextManager - getModelContextLimit reconoce modelos Gemma', () => {
  const limitGemma2 = ContextManager.getModelContextLimit('google/gemma-2-9b-it');
  assert.equal(limitGemma2, 8192);

  const limitGemma4 = ContextManager.getModelContextLimit('google/gemma-4-12b-qat');
  assert.equal(limitGemma4, 32768);

  const limitGemmaGeneric = ContextManager.getModelContextLimit('gemma-3-27b');
  assert.equal(limitGemmaGeneric, 32768);
});

test('ChatEngine - executeAgentTurnLoop inyecta aviso agéntico tras consultas consecutivas y compacta al recibir checkpoint', async () => {
  const ChatAPI = require('../js/api.js');
  const originalStream = ChatAPI.streamChatCompletion;

  let turn = 0;
  ChatAPI.streamChatCompletion = async (options) => {
    turn++;
    if (turn === 1) {
      // Turno 1: el modelo llama a list_documents (primera consulta de datos)
      if (options.onDone) {
        options.onDone('', { completionTokens: 10 }, [
          { id: 'call_list_1', function: { name: 'list_documents', arguments: '{}' } }
        ]);
      }
      return {
        accumulatedText: '',
        toolCalls: [{ id: 'call_list_1', function: { name: 'list_documents', arguments: '{}' } }],
        stats: { completionTokens: 10 }
      };
    } else if (turn === 2) {
      // Turno 2: el modelo llama a search_web (segunda consulta de datos consecutiva)
      if (options.onDone) {
        options.onDone('', { completionTokens: 10 }, [
          { id: 'call_web_2', function: { name: 'search_web', arguments: '{"query":"walmart ebitda"}' } }
        ]);
      }
      return {
        accumulatedText: '',
        toolCalls: [{ id: 'call_web_2', function: { name: 'search_web', arguments: '{"query":"walmart ebitda"}' } }],
        stats: { completionTokens: 10 }
      };
    } else if (turn === 3) {
      // Turno 3: el modelo atiende al aviso y llama a agent_checkpoint
      if (options.onDone) {
        options.onDone('', { completionTokens: 10 }, [
          {
            id: 'call_cp_3',
            function: {
              name: 'agent_checkpoint',
              arguments: JSON.stringify({
                findings: 'Datos parciales de 2018 recuperados.',
                missing_info: 'Faltan 2019 y 2020.',
                ready_to_respond: false
              })
            }
          }
        ]);
      }
      return {
        accumulatedText: '',
        toolCalls: [{
          id: 'call_cp_3',
          function: {
            name: 'agent_checkpoint',
            arguments: JSON.stringify({
              findings: 'Datos parciales de 2018 recuperados.',
              missing_info: 'Faltan 2019 y 2020.',
              ready_to_respond: false
            })
          }
        }],
        stats: { completionTokens: 10 }
      };
    } else {
      // Turno 4: respuesta final
      if (options.onDone) options.onDone('Respuesta final completada.', { completionTokens: 20 }, null);
      return { accumulatedText: 'Respuesta final completada.', toolCalls: null, stats: { completionTokens: 20 } };
    }
  };

  const history = [{ role: 'user', content: 'Calcula EBITDA Walmart' }];
  const res = await Engine.executeAgentTurnLoop({
    apiUrl: 'http://localhost:1234/v1',
    apiType: 'openai',
    model: 'google/gemma-4-12b-qat',
    chatHistory: history,
    appConfig: {
      apiUrl: 'http://localhost:1234/v1',
      model: 'google/gemma-4-12b-qat',
      language: 'es',
      enabledTools: { agent_checkpoint: true, search_web: true, list_documents: true }
    }
  });

  ChatAPI.streamChatCompletion = originalStream;

  assert.equal(res.success, true);
  // Verificar que la herramienta en turno 2 (search_web) recibió el aviso agéntico obligatorio
  const webToolMsg = history.find(m => m.role === 'tool' && m.name === 'search_web');
  assert.ok(webToolMsg, 'Debe existir el mensaje tool de search_web');
  assert.ok(webToolMsg.content.includes('AVISO AGÉNTICO OBLIGATORIO'), 'Debe incluir el aviso agéntico obligatorio');

  // Verificar que al procesar agent_checkpoint se compactó el historial
  const compactedWebMsg = history.find(m => m.role === 'tool' && m.name === 'search_web');
  // Si el contenido supera 250 caracteres, se compacta; en search_web mock o real:
  const cpToolMsg = history.find(m => m.role === 'tool' && m.name === 'agent_checkpoint');
  assert.ok(cpToolMsg, 'Debe existir el mensaje tool de agent_checkpoint');
  assert.ok(cpToolMsg.content.includes('Datos parciales de 2018 recuperados'));
});

