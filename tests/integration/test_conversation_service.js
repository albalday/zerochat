require('fake-indexeddb/auto');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const ConversationService = require('../../js/conversation-service.js');
const UIConversation = require('../../js/ui-conversation.js');
const GenerationController = require('../../js/generation-controller.js');
const ChatAPI = require('../../js/api.js');
const State = require('../../js/state.js');
const Storage = require('../../js/cookies.js');
const { installDom } = require('../helpers/dom-env.js');

const HISTORY = [
  { id: 'm1', role: 'system', content: 'sys' },
  { id: 'm2', role: 'user', content: 'user 1' },
  { id: 'm3', role: 'assistant', content: 'asst 1' },
  { id: 'm4', role: 'user', content: 'user 2' },
  { id: 'm5', role: 'assistant', content: 'asst 2' }
];

/** Conversación activa con su mensaje del asistente pintado; devuelve el wrapper y las opciones de app.js. */
async function setupBranch(t, history = HISTORY, anchorId = 'm5') {
  const dom = installDom({ app: true });
  t.after(() => dom.restore());
  await Storage.deleteAllConversations();
  State.replaceConversation({ sessionId: 'parent_sess_1', sessions: [{ id: 'parent_sess_1', title: 'Parent Chat' }], messages: structuredClone(history) });
  const messagesList = document.getElementById('messages-list');
  const { wrapper } = UIConversation.createAssistantMessagePlaceholder(messagesList, anchorId, { onBranch() {}, onDelete() {} });
  const options = { renderSessionMessages() {}, renderSidebarChats() {}, onSessionReset() {}, resetComposerInput() {}, closeSidebar() {} };
  return { wrapper, options };
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
  const { wrapper, options } = await setupBranch(t, shortHistory, 'm3');
  useDialogs(t, []);
  assert.equal(await ConversationService.createConversationBranch(wrapper, options), true);

  const sessionId = State.get('sessions').activeId;
  assert.notEqual(sessionId, 'parent_sess_1');
  assert.deepEqual(State.get('messages').map(message => message.id), [0, 1, 2].map(index => `msg_${sessionId}_${index}`));
  const stored = await Storage.getConversation(sessionId);
  assert.equal(stored.metadata.parentSessionId, 'parent_sess_1');
  assert.equal(stored.title, require('../../js/i18n.js').t('chat_branch_title', { title: 'Parent Chat' }));
});

test('ConversationService - con resumen, la rama compacta el contexto previo y conserva literal la respuesta de anclaje', async t => {
  const { wrapper, options } = await setupBranch(t);
  useDialogs(t, [{ accepted: true, checkboxChecked: true }]);
  const summarized = [];
  let busyDuringSummary = null;
  useSummarizer(t, async ({ messages, signal }) => {
    busyDuringSummary = State.isConversationBusy();
    assert.equal(typeof signal.aborted, 'boolean');
    summarized.push(...messages.slice(1, -1).map(message => message.content));
    return { accumulatedText: 'Consolidated summary of conversation' };
  });

  assert.equal(await ConversationService.createConversationBranch(wrapper, options), true);
  assert.equal(busyDuringSummary, true, 'Mientras se resume la conversación está ocupada');
  assert.equal(State.isConversationBusy(), false);
  assert.equal(State.get('ui').generationStatus.phase, 'idle');
  assert.deepEqual(summarized, ['user 1', 'asst 1', 'user 2'], 'La respuesta de anclaje no se resume');
  assert.deepEqual(State.get('messages').map(message => message.content), ['sys', 'Consolidated summary of conversation', 'asst 2']);
  assert.equal(State.get('messages')[1]._isSummaryBlock, true);
});

test('ConversationService - no bifurca mientras la conversación está ocupada', async t => {
  const { wrapper, options } = await setupBranch(t);
  const { alerts } = useDialogs(t, []);
  State.set('streaming', { isGenerating: true });
  t.after(() => State.set('streaming', { isGenerating: false }));
  assert.equal(await ConversationService.createConversationBranch(wrapper, options), false);
  assert.equal(alerts.length, 1);
  assert.deepEqual(await savedBranches(), []);
});

test('ConversationService - parar durante el resumen cancela la rama sin ofrecer el historial completo', async t => {
  const { wrapper, options } = await setupBranch(t);
  const { confirms, alerts } = useDialogs(t, [{ accepted: true, checkboxChecked: true }]);
  useSummarizer(t, ({ signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')));
    GenerationController.handleStopGeneration();
  }));
  t.mock.method(console, 'warn', () => {});
  assert.equal(await ConversationService.createConversationBranch(wrapper, options), false);
  assert.equal(confirms.length, 1, 'Solo el diálogo inicial');
  assert.equal(alerts.length, 0);
  assert.deepEqual(await savedBranches(), []);
  assert.equal(State.isConversationBusy(), false);
});

test('ConversationService - cancelar el diálogo de bifurcación no crea la rama', async t => {
  const { wrapper, options } = await setupBranch(t);
  const { confirms } = useDialogs(t, [{ accepted: false, checkboxChecked: true }]);
  assert.equal(await ConversationService.createConversationBranch(wrapper, options), false);
  assert.equal(confirms.length, 1);
  assert.ok(confirms[0].opts.checkbox, 'Debe ofrecer la casilla de resumen');
  assert.deepEqual(await savedBranches(), []);
});

test('ConversationService - aceptar sin la casilla de resumen clona el historial completo', async t => {
  const { wrapper, options } = await setupBranch(t);
  useDialogs(t, [{ accepted: true, checkboxChecked: false }]);
  useSummarizer(t, async () => { throw new Error('no debe resumir'); });
  assert.equal(await ConversationService.createConversationBranch(wrapper, options), true);
  assert.equal(State.get('messages').length, 5);
});

test('ConversationService - si el resumen falla ofrece bifurcar con el historial completo', async t => {
  t.mock.method(console, 'warn', () => {});
  {
    const { wrapper, options } = await setupBranch(t);
    const { confirms } = useDialogs(t, [{ accepted: true, checkboxChecked: true }, true]);
    useSummarizer(t, async () => { throw new Error('provider down'); });
    assert.equal(await ConversationService.createConversationBranch(wrapper, options), true);
    assert.equal(confirms.length, 2);
    assert.equal(State.get('messages').length, 5);
  }
  {
    const { wrapper, options } = await setupBranch(t);
    useDialogs(t, [{ accepted: true, checkboxChecked: true }, false]);
    useSummarizer(t, async () => { throw new Error('provider down'); });
    assert.equal(await ConversationService.createConversationBranch(wrapper, options), false);
    assert.deepEqual(await savedBranches(), []);
  }
});

test('ConversationService - una sesión sin mensajes del usuario no se guarda', async t => {
  await setupBranch(t, [{ id: 'm1', role: 'system', content: 'sys' }]);
  await ConversationService.saveCurrentSession({ renderSidebarChats() {} });
  assert.deepEqual(State.get('sessions').list, []);
  assert.equal(await Storage.getConversation('parent_sess_1'), null);
});

test('ConversationService - al guardar, el título sale de la primera línea del usuario sin Markdown', async t => {
  await setupBranch(t, [{ id: 'm1', role: 'system', content: 'sys' }, { id: 'u1', role: 'user', content: '# Primera **pregunta**\nresto' }]);
  State.set('sessions', { list: [] });
  await ConversationService.saveCurrentSession({ renderSidebarChats() {} });
  assert.equal(State.get('sessions').list[0].title, 'Primera pregunta');
  assert.equal((await Storage.getConversation('parent_sess_1')).history.length, 2);
});
