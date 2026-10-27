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

test('Turns.hasMatchingToolCall - acepta resultados paralelos del mismo turno assistant', () => {
  const assistant = { role: 'assistant', content: null, tool_calls: [{ id: 'call_a', function: { name: 'a' } }, { id: 'call_b', function: { name: 'b' } }] };
  const toolA = { role: 'tool', tool_call_id: 'call_a', name: 'a', content: 'A' };
  assert.equal(Turns.hasMatchingToolCall([assistant], toolA), true);
  assert.equal(Turns.hasMatchingToolCall([assistant, toolA], { tool_call_id: 'call_b', name: 'b' }), true);
  assert.equal(Turns.hasMatchingToolCall([assistant, toolA], { tool_call_id: 'call_x', name: 'x' }), false);
  assert.equal(Turns.hasMatchingToolCall([{ role: 'user', content: 'Hola' }, toolA], toolA), false);
  assert.equal(Turns.hasMatchingToolCall([], toolA), false);
});

test('Turns.removeSelectedTurn - conserva todos los resultados de llamadas paralelas ajenas al turno borrado', () => {
  const history = [
    { id: 'u1', role: 'user', content: 'Primera' },
    { id: 'u1_turn_0_assistant', role: 'assistant', content: null, tool_calls: [{ id: 'call_a', function: { name: 'a' } }, { id: 'call_b', function: { name: 'b' } }] },
    { id: 'u1_turn_0_tool_a', role: 'tool', tool_call_id: 'call_a', name: 'a', content: 'A' },
    { id: 'u1_turn_0_tool_b', role: 'tool', tool_call_id: 'call_b', name: 'b', content: 'B' },
    { id: 'u1_final', role: 'assistant', content: 'Respuesta' },
    { id: 'u2', role: 'user', content: 'Segunda' },
    { id: 'u2_final', role: 'assistant', content: 'Otra' }
  ];
  const result = Turns.removeSelectedTurn(history, { baseId: 'u2' });
  assert.deepEqual(result.map(message => message.id), ['u1', 'u1_turn_0_assistant', 'u1_turn_0_tool_a', 'u1_turn_0_tool_b', 'u1_final']);
});

test('Turns.dropOrphanToolMessages - descarta resultados sin turno assistant que los declare', () => {
  const result = Turns.dropOrphanToolMessages([
    { role: 'user', content: 'Hola' },
    { role: 'tool', tool_call_id: 'call_x', name: 'x', content: 'huérfano' },
    { role: 'assistant', content: 'Fin' }
  ]);
  assert.deepEqual(result.map(message => message.role), ['user', 'assistant']);
});

test('Turns.getLastUserPrompt - devuelve el texto del último mensaje del usuario', () => {
  assert.equal(Turns.getLastUserPrompt(null), '');
  assert.equal(Turns.getLastUserPrompt([
    { role: 'user', content: 'primero' },
    { role: 'assistant', content: 'respuesta' },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:' } }, { type: 'text', text: 'segundo' }] },
    { role: 'assistant', content: 'otra respuesta' },
    { role: 'tool', content: 'resultado' }
  ]), 'segundo');
});

test('Turns.sanitizeTurnBoundaries - sanea resultados huérfanos y llamadas a herramientas no respondidas', () => {
  const history = [
    { role: 'user', content: 'primero' },
    // 1. Tool huérfano antes de cualquier llamada
    { role: 'tool', tool_call_id: 'call_orphan', name: 'orphan', content: 'descartar' },
    // 2. Assistant con llamada respondida y llamada no respondida
    {
      role: 'assistant',
      content: 'Buscando...',
      tool_calls: [
        { id: 'call_1', function: { name: 'tool_a', arguments: '{}' } },
        { id: 'call_2', function: { name: 'tool_b', arguments: '{}' } }
      ]
    },
    { role: 'tool', tool_call_id: 'call_1', name: 'tool_a', content: 'resultado 1' },
    // 3. Assistant final con llamada no respondida y texto
    {
      role: 'assistant',
      content: 'Texto conservado',
      tool_calls: [{ id: 'call_unanswered', function: { name: 'tool_c', arguments: '{}' } }]
    },
    // 4. Assistant sin texto con llamada no respondida (ej. interrumpido)
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_interrupted', function: { name: 'tool_d', arguments: '{}' } }]
    }
  ];

  const sanitized = Turns.sanitizeTurnBoundaries(history);

  assert.equal(sanitized.length, 4);
  assert.equal(sanitized[0].role, 'user');
  assert.equal(sanitized[1].role, 'assistant');
  // call_2 fue descartada porque no tenía tool message
  assert.deepEqual(sanitized[1].tool_calls.map(c => c.id), ['call_1']);
  assert.equal(sanitized[2].role, 'tool');
  assert.equal(sanitized[2].tool_call_id, 'call_1');
  // call_unanswered fue descartada pero el texto se conserva sin campo tool_calls
  assert.equal(sanitized[3].role, 'assistant');
  assert.equal(sanitized[3].content, 'Texto conservado');
  assert.equal(sanitized[3].tool_calls, undefined);
});

test('Turns.sanitizeTurnBoundaries - cada resultado responde a una sola llamada paralela de la misma herramienta', () => {
  const calls = [
    { id: 'call_a', function: { name: 'search_web', arguments: '{"q":"a"}' } },
    { id: 'call_b', function: { name: 'search_web', arguments: '{"q":"b"}' } },
    { id: 'call_c', function: { name: 'search_web', arguments: '{"q":"c"}' } }
  ];
  const sanitized = Turns.sanitizeTurnBoundaries([
    { role: 'user', content: 'busca' },
    { role: 'assistant', content: null, tool_calls: calls },
    { role: 'tool', tool_call_id: 'call_b', name: 'search_web', content: 'B' },
    { role: 'tool', tool_call_id: 'generated_id', name: 'search_web', content: 'sin id propio' }
  ]);
  assert.deepEqual(sanitized[1].tool_calls.map(c => c.id), ['call_a', 'call_b']);
});
