const test = require('node:test');
const assert = require('node:assert/strict');
const ModelCatalog = require('../../js/model-catalog.js');
const Storage = require('../../js/storage.js');

test.beforeEach(() => localStorage.clear());

test('ModelCatalog - guarda los modelos por conexión y da su contexto con la conexión cargada', () => {
  const local = { apiType: 'openai', apiUrl: 'http://localhost:1234/v1/' };
  ModelCatalog.save([{ id: 'qwen', details: { loaded_context_length: 32768 } }], local);
  ModelCatalog.save([{ id: 'qwen', details: { context_length: 131072 } }], { apiType: 'openai', apiUrl: 'https://api.example.test/v1' });

  // La misma conexión con otra barra final o mayúsculas comparte caché.
  assert.deepEqual(ModelCatalog.load({ apiType: 'OpenAI', apiUrl: 'HTTP://localhost:1234/v1' }).map(model => model.id), ['qwen']);
  assert.equal(ModelCatalog.getContextLimit('qwen'), 32768);
  assert.deepEqual(ModelCatalog.load({ apiType: 'anthropic', apiUrl: local.apiUrl }), []);
  assert.equal(ModelCatalog.getContextLimit('qwen'), null);
});

test('ModelCatalog - una caché ilegible o de otra versión se borra', () => {
  for (const raw of ['{no es json', JSON.stringify({ version: 0, connections: { 'openai:http://x': [{ id: 'viejo' }] } })]) {
    Storage.setStorageItem('cached_models', raw);
    assert.deepEqual(ModelCatalog.load({ apiType: 'openai', apiUrl: 'http://x' }), []);
    assert.equal(Storage.getStorageItem('cached_models'), null);
  }
});
