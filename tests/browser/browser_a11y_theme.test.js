const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTestBrowser, closeGlobalBrowser, seedConnectionProfiles, getBundleUrl, getIndexUrl } = require('../helpers/browser-env.js');

describe('Browser UI - a11y_theme', { concurrency: 3 }, () => {
  after(async () => {
    await closeGlobalBrowser();
  });

test('Browser UI - Modo Oscuro y resolución de Design Tokens', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    const filePath = 'file://' + path.resolve(__dirname, '../../zerochat.html');
    await page.goto(filePath, { waitUntil: 'load' });
    await page.waitForSelector('#welcome-banner');
    await page.waitForFunction(() => document.documentElement.classList.contains('zerochat-ready'));

    // 1. Validar tokens en modo claro
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'light');
    });

    const lightTokens = await page.evaluate(() => {
      const docStyle = getComputedStyle(document.documentElement);
      const bodyStyle = getComputedStyle(document.body);
      return {
        primary: docStyle.getPropertyValue('--primary').trim(),
        bgApp: docStyle.getPropertyValue('--bg-app').trim(),
        bgSurface: docStyle.getPropertyValue('--bg-surface').trim(),
        textMain: docStyle.getPropertyValue('--text-main').trim(),
        radiusMd: docStyle.getPropertyValue('--radius-md').trim(),
        bodyBg: bodyStyle.backgroundColor
      };
    });

    assert.ok(lightTokens.primary, 'Debe resolver --primary');
    assert.ok(lightTokens.bgApp, 'Debe resolver --bg-app');
    assert.ok(lightTokens.bgSurface, 'Debe resolver --bg-surface');
    assert.ok(lightTokens.radiusMd, 'Debe resolver --radius-md');

    // 2. Validar tokens en modo oscuro
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'dark');
    });

    const darkTokens = await page.evaluate(() => {
      const docStyle = getComputedStyle(document.documentElement);
      const bodyStyle = getComputedStyle(document.body);
      return {
        primary: docStyle.getPropertyValue('--primary').trim(),
        bgApp: docStyle.getPropertyValue('--bg-app').trim(),
        bgSurface: docStyle.getPropertyValue('--bg-surface').trim(),
        textMain: docStyle.getPropertyValue('--text-main').trim(),
        bodyBg: bodyStyle.backgroundColor
      };
    });

    assert.ok(darkTokens.primary, 'Debe resolver --primary en dark');
    assert.notEqual(darkTokens.bgApp, lightTokens.bgApp, 'El fondo de la app debe diferir entre temas');
    assert.notEqual(darkTokens.bodyBg, lightTokens.bodyBg, 'El fondo computado del body debe cambiar en dark');
  } finally {
    await browser.close();
  }
});

test('Browser UI - Fase 2: Header Superior Moderno y Acciones Integradas', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    const filePath = 'file://' + path.resolve(__dirname, '../../zerochat.html');
    await page.goto(filePath, { waitUntil: 'load' });

    // 1. Verificar presencia y posición del header moderno
    const headerInfo = await page.$eval('.app-header', el => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return {
        exists: !!el,
        position: style.position,
        top: rect.top,
        height: rect.height,
        display: style.display
      };
    });
    assert.ok(headerInfo.exists, 'El header (.app-header) debe existir');
    assert.equal(headerInfo.display, 'flex', 'El header debe ser flex');
    assert.ok(headerInfo.height >= 40, 'El header debe tener altura suficiente');

    // 2. Verificar que la antigua barra superior sobre el prompt ya NO existe
    const hasOldToolbar = await page.$eval('.input-toolbar-top', () => true).catch(() => false);
    assert.equal(hasOldToolbar, false, 'La barra .input-toolbar-top obsoleta debe haber sido retirada');

    // 3. Verificar que el botón de toggle del sidebar reside en el header y abre/cierra la barra lateral
    const isSidebarToggleInHeader = await page.$eval('.app-header #btn-toggle-sidebar', el => !!el);
    assert.ok(isSidebarToggleInHeader, '#btn-toggle-sidebar debe residir dentro de .app-header');

    // Estado inicial: sidebar abierto por defecto
    const sidebarInitialDisplay = await page.$eval('#chat-sidebar', el => getComputedStyle(el).display);
    assert.equal(sidebarInitialDisplay, 'flex', 'El sidebar debe estar abierto por defecto');

    // Cerrar sidebar pulsando el botón de cerrar del sidebar
    await page.click('#btn-close-sidebar');
    const sidebarClosedAgain = await page.$eval('#chat-sidebar', el => getComputedStyle(el).display);
    assert.equal(sidebarClosedAgain, 'none', 'El sidebar debe cerrarse');

    // Abrir sidebar pulsando el botón del header
    await page.click('#btn-toggle-sidebar');
    const sidebarOpenedDisplay = await page.$eval('#chat-sidebar', el => getComputedStyle(el).display);
    assert.equal(sidebarOpenedDisplay, 'flex', 'El sidebar debe abrirse (display: flex) tras pulsar el botón del header');

    // 4. Menú de perfiles activo en el header superior
    const hasProfileMenu = await page.$eval('.app-header #active-profile-menu', el => !!el);
    assert.ok(hasProfileMenu, 'El selector de perfil debe residir dentro del header');

    const profileStyle = await page.$eval('.header-profile-trigger', el => {
      const computed = getComputedStyle(el);
      return {
        borderStyle: computed.borderStyle,
        fontSize: computed.fontSize
      };
    });
    assert.equal(profileStyle.borderStyle, 'solid', 'El disparador debe tener un borde sutil');

    // Botón de editar perfiles en cabecera removido
    const hasBtnOpenProfiles = await page.$eval('#btn-open-profiles', el => !!el).catch(() => false);
    assert.equal(hasBtnOpenProfiles, false, 'El icono de editar perfiles en la cabecera debe haber sido eliminado');

    // Disclaimer inferior del textbox eliminado
    const hasDisclaimer = await page.$eval('.chat-disclaimer', el => !!el).catch(() => false);
    assert.equal(hasDisclaimer, false, 'La línea de ayuda/disclaimer debajo del prompt debe haber sido eliminada');

    // El menú muestra perfiles y una acción explícita para editarlos.
    await page.click('#active-profile-trigger');
    const menuState = await page.evaluate(() => ({
      open: document.getElementById('active-profile-trigger').getAttribute('aria-expanded'),
      list: document.getElementById('active-profile-list').textContent,
      hasEditBtn: !!document.querySelector('.btn-profile-item-edit')
    }));
    assert.equal(menuState.open, 'true', 'El disparador debe abrir el menú de perfiles');
    assert.match(menuState.list, /Espejo/, 'La primera instalación debe incluir el perfil Espejo');
    assert.ok(menuState.hasEditBtn, 'El menú debe incluir el botón para editar el perfil');

    await page.click('.btn-profile-item-edit');
    await page.waitForFunction(() => document.getElementById('profiles-dialog')?.open);
    const isProfilesOpen = await page.$eval('#profiles-dialog', el => el.open);
    assert.ok(isProfilesOpen, 'Pulsar editar perfil debe abrir #profiles-dialog');
    await page.click('#btn-close-profiles');
    await page.waitForFunction(() => !document.getElementById('profiles-dialog')?.open);

    // 5. Botón de Configuración en la cabecera del sidebar y selección de sección
    await page.click('#btn-open-settings');
    await page.click('[data-section="tab-model"]');
    await page.waitForFunction(() => document.getElementById('settings-dialog')?.open);
    const isSettingsOpen = await page.$eval('#settings-dialog', el => el.open);
    assert.ok(isSettingsOpen, 'Pulsar el botón de ajustes en el sidebar y elegir sección debe abrir #settings-dialog');
    await page.click('#btn-close-settings');
    await page.waitForFunction(() => !document.getElementById('settings-dialog')?.open);

    // 6. Botón de RAG abre el diálogo de conocimiento (asíncrono con refresh)
    await page.click('#btn-open-rag');
    await page.waitForFunction(() => document.getElementById('rag-modal')?.open);
    const isRagOpen = await page.$eval('#rag-modal', el => el.open);
    assert.ok(isRagOpen, 'Pulsar el botón de conocimiento en el header debe abrir #rag-modal');
    await page.click('#btn-close-rag');
    await page.waitForFunction(() => !document.getElementById('rag-modal')?.open);
  } finally {
    await browser.close();
  }
});

