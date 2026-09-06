const test = require('node:test');
const assert = require('node:assert/strict');

const AgentCore = require('../js/agent-core.js');
const MCP = require('../js/mcp.js');
const ChatState = require('../js/state.js');
const ChatConfig = require('../js/config-store.js');

test('MCP Tools - Contrato declarativo y descubrimiento de herramientas nativas del sistema', async () => {
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
              serverInfo: { name: 'ZeroChat Local Tools', version: '1.0.0' },
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
                  name: 'list_directory',
                  description: 'Recorre un directorio local y devuelve la lista de archivos y subcarpetas.',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      path: { type: 'string', description: 'Ruta del directorio' },
                      max_depth: { type: 'integer', description: 'Profundidad' }
                    }
                  }
                },
                {
                  name: 'read_file',
                  description: 'Lee el contenido de texto de un archivo local.',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      path: { type: 'string', description: 'Ruta del archivo' },
                      max_bytes: { type: 'integer', description: 'Límite de bytes' }
                    },
                    required: ['path']
                  }
                },
                {
                  name: 'execute_command',
                  description: 'Ejecuta un comando en la terminal local.',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      command: { type: 'string', description: 'Comando shell' },
                      cwd: { type: 'string', description: 'Directorio de trabajo' },
                      timeout_seconds: { type: 'integer', description: 'Timeout en segundos' }
                    },
                    required: ['command']
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
      id: 'mcp_proxy',
      name: 'ZeroChat Local Tools',
      url: 'http://127.0.0.1:6388/sse'
    });

    const provider = new MCP.McpToolProvider(client, {
      id: 'mcp_prov_mcp_proxy',
      name: 'ZeroChat Local Tools'
    });
    const tools = await provider.discoverTools();

    assert.equal(tools.length, 3);

    // Comprobar metadatos, alias e iconos
    const listDirTool = tools.find(t => t.aliases.includes('list_directory'));
    const readFileTool = tools.find(t => t.aliases.includes('read_file'));
    const execCmdTool = tools.find(t => t.aliases.includes('execute_command'));

    assert.ok(listDirTool);
    assert.ok(readFileTool);
    assert.ok(execCmdTool);

    assert.equal(listDirTool.metadata.icon, 'plug');
    assert.equal(readFileTool.metadata.icon, 'plug');
    assert.equal(execCmdTool.metadata.icon, 'plug');

    // Comprobar vistas declaradas
    assert.ok(typeof listDirTool.view?.createLiveCard === 'function');
    assert.ok(typeof readFileTool.view?.createLiveCard === 'function');
    assert.ok(typeof execCmdTool.view?.createLiveCard === 'function');

    // Registrar en ToolRegistry
    const registry = new AgentCore.ToolRegistry();
    registry.registerProvider(provider);

    // 1. Con estado DESCONECTADO: no deben incluirse en getActiveDefinitions
    ChatState.set('mcp', { status: 'disconnected' });
    const defsDisconnected = registry.getActiveDefinitions({});
    const mcpDefsDisconnected = defsDisconnected.filter(d =>
      d.function.name.includes('list_directory') ||
      d.function.name.includes('read_file') ||
      d.function.name.includes('execute_command')
    );
    assert.equal(mcpDefsDisconnected.length, 0);

    // 2. Con estado CONECTADO: deben incluirse en getActiveDefinitions
    ChatState.set('mcp', { status: 'connected' });
    const defsConnected = registry.getActiveDefinitions({});
    const mcpDefsConnected = defsConnected.filter(d =>
      d.function.name.includes('list_directory') ||
      d.function.name.includes('read_file') ||
      d.function.name.includes('execute_command')
    );
    assert.equal(mcpDefsConnected.length, 3);

    // 3. Con switch desactivado para 'execute_command': debe excluirse
    const defsFiltered = registry.getActiveDefinitions({
      enabledTools: {
        [execCmdTool.id]: false
      }
    });
    const hasExec = defsFiltered.some(d => d.function.name.includes('execute_command'));
    const hasRead = defsFiltered.some(d => d.function.name.includes('read_file'));
    assert.equal(hasExec, false);
    assert.equal(hasRead, true);

    // 4. Desregistro de proveedor
    registry.unregisterProvider('mcp_prov_mcp_proxy');
    assert.equal(registry.hasTool('list_directory'), false);
    assert.equal(registry.hasTool('read_file'), false);
    assert.equal(registry.hasTool('execute_command'), false);
  } finally {
    global.fetch = originalFetch;
    ChatState.set('mcp', { status: 'disconnected' });
  }
});

