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

test('zerochat.py: run_command abre una shell nueva en el proyecto y une stdout y stderr en orden', { skip: process.platform === 'win32' }, () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const script = `
import importlib.util
import json
import os
import tempfile
from pathlib import Path

with tempfile.TemporaryDirectory() as temp_dir:
    os.environ["ZEROCHAT_DATA_DIR"] = temp_dir
    spec = importlib.util.spec_from_file_location("zerochat_run_command_test", Path(${JSON.stringify(path.join(repoRoot, 'zerochat.py'))}))
    zerochat = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(zerochat)
    start = Path.cwd()
    project = (Path(temp_dir) / "project").resolve()
    (project / "src").mkdir(parents=True)
    os.chdir(project)

    result = json.loads(zerochat.run_command("echo uno; echo dos >&2; echo tres; exit 3"))
    assert result["success"] is False and result["status"] == "exited" and result["exit_code"] == 3, result
    assert result["output"] == "uno\\ndos\\ntres\\n", result
    assert isinstance(result["job_id"], int) and "cwd" not in result

    # Nada pasa de una llamada a la siguiente: ni el directorio ni las variables.
    assert json.loads(zerochat.run_command("cd src && export ZC_TEST_VAR=1 && pwd"))["output"].strip() == str(project / "src")
    after = json.loads(zerochat.run_command('pwd; echo "var=$ZC_TEST_VAR"'))
    assert after["output"] == f"{project}\\nvar=\\n", after

    for bad in ("", "   "):
        assert json.loads(zerochat.run_command(bad))["success"] is False
    os.chdir(start)
`;
  assert.doesNotThrow(() => execFileSync('python3', ['-c', script], { cwd: repoRoot, stdio: 'pipe' }));
});

test('zerochat.py: set_project_directory mueve el proceso y los comandos, y cd no cambia el proyecto', { skip: process.platform === 'win32' }, () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const script = `
import importlib.util
import os
import tempfile
from pathlib import Path

with tempfile.TemporaryDirectory() as temp_dir:
    os.environ["ZEROCHAT_DATA_DIR"] = temp_dir
    spec = importlib.util.spec_from_file_location("zerochat_project_dir_test", Path(${JSON.stringify(path.join(repoRoot, 'zerochat.py'))}))
    zerochat = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(zerochat)
    import json
    dev_root = zerochat.get_dev_root()
    start = Path.cwd().resolve()
    project = (Path(temp_dir) / "project").resolve()
    (project / "src").mkdir(parents=True)
    (project / "note.txt").write_text("hola", encoding="utf-8")

    for bad in ("", "   ", None, 7, "x" * 5000, str(project / "missing"), str(project / "note.txt")):
        try:
            zerochat.set_project_directory(bad)
        except ValueError:
            pass
        else:
            raise AssertionError(f"debe rechazar {bad!r}")
        assert Path.cwd().resolve() == start

    result = zerochat.set_project_directory(str(project))
    assert result == {"cwd": str(project), "previous_cwd": str(start)}
    assert Path.cwd().resolve() == project
    assert json.loads(zerochat.read_file("note.txt"))["content"].startswith("hola")
    assert json.loads(zerochat.run_command("pwd"))["output"].strip() == str(project)

    # cd solo vale dentro del comando: el proyecto (y las rutas relativas) siguen en la raíz.
    assert json.loads(zerochat.run_command("cd src && pwd"))["output"].strip() == str(project / "src")
    assert Path.cwd().resolve() == project
    assert json.loads(zerochat.read_file("note.txt"))["success"] is True

    # Una ruta relativa se resuelve contra el proyecto actual y los comandos arrancan en la nueva raíz.
    assert zerochat.set_project_directory("src")["cwd"] == str(project / "src")
    assert json.loads(zerochat.run_command("pwd"))["output"].strip() == str(project / "src")
    assert zerochat.get_dev_root() == dev_root
    assert "set_project_directory" not in zerochat.LOCAL_TOOL_HANDLERS
    os.chdir(start)
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

test('zerochat.py: la ayuda sale en texto plano aunque el entorno pida colores', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const help = execFileSync('python3', ['zerochat.py', '--help'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '1', PYTHON_COLORS: '1' }
  });

  assert.match(help, /--no-exit-on-close/);
  assert.doesNotMatch(help, /\x1b\[/);
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

test('zerochat.py: run_command mata a los descendientes al agotar el plazo y acota la salida', { skip: process.platform === 'win32' }, () => {
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
    raise AssertionError(f"El proceso {pid} sigue vivo")

with tempfile.TemporaryDirectory() as temp_dir:
    os.environ["ZEROCHAT_DATA_DIR"] = temp_dir
    spec = importlib.util.spec_from_file_location("zerochat_run_command_limits_test", Path(${JSON.stringify(path.join(repoRoot, 'zerochat.py'))}))
    zerochat = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(zerochat)

    pid_file = Path(temp_dir) / "timeout.pid"
    started = time.monotonic()
    result = json.loads(zerochat.run_command(f"sh -c 'echo $$ > {pid_file}; exec sleep 100' & echo antes; sleep 100", timeout_seconds=1))
    assert result["success"] is False and result["status"] == "timeout", result
    assert "timed out after 1 s" in result["error"] and "background=true" in result["note"]
    assert result["output"] == "antes\\n"
    assert time.monotonic() - started < 6
    wait_dead(int(pid_file.read_text().strip()))

    # Lo que deja en marcha un comando que ya ha terminado no sobrevive como huérfano.
    leftover = Path(temp_dir) / "leftover.pid"
    result = json.loads(zerochat.run_command(f"(sh -c 'echo $$ > {leftover}; exec sleep 100' &); while [ ! -s {leftover} ]; do sleep 0.05; done; echo fin"))
    assert result["status"] == "exited" and result["output"] == "fin\\n", result
    wait_dead(int(leftover.read_text().strip()))

    result = json.loads(zerochat.run_command("python3 -c \\"print('x' * 5000000)\\"", timeout_seconds=30))
    assert result["success"] is True, result
    assert result["truncated"] is True and len(result["output"]) < 20000
    log_file = Path(result["log_file"])
    assert log_file.is_file() and log_file.stat().st_size == 5000001

    # Un log que supera el tope conserva comienzo y final, con una marca en medio.
    zerochat.JOB_LOG_HEAD_BYTES = 1000
    zerochat.JOB_LOG_TAIL_BYTES = 1000
    result = json.loads(zerochat.run_command("seq 1 20000"))
    job = zerochat.JOBS.get(job_id=result["job_id"])
    assert result["output"].endswith("20000\\n") and result["truncated"] is True
    text, next_offset = job.read_range(0, 10 ** 9)
    assert text.startswith("1\\n2\\n") and "bytes of output discarded" in text and text.endswith("19999\\n20000\\n")
    assert next_offset == job.total
    content = log_file.with_name(f"job-{job.id}.log").read_text(encoding="utf-8")
    assert content.startswith("1\\n2\\n") and "bytes of output discarded" in content and content.endswith("20000\\n")
`;
  assert.doesNotThrow(() => execFileSync('python3', ['-c', script], { cwd: repoRoot, stdio: 'pipe' }));
});

