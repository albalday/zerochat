const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  BaseProviderAdapter,
  ClaudeProviderAdapter,
  GeminiProviderAdapter,
  OllamaProviderAdapter,
  OpenRouterProviderAdapter,
  ProviderRegistry,
  registry
} = require('../js/providers.js');

test('ProviderRegistry - Detección y resolución de adaptadores', () => {
  assert.equal(registry.detect('http://localhost:11434'), 'ollama');
  assert.equal(registry.detect('https://api.anthropic.com/v1'), 'claude');
  assert.equal(registry.detect('https://openrouter.ai/api/v1'), 'openrouter');
  assert.equal(registry.detect('https://generativelanguage.googleapis.com/v1beta/openai'), 'gemini');
  assert.equal(registry.detect('http://localhost:1234/v1'), 'openai');
  assert.equal(registry.detect('https://mi-servidor.local', 'custom'), 'custom');

  assert.equal(registry.resolve('https://api.anthropic.com/v1').id, 'claude');
  assert.equal(registry.resolve('http://localhost:11434').id, 'ollama');
  assert.equal(registry.resolve('http://localhost:1234/v1').id, 'openai');
});

test('OpenAIAdapter - Normalización de endpoint y payload', () => {
  const adapter = new BaseProviderAdapter();
  assert.equal(adapter.normalizeEndpoint('http://localhost:1234/v1'), 'http://localhost:1234/v1/chat/completions');
  assert.equal(adapter.normalizeEndpoint('http://localhost:1234/v1/chat/completions'), 'http://localhost:1234/v1/chat/completions');

  const payload = adapter.buildPayload({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'Hola' }],
    reasoningEffort: 'medium',
    enableContextCache: false
  });

  assert.equal(payload.model, 'gpt-4o');
  assert.equal(payload.stream, true);
  assert.equal(payload.reasoning_effort, 'medium');
  assert.deepEqual(payload.stream_options, { include_usage: true });
});

test('OpenAIAdapter - Parseo de chunks SSE con razonamiento y tools', () => {
  const adapter = new BaseProviderAdapter();
  
  // Chunk con razonamiento
  const rChunk = adapter.parseStreamChunk({
    choices: [{ delta: { reasoning_content: 'Pensando paso 1...' } }]
  });
  assert.equal(rChunk.reasoningChunk, 'Pensando paso 1...');
  assert.equal(rChunk.textChunk, '');

  // Chunk con texto
  const tChunk = adapter.parseStreamChunk({
    choices: [{ delta: { content: 'Respuesta' } }]
  });
  assert.equal(tChunk.textChunk, 'Respuesta');

  // Chunk con tool calls
  const toolChunk = adapter.parseStreamChunk({
    choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'search_web', arguments: '{"q":"test"}' } }] } }]
  });
  assert.equal(toolChunk.toolCallDeltas.length, 1);
  assert.equal(toolChunk.toolCallDeltas[0].function.name, 'search_web');

  // Chunk con usage
  const uChunk = adapter.parseStreamChunk({
    usage: { prompt_tokens_details: { cached_tokens: 1500 }, total_tokens: 2000 }
  });
  assert.equal(uChunk.cachedTokens, 1500);
});

test('OpenAIAdapter - Auto-recuperación de errores HTTP 400', () => {
  const adapter = new BaseProviderAdapter();
  const payload = { model: 'test', reasoning_effort: 'high', tools: [{ type: 'function' }] };

  // Rechazo de razonamiento
  const rec1 = adapter.handleHttpError(400, "Unknown parameter 'reasoning_effort'", payload);
  assert.equal(rec1.retry, true);
  assert.equal(payload.reasoning_effort, undefined);

  // Rechazo de tools
  const rec2 = adapter.handleHttpError(400, "Server does not support tools/functions", payload);
  assert.equal(rec2.retry, true);
  assert.equal(payload.tools, undefined);
});

test('ClaudeAdapter - Formato de mensajes, presupuesto de thinking y caché efímera', () => {
  const adapter = new ClaudeProviderAdapter();
  assert.equal(adapter.normalizeEndpoint('https://api.anthropic.com/v1'), 'https://api.anthropic.com/v1/messages');

  // Formateo multimodal de imagen base64
  const formatted = adapter.formatMessages([
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Mira esto' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==' } }
      ]
    }
  ]);
  assert.equal(formatted[0].content[1].type, 'image');
  assert.equal(formatted[0].content[1].source.media_type, 'image/png');
  assert.equal(formatted[0].content[1].source.data, 'iVBORw0KGgoAAAANSUhEUg==');

  // Construcción de payload con thinking y caché
  const payload = adapter.buildPayload({
    model: 'claude-3-7-sonnet',
    messages: [
      { role: 'system', content: 'Eres un bot' },
      { role: 'user', content: 'Pregunta' }
    ],
    reasoningEffort: 'medium',
    toolsList: [{ name: 'test_tool' }],
    enableContextCache: false
  });

  assert.deepEqual(payload.thinking, { type: 'enabled', budget_tokens: 2048 });
  assert.equal(payload.temperature, 1.0);
  assert.ok(payload.tools[0].cache_control, 'Debe inyectar cache_control en el tool');
  assert.ok(payload.messages[0].content[0].cache_control, 'Debe inyectar cache_control en el system message');
});

