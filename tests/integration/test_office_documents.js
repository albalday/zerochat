const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { installDom } = require('../helpers/dom-env.js');
const { toFile } = require('../helpers/files.js');

installDom();
const RagStorage = require('../../js/ragStorage.js');
const RagIndex = require('../../js/rag-index.js');
const Ingestion = require('../../js/ingestionEngine.js');
const WebBrowser = require('../../js/web-browser.js');

const FIXTURES = path.resolve(__dirname, '../fixtures/office');
const fixtureBytes = name => fs.readFileSync(path.join(FIXTURES, name));
const fixtureFile = (fixture, name = fixture, type = '') => toFile({ name, type, content: fixtureBytes(fixture) });

beforeEach(async () => {
  RagIndex.clearCache();
  await RagStorage.clearAllData();
});

test('Ingesta RAG: los documentos ofimáticos se indexan con sus imágenes antes del rechazo de ZIP', async () => {
  const branch = await RagStorage.createBranch('Ofimática');
  const result = await Ingestion.processDocumentQueue([
    fixtureFile('pandoc.docx', 'informe.docx'),
    fixtureFile('libreoffice.pptx', 'charla.pptx'),
    fixtureFile('libreoffice.ods', 'ventas.ods'),
    toFile({ name: 'acta.doc', type: 'application/msword', content: new Uint8Array([0xD0, 0xCF, 0x11, 0xE0]) }),
    toFile({ name: 'logs.zip', type: 'application/zip', content: new Uint8Array([0x50, 0x4B, 0x03, 0x04]) })
  ], branch.id, null, { maxChars: 2000 });

  assert.equal(result.processed, 3);
  assert.deepEqual(result.errors.map(error => error.fileName), ['acta.doc', 'logs.zip']);
  assert.match(result.errors[0].error, /Word 97-2003 files \(\.doc\) are not supported/);
  assert.match(result.errors[1].error, /ZIP archive/);

  const documents = await RagStorage.getDocumentsByBranch(branch.id);
  const byTitle = Object.fromEntries(documents.map(document => [document.title, document]));
  assert.deepEqual(Object.keys(byTitle).sort(), ['charla.pptx', 'informe.docx', 'ventas.ods']);
  assert.equal(byTitle['informe.docx'].fileType, 'docx');
  assert.equal(byTitle['charla.pptx'].fileType, 'pptx');
  assert.equal(byTitle['ventas.ods'].fileType, 'ods');
  for (const document of documents) assert.equal(document.imageCount, 1, document.title);

  const docxImages = await RagStorage.getDocumentImages(byTitle['informe.docx'].id);
  assert.equal(docxImages[0].mimeType, 'image/png');
  const docxChunks = await RagStorage.getChunksByDocument(byTitle['informe.docx'].id);
  assert.ok(docxChunks.some(chunk => chunk.content.includes(`rag-image://${byTitle['informe.docx'].id}:img_1`)));

  const slideChunks = await RagStorage.getChunksByDocument(byTitle['charla.pptx'].id);
  assert.equal(Math.min(...slideChunks.map(chunk => chunk.pageStart)), 1);
  assert.equal(Math.max(...slideChunks.map(chunk => chunk.pageEnd)), 2);

  const found = await RagIndex.searchBranch(branch.id, 'Café', { tolerance: 0 });
  assert.ok(found.hits.some(hit => hit.documentTitle === 'informe.docx'));
  assert.ok(found.hits.some(hit => hit.documentTitle === 'ventas.ods'));
});

test('Herramientas web: un documento ofimático se descarga y lee en local, sin gateway ni proxy', async () => {
  const originalFetch = global.fetch;
  const requested = [];
  global.fetch = async url => {
    requested.push(String(url));
    if (url === 'https://example.com/files/informe.docx') return new Response(fixtureBytes('pandoc.docx'), { headers: { 'content-type': 'application/octet-stream' } });
    if (url === 'https://example.com/export?id=7') {
      return new Response(fixtureBytes('exceljs.xlsx'), { headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } });
    }
    if (url === 'https://example.com/files/acta.doc') return new Response(new Uint8Array([0xD0, 0xCF, 0x11, 0xE0]), { headers: { 'content-type': 'application/msword' } });
    return new Response('gateway unavailable', { status: 503 });
  };
  try {
    const docx = await WebBrowser.fetchPage('https://example.com/files/informe.docx');
    assert.equal(docx.success, true);
    assert.equal(docx.strategy, 'LocalDocumentExtractor');
    assert.match(docx.content, /^\[Word document: informe\.docx\]\n\[URL: https:\/\/example\.com\/files\/informe\.docx\]/);
    assert.match(docx.content, /^# Informe trimestral$/m);
    assert.match(docx.content, /\[Image: Logo rojo\]/);
    assert.doesNotMatch(docx.content, /rag-image:/);
    assert.deepEqual(requested, ['https://example.com/files/informe.docx']);

    const sheet = await WebBrowser.fetchPage('https://example.com/export?id=7');
    assert.equal(sheet.success, true);
    assert.equal(sheet.strategy, 'DirectFetch');
    assert.match(sheet.content, /^\[Excel spreadsheet: export\]/);
    assert.match(sheet.content, /^## Sheet: Ventas$/m);

    requested.length = 0;
    const legacy = await WebBrowser.fetchPage('https://example.com/files/acta.doc');
    assert.equal(legacy.success, false);
    assert.match(legacy.error, /Word 97-2003 files \(\.doc\) are not supported/);
    assert.ok(requested.every(url => url === 'https://example.com/files/acta.doc'), 'No debe recurrir al gateway ni al proxy');
  } finally {
    global.fetch = originalFetch;
  }
});
