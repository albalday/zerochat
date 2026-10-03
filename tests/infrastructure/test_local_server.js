const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const pkg = require('../../package.json');

// El backend no admite fijar el token por argumentos: las pruebas lo dejan
// preparado como token diario en un directorio de datos temporal.
const tokenDataDirs = [];
function tokenDataDir(token) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zerochat-token-'));
  const now = new Date();
  const today = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
    .map((part, index) => String(part).padStart(index ? 2 : 4, '0')).join('-');
  fs.mkdirSync(path.join(dataDir, 'config'), { mode: 0o700 });
  fs.writeFileSync(path.join(dataDir, 'config', 'token.json'), JSON.stringify({ token, date: today }), { mode: 0o600 });
  tokenDataDirs.push(dataDir);
  return dataDir;
}
test.after(() => {
  for (const dataDir of tokenDataDirs) fs.rmSync(dataDir, { recursive: true, force: true });
});

test('zerochat.py: la consola interactiva expone estado, ayuda y cierre ordenado', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const script = `
import argparse
import importlib.util
import sys
import time
from pathlib import Path
spec = importlib.util.spec_from_file_location('zerochat_console_test', Path(${JSON.stringify(path.resolve(__dirname, '../../zerochat.py'))}))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
parser = argparse.ArgumentParser(prog='zerochat.py')
assert 'usage: zerochat.py' in parser.format_help()

class InteractiveOutput:
    def __init__(self):
        import io
        self.output = io.StringIO()
    def isatty(self):
        return True
    def write(self, value):
        return self.output.write(value)
    def flush(self):
        return self.output.flush()

original_stdin = sys.stdin
original_stdout = sys.stdout
try:
    interactive = InteractiveOutput()
    sys.stdout = interactive
    module.CONSOLE_STATUS_IDLE_SECONDS = 0.02
    console = module.ConsoleControl(None, parser, target_url="http://127.0.0.1:6388/zerochat.html#token=abc")
    assert console.enabled is True
    console.start()
    console.log("primer log")
    time.sleep(0.04)
    assert interactive.output.getvalue().count("Comandos de consola:") == 1
    assert "ZeroChat activo" not in interactive.output.getvalue()
    time.sleep(0.04)
    assert interactive.output.getvalue().count("Comandos de consola:") == 1
    console.log("segundo log")
    time.sleep(0.04)
    assert interactive.output.getvalue().count("Comandos de consola:") == 2
    console.close()
finally:
    sys.stdin = original_stdin
    sys.stdout = original_stdout
`;
  assert.doesNotThrow(() => execFileSync('python3', ['-c', script], { cwd: repoRoot, stdio: 'pipe' }));
});

test('zerochat.py: reinstala los archivos MCP gestionados sin borrar datos ni servicios del usuario', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  assert.doesNotThrow(() => execFileSync('node', ['scripts/build-managed-services.mjs'], { cwd: repoRoot, stdio: 'pipe' }));
  const script = `
import importlib.util
import json
import os
import tempfile
from pathlib import Path

with tempfile.TemporaryDirectory() as temp_dir:
    os.environ["ZEROCHAT_DATA_DIR"] = temp_dir
    spec = importlib.util.spec_from_file_location("zerochat_managed_services_test", Path(${JSON.stringify(path.resolve(__dirname, '../../zerochat.py'))}))
    zerochat = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(zerochat)
    oauth_trace = zerochat._mcp_trace_text("https://auth.example/authorize?state=csrf-value&code=oauth-code&scope=openid")
    assert "csrf-value" not in oauth_trace
    assert "oauth-code" not in oauth_trace
    assert "scope=openid" in oauth_trace
    composio_definition = json.loads(zerochat.MANAGED_SERVICE_FILES["composio/service.json"])
    composio_args = composio_definition["launch"]["args"]
    metadata_index = composio_args.index("--static-oauth-client-metadata")
    assert json.loads(composio_args[metadata_index + 1])["client_name"] == "zerochat-mcp-remote"
    protocol_index = composio_args.index("--protocol")
    assert composio_args[protocol_index + 1] == "legacy"
    services_root = Path(temp_dir) / "services"
    managed_service = services_root / "playwright" / "service.json"
    runtime_marker = services_root / "playwright" / ".installed.json"
    user_service = services_root / "custom" / "service.json"
    managed_service.write_text("modified", encoding="utf-8")
    runtime_marker.write_text("keep", encoding="utf-8")
    user_service.parent.mkdir(parents=True)
    user_service.write_text('{"id":"custom"}', encoding="utf-8")

    zerochat.materialize_managed_services(services_root)

    repo_services = Path(${JSON.stringify(path.join(repoRoot, 'services'))})
    for relative_path, content in zerochat.MANAGED_SERVICE_FILES.items():
        assert (services_root / relative_path).read_text(encoding="utf-8") == content
        assert (repo_services / relative_path).read_text(encoding="utf-8") == content
    assert runtime_marker.read_text(encoding="utf-8") == "keep"
    assert user_service.read_text(encoding="utf-8") == '{"id":"custom"}'
`;
  assert.doesNotThrow(() => execFileSync('python3', ['-c', script], { cwd: repoRoot, stdio: 'pipe' }));
});

test('zerochat.py: un MCP propio conserva su API key local y la pasa desde launch.env', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const script = `
import importlib.util
import json
import os
import tempfile
from pathlib import Path
from unittest.mock import Mock, patch

with tempfile.TemporaryDirectory() as temp_dir:
    os.environ["ZEROCHAT_DATA_DIR"] = temp_dir
    spec = importlib.util.spec_from_file_location("zerochat_mcp_key_test", Path(${JSON.stringify(path.join(repoRoot, 'zerochat.py'))}))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    root = Path(temp_dir) / "services"
    custom = root / "custom-key"
    custom.mkdir()
    definition = {
        "id": "custom-key", "launch": {
            "executable": "\u0024{pythonExecutable}", "args": [],
            "env": {"SERVICE_API_KEY": "fixture-key", "HOME": "\u0024{serviceDir}"}
        }
    }
    config = custom / "service.json"
    config.write_text(json.dumps(definition), encoding="utf-8")
    config.chmod(0o600)
    traces = []
    module.console_log = lambda message, **kwargs: traces.append(message)
    manager = module.McpServiceManager(root)
    module.materialize_managed_services(root)
    assert json.loads(config.read_text()) == definition
    assert config.stat().st_mode & 0o777 == 0o600
    client = Mock(tools=[])
    client.running.return_value = True
    with patch.dict(os.environ, {"SERVICE_API_KEY": "inherited-fixture"}), patch.object(module, "StdioMcpClient", return_value=client) as constructor:
        manager.start("custom-key")
        env = constructor.call_args.args[3]
        assert env["SERVICE_API_KEY"] == "fixture-key"
        assert env["HOME"] == str(custom)
        assert "PATH" in env
        assert os.environ["SERVICE_API_KEY"] == "inherited-fixture"
        client.start.assert_called_once()
    assert "fixture-key" not in "".join(traces)
    assert next(item for item in manager.list_servers() if item["id"] == "custom-key")["status"] == "running"
    manager.close()
`;
  assert.doesNotThrow(() => execFileSync('python3', ['-c', script], { cwd: repoRoot, stdio: 'pipe' }));
});

test('zerochat.py: el arranque MCP deja traza de éxito y fallo en la consola', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const script = `
import importlib.util
import json
import os
import sys
import tempfile
import time
from pathlib import Path

with tempfile.TemporaryDirectory() as temp_dir:
    os.environ["ZEROCHAT_DATA_DIR"] = temp_dir
    spec = importlib.util.spec_from_file_location("zerochat_mcp_trace_test", Path(${JSON.stringify(path.resolve(__dirname, '../../zerochat.py'))}))
    zerochat = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(zerochat)
    root = Path(temp_dir) / "services"
    traces = []
    zerochat.console_log = lambda message, **_kwargs: traces.append(message)

    def write_service(server_id, script_text):
        service_dir = root / server_id
        service_dir.mkdir(parents=True)
        entrypoint = service_dir / "server.py"
        entrypoint.write_text(script_text, encoding="utf-8")
        (service_dir / "service.json").write_text(json.dumps({
            "id": server_id,
            "launch": {
                "executable": sys.executable,
                "args": [str(entrypoint)],
                "cwd": str(service_dir),
                "env": {},
                "handshakeTimeoutSeconds": 2
            }
        }), encoding="utf-8")

    write_service("healthy", '''import json, sys
for line in sys.stdin:
    request = json.loads(line)
    method = request.get("method")
    if method == "initialize":
        result = {"protocolVersion": "2024-11-05", "capabilities": {}, "serverInfo": {"name": "healthy", "version": "1"}}
    elif method == "tools/list":
        result = {"tools": []}
    else:
        continue
    print(json.dumps({"jsonrpc": "2.0", "id": request.get("id"), "result": result}), flush=True)
''')
    write_service("broken", 'import sys\\nprint("intentional MCP startup failure", file=sys.stderr, flush=True)\\nsys.exit(3)\\n')

    manager = zerochat.McpServiceManager(root)
    assert next(item for item in manager.start("healthy") if item["id"] == "healthy")["status"] == "running"
    assert next(item for item in manager.start("broken") if item["id"] == "broken")["status"] == "error"
    time.sleep(0.1)
    manager.close()

    joined = "\\n".join(traces)
    assert "[MCP healthy] start requested" in joined
    assert "[MCP healthy] launching:" in joined
    assert "[MCP healthy] handshake completed" in joined
    assert "[MCP healthy] started successfully" in joined
    assert "[MCP broken] stderr: intentional MCP startup failure" in joined
    assert "[MCP broken] start failed:" in joined
`;
  assert.doesNotThrow(() => execFileSync('python3', ['-c', script], { cwd: repoRoot, stdio: 'pipe' }));
});

