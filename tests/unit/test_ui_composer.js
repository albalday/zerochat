const { test } = require('node:test');
const assert = require('node:assert/strict');
const UIComposer = require('../../js/ui-composer.js');
const State = require('../../js/state.js');
const { installDom, getElements } = require('../helpers/dom-env.js');

const COMPOSER_IDS = {
  chatForm: 'chat-form',
  userInput: 'user-input',
  btnSend: 'btn-send',
  btnStopStream: 'btn-stop-stream',
  btnAttachFile: 'btn-attach-file',
  fileInput: 'file-input',
  attachmentsContainer: 'attachments-container',
  generationStatus: 'generation-status'
};

function setup(t) {
  const dom = installDom({ app: true });
  t.after(() => dom.restore());
  return getElements(document, COMPOSER_IDS);
}

function press(element, key, init = {}) {
  const event = new KeyboardEvent('keydown', { key, cancelable: true, ...init });
  element.dispatchEvent(event);
  return event.defaultPrevented;
}

test('UIComposer - setPromptValue escribe el texto y devuelve el foco al compositor', t => {
  const elements = setup(t);
  UIComposer.setPromptValue(elements, 'nuevo prompt');
  assert.equal(elements.userInput.value, 'nuevo prompt');
  assert.equal(document.activeElement, elements.userInput);
});

test('UIComposer - syncGenerationControls alterna Enviar y Parar y limpia el estado al terminar', t => {
  const elements = setup(t);
  State.set('streaming', { isGenerating: true });
  State.setGenerationStatus({ phase: 'tool', text: 'Ejecutando...' });

  UIComposer.syncGenerationControls(elements, true);
  assert.equal(elements.btnSend.disabled, true);
  assert.equal(elements.btnStopStream.hidden, false);
  assert.equal(State.get('ui').generationStatus.phase, 'tool');

  State.set('streaming', { isGenerating: false });
  UIComposer.syncGenerationControls(elements, false);
  assert.equal(elements.btnSend.disabled, false);
  assert.equal(elements.btnStopStream.hidden, true);
  assert.equal(State.get('ui').generationStatus.phase, 'idle');
  assert.equal(elements.generationStatus.hidden, true);
});

test('UIComposer - mount envía con submit y con Enter, pero no con Mayús+Enter', t => {
  const elements = setup(t);
  let sent = 0;
  UIComposer.mount(elements, { onSendMessage: () => { sent++; }, onStopGeneration() {}, getLastPrompt: () => '' });

  elements.chatForm.dispatchEvent(new Event('submit', { cancelable: true }));
  assert.equal(sent, 1);
  assert.equal(press(elements.userInput, 'Enter'), true);
  assert.equal(sent, 2);
  assert.equal(press(elements.userInput, 'Enter', { shiftKey: true }), false);
  assert.equal(sent, 2);

  // Montar de nuevo sustituye los oyentes anteriores en lugar de duplicarlos.
  UIComposer.mount(elements, { onSendMessage: () => { sent++; }, onStopGeneration() {}, getLastPrompt: () => '' });
  press(elements.userInput, 'Enter');
  assert.equal(sent, 3);
});

test('UIComposer - ArrowUp con el composer vacío recupera el último prompt', t => {
  const elements = setup(t);
  let lastPrompt = 'último prompt';
  UIComposer.mount(elements, { onSendMessage() {}, onStopGeneration() {}, getLastPrompt: () => lastPrompt });
  const input = elements.userInput;

  assert.equal(press(input, 'ArrowUp'), true);
  assert.equal(input.value, 'último prompt');
  assert.equal(input.selectionStart, 'último prompt'.length);

  // Con texto en el composer la flecha conserva su comportamiento nativo
  input.value = 'borrador';
  assert.equal(press(input, 'ArrowUp'), false);
  assert.equal(input.value, 'borrador');

  // Con modificadores, durante composición IME o sin historial no se altera nada
  input.value = '';
  assert.equal(press(input, 'ArrowUp', { shiftKey: true }), false);
  assert.equal(press(input, 'ArrowUp', { isComposing: true }), false);
  lastPrompt = '';
  assert.equal(press(input, 'ArrowUp'), false);
  assert.equal(input.value, '');
});

test('UIComposer - el botón de parar y el de adjuntar llaman a su acción', t => {
  const elements = setup(t);
  let stopped = false;
  let pickerOpened = false;
  elements.fileInput.click = () => { pickerOpened = true; };
  UIComposer.mount(elements, { onSendMessage() {}, onStopGeneration: () => { stopped = true; }, getLastPrompt: () => '' });

  elements.btnStopStream.click();
  elements.btnAttachFile.click();
  assert.equal(stopped, true);
  assert.equal(pickerOpened, true);
});
