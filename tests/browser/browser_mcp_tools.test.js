const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestBrowser, closeGlobalBrowser, getIndexUrl, waitForAppReady, openSavedSession } = require('../helpers/browser-env.js');

describe('Browser UI - mcp_tools', { concurrency: 2 }, () => {
  after(async () => {
    await closeGlobalBrowser();
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
      const call = { function: { name: tool.name, arguments: '{}' } };
      const card = window.ChatToolCards.createLiveToolCard(tool.name, {});
      document.body.appendChild(card);
      const pending = window.ChatToolCards.promptToolAuthorization(card, call, { serverId: tool.metadata.mcpServerId, serverName: tool.metadata.mcpServerId, args: {} });
      const button = card.querySelector('.btn-auth-allow-server');
      const label = button.textContent;
      const title = button.title;
      button.click();
      const decision = await pending;
      card.remove();

      const localProvider = new window.ChatMCP.McpToolProvider({
        id: 'mcp_proxy', name: 'ZeroChat Local Server',
        initialize: async () => ({ success: true }),
        listTools: async () => [{ name: 'run_command', inputSchema: { type: 'object', properties: {} } }]
      });
      const [localTool] = await localProvider.discoverTools();
      const localCard = window.ChatToolCards.createLiveToolCard(localTool.name, {});
      document.body.appendChild(localCard);
      const localPending = window.ChatToolCards.promptToolAuthorization(localCard, { function: { name: localTool.name, arguments: '{}' } }, {
        serverId: localTool.metadata.mcpServerId,
        serverName: localTool.metadata.mcpServerName,
        args: {}
      });
      const hasLocalServerButton = Boolean(localCard.querySelector('.btn-auth-allow-server'));
      localCard.querySelector('.btn-auth-deny').click();
      await localPending;
      localCard.remove();

      return { label, title, decision, hasLocalServerButton };
    });
    assert.ok(result.label.includes('composio'));
    assert.ok(result.title.includes('composio'));
    assert.ok(!result.label.includes('External MCP Host'));
    assert.deepEqual(result.decision, { decision: 'allow_server_always' });
    assert.equal(result.hasLocalServerButton, false);
  } finally { await browser.close(); }
});