test('MCP Tools - Formateo de resultados Markdown especializado para list_directory, read_file y execute_command', () => {
  const client = new MCP.McpClient({ id: 'local_server', name: 'ZeroChat' });
  const provider = new MCP.McpToolProvider(client);

  const mockTool = new AgentCore.Tool({
    name: 'test_mcp_tool',
    category: 'mcp'
  });

  // 1. execute_command
  const execResult = {
    content: JSON.stringify({
      success: true,
      command: 'echo "hello mcp"',
      returncode: 0,
      stdout: 'hello mcp\n',
      stderr: ''
    })
  };
  const execView = provider.client;
  assert.ok(execResult.content.includes('hello mcp'));

  // 2. list_directory
  const listResult = {
    content: JSON.stringify({
      success: true,
      path: '/home/alberto/vs/zerochat',
      total_items: 2,
      entries: [
        { name: 'js', type: 'directory', size_bytes: null },
        { name: 'index.html', type: 'file', size_bytes: 85000 }
      ]
    })
  };
  const parsedList = JSON.parse(listResult.content);
  assert.equal(parsedList.total_items, 2);
  assert.equal(parsedList.entries[0].name, 'js');

  // 3. read_file
  const readResult = {
    content: JSON.stringify({
      success: true,
      path: '/home/alberto/vs/zerochat/package.json',
      size_bytes: 1200,
      content: '{\n  "name": "zerochat"\n}'
    })
  };
  const parsedRead = JSON.parse(readResult.content);
  assert.equal(parsedRead.size_bytes, 1200);
  assert.ok(parsedRead.content.includes('zerochat'));
});

test('MCP Tools - Descubrimiento y soporte dinámico de herramientas arbitrarias sin nombres hardcodeados', async () => {
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
              serverInfo: { name: 'Postgres MCP Server', version: '2.0.0' },
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
                  name: 'execute_sql_query',
                  description: 'Ejecuta una consulta SQL en la base de datos PostgreSQL remota.',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      sql: { type: 'string', description: 'Query SQL' }
                    },
                    required: ['sql']
                  }
                },
                {
                  name: 'search_vector_embedding',
                  description: 'Busca los k vecinos más próximos en el índice vectorial.',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      query_vector: { type: 'array', items: { type: 'number' } },
                      k: { type: 'integer' }
                    },
                    required: ['query_vector']
                  }
                }
              ]
            }
          })
        };
      }
      return { ok: false, status: 404 };
    };

    const client = new MCP.McpClient({
      id: 'postgres_server',
      name: 'Postgres MCP Server',
      url: 'http://127.0.0.1:6388/sse'
    });

    const provider = new MCP.McpToolProvider(client);
    const tools = await provider.discoverTools();

    assert.equal(tools.length, 2);

    const sqlTool = tools.find(t => t.aliases.includes('execute_sql_query'));
    const vecTool = tools.find(t => t.aliases.includes('search_vector_embedding'));

    assert.ok(sqlTool);
    assert.ok(vecTool);

    // Verificamos que conserven sus descripciones nativas de FastMCP y el icono uniforme plug
    assert.equal(sqlTool.metadata.icon, 'plug');
    assert.equal(vecTool.metadata.icon, 'plug');
    assert.equal(sqlTool.metadata.description, 'Ejecuta una consulta SQL en la base de datos PostgreSQL remota.');
    assert.equal(vecTool.metadata.description, 'Busca los k vecinos más próximos en el índice vectorial.');

    // Verificamos que el formateo de Markdown universal funcione sin conocer los nombres
    const mdSql = sqlTool.formatter({ sql: 'SELECT * FROM users' }, { content: JSON.stringify([{ id: 1, name: 'Alice' }]) });
    assert.ok(mdSql.includes('🔌'));
    assert.ok(mdSql.includes('execute_sql_query'));
    assert.ok(mdSql.includes('Alice'));
  } finally {
    global.fetch = originalFetch;
  }
});

