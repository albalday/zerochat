const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ChatUIMcp = require('../../js/ui-mcp.js');
const ChatState = require('../../js/state.js');
const ChatI18n = require('../../js/i18n.js');
const ChatMCP = require('../../js/mcp.js');
const ChatConfig = require('../../js/config-store.js');
const ChatToolSecurity = require('../../js/tool-security.js');
const UISettings = require('../../js/ui-settings.js');
const Defaults = require('../../js/defaults.js');
const { installDom } = require('../helpers/dom-env.js');

/** DOM de la aplicación con el diálogo de ajustes montado y el estado MCP restaurado al terminar. */
function setup(t, mcp = {}) {
  const dom = installDom({ app: true });
  UISettings.ensureDialogMarkup();
  const previousState = ChatState.get('mcp');
  ChatState.set('mcp', { ...previousState, tools: [], externalTools: [], externalServers: [], ...mcp });
  t.after(() => {
    ChatState.set('mcp', previousState);
    ChatToolSecurity.manager.clearAllAuthorizations();
    ChatToolSecurity.manager.setGlobalMcpPolicy('ask');
    dom.restore();
  });
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
    serversList: byId('mcp-servers-list'),
    savedAuthsList: byId('mcp-saved-auths-list'),
    btnClearAuths: byId('btn-mcp-clear-auths'),
    directoryRules: byId('mcp-directory-rules'),
    directoryRulesError: byId('mcp-directory-rules-error'),
    policyRadios: {
      ask: byId('mcp-policy-ask'),
      workspace_trust: byId('mcp-policy-workspace-trust'),
      allow_all: byId('mcp-policy-allow-all')
    }
  };
}

/** Sección MCP montada con initMcpUI: los eventos se enlazan una vez, delegados en los contenedores. */
function mounted(t, mcp = {}) {
  const elements = setup(t, mcp);
  const ui = ChatUIMcp.initMcpUI(elements);
  t.after(() => ui.destroy());
  return elements;
}

test('ChatUIMcp - recomienda el arranque por PyPI según el sistema y el puerto de zerochat.py', () => {
  assert.equal(ChatUIMcp.generateTerminalCommand({ platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' }), 'pip install zerochat\nzerochat');
  assert.equal(ChatUIMcp.generateTerminalCommand({ platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }), 'pip install zerochat\nzerochat');
  assert.equal(ChatUIMcp.generateTerminalCommand({ platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }), 'py -m pip install zerochat\npy -m zerochat');
  assert.equal(ChatUIMcp.generateTerminalCommand({ userAgentData: { platform: 'Windows' }, platform: '' }), 'py -m pip install zerochat\npy -m zerochat');

  const serverSource = fs.readFileSync(path.join(__dirname, '../..', 'zerochat.py'), 'utf8');
  assert.match(serverSource, new RegExp(`DEFAULT_PORT\\s*=\\s*${Defaults.CONFIG_DEFAULTS.mcpPort}\\b`));
});

test('ChatUIMcp - renderConnectionStatus actualiza badge, guía de arranque y detalles', t => {
  const elements = setup(t);
  ChatUIMcp.renderConnectionStatus(elements, { ...ChatState.get('mcp'), status: 'disconnected' });
  assert.equal(elements.statusBadge.className, 'mcp-status-badge mcp-status-disconnected');
  assert.equal(elements.statusText.textContent, 'Desconectado');
  assert.equal(elements.statusText.getAttribute('data-i18n'), 'mcp_status_disconnected');
  assert.equal(elements.serverDetails.hidden, true);
  assert.equal(elements.bootstrapCard.hidden, false);
  assert.equal(elements.reconnectHint.hidden, false);
  assert.equal(elements.reconnectHint.textContent, 'Si el servidor se ha reiniciado, recarga esta página (F5) para volver a conectar.');
  assert.equal(elements.commandSnippet.textContent, ChatUIMcp.generateTerminalCommand());

  ChatUIMcp.renderConnectionStatus(elements, { ...ChatState.get('mcp'), status: 'connecting' });
  assert.equal(elements.statusText.textContent, 'Conectando...');
  assert.equal(elements.reconnectHint.hidden, true);

  ChatUIMcp.renderConnectionStatus(elements, {
    ...ChatState.get('mcp'),
    status: 'connected',
    serverInfo: { name: 'zerochat', version: '0.4.0' },
    latencyMs: 15,
    tools: [{ id: 't1', name: 't1', metadata: {} }, { id: 't2', name: 't2', metadata: {} }]
  });
  assert.equal(elements.statusText.textContent, 'Conectado');
  assert.equal(elements.serverDetails.hidden, false);
  assert.equal(elements.bootstrapCard.hidden, true);
  assert.ok(elements.serverDetails.title.includes('zerochat v0.4.0'));
  assert.ok(elements.serverDetails.title.includes('15ms'));
  assert.ok(elements.serverDetails.textContent.includes('2 herramientas'));

  ChatUIMcp.renderConnectionStatus(elements, { ...ChatState.get('mcp'), status: 'error', error: 'Conexión rechazada' });
  assert.equal(elements.statusText.textContent, 'Error de conexión');
  assert.equal(elements.bootstrapCard.hidden, false);
});

test('ChatUIMcp - incorpora herramientas externas al listado MCP', () => {
  const allTools = ChatUIMcp.getAllMcpTools({ tools: [{ name: 'read_file' }], externalTools: [{ name: 'mcp_composio_search' }] });
  assert.deepEqual(allTools.map(tool => tool.name), ['read_file', 'mcp_composio_search']);
});

test('ChatUIMcp - copyCommandToClipboard copia y muestra la confirmación en el botón', async t => {
  const elements = setup(t);
  const copied = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { copied.push(text); } } });
  assert.equal(await ChatUIMcp.copyCommandToClipboard('test command', elements.btnCopyCmd), true);
  assert.deepEqual(copied, ['test command']);
  assert.ok(elements.btnCopyCmd.classList.contains('copied'));
  assert.match(elements.btnCopyCmd.textContent, new RegExp(ChatI18n.t('mcp_cmd_copied')));
});

