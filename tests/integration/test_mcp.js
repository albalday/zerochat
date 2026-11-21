const test = require('node:test');
const assert = require('node:assert/strict');

// Cargar módulos
const AgentCore = require('../../js/agent-core.js');
const MCP = require('../../js/mcp.js');
const ChatState = require('../../js/state.js');

test('MCP - Descubrimiento, invocación, errores JSON-RPC y cabeceras del cliente', async () => {
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
      if (body.method === 'tools/call') {
        if (body.params.arguments?.invalid) {
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
        }
        assert.equal(body.params.name, 'calculate_math');
        assert.equal(body.params.arguments.expression, '40 + 2');
        return {
          ok: true,
          status: 200,
          json: async () => ({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              content: [{ type: 'text', text: 'Resultado: 42' }],
              isError: false
            }
          })
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          jsonrpc: '2.0',
          id: body.id,
          error: { code: -32601, message: 'Method not found' }
        })
      };
    };

    const client = new MCP.McpClient({
      id: 'weather_server',
      name: 'Weather MCP Server',
      url: 'https://mcp.weather.local/rpc',
      headers: { Authorization: 'Bearer test-secret-token' },
      token: 'session'
    });
    assert.equal(client.buildHeaders().Authorization, 'Bearer test-secret-token');
    assert.equal(client.buildHeaders()['X-ZeroChat-Token'], 'session');

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

    const registry = new AgentCore.ToolRegistry();
    registry.registerProvider(provider);
    assert.equal(Boolean(registry.getTool('get_weather_forecast')), false);
    assert.ok(registry.getTool('weatherz5fzserver_get_weather_forecast'));
    const defs = registry.getActiveDefinitions(require('../../js/config-store.js').normalize({}));
    assert.ok(defs.find(d => d.function.name.includes('get_weather_forecast')));

    const res = await client.callTool('calculate_math', { expression: '40 + 2' });
    assert.equal(res.success, true);
    assert.equal(res.isError, false);
    assert.equal(res.content, 'Resultado: 42');

    await assert.rejects(() => client.request('non_existent_method'), /MCP error \(-32601\): Method not found/);
    const callRes = await client.callTool('some_tool', { invalid: true });
    assert.equal(callRes.success, false);
    assert.equal(callRes.isError, true);
    assert.ok(callRes.content.includes('Parámetro inválido'));
  } finally {
    global.fetch = originalFetch;
  }
});

test('MCP - Cancelación con AbortSignal, truncado de salida y capturas Base64 como evidencia visual', async () => {
  const originalFetch = global.fetch;
  const screenshotBase64 = 'A'.repeat(70000);

  try {
    const client = new MCP.McpClient({
      id: 'local_server',
      name: 'ZeroChat Local Server',
      url: 'https://mcp.local/rpc'
    });

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => client.request('tools/list', {}, { signal: controller.signal }),
      /(aborted|cancel)/i
    );

    global.fetch = async (url, options) => {
      const body = JSON.parse(options.body || '{}');
      const text = body.params?.name === 'browser_action'
        ? JSON.stringify({ success: true, action: 'screenshot', mime_type: 'image/png', image_base64: screenshotBase64 })
        : 'X'.repeat(70000);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          jsonrpc: '2.0',
          id: body.id,
          result: { content: [{ type: 'text', text }], isError: false }
        })
      };
    };

    const hugeRes = await client.callTool('large_dump', {});
    assert.equal(hugeRes.success, true);
    assert.ok(hugeRes.content.length <= 60100);
    assert.ok(hugeRes.content.includes('[... MCP content truncated due to size limit ...]') || hugeRes.content.includes('[... Contenido MCP truncado por límite de tamaño ...]'));

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