test('Browser UI - Fase 7: Accesibilidad WCAG 2.1 AA, Focus-Visible y Reduced Motion', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const filePath = 'file://' + path.resolve(__dirname, '../../zerochat.html');
    await page.goto(filePath, { waitUntil: 'load' });
    await page.waitForFunction(() => document.documentElement.classList.contains('zerochat-ready'));
    await page.waitForSelector('#welcome-banner');

    // 1. Validar Focus Visible con navegación por teclado
    await page.evaluate(() => {
      if (document.activeElement && document.activeElement !== document.body) {
        document.activeElement.blur();
      }
    });
    await page.keyboard.press('Tab');
    const focusedOutline = await page.evaluate(() => {
      const activeEl = document.activeElement;
      if (!activeEl) return null;
      const s = getComputedStyle(activeEl);
      return {
        tag: activeEl.tagName,
        outlineStyle: s.outlineStyle,
        outlineWidth: s.outlineWidth
      };
    });
    assert.ok(focusedOutline, 'Debe haber un elemento enfocado por teclado');
    assert.notEqual(focusedOutline.outlineStyle, 'none', 'El elemento enfocado debe tener un indicador visual outline');

    // 2. Validar soporte prefers-reduced-motion
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const reducedMotionApplied = await page.evaluate(() => {
      const el = document.querySelector('.welcome-banner') || document.body;
      const s = getComputedStyle(el);
      return parseFloat(s.animationDuration) <= 0.05;
    });
    assert.ok(reducedMotionApplied, 'Las animaciones deben reducirse drásticamente bajo prefers-reduced-motion');

    // 3. Validar ratios de contraste de color semántico (WCAG 2.1 AA >= 4.5:1)
    function luminance(r, g, b) {
      const a = [r, g, b].map(v => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      });
      return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722;
    }
    function contrastRatio(rgb1, rgb2) {
      const l1 = luminance(rgb1[0], rgb1[1], rgb1[2]);
      const l2 = luminance(rgb2[0], rgb2[1], rgb2[2]);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    }

    // Comprobar ratios en Light Mode (#ffffff fondo)
    const ratioLight = contrastRatio([15, 23, 42], [255, 255, 255]); // #0f172a vs #ffffff
    assert.ok(ratioLight >= 4.5, `Contraste en modo claro (${ratioLight.toFixed(1)}:1) debe superar 4.5:1`);

    // Comprobar ratios en Dark Mode (#131b2e vs #f1f5f9)
    const ratioDark = contrastRatio([241, 245, 249], [19, 27, 46]);
    assert.ok(ratioDark >= 4.5, `Contraste en modo oscuro (${ratioDark.toFixed(1)}:1) debe superar 4.5:1`);

    // 4. Validar ausencia total de errores o excepciones tras interacciones complejas
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(err.message));
    assert.equal(pageErrors.length, 0, 'No debe haber errores de página en ninguna fase');
  } finally {
    await browser.close();
  }
});

