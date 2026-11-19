const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const RagStorage = require('../../js/ragStorage.js');
const RagIndex = require('../../js/rag-index.js');
const Ingestion = require('../../js/ingestionEngine.js');
const { toFile } = require('../helpers/files.js');
const { clearRagData } = require('../helpers/rag-data.js');

beforeEach(async () => {
  await clearRagData();
});

test('IngestionEngine - genera chunks acotados con solapamiento, títulos y rangos de página', () => {
  const sectionA = '# Instalación\n\n' + 'Configuración inicial. '.repeat(90);
  const sectionB = '# Seguridad\n\n' + 'Autenticación multifactor. '.repeat(90);
  const chunks = Ingestion.partitionTextIntoChunks(`${sectionA}\n\n${sectionB}`, { maxChars: 1200, overlapChars: 120 });
  assert.ok(chunks.length >= 3);
  assert.equal(chunks[0].title, 'Instalación');
  assert.ok(chunks.every(chunk => chunk.content.length <= 1320));
  assert.ok(chunks[1].content.includes(chunks[0].content.slice(-40).trim()));

  const paged = Ingestion.partitionTextIntoChunks(
    '--- Page 2 ---\nInicio\n\n' + 'dato '.repeat(250) + '\n\n--- Page 3 ---\nFinal',
    { maxChars: 1100, overlapChars: 0 }
  );
  assert.equal(paged[0].pageStart, 2);
  assert.ok(paged.some(chunk => chunk.pageEnd === 3));
});

test('IngestionEngine - ingiere cola de texto/logs/gzip y rechaza binarios o ZIP con detalle de error', async () => {
  const zlib = require('node:zlib');
  const branch = await RagStorage.createBranch('Pruebas');
  const progress = [];
  const gzipBytes = zlib.gzipSync('2026-09-05T10:00:00Z sshd[123]: Failed password for root from 10.0.0.1');

  const result = await Ingestion.processDocumentQueue([
    toFile({ name: 'uno.md', type: 'text/markdown', content: '# Redes\nProtocolo BGP para enrutamiento.' }),
    toFile({ name: 'api.log', type: '', content: '2026-09-05 ERROR conexión rechazada' }),
    toFile({ name: 'main.py', type: 'text/x-python', content: 'def saludar():\n    return "__DOC_ID__"' }),
    toFile({ name: 'auth.log.1.gz', type: 'application/gzip', content: gzipBytes }),
    toFile({ name: 'vacio.txt', content: '' }),
    toFile({ name: 'datos.bin', type: 'application/octet-stream', content: 'texto\0binario' }),
    toFile({ name: 'logs.zip', type: 'application/zip', content: new Uint8Array([0x50, 0x4B, 0x03, 0x04]) })
  ], branch.id, event => progress.push(event), { maxChars: 2000 });

  assert.equal(result.processed, 4);
  assert.equal(result.failed, 3);
  assert.ok(result.errors.some(e => e.fileName === 'logs.zip' && e.error.includes('ZIP archive')));
  assert.ok(progress.some(event => event.status === 'chunking'));
  const finalProgress = progress[progress.length - 1];
  assert.equal(finalProgress.finishedFiles, 7);
  assert.equal(finalProgress.overallPercent, 100);

  const docs = await RagStorage.getDocumentsByBranch(branch.id);
  const pyDoc = docs.find(d => d.title === 'main.py');
  assert.match((await RagStorage.getChunksByDocument(pyDoc.id))[0].content, /return "__DOC_ID__"/);
  assert.equal((await RagIndex.searchBranch(branch.id, 'BGP', { tolerance: 0 })).hits[0].documentTitle, 'uno.md');
  assert.equal((await RagIndex.searchBranch(branch.id, 'Failed password', { tolerance: 0 })).hits[0].documentTitle, 'auth.log.1.gz');
});

