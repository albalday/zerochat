const { test } = require('node:test');
const assert = require('node:assert/strict');
const Providers = require('../js/providers.js');
const WebLLM = require('../js/providers-webllm.js');
const Inspector = require('../js/ui-inspector.js');
const Profiles = require('../js/ui-profiles.js');
const Storage = require('../js/cookies.js');

test('Completed-model queries share validation and observe storage changes without loading WebLLM', () => {
  const previousStorage = global.ChatStorage;
  let raw = '["ready",7,null,"ready"]';
  global.ChatStorage = { getStorageItem: () => raw };
  try {
    for (const query of [WebLLM.getCompletedModelIds, Inspector.getWebLLMCompletedModelIds]) {
      assert.deepEqual(query(), ['ready']);
    }
    assert.equal(Profiles.isDownloadedWebLLMModel('ready'), true);
    assert.equal(Profiles.isDownloadedWebLLMModel('partial'), false);
    for (const invalid of ['broken JSON', '{}', 'null', '[]']) {
      raw = invalid;
      assert.deepEqual(Inspector.getWebLLMCompletedModelIds(), []);
      assert.equal(Profiles.isDownloadedWebLLMModel('ready'), false);
    }
    global.ChatStorage.getStorageItem = () => { throw new Error('Storage unavailable'); };
    assert.deepEqual(Inspector.getWebLLMCompletedModelIds(), []);
    assert.equal(Profiles.isDownloadedWebLLMModel('ready'), false);
  } finally {
    if (previousStorage === undefined) delete global.ChatStorage;
    else global.ChatStorage = previousStorage;
  }
});

test('Completed-model queries retain the module fallback when the adapter is unavailable in Node', () => {
  const originalGet = Providers.registry.get;
  const previousStorage = global.ChatStorage;
  const previousValue = Storage.getStorageItem(WebLLM.COMPLETED_MODELS_STORAGE_KEY);
  Providers.registry.get = () => null;
  delete global.ChatStorage;
  Storage.setStorageItem(WebLLM.COMPLETED_MODELS_STORAGE_KEY, '["offline-model"]');
  try {
    assert.deepEqual(Inspector.getWebLLMCompletedModelIds(), ['offline-model']);
    assert.equal(Profiles.isDownloadedWebLLMModel('offline-model'), true);
  } finally {
    Providers.registry.get = originalGet;
    if (previousStorage !== undefined) global.ChatStorage = previousStorage;
    if (previousValue == null) Storage.deleteStorageItem(WebLLM.COMPLETED_MODELS_STORAGE_KEY);
    else Storage.setStorageItem(WebLLM.COMPLETED_MODELS_STORAGE_KEY, previousValue);
  }
});

test('Completed-model queries honor a registered adapter instead of reading fallback storage', () => {
  const originalGet = Providers.registry.get;
  Providers.registry.get = () => ({
    getCompletedModelIds: () => ['adapter-model'],
    isModelCompleted: id => id === 'adapter-model'
  });
  try {
    assert.deepEqual(Inspector.getWebLLMCompletedModelIds(), ['adapter-model']);
    assert.equal(Profiles.isDownloadedWebLLMModel('adapter-model'), true);
    assert.equal(Profiles.isDownloadedWebLLMModel('other'), false);
  } finally { Providers.registry.get = originalGet; }
});
