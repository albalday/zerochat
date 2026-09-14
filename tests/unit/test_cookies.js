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
