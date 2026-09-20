const test = require('node:test');
const assert = require('node:assert/strict');
const Defaults = require('../../js/defaults.js');

test('ChatDefaults - el tema predeterminado compartido es oscuro', () => {
  assert.equal(Defaults.DEFAULT_THEME, 'dark');
  assert.ok(Object.isFrozen(Defaults));
});
