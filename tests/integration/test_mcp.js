const test = require('node:test');
const assert = require('node:assert/strict');

// Cargar módulos
const AgentCore = require('../../js/agent-core.js');
const MCP = require('../../js/mcp.js');
const ChatState = require('../../js/state.js');

test('MCP - Descubrimiento y Mapeo de Herramientas (tools/list)', async () => {
  const originalFetch = global.fetch;

  try {
    global.fetch = async (url, options) => {
      const body = JSON.parse(options.body || '{}');
      if (body.method === 'initialize') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              protocolVersion: '2024-11-05',
              serverInfo: { name: 'Weather MCP Server', version: '1.2.0' },
              capabilities: { tools: {} }
            }
          })
        };
      }
      if (body.method === 'tools/list') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              tools: [
                {
                  name: 'get_weather_forecast',
                  description: 'Obtiene el pronóstico del tiempo para una ciudad.',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      city: { type: 'string', description: 'Nombre de la ciudad' },
                      days: { type: 'number', description: 'Días de previsión' }
                    },
                    required: ['city']
                  }
                }
              ]
            }
          })
        };
      }
      return { ok: false, status: 404, text: async () => 'Not Found' };
    };

    const client = new MCP.McpClient({
      id: 'weather_server',
      name: 'Weather MCP Server',
      url: 'https://mcp.weather.local/rpc'
    });

    const provider = new MCP.McpToolProvider(client);
    const tools = await provider.discoverTools();

    assert.equal(tools.length, 1);
    const weatherTool = tools[0];
    assert.equal(weatherTool.category, 'mcp');
    assert.ok(weatherTool.name.includes('weatherz5fzserver_get_weather_forecast'));
    assert.deepEqual(weatherTool.aliases, []);
    assert.equal(weatherTool.metadata.mcpServerName, 'Weather MCP Server');
    assert.equal(weatherTool.metadata.originalName, 'get_weather_forecast');
    assert.ok(weatherTool.parameters.required.includes('city'));

    // Registro en ToolRegistry
    const registry = new AgentCore.ToolRegistry();
    registry.registerProvider(provider);

    // Solo debe resolver por el nombre público completo.
    assert.equal(Boolean(registry.getTool('get_weather_forecast')), false);
    assert.ok(registry.getTool('weatherz5fzserver_get_weather_forecast'));

    const defs = registry.getActiveDefinitions(require('../../js/config-store.js').normalize({}));
    const weatherDef = defs.find(d => d.function.name.includes('get_weather_forecast'));
    assert.ok(weatherDef);
  } finally {
    global.fetch = originalFetch;
  }
});

test('MCP - Invocación de herramientas (tools/call) y conversión de resultados', async () => {
  const originalFetch = global.fetch;

  try {
    global.fetch = async (url, options) => {
      const body = JSON.parse(options.body || '{}');
      if (body.method === 'tools/call') {
        assert.equal(body.params.name, 'calculate_math');
        assert.equal(body.params.arguments.expression, '40 + 2');
        return {
          ok: true,
          status: 200,
          json: async () => ({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              content: [
                { type: 'text', text: 'Resultado: 42' }
              ],
              isError: false
            }
          })
        };
      }
      return { ok: false, status: 500 };
    };

    const client = new MCP.McpClient({
      id: 'math_server',
      name: 'Math Server',
      url: 'https://mcp.math.local/rpc'
    });

    const res = await client.callTool('calculate_math', { expression: '40 + 2' });
    assert.equal(res.success, true);
    assert.equal(res.isError, false);
    assert.equal(res.content, 'Resultado: 42');
    assert.ok(res.executionTimeMs >= 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test('MCP - Manejo de errores de servidor y respuestas con isError: true', async () => {
  const originalFetch = global.fetch;

  try {
    // 1. Error de protocolo JSON-RPC
    global.fetch = async (url, options) => {
      const body = JSON.parse(options.body || '{}');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          jsonrpc: '2.0',
          id: body.id,
          error: {
            code: -32601,
            message: 'Method not found'
          }
        })
      };
    };

    const client = new MCP.McpClient({
      id: 'err_server',
      name: 'Error Server',
      url: 'https://mcp.err.local/rpc'
    });

    await assert.rejects(
      async () => client.request('non_existent_method'),
      /MCP error \(-32601\): Method not found/
    );

    // 2. Respuesta con isError: true en tools/call
    global.fetch = async (url, options) => {
      const body = JSON.parse(options.body || '{}');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            content: [{ type: 'text', text: 'Parámetro inválido proporcionado' }],
            isError: true
          }
        })
      };
    };

    const callRes = await client.callTool('some_tool', { invalid: true });
    assert.equal(callRes.success, false);
    assert.equal(callRes.isError, true);
    assert.ok(callRes.content.includes('Parámetro inválido'));
  } finally {
    global.fetch = originalFetch;
  }
});

