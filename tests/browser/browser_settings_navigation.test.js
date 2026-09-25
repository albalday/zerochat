const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createTestBrowser, closeGlobalBrowser, seedConnectionProfiles } = require('../helpers/browser-env.js');

describe('Browser UI - Navegación de Configuración Móvil y Sidebar', { concurrency: 1 }, () => {
  after(async () => {
    await closeGlobalBrowser();
  });

  test('Requisitos 1-5, 7-10: flujo de configuración, cabecera de sección y persistencia', { timeout: 10000 }, async () => {
    const browser = await createTestBrowser();
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      page.setDefaultTimeout(3000);
      await seedConnectionProfiles(page);
      await page.goto('file://' + path.resolve(__dirname, '../../zerochat.html'), { waitUntil: 'load' });
      // El contenedor es estático; el formulario se crea bajo demanda al abrir una sección.
      await page.waitForSelector('#settings-dialog', { state: 'attached' });

      const initial = await page.evaluate(() => ({
        chatVisible: !document.getElementById('sidebar-view-chat').hidden,
        settingsHidden: document.getElementById('sidebar-view-settings').hidden,
        dialogOpen: document.getElementById('settings-dialog').open
      }));
      assert.deepEqual(initial, { chatVisible: true, settingsHidden: true, dialogOpen: false });

      await page.locator('#btn-open-settings').evaluate(button => button.click());
      await page.waitForFunction(() => !document.getElementById('sidebar-view-settings').hidden);

      const sidebar = await page.evaluate(() => ({
        mode: document.getElementById('chat-sidebar').classList.contains('mode-settings'),
        languages: document.querySelectorAll('#sidebar-choice-language .btn-lang-toggle').length,
        themes: document.querySelectorAll('#sidebar-choice-theme .btn-theme-toggle').length,
        sections: Array.from(document.querySelectorAll('#sidebar-settings-nav .sidebar-settings-item')).map(item => ({
          id: item.dataset.section,
          icon: Boolean(item.querySelector('svg.ui-icon')),
          label: item.querySelector('.settings-item-label')?.textContent.trim(),
          href: item.getAttribute('href'),
          target: item.getAttribute('target')
        }))
      }));
      assert.equal(sidebar.mode, true);
      assert.equal(sidebar.languages, 2);
      assert.equal(sidebar.themes, 2);
      assert.deepEqual(sidebar.sections.map(item => item.id), ['model', 'agent', 'rag-manage', 'mcp', 'permissions', 'inspector', undefined]);
      assert.ok(sidebar.sections.every(item => item.icon && item.label));
      assert.deepEqual(sidebar.sections.at(-1), { id: undefined, icon: true, label: 'Ayuda', href: 'help/index.html', target: '_blank' });

      const helpPagePromise = page.context().waitForEvent('page');
      await page.locator('#sidebar-settings-help').click();
      const helpPage = await helpPagePromise;
      await helpPage.waitForLoadState();
      assert.equal(await page.evaluate(() => document.getElementById('settings-dialog').open), false, 'Ayuda no debe abrir ningún panel de configuración');
      await helpPage.close();

      await page.locator('#sidebar-choice-language .btn-lang-toggle[data-lang="en"]').evaluate(button => button.click());
      assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
      assert.deepEqual(await page.locator('#sidebar-settings-help').evaluate(link => ({ label: link.textContent.trim(), href: link.getAttribute('href'), target: link.getAttribute('target') })), {
        label: 'Help', href: 'help/en/index.html', target: '_blank'
      });
      await page.locator('#sidebar-choice-language .btn-lang-toggle[data-lang="es"]').evaluate(button => button.click());
      await page.locator('#sidebar-choice-theme .btn-theme-toggle[data-theme="dark"]').evaluate(button => button.click());
      assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-theme')), 'dark');
      await page.locator('#sidebar-choice-theme .btn-theme-toggle[data-theme="light"]').evaluate(button => button.click());

      await page.locator('#btn-sidebar-back-to-chats').evaluate(button => button.click());
      await page.waitForFunction(() => !document.getElementById('sidebar-view-chat').hidden);
      await page.locator('#btn-open-settings').evaluate(button => button.click());
      await page.locator('#sidebar-settings-nav [data-section="agent"]').evaluate(item => item.click());
      await page.waitForFunction(() => document.getElementById('settings-dialog').open);

      const panel = await page.evaluate(() => {
        const dialog = document.getElementById('settings-dialog');
        return {
          activePane: dialog.querySelector('.settings-section-pane.active')?.id,
          oldTabs: dialog.querySelectorAll('.modal-tabs-nav, .modal-tab-btn').length,
          header: Boolean(dialog.querySelector('.settings-section-header')),
          close: Boolean(dialog.querySelector('#btn-close-settings svg')),
          save: Boolean(dialog.querySelector('#btn-save-settings')),
          activeSidebarSection: document.querySelector('#sidebar-settings-nav .sidebar-settings-item.active')?.dataset.section,
          modalFooter: Boolean(dialog.querySelector('.modal-footer')),
          clearInDialog: Boolean(dialog.querySelector('#btn-clear-all-data'))
        };
      });
      assert.deepEqual(panel, {
        activePane: 'settings-agent', oldTabs: 0, header: true, close: true, save: true,
        activeSidebarSection: 'agent', modalFooter: false, clearInDialog: false
      });

      await page.locator('#btn-close-settings').evaluate(button => button.click());
      await page.waitForFunction(() => !document.getElementById('settings-dialog').open);
      assert.equal(await page.locator('#sidebar-view-settings #btn-clear-all-data').count(), 1);
      await page.locator('#sidebar-view-settings #btn-clear-all-data').evaluate(button => button.click());
      await page.waitForFunction(() => document.getElementById('notice-dialog').open);
      await page.locator('#notice-cancel').evaluate(button => button.click());
      await page.waitForFunction(() => !document.getElementById('notice-dialog').open);

      await page.locator('#sidebar-settings-nav [data-section="model"]').evaluate(item => item.click());
      await page.waitForFunction(() => document.getElementById('settings-dialog').open);
      await page.fill('#setting-system-data-prompt', 'Instrucción de prueba persistencia');
      await page.locator('#btn-save-settings').evaluate(button => button.click());
      await page.waitForFunction(() => !document.getElementById('settings-dialog').open);
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('zerochat_runtime_config_v2')).systemDataPrompt), 'Instrucción de prueba persistencia');
    } finally {
      await browser.close();
    }
  });

  test('Requisito 6: en móvil, seleccionar sección cierra el sidebar y cerrar el panel lo recupera', { timeout: 10000 }, async () => {
    const browser = await createTestBrowser();
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      page.setDefaultTimeout(3000);
      await seedConnectionProfiles(page);
      await page.goto('file://' + path.resolve(__dirname, '../../zerochat.html'), { waitUntil: 'load' });
      // El formulario de ajustes se monta bajo demanda al abrir una sección.
      await page.waitForSelector('#settings-dialog', { state: 'attached' });

      const sidebarOpen = await page.evaluate(() => !document.getElementById('chat-sidebar').classList.contains('sidebar-hidden'));
      if (sidebarOpen) {
        await page.locator('#btn-close-sidebar').evaluate(button => button.click());
        await page.waitForFunction(() => document.getElementById('chat-sidebar').classList.contains('sidebar-hidden'));
      }
      await page.locator('#btn-toggle-sidebar').evaluate(button => button.click());
      await page.waitForFunction(() => !document.getElementById('chat-sidebar').classList.contains('sidebar-hidden'));
      await page.locator('#btn-open-settings').evaluate(button => button.click());
      await page.locator('#sidebar-settings-nav [data-section="model"]').evaluate(item => item.click());
      await page.waitForFunction(() => document.getElementById('settings-dialog').open);
      await page.evaluate(() => Promise.all(
        document.getElementById('settings-dialog').getAnimations().map(animation => animation.finished.catch(() => {}))
      ));

      const mobileOpen = await page.evaluate(() => ({
        sidebarHidden: document.getElementById('chat-sidebar').classList.contains('sidebar-hidden'),
        dialogWidth: Math.round(document.getElementById('settings-dialog').getBoundingClientRect().width),
        layoutWidth: document.documentElement.clientWidth
      }));
      assert.equal(mobileOpen.sidebarHidden, true);
      assert.equal(mobileOpen.dialogWidth, mobileOpen.layoutWidth);

      await page.locator('#btn-close-settings').evaluate(button => button.click());
      await page.waitForFunction(() => !document.getElementById('settings-dialog').open);
      const mobileClosed = await page.evaluate(() => ({
        sidebarHidden: document.getElementById('chat-sidebar').classList.contains('sidebar-hidden'),
        settingsVisible: !document.getElementById('sidebar-view-settings').hidden
      }));
      assert.deepEqual(mobileClosed, { sidebarHidden: false, settingsVisible: true });
    } finally {
      await browser.close();
    }
  });
});
