/**
 * Suite de pruebas de integración para ChatEngine (js/chat-engine.js).
 * Verifica:
 * 1. Formateo de fechas iniciales y guías de herramientas en System Prompt.
 * 2. Inyección y anclaje de mensajes efectivos para Context-Caching.
 * 3. Orquestación del bucle agéntico con streaming, llamadas a herramientas y cancelación mediante AbortSignal.
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

test('ChatEngine - buildEffectiveMessages reenvía la firma del razonamiento, agrupa llamadas paralelas y coloca la evidencia visual al final del lote', () => {
  const replayMsgs = buildMessages([
    { role: 'user', content: 'Pregunta' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
      reasoningReplay: { field: 'thinking', text: 'plan', signature: '' } },
    { role: 'tool', tool_call_id: 'c1', name: 'read_file', content: 'a' }
  ]);
  const assistant = replayMsgs.find(m => m.role === 'assistant');
  assert.equal(assistant.thinking, 'plan');
  assert.equal(assistant.reasoning_signature, '');

  const parallelMsgs = buildMessages([
    { role: 'user', content: 'Busca dos cosas' },
    { role: 'assistant', content: null, tool_calls: [
      { id: 'call_a', type: 'function', function: { name: 'search_a', arguments: '{}' } },
      { id: 'call_b', type: 'function', function: { name: 'search_b', arguments: '{}' } }
    ] },
    { role: 'tool', tool_call_id: 'call_a', name: 'search_a', content: 'A' },
    { role: 'tool', tool_call_id: 'call_b', name: 'search_b', content: 'B' },
    { role: 'tool', tool_call_id: 'call_orphan', name: 'orphan', content: 'C' }
  ], {}, { enableTools: false });
  const parallelTail = parallelMsgs.slice(parallelMsgs.findIndex(message => message.role === 'assistant'));
  assert.deepEqual(parallelTail.map(message => message.role), ['assistant', 'tool', 'tool', 'assistant', 'tool']);
  assert.deepEqual(parallelTail[3].tool_calls.map(call => call.id), ['call_orphan']);

  const longResult = 'x'.repeat(5000);
  const messages = buildMessages([
    { role: 'user', content: 'compara' },
    { role: 'assistant', content: null, tool_calls: [
      { id: 'call_image', type: 'function', function: { name: 'read_knowledge_image', arguments: '{}' } },
      { id: 'call_text', type: 'function', function: { name: 'search_web', arguments: '{}' } },
      { id: 'call_shot', type: 'function', function: { name: 'browser_action', arguments: '{}' } }
    ] },
    { role: 'tool', tool_call_id: 'call_image', name: 'read_knowledge_image', content: 'Imagen recuperada.', images: [{ dataUrl: 'data:image/png;base64,AA==', imageRef: 'rag-image://doc_1:img_1', documentTitle: 'diagrama.md', page: 2 }] },
    { role: 'tool', tool_call_id: 'call_text', name: 'search_web', content: longResult },
    { role: 'tool', tool_call_id: 'call_shot', name: 'browser_action', content: '{}', images: [{ dataUrl: 'data:image/png;base64,BB==', url: 'https://example.com/' }] }
  ], {}, { enableTools: false });

  const tail = messages.slice(messages.findIndex(message => message.role === 'assistant'));
  assert.deepEqual(tail.map(message => message.role), ['assistant', 'tool', 'tool', 'tool', 'user']);
  assert.equal(tail[0].tool_calls.length, 3);
  assert.deepEqual(tail[4], {
    role: 'user',
    content: [
      { type: 'text', text: 'Visual evidence returned by read_knowledge_image: rag-image://doc_1:img_1 · diagrama.md · page 2' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
      { type: 'text', text: 'Visual evidence returned by browser_action: https://example.com/' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,BB==' } }
    ]
  });
  assert.equal(tail[2].content, longResult);
});

test('ChatEngine - buildEffectiveMessages inyecta fecha estable, RAG, directorio del proyecto y guía de herramientas', () => {
  const anchor = ChatEngine.getConversationDateAnchor();
  assert.ok(anchor.includes('Conversation start date:') && anchor.includes('Timezone:'));

  const history = [{ role: 'user', content: '¿Qué manuales tengo disponibles?' }];
  const appConfig = {
    systemPrompt: 'Eres un asistente experto.',
    systemDataPrompt: '[Format: Always use standard Markdown and plain text.]',
    language: 'es',
    activeRagBranchIds: ['branch_123']
  };
  const messages = buildMessages(history, appConfig, {
    currentRagSystemContext: '[BASE DE CONOCIMIENTO ACTIVA: Manual GA-Z77P-D3]',
    enableTools: true,
    projectDirectory: '/home/u/app'
  });

  assert.equal(messages[0].role, 'system');
  assert.ok(messages[0].content.includes('[BASE DE CONOCIMIENTO ACTIVA: Manual GA-Z77P-D3]'));
  assert.ok(messages[0].content.includes('Conversation start date:'));
  assert.ok(messages[0].content.includes('Eres un asistente experto.'));
  assert.ok(messages[0].content.includes('[Format: Always use standard Markdown and plain text.]'));
  assert.ok(messages[0].content.includes('Knowledge Base active'));
  assert.ok(messages[0].content.includes('*Project directory:* /home/u/app.'));
  assert.equal(messages[1].content, history[0].content);

  // Sin herramientas o sin directorio no inyecta Project directory, pero sí la fecha
  const enabledTools = Object.fromEntries(ChatAgentCore.registry.getActiveDefinitions(config()).map(t => [t.function.name, false]));
  assert.equal(ChatAgentCore.registry.getActiveDefinitions(config({ enabledTools })).length, 0);
  const withoutTools = buildMessages(history, { ...appConfig, enabledTools }, { enableTools: false, projectDirectory: '/home/u/app' });
  assert.ok(!withoutTools[0].content.includes('Project directory'));
  assert.match(withoutTools[0].content, /Conversation start date/);

  // Con herramientas en texto (WebLLM) no inyecta la guía de pseudo-firmas
  require('../../js/providers-webllm.js');
  const webllmMsgs = buildMessages([{ role: 'user', content: 'Hola' }], {
    apiType: 'webllm', apiUrl: 'webllm://local', model: 'Qwen3-4B-q4f16_1-MLC', language: 'es', enabledTools: { search_web: true }
  }, { enableTools: true });
  assert.equal(webllmMsgs[0].content.includes('AVAILABLE TOOLS AND FUNCTIONS'), false);
  assert.ok(webllmMsgs[0].content.includes('*Workflow instruction:*'));

  // Fecha inicial estable al cambiar día y serializar el historial
  const datedHistory = [{ role: 'system', content: 'Sistema' }, { role: 'user', content: 'Hola' }];
  const fixedAnchor = ChatEngine.ensureConversationDate(datedHistory, '2026-01-01T12:00:00Z');
  assert.match(fixedAnchor, /2026-01-01/);
  const before = buildMessages(datedHistory);
  const restored = JSON.parse(JSON.stringify(datedHistory));
  assert.equal(ChatEngine.ensureConversationDate(restored, '2026-02-02T12:00:00Z'), fixedAnchor);
  assert.deepEqual(buildMessages(restored), before);
});

test('ChatEngine - executeAgentTurnLoop conserva evidencia RAG multimodal, ordena el markdown intermedio e inyecta el contexto del proyecto', async () => {
  const originalStream = ChatAPI.streamChatCompletion;
  const originalDispatch = ChatAgentCore.dispatchToolCall;
  let calls = 0;
  let secondRequestMessages = null;
  let sentSystem = '';

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
  ChatAPI.streamChatCompletion = async params => {
    calls++;
    sentSystem = params.messages.find(message => message.role === 'system')?.content || '';
    if (calls === 1) {
      const toolCalls = [{ id: 'image_call', type: 'function', function: { name: 'read_knowledge_image', arguments: '{}' } }];
      return { accumulatedText: 'I will inspect it.', toolCalls, stats: null };
    }
    secondRequestMessages = params.messages;
    return { accumulatedText: 'I inspected the image.', toolCalls: null, stats: null };
  };

  try {
    const history = [{ role: 'user', content: 'Inspect the diagram.' }];
    const result = await runTurn({
      chatHistory: history,
      appConfig: { apiUrl: 'http://localhost:1234/v1', apiType: 'openai', model: 'test-model', activeRagBranchIds: ['branch_1'] },
      projectContext: {
        status: 'ready',
        cwd: '/home/u/repo',
        rules: { content: 'Project rules: AGENTS.md', truncated: false },
        state: { content: '- Next step: tests', truncated: false }
      }
    });

    assert.ok(history.find(message => message.role === 'tool')?.images?.[0]?.dataUrl);
    assert.ok(secondRequestMessages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url')));
    assert.equal(result.accumulatedMarkdown, 'I will inspect it.\n\n> image\n\nI inspected the image.');
    assert.match(sentSystem, /rooted at \/home\/u\/repo/);
  } finally {
    ChatAPI.streamChatCompletion = originalStream;
    ChatAgentCore.dispatchToolCall = originalDispatch;
  }
});

test('ChatEngine - al parar o fallar el proveedor devuelve los pasos ejecutados sin las llamadas pendientes ni el bloque fallido', async () => {
  const originalStream = ChatAPI.streamChatCompletion;
  const originalDispatch = ChatAgentCore.dispatchToolCall;
  const controller = new AbortController();
  const dispatched = [];

  ChatAgentCore.dispatchToolCall = async call => {
    dispatched.push(call.id);
    controller.abort();
    return { success: true, result: { value: 'A' }, resultText: 'A', markdownBlock: '> A' };
  };
  ChatAPI.streamChatCompletion = async () => ({
    accumulatedText: 'Searching.',
    toolCalls: [
      { id: 'call_a', type: 'function', function: { name: 'search_web', arguments: '{}' } },
      { id: 'call_b', type: 'function', function: { name: 'fetch_web_page', arguments: '{}' } }
    ],
    stats: null
  });

  try {
    const result = await runTurn({ chatHistory: [{ role: 'user', content: 'Search and read.' }], signal: controller.signal });
    assert.equal(result.cancelled, true);
    assert.deepEqual(dispatched, ['call_a']);
    assert.deepEqual(result.chatHistory.map(message => message.role), ['user', 'assistant', 'tool']);
    assert.deepEqual(result.chatHistory[1].tool_calls.map(call => call.id), ['call_a']);

    let calls = 0;
    ChatAgentCore.dispatchToolCall = async () => ({ success: true, result: { value: 'A' }, resultText: 'A', markdownBlock: '> A' });
    ChatAPI.streamChatCompletion = async params => {
      if (++calls === 1) {
        return { accumulatedText: 'Searching.', toolCalls: [{ id: 'call_a', type: 'function', function: { name: 'search_web', arguments: '{}' } }], stats: null };
      }
      params.onChunk('Partial', 'Partial', null);
      throw new Error('Overloaded');
    };
    const view = createTurnView();
    const errRes = await runTurn({ chatHistory: [{ role: 'user', content: 'Search.' }], view });
    assert.equal(errRes.error.message, 'Overloaded');
    assert.deepEqual(errRes.chatHistory.map(message => message.role), ['user', 'assistant', 'tool']);
    assert.deepEqual(view.blocks.map(block => block.text), ['Searching.']);
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


const READY_PROJECT = {
  status: 'ready',
  cwd: '/home/u/repo',
  rules: { content: 'Project rules: AGENTS.md', truncated: false },
  state: { content: '- Next step: tests', truncated: false }
};

test('ChatEngine - el bloque del proyecto sigue tras compactación y antepone la nota de comandos terminados, también con imágenes', () => {
  const history = [
    { role: 'system', content: 'Checkpoint acumulativo', _isSummaryBlock: true },
    { role: 'user', content: 'Continúa' }
  ];
  const compacted = buildMessages(history, {}, { enableTools: false, projectContext: READY_PROJECT });
  assert.equal(compacted[0].role, 'system');
  assert.match(compacted[0].content, /Project mode/);
  assert.ok(compacted.some(message => message.content === 'Checkpoint acumulativo'));

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
    assert.deepEqual(request.messages.map(m => m.role), ['system', 'user']);
    assert.equal(request.messages[0].content, 'SUMMARIZE');
    assert.match(request.messages[1].content, /<conversation_history>[\s\S]*User: hola[\s\S]*<\/conversation_history>/);
  } finally {
    ChatAPI.streamChatCompletion = originalStream;
  }
});


test('ChatEngine - switch_model cambia de perfil y de razonamiento desde el siguiente paso, solo con perfiles que nombró el usuario', async t => {
  const Profiles = require('../../js/profile-repository.js');
  const State = require('../../js/state.js');
  const Storage = require('../../js/storage.js');
  const profile = (id, name, model, reasoningEffort) => ({
    id, name, version: 1, settings: { apiUrl: `http://${id}/v1`, apiType: 'openai', model, reasoningEffort, apiKey: `key-${id}` }
  });
  const profiles = [profile('argon', 'Argon', 'argon-1', 'medium'), profile('gemini', 'Gemini', 'gemini-x', 'low'), profile('otro', 'Otro', 'otro-1', 'low')];
  t.mock.method(Profiles, 'list', () => profiles);
  t.mock.method(Profiles, 'get', id => profiles.find(item => item.id === id) || null);
  t.mock.method(Profiles, 'loadUnlocked', async id => profiles.find(item => item.id === id) || null);
  t.mock.method(Storage, 'saveRuntimeConfigV2', () => {});
  const previousConfig = State.get('config');
  t.after(() => State.set('config', previousConfig));
  State.set('config', config({ apiUrl: 'http://inicio/v1', model: 'inicio-1', reasoningEffort: 'medium' }));

  const calls = [
    { profile: 'argon', reasoning: 'high' },
    { profile: 'Otro' },
    { profile: 'Desconocido' },
    { profile: 'Gemini', reasoning: 'medium' }
  ];
  const sent = [];
  t.mock.method(ChatAPI, 'streamChatCompletion', async params => {
    sent.push({ model: params.model, apiKey: params.apiKey, apiUrl: params.apiUrl, reasoningEffort: params.reasoningEffort });
    const args = calls[sent.length - 1];
    if (!args) return { accumulatedText: 'Hecho.', toolCalls: [], stats: null };
    return { accumulatedText: '', toolCalls: [{ id: `call_${sent.length}`, type: 'function', function: { name: 'switch_model', arguments: JSON.stringify(args) } }], stats: null };
  });

  const activated = [];
  const result = await runTurn({
    apiKey: 'key-inicio',
    appConfig: State.get('config'),
    chatHistory: [{ role: 'user', content: 'Analiza con el perfil Argon y razonamiento alto; luego ejecútalo con gemini y razonamiento normal.' }],
    activateProfile: async id => {
      activated.push(id);
      ChatConfig.activateProfile(id, { sessionOnly: true });
    }
  });

  assert.equal(result.finalAssistantText, 'Hecho.');
  assert.deepEqual(sent, [
    { model: 'inicio-1', apiKey: 'key-inicio', apiUrl: 'http://inicio/v1', reasoningEffort: 'medium' },
    { model: 'argon-1', apiKey: 'key-argon', apiUrl: 'http://argon/v1', reasoningEffort: 'high' },
    { model: 'argon-1', apiKey: 'key-argon', apiUrl: 'http://argon/v1', reasoningEffort: 'high' },
    { model: 'argon-1', apiKey: 'key-argon', apiUrl: 'http://argon/v1', reasoningEffort: 'high' },
    { model: 'gemini-x', apiKey: 'key-gemini', apiUrl: 'http://gemini/v1', reasoningEffort: 'medium' }
  ]);
  assert.deepEqual(activated, ['argon', 'gemini']);
  const toolResults = result.chatHistory.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
  assert.deepEqual(toolResults[0], { success: true, profile: 'Argon', model: 'argon-1', reasoning: 'high', note: 'From your next step on you run with this profile and reasoning level.' });
  assert.match(toolResults[1].error, /has not named the "Otro" profile/);
  // Un nombre que no existe no revela cuáles sí.
  assert.equal(toolResults[2].error, 'There is no profile named "Desconocido". Ask the user for the exact profile name.');
  assert.equal(toolResults[3].model, 'gemini-x');
  assert.equal(ChatConfig.getActive().activeProfile.name, 'Gemini');
});

test('ChatEngine - switch_model sin activateProfile solo cambia el razonamiento', async t => {
  const State = require('../../js/state.js');
  const Storage = require('../../js/storage.js');
  t.mock.method(Storage, 'saveRuntimeConfigV2', () => {});
  const previousConfig = State.get('config');
  t.after(() => State.set('config', previousConfig));
  State.set('config', config({ model: 'inicio-1', reasoningEffort: 'medium', sessionOnly: true }));
  const efforts = [];
  t.mock.method(ChatAPI, 'streamChatCompletion', async params => {
    efforts.push(params.reasoningEffort);
    const args = [{ reasoning: 'xhigh' }, { profile: 'Argon' }][efforts.length - 1];
    if (!args) return { accumulatedText: 'Hecho.', toolCalls: [], stats: null };
    return { accumulatedText: '', toolCalls: [{ id: `call_${efforts.length}`, type: 'function', function: { name: 'switch_model', arguments: JSON.stringify(args) } }], stats: null };
  });
  const Profiles = require('../../js/profile-repository.js');
  t.mock.method(Profiles, 'list', () => [{ id: 'argon', name: 'Argon', settings: {} }]);

  const result = await runTurn({ appConfig: State.get('config'), chatHistory: [{ role: 'user', content: 'Piensa al máximo y luego usa Argon.' }] });
  assert.deepEqual(efforts, ['medium', 'xhigh', 'xhigh']);
  const toolResults = result.chatHistory.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
  assert.equal(toolResults[0].reasoning, 'xhigh');
  assert.equal(toolResults[1].error, 'Switching the profile is not available here.');
});