async function waitForServer(baseUrl, testToken, serverProc, maxWaitMs = 15000) {
  const start = Date.now();
  let serverError = '';
  if (serverProc && serverProc.stderr) {
    serverProc.stderr.on('data', chunk => { serverError += chunk.toString(); });
  }
  while (Date.now() - start < maxWaitMs) {
    try {
      const probeRes = await fetch(`${baseUrl}/`, {
        headers: testToken ? { 'X-ZeroChat-Token': testToken } : {}
      });
      if (probeRes.ok) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail(`El servidor zerochat.py no arrancó en ${baseUrl} tras ${maxWaitMs}ms. Error: ${serverError}`);
}

test('Servidor local zerochat.py: token de sesión, herramientas core y aislamiento', async () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const serverPath = path.resolve(repoRoot, 'zerochat.py');
  const port = 6400 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const testToken = 'test-token-secret-12345';
  const nativeFetch = global.fetch;
  let toolAuthorization = null;
  const signedFetch = async (url, options = {}) => {
    const body = typeof options.body === 'string' ? options.body : '';
    let request;
    try { request = JSON.parse(body); } catch (_) {}
    if (toolAuthorization && request?.method === 'tools/call' && String(url).startsWith(baseUrl)) {
      const expiresAt = Date.now() + toolAuthorization.ttlMs;
      const nonce = crypto.randomBytes(16).toString('base64url');
      const pathName = new URL(url).pathname.replace(/\/$/, '') || '/';
      const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
      const signatureBase = JSON.stringify(['zerochat-tool-auth-v1', toolAuthorization.sessionId, 'POST', pathName, expiresAt, nonce, bodyHash]);
      const signature = crypto.createHmac('sha256', Buffer.from(toolAuthorization.key, 'base64url')).update(signatureBase).digest('base64url');
      options = { ...options, headers: { ...(options.headers || {}),
        'X-ZeroChat-Tool-Session': toolAuthorization.sessionId,
        'X-ZeroChat-Tool-Expires': String(expiresAt),
        'X-ZeroChat-Tool-Nonce': nonce,
        'X-ZeroChat-Tool-Signature': signature } };
    }
    return nativeFetch(url, options);
  };
  global.fetch = signedFetch;

  const serverProc = spawn('python3', [
    serverPath, '--port', String(port), '--no-browser', '--no-venv'
  ], { env: { ...process.env, ZEROCHAT_DATA_DIR: tokenDataDir(testToken) }, stdio: ['ignore', 'pipe', 'pipe'] });

  let serverError = '';
  let serverOutput = '';
  serverProc.stderr.on('data', chunk => { serverError += chunk; });
  serverProc.stdout.on('data', chunk => { serverOutput += chunk; });

  try {
    // 1. Esperar arranque
    await waitForServer(baseUrl, testToken, serverProc);

    // 2. Comprobar rechazo sin token (HTTP 401)
    const unauthGet = await fetch(`${baseUrl}/`);
    assert.equal(unauthGet.status, 401, 'Petición GET sin token debe ser rechazada con 401');

    const unauthPost = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'https://albalday.github.io' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    });
    assert.equal(unauthPost.status, 401, 'Petición POST sin token debe ser rechazada con 401');

    const favicon = await fetch(`${baseUrl}/favicon.ico`);
    assert.equal(favicon.status, 204);
    assert.equal(await favicon.text(), '');
    const forbiddenFavicon = await fetch(`${baseUrl}/favicon.ico`, {
      headers: { Origin: 'https://untrusted.example' }
    });
    assert.equal(forbiddenFavicon.status, 403);

    const querySse = await fetch(`${baseUrl}/sse?token=${testToken}`);
    assert.equal(querySse.status, 401);
    const { McpClient } = require('../../js/mcp.js');
    const client = new McpClient({ url: `${baseUrl}/sse`, token: testToken });
    try {
      assert.equal(await client.connectSseStream({ timeoutMs: 2000 }), `${baseUrl}/`);
      assert.equal(client.isSseActive, true);
      const tools = await client.request('tools/list');
      assert.ok(Array.isArray(tools.tools));
    } finally {
      client.disconnect();
    }

    // 3. Comprobar rechazo con token inválido
    const invalidPost = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://albalday.github.io',
        'Authorization': 'Bearer wrong-token'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} })
    });
    assert.equal(invalidPost.status, 401, 'Petición con token erróneo debe ser 401');

    // El token en la URL ya no autoriza peticiones.
    const queryTokenGet = await fetch(`${baseUrl}/?token=${testToken}`);
    assert.equal(queryTokenGet.status, 401, 'El token en query string debe ser rechazado');

    const invalidShapeRes = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://albalday.github.io',
        'Authorization': `Bearer ${testToken}`
      },
      body: JSON.stringify([])
    });
    assert.equal(invalidShapeRes.status, 400, 'Una petición JSON que no sea un objeto debe rechazarse');

    try {
      const oversizedRes = await fetch(baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Origin': 'https://albalday.github.io',
          'Authorization': `Bearer ${testToken}`
        },
        body: 'x'.repeat(1024 * 1024 + 1)
      });
      assert.equal(oversizedRes.status, 413, 'Un cuerpo superior al límite debe rechazarse');
    } catch (err) {
      if (err?.cause?.code !== 'EPIPE' && err?.cause?.code !== 'ECONNRESET') {
        throw err;
      }
    }

    // 4. Comprobar autorización con cabecera Authorization: Bearer <token>
    const initRes = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://albalday.github.io',
        'Authorization': `Bearer ${testToken}`
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'initialize', params: {} })
    });
    assert.equal(initRes.status, 200);
    const initJson = await initRes.json();
    assert.equal(initJson.result?.serverInfo?.name, 'ZeroChat Local Server');
    assert.equal(initJson.result?.serverInfo?.version, pkg.version.split('.').slice(0, 2).join('.'));
    toolAuthorization = initJson.result?.toolAuthorization;
    assert.equal(toolAuthorization?.version, 'zerochat-tool-auth-v1');
    const unsignedToolRes = await nativeFetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'https://albalday.github.io', 'Authorization': `Bearer ${testToken}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 301, method: 'tools/call', params: { name: 'list_directory', arguments: { path: '.' } } })
    });
    assert.equal(unsignedToolRes.status, 403, 'Una llamada tools/call sin sello debe rechazarse');
    const { McpClient: SignedMcpClient } = require('../../js/mcp.js');
    global.fetch = nativeFetch;
    const signedClient = new SignedMcpClient({ id: 'mcp_proxy', url: baseUrl, token: testToken });
    try {
      assert.equal((await signedClient.initialize()).success, true);
      assert.equal((await signedClient.callTool('list_directory', { path: '.' }, { toolAuthorization: true })).success, true);
    } finally {
      signedClient.disconnect();
      global.fetch = signedFetch;
    }

    // 5. Comprobar tools/list
    const toolsRes = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://albalday.github.io',
        'X-ZeroChat-Token': testToken
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} })
    });
    assert.equal(toolsRes.status, 200);
    const toolsJson = await toolsRes.json();
    const tools = toolsJson.result?.tools || [];
    const toolNames = tools.map(t => t.name);
    assert.ok(toolNames.includes('list_directory'));
    assert.ok(toolNames.includes('read_file'));
    assert.ok(toolNames.includes('write_file'));
    assert.ok(toolNames.includes('edit_file'));
    assert.ok(toolNames.includes('bash'));
    assert.ok(toolNames.includes('search_files'));
    assert.ok(toolNames.includes('execute_command'));
    assert.ok(typeof initJson.result?.serverInfo?.os === 'string', 'serverInfo debe publicar el SO detectado');
    const bashTool = tools.find(t => t.name === 'bash');
    assert.ok(bashTool?.description?.includes('Host OS:'), 'bash debe declarar el SO anfitrión');
    const execToolDef = tools.find(t => t.name === 'execute_command');
    assert.ok(execToolDef?.description?.includes('Host OS:'), 'execute_command debe declarar el SO anfitrión');
    assert.ok(toolNames.includes('get_diagnostics'));
    assert.ok(toolNames.includes('browser_action'));
    const browserAction = tools.find(t => t.name === 'browser_action');
    assert.equal(typeof browserAction?.availability?.available, 'boolean',
      'browser_action debe publicar su disponibilidad antes de poder activarse');
    const listDirectory = tools.find(t => t.name === 'list_directory');
    assert.equal(listDirectory?.inputSchema?.properties?.max_depth, undefined,
      'list_directory no debe publicar una profundidad recursiva inexistente');

    const availabilityRes = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://albalday.github.io',
        'X-ZeroChat-Token': testToken
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 41, method: 'tools/availability', params: { name: 'browser_action' } })
    });
    assert.equal(availabilityRes.status, 200);
    const availabilityJson = await availabilityRes.json();
    assert.equal(typeof availabilityJson.result?.available, 'boolean');

    // El contrato estricto rechaza parámetros que ya no existen.
    const obsoleteArgumentRes = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://albalday.github.io',
        'Authorization': `Bearer ${testToken}`
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 41,
        method: 'tools/call',
        params: {
          name: 'list_directory',
          arguments: { path: '.', max_depth: 2 }
        }
      })
    });
    assert.equal(obsoleteArgumentRes.status, 400);
    const obsoleteArgumentJson = await obsoleteArgumentRes.json();
    assert.match(obsoleteArgumentJson.error || '', /max_depth/);

    // 6. Comprobar ejecución de herramienta read_file
    const callRes = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://albalday.github.io',
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
    assert.match(parsedContent.content, new RegExp(`"version": "${pkg.version}"`));

    // 6.1. Comprobar read_file con rangos start_line y end_line
    const rangeRes = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://albalday.github.io',
        'Authorization': `Bearer ${testToken}`
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 51,
        method: 'tools/call',
        params: {
          name: 'read_file',
          arguments: { path: 'package.json', start_line: 1, end_line: 3 }
        }
      })
    });
    assert.equal(rangeRes.status, 200);
    const rangeJson = await rangeRes.json();
    const parsedRange = JSON.parse(rangeJson.result?.content?.[0]?.text);
    assert.equal(parsedRange.success, true);
    assert.equal(parsedRange.lines_returned, 3);
    assert.equal(parsedRange.start_line, 1);
    assert.equal(parsedRange.end_line, 3);

    // 6.2. Comprobar list_directory recursivo acotado
    const listRecRes = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://albalday.github.io',
        'Authorization': `Bearer ${testToken}`
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 52,
        method: 'tools/call',
        params: {
          name: 'list_directory',
          arguments: { path: 'tests/helpers', recursive: true }
        }
      })
    });
    assert.equal(listRecRes.status, 200);
    const listRecJson = await listRecRes.json();
    const parsedListRec = JSON.parse(listRecJson.result?.content?.[0]?.text);
    assert.equal(parsedListRec.success, true);
    assert.equal(parsedListRec.recursive, true);

    // 6.3. Comprobar write_file y edit_file quirúrgico (old_str -> new_str)
    const testFilePath = path.join(os.tmpdir(), `zerochat_test_p1_${Date.now()}.txt`);
    const writeRes = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://albalday.github.io',
        'Authorization': `Bearer ${testToken}`
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 53,
        method: 'tools/call',
        params: {
          name: 'write_file',
          arguments: { path: testFilePath, content: 'primera linea\nsegunda linea objetivo\ntercera linea\n' }
        }
      })
    });
    assert.equal(writeRes.status, 200);
    const writeJson = await writeRes.json();
    const parsedWrite = JSON.parse(writeJson.result?.content?.[0]?.text);
    assert.equal(parsedWrite.success, true);

    const editSurgicalRes = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://albalday.github.io',
        'Authorization': `Bearer ${testToken}`
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 54,
        method: 'tools/call',
        params: {
          name: 'edit_file',
          arguments: { path: testFilePath, old_str: 'segunda linea objetivo', new_str: 'segunda linea modificada' }
        }
      })
    });
    assert.equal(editSurgicalRes.status, 200);
    const editSurgicalJson = await editSurgicalRes.json();
    const parsedEditSurgical = JSON.parse(editSurgicalJson.result?.content?.[0]?.text);
    assert.equal(parsedEditSurgical.success, true);
    assert.equal(parsedEditSurgical.replacements, 1);

    // Error con 0 coincidencias
    const edit0Res = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://albalday.github.io',
        'Authorization': `Bearer ${testToken}`
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 55,
        method: 'tools/call',
        params: {
          name: 'edit_file',
          arguments: { path: testFilePath, old_str: 'linea inexistente', new_str: 'foo' }
        }
      })
    });
    assert.equal(edit0Res.status, 200);
    const edit0Json = await edit0Res.json();
    assert.equal(edit0Json.result?.isError, true);
    assert.match(edit0Json.result?.content?.[0]?.text || '', /Target text was not found|No se encontró el texto/);

    try { fs.unlinkSync(testFilePath); } catch (_) {}

    // 6.4. Comprobar herramienta bash con sesión persistente (variables de entorno y cwd)
    const bashEnv1Res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'https://albalday.github.io', 'Authorization': `Bearer ${testToken}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 56,
        method: 'tools/call',
        params: {
          name: 'bash',
          arguments: { command: 'export ZEROCHAT_PERSIST_VAR="antigravity_persistent_value" && cd tests/helpers' }
        }
      })
    });
    assert.equal(bashEnv1Res.status, 200);
    const bashEnv1Json = await bashEnv1Res.json();
    const parsedBash1 = JSON.parse(bashEnv1Json.result?.content?.[0]?.text);
    assert.equal(parsedBash1.success, true);
    assert.match(parsedBash1.cwd, /tests\/helpers$/);

    const bashEnv2Res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'https://albalday.github.io', 'Authorization': `Bearer ${testToken}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 57,
        method: 'tools/call',
        params: {
          name: 'bash',
          arguments: { command: 'echo "CHECK_VAR=$ZEROCHAT_PERSIST_VAR" && pwd' }
        }
      })
    });
    assert.equal(bashEnv2Res.status, 200);
    const bashEnv2Json = await bashEnv2Res.json();
    const parsedBash2 = JSON.parse(bashEnv2Json.result?.content?.[0]?.text);
    assert.equal(parsedBash2.success, true);
    assert.match(parsedBash2.stdout, /CHECK_VAR=antigravity_persistent_value/);
    assert.match(parsedBash2.stdout, /tests\/helpers/);

    // Restaurar cwd del bash
    await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'https://albalday.github.io', 'Authorization': `Bearer ${testToken}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 58,
        method: 'tools/call',
        params: { name: 'bash', arguments: { command: `cd ${JSON.stringify(repoRoot)}` } }
      })
    });

    // 6.5. Comprobar truncado defensivo de bash (>8.000 caracteres)
    const bashTruncRes = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'https://albalday.github.io', 'Authorization': `Bearer ${testToken}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 59,
        method: 'tools/call',
        params: {
          name: 'bash',
          arguments: { command: 'python3 -c "for i in range(120): print(f\'line {i:03d} \' + \'x\'*80)"' }
        }
      })
    });
    assert.equal(bashTruncRes.status, 200);
    const bashTruncJson = await bashTruncRes.json();
    const parsedBashTrunc = JSON.parse(bashTruncJson.result?.content?.[0]?.text);
    assert.equal(parsedBashTrunc.success, true);
    assert.equal(parsedBashTrunc.truncated, true);
    assert.match(parsedBashTrunc.stdout, /Output truncated|Salida truncada/);
    assert.match(parsedBashTrunc.stdout, /line 000/);
    assert.match(parsedBashTrunc.stdout, /line 119/);

    // 6.6. Comprobar search_files con regex y filtro glob
    const searchRes = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'https://albalday.github.io', 'Authorization': `Bearer ${testToken}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 60,
        method: 'tools/call',
        params: {
          name: 'search_files',
          arguments: { query: 'PersistentShellSession', path: '.', file_pattern: '*.py' }
        }
      })
    });
    assert.equal(searchRes.status, 200);
    const searchJson = await searchRes.json();
    const parsedSearch = JSON.parse(searchJson.result?.content?.[0]?.text);
    assert.equal(parsedSearch.success, true);
    assert.ok(parsedSearch.total_matches > 0);
    assert.ok(parsedSearch.matches.some(m => m.relative_path.includes('dd-tools.py') || m.relative_path.includes('zerochat.py')));

    // 6.7. Comprobar get_diagnostics en archivo específico
    const diagRes = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'https://albalday.github.io', 'Authorization': `Bearer ${testToken}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 61,
        method: 'tools/call',
        params: {
          name: 'get_diagnostics',
          arguments: { path: 'package.json' }
        }
      })
    });
    assert.equal(diagRes.status, 200);
    const diagJson = await diagRes.json();
    const parsedDiag = JSON.parse(diagJson.result?.content?.[0]?.text);
    assert.equal(parsedDiag.success, true);
    assert.equal(parsedDiag.error_count, 0);

    // 6.8. Comprobar browser_action (navigate y screenshot)
    const navRes = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'https://albalday.github.io', 'Authorization': `Bearer ${testToken}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 62,
        method: 'tools/call',
        params: {
          name: 'browser_action',
          arguments: { action: 'navigate', url: 'about:blank' }
        }
      })
    });
    assert.equal(navRes.status, 200);
    const navJson = await navRes.json();
    const parsedNav = JSON.parse(navJson.result?.content?.[0]?.text);
    assert.equal(parsedNav.success, true);
    assert.equal(parsedNav.action, 'navigate');

    const screenshotRes = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'https://albalday.github.io', 'Authorization': `Bearer ${testToken}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 63,
        method: 'tools/call',
        params: {
          name: 'browser_action',
          arguments: { action: 'screenshot' }
        }
      })
    });
    assert.equal(screenshotRes.status, 200);
    const screenshotJson = await screenshotRes.json();
    const parsedScreenshot = JSON.parse(screenshotJson.result?.content?.[0]?.text);
    assert.equal(parsedScreenshot.success, true);
    assert.equal(parsedScreenshot.action, 'screenshot');
    assert.ok(typeof parsedScreenshot.image_base64 === 'string' && parsedScreenshot.image_base64.length > 50);

    // 7. Comprobar flujo SSE con token en cabecera
    const sseRes = await fetch(`${baseUrl}/sse`, {
      headers: { 'Accept': 'text/event-stream', 'X-ZeroChat-Token': testToken }
    });
    assert.equal(sseRes.status, 200);
    assert.equal(sseRes.headers.get('content-type'), 'text/event-stream');

    // 8. Comprobar servicios MCP externos arrancables individualmente
    const statusRes = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'https://albalday.github.io', 'Authorization': `Bearer ${testToken}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'zerochat/external/status', params: {} })
    });
    assert.equal(statusRes.status, 200);
    const statusJson = await statusRes.json();
    assert.equal(statusJson.result?.host, 'running');
    const serverIds = (statusJson.result?.servers || []).map(s => s.id);
    assert.ok(serverIds.includes('ejemplo'), 'ejemplo debe estar provisto');
    assert.ok(serverIds.includes('composio'), 'composio debe estar provisto');
    assert.ok(serverIds.includes('playwright'), 'playwright debe estar provisto');
    assert.ok(serverIds.includes('memory'), 'memory debe estar provisto');
    assert.equal(serverIds.includes('lsp'), false, 'lsp no debe ofrecerse como servicio integrado');
    const exampleServer = (statusJson.result?.servers || []).find(s => s.id === 'ejemplo');
    assert.equal(exampleServer?.status, 'stopped');
    assert.equal(exampleServer?.help?.url, 'help/mcp.html#crear-mcp-con-agente');
    const composioServer = (statusJson.result?.servers || []).find(s => s.id === 'composio');
    assert.deepEqual(composioServer?.remote, {
      type: 'mcp-remote',
      transport: 'streamable-http',
      url: 'https://connect.composio.dev/mcp',
      authentication: 'composio-connect'
    });

    // Iniciar individualmente el ejemplo
    const startRes = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'https://albalday.github.io', 'Authorization': `Bearer ${testToken}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'zerochat/external/servers/start', params: { serverId: 'ejemplo' } })
    });
    assert.equal(startRes.status, 200);
    const startJson = await startRes.json();
    const runningExample = (startJson.result?.servers || []).find(s => s.id === 'ejemplo');
    assert.equal(runningExample?.status, 'running');
    assert.equal(runningExample?.toolCount, 1);

    // tools/list en /mcp/external
    const extToolsRes = await fetch(`${baseUrl}/mcp/external`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'https://albalday.github.io', 'Authorization': `Bearer ${testToken}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/list', params: {} })
    });
    assert.equal(extToolsRes.status, 200);
    const extToolsJson = await extToolsRes.json();
    const extToolNames = (extToolsJson.result?.tools || []).map(t => t.name);
    assert.ok(extToolNames.includes('ejemplo_echo'));

    // tools/call ejecutando el echo del ejemplo
    const extCallRes = await fetch(`${baseUrl}/mcp/external`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'https://albalday.github.io', 'Authorization': `Bearer ${testToken}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: { name: 'ejemplo_echo', arguments: { message: 'probando mcp' } }
      })
    });
    assert.equal(extCallRes.status, 200);
    const extCallJson = await extCallRes.json();
    assert.equal(extCallJson.result?.isError, false);
    assert.equal(extCallJson.result?.content?.[0]?.text, 'echo: probando mcp');

    // Detener individualmente el ejemplo
    const stopRes = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${testToken}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'zerochat/external/servers/stop', params: { serverId: 'ejemplo' } })
    });
    assert.equal(stopRes.status, 200);
    const stopJson = await stopRes.json();
    const stoppedExample = (stopJson.result?.servers || []).find(s => s.id === 'ejemplo');
    assert.equal(stoppedExample?.status, 'stopped');
    assert.equal(stoppedExample?.toolCount, 0);

  } finally {
    global.fetch = nativeFetch;
    serverProc.kill('SIGTERM');
  }
});


test('zerochat.py: execute_command con cwd inexistente devuelve error sin ejecutar el comando', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const script = `
import importlib.util
import json
import os
import tempfile
from pathlib import Path

with tempfile.TemporaryDirectory() as temp_dir:
    os.environ["ZEROCHAT_DATA_DIR"] = temp_dir
    spec = importlib.util.spec_from_file_location("zerochat_execute_cwd_test", Path(${JSON.stringify(path.join(repoRoot, 'zerochat.py'))}))
    zerochat = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(zerochat)
    marker = Path(temp_dir) / "marker.txt"
    missing = Path(temp_dir) / "missing"
    result = json.loads(zerochat.execute_command(f"touch {marker}", cwd=str(missing)))
    assert result["success"] is False
    assert "does not exist" in result["error"]
    assert not marker.exists()
    a_file = Path(temp_dir) / "file.txt"
    a_file.write_text("x", encoding="utf-8")
    result = json.loads(zerochat.execute_command("pwd", cwd=str(a_file)))
    assert result["success"] is False
    ok = json.loads(zerochat.execute_command("pwd", cwd=temp_dir))
    assert ok["success"] is True
`;
  assert.doesNotThrow(() => execFileSync('python3', ['-c', script], { cwd: repoRoot, stdio: 'pipe' }));
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zerochat-daily-token-'));
  try {
    const output = execFileSync('python3', ['-c', code], {
      cwd: path.resolve(__dirname, '../..'),
      env: { ...process.env, ZEROCHAT_DATA_DIR: dataDir },
      encoding: 'utf8'
    });
    assert.ok(output.includes('DAILY_TOKEN_OK'));
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('zerochat.py: el token diario y su directorio se crean solo legibles por el usuario', { skip: process.platform === 'win32' }, () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const script = `
import importlib.util
import json
import os
import stat
import tempfile
from pathlib import Path

os.umask(0o022)
with tempfile.TemporaryDirectory() as temp_dir:
    os.environ["ZEROCHAT_DATA_DIR"] = temp_dir
    config_dir = Path(temp_dir) / "config"
    config_dir.mkdir(mode=0o755)
    stale = config_dir / "token.json"
    stale.write_text(json.dumps({"token": "x" * 43, "date": "2000-01-01"}), encoding="utf-8")
    stale.chmod(0o644)
    spec = importlib.util.spec_from_file_location("zerochat_token_perms_test", Path(${JSON.stringify(path.join(repoRoot, 'zerochat.py'))}))
    zerochat = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(zerochat)
    token_file = config_dir / "token.json"
    # Importar el módulo no genera ni modifica el token: solo lo hace main().
    assert zerochat.SESSION_TOKEN == ""
    assert json.loads(token_file.read_text(encoding="utf-8"))["token"] == "x" * 43
    token = zerochat.get_daily_token()
    assert stat.S_IMODE(config_dir.stat().st_mode) == 0o700
    assert stat.S_IMODE(token_file.stat().st_mode) == 0o600
    assert json.loads(token_file.read_text(encoding="utf-8"))["token"] == token
    assert token != "x" * 43
    assert not (config_dir / "token.json.tmp").exists()

    # Un token vigente creado con la umask por una versión anterior también se corrige.
    token_file.chmod(0o644)
    assert zerochat.get_daily_token() == token
    assert stat.S_IMODE(token_file.stat().st_mode) == 0o600
`;
  assert.doesNotThrow(() => execFileSync('python3', ['-c', script], { cwd: repoRoot, stdio: 'pipe' }));
});

test('Versionado: el backend usa major.minor y la interfaz conserva el parche', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const output = execFileSync('python3', ['-c', `
import zerochat
assert zerochat.VERSION == '${pkg.version.split('.').slice(0, 2).join('.')}'
assert zerochat.UI_VERSION == '${pkg.version}'
print('VERSION_POLICY_OK')
`], { cwd: repoRoot, encoding: 'utf8' });
  assert.ok(output.includes('VERSION_POLICY_OK'));
});

test('Detección de entorno de desarrollo y servicio de zerochat.html y estáticos en zerochat.py', async () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const serverPath = path.resolve(repoRoot, 'zerochat.py');
  const port = 7400 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const testToken = 'test-token-dev-auto';

  // Iniciar sin --ui-url para verificar auto-detección
  const serverProc = spawn('python3', [
    serverPath, '--port', String(port), '--no-browser', '--no-venv'
  ], { cwd: repoRoot, env: { ...process.env, ZEROCHAT_DATA_DIR: tokenDataDir(testToken) }, stdio: ['ignore', 'pipe', 'pipe'] });

  let serverOutput = '';
  serverProc.stdout.on('data', chunk => { serverOutput += chunk; });

  try {
    // 1. Esperar arranque
    await waitForServer(baseUrl, testToken, serverProc);

    // 2. Verificar detección en stdout del banner
    assert.match(serverOutput, /Modo de ejecución\s*:\s*Desarrollo local/);
    assert.match(serverOutput, new RegExp(`Destino Web\\s*:\\s*http://127\\.0\\.0\\.1:${port}/zerochat\\.html`));

    // 3. Verificar servicio de zerochat.html sin necesidad de token en headers
    const htmlRes = await fetch(`${baseUrl}/zerochat.html`);
    assert.equal(htmlRes.status, 200, 'Debe servir zerochat.html con 200 OK');
    assert.match(htmlRes.headers.get('content-type') || '', /text\/html/);
    const htmlText = await htmlRes.text();
    assert.ok(htmlText.includes('ZeroChat'), 'El contenido debe ser el HTML de ZeroChat');

    // 4. Verificar servicio de assets estáticos (js, css, manifest)
    const jsRes = await fetch(`${baseUrl}/js/app.js`);
    assert.equal(jsRes.status, 200);
    assert.match(jsRes.headers.get('content-type') || '', /javascript/);
    await jsRes.text();

    const cssRes = await fetch(`${baseUrl}/css/tokens.css`);
    assert.equal(cssRes.status, 200);
    assert.match(cssRes.headers.get('content-type') || '', /text\/css/);
    await cssRes.text();

    const manifestRes = await fetch(`${baseUrl}/manifest.webmanifest`);
    assert.equal(manifestRes.status, 200);
    assert.match(manifestRes.headers.get('content-type') || '', /manifest/);
    await manifestRes.text();

    // 5. Verificar protección anti-path-traversal
    const traversalRes = await fetch(`${baseUrl}/../package.json`);
    assert.notEqual(traversalRes.status, 200, 'No debe permitir acceso fuera de la raíz');
    await traversalRes.text();
  } finally {
    serverProc.kill('SIGTERM');
  }
});

