const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const RagStorage = require('../../js/ragStorage.js');
const IngestionEngine = require('../../js/ingestionEngine.js');

beforeEach(async () => {
  await RagStorage.clearAllData();
});

test('Ingestion - detecta duplicado idéntico por ruta y permite ignorarlo', async () => {
  const branch = await RagStorage.createBranch('Rama1');

  // Primer archivo
  const file1 = { name: 'guia.txt', content: 'Contenido original de la guía técnica.' };
  const res1 = await IngestionEngine.processDocumentQueue([file1], branch.id);
  assert.equal(res1.processed, 1);
  assert.equal(res1.skipped, 0);
  assert.equal(res1.replaced, 0);

  // Mismo archivo intentando ingresar de nuevo, con opción ignore
  let conflictCalled = false;
  const file2 = { name: 'guia.txt', content: 'Contenido nuevo diferente pero misma ruta.' };
  const res2 = await IngestionEngine.processDocumentQueue([file2], branch.id, null, {
    onDuplicateConflict: async ({ fullPath }) => {
      conflictCalled = true;
      assert.equal(fullPath, 'guia.txt');
      return { action: 'ignore', applyToAll: false };
    }
  });

  assert.equal(conflictCalled, true);
  assert.equal(res2.processed, 0);
  assert.equal(res2.skipped, 1);
  assert.equal(res2.replaced, 0);

  // Verificar que el documento original sigue intacto
  const docs = await RagStorage.getDocumentsByBranch(branch.id);
  assert.equal(docs.length, 1);
  const chunks = await RagStorage.getChunksByDocument(docs[0].id);
  assert.match(chunks[0].content, /Contenido original/);
});

test('Ingestion - detecta duplicado idéntico por ruta y permite reemplazarlo atómicamente', async () => {
  const branch = await RagStorage.createBranch('Rama2');

  const file1 = { name: 'doc.txt', content: 'Texto versión 1.' };
  await IngestionEngine.processDocumentQueue([file1], branch.id);

  const file2 = { name: 'doc.txt', content: 'Texto versión 2 actualizado.' };
  let conflictCalled = false;
  const res2 = await IngestionEngine.processDocumentQueue([file2], branch.id, null, {
    onDuplicateConflict: async ({ fullPath }) => {
      conflictCalled = true;
      assert.equal(fullPath, 'doc.txt');
      return { action: 'replace', applyToAll: false };
    }
  });

  assert.equal(conflictCalled, true);
  assert.equal(res2.processed, 0);
  assert.equal(res2.replaced, 1);
  assert.equal(res2.skipped, 0);

  // Solo debe haber 1 documento en la rama
  const docs = await RagStorage.getDocumentsByBranch(branch.id);
  assert.equal(docs.length, 1);
  const chunks = await RagStorage.getChunksByDocument(docs[0].id);
  assert.match(chunks[0].content, /Texto versión 2 actualizado/);
});

test('Ingestion - archivos con distinta ruta relativa no son duplicados', async () => {
  const branch = await RagStorage.createBranch('RamaRutas');

  const fileA = { name: 'doc.txt', webkitRelativePath: 'folderA/doc.txt', content: 'Contenido A.' };
  const fileB = { name: 'doc.txt', webkitRelativePath: 'folderB/doc.txt', content: 'Contenido B.' };

  const res = await IngestionEngine.processDocumentQueue([fileA, fileB], branch.id);
  assert.equal(res.processed, 2);
  assert.equal(res.skipped, 0);
  assert.equal(res.replaced, 0);

  const docs = await RagStorage.getDocumentsByBranch(branch.id);
  assert.equal(docs.length, 2);
});

test('Ingestion - casilla applyToAll automatiza respuesta en duplicados restantes', async () => {
  const branch = await RagStorage.createBranch('RamaBatch');

  // Precargar 3 archivos
  const initialFiles = [
    { name: 'file1.txt', content: 'Original 1' },
    { name: 'file2.txt', content: 'Original 2' },
    { name: 'file3.txt', content: 'Original 3' }
  ];
  await IngestionEngine.processDocumentQueue(initialFiles, branch.id);

  // Nueva carga con los 3 duplicados
  let conflictCount = 0;
  const duplicateFiles = [
    { name: 'file1.txt', content: 'Nuevo 1' },
    { name: 'file2.txt', content: 'Nuevo 2' },
    { name: 'file3.txt', content: 'Nuevo 3' }
  ];

  const res = await IngestionEngine.processDocumentQueue(duplicateFiles, branch.id, null, {
    onDuplicateConflict: async () => {
      conflictCount++;
      return { action: 'ignore', applyToAll: true };
    }
  });

  // Solo debe haber preguntado una vez
  assert.equal(conflictCount, 1);
  assert.equal(res.skipped, 3);
  assert.equal(res.processed, 0);
  assert.equal(res.replaced, 0);
});

test('Ingestion - dos archivos idénticos dentro de la misma cola se detectan como duplicado', async () => {
  const branch = await RagStorage.createBranch('RamaCola');

  const queue = [
    { name: 'reporte.txt', content: 'Primer reporte' },
    { name: 'reporte.txt', content: 'Segundo reporte repetido' }
  ];

  let conflictCalled = false;
  const res = await IngestionEngine.processDocumentQueue(queue, branch.id, null, {
    onDuplicateConflict: async () => {
      conflictCalled = true;
      return { action: 'ignore', applyToAll: false };
    }
  });

  assert.equal(conflictCalled, true);
  assert.equal(res.processed, 1);
  assert.equal(res.skipped, 1);

  const docs = await RagStorage.getDocumentsByBranch(branch.id);
  assert.equal(docs.length, 1);
});

test('Ingestion - AbortController detiene la cola y marca cancelados limpiamente', async () => {
  const branch = await RagStorage.createBranch('RamaCancel');
  const controller = new AbortController();

  const files = [
    { name: 'doc1.txt', content: 'Contenido uno.' },
    { name: 'doc2.txt', content: 'Contenido dos.' },
    { name: 'doc3.txt', content: 'Contenido tres.' }
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

