const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTestBrowser, closeGlobalBrowser, seedConnectionProfiles, getBundleUrl, getIndexUrl } = require('../helpers/browser-env.js');

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
      const errorMessage = document.createElement('div');
      const elements = {
        statusBadge: document.createElement('div'),
        statusText: document.createElement('span'),
        btnConnect: document.createElement('button'),
        serverDetails,
        errorMessage
      };
      const payload = '<img data-xss-probe="mcp" src=x onerror="window.__mcpXss=true">';
      window.ChatUIMcp.renderConnectionStatus(elements, {
        status: 'connected',
        serverInfo: { name: payload, version: payload },
        tools: []
      }, key => key);
      const detailsSafe = !serverDetails.querySelector('[data-xss-probe]') && serverDetails.textContent.includes(payload);
      window.ChatUIMcp.renderConnectionStatus(elements, {
        status: 'error',
        error: payload
      }, key => key);
      return {
        detailsSafe,
        errorSafe: !errorMessage.querySelector('[data-xss-probe]') && errorMessage.textContent.includes(payload),
        executed: Boolean(window.__mcpXss)
      };
    });
    assert.equal(result.detailsSafe, true);
    assert.equal(result.errorSafe, true);
    assert.equal(result.executed, false);
  } finally { await browser.close(); }
});

