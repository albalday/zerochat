const test = require('node:test');
const assert = require('node:assert/strict');
const UIConversation = require('../../js/ui-conversation.js');
const State = require('../../js/state.js');
const I18n = require('../../js/i18n.js');
const { installDom } = require('../helpers/dom-env.js');

function setup(t) {
  const dom = installDom({ app: true });
  t.after(() => dom.restore());
  return {
    messagesList: document.getElementById('messages-list'),
    welcomeBanner: document.getElementById('welcome-banner')
  };
}

const noopCallbacks = { onReuse() {}, onDelete() {}, onBranch() {} };

function mockClipboard(t, writeText) {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  t.after(() => {
    if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor);
  });
}

test('UIConversation - los bloques de respuesta pintan texto final y en streaming sin tocar los demás', t => {
  setup(t);
  const container = document.createElement('div');
  const first = UIConversation.createAssistantBlock(container);
  const second = UIConversation.createAssistantBlock(container);
  UIConversation.renderAssistantBlock(first, '**First**', { streaming: true });
  UIConversation.renderAssistantBlock(second, 'Other response');
  const untouched = second.innerHTML;
  assert.match(first.innerHTML, /<strong>First/);
  assert.ok(first.querySelector('.streaming-cursor'));
  UIConversation.renderAssistantBlock(first, '**Finished**');
  assert.equal(first.querySelector('.streaming-cursor'), null);
  assert.match(first.innerHTML, /Finished/);
  assert.equal(second.innerHTML, untouched);
  assert.equal(container.children.length, 2);
});

test('UIConversation - el error de conexión escapa los datos remotos y conserva el marcado traducido', t => {
  const { messagesList } = setup(t);
  const parts = UIConversation.createAssistantMessagePlaceholder(messagesList, 'msg_error', noopCallbacks);
  const payload = '<img src=x onerror="probe()">';
  UIConversation.renderConnectionError(parts, payload, payload);
  assert.equal(parts.content.querySelector('img'), null);
  assert.equal((parts.content.innerHTML.match(/&lt;img/g) || []).length, 2);
  assert.ok(parts.content.querySelector('.message-error-card strong'));
  assert.equal(parts.row.classList.contains('message-error'), true);
  assert.equal(parts.actions.style.display, 'inline-flex');
});

