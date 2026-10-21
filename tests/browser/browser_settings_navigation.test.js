const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestBrowser, closeGlobalBrowser, seedConnectionProfiles, getIndexUrl, withTestApp } = require('../helpers/browser-env.js');

describe('Browser UI - Navegación de Configuración Móvil y Sidebar', { concurrency: 1 }, () => {
  after(async () => {
    await closeGlobalBrowser();
  });

  test('Requisito 6: en móvil, seleccionar sección cierra el sidebar y cerrar el panel lo recupera', { timeout: 10000 }, async () => {
    const browser = await createTestBrowser();
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      page.setDefaultTimeout(3000);
      await seedConnectionProfiles(page);
      await page.goto(getIndexUrl(), { waitUntil: 'load' });
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

  /**
   * Abre los ajustes desde la barra lateral en la sección indicada. Con el diálogo modal abierto la
   * barra queda detrás, así que el clic se envía al elemento como en el resto de esta suite.
   */
  async function openSettings(page, section) {
    if (await page.locator('#sidebar-view-settings').isHidden()) await page.click('#btn-open-settings');
    await page.locator(`#sidebar-settings-nav [data-section="${section}"]`).evaluate(item => item.click());
    await page.waitForFunction(id => document.getElementById('settings-dialog').open && document.getElementById(`settings-${id}`).classList.contains('active'), section);
  }

  test('Browser UI - la sección MCP se aplica al momento: sin Guardar ni cambios pendientes', async () => {
    await withTestApp({ viewport: { width: 1280, height: 800 } }, async page => {
      page.setDefaultTimeout(5000);
      await openSettings(page, 'mcp');
      assert.equal(await page.locator('#btn-save-settings').isHidden(), true);
      // Un interruptor real de herramienta MCP dentro de la sección.
      await page.evaluate(() => window.ChatUIMcp.renderToolsList(document.getElementById('mcp-tools-container'), [
        { name: 'mcp_demo_read', description: 'Lee', inputSchema: { type: 'object', properties: {} }, metadata: { mcpServerName: 'demo', originalName: 'read' } }
      ], window.ChatConfig.getActive().enabledTools));
      await page.locator('#mcp-tools-container .mcp-tool-card input[type="checkbox"]').first().evaluate(input => input.click());
      assert.equal(await page.$eval('#settings-dialog', dialog => dialog.dataset.settingsDirty), 'false');
      await page.click('#btn-close-settings');
      await page.waitForFunction(() => !document.getElementById('settings-dialog').open);
      assert.equal(await page.evaluate(() => document.getElementById('notice-dialog').open), false, 'Cerrar no pide confirmación');

      await openSettings(page, 'model');
      assert.equal(await page.locator('#btn-save-settings').isVisible(), true);
      await page.fill('#setting-system-data-prompt', 'Datos propios');
      await openSettings(page, 'mcp');
      assert.equal(await page.locator('#btn-save-settings').isVisible(), true, 'Con cambios de otra sección se puede guardar desde MCP');
    });
  });

  test('Browser UI - guardar aplica reglas, política MCP y datos del sistema, y una regla inválida muestra el error', async () => {
    await withTestApp({ viewport: { width: 1280, height: 800 } }, async page => {
      page.setDefaultTimeout(5000);
      await openSettings(page, 'agent');
      await page.locator('.switch:has([data-tool-id="search_web"])').click();
      assert.notEqual(await page.evaluate(() => window.ChatConfig.getActive().enabledTools.search_web), false, 'El interruptor espera a Guardar');

      await openSettings(page, 'permissions');
      await page.fill('#mcp-directory-rules', 'R:/home/user\nW:/tmp\n\n');
      await page.locator('.mcp-policy-option:has(#mcp-policy-workspace-trust)').click();
      await openSettings(page, 'model');
      await page.fill('#setting-system-data-prompt', 'Datos propios');
      await page.click('#btn-save-settings');
      await page.waitForFunction(() => !document.getElementById('settings-dialog').open);
      assert.deepEqual(await page.evaluate(() => ({
        rules: window.ChatToolSecurity.manager.getDirectoryRules(),
        policy: window.ChatToolSecurity.manager.getGlobalMcpPolicy(),
        dataPrompt: window.ChatConfig.getActive().systemDataPrompt,
        searchWeb: window.ChatConfig.getActive().enabledTools.search_web
      })), { rules: ['R:/home/user', 'W:/tmp'], policy: 'workspace_trust', dataPrompt: 'Datos propios', searchWeb: false });

      await openSettings(page, 'permissions');
      assert.equal(await page.inputValue('#mcp-directory-rules'), 'R:/home/user\nW:/tmp', 'El campo muestra las reglas guardadas');
      await page.fill('#mcp-directory-rules', 'X:/invalid');
      await page.click('#btn-save-settings');
      await page.waitForFunction(() => document.getElementById('mcp-directory-rules-error').textContent !== '');
      assert.equal(await page.evaluate(() => document.getElementById('settings-dialog').open), true, 'Una regla inválida no cierra los ajustes');
    });
  });

  test('Browser UI - Navegador guarda la herramienta y la configuración de Playwright y lo reinicia tras confirmar', async () => {
    await withTestApp({ viewport: { width: 1280, height: 800 } }, async page => {
      page.setDefaultTimeout(5000);
      // Servidor local con Playwright MCP en marcha: solo Chromium instalado y solo Edge en el sistema.
      await page.evaluate(() => {
        window.ChatState.set('mcp', { status: 'connected', externalServers: [{ id: 'playwright', status: 'running', enabled: false }] });
        window.__requests = [];
        window.__actions = [];
        const saved = { mode: 'own', engine: 'chromium', userBrowser: 'chrome', headless: true, extensionToken: '' };
        window.ChatMCP.manager.requestExternalControl = async (method, params) => {
          window.__requests.push({ method, params });
          if (method === 'zerochat/browser/config/get') return saved;
          if (method === 'zerochat/browser/config/set') return params.config;
          return { available: true, systemBrowsers: { chrome: false, msedge: true, chromium: true, firefox: true },
            extensions: { chrome: false, msedge: false, chromium: true }, engines: [
            { id: 'chromium', title: 'Chrome for Testing 1', installed: true },
            { id: 'firefox', title: 'Firefox 2', installed: false }
          ] };
        };
        window.ChatMCP.manager.stopExternalServer = async id => { window.__actions.push(`stop ${id}`); };
        window.ChatMCP.manager.startExternalServer = async (id, onWait, { remember }) => { window.__actions.push(`start ${id} remember=${remember}`); };
      });
      await openSettings(page, 'browser');
      // Sin Playwright instalado el servidor declara browser_action no disponible: no se elige y se ve «Ninguna».
      assert.equal(await page.isDisabled('input[name="browser-tool"][value="browser_action"]'), true);
      assert.equal(await page.isChecked('input[name="browser-tool"][value="none"]'), true);
      await page.evaluate(() => window.ChatState.set('mcp', { tools: [{ name: 'browser_action', available: true }] }));
      assert.equal(await page.isChecked('input[name="browser-tool"][value="browser_action"]'), true, 'Disponible, vuelve la elección guardada');
      assert.equal(await page.locator('.browser-modes').count(), 0, 'Sin Playwright MCP no hay opciones de navegador');

      await page.check('input[name="browser-tool"][value="playwright"]');
      await page.waitForSelector('.browser-modes');
      assert.equal(await page.isDisabled('input[name="browser-engine"][value="firefox"]'), true, 'Un motor sin instalar no se elige');
      assert.equal(await page.isDisabled('#browser-user-browser option[value="chrome"]'), true, 'Un navegador no detectado no se elige');
      await page.check('input[name="browser-mode"][value="user"]');
      // Con la extensión instalada en el navegador elegido no se ofrece cómo instalarla.
      await page.selectOption('#browser-user-browser', 'chromium');
      assert.equal(await page.locator('a[href*="browser-action.html#extension"]').count(), 0, 'Chromium ya tiene la extensión');
      await page.selectOption('#browser-user-browser', 'msedge');
      assert.equal(await page.locator('a[href*="browser-action.html#extension"]').count(), 1, 'Edge no tiene la extensión');
      // Un token no válido se señala en su campo y no deja guardar.
      await page.fill('#browser-extension-token', 'tok 1');
      await page.locator('#browser-extension-token').blur();
      await page.click('#btn-save-settings');
      await page.waitForSelector('#browser-extension-token-error');
      assert.equal(await page.evaluate(() => document.getElementById('settings-dialog').open), true, 'Un token no válido no cierra los ajustes');
      // Se admite pegar la línea de entorno que muestra la extensión.
      await page.fill('#browser-extension-token', ' PLAYWRIGHT_MCP_EXTENSION_TOKEN=tok_1 ');
      await page.locator('#browser-extension-token').blur();
      assert.equal(await page.inputValue('#browser-extension-token'), 'tok_1');
      assert.equal(await page.locator('#browser-extension-token-error').count(), 0);
      await page.click('#btn-save-settings');
      await page.waitForFunction(() => document.getElementById('notice-dialog').open);
      await page.click('#notice-accept');
      await page.waitForFunction(() => !document.getElementById('settings-dialog').open);
      await page.waitForFunction(() => window.__actions.length === 2);
      assert.deepEqual(await page.evaluate(() => ({
        set: window.__requests.filter(request => request.method === 'zerochat/browser/config/set').map(request => request.params),
        actions: window.__actions,
        tool: window.ChatConfig.getActive().browser
      })), {
        set: [{ config: { mode: 'user', engine: 'chromium', userBrowser: 'msedge', headless: true, extensionToken: 'tok_1' } }],
        // El reinicio no cambia si Playwright MCP queda recordado para la siguiente sesión.
        actions: ['stop playwright', 'start playwright remember=false'],
        tool: 'playwright'
      });
    });
  });
});
