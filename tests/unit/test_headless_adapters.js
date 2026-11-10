const test = require('node:test');
const assert = require('node:assert/strict');
const HeadlessAdapters = require('../../js/headless-adapters.js');
const ToolCards = require('../../js/tool-cards.js');

test('HeadlessAdapters - MemoryStorage soporta el contrato básico de almacenamiento clave-valor', () => {
  const storage = HeadlessAdapters.createMemoryStorage();
  assert.equal(storage.length, 0);
  assert.equal(storage.getItem('missing'), null);

  storage.setItem('k1', 'val1');
  storage.setItem('k2', 'val2');
  assert.equal(storage.length, 2);
  assert.equal(storage.getItem('k1'), 'val1');
  assert.equal(storage.key(0), 'k1');

  storage.removeItem('k1');
  assert.equal(storage.length, 1);
  assert.equal(storage.getItem('k1'), null);

  storage.clear();
  assert.equal(storage.length, 0);
});

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

test('HeadlessAdapters - createHeadlessTurnView responde a autorizaciones usando el responder activo', async () => {
  let activeResponder = name => (name === 'read_file' ? 'allow_session' : 'deny');
  ToolCards.setAuthorizationResponder(activeResponder);
  try {
    const view = HeadlessAdapters.createHeadlessTurnView();
    const card = view.cards.open('read_file', {}, 'inv_1');

    assert.equal(card.element, null);
    assert.equal(typeof card.attachListeners, 'function');
    assert.equal(typeof card.nest, 'function');
    assert.equal(typeof card.complete, 'function');

    const decision = await card.requestAuthorization({ function: { name: 'read_file' } }, { name: 'read_file' });
    assert.equal(decision, 'allow_session');

    const denied = await card.requestAuthorization({ function: { name: 'run_command' } }, { name: 'run_command' });
    assert.equal(denied, 'deny');
  } finally {
    ToolCards.setAuthorizationResponder(null);
  }
});

test('HeadlessAdapters - createHeadlessTurnView usa getAuthorizationResponder inyectado si se especifica', async () => {
  const customResponder = name => (name === 'write_file' ? 'allow_once' : 'deny');
  const view = HeadlessAdapters.createHeadlessTurnView({ getAuthorizationResponder: () => customResponder });
  const card = view.cards.open('write_file', {}, 'inv_2');

  const decision = await card.requestAuthorization({ function: { name: 'write_file' } }, { name: 'write_file' });
  assert.equal(decision, 'allow_once');

  const nested = card.nest();
  const nestedCard = nested.open('write_file', {}, 'inv_nested');
  const nestedDecision = await nestedCard.requestAuthorization({ function: { name: 'write_file' } }, { name: 'write_file' });
  assert.equal(nestedDecision, 'allow_once');
});

test('HeadlessAdapters - createHeadlessTurnView deniega por defecto si no hay responder activo', async () => {
  ToolCards.setAuthorizationResponder(null);
  const view = HeadlessAdapters.createHeadlessTurnView();
  const card = view.cards.open('write_file', {}, 'inv_3');

  const decision = await card.requestAuthorization({ function: { name: 'write_file' } }, { name: 'write_file' });
  assert.equal(decision, 'deny');
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
});
