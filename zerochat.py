#!/usr/bin/env python3
"""
ZeroChat - Backend Local Unificado y Gestor de Entorno

Proporciona:
1. Auto-creación del entorno MCP local `~/zerochat/.venv`.
2. Servidor local HTTP y Server-Sent Events (SSE) con autenticación estricta por token efímero.
3. Herramientas locales seguras: read_file, edit_file, list_directory, run_command.
4. Apertura automática del navegador apuntando a zerochat.html con token en el fragmento hash.
"""

from __future__ import annotations

import argparse
import atexit
import base64
import datetime
import fnmatch
import functools
import hashlib
import hmac
import importlib.metadata
import ipaddress
import json
import os
import queue
import re
import secrets
import shutil
import shlex
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from urllib.parse import urlencode
import venv
import webbrowser
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SOURCE_BACKEND_VERSION = "9.5.0"

def _read_source_version(filename: str) -> str | None:
    """Lee la versión de un archivo del repositorio cuando se ejecuta desde fuentes."""
    try:
        version_file = Path(__file__).resolve().parent / filename
        if version_file.is_file():
            content = version_file.read_text(encoding="utf-8")
            match = re.search(r'version\s*=\s*"([0-9]+\.[0-9]+\.[0-9]+)"', content)
            if match:
                return match.group(1)
    except (OSError, re.error):
        pass
    return None


def _read_backend_version() -> str:
    """Devuelve la versión publicada del backend, sin depender de package.json instalado."""
    source_version = _read_source_version("pyproject.toml")
    if source_version:
        return source_version
    try:
        return importlib.metadata.version("zerochat")
    except importlib.metadata.PackageNotFoundError:
        return SOURCE_BACKEND_VERSION


def _read_ui_version() -> str:
    """Devuelve la versión de la interfaz cuando se ejecuta desde el repositorio."""
    try:
        pkg_path = Path(__file__).resolve().parent / "package.json"
        if pkg_path.is_file():
            data = json.loads(pkg_path.read_text(encoding="utf-8"))
            if isinstance(data.get("version"), str):
                return data["version"].strip()
    except (OSError, json.JSONDecodeError):
        pass
    return BACKEND_PACKAGE_VERSION


def compatibility_version(version: str) -> str:
    """La interfaz y el backend son compatibles si comparten major.minor."""
    parts = version.split(".")
    return ".".join(parts[:2]) if len(parts) >= 2 else version

BACKEND_PACKAGE_VERSION = _read_backend_version()
VERSION = compatibility_version(BACKEND_PACKAGE_VERSION)
UI_VERSION = _read_ui_version()
DEFAULT_PORT = 6388
DEFAULT_HOST = "127.0.0.1"
DEFAULT_UI_URL = "https://albalday.github.io/zerochat/zerochat.html"
REMOTE_SCRIPT_URL = "https://raw.githubusercontent.com/albalday/zerochat/master/zerochat.py"
CONSOLE_STATUS_IDLE_SECONDS = 8.0
CONSOLE_CONTROL = None
NOTICES: list[str] = []
NOTICES_LOCK = threading.Lock()
class ConsoleControl:
    """Muestra una sola línea de ayuda tras un periodo de inactividad en consola."""
    def __init__(self, server: ThreadingHTTPServer, parser: argparse.ArgumentParser, target_url: str | None = None):
        self.server = server
        self.parser = parser
        self.target_url = target_url
        self.last_activity = time.monotonic()
        self.lock = threading.Lock()
        self.enabled = bool(getattr(sys.stdout, "isatty", lambda: False)())
        self._keyboard_enabled = bool(getattr(sys.stdin, "isatty", lambda: False)())
        self._idle_timer: threading.Timer | None = None
        self._keyboard_stop = threading.Event()
        self._keyboard_thread: threading.Thread | None = None
        self._timer_generation = 0
        self._closed = False

    def start(self):
        if self.enabled:
            self._reset_idle_timer()
        if self._keyboard_enabled:
            self._keyboard_thread = threading.Thread(target=self._keyboard_loop, name="zerochat-console-input", daemon=True)
            self._keyboard_thread.start()

    def close(self):
        with self.lock:
            self._closed = True
            self._keyboard_stop.set()
            if self._idle_timer:
                self._idle_timer.cancel()
                self._idle_timer = None

    def _reset_idle_timer(self):
        with self.lock:
            if self._closed:
                return
            self.last_activity = time.monotonic()
            self._timer_generation += 1
            if self._idle_timer:
                self._idle_timer.cancel()
            generation = self._timer_generation
            self._idle_timer = threading.Timer(CONSOLE_STATUS_IDLE_SECONDS, self._show_commands_once, args=(generation,))
            self._idle_timer.daemon = True
            self._idle_timer.start()

    def _show_commands_once(self, generation: int):
        with self.lock:
            if self._closed or generation != self._timer_generation:
                return
            commands = "[h] ayuda · [n] Navegador"
            if get_notices():
                commands += " · [i] información"
            print(f"Comandos de consola: {commands} · [x] salir ordenadamente", flush=True)
            self._idle_timer = None

    def log(self, message: str, *, flush: bool = True):
        print(message, flush=flush)
        if self.enabled:
            self._reset_idle_timer()

    def show_help(self):
        print(self.parser.format_help().rstrip(), flush=True)

    def show_notices(self):
        notices = get_notices()
        if not notices:
            return
        print("Información:", flush=True)
        for notice in notices:
            print(f"- {notice}", flush=True)

    def _handle_command(self, command: str):
        key = command.strip().lower()
        if key == "h":
            self.show_help()
        elif key == "n" and self.target_url:
            launch_browser(self.target_url)
        elif key == "i":
            self.show_notices()
        elif key == "x":
            self.log(timestamp_message("Deteniendo servidor ZeroChat..."))
            stop_zerochat_server(self.server)

    def _keyboard_loop(self):
        """Lee comandos normales terminados con Intro, sin alterar el terminal."""
        while not self._keyboard_stop.is_set():
            line = sys.stdin.readline()
            if not line:
                return
            self._handle_command(line)


def console_log(message: str, *, flush: bool = True):
    if CONSOLE_CONTROL:
        CONSOLE_CONTROL.log(message, flush=flush)
    else:
        print(message, flush=flush)


def timestamp_message(message: str) -> str:
    """Antepone la hora local con el formato común de la consola."""
    return f"[{time.strftime('%H:%M:%S')}] {message}"


def log_event(message: str):
    """Registra en consola un evento con la hora local."""
    console_log(timestamp_message(message))

@functools.lru_cache(maxsize=1)
def get_dev_root() -> Path | None:
    """
    Detecta si zerochat.py se está ejecutando en el directorio de desarrollo del repositorio.
    Comprueba si existen zerochat.html, js/ y css/ en el directorio del script o en cwd.
    Se calcula una vez: set_project_directory cambia cwd y no debe cambiar la interfaz servida.
    """
    script_dir = Path(__file__).resolve().parent
    cwd = Path.cwd().resolve()
    for candidate in (script_dir, cwd):
        if (candidate / "zerochat.html").is_file() and (candidate / "js").is_dir() and (candidate / "css").is_dir():
            return candidate
    return None


def get_static_root() -> Path | None:
    """La interfaz local solo se sirve al ejecutar el repositorio de desarrollo."""
    return get_dev_root()


def is_installed_runtime() -> bool:
    """Identifica el ejecutable instalado desde PyPI, sin confundirlo con el repositorio."""
    if get_dev_root() is not None:
        return False
    try:
        return importlib.metadata.version("zerochat") == BACKEND_PACKAGE_VERSION
    except importlib.metadata.PackageNotFoundError:
        return False