test('ChatUIMcp - initMcpUI publica el comando de arranque y sigue los cambios de estado', t => {
  const elements = setup(t);
  const ui = ChatUIMcp.initMcpUI(elements);
  t.after(() => ui.destroy());
  assert.equal(elements.commandSnippet.textContent, ChatUIMcp.generateTerminalCommand());
  ChatState.set('mcp', { status: 'connected', serverInfo: { name: 'zerochat' } });
  assert.equal(elements.statusText.textContent, 'Conectado');
});

test('ChatUIMcp - renderToolsList renderiza estado vacío cuando está desconectado', t => {
  const { toolsContainer } = setup(t, { status: 'disconnected' });
  ChatUIMcp.renderToolsList(toolsContainer, [], {});
  assert.ok(toolsContainer.querySelector('.mcp-tools-empty'));
  assert.match(toolsContainer.textContent, /ejecute localmente/);
});

const TOOLS = [
  { id: 'list_directory', name: 'list_directory', description: 'Lista un directorio', inputSchema: { type: 'object', properties: { path: { type: 'string' } } }, metadata: {} },
  { id: 'read_file', name: 'read_file', description: 'Lee un archivo', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }, metadata: {} },
  { id: 'run_command', name: 'run_command', description: 'Ejecuta comandos', inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }, metadata: {} }
];

test('ChatUIMcp - renderToolsList renderiza herramientas con interruptores que actualizan la configuración', t => {
  const { toolsContainer } = mounted(t);
  const previous = ChatConfig.getActive().enabledTools;
  t.after(() => ChatConfig.updateRuntime({ enabledTools: previous }));
  ChatUIMcp.renderToolsList(toolsContainer, TOOLS, { list_directory: true, read_file: false, run_command: true });

  assert.ok(toolsContainer.querySelector('.mcp-tools-header'));
  assert.match(toolsContainer.textContent, /Herramientas Disponibles del Sistema/);
  assert.match(toolsContainer.textContent, /3 detectadas/);
  assert.match(toolsContainer.querySelector('[data-tool-id="read_file"] .mcp-tool-params').textContent, /path: string/);

  const checkbox = id => toolsContainer.querySelector(`.mcp-tool-checkbox[data-tool-id="${id}"]`);
  assert.equal(checkbox('read_file').checked, false);
  checkbox('run_command').checked = false;
  checkbox('run_command').dispatchEvent(new Event('change', { bubbles: true }));
  assert.equal(ChatConfig.getActive().enabledTools.run_command, false);
  checkbox('read_file').checked = true;
  checkbox('read_file').dispatchEvent(new Event('change', { bubbles: true }));
  assert.equal(ChatConfig.getActive().enabledTools.read_file, true);
});