test('IngestionEngine & FileParser - decodifica CMaps ToUnicode de 1 y 2 bytes sin corromper cadenas ASCII', async () => {
  const FileParser = require('../../js/file-parser.js');
  const buildCmapPdf = (codespace, bodyEntries, streamOp, fontSubtype = '/Type0') => `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj
4 0 obj << /Type /Font /Subtype ${fontSubtype} /ToUnicode 6 0 R >> endobj
6 0 obj << /Length 400 >>
stream
/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
1 begincodespacerange
${codespace}
endcodespacerange
${bodyEntries}
endcmap
end
endstream
endobj
5 0 obj << /Length 120 >>
stream
BT
/F1 12 Tf
${streamOp} Tj
ET
endstream
endobj
trailer << /Size 7 /Root 1 0 R >>
%%EOF`;

  const hexText = await FileParser.extractTextFromPdf(Buffer.from(buildCmapPdf(
    '<0000> <FFFF>',
    '1 beginbfrange\n<0001> <0002> [ <0041> <0042> ]\nendbfrange\n1 beginbfchar\n<0003> <0043>\nendbfchar',
    '<000100020003>'
  ), 'latin1'));
  assert.ok(hexText.includes('ABC'));

  const byte1Text = await FileParser.extractTextFromPdf(Buffer.from(buildCmapPdf(
    '<00> <FF>',
    '1 beginbfchar\n<77> <0054>\n<6c> <0061>\n<61> <006c>\n<73> <0065>\nendbfchar',
    '(wlas)',
    '/Type1'
  ), 'latin1'));
  assert.ok(byte1Text.includes('Tale'));

  const asciiText = await FileParser.extractTextFromPdf(Buffer.from(buildCmapPdf(
    '<0000> <FFFF>',
    '1 beginbfchar\n<0047> <0064>\nendbfchar',
    "(GA-Z77P-D3 User's Manual GIGABYTE)"
  ), 'latin1'));
  assert.ok(asciiText.includes('GA-Z77P-D3') && asciiText.includes("User's Manual") && asciiText.includes('GIGABYTE'));
});

test('IngestionEngine & FileParser - extrae imágenes XObject (con o sin texto), guarda en RagStorage y tolera CMYK sin canvas', async () => {
  const FileParser = require('../../js/file-parser.js');
  const Markdown = require('../../js/markdown.js');
  const fakeJpegBytes = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xFF, 0xDB, 0x00, 0x43, ...new Array(65).fill(0), 0xFF, 0xD9]);
  const jpegString = fakeJpegBytes.toString('latin1');

  const pdfWithText = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >> endobj
4 0 obj << /Type /XObject /Subtype /Image /Width 800 /Height 600 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${fakeJpegBytes.length} >>
stream
${jpegString}
endstream
endobj
5 0 obj << /Length 50 >>
stream
BT
/F1 12 Tf
(Motherboard Layout) Tj
ET
/Im1 Do
endstream
endobj
trailer << /Size 6 /Root 1 0 R >>
%%EOF`;

  const docResult = await FileParser.parsePdfDocument(Buffer.from(pdfWithText, 'latin1'));
  assert.strictEqual(docResult.images.length, 1);
  assert.strictEqual(docResult.images[0].mimeType, 'image/jpeg');
  assert.ok(docResult.text.includes('![Diagram') && docResult.text.includes('rag-image://'));

  const branch = await RagStorage.createBranch('test-img-branch');
  const savedDoc = await RagStorage.saveDocument({
    branchId: branch.id, title: 'test-img.pdf', fileType: 'pdf', chunks: [{ order: 0, title: 'Frag 1', content: docResult.text }]
  }, docResult.images);
  assert.strictEqual((await RagStorage.getDocumentImage(savedDoc.id, 'img_1')).width, 800);
  assert.strictEqual(Markdown.sanitizeImageUrl(`rag-image://${savedDoc.id}:img_1`), `rag-image://${savedDoc.id}:img_1`);

  const imageOnlyPdf = `%PDF-1.4
4 0 obj << /Type /XObject /Subtype /Image /Width 800 /Height 600 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${fakeJpegBytes.length} >>
stream
${jpegString}
endstream
endobj
trailer << /Size 5 >>
%%EOF`;
  const noText = await FileParser.parsePdfDocument(Buffer.from(imageOnlyPdf, 'latin1'));
  assert.equal(noText.images.length, 1);
  assert.match(noText.text, /no selectable text could be extracted/);
  assert.match(noText.text, /rag-image:\/\/__DOC_ID__:img_1/);

  assert.strictEqual(await FileParser.convertCmykDataUrlToRgb(null), null);
  const cmykJpeg = 'data:image/jpeg;base64,/9j/wAAUCAAQABAEAREAAhEBAxEBBBEA/9k=';
  assert.strictEqual(await FileParser.convertCmykDataUrlToRgb(cmykJpeg), cmykJpeg);
});
