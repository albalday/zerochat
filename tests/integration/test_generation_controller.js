require('fake-indexeddb/auto');
const test = require('node:test');
const assert = require('node:assert/strict');
const GenerationController = require('../../js/generation-controller.js');
const UIConversation = require('../../js/ui-conversation.js');
const ChatAPI = require('../../js/api.js');
const ChatMCP = require('../../js/mcp.js');
const State = require('../../js/state.js');
const Config = require('../../js/config-store.js');
const Debug = require('../../js/debug.js');
const I18n = require('../../js/i18n.js');
const { installDom, getElements } = require('../helpers/dom-env.js');

const ELEMENT_IDS = {
  messagesList: 'messages-list',
  welcomeBanner: 'welcome-banner',
  userInput: 'user-input',
  btnSend: 'btn-send',
  btnStopStream: 'btn-stop-stream',
  fileInput: 'file-input',
  attachmentsContainer: 'attachments-container',
  generationStatus: 'generation-status',
  reasoningMenu: 'reasoning-menu',
  btnReasoning: 'btn-reasoning',
  debugLogContent: 'debug-log-content',
  debugStatusIndicator: 'debug-status-indicator'
};

/** Entorno de app.js: DOM real, configuración activa y los callbacks que cablea la aplicación. */
function setup(t, { model = 'test-model', apiUrl = 'http://localhost:1234/v1', respond } = {}) {
  const dom = installDom({ app: true });
  const elements = getElements(document, ELEMENT_IDS);
  Debug.setElements(elements);
  State.replaceConversation({ sessionId: 'session_generation', sessions: [], messages: [{ id: 'system_root', role: 'system', content: '' }] });
  Config.updateRuntime({ model, apiUrl, apiType: 'openai', activeProfile: null });
  const originalStream = ChatAPI.streamChatCompletion;
  ChatAPI.streamChatCompletion = respond || (async params => {
    return { accumulatedText: 'ok', toolCalls: null, stats: null };
  });
  t.after(() => {
    ChatAPI.streamChatCompletion = originalStream;
    dom.restore();
  });

  const calls = { saved: 0, badges: [] };
  const callbacks = { onReuse() {}, onDelete() {}, onBranch() {} };
  const send = text => {
    elements.userInput.value = text;
    return GenerationController.handleSendMessage({
      elements,
      appendUserMessage: (displayText, originalPrompt, attachedImages) => UIConversation.appendUserMessage(
        elements.messagesList, elements.welcomeBanner, { text: displayText, originalPrompt, attachedImages }, callbacks),
      createAssistantMessagePlaceholder: () => UIConversation.createAssistantMessagePlaceholder(elements.messagesList, null, callbacks),
      updateConnectionTokensBadge: (...args) => calls.badges.push(args),
      openDebugInterceptorModal: async request => request,
      saveCurrentSession: () => { calls.saved++; }
    });
  };
  const lastAssistant = () => [...elements.messagesList.querySelectorAll('.message-wrapper.assistant')].at(-1);
  return { elements, send, calls, lastAssistant };
}

test('GenerationController - responde, guarda el historial y deja la generación inactiva', async t => {
  const { send, calls, lastAssistant, elements } = setup(t);
  await send('Hola');
  assert.deepEqual(State.get('messages').slice(1).map(message => message.role), ['user', 'assistant']);
  assert.match(lastAssistant().querySelector('.message-content').innerHTML, /ok/);
  assert.equal(lastAssistant().querySelector('.message-actions').style.display, 'inline-flex');
  assert.equal(calls.saved, 1);
  assert.equal(GenerationController.isGenerating(), false);
  assert.equal(elements.userInput.value, '');
});

test('GenerationController - ignora un envío sin texto ni adjuntos', async t => {
  const { send, calls } = setup(t);
  await send('   ');
  assert.equal(State.get('messages').length, 1);
  assert.equal(calls.saved, 0);
});

