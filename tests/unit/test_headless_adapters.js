const test = require('node:test');
const assert = require('node:assert/strict');
const HeadlessAdapters = require('../../js/headless-adapters.js');
const ToolCards = require('../../js/tool-cards.js');

test('HeadlessAdapters - createHeadlessTurnView gestiona bloques de texto sin DOM', () => {
  const view = HeadlessAdapters.createHeadlessTurnView();
  assert.equal(typeof view.scrollToBottom, 'function');
  view.scrollToBottom();

  const block1 = view.createBlock();
  block1.render('chunk 1', { streaming: true });
  assert.equal(block1.getText(), 'chunk 1');

  block1.render('chunk 1 final', { streaming: false });
  assert.equal(block1.getText(), 'chunk 1 final');

  block1.remove();
  assert.equal(block1.getText(), '');

  const block2 = view.createBlock({ reset: true });
  block2.render('reset block');
  assert.equal(block2.getText(), 'reset block');
});

test('HeadlessAdapters - createHeadlessTurnView delega autorizaciones al responder activo, al inyectado o deniega por defecto', async () => {
  globalThis.ChatToolCards = ToolCards;
  ToolCards.setAuthorizationResponder(name => (name === 'read_file' ? 'allow_session' : 'deny'));
  try {
    const view = HeadlessAdapters.createHeadlessTurnView();
    const card = view.cards.open('read_file', {}, 'inv_1');
    assert.equal(card.element, null);
    for (const fn of ['attachListeners', 'nest', 'complete']) assert.equal(typeof card[fn], 'function');
    assert.equal(await card.requestAuthorization({ function: { name: 'read_file' } }, { name: 'read_file' }), 'allow_session');
    assert.equal(await card.requestAuthorization({ function: { name: 'run_command' } }, { name: 'run_command' }), 'deny');
  } finally {
    ToolCards.setAuthorizationResponder(null);
  }

  const customView = HeadlessAdapters.createHeadlessTurnView({ getAuthorizationResponder: () => (name => (name === 'write_file' ? 'allow_once' : 'deny')) });
  const nestedCard = customView.cards.open('write_file', {}, 'inv_2').nest().open('write_file', {}, 'inv_nested');
  assert.equal(await nestedCard.requestAuthorization({ function: { name: 'write_file' } }, { name: 'write_file' }), 'allow_once');

  const noResponderView = HeadlessAdapters.createHeadlessTurnView();
  assert.equal(await noResponderView.cards.open('write_file', {}, 'inv_3').requestAuthorization({ function: { name: 'write_file' } }, { name: 'write_file' }), 'deny');
});

test('HeadlessAdapters - createHeadlessConversationStore interactúa con el backend RPC', async () => {
  assert.throws(() => HeadlessAdapters.createHeadlessConversationStore(null), /must be a function/);

  const calls = [];
  const fakeBackend = async (method, params) => {
    calls.push({ method, params });
    if (method === 'zerochat/conversations/get') {
      return { conversation: { id: params.id, title: 'Test Conv', messages: [] } };
    }
    if (method === 'zerochat/conversations/save') {
      return { ok: true };
    }
    return null;
  };

  const store = HeadlessAdapters.createHeadlessConversationStore(fakeBackend);

  const empty = await store.getConversation('');
  assert.equal(empty, null);

  const conv = await store.getConversation('conv_123');
  assert.deepEqual(conv, { id: 'conv_123', title: 'Test Conv', messages: [] });
  assert.equal(calls[0].method, 'zerochat/conversations/get');
  assert.equal(calls[0].params.id, 'conv_123');

  const savedEmpty = await store.saveConversation({});
  assert.equal(savedEmpty, false);

  const saved = await store.saveConversation({ id: 'conv_123', title: 'Updated' }, [{ role: 'user', content: 'hello' }]);
  assert.equal(saved, true);
  assert.equal(calls[1].method, 'zerochat/conversations/save');
  assert.equal(calls[1].params.conversation.id, 'conv_123');
  assert.equal(calls[1].params.messages.length, 1);

  // Conversación > CONVERSATION_SAVE_CHUNK_BYTES pasa por save_chunk y commit final.
  const Storage = require('../../js/storage.js');
  calls.length = 0;
  const big = 'Z'.repeat(Math.floor(Storage.CONVERSATION_SAVE_CHUNK_BYTES * 0.7));
  await store.saveConversation({ id: 'conv_big', title: 'Big' }, [
    { id: 'b1', role: 'user', content: big },
    { id: 'b2', role: 'assistant', content: big }
  ]);
  assert.equal(calls.slice(0, -1).every(c => c.method === 'zerochat/conversations/save_chunk'), true);
  assert.equal(calls.at(-1).method, 'zerochat/conversations/save');
  assert.ok(calls.at(-1).params.uploadId);
});