test('MCP - Timeout, Cancelación con AbortSignal y Truncado de Salida', async () => {
  const originalFetch = global.fetch;

  try {
    // Test de cancelación
    const client = new MCP.McpClient({
      id: 'slow_server',
      name: 'Slow Server',
      url: 'https://mcp.slow.local/rpc'
    });

    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      async () => client.request('tools/list', {}, { signal: controller.signal }),
      /(aborted|cancel)/i
    );

    // Test de truncado de salida con respuestas gigantes
    global.fetch = async (url, options) => {
      const body = JSON.parse(options.body || '{}');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            content: [{ type: 'text', text: 'X'.repeat(70000) }],
            isError: false
          }
        })
      };
    };

    const hugeRes = await client.callTool('large_dump', {});
    assert.equal(hugeRes.success, true);
    assert.ok(hugeRes.content.length <= 60100);
    assert.ok(hugeRes.content.includes('[... MCP content truncated due to size limit ...]') || hugeRes.content.includes('[... Contenido MCP truncado por límite de tamaño ...]'));
  } finally {
    global.fetch = originalFetch;
  }
});

test('MCP - conserva capturas Base64 como evidencia visual antes de truncar el texto', async () => {
  const originalFetch = global.fetch;
  const screenshotBase64 = 'A'.repeat(70000);

  try {
    const client = new MCP.McpClient({
      id: 'local_server',
      name: 'ZeroChat Local Server',
      url: 'https://mcp.local/rpc'
    });
    global.fetch = async (url, options) => {
      const body = JSON.parse(options.body || '{}');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            content: [{
              type: 'text',
              text: JSON.stringify({
                success: true,
                action: 'screenshot',
                mime_type: 'image/png',
                image_base64: screenshotBase64
              })
            }],
            isError: false
          }
        })
      };
    };

    const response = await client.callTool('browser_action', { action: 'screenshot' });
    assert.equal(response.image_base64, screenshotBase64);
    assert.equal(response.mime_type, 'image/png');
    assert.ok(response.content.includes('attached as visual evidence'));
    assert.equal(response.content.includes(screenshotBase64), false);
    assert.equal(response.content.includes('[... MCP content truncated due to size limit ...]'), false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('MCP - el cliente conserva sus cabeceras propias junto a las de ZeroChat', () => {
  const client = new MCP.McpClient({ id: 'test_local', url: 'http://localhost:8000/rpc', headers: { Authorization: 'Bearer test-secret-token' }, token: 'session' });
  const headers = client.buildHeaders();
  assert.equal(headers.Authorization, 'Bearer test-secret-token');
  assert.equal(headers['X-ZeroChat-Token'], 'session');
});

test('MCP - probeConnection acepta un endpoint activo y rechaza fallos de conexión, URL vacía y respuestas HTTP fallidas', async () => {
  {
    const originalFetch = global.fetch;

    try {
      global.fetch = async (url, options) => {
        const body = JSON.parse(options.body || '{}');
        if (body.method === 'initialize') {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              jsonrpc: '2.0',
              id: body.id,
              result: {
                protocolVersion: '2024-11-05',
                serverInfo: { name: 'mcp-proxy', version: '0.4.0' },
                capabilities: {}
              }
            })
          };
        }
        return { ok: false, status: 404 };
      };

      const res = await MCP.probeConnection('http://127.0.0.1:6388', { timeoutMs: 1000 });
      assert.equal(res.success, true);
      assert.equal(res.serverInfo.name, 'mcp-proxy');
      assert.equal(res.serverInfo.version, '0.4.0');
      assert.ok(typeof res.latencyMs === 'number');
    } finally {
      global.fetch = originalFetch;
    }
  }

  {
    const emptyRes = await MCP.probeConnection('');
    assert.equal(emptyRes.success, false);
    assert.match(emptyRes.error, /Invalid or empty URL/);

    const originalFetch = global.fetch;
    try {
      global.fetch = async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:6388');
      };

      const failRes = await MCP.probeConnection('http://127.0.0.1:6388', { timeoutMs: 500 });
      assert.equal(failRes.success, false);
      assert.match(failRes.error, /Cannot reach the local server/);
    } finally {
      global.fetch = originalFetch;
    }
  }

  {
    const originalFetch = global.fetch;
    try {
      global.fetch = async (_url, options = {}) => {
        if (options.method === 'POST') {
          return {
            ok: true,
            status: 200,
            json: async () => ({ jsonrpc: '2.0', error: { code: -32601, message: 'initialize unavailable' } })
          };
        }
        return { ok: false, status: 503, text: async () => 'Service unavailable' };
      };
      const result = await MCP.probeConnection('http://127.0.0.1:6388', { timeoutMs: 500 });
      assert.equal(result.success, false);
    } finally {
      global.fetch = originalFetch;
    }
  }
});