test('GenerationController - sin modelo muestra el aviso con la URL escapada', async t => {
  const { send, calls, lastAssistant } = setup(t, { model: '', apiUrl: 'http://x/<img src=x onerror="bad()">' });
  await send('Hola');
  const wrapper = lastAssistant();
  assert.ok(wrapper.querySelector('.message-row').classList.contains('message-error'));
  assert.match(wrapper.textContent, new RegExp(I18n.t('err_no_model_title')));
  assert.equal(wrapper.querySelector('.message-content img'), null, 'apiUrl no debe interpretarse como HTML');
  assert.match(wrapper.querySelector('.message-error-card-hint').textContent, /<img src=x onerror="bad\(\)">/);
  assert.equal(calls.saved, 1);
  assert.equal(GenerationController.isGenerating(), false);
});

test('GenerationController - un error del proveedor se muestra escapado en la tarjeta de conexión', async t => {
  t.mock.method(console, 'error', () => {});
  const { send, lastAssistant } = setup(t, { respond: async () => { throw new Error('<img src=x onerror="bad()">'); } });
  await send('Question');
  const content = lastAssistant().querySelector('.message-content');
  assert.ok(content.querySelector('.message-error-card'));
  assert.equal(content.querySelector('img'), null);
  assert.equal(lastAssistant().querySelector('.message-actions').style.display, 'inline-flex');
  assert.equal(GenerationController.isGenerating(), false);
});

test('GenerationController - parar a mitad conserva el mensaje del usuario y no deja la conversación ocupada', async t => {
  const { send, calls } = setup(t, {
    respond: params => new Promise((_resolve, reject) => {
      params.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      GenerationController.handleStopGeneration();
    })
  });
  await send('Detén la tarea');
  assert.equal(State.get('messages')[1].content, 'Detén la tarea');
  assert.equal(calls.saved, 1);
  assert.equal(State.isConversationBusy(), false);
});

test('GenerationController - guarda en el mensaje del usuario la nota de comandos terminados antes de llamar al modelo', async t => {
  let requestMessages = null;
  const { send } = setup(t, {
    respond: async params => {
      requestMessages = params.messages;
      return { accumulatedText: 'ok', toolCalls: null, stats: null };
    }
  });
  const seenByNotes = [];
  t.mock.method(ChatMCP.manager, 'buildCommandNotes', async messages => {
    seenByNotes.push(messages.filter(message => message.role === 'user').map(message => message.content));
    return 'Background commands that finished since your last turn: ...';
  });
  await send('sigue');

  assert.deepEqual(seenByNotes, [['sigue']]);
  const user = State.get('messages').find(message => message.role === 'user');
  assert.equal(user.content, 'sigue', 'El texto visible no cambia');
  assert.equal(user.commandNotes, 'Background commands that finished since your last turn: ...');
  assert.match(requestMessages.find(message => message.role === 'user').content, /^Background commands/);
});

test('GenerationController - en pantallas táctiles no devuelve el foco al compositor al terminar', async t => {
  const { send, elements } = setup(t);
  window.matchMedia = query => ({ matches: query === '(pointer: coarse)' });
  elements.userInput.blur();
  await send('Hola');
  assert.notEqual(document.activeElement, elements.userInput);
});

test('GenerationController.runCancellableTask - marca la conversación ocupada y la libera aunque la tarea falle', async () => {
  await assert.rejects(GenerationController.runCancellableTask(async signal => {
    assert.equal(State.isConversationBusy(), true);
    assert.equal(signal.aborted, false);
    await assert.rejects(GenerationController.runCancellableTask(async () => {}), /already running/);
    throw new Error('task failed');
  }), /task failed/);
  assert.equal(State.isConversationBusy(), false);
  assert.equal(GenerationController.isGenerating(), false);
});

test('GenerationController.runCancellableTask - el botón de parar aborta la señal de la tarea', async () => {
  const aborted = await GenerationController.runCancellableTask(async signal => {
    GenerationController.handleStopGeneration();
    return signal.aborted;
  });
  assert.equal(aborted, true);
});