test('Apertura de navegador en zerochat.py: open_browser prioriza herramientas de sistema y desacopla el proceso', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const testScript = `
import sys
import os
import subprocess
from unittest.mock import patch, MagicMock
import zerochat

# La comprobación de browser_action solo inspecciona requisitos: no inicia Chromium.
with patch('subprocess.Popen') as mock_popen:
    availability = zerochat.browser_action_availability()
    assert isinstance(availability.get('available'), bool)
    mock_popen.assert_not_called()

# 1. En Termux se prioriza termux-open-url incluso si xdg-open está disponible
with patch('subprocess.Popen') as mock_popen, patch('shutil.which', side_effect=lambda cmd: '/data/data/com.termux/files/usr/bin/' + cmd if cmd in ('termux-open-url', 'xdg-open') else None), patch.dict(os.environ, {'TERMUX_VERSION': '0.118'}, clear=True):
    with patch.object(sys, 'platform', 'linux'):
        res = zerochat.open_browser('http://127.0.0.1:6388/zerochat.html')
        assert res is True, "open_browser debe retornar True con termux-open-url"
        mock_popen.assert_called_once()
        args, kwargs = mock_popen.call_args
        assert args[0] == ['termux-open-url', 'http://127.0.0.1:6388/zerochat.html']
        assert kwargs.get('start_new_session') is True
        assert kwargs.get('stdout') == subprocess.DEVNULL
        assert kwargs.get('stderr') == subprocess.DEVNULL

# 2. En Linux de escritorio con xdg-open disponible
with patch('subprocess.Popen') as mock_popen, patch('shutil.which', side_effect=lambda cmd: '/usr/bin/' + cmd if cmd == 'xdg-open' else None), patch.dict(os.environ, {}, clear=True):
    with patch.object(sys, 'platform', 'linux'):
        res = zerochat.open_browser('http://127.0.0.1:6388/zerochat.html')
        assert res is True, "open_browser debe retornar True con xdg-open"
        mock_popen.assert_called_once()
        args, kwargs = mock_popen.call_args
        assert args[0] == ['xdg-open', 'http://127.0.0.1:6388/zerochat.html']
        assert kwargs.get('start_new_session') is True
        assert kwargs.get('stdout') == subprocess.DEVNULL
        assert kwargs.get('stderr') == subprocess.DEVNULL

# 3. El prefijo de Termux también se detecta cuando TERMUX_VERSION no está definido
with patch('subprocess.Popen') as mock_popen, patch('shutil.which', side_effect=lambda cmd: '/data/data/com.termux/files/usr/bin/' + cmd if cmd in ('termux-open-url', 'xdg-open') else None), patch.dict(os.environ, {'PREFIX': '/data/data/com.termux/files/usr'}, clear=True):
    with patch.object(sys, 'platform', 'linux'):
        res = zerochat.open_browser('http://127.0.0.1:6388/zerochat.html')
        assert res is True, "open_browser debe detectar Termux por PREFIX"
        mock_popen.assert_called_once()
        args, kwargs = mock_popen.call_args
        assert args[0] == ['termux-open-url', 'http://127.0.0.1:6388/zerochat.html']

# 4. Termux usa termux-open-url aunque Python se identifique como Android
with patch('subprocess.Popen') as mock_popen, patch('shutil.which', return_value='/data/data/com.termux/files/usr/bin/termux-open-url'), patch.dict(os.environ, {'TERMUX_VERSION': '0.118'}, clear=True):
    with patch.object(sys, 'platform', 'android'):
        res = zerochat.open_browser('http://127.0.0.1:6388/zerochat.html')
        assert res is True, "open_browser debe priorizar Termux también en Android"
        args, kwargs = mock_popen.call_args
        assert args[0] == ['termux-open-url', 'http://127.0.0.1:6388/zerochat.html']

# 5. Termux recibe un comando manual seguro que conserva el token de sesión
termux_url = 'https://albalday.github.io/zerochat/zerochat.html#token=test-token&host=127.0.0.1&port=6388'
with patch.dict(os.environ, {'PREFIX': '/data/data/com.termux/files/usr'}, clear=True):
    assert zerochat.get_manual_browser_command(termux_url) == "termux-open-url 'https://albalday.github.io/zerochat/zerochat.html#token=test-token&host=127.0.0.1&port=6388'"

# 6. Termux usa la ruta absoluta de PREFIX si el venv no hereda PATH
with patch('subprocess.Popen') as mock_popen, patch('shutil.which', return_value=None), patch.object(zerochat.Path, 'is_file', return_value=True), patch.dict(os.environ, {'PREFIX': '/data/data/com.termux/files/usr'}, clear=True):
    with patch.object(sys, 'platform', 'linux'):
        res = zerochat.open_browser('http://127.0.0.1:6388/zerochat.html')
        assert res is True, "open_browser debe usar la ruta absoluta de Termux"
        args, kwargs = mock_popen.call_args
        assert args[0] == ['/data/data/com.termux/files/usr/bin/termux-open-url', 'http://127.0.0.1:6388/zerochat.html']

# 7. Termux informa el fallo de lanzamiento en lugar de ocultarlo y probar otro launcher
with patch('subprocess.Popen', side_effect=PermissionError('permiso denegado')), patch('shutil.which', return_value='/data/data/com.termux/files/usr/bin/termux-open-url'), patch.dict(os.environ, {'PREFIX': '/data/data/com.termux/files/usr'}, clear=True):
    with patch.object(sys, 'platform', 'linux'):
        try:
            zerochat.open_browser('http://127.0.0.1:6388/zerochat.html')
            raise AssertionError('open_browser debe propagar el error de termux-open-url')
        except RuntimeError as err:
            assert 'permiso denegado' in str(err)
            assert 'termux_detectado=True' in str(err)

# 8. En Linux sin xdg-open pero con gio disponible
with patch('subprocess.Popen') as mock_popen, patch('shutil.which', side_effect=lambda cmd: '/usr/bin/' + cmd if cmd == 'gio' else None), patch.dict(os.environ, {}, clear=True):
    with patch.object(sys, 'platform', 'linux'):
        res = zerochat.open_browser('http://127.0.0.1:6388/zerochat.html')
        assert res is True, "open_browser debe retornar True con gio"
        mock_popen.assert_called_once()
        args, kwargs = mock_popen.call_args
        assert args[0] == ['gio', 'open', 'http://127.0.0.1:6388/zerochat.html']
        assert kwargs.get('start_new_session') is True

# 9. Fallback a webbrowser cuando no hay herramientas de sistema
with patch('shutil.which', return_value=None), patch('webbrowser.open', return_value=True) as mock_wb, patch.dict(os.environ, {}, clear=True):
    with patch.object(sys, 'platform', 'linux'):
        res = zerochat.open_browser('http://127.0.0.1:6388/zerochat.html')
        assert res is True
        mock_wb.assert_called_once_with('http://127.0.0.1:6388/zerochat.html')

# 10. Un navegador que rechaza la URL conserva un error diagnosticable
with patch('shutil.which', return_value=None), patch('webbrowser.open', return_value=False), patch.dict(os.environ, {}, clear=True):
    with patch.object(sys, 'platform', 'linux'):
        try:
            zerochat.open_browser('http://127.0.0.1:6388/zerochat.html')
            raise AssertionError('open_browser debe explicar un lanzamiento rechazado')
        except RuntimeError as err:
            assert 'Ningún lanzador de navegador aceptó' in str(err)
            assert 'termux_detectado=False' in str(err)
            assert 'webbrowser: devolvió False' in str(err)

print("OPEN_BROWSER_TEST_OK")
`;

  const output = execFileSync('python3', ['-c', testScript], {
    cwd: repoRoot,
    encoding: 'utf8'
  });
  assert.ok(output.includes('OPEN_BROWSER_TEST_OK'), 'La prueba de open_browser debe completarse correctamente');
});

