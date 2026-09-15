const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

test('Servidor local mantiene las herramientas ZeroChat separadas del host MCP externo', async () => {
  const serverPath = path.resolve(__dirname, '../../scripts/mcp_server.py');
  const sourceRoot = path.resolve(__dirname, '../../scripts/mcp');
  const mcpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zerochat-mcp-home-'));
  const port = 6398;
  const baseUrl = `http://127.0.0.1:${port}`;
  const serverProc = spawn('python3', [
    serverPath, '--port', String(port), '--mcp-source', 'local-copy',
    '--mcp-source-root', sourceRoot, '--mcp-home', mcpHome
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  async function rpc(id, method, params = {}, endpoint = baseUrl) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
    });
    assert.equal(response.status, 200);
    return response.json();
  }

  try {
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        if ((await fetch(baseUrl)).ok) break;
      } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 100));
      if (attempt === 39) assert.fail('El servidor local no arrancó');
    }

    const localTools = await rpc(1, 'tools/list');
    assert.deepEqual(localTools.result.tools.map(tool => tool.name).sort(), [
      'edit_file', 'execute_command', 'list_directory', 'read_file'
    ]);
    assert.equal((await fetch(`${baseUrl}/mcp/external/status`)).status, 200);
    const before = await rpc(2, 'zerochat/external/status');
    assert.equal(before.result.host, 'stopped');
    assert.deepEqual(before.result.servers, []);

    const started = await rpc(3, 'zerochat/external/start');
    assert.equal(started.result.host, 'running');
    assert.equal(started.result.servers.length, 1);
    assert.equal(started.result.servers[0].id, 'playwright');
    assert.notEqual(started.result.servers[0].status, 'running');

    const afterStartLocalTools = await rpc(4, 'tools/list');
    assert.equal(afterStartLocalTools.result.tools.length, 4, 'El host externo no se agrega al proveedor local');

    const externalTools = await rpc(5, 'tools/list', {}, `${baseUrl}/mcp/external`);
    assert.deepEqual(externalTools.result.tools, [], 'No se publican herramientas hasta arrancar un servicio externo');

    const stopped = await rpc(6, 'zerochat/external/stop');
    assert.equal(stopped.result.host, 'stopped');
  } finally {
    serverProc.kill('SIGINT');
    if (serverProc.exitCode === null) {
      await new Promise(resolve => serverProc.once('close', resolve));
    }
    fs.rmSync(mcpHome, { recursive: true, force: true });
  }
});
