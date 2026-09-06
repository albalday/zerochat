const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  BaseProviderAdapter,
  ClaudeProviderAdapter,
  GeminiProviderAdapter,
  OpenRouterProviderAdapter
} = require('../js/providers.js');
const ChatState = require('../js/state.js');
const ChatProfileRepository = require('../js/profile-repository.js');
const ChatConfig = require('../js/config-store.js');
const ChatEngine = require('../js/chat-engine.js');

test('ContextCache - Jerarquía de prefijo en system prompt coloca base primero y fecha/RAG al final', () => {
  const history = [{ role: 'user', content: 'Consulta 1' }];
  const config = {
    systemPrompt: 'INSTRUCCION_BASE_MAESTRA',
    systemDataPrompt: 'FORMATO_PLANO',
    sendDateTime: true
  };
  const effective = ChatEngine.buildEffectiveMessages(history, config, {
    currentRagSystemContext: 'CONTEXTO_RAG_VARIABLE'
  });

  const sys = effective.find(m => m.role === 'system');
  assert.ok(sys, 'Debe haber un system prompt');
  
  const baseIdx = sys.content.indexOf('INSTRUCCION_BASE_MAESTRA');
  const ragIdx = sys.content.indexOf('CONTEXTO_RAG_VARIABLE');
  const dateIdx = sys.content.indexOf('Fecha de inicio de la conversación');

  assert.ok(baseIdx !== -1, 'Debe contener la instrucción base');
  assert.ok(ragIdx !== -1, 'Debe contener el contexto RAG');
  assert.ok(dateIdx !== -1, 'Debe contener la fecha de inicio');

  // Verificar jerarquía de estabilidad de prefijo: Base < RAG < Fecha
  assert.ok(baseIdx < ragIdx, 'Las instrucciones base deben preceder al contexto RAG');
  assert.ok(ragIdx < dateIdx, 'El contexto RAG debe preceder al ancla de fecha final');
});

test('ContextCache - ClaudeAdapter genera cabeceras nativas y ubica cache_control en el último turno de tool', () => {
  const adapter = new ClaudeProviderAdapter();
  const headers = adapter.buildHeaders('sk-ant-test-key-123');

  assert.equal(headers['anthropic-version'], '2023-06-01', 'Debe incluir la cabecera anthropic-version');
  assert.equal(headers['x-api-key'], 'sk-ant-test-key-123', 'Debe incluir x-api-key para la API directa');
  assert.equal(headers['Authorization'], 'Bearer sk-ant-test-key-123', 'Debe mantener Authorization para compatibilidad proxy');

  // En un bucle agéntico con turnos de tools, el último turno procesable es el resultado de la herramienta
  const payload = adapter.buildPayload({
    model: 'claude-3-7-sonnet-20250219',
    messages: [
      { role: 'system', content: 'Eres un asistente' },
      { role: 'user', content: '¿Qué hora es?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_current_datetime', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '2026-09-06T07:00:00Z' }
    ],
    toolsList: [{ type: 'function', function: { name: 'get_current_datetime' } }]
  });

  // Tools deben tener cache_control
  assert.ok(payload.tools[0].cache_control, 'La herramienta debe tener cache_control');
  // System debe tener cache_control
  assert.ok(payload.system[0].cache_control, 'El system prompt debe tener cache_control');
  // El último mensaje (tool response) debe ser el que tenga cache_control
  const lastMsg = payload.messages[payload.messages.length - 1];
  assert.equal(lastMsg.role, 'tool');
  assert.ok(Array.isArray(lastMsg.content), 'El mensaje debe haberse convertido en array con partes de contenido');
  assert.ok(lastMsg.content[0].cache_control, 'El resultado de la herramienta debe tener cache_control para el siguiente turno');
});