test('zerochat.py: logging de peticiones y respuestas con HH:MM:SS, sin datos comprometidos y con detalle de errores', async () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const serverPath = path.resolve(repoRoot, 'zerochat.py');
  const port = 6400 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const testToken = 'super-secret-token-xyz-987';

  const serverProc = spawn('python3', [
    serverPath, '--port', String(port), '--no-browser', '--no-venv'
  ], { env: { ...process.env, ZEROCHAT_DATA_DIR: tokenDataDir(testToken) }, stdio: ['ignore', 'pipe', 'pipe'] });

  let serverOutput = '';
  serverProc.stdout.on('data', chunk => { serverOutput += chunk.toString(); });

  try {
    // Esperar arranque comprobando probe con token
    await waitForServer(baseUrl, testToken, serverProc);

    // 1. Petición GET sin token (401 Unauthorized)
    await fetch(`${baseUrl}/`);

    // 2. Petición GET autenticada por cabecera
    await fetch(`${baseUrl}/`, { headers: { 'X-ZeroChat-Token': testToken } });

    // 3. Petición POST con initialize
    const loggingInitRes = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${testToken}`
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'initialize', params: {} })
    });
    const loggingAuth = (await loggingInitRes.json()).result?.toolAuthorization;

    // 4. Petición POST con tools/call fallida (archivo no existente) con argumento sensible
    await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${testToken}`
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: {
          name: 'read_file',
          arguments: {
            path: 'archivo_que_no_existe_12345.txt',
            secret_payload: 'super_secret_payload_content_12345'
          }
        }
      })
    });

    // 5. Petición POST con JSON malformado (400 Bad Request)
    await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${testToken}`
      },
      body: '{ json_invalido: true '
    });

    // 6. Petición POST con herramienta no existente (-32601)
    const unknownBody = JSON.stringify({
      jsonrpc: '2.0', id: 12, method: 'tools/call',
      params: { name: 'herramienta_fantasma', arguments: { secret_api_key: 'confidential_key_abc_999' } }
    });
    const unknownExpires = Date.now() + loggingAuth.ttlMs;
    const unknownNonce = crypto.randomBytes(16).toString('base64url');
    const unknownHash = crypto.createHash('sha256').update(unknownBody).digest('hex');
    const unknownBase = JSON.stringify(['zerochat-tool-auth-v1', loggingAuth.sessionId, 'POST', '/', unknownExpires, unknownNonce, unknownHash]);
    const unknownSignature = crypto.createHmac('sha256', Buffer.from(loggingAuth.key, 'base64url')).update(unknownBase).digest('base64url');
    await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${testToken}`,
        'X-ZeroChat-Tool-Session': loggingAuth.sessionId,
        'X-ZeroChat-Tool-Expires': String(unknownExpires),
        'X-ZeroChat-Tool-Nonce': unknownNonce,
        'X-ZeroChat-Tool-Signature': unknownSignature
      },
      body: unknownBody
    });

    // Dar margen para vaciar buffers de stdout
    await new Promise(resolve => setTimeout(resolve, 150));

    // Validar líneas con formato [HH:MM:SS]
    const timestampRegex = /\[\d{2}:\d{2}:\d{2}\]/;
    assert.match(serverOutput, timestampRegex, 'Los logs deben incluir marca temporal [HH:MM:SS]');

    // Validar líneas de petición (-->) y respuesta (<--)
    assert.match(serverOutput, /\[\d{2}:\d{2}:\d{2}\]\s+-->\s+GET\s+\//, 'Debe registrarse línea de petición GET');
    assert.match(serverOutput, /\[\d{2}:\d{2}:\d{2}\]\s+<--\s+401 Unauthorized/, 'Debe registrarse error 401');

    // Validar que el token NUNCA se filtre en texto plano en stdout de las peticiones
    const logsWithoutBanner = serverOutput.split('=' .repeat(30)).pop() || '';
    assert.ok(!logsWithoutBanner.includes(testToken), 'El token de sesión no debe fugarse en los logs de peticiones');

    // Validar que NO se filtran los argumentos/payloads de las herramientas
    assert.ok(!serverOutput.includes('super_secret_payload_content_12345'), 'Los payloads confidenciales no deben imprimirse');
    assert.ok(!serverOutput.includes('confidential_key_abc_999'), 'Las claves en argumentos no deben imprimirse');

    // Validar que el tag de la herramienta y el error se registran
    assert.match(serverOutput, /Argumento no permitido: secret_payload/, 'Debe registrarse el rechazo del argumento no permitido');
    assert.match(serverOutput, /ERROR:/, 'Debe registrarse la etiqueta ERROR en fallos de herramientas');
    assert.match(serverOutput, /<--\s+400 Bad Request/, 'Debe registrarse error 400 en JSON malformado');
    assert.match(serverOutput, /\[-32601\]\s*Herramienta local 'herramienta_fantasma' no encontrada/, 'Debe registrarse error descriptivo de herramienta no encontrada');
  } finally {
    serverProc.kill('SIGTERM');
  }
});

