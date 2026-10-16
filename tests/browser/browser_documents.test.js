const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTestBrowser, withTestApp, closeGlobalBrowser } = require('../helpers/browser-env.js');

const FIXTURES = path.resolve(__dirname, '../fixtures/office');
const fixture = (name, as = name, mimeType = 'application/octet-stream') => ({ name: as, mimeType, buffer: fs.readFileSync(path.join(FIXTURES, name)) });

// JPEG CMYK rojo puro con la convención de un PDF (DCTDecode sin invertir), como los que se
// extraen de los manuales: Adobe YCCK (ImageMagick), Adobe CMYK (Pillow), con marcadores de
// reinicio y sin marcador Adobe. Un navegador los pinta en negativo si no se corrigen.
const PDF_YCCK = '/9j/7gAOQWRvYmUAZAAAAAAC/9sAQwADAgIDAgIDAwMDBAMDBAUIBQUEBAUKBwcGCAwKDAwLCgsLDQ4SEA0OEQ4LCxAWEBETFBUVFQwPFxgWFBgSFBUU/9sAQwEDBAQFBAUJBQUJFA0LDRQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU/8AAFAgAEAAQBAERAAIRAQMRAQQRAP/EABYAAQEBAAAAAAAAAAAAAAAAAAAICf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAWAQEBAQAAAAAAAAAAAAAAAAAABwn/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADgQBAAIRAxEEAAA/AJ0QxqmyqAAAAf/Z';
const PDF_CMYK = '/9j/7gAOQWRvYmUAZAAAAAAA/9sAQwADAgIDAgIDAwMDBAMDBAUIBQUEBAUKBwcGCAwKDAwLCgsLDQ4SEA0OEQ4LCxAWEBETFBUVFQwPFxgWFBgSFBUU/8AAFAgAEAAQBEMRAE0RAFkRAEsRAP/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/aAA4EQwBNAFkASwAAPwD8qq/VOv1Tr8qqKKKKKKKKKKKK/9k=';
const PDF_CMYK_RESTART = '/9j/7gAOQWRvYmUAZAAAAAAA/9sAQwADAgIDAgIDAwMDBAMDBAUIBQUEBAUKBwcGCAwKDAwLCgsLDQ4SEA0OEQ4LCxAWEBETFBUVFQwPFxgWFBgSFBUU/8AAFAgAIAAgBEMRAE0RAFkRAEsRAP/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/dAAQAAf/aAA4EQwBNAFkASwAAPwD8qq/VOv1Tr8qq/9D8qq/VOv1Tr8qq/9H8qq/VOv1Tr8qq/9L8qq/VOv1Tr8qq/9P8qq/VOv1Tr8qq/9T8qq/VOv1Tr8qq/9X8qq/VOv1Tr8qq/9b8qq/VOv1Tr8qq/9f8qq/VOv1Tr8qq/9D8qq/VOv1Tr8qq/9H8qq/VOv1Tr8qq/9L8qq/VOv1Tr8qq/9P8qq/VOv1Tr8qq/9T8qq/VOv1Tr8qq/9X8qq/VOv1Tr8qq/9b8qq/VOv1Tr8qq/9k=';
const PDF_CMYK_NO_ADOBE = '/9j/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/wAAUCAAQABAEQxEATREAWREASxEA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADgRDAE0AWQBLAAA/APyqr9U6/VOvyqoooooooooooor/2Q==';

describe('Browser - documents', () => {
  after(async () => {
    await closeGlobalBrowser();
  });

  test('Browser - convertCmykDataUrlToRgb pinta los JPEG CMYK de un PDF con sus colores reales', async () => {
    const browser = await createTestBrowser();
    try {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'warning' || message.type() === 'error') errors.push(message.text()); });
      await page.setContent('<!doctype html><html><body></body></html>');
      await page.addScriptTag({ path: path.resolve(__dirname, '../../js/utils.js') });
      await page.addScriptTag({ path: path.resolve(__dirname, '../../js/file-parser.js') });

      const inputs = [PDF_YCCK, PDF_CMYK, PDF_CMYK_RESTART, PDF_CMYK_NO_ADOBE].map(b64 => `data:image/jpeg;base64,${b64}`);
      const results = await page.evaluate(async (urls) => {
        async function samplePixel(dataUrl) {
          const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
          const canvas = document.createElement('canvas');
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(bitmap, 0, 0);
          return Array.from(ctx.getImageData(bitmap.width - 4, bitmap.height - 4, 1, 1).data.slice(0, 3));
        }
        const output = [];
        for (const url of urls) {
          const converted = await ChatFileParser.convertCmykDataUrlToRgb(url);
          const bytes = Uint8Array.from(atob(converted.split(',')[1]), c => c.charCodeAt(0));
          let components = 0;
          for (let i = 2; i + 9 < bytes.length; i++) {
            if (bytes[i] === 0xFF && bytes[i + 1] === 0xC0) { components = bytes[i + 9]; break; }
          }
          output.push({ changed: converted !== url, components, pixel: await samplePixel(converted) });
        }
        return output;
      }, inputs);

      results.forEach((result, index) => {
        assert.equal(result.changed, true, `entrada ${index}`);
        assert.equal(result.components, 3, `entrada ${index}`);
        const [r, g, b] = result.pixel;
        assert.ok(r > 200 && g < 80 && b < 80, `entrada ${index}: se esperaba rojo, se obtuvo ${result.pixel}`);
      });

      const rgbJpeg = await page.evaluate(() => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 16;
        return canvas.toDataURL('image/jpeg');
      });
      assert.equal(await page.evaluate(url => ChatFileParser.convertCmykDataUrlToRgb(url), rgbJpeg), rgbJpeg);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });

  test('Browser - el compositor adjunta Word, Excel y OpenDocument y explica los formatos antiguos', async () => {
    await withTestApp(async page => {
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route(/^https?:/, route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [], models: [] }) }));

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
    });
  });

  test('Browser - la base de conocimiento indexa documentos ofimáticos con sus imágenes', async () => {
    await withTestApp(async page => {
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route(/^https?:/, route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [], models: [] }) }));

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
    });
  });
});
