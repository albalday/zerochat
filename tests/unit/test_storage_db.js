require('fake-indexeddb/auto');

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('../../js/storage-db.js');
const RagStorage = require('../../js/ragStorage.js');

beforeEach(async () => {
  await RagStorage.clearAllData();
});

after(async () => {
  await Database.closeDatabase();
});

test('ZeroChatDB - crea el esquema compartido completo', async () => {
  const db = await Database.openDatabase();
  assert.deepEqual(Array.from(db.objectStoreNames).sort(), Object.values(Database.STORES).sort());

  const tx = db.transaction([
    Database.STORES.ragDocuments,
    Database.STORES.ragImages,
    Database.STORES.ragChunks
  ], 'readonly');
  assert.ok(tx.objectStore(Database.STORES.ragDocuments).indexNames.contains('by_branchId'));
  assert.ok(tx.objectStore(Database.STORES.ragImages).indexNames.contains('by_branchId'));
  assert.ok(tx.objectStore(Database.STORES.ragChunks).indexNames.contains('by_documentId'));
});

test('ZeroChatDB - conserva imágenes, metadatos y chunks en almacenes separados', async () => {
  const branch = await RagStorage.createBranch('Persistencia real');
  const document = await RagStorage.saveDocument({
    branchId: branch.id,
    title: 'informe.pdf',
    fileType: 'pdf',
    mimeType: 'application/pdf',
    fileSize: 123,
    chunks: [{ title: 'Fragmento', content: 'contenido original' }]
  }, [{ id: 'img_1', dataUrl: 'data:image/jpeg;base64,123' }]);

  assert.equal((await RagStorage.getDocumentImages(document.id))[0].id, 'img_1');
  assert.equal((await RagStorage.getDocumentsByBranch(branch.id))[0].chunkCount, 1);
  assert.equal((await RagStorage.getChunksByDocument(document.id))[0].content, 'contenido original');
});

test('ZeroChatDB - elimina en cascada toda una rama', async () => {
  const branch = await RagStorage.createBranch('Descartable');
  const document = await RagStorage.saveDocument({
    branchId: branch.id,
    title: 'descartable.md',
    fileType: 'md',
    chunks: [{ content: '# Temporal' }]
  });

  await RagStorage.deleteBranch(branch.id);

  assert.equal(await RagStorage.getBranchById(branch.id), null);
  assert.equal(await RagStorage.getDocumentById(document.id), null);
  assert.deepEqual(await RagStorage.getDocumentImages(document.id), []);
  assert.deepEqual(await RagStorage.getChunksByBranch(branch.id), []);
});