test('Servidor local zerochat.py: heartbeat y apagado automático por inactividad', async () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const serverPath = path.resolve(repoRoot, 'zerochat.py');
  const port = 7400 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const testToken = 'heartbeat-test-token-67890';

  // Iniciar servidor con timeout de heartbeat de 0.2 segundos para prueba ágil
  const serverProc = spawn('python3', [
    serverPath, '--port', String(port), '--no-browser', '--no-venv'
  ], {
    env: { ...process.env, ZEROCHAT_DATA_DIR: tokenDataDir(testToken), ZEROCHAT_HEARTBEAT_TIMEOUT: '0.2', ZEROCHAT_HEARTBEAT_POLL: '0.05' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let serverOutput = '';
  serverProc.stdout.on('data', chunk => { serverOutput += chunk; });

  try {
    // 1. Esperar arranque
    await waitForServer(baseUrl, testToken, serverProc);

    // 2. Rechazo de /zerochat/heartbeat sin token o con token inválido (401)
    const unauthHb = await fetch(`${baseUrl}/zerochat/heartbeat`);
    assert.equal(unauthHb.status, 401, 'Heartbeat sin token debe ser 401');

    const invalidHb = await fetch(`${baseUrl}/zerochat/heartbeat`, { headers: { 'X-ZeroChat-Token': 'token-invalido-xyz' } });
    assert.equal(invalidHb.status, 401, 'Heartbeat con token inválido debe ser 401');

    // 3. Aceptación de /zerochat/heartbeat con token válido (200 {"ok": true})
    const authHb = await fetch(`${baseUrl}/zerochat/heartbeat`, { headers: { 'X-ZeroChat-Token': testToken } });
    assert.equal(authHb.status, 200, 'Heartbeat con token válido debe ser 200');
    const hbData = await authHb.json();
    assert.equal(hbData.ok, true, 'Heartbeat debe responder {"ok": true}');

    // 4. Latido sucesivo antes de que expire el timeout (a los 100ms) mantiene vivo el servidor
    await new Promise(resolve => setTimeout(resolve, 100));
    const keepAliveHb = await fetch(`${baseUrl}/zerochat/heartbeat`, { headers: { 'X-ZeroChat-Token': testToken } });
    assert.equal(keepAliveHb.status, 200, 'Heartbeat periódico debe mantener vivo el servidor');

    // 5. Intento con token inválido a los 50ms no debe renovar el watchdog
    await new Promise(resolve => setTimeout(resolve, 50));
    const badTokenHb = await fetch(`${baseUrl}/zerochat/heartbeat`, { headers: { 'X-ZeroChat-Token': 'fake-token' } });
    assert.equal(badTokenHb.status, 401, 'Token inválido debe seguir siendo rechazado');

    // 6. Esperar a que el watchdog detecte la inactividad (>0.2s desde el último válido) y apague el servidor automáticamente
    const exitPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('El servidor no se apagó por inactividad de heartbeat')), 3000);
      serverProc.on('exit', (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });

    await exitPromise;
    assert.match(serverOutput, /Navegador desconectado \(cierre detectado\)/, 'El log debe indicar la detección de cierre');
  } finally {
    try { serverProc.kill('SIGTERM'); } catch (_) {}
  }
});