test('Browser UI - Fase 6: Modales <dialog> Modernos con Blur y Tarjetas de Herramientas', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const filePath = 'file://' + path.resolve(__dirname, '../../zerochat.html');
    await page.goto(filePath, { waitUntil: 'load' });
    await page.waitForSelector('#welcome-banner');

    // 1. Abrir diálogo de Configuración y validar propiedades de modal moderno
    await page.click('#btn-open-settings');
    await page.click('[data-section="tab-general"]');
    await page.waitForFunction(() => document.getElementById('settings-dialog')?.open);

    const dialogMetrics = await page.evaluate(() => {
      const dialog = document.getElementById('settings-dialog');
      const style = getComputedStyle(dialog);
      return {
        borderRadius: parseFloat(style.borderRadius),
        boxShadow: style.boxShadow,
        display: style.display
      };
    });

    assert.equal(dialogMetrics.display, 'flex', 'El diálogo abierto debe tener display: flex');
    assert.ok(dialogMetrics.borderRadius >= 16, `El radio de curvatura (${dialogMetrics.borderRadius}px) debe ser moderno (>= 16px / 1.25rem)`);
    assert.notEqual(dialogMetrics.boxShadow, 'none', 'El modal debe tener elevación con sombra');

    // Validar que en viewport móvil el modal usa todo el ancho de la pantalla
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => Promise.all(document.getElementById('settings-dialog').getAnimations().map(a => a.finished)));
    const mobileMetrics = await page.evaluate(() => {
      const dialog = document.getElementById('settings-dialog');
      const rect = dialog.getBoundingClientRect();
      return {
        width: Math.round(rect.width),
        windowWidth: window.innerWidth,
        left: Math.round(rect.left)
      };
    });
    assert.equal(mobileMetrics.width, mobileMetrics.windowWidth, 'En móvil el modal debe usar todo el ancho de la pantalla');
    assert.equal(mobileMetrics.left, 0, 'En móvil el modal debe extenderse desde el borde izquierdo (left: 0)');
    await page.setViewportSize({ width: 1280, height: 800 });

    const contextCachePlacement = await page.evaluate(() => ({
      automaticNotice: !!document.querySelector('#tab-model [data-i18n="model_cache_title"]'),
      legacyToggle: !!document.getElementById('setting-enable-context-cache'),
      agentCacheText: document.querySelector('#tab-agent')?.textContent.includes('Caché de Contexto') || false
    }));
    assert.ok(contextCachePlacement.automaticNotice, 'La caché automática debe explicarse en la pestaña Modelo');
    assert.equal(contextCachePlacement.legacyToggle, false, 'La caché no debe exponerse como un interruptor de Agente');
    assert.equal(contextCachePlacement.agentCacheText, false, 'La pestaña Agente no debe presentar la caché como herramienta');

    // 2. Navegar entre secciones del sidebar de configuración
    await page.click('#btn-settings-back');
    await page.waitForSelector('#sidebar-settings-nav');
    const sectionButtons = await page.$$('#sidebar-settings-nav .sidebar-settings-item');
    assert.ok(sectionButtons.length >= 2, 'Debe haber múltiples opciones en la navegación de configuración');

    // Hacer click en la segunda sección (tab-model)
    await sectionButtons[1].click();
    await page.waitForFunction(() => document.getElementById('settings-dialog')?.open);
    const isSecondSectionActive = await sectionButtons[1].evaluate(el => el.classList.contains('active'));
    assert.ok(isSecondSectionActive, 'Hacer click en la sección debe marcarla como .active');

    // 2b. Volver a la sección Conexión y comprobar el perfil activo
    await page.click('#btn-settings-back');
    await sectionButtons[0].click();
    await page.waitForFunction(() => document.getElementById('settings-dialog')?.open);
    const connectionTab = await page.evaluate(() => ({
      hasActiveProfile: !!document.getElementById('settings-active-profile-name'),
      hasConnectionInputs: !!document.querySelector('#settings-dialog #setting-api-url'),
      hasManageButton: !!document.getElementById('btn-manage-profiles')
    }));
    assert.ok(connectionTab.hasActiveProfile, 'La pestaña Conexión debe mostrar el perfil activo');
    assert.equal(connectionTab.hasConnectionInputs, false, 'La pestaña Conexión no debe editar datos de perfil');
    assert.ok(connectionTab.hasManageButton, 'La pestaña Conexión debe enlazar al mantenedor de perfiles');

    await page.click('#btn-manage-profiles');
    await page.waitForFunction(() => document.getElementById('profiles-dialog')?.open);
    await page.click('#btn-new-profile');
    await page.fill('#notice-input', 'Perfil Temporal Browser');
    await page.click('#notice-accept');
    await page.click('#profile-tab-settings');
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
    await page.click('#btn-manage-profiles');
    await page.waitForFunction(() => document.getElementById('profiles-dialog')?.open);
    const createdProfileId = await page.evaluate(() => window.ChatProfileRepository.findByName('Perfil Temporal Browser').id);
    await page.selectOption('#profile-select-helper', createdProfileId);
    await page.fill('#setting-profile-name', 'Perfil Temporal renombrado');
    await page.click('#profile-tab-settings');
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
    const sectionOrder = await page.$$eval('#sidebar-settings-nav .sidebar-settings-item', els => els.map(e => e.getAttribute('data-section')));
    const agentIndex = sectionOrder.indexOf('tab-agent');
    const mcpIndex = sectionOrder.indexOf('tab-mcp');
    const permissionsIndex = sectionOrder.indexOf('tab-permissions');
    assert.ok(agentIndex >= 0 && mcpIndex === agentIndex + 1, 'La sección MCP debe estar posicionada inmediatamente al lado de la de Agente');
    assert.ok(permissionsIndex === mcpIndex + 1, 'La sección Permisos debe estar inmediatamente después de MCP');

    // Volver al sidebar de configuración antes de seleccionar otra sección
    await page.click('#btn-settings-back');
    await page.waitForFunction(() => !document.getElementById('settings-dialog')?.open);

    const mcpSectionBtn = await page.$('#sidebar-settings-nav button[data-section="tab-mcp"]');
    assert.ok(mcpSectionBtn, 'Debe existir la sección MCP en la navegación de configuración');
    await mcpSectionBtn.click();
    await page.waitForFunction(() => document.getElementById('settings-dialog')?.open);
    const isMcpActive = await mcpSectionBtn.evaluate(el => el.classList.contains('active'));
    assert.ok(isMcpActive, 'La sección MCP debe quedar activa al hacer click');

    const mcpUiState = await page.evaluate(() => {
      const pane = document.getElementById('tab-mcp');
      const badge = document.getElementById('mcp-status-badge');
      const btnConfigure = document.getElementById('btn-mcp-configure');
      const btnConnect = document.getElementById('btn-mcp-connect');
      return {
        paneActive: pane?.classList.contains('active'),
        badgeText: badge?.textContent?.trim(),
        hasConfigureBtn: !!btnConfigure,
        hasConnectBtn: !!btnConnect,
        hasToolsContainer: !!document.getElementById('mcp-tools-container'),
        toolsContainerVisible: document.getElementById('mcp-tools-container')?.style?.display !== 'none'
      };
    });

    assert.ok(mcpUiState.paneActive, 'El panel tab-mcp debe estar visible y activo');
    assert.ok(mcpUiState.badgeText.includes('Desconectado') || mcpUiState.badgeText.includes('Conectado'), 'El estado debe ser Desconectado o Conectado según disponibilidad');
    assert.ok(mcpUiState.hasConfigureBtn, 'El botón Configurar debe estar presente en el panel MCP');
    assert.ok(mcpUiState.hasConnectBtn, 'El botón Conectar debe estar presente en el panel MCP');
    assert.ok(mcpUiState.hasToolsContainer, 'El contenedor de herramientas MCP debe estar presente');
    assert.ok(mcpUiState.toolsContainerVisible, 'El contenedor de herramientas MCP debe estar visible');

    await page.click('#btn-settings-back');
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
    await page.click('#btn-settings-back');
    await page.waitForFunction(() => !document.getElementById('settings-dialog')?.open);
    await mcpSectionBtn.click();
    await page.waitForFunction(() => document.getElementById('settings-dialog')?.open);

    // Abrir modal de configuración e instrucciones desde el botón Configurar
    await page.click('#btn-mcp-configure');
    await page.waitForSelector('#mcp-setup-dialog[open]');
    const isSetupOpen = await page.$eval('#mcp-setup-dialog', el => el.open);
    assert.ok(isSetupOpen, 'El modal de configuración de MCP debe abrirse');

    const modalState = await page.evaluate(() => {
      const portInput = document.getElementById('mcp-port-input');
      const command = document.getElementById('mcp-terminal-command');
      const endpoint = document.getElementById('mcp-endpoint-preview');
      return {
        port: portInput?.value,
        commandText: command?.textContent?.trim(),
        endpointText: endpoint?.textContent?.trim()
      };
    });

    assert.equal(modalState.port, '6388', 'El puerto por defecto debe ser 6388 (rango 63xx)');
    assert.ok(modalState.commandText.includes('curl -sSL'), 'El comando debe usar curl');
    assert.ok(modalState.commandText.includes('zerochat.py'), 'El comando debe apuntar a zerochat.py');
    assert.equal(modalState.endpointText, 'http://127.0.0.1:6388/sse');

    // Cambiar interactivamente el puerto en el input del modal y verificar reactividad inmediata
    await page.fill('#mcp-port-input', '6395');
    const updatedCommand = await page.$eval('#mcp-terminal-command', el => el.textContent.trim());
    const updatedEndpoint = await page.$eval('#mcp-endpoint-preview', el => el.textContent.trim());
    assert.ok(updatedCommand.includes('--port 6395'), 'El comando debe actualizarse reactivamente a 6395');
    assert.equal(updatedEndpoint, 'http://127.0.0.1:6395/sse', 'El endpoint debe actualizarse reactivamente a 6395');

    // Cerrar el modal de configuración de MCP
    await page.click('#btn-close-mcp-setup-footer');
    await page.waitForFunction(() => !document.getElementById('mcp-setup-dialog')?.open);
    const isSetupClosed = await page.$eval('#mcp-setup-dialog', el => !el.open);
    assert.ok(isSetupClosed, 'El modal de configuración de MCP debe cerrarse correctamente');

    // 3. Cerrar ambos modales sin guardar la configuración general.
    await page.waitForFunction(() => !document.getElementById('profiles-dialog')?.open);
    await page.click('#btn-close-settings');
    await page.waitForFunction(() => !document.getElementById('settings-dialog')?.open);
    const isClosed = await page.$eval('#settings-dialog', el => !el.open);
    assert.ok(isClosed, 'El diálogo debe cerrarse correctamente');

    // 4. Validar renderizado de Tarjetas de Herramientas (Tool Cards) en el chat
    await page.evaluate(() => {
      const messagesList = document.getElementById('messages-list');
      const wrapper = document.createElement('div');
      wrapper.className = 'message-wrapper assistant';
      wrapper.innerHTML = `
        <div class="message-row assistant">
          <div class="message-content-wrapper">
            <div class="tool-card-wrapper">
              <div class="tool-execution-card">
                <div class="tool-card-header">
                  <div class="tool-card-title">
                    <span>⚡</span>
                    <span>execute_javascript</span>
                  </div>
                  <div class="tool-card-header-actions">
                    <span class="tool-card-badge status-success">✅ Completado (42ms)</span>
                    <button type="button" class="btn-tool-collapse">▾</button>
                  </div>
                </div>
                <div class="tool-card-collapsible-body">
                  <div class="tool-card-result">
                    <pre class="tool-card-code"><code>console.log("Prueba Fase 6");</code></pre>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      `;
      messagesList.appendChild(wrapper);
    });

    // Validar estilos de la tarjeta de herramienta
    const cardInfo = await page.evaluate(() => {
      const card = document.querySelector('.tool-execution-card');
      const badge = document.querySelector('.tool-card-badge');
      const header = document.querySelector('.tool-card-header');
      const cardStyle = getComputedStyle(card);
      const badgeStyle = getComputedStyle(badge);
      const headerStyle = getComputedStyle(header);
      return {
        cardRadius: parseFloat(cardStyle.borderRadius),
        badgeRadius: parseFloat(badgeStyle.borderRadius),
        headerBg: headerStyle.backgroundColor
      };
    });

    assert.ok(cardInfo.cardRadius >= 8, 'La tarjeta de herramienta debe tener bordes redondeados (>= 8px)');
    assert.ok(cardInfo.badgeRadius >= 12, 'El badge de estado de la tarjeta debe tener estilo píldora');
    assert.ok(cardInfo.headerBg, 'La cabecera de la herramienta debe tener un fondo de superficie asignado');
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
