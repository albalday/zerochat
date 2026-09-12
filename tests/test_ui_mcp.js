const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ChatUIMcp = require('../js/ui-mcp.js');
const ChatState = require('../js/state.js');
const ChatI18n = require('../js/i18n.js');

test('ChatUIMcp - sanitizePort y sanitizeHost', () => {
  // Puertos válidos
  assert.equal(ChatUIMcp.sanitizePort(6388), 6388);
  assert.equal(ChatUIMcp.sanitizePort('6390'), 6390);
  assert.equal(ChatUIMcp.sanitizePort(1024), 1024);
  assert.equal(ChatUIMcp.sanitizePort(65535), 65535);

  // Puertos inválidos retornan puerto por defecto (6388)
  assert.equal(ChatUIMcp.sanitizePort(80), 6388);
  assert.equal(ChatUIMcp.sanitizePort(0), 6388);
  assert.equal(ChatUIMcp.sanitizePort(70000), 6388);
  assert.equal(ChatUIMcp.sanitizePort('not_a_port'), 6388);
  assert.equal(ChatUIMcp.sanitizePort(null), 6388);

  // Hosts
  assert.equal(ChatUIMcp.sanitizeHost('127.0.0.1'), '127.0.0.1');
  assert.equal(ChatUIMcp.sanitizeHost(' localhost '), 'localhost');
  assert.equal(ChatUIMcp.sanitizeHost(''), '127.0.0.1');
  assert.equal(ChatUIMcp.sanitizeHost(null), '127.0.0.1');
});

test('ChatUIMcp - buildMcpEndpoint', () => {
  assert.equal(
    ChatUIMcp.buildMcpEndpoint('127.0.0.1', 6388),
    'http://127.0.0.1:6388/sse'
  );
  assert.equal(
    ChatUIMcp.buildMcpEndpoint('localhost', '6399', '/custom-sse'),
    'http://localhost:6399/custom-sse'
  );
  assert.equal(
    ChatUIMcp.buildMcpEndpoint('', '', 'sse'),
    'http://127.0.0.1:6388/sse'
  );
});

test('ChatUIMcp - generateTerminalCommand genera la línea de comando simplificada', () => {
  const cmdDefault = ChatUIMcp.generateTerminalCommand(6388);
  assert.equal(cmdDefault, 'python3 zerochat_mcp.py');

  const cmdCustom = ChatUIMcp.generateTerminalCommand(6395);
  assert.equal(cmdCustom, 'python3 zerochat_mcp.py --port 6395');

  // Fallback seguro en puerto inválido
  const cmdInvalid = ChatUIMcp.generateTerminalCommand('invalido');
  assert.equal(cmdInvalid, 'python3 zerochat_mcp.py');
});

test('ChatUIMcp - selecciona sistema operativo y adapta comando e instrucciones', () => {
  assert.equal(ChatUIMcp.DEFAULT_OPERATING_SYSTEM, 'linux');
  assert.equal(ChatUIMcp.sanitizeOperatingSystem('unknown'), 'linux');
  assert.equal(ChatUIMcp.generateTerminalCommand(6388, 'linux'), 'python3 zerochat_mcp.py');
  assert.equal(ChatUIMcp.generateTerminalCommand(6395, 'windows'), 'py zerochat_mcp.py --port 6395');

  const linuxHelp = ChatUIMcp.generateClipboardCommand(6388, 'linux', () => 'LINUX HELP');
  const windowsHelp = ChatUIMcp.generateClipboardCommand(6388, 'windows', () => 'WINDOWS HELP');
  const androidHelp = ChatUIMcp.generateClipboardCommand(6388, 'android', () => 'ANDROID HELP');
  assert.equal(linuxHelp, 'LINUX HELP\n\npython3 zerochat_mcp.py');
  assert.equal(windowsHelp, 'WINDOWS HELP\n\npy zerochat_mcp.py');
  assert.equal(androidHelp, 'ANDROID HELP\n\npython3 zerochat_mcp.py');
  assert.equal(ChatUIMcp.generateOperatingSystemInstructions('windows', () => 'WINDOWS HELP'), 'WINDOWS HELP');
});

