const test = require('node:test');
const assert = require('node:assert/strict');

// Cargar módulos
const AgentCore = require('../js/agent-core.js');
const MCP = require('../js/mcp.js');
const ChatState = require('../js/state.js');

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
    assert.ok(weatherTool.name.includes('weather_server__get_weather_forecast'));
    assert.ok(weatherTool.aliases.includes('get_weather_forecast'));
    assert.equal(weatherTool.metadata.mcpServerName, 'Weather MCP Server');
    assert.equal(weatherTool.metadata.originalName, 'get_weather_forecast');
    assert.ok(weatherTool.parameters.required.includes('city'));

    // Registro en ToolRegistry
    const registry = new AgentCore.ToolRegistry();
    registry.registerProvider(provider);

    // Debe resolver por alias o por nombre con namespace
    assert.ok(registry.hasTool('get_weather_forecast'));
    assert.ok(registry.hasTool('mcp__weather_server__get_weather_forecast'));

    const defs = registry.getDefinitions();
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
      /Error MCP \(-32601\): Method not found/
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
    assert.ok(hugeRes.content.includes('[... Contenido MCP truncado por límite de tamaño ...]'));
  } finally {
    global.fetch = originalFetch;
  }
});

test('MCP - McpManager administración de servidores y sincronización', async () => {
  const manager = new MCP.McpManager();

  // Añadir servidor
  const server = manager.addServer({
    name: 'Test Local MCP',
    url: 'http://localhost:8000/rpc',
    headers: { 'Authorization': 'Bearer test-secret-token' },
    enabled: true
  });

  assert.ok(server.id);
  assert.equal(server.name, 'Test Local MCP');
  assert.equal(manager.getServers().length >= 1, true);

  // Obtener cliente y verificar que las cabeceras de autorización se mantengan en el cliente
  const client = manager.getClient(server.id);
  assert.equal(client.headers['Authorization'], 'Bearer test-secret-token');

  // Limpiar
  manager.removeServer(server.id);
  assert.equal(manager.getServers().some(s => s.id === server.id), false);
});

test('MCP - probeConnection sondea exitosamente un endpoint activo', async () => {
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

    const res = await MCP.probeConnection('http://127.0.0.1:6388/sse', { timeoutMs: 1000 });
    assert.equal(res.success, true);
    assert.equal(res.serverInfo.name, 'mcp-proxy');
    assert.equal(res.serverInfo.version, '0.4.0');
    assert.ok(typeof res.latencyMs === 'number');
  } finally {
    global.fetch = originalFetch;
  }
});

test('MCP - probeConnection maneja fallo de conexión y URL vacía', async () => {
  const emptyRes = await MCP.probeConnection('');
  assert.equal(emptyRes.success, false);
  assert.ok(emptyRes.error.includes('no válida'));

  const originalFetch = global.fetch;
  try {
    global.fetch = async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:6388');
    };

    const failRes = await MCP.probeConnection('http://127.0.0.1:6388/sse', { timeoutMs: 500 });
    assert.equal(failRes.success, false);
    assert.ok(failRes.error.includes('No se puede conectar al proxy'));
  } finally {
    global.fetch = originalFetch;
  }
});

