const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createTestBrowser, closeGlobalBrowser } = require('../helpers/browser-env.js');

describe('Browser UI - mcp_tools', { concurrency: 2 }, () => {
  after(async () => {
    await closeGlobalBrowser();
  });

test('Browser UI - los metadatos MCP externos se renderizan como texto', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    await page.goto('file://' + path.resolve(__dirname, '../../zerochat.html'), { waitUntil: 'load' });
    await page.waitForFunction(() => document.documentElement.classList.contains('zerochat-ready'));
    const result = await page.evaluate(() => {
      const serverDetails = document.createElement('div');
      const elements = {
        statusBadge: document.createElement('div'),
        statusText: document.createElement('span'),
        serverDetails
      };
      const payload = '<img data-xss-probe="mcp" src=x onerror="window.__mcpXss=true">';
      window.ChatUIMcp.renderConnectionStatus(elements, {
        status: 'connected',
        serverInfo: { name: payload, version: payload },
        tools: []
      }, key => key);
      const detailsSafe = !serverDetails.querySelector('[data-xss-probe]') && (serverDetails.textContent.includes(payload) || (serverDetails.getAttribute('title') || '').includes(payload));
      return {
        detailsSafe,
        executed: Boolean(window.__mcpXss)
      };
    });
    assert.equal(result.detailsSafe, true);
    assert.equal(result.executed, false);
  } finally { await browser.close(); }
});

test('Browser UI - RAG avisa al combinar ramas con idiomas distintos sin alterar su activación', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto('file://' + path.resolve(__dirname, '../../zerochat.html'), { waitUntil: 'load' });
    await page.waitForFunction(() => document.documentElement.classList.contains('zerochat-ready'));
    const branchIds = await page.evaluate(async () => {
      await window.ChatRagStorage.clearAllData();
      window.ChatRagUI.setActiveBranchIds([]);
      const spanishOne = await window.ChatRagStorage.createBranch({ name: 'ES uno', language: 'spanish' });
      const spanishTwo = await window.ChatRagStorage.createBranch({ name: 'ES dos', language: 'spanish' });
      const english = await window.ChatRagStorage.createBranch({ name: 'EN', language: 'english' });
      return { spanishOne: spanishOne.id, spanishTwo: spanishTwo.id, english: english.id };
    });

    await page.click('#btn-open-rag');
    await page.waitForFunction(() => document.querySelectorAll('#rag-modal [data-branch-id]').length === 3);

    await page.locator(`#rag-modal [data-branch-id="${branchIds.spanishOne}"]`).click();
    await page.waitForTimeout(50);
    assert.equal(await page.$eval('#notice-dialog', dialog => dialog.open), false);

    await page.locator(`#rag-modal [data-branch-id="${branchIds.spanishTwo}"]`).click();
    await page.waitForTimeout(50);
    assert.equal(await page.$eval('#notice-dialog', dialog => dialog.open), false);

    await page.locator(`#rag-modal [data-branch-id="${branchIds.english}"]`).click();
    await page.waitForFunction(() => document.getElementById('notice-dialog')?.open);
    const warningText = await page.$eval('#notice-message', el => el.textContent);
    assert.match(warningText, /idiomas distintos/i);
    assert.match(warningText, /Español/i);
    assert.match(warningText, /Inglés/i);
    assert.equal(await page.evaluate(() => window.ChatRagUI.getActiveBranchIds().length), 3);
    await page.click('#notice-accept');
    await page.click('#btn-close-rag');
  } finally {
    await browser.close();
  }
});

