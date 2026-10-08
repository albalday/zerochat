const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const pkg = require('../../package.json');

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
  // Python 3.14 colorea la ayuda de argparse si FORCE_COLOR está definido; el test compara texto plano.
  const env = { ...process.env, NO_COLOR: '1' };
  delete env.FORCE_COLOR;
  assert.doesNotThrow(() => execFileSync('python3', ['-c', script], { cwd: repoRoot, env, stdio: 'pipe' }));
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
        # El bootstrap de pip pertenece a la biblioteca estándar y multiplica la duración del test.
        real_create = zerochat.venv.create
        with patch.object(zerochat.venv, "create", side_effect=lambda env_dir, **kw: real_create(env_dir, **{**kw, "with_pip": False})):
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

test('zerochat.py: execute_command termina los descendientes al agotar el plazo y acota la salida', { skip: process.platform === 'win32' }, () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const script = `
import importlib.util
import json
import os
import tempfile
import time
from pathlib import Path

def wait_dead(pid):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return
        time.sleep(0.05)
    raise AssertionError(f"El proceso {pid} sigue vivo tras agotar el plazo")

with tempfile.TemporaryDirectory() as temp_dir:
    os.environ["ZEROCHAT_DATA_DIR"] = temp_dir
    spec = importlib.util.spec_from_file_location("zerochat_execute_command_limits_test", Path(${JSON.stringify(path.join(repoRoot, 'zerochat.py'))}))
    zerochat = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(zerochat)
    work_dir = Path(temp_dir) / "work"
    work_dir.mkdir()

    # Con cwd explícito (subproceso propio) y por la sesión persistente.
    for label, cwd in (("cwd", str(work_dir)), ("session", ".")):
        pid_file = Path(temp_dir) / f"{label}.pid"
        command = f"sh -c 'echo $$ > {pid_file}; exec sleep 100' & sleep 100"
        started = time.monotonic()
        result = json.loads(zerochat.execute_command(command, cwd=cwd, timeout_seconds=1))
        assert result["success"] is False and "timed out" in result["error"], result
        assert time.monotonic() - started < 5, label
        wait_dead(int(pid_file.read_text().strip()))

    for cwd in (str(work_dir), "."):
        result = json.loads(zerochat.execute_command("python3 -c \\"print('x' * 5000000)\\"", cwd=cwd, timeout_seconds=30))
        assert result["success"] is True, result
        assert result["truncated"] is True
        assert len(result["stdout"]) < 20000
`;
  assert.doesNotThrow(() => execFileSync('python3', ['-c', script], { cwd: repoRoot, stdio: 'pipe' }));
});