test('ChatUIMcp - generateMcpServerScript genera código Python autónomo para el Servidor Local', () => {
  const pyScript = ChatUIMcp.generateMcpServerScript({ host: '127.0.0.1', port: 6388 });
  assert.ok(pyScript.includes('#!/usr/bin/env python3'));
  assert.ok(!pyScript.includes('FastMCP'));
  assert.ok(pyScript.includes('list_directory'));
  assert.ok(pyScript.includes('read_file'));
  assert.ok(pyScript.includes('search_files'));
  assert.ok(pyScript.includes('edit_file'));
  assert.ok(pyScript.includes('execute_command'));
  assert.ok(pyScript.includes('browser_navigate'));
  assert.ok(pyScript.includes('ZeroChatLocalServerHandler'));
  assert.ok(pyScript.includes('ThreadingHTTPServer'));
  assert.ok(pyScript.includes('DEFAULT_PORT = 6388'));
  assert.ok(pyScript.includes('default="127.0.0.1"'));

  const pyCustom = ChatUIMcp.generateMcpServerScript({ host: '0.0.0.0', port: 6399 });
  assert.ok(pyCustom.includes('DEFAULT_PORT = 6399'));
  assert.ok(pyCustom.includes('default="0.0.0.0"'));
});

test('ChatUIMcp - el puerto predeterminado coincide con el servidor Python', () => {
  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'mcp_server.py'), 'utf8');
  assert.match(serverSource, new RegExp(`DEFAULT_PORT\\s*=\\s*${ChatUIMcp.DEFAULT_PORT}\\b`));
  assert.match(serverSource, /add_argument\("--port", type=int, default=DEFAULT_PORT/);
});

test('ChatUIMcp - renderConnectionStatus actualiza badge, botones y detalles', () => {
  function createMockElements() {
    const attrs = {};
    return {
      statusBadge: { className: '' },
      statusText: {
        textContent: '',
        setAttribute: (k, v) => { attrs[k] = v; },
        getAttribute: (k) => attrs[k]
      },
      btnConnect: { style: {}, disabled: false, innerHTML: '' },
      btnDisconnect: { style: {}, disabled: false, innerHTML: '' },
      serverDetails: { style: {}, innerHTML: '', textContent: '' },
      errorMessage: { style: {}, innerHTML: '', textContent: '' },
      hostInput: { value: '127.0.0.1' },
      portInput: { value: '6388' },
      endpointPreview: { textContent: '' },
      commandSnippet: { textContent: '' }
    };
  }

  const elements = createMockElements();
  const t = (k, p) => ChatI18n.t(k, p);

  // 1. Estado desconectado
  ChatUIMcp.renderConnectionStatus(elements, { status: 'disconnected', host: '127.0.0.1', port: 6388 }, t);
  assert.equal(elements.statusBadge.className, 'mcp-status-badge mcp-status-disconnected');
  assert.equal(elements.statusText.textContent, 'Desconectado');
  assert.equal(elements.statusText.getAttribute('data-i18n'), 'mcp_status_disconnected');
  assert.equal(elements.btnConnect.style.display, 'inline-flex');
  assert.equal(elements.btnConnect.disabled, false);
  assert.ok(elements.btnConnect.innerHTML.includes('data-i18n="mcp_btn_connect"'));
  assert.equal(elements.btnDisconnect.style.display, 'none');
  assert.equal(elements.serverDetails.style.display, 'none');
  assert.equal(elements.errorMessage.style.display, 'none');

  // 2. Estado conectando
  ChatUIMcp.renderConnectionStatus(elements, { status: 'connecting', host: '127.0.0.1', port: 6388 }, t);
  assert.equal(elements.statusBadge.className, 'mcp-status-badge mcp-status-connecting');
  assert.equal(elements.statusText.textContent, 'Conectando...');
  assert.equal(elements.statusText.getAttribute('data-i18n'), 'mcp_status_connecting');
  assert.equal(elements.btnConnect.disabled, true);
  assert.ok(elements.btnConnect.innerHTML.includes('data-i18n="mcp_btn_connecting"'));
  assert.equal(elements.btnDisconnect.style.display, 'none');

  // 3. Estado conectado
  ChatUIMcp.renderConnectionStatus(elements, {
    status: 'connected',
    host: '127.0.0.1',
    port: 6388,
    serverInfo: { name: 'mcp-proxy', version: '0.4.0' },
    tools: [{ name: 'read_file' }, { name: 'list_dir' }],
    latencyMs: 15
  }, t);
  assert.equal(elements.statusBadge.className, 'mcp-status-badge mcp-status-connected');
  assert.equal(elements.statusText.textContent, 'Conectado');
  assert.equal(elements.statusText.getAttribute('data-i18n'), 'mcp_status_connected');
  assert.equal(elements.btnConnect.style.display, 'none');
  assert.equal(elements.btnDisconnect.style.display, 'inline-flex');
  assert.equal(elements.serverDetails.style.display, 'flex');
  assert.ok(elements.serverDetails.textContent.includes('mcp-proxy v0.4.0'));
  assert.ok(elements.serverDetails.textContent.includes('15ms'));
  assert.ok(elements.serverDetails.textContent.includes('2 herramientas'));

  // 4. Estado error
  ChatUIMcp.renderConnectionStatus(elements, {
    status: 'error',
    host: '127.0.0.1',
    port: 6388,
    error: 'Conexión rechazada',
    latencyMs: 3
  }, t);
  assert.equal(elements.statusBadge.className, 'mcp-status-badge mcp-status-error');
  assert.equal(elements.statusText.textContent, 'Error de conexión');
  assert.equal(elements.statusText.getAttribute('data-i18n'), 'mcp_status_error');
  assert.equal(elements.btnConnect.style.display, 'inline-flex');
  assert.equal(elements.btnConnect.disabled, false);
  assert.equal(elements.errorMessage.style.display, 'flex');
  assert.ok(elements.errorMessage.textContent.includes('Conexión rechazada'));

  // 5. Estado error con caracteres HTML potencialmente peligrosos (prevenir XSS)
  ChatUIMcp.renderConnectionStatus(elements, {
    status: 'error',
    host: '127.0.0.1',
    port: 6388,
    error: '<script>alert("xss")</script>'
  }, t);
  assert.equal(elements.errorMessage.textContent, '<script>alert("xss")</script>');
});