test('zerochat.py: run_command en segundo plano se sigue y se detiene con check_command', { skip: process.platform === 'win32' }, () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const script = `
import importlib.util
import json
import os
import tempfile
import time
from pathlib import Path

with tempfile.TemporaryDirectory() as temp_dir:
    os.environ["ZEROCHAT_DATA_DIR"] = temp_dir
    spec = importlib.util.spec_from_file_location("zerochat_background_test", Path(${JSON.stringify(path.join(repoRoot, 'zerochat.py'))}))
    zerochat = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(zerochat)
    zerochat.BACKGROUND_STARTUP_WAIT = 0.5

    # Un fallo inmediato se ve en la propia respuesta.
    failed = json.loads(zerochat.run_command("echo ocupado; exit 4", background=True))
    assert failed["status"] == "exited" and failed["exit_code"] == 4 and failed["output"] == "ocupado\\n", failed

    started = time.monotonic()
    first = json.loads(zerochat.run_command("echo uno; sleep 1.5; echo dos; sleep 1.5; echo tres", background=True, job_key="clave-de-prueba"))
    assert time.monotonic() - started < 2
    assert first["status"] == "running" and first["output"] == "uno\\n" and "check_command" in first["note"], first
    job_id = first["job_id"]
    assert zerochat.JOBS.get(key="clave-de-prueba").id == job_id

    # Solo devuelve lo que el modelo aún no ha visto.
    nothing = json.loads(zerochat.check_command(job_id))
    assert nothing["status"] == "running" and nothing["new_output"] == "", nothing
    finished = json.loads(zerochat.check_command(job_id, wait_seconds=10))
    assert finished["status"] == "exited" and finished["exit_code"] == 0 and finished["new_output"] == "dos\\ntres\\n", finished
    assert zerochat.JOBS.get(job_id=job_id).reported is True

    server = json.loads(zerochat.run_command("echo escuchando; exec sleep 100", background=True))
    stopped = json.loads(zerochat.check_command(server["job_id"], stop=True))
    assert stopped["success"] is True and stopped["status"] == "stopped" and stopped["stopped_by"] == "model", stopped

    # Un final que el modelo no ha visto se entrega una sola vez; los vistos y los vivos, nunca.
    unseen = json.loads(zerochat.run_command("echo a; sleep 0.8; echo fin; exit 3", background=True))
    zerochat.JOBS.get(job_id=unseen["job_id"]).done.wait(5)
    alive = json.loads(zerochat.run_command("exec sleep 100", background=True))
    reports = zerochat.JOBS.report_finished([unseen["job_id"], job_id, alive["job_id"], 9999, unseen["job_id"]])
    assert [r["id"] for r in reports] == [unseen["job_id"]], reports
    assert reports[0]["exit_code"] == 3 and reports[0]["tail"] == "a\\nfin" and reports[0]["log_file"].endswith(".log")
    assert zerochat.JOBS.report_finished([unseen["job_id"]]) == []
    assert json.loads(zerochat.check_command(unseen["job_id"]))["new_output"] == ""
    zerochat.check_command(alive["job_id"], stop=True)

    unknown = json.loads(zerochat.check_command(9999))
    assert unknown["success"] is False and "Unknown job_id" in unknown["error"]

    # Límite de comandos simultáneos.
    zerochat.MAX_RUNNING_JOBS = 1
    busy = json.loads(zerochat.run_command("sleep 100", background=True))
    refused = json.loads(zerochat.run_command("echo otro"))
    assert refused["success"] is False and "Too many commands" in refused["error"], refused
    zerochat.MAX_RUNNING_JOBS = 8

    # Al apagar se detienen todos y se borra el directorio de logs.
    log_dir = zerochat.JOBS.get(job_id=busy["job_id"]).log_path.parent
    zerochat.JOBS.shutdown()
    assert zerochat.JOBS.get(job_id=busy["job_id"]).status == "stopped"
    assert not log_dir.exists()
    assert "bash" not in zerochat.LOCAL_TOOL_HANDLERS and "execute_command" not in zerochat.LOCAL_TOOL_HANDLERS
`;
  assert.doesNotThrow(() => execFileSync('python3', ['-c', script], { cwd: repoRoot, stdio: 'pipe' }));
});

