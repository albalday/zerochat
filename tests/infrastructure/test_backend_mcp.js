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
        manager.start("custom-key", remember=True)
        env = constructor.call_args.args[3]
        assert env["SERVICE_API_KEY"] == "fixture-key"
        assert env["HOME"] == str(custom)
        assert "PATH" in env
        assert os.environ["SERVICE_API_KEY"] == "inherited-fixture"
        client.start.assert_called_once()
    assert "fixture-key" not in "".join(traces)
    assert next(item for item in manager.list_servers() if item["id"] == "custom-key")["status"] == "running"
    manager.close()
    # Solo un arranque recordado se guarda como activo para la siguiente sesión.
    preferences = Path(temp_dir) / "config" / "services.json"
    with patch.object(module, "StdioMcpClient", return_value=client):
        assert json.loads(preferences.read_text())["custom-key"]["enabled"] is True
        preferences.unlink()
        manager = module.McpServiceManager(root)
        manager.start("custom-key", remember=False)
        assert not preferences.exists()
        assert next(item for item in manager.list_servers() if item["id"] == "custom-key")["enabled"] is False
    manager.close()
`;
  assert.doesNotThrow(() => execFileSync('python3', ['-c', script], { cwd: repoRoot, stdio: 'pipe' }));
});

test('zerochat.py: Playwright MCP arranca con el navegador de la configuración del navegador', () => {
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
    spec = importlib.util.spec_from_file_location("zerochat_browser_config_test", Path(${JSON.stringify(path.join(repoRoot, 'zerochat.py'))}))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.console_log = lambda message, **kwargs: None
    manager = module.McpServiceManager()
    config_file = Path(temp_dir) / "config" / "browser.json"
    client = Mock(tools=[])
    client.running.return_value = True

    launched_env = {}

    def launch_args(config, browser=None):
        if config is None:
            config_file.unlink(missing_ok=True)
        else:
            config_file.write_text(config if isinstance(config, str) else json.dumps(config), encoding="utf-8")
        with patch.object(manager, "_prepare_service", return_value={"serviceDir": "/svc", "nodeExecutable": "node", "pythonExecutable": "python"}), \\
             patch.object(module, "StdioMcpClient", return_value=client) as constructor:
            manager.start("playwright", remember=False, browser=browser)
            manager.close()
            launched_env.clear()
            launched_env.update(constructor.call_args.args[3])
            return constructor.call_args.args[1][1:]

    own = Path(temp_dir) / "playwright" / "profile"
    default_args = ["--browser=chromium", f"--user-data-dir={own / 'chromium'}", "--headless"]
    # Sin fichero, o con uno no válido, se usan los valores por defecto: navegador propio sin ventana.
    assert launch_args(None) == default_args
    for directory in (own.parent, own, own / "chromium"):
        assert directory.stat().st_mode & 0o777 == 0o700, directory
    assert launch_args("{roto") == default_args
    assert launch_args({"mode": "own", "engine": "opera"}) == default_args
    assert launch_args({"mode": "own", "engine": "firefox", "headless": False}) == ["--browser=firefox", f"--user-data-dir={own / 'firefox'}"]
    # Con el navegador del usuario manda la extensión y siempre hay ventana.
    assert launch_args({"mode": "user", "userBrowser": "msedge", "headless": True}) == ["--extension", "--browser=msedge"]
    # Chromium no es un canal: su ejecutable y su perfil, con el canal chrome; sin Chromium no arranca.
    with patch.object(module, "chromium_install", return_value=("/usr/bin/chromium", Path("/home/u/.config/chromium"))):
        assert launch_args({"mode": "user", "userBrowser": "chromium"}) == [
            "--extension", "--browser=chrome", "--executable-path=/usr/bin/chromium", "--user-data-dir=/home/u/.config/chromium"]
    with patch.object(module, "chromium_install", return_value=None):
        try:
            module.playwright_launch_args({**module.BROWSER_CONFIG_DEFAULTS, "mode": "user", "userBrowser": "chromium"})
        except RuntimeError as err:
            assert "Chromium" in str(err)
        else:
            raise AssertionError("arrancó sin Chromium")

    # El navegador que exige el perfil sustituye solo al modo y al navegador de Ajustes, en ese arranque.
    settings = {"mode": "own", "engine": "firefox", "headless": False, "extensionToken": "abc"}
    assert launch_args(settings, {"mode": "user", "userBrowser": "msedge"}) == ["--extension", "--browser=msedge"]
    assert launched_env["PLAYWRIGHT_MCP_EXTENSION_TOKEN"] == "abc"
    assert manager.browsers["playwright"] == {"mode": "user", "userBrowser": "msedge"}
    assert launch_args({**settings, "mode": "user"}, {"mode": "own", "engine": "webkit"}) == ["--browser=webkit", f"--user-data-dir={own / 'webkit'}"]
    assert launch_args(settings) == ["--browser=firefox", f"--user-data-dir={own / 'firefox'}"]
    assert manager.browsers["playwright"] == {"mode": "own", "engine": "firefox"}
    for invalid in [None, [], {"mode": "own"}, {"mode": "own", "engine": "opera"}, {"mode": "user", "userBrowser": "firefox"},
                    {"mode": "own", "engine": "chromium", "headless": False}, {"mode": "user", "engine": "chromium"}]:
        try:
            module.validate_profile_browser(invalid)
        except ValueError as err:
            assert "browser debe ser" in str(err)
        else:
            raise AssertionError(f"navegador de perfil aceptado: {invalid}")

    # La extensión cuenta como instalada si algún perfil del navegador la tiene en su carpeta Extensions.
    profiles = Path(temp_dir) / "user-browsers"
    (profiles / "chrome" / "Profile 2" / "Extensions" / module.PLAYWRIGHT_EXTENSION_ID / "1.0_0").mkdir(parents=True)
    (profiles / "msedge" / "Default" / "Extensions" / "otra").mkdir(parents=True)
    data_dirs = {"chrome": profiles / "chrome", "msedge": profiles / "msedge", "chromium": None}
    with patch.object(module, "user_browser_data_dir", side_effect=data_dirs.get):
        assert module.user_browser_extensions() == {"chrome": True, "msedge": False, "chromium": False}

    # El token de la extensión va en el entorno, nunca en los argumentos, y solo con el navegador del usuario.
    token = "abc_DEF-123"
    assert launch_args({"mode": "user", "userBrowser": "chrome", "extensionToken": token}) == ["--extension", "--browser=chrome"]
    assert launched_env["PLAYWRIGHT_MCP_EXTENSION_TOKEN"] == token
    launch_args({"mode": "own", "extensionToken": token})
    assert "PLAYWRIGHT_MCP_EXTENSION_TOKEN" not in launched_env

    # Lo guardado se valida, solo lo lee el usuario y es lo que usa el siguiente arranque.
    saved = module.save_browser_config({"engine": "webkit", "headless": False})
    assert saved == {"mode": "own", "engine": "webkit", "userBrowser": "chrome", "headless": False, "extensionToken": ""}
    assert config_file.stat().st_mode & 0o777 == 0o600
    assert module.validate_browser_config({"extensionToken": "a" * 256})["extensionToken"] == "a" * 256
    assert launch_args(saved) == ["--browser=webkit", f"--user-data-dir={own / 'webkit'}"]

    # Borrar los datos quita solo el perfil de ese motor y exige Playwright MCP detenido.
    (own / "chromium" / "Cookies").write_text("x")
    with patch.object(module.GLOBAL_MCP_MANAGER, "list_servers", return_value=[{"id": "playwright", "status": "starting"}]):
        try:
            module.clear_own_browser_data("chromium")
        except ValueError as err:
            assert "Detén Playwright MCP" in str(err)
        else:
            raise AssertionError("se borraron los datos de un navegador abierto")
    assert module.clear_own_browser_data("chromium") == {"cleared": "chromium"}
    assert sorted(path.name for path in own.iterdir()) == ["firefox", "webkit"]

    for raw, message in [
        ([], "objeto"),
        ({"mode": "own", "extra": 1}, "extra"),
        ({"mode": "remote"}, "mode"),
        ({"userBrowser": "firefox"}, "userBrowser"),
        ({"headless": "no"}, "headless"),
        ({"extensionToken": "a b"}, "extensionToken"),
        ({"extensionToken": "a" * 257}, "extensionToken"),
    ]:
        try:
            module.save_browser_config(raw)
        except ValueError as err:
            assert message in str(err), (raw, err)
        else:
            raise AssertionError(raw)
    assert module.load_browser_config() == saved, "un valor rechazado no cambia lo guardado"
`;
  assert.doesNotThrow(() => execFileSync('python3', ['-c', script], { cwd: repoRoot, stdio: 'pipe' }));
});

