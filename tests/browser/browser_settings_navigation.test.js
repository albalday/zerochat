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

      // Req 2: La lista de secciones aparece con sus elementos correctos e iconos SVG
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
      assert.equal(sectionsInfo.count, 7, 'Debe haber exactamente 7 secciones en la lista de navegación');
      const expectedSections = ['tab-general', 'tab-model', 'tab-agent', 'tab-mcp', 'tab-permissions', 'tab-appearance', 'tab-inspector'];
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
        const activePane = dialog.querySelector('.modal-tab-pane.active');
        const oldTabs = dialog.querySelectorAll('.modal-tabs-nav, .modal-tab-btn');
        const sectionHeader = dialog.querySelector('.settings-section-header');
        const titleEl = document.getElementById('settings-section-title');
        const backBtn = document.getElementById('btn-settings-back');
        const closeBtn = document.getElementById('btn-close-settings');
        const activeSidebarItem = document.querySelector('#sidebar-settings-nav .sidebar-settings-item.active');

        return {
          activePaneId: activePane?.id,
          hasOldTabs: oldTabs.length > 0,
          hasHeader: !!sectionHeader,
          titleText: titleEl?.textContent?.trim(),
          hasBackBtn: !!backBtn && !!backBtn.querySelector('svg'),
          hasCloseBtn: !!closeBtn && !!closeBtn.querySelector('svg'),
          activeSidebarSection: activeSidebarItem?.getAttribute('data-section')
        };
      });

      assert.equal(agentSectionState.activePaneId, 'tab-agent', 'Debe estar activo el panel tab-agent');
      assert.equal(agentSectionState.hasOldTabs, false, 'No deben existir pestañas antiguas dentro de settings-dialog');
      assert.ok(agentSectionState.hasHeader, 'Debe existir la cabecera unificada de sección');
      assert.ok(agentSectionState.hasBackBtn, 'La cabecera debe incluir el botón volver con SVG');
      assert.ok(agentSectionState.hasCloseBtn, 'La cabecera debe incluir el botón cerrar con SVG');
      assert.equal(agentSectionState.activeSidebarSection, 'tab-agent', 'El elemento del sidebar debe marcarse como .active');

      // Req 7: El botón volver de sección [←] reabre/mantiene el sidebar en modo configuración
      await page.click('#btn-settings-back');
      await page.waitForFunction(() => !document.getElementById('settings-dialog').open);

      const afterBackState = await page.evaluate(() => ({
        dialogOpen: document.getElementById('settings-dialog').open,
        settingsVisible: !document.getElementById('sidebar-view-settings').hidden && getComputedStyle(document.getElementById('sidebar-view-settings')).display !== 'none',
        chatHidden: document.getElementById('sidebar-view-chat').hidden || getComputedStyle(document.getElementById('sidebar-view-chat')).display === 'none'
      }));
      assert.equal(afterBackState.dialogOpen, false, 'El diálogo debe cerrarse tras pulsar volver');
      assert.equal(afterBackState.settingsVisible, true, 'El sidebar debe permanecer en modo configuración');
      assert.equal(afterBackState.chatHidden, true, 'La vista de chat debe seguir oculta');

      // Req 8: El botón cerrar [×] devuelve directamente al chat
      await page.click('[data-section="tab-appearance"]');
      await page.waitForFunction(() => document.getElementById('settings-dialog').open);
      assert.equal(await page.$eval('#settings-section-title', el => el.textContent.trim().length > 0), true);

      await page.click('#btn-close-settings');
      await page.waitForFunction(() => !document.getElementById('settings-dialog').open);

      const afterCloseState = await page.evaluate(() => ({
        dialogOpen: document.getElementById('settings-dialog').open,
        chatVisible: !document.getElementById('sidebar-view-chat').hidden && getComputedStyle(document.getElementById('sidebar-view-chat')).display !== 'none',
        settingsHidden: document.getElementById('sidebar-view-settings').hidden || getComputedStyle(document.getElementById('sidebar-view-settings')).display === 'none'
      }));
      assert.equal(afterCloseState.dialogOpen, false, 'El diálogo debe cerrarse tras pulsar cerrar');
      assert.equal(afterCloseState.chatVisible, true, 'El sidebar debe volver al modo chat');
      assert.equal(afterCloseState.settingsHidden, true, 'La vista de configuración debe quedar oculta');

      // Req 9 & 10: Guardar cambios mantiene su lógica y persistencia intacta
      await page.click('#btn-open-settings');
      await page.click('[data-section="tab-model"]');
      await page.waitForFunction(() => document.getElementById('settings-dialog').open);

      // Modificar un campo y guardar
      await page.fill('#setting-system-data-prompt', 'Instrucción de prueba persistencia');
      await page.click('#btn-save-settings');
      await page.waitForFunction(() => !document.getElementById('settings-dialog').open);

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
      await page.click('[data-section="tab-general"]');
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

      // Req 7 en móvil: Botón volver reabre el sidebar en modo configuración
      await page.click('#btn-settings-back');
      await page.waitForFunction(() => !document.getElementById('settings-dialog').open);

      const mobileSidebarReopened = await page.evaluate(() => {
        const sidebar = document.getElementById('chat-sidebar');
        const isSettingsVisible = !document.getElementById('sidebar-view-settings').hidden && getComputedStyle(document.getElementById('sidebar-view-settings')).display !== 'none';
        const isHidden = sidebar.classList.contains('sidebar-hidden') || getComputedStyle(sidebar).display === 'none';
        return !isHidden && isSettingsVisible;
      });
      assert.equal(mobileSidebarReopened, true, 'Pulsar volver en móvil reabre el sidebar en modo configuración');
    } finally {
      await browser.close();
    }
  });
});

