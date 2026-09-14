const { test } = require('node:test');
const assert = require('node:assert/strict');
const State = require('../../js/state.js');
const Engine = require('../../js/chat-engine.js');

test('Turn integration facades - State y Engine aplican reglas de turnos con sus contratos específicos', () => {
  const history = [
    { id: 'u1', role: 'user', content: 'Pregunta' },
    { id: 'a1', role: 'assistant', tool_calls: [{ id: 'call_1', function: { name: 'search' } }] },
    { id: 't1', role: 'tool', tool_call_id: 'call_1', content: 'Dato' },
    { id: 'a1_final', role: 'assistant', content: 'Respuesta' }
  ];

  const selection = { baseId: 'a1', explicitIds: new Set(['a1']) };

  // ChatState mutador
  const store = State.createStore({ messages: history });
  const stateResult = store.removeTurn(selection);
  assert.equal(stateResult.ok, true);
  assert.equal(stateResult.removedCount, 3);
  assert.deepEqual(store.get('messages').map(m => m.id), ['u1']);

  // ChatEngine función pura de historial
  const engineResult = Engine.removeTurnFromHistory(history, selection);
  assert.deepEqual(engineResult.map(m => m.id), ['u1']);
});

test('Turn integration facades - State bloquea borrado durante inferencia activa', () => {
  const history = [
    { id: 'msg_alpha_final', role: 'assistant' },
    { id: 'msg_alpha_other', role: 'assistant' },
    { id: 'msg_beta_final', role: 'assistant' }
  ];

  const store = State.createStore({ messages: history });

  // Guard activo durante streaming
  store.set('streaming', { isGenerating: true });
  const busyResult = store.removeTurn({ baseId: 'msg_beta' });
  assert.equal(busyResult.ok, false);
  assert.equal(busyResult.reason, 'generation-active');
  assert.equal(store.get('messages').length, 3);

  // Inferencia terminada: borrado permitido
  store.set('streaming', { isGenerating: false });
  const successResult = store.removeTurn(m => m.id === 'msg_beta_final');
  assert.equal(successResult.ok, true);
  assert.equal(successResult.removedCount, 1);
  assert.equal(store.get('messages').length, 2);
});
