const test = require('node:test');
const assert = require('node:assert/strict');
const RunMode = require('../../js/run-mode.js');

test('RunMode.readRunId solo acepta un identificador válido del fragmento de arranque', () => {
  const valid = 'a'.repeat(16);
  const rows = [
    [`#token=t&host=127.0.0.1&port=1&run=${valid}`, valid],
    [`#run=${'b'.repeat(128)}`, 'b'.repeat(128)],
    [`#run=${'b'.repeat(129)}`, null],
    [`#run=${'a'.repeat(15)}`, null],
    ['#run=abcdefghijklmnop%3Cscript', null],
    ['#token=t', null],
    ['', null]
  ];
  for (const [hash, expected] of rows) assert.equal(RunMode.readRunId(hash), expected, hash);
});

test('RunMode.createProgressReporter limita el streaming al intervalo y envía siempre el resto', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 10_000 });
  const sent = [];
  const report = RunMode.createProgressReporter(event => sent.push(event.text));
  report({ kind: 'stream', text: 's1' });
  report({ kind: 'tool', text: 'tool' });
  t.mock.timers.tick(1999);
  report({ kind: 'stream', text: 's2' });
  t.mock.timers.tick(1);
  report({ kind: 'stream', text: 's3' });
  report({ kind: 'status', text: 'status' });
  assert.deepEqual(sent, ['s1', 'tool', 's3', 'status']);
});

test('RunMode.pendingAskUserQuestion toma la pregunta de ask_user de los mensajes tool del final del turno', () => {
  const askCall = (id, question) => ({ id, type: 'function', function: { name: 'ask_user', arguments: JSON.stringify({ question, options: ['A', 'B'] }) } });
  const readCall = { id: 'r1', type: 'function', function: { name: 'read_file', arguments: '{}' } };
  const tool = (id, name) => ({ role: 'tool', tool_call_id: id, name, content: '{}' });
  const user = { role: 'user', content: 'hola' };
  const rows = [
    [[user, { role: 'assistant', tool_calls: [askCall('a1', ' ¿Sigo? ')] }, tool('a1', 'ask_user')], '¿Sigo?'],
    // Varias herramientas en el mismo paso: ask_user no tiene que ser la última.
    [[user, { role: 'assistant', tool_calls: [askCall('a1', '¿Cuál?'), readCall] }, tool('a1', 'ask_user'), tool('r1', 'read_file')], '¿Cuál?'],
    // Un ask_user de un turno anterior, ya contestado, no cuenta.
    [[user, { role: 'assistant', tool_calls: [askCall('a1', '¿Cuál?')] }, tool('a1', 'ask_user'), user, { role: 'assistant', content: 'Hecho' }], null],
    [[user, { role: 'assistant', tool_calls: [readCall] }, tool('r1', 'read_file')], null],
    [[user, { role: 'assistant', tool_calls: [{ id: 'a1', function: { name: 'ask_user', arguments: 'no json' } }] }, tool('a1', 'ask_user')], 'ask_user'],
    [[], null]
  ];
  for (const [messages, expected] of rows) assert.equal(RunMode.pendingAskUserQuestion(messages), expected, JSON.stringify(messages));
});

test('RunMode.answerToolApprovals permite para la sesión salvo las herramientas peligrosas sin --allow-dangerous-tools', t => {
  const ToolCards = require('../../js/tool-cards.js');
  let responder = null;
  t.mock.method(ToolCards, 'setAuthorizationResponder', fn => { responder = fn; });
  for (const [allowDangerous, expected] of [
    [false, [['read_file', 'allow_session'], ['run_command', 'deny'], ['write_file', 'deny'], ['edit_file', 'deny']]],
    [true, [['read_file', 'allow_session'], ['run_command', 'allow_session'], ['write_file', 'allow_session'], ['edit_file', 'allow_session']]]
  ]) {
    const events = [];
    RunMode.answerToolApprovals(allowDangerous, event => events.push(event));
    assert.deepEqual(expected.map(([name]) => [name, responder(name)]), expected);
    assert.deepEqual(events, expected.map(([name, decision]) => ({ kind: decision === 'deny' ? 'approval_denied' : 'approval_allowed', text: name })));
  }
});