def get_data_dir() -> Path:
    """Devuelve el directorio local que concentra el estado y los MCP de ZeroChat."""
    configured = os.environ.get("ZEROCHAT_DATA_DIR", "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    return (Path.home() / "zerochat").resolve()


def get_venv_dir() -> Path:
    """Devuelve el entorno aislado usado exclusivamente por los MCP Python."""
    return get_data_dir() / ".venv"


def reset_notices():
    """Reinicia los avisos transitorios de la ejecución actual."""
    with NOTICES_LOCK:
        NOTICES.clear()


def add_notice(message: str):
    """Añade un aviso para la consola interactiva de la ejecución actual."""
    if not isinstance(message, str) or not message.strip():
        raise ValueError("El aviso debe ser texto no vacío")
    with NOTICES_LOCK:
        NOTICES.append(message.strip())


def get_notices() -> tuple[str, ...]:
    """Devuelve una instantánea inmutable de los avisos actuales."""
    with NOTICES_LOCK:
        return tuple(NOTICES)


def _write_private_text(target: Path, text: str):
    """Escribe un secreto con permisos 0o600 desde su creación y lo sustituye de una vez."""
    tmp_file = target.with_suffix(target.suffix + ".tmp")
    tmp_file.unlink(missing_ok=True)
    fd = os.open(tmp_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
    tmp_file.replace(target)


def get_daily_token() -> str:
    """Devuelve un token de sesión diario persistido en ~/zerochat/config/token.json."""
    config_dir = get_data_dir() / "config"
    config_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    token_file = config_dir / "token.json"
    if os.name != "nt":
        # Corrige también directorios y tokens creados por versiones anteriores con la umask.
        config_dir.chmod(0o700)
        if token_file.exists():
            token_file.chmod(0o600)
    today = datetime.date.today().isoformat()
    if token_file.exists():
        try:
            data = json.loads(token_file.read_text(encoding="utf-8"))
            if data.get("date") == today and data.get("token") and isinstance(data["token"], str):
                return data["token"]
        except (OSError, json.JSONDecodeError):
            pass
    token = secrets.token_urlsafe(32)
    try:
        _write_private_text(token_file, json.dumps({"token": token, "date": today}, indent=2))
    except OSError as err:
        log_event(f"[zerochat] Advertencia: no se pudo guardar el token diario en {token_file}: {err}")
    return token


# Token de sesión en memoria; main() lo carga o genera al arrancar el servidor.
SESSION_TOKEN = ""
ACTIVE_PORT = DEFAULT_PORT
ACTIVE_HOST = DEFAULT_HOST

# Kept only for this Python process: binds an approved browser tool call to
# the exact JSON-RPC bytes sent to the local host.
TOOL_AUTH_VERSION = "zerochat-tool-auth-v1"
TOOL_AUTH_TTL_MS = 30_000
TOOL_AUTH_MAX_NONCES = 10_000
TOOL_AUTH_KEY = secrets.token_bytes(32)
TOOL_AUTH_SESSION_ID = secrets.token_urlsafe(18)
TOOL_AUTH_NONCES: dict[str, int] = {}
TOOL_AUTH_NONCES_LOCK = threading.Lock()

DETECTED_OS = "windows" if sys.platform.startswith("win") else ("macos" if sys.platform == "darwin" else ("android" if "ANDROID_ROOT" in os.environ else "linux"))


def get_venv_python(venv_dir: Path) -> Path:
    """Devuelve el ejecutable de Python del entorno virtual según el SO."""
    if sys.platform.startswith("win"):
        return venv_dir / "Scripts" / "python.exe"
    return venv_dir / "bin" / "python"


def ensure_virtual_environment():
    """
    Crea ~/zerochat/.venv para dependencias MCP en ambos modos de distribución.
    El servidor conserva el intérprete con el que fue iniciado; el entorno se usa
    exclusivamente al lanzar procesos MCP Python.
    """
    venv_dir = get_venv_dir()
    if get_venv_python(venv_dir).exists():
        return
    log_event(f"[zerochat] Inicializando entorno virtual en {venv_dir}...")
    try:
        venv.create(venv_dir, with_pip=True, clear=False)
        log_event("[zerochat] Entorno virtual preparado con éxito.")
    except Exception as err:
        log_event(f"[zerochat] Advertencia al crear venv: {err}. Continuando con intérprete actual.")

def parse_version(ver: str) -> tuple[int, ...]:
    """Convierte una cadena de versión semántica en tupla de enteros para comparación."""
    parts = []
    for piece in ver.split("."):
        clean = "".join(filter(str.isdigit, piece))
        if clean:
            parts.append(int(clean))
    return tuple(parts)


def _read_remote_content(url: str) -> str:
    """Lee una cabecera acotada de un recurso publicado de ZeroChat."""
    req = urllib.request.Request(url, headers={"User-Agent": f"ZeroChat/{VERSION}"})
    with urllib.request.urlopen(req, timeout=3) as resp:
        return resp.read(4096).decode("utf-8", errors="ignore")


def _read_remote_ui_version() -> str | None:
    """Extrae la versión del título de la interfaz servida por GitHub Pages."""
    content = _read_remote_content(DEFAULT_UI_URL)
    match = re.search(r"<title>\s*ZeroChat\s+v(\d+\.\d+\.\d+)\s*</title>", content, re.IGNORECASE)
    return match.group(1) if match else None


def _read_remote_backend_version() -> str | None:
    """Extrae la versión estática del ejecutable publicado en GitHub."""
    content = _read_remote_content(REMOTE_SCRIPT_URL)
    match = re.search(r'^SOURCE_BACKEND_VERSION\s*=\s*["\'](\d+\.\d+\.\d+)["\']', content, re.MULTILINE)
    return match.group(1) if match else None


def has_new_backend_version(remote_version: str, local_version: str = VERSION) -> bool:
    """Compara solo major.minor: los parches pertenecen a la interfaz web."""
    return parse_version(compatibility_version(remote_version)) > parse_version(compatibility_version(local_version))


def check_version():
    """Informa de la versión de Pages y de actualizaciones del ejecutable."""
    if get_dev_root() is not None:
        return
    try:
        installed = is_installed_runtime()
        remote_ui_version = _read_remote_ui_version()
        if remote_ui_version:
            notice = f"Interfaz web en GitHub Pages: v{remote_ui_version}."
            if remote_ui_version != UI_VERSION:
                notice += f" El ejecutable incluye la referencia v{UI_VERSION}; la interfaz remota se cargará al abrir el navegador."
            add_notice(notice)

        remote_backend_version = _read_remote_backend_version()
        if remote_backend_version and has_new_backend_version(remote_backend_version):
            notice = f"Nueva versión del servidor disponible (local: {VERSION}, remota: {compatibility_version(remote_backend_version)})."
            if installed:
                notice += f" Actualiza cuando quieras con: {sys.executable} -m pip install --upgrade --no-cache-dir zerochat"
            else:
                notice += f" Actualiza con: curl -sSL {REMOTE_SCRIPT_URL} -o zerochat.py"
            add_notice(notice)
    except (urllib.error.URLError, TimeoutError, OSError):
        # Modo offline o sin conectividad al comprobar versiones remotas.
        pass
# ==============================================================================
# Ejecución de comandos y tareas en segundo plano
# ==============================================================================

COMMAND_DEFAULT_TIMEOUT = 30
COMMAND_MAX_TIMEOUT = 600
COMMAND_MAX_WAIT = 600
# Lo que espera un comando en segundo plano antes de responder: deja ver un fallo inmediato.
BACKGROUND_STARTUP_WAIT = 2.5
MAX_RUNNING_JOBS = 8
MAX_FINISHED_JOBS = 50
# El log de cada tarea conserva su comienzo en disco y su final en memoria mientras corre.
JOB_LOG_HEAD_BYTES = 4 * 1024 * 1024
JOB_LOG_TAIL_BYTES = 1024 * 1024
JOB_STOP_GRACE_SECONDS = 3.0
JOB_DRAIN_SECONDS = 2.0
JOB_KEY_PATTERN = re.compile(r"[A-Za-z0-9_-]{8,64}")
# Lo que se lee de cada extremo de la salida nueva antes de recortarla para el modelo.
MODEL_OUTPUT_READ_BYTES = 64 * 1024
CARD_TAIL_BYTES = 2048
JOB_LOG_PAGE_BYTES = 256 * 1024
REPORT_TAIL_LINES = 20
REPORT_TAIL_BYTES = 4096


def truncate_terminal_output(text: str, max_chars: int = 8000, head_lines: int = 50, tail_lines: int = 30) -> tuple[str, bool]:
    """Outputs >8,000 characters are truncated to first 50 lines + warning + last 30 lines."""
    if len(text) <= max_chars:
        return text, False
    lines = text.splitlines(keepends=True)
    if len(lines) <= head_lines + tail_lines:
        half = max_chars // 2
        return (
            text[:half]
            + f"\n\n[... Output truncated due to length ({len(text)} total characters) ...]\n\n"
            + text[-half:],
            True
        )
    omitted = len(lines) - head_lines - tail_lines
    head = "".join(lines[:head_lines])
    tail = "".join(lines[-tail_lines:])
    warning = f"\n\n[... Output truncated: omitted {omitted} lines ({len(text)} total characters) ...]\n\n"
    return head + warning + tail, True


def _powershell_executable() -> str:
    return shutil.which("powershell") or shutil.which("pwsh") or "powershell.exe"


def _kill_process_tree(proc: subprocess.Popen):
    """Termina el proceso y sus descendientes (grupo POSIX o árbol de Windows) para no dejar huérfanos."""
    try:
        if DETECTED_OS == "windows":
            # TerminateProcess solo alcanza al hijo directo: npm.cmd o npx dejarían vivo a node.
            subprocess.run(
                ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)
            )
            if proc.poll() is None:
                try:
                    proc.kill()
                except (ProcessLookupError, OSError, AttributeError):
                    pass
        elif hasattr(os, "killpg") and hasattr(os, "getpgid"):
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        else:
            proc.kill()
    except (ProcessLookupError, PermissionError, OSError, AttributeError):
        try:
            proc.kill()
        except (ProcessLookupError, OSError, AttributeError):
            pass


def _process_start_token(pid: int) -> str | None:
    """Huella del arranque de un proceso: distingue al original de otro que reciba el mismo PID."""
    try:
        if Path(f"/proc/{pid}/stat").is_file():
            stat = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8", errors="replace")
            # El nombre del proceso va entre paréntesis y puede contener espacios.
            return stat.rsplit(")", 1)[1].split()[19]
        result = subprocess.run(["ps", "-o", "lstart=", "-p", str(pid)], capture_output=True, text=True, timeout=5)
        return result.stdout.strip() or None
    except (OSError, IndexError, subprocess.SubprocessError):
        return None


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def _jobs_base_dir() -> Path:
    """Directorio común de los logs y registros de comandos de todas las instancias del usuario."""
    try:
        owner = str(os.getuid())
    except AttributeError:
        owner = re.sub(r"[^A-Za-z0-9_-]", "_", os.environ.get("USERNAME", "user"))
    base = Path(tempfile.gettempdir()) / f"zerochat-jobs-{owner}"
    base.mkdir(mode=0o700, exist_ok=True)
    return base


def cleanup_orphan_jobs() -> int:
    """Mata los comandos de instancias de ZeroChat que murieron sin poder detenerlos (POSIX).

    Solo actúa sobre instancias cuyo proceso ya no existe, y sobre grupos cuyo líder es el
    proceso registrado o ya no existe: nunca alcanza a otra instancia viva ni a un proceso ajeno.
    """
    if DETECTED_OS == "windows" or not hasattr(os, "killpg"):
        return 0
    killed = 0
    try:
        sessions = [entry for entry in _jobs_base_dir().iterdir() if entry.is_dir()]
    except OSError:
        return 0
    for session in sessions:
        try:
            owner = json.loads((session / "owner.json").read_text(encoding="utf-8"))
            owner_pid = int(owner["pid"])
        except (OSError, ValueError, KeyError, TypeError):
            continue
        if owner_pid == os.getpid() or (_pid_alive(owner_pid) and _process_start_token(owner_pid) == owner.get("start")):
            continue
        try:
            registry = json.loads((session / "jobs.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            registry = {}
        for entry in registry.values() if isinstance(registry, dict) else ():
            try:
                pgid = int(entry["pgid"])
            except (ValueError, KeyError, TypeError):
                continue
            # Mientras el grupo exista, su número no se reasigna; si el líder vive, debe ser el registrado.
            if _pid_alive(pgid) and _process_start_token(pgid) != entry.get("start"):
                continue
            try:
                os.killpg(pgid, signal.SIGKILL)
                killed += 1
            except OSError:
                pass
        shutil.rmtree(session, ignore_errors=True)
    return killed


class _WindowsKillOnCloseJob:
    """Job Object de Windows que mata los comandos si ZeroChat termina, aunque sea de golpe."""

    def __init__(self):
        self._handle = None
        self._kernel32 = None
        try:
            import ctypes
            from ctypes import wintypes

            class BasicLimits(ctypes.Structure):
                _fields_ = [
                    ("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                    ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                    ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                    ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD)
                ]

            class IoCounters(ctypes.Structure):
                _fields_ = [(name, ctypes.c_uint64) for name in (
                    "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                    "ReadTransferCount", "WriteTransferCount", "OtherTransferCount"
                )]

            class ExtendedLimits(ctypes.Structure):
                _fields_ = [
                    ("BasicLimitInformation", BasicLimits), ("IoInfo", IoCounters),
                    ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                    ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)
                ]

            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel32.CreateJobObjectW.restype = wintypes.HANDLE
            kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
            kernel32.SetInformationJobObject.restype = wintypes.BOOL
            kernel32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
            kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
            kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
            handle = kernel32.CreateJobObjectW(None, None)
            if not handle:
                return
            limits = ExtendedLimits()
            limits.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            # 9 = JobObjectExtendedLimitInformation
            if not kernel32.SetInformationJobObject(handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
                return
            self._handle = handle
            self._kernel32 = kernel32
        except (OSError, AttributeError, ImportError):
            self._handle = None

    def assign(self, proc: subprocess.Popen) -> bool:
        # Un nieto lanzado antes de la asignación podría escapar: el margen es de microsegundos.
        if not self._handle:
            return False
        try:
            return bool(self._kernel32.AssignProcessToJobObject(self._handle, int(proc._handle)))
        except (OSError, AttributeError, ValueError):
            return False


def _utf8_boundary(data: bytes) -> int:
    """Primer byte que comienza un carácter UTF-8, para no partir uno multibyte."""
    start = 0
    while start < min(len(data), 3) and (data[start] & 0xC0) == 0x80:
        start += 1
    return start


def _discarded_marker(count: int) -> bytes:
    return f"\n[... {count} bytes of output discarded ...]\n".encode("utf-8")


def _powershell_runner(command: str) -> str:
    """Envuelve el comando para que PowerShell devuelva su código de salida real."""
    return (
        "$ErrorActionPreference = 'Continue'\n"
        "$LASTEXITCODE = $null\n"
        "$__ret = 0\n"
        "try {\n"
        "    . {\n"
        f"{command}\n"
        "    }\n"
        "    if ($LASTEXITCODE -ne $null) {\n"
        "        $__ret = $LASTEXITCODE\n"
        "    } elseif (-not $?) {\n"
        "        $__ret = 1\n"
        "    }\n"
        "} catch {\n"
        "    $__ret = 1\n"
        "    [Console]::Error.WriteLine($_)\n"
        "}\n"
        "exit $__ret\n"
    )


class CommandJob:
    """Un comando lanzado por run_command: su proceso, su log y su estado."""

    def __init__(self, job_id: int, key: str | None, command: str, cwd: str, background: bool, log_path: Path):
        self.id = job_id
        self.key = key
        self.command = command
        self.cwd = cwd
        self.background = background
        self.log_path = log_path
        self.started_at = time.time()
        self._started_mono = time.monotonic()
        self.ended_mono: float | None = None
        self.ended_at: float | None = None
        self.exit_code: int | None = None
        self.status = "running"
        self.stop_reason: str | None = None
        self.timeout_seconds: int | None = None
        # Hasta dónde ha leído el modelo la salida, y si ya ha visto el final.
        self.model_cursor = 0
        self.reported = False
        self.proc: subprocess.Popen | None = None
        self.leader_start: str | None = None
        self.runner_path: Path | None = None
        self.done = threading.Event()
        self._lock = threading.Lock()
        self._log = open(log_path, "wb")
        self._head_len = 0
        self._tail = bytearray()
        self._tail_start = 0
        self._total = 0
        self._tail_file_offset = 0
        self._finalized = False
        self._reader: threading.Thread | None = None

    # --- Salida -------------------------------------------------------------

    def _append(self, chunk: bytes):
        with self._lock:
            self._total += len(chunk)
            room = JOB_LOG_HEAD_BYTES - self._head_len
            if room > 0:
                part = chunk[:room]
                self._log.write(part)
                self._log.flush()
                self._head_len += len(part)
                self._tail_start = self._head_len
                chunk = chunk[room:]
            if chunk:
                self._tail.extend(chunk)
                overflow = len(self._tail) - JOB_LOG_TAIL_BYTES
                if overflow > 0:
                    del self._tail[:overflow]
                    self._tail_start += overflow

    def _read_output(self, stream):
        try:
            while True:
                chunk = stream.read1(65536) if hasattr(stream, "read1") else stream.read(65536)
                if not chunk:
                    break
                self._append(chunk)
        except (OSError, ValueError):
            pass

    def start_reader(self, stream):
        self._reader = threading.Thread(target=self._read_output, args=(stream,), daemon=True)
        self._reader.start()

    def _finalize_log(self):
        """Al terminar, el final retenido en memoria pasa al fichero tras una marca de recorte."""
        if self._reader:
            # Un proceso que escape del grupo puede mantener el pipe abierto: no esperar sin límite.
            self._reader.join(JOB_DRAIN_SECONDS)
        with self._lock:
            marker = b""
            dropped = self._tail_start - self._head_len
            if dropped > 0:
                marker = _discarded_marker(dropped)
                self._log.write(marker)
            self._tail_file_offset = self._head_len + len(marker)
            self._log.write(bytes(self._tail))
            self._log.close()
            self._tail = bytearray()
            self._finalized = True

    @property
    def total(self) -> int:
        return self._total

    @property
    def truncated_log(self) -> bool:
        return self._tail_start > self._head_len

    def read_range(self, start: int, max_bytes: int) -> tuple[str, int]:
        """Devuelve la salida desde la posición start (como mucho max_bytes) y la posición siguiente.

        Las posiciones cuentan los bytes producidos por el comando; el tramo descartado del medio
        se sustituye por una marca.
        """
        with self._lock:
            pos = max(0, min(start, self._total))
            remaining = max(0, max_bytes)
            pieces: list[bytes] = []
            if remaining and pos < self._head_len:
                count = min(remaining, self._head_len - pos)
                with open(self.log_path, "rb") as handle:
                    handle.seek(pos)
                    pieces.append(handle.read(count))
                pos += count
                remaining -= count
            if remaining and self._head_len <= pos < self._tail_start:
                pieces.append(_discarded_marker(self._tail_start - self._head_len))
                pos = self._tail_start
            if remaining and self._tail_start <= pos < self._total:
                count = min(remaining, self._total - pos)
                offset = pos - self._tail_start
                if self._finalized:
                    with open(self.log_path, "rb") as handle:
                        handle.seek(self._tail_file_offset + offset)
                        pieces.append(handle.read(count))
                else:
                    pieces.append(bytes(self._tail[offset:offset + count]))
                pos += count
        data = b"".join(pieces)
        if start > 0:
            data = data[_utf8_boundary(data):]
        return data.decode("utf-8", errors="replace"), pos

    def output_since(self, start: int) -> str:
        """La salida desde start, leyendo solo su comienzo y su final si es muy larga."""
        total = self._total
        if total - start <= 2 * MODEL_OUTPUT_READ_BYTES:
            return self.read_range(start, total - start)[0]
        head, _ = self.read_range(start, MODEL_OUTPUT_READ_BYTES)
        tail, _ = self.read_range(total - MODEL_OUTPUT_READ_BYTES, MODEL_OUTPUT_READ_BYTES)
        omitted = total - start - 2 * MODEL_OUTPUT_READ_BYTES
        return head + f"\n[... {omitted} bytes omitted ...]\n" + tail

    def tail_text(self, max_bytes: int = CARD_TAIL_BYTES) -> str:
        return self.read_range(max(0, self._total - max_bytes), max_bytes)[0]

    # --- Estado -------------------------------------------------------------

    def elapsed(self) -> float:
        end = self.ended_mono if self.ended_mono is not None else time.monotonic()
        return round(end - self._started_mono, 1)

    def summary(self) -> dict:
        return {
            "id": self.id,
            "key": self.key,
            "command": self.command if len(self.command) <= 300 else self.command[:300] + "…",
            "cwd": self.cwd,
            "background": self.background,
            "status": self.status,
            "exit_code": self.exit_code,
            "stop_reason": self.stop_reason,
            "started_at": int(self.started_at * 1000),
            "ended_at": int(self.ended_at * 1000) if self.ended_at else None,
            "elapsed_s": self.elapsed(),
            "output_bytes": self._total
        }


class JobManager:
    """Registro de los comandos lanzados en esta sesión del servidor."""

    def __init__(self):
        self._jobs: dict[int, CommandJob] = {}
        self._next_id = 1
        self._lock = threading.Lock()
        self._dir: Path | None = None
        self._windows_job: _WindowsKillOnCloseJob | None = None
        atexit.register(self.shutdown)

    def _session_dir(self) -> Path:
        """Directorio de esta instancia, con su huella para que otra pueda limpiarlo si muere."""
        if self._dir is None:
            directory = Path(tempfile.mkdtemp(prefix=f"{os.getpid()}-", dir=_jobs_base_dir()))
            owner = {"pid": os.getpid(), "start": _process_start_token(os.getpid())}
            (directory / "owner.json").write_text(json.dumps(owner), encoding="utf-8")
            self._dir = directory
        return self._dir

    def _write_registry(self):
        """Apunta en disco los grupos de procesos en marcha para limpiarlos tras un cierre abrupto."""
        if DETECTED_OS == "windows" or self._dir is None:
            return
        with self._lock:
            entries = {
                str(job.id): {"pgid": job.proc.pid, "start": job.leader_start}
                for job in self._jobs.values() if job.proc and job.ended_at is None
            }
        try:
            _atomic_write_text(self._dir / "jobs.json", json.dumps(entries))
        except OSError:
            pass

    def _prune(self):
        finished = [job for job in self._jobs.values() if job.done.is_set()]
        for job in finished[:max(0, len(finished) - MAX_FINISHED_JOBS)]:
            del self._jobs[job.id]
            try:
                job.log_path.unlink(missing_ok=True)
            except OSError:
                pass

    def start(self, command: str, background: bool, key: str | None = None) -> CommandJob:
        if not isinstance(command, str) or not command.strip():
            raise ValueError("The command is empty.")
        if key is not None and not (isinstance(key, str) and JOB_KEY_PATTERN.fullmatch(key)):
            key = None
        cwd = str(Path.cwd().resolve())
        with self._lock:
            if sum(1 for job in self._jobs.values() if job.status == "running") >= MAX_RUNNING_JOBS:
                raise ValueError(
                    f"Too many commands running ({MAX_RUNNING_JOBS}). "
                    "Stop one with check_command(job_id, stop=true) before starting another."
                )
            self._prune()
            job_id = self._next_id
            self._next_id += 1
            job = CommandJob(job_id, key, command, cwd, background, self._session_dir() / f"job-{job_id}.log")
            self._jobs[job_id] = job
        try:
            self._launch(job)
        except Exception:
            with self._lock:
                self._jobs.pop(job_id, None)
            job._log.close()
            job.log_path.unlink(missing_ok=True)
            raise
        return job

    def _launch(self, job: CommandJob):
        if DETECTED_OS == "windows":
            job.runner_path = job.log_path.with_suffix(".ps1")
            job.runner_path.write_text(_powershell_runner(job.command), encoding="utf-8")
            argv = [_powershell_executable(), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(job.runner_path)]
        else:
            argv = [shutil.which("bash") or shutil.which("sh") or "/bin/sh", "-c", job.command]
        job.proc = subprocess.Popen(
            argv,
            cwd=job.cwd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            # Una sola salida, en el orden en que la escribe el comando, como en una terminal.
            stderr=subprocess.STDOUT,
            start_new_session=DETECTED_OS != "windows" and hasattr(os, "setsid")
        )
        if DETECTED_OS == "windows":
            if self._windows_job is None:
                self._windows_job = _WindowsKillOnCloseJob()
            self._windows_job.assign(job.proc)
        else:
            job.leader_start = _process_start_token(job.proc.pid)
        job.start_reader(job.proc.stdout)
        threading.Thread(target=self._watch, args=(job,), daemon=True).start()
        self._write_registry()

    def _watch(self, job: CommandJob):
        proc = job.proc
        if DETECTED_OS != "windows" and hasattr(os, "waitid"):
            # Esperar sin recoger al proceso mantiene reservado su grupo: así se puede matar a lo
            # que haya dejado en marcha sin riesgo de alcanzar a un grupo nuevo con el mismo número.
            try:
                os.waitid(os.P_PID, proc.pid, os.WEXITED | os.WNOWAIT)
                os.killpg(proc.pid, signal.SIGKILL)
            except (OSError, ChildProcessError):
                pass
        returncode = proc.wait()
        job._finalize_log()
        if proc.stdout:
            try:
                proc.stdout.close()
            except OSError:
                pass
        if job.runner_path:
            job.runner_path.unlink(missing_ok=True)
        job.ended_mono = time.monotonic()
        job.ended_at = time.time()
        job.exit_code = returncode
        if job.stop_reason == "timeout":
            job.status = "timeout"
        elif job.stop_reason:
            job.status = "stopped"
        else:
            job.status = "exited"
        self._write_registry()
        job.done.set()

    def get(self, job_id=None, key=None) -> CommandJob | None:
        with self._lock:
            if isinstance(job_id, int) and not isinstance(job_id, bool):
                return self._jobs.get(job_id)
            if isinstance(key, str) and key:
                return next((job for job in self._jobs.values() if job.key == key), None)
        return None

    def list(self) -> list[CommandJob]:
        with self._lock:
            return list(self._jobs.values())

    def stop(self, job: CommandJob, reason: str) -> CommandJob:
        """Termina el grupo del comando: primero con cortesía y, si no basta, a la fuerza."""
        if job.done.is_set():
            return job
        if job.stop_reason is None:
            job.stop_reason = reason
        proc = job.proc
        if DETECTED_OS == "windows":
            _kill_process_tree(proc)
            job.done.wait(JOB_STOP_GRACE_SECONDS)
            return job
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except OSError:
            pass
        if not job.done.wait(JOB_STOP_GRACE_SECONDS):
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except OSError:
                pass
            job.done.wait(JOB_STOP_GRACE_SECONDS)
        return job

    def report_finished(self, ids: list[int]) -> list[dict]:
        """Final de los comandos indicados que han terminado sin que el modelo lo haya visto.

        Cada final se entrega una sola vez: queda marcado como visto.
        """
        reports = []
        for job_id in dict.fromkeys(ids):
            job = self.get(job_id=job_id)
            if job is None or not job.done.is_set() or job.reported:
                continue
            job.reported = True
            job.model_cursor = job.total
            tail = "\n".join(job.tail_text(REPORT_TAIL_BYTES).rstrip("\n").split("\n")[-REPORT_TAIL_LINES:])
            reports.append({**job.summary(), "tail": tail, "log_file": str(job.log_path)})
        return reports

    def running(self) -> list[CommandJob]:
        return [job for job in self.list() if not job.done.is_set()]

    def stop_all(self, reason: str = "shutdown"):
        threads = [threading.Thread(target=self.stop, args=(job, reason), daemon=True) for job in self.running()]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(JOB_STOP_GRACE_SECONDS * 2 + 1)

    def shutdown(self):
        self.stop_all("shutdown")
        if self._dir is not None:
            shutil.rmtree(self._dir, ignore_errors=True)


JOBS = JobManager()


def _clamp_seconds(value, default: int, minimum: int, maximum: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        number = default
    return max(minimum, min(number, maximum))


def _job_result(job: CommandJob, note: str | None = None, output_field: str = "output") -> str:
    """Resultado para el modelo con la salida que aún no ha visto."""
    start = job.model_cursor
    total = job.total
    output, truncated = truncate_terminal_output(job.output_since(start))
    job.model_cursor = total
    # Detener un comando a propósito no es un fallo; sí lo son salir con error o agotar el plazo.
    failed = job.status == "timeout" or (job.status == "exited" and job.exit_code != 0)
    result = {"success": not failed, "status": job.status, "job_id": job.id}
    if job.status == "timeout":
        result["error"] = f"Command timed out after {job.timeout_seconds} s and was killed."
    if job.status == "running":
        result["elapsed_s"] = job.elapsed()
    else:
        result["exit_code"] = job.exit_code
        result["duration_s"] = job.elapsed()
        job.reported = True
    result[output_field] = output
    if truncated or job.truncated_log:
        result["truncated"] = True
        result["log_file"] = str(job.log_path)
    if job.status == "stopped":
        result["stopped_by"] = job.stop_reason
    if note:
        result["note"] = note
    return json.dumps(result, ensure_ascii=False, indent=2)


def run_command(command: str, timeout_seconds: int = COMMAND_DEFAULT_TIMEOUT, background: bool = False, job_key: str | None = None) -> str:
    """Ejecuta un comando en una shell nueva en el directorio del proyecto."""
    try:
        job = JOBS.start(command, background=bool(background), key=job_key)
    except (ValueError, OSError) as exc:
        return _tool_error(str(exc), os=DETECTED_OS)
    if background:
        if not job.done.wait(BACKGROUND_STARTUP_WAIT):
            return _job_result(job, note=(
                f"Running in background. Follow it with check_command(job_id={job.id}, wait_seconds=...) "
                f"and stop it with check_command(job_id={job.id}, stop=true)."
            ))
        return _job_result(job)
    timeout = _clamp_seconds(timeout_seconds, COMMAND_DEFAULT_TIMEOUT, 1, COMMAND_MAX_TIMEOUT)
    if not job.done.wait(timeout):
        job.timeout_seconds = timeout
        JOBS.stop(job, "timeout")
        return _job_result(job, note=(
            f"Killed after {timeout} s. If this command is expected to take longer, re-run it with "
            f"a larger timeout_seconds (max {COMMAND_MAX_TIMEOUT}) or with background=true."
        ))
    return _job_result(job)


def check_command(job_id: int, wait_seconds: int = 0, stop: bool = False) -> str:
    """Estado y salida nueva de un comando lanzado por run_command; puede esperarlo o detenerlo."""
    job = JOBS.get(job_id=job_id)
    if job is None:
        return _tool_error(f"Unknown job_id {job_id}. It may belong to a previous ZeroChat session.", os=DETECTED_OS)
    if stop:
        JOBS.stop(job, "model")
    else:
        wait = _clamp_seconds(wait_seconds, 0, 0, COMMAND_MAX_WAIT)
        if wait:
            job.done.wait(wait)
    return _job_result(job, output_field="new_output")


def job_details(job: CommandJob) -> dict:
    """Estado del comando para su tarjeta en la interfaz, con el final de su salida."""
    return {**job.summary(), "tail": job.tail_text()}
# ==============================================================================
# Generated from services/ by scripts/build-managed-services.mjs. Do not edit.
# ==============================================================================

MANAGED_SERVICE_FILES: dict[str, str] = json.loads("{\n  \"composio/installer.json\": \"{\\n  \\\"schemaVersion\\\": 1,\\n  \\\"type\\\": \\\"npm\\\",\\n  \\\"product\\\": {\\n    \\\"package\\\": \\\"mcp-remote\\\",\\n    \\\"version\\\": \\\"0.13.5\\\"\\n  },\\n  \\\"requirements\\\": {\\n    \\\"node\\\": {\\n      \\\"minimumMajor\\\": 18\\n    }\\n  }\\n}\\n\",\n  \"composio/service.json\": \"{\\n  \\\"schemaVersion\\\": 1,\\n  \\\"id\\\": \\\"composio\\\",\\n  \\\"displayName\\\": {\\n    \\\"es\\\": \\\"Composio Connect\\\",\\n    \\\"en\\\": \\\"Composio Connect\\\"\\n  },\\n  \\\"description\\\": {\\n    \\\"es\\\": \\\"MCP remoto para acceder a aplicaciones como Gmail, Google Drive, Slack o GitHub. Composio solicita la autorización de cada aplicación cuando sea necesaria.\\\",\\n    \\\"en\\\": \\\"Remote MCP for apps such as Gmail, Google Drive, Slack, and GitHub. Composio requests authorization for each app when it is needed.\\\"\\n  },\\n  \\\"help\\\": {\\n    \\\"url\\\": \\\"https://docs.composio.dev/docs/composio-connect\\\",\\n    \\\"label\\\": {\\n      \\\"es\\\": \\\"Guía oficial de Composio Connect\\\",\\n      \\\"en\\\": \\\"Composio Connect official guide\\\"\\n    }\\n  },\\n  \\\"enabledByDefault\\\": false,\\n  \\\"transport\\\": \\\"stdio\\\",\\n  \\\"remote\\\": {\\n    \\\"type\\\": \\\"mcp-remote\\\",\\n    \\\"transport\\\": \\\"streamable-http\\\",\\n    \\\"url\\\": \\\"https://connect.composio.dev/mcp\\\",\\n    \\\"authentication\\\": \\\"composio-connect\\\"\\n  },\\n  \\\"launch\\\": {\\n    \\\"executable\\\": \\\"${nodeExecutable}\\\",\\n    \\\"args\\\": [\\n      \\\"${serviceDir}/node_modules/mcp-remote/dist/proxy.js\\\",\\n      \\\"https://connect.composio.dev/mcp\\\",\\n      \\\"--protocol\\\",\\n      \\\"legacy\\\",\\n      \\\"--static-oauth-client-metadata\\\",\\n      \\\"{\\\\\\\"client_name\\\\\\\":\\\\\\\"zerochat-mcp-remote\\\\\\\"}\\\",\\n      \\\"--auth-timeout\\\",\\n      \\\"120\\\"\\n    ],\\n    \\\"cwd\\\": \\\"${serviceDir}\\\",\\n    \\\"env\\\": {\\n      \\\"HOME\\\": \\\"${serviceDir}\\\",\\n      \\\"USERPROFILE\\\": \\\"${serviceDir}\\\"\\n    },\\n    \\\"handshakeTimeoutSeconds\\\": 150\\n  }\\n}\\n\",\n  \"ejemplo/ejemplo_mcp_server.py\": \"#!/usr/bin/env python3\\nimport json\\nimport sys\\n\\ndef reply(req_id, result=None, error=None):\\n    resp = {\\\"jsonrpc\\\": \\\"2.0\\\", \\\"id\\\": req_id}\\n    if error:\\n        resp[\\\"error\\\"] = error\\n    else:\\n        resp[\\\"result\\\"] = result\\n    sys.stdout.write(json.dumps(resp) + \\\"\\\\n\\\")\\n    sys.stdout.flush()\\n\\nfor raw in sys.stdin:\\n    try:\\n        req = json.loads(raw)\\n    except Exception:\\n        continue\\n    req_id = req.get(\\\"id\\\")\\n    method = req.get(\\\"method\\\")\\n    params = req.get(\\\"params\\\", {})\\n    if method == \\\"initialize\\\":\\n        reply(req_id, {\\n            \\\"protocolVersion\\\": \\\"2024-11-05\\\",\\n            \\\"serverInfo\\\": {\\\"name\\\": \\\"ZeroChat MCP Example\\\", \\\"version\\\": \\\"1.0.0\\\"},\\n            \\\"capabilities\\\": {\\\"tools\\\": {}}\\n        })\\n    elif method == \\\"tools/list\\\":\\n        reply(req_id, {\\\"tools\\\": [{\\n            \\\"name\\\": \\\"echo\\\",\\n            \\\"description\\\": \\\"Echo back a message for testing.\\\",\\n            \\\"inputSchema\\\": {\\n                \\\"type\\\": \\\"object\\\",\\n                \\\"properties\\\": {\\\"message\\\": {\\\"type\\\": \\\"string\\\", \\\"description\\\": \\\"Message to echo.\\\"}},\\n                \\\"required\\\": [\\\"message\\\"]\\n            }\\n        }]})\\n    elif method == \\\"tools/call\\\":\\n        if params.get(\\\"name\\\") != \\\"echo\\\":\\n            reply(req_id, error={\\\"code\\\": -32601, \\\"message\\\": \\\"Tool not found\\\"})\\n            continue\\n        msg = params.get(\\\"arguments\\\", {}).get(\\\"message\\\", \\\"\\\")\\n        reply(req_id, {\\n            \\\"content\\\": [{\\\"type\\\": \\\"text\\\", \\\"text\\\": f\\\"echo: {msg}\\\"}],\\n            \\\"isError\\\": False\\n        })\\n\",\n  \"ejemplo/installer.json.example\": \"{\\n  \\\"schemaVersion\\\": 1,\\n  \\\"type\\\": \\\"npm\\\",\\n  \\\"product\\\": {\\n    \\\"package\\\": \\\"@scope/mcp-package\\\",\\n    \\\"version\\\": \\\"1.2.3\\\"\\n  },\\n  \\\"requirements\\\": {\\n    \\\"node\\\": {\\n      \\\"minimumMajor\\\": 18\\n    }\\n  }\\n}\\n\",\n  \"ejemplo/README.md\": \"# Crear un MCP gestionado por ZeroChat\\n\\nEsta carpeta es la referencia para crear servicios MCP gestionados. La ubicación de producción es el directorio personal del usuario, seguido de `zerochat/services` (por ejemplo, `/home/usuario/zerochat/services`). No uses `~`, `$HOME` ni una ruta relativa como `services/`: primero identifica la ruta absoluta del directorio personal y úsala para localizar este archivo. El nuevo servicio se crea como carpeta hermana de `ejemplo`, nunca dentro de ella.\\n\\n## Procedimiento obligatorio\\n\\n1. Lee `README.md`, `service.json` y `installer.json.example` de la carpeta `ejemplo` situada en el directorio de datos de ZeroChat.\\n2. Consulta solo la documentación oficial del MCP solicitado.\\n3. Crea una carpeta con un identificador seguro y descriptivo junto a `ejemplo`. Usa un `id` único en `service.json`, también cuando copies otro servicio.\\n4. Crea `service.json` copiando esta estructura y adapta únicamente los valores necesarios.\\n5. Crea `installer.json` solo si el MCP se distribuye como paquete npm. Copia `installer.json.example`, fija la versión exacta y declara la versión mínima de Node.js.\\n6. Añade `help.url` con la página oficial de instalación y etiquetas en español e inglés.\\n7. Si requiere una API key, declara la variable que exige el MCP en el objeto `env` de `launch` dentro de `service.json` con el valor literal `PASTE_API_KEY_HERE`. No pidas la clave al usuario ni la escribas en el chat: indica la ruta absoluta del JSON y el campo que debe editar a mano. El usuario guardará su clave únicamente en el JSON local de su carpeta propia.\\n8. No instales ni inicies el servicio. Al terminar, informa de los archivos creados, fuentes oficiales y requisitos pendientes.\\n\\n## Límites de ZeroChat\\n\\nZeroChat gestiona procesos MCP por `stdio`. Puede instalar paquetes npm mediante `installer.json` y arrancarlos con `${nodeExecutable}`. También puede arrancar un ejecutable o script ya disponible con `launch`.\\n\\nZeroChat también puede usar `mcp-remote` como puente para un MCP remoto HTTP/SSE con OAuth o API key. Decláralo como un servicio `stdio`: el proceso local debe ser `mcp-remote`, mientras que `remote` describe el endpoint remoto para la interfaz. Conserva las credenciales y el almacén OAuth dentro de `${serviceDir}`.\\n\\n## Contratos JSON\\n\\n- `service.json` es obligatorio. Conserva `schemaVersion`, `id`, textos bilingües, `transport: \\\"stdio\\\"` y `launch`.\\n- En `launch`, usa `${serviceDir}`, `${nodeExecutable}` o `${pythonExecutable}`; no uses rutas absolutas de usuario.\\n- `launch.handshakeTimeoutSeconds` (15 s por defecto) limita el arranque y `launch.callTimeoutSeconds` (30 s por defecto) cada llamada a una herramienta; súbelo para MCP lentos, como la automatización de navegador.\\n- `installer.json` es opcional y hoy solo admite `type: \\\"npm\\\"`.\\n- `help` es opcional, pero debe incluirse en todo servicio creado:\\n\\n```json\\n\\\"help\\\": {\\n  \\\"url\\\": \\\"https://documentacion-oficial.example/install\\\",\\n  \\\"label\\\": { \\\"es\\\": \\\"Instalación oficial\\\", \\\"en\\\": \\\"Official installation\\\" }\\n}\\n```\\n\\n## Prompt para el usuario\\n\\nSustituye únicamente `<nombre-del-mcp>`:\\n\\n```text\\nPara instalar el MCP <nombre-del-mcp>, lee primero services/ejemplo/README.md y sigue exactamente sus instrucciones.\\n```\\n\\n## Servicios remotos y claves API\\n\\n`launch.env` es el objeto `env` dentro de `launch` en `service.json`, no un archivo. El agente deja únicamente el marcador; el usuario introduce la clave real a mano en ese JSON. No crees un archivo `launch.env` o `.env`.\\n\\nPara un remoto, lee también `service.json` e `installer.json` de la carpeta hermana `composio`. Crea una carpeta nueva con nombre e `id` propios; usa Composio como ejemplo del puente local, conservando `transport: \\\"stdio\\\"`. Consulta la documentación oficial del proveedor y de [mcp-remote](https://github.com/punkpeye/mcp-remote#custom-headers) para adaptar endpoint, transporte, cabeceras y autenticación. No copies sin verificar las opciones `--protocol`, los metadatos de cliente ni los parámetros OAuth específicos de Composio. Conserva `HOME` y `USERPROFILE` dentro de `${serviceDir}`.\\n\\nPara un MCP local que requiera una variable, deja este campo dentro de `launch`, conservando sus demás campos y usando el nombre de variable documentado por el MCP:\\n\\n```json\\n\\\"env\\\": {\\n  \\\"SERVICE_API_KEY\\\": \\\"PASTE_API_KEY_HERE\\\"\\n}\\n```\\n\\nPara un remoto que acepte `Authorization: Bearer`, los campos dentro de `launch` pueden ser:\\n\\n```json\\n\\\"args\\\": [\\n  \\\"${serviceDir}/node_modules/mcp-remote/dist/proxy.js\\\",\\n  \\\"https://mcp.example.com/mcp\\\",\\n  \\\"--header\\\",\\n  \\\"Authorization: Bearer ${REMOTE_API_KEY}\\\"\\n],\\n\\\"env\\\": {\\n  \\\"HOME\\\": \\\"${serviceDir}\\\",\\n  \\\"USERPROFILE\\\": \\\"${serviceDir}\\\",\\n  \\\"REMOTE_API_KEY\\\": \\\"PASTE_API_KEY_HERE\\\"\\n}\\n```\\n\\nAdapta la cabecera y su formato a lo que exige el proveedor. `remote.authentication` solo describe el servicio; no configura la autenticación. La referencia `${REMOTE_API_KEY}` en la cabecera la resuelve `mcp-remote`. ZeroChat no resuelve variables de entorno genéricas: en `launch.env`, `${SERVICE_API_KEY}` se pasaría como texto literal. Solo sustituye `${serviceDir}`, `${nodeExecutable}`, `${pythonExecutable}` y `${option:...}`. No pongas claves reales en argumentos ni en URLs.\\n\\n### Pasos para el usuario\\n\\n1. Usa una carpeta propia bajo el directorio de servicios, con nombre e `id` únicos. Si copias un servicio incluido, copia sus definiciones, no sus dependencias ni credenciales OAuth. No edites `ejemplo`, `composio`, `playwright` ni `memory`: sus archivos distribuidos se restauran al arrancar.\\n2. Abre el `service.json` de tu carpeta y sustituye `PASTE_API_KEY_HERE` por la clave real en `launch.env`. Mantén el JSON válido y los demás campos. No necesitas `export`, `.env` ni otro JSON de credenciales.\\n3. Restringe el archivo a tu usuario con `chmod 600 /ruta/absoluta/zerochat/services/mi-servicio/service.json` en Linux o Termux. La clave queda en texto plano: no compartas el archivo ni lo subas al repositorio o al chat.\\n4. Inicia el servicio desde Ajustes → MCP. Si la nueva carpeta no aparece, reinicia ZeroChat y conecta de nuevo. Para cambiar una clave, detén primero el servicio, edita el JSON y vuelve a iniciarlo.\\n5. ZeroChat conserva los servicios propios al reiniciar y actualizar. Borrar el directorio de datos elimina también esas claves: guarda una copia privada si la necesitas.\\n\\n## English: creating local and remote services\\n\\n1. Locate the user's absolute home directory and read `README.md`, `service.json` and `installer.json.example` in `zerochat/services/ejemplo`.\\n2. Read the requested MCP's official documentation. Create a sibling folder with its own name and unique JSON `id`; do not modify bundled definitions. Preserve bilingual text, `schemaVersion`, `transport: \\\"stdio\\\"`, `launch` and official `help` links. `launch.handshakeTimeoutSeconds` (default 15 s) bounds startup and `launch.callTimeoutSeconds` (default 30 s) each tool call; raise it for slow MCPs such as browser automation.\\n3. For npm services, add `installer.json` with an exact package version and minimum Node.js major version. Otherwise use an existing executable or script.\\n4. For remote HTTP/SSE MCPs, also read the sibling `composio` JSON files and use its managed `mcp-remote` bridge as the example. Adapt endpoint, transport and authentication to the official provider and bridge documentation. Verify Composio-specific protocol and OAuth options before copying them. Keep `HOME` and `USERPROFILE` isolated inside `${serviceDir}`.\\n5. If an API key is required, put the literal `PASTE_API_KEY_HERE` under the required variable in the `env` object under `launch` inside `service.json`. `launch.env` is a JSON field, not a file. The user enters the actual key manually in that JSON; do not create a `launch.env` or `.env` file. Do not request the user's key or place real secrets in chat, arguments or URLs. Give the absolute JSON path and exact field to edit. For remote header authentication, use `--header` with the provider's required header and a reference to the variable, as shown above; `mcp-remote` resolves that reference. `remote.authentication` is descriptive only.\\n6. Do not install or start the service. Report created files, official sources and outstanding requirements; the user will start it from Settings → MCP.\\n\\nThe user replaces `PASTE_API_KEY_HERE` directly in their own folder's JSON, preserves valid JSON and existing fields, and restricts the file with `chmod 600 /absolute/path/zerochat/services/my-service/service.json` on Linux/Termux. No shell export, `.env` or separate credentials JSON is needed. ZeroChat only expands service/interpreter paths and `${option:...}`, not generic environment placeholders in `launch.env`. The key is stored in plain text: do not share or commit the file or paste it into chat.\\n\\nIf a new folder does not appear, restart ZeroChat and reconnect. Stop an active service before editing its key, then start it again. User-created folders survive restarts and updates. Bundled definitions are restored on startup: copy them into a new folder and change the JSON `id` to customize them, without copying dependencies or OAuth credentials. Deleting the data directory also deletes custom services and their keys; keep a private backup if needed.\\n\",\n  \"ejemplo/service.json\": \"{\\n  \\\"schemaVersion\\\": 1,\\n  \\\"id\\\": \\\"ejemplo\\\",\\n  \\\"displayName\\\": {\\n    \\\"es\\\": \\\"Ejemplo de MCP\\\",\\n    \\\"en\\\": \\\"MCP example\\\"\\n  },\\n  \\\"description\\\": {\\n    \\\"es\\\": \\\"Plantilla mínima para crear servicios MCP gestionados por ZeroChat. Muestra el protocolo stdio y la estructura de configuración que debe seguir un nuevo MCP.\\\",\\n    \\\"en\\\": \\\"Minimal template for creating ZeroChat-managed MCP services. It demonstrates the stdio protocol and configuration structure for a new MCP.\\\"\\n  },\\n  \\\"help\\\": {\\n    \\\"url\\\": \\\"help/mcp.html#crear-mcp-con-agente\\\",\\n    \\\"label\\\": {\\n      \\\"es\\\": \\\"Guía para crear un MCP gestionado\\\",\\n      \\\"en\\\": \\\"Guide to creating a managed MCP\\\"\\n    }\\n  },\\n  \\\"enabledByDefault\\\": false,\\n  \\\"transport\\\": \\\"stdio\\\",\\n  \\\"launch\\\": {\\n    \\\"executable\\\": \\\"${pythonExecutable}\\\",\\n    \\\"args\\\": [\\\"${serviceDir}/ejemplo_mcp_server.py\\\"],\\n    \\\"cwd\\\": \\\"${serviceDir}\\\",\\n    \\\"env\\\": {},\\n    \\\"handshakeTimeoutSeconds\\\": 10\\n  }\\n}\\n\",\n  \"memory/installer.json\": \"{\\n  \\\"schemaVersion\\\": 1,\\n  \\\"type\\\": \\\"npm\\\",\\n  \\\"product\\\": {\\n    \\\"package\\\": \\\"@modelcontextprotocol/server-memory\\\",\\n    \\\"version\\\": \\\"2026.8.31\\\"\\n  },\\n  \\\"requirements\\\": {\\n    \\\"node\\\": {\\n      \\\"minimumMajor\\\": 18\\n    }\\n  }\\n}\\n\",\n  \"memory/service.json\": \"{\\n  \\\"schemaVersion\\\": 1,\\n  \\\"id\\\": \\\"memory\\\",\\n  \\\"displayName\\\": {\\n    \\\"es\\\": \\\"Memoria y Grafos (Knowledge Graph)\\\",\\n    \\\"en\\\": \\\"Memory & Knowledge Graph\\\"\\n  },\\n  \\\"description\\\": {\\n    \\\"es\\\": \\\"Almacenamiento persistente de entidades, preferencias y contexto histórico estructurado en un grafo de conocimiento.\\\",\\n    \\\"en\\\": \\\"Persistent storage of entities, preferences, and historical context structured as a knowledge graph.\\\"\\n  },\\n  \\\"enabledByDefault\\\": false,\\n  \\\"transport\\\": \\\"stdio\\\",\\n  \\\"launch\\\": {\\n    \\\"executable\\\": \\\"${nodeExecutable}\\\",\\n    \\\"args\\\": [\\\"${serviceDir}/node_modules/@modelcontextprotocol/server-memory/dist/index.js\\\"],\\n    \\\"cwd\\\": \\\"${serviceDir}\\\",\\n    \\\"env\\\": {\\n      \\\"MEMORY_FILE_PATH\\\": \\\"${serviceDir}/memory.jsonl\\\"\\n    },\\n    \\\"handshakeTimeoutSeconds\\\": 30\\n  }\\n}\\n\\n\",\n  \"playwright/installer.json\": \"{\\n  \\\"schemaVersion\\\": 1,\\n  \\\"type\\\": \\\"npm\\\",\\n  \\\"product\\\": {\\n    \\\"package\\\": \\\"@playwright/mcp\\\",\\n    \\\"version\\\": \\\"0.0.81\\\",\\n    \\\"browser\\\": \\\"chromium\\\"\\n  },\\n  \\\"requirements\\\": {\\n    \\\"node\\\": {\\n      \\\"minimumMajor\\\": 18\\n    }\\n  }\\n}\\n\",\n  \"playwright/service.json\": \"{\\n  \\\"schemaVersion\\\": 1,\\n  \\\"id\\\": \\\"playwright\\\",\\n  \\\"displayName\\\": {\\n    \\\"es\\\": \\\"Playwright MCP\\\",\\n    \\\"en\\\": \\\"Playwright MCP\\\"\\n  },\\n  \\\"description\\\": {\\n    \\\"es\\\": \\\"Automatización de navegador mediante el servidor MCP oficial de Playwright.\\\",\\n    \\\"en\\\": \\\"Browser automation through the official Playwright MCP server.\\\"\\n  },\\n  \\\"enabledByDefault\\\": false,\\n  \\\"transport\\\": \\\"stdio\\\",\\n  \\\"launch\\\": {\\n    \\\"executable\\\": \\\"${nodeExecutable}\\\",\\n    \\\"args\\\": [\\\"${serviceDir}/node_modules/@playwright/mcp/cli.js\\\", \\\"--browser=chromium\\\"],\\n    \\\"cwd\\\": \\\"${serviceDir}\\\",\\n    \\\"env\\\": {},\\n    \\\"handshakeTimeoutSeconds\\\": 30,\\n    \\\"callTimeoutSeconds\\\": 120\\n  },\\n  \\\"options\\\": [\\n    {\\n      \\\"id\\\": \\\"headless\\\",\\n      \\\"type\\\": \\\"boolean\\\",\\n      \\\"label\\\": {\\n        \\\"es\\\": \\\"Navegación en segundo plano (Headless)\\\",\\n        \\\"en\\\": \\\"Headless background mode\\\"\\n      },\\n      \\\"description\\\": {\\n        \\\"es\\\": \\\"Desactívalo para ver la ventana del navegador durante la automatización\\\",\\n        \\\"en\\\": \\\"Disable to display the browser window during automation\\\"\\n      },\\n      \\\"default\\\": true,\\n      \\\"argsWhenTrue\\\": [\\\"--headless\\\"],\\n      \\\"argsWhenFalse\\\": []\\n    }\\n  ]\\n}\\n\\n\"\n}")


def materialize_managed_services(services_root: Path | None = None) -> None:
    """Installs the managed service files without deleting user data or services."""
    root = Path(services_root) if services_root else get_data_dir() / "services"
    for relative_path, content in MANAGED_SERVICE_FILES.items():
        destination = root / relative_path
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(content, encoding="utf-8")
        if relative_path.startswith("scripts/"):
            destination.chmod(0o755)
# ==============================================================================
# Herramientas Locales Core
# ==============================================================================

MAX_HTTP_BODY_BYTES = 1024 * 1024
MAX_PATH_LENGTH = 4096
MAX_COMMAND_LENGTH = 16384
BROWSER_ACTIONS = ("navigate", "screenshot", "click", "fill")


def _tool_error(message: str, **extra) -> str:
    """Serializa el resultado de error común de las herramientas locales."""
    return json.dumps({"success": False, "error": message, **extra}, ensure_ascii=False)


def _atomic_write_text(target: Path, text: str):
    """Sustituye el archivo de una vez para no dejarlo a medias si la escritura falla."""
    temp_path = target.with_suffix(target.suffix + f".tmp_{os.getpid()}_{time.time_ns()}")
    with open(temp_path, "w", encoding="utf-8") as f:
        f.write(text)
    temp_path.replace(target)


IGNORED_WORKSPACE_DIRS = {
    ".git", ".venv", "venv", "node_modules", "__pycache__",
    ".pytest_cache", ".cache", ".gemini", "dist", "build"
}


def list_directory(path: str = ".", recursive: bool = False) -> str:
    """List files and directories in a local directory with safe bounded recursive traversal."""
    try:
        target = Path(path).expanduser().resolve()
        if not target.exists():
            return _tool_error(f"Path '{path}' does not exist.")
        if not target.is_dir():
            return _tool_error(f"Path '{path}' is not a directory.")

        max_depth = 3 if recursive else 1
        entries = []

        def _scan(current_path: Path, current_depth: int):
            if current_depth > max_depth or len(entries) >= 1000:
                return
            try:
                with os.scandir(current_path) as it:
                    items = list(it)
                    items.sort(key=lambda e: (not e.is_dir(follow_symlinks=False), e.name.lower()))
                    for entry in items:
                        if len(entries) >= 1000:
                            break
                        try:
                            stat = entry.stat(follow_symlinks=False)
                            is_dir = entry.is_dir(follow_symlinks=False)
                            try:
                                resolved_path = str(Path(entry.path).resolve())
                            except (OSError, RuntimeError):
                                resolved_path = str(Path(entry.path).absolute())
                            entry_data = {
                                "name": entry.name,
                                "path": resolved_path,
                                "type": "directory" if is_dir else "file",
                                "size_bytes": None if is_dir else stat.st_size,
                                "is_symlink": entry.is_symlink()
                            }
                            if recursive:
                                try:
                                    entry_data["relative_path"] = str(Path(entry.path).relative_to(target))
                                except ValueError:
                                    entry_data["relative_path"] = entry.name
                            entries.append(entry_data)
                            if recursive and is_dir and not entry.is_symlink():
                                _scan(Path(entry.path), current_depth + 1)
                        except (PermissionError, FileNotFoundError, OSError):
                            continue
            except (PermissionError, FileNotFoundError, OSError):
                pass

        _scan(target, 1)

        return json.dumps({
            "success": True,
            "path": str(target),
            "recursive": bool(recursive),
            "total_items": len(entries),
            "entries": entries
        }, ensure_ascii=False, indent=2)
    except Exception as e:
        return _tool_error(str(e))


def read_file(path: str, start_line: int = 1, end_line: int = None, max_lines: int = 500, max_bytes: int = 100000) -> str:
    """Read text content from a local file in streaming mode with safe ranges and bounds."""
    try:
        target = Path(path).expanduser().resolve()
        if not target.exists():
            return _tool_error(f"File '{path}' does not exist.")
        if not target.is_file():
            return _tool_error(f"Path '{path}' is not a regular file.")

        file_size = target.stat().st_size
        safe_max_bytes = max(1024, min(int(max_bytes), 2000000))
        safe_start_line = max(1, int(start_line))

        if end_line is not None:
            safe_end_line = max(safe_start_line, int(end_line))
            target_line_count = min(safe_end_line - safe_start_line + 1, 2000)
            safe_end_line = safe_start_line + target_line_count - 1
        else:
            safe_end_line = None
            target_line_count = max(1, min(int(max_lines), 2000))

        selected_lines = []
        current_bytes = 0
        truncated_bytes = False
        total_lines = 0
        reached_end_bound = False

        with open(target, "r", encoding="utf-8", errors="replace") as f:
            for line_no, line in enumerate(f, 1):
                total_lines = line_no
                if line_no < safe_start_line:
                    continue
                if safe_end_line is not None and line_no > safe_end_line:
                    reached_end_bound = True
                    if line_no > safe_start_line + 50000:
                        break
                    continue
                if safe_end_line is None and len(selected_lines) >= target_line_count:
                    reached_end_bound = True
                    if line_no > safe_start_line + 50000:
                        break
                    continue

                if not reached_end_bound:
                    line_bytes = len(line.encode("utf-8"))
                    if current_bytes + line_bytes > safe_max_bytes:
                        remaining_budget = max(0, safe_max_bytes - current_bytes)
                        if remaining_budget > 0:
                            encoded = line.encode("utf-8")[:remaining_budget]
                            selected_lines.append(encoded.decode("utf-8", errors="ignore"))
                        truncated_bytes = True
                        reached_end_bound = True
                        break
                    else:
                        selected_lines.append(line)
                        current_bytes += line_bytes

        content = "".join(selected_lines)
        last_returned_line = safe_start_line + len(selected_lines) - 1 if selected_lines else safe_start_line - 1

        is_truncated = truncated_bytes or (safe_end_line is not None and safe_end_line < total_lines) or (safe_end_line is None and (safe_start_line + target_line_count - 1) < total_lines)

        return json.dumps({
            "success": True,
            "path": str(target),
            "size_bytes": file_size,
            "total_lines": total_lines,
            "start_line": safe_start_line,
            "end_line": last_returned_line,
            "lines_returned": len(selected_lines),
            "truncated": is_truncated,
            "content": content
        }, ensure_ascii=False, indent=2)
    except Exception as e:
        return _tool_error(str(e))


def write_file(path: str, content: str) -> str:
    """Create or overwrite a file completely and atomically."""
    try:
        target = Path(path).expanduser().resolve()
        target.parent.mkdir(parents=True, exist_ok=True)
        _atomic_write_text(target, content)
        bytes_written = len(content.encode("utf-8"))
        return json.dumps({
            "success": True,
            "path": str(target),
            "bytes_written": bytes_written
        }, ensure_ascii=False, indent=2)
    except Exception as e:
        return _tool_error(str(e))


def edit_file(path: str, old_str: str, new_str: str, replace_all: bool = False) -> str:
    """Replace old_str with new_str in an existing file: its single occurrence, or all of them with replace_all."""
    try:
        target = Path(path).expanduser().resolve()
        if not target.exists():
            return _tool_error(f"File '{path}' does not exist. Use read_file to verify existing paths.")
        if not target.is_file():
            return _tool_error(f"Path '{path}' is not a regular file.")

        with open(target, "r", encoding="utf-8", errors="replace") as f:
            file_text = f.read()

        if not old_str:
            return _tool_error("old_str is empty. Provide the exact text to replace.")
        occurrences = file_text.count(old_str)
        if occurrences == 0:
            return _tool_error(f"Target text was not found in '{path}'. Check exact file content with read_file.")
        if occurrences > 1 and not replace_all:
            return _tool_error(f"Found {occurrences} matches for the snippet in '{path}'. Provide more surrounding context in old_str to ensure a unique match, or set replace_all to replace every match.")

        updated_text = file_text.replace(old_str, new_str) if replace_all else file_text.replace(old_str, new_str, 1)
        _atomic_write_text(target, updated_text)
        return json.dumps({
            "success": True,
            "path": str(target),
            "bytes_written": len(updated_text.encode("utf-8")),
            "replacements": occurrences if replace_all else 1
        }, ensure_ascii=False, indent=2)
    except Exception as e:
        return _tool_error(str(e))


def set_project_directory(path) -> dict:
    """Cambia el directorio del proyecto: el del proceso, base de las rutas relativas y de los comandos."""
    if not isinstance(path, str) or not path.strip():
        raise ValueError("La ruta del directorio está vacía.")
    if len(path) > MAX_PATH_LENGTH:
        raise ValueError("La ruta del directorio excede el tamaño máximo permitido.")
    target = Path(path.strip()).expanduser().resolve()
    if not target.is_dir():
        raise ValueError(f"'{path}' no existe o no es un directorio.")
    previous = str(Path.cwd().resolve())
    # Los comandos en marcha conservan el directorio en que se lanzaron.
    os.chdir(target)
    return {"cwd": str(target), "previous_cwd": previous}


def _configured_gui_diff_tool(git_bin: str, repo_root: Path) -> str:
    """Herramienta gráfica que usaría `git difftool --gui`, o '' si no hay ninguna configurada.

    Sin diff.guitool ni merge.guitool, git recurre a diff.tool o adivina una, que puede ser de
    terminal (vimdiff): lanzada sin terminal quedaría invisible y colgada.
    """
    for key in ("diff.guitool", "merge.guitool"):
        res = subprocess.run(
            [git_bin, "config", "--get", key],
            cwd=str(repo_root),
            capture_output=True,
            text=True,
            timeout=5,
            check=False
        )
        if res.returncode == 0 and res.stdout.strip():
            return res.stdout.strip()
    return ""


def open_file_diff(path: str, commit_fallback: bool = False) -> dict:
    """Abre un visor externo de diffs (git difftool) para comparar el fichero actual frente a Git HEAD, su último commit o fichero vacío."""
    if not isinstance(path, str) or not path.strip():
        raise ValueError("La ruta del archivo está vacía.")
    if len(path) > MAX_PATH_LENGTH:
        raise ValueError("La ruta del archivo excede el tamaño máximo permitido.")

    target = Path(path.strip()).expanduser().resolve()
    if not target.exists():
        raise ValueError(f"El archivo '{path}' no existe.")
    if not target.is_file():
        raise ValueError(f"'{path}' no es un archivo regular.")

    git_bin = shutil.which("git")
    if not git_bin:
        raise RuntimeError("Git no está instalado o no se encuentra en el PATH del sistema.")

    try:
        res = subprocess.run(
            [git_bin, "rev-parse", "--show-toplevel"],
            cwd=str(target.parent),
            capture_output=True,
            text=True,
            timeout=5,
            check=False
        )
    except Exception as err:
        raise RuntimeError(f"Error comprobando repositorio Git: {err}")

    if res.returncode != 0:
        raise ValueError(f"El archivo '{target.name}' no pertenece a ningún repositorio Git.")

    repo_root = Path(res.stdout.strip()).resolve()
    if not _configured_gui_diff_tool(git_bin, repo_root):
        raise ValueError(
            "No hay un visor gráfico de diffs configurado en Git. Configura uno, por ejemplo: "
            "git config --global diff.guitool meld"
        )

    has_head = subprocess.run(
        [git_bin, "rev-parse", "--verify", "HEAD"],
        cwd=str(repo_root),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=5,
        check=False
    ).returncode == 0

    in_head = False
    has_working_tree_diff = True
    if has_head:
        try:
            rel_path = target.relative_to(repo_root).as_posix()
            in_head = subprocess.run(
                [git_bin, "cat-file", "-e", f"HEAD:{rel_path}"],
                cwd=str(repo_root),
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=5,
                check=False
            ).returncode == 0
            if in_head:
                diff_check = subprocess.run(
                    [git_bin, "diff", "--quiet", "HEAD", "--", str(target)],
                    cwd=str(repo_root),
                    timeout=5,
                    check=False
                )
                has_working_tree_diff = (diff_check.returncode != 0)
        except ValueError:
            in_head = False

    cmd = [git_bin, "difftool", "--no-prompt", "--gui"]

    mode = "working_tree"
    last_commit = ""
    if has_working_tree_diff:
        if in_head:
            cmd.extend(["HEAD", "--", str(target)])
        else:
            cmd.extend(["--no-index", "--", os.devnull, str(target)])
    else:
        # No hay cambios pendientes en el árbol de trabajo. Comprobar historial del archivo.
        rel_path = target.relative_to(repo_root).as_posix()
        log_res = subprocess.run(
            [git_bin, "log", "-n", "1", "--format=%H", "--", rel_path],
            cwd=str(repo_root),
            capture_output=True,
            text=True,
            timeout=5,
            check=False
        )
        last_commit = log_res.stdout.strip() if log_res.returncode == 0 else ""
        if not commit_fallback or not last_commit:
            return {
                "success": True,
                "has_diff": False,
                "in_head": in_head,
                "has_commit_history": bool(last_commit),
                "last_commit": last_commit or None,
                "path": str(target)
            }

        mode = "commit"
        parent_check = subprocess.run(
            [git_bin, "rev-parse", "--verify", f"{last_commit}~1"],
            cwd=str(repo_root),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=5,
            check=False
        )
        if parent_check.returncode == 0:
            cmd.extend([f"{last_commit}~1", last_commit, "--", str(target)])
        else:
            cmd.extend(["4b825dc642cb6eb9a060e54bf8d69288fbee4904", last_commit, "--", str(target)])

    popen_kwargs = {
        "cwd": str(repo_root),
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
    }
    if os.name == "nt":
        popen_kwargs["creationflags"] = (
            getattr(subprocess, "DETACHED_PROCESS", 0) |
            getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        )
    else:
        popen_kwargs["start_new_session"] = True

    proc = subprocess.Popen(cmd, **popen_kwargs)
    return {
        "success": True,
        "has_diff": True,
        "mode": mode,
        "pid": proc.pid,
        "path": str(target),
        "in_head": in_head,
        "commit": last_commit or None
    }


def search_files(query: str, path: str = ".", file_pattern: str = None, max_results: int = 100) -> str:
    """Recursively search for plain text or regular expressions across project files."""
    try:
        target = Path(path).expanduser().resolve()
        if not target.exists():
            return _tool_error(f"Path '{path}' does not exist.")
        if not target.is_dir():
            return _tool_error(f"Path '{path}' is not a directory.")

        warning = None
        try:
            regex = re.compile(query, re.MULTILINE)
        except re.error as err:
            warning = f"Query '{query}' is not a valid regular expression ({err}); treated as literal text."
            regex = re.compile(re.escape(query), re.MULTILINE)

        try:
            safe_max_results = max(1, min(int(max_results), 500))
        except (TypeError, ValueError):
            safe_max_results = 100

        matches = []
        files_searched = 0
        max_file_size = 2 * 1024 * 1024
        truncated = False

        for root, dirs, files in os.walk(target):
            dirs[:] = [d for d in dirs if d not in IGNORED_WORKSPACE_DIRS and not d.startswith(".")]

            for fname in sorted(files):
                if file_pattern and not fnmatch.fnmatch(fname, file_pattern):
                    continue

                fpath = Path(root) / fname
                try:
                    if fpath.is_symlink():
                        try:
                            if not fpath.resolve().is_relative_to(target):
                                continue
                        except (OSError, ValueError):
                            continue
                    stat = fpath.stat()
                    if stat.st_size > max_file_size:
                        continue
                except OSError:
                    continue

                files_searched += 1
                try:
                    with open(fpath, "r", encoding="utf-8", errors="ignore") as f:
                        for line_idx, line in enumerate(f, 1):
                            if regex.search(line):
                                try:
                                    rel_path = str(fpath.relative_to(target))
                                except ValueError:
                                    rel_path = str(fpath)
                                matches.append({
                                    "file": str(fpath),
                                    "relative_path": rel_path,
                                    "line_number": line_idx,
                                    "content": line.rstrip("\r\n")[:300]
                                })
                                if len(matches) >= safe_max_results:
                                    truncated = True
                                    break
                except (PermissionError, OSError):
                    continue

                if truncated:
                    break
            if truncated:
                break

        payload = {
            "success": True,
            "path": str(target),
            "query": query,
            "file_pattern": file_pattern,
            "files_searched": files_searched,
            "total_matches": len(matches),
            "truncated": truncated,
            "matches": matches
        }
        if warning:
            payload["warning"] = warning

        return json.dumps(payload, ensure_ascii=False, indent=2)
    except Exception as e:
        return _tool_error(str(e))


def get_diagnostics(path: str | None = None) -> str:
    """Retrieve syntax diagnostics and code errors for a file or the entire workspace."""
    try:
        if path is not None and str(path).strip():
            target = Path(str(path).strip()).expanduser().resolve()
        else:
            target = Path.cwd().resolve()

        if not target.exists():
            return _tool_error(f"Path '{path}' does not exist.")

        diagnostics: list[dict] = []
        files_checked = 0

        def check_single_file(fpath: Path) -> list[dict]:
            ext = fpath.suffix.lower()
            file_diags: list[dict] = []
            try:
                rel_display = str(fpath.relative_to(Path.cwd()))
            except ValueError:
                rel_display = str(fpath)

            if ext == ".py":
                try:
                    content = fpath.read_text(encoding="utf-8", errors="replace")
                    compile(content, str(fpath), "exec")
                except (SyntaxError, IndentationError) as e:
                    file_diags.append({
                        "file": rel_display,
                        "line": e.lineno or 1,
                        "column": e.offset or 1,
                        "severity": "error",
                        "message": f"SyntaxError: {e.msg}"
                    })
            elif ext in (".js", ".mjs", ".cjs"):
                node_bin = shutil.which("node")
                if node_bin:
                    try:
                        res = subprocess.run([node_bin, "--check", str(fpath)], capture_output=True, text=True, timeout=10)
                        if res.returncode != 0:
                            stderr = res.stderr or ""
                            line_match = re.search(r':(\d+)\n([^\n]+)\n(\s*)\^', stderr)
                            line = int(line_match.group(1)) if line_match else 1
                            col = len(line_match.group(3)) + 1 if line_match else 1
                            msg_match = re.search(r'(SyntaxError:[^\n]+)', stderr)
                            msg = msg_match.group(1) if msg_match else (stderr.strip().splitlines()[-1] if stderr.strip() else "Syntax error")
                            file_diags.append({
                                "file": rel_display,
                                "line": line,
                                "column": col,
                                "severity": "error",
                                "message": msg
                            })
                    except (subprocess.SubprocessError, OSError):
                        pass
            elif ext == ".json":
                try:
                    content = fpath.read_text(encoding="utf-8", errors="replace")
                    json.loads(content)
                except json.JSONDecodeError as e:
                    file_diags.append({
                        "file": rel_display,
                        "line": e.lineno,
                        "column": e.colno,
                        "severity": "error",
                        "message": f"JSONDecodeError: {e.msg}"
                    })
            return file_diags

        if target.is_file():
            files_checked = 1
            diagnostics.extend(check_single_file(target))
        else:
            max_scan = 200
            for root, dirs, files in os.walk(target):
                dirs[:] = [d for d in dirs if d not in IGNORED_WORKSPACE_DIRS and not d.startswith(".")]
                for fname in sorted(files):
                    fp = Path(root) / fname
                    try:
                        if fp.is_symlink():
                            try:
                                if not fp.resolve().is_relative_to(target):
                                    continue
                            except (OSError, ValueError):
                                continue
                    except OSError:
                        continue
                    if fp.suffix.lower() in (".py", ".js", ".mjs", ".cjs", ".json"):
                        files_checked += 1
                        diagnostics.extend(check_single_file(fp))
                        if files_checked >= max_scan:
                            break
                if files_checked >= max_scan:
                    break

        msg = f"Found {len(diagnostics)} issue(s)." if diagnostics else "No diagnostic issues found."

        return json.dumps({
            "success": True,
            "path": str(target),
            "files_checked": files_checked,
            "error_count": len(diagnostics),
            "diagnostics": diagnostics,
            "message": msg
        }, ensure_ascii=False, indent=2)
    except Exception as e:
        return _tool_error(str(e))


class PersistentBrowserSession:
    """Manages a persistent headless browser session (Playwright) for browser_action."""

    def __init__(self):
        self._lock = threading.Lock()
        self._process: subprocess.Popen | None = None
        atexit.register(self.close)

    def _ensure_running(self) -> subprocess.Popen:
        if self._process is not None and self._process.poll() is None:
            return self._process

        node = shutil.which("node")
        if not node:
            raise RuntimeError("Node.js is not installed or not found in system PATH.")

        runner_js = """
const readline = require('readline');
let playwright;
try {
  playwright = require('playwright');
} catch (e1) {
  try {
    const path = require('path');
    const home = process.env.HOME || process.env.USERPROFILE || '';
    playwright = require(path.join(home, 'zerochat', 'services', 'playwright', 'node_modules', 'playwright'));
  } catch (e2) {
    console.log(JSON.stringify({
      success: false,
      error: "Playwright is not available. Install it with 'npm install playwright' or enable the Playwright MCP service."
    }));
    process.exit(1);
  }
}

(async () => {
  let browser, context, page;
  try {
    const candidates = [
      {},                      // 1. Playwright bundled Chromium
      { channel: 'chrome' },   // 2. System Google Chrome
      { channel: 'msedge' },   // 3. System Microsoft Edge (Windows 10/11)
      { channel: 'chromium' }  // 4. System Chromium (/usr/bin/chromium)
    ];
    let lastErr = null;
    for (const cand of candidates) {
      try {
        browser = await playwright.chromium.launch({ ...cand, headless: true });
        if (browser) break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!browser) {
      throw lastErr || new Error('No Chromium-based browser found (Playwright, Chrome, Edge, or Chromium).');
    }
    context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    page = await context.newPage();
  } catch (err) {
    console.log(JSON.stringify({ success: false, error: 'Failed to start browser: ' + err.message }));
    process.exit(1);
  }

  console.log(JSON.stringify({ ready: true }));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let req;
    try {
      req = JSON.parse(line);
    } catch (e) {
      console.log(JSON.stringify({ success: false, error: 'Invalid command JSON' }));
      continue;
    }

    try {
      const act = req.action;
      if (act === 'navigate') {
        if (!req.url) throw new Error("Parameter 'url' is required for action 'navigate'");
        await page.goto(req.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        console.log(JSON.stringify({
          success: true,
          action: 'navigate',
          url: page.url(),
          title: await page.title()
        }));
      } else if (act === 'screenshot') {
        if (req.url && req.url !== page.url()) {
          await page.goto(req.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        }
        const buf = await page.screenshot({ fullPage: false });
        console.log(JSON.stringify({
          success: true,
          action: 'screenshot',
          image_base64: buf.toString('base64'),
          mime_type: 'image/png',
          url: page.url(),
          title: await page.title()
        }));
      } else if (act === 'click') {
        if (!req.selector) throw new Error("Parameter 'selector' is required for action 'click'");
        await page.click(req.selector, { timeout: 15000 });
        console.log(JSON.stringify({
          success: true,
          action: 'click',
          selector: req.selector,
          url: page.url()
        }));
      } else if (act === 'fill') {
        if (!req.selector) throw new Error("Parameter 'selector' is required for action 'fill'");
        await page.fill(req.selector, req.value || '', { timeout: 15000 });
        console.log(JSON.stringify({
          success: true,
          action: 'fill',
          selector: req.selector,
          value: req.value || '',
          url: page.url()
        }));
      } else if (act === 'close') {
        await browser.close();
        console.log(JSON.stringify({ success: true, action: 'close' }));
        process.exit(0);
      } else {
        console.log(JSON.stringify({ success: false, error: 'Unsupported action: ' + act }));
      }
    } catch (err) {
      console.log(JSON.stringify({ success: false, error: err.message, action: req.action }));
    }
  }
})();
"""
        proc = subprocess.Popen(
            [node, "-e", runner_js],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1
        )
        self._process = proc
        first_line = proc.stdout.readline()
        if not first_line:
            err = proc.stderr.read()
            self._process = None
            raise RuntimeError(f"Failed to initialize headless browser: {err or 'process terminated unexpectedly'}")
        data = json.loads(first_line)
        if not data.get("ready"):
            self._process = None
            raise RuntimeError(data.get("error", "Unknown error starting browser"))

        return proc

    def execute(self, command: dict) -> dict:
        with self._lock:
            try:
                proc = self._ensure_running()
            except Exception as e:
                return {"success": False, "error": str(e)}

            req_json = json.dumps(command, ensure_ascii=False) + "\n"
            try:
                proc.stdin.write(req_json)
                proc.stdin.flush()
                resp_line = proc.stdout.readline()
                if not resp_line:
                    self.close()
                    return {"success": False, "error": "Browser process closed unexpectedly."}
                return json.loads(resp_line)
            except Exception as e:
                self.close()
                return {"success": False, "error": f"Error executing browser action: {e}"}

    def close(self):
        with self._lock:
            if self._process is not None:
                try:
                    if self._process.poll() is None:
                        try:
                            self._process.stdin.write(json.dumps({"action": "close"}) + "\n")
                            self._process.stdin.flush()
                            self._process.wait(timeout=2)
                        except (OSError, subprocess.SubprocessError):
                            self._process.kill()
                except (OSError, subprocess.SubprocessError):
                    pass
                self._process = None


_BROWSER_SESSION = PersistentBrowserSession()


def browser_action_availability() -> dict:
    """Comprueba requisitos locales sin lanzar Node.js ni Chromium."""
    if not shutil.which("node"):
        return {"available": False, "error": "Node.js is not installed or not found in system PATH."}
    playwright_locations = (
        Path.cwd() / "node_modules" / "playwright",
        get_data_dir() / "services" / "playwright" / "node_modules" / "playwright"
    )
    if not any(location.is_dir() for location in playwright_locations):
        return {"available": False, "error": "Playwright is not available."}
    browser_commands = (
        "google-chrome", "google-chrome-stable", "chromium", "chromium-browser",
        "msedge", "msedge.exe", "chrome", "chrome.exe"
    )
    if sys.platform == "darwin":
        playwright_cache = Path.home() / "Library" / "Caches" / "ms-playwright"
    elif sys.platform.startswith("win"):
        playwright_cache = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local")) / "ms-playwright"
    else:
        playwright_cache = Path.home() / ".cache" / "ms-playwright"
    try:
        has_playwright_browser = playwright_cache.is_dir() and any(
            child.is_dir() and child.name.startswith("chromium")
            for child in playwright_cache.iterdir()
        )
    except OSError:
        has_playwright_browser = False
    if has_playwright_browser or any(shutil.which(command) for command in browser_commands):
        return {"available": True}
    return {"available": False, "error": "Playwright Chromium is not installed."}


def browser_action(action: str, url: str | None = None, selector: str | None = None, value: str | None = None) -> str:
    """Control a headless browser for UI testing and visual inspection."""
    try:
        act = (action or "").strip().lower()
        if act not in BROWSER_ACTIONS:
            return _tool_error(f"Invalid browser action: '{action}'. Valid actions: {', '.join(BROWSER_ACTIONS)}.")

        cmd = {"action": act}
        if url:
            cmd["url"] = str(url).strip()
        if selector:
            cmd["selector"] = str(selector).strip()
        if value is not None:
            cmd["value"] = str(value)

        result = _BROWSER_SESSION.execute(cmd)
        return json.dumps(result, ensure_ascii=False, indent=2)
    except Exception as e:
        return _tool_error(str(e))


LOCAL_TOOLS_DEFINITIONS = [
    {
        "name": "list_directory",
        "description": "List files and directories in a local directory with safe bounded recursive traversal.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "maxLength": MAX_PATH_LENGTH, "description": "Relative or absolute directory path (defaults to '.')"},
                "recursive": {"type": "boolean", "description": "If true, traverses subdirectories up to depth 3", "default": False}
            }
        }
    },
    {
        "name": "read_file",
        "description": "Read a text file, whole or by line range.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "maxLength": MAX_PATH_LENGTH, "description": "File path"},
                "start_line": {"type": "integer", "description": "First line (1-based)", "default": 1},
                "end_line": {"type": "integer", "description": "Last line (inclusive)"},
                "max_lines": {"type": "integer", "description": "Line cap if no end_line", "default": 500},
                "max_bytes": {"type": "integer", "description": "Byte cap", "default": 100000}
            },
            "required": ["path"]
        }
    },
    {
        "name": "write_file",
        "description": "Create or overwrite a file completely and atomically.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "maxLength": MAX_PATH_LENGTH, "description": "Path to the file to write"},
                "content": {"type": "string", "maxLength": MAX_HTTP_BODY_BYTES, "description": "Full content of the file"}
            },
            "required": ["path", "content"]
        }
    },
    {
        "name": "edit_file",
        "description": (
            "Replace old_str with new_str in an existing file. "
            "For several changes, in this file or in others, emit several edit_file calls in the same response; "
            "they are applied in order, each one on the result of the previous one."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "maxLength": MAX_PATH_LENGTH, "description": "File path"},
                "old_str": {"type": "string", "maxLength": MAX_HTTP_BODY_BYTES, "description": "Exact text to replace; must occur once unless replace_all is true"},
                "new_str": {"type": "string", "maxLength": MAX_HTTP_BODY_BYTES, "description": "Replacement text"},
                "replace_all": {"type": "boolean", "description": "Replace every occurrence of old_str (e.g. to rename an identifier)", "default": False}
            },
            "required": ["path", "old_str", "new_str"]
        }
    },
    {
        "name": "search_files",
        "description": "Recursively search for plain text or regular expressions across project files.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "maxLength": 4096, "description": "Plain text string or regular expression to search for"},
                "path": {"type": "string", "maxLength": MAX_PATH_LENGTH, "description": "Base search directory (defaults to '.')", "default": "."},
                "file_pattern": {"type": "string", "maxLength": 256, "description": "Optional glob filter (e.g. *.js, *.py)"},
                "max_results": {"type": "integer", "description": "Maximum number of matching lines to return (default 100, max 500)", "default": 100}
            },
            "required": ["query"]
        }
    },
    {
        "name": "run_command",
        "description": (
            "Run a PowerShell command in the project directory and return its exit code and output (stdout and stderr combined). "
            "Each call starts a fresh PowerShell in the project directory: Set-Location and $env: changes do not carry over to later calls, "
            "so chain them with ; in the same command. "
            if DETECTED_OS == "windows"
            else
            "Run a shell command (bash) in the project directory and return its exit code and output (stdout and stderr combined). "
            "Each call starts a fresh shell in the project directory: cd, export or source/activate do not carry over to later calls, "
            "so chain them with && in the same command. "
        ) + (
            "By default it waits up to timeout_seconds and kills the command if it has not finished. "
            "Use background=true for servers, watchers or anything that does not finish on its own; "
            f"then follow or stop it with check_command. Host OS: {DETECTED_OS}."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "maxLength": MAX_COMMAND_LENGTH,
                    "description": (
                        "PowerShell command to run (e.g. git status; npm test)"
                        if DETECTED_OS == "windows"
                        else "Shell command to run (e.g. git status, npm test)"
                    )
                },
                "timeout_seconds": {"type": "integer", "description": f"Seconds to wait before killing the command (default {COMMAND_DEFAULT_TIMEOUT}, max {COMMAND_MAX_TIMEOUT}). Ignored with background=true.", "default": COMMAND_DEFAULT_TIMEOUT},
                "background": {"type": "boolean", "description": "Return after a few seconds and keep the command running; returns a job_id for check_command.", "default": False}
            },
            "required": ["command"]
        }
    },
    {
        "name": "check_command",
        "description": "Check a command started by run_command: returns its status and the output produced since the last check. Use wait_seconds to wait for it to finish, or stop=true to terminate it.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "job_id": {"type": "integer", "description": "job_id returned by run_command"},
                "wait_seconds": {"type": "integer", "description": f"Seconds to wait for the command to finish before returning (default 0, max {COMMAND_MAX_WAIT})", "default": 0},
                "stop": {"type": "boolean", "description": "Terminate the command and its child processes", "default": False}
            },
            "required": ["job_id"]
        }
    },
    {
        "name": "get_diagnostics",
        "description": "Retrieve syntax diagnostics and code errors for a file or the entire workspace.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "maxLength": MAX_PATH_LENGTH, "description": "Path to the file or directory to inspect (defaults to '.')"}
            }
        }
    },
    {
        "name": "browser_action",
        "description": "Control a headless browser (Playwright) for web navigation, UI testing, and visual inspection via screenshots.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": list(BROWSER_ACTIONS),
                    "maxLength": 32,
                    "description": "Action to perform in the browser"
                },
                "url": {"type": "string", "maxLength": 4096, "description": "Target URL for navigate or screenshot"},
                "selector": {"type": "string", "maxLength": 1024, "description": "CSS selector for click or fill actions"},
                "value": {"type": "string", "maxLength": MAX_HTTP_BODY_BYTES, "description": "Text value to type for fill action"}
            },
            "required": ["action"]
        }
    }
]

