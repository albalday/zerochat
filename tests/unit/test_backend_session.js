const test = require('node:test');
const assert = require('node:assert/strict');
const BackendSession = require('../../js/backend-session.js');

test('BackendSession.parseLaunchSession solo adopta un servidor de este equipo con puerto válido', () => {
  const rows = [
    ['#token=t&host=127.0.0.1&port=6883', { session: { token: 't', url: 'http://127.0.0.1:6883' }, run: false }],
    ['#token=t&host=localhost&port=65535&run=x', { session: { token: 't', url: 'http://localhost:65535' }, run: true }],
    ['#token=t&host=127.0.0.1&port=1', { session: { token: 't', url: 'http://127.0.0.1:1' }, run: false }],
    ['#token=t&host=127.0.0.1&port=0', { session: null, run: false }],
    ['#token=t&host=127.0.0.1&port=65536', { session: null, run: false }],
    ['#token=t&host=127.0.0.1&port=80.5', { session: null, run: false }],
    ['#token=t&host=evil.example&port=6883', { session: null, run: false }],
    ['#token=t&host=127.0.0.2&port=6883&run=x', { session: null, run: true }],
    ['#host=127.0.0.1&port=6883', null],
    ['', null]
  ];
  for (const [hash, expected] of rows) {
    assert.deepEqual(BackendSession.parseLaunchSession(hash), expected, hash);
  }
});
