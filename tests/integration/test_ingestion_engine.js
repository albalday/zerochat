const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const RagStorage = require('../../js/ragStorage.js');
const RagIndex = require('../../js/rag-index.js');
const Ingestion = require('../../js/ingestionEngine.js');

beforeEach(async () => {
  RagIndex.clearCache();
  await RagStorage.clearAllData();
});

test('IngestionEngine - normaliza y lee texto sin LLM', async () => {
  assert.equal(Ingestion.normalizeExtractedText(' hola\r\n\0mundo '), 'hola\nmundo');
  assert.equal(await Ingestion.extractTextFromPlainText({ content: '# Guía\nTexto' }), '# Guía\nTexto');
  assert.equal(Ingestion.detectFileType({ name: 'manual.PDF' }), 'pdf');
  assert.equal(Ingestion.detectFileType({ name: 'notas.md' }), 'md');
  assert.equal(Ingestion.detectFileType({ name: 'servidor.log' }), 'txt');
  assert.equal(Ingestion.detectFileType({ name: 'main.py' }), 'txt');
  assert.equal(Ingestion.detectFileType({ name: 'Dockerfile' }), 'txt');
  assert.equal(Ingestion.detectFileType({ name: 'imagen.png', type: 'image/png' }), null);
  assert.equal(Ingestion.isLikelyText('INFO servicio iniciado\n'), true);
  assert.equal(Ingestion.isLikelyText('texto\0binario'), false);
});

test('IngestionEngine - genera chunks acotados con solapamiento y títulos', () => {
  const sectionA = '# Instalación\n\n' + 'Configuración inicial. '.repeat(90);
  const sectionB = '# Seguridad\n\n' + 'Autenticación multifactor. '.repeat(90);
  const chunks = Ingestion.partitionTextIntoChunks(`${sectionA}\n\n${sectionB}`, { maxChars: 1200, overlapChars: 120 });
  assert.ok(chunks.length >= 3);
  assert.equal(chunks[0].title, 'Instalación');
  assert.ok(chunks.every(chunk => chunk.content.length <= 1320));
  assert.ok(chunks[1].content.includes(chunks[0].content.slice(-40).trim()));
});

test('IngestionEngine - conserva rangos de página', () => {
  const text = '--- Página 2 ---\nInicio\n\n' + 'dato '.repeat(250) + '\n\n--- Página 3 ---\nFinal';
  const chunks = Ingestion.partitionTextIntoChunks(text, { maxChars: 1100, overlapChars: 0 });
  assert.equal(chunks[0].pageStart, 2);
  assert.ok(chunks.some(chunk => chunk.pageEnd === 3));
});

test('IngestionEngine - procesa cola, persiste e indexa sin cliente LLM', async () => {
  const branch = await RagStorage.createBranch('Pruebas');
  const progress = [];
  const result = await Ingestion.processDocumentQueue([
    { name: 'uno.md', type: 'text/markdown', content: '# Redes\nProtocolo BGP para enrutamiento.', size: 38 },
    { name: 'vacio.txt', content: '' },
    { name: 'imagen.png', type: 'image/png', content: 'no indexar' }
  ], branch.id, event => progress.push(event), { maxChars: 2000 });
  assert.equal(result.processed, 1);
  assert.equal(result.failed, 2);
  assert.equal((await RagStorage.getDocumentsByBranch(branch.id)).length, 1);
  assert.ok(progress.some(event => event.status === 'chunking'));
  assert.ok(progress.every(event => event.percent >= 0 && event.percent <= 100));
  assert.ok(progress.every(event => event.totalFiles === 3 && event.finishedFiles >= 0));
  const finalProgress = progress[progress.length - 1];
  assert.equal(finalProgress.finishedFiles, 3);
  assert.equal(finalProgress.overallPercent, 100);
  const found = await RagIndex.searchBranch(branch.id, 'BGP', { tolerance: 0 });
  assert.equal(found.hits[0].documentTitle, 'uno.md');
});