test('ChatUIMcp - copyCommandToClipboard gestiona feedback', async () => {
  const originalDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let copiedText = '';

  Object.defineProperty(globalThis, 'navigator', {
    value: {
      clipboard: {
        writeText: async (txt) => {
          copiedText = txt;
        }
      }
    },
    configurable: true,
    writable: true
  });

  const btn = {
    innerHTML: 'Copiar',
    classList: {
      add: (cls) => { btn._class = cls; },
      remove: (cls) => { if (btn._class === cls) btn._class = ''; }
    }
  };

  try {
    const ok = await ChatUIMcp.copyCommandToClipboard('test command', btn, () => 'Copiado!');
    assert.equal(ok, true);
    assert.equal(copiedText, 'test command');
    assert.ok(btn.innerHTML.includes('Copiado!'));
    assert.equal(btn._class, 'btn-copied');
  } finally {
    if (originalDesc) {
      Object.defineProperty(globalThis, 'navigator', originalDesc);
    }
  }
});

test('ChatUIMcp - initMcpUI vincula reactividad entre inputs y estado', () => {
  const listeners = {};
  const mockPortInput = {
    value: '6388',
    addEventListener: (evt, fn) => { listeners[evt] = fn; }
  };
  const mockHostInput = {
    value: '127.0.0.1',
    addEventListener: (evt, fn) => {}
  };
  const mockCommandSnippet = { textContent: '' };
  const mockEndpointPreview = { textContent: '' };

  const elements = {
    portInput: mockPortInput,
    hostInput: mockHostInput,
    commandSnippet: mockCommandSnippet,
    endpointPreview: mockEndpointPreview,
    statusBadge: { className: '' },
    statusText: { textContent: '' },
    btnConnect: { style: {}, disabled: false, innerHTML: '', addEventListener: () => {} },
    btnDisconnect: { style: {}, disabled: false, innerHTML: '', addEventListener: () => {} },
    serverDetails: { style: {}, innerHTML: '' },
    errorMessage: { style: {}, innerHTML: '' },
    btnCopyCmd: { addEventListener: () => {} }
  };

  const uiInstance = ChatUIMcp.initMcpUI(elements);
  assert.ok(uiInstance);
  assert.equal(mockCommandSnippet.textContent, 'python3 zerochat_mcp.py');
  assert.equal(mockEndpointPreview.textContent, 'http://127.0.0.1:6388/sse');

  // Al cambiar el input de puerto, se recalcula el comando en tiempo real
  mockPortInput.value = '6392';
  listeners['input']();

  assert.equal(mockCommandSnippet.textContent, 'python3 zerochat_mcp.py --port 6392');
  assert.equal(mockEndpointPreview.textContent, 'http://127.0.0.1:6392/sse');

  uiInstance.destroy();
});

