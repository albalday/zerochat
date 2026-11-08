const { test } = require('node:test');
const assert = require('node:assert/strict');
const ConversationService = require('../../js/conversation-service.js');
const GenerationController = require('../../js/generation-controller.js');
const ChatAPI = require('../../js/api.js');
const State = require('../../js/state.js');
const Storage = require('../../js/storage.js');

const HISTORY = [
  { id: 'm1', role: 'system', content: 'sys' },
  { id: 'm2', role: 'user', content: 'user 1' },
  { id: 'm3', role: 'assistant', content: 'asst 1' },
  { id: 'm4', role: 'user', content: 'user 2' },
  { id: 'm5', role: 'assistant', content: 'asst 2' }
];

/**
 * Conversación activa; devuelve la referencia de la respuesta de anclaje y las opciones de app.js.
 * `summarizing` registra cada cambio del indicador de progreso del resumen.
 */
async function setupBranch(t, history = HISTORY, anchorId = 'm5') {
  await Storage.deleteAllConversations();
  State.replaceConversation({ sessionId: 'parent_sess_1', sessions: [{ id: 'parent_sess_1', title: 'Parent Chat' }], messages: structuredClone(history) });
  const anchor = { msgId: anchorId, baseId: anchorId, explicitIds: [] };
  const summarizing = [];
  const options = {
    renderSessionMessages() {},
    renderSidebarChats() {},
    onSessionReset() {},
    resetComposerInput() {},
    closeMobileSidebar() {},
    onSummarizing: active => summarizing.push(active)
  };
  return { anchor, options, summarizing };
}

function useDialogs(t, confirmResults) {
  const previous = globalThis.ChatDialogs;
  const confirms = [];
  const alerts = [];
  globalThis.ChatDialogs = {
    confirm: async (message, opts) => { confirms.push({ message, opts }); return confirmResults.shift(); },
    alert: async message => { alerts.push(message); }
  };
  t.after(() => { globalThis.ChatDialogs = previous; });
  return { confirms, alerts };
}

/** El resumen es la única llamada al proveedor: se sustituye la red, no el motor. */
function useSummarizer(t, summarize) {
  const original = ChatAPI.streamChatCompletion;
  ChatAPI.streamChatCompletion = summarize;
  t.after(() => { ChatAPI.streamChatCompletion = original; });
}

async function savedBranches() {
  return (await Storage.getConversationsList()).filter(session => session.id !== 'parent_sess_1');
}

test('ConversationService - sin diálogo de resumen, la rama clona el historial hasta la respuesta elegida', async t => {
  const shortHistory = HISTORY.slice(0, 3);
  const { anchor, options } = await setupBranch(t, shortHistory, 'm3');
  useDialogs(t, []);
  assert.equal(await ConversationService.createConversationBranch(anchor, options), true);

  const sessionId = State.get('sessions').activeId;
  assert.notEqual(sessionId, 'parent_sess_1');
  assert.deepEqual(State.get('messages').map(message => message.id), [0, 1, 2].map(index => `msg_${sessionId}_${index}`));
  const stored = await Storage.getConversation(sessionId);
  assert.deepEqual(stored.history.map(message => message.content), shortHistory.map(message => message.content));
  assert.equal(stored.title, require('../../js/i18n.js').t('chat_branch_title', { title: 'Parent Chat' }));
});

test('ConversationService - con resumen, la rama compacta el contexto previo y conserva literal la respuesta de anclaje', async t => {
  const { anchor, options, summarizing } = await setupBranch(t);
  useDialogs(t, [{ accepted: true, checkboxChecked: true }]);
  const summarized = [];
  let busyDuringSummary = null;
  let summaryPrompt = '';
  useSummarizer(t, async ({ messages, signal }) => {
    busyDuringSummary = State.isConversationBusy();
    assert.equal(typeof signal.aborted, 'boolean');
    summaryPrompt = messages[1]?.content || '';
    return { accumulatedText: 'Consolidated summary of conversation' };
  });

  assert.equal(await ConversationService.createConversationBranch(anchor, options), true);
  assert.equal(busyDuringSummary, true, 'Mientras se resume la conversación está ocupada');
  assert.deepEqual(summarizing, [true, false], 'El indicador se muestra durante el resumen y se retira al terminar');
  assert.equal(State.isConversationBusy(), false);
  assert.equal(State.get('ui').generationStatus.phase, 'idle');
  assert.ok(summaryPrompt.includes('User: user 1') && summaryPrompt.includes('Assistant: asst 1') && summaryPrompt.includes('User: user 2'));
  assert.ok(!summaryPrompt.includes('asst 2'), 'La respuesta de anclaje no se resume');
  assert.deepEqual(State.get('messages').map(message => message.content), ['sys', 'Consolidated summary of conversation', 'asst 2']);
  assert.equal(State.get('messages')[1]._isSummaryBlock, true);
});

