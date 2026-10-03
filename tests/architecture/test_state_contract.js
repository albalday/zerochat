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
