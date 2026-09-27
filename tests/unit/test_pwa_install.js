const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('PWA install - suprime la sugerencia sin solicitar instalación ni registrar acciones', () => {
  const listeners = {};
  const source = fs.readFileSync(path.resolve(__dirname, '../../js/pwa-install.js'), 'utf8');
  vm.runInNewContext(source, {
    window: {
      addEventListener(name, handler) { listeners[name] = handler; }
    }
  });
  assert.deepEqual(Object.keys(listeners), ['beforeinstallprompt']);
  for (let i = 0; i < 2; i++) {
    let prevented = false;
    listeners.beforeinstallprompt({
      preventDefault() { prevented = true; },
      prompt() { assert.fail('ZeroChat no debe solicitar instalación'); }
    });
    assert.equal(prevented, true);
  }
});