test('ChatUIMcp - initMcpUI gestiona apertura y cierre del modal de configuración', () => {
  const listeners = {};
  let modalOpen = false;
  const mockDialog = {
    showModal: () => { modalOpen = true; },
    close: () => { modalOpen = false; },
    addEventListener: (evt, fn) => { listeners['dialog_' + evt] = fn; }
  };
  const mockBtnConfigure = {
    addEventListener: (evt, fn) => { listeners['btnConfigure_' + evt] = fn; }
  };
  const mockBtnClose = {
    addEventListener: (evt, fn) => { listeners['btnClose_' + evt] = fn; }
  };
  const mockBtnCloseFooter = {
    addEventListener: (evt, fn) => { listeners['btnCloseFooter_' + evt] = fn; }
  };

  const elements = {
    mcpSetupDialog: mockDialog,
    btnConfigure: mockBtnConfigure,
    btnCloseSetup: mockBtnClose,
    btnCloseSetupFooter: mockBtnCloseFooter,
    portInput: { value: '6388', addEventListener: () => {} },
    hostInput: { value: '127.0.0.1', addEventListener: () => {} },
    commandSnippet: { textContent: '' },
    endpointPreview: { textContent: '' },
    statusBadge: { className: '' },
    statusText: { textContent: '' },
    btnConnect: { style: {}, disabled: false, innerHTML: '', addEventListener: () => {} },
    btnDisconnect: { style: {}, disabled: false, innerHTML: '', addEventListener: () => {} },
    serverDetails: { style: {}, innerHTML: '' },
    errorMessage: { style: {}, innerHTML: '' },
    btnCopyCmd: { addEventListener: () => {} }
  };

  const uiInstance = ChatUIMcp.initMcpUI(elements);
  assert.equal(modalOpen, false);

  // 1. Abrir modal con click en botón Configurar
  listeners['btnConfigure_click']();
  assert.equal(modalOpen, true);

  // 2. Cerrar modal con botón de cabecera
  listeners['btnClose_click']();
  assert.equal(modalOpen, false);

  // 3. Abrir de nuevo y cerrar con botón del footer
  listeners['btnConfigure_click']();
  assert.equal(modalOpen, true);
  listeners['btnCloseFooter_click']();
  assert.equal(modalOpen, false);

  // 4. Cerrar haciendo click fuera en el backdrop
  listeners['btnConfigure_click']();
  assert.equal(modalOpen, true);
  listeners['dialog_click']({ target: mockDialog });
  assert.equal(modalOpen, false);

  uiInstance.destroy();
});

test('ChatUIMcp - renderToolsList renderiza estado vacío cuando está desconectado o sin herramientas', () => {
  const container = {
    innerHTML: '',
    style: {}
  };

  ChatUIMcp.renderToolsList(container, [], {}, (k) => ChatI18n.t(k));
  assert.equal(container.style.display, 'block');
  assert.ok(container.innerHTML.includes('mcp-tools-empty'));
  assert.ok(container.innerHTML.includes('servidor Python local'));
});

