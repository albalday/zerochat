const test = require('node:test');
const assert = require('node:assert/strict');
const McpStatus = require('../../js/mcp-status.js');
const CONTRACT = require('../fixtures/mcp/contract.json');

test('McpStatus - los estados son los del backend y cada predicado los clasifica', () => {
  assert.deepEqual(McpStatus.SERVICE_STATUSES, CONTRACT.serviceStatuses);
  // estado -> [isBusy, isRunning, isActive, canStart]; null es sin conexión.
  const table = {
    stopped: [false, false, false, true],
    installing: [true, false, true, false],
    starting: [true, false, true, false],
    running: [false, true, true, false],
    error: [false, false, false, true],
    null: [false, false, false, false]
  };
  for (const [key, expected] of Object.entries(table)) {
    const status = key === 'null' ? null : key;
    const { isBusy, isRunning, isActive, canStart } = McpStatus;
    assert.deepEqual([isBusy, isRunning, isActive, canStart].map(predicate => predicate(status)), expected, key);
  }
});