LOCAL_TOOL_HANDLERS = {
    "list_directory": list_directory,
    "read_file": read_file,
    "write_file": write_file,
    "edit_file": edit_file,
    "run_command": run_command,
    "check_command": check_command,
    "search_files": search_files,
    "get_diagnostics": get_diagnostics,
    "browser_action": browser_action
}
# ==============================================================================
# Servidor HTTP JSON-RPC 2.0 y SSE con Autenticación por Token
# ==============================================================================

MAX_RPC_METHOD_LENGTH = 128
MAX_TOOL_NAME_LENGTH = 128
# Un mensaje MCP admite imágenes en base64, pero no puede agotar la memoria del backend.
MAX_MCP_MESSAGE_CHARS = 16 * 1024 * 1024
MAX_MCP_STDERR_LINE_CHARS = 64 * 1024
DEFAULT_MCP_CALL_TIMEOUT_SECONDS = 30


def validate_local_tool_arguments(tool_name: str, arguments: dict) -> str | None:
    """Valida tipos y límites de las herramientas locales a partir de su definición canónica."""
    definition = next((item for item in LOCAL_TOOLS_DEFINITIONS if item["name"] == tool_name), None)
    if definition is None:
        return None

    schema = definition.get("inputSchema", {})
    properties = schema.get("properties", {})
    type_map = {"string": str, "integer": int, "boolean": bool}

    for name, value in arguments.items():
        prop = properties.get(name)
        if prop is None:
            return f"Argumento no permitido: {name}"
        expected_type_name = prop.get("type")
        expected_type = type_map.get(expected_type_name)
        if expected_type is bool:
            if not isinstance(value, bool):
                return f"Tipo inválido para '{name}'"
        else:
            if isinstance(value, bool) or not isinstance(value, expected_type):
                return f"Tipo inválido para '{name}'"
        max_length = prop.get("maxLength")
        if max_length is not None and len(value) > max_length:
            return f"'{name}' excede el tamaño máximo permitido"

    for name in schema.get("required", ()):
        if name not in arguments:
            return f"Falta el argumento obligatorio: {name}"

    if tool_name == "browser_action":
        if arguments.get("action") not in BROWSER_ACTIONS:
            return f"Acción de navegador no permitida: {arguments.get('action')}"

    return None