test('Servidor local zerochat.py: --no-exit-on-close desactiva el watchdog', async () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const serverPath = path.resolve(repoRoot, 'zerochat.py');
  const port = 7500 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const testToken = 'no-exit-token-99999';

  const serverProc = spawn('python3', [
    serverPath, '--port', String(port), '--no-browser', '--no-exit-on-close', '--no-venv'
  ], {
    env: { ...process.env, ZEROCHAT_DATA_DIR: tokenDataDir(testToken), ZEROCHAT_HEARTBEAT_TIMEOUT: '0.2', ZEROCHAT_HEARTBEAT_POLL: '0.05' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let serverOutput = '';
  serverProc.stdout.on('data', chunk => { serverOutput += chunk; });

  try {
    await waitForServer(baseUrl, testToken, serverProc);

    // Enviar un heartbeat
    const hbRes = await fetch(`${baseUrl}/zerochat/heartbeat`, { headers: { 'X-ZeroChat-Token': testToken } });
    assert.equal(hbRes.status, 200);

    // Esperar 400ms (> ZEROCHAT_HEARTBEAT_TIMEOUT=0.2)
    await new Promise(resolve => setTimeout(resolve, 400));

    // El servidor debe seguir activo porque --no-exit-on-close desactivó el watchdog
    const checkRes = await fetch(`${baseUrl}/`, { headers: { 'X-ZeroChat-Token': testToken } });
    assert.equal(checkRes.status, 200, 'El servidor debe seguir respondiendo con --no-exit-on-close');
    assert.match(serverOutput, /Auto-cierre\s*:\s*Desactivado/, 'El banner debe indicar auto-cierre desactivado');
  } finally {
    serverProc.kill('SIGTERM');
  }
});

test('Servidor local zerochat.py: peticiones RPC autenticadas (/mcp/external) inicializan y renuevan el watchdog sin /zerochat/heartbeat', async () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const serverPath = path.resolve(repoRoot, 'zerochat.py');
  const port = 7600 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const testToken = 'rpc-watchdog-token-12345';

  const serverProc = spawn('python3', [
    serverPath, '--port', String(port), '--no-browser', '--no-venv'
  ], {
    env: { ...process.env, ZEROCHAT_DATA_DIR: tokenDataDir(testToken), ZEROCHAT_HEARTBEAT_TIMEOUT: '0.2', ZEROCHAT_HEARTBEAT_POLL: '0.05' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let serverOutput = '';
  serverProc.stdout.on('data', chunk => { serverOutput += chunk; });

  try {
    // 1. Esperar arranque
    await waitForServer(baseUrl, testToken, serverProc);

    // 2. Enviar petición RPC a /mcp/external con token (tools/list)
    const rpcRes = await fetch(`${baseUrl}/mcp/external`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ZeroChat-Token': testToken
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    });
    assert.equal(rpcRes.status, 200, 'Llamada RPC debe devolver 200');

    // 3. Esperar a que el watchdog detecte la inactividad tras la llamada RPC (>0.2s)
    const exitPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('El servidor no se apagó por inactividad tras RPC')), 3000);
      serverProc.on('exit', (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });

    await exitPromise;
    assert.match(serverOutput, /Navegador desconectado \(cierre detectado\)/, 'El watchdog debe registrar desconexión tras actividad RPC');
  } finally {
    try { serverProc.kill('SIGTERM'); } catch (_) {}
  }
});

test('Servidor local zerochat.py: omite comprobación de versión remota en desarrollo local', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const serverPath = path.resolve(repoRoot, 'zerochat.py');

  const checkPyCode = `
import zerochat
import sys

# 1. En entorno de repo local dev_root debe estar activo
assert zerochat.get_dev_root() is not None, "get_dev_root() debe detectar el repositorio local"

# 2. check_version() no debe imprimir nada en modo dev
import io
out = io.StringIO()
old_stdout = sys.stdout
sys.stdout = out
try:
    zerochat.check_version()
finally:
    sys.stdout = old_stdout

output = out.getvalue()
assert "Nueva versión disponible" not in output, f"No debe comprobar versión en dev: {output}"
assert "_read_package_version" not in output, f"No debe mostrar texto de función interna: {output}"

# 3. parse_version compara semver adecuadamente
assert zerochat.parse_version("7.0.5") == (7, 0, 5)
assert zerochat.parse_version("7.0.10") > zerochat.parse_version("7.0.5")
assert not (zerochat.parse_version("7.0.5") > zerochat.parse_version("7.0.5"))

# 4. Solo major.minor requiere actualizar el ejecutable.
assert not zerochat.has_new_backend_version("7.4.9", "7.4")
assert zerochat.has_new_backend_version("7.5.0", "7.4")
assert zerochat.get_venv_dir() == zerochat.get_data_dir() / ".venv"

# 5. Los avisos son transitorios, validan su contenido y no se eliminan al mostrarlos.
zerochat.reset_notices()
assert zerochat.get_notices() == ()
zerochat.add_notice("Aviso de prueba")
assert zerochat.get_notices() == ("Aviso de prueba",)
try:
    zerochat.add_notice("  ")
    raise AssertionError("Los avisos vacíos deben rechazarse")
except ValueError:
    pass

# La comprobación consulta GitHub Pages para la interfaz y GitHub para el ejecutable.
from unittest.mock import patch
newer_version = f"{int(zerochat.VERSION.split('.')[0]) + 1}.0.0"
with patch.object(zerochat, "get_dev_root", return_value=None), \
     patch.object(zerochat, "is_installed_runtime", return_value=True), \
     patch.object(zerochat, "_read_remote_ui_version", return_value="99.1.2"), \
     patch.object(zerochat, "_read_remote_backend_version", return_value=newer_version):
    zerochat.check_version()
assert len(zerochat.get_notices()) == 3
assert "Interfaz web en GitHub Pages: v99.1.2" in zerochat.get_notices()[-2]
assert "Nueva versión del servidor disponible" in zerochat.get_notices()[-1]
assert "-m pip install --upgrade" in zerochat.get_notices()[-1]

with patch.object(zerochat, "_read_remote_content", return_value="<title>ZeroChat v8.2.2</title>"):
    assert zerochat._read_remote_ui_version() == "8.2.2"
with patch.object(zerochat, "_read_remote_content", return_value='SOURCE_BACKEND_VERSION = "8.2.0"'):
    assert zerochat._read_remote_backend_version() == "8.2.0"

# 6. El entorno MCP no cambia el intérprete del servidor.
import os
import tempfile
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
with tempfile.TemporaryDirectory() as temp_dir:
    old_data_dir = os.environ.get("ZEROCHAT_DATA_DIR")
    os.environ["ZEROCHAT_DATA_DIR"] = temp_dir
    try:
        current_python = sys.executable
        zerochat.ensure_virtual_environment()
        assert sys.executable == current_python
        assert zerochat.get_venv_python(zerochat.get_venv_dir()).is_file()
    finally:
        if old_data_dir is None:
            os.environ.pop("ZEROCHAT_DATA_DIR", None)
        else:
            os.environ["ZEROCHAT_DATA_DIR"] = old_data_dir

# 7. La validación MCP acepta una versión de Node que cumple el mínimo configurado.
with tempfile.TemporaryDirectory() as temp_dir:
    service_dir = Path(temp_dir)
    (service_dir / "installer.json").write_text(json.dumps({
        "type": "npm",
        "product": {"package": "example-mcp", "version": "1.0.0"},
        "requirements": {"node": {"minimumMajor": 24}}
    }), encoding="utf-8")
    (service_dir / "node_modules" / "example-mcp").mkdir(parents=True)
    (service_dir / ".installed.json").write_text(json.dumps({
        "package": "example-mcp", "version": "1.0.0"
    }), encoding="utf-8")
    with patch.object(zerochat.shutil, "which", side_effect=lambda command: f"/usr/bin/{command}"), \
         patch.object(zerochat.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout="v24.18.1\\n")):
        zerochat.McpServiceManager()._prepare_service("example", {"_directory": service_dir})
`;

  execFileSync('python3', ['-c', checkPyCode], { cwd: repoRoot });
});

