const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

test('Servidor Local Python - JSON-RPC 2.0, herramientas locales y router de servidores MCP stdio', async () => {
  const serverPath = path.resolve(__dirname, '../../scripts/mcp_server.py');
  const dummyFixturePath = path.resolve(__dirname, '../fixtures/dummy_mcp_server.py');
  const port = 6398;
  const baseUrl = `http://127.0.0.1:${port}`;

  const serverProc = spawn('python3', [serverPath, '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    // Esperar a que el servidor esté activo
    let connected = false;
    for (let i = 0; i < 40; i++) {
      try {
        const res = await fetch(baseUrl);
        if (res.ok) {
          connected = true;
          break;
        }
      } catch (e) {
        await new Promise(r => setTimeout(r, 100));
      }
    }
    assert.ok(connected, 'El servidor Python debe arrancar y responder en su puerto');

    // 1. Handshake OPTIONS (CORS y Private Network Access)
    const optRes = await fetch(baseUrl, { method: 'OPTIONS' });
    assert.equal(optRes.status, 204);
    assert.equal(optRes.headers.get('access-control-allow-origin'), '*');
    assert.equal(optRes.headers.get('access-control-allow-private-network'), 'true');

    // 2. Handshake GET /sse para clientes MCP
    const sseRes = await fetch(`${baseUrl}/sse`, {
      headers: { Accept: 'text/event-stream' }
    });
    assert.equal(sseRes.status, 200);
    const reader = sseRes.body.getReader();
    const { value } = await reader.read();
    await reader.cancel();
    const sseText = new TextDecoder().decode(value);
    assert.ok(sseText.includes('event: endpoint'));
    assert.ok(sseText.includes('data: /'));

    // 3. JSON-RPC: initialize
    const initRes = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05' }
      })
    });
    assert.equal(initRes.status, 200);
    const initData = await initRes.json();
    assert.equal(initData.result.serverInfo.name, 'ZeroChat Local Server');
    assert.ok(initData.result.capabilities.tools);

    // 4. JSON-RPC: tools/list (4 herramientas locales fijas)
    const listRes = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {}
      })
    });
    assert.equal(listRes.status, 200);
    const listData = await listRes.json();
    const tools = listData.result.tools;
    assert.equal(tools.length, 4, 'Debe incluir exactamente las 4 herramientas locales fijas');
    const toolNames = tools.map(t => t.name);
    assert.ok(toolNames.includes('list_directory'));
    assert.ok(toolNames.includes('read_file'));
    assert.ok(toolNames.includes('edit_file'));
    assert.ok(toolNames.includes('execute_command'));

    // 5. tools/call: execute_command (con informe de SO)
    const execRes = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'execute_command',
          arguments: { command: 'echo zerochat_server_ok' }
        }
      })
    });
    assert.equal(execRes.status, 200);
    const execData = await execRes.json();
    const execPayload = JSON.parse(execData.result.content[0].text);
    assert.equal(execPayload.success, true);
    assert.ok(execPayload.stdout.includes('zerochat_server_ok'));
    assert.ok(execPayload.os_info.system, 'Debe reportar el sistema operativo');
    assert.ok(execPayload.os_info.shell, 'Debe reportar la shell');

    // 6. tools/call: read_file (con soporte de rangos de líneas)
    const readRes = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'read_file',
          arguments: { path: 'package.json', start_line: 1, max_lines: 3 }
        }
      })
    });
    const readData = await readRes.json();
    const readPayload = JSON.parse(readData.result.content[0].text);
    assert.equal(readPayload.success, true);
    assert.equal(readPayload.lines_returned, 3);
    assert.ok(readPayload.content.includes('zerochat'));

    // 7. tools/call: edit_file (creación, edición atómica y reemplazo)
    const tmpFile = path.resolve(__dirname, `temp_test_${Date.now()}.txt`);
    try {
      // Escritura
      const writeRes = await fetch(baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 5,
          method: 'tools/call',
          params: {
            name: 'edit_file',
            arguments: { path: tmpFile, content: 'alpha\nbeta\ngamma\n', mode: 'write' }
          }
        })
      });
      const writeData = await writeRes.json();
      assert.equal(JSON.parse(writeData.result.content[0].text).success, true);
      assert.equal(fs.readFileSync(tmpFile, 'utf8'), 'alpha\nbeta\ngamma\n');

      // Reemplazo atómico de fragmento
      const replRes = await fetch(baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 6,
          method: 'tools/call',
          params: {
            name: 'edit_file',
            arguments: { path: tmpFile, content: 'BETA_MODIFICADA', mode: 'replace_chunk', target_content: 'beta' }
          }
        })
      });
      const replData = await replRes.json();
      assert.equal(JSON.parse(replData.result.content[0].text).success, true);
      assert.equal(fs.readFileSync(tmpFile, 'utf8'), 'alpha\nBETA_MODIFICADA\ngamma\n');
    } finally {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }

    // 8. tools/call: list_directory
    const listDirRes = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: {
          name: 'list_directory',
          arguments: { path: '.', max_depth: 1 }
        }
      })
    });
    const listDirData = await listDirRes.json();
    const listDirPayload = JSON.parse(listDirData.result.content[0].text);
    assert.equal(listDirPayload.success, true);
    assert.ok(listDirPayload.entries.length > 0);

    // 9. Router y ciclo de vida de servidor MCP stdio externo (/mcp/start, agregación y /mcp/stop)
    // 9a. Consultar lista de servidores
    const serversRes = await fetch(`${baseUrl}/mcp/servers`);
    assert.equal(serversRes.status, 200);
    const serversData = await serversRes.json();
    assert.ok(Array.isArray(serversData.servers));

    // 9b. Arrancar dummy server mediante /mcp/start
    const startMcpRes = await fetch(`${baseUrl}/mcp/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        server_id: 'dummy_server',
        config: {
          command: 'python3',
          args: [dummyFixturePath]
        }
      })
    });
    assert.equal(startMcpRes.status, 200);
    const startMcpData = await startMcpRes.json();
    assert.equal(startMcpData.success, true);
    assert.equal(startMcpData.server.status, 'running');

    // 9c. Comprobar que tools/list ahora agrega la herramienta externa (4 locales + 1 MCP = 5)
    const listAggRes = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/list',
        params: {}
      })
    });
    const listAggData = await listAggRes.json();
    assert.equal(listAggData.result.tools.length, 5);
    const aggNames = listAggData.result.tools.map(t => t.name);
    assert.ok(aggNames.includes('mcp__dummy_server__echo'));

    // 9d. Enrutamiento en tools/call hacia el servidor MCP externo
    const callMcpRes = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: {
          name: 'mcp__dummy_server__echo',
          arguments: { message: 'Mensaje desde ZeroChat' }
        }
      })
    });
    assert.equal(callMcpRes.status, 200);
    const callMcpData = await callMcpRes.json();
    assert.equal(callMcpData.result.content[0].text, 'echo: Mensaje desde ZeroChat');

    // 9e. Detener el servidor MCP externo mediante /mcp/stop
    const stopMcpRes = await fetch(`${baseUrl}/mcp/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server_id: 'dummy_server' })
    });
    assert.equal(stopMcpRes.status, 200);
    const stopMcpData = await stopMcpRes.json();
    assert.equal(stopMcpData.success, true);

    // 9f. tools/list regresa limpiamente a las 4 herramientas locales
    const listFinalRes = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/list', params: {} })
    });
    const listFinalData = await listFinalRes.json();
    assert.equal(listFinalData.result.tools.length, 4);

  } finally {
    serverProc.kill('SIGTERM');
  }
});