test('ChatUIMcp - renderToolsList renderiza herramientas con switches y captura cambios', () => {
  const ChatConfig = require('../js/config-store.js');
  let lastUpdatedConfig = null;
  const originalUpdate = ChatConfig.update;
  const originalUpdateRuntime = ChatConfig.updateRuntime;
  ChatConfig.update = (patch) => {
    lastUpdatedConfig = patch;
  };
  ChatConfig.updateRuntime = (patch) => {
    lastUpdatedConfig = patch;
  };

  try {
    const mockCheckboxes = [];
    const changeListeners = {};

    const container = {
      innerHTML: '',
      style: {},
      querySelectorAll: (selector) => {
        if (selector === '.mcp-tool-checkbox') {
          return mockCheckboxes;
        }
        return [];
      }
    };

    const tools = [
      {
        id: 'list_directory',
        name: 'list_directory',
        description: 'Recorre un directorio local',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            max_depth: { type: 'integer' }
          }
        }
      },
      {
        id: 'read_file',
        name: 'read_file',
        description: 'Lee un archivo local',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string' }
          },
          required: ['path']
        }
      },
      {
        id: 'execute_command',
        name: 'execute_command',
        description: 'Ejecuta comandos en la terminal',
        inputSchema: {
          type: 'object',
          properties: {
            command: { type: 'string' }
          },
          required: ['command']
        }
      }
    ];

    const currentEnabled = {
      list_directory: true,
      read_file: false,
      execute_command: true
    };

    // Crear mock checkboxes para simular querySelectorAll
    tools.forEach(tool => {
      const cb = {
        checked: currentEnabled[tool.id],
        getAttribute: (attr) => attr === 'data-tool-id' ? tool.id : null,
        addEventListener: (event, handler) => {
          changeListeners[`${tool.id}_${event}`] = handler;
        }
      };
      mockCheckboxes.push(cb);
    });

    ChatUIMcp.renderToolsList(container, tools, currentEnabled, (k, p) => ChatI18n.t(k, p));

    assert.equal(container.style.display, 'block');
    assert.ok(container.innerHTML.includes('mcp-tools-header'));
    assert.ok(container.innerHTML.includes('Herramientas Disponibles del Sistema'));
    assert.ok(container.innerHTML.includes('3 detectadas'));

    // Verificar markup de las tools
    assert.ok(container.innerHTML.includes('list_directory'));
    assert.ok(container.innerHTML.includes('read_file'));
    assert.ok(container.innerHTML.includes('execute_command'));
    assert.ok(container.innerHTML.includes('MCP'));

    // Simular que el usuario desactiva 'execute_command'
    mockCheckboxes[2].checked = false;
    changeListeners['execute_command_change']();

    assert.ok(lastUpdatedConfig);
    assert.equal(lastUpdatedConfig.enabledTools.execute_command, false);

    // Simular que el usuario activa 'read_file'
    mockCheckboxes[1].checked = true;
    changeListeners['read_file_change']();

    assert.ok(lastUpdatedConfig);
    assert.equal(lastUpdatedConfig.enabledTools.read_file, true);
  } finally {
    ChatConfig.update = originalUpdate;
    ChatConfig.updateRuntime = originalUpdateRuntime;
  }
});

test('ChatUIMcp - autoConnectIfAvailable delega en ChatMCP.manager', async () => {
  const ChatMCP = require('../js/mcp.js');
  const originalAutoConnect = ChatMCP.manager.autoConnectIfAvailable;
  let calledWith = null;

  try {
    ChatMCP.manager.autoConnectIfAvailable = async (opts) => {
      calledWith = opts;
      return { success: true, available: true };
    };

    const res = await ChatUIMcp.autoConnectIfAvailable({ host: '127.0.0.1', port: 6388 });
    assert.equal(res.success, true);
    assert.equal(res.available, true);
    assert.equal(calledWith.host, '127.0.0.1');
    assert.equal(calledWith.port, 6388);
  } finally {
    ChatMCP.manager.autoConnectIfAvailable = originalAutoConnect;
  }
});