test('MCP - una comprobación de salud fallida degrada una conexión previamente activa', async () => {
  const originalFetch = global.fetch;
  const previousState = ChatState.get('mcp');
  const manager = new MCP.McpManager();
  try {
    ChatState.set('mcp', {
      ...previousState,
      status: 'connected',
      endpoint: 'http://127.0.0.1:6388',
      tools: [{ id: 'mcp_test_tool' }]
    });
    manager.target = { url: 'http://127.0.0.1:6388', proxyKey: null };
    global.fetch = async () => { throw new Error('ECONNREFUSED'); };

    const result = await manager.verifyProxyConnection({ timeoutMs: 500 });
    const state = ChatState.get('mcp');
    assert.equal(result.success, false);
    assert.equal(state.status, 'error');
    assert.equal(state.tools.length, 0);
    assert.match(state.error, /Cannot reach|ECONNREFUSED/i);
  } finally {
    global.fetch = originalFetch;
    ChatState.set('mcp', previousState);
  }
});

test('MCP - la conexión silenciosa del arranque conecta si el servidor está activo y queda desconectada si no', async () => {
  const originalFetch = global.fetch;

  try {
    // 1. Caso Servidor Inactivo / puerto cerrado
    global.fetch = async () => {
      throw new Error('fetch failed: ECONNREFUSED');
    };

    const resInactive = await MCP.manager.connectProxy({
      url: 'http://127.0.0.1:6388',
      timeoutMs: 500,
      silentOnFailure: true
    });

    assert.equal(resInactive.available, false);
    assert.equal(resInactive.success, false);

    // 2. Caso Servidor Activo
    global.fetch = async (url, options) => {
      const body = JSON.parse(options?.body || '{}');
      if (body.method === 'initialize') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              protocolVersion: '2024-11-05',
              serverInfo: { name: 'mcp-proxy-auto', version: '1.0.0' },
              capabilities: { tools: {} }
            }
          })
        };
      }
      if (body.method === 'tools/list') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              tools: [
                {
                  name: 'auto_tool',
                  description: 'Herramienta de prueba autoconectada',
                  inputSchema: { type: 'object', properties: {} }
                }
              ]
            }
          })
        };
      }
      return { ok: false, status: 404, text: async () => 'Not Found' };
    };

    const resActive = await MCP.manager.connectProxy({
      url: 'http://127.0.0.1:6388',
      timeoutMs: 1000,
      silentOnFailure: true
    });

    assert.equal(resActive.success, true);
    assert.equal(resActive.tools.length, 1);
    assert.ok(resActive.tools[0].name.includes('auto_tool'));
    assert.equal(resActive.tools[0].metadata.originalName, 'auto_tool');
  } finally {
    global.fetch = originalFetch;
    MCP.manager.setHeartbeatTimer(false);
    await MCP.manager.disconnectProxy();
  }
});

test('MCP - publicToolName codifica igual que el backend la tabla compartida', () => {
  // test_mcp_services.py comprueba la misma tabla contra public_tool_name de Python.
  for (const { server, tool, expected } of require('../fixtures/mcp/public-tool-names.json')) {
    let name = null;
    try { name = MCP.publicToolName(server, tool); } catch (_) {}
    assert.equal(name, expected, `${server}/${tool}`);
  }
});

test('MCP - proveedor, registro y permisos aíslan herramientas homónimas del host externo', async () => {
  const Security = require('../../js/tool-security.js');
  const servers = {
    browser_service: ['browser_navigate', 'read_file'],
    second: ['browser_navigate', 'read_file'],
    'a-b': ['read_file'], a_b: ['read_file'],
    a: ['b_read_file'], A: ['read_file'], az: ['read_file'],
    // Antes 'z5fz' se conservaba literal y colisionaba con '_' codificado.
    _: ['x'], z5fz: ['x'], Z: ['zip', 'z7az'],
    edge: ['read_file', 'readfile', 'Read_file', 'read-file', 'ñ'],
    composio: ['COMPOSIO_SEARCH_TOOLS']
  };
  // Host externo como lo publica el backend: nombre público y metadatos del servicio de origen.
  const rawTools = Object.entries(servers).flatMap(([server, names]) => names.map(originalName => ({
    name: MCP.publicToolName(server, originalName), metadata: { mcpServerId: server, originalName }
  })));
  const provider = new MCP.McpToolProvider({
    id: 'mcp_external', name: 'External host', initialize: async () => ({ success: true }),
    listTools: async () => rawTools,
    callTool: async (name, args) => {
      const { metadata } = rawTools.find(tool => tool.name === name);
      return { server: metadata.mcpServerId, name: metadata.originalName, arguments: args };
    }
  });
  const tools = await provider.discoverTools();
  assert.equal(new Set(tools.map(t => t.name)).size, tools.length);
  assert.equal(tools[0].name, 'browserz5fzservice_browser_navigate');
  assert.ok(tools.some(tool => tool.name === 'composio_COMPOSIO_SEARCH_TOOLS'),
    'los nombres remotos en mayúsculas deben conservarse legibles');
  const registry = new AgentCore.ToolRegistry();
  registry.registerProvider(provider);
  for (const tool of tools) {
    const direct = new MCP.McpToolProvider({
      id: tool.metadata.mcpServerId, initialize: async () => ({ success: true }),
      listTools: async () => [{ name: tool.metadata.originalName }]
    });
    assert.equal((await direct.discoverTools())[0].name, tool.name);
    const result = await registry.getTool(tool.name).execute({ value: 42 }, {});
    assert.equal(result.server, tool.metadata.mcpServerId);
    assert.equal(result.name, tool.metadata.originalName);
    assert.deepEqual(result.arguments, { value: 42 });
  }
  assert.equal(registry.getTool('read_file'), null);
  assert.equal(registry.getTool('mcpbrowserservicebrowsernavigate'), null);
  assert.equal(registry.getTool('mcp__browser_service__browser_navigate'), null);

  const previousStorage = global.localStorage;
  const saved = new Map();
  global.localStorage = { getItem: k => saved.get(k) || null, setItem: (k, v) => saved.set(k, v) };
  try {
    const first = new Security.ToolSecurityManager();
    first.setToolPolicy(tools[0].name, 'allow', { originalName: 'browser_navigate' });
    const restored = new Security.ToolSecurityManager();
    assert.equal(restored.evaluateAuthorization(tools[0], {}).status, 'allow');
    assert.equal(restored.evaluateAuthorization(tools[2], {}).requiresApproval, true);
    assert.equal(restored.getToolPolicy('browser_navigate'), null);
    assert.equal(restored.evaluateAuthorization('read_file', {}).requiresApproval, true);
  } finally {
    if (previousStorage === undefined) delete global.localStorage;
    else global.localStorage = previousStorage;
  }
  rawTools[0] = { ...rawTools[0], name: 'wrong_browser_navigate' };
  await assert.rejects(provider.discoverTools(), /Invalid external MCP public name/);
});

