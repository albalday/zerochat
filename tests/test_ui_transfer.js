const { test } = require('node:test');
const assert = require('node:assert/strict');
const UITransfer = require('../js/ui-transfer.js');

test('UITransfer - parseConversationJson parses object with messages array', () => {
  const jsonStr = JSON.stringify({
    title: 'Chat Test',
    messages: [
      { role: 'user', content: 'Hola' },
      { role: 'assistant', content: 'Mundo' }
    ]
  });

  const parsed = UITransfer.parseConversationJson(jsonStr);
  assert.equal(parsed.messages.length, 2);
  assert.equal(parsed.messages[0].content, 'Hola');
  assert.equal(parsed.messages[1].content, 'Mundo');
});

test('UITransfer - parseConversationJson parses raw array format', () => {
  const jsonStr = JSON.stringify([
    { role: 'user', content: 'Solo array' }
  ]);

  const parsed = UITransfer.parseConversationJson(jsonStr);
  assert.equal(parsed.messages.length, 1);
  assert.equal(parsed.messages[0].content, 'Solo array');
});

test('UITransfer - parseConversationJson rejects invalid payload structure', () => {
  assert.throws(() => {
    UITransfer.parseConversationJson('{"invalid": true}');
  }, /Estructura de conversación no válida/);

  assert.throws(() => {
    UITransfer.parseConversationJson('null');
  });
});

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
