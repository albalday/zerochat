const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const State = require('../js/state.js');

test('Notice queue validates, deduplicates and clears on conversation changes', () => {
  const store = State.createStore();
  const notice = { message: 'Hello', title: 'Information', type: 'info' };
  const id = store.enqueueNotice(notice);
  assert.equal(store.enqueueNotice(notice), id);
  store.enqueueNotice({ ...notice, message: 'Second' });
  assert.equal(store.get('ui').notices.length, 2);
  store.dismissNotice(id);
  assert.equal(store.get('ui').notices[0].message, 'Second');
  assert.throws(() => store.enqueueNotice({ ...notice, type: 'invalid' }), TypeError);
  store.replaceConversation({ sessionId: 'another', messages: [] });
  assert.deepEqual(store.get('ui').notices, []);
  for (let i = 0; i < 50; i++) store.enqueueNotice({ ...notice, message: String(i) });
  assert.throws(() => store.enqueueNotice(notice), RangeError);
});

test('Application does not call native browser dialogs', () => {
  function check(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'vendor') continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) check(file);
      else if (file.endsWith('.js')) {
        const source = fs.readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '');
        assert.doesNotMatch(source, /(?:window|globalThis|self)\s*\.\s*(?:alert|confirm|prompt)\s*\(/, file);
        assert.doesNotMatch(source.replace(/function alert\(/g, 'function internalNotice('), /(?<![\w.])(?:alert|confirm|prompt)\s*\(/g, file);
      }
    }
  }
  check('js');
});

test('Confirmations remain independent and require explicit acceptance', () => {
  const store = State.createStore();
  const notice = { message: 'Delete?', title: 'Confirm', type: 'info', mode: 'confirm' };
  const first = store.enqueueNotice(notice);
  const second = store.enqueueNotice(notice);
  assert.notEqual(first, second);
  store.dismissNotice(first, true);
  assert.deepEqual(store.get('ui').noticeResult, { id: first, accepted: true });
  store.dismissNotice(second);
  assert.deepEqual(store.get('ui').noticeResult, { id: second, accepted: false });
});

test('Prompts preserve initial text and distinguish empty acceptance from cancellation', () => {
  const store = State.createStore();
  const notice = { message: 'Name', title: 'Input', type: 'info', mode: 'prompt', value: '<text>' };
  const first = store.enqueueNotice(notice);
  const second = store.enqueueNotice(notice);
  assert.notEqual(first, second);
  assert.equal(store.get('ui').notices[0].value, '<text>');
  store.dismissNotice(first, true, '');
  assert.equal(store.get('ui').noticeResult.value, '');
  store.dismissNotice(second, false, 'discard');
  assert.equal(store.get('ui').noticeResult.value, null);
});
