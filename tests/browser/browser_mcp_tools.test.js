const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestBrowser, closeGlobalBrowser, getIndexUrl, waitForAppReady, openSavedSession } = require('../helpers/browser-env.js');

describe('Browser UI - mcp_tools', { concurrency: 2 }, () => {
  after(async () => {
    await closeGlobalBrowser();
  });

test('Browser UI - los metadatos MCP externos se renderizan como texto', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);
    const result = await page.evaluate(() => {
      const byId = id => document.getElementById(id);
      const serverDetails = byId('mcp-server-details');
      const elements = {
        statusBadge: byId('mcp-status-badge'), statusText: byId('mcp-status-text'), serverDetails,
        reconnectHint: byId('mcp-reconnect-hint'), commandSnippet: byId('mcp-terminal-command'), bootstrapCard: byId('mcp-bootstrap-card'),
        toolsContainer: byId('mcp-tools-container'), serversList: byId('mcp-servers-list')
      };
      const payload = '<img data-xss-probe="mcp" src=x onerror="window.__mcpXss=true">';
      window.ChatUIMcp.renderConnectionStatus(elements, {
        ...window.ChatState.get('mcp'),
        status: 'connected',
        serverInfo: { name: payload, version: payload }
      });
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

test('Browser UI - autorización de Composio muestra y devuelve únicamente su servicio', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);
    const result = await page.evaluate(async () => {
      const provider = new window.ChatMCP.McpToolProvider({
        id: 'mcp_external', name: 'ZeroChat External MCP Host',
        initialize: async () => ({ success: true }),
        listTools: async () => [{
          name: 'composio_COMPOSIO_SEARCH_TOOLS',
          metadata: { mcpServerId: 'composio', originalName: 'COMPOSIO_SEARCH_TOOLS' }
        }]
      });
      const [tool] = await provider.discoverTools();
      const manager = new window.ChatToolSecurity.ToolSecurityManager();
      const auth = manager.evaluateAuthorization(tool, {});
      const call = { function: { name: tool.name, arguments: '{}' } };
      const card = window.ChatToolCards.createLiveToolCard(tool.name, {});
      document.body.appendChild(card);
      const pending = window.ChatToolCards.promptToolAuthorization(card, call, { ...auth, args: {} });
      const button = card.querySelector('.btn-auth-allow-server');
      const label = button.textContent;
      const title = button.title;
      button.click();
      const decision = await pending;
      card.remove();
      return { label, title, decision };
    });
    assert.ok(result.label.includes('composio'));
    assert.ok(result.title.includes('composio'));
    assert.ok(!result.label.includes('External MCP Host'));
    assert.deepEqual(result.decision, { decision: 'allow_server_always', serverId: 'composio' });
  } finally { await browser.close(); }
});

test('Browser UI - la autorización de carpeta solo se ofrece para rutas que pueden ser una regla', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);
    const result = await page.evaluate(async () => {
      const manager = new window.ChatToolSecurity.ToolSecurityManager();
      manager.setStartupDirectory('/home/user/proj');
      const tool = { id: 'read_file', name: 'read_file', category: 'mcp' };
      const render = (path) => {
        const args = { path };
        const auth = manager.evaluateAuthorization(tool, args);
        const call = { function: { name: 'read_file', arguments: JSON.stringify(args) } };
        const card = window.ChatToolCards.createLiveToolCard('read_file', args);
        document.body.appendChild(card);
        const pending = window.ChatToolCards.promptToolAuthorization(card, call, { ...auth, args });
        return { card, pending };
      };

      const unresolved = {};
      for (const path of ['~/.ssh/id_rsa', '$HOME/.ssh/id_rsa', '../../etc/passwd']) {
        const { card, pending } = render(path);
        unresolved[path] = Boolean(card.querySelector('.btn-auth-allow-path'));
        card.querySelector('.btn-auth-deny').click();
        await pending;
        card.remove();
      }

      const { card, pending } = render('/home/user/other/a.txt');
      const button = card.querySelector('.btn-auth-allow-path');
      button.click();
      const decision = await pending;
      card.remove();
      return { unresolved, decision };
    });
    assert.deepEqual(result.unresolved, {
      '~/.ssh/id_rsa': false,
      '$HOME/.ssh/id_rsa': false,
      '../../etc/passwd': false
    });
    assert.equal(result.decision.decision, 'allow_always');
    assert.equal(result.decision.directoryRule, 'R:/home/user/other/**');
  } finally { await browser.close(); }
});