test('ConversationService - no bifurca mientras la conversación está ocupada', async t => {
  const { anchor, options } = await setupBranch(t);
  const { alerts } = useDialogs(t, []);
  State.set('streaming', { isGenerating: true });
  t.after(() => State.set('streaming', { isGenerating: false }));
  assert.equal(await ConversationService.createConversationBranch(anchor, options), false);
  assert.equal(alerts.length, 1);
  assert.deepEqual(await savedBranches(), []);
});

test('ConversationService - parar durante el resumen cancela la rama sin ofrecer el historial completo', async t => {
  const { anchor, options } = await setupBranch(t);
  const { confirms, alerts } = useDialogs(t, [{ accepted: true, checkboxChecked: true }]);
  useSummarizer(t, ({ signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')));
    GenerationController.handleStopGeneration();
  }));
  t.mock.method(console, 'warn', () => {});
  assert.equal(await ConversationService.createConversationBranch(anchor, options), false);
  assert.equal(confirms.length, 1, 'Solo el diálogo inicial');
  assert.equal(alerts.length, 0);
  assert.deepEqual(await savedBranches(), []);
  assert.equal(State.isConversationBusy(), false);
});

test('ConversationService - si el resumen falla ofrece bifurcar con el historial completo', async t => {
  t.mock.method(console, 'warn', () => {});
  {
    const { anchor, options } = await setupBranch(t);
    const { confirms } = useDialogs(t, [{ accepted: true, checkboxChecked: true }, true]);
    useSummarizer(t, async () => { throw new Error('provider down'); });
    assert.equal(await ConversationService.createConversationBranch(anchor, options), true);
    assert.equal(confirms.length, 2);
    assert.equal(State.get('messages').length, 5);
  }
  {
    const { anchor, options } = await setupBranch(t);
    useDialogs(t, [{ accepted: true, checkboxChecked: true }, false]);
    useSummarizer(t, async () => { throw new Error('provider down'); });
    assert.equal(await ConversationService.createConversationBranch(anchor, options), false);
    assert.deepEqual(await savedBranches(), []);
  }
});

test('ConversationService - una sesión sin mensajes del usuario no se guarda', async t => {
  await setupBranch(t, [{ id: 'm1', role: 'system', content: 'sys' }]);
  await ConversationService.saveCurrentSession({ renderSidebarChats() {} });
  assert.deepEqual(State.get('sessions').list, []);
  assert.equal(await Storage.getConversation('parent_sess_1'), null);
});

test('ConversationService - loadSessionsFromStorage inicializa al arrancar, conserva la sesión activa al reconectar y avisa si falla', async t => {
  await Storage.deleteAllConversations();
  await Storage.saveConversation(
    { id: 'saved_1', title: 'Guardada 1', createdAt: 1000, updatedAt: 2000 },
    [{ id: 'u1', role: 'user', content: 'Hola' }]
  );

  // 1. Arranque inicial sin sesión activa: crea conversación inicial y carga sesiones
  State.set('sessions', { activeId: null, list: [] });
  State.set('messages', []);
  let renderedMessages = 0;
  let renderedSidebar = 0;
  const options = {
    renderSessionMessages() { renderedMessages++; },
    renderSidebarChats() { renderedSidebar++; }
  };

  await ConversationService.loadSessionsFromStorage(options);
  const initialActiveId = State.get('sessions').activeId;
  assert.ok(initialActiveId);
  assert.equal(State.get('messages')[0].id, 'system_root');
  assert.deepEqual(State.get('sessions').list.map(s => s.id), ['saved_1']);
  assert.equal(renderedMessages, 1);
  assert.equal(renderedSidebar, 1);

  // 2. Reconexión con conversación activa en curso: actualiza la lista sin reiniciar la conversación activa
  State.replaceMessages([
    { id: 'system_root', role: 'system', content: 'sys' },
    { id: 'u_active', role: 'user', content: 'En curso' }
  ]);
  await Storage.saveConversation(
    { id: 'saved_2', title: 'Guardada 2', createdAt: 2000, updatedAt: 3000 },
    [{ id: 'u2', role: 'user', content: 'Nueva' }]
  );

  await ConversationService.loadSessionsFromStorage(options);
  assert.equal(State.get('sessions').activeId, initialActiveId);
  assert.equal(State.get('messages')[1].content, 'En curso');
  assert.deepEqual(State.get('sessions').list.map(s => s.id), ['saved_2', 'saved_1']);
  assert.equal(renderedMessages, 1, 'No debe repintar ni reiniciar los mensajes de la sesión activa');
  assert.equal(renderedSidebar, 2);

  // 3. Error de lectura o conexión: muestra alerta al usuario
  const { alerts } = useDialogs(t, []);
  t.mock.method(console, 'warn', () => {});
  t.mock.method(Storage, 'getConversationsList', async () => { throw new Error('Storage failure'); });

  await ConversationService.loadSessionsFromStorage(options);
  assert.equal(alerts.length, 1);
});