test('Browser UI - autorización de comando concede la línea editable con alcance de sesión, proyecto o todos', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);
    const result = await page.evaluate(async () => {
      // 1. Tarjeta con oferta de comando
      const cardCmd = window.ChatToolCards.createLiveToolCard('run_command', {});
      document.body.appendChild(cardCmd);
      const pendingCmd = window.ChatToolCards.promptToolAuthorization(cardCmd, {
        function: { name: 'run_command', arguments: JSON.stringify({ command: 'ls -la' }) }
      }, {
        args: { command: 'ls -la' },
        ruleOffer: {
          type: 'command',
          command: 'ls *'
        }
      });
      const hasGenericAlwaysInCmd = Boolean(cardCmd.querySelector('.btn-auth-allow-always'));
      const hasGenericSessionInCmd = Boolean(cardCmd.querySelector('.btn-auth-allow-session'));
      const scopes = [...cardCmd.querySelectorAll('.btn-auth-allow-cmd')].map(button => button.dataset.decision);
      // La línea propuesta es el patrón y se edita; vacía o con "*" en el ejecutable no se acepta
      const input = cardCmd.querySelector('.tool-auth-cmd-input');
      const buttons = [...cardCmd.querySelectorAll('.btn-auth-allow-cmd')];
      const projectButton = cardCmd.querySelector('.btn-auth-allow-cmd[data-decision="allow_project"]');
      const proposedPattern = input.value;
      const rejected = {};
      for (const value of ['  ', '*', ' * ', 'l* -l']) {
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        buttons.forEach(button => button.click());
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        rejected[value] = buttons.every(button => button.disabled) && input.getAttribute('aria-invalid') === 'true';
      }
      const stillPending = Boolean(cardCmd.querySelector('.tool-card-auth-prompt'));
      input.value = 'ls -l *';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const enabledAgain = buttons.every(button => !button.disabled);
      projectButton.click();
      const cmdDecision = await pendingCmd;
      cardCmd.remove();

      // 2. Tarjeta sin oferta de comando (lectura o herramienta genérica)
      const cardFile = window.ChatToolCards.createLiveToolCard('read_file', {});
      document.body.appendChild(cardFile);
      const pendingFile = window.ChatToolCards.promptToolAuthorization(cardFile, {
        function: { name: 'read_file', arguments: JSON.stringify({ path: 'test.txt' }) }
      }, {
        args: { path: 'test.txt' }
      });
      const hasGenericAlwaysInFile = Boolean(cardFile.querySelector('.btn-auth-allow-always'));
      cardFile.querySelector('.btn-auth-deny').click();
      await pendingFile;
      cardFile.remove();

      // 3. run_command compuesto, sin oferta: no hay "siempre" sin patrón
      const cardChained = window.ChatToolCards.createLiveToolCard('run_command', {});
      document.body.appendChild(cardChained);
      const pendingChained = window.ChatToolCards.promptToolAuthorization(cardChained, {
        function: { name: 'run_command', arguments: JSON.stringify({ command: 'ls && pwd' }) }
      }, { args: { command: 'ls && pwd' } });
      const hasGenericAlwaysInChained = Boolean(cardChained.querySelector('.btn-auth-allow-always'));
      cardChained.querySelector('.btn-auth-deny').click();
      await pendingChained;
      cardChained.remove();

      return { hasGenericAlwaysInChained, hasGenericAlwaysInCmd, hasGenericSessionInCmd, scopes, hasGenericAlwaysInFile, proposedPattern, rejected, stillPending, enabledAgain, cmdDecision };
    });
    assert.deepEqual(result.scopes, ['allow_session', 'allow_project', 'allow_always']);
    assert.equal(result.hasGenericAlwaysInChained, false, 'run_command solo se permite para siempre con un patrón');
    assert.equal(result.hasGenericSessionInCmd, false, 'En un comando la sesión se concede sobre la línea, no sobre run_command entero');
    assert.equal(result.proposedPattern, 'ls *');
    assert.deepEqual(result.rejected, { '  ': true, '*': true, ' * ': true, 'l* -l': true });
    assert.equal(result.stillPending, true, 'Una línea no válida no decide la autorización');
    assert.equal(result.enabledAgain, true);
    assert.deepEqual(result.cmdDecision, { decision: 'allow_project', commandPattern: 'ls -l *' });
    assert.equal(result.hasGenericAlwaysInCmd, false, 'El botón genérico permitir siempre no debe aparecer en comandos');
    assert.equal(result.hasGenericAlwaysInFile, true, 'El botón genérico permitir siempre debe aparecer en herramientas no comando');
  } finally { await browser.close(); }
});

test('Browser UI - la petición de autorización saca la tarjeta del historial plegado y la deja como estaba al decidir', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);
    const result = await page.evaluate(async () => {
      const collapsed = card => card.querySelector('.tool-execution-card').classList.contains('collapsed');
      const inHistory = card => card.parentElement.classList.contains('tool-call-group-cards');
      const ask = async (card, button) => {
        const pending = window.ChatToolCards.promptToolAuthorization(card, { function: { name: 'read_file', arguments: '{}' } }, { args: {} });
        const visible = !collapsed(card) && !inHistory(card);
        card.querySelector(button).click();
        await pending;
        return visible;
      };
      const container = document.createElement('div');
      document.body.appendChild(container);
      const card = window.ChatToolCards.createLiveToolCard('read_file', { path: 'a.txt' });
      window.ChatToolCards.appendToolCard(container, card);
      const states = { created: collapsed(card) && inHistory(card), whileAsking: await ask(card, '.btn-auth-allow-once'), afterAllow: collapsed(card) && inHistory(card) };
      // Abierta por el usuario (fuera del chat el botón no tiene listener), sigue abierta después de decidir.
      card.querySelector('.tool-execution-card').classList.remove('collapsed');
      states.userOpened = !collapsed(card);
      await ask(card, '.btn-auth-deny');
      states.afterDeny = !collapsed(card) && inHistory(card);
      container.remove();
      return states;
    });
    assert.deepEqual(result, { created: true, whileAsking: true, afterAllow: true, userOpened: true, afterDeny: true });
  } finally { await browser.close(); }
});