test('Browser UI - la petición de permisos agrupa las autorizaciones ampliadas y se adapta a móvil', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);
    await page.evaluate(() => {
      const messagesList = document.getElementById('messages-list');
      messagesList.replaceChildren(Object.assign(document.createElement('div'), { style: 'height: 1200px; flex: 0 0 1200px;' }));
      const card = document.createElement('div');
      card.innerHTML = '<div class="tool-execution-card"><span class="tool-card-badge"></span><div class="tool-card-collapsible-body"><div style="height: 110px;"></div></div></div>';
      messagesList.appendChild(card);
      window.__permissionCard = card;
      window.__permissionDecision = window.ChatToolCards.promptToolAuthorization(card, { function: { name: 'run_command' } }, {
        serverId: 'zerochat-local',
        serverName: 'ZeroChat Local Server',
        args: { command: 'git status' }
      });
    });
    await page.waitForFunction(() => document.getElementById('messages-list').scrollTop > 0);
    await page.waitForFunction(() => {
      const card = window.__permissionCard.querySelector('.tool-execution-card');
      const list = document.getElementById('messages-list');
      return card.getBoundingClientRect().bottom <= list.getBoundingClientRect().bottom + 1;
    });

    const initial = await page.evaluate(() => {
      const prompt = window.__permissionCard.querySelector('.tool-card-auth-prompt');
      const actions = prompt.querySelector('.tool-auth-actions');
      const menu = prompt.querySelector('.tool-auth-more-menu');
      const listRect = document.getElementById('messages-list').getBoundingClientRect();
      return {
        directActions: Array.from(actions.children).map(el => el.className),
        menuHidden: menu.hidden,
        layout: getComputedStyle(actions).display,
        serverTagCount: prompt.querySelectorAll('.tool-card-tag').length,
        cardOverflow: getComputedStyle(window.__permissionCard.querySelector('.tool-execution-card')).overflow,
        panelVisible: window.__permissionCard.querySelector('.tool-execution-card').getBoundingClientRect().bottom <= listRect.bottom + 1
      };
    });
    assert.deepEqual(initial.directActions, ['btn-auth-action btn-auth-allow-once', 'tool-auth-more', 'btn-auth-action btn-auth-deny']);
    assert.equal(initial.menuHidden, true);
    assert.equal(initial.layout, 'grid');
    assert.equal(initial.serverTagCount, 0);
    assert.equal(initial.cardOverflow, 'visible');
    assert.equal(initial.panelVisible, true);

    await page.click('.btn-auth-more');
    await page.waitForFunction(() => {
      const card = window.__permissionCard.querySelector('.tool-execution-card');
      const list = document.getElementById('messages-list');
      return card.getBoundingClientRect().bottom <= list.getBoundingClientRect().bottom + 1;
    });
    const expanded = await page.evaluate(() => {
      const prompt = window.__permissionCard.querySelector('.tool-card-auth-prompt');
      const menu = prompt.querySelector('.tool-auth-more-menu');
      return {
        expanded: prompt.querySelector('.btn-auth-more').getAttribute('aria-expanded'),
        menuHidden: menu.hidden,
        menuPosition: getComputedStyle(menu).position,
        hasSession: !!menu.querySelector('.btn-auth-allow-session'),
        hasPermanent: !!menu.querySelector('.btn-auth-allow-always'),
        hasCommandScope: !!menu.querySelector('.btn-auth-allow-cmd'),
        hasServerTrust: !!menu.querySelector('.btn-auth-allow-server'),
        panelVisible: window.__permissionCard.querySelector('.tool-execution-card').getBoundingClientRect().bottom <= document.getElementById('messages-list').getBoundingClientRect().bottom + 1
      };
    });
    assert.equal(expanded.expanded, 'true');
    assert.equal(expanded.menuHidden, false);
    assert.equal(expanded.menuPosition, 'static');
    assert.equal(expanded.hasSession, true);
    assert.equal(expanded.hasPermanent, true);
    assert.equal(expanded.hasCommandScope, true);
    assert.equal(expanded.hasServerTrust, true);
    assert.equal(expanded.panelVisible, true);

    await page.click('.tool-auth-more-menu .btn-auth-allow-session');
    const decision = await page.evaluate(async () => {
      const result = await window.__permissionDecision;
      window.__permissionCard.remove();
      return result;
    });
    assert.equal(decision, 'allow_session');
  } finally { await browser.close(); }
});

