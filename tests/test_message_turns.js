const { test } = require('node:test');
const assert = require('node:assert/strict');
const Turns = require('../js/message-turns.js');
const State = require('../js/state.js');
const Engine = require('../js/chat-engine.js');

test('Turn rules remove selected calls and orphan results without changing input', () => {
  const history = [
    { id: 'u1', role: 'user', content: 'Question' },
    { id: 'a1', role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'search' } }] },
    { id: 't1', role: 'tool', tool_call_id: 'c1', content: 'Result' },
    { id: 'a1_final', role: 'assistant', content: 'Answer' },
    { id: 'u2', role: 'user', content: 'Next question' },
    { id: 'a2', role: 'assistant', tool_calls: [{ id: 'c2', function: { name: 'read' } }] },
    { id: 't2', role: 'tool', tool_call_id: 'c2', content: 'Kept result' },
    { id: 'a2_final', role: 'assistant', content: 'Kept answer' },
    { id: 'orphan', role: 'tool', tool_call_id: 'unknown' }
  ];
  const original = structuredClone(history);
  const selection = { baseId: 'a1', explicitIds: new Set(['a1']) };
  const result = Turns.removeSelectedTurn(history, selection);
  assert.deepEqual(result.map(m => m.id), ['u1', 'u2', 'a2', 't2', 'a2_final']);
  assert.deepEqual(history, original);
  assert.deepEqual([...selection.explicitIds], ['a1']);
  const store = State.createStore({ messages: history });
  assert.deepEqual(store.removeTurn(selection).messages, result);
  assert.deepEqual(Engine.removeTurnFromHistory(history, selection), result);
});

test('Turn facades preserve distinct legacy selection defaults and busy guards', () => {
  const history = ['msg_alpha_final', 'msg_alpha_other', 'msg_beta_final'].map(id => ({ id, role: 'assistant' }));
  assert.deepEqual(Engine.removeTurnFromHistory(history, { msgId: 'msg_alpha_other' }).map(m => m.id),
    ['msg_alpha_final', 'msg_beta_final']);
  const store = State.createStore({ messages: history });
  assert.deepEqual(store.removeTurn({ msgId: 'msg_alpha_other' }).messages.map(m => m.id), ['msg_beta_final']);
  store.set('streaming', { isGenerating: true });
  assert.equal(store.removeTurn({ baseId: 'msg_beta' }).reason, 'generation-active');
  assert.equal(store.get('messages').length, 1);
  store.set('streaming', { isGenerating: false });
  assert.equal(store.removeTurn(m => m.id === 'msg_beta_final').removedCount, 1);
});

test('Turn rules preserve legacy name matching and distinguish neighboring ID prefixes', () => {
  const history = [
    { id: 'a1', role: 'assistant' },
    { id: 'a10', role: 'assistant', tool_calls: [{ function: { name: 'read' } }] },
    { id: 'result', role: 'tool', name: 'read' }
  ];
  assert.deepEqual(Turns.removeSelectedTurn(history, { baseId: 'a1' }), history.slice(1));
  assert.equal(Turns.isDateTimeInitialTurn({ role: 'user', content: [{ text: 'Current date and time: today' }] }), true);
  assert.equal(Turns.isDateTimeInitialTurn({ role: 'assistant', content: 'Current date and time: today' }), false);
});