test('MCP - probeConnection, degradación por salud fallida y conexión silenciosa del arranque', async () => {
  const originalFetch = global.fetch;
  const previousState = ChatState.get('mcp');

  try {
    const emptyRes = await MCP.probeConnection('');
    assert.equal(emptyRes.success, false);
    assert.match(emptyRes.error, /Invalid or empty URL/);

    global.fetch = async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:6388'); };
    const failRes = await MCP.probeConnection('http://127.0.0.1:6388', { timeoutMs: 500 });
    assert.equal(failRes.success, false);
    assert.match(failRes.error, /Cannot reach the local server/);

    const manager = new MCP.McpManager();
    ChatState.set('mcp', { ...previousState, status: 'connected', endpoint: 'http://127.0.0.1:6388', tools: [{ id: 'mcp_test_tool' }] });
    manager.target = { url: 'http://127.0.0.1:6388', proxyKey: null };
    const degraded = await manager.verifyProxyConnection({ timeoutMs: 500 });
    assert.equal(degraded.success, false);
    assert.equal(ChatState.get('mcp').status, 'error');
    assert.equal(ChatState.get('mcp').tools.length, 0);

    const resInactive = await MCP.manager.connectProxy({ url: 'http://127.0.0.1:6388', timeoutMs: 500, silentOnFailure: true });
    assert.equal(resInactive.available, false);
    assert.equal(resInactive.success, false);

    global.fetch = async (_url, options = {}) => {
      if (options.method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', error: { code: -32601, message: 'initialize unavailable' } }) };
      }
      return { ok: false, status: 503, text: async () => 'Service unavailable' };
    };
    assert.equal((await MCP.probeConnection('http://127.0.0.1:6388', { timeoutMs: 500 })).success, false);

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
              tools: [{ name: 'auto_tool', description: 'Herramienta de prueba autoconectada', inputSchema: { type: 'object', properties: {} } }]
            }
          })
        };
      }
      return { ok: false, status: 404, text: async () => 'Not Found' };
    };

    const probeOk = await MCP.probeConnection('http://127.0.0.1:6388', { timeoutMs: 1000 });
    assert.equal(probeOk.success, true);
    assert.equal(probeOk.serverInfo.name, 'mcp-proxy-auto');

    const resActive = await MCP.manager.connectProxy({ url: 'http://127.0.0.1:6388', timeoutMs: 1000, silentOnFailure: true });
    assert.equal(resActive.success, true);
    assert.equal(resActive.tools.length, 1);
    assert.equal(resActive.tools[0].metadata.originalName, 'auto_tool');
  } finally {
    global.fetch = originalFetch;
    MCP.manager.setLiveStateWatch(false);
    await MCP.manager.disconnectProxy();
    ChatState.set('mcp', previousState);
  }
});

test('MCP - publicToolName, aislamiento de herramientas homónimas y validación de nombres', async () => {
  // test_mcp_services.py comprueba la misma tabla contra public_tool_name de Python.
  for (const { server, tool, expected } of require('../fixtures/mcp/public-tool-names.json')) {
    let name = null;
    try { name = MCP.publicToolName(server, tool); } catch (_) {}
    assert.equal(name, expected, `${server}/${tool}`);
  }

  for (const names of [[null], [''], ['x'.repeat(65)], ['read_file', 'read_file']]) {
    const badProvider = new MCP.McpToolProvider({ id: 'mcp_proxy', initialize: async () => ({ success: true }),
      listTools: async () => names.map(name => ({ name })) });
    await assert.rejects(badProvider.discoverTools(), /Invalid MCP|exceeds|Duplicate/);
  }

  const Security = require('../../js/tool-security.js');
  const servers = {
    browser_service: ['browser_navigate', 'read_file'],
    second: ['browser_navigate', 'read_file'],
    'a-b': ['read_file'], a_b: ['read_file'],
    a: ['b_read_file'], A: ['read_file'], az: ['read_file'],
    _: ['x'], z5fz: ['x'], Z: ['zip', 'z7az'],
    edge: ['read_file', 'readfile', 'Read_file', 'read-file', 'ñ'],
    composio: ['COMPOSIO_SEARCH_TOOLS']
  };
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
  assert.ok(tools.some(tool => tool.name === 'composio_COMPOSIO_SEARCH_TOOLS'));
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

  const restored = new Security.ToolSecurityManager();
  restored.applyPolicies({ tools: { [tools[0].name]: { policy: 'allow', originalName: 'browser_navigate' } } });
  assert.equal(restored.getToolPolicy(tools[0].name), 'allow');
  assert.equal(restored.getToolPolicy(tools[2].name), null);
  assert.equal(restored.getToolPolicy('browser_navigate'), null);
  assert.equal(restored.getToolPolicy('read_file'), null);
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
  const mockClient = {
    async request(method, patch) {
      const tools = { ...(mockClient.state.tools || {}) };
      if (patch.tools) {
        Object.entries(patch.tools).forEach(([k, v]) => { if (v === null) delete tools[k]; else tools[k] = v; });
      }
      const servers = { ...(mockClient.state.servers || {}) };
      if (patch.servers) {
        Object.entries(patch.servers).forEach(([k, v]) => { if (v === null) delete servers[k]; else servers[k] = v; });
      }
      mockClient.state = { ...mockClient.state, ...patch, tools, servers };
      return { policies: mockClient.state };
    },
    state: {}
  };
  manager.setMcpClient(mockClient);
  for (const tool of [search, execute, browser]) {
    assert.equal(tool.description, tool === browser ? 'Navigate to a URL' : tool.metadata.originalName);
    assert.ok(tool.toMarkdown({}, {}).includes(tool.metadata.mcpServerId));
    assert.ok(!tool.toMarkdown({}, {}).includes('ZeroChat External MCP Host'));
  }
  await manager.setToolPolicy(search.name, 'allow');
  assert.equal(manager.getToolPolicy(search.name), 'allow');
  assert.equal(manager.getToolPolicy(execute.name), null);
  await manager.setServerPolicy('composio', 'allow', { serverName: 'composio' });
  assert.equal(manager.listAuthorizedServers()[0].serverName, 'composio');
  assert.equal(manager.getServerPolicy('composio'), 'allow');
  await manager.setToolPolicy(execute.name, 'deny');
  assert.equal(manager.getToolPolicy(execute.name), 'deny');
});