test('ClaudeAdapter - Parseo de chunks SSE nativos de Anthropic', () => {
  const adapter = new ClaudeProviderAdapter();

  // Thinking delta
  const rChunk = adapter.parseStreamChunk({
    type: 'content_block_delta',
    delta: { type: 'thinking_delta', thinking: 'Claude pensando...' }
  });
  assert.equal(rChunk.reasoningChunk, 'Claude pensando...');

  // Text delta
  const tChunk = adapter.parseStreamChunk({
    type: 'content_block_delta',
    delta: { type: 'text_delta', text: 'Hola humano' }
  });
  assert.equal(tChunk.textChunk, 'Hola humano');

  // Message start usage
  const uChunk = adapter.parseStreamChunk({
    type: 'message_start',
    message: { usage: { cache_read_input_tokens: 3500 } }
  });
  assert.equal(uChunk.cachedTokens, 3500);
});

test('OllamaAdapter - Endpoints y parseo de modelos de Ollama (/api/tags)', () => {
  const adapter = new OllamaProviderAdapter();
  assert.equal(adapter.normalizeEndpoint('http://localhost:11434'), 'http://localhost:11434/v1/chat/completions');
  assert.equal(adapter.normalizeEndpoint('http://localhost:11434/api/chat'), 'http://localhost:11434/api/chat');

  const endpoints = adapter.getModelEndpoints('http://localhost:11434');
  assert.ok(endpoints.includes('http://localhost:11434/api/tags'));

  const parsedModels = adapter.parseModelsResponse({
    models: [
      { name: 'llama3:latest', size: 4000000 },
      { name: 'deepseek-r1:8b', size: 5000000 }
    ]
  });
  assert.equal(parsedModels.length, 2);
  assert.equal(parsedModels[0].id, 'llama3:latest');
  assert.equal(parsedModels[1].id, 'deepseek-r1:8b');
});

test('OpenRouterAdapter - Configuración de razonamiento y endpoints', () => {
  const adapter = new OpenRouterProviderAdapter();
  const payload = adapter.buildPayload({
    model: 'deepseek/deepseek-r1',
    messages: [{ role: 'user', content: 'Test' }],
    reasoningEffort: 'high'
  });

  assert.deepEqual(payload.reasoning, { effort: 'high' });
  assert.equal(payload.reasoning_effort, 'high');
});

test('Capabilities - Declaración estándar y por proveedor', () => {
  const baseAdapter = new BaseProviderAdapter();
  const baseCaps = baseAdapter.getCapabilities();
  assert.equal(baseCaps.streaming, true);
  assert.equal(baseCaps.vision, true);
  assert.equal(baseCaps.tools, true);
  assert.equal(baseCaps.reasoning, true);
  assert.equal(baseCaps.jsonMode, true);
  assert.equal(baseCaps.promptCaching, true);
  assert.equal(baseCaps.embeddings, true);
  assert.equal(baseCaps.modelListing, true);

  const claudeAdapter = new ClaudeProviderAdapter();
  const claudeCaps = claudeAdapter.getCapabilities();
  assert.equal(claudeCaps.jsonMode, false);
  assert.equal(claudeCaps.embeddings, false);
  assert.equal(claudeCaps.promptCaching, true);

  const ollamaAdapter = new OllamaProviderAdapter();
  const ollamaCaps = ollamaAdapter.getCapabilities();
  assert.equal(ollamaCaps.promptCaching, false);
  assert.equal(ollamaCaps.tools, true);

  const openrouterAdapter = new OpenRouterProviderAdapter();
  const openrouterCaps = openrouterAdapter.getCapabilities();
  assert.equal(openrouterCaps.embeddings, false);
  assert.equal(openrouterCaps.promptCaching, true);
});

