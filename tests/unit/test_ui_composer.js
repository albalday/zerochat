const { test } = require('node:test');
const assert = require('node:assert/strict');
const UIComposer = require('../../js/ui-composer.js');

test('UIComposer - getPromptValue and setPromptValue manipulate input value', () => {
  const elements = {
    userInput: { value: '  hola mundo  ', focus() {} }
  };
  assert.equal(UIComposer.getPromptValue(elements), 'hola mundo');

  UIComposer.setPromptValue(elements, 'nuevo prompt');
  assert.equal(UIComposer.getPromptValue(elements), 'nuevo prompt');

  UIComposer.clearInput(elements);
  assert.equal(UIComposer.getPromptValue(elements), '');
});

test('UIComposer - autoResizeTextarea adjusts height based on scrollHeight', () => {
  const elements = {
    userInput: {
      value: 'texto multilinea',
      scrollHeight: 100,
      style: { height: '' }
    }
  };

  UIComposer.autoResizeTextarea(elements);
  assert.equal(elements.userInput.style.height, '100px');

  elements.userInput.scrollHeight = 300;
  UIComposer.autoResizeTextarea(elements);
  assert.equal(elements.userInput.style.height, '160px'); // capped at 160

  elements.userInput.value = '';
  UIComposer.autoResizeTextarea(elements);
  assert.equal(elements.userInput.style.height, '');
});

test('UIComposer - syncGenerationControls updates btnSend and btnStopStream states', () => {
  const elements = {
    btnSend: { disabled: false },
    btnStopStream: { style: { display: 'none' } }
  };

  let cleared = false;
  const options = {
    clearGenerationStatus: () => { cleared = true; }
  };

  // Cuando está generando
  UIComposer.syncGenerationControls(elements, true, options);
  assert.equal(elements.btnSend.disabled, true);
  assert.equal(elements.btnStopStream.style.display, 'inline-flex');
  assert.equal(cleared, false);

  // Cuando se detiene la generación
  UIComposer.syncGenerationControls(elements, false, options);
  assert.equal(elements.btnSend.disabled, false);
  assert.equal(elements.btnStopStream.style.display, 'none');
  assert.equal(cleared, true);
});

test('UIComposer - mount attaches submit and keydown handlers and disposes cleanly', () => {
  const listeners = {};
  function addListener(target, event, fn) {
    listeners[target + ':' + event] = fn;
  }
  function removeListener(target, event) {
    delete listeners[target + ':' + event];
  }

  const elements = {
    chatForm: {
      addEventListener: (evt, fn) => addListener('form', evt, fn),
      removeEventListener: (evt, fn) => removeListener('form', evt, fn),
      classList: { add() {}, remove() {} }
    },
    userInput: {
      addEventListener: (evt, fn) => addListener('input', evt, fn),
      removeEventListener: (evt, fn) => removeListener('input', evt, fn)
    }
  };

  let sent = false;
  const composer = UIComposer.mount(elements, {
    onSendMessage: () => { sent = true; }
  });

  // Evento submit en formulario
  let prevented = false;
  listeners['form:submit']({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(sent, true);

  // Evento Enter sin Shift en input
  sent = false;
  prevented = false;
  listeners['input:keydown']({ key: 'Enter', shiftKey: false, preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(sent, true);

  // Shift + Enter no debe disparar envío
  sent = false;
  prevented = false;
  listeners['input:keydown']({ key: 'Enter', shiftKey: true, preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false);
  assert.equal(sent, false);

  // Desmontar
  UIComposer.dispose();
  assert.equal(listeners['form:submit'], undefined);
  assert.equal(listeners['input:keydown'], undefined);
});