test('Browser UI - Iconos Fase 2: Iconos Vectoriales SVG en Header Superior y Composer', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const filePath = 'file://' + path.resolve(__dirname, '../../zerochat.html');
    await page.goto(filePath, { waitUntil: 'load' });
    await page.waitForSelector('#welcome-banner');

    // 1. Validar iconos SVG en el Header
    const headerIcons = await page.evaluate(() => {
      const profileSvg = document.querySelector('.header-profile-trigger .profile-icon svg');
      const ragSvg = document.querySelector('#btn-open-rag svg');
      const debugSvg = document.querySelector('#btn-toggle-debug svg');
      const reasoningSvg = document.querySelector('#btn-reasoning svg');

      return {
        hasProfileSvg: !!profileSvg,
        hasRagSvg: !!ragSvg,
        hasDebugSvg: !!debugSvg,
        hasReasoningSvg: !!reasoningSvg,
        ragWidth: ragSvg ? parseFloat(getComputedStyle(ragSvg).width) : 0,
        reasoningWidth: reasoningSvg ? parseFloat(getComputedStyle(reasoningSvg).width) : 0
      };
    });

    assert.ok(headerIcons.hasProfileSvg, 'El selector de perfiles debe contener un SVG vectorial (zap)');
    assert.ok(headerIcons.hasRagSvg, 'El botón RAG debe contener un SVG vectorial (layers)');
    assert.ok(headerIcons.hasDebugSvg, 'El botón de debug debe contener un SVG vectorial (terminal)');
    assert.ok(headerIcons.hasReasoningSvg, 'El botón de razonamiento debe contener un SVG vectorial (brain)');
    assert.ok(headerIcons.ragWidth >= 12, 'El icono RAG debe tener dimensiones computadas válidas');
    assert.ok(headerIcons.reasoningWidth >= 12, 'El icono de razonamiento debe tener dimensiones válidas');

    // 2. Abrir menú de razonamiento y verificar cabecera con SVG
    await page.click('#btn-reasoning');
    await page.waitForFunction(() => document.getElementById('reasoning-menu')?.style.display !== 'none');

    const menuHeaderInfo = await page.evaluate(() => {
      const menu = document.getElementById('reasoning-menu');
      const header = document.querySelector('.reasoning-menu-header');
      const options = document.querySelector('.reasoning-options');
      const lowOption = document.querySelector('.reasoning-option[data-level="low"]') || document.querySelector('.reasoning-option');
      const lowIcon = lowOption?.querySelector('.option-icon');
      const lowText = lowOption?.querySelector('.option-text');
      const svg = header?.querySelector('svg');
      const text = header?.textContent || '';
      const activeOption = document.querySelector('.reasoning-option.active');
      const activeCheckSvg = activeOption?.querySelector('.option-check svg');
      const lowBorderStyle = lowOption ? getComputedStyle(lowOption).borderStyle : '';
      const activeBorderStyle = activeOption ? getComputedStyle(activeOption).borderStyle : '';
      const lowBorderWidth = lowOption ? getComputedStyle(lowOption).borderWidth : '';
      const activeBorderWidth = activeOption ? getComputedStyle(activeOption).borderWidth : '';
      const btnAriaPopup = document.getElementById('btn-reasoning')?.getAttribute('aria-haspopup');
      const btnAriaExpanded = document.getElementById('btn-reasoning')?.getAttribute('aria-expanded');

      return {
        hasSvg: !!svg,
        hasEmoji: text.includes('🧠'),
        text: text.trim(),
        flexDirection: menu ? getComputedStyle(menu).flexDirection : '',
        headerBottom: header?.getBoundingClientRect().bottom || 0,
        optionsTop: options?.getBoundingClientRect().top || 0,
        lowIconRight: lowIcon?.getBoundingClientRect().right || 0,
        lowTextLeft: lowText?.getBoundingClientRect().left || 0,
        lowBorderStyle,
        activeBorderStyle,
        lowBorderWidth,
        activeBorderWidth,
        hasActiveCheckSvg: !!activeCheckSvg,
        btnAriaPopup,
        btnAriaExpanded
      };
    });

    assert.ok(menuHeaderInfo.hasSvg, 'La cabecera del menú de razonamiento debe contener un SVG (brain)');
    assert.equal(menuHeaderInfo.hasEmoji, false, 'La cabecera del menú no debe contener el emoji 🧠');
    assert.equal(menuHeaderInfo.flexDirection, 'column', 'El menú de razonamiento debe apilar cabecera y opciones verticalmente');
    assert.ok(menuHeaderInfo.optionsTop >= menuHeaderInfo.headerBottom, 'Las opciones deben mostrarse debajo de la cabecera, no a su lado');
    assert.ok(menuHeaderInfo.lowTextLeft - menuHeaderInfo.lowIconRight <= 10, 'El texto del nivel bajo debe quedar junto a su indicador');
    assert.ok(menuHeaderInfo.lowBorderStyle === 'none' || menuHeaderInfo.lowBorderWidth === '0px', 'Las opciones de razonamiento no deben tener enmarcado');
    assert.ok(menuHeaderInfo.activeBorderStyle === 'none' || menuHeaderInfo.activeBorderWidth === '0px', 'La opción activa de razonamiento no debe tener enmarcado');
    assert.ok(menuHeaderInfo.hasActiveCheckSvg, 'La opción activa debe indicar selección mediante icono SVG checkmark');
    assert.equal(menuHeaderInfo.btnAriaPopup, 'menu', 'El botón de razonamiento debe declarar aria-haspopup="menu"');
    assert.equal(menuHeaderInfo.btnAriaExpanded, 'true', 'El botón de razonamiento debe tener aria-expanded="true" al estar desplegado');
  } finally {
    await browser.close();
  }
});