test('Capabilities - Utilización en buildPayload para filtrar parámetros no soportados', () => {
  // 1. Proveedor sin soporte de Prompt Caching (ej: Ollama) no debe inyectar stream_options.include_usage
  const ollamaAdapter = new OllamaProviderAdapter();
  const ollamaPayload = ollamaAdapter.buildPayload({
    model: 'llama3:latest',
    messages: [{ role: 'user', content: 'test' }],
    enableContextCache: true
  });
  assert.equal(ollamaPayload.stream_options, undefined, 'Ollama no debe tener stream_options');

  // 2. Proveedor con capability tools: false no debe inyectar tools
  const noToolsAdapter = new BaseProviderAdapter({
    capabilities: { tools: false }
  });
  const noToolsPayload = noToolsAdapter.buildPayload({
    model: 'simple-model',
    messages: [{ role: 'user', content: 'test' }],
    toolsList: [{ type: 'function', function: { name: 'search_web' } }]
  });
  assert.equal(noToolsPayload.tools, undefined, 'No debe inyectar tools si tools=false');
  assert.equal(noToolsPayload.tool_choice, undefined);

  // 3. Proveedor con capability reasoning: false no debe inyectar reasoning_effort
  const noReasoningAdapter = new BaseProviderAdapter({
    capabilities: { reasoning: false }
  });
  const noReasoningPayload = noReasoningAdapter.buildPayload({
    model: 'simple-model',
    messages: [{ role: 'user', content: 'test' }],
    reasoningEffort: 'high'
  });
  assert.equal(noReasoningPayload.reasoning_effort, undefined, 'No debe inyectar reasoning si reasoning=false');

  // 4. Proveedor con capability jsonMode: true y jsonMode solicitado
  const jsonAdapter = new BaseProviderAdapter();
  const jsonPayload = jsonAdapter.buildPayload({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'test' }],
    jsonMode: true
  });
  assert.deepEqual(jsonPayload.response_format, { type: 'json_object' });

  // 5. Proveedor con vision: false debe filtrar o degradar imágenes
  const noVisionAdapter = new BaseProviderAdapter({
    capabilities: { vision: false }
  });
  const textOnlyMessages = noVisionAdapter.formatMessages([
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Descripción textual' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,123' } }
      ]
    }
  ]);
  assert.equal(textOnlyMessages[0].content, 'Descripción textual', 'Debe extraer sólo texto si vision=false');
});

test('GeminiAdapter - Normalización de endpoints, stripping de prefijo models/ y compatibilidad de payload', () => {
  const adapter = new GeminiProviderAdapter();
  assert.equal(adapter.normalizeEndpoint('https://generativelanguage.googleapis.com/v1beta/openai'), 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');

  // Parseo de lista de modelos de Gemini con prefijo models/
  const parsedModels = adapter.parseModelsResponse({
    models: [
      { name: 'models/gemini-1.5-flash', displayName: 'Gemini 1.5 Flash' },
      { name: 'models/gemini-2.0-flash', displayName: 'Gemini 2.0 Flash' },
      { name: 'models/embedding-001', displayName: 'Embedding' }
    ]
  });
  assert.equal(parsedModels.length, 2);
  assert.equal(parsedModels[0].id, 'gemini-1.5-flash');
  assert.equal(parsedModels[1].id, 'gemini-2.0-flash');

  // Construcción de payload: debe quitar models/ y no inyectar reasoning_effort ni stream_options
  const payload = adapter.buildPayload({
    model: 'models/gemini-1.5-flash',
    messages: [
      { role: 'user', content: 'hola' },
      // Simular un mensaje tool huérfano
      { role: 'tool', tool_call_id: 'call_999', name: 'render_chart', content: '{"success":true}' }
    ],
    reasoningEffort: 'none',
    enableContextCache: true
  });
  assert.equal(payload.model, 'gemini-1.5-flash');
  assert.equal(payload.reasoning_effort, undefined, 'No debe inyectar reasoning_effort');
  assert.equal(payload.stream_options, undefined, 'No debe inyectar stream_options');
  // Debe haber insertado el mensaje assistant previo para evitar error 400 en Gemini
  assert.equal(payload.messages.length, 3);
  assert.equal(payload.messages[1].role, 'assistant');
  assert.ok(payload.messages[1].tool_calls);
  assert.equal(payload.messages[2].role, 'tool');

  // Si el historial comienza con un mensaje assistant tras system, debe insertar user antes
  const leadingAssistantPayload = adapter.buildPayload({
    model: 'gemini-2.0-flash',
    messages: [
      { role: 'system', content: 'system prompt' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', function: { name: 'search_web', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_1', name: 'search_web', content: 'results' }
    ]
  });
  assert.equal(leadingAssistantPayload.messages[0].role, 'system');
  assert.equal(leadingAssistantPayload.messages[1].role, 'user', 'Debe insertar un turno user antes del assistant con tools');
  assert.equal(leadingAssistantPayload.messages[2].role, 'assistant');
  assert.equal(leadingAssistantPayload.messages[3].role, 'tool');
});

test('ChatAPI.getProviderCapabilities - Consulta a través de ChatAPI', () => {
  const ChatAPI = require('../js/api.js');
  const claudeCaps = ChatAPI.getProviderCapabilities('https://api.anthropic.com/v1');
  assert.equal(claudeCaps.jsonMode, false);
  assert.equal(claudeCaps.promptCaching, true);

  const ollamaCaps = ChatAPI.getProviderCapabilities('http://localhost:11434');
  assert.equal(ollamaCaps.promptCaching, false);
  assert.equal(ollamaCaps.streaming, true);

  const geminiCaps = ChatAPI.getProviderCapabilities('https://generativelanguage.googleapis.com/v1beta/openai');
  assert.equal(geminiCaps.reasoning, false);
  assert.equal(geminiCaps.promptCaching, true);
});
