const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../js/app.js'), 'utf8');

test('App startup requires the canonical config module before registering UI startup', () => {
  assert.throws(() => vm.runInNewContext(source, { window: {} }), /requires ChatConfig/);
  const events = [];
  vm.runInNewContext(source, {
    window: { ChatConfig: { initialize: () => events.push('config'), getActive: () => ({}) } },
    document: { readyState: 'loading', addEventListener: type => events.push(type) }
  });
  assert.deepEqual(events, ['config', 'DOMContentLoaded']);
});

test('App startup reports config initialization failures while retaining the canonical store', () => {
  let warning;
  let startupRegistered = false;
  vm.runInNewContext(source, {
    window: { ChatConfig: { initialize: () => { throw new Error('Unavailable persistence'); }, getActive: () => ({}) } },
    console: { warn: (_message, error) => { warning = error.message; } },
    document: { readyState: 'loading', addEventListener: () => { startupRegistered = true; } }
  });
  assert.equal(warning, 'Unavailable persistence');
  assert.equal(startupRegistered, true);
});