test('MCP - autorización externa muestra el servicio de origen y conserva permisos separados', async () => {
  const Security = require('../../js/tool-security.js');
  const provider = new MCP.McpToolProvider({
    id: 'mcp_external', name: 'ZeroChat External MCP Host',
    initialize: async () => ({ success: true }),
    listTools: async () => [
      ['composio', 'COMPOSIO_SEARCH_TOOLS'],
      ['composio', 'COMPOSIO_MULTI_EXECUTE_TOOL'],
      ['playwright', 'browser_navigate']
    ].map(([server, name]) => ({
      name: `${server}_${name}`,
      description: name === 'browser_navigate' ? 'Navigate to a URL' : undefined,
      metadata: { mcpServerId: server, originalName: name }
    }))
  });
  const [search, execute, browser] = await provider.discoverTools();
  const manager = new Security.ToolSecurityManager();
  for (const tool of [search, execute, browser]) {
    const auth = manager.evaluateAuthorization(tool, {});
    assert.equal(auth.serverName, tool.metadata.mcpServerId);
    assert.equal(auth.serverId, tool.metadata.mcpServerId);
    assert.equal(auth.requiresApproval, true);
    assert.equal(tool.description, tool === browser ? 'Navigate to a URL' : tool.metadata.originalName);
    assert.ok(tool.toMarkdown({}, {}).includes(auth.serverName));
    assert.ok(!tool.toMarkdown({}, {}).includes('ZeroChat External MCP Host'));
  }
  manager.setToolPolicy(search.name, 'allow');
  assert.equal(manager.evaluateAuthorization(search, {}).status, 'allow');
  assert.equal(manager.evaluateAuthorization(execute, {}).requiresApproval, true);
  assert.equal(manager.evaluateAuthorization(browser, {}).requiresApproval, true);
  const auth = manager.evaluateAuthorization(execute, {});
  manager.setServerPolicy(auth.serverId, 'allow', { serverName: auth.serverName });
  assert.equal(manager.listAuthorizedServers()[0].serverName, 'composio');
  assert.equal(manager.evaluateAuthorization(execute, {}).status, 'allow');
  assert.equal(manager.evaluateAuthorization(browser, {}).requiresApproval, true);
  manager.setToolPolicy(execute.name, 'deny');
  assert.equal(manager.evaluateAuthorization(execute, {}).status, 'deny');
});

test('MCP - nombres inválidos, duplicados y demasiado largos fallan explícitamente', async () => {
  for (const names of [[null], [''], ['x'.repeat(65)], ['read_file', 'read_file']]) {
    const provider = new MCP.McpToolProvider({ id: 'mcp_proxy', initialize: async () => ({ success: true }),
      listTools: async () => names.map(name => ({ name })) });
    await assert.rejects(provider.discoverTools(), /Invalid MCP|exceeds|Duplicate/);
  }
  const provider = new MCP.McpToolProvider({ id: 'mcp_proxy', initialize: async () => ({ success: true }),
    listTools: async () => [{ name: 'read_file' }] });
  assert.equal((await provider.discoverTools())[0].name, 'read_file');
});