test('ConversationService - saveCurrentSession no sobrescribe en almacenamiento una conversación en ejecución en el servidor', async t => {
  await Storage.deleteAllConversations();
  const previousMcp = State.get('mcp');
  t.after(() => State.set('mcp', previousMcp));

  await Storage.saveConversation(
    { id: 'srv_running_1', title: 'Remota', createdAt: 1000, updatedAt: 2000 },
    [
      { id: 'u1', role: 'user', content: 'Pregunta inicial' },
      { id: 'a1', role: 'assistant', content: 'Respuesta guardada por el servidor en segundo plano' }
    ]
  );

  // El navegador aún tiene en memoria solo el primer mensaje y cambia de sesión mientras el servidor sigue ejecutando
  State.replaceConversation({
    sessionId: 'srv_running_1',
    sessions: [{ id: 'srv_running_1', title: 'Remota' }],
    messages: [{ id: 'u1', role: 'user', content: 'Pregunta inicial' }]
  });
  State.set('mcp', {
    ...previousMcp,
    serverRuns: [{ conversationId: 'srv_running_1', runId: 'r_1', status: 'running' }]
  });

  let sidebarRendered = 0;
  await ConversationService.saveCurrentSession({ renderSidebarChats() { sidebarRendered++; } });
  assert.equal(sidebarRendered, 1);

  const stored = await Storage.getConversation('srv_running_1');
  assert.equal(stored.history.length, 2, 'No debe pisar el historial que está escribiendo el servidor');
  assert.equal(stored.history[1].content, 'Respuesta guardada por el servidor en segundo plano');
});

test('ConversationService - saveCurrentSession actualiza profileId con el perfil activo actual', async t => {
  await Storage.deleteAllConversations();
  const Config = require('../../js/config-store.js');
  const Profiles = require('../../js/profile-repository.js');
  Profiles.save({ id: 'prof_deepseek', name: 'Z-deepseek', general: true, settings: { apiType: 'openai' } });
  t.after(() => Config.activateFallbackProfile());

  State.replaceConversation({
    sessionId: 'sess_profile_test',
    sessions: [{ id: 'sess_profile_test', title: 'Inicial', profileId: 'profile:mirror' }],
    messages: [{ id: 'u1', role: 'user', content: 'test' }]
  });

  Config.activateProfile('prof_deepseek');
  await ConversationService.saveCurrentSession({ renderSidebarChats() {} });

  const sessionMeta = State.get('sessions').list.find(s => s.id === 'sess_profile_test');
  assert.equal(sessionMeta.profileId, 'Z-deepseek');

  const stored = await Storage.getConversation('sess_profile_test');
  assert.equal(stored.profileId, 'Z-deepseek');
});

test('ConversationService - saveCurrentSession con overrides persiste serverRun y profileId y se preservan', async t => {
  await Storage.deleteAllConversations();
  State.replaceConversation({
    sessionId: 'sess_srv_run_1',
    sessions: [{ id: 'sess_srv_run_1', title: 'Inicial' }],
    messages: [{ id: 'u1', role: 'user', content: 'test server run' }]
  });

  await ConversationService.saveCurrentSession({ renderSidebarChats() {} }, { serverRun: true, profileId: 'claude' });

  const sessionMeta = State.get('sessions').list.find(s => s.id === 'sess_srv_run_1');
  assert.equal(sessionMeta.serverRun, true);
  assert.equal(sessionMeta.profileId, 'claude');

  const stored = await Storage.getConversation('sess_srv_run_1');
  assert.equal(stored.serverRun, true);
  assert.equal(stored.profileId, 'claude');

  // Guardar de nuevo sin overrides preserva serverRun y profileId de servidor
  await ConversationService.saveCurrentSession({ renderSidebarChats() {} });
  const updatedMeta = State.get('sessions').list.find(s => s.id === 'sess_srv_run_1');
  assert.equal(updatedMeta.serverRun, true);
  assert.equal(updatedMeta.profileId, 'claude');
});

