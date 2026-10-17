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
