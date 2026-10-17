const test = require('node:test');
const assert = require('node:assert/strict');

const AgentCore = require('../../js/agent-core.js');
const MCP = require('../../js/mcp.js');
const ChatState = require('../../js/state.js');

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
                  description: 'Lista archivos y carpetas de un directorio local, sin recorrer subdirectorios.',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      path: { type: 'string', description: 'Ruta del directorio' }
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
                  name: 'run_command',
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
    const listDirTool = tools.find(t => t.metadata.originalName === 'list_directory');
    const readFileTool = tools.find(t => t.metadata.originalName === 'read_file');
    const execCmdTool = tools.find(t => t.metadata.originalName === 'run_command');

    assert.ok(listDirTool);
    assert.ok(readFileTool);
    assert.ok(execCmdTool);

    assert.match(listDirTool.metadata.iconSvg, /<svg/);
    assert.match(readFileTool.metadata.iconSvg, /<svg/);
    assert.match(execCmdTool.metadata.iconSvg, /<svg/);

    // Comprobar vistas declaradas
    assert.ok(typeof listDirTool.view?.createLiveCard === 'function');
    assert.ok(typeof readFileTool.view?.createLiveCard === 'function');
    assert.ok(typeof execCmdTool.view?.createLiveCard === 'function');

    // Registrar en ToolRegistry
    const registry = new AgentCore.ToolRegistry();
    registry.registerProvider(provider);

    // 1. Con estado DESCONECTADO: no deben incluirse en getActiveDefinitions
    ChatState.set('mcp', { status: 'disconnected' });
    const defsDisconnected = registry.getActiveDefinitions(require('../../js/config-store.js').normalize({}));
    const mcpDefsDisconnected = defsDisconnected.filter(d =>
      d.function.name.includes('list_directory') ||
      d.function.name.includes('read_file') ||
      d.function.name.includes('run_command')
    );
    assert.equal(mcpDefsDisconnected.length, 0);

    // 2. Con estado CONECTADO: deben incluirse en getActiveDefinitions
    ChatState.set('mcp', { status: 'connected' });
    const defsConnected = registry.getActiveDefinitions(require('../../js/config-store.js').normalize({}));
    const mcpDefsConnected = defsConnected.filter(d =>
      d.function.name.includes('list_directory') ||
      d.function.name.includes('read_file') ||
      d.function.name.includes('run_command')
    );
    assert.equal(mcpDefsConnected.length, 3);

    // 3. Con switch desactivado para 'run_command': debe excluirse
    const defsFiltered = registry.getActiveDefinitions(require('../../js/config-store.js').normalize({
      enabledTools: {
        [execCmdTool.name]: false
      }
    }));
    const hasExec = defsFiltered.some(d => d.function.name.includes('run_command'));
    const hasRead = defsFiltered.some(d => d.function.name.includes('read_file'));
    assert.equal(hasExec, false);
    assert.equal(hasRead, true);

    // 4. Desregistro de proveedor
    registry.unregisterProvider('mcp_prov_mcp_proxy');
    assert.equal(Boolean(registry.getTool('list_directory')), false);
    assert.equal(Boolean(registry.getTool('read_file')), false);
    assert.equal(Boolean(registry.getTool('run_command')), false);
  } finally {
    global.fetch = originalFetch;
    ChatState.set('mcp', { status: 'disconnected' });
  }
});


test('MCP Tools - run_command del servidor local envía la clave de la invocación y se detiene al abortar', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  try {
    global.fetch = async (url, options) => {
      const body = JSON.parse(options.body || '{}');
      calls.push(body);
      const reply = result => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, result }) });
      if (body.method === 'initialize') {
        return reply({ protocolVersion: '2024-11-05', serverInfo: { name: 'ZeroChat Local Server', version: '1.0.0' }, capabilities: { tools: {} } });
      }
      if (body.method === 'tools/list') {
        return reply({ tools: [
          { name: 'run_command', description: 'Run a command', inputSchema: { type: 'object', required: ['command'] } },
          { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', required: ['path'] } }
        ] });
      }
      if (body.method === 'tools/call' && body.params.name === 'run_command') {
        // Simula un comando largo: la petición solo termina al abortarse.
        return new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
        });
      }
      if (body.method === 'tools/call') {
        return reply({ content: [{ type: 'text', text: '{"success": true}' }], isError: false });
      }
      if (body.method === 'zerochat/jobs/stop') return reply({ status: 'stopped' });
      return { ok: false, status: 404 };
    };

    const client = new MCP.McpClient({ id: 'mcp_proxy', name: 'ZeroChat Local Server', url: 'http://127.0.0.1:6388/sse' });
    const tools = await new MCP.McpToolProvider(client).discoverTools();
    const runTool = tools.find(t => t.name === 'run_command');
    const readTool = tools.find(t => t.name === 'read_file');

    const controller = new AbortController();
    const pending = runTool.execute({ command: 'sleep 100' }, { invocationId: 'inv-clave-1234', signal: controller.signal });
    await new Promise(resolve => setTimeout(resolve, 10));
    const toolCall = calls.find(call => call.method === 'tools/call');
    assert.deepEqual(toolCall.params._meta, { zerochatJobKey: 'inv-clave-1234' });
    controller.abort();
    await assert.rejects(pending, error => error.name === 'AbortError');
    await new Promise(resolve => setTimeout(resolve, 10));
    const stop = calls.find(call => call.method === 'zerochat/jobs/stop');
    assert.deepEqual(stop?.params, { key: 'inv-clave-1234' });

    // Las demás herramientas no llevan clave ni provocan paradas.
    calls.length = 0;
    await readTool.execute({ path: 'x' }, { invocationId: 'inv-otra-12345', signal: new AbortController().signal });
    assert.equal(calls.find(call => call.method === 'tools/call').params._meta, undefined);
    assert.equal(calls.some(call => call.method === 'zerochat/jobs/stop'), false);
  } finally {
    global.fetch = originalFetch;
  }
});