/** Servidor local falso: responde initialize (con `tools`, `policies` y `liveState`) y el latido; `state.server` lo apaga o cambia su token. */
function fakeLocalServer(state) {
  return async (url, options) => {
    if (state.server === 'down') throw new TypeError('Failed to fetch');
    if (state.server === 'newToken') return { ok: false, status: 401, text: async () => 'Unauthorized' };
    const body = options?.body ? JSON.parse(options.body) : {};
    const reply = result => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, result }) });
    const liveState = state.live ? {
      externalTools: [{ name: 'sqlite_query', description: 'Query SQLite', metadata: { mcpServerId: 'sqlite', originalName: 'query' } }],
      ...state.live
    } : null;
    if (body.method === 'initialize') {
      return reply({
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'zerochat' },
        capabilities: {},
        tools: [{ name: 'edit_file' }],
        policies: state.policies || { allowAll: false, directoryRules: ['RWX:/repo/**'] },
        liveState
      });
    }
    if (body.method === 'zerochat/heartbeat') {
      state.beats = (state.beats || 0) + 1;
      return reply(liveState);
    }
    return reply({});
  };
}

test('MCP - connectProxy publica el estado vivo de initialize y registra las herramientas de los servicios externos en marcha', async t => {
  const Security = require('../../js/tool-security.js');
  const state = { server: 'up', live: { cwd: '/repo', jobs: [], exit_on_close: true, servers: [{ id: 'sqlite', status: 'running', toolCount: 1 }] } };
  const fetchMock = t.mock.method(global, 'fetch', fakeLocalServer(state));
  const manager = new MCP.McpManager();
  try {
    const connResult = await manager.connectProxy({ url: 'http://127.0.0.1:6388', token: 'tok' });
    assert.equal(connResult.success, true);
    assert.equal(fetchMock.mock.callCount(), 1, 'Una sola petición (initialize) trae herramientas locales, externas y políticas');
    assert.deepEqual(Security.manager.getDirectoryRules(), ['RWX:/repo/**']);
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
    const beatsBefore = state.beats || 0;
    await manager.sendHeartbeat();
    assert.ok(state.beats > beatsBefore);
    await manager.disconnectProxy();
  } finally {
    manager.setLiveStateWatch(false);
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
    assert.notEqual(manager.liveWatchAbort, null, 'el seguimiento vigila el destino aunque la conexión falle');

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
    assert.notEqual(manager.liveWatchAbort, null);

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
    manager.setLiveStateWatch(false);
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
    manager.setLiveStateWatch(false);
    await manager.disconnectProxy();
  }
});