test('Browser UI - los cambios de Agente y Permisos avisan antes de cerrar ajustes', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto('file://' + path.resolve(__dirname, '../../zerochat.html'), { waitUntil: 'load' });
    await page.waitForFunction(() => document.documentElement.classList.contains('zerochat-ready'));

    await page.click('#btn-open-settings');
    await page.click('[data-section="tab-agent"]');
    await page.waitForFunction(() => document.getElementById('settings-dialog')?.open);
    await page.$eval('#setting-max-agent-turns', (input) => {
      input.value = String(Number(input.value) + 1);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    assert.equal(await page.$eval('#settings-dialog', dialog => dialog.dataset.settingsDirty), 'true');

    await page.click('#btn-close-settings');
    await page.waitForFunction(() => document.getElementById('notice-dialog')?.open);
    assert.match(await page.$eval('#notice-message', el => el.textContent), /cambios sin guardar/i);
    await page.click('#notice-cancel');
    await page.waitForFunction(() => !document.getElementById('notice-dialog')?.open);

    await page.click('#btn-close-settings');
    await page.waitForFunction(() => document.getElementById('notice-dialog')?.open);
    await page.click('#notice-accept');
    await page.waitForFunction(() => !document.getElementById('settings-dialog')?.open);
    await page.click('[data-section="tab-permissions"]');
    await page.waitForFunction(() => document.getElementById('settings-dialog')?.open);
    await page.locator('.mcp-policy-option:has(#mcp-policy-allow-all)').click();
    assert.equal(await page.$eval('#settings-dialog', dialog => dialog.dataset.settingsDirty), 'true');
    await page.click('#btn-close-settings');
    await page.waitForFunction(() => document.getElementById('notice-dialog')?.open);
    await page.click('#notice-cancel');
    await page.locator('.mcp-policy-option:has(#mcp-policy-ask)').click();
    await page.click('#btn-close-settings');
    await page.waitForFunction(() => document.getElementById('notice-dialog')?.open);
    await page.click('#notice-accept');
    await page.waitForFunction(() => !document.getElementById('settings-dialog')?.open);
  } finally {
    await browser.close();
  }
});