test('Browser UI - el menú de permisos de escritorio no queda bajo el composer', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);
    await page.evaluate(() => {
      const messagesList = document.getElementById('messages-list');
      messagesList.replaceChildren(Object.assign(document.createElement('div'), { style: 'height: 1200px; flex: 0 0 1200px;' }));
      const card = document.createElement('div');
      card.innerHTML = '<div class="tool-execution-card"><span class="tool-card-badge"></span><div class="tool-card-collapsible-body"><div style="height: 80px;"></div></div></div>';
      messagesList.appendChild(card);
      window.__desktopPermissionCard = card;
      window.__desktopPermissionDecision = window.ChatToolCards.promptToolAuthorization(card, { function: { name: 'run_command' } }, {
        args: { command: 'git status' }
      });
    });
    await page.click('.btn-auth-more');
    await page.waitForFunction(() => {
      const menu = window.__desktopPermissionCard.querySelector('.tool-auth-more-menu');
      const list = document.getElementById('messages-list');
      return menu.getBoundingClientRect().bottom <= list.getBoundingClientRect().bottom + 1;
    });
    const layout = await page.evaluate(() => {
      const card = window.__desktopPermissionCard.querySelector('.tool-execution-card');
      const menu = window.__desktopPermissionCard.querySelector('.tool-auth-more-menu');
      return {
        cardOverflow: getComputedStyle(card).overflow,
        menuPosition: getComputedStyle(menu).position
      };
    });
    assert.equal(layout.cardOverflow, 'visible');
    assert.equal(layout.menuPosition, 'absolute');
    await page.click('.btn-auth-deny');
    await page.evaluate(async () => {
      await window.__desktopPermissionDecision;
      window.__desktopPermissionCard.remove();
    });
  } finally { await browser.close(); }
});

test('Browser UI - RAG avisa al combinar ramas con idiomas distintos sin alterar su activación', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);
    const branchIds = await page.evaluate(async () => {
      for (const branch of await window.ChatRagStorage.getBranches()) await window.ChatRagStorage.deleteBranch(branch.id);
      window.ChatConfig.updateRuntime({ activeRagBranchIds: [] });
      const spanishOne = await window.ChatRagStorage.createBranch({ name: 'ES uno', language: 'spanish' });
      const spanishTwo = await window.ChatRagStorage.createBranch({ name: 'ES dos', language: 'spanish' });
      const english = await window.ChatRagStorage.createBranch({ name: 'EN', language: 'english' });
      return { spanishOne: spanishOne.id, spanishTwo: spanishTwo.id, english: english.id };
    });

    await page.click('#btn-open-rag');
    await page.waitForFunction(() => document.querySelectorAll('#rag-modal [data-branch-id]').length === 3);

    const waitForActiveBranch = id => page.waitForFunction(branchId => document.querySelector(`#rag-modal [data-branch-id="${branchId}"]`)?.classList.contains('active'), id);
    await page.locator(`#rag-modal [data-branch-id="${branchIds.spanishOne}"]`).click();
    await waitForActiveBranch(branchIds.spanishOne);
    assert.equal(await page.$eval('#notice-dialog', dialog => dialog.open), false);

    await page.locator(`#rag-modal [data-branch-id="${branchIds.spanishTwo}"]`).click();
    await waitForActiveBranch(branchIds.spanishTwo);
    assert.equal(await page.$eval('#notice-dialog', dialog => dialog.open), false);

    await page.locator(`#rag-modal [data-branch-id="${branchIds.english}"]`).click();
    await page.waitForFunction(() => document.getElementById('notice-dialog')?.open);
    const warningText = await page.$eval('#notice-message', el => el.textContent);
    assert.match(warningText, /idiomas distintos/i);
    assert.match(warningText, /Español/i);
    assert.match(warningText, /Inglés/i);
    assert.equal(await page.evaluate(() => window.ChatConfig.getActive().activeRagBranchIds.length), 3);
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
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);

    await page.click('#btn-open-settings');
    await page.click('[data-section="agent"]');
    await page.waitForFunction(() => document.getElementById('settings-dialog')?.open);
    await page.locator('#settings-agent .agent-tool-checkbox:not([data-tool-id="browser_action"])').first().locator('..').click();
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
    await page.click('[data-section="permissions"]');
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

test('Browser UI - Botón y cabecera para abrir/cerrar tool funcionan al recuperar del historial', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const filePath = getIndexUrl();
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
    });
    await openSavedSession(page, 'sess_tool_hist_toggle');

    // 2. Las tools históricas se restauran dentro del historial plegado del grupo.
    await page.waitForSelector('.tool-call-group-history');
    await page.click('.tool-call-group-summary');
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

