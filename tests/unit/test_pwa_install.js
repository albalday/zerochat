const { test } = require('node:test');
const assert = require('node:assert/strict');

function loadPwa({ navigator = {}, matchMedia = () => ({ matches: false }) } = {}) {
  const modulePath = require.resolve('../../js/pwa-install.js');
  delete require.cache[modulePath];
  const previousWindow = global.window;
  const previousNavigator = global.navigator;
  global.window = {
    navigator,
    matchMedia,
    addEventListener() {}
  };
  global.navigator = navigator;
  const module = require('../../js/pwa-install.js');
  return {
    module,
    restore() {
      global.window = previousWindow;
      global.navigator = previousNavigator;
      delete require.cache[modulePath];
    }
  };
}

test('PWA install - cancela el aviso automático y solo habilita el botón', () => {
  const { module, restore } = loadPwa();
  try {
    const button = { hidden: true, addEventListener() {} };
    module.setup(button);
    let prevented = false;
    module.handleBeforeInstallPrompt({ preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(button.hidden, false);
  } finally {
    restore();
  }
});

test('PWA install - solicita el diálogo nativo solo al invocar la acción', async () => {
  const { module, restore } = loadPwa();
  try {
    const button = { hidden: true, addEventListener() {} };
    module.setup(button);
    let prompted = false;
    module.handleBeforeInstallPrompt({
      preventDefault() {},
      prompt: async () => { prompted = true; },
      userChoice: Promise.resolve({ outcome: 'accepted' })
    });
    assert.equal(prompted, false);
    assert.deepEqual(await module.requestInstall(), { outcome: 'accepted' });
    assert.equal(prompted, true);
    assert.equal(button.hidden, true);
  } finally {
    restore();
  }
});

test('PWA install - no se muestra en una aplicación ya instalada', () => {
  const { module, restore } = loadPwa({ matchMedia: () => ({ matches: true }) });
  try {
    const button = { hidden: false, addEventListener() {} };
    module.setup(button);
    module.handleBeforeInstallPrompt({ preventDefault() {} });
    assert.equal(button.hidden, true);
  } finally {
    restore();
  }
});