test('Browser UI - configuración MCP, perfiles y secciones permanecen operativas', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const filePath = 'file://' + path.resolve(__dirname, '../../zerochat.html');
    await page.goto(filePath, { waitUntil: 'load' });
    await page.waitForSelector('#welcome-banner');

    // 1. Abrir diálogo de Configuración.
    await page.click('#btn-open-settings');
    await page.click('[data-section="tab-model"]');
    await page.waitForFunction(() => document.getElementById('settings-dialog')?.open);

    const contextCachePlacement = await page.evaluate(() => ({
      automaticNotice: !!document.querySelector('#tab-model [data-i18n="model_cache_title"]'),
      legacyToggle: !!document.getElementById('setting-enable-context-cache'),
      agentCacheText: document.querySelector('#tab-agent')?.textContent.includes('Caché de Contexto') || false
    }));
    assert.ok(contextCachePlacement.automaticNotice, 'La caché automática debe explicarse en la pestaña Modelo');
    assert.equal(contextCachePlacement.legacyToggle, false, 'La caché no debe exponerse como un interruptor de Agente');
    assert.equal(contextCachePlacement.agentCacheText, false, 'La pestaña Agente no debe presentar la caché como herramienta');

    // 2. Navegar entre secciones del sidebar de configuración
    await page.click('#btn-close-settings');
    await page.waitForSelector('#sidebar-settings-nav');
    const sectionButtons = await page.$$('#sidebar-settings-nav .sidebar-settings-item');
    assert.ok(sectionButtons.length >= 2, 'Debe haber múltiples opciones en la navegación de configuración');

    // Hacer click en la segunda sección (tab-model)
    await sectionButtons[1].click();
    await page.waitForFunction(() => document.getElementById('settings-dialog')?.open);
    const isSecondSectionActive = await sectionButtons[1].evaluate(el => el.classList.contains('active'));
    assert.ok(isSecondSectionActive, 'Hacer click en la sección debe marcarla como .active');

    // 2b. Cerrar settings y abrir mantenedor de perfiles desde el combo de perfiles del composer
    await page.click('#btn-close-settings');
    await page.waitForFunction(() => !document.getElementById('settings-dialog')?.open);

    await page.click('#active-profile-trigger');
    await page.click('#btn-menu-new-profile');
    await page.waitForFunction(() => document.getElementById('profiles-dialog')?.open);
    await page.fill('#setting-profile-name', 'Perfil Temporal Browser');
    await page.fill('#setting-api-url', 'http://browser-test:1234/v1');
    await page.evaluate(() => {
      window.ChatUIInspector.handleQueryServer = async () => {
        const model = document.getElementById('setting-model');
        const select = document.getElementById('model-select-helper');
        select.replaceChildren(new Option('query-model', 'query-model'));
        select.value = 'query-model';
        model.value = 'query-model';
        return true;
      };
    });
    await page.click('#btn-query-server');
    await page.waitForFunction(() => !document.getElementById('btn-save-profile').disabled);
    await page.click('#btn-save-profile');

    const profileSaveResult = await page.evaluate(() => {
      const dialog = document.getElementById('profiles-dialog');
      const feedback = document.getElementById('profile-action-feedback');
      const profile = window.ChatProfileRepository?.findByName?.('Perfil Temporal Browser');
      const runtime = window.ChatConfig?.getActive?.();
      return {
        isOpen: dialog.open,
        feedbackVisible: feedback && feedback.style.display !== 'none',
        savedUrl: profile?.settings?.apiUrl,
        runtimeUrl: runtime?.apiUrl
      };
    });

    assert.equal(profileSaveResult.isOpen, false, 'Guardar el perfil debe cerrar el mantenedor');
    assert.equal(profileSaveResult.savedUrl, 'http://browser-test:1234/v1', 'Debe persistir el perfil en su repositorio');
    assert.equal(profileSaveResult.runtimeUrl, 'http://browser-test:1234/v1', 'El perfil guardado debe quedar activo por defecto');

    // Renombrar el perfil creado actualiza el mismo registro y recarga sus datos.
    const createdProfileId = await page.evaluate(() => window.ChatProfileRepository.findByName('Perfil Temporal Browser').id);
    await page.click('#active-profile-trigger');
    await page.click(`.header-profile-item:has([data-profile-id="${createdProfileId}"]) [data-profile-action="edit"]`);
    await page.waitForFunction(() => document.getElementById('profiles-dialog')?.open);
    await page.fill('#setting-profile-name', 'Perfil Temporal renombrado');
    await page.fill('#setting-api-url', 'http://active-profile-test:1234/v1');
    await page.evaluate(() => {
      window.ChatUIInspector.handleQueryServer = async () => {
        const model = document.getElementById('setting-model');
        const select = document.getElementById('model-select-helper');
        select.replaceChildren(new Option('query-model', 'query-model'));
        select.value = 'query-model';
        model.value = 'query-model';
        return true;
      };
    });
    await page.click('#btn-query-server');
    await page.waitForFunction(() => !document.getElementById('btn-save-profile').disabled);
    await page.click('#btn-save-profile');
    const renamedActiveResult = await page.evaluate(() => {
      const profiles = window.ChatProfileRepository?.list?.() || [];
      const runtime = window.ChatConfig?.getActive?.();
      return {
        renamedCount: profiles.filter(profile => profile.name === 'Perfil Temporal renombrado').length,
        oldNameExists: profiles.some(profile => profile.name === 'Perfil Temporal Browser'),
        runtimeName: runtime?.activeProfile?.name,
        runtimeUrl: runtime?.apiUrl
      };
    });
    assert.equal(renamedActiveResult.renamedCount, 1, 'Renombrar no debe duplicar el perfil');
    assert.equal(renamedActiveResult.oldNameExists, false, 'El nombre anterior debe desaparecer del selector');
    assert.equal(renamedActiveResult.runtimeName, 'Perfil Temporal renombrado', 'El perfil activo debe reflejar el nuevo nombre');
    assert.equal(renamedActiveResult.runtimeUrl, 'http://active-profile-test:1234/v1', 'Los cambios del perfil activo deben recargarse');

    // 2c. Verificar las secciones MCP y Permisos en el sidebar de configuración
    const isSettingsNavVisible = await page.evaluate(() => {
      const view = document.getElementById('sidebar-view-settings');
      return !!view && !view.hidden && getComputedStyle(view).display !== 'none';
    });
    if (!isSettingsNavVisible) {
      await page.click('#btn-open-settings');
    }
    const sectionOrder = await page.$$eval('#sidebar-settings-nav .sidebar-settings-item', els => els.map(e => e.getAttribute('data-section')));
    const agentIndex = sectionOrder.indexOf('tab-agent');
    const ragIndex = sectionOrder.indexOf('rag-manage');
    const mcpIndex = sectionOrder.indexOf('tab-mcp');
    const permissionsIndex = sectionOrder.indexOf('tab-permissions');
    assert.ok(agentIndex >= 0 && ragIndex === agentIndex + 1, 'La sección RAG debe estar posicionada inmediatamente después de Agente');
    assert.ok(mcpIndex === ragIndex + 1, 'La sección MCP debe estar posicionada inmediatamente después de RAG');
    assert.ok(permissionsIndex === mcpIndex + 1, 'La sección Permisos debe estar inmediatamente después de MCP');

    const mcpSectionBtn = await page.$('#sidebar-settings-nav button[data-section="tab-mcp"]');
    assert.ok(mcpSectionBtn, 'Debe existir la sección MCP en la navegación de configuración');
    await mcpSectionBtn.click();
    await page.waitForFunction(() => document.getElementById('settings-dialog')?.open);
    const isMcpActive = await mcpSectionBtn.evaluate(el => el.classList.contains('active'));
    assert.ok(isMcpActive, 'La sección MCP debe quedar activa al hacer click');

    const mcpUiState = await page.evaluate(() => {
      const pane = document.getElementById('tab-mcp');
      const badge = document.getElementById('mcp-status-badge');
      const btnConnect = document.getElementById('btn-mcp-connect');
      const bootstrap = document.getElementById('mcp-bootstrap-card');
      const command = document.getElementById('mcp-terminal-command');
      const help = bootstrap?.querySelector('a');
      return {
        paneActive: pane?.classList.contains('active'),
        badgeText: badge?.textContent?.trim(),
        hasConnectBtn: !!btnConnect,
        hasSetupDialog: !!document.getElementById('mcp-setup-dialog'),
        bootstrapVisible: bootstrap && getComputedStyle(bootstrap).display !== 'none',
        commandText: command?.textContent?.trim(),
        helpHref: help?.getAttribute('href'),
        hasToolsContainer: !!document.getElementById('mcp-tools-container'),
        toolsContainerVisible: document.getElementById('mcp-tools-container')?.style?.display !== 'none'
      };
    });

    assert.ok(mcpUiState.paneActive, 'El panel tab-mcp debe estar visible y activo');
    assert.ok(mcpUiState.badgeText.includes('Desconectado') || mcpUiState.badgeText.includes('Conectado'), 'El estado debe ser Desconectado o Conectado según disponibilidad');
    assert.equal(mcpUiState.hasConnectBtn, false, 'El panel MCP no debe ofrecer conexión manual');
    assert.equal(mcpUiState.hasSetupDialog, false, 'El subpanel de conexión manual no debe existir');
    assert.ok(mcpUiState.bootstrapVisible, 'Debe explicar cómo arrancar el servidor local cuando no está disponible');
    assert.equal(mcpUiState.commandText, 'pip install zerochat && zerochat');
    assert.equal(mcpUiState.helpHref, 'help/mcp.html');
    assert.ok(mcpUiState.hasToolsContainer, 'El contenedor de herramientas MCP debe estar presente');
    assert.ok(mcpUiState.toolsContainerVisible, 'El contenedor de herramientas MCP debe estar visible');

    await page.click('#btn-close-settings');
    await page.waitForFunction(() => !document.getElementById('settings-dialog')?.open);

    const permissionsSectionBtn = await page.$('#sidebar-settings-nav button[data-section="tab-permissions"]');
    assert.ok(permissionsSectionBtn, 'Debe existir la sección Permisos en la navegación de configuración');
    await permissionsSectionBtn.click();
    await page.waitForFunction(() => document.getElementById('settings-dialog')?.open);
    const permissionsState = await page.evaluate(() => ({
      paneActive: document.getElementById('tab-permissions')?.classList.contains('active'),
      hasAskPolicy: !!document.getElementById('mcp-policy-ask'),
      hasSavedAuthorizations: !!document.getElementById('mcp-saved-auths-list')
    }));
    assert.ok(permissionsState.paneActive, 'El panel tab-permissions debe quedar visible y activo');
    assert.ok(permissionsState.hasAskPolicy, 'La política de permisos debe estar disponible en la nueva pestaña');
    assert.ok(permissionsState.hasSavedAuthorizations, 'Las autorizaciones recordadas deben estar disponibles en la nueva pestaña');

    // Volver a la sección MCP
    await page.click('#btn-close-settings');
    await page.waitForFunction(() => !document.getElementById('settings-dialog')?.open);
    await mcpSectionBtn.click();
    await page.waitForFunction(() => document.getElementById('settings-dialog')?.open);

    // 3. Cerrar ambos modales sin guardar la configuración general.
    await page.waitForFunction(() => !document.getElementById('profiles-dialog')?.open);
    await page.click('#btn-close-settings');
    await page.waitForFunction(() => !document.getElementById('settings-dialog')?.open);
    const isClosed = await page.$eval('#settings-dialog', el => !el.open);
    assert.ok(isClosed, 'El diálogo debe cerrarse correctamente');

  } finally {
    await browser.close();
  }
});

