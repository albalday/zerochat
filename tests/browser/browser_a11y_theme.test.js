const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestBrowser, closeGlobalBrowser, getIndexUrl, waitForAppReady } = require('../helpers/browser-env.js');

describe('Browser UI - a11y_theme', { concurrency: 3 }, () => {
  after(async () => {
    await closeGlobalBrowser();
  });

test('Browser UI - temas claro/oscuro, foco visible y contraste AA en exportación', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);

    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('Tab');
    const focusedOutline = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
    assert.notEqual(focusedOutline, 'none', 'El elemento enfocado por teclado debe tener un indicador visual outline');

    const readTheme = theme => page.evaluate(theme => {
      document.getElementById(`btn-theme-${theme}`).click();
      const docStyle = getComputedStyle(document.documentElement);
      return {
        dataTheme: document.documentElement.getAttribute('data-theme'),
        primary: docStyle.getPropertyValue('--primary').trim(),
        bgApp: docStyle.getPropertyValue('--bg-app').trim(),
        radiusMd: docStyle.getPropertyValue('--radius-md').trim(),
        bodyBg: getComputedStyle(document.body).backgroundColor,
        iconStroke: document.querySelector('.app-header svg.ui-icon')?.getAttribute('stroke')
      };
    }, theme);
    const light = await readTheme('light');
    const dark = await readTheme('dark');
    assert.ok([null, 'light'].includes(light.dataTheme), 'El tema claro no debe dejar activo el oscuro');
    assert.equal(dark.dataTheme, 'dark');
    assert.ok(light.primary && light.bgApp && light.radiusMd && dark.primary, 'Los design tokens deben resolverse en ambos temas');
    assert.notEqual(dark.bgApp, light.bgApp, 'El fondo de la app debe diferir entre temas');
    assert.notEqual(dark.bodyBg, light.bodyBg, 'El fondo computado del body debe cambiar en dark');
    assert.equal(dark.iconStroke, 'currentColor', 'Los iconos deben heredar el color del tema');

    const exportDarkContrast = await page.evaluate(() => {
      document.getElementById('export-modal').showModal();
      const parseColor = color => (color.match(/\d+/g) || []).slice(0, 3).map(Number);
      const luminance = color => {
        const channels = parseColor(color).map(value => {
          const normalized = value / 255;
          return normalized <= 0.03928 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
      };
      const contrast = (foreground, background) => {
        const [high, low] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
        return (high + 0.05) / (low + 0.05);
      };
      const card = document.querySelector('#export-modal .export-card-btn');
      const background = getComputedStyle(card).backgroundColor;
      const close = getComputedStyle(document.getElementById('btn-close-export'));
      return {
        title: contrast(getComputedStyle(card.querySelector('strong')).color, background),
        description: contrast(getComputedStyle(card.querySelector('.export-card-info span')).color, background),
        closeDistinct: close.color !== close.backgroundColor
      };
    });
    assert.ok(exportDarkContrast.title >= 4.5, 'El título de cada tarjeta de exportación debe tener contraste AA en oscuro');
    assert.ok(exportDarkContrast.description >= 4.5, 'La descripción de cada tarjeta de exportación debe tener contraste AA en oscuro');
    assert.equal(exportDarkContrast.closeDistinct, true, 'El cierre de exportación debe usar colores semánticos en oscuro');
  } finally {
    await browser.close();
  }
});

test('Browser UI - controles estáticos y dinámicos usan iconos SVG sin emojis', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);

    const audit = await page.evaluate(() => {
      const container = document.getElementById('messages-list');
      const jsCard = ChatToolCards.createLiveToolCard('execute_javascript', { code: 'console.log("hola");' });
      const searchCard = ChatToolCards.createLiveToolCard('search_web', { query: 'test query' });
      container.append(jsCard, searchCard);
      const runningSpinners = [jsCard, searchCard].every(card => !!card.querySelector('.tool-card-badge svg.ui-icon-spin'));
      ChatToolCards.updateLiveToolCard(jsCard, 'execute_javascript', {}, { success: true, result: 'hola' }, 42);

      const chart = document.createElement('div');
      chart.innerHTML = ChatCharts.renderChartCard({ type: 'bar', title: 'Ventas', labels: ['Ene', 'Feb'], datasets: [{ label: 'Ventas', data: [10, 20] }] });
      container.append(chart);

      ChatUISidebar.renderSidebarChats({ sidebarChatsList: document.getElementById('sidebar-chats-list') }, [
        { id: 'sess_icons', title: 'Conversación de prueba', updatedAt: Date.now() }
      ], 'sess_icons', {});

      ChatUIInspector.renderInspectorReport({ inspectorResults: document.getElementById('inspector-results') }, {
        provider: { id: 'openai', label: 'OpenAI Test' },
        endpoint: { normalized: 'https://api.openai.com/v1/chat/completions' },
        model: { selected: 'gpt-4o', totalDiscovered: 1 },
        inspectionTimeMs: 120,
        capabilities: Object.fromEntries(['streaming', 'tools', 'vision', 'reasoning'].map(key => [key, { status: 'confirmed', detail: 'OK' }]))
      });

      // Cada selector designa controles que deben mostrar un icono vectorial.
      const iconSelectors = [
        '.header-profile-trigger .profile-icon', '#btn-open-rag', '#btn-toggle-debug', '#btn-reasoning',
        '#btn-sidebar-new-chat', '#btn-open-settings', '#btn-close-sidebar', '.sidebar-search-box',
        '#btn-import-chat-file', '#btn-delete-all-chats', '.sidebar-chat-item .btn-export',
        '.sidebar-chat-item .btn-rename', '.sidebar-chat-item .btn-delete', '.reasoning-menu-header',
        '#sidebar-settings-nav .sidebar-settings-item', '#btn-toggle-key', '#btn-clear-all-data', '.btn-theme-toggle',
        '#export-modal .modal-icon', '#btn-close-export', '#export-modal .export-card-icon',
        '#btn-rag-save-branch', '#btn-rag-delete-branch', '#btn-rag-export-branch', '#btn-rag-import-branch',
        '.tool-card-title', '.tool-card-badge', '.btn-tool-collapse', '.chat-chart-title', '#inspector-results .cap-card-title'
      ];
      const missingIcons = iconSelectors.flatMap(selector => {
        const elements = Array.from(document.querySelectorAll(selector));
        if (elements.length === 0) return [`${selector} (no existe)`];
        return elements.some(element => !element.querySelector('svg')) ? [selector] : [];
      });

      const emoji = /\p{Extended_Pictographic}/u;
      const chromeSelectors = 'button, option, .app-header, .tool-card-title, .tool-card-badge, .chat-chart-title, .cap-card-title, .sidebar-settings-item, .export-card-btn, .settings-section-pane label';
      const withEmoji = Array.from(document.querySelectorAll(chromeSelectors))
        .filter(element => emoji.test(element.textContent))
        .map(element => element.id || element.className || element.tagName);

      const icons = Array.from(document.querySelectorAll('svg.ui-icon'));
      return {
        runningSpinners,
        completedCollapsed: !!jsCard.querySelector('.tool-execution-card.collapsed') || jsCard.classList.contains('collapsed'),
        missingIcons,
        withEmoji,
        iconCount: icons.length,
        malformedIcons: icons.filter(svg => svg.getAttribute('viewBox') !== '0 0 24 24' || svg.children.length === 0).length,
        headerIconsRendered: Array.from(document.querySelectorAll('.top-header svg.ui-icon')).every(svg => svg.getBoundingClientRect().width > 0)
      };
    });

    assert.equal(audit.runningSpinners, true, 'Las tarjetas en ejecución deben mostrar un spinner SVG');
    assert.equal(audit.completedCollapsed, true, 'La tarjeta de la tool debe minimizarse tras su ejecución');
    assert.deepEqual(audit.missingIcons, [], 'Todos los controles deben incluir su icono SVG');
    assert.deepEqual(audit.withEmoji, [], 'Ningún control de la interfaz debe contener emojis');
    assert.ok(audit.iconCount >= 20, `Debe haber al menos 20 iconos vectoriales (encontrados: ${audit.iconCount})`);
    assert.equal(audit.malformedIcons, 0, 'Todos los iconos SVG deben usar viewBox 0 0 24 24 y contener trazos');
    assert.equal(audit.headerIconsRendered, true, 'Los iconos de la cabecera deben renderizarse con dimensiones positivas');
  } finally {
    await browser.close();
  }
});

