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
              if (params.directoryRules?.some(r => !/^(R|W|RW):/.test(r))) {
                throw new Error('Invalid directory rule. Use R:, W: or RW: followed by a path.');
              }
              const currentRules = params.directoryRules !== undefined ? params.directoryRules : window.ChatToolSecurity.manager.directoryRules;
              const currentPolicy = params.globalMcpPolicy !== undefined ? params.globalMcpPolicy : window.ChatToolSecurity.manager.globalMcpPolicy;
              return { policies: {
                directoryRules: currentRules,
                globalMcpPolicy: currentPolicy
              }};
            }
            return {};
          }
        };
        window.ChatToolSecurity.manager.setMcpClient(client);
      });
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
});