/** Servidor local falso: responde initialize (con `liveState`), tools/list y el latido; `state.server` lo apaga o cambia su token. */
function fakeLocalServer(state) {
  return async (url, options) => {
    if (state.server === 'down') throw new TypeError('Failed to fetch');
    if (state.server === 'newToken') return { ok: false, status: 401, text: async () => 'Unauthorized' };
    const body = options?.body ? JSON.parse(options.body) : {};
    const reply = result => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, result }) });
    const external = String(url).endsWith('/mcp/external');
    if (body.method === 'initialize') {
      return reply({ protocolVersion: '2024-11-05', serverInfo: { name: external ? 'External MCP' : 'zerochat' }, capabilities: {}, ...(external ? {} : { liveState: state.live }) });
    }
    if (body.method === 'tools/list') {
      return reply({ tools: external
        ? [{ name: 'sqlite_query', description: 'Query SQLite', metadata: { mcpServerId: 'sqlite', originalName: 'query' } }]
        : [{ name: 'edit_file' }] });
    }
    if (body.method === 'zerochat/heartbeat') {
      state.beats = (state.beats || 0) + 1;
      return reply(state.live);
    }
    return reply({});
  };
}

test('MCP - connectProxy publica el estado vivo de initialize y registra las herramientas de los servicios externos en marcha', async t => {
  const state = { server: 'up', live: { cwd: '/repo', jobs: [], exit_on_close: true, servers: [{ id: 'sqlite', status: 'running', toolCount: 1, enabled: true }] } };
  t.mock.method(global, 'fetch', fakeLocalServer(state));
  const manager = new MCP.McpManager();
  try {
    const connResult = await manager.connectProxy({ url: 'http://127.0.0.1:6388', token: 'tok' });
    assert.equal(connResult.success, true);
    assert.equal(state.beats, undefined, 'sin esperar al latido');
    assert.equal(ChatState.get('mcp').exitOnClose, true);
    assert.deepEqual(ChatState.get('mcp').externalServers.map(server => server.id), ['sqlite']);
    assert.deepEqual(ChatState.get('mcp').externalTools.map(tool => tool.name), ['sqlite_query']);
    assert.ok(AgentCore.registry.getTool('sqlite_query'), 'sqlite_query debe estar registrada en el registry');

    // Reconectar connectProxy no debe destruir las herramientas externas
    const reconnectResult = await manager.connectProxy({ url: 'http://127.0.0.1:6388' });
    assert.equal(reconnectResult.success, true);
    assert.ok(AgentCore.registry.getTool('sqlite_query'), 'sqlite_query debe seguir registrada tras reconectar');

    // El latido es el método zerochat/heartbeat del servidor local.
    await manager.sendHeartbeat();
    assert.equal(state.beats, 1);
    await manager.disconnectProxy();
  } finally {
    manager.setHeartbeatTimer(false);
  }
});

test('MCP - con sesión, el latido conecta cuando el servidor local arranca o vuelve tras un reinicio', async t => {
  const state = { server: 'down', live: { cwd: '/repo', jobs: [], exit_on_close: true, servers: [] } };
  t.mock.method(global, 'fetch', fakeLocalServer(state));
  const manager = new MCP.McpManager();
  try {
    // La página abre con la sesión guardada y el servidor apagado: el latido queda vigilando.
    const failed = await manager.connectProxy({ url: 'http://127.0.0.1:6388', token: 'tok' });
    assert.equal(failed.success, false);
    assert.equal(ChatState.get('mcp').status, 'error');
    assert.ok(manager.heartbeatTimer, 'el latido vigila el destino aunque la conexión falle');

    // Mientras sigue caído, el latido no cambia el estado.
    const downState = ChatState.get('mcp');
    await manager.sendHeartbeat();
    assert.deepEqual(ChatState.get('mcp'), downState);

    // El servidor arranca: el latido conecta.
    state.server = 'up';
    await manager.sendHeartbeat();
    assert.equal(ChatState.get('mcp').status, 'connected');

    // El servidor cae: el latido lo detecta y sigue en marcha.
    state.server = 'down';
    await manager.sendHeartbeat();
    assert.equal(ChatState.get('mcp').status, 'error');
    assert.equal(manager.isProxyConnected(), false);
    assert.ok(manager.heartbeatTimer);

    // Vuelve con otro token diario: se pide identificarse en lugar de mostrar el fallo de red anterior.
    state.server = 'newToken';
    await manager.sendHeartbeat();
    assert.equal(ChatState.get('mcp').status, 'login_required');
    assert.match(ChatState.get('mcp').error, /HTTP 401/);

    // Vuelve aceptando la sesión: el siguiente latido reconecta sin recargar la página.
    state.server = 'up';
    await manager.sendHeartbeat();
    assert.equal(ChatState.get('mcp').status, 'connected');
    assert.equal(manager.isProxyConnected(), true);
  } finally {
    manager.setHeartbeatTimer(false);
  }
});

