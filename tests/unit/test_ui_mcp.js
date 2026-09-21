const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ChatUIMcp = require('../../js/ui-mcp.js');
const ChatState = require('../../js/state.js');
const ChatI18n = require('../../js/i18n.js');

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

test('ChatUIMcp - generateTerminalCommand ofrece el arranque oficial de zerochat.py', () => {
  assert.equal(
    ChatUIMcp.generateTerminalCommand(),
    'curl -sL https://albalday.github.io/zerochat/zerochat.py -o zerochat.py && python3 zerochat.py'
  );
});

test('ChatUIMcp - el puerto predeterminado coincide con el servidor Python zerochat.py', () => {
  const serverSource = fs.readFileSync(path.join(__dirname, '../..', 'zerochat.py'), 'utf8');
  assert.match(serverSource, new RegExp(`DEFAULT_PORT\\s*=\\s*${ChatUIMcp.DEFAULT_PORT}\\b`));
  assert.match(serverSource, /--port/);
});

test('ChatUIMcp - renderConnectionStatus actualiza badge, guía de arranque y detalles', () => {
  function createMockElements() {
    const attrs = {};
    const reconnectAttrs = {};
    return {
      statusBadge: { className: '' },
      statusText: {
        textContent: '',
        setAttribute: (k, v) => { attrs[k] = v; },
        getAttribute: (k) => attrs[k]
      },
      serverDetails: { style: {}, innerHTML: '', textContent: '', title: '' },
      bootstrapCard: { style: {} },
      reconnectHint: { style: {}, textContent: '', setAttribute: (k, v) => { reconnectAttrs[k] = v; } },
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
  assert.equal(elements.serverDetails.style.display, 'none');
  assert.equal(elements.bootstrapCard.style.display, 'block');
  assert.equal(elements.reconnectHint.style.display, 'block');
  assert.equal(elements.reconnectHint.textContent, 'Si el servidor se ha reiniciado, recarga esta página (F5) para volver a conectar.');
  assert.equal(elements.commandSnippet.textContent, 'curl -sL https://albalday.github.io/zerochat/zerochat.py -o zerochat.py && python3 zerochat.py');

  // 2. Estado conectando
  ChatUIMcp.renderConnectionStatus(elements, { status: 'connecting', host: '127.0.0.1', port: 6388 }, t);
  assert.equal(elements.statusBadge.className, 'mcp-status-badge mcp-status-connecting');
  assert.equal(elements.statusText.textContent, 'Conectando...');
  assert.equal(elements.statusText.getAttribute('data-i18n'), 'mcp_status_connecting');
  assert.equal(elements.bootstrapCard.style.display, 'block');
  assert.equal(elements.reconnectHint.style.display, 'none');

  // 3. Estado conectado
  ChatUIMcp.renderConnectionStatus(elements, {
    status: 'connected',
    host: '127.0.0.1',
    port: 6388,
    serverInfo: { name: 'mcp-proxy', version: '0.4.0' },
    latencyMs: 15,
    tools: [{ name: 't1' }, { name: 't2' }]
  }, t);
  assert.equal(elements.statusBadge.className, 'mcp-status-badge mcp-status-connected');
  assert.equal(elements.statusText.textContent, 'Conectado');
  assert.equal(elements.statusText.getAttribute('data-i18n'), 'mcp_status_connected');
  assert.equal(elements.serverDetails.style.display, 'inline-flex');
  assert.equal(elements.bootstrapCard.style.display, 'none');
  assert.equal(elements.reconnectHint.style.display, 'none');
  assert.ok(elements.serverDetails.title.includes('mcp-proxy v0.4.0'));
  assert.ok(elements.serverDetails.title.includes('15ms'));
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
  assert.equal(elements.bootstrapCard.style.display, 'block');
  assert.equal(elements.reconnectHint.style.display, 'none');
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

test('ChatUIMcp - initMcpUI publica el comando de arranque sin conexión manual', () => {
  const mockCommandSnippet = { textContent: '' };

  const elements = {
    commandSnippet: mockCommandSnippet,
    statusBadge: { className: '' },
    statusText: { textContent: '' },
    serverDetails: { style: {}, innerHTML: '' },
    bootstrapCard: { style: {} },
    btnCopyCmd: { addEventListener: () => {} }
  };

  const uiInstance = ChatUIMcp.initMcpUI(elements);
  assert.ok(uiInstance);
  assert.equal(mockCommandSnippet.textContent, 'curl -sL https://albalday.github.io/zerochat/zerochat.py -o zerochat.py && python3 zerochat.py');

  uiInstance.destroy();
});

test('ChatUIMcp - renderToolsList renderiza estado vacío cuando está desconectado o sin herramientas', () => {
  const previousState = ChatState.get('mcp');
  ChatState.set('mcp', { ...previousState, status: 'disconnected' });
  try {
    const container = {
      innerHTML: '',
      style: {}
    };

    ChatUIMcp.renderToolsList(container, [], {}, (k) => ChatI18n.t(k));
    assert.equal(container.style.display, 'block');
    assert.ok(container.innerHTML.includes('mcp-tools-empty'));
    assert.ok(container.innerHTML.includes('zerochat.py'));
  } finally {
    ChatState.set('mcp', previousState);
  }
});

test('ChatUIMcp - renderToolsList renderiza herramientas con switches y captura cambios', () => {
  const ChatConfig = require('../../js/config-store.js');
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
  const ChatMCP = require('../../js/mcp.js');
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
  const ChatToolSecurity = require('../../js/tool-security.js');
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
      id: 'mcp_test_tool_1',
      name: 'mcp_test_tool_1',
      metadata: { mcpServerName: 'srv1', originalName: 'tool1' }
    },
    {
      id: 'mcp_test_tool_2',
      name: 'mcp_test_tool_2',
      metadata: { mcpServerName: 'srv1', originalName: 'tool2' }
    }
  ];

  // Pre-autorizar tool 2
  ChatToolSecurity.manager.setToolPolicy('mcp_test_tool_2', 'allow', { serverName: 'srv1', originalName: 'tool2' });

  tools.forEach(tool => {
    const sel = {
      value: tool.id === 'mcp_test_tool_2' ? 'allow' : 'ask',
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
  selectListeners['mcp_test_tool_1_change']();
  assert.equal(ChatToolSecurity.manager.getToolPolicy('mcp_test_tool_1'), 'allow');
  assert.ok(mockSelects[0].className.includes('status-allowed'));

  // Cambiar tool 2 a 'ask' (revocar)
  mockSelects[1].value = 'ask';
  selectListeners['mcp_test_tool_2_change']();
  assert.equal(ChatToolSecurity.manager.getToolPolicy('mcp_test_tool_2'), null);
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

  // Simular escaneo de data-i18n al abrir una sección de configuración
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

test('ChatUIMcp - renderExternalServers muestra mensaje vacío si no hay servidores', () => {
  const container = { innerHTML: '' };
  ChatUIMcp.renderExternalServers(container, [], (k) => k);
  assert.ok(container.innerHTML.includes('mcp-servers-empty'));
  assert.ok(container.innerHTML.includes('mcp_servers_empty'));
});

test('ChatUIMcp - renderExternalServers renderiza tarjetas con badges y botón Iniciar/Detener individual', () => {
  const container = { innerHTML: '' };
  const mockServers = [
    {
      id: 'dummy_mcp',
      displayName: { es: 'Dummy MCP', en: 'Dummy MCP' },
      description: { es: 'Servidor de prueba', en: 'Test server' },
      status: 'stopped',
      toolCount: 0
    },
    {
      id: 'sqlite',
      displayName: { es: 'SQLite', en: 'SQLite' },
      description: { es: 'Base de datos', en: 'Database' },
      status: 'running',
      toolCount: 2
    }
  ];

  ChatUIMcp.renderExternalServers(container, mockServers, (k, p) => ChatI18n.t(k, p));
  assert.ok(container.innerHTML.includes('dummy_mcp'));
  assert.ok(container.innerHTML.includes('status-stopped'));
  assert.ok(container.innerHTML.includes('Iniciar'));
  assert.ok(container.innerHTML.includes('sqlite'));
  assert.ok(container.innerHTML.includes('status-running'));
  assert.ok(container.innerHTML.includes('Detener'));
  assert.ok(container.innerHTML.includes('2 herramientas activas'));
});
