const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const { closeGlobalBrowser, withTestApp } = require('../helpers/browser-env.js');

describe('Browser UI - Navegación de Configuración Móvil y Sidebar', { concurrency: 1 }, () => {
  after(async () => {
    await closeGlobalBrowser();
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
      await page.evaluate(() => {
        const client = {
          async request(method, params) {
            if (method === 'zerochat/security/update') {
              if (params.directoryRules?.some(r => {
                const m = /^([RWX]+):/.exec(r);
                return !m || new Set(m[1]).size !== m[1].length;
              })) {
                throw new Error('Invalid directory rule. Use R, W, X followed by :path.');
              }
              const currentRules = params.directoryRules !== undefined ? params.directoryRules : window.ChatToolSecurity.manager.getDirectoryRules();
              const currentAllowAll = params.allowAll !== undefined ? params.allowAll : window.ChatToolSecurity.manager.getAllowAll();
              return { policies: {
                directoryRules: currentRules,
                allowAll: currentAllowAll
              }};
            }
            return {};
          }
        };
        window.ChatToolSecurity.manager.setMcpClient(client);
        window.ChatState.set('mcp', { status: 'connected', serverInfo: { name: 'ZeroChat', cwd: '/workspace' } });
        window.ChatToolSecurity.manager.applyPolicies({ directoryRules: ['RWX:/workspace/**'] });
      });
      await openSettings(page, 'agent');
      await page.locator('.switch:has([data-tool-id="search_web"])').click();
      assert.notEqual(await page.evaluate(() => window.ChatConfig.getActive().enabledTools.search_web), false, 'El interruptor espera a Guardar');

      await openSettings(page, 'permissions');
      assert.equal(await page.isChecked('#mcp-allow-all'), false);
      assert.equal(await page.inputValue('#mcp-directory-rules'), 'RWX:/workspace/**', 'El campo arranca con la regla editable del proyecto');
      await page.fill('#mcp-directory-rules', 'R:/workspace/**\nW:/tmp\n\n');
      await page.locator('.switch:has(#mcp-allow-all)').click();
      await openSettings(page, 'model');
      await page.fill('#setting-system-data-prompt', 'Datos propios');
      await page.click('#btn-save-settings');
      await page.waitForFunction(() => !document.getElementById('settings-dialog').open);
      assert.deepEqual(await page.evaluate(() => ({
        rules: window.ChatToolSecurity.manager.getDirectoryRules(),
        allowAll: window.ChatToolSecurity.manager.getAllowAll(),
        dataPrompt: window.ChatConfig.getActive().systemDataPrompt,
        searchWeb: window.ChatConfig.getActive().enabledTools.search_web
      })), { rules: ['R:/workspace/**', 'W:/tmp'], allowAll: true, dataPrompt: 'Datos propios', searchWeb: false });

      await openSettings(page, 'permissions');
      assert.equal(await page.locator('#mcp-directory-rules-project').isVisible(), true);
      assert.equal(await page.textContent('#mcp-directory-rules-project'), 'Proyecto: workspace');
      assert.equal(await page.textContent('#sidebar-settings-project-label'), 'Proyecto: workspace');
      assert.equal(await page.textContent('#settings-project-badge'), 'Proyecto: workspace');
      assert.equal(await page.getAttribute('#mcp-directory-rules-project', 'title'), '/workspace');
      assert.equal(await page.inputValue('#mcp-directory-rules'), 'R:/workspace/**\nW:/tmp', 'El campo muestra las reglas guardadas editables');

      assert.deepEqual(
        await page.$$eval('.sidebar-settings-project-group .sidebar-settings-item', els => els.map(el => el.dataset.section)),
        ['model', 'agent', 'mcp', 'browser', 'permissions'],
        'El bloque de proyecto agrupa exactamente las cinco secciones de proyecto'
      );
      assert.equal(await page.locator('.sidebar-settings-project-group [data-section="encryption"]').count(), 0);
      assert.equal(await page.locator('.sidebar-settings-project-group [data-section="rag"]').count(), 0);

      // En una sección global como Conexión, el distintivo de proyecto en cabecera se oculta.
      await page.click('#btn-close-settings');
      await page.waitForFunction(() => !document.getElementById('settings-dialog').open);
      await page.click('#btn-sidebar-back-to-chats');
      await page.click('#btn-open-connection');
      await page.waitForFunction(() => {
        const dlg = document.getElementById('settings-dialog');
        return dlg && dlg.open && document.getElementById('settings-connection')?.classList.contains('active');
      });
      assert.equal(await page.locator('#settings-project-badge').isVisible(), false);
      await page.click('#btn-close-settings');
      await page.waitForFunction(() => !document.getElementById('settings-dialog').open);

      // Simular cambio de directorio del proyecto
      await page.evaluate(() => {
        window.ChatState.set('mcp', { status: 'connected', serverInfo: { name: 'ZeroChat', cwd: '/workspace-nuevo' } });
        window.ChatToolSecurity.manager.applyPolicies({ directoryRules: ['RWX:/workspace-nuevo/**'] });
      });
      await openSettings(page, 'permissions');
      assert.equal(await page.textContent('#mcp-directory-rules-project'), 'Proyecto: workspace-nuevo');
      assert.equal(await page.textContent('#sidebar-settings-project-label'), 'Proyecto: workspace-nuevo');
      assert.equal(await page.textContent('#settings-project-badge'), 'Proyecto: workspace-nuevo');
      assert.equal(await page.getAttribute('#mcp-directory-rules-project', 'title'), '/workspace-nuevo');
      assert.equal(await page.inputValue('#mcp-directory-rules'), 'RWX:/workspace-nuevo/**', 'La regla del proyecto cambia tras cambio de directorio');

      await page.fill('#mcp-directory-rules', 'Z:/invalid');
      await page.click('#btn-save-settings');
      await page.waitForFunction(() => document.getElementById('mcp-directory-rules-error').textContent !== '');
      const errText = await page.textContent('#mcp-directory-rules-error');
      assert.match(errText, /Invalid directory rule/, 'El error del backend se muestra en el formulario');
      assert.equal(await page.evaluate(() => document.getElementById('settings-dialog').open), true, 'Una regla inválida no cierra los ajustes');
    });
  });

  test('Browser UI - el token de la extensión solo muestra si está guardado y se guarda o borra al momento', async () => {
    await withTestApp({ viewport: { width: 1280, height: 800 } }, async page => {
      page.setDefaultTimeout(5000);
      await page.evaluate(() => {
        window.__tokenCalls = [];
        window.__prompts = ['mal token!', 'PLAYWRIGHT_MCP_EXTENSION_TOKEN="tok_1"'];
        window.ChatDialogs.prompt = async (message, value, options) => { window.__promptType = options.inputType; return window.__prompts.shift(); };
        window.ChatDialogs.confirm = async () => true;
        window.ChatMCP.manager.clients.set('mcp_proxy', {
          async request(method, params) {
            if (method === 'zerochat/browser/engines/list') {
              return { config: { mode: 'own', engine: 'chromium', userBrowser: 'chrome', headless: true, userAgentMode: 'auto', userAgent: '' }, extensionTokenConfigured: false, engines: [{ id: 'chromium', installed: true }], systemBrowsers: { chrome: true }, extensions: {} };
            }
            if (method === 'zerochat/browser/extension_token/set') {
              window.__tokenCalls.push(params.token);
              return { extensionTokenConfigured: params.token !== null };
            }
            return {};
          }
        });
        window.ChatState.set('mcp', { status: 'connected', serverInfo: { name: 'ZeroChat', cwd: '/p' }, playwright: { installed: true, browserAction: { available: true } } });
      });
      await openSettings(page, 'browser');
      await page.locator('input[name="browser-tool"][value="playwright"]').check();
      const badge = '[data-browser-action="token-set"] >> xpath=preceding-sibling::span[@role="status"]';
      assert.equal(await page.textContent(badge), 'Sin guardar');
      assert.equal(await page.locator('[data-browser-action="token-delete"]').count(), 0);

      await page.click('[data-browser-action="token-set"]');
      await page.waitForSelector('#settings-browser .status-error');
      assert.match(await page.textContent('#settings-browser .status-error'), /letras, cifras/, 'un token no válido no se envía');
      await page.click('[data-browser-action="token-set"]');
      await page.waitForSelector('[data-browser-action="token-delete"]');
      assert.equal(await page.textContent(badge), 'Guardado');
      assert.doesNotMatch(await page.innerHTML('#settings-browser'), /tok_1/, 'el token no queda en la página');

      await page.click('[data-browser-action="token-delete"]');
      await page.waitForFunction(() => !document.querySelector('[data-browser-action="token-delete"]'));
      assert.deepEqual(await page.evaluate(() => [window.__promptType, window.__tokenCalls]), ['password', ['tok_1', null]]);
    });
  });

  test('Browser UI - un error al guardar navegador no persiste permisos parciales y un fallo en MCP revierte el interruptor', async () => {
    await withTestApp({ viewport: { width: 1280, height: 800 } }, async page => {
      page.setDefaultTimeout(5000);
      await page.evaluate(() => {
        window.__securityUpdateCalls = 0;
        window.ChatMCP.manager.clients.set('mcp_proxy', {
          async request(method) {
            if (method === 'zerochat/security/update') {
              window.__securityUpdateCalls += 1;
              return { policies: { allowAll: false, tools: {}, servers: {}, directoryRules: ['RWX:/p/**'], commandPatterns: { global: [], project: [], session: [] } } };
            }
            if (method === 'zerochat/browser/engines/list') {
              return { config: { mode: 'own', engine: 'chromium', userBrowser: 'chrome', headless: true, userAgentMode: 'auto', userAgent: '' }, extensionTokenConfigured: false, engines: [{ id: 'chromium', installed: true }], systemBrowsers: { chrome: true }, extensions: {} };
            }
            if (method === 'zerochat/project/environment/set') {
              window.__envSetFailed = true;
              throw new Error('backend save failed');
            }
            return {};
          }
        });
        window.ChatToolSecurity.manager.setMcpClient(window.ChatMCP.manager.clients.get('mcp_proxy'));
        window.ChatState.set('mcp', {
          status: 'connected',
          serverInfo: { name: 'ZeroChat', cwd: '/p' },
          playwright: { installed: true, browserAction: { available: true } },
          tools: [{ name: 'mcp_demo_read', description: 'Lee', defaultEnabled: true, inputSchema: { type: 'object', properties: {} }, metadata: { mcpServerName: 'demo', originalName: 'read' } }]
        });
        window.ChatToolSecurity.manager.applyPolicies({ allowAll: false, directoryRules: ['RWX:/p/**'] });
      });

      // Cambiar permiso + User-Agent personalizado vacío en Navegador: no debe enviar zerochat/security/update.
      await openSettings(page, 'permissions');
      await page.fill('#mcp-directory-rules', 'R:/p/**');
      await openSettings(page, 'browser');
      await page.locator('input[name="browser-tool"][value="playwright"]').check();
      await page.selectOption('#browser-user-agent-mode', 'custom');
      await page.click('#btn-save-settings');
      assert.equal(await page.evaluate(() => document.getElementById('settings-dialog').open), true);
      assert.equal(await page.evaluate(() => window.__securityUpdateCalls), 0, 'Permisos no se guardan si Navegador falla validación');

      // Fallo al persistir interruptor en Ajustes › MCP revierte estado y checkbox.
      await openSettings(page, 'mcp');
      await page.locator('#mcp-tools-container .mcp-tool-card input[type="checkbox"]').first().evaluate(input => input.click());
      await page.waitForFunction(() => window.__envSetFailed && document.querySelector('#mcp-tools-container .mcp-tool-card input[type="checkbox"]')?.checked === true && window.ChatConfig.getActive().enabledTools.mcp_demo_read === undefined);
    });
  });
});