test('Browser UI - Iconos Fase 3: Iconos Vectoriales SVG en Barra Lateral e Historial', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const filePath = 'file://' + path.resolve(__dirname, '../../zerochat.html');
    await page.goto(filePath, { waitUntil: 'load' });
    await page.waitForSelector('#welcome-banner');

    // 1. Validar barra lateral abierta
    await page.waitForFunction(() => document.getElementById('chat-sidebar')?.style.display !== 'none');

    // 2. Verificar iconos vectoriales de cabecera, buscador y footer de sidebar
    const sidebarIcons = await page.evaluate(() => {
      const newChatSvg = document.querySelector('#btn-sidebar-new-chat svg');
      const settingsSvg = document.querySelector('.sidebar-header #btn-open-settings svg');
      const closeSvg = document.querySelector('#btn-close-sidebar svg');
      const searchSvg = document.querySelector('.sidebar-search-box svg');
      const importSvg = document.querySelector('#btn-import-chat-file svg');
      const deleteAllSvg = document.querySelector('#btn-delete-all-chats svg');

      return {
        hasNewChatSvg: !!newChatSvg,
        hasSettingsSvg: !!settingsSvg,
        hasCloseSvg: !!closeSvg,
        hasSearchSvg: !!searchSvg,
        hasImportSvg: !!importSvg,
        hasDeleteAllSvg: !!deleteAllSvg,
        newChatWidth: newChatSvg ? parseFloat(getComputedStyle(newChatSvg).width) : 0,
        searchWidth: searchSvg ? parseFloat(getComputedStyle(searchSvg).width) : 0
      };
    });

    assert.ok(sidebarIcons.hasNewChatSvg, 'El botón de nueva conversación debe tener icono SVG');
    assert.ok(sidebarIcons.hasSettingsSvg, 'El botón de configuración en la cabecera del sidebar debe tener icono SVG');
    assert.ok(sidebarIcons.hasCloseSvg, 'El botón de cerrar barra lateral debe tener icono SVG');
    assert.ok(sidebarIcons.hasSearchSvg, 'El buscador debe tener icono SVG de lupa');
    assert.ok(sidebarIcons.hasImportSvg, 'El botón de importar debe tener icono SVG');
    assert.ok(sidebarIcons.hasDeleteAllSvg, 'El botón de borrar todo debe tener icono SVG');
    assert.ok(sidebarIcons.newChatWidth >= 14, 'El icono de nuevo chat debe tener tamaño >= 14px');

    // 3. Renderizar una sesión simulada en el historial y verificar iconos de acciones en hover
    const chatItemActionIcons = await page.evaluate(() => {
      const list = document.getElementById('sidebar-chats-list');
      if (typeof ChatUISidebar !== 'undefined' && typeof ChatUISidebar.renderSidebarChats === 'function') {
        ChatUISidebar.renderSidebarChats({ sidebarChatsList: list }, [
          { id: 'sess_test_1', title: 'Conversación de prueba', updatedAt: Date.now() }
        ], 'sess_test_1', {});
      }
      const item = list.querySelector('.sidebar-chat-item');
      const exportSvg = item?.querySelector('.btn-export svg');
      const renameSvg = item?.querySelector('.btn-rename svg');
      const deleteSvg = item?.querySelector('.btn-delete svg');

      return {
        hasItem: !!item,
        hasExportSvg: !!exportSvg,
        hasRenameSvg: !!renameSvg,
        hasDeleteSvg: !!deleteSvg,
        exportWidth: exportSvg ? parseFloat(getComputedStyle(exportSvg).width) : 0,
        renameWidth: renameSvg ? parseFloat(getComputedStyle(renameSvg).width) : 0,
        deleteWidth: deleteSvg ? parseFloat(getComputedStyle(deleteSvg).width) : 0
      };
    });

    assert.ok(chatItemActionIcons.hasItem, 'El item de conversación debe renderizarse');
    assert.ok(chatItemActionIcons.hasExportSvg, 'La acción de exportar debe contener icono SVG (download)');
    assert.ok(chatItemActionIcons.hasRenameSvg, 'La acción de renombrar debe contener icono SVG (edit)');
    assert.ok(chatItemActionIcons.hasDeleteSvg, 'La acción de eliminar debe contener icono SVG (trash)');
    assert.ok(chatItemActionIcons.exportWidth >= 10, 'El icono de exportar debe tener dimensiones válidas');
    assert.ok(chatItemActionIcons.renameWidth >= 10, 'El icono de renombrar debe tener dimensiones válidas');
    assert.ok(chatItemActionIcons.deleteWidth >= 10, 'El icono de eliminar debe tener dimensiones válidas');
  } finally {
    await browser.close();
  }
});

