const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createTestBrowser, closeGlobalBrowser } = require('../helpers/browser-env.js');

describe('Browser UI - mcp_tools', { concurrency: 2 }, () => {
  after(async () => {
    await closeGlobalBrowser();
  });

test('Browser UI - ayuda MCP ofrece prompts multilínea copiables y claves API en ambos idiomas', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    for (const helpPath of ['help/mcp.html', 'help/en/mcp.html']) {
      await page.goto('file://' + path.resolve(__dirname, '../..', helpPath), { waitUntil: 'load' });
      const result = await page.evaluate(() => {
        const boxes = Array.from(document.querySelectorAll('.code-wrapper'));
        const prompts = boxes.filter(box => box.textContent.includes('PASTE_API_KEY_HERE') && box.textContent.includes('README.md'));
        return {
          prompts: prompts.map(box => ({
            lines: box.querySelector('pre').textContent.trim().split('\n').length,
            copy: Boolean(box.querySelector('.btn-copy')),
            text: box.querySelector('pre').textContent
          })),
          remote: Boolean(document.getElementById('crear-mcp-remoto')),
          keys: Boolean(document.getElementById('api-key-servicio')),
          header: boxes.some(box => box.textContent.includes('Authorization: Bearer ${REMOTE_API_KEY}')),
          permissions: document.body.textContent.includes('chmod 600')
        };
      });
      assert.equal(result.prompts.length, 2);
      assert.ok(result.prompts.every(prompt => prompt.lines >= 8 && prompt.copy));
      assert.ok(result.prompts[1].text.includes('zerochat/services/composio'));
      assert.equal(result.remote, true);
      assert.equal(result.keys, true);
      assert.equal(result.header, true);
      assert.equal(result.permissions, true);
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
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

test('Browser UI - autorización de Composio muestra y devuelve únicamente su servicio', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    await page.goto('file://' + path.resolve(__dirname, '../../zerochat.html'), { waitUntil: 'load' });
    await page.waitForFunction(() => document.documentElement.classList.contains('zerochat-ready'));
    const result = await page.evaluate(async () => {
      const provider = new window.ChatMCP.McpToolProvider({
        id: 'mcp_external', name: 'ZeroChat External MCP Host',
        initialize: async () => {},
        listTools: async () => [{
          name: 'composio_COMPOSIO_SEARCH_TOOLS',
          metadata: { mcpServerId: 'composio', originalName: 'COMPOSIO_SEARCH_TOOLS' }
        }]
      });
      const [tool] = await provider.discoverTools();
      const manager = new window.ChatToolSecurity.ToolSecurityManager({ storageKey: 'browser_composio_auth' });
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

test('Browser UI - en móvil las acciones MCP no comprimen la descripción del servidor', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto('file://' + path.resolve(__dirname, '../../zerochat.html'), { waitUntil: 'load' });
    await page.waitForFunction(() => document.documentElement.classList.contains('zerochat-ready'));
    const layout = await page.evaluate(() => {
      const container = document.createElement('div');
      container.className = 'mcp-servers-list';
      document.body.appendChild(container);
      window.ChatUIMcp.renderExternalServers(container, [{
        id: 'composio',
        displayName: { es: 'Composio Connect' },
        description: { es: 'MCP remoto para acceder a aplicaciones como Gmail, Google Drive, Slack o GitHub. Composio solicita la autorización de cada aplicación cuando sea necesaria.' },
        status: 'stopped',
        remote: { type: 'mcp-remote', url: 'https://connect.composio.dev/mcp' }
      }], key => window.ChatI18n.t(key));
      const item = container.querySelector('.mcp-server-item');
      const info = item.querySelector('.mcp-server-info');
      const desc = item.querySelector('.mcp-server-desc');
      const actions = item.querySelector('.mcp-server-actions');
      const trust = item.querySelector('.btn-mcp-server-trust');
      const toggle = item.querySelector('.btn-mcp-server-toggle');
      const result = {
        itemDirection: getComputedStyle(item).flexDirection,
        actionsDisplay: getComputedStyle(actions).display,
        descriptionWidth: desc.getBoundingClientRect().width,
        actionsBelowInfo: actions.getBoundingClientRect().top >= info.getBoundingClientRect().bottom,
        buttonsShareRow: Math.abs(trust.getBoundingClientRect().top - toggle.getBoundingClientRect().top) < 1
      };
      container.remove();
      return result;
    });
    assert.equal(layout.itemDirection, 'column');
    assert.equal(layout.actionsDisplay, 'grid');
    assert.ok(layout.descriptionWidth > 250);
    assert.equal(layout.actionsBelowInfo, true);
    assert.equal(layout.buttonsShareRow, true);
  } finally { await browser.close(); }
});

test('Browser UI - el panel MCP aprovecha el ancho sin solapar estado ni contadores', { timeout: 30000 }, async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.goto('file://' + path.resolve(__dirname, '../../zerochat.html'), { waitUntil: 'load' });
    await page.waitForFunction(() => document.documentElement.classList.contains('zerochat-ready'));
    await page.locator('#btn-open-settings').evaluate(button => button.click());
    await page.locator('#sidebar-settings-nav [data-section="mcp"]').evaluate(button => button.click());
    await page.waitForSelector('#settings-dialog[open]');
    await page.evaluate(() => Promise.all(document.getElementById('settings-dialog').getAnimations().map(animation => animation.finished.catch(() => {}))));

    for (const width of [320, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      for (const language of ['es', 'en']) {
        for (const theme of ['light', 'dark']) {
          const layout = await page.evaluate(({ language, theme }) => {
            window.ChatI18n.setLanguage(language, false);
            document.documentElement.setAttribute('data-theme', theme);
            const panel = document.getElementById('settings-mcp');
            window.ChatUIMcp.renderConnectionStatus({
              statusBadge: document.getElementById('mcp-status-badge'),
              statusText: document.getElementById('mcp-status-text'),
              serverDetails: document.getElementById('mcp-server-details'),
              bootstrapCard: document.getElementById('mcp-bootstrap-card')
            }, { status: 'connected', tools: Array.from({ length: 20 }, () => ({})) });
            window.ChatUIMcp.renderExternalServers(document.getElementById('mcp-servers-list'), [{
              id: 'composio', displayName: { es: 'Composio Connect', en: 'Composio Connect' },
              description: { es: 'MCP remoto para acceder a aplicaciones como Gmail, Google Drive, Slack o GitHub.', en: 'Remote MCP to access applications such as Gmail, Google Drive, Slack or GitHub.' },
              status: 'running', toolCount: 11,
              remote: { type: 'mcp-remote', url: 'https://connect.composio.dev/mcp' },
              help: { url: 'https://composio.dev', label: { es: 'Guía oficial de Composio Connect', en: 'Official Composio Connect guide' } }
            }]);
            const rect = selector => panel.querySelector(selector).getBoundingClientRect();
            const intersects = (a, b) => a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
            const title = rect('.mcp-title-group strong');
            const count = rect('.mcp-server-details');
            const status = rect('.mcp-status-actions');
            const section = panel.querySelector('#mcp-servers-card');
            const item = panel.querySelector('.mcp-server-item');
            const toggle = panel.querySelector('.btn-mcp-server-toggle');
            return {
              overlap: intersects(title, count) || intersects(title, status) || intersects(count, status),
              overflow: panel.scrollWidth > panel.clientWidth + 1,
              sectionWidth: section.getBoundingClientRect().width,
              panelWidth: panel.getBoundingClientRect().width,
              outerBorder: getComputedStyle(section).borderLeftWidth,
              innerBorder: getComputedStyle(item).borderLeftWidth,
              itemBackground: getComputedStyle(item).backgroundColor,
              panelBackground: getComputedStyle(document.getElementById('settings-dialog')).backgroundColor,
              descriptionWidth: rect('.mcp-server-desc').width,
              actionsBelow: rect('.mcp-server-actions').top >= rect('.mcp-server-info').bottom,
              toggleHeight: toggle.getBoundingClientRect().height,
              stopColor: getComputedStyle(toggle).color,
              stopBorderColor: getComputedStyle(toggle).borderColor
            };
          }, { language, theme });
          const context = `${width}px ${language} ${theme}`;
          assert.equal(layout.overlap, false, context);
          assert.equal(layout.overflow, false, context);
          assert.equal(layout.sectionWidth, layout.panelWidth, context);
          assert.equal(layout.outerBorder, '0px', context);
          assert.equal(layout.innerBorder, '0px', context);
          assert.notEqual(layout.itemBackground, layout.panelBackground, context);
          assert.ok(layout.toggleHeight >= 36, context);
          assert.equal(layout.stopColor, layout.stopBorderColor, context);
          if (width <= 640) {
            assert.ok(layout.descriptionWidth >= width - 70, context);
            assert.equal(layout.actionsBelow, true, context);
            assert.ok(layout.toggleHeight >= 40, context);
          }
        }
      }
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('Browser UI - las autorizaciones guardadas mantienen icono y detalle en una sola fila', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    await page.goto('file://' + path.resolve(__dirname, '../../zerochat.html'), { waitUntil: 'load' });
    await page.waitForFunction(() => document.documentElement.classList.contains('zerochat-ready'));
    const layout = await page.evaluate(() => {
      const security = window.ChatToolSecurity.manager;
      security.clearAllAuthorizations();
      security.setToolPolicy('mcp_compact_layout_test', 'allow', { originalName: 'compact layout test' });

      const container = document.createElement('div');
      container.className = 'mcp-saved-auths-list';
      container.style.width = '600px';
      document.body.appendChild(container);
      window.ChatUIMcp.renderSavedAuthorizations({ savedAuthsList: container }, key => window.ChatI18n.t(key));

      const button = container.querySelector('.btn-revoke-auth');
      const info = container.querySelector('.mcp-auth-item-info');
      const buttonRect = button.getBoundingClientRect();
      const infoRect = info.getBoundingClientRect();
      const result = {
        buttonDisplay: getComputedStyle(button).display,
        itemDisplay: getComputedStyle(container.querySelector('.mcp-auth-item')).display,
        isSingleRow: Math.abs((buttonRect.top + buttonRect.height / 2) - (infoRect.top + infoRect.height / 2)) < 1,
        iconBeforeInfo: buttonRect.left < infoRect.left,
        buttonColor: getComputedStyle(button).color
      };
      security.clearAllAuthorizations();
      container.remove();
      return result;
    });
    assert.equal(layout.itemDisplay, 'flex');
    assert.equal(layout.buttonDisplay, 'grid');
    assert.equal(layout.isSingleRow, true);
    assert.equal(layout.iconBeforeInfo, true);
    assert.notEqual(layout.buttonColor, 'rgb(255, 255, 255)');
  } finally { await browser.close(); }
});

test('Browser UI - la petición de permisos agrupa las autorizaciones ampliadas y se adapta a móvil', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
    await page.goto('file://' + path.resolve(__dirname, '../../zerochat.html'), { waitUntil: 'load' });
    await page.waitForFunction(() => document.documentElement.classList.contains('zerochat-ready'));
    await page.evaluate(() => {
      const messagesList = document.getElementById('messages-list');
      messagesList.replaceChildren(Object.assign(document.createElement('div'), { style: 'height: 1200px; flex: 0 0 1200px;' }));
      const card = document.createElement('div');
      card.innerHTML = '<div class="tool-execution-card"><span class="tool-card-badge"></span><div class="tool-card-collapsible-body"><div style="height: 110px;"></div></div></div>';
      messagesList.appendChild(card);
      window.__permissionCard = card;
      window.__permissionDecision = window.ChatToolCards.promptToolAuthorization(card, { function: { name: 'bash' } }, {
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
        serverTagCount: prompt.querySelectorAll('.mcp-card-server-tag').length,
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
    await page.goto('file://' + path.resolve(__dirname, '../../zerochat.html'), { waitUntil: 'load' });
    await page.waitForFunction(() => document.documentElement.classList.contains('zerochat-ready'));
    await page.evaluate(() => {
      const messagesList = document.getElementById('messages-list');
      messagesList.replaceChildren(Object.assign(document.createElement('div'), { style: 'height: 1200px; flex: 0 0 1200px;' }));
      const card = document.createElement('div');
      card.innerHTML = '<div class="tool-execution-card"><span class="tool-card-badge"></span><div class="tool-card-collapsible-body"><div style="height: 80px;"></div></div></div>';
      messagesList.appendChild(card);
      window.__desktopPermissionCard = card;
      window.__desktopPermissionDecision = window.ChatToolCards.promptToolAuthorization(card, { function: { name: 'bash' } }, {
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
    await page.click('[data-section="agent"]');
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

test('Browser UI - configuración MCP, perfiles y secciones permanecen operativas', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const filePath = 'file://' + path.resolve(__dirname, '../../zerochat.html');
    await page.goto(filePath, { waitUntil: 'load' });
    await page.waitForSelector('#welcome-banner');

    // 1. Abrir diálogo de Configuración.
    await page.click('#btn-open-settings');
    await page.click('[data-section="model"]');
    await page.waitForFunction(() => document.getElementById('settings-dialog')?.open);

    const contextCachePlacement = await page.evaluate(() => ({
      automaticNotice: !!document.querySelector('#settings-model [data-i18n="model_cache_title"]'),
      legacyToggle: !!document.getElementById('setting-enable-context-cache'),
      agentCacheText: document.querySelector('#settings-agent')?.textContent.includes('Caché de Contexto') || false
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
    const agentIndex = sectionOrder.indexOf('agent');
    const ragIndex = sectionOrder.indexOf('rag');
    const mcpIndex = sectionOrder.indexOf('mcp');
    const permissionsIndex = sectionOrder.indexOf('permissions');
    assert.ok(agentIndex >= 0 && ragIndex === agentIndex + 1, 'La sección RAG debe estar posicionada inmediatamente después de Agente');
    assert.ok(mcpIndex === ragIndex + 1, 'La sección MCP debe estar posicionada inmediatamente después de RAG');
    assert.ok(permissionsIndex === mcpIndex + 1, 'La sección Permisos debe estar inmediatamente después de MCP');

    const mcpSectionBtn = await page.$('#sidebar-settings-nav button[data-section="mcp"]');
    assert.ok(mcpSectionBtn, 'Debe existir la sección MCP en la navegación de configuración');
    await mcpSectionBtn.click();
    await page.waitForFunction(() => document.getElementById('settings-dialog')?.open);
    const isMcpActive = await mcpSectionBtn.evaluate(el => el.classList.contains('active'));
    assert.ok(isMcpActive, 'La sección MCP debe quedar activa al hacer click');

    const mcpUiState = await page.evaluate(() => {
      const pane = document.getElementById('settings-mcp');
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

    assert.ok(mcpUiState.paneActive, 'El panel settings-mcp debe estar visible y activo');
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

    const permissionsSectionBtn = await page.$('#sidebar-settings-nav button[data-section="permissions"]');
    assert.ok(permissionsSectionBtn, 'Debe existir la sección Permisos en la navegación de configuración');
    await permissionsSectionBtn.click();
    await page.waitForFunction(() => document.getElementById('settings-dialog')?.open);
    const permissionsState = await page.evaluate(() => ({
      paneActive: document.getElementById('settings-permissions')?.classList.contains('active'),
      hasAskPolicy: !!document.getElementById('mcp-policy-ask'),
      hasSavedAuthorizations: !!document.getElementById('mcp-saved-auths-list'),
      hasDirectoryRulesSaveButton: !!document.getElementById('btn-mcp-save-directory-rules'),
      modalBodyOverflowY: getComputedStyle(document.querySelector('#settings-form .modal-body')).overflowY,
      savedAuthorizationsOverflowY: getComputedStyle(document.getElementById('mcp-saved-auths-list')).overflowY,
      savedAuthorizationsMaxHeight: getComputedStyle(document.getElementById('mcp-saved-auths-list')).maxHeight
    }));
    assert.ok(permissionsState.paneActive, 'El panel tab-permissions debe quedar visible y activo');
    assert.ok(permissionsState.hasAskPolicy, 'La política de permisos debe estar disponible en la nueva pestaña');
    assert.ok(permissionsState.hasSavedAuthorizations, 'Las autorizaciones recordadas deben estar disponibles en la nueva pestaña');
    assert.equal(permissionsState.hasDirectoryRulesSaveButton, false, 'Las reglas de directorios deben usar el guardado general');
    assert.equal(permissionsState.modalBodyOverflowY, 'auto', 'El cuerpo del diálogo debe gestionar el desplazamiento de permisos');
    assert.equal(permissionsState.savedAuthorizationsOverflowY, 'visible', 'La lista de permisos no debe crear un scroll interno');
    assert.equal(permissionsState.savedAuthorizationsMaxHeight, 'none', 'La lista de permisos debe poder crecer sin límite de altura');

    await page.locator('#mcp-directory-rules').fill('R:./permissions-test/**');
    await page.click('#btn-save-settings');
    await page.waitForFunction(() => !document.getElementById('settings-dialog')?.open);
    assert.deepEqual(
      await page.evaluate(() => window.ChatToolSecurity.manager.getDirectoryRules()),
      ['R:permissions-test/**'],
      'El guardado general debe persistir las reglas de directorios'
    );

    // Volver a la sección MCP
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
    const filePath = 'file://' + path.resolve(__dirname, '../../zerochat.html');
    await page.goto(filePath, { waitUntil: 'load' });
    await page.waitForFunction(() => document.documentElement.classList.contains('zerochat-ready'));

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
    await page.waitForFunction(() => document.documentElement.classList.contains('zerochat-ready'));

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
});
