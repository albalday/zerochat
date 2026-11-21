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

/** Opciones completas de app.js con callbacks vacíos; `overrides` sustituye los que la prueba observa. */
function appOptions(overrides = {}) {
  return {
    renderSessionMessages() {},
    renderSidebarChats() {},
    onSessionReset() {},
    onSessionSwitched() {},
    resetComposerInput() {},
    closeMobileSidebar() {},
    onSummarizing() {},
    isServerMode: () => false,
    getProject: () => '',
    ...overrides
  };
}

/**
 * Conversación activa; devuelve la referencia de la respuesta de anclaje y las opciones de app.js.
 * `summarizing` registra cada cambio del indicador de progreso del resumen.
 */
async function setupBranch(t, history = HISTORY, anchorId = 'm5') {
  await Storage.deleteAllConversations();
  State.replaceConversation({ sessionId: 'parent_sess_1', sessions: [{ id: 'parent_sess_1', title: 'Parent Chat' }], messages: structuredClone(history) });
  const anchor = { msgId: anchorId, baseId: anchorId, explicitIds: [] };
  const summarizing = [];
  const options = appOptions({ onSummarizing: active => summarizing.push(active) });
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

test('ConversationService - sin diálogo de resumen la rama clona en el mismo proyecto y hereda perfil y modo servidor', async t => {
  const shortHistory = HISTORY.slice(0, 3);
  const { anchor, options } = await setupBranch(t, shortHistory, 'm3');
  State.set('sessions', { list: [{ id: 'parent_sess_1', title: 'Parent Chat', project: '/repo/app' }] });
  useDialogs(t, []);
  assert.equal(await ConversationService.createConversationBranch(anchor, options), true);

  const sessionId = State.get('sessions').activeId;
  assert.notEqual(sessionId, 'parent_sess_1');
  assert.deepEqual(State.get('messages').map(message => message.id), [0, 1, 2].map(index => `msg_${sessionId}_${index}`));
  const stored = await Storage.getConversation(sessionId);
  assert.deepEqual(stored.history.map(message => message.content), shortHistory.map(message => message.content));
  assert.equal(stored.title, require('../../js/i18n.js').t('chat_branch_title', { title: 'Parent Chat' }));
  assert.equal(stored.project, '/repo/app');

  // Con modo servidor y perfil activo, la rama los conserva
  const Config = require('../../js/config-store.js');
  const Profiles = require('../../js/profile-repository.js');
  Profiles.save({ id: 'profile:deepseek-coder', name: 'deepseek-coder', settings: { model: 'deepseek' } });
  Config.activateProfile('profile:deepseek-coder');
  t.after(() => Config.activateFallbackProfile());
  State.replaceConversation({
    sessionId: 'parent_sess_1',
    sessions: [{ id: 'parent_sess_1', title: 'Parent Server Chat' }],
    messages: structuredClone(shortHistory)
  });
  let switchedConversation = null;
  assert.equal(await ConversationService.createConversationBranch({ msgId: 'm3', baseId: 'm3', explicitIds: [] }, appOptions({
    isServerMode: () => true,
    onSessionSwitched: conv => { switchedConversation = conv; }
  })), true);
  assert.equal(switchedConversation.serverRun, true);
  assert.equal(switchedConversation.profileId, 'deepseek-coder');
  const srvStored = await Storage.getConversation(State.get('sessions').activeId);
  assert.equal(srvStored.serverRun, true);
  assert.equal(srvStored.profileId, 'deepseek-coder');
  assert.equal(srvStored.project, undefined);
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

test('ConversationService - createConversationBranch respeta estado ocupado, parada manual y ofrece historial completo si falla el resumen', async t => {
  t.mock.method(console, 'warn', () => {});
  {
    const { anchor, options } = await setupBranch(t);
    const { alerts } = useDialogs(t, []);
    State.set('streaming', { isGenerating: true });
    assert.equal(await ConversationService.createConversationBranch(anchor, options), false);
    assert.equal(alerts.length, 1);
    assert.deepEqual(await savedBranches(), []);
    State.set('streaming', { isGenerating: false });
  }
  {
    const { anchor, options } = await setupBranch(t);
    const { confirms, alerts } = useDialogs(t, [{ accepted: true, checkboxChecked: true }]);
    useSummarizer(t, ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
      GenerationController.handleStopGeneration();
    }));
    assert.equal(await ConversationService.createConversationBranch(anchor, options), false);
    assert.equal(confirms.length, 1);
    assert.equal(alerts.length, 0);
    assert.deepEqual(await savedBranches(), []);
    assert.equal(State.isConversationBusy(), false);
  }
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

test('ConversationService - si el almacenamiento no borra la conversación, sigue en la lista', async t => {
  await Storage.deleteAllConversations();
  const session = { id: 'del_fail', title: 'No se borra' };
  await Storage.saveConversation(session, [{ id: 'del_fail_m', role: 'user', content: 'hola' }]);
  State.replaceConversation({ sessionId: 'del_other', sessions: [session], messages: [] });
  const { alerts } = useDialogs(t, [true]);
  t.mock.method(Storage, 'deleteConversation', async () => { throw new Error('Storage failure'); });

  await ConversationService.deleteSession('del_fail', appOptions());
  assert.deepEqual(State.get('sessions').list.map(item => item.id), ['del_fail']);
  assert.equal(alerts.length, 1);
});

test('ConversationService - saveCurrentSession ignora sesiones/borradores vacíos y protege ejecuciones en curso del servidor', async t => {
  await setupBranch(t, [{ id: 'm1', role: 'system', content: 'sys' }]);
  await ConversationService.saveCurrentSession(appOptions());
  assert.deepEqual(State.get('sessions').list, []);
  assert.equal(await Storage.getConversation('parent_sess_1'), null);

  await Storage.deleteAllConversations();
  const prevSession = { id: 'sess_prev_1', title: 'Chat previo guardado', createdAt: 1000, updatedAt: 2000, messageCount: 2 };
  await Storage.saveConversation(prevSession, [
    { id: 'm_prev_1', role: 'user', content: 'Pregunta anterior' },
    { id: 'm_prev_2', role: 'assistant', content: 'Respuesta anterior' }
  ]);
  State.replaceConversation({
    sessionId: 'sess_draft_new',
    sessions: [prevSession],
    messages: [{ id: 'm_sys', role: 'system', content: 'System prompt' }]
  });
  let sidebarRendered = 0;
  await ConversationService.saveCurrentSession(appOptions({ renderSidebarChats() { sidebarRendered++; } }), { serverRun: true, profileId: 'local' });
  assert.equal(State.get('sessions').activeId, 'sess_draft_new');
  assert.equal(sidebarRendered, 0);
  assert.equal((await Storage.getConversation('sess_prev_1')).history.length, 2);

  await Storage.deleteAllConversations();
  const previousMcp = State.get('mcp');
  t.after(() => State.set('mcp', previousMcp));
  await Storage.saveConversation(
    { id: 'srv_running_1', title: 'Remota', createdAt: 1000, updatedAt: 2000 },
    [{ id: 'u1', role: 'user', content: 'Pregunta' }, { id: 'a1', role: 'assistant', content: 'Respuesta servidor' }]
  );
  State.replaceConversation({
    sessionId: 'srv_running_1',
    sessions: [{ id: 'srv_running_1', title: 'Remota' }],
    messages: [{ id: 'u1', role: 'user', content: 'Pregunta' }]
  });
  State.set('mcp', { ...previousMcp, serverRuns: [{ conversationId: 'srv_running_1', runId: 'r_1', status: 'running' }] });
  let srvSidebar = 0;
  await ConversationService.saveCurrentSession(appOptions({ renderSidebarChats() { srvSidebar++; } }));
  assert.equal(srvSidebar, 1);
  assert.equal((await Storage.getConversation('srv_running_1')).history[1].content, 'Respuesta servidor');
});

test('ConversationService - saveCurrentSession persiste profileId, proyecto inicial inmutable y overrides de servidor', async t => {
  await Storage.deleteAllConversations();
  const Config = require('../../js/config-store.js');
  const Profiles = require('../../js/profile-repository.js');
  Profiles.save({ id: 'prof_deepseek', name: 'deepseek', general: true, settings: { apiType: 'openai' } });
  t.after(() => Config.activateFallbackProfile());

  State.replaceConversation({
    sessionId: 'sess_profile_test',
    sessions: [],
    messages: [{ id: 'u1', role: 'user', content: 'test' }]
  });
  Config.activateProfile('prof_deepseek');
  await ConversationService.saveCurrentSession(appOptions({ getProject: () => '/repo/a' }));
  assert.equal((await Storage.getConversation('sess_profile_test')).profileId, 'deepseek');
  assert.equal((await Storage.getConversation('sess_profile_test')).project, '/repo/a');

  await ConversationService.saveCurrentSession(appOptions({ getProject: () => '/repo/b' }));
  assert.equal((await Storage.getConversation('sess_profile_test')).project, '/repo/a');
  Config.activateFallbackProfile();

  await Storage.deleteAllConversations();
  State.replaceConversation({
    sessionId: 'sess_srv_run_1',
    sessions: [{ id: 'sess_srv_run_1', title: 'Inicial' }],
    messages: [{ id: 'u1', role: 'user', content: 'test server run' }]
  });
  await ConversationService.saveCurrentSession(appOptions(), { serverRun: true, profileId: 'claude' });
  await ConversationService.saveCurrentSession(appOptions({ isServerMode: () => true }));
  const storedSrv = await Storage.getConversation('sess_srv_run_1');
  assert.equal(storedSrv.serverRun, true);
  assert.equal(storedSrv.profileId, 'claude');
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
  const options = appOptions({
    renderSessionMessages() { renderedMessages++; },
    renderSidebarChats() { renderedSidebar++; }
  });

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

test('ConversationService - borrar el historial borra solo el conjunto seleccionado e indica cuál en la confirmación', async t => {
  // setupBranch vacía el almacenamiento y da las opciones de app.js.
  const options = { ...(await setupBranch(t)).options, getProject: () => '/repo/a' };
  const sessions = [{ id: 'del_a', title: 'A', project: '/repo/a' }, { id: 'del_b', title: 'B', project: '/repo/b' }, { id: 'del_n', title: 'N' }];
  for (const session of sessions) await Storage.saveConversation(session, [{ id: `${session.id}_m`, role: 'user', content: 'hola' }]);
  State.replaceConversation({ sessionId: 'del_b', sessions, messages: [{ id: 'del_b_m', role: 'user', content: 'hola' }] });
  const { confirms } = useDialogs(t, [false, true, true, true]);
  const storedIds = async () => (await Storage.getConversationsList()).map(session => session.id).sort();

  await ConversationService.deleteAllSessions({ ...options, getSelectedProject: () => '/repo/empty' });
  assert.equal(confirms.length, 0, 'Sin conversaciones en el conjunto seleccionado no pide confirmación');
  // La vista de tareas pendientes no es un conjunto de proyecto: no borra nada, tampoco el proyecto actual.
  await ConversationService.deleteAllSessions({ ...options, getSelectedProject: () => undefined });
  assert.equal(confirms.length, 0);
  assert.deepEqual(await storedIds(), ['del_a', 'del_b', 'del_n']);

  await ConversationService.deleteAllSessions({ ...options, getSelectedProject: () => '/repo/a' });
  assert.deepEqual(await storedIds(), ['del_a', 'del_b', 'del_n'], 'Cancelar no borra nada');
  assert.match(confirms[0].message, /1 conversaciones del proyecto a\b/);
  assert.equal(confirms[0].opts?.checkbox, undefined);

  await ConversationService.deleteAllSessions({ ...options, getSelectedProject: () => '/repo/a' });
  assert.deepEqual(await storedIds(), ['del_b', 'del_n']);
  assert.deepEqual(State.get('sessions').list.map(session => session.id), ['del_b', 'del_n']);
  assert.equal(State.get('sessions').activeId, 'del_b', 'La conversación abierta de otro proyecto sigue abierta');

  await ConversationService.deleteAllSessions({ ...options, getSelectedProject: () => '' });
  assert.match(confirms[2].message, /1 conversaciones del proyecto general\b/);
  assert.deepEqual(await storedIds(), ['del_b']);
  assert.equal(State.get('sessions').activeId, 'del_b');

  await ConversationService.deleteAllSessions({ ...options, getSelectedProject: () => null });
  assert.match(confirms[3].message, /1 conversaciones de todos los proyectos\b/);
  assert.deepEqual(await storedIds(), []);
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
  const options = appOptions({ onSessionSwitched: conv => { switchedConversation = conv; } });

  const switched = await ConversationService.switchToSession('sess_history_server', options);
  assert.equal(switched, true);
  assert.ok(switchedConversation);
  assert.equal(switchedConversation.id, 'sess_history_server');
  assert.equal(switchedConversation.serverRun, true);
  assert.equal(switchedConversation.profileId, 'claude');
  const storedInState = State.get('sessions')?.list?.find(s => s.id === 'sess_history_server');
  assert.equal(storedInState?.serverRun, true);
  assert.equal(storedInState?.profileId, 'claude');
});

test('ConversationService - confirmProjectSwitch avisa solo al abrir un chat de otro proyecto estando conectado y respeta cancelar', async t => {
  await Storage.deleteAllConversations();
  const sA = { id: 'sess_a', title: 'Chat A', project: '/repo/a', createdAt: 1000, updatedAt: 1000 };
  const sB = { id: 'sess_b', title: 'Chat B', project: '/repo/b', createdAt: 2000, updatedAt: 2000 };
  const sG = { id: 'sess_g', title: 'Chat General', createdAt: 3000, updatedAt: 3000 };
  for (const s of [sA, sB, sG]) await Storage.saveConversation(s, [{ id: `${s.id}_m`, role: 'user', content: s.title }]);

  const previousMcp = State.get('mcp');
  t.after(() => State.set('mcp', previousMcp));

  State.replaceConversation({
    sessionId: 'sess_a',
    sessions: [sA, sB, sG],
    messages: [{ id: 'sess_a_m', role: 'user', content: 'Chat A' }]
  });
  State.set('mcp', { ...previousMcp, status: 'connected', serverInfo: { cwd: '/repo/a' } });

  const { confirms } = useDialogs(t, [false, true, true]);
  const opts = { ...appOptions({ getProject: () => '/repo/a' }), confirmProjectSwitch: true };

  assert.equal(await ConversationService.switchToSession('sess_b', opts), false);
  assert.equal(confirms.length, 1);
  assert.match(confirms[0].message, /\bb\b/);
  assert.equal(State.get('sessions').activeId, 'sess_a');

  assert.equal(await ConversationService.switchToSession('sess_b', opts), true);
  assert.equal(confirms.length, 2);
  assert.equal(State.get('sessions').activeId, 'sess_b');

  // Sin confirmar si ya pertenece al proyecto activo, si no hay conexión o si no se pide confirmProjectSwitch.
  assert.equal(await ConversationService.switchToSession('sess_a', opts), true);
  assert.equal(confirms.length, 2);

  assert.equal(await ConversationService.switchToSession('sess_g', opts), true);
  assert.equal(confirms.length, 3);
  assert.match(confirms[2].message, /\bgeneral\b/);

  State.set('mcp', { ...previousMcp, status: 'disconnected', serverInfo: null });
  assert.equal(await ConversationService.switchToSession('sess_b', opts), true);
  assert.equal(confirms.length, 3);
});