test('IngestionEngine - ingiere formatos de texto genéricos y rechaza binarios', async () => {
  const branch = await RagStorage.createBranch('Texto genérico');
  const result = await Ingestion.processDocumentQueue([
    { name: 'api.log', type: '', content: '2026-09-05 ERROR conexión rechazada', size: 38 },
    { name: 'config.yaml', type: 'application/x-yaml', content: 'database:\n  host: localhost', size: 27 },
    { name: 'main.py', type: 'text/x-python', content: 'def saludar():\n    return "__DOC_ID__"', size: 39 },
    { name: 'datos.bin', type: 'application/octet-stream', content: 'texto\0binario', size: 14 }
  ], branch.id, null, { maxChars: 2000 });

  assert.equal(result.processed, 3);
  assert.equal(result.failed, 1);
  const documents = await RagStorage.getDocumentsByBranch(branch.id);
  assert.deepEqual(documents.map(document => document.title).sort(), ['api.log', 'config.yaml', 'main.py']);
  assert.ok(documents.every(document => document.fileType === 'txt'));
  const sourceDocument = documents.find(document => document.title === 'main.py');
  const sourceChunk = await RagStorage.getChunksByDocument(sourceDocument.id);
  assert.match(sourceChunk[0].content, /    return "__DOC_ID__"/);
  const found = await RagIndex.searchBranch(branch.id, 'conexión rechazada', { tolerance: 0 });
  assert.equal(found.hits[0].documentTitle, 'api.log');
});

test('IngestionEngine - indexa logs gzip y explica los comprimidos no compatibles', async () => {
  const zlib = require('node:zlib');
  const branch = await RagStorage.createBranch('Logs comprimidos');
  const logText = '2026-09-05T10:00:00Z sshd[123]: Failed password for root from 10.0.0.1';
  const gzipBytes = zlib.gzipSync(logText);
  const gzipFile = {
    name: 'auth.log.1.gz',
    type: 'application/gzip',
    size: gzipBytes.length,
    arrayBuffer: async () => gzipBytes.buffer.slice(gzipBytes.byteOffset, gzipBytes.byteOffset + gzipBytes.byteLength)
  };
  const zipFile = {
    name: 'logs.zip',
    type: 'application/zip',
    size: 4,
    arrayBuffer: async () => new Uint8Array([0x50, 0x4B, 0x03, 0x04]).buffer
  };

  const result = await Ingestion.processDocumentQueue([gzipFile, zipFile], branch.id, null, { maxChars: 2000 });

  assert.equal(result.processed, 1);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.errors, [{ fileName: 'logs.zip', error: 'El archivo es un ZIP. Extrae los logs o usa archivos .gz individuales.' }]);
  const documents = await RagStorage.getDocumentsByBranch(branch.id);
  assert.equal(documents.length, 1);
  assert.equal(documents[0].title, 'auth.log.1.gz');
  const chunks = await RagStorage.getChunksByDocument(documents[0].id);
  assert.match(chunks[0].content, /Failed password/);
  const found = await RagIndex.searchBranch(branch.id, 'Failed password', { tolerance: 0 });
  assert.equal(found.hits[0].documentTitle, 'auth.log.1.gz');
});

