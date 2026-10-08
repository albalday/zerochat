const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const JS_DIR = path.resolve(__dirname, '../../js');
// Únicos módulos autorizados a escribir el slice `ui` directamente; el resto usa los mutadores de ChatState.
const UI_SLICE_WRITERS = new Set(['state.js', 'ui-inspector.js']);

test('ChatState - solo state.js y ui-inspector.js escriben el slice ui con State.set', () => {
  const offenders = fs.readdirSync(JS_DIR)
    .filter(name => name.endsWith('.js') && !UI_SLICE_WRITERS.has(name))
    .filter(name => /\.set\(\s*['"]ui['"]/.test(fs.readFileSync(path.join(JS_DIR, name), 'utf8')));

  assert.deepEqual(offenders, [], `Usa los mutadores de ChatState en lugar de State.set('ui', …): ${offenders.join(', ')}`);
});

test('ChatState - app.js no mantiene una copia mutable del estado de generación', () => {
  const appSource = fs.readFileSync(path.join(__dirname, '../..', 'js', 'app.js'), 'utf8');
  assert.doesNotMatch(appSource, /let\s+isGenerating\s*=/);
  assert.match(appSource, /State\.isConversationBusy/);
});

test('ChatState - el slice project solo se escribe mediante setProjectContext', () => {
  const offenders = fs.readdirSync(JS_DIR)
    .filter(name => name.endsWith('.js') && name !== 'state.js')
    .filter(name => /\.set\(\s*['"]project['"]|setState\(\s*\{\s*project\b/.test(fs.readFileSync(path.join(JS_DIR, name), 'utf8')));

  assert.deepEqual(offenders, [], `Usa ChatState.setProjectContext: ${offenders.join(', ')}`);
});
