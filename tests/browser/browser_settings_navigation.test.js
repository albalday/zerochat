const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createTestBrowser, closeGlobalBrowser, seedConnectionProfiles } = require('../helpers/browser-env.js');

describe('Browser UI - Navegación de Configuración Móvil y Sidebar', { concurrency: 1 }, () => {
  after(async () => {
    await closeGlobalBrowser();
  });

  test('Requisitos 1-5, 7-10: Flujo de navegación de configuración, cabecera de sección, sin pestañas y persistencia', async () => {
    const browser = await createTestBrowser();
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await seedConnectionProfiles(page);
      const filePath = 'file://' + path.resolve(__dirname, '../../zerochat.html');
      await page.goto(filePath, { waitUntil: 'load' });
      await page.waitForSelector('#welcome-banner');

      // Estado inicial: sidebar en modo chat
      const initialMode = await page.evaluate(() => ({
        chatVisible: !document.getElementById('sidebar-view-chat').hidden && getComputedStyle(document.getElementById('sidebar-view-chat')).display !== 'none',
        settingsHidden: document.getElementById('sidebar-view-settings').hidden || getComputedStyle(document.getElementById('sidebar-view-settings')).display === 'none',
        dialogOpen: document.getElementById('settings-dialog').open
      }));
      assert.equal(initialMode.chatVisible, true, 'Inicialmente la vista de chat debe ser visible');
      assert.equal(initialMode.settingsHidden, true, 'Inicialmente la vista de configuración debe estar oculta');
      assert.equal(initialMode.dialogOpen, false, 'El diálogo de configuración debe estar cerrado');

      // Req 1: Clic en configuración conmuta el sidebar a modo configuración
      await page.click('#btn-open-settings');
      const settingsMode = await page.evaluate(() => ({
        chatHidden: document.getElementById('sidebar-view-chat').hidden || getComputedStyle(document.getElementById('sidebar-view-chat')).display === 'none',
        settingsVisible: !document.getElementById('sidebar-view-settings').hidden && getComputedStyle(document.getElementById('sidebar-view-settings')).display !== 'none',
        hasModeClass: document.getElementById('chat-sidebar').classList.contains('mode-settings')
      }));
      assert.equal(settingsMode.chatHidden, true, 'Al conmutar, la vista de chat debe ocultarse');
      assert.equal(settingsMode.settingsVisible, true, 'Al conmutar, la vista de configuración debe ser visible');
      assert.equal(settingsMode.hasModeClass, true, 'El sidebar debe recibir la clase mode-settings');

      // Req 2: Las elecciones directas de idioma y tema figuran en primer lugar
      const choicesInfo = await page.evaluate(() => {
        const langChoice = document.getElementById('sidebar-choice-language');
        const themeChoice = document.getElementById('sidebar-choice-theme');
        const langButtons = Array.from(langChoice ? langChoice.querySelectorAll('.btn-lang-toggle') : []);
        const themeButtons = Array.from(themeChoice ? themeChoice.querySelectorAll('.btn-theme-toggle') : []);
        return {
          hasLangChoice: !!langChoice,
          hasThemeChoice: !!themeChoice,
          langButtons: langButtons.map(b => ({ lang: b.getAttribute('data-lang'), text: b.textContent.trim(), active: b.classList.contains('active') })),
          themeButtons: themeButtons.map(b => ({ theme: b.getAttribute('data-theme'), hasSvg: !!b.querySelector('svg'), active: b.classList.contains('active') }))
        };
      });
      assert.ok(choicesInfo.hasLangChoice, 'Debe existir la elección de idioma en el sidebar');
      assert.ok(choicesInfo.hasThemeChoice, 'Debe existir la elección de tema en el sidebar');
      assert.equal(choicesInfo.langButtons.length, 2, 'Deben existir 2 opciones de idioma (ES/EN)');
      assert.equal(choicesInfo.themeButtons.length, 2, 'Deben existir 2 opciones de tema (claro/oscuro)');

      // Probar alternar idioma directamente desde el sidebar
      await page.click('#sidebar-choice-language .btn-lang-toggle[data-lang="en"]');
      assert.equal(await page.evaluate(() => document.documentElement.lang), 'en', 'Cambiar a inglés debe actualizar el atributo lang');
      await page.click('#sidebar-choice-language .btn-lang-toggle[data-lang="es"]');
      assert.equal(await page.evaluate(() => document.documentElement.lang), 'es', 'Cambiar a español debe restaurar lang="es"');

      // Probar alternar tema directamente desde el sidebar
      await page.click('#sidebar-choice-theme .btn-theme-toggle[data-theme="dark"]');
      assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-theme')), 'dark', 'Cambiar a tema oscuro debe actualizar data-theme="dark"');
      assert.equal(await page.evaluate(() => document.querySelector('#sidebar-choice-theme .btn-theme-toggle[data-theme="dark"]').classList.contains('active')), true);
      await page.click('#sidebar-choice-theme .btn-theme-toggle[data-theme="light"]');
      assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-theme')), null, 'Cambiar a tema claro debe retirar data-theme="dark"');
      assert.equal(await page.evaluate(() => document.querySelector('#sidebar-choice-theme .btn-theme-toggle[data-theme="light"]').classList.contains('active')), true);

      // Req 2b: La lista de 5 secciones de panel aparece con sus elementos correctos e iconos SVG
      const sectionsInfo = await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll('#sidebar-settings-nav .sidebar-settings-item'));
        return {
          count: items.length,
          sections: items.map(item => ({
            section: item.getAttribute('data-section'),
            hasSvg: !!item.querySelector('svg.ui-icon'),
            hasChevron: !!item.querySelector('.sidebar-settings-chevron, svg'),
            hasText: !!item.querySelector('.settings-item-label')?.textContent?.trim(),
            rawText: item.textContent
          }))
        };
      });
      assert.equal(sectionsInfo.count, 6, 'Debe haber exactamente 6 secciones en la lista de navegación');
      const expectedSections = ['tab-model', 'tab-agent', 'rag-manage', 'tab-mcp', 'tab-permissions', 'tab-inspector'];
      assert.deepEqual(sectionsInfo.sections.map(s => s.section), expectedSections, 'El orden y claves de sección deben coincidir con el diseño');
      assert.ok(sectionsInfo.sections.every(s => s.hasSvg), 'Cada sección debe tener un icono SVG');
      assert.ok(sectionsInfo.sections.every(s => s.hasText), 'Cada sección debe tener un título descriptivo');
      assert.ok(sectionsInfo.sections.every(s => !/🌐|⚙️|🤖|🔌|🔒|🎨|🔍/.test(s.rawText)), 'Ninguna sección debe contener emojis residuales');

      // Req 3: El botón volver restaura el historial sin pérdida de estado
      await page.click('#btn-sidebar-back-to-chats');
      const restoredMode = await page.evaluate(() => ({
        chatVisible: !document.getElementById('sidebar-view-chat').hidden && getComputedStyle(document.getElementById('sidebar-view-chat')).display !== 'none',
        settingsHidden: document.getElementById('sidebar-view-settings').hidden || getComputedStyle(document.getElementById('sidebar-view-settings')).display === 'none',
        hasModeClass: document.getElementById('chat-sidebar').classList.contains('mode-settings')
      }));
      assert.equal(restoredMode.chatVisible, true, 'Volver restaura la vista de chat');
      assert.equal(restoredMode.settingsHidden, true, 'Volver oculta la vista de configuración');
      assert.equal(restoredMode.hasModeClass, false, 'Volver retira la clase mode-settings');

      // Volver a abrir configuración
      await page.click('#btn-open-settings');

      // Req 4 & Req 5: Seleccionar sección abre el contenido exacto y sin pestañas antiguas
      await page.click('[data-section="tab-agent"]');
      await page.waitForFunction(() => document.getElementById('settings-dialog').open);

      const agentSectionState = await page.evaluate(() => {
        const dialog = document.getElementById('settings-dialog');
        const activePane = dialog.querySelector('.settings-section-pane.active');
        const oldTabs = dialog.querySelectorAll('.modal-tabs-nav, .modal-tab-btn');
        const sectionHeader = dialog.querySelector('.settings-section-header');
        const titleEl = document.getElementById('settings-section-title');
        const backBtn = document.getElementById('btn-settings-back');
        const closeBtn = document.getElementById('btn-close-settings');
        const activeSidebarItem = document.querySelector('#sidebar-settings-nav .sidebar-settings-item.active');
        const closeStyles = closeBtn ? getComputedStyle(closeBtn) : null;
        const saveBtn = document.getElementById('btn-save-settings');
        const saveStyles = saveBtn ? getComputedStyle(saveBtn) : null;

        return {
          activePaneId: activePane?.id,
          hasOldTabs: oldTabs.length > 0,
          hasHeader: !!sectionHeader,
          titleText: titleEl?.textContent?.trim(),
          hasBackBtn: !!backBtn && !!backBtn.querySelector('svg'),
          hasCloseBtn: !!closeBtn && !!closeBtn.querySelector('svg'),
          activeSidebarSection: activeSidebarItem?.getAttribute('data-section'),
          closeBorder: closeStyles?.borderStyle !== 'none' && parseFloat(closeStyles?.borderWidth || '0') > 0,
          closeBg: closeStyles?.backgroundColor !== 'rgba(0, 0, 0, 0)' && closeStyles?.backgroundColor !== 'transparent',
          closeHeight: Math.round(parseFloat(closeStyles?.height || '0')),
          saveHeight: Math.round(parseFloat(saveStyles?.height || '0'))
        };
      });

      assert.equal(agentSectionState.activePaneId, 'tab-agent', 'Debe estar activo el panel tab-agent');
      assert.equal(agentSectionState.hasOldTabs, false, 'No deben existir pestañas antiguas dentro de settings-dialog');
      assert.ok(agentSectionState.hasHeader, 'Debe existir la cabecera unificada de sección');
      assert.equal(agentSectionState.hasBackBtn, false, 'La cabecera no debe incluir el botón volver');
      assert.ok(agentSectionState.hasCloseBtn, 'La cabecera debe incluir el botón cerrar con SVG');
      assert.ok(agentSectionState.closeBorder, 'El botón cerrar [X] debe tener borde visible sin hover (remarcada)');
      assert.ok(agentSectionState.closeBg, 'El botón cerrar [X] debe tener fondo visible sin hover (remarcada)');
      assert.equal(agentSectionState.closeHeight, 36, 'El botón cerrar [X] debe tener 36px de altura');
      assert.equal(agentSectionState.saveHeight, 36, 'El botón guardar debe tener la misma altura de 36px que el botón cerrar');
      assert.equal(agentSectionState.activeSidebarSection, 'tab-agent', 'El elemento del sidebar debe marcarse como .active');

      // Req: El botón borrar todo, restaurar, cancelar y la botonera inferior ya no existen dentro del diálogo
      const modalButtonsState = await page.evaluate(() => ({
        hasClear: !!document.querySelector('#settings-dialog #btn-clear-all-data'),
        hasReset: !!document.querySelector('#settings-dialog #btn-reset-settings'),
        hasCancel: !!document.querySelector('#settings-dialog #btn-cancel-settings'),
        hasFooter: !!document.querySelector('#settings-dialog .modal-footer'),
        hasHeaderSave: !!document.querySelector('.settings-section-header #btn-save-settings')
      }));
      assert.equal(modalButtonsState.hasClear, false, 'El botón de borrar todo no debe existir dentro de ningún panel del diálogo');
      assert.equal(modalButtonsState.hasReset, false, 'El botón de restaurar no debe existir dentro de ningún panel del diálogo');
      assert.equal(modalButtonsState.hasCancel, false, 'El botón de cancelar no debe existir dentro de ningún panel del diálogo');
      assert.equal(modalButtonsState.hasFooter, false, 'La botonera inferior modal-footer no debe existir en settings-dialog');
      assert.equal(modalButtonsState.hasHeaderSave, true, 'El botón de guardar debe estar en la cabecera junto a la X');

      // Req: El botón cerrar [X] reabre/mantiene el sidebar en modo configuración
      await page.click('#btn-close-settings');
      await page.waitForFunction(() => !document.getElementById('settings-dialog').open);

      // Los cambios pendientes deben confirmarse antes de cerrar y el rechazo conserva el borrador.
      await page.click('[data-section="tab-model"]');
      await page.waitForFunction(() => document.getElementById('settings-dialog').open);
      await page.fill('#setting-system-data-prompt', 'Borrador sin guardar');
      await page.click('#btn-close-settings');
      await page.waitForFunction(() => document.getElementById('notice-dialog')?.open);
      assert.equal(await page.$eval('#settings-dialog', el => el.open), true, 'Cancelar el descarte debe mantener abierto el diálogo de ajustes');
      await page.click('#notice-cancel');
      await page.waitForFunction(() => !document.getElementById('notice-dialog')?.open);
      assert.equal(await page.inputValue('#setting-system-data-prompt'), 'Borrador sin guardar');
      await page.click('#btn-close-settings');
      await page.waitForFunction(() => document.getElementById('notice-dialog')?.open);
      await page.click('#notice-accept');
      await page.waitForFunction(() => !document.getElementById('settings-dialog').open);

      // Req: El botón borrar todo reside exclusivamente en la parte baja del sidebar de configuración
      const sidebarClearBtn = await page.evaluate(() => {
        const btn = document.querySelector('#sidebar-view-settings .sidebar-settings-footer #btn-clear-all-data');
        return {
          exists: !!btn,
          hasSvg: !!btn?.querySelector('svg'),
          hasTrashIcon: !!btn?.querySelector('use[href*="trash"]'),
          text: btn?.textContent?.trim()
        };
      });
      assert.ok(sidebarClearBtn.exists, 'El botón de borrar todo debe ubicarse en el pie del sidebar de configuración');
      assert.ok(sidebarClearBtn.hasSvg && sidebarClearBtn.hasTrashIcon, 'El botón de borrar todo debe tener icono SVG de papelera');
      assert.equal(sidebarClearBtn.text, 'Borrar todo', 'El texto del botón de borrar todo debe ser correcto');

      // Probar pulsar "Borrar todo" en el sidebar: solicita confirmación y cancelar no borra
      await page.click('#sidebar-view-settings #btn-clear-all-data');
      await page.waitForFunction(() => document.getElementById('notice-dialog')?.open);
      assert.equal(await page.$eval('#notice-dialog', el => el.open), true, 'Pulsar borrar todo debe abrir diálogo de confirmación');
      await page.click('#notice-cancel');
      await page.waitForFunction(() => !document.getElementById('notice-dialog')?.open);

      const afterBackState = await page.evaluate(() => ({
        dialogOpen: document.getElementById('settings-dialog').open,
        settingsVisible: !document.getElementById('sidebar-view-settings').hidden && getComputedStyle(document.getElementById('sidebar-view-settings')).display !== 'none',
        chatHidden: document.getElementById('sidebar-view-chat').hidden || getComputedStyle(document.getElementById('sidebar-view-chat')).display === 'none'
      }));
      assert.equal(afterBackState.dialogOpen, false, 'El diálogo debe cerrarse tras pulsar volver');
      assert.equal(afterBackState.settingsVisible, true, 'El sidebar debe permanecer en modo configuración');
      assert.equal(afterBackState.chatHidden, true, 'La vista de chat debe seguir oculta');

      // Req: El botón cerrar [×] cierra el panel y deja el sidebar en modo configuración
      await page.click('[data-section="tab-mcp"]');
      await page.waitForFunction(() => document.getElementById('settings-dialog').open);
      await page.click('#btn-close-settings');
      await page.waitForFunction(() => !document.getElementById('settings-dialog').open);

      const afterCloseState = await page.evaluate(() => ({
        dialogOpen: document.getElementById('settings-dialog').open,
        settingsVisible: !document.getElementById('sidebar-view-settings').hidden && getComputedStyle(document.getElementById('sidebar-view-settings')).display !== 'none',
        chatHidden: document.getElementById('sidebar-view-chat').hidden || getComputedStyle(document.getElementById('sidebar-view-chat')).display === 'none',
        hasModeClass: document.getElementById('chat-sidebar').classList.contains('mode-settings')
      }));
      assert.equal(afterCloseState.dialogOpen, false, 'El diálogo debe cerrarse tras pulsar cerrar [X]');
      assert.equal(afterCloseState.settingsVisible, true, 'El sidebar debe permanecer en modo configuración tras cerrar con [X]');
      assert.equal(afterCloseState.chatHidden, true, 'La vista de chat no debe aparecer tras cerrar con [X]');
      assert.equal(afterCloseState.hasModeClass, true, 'El sidebar debe mantener mode-settings tras cerrar con [X]');

      // Req: Guardar cambios desde la cabecera mantiene su lógica y persistencia intacta
      await page.click('[data-section="tab-model"]');
      await page.waitForFunction(() => document.getElementById('settings-dialog').open);

      // Modificar un campo y guardar
      await page.fill('#setting-system-data-prompt', 'Instrucción de prueba persistencia');
      await page.click('#btn-save-settings');
      await page.waitForFunction(() => !document.getElementById('settings-dialog').open);

      const afterSaveState = await page.evaluate(() => ({
        dialogOpen: document.getElementById('settings-dialog').open,
        settingsVisible: !document.getElementById('sidebar-view-settings').hidden && getComputedStyle(document.getElementById('sidebar-view-settings')).display !== 'none',
        chatHidden: document.getElementById('sidebar-view-chat').hidden || getComputedStyle(document.getElementById('sidebar-view-chat')).display === 'none',
        hasModeClass: document.getElementById('chat-sidebar').classList.contains('mode-settings')
      }));
      assert.equal(afterSaveState.dialogOpen, false, 'El diálogo debe cerrarse tras Guardar');
      assert.equal(afterSaveState.settingsVisible, true, 'El sidebar debe permanecer en modo configuración tras Guardar');
      assert.equal(afterSaveState.chatHidden, true, 'La vista de chat no debe aparecer tras Guardar');
      assert.equal(afterSaveState.hasModeClass, true, 'El sidebar debe mantener mode-settings tras Guardar');

      const persistedConfig = await page.evaluate(() => {
        const raw = localStorage.getItem('zerochat_runtime_config_v2');
        return raw ? JSON.parse(raw) : null;
      });
      assert.ok(persistedConfig, 'La configuración debe persistirse en localStorage');
      assert.equal(persistedConfig.systemDataPrompt, 'Instrucción de prueba persistencia', 'El cambio debe guardarse correctamente');
    } finally {
      await browser.close();
    }
  });

  test('Requisito 6: En viewport móvil (<= 768px), seleccionar sección auto-cierra el sidebar y volver reabre el sidebar de configuración', async () => {
    const browser = await createTestBrowser();
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await seedConnectionProfiles(page);
      const filePath = 'file://' + path.resolve(__dirname, '../../zerochat.html');
      await page.goto(filePath, { waitUntil: 'load' });
      await page.waitForSelector('#welcome-banner');

      // Cerrar sidebar si está abierto para probar apertura con botón toggle del header
      const sidebarIsInitialOpen = await page.evaluate(() => {
        const sidebar = document.getElementById('chat-sidebar');
        return sidebar && !sidebar.classList.contains('sidebar-hidden') && getComputedStyle(sidebar).display !== 'none';
      });
      if (sidebarIsInitialOpen) {
        await page.click('#btn-close-sidebar');
        await page.waitForFunction(() => {
          const toggle = document.getElementById('btn-toggle-sidebar');
          return toggle && getComputedStyle(toggle).display !== 'none';
        });
      }

      await page.click('#btn-toggle-sidebar');
      await page.waitForFunction(() => {
        const sidebar = document.getElementById('chat-sidebar');
        return sidebar && !sidebar.classList.contains('sidebar-hidden') && getComputedStyle(sidebar).display !== 'none';
      });

      // Pasar a modo configuración
      await page.click('#btn-open-settings');
      await page.waitForSelector('#sidebar-settings-nav');

      // Req 6: Seleccionar sección auto-cierra el sidebar en móvil
      await page.click('[data-section="tab-model"]');
      await page.waitForFunction(() => document.getElementById('settings-dialog').open);

      const mobileSidebarClosed = await page.evaluate(() => {
        const sidebar = document.getElementById('chat-sidebar');
        return sidebar.classList.contains('sidebar-hidden') || getComputedStyle(sidebar).display === 'none';
      });
      assert.equal(mobileSidebarClosed, true, 'En viewport móvil, al seleccionar una sección el sidebar debe auto-cerrarse');

      // Validar dimensiones a pantalla completa del diálogo en móvil (100dvh / 100vw)
      await page.evaluate(() => Promise.all(document.getElementById('settings-dialog').getAnimations().map(a => a.finished)));
      const dialogMobileBox = await page.evaluate(() => {
        const dialog = document.getElementById('settings-dialog');
        const rect = dialog.getBoundingClientRect();
        return {
          width: Math.round(rect.width),
          windowWidth: window.innerWidth
        };
      });
      assert.equal(dialogMobileBox.width, dialogMobileBox.windowWidth, 'El modal de sección debe ocupar todo el ancho en móvil');

      // Req en móvil: Botón cerrar [X] reabre el sidebar en modo configuración
      await page.click('#btn-close-settings');
      await page.waitForFunction(() => !document.getElementById('settings-dialog').open);

      const mobileSidebarReopened = await page.evaluate(() => {
        const sidebar = document.getElementById('chat-sidebar');
        const isSettingsVisible = !document.getElementById('sidebar-view-settings').hidden && getComputedStyle(document.getElementById('sidebar-view-settings')).display !== 'none';
        const isHidden = sidebar.classList.contains('sidebar-hidden') || getComputedStyle(sidebar).display === 'none';
        return !isHidden && isSettingsVisible;
      });
      assert.equal(mobileSidebarReopened, true, 'Pulsar cerrar en móvil reabre el sidebar en modo configuración');
    } finally {
      await browser.close();
    }
  });
});