test('Browser UI - RAG crea y edita ramas en pantalla sin diálogos nativos', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);

    // Verificación de gestión de ramas con campos en pantalla (sin ventanas prompt nativas)
    let dialogTriggered = false;
    page.on('dialog', () => { dialogTriggered = true; });

    await page.locator('#btn-open-settings').evaluate(button => button.click());
    await page.click('.sidebar-settings-item[data-section="rag"]');
    await page.click('#btn-rag-branches');
    await page.waitForSelector('#rag-manage-modal[open]');
    const layout = await page.evaluate(() => ({
      saveText: document.getElementById('btn-rag-save-branch')?.textContent.trim(),
      actionsInHeader: !!document.querySelector('#rag-manage-modal .settings-section-header .settings-header-actions #btn-rag-export-branch'),
      footer: !!document.querySelector('#rag-manage-modal .modal-footer'),
      branchSelectWidth: parseFloat(getComputedStyle(document.getElementById('rag-manage-branch-select')).width)
    }));
    assert.equal(layout.saveText, 'Guardar', 'El texto del botón de guardar debe ser permanentemente "Guardar"');
    assert.equal(layout.actionsInHeader, true, 'Las acciones principales deben estar en la cabecera de gestión');
    assert.equal(layout.footer, false, 'El panel de gestión no debe tener pie de acciones');
    assert.ok(layout.branchSelectWidth > 200, 'El selector de rama debe aprovechar el ancho disponible');
    await page.waitForSelector('#rag-branch-details-card');
    await page.waitForFunction(() => {
      const sel = document.getElementById('rag-manage-branch-select');
      return sel && sel.options.length > 0 && Array.from(sel.options).some(o => o.value === '__new__');
    });

    // Verificar que el textbox en la pestaña de documentos fue eliminado para ganar espacio
    const workspaceHasTextbox = await page.$eval('#rag-manage-workspace', el => !!el.querySelector('.rag-workspace-summary'));
    assert.equal(workspaceHasTextbox, false, 'El workspace de documentos no debe tener el textbox de resumen para ganar espacio');

    // Seleccionar "+ Nueva rama..." en el combo para iniciar la creación
    await page.selectOption('#rag-manage-branch-select', '__new__');
    assert.equal(await page.$eval('#btn-rag-save-branch', el => el.disabled), true, 'El botón Guardar debe estar desactivado con nombre vacío');

    await page.fill('#rag-branch-name-input', 'Rama de navegador');
    await page.fill('#rag-branch-desc-input', 'Descripción de prueba de navegador');

    // Verificar que al escribir un nombre el botón Guardar se habilita y mantiene el texto "Guardar"
    assert.equal(await page.$eval('#btn-rag-save-branch', el => el.disabled), false, 'Al escribir un nombre el botón Guardar se activa');
    assert.equal(await page.$eval('#btn-rag-save-branch', el => el.textContent.trim()), 'Guardar');

    // Pulsar el botón Guardar
    await page.click('#btn-rag-save-branch');

    await page.waitForFunction(() => {
      const select = document.getElementById('rag-manage-branch-select');
      return select && Array.from(select.options).some(opt => opt.text.includes('Rama de navegador'));
    });

    // Verificar que tras guardar el botón queda desactivado pero sigue siendo "Guardar"
    assert.equal(await page.$eval('#btn-rag-save-branch', el => el.disabled), true, 'Tras guardar el botón queda desactivado');
    assert.equal(await page.$eval('#btn-rag-save-branch', el => el.textContent.trim()), 'Guardar');

    const createdBranch = await page.evaluate(async () => {
      const branches = await window.ChatRagStorage.getBranches();
      return branches.find(b => b.name === 'Rama de navegador');
    });

    assert.ok(createdBranch, 'La rama debe haberse creado en IndexedDB');
    assert.equal(createdBranch.description, 'Descripción de prueba de navegador', 'La descripción debe haberse guardado');
    assert.equal(dialogTriggered, false, 'No debe haberse disparado ningún diálogo prompt() nativo');

    // Modificar descripción en pantalla y verificar que se activa el botón Guardar
    await page.fill('#rag-branch-desc-input', 'Descripción editada sin prompts');
    assert.equal(await page.$eval('#btn-rag-save-branch', el => el.disabled), false, 'Al modificar la descripción el botón Guardar se activa');
    assert.equal(await page.$eval('#btn-rag-save-branch', el => el.textContent.trim()), 'Guardar');

    await page.click('#btn-rag-save-branch');

    await page.waitForFunction(async (branchId) => {
      const b = await window.ChatRagStorage.getBranchById(branchId);
      return b && b.description === 'Descripción editada sin prompts';
    }, createdBranch.id);

    const updatedBranch = await page.evaluate(async (branchId) => {
      return await window.ChatRagStorage.getBranchById(branchId);
    }, createdBranch.id);

    assert.equal(updatedBranch.description, 'Descripción editada sin prompts', 'La modificación debe haberse guardado');
    assert.equal(dialogTriggered, false, 'No debe haberse mostrado ningún diálogo emergente bloqueante');

    assert.equal(await page.$eval('#btn-rag-save-branch', el => el.disabled), true, 'Tras guardar la modificación el botón Guardar vuelve a desactivarse');
    assert.equal(await page.$eval('#btn-rag-save-branch', el => el.textContent.trim()), 'Guardar');
    // Verificar que el diálogo de activación también muestra el resumen de cada rama
    await page.click('#btn-close-rag-manage');
    await page.click('#btn-open-rag');
    await page.waitForSelector('#rag-modal[open]');
    await page.waitForSelector('.rag-branch-select-card .rag-branch-metrics');
    const activeBranchMetricsText = await page.$eval('.rag-branch-select-card .rag-branch-metrics', el => el.textContent.trim());
    assert.ok(activeBranchMetricsText.includes('Esta rama cargó'), 'El resumen de cada rama en la pestaña Activar debe decir "Esta rama cargó"');
    assert.ok(activeBranchMetricsText.includes('documentos de'), 'El resumen de cada rama en la pestaña Activar debe usar "documentos de"');

    await page.click('#btn-close-rag');
  } finally {
    await browser.close();
  }
});

});