def sanitize_log_path(raw_path: str) -> str:
    """Oculta tokens de sesión o parámetros sensibles en la query string para logs seguros."""
    if not raw_path or "?" not in raw_path:
        return raw_path or "/"
    path, query = raw_path.split("?", 1)
    safe_query = re.sub(r'(token=)[^&]+', r'\1***', query, flags=re.IGNORECASE)
    return f"{path}?{safe_query}"


def format_log_error(msg: str, max_len: int = 160) -> str:
    """Limpia y trunca mensajes de error para mantener el log en una sola línea legible."""
    if not msg:
        return ""
    cleaned = " ".join(str(msg).strip().splitlines())
    if len(cleaned) > max_len:
        return cleaned[:max_len - 3] + "..."
    return cleaned


def is_allowed_origin(origin: str | None, require_origin: bool = False) -> bool:
    """Verifica si el origen CORS está autorizado."""
    if origin is None or origin == "null":
        return not require_origin
    origin_lower = origin.lower()
    if origin_lower == "https://albalday.github.io" or origin_lower.startswith("https://albalday.github.io/"):
        return True
    if origin_lower == "http://127.0.0.1" or origin_lower.startswith("http://127.0.0.1:"):
        return True
    if origin_lower == "http://localhost" or origin_lower.startswith("http://localhost:"):
        return True
    return False


