const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestBrowser, closeGlobalBrowser, getIndexUrl, waitForAppReady } = require('../helpers/browser-env.js');

describe('Browser UI - debug panel', { concurrency: 2 }, () => {
  after(async () => {
    await closeGlobalBrowser();
  });

  test('el panel de depuración expone filtros accesibles y sigue el final del log salvo que el usuario suba', async () => {
    const browser = await createTestBrowser();
    try {
      const page = await browser.newPage();
      const pageErrors = [];
      page.on('pageerror', error => pageErrors.push(error.message));
      await page.goto(getIndexUrl(), { waitUntil: 'load' });
      await waitForAppReady(page);

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

      const scroll = await page.evaluate(() => {
        const log = document.getElementById('debug-log-content');
        const atBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight <= 1;
        const fill = n => { for (let i = 0; i < n; i++) window.ChatDebug.addLog('network', `entrada ${i}`); };
        document.querySelector('[data-debug-tab="all"]').click();
        fill(60);
        const followed = atBottom();
        log.dispatchEvent(new WheelEvent('wheel', { deltaY: -120 }));
        log.scrollTo({ top: 0, behavior: 'instant' });
        fill(5);
        const kept = log.scrollTop;
        document.querySelector('[data-debug-tab="network"]').click();
        return { hasToggle: !!document.getElementById('btn-toggle-autoscroll'), scrollable: log.scrollHeight > log.clientHeight, followed, kept, resumedOnTab: atBottom() };
      });
      assert.deepEqual(scroll, { hasToggle: false, scrollable: true, followed: true, kept: 0, resumedOnTab: true });
      assert.deepEqual(pageErrors, []);
    } finally {
      await browser.close();
    }
  });

  test('en móvil el panel de depuración ocupa todo el ancho', async () => {
    const browser = await createTestBrowser();
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await page.goto(getIndexUrl(), { waitUntil: 'load' });
      await waitForAppReady(page);
      await page.evaluate(() => document.getElementById('btn-toggle-debug').click());
      const rect = await page.evaluate(() => {
        const { left, width } = document.getElementById('debug-panel').getBoundingClientRect();
        return { left, width };
      });
      assert.deepEqual(rect, { left: 0, width: 390 });
    } finally {
      await browser.close();
    }
  });

  test('el editor de mensaje saliente sitúa las acciones de envío en la cabecera', async () => {
    const browser = await createTestBrowser();
    try {
      const page = await browser.newPage();
      await page.goto(getIndexUrl(), { waitUntil: 'load' });
      await waitForAppReady(page);
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
