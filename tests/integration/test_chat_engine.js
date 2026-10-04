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

test('ChatEngine - no inventa turnos assistant para resultados de llamadas paralelas', () => {
  const messages = ChatEngine.buildEffectiveMessages([
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
  const messages = ChatEngine.buildEffectiveMessages([
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

test('ChatEngine - no crea evidencia visual para resultados de herramienta sin imagen', () => {
  const messages = ChatEngine.buildEffectiveMessages([
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_image', type: 'function', function: { name: 'read_knowledge_image', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_image', name: 'read_knowledge_image', content: 'Error.' }
  ], {}, { enableTools: false });
  assert.equal(messages.filter(message => Array.isArray(message.content)).length, 0);
});
const ChatAPI = require('../../js/api.js');
const ChatAgentCore = require('../../js/agent-core.js');

test('ChatEngine - getConversationDateAnchor genera el ancla con fecha y zona horaria', (t) => {
  const anchorEs = ChatEngine.getConversationDateAnchor('es');
  assert.ok(anchorEs.includes('Conversation start date:'));
  assert.ok(anchorEs.includes('Timezone:'));

  const anchorEn = ChatEngine.getConversationDateAnchor('en');
  assert.ok(anchorEn.includes('Conversation start date:'));
  assert.ok(anchorEn.includes('Timezone:'));
});

test('ChatEngine - getToolsSystemPromptGuide genera la lista de herramientas activas', (t) => {
  const guideEs = ChatEngine.getToolsSystemPromptGuide({
    enableAgentWeb: true,
    enableAgentJs: true,
    enableAgentSearch: true,
    enableAgentChart: true
  }, 'es');

  assert.ok(guideEs.includes('AVAILABLE TOOLS AND FUNCTIONS'));
  assert.ok(guideEs.includes('fetch_web_page'));
  assert.ok(guideEs.includes('search_web'));
  assert.ok(guideEs.includes('execute_javascript'));
  assert.ok(guideEs.includes('render_chart'));
});

test('ChatEngine - injectStreamingCursor inserta el cursor antes de cerrar etiquetas', (t) => {
  const htmlWithTag = '<p>Hola mundo</p>';
  const res = ChatEngine.injectStreamingCursor(htmlWithTag);
  assert.equal(res, '<p>Hola mundo<span class="streaming-cursor"></span></p>');

  const plainText = 'Texto sin etiquetas';
  const resPlain = ChatEngine.injectStreamingCursor(plainText);
  assert.equal(resPlain, 'Texto sin etiquetas<span class="streaming-cursor"></span>');

  const empty = '';
  const resEmpty = ChatEngine.injectStreamingCursor(empty);
  assert.equal(resEmpty, '<span class="streaming-cursor"></span>');
});

test('ChatEngine - buildEffectiveMessages inyecta fecha, RAG y formatea mensajes', (t) => {
  const history = [
    { role: 'user', content: '¿Qué manuales tengo disponibles?' }
  ];

  const appConfig = {
    systemPrompt: 'Eres un asistente experto.',
    systemDataPrompt: '[Format: Always use standard Markdown and plain text.]',
    language: 'es',
    activeRagBranchId: 'branch_123',
    enableAgentJs: true
  };

  const options = {
    currentRagSystemContext: '[BASE DE CONOCIMIENTO ACTIVA: Manual GA-Z77P-D3]'
  };

  const messages = ChatEngine.buildEffectiveMessages(history, appConfig, options);

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

test('ChatEngine - executeAgentTurnLoop ejecuta un turno simple sin herramientas', async (t) => {
  const originalStream = ChatAPI.streamChatCompletion;
  let receivedApiKey;

  // Mock de streamChatCompletion para respuesta directa
  ChatAPI.streamChatCompletion = async (params) => {
    receivedApiKey = params.apiKey;
    if (params.onChunk) {
      params.onChunk('Hola, ', 'Hola, ', { ttftSec: '0.12', tokensPerSec: '50.0', totalSec: '0.20', tokens: 10 });
      params.onChunk('Hola, ¿en qué puedo ayudarte hoy?', '¿en qué puedo ayudarte hoy?', { ttftSec: '0.12', tokensPerSec: '55.0', totalSec: '0.35', tokens: 20 });
    }
    if (params.onDone) {
      params.onDone('Hola, ¿en qué puedo ayudarte hoy?', { ttftSec: '0.12', tokensPerSec: '55.0', totalSec: '0.35', tokens: 20 }, null);
    }
    return {
      accumulatedText: 'Hola, ¿en qué puedo ayudarte hoy?',
      stats: { ttftSec: '0.12', tokensPerSec: '55.0', totalSec: '0.35', tokens: 20 },
      toolCalls: null
    };
  };

  const history = [
    { role: 'user', content: 'Hola' }
  ];

  const appConfig = {
    apiUrl: 'http://localhost:1234/v1',
    apiType: 'openai',
    model: 'test-model',
    temperature: '0.7',
    language: 'es'
  };

  let chunksReceived = [];
  const res = await ChatEngine.executeAgentTurnLoop({
    apiUrl: appConfig.apiUrl,
    apiType: appConfig.apiType,
    apiKey: 'test-key',
    model: appConfig.model,
    chatHistory: history,
    appConfig: appConfig,
    assistantMsgId: 'asst_test',
    onChunk: ({ fullText }) => {
      chunksReceived.push(fullText);
    }
  });

  assert.equal(res.success, true);
  assert.equal(receivedApiKey, 'test-key');
  assert.equal(res.finalAssistantText, 'Hola, ¿en qué puedo ayudarte hoy?');
  assert.equal(history.length, 2);
  assert.equal(history[1].role, 'assistant');
  assert.equal(history[1].content, 'Hola, ¿en qué puedo ayudarte hoy?');

  // Restaurar API
  ChatAPI.streamChatCompletion = originalStream;
});

test('ChatEngine - executeAgentTurnLoop ejecuta llamadas a herramientas y genera turno final', async (t) => {
  const originalStream = ChatAPI.streamChatCompletion;
  let callCount = 0;

  ChatAPI.streamChatCompletion = async (params) => {
    callCount++;
    if (callCount === 1) {
      // Turno 1: Devuelve una llamada a execute_javascript
      const tc = [{
        id: 'call_calc_1',
        type: 'function',
        function: {
          name: 'execute_javascript',
          arguments: JSON.stringify({ code: 'const a = 15; const b = 25; return a + b;' })
        }
      }];
      if (params.onDone) params.onDone('', null, tc);
      return { accumulatedText: '', toolCalls: tc, stats: null };
    } else {
      // Turno 2: Respuesta final con el resultado
      const finalMsg = 'El resultado de la suma de 15 y 25 es 40.';
      if (params.onChunk) params.onChunk(finalMsg, finalMsg, null);
      if (params.onDone) params.onDone(finalMsg, null, null);
      return { accumulatedText: finalMsg, toolCalls: null, stats: null };
    }
  };

  const history = [
    { role: 'user', content: '¿Cuánto es 15 + 25?' }
  ];

  const appConfig = {
    apiUrl: 'http://localhost:1234/v1',
    apiType: 'openai',
    model: 'test-model',
    language: 'es',
    enableAgentJs: true
  };

  const res = await ChatEngine.executeAgentTurnLoop({
    apiUrl: appConfig.apiUrl,
    apiType: appConfig.apiType,
    model: appConfig.model,
    chatHistory: history,
    appConfig: appConfig,
    assistantMsgId: 'asst_calc'
  });

  assert.equal(res.success, true);
  assert.equal(res.finalAssistantText, 'El resultado de la suma de 15 y 25 es 40.');
  assert.equal(history.length, 4); // user -> assistant (tool call) -> tool (res) -> assistant (final)
  assert.equal(history[1].role, 'assistant');
  assert.ok(history[1].tool_calls);
  assert.equal(history[2].role, 'tool');
  assert.ok(history[2].content.includes('40'));
  assert.equal(history[3].role, 'assistant');

  ChatAPI.streamChatCompletion = originalStream;
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
      params.onDone('', null, toolCalls);
      return { accumulatedText: '', toolCalls, stats: null };
    }
    secondRequestMessages = params.messages;
    params.onDone('I inspected the image.', null, null);
    return { accumulatedText: 'I inspected the image.', toolCalls: null, stats: null };
  };

  try {
    const history = [{ role: 'user', content: 'Inspect the diagram.' }];
    await ChatEngine.executeAgentTurnLoop({
      chatHistory: history,
      appConfig: { apiUrl: 'http://localhost:1234/v1', apiType: 'openai', model: 'test-model', activeRagBranchId: 'branch_1' }
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
      params.onDone('I will calculate it.', null, toolCalls);
      return { accumulatedText: 'I will calculate it.', toolCalls, stats: null };
    }
    params.onDone('The result is 4.', null, null);
    return { accumulatedText: 'The result is 4.', toolCalls: null, stats: null };
  };

  try {
    const result = await ChatEngine.executeAgentTurnLoop({
      chatHistory: [{ role: 'user', content: 'Calculate 2 + 2.' }],
      appConfig: { apiUrl: 'http://localhost:1234/v1', apiType: 'openai', model: 'test-model' }
    });
    assert.equal(result.accumulatedMarkdown, 'I will calculate it.\n\n> tool result\n\nThe result is 4.');
  } finally {
    ChatAPI.streamChatCompletion = originalStream;
    ChatAgentCore.dispatchToolCall = originalDispatch;
  }
});

test('ChatEngine - executeAgentTurnLoop protege contra bucles infinitos repetidos', async (t) => {
  const originalStream = ChatAPI.streamChatCompletion;

  // Mock que siempre devuelve exactamente la misma llamada a herramienta
  ChatAPI.streamChatCompletion = async (params) => {
    const tc = [{
      id: 'call_loop_1',
      type: 'function',
      function: {
        name: 'execute_javascript',
        arguments: JSON.stringify({ code: '2 + 2' })
      }
    }];
    if (params.onDone) params.onDone('', null, tc);
    return { accumulatedText: '', toolCalls: tc, stats: null };
  };

  const history = [
    { role: 'user', content: 'Repite' }
  ];

  const appConfig = {
    apiUrl: 'http://localhost:1234/v1',
    apiType: 'openai',
    model: 'test-model',
    enableAgentJs: true
  };

  let errorLogs = [];
  const statuses = [];
  const res = await ChatEngine.executeAgentTurnLoop({
    apiUrl: appConfig.apiUrl,
    apiType: appConfig.apiType,
    model: appConfig.model,
    chatHistory: history,
    appConfig: appConfig,
    onLog: (type, text) => {
      if (type === 'error') errorLogs.push(text);
    },
    onGenerationStatus: status => statuses.push(status)
  });

  assert.equal(res.success, true);
  assert.equal(res.loopDetected, true);
  assert.ok(statuses.some(s => s.phase === 'error' && (s.text.includes('bucle infinito') || s.text.includes('loop'))), 'Debe emitir estado de parada por bucle infinito');
  assert.ok(res.finalAssistantText.includes('Infinite Loop Protection'));
  assert.ok(errorLogs.some(msg => msg.includes('[Protección Bucle Infinito]')));
  assert.equal(history.at(-1).role, 'assistant');
  assert.equal(history.at(-1).content, res.finalAssistantText);

  ChatAPI.streamChatCompletion = originalStream;
});

test('ChatEngine - executeAgentTurnLoop limpia el cursor inicial del contenedor en turnIndex 0', async (t) => {
  const originalStream = ChatAPI.streamChatCompletion;

  ChatAPI.streamChatCompletion = async (params) => {
    if (params.onChunk) {
      params.onChunk('Respuesta de prueba', 'Respuesta de prueba', { ttftSec: '0.1', tokensPerSec: '40', totalSec: '0.2', tokens: 5 });
    }
    if (params.onDone) {
      params.onDone('Respuesta de prueba', null, null);
    }
    return { accumulatedText: 'Respuesta de prueba', toolCalls: null, stats: null };
  };

  const fakeContainer = {
    innerHTML: '<span class="streaming-cursor initial-cursor"></span>',
    querySelectorAll: () => [],
    appendChild: (child) => {
      fakeContainer.children = fakeContainer.children || [];
      fakeContainer.children.push(child);
    }
  };

  global.document = {
    createElement: (tag) => ({
      tagName: tag,
      className: '',
      style: {},
      setAttribute: () => {},
      appendChild: () => {},
      querySelectorAll: () => [],
      ownerDocument: global.document
    })
  };

  const res = await ChatEngine.executeAgentTurnLoop({
    apiUrl: 'http://localhost:1234/v1',
    apiType: 'openai',
    model: 'test-model',
    chatHistory: [{ role: 'user', content: 'Hola' }],
    appConfig: { apiUrl: 'http://localhost:1234/v1', model: 'test-model' },
    container: fakeContainer
  });

  // El cursor inicial debe haberse limpiado antes de añadir el agentic-turn-block
  assert.equal(res.success, true);
  assert.equal(fakeContainer.innerHTML, '');
  assert.match(fakeContainer.children[0].innerHTML, /Respuesta de prueba/);
  assert.doesNotMatch(fakeContainer.children[0].innerHTML, /streaming-cursor/);

  ChatAPI.streamChatCompletion = originalStream;
  delete global.document;
});

test('ChatEngine - executeAgentTurnLoop muestra una línea de compactación antes de la respuesta', async () => {
  const originalStream = ChatAPI.streamChatCompletion;
  const history = [];
  for (let index = 0; index < 4; index++) {
    history.push(
      { role: 'user', content: `Pregunta ${index}: ${'detalle '.repeat(60)}` },
      { role: 'assistant', content: `Respuesta ${index}: ${'resultado '.repeat(60)}` }
    );
  }

  ChatAPI.streamChatCompletion = async (params) => {
    if (params.toolChoice === 'none') return { accumulatedText: 'Checkpoint acumulativo.' };
    params.onChunk?.('Respuesta final', 'Respuesta final', null);
    return { accumulatedText: 'Respuesta final', toolCalls: null, stats: null };
  };

  const fakeContainer = {
    innerHTML: '',
    children: [],
    appendChild: child => fakeContainer.children.push(child)
  };
  global.document = {
    createElement: tag => ({ tagName: tag, className: '', innerHTML: '', querySelectorAll: () => [], ownerDocument: global.document })
  };

  try {
    const res = await ChatEngine.executeAgentTurnLoop({
      chatHistory: history,
      appConfig: { apiUrl: 'http://localhost:1234/v1', model: 'test-model', modelContextLimit: 300 },
      container: fakeContainer
    });

    assert.equal(res.success, true);
    assert.equal(fakeContainer.children.length, 2);
    assert.match(fakeContainer.children[0].innerHTML, /Compactando contexto\.\.\.\.\./);
    assert.match(fakeContainer.children[1].innerHTML, /Respuesta final/);
    assert.equal(history[0]._isSummaryBlock, true);
  } finally {
    ChatAPI.streamChatCompletion = originalStream;
    delete global.document;
  }
});

test('ChatEngine - removeTurnFromHistory elimina múltiples llamadas sucesivas a herramientas', () => {
  const baseId = 'msg_multi_tools';
  const history = [
    { id: 'usr_1', role: 'user', content: 'Calcula y grafica' },
    {
      id: `${baseId}_turn_0_assistant`,
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_calc', type: 'function', function: { name: 'execute_javascript', arguments: '{"code":"2+2"}' } }]
    },
    {
      id: `${baseId}_turn_0_tool_call_calc`,
      role: 'tool',
      tool_call_id: 'call_calc',
      name: 'execute_javascript',
      content: '{"result":4}'
    },
    {
      id: `${baseId}_turn_1_assistant`,
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_chart', type: 'function', function: { name: 'render_chart', arguments: '{"data":[4]}' } }]
    },
    {
      id: `${baseId}_turn_1_tool_call_chart`,
      role: 'tool',
      tool_call_id: 'call_chart',
      name: 'render_chart',
      content: '{"rendered":true}'
    },
    {
      id: `${baseId}_final`,
      role: 'assistant',
      content: 'El resultado es 4 y se ha graficado.'
    }
  ];

  const updated = ChatEngine.removeTurnFromHistory(history, { msgId: baseId, baseId });
  assert.equal(updated.length, 1);
  assert.equal(updated[0].id, 'usr_1');
  assert.equal(updated.filter(m => m.role === 'tool').length, 0, 'Todas las respuestas de tool deben eliminarse');
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
  const cleanedHistory = ChatEngine.removeTurnFromHistory(chatHistory, { msgId: baseId, baseId });

  // 2. El usuario envía una siguiente petición
  cleanedHistory.push({
    id: 'u2',
    role: 'user',
    content: 'Ahora dime la hora'
  });

  // 3. ChatEngine construye los mensajes efectivos para la API de inferencia
  const effective = ChatEngine.buildEffectiveMessages(cleanedHistory, {
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
  const first = ChatEngine.buildEffectiveMessages(history, config);
  history.push({ role: 'assistant', content: 'Respuesta' }, { role: 'user', content: 'Segunda pregunta' });
  const next = ChatEngine.buildEffectiveMessages(history, config);
  assert.equal(first.find(m => m.role === 'user').content, next.find(m => m.role === 'user').content);
  assert.equal(next.filter(m => m.role === 'user')[1].content, 'Segunda pregunta');
  assert.ok(!JSON.stringify(next).includes('[Context Time:'));
});


test('ChatEngine - fecha inicial estable al cambiar día, idioma y serializar el historial', () => {
  const history = [{ role: 'system', content: 'Sistema' }, { role: 'user', content: 'Hola' }];
  const anchor = ChatEngine.ensureConversationDate(history, 'es', '2026-01-01T12:00:00Z');
  assert.match(anchor, /2026-01-01/);
  const before = ChatEngine.buildEffectiveMessages(history);
  const restored = JSON.parse(JSON.stringify(history));
  assert.equal(ChatEngine.ensureConversationDate(restored, 'en', '2026-02-02T12:00:00Z'), anchor);
  const after = ChatEngine.buildEffectiveMessages(restored);
  assert.deepEqual(after, before);
  assert.equal(after[0].content.split(anchor).length - 1, 1);
  assert.equal(after[1].content, 'Hola');
  assert.ok(after.every(m => !Object.hasOwn(m, 'contextDateAnchor')));
  assert.ok(!/\d{2}:\d{2}/.test(anchor));
  assert.equal(ChatEngine.buildEffectiveMessages(restored)[0].content, before[0].content);
});


test('ChatEngine - inyecta la fecha inicial de forma incondicional sin forzar el modo de herramientas si están desactivadas', () => {
  const enabledTools = Object.fromEntries(ChatAgentCore.registry.getActiveDefinitions({}).map(t => [t.function.name, false]));
  const config = { enabledTools };
  const defs = ChatAgentCore.registry.getActiveDefinitions(config);
  assert.equal(defs.length, 0, 'No debe haber herramientas activas si todas están desmarcadas');
  const messages = ChatEngine.buildEffectiveMessages([{ role: 'user', content: 'Hola' }], config);
  assert.match(messages[0].content, /Conversation start date/);
});

test('ChatEngine - no duplica los chunks de razonamiento al invocar onReasoningChunk y onLog', async () => {
  const originalStream = ChatAPI.streamChatCompletion;

  ChatAPI.streamChatCompletion = async (params) => {
    if (params.onReasoningChunk) {
      params.onReasoningChunk('Pol');
      params.onReasoningChunk('itely');
    }
    if (params.onChunk) {
      params.onChunk('Respuesta', 'Respuesta', null);
    }
    if (params.onDone) {
      params.onDone('Respuesta', null, null);
    }
    return {
      accumulatedText: 'Respuesta',
      stats: null,
      toolCalls: null
    };
  };

  const reasoningChunks = [];
  const logEvents = [];

  const res = await ChatEngine.executeAgentTurnLoop({
    apiUrl: 'http://localhost:1234/v1',
    apiType: 'openai',
    model: 'test-model',
    chatHistory: [{ role: 'user', content: 'Hola' }],
    appConfig: { apiUrl: 'http://localhost:1234/v1', apiType: 'openai', model: 'test-model' },
    assistantMsgId: 'asst_reasoning_test',
    onReasoningChunk: (chunk) => {
      reasoningChunks.push(chunk);
    },
    onLog: (type, text) => {
      logEvents.push({ type, text });
    }
  });

  assert.equal(res.success, true);
  // Se deben recibir exactamente los 2 chunks sin duplicarse
  assert.deepEqual(reasoningChunks, ['Pol', 'itely']);
  // onLog no debe recibir logs de tipo 'thinking' puesto que onReasoningChunk los procesó
  const thinkingLogs = logEvents.filter(l => l.type === 'thinking');
  assert.equal(thinkingLogs.length, 0);

  ChatAPI.streamChatCompletion = originalStream;
});

test('ChatEngine - executeAgentTurnLoop finaliza con éxito al alcanzar límite de turnos (15) aunque falle la síntesis', async (t) => {
  const originalStream = ChatAPI.streamChatCompletion;

  let callCount = 0;
  let synthesisPrompt = '';
  ChatAPI.streamChatCompletion = async (params) => {
    callCount++;
    if (params.enableTools === false) {
      // Simular fallo de red o rechazo de servidor en la síntesis final
      synthesisPrompt = params.messages.at(-1)?.content || '';
      throw new Error('HTTP 500: Server synthesis failed');
    }
    const tc = [{
      id: 'call_turn_' + callCount,
      type: 'function',
      function: {
        name: 'execute_javascript',
        arguments: JSON.stringify({ code: `let v = ${callCount}` })
      }
    }];
    if (params.onDone) params.onDone('', null, tc);
    return { accumulatedText: '', toolCalls: tc, stats: null };
  };

  const history = [{ role: 'user', content: 'Ejecuta 15 herramientas' }];
  const appConfig = {
    apiUrl: 'http://localhost:1234/v1',
    apiType: 'openai',
    model: 'test-model',
    enableAgentJs: true,
    language: 'es'
  };

  const res = await ChatEngine.executeAgentTurnLoop({
    apiUrl: appConfig.apiUrl,
    apiType: appConfig.apiType,
    model: appConfig.model,
    chatHistory: history,
    appConfig: appConfig,
    maxAgentTurns: 15
  });

  assert.equal(res.success, true);
  assert.ok(callCount >= 15, 'Debe haber ejecutado al menos 15 llamadas');
  assert.match(synthesisPrompt, /Prefer a brief, clear answer/, 'La síntesis debe priorizar una respuesta concisa');
  assert.match(synthesisPrompt, /Do not enumerate tool calls or results/, 'La síntesis no debe pedir un listado de herramientas');
  assert.equal(res.finalAssistantText, 'I could not produce a final answer after processing the available information. Please try again.');
  assert.doesNotMatch(res.finalAssistantText, /let v =|Summary of Consulted Information/, 'El fallback no debe exponer resultados crudos de herramientas');
  assert.ok(history.some(m => m.id && m.id.endsWith('_final')), 'Debe registrar el turno final en el historial');

  ChatAPI.streamChatCompletion = originalStream;
});

test('ChatEngine - con herramientas en texto (WebLLM) no inyecta la guía de pseudo-firmas', () => {
  require('../../js/providers-webllm.js');
  const appConfig = { apiType: 'webllm', apiUrl: 'webllm://local', model: 'Qwen3-4B-q4f16_1-MLC', language: 'es', enabledTools: { search_web: true } };
  const messages = ChatEngine.buildEffectiveMessages([{ role: 'user', content: 'Hola' }], appConfig, { enableTools: true });
  const system = messages.find(message => message.role === 'system')?.content || '';
  assert.equal(system.includes('AVAILABLE TOOLS AND FUNCTIONS'), false);
  assert.ok(system.includes('*Workflow instruction:*'));
});
