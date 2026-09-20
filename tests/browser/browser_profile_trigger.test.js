const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createTestBrowser, closeGlobalBrowser } = require('../helpers/browser-env.js');

describe('Browser UI - profile trigger', { concurrency: 2 }, () => {
  after(async () => {
    await closeGlobalBrowser();
  });

  test('el selector de perfiles conserva un ancho utilizable en la cabecera', async () => {
    const browser = await createTestBrowser();
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.goto('file://' + path.resolve(__dirname, '../../zerochat.html'), { waitUntil: 'load' });
      await page.waitForFunction(() => document.documentElement.classList.contains('zerochat-ready'));

      const layout = await page.evaluate(() => {
        const trigger = document.getElementById('active-profile-trigger').getBoundingClientRect();
        const name = document.getElementById('active-profile-name');
        return { triggerWidth: trigger.width, nameWidth: name.getBoundingClientRect().width };
      });
      assert.ok(layout.triggerWidth >= 136, `El selector no debe colapsar (${layout.triggerWidth}px)`);
      assert.ok(layout.nameWidth > 0, 'El nombre activo debe conservar espacio visible');
    } finally {
      await browser.close();
    }
  });
});
