const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const { withTestApp, closeGlobalBrowser } = require('../helpers/browser-env.js');

// Panel MCP de ajustes tal como lo monta app.js (initMcpUI), sin servidor local: el estado MCP y los
// métodos de ChatMCP.manager que llegarían al servidor se fijan en cada prueba.

/** Página de la aplicación con el estado MCP indicado; devuelve los textos que necesita la prueba. */
async function withMcpPanel(mcp, fn) {
  await withTestApp(async page => {
    page.setDefaultTimeout(5000);
    await page.evaluate(mcp => {
      window.ChatState.set('mcp', current => ({ ...current, tools: [], externalTools: [], externalServers: [], ...mcp }));
      window.mcpElements = () => {
        const byId = id => document.getElementById(id);
        return {
          statusBadge: byId('mcp-status-badge'),
          statusText: byId('mcp-status-text'),
          serverDetails: byId('mcp-server-details'),
          reconnectHint: byId('mcp-reconnect-hint'),
          commandSnippet: byId('mcp-terminal-command'),
          btnCopyCmd: byId('btn-mcp-copy-cmd'),
          bootstrapCard: byId('mcp-bootstrap-card'),
          toolsContainer: byId('mcp-tools-container'),
          serversList: byId('mcp-servers-list')
        };
      };
    }, mcp);
    await fn(page);
  });
}

const TOOLS = [
  { id: 'list_directory', name: 'list_directory', description: 'Lista un directorio', inputSchema: { type: 'object', properties: { path: { type: 'string' } } }, metadata: {} },
  { id: 'read_file', name: 'read_file', description: 'Lee un archivo', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }, metadata: {} },
  { id: 'run_command', name: 'run_command', description: 'Ejecuta comandos', inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }, metadata: {} }
];

