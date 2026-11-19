const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const RagStorage = require('../../js/ragStorage.js');
const IngestionEngine = require('../../js/ingestionEngine.js');
const { toFile } = require('../helpers/files.js');
const { clearRagData } = require('../helpers/rag-data.js');

beforeEach(async () => {
  await clearRagData();
});

test('Ingestion - gestiona duplicados por ruta con ignore, replace, applyToAll y en la misma cola', async () => {
  // 1. Duplicado previo: ignore y replace
  const branch = await RagStorage.createBranch('Rama1');
  const first = await IngestionEngine.processDocumentQueue([toFile({ name: 'guia.txt', content: 'Contenido v1.' })], branch.id);
  assert.equal(first.processed, 1);

  const ignored = await IngestionEngine.processDocumentQueue(
    [toFile({ name: 'guia.txt', content: 'Contenido distinto.' })],
    branch.id,
    null,
    {
      onDuplicateConflict: async ({ fullPath }) => {
        assert.equal(fullPath, 'guia.txt');
        return { action: 'ignore', applyToAll: false };
      }
    }
  );
  assert.deepEqual([ignored.processed, ignored.skipped, ignored.replaced], [0, 1, 0]);
  let docs = await RagStorage.getDocumentsByBranch(branch.id);
  assert.match((await RagStorage.getChunksByDocument(docs[0].id))[0].content, /Contenido v1/);

  const replaced = await IngestionEngine.processDocumentQueue(
    [toFile({ name: 'guia.txt', content: 'Contenido v2.' })],
    branch.id,
    null,
    { onDuplicateConflict: async () => ({ action: 'replace', applyToAll: false }) }
  );
  assert.deepEqual([replaced.processed, replaced.skipped, replaced.replaced], [0, 0, 1]);
  docs = await RagStorage.getDocumentsByBranch(branch.id);
  assert.equal(docs.length, 1);
  assert.match((await RagStorage.getChunksByDocument(docs[0].id))[0].content, /Contenido v2/);

  // 2. applyToAll solo pregunta una vez en lote de múltiples duplicados
  const batchBranch = await RagStorage.createBranch('RamaBatch');
  await IngestionEngine.processDocumentQueue([
    toFile({ name: 'f1.txt', content: 'O1' }),
    toFile({ name: 'f2.txt', content: 'O2' }),
    toFile({ name: 'f3.txt', content: 'O3' })
  ], batchBranch.id);
  let promptCount = 0;
  const batchRes = await IngestionEngine.processDocumentQueue([
    toFile({ name: 'f1.txt', content: 'N1' }),
    toFile({ name: 'f2.txt', content: 'N2' }),
    toFile({ name: 'f3.txt', content: 'N3' })
  ], batchBranch.id, null, {
    onDuplicateConflict: async () => { promptCount++; return { action: 'ignore', applyToAll: true }; }
  });
  assert.equal(promptCount, 1);
  assert.deepEqual([batchRes.processed, batchRes.skipped, batchRes.replaced], [0, 3, 0]);

  // 3. Dos archivos con el mismo nombre dentro de la misma cola
  const queueBranch = await RagStorage.createBranch('RamaCola');
  let queuePrompted = false;
  const queueRes = await IngestionEngine.processDocumentQueue([
    toFile({ name: 'reporte.txt', content: 'Primero' }),
    toFile({ name: 'reporte.txt', content: 'Segundo' })
  ], queueBranch.id, null, {
    onDuplicateConflict: async () => { queuePrompted = true; return { action: 'ignore', applyToAll: false }; }
  });
  assert.equal(queuePrompted, true);
  assert.deepEqual([queueRes.processed, queueRes.skipped], [1, 1]);
  assert.equal((await RagStorage.getDocumentsByBranch(queueBranch.id)).length, 1);
});

test('Ingestion - AbortController detiene la cola y marca cancelados limpiamente', async () => {
  const branch = await RagStorage.createBranch('RamaCancel');
  const controller = new AbortController();

  const files = [
    toFile({ name: 'doc1.txt', content: 'Contenido uno.' }),
    toFile({ name: 'doc2.txt', content: 'Contenido dos.' }),
    toFile({ name: 'doc3.txt', content: 'Contenido tres.' })
  ];

  const events = [];
  const res = await IngestionEngine.processDocumentQueue(files, branch.id, event => {
    events.push(event);
    if (event.status === 'completed' && event.fileName === 'doc1.txt') {
      controller.abort();
    }
  }, { signal: controller.signal });

  assert.equal(res.processed, 1);
  assert.equal(res.cancelled, 2);

  // Solo debe haberse guardado doc1
  const docs = await RagStorage.getDocumentsByBranch(branch.id);
  assert.equal(docs.length, 1);
  assert.equal(docs[0].title, 'doc1.txt');

  // Verificar eventos de cancelación
  const cancelledEvents = events.filter(e => e.status === 'cancelled');
  assert.equal(cancelledEvents.length, 2);
});

