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
} = require('../../js/providers.js');

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

test('ProviderRegistry - todo adaptador registrado extiende BaseProviderAdapter', () => {
  require('../../js/providers-webllm.js');
  const ids = [...registry.adapters.keys()];
  assert.ok(ids.includes('webllm'));
  for (const [id, adapter] of registry.adapters) {
    assert.ok(adapter instanceof BaseProviderAdapter, `${id} no extiende BaseProviderAdapter`);
  }
  assert.ok(registry.defaultAdapter instanceof BaseProviderAdapter);
});

test('ProviderRegistry - declara configuración de conexión sin lógica de UI por proveedor', () => {
  assert.equal(registry.get('ollama').getConnectionConfig().endpoint, 'http://localhost:11434');
  assert.equal(registry.get('claude').getConnectionConfig().endpoint, 'https://api.anthropic.com/v1');
  assert.ok(registry.getConnectionEndpoints().includes('https://api.openai.com/v1'));
  assert.equal(registry.get('mirror').getConnectionConfig().credentials, false);
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

test('OpenAIAdapter - indica el campo del razonamiento que se puede reenviar', () => {
  const adapter = new BaseProviderAdapter();
  assert.equal(adapter.parseStreamChunk({ choices: [{ delta: { reasoning_content: 'a' } }] }).reasoningField, 'reasoning_content');
  assert.equal(adapter.parseStreamChunk({ choices: [{ delta: { reasoning: 'b' } }] }).reasoningField, 'reasoning');
  const thinking = adapter.parseStreamChunk({ choices: [{ delta: { thinking: 'c' } }] });
  assert.equal(thinking.reasoningChunk, 'c');
  assert.equal(thinking.reasoningField, undefined);
});

test('OpenAIAdapter - un rechazo del razonamiento reenviado lo quita de los mensajes y conserva reasoning_effort', () => {
  const adapter = new BaseProviderAdapter();
  const payload = {
    reasoning_effort: 'high',
    messages: [
      { role: 'user', content: 'Hola' },
      { role: 'assistant', content: null, reasoning_content: 'plan', tool_calls: [{ id: 'c1' }] }
    ]
  };
  const recovery = adapter.handleHttpError(400, "messages[1]: unexpected field 'reasoning_content'", payload);
  assert.deepEqual(recovery, { retry: true, reason: 'reasoning_history_rejected' });
  assert.equal('reasoning_content' in payload.messages[1], false);
  assert.equal(payload.reasoning_effort, 'high');

  // "reasoning" es también un parámetro raíz: sin mención a los mensajes se trata como tal.
  const routerPayload = {
    reasoning: { effort: 'high' },
    messages: [{ role: 'assistant', content: null, reasoning: 'plan', tool_calls: [{ id: 'c1' }] }]
  };
  assert.equal(adapter.handleHttpError(400, "Unknown parameter 'reasoning'", routerPayload).reason, 'reasoning_rejected');
  assert.equal(routerPayload.messages[0].reasoning, 'plan');
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

test('ClaudeAdapter - Acumula los bloques tool_use y la firma del thinking del streaming', () => {
  const adapter = new ClaudeProviderAdapter();

  const thinking = adapter.parseStreamChunk({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'plan' } });
  assert.equal(thinking.reasoningField, 'thinking');
  const signature = adapter.parseStreamChunk({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: '' } });
  assert.equal(signature.reasoningSignature, '', 'Una firma vacía también se reenvía');

  const start = adapter.parseStreamChunk({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} } });
  assert.deepEqual(start.toolCallDeltas, [{ index: 1, id: 'toolu_1', function: { name: 'get_weather', arguments: '' } }]);
  const args = adapter.parseStreamChunk({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"city":' } });
  assert.deepEqual(args.toolCallDeltas, [{ index: 1, function: { arguments: '{"city":' } }]);

  const complete = adapter.parseStreamChunk({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_2', name: 'now', input: { tz: 'UTC' } } });
  assert.equal(complete.toolCallDeltas[0].function.arguments, '{"tz":"UTC"}', 'Un input completo en el inicio del bloque cuenta como argumentos');
});

test('ClaudeAdapter - El contexto de la Messages API suma la entrada y la caché', () => {
  const adapter = new ClaudeProviderAdapter();
  const start = adapter.parseStreamChunk({ type: 'message_start', message: { usage: { input_tokens: 4, cache_read_input_tokens: 319, cache_creation_input_tokens: 10, output_tokens: 0 } } });
  assert.equal(start.usage.prompt_tokens, 333);
  assert.equal(start.cachedTokens, 319);
  const delta = adapter.parseStreamChunk({ type: 'message_delta', usage: { output_tokens: 57 } });
  assert.equal(delta.usage.prompt_tokens, undefined, 'Sin input_tokens no se inventa la entrada');
});

test('ClaudeAdapter - Traduce el historial de herramientas a bloques tool_use y tool_result', () => {
  const adapter = new ClaudeProviderAdapter();
  const toolsList = [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: {} } } }];
  const payload = adapter.buildPayload({
    model: 'modelo',
    reasoningEffort: 'low',
    toolsList,
    messages: [
      { role: 'user', content: 'Tiempo en Madrid y París' },
      {
        role: 'assistant',
        content: 'Consulto las dos.',
        thinking: 'dos llamadas',
        reasoning_signature: 'firma',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Madrid"}' } },
          { id: 'c2', type: 'function', function: { name: 'get_weather', arguments: 'no es json' } }
        ]
      },
      { role: 'tool', tool_call_id: 'c1', name: 'get_weather', content: '22C' },
      { role: 'tool', tool_call_id: 'c2', name: 'get_weather', content: { error: 'bad args' } }
    ]
  });

  assert.deepEqual(payload.messages[1], {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'dos llamadas', signature: 'firma' },
      { type: 'text', text: 'Consulto las dos.' },
      { type: 'tool_use', id: 'c1', name: 'get_weather', input: { city: 'Madrid' } },
      { type: 'tool_use', id: 'c2', name: 'get_weather', input: {} }
    ]
  });
  assert.equal(payload.messages.length, 3, 'Los resultados paralelos van en un único turno user');
  assert.deepEqual(payload.messages[2].content.map(block => [block.type, block.tool_use_id, block.content]), [
    ['tool_result', 'c1', '22C'],
    ['tool_result', 'c2', '{"error":"bad args"}']
  ]);
  assert.deepEqual(payload.tool_choice, { type: 'auto' });
  assert.equal(toolsList[0].cache_control, undefined, 'La lista de herramientas recibida no se modifica');
  assert.ok(payload.tools[0].cache_control);
  assert.equal(payload.max_tokens, 32000, 'El razonamiento no recorta la salida máxima');
});

