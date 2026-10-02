const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createTestBrowser, closeGlobalBrowser } = require('../helpers/browser-env.js');

// JPEG 16x16 rojo puro generados con ImageMagick (Adobe YCCK) y Pillow (Adobe CMYK).
const RED_YCCK_JPEG = 'data:image/jpeg;base64,/9j/7gAOQWRvYmUAZAAAAAAC/9sAQwADAgIDAgIDAwMDBAMDBAUIBQUEBAUKBwcGCAwKDAwLCgsLDQ4SEA0OEQ4LCxAWEBETFBUVFQwPFxgWFBgSFBUU/9sAQwEDBAQFBAUJBQUJFA0LDRQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU/8AAFAgAEAAQBAERAAIRAQMRAQQRAP/EABYAAQEBAAAAAAAAAAAAAAAAAAAICf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAWAQEBAQAAAAAAAAAAAAAAAAAABwn/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADgQBAAIRAxEEAAA/AKIXNlU1TAAAAf/Z';
const RED_CMYK_JPEG = 'data:image/jpeg;base64,/9j/7gAOQWRvYmUAZAAAAAAA/9sAQwADAgIDAgIDAwMDBAMDBAUIBQUEBAUKBwcGCAwKDAwLCgsLDQ4SEA0OEQ4LCxAWEBETFBUVFQwPFxgWFBgSFBUU/8AAFAgAEAAQBEMRAE0RAFkRAEsRAP/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/aAA4EQwBNAFkASwAAPwD9U6/Kqvyqr9U6KKKKKKKKKKKK/9k=';

describe('Browser - file_parser', () => {
  after(async () => {
    await closeGlobalBrowser();
  });

  test('Browser - convertCmykDataUrlToRgb decodifica CMYK/YCCK de forma nativa a JPEG RGB', async () => {
    const browser = await createTestBrowser();
    try {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.setContent('<!doctype html><html><body></body></html>');
      await page.addScriptTag({ path: path.resolve(__dirname, '../../js/file-parser.js') });

      const results = await page.evaluate(async (inputs) => {
        async function samplePixel(dataUrl) {
          const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
          const canvas = document.createElement('canvas');
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(bitmap, 0, 0);
          return Array.from(ctx.getImageData(8, 8, 1, 1).data.slice(0, 3));
        }
        const output = [];
        for (const input of inputs) {
          const converted = await ChatFileParser.convertCmykDataUrlToRgb(input);
          const bytes = Uint8Array.from(atob(converted.split(',')[1]), c => c.charCodeAt(0));
          let components = 0;
          for (let i = 2; i + 9 < bytes.length; i++) {
            if (bytes[i] === 0xFF && bytes[i + 1] === 0xC0) { components = bytes[i + 9]; break; }
          }
          output.push({ changed: converted !== input, components, pixel: await samplePixel(converted) });
        }
        return output;
      }, [RED_YCCK_JPEG, RED_CMYK_JPEG]);

      for (const result of results) {
        assert.equal(result.changed, true);
        assert.equal(result.components, 3);
        const [r, g, b] = result.pixel;
        assert.ok(r > 200 && g < 80 && b < 80, `se esperaba rojo, se obtuvo ${result.pixel}`);
      }

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