test('ConversationService - switchToSession notifica onSessionSwitched con los metadatos de la conversación recuperada', async t => {
  await Storage.deleteAllConversations();
  const session = {
    id: 'sess_history_server',
    title: 'Chat en servidor',
    createdAt: Date.now() - 5000,
    updatedAt: Date.now() - 1000,
    profileId: 'claude',
    serverRun: true
  };
  await Storage.saveConversation(session, [{ id: 'm1', role: 'user', content: 'hola servidor' }]);

  State.replaceConversation({
    sessionId: 'sess_other',
    sessions: [{ id: 'sess_other', title: 'Local Chat' }, session],
    messages: [{ id: 'm_other', role: 'user', content: 'local' }]
  });

  let switchedConversation = null;
  const options = {
    renderSessionMessages() {},
    renderSidebarChats() {},
    onSessionReset() {},
    resetComposerInput() {},
    closeMobileSidebar() {},
    onSessionSwitched: conv => { switchedConversation = conv; }
  };

  const switched = await ConversationService.switchToSession('sess_history_server', options);
  assert.equal(switched, true);
  assert.ok(switchedConversation);
  assert.equal(switchedConversation.id, 'sess_history_server');
  assert.equal(switchedConversation.serverRun, true);
  assert.equal(switchedConversation.profileId, 'claude');
});

test('ConversationService - saveCurrentSession en un borrador vacío no altera activeId ni sobreescribe chats previos', async t => {
  await Storage.deleteAllConversations();

  const prevSession = {
    id: 'sess_prev_1',
    title: 'Chat previo guardado',
    createdAt: Date.now() - 10000,
    updatedAt: Date.now() - 5000,
    messageCount: 2
  };
  const prevHistory = [
    { id: 'm_prev_1', role: 'user', content: 'Pregunta anterior' },
    { id: 'm_prev_2', role: 'assistant', content: 'Respuesta anterior' }
  ];
  await Storage.saveConversation(prevSession, prevHistory);

  // Activamos un nuevo borrador vacío (solo con system)
  State.replaceConversation({
    sessionId: 'sess_draft_new',
    sessions: [prevSession],
    messages: [{ id: 'm_sys', role: 'system', content: 'System prompt' }]
  });

  let sidebarRendered = 0;
  const options = {
    renderSidebarChats() { sidebarRendered++; }
  };

  // Se invoca saveCurrentSession sobre el borrador vacío (ej: cambio de modo/perfil)
  await ConversationService.saveCurrentSession(options, { serverRun: true, profileId: 'local' });

  // activeId debe seguir siendo sess_draft_new, jamás mutar a sess_prev_1
  assert.equal(State.get('sessions').activeId, 'sess_draft_new', 'El borrador nuevo debe seguir activo');
  assert.equal(sidebarRendered, 0, 'No debe renderizar el sidebar si no se guardó ni eliminó nada');

  // El chat previo no debe haber sido tocado
  const storedPrev = await Storage.getConversation('sess_prev_1');
  assert.ok(storedPrev);
  assert.equal(storedPrev.history.length, 2);
  assert.equal(storedPrev.history[0].content, 'Pregunta anterior');
  assert.equal(storedPrev.title, 'Chat previo guardado');
});

test('ConversationService - createConversationBranch respeta el modo servidor y perfil activo en ese momento', async t => {
  await Storage.deleteAllConversations();

  const history = [
    { id: 'm1', role: 'system', content: 'sys' },
    { id: 'm2', role: 'user', content: 'user 1' },
    { id: 'm3', role: 'assistant', content: 'asst 1' }
  ];
  State.replaceConversation({
    sessionId: 'parent_sess_server',
    sessions: [{ id: 'parent_sess_server', title: 'Parent Server Chat' }],
    messages: structuredClone(history)
  });

  const anchor = { msgId: 'm3', baseId: 'm3', explicitIds: [] };
  let switchedConversation = null;
  const options = {
    renderSessionMessages() {},
    renderSidebarChats() {},
    onSessionReset() {},
    resetComposerInput() {},
    closeMobileSidebar() {},
    onSummarizing() {},
    isServerMode: () => true,
    getServerProfile: () => 'deepseek-coder',
    onSessionSwitched: conv => { switchedConversation = conv; }
  };

  const branched = await ConversationService.createConversationBranch(anchor, options);
  assert.equal(branched, true);
  assert.ok(switchedConversation);
  assert.equal(switchedConversation.serverRun, true);
  assert.equal(switchedConversation.profileId, 'deepseek-coder');

  const branchId = State.get('sessions').activeId;
  const stored = await Storage.getConversation(branchId);
  assert.ok(stored);
  assert.equal(stored.serverRun, true);
  assert.equal(stored.profileId, 'deepseek-coder');
});
