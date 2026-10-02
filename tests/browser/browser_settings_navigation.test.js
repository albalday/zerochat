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
      assert.deepEqual(sidebar.sections.map(item => item.id), ['model', 'agent', 'rag', 'mcp', 'permissions', 'encryption', undefined]);
      assert.ok(sidebar.sections.every(item => item.icon && item.label));
      assert.deepEqual(sidebar.sections.at(-1), { id: undefined, icon: true, label: 'Ayuda', href: 'help/index.html', target: '_blank' });

      await page.locator('#sidebar-settings-nav [data-section="encryption"]').evaluate(item => item.click());
      await page.waitForFunction(() => !document.getElementById('sidebar-encryption-nav').hidden);
      assert.deepEqual(await page.$$eval('#sidebar-encryption-nav .sidebar-settings-item', items => items.map(item => item.textContent.trim())), ['Volver', 'Nueva contraseña', 'Usar predeterminada']);
      assert.equal(await page.locator('#btn-encryption-back use').getAttribute('href'), '#icon-arrow-left');
      assert.equal(await page.locator('#sidebar-settings-nav').isHidden(), true);
      await page.locator('#btn-encryption-back').evaluate(button => button.click());
      await page.waitForFunction(() => !document.getElementById('sidebar-settings-nav').hidden);

      await page.locator('#sidebar-settings-nav [data-section="rag"]').evaluate(item => item.click());
      await page.waitForFunction(() => !document.getElementById('sidebar-rag-nav').hidden);
      assert.deepEqual(await page.$$eval('#sidebar-rag-nav .sidebar-settings-item', items => items.map(item => item.textContent.trim())), ['Volver', 'Ramas', 'Activar']);
      assert.equal(await page.locator('#btn-rag-activate use').getAttribute('href'), '#icon-check-circle');
      await page.locator('#btn-rag-branches').evaluate(button => button.click());
      await page.waitForSelector('#rag-manage-modal[open]');
      assert.equal(await page.locator('#rag-manage-modal h3').textContent(), 'RAG-Ramas');
      await page.locator('#btn-close-rag-manage').evaluate(button => button.click());
      await page.locator('#btn-rag-activate').evaluate(button => button.click());
      await page.waitForSelector('#rag-modal[open]');
      assert.equal(await page.locator('#rag-storage-quota-info').count(), 0);
      await page.locator('#btn-close-rag').evaluate(button => button.click());
      await page.locator('#btn-rag-back').evaluate(button => button.click());
      await page.waitForFunction(() => !document.getElementById('sidebar-settings-nav').hidden);

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

  test('RAG: el progreso y los resultados de ingesta no desbordan en móvil', async () => {
    const browser = await createTestBrowser();
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await page.goto('file://' + path.resolve(__dirname, '../../zerochat.html'), { waitUntil: 'load' });
      await page.evaluate(() => {
        const modal = document.getElementById('rag-manage-modal');
        modal.innerHTML = `<div class="modal-body"><div id="rag-ingestion-progress">
          <div class="rag-ingestion-global-progress"><div><strong>Carga global: 1 de 1</strong><span>1 indexado</span></div><progress max="100" value="100"></progress><div style="display:inline-flex; align-items:center; gap:0.5rem;"><span>100%</span><button type="button" class="rag-stop-ingestion-btn">Detener</button></div></div>
          <div class="rag-ingestion-progress-recent"><div class="rag-ingestion-progress-item error"><strong>documento-con-un-nombre-muy-largo-sin-espacios-para-comprobar-el-ajuste-en-movil.pdf</strong><span>Error-de-ingesta-con-un-texto-muy-largo-sin-espacios-que-debe-ajustarse</span><progress max="100" value="100"></progress></div></div>
        </div></div>`;
        modal.showModal();
      });
      const dimensions = await page.evaluate(() => Array.from(document.querySelectorAll('.rag-ingestion-global-progress, .rag-ingestion-progress-item')).map(element => ({
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth
      })));
      assert.ok(dimensions.every(({ clientWidth, scrollWidth }) => scrollWidth <= clientWidth), 'Los controles y resultados de ingesta deben ajustarse al ancho móvil');
    } finally {
      await browser.close();
    }
  });
  test('Agente y Permisos comparten superficies suaves y controles accesibles en móvil', { timeout: 30000 }, async () => {
    const browser = await createTestBrowser();
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(3000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => {
        if (message.type() === 'error') errors.push(message.text());
      });
      await seedConnectionProfiles(page);
      await page.goto('file://' + path.resolve(__dirname, '../../zerochat.html'), { waitUntil: 'load' });
      await page.locator('#btn-open-settings').evaluate(button => button.click());
      await page.locator('#sidebar-settings-nav [data-section="agent"]').evaluate(button => button.click());
      await page.waitForSelector('#settings-dialog[open]');
      await page.evaluate(() => Promise.all(document.getElementById('settings-dialog').getAnimations().map(animation => animation.finished.catch(() => {}))));

      for (const section of ['agent', 'permissions']) {
        if (section === 'permissions') {
          await page.locator('#btn-close-settings').click();
          await page.waitForSelector('#notice-dialog[open]');
          await page.locator('#notice-accept').click();
          await page.waitForFunction(() => !document.getElementById('settings-dialog').open);
          await page.locator('#sidebar-settings-nav [data-section="permissions"]').evaluate(button => button.click());
          await page.evaluate(() => {
            window.ChatToolSecurity.manager.setToolPolicy('mcp_layout_test', 'allow', { originalName: 'tool_with_a_very_long_name_for_mobile_permissions_layout', constraints: { path: { allowedDirectories: ['/a/very/long/path/to/a/workspace/that/needs/to/fit/inside/mobile/permissions'] } } });
          });
        }
        for (const width of [320, 390, 768, 1280]) {
          await page.setViewportSize({ width, height: 844 });
          for (const language of ['es', 'en']) {
            for (const theme of ['light', 'dark']) {
              const layout = await page.evaluate(({ section, language, theme }) => {
                window.ChatI18n.setLanguage(language, false);
                document.documentElement.setAttribute('data-theme', theme);
                if (section === 'permissions') window.ChatUIMcp.renderSavedAuthorizations();
                const panel = document.getElementById(`settings-${section}`);
                const directoryStyle = getComputedStyle(document.getElementById('mcp-directory-rules'));
                const referenceInputStyle = getComputedStyle(document.getElementById('setting-system-data-prompt'));
                const blocks = Array.from(panel.querySelectorAll(section === 'agent' ? '.form-field' : '.mcp-status-card'));
                const items = Array.from(panel.querySelectorAll(section === 'agent' ? '.setting-toggle-card' : '.mcp-policy-options, .mcp-auth-item'));
                return {
                  overflow: panel.scrollWidth > panel.clientWidth + 1,
                  fullWidth: blocks.every(block => Math.abs(block.getBoundingClientRect().width - panel.getBoundingClientRect().width) < 1),
                  borderless: [...blocks, ...items].every(item => getComputedStyle(item).borderLeftWidth === '0px'),
                  softBackground: items.every(item => getComputedStyle(item).backgroundColor !== getComputedStyle(document.getElementById('settings-dialog')).backgroundColor),
                  itemCount: items.length,
                  directoryFieldThemed: section !== 'permissions' || (directoryStyle.backgroundColor === referenceInputStyle.backgroundColor && directoryStyle.color === referenceInputStyle.color),
                  controlsFit: Array.from(panel.querySelectorAll('.switch, input[type="radio"], .btn-revoke-auth, #btn-mcp-clear-auths')).every(control => {
                    const rect = control.getBoundingClientRect();
                    const bounds = panel.getBoundingClientRect();
                    return rect.width > 0 && rect.left >= bounds.left && rect.right <= bounds.right + 1;
                  })
                };
              }, { section, language, theme });
              const context = `${section} ${width}px ${language} ${theme}`;
              assert.equal(layout.overflow, false, context);
              assert.equal(layout.fullWidth, true, context);
              assert.equal(layout.borderless, true, context);
              assert.equal(layout.softBackground, true, context);
              assert.equal(layout.controlsFit, true, context);
              assert.equal(layout.directoryFieldThemed, true, context);
              assert.ok(layout.itemCount > 0, context);
            }
          }
        }
        if (section === 'agent') {
          const checkbox = page.locator('#settings-agent .agent-tool-checkbox:not([data-tool-id="browser_action"])').first();
          const before = await checkbox.isChecked();
          await checkbox.locator('..').click();
          assert.equal(await checkbox.isChecked(), !before);
          await checkbox.locator('..').click();
        } else {
          await page.locator('#mcp-policy-workspace-trust').check();
          assert.equal(await page.locator('#mcp-policy-workspace-trust').isChecked(), true);
          await page.locator('#mcp-policy-ask').check();
          await page.locator('#settings-permissions .btn-revoke-auth').click();
          assert.equal(await page.locator('#settings-permissions .mcp-auth-item').count(), 0);
          assert.equal(await page.locator('#btn-mcp-clear-auths').isHidden(), true);
        }
      }
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });

  test('MCP y RAG comparten cabecera, superficies suaves y botones de peligro con el resto de paneles', { timeout: 30000 }, async () => {
    const browser = await createTestBrowser();
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(3000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await seedConnectionProfiles(page);
      await page.goto('file://' + path.resolve(__dirname, '../../zerochat.html'), { waitUntil: 'load' });
      await page.evaluate(async () => {
        const branch = await window.ChatRagStorage.createBranch('Rama-con-un-nombre-muy-largo-para-comprobar-el-ajuste-en-movil', 'Descripción de prueba');
        await window.ChatRagStorage.saveDocument({
          branchId: branch.id,
          title: 'documento-con-un-nombre-muy-largo-sin-espacios-para-comprobar-el-ajuste.md',
          fileType: 'md',
          chunks: [{ content: 'Contenido de prueba' }]
        });
      });

      const panels = [
        {
          name: 'mcp',
          open: async () => {
            await page.locator('#btn-open-settings').evaluate(button => button.click());
            await page.locator('#sidebar-settings-nav [data-section="mcp"]').evaluate(button => button.click());
            await page.waitForSelector('#settings-dialog[open]');
            await page.evaluate(() => window.ChatUIMcp.renderExternalServers(document.getElementById('mcp-servers-list'), [
              { id: 'servidor-largo', displayName: 'Servidor-MCP-con-un-nombre-muy-largo-sin-espacios', status: 'running', description: 'Descripción' }
            ]));
          },
          dialog: '#settings-dialog',
          surfaces: '#mcp-bootstrap-card, .mcp-server-item',
          danger: '.btn-mcp-server-toggle[data-action="stop"]',
          close: () => page.evaluate(() => document.getElementById('settings-dialog').close())
        },
        {
          name: 'rag-activate',
          open: async () => {
            await page.evaluate(() => window.ChatRagUI.openActivationModal());
            await page.waitForSelector('#rag-active-branch-list .rag-branch-select-card');
          },
          dialog: '#rag-modal',
          surfaces: '.setting-toggle-card, .rag-help-link-card, .rag-active-tip-card',
          danger: null,
          close: () => page.locator('#btn-close-rag').click()
        },
        {
          name: 'rag-manage',
          open: async () => {
            await page.evaluate(() => window.ChatRagUI.openManageModal());
            await page.waitForSelector('#rag-manage-workspace .rag-document-card');
          },
          dialog: '#rag-manage-modal',
          surfaces: '.rag-branch-details-card, .rag-document-card',
          danger: '#btn-rag-delete-branch, .btn-rag-delete-document',
          close: () => page.locator('#btn-close-rag-manage').click()
        }
      ];

      for (const panel of panels) {
        await panel.open();
        for (const width of [320, 390, 768, 1280]) {
          await page.setViewportSize({ width, height: 844 });
          for (const theme of ['light', 'dark']) {
            const layout = await page.evaluate(({ dialogSelector, surfaces, danger, theme }) => {
              document.documentElement.setAttribute('data-theme', theme);
              const dialog = document.querySelector(dialogSelector);
              const header = dialog.querySelector('.modal-header');
              const body = dialog.querySelector('.modal-body');
              const dialogBackground = getComputedStyle(dialog).backgroundColor;
              const surfaceElements = Array.from(dialog.querySelectorAll(surfaces));
              const dangerElements = danger ? Array.from(dialog.querySelectorAll(danger)) : [];
              const fits = element => element.scrollWidth <= element.clientWidth + 1;
              return {
                sharedHeader: header.classList.contains('settings-section-header') && !!header.querySelector(':scope > .settings-header-actions'),
                headerFits: fits(header),
                bodyFits: fits(body),
                fullScreenOnMobile: window.innerWidth > 768 || Math.abs(dialog.getBoundingClientRect().height - window.innerHeight) < 1,
                surfaceCount: surfaceElements.length,
                softSurfaces: surfaceElements.every(element => {
                  const style = getComputedStyle(element);
                  return style.borderLeftWidth === '0px' && style.backgroundColor !== dialogBackground;
                }),
                dangerCount: dangerElements.length,
                dangerUnified: dangerElements.every(element => element.classList.contains('btn-danger-outline'))
              };
            }, { dialogSelector: panel.dialog, surfaces: panel.surfaces, danger: panel.danger, theme });
            const context = `${panel.name} ${width}px ${theme}`;
            assert.equal(layout.sharedHeader, true, context);
            assert.equal(layout.headerFits, true, context);
            assert.equal(layout.bodyFits, true, context);
            assert.equal(layout.fullScreenOnMobile, true, context);
            assert.ok(layout.surfaceCount > 0, context);
            assert.equal(layout.softSurfaces, true, context);
            if (panel.danger) assert.ok(layout.dangerCount > 0, context);
            assert.equal(layout.dangerUnified, true, context);
          }
        }
        await panel.close();
      }
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
});