test('zerochat.py: al arrancar mata los comandos de instancias muertas sin tocar las vivas', { skip: process.platform === 'win32' }, () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const script = `
import importlib.util
import json
import os
import subprocess
import tempfile
import time
from pathlib import Path

with tempfile.TemporaryDirectory() as temp_dir:
    os.environ["ZEROCHAT_DATA_DIR"] = temp_dir
    tempfile.tempdir = temp_dir
    spec = importlib.util.spec_from_file_location("zerochat_orphans_test", Path(${JSON.stringify(path.join(repoRoot, 'zerochat.py'))}))
    zerochat = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(zerochat)
    base = zerochat._jobs_base_dir()
    assert base.parent == Path(temp_dir)

    def spawn_group():
        proc = subprocess.Popen(["sleep", "100"], start_new_session=True)
        return proc, {"pgid": proc.pid, "start": zerochat._process_start_token(proc.pid)}

    def session(name, owner, jobs):
        directory = base / name
        directory.mkdir()
        (directory / "owner.json").write_text(json.dumps(owner), encoding="utf-8")
        (directory / "jobs.json").write_text(json.dumps(jobs), encoding="utf-8")
        return directory

    dead_owner = subprocess.Popen(["true"])
    dead_owner.wait()
    orphan, orphan_entry = spawn_group()
    reused, reused_entry = spawn_group()
    reused_entry["start"] = "otro-arranque"
    dead = session("dead", {"pid": dead_owner.pid, "start": "x"}, {"1": orphan_entry, "2": reused_entry})

    alive_job, alive_entry = spawn_group()
    alive = session("alive", {"pid": os.getpid(), "start": zerochat._process_start_token(os.getpid())}, {"1": alive_entry})
    # Un proceso vivo con otro arranque no es la instancia registrada: su sesión se limpia.
    impostor_job, impostor_entry = spawn_group()
    impostor = session("impostor", {"pid": alive_job.pid, "start": "otro-arranque"}, {"1": impostor_entry})

    assert zerochat.cleanup_orphan_jobs() == 2
    assert orphan.wait(timeout=5) == -9 and impostor_job.wait(timeout=5) == -9
    assert reused.poll() is None, "un PID reutilizado por otro proceso no se mata"
    assert alive_job.poll() is None, "los comandos de una instancia viva no se tocan"
    assert not dead.exists() and not impostor.exists() and alive.exists()
    for proc in (reused, alive_job):
        proc.kill()
        proc.wait()

    # La propia instancia apunta sus comandos en marcha y los borra al terminar.
    zerochat.BACKGROUND_STARTUP_WAIT = 0.2
    started = json.loads(zerochat.run_command("exec sleep 100", background=True))
    job = zerochat.JOBS.get(job_id=started["job_id"])
    own = job.log_path.parent
    owner = json.loads((own / "owner.json").read_text(encoding="utf-8"))
    assert owner["pid"] == os.getpid()
    registry = json.loads((own / "jobs.json").read_text(encoding="utf-8"))
    assert registry[str(job.id)] == {"pgid": job.proc.pid, "start": zerochat._process_start_token(job.proc.pid)}, (registry, job.id, job.proc.pid)
    zerochat.check_command(job.id, stop=True)
    assert json.loads((own / "jobs.json").read_text(encoding="utf-8")) == {}
    zerochat.JOBS.shutdown()
    assert not own.exists()
`;
  assert.doesNotThrow(() => execFileSync('python3', ['-c', script], { cwd: repoRoot, stdio: 'pipe' }));
});