test('ClaudeAdapter - tool_choice, imágenes sin visión y límite de salida del modelo', () => {
  const adapter = new ClaudeProviderAdapter();
  const tools = [{ type: 'function', function: { name: 'read_file' } }];
  const choice = toolChoice => adapter.buildPayload({ model: 'm', messages: [{ role: 'user', content: 'x' }], toolsList: tools, toolChoice }).tool_choice;
  assert.deepEqual(choice('none'), { type: 'none' });
  assert.deepEqual(choice('required'), { type: 'any' });
  assert.deepEqual(choice({ type: 'function', function: { name: 'read_file' } }), { type: 'tool', name: 'read_file' });

  const textOnly = adapter.formatMessages([{ role: 'user', content: [
    { type: 'text', text: 'Mira' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
  ] }], { ...adapter.getCapabilities(), vision: false });
  assert.deepEqual(textOnly[0].content, [{ type: 'text', text: 'Mira' }]);

  const payload = adapter.buildPayload({ model: 'm', messages: [{ role: 'user', content: 'x' }], reasoningEffort: 'xhigh' });
  const recovery = adapter.handleHttpError(400, 'max_tokens: 32000 > 8192, which is the maximum allowed number of output tokens for m', payload);
  assert.equal(recovery.reason, 'max_tokens_rejected');
  assert.equal(payload.max_tokens, 8192);
  assert.equal(payload.thinking.budget_tokens, 4096, 'El presupuesto de razonamiento queda por debajo del nuevo límite');

  const nextPayload = adapter.buildPayload({ model: 'm', messages: [{ role: 'user', content: 'y' }], reasoningEffort: 'xhigh' });
  assert.equal(nextPayload.max_tokens, 8192, 'Las llamadas siguientes al mismo modelo usan directamente el límite aprendido');
  assert.equal(nextPayload.thinking.budget_tokens, 4096);
});

test('Adaptadores - Errores dentro del streaming y motivo de fin', () => {
  const base = new BaseProviderAdapter();
  assert.equal(base.parseStreamChunk({ error: { message: 'Provider returned error', code: 502 } }).error, 'Provider returned error');
  assert.equal(base.parseStreamChunk({ error: 'context overflow' }).error, 'context overflow');
  assert.equal(base.parseStreamChunk({ choices: [{ delta: {}, finish_reason: 'length' }] }).truncatedBy, 'length');
  assert.equal(base.parseStreamChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }).truncatedBy, undefined);
  assert.equal(base.parseStreamChunk({ choices: [{ delta: { content: 'a' } }] }).error, undefined);

  const claude = new ClaudeProviderAdapter();
  assert.equal(claude.parseStreamChunk({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }).error, 'Overloaded');
  assert.equal(claude.parseStreamChunk({ type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 9 } }).truncatedBy, 'max_tokens');
  assert.equal(claude.parseStreamChunk({ choices: [{ delta: { content: 'a' } }] }).textChunk, 'a', 'Claude en formato OpenAI pasa por el adaptador base');
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
  assert.equal(baseCaps.temperature, true);
  assert.equal(new BaseProviderAdapter().buildPayload({ model: 'm', messages: [], temperature: '0.3' }).temperature, 0.3);

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