def public_tool_name(server_id: str, original: str) -> str:
    """Codificación inyectiva de nombres de herramientas MCP idéntica a publicToolName en js/mcp.js."""
    def encode(value: str, tool: bool = False) -> str:
        if not isinstance(value, str) or not value or len(value) > 256:
            raise ValueError("Componente de nombre MCP no válido")
        # MCP function names preserve ASCII case, which keeps remote tool
        # names readable. The lowercase z opens every escape, so it is escaped too.
        return "".join(ch if ("a" <= ch <= "y" or "A" <= ch <= "Z" or "0" <= ch <= "9" or (tool and ch == "_"))
                       else f"z{ord(ch):x}z" for ch in value)
    name = f"{encode(server_id)}_{encode(original, True)}"
    if len(name) > 64:
        raise ValueError(f"El nombre público de la herramienta MCP excede 64 caracteres: {name}")
    return name


def _mcp_trace_text(value: object, max_len: int = 1000) -> str:
    """Normaliza diagnósticos MCP para consola sin exponer secretos comunes."""
    text = " ".join(str(value).strip().splitlines())
    text = re.sub(r"(?i)(\b(?:api[_-]?key|token|secret|password)\b\s*[=:]\s*)\S+", r"\1***", text)
    text = re.sub(r"(?i)(--(?:api[_-]?key|token|secret|password)\s+)\S+", r"\1***", text)
    text = re.sub(r"(?i)([?&](?:access_token|code|id_token|refresh_token|state)=)[^&\s]+", r"\1***", text)
    return text[:max_len - 3] + "..." if len(text) > max_len else text


def _read_bounded_line(stream, limit: int) -> tuple[str, str | None]:
    """Lee una línea de como mucho limit caracteres.

    Si la línea es más larga, consume y descarta el resto sin retenerlo en memoria y
    devuelve el comienzo junto con el último fragmento leído (para diagnóstico).
    """
    line = stream.readline(limit + 1)
    if len(line) <= limit or line.endswith("\n"):
        return line, None
    tail = line
    while True:
        chunk = stream.readline(limit)
        if not chunk:
            break
        tail = chunk
        if chunk.endswith("\n"):
            break
    return line[:limit], tail


def _positive_seconds(value, default: float) -> float:
    """Normaliza un plazo en segundos declarado en service.json."""
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value <= 0:
        return default
    return float(value)


class StdioMcpClient:
    max_message_chars = MAX_MCP_MESSAGE_CHARS

    def __init__(self, command: str, args: list[str], cwd: str, env: dict[str, str], trace=None,
                 call_timeout: float = DEFAULT_MCP_CALL_TIMEOUT_SECONDS):
        self.command = command
        self.args = args
        self.cwd = cwd
        self.env = env
        self.call_timeout = call_timeout
        self.process: subprocess.Popen | None = None
        self._pending: dict[int, queue.Queue] = {}
        self._next = 0
        self._lock = threading.Lock()
        # Escribir en stdin puede bloquear si el hijo no lee: nunca con _lock tomado,
        # porque el lector de stdout lo necesita para entregar respuestas.
        self._write_lock = threading.Lock()
        self._alive = False
        self.tools: list[dict] = []
        self.oauth_url: str | None = None
        self._trace = trace or (lambda _message: None)

    def running(self) -> bool:
        return self._alive and self.process is not None and self.process.poll() is None

    def start(self, handshake_timeout: int = 30):
        cmd = [self.command] + self.args
        self._trace(f"launching: {_mcp_trace_text(' '.join(cmd))}")
        self.process = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=self.cwd,
            env=self.env,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            # Grupo propio para terminar también npm, node o navegadores lanzados por el MCP.
            start_new_session=DETECTED_OS != "windows" and hasattr(os, "setsid")
        )
        self._alive = True
        threading.Thread(target=self._drain_stderr, daemon=True).start()
        threading.Thread(target=self._read_stdout, daemon=True).start()

        self.request("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "zerochat", "version": VERSION}
        }, timeout=handshake_timeout)
        self.notify("notifications/initialized")
        tools_resp = self.request("tools/list", {}, timeout=10)
        self.tools = tools_resp.get("tools", [])
        self.oauth_url = None  # OAuth completado si llegamos aquí
        self._trace(f"handshake completed; {len(self.tools)} tool(s) available")

    # Patrón que mcp-remote imprime justo antes de la URL OAuth:
    # "Please authorize this client by visiting:\n<url>"
    _OAUTH_URL_RE = re.compile(r'https?://\S{20,}', re.IGNORECASE)
    _OAUTH_HINT_RE = re.compile(r'visiting|authorize|authorization', re.IGNORECASE)

    def _drain_stderr(self):
        if not self.process or not self.process.stderr:
            return
        pending_oauth = False
        stderr = self.process.stderr
        while True:
            raw_line, _ = _read_bounded_line(stderr, MAX_MCP_STDERR_LINE_CHARS)
            if not raw_line:
                break
            line = _mcp_trace_text(raw_line)
            if not line:
                continue
            self._trace(f"stderr: {line}")
            # Detectar la URL OAuth en el flujo de stderr de mcp-remote.
            # La secuencia típica es: "visiting:\n<url>" en líneas consecutivas.
            if self._OAUTH_HINT_RE.search(line):
                pending_oauth = True
            if pending_oauth:
                m = self._OAUTH_URL_RE.search(line)
                if m:
                    url = m.group(0).rstrip('.,;)')
                    self.oauth_url = url
                    self._trace(f"oauth_url detected for frontend: {_mcp_trace_text(url)}")
                    pending_oauth = False



    def _read_stdout(self):
        try:
            if not self.process or not self.process.stdout:
                return
            stdout = self.process.stdout
            while True:
                line, tail = _read_bounded_line(stdout, self.max_message_chars)
                if not line:
                    break
                if tail is not None:
                    self._reject_oversized(line, tail)
                    continue
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    continue
                req_id = msg.get("id")
                if req_id is not None:
                    with self._lock:
                        waiter = self._pending.pop(req_id, None)
                    if waiter:
                        waiter.put(msg)
        finally:
            self._alive = False
            if self.process:
                return_code = self.process.poll()
                if return_code is not None:
                    self._trace(f"process exited with code {return_code}")
            with self._lock:
                pending = list(self._pending.values())
                self._pending.clear()
            for waiter in pending:
                waiter.put({"error": {"message": "MCP process ended unexpectedly"}})

    _HEAD_ID_RE = re.compile(r'^\s*\{\s*"jsonrpc"\s*:\s*"2\.0"\s*,\s*"id"\s*:\s*(\d+)')
    _TAIL_ID_RE = re.compile(r'"id"\s*:\s*(\d+)\s*\}\s*$')

    def _reject_oversized(self, head: str, tail: str):
        """Responde con error a la petición cuya respuesta supera el límite de tamaño."""
        message = f"MCP response exceeds {self.max_message_chars} characters"
        self._trace(f"discarded oversized message: {message}")
        match = self._HEAD_ID_RE.match(head) or self._TAIL_ID_RE.search(tail)
        with self._lock:
            if match:
                waiter = self._pending.pop(int(match.group(1)), None)
                waiters = [waiter] if waiter else []
            else:
                # Sin identificador no se sabe a quién pertenece: falla todo lo pendiente.
                waiters = list(self._pending.values())
                self._pending.clear()
        for waiter in waiters:
            waiter.put({"error": {"message": message}})

    def _write(self, payload: str):
        with self._write_lock:
            self.process.stdin.write(payload)
            self.process.stdin.flush()

    def request(self, method: str, params: dict, timeout: float = DEFAULT_MCP_CALL_TIMEOUT_SECONDS) -> dict:
        if not self.running():
            raise RuntimeError("MCP process is not running")
        with self._lock:
            self._next += 1
            req_id = self._next
            waiter = queue.Queue(maxsize=1)
            self._pending[req_id] = waiter
        payload = json.dumps({"jsonrpc": "2.0", "id": req_id, "method": method, "params": params}) + "\n"
        try:
            self._write(payload)
        except Exception as exc:
            self._alive = False
            with self._lock:
                self._pending.pop(req_id, None)
            raise RuntimeError(f"Failed writing to MCP process: {exc}") from exc
        try:
            response = waiter.get(timeout=timeout)
        except queue.Empty as exc:
            with self._lock:
                self._pending.pop(req_id, None)
            raise TimeoutError(f"MCP request timed out: {method}") from exc
        if response.get("error"):
            raise RuntimeError(str(response["error"].get("message", "MCP request failed")))
        return response.get("result", {})

    def notify(self, method: str):
        if self.running():
            try:
                self._write(json.dumps({"jsonrpc": "2.0", "method": method}) + "\n")
            except (OSError, ValueError):
                self._alive = False

    def _signal_group(self, sig) -> bool:
        """Envía la señal al grupo del MCP; devuelve False si no hay grupo propio."""
        if DETECTED_OS == "windows" or not hasattr(os, "killpg"):
            return False
        try:
            os.killpg(self.process.pid, sig)
        except ProcessLookupError:
            pass
        except OSError:
            return False
        return True

    def stop(self):
        self._alive = False
        if not self.process:
            return
        if DETECTED_OS == "windows":
            # Windows no tiene SIGKILL ni grupos POSIX: se elimina el árbol completo de una vez.
            _kill_process_tree(self.process)
            try:
                self.process.wait(timeout=2)
            except (OSError, subprocess.TimeoutExpired):
                pass
            self.process = None
            self.tools = []
            return
        try:
            if not self._signal_group(signal.SIGTERM):
                self.process.terminate()
            self.process.wait(timeout=2)
        except (OSError, subprocess.TimeoutExpired):
            pass
        # Los descendientes que sigan vivos se eliminan aunque el proceso principal ya terminara.
        if not self._signal_group(signal.SIGKILL):
            try:
                self.process.kill()
            except OSError:
                pass
        self.process = None
        self.tools = []