test('ChatUIMcp - renderToolsList renderiza selectores de autorización y actualiza políticas', t => {
  const tools = [
    { id: 'mcp_test_tool_1', name: 'mcp_test_tool_1', metadata: { mcpServerName: 'srv1', originalName: 'tool1' } },
    { id: 'mcp_test_tool_2', name: 'mcp_test_tool_2', metadata: { mcpServerName: 'srv1', originalName: 'tool2' } }
  ];
  // Conectada: cada cambio de política repinta la lista desde el estado MCP.
  const { toolsContainer } = mounted(t, { status: 'connected', tools });
  ChatToolSecurity.manager.setToolPolicy('mcp_test_tool_2', 'allow', { serverName: 'srv1', originalName: 'tool2' });
  ChatUIMcp.renderToolsList(toolsContainer, tools, {});

  const select = id => toolsContainer.querySelector(`.mcp-auth-select[data-tool-id="${id}"]`);
  assert.equal(select('mcp_test_tool_2').value, 'allow');
  select('mcp_test_tool_1').value = 'allow';
  select('mcp_test_tool_1').dispatchEvent(new Event('change', { bubbles: true }));
  assert.equal(ChatToolSecurity.manager.getToolPolicy('mcp_test_tool_1'), 'allow');
  assert.ok(select('mcp_test_tool_1').classList.contains('status-allowed'));

  select('mcp_test_tool_2').value = 'ask';
  select('mcp_test_tool_2').dispatchEvent(new Event('change', { bubbles: true }));
  assert.equal(ChatToolSecurity.manager.getToolPolicy('mcp_test_tool_2'), null);
  assert.ok(select('mcp_test_tool_2').classList.contains('status-ask'));

  ChatToolSecurity.manager.setGlobalMcpPolicy('allow_all');
  ChatUIMcp.renderToolsList(toolsContainer, tools, {});
  assert.match(toolsContainer.textContent, /\(Global\)/);
});

test('ChatUIMcp - las revocaciones guardadas son botones de icono con tooltip accesible', t => {
  mounted(t);
  ChatToolSecurity.manager.setToolPolicy('mcp_compact_revoke_test', 'allow', { originalName: 'compact revoke test' });
  ChatUIMcp.renderSavedAuthorizations();
  const button = document.querySelector('#mcp-saved-auths-list .btn-revoke-auth');
  assert.equal(button.title, 'Revocar');
  assert.equal(button.getAttribute('aria-label'), 'Revocar');
  assert.ok(button.querySelector('.ui-icon'));
  assert.equal(button.textContent.trim(), '');
  button.click();
  assert.equal(ChatToolSecurity.manager.getToolPolicy('mcp_compact_revoke_test'), null);
});

test('ChatUIMcp - mantiene data-i18n y no revierte a desconectado tras applyTranslations', t => {
  const elements = setup(t);
  const originalLang = ChatI18n.getLanguage();
  t.after(() => ChatI18n.setLanguage(originalLang));
  ChatI18n.setLanguage('es');
  ChatUIMcp.renderConnectionStatus(elements, { ...ChatState.get('mcp'), status: 'connected', serverInfo: { name: 'zerochat', version: '1.0' }, tools: [{ id: 'x', name: 'x', metadata: {} }] });
  assert.equal(elements.statusText.textContent, 'Conectado');

  // Abrir una sección de configuración vuelve a aplicar las traducciones del documento.
  ChatI18n.applyTranslations(document);
  assert.equal(elements.statusText.textContent, 'Conectado');
  assert.equal(elements.statusText.getAttribute('data-i18n'), 'mcp_status_connected');
  ChatI18n.setLanguage('en');
  assert.equal(elements.statusText.textContent, 'Connected');
});