test('Browser UI - Las reglas de permisos y herramientas sobreviven a recargas (F5)', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const filePath = getIndexUrl();
    await page.goto(filePath, { waitUntil: 'load' });
    await waitForAppReady(page);

    // 1. Abrir Ajustes -> Permisos y configurar una regla de directorio
    await page.click('#btn-open-settings');
    await page.click('[data-section="permissions"]');
    await page.waitForFunction(() => document.getElementById('settings-dialog')?.open);
    await page.locator('#mcp-directory-rules').fill('RW:./my-project/**');
    await page.click('#btn-save-settings');
    await page.waitForFunction(() => !document.getElementById('settings-dialog')?.open);

    // Verificar que se guardó en ToolSecurity
    assert.deepEqual(
      await page.evaluate(() => window.ChatToolSecurity.manager.getDirectoryRules()),
      ['RW:my-project/**']
    );

    // 2. Abrir Ajustes -> Modelo y guardar sin tocar Permisos (no debe borrar las reglas)
    await page.click('[data-section="model"]');
    await page.waitForFunction(() => document.getElementById('settings-dialog')?.open);
    await page.click('#btn-save-settings');
    await page.waitForFunction(() => !document.getElementById('settings-dialog')?.open);

    assert.deepEqual(
      await page.evaluate(() => window.ChatToolSecurity.manager.getDirectoryRules()),
      ['RW:my-project/**'],
      'Guardar desde otra pestaña no debe borrar las reglas de directorios'
    );

    // 3. Abrir Ajustes -> Agente y desactivar execute_javascript
    await page.click('[data-section="agent"]');
    await page.waitForFunction(() => document.getElementById('settings-dialog')?.open);
    await page.locator('.switch:has([data-tool-id="execute_javascript"])').click();
    await page.click('#btn-save-settings');
    await page.waitForFunction(() => !document.getElementById('settings-dialog')?.open);

    // 4. Establecer un permiso 'allow' en una herramienta integrada de archivos
    await page.evaluate(() => {
      window.ChatToolSecurity.manager.setToolPolicy('read_file', 'allow', {
        serverName: 'mcp-proxy',
        originalName: 'read_file'
      });
    });

    // 5. Recarga de página (F5)
    await page.reload({ waitUntil: 'load' });
    await waitForAppReady(page);

    // 6. Verificar que las reglas de directorios y la política granular sobrevivieron
    const securityState = await page.evaluate(() => ({
      directoryRules: window.ChatToolSecurity.manager.getDirectoryRules(),
      readFilePolicy: window.ChatToolSecurity.manager.getToolPolicy('read_file'),
      readFileEval: window.ChatToolSecurity.manager.evaluateAuthorization({ id: 'read_file', name: 'read_file', category: 'mcp' }, { path: 'some/file.txt' })
    }));
    assert.deepEqual(securityState.directoryRules, ['RW:my-project/**'], 'Las reglas de directorios deben sobrevivir al F5');
    assert.equal(securityState.readFilePolicy, 'allow', 'La política granular debe sobrevivir al F5');
    assert.equal(securityState.readFileEval.status, 'allow', 'La evaluación tras F5 debe autorizar sin pedir confirmación');
    assert.equal(securityState.readFileEval.requiresApproval, false);

    // 7. Verificar que el estado del checkbox del agente sobrevivió
    const enabledToolsAfterF5 = await page.evaluate(() => window.ChatConfig.getActive().enabledTools);
    assert.equal(enabledToolsAfterF5['execute_javascript'], false, 'El estado de la herramienta del agente debe sobrevivir al F5');

    // 8. Reabrir Ajustes -> Permisos y verificar que el textarea contiene la regla
    await page.click('#btn-open-settings');
    await page.click('[data-section="permissions"]');
    await page.waitForFunction(() => document.getElementById('settings-dialog')?.open);
    const textareaVal = await page.$eval('#mcp-directory-rules', el => el.value);
    assert.match(textareaVal, /RW:my-project\/\*\*/, 'El textarea de directorios debe mostrar la regla guardada tras F5');
    await page.click('#btn-close-settings');
  } finally {
    await browser.close();
  }
});

