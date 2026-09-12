const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

test('Servidor Local Python - JSON-RPC 2.0 y servicios de software (archivos, búsqueda, edición, terminal y navegador)', async () => {
  const serverPath = path.resolve(__dirname, '../scripts/mcp_server.py');
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

    // 4. JSON-RPC: tools/list
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
    assert.equal(tools.length, 6);
    const toolNames = tools.map(t => t.name);
    assert.ok(toolNames.includes('list_directory'));
    assert.ok(toolNames.includes('read_file'));
    assert.ok(toolNames.includes('search_files'));
    assert.ok(toolNames.includes('edit_file'));
    assert.ok(toolNames.includes('execute_command'));
    assert.ok(toolNames.includes('browser_navigate'));

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

    // 7. tools/call: search_files (por nombre y contenido)
    const searchRes = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'search_files',
          arguments: { directory: '.', query: 'ZeroChat', max_results: 2 }
        }
      })
    });
    const searchData = await searchRes.json();
    const searchPayload = JSON.parse(searchData.result.content[0].text);
    assert.equal(searchPayload.success, true);
    assert.ok(searchPayload.matches.length > 0);

    // 8. tools/call: edit_file (creación, edición atómica y reemplazo)
    const tmpFile = path.resolve(__dirname, `temp_test_${Date.now()}.txt`);
    try {
      // Escritura
      const writeRes = await fetch(baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 6,
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
          id: 7,
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

    // 9. tools/call: browser_navigate (manejo gracioso si no está instalado playwright)
    const navRes = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: {
          name: 'browser_navigate',
          arguments: { url: 'https://example.com' }
        }
      })
    });
    const navData = await navRes.json();
    const navPayload = JSON.parse(navData.result.content[0].text);
    if (!navPayload.success) {
      assert.ok(navPayload.error.includes('playwright'));
    } else {
      assert.ok(navPayload.url);
    }
  } finally {
    serverProc.kill('SIGTERM');
  }
});
