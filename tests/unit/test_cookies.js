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
