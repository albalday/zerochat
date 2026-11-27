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
      const mockClient = {
        // Como el backend, fija grantedAt al conceder.
        async request(method, patch) {
          const tools = { ...window.ChatToolSecurity.manager.policies.tools };
          if (patch?.tools) {
            for (const [id, val] of Object.entries(patch.tools)) {
              if (val === null) delete tools[id];
              else tools[id] = { ...val, grantedAt: Date.now() };
            }
          }
          const servers = { ...window.ChatToolSecurity.manager.policies.servers };
          if (patch?.servers) {
            for (const [id, val] of Object.entries(patch.servers)) {
              if (val === null) delete servers[id];
              else servers[id] = { ...val, grantedAt: Date.now() };
            }
          }
          return {
            policies: {
              allowAll: patch?.allowAll ?? window.ChatToolSecurity.manager.policies.allowAll,
              directoryRules: patch?.directoryRules || window.ChatToolSecurity.manager.policies.directoryRules,
              tools,
              servers,
              commandPatterns: patch?.commandPatterns
                ? { global: [], project: [], ...patch.commandPatterns, session: window.ChatToolSecurity.manager.policies.commandPatterns.session }
                : window.ChatToolSecurity.manager.policies.commandPatterns
            }
          };
        }
      };
      window.ChatToolSecurity.manager.setMcpClient(mockClient);
      window.ChatState.set('mcp', current => ({ ...current, tools: [], externalTools: [], externalServers: [], ...mcp }));
      window.mcpElements = () => {
        const byId = id => document.getElementById(id);
        return {
          statusBadge: byId('mcp-status-badge'),
          statusText: byId('mcp-status-text'),
          serverDetails: byId('mcp-server-details'),
          commandSnippet: byId('mcp-terminal-command'),
          btnCopyCmd: byId('btn-mcp-copy-cmd'),
          bootstrapCard: byId('mcp-bootstrap-card'),
          serversCard: byId('mcp-servers-card'),
          serversCounter: byId('mcp-servers-counter'),
          localToolsCard: byId('mcp-local-tools-card'),
          localToolsCounter: byId('mcp-local-tools-counter'),
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
          commandMatches: elements.commandSnippet.textContent === window.ChatUIMcp.generateTerminalCommand()
        };
      }, state);

      const disconnected = await render({ status: 'disconnected' });
      assert.equal(disconnected.badge, 'mcp-status-badge mcp-status-disconnected');
      assert.equal(disconnected.text, 'Desconectado');
      assert.equal(disconnected.i18n, 'mcp_status_disconnected');
      assert.equal(disconnected.detailsHidden, true);
      assert.equal(disconnected.bootstrapHidden, false);
      assert.equal(disconnected.commandMatches, true, 'initMcpUI publica el comando de arranque');

      const connecting = await render({ status: 'connecting' });
      assert.equal(connecting.text, 'Conectando...');

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

      // Conectado, la lista de herramientas locales se pinta desde state.tools (excluyendo externalTools) y la configuración activa.
      const listed = await page.evaluate(tools => {
        const container = document.getElementById('mcp-tools-container');
        const card = document.getElementById('mcp-local-tools-card');
        window.ChatConfig.updateRuntime({ enabledTools: { ...window.ChatConfig.getActive().enabledTools, list_directory: true, read_file: false, run_command: true } });
        window.ChatState.set('mcp', current => ({
          ...current,
          status: 'connected',
          tools,
          externalTools: [{ id: 'brave_search', name: 'brave_search', description: 'Externa', metadata: { mcpServerId: 'brave', mcpServerName: 'Brave', originalName: 'search' } }]
        }));
        return {
          cardHidden: card.hidden,
          cardTag: card.tagName,
          title: card.querySelector('summary').textContent,
          counter: document.getElementById('mcp-local-tools-counter').textContent,
          hasExternalInLocal: Boolean(container.querySelector('[data-tool-id="brave_search"]')),
          params: container.querySelector('[data-tool-id="read_file"] .mcp-tool-params').textContent,
          readChecked: container.querySelector('.mcp-tool-checkbox[data-tool-id="read_file"]').checked
        };
      }, TOOLS);
      assert.equal(listed.cardHidden, false);
      assert.equal(listed.cardTag, 'DETAILS');
      assert.match(listed.title, /Herramientas locales del servidor/);
      assert.match(listed.counter, /3 herramientas/);
      assert.equal(listed.hasExternalInLocal, false, 'Las herramientas de servidores externos no van en la lista local');
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
      await page.evaluate(async tools => {
        await window.ChatToolSecurity.manager.setToolPolicy('mcp_test_tool_2', 'allow', { serverName: 'srv1', originalName: 'tool2' });
        window.ChatUIMcp.renderToolsList(document.getElementById('mcp-tools-container'), tools, {});
      }, tools);
      assert.equal(await select('mcp_test_tool_2').inputValue(), 'allow');

      await select('mcp_test_tool_1').evaluate(element => { element.value = 'allow'; element.dispatchEvent(new Event('change', { bubbles: true })); });
      await page.waitForFunction(() => window.ChatToolSecurity.manager.getToolPolicy('mcp_test_tool_1') === 'allow');
      assert.equal(await page.evaluate(() => window.ChatToolSecurity.manager.getToolPolicy('mcp_test_tool_1')), 'allow');
      assert.equal(await select('mcp_test_tool_1').evaluate(element => element.classList.contains('status-allowed')), true);

      await select('mcp_test_tool_2').evaluate(element => { element.value = 'ask'; element.dispatchEvent(new Event('change', { bubbles: true })); });
      await page.waitForFunction(() => window.ChatToolSecurity.manager.getToolPolicy('mcp_test_tool_2') === null);
      assert.equal(await page.evaluate(() => window.ChatToolSecurity.manager.getToolPolicy('mcp_test_tool_2')), null);
      assert.equal(await select('mcp_test_tool_2').evaluate(element => element.classList.contains('status-ask')), true);

      const projectAll = await page.evaluate(async tools => {
        await window.ChatToolSecurity.manager.setAllowAll(true);
        const container = document.getElementById('mcp-tools-container');
        window.ChatUIMcp.renderToolsList(container, tools, {});
        const text = container.textContent;
        await window.ChatToolSecurity.manager.setAllowAll(false);
        return text;
      }, tools);
      assert.match(projectAll, /\(Proyecto\)/);

      const revoke = await page.evaluate(() => {
        window.ChatToolSecurity.manager.applyPolicies({
          tools: { mcp_compact_revoke_test: { policy: 'allow', scope: 'permanent', originalName: 'compact revoke test' } },
          servers: { srv_session: { policy: 'allow', scope: 'session', serverName: 'srv_session' } }
        });
        window.ChatUIMcp.renderSavedAuthorizations();
        const scopes = [...document.querySelectorAll('#mcp-saved-auths-list .mcp-auth-scope-badge')].map(el => el.textContent.trim());
        const button = document.querySelector('#mcp-saved-auths-list .btn-revoke-auth');
        const shape = { title: button.title, aria: button.getAttribute('aria-label'), icon: Boolean(button.querySelector('.ui-icon')), text: button.textContent.trim() };
        button.click();
        return { ...shape, scopes };
      });
      assert.deepEqual(revoke, { title: 'Revocar', aria: 'Revocar', icon: true, text: '', scopes: ['Sesión', 'Global'] });
      await page.waitForFunction(() => window.ChatToolSecurity.manager.getToolPolicy('mcp_compact_revoke_test') === null);
      await page.evaluate(() => window.ChatToolSecurity.manager.revokeServerPolicy('srv_session'));
    });
  });

  test('Browser UI - los patrones de comando guardados se quitan y añaden uno a uno y los rechazos se muestran', async () => {
    await withMcpPanel({ status: 'connected', tools: [], serverInfo: { cwd: '/home/yo/app' } }, async page => {
      const patterns = () => page.evaluate(() => window.ChatToolSecurity.manager.getCommandPatterns().global);
      const chips = () => page.$$eval('#mcp-saved-auths-list .mcp-auth-cmd-chip code', els => els.map(el => el.textContent));
      const removePattern = pattern => page.evaluate(p => document.querySelector(`#mcp-saved-auths-list .btn-remove-cmd-pattern[data-pattern="${p}"]`).click(), pattern);
      await page.evaluate(() => {
        window.ChatToolSecurity.manager.applyPolicies({
          commandPatterns: { global: ['git status *', 'git diff'], project: ['npm test *'], session: ['make *'] }
        });
        window.ChatUIMcp.renderSavedAuthorizations();
      });
      // Agrupados por alcance: todos los proyectos, proyecto actual y sesión (esta sin botón de quitar)
      assert.deepEqual(await chips(), ['git status *', 'git diff', 'npm test *', 'make *']);
      assert.deepEqual(await page.$$eval('#mcp-saved-auths-list .mcp-auth-cmd-scope', els => els.map(el => [el.textContent.trim(), el.title])),
        [['Todos los proyectos', 'Todos los proyectos'], ['Este proyecto (app)', '/home/yo/app'], ['Sesión', await page.evaluate(() => window.ChatI18n.t('tool_auth_cmd_session_title'))]]);
      assert.equal(await page.$$eval('#mcp-saved-auths-list .btn-remove-cmd-pattern', els => els.length), 3);

      await page.evaluate(() => {
        document.querySelector('#mcp-saved-auths-list .mcp-auth-cmd-input').value = 'git log *';
        document.querySelector('#mcp-saved-auths-list .btn-add-cmd-pattern').click();
      });
      await page.waitForFunction(() => window.ChatToolSecurity.manager.getCommandPatterns().global.length === 3);
      assert.deepEqual(await patterns(), ['git status *', 'git diff', 'git log *']);

      await removePattern('git diff');
      await page.waitForFunction(() => window.ChatToolSecurity.manager.getCommandPatterns().global.length === 2);
      assert.deepEqual(await patterns(), ['git status *', 'git log *']);

      // Quitar un patrón de proyecto no toca los globales
      await page.evaluate(() => document.querySelector('#mcp-saved-auths-list .btn-remove-cmd-pattern[data-scope="project"]').click());
      await page.waitForFunction(() => !window.ChatToolSecurity.manager.getCommandPatterns().project.length);
      assert.deepEqual(await patterns(), ['git status *', 'git log *']);

      // Un rechazo del backend se muestra junto al editor sin cambiar nada
      const enterKept = await page.evaluate(() => {
        const manager = window.ChatToolSecurity.manager;
        window.__originalRequest = manager.mcpClient.request;
        manager.mcpClient.request = async () => { throw new Error('Patrón de comando no válido'); };
        const input = document.querySelector('#mcp-saved-auths-list .mcp-auth-cmd-input');
        input.value = 'git; rm';
        const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
        input.dispatchEvent(enter);
        return enter.defaultPrevented;
      });
      assert.equal(enterKept, true, 'Enter debe quedarse en el editor y no enviar los ajustes');
      await page.waitForFunction(() => !document.querySelector('#mcp-saved-auths-list .mcp-auth-cmd-error').hidden);
      const shown = await page.evaluate(() => {
        window.ChatToolSecurity.manager.mcpClient.request = window.__originalRequest;
        return document.querySelector('#mcp-saved-auths-list .mcp-auth-cmd-error').textContent;
      });
      assert.equal(shown, 'Patrón de comando no válido');
      assert.deepEqual(await patterns(), ['git status *', 'git log *']);

      // El alta elige el alcance: el proyecto actual guarda el patrón en project
      await page.evaluate(() => {
        const editor = document.querySelector('#mcp-saved-auths-list .mcp-auth-cmd-add');
        editor.querySelector('.mcp-auth-cmd-scope-select').value = 'project';
        editor.querySelector('.mcp-auth-cmd-input').value = 'npm test *';
        editor.querySelector('.btn-add-cmd-pattern').click();
      });
      await page.waitForFunction(() => window.ChatToolSecurity.manager.getCommandPatterns().project.length === 1);
      assert.deepEqual(await page.evaluate(() => window.ChatToolSecurity.manager.getCommandPatterns().project), ['npm test *']);
      assert.deepEqual(await patterns(), ['git status *', 'git log *']);
    });
  });

  test('Browser UI - los servidores externos muestran tarjetas con estado, ayuda, origen remoto sin secretos y aviso de Ajustes › Navegador', async () => {
    await withMcpPanel({}, async page => {
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
      assert.match(result.playwright, /se configura en Ajustes › Navegador/);
    });
  });

  test('Browser UI - cada servidor externo agrupa sus herramientas en su tarjeta plegable, preserva su estado abierto tras re-render y guarda políticas/interruptores', async () => {
    const externalServers = [
      { id: 'brave', displayName: { es: 'Brave Search' }, description: { es: 'Búsqueda web' }, status: 'running', toolCount: 2 },
      { id: 'mail', displayName: { es: 'Correo' }, status: 'error', error: 'Falta contraseña', toolCount: 0 }
    ];
    const externalTools = [
      { id: 'brave_web_search', name: 'brave_web_search', description: 'Busca en la web', defaultEnabled: true, inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }, metadata: { mcpServerId: 'brave', mcpServerName: 'Brave Search', originalName: 'web_search' } },
      { id: 'brave_news_search', name: 'brave_news_search', description: 'Busca noticias', defaultEnabled: false, inputSchema: { type: 'object', properties: {} }, metadata: { mcpServerId: 'brave', mcpServerName: 'Brave Search', originalName: 'news_search' } }
    ];
    await withMcpPanel({ status: 'connected', tools: TOOLS, externalServers, externalTools }, async page => {
      const initial = await page.evaluate(() => {
        const serversCounter = document.getElementById('mcp-servers-counter').textContent;
        const braveCard = document.querySelector('#mcp-servers-list details.mcp-server-item[data-server-id="brave"]');
        const mailCard = document.querySelector('#mcp-servers-list details.mcp-server-item[data-server-id="mail"]');
        const toolsDetails = braveCard.querySelector('details.mcp-server-tools-details[data-server-tools-id="brave"]');
        const names = [...braveCard.querySelectorAll('.mcp-tool-name')].map(el => el.textContent);
        const localHasBrave = Boolean(document.querySelector('#mcp-tools-container [data-tool-id="brave_web_search"]'));
        return {
          serversCounter,
          braveOpen: braveCard.open,
          mailOpen: mailCard.open,
          toolsHeading: toolsDetails.querySelector('summary').textContent.trim(),
          names,
          localHasBrave
        };
      });
      assert.equal(initial.serversCounter, '1 activos / 2');
      assert.equal(initial.braveOpen, false, 'Un servidor sin error empieza plegado');
      assert.equal(initial.mailOpen, true, 'Un servidor con error se abre automáticamente');
      assert.equal(initial.toolsHeading, 'Herramientas (1/2 activas)');
      assert.deepEqual(initial.names, ['web_search', 'news_search'], 'Muestra el nombre original corto dentro de su servidor');
      assert.equal(initial.localHasBrave, false, 'Las herramientas externas no aparecen en la lista local');

      // Abrir la tarjeta de Brave y su subsección de herramientas; un re-render del latido debe preservar ambos abiertos.
      await page.evaluate(() => {
        const braveCard = document.querySelector('#mcp-servers-list details.mcp-server-item[data-server-id="brave"]');
        braveCard.open = true;
        braveCard.querySelector('details.mcp-server-tools-details').open = true;
        window.ChatState.set('mcp', current => ({ ...current, latencyMs: 22 }));
      });
      const afterHeartbeat = await page.evaluate(() => {
        const braveCard = document.querySelector('#mcp-servers-list details.mcp-server-item[data-server-id="brave"]');
        return {
          serverOpen: braveCard.open,
          toolsOpen: braveCard.querySelector('details.mcp-server-tools-details').open
        };
      });
      assert.deepEqual(afterHeartbeat, { serverOpen: true, toolsOpen: true });

      // Cambiar interruptor y política de una herramienta anidada en la tarjeta del servidor.
      await page.locator('#mcp-servers-list .mcp-tool-checkbox[data-tool-id="brave_news_search"]').evaluate(input => input.click());
      await page.locator('#mcp-servers-list .mcp-auth-select[data-tool-id="brave_web_search"]').evaluate(el => {
        el.value = 'allow';
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.waitForFunction(() => window.ChatToolSecurity.manager.getToolPolicy('brave_web_search') === 'allow');
      const updated = await page.evaluate(() => ({
        newsEnabled: window.ChatConfig.getActive().enabledTools.brave_news_search,
        webPolicy: window.ChatToolSecurity.manager.getToolPolicy('brave_web_search'),
        serverStillOpen: document.querySelector('#mcp-servers-list details.mcp-server-item[data-server-id="brave"]').open
      }));
      assert.deepEqual(updated, { newsEnabled: true, webPolicy: 'allow', serverStillOpen: true });
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

  test('Browser UI - los secretos de un servicio muestran solo si están guardados y se guardan o borran desde un diálogo de contraseña', async () => {
    await withMcpPanel({}, async page => {
      await page.evaluate(() => {
        window.__secretCalls = [];
        window.ChatMCP.manager.setExternalServerSecret = async (...args) => { window.__secretCalls.push(args); };
        window.ChatDialogs.confirm = async () => true;
        window.__renderSecretCard = configured => window.ChatUIMcp.renderExternalServers(document.getElementById('mcp-servers-list'), [{
          id: 'brave', status: 'stopped', secrets: [{ name: 'BRAVE_API_KEY', label: { es: 'Clave de Brave Search' }, configured }]
        }]);
        window.__renderSecretCard(false);
      });
      const missing = await page.evaluate(() => ({
        status: document.querySelector('#mcp-servers-list .mcp-server-secret-status').textContent,
        canDelete: Boolean(document.querySelector('#mcp-servers-list .btn-mcp-secret-delete'))
      }));
      assert.deepEqual(missing, { status: 'Sin guardar', canDelete: false });

      await page.evaluate(() => document.querySelector('#mcp-servers-list .btn-mcp-secret-set').click());
      await page.waitForSelector('#notice-dialog[open] #notice-input');
      assert.equal(await page.locator('#notice-input').getAttribute('type'), 'password');
      await page.locator('#notice-input').fill('bsa-nueva');
      await page.locator('#notice-accept').click();
      await page.waitForFunction(() => window.__secretCalls.length === 1);

      await page.evaluate(() => window.__renderSecretCard(true));
      assert.equal(await page.textContent('#mcp-servers-list .mcp-server-secret-status'), 'Guardada');
      await page.evaluate(() => document.querySelector('#mcp-servers-list .btn-mcp-secret-delete').click());
      await page.waitForFunction(() => window.__secretCalls.length === 2);

      const { calls, markup } = await page.evaluate(() => ({
        calls: window.__secretCalls,
        markup: document.getElementById('mcp-servers-list').innerHTML
      }));
      assert.deepEqual(calls, [['brave', 'BRAVE_API_KEY', 'bsa-nueva'], ['brave', 'BRAVE_API_KEY', null]]);
      assert.doesNotMatch(markup, /bsa-nueva/);
    });
  });

});
