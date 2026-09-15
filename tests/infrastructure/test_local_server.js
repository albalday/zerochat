const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

test('Ruta publicada del host MCP: instala, inicia, enruta, detiene y desconecta un servicio stdio', async () => {
  const serverPath = path.resolve(__dirname, '../../scripts/mcp_server.py');
  const sourceRoot = path.resolve(__dirname, '../../scripts/mcp');
  const releaseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zerochat-mcp-release-'));
  const mcpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zerochat-mcp-home-'));
  const port = 6400 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  fs.cpSync(sourceRoot, releaseRoot, { recursive: true });
  const serviceRoot = path.join(releaseRoot, 'services', 'dummy.mcp');
  fs.mkdirSync(serviceRoot);
  fs.copyFileSync(path.resolve(__dirname, '../fixtures/dummy_mcp_server.py'), path.join(serviceRoot, 'dummy_mcp_server.py'));
  fs.writeFileSync(path.join(serviceRoot, 'service.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'dummy',
    displayName: { es: 'Servicio de prueba', en: 'Test service' },
    description: { es: 'Servidor stdio local para pruebas.', en: 'Local stdio server for tests.' },
    enabledByDefault: false,
    transport: 'stdio',
    launch: {
      executable: '${pythonExecutable}',
      args: ['${serviceSourceDir}/dummy_mcp_server.py'],
      cwd: '${serviceDir}',
      env: {},
      handshakeTimeoutSeconds: 5
    }
  }));
  fs.writeFileSync(path.join(serviceRoot, 'installer.json'), JSON.stringify({ schemaVersion: 1, type: 'none' }));
  const serverProc = spawn('python3', [
    serverPath, '--port', String(port), '--mcp-source', 'local-copy',
    '--mcp-source-root', releaseRoot, '--mcp-home', mcpHome
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let serverError = '';
  let serverOutput = '';
  serverProc.stderr.on('data', chunk => { serverError += chunk; });
  serverProc.stdout.on('data', chunk => { serverOutput += chunk; });

  async function rpc(id, method, params = {}, endpoint = baseUrl) {
    let response;
    try {
      response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
      });
    } catch (error) {
      assert.fail(`${serverError || error.message}`);
    }
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
    assert.equal(started.error, undefined, started.error?.message);
    assert.equal(started.result.host, 'running');
    assert.equal(started.result.servers.length, 1);
    assert.equal(started.result.servers[0].id, 'dummy');
    assert.notEqual(started.result.servers[0].status, 'running');

    const afterStartLocalTools = await rpc(4, 'tools/list');
    assert.equal(afterStartLocalTools.result.tools.length, 4, 'El host externo no se agrega al proveedor local');

    const externalTools = await rpc(5, 'tools/list', {}, `${baseUrl}/mcp/external`);
    assert.deepEqual(externalTools.result.tools, [], 'No se publican herramientas hasta arrancar un servicio externo');

    const invalidService = await rpc(6, 'zerochat/external/servers/start', { serverId: 'missing' });
    assert.equal(invalidService.error.code, -32011);

    const serviceStarted = await rpc(7, 'zerochat/external/servers/start', { serverId: 'dummy' });
    const dummy = serviceStarted.result.servers.find(server => server.id === 'dummy');
    assert.equal(dummy.status, 'running');
    assert.equal(dummy.installed, true);
    assert.equal(dummy.toolCount, 1);

    const published = await rpc(8, 'tools/list', {}, `${baseUrl}/mcp/external`);
    assert.equal(published.result.tools.length, 1);
    assert.equal(published.result.tools[0].name, 'mcp_dummy_echo');
    assert.deepEqual(published.result.tools[0].metadata, { mcpServerId: 'dummy', originalName: 'echo' });

    const echo = await rpc(9, 'tools/call', { name: 'mcp_dummy_echo', arguments: { message: 'hello' } }, `${baseUrl}/mcp/external`);
    assert.deepEqual(echo.result.content, [{ type: 'text', text: 'echo: hello' }]);
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.match(serverOutput, /^\[\d{2}:\d{2}:\d{2}\] REQUEST MCP tools\/call$/m);
    assert.match(serverOutput, /^\[\d{2}:\d{2}:\d{2}\] RESPONSE MCP tools\/call HTTP 200 ok$/m);
    assert.doesNotMatch(serverOutput, /hello/);
    const rejectedTool = await rpc(10, 'tools/call', { name: 'mcp_dummy_missing', arguments: {} }, `${baseUrl}/mcp/external`);
    assert.equal(rejectedTool.error.code, -32001);

    const serviceStopped = await rpc(11, 'zerochat/external/servers/stop', { serverId: 'dummy' });
    assert.equal(serviceStopped.result.servers.find(server => server.id === 'dummy').status, 'stopped');
    assert.deepEqual((await rpc(12, 'tools/list', {}, `${baseUrl}/mcp/external`)).result.tools, []);

    const stopped = await rpc(13, 'zerochat/external/stop');
    assert.equal(stopped.result.host, 'stopped');
    const disconnected = await rpc(14, 'tools/list', {}, `${baseUrl}/mcp/external`);
    assert.equal(disconnected.error.code, -32001);
  } finally {
    serverProc.kill('SIGINT');
    if (serverProc.exitCode === null) {
      await new Promise(resolve => serverProc.once('close', resolve));
    }
    fs.rmSync(mcpHome, { recursive: true, force: true });
    fs.rmSync(releaseRoot, { recursive: true, force: true });
  }
});