test('Reasoning intensity - ninguno envía el apagado explícito de cada protocolo y se retira si se rechaza', () => {
  const messages = [{ role: 'user', content: 'hola' }];
  const openAIPayload = new BaseProviderAdapter().buildPayload({ model: 'test', messages, reasoningEffort: 'none' });
  assert.equal(openAIPayload.reasoning_effort, 'none');

  const routerPayload = new OpenRouterProviderAdapter().buildPayload({ model: 'test', messages, reasoningEffort: 'none' });
  assert.deepEqual(routerPayload.reasoning, { effort: 'none' });

  const claude = new ClaudeProviderAdapter();
  const claudePayload = claude.buildPayload({ model: 'claude-test', messages, temperature: 0.3, reasoningEffort: 'none' });
  assert.deepEqual(claudePayload.thinking, { type: 'disabled' });
  assert.equal(claudePayload.temperature, 0.3, 'Sin razonamiento se respeta la temperatura del perfil');

  const geminiPayload = new GeminiProviderAdapter().buildPayload({ model: 'gemini-pro', messages, reasoningEffort: 'none' });
  const recovery = new GeminiProviderAdapter().handleHttpError(400, 'Thinking cannot be disabled for this model.', geminiPayload);
  assert.equal(recovery.reason, 'reasoning_rejected');
  assert.equal(geminiPayload.reasoning_effort, undefined, 'Un modelo con razonamiento mínimo recibe la petición sin el parámetro');

  const geminiMax = new GeminiProviderAdapter().buildPayload({ model: 'gemini-flash', messages, reasoningEffort: 'xhigh' });
  assert.equal(geminiMax.reasoning_effort, 'high', 'Máximo pide el nivel más alto que admite Gemini');

  const omitted = new BaseProviderAdapter().buildPayload({ model: 'test', messages, reasoningEffort: '' });
  assert.equal(omitted.reasoning_effort, undefined, 'Un nivel vacío no envía parámetro');
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

  // Construcción de payload: quita models/, pide sin razonamiento de forma explícita y no inyecta stream_options
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
  assert.equal(payload.reasoning_effort, 'none', 'Sin razonamiento se pide de forma explícita');
  assert.equal(payload.stream_options, undefined, 'No debe inyectar stream_options');
  assert.equal('temperature' in payload, false, 'Gemini no debe recibir temperature');
  assert.equal('top_p' in payload, false);
  assert.equal('top_k' in payload, false);
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
  const ChatAPI = require('../../js/api.js');
  const claudeCaps = ChatAPI.getProviderCapabilities('https://api.anthropic.com/v1');
  assert.equal(claudeCaps.jsonMode, false);
  assert.equal(claudeCaps.promptCaching, true);

  const ollamaCaps = ChatAPI.getProviderCapabilities('http://localhost:11434');
  assert.equal(ollamaCaps.promptCaching, false);
  assert.equal(ollamaCaps.streaming, true);

  const geminiCaps = ChatAPI.getProviderCapabilities('https://generativelanguage.googleapis.com/v1beta/openai');
  assert.equal(geminiCaps.reasoning, true);
  assert.equal(geminiCaps.temperature, false);
  assert.equal(geminiCaps.promptCaching, true);
});

test('GeminiAdapter - formatMessages conserva resultados de llamadas paralelas y respuestas de texto sin turnos sintéticos', () => {
  {
    const adapter = new GeminiProviderAdapter();
    const formatted = adapter.formatMessages([
      { role: 'system', content: 'Sistema' },
      { role: 'user', content: 'Busca dos cosas' },
      { role: 'assistant', content: null, tool_calls: [
        { id: 'call_a', type: 'function', function: { name: 'search_a', arguments: '{}' } },
        { id: 'call_b', type: 'function', function: { name: 'search_b', arguments: '{}' } }
      ] },
      { role: 'tool', tool_call_id: 'call_a', name: 'search_a', content: 'A' },
      { role: 'tool', tool_call_id: 'call_b', name: 'search_b', content: 'B' }
    ]);
    assert.deepEqual(formatted.map(message => message.role), ['system', 'user', 'assistant', 'tool', 'tool']);
  }

  {
    const adapter = new GeminiProviderAdapter();
    const formatted = adapter.formatMessages([
      { role: 'system', content: 'Sistema' },
      { role: 'user', content: 'Hola' },
      { role: 'assistant', content: 'Respuesta previa' },
      { role: 'user', content: 'Sigue' }
    ]);
    assert.deepEqual(formatted.map(message => [message.role, message.content]), [
      ['system', 'Sistema'], ['user', 'Hola'], ['assistant', 'Respuesta previa'], ['user', 'Sigue']
    ]);

    const afterSystem = adapter.formatMessages([
      { role: 'system', content: 'Sistema' },
      { role: 'assistant', content: 'Saludo inicial' }
    ]);
    assert.deepEqual(afterSystem.map(message => message.role), ['system', 'user', 'assistant']);
  }
});
