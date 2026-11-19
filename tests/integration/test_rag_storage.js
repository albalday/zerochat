const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const RagStorage = require('../../js/ragStorage.js');
const { clearRagData } = require('../helpers/rag-data.js');

beforeEach(clearRagData);

test('RagStorage - guarda, consulta por alias, elimina en cascada y valida entradas', async () => {
  await assert.rejects(() => RagStorage.createBranch(''), { name: 'ValidationError' });
  const branch = await RagStorage.createBranch('Arquitectura');
  await assert.rejects(() => RagStorage.saveDocument({ branchId: branch.id }), { name: 'ValidationError' });
  await assert.rejects(() => RagStorage.saveDocument({ branchId: 'inexistente', title: 'a.txt' }), { name: 'NotFoundError' });

  const document = await RagStorage.saveDocument({
    branchId: branch.id,
    title: 'manual.pdf',
    fileType: 'pdf',
    mimeType: 'application/pdf',
    fileSize: 4,
    chunks: [
      { order: 0, title: 'CPU', content: 'Instalación del procesador LGA1155.', pageStart: 1, pageEnd: 2 },
      { order: 1, title: 'RAM', content: 'Configuración de memoria DDR3.', pageStart: 3, pageEnd: 3 }
    ]
  });
  const second = await RagStorage.saveDocument({
    branchId: branch.id, title: 'dos.txt', fileType: 'txt', chunks: [{ content: 'Dos' }]
  }, 'Dos');

  const stored = await RagStorage.getDocumentById(document.id);
  assert.equal(stored.chunkCount, 2);
  assert.equal(stored.imageCount, 0);
  assert.equal(stored.chunks, undefined);
  assert.equal((await RagStorage.getChunksByDocument(document.id)).length, 2);
  assert.equal((await RagStorage.getChunksByBranch(branch.id)).length, 3);

  // Alias comunes de getChunkById: canónico, docId#idx y documentId directo.
  assert.equal((await RagStorage.getChunkById(`${document.id}:chunk:0`)).content, 'Instalación del procesador LGA1155.');
  assert.equal((await RagStorage.getChunkById(`${document.id}#1`)).content, 'Configuración de memoria DDR3.');
  assert.equal((await RagStorage.getChunkById(document.id)).content, 'Instalación del procesador LGA1155.');

  // Eliminación individual y en cascada por rama.
  assert.equal(await RagStorage.deleteDocument(second.id), true);
  assert.equal(await RagStorage.getChunkById(`${second.id}:chunk:0`), null);
  const result = await RagStorage.deleteBranch(branch.id);
  assert.equal(result.deletedDocumentsCount, 1);
  assert.equal((await RagStorage.getDocumentsByBranch(branch.id)).length, 0);
  assert.equal((await RagStorage.getChunksByBranch(branch.id)).length, 0);
});

test('RagStorage - exporta e importa respaldos JSON y gzip con imágenes reasignadas', async () => {
  await assert.rejects(
    () => RagStorage.importBranch({ schema: 'unsupported-format', version: 99, branch: {}, documents: [] }),
    { name: 'ValidationError' }
  );

  // Respaldo JSON plano (v2 sin fuente original).
  const jsonBranch = await RagStorage.createBranch('Respaldo', 'Copia portable');
  await RagStorage.saveDocument({
    branchId: jsonBranch.id,
    title: 'notas.txt',
    fileType: 'txt',
    mimeType: 'text/plain',
    fileSize: 5,
    chunks: [{ title: 'Nota', content: 'cinco' }]
  });
  const plain = await RagStorage.exportBranchBlob(jsonBranch.id, { compress: false });
  assert.equal(plain.compressed, false);
  assert.match(plain.filename, /^Respaldo\.zerochat-knowledge\.json$/);
  const backup = JSON.parse(await RagStorage.readBackupText(new File([plain.blob], plain.filename)));
  assert.equal(backup.schema, 'zerochat-knowledge');
  assert.equal(backup.version, 2);
  assert.equal(backup.documents[0].source, undefined);

  await clearRagData();
  const restoredJson = await RagStorage.importBranch(JSON.stringify(backup));
  const restoredDocs = await RagStorage.getDocumentsByBranch(restoredJson.id);
  assert.equal(restoredJson.name, 'Respaldo');
  assert.equal((await RagStorage.getChunksByDocument(restoredDocs[0].id))[0].content, 'cinco');

  // Respaldo gzip con imágenes: lectura por extensión o por firma y reasignación de docId.
  const imgBranch = await RagStorage.createBranch('ImagesTest');
  await RagStorage.saveDocument({
    id: 'doc_original',
    branchId: imgBranch.id,
    title: 'doc-with-image.pdf',
    fileType: 'pdf',
    chunks: [{ order: 0, title: 'Sección', content: 'Balance: ![Balance](rag-image://doc_original:img_1)' }]
  }, [{ id: 'img_1', page: 1, mimeType: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,1234', label: 'Balance' }]);

  let progressCalled = false;
  const gz = await RagStorage.exportBranchBlob(imgBranch.id, {
    compress: true,
    onProgress: p => { if (p.percent === 100) progressCalled = true; }
  });
  assert.equal(gz.compressed, true);
  assert.ok(gz.filename.endsWith('.zerochat-knowledge.json.gz'));
  assert.ok(progressCalled);

  const decompressedText = await RagStorage.readBackupText(new File([gz.blob], gz.filename));
  assert.equal(await RagStorage.readBackupText(new File([gz.blob], 'renombrada.json')), decompressedText);
  const restoredImgBranch = await RagStorage.importBranch(decompressedText);
  const [restoredImgDoc] = await RagStorage.getDocumentsByBranch(restoredImgBranch.id);
  assert.equal(restoredImgDoc.imageCount, 1);
  assert.equal((await RagStorage.getDocumentImages(restoredImgDoc.id))[0].dataUrl, 'data:image/jpeg;base64,1234');
  const [restoredChunk] = await RagStorage.getChunksByDocument(restoredImgDoc.id);
  assert.ok(restoredChunk.content.includes(`rag-image://${restoredImgDoc.id}:img_1`));
});

test('RagStorage - coherencia de formatos admitidos con ChatOfficeParser (F-15)', async () => {
  const OfficeParser = require('../../js/office-parser.js');
  const branch = await RagStorage.createBranch('FormatTest');

  const modernOfficeFormats = ['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp'];
  for (const ext of modernOfficeFormats) {
    assert.ok(OfficeParser.isOfficeFormat(ext), `${ext} debe ser reconocido por el parser`);
    const doc = await RagStorage.saveDocument({
      branchId: branch.id,
      title: `archivo.${ext}`,
      fileType: ext,
      chunks: [{ content: `Contenido de prueba para ${ext}` }]
    });
    assert.equal(doc.fileType, ext);
  }
});

