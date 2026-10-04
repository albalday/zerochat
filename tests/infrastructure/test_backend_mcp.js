const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

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
    client.call_timeout = 30
    def request(method, params, timeout):
        assert not manager._lock.locked(), "El lock del gestor no debe mantenerse durante la llamada"
        assert timeout == client.call_timeout
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

test('zerochat.py: detener un MCP en Windows elimina su árbol de procesos sin usar señales POSIX', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const script = `
import importlib.util
import os
import signal
import subprocess
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

with tempfile.TemporaryDirectory() as temp_dir:
    os.environ["ZEROCHAT_DATA_DIR"] = temp_dir
    spec = importlib.util.spec_from_file_location("zerochat_mcp_windows_stop_test", Path(${JSON.stringify(path.join(repoRoot, 'zerochat.py'))}))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.DETECTED_OS = "windows"
    client = module.StdioMcpClient(sys.executable, [], temp_dir, dict(os.environ))
    client.process = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(100)"])
    process = client.process
    calls = []
    real_run = subprocess.run
    def fake_run(cmd, *args, **kwargs):
        if cmd[0] == "taskkill":
            calls.append(cmd)
            os.kill(int(cmd[2]), signal.SIGTERM)
            return subprocess.CompletedProcess(cmd, 0)
        return real_run(cmd, *args, **kwargs)
    sigkill = signal.SIGKILL
    del signal.SIGKILL
    try:
        with patch.object(module.subprocess, "run", side_effect=fake_run):
            client.stop()
    finally:
        signal.SIGKILL = sigkill
    assert calls == [["taskkill", "/PID", str(process.pid), "/T", "/F"]], calls
    assert process.poll() is not None
    assert client.process is None and client.tools == []
`;
  assert.doesNotThrow(() => execFileSync('python3', ['-c', script], { cwd: repoRoot, stdio: 'pipe' }));
});

const LIMITS_MCP_FIXTURE = `import json, subprocess, sys, time
child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(100)"])
with open(sys.argv[1], "w") as pid_file:
    pid_file.write(str(child.pid))

def send(payload):
    sys.stdout.write(payload + "\\n")
    sys.stdout.flush()

for line in sys.stdin:
    request = json.loads(line)
    method, req_id = request.get("method"), request.get("id")
    if method == "initialize":
        result = {"protocolVersion": "2024-11-05", "capabilities": {}, "serverInfo": {"name": "limits", "version": "1"}}
    elif method == "tools/list":
        result = {"tools": [{"name": "big_head"}, {"name": "big_tail"}, {"name": "slow"}, {"name": "echo"}]}
    elif method == "tools/call":
        name = request["params"]["name"]
        content = {"content": [{"type": "text", "text": "x" * (5 * 1024 * 1024)}]}
        if name == "big_head":
            send(json.dumps({"jsonrpc": "2.0", "id": req_id, "result": content}))
            continue
        if name == "big_tail":
            send(json.dumps({"result": content, "jsonrpc": "2.0", "id": req_id}))
            continue
        if name == "slow":
            time.sleep(3)
        result = {"content": [{"type": "text", "text": "ok"}]}
    else:
        continue
    send(json.dumps({"jsonrpc": "2.0", "id": req_id, "result": result}))
`;

test('zerochat.py: el cliente MCP stdio acota los mensajes, aplica el plazo del servicio y termina sus descendientes', { skip: process.platform === 'win32' }, () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zerochat-mcp-limits-'));
  const fixturePath = path.join(fixtureDir, 'server.py');
  fs.writeFileSync(fixturePath, LIMITS_MCP_FIXTURE);
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
    spec = importlib.util.spec_from_file_location("zerochat_mcp_stdio_limits_test", Path(${JSON.stringify(path.join(repoRoot, 'zerochat.py'))}))
    zerochat = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(zerochat)
    root = Path(temp_dir) / "services"
    service_dir = root / "limits"
    service_dir.mkdir(parents=True)
    child_pid_file = Path(temp_dir) / "child.pid"
    (service_dir / "service.json").write_text(json.dumps({
        "id": "limits",
        "launch": {
            "executable": sys.executable,
            "args": [${JSON.stringify(fixturePath)}, str(child_pid_file)],
            "cwd": str(service_dir),
            "env": {},
            "handshakeTimeoutSeconds": 5,
            "callTimeoutSeconds": 0.5
        }
    }), encoding="utf-8")

    zerochat.StdioMcpClient.max_message_chars = 1024 * 1024
    manager = zerochat.McpServiceManager(root)
    try:
        assert next(item for item in manager.start("limits") if item["id"] == "limits")["status"] == "running"
        client = manager.clients["limits"]
        assert client.call_timeout == 0.5

        original_write = client._write
        def write_without_lock(payload):
            assert not client._lock.locked(), "No se debe escribir en stdin con el cerrojo de peticiones tomado"
            original_write(payload)
        client._write = write_without_lock

        # Respuestas de 5 MB con el id al principio (SDK Python) o al final (SDK Node).
        for tool in ("big_head", "big_tail"):
            try:
                manager.call(zerochat.public_tool_name("limits", tool), {})
                raise AssertionError("Una respuesta demasiado grande debe fallar")
            except RuntimeError as exc:
                assert "exceeds" in str(exc), exc
        # El flujo sigue sincronizado tras descartar los mensajes grandes.
        assert manager.call(zerochat.public_tool_name("limits", "echo"), {})["content"][0]["text"] == "ok"

        started = time.monotonic()
        try:
            manager.call(zerochat.public_tool_name("limits", "slow"), {})
            raise AssertionError("La llamada lenta debe agotar el plazo del servicio")
        except TimeoutError:
            pass
        assert time.monotonic() - started < 2

        child_pid = int(child_pid_file.read_text())
        os.kill(child_pid, 0)
        manager.stop("limits")
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                os.kill(child_pid, 0)
            except ProcessLookupError:
                break
            time.sleep(0.05)
        else:
            raise AssertionError("stop() debe terminar los procesos hijos del MCP")
    finally:
        manager.close()
`;
  try {
    assert.doesNotThrow(() => execFileSync('python3', ['-c', script], { cwd: repoRoot, stdio: 'pipe' }));
  } finally {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('zerochat.py: el gestor MCP descarta y registra nombres públicos inválidos o duplicados', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const script = `
import importlib.util
import os
import tempfile
from pathlib import Path
from unittest.mock import Mock

with tempfile.TemporaryDirectory() as temp_dir:
    os.environ["ZEROCHAT_DATA_DIR"] = temp_dir
    spec = importlib.util.spec_from_file_location("zerochat_mcp_duplicate_names_test", Path(${JSON.stringify(path.join(repoRoot, 'zerochat.py'))}))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    traces = []
    module.console_log = lambda message, **_kwargs: traces.append(message)
    manager = module.McpServiceManager(Path(temp_dir) / "services")
    client = Mock(tools=[{"name": "lookup"}, {"name": "lookup"}, {"name": "x" * 80}, {"name": ""}])
    client.running.return_value = True
    manager.clients["demo"] = client
    names = [tool["name"] for tool in manager.tools()]
    assert names == ["demo_lookup"], names
    joined = "\\n".join(traces)
    assert "duplicate public name demo_lookup" in joined, joined
    assert joined.count("tool discarded") == 3, joined
`;
  assert.doesNotThrow(() => execFileSync('python3', ['-c', script], { cwd: repoRoot, stdio: 'pipe' }));
});
