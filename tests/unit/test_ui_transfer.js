const { test } = require('node:test');
const assert = require('node:assert/strict');
const UITransfer = require('../../js/ui-transfer.js');

test('UITransfer - openExportModal and closeExportModal manage dialog open state', () => {
  let modalOpened = false;
  let modalClosed = false;
  const mockElements = {
    exportModal: {
      open: false,
      showModal: () => { modalOpened = true; mockElements.exportModal.open = true; },
      close: () => { modalClosed = true; mockElements.exportModal.open = false; }
    }
  };

  UITransfer.openExportModal(mockElements, 'chat_123');
  assert.equal(modalOpened, true);
  assert.equal(UITransfer.getExportTargetSessionId(mockElements), 'chat_123');

  UITransfer.closeExportModal(mockElements);
  assert.equal(modalClosed, true);
  assert.equal(UITransfer.getExportTargetSessionId(mockElements), '');
});

test('UITransfer - resolveSessionForExport returns active session when matching target', async () => {
  const mockMessages = [{ role: 'user', content: 'Activo' }];
  const session = await UITransfer.resolveSessionForExport('chat_active', {
    getActiveSessionId: () => 'chat_active',
    getHistory: () => mockMessages
  });

  assert.notEqual(session, null);
  assert.equal(session.id, 'chat_active');
  assert.deepEqual(session.messages, mockMessages);
});

test('UITransfer - mount limpia la sesión de destino al cerrar el modal y rechaza archivos demasiado grandes', async () => {
  const listeners = {};
  const makeTarget = (name, extra = {}) => ({
    ...extra,
    addEventListener: (evt, fn) => { listeners[`${name}:${evt}`] = fn; },
    removeEventListener: (evt) => { delete listeners[`${name}:${evt}`]; }
  });
  const elements = {
    exportModal: makeTarget('modal', { dataset: { sessionId: 'session_a' } }),
    importJsonInput: makeTarget('input', { value: 'C:\\fakepath\\big.json' })
  };
  let imported = false;
  const previousDialogs = globalThis.ChatDialogs;
  const alerts = [];
  globalThis.ChatDialogs = { alert: async (message, options) => { alerts.push(options?.type); } };
  try {
    UITransfer.mount({ elements, onImportSuccess: () => { imported = true; } });

    listeners['modal:close']();
    assert.equal(elements.exportModal.dataset.sessionId, undefined);

    await listeners['input:change']({ target: { files: [{ name: 'big.json', size: 51 * 1024 * 1024 }] } });
    assert.equal(imported, false);
    assert.deepEqual(alerts, ['error']);
    assert.equal(elements.importJsonInput.value, '');

    UITransfer.dispose();
    assert.equal(listeners['modal:close'], undefined);
    assert.equal(listeners['input:change'], undefined);
  } finally {
    globalThis.ChatDialogs = previousDialogs;
  }
});