test('Browser UI - Botón y cabecera para abrir/cerrar tool funcionan al recuperar del historial', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const filePath = 'file://' + path.resolve(__dirname, '../../zerochat.html');
    await page.goto(filePath, { waitUntil: 'load' });
    await page.waitForSelector('#welcome-banner');

    // 1. Guardar y cargar una conversación con tool en el almacenamiento
    await page.evaluate(async () => {
      const history = [
        { id: 'msg_u_tool', role: 'user', content: 'Calcula 10 + 20' },
        {
          id: 'msg_a_tool',
          role: 'assistant',
          content: 'He ejecutado el código para calcularlo:',
          tool_calls: [{
            id: 'call_js_hist_1',
            type: 'function',
            function: { name: 'execute_javascript', arguments: '{"javascript":"return 10 + 20;"}' }
          }]
        },
        {
          id: 'msg_t_tool',
          role: 'tool',
          tool_call_id: 'call_js_hist_1',
          name: 'execute_javascript',
          content: '{"success":true,"result":"30"}'
        }
      ];
      await window.ChatStorage.saveConversation({ id: 'sess_tool_hist_toggle', title: 'Test Tool Toggle', createdAt: Date.now() }, history);
      await window.ChatApp.switchToSession('sess_tool_hist_toggle');
    });

    // 2. Esperar que se renderice la tarjeta de la tool
    await page.waitForSelector('.tool-execution-card');

    // 3. Verificar que aparece minimizada (collapsed) inicialmente
    const isInitiallyCollapsed = await page.$eval('.tool-execution-card', el => el.classList.contains('collapsed'));
    assert.equal(isInitiallyCollapsed, true, 'La tarjeta de tool recuperada del historial debe estar minimizada inicialmente');

    // 4. Hacer clic en el botón .btn-tool-collapse y verificar que se abre (no colapsada)
    await page.click('.btn-tool-collapse');
    const isOpenedAfterBtnClick = await page.$eval('.tool-execution-card', el => !el.classList.contains('collapsed'));
    assert.equal(isOpenedAfterBtnClick, true, 'Al pulsar el botón .btn-tool-collapse debe expandirse la tarjeta');

    // 5. Hacer clic de nuevo en el botón .btn-tool-collapse y verificar que se cierra
    await page.click('.btn-tool-collapse');
    const isClosedAfterSecondClick = await page.$eval('.tool-execution-card', el => el.classList.contains('collapsed'));
    assert.equal(isClosedAfterSecondClick, true, 'Al pulsar de nuevo el botón .btn-tool-collapse debe volver a minimizarse');

    // 6. Hacer clic en la cabecera .tool-card-header y verificar que también se expande
    await page.click('.tool-card-header');
    const isOpenedAfterHeaderClick = await page.$eval('.tool-execution-card', el => !el.classList.contains('collapsed'));
    assert.equal(isOpenedAfterHeaderClick, true, 'Al pulsar en la cabecera de la tarjeta debe expandirse');
  } finally {
    await browser.close();
  }
});
});