test('ChatUIMcp - renderExternalServers muestra estado vacío o tarjetas con badges y botón Iniciar/Detener', t => {
  const { serversList } = setup(t);
  ChatUIMcp.renderExternalServers(serversList, []);
  assert.ok(serversList.querySelector('.mcp-servers-empty'));

  ChatUIMcp.renderExternalServers(serversList, [
    { id: 'ejemplo', displayName: { es: 'Ejemplo de MCP', en: 'MCP example' }, description: { es: 'Servidor de prueba' }, help: { url: 'help/mcp.html', label: { es: 'Guía del ejemplo' } }, status: 'stopped', toolCount: 0 },
    { id: 'sqlite', displayName: { es: 'SQLite' }, description: { es: 'Base de datos' }, status: 'running', toolCount: 2 }
  ]);
  const card = id => serversList.querySelector(`.mcp-server-item[data-server-id="${id}"]`);
  assert.match(card('ejemplo').textContent, /Ejemplo de MCP/);
  assert.equal(card('ejemplo').querySelector('.mcp-server-help a').getAttribute('href'), 'help/mcp.html');
  assert.ok(card('ejemplo').querySelector('.status-stopped'));
  assert.match(card('ejemplo').querySelector('.btn-mcp-server-toggle').textContent, /Iniciar/);
  assert.ok(card('sqlite').querySelector('.status-running'));
  assert.match(card('sqlite').querySelector('.btn-mcp-server-toggle').textContent, /Detener/);
  assert.match(card('sqlite').textContent, /2 herramientas activas/);
});

test('ChatUIMcp - el campo help de service.json solo admite URL HTTP o rutas relativas seguras', () => {
  assert.deepEqual(ChatUIMcp.getServiceHelp({ url: 'https://example.com/help', label: { es: 'Ayuda' } }, 'es'), { url: 'https://example.com/help', label: 'Ayuda' });
  assert.deepEqual(ChatUIMcp.getServiceHelp({ url: 'help/mcp.html', label: { en: 'Help' } }, 'es'), { url: 'help/mcp.html', label: 'Help' });
  assert.equal(ChatUIMcp.getServiceHelp({ url: 'javascript:alert(1)', label: 'Unsafe' }, 'es'), null);
  assert.equal(ChatUIMcp.getServiceHelp({ url: '//example.com', label: 'Unsafe' }, 'es'), null);
});

test('ChatUIMcp - identifica los servicios mcp-remote sin exponer la ruta completa', t => {
  const { serversList } = setup(t);
  ChatUIMcp.renderExternalServers(serversList, [{ id: 'composio', status: 'stopped', remote: { type: 'mcp-remote', url: 'https://connect.composio.dev/mcp?secret=must-not-be-rendered' } }]);
  assert.match(serversList.textContent, /MCP remoto HTTP/);
  assert.match(serversList.textContent, /connect\.composio\.dev/);
  assert.doesNotMatch(serversList.innerHTML, /must-not-be-rendered/);
});

function clickToggle(serversList, server) {
  ChatUIMcp.renderExternalServers(serversList, [server]);
  const button = serversList.querySelector('.btn-mcp-server-toggle');
  button.click();
  return button;
}

test('ChatUIMcp - un error al iniciar se muestra en su tarjeta con enlace a la ayuda de dependencias', async t => {
  const { serversList } = setup(t, { externalServers: [{ id: 'ejemplo', status: 'stopped' }] });
  ChatUIMcp.renderExternalServers(serversList, [{ id: 'example-mcp', status: 'error', error: 'example-mcp requiere Node.js 24+' }]);
  assert.equal(serversList.querySelector('.mcp-server-error a').getAttribute('href'), 'help/mcp.html');
  assert.match(serversList.textContent, /Consultar ayuda de dependencias MCP/);
  assert.match(serversList.textContent, /Node\.js 24\+/);

  t.mock.method(ChatMCP.manager, 'startExternalServer', async () => { throw new Error('connection failed'); });
  t.mock.method(console, 'error', () => {});
  assert.equal(await ChatUIMcp.runExternalServerAction('ejemplo', 'start'), false);
  const server = ChatState.get('mcp').externalServers[0];
  assert.equal(server.status, 'stopped');
  assert.equal(server.error, 'No se pudo actualizar el servidor MCP.');
});

test('ChatUIMcp - Playwright detecta e informa si browser_action está activa', t => {
  assert.equal(ChatUIMcp.isBrowserActionActive({}, { name: 'browser_action', available: true }), true);
  assert.equal(ChatUIMcp.isBrowserActionActive({ browser_action: false }, { name: 'browser_action', available: true }), false);
  assert.equal(ChatUIMcp.isBrowserActionActive({}, { name: 'browser_action', available: false }), false);
  assert.equal(ChatUIMcp.isBrowserActionActive({}, null), false);

  const { serversList } = setup(t, { tools: [{ id: 'browser_action', name: 'browser_action', available: true, metadata: {} }] });
  ChatUIMcp.renderExternalServers(serversList, [{ id: 'playwright', status: 'stopped' }]);
  assert.match(serversList.textContent, /browser_action está activa/);
});

