const test = require('node:test');
const assert = require('node:assert');
const ChatDebug = require('../../js/debug.js');

test('ChatDebug - Gestión de estado y formateo temporal', () => {
  const timeStr = ChatDebug.getFormattedTime();
  assert.ok(/^\d{1,2}:\d{2}:\d{2}$/.test(timeStr));

  ChatDebug.setRawLogsEnabled(true);
  assert.equal(ChatDebug.isRawLogsEnabled(), true);

  ChatDebug.setRawLogsEnabled(false);
  assert.equal(ChatDebug.isRawLogsEnabled(), false);
});