test('IngestionEngine & FileParser - extrae texto decodificando CMap ToUnicode y rangos', async () => {
  const FileParser = require('../../js/file-parser.js');
  const pdfContent = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>
endobj
4 0 obj
<< /Type /Font /Subtype /Type0 /ToUnicode 6 0 R >>
endobj
6 0 obj
<< /Length 200 >>
stream
/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
1 beginbfrange
<0001> <0002> [ <0041> <0042> ]
endbfrange
1 beginbfchar
<0003> <0043>
endbfchar
endcmap
end
endstream
endobj
5 0 obj
<< /Length 60 >>
stream
BT
/F1 12 Tf
<000100020003> Tj
ET
endstream
endobj
trailer
<< /Size 7 /Root 1 0 R >>
%%EOF`;

  const buffer = Buffer.from(pdfContent, 'latin1');
  const text = await FileParser.extractTextFromPdf(buffer);
  assert.ok(text.includes('ABC'), `El texto extraído debería contener 'ABC', obtenido: '${text}'`);
});

test('IngestionEngine & FileParser - extrae texto decodificando cadenas literales con sustitución CMap de 1 byte', async () => {
  const FileParser = require('../../js/file-parser.js');
  const pdfContent = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>
endobj
4 0 obj
<< /Type /Font /Subtype /Type1 /ToUnicode 6 0 R >>
endobj
6 0 obj
<< /Length 200 >>
stream
/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
1 begincodespacerange
<00> <FF>
endcodespacerange
1 beginbfchar
<77> <0054>
<6c> <0061>
<48> <0062>
<61> <006c>
<73> <0065>
endbfchar
endcmap
end
endstream
endobj
5 0 obj
<< /Length 40 >>
stream
BT
/F1 12 Tf
(wlas) Tj
ET
endstream
endobj
trailer
<< /Size 7 /Root 1 0 R >>
%%EOF`;

  const buffer = Buffer.from(pdfContent, 'latin1');
  const text = await FileParser.extractTextFromPdf(buffer);
  assert.ok(text.includes('Tale'), `El texto extraído debería contener 'Tale', obtenido: '${text}'`);
});

test('IngestionEngine & FileParser - extrae imágenes XObject de PDF y genera referencias recuperables', async () => {
  const FileParser = require('../../js/file-parser.js');
  const RagStorage = require('../../js/ragStorage.js');
  const Markdown = require('../../js/markdown.js');

  // JPEG mínimo válido (cabecera FFD8 y cierre FFD9)
  const fakeJpegBytes = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xFF, 0xDB, 0x00, 0x43, ...new Array(65).fill(0), 0xFF, 0xD9]);
  const jpegString = fakeJpegBytes.toString('latin1');

  const pdfContent = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>
endobj
4 0 obj
<< /Type /XObject /Subtype /Image /Width 800 /Height 600 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${fakeJpegBytes.length} >>
stream
${jpegString}
endstream
endobj
5 0 obj
<< /Length 50 >>
stream
BT
/F1 12 Tf
(Motherboard Layout) Tj
ET
/Im1 Do
endstream
endobj
trailer
<< /Size 6 /Root 1 0 R >>
%%EOF`;

  const buffer = Buffer.from(pdfContent, 'latin1');
  const docResult = await FileParser.parsePdfDocument(buffer);

  assert.ok(Array.isArray(docResult.images), 'docResult.images debe ser un array');
  assert.strictEqual(docResult.images.length, 1, 'Debe extraer exactamente 1 imagen');
  assert.strictEqual(docResult.images[0].width, 800);
  assert.strictEqual(docResult.images[0].height, 600);
  assert.strictEqual(docResult.images[0].mimeType, 'image/jpeg');
  assert.ok(docResult.images[0].dataUrl.startsWith('data:image/jpeg;base64,'));

  // Verificar que el texto incluye la referencia de imagen
  assert.ok(docResult.text.includes('![Diagrama'), 'El texto debe incluir la etiqueta de imagen');
  assert.ok(docResult.text.includes('rag-image://'), 'El texto debe incluir la sintaxis rag-image://');

  // Guardar y recuperar desde RagStorage
  const branch = await RagStorage.createBranch('test-img-branch');
  const savedDoc = await RagStorage.saveDocument({
    branchId: branch.id,
    title: 'test-img.pdf',
    fileType: 'pdf',
    chunks: [{ order: 0, title: 'Frag 1', content: docResult.text }]
  }, docResult.images);

  const imagesFromStorage = await RagStorage.getDocumentImages(savedDoc.id);
  assert.strictEqual(imagesFromStorage.length, 1);
  assert.strictEqual(savedDoc.imageCount, 1);
  const singleImage = await RagStorage.getDocumentImage(savedDoc.id, 'img_1');
  assert.ok(singleImage, 'Debe recuperar la imagen por ID');
  assert.strictEqual(singleImage.width, 800);

  // Verificar Markdown sanitizeImageUrl
  const safeRagUrl = Markdown.sanitizeImageUrl(`rag-image://${savedDoc.id}:img_1`);
  assert.strictEqual(safeRagUrl, `rag-image://${savedDoc.id}:img_1`);

  await RagStorage.deleteBranch(branch.id);
});