class McpServiceManager:
    def __init__(self, services_root: Path | None = None):
        if services_root:
            self.services_root = Path(services_root)
        else:
            self.services_root = get_data_dir() / "services"
        self.services_root.mkdir(parents=True, exist_ok=True)
        self.config_file = get_data_dir() / "config" / "services.json"
        self.config_file.parent.mkdir(parents=True, exist_ok=True)
        self.clients: dict[str, StdioMcpClient] = {}
        self.states: dict[str, str] = {}
        self.errors: dict[str, str] = {}
        self._lock = threading.Lock()
        materialize_managed_services(self.services_root)
        self.services = self._load_services()
        self.preferences = self._load_preferences()

    @staticmethod
    def _trace(server_id: str, message: str):
        log_event(f"[MCP {server_id}] {_mcp_trace_text(message)}")

    def _load_services(self) -> dict[str, dict]:
        servers = {}
        for directory in sorted(self.services_root.iterdir()):
            if not directory.is_dir():
                continue
            service_file = directory / "service.json"
            if not service_file.exists():
                continue
            try:
                server = json.loads(service_file.read_text(encoding="utf-8"))
                server_id = server.get("id") or directory.name.replace(".mcp", "")
                server["id"] = server_id
                server["_directory"] = directory
                servers[server_id] = server
            except (OSError, json.JSONDecodeError):
                continue
        return servers

    def _load_preferences(self) -> dict:
        if self.config_file.exists():
            try:
                return json.loads(self.config_file.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                return {}
        return {}

    def _save_preferences(self):
        try:
            tmp = self.config_file.with_suffix(".tmp")
            tmp.write_text(json.dumps(self.preferences, indent=2), encoding="utf-8")
            tmp.replace(self.config_file)
        except OSError as err:
            log_event(f"[zerochat] Advertencia al guardar preferencias MCP en {self.config_file}: {err}")

    def list_servers(self) -> list[dict]:
        self.services = self._load_services()
        result = []
        for server_id, server in self.services.items():
            client = self.clients.get(server_id)
            state = self.states.get(server_id, "stopped")
            running = bool(client and client.running() and state == "running")
            pref = self.preferences.get(server_id, {})
            result.append({
                "id": server_id,
                "displayName": server.get("displayName", {}),
                "description": server.get("description", {}),
                "help": server.get("help"),
                "remote": server.get("remote"),
                "enabled": pref.get("enabled", server.get("enabledByDefault", False)),
                "status": "running" if running else state,
                "toolCount": len(client.tools) if running else 0,
                "error": self.errors.get(server_id),
                "options": server.get("options", []),
                "userOptions": pref.get("options", {}),
                "oauthUrl": client.oauth_url if client else None,
            })

        return result


    def _expand(self, value: str, values: dict[str, str]) -> str:
        if not isinstance(value, str):
            raise ValueError("Invalid process argument")
        for key, replacement in values.items():
            value = value.replace("${" + key + "}", str(replacement))
        return value

    def _prepare_service(self, server_id: str, server: dict) -> dict[str, str]:
        service_dir = server["_directory"]
        installer_file = service_dir / "installer.json"
        node = shutil.which("node") or "node"
        npm = shutil.which("npm") or "npm"

        if installer_file.exists():
            self._trace(server_id, f"reading installer: {installer_file.name}")
            marker = service_dir / ".installed.json"
            try:
                installer = json.loads(installer_file.read_text(encoding="utf-8"))
            except Exception as e:
                raise RuntimeError(f"Error leyendo installer.json: {e}")
            kind = installer.get("type", "npm")
            if kind == "npm":
                product = installer.get("product", {})
                package = product.get("package")
                version = product.get("version")
                if not package or not version:
                    raise RuntimeError("El instalador npm debe definir package y version")
                if not shutil.which("node") or not shutil.which("npm"):
                    raise RuntimeError("Node.js y npm son necesarios para instalar este servicio MCP")

                self._check_node_requirement(server_id, installer, node)

                package_dir = service_dir / "node_modules" / Path(*package.split("/"))
                needs_install = not marker.exists() or not package_dir.is_dir()
                if not needs_install:
                    try:
                        installation = json.loads(marker.read_text(encoding="utf-8"))
                        if installation.get("package") != package or installation.get("version") != version:
                            needs_install = True
                    except (OSError, json.JSONDecodeError):
                        needs_install = True

                if needs_install:
                    self.states[server_id] = "installing"
                    self._trace(server_id, f"installing npm package: {package}@{version}")
                    manifest = service_dir / "package.json"
                    manifest.write_text(json.dumps({"private": True, "dependencies": {package: version}}, indent=2), encoding="utf-8")
                    res = subprocess.run([npm, "install", "--ignore-scripts", "--no-audit", "--no-fund"], cwd=service_dir, capture_output=True, text=True, timeout=600)
                    if res.returncode != 0:
                        raise RuntimeError(f"Fallo instalando dependencias npm: {res.stderr or res.stdout}")
                    self._trace(server_id, f"npm package installed: {package}@{version}")
                    installation = {"type": "npm", "package": package, "version": version, "nodeExecutable": node}
                    browser = product.get("browser")
                    if browser:
                        playwright_cli = service_dir / "node_modules" / "playwright" / "cli.js"
                        if not playwright_cli.is_file():
                            raise RuntimeError("No se encontró Playwright después de instalar el servicio MCP")
                        browser_result = subprocess.run(
                            [node, str(playwright_cli), "install", browser], cwd=service_dir,
                            capture_output=True, text=True, timeout=600
                        )
                        if browser_result.returncode != 0:
                            raise RuntimeError(
                                f"Fallo instalando el navegador {browser} de Playwright: "
                                f"{browser_result.stderr or browser_result.stdout}"
                            )
                        installation["browser"] = browser
                    marker.write_text(json.dumps(installation, indent=2), encoding="utf-8")
                else:
                    self._trace(server_id, f"npm package already installed: {package}@{version}")

        venv_python = get_venv_python(get_venv_dir())
        return {
            "serviceDir": str(service_dir),
            "pythonExecutable": str(venv_python) if venv_python.is_file() else sys.executable,
            "nodeExecutable": node
        }

    def _check_node_requirement(self, server_id: str, installer: dict, node: str):
        """Comprueba la versión mínima de Node.js que declara el instalador."""
        node_requirement = installer.get("requirements", {}).get("node")
        if node_requirement is None:
            # Compatibilidad con instaladores creados antes de requirements.node.
            required_node_major = int(installer.get("product", {}).get("nodeMajor", 18))
        elif not isinstance(node_requirement, dict):
            raise RuntimeError("El requisito Node.js debe ser un objeto en installer.json")
        else:
            required_node_major = node_requirement.get("minimumMajor")
            if not isinstance(required_node_major, int) or isinstance(required_node_major, bool) or required_node_major < 1:
                raise RuntimeError("El requisito Node.js debe definir minimumMajor como un entero positivo")
        version_result = subprocess.run(
            [node, "--version"], capture_output=True, text=True, timeout=5
        )
        detected = version_result.stdout.strip()
        version_match = re.match(r"v(\d+)", detected)
        if version_result.returncode != 0 or not version_match:
            raise RuntimeError("No se pudo comprobar la versión de Node.js necesaria para este servicio MCP")
        self._trace(server_id, f"Node.js detected: {detected} (minimum {required_node_major})")
        if int(version_match.group(1)) < required_node_major:
            raise RuntimeError(f"{server_id} requiere Node.js {required_node_major}+; se detectó {detected}")

    def start(self, server_id: str) -> list[dict]:
        with self._lock:
            self.services = self._load_services()
            server = self.services.get(server_id)
            if not server:
                raise KeyError(f"Servidor MCP desconocido: {server_id}")
            current = self.clients.get(server_id)
            if current and current.running():
                return self.list_servers()
            self.states[server_id] = "starting"
            self.errors.pop(server_id, None)
            client = None
            self._trace(server_id, "start requested")
            try:
                service_dir = server["_directory"]
                values = self._prepare_service(server_id, server)
                user_opts = self.preferences.get(server_id, {}).get("options", {})
                option_args = []
                for opt in server.get("options", []):
                    opt_id = opt.get("id")
                    if not opt_id:
                        continue
                    val = user_opts.get(opt_id, opt.get("default"))
                    values[f"option:{opt_id}"] = str(val)
                    if opt.get("type") == "boolean":
                        option_args.extend(opt.get("argsWhenTrue", []) if val else opt.get("argsWhenFalse", []))

                launch = server.get("launch", {})
                command = self._expand(launch.get("executable", sys.executable), values)
                args = [self._expand(arg, values) for arg in launch.get("args", []) + option_args]

                env = os.environ.copy()
                for k, v in launch.get("env", {}).items():
                    env[k] = self._expand(v, values)

                client = StdioMcpClient(
                    command, args, str(service_dir), env,
                    trace=lambda message: self._trace(server_id, message),
                    call_timeout=_positive_seconds(launch.get("callTimeoutSeconds"), DEFAULT_MCP_CALL_TIMEOUT_SECONDS)
                )
                # _prepare_service puede haber dejado el estado en "installing".
                self.states[server_id] = "starting"
                self.clients[server_id] = client
                client.start(int(launch.get("handshakeTimeoutSeconds", 15)))
                self.states[server_id] = "running"
                entry = self.preferences.setdefault(server_id, {})
                entry["enabled"] = True
                self._save_preferences()
                self._trace(server_id, "started successfully")
            except Exception as exc:
                self.states[server_id] = "error"
                self.errors[server_id] = str(exc)
                self._trace(server_id, f"start failed: {exc}")
                if server_id in self.clients:
                    self.clients.pop(server_id).stop()
                elif client:
                    client.stop()
            return self.list_servers()

    def stop(self, server_id: str) -> list[dict]:
        with self._lock:
            self.services = self._load_services()
            if server_id not in self.services and server_id not in self.clients:
                raise KeyError(f"Servidor MCP desconocido: {server_id}")
            client = self.clients.pop(server_id, None)
            if client:
                client.stop()
            self.states[server_id] = "stopped"
            self.errors.pop(server_id, None)
            entry = self.preferences.setdefault(server_id, {})
            entry["enabled"] = False
            self._save_preferences()
            return self.list_servers()

    def configure(self, server_id: str, options: dict | None = None) -> list[dict]:
        with self._lock:
            self.services = self._load_services()
            if server_id not in self.services:
                raise KeyError(f"Servidor MCP desconocido: {server_id}")
            entry = self.preferences.setdefault(server_id, {})
            if options is not None:
                opts = entry.setdefault("options", {})
                opts.update(options)
            self._save_preferences()
            return self.list_servers()

    def tools(self) -> list[dict]:
        aggregated = []
        seen: set[str] = set()
        with self._lock:
            for server_id, client in self.clients.items():
                if not client.running():
                    continue
                for t in client.tools:
                    original = t.get("name") if isinstance(t, dict) else None
                    try:
                        pname = public_tool_name(server_id, original)
                    except Exception as exc:
                        self._trace(server_id, f"tool discarded ({original!r}): {exc}")
                        continue
                    if pname in seen:
                        self._trace(server_id, f"tool discarded ({original!r}): duplicate public name {pname}")
                        continue
                    seen.add(pname)
                    tcopy = dict(t)
                    tcopy["name"] = pname
                    tcopy["metadata"] = {
                        "mcpServerId": server_id,
                        "originalName": original
                    }
                    aggregated.append(tcopy)
        return aggregated

    def call(self, public_name: str, arguments: dict) -> dict:
        target = None
        with self._lock:
            for server_id, client in self.clients.items():
                if not client.running():
                    continue
                for t in client.tools:
                    try:
                        matches = public_tool_name(server_id, t.get("name")) == public_name
                    except (ValueError, TypeError):
                        continue
                    if matches:
                        target = (client, t["name"])
                        break
                if target:
                    break
        if not target:
            raise ValueError(f"Herramienta externa '{public_name}' no disponible o servidor detenido.")
        # La llamada puede durar decenas de segundos: no debe bloquear al resto de servidores.
        client, original_name = target
        return client.request("tools/call", {"name": original_name, "arguments": arguments}, timeout=client.call_timeout)

    def close(self):
        with self._lock:
            for client in list(self.clients.values()):
                client.stop()
            self.clients.clear()


GLOBAL_MCP_MANAGER = McpServiceManager()
DEFAULT_HEARTBEAT_TIMEOUT = float(os.environ.get("ZEROCHAT_HEARTBEAT_TIMEOUT", "60.0"))
DEFAULT_HEARTBEAT_GRACE = float(os.environ.get("ZEROCHAT_HEARTBEAT_GRACE", "45.0"))
DEFAULT_HEARTBEAT_POLL = float(os.environ.get("ZEROCHAT_HEARTBEAT_POLL", "5.0"))
HEARTBEAT_LAST_SEEN = 0.0
HEARTBEAT_INITIALIZED = False
HEARTBEAT_WATCHDOG_STOP = threading.Event()
_SERVER_SHUTTING_DOWN = threading.Event()
# Si el servidor se detiene al cerrar el navegador, cerrar la pestaña detiene también los comandos.
EXIT_ON_CLOSE = False
# zerochat/run/progress ya se registra con su propio texto en dispatch_run.
QUIET_RPC_METHODS = frozenset({"zerochat/jobs/get", "zerochat/jobs/log", "zerochat/jobs/list", "zerochat/run/progress"})


def mark_browser_active():
    """Registra la presencia activa del navegador ante cualquier petición válida."""
    global HEARTBEAT_LAST_SEEN, HEARTBEAT_INITIALIZED
    HEARTBEAT_LAST_SEEN = time.monotonic()
    HEARTBEAT_INITIALIZED = True


def stop_zerochat_server(server: ThreadingHTTPServer):
    """Detiene limpiamente el servidor y todos los subsistemas evitando reentradas."""
    if _SERVER_SHUTTING_DOWN.is_set():
        return
    _SERVER_SHUTTING_DOWN.set()
    HEARTBEAT_WATCHDOG_STOP.set()
    running = JOBS.running()
    if running:
        console_log(timestamp_message(f"Deteniendo {len(running)} comando(s) en marcha: " + ", ".join(job.command[:60] for job in running)))
    JOBS.stop_all("shutdown")
    GLOBAL_MCP_MANAGER.close()
    threading.Thread(target=server.shutdown, daemon=True).start()


def heartbeat_watchdog(server: ThreadingHTTPServer, initial_grace_seconds: float = DEFAULT_HEARTBEAT_GRACE, inactivity_timeout_seconds: float = DEFAULT_HEARTBEAT_TIMEOUT, require_initial_connection: bool = True):
    """
    Supervisa la presencia de la pestaña del navegador mediante latidos HTTP.
    Si el navegador se cierra o deja de emitir latidos, detiene el servidor automáticamente.
    """
    start_time = time.monotonic()
    poll_interval = min(DEFAULT_HEARTBEAT_POLL, max(0.02, inactivity_timeout_seconds / 2))
    while not HEARTBEAT_WATCHDOG_STOP.is_set():
        if HEARTBEAT_WATCHDOG_STOP.wait(timeout=poll_interval):
            break

        now = time.monotonic()

        # 1. Periodo de gracia inicial (solo si zerochat abrió el navegador)
        if not HEARTBEAT_INITIALIZED:
            if require_initial_connection and (now - start_time > initial_grace_seconds):
                log_event(f"Tiempo de espera del navegador agotado ({initial_grace_seconds:.0f}s). Deteniendo servidor ZeroChat...")
                stop_zerochat_server(server)
                break
            continue

        # 2. Inactividad tras haber recibido latidos
        if now - HEARTBEAT_LAST_SEEN > inactivity_timeout_seconds:
            log_event("Navegador desconectado (cierre detectado). Deteniendo servidor ZeroChat...")
            stop_zerochat_server(server)
            break


DEV_CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8",
    ".map": "application/json",
}

METADATA_HOSTS = frozenset({
    "169.254.169.254",
    "metadata.google.internal",
    "instance-data",
    "100.100.100.200",
})
DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
WEB_FETCH_MAX_BYTES = 10 * 1024 * 1024
WEB_FETCH_MAX_REDIRECTS = 5
WEB_FETCH_READ_CHUNK = 64 * 1024
TEXT_CONTENT_TYPE_RE = re.compile(
    r"^(text/|application/(json|xml|xhtml\+xml|javascript|x-javascript|ecmascript)$|[a-z]+/[^;]*\+(json|xml)$)"
)


def _is_public_ip(address: str) -> bool:
    """Una dirección es pública si es global y no multicast; las IPv4 mapeadas en IPv6 se evalúan como IPv4."""
    ip = ipaddress.ip_address(address.split("%", 1)[0])
    if ip.version == 6 and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return ip.is_global and not ip.is_multicast


def is_dangerous_host(hostname: str) -> bool:
    """Riesgo de SSRF: metadatos cloud, nombres locales o cualquier dirección resuelta no pública."""
    clean_host = (hostname or "").strip().lower().strip("[]").rstrip(".")
    if not clean_host or clean_host in METADATA_HOSTS or clean_host == "localhost":
        return True
    if clean_host.endswith((".localhost", ".local", ".internal")):
        return True
    try:
        infos = socket.getaddrinfo(clean_host, None, proto=socket.IPPROTO_TCP)
    except (socket.gaierror, UnicodeError):
        # Sin resolución no hay conexión posible: la petición fallará por sí misma.
        return False
    return any(not _is_public_ip(info[4][0]) for info in infos)


def _validate_web_url(url: str) -> str:
    """Valida esquema y host de una URL de descarga (también de cada redirección)."""
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError(f"Protocolo no permitido: '{parsed.scheme}'. Solo se admite http y https.")
    if not parsed.hostname:
        raise ValueError("URL sin nombre de host válido.")
    if is_dangerous_host(parsed.hostname):
        raise PermissionError("Acceso bloqueado: intento de acceso a servicios internos o metadatos de infraestructura (SSRF).")
    return url