test('ChatUIMcp - renderToolsList renderiza selectores de autorización y actualiza políticas', () => {
  const ChatToolSecurity = require('../js/tool-security.js');
  ChatToolSecurity.manager.clearAllAuthorizations();
  ChatToolSecurity.manager.setGlobalMcpPolicy('ask');

  const mockSelects = [];
  const selectListeners = {};

  const container = {
    innerHTML: '',
    style: {},
    querySelectorAll: (selector) => {
      if (selector === '.mcp-auth-select') {
        return mockSelects;
      }
      return [];
    }
  };

  const tools = [
    {
      id: 'mcp__test_tool_1',
      name: 'mcp__test_tool_1',
      metadata: { mcpServerName: 'srv1', originalName: 'tool1' }
    },
    {
      id: 'mcp__test_tool_2',
      name: 'mcp__test_tool_2',
      metadata: { mcpServerName: 'srv1', originalName: 'tool2' }
    }
  ];

  // Pre-autorizar tool 2
  ChatToolSecurity.manager.setToolPolicy('mcp__test_tool_2', 'allow', { serverName: 'srv1', originalName: 'tool2' });

  tools.forEach(tool => {
    const sel = {
      value: tool.id === 'mcp__test_tool_2' ? 'allow' : 'ask',
      className: '',
      getAttribute: (attr) => {
        if (attr === 'data-tool-id') return tool.id;
        if (attr === 'data-server-name') return tool.metadata.mcpServerName;
        if (attr === 'data-orig-name') return tool.metadata.originalName;
        return null;
      },
      addEventListener: (evt, fn) => {
        selectListeners[`${tool.id}_${evt}`] = fn;
      }
    };
    mockSelects.push(sel);
  });

  ChatUIMcp.renderToolsList(container, tools, {}, (k) => ChatI18n.t(k));

  // Verificar que el select está presente en el markup
  assert.ok(container.innerHTML.includes('mcp-auth-select'));
  assert.ok(container.innerHTML.includes('value="allow" selected'));

  // Cambiar tool 1 a 'allow'
  mockSelects[0].value = 'allow';
  selectListeners['mcp__test_tool_1_change']();
  assert.equal(ChatToolSecurity.manager.getToolPolicy('mcp__test_tool_1'), 'allow');
  assert.ok(mockSelects[0].className.includes('status-allowed'));

  // Cambiar tool 2 a 'ask' (revocar)
  mockSelects[1].value = 'ask';
  selectListeners['mcp__test_tool_2_change']();
  assert.equal(ChatToolSecurity.manager.getToolPolicy('mcp__test_tool_2'), null);
  assert.ok(mockSelects[1].className.includes('status-ask'));

  // Probar modo global allow_all
  ChatToolSecurity.manager.setGlobalMcpPolicy('allow_all');
  ChatUIMcp.renderToolsList(container, tools, {}, (k) => ChatI18n.t(k));
  assert.ok(container.innerHTML.includes('(Global)'));

  ChatToolSecurity.manager.setGlobalMcpPolicy('ask');
  ChatToolSecurity.manager.clearAllAuthorizations();
});

test('ChatUIMcp - mantiene data-i18n y no revierte a desconectado tras applyTranslations', () => {
  const originalLang = ChatI18n.getLanguage ? ChatI18n.getLanguage() : 'es';
  ChatI18n.setLanguage('es', false);

  const mockAttrs = { 'data-i18n': 'mcp_status_disconnected' };
  const mockStatusText = {
    textContent: 'Desconectado',
    setAttribute(k, v) { mockAttrs[k] = v; },
    getAttribute(k) { return mockAttrs[k]; }
  };
  const mockElements = {
    statusBadge: { className: 'mcp-status-badge mcp-status-disconnected' },
    statusText: mockStatusText,
    btnConnect: { style: {}, disabled: false, innerHTML: '', addEventListener: () => {} },
    btnDisconnect: { style: {}, disabled: false, innerHTML: '', addEventListener: () => {} },
    serverDetails: { style: {}, innerHTML: '' },
    errorMessage: { style: {}, innerHTML: '' }
  };

  // Simular conexión establecida
  ChatUIMcp.renderConnectionStatus(mockElements, {
    status: 'connected',
    serverInfo: { name: 'mcp-proxy', version: '1.0' },
    tools: [{ name: 'test_tool' }],
    latencyMs: 5
  }, (k, p) => ChatI18n.t(k, p));

  assert.equal(mockStatusText.textContent, 'Conectado');
  assert.equal(mockStatusText.getAttribute('data-i18n'), 'mcp_status_connected');

  // Simular escaneo de data-i18n (como hace applyTranslations en openSettingsModal)
  const mockRoot = {
    querySelectorAll(selector) {
      if (selector === '[data-i18n]') {
        return [mockStatusText];
      }
      return [];
    }
  };
  ChatI18n.applyTranslations(mockRoot);

  // Debe mantenerse Conectado, no volver a Desconectado
  assert.equal(mockStatusText.textContent, 'Conectado');
  assert.equal(mockStatusText.getAttribute('data-i18n'), 'mcp_status_connected');

  // Si se cambia a inglés, debe traducirse a Connected
  ChatI18n.setLanguage('en', false);
  ChatI18n.applyTranslations(mockRoot);
  assert.equal(mockStatusText.textContent, 'Connected');

  // Restaurar idioma
  ChatI18n.setLanguage(originalLang, false);
});