describe('Browser UI - panel MCP', { concurrency: 2 }, () => {
  after(async () => {
    await closeGlobalBrowser();
  });

  test('Browser UI - el estado de conexión actualiza insignia, guía de arranque y detalles, y sobrevive a las traducciones', async () => {
    await withMcpPanel({}, async page => {
      const render = state => page.evaluate(state => {
        const elements = window.mcpElements();
        window.ChatUIMcp.renderConnectionStatus(elements, { ...window.ChatState.get('mcp'), ...state });
        return {
          badge: elements.statusBadge.className,
          text: elements.statusText.textContent,
          i18n: elements.statusText.getAttribute('data-i18n'),
          detailsHidden: elements.serverDetails.hidden,
          detailsTitle: elements.serverDetails.title,
          details: elements.serverDetails.textContent,
          bootstrapHidden: elements.bootstrapCard.hidden,
          hintHidden: elements.reconnectHint.hidden,
          hint: elements.reconnectHint.textContent,
          commandMatches: elements.commandSnippet.textContent === window.ChatUIMcp.generateTerminalCommand()
        };
      }, state);

      const disconnected = await render({ status: 'disconnected' });
      assert.equal(disconnected.badge, 'mcp-status-badge mcp-status-disconnected');
      assert.equal(disconnected.text, 'Desconectado');
      assert.equal(disconnected.i18n, 'mcp_status_disconnected');
      assert.equal(disconnected.detailsHidden, true);
      assert.equal(disconnected.bootstrapHidden, false);
      assert.equal(disconnected.hintHidden, false);
      assert.equal(disconnected.hint, 'Si el servidor se ha reiniciado, recarga esta página (F5) para volver a conectar.');
      assert.equal(disconnected.commandMatches, true, 'initMcpUI publica el comando de arranque');

      const connecting = await render({ status: 'connecting' });
      assert.equal(connecting.text, 'Conectando...');
      assert.equal(connecting.hintHidden, true);

      const connected = await render({ status: 'connected', serverInfo: { name: 'zerochat', version: '0.4.0' }, latencyMs: 15, tools: [{ id: 't1', name: 't1', metadata: {} }, { id: 't2', name: 't2', metadata: {} }] });
      assert.equal(connected.text, 'Conectado');
      assert.equal(connected.detailsHidden, false);
      assert.equal(connected.bootstrapHidden, true);
      assert.ok(connected.detailsTitle.includes('zerochat v0.4.0') && connected.detailsTitle.includes('15ms'));
      assert.ok(connected.details.includes('2 herramientas'));

      // Volver a aplicar las traducciones del documento no revierte el estado de la conexión.
      const translated = await page.evaluate(() => {
        window.ChatState.set('mcp', current => ({ ...current, status: 'connected', serverInfo: { name: 'zerochat', version: '1.0' }, tools: [{ id: 'x', name: 'x', metadata: {} }] }));
        window.ChatI18n.applyTranslations(document);
        const text = document.getElementById('mcp-status-text');
        const afterApply = [text.textContent, text.getAttribute('data-i18n')];
        window.ChatI18n.setLanguage('en');
        const english = text.textContent;
        window.ChatI18n.setLanguage('es');
        return { afterApply, english };
      });
      assert.deepEqual(translated, { afterApply: ['Conectado', 'mcp_status_connected'], english: 'Connected' });

      const error = await render({ status: 'error', error: 'Conexión rechazada' });
      assert.equal(error.text, 'Error de conexión');
      assert.equal(error.bootstrapHidden, false);

      // El panel sigue los cambios del estado sin que nadie lo pinte a mano.
      await page.evaluate(() => window.ChatState.set('mcp', current => ({ ...current, status: 'connected', serverInfo: { name: 'zerochat' } })));
      assert.equal(await page.textContent('#mcp-status-text'), 'Conectado');
    });
  });

  test('Browser UI - la lista de herramientas muestra el estado vacío y sus interruptores actualizan la configuración', async () => {
    await withMcpPanel({ status: 'disconnected' }, async page => {
      const empty = await page.evaluate(() => {
        const container = document.getElementById('mcp-tools-container');
        window.ChatUIMcp.renderToolsList(container, [], {});
        return { empty: Boolean(container.querySelector('.mcp-tools-empty')), text: container.textContent };
      });
      assert.equal(empty.empty, true);
      assert.match(empty.text, /ejecute localmente/);

      // Conectado, la lista se pinta desde el estado MCP y la configuración activa.
      const listed = await page.evaluate(tools => {
        const container = document.getElementById('mcp-tools-container');
        window.ChatConfig.updateRuntime({ enabledTools: { ...window.ChatConfig.getActive().enabledTools, list_directory: true, read_file: false, run_command: true } });
        window.ChatState.set('mcp', current => ({ ...current, status: 'connected', tools }));
        return {
          header: Boolean(container.querySelector('.mcp-tools-header')),
          text: container.textContent,
          params: container.querySelector('[data-tool-id="read_file"] .mcp-tool-params').textContent,
          readChecked: container.querySelector('.mcp-tool-checkbox[data-tool-id="read_file"]').checked
        };
      }, TOOLS);
      assert.equal(listed.header, true);
      assert.match(listed.text, /Herramientas Disponibles del Sistema/);
      assert.match(listed.text, /3 detectadas/);
      assert.match(listed.params, /path: string/);
      assert.equal(listed.readChecked, false);

      await page.locator('.mcp-tool-checkbox[data-tool-id="run_command"]').evaluate(input => input.click());
      await page.locator('.mcp-tool-checkbox[data-tool-id="read_file"]').evaluate(input => input.click());
      assert.deepEqual(await page.evaluate(() => {
        const enabled = window.ChatConfig.getActive().enabledTools;
        return [enabled.run_command, enabled.read_file];
      }), [false, true]);
    });
  });

  test('Browser UI - los selectores de autorización actualizan las políticas y las revocaciones son botones accesibles', async () => {
    const tools = [
      { id: 'mcp_test_tool_1', name: 'mcp_test_tool_1', metadata: { mcpServerName: 'srv1', originalName: 'tool1' } },
      { id: 'mcp_test_tool_2', name: 'mcp_test_tool_2', metadata: { mcpServerName: 'srv1', originalName: 'tool2' } }
    ];
    // Conectada: cada cambio de política repinta la lista desde el estado MCP.
    await withMcpPanel({ status: 'connected', tools }, async page => {
      const select = id => page.locator(`.mcp-auth-select[data-tool-id="${id}"]`);
      await page.evaluate(tools => {
        window.ChatToolSecurity.manager.setToolPolicy('mcp_test_tool_2', 'allow', { serverName: 'srv1', originalName: 'tool2' });
        window.ChatUIMcp.renderToolsList(document.getElementById('mcp-tools-container'), tools, {});
      }, tools);
      assert.equal(await select('mcp_test_tool_2').inputValue(), 'allow');

      await select('mcp_test_tool_1').evaluate(element => { element.value = 'allow'; element.dispatchEvent(new Event('change', { bubbles: true })); });
      assert.equal(await page.evaluate(() => window.ChatToolSecurity.manager.getToolPolicy('mcp_test_tool_1')), 'allow');
      assert.equal(await select('mcp_test_tool_1').evaluate(element => element.classList.contains('status-allowed')), true);

      await select('mcp_test_tool_2').evaluate(element => { element.value = 'ask'; element.dispatchEvent(new Event('change', { bubbles: true })); });
      assert.equal(await page.evaluate(() => window.ChatToolSecurity.manager.getToolPolicy('mcp_test_tool_2')), null);
      assert.equal(await select('mcp_test_tool_2').evaluate(element => element.classList.contains('status-ask')), true);

      const global = await page.evaluate(tools => {
        window.ChatToolSecurity.manager.setGlobalMcpPolicy('allow_all');
        const container = document.getElementById('mcp-tools-container');
        window.ChatUIMcp.renderToolsList(container, tools, {});
        const text = container.textContent;
        window.ChatToolSecurity.manager.setGlobalMcpPolicy('ask');
        return text;
      }, tools);
      assert.match(global, /\(Global\)/);

      const revoke = await page.evaluate(() => {
        window.ChatToolSecurity.manager.setToolPolicy('mcp_compact_revoke_test', 'allow', { originalName: 'compact revoke test' });
        window.ChatUIMcp.renderSavedAuthorizations();
        const button = document.querySelector('#mcp-saved-auths-list .btn-revoke-auth');
        const shape = { title: button.title, aria: button.getAttribute('aria-label'), icon: Boolean(button.querySelector('.ui-icon')), text: button.textContent.trim() };
        button.click();
        return { ...shape, policy: window.ChatToolSecurity.manager.getToolPolicy('mcp_compact_revoke_test') };
      });
      assert.deepEqual(revoke, { title: 'Revocar', aria: 'Revocar', icon: true, text: '', policy: null });
    });
  });

  test('Browser UI - los servidores externos muestran tarjetas con estado, ayuda, origen remoto sin secretos y aviso de browser_action', async () => {
    await withMcpPanel({ tools: [{ id: 'browser_action', name: 'browser_action', available: true, metadata: {} }] }, async page => {
      const result = await page.evaluate(() => {
        const list = document.getElementById('mcp-servers-list');
        window.ChatUIMcp.renderExternalServers(list, []);
        const empty = Boolean(list.querySelector('.mcp-servers-empty'));
        window.ChatUIMcp.renderExternalServers(list, [
          { id: 'ejemplo', displayName: { es: 'Ejemplo de MCP', en: 'MCP example' }, description: { es: 'Servidor de prueba' }, help: { url: 'help/mcp.html', label: { es: 'Guía del ejemplo' } }, status: 'stopped', toolCount: 0 },
          { id: 'sqlite', displayName: { es: 'SQLite' }, description: { es: 'Base de datos' }, status: 'running', toolCount: 2 },
          { id: 'composio', status: 'stopped', remote: { type: 'mcp-remote', url: 'https://connect.composio.dev/mcp?secret=must-not-be-rendered' } },
          { id: 'playwright', status: 'stopped' }
        ]);
        const card = id => list.querySelector(`.mcp-server-item[data-server-id="${id}"]`);
        return {
          empty,
          ejemplo: {
            text: card('ejemplo').textContent,
            help: card('ejemplo').querySelector('.mcp-server-help a').getAttribute('href'),
            stopped: Boolean(card('ejemplo').querySelector('.status-stopped')),
            toggle: card('ejemplo').querySelector('.btn-mcp-server-toggle').textContent
          },
          sqlite: {
            text: card('sqlite').textContent,
            running: Boolean(card('sqlite').querySelector('.status-running')),
            toggle: card('sqlite').querySelector('.btn-mcp-server-toggle').textContent
          },
          composio: { text: card('composio').textContent, markup: card('composio').innerHTML },
          playwright: card('playwright').textContent
        };
      });
      assert.equal(result.empty, true);
      assert.match(result.ejemplo.text, /Ejemplo de MCP/);
      assert.equal(result.ejemplo.help, 'help/mcp.html');
      assert.equal(result.ejemplo.stopped, true);
      assert.match(result.ejemplo.toggle, /Iniciar/);
      assert.equal(result.sqlite.running, true);
      assert.match(result.sqlite.toggle, /Detener/);
      assert.match(result.sqlite.text, /2 herramientas activas/);
      assert.match(result.composio.text, /MCP remoto HTTP/);
      assert.match(result.composio.text, /connect\.composio\.dev/);
      assert.doesNotMatch(result.composio.markup, /must-not-be-rendered/);
      assert.match(result.playwright, /browser_action está activa/);
    });
  });

  test('Browser UI - repintar las listas MCP no vuelve a enlazar eventos: cada acción se dispara una vez', async () => {
    await withMcpPanel({}, async page => {
      const counts = await page.evaluate(async () => {
        const counts = { policy: 0, start: 0 };
        const security = window.ChatToolSecurity.manager;
        const setToolPolicy = security.setToolPolicy.bind(security);
        security.setToolPolicy = (...args) => { counts.policy++; return setToolPolicy(...args); };
        window.ChatMCP.manager.startExternalServer = async () => { counts.start++; };

        const tools = [{ id: 'mcp_once', name: 'mcp_once', metadata: { mcpServerName: 'srv', originalName: 'once' } }];
        const toolsContainer = document.getElementById('mcp-tools-container');
        window.ChatUIMcp.renderToolsList(toolsContainer, tools, {});
        window.ChatUIMcp.renderToolsList(toolsContainer, tools, {});
        const select = toolsContainer.querySelector('.mcp-auth-select');
        select.value = 'allow';
        select.dispatchEvent(new Event('change', { bubbles: true }));

        const serversList = document.getElementById('mcp-servers-list');
        window.ChatUIMcp.renderExternalServers(serversList, [{ id: 'ejemplo', status: 'stopped' }]);
        window.ChatUIMcp.renderExternalServers(serversList, [{ id: 'ejemplo', status: 'stopped' }]);
        serversList.querySelector('.btn-mcp-server-toggle').click();
        // Flush de macrotarea: deja ejecutar el callback asíncrono del mock.
        await new Promise(resolve => setTimeout(resolve, 0));
        return counts;
      });
      assert.deepEqual(counts, { policy: 1, start: 1 });
    });
  });

});
