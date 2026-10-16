const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('../../js/storage-db.js');
const Storage = require('../../js/storage.js');

test('Full reset deletes ZeroChat RAG data and model caches without deleting unrelated databases', async () => {
  const db = await Database.openDatabase();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(Database.STORES.ragDocuments, 'readwrite');
    tx.objectStore(Database.STORES.ragDocuments).put({ id: 'document', content: 'test' });
    tx.oncomplete = resolve;
    tx.onerror = reject;
  });
  await new Promise(resolve => {
    const request = indexedDB.open('unrelated-file-origin-database');
    request.onsuccess = () => { request.result.close(); resolve(); };
  });
  const originalCaches = global.caches;
  const deleted = [];
  global.caches = { keys: async () => ['webllm/model', 'webllm/wasm'], delete: async name => { deleted.push(name); return true; } };
  try {
    assert.equal(await Storage.clearAllStorage(), true);
    assert.deepEqual(await indexedDB.databases(), [{ name: 'unrelated-file-origin-database', version: 1 }]);
    assert.deepEqual(deleted.sort(), ['webllm/model', 'webllm/wasm']);
  } finally {
    global.caches = originalCaches;
    await Database.closeDatabase();
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase('unrelated-file-origin-database');
      request.onsuccess = resolve;
      request.onerror = () => reject(request.error);
    });
  }
});

test('Full reset reports cache failure while still deleting IndexedDB', async () => {
  await Database.openDatabase();
  const originalCaches = global.caches;
  global.caches = { keys: async () => { throw new Error('Storage denied'); } };
  try {
    assert.equal(await Storage.clearAllStorage(), false);
    assert.match(Storage.getLastClearAllStorageError(), /^Cache Storage: Storage denied$/);
    assert.deepEqual(await indexedDB.databases(), []);
  } finally { global.caches = originalCaches; }
});

test('Full reset ignores an unavailable Service Worker API on file origins', async () => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(global, 'navigator');
  Object.defineProperty(global, 'navigator', {
    configurable: true,
    value: {
      serviceWorker: {
        getRegistrations: async () => {
          throw new Error("Failed to get ServiceWorkerRegistration objects: The URL protocol of the current origin ('null') is not supported.");
        }
      }
    }
  });
  try {
    assert.equal(await Storage.clearAllStorage(), true);
  } finally {
    if (navigatorDescriptor) Object.defineProperty(global, 'navigator', navigatorDescriptor);
    else delete global.navigator;
  }
});

test('DataResetService - tras confirmar detiene la generación, borra los datos y recarga', async t => {
  const DataResetService = require('../../js/data-reset-service.js');
  const GenerationController = require('../../js/generation-controller.js');
  const { installDom } = require('../helpers/dom-env.js');
  const dom = installDom();
  const calls = [];
  const alerts = [];
  const previousDialogs = globalThis.ChatDialogs;
  globalThis.ChatDialogs = { confirm: async () => true, alert: async message => { alerts.push(message); } };
  t.mock.method(dom.window.location, 'reload', () => calls.push('reload'));
  t.mock.method(GenerationController, 'handleStopGeneration', () => calls.push('stop'));
  t.mock.method(Storage, 'clearAllStorage', async () => { calls.push('clear'); return true; });
  try {
    assert.deepEqual(await DataResetService.resetAllData(), { confirmed: true, success: true });
    assert.deepEqual(calls, ['stop', 'clear', 'reload']);
    assert.deepEqual(alerts, []);
  } finally {
    if (previousDialogs === undefined) delete globalThis.ChatDialogs;
    else globalThis.ChatDialogs = previousDialogs;
    dom.restore();
  }
});

test('DataResetService - cancelar no toca nada', async t => {
  const DataResetService = require('../../js/data-reset-service.js');
  const { installDom } = require('../helpers/dom-env.js');
  const dom = installDom();
  const calls = [];
  const previousDialogs = globalThis.ChatDialogs;
  globalThis.ChatDialogs = { confirm: async () => false, alert: async () => {} };
  try {
    assert.deepEqual(await DataResetService.resetAllData(), { confirmed: false, success: false });
    assert.deepEqual(calls, []);
  } finally {
    if (previousDialogs === undefined) delete globalThis.ChatDialogs;
    else globalThis.ChatDialogs = previousDialogs;
    dom.restore();
  }
});

test('DataResetService - si el borrado falla avisa con el motivo y no recarga', async t => {
  const DataResetService = require('../../js/data-reset-service.js');
  const GenerationController = require('../../js/generation-controller.js');
  const I18n = require('../../js/i18n.js');
  const { installDom } = require('../helpers/dom-env.js');
  const dom = installDom();
  const calls = [];
  const alerts = [];
  const previousDialogs = globalThis.ChatDialogs;
  globalThis.ChatDialogs = { confirm: async () => true, alert: async message => { alerts.push(message); } };
  t.mock.method(dom.window.location, 'reload', () => calls.push('reload'));
  t.mock.method(GenerationController, 'handleStopGeneration', () => calls.push('stop'));
  t.mock.method(Storage, 'clearAllStorage', async () => { calls.push('clear'); return false; });
  t.mock.method(Storage, 'getLastClearAllStorageError', () => 'IndexedDB blocked');
  try {
    const result = await DataResetService.resetAllData();
    assert.deepEqual(result, { confirmed: true, success: false, error: 'IndexedDB blocked' });
    assert.deepEqual(calls, ['stop', 'clear']);
    assert.deepEqual(alerts, [I18n.t('clear_all_data_failed_detail', { detail: 'IndexedDB blocked' })]);
  } finally {
    if (previousDialogs === undefined) delete globalThis.ChatDialogs;
    else globalThis.ChatDialogs = previousDialogs;
    dom.restore();
  }
});
