const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  ClaudeProviderAdapter,
  GeminiProviderAdapter,
  OpenRouterProviderAdapter
} = require('../../js/providers.js');
const ChatEngine = require('../../js/chat-engine.js');

test('ContextCache - Jerarquía de prefijo en system prompt coloca base primero y fecha/RAG al final', () => {
  const history = [{ role: 'user', content: 'Consulta 1' }];
  const config = {
    systemPrompt: 'INSTRUCCION_BASE_MAESTRA',
    systemDataPrompt: 'FORMATO_PLANO'
  };
  const effective = ChatEngine.buildEffectiveMessages(history, require('../../js/config-store.js').normalize(config), {
    currentRagSystemContext: 'CONTEXTO_RAG_VARIABLE'
  });

  const sys = effective.find(m => m.role === 'system');
  assert.ok(sys, 'Debe haber un system prompt');
  
  const baseIdx = sys.content.indexOf('INSTRUCCION_BASE_MAESTRA');
  const ragIdx = sys.content.indexOf('CONTEXTO_RAG_VARIABLE');
  const dateIdx = sys.content.indexOf('Conversation start date');

  assert.ok(baseIdx !== -1, 'Debe contener la instrucción base');
  assert.ok(ragIdx !== -1, 'Debe contener el contexto RAG');
  assert.ok(dateIdx !== -1, 'Debe contener la fecha de inicio');

  // Verificar jerarquía de estabilidad de prefijo: Base < RAG < Fecha
  assert.ok(baseIdx < ragIdx, 'Las instrucciones base deben preceder al contexto RAG');
  assert.ok(ragIdx < dateIdx, 'El contexto RAG debe preceder al ancla de fecha final');
});

test('ContextCache - el bloque del proyecto es estable: sigue a la base y precede a RAG y fecha', () => {
  const sys = ChatEngine.buildEffectiveMessages([{ role: 'user', content: 'Consulta' }], require('../../js/config-store.js').normalize({ systemPrompt: 'INSTRUCCION_BASE_MAESTRA' }), {
    currentRagSystemContext: 'CONTEXTO_RAG_VARIABLE',
    projectContext: { status: 'ready', cwd: '/repo', rules: { content: 'NORMAS_PROYECTO' }, state: { content: '' } }
  }).find(m => m.role === 'system').content;

  const baseIdx = sys.indexOf('INSTRUCCION_BASE_MAESTRA');
  const projectIdx = sys.indexOf('NORMAS_PROYECTO');
  assert.ok(baseIdx !== -1 && projectIdx !== -1);
  assert.ok(baseIdx < projectIdx, 'Las instrucciones base preceden al proyecto');
  assert.ok(projectIdx < sys.indexOf('CONTEXTO_RAG_VARIABLE'), 'El proyecto precede al contexto RAG dinámico');
  assert.ok(projectIdx < sys.indexOf('Conversation start date'), 'El proyecto precede al ancla de fecha');
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
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'execute_javascript', arguments: '{"code":"return 1+1;"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '2' }
    ],
    toolsList: [{ type: 'function', function: { name: 'execute_javascript' } }]
  });

  // Tools deben tener cache_control
  assert.ok(payload.tools[0].cache_control, 'La herramienta debe tener cache_control');
  // System debe tener cache_control
  assert.ok(payload.system[0].cache_control, 'El system prompt debe tener cache_control');
  // El último mensaje (tool response) debe ser el que tenga cache_control
  const lastMsg = payload.messages[payload.messages.length - 1];
  assert.equal(lastMsg.role, 'user');
  assert.equal(lastMsg.content[0].type, 'tool_result');
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