test('MCP - McpManager connectProxy y disconnectProxy gestionan estado', async () => {
  const originalFetch = global.fetch;
  const manager = new MCP.McpManager();

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
              serverInfo: { name: 'mcp-proxy', version: '1.0.0' },
              capabilities: {}
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
            result: { tools: [] }
          })
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };

    const registry = new AgentCore.ToolRegistry();
    const connResult = await manager.connectProxy({ host: '127.0.0.1', port: 6388 }, registry);
    assert.equal(connResult.success, true);

    const discResult = manager.disconnectProxy();
    assert.equal(discResult.success, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test('MCP - McpClient disconnect() limpia recursos y cancela peticiones pendientes', async () => {
  const client = new MCP.McpClient({
    id: 'test_server',
    name: 'Test Server',
    url: 'http://127.0.0.1:6388/sse'
  });

  client.isSseActive = true;
  client.postUrl = 'http://127.0.0.1:6388/messages/?session_id=fake-uuid';

  // Simular una petición pendiente esperando SSE
  let rejectedError = null;
  client.pendingRequests.set(1, {
    reject: (err) => { rejectedError = err; },
    resolve: () => {},
    timer: setTimeout(() => {}, 10000)
  });

  client.disconnect();

  assert.equal(client.isSseActive, false);
  assert.equal(client.postUrl, null);
  assert.equal(client.pendingRequests.size, 0);
  assert.ok(rejectedError);
  assert.ok(rejectedError.message.includes('cerrada'));
});

test('MCP - McpClient se auto-recupera de HTTP 404 por sesión SSE expirada o reiniciada', async () => {
  const originalFetch = global.fetch;
  let sseConnectCount = 0;
  let requestsMade = [];

  try {
    global.fetch = async (url, options = {}) => {
      requestsMade.push({ url, method: options.method || 'GET' });

      // GET a /sse para negociar endpoint
      if (url === 'http://127.0.0.1:6388/sse') {
        sseConnectCount++;
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('event: endpoint\ndata: /messages/?session_id=new-session-uuid-123\n\n'));
            controller.close();
          }
        });
        return {
          ok: true,
          status: 200,
          body: stream
        };
      }

      // POST con ID caducado devuelto por proxy reiniciado
      if (url.includes('session_id=old-stale-uuid')) {
        return {
          ok: false,
          status: 404,
          text: async () => 'Could not find session for ID: old-stale-uuid'
        };
      }

      // POST con nuevo session_id tras recuperación
      if (url.includes('session_id=new-session-uuid-123')) {
        const body = JSON.parse(options.body || '{}');
        return {
          ok: true,
          status: 200,
          json: async () => ({
            jsonrpc: '2.0',
            id: body.id,
            result: { recovered: true, ping: 'pong' }
          })
        };
      }

      return { ok: false, status: 500, text: async () => 'Error no esperado' };
    };

    const client = new MCP.McpClient({
      id: 'mcp_proxy',
      name: 'mcp-proxy',
      url: 'http://127.0.0.1:6388/sse'
    });

    // Simulamos que el cliente tenía en memoria una sesión previa antes del reinicio del servidor
    client.isSseActive = true;
    client.postUrl = 'http://127.0.0.1:6388/messages/?session_id=old-stale-uuid';

    // Ejecutamos la petición: debe fallar con 404, detectar sesión muerta, reconectar y reintentar con éxito
    const result = await client.request('ping', {});

    assert.equal(result.recovered, true);
    assert.equal(result.ping, 'pong');
    assert.equal(sseConnectCount, 1);
    assert.ok(client.postUrl.includes('session_id=new-session-uuid-123'));

    // Validar secuencia de llamadas: primero POST a old-stale, luego GET a /sse, luego POST a new-session
    assert.equal(requestsMade[0].url, 'http://127.0.0.1:6388/messages/?session_id=old-stale-uuid');
    assert.equal(requestsMade[1].url, 'http://127.0.0.1:6388/sse');
    assert.equal(requestsMade[2].url, 'http://127.0.0.1:6388/messages/?session_id=new-session-uuid-123');
  } finally {
    global.fetch = originalFetch;
  }
});

test('MCP - autoConnectIfAvailable conecta si el servidor está activo y permanece desconectado si no', async () => {
  const originalFetch = global.fetch;

  try {
    // 1. Caso Servidor Inactivo / puerto cerrado
    global.fetch = async () => {
      throw new Error('fetch failed: ECONNREFUSED');
    };

    const resInactive = await MCP.manager.autoConnectIfAvailable({
      host: '127.0.0.1',
      port: 6388,
      timeoutMs: 500
    });

    assert.equal(resInactive.available, false);
    assert.equal(resInactive.success, false);

    // 2. Caso Servidor Activo
    global.fetch = async (url, options) => {
      if (options?.method === 'GET' && url.includes('/sse')) {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('event: endpoint\ndata: /messages/?session_id=test-auto-conn\n\n'));
            controller.close();
          }
        });
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'Content-Type': 'text/event-stream' }),
          body: stream
        };
      }

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

    const resActive = await MCP.manager.autoConnectIfAvailable({
      host: '127.0.0.1',
      port: 6388,
      timeoutMs: 1000
    });

    assert.equal(resActive.success, true);
    assert.equal(resActive.tools.length, 1);
    assert.ok(resActive.tools[0].name.includes('auto_tool'));
    assert.equal(resActive.tools[0].titleFallback, 'auto_tool');
  } finally {
    global.fetch = originalFetch;
    MCP.manager.disconnectProxy();
  }
});

test('MCP - connectProxy soporta silentOnFailure para arranque y fallo explícito', async () => {
  const originalFetch = global.fetch;
  const manager = new MCP.McpManager();

  try {
    // Simular que no hay servidor escuchando (fetch falla)
    global.fetch = async () => {
      throw new Error('ECONNREFUSED');
    };

    // 1. Conexión de arranque (silentOnFailure: true)
    const resSilent = await manager.connectProxy({
      host: '127.0.0.1',
      port: 6388,
      silentOnFailure: true
    });
    assert.equal(resSilent.success, false);
    assert.equal(resSilent.available, false);
    const stateSilent = ChatState.get('mcp');
    assert.equal(stateSilent.status, 'disconnected');
    assert.equal(stateSilent.error, null);

    // 2. Conexión manual por el usuario (silentOnFailure: false)
    const resManual = await manager.connectProxy({
      host: '127.0.0.1',
      port: 6388,
      silentOnFailure: false
    });
    assert.equal(resManual.success, false);
    const stateManual = ChatState.get('mcp');
    assert.equal(stateManual.status, 'error');
    assert.ok(stateManual.error);
  } finally {
    global.fetch = originalFetch;
    manager.disconnectProxy();
  }
});



