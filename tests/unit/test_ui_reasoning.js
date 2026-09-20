const { test } = require('node:test');
const assert = require('node:assert/strict');
const UIReasoning = require('../../js/ui-reasoning.js');

test('UIReasoning - convierte entre intensidad y esfuerzo sin valores inválidos', () => {
  assert.equal(UIReasoning.getReasoningIntensity('none'), 0);
  assert.equal(UIReasoning.getReasoningIntensity('off'), 0);
  assert.equal(UIReasoning.getReasoningIntensity('medium'), 2);
  assert.equal(UIReasoning.getReasoningIntensity('xhigh'), 4);
  assert.equal(UIReasoning.getReasoningLevelFromIntensity(-1), 'none');
  assert.equal(UIReasoning.getReasoningLevelFromIntensity(3), 'high');
  assert.equal(UIReasoning.getReasoningLevelFromIntensity(99), 'xhigh');
});

test('UIReasoning - sincroniza slider y etiqueta con el esfuerzo elegido', () => {
  const attributes = {};
  const elements = {
    reasoningIntensity: {
      value: '',
      style: { setProperty: (key, value) => { attributes[key] = value; } },
      setAttribute: (key, value) => { attributes[key] = value; }
    },
    reasoningIntensityValue: { textContent: '' }
  };
  UIReasoning.syncReasoningIntensity(elements, 'high');
  assert.equal(elements.reasoningIntensity.value, '3');
  assert.equal(attributes['--reasoning-intensity'], '75%');
  assert.ok(elements.reasoningIntensityValue.textContent);
});

test('UIReasoning - seleccionar nivel mantiene la compatibilidad y notifica la intención', () => {
  const classes = new Set();
  const elements = {
    reasoningLabel: { textContent: '' },
    btnReasoning: { classList: { toggle: (key, value) => value ? classes.add(key) : classes.delete(key) } },
    reasoningMenu: { style: {} }
  };
  let selected = '';
  UIReasoning.selectReasoningLevel(elements, {}, 'high', value => { selected = value; });
  assert.equal(selected, 'high');
  assert.ok(classes.has('active-high'));
  assert.equal(elements.reasoningMenu.style.display, 'none');
});