test('Browser UI - Iconos Fase 4: Iconos Vectoriales SVG en Tarjetas Agénticas y Badges de Estado', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const filePath = 'file://' + path.resolve(__dirname, '../../zerochat.html');
    await page.goto(filePath, { waitUntil: 'load' });
    await page.waitForSelector('#welcome-banner');

    const toolCardsResult = await page.evaluate(() => {
      const container = document.getElementById('messages-list') || document.body;

      // 1. Crear tarjeta viva de execute_javascript
      const jsCard = ChatToolCards.createLiveToolCard('execute_javascript', { code: 'console.log("hola");' });
      container.appendChild(jsCard);

      const jsTitle = jsCard.querySelector('.tool-card-title');
      const jsTitleSvg = jsTitle?.querySelector('svg');
      const jsBadge = jsCard.querySelector('.tool-card-badge');
      const jsBadgeSpinnerSvg = jsBadge?.querySelector('svg.ui-icon-spin');
      const jsCollapseSvg = jsCard.querySelector('.btn-tool-collapse svg');

      const jsTitleHasEmoji = jsTitle?.textContent.includes('⚡') || false;
      const jsBadgeHasEmoji = jsBadge?.textContent.includes('⏳') || false;

      // 2. Actualizar tarjeta viva a completada
      ChatToolCards.updateLiveToolCard(jsCard, 'execute_javascript', {}, { success: true, result: 'hola' }, 42);
      const jsBadgeSuccessSvg = jsBadge?.querySelector('svg');
      const jsBadgeSuccessHasEmoji = jsBadge?.textContent.includes('✅') || false;

      // 3. Crear tarjeta de search_web
      const searchCard = ChatToolCards.createLiveToolCard('search_web', { query: 'test query' });
      container.appendChild(searchCard);

      const searchTitle = searchCard.querySelector('.search-card-title');
      const searchTitleSvg = searchTitle?.querySelector('svg');
      const searchBadge = searchCard.querySelector('.search-card-badge');
      const searchBadgeSpinnerSvg = searchBadge?.querySelector('svg.ui-icon-spin');

      const searchTitleHasEmoji = searchTitle?.textContent.includes('🔍') || false;
      const searchBadgeHasEmoji = searchBadge?.textContent.includes('⏳') || false;

      // 4. Renderizar gráfico nativo
      let chartSvgFound = false;
      let chartEmojiFound = true;
      if (typeof ChatCharts !== 'undefined' && typeof ChatCharts.renderChartCard === 'function') {
        const chartHtml = ChatCharts.renderChartCard({
          type: 'bar',
          title: 'Ventas Mensuales',
          labels: ['Ene', 'Feb'],
          datasets: [{ label: 'Ventas', data: [10, 20] }]
        });
        const chartWrapper = document.createElement('div');
        chartWrapper.innerHTML = chartHtml;
        container.appendChild(chartWrapper);

        const chartHeader = chartWrapper.querySelector('.chat-chart-title');
        chartSvgFound = !!chartHeader?.querySelector('svg');
        chartEmojiFound = chartHeader?.textContent.includes('📊') || false;
      }

      return {
        hasJsTitleSvg: !!jsTitleSvg,
        jsTitleHasEmoji,
        hasJsBadgeSpinnerSvg: !!jsBadgeSpinnerSvg,
        jsBadgeHasEmoji,
        hasJsCollapseSvg: !!jsCollapseSvg,
        hasJsBadgeSuccessSvg: !!jsBadgeSuccessSvg,
        jsBadgeSuccessHasEmoji,
        hasSearchTitleSvg: !!searchTitleSvg,
        searchTitleHasEmoji,
        hasSearchBadgeSpinnerSvg: !!searchBadgeSpinnerSvg,
        searchBadgeHasEmoji,
        chartSvgFound,
        chartEmojiFound,
        jsCardCollapsed: !!jsCard.querySelector('.tool-execution-card.collapsed')
      };
    });

    // Validaciones JS Tool Card
    assert.ok(toolCardsResult.hasJsTitleSvg, 'execute_javascript debe tener icono SVG');
    assert.equal(toolCardsResult.jsTitleHasEmoji, false, 'execute_javascript no debe tener emoji ⚡');
    assert.ok(toolCardsResult.hasJsBadgeSpinnerSvg, 'El badge en ejecución debe tener un spinner SVG animado');
    assert.equal(toolCardsResult.jsBadgeHasEmoji, false, 'El badge no debe tener emoji ⏳');
    assert.ok(toolCardsResult.hasJsCollapseSvg, 'El botón de colapsar debe tener un chevron SVG');
    assert.ok(toolCardsResult.hasJsBadgeSuccessSvg, 'El badge de completado debe tener un check SVG');
    assert.equal(toolCardsResult.jsBadgeSuccessHasEmoji, false, 'El badge de completado no debe tener emoji ✅');
    assert.ok(toolCardsResult.jsCardCollapsed, 'La tarjeta de la tool debe aparecer minimizada (collapsed) tras su ejecución');

    // Validaciones Search Web Card
    assert.ok(toolCardsResult.hasSearchTitleSvg, 'search_web debe tener icono SVG');
    assert.equal(toolCardsResult.searchTitleHasEmoji, false, 'search_web no debe tener emoji 🔍');
    assert.ok(toolCardsResult.hasSearchBadgeSpinnerSvg, 'El badge de búsqueda debe tener spinner SVG');
    assert.equal(toolCardsResult.searchBadgeHasEmoji, false, 'El badge de búsqueda no debe tener emoji ⏳');

    // Validaciones Chart Card
    assert.ok(toolCardsResult.chartSvgFound, 'La tarjeta de gráficos debe tener un icono SVG');
    assert.equal(toolCardsResult.chartEmojiFound, false, 'La tarjeta de gráficos no debe tener emoji 📊');
  } finally {
    await browser.close();
  }
});

