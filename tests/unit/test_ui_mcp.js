const test = require('node:test');
const assert = require('node:assert/strict');

const ChatUIMcp = require('../../js/ui-mcp.js');
const ChatState = require('../../js/state.js');
const ChatMCP = require('../../js/mcp.js');
const ChatConfig = require('../../js/config-store.js');
const ChatToolSecurity = require('../../js/tool-security.js');
const ChatMcpStatus = require('../../js/mcp-status.js');

/** Estado MCP de la prueba, restaurado al terminar junto con las autorizaciones. */
function setup(t, mcp = {}) {
  const previousState = ChatState.get('mcp');
  ChatState.set('mcp', { ...previousState, tools: [], externalTools: [], externalServers: [], ...mcp });
  t.after(() => {
    ChatState.set('mcp', previousState);
    ChatToolSecurity.manager.applyPolicies({ allowAll: false, tools: {}, servers: {}, directoryRules: [] });
  });
}

test('ChatMcpStatus - cada estado de servicio del backend (tests/fixtures/mcp/contract.json) se puede arrancar o está activo, nunca ambos', () => {
  const { serviceStatuses } = require('../fixtures/mcp/contract.json');
  for (const status of serviceStatuses) {
    assert.notEqual(ChatMcpStatus.isActive(status), ChatMcpStatus.canStart(status), status);
  }
  assert.deepEqual(serviceStatuses.filter(ChatMcpStatus.isRunning), ['running']);
});

test('ChatUIMcp - el campo help de service.json solo admite URL HTTP o rutas relativas seguras', () => {
  assert.deepEqual(ChatUIMcp.getServiceHelp({ url: 'https://example.com/help', label: { es: 'Ayuda' } }, 'es'), { url: 'https://example.com/help', label: 'Ayuda' });
  assert.deepEqual(ChatUIMcp.getServiceHelp({ url: 'help/mcp.html', label: { en: 'Help' } }, 'es'), { url: 'help/mcp.html', label: 'Help' });
  assert.equal(ChatUIMcp.getServiceHelp({ url: 'javascript:alert(1)', label: 'Unsafe' }, 'es'), null);
  assert.equal(ChatUIMcp.getServiceHelp({ url: '//example.com', label: 'Unsafe' }, 'es'), null);
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

test('ChatUIMcp - detiene un servicio sobrante aunque haya más de 50 instalados por delante', async t => {
  const servers = [...Array.from({ length: 50 }, (_, i) => ({ id: `idle${i}`, status: 'stopped' })), { id: 'obsolete', status: 'running' }];
  setup(t, { status: 'connected', externalServers: servers });
  ChatConfig.updateRuntime({ mcpServers: [], browser: 'none' });
  useDialogs(t, null, []);
  const stopped = [];
  t.mock.method(ChatMCP.manager, 'stopExternalServer', async id => { stopped.push(id); });
  await ChatUIMcp.reconcileProjectServices(servers);
  assert.deepEqual(stopped, ['obsolete']);
});

test('ChatUIMcp - concilia servicios del proyecto en silencio, detiene los sobrantes y avisa solo si alguno falla', async t => {
  const servers = [
    { id: 'memory', status: 'stopped', displayName: { es: 'Memoria', en: 'Memory' } },
    { id: 'composio', status: 'stopped', displayName: { es: 'Composio' } },
    { id: 'playwright', status: 'stopped', displayName: { es: 'Playwright' } },
    { id: 'running', status: 'running' },
    { id: 'obsolete', status: 'running' }
  ];
  setup(t, { status: 'connected', externalServers: servers });
  ChatConfig.updateRuntime({ mcpServers: ['memory', 'composio', 'running'], browser: 'playwright' });
  const started = [];
  const stopped = [];
  const alerts = [];
  const confirms = useDialogs(t, null, alerts);
  t.mock.method(ChatMCP.manager, 'startExternalServer', async id => {
    started.push(id);
    if (id === 'composio') throw new Error('connection failed');
  });
  t.mock.method(console, 'error', () => {});
  t.mock.method(ChatMCP.manager, 'stopExternalServer', async id => {
    stopped.push(id);
  });

  assert.deepEqual(await ChatUIMcp.reconcileProjectServices(servers), ['memory', 'playwright']);
  assert.equal(confirms.length, 0);
  assert.deepEqual(stopped, ['obsolete']);
  assert.deepEqual(started, ['memory', 'composio', 'playwright']);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].options.type, 'error');
  assert.match(alerts[0].message, /Composio/);
  assert.doesNotMatch(alerts[0].message, /Memoria/);

  // Al cambiar de proyecto y desactivar Playwright, detiene playwright y arranca solo los del proyecto nuevo.
  alerts.length = 0;
  started.length = 0;
  stopped.length = 0;
  const switched = [
    { id: 'memory', status: 'stopped', displayName: { es: 'Memoria' } },
    { id: 'playwright', status: 'running', displayName: { es: 'Playwright' } }
  ];
  setup(t, { status: 'connected', externalServers: switched });
  ChatConfig.updateRuntime({ mcpServers: ['memory'], browser: 'browser_action' });
  assert.deepEqual(await ChatUIMcp.reconcileProjectServices(switched), ['memory']);
  assert.deepEqual(stopped, ['playwright']);
  assert.deepEqual(started, ['memory']);
  assert.equal(alerts.length, 0);

  // No vuelve a arrancar uno que ya pasó a activo en el estado vivo antes de llegar su turno.
  started.length = 0;
  stopped.length = 0;
  setup(t, { status: 'connected', externalServers: [{ id: 'memory', status: 'running' }] });
  ChatConfig.updateRuntime({ mcpServers: ['memory'], browser: 'none' });
  await ChatUIMcp.reconcileProjectServices([{ id: 'memory', status: 'stopped' }]);
  assert.deepEqual(started, []);
  assert.deepEqual(stopped, []);
});

test('ChatUIMcp - renderExternalServers pinta opciones de texto (y secretos) escapando valores', () => {
  let html = '';
  const container = { set innerHTML(v) { html = v; }, get innerHTML() { return html; }, querySelectorAll: () => [] };
  ChatUIMcp.renderExternalServers(container, [{
    id: 'mail',
    status: 'stopped',
    displayName: { es: 'Correo', en: 'Mail' },
    options: [
      { id: 'MAIL_IMAP_HOST', type: 'text', label: { es: 'Servidor IMAP', en: 'IMAP server' }, placeholder: { es: 'imap.gmail.com', en: 'imap.gmail.com' } },
      { id: 'MAIL_USER', type: 'text', label: { es: 'Usuario', en: 'User' } }
    ],
    userOptions: { MAIL_IMAP_HOST: 'imap."test".com' },
    secrets: [{ name: 'MAIL_PASSWORD', label: { es: 'Contraseña', en: 'Password' }, configured: false }]
  }]);
  assert.match(html, /class="mcp-server-option-input"/);
  assert.match(html, /data-option-id="MAIL_IMAP_HOST"/);
  assert.match(html, /value="imap\.&quot;test&quot;\.com"/);
  assert.match(html, /placeholder="imap\.gmail\.com"/);
  assert.match(html, /data-secret-name="MAIL_PASSWORD"/);
});