test('Browser UI - la autorización de carpeta solo se ofrece para rutas que pueden ser una regla', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);
    const result = await page.evaluate(async () => {
      const render = (path, ruleOffer = null) => {
        const args = { path };
        const call = { function: { name: 'read_file', arguments: JSON.stringify(args) } };
        const card = window.ChatToolCards.createLiveToolCard('read_file', args);
        document.body.appendChild(card);
        const pending = window.ChatToolCards.promptToolAuthorization(card, call, { ruleOffer, args });
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

      const { card, pending } = render('/home/user/other/a.txt', { type: 'directory', access: 'R', directoryRule: 'R:/home/user/other/**' });
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
        args: { command: 'git status' },
        ruleOffer: { type: 'command', command: 'git *' }
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
        hasCommandScope: !!menu.querySelector('.btn-auth-allow-cmd'),
        // Los tres alcances van uno por fila y la línea del comando debajo, con ancho útil
        cmdInputWidth: menu.querySelector('.tool-auth-cmd-input').getBoundingClientRect().width,
        cmdLayout: (() => {
          const rows = [...menu.querySelectorAll('.btn-auth-allow-cmd'), menu.querySelector('.tool-auth-cmd-input')].map(el => el.getBoundingClientRect());
          return rows.every((rect, i) => i === 0 || rect.top >= rows[i - 1].bottom);
        })(),
        hasServerTrust: !!menu.querySelector('.btn-auth-allow-server'),
        panelVisible: window.__permissionCard.querySelector('.tool-execution-card').getBoundingClientRect().bottom <= document.getElementById('messages-list').getBoundingClientRect().bottom + 1
      };
    });
    assert.equal(expanded.expanded, 'true');
    assert.equal(expanded.menuHidden, false);
    assert.equal(expanded.menuPosition, 'static');
    assert.equal(expanded.hasCommandScope, true);
    assert.ok(expanded.cmdInputWidth >= 150, `El campo del patrón es demasiado estrecho: ${expanded.cmdInputWidth}px`);
    assert.equal(expanded.cmdLayout, true);
    assert.equal(expanded.hasServerTrust, true);
    assert.equal(expanded.panelVisible, true);
  } finally { await browser.close(); }
});

test('Browser UI - los cambios de Agente y Permisos avisan antes de cerrar ajustes y descartarlos no los guarda', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);

    await page.click('#btn-open-settings');
    const savedState = () => page.evaluate(() => ({
      enabledTools: window.ChatConfig.getActive().enabledTools,
      policy: window.ChatToolSecurity.manager.getGlobalMcpPolicy(),
      rules: window.ChatToolSecurity.manager.getDirectoryRules()
    }));
    const before = await savedState();
    await page.click('[data-section="agent"]');
    await page.waitForFunction(() => document.getElementById('settings-dialog')?.open);
    const toolCheckbox = page.locator('#settings-agent .agent-tool-checkbox:not([data-tool-id="browser_action"])').first();
    const toolChecked = await toolCheckbox.isChecked();
    await toolCheckbox.locator('..').click();
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
    await page.click('[data-section="agent"]');
    await page.waitForFunction(() => document.getElementById('settings-dialog')?.open);
    assert.equal(await toolCheckbox.isChecked(), toolChecked, 'Reabrir restaura el interruptor descartado');
    await page.click('#btn-close-settings');
    await page.waitForFunction(() => !document.getElementById('settings-dialog')?.open);

    await page.click('[data-section="permissions"]');
    await page.waitForFunction(() => document.getElementById('settings-dialog')?.open);
    await page.locator('.mcp-policy-option:has(#mcp-policy-allow-all)').click();
    await page.fill('#mcp-directory-rules', 'RW:/tmp/descartado');
    assert.equal(await page.$eval('#settings-dialog', dialog => dialog.dataset.settingsDirty), 'true');
    await page.click('#btn-close-settings');
    await page.waitForFunction(() => document.getElementById('notice-dialog')?.open);
    await page.click('#notice-accept');
    await page.waitForFunction(() => !document.getElementById('settings-dialog')?.open);
    assert.deepEqual(await savedState(), before, 'Descartar no guarda herramientas, política ni reglas');

    await page.click('[data-section="permissions"]');
    await page.waitForFunction(() => document.getElementById('settings-dialog')?.open);
    assert.deepEqual(await page.evaluate(() => ({
      policy: document.querySelector('input[name="mcp-global-policy"]:checked')?.value,
      rules: document.getElementById('mcp-directory-rules').value
    })), { policy: before.policy, rules: before.rules.join('\n') }, 'Reabrir restaura los permisos guardados');
  } finally {
    await browser.close();
  }
});

