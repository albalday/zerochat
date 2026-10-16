const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestBrowser, closeGlobalBrowser, getIndexUrl, waitForAppReady } = require('../helpers/browser-env.js');

describe('Browser - vendor loader', () => {
  after(async () => {
    await closeGlobalBrowser();
  });

  test('Browser - ChatVendorLoader inyecta los bundles una vez en file:// y explica el fallo sin conexión', async () => {
    const browser = await createTestBrowser();
    try {
      const page = await browser.newPage();
      await page.goto(getIndexUrl(), { waitUntil: 'load' });
      await waitForAppReady(page);

      const loaded = await page.evaluate(async () => {
        window.ZeroChatOrama = undefined;
        const [a, b] = await Promise.all([ChatVendorLoader.load('orama'), ChatVendorLoader.load('orama')]);
        return {
          same: a === b && a === window.ZeroChatOrama,
          hasSearch: typeof a.search === 'function',
          injected: document.querySelectorAll('script[src="js/vendor/orama.browser.js"]').length
        };
      });
      assert.deepEqual(loaded, { same: true, hasSearch: true, injected: 2 });

      const office = await page.evaluate(async () => {
        const [mammoth, fflate] = await Promise.all(['mammoth', 'fflate'].map(id => ChatVendorLoader.load(id)));
        return { mammoth: typeof mammoth.convertToHtml, fflate: typeof fflate.unzipSync };
      });
      assert.deepEqual(office, { mammoth: 'function', fflate: 'function' });

      const failure = await page.evaluate(async () => {
        try {
          await ChatVendorLoader.load('missing-library');
          return null;
        } catch (error) {
          return { code: error.code, message: error.message, leftover: document.querySelectorAll('script[src*="missing-library"]').length };
        }
      });
      assert.equal(failure.code, 'VENDOR_UNAVAILABLE');
      assert.match(failure.message, /first use/);
      assert.equal(failure.leftover, 0);
    } finally {
      await browser.close();
    }
  });
});
