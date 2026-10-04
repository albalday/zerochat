const { test } = require('node:test');
const assert = require('node:assert/strict');
const Storage = require('../../js/cookies.js');

test('Storage - Guardar y recuperar valores en memoria/storage', () => {
  Storage.setStorageItem('test_key', 'test_value');
  const val = Storage.getStorageItem('test_key');
  assert.equal(val, 'test_value');

  Storage.deleteStorageItem('test_key');
  const valDeleted = Storage.getStorageItem('test_key');
  assert.equal(valDeleted, null);
});

test('Storage - persiste exclusivamente el documento de configuración operativa', () => {
  const config = { schemaVersion: 2, model: 'custom-test-model', enabledTools: { search_web: false } };
  Storage.saveRuntimeConfigV2(config);
  const loaded = Storage.loadRuntimeConfigV2();
  assert.deepEqual(loaded, config);
  loaded.enabledTools.search_web = true;
  assert.equal(Storage.loadRuntimeConfigV2().enabledTools.search_web, false);
});

test('Storage - alias heredados conservan compatibilidad hacia atrás', () => {
  Storage.setCookie('legacy_key', 'legacy_val');
  assert.equal(Storage.getCookie('legacy_key'), 'legacy_val');
  Storage.deleteCookie('legacy_key');
  assert.equal(Storage.getCookie('legacy_key'), null);
});

test('Storage - valida el contrato restrictivo de la sesión del backend local', () => {
  assert.deepEqual(
    Storage.normalizeBackendSession({ token: 'token_seguro-123', host: 'LOCALHOST', port: '6388' }),
    { token: 'token_seguro-123', host: 'localhost', port: 6388 }
  );
  assert.equal(Storage.normalizeBackendSession({ token: '', host: '127.0.0.1', port: 6388 }), null);
  assert.equal(Storage.normalizeBackendSession({ token: ' token ', host: '127.0.0.1', port: 6388 }), null);
  assert.equal(Storage.normalizeBackendSession({ token: 'token', host: 'example.test', port: 6388 }), null);
  assert.equal(Storage.normalizeBackendSession({ token: 'token', host: '127.0.0.1', port: 0 }), null);
  assert.equal(Storage.normalizeBackendSession({ token: 'token', host: '127.0.0.1', port: 65536 }), null);
});

function createMemoryWebStorage(entries) {
  const data = new Map(Object.entries(entries));
  return {
    get length() { return data.size; },
    key: index => [...data.keys()][index] ?? null,
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: key => data.delete(key),
    clear: () => data.clear(),
    keys: () => [...data.keys()].sort()
  };
}

test('Storage - el borrado completo solo elimina claves y cookies propias de ZeroChat', async () => {
  assert.equal(Storage.isOwnedStorageKey('zerochat_profiles_v1'), true);
  assert.equal(Storage.isOwnedStorageKey('zc_tool_security_v3'), true);
  assert.equal(Storage.isOwnedStorageKey('chat_mcp_servers'), true);
  assert.equal(Storage.isOwnedStorageKey('otra_app_token'), false);

  const local = createMemoryWebStorage({ zerochat_language: 'es', zc_tool_security_v3: '{}', chat_mcp_servers: '[]', otra_app_token: 'x' });
  Storage.removeOwnedStorageKeys(local);
  assert.deepEqual(local.keys(), ['otra_app_token']);

  const session = createMemoryWebStorage({ zerochat_tmp: '1', otra_app_estado: '2' });
  const writtenCookies = [];
  const descriptors = {
    sessionStorage: Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'),
    document: Object.getOwnPropertyDescriptor(globalThis, 'document')
  };
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: session });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      get cookie() { return 'zerochat_backend_session_v1=abc; otra_app_sesion=def'; },
      set cookie(value) { writtenCookies.push(value); }
    }
  });
  try {
    await Storage.clearAllStorage();
    assert.deepEqual(session.keys(), ['otra_app_estado']);
    assert.ok(writtenCookies.length > 0);
    assert.ok(writtenCookies.every(value => value.startsWith('zerochat_backend_session_v1=;')), writtenCookies.join('\n'));
  } finally {
    for (const [name, descriptor] of Object.entries(descriptors)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});

test('Storage - avisa si localStorage rechaza la escritura y conserva el valor en memoria', (t) => {
  const modulePath = require.resolve('../../js/cookies.js');
  const originalLocalStorage = global.localStorage;
  global.localStorage = {
    setItem: key => { if (key !== '__zerochat_test__') throw new Error('QuotaExceededError'); },
    removeItem: () => {},
    getItem: () => null
  };
  delete require.cache[modulePath];
  t.mock.method(console, 'warn', () => {});
  try {
    const FreshStorage = require('../../js/cookies.js');
    FreshStorage.setStorageItem('quota_key', 'value');

    assert.equal(console.warn.mock.callCount(), 1);
    assert.match(String(console.warn.mock.calls[0].arguments[0]), /quota_key/);
    assert.equal(FreshStorage.getStorageItem('quota_key'), 'value');
  } finally {
    if (originalLocalStorage === undefined) delete global.localStorage;
    else global.localStorage = originalLocalStorage;
    delete require.cache[modulePath];
  }
});