test('Browser UI - el progreso MCP sobrevive al renderizado y el plazo agotado deja el botón ocupado con el aviso', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);
    const result = await page.evaluate(async () => {
      // La aplicación ya montó el panel MCP sobre su lista de servicios y sigue ChatState.
      const container = document.getElementById('mcp-servers-list');
      const manager = ChatMCP.manager;
      const originalStart = manager.startExternalServer;
      try {
        ChatI18n.setLanguage('es');
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
        reportWait(2, 10);
        const attempt = button().textContent.trim();
        const error = new Error('Wait expired');
        error.code = 'EXTERNAL_START_WAIT_TIMEOUT';
        error.externalServer = { id: 'ejemplo', status: 'starting' };
        rejectStart(error);
        // Flush de macrotarea: deja ejecutar el callback asíncrono del mock.
        await new Promise(resolve => setTimeout(resolve, 0));
        const timedOut = { disabled: button().disabled, error: container.querySelector('.mcp-server-error')?.textContent };
        ChatState.set('mcp', { externalServers: [{ id: 'ejemplo', status: 'running' }] });
        return { initial, attempt, timedOut, action: button().getAttribute('data-action') };
      } finally {
        manager.startExternalServer = originalStart;
      }
    });
    assert.deepEqual(result.initial, { text: 'Iniciando', disabled: true, busy: 'true', replaced: true });
    assert.equal(result.attempt, 'Iniciando (intento 2 de 10)…');
    assert.equal(result.timedOut.disabled, true);
    assert.match(result.timedOut.error, /OAuth/);
    assert.equal(result.action, 'stop');
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
      const originalRead = manager.readLiveState;
      const originalTimeout = window.setTimeout;
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
          manager.requestExternalControl = async () => {
            starts += 1;
            const error = new Error('Initial request timed out');
            error.name = 'AbortError';
            throw error;
          };
          // El latido publica lo que lee, como haría con el servidor real.
          manager.readLiveState = async () => {
            checks += 1;
            const payload = { servers: [checks < 3 ? { id: 'oauth-fixture', status: checks === 1 ? 'installing' : 'starting' } : running] };
            await manager.applyLiveState(payload);
            return payload;
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
        manager.readLiveState = originalRead;
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

test('Browser UI - la tarjeta de run_command sigue al comando, muestra su log al desplegarse, lo detiene y ve su final en el latido', { timeout: 30000 }, async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    // Reloj simulado: los sondeos del log (700 ms y luego cada 2 s) y el reloj de la tarjeta avanzan
    // con runFor en lugar de esperarse.
    await page.clock.install();
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
    await page.clock.runFor(3000);
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
      [true, 'running', 'npm run dev', 'linea 1\nlinea 2\n', ['log', 'stop'], true, true]);
    const calls = await page.evaluate(() => window.__jobCalls);
    assert.ok(calls.some(call => call.method === 'zerochat/jobs/get' && call.params.id === 7));
    assert.ok(calls.some(call => call.method === 'zerochat/jobs/log' && call.params.id === 7));

    // Plegada no hace peticiones, aunque el reloj siga avanzando; al desplegarla de nuevo, el log
    // vuelve a estar al día.
    const collapsed = await page.evaluate(() => {
      window.__commandCard.querySelector('.tool-execution-card').classList.add('collapsed');
      return { calls: window.__jobCalls.length, badge: window.__commandCard.querySelector('.tool-card-badge').textContent };
    });
    await page.clock.runFor(5000);
    assert.deepEqual(await page.evaluate(({ calls, badge }) => ({
      calls: window.__jobCalls.slice(calls).map(call => call.method),
      clockMoved: window.__commandCard.querySelector('.tool-card-badge').textContent !== badge
    }), collapsed), { calls: [], clockMoved: true });
    await page.evaluate(() => window.__commandCard.querySelector('.tool-execution-card').classList.remove('collapsed'));
    await page.clock.runFor(2000);
    await page.waitForFunction(() => {
      const log = window.__commandCard.querySelector('.command-card-log').textContent;
      return log.endsWith(window.__job.log.trimEnd().split('\n').pop());
    });

    // «Ver log completo» abre una pestaña con todo el log que guarda el servidor, no solo las últimas líneas.
    const [popup] = await Promise.all([page.waitForEvent('popup'), card.locator('[data-command-action="log"]').click()]);
    await popup.waitForURL(/^blob:/);
    const fullLog = await popup.evaluate(() => document.body.innerText);
    assert.ok(fullLog.startsWith('linea 1\nlinea 2\n') && /linea \d+\n?$/.test(fullLog), fullLog.slice(-80));
    await popup.close();

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
    await page.clock.runFor(5000);
    assert.equal(await page.evaluate(() => window.__jobCalls.length), callsAfterStop, 'Un comando terminado deja de consultarse');

    // El final de un comando en segundo plano llega con el latido: al dejar de figurar entre los
    // que siguen en marcha, su tarjeta pregunta una vez cómo acabó.
    await page.evaluate(() => {
      const job = window.__job;
      Object.assign(job, { id: 11, key: 'inv-tarjeta-3', status: 'running', exit_code: null, log: 'vigilando\n' });
      window.ChatState.set('mcp', { status: 'connected', serverInfo: { name: 'ZeroChat', cwd: '/tmp' }, tools: [] });
      window.ChatMCP.manager.applyLiveState({ jobs: [{ id: 11, command: 'npm run watch', status: 'running', started_at: Date.now(), background: true }] });
      const args = { command: 'npm run watch', background: true };
      const card = window.ChatToolCards.createLiveToolCard('run_command', args);
      card.dataset.invocationId = job.key;
      window.ChatToolCards.appendToolCard(document.getElementById('command-card-test'), card);
      window.ChatToolCards.updateLiveToolCard(card, 'run_command', args, { content: JSON.stringify({ success: true, status: 'running', job_id: 11, elapsed_s: 2.5, output: 'vigilando\n' }) }, 2500);
      window.__commandCard = card;
    });
    await page.waitForFunction(() => /^En segundo plano · /.test(window.__commandCard.querySelector('.tool-card-badge').textContent.trim()));
    // Plegada, muestra la última línea de salida que trae el latido; desplegada no, porque se ve el log.
    const lastLine = await page.evaluate(() => {
      const card = window.__commandCard;
      const element = card.querySelector('.command-card-last-line');
      card.querySelector('.tool-execution-card').classList.add('collapsed');
      window.ChatMCP.manager.applyLiveState({ jobs: [{ id: 11, command: 'npm run watch', status: 'running', started_at: Date.now(), background: true, last_line: 'compilando 3/10' }] });
      const folded = { text: element.textContent, shown: getComputedStyle(element).display !== 'none' && !element.hidden };
      card.querySelector('.tool-execution-card').classList.remove('collapsed');
      return { folded, expandedShown: getComputedStyle(element).display !== 'none' };
    });
    assert.deepEqual(lastLine, { folded: { text: 'compilando 3/10', shown: true }, expandedShown: false });

    // Plegada (tras volver a la vista), solo pregunta por el final.
    const before = await page.evaluate(() => {
      window.__commandCard.querySelector('.tool-execution-card').classList.add('collapsed');
      Object.assign(window.__job, { status: 'exited', exit_code: 0, elapsed_s: 42 });
      const before = window.__jobCalls.length;
      window.ChatMCP.manager.applyLiveState({ jobs: [] });
      return before;
    });
    await page.waitForFunction(() => window.__commandCard.querySelector('.tool-card-badge').textContent.trim() === 'Terminado · 42 s');
    assert.equal(await page.evaluate(() => window.__commandCard.querySelector('.command-card-last-line').hidden), true, 'Un comando terminado no muestra última línea');
    const viaHeartbeat = await page.evaluate(before => window.__jobCalls.slice(before).map(call => [call.method, call.params.id]), before);
    // Después vuelve a leer la lista de comandos en marcha, ya sin este.
    assert.deepEqual(viaHeartbeat, [['zerochat/jobs/get', 11], ['zerochat/jobs/list', undefined]]);

    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('Browser UI - la tarjeta de check_command muestra la salida nueva mientras espera y corta la espera sin detener el comando', { timeout: 30000 }, async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.clock.install();
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);

    await page.evaluate(async () => {
      const provider = new window.ChatMCP.McpToolProvider({ id: 'mcp_proxy', name: 'ZeroChat', initialize: async () => ({ success: true }), listTools: async () => [{ name: 'check_command' }] }, { id: 'mcp_prov_wait_card_test' });
      await provider.discoverTools();
      window.ChatAgentCore.registry.registerProvider(provider);
      // Servidor simulado: el comando 7 lleva escritas dos líneas y escribe una más en cada consulta del log.
      const job = { id: 7, log: 'antes 1\nantes 2\n' };
      window.__waitCalls = [];
      window.ChatMCP.manager.requestExternalControl = async (method, params) => {
        window.__waitCalls.push({ method, params });
        if (method === 'zerochat/jobs/end_wait') return { ended: true };
        if (method === 'zerochat/jobs/get') return { id: job.id, status: 'running', output_bytes: job.log.length };
        if (method === 'zerochat/jobs/log') {
          job.log += `nueva ${job.log.split('\n').length - 2}\n`;
          return { text: job.log.slice(params.offset), next: job.log.length, total: job.log.length, done: false };
        }
        throw new Error(`Método inesperado ${method}`);
      };
      const container = document.createElement('div');
      container.id = 'wait-card-test';
      document.getElementById('chat-messages')?.appendChild(container) || document.body.appendChild(container);
      const args = { job_id: 7, wait_seconds: 300, pattern: 'listening' };
      const card = window.ChatToolCards.createLiveToolCard('check_command', args);
      card.dataset.invocationId = 'inv-espera-1';
      window.ChatToolCards.appendToolCard(container, card);
      window.__waitCard = card;
      window.__waitArgs = args;
    });

    await page.clock.runFor(3000);
    await page.waitForFunction(() => /nueva 1\n/.test(window.__waitCard.querySelector('.command-card-log').textContent));
    const waiting = await page.evaluate(() => {
      const card = window.__waitCard;
      return {
        title: card.querySelector('.tool-card-title, .tool-execution-card').textContent.includes('Esperando al comando 7'),
        pattern: card.querySelector('.command-card-command').textContent,
        badge: card.querySelector('.tool-card-badge').textContent.trim(),
        log: card.querySelector('.command-card-log').textContent,
        endButton: card.querySelector('[data-command-action="stop"]').textContent.trim(),
        endVisible: !card.querySelector('[data-command-action="stop"]').hidden,
        // Mientras espera está en la zona visible de su grupo, no en el historial plegado.
        inView: card.parentElement.classList.contains('tool-call-group-active-cards')
      };
    });
    assert.deepEqual([waiting.title, waiting.pattern, waiting.endButton, waiting.endVisible, waiting.inView], [true, 'listening', 'Dejar de esperar', true, true]);
    assert.match(waiting.badge, /^Esperando · \d\.\d s de 5:00$/);
    // Solo la salida nueva: lo escrito antes de empezar a esperar no aparece.
    assert.ok(waiting.log.startsWith('nueva 1\n') && !waiting.log.includes('antes'), waiting.log);

    await page.locator('#wait-card-test [data-command-action="stop"]').click();
    await page.waitForFunction(() => window.__waitCalls.some(call => call.method === 'zerochat/jobs/end_wait'));
    const endCall = await page.evaluate(() => window.__waitCalls.find(call => call.method === 'zerochat/jobs/end_wait').params);
    assert.deepEqual(endCall, { key: 'inv-espera-1' });
    assert.equal(await page.evaluate(() => window.__waitCalls.filter(call => call.method === 'zerochat/jobs/stop').length), 0, 'Cortar la espera no detiene el comando');

    // La herramienta vuelve con la espera cortada: la tarjeta lo dice y deja de consultar el log.
    await page.evaluate(() => {
      const result = { content: JSON.stringify({ success: true, status: 'running', job_id: 7, returned_because: 'wait_ended_by_user', waited_s: 4, new_output: 'nueva 1\nnueva 2\n' }) };
      window.ChatToolCards.updateLiveToolCard(window.__waitCard, 'check_command', window.__waitArgs, result, 4000);
    });
    const ended = await page.evaluate(() => ({
      badge: window.__waitCard.querySelector('.tool-card-badge').textContent.trim(),
      endHidden: window.__waitCard.querySelector('[data-command-action="stop"]').hidden,
      log: window.__waitCard.querySelector('.command-card-log').textContent,
      calls: window.__waitCalls.length
    }));
    assert.deepEqual([ended.badge, ended.endHidden, ended.log], ['Espera cortada · 4.0 s', true, 'nueva 1\nnueva 2']);
    await page.clock.runFor(5000);
    assert.equal(await page.evaluate(() => window.__waitCalls.length), ended.calls, 'Una espera terminada deja de consultarse');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

});
