/**
 * Suite de pruebas unitarias para ChatEngine (js/chat-engine.js).
 * Verifica:
 * 1. Formateo de fechas iniciales y guías de herramientas en System Prompt.
 * 2. Inyección y anclaje de mensajes efectivos para Context-Caching.
 * 3. Inserción semántica de cursor en streaming.
 * 4. Orquestación del bucle agéntico con streaming y llamadas a herramientas.
 * 5. Detección y protección contra bucles infinitos por llamadas idénticas consecutivas.
 * 6. Cancelación mediante AbortSignal.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

// Importar ChatEngine y dependencias
const ChatEngine = require('../../js/chat-engine.js');
const MessageTurns = require('../../js/message-turns.js');
const ChatConfig = require('../../js/config-store.js');
const ChatAPI = require('../../js/api.js');
const ChatAgentCore = require('../../js/agent-core.js');
const { createTurnView } = require('../helpers/turn-view.js');

// La aplicación siempre entrega la configuración normalizada y todos los callbacks del turno.
const config = (overrides = {}) => ChatConfig.normalize(overrides);
// `enableTools` fija si el registro real tiene herramientas activas durante la llamada.
function buildMessages(history, appConfig = {}, { enableTools, ...options } = {}) {
  const registry = require('../../js/agent-core.js').registry;
  const original = registry.getActiveTools;
  if (enableTools !== undefined) registry.getActiveTools = () => (enableTools ? [{ name: 'tool' }] : []);
  try {
    return ChatEngine.buildEffectiveMessages(history, config(appConfig), options);
  } finally {
    registry.getActiveTools = original;
  }
}

// El sandbox real necesita un navegador (lo cubren las pruebas de browser): aquí la herramienta
// devuelve un resultado fijo y el motor se prueba con el resto de piezas reales.
function runTurn({ appConfig = {}, ...params }) {
  return ChatEngine.executeAgentTurnLoop({
    assistantMsgId: 'asst_test',
    view: createTurnView(),
    onReasoningChunk() {},
    onLog() {},
    onStats() {},
    onGenerationStatus() {},
    ...params,
    appConfig: config(appConfig)
  });
}

test('ChatEngine - reenvía la firma del razonamiento cuando el servidor la entrega', () => {
  const messages = buildMessages([
    { role: 'user', content: 'Pregunta' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
      reasoningReplay: { field: 'thinking', text: 'plan', signature: '' } },
    { role: 'tool', tool_call_id: 'c1', name: 'read_file', content: 'a' }
  ]);
  const assistant = messages.find(m => m.role === 'assistant');
  assert.equal(assistant.thinking, 'plan');
  assert.equal(assistant.reasoning_signature, '');
});

test('ChatEngine - no inventa turnos assistant para resultados de llamadas paralelas', () => {
  const messages = buildMessages([
    { role: 'user', content: 'Busca dos cosas' },
    { role: 'assistant', content: null, tool_calls: [
      { id: 'call_a', type: 'function', function: { name: 'search_a', arguments: '{}' } },
      { id: 'call_b', type: 'function', function: { name: 'search_b', arguments: '{}' } }
    ] },
    { role: 'tool', tool_call_id: 'call_a', name: 'search_a', content: 'A' },
    { role: 'tool', tool_call_id: 'call_b', name: 'search_b', content: 'B' },
    { role: 'tool', tool_call_id: 'call_orphan', name: 'orphan', content: 'C' }
  ], {}, { enableTools: false });

  const tail = messages.slice(messages.findIndex(message => message.role === 'assistant'));
  assert.deepEqual(tail.map(message => message.role), ['assistant', 'tool', 'tool', 'assistant', 'tool']);
  assert.deepEqual(tail[3].tool_calls.map(call => call.id), ['call_orphan']);
});

test('ChatEngine - adjunta una imagen RAG como evidencia multimodal tras su resultado', () => {
  const messages = buildMessages([
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_image', type: 'function', function: { name: 'read_knowledge_image', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_image', name: 'read_knowledge_image', content: 'Imagen recuperada.', images: [{ dataUrl: 'data:image/png;base64,AA==', imageRef: 'rag-image://doc_1:img_1', documentTitle: 'diagrama.md', page: 2 }] }
  ], {}, { enableTools: false });

  const toolIndex = messages.findIndex(message => message.role === 'tool' && message.name === 'read_knowledge_image');
  assert.ok(toolIndex >= 0);
  const visual = messages[toolIndex + 1];
  assert.equal(visual.role, 'user');
  assert.equal(visual.content[1].type, 'image_url');
  assert.equal(visual.content[1].image_url.url, 'data:image/png;base64,AA==');
  assert.match(visual.content[0].text, /rag-image:\/\/doc_1:img_1/);
});

test('ChatEngine - adjunta una imagen web descargada como evidencia multimodal tras su resultado', () => {
  const messages = buildMessages([
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_dl_img', type: 'function', function: { name: 'download_image', arguments: '{"url":"https://example.com/cat.png"}' } }] },
    { role: 'tool', tool_call_id: 'call_dl_img', name: 'download_image', content: 'Image retrieved: https://example.com/cat.png', images: [{ dataUrl: 'data:image/png;base64,AA==', url: 'https://example.com/cat.png' }] }
  ], {}, { enableTools: false });

  const toolIndex = messages.findIndex(message => message.role === 'tool' && message.name === 'download_image');
  assert.ok(toolIndex >= 0);
  const visual = messages[toolIndex + 1];
  assert.equal(visual.role, 'user');
  assert.equal(visual.content[1].type, 'image_url');
  assert.equal(visual.content[1].image_url.url, 'data:image/png;base64,AA==');
  assert.match(visual.content[0].text, /https:\/\/example.com\/cat.png/);
});

test('ChatEngine - getConversationDateAnchor genera el ancla con fecha y zona horaria', (t) => {
  const anchorEs = ChatEngine.getConversationDateAnchor();
  assert.ok(anchorEs.includes('Conversation start date:'));
  assert.ok(anchorEs.includes('Timezone:'));

  const anchorEn = ChatEngine.getConversationDateAnchor();
  assert.ok(anchorEn.includes('Conversation start date:'));
  assert.ok(anchorEn.includes('Timezone:'));
});

test('ChatEngine - buildEffectiveMessages inyecta fecha, RAG y formatea mensajes', (t) => {
  const history = [
    { role: 'user', content: '¿Qué manuales tengo disponibles?' }
  ];

  const appConfig = {
    systemPrompt: 'Eres un asistente experto.',
    systemDataPrompt: '[Format: Always use standard Markdown and plain text.]',
    language: 'es',
    activeRagBranchIds: ['branch_123']
  };

  const options = {
    currentRagSystemContext: '[BASE DE CONOCIMIENTO ACTIVA: Manual GA-Z77P-D3]'
  };

  const messages = buildMessages(history, appConfig, options);

  assert.equal(messages[0].role, 'system');
  assert.ok(messages[0].content.includes('[BASE DE CONOCIMIENTO ACTIVA: Manual GA-Z77P-D3]'));
  assert.ok(messages[0].content.includes('Conversation start date:'));
  assert.ok(messages[0].content.includes('Eres un asistente experto.'));
  assert.ok(messages[0].content.includes('[Format: Always use standard Markdown and plain text.]'));
  assert.ok(messages[0].content.includes('Knowledge Base active'));
  assert.ok(messages[0].content.includes("Use 'list_documents' only when you explicitly need a complete inventory"));

  assert.equal(messages[1].role, 'user');
  assert.ok(messages[1].content.includes('¿Qué manuales tengo disponibles?'));
  assert.equal(messages[1].content, history[0].content);
  assert.ok(!JSON.stringify(messages).includes('[Context Time:'));
});

test('ChatEngine - buildEffectiveMessages indica el directorio del proyecto solo con herramientas', () => {
  const history = [{ role: 'user', content: 'Hola' }];
  const config = { systemPrompt: 'Base', language: 'es' };
  const withTools = buildMessages(history, config, { enableTools: true, projectDirectory: '/home/u/app' });
  assert.ok(withTools[0].content.includes('*Project directory:* /home/u/app.'));
  assert.ok(withTools[0].content.includes('Relative paths in local tools resolve against it.'));
  const withoutTools = buildMessages(history, config, { enableTools: false, projectDirectory: '/home/u/app' });
  assert.ok(!withoutTools[0].content.includes('Project directory'));
  const withoutServer = buildMessages(history, config, { enableTools: true, projectDirectory: '' });
  assert.ok(!withoutServer[0].content.includes('Project directory'));
});

test('ChatEngine - conserva evidencia RAG multimodal entre pasos agénticos', async () => {
  const originalStream = ChatAPI.streamChatCompletion;
  const originalDispatch = ChatAgentCore.dispatchToolCall;
  let calls = 0;
  let secondRequestMessages = null;

  ChatAgentCore.dispatchToolCall = async () => ({
    success: true,
    result: {
      dataUrl: 'data:image/png;base64,AA==',
      mimeType: 'image/png',
      imageRef: 'rag-image://doc_1:image_1',
      documentTitle: 'manual.pdf',
      page: 3
    },
    resultText: 'Image retrieved.',
    markdownBlock: '> image'
  });
  ChatAPI.streamChatCompletion = async (params) => {
    calls++;
    if (calls === 1) {
      const toolCalls = [{ id: 'image_call', type: 'function', function: { name: 'read_knowledge_image', arguments: '{}' } }];
      return { accumulatedText: '', toolCalls, stats: null };
    }
    secondRequestMessages = params.messages;
    return { accumulatedText: 'I inspected the image.', toolCalls: null, stats: null };
  };

  try {
    const history = [{ role: 'user', content: 'Inspect the diagram.' }];
    await runTurn({
      chatHistory: history,
      appConfig: { apiUrl: 'http://localhost:1234/v1', apiType: 'openai', model: 'test-model', activeRagBranchIds: ['branch_1'] }
    });

    assert.ok(history.find(message => message.role === 'tool')?.images?.[0]?.dataUrl);
    assert.ok(secondRequestMessages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url')));
  } finally {
    ChatAPI.streamChatCompletion = originalStream;
    ChatAgentCore.dispatchToolCall = originalDispatch;
  }
});

test('ChatEngine - copia el texto intermedio y los bloques de herramientas en orden', async () => {
  const originalStream = ChatAPI.streamChatCompletion;
  const originalDispatch = ChatAgentCore.dispatchToolCall;
  let calls = 0;

  ChatAgentCore.dispatchToolCall = async () => ({ success: true, result: { value: 4 }, resultText: '4', markdownBlock: '> tool result' });
  ChatAPI.streamChatCompletion = async params => {
    calls++;
    if (calls === 1) {
      const toolCalls = [{ id: 'calc_call', type: 'function', function: { name: 'execute_javascript', arguments: '{}' } }];
      return { accumulatedText: 'I will calculate it.', toolCalls, stats: null };
    }
    return { accumulatedText: 'The result is 4.', toolCalls: null, stats: null };
  };

  try {
    const result = await runTurn({
      chatHistory: [{ role: 'user', content: 'Calculate 2 + 2.' }],
      appConfig: { apiUrl: 'http://localhost:1234/v1', apiType: 'openai', model: 'test-model' }
    });
    assert.equal(result.accumulatedMarkdown, 'I will calculate it.\n\n> tool result\n\nThe result is 4.');
  } finally {
    ChatAPI.streamChatCompletion = originalStream;
    ChatAgentCore.dispatchToolCall = originalDispatch;
  }
});

test('ChatEngine - la siguiente petición tras borrar respuesta con tools no incluye ningún tool ni turno huérfano', () => {
  const baseId = 'turn_with_tools_deleted';
  const chatHistory = [
    { id: 'u1', role: 'user', content: '¿Qué temperatura hace?' },
    {
      id: `${baseId}_turn_0_assistant`,
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_temp', type: 'function', function: { name: 'get_temp', arguments: '{}' } }]
    },
    {
      id: `${baseId}_turn_0_tool_call_temp`,
      role: 'tool',
      tool_call_id: 'call_temp',
      name: 'get_temp',
      content: '22C'
    },
    {
      id: `${baseId}_final`,
      role: 'assistant',
      content: 'La temperatura es de 22C.'
    }
  ];

  // 1. Borrar la respuesta del asistente (con todas sus herramientas)
  const cleanedHistory = MessageTurns.removeSelectedTurn(chatHistory, { msgId: baseId, baseId });

  // 2. El usuario envía una siguiente petición
  cleanedHistory.push({
    id: 'u2',
    role: 'user',
    content: 'Ahora dime la hora'
  });

  // 3. ChatEngine construye los mensajes efectivos para la API de inferencia
  const effective = buildMessages(cleanedHistory, {
    apiUrl: 'http://localhost:1234/v1',
    model: 'test-model'
  });

  // 4. Validar que no haya ningún residuo de tool de la petición eliminada
  const toolMessages = effective.filter(m => m.role === 'tool');
  assert.equal(toolMessages.length, 0, 'No debe haber ningún mensaje de rol "tool" en la siguiente petición');

  const assistantWithTools = effective.filter(m => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0);
  assert.equal(assistantWithTools.length, 0, 'No debe haber ningún asistente con tool_calls de la petición eliminada');

  const userMessages = effective.filter(m => m.role === 'user');
  assert.equal(userMessages.length, 2, 'Deben conservarse los mensajes de usuario válidos');
  assert.equal(userMessages[0].content, '¿Qué temperatura hace?');
  assert.ok(userMessages[1].content.includes('Ahora dime la hora'));
});


test('ChatEngine - conserva el texto de usuario entre peticiones y llamadas a herramientas', () => {
  const history = [{ role: 'user', content: 'Primera pregunta' }];
  const config = {};
  const first = buildMessages(history, config);
  history.push({ role: 'assistant', content: 'Respuesta' }, { role: 'user', content: 'Segunda pregunta' });
  const next = buildMessages(history, config);
  assert.equal(first.find(m => m.role === 'user').content, next.find(m => m.role === 'user').content);
  assert.equal(next.filter(m => m.role === 'user')[1].content, 'Segunda pregunta');
  assert.ok(!JSON.stringify(next).includes('[Context Time:'));
});


test('ChatEngine - fecha inicial estable al cambiar día, idioma y serializar el historial', () => {
  const history = [{ role: 'system', content: 'Sistema' }, { role: 'user', content: 'Hola' }];
  const anchor = ChatEngine.ensureConversationDate(history, '2026-01-01T12:00:00Z');
  assert.match(anchor, /2026-01-01/);
  const before = buildMessages(history);
  const restored = JSON.parse(JSON.stringify(history));
  assert.equal(ChatEngine.ensureConversationDate(restored, '2026-02-02T12:00:00Z'), anchor);
  const after = buildMessages(restored);
  assert.deepEqual(after, before);
  assert.equal(after[0].content.split(anchor).length - 1, 1);
  assert.equal(after[1].content, 'Hola');
  assert.ok(after.every(m => !Object.hasOwn(m, 'contextDateAnchor')));
  assert.ok(!/\d{2}:\d{2}/.test(anchor));
  assert.equal(buildMessages(restored)[0].content, before[0].content);
});


test('ChatEngine - inyecta la fecha inicial de forma incondicional sin forzar el modo de herramientas si están desactivadas', () => {
  const enabledTools = Object.fromEntries(ChatAgentCore.registry.getActiveDefinitions(config()).map(t => [t.function.name, false]));
  const defs = ChatAgentCore.registry.getActiveDefinitions(config({ enabledTools }));
  assert.equal(defs.length, 0, 'No debe haber herramientas activas si todas están desmarcadas');
  const messages = buildMessages([{ role: 'user', content: 'Hola' }], { enabledTools });
  assert.match(messages[0].content, /Conversation start date/);
});

test('ChatEngine - con herramientas en texto (WebLLM) no inyecta la guía de pseudo-firmas', () => {
  require('../../js/providers-webllm.js');
  const appConfig = { apiType: 'webllm', apiUrl: 'webllm://local', model: 'Qwen3-4B-q4f16_1-MLC', language: 'es', enabledTools: { search_web: true } };
  const messages = buildMessages([{ role: 'user', content: 'Hola' }], appConfig, { enableTools: true });
  const system = messages.find(message => message.role === 'system')?.content || '';
  assert.equal(system.includes('AVAILABLE TOOLS AND FUNCTIONS'), false);
  assert.ok(system.includes('*Workflow instruction:*'));
});

const READY_PROJECT = {
  status: 'ready',
  cwd: '/home/u/repo',
  rules: { content: 'Project rules: AGENTS.md', truncated: false },
  state: { content: '- Next step: tests', truncated: false }
};

test('ChatEngine - el bloque del proyecto sigue en el prompt de sistema tras una compactación', () => {
  const history = [
    { role: 'system', content: 'Checkpoint acumulativo', _isSummaryBlock: true },
    { role: 'user', content: 'Continúa' }
  ];
  const messages = buildMessages(history, {}, { enableTools: false, projectContext: READY_PROJECT });
  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /Project mode/);
  assert.ok(messages.some(message => message.content === 'Checkpoint acumulativo'));
});

test('ChatEngine - executeAgentTurnLoop envía al proveedor la instantánea del proyecto', async () => {
  const originalStream = ChatAPI.streamChatCompletion;
  let sentSystem = '';
  ChatAPI.streamChatCompletion = async (params) => {
    sentSystem = params.messages.find(message => message.role === 'system')?.content || '';
    params.onChunk?.('ok', 'ok', null);
    return { accumulatedText: 'ok', toolCalls: null, stats: null };
  };
  try {
    const res = await runTurn({
      chatHistory: [{ role: 'user', content: 'Hola' }],
      appConfig: { apiUrl: 'http://localhost:1234/v1', model: 'test-model', enabledTools: {} },
      projectContext: READY_PROJECT
    });
    assert.equal(res.success, true);
    assert.match(sentSystem, /rooted at \/home\/u\/repo/);
  } finally {
    ChatAPI.streamChatCompletion = originalStream;
  }
});


test('ChatEngine.createHistorySummarizer - pide el checkpoint sin herramientas ni razonamiento', async () => {
  const originalStream = ChatAPI.streamChatCompletion;
  let request = null;
  ChatAPI.streamChatCompletion = async params => { request = params; return { accumulatedText: 'checkpoint' }; };
  try {
    const signal = new AbortController().signal;
    const summarize = ChatEngine.createHistorySummarizer({ apiUrl: 'https://x.test', apiType: 'openai', apiKey: 'k', model: 'm', signal });
    const result = await summarize({ systemPrompt: 'SUMMARIZE', messages: [{ role: 'user', content: 'hola' }] });
    assert.equal(result, 'checkpoint');
    assert.equal(request.apiKey, 'k');
    assert.equal(request.signal, signal);
    assert.equal(request.toolChoice, 'none');
    assert.equal(request.reasoningEffort, 'none');
    assert.deepEqual(request.messages.map(m => m.role), ['system', 'user', 'user']);
    assert.equal(request.messages[0].content, 'SUMMARIZE');
  } finally {
    ChatAPI.streamChatCompletion = originalStream;
  }
});

test('ChatEngine - antepone al mensaje del usuario la nota de comandos terminados, también con imágenes', () => {
  const note = 'Background commands that finished since your last turn:\n- job_id 4 `npm test` exited with code 1 after 3:12.';
  const messages = buildMessages([
    { role: 'user', content: 'sigue', commandNotes: note },
    { role: 'assistant', content: 'vale' },
    { role: 'user', content: 'mira esto', commandNotes: note, images: [{ dataUrl: 'data:image/png;base64,AA==' }] },
    { role: 'user', content: 'sin nota' }
  ], {}, { enableTools: false });
  const users = messages.filter(message => message.role === 'user');
  assert.equal(users[0].content, `${note}\n\nsigue`);
  assert.equal(users[1].content[0].text, `${note}\n\nmira esto`);
  assert.equal(users[1].content[1].type, 'image_url');
  assert.equal(users[2].content, 'sin nota');
});

