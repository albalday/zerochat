const test = require('node:test');
const assert = require('node:assert');
const ChatDebug = require('../../js/debug.js');

test('ChatDebug - Formateo temporal', () => {
  const timeStr = ChatDebug.getFormattedTime();
  assert.ok(/^\d{1,2}:\d{2}:\d{2}$/.test(timeStr));
});
