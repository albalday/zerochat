const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const { withTestApp, closeGlobalBrowser } = require('../helpers/browser-env.js');

describe('Browser UI - debug panel', { concurrency: 2 }, () => {
  after(async () => {
    await closeGlobalBrowser();
  });

  test('el panel de depuración expone filtros accesibles y sigue el final del log salvo que el usuario suba', async () => {
    await withTestApp(async page => {
      const pageErrors = [];
      page.on('pageerror', error => pageErrors.push(error.message));

      await page.click('#btn-toggle-debug');
      const opened = await page.evaluate(() => ({
        display: getComputedStyle(document.getElementById('debug-panel')).display,
        panelHidden: document.getElementById('debug-panel').hidden,
        triggerExpanded: document.getElementById('btn-toggle-debug').getAttribute('aria-expanded'),
        filtersRole: document.querySelector('.debug-tabs').getAttribute('role')
      }));
      assert.equal(opened.display, 'flex');
      assert.equal(opened.panelHidden, false);
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
    });
  });

});