test('Browser UI - el progreso MCP sobrevive al renderizado y el timeout conserva starting', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);
    const results = await page.evaluate(async () => {
      // La aplicación ya montó el panel MCP sobre su lista de servicios y sigue ChatState.
      const container = document.getElementById('mcp-servers-list');
      const manager = ChatMCP.manager;
      const originalStart = manager.startExternalServer;
      const originalSync = manager.syncExternalServers;
      manager.syncExternalServers = async () => {};
      const results = [];
      try {
        for (const language of ['es', 'en']) {
          ChatI18n.setLanguage(language);
          ChatState.set('mcp', {
            ...ChatState.get('mcp'), status: 'connected',
            externalServers: [{ id: 'ejemplo', status: 'stopped' }]
          });
          let reportWait, rejectStart;
          manager.startExternalServer = async (id, callback) => {
            reportWait = callback;
            await new Promise((resolve, reject) => { rejectStart = reject; });
          };
          const originalButton = container.querySelector('.btn-mcp-server-toggle');
          originalButton.click();
          const button = () => container.querySelector('.btn-mcp-server-toggle');
          const initial = {
            text: button().textContent.trim(), disabled: button().disabled,
            busy: button().getAttribute('aria-busy'), replaced: button() !== originalButton
          };
          const attempts = [];
          for (const attempt of [1, 2, 10]) {
            reportWait(attempt, 10);
            attempts.push(button().textContent.trim());
          }
          const error = new Error('Wait expired');
          error.code = 'EXTERNAL_START_WAIT_TIMEOUT';
          error.externalServer = { id: 'ejemplo', status: 'starting' };
          rejectStart(error);
          // Flush de macrotarea: deja ejecutar el callback asíncrono del mock.
          await new Promise(resolve => setTimeout(resolve, 0));
          const timedOut = {
            status: ChatState.get('mcp').externalServers[0].status,
            disabled: button().disabled, error: container.querySelector('.mcp-server-error')?.textContent
          };
          ChatState.set('mcp', { externalServers: [{ id: 'ejemplo', status: 'running' }] });
          results.push({ language, initial, attempts, timedOut, action: button().getAttribute('data-action') });
        }
      } finally {
        manager.startExternalServer = originalStart;
        manager.syncExternalServers = originalSync;

      }
      return results;
    });
    for (const result of results) {
      assert.equal(result.initial.text, result.language === 'es' ? 'Iniciando' : 'Starting');
      assert.equal(result.initial.disabled, true);
      assert.equal(result.initial.busy, 'true');
      assert.equal(result.initial.replaced, true);
      assert.deepEqual(result.attempts, [1, 2, 10].map(attempt => result.language === 'es'
        ? `Iniciando (intento ${attempt} de 10)…` : `Starting (attempt ${attempt} of 10)…`));
      assert.equal(result.timedOut.status, 'starting');
      assert.equal(result.timedOut.disabled, true);
      assert.match(result.timedOut.error, /OAuth/);
      assert.equal(result.action, 'stop');
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('Browser UI - tras el primer timeout MCP pasa de instalación a OAuth y activo sin reabrir el panel', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);
    const results = await page.evaluate(async () => {
      // La aplicación ya montó el panel MCP sobre su lista de servicios y sigue ChatState.
      const container = document.getElementById('mcp-servers-list');
      const manager = ChatMCP.manager;
      const originalRequest = manager.requestExternalControl;
      const originalSync = manager.syncExternalServers;
      const originalTimeout = window.setTimeout;
      manager.syncExternalServers = async () => {};
      const results = [];
      try {
        for (const language of ['es', 'en']) {
          ChatI18n.setLanguage(language);
          ChatState.set('mcp', {
            ...ChatState.get('mcp'), status: 'connected',
            externalServers: [{ id: 'oauth-fixture', status: 'stopped' }]
          });
          let starts = 0, checks = 0;
          const phases = [];
          const running = { id: 'oauth-fixture', status: 'running', toolCount: 1 };
          manager.requestExternalControl = async method => {
            if (method.endsWith('/start')) {
              starts += 1;
              const error = new Error('Initial request timed out');
              error.name = 'AbortError';
              throw error;
            }
            checks += 1;
            return { servers: [checks < 3 ? { id: 'oauth-fixture', status: checks === 1 ? 'installing' : 'starting' } : running] };
          };
          manager.syncExternalServers = async () => {
            ChatState.set('mcp', state => ({ ...state, externalServers: [running] }));
          };
          window.setTimeout = (callback, delay, ...args) => {
            if (delay === 15000) {
              const button = container.querySelector('.btn-mcp-server-toggle');
              phases.push({ status: ChatState.get('mcp').externalServers[0].status,
                disabled: button.disabled, error: !!container.querySelector('.mcp-server-error') });
              return originalTimeout(callback, 0, ...args);
            }
            return originalTimeout(callback, delay, ...args);
          };
          container.querySelector('.btn-mcp-server-toggle').click();
          for (let wait = 0; checks < 3 && wait < 200; wait += 1) {
            await new Promise(resolve => originalTimeout(resolve, 5));
          }
          if (checks < 3) throw new Error('MCP status polling did not reach running');
          await new Promise(resolve => originalTimeout(resolve, 0));
          results.push({ starts, phases, status: ChatState.get('mcp').externalServers[0].status,
            action: container.querySelector('.btn-mcp-server-toggle').getAttribute('data-action'),
            error: !!container.querySelector('.mcp-server-error') });
        }
      } finally {
        window.setTimeout = originalTimeout;
        manager.requestExternalControl = originalRequest;
        manager.syncExternalServers = originalSync;

      }
      return results;
    });
    for (const result of results) {
      assert.equal(result.starts, 1);
      assert.deepEqual(result.phases, [
        { status: 'installing', disabled: true, error: false },
        { status: 'starting', disabled: true, error: false }
      ]);
      assert.equal(result.status, 'running');
      assert.equal(result.action, 'stop');
      assert.equal(result.error, false);
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('Browser UI - la tarjeta de run_command sigue al comando, muestra su log al desplegarse y lo detiene', { timeout: 30000 }, async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);

    await page.evaluate(async () => {
      // run_command del servidor local, registrado como lo registra McpToolProvider al conectar.
      const provider = new window.ChatMCP.McpToolProvider({ id: 'mcp_proxy', name: 'ZeroChat', initialize: async () => ({ success: true }), listTools: async () => [{ name: 'run_command' }] }, { id: 'mcp_prov_command_card_test' });
      await provider.discoverTools();
      window.ChatAgentCore.registry.registerProvider(provider);
      // Servidor simulado: un comando en segundo plano que escribe líneas hasta que se detiene.
      const job = { id: 7, key: 'inv-tarjeta-1', status: 'running', exit_code: null, started_at: Date.now() - 5000, elapsed_s: 5, output_bytes: 0, log: '' };
      window.__jobCalls = [];
      window.__job = job;
      const line = n => `linea ${n}\n`;
      for (let i = 1; i <= 6; i++) job.log += line(i);
      window.ChatMCP.manager.requestExternalControl = async (method, params) => {
        window.__jobCalls.push({ method, params });
        const matches = params.id === job.id || params.key === job.key;
        if (!matches) throw new Error('Comando no encontrado');
        if (method === 'zerochat/jobs/stop') { job.status = 'stopped'; job.exit_code = -15; job.stop_reason = 'user'; }
        if (job.status === 'running') job.log += line(job.log.split('\n').length);
        job.output_bytes = job.log.length;
        const details = { id: job.id, key: job.key, status: job.status, exit_code: job.exit_code, started_at: job.started_at, elapsed_s: job.elapsed_s, output_bytes: job.output_bytes, tail: job.log.slice(-200) };
        if (method === 'zerochat/jobs/log') {
          return { text: job.log.slice(params.offset, params.offset + params.limit), next: Math.min(job.log.length, params.offset + params.limit), total: job.log.length, done: job.status !== 'running' };
        }
        return details;
      };
      const container = document.createElement('div');
      container.id = 'command-card-test';
      document.getElementById('chat-messages')?.appendChild(container) || document.body.appendChild(container);
      const args = { command: 'npm run dev', background: true };
      const card = window.ChatToolCards.createLiveToolCard('run_command', args);
      card.dataset.invocationId = job.key;
      window.ChatToolCards.appendToolCard(container, card);
      // Igual que agent-core: actualizar la tarjeta con el resultado y archivarla como terminada.
      const result = { content: JSON.stringify({ success: true, status: 'running', job_id: 7, elapsed_s: 2.5, output: 'linea 1\n' }) };
      window.ChatToolCards.updateLiveToolCard(card, 'run_command', args, result, 2500);
      window.ChatToolCards.completeToolCard(card, result);
      window.__commandCard = card;
    });

    const card = page.locator('#command-card-test .command-card-wrapper');
    await page.waitForFunction(() => window.__commandCard.parentElement?.classList.contains('tool-call-group-active-cards'));
    // Desplegada, la tarjeta muestra el log y lo va completando.
    await page.waitForFunction(() => /linea 1\n[\s\S]*linea 8\n/.test(window.__commandCard.querySelector('.command-card-log').textContent));
    const running = await card.evaluate(el => ({
      badge: el.querySelector('.tool-card-badge').textContent.trim(),
      expanded: !el.querySelector('.tool-execution-card').classList.contains('collapsed'),
      status: el.dataset.toolCallStatus,
      title: el.querySelector('.command-card-command').getAttribute('title'),
      logStart: el.querySelector('.command-card-log').textContent.slice(0, 16),
      buttons: Array.from(el.querySelectorAll('[data-command-action]'), button => button.dataset.commandAction),
      stopVisible: !el.querySelector('[data-command-action="stop"]').hidden,
      groupRunning: el.closest('.tool-call-group').classList.contains('is-running')
    }));
    assert.match(running.badge, /En segundo plano · 0?:?0?\d/);
    assert.deepEqual([running.expanded, running.status, running.title, running.logStart, running.buttons, running.stopVisible, running.groupRunning],
      [true, 'running', 'npm run dev', 'linea 1\nlinea 2\n', ['stop'], true, true]);
    const calls = await page.evaluate(() => window.__jobCalls);
    assert.ok(calls.some(call => call.method === 'zerochat/jobs/get' && call.params.id === 7));
    assert.ok(calls.some(call => call.method === 'zerochat/jobs/log' && call.params.id === 7));

    // Plegada no hace peticiones, aunque el reloj siga avanzando; al desplegarla de nuevo, el log
    // vuelve a estar al día.
    const collapsed = await page.evaluate(async () => {
      window.__commandCard.querySelector('.tool-execution-card').classList.add('collapsed');
      const before = window.__jobCalls.length;
      const badgeBefore = window.__commandCard.querySelector('.tool-card-badge').textContent;
      await new Promise(resolve => {
        const check = setInterval(() => {
          if (window.__commandCard.querySelector('.tool-card-badge').textContent !== badgeBefore) {
            clearInterval(check);
            resolve();
          }
        }, 50);
        setTimeout(() => { clearInterval(check); resolve(); }, 1200);
      });
      return { calls: window.__jobCalls.slice(before).map(call => call.method), clockMoved: window.__commandCard.querySelector('.tool-card-badge').textContent !== badgeBefore };
    });
    assert.deepEqual(collapsed, { calls: [], clockMoved: true });
    await page.evaluate(() => window.__commandCard.querySelector('.tool-execution-card').classList.remove('collapsed'));
    await page.waitForFunction(() => {
      const log = window.__commandCard.querySelector('.command-card-log').textContent;
      return log.endsWith(window.__job.log.split('\n').slice(-2).join('\n'));
    });

    await card.locator('[data-command-action="stop"]').click();
    await page.waitForFunction(() => /Detenido/.test(window.__commandCard.querySelector('.tool-card-badge').textContent));
    const stopped = await card.evaluate(el => ({
      stopHidden: el.querySelector('[data-command-action="stop"]').hidden,
      archived: el.parentElement.classList.contains('tool-call-group-cards'),
      status: el.dataset.toolCallStatus
    }));
    assert.deepEqual(stopped, { stopHidden: true, archived: true, status: 'success' });
    assert.ok((await page.evaluate(() => window.__jobCalls)).some(call => call.method === 'zerochat/jobs/stop' && call.params.id === 7));
    const callsAfterStop = await page.evaluate(() => window.__jobCalls.length);
    // Aserción negativa: la espera fija es a propósito para confirmar que el contador no cambia.
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => window.__jobCalls.length), callsAfterStop, 'Un comando terminado deja de consultarse');

    // Un comando esperado: se sigue por la clave de la invocación hasta que llega el resultado.
    const foreground = await page.evaluate(async () => {
      const job = window.__job;
      Object.assign(job, { id: 8, key: 'inv-tarjeta-2', status: 'running', exit_code: null, log: 'compilando\n' });
      const args = { command: 'npm run build' };
      const card = window.ChatToolCards.createLiveToolCard('run_command', args);
      card.dataset.invocationId = job.key;
      window.ChatToolCards.appendToolCard(document.getElementById('command-card-test'), card);
      await new Promise(resolve => {
        const check = setInterval(() => {
          if (window.__jobCalls.some(call => call.params.key === 'inv-tarjeta-2')) {
            clearInterval(check);
            resolve();
          }
        }, 50);
        setTimeout(() => { clearInterval(check); resolve(); }, 1200);
      });
      const during = {
        badge: card.querySelector('.tool-card-badge').textContent.trim(),
        stop: !card.querySelector('[data-command-action="stop"]').hidden,
        byKey: window.__jobCalls.some(call => call.params.key === 'inv-tarjeta-2'),
        log: card.querySelector('.command-card-log').textContent.startsWith('compilando\n')
      };
      const result = { content: JSON.stringify({ success: false, status: 'exited', job_id: 8, exit_code: 2, duration_s: 3.1, output: 'error TS2304\n' }) };
      window.ChatToolCards.updateLiveToolCard(card, 'run_command', args, result, 3100);
      return {
        during,
        after: {
          badge: card.querySelector('.tool-card-badge').textContent.trim(),
          stop: !card.querySelector('[data-command-action="stop"]').hidden,
          collapsed: card.querySelector('.tool-execution-card').classList.contains('collapsed')
        }
      };
    });
    assert.match(foreground.during.badge, /^Ejecutándose · /);
    assert.equal(foreground.during.stop, true);
    assert.equal(foreground.during.byKey, true);
    assert.equal(foreground.during.log, true, 'Mientras se espera, la tarjeta desplegada muestra el log');
    assert.deepEqual(foreground.after, { badge: 'Código 2 · 3.1 s', stop: false, collapsed: true });

    // El final de un comando en segundo plano llega con el latido: al dejar de figurar entre los
    // que siguen en marcha, su tarjeta pregunta una vez cómo acabó.
    const viaHeartbeat = await page.evaluate(async () => {
      const job = window.__job;
      Object.assign(job, { id: 11, key: 'inv-tarjeta-3', status: 'running', exit_code: null, log: 'vigilando\n' });
      window.ChatState.set('mcp', { status: 'connected', serverInfo: { name: 'ZeroChat', cwd: '/tmp' }, tools: [] });
      window.ChatMCP.manager.syncCommandJobs([{ id: 11, command: 'npm run watch', status: 'running', started_at: Date.now(), background: true }]);
      const args = { command: 'npm run watch', background: true };
      const card = window.ChatToolCards.createLiveToolCard('run_command', args);
      card.dataset.invocationId = job.key;
      window.ChatToolCards.appendToolCard(document.getElementById('command-card-test'), card);
      window.ChatToolCards.updateLiveToolCard(card, 'run_command', args, { content: JSON.stringify({ success: true, status: 'running', job_id: 11, elapsed_s: 2.5, output: 'vigilando\n' }) }, 2500);
      await new Promise(resolve => {
        const deadline = Date.now() + 2000;
        const check = () => (/^Ejecutándose · /.test(card.querySelector('.tool-card-badge').textContent.trim()) || Date.now() > deadline) ? resolve() : requestAnimationFrame(check);
        check();
      });
      // Plegada (tras volver a la vista), solo pregunta por el final.
      card.querySelector('.tool-execution-card').classList.add('collapsed');
      Object.assign(job, { status: 'exited', exit_code: 0, elapsed_s: 42 });
      const before = window.__jobCalls.length;
      window.ChatMCP.manager.syncCommandJobs([]);
      await new Promise(resolve => {
        const deadline = Date.now() + 2000;
        const check = () => (card.querySelector('.tool-card-badge').textContent.trim() === 'Terminado · 42 s' || Date.now() > deadline) ? resolve() : requestAnimationFrame(check);
        check();
      });
      return {
        badge: card.querySelector('.tool-card-badge').textContent.trim(),
        calls: window.__jobCalls.slice(before).map(call => [call.method, call.params.id])
      };
    });
    // Después vuelve a leer la lista de comandos en marcha, ya sin este.
    assert.deepEqual(viaHeartbeat, { badge: 'Terminado · 42 s', calls: [['zerochat/jobs/get', 11], ['zerochat/jobs/list', undefined]] });

    // Tarjeta del historial: plegada y sin peticiones; al desplegarla, si el log ya no existe en
    // el servidor, muestra la salida guardada en el chat.
    const historical = await page.evaluate(async () => {
      const requests = [];
      window.ChatMCP.manager.requestExternalControl = async method => { requests.push(method); throw new Error('Comando no encontrado'); };
      const make = output => {
        const card = window.ChatToolCards.renderHistoricalToolCard({ function: { name: 'run_command', arguments: JSON.stringify({ command: 'pytest -x' }) } }, {
          content: JSON.stringify({ success: true, status: 'exited', job_id: 3, exit_code: 0, duration_s: 72, output })
        });
        document.getElementById('command-card-test').appendChild(card);
        return card;
      };
      const card = make('5 passed\n');
      const empty = make('');
      // Aserción negativa: la espera fija es a propósito para confirmar que plegada no pide nada.
      await new Promise(resolve => setTimeout(resolve, 50));
      const before = { collapsed: card.querySelector('.tool-execution-card').classList.contains('collapsed'), requests: requests.length };
      card.querySelector('.tool-execution-card').classList.remove('collapsed');
      empty.querySelector('.tool-execution-card').classList.remove('collapsed');
      await new Promise(resolve => {
        const deadline = Date.now() + 2000;
        const check = () => (card.querySelector('.command-card-log').textContent === '5 passed'
          && empty.querySelector('.command-card-log').textContent.length > 0 || Date.now() > deadline) ? resolve() : requestAnimationFrame(check);
        check();
      });
      return {
        before,
        badge: card.querySelector('.tool-card-badge').textContent.trim(),
        stop: !card.querySelector('[data-command-action="stop"]').hidden,
        log: card.querySelector('.command-card-log').textContent,
        empty: empty.querySelector('.command-card-log').textContent
      };
    });
    assert.deepEqual(historical, {
      before: { collapsed: true, requests: 0 },
      badge: 'Terminado · 1:12',
      stop: false,
      log: '5 passed',
      empty: 'El log ya no está disponible: ZeroChat se ha reiniciado o el comando se ha descartado.'
    });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

});