test('MCP - el latido periódico y la vuelta a la pestaña funcionan igual con y sin auto-cierre', async t => {
  const state = { server: 'up', live: { cwd: '/repo', jobs: [], exit_on_close: false, servers: [] } };
  t.mock.method(global, 'fetch', fakeLocalServer(state));
  const manager = new MCP.McpManager();
  try {
    assert.equal((await manager.connectProxy({ url: 'http://127.0.0.1:6388', token: 'tok' })).success, true);
    assert.notEqual(manager.liveWatchAbort, null, 'sin auto-cierre también hay seguimiento activo');

    // Otra pestaña cambia el directorio: se ve al volver a esta sin esperar al siguiente tick.
    state.live = { ...state.live, cwd: '/otro' };
    const beatsBefore = state.beats || 0;
    await manager.onPageVisible();
    assert.ok(state.beats > beatsBefore);
    assert.equal(ChatState.get('mcp').serverInfo.cwd, '/otro');

    // El servidor se reinicia: al volver se detecta la caída y luego reconecta.
    state.server = 'down';
    await manager.onPageVisible();
    assert.equal(ChatState.get('mcp').status, 'error');
    assert.notEqual(manager.liveWatchAbort, null);
    state.server = 'up';
    await manager.onPageVisible();
    assert.equal(ChatState.get('mcp').status, 'connected');

    // Con auto-cierre también relee enseguida al volver a la pestaña.
    state.live = { ...state.live, exit_on_close: true };
    await manager.connectProxy({ url: 'http://127.0.0.1:6388' });
    assert.notEqual(manager.liveWatchAbort, null);
    const beats = state.beats || 0;
    await manager.onPageVisible();
    assert.ok(state.beats > beats);
  } finally {
    manager.setLiveStateWatch(false);
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
  t.mock.timers.tick(29999);
  await Promise.resolve();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  await assert.rejects(read, { name: 'AbortError' });
});

function makeAbortError() {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

async function flushMicrotasks() {
  await new Promise(resolve => setImmediate(resolve));
}

test('ChatMCP - start: resuelve timeouts con wait, propaga errores inmediatos y rechaza estados terminales', async t => {
  const manager = MCP.manager;

  for (const errFactory of [() => makeAbortError(), () => Object.assign(new Error('HTTP response timed out'), { code: 'MCP_REQUEST_TIMEOUT' })]) {
    let calls = 0;
    const req = t.mock.method(manager, 'requestExternalControl', async method => {
      calls += 1;
      if (method === 'zerochat/external/servers/start') throw errFactory();
      if (method === 'zerochat/external/servers/wait') return { servers: [{ id: 'ejemplo', status: 'running' }], rev: 'r1' };
      throw new Error(`Unexpected method ${method}`);
    });
    const waits = [];
    const res = await manager.startExternalServer('ejemplo', (a, tot) => waits.push([a, tot]));
    assert.equal(res.servers[0].status, 'running');
    assert.deepEqual(waits, []);
    assert.equal(calls, 2);
    req.mock.restore();
  }

  // Estados terminales o fallo al consultar wait rechazan sin esperar.
  let waits = 0;
  for (const status of ['error', 'available', 'stopped', undefined]) {
    const req = t.mock.method(manager, 'requestExternalControl', async method => {
      if (method === 'zerochat/external/servers/start') throw makeAbortError();
      return { servers: status ? [{ id: 'ejemplo', status }] : [], rev: 'r1' };
    });
    await assert.rejects(manager.startExternalServer('ejemplo', () => { waits += 1; }), error => error.code === 'EXTERNAL_START_STATUS_UNAVAILABLE');
    assert.equal(req.mock.callCount(), 2);
    req.mock.restore();
  }
  assert.equal(waits, 0);

  const reqFail = t.mock.method(manager, 'requestExternalControl', async method => {
    if (method === 'zerochat/external/servers/start') throw makeAbortError();
    throw new Error('Status unavailable');
  });
  await assert.rejects(manager.startExternalServer('ejemplo', null),
    error => error.code === 'EXTERNAL_START_STATUS_UNAVAILABLE' && error.cause.message === 'Status unavailable');
  reqFail.mock.restore();

  // Error distinto de timeout en start se propaga sin consultar wait.
  const callsDirect = [];
  t.mock.method(manager, 'requestExternalControl', async method => {
    callsDirect.push(method);
    throw new Error('Sin conexión');
  });
  await assert.rejects(() => manager.startExternalServer('ejemplo', null), /Sin conexión/);
  assert.deepEqual(callsDirect, ['zerochat/external/servers/start']);
});

test('ChatMCP - start: sigue fases por long-poll con oauthUrl y respeta su presupuesto', async t => {
  const manager = MCP.manager;

  // 1. Límite de 6 waits de 25 s (150 s) cuando permanece en starting sin oauthUrl
  let waitCalls1 = 0;
  const seenSinceRev = [];
  const req1 = t.mock.method(manager, 'requestExternalControl', async (method, params) => {
    if (method === 'zerochat/external/servers/start') {
      assert.equal(params.wait_ms, 25000);
      return { servers: [{ id: 'ejemplo', status: 'starting' }], rev: 'r0' };
    }
    seenSinceRev.push(params.since_rev);
    waitCalls1 += 1;
    return { servers: [{ id: 'ejemplo', status: 'starting' }], rev: `r${waitCalls1}` };
  });
  const waits1 = [];
  await assert.rejects(
    manager.startExternalServer('ejemplo', (attempt, total) => waits1.push([attempt, total])),
    error => error.code === 'EXTERNAL_START_WAIT_TIMEOUT' && error.externalServer.status === 'starting'
  );
  assert.equal(waitCalls1, 6);
  assert.deepEqual(seenSinceRev, ['r0', 'r1', 'r2', 'r3', 'r4', 'r5']);
  assert.deepEqual([waits1[0], waits1[5]], [[1, 6], [6, 6]]);
  req1.mock.restore();

  // 2. OAuth y transición installing -> starting despiertan sin reenviar arranque y propagan oauthUrl
  let checks = 0;
  const methods2 = [];
  const req2 = t.mock.method(manager, 'requestExternalControl', async (method, params) => {
    methods2.push({ method, params });
    checks += 1;
    if (checks === 1) return { servers: [{ id: 'composio', status: 'installing', oauthUrl: null }], rev: 's1' };
    if (checks === 2) return { servers: [{ id: 'composio', status: 'starting', oauthUrl: 'https://example.com/oauth' }], rev: 's2' };
    return { servers: [{ id: 'composio', status: 'running', oauthUrl: null }], rev: 's3' };
  });
  const waits2 = [];
  const receivedServers = [];
  const res2 = await manager.startExternalServer('composio', (a, tot, st, srv) => {
    waits2.push([a, tot, st]);
    receivedServers.push(srv);
  });
  assert.equal(res2.servers[0].status, 'running');
  assert.deepEqual(waits2, [[1, 48, 'installing'], [1, 48, 'starting']]);
  assert.equal(receivedServers[1].oauthUrl, 'https://example.com/oauth');
  assert.deepEqual(methods2.map(c => c.method), [
    'zerochat/external/servers/start',
    'zerochat/external/servers/wait',
    'zerochat/external/servers/wait'
  ]);
  assert.equal(methods2[1].params.since_rev, 's1');
  assert.equal(methods2[2].params.since_rev, 's2');
  req2.mock.restore();
});

test('ChatMCP - runExternalServerAction: el plazo de espera agotado deja el servicio en starting con el aviso de OAuth', async t => {
  const previousMcp = ChatState.get('mcp');
  ChatState.set('mcp', { ...previousMcp, externalServers: [{ id: 'ejemplo', status: 'stopped' }] });
  t.after(() => ChatState.set('mcp', previousMcp));
  const manager = MCP.manager;
  t.mock.method(manager, 'startExternalServer', async (id, onWait) => {
    onWait(3, 10);
    assert.deepEqual(ChatState.get('mcp').externalServers[0].startWait, { attempt: 3, total: 10 });
    throw Object.assign(new Error('Wait expired'), { code: 'EXTERNAL_START_WAIT_TIMEOUT', externalServer: { id: 'ejemplo', status: 'starting' } });
  });
  assert.equal(await manager.runExternalServerAction('ejemplo', 'start'), false);
  const [server] = ChatState.get('mcp').externalServers;
  assert.deepEqual({ status: server.status, startWait: server.startWait }, { status: 'starting', startWait: null });
  assert.match(server.error, /OAuth/);
});

test('MCP - cabecera de proyecto, disponibilidad por carpeta, caída de carpeta y carrera con setProjectDirectory', async () => {
  const previousMcp = ChatState.get('mcp');
  const previousSessions = ChatState.get('sessions');
  const manager = new MCP.McpManager();
  try {
    const local = new MCP.McpClient({ id: 'mcp_proxy', url: 'http://127.0.0.1:6883' });
    const external = new MCP.McpClient({ id: 'otro', url: 'https://mcp.example.com' });
    ChatState.set('mcp', { ...previousMcp, serverInfo: null });
    assert.equal(local.buildHeaders()['X-ZeroChat-Project'], undefined, 'Sin proyecto el servidor usa el suyo por defecto');
    ChatState.set('mcp', { ...previousMcp, serverInfo: { cwd: '/home/yo/año nuevo' } });
    assert.equal(decodeURIComponent(local.buildHeaders()['X-ZeroChat-Project']), '/home/yo/año nuevo');
    assert.match(local.buildHeaders()['X-ZeroChat-Project'], /^[\x20-\x7e]+$/, 'Una cabecera HTTP solo admite ASCII');
    assert.equal(external.buildHeaders()['X-ZeroChat-Project'], undefined);

    // Disponibilidad por proyecto de la conversación activa y carpeta general
    const provider = new MCP.McpToolProvider({ id: 'mcp_proxy', name: 'ZeroChat', initialize: async () => ({ success: true }), listTools: async () => [{ name: 'read_file' }] });
    const [readFile] = await provider.discoverTools();
    ChatState.set('mcp', { ...previousMcp, status: 'connected', serverInfo: { name: 'ZeroChat', cwd: '/repo', noProjectDir: '/home/u/zerochat/general' } });
    const withProject = project => {
      ChatState.set('sessions', { activeId: 's1', list: project === undefined ? [] : [{ id: 's1', title: 'x', ...(project ? { project } : {}) }] });
      return readFile.isAvailable();
    };
    assert.equal(withProject('/repo'), true);
    assert.equal(withProject(undefined), true);
    assert.equal(withProject(''), false);
    assert.equal(withProject('/otro'), false);
    ChatState.set('mcp', { ...ChatState.get('mcp'), serverInfo: { ...ChatState.get('mcp').serverInfo, cwd: '/home/u/zerochat/general' } });
    assert.equal(withProject(''), true);
    assert.equal(MCP.projectOfDirectory('/home/u/zerochat/general'), '');
    assert.equal(MCP.directoryOfProject(''), '/home/u/zerochat/general');
    ChatState.set('mcp', { ...ChatState.get('mcp'), status: 'disconnected' });
    assert.equal(withProject('/repo'), false);

    // Si la carpeta desaparece (-32003), vuelve al proyecto por defecto y repite
    ChatState.set('mcp', { ...previousMcp, status: 'connected', serverInfo: { name: 'ZeroChat', cwd: '/repo/borrado' } });
    const calls = [];
    manager.clients.set('mcp_proxy', { request: async method => {
      calls.push(method);
      if (ChatState.get('mcp').serverInfo.cwd === '/repo/borrado') throw Object.assign(new Error('gone'), { rpcError: { code: -32003 } });
      return { method };
    } });
    manager.probeTarget = async () => ({ success: true, serverInfo: { name: 'ZeroChat', cwd: '/repo/inicio' }, liveState: null });
    const lost = [];
    manager.onProjectLost = info => lost.push(info);
    const results = await Promise.all(['zerochat/conversations/list', 'zerochat/jobs/list'].map(method => manager.requestExternalControl(method)));
    assert.deepEqual(results.map(result => result.method), ['zerochat/conversations/list', 'zerochat/jobs/list']);
    assert.equal(calls.length, 4);
    assert.deepEqual(lost, [{ project: '/repo/borrado', fallback: '/repo/inicio' }]);
    assert.equal(ChatState.get('mcp').serverInfo.cwd, '/repo/inicio');

    // setProjectDirectory invalida un readLiveState en vuelo para que no revierta cwd
    let resolveHeartbeat;
    const heartbeatDeferred = new Promise(resolve => { resolveHeartbeat = resolve; });
    manager.clients.set('mcp_proxy', {
      request: async (method, params) => {
        if (method === 'zerochat/heartbeat') return heartbeatDeferred;
        if (method === 'zerochat/project/set_directory') return { cwd: params.path };
        return {};
      }
    });
    ChatState.set('mcp', { ...previousMcp, status: 'connected', serverInfo: { name: 'ZeroChat', cwd: '/repo/a' } });
    const pendingRead = manager.readLiveState();
    await manager.setProjectDirectory('/repo/b');
    assert.equal(ChatState.get('mcp').serverInfo.cwd, '/repo/b');
    resolveHeartbeat({ ok: true, cwd: '/repo/a' });
    await pendingRead;
    assert.equal(ChatState.get('mcp').serverInfo.cwd, '/repo/b');
  } finally {
    ChatState.set('mcp', previousMcp);
    ChatState.set('sessions', previousSessions);
  }
});

test('MCP - applyLiveState publica el estado vivo del servidor y solo escribe lo que cambia', async t => {
  const Security = require('../../js/tool-security.js');
  const previousState = ChatState.get('mcp');
  const manager = new MCP.McpManager();
  try {
    ChatState.set('mcp', { ...previousState, status: 'connected', serverInfo: { name: 'ZeroChat', cwd: '/repo' }, commandJobs: [], exitOnClose: false, playwright: null });
    const provider = new MCP.McpToolProvider({ id: 'mcp_proxy', name: 'ZeroChat', initialize: async () => ({ success: true }), listTools: async () => [{ name: 'browser_action' }] });
    const [browserAction] = await provider.discoverTools();
    assert.equal(browserAction.isAvailable(), false, 'Sin latido no se sabe si hay Playwright');
    assert.equal(MCP.playwrightInstalled(), null);

    const writes = [];
    const unsubscribe = ChatState.subscribe('mcp', value => writes.push(value));
    const jobs = [
      { id: 1, key: 'inv-a', command: 'npm run dev', status: 'running', started_at: 1000, background: true, elapsed_s: 3, last_line: 'ready in 300 ms' },
      { id: 2, command: 'npm test', status: 'exited', started_at: 2000, background: true },
      { id: 4, command: 'npm run build', status: 'running', started_at: 3000, background: false },
      { id: 'x', command: 'malo', status: 'running', background: true }
    ];
    const heartbeat = {
      ok: true,
      cwd: '/otro',
      policies: { directoryRules: ['RWX:/otro/**'] },
      jobs,
      exit_on_close: true,
      playwright: { installed: true, browserAction: { available: true, extra: 1 } }
    };
    assert.equal(await manager.applyLiveState(heartbeat), true);
    assert.equal(writes.length, 1, 'Un latido es una sola escritura');
    const mcp = ChatState.get('mcp');
    // Solo los de segundo plano: un comando esperado ya se ve en su tarjeta.
    assert.deepEqual(mcp.commandJobs, [{ id: 1, command: 'npm run dev', startedAt: 1000, lastLine: 'ready in 300 ms' }]);
    assert.equal(mcp.exitOnClose, true);
    assert.equal(mcp.serverInfo.cwd, '/otro');
    assert.deepEqual(Security.manager.getDirectoryRules(), ['RWX:/otro/**']);
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

test('MCP - startServerRun, cancelServerRun y readLiveState con focus_conversation_id y long-poll sin sondeo de 2 s', async () => {
  const previousMcp = ChatState.get('mcp');
  const previousSessions = ChatState.get('sessions');
  const manager = new MCP.McpManager();
  manager.target = { url: 'http://127.0.0.1:6388', proxyKey: null };
  const calls = [];
  let heartbeatResponse = {
    ok: true,
    rev: 'rev_1',
    exit_on_close: false,
    runs: [{ conversation_id: 'conv_srv_1', run_id: 'run_srv_1', status: 'running' }],
    focus_run: { conversation_id: 'conv_srv_1', run_id: 'run_srv_1', status: 'running', step_text: 'step 1' }
  };
  manager.clients.set('mcp_proxy', {
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === 'zerochat/run/start') {
        return { ok: true, run_id: 'run_srv_1', conversation_id: params.conversation_id, status: 'running' };
      }
      if (method === 'zerochat/run/cancel') {
        heartbeatResponse = {
          ok: true,
          rev: 'rev_3',
          exit_on_close: false,
          runs: [],
          focus_run: null
        };
        return { ok: true, cancelled: true };
      }
      if (method === 'zerochat/heartbeat') {
        return heartbeatResponse;
      }
      return {};
    }
  });

  try {
    ChatState.set('mcp', { ...previousMcp, status: 'connected', serverRuns: [], focusRun: null });
    ChatState.set('sessions', { activeId: 'conv_srv_1', list: [] });

    // 1. startServerRun publica el estado 'running' y activa el seguimiento de latido sin temporizador de 2 s
    const started = await manager.startServerRun({
      conversationId: 'conv_srv_1',
      profile: 'Server',
      toolSecurity: { allowAll: false }
    });
    assert.equal(started.run_id, 'run_srv_1');
    assert.deepEqual(ChatState.get('mcp').serverRuns, [
      { conversationId: 'conv_srv_1', runId: 'run_srv_1', status: 'running' }
    ]);
    assert.notEqual(manager.liveWatchAbort, null);

    // 2. readLiveState envía focus_conversation_id y publica focusRun y liveStateRev
    await manager.readLiveState();
    assert.deepEqual(calls[1], {
      method: 'zerochat/heartbeat',
      params: { focus_conversation_id: 'conv_srv_1' }
    });
    assert.equal(ChatState.get('mcp').focusRun?.step_text, 'step 1');
    assert.equal(manager.liveStateRev, 'rev_1');

    // Al cambiar de conversación y volver, sigue manteniendo el seguimiento activo único.
    ChatState.set('sessions', { activeId: 'conv_otra', list: [] });
    await manager.readLiveState();
    assert.notEqual(manager.liveWatchAbort, null);
    ChatState.set('sessions', { activeId: 'conv_srv_1', list: [] });
    await manager.readLiveState();
    assert.notEqual(manager.liveWatchAbort, null);

    // 3. Cuando la tarea pasa a needs_input y exit_on_close es true, actualiza rev y estado
    heartbeatResponse = {
      ok: true,
      rev: 'rev_2',
      exit_on_close: true,
      runs: [{ conversation_id: 'conv_srv_1', run_id: 'run_srv_1', status: 'needs_input' }],
      focus_run: { conversation_id: 'conv_srv_1', run_id: 'run_srv_1', status: 'needs_input', pending_reason: 'ask_user' }
    };
    await manager.readLiveState();
    assert.equal(ChatState.get('mcp').serverRuns[0].status, 'needs_input');
    assert.equal(manager.liveStateRev, 'rev_2');

    // 4. cancelServerRun invoca zerochat/run/cancel y relee el estado vivo
    await manager.cancelServerRun('conv_srv_1');
    assert.deepEqual(calls[5], {
      method: 'zerochat/run/cancel',
      params: { conversation_id: 'conv_srv_1' }
    });
    assert.deepEqual(ChatState.get('mcp').serverRuns, []);
    assert.equal(ChatState.get('mcp').focusRun, null);
    assert.equal(manager.liveStateRev, 'rev_3');
    assert.notEqual(manager.liveWatchAbort, null);
  } finally {
    manager.setLiveStateWatch(false);
    assert.equal(manager.liveWatchAbort, null);
    ChatState.set('mcp', previousMcp);
    ChatState.set('sessions', previousSessions);
  }
});

test('MCP - setProjectDirectory aplica projectEnvironment guardado y concilia arranque/parada de MCPs y Navegador', async t => {
  const ChatConfig = require('../../js/config-store.js');
  const previousMcp = ChatState.get('mcp');
  const manager = MCP.manager;
  const envEvents = [];
  const savedEnvs = {
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
  const previousClient = manager.clients.get('mcp_proxy');
  manager.clients.set('mcp_proxy', {
    async request(method, params) {
      if (method === 'zerochat/project/set_directory') {
        const cwd = params.path;
        return {
          cwd,
          policies: { allowAll: false, tools: {}, servers: {}, directoryRules: [`RWX:${cwd}/**`], commandPatterns: { global: [], project: [], session: [] } },
          projectEnvironment: savedEnvs[cwd] || savedEnvs['/proj/b']
        };
      }
      if (method === 'zerochat/external/servers/start') {
        serverStates[params.serverId] = 'running';
        envEvents.push(`start:${params.serverId}`);
        return { servers: listServers(), externalTools: [] };
      }
      if (method === 'zerochat/external/servers/stop') {
        serverStates[params.serverId] = 'stopped';
        envEvents.push(`stop:${params.serverId}`);
        return { servers: listServers(), externalTools: [] };
      }
      if (method === 'tools/list') return { tools: [] };
      return {};
    }
  });
  ChatState.set('mcp', { status: 'connected', serverInfo: { name: 'ZeroChat', cwd: '/proj/init' }, externalServers: listServers() });
  t.after(() => {
    if (previousClient) manager.clients.set('mcp_proxy', previousClient);
    else manager.clients.delete('mcp_proxy');
    ChatState.set('mcp', previousMcp);
  });

  await manager.setProjectDirectory('/proj/a');
  assert.equal(ChatConfig.getActive().systemDataPrompt, 'Instrucciones proyecto A');
  assert.equal(ChatConfig.getActive().enabledTools.search_web, false);
  assert.deepEqual(ChatConfig.getActive().mcpServers, ['memory']);
  assert.equal(ChatConfig.getActive().browser, 'playwright');
  assert.deepEqual(envEvents, ['start:memory', 'start:playwright']);

  envEvents.length = 0;
  await manager.setProjectDirectory('/proj/b');
  assert.equal(ChatConfig.getActive().systemDataPrompt, ChatConfig.DEFAULT_SYSTEM_DATA_PROMPT);
  assert.deepEqual(ChatConfig.getActive().mcpServers, []);
  assert.equal(ChatConfig.getActive().browser, 'browser_action');
  assert.deepEqual(envEvents, ['stop:memory', 'stop:playwright']);
});
