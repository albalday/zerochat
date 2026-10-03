const test = require('node:test');
const assert = require('node:assert/strict');

const AgentCore = require('../../js/agent-core.js');
const State = require('../../js/state.js');
const UIReasoning = require('../../js/ui-reasoning.js');
const AgentCheckpointTool = require('../../js/tools/builtin/agent-checkpoint.tool.js');
const Engine = require('../../js/chat-engine.js');
const RagStorage = require('../../js/ragStorage.js');
const RagService = require('../../js/rag-service.js');

test('AgentCheckpoint Tool - cumple el contrato y está desactivada por defecto en el estado y en las definiciones activas', () => {
  const tool = AgentCheckpointTool.createTool(AgentCore.Tool);
  const validation = AgentCore.validateToolContract(tool);

  assert.equal(validation.valid, true, `Validación de contrato fallida: ${validation.errors.join(' ')}`);
  assert.equal(tool.name, 'agent_checkpoint');
  assert.equal(tool.category, 'agent');
  assert.equal(tool.settings.defaultEnabled, false, 'agent_checkpoint debe estar desactivado por defecto');
  assert.ok(tool.aliases.includes('checkpoint'));
  assert.ok(tool.parameters.properties.findings);
  assert.ok(tool.parameters.properties.ready_to_respond);

  const store = State.createStore();
  const state = store.getState();
  assert.equal(state.config.enabledTools.agent_checkpoint, false, 'enabledTools.agent_checkpoint debe ser false en el estado inicial');

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

test('AgentCheckpoint Tool - ejecución concluye o continúa según ready_to_respond', async () => {
  {
    const tool = AgentCheckpointTool.createTool(AgentCore.Tool);

    const args = {
      findings: 'Se confirmó que el ratio de liquidez es 1.45 y la deuda neta bajó un 12%.',
      ready_to_respond: true
    };

    const result = await tool.execute(args);

    assert.equal(result.success, true);
    assert.equal(result.action, 'conclude');
    assert.equal(result.status, 'acknowledged');
    assert.equal(result.findings, args.findings);
    assert.ok(result.guidance.includes('final answer'));

    const serialized = tool.serializeResultForModel(args, result);
    assert.ok(serialized.includes('conclude'));
    assert.ok(serialized.includes(args.findings));
  }

  {
    const tool = AgentCheckpointTool.createTool(AgentCore.Tool);

    const args = {
      findings: 'Se obtuvo el balance del año 2023.',
      missing_info: 'Falta el desglose por trimestres del 2024.',
      next_action: 'search_knowledge_base(query="desglose trimestres 2024")',
      ready_to_respond: false
    };

    const result = await tool.execute(args);

    assert.equal(result.success, true);
    assert.equal(result.action, 'continue');
    assert.equal(result.missing_info, args.missing_info);
    assert.equal(result.next_action, args.next_action);
    assert.ok(result.guidance.includes(args.next_action));
    assert.ok(!result.guidance.includes('memory compacted'));
    assert.ok(!tool.promptGuide().includes('compacts working memory'), 'La guía describe consolidación, no compactación inmediata');
  }
});

test('AgentCheckpoint Tool - ChatEngine y RagService inyectan la regla de checkpoint solo si está activo', async () => {
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

  const branch = await RagStorage.createBranch('Finanzas', 'Documentos contables');

  const contextWithoutCp = await RagService.buildRagSystemContext(branch.id, { isCheckpointEnabled: false });
  assert.ok(!contextWithoutCp.includes('agent_checkpoint'));

  const contextWithCp = await RagService.buildRagSystemContext(branch.id, { isCheckpointEnabled: true });
  assert.ok(contextWithCp.includes('agent_checkpoint'));
  assert.ok(contextWithCp.includes('consolidate findings and record the next step'));
});

test('ChatEngine - executeAgentTurnLoop no clasifica consultas para forzar checkpoints', async () => {
  const ChatAPI = require('../../js/api.js');
  const WebSearch = require('../../js/web-search.js');
  const originalStream = ChatAPI.streamChatCompletion;
  const originalSearch = WebSearch.search;
  WebSearch.search = async () => ({
    success: true,
    count: 1,
    results: [{ title: 'Walmart EBITDA', snippet: 'Walmart 2018 EBITDA was $32B', url: 'https://example.com' }],
    markdown: 'Walmart EBITDA 2018: $32B'
  });

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
      // Turno 3: el modelo puede crear el checkpoint por iniciativa propia.
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
  let res;
  try {
    res = await Engine.executeAgentTurnLoop({
      apiUrl: 'http://localhost:1234/v1',
      apiType: 'openai',
      model: 'configured-model',
      chatHistory: history,
      appConfig: {
        apiUrl: 'http://localhost:1234/v1',
        model: 'configured-model',
        language: 'es',
        enabledTools: { agent_checkpoint: true, search_web: true, list_documents: true }
      }
    });
  } finally {
    ChatAPI.streamChatCompletion = originalStream;
    WebSearch.search = originalSearch;
  }

  assert.equal(res.success, true);
  // Las herramientas se envían tal cual: el runtime no las clasifica ni les inyecta avisos.
  const webToolMsg = history.find(m => m.role === 'tool' && m.name === 'search_web');
  assert.ok(webToolMsg, 'Debe existir el mensaje tool de search_web');
  assert.ok(!webToolMsg.content.includes('MANDATORY AGENT NOTICE'));

  // Invocar la herramienta no aplica poda selectiva al historial.
  const cpToolMsg = history.find(m => m.role === 'tool' && m.name === 'agent_checkpoint');
  assert.ok(cpToolMsg, 'Debe existir el mensaje tool de agent_checkpoint');
  assert.ok(cpToolMsg.content.includes('Datos parciales de 2018 recuperados'));
});
