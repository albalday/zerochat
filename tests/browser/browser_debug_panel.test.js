const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createTestBrowser, closeGlobalBrowser } = require('../helpers/browser-env.js');

describe('Browser UI - debug panel', { concurrency: 2 }, () => {
  after(async () => {
    await closeGlobalBrowser();
  });

  test('el panel de depuración usa superficie temática y filtros accesibles', async () => {
    const browser = await createTestBrowser();
    try {
      const page = await browser.newPage();
      await page.goto('file://' + path.resolve(__dirname, '../../zerochat.html'), { waitUntil: 'load' });
      await page.waitForFunction(() => document.documentElement.classList.contains('zerochat-ready'));

      await page.click('#btn-toggle-debug');
      const opened = await page.evaluate(() => ({
        display: getComputedStyle(document.getElementById('debug-panel')).display,
        panelHidden: document.getElementById('debug-panel').getAttribute('aria-hidden'),
        triggerExpanded: document.getElementById('btn-toggle-debug').getAttribute('aria-expanded'),
        filtersRole: document.querySelector('.debug-tabs').getAttribute('role')
      }));
      assert.equal(opened.display, 'flex');
      assert.equal(opened.panelHidden, 'false');
      assert.equal(opened.triggerExpanded, 'true');
      assert.equal(opened.filtersRole, 'group');

      await page.click('[data-debug-tab="network"]');
      const selected = await page.evaluate(() => Array.from(document.querySelectorAll('.debug-tab')).map(tab => ({
        filter: tab.dataset.debugTab,
        pressed: tab.getAttribute('aria-pressed'),
        active: tab.classList.contains('active')
      })));
      assert.deepEqual(selected.find(tab => tab.filter === 'network'), { filter: 'network', pressed: 'true', active: true });
      assert.equal(selected.filter(tab => tab.pressed === 'true').length, 1);
    } finally {
      await browser.close();
    }
  });
});
