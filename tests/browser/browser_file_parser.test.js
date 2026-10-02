const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createTestBrowser, closeGlobalBrowser } = require('../helpers/browser-env.js');

// JPEG CMYK rojo puro con la convención de un PDF (DCTDecode sin invertir), como los que se
// extraen de los manuales: Adobe YCCK (ImageMagick), Adobe CMYK (Pillow), con marcadores de
// reinicio y sin marcador Adobe. Un navegador los pinta en negativo si no se corrigen.
const PDF_YCCK = '/9j/7gAOQWRvYmUAZAAAAAAC/9sAQwADAgIDAgIDAwMDBAMDBAUIBQUEBAUKBwcGCAwKDAwLCgsLDQ4SEA0OEQ4LCxAWEBETFBUVFQwPFxgWFBgSFBUU/9sAQwEDBAQFBAUJBQUJFA0LDRQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU/8AAFAgAEAAQBAERAAIRAQMRAQQRAP/EABYAAQEBAAAAAAAAAAAAAAAAAAAICf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAWAQEBAQAAAAAAAAAAAAAAAAAABwn/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADgQBAAIRAxEEAAA/AJ0QxqmyqAAAAf/Z';
const PDF_CMYK = '/9j/7gAOQWRvYmUAZAAAAAAA/9sAQwADAgIDAgIDAwMDBAMDBAUIBQUEBAUKBwcGCAwKDAwLCgsLDQ4SEA0OEQ4LCxAWEBETFBUVFQwPFxgWFBgSFBUU/8AAFAgAEAAQBEMRAE0RAFkRAEsRAP/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/aAA4EQwBNAFkASwAAPwD8qq/VOv1Tr8qqKKKKKKKKKKKK/9k=';
const PDF_CMYK_RESTART = '/9j/7gAOQWRvYmUAZAAAAAAA/9sAQwADAgIDAgIDAwMDBAMDBAUIBQUEBAUKBwcGCAwKDAwLCgsLDQ4SEA0OEQ4LCxAWEBETFBUVFQwPFxgWFBgSFBUU/8AAFAgAIAAgBEMRAE0RAFkRAEsRAP/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/dAAQAAf/aAA4EQwBNAFkASwAAPwD8qq/VOv1Tr8qq/9D8qq/VOv1Tr8qq/9H8qq/VOv1Tr8qq/9L8qq/VOv1Tr8qq/9P8qq/VOv1Tr8qq/9T8qq/VOv1Tr8qq/9X8qq/VOv1Tr8qq/9b8qq/VOv1Tr8qq/9f8qq/VOv1Tr8qq/9D8qq/VOv1Tr8qq/9H8qq/VOv1Tr8qq/9L8qq/VOv1Tr8qq/9P8qq/VOv1Tr8qq/9T8qq/VOv1Tr8qq/9X8qq/VOv1Tr8qq/9b8qq/VOv1Tr8qq/9k=';
const PDF_CMYK_NO_ADOBE = '/9j/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/wAAUCAAQABAEQxEATREAWREASxEA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADgRDAE0AWQBLAAA/APyqr9U6/VOvyqoooooooooooor/2Q==';

describe('Browser - file_parser', () => {
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
});
