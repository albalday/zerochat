const test = require('node:test');
const assert = require('node:assert/strict');
const State = require('../../js/state.js');

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

  // Tope de elementos de una confirmación en el borde exacto: 50 se aceptan, 51 no
  const listStore = State.createStore();
  const items = count => Array.from({ length: count }, (_, i) => ({ id: `i${i}`, label: `Item ${i}` }));
  const accepted = listStore.enqueueNotice({ ...notice, mode: 'confirm', items: items(50) });
  assert.equal(listStore.get('ui').notices.find(item => item.id === accepted).items.length, 50);
  assert.throws(() => listStore.enqueueNotice({ ...notice, mode: 'confirm', items: items(51) }), TypeError);
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