test('zerochat.py: avisa al escuchar en un host que no es de bucle local', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const checkPyCode = `
import zerochat

for host in ("127.0.0.1", "127.0.0.2", "localhost", "LOCALHOST", "::1", "[::1]"):
    assert zerochat.is_loopback_host(host), host
    assert zerochat.remote_exposure_warning(host) is None, host

for host in ("0.0.0.0", "::", "192.168.1.10", "mi-equipo.local", ""):
    assert not zerochat.is_loopback_host(host), host
    warning = zerochat.remote_exposure_warning(host)
    assert warning and "ejecutar comandos" in warning and "sin cifrar" in warning, host
`;

  execFileSync('python3', ['-c', checkPyCode], { cwd: repoRoot });
});

test('zerochat.py se reconstruye de forma idéntica desde sus módulos en py/ mediante sort | cat', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const pyDir = path.join(repoRoot, 'py');
  assert.ok(fs.existsSync(pyDir), 'El directorio py/ debe existir');

  const files = fs.readdirSync(pyDir).filter(f => f.endsWith('.py')).sort();
  assert.ok(files.length > 1, 'Debe haber múltiples módulos divididos en py/');
  assert.equal(files[files.length - 1], 'zz-main.py', 'El último módulo ordenado alfabéticamente debe ser zz-main.py');

  const concatenated = files.map(f => fs.readFileSync(path.join(pyDir, f), 'utf8')).join('');
  const currentZerochat = fs.readFileSync(path.join(repoRoot, 'zerochat.py'), 'utf8');

  assert.equal(currentZerochat, concatenated, 'zerochat.py debe coincidir exactamente con la concatenación ordenada de py/*.py (ejecuta npm run build:backend)');
});

