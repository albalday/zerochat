const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { toFile } = require('../helpers/files.js');

const RagStorage = require('../../js/ragStorage.js');
const RagIndex = require('../../js/rag-index.js');
const Ingestion = require('../../js/ingestionEngine.js');
const WebBrowser = require('../../js/web-browser.js');
const { clearRagData } = require('../helpers/rag-data.js');

const FIXTURES = path.resolve(__dirname, '../fixtures/office');
const fixtureBytes = name => fs.readFileSync(path.join(FIXTURES, name));
const fixtureFile = (fixture, name = fixture, type = '') => toFile({ name, type, content: fixtureBytes(fixture) });

beforeEach(async () => {
  await clearRagData();
});

test('Ingesta RAG: los documentos ofimáticos se indexan con sus imágenes antes del rechazo de ZIP', async () => {
  const branch = await RagStorage.createBranch('Ofimática');
  const result = await Ingestion.processDocumentQueue([
    fixtureFile('pandoc.odt', 'informe.odt'),
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
  assert.deepEqual(Object.keys(byTitle).sort(), ['charla.pptx', 'informe.odt', 'ventas.ods']);
  assert.equal(byTitle['informe.odt'].fileType, 'odt');
  assert.equal(byTitle['charla.pptx'].fileType, 'pptx');
  assert.equal(byTitle['ventas.ods'].fileType, 'ods');
  for (const document of documents) assert.equal(document.imageCount, 1, document.title);

  const textImages = await RagStorage.getDocumentImages(byTitle['informe.odt'].id);
  assert.equal(textImages[0].mimeType, 'image/png');
  const textChunks = await RagStorage.getChunksByDocument(byTitle['informe.odt'].id);
  assert.ok(textChunks.some(chunk => chunk.content.includes(`rag-image://${byTitle['informe.odt'].id}:img_1`)));

  const slideChunks = await RagStorage.getChunksByDocument(byTitle['charla.pptx'].id);
  assert.equal(Math.min(...slideChunks.map(chunk => chunk.pageStart)), 1);
  assert.equal(Math.max(...slideChunks.map(chunk => chunk.pageEnd)), 2);

  const found = await RagIndex.searchBranch(branch.id, 'Café', { tolerance: 0 });
  assert.ok(found.hits.some(hit => hit.documentTitle === 'informe.odt'));
  assert.ok(found.hits.some(hit => hit.documentTitle === 'ventas.ods'));
});

test('Herramientas web: un documento ofimático se descarga una sola vez y se lee en local', async () => {
  const originalFetch = global.fetch;
  const requested = [];
  global.fetch = async url => {
    requested.push(String(url));
    if (url === 'https://example.com/files/informe.odt') return new Response(fixtureBytes('pandoc.odt'), { headers: { 'content-type': 'application/octet-stream' } });
    if (url === 'https://example.com/export?id=7') {
      return new Response(fixtureBytes('exceljs.xlsx'), { headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } });
    }
    if (url === 'https://example.com/files/acta.doc') return new Response(new Uint8Array([0xD0, 0xCF, 0x11, 0xE0]), { headers: { 'content-type': 'application/msword' } });
    return new Response('unexpected request', { status: 503 });
  };
  try {
    const text = await WebBrowser.fetchPage('https://example.com/files/informe.odt');
    assert.equal(text.success, true);
    assert.equal(text.strategy, 'LocalDocumentExtractor');
    assert.match(text.content, /^\[OpenDocument text: informe\.odt\]\n\[URL: https:\/\/example\.com\/files\/informe\.odt\]/);
    assert.match(text.content, /^# Informe trimestral$/m);
    assert.match(text.content, /\[Image: Image 1 \(page 1\)\]/);
    assert.doesNotMatch(text.content, /rag-image:/);
    assert.deepEqual(requested, ['https://example.com/files/informe.odt']);

    const sheet = await WebBrowser.fetchPage('https://example.com/export?id=7');
    assert.equal(sheet.success, true);
    assert.equal(sheet.strategy, 'DirectFetch');
    assert.match(sheet.content, /^\[Excel spreadsheet: export\]/);
    assert.match(sheet.content, /^## Sheet: Ventas$/m);

    // Con backend, un documento sin extensión llega en base64 por su Content-Type y se lee igual.
    const manager = require('../../js/mcp.js').manager;
    const origIsProxyConnected = manager.isProxyConnected;
    const origFetchWebResource = manager.fetchWebResource;
    manager.isProxyConnected = () => true;
    manager.fetchWebResource = async () => ({
      ok: true,
      status: 200,
      content_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      base64: Buffer.from(fixtureBytes('exceljs.xlsx')).toString('base64')
    });
    try {
      const backendSheet = await WebBrowser.fetchPage('https://example.com/export?id=8');
      assert.equal(backendSheet.success, true);
      assert.match(backendSheet.content, /^## Sheet: Ventas$/m);
    } finally {
      manager.isProxyConnected = origIsProxyConnected;
      manager.fetchWebResource = origFetchWebResource;
    }

    requested.length = 0;
    const legacy = await WebBrowser.fetchPage('https://example.com/files/acta.doc');
    assert.equal(legacy.success, false);
    assert.match(legacy.error, /Word 97-2003 files \(\.doc\) are not supported/);
    assert.ok(requested.every(url => url === 'https://example.com/files/acta.doc'), 'Solo se pide el documento');
  } finally {
    global.fetch = originalFetch;
  }
});