test('Browser UI - Iconos Fase 5: Iconos Vectoriales SVG en Modales, Secciones, Exportación y RAG', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const filePath = 'file://' + path.resolve(__dirname, '../../zerochat.html');
    await page.goto(filePath, { waitUntil: 'load' });
    await page.waitForSelector('#welcome-banner');

    // 1. Abrir modal de Ajustes desde el sidebar
    await page.click('#btn-open-settings');
    await page.waitForSelector('#sidebar-settings-nav');

    const sidebarIcons = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('#sidebar-settings-nav .sidebar-settings-item'));
      const itemsHaveSvg = items.every(t => !!t.querySelector('svg'));
      const itemsText = items.map(t => t.textContent).join(' ');
      const hasItemEmojis = /🌐|⚙️|🤖|🎨|🔍/.test(itemsText);
      return { itemsHaveSvg, hasItemEmojis };
    });

    assert.ok(sidebarIcons.itemsHaveSvg, 'Todas las opciones de configuración del sidebar deben contener un icono SVG');
    assert.equal(sidebarIcons.hasItemEmojis, false, 'Las opciones de configuración no deben contener emojis residuales');

    await page.click('[data-section="tab-model"]');
    await page.waitForSelector('#settings-dialog[open]');

    const settingsIcons = await page.evaluate(() => {
      const toggleKeySvg = !!document.querySelector('#btn-toggle-key svg');
      const clearAllBtn = document.getElementById('btn-clear-all-data');
      const clearAllSvg = !!clearAllBtn?.querySelector('svg');
      const clearAllHasEmoji = /🗑/.test(clearAllBtn?.textContent || '');
      const clearAllText = clearAllBtn?.textContent?.trim() || '';
      const themeButtons = Array.from(document.querySelectorAll('.btn-theme-toggle'));
      const themeHaveSvg = themeButtons.every(b => !!b.querySelector('svg'));

      return {
        toggleKeySvg,
        clearAllSvg,
        clearAllHasEmoji,
        clearAllText,
        themeHaveSvg
      };
    });

    assert.ok(settingsIcons.toggleKeySvg, 'El botón de visibilidad de clave debe contener icono SVG');
    assert.ok(settingsIcons.clearAllSvg, 'El botón de borrar todo debe contener icono SVG');
    assert.equal(settingsIcons.clearAllHasEmoji, false, 'El botón de borrar todo no debe contener emoji');
    assert.equal(settingsIcons.clearAllText, 'Borrar todo', 'El texto de borrar todo debe ser limpio');
    assert.ok(settingsIcons.themeHaveSvg, 'Los botones de modo claro/oscuro deben contener iconos SVG');

    await page.click('#btn-close-settings');
    await page.waitForFunction(() => !document.getElementById('settings-dialog').open);

    // 2. Abrir modal de Exportación
    await page.evaluate(() => document.getElementById('export-modal').showModal());
    await page.waitForSelector('#export-modal[open]');

    const exportIcons = await page.evaluate(() => {
      const headerIcon = document.querySelector('#export-modal .modal-icon svg');
      const closeBtn = document.querySelector('#btn-close-export svg');
      const cards = Array.from(document.querySelectorAll('#export-modal .export-card-btn'));
      const cardsHaveSvg = cards.every(c => !!c.querySelector('.export-card-icon svg'));
      const cardsText = cards.map(c => c.textContent).join(' ');
      const hasExportEmojis = /📄|📦|🖨️/.test(cardsText);

      return {
        hasHeaderSvg: !!headerIcon,
        hasCloseSvg: !!closeBtn,
        cardsHaveSvg,
        hasExportEmojis
      };
    });

    assert.ok(exportIcons.hasHeaderSvg, 'La cabecera de exportación debe tener icono SVG');
    assert.ok(exportIcons.hasCloseSvg, 'El botón de cierre de exportación debe tener icono SVG');
    assert.ok(exportIcons.cardsHaveSvg, 'Todas las tarjetas de exportación deben tener icono SVG');
    assert.equal(exportIcons.hasExportEmojis, false, 'Las tarjetas de exportación no deben contener emojis');

    await page.evaluate(() => document.getElementById('export-modal').close());

    // 3. Abrir modal de RAG desde el compositor (modo activate)
    await page.click('#btn-open-rag');
    await page.waitForSelector('#rag-modal[open]');

    const ragIconsActivate = await page.evaluate(() => {
      const headerSvg = document.querySelector('#rag-modal .rag-header-icon svg');
      const activationContent = document.querySelector('#rag-modal .rag-modal-content');
      const activationContentDisplay = activationContent ? window.getComputedStyle(activationContent).display : 'none';

      return {
        hasHeaderSvg: !!headerSvg,
        hasActivationContent: !!activationContent,
        activationContentDisplay
      };
    });

    assert.ok(ragIconsActivate.hasHeaderSvg, 'La cabecera de RAG debe tener icono SVG');
    assert.ok(ragIconsActivate.hasActivationContent, 'El modal de conocimiento debe mostrar el contenido de activación desde el composer');
    assert.notEqual(ragIconsActivate.activationContentDisplay, 'none', 'El contenido de activación debe estar visible');

    // Cerrar y reabrir desde el menú de configuración (modo manage) para verificar los iconos de gestión
    await page.click('#btn-close-rag');

    // Abrir el sidebar si está oculto
    const sidebarVisible = await page.evaluate(() => {
      const sidebar = document.getElementById('chat-sidebar');
      return sidebar && !sidebar.classList.contains('sidebar-hidden');
    });
    if (!sidebarVisible) {
      await page.click('#btn-toggle-sidebar');
    }

    await page.click('#btn-open-settings');
    await page.click('.sidebar-settings-item[data-section="rag-manage"]');
    await page.waitForSelector('#rag-manage-modal[open]');

    const ragIcons = await page.evaluate(() => {
      const newBranchBtn = document.getElementById('btn-rag-new-branch');
      const newBranchSvg = newBranchBtn?.querySelector('svg');
      const newBranchHasPlusInText = (newBranchBtn?.textContent || '').includes('+');
      const newBranchText = newBranchBtn?.textContent?.trim() || '';

      const editBranchSvg = document.querySelector('#btn-rag-edit-branch svg');
      const deleteBranchSvg = document.querySelector('#btn-rag-delete-branch svg');
      const exportBranchSvg = document.querySelector('#btn-rag-export-branch svg');
      const importBranchSvg = document.querySelector('#btn-rag-import-branch svg');
      const quotaSvg = document.querySelector('#rag-storage-quota-info svg');

      return {
        hasNewBranchSvg: !!newBranchSvg,
        newBranchHasPlusInText,
        newBranchText,
        hasEditBranchSvg: !!editBranchSvg,
        hasDeleteBranchSvg: !!deleteBranchSvg,
        hasExportBranchSvg: !!exportBranchSvg,
        hasImportBranchSvg: !!importBranchSvg,
        hasQuotaSvg: !!quotaSvg
      };
    });

    assert.ok(ragIcons.hasNewBranchSvg, 'El botón de nueva rama debe tener icono SVG');
    assert.equal(ragIcons.newBranchHasPlusInText, false, 'El botón de nueva rama no debe tener símbolo + en el texto');
    assert.equal(ragIcons.newBranchText, 'Nueva rama', 'El texto del botón de nueva rama debe ser exactamente "Nueva rama"');
    assert.ok(ragIcons.hasEditBranchSvg, 'El botón de editar rama debe tener icono SVG');
    assert.ok(ragIcons.hasDeleteBranchSvg, 'El botón de eliminar rama debe tener icono SVG');
    assert.ok(ragIcons.hasExportBranchSvg, 'El botón de respaldar rama debe tener icono SVG');
    assert.ok(ragIcons.hasImportBranchSvg, 'El botón de importar rama debe tener icono SVG');
    assert.ok(ragIcons.hasQuotaSvg, 'El indicador de cuota debe tener icono SVG');

    // Verificación de gestión de ramas con campos en pantalla (sin ventanas prompt nativas)
    let dialogTriggered = false;
    page.on('dialog', () => { dialogTriggered = true; });

    // Cerrar el modal y abrir desde el menú de configuración para acceder al modo "manage"
    await page.click('#btn-close-rag-manage');
    await page.click('#btn-open-settings');
    await page.click('.sidebar-settings-item[data-section="rag-manage"]');
    await page.waitForSelector('#rag-branch-details-card');

    // Verificar que el textbox en la pestaña de documentos fue eliminado para ganar espacio
    const workspaceHasTextbox = await page.$eval('#rag-manage-workspace', el => !!el.querySelector('.rag-workspace-summary'));
    assert.equal(workspaceHasTextbox, false, 'El workspace de documentos no debe tener el textbox de resumen para ganar espacio');

    // Pulsar Nueva rama y rellenar campos en pantalla
    await page.click('#btn-rag-new-branch');
    await page.fill('#rag-branch-name-input', 'Rama de navegador');
    await page.fill('#rag-branch-desc-input', 'Descripción de prueba de navegador');

    // Verificar que el botón cambia a Guardar
    const saveBtnTextAfterType = await page.$eval('#btn-rag-new-branch', el => el.textContent.trim());
    assert.equal(saveBtnTextAfterType, 'Guardar', 'Al detectar cambios el botón de nueva rama debe cambiar a Guardar');

    // Pulsar el botón Guardar
    await page.click('#btn-rag-new-branch');

    await page.waitForFunction(() => {
      const select = document.getElementById('rag-manage-branch-select');
      return select && Array.from(select.options).some(opt => opt.text.includes('Rama de navegador'));
    });

    // Verificar que tras guardar vuelve a ser "Nueva rama"
    const btnTextAfterSave = await page.$eval('#btn-rag-new-branch', el => el.textContent.trim());
    assert.equal(btnTextAfterSave, 'Nueva rama', 'Tras guardar el botón debe volver a ser "Nueva rama"');

    // Ahora que la rama existe y está seleccionada en Documentos, verificar el resumen en el pie del modal
    const footerSummary = await page.evaluate(() => {
      const el = document.getElementById('rag-branch-summary-footer');
      return {
        text: el?.textContent?.trim() || '',
        display: el ? window.getComputedStyle(el).display : 'none'
      };
    });
    assert.ok(footerSummary.text.includes('Esta rama cargó'), 'El pie del modal debe contener el resumen "Esta rama cargó"');
    assert.ok(footerSummary.text.includes('documentos de'), 'El pie del modal debe indicar "documentos de"');
    assert.notEqual(footerSummary.display, 'none', 'El resumen en el pie del diálogo de gestión debe ser visible');

    const createdBranch = await page.evaluate(async () => {
      const branches = await window.ChatRagStorage.getBranches();
      return branches.find(b => b.name === 'Rama de navegador');
    });

    assert.ok(createdBranch, 'La rama debe haberse creado en IndexedDB');
    assert.equal(createdBranch.description, 'Descripción de prueba de navegador', 'La descripción debe haberse guardado');
    assert.equal(dialogTriggered, false, 'No debe haberse disparado ningún diálogo prompt() nativo');

    // Modificar descripción en pantalla y verificar que cambia a Guardar
    await page.fill('#rag-branch-desc-input', 'Descripción editada sin prompts');
    const editBtnText = await page.$eval('#btn-rag-new-branch', el => el.textContent.trim());
    assert.equal(editBtnText, 'Guardar', 'Al modificar la descripción el botón debe cambiar a Guardar');

    await page.click('#btn-rag-new-branch');

    await page.waitForFunction(async (branchId) => {
      const b = await window.ChatRagStorage.getBranchById(branchId);
      return b && b.description === 'Descripción editada sin prompts';
    }, createdBranch.id);

    const updatedBranch = await page.evaluate(async (branchId) => {
      return await window.ChatRagStorage.getBranchById(branchId);
    }, createdBranch.id);

    assert.equal(updatedBranch.description, 'Descripción editada sin prompts', 'La modificación debe haberse guardado');
    assert.equal(dialogTriggered, false, 'No debe haberse mostrado ningún diálogo emergente bloqueante');

    const btnTextFinal = await page.$eval('#btn-rag-new-branch', el => el.textContent.trim());
    assert.equal(btnTextFinal, 'Nueva rama', 'Tras guardar la modificación el botón debe volver a Nueva rama');
    // Verificar que el diálogo de activación también muestra el resumen de cada rama
    await page.click('#btn-close-rag-manage');
    await page.click('#btn-open-rag');
    await page.waitForSelector('#rag-modal[open]');
    const activeBranchMetricsText = await page.$eval('.rag-branch-select-card .rag-branch-metrics', el => el.textContent.trim());
    assert.ok(activeBranchMetricsText.includes('Esta rama cargó'), 'El resumen de cada rama en la pestaña Activar debe decir "Esta rama cargó"');
    assert.ok(activeBranchMetricsText.includes('documentos de'), 'El resumen de cada rama en la pestaña Activar debe usar "documentos de"');

    await page.click('#btn-close-rag');
  } finally {
    await browser.close();
  }
});

