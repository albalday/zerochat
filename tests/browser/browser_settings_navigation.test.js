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

  test('Browser UI - cambiar de proyecto aplica su entorno guardado y concilia arranque/parada de MCPs y Navegador', async () => {
    await withTestApp({ viewport: { width: 1280, height: 800 } }, async page => {
      page.setDefaultTimeout(5000);
      await page.evaluate(() => {
        window.__envEvents = [];
        window.__savedEnvs = {
          '/proj/a': {
            saved: true,
            systemDataPrompt: 'Instrucciones proyecto A',
            enabledTools: { search_web: false },
            mcpServers: ['memory'],
            browser: 'playwright',
            updatedAt: 100
          },
          '/proj/b': { saved: false, systemDataPrompt: null, enabledTools: {}, mcpServers: [], browser: 'browser_action', updatedAt: 0 }
        };
        const serverStates = { memory: 'stopped', playwright: 'stopped' };
        const listServers = () => [
          { id: 'memory', status: serverStates.memory, displayName: { es: 'Memoria' } },
          { id: 'playwright', status: serverStates.playwright, displayName: { es: 'Playwright' } }
        ];
        window.ChatMCP.manager.clients.set('mcp_proxy', {
          async request(method, params) {
            if (method === 'zerochat/project/set_directory') {
              const cwd = params.path;
              return {
                cwd,
                policies: { allowAll: false, tools: {}, servers: {}, directoryRules: [`RWX:${cwd}/**`], commandPatterns: { global: [], project: [], session: [] } },
                projectEnvironment: window.__savedEnvs[cwd] || window.__savedEnvs['/proj/b']
              };
            }
            if (method === 'zerochat/project/environment/set') {
              const cwd = window.ChatState.get('mcp').serverInfo?.cwd;
              window.__savedEnvs[cwd] = { ...(window.__savedEnvs[cwd] || {}), ...params, saved: true, updatedAt: Date.now() };
              return { projectEnvironment: window.__savedEnvs[cwd] };
            }
            if (method === 'zerochat/external/servers/start') {
              serverStates[params.serverId] = 'running';
              window.__envEvents.push(`start:${params.serverId}`);
              return { servers: listServers() };
            }
            if (method === 'zerochat/external/servers/stop') {
              serverStates[params.serverId] = 'stopped';
              window.__envEvents.push(`stop:${params.serverId}`);
              return { servers: listServers() };
            }
            if (method === 'tools/list') return { tools: [] };
            return {};
          }
        });
        window.ChatState.set('mcp', { status: 'connected', serverInfo: { name: 'ZeroChat', cwd: '/proj/init' }, externalServers: listServers() });
      });

      // Cambiar a /proj/a carga su entorno guardado y arranca memory + playwright.
      await page.evaluate(() => window.ChatMCP.manager.setProjectDirectory('/proj/a'));
      assert.deepEqual(await page.evaluate(() => ({
        prompt: window.ChatConfig.getActive().systemDataPrompt,
        searchWeb: window.ChatConfig.getActive().enabledTools.search_web,
        mcpServers: window.ChatConfig.getActive().mcpServers,
        browser: window.ChatConfig.getActive().browser,
        events: window.__envEvents
      })), {
        prompt: 'Instrucciones proyecto A',
        searchWeb: false,
        mcpServers: ['memory'],
        browser: 'playwright',
        events: ['start:memory', 'start:playwright']
      });

      // Cambiar a /proj/b (sin guardar) restablece valores por defecto y detiene memory y playwright.
      await page.evaluate(() => {
        window.__envEvents = [];
        return window.ChatMCP.manager.setProjectDirectory('/proj/b');
      });
      assert.deepEqual(await page.evaluate(() => ({
        matchesDefault: window.ChatConfig.getActive().systemDataPrompt === window.ChatConfig.DEFAULT_SYSTEM_DATA_PROMPT,
        mcpServers: window.ChatConfig.getActive().mcpServers,
        browser: window.ChatConfig.getActive().browser,
        events: window.__envEvents
      })), {
        matchesDefault: true,
        mcpServers: [],
        browser: 'browser_action',
        events: ['stop:memory', 'stop:playwright']
      });
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
              return { config: { mode: 'user', engine: 'chromium', userBrowser: 'chrome', headless: true, extensionToken: '' }, engines: [{ id: 'chromium', installed: true }], systemBrowsers: { chrome: true }, extensions: {} };
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

      // Cambiar permiso + token de extensión inválido en Navegador: no debe enviar zerochat/security/update.
      await openSettings(page, 'permissions');
      await page.fill('#mcp-directory-rules', 'R:/p/**');
      await openSettings(page, 'browser');
      await page.locator('input[name="browser-tool"][value="playwright"]').check();
      await page.fill('#browser-extension-token', 'token invalido!');
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
