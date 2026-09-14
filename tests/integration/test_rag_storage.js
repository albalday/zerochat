const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const RagStorage = require('../../js/ragStorage.js');

beforeEach(async () => RagStorage.clearAllData());

test('RagStorage - usa el esquema RAG unificado de ZeroChatDB', () => {
  assert.equal(RagStorage.DB_NAME, 'ZeroChatDB');
  assert.equal(RagStorage.DB_VERSION, 4);
  assert.equal(RagStorage.STORE_BRANCHES, 'rag_branches');
  assert.equal(RagStorage.STORE_DOCUMENTS, 'rag_documents');
  assert.equal(RagStorage.STORE_IMAGES, 'rag_images');
  assert.equal(RagStorage.STORE_CHUNKS, 'rag_chunks');
});

test('RagStorage - CRUD de ramas con soporte de idioma', async () => {
  const created = await RagStorage.createBranch('Manuales', 'Documentación técnica', 'english');
  assert.equal(created.name, 'Manuales');
  assert.equal(created.language, 'english');
  assert.equal((await RagStorage.getBranchById(created.id)).language, 'english');

  const updated = await RagStorage.updateBranch(created.id, { name: 'Guías', language: 'french' });
  assert.equal(updated.name, 'Guías');
  assert.equal(updated.language, 'french');
  assert.equal(updated.description, 'Documentación técnica');
});

test('RagStorage - guarda metadatos y chunks por separado sin archivo fuente', async () => {
  const branch = await RagStorage.createBranch('Arquitectura');
  const document = await RagStorage.saveDocument({
    branchId: branch.id,
    title: 'manual.pdf',
    fileType: 'pdf',
    mimeType: 'application/pdf',
    fileSize: 4,
    chunks: [
      { title: 'CPU', content: 'Instalación del procesador LGA1155.', pageStart: 1, pageEnd: 2 },
      { title: 'RAM', content: 'Configuración de memoria DDR3.', pageStart: 3, pageEnd: 3 }
    ]
  });

  const stored = await RagStorage.getDocumentById(document.id);
  assert.equal(stored.chunkCount, 2);
  assert.equal(stored.imageCount, 0);
  assert.equal(stored.chunks, undefined);

  const chunks = await RagStorage.getChunksByDocument(document.id);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].id, `${document.id}:chunk:0`);
  assert.equal(chunks[1].content, 'Configuración de memoria DDR3.');
  assert.equal((await RagStorage.getChunksByBranch(branch.id)).length, 2);
});

test('RagStorage - guarda el número de imágenes como metadato del documento', async () => {
  const branch = await RagStorage.createBranch('Imágenes');
  const document = await RagStorage.saveDocument({
    branchId: branch.id, title: 'informe.pdf', fileType: 'pdf', chunks: [{ content: 'Informe con gráfico.' }]
  }, [{ id: 'img_1' }, { id: 'img_2' }]);

  assert.equal(document.imageCount, 2);
  assert.equal((await RagStorage.getDocumentById(document.id)).imageCount, 2);
});

test('RagStorage - elimina documentos y ramas en cascada', async () => {
  const branch = await RagStorage.createBranch('Temporal');
  const first = await RagStorage.saveDocument({
    branchId: branch.id, title: 'uno.txt', fileType: 'txt', chunks: [{ content: 'Uno' }]
  }, 'Uno');
  await RagStorage.saveDocument({
    branchId: branch.id, title: 'dos.txt', fileType: 'txt', chunks: [{ content: 'Dos' }]
  }, 'Dos');

  assert.equal(await RagStorage.deleteDocument(first.id), true);
  assert.equal(await RagStorage.getChunkById(`${first.id}:chunk:0`), null);
  const result = await RagStorage.deleteBranch(branch.id);
  assert.equal(result.deletedDocumentsCount, 1);
  assert.equal((await RagStorage.getDocumentsByBranch(branch.id)).length, 0);
  assert.equal((await RagStorage.getChunksByBranch(branch.id)).length, 0);
});

test('RagStorage - valida entradas y expone estimación de cuota', async () => {
  await assert.rejects(() => RagStorage.createBranch(''), RagStorage.ValidationError);
  await assert.rejects(() => RagStorage.saveDocument({ title: 'sin-rama.txt' }), RagStorage.ValidationError);
  const estimate = await RagStorage.getStorageEstimate();
  assert.equal(typeof estimate.usage, 'number');
  assert.equal(typeof estimate.usagePercent, 'string');
});

test('RagStorage - exporta e importa únicamente el formato actual', async () => {
  const branch = await RagStorage.createBranch('Respaldo', 'Copia portable');
  await RagStorage.saveDocument({
    branchId: branch.id,
    title: 'notas.txt',
    fileType: 'txt',
    mimeType: 'text/plain',
    fileSize: 5,
    chunks: [{ title: 'Nota', content: 'cinco' }]
  });

  const backup = await RagStorage.exportBranch(branch.id);
  assert.equal(backup.schema, 'zerochat-knowledge');
  assert.equal(backup.version, 2);
  assert.equal(backup.documents[0].source, undefined);

  await RagStorage.clearAllData();
  const restoredBranch = await RagStorage.importBranch(JSON.stringify(backup));
  const restoredDocuments = await RagStorage.getDocumentsByBranch(restoredBranch.id);
  assert.equal(restoredBranch.name, 'Respaldo');
  assert.equal(restoredDocuments.length, 1);
  assert.equal((await RagStorage.getChunksByDocument(restoredDocuments[0].id))[0].content, 'cinco');

  await assert.rejects(
    () => RagStorage.importBranch({ schema: 'unsupported-format', version: 99, branch: {}, documents: [] }),
    RagStorage.ValidationError
  );
});