test('UIConversation - copiar usa el texto del momento y vuelve al icono original', async t => {
  setup(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const copied = [];
  mockClipboard(t, async text => { copied.push(text); });
  const button = document.createElement('button');
  button.innerHTML = '<span>copy</span>';
  let text = 'Original';
  UIConversation.bindMessageCopy(button, () => text);

  assert.equal(await button.onclick(), true);
  assert.equal(button.classList.contains('copied'), true);
  text = 'Updated';
  assert.equal(await button.onclick(), true);
  assert.deepEqual(copied, ['Original', 'Updated']);
  t.mock.timers.tick(2000);
  assert.equal(button.classList.contains('copied'), false);
  assert.equal(button.innerHTML, '<span>copy</span>');
});

test('UIConversation - un fallo del portapapeles no se presenta como copia correcta', async t => {
  setup(t);
  const warnings = t.mock.method(console, 'warn', () => {});
  mockClipboard(t, async () => { throw new Error('Clipboard denied'); });
  const button = document.createElement('button');
  UIConversation.bindMessageCopy(button, () => 'Text');
  assert.equal(await button.onclick(), false);
  assert.equal(button.classList.contains('copied'), false);
  assert.equal(warnings.mock.callCount(), 1);
});

test('UIConversation - showTypingIndicator y removeTypingIndicator gestionan un único indicador', t => {
  const { messagesList } = setup(t);
  UIConversation.showTypingIndicator(messagesList);
  UIConversation.showTypingIndicator(messagesList);
  assert.equal(messagesList.querySelectorAll('#typing-indicator-wrapper').length, 1);
  UIConversation.removeTypingIndicator();
  assert.equal(messagesList.querySelector('#typing-indicator-wrapper'), null);
});

test('UIConversation - appendUserMessage pinta el mensaje y sus acciones', t => {
  const { messagesList, welcomeBanner } = setup(t);
  let reusedText = '';
  let deleted = null;
  const msgId = UIConversation.appendUserMessage(messagesList, welcomeBanner, {
    text: 'Hola mundo',
    originalPrompt: 'Hola mundo prompt'
  }, { onReuse: text => { reusedText = text; }, onDelete: wrapper => { deleted = wrapper; } });

  assert.ok(msgId.startsWith('msg_usr_'));
  assert.equal(welcomeBanner.style.display, 'none');
  const wrapper = messagesList.querySelector(`[data-msg-id="${msgId}"]`);
  assert.ok(wrapper.classList.contains('user'));
  assert.equal(wrapper.querySelector('.message-content').textContent, 'Hola mundo');

  const [reuse, copy, remove] = wrapper.querySelectorAll('.message-actions button');
  assert.ok(copy.classList.contains('btn-copy-user'));
  reuse.click();
  assert.equal(reusedText, 'Hola mundo prompt');
  remove.click();
  assert.equal(deleted, wrapper);
});

test('UIConversation - createAssistantMessagePlaceholder crea la estructura y las acciones del asistente', t => {
  const { messagesList } = setup(t);
  let branched = null;
  const result = UIConversation.createAssistantMessagePlaceholder(messagesList, 'test_ast_1', { ...noopCallbacks, onBranch: wrapper => { branched = wrapper; } });
  assert.equal(result.wrapper.getAttribute('data-msg-id'), 'test_ast_1');
  assert.equal(result.wrapper.getAttribute('data-base-id'), 'test_ast_1');
  assert.ok(result.content.querySelector('.initial-cursor'));
  assert.equal(result.actions.style.display, 'none');
  assert.equal(result.statsContainer.parentNode, result.footerRow);
  result.wrapper.querySelector('.btn-branch-conversation').click();
  assert.equal(branched, result.wrapper);
});

function seedTurn(messagesList, welcomeBanner, msgId) {
  State.replaceConversation({ sessionId: 'session_remove', messages: [{ id: msgId, role: 'user', content: 'Borrar' }] });
  UIConversation.appendUserMessage(messagesList, welcomeBanner, { text: 'Borrar', existingMsgId: msgId }, noopCallbacks);
  return messagesList.querySelector(`[data-msg-id="${msgId}"]`);
}

test('UIConversation - removeMessage no borra nada mientras la conversación está ocupada', t => {
  const { messagesList, welcomeBanner } = setup(t);
  const wrapper = seedTurn(messagesList, welcomeBanner, 'msg_busy');
  let saved = false;
  State.set('streaming', { isGenerating: true });
  t.after(() => State.set('streaming', { isGenerating: false }));
  UIConversation.removeMessage(wrapper, { messagesList, welcomeBanner, saveSession: () => { saved = true; } });
  assert.equal(State.get('messages').length, 1);
  assert.ok(wrapper.isConnected);
  assert.equal(saved, false);
});

test('UIConversation - removeMessage borra el turno, lo quita del DOM y muestra la bienvenida si queda vacío', t => {
  const { messagesList, welcomeBanner } = setup(t);
  const wrapper = seedTurn(messagesList, welcomeBanner, 'msg_to_delete');
  let saved = false;
  UIConversation.removeMessage(wrapper, { messagesList, welcomeBanner, saveSession: () => { saved = true; } });
  assert.equal(State.get('messages').length, 0);
  assert.equal(wrapper.isConnected, false);
  assert.equal(saved, true);
  assert.equal(welcomeBanner.parentNode, messagesList);
  assert.equal(welcomeBanner.style.display, '');
});

test('UIConversation - las imágenes adjuntas se sanean y solo las válidas generan IMG', t => {
  const { messagesList, welcomeBanner } = setup(t);
  UIConversation.appendUserMessage(messagesList, welcomeBanner, {
    text: 'Mensaje con imágenes',
    attachedImages: [
      { name: 'segura.png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' },
      { name: 'peligrosa.png', dataUrl: 'javascript:alert(1)' },
      { name: 'xss.png', dataUrl: 'data:text/html,<script>alert(1)</script>' }
    ]
  }, noopCallbacks);
  const items = messagesList.querySelectorAll('.message-images-grid .message-image-item');
  assert.equal(items.length, 3);
  const images = messagesList.querySelectorAll('.message-images-grid img');
  assert.equal(images.length, 1);
  assert.equal(images[0].getAttribute('src'), 'data:image/png;base64,iVBORw0KGgo=');
  assert.equal(images[0].getAttribute('alt'), 'segura.png');
  assert.equal(messagesList.querySelector('script'), null);
});

// happy-dom no calcula el layout: el contenedor expone las medidas que tendría en el navegador.
function createScrollContainer({ scrollHeight = 1000, clientHeight = 200 } = {}) {
  const container = document.createElement('div');
  const metrics = { scrollHeight, clientHeight, scrollTop: scrollHeight - clientHeight };
  for (const key of ['scrollHeight', 'clientHeight', 'scrollTop']) {
    Object.defineProperty(container, key, { configurable: true, get: () => metrics[key], set: value => { metrics[key] = value; } });
  }
  container.scrollTo = ({ top }) => { metrics.scrollTop = top; };
  container.emit = (type, init = {}) => container.dispatchEvent(Object.assign(new Event(type), init));
  container.userScrollTo = top => { metrics.scrollTop = top; container.emit('scroll'); };
  return container;
}

test('UIConversation - scrollToBottom sigue el final salvo que el usuario suba por arrastre, teclas o toque, y lo retoma al volver o con force', t => {
  setup(t);
  {
    const container = createScrollContainer();
    UIConversation.scrollToBottom(container);
    container.scrollHeight = 1400;
    UIConversation.scrollToBottom(container);
    assert.equal(container.scrollTop, 1400);
  }
  {
    const container = createScrollContainer();
    UIConversation.scrollToBottom(container);
    container.emit('wheel', { deltaY: -100 });
    container.scrollTop = 300;
    container.scrollHeight = 1400;
    UIConversation.scrollToBottom(container);
    assert.equal(container.scrollTop, 300);
  }
  {
    const dragged = createScrollContainer();
    UIConversation.scrollToBottom(dragged);
    dragged.userScrollTo(500);
    UIConversation.scrollToBottom(dragged);
    assert.equal(dragged.scrollTop, 500);

    const keyed = createScrollContainer();
    UIConversation.scrollToBottom(keyed);
    keyed.emit('keydown', { key: 'PageUp' });
    keyed.scrollTop = 100;
    UIConversation.scrollToBottom(keyed);
    assert.equal(keyed.scrollTop, 100);

    const touched = createScrollContainer();
    UIConversation.scrollToBottom(touched);
    touched.emit('touchstart', { touches: [{ clientY: 100 }] });
    touched.emit('touchmove', { touches: [{ clientY: 180 }] });
    touched.scrollTop = 50;
    UIConversation.scrollToBottom(touched);
    assert.equal(touched.scrollTop, 50);
  }
  {
    const container = createScrollContainer();
    UIConversation.scrollToBottom(container);
    container.emit('wheel', { deltaY: -100 });
    container.userScrollTo(790);
    container.scrollHeight = 1400;
    UIConversation.scrollToBottom(container);
    assert.equal(container.scrollTop, 1400);

    container.emit('wheel', { deltaY: -100 });
    container.scrollTop = 200;
    UIConversation.scrollToBottom(container, { force: true });
    assert.equal(container.scrollTop, 1400);
  }
});

test('UIConversation - renderSessionMessages pinta el resumen plegado como Markdown saneado y los turnos', t => {
  const elements = setup(t);
  let telemetryUpdated = false;
  UIConversation.renderSessionMessages(elements, [
    { id: 's1', role: 'system', content: 'Prompt base' },
    { id: 's2', role: 'system', content: 'Resumen **previo** <img src=x onerror="alert(1)">', _isSummaryBlock: true },
    { id: 'u1', role: 'user', content: 'Pregunta' },
    { id: 'a1_turn_0_assistant', role: 'assistant', content: 'Última respuesta del asistente' }
  ], { ...noopCallbacks, resetTelemetry() {}, updateTelemetry: () => { telemetryUpdated = true; } });

  const banner = elements.messagesList.querySelector('details.branch-summary-banner');
  assert.ok(banner);
  assert.equal(banner.open, false, 'Debe estar plegado por defecto');
  assert.ok(banner.querySelector('summary.branch-summary-header'));
  assert.match(banner.innerHTML, /<strong>previo<\/strong>/);
  assert.equal(banner.querySelector('img'), null);
  assert.equal(elements.welcomeBanner.style.display, 'none');
  const assistant = elements.messagesList.querySelector('.message-wrapper.assistant');
  assert.equal(assistant.getAttribute('data-base-id'), 'a1');
  assert.equal(assistant.getAttribute('data-msg-ids'), 'a1_turn_0_assistant');
  assert.equal(telemetryUpdated, true);
});

test('UIConversation - sin turnos muestra la bienvenida y reinicia la telemetría', t => {
  const elements = setup(t);
  let reset = false;
  UIConversation.renderSessionMessages(elements, [{ id: 's1', role: 'system', content: 'Prompt base' }], { ...noopCallbacks, resetTelemetry: () => { reset = true; }, updateTelemetry() {} });
  assert.equal(elements.welcomeBanner.parentNode, elements.messagesList);
  assert.equal(reset, true);
});

test('UIConversation - showBranchLoadingIndicator y hideBranchLoadingIndicator actualizan el DOM y el botón', t => {
  const { messagesList } = setup(t);
  const { wrapper } = UIConversation.createAssistantMessagePlaceholder(messagesList, 'msg_branch', noopCallbacks);
  const button = wrapper.querySelector('.btn-branch-conversation');

  UIConversation.showBranchLoadingIndicator(wrapper, 'Resumiendo contexto previo...');
  assert.equal(button.disabled, true);
  assert.ok(button.classList.contains('is-loading'));
  assert.equal(button.title, 'Resumiendo contexto previo...');
  const indicator = wrapper.querySelector('.branch-progress-indicator');
  assert.equal(indicator.getAttribute('role'), 'status');
  assert.equal(indicator.getAttribute('aria-live'), 'polite');
  assert.ok(indicator.textContent.includes('Resumiendo contexto previo...'));

  UIConversation.showBranchLoadingIndicator(wrapper, 'Resumiendo contexto previo...');
  assert.equal(wrapper.querySelectorAll('.branch-progress-indicator').length, 1, 'No debe duplicar el indicador');

  UIConversation.hideBranchLoadingIndicator(wrapper);
  assert.equal(button.disabled, false);
  assert.equal(button.classList.contains('is-loading'), false);
  assert.equal(button.title, I18n.t('btn_branch_title'));
  assert.equal(button.getAttribute('aria-label'), I18n.t('btn_branch_title'));
  assert.equal(button.querySelector('.ui-icon-spin'), null);
  assert.equal(wrapper.querySelector('.branch-progress-indicator'), null);
});
