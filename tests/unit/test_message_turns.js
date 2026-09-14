const { test } = require('node:test');
const assert = require('node:assert/strict');
const Turns = require('../../js/message-turns.js');

test('Turns.extractBaseId - normaliza identificadores y descarta sufijos de turnos', () => {
  assert.equal(Turns.extractBaseId('msg_123_turn_0_assistant'), 'msg_123');
  assert.equal(Turns.extractBaseId('msg_123_turn_1_tool_call_foo'), 'msg_123');
  assert.equal(Turns.extractBaseId('msg_123_final'), 'msg_123');
  assert.equal(Turns.extractBaseId('msg_123'), 'msg_123');
  assert.equal(Turns.extractBaseId(''), '');
  assert.equal(Turns.extractBaseId(null), '');
  assert.equal(Turns.extractBaseId(undefined), '');
  assert.equal(Turns.extractBaseId(123), '');
});

test('Turns.isDateTimeInitialTurn - reconoce turnos temporales en español e inglés y multipart', () => {
  // Español
  assert.equal(Turns.isDateTimeInitialTurn({ role: 'user', content: 'La fecha y hora actual es: lunes 14 de septiembre' }), true);
  assert.equal(Turns.isDateTimeInitialTurn({ role: 'user', content: 'Fecha y hora actual: lunes 14 de septiembre' }), true);

  // Inglés
  assert.equal(Turns.isDateTimeInitialTurn({ role: 'user', content: 'The current date and time is: Monday, September 14' }), true);
  assert.equal(Turns.isDateTimeInitialTurn({ role: 'user', content: 'Current date and time: Monday, September 14' }), true);

  // Multipart (array con objeto text)
  assert.equal(Turns.isDateTimeInitialTurn({ role: 'user', content: [{ text: 'Current date and time: today' }] }), true);

  // No iniciales o roles distintos de user
  assert.equal(Turns.isDateTimeInitialTurn({ role: 'assistant', content: 'Current date and time: today' }), false);
  assert.equal(Turns.isDateTimeInitialTurn({ role: 'system', content: 'Current date and time: today' }), false);
  assert.equal(Turns.isDateTimeInitialTurn({ role: 'user', content: 'Hola mundo' }), false);
  assert.equal(Turns.isDateTimeInitialTurn(null), false);
  assert.equal(Turns.isDateTimeInitialTurn({}), false);
});

test('Turns.removeSelectedTurn - elimina llamadas seleccionadas y resultados huérfanos sin mutar el array de entrada', () => {
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

  // Inmutabilidad verificada
  assert.deepEqual(history, original);
  assert.deepEqual([...selection.explicitIds], ['a1']);

  // Resultado esperado: 'a1', 't1', 'a1_final' y el 'orphan' eliminados; 'u1', 'u2', 'a2', 't2', 'a2_final' preservados
  assert.deepEqual(result.map(m => m.id), ['u1', 'u2', 'a2', 't2', 'a2_final']);
});

test('Turns.removeSelectedTurn - preserva compatibilidad por nombre y distingue prefijos de identificadores contiguos', () => {
  const history = [
    { id: 'a1', role: 'assistant' },
    { id: 'a10', role: 'assistant', tool_calls: [{ function: { name: 'read' } }] },
    { id: 'result', role: 'tool', name: 'read' }
  ];

  // Si se elimina baseId 'a1', 'a10' NO debe eliminarse
  const withoutA1 = Turns.removeSelectedTurn(history, { baseId: 'a1' });
  assert.deepEqual(withoutA1.map(m => m.id), ['a10', 'result']);

  // Selección explícita por explicitIds
  const onlyUsers = Turns.removeSelectedTurn([
    { id: 'u1', role: 'user' },
    { id: 'a1', role: 'assistant' }
  ], { explicitIds: ['a1'] });
  assert.deepEqual(onlyUsers.map(m => m.id), ['u1']);

  // Entradas vacías o nulas
  assert.deepEqual(Turns.removeSelectedTurn([], { baseId: 'a1' }), []);
  assert.deepEqual(Turns.removeSelectedTurn(null, { baseId: 'a1' }), []);
});