test('RagStorage - exportBranchBlob genera un respaldo comprimido gzip en streaming', async () => {
  const branch = await RagStorage.createBranch('GzipTest');
  await RagStorage.saveDocument({
    branchId: branch.id,
    title: 'large-doc.txt',
    fileType: 'txt',
    chunks: [
      { order: 0, title: 'Parte 1', content: 'Contenido extenso de prueba para compresión gzip.' }
    ]
  }, 'contenido original de prueba');

  const { blob, compressed, filename } = await RagStorage.exportBranchBlob(branch.id, { compress: true });
  assert.equal(compressed, true);
  assert.ok(filename.endsWith('.zerochat-knowledge.json.gz'));
  assert.ok(blob.size > 0);

  // Descomprimir el blob para verificar su estructura
  const ds = new DecompressionStream('gzip');
  const decompressedText = await new Response(blob.stream().pipeThrough(ds)).text();
  const parsed = JSON.parse(decompressedText);
  assert.equal(parsed.schema, 'zerochat-knowledge');
  assert.equal(parsed.documents.length, 1);
  assert.equal(parsed.documents[0].chunks[0].content, 'Contenido extenso de prueba para compresión gzip.');

  // Probar importación tras limpiar datos
  await RagStorage.clearAllData();
  const restored = await RagStorage.importBranch(decompressedText);
  assert.equal(restored.name, 'GzipTest');
  const docs = await RagStorage.getDocumentsByBranch(restored.id);
  assert.equal(docs.length, 1);
});

test('RagStorage - exporta e importa información de imágenes y reasigna referencias en chunks', async () => {
  const branch = await RagStorage.createBranch('ImagesTest');
  await RagStorage.saveDocument({
    id: 'doc_original',
    branchId: branch.id,
    title: 'doc-with-image.pdf',
    fileType: 'pdf',
    chunks: [
      { order: 0, title: 'Sección con gráfico', content: 'Aquí está el balance: ![Balance](rag-image://doc_original:img_1)' }
    ]
  }, [
    { id: 'img_1', page: 1, mimeType: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,1234', label: 'Balance' }
  ]);

  let progressCalled = false;
  const { blob } = await RagStorage.exportBranchBlob(branch.id, {
    compress: true,
    onProgress: (p) => {
      if (p.percent === 100) progressCalled = true;
    }
  });
  assert.ok(progressCalled);

  const ds = new DecompressionStream('gzip');
  const decompressedText = await new Response(blob.stream().pipeThrough(ds)).text();
  const parsed = JSON.parse(decompressedText);
  assert.equal(parsed.documents[0].imageCount, 1);
  assert.equal(parsed.documents[0].images.length, 1);
  assert.equal(parsed.documents[0].images[0].id, 'img_1');

  // Restaurar en una nueva rama sin borrar la anterior (provocará asignación de nuevo document.id)
  const restoredBranch = await RagStorage.importBranch(decompressedText);
  const restoredDocs = await RagStorage.getDocumentsByBranch(restoredBranch.id);
  assert.equal(restoredDocs.length, 1);
  assert.equal(restoredDocs[0].imageCount, 1);

  // Las imágenes deben haberse guardado para el nuevo documento
  const restoredImages = await RagStorage.getDocumentImages(restoredDocs[0].id);
  assert.equal(restoredImages.length, 1);
  assert.equal(restoredImages[0].dataUrl, 'data:image/jpeg;base64,1234');

  // Los chunks deben haber reasignado la referencia de imagen al nuevo ID de documento
  const restoredChunks = await RagStorage.getChunksByDocument(restoredDocs[0].id);
  assert.ok(restoredChunks[0].content.includes(`rag-image://${restoredDocs[0].id}:img_1`));
});

test('RagStorage - getChunkById resuelve alias comunes generados por LLMs (docId#0, docId:0)', async () => {
  const branch = await RagStorage.createBranch('AliasTest');
  const doc = await RagStorage.saveDocument({
    branchId: branch.id,
    title: 'doc.txt',
    fileType: 'txt',
    chunks: [
      { order: 0, title: 'Sección 0', content: 'Contenido sección 0' },
      { order: 1, title: 'Sección 1', content: 'Contenido sección 1' }
    ]
  }, 'doc');

  // Consulta por ID canónico
  const c0 = await RagStorage.getChunkById(`${doc.id}:chunk:0`);
  assert.equal(c0.content, 'Contenido sección 0');

  // Consulta por alias con almohadilla: doc_id#0
  const c0Hash = await RagStorage.getChunkById(`${doc.id}#0`);
  assert.ok(c0Hash);
  assert.equal(c0Hash.content, 'Contenido sección 0');

  // Consulta por alias doc_id#1
  const c1Hash = await RagStorage.getChunkById(`${doc.id}#1`);
  assert.ok(c1Hash);
  assert.equal(c1Hash.content, 'Contenido sección 1');

  // Consulta pasando directamente el documentId
  const cDoc = await RagStorage.getChunkById(doc.id);
  assert.ok(cDoc);
  assert.equal(cDoc.content, 'Contenido sección 0');
});