class _ValidatingRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Sigue redirecciones solo si el destino supera la misma validación anti-SSRF que la URL pedida."""
    max_redirections = WEB_FETCH_MAX_REDIRECTS

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _validate_web_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_WEB_OPENER = urllib.request.build_opener(_ValidatingRedirectHandler)


def _read_limited_body(stream, content_encoding: str, max_bytes: int) -> tuple[bytes, bool]:
    """Lee el cuerpo ya descomprimido hasta `max_bytes`; indica si había más (truncado)."""
    encoding = (content_encoding or "").strip().lower()
    # MAX_WBITS | 32 detecta la cabecera gzip o zlib.
    decompressor = zlib.decompressobj(zlib.MAX_WBITS | 32) if encoding in ("gzip", "x-gzip", "deflate") else None
    data = bytearray()
    while len(data) <= max_bytes:
        chunk = stream.read(WEB_FETCH_READ_CHUNK)
        if not chunk:
            break
        if decompressor:
            # La salida se limita al hueco restante: un cuerpo comprimido no puede crecer sin tope.
            chunk = decompressor.decompress(chunk, max_bytes + 1 - len(data))
        data += chunk
    truncated = len(data) > max_bytes
    return bytes(data[:max_bytes]), truncated


def is_text_content_type(content_type: str) -> bool:
    """Tipos que se devuelven como texto; el resto viaja en base64."""
    media_type = (content_type or "").split(";", 1)[0].strip().lower()
    return not media_type or bool(TEXT_CONTENT_TYPE_RE.match(media_type))


def fetch_web_resource(params: dict) -> dict:
    """Descarga de forma segura un recurso web vía HTTP/HTTPS para el cliente web."""
    url = params.get("url")
    if not isinstance(url, str) or not url.strip():
        raise ValueError("URL no válida o ausente.")
    url = _validate_web_url(url.strip())

    timeout_s = max(0.5, min(float(params.get("timeout_s", 10.0)), 30.0))
    max_bytes = max(1024, min(int(params.get("max_bytes", 2 * 1024 * 1024)), WEB_FETCH_MAX_BYTES))
    as_binary = bool(params.get("binary", False))
    accept = params.get("accept")
    req_headers = {
        "User-Agent": DEFAULT_USER_AGENT,
        "Accept": accept if isinstance(accept, str) and accept else "*/*",
        "Accept-Encoding": "gzip, deflate",
    }

    req = urllib.request.Request(url, headers=req_headers)
    try:
        with _WEB_OPENER.open(req, timeout=timeout_s) as resp:
            content_type = resp.headers.get("Content-Type", "")
            raw_data, truncated = _read_limited_body(resp, resp.headers.get("Content-Encoding", ""), max_bytes)
            # Las cabeceras de transporte ya no describen el cuerpo descomprimido.
            resp_headers = {k: v for k, v in resp.getheaders() if k.lower() not in ("content-encoding", "content-length")}
            result = {
                "ok": True,
                "status": resp.status,
                "url": resp.geturl(),
                "content_type": content_type,
                "headers": resp_headers,
                "byte_size": len(raw_data),
                "truncated": truncated
            }
            if as_binary or not is_text_content_type(content_type):
                result["base64"] = base64.b64encode(raw_data).decode("ascii")
                return result
            charset = resp.headers.get_content_charset() or "utf-8"
            try:
                result["text"] = raw_data.decode(charset, errors="replace")
            except LookupError:
                result["text"] = raw_data.decode("utf-8", errors="replace")
            return result
    except urllib.error.HTTPError as he:
        err_body = ""
        try:
            err_body = he.read(2048).decode("utf-8", errors="replace")
        except OSError:
            pass
        return {
            "ok": False,
            "status": he.code,
            "error": f"HTTP {he.code}: {he.reason}",
            "text": err_body
        }
    except Exception as exc:
        return {
            "ok": False,
            "status": 0,
            "error": str(exc)
        }


class ZeroChatServerHandler(BaseHTTPRequestHandler):
    server_version = f"ZeroChatServer/{VERSION}"

    def _log_req(self, method: str, detail: str):
        log_event(f"--> {method} {detail}")

    def _log_res(self, status: int, detail: str, duration_ms: float, error_info: str = ""):
        status_text = {
            200: "200 OK",
            204: "204 No Content",
            400: "400 Bad Request",
            401: "401 Unauthorized",
            403: "403 Forbidden",
            404: "404 Not Found",
            500: "500 Internal Server Error",
        }.get(status, str(status))
        err_suffix = f" - ERROR: {format_log_error(error_info)}" if error_info else ""
        log_event(f"<-- {status_text} {detail}{err_suffix} ({duration_ms:.1f}ms)")

    def serve_static_file(self, rel_path: str) -> bool:
        """Sirve recursos estáticos solo desde el repositorio de desarrollo."""
        static_root = get_static_root()
        if not static_root:
            return False

        clean_rel = rel_path.split("?", 1)[0].lstrip("/")
        if not clean_rel:
            return False

        target_path = (static_root / clean_rel).resolve()
        try:
            rel_parts = target_path.relative_to(static_root.resolve()).parts
        except ValueError:
            return False

        # Whitelist de archivos y carpetas autorizados para servir la interfaz web
        is_allowed_static = (
            clean_rel == "zerochat.html" or
            clean_rel in ("manifest.webmanifest", "sw.js", "favicon.ico") or
            clean_rel.startswith("js/") or
            clean_rel.startswith("css/") or
            clean_rel.startswith("help/")
        )
        if not is_allowed_static:
            return False

        # Protección: bloquear archivos ocultos, datos y dependencias locales.
        for part in rel_parts:
            if part.startswith(".") and part != ".":
                return False
            if part in ("zerochat", "node_modules", ".git", "tests"):
                return False

        if not target_path.is_file():
            return False

        ext = target_path.suffix.lower()
        content_type = DEV_CONTENT_TYPES.get(ext, "application/octet-stream")
        try:
            data = target_path.read_bytes()
        except Exception:
            return False

        mark_browser_active()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        if clean_rel == "sw.js":
            self.send_header("Service-Worker-Allowed", "/")
        self.send_cors_headers()
        self.end_headers()
        self.wfile.write(data)
        return True

    def send_cors_headers(self):
        origin = self.headers.get("Origin")
        if not is_allowed_origin(origin, require_origin=True):
            return
        self.send_header("Access-Control-Allow-Origin", origin if origin else "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization, X-ZeroChat-Token, X-ZeroChat-Client, X-ZeroChat-Tool-Session, X-ZeroChat-Tool-Expires, X-ZeroChat-Tool-Nonce, X-ZeroChat-Tool-Signature")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def verify_token(self) -> bool:
        """Comprueba el token de sesión exclusivamente en cabeceras HTTP."""
        auth_header = self.headers.get("Authorization", "")
        token_candidate = None
        if auth_header.startswith("Bearer "):
            token_candidate = auth_header[7:].strip()
        elif "X-ZeroChat-Token" in self.headers:
            token_candidate = self.headers.get("X-ZeroChat-Token", "").strip()

        if not token_candidate:
            return False
        is_valid = hmac.compare_digest(token_candidate, SESSION_TOKEN)
        if is_valid:
            mark_browser_active()
        return is_valid

    def verify_tool_authorization(self, body: bytes, request_path: str) -> str | None:
        """Validate and atomically consume an authorization for one tool call."""
        session_id = self.headers.get("X-ZeroChat-Tool-Session", "")
        expires_raw = self.headers.get("X-ZeroChat-Tool-Expires", "")
        nonce = self.headers.get("X-ZeroChat-Tool-Nonce", "")
        signature = self.headers.get("X-ZeroChat-Tool-Signature", "")
        if (not isinstance(session_id, str) or len(session_id) > 128 or
                not isinstance(nonce, str) or not re.fullmatch(r"[A-Za-z0-9_-]{22,128}", nonce) or
                not isinstance(signature, str) or not re.fullmatch(r"[A-Za-z0-9_-]{43,128}", signature)):
            return "Missing or invalid tool authorization"
        try:
            expires_at = int(expires_raw)
        except (TypeError, ValueError):
            return "Missing or invalid tool authorization"
        now_ms = int(time.time() * 1000)
        if session_id != TOOL_AUTH_SESSION_ID or expires_at < now_ms or expires_at > now_ms + TOOL_AUTH_TTL_MS:
            return "Expired or invalid tool authorization"
        body_hash = hashlib.sha256(body).hexdigest()
        signature_base = json.dumps(
            [TOOL_AUTH_VERSION, session_id, "POST", request_path or "/", expires_at, nonce, body_hash],
            separators=(",", ":"), ensure_ascii=True
        ).encode("utf-8")
        expected = base64.urlsafe_b64encode(hmac.new(TOOL_AUTH_KEY, signature_base, hashlib.sha256).digest()).rstrip(b"=").decode("ascii")
        if not hmac.compare_digest(signature, expected):
            return "Invalid tool authorization signature"
        with TOOL_AUTH_NONCES_LOCK:
            for value, expiry in list(TOOL_AUTH_NONCES.items()):
                if expiry < now_ms:
                    del TOOL_AUTH_NONCES[value]
            if nonce in TOOL_AUTH_NONCES:
                return "Tool authorization was already used"
            if len(TOOL_AUTH_NONCES) >= TOOL_AUTH_MAX_NONCES:
                return "Tool authorization cache is full"
            TOOL_AUTH_NONCES[nonce] = expires_at
        return None

    def do_OPTIONS(self):
        t0 = time.monotonic()
        safe_path = sanitize_log_path(self.path)
        path_clean = self.path.split("?", 1)[0].rstrip("/")
        is_heartbeat = path_clean == "/zerochat/heartbeat"
        if not is_heartbeat:
            self._log_req("OPTIONS", safe_path)
        origin = self.headers.get("Origin")
        if not is_allowed_origin(origin, require_origin=True):
            self.send_response(403)
            self.end_headers()
            self._log_res(403, safe_path, (time.monotonic() - t0) * 1000, f"Origen no permitido: '{origin}'")
            return
        self.send_response(204)
        self.send_cors_headers()
        self.end_headers()
        if not is_heartbeat:
            self._log_res(204, safe_path, (time.monotonic() - t0) * 1000)

    def _send_json_response(self, status: int, data: dict) -> bool:
        """Envía JSON con cabeceras CORS; devuelve False si el cliente ya cerró la conexión."""
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_cors_headers()
        self.end_headers()
        try:
            self.wfile.write(body)
            return True
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
            return False

    def do_GET(self):
        t0 = time.monotonic()
        safe_path = sanitize_log_path(self.path)
        path_clean = self.path.split("?", 1)[0].rstrip("/")
        is_heartbeat = path_clean == "/zerochat/heartbeat"

        origin = self.headers.get("Origin")
        if not is_allowed_origin(origin):
            if not is_heartbeat:
                self._log_req("GET", safe_path)
            self.send_response(403)
            self.end_headers()
            self._log_res(403, safe_path, (time.monotonic() - t0) * 1000, f"Origen no permitido: '{origin}'")
            return

        # Servir archivos estáticos del repositorio si estamos en entorno de desarrollo
        if path_clean and self.serve_static_file(path_clean):
            self._log_req("GET", safe_path)
            self._log_res(200, safe_path, (time.monotonic() - t0) * 1000)
            return

        # Browsers request this optional public resource without API credentials.
        if path_clean == "/favicon.ico":
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        if not is_heartbeat:
            self._log_req("GET", safe_path)

        if not self.verify_token():
            self._reject(401, {"error": "Unauthorized: invalid or missing session token"}, safe_path, t0, "Token de sesión ausente o inválido")
            return

        if is_heartbeat:
            mark_browser_active()
            # cwd permite a cada pestaña notar que otra ha cambiado el directorio del proyecto;
            # jobs, mostrar los comandos que siguen en marcha y avisar antes de cerrar si se detendrían.
            self._send_json_response(200, {
                "ok": True,
                "cwd": str(Path.cwd().resolve()),
                "jobs": [job.summary() for job in JOBS.running()],
                "exit_on_close": EXIT_ON_CLOSE
            })
            return

        accept = self.headers.get("Accept", "")
        if "/sse" in self.path or "text/event-stream" in accept:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "keep-alive")
            self.send_cors_headers()
            self.end_headers()
            endpoint_data = b"/mcp/external" if "/mcp/external" in self.path else b"/"
            self.wfile.write(b"event: endpoint\r\ndata: " + endpoint_data + b"\r\n\r\n")
            self.wfile.flush()
            self._log_res(200, f"{safe_path} [SSE canal activo]", (time.monotonic() - t0) * 1000)
            return

        self._send_json_response(200, {
            "status": "active",
            "server": "ZeroChat Local Server",
            "version": VERSION,
            "cwd": str(Path.cwd().resolve()),
            "tools_count": len(LOCAL_TOOLS_DEFINITIONS),
            "browser_action": browser_action_availability(),
            "os": DETECTED_OS
        })
        self._log_res(200, safe_path, (time.monotonic() - t0) * 1000)

    def _reject(self, status: int, data: dict, safe_path: str, t0: float, log_message: str):
        self._send_json_response(status, data)
        self._log_res(status, safe_path, (time.monotonic() - t0) * 1000, log_message)

    def _read_rpc_request(self, safe_path: str, t0: float) -> tuple[dict, bytes] | None:
        """Lee y valida el cuerpo JSON-RPC; si no es válido responde y devuelve None."""
        try:
            content_len = int(self.headers.get("Content-Length"))
        except (TypeError, ValueError):
            self._log_req("POST", safe_path)
            self._reject(400, {"error": "Invalid Content-Length"}, safe_path, t0, "Content-Length inválido")
            return None
        if content_len < 0:
            self._log_req("POST", safe_path)
            self._reject(400, {"error": "Invalid Content-Length"}, safe_path, t0, "Content-Length negativo")
            return None
        body_limit = http_body_limit()
        if content_len > body_limit:
            self._log_req("POST", safe_path)
            if content_len <= body_limit * 2:
                try:
                    self.rfile.read(content_len)
                except (OSError, ValueError):
                    pass
            self.close_connection = True
            self._reject(413, {"error": "Request body too large"}, safe_path, t0, "Cuerpo HTTP excede el límite")
            return None
        post_data = self.rfile.read(content_len)

        try:
            req = json.loads(post_data.decode("utf-8"))
        except Exception as err:
            self._log_req("POST", safe_path)
            self._reject(400, {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": f"Parse error: {err}"}},
                         safe_path, t0, f"Error parseando JSON: {err}")
            return None

        rpc_error = self._validate_rpc(req)
        if rpc_error:
            self._log_req("POST", safe_path)
            self._reject(400, {"error": rpc_error[0]}, safe_path, t0, rpc_error[1])
            return None
        return req, post_data

    @staticmethod
    def _validate_rpc(req) -> tuple[str, str] | None:
        """Devuelve (error público, detalle de log) si la petición no es JSON-RPC 2.0 válida."""
        if not isinstance(req, dict):
            return "Request must be a JSON object", "La solicitud JSON no es un objeto"
        req_id = req.get("id")
        method = req.get("method")
        params = req.get("params", {})
        if req.get("jsonrpc") != "2.0":
            return "Invalid JSON-RPC version", "Versión JSON-RPC inválida"
        if req_id is not None and (isinstance(req_id, bool) or not isinstance(req_id, (str, int, float))):
            return "Invalid JSON-RPC id", "id JSON-RPC inválido"
        if not isinstance(method, str) or not method or len(method) > MAX_RPC_METHOD_LENGTH:
            return "Invalid JSON-RPC method", "Método JSON-RPC inválido"
        if not isinstance(params, dict):
            return "Invalid JSON-RPC params", "params JSON-RPC inválidos"
        if method == "tools/call":
            tool_name = params.get("name")
            tool_args = params.get("arguments", {})
            if not isinstance(tool_name, str) or not tool_name or len(tool_name) > MAX_TOOL_NAME_LENGTH:
                return "Invalid tool name", "Nombre de herramienta inválido"
            if not isinstance(tool_args, dict):
                return "Invalid tool arguments", "Argumentos de herramienta inválidos"
            tool_args_error = validate_local_tool_arguments(tool_name, tool_args)
            if tool_args_error:
                return tool_args_error, tool_args_error
        return None

    @staticmethod
    def _initialize_result(server_info: dict) -> dict:
        return {
            "protocolVersion": "2024-11-05",
            "serverInfo": server_info,
            "capabilities": {
                "tools": {"listChanged": True}
            },
            "toolAuthorization": {
                "version": TOOL_AUTH_VERSION,
                "sessionId": TOOL_AUTH_SESSION_ID,
                "key": base64.urlsafe_b64encode(TOOL_AUTH_KEY).rstrip(b"=").decode("ascii"),
                "ttlMs": TOOL_AUTH_TTL_MS
            }
        }

    @staticmethod
    def _tool_exception_result(ex: Exception) -> dict:
        return {"content": [{"type": "text", "text": _tool_error(str(ex))}], "isError": True}

    def _dispatch_external(self, method: str, params: dict) -> tuple[dict | None, dict | None, str]:
        """Atiende /mcp/external. Devuelve (result, error JSON-RPC, detalle de error de herramienta)."""
        if method == "initialize":
            return self._initialize_result({"name": "ZeroChat External MCP Host", "version": VERSION}), None, ""
        if method == "tools/list":
            return {"tools": GLOBAL_MCP_MANAGER.tools()}, None, ""
        if method == "tools/call":
            try:
                result = GLOBAL_MCP_MANAGER.call(params["name"], params.get("arguments", {}))
            except Exception as ex:
                return self._tool_exception_result(ex), None, str(ex)
            tool_error_info = ""
            if isinstance(result, dict) and result.get("isError"):
                c_list = result.get("content", [])
                if c_list and isinstance(c_list, list) and isinstance(c_list[0], dict):
                    tool_error_info = c_list[0].get("text", "Error en herramienta MCP externa")
                else:
                    tool_error_info = "Error en herramienta MCP externa"
            return result, None, tool_error_info
        return None, {"code": -32601, "message": f"Método '{method}' no soportado en /mcp/external."}, ""

    def _dispatch_local(self, method: str, params: dict) -> tuple[dict | None, dict | None, str]:
        """Atiende el endpoint local. Devuelve (result, error JSON-RPC, detalle de error de herramienta)."""
        if method == "initialize":
            server_info = {
                "name": "ZeroChat Local Server",
                "version": VERSION,
                "cwd": str(Path.cwd().resolve()),
                "os": DETECTED_OS
            }
            return self._initialize_result(server_info), None, ""
        if method == "tools/list":
            browser_availability = browser_action_availability()
            tools = []
            for definition in LOCAL_TOOLS_DEFINITIONS:
                item = dict(definition)
                if item.get("name") == "browser_action":
                    item["availability"] = browser_availability
                tools.append(item)
            return {"tools": tools}, None, ""
        if method == "tools/availability":
            if params.get("name", "") != "browser_action":
                return None, {"code": -32602, "message": "Herramienta no compatible con comprobación de disponibilidad."}, ""
            return browser_action_availability(), None, ""
        if method == "tools/call":
            tool_name = params["name"]
            handler = LOCAL_TOOL_HANDLERS.get(tool_name)
            if not handler:
                return None, {"code": -32601, "message": f"Herramienta local '{tool_name}' no encontrada."}, ""
            arguments = dict(params.get("arguments", {}))
            if tool_name == "run_command":
                # La clave la pone el cliente, no el modelo: permite detener el comando antes de conocer su job_id.
                meta = params.get("_meta")
                arguments["job_key"] = meta.get("zerochatJobKey") if isinstance(meta, dict) else None
            try:
                tool_output_json = handler(**arguments)
            except Exception as ex:
                return self._tool_exception_result(ex), None, str(ex)
            tool_error_info = ""
            try:
                parsed_out = json.loads(tool_output_json)
                if isinstance(parsed_out, dict) and parsed_out.get("success") is False:
                    tool_error_info = str(parsed_out.get("error", "Error en herramienta local"))
            except (json.JSONDecodeError, TypeError):
                pass
            return {"content": [{"type": "text", "text": tool_output_json}], "isError": bool(tool_error_info)}, None, tool_error_info
        if method == "zerochat/project/set_directory":
            # Lo invoca la interfaz a petición del usuario: no es una herramienta del modelo.
            try:
                return set_project_directory(params.get("path")), None, ""
            except (ValueError, OSError) as exc:
                return None, {"code": -32602, "message": str(exc)}, ""
        if method == "zerochat/diff/open":
            try:
                return open_file_diff(params.get("path"), bool(params.get("commit_fallback"))), None, ""
            except (ValueError, RuntimeError) as exc:
                return None, {"code": -32602, "message": str(exc)}, ""
            except Exception as exc:
                return None, {"code": -32603, "message": f"Error al abrir el visor de diffs: {exc}"}, str(exc)
        if method == "zerochat/web/fetch":
            try:
                return fetch_web_resource(params), None, ""
            except (ValueError, PermissionError) as exc:
                return None, {"code": -32602, "message": str(exc)}, ""
            except Exception as exc:
                return None, {"code": -32603, "message": f"Error en transporte web: {exc}"}, str(exc)
        if method.startswith("zerochat/jobs/"):
            return self._dispatch_jobs(method, params)
        if method.startswith("zerochat/run/"):
            return dispatch_run(method, params)
        if method == "zerochat/external/status":
            return {"host": "running", "version": VERSION, "servers": GLOBAL_MCP_MANAGER.list_servers()}, None, ""
        if method in ("zerochat/external/servers/start", "zerochat/external/servers/stop", "zerochat/external/servers/configure"):
            return self._dispatch_server_control(method, params)
        return None, {"code": -32601, "message": f"Método '{method}' no soportado."}, ""

    @staticmethod
    def _dispatch_jobs(method: str, params: dict) -> tuple[dict | None, dict | None, str]:
        """Control de los comandos desde la interfaz: tarjetas, log y botón de detener."""
        if method == "zerochat/jobs/list":
            return {"jobs": [job.summary() for job in JOBS.list()]}, None, ""
        if method == "zerochat/jobs/report":
            ids = params.get("ids")
            if not isinstance(ids, list) or len(ids) > 100 or any(isinstance(i, bool) or not isinstance(i, int) for i in ids):
                return None, {"code": -32602, "message": "ids debe ser una lista de hasta 100 enteros."}, ""
            return {"reports": JOBS.report_finished(ids)}, None, ""
        job = JOBS.get(job_id=params.get("id"), key=params.get("key"))
        if method in ("zerochat/jobs/get", "zerochat/jobs/log", "zerochat/jobs/stop") and job is None:
            return None, {"code": -32602, "message": "Comando no encontrado: puede pertenecer a una sesión anterior de ZeroChat."}, ""
        if method == "zerochat/jobs/get":
            return job_details(job), None, ""
        if method == "zerochat/jobs/log":
            offset = params.get("offset", 0)
            limit = params.get("limit", JOB_LOG_PAGE_BYTES)
            if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0:
                return None, {"code": -32602, "message": "offset debe ser un entero no negativo."}, ""
            if isinstance(limit, bool) or not isinstance(limit, int) or limit <= 0:
                return None, {"code": -32602, "message": "limit debe ser un entero positivo."}, ""
            text, next_offset = job.read_range(offset, min(limit, JOB_LOG_PAGE_BYTES))
            return {"text": text, "next": next_offset, "total": job.total, "done": job.done.is_set()}, None, ""
        if method == "zerochat/jobs/stop":
            JOBS.stop(job, "user")
            return job_details(job), None, ""
        return None, {"code": -32601, "message": f"Método '{method}' no soportado."}, ""

    @staticmethod
    def _dispatch_server_control(method: str, params: dict) -> tuple[dict | None, dict | None, str]:
        server_id = params.get("serverId")
        opts = params.get("options", {})
        if not isinstance(server_id, str) or not server_id:
            return None, {"code": -32602, "message": "serverId debe ser un texto no vacío."}, ""
        if not isinstance(opts, dict):
            return None, {"code": -32602, "message": "options debe ser un objeto."}, ""
        try:
            if method.endswith("/start"):
                servers = GLOBAL_MCP_MANAGER.start(server_id)
            elif method.endswith("/stop"):
                servers = GLOBAL_MCP_MANAGER.stop(server_id)
            else:
                servers = GLOBAL_MCP_MANAGER.configure(server_id, opts)
        except KeyError as exc:
            return None, {"code": -32602, "message": str(exc.args[0]) if exc.args else str(exc)}, ""
        return {"servers": servers}, None, ""

    def do_POST(self):
        t0 = time.monotonic()
        safe_path = sanitize_log_path(self.path)
        req_path = self.path.split("?", 1)[0].rstrip("/")
        origin = self.headers.get("Origin")
        if not is_allowed_origin(origin):
            self._log_req("POST", safe_path)
            self.send_response(403)
            self.end_headers()
            self._log_res(403, safe_path, (time.monotonic() - t0) * 1000, f"Origen no permitido: '{origin}'")
            return

        if not self.verify_token():
            self._log_req("POST", safe_path)
            self._reject(401, {
                "jsonrpc": "2.0",
                "id": None,
                "error": {"code": -32000, "message": "Unauthorized: invalid or missing session token"}
            }, safe_path, t0, "Token de sesión ausente o inválido")
            return

        parsed = self._read_rpc_request(safe_path, t0)
        if parsed is None:
            return
        req, post_data = parsed
        req_id = req.get("id")
        method = req["method"]
        params = req.get("params", {})

        if method == "tools/call":
            auth_error = self.verify_tool_authorization(post_data, req_path or "/")
            if auth_error:
                self._log_req("POST", safe_path)
                self._reject(403, {"error": auth_error}, safe_path, t0, auth_error)
                return

        # Etiqueta de seguimiento para la petición y respuesta (sin datos sensibles)
        action_tag = f"[tools/call: {params['name']}]" if method == "tools/call" else f"[rpc: {method}]"
        log_detail = f"{safe_path} {action_tag}"
        # Las consultas periódicas de la interfaz no se registran, como el latido. Un fallo suyo es
        # normal (por ejemplo, preguntar por un comando que el servidor aún no ha registrado).
        quiet = method in QUIET_RPC_METHODS
        if not quiet:
            self._log_req("POST", log_detail)

        if req_id is None and method.startswith("notifications/"):
            self.send_response(204)
            self.send_cors_headers()
            self.end_headers()
            self._log_res(204, log_detail, (time.monotonic() - t0) * 1000)
            return

        try:
            if "/mcp/external" in req_path:
                result, error, tool_error_info = self._dispatch_external(method, params)
            else:
                result, error, tool_error_info = self._dispatch_local(method, params)
        except Exception as ex:
            result, tool_error_info = None, ""
            error = {"code": -32603, "message": f"Error interno: {ex}"}

        response_payload = {"jsonrpc": "2.0", "id": req_id}
        if error:
            response_payload["error"] = error
            error_info = f"[{error.get('code')}] {error.get('message')}"
        else:
            response_payload["result"] = result
            error_info = tool_error_info

        if self._send_json_response(200, response_payload) and not quiet:
            self._log_res(200, log_detail, (time.monotonic() - t0) * 1000, error_info=error_info)

    def log_message(self, format, *args):
        # Silenciar logs ruidosos por defecto
        pass
def is_termux_environment() -> bool:
    """Devuelve si el proceso se ejecuta dentro de la instalación de Termux."""
    termux_prefix = "/data/data/com.termux/files/usr"
    return bool(
        os.environ.get("TERMUX_VERSION")
        or os.environ.get("PREFIX", "").startswith(termux_prefix)
        or sys.prefix.startswith(termux_prefix)
    )


def get_manual_browser_command(url: str) -> str | None:
    """Devuelve un comando pegable para abrir la sesión cuando Termux no pudo hacerlo."""
    if is_termux_environment():
        return shlex.join(["termux-open-url", url])
    return None


def get_termux_open_url_executable() -> str | None:
    """Localiza termux-open-url incluso si el venv recibió un PATH incompleto."""
    if shutil.which("termux-open-url"):
        return "termux-open-url"

    prefix = os.environ.get("PREFIX", "/data/data/com.termux/files/usr")
    executable = Path(prefix) / "bin" / "termux-open-url"
    if executable.is_file():
        return str(executable)
    return None


def browser_launch_diagnostics(attempts: list[str]) -> str:
    """Resume el entorno y los lanzadores comprobados sin exponer la URL de sesión."""
    termux_prefix = os.environ.get("PREFIX", "(no definido)")
    configured_path = os.environ.get("PATH", "(no definido)")
    termux_binary = Path(termux_prefix) / "bin" / "termux-open-url" if termux_prefix != "(no definido)" else None
    lines = [
        f"plataforma={sys.platform}",
        f"termux_detectado={is_termux_environment()}",
        f"TERMUX_VERSION={'definido' if os.environ.get('TERMUX_VERSION') else 'no definido'}",
        f"PREFIX={termux_prefix}",
        f"PATH={configured_path}",
        f"termux-open-url_en_PATH={shutil.which('termux-open-url') or 'no encontrado'}",
        f"termux-open-url_en_PREFIX={str(termux_binary) if termux_binary and termux_binary.is_file() else 'no encontrado'}",
        f"xdg-open={shutil.which('xdg-open') or 'no encontrado'}",
        f"gio={shutil.which('gio') or 'no encontrado'}",
        "intentos=" + ("; ".join(attempts) if attempts else "ninguno"),
    ]
    return "\n  ".join(lines)


def open_browser(url: str) -> bool:
    """
    Abre la URL en el navegador predeterminado del usuario respetando el entorno del sistema.
    En Termux usa termux-open-url para delegar la apertura en Android. En el resto de
    Linux prioriza xdg-open o gio para respetar el gestor de ventanas y mimeapps.list,
    desacoplando el proceso hijo para evitar ruidos en la terminal.
    """
    attempts = []
    if is_termux_environment():
        termux_open_url = get_termux_open_url_executable()
        if not termux_open_url:
            raise FileNotFoundError(
                "Termux fue detectado, pero no se encontró termux-open-url.\n  "
                + browser_launch_diagnostics(["termux-open-url: no localizado"])
            )
        try:
            subprocess.Popen(
                [termux_open_url, url],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
            return True
        except OSError as error:
            raise RuntimeError(
                f"termux-open-url no pudo iniciarse: {type(error).__name__}: {error}\n  "
                + browser_launch_diagnostics(["termux-open-url: error al iniciar"])
            ) from error
    elif sys.platform.startswith("linux"):
        for cmd in ("xdg-open", "gio"):
            if shutil.which(cmd):
                try:
                    args = ["gio", "open", url] if cmd == "gio" else ["xdg-open", url]
                    subprocess.Popen(
                        args,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        start_new_session=True,
                    )
                    return True
                except OSError as error:
                    attempts.append(f"{cmd}: {type(error).__name__}: {error}")
            else:
                attempts.append(f"{cmd}: no encontrado")
    elif sys.platform == "darwin":
        if shutil.which("open"):
            try:
                subprocess.Popen(
                    ["open", url],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    start_new_session=True,
                )
                return True
            except OSError as error:
                attempts.append(f"open: {type(error).__name__}: {error}")
    elif sys.platform == "win32":
        try:
            os.startfile(url)
            return True
        except OSError as error:
            attempts.append(f"os.startfile: {type(error).__name__}: {error}")

    try:
        if webbrowser.open(url):
            return True
    except Exception as error:
        attempts.append(f"webbrowser: {type(error).__name__}: {error}")
        raise RuntimeError(
            "El navegador predeterminado rechazó la URL de ZeroChat.\n  "
            + browser_launch_diagnostics(attempts)
        ) from error
    attempts.append("webbrowser: devolvió False")
    raise RuntimeError(
        "Ningún lanzador de navegador aceptó la URL de ZeroChat.\n  "
        + browser_launch_diagnostics(attempts)
    )


def launch_browser(url: str) -> bool:
    """Abre el navegador en la URL de la sesión y muestra información o diagnóstico en consola."""
    termux_detected = is_termux_environment()
    if termux_detected:
        log_event("Termux detectado; se abrirá mediante termux-open-url.")
    log_event("Abriendo navegador en la interfaz configurada...")
    try:
        if not open_browser(url):
            raise RuntimeError("El lanzador de navegador devolvió un resultado sin éxito.")
        return True
    except Exception as e:
        log_event(f"No se pudo abrir el navegador automáticamente: {e}")
        console_log("  Traza de diagnóstico:", flush=True)
        traceback.print_exc()
        manual_command = get_manual_browser_command(url)
        if manual_command:
            console_log("  Termux detectado. Prueba este comando exacto:", flush=True)
            console_log(f"  {manual_command}", flush=True)
        return False





def default_browser_executable() -> str | None:
    """Ejecutable del navegador predeterminado en Linux (xdg-settings y su fichero .desktop), o None."""
    if not sys.platform.startswith("linux") or is_termux_environment() or not shutil.which("xdg-settings"):
        return None
    try:
        desktop = subprocess.run(["xdg-settings", "get", "default-web-browser"], capture_output=True, text=True, timeout=5).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None
    if not desktop.endswith(".desktop") or "/" in desktop:
        return None
    data_dirs = [os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")]
    data_dirs += (os.environ.get("XDG_DATA_DIRS") or "/usr/local/share:/usr/share").split(":")
    for data_dir in data_dirs:
        entry = Path(data_dir) / "applications" / desktop
        if not entry.is_file():
            continue
        try:
            lines = entry.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            return None
        exec_line = next((line[5:] for line in lines if line.startswith("Exec=")), "")
        try:
            tokens = [token for token in shlex.split(exec_line) if token != "env" and "=" not in token]
        except ValueError:
            return None
        # Flatpak o Snap envuelven el navegador: no admiten sus opciones directamente.
        if not tokens or Path(tokens[0]).name in ("flatpak", "snap"):
            return None
        return shutil.which(tokens[0])
    return None


def launch_headless_browser(url: str) -> subprocess.Popen | None:
    """
    Abre la URL en el navegador predeterminado con --headless y el perfil normal del usuario.
    Si el navegador ya está abierto, este suele recibir la URL como una pestaña visible.
    Devuelve el proceso lanzado, o None si no se pudo y hay que abrirlo de la forma normal.
    """
    executable = default_browser_executable()
    if not executable:
        log_event("No se pudo identificar el navegador predeterminado para abrirlo sin ventana; se abrirá de la forma normal.")
        return None
    log_event(f"Abriendo {Path(executable).name} sin ventana en la interfaz configurada...")
    try:
        return subprocess.Popen(
            [executable, "--headless", url],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except OSError as error:
        log_event(f"No se pudo abrir {executable} sin ventana ({error}); se abrirá de la forma normal.")
        return None
# ==============================================================================
# Modo ejecución desatendida (zerochat.py --prompt)
# ==============================================================================
# El servidor arranca y abre el navegador como siempre, con run=<id> en el fragmento: la interfaz
# pide el prompt, informa del progreso y devuelve el resultado por JSON-RPC zerochat/run/*.

# Plazo total y sin progreso de la interfaz; las variables de entorno solo las usan las pruebas.
RUN_TOTAL_TIMEOUT = float(os.environ.get("ZEROCHAT_RUN_TIMEOUT", "900"))
RUN_IDLE_SECONDS = float(os.environ.get("ZEROCHAT_RUN_IDLE_SECONDS", "180"))
RUN_POLL_SECONDS = 0.2
RUN_PROGRESS_TEXT_MAX = 500
RUN_PROGRESS_KIND_PATTERN = re.compile(r"[a-z_]{1,32}")
RUN_EXIT_DONE = 0
RUN_EXIT_ERROR = 1
RUN_EXIT_TIMEOUT = 2
RUN_EXIT_SETUP = 3
# Formato de --export según la extensión del fichero; la interfaz genera el contenido con ChatExport.
RUN_EXPORT_FORMATS = {".md": "markdown", ".json": "json", ".html": "html"}
# Cuerpo HTTP admitido mientras se espera la exportación: el JSON y el HTML llevan las imágenes incrustadas.
RUN_EXPORT_MAX_BODY_BYTES = 64 * 1024 * 1024


class RunSession:
    """Estado de la ejecución: prompt, opciones, último progreso, exportación, resultado y motivo de un final sin él."""
    def __init__(self, prompt: str, profile: str | None = None, export_path: Path | None = None, keep_open: bool = False):
        self.run_id = secrets.token_urlsafe(24)
        self.prompt = prompt
        # Perfil de conexión (nombre o id) que la interfaz usa solo en esta ejecución; None, el activo.
        self.profile = profile
        # Fichero donde se escribe la conversación exportada (formato por su extensión); None, sin exportar.
        self.export_path = export_path
        self.exported = False
        self.export_error: str | None = None
        # La interfaz no cierra la página al terminar, para ver la conversación (sin --headless).
        self.keep_open = keep_open
        self.lock = threading.Lock()
        self.last_activity = time.monotonic()
        self.prompt_delivered = False
        self.result: dict | None = None
        self.stop_reason: str | None = None
        self.finished = threading.Event()

    def touch(self):
        with self.lock:
            self.last_activity = time.monotonic()

    def idle_seconds(self) -> float:
        with self.lock:
            return time.monotonic() - self.last_activity


RUN_SESSION: RunSession | None = None


def http_body_limit() -> int:
    """Tope del cuerpo de una petición: el general, o el de la exportación mientras se espera."""
    session = RUN_SESSION
    if session is not None and session.export_path is not None and not session.exported:
        return RUN_EXPORT_MAX_BODY_BYTES
    return MAX_HTTP_BODY_BYTES


def dispatch_run(method: str, params: dict) -> tuple[dict | None, dict | None, str]:
    """Métodos zerochat/run/* que usa la interfaz abierta por el modo ejecución."""
    session = RUN_SESSION
    if session is None:
        return None, {"code": -32601, "message": "El servidor no está en modo ejecución."}, ""
    run_id = params.get("run_id")
    if not isinstance(run_id, str) or not hmac.compare_digest(run_id, session.run_id):
        return None, {"code": -32602, "message": "run_id no válido."}, ""
    if method == "zerochat/run/prompt":
        with session.lock:
            if session.prompt_delivered:
                return None, {"code": -32602, "message": "El prompt ya se entregó."}, ""
            session.prompt_delivered = True
        session.touch()
        export_format = RUN_EXPORT_FORMATS[session.export_path.suffix.lower()] if session.export_path else None
        return {"prompt": session.prompt, "profile": session.profile, "export": export_format, "keep_open": session.keep_open}, None, ""
    if method == "zerochat/run/progress":
        kind = params.get("kind")
        text = params.get("text", "")
        if not isinstance(kind, str) or not RUN_PROGRESS_KIND_PATTERN.fullmatch(kind) or not isinstance(text, str):
            return None, {"code": -32602, "message": "Progreso no válido."}, ""
        session.touch()
        if len(text) > RUN_PROGRESS_TEXT_MAX:
            text = text[:RUN_PROGRESS_TEXT_MAX] + "…"
        log_event(f"[run] {kind}{': ' + text if text else ''}")
        return {"ok": True}, None, ""
    if method == "zerochat/run/export":
        content = params.get("content")
        if session.export_path is None or not isinstance(content, str):
            return None, {"code": -32602, "message": "Exportación no pedida o sin contenido."}, ""
        with session.lock:
            if session.exported:
                return None, {"code": -32602, "message": "La exportación ya se recibió."}, ""
            try:
                session.export_path.write_text(content, encoding="utf-8")
            except OSError as exc:
                session.export_error = f"No se pudo escribir {session.export_path}: {exc}"
                return None, {"code": -32603, "message": session.export_error}, ""
            session.exported = True
        session.touch()
        log_event(f"[run] Conversación exportada en {session.export_path}")
        return {"ok": True}, None, ""
    if method == "zerochat/run/result":
        text = params.get("text")
        error = params.get("error")
        if not ((isinstance(text, str) and error is None) or (isinstance(error, str) and error and text is None)):
            return None, {"code": -32602, "message": "El resultado lleva text o error."}, ""
        with session.lock:
            if session.result is not None:
                return None, {"code": -32602, "message": "El resultado ya se recibió."}, ""
            session.result = {"text": text} if error is None else {"error": error}
        session.finished.set()
        return {"ok": True}, None, ""
    return None, {"code": -32601, "message": f"Método '{method}' no soportado."}, ""


def run_supervisor(server: ThreadingHTTPServer, session: RunSession):
    """Detiene el servidor al recibir el resultado o al agotar el plazo total o el de inactividad."""
    deadline = time.monotonic() + RUN_TOTAL_TIMEOUT
    while not session.finished.wait(RUN_POLL_SECONDS):
        # El latido o una señal ya detienen el servidor: el resultado queda vacío.
        if _SERVER_SHUTTING_DOWN.is_set():
            return
        if time.monotonic() >= deadline:
            session.stop_reason = f"Plazo total agotado ({RUN_TOTAL_TIMEOUT:.0f}s)."
            break
        if session.idle_seconds() > RUN_IDLE_SECONDS:
            session.stop_reason = f"Sin progreso de la interfaz durante {RUN_IDLE_SECONDS:.0f}s."
            break
    stop_zerochat_server(server)


def run_error(message: str):
    """Motivo de un final sin respuesta: va a stderr aunque el registro esté desactivado (--log off)."""
    print(timestamp_message(f"[run] {message}"), file=sys.stderr, flush=True)


def run_outcome(session: RunSession) -> tuple[int, str | None]:
    """
    Código de salida y respuesta final (solo si terminó bien), con el motivo de un fallo en stderr;
    una exportación pedida que no se escribió convierte un final correcto en error sin quitar la respuesta.
    """
    if session.export_path and not session.exported:
        run_error(session.export_error or f"La interfaz no envió la conversación para {session.export_path}.")
    if session.result is None:
        run_error(session.stop_reason or "El navegador se cerró o la ejecución se interrumpió sin resultado.")
        return RUN_EXIT_TIMEOUT, None
    if "error" in session.result:
        run_error(f"Error de generación: {session.result['error']}")
        return RUN_EXIT_ERROR, None
    log_event("[run] Ejecución terminada.")
    if session.export_path and not session.exported:
        return RUN_EXIT_ERROR, session.result["text"]
    return RUN_EXIT_DONE, session.result["text"]


def fall_back_when_headless_exits(proc: subprocess.Popen, url: str):
    """
    Un navegador sin ventana termina enseguida si su perfil ya está abierto (Firefox avisa de que
    ya está en marcha): si acaba antes de que conecte la interfaz, se abre la pestaña normal.
    """
    proc.wait()
    if not HEARTBEAT_INITIALIZED and not _SERVER_SHUTTING_DOWN.is_set():
        log_event("El navegador sin ventana terminó sin abrir la interfaz (¿ya estaba abierto?); se abre una pestaña de la forma normal.")
        launch_browser(url)
# ==============================================================================
# Punto de Entrada Principal (CLI)
# ==============================================================================

def is_loopback_host(host: str) -> bool:
    """Indica si el host de escucha solo acepta conexiones del propio equipo."""
    value = (host or "").strip().strip("[]").lower()
    if value == "localhost":
        return True
    try:
        return ipaddress.ip_address(value).is_loopback
    except ValueError:
        return False


def remote_exposure_warning(host: str) -> str | None:
    """Devuelve el aviso de exposición en red si el host no es de bucle local."""
    if is_loopback_host(host):
        return None
    return (
        f"Escuchando en {host}: cualquiera en la red con el token puede ejecutar comandos "
        "en este equipo y el tráfico HTTP va sin cifrar."
    )


def main():
    global ACTIVE_PORT, ACTIVE_HOST, SESSION_TOKEN, CONSOLE_CONTROL, EXIT_ON_CLOSE
    global TOOL_AUTH_KEY, TOOL_AUTH_SESSION_ID, TOOL_AUTH_NONCES, RUN_SESSION

    parser = argparse.ArgumentParser(description=f"ZeroChat Local Server v{VERSION}")
    # Desde Python 3.14 argparse colorea la ayuda con códigos ANSI; la consola la muestra en texto plano.
    parser.color = False
    parser.add_argument("--port", type=int, default=int(os.environ.get("ZEROCHAT_PORT", DEFAULT_PORT)), help=f"Puerto de escucha (default: {DEFAULT_PORT})")
    parser.add_argument("--host", default=os.environ.get("ZEROCHAT_HOST", DEFAULT_HOST), help=f"Host de escucha (default: {DEFAULT_HOST})")
    parser.add_argument("--ui-url", default=None, help="URL de la interfaz web a abrir (por defecto: interfaz local en desarrollo o GitHub Pages)")
    parser.add_argument("--no-browser", action="store_true", help="No abrir automáticamente el navegador")
    parser.add_argument("--no-exit-on-close", action="store_true", help="No detener el servidor automáticamente al cerrar el navegador")
    parser.add_argument("--no-venv", action="store_true", help="Omitir la comprobación/creación de ~/zerochat/.venv")
    parser.add_argument("--test", action="store_true", help="Ejecutar autocomprobación interna de herramientas")
    parser.add_argument("--prompt", default=None, help="Ejecutar este prompt en la interfaz, imprimir solo la respuesta final y terminar (salida 0 terminado, 1 error de generación, 2 plazo agotado o navegador cerrado, 3 fallo de arranque)")
    parser.add_argument("--profile", default=None, help="Con --prompt, perfil de conexión (nombre o id) que se usa solo en esta ejecución, sin cambiar el activo")
    parser.add_argument("--log", choices=("on", "off"), default=None, help="Mostrar la cabecera y el registro del servidor (default: on; off con --prompt)")
    parser.add_argument("--export", default=None, metavar="FICHERO", help=f"Con --prompt, guardar la conversación en FICHERO; el formato sale de la extensión ({', '.join(RUN_EXPORT_FORMATS)})")
    parser.add_argument("--keep-open", action="store_true", help="Con --prompt, no cerrar la página al terminar para ver la conversación (no se combina con --headless)")
    parser.add_argument("--headless", action="store_true", help="Con --prompt, abrir el navegador predeterminado sin ventana (si ya está abierto puede verse la pestaña)")
    parser.add_argument("--version", action="version", version=f"ZeroChat {VERSION}")
    args = parser.parse_args()

    # Los avisos no persisten entre ejecuciones del servidor.
    reset_notices()

    # Modo ejecución: stdout queda solo para la respuesta final; todo el registro va a stderr.
    result_out = sys.stdout
    if args.prompt is None and (args.headless or args.keep_open or args.profile is not None or args.export is not None):
        parser.error("--headless, --keep-open, --profile y --export solo se usan con --prompt")
    if args.prompt is not None:
        if not args.prompt.strip():
            run_error("El prompt está vacío.")
            sys.exit(RUN_EXIT_SETUP)
        if args.no_browser:
            parser.error("--prompt necesita abrir el navegador: no se combina con --no-browser")
        if args.profile is not None and not args.profile.strip():
            parser.error("--profile no puede estar vacío")
        if args.keep_open and args.headless:
            parser.error("--keep-open necesita la ventana del navegador: no se combina con --headless")
        export_path = None
        if args.export is not None:
            export_path = Path(args.export).expanduser().absolute()
            if export_path.suffix.lower() not in RUN_EXPORT_FORMATS:
                parser.error(f"--export necesita una de estas extensiones: {', '.join(RUN_EXPORT_FORMATS)}")
            if not export_path.parent.is_dir():
                parser.error(f"--export: no existe el directorio {export_path.parent}")
        RUN_SESSION = RunSession(args.prompt.strip(), args.profile.strip() if args.profile else None, export_path, args.keep_open)
    # Todo el registro pasa por stdout: con --prompt va a stderr para dejar stdout a la respuesta,
    # y con --log off se descarta.
    log_enabled = args.log == "on" if args.log else RUN_SESSION is None
    if not log_enabled:
        sys.stdout = open(os.devnull, "w", encoding="utf-8")
    elif RUN_SESSION:
        sys.stdout = sys.stderr

    if args.test:
        print(timestamp_message(f"TEST list_directory {'ok' if json.loads(list_directory('.'))['success'] else 'error'}"))
        print(timestamp_message(f"TEST read_file {'ok' if json.loads(read_file('package.json', max_lines=5))['success'] else 'error'}"))
        print(timestamp_message(f"TEST run_command {'ok' if json.loads(run_command('echo hello'))['success'] else 'error'}"))
        print(timestamp_message("TEST all local tools ready."))
        return

    orphans = cleanup_orphan_jobs()
    if orphans:
        print(timestamp_message(f"Detenidos {orphans} comando(s) que seguían en marcha de una sesión anterior interrumpida."))

    # 1. Asegurar el entorno MCP aislado en ambos modos de distribución.
    if not args.no_venv:
        ensure_virtual_environment()

    browser_availability = browser_action_availability()
    if not browser_availability.get("available"):
        add_notice(
            "browser_action desactivada: para usarla, inicia el servicio 'playwright' en Ajustes → MCP "
            "(se instala solo). Requiere Node.js y disponer de Chrome o Edge en el sistema."
        )

    # 2. Detectar entorno de desarrollo y resolver URL de destino
    dev_root = get_dev_root()
    static_root = get_static_root()
    is_dev = dev_root is not None
    is_installed = is_installed_runtime()

    # 3. Comprobar versión remota en segundo plano (solo fuera del entorno de desarrollo local)
    if not is_dev:
        threading.Thread(target=check_version, daemon=True).start()

    ACTIVE_PORT = args.port
    ACTIVE_HOST = args.host
    SESSION_TOKEN = get_daily_token()
    # A restart deliberately invalidates every browser-side signing credential.
    TOOL_AUTH_KEY = secrets.token_bytes(32)
    TOOL_AUTH_SESSION_ID = secrets.token_urlsafe(18)
    with TOOL_AUTH_NONCES_LOCK:
        TOOL_AUTH_NONCES = {}

    try:
        server = ThreadingHTTPServer((ACTIVE_HOST, ACTIVE_PORT), ZeroChatServerHandler)
    except OSError as exc:
        if not RUN_SESSION:
            raise
        run_error(f"No se pudo escuchar en {ACTIVE_HOST}:{ACTIVE_PORT}: {exc}")
        sys.exit(RUN_EXIT_SETUP)
    exposure_warning = remote_exposure_warning(ACTIVE_HOST)
    if exposure_warning:
        add_notice(exposure_warning)

    if args.ui_url:
        ui_url = args.ui_url
    elif static_root:
        ui_url = f"http://{ACTIVE_HOST}:{ACTIVE_PORT}/zerochat.html"
    else:
        ui_url = DEFAULT_UI_URL

    browser_host = ACTIVE_HOST if ACTIVE_HOST in {"127.0.0.1", "localhost"} else "127.0.0.1"
    fragment = {'token': SESSION_TOKEN, 'host': browser_host, 'port': ACTIVE_PORT}
    if RUN_SESSION:
        fragment['run'] = RUN_SESSION.run_id
    target_url = f"{ui_url}#{urlencode(fragment)}"
    # El modo ejecución detecta con el latido que el navegador se cerró sin devolver resultado.
    exit_on_close = RUN_SESSION is not None or not args.no_exit_on_close
    EXIT_ON_CLOSE = exit_on_close

    print("=" * 64)
    print(f"  ZeroChat Local Server v{VERSION} (UI {UI_VERSION})")
    print(f"  Directorio de trabajo : {Path.cwd()}")
    print(f"  Datos y MCP           : {get_data_dir()}")
    print(f"  Entorno MCP           : {get_venv_dir()}")
    if is_dev:
        print(f"  Modo de ejecución     : Desarrollo local ({dev_root})")
    elif is_installed:
        print("  Modo de ejecución     : Paquete PyPI (GitHub Pages)")
    else:
        print("  Modo de ejecución     : Producción (Web universal)")
    print(f"  Servidor HTTP/SSE     : http://{ACTIVE_HOST}:{ACTIVE_PORT}")
    if exposure_warning:
        print(f"  AVISO                 : {exposure_warning}")
    print("  Token de sesión (diario): configurado")
    print(f"  Destino Web           : {ui_url}")
    if exit_on_close:
        print("  Auto-cierre           : Activado (al cerrar navegador)")
    else:
        print("  Auto-cierre           : Desactivado")
    print("=" * 64, flush=True)

    headless_browser = None
    if RUN_SESSION:
        headless_browser = launch_headless_browser(target_url) if args.headless else None
        if headless_browser is None and not launch_browser(target_url):
            run_error("No se pudo abrir el navegador.")
            server.server_close()
            sys.stdout = result_out
            sys.exit(RUN_EXIT_SETUP)
        if headless_browser is not None:
            threading.Thread(target=fall_back_when_headless_exits, args=(headless_browser, target_url), daemon=True).start()
        threading.Thread(target=run_supervisor, args=(server, RUN_SESSION), daemon=True).start()
    else:
        CONSOLE_CONTROL = ConsoleControl(server, parser, target_url=target_url)
        CONSOLE_CONTROL.start()
        if not args.no_browser:
            launch_browser(target_url)

    if exit_on_close:
        require_initial = not args.no_browser
        threading.Thread(
            target=heartbeat_watchdog,
            args=(server, DEFAULT_HEARTBEAT_GRACE, DEFAULT_HEARTBEAT_TIMEOUT, require_initial),
            daemon=True
        ).start()

    def shutdown(*_):
        console_log("\n" + timestamp_message("Deteniendo servidor ZeroChat..."))
        stop_zerochat_server(server)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)
    # Cerrar el terminal no debe dejar vivos los comandos, que no reciben sus señales.
    if hasattr(signal, "SIGHUP"):
        signal.signal(signal.SIGHUP, shutdown)

    try:
        server.serve_forever()
    finally:
        stop_zerochat_server(server)
        server.server_close()
        if CONSOLE_CONTROL:
            CONSOLE_CONTROL.close()
            CONSOLE_CONTROL = None

    if RUN_SESSION:
        # Firefox sin ventana sigue vivo al cerrar la página; uno ya abierto solo recibió la pestaña.
        if headless_browser is not None and headless_browser.poll() is None:
            _kill_process_tree(headless_browser)
        code, text = run_outcome(RUN_SESSION)
        sys.stdout = result_out
        if text is not None:
            result_out.write(text if text.endswith("\n") else text + "\n")
            result_out.flush()
        sys.exit(code)


if __name__ == "__main__":
    main()