test('ChatUIMcp - iniciar un servidor MCP muestra el estado iniciando y el intento de cada espera', async t => {
  const { serversList } = mounted(t, { externalServers: [{ id: 'ejemplo', status: 'stopped' }] });
  let statusDuringStart = null;
  t.mock.method(ChatMCP.manager, 'startExternalServer', async (serverId, onWait) => {
    statusDuringStart = ChatState.get('mcp').externalServers[0].status;
    assert.equal(serverId, 'ejemplo');
    onWait(2, 10, 'starting');
  });
  const button = clickToggle(serversList, { id: 'ejemplo', status: 'stopped' });
  assert.equal(button.textContent, 'Iniciando');
  assert.equal(button.disabled, true);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(statusDuringStart, 'starting');
  assert.deepEqual(ChatState.get('mcp').externalServers[0].startWait, { attempt: 2, total: 10 });
  assert.equal(button.disabled, false);
  assert.equal(button.hasAttribute('aria-busy'), false);
});

test('ChatUIMcp - repintar las listas no vuelve a enlazar eventos: cada acción se dispara una vez', async t => {
  const { toolsContainer, serversList } = mounted(t);
  const tools = [{ id: 'mcp_once', name: 'mcp_once', metadata: { mcpServerName: 'srv', originalName: 'once' } }];
  const setPolicy = t.mock.method(ChatToolSecurity.manager, 'setToolPolicy');
  ChatUIMcp.renderToolsList(toolsContainer, tools, {});
  ChatUIMcp.renderToolsList(toolsContainer, tools, {});
  const select = toolsContainer.querySelector('.mcp-auth-select');
  select.value = 'allow';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  assert.equal(setPolicy.mock.callCount(), 1);

  const start = t.mock.method(ChatMCP.manager, 'startExternalServer', async () => {});
  ChatUIMcp.renderExternalServers(serversList, [{ id: 'ejemplo', status: 'stopped' }]);
  ChatUIMcp.renderExternalServers(serversList, [{ id: 'ejemplo', status: 'stopped' }]);
  serversList.querySelector('.btn-mcp-server-toggle').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(start.mock.callCount(), 1);
});

function useDialogs(t, confirmResult, alerts = []) {
  const previous = globalThis.ChatDialogs;
  const confirms = [];
  globalThis.ChatDialogs = {
    confirm: async (message, options) => { confirms.push({ message, options }); return typeof confirmResult === 'function' ? confirmResult() : confirmResult; },
    alert: async (message, options) => { alerts.push({ message, options }); }
  };
  t.after(() => { globalThis.ChatDialogs = previous; });
  return confirms;
}

test('ChatUIMcp - ofrece iniciar los servicios de la sesión anterior y arranca solo los que se conservan', async t => {
  const servers = [
    { id: 'memory', enabled: true, status: 'stopped', displayName: { es: 'Memoria', en: 'Memory' } },
    { id: 'composio', enabled: true, status: 'stopped', displayName: { es: 'Composio' } },
    { id: 'ejemplo', enabled: true, status: 'stopped' },
    { id: 'running', enabled: true, status: 'running' },
    { id: 'disabled', enabled: false, status: 'stopped' }
  ];
  setup(t, { externalServers: servers });
  const started = [];
  const alerts = [];
  let selection = ['memory', 'composio'];
  const confirms = useDialogs(t, () => selection, alerts);
  t.mock.method(ChatMCP.manager, 'startExternalServer', async id => {
    started.push(id);
    if (id === 'composio') throw new Error('connection failed');
  });
  t.mock.method(console, 'error', () => {});
  const stopped = [];
  t.mock.method(ChatMCP.manager, 'stopExternalServer', async id => { stopped.push(id); });

  assert.deepEqual(await ChatUIMcp.offerStoppedExternalServices(servers), selection);
  assert.deepEqual(confirms[0].options.items, [{ id: 'memory', label: 'Memoria' }, { id: 'composio', label: 'Composio' }, { id: 'ejemplo', label: 'ejemplo' }]);
  assert.equal(confirms[0].options.acceptText, 'Iniciar');
  assert.deepEqual(started, ['memory', 'composio']);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].options.type, 'error');
  assert.match(alerts[0].message, /Composio/);
  assert.doesNotMatch(alerts[0].message, /Memoria/);

  // Los que no se inician se guardan como no iniciados y no se vuelven a ofrecer.
  assert.deepEqual(stopped, ['ejemplo']);

  ChatState.set('mcp', { externalServers: servers });
  started.length = 0;
  stopped.length = 0;
  selection = null;
  assert.deepEqual(await ChatUIMcp.offerStoppedExternalServices(servers), []);
  assert.deepEqual(started, []);
  assert.deepEqual(stopped, ['memory', 'composio', 'ejemplo']);

  confirms.length = 0;
  assert.deepEqual(await ChatUIMcp.offerStoppedExternalServices([{ id: 'x', enabled: false, status: 'stopped' }]), []);
  assert.equal(confirms.length, 0);
});

