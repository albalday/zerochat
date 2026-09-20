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

  test('el editor de mensaje saliente sitúa las acciones de envío en la cabecera', async () => {
    const browser = await createTestBrowser();
    try {
      const page = await browser.newPage();
      await page.goto('file://' + path.resolve(__dirname, '../../zerochat.html'), { waitUntil: 'load' });
      await page.waitForFunction(() => document.documentElement.classList.contains('zerochat-ready'));
      await page.evaluate(() => {
        window.__debugInterceptorResult = window.ChatDebug.openInterceptorModal({
          endpoint: '/v1/chat/completions', headers: {}, payload: { model: 'test', messages: [] }
        });
      });
      const layout = await page.evaluate(() => {
        const dialog = document.getElementById('debug-interceptor-dialog');
        const header = dialog.querySelector('.modal-header');
        return {
          hasClose: !!dialog.querySelector('#btn-close-debug-modal'),
          sendInHeader: header.contains(dialog.querySelector('#btn-debug-send')),
          sendDisableInHeader: header.contains(dialog.querySelector('#btn-debug-send-disable')),
          hasFooter: !!dialog.querySelector('.debug-modal-footer')
        };
      });
      assert.equal(layout.hasClose, true);
      assert.equal(layout.sendInHeader, true);
      assert.equal(layout.sendDisableInHeader, true);
      assert.equal(layout.hasFooter, false);
      await page.click('#btn-close-debug-modal');
      await page.evaluate(() => window.__debugInterceptorResult);
    } finally {
      await browser.close();
    }
  });
});