test('zerochat.py: la instalación termina en starting antes del handshake OAuth y conserva errores reales', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const script = `
import importlib.util
import json
import os
import tempfile
from pathlib import Path
from unittest.mock import Mock, patch

with tempfile.TemporaryDirectory() as temp_dir:
    os.environ["ZEROCHAT_DATA_DIR"] = temp_dir
    spec = importlib.util.spec_from_file_location("zerochat_mcp_start_state_test", Path(${JSON.stringify(path.join(repoRoot, 'zerochat.py'))}))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    root = Path(temp_dir) / "services"
    custom = root / "oauth-fixture"
    custom.mkdir()
    (custom / "service.json").write_text(json.dumps({
        "id": "oauth-fixture", "launch": {"args": [], "handshakeTimeoutSeconds": 150}
    }))
    manager = module.McpServiceManager(root)
    def status():
        return next(item for item in manager.list_servers() if item["id"] == "oauth-fixture")
    def prepare(server_id, server):
        assert status()["status"] == "starting"
        assert status()["error"] is None
        manager.states[server_id] = "installing"
        assert status()["status"] == "installing"
        return {}
    for fail in [True, False]:
        manager.errors["oauth-fixture"] = "Previous failure"
        client = Mock(tools=[])
        def handshake(timeout):
            assert timeout == 150
            assert status()["status"] == "starting"
            assert status()["error"] is None
            if fail:
                raise RuntimeError("OAuth failed")
        client.start.side_effect = handshake
        with patch.object(manager, "_prepare_service", side_effect=prepare), patch.object(module, "StdioMcpClient", return_value=client):
            manager.start("oauth-fixture")
        assert status()["status"] == ("error" if fail else "running")
        assert status()["error"] == ("OAuth failed" if fail else None)
        assert client.stop.call_count == (1 if fail else 0)
    manager.close()
`;
  assert.doesNotThrow(() => execFileSync('python3', ['-c', script], { cwd: repoRoot, stdio: 'pipe' }));
});

test('Servidor local zerochat.py: los métodos de control MCP responden con error JSON-RPC ante entradas inválidas', async () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const serverPath = path.resolve(repoRoot, 'zerochat.py');
  const testToken = 'control-errors-token-12345';
  const dataDir = tokenDataDir(testToken);
  const port = 7600 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;

  const serverProc = spawn('python3', [
    serverPath, '--port', String(port), '--no-browser', '--no-venv', '--no-exit-on-close'
  ], {
    env: { ...process.env, ZEROCHAT_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const rpc = async (method, params) => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${testToken}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    });
    assert.equal(res.status, 200, method);
    return res.json();
  };

  try {
    await waitForServer(baseUrl, testToken, serverProc);
    for (const action of ['start', 'stop', 'configure']) {
      const method = `zerochat/external/servers/${action}`;
      const unknown = await rpc(method, { serverId: 'no-existe', options: {} });
      assert.equal(unknown.error?.code, -32602, `${method} con servidor desconocido`);
      assert.match(unknown.error?.message, /no-existe/);
      const invalidId = await rpc(method, { serverId: 42 });
      assert.equal(invalidId.error?.code, -32602, `${method} con serverId no textual`);
    }
    const invalidOptions = await rpc('zerochat/external/servers/configure', { serverId: 'ejemplo', options: 'x' });
    assert.equal(invalidOptions.error?.code, -32602);
    const status = await rpc('zerochat/external/status', {});
    assert.equal(status.result.servers.some(server => server.id === 'no-existe'), false);
  } finally {
    try { serverProc.kill('SIGTERM'); } catch (_) {}
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('zerochat.py: una llamada a herramienta MCP externa no bloquea al gestor mientras se ejecuta', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const script = `
import importlib.util
import os
import tempfile
from pathlib import Path
from unittest.mock import Mock

with tempfile.TemporaryDirectory() as temp_dir:
    os.environ["ZEROCHAT_DATA_DIR"] = temp_dir
    spec = importlib.util.spec_from_file_location("zerochat_mcp_call_lock_test", Path(${JSON.stringify(path.join(repoRoot, 'zerochat.py'))}))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    manager = module.McpServiceManager(Path(temp_dir) / "services")
    client = Mock(tools=[{"name": "lookup"}])
    client.running.return_value = True
    def request(method, params):
        assert not manager._lock.locked(), "El lock del gestor no debe mantenerse durante la llamada"
        assert method == "tools/call" and params == {"name": "lookup", "arguments": {"q": 1}}
        return {"content": []}
    client.request.side_effect = request
    manager.clients["demo"] = client
    assert manager.call(module.public_tool_name("demo", "lookup"), {"q": 1}) == {"content": []}
    try:
        manager.call("demo_missing", {})
        raise AssertionError("Debe rechazar herramientas inexistentes")
    except ValueError:
        pass
`;
  assert.doesNotThrow(() => execFileSync('python3', ['-c', script], { cwd: repoRoot, stdio: 'pipe' }));
});
