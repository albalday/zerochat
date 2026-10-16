const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTestBrowser, closeGlobalBrowser, getIndexUrl, waitForAppReady } = require('../helpers/browser-env.js');

const FIXTURES = path.resolve(__dirname, '../fixtures/office');
const fixture = (name, as = name, mimeType = 'application/octet-stream') => ({ name: as, mimeType, buffer: fs.readFileSync(path.join(FIXTURES, name)) });

async function openApp(browser) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route(/^https?:/, route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [], models: [] }) }));
  await page.goto(getIndexUrl(), { waitUntil: 'load' });
  await waitForAppReady(page);
  return { page, errors };
}

describe('Browser - office documents', () => {
  after(async () => {
    await closeGlobalBrowser();
  });

  test('Browser - el compositor adjunta Word, Excel y OpenDocument y explica los formatos antiguos', async () => {
    const browser = await createTestBrowser();
    try {
      const { page, errors } = await openApp(browser);
      assert.equal(await page.evaluate(() => document.querySelectorAll('script[src^="js/vendor/mammoth"]').length), 0,
        'mammoth no debe cargarse al arrancar');

      await page.locator('#file-input').setInputFiles([
        fixture('libreoffice.docx', 'informe.docx'),
        fixture('exceljs.xlsx', 'ventas.xlsx'),
        fixture('libreoffice.odp', 'charla.odp'),
        { name: 'acta.doc', mimeType: 'application/msword', buffer: Buffer.from([0xD0, 0xCF, 0x11, 0xE0]) }
      ]);
      await page.waitForFunction(() => document.getElementById('notice-dialog').open, null, { timeout: 15000 });
      assert.match(await page.locator('#notice-dialog').textContent(), /acta\.doc[\s\S]*Word 97-2003 files \(\.doc\) are not supported/);
      await page.locator('#notice-accept').click();

      assert.deepEqual(await page.locator('.file-chip-name').allTextContents(), ['informe.docx', 'ventas.xlsx', 'charla.odp']);
      const payload = await page.evaluate(() => {
        const { fullPrompt, displayText, imageAttachments } = ChatAttachments.buildAttachmentsPayload('Resume');
        return {
          fullPrompt,
          displayText,
          images: imageAttachments.map(image => [image.name, image.mimeType, image.dataUrl.startsWith('data:image/png;base64,')]),
          vendors: [...document.querySelectorAll('script[src^="js/vendor/"]')].map(script => script.getAttribute('src')).sort()
        };
      });
      assert.match(payload.fullPrompt, /--- Word document: informe\.docx \([^)]+\) ---\n```markdown\n# Informe trimestral/);
      assert.match(payload.fullPrompt, /--- Excel spreadsheet: ventas\.xlsx [\s\S]*\| Producto \| Unidades \| Precio \| Total \| Fecha \|/);
      assert.match(payload.fullPrompt, /--- OpenDocument presentation: charla\.odp [\s\S]*--- Slide 2 ---\n## Resultados/);
      assert.doesNotMatch(payload.fullPrompt, /rag-image:/);
      assert.deepEqual(payload.images, [
        ['informe.docx: Image 1', 'image/png', true],
        ['ventas.xlsx: Image 1 (sheet "Ventas")', 'image/png', true],
        ['charla.odp: Image 1 (slide 2)', 'image/png', true]
      ]);
      assert.match(payload.displayText, /\[📄 informe\.docx, 📄 ventas\.xlsx, 📄 charla\.odp\]$/);
      assert.deepEqual(payload.vendors, ['js/vendor/fflate.browser.js', 'js/vendor/mammoth.browser.js', 'js/vendor/orama.browser.js']);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });

  test('Browser - la base de conocimiento indexa documentos ofimáticos con sus imágenes', async () => {
    const browser = await createTestBrowser();
    try {
      const { page, errors } = await openApp(browser);
      const files = ['pandoc.docx', 'pandoc.pptx', 'libreoffice.ods'].map(name => ({ name, base64: fs.readFileSync(path.join(FIXTURES, name)).toString('base64') }));
      const summary = await page.evaluate(async files => {
        const branch = await ChatRagStorage.createBranch('Ofimática');
        const toFile = ({ name, base64 }) => new File([Uint8Array.from(atob(base64), char => char.charCodeAt(0))], name);
        const result = await ChatIngestionEngine.processDocumentQueue(files.map(toFile), branch.id, null, {});
        const documents = await ChatRagStorage.getDocumentsByBranch(branch.id);
        const hits = await ChatRagIndex.searchBranch(branch.id, 'Resultados', { tolerance: 0 });
        return {
          processed: result.processed,
          errors: result.errors,
          documents: documents.map(document => [document.title, document.fileType, document.imageCount]).sort(),
          slideHit: hits.hits.some(hit => hit.documentTitle === 'pandoc.pptx')
        };
      }, files);
      assert.equal(summary.processed, 3, JSON.stringify(summary.errors));
      assert.deepEqual(summary.documents, [['libreoffice.ods', 'ods', 1], ['pandoc.docx', 'docx', 1], ['pandoc.pptx', 'pptx', 1]]);
      assert.equal(summary.slideHit, true);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });
});