test('MCP - un 401 pide identificarse y zerochat/login da el token con el que se conecta, a través del proxy si se usa', async t => {
  const requests = [];
  let validToken = 'hoy';
  t.mock.method(global, 'fetch', async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url, method: body.method, headers: options.headers, params: body.params });
    const reply = result => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, result }) });
    if (body.method === 'zerochat/login') {
      return body.params.password === 'buena'
        ? reply({ token: validToken })
        : { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, error: { code: -32001, message: 'Usuario o contraseña incorrectos.' } }) };
    }
    if (options.headers['X-ZeroChat-Token'] !== validToken) return { ok: false, status: 401, text: async () => 'Unauthorized' };
    if (body.method === 'initialize') return reply({ protocolVersion: '2024-11-05', serverInfo: { name: 'zerochat' }, capabilities: {}, liveState: { exit_on_close: false, servers: [] } });
    return reply(body.method === 'tools/list' ? { tools: [] } : {});
  });
  const manager = new MCP.McpManager();
  const url = 'https://zerochat.example';
  try {
    // Sesión de ayer: también en la conexión silenciosa del arranque se pide identificarse.
    const expired = await manager.connectProxy({ url, proxyKey: 'clave-caddy', token: 'ayer', silentOnFailure: true });
    assert.equal(expired.success, false);
    assert.equal(ChatState.get('mcp').status, 'login_required');

    await assert.rejects(manager.login('ana', 'mala'), error => error.rpcError?.code === -32001);
    assert.equal(await manager.login('ana', 'buena'), 'hoy');
    const login = requests.filter(request => request.method === 'zerochat/login').at(-1);
    assert.equal(login.url, url);
    assert.deepEqual(login.params, { user: 'ana', password: 'buena' });

    assert.equal((await manager.connectProxy({ url, proxyKey: 'clave-caddy', token: 'hoy' })).success, true);
    assert.equal(ChatState.get('mcp').status, 'connected');
    // Con el proxy, Authorization lleva su clave y X-ZeroChat-Proxy lo enruta; el token va en X-ZeroChat-Token.
    for (const request of requests) {
      assert.equal(request.headers['X-ZeroChat-Proxy'], '1', request.method);
      assert.equal(request.headers.Authorization, 'Bearer clave-caddy', request.method);
    }
    assert.equal(requests.at(-1).headers['X-ZeroChat-Token'], 'hoy');

    // El token caduca con la conexión abierta: el latido lo detecta y pide identificarse de nuevo.
    validToken = 'mañana';
    await manager.onPageVisible();
    assert.equal(ChatState.get('mcp').status, 'login_required');
    assert.equal(manager.isProxyConnected(), false);

    // Sin proxy no se envía su cabecera.
    requests.length = 0;
    await manager.connectProxy({ url: 'http://127.0.0.1:6388', token: 'mañana' });
    assert.equal(requests[0].headers['X-ZeroChat-Proxy'], undefined);
  } finally {
    manager.setHeartbeatTimer(false);
    await manager.disconnectProxy();
  }
});

test('MCP - sin auto-cierre no hay temporizador de latido: el estado se relee y se reconecta al volver a la pestaña', async t => {
  const state = { server: 'up', live: { cwd: '/repo', jobs: [], exit_on_close: false, servers: [] } };
  t.mock.method(global, 'fetch', fakeLocalServer(state));
  const manager = new MCP.McpManager();
  try {
    assert.equal((await manager.connectProxy({ url: 'http://127.0.0.1:6388', token: 'tok' })).success, true);
    assert.equal(manager.heartbeatTimer, null);

    // Otra pestaña cambia el directorio: se ve al volver a esta.
    state.live = { ...state.live, cwd: '/otro' };
    await manager.onPageVisible();
    assert.equal(state.beats, 1);
    assert.equal(ChatState.get('mcp').serverInfo.cwd, '/otro');

    // El servidor se reinicia mientras la pestaña está oculta: al volver se reconecta.
    state.server = 'down';
    await manager.onPageVisible();
    assert.equal(ChatState.get('mcp').status, 'error');
    // Ya desconectado, la conexión fallida no arranca el latido periódico.
    await manager.connectProxy({ url: 'http://127.0.0.1:6388' });
    assert.equal(manager.heartbeatTimer, null);
    state.server = 'up';
    await manager.onPageVisible();
    assert.equal(ChatState.get('mcp').status, 'connected');

    // Con un servidor con auto-cierre vuelve el temporizador y la vuelta a la pestaña no añade lecturas.
    state.live = { ...state.live, exit_on_close: true };
    await manager.connectProxy({ url: 'http://127.0.0.1:6388' });
    assert.ok(manager.heartbeatTimer);
    const beats = state.beats;
    await manager.onPageVisible();
    assert.equal(state.beats, beats);
  } finally {
    manager.setHeartbeatTimer(false);
    await manager.disconnectProxy();
  }
});

test('MCP - una lectura del latido colgada se corta al cumplirse su intervalo para no bloquear los siguientes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(global, 'fetch', (url, options) => new Promise((_, reject) => {
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  }));
  const manager = new MCP.McpManager();
  manager.clients.set('mcp_proxy', new MCP.McpClient({ id: 'mcp_proxy', url: 'http://127.0.0.1:6388', token: 'tok' }));

  let settled = false;
  const read = manager.readLiveState().finally(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(9999);
  await Promise.resolve();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  await assert.rejects(read, { name: 'AbortError' });
});

