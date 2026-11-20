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
  assert.equal(BackendSession.parseLaunchProject('?project=%2Frepo%2Fb'), '/repo/b');
  assert.equal(BackendSession.parseLaunchProject('?foo=1&project=%20%2Frepo%2Fa%20'), '/repo/a');
  assert.equal(BackendSession.parseLaunchProject(''), '');
});

test('BackendSession.sessionConnection usa la sesión guardada y la clave del proxy solo si es del destino configurado', () => {
  const LOCAL = 'http://127.0.0.1:6388';
  const remote = { localBackend: false, backendUrl: 'https://casa.example.org/', useProxy: true, proxyKey: '  clave  ' };
  assert.equal(BackendSession.sessionConnection(null, remote, LOCAL), null);
  assert.deepEqual(BackendSession.sessionConnection({ url: 'https://casa.example.org', token: 'tok' }, remote, LOCAL),
    { url: 'https://casa.example.org', token: 'tok', proxyKey: 'clave' });
  // Una sesión de otro servidor no recibe la clave del proxy configurado.
  assert.deepEqual(BackendSession.sessionConnection({ url: LOCAL, token: 'tok' }, remote, LOCAL), { url: LOCAL, token: 'tok', proxyKey: null });
  // Sin configuración guardada, el destino es el servidor local.
  assert.deepEqual(BackendSession.connectionTarget({}, LOCAL), { url: LOCAL, proxyKey: null });
  assert.deepEqual(BackendSession.connectionTarget({ ...remote, useProxy: false }, LOCAL), { url: 'https://casa.example.org', proxyKey: null });
});

test('BackendSession.connectConfigured solo recarga sesiones cuando la conexión tiene éxito', async () => {
  let loadCalls = 0;
  let connectResult = { success: false, status: 401 };
  const prev = {
    ChatStorage: global.ChatStorage,
    ChatConfig: global.ChatConfig,
    ChatDefaults: global.ChatDefaults,
    ChatMCP: global.ChatMCP
  };
  global.ChatStorage = { getBackendSession: () => null };
  global.ChatConfig = { getActive: () => ({}) };
  global.ChatDefaults = { LOCAL_BACKEND_URL: 'http://127.0.0.1:6388' };
  global.ChatMCP = {
    manager: {
      setSessionToken() {},
      connectProxy: async () => connectResult
    }
  };
  try {
    const session = BackendSession.create({
      loadSessions: async () => { loadCalls += 1; }
    });
    await session.connectConfigured();
    assert.equal(loadCalls, 0);
    connectResult = { success: true };
    await session.connectConfigured();
    assert.equal(loadCalls, 1);
  } finally {
    Object.assign(global, prev);
  }
});
