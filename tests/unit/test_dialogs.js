const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const State = require('../../js/state.js');
const { listSourceFiles } = require('../helpers/source-files');

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
  for (const file of listSourceFiles(path.resolve(__dirname, '../../js'))) {
    const source = fs.readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(source, /(?:window|globalThis|self)\s*\.\s*(?:alert|confirm|prompt)\s*\(/, file);
    assert.doesNotMatch(source.replace(/function alert\(/g, 'function internalNotice('), /(?<![\w.])(?:alert|confirm|prompt)\s*\(/g, file);
  }
});

test('Confirmations, item lists and prompts remain independent and return explicit results', () => {
  const store = State.createStore();

  const confirmNotice = { message: 'Delete?', title: 'Confirm', type: 'info', mode: 'confirm' };
  const c1 = store.enqueueNotice(confirmNotice);
  const c2 = store.enqueueNotice(confirmNotice);
  assert.notEqual(c1, c2);
  store.dismissNotice(c1, true);
  assert.deepEqual(store.get('ui').noticeResult, { id: c1, accepted: true });
  store.dismissNotice(c2);
  assert.deepEqual(store.get('ui').noticeResult, { id: c2, accepted: false });

  const itemNotice = { message: 'Start?', title: 'Services', type: 'info', mode: 'confirm', items: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] };
  const i1 = store.enqueueNotice(itemNotice);
  assert.deepEqual(store.get('ui').notices[0].items, itemNotice.items);
  store.dismissNotice(i1, true, null, false, ['b', 'b', 'injected']);
  assert.deepEqual(store.get('ui').noticeResult, { id: i1, accepted: true, items: ['b'] });
  const i2 = store.enqueueNotice(itemNotice);
  store.dismissNotice(i2, false, null, false, ['a']);
  assert.deepEqual(store.get('ui').noticeResult, { id: i2, accepted: false, items: null });
  assert.throws(() => store.enqueueNotice({ ...itemNotice, items: [{ id: '', label: 'Empty' }] }), TypeError);
  assert.throws(() => store.enqueueNotice({ ...itemNotice, items: [{ id: 'x'.repeat(201), label: 'Long' }] }), TypeError);
  assert.throws(() => store.enqueueNotice({ ...itemNotice, items: 'a' }), TypeError);

  const promptNotice = { message: 'Name', title: 'Input', type: 'info', mode: 'prompt', value: '<text>' };
  const p1 = store.enqueueNotice(promptNotice);
  const p2 = store.enqueueNotice(promptNotice);
  assert.notEqual(p1, p2);
  assert.equal(store.get('ui').notices[0].value, '<text>');
  store.dismissNotice(p1, true, '');
  assert.equal(store.get('ui').noticeResult.value, '');
  store.dismissNotice(p2, false, 'discard');
  assert.equal(store.get('ui').noticeResult.value, null);
});