test('MCP - startExternalServer espera instalaciones largas y limita cada fase', async () => {
  const originalSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms, ...args) => (ms === 15000 ? setImmediate(fn, ...args) : originalSetTimeout(fn, ms, ...args));
  const timeout = () => Object.assign(new Error('timeout'), { code: 'MCP_REQUEST_TIMEOUT' });
  const run = async (phases) => {
    const manager = new MCP.McpManager();
    const waits = [];
    let polls = 0;
    manager.requestExternalControl = async () => { throw timeout(); };
    manager.readLiveState = async () => {
      const status = phases[Math.min(polls, phases.length - 1)];
      polls += 1;
      return { servers: [{ id: 'playwright', status }] };
    };
    const result = await manager.startExternalServer('playwright', (attempt, total, status) => waits.push({ attempt, total, status }), { remember: true });
    return { result, waits };
  };
  try {
    const install = [...Array(30).fill('installing'), ...Array(5).fill('starting'), 'running'];
    const { result, waits } = await run(install);
    assert.equal(result.servers[0].status, 'running');
    assert.deepEqual(waits[29], { attempt: 30, total: 80, status: 'installing' });
    assert.deepEqual(waits[30], { attempt: 1, total: 10, status: 'starting' });

    await assert.rejects(run(Array(20).fill('starting')), error => (
      error.code === 'EXTERNAL_START_WAIT_TIMEOUT' && error.externalServer.status === 'starting'
    ));
  } finally {
    global.setTimeout = originalSetTimeout;
  }
});

test('MCP - applyLiveState publica el estado vivo del servidor y solo escribe lo que cambia', async t => {
  const Security = require('../../js/tool-security.js');
  const previousState = ChatState.get('mcp');
  const manager = new MCP.McpManager();
  const startup = t.mock.method(Security.manager, 'setStartupDirectory', () => {});
  try {
    ChatState.set('mcp', { ...previousState, status: 'connected', serverInfo: { name: 'ZeroChat', cwd: '/repo' }, commandJobs: [], exitOnClose: false, playwright: null });
    const provider = new MCP.McpToolProvider({ id: 'mcp_proxy', name: 'ZeroChat', initialize: async () => ({ success: true }), listTools: async () => [{ name: 'browser_action' }] });
    const [browserAction] = await provider.discoverTools();
    assert.equal(browserAction.isAvailable(), false, 'Sin latido no se sabe si hay Playwright');
    assert.equal(MCP.playwrightInstalled(), null);

    const writes = [];
    const unsubscribe = ChatState.subscribe('mcp', value => writes.push(value));
    const jobs = [
      { id: 1, key: 'inv-a', command: 'npm run dev', status: 'running', started_at: 1000, background: true, elapsed_s: 3 },
      { id: 2, command: 'npm test', status: 'exited', started_at: 2000, background: true },
      { id: 4, command: 'npm run build', status: 'running', started_at: 3000, background: false },
      { id: 'x', command: 'malo', status: 'running', background: true }
    ];
    const heartbeat = { ok: true, cwd: '/otro', jobs, exit_on_close: true, playwright: { installed: true, browserAction: { available: true, extra: 1 } } };
    assert.equal(await manager.applyLiveState(heartbeat), true);
    assert.equal(writes.length, 1, 'Un latido es una sola escritura');
    const mcp = ChatState.get('mcp');
    // Solo los de segundo plano: un comando esperado ya se ve en su tarjeta.
    assert.deepEqual(mcp.commandJobs, [{ id: 1, command: 'npm run dev', startedAt: 1000 }]);
    assert.equal(mcp.exitOnClose, true);
    assert.equal(mcp.serverInfo.cwd, '/otro');
    assert.deepEqual(startup.mock.calls.map(call => call.arguments[0]), ['/otro']);
    assert.deepEqual(mcp.playwright, { installed: true, browserAction: { available: true } });
    assert.equal(browserAction.isAvailable(), true);
    // El mismo estado con otro tiempo transcurrido no vuelve a escribir.
    assert.equal(await manager.applyLiveState({ ...heartbeat, jobs: [{ ...jobs[0], elapsed_s: 13 }] }), false);
    assert.equal(writes.length, 1);

    // Un control solo trae su campo y deja el resto como estaba.
    const requests = [];
    manager.clients.set('mcp_proxy', {
      request: async method => {
        requests.push(method);
        return { jobs: [] };
      }
    });
    assert.equal(await manager.refreshCommandJobs(), true);
    assert.deepEqual(requests, ['zerochat/jobs/list']);
    assert.deepEqual(ChatState.get('mcp').commandJobs, []);
    assert.equal(ChatState.get('mcp').exitOnClose, true);
    // Sin Chromium, o con el servicio quitado durante la sesión, browser_action deja de estar disponible.
    assert.equal(await manager.applyLiveState({ playwright: { installed: true, browserAction: { available: false, error: 'Playwright Chromium is not installed.' } } }), true);
    assert.equal(browserAction.isAvailable(), false);
    assert.equal(await manager.applyLiveState({ playwright: { installed: false, browserAction: { available: false } } }), true);
    assert.equal(MCP.playwrightInstalled(), false);
    assert.equal(await manager.applyLiveState({ playwright: { browserAction: { available: true } } }), false, 'Playwright sin installed no se publica');

    // Los servicios externos: solo se escriben si cambia lo que informa el servidor, y sus
    // herramientas se vuelven a registrar solo si cambian los que están en marcha.
    const refresh = t.mock.method(manager, 'refreshExternalTools', async () => {});
    const servers = [{ id: 'memory', status: 'running', toolCount: 3 }, { id: 'ejemplo', status: 'stopped', toolCount: 0 }];
    assert.equal(await manager.applyLiveState({ servers }), true);
    assert.deepEqual(ChatState.get('mcp').externalServers, servers);
    assert.deepEqual(refresh.mock.calls.map(call => call.arguments[0]), [true]);
    // Lo que muestra la interfaz de una acción en curso sigue mientras el servidor no cambie.
    ChatState.set('mcp', { externalServers: [servers[0], { ...servers[1], status: 'starting', startWait: { attempt: 1, total: 10 } }] });
    assert.equal(await manager.applyLiveState({ servers }), false);
    assert.equal(ChatState.get('mcp').externalServers[1].status, 'starting');
    // Uno empieza a arrancar: cambia la lista pero no las herramientas.
    const starting = [servers[0], { ...servers[1], status: 'starting' }];
    assert.equal(await manager.applyLiveState({ servers: starting }), true);
    assert.deepEqual(ChatState.get('mcp').externalServers, starting);
    assert.equal(refresh.mock.callCount(), 1);
    // El que estaba en marcha muere: se retiran sus herramientas.
    await manager.applyLiveState({ servers: [{ ...servers[0], status: 'error', toolCount: 0 }, starting[1]] });
    assert.deepEqual(refresh.mock.calls.map(call => call.arguments[0]), [true, false]);
    unsubscribe?.();

    ChatState.set('mcp', { ...ChatState.get('mcp'), status: 'disconnected' });
    assert.equal(await manager.applyLiveState(heartbeat), false, 'sin conexión no se publica');
  } finally {
    ChatState.set('mcp', previousState);
  }
});