test('IngestionEngine & FileParser - conserva referencias de imagen si el PDF no contiene texto', async () => {
  const FileParser = require('../../js/file-parser.js');
  const fakeJpegBytes = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xFF, 0xDB, 0x00, 0x43, ...new Array(65).fill(0), 0xFF, 0xD9]);
  const jpegString = fakeJpegBytes.toString('latin1');
  // Imagen XObject sin árbol de páginas ni streams de texto: simula un PDF del
  // que solo se puede recuperar una imagen incrustada.
  const pdfContent = `%PDF-1.4
4 0 obj
<< /Type /XObject /Subtype /Image /Width 800 /Height 600 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${fakeJpegBytes.length} >>
stream
${jpegString}
endstream
endobj
trailer
<< /Size 5 >>
%%EOF`;

  const result = await FileParser.parsePdfDocument(Buffer.from(pdfContent, 'latin1'));
  assert.equal(result.images.length, 1);
  assert.match(result.text, /No se pudo extraer texto seleccionable/);
  assert.match(result.text, /Se recuperaron 1 imagen incrustada/);
  assert.match(result.text, /rag-image:\/\/__DOC_ID__:img_1/);
});

test('IngestionEngine & FileParser - no corrompe texto plano ASCII por CIDs de 16 bits en ToUnicode', async () => {
  const FileParser = require('../../js/file-parser.js');

  // CMap que contiene un mapeo de 16 bits <0047> -> <0064> (donde 47 es 'G' en ASCII)
  const cmapStream = `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Custom-ToUnicode def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
1 beginbfchar
<0047> <0064>
endbfchar
endcmap
CMapName currentdict /CMap defineresource pop
end
end`;

  const pdfContent = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 6 0 R >>
endobj
4 0 obj
<< /Type /Font /Subtype /Type0 /ToUnicode 5 0 R >>
endobj
5 0 obj
<< /Length ${cmapStream.length} >>
stream
${cmapStream}
endstream
endobj
6 0 obj
<< /Length 70 >>
stream
BT
/F1 12 Tf
(GA-Z77P-D3 User's Manual GIGABYTE) Tj
ET
endstream
endobj
trailer
<< /Size 7 /Root 1 0 R >>
%%EOF`;

  const buffer = Buffer.from(pdfContent, 'latin1');
  const text = await FileParser.extractTextFromPdf(buffer);
  assert.ok(text.includes('GA-Z77P-D3'), `El texto no debe corromperse a 'dA-wTTm-aP', obtenido: '${text}'`);
  assert.ok(text.includes("User's Manual"), `El texto debe mantener 'User\'s Manual', obtenido: '${text}'`);
  assert.ok(text.includes('GIGABYTE'), `El texto debe mantener 'GIGABYTE', obtenido: '${text}'`);
});

test('IngestionEngine - Conversión CMYK bajo demanda y preservación de isCmyk', async () => {
  const FileParser = require('../../js/file-parser.js');
  assert.strictEqual(typeof FileParser.convertCmykDataUrlToRgb, 'function');
  assert.strictEqual(typeof FileParser.convertCmykJpegToRgbDataUrl, 'function');

  // Verificar que convertCmykDataUrlToRgb maneja entradas seguras
  assert.strictEqual(FileParser.convertCmykDataUrlToRgb(null), null);
  assert.strictEqual(FileParser.convertCmykDataUrlToRgb('data:image/png;base64,123'), 'data:image/png;base64,123');
});