test('ContextCache - OpenRouterAdapter respeta el límite de 4 breakpoints y soporta contenido multimodal', () => {
  const adapter = new OpenRouterProviderAdapter();

  const messages = [
    { role: 'system', content: 'Instrucción 1' },
    { role: 'system', content: 'Instrucción 2' },
    { role: 'user', content: [{ type: 'text', text: 'Analiza esta imagen:' }, { type: 'image_url', image_url: { url: 'https://ejemplo.com/img.png' } }] }
  ];

  const toolsList = [
    { type: 'function', function: { name: 'tool_a' } },
    { type: 'function', function: { name: 'tool_b' } }
  ];

  const payload = adapter.buildPayload({
    model: 'anthropic/claude-3.5-sonnet',
    messages,
    toolsList
  });

  // Contar breakpoints generados
  let count = 0;
  if (payload.tools) {
    payload.tools.forEach(t => { if (t.cache_control) count++; });
  }
  payload.messages.forEach(m => {
    if (Array.isArray(m.content)) {
      m.content.forEach(p => { if (p.cache_control) count++; });
    }
  });

  assert.ok(count <= 4, `No debe exceder 4 puntos efímeros de caché (actual: ${count})`);
  // Verificar que el último mensaje user con array multimodal preservó ambas partes y marcó la última
  const userMsg = payload.messages.find(m => m.role === 'user');
  assert.ok(Array.isArray(userMsg.content));
  assert.equal(userMsg.content.length, 2);
  assert.ok(userMsg.content[1].cache_control, 'La última parte de la entrada multimodal debe tener cache_control');
});

test('ContextCache - GeminiAdapter declara promptCaching: true y no inyecta stream_options en streaming false', () => {
  const adapter = new GeminiProviderAdapter();
  const caps = adapter.getCapabilities();
  assert.equal(caps.promptCaching, true, 'Gemini debe declarar promptCaching true');

  const payloadSync = adapter.buildPayload({
    model: 'gemini-2.0-flash',
    messages: [{ role: 'user', content: 'Hola' }],
    stream: false
  });
  assert.equal(payloadSync.stream_options, undefined, 'No debe inyectar stream_options en stream false');
});

test('ContextCache - Normalización de métricas de tokens en ChatAPI para OpenAI y Anthropic', () => {
  // Simular evento con formato OpenAI
  const openaiChunk = {
    usage: {
      prompt_tokens: 120,
      completion_tokens: 45,
      total_tokens: 165,
      prompt_tokens_details: { cached_tokens: 90 }
    }
  };
  const baseAdapter = new BaseProviderAdapter();
  const parsedOpenai = baseAdapter.parseStreamChunk(openaiChunk);
  assert.equal(parsedOpenai.cachedTokens, 90);
  assert.equal(parsedOpenai.usage.prompt_tokens, 120);

  // Simular evento con formato Anthropic (input_tokens / output_tokens)
  const claudeChunk = {
    type: 'message_start',
    message: {
      usage: {
        input_tokens: 500,
        output_tokens: 80,
        cache_read_input_tokens: 400,
        cache_creation_input_tokens: 100
      }
    }
  };
  const claudeAdapter = new ClaudeProviderAdapter();
  const parsedClaude = claudeAdapter.parseStreamChunk(claudeChunk);
  assert.equal(parsedClaude.cachedTokens, 400);
  assert.equal(parsedClaude.cacheCreationTokens, 100);
});

test('ContextCache - Arquitectura: Perfiles de conexión persisten en config y la ejecución solo lee ChatState.config', () => {
  // 1. Simular repositorio de perfiles con enableContextCache
  const mockStorage = {
    data: {},
    getStorageItem(k) { return this.data[k] || null; },
    setStorageItem(k, v) { this.data[k] = v; },
    saveRuntimeConfigV2(c) { this.data['runtime_config'] = JSON.stringify(c); },
    loadRuntimeConfigV2() { return this.data['runtime_config'] ? JSON.parse(this.data['runtime_config']) : null; }
  };

  const profileRepo = ChatProfileRepository.createRepository(mockStorage);
  const profiles = profileRepo.list();
  assert.ok(profiles.length >= 2);
  assert.equal(profiles[0].settings.enableContextCache, true);

  // 2. Modificar el perfil para desactivar la caché mediante save
  const targetProfile = profiles[0];
  const updated = profileRepo.save({
    ...targetProfile,
    settings: { ...targetProfile.settings, enableContextCache: false }
  });
  assert.equal(updated.settings.enableContextCache, false);

  // 3. Al activar el perfil en ChatConfig, se vuelca en ChatState.config
  const customStore = ChatConfig.createConfigStore({
    storage: mockStorage,
    profiles: profileRepo,
    state: ChatState
  });

  const activeConfig = customStore.activateProfile(targetProfile.id);
  assert.equal(activeConfig.enableContextCache, false);

  // 4. La ejecución sólo consulta el estado general (ChatState / ChatConfig)
  const stateConfig = ChatState.get('config');
  assert.equal(stateConfig.enableContextCache, false, 'El estado general debe contener el valor sincronizado del perfil');
});