test('zerochat.py: list_directory, search_files y get_diagnostics manejan enlaces simbólicos externos de forma segura', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const script = `
import importlib.util
import json
import os
import tempfile
from pathlib import Path

with tempfile.TemporaryDirectory() as temp_dir:
    os.environ["ZEROCHAT_DATA_DIR"] = temp_dir
    spec = importlib.util.spec_from_file_location("zerochat_tools_test", Path(${JSON.stringify(path.join(repoRoot, 'zerochat.py'))}))
    zerochat = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(zerochat)

    base = Path(temp_dir)
    outside = base / "outside.txt"
    outside.write_text("SECRET_EXTERNAL_DATA", encoding="utf-8")

    project = base / "proj"
    project.mkdir()
    (project / "regular.txt").write_text("hello world\\nregular line", encoding="utf-8")
    (project / "symlink_ext.txt").symlink_to(outside)

    sub = project / "sub"
    sub.mkdir()
    (sub / "inside.py").write_text("print('inside')\\n", encoding="utf-8")
    (sub / "ext_link.py").symlink_to(outside)

    # 1. list_directory con recursive=True no falla ante symlink externo y calcula relative_path
    list_res = json.loads(zerochat.list_directory(str(project), recursive=True))
    assert list_res["success"] is True
    paths = [e["name"] for e in list_res["entries"]]
    assert "symlink_ext.txt" in paths

    # 2. search_files no indexa ni busca en symlinks que apuntan fuera del proyecto
    search_res = json.loads(zerochat.search_files("SECRET_EXTERNAL", path=str(project)))
    assert search_res["success"] is True
    assert search_res["total_matches"] == 0

    search_ok = json.loads(zerochat.search_files("hello", path=str(project)))
    assert search_ok["success"] is True
    assert search_ok["total_matches"] == 1

    # 3. get_diagnostics no escanea symlinks que apuntan fuera del proyecto
    diag_res = json.loads(zerochat.get_diagnostics(path=str(project)))
    assert diag_res["success"] is True
    assert diag_res["error_count"] == 0

    # 4. read_file acota end_line a máximo 2000 líneas
    big_file = project / "big.txt"
    big_file.write_text("\\n".join(f"line_{i}" for i in range(1, 3000)), encoding="utf-8")
    read_res = json.loads(zerochat.read_file(str(big_file), start_line=1, end_line=2500))
    assert read_res["success"] is True
    assert read_res["lines_returned"] == 2000
    assert read_res["truncated"] is True
`;
  assert.doesNotThrow(() => execFileSync('python3', ['-c', script], { cwd: repoRoot, stdio: 'pipe' }));
});

test('zerochat.py: en Windows cada comando queda en un Job Object que lo mata si ZeroChat termina', { skip: process.platform !== 'win32' }, () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const script = `
import ctypes
import importlib.util
import os
import tempfile
from ctypes import wintypes
from pathlib import Path

with tempfile.TemporaryDirectory() as temp_dir:
    os.environ["ZEROCHAT_DATA_DIR"] = temp_dir
    spec = importlib.util.spec_from_file_location("zerochat_windows_job_test", Path(${JSON.stringify(path.join(repoRoot, 'zerochat.py'))}))
    zerochat = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(zerochat)
    job = zerochat.JOBS.start("Start-Sleep -Seconds 30", background=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.IsProcessInJob.argtypes = [wintypes.HANDLE, wintypes.HANDLE, ctypes.POINTER(wintypes.BOOL)]
    inside = wintypes.BOOL(False)
    assert kernel32.IsProcessInJob(int(job.proc._handle), zerochat.JOBS._windows_job._handle, ctypes.byref(inside))
    assert inside.value
    zerochat.JOBS.stop(job, "user")
    assert job.status == "stopped"
    zerochat.JOBS.shutdown()
`;
  assert.doesNotThrow(() => execFileSync('python', ['-c', script], { cwd: repoRoot, stdio: 'pipe' }));
});
