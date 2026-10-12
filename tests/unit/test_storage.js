const { test } = require('node:test');
const assert = require('node:assert/strict');
const Storage = require('../../js/storage.js');

test('Storage - guarda, lee y borra valores con el prefijo de ZeroChat', () => {
  Storage.setStorageItem('test_key', 'test_value');
  assert.equal(Storage.getStorageItem('test_key'), 'test_value');
  assert.equal(localStorage.getItem('zerochat_test_key'), 'test_value');

  Storage.deleteStorageItem('test_key');
  const valDeleted = Storage.getStorageItem('test_key');
  assert.equal(valDeleted, null);
});

test('Storage - persiste exclusivamente el documento de configuración operativa', () => {
  const config = { model: 'custom-test-model', enabledTools: { search_web: false } };
  Storage.saveRuntimeConfigV2(config);
  const loaded = Storage.loadRuntimeConfigV2();
  assert.deepEqual(loaded, config);
  loaded.enabledTools.search_web = true;
  assert.equal(Storage.loadRuntimeConfigV2().enabledTools.search_web, false);
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

test('Storage - el borrado completo solo elimina claves y cookies propias de ZeroChat', async () => {
  localStorage.setItem('zerochat_language', 'es');
  localStorage.setItem('otra_app_token', 'x');
  sessionStorage.setItem('zerochat_tmp', '1');
  sessionStorage.setItem('otra_app_estado', '2');
  const writtenCookies = [];
  const descriptors = {
    document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
    location: Object.getOwnPropertyDescriptor(globalThis, 'location')
  };
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { protocol: 'http:' } });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      get cookie() { return 'zerochat_backend_session_v1=abc; otra_app_sesion=def'; },
      set cookie(value) { writtenCookies.push(value); }
    }
  });
  try {
    assert.equal(await Storage.clearAllStorage(), true, Storage.getLastClearAllStorageError());
    assert.equal(localStorage.getItem('zerochat_language'), null);
    assert.equal(localStorage.getItem('otra_app_token'), 'x');
    assert.equal(sessionStorage.getItem('zerochat_tmp'), null);
    assert.equal(sessionStorage.getItem('otra_app_estado'), '2');
    assert.equal(writtenCookies.length, 1);
    assert.match(writtenCookies[0], /^zerochat_backend_session_v1=;Max-Age=0;/);
  } finally {
    for (const [name, descriptor] of Object.entries(descriptors)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
    localStorage.removeItem('otra_app_token');
    sessionStorage.removeItem('otra_app_estado');
  }
});

test('Storage - avisa si localStorage rechaza la escritura', t => {
  t.mock.method(localStorage, 'setItem', () => { throw new Error('QuotaExceededError'); });
  t.mock.method(console, 'warn', () => {});
  Storage.setStorageItem('quota_key', 'value');
  assert.equal(console.warn.mock.callCount(), 1);
  assert.match(String(console.warn.mock.calls[0].arguments[0]), /quota_key/);
  assert.equal(Storage.getStorageItem('quota_key'), null);
});
