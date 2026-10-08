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

test('UIReasoning - acciones del modo proyecto según su estado', () => {
  assert.deepEqual(UIReasoning.getProjectActions({ status: 'missing' }, { canInitialize: true }), ['initialize', 'decline']);
  assert.deepEqual(UIReasoning.getProjectActions({ status: 'missing' }), ['decline']);
  assert.deepEqual(UIReasoning.getProjectActions({ status: 'declined' }), ['reactivate']);
  for (const status of ['ready', 'error', 'no_access']) {
    assert.deepEqual(UIReasoning.getProjectActions({ status }), ['reload'], status);
  }
  for (const status of ['disabled', 'unavailable']) {
    assert.deepEqual(UIReasoning.getProjectActions({ status }), [], status);
  }
});

test('UIReasoning - el texto de estado del proyecto usa la clave de su estado y el nombre de la carpeta', () => {
  const I18n = require('../../js/i18n.js');
  I18n.setLanguage?.('es', false);
  assert.equal(UIReasoning.getProjectStatusText({ projectMode: false }, { status: 'ready', cwd: '/r' }), I18n.t('project_status_disabled'));
  assert.match(UIReasoning.getProjectStatusText({ projectMode: true }, { status: 'ready', cwd: '/home/u/my-repo/' }), /my-repo/);
  assert.match(UIReasoning.getProjectStatusText({ projectMode: true }, { status: 'missing', cwd: 'C:\\code\\app' }), /app/);
});