test('ChatUIMcp - no reinicia ni marca como detenido un servicio que se inició mientras el diálogo estaba abierto', async t => {
  const servers = [{ id: 'memory', enabled: true, status: 'stopped' }, { id: 'ejemplo', enabled: true, status: 'stopped' }];
  setup(t, { externalServers: servers });
  const started = [];
  useDialogs(t, () => {
    ChatState.set('mcp', current => ({ ...current, externalServers: servers.map(server => ({ ...server, status: 'running' })) }));
    return ['memory'];
  });
  t.mock.method(ChatMCP.manager, 'startExternalServer', async id => { started.push(id); });
  const stop = t.mock.method(ChatMCP.manager, 'stopExternalServer', async () => {});
  await ChatUIMcp.offerStoppedExternalServices(servers);
  assert.deepEqual(started, []);
  assert.equal(stop.mock.callCount(), 0);
});

function makeAbortError() {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

async function flushMicrotasks() {
  await new Promise(resolve => setImmediate(resolve));
}

test('ChatMCP - start: un timeout inicial o de respuesta SSE consulta el estado y acepta running', async t => {
  const manager = ChatMCP.manager;
  {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const request = t.mock.method(manager, 'requestExternalControl', async () => { throw makeAbortError(); });
    const fetch = t.mock.method(manager, 'fetchExternalServers', async () => ({ servers: [{ id: 'ejemplo', status: 'running' }] }));
    const sync = t.mock.method(manager, 'syncExternalServers', async () => {});
    const waits = [];
    const result = await manager.startExternalServer('ejemplo', (attempt, total) => waits.push([attempt, total]));
    assert.equal(result.servers[0].status, 'running');
    assert.deepEqual(waits, []);
    assert.equal(sync.mock.callCount(), 1);
    t.mock.timers.reset();
    request.mock.restore();
    fetch.mock.restore();
    sync.mock.restore();
  }
  {
    t.mock.method(manager, 'requestExternalControl', async () => {
      const error = new Error('SSE response timed out');
      error.code = 'MCP_REQUEST_TIMEOUT';
      throw error;
    });
    t.mock.method(manager, 'fetchExternalServers', async () => ({ servers: [{ id: 'ejemplo', status: 'running' }] }));
    const sync = t.mock.method(manager, 'syncExternalServers', async () => {});
    assert.equal((await manager.startExternalServer('ejemplo')).servers[0].status, 'running');
    assert.equal(sync.mock.callCount(), 1);
  }
});

test('ChatMCP - start: si el estado se queda en starting, renuncia tras 10 comprobaciones', async t => {
  const manager = ChatMCP.manager;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(manager, 'requestExternalControl', async () => { throw makeAbortError(); });
  let fetchCalls = 0;
  t.mock.method(manager, 'fetchExternalServers', async () => {
    fetchCalls += 1;
    return { servers: [{ id: 'ejemplo', status: 'starting' }] };
  });
  const waits = [];
  const pending = assert.rejects(
    manager.startExternalServer('ejemplo', (attempt, total) => waits.push([attempt, total])),
    error => error.code === 'EXTERNAL_START_WAIT_TIMEOUT' && error.externalServer.status === 'starting'
  );
  for (let i = 0; i < 10; i += 1) {
    await flushMicrotasks();
    t.mock.timers.tick(15000);
    await flushMicrotasks();
  }
  await pending;
  assert.equal(fetchCalls, 11);
  assert.equal(waits.length, 10);
  assert.deepEqual(waits[0], [1, 10]);
  assert.deepEqual(waits[9], [10, 10]);
});

test('ChatMCP - start: renuncia sin esperar ante estado de error, estados terminales, servicios desconocidos o fallo de consulta', async t => {
  const manager = ChatMCP.manager;
  t.mock.method(manager, 'requestExternalControl', async () => { throw makeAbortError(); });
  let waits = 0;
  for (const status of ['error', 'available', 'stopped', undefined]) {
    const fetch = t.mock.method(manager, 'fetchExternalServers', async () => ({ servers: status ? [{ id: 'ejemplo', status }] : [] }));
    await assert.rejects(manager.startExternalServer('ejemplo', () => { waits += 1; }), error => error.code === 'EXTERNAL_START_STATUS_UNAVAILABLE');
    assert.equal(fetch.mock.callCount(), 1);
    fetch.mock.restore();
  }
  assert.equal(waits, 0);

  manager.requestExternalControl.mock.restore();
  t.mock.method(manager, 'requestExternalControl', async method => {
    if (method.endsWith('/start')) throw makeAbortError();
    throw new Error('Status unavailable');
  });
  await assert.rejects(manager.startExternalServer('ejemplo'),
    error => error.code === 'EXTERNAL_START_STATUS_UNAVAILABLE' && error.cause.message === 'Status unavailable');
});

test('ChatMCP - start: un error distinto del timeout se propaga sin comprobar el estado', async t => {
  const manager = ChatMCP.manager;
  t.mock.method(manager, 'requestExternalControl', async () => { throw new Error('Sin conexión'); });
  const fetch = t.mock.method(manager, 'fetchExternalServers', async () => ({ servers: [] }));
  await assert.rejects(() => manager.startExternalServer('ejemplo'), /Sin conexión/);
  assert.equal(fetch.mock.callCount(), 0);
});

test('ChatMCP - start: OAuth termina durante una espera sin reenviar el arranque', async t => {
  const manager = ChatMCP.manager;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const request = t.mock.method(manager, 'requestExternalControl', async () => { throw makeAbortError(); });
  let checks = 0;
  t.mock.method(manager, 'fetchExternalServers', async () => ({
    servers: [{ id: 'ejemplo', status: ++checks === 3 ? 'running' : checks === 1 ? 'installing' : 'starting' }]
  }));
  const sync = t.mock.method(manager, 'syncExternalServers', async () => {});
  const waits = [];
  const pending = manager.startExternalServer('ejemplo', (attempt, total, status) => waits.push([attempt, total, status]));
  await flushMicrotasks();
  assert.deepEqual(waits, [[1, 80, 'installing']]);
  t.mock.timers.tick(14999);
  await flushMicrotasks();
  assert.equal(checks, 1);
  t.mock.timers.tick(1);
  await flushMicrotasks();
  assert.deepEqual(waits, [[1, 80, 'installing'], [1, 10, 'starting']]);
  t.mock.timers.tick(15000);
  assert.equal((await pending).servers[0].status, 'running');
  assert.equal(request.mock.callCount(), 1);
  assert.equal(sync.mock.callCount(), 1);
});

test('ChatMCP - start: propaga el objeto servidor con oauthUrl durante el arranque', async t => {
  const manager = ChatMCP.manager;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(manager, 'requestExternalControl', async () => { throw makeAbortError(); });
  let checks = 0;
  t.mock.method(manager, 'fetchExternalServers', async () => ({
    servers: [{ id: 'composio', status: ++checks === 2 ? 'running' : 'starting', oauthUrl: checks === 1 ? 'https://example.com/oauth' : null }]
  }));
  t.mock.method(manager, 'syncExternalServers', async () => {});
  const receivedServers = [];
  const pending = manager.startExternalServer('composio', (attempt, total, status, server) => receivedServers.push(server));
  await flushMicrotasks();
  t.mock.timers.tick(15000);
  assert.equal((await pending).servers[0].status, 'running');
  assert.equal(receivedServers.length, 1);
  assert.equal(receivedServers[0].oauthUrl, 'https://example.com/oauth');
});