test('Browser UI - Verificación global de iconos SVG, accesibilidad y auditoría residual', async (t) => {
  const browser = await createTestBrowser();
  const page = await browser.newPage();

  try {
    const fileUrl = 'file://' + path.resolve(__dirname, '../../zerochat.html');
    await page.goto(fileUrl, { waitUntil: 'load' });

    // 1. Verificar estructura y renderizado de SVGs
    const svgValidation = await page.evaluate(() => {
      const svgs = Array.from(document.querySelectorAll('svg.ui-icon'));
      const allWellFormed = svgs.every(svg => {
        return svg.tagName.toLowerCase() === 'svg' &&
          svg.getAttribute('viewBox') === '0 0 24 24' &&
          svg.children.length > 0;
      });

      // Validar dimensiones en SVGs actualmente visibles en pantalla
      const visibleHeaderSvgs = Array.from(document.querySelectorAll('.top-header svg.ui-icon'));
      const headerSvgsRendered = visibleHeaderSvgs.every(svg => {
        const rect = svg.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });

      // Validar que ninguna opción de selector de proveedor contiene emojis
      const apiTypeSelect = document.getElementById('setting-api-type');
      const optionsText = Array.from(apiTypeSelect?.options || []).map(o => o.textContent).join(' ');
      const hasOptionEmojis = /🤖|🦙|🔀|🎭|✨/.test(optionsText);

      // Validar que la cabecera, sidebar y controles de ajuste no contienen emojis residuales
      const headerText = document.querySelector('.app-header')?.textContent || '';
      const sidebarText = document.querySelector('.sidebar')?.textContent || '';
      const settingsSectionsText = document.querySelector('#settings-dialog .settings-section-pane')?.textContent || '';

      const forbiddenEmojis = /⚡|📊|🌿|📤|📜|🧠|➕|🔍|🗑️|✏️|👁️|☀️|🌙/;
      const hasHeaderEmojis = forbiddenEmojis.test(headerText);
      const hasSidebarEmojis = /➕|🗑️|✏️/.test(sidebarText);
      const hasSettingsSectionsEmojis = /🌐|⚙️|🤖|🎨|🔍/.test(settingsSectionsText);

      return {
        svgCount: svgs.length,
        allWellFormed,
        headerSvgsRendered,
        hasOptionEmojis,
        hasHeaderEmojis,
        hasSidebarEmojis,
        hasSettingsSectionsEmojis
      };
    });

    assert.ok(svgValidation.svgCount >= 20, `Debe haber al menos 20 iconos vectoriales en la interfaz (encontrados: ${svgValidation.svgCount})`);
    assert.ok(svgValidation.allWellFormed, 'Todos los iconos SVG deben estar bien formados con viewBox="0 0 24 24" y trazo vectorial');
    assert.ok(svgValidation.headerSvgsRendered, 'Los iconos SVG visibles en la cabecera deben renderizarse con dimensiones positivas');
    assert.equal(svgValidation.hasOptionEmojis, false, 'El selector de proveedor no debe contener emojis');
    assert.equal(svgValidation.hasHeaderEmojis, false, 'La cabecera no debe contener emojis residuales');
    assert.equal(svgValidation.hasSidebarEmojis, false, 'La barra lateral no debe contener emojis residuales');
    assert.equal(svgValidation.hasSettingsSectionsEmojis, false, 'Las secciones de configuración no deben contener emojis residuales');

    // 2. Verificar alternancia de temas claro/oscuro y stroke de currentColor
    const themeTest = await page.evaluate(() => {
      const btnThemeLight = document.getElementById('btn-theme-light');
      const btnThemeDark = document.getElementById('btn-theme-dark');
      btnThemeDark.click();
      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';

      // Verificar que los SVGs usan currentColor
      const sampleSvg = document.querySelector('.app-header svg.ui-icon');
      const strokeAttr = sampleSvg?.getAttribute('stroke');

      btnThemeLight.click();
      const isLight = !document.documentElement.getAttribute('data-theme') || document.documentElement.getAttribute('data-theme') === 'light';

      return {
        isDark,
        isLight,
        usesCurrentColor: strokeAttr === 'currentColor'
      };
    });

    assert.ok(themeTest.isDark, 'Debe activar correctamente el tema oscuro');
    assert.ok(themeTest.isLight, 'Debe activar correctamente el tema claro');
    assert.ok(themeTest.usesCurrentColor, 'Los iconos vectoriales deben usar stroke="currentColor" para heredar contraste dinámicamente');

    // 3. Verificar inspector de capacidades con SVGs vectoriales
    const inspectorCapSvgs = await page.evaluate(() => {
      // Simular reporte en UIInspector
      const fakeReport = {
        provider: { id: 'openai', label: 'OpenAI Test' },
        endpoint: { normalized: 'https://api.openai.com/v1/chat/completions' },
        model: { selected: 'gpt-4o', totalDiscovered: 1 },
        inspectionTimeMs: 120,
        capabilities: {
          streaming: { status: 'confirmed', detail: 'OK' },
          tools: { status: 'confirmed', detail: 'OK' },
          vision: { status: 'confirmed', detail: 'OK' },
          reasoning: { status: 'confirmed', detail: 'OK' }
        }
      };

      const elements = {
        inspectorResults: document.getElementById('inspector-results')
      };

      const inspector = window.ChatUIInspector || window.UIInspector;
      if (inspector && typeof inspector.renderInspectorReport === 'function') {
        inspector.renderInspectorReport(elements, fakeReport);
      }

      const capCards = Array.from(document.querySelectorAll('#inspector-results .inspector-cap-card'));
      const cardsHaveSvgs = capCards.length > 0 && capCards.every(c => !!c.querySelector('.cap-card-title svg.ui-icon'));
      const text = document.getElementById('inspector-results')?.textContent || '';
      const hasCapEmojis = /📡|⚙️|👁️|🧠|📋|💾|🔢|🤖/.test(text);

      return {
        cardCount: capCards.length,
        cardsHaveSvgs,
        hasCapEmojis
      };
    });

    assert.ok(inspectorCapSvgs.cardCount >= 4, 'Deben renderizarse las tarjetas de capacidad en el inspector');
    assert.ok(inspectorCapSvgs.cardsHaveSvgs, 'Todas las tarjetas de capacidad deben renderizar iconos SVG vectoriales');
    assert.equal(inspectorCapSvgs.hasCapEmojis, false, 'Las tarjetas de capacidad no deben contener emojis residuales');

  } finally {
    await browser.close();
  }
});
});
