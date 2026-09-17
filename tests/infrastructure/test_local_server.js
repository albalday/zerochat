const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

test('Servidor local zerochat.py: token de sesión, herramientas core y aislamiento', async () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const serverPath = path.resolve(repoRoot, 'zerochat.py');
  const port = 6400 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const testToken = 'test-token-secret-12345';

  const serverProc = spawn('python3', [
    serverPath, '--port', String(port), '--token', testToken, '--no-browser', '--no-venv'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let serverError = '';
  let serverOutput = '';
  serverProc.stderr.on('data', chunk => { serverError += chunk; });
  serverProc.stdout.on('data', chunk => { serverOutput += chunk; });

  try {
    // 1. Esperar arranque
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const probeRes = await fetch(`${baseUrl}/?token=${testToken}`);
        if (probeRes.ok) break;
      } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 100));
      if (attempt === 29) {
        assert.fail(`El servidor zerochat.py no arrancó en ${baseUrl}. Error: ${serverError}`);
      }
    }

    // 2. Comprobar rechazo sin token (HTTP 401)
    const unauthGet = await fetch(`${baseUrl}/`);
    assert.equal(unauthGet.status, 401, 'Petición GET sin token debe ser rechazada con 401');

    const unauthPost = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    });
    assert.equal(unauthPost.status, 401, 'Petición POST sin token debe ser rechazada con 401');

    // 3. Comprobar rechazo con token inválido
    const invalidPost = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer wrong-token'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} })
    });
    assert.equal(invalidPost.status, 401, 'Petición con token erróneo debe ser 401');

    // 4. Comprobar autorización con cabecera Authorization: Bearer <token>
    const initRes = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${testToken}`
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'initialize', params: {} })
    });
    assert.equal(initRes.status, 200);
    const initJson = await initRes.json();
    assert.equal(initJson.result?.serverInfo?.name, 'ZeroChat Local Server');
    assert.equal(initJson.result?.serverInfo?.version, '7.0.0');

    // 5. Comprobar tools/list
    const toolsRes = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ZeroChat-Token': testToken
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} })
    });
    assert.equal(toolsRes.status, 200);
    const toolsJson = await toolsRes.json();
    const toolNames = (toolsJson.result?.tools || []).map(t => t.name);
    assert.ok(toolNames.includes('list_directory'));
    assert.ok(toolNames.includes('read_file'));
    assert.ok(toolNames.includes('edit_file'));
    assert.ok(toolNames.includes('execute_command'));

    // 6. Comprobar ejecución de herramienta read_file
    const callRes = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${testToken}`
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'read_file',
          arguments: { path: 'package.json', max_lines: 10 }
        }
      })
    });
    assert.equal(callRes.status, 200);
    const callJson = await callRes.json();
    assert.equal(callJson.result?.isError, false);
    const parsedContent = JSON.parse(callJson.result?.content?.[0]?.text);
    assert.equal(parsedContent.success, true);
    assert.match(parsedContent.content, /"version": "7.0.0"/);

    // 7. Comprobar flujo SSE con token en query param
    const sseRes = await fetch(`${baseUrl}/sse?token=${testToken}`, {
      headers: { 'Accept': 'text/event-stream' }
    });
    assert.equal(sseRes.status, 200);
    assert.equal(sseRes.headers.get('content-type'), 'text/event-stream');

    // 8. Comprobar servicios MCP externos arrancables individualmente
    const statusRes = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${testToken}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'zerochat/external/status', params: {} })
    });
    assert.equal(statusRes.status, 200);
    const statusJson = await statusRes.json();
    assert.equal(statusJson.result?.host, 'running');
    const serverIds = (statusJson.result?.servers || []).map(s => s.id);
    assert.ok(serverIds.includes('dummy_mcp'), 'dummy_mcp debe estar provisto');
    assert.ok(serverIds.includes('playwright'), 'playwright debe estar provisto');
    assert.ok(serverIds.includes('memory'), 'memory debe estar provisto');
    assert.ok(serverIds.includes('lsp'), 'lsp debe estar provisto');
    const dummyServer = (statusJson.result?.servers || []).find(s => s.id === 'dummy_mcp');
    assert.equal(dummyServer?.status, 'stopped');

    // Iniciar individualmente dummy_mcp
    const startRes = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${testToken}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'zerochat/external/servers/start', params: { serverId: 'dummy_mcp' } })
    });
    assert.equal(startRes.status, 200);
    const startJson = await startRes.json();
    const runningDummy = (startJson.result?.servers || []).find(s => s.id === 'dummy_mcp');
    assert.equal(runningDummy?.status, 'running');
    assert.equal(runningDummy?.toolCount, 1);

    // tools/list en /mcp/external
    const extToolsRes = await fetch(`${baseUrl}/mcp/external`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${testToken}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/list', params: {} })
    });
    assert.equal(extToolsRes.status, 200);
    const extToolsJson = await extToolsRes.json();
    const extToolNames = (extToolsJson.result?.tools || []).map(t => t.name);
    assert.ok(extToolNames.includes('mcp_dummyz5fzmcp_echo'));

    // tools/call ejecutando dummy_mcp echo
    const extCallRes = await fetch(`${baseUrl}/mcp/external`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${testToken}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: { name: 'mcp_dummyz5fzmcp_echo', arguments: { message: 'probando mcp' } }
      })
    });
    assert.equal(extCallRes.status, 200);
    const extCallJson = await extCallRes.json();
    assert.equal(extCallJson.result?.isError, false);
    assert.equal(extCallJson.result?.content?.[0]?.text, 'echo: probando mcp');

    // Detener individualmente dummy_mcp
    const stopRes = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${testToken}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'zerochat/external/servers/stop', params: { serverId: 'dummy_mcp' } })
    });
    assert.equal(stopRes.status, 200);
    const stopJson = await stopRes.json();
    const stoppedDummy = (stopJson.result?.servers || []).find(s => s.id === 'dummy_mcp');
    assert.equal(stoppedDummy?.status, 'stopped');
    assert.equal(stoppedDummy?.toolCount, 0);

  } finally {
    serverProc.kill('SIGTERM');
  }
});

test('Generación y persistencia de token diario en zerochat.py', async () => {
  const code = `
import zerochat
token1 = zerochat.get_daily_token()
token2 = zerochat.get_daily_token()
assert token1 == token2, "El token diario debe ser idempotente en el mismo día"
assert len(token1) > 20, "El token debe ser de longitud segura"
print("DAILY_TOKEN_OK")
`;
  const output = execFileSync('python3', ['-c', code], {
    cwd: path.resolve(__dirname, '../..'),
    encoding: 'utf8'
  });
  assert.ok(output.includes('DAILY_TOKEN_OK'));
});