test('zerochat.py: los motores de Playwright se listan, instalan con progreso y quitan en su caché', { skip: process.platform === 'win32' }, () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const script = `
import importlib.util
import json
import os
import tempfile
import time
from pathlib import Path
from unittest.mock import patch

with tempfile.TemporaryDirectory() as temp_dir:
    os.environ["ZEROCHAT_DATA_DIR"] = temp_dir
    cache = Path(temp_dir) / "cache"
    cli = Path(temp_dir) / "services" / "playwright" / "node_modules" / "playwright" / "cli.js"
    cli.parent.mkdir(parents=True)
    (cli.parent / "package.json").write_text('{"version": "1.2.3"}', encoding="utf-8")
    # CLI simulado: --dry-run da las rutas de esta versión; install escribe el progreso como sin
    # terminal, espera a que exista "go" y falla con webkit.
    cli.write_text('''
const fs = require("fs"), path = require("path");
const cache = ${JSON.stringify('CACHE')};
const titles = {"chromium": "Chrome for Testing 1", "chromium-headless-shell": "Chrome Headless Shell 1", "firefox": "Firefox 2", "webkit": "WebKit 3"};
const dir = name => path.join(cache, name.replace(/-/g, "_") + "-1");
const args = process.argv.slice(2);
if (args.includes("--dry-run")) {
  for (const name of args.slice(2)) console.log(titles[name] + " (playwright " + name + " v1)\\\\n  Install location:    " + dir(name) + "\\\\n");
  process.exit(0);
}
const engine = args[1];
if (engine === "webkit") { console.error("Host system is missing dependencies"); process.exit(1); }
const names = engine === "chromium" ? ["chromium", "chromium-headless-shell"] : [engine];
console.log("Downloading " + titles[names[0]] + " (playwright " + names[0] + " v1) from https://example.invalid");
console.log("|■■■■■■■■■■■■■■■■■■■■■■■■                                                        |  30% of 10 MiB");
const wait = () => {
  if (!fs.existsSync(path.join(cache, "go"))) return setTimeout(wait, 20);
  for (const name of names) { fs.mkdirSync(dir(name), {recursive: true}); fs.writeFileSync(path.join(dir(name), "INSTALLATION_COMPLETE"), ""); }
};
wait();
'''.replace("CACHE", str(cache)), encoding="utf-8")
    cache.mkdir()
    (cache / "ffmpeg-1").mkdir()
    spec = importlib.util.spec_from_file_location("zerochat_engines_test", Path(${JSON.stringify(path.join(repoRoot, 'zerochat.py'))}))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.console_log = lambda message, **kwargs: None
    engines = module.BrowserEngines()

    def engine(listing, engine_id):
        return next(item for item in listing["engines"] if item["id"] == engine_id)

    def settled(engine_id):
        for _ in range(250):
            item = engine(engines.list(), engine_id)
            if item.get("status") != "installing":
                return item
            time.sleep(0.02)
        raise AssertionError("la instalación no terminó")

    listing = engines.list()
    assert listing["available"] and listing["playwrightVersion"] == "1.2.3"
    assert [(item["id"], item["title"], item["installed"]) for item in listing["engines"]] == [
        ("chromium", "Chrome for Testing 1", False), ("firefox", "Firefox 2", False), ("webkit", "WebKit 3", False)]

    engines.install("chromium")
    for _ in range(250):
        progress = engine(engines.list(), "chromium")
        if progress.get("percent"):
            break
        time.sleep(0.02)
    assert progress == {"id": "chromium", "title": "Chrome for Testing 1", "installed": False,
                        "status": "installing", "download": "Chrome for Testing 1", "percent": 30}, progress
    for call in (lambda: engines.install("chromium"), lambda: engines.install("opera")):
        try:
            call()
        except ValueError:
            pass
        else:
            raise AssertionError("se aceptó una instalación repetida o un motor desconocido")
    (cache / "go").write_text("")
    assert settled("chromium") == {"id": "chromium", "title": "Chrome for Testing 1", "installed": True}
    engines.install("webkit")
    failed = settled("webkit")
    assert failed["status"] == "error" and "missing dependencies" in failed["error"] and not failed["installed"], failed

    # Quitar un motor exige Playwright MCP detenido y conserva ffmpeg, común a todos.
    with patch.object(module.GLOBAL_MCP_MANAGER, "list_servers", return_value=[{"id": "playwright", "status": "running"}]):
        try:
            engines.remove("chromium")
        except ValueError as err:
            assert "Detén Playwright MCP" in str(err)
        else:
            raise AssertionError("se quitó un motor en uso")
    # Al quitar el motor elegido, la configuración pasa a otro instalado.
    engines.install("firefox")
    assert settled("firefox")["installed"]
    assert engine(engines.remove("chromium"), "chromium")["installed"] is False
    assert sorted(path.name for path in cache.iterdir()) == ["ffmpeg-1", "firefox-1", "go"]
    assert module.load_browser_config()["engine"] == "firefox"
    engines.remove("firefox")
    assert module.load_browser_config()["engine"] == "firefox", "sin otro instalado se conserva"

    cli.unlink()
    assert engines.list() == {"systemBrowsers": module.system_browsers(), "extensions": module.user_browser_extensions(), "engines": [], "available": False,
                              "error": "Playwright MCP is not installed."}
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
    assert next(item for item in manager.start("healthy", remember=True) if item["id"] == "healthy")["status"] == "running"
    assert next(item for item in manager.start("broken", remember=True) if item["id"] == "broken")["status"] == "error"
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
            manager.start("oauth-fixture", remember=True)
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

test('zerochat.py: el cliente MCP stdio acota los mensajes, aplica el plazo del servicio, informa de su caída y termina sus descendientes', { skip: process.platform === 'win32' }, () => {
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
        assert next(item for item in manager.start("limits", remember=True) if item["id"] == "limits")["status"] == "running"
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
        # Si el proceso del servicio muere, deja de figurar en marcha y stop() limpia sus descendientes.
        client.process.kill()
        client.process.wait(timeout=5)
        crashed = next(item for item in manager.list_servers() if item["id"] == "limits")
        assert (crashed["status"], crashed["toolCount"]) == ("error", 0), crashed
        assert crashed["error"].startswith("MCP process exited with code"), crashed
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