test('MCP - buildCommandNotes redacta en inglés los comandos en segundo plano terminados sin que el modelo lo viera', async () => {
  const manager = new MCP.McpManager();
  const requests = [];
  manager.clients.set('mcp_proxy', {
    request: async (method, params) => {
      requests.push({ method, params });
      return { reports: [
        { id: 4, command: 'npm test\necho fin', status: 'exited', exit_code: 1, elapsed_s: 192, stop_reason: null, tail: 'FAIL a.test.js\n1 failed', log_file: '/tmp/z/job-4.log' },
        { id: 6, command: 'npm run dev', status: 'stopped', exit_code: -15, elapsed_s: 30, stop_reason: 'user', tail: '', log_file: '/tmp/z/job-6.log' }
      ] };
    }
  });
  const tool = (name, data) => ({ role: 'tool', name, tool_call_id: `c${Math.random()}`, content: JSON.stringify(data) });
  const messages = [
    { role: 'user', content: 'lanza las pruebas' },
    tool('run_command', { success: true, status: 'running', job_id: 4, output: '' }),
    tool('run_command', { success: true, status: 'running', job_id: 5, output: '' }),
    tool('check_command', { success: true, status: 'exited', job_id: 5, exit_code: 0, new_output: '' }),
    tool('run_command', { success: true, status: 'running', job_id: 6, output: '' }),
    tool('read_file', { success: true, status: 'running', job_id: 7 }),
    { role: 'tool', name: 'run_command', content: 'Error MCP (-32602): Argumento no permitido: cwd' }
  ];
  const note = await manager.buildCommandNotes(messages);
  assert.deepEqual(requests, [{ method: 'zerochat/jobs/report', params: { ids: [4, 6] } }]);
  assert.equal(note, [
    'Background commands that finished since your last turn:',
    '- job_id 4 `npm test` exited with code 1 after 3:12.',
    '  Last lines:',
    '    FAIL a.test.js',
    '    1 failed',
    '- job_id 6 `npm run dev` was stopped by the user after 30 s.',
    'For more output, read the log file with read_file or search_files: job_id 4: /tmp/z/job-4.log; job_id 6: /tmp/z/job-6.log.'
  ].join('\n'));

  // Sin comandos pendientes no se consulta al servidor; si falla, no hay nota.
  requests.length = 0;
  assert.equal(await manager.buildCommandNotes(messages.slice(0, 1)), '');
  assert.equal(requests.length, 0);
  manager.clients.set('mcp_proxy', { request: async () => { throw new Error('offline'); } });
  assert.equal(await manager.buildCommandNotes(messages), '');
});
