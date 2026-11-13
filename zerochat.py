#!/usr/bin/env python3
"""
ZeroChat - Backend Local Unificado y Gestor de Entorno

Proporciona:
1. Auto-creación del entorno MCP local `~/zerochat/.venv`.
2. Servidor local HTTP JSON-RPC con autenticación estricta por token diario e identificación con la cuenta del sistema.
3. Herramientas locales seguras: read_file, edit_file, list_directory, run_command.
4. Apertura automática del navegador apuntando a zerochat.html con token en el fragmento hash.
"""

from __future__ import annotations

import argparse
import atexit
import base64
import contextlib
import ctypes
import ctypes.util
import dataclasses
import datetime
import fnmatch
import functools
import getpass
import hashlib
import hmac
import html
import importlib.metadata
import inspect
import ipaddress
import itertools
import json
import math
import os
import queue
import re
import secrets
import shlex
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import venv
import webbrowser
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlencode

# --- core.environment ---
"""Entorno de ejecución: sistema operativo, directorios de datos y de desarrollo y entorno virtual."""



DETECTED_OS = "windows" if sys.platform.startswith("win") else ("macos" if sys.platform == "darwin" else ("android" if "ANDROID_ROOT" in os.environ else "linux"))

# --- core.limits ---
"""Topes compartidos por varios módulos: tamaño de las peticiones HTTP, rutas, comandos y nombres JSON-RPC."""


MAX_HTTP_BODY_BYTES = 1024 * 1024
MAX_PATH_LENGTH = 4096
MAX_COMMAND_LENGTH = 16384
MAX_RPC_METHOD_LENGTH = 128
MAX_TOOL_NAME_LENGTH = 128

# --- core.logging ---
"""Registro en consola con la hora local; la consola interactiva, si existe, recibe las líneas."""



CONSOLE_CONTROL = None


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

# --- core.process ---
"""Procesos del sistema: si siguen vivos, su huella de arranque y la terminación de su árbol."""





def _kill_process_tree(target: subprocess.Popen | int, *, grace_seconds: float = 0.0) -> None:
    """
    Termina un proceso y sus descendientes: su grupo POSIX si lo encabeza (los hijos de zerochat arrancan
    en una sesión propia) o su árbol en Windows, donde TerminateProcess solo alcanzaría al hijo directo y
    npm.cmd o npx dejarían vivo a node. Con grace_seconds se pide primero que termine (SIGTERM) y solo se
    fuerza si sigue vivo. Un Popen ya terminado no se toca: su PID podría ser ya de otro proceso.
    """
    proc = target if isinstance(target, subprocess.Popen) else None
    pid = proc.pid if proc else target
    if proc is not None and proc.poll() is not None:
        return
    if proc is None and (not _pid_alive(pid) or pid == os.getpid()):
        return
    try:
        if DETECTED_OS == "windows":
            subprocess.run(
                ["taskkill", "/PID", str(pid), "/T", "/F"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)
            )
        elif hasattr(os, "killpg") and hasattr(os, "getpgid"):
            send = os.killpg if os.getpgid(pid) == pid else os.kill
            if grace_seconds > 0:
                send(pid, signal.SIGTERM)
                time.sleep(grace_seconds)
                if not _pid_alive(pid):
                    return
            send(pid, signal.SIGKILL)
        else:
            os.kill(pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        pass
    if proc is not None and proc.poll() is None:
        try:
            proc.kill()
        except (OSError, AttributeError):
            pass


def _windows_kernel32():
    """kernel32 con los prototipos que usan la huella de arranque y la comprobación de vida de un proceso."""
    from ctypes import wintypes
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.GetExitCodeProcess.restype = wintypes.BOOL
    kernel32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    kernel32.GetProcessTimes.restype = wintypes.BOOL
    kernel32.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    return kernel32


# PROCESS_QUERY_LIMITED_INFORMATION: basta para leer la hora de creación y el código de salida.
_WINDOWS_PROCESS_QUERY = 0x1000


def _windows_process_start_token(pid: int) -> str | None:
    """En Windows la huella es la hora de creación del proceso (GetProcessTimes)."""
    from ctypes import wintypes
    kernel32 = _windows_kernel32()
    handle = kernel32.OpenProcess(_WINDOWS_PROCESS_QUERY, False, pid)
    if not handle:
        return None
    try:
        created, exited, kernel, user = (wintypes.FILETIME() for _ in range(4))
        if not kernel32.GetProcessTimes(handle, ctypes.byref(created), ctypes.byref(exited), ctypes.byref(kernel), ctypes.byref(user)):
            return None
        return str((created.dwHighDateTime << 32) | created.dwLowDateTime)
    finally:
        kernel32.CloseHandle(handle)


def _process_start_token(pid: int) -> str | None:
    """Huella del arranque de un proceso: distingue al original de otro que reciba el mismo PID."""
    if os.name == "nt":
        return _windows_process_start_token(pid)
    try:
        if Path(f"/proc/{pid}/stat").is_file():
            stat = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8", errors="replace")
            # El nombre del proceso va entre paréntesis y puede contener espacios.
            return stat.rsplit(")", 1)[1].split()[19]
        result = subprocess.run(["ps", "-o", "lstart=", "-p", str(pid)], capture_output=True, text=True, timeout=5)
        return result.stdout.strip() or None
    except (OSError, IndexError, subprocess.SubprocessError):
        return None


def _windows_pid_alive(pid: int) -> bool:
    """En Windows, os.kill(pid, 0) no comprueba nada: envía Ctrl+C a la consola de ese proceso."""
    from ctypes import wintypes
    kernel32 = _windows_kernel32()
    handle = kernel32.OpenProcess(_WINDOWS_PROCESS_QUERY, False, pid)
    if not handle:
        return ctypes.get_last_error() == 5  # ERROR_ACCESS_DENIED: existe, pero es de otra cuenta
    try:
        exit_code = wintypes.DWORD()
        return bool(kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code))) and exit_code.value == 259  # STILL_ACTIVE
    finally:
        kernel32.CloseHandle(handle)


def _pid_alive(pid: int) -> bool:
    if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 0:
        return False
    if os.name == "nt":
        return _windows_pid_alive(pid)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True

# --- core.version ---
"""Versiones del backend y de la interfaz, y direcciones desde las que se publican."""



SOURCE_BACKEND_VERSION = "10.14.0"


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
DEFAULT_UI_URL = "https://albalday.github.io/zerochat/zerochat.html"
REMOTE_SCRIPT_URL = "https://raw.githubusercontent.com/albalday/zerochat/master/zerochat.py"

DEFAULT_PORT = 6388
DEFAULT_HOST = "127.0.0.1"
CONSOLE_STATUS_IDLE_SECONDS = 8.0
NOTICES: list[str] = []
NOTICES_LOCK = threading.Lock()

class ConsoleControl:
    """Muestra una sola línea de ayuda tras un periodo de inactividad en consola."""
    def __init__(self, server: ThreadingHTTPServer, parser: argparse.ArgumentParser, launch_url=None):
        self.server = server
        self.parser = parser
        # Función que da la URL de la interfaz con el token vigente al pulsar n, no el del arranque.
        self.launch_url = launch_url
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
        elif key == "n" and self.launch_url:
            launch_browser(self.launch_url())
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

@functools.lru_cache(maxsize=1)
def get_dev_root() -> Path | None:
    """
    Detecta si zerochat.py se está ejecutando en el directorio de desarrollo del repositorio.
    Comprueba si existen zerochat.html, js/ y css/ en el directorio del script o en cwd.
    Se calcula una vez, al arrancar: la interfaz servida no depende del proyecto de cada pestaña.
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
    tmp_file = target.with_name(f"{target.name}.{os.getpid()}.{threading.get_ident()}.tmp")
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


# Token de sesión en memoria y su día; main() lo carga al arrancar y current_session_token() lo renueva.
SESSION_TOKEN = ""
SESSION_TOKEN_DATE = ""
SESSION_TOKEN_LOCK = threading.Lock()


def current_session_token() -> str:
    """
    Token diario vigente: al cambiar el día carga o genera el nuevo, también con el servidor en marcha.
    Cada token abre una sesión: al cargarlo se olvidan, bajo el mismo cerrojo, las autorizaciones de sesión.
    """
    global SESSION_TOKEN, SESSION_TOKEN_DATE
    today = datetime.date.today().isoformat()
    with SESSION_TOKEN_LOCK:
        if SESSION_TOKEN_DATE != today:
            SESSION_TOKEN = get_daily_token()
            SESSION_TOKEN_DATE = today
            reset_session_authorizations()
        return SESSION_TOKEN
ACTIVE_PORT = DEFAULT_PORT
ACTIVE_HOST = DEFAULT_HOST


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

    def __init__(self, job_id: int, key: str | None, command: str, project: SecurityContext, background: bool, log_path: Path):
        self.id = job_id
        self.key = key
        self.command = command
        self.cwd = str(project.workspace_dir)
        self.project = project.key
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
    """
    Registro de los comandos lanzados en esta sesión del servidor. Cada comando es del proyecto en el que
    arrancó (su cwd): las consultas indican el proyecto y solo ven los suyos; None (al apagar) los ve todos.
    """

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

    def start(self, command: str, background: bool, project: SecurityContext, key: str | None = None) -> CommandJob:
        if not isinstance(command, str) or not command.strip():
            raise ValueError("The command is empty.")
        if key is not None and not (isinstance(key, str) and JOB_KEY_PATTERN.fullmatch(key)):
            key = None
        with self._lock:
            if sum(1 for job in self._jobs.values() if job.status == "running") >= MAX_RUNNING_JOBS:
                raise ValueError(
                    f"Too many commands running ({MAX_RUNNING_JOBS}). "
                    "Stop one with check_command(job_id, stop=true) before starting another."
                )
            self._prune()
            job_id = self._next_id
            self._next_id += 1
            job = CommandJob(job_id, key, command, project, background, self._session_dir() / f"job-{job_id}.log")
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
        if DETECTED_OS in ("linux", "android") and hasattr(os, "waitid"):
            # Esperar sin recoger al proceso mantiene reservado su grupo: así se puede matar a lo
            # que haya dejado en marcha sin riesgo de alcanzar a un grupo nuevo con el mismo número.
            try:
                os.waitid(os.P_PID, proc.pid, os.WEXITED | os.WNOWAIT)
                os.killpg(proc.pid, signal.SIGKILL)
            except (OSError, ChildProcessError):
                pass
            returncode = proc.wait()
        else:
            returncode = proc.wait()
            if DETECTED_OS != "windows":
                # En macOS waitid con WNOWAIT no vuelve al terminar el comando. Tras recogerlo, el grupo
                # sigue reservado mientras le quede algún proceso, que es justo lo que se mata.
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except OSError:
                    pass
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

    def get(self, project: str, job_id=None, key=None) -> CommandJob | None:
        jobs = self.list(project)
        if isinstance(job_id, int) and not isinstance(job_id, bool):
            return next((job for job in jobs if job.id == job_id), None)
        if isinstance(key, str) and key:
            return next((job for job in jobs if job.key == key), None)
        return None

    def list(self, project: str | None) -> list[CommandJob]:
        """Comandos del proyecto con esa clave (SecurityContext.key); None, los de todos."""
        with self._lock:
            return [job for job in self._jobs.values() if project is None or job.project == project]

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

    def report_finished(self, ids: list[int], project: str) -> list[dict]:
        """Final de los comandos indicados que han terminado sin que el modelo lo haya visto.

        Cada final se entrega una sola vez: queda marcado como visto.
        """
        reports = []
        for job_id in dict.fromkeys(ids):
            job = self.get(project, job_id=job_id)
            if job is None or not job.done.is_set() or job.reported:
                continue
            job.reported = True
            job.model_cursor = job.total
            tail = "\n".join(job.tail_text(REPORT_TAIL_BYTES).rstrip("\n").split("\n")[-REPORT_TAIL_LINES:])
            reports.append({**job.summary(), "tail": tail, "log_file": str(job.log_path)})
        return reports

    def running(self, project: str | None) -> list[CommandJob]:
        return [job for job in self.list(project) if not job.done.is_set()]

    def stop_all(self, reason: str = "shutdown"):
        threads = [threading.Thread(target=self.stop, args=(job, reason), daemon=True) for job in self.running(None)]
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


def run_command(command: str, timeout_seconds: int = COMMAND_DEFAULT_TIMEOUT, background: bool = False, job_key: str | None = None, *, ctx: SecurityContext) -> str:
    """Ejecuta un comando en una shell nueva en el directorio del proyecto."""
    try:
        job = JOBS.start(command, background=bool(background), project=ctx, key=job_key)
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


def check_command(job_id: int, wait_seconds: int = 0, stop: bool = False, *, ctx: SecurityContext) -> str:
    """Estado y salida nueva de un comando lanzado por run_command; puede esperarlo o detenerlo."""
    job = JOBS.get(ctx.key, job_id=job_id)
    if job is None:
        return _tool_error(f"Unknown job_id {job_id}. It may belong to a previous ZeroChat session or to another project.", os=DETECTED_OS)
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

# Visores gráficos que `git difftool` ya sabe lanzar, en orden de preferencia, con el ejecutable que los delata.
GUI_DIFF_TOOLS = {"vscode": "code", "meld": "meld", "kdiff3": "kdiff3", "kompare": "kompare", "gvimdiff": "gvim"}
# Respaldo cuando no hay ninguno: visor web que se instala en el entorno aislado de ZeroChat.
WEBDIFF_REQUIREMENT = "webdiff==1.4.0"
WEBDIFF_INSTALL_TIMEOUT_SECONDS = 120
DIFF_CONTEXT_LINES = 5


def _venv_webdiff() -> Path:
    """Ruta de webdiff dentro de ~/zerochat/.venv, junto al intérprete del entorno."""
    venv_python = get_venv_python(get_venv_dir())
    return venv_python.with_name("webdiff" + venv_python.suffix)


def _find_webdiff() -> str:
    """webdiff del entorno de ZeroChat o, si no, del PATH; '' si no hay ninguno."""
    venv_webdiff = _venv_webdiff()
    if venv_webdiff.exists():
        return str(venv_webdiff)
    return shutil.which("webdiff") or ""


def _diff_tool_settings(tool: str, webdiff_bin: str) -> list:
    """Pares (clave, valor) de git config que deja `tool` como visor gráfico; webdiff no es un visor integrado de git."""
    settings = [("diff.guitool", tool)]
    if tool == "webdiff":
        settings.insert(0, ("difftool.webdiff.cmd", f'"{webdiff_bin}" "$LOCAL" "$REMOTE"'))
    return settings


def detect_gui_diff_tool() -> dict:
    """Visor que proponer cuando Git no tiene ninguno: el primero instalado o, si no hay, webdiff.

    Incluye las órdenes exactas que aplicará configure_gui_diff_tool, para mostrarlas antes de confirmar.
    """
    tool = next((name for name, binary in GUI_DIFF_TOOLS.items() if shutil.which(binary)), "webdiff")
    webdiff_bin = _find_webdiff()
    return {
        "tool": tool,
        "install": tool == "webdiff" and not webdiff_bin,
        "commands": [
            shlex.join(["git", "config", "--global", key, value])
            for key, value in _diff_tool_settings(tool, webdiff_bin or str(_venv_webdiff()))
        ],
    }


def _install_webdiff() -> str:
    """Instala webdiff en ~/zerochat/.venv y devuelve la ruta del ejecutable."""
    ensure_virtual_environment()
    venv_python = get_venv_python(get_venv_dir())
    if not venv_python.exists():
        raise RuntimeError(f"No se pudo preparar el entorno virtual de ZeroChat: falta {venv_python}")
    res = subprocess.run(
        [str(venv_python), "-m", "pip", "install", WEBDIFF_REQUIREMENT],
        capture_output=True,
        text=True,
        timeout=WEBDIFF_INSTALL_TIMEOUT_SECONDS,
        check=False
    )
    if res.returncode != 0:
        raise RuntimeError(f"Error instalando webdiff: {(res.stderr or res.stdout).strip()[-500:]}")
    webdiff = _venv_webdiff()
    if not webdiff.exists():
        raise RuntimeError(f"webdiff se instaló pero no aparece en {webdiff}")
    return str(webdiff)


def configure_gui_diff_tool(tool) -> dict:
    """Deja `tool` como visor gráfico global de Git, instalando antes webdiff si es el elegido y falta."""
    if not isinstance(tool, str) or (tool != "webdiff" and tool not in GUI_DIFF_TOOLS):
        raise ValueError(f"Visor de diffs '{tool}' no reconocido.")
    git_bin = shutil.which("git")
    if not git_bin:
        raise RuntimeError("Git no está instalado o no se encuentra en el PATH del sistema.")

    webdiff_bin = ""
    if tool == "webdiff":
        webdiff_bin = _find_webdiff() or _install_webdiff()
    elif not shutil.which(GUI_DIFF_TOOLS[tool]):
        raise ValueError(f"'{GUI_DIFF_TOOLS[tool]}' no está en el PATH del sistema.")

    for key, value in _diff_tool_settings(tool, webdiff_bin):
        subprocess.run([git_bin, "config", "--global", key, value], capture_output=True, timeout=5, check=True)
    return {"tool": tool}


def _configured_gui_diff_tool(git_bin: str, repo_root: Path) -> str:
    """Herramienta gráfica que usaría `git difftool --gui`, o '' si no hay ninguna configurada."""
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


def _open_gui_file_diff(path: str, ctx: SecurityContext, commit_fallback: bool = False) -> dict:
    """Abre un visor externo de diffs (git difftool) en una ventana del sistema operativo."""
    if not isinstance(path, str) or not path.strip():
        raise ValueError("La ruta del archivo está vacía.")
    if len(path) > MAX_PATH_LENGTH:
        raise ValueError("La ruta del archivo excede el tamaño máximo permitido.")

    target = ctx.absolute(path)
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
        return {"success": False, "setup": detect_gui_diff_tool()}

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


def render_diff_html(
    diff_text: str,
    filename: str,
    rel_path: str = "",
    mode: str = "working_tree",
    commit: str | None = None,
    full_file_bytes: bytes | None = None
) -> str:
    """Genera una página HTML autocontenida y visualmente limpia con el diff para mostrar en una pestaña nueva."""
    diff_lines = diff_text.splitlines()
    rows = []
    old_num = 0
    new_num = 0
    in_hunk = False
    additions = 0
    deletions = 0

    hunk_re = re.compile(r"^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$")

    for line in diff_lines:
        hunk_match = hunk_re.match(line)
        if hunk_match:
            old_num = int(hunk_match.group(1))
            new_num = int(hunk_match.group(2))
            in_hunk = True
            rows.append({
                "type": "hunk",
                "old_num": "",
                "new_num": "",
                "sign": "@",
                "text": line,
            })
            continue

        if not in_hunk:
            rows.append({
                "type": "meta",
                "old_num": "",
                "new_num": "",
                "sign": " ",
                "text": line,
            })
            continue

        if line.startswith("+"):
            additions += 1
            rows.append({
                "type": "add",
                "old_num": "",
                "new_num": str(new_num),
                "sign": "+",
                "text": line[1:],
            })
            new_num += 1
        elif line.startswith("-"):
            deletions += 1
            rows.append({
                "type": "del",
                "old_num": str(old_num),
                "new_num": "",
                "sign": "-",
                "text": line[1:],
            })
            old_num += 1
        elif line.startswith(" "):
            rows.append({
                "type": "ctx",
                "old_num": str(old_num),
                "new_num": str(new_num),
                "sign": " ",
                "text": line[1:],
            })
            old_num += 1
            new_num += 1
        else:
            rows.append({
                "type": "meta",
                "old_num": "",
                "new_num": "",
                "sign": " ",
                "text": line,
            })

    table_rows = []
    for row in rows:
        r_type = row["type"]
        old_n = row["old_num"]
        new_n = row["new_num"]
        sign = html.escape(row["sign"])
        txt = html.escape(row["text"])
        table_rows.append(
            f'<tr class="row-{r_type}">'
            f'<td class="line-num">{old_n}</td>'
            f'<td class="line-num">{new_n}</td>'
            f'<td class="line-sign">{sign}</td>'
            f'<td class="line-code">{txt}</td>'
            f'</tr>'
        )

    mode_label = f"Commit {commit[:7]}" if (mode == "commit" and commit) else "Working Tree vs HEAD"
    display_title = filename or "diff"
    display_path = rel_path or filename or ""

    btn_html = ""
    script_html = ""
    if full_file_bytes is not None:
        b64_content = base64.b64encode(full_file_bytes).decode("ascii")
        btn_html = (
            '<button type="button" class="btn-full-file" onclick="openFullFile()">'
            '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
            '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>'
            '<polyline points="14 2 14 8 20 8"></polyline>'
            '<line x1="16" y1="13" x2="8" y2="13"></line>'
            '<line x1="16" y1="17" x2="8" y2="17"></line>'
            '<polyline points="10 9 9 9 8 9"></polyline>'
            '</svg>'
            '<span>Abrir fichero completo</span>'
            '</button>'
        )
        script_html = f"""  <script>
    function openFullFile() {{
      const b64 = "{b64_content}";
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {{
        bytes[i] = binary.charCodeAt(i);
      }}
      const blob = new Blob([bytes], {{ type: "text/plain;charset=utf-8" }});
      window.open(URL.createObjectURL(blob), "_blank");
    }}
  </script>"""

    return f"""<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Diff: {html.escape(display_title)}</title>
  <style>
    :root {{
      --bg: #ffffff;
      --fg: #1f2328;
      --header-bg: #f6f8fa;
      --border: #d0d7de;
      --hunk-bg: #ddf4ff;
      --hunk-fg: #0969da;
      --add-bg: #dafbe1;
      --add-fg: #1a7f37;
      --add-num-bg: #aceebb;
      --del-bg: #ffebe9;
      --del-fg: #cf222e;
      --del-num-bg: #ffd7d5;
      --meta-fg: #656d76;
      --linenum-fg: #8c959f;
      --linenum-bg: #f6f8fa;
      --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    }}
    @media (prefers-color-scheme: dark) {{
      :root {{
        --bg: #0d1117;
        --fg: #e6edf3;
        --header-bg: #161b22;
        --border: #30363d;
        --hunk-bg: rgba(56, 139, 253, 0.15);
        --hunk-fg: #58a6ff;
        --add-bg: rgba(46, 160, 67, 0.15);
        --add-fg: #3fb950;
        --add-num-bg: rgba(46, 160, 67, 0.25);
        --del-bg: rgba(248, 81, 73, 0.15);
        --del-fg: #f85149;
        --del-num-bg: rgba(248, 81, 73, 0.25);
        --meta-fg: #8b949e;
        --linenum-fg: #6e7681;
        --linenum-bg: #161b22;
      }}
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      padding: 16px;
      background: var(--bg);
      color: var(--fg);
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      line-height: 1.5;
    }}
    .diff-container {{
      max-width: 1400px;
      margin: 0 auto;
      border: 1px solid var(--border);
      border-radius: 6px;
      overflow: hidden;
      background: var(--bg);
    }}
    .diff-header {{
      padding: 12px 16px;
      background: var(--header-bg);
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 12px;
    }}
    .diff-title-group {{
      display: flex;
      align-items: baseline;
      gap: 10px;
      flex-wrap: wrap;
    }}
    .diff-title {{
      margin: 0;
      font-size: 16px;
      font-weight: 600;
      font-family: var(--font-mono);
    }}
    .diff-path {{
      font-size: 13px;
      color: var(--meta-fg);
      font-family: var(--font-mono);
    }}
    .diff-meta {{
      display: flex;
      gap: 10px;
      align-items: center;
    }}
    .diff-badge {{
      font-size: 12px;
      padding: 2px 8px;
      border-radius: 12px;
      border: 1px solid var(--border);
      background: var(--bg);
      color: var(--meta-fg);
      font-family: var(--font-mono);
    }}
    .diff-stat {{
      font-size: 13px;
      font-weight: 600;
      font-family: var(--font-mono);
    }}
    .stat-add {{ color: var(--add-fg); }}
    .stat-del {{ color: var(--del-fg); }}
    .btn-full-file {{
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 3px 10px;
      font-size: 12px;
      font-weight: 500;
      color: var(--fg);
      background: var(--header-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      cursor: pointer;
      font-family: inherit;
      transition: background 0.15s ease, border-color 0.15s ease;
    }}
    .btn-full-file:hover {{
      background: var(--border);
    }}
    .diff-table {{
      width: 100%;
      border-collapse: collapse;
      font-family: var(--font-mono);
      font-size: 12px;
      line-height: 1.45;
    }}
    .diff-table td {{
      padding: 1px 8px;
      vertical-align: top;
    }}
    .line-num {{
      width: 1%;
      min-width: 44px;
      text-align: right;
      color: var(--linenum-fg);
      background: var(--linenum-bg);
      user-select: none;
      border-right: 1px solid var(--border);
    }}
    .line-sign {{
      width: 1%;
      min-width: 20px;
      text-align: center;
      user-select: none;
      font-weight: bold;
    }}
    .line-code {{
      white-space: pre-wrap;
      word-break: break-all;
    }}
    .row-add {{ background: var(--add-bg); color: var(--add-fg); }}
    .row-add .line-num {{ background: var(--add-num-bg); }}
    .row-del {{ background: var(--del-bg); color: var(--del-fg); }}
    .row-del .line-num {{ background: var(--del-num-bg); }}
    .row-hunk {{
      background: var(--hunk-bg);
      color: var(--hunk-fg);
      border-top: 1px solid var(--border);
      border-bottom: 1px solid var(--border);
    }}
    .row-meta {{ color: var(--meta-fg); background: var(--header-bg); }}
  </style>
</head>
<body>
  <div class="diff-container">
    <header class="diff-header">
      <div class="diff-title-group">
        <h1 class="diff-title">{html.escape(display_title)}</h1>
        {f'<span class="diff-path">{html.escape(display_path)}</span>' if display_path != display_title else ''}
      </div>
      <div class="diff-meta">
        <span class="diff-badge">{html.escape(mode_label)}</span>
        <span class="diff-stat stat-add">+{additions}</span>
        <span class="diff-stat stat-del">-{deletions}</span>
        {btn_html}
      </div>
    </header>
    <table class="diff-table">
      <tbody>
        {"".join(table_rows)}
      </tbody>
    </table>
  </div>
  {script_html}
</body>
</html>"""


def generate_file_diff(path: str, ctx: SecurityContext, commit_fallback: bool = False, context_lines: int = DIFF_CONTEXT_LINES) -> dict:
    """Calcula y devuelve el diff de un archivo frente a Git HEAD o su último commit, incluyendo HTML."""
    if not isinstance(path, str) or not path.strip():
        raise ValueError("La ruta del archivo está vacía.")
    if len(path) > MAX_PATH_LENGTH:
        raise ValueError("La ruta del archivo excede el tamaño máximo permitido.")

    target = ctx.absolute(path)
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
    rel_path = target.name
    try:
        rel_path = target.relative_to(repo_root).as_posix()
    except ValueError:
        pass

    if has_head:
        try:
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

    mode = "working_tree"
    last_commit = ""
    diff_text = ""

    if has_working_tree_diff:
        if in_head:
            cmd = [git_bin, "diff", f"-U{context_lines}", "HEAD", "--", str(target)]
        else:
            cmd = [git_bin, "diff", f"-U{context_lines}", "--no-index", "--", os.devnull, str(target)]
        diff_res = subprocess.run(cmd, cwd=str(repo_root), capture_output=True, text=True, timeout=10, check=False)
        diff_text = diff_res.stdout
    else:
        # No hay cambios pendientes en el árbol de trabajo. Comprobar historial del archivo.
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
            cmd = [git_bin, "diff", f"-U{context_lines}", f"{last_commit}~1", last_commit, "--", str(target)]
        else:
            cmd = [git_bin, "diff", f"-U{context_lines}", "4b825dc642cb6eb9a060e54bf8d69288fbee4904", last_commit, "--", str(target)]
        diff_res = subprocess.run(cmd, cwd=str(repo_root), capture_output=True, text=True, timeout=10, check=False)
        diff_text = diff_res.stdout

    if not diff_text.strip():
        return {
            "success": True,
            "has_diff": False,
            "in_head": in_head,
            "has_commit_history": bool(last_commit),
            "last_commit": last_commit or None,
            "path": str(target)
        }

    full_file_bytes = None
    if mode == "commit" and last_commit:
        show_res = subprocess.run(
            [git_bin, "show", f"{last_commit}:{rel_path}"],
            cwd=str(repo_root),
            capture_output=True,
            timeout=5,
            check=False
        )
        if show_res.returncode == 0:
            full_file_bytes = show_res.stdout
    if full_file_bytes is None:
        try:
            if target.is_file() and target.stat().st_size <= 5_000_000:
                full_file_bytes = target.read_bytes()
        except (OSError, PermissionError):
            full_file_bytes = None

    html_content = render_diff_html(
        diff_text=diff_text,
        filename=target.name,
        rel_path=rel_path,
        mode=mode,
        commit=last_commit or None,
        full_file_bytes=full_file_bytes
    )

    return {
        "success": True,
        "has_diff": True,
        "mode": mode,
        "path": str(target),
        "in_head": in_head,
        "commit": last_commit or None,
        "diff": diff_text,
        "html": html_content
    }


def open_file_diff(path: str, ctx: SecurityContext, commit_fallback: bool = False, gui: bool = False, context_lines: int = DIFF_CONTEXT_LINES) -> dict:
    """Obtiene el diff de un archivo asociado a Git.

    Por defecto genera el diff con el visor propio de ZeroChat (HTML y texto), apto para
    ejecución local y remota sin depender de visores gráficos instalados en el sistema operativo.
    Con `gui=True` lanza el visor gráfico externo configurado en Git (difftool).
    """
    if gui:
        return _open_gui_file_diff(path, ctx, commit_fallback)
    return generate_file_diff(path, ctx, commit_fallback, context_lines=context_lines)

# ==============================================================================
# Generated from services/ by scripts/build-managed-services.mjs. Do not edit.
# ==============================================================================

MANAGED_SERVICE_FILES: dict[str, str] = json.loads("{\n  \"composio/installer.json\": \"{\\n  \\\"schemaVersion\\\": 1,\\n  \\\"type\\\": \\\"npm\\\",\\n  \\\"product\\\": {\\n    \\\"package\\\": \\\"mcp-remote\\\",\\n    \\\"version\\\": \\\"0.13.5\\\"\\n  },\\n  \\\"requirements\\\": {\\n    \\\"node\\\": {\\n      \\\"minimumMajor\\\": 18\\n    }\\n  }\\n}\\n\",\n  \"composio/service.json\": \"{\\n  \\\"schemaVersion\\\": 1,\\n  \\\"id\\\": \\\"composio\\\",\\n  \\\"displayName\\\": {\\n    \\\"es\\\": \\\"Composio Connect\\\",\\n    \\\"en\\\": \\\"Composio Connect\\\"\\n  },\\n  \\\"description\\\": {\\n    \\\"es\\\": \\\"MCP remoto para acceder a aplicaciones como Gmail, Google Drive, Slack o GitHub. Composio solicita la autorización de cada aplicación cuando sea necesaria.\\\",\\n    \\\"en\\\": \\\"Remote MCP for apps such as Gmail, Google Drive, Slack, and GitHub. Composio requests authorization for each app when it is needed.\\\"\\n  },\\n  \\\"help\\\": {\\n    \\\"url\\\": \\\"https://docs.composio.dev/docs/composio-connect\\\",\\n    \\\"label\\\": {\\n      \\\"es\\\": \\\"Guía oficial de Composio Connect\\\",\\n      \\\"en\\\": \\\"Composio Connect official guide\\\"\\n    }\\n  },\\n  \\\"enabledByDefault\\\": false,\\n  \\\"transport\\\": \\\"stdio\\\",\\n  \\\"remote\\\": {\\n    \\\"type\\\": \\\"mcp-remote\\\",\\n    \\\"transport\\\": \\\"streamable-http\\\",\\n    \\\"url\\\": \\\"https://connect.composio.dev/mcp\\\",\\n    \\\"authentication\\\": \\\"composio-connect\\\"\\n  },\\n  \\\"launch\\\": {\\n    \\\"executable\\\": \\\"${nodeExecutable}\\\",\\n    \\\"args\\\": [\\n      \\\"${serviceDir}/node_modules/mcp-remote/dist/proxy.js\\\",\\n      \\\"https://connect.composio.dev/mcp\\\",\\n      \\\"--protocol\\\",\\n      \\\"legacy\\\",\\n      \\\"--static-oauth-client-metadata\\\",\\n      \\\"{\\\\\\\"client_name\\\\\\\":\\\\\\\"zerochat-mcp-remote\\\\\\\"}\\\",\\n      \\\"--auth-timeout\\\",\\n      \\\"120\\\"\\n    ],\\n    \\\"cwd\\\": \\\"${serviceDir}\\\",\\n    \\\"env\\\": {\\n      \\\"HOME\\\": \\\"${serviceDir}\\\",\\n      \\\"USERPROFILE\\\": \\\"${serviceDir}\\\"\\n    },\\n    \\\"handshakeTimeoutSeconds\\\": 150\\n  }\\n}\\n\",\n  \"ejemplo/ejemplo_mcp_server.py\": \"#!/usr/bin/env python3\\nimport json\\nimport sys\\n\\ndef reply(req_id, result=None, error=None):\\n    resp = {\\\"jsonrpc\\\": \\\"2.0\\\", \\\"id\\\": req_id}\\n    if error:\\n        resp[\\\"error\\\"] = error\\n    else:\\n        resp[\\\"result\\\"] = result\\n    sys.stdout.write(json.dumps(resp) + \\\"\\\\n\\\")\\n    sys.stdout.flush()\\n\\nfor raw in sys.stdin:\\n    try:\\n        req = json.loads(raw)\\n    except Exception:\\n        continue\\n    req_id = req.get(\\\"id\\\")\\n    method = req.get(\\\"method\\\")\\n    params = req.get(\\\"params\\\", {})\\n    if method == \\\"initialize\\\":\\n        reply(req_id, {\\n            \\\"protocolVersion\\\": \\\"2024-11-05\\\",\\n            \\\"serverInfo\\\": {\\\"name\\\": \\\"ZeroChat MCP Example\\\", \\\"version\\\": \\\"1.0.0\\\"},\\n            \\\"capabilities\\\": {\\\"tools\\\": {}}\\n        })\\n    elif method == \\\"tools/list\\\":\\n        reply(req_id, {\\\"tools\\\": [{\\n            \\\"name\\\": \\\"echo\\\",\\n            \\\"description\\\": \\\"Echo back a message for testing.\\\",\\n            \\\"inputSchema\\\": {\\n                \\\"type\\\": \\\"object\\\",\\n                \\\"properties\\\": {\\\"message\\\": {\\\"type\\\": \\\"string\\\", \\\"description\\\": \\\"Message to echo.\\\"}},\\n                \\\"required\\\": [\\\"message\\\"]\\n            }\\n        }]})\\n    elif method == \\\"tools/call\\\":\\n        if params.get(\\\"name\\\") != \\\"echo\\\":\\n            reply(req_id, error={\\\"code\\\": -32601, \\\"message\\\": \\\"Tool not found\\\"})\\n            continue\\n        msg = params.get(\\\"arguments\\\", {}).get(\\\"message\\\", \\\"\\\")\\n        reply(req_id, {\\n            \\\"content\\\": [{\\\"type\\\": \\\"text\\\", \\\"text\\\": f\\\"echo: {msg}\\\"}],\\n            \\\"isError\\\": False\\n        })\\n\",\n  \"ejemplo/installer.json.example\": \"{\\n  \\\"schemaVersion\\\": 1,\\n  \\\"type\\\": \\\"npm\\\",\\n  \\\"product\\\": {\\n    \\\"package\\\": \\\"@scope/mcp-package\\\",\\n    \\\"version\\\": \\\"1.2.3\\\"\\n  },\\n  \\\"requirements\\\": {\\n    \\\"node\\\": {\\n      \\\"minimumMajor\\\": 18\\n    }\\n  }\\n}\\n\",\n  \"ejemplo/README.md\": \"# Crear un MCP gestionado por ZeroChat\\n\\nEsta carpeta es la referencia para crear servicios MCP gestionados. La ubicación de producción es el directorio personal del usuario, seguido de `zerochat/services` (por ejemplo, `/home/usuario/zerochat/services`). No uses `~`, `$HOME` ni una ruta relativa como `services/`: primero identifica la ruta absoluta del directorio personal y úsala para localizar este archivo. El nuevo servicio se crea como carpeta hermana de `ejemplo`, nunca dentro de ella.\\n\\n## Procedimiento obligatorio\\n\\n1. Lee `README.md`, `service.json` y `installer.json.example` de la carpeta `ejemplo` situada en el directorio de datos de ZeroChat.\\n2. Consulta solo la documentación oficial del MCP solicitado.\\n3. Crea una carpeta con un identificador seguro y descriptivo junto a `ejemplo`. Usa un `id` único en `service.json`, también cuando copies otro servicio.\\n4. Crea `service.json` copiando esta estructura y adapta únicamente los valores necesarios.\\n5. Crea `installer.json` solo si el MCP se distribuye como paquete npm. Copia `installer.json.example`, fija la versión exacta y declara la versión mínima de Node.js.\\n6. Añade `help.url` con la página oficial de instalación y etiquetas en español e inglés.\\n7. Si requiere una API key, declara la variable que exige el MCP en el objeto `env` de `launch` dentro de `service.json` con el valor literal `PASTE_API_KEY_HERE`. No pidas la clave al usuario ni la escribas en el chat: indica la ruta absoluta del JSON y el campo que debe editar a mano. El usuario guardará su clave únicamente en el JSON local de su carpeta propia.\\n8. Evalúa la concurrencia y la compatibilidad con ejecuciones paralelas y desatendidas antes de guardar: el servicio no debe usar puertos fijos, debe arrancar en modo efímero o aislado si maneja estado de sesión, y no debe depender de entradas interactivas por consola o ventanas emergentes durante la ejecución.\\n9. No instales ni inicies el servicio. Al terminar, informa de los archivos creados, fuentes oficiales y requisitos pendientes.\\n\\n## Límites de ZeroChat\\n\\nZeroChat gestiona procesos MCP por `stdio`. Puede instalar paquetes npm mediante `installer.json` y arrancarlos con `${nodeExecutable}`. También puede arrancar un ejecutable o script ya disponible con `launch`.\\n\\nZeroChat también puede usar `mcp-remote` como puente para un MCP remoto HTTP/SSE con OAuth o API key. Decláralo como un servicio `stdio`: el proceso local debe ser `mcp-remote`, mientras que `remote` describe el endpoint remoto para la interfaz. Conserva las credenciales y el almacén OAuth dentro de `${serviceDir}`.\\n\\n## Contratos JSON\\n\\n- `service.json` es obligatorio. Conserva `schemaVersion`, `id`, textos bilingües, `transport: \\\"stdio\\\"` y `launch`.\\n- En `launch`, usa `${serviceDir}`, `${nodeExecutable}` o `${pythonExecutable}`; no uses rutas absolutas de usuario.\\n- `launch.handshakeTimeoutSeconds` (15 s por defecto) limita el arranque y `launch.callTimeoutSeconds` (30 s por defecto) cada llamada a una herramienta; súbelo para MCP lentos, como la automatización de navegador.\\n- `installer.json` es opcional y hoy solo admite `type: \\\"npm\\\"`.\\n- `help` es opcional, pero debe incluirse en todo servicio creado:\\n\\n```json\\n\\\"help\\\": {\\n  \\\"url\\\": \\\"https://documentacion-oficial.example/install\\\",\\n  \\\"label\\\": { \\\"es\\\": \\\"Instalación oficial\\\", \\\"en\\\": \\\"Official installation\\\" }\\n}\\n```\\n\\n## Concurrencia y ejecuciones paralelas\\n\\nTodo servicio MCP debe diseñarse para permitir invocaciones simultáneas (varias pestañas, múltiples sesiones o ejecuciones paralelas en línea de comandos como `zerochat --prompt`):\\n\\n1. **Aislamiento y modo efímero por defecto**: los servicios que gestionan navegadores o sesiones de ejecución deben iniciar por defecto en modo volátil en memoria (como `--isolated` en Playwright) o en directorios temporales independientes. No deben depender de un único perfil o carpeta de usuario fija compartida que imponga bloqueos de proceso (`SingletonLock` en Chromium, bloqueos de ficheros de sesión). Si se ofrece persistencia, debe ser opcional y parametrizable por perfil o almacenamiento nombrado.\\n2. **Transporte exclusivo por `stdio`**: los servidores MCP locales se comunican exclusivamente por entrada y salida estándar. Si un ejecutable o biblioteca interna abre un socket o servidor HTTP local auxiliar, nunca debe fijar un puerto estático (como `8080`), pues causará errores `EADDRINUSE` ante dos procesos concurrentes; debe asignar puertos dinámicos (`port: 0` o rango efímero).\\n3. **Persistencia coordinada o aislada**: si el servicio persiste datos en disco (como bases de datos SQLite locales o archivos planos JSON/JSONL), la ruta no debe ser fija y compartida si el motor no gestiona concurrencia multi-proceso. SQLite debe operar con modo WAL y timeout de ocupación (`busy_timeout`); ficheros planos sin bloqueo interproceso como `memory.jsonl` deben reservarse a una única sesión activa o aislarse por perfil/espacio de trabajo.\\n4. **Ejecución desatendida y sin interacción en tiempo de ejecución**: el proceso nunca debe abrir ventanas emergentes, diálogos gráficos ni solicitar confirmación interactiva por consola. Todas las credenciales o parámetros se configuran previamente vía `launch.env` o argumentos. Los flujos de autorización interactiva (como el inicio de sesión OAuth inicial de `mcp-remote`) son incompatibles con sesiones desatendidas y paralelas; deben completarse de forma supervisada antes de iniciar ejecuciones automáticas.\\n\\n### Comportamiento de los servicios incluidos\\n\\n- **`playwright`**: seguro para ejecución paralela. Arranca por defecto con `--isolated` en memoria sin bloquear perfiles de usuario. Permite almacenamiento persistente opcional nombrado por perfil (`storage`).\\n- **`memory`**: persistencia monoproceso en `${serviceDir}/memory.jsonl`. No implementa sincronización atómica entre procesos; no debe compartirse simultáneamente entre varias tareas que escriban entidades a la vez.\\n- **`composio`**: puente remoto vía `mcp-remote`. El flujo OAuth inicial es interactivo y no funciona en segundo plano ni en paralelo; tras autorizarse, las consultas remotas operan concurrentemente.\\n- **`ejemplo`**: servidor de prueba en memoria por `stdio`, 100% seguro para concurrencia.\\n\\n## Prompt para el usuario\\n\\nSustituye únicamente `<nombre-del-mcp>`:\\n\\n```text\\nPara instalar el MCP <nombre-del-mcp>, lee primero services/ejemplo/README.md y sigue exactamente sus instrucciones.\\n```\\n\\n## Servicios remotos y claves API\\n\\n`launch.env` es el objeto `env` dentro de `launch` en `service.json`, no un archivo. El agente deja únicamente el marcador; el usuario introduce la clave real a mano en ese JSON. No crees un archivo `launch.env` o `.env`.\\n\\nPara un remoto, lee también `service.json` e `installer.json` de la carpeta hermana `composio`. Crea una carpeta nueva con nombre e `id` propios; usa Composio como ejemplo del puente local, conservando `transport: \\\"stdio\\\"`. Consulta la documentación oficial del proveedor y de [mcp-remote](https://github.com/punkpeye/mcp-remote#custom-headers) para adaptar endpoint, transporte, cabeceras y autenticación. No copies sin verificar las opciones `--protocol`, los metadatos de cliente ni los parámetros OAuth específicos de Composio. Conserva `HOME` y `USERPROFILE` dentro de `${serviceDir}`.\\n\\nPara un MCP local que requiera una variable, deja este campo dentro de `launch`, conservando sus demás campos y usando el nombre de variable documentado por el MCP:\\n\\n```json\\n\\\"env\\\": {\\n  \\\"SERVICE_API_KEY\\\": \\\"PASTE_API_KEY_HERE\\\"\\n}\\n```\\n\\nPara un remoto que acepte `Authorization: Bearer`, los campos dentro de `launch` pueden ser:\\n\\n```json\\n\\\"args\\\": [\\n  \\\"${serviceDir}/node_modules/mcp-remote/dist/proxy.js\\\",\\n  \\\"https://mcp.example.com/mcp\\\",\\n  \\\"--header\\\",\\n  \\\"Authorization: Bearer ${REMOTE_API_KEY}\\\"\\n],\\n\\\"env\\\": {\\n  \\\"HOME\\\": \\\"${serviceDir}\\\",\\n  \\\"USERPROFILE\\\": \\\"${serviceDir}\\\",\\n  \\\"REMOTE_API_KEY\\\": \\\"PASTE_API_KEY_HERE\\\"\\n}\\n```\\n\\nAdapta la cabecera y su formato a lo que exige el proveedor. `remote.authentication` solo describe el servicio; no configura la autenticación. La referencia `${REMOTE_API_KEY}` en la cabecera la resuelve `mcp-remote`. ZeroChat no resuelve variables de entorno genéricas: en `launch.env`, `${SERVICE_API_KEY}` se pasaría como texto literal. Solo sustituye `${serviceDir}`, `${nodeExecutable}`, `${pythonExecutable}` y `${option:...}`. No pongas claves reales en argumentos ni en URLs.\\n\\n### Pasos para el usuario\\n\\n1. Usa una carpeta propia bajo el directorio de servicios, con nombre e `id` únicos. Si copias un servicio incluido, copia sus definiciones, no sus dependencias ni credenciales OAuth. No edites `ejemplo`, `composio`, `playwright` ni `memory`: sus archivos distribuidos se restauran al arrancar.\\n2. Abre el `service.json` de tu carpeta y sustituye `PASTE_API_KEY_HERE` por la clave real en `launch.env`. Mantén el JSON válido y los demás campos. No necesitas `export`, `.env` ni otro JSON de credenciales.\\n3. Restringe el archivo a tu usuario con `chmod 600 /ruta/absoluta/zerochat/services/mi-servicio/service.json` en Linux o Termux. La clave queda en texto plano: no compartas el archivo ni lo subas al repositorio o al chat.\\n4. Inicia el servicio desde Ajustes → MCP. Si la nueva carpeta no aparece, reinicia ZeroChat y conecta de nuevo. Para cambiar una clave, detén primero el servicio, edita el JSON y vuelve a iniciarlo.\\n5. ZeroChat conserva los servicios propios al reiniciar y actualizar. Borrar el directorio de datos elimina también esas claves: guarda una copia privada si la necesitas.\\n\\n## English: creating local and remote services\\n\\n1. Locate the user's absolute home directory and read `README.md`, `service.json` and `installer.json.example` in `zerochat/services/ejemplo`.\\n2. Read the requested MCP's official documentation. Create a sibling folder with its own name and unique JSON `id`; do not modify bundled definitions. Preserve bilingual text, `schemaVersion`, `transport: \\\"stdio\\\"`, `launch` and official `help` links. `launch.handshakeTimeoutSeconds` (default 15 s) bounds startup and `launch.callTimeoutSeconds` (default 30 s) each tool call; raise it for slow MCPs such as browser automation.\\n3. For npm services, add `installer.json` with an exact package version and minimum Node.js major version. Otherwise use an existing executable or script.\\n4. For remote HTTP/SSE MCPs, also read the sibling `composio` JSON files and use its managed `mcp-remote` bridge as the example. Adapt endpoint, transport and authentication to the official provider and bridge documentation. Verify Composio-specific protocol and OAuth options before copying them. Keep `HOME` and `USERPROFILE` isolated inside `${serviceDir}`.\\n5. If an API key is required, put the literal `PASTE_API_KEY_HERE` under the required variable in the `env` object under `launch` inside `service.json`. `launch.env` is a JSON field, not a file. The user enters the actual key manually in that JSON; do not create a `launch.env` or `.env` file. Do not request the user's key or place real secrets in chat, arguments or URLs. Give the absolute JSON path and exact field to edit. For remote header authentication, use `--header` with the provider's required header and a reference to the variable, as shown above; `mcp-remote` resolves that reference. `remote.authentication` is descriptive only.\\n6. Evaluate concurrency and headless compatibility before finalizing: ensure the service avoids static ports, runs in ephemeral/isolated mode by default if managing session state, and does not require interactive console prompts or graphical windows.\\n7. Do not install or start the service. Report created files, official sources and outstanding requirements; the user will start it from Settings → MCP.\\n\\n### Concurrency and parallel execution\\n\\nAll MCP services must be designed to support simultaneous executions (multiple browser tabs, concurrent sessions, or parallel headless CLI tasks like `zerochat --prompt`):\\n\\n1. **Isolated and ephemeral by default**: execution environments or browser engines must default to in-memory or isolated sessions (such as `--isolated` in Playwright) without locking shared profile directories across processes. Persistent state must be optional and parameterized by profile or named storage.\\n2. **Pure `stdio` transport**: local MCP processes communicate strictly through standard input and output. If a process starts an auxiliary internal HTTP/TCP listener, it must bind dynamic ephemeral ports (`port: 0`), never static ports that collide with `EADDRINUSE`.\\n3. **Safe persistent storage**: if persisting data to disk (e.g., SQLite or flat JSON/JSONL files), ensure the storage engine supports multi-process writes (SQLite with WAL and busy timeout). Flat files without process locking (such as `memory.jsonl`) should be isolated per session/workspace rather than shared across parallel writers.\\n4. **Unattended headless execution**: MCPs must never display GUI popups, interactive prompts, or console confirmation during execution. Secrets and settings must be supplied via `launch.env`. Interactive authorization flows (such as initial browser-based OAuth) must be completed in an interactive session beforehand; they cannot run unattended or in parallel.\\n\\n#### Bundled services concurrency summary\\n\\n- **`playwright`**: parallel-safe; defaults to in-memory `--isolated` mode with optional named profile storage.\\n- **`memory`**: single-process JSONL persistence (`memory.jsonl`); concurrent writes can overwrite data.\\n- **`composio`**: remote bridge via `mcp-remote`; initial OAuth is strictly interactive, while post-auth tool calls support parallel requests.\\n- **`ejemplo`**: stateless in-memory `stdio` echo server, fully parallel-safe.\\n\\nThe user replaces `PASTE_API_KEY_HERE` directly in their own folder's JSON, preserves valid JSON and existing fields, and restricts the file with `chmod 600 /absolute/path/zerochat/services/my-service/service.json` on Linux/Termux. No shell export, `.env` or separate credentials JSON is needed. ZeroChat only expands service/interpreter paths and `${option:...}`, not generic environment placeholders in `launch.env`. The key is stored in plain text: do not share or commit the file or paste it into chat.\\n\\nIf a new folder does not appear, restart ZeroChat and reconnect. Stop an active service before editing its key, then start it again. User-created folders survive restarts and updates. Bundled definitions are restored on startup: copy them into a new folder and change the JSON `id` to customize them, without copying dependencies or OAuth credentials. Deleting the data directory also deletes custom services and their keys; keep a private backup if needed.\\n\",\n  \"ejemplo/service.json\": \"{\\n  \\\"schemaVersion\\\": 1,\\n  \\\"id\\\": \\\"ejemplo\\\",\\n  \\\"displayName\\\": {\\n    \\\"es\\\": \\\"Ejemplo de MCP\\\",\\n    \\\"en\\\": \\\"MCP example\\\"\\n  },\\n  \\\"description\\\": {\\n    \\\"es\\\": \\\"Plantilla mínima para crear servicios MCP gestionados por ZeroChat. Muestra el protocolo stdio y la estructura de configuración que debe seguir un nuevo MCP.\\\",\\n    \\\"en\\\": \\\"Minimal template for creating ZeroChat-managed MCP services. It demonstrates the stdio protocol and configuration structure for a new MCP.\\\"\\n  },\\n  \\\"help\\\": {\\n    \\\"url\\\": \\\"help/mcp.html#crear-mcp-con-agente\\\",\\n    \\\"label\\\": {\\n      \\\"es\\\": \\\"Guía para crear un MCP gestionado\\\",\\n      \\\"en\\\": \\\"Guide to creating a managed MCP\\\"\\n    }\\n  },\\n  \\\"enabledByDefault\\\": false,\\n  \\\"transport\\\": \\\"stdio\\\",\\n  \\\"launch\\\": {\\n    \\\"executable\\\": \\\"${pythonExecutable}\\\",\\n    \\\"args\\\": [\\\"${serviceDir}/ejemplo_mcp_server.py\\\"],\\n    \\\"cwd\\\": \\\"${serviceDir}\\\",\\n    \\\"env\\\": {},\\n    \\\"handshakeTimeoutSeconds\\\": 10\\n  }\\n}\\n\",\n  \"memory/installer.json\": \"{\\n  \\\"schemaVersion\\\": 1,\\n  \\\"type\\\": \\\"npm\\\",\\n  \\\"product\\\": {\\n    \\\"package\\\": \\\"@modelcontextprotocol/server-memory\\\",\\n    \\\"version\\\": \\\"2026.8.31\\\"\\n  },\\n  \\\"requirements\\\": {\\n    \\\"node\\\": {\\n      \\\"minimumMajor\\\": 18\\n    }\\n  }\\n}\\n\",\n  \"memory/service.json\": \"{\\n  \\\"schemaVersion\\\": 1,\\n  \\\"id\\\": \\\"memory\\\",\\n  \\\"displayName\\\": {\\n    \\\"es\\\": \\\"Memoria y Grafos (Knowledge Graph)\\\",\\n    \\\"en\\\": \\\"Memory & Knowledge Graph\\\"\\n  },\\n  \\\"description\\\": {\\n    \\\"es\\\": \\\"Almacenamiento persistente de entidades, preferencias y contexto histórico estructurado en un grafo de conocimiento.\\\",\\n    \\\"en\\\": \\\"Persistent storage of entities, preferences, and historical context structured as a knowledge graph.\\\"\\n  },\\n  \\\"enabledByDefault\\\": false,\\n  \\\"transport\\\": \\\"stdio\\\",\\n  \\\"launch\\\": {\\n    \\\"executable\\\": \\\"${nodeExecutable}\\\",\\n    \\\"args\\\": [\\\"${serviceDir}/node_modules/@modelcontextprotocol/server-memory/dist/index.js\\\"],\\n    \\\"cwd\\\": \\\"${serviceDir}\\\",\\n    \\\"env\\\": {\\n      \\\"MEMORY_FILE_PATH\\\": \\\"${serviceDir}/memory.jsonl\\\"\\n    },\\n    \\\"handshakeTimeoutSeconds\\\": 30\\n  }\\n}\\n\\n\",\n  \"playwright/installer.json\": \"{\\n  \\\"schemaVersion\\\": 1,\\n  \\\"type\\\": \\\"npm\\\",\\n  \\\"product\\\": {\\n    \\\"package\\\": \\\"@playwright/mcp\\\",\\n    \\\"version\\\": \\\"0.0.81\\\",\\n    \\\"browser\\\": \\\"chromium\\\"\\n  },\\n  \\\"requirements\\\": {\\n    \\\"node\\\": {\\n      \\\"minimumMajor\\\": 18\\n    }\\n  }\\n}\\n\",\n  \"playwright/service.json\": \"{\\n  \\\"schemaVersion\\\": 1,\\n  \\\"id\\\": \\\"playwright\\\",\\n  \\\"displayName\\\": {\\n    \\\"es\\\": \\\"Playwright MCP\\\",\\n    \\\"en\\\": \\\"Playwright MCP\\\"\\n  },\\n  \\\"description\\\": {\\n    \\\"es\\\": \\\"Automatización de navegador mediante el servidor MCP oficial de Playwright.\\\",\\n    \\\"en\\\": \\\"Browser automation through the official Playwright MCP server.\\\"\\n  },\\n  \\\"enabledByDefault\\\": false,\\n  \\\"transport\\\": \\\"stdio\\\",\\n  \\\"launch\\\": {\\n    \\\"executable\\\": \\\"${nodeExecutable}\\\",\\n    \\\"args\\\": [\\\"${serviceDir}/node_modules/@playwright/mcp/cli.js\\\"],\\n    \\\"cwd\\\": \\\"${serviceDir}\\\",\\n    \\\"env\\\": {},\\n    \\\"handshakeTimeoutSeconds\\\": 30,\\n    \\\"callTimeoutSeconds\\\": 120\\n  }\\n}\\n\"\n}")


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
# Motor de Control de Acceso y Seguridad de Herramientas (AccessController)
# ==============================================================================

GLOBAL_POLICY_ASK = "ask"
GLOBAL_POLICY_ALLOW_ALL = "allow_all"
GLOBAL_POLICY_WORKSPACE_TRUST = "workspace_trust"
GLOBAL_POLICIES = (GLOBAL_POLICY_ASK, GLOBAL_POLICY_ALLOW_ALL, GLOBAL_POLICY_WORKSPACE_TRUST)

POLICY_ALLOW = "allow"
POLICY_DENY = "deny"
POLICY_ASK = "ask"

SCOPE_PERMANENT = "permanent"
SCOPE_SESSION = "session"

POLICY_STATE_VERSION = 6
CHALLENGE_TTL_MS = 600_000
AUTHORIZE_DECISIONS = ("allow_once", "allow_session", "allow_project", "allow_always", "allow_server_always")
MAX_POLICY_ENTRIES = 500
# Proyectos con sesión en memoria: al pasar del tope se olvida la del usado hace más tiempo sin comandos en marcha.
MAX_PROJECT_SESSIONS = 16

DIRECTORY_RULE_PATTERN = re.compile(r"^(R|W|RW):(.+)$")
COMMAND_TOOL = "run_command"
JOB_CONTROL_TOOL = "check_command"
# Herramientas integradas que acceden al sistema de archivos por su argumento de ruta.
READ_PATH_TOOLS = frozenset(("read_file", "list_directory", "search_files", "get_diagnostics"))
WRITE_PATH_TOOLS = frozenset(("edit_file", "write_file"))
DIRECTORY_PATH_TOOLS = frozenset(("list_directory", "search_files", "get_diagnostics"))

MAX_COMMAND_PATTERNS = 50
COMMAND_PATTERN_FORBIDDEN = re.compile(r"[;&|<>$`'\"\\\n\r]")
# Lo que nunca cubre un comodín: expansión de la shell (variables, llaves, comillas invertidas, ~ inicial),
# un segmento '..' o un glob que lo alcance ('.?'), y en los argumentos del '*' final, una ruta absoluta.
COMMAND_WILDCARD_UNSAFE = re.compile(r"[$`{}]|(?:^|[=:])~|(?:^|[/\\=:])\.\.(?:[/\\]|$)|(?:^|/)\.[^/]*[*?\[]")
COMMAND_ABSOLUTE_ARG = re.compile(r"(?:^|[=:])(?:[/\\]|[A-Za-z]:[/\\])")
SYSTEM_BIN_DIRS = ("/usr/bin/", "/bin/", "/usr/local/bin/")
SUBCOMMAND_TOKEN = re.compile(r"[A-Za-z][A-Za-z0-9_.:-]*")

SAFE_REDIRECTION_PATTERN = re.compile(r"&>\s*/dev/null|\d?>>?\s*/dev/null|\d?>&\d")
# Lo que impide validar un comando por partes: sustitución de comandos o de procesos y saltos de línea.
SHELL_SPLIT_UNSUPPORTED = re.compile(r"[`\n\r]|\$\(|[<>]\(")
# Palabras que cambian cómo se ejecuta lo que sigue (bloques, bucles, prefijos o cambios de carpeta ocultos).
SHELL_KEYWORDS = frozenset(["if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac",
                            "select", "function", "{", "}", "!", "[[", "time", "coproc", "pushd", "popd", "builtin",
                            "set-location", "sl", "chdir", "push-location", "pop-location"])
ENV_ASSIGNMENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*=.*")
# Un cd a una carpeta que solo la shell conoce: variables, ~, comodines o la anterior.
CD_UNSAFE_TARGET = re.compile(r"[$~*?\[{]")

WORKSPACE_TRUST_PIPE_FILTERS = frozenset([
    "head", "tail", "grep", "egrep", "fgrep", "rg", "wc", "sort", "uniq", "cut", "tr", "column", "nl", "cat", "jq"
])
WORKSPACE_TRUST_GLOBAL_COMMANDS = re.compile(r"(?:^|\s)(?:sudo|su|doas|mkfs|reboot|shutdown|systemctl)\b")
WORKSPACE_TRUST_OUTSIDE_REFERENCE = re.compile(r"(?:^|[\s=:'\"])(?:[\\/~]|[A-Za-z]:[\\/])|\$|(?:^|[\s=:'\"\\/])\.\.(?=[\s\\/'\"]|$)")


# Proyecto por defecto: la carpeta de arranque, para las peticiones que no indican el suyo (la primera
# conexión de una pestaña, las ejecuciones en servidor). El proceso nunca cambia de directorio: cada
# petición recibe su proyecto en un SecurityContext.
PROJECT_DIR = Path.cwd().resolve()


def project_context() -> "SecurityContext":
    """Contexto del proyecto por defecto del servidor."""
    return SecurityContext(PROJECT_DIR)


# Código JSON-RPC de una petición cuyo proyecto (cabecera X-ZeroChat-Project) ya no existe.
PROJECT_GONE_CODE = -32003


class ProjectGoneError(ValueError):
    """La carpeta del proyecto de la pestaña ya no existe."""


def request_project_context(raw: str | None, *, fallback: bool) -> "SecurityContext":
    """
    Proyecto de una petición: la carpeta absoluta de la cabecera X-ZeroChat-Project (codificada como en
    una URL) o, sin cabecera, el proyecto por defecto. Una carpeta que ya no existe es un error, salvo con
    fallback (initialize), que devuelve el proyecto por defecto para que la pestaña sepa dónde está.
    """
    if not raw:
        return project_context()
    path = Path(urllib.parse.unquote(raw))
    if path.is_absolute() and path.is_dir():
        return SecurityContext(path.resolve())
    if fallback:
        return project_context()
    raise ProjectGoneError(f"La carpeta del proyecto de la pestaña ya no existe: {path}")


@dataclasses.dataclass
class SecurityContext:
    """Proyecto en el que actúa una petición: base de sus rutas relativas, de sus comandos y de sus permisos."""
    workspace_dir: Path

    @property
    def key(self) -> str:
        """Identificador estable del proyecto: la clave de sus sesiones, de sus patrones guardados y de sus comandos."""
        return normalize_directory_path(str(self.workspace_dir))

    def absolute(self, path: str) -> Path:
        """
        Ruta que una herramienta abre: la resuelta contra la carpeta del proyecto ('~' es la del usuario).
        Es la misma que evalúan los permisos (resolve_path): colapsa los '..' antes de seguir enlaces
        simbólicos, así 'enlace/../x' no se permite como una ruta y se abre como otra. ValueError si no es válida.
        """
        norm = normalize_directory_path(str(Path(str(path).strip()).expanduser()))
        if not norm:
            raise ValueError(f"Ruta no válida: '{path}'.")
        target = Path(norm)
        return (target if target.is_absolute() else self.workspace_dir / target).resolve()

    def resolve_path(self, path_str: str) -> Path | None:
        """La ruta de absolute() para evaluar permisos; None si no es válida o lleva referencias sin resolver ('~', '$VAR')."""
        if not isinstance(path_str, str) or contains_unresolved_reference(path_str):
            return None
        try:
            return self.absolute(path_str)
        except (ValueError, RuntimeError, OSError):
            return None

    def is_inside_workspace(self, path_str: str) -> bool:
        """Determina si la ruta reside estrictamente dentro del espacio de trabajo del contexto."""
        resolved = self.resolve_path(path_str)
        if resolved is None:
            return False
        try:
            resolved.relative_to(self.workspace_dir.resolve())
            return True
        except ValueError:
            return False


def contains_unresolved_reference(value: str) -> bool:
    """Detecta variables de entorno ($VAR, ${VAR}) o expansiones de usuario (~)."""
    if not isinstance(value, str):
        return False
    trimmed = value.strip()
    if not trimmed:
        return False
    if trimmed.startswith("~"):
        return True
    return bool(re.search(r"\$(?:\{[^}]+\}|[A-Za-z_][A-Za-z0-9_]*)", trimmed))


def normalize_directory_path(value: str) -> str:
    """Normaliza rutas posix/windows colapsando . y .. de forma determinista."""
    if not isinstance(value, str) or not value.strip() or "\0" in value:
        return ""
    if contains_unresolved_reference(value):
        return ""
    trimmed = value.strip().replace("\\", "/")
    is_absolute = bool(re.match(r"^(/|[A-Za-z]:/?)", trimmed))
    parts = []
    for part in trimmed.split("/"):
        if not part or part == ".":
            continue
        if part == "..":
            if parts:
                parts.pop()
            else:
                return ""
        else:
            parts.append(part)
    prefix = "/" if trimmed.startswith("/") else ""
    joined = "/".join(parts)
    if is_absolute and not joined.startswith("/") and not re.match(r"^[A-Za-z]:", joined):
        joined = prefix + joined
    return joined or (prefix or ".")


def parse_directory_rule(raw_rule: str) -> dict | None:
    """Parsea una regla 'R:path', 'W:path' o 'RW:path' normalizando su ruta."""
    if not isinstance(raw_rule, str):
        return None
    match = DIRECTORY_RULE_PATTERN.match(raw_rule.strip())
    if not match:
        return None
    access = match.group(1)
    raw_path = match.group(2)
    path = normalize_directory_path(raw_path)
    if not path:
        return None
    return {"access": access, "path": path, "rule": f"{access}:{path}"}


def matches_directory_pattern(path: str, pattern: str) -> bool:
    """Comprueba si una ruta cumple un patrón con soporte para /** y prefijos."""
    if pattern.endswith("/**") and path == pattern[:-3]:
        return True
    if "*" not in pattern:
        if path == pattern:
            return True
        prefix = pattern if pattern.endswith("/") else f"{pattern}/"
        if path.startswith(prefix):
            return True
    escaped = re.escape(pattern).replace(r"\*\*\/", ".*").replace(r"\*\*", ".*").replace(r"\*", "[^/]*")
    return bool(re.fullmatch(escaped, path))


def split_command(cmd: str) -> list[tuple[str, str]] | None:
    """
    Parte un comando por sus operadores de shell fuera de comillas (&&, ||, ; y |) en
    [(operador anterior, subcomando)], para validar cada subcomando por separado. None si usa algo
    que no se puede validar por partes: sustitución de comandos, saltos de línea, '&' en segundo
    plano, subshells, redirecciones a ficheros (salvo las de SAFE_REDIRECTION_PATTERN), palabras
    reservadas de la shell, comillas sin cerrar, un subcomando vacío o un cd que no sea 'cd <dir>'.
    """
    if not isinstance(cmd, str) or SHELL_SPLIT_UNSUPPORTED.search(cmd):
        return None
    text = SAFE_REDIRECTION_PATTERN.sub(" ", cmd)
    segments, current, operator, quote, i = [], "", "", "", 0
    while i < len(text):
        ch = text[i]
        two = text[i:i + 2]
        if quote:
            if ch == "\\" and quote == '"':
                current += two
                i += 2
                continue
            quote = "" if ch == quote else quote
        elif ch == "\\":
            current += two
            i += 2
            continue
        elif ch in "'\"":
            quote = ch
        elif two in ("&&", "||") or ch in ";|":
            sep = two if two in ("&&", "||") else ch
            segments.append((operator, current.strip()))
            current, operator = "", sep
            i += len(sep)
            continue
        elif ch in "&<>()":
            return None
        current += ch
        i += 1
    segments.append((operator, current.strip()))
    if quote or not all(_is_plain_segment(segment) for _, segment in segments):
        return None
    return segments


def _is_plain_segment(segment: str) -> bool:
    """Un subcomando no vacío, que no empieza por una palabra reservada y, si es un cd, de la forma 'cd <dir>'."""
    try:
        words = shlex.split(segment)
    except ValueError:
        return False
    if not words or words[0].lower() in SHELL_KEYWORDS:
        return False
    # Un cd tras variables ('x=1 cd /etc') o tras 'command' también cambia la carpeta: no se admite.
    rest = list(itertools.dropwhile(ENV_ASSIGNMENT.fullmatch, words))
    if rest[rest[:1] == ["command"]:][:1] == ["cd"] and words[0] != "cd":
        return False
    return words[0] != "cd" or (len(words) == 2 and not words[1].startswith("-") and not CD_UNSAFE_TARGET.search(words[1]))


def cd_target(segment: str) -> str | None:
    """Carpeta de un subcomando 'cd <dir>' ya validado por split_command, o None si no es un cd."""
    words = shlex.split(segment)
    return words[1] if words[0] == "cd" else None


def get_command_arg(args: dict | None) -> str:
    """Argumento `command` de run_command (el manejador no admite otro nombre)."""
    val = args.get("command") if isinstance(args, dict) else None
    return val.strip() if isinstance(val, str) else ""


def get_path_arg(args: dict | None) -> str:
    """Argumento `path` de las herramientas integradas de ficheros (el manejador no admite otro nombre)."""
    val = args.get("path") if isinstance(args, dict) else None
    return val.strip() if isinstance(val, str) else ""


def get_integrated_path_access(tool_name: str) -> str:
    """Clasifica el tipo de acceso al sistema de archivos ('R' o 'W') de herramientas core."""
    if tool_name in READ_PATH_TOOLS:
        return "R"
    if tool_name in WRITE_PATH_TOOLS:
        return "W"
    return ""


def is_workspace_local_command(segment: str) -> bool:
    """Filtro de Workspace Trust para un subcomando: sin órdenes globales ni referencias fuera del proyecto."""
    return not WORKSPACE_TRUST_GLOBAL_COMMANDS.search(segment) and not WORKSPACE_TRUST_OUTSIDE_REFERENCE.search(segment)


@functools.lru_cache(maxsize=512)
def compile_command_pattern(pattern: str) -> tuple[tuple[tuple[re.Pattern, bool], ...], bool]:
    """
    Compila un patrón de comando por argumentos: cada palabra es una expresión regular (un `*`
    vale cualquier texto sin `/`) con su marca de comodín, y un `*` suelto al final admite
    cualquier número de argumentos más ('git log *' -> ((git, no), (log, no)), sí).
    """
    words = pattern.split()
    rest = bool(words) and words[-1] == "*"
    if rest:
        words = words[:-1]
    compiled = tuple((re.compile("[^/]*".join(re.escape(part) for part in word.split("*"))), "*" in word)
                     for word in words)
    return compiled, rest


def matches_command_pattern(command: str, pattern: str) -> bool:
    """
    Verifica si un comando cumple un patrón autorizado, argumento a argumento: sin `*` el texto es
    exacto. Un argumento cubierto por un comodín no puede contener `..` ni lo que expande la shell, y
    los del `*` final tampoco una ruta absoluta. Solo cubre un subcomando simple, nunca un cd.
    """
    segments = split_command(command)
    if not segments or len(segments) != 1 or cd_target(segments[0][1]) is not None:
        return False
    command = segments[0][1]
    words, rest = compile_command_pattern(str(pattern))
    try:
        args = shlex.split(command)
    except ValueError:
        return False
    if not words or len(args) < len(words) or (len(args) > len(words) and not rest):
        return False
    first = next((args[0][len(d):] for d in SYSTEM_BIN_DIRS if args[0].startswith(d)), args[0])
    for (regex, wildcard), arg in zip(words, [first, *args[1:]]):
        if not regex.fullmatch(arg) or (wildcard and COMMAND_WILDCARD_UNSAFE.search(arg)):
            return False
    # Los argumentos del '*' final no tienen texto fijo que los acote: tampoco pueden salir del proyecto.
    return not any(COMMAND_WILDCARD_UNSAFE.search(arg) or COMMAND_ABSOLUTE_ARG.search(arg) for arg in args[len(words):])


def normalize_command_pattern(raw: str) -> str:
    """
    Limpia un patrón de comando ('git  status *' -> 'git status *'): el ejecutable sin comodín, sin
    metacaracteres de shell ni comillas y sin `**`, reservado; ValueError si no es válido.
    """
    if not isinstance(raw, str):
        raise ValueError("Cada patrón de comando debe ser un texto.")
    clean = " ".join(raw.split())
    if not clean or "*" in clean.split()[0] or "**" in clean or COMMAND_PATTERN_FORBIDDEN.search(clean):
        raise ValueError(f"Patrón de comando no válido: '{raw}'.")
    return clean


def _is_valid_pattern(raw: str) -> bool:
    try:
        return bool(normalize_command_pattern(raw))
    except ValueError:
        return False


def clean_pattern_list(raw, label: str) -> list[str]:
    """Patrones limpios, sin repetidos ni cubiertos por otro más amplio de la misma lista."""
    if not isinstance(raw, list):
        raise ValueError(f"{label} debe ser una lista de comandos.")
    unique = list(dict.fromkeys(normalize_command_pattern(p) for p in raw))
    return [p for p in unique if not any(q != p and matches_command_pattern(p, q) for q in unique)]


def normalize_command_patterns(raw) -> dict:
    """
    Valida los patrones de comando guardados: `global` (todos los proyectos) y `projects` (ruta absoluta
    del proyecto -> patrones), sin repetidos ni cubiertos por otro más amplio y como máximo
    MAX_COMMAND_PATTERNS en total. Los de sesión nunca forman parte del estado guardado.
    """
    if not isinstance(raw, dict):
        raise ValueError("commandPatterns debe ser un diccionario con global y projects.")
    raw_projects = raw.get("projects") or {}
    if not isinstance(raw_projects, dict):
        raise ValueError("commandPatterns.projects debe ser un diccionario de proyecto a patrones.")
    projects: dict[str, list[str]] = {}
    for raw_path, raw_list in raw_projects.items():
        path = normalize_directory_path(str(raw_path))
        if not path or not re.match(r"^(/|[A-Za-z]:/)", path):
            raise ValueError(f"Proyecto no válido en commandPatterns.projects: '{raw_path}'.")
        patterns = clean_pattern_list(projects.get(path, []) + clean_pattern_list(raw_list, "commandPatterns.projects"), "commandPatterns.projects")
        if patterns:
            projects[path] = patterns
    global_patterns = clean_pattern_list(raw.get("global") or [], "commandPatterns.global")
    total = len(global_patterns) + sum(len(v) for v in projects.values())
    if total > MAX_COMMAND_PATTERNS:
        raise ValueError(f"Hay {total} patrones de comando; el máximo es {MAX_COMMAND_PATTERNS}.")
    return {"global": global_patterns, "projects": projects}


def suggest_command_prefix(command: str) -> str:
    """Prefijo sugerido: ejecutable y, si lo hay, su subcomando ('git status --short' -> 'git status')."""
    tokens = command.split()
    if not tokens:
        return ""
    if len(tokens) > 1 and SUBCOMMAND_TOKEN.fullmatch(tokens[1]):
        return f"{tokens[0]} {tokens[1]}"
    return tokens[0]


def command_rule_offer(commands: list[str]) -> dict | None:
    """
    Un patrón que cubra todos los subcomandos sin autorizar: el programa con su subcomando y '*', o el
    comando exacto si es uno solo y el '*' no lo cubriría. Sin oferta si no hay uno común.
    """
    candidates = [*dict.fromkeys(f"{suggest_command_prefix(c)} *" for c in commands), *commands[:len(commands) == 1]]
    pattern = next((p for p in candidates
                    if _is_valid_pattern(p) and all(matches_command_pattern(c, p) for c in commands)), None)
    return {"type": "command", "command": pattern} if pattern else None


def directory_rule_offer(tool_name: str, access: str, path: str) -> dict | None:
    """Regla sugerida para la carpeta de la ruta (la propia ruta en list_directory)."""
    if not normalize_directory_path(path):
        return None
    clean_path = path.replace("\\", "/").rstrip("/")
    if tool_name == "list_directory":
        folder = clean_path
    else:
        folder = clean_path[:clean_path.rfind("/")] if "/" in clean_path else "."
    dir_path = folder or "/"
    rule = f"{access}:{dir_path}" if dir_path == "/" else f"{access}:{dir_path}/**"
    return {"type": "directory", "access": access, "directoryRule": rule}


@dataclasses.dataclass
class AccessDecision:
    """Resultado formal de la evaluación de una llamada a herramienta."""
    allowed: bool
    status: str
    reason: str
    requires_approval: bool = False
    tool_id: str = ""
    server_name: str = ""
    server_id: str = ""
    details: str = ""
    rule_offer: dict | None = None

    def to_dict(self) -> dict:
        return {
            "allowed": self.allowed,
            "status": self.status,
            "reason": self.reason,
            "requiresApproval": self.requires_approval,
            "toolId": self.tool_id,
            "serverName": self.server_name,
            "serverId": self.server_id,
            "details": self.details,
            "ruleOffer": self.rule_offer
        }


@dataclasses.dataclass
class ProjectSession:
    """
    Lo autorizado en la sesión para un proyecto y sus retos pendientes, en memoria mientras dure el servidor.
    Lo comparten todas las pestañas y dispositivos que trabajan en ese proyecto.
    """
    last_used: float = 0.0
    global_policy: str | None = None
    directory_rules: list[str] | None = None
    tools: dict[str, dict] = dataclasses.field(default_factory=dict)
    servers: dict[str, dict] = dataclasses.field(default_factory=dict)
    command_patterns: list[str] = dataclasses.field(default_factory=list)
    challenges: dict[str, dict] = dataclasses.field(default_factory=dict)

    def entries(self, kind: str) -> dict[str, dict]:
        return self.tools if kind == "tools" else self.servers


class AccessController:
    """Motor de control de acceso y autorización del backend (PDP/PEP)."""

    def __init__(self):
        self._lock = threading.RLock()
        self.sessions: dict[str, ProjectSession] = {}

    def _session(self, context: SecurityContext) -> ProjectSession:
        """
        Sesión del proyecto de la petición, creada vacía la primera vez. Con MAX_PROJECT_SESSIONS proyectos
        en memoria, olvida la del usado hace más tiempo que no tenga comandos en marcha (como mucho hay 8
        comandos a la vez, así que siempre queda alguno sin ellos).
        """
        with self._lock:
            session = self.sessions.get(context.key)
            if session is None:
                if len(self.sessions) >= MAX_PROJECT_SESSIONS:
                    idle = [k for k in self.sessions if not JOBS.running(k)]
                    del self.sessions[min(idle, key=lambda k: self.sessions[k].last_used)]
                session = self.sessions[context.key] = ProjectSession()
            session.last_used = time.monotonic()
            return session

    @staticmethod
    def _normalize_state(raw: dict | None) -> dict:
        """Única definición del estado permanente y de sus valores por defecto."""
        data = raw if isinstance(raw, dict) else {}
        patterns = data.get("commandPatterns") if isinstance(data.get("commandPatterns"), dict) else {}
        # run_command nunca se guarda autorizado entero: sus permisos permanentes son patrones.
        tools = {tid: entry for tid, entry in dict(data.get("tools") or {}).items()
                 if not (tid == COMMAND_TOOL and isinstance(entry, dict) and entry.get("policy") == POLICY_ALLOW)}
        return {
            "version": POLICY_STATE_VERSION,
            "globalMcpPolicy": data.get("globalMcpPolicy") or GLOBAL_POLICY_ASK,
            "directoryRules": list(data.get("directoryRules") or []),
            "tools": tools,
            "servers": dict(data.get("servers") or {}),
            "commandPatterns": {"global": list(patterns.get("global") or []), "projects": dict(patterns.get("projects") or {})}
        }

    def _read_permanent_state(self) -> dict:
        """Lee el estado permanente de SQLite; un fallo de lectura se propaga al llamador."""
        return self._normalize_state(get_security_policy_data())

    def _update_permanent(self, mutator: typing.Callable[[dict], dict]) -> dict:
        """Lectura-modificación-escritura transaccional sobre el estado permanente normalizado."""
        return update_security_policy_data(lambda raw: mutator(self._normalize_state(raw)))

    def _effective_state(self, context: SecurityContext) -> dict:
        """Una sola lectura del estado permanente combinada con la capa de sesión del proyecto."""
        state = self._read_permanent_state()
        with self._lock:
            session = self._session(context)
            return {
                "globalMcpPolicy": session.global_policy if session.global_policy is not None else state["globalMcpPolicy"],
                "directoryRules": list(session.directory_rules) if session.directory_rules is not None else state["directoryRules"],
                "tools": {**state["tools"], **session.tools},
                "servers": {**state["servers"], **session.servers},
                "commandPatterns": {**state["commandPatterns"], "session": list(session.command_patterns)}
            }

    def _command_patterns(self, view: dict, context: SecurityContext) -> list[str]:
        """Patrones que rigen en el proyecto: los de todos los proyectos, los de este y los de la sesión."""
        patterns = view["commandPatterns"]
        return [*patterns["global"], *(patterns["projects"].get(context.key) or []), *patterns["session"]]

    def export_state(self, context: SecurityContext) -> dict:
        return {
            "version": POLICY_STATE_VERSION,
            **self._effective_state(context),
            "defaultDirectoryRule": self.get_default_directory_rule(context)
        }

    def _validate_directory_rules(self, raw_rules: list | tuple, context: SecurityContext) -> list[str]:
        if not isinstance(raw_rules, (list, tuple)):
            raise ValueError("Las reglas de directorio deben ser una lista.")
        parsed_rules = []
        for raw in raw_rules:
            rule_obj = parse_directory_rule(raw)
            if not rule_obj:
                raise ValueError(f"Regla de directorio inválida: '{raw}'. Formato esperado: R:path, W:path o RW:path.")
            parsed_rules.append(rule_obj["rule"])
        unique_rules = list(dict.fromkeys(parsed_rules))
        default_rule = self.get_default_directory_rule(context)
        return [r for r in unique_rules if r != default_rule]

    @staticmethod
    def _validate_policy_entries(raw_entries: dict, kind: str, scope: str) -> dict:
        kind_desc = "herramientas" if kind == "tools" else "servidores"
        kind_label = "la herramienta" if kind == "tools" else "el servidor"
        if not isinstance(raw_entries, dict):
            raise ValueError(f"{kind} debe ser un diccionario de {kind_desc}.")
        clean_map = {}
        for item_id, entry in raw_entries.items():
            clean_key = str(item_id).strip()
            if not clean_key:
                continue
            if entry is None:
                clean_map[clean_key] = None
                continue
            if not isinstance(entry, dict):
                raise ValueError(f"La entrada para {kind_label} '{item_id}' debe ser un diccionario o None.")
            pol = entry.get("policy")
            if pol not in (POLICY_ALLOW, POLICY_DENY):
                raise ValueError(f"Política inválida para {kind_label} '{item_id}': '{pol}'. Válidas: allow, deny.")
            # Como en un reto (allow_always), run_command solo se autoriza siempre con patrones de comando.
            if kind == "tools" and clean_key == COMMAND_TOOL and pol == POLICY_ALLOW and scope == SCOPE_PERMANENT:
                raise ValueError("allow_always_requires_command_pattern")
            clean_map[clean_key] = AccessController._make_entry(
                kind, pol, scope,
                server_name=str(entry.get("serverName", "") or ""),
                original_name=str(entry.get("originalName", "") or "")
            )
        return clean_map

    @staticmethod
    def _make_entry(kind: str, policy: str, scope: str, server_name: str = "", original_name: str = "") -> dict:
        """Única forma de una entrada de política de herramienta o servidor."""
        entry = {
            "policy": policy,
            "scope": scope,
            "grantedAt": int(time.time() * 1000),
            "serverName": server_name
        }
        if kind == "tools":
            entry["originalName"] = original_name
        return entry

    @staticmethod
    def _check_entry_limit(state: dict):
        """Único tope de entradas, sobre el estado resultante (guardado o capa de sesión)."""
        total = len(state.get("directoryRules") or []) + len(state.get("tools") or {}) + len(state.get("servers") or {})
        if total > MAX_POLICY_ENTRIES:
            raise ValueError(f"El número total de entradas ({total}) supera el máximo permitido ({MAX_POLICY_ENTRIES}).")

    def _validate_state_payload(self, state: dict, scope: str, context: SecurityContext) -> tuple[str | None, list[str] | None, dict | None, dict | None]:
        if not isinstance(state, dict):
            raise ValueError("El estado de políticas debe ser un diccionario.")

        clean_global = None
        if "globalMcpPolicy" in state:
            pol = state["globalMcpPolicy"]
            if pol not in GLOBAL_POLICIES:
                raise ValueError(f"Política global no válida: '{pol}'. Válidas: {GLOBAL_POLICIES}")
            clean_global = pol

        clean_rules = self._validate_directory_rules(state["directoryRules"], context) if "directoryRules" in state else None
        clean_tools = self._validate_policy_entries(state["tools"], "tools", scope) if "tools" in state else None
        clean_servers = self._validate_policy_entries(state["servers"], "servers", scope) if "servers" in state else None
        return clean_global, clean_rules, clean_tools, clean_servers

    def import_state(self, state: dict, context: SecurityContext):
        """
        Aplica un parche parcial persistente (None revoca) y devuelve el estado exportado.
        `addDirectoryRules` añade reglas a las guardadas dentro de la misma transacción y
        `commandPatterns` sustituye los patrones de comando guardados.
        """
        clean_global, clean_rules, clean_tools, clean_servers = self._validate_state_payload(state, SCOPE_PERMANENT, context)
        added_rules = self._validate_directory_rules(state["addDirectoryRules"], context) if "addDirectoryRules" in state else []
        clean_patterns = normalize_command_patterns(state["commandPatterns"]) if "commandPatterns" in state else None

        def mutator(current: dict) -> dict:
            if clean_global is not None:
                current["globalMcpPolicy"] = clean_global
            if clean_rules is not None:
                current["directoryRules"] = clean_rules
            if added_rules:
                current["directoryRules"] = self._append_rules(current["directoryRules"], added_rules)
            if clean_tools is not None:
                current["tools"] = self._apply_entry_patch(current.get("tools"), clean_tools)
            if clean_servers is not None:
                current["servers"] = self._apply_entry_patch(current.get("servers"), clean_servers)
            if clean_patterns is not None:
                current["commandPatterns"] = clean_patterns
            self._check_entry_limit(current)
            return current
        self._update_permanent(mutator)
        # Lo guardado vale para todos los proyectos: sustituye o revoca lo equivalente en la sesión de cada uno.
        with self._lock:
            for session in self.sessions.values():
                if clean_global is not None:
                    session.global_policy = None
                if clean_rules is not None:
                    session.directory_rules = None
                elif added_rules and session.directory_rules is not None:
                    session.directory_rules = self._append_rules(session.directory_rules, added_rules)
                for kind, patch in (("tools", clean_tools), ("servers", clean_servers)):
                    for item_id in patch or {}:
                        session.entries(kind).pop(item_id, None)
        return self.export_state(context)

    @staticmethod
    def _append_rules(rules: list[str], new_rules: list[str]) -> list[str]:
        return list(dict.fromkeys(list(rules) + list(new_rules)))

    @staticmethod
    def _apply_entry_patch(current: dict | None, patch: dict) -> dict:
        """Aplica un parche de entradas (None revoca); conserva grantedAt si la política no cambia."""
        result = dict(current or {})
        for item_id, entry in patch.items():
            if entry is None:
                result.pop(item_id, None)
                continue
            previous = result.get(item_id) or {}
            same_grant = previous.get("policy") == entry["policy"]
            result[item_id] = {**entry, "grantedAt": previous["grantedAt"]} if same_grant and previous.get("grantedAt") else entry
        return result

    def apply_session_overlay(self, state: dict, context: SecurityContext):
        """
        Aplica una capa de políticas temporal en memoria para una ejecución en servidor, sin persistir.
        De los patrones de comando solo toma los de sesión: los guardados se leen de la misma base de datos.
        """
        clean_global, clean_rules, clean_tools, clean_servers = self._validate_state_payload(state, SCOPE_SESSION, context)
        raw_patterns = state.get("commandPatterns")
        session_patterns = self._limit_patterns(clean_pattern_list(raw_patterns.get("session") or [], "commandPatterns.session")) \
            if isinstance(raw_patterns, dict) else None

        with self._lock:
            session = self._session(context)
            rules = clean_rules if clean_rules is not None else session.directory_rules
            tools = self._apply_entry_patch(session.tools, clean_tools or {})
            servers = self._apply_entry_patch(session.servers, clean_servers or {})
            self._check_entry_limit({"directoryRules": rules, "tools": tools, "servers": servers})
            if clean_global is not None:
                session.global_policy = clean_global
            session.directory_rules, session.tools, session.servers = rules, tools, servers
            if session_patterns is not None:
                session.command_patterns = session_patterns
        return self.export_state(context)

    @staticmethod
    def _limit_patterns(patterns: list[str]) -> list[str]:
        if len(patterns) > MAX_COMMAND_PATTERNS:
            raise ValueError(f"Hay {len(patterns)} patrones de comando; el máximo es {MAX_COMMAND_PATTERNS}.")
        return patterns

    @staticmethod
    def get_default_directory_rule(context: SecurityContext) -> str:
        base = normalize_directory_path(str(context.workspace_dir))
        return f"RW:{base}" if base == "/" else f"RW:{base}/**"

    @staticmethod
    def _resolve_rule_pattern(pattern: str, workspace_dir: Path | None = None) -> str:
        base, sep, rest = pattern.partition("*")
        if base:
            # Mismo resolutor que SecurityContext.resolve_path (destino y base de la regla).
            target = Path(base) if (not workspace_dir or os.path.isabs(base)) else Path(workspace_dir) / base
            real_base = normalize_directory_path(str(target.resolve(strict=False)))
            if sep and base.endswith("/") and not real_base.endswith("/"):
                real_base += "/"
        else:
            real_base = ""
        return f"{real_base}{sep}{rest}"

    def evaluate_directory_rule(self, access: str, path: str, user_rules: list[str],
                                ctx: SecurityContext) -> dict:
        resolved_target = ctx.resolve_path(path)
        if resolved_target is None:
            return {"allowed": False, "rule": None, "path": ""}
        normalized_dest = normalize_directory_path(str(resolved_target))
        if not normalized_dest:
            return {"allowed": False, "rule": None, "path": ""}

        matching_user_rules = []
        for raw_rule in user_rules:
            parsed = parse_directory_rule(raw_rule)
            if not parsed:
                continue
            rule_pattern = self._resolve_rule_pattern(parsed["path"], ctx.workspace_dir)
            if matches_directory_pattern(normalized_dest, rule_pattern):
                matching_user_rules.append(parsed)

        for parsed in matching_user_rules:
            if parsed["access"] == access or parsed["access"] == "RW":
                return {"allowed": True, "rule": parsed["rule"], "path": normalized_dest}

        if matching_user_rules:
            return {"allowed": False, "rule": None, "path": normalized_dest}

        default_rule = self.get_default_directory_rule(ctx)
        default_parsed = parse_directory_rule(default_rule)
        if default_parsed and (default_parsed["access"] == access or default_parsed["access"] == "RW"):
            rule_pattern = self._resolve_rule_pattern(default_parsed["path"], ctx.workspace_dir)
            if matches_directory_pattern(normalized_dest, rule_pattern):
                return {"allowed": True, "rule": default_parsed["rule"], "path": normalized_dest}
        return {"allowed": False, "rule": None, "path": normalized_dest}

    def clear_session(self):
        """Olvida lo autorizado en la sesión y los retos pendientes de todos los proyectos."""
        with self._lock:
            self.sessions.clear()

    def create_challenge(self, tool_name: str, args: dict, decision: AccessDecision, *, context: SecurityContext,
                         server_name: str = "", server_id: str = "", origin: str = "local",
                         job_key: str | None = None, conversation_id: str = "") -> dict:
        """Genera un reto estructurado para solicitar confirmación interactiva al usuario."""
        challenge_id = f"auth_{secrets.token_urlsafe(16)}"
        now = int(time.time() * 1000)
        with self._lock:
            challenges = self._session(context).challenges
            expired = [cid for cid, c in challenges.items() if now - c.get("createdAt", 0) > CHALLENGE_TTL_MS]
            for cid in expired:
                challenges.pop(cid, None)

            challenge_data = {
                "id": challenge_id,
                "toolName": tool_name,
                "arguments": args,
                "serverName": server_name or decision.server_name,
                "serverId": server_id or decision.server_id,
                "origin": origin,
                "jobKey": job_key,
                "conversationId": conversation_id,
                "createdAt": now
            }
            challenges[challenge_id] = challenge_data
            return challenge_data

    def authorize_challenge(self, challenge_id: str, decision: str, *, context: SecurityContext,
                            command_pattern: str | None = None, directory_rule: str | None = None) -> dict | None:
        """
        Valida la decisión, consume el reto (una única ejecución) y registra la decisión.
        Devuelve el reto consumido, o None si no existe en el proyecto de la petición, caducó o la decisión
        no aplica. Una decisión mal formada lanza ValueError y deja el reto pendiente.
        """
        now = int(time.time() * 1000)
        with self._lock:
            challenges = self._session(context).challenges
            challenge = challenges.get(challenge_id)
            if not challenge:
                return None
            if now - challenge.get("createdAt", 0) > CHALLENGE_TTL_MS:
                challenges.pop(challenge_id, None)
                return None
            if decision not in AUTHORIZE_DECISIONS:
                return None
            if decision == "allow_server_always" and not challenge.get("serverId"):
                return None
            pattern = self._validate_command_pattern(decision, command_pattern, challenge)
            rules = self._validate_directory_rules([directory_rule], context) if directory_rule else []
            challenges.pop(challenge_id)
        self._record_decision(challenge, decision, pattern, rules, context)
        return challenge

    def revoke_challenge(self, challenge_id: str, *, context: SecurityContext) -> bool:
        with self._lock:
            return self._session(context).challenges.pop(challenge_id, None) is not None

    @staticmethod
    def _validate_command_pattern(decision: str, raw_pattern: str | None, challenge: dict) -> str | None:
        """Patrón de una decisión sobre run_command: obligatorio para siempre o proyecto y que cubra el comando del reto."""
        is_command = challenge["toolName"] == COMMAND_TOOL
        if decision == "allow_project" and (not is_command or not raw_pattern):
            raise ValueError("allow_project_requires_command_pattern")
        if decision == "allow_always" and is_command and not raw_pattern:
            raise ValueError("allow_always_requires_command_pattern")
        if raw_pattern is None or decision not in ("allow_session", "allow_project", "allow_always"):
            return None
        if not is_command:
            raise ValueError("Solo run_command admite patrones de comando.")
        pattern = normalize_command_pattern(raw_pattern)
        command = get_command_arg(challenge["arguments"])
        if not any(matches_command_pattern(segment, pattern) for _, segment in split_command(command) or []):
            raise ValueError(f"El patrón '{pattern}' no cubre ningún subcomando de '{command}'.")
        return pattern

    def _record_decision(self, challenge: dict, decision: str, pattern: str | None, rules: list[str],
                         context: SecurityContext):
        """
        Registra la respuesta del usuario a un reto. La sesión queda en memoria; la política permanente y la
        regla de directorio se escriben en una sola transacción y un error de persistencia se propaga.
        """
        tool, server_name, server_id = challenge["toolName"], challenge["serverName"], challenge["serverId"]
        if decision == "allow_session":
            with self._lock:
                session = self._session(context)
                if pattern:
                    session.command_patterns = self._limit_patterns(
                        clean_pattern_list(session.command_patterns + [pattern], "commandPatterns.session"))
                else:
                    session.tools[tool] = self._make_entry("tools", POLICY_ALLOW, SCOPE_SESSION, server_name, tool)
        permanent = decision in ("allow_project", "allow_always", "allow_server_always")
        if not permanent and not rules:
            return
        project = context.key

        def mutator(state: dict) -> dict:
            saved = state["commandPatterns"]
            if pattern and decision == "allow_project":
                projects = {**saved["projects"], project: [*(saved["projects"].get(project) or []), pattern]}
                state["commandPatterns"] = normalize_command_patterns({**saved, "projects": projects})
            elif pattern and decision == "allow_always":
                state["commandPatterns"] = normalize_command_patterns({**saved, "global": [*saved["global"], pattern]})
            elif decision == "allow_always":
                state["tools"][tool] = self._make_entry("tools", POLICY_ALLOW, SCOPE_PERMANENT, server_name, tool)
            elif decision == "allow_server_always":
                state["servers"][server_id] = self._make_entry("servers", POLICY_ALLOW, SCOPE_PERMANENT, server_name or server_id)
            if rules:
                state["directoryRules"] = self._append_rules(state["directoryRules"], rules)
            self._check_entry_limit(state)
            return state
        self._update_permanent(mutator)
        with self._lock:
            for session in self.sessions.values():
                if decision == "allow_always" and not pattern:
                    session.tools.pop(tool, None)
                elif decision == "allow_server_always":
                    session.servers.pop(server_id, None)
                if rules and session.directory_rules is not None:
                    session.directory_rules = self._append_rules(session.directory_rules, rules)

    def evaluate_authorization(self, tool_name: str, raw_args: dict | None, context: SecurityContext,
                               server_name: str = "", server_id: str = "") -> AccessDecision:
        """
        Evalúa si la invocación de una herramienta está permitida, denegada o requiere confirmación.
        Jerarquía:
        1. Lista negra explícita (deny individual o de servidor).
        2. Herramientas de control de procesos (check_command).
        3. Política global allow_all -> allow incondicional.
        4. Política granular de herramienta -> allow.
        5. Política de servidor completo -> allow incondicional para sus herramientas.
        6. run_command: patrones de comando y, si no lo cubren, Workspace Trust.
        7. Herramientas con ruta: reglas de directorio y Workspace Trust.
        8. Por defecto -> ask (solicitar confirmación), con la regla sugerida si la hay.
        """
        status, reason, details, offer = self._evaluate(tool_name, dict(raw_args or {}), context, server_id)
        return AccessDecision(allowed=status == POLICY_ALLOW, status=status, reason=reason,
                              requires_approval=status == POLICY_ASK, tool_id=tool_name, server_name=server_name,
                              server_id=server_id, details=details, rule_offer=offer)

    def _evaluate(self, tool_name: str, args: dict, ctx: SecurityContext, server_id: str) -> tuple[str, str, str, dict | None]:
        view = self._effective_state(ctx)
        tool_policy = (view["tools"].get(tool_name) or {}).get("policy")
        server_policy = (view["servers"].get(server_id) or {}).get("policy") if server_id else None
        if tool_policy == POLICY_DENY:
            return POLICY_DENY, "granular_deny_rule", "", None
        if server_policy == POLICY_DENY:
            return POLICY_DENY, "server_deny_rule", "", None
        if tool_name == JOB_CONTROL_TOOL:
            return POLICY_ALLOW, "job_control_tool", "", None
        if view["globalMcpPolicy"] == GLOBAL_POLICY_ALLOW_ALL:
            return POLICY_ALLOW, "mcp_global_allow_all", "", None
        if tool_policy == POLICY_ALLOW:
            return POLICY_ALLOW, "granular_allow_rule", "", None
        if server_policy == POLICY_ALLOW:
            return POLICY_ALLOW, "server_allow_rule", "", None
        if tool_name == COMMAND_TOOL:
            return self._evaluate_command(get_command_arg(args), view, ctx)
        access = get_integrated_path_access(tool_name)
        path = get_path_arg(args) or ("." if tool_name in DIRECTORY_PATH_TOOLS else "")
        if access and path:
            return self._evaluate_path(tool_name, access, path, view, ctx)
        return POLICY_ASK, "mcp_default_ask", "", None

    def _evaluate_command(self, raw_command: str, view: dict, ctx: SecurityContext) -> tuple[str, str, str, dict | None]:
        """
        Valida cada subcomando por separado: un cd tiene que llevar a una carpeta cubierta por las reglas
        de directorio, y los subcomandos siguientes se ejecutan en ella; el resto tiene que estar cubierto
        por un patrón o, con Workspace Trust, quedarse en el proyecto (tras una tubería, solo un filtro).
        Un patrón es una vía más de permitir, nunca una puerta que anule Workspace Trust.
        """
        segments = split_command(raw_command)
        if segments is None:
            return (POLICY_ASK, "command_chaining_requires_approval",
                    f"El comando usa sintaxis de shell que no se puede validar por partes: {raw_command}", None)
        patterns = self._command_patterns(view, ctx)
        trust = view["globalMcpPolicy"] == GLOBAL_POLICY_WORKSPACE_TRUST
        cwd, by_trust, uncovered = ctx.workspace_dir, False, []
        for operator, segment in segments:
            directory = cd_target(segment)
            if directory is not None:
                target = directory if re.match(r"^(/|[A-Za-z]:[\\/])", directory) else str(cwd / directory)
                if not any(self.evaluate_directory_rule(a, target, view["directoryRules"], ctx)["allowed"] for a in ("R", "W")):
                    return (POLICY_ASK, "command_directory_outside_rules",
                            f"El comando se ejecuta fuera de las reglas de directorio: {directory}", None)
                cwd = ctx.resolve_path(target)
            elif any(matches_command_pattern(segment, p) for p in patterns):
                continue
            elif trust and is_workspace_local_command(segment) and (
                    operator != "|" or segment.split()[0] in WORKSPACE_TRUST_PIPE_FILTERS):
                by_trust = True
            else:
                uncovered.append(segment)
        if not uncovered:
            return POLICY_ALLOW, "workspace_trust_command" if by_trust else "command_pattern_allow", "", None
        if trust:
            reason, details = "workspace_trust_external_or_global_command", "El comando accede a recursos globales o rutas fuera del espacio de trabajo."
        else:
            reason, details = ("command_outside_allowed_patterns", f"Comando fuera de los patrones autorizados: {'; '.join(uncovered)}") if patterns else ("mcp_default_ask", "")
        return POLICY_ASK, reason, details, command_rule_offer(uncovered)

    def _evaluate_path(self, tool_name: str, access: str, path: str, view: dict, ctx: SecurityContext) -> tuple[str, str, str, dict | None]:
        """Herramientas integradas de ficheros: reglas de directorio y, con Workspace Trust, el proyecto."""
        dir_eval = self.evaluate_directory_rule(access, path, view["directoryRules"], ctx)
        if dir_eval["allowed"]:
            return POLICY_ALLOW, "directory_rule_allow", "", None
        if view["globalMcpPolicy"] == GLOBAL_POLICY_WORKSPACE_TRUST and ctx.is_inside_workspace(path):
            return POLICY_ALLOW, "workspace_trust_allow", "", None
        return (POLICY_ASK, "directory_rule_required", f"La ruta no coincide con una regla {access}: {path}",
                directory_rule_offer(tool_name, access, dir_eval["path"] or path))


ACCESS_CONTROLLER = AccessController()

# ==============================================================================
# Herramientas Locales Core
# ==============================================================================

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


def list_directory(path: str = ".", recursive: bool = False, *, ctx: SecurityContext) -> str:
    """List files and directories in a local directory with safe bounded recursive traversal."""
    try:
        target = ctx.absolute(path)
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
                                    entry_data["relative_path"] = Path(entry.path).relative_to(target).as_posix()
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


def read_file(path: str, start_line: int = 1, end_line: int = None, max_lines: int = 500, max_bytes: int = 100000, *, ctx: SecurityContext) -> str:
    """Read text content from a local file in streaming mode with safe ranges and bounds."""
    try:
        target = ctx.absolute(path)
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


def write_file(path: str, content: str, *, ctx: SecurityContext) -> str:
    """Create or overwrite a file completely and atomically."""
    try:
        target = ctx.absolute(path)
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


def edit_file(path: str, old_str: str, new_str: str, replace_all: bool = False, *, ctx: SecurityContext) -> str:
    """Replace old_str with new_str in an existing file: its single occurrence, or all of them with replace_all."""
    try:
        target = ctx.absolute(path)
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


def resolve_project_directory(path, ctx: SecurityContext) -> dict:
    """
    Valida la carpeta que elige una pestaña como proyecto (relativa al suyo actual). El servidor no la
    guarda: la pestaña la envía en cada petición (X-ZeroChat-Project) y otras pestañas siguen en la suya.
    """
    if not isinstance(path, str) or not path.strip():
        raise ValueError("La ruta del directorio está vacía.")
    if len(path) > MAX_PATH_LENGTH:
        raise ValueError("La ruta del directorio excede el tamaño máximo permitido.")
    target = ctx.absolute(path)
    if not target.is_dir():
        raise ValueError(f"'{path}' no existe o no es un directorio.")
    # Cambiar de proyecto no borra nada: cada proyecto conserva su propia sesión.
    return {"cwd": str(target)}


def search_files(query: str, path: str = ".", file_pattern: str = None, max_results: int = 100, *, ctx: SecurityContext) -> str:
    """Recursively search for plain text or regular expressions across project files."""
    try:
        target = ctx.absolute(path)
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
                                    rel_path = fpath.relative_to(target).as_posix()
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


def get_diagnostics(path: str | None = None, *, ctx: SecurityContext) -> str:
    """Retrieve syntax diagnostics and code errors for a file or the entire workspace."""
    try:
        target = ctx.absolute(path) if path is not None and str(path).strip() else ctx.workspace_dir

        if not target.exists():
            return _tool_error(f"Path '{path}' does not exist.")

        diagnostics: list[dict] = []
        files_checked = 0

        def check_single_file(fpath: Path) -> list[dict]:
            ext = fpath.suffix.lower()
            file_diags: list[dict] = []
            try:
                rel_display = fpath.relative_to(ctx.workspace_dir).as_posix()
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
  playwright = require(process.env.ZEROCHAT_PLAYWRIGHT_MODULE);
} catch (e) {
  console.log(JSON.stringify({
    success: false,
    error: "Playwright is not available. Start the Playwright service once in Settings > MCP to install it."
  }));
  process.exit(1);
}

(async () => {
  let browser, context, page;
  try {
    const candidates = [
      {},                      // 1. Playwright bundled Chromium
      { channel: 'chrome' },   // 2. System Google Chrome
      { channel: 'msedge' },   // 3. System Microsoft Edge
      { channel: 'chromium' }  // 4. Playwright full Chromium, if only the headless shell is missing
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
            env={**os.environ, "ZEROCHAT_PLAYWRIGHT_MODULE": str(playwright_service_module())},
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
    # Solo el Playwright del servicio, no el node_modules de la carpeta desde la que arranca el servidor.
    if not playwright_service_cli().is_file():
        return {"available": False, "error": "Playwright is not available."}
    # El runner prueba las entradas de Chromium de Playwright y los canales chrome y msedge.
    browsers = system_browsers()
    if cached_engine_entries() & set(ENGINE_CACHE_ENTRIES["chromium"]) or browsers["chrome"] or browsers["msedge"]:
        return {"available": True}
    return {"available": False, "error": "Playwright Chromium is not installed."}


def playwright_status() -> dict:
    """Playwright del servicio y browser_action tal como están ahora, para el latido del cliente."""
    return {"installed": playwright_service_cli().is_file(), "browserAction": browser_action_availability()}


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

# Configuración del navegador de Playwright MCP (sección Navegador de Ajustes).
# Modo propio: un motor de Playwright en memoria (--isolated), o con almacenamiento persistente con nombre
# en ~/zerochat/playwright/profile/<motor>/<nombre>.
# Modo del usuario: su Chrome, Edge o Chromium mediante la extensión de Playwright (--extension).
BROWSER_MODES = ("own", "user")
OWN_BROWSER_ENGINES = ("chromium", "firefox", "webkit")
USER_BROWSERS = ("chrome", "msedge", "chromium")
BROWSER_CONFIG_DEFAULTS = {"mode": "own", "engine": "chromium", "userBrowser": "chrome", "headless": True, "extensionToken": ""}
# Identificador de la extensión de Playwright en la tienda de Chrome, que también usa Edge.
PLAYWRIGHT_SERVER_ID = "playwright"
PLAYWRIGHT_EXTENSION_ID = "mmlmfjhmonkocbjadbfplnigmagldckm"
# Token que muestra la extensión: con él la conexión no pide aceptarla en el navegador.
_EXTENSION_TOKEN = re.compile(r"^[A-Za-z0-9_-]{0,256}$")
_STORAGE_NAME = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_BROWSER_CONFIG_CHOICES = {"mode": BROWSER_MODES, "engine": OWN_BROWSER_ENGINES, "userBrowser": USER_BROWSERS}


def browser_config_file() -> Path:
    return get_data_dir() / "config" / "browser.json"


def own_browser_profile_dir(engine: str) -> Path:
    return get_data_dir() / "playwright" / "profile" / engine


def validate_browser_config(raw) -> dict:
    """Devuelve la configuración completa o lanza ValueError; los campos que faltan toman su valor por defecto."""
    if not isinstance(raw, dict):
        raise ValueError("La configuración del navegador debe ser un objeto")
    unknown = sorted(set(raw) - set(BROWSER_CONFIG_DEFAULTS))
    if unknown:
        raise ValueError(f"Campos desconocidos en la configuración del navegador: {', '.join(unknown)}")
    config = {**BROWSER_CONFIG_DEFAULTS, **raw}
    for key, choices in _BROWSER_CONFIG_CHOICES.items():
        if config[key] not in choices:
            raise ValueError(f"{key} debe ser uno de: {', '.join(choices)}")
    if not isinstance(config["headless"], bool):
        raise ValueError("headless debe ser un booleano")
    if not isinstance(config["extensionToken"], str) or not _EXTENSION_TOKEN.match(config["extensionToken"]):
        raise ValueError("extensionToken debe tener hasta 256 letras, cifras, guiones o guiones bajos")
    return config


def load_browser_config() -> dict:
    path = browser_config_file()
    if not path.exists():
        return dict(BROWSER_CONFIG_DEFAULTS)
    try:
        return validate_browser_config(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, ValueError) as err:
        log_event(f"[zerochat] Configuración del navegador no válida en {path}, se usan los valores por defecto: {err}")
        return dict(BROWSER_CONFIG_DEFAULTS)


def save_browser_config(raw) -> dict:
    config = validate_browser_config(raw)
    path = browser_config_file()
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    # Guarda el token de la extensión: solo lo lee el usuario.
    _write_private_text(path, json.dumps(config, indent=2))
    return config


def _playwright_active() -> bool:
    return any(server["id"] == PLAYWRIGHT_SERVER_ID and server["status"] in ("running", "starting", "installing")
               for server in GLOBAL_MCP_MANAGER.list_servers())


def clear_own_browser_data(engine) -> dict:
    """Borra el perfil persistente del motor (cookies, sesiones, almacenamiento de los sitios)."""
    if engine not in OWN_BROWSER_ENGINES:
        raise ValueError(f"engine debe ser uno de: {', '.join(OWN_BROWSER_ENGINES)}")
    # El navegador abierto tiene el perfil bloqueado y volvería a escribirlo.
    if _playwright_active():
        raise ValueError("Detén Playwright MCP antes de borrar los datos del navegador.")
    shutil.rmtree(own_browser_profile_dir(engine), ignore_errors=True)
    return {"cleared": engine}


def chromium_install() -> tuple[str, Path] | None:
    """Chromium del sistema: ejecutable y carpeta de datos del usuario, o None si no está."""
    if sys.platform == "darwin":
        executable = "/Applications/Chromium.app/Contents/MacOS/Chromium"
        data_dir = Path.home() / "Library" / "Application Support" / "Chromium"
    elif sys.platform.startswith("win"):
        local = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
        executable = str(local / "Chromium" / "Application" / "chrome.exe")
        data_dir = local / "Chromium" / "User Data"
    else:
        executable = shutil.which("chromium") or shutil.which("chromium-browser") or ""
        # El Chromium de snap guarda el perfil dentro de su confinamiento.
        snap = os.path.realpath(executable).startswith("/snap/")
        data_dir = Path.home() / ("snap/chromium/common/chromium" if snap else ".config/chromium")
    return (executable, data_dir) if executable and os.path.isfile(executable) else None


def playwright_launch_args(config: dict, user_agent: str | None = None) -> list[str]:
    """Argumentos de Playwright MCP para la configuración del navegador."""
    if config["mode"] == "user":
        # La extensión maneja el navegador abierto del usuario: siempre con ventana.
        if config["userBrowser"] != "chromium":
            return ["--extension", f"--browser={config['userBrowser']}"]
        # Chromium no es un canal de Playwright: se da su ejecutable y su perfil, con el canal chrome
        # para que no lo lance sin sandbox si no está abierto.
        install = chromium_install()
        if not install:
            raise RuntimeError("No se encuentra Chromium en el sistema: elige otro navegador en Ajustes › Navegador.")
        executable, data_dir = install
        return ["--extension", "--browser=chrome", f"--executable-path={executable}", f"--user-data-dir={data_dir}"]
    args = [f"--browser={config['engine']}"]
    storage = config.get("storage")
    if storage:
        profile_dir = own_browser_profile_dir(config["engine"]) / storage
        for directory in (profile_dir.parent.parent.parent, profile_dir.parent.parent, profile_dir.parent, profile_dir):
            directory.mkdir(mode=0o700, exist_ok=True)
        args.append(f"--user-data-dir={profile_dir}")
    else:
        args.append("--isolated")
    # El motor propio usa el User-Agent de ZeroChat; en modo user lo pone el navegador del usuario.
    if user_agent:
        args.append(f"--user-agent={user_agent}")
    if config["headless"]:
        args.append("--headless")
    return args


def playwright_launch_env(config: dict) -> dict[str, str]:
    """Entorno de Playwright MCP: el token de la extensión, que no aparece en la línea de órdenes ni en el log."""
    if config["mode"] == "user" and config["extensionToken"]:
        return {"PLAYWRIGHT_MCP_EXTENSION_TOKEN": config["extensionToken"]}
    return {}


def validate_profile_browser(raw) -> dict:
    """Navegador que exige un perfil: el propio con un motor (y opcionalmente headless False y storage
    con nombre), o el del usuario con uno de sus navegadores."""
    if isinstance(raw, dict) and raw.get("mode") == "own" and raw.get("engine") in OWN_BROWSER_ENGINES:
        if set(raw) <= {"mode", "engine", "headless", "storage"}:
            headless_ok = "headless" not in raw or raw["headless"] is False
            storage = raw.get("storage")
            storage_ok = "storage" not in raw or (isinstance(storage, str) and bool(_STORAGE_NAME.match(storage)))
            if headless_ok and storage_ok:
                result = {"mode": "own", "engine": raw["engine"]}
                if "headless" in raw:
                    result["headless"] = False
                if "storage" in raw:
                    result["storage"] = storage
                return result
    if isinstance(raw, dict) and raw.get("mode") == "user" and set(raw) == {"mode", "userBrowser"} and raw["userBrowser"] in USER_BROWSERS:
        return {"mode": "user", "userBrowser": raw["userBrowser"]}
    raise ValueError("browser debe ser {mode: own, engine[, headless: false][, storage]} o {mode: user, userBrowser} con un motor o navegador admitido")


def browser_choice(config: dict) -> dict:
    """Modo y navegador con los que arranca Playwright MCP, en la forma de validate_profile_browser."""
    if config["mode"] == "own":
        return {
            "mode": "own",
            "engine": config["engine"],
            **({} if config["headless"] else {"headless": False}),
            **({"storage": config["storage"]} if config.get("storage") else {}),
        }
    return {"mode": "user", "userBrowser": config["userBrowser"]}


def _playwright_launch(browser: dict | None, user_agent: str | None = None) -> tuple[list[str], dict[str, str], dict]:
    """La configuración de Ajustes › Navegador con el modo y el navegador que exija el perfil activo."""
    config = load_browser_config()
    if browser is not None:
        config = {**config, **validate_profile_browser(browser)}
    return playwright_launch_args(config, user_agent), playwright_launch_env(config), browser_choice(config)


# User-Agent que usan los motores propios de Playwright; lo fija el servidor con el User-Agent
# activo de las salidas web (ff-server) para que ambos compartan el mismo fingerprint.
SERVICE_USER_AGENT: str | None = None


def set_service_user_agent(user_agent: str | None) -> None:
    global SERVICE_USER_AGENT
    SERVICE_USER_AGENT = user_agent


# Argumentos, entorno y navegador elegido que añade ZeroChat al arrancar un servicio gestionado,
# calculados en cada arranque.
SERVICE_LAUNCH = {PLAYWRIGHT_SERVER_ID: lambda browser: _playwright_launch(browser, SERVICE_USER_AGENT)}


# Motores propios de Playwright: cada uno se compone de las entradas de la caché que instala
# "playwright install <motor>"; ffmpeg es común y no se quita.
ENGINE_CACHE_ENTRIES = {"chromium": ("chromium", "chromium-headless-shell"), "firefox": ("firefox",), "webkit": ("webkit",)}
ENGINE_INSTALL_TIMEOUT_SECONDS = 1200
_DRY_RUN_ENTRY = re.compile(r"^(.+?) \(playwright (\S+) v\d+\)\n\s+Install location:\s+(.+)$", re.MULTILINE)
_INSTALL_PERCENT = re.compile(r"(\d{1,3})% of ")
_INSTALL_DOWNLOAD = re.compile(r"^Downloading (.+?) \(playwright ")


def playwright_engine_cache() -> Path:
    """Caché de motores de Playwright sin lanzar Node: PLAYWRIGHT_BROWSERS_PATH o la ruta por defecto de la plataforma."""
    configured = os.environ.get("PLAYWRIGHT_BROWSERS_PATH", "").strip()
    if configured:
        return Path(configured).expanduser()
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Caches" / "ms-playwright"
    if sys.platform.startswith("win"):
        return Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local") / "ms-playwright"
    return Path.home() / ".cache" / "ms-playwright"


def cached_engine_entries() -> set[str]:
    """Entradas de ENGINE_CACHE_ENTRIES con alguna revisión completa en la caché; la revisión exacta de esta
    versión de Playwright solo la da BrowserEngines.list lanzando Node."""
    try:
        folders = [child.name for child in playwright_engine_cache().iterdir() if (child / "INSTALLATION_COMPLETE").is_file()]
    except OSError:
        return set()
    # Las carpetas se llaman como la entrada con guiones bajos y su revisión: chromium_headless_shell-1187.
    names = {name for entries in ENGINE_CACHE_ENTRIES.values() for name in entries}
    return {name for name in names if any(folder.startswith(name.replace("-", "_") + "-") for folder in folders)}


def playwright_service_module() -> Path:
    return get_data_dir() / "services" / "playwright" / "node_modules" / "playwright"


def playwright_service_cli() -> Path:
    return playwright_service_module() / "cli.js"


def system_browsers() -> dict[str, bool]:
    """Chrome y Edge en las rutas donde los busca Playwright para --browser=chrome|msedge, Chromium donde lo
    busca chromium_install; Firefox solo se informa."""
    if sys.platform == "darwin":
        candidates = {
            "chrome": ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
            "msedge": ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
            "firefox": ["/Applications/Firefox.app/Contents/MacOS/firefox"],
        }
    elif sys.platform.startswith("win"):
        roots = [os.environ.get(name) for name in ("LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)")]
        roots = [root for root in roots if root]
        candidates = {
            "chrome": [os.path.join(root, "Google", "Chrome", "Application", "chrome.exe") for root in roots],
            "msedge": [os.path.join(root, "Microsoft", "Edge", "Application", "msedge.exe") for root in roots],
            "firefox": [os.path.join(root, "Mozilla Firefox", "firefox.exe") for root in roots],
        }
    else:
        candidates = {
            "chrome": ["/opt/google/chrome/chrome"],
            "msedge": ["/opt/microsoft/msedge/msedge"],
            "firefox": [shutil.which("firefox") or ""],
        }
    found = {name: any(path and os.path.isfile(path) for path in paths) for name, paths in candidates.items()}
    return {**found, "chromium": chromium_install() is not None}


def user_browser_data_dir(browser: str) -> Path | None:
    """Carpeta de datos del usuario de Chrome, Edge o Chromium, donde están sus perfiles."""
    if browser == "chromium":
        install = chromium_install()
        return install[1] if install else None
    if sys.platform == "darwin":
        root, paths = Path.home() / "Library" / "Application Support", {"chrome": "Google/Chrome", "msedge": "Microsoft Edge"}
    elif sys.platform.startswith("win"):
        root = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
        paths = {"chrome": "Google/Chrome/User Data", "msedge": "Microsoft/Edge/User Data"}
    else:
        root, paths = Path.home() / ".config", {"chrome": "google-chrome", "msedge": "microsoft-edge"}
    return root / paths[browser]


def user_browser_extensions() -> dict[str, bool]:
    """Si algún perfil de cada navegador del usuario tiene instalada la extensión de Playwright desde la tienda."""
    found = {}
    for browser in USER_BROWSERS:
        data_dir = user_browser_data_dir(browser)
        found[browser] = bool(data_dir) and any(data_dir.glob(f"*/Extensions/{PLAYWRIGHT_EXTENSION_ID}"))
    return found


class BrowserEngines:
    """Lista, instala y quita los motores propios de Playwright en su caché, nunca en el sistema."""

    def __init__(self):
        self._lock = threading.Lock()
        self._jobs: dict[str, dict] = {}

    @staticmethod
    def _run_cli(cli: Path, *args: str, timeout: float) -> subprocess.CompletedProcess:
        return subprocess.run([shutil.which("node") or "node", str(cli), *args], cwd=cli.parent,
                              capture_output=True, text=True, timeout=timeout)

    def _locations(self, cli: Path) -> dict[str, tuple[str, Path]]:
        """Entradas de la caché de esta versión de Playwright: nombre -> (título con versión, ruta)."""
        names = [name for entries in ENGINE_CACHE_ENTRIES.values() for name in entries]
        result = self._run_cli(cli, "install", "--dry-run", *names, timeout=30)
        if result.returncode != 0:
            raise RuntimeError(f"Playwright no pudo listar sus navegadores: {(result.stderr or result.stdout).strip()}")
        return {name: (title, Path(location.strip())) for title, name, location in _DRY_RUN_ENTRY.findall(result.stdout)}

    def list(self) -> dict:
        """Navegadores del sistema y motores de Playwright; sin Playwright del servicio no hay motores."""
        cli = playwright_service_cli()
        result = {"systemBrowsers": system_browsers(), "extensions": user_browser_extensions(), "engines": []}
        if not cli.is_file():
            return result
        locations = self._locations(cli)
        with self._lock:
            jobs = {engine: dict(job) for engine, job in self._jobs.items()}
        for engine, entries in ENGINE_CACHE_ENTRIES.items():
            title = locations.get(entries[0], (engine,))[0]
            installed = all(name in locations and (locations[name][1] / "INSTALLATION_COMPLETE").is_file() for name in entries)
            result["engines"].append({"id": engine, "title": title, "installed": installed, **jobs.get(engine, {})})
        return result

    def _check_engine(self, engine) -> Path:
        if engine not in ENGINE_CACHE_ENTRIES:
            raise ValueError(f"engine debe ser uno de: {', '.join(ENGINE_CACHE_ENTRIES)}")
        cli = playwright_service_cli()
        if not cli.is_file():
            raise ValueError("Playwright MCP no está instalado: arráncalo una vez desde Ajustes › MCP.")
        if self._jobs.get(engine, {}).get("status") == "installing":
            raise ValueError(f"{engine} ya se está instalando.")
        return cli

    def install(self, engine) -> dict:
        with self._lock:
            cli = self._check_engine(engine)
            self._jobs[engine] = {"status": "installing", "percent": 0}
        threading.Thread(target=self._install, args=(cli, engine), daemon=True).start()
        return self.list()

    def _install(self, cli: Path, engine: str):
        log_event(f"[zerochat] Instalando el motor {engine} de Playwright")
        lines = []
        try:
            proc = subprocess.Popen([shutil.which("node") or "node", str(cli), "install", engine], cwd=cli.parent,
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            timer = threading.Timer(ENGINE_INSTALL_TIMEOUT_SECONDS, proc.kill)
            timer.start()
            try:
                for line in proc.stdout:
                    lines = (lines + [line.rstrip()])[-20:]
                    percent, download = _INSTALL_PERCENT.search(line), _INSTALL_DOWNLOAD.match(line)
                    with self._lock:
                        if download:
                            self._jobs[engine].update(download=download.group(1), percent=0)
                        elif percent:
                            self._jobs[engine]["percent"] = min(100, int(percent.group(1)))
                code = proc.wait()
            finally:
                timer.cancel()
            if code != 0:
                raise RuntimeError("\n".join(lines[-5:]) or f"código {code}")
            with self._lock:
                self._jobs.pop(engine, None)
            log_event(f"[zerochat] Motor {engine} de Playwright instalado")
        except (OSError, RuntimeError, subprocess.SubprocessError) as err:
            with self._lock:
                self._jobs[engine] = {"status": "error", "error": format_log_error(str(err), 500)}
            log_event(f"[zerochat] Fallo instalando el motor {engine} de Playwright: {format_log_error(str(err))}")

    def remove(self, engine) -> dict:
        with self._lock:
            cli = self._check_engine(engine)
            # Borrar un motor en uso deja al navegador abierto sin sus ficheros.
            if _playwright_active():
                raise ValueError("Detén Playwright MCP antes de quitar un motor.")
            locations = self._locations(cli)
            for name in ENGINE_CACHE_ENTRIES[engine]:
                if name in locations:
                    shutil.rmtree(locations[name][1], ignore_errors=True)
            self._jobs.pop(engine, None)
        result = self.list()
        # La configuración no se queda con un motor quitado si hay otro instalado.
        config = load_browser_config()
        replacement = next((item["id"] for item in result["engines"] if item["installed"]), None)
        if config["engine"] == engine and replacement:
            save_browser_config({**config, "engine": replacement})
        return result


BROWSER_ENGINES = BrowserEngines()

# ==============================================================================
# Identificación con el usuario y la contraseña del sistema (zerochat/login)
# ==============================================================================

# Tras LOGIN_MAX_FAILURES fallos seguidos, los intentos se rechazan sin comprobarlos durante el bloqueo.
LOGIN_MAX_FAILURES = 5
LOGIN_LOCKOUT_SECONDS = 900.0
LOGIN_MAX_FIELD_LENGTH = 512
# Sin token solo se lee un cuerpo de este tamaño, el justo para zerochat/login.
LOGIN_MAX_BODY_BYTES = 4096
LOGIN_FAILED_CODE = -32001
LOGIN_LOCKED_CODE = -32002
LOGIN_PAM_SERVICE = "login"
LOGIN_LOCK = threading.Lock()
LOGIN_FAILURES = 0
LOGIN_LOCKED_UNTIL = 0.0


class LoginError(Exception):
    """Identificación rechazada: `code` es el error JSON-RPC y `data`, lo que necesita la interfaz."""
    def __init__(self, code: int, message: str, data: dict | None = None):
        super().__init__(message)
        self.code = code
        self.data = data


def system_account() -> str:
    """Cuenta que ejecuta zerochat.py, la única que puede identificarse."""
    if os.name == "nt":
        return getpass.getuser()
    import pwd
    return pwd.getpwuid(os.getuid()).pw_name


def _pam_authenticate(user: str, password: str) -> bool:
    """PAM en Linux y macOS: un proceso sin privilegios comprueba su propia cuenta (unix_chkpwd en Linux)."""
    libpam_path = ctypes.util.find_library("pam")
    if not libpam_path:
        raise RuntimeError("PAM no está disponible en este sistema.")
    libpam = ctypes.CDLL(libpam_path)
    libc = ctypes.CDLL(ctypes.util.find_library("c"))
    libc.calloc.restype = ctypes.c_void_p
    libc.calloc.argtypes = [ctypes.c_size_t, ctypes.c_size_t]
    libc.strdup.restype = ctypes.c_void_p
    libc.strdup.argtypes = [ctypes.c_char_p]

    class PamMessage(ctypes.Structure):
        _fields_ = [("msg_style", ctypes.c_int), ("msg", ctypes.c_char_p)]

    class PamResponse(ctypes.Structure):
        _fields_ = [("resp", ctypes.c_void_p), ("resp_retcode", ctypes.c_int)]

    conv_func = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_int, ctypes.POINTER(ctypes.POINTER(PamMessage)),
                                 ctypes.POINTER(ctypes.POINTER(PamResponse)), ctypes.c_void_p)

    class PamConv(ctypes.Structure):
        _fields_ = [("conv", conv_func), ("appdata_ptr", ctypes.c_void_p)]

    login_name = user.encode("utf-8")
    secret = password.encode("utf-8")

    def conversation(count, messages, response, _appdata):
        # PAM libera las respuestas: se reservan con la libc, no con Python.
        replies = libc.calloc(count, ctypes.sizeof(PamResponse))
        if not replies:
            return 5  # PAM_BUF_ERR
        array = ctypes.cast(replies, ctypes.POINTER(PamResponse))
        for index in range(count):
            style = messages[index].contents.msg_style
            if style == 1:  # PAM_PROMPT_ECHO_OFF: la contraseña
                array[index].resp = libc.strdup(secret)
            elif style == 2:  # PAM_PROMPT_ECHO_ON: el usuario
                array[index].resp = libc.strdup(login_name)
        response[0] = array
        return 0

    libpam.pam_start.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.POINTER(PamConv), ctypes.POINTER(ctypes.c_void_p)]
    libpam.pam_authenticate.argtypes = [ctypes.c_void_p, ctypes.c_int]
    libpam.pam_acct_mgmt.argtypes = [ctypes.c_void_p, ctypes.c_int]
    libpam.pam_end.argtypes = [ctypes.c_void_p, ctypes.c_int]
    callback = conv_func(conversation)
    conv = PamConv(callback, None)
    handle = ctypes.c_void_p()
    status = libpam.pam_start(LOGIN_PAM_SERVICE.encode("ascii"), login_name, ctypes.byref(conv), ctypes.byref(handle))
    if status != 0:
        raise RuntimeError(f"PAM no pudo iniciarse (código {status}).")
    try:
        status = libpam.pam_authenticate(handle, 0)
        if status == 0:
            # Una cuenta caducada o bloqueada no se identifica aunque la contraseña sea correcta.
            status = libpam.pam_acct_mgmt(handle, 0)
    finally:
        libpam.pam_end(handle, status)
    return status == 0


def _windows_logon(user: str, password: str) -> bool:
    """LogonUserW de advapi32 con un inicio de sesión de red, que comprueba la contraseña sin cargar el perfil."""
    from ctypes import wintypes
    advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    advapi32.LogonUserW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
    advapi32.LogonUserW.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    token = wintypes.HANDLE()
    # LOGON32_LOGON_NETWORK (3) y LOGON32_PROVIDER_DEFAULT (0).
    if not advapi32.LogonUserW(user, None, password, 3, 0, ctypes.byref(token)):
        return False
    kernel32.CloseHandle(token)
    return True


def check_system_password(user: str, password: str) -> bool:
    """Comprueba la contraseña de una cuenta del sistema."""
    return _windows_logon(user, password) if os.name == "nt" else _pam_authenticate(user, password)


def login(params: dict) -> dict:
    """
    zerochat/login: con la cuenta que ejecuta zerochat.py y su contraseña devuelve el token diario.
    Tras LOGIN_MAX_FAILURES fallos seguidos rechaza los intentos sin comprobarlos durante
    LOGIN_LOCKOUT_SECONDS; los intentos van de uno en uno.
    """
    global LOGIN_FAILURES, LOGIN_LOCKED_UNTIL
    user = params.get("user")
    password = params.get("password")
    if not all(isinstance(value, str) and 0 < len(value) <= LOGIN_MAX_FIELD_LENGTH for value in (user, password)):
        raise LoginError(-32602, f"user y password deben ser textos de 1 a {LOGIN_MAX_FIELD_LENGTH} caracteres.")
    with LOGIN_LOCK:
        remaining = LOGIN_LOCKED_UNTIL - time.monotonic()
        if remaining > 0:
            raise LoginError(LOGIN_LOCKED_CODE, "Demasiados intentos fallidos: espera para volver a intentarlo.", {"retryAfter": math.ceil(remaining)})
        account = system_account()
        same_account = user.casefold() == account.casefold() if os.name == "nt" else user == account
        # La contraseña se comprueba también con otro usuario, para que la respuesta no delate la cuenta.
        valid = check_system_password(account, password)
        if not (valid and same_account):
            LOGIN_FAILURES += 1
            if LOGIN_FAILURES >= LOGIN_MAX_FAILURES:
                LOGIN_FAILURES = 0
                LOGIN_LOCKED_UNTIL = time.monotonic() + LOGIN_LOCKOUT_SECONDS
            raise LoginError(LOGIN_FAILED_CODE, "Usuario o contraseña incorrectos.")
        LOGIN_FAILURES = 0
    return {"token": current_session_token()}

# ==============================================================================
# Servidor HTTP JSON-RPC 2.0 y SSE con Autenticación por Token
# ==============================================================================

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
        if expected_type is None:
            return f"Tipo no admitido en la definición de '{name}': {expected_type_name}"
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


@dataclasses.dataclass
class McpServiceRecord:
    """Estado de un servicio MCP en este proceso: fase del ciclo de vida, cliente, último error y
    modo y navegador con los que arrancó (solo los servicios de SERVICE_LAUNCH)."""
    phase: str = "stopped"  # stopped, installing, starting, running o error
    client: StdioMcpClient | None = None
    error: str | None = None
    browser: dict | None = None


def service_status(record: McpServiceRecord, alive: bool, exit_code: int | None) -> tuple[str, str | None]:
    """Estado público y error de un servicio a partir de su registro y de si su proceso sigue vivo:
    el proceso de un servicio en marcha puede morir sin que nadie lo detenga."""
    if record.phase != "running" or alive:
        return record.phase, record.error
    if exit_code is not None:
        return "error", f"MCP process exited with code {exit_code}"
    return "error", "MCP process is not responding"


class McpServiceManager:
    def __init__(self, services_root: Path | None = None):
        if services_root:
            self.services_root = Path(services_root)
        else:
            self.services_root = get_data_dir() / "services"
        self.services_root.mkdir(parents=True, exist_ok=True)
        self.config_file = get_data_dir() / "config" / "services.json"
        self.config_file.parent.mkdir(parents=True, exist_ok=True)
        self.records: dict[str, McpServiceRecord] = {}
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

    def _remember(self, server_id: str, enabled: bool):
        """Único sitio que guarda si un servicio queda activo para ofrecerlo en la siguiente sesión: lo
        marca un arranque con remember y lo desmarca detenerlo. Un reinicio (detener y arrancar con el
        valor previo) lo conserva, y un arranque sin remember, como el de un perfil, no lo cambia."""
        self.preferences.setdefault(server_id, {})["enabled"] = enabled
        self._save_preferences()

    def list_servers(self) -> list[dict]:
        self.services = self._load_services()
        result = []
        for server_id, server in self.services.items():
            record = self.records.get(server_id) or McpServiceRecord()
            client = record.client
            exit_code = client.process.poll() if client and client.process else None
            status, error = service_status(record, bool(client and client.running()), exit_code)
            running = status == "running"
            pref = self.preferences.get(server_id, {})
            result.append({
                "id": server_id,
                "displayName": server.get("displayName", {}),
                "description": server.get("description", {}),
                "help": server.get("help"),
                "remote": server.get("remote"),
                "enabled": pref.get("enabled", server.get("enabledByDefault", False)),
                "status": status,
                "toolCount": len(client.tools) if running else 0,
                "error": error,
                "options": server.get("options", []),
                "userOptions": pref.get("options", {}),
                "oauthUrl": client.oauth_url if client else None,
                "browser": record.browser if running else None,
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
                    self.records[server_id].phase = "installing"
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

    def start(self, server_id: str, remember: bool, browser: dict | None = None) -> list[dict]:
        """Arranca un servicio; con remember lo guarda como activo para ofrecerlo en la siguiente sesión.
        `browser` es el navegador que exige el perfil activo, solo para Playwright MCP."""
        with self._lock:
            self.services = self._load_services()
            server = self.services.get(server_id)
            if not server:
                raise KeyError(f"Servidor MCP desconocido: {server_id}")
            record = self.records.setdefault(server_id, McpServiceRecord())
            if record.client and record.client.running():
                return self.list_servers()
            record.phase, record.error = "starting", None
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
                record.browser = None
                if server_id in SERVICE_LAUNCH:
                    extra_args, extra_env, record.browser = SERVICE_LAUNCH[server_id](browser)
                    args += extra_args
                    env.update(extra_env)

                client = StdioMcpClient(
                    command, args, str(service_dir), env,
                    trace=lambda message: self._trace(server_id, message),
                    call_timeout=_positive_seconds(launch.get("callTimeoutSeconds"), DEFAULT_MCP_CALL_TIMEOUT_SECONDS)
                )
                # _prepare_service puede haber dejado el estado en "installing".
                record.phase, record.client = "starting", client
                client.start(int(launch.get("handshakeTimeoutSeconds", 15)))
                record.phase = "running"
                if remember:
                    self._remember(server_id, True)
                self._trace(server_id, "started successfully")
            except Exception as exc:
                record.phase, record.error = "error", str(exc)
                self._trace(server_id, f"start failed: {exc}")
                stale, record.client = record.client or client, None
                if stale:
                    stale.stop()
            return self.list_servers()

    def stop(self, server_id: str) -> list[dict]:
        with self._lock:
            self.services = self._load_services()
            record = self.records.pop(server_id, McpServiceRecord())
            if server_id not in self.services and not record.client:
                raise KeyError(f"Servidor MCP desconocido: {server_id}")
            if record.client:
                record.client.stop()
            self._remember(server_id, False)
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

    def _running_clients(self) -> list[tuple[str, StdioMcpClient]]:
        return [(server_id, record.client) for server_id, record in self.records.items()
                if record.client and record.client.running()]

    def tools(self) -> list[dict]:
        aggregated = []
        seen: set[str] = set()
        with self._lock:
            for server_id, client in self._running_clients():
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

    def _resolve_tool(self, public_name: str) -> tuple[str, StdioMcpClient, str] | None:
        with self._lock:
            for server_id, client in self._running_clients():
                for t in client.tools:
                    try:
                        matches = public_tool_name(server_id, t.get("name")) == public_name
                    except (ValueError, TypeError):
                        continue
                    if matches:
                        return server_id, client, t["name"]
        return None

    def server_of(self, public_name: str) -> str | None:
        resolved = self._resolve_tool(public_name)
        if resolved:
            return resolved[0]
        if not isinstance(public_name, str) or "_" not in public_name:
            return None
        prefix = public_name.split("_", 1)[0]
        try:
            decoded = re.sub(r"z([0-9a-f]+)z", lambda m: chr(int(m.group(1), 16)), prefix)
        except (ValueError, OverflowError):
            return None
        return decoded or None

    def call(self, public_name: str, arguments: dict) -> dict:
        resolved = self._resolve_tool(public_name)
        if not resolved:
            raise ValueError(f"Herramienta externa '{public_name}' no disponible o servidor detenido.")
        # La llamada puede durar decenas de segundos: no debe bloquear al resto de servidores.
        _, client, original_name = resolved
        return client.request("tools/call", {"name": original_name, "arguments": arguments}, timeout=client.call_timeout)

    def close(self):
        with self._lock:
            for record in self.records.values():
                if record.client:
                    record.client.stop()
                record.phase, record.client, record.error = "stopped", None, None


GLOBAL_MCP_MANAGER = McpServiceManager()

# Persistencia local de zerochat.py con SQLite embebido para perfiles de conexión generales y conversaciones.
_STORAGE_LOCK = threading.RLock()
_INITIALIZED_DB: Path | None = None
READONLY_PROFILE_ID = "profile:mirror"
MIRROR_PROFILE_NAME = "Espejo"
MAX_PROFILE_NAME_LENGTH = 128
MAX_PROFILE_DESCRIPTION_LENGTH = 2048
MAX_CONVERSATION_ID_LENGTH = 128
MAX_CONVERSATION_TITLE_LENGTH = 256
MAX_BLOB_SIZE = 50 * 1024 * 1024
MAX_BLOB_HTTP_BYTES = 72 * 1024 * 1024

STORAGE_MIGRATIONS = [
    (1, "001_create_profiles_table", """
        CREATE TABLE IF NOT EXISTS profiles (
            id TEXT PRIMARY KEY,
            name TEXT UNIQUE NOT NULL,
            description TEXT DEFAULT '',
            settings_json TEXT NOT NULL,
            api_key TEXT DEFAULT '',
            version INTEGER DEFAULT 1,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_profiles_name ON profiles(name);
        CREATE INDEX IF NOT EXISTS idx_profiles_updated_at ON profiles(updated_at);
    """),
    (2, "002_create_conversations_tables", """
        CREATE TABLE IF NOT EXISTS conversations (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            message_count INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at);

        CREATE TABLE IF NOT EXISTS messages (
            conversation_id TEXT NOT NULL,
            position INTEGER NOT NULL,
            id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            extra_json TEXT DEFAULT '{}',
            FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
            PRIMARY KEY (conversation_id, position)
        );
    """),
    (3, "003_create_blobs_table", """
        CREATE TABLE IF NOT EXISTS blobs (
            id TEXT PRIMARY KEY,
            mime_type TEXT NOT NULL,
            size INTEGER NOT NULL,
            data BLOB NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_blobs_created_at ON blobs(created_at);
    """),
    (4, "004_add_extra_json_to_conversations", """
        ALTER TABLE conversations ADD COLUMN extra_json TEXT DEFAULT '{}';
    """),
    (5, "005_create_security_policies_table", """
        CREATE TABLE IF NOT EXISTS security_policies (
            id TEXT PRIMARY KEY,
            user_id TEXT,
            data_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_security_policies_user ON security_policies(user_id);
    """)
]


def get_storage_dir() -> Path:
    """Directorio persistente con permisos 0700 para la base de datos local de ZeroChat."""
    storage_dir = get_data_dir() / "storage"
    storage_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    if os.name != "nt":
        storage_dir.chmod(0o700)
    return storage_dir


def get_storage_db_path() -> Path:
    """Ruta al archivo SQLite principal de ZeroChat."""
    return get_storage_dir() / "zerochat.db"


def _secure_db_files(db_path: Path):
    """Garantiza permisos 0600 en el archivo SQLite y sus auxiliares de journaling en POSIX."""
    if os.name == "nt":
        return
    if not db_path.exists():
        fd = os.open(db_path, os.O_WRONLY | os.O_CREAT, 0o600)
        os.close(fd)
    for target in (db_path, db_path.with_name(db_path.name + "-wal"), db_path.with_name(db_path.name + "-shm")):
        if target.exists():
            target.chmod(0o600)


def _apply_migrations(conn: sqlite3.Connection):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at INTEGER NOT NULL,
            description TEXT NOT NULL
        );
    """)
    applied = {row["version"] for row in conn.execute("SELECT version FROM schema_migrations;").fetchall()}
    for version, description, sql in STORAGE_MIGRATIONS:
        if version not in applied:
            conn.executescript(sql)
            conn.execute(
                "INSERT INTO schema_migrations (version, applied_at, description) VALUES (?, ?, ?);",
                (version, int(time.time() * 1000), description)
            )
    conn.commit()


@contextlib.contextmanager
def open_storage():
    """Abre una conexión SQLite segura con migraciones aplicadas y la cierra al salir."""
    global _INITIALIZED_DB
    with _STORAGE_LOCK:
        db_path = get_storage_db_path()
        needs_init = _INITIALIZED_DB != db_path or not db_path.exists()
        _secure_db_files(db_path)
        conn = sqlite3.connect(str(db_path), timeout=5.0)
        try:
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode=WAL;")
            conn.execute("PRAGMA foreign_keys=ON;")
            conn.execute("PRAGMA busy_timeout=5000;")
            _secure_db_files(db_path)
            if needs_init:
                _apply_migrations(conn)
                _INITIALIZED_DB = db_path
            yield conn
        finally:
            conn.close()


def normalize_profile_id(name: str, given_id: str | None = None) -> str:
    """Genera o normaliza un identificador único para el perfil general."""
    if given_id and isinstance(given_id, str) and given_id.strip():
        clean = given_id.strip()
        return clean if clean.startswith("profile:") else f"profile:{clean}"
    clean_name = urllib.parse.quote(name.strip())
    return f"profile:general-{clean_name}"


def validate_profile_payload(record: dict) -> tuple[str, str, str, dict, str | None]:
    """Valida los campos obligatorios del perfil y separa ajustes de la clave secreta."""
    if not isinstance(record, dict):
        raise ValueError("El perfil debe ser un objeto")
    name = str(record.get("name") or "").strip()
    if not name:
        raise ValueError("El nombre del perfil no puede estar vacío")
    if len(name) > MAX_PROFILE_NAME_LENGTH:
        raise ValueError(f"El nombre del perfil no puede superar {MAX_PROFILE_NAME_LENGTH} caracteres")

    description = str(record.get("description") or "").strip()
    if len(description) > MAX_PROFILE_DESCRIPTION_LENGTH:
        raise ValueError(f"La descripción no puede superar {MAX_PROFILE_DESCRIPTION_LENGTH} caracteres")

    profile_id = normalize_profile_id(name, record.get("id"))
    if profile_id == READONLY_PROFILE_ID or name.lower() == MIRROR_PROFILE_NAME.lower():
        raise ValueError("El perfil Espejo no se puede modificar")

    settings_source = record.get("settings")
    if not isinstance(settings_source, dict):
        raise ValueError("Los ajustes del perfil deben ser un objeto")

    settings = dict(settings_source)
    has_api_key = "apiKey" in settings or "apiKey" in record
    raw_key = settings.pop("apiKey", None)
    if raw_key is None:
        raw_key = record.get("apiKey")
    api_key = str(raw_key or "").strip() if has_api_key else None
    return profile_id, name, description, settings, api_key


def _row_to_profile(row: sqlite3.Row) -> dict:
    """Transforma una fila SQLite en el objeto de perfil del servidor."""
    try:
        settings = json.loads(row["settings_json"])
    except (json.JSONDecodeError, TypeError):
        settings = {}

    settings["apiKey"] = row["api_key"] or ""
    return {
        "id": row["id"],
        "name": row["name"],
        "description": row["description"] or "",
        "general": True,
        "schemaVersion": 1,
        "version": row["version"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "settings": settings
    }


def list_general_profiles() -> list[dict]:
    """Lista todos los perfiles de conexión del servidor almacenados en SQLite."""
    with open_storage() as conn:
        rows = conn.execute("SELECT * FROM profiles ORDER BY name COLLATE NOCASE ASC;").fetchall()
        return [_row_to_profile(row) for row in rows]


def get_general_profile(profile_id: str) -> dict | None:
    """Recupera un perfil de servidor por su identificador único."""
    if not profile_id or not isinstance(profile_id, str) or not profile_id.strip():
        return None
    clean_id = normalize_profile_id("", profile_id)
    with open_storage() as conn:
        row = conn.execute("SELECT * FROM profiles WHERE id = ?;", (clean_id,)).fetchone()
        return _row_to_profile(row) if row else None


def get_general_profile_by_name(name: str) -> dict | None:
    """Recupera un perfil de servidor por su nombre."""
    if not name or not isinstance(name, str) or not name.strip():
        return None
    clean = name.strip()
    stripped = clean[2:].strip() if clean[:2].upper() == "Z-" else clean
    candidates = list(dict.fromkeys([clean, stripped, f"Z-{stripped}", f"Z- {stripped}"]))
    with open_storage() as conn:
        for candidate in candidates:
            row = conn.execute("SELECT * FROM profiles WHERE name = ? COLLATE NOCASE;", (candidate,)).fetchone()
            if row:
                return _row_to_profile(row)
        return None


def save_general_profile(record: dict) -> dict:
    """Guarda (crea o actualiza) un perfil de conexión del servidor en SQLite."""
    profile_id, name, description, settings, api_key = validate_profile_payload(record)
    now = int(time.time() * 1000)

    with open_storage() as conn:
        existing = conn.execute("SELECT * FROM profiles WHERE id = ?;", (profile_id,)).fetchone()
        if existing:
            try:
                existing_settings = json.loads(existing["settings_json"])
            except (json.JSONDecodeError, TypeError):
                existing_settings = {}
            if existing_settings.get("apiKeyLocked") is True:
                raise ValueError("Los cambios en este perfil están bloqueados")

        same_name = conn.execute(
            "SELECT id FROM profiles WHERE name = ? COLLATE NOCASE AND id != ?;",
            (name, profile_id)
        ).fetchone()
        if same_name:
            raise ValueError(f"Ya existe un perfil con el nombre '{name}' en el servidor")

        if existing:
            version = existing["version"] + 1
            final_api_key = (existing["api_key"] or "") if api_key is None else api_key
            conn.execute("""
                UPDATE profiles
                SET name = ?, description = ?, settings_json = ?, api_key = ?, version = ?, updated_at = ?
                WHERE id = ?;
            """, (name, description, json.dumps(settings), final_api_key, version, now, profile_id))
        else:
            conn.execute("""
                INSERT INTO profiles (id, name, description, settings_json, api_key, version, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, 1, ?, ?);
            """, (profile_id, name, description, json.dumps(settings), api_key or "", now, now))

        conn.commit()
        saved_row = conn.execute("SELECT * FROM profiles WHERE id = ?;", (profile_id,)).fetchone()
        return _row_to_profile(saved_row)


def delete_general_profile(profile_id: str) -> bool:
    """Elimina un perfil de conexión general de SQLite."""
    if not profile_id or not isinstance(profile_id, str) or not profile_id.strip():
        return False
    clean_id = normalize_profile_id("", profile_id)
    with open_storage() as conn:
        cursor = conn.execute("DELETE FROM profiles WHERE id = ?;", (clean_id,))
        conn.commit()
        return cursor.rowcount > 0


# ==============================================================================
# Almacén de conversaciones y mensajes (M46)
# ==============================================================================

def _validate_conversation_id(session_id) -> str:
    if not isinstance(session_id, str) or not session_id.strip():
        raise ValueError("El identificador de la conversación no puede estar vacío")
    clean = session_id.strip()
    if len(clean) > MAX_CONVERSATION_ID_LENGTH:
        raise ValueError(f"El identificador no puede superar {MAX_CONVERSATION_ID_LENGTH} caracteres")
    return clean


def _validate_conversation_title(title, allow_empty: bool = False) -> str:
    if not isinstance(title, str):
        raise ValueError("El título de la conversación debe ser un texto")
    clean = title.strip()
    if not allow_empty and not clean:
        raise ValueError("El título de la conversación no puede estar vacío")
    if len(clean) > MAX_CONVERSATION_TITLE_LENGTH:
        raise ValueError(f"El título no puede superar {MAX_CONVERSATION_TITLE_LENGTH} caracteres")
    return clean


def _row_to_conversation_header(row: sqlite3.Row) -> dict:
    """Transforma una fila SQLite en la cabecera de una conversación."""
    header = {
        "id": row["id"],
        "title": row["title"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "messageCount": row["message_count"]
    }
    extra = json.loads(row["extra_json"]) if row["extra_json"] else {}
    if "profile_id" in extra:
        header["profileId"] = extra["profile_id"]
    if "server_run" in extra:
        header["serverRun"] = bool(extra["server_run"])
    if extra.get("project"):
        header["project"] = extra["project"]
    return header


def _row_to_message(row: sqlite3.Row) -> dict:
    """Transforma una fila SQLite en el objeto de mensaje de la conversación."""
    extra = json.loads(row["extra_json"]) if row["extra_json"] else {}
    return {
        "id": row["id"],
        "role": row["role"],
        "content": row["content"],
        **extra
    }


def list_conversations() -> list[dict]:
    """Lista las cabeceras de conversaciones ordenadas de más reciente a más antigua."""
    with open_storage() as conn:
        rows = conn.execute("SELECT * FROM conversations ORDER BY updated_at DESC;").fetchall()
        return [_row_to_conversation_header(row) for row in rows]


def get_conversation(session_id: str) -> dict | None:
    """Recupera una conversación completa con sus mensajes ordenados por posición."""
    clean_id = _validate_conversation_id(session_id)
    with open_storage() as conn:
        conv_row = conn.execute("SELECT * FROM conversations WHERE id = ?;", (clean_id,)).fetchone()
        if not conv_row:
            return None
        header = _row_to_conversation_header(conv_row)
        msg_rows = conn.execute(
            "SELECT * FROM messages WHERE conversation_id = ? ORDER BY position ASC;",
            (clean_id,)
        ).fetchall()
        return {**header, "history": [_row_to_message(row) for row in msg_rows]}


def save_conversation(session_meta: dict, messages: list[dict] | None = None) -> dict:
    """Guarda o actualiza una conversación y sustituye sus mensajes atómicamente."""
    if not isinstance(session_meta, dict):
        raise ValueError("Los metadatos de la conversación deben ser un objeto")
    if messages is None:
        messages = []
    if not isinstance(messages, list):
        raise ValueError("Los mensajes de la conversación deben ser una lista")

    session_id = _validate_conversation_id(session_meta.get("id"))
    raw_title = session_meta.get("title")
    title = _validate_conversation_title("" if raw_title is None else raw_title, allow_empty=True)

    now = int(time.time() * 1000)
    created_at = int(session_meta.get("createdAt") or now)
    updated_at = int(session_meta.get("updatedAt") or now)

    # extra_json guarda el perfil, el modo servidor y el proyecto; la cabecera los expone como campos propios.
    extra = {}
    profile_id = session_meta.get("profileId")
    if profile_id and isinstance(profile_id, str) and profile_id.strip():
        extra["profile_id"] = profile_id.strip()
    if session_meta.get("serverRun") is not None:
        extra["server_run"] = bool(session_meta.get("serverRun"))
    project = session_meta.get("project")
    if project is not None:
        if not isinstance(project, str) or len(project) > MAX_PATH_LENGTH:
            raise ValueError("El proyecto de la conversación debe ser una ruta")
        if project.strip():
            extra["project"] = project.strip()

    with open_storage() as conn:
        existing = conn.execute("SELECT created_at, extra_json, title FROM conversations WHERE id = ?;", (session_id,)).fetchone()
        if existing:
            if not session_meta.get("createdAt") and existing["created_at"]:
                created_at = int(existing["created_at"])
            if not title and existing["title"]:
                title = existing["title"]
            existing_extra = json.loads(existing["extra_json"]) if existing["extra_json"] else {}
            extra = {**existing_extra, **extra}
            # El proyecto se fija al crear la conversación y no cambia después.
            if existing_extra.get("project"):
                extra["project"] = existing_extra["project"]

        extra_json = json.dumps(extra, ensure_ascii=False) if extra else "{}"

        conn.execute("""
            INSERT INTO conversations (id, title, created_at, updated_at, message_count, extra_json)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                title = excluded.title,
                updated_at = excluded.updated_at,
                message_count = excluded.message_count,
                extra_json = excluded.extra_json;
        """, (session_id, title, created_at, updated_at, len(messages), extra_json))

        conn.execute("DELETE FROM messages WHERE conversation_id = ?;", (session_id,))

        for pos, msg in enumerate(messages):
            if not isinstance(msg, dict):
                raise ValueError("Cada mensaje debe ser un objeto")
            msg_id = str(msg.get("id") or "").strip() or f"msg_{session_id}_{pos}"
            role = str(msg.get("role") or "user").strip()
            content = "" if msg.get("content") is None else str(msg.get("content"))
            extra = {k: v for k, v in msg.items() if k not in ("id", "role", "content", "conversationId", "position")}
            extra_json = json.dumps(extra) if extra else "{}"

            conn.execute("""
                INSERT INTO messages (conversation_id, position, id, role, content, extra_json)
                VALUES (?, ?, ?, ?, ?, ?);
            """, (session_id, pos, msg_id, role, content, extra_json))

        conn.commit()
        row = conn.execute("SELECT * FROM conversations WHERE id = ?;", (session_id,)).fetchone()
        return _row_to_conversation_header(row)


def mark_conversation_server_run(session_id: str, profile_name: str | None = None) -> bool:
    """Marca la conversación en SQLite como ejecutada en servidor asociándole el perfil."""
    try:
        clean_id = _validate_conversation_id(session_id)
    except (ValueError, TypeError):
        return False
    try:
        with open_storage() as conn:
            row = conn.execute("SELECT extra_json FROM conversations WHERE id = ?;", (clean_id,)).fetchone()
            if not row:
                return False
            cur_extra = json.loads(row["extra_json"]) if row["extra_json"] else {}
            cur_extra["server_run"] = True
            if profile_name:
                cur_extra["profile_id"] = str(profile_name).strip()
            conn.execute("UPDATE conversations SET extra_json = ? WHERE id = ?;", (json.dumps(cur_extra, ensure_ascii=False), clean_id))
            conn.commit()
            return True
    except (sqlite3.Error, OSError, json.JSONDecodeError):
        return False


def rename_conversation(session_id: str, new_title: str) -> bool:
    """Renombra una conversación existente en SQLite."""
    clean_id = _validate_conversation_id(session_id)
    title = _validate_conversation_title(new_title)
    now = int(time.time() * 1000)
    with open_storage() as conn:
        cursor = conn.execute(
            "UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?;",
            (title, now, clean_id)
        )
        conn.commit()
        return cursor.rowcount > 0


# Identificadores de blob de las imágenes de los mensajes (messages.extra_json, campo images[].blobId).
_MESSAGE_BLOB_IDS_SQL = """
    SELECT DISTINCT json_extract(image.value, '$.blobId') AS blob_id
    FROM messages, json_each(messages.extra_json, '$.images') AS image
    WHERE json_valid(messages.extra_json) AND json_extract(image.value, '$.blobId') IS NOT NULL
"""


def _delete_conversations(conn: sqlite3.Connection, where: str, params: tuple) -> list[str]:
    """
    Borra en una transacción las conversaciones que cumplen `where`, con sus mensajes en cascada, y los
    blobs que solo ellas referenciaban. Solo se consideran los blobs de las conversaciones borradas: uno
    subido para una conversación que aún no se ha guardado no se toca.
    """
    conn.isolation_level = None
    conn.execute("BEGIN IMMEDIATE;")
    try:
        ids = [row["id"] for row in conn.execute(f"SELECT id FROM conversations WHERE {where};", params)]
        if ids:
            marks = ",".join("?" for _ in ids)
            candidates = {row["blob_id"] for row in conn.execute(
                f"{_MESSAGE_BLOB_IDS_SQL} AND messages.conversation_id IN ({marks});", ids)}
            conn.execute(f"DELETE FROM conversations WHERE id IN ({marks});", ids)
            if candidates:
                still_used = {row["blob_id"] for row in conn.execute(_MESSAGE_BLOB_IDS_SQL)}
                orphans = [(blob_id,) for blob_id in candidates - still_used]
                conn.executemany("DELETE FROM blobs WHERE id = ?;", orphans)
        conn.execute("COMMIT;")
        return ids
    except Exception:
        conn.execute("ROLLBACK;")
        raise


def delete_conversation(session_id: str) -> bool:
    """Elimina una conversación con sus mensajes y los blobs que solo ella usaba."""
    clean_id = _validate_conversation_id(session_id)
    with open_storage() as conn:
        return bool(_delete_conversations(conn, "id = ?", (clean_id,)))


def delete_project_conversations(project: str) -> list[str]:
    """Elimina las conversaciones de un proyecto con sus mensajes y blobs propios, y devuelve sus identificadores."""
    if not isinstance(project, str) or not project.strip() or len(project) > MAX_PATH_LENGTH:
        raise ValueError("El proyecto de las conversaciones debe ser una ruta")
    with open_storage() as conn:
        return _delete_conversations(conn, "json_extract(extra_json, '$.project') = ?", (project.strip(),))


def delete_all_conversations() -> int:
    """Elimina todas las conversaciones con sus mensajes y los blobs que estas usaban."""
    with open_storage() as conn:
        return len(_delete_conversations(conn, "1 = 1", ()))


def _validate_blob_id(blob_id: str) -> str:
    """Valida que el identificador del blob sea un hash SHA-256 en hexadecimal (64 caracteres)."""
    if not isinstance(blob_id, str) or not re.match(r"^[0-9a-f]{64}$", blob_id.strip().lower()):
        raise ValueError(f"ID de blob inválido (debe ser un hash SHA-256 hexadecimal de 64 caracteres): {blob_id}")
    return blob_id.strip().lower()


def put_blob(data_bytes: bytes, mime_type: str = "application/octet-stream", blob_id: str | None = None) -> dict:
    """Almacena un blob binario indexado por su hash SHA-256."""
    if not isinstance(data_bytes, (bytes, bytearray)):
        raise ValueError("Los datos del blob deben ser bytes")
    if len(data_bytes) == 0:
        raise ValueError("El blob no puede estar vacío")
    if len(data_bytes) > MAX_BLOB_SIZE:
        raise ValueError(f"El tamaño del blob ({len(data_bytes)} bytes) excede el máximo permitido ({MAX_BLOB_SIZE} bytes)")

    calc_id = hashlib.sha256(data_bytes).hexdigest()
    if blob_id is not None:
        clean_id = _validate_blob_id(blob_id)
        if clean_id != calc_id:
            raise ValueError(f"El ID del blob ({clean_id}) no coincide con el hash SHA-256 de los datos ({calc_id})")
    else:
        clean_id = calc_id

    mime = (mime_type or "application/octet-stream").strip()
    now = int(time.time() * 1000)
    with open_storage() as conn:
        conn.execute("""
            INSERT INTO blobs (id, mime_type, size, data, created_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                mime_type = excluded.mime_type,
                size = excluded.size,
                data = excluded.data;
        """, (clean_id, mime, len(data_bytes), sqlite3.Binary(data_bytes), now))
        conn.commit()
    return {"id": clean_id, "mime_type": mime, "size": len(data_bytes), "created_at": now}


def get_blob(blob_id: str) -> dict | None:
    """Recupera un blob por su hash SHA-256."""
    clean_id = _validate_blob_id(blob_id)
    with open_storage() as conn:
        row = conn.execute("SELECT id, mime_type, size, data, created_at FROM blobs WHERE id = ?;", (clean_id,)).fetchone()
        if not row:
            return None
        return {
            "id": row["id"],
            "mime_type": row["mime_type"],
            "size": row["size"],
            "data": bytes(row["data"]),
            "created_at": row["created_at"],
        }


def has_blobs(blob_ids: list[str]) -> dict:
    """Comprueba la existencia de una lista de IDs de blobs, devolviendo los existentes y los faltantes."""
    if not isinstance(blob_ids, list):
        raise ValueError("La lista de IDs de blobs debe ser una lista")
    if len(blob_ids) > 1000:
        raise ValueError("No se pueden consultar más de 1000 IDs de blobs a la vez")
    clean_ids = [_validate_blob_id(bid) for bid in blob_ids]
    if not clean_ids:
        return {"existing": [], "missing": []}
    unique_ids = list(dict.fromkeys(clean_ids))
    with open_storage() as conn:
        placeholders = ",".join("?" for _ in unique_ids)
        rows = conn.execute(f"SELECT id FROM blobs WHERE id IN ({placeholders});", unique_ids).fetchall()
        existing_set = {row["id"] for row in rows}
        return {
            "existing": [bid for bid in unique_ids if bid in existing_set],
            "missing": [bid for bid in unique_ids if bid not in existing_set],
        }


def _parse_security_policy_row(row) -> dict | None:
    """Decodifica la fila de políticas; un JSON corrupto es un error visible, nunca un estado vacío."""
    if not row:
        return None
    try:
        data = json.loads(row["data_json"])
    except (ValueError, TypeError) as exc:
        raise RuntimeError(f"Las políticas de seguridad guardadas están corruptas: {exc}") from exc
    if not isinstance(data, dict):
        raise RuntimeError("Las políticas de seguridad guardadas no son un objeto JSON.")
    return data


def get_security_policy_data() -> dict | None:
    """Recupera los datos de políticas de seguridad guardados en SQLite (None si no hay ninguno)."""
    with open_storage() as conn:
        row = conn.execute("SELECT data_json FROM security_policies WHERE id = 'default';").fetchone()
        return _parse_security_policy_row(row)


def update_security_policy_data(mutator: typing.Callable[[dict | None], dict]) -> dict:
    """Ejecuta una lectura-modificación-escritura atómica en una transacción BEGIN IMMEDIATE."""
    with open_storage() as conn:
        conn.isolation_level = None
        conn.execute("BEGIN IMMEDIATE;")
        try:
            row = conn.execute("SELECT data_json FROM security_policies WHERE id = 'default';").fetchone()
            updated = mutator(_parse_security_policy_row(row))
            data_str = json.dumps(updated, ensure_ascii=False)
            now = int(time.time() * 1000)
            conn.execute("""
                INSERT INTO security_policies (id, data_json, updated_at)
                VALUES ('default', ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    data_json = excluded.data_json,
                    updated_at = excluded.updated_at;
            """, (data_str, now))
            conn.execute("COMMIT;")
            return updated
        except Exception:
            conn.execute("ROLLBACK;")
            raise

DEFAULT_HEARTBEAT_TIMEOUT = 60.0
DEFAULT_HEARTBEAT_GRACE = 45.0
DEFAULT_HEARTBEAT_POLL = 5.0
HEARTBEAT_LAST_SEEN = 0.0
HEARTBEAT_INITIALIZED = False
HEARTBEAT_WATCHDOG_STOP = threading.Event()
_SERVER_SHUTTING_DOWN = threading.Event()
# Si el servidor se detiene al cerrar el navegador, cerrar la pestaña detiene también los comandos.
EXIT_ON_CLOSE = False
# zerochat/run/progress ya se registra con su propio texto en dispatch_run.
# Un navegador lo usa una conversación cada vez; queda libre tras este tiempo sin que lo use. Cubre lo que
# el modelo tarda en razonar entre dos acciones, no la espera a otra petición del usuario.
BROWSER_LEASE_IDLE_SECONDS = 60.0


class BrowserLease:
    """
    Reserva de los navegadores (browser_action y Playwright MCP): la conversación que los usa los conserva
    mientras siga usándolos; otra recibe un error claro hasta que pasen BROWSER_LEASE_IDLE_SECONDS sin uso.
    Sin cola: compartir la página haría que una conversación actuase sobre la de otra.
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._holders: dict[str, tuple[str, float]] = {}

    def acquire(self, resource: str, conversation_id: str) -> bool:
        now = time.monotonic()
        with self._lock:
            holder = self._holders.get(resource)
            if holder and holder[0] != conversation_id and now - holder[1] < BROWSER_LEASE_IDLE_SECONDS:
                return False
            self._holders[resource] = (conversation_id, now)
            return True


BROWSER_LEASES = BrowserLease()

QUIET_RPC_METHODS = frozenset({"zerochat/heartbeat", "zerochat/jobs/get", "zerochat/jobs/log", "zerochat/jobs/list", "zerochat/run/progress"})


def mark_browser_active():
    """Registra la presencia del navegador ante cualquier petición de un origen permitido, aunque su
    token haya caducado: el auto-cierre no detiene el servidor ni sus comandos al cambiar el día."""
    global HEARTBEAT_LAST_SEEN, HEARTBEAT_INITIALIZED
    HEARTBEAT_LAST_SEEN = time.monotonic()
    HEARTBEAT_INITIALIZED = True


def live_state(ctx: SecurityContext, focus_conversation_id: str | None = None) -> dict:
    """
    Estado del servidor que la interfaz sigue en vivo, en initialize y en cada zerochat/heartbeat:
    cwd, el proyecto de la pestaña que pregunta (su cabecera X-ZeroChat-Project); jobs, los comandos en
    marcha, para mostrarlos y avisar antes de cerrar si se detendrían; exit_on_close; playwright, si
    se puede navegar aunque se haya instalado o quitado durante la sesión; servers, los servicios
    MCP externos aunque otra pestaña los cambie o su proceso muera; runs, lista ligera de ejecuciones
    en segundo plano; y focus_run, estado detallado de la ejecución enfocada por el usuario.
    """
    runs, focus_run = list_server_runs(focus_conversation_id)
    return {
        "cwd": str(ctx.workspace_dir),
        "jobs": [job.summary() for job in JOBS.running(ctx.key)],
        "exit_on_close": EXIT_ON_CLOSE,
        "playwright": playwright_status(),
        "servers": GLOBAL_MCP_MANAGER.list_servers(),
        "runs": runs,
        "focus_run": focus_run
    }


def stop_zerochat_server(server: ThreadingHTTPServer):
    """Detiene limpiamente el servidor y todos los subsistemas evitando reentradas."""
    if _SERVER_SHUTTING_DOWN.is_set():
        return
    _SERVER_SHUTTING_DOWN.set()
    HEARTBEAT_WATCHDOG_STOP.set()
    running = JOBS.running(None)
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
            runs, _ = list_server_runs()
            if any(r.get("status") == "running" for r in runs):
                continue
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
DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
# El User-Agent activo se sustituye por el de la primera petición del frontend (variabilidad de
# fingerprint); sin frontend (--prompt/--conversation) se queda el valor por defecto.
ACTIVE_USER_AGENT = DEFAULT_USER_AGENT


def capture_frontend_user_agent(user_agent: str) -> None:
    """Adopta el User-Agent de la primera petición del frontend como User-Agent de las salidas web."""
    global ACTIVE_USER_AGENT
    if ACTIVE_USER_AGENT is DEFAULT_USER_AGENT and isinstance(user_agent, str) and user_agent.strip():
        ACTIVE_USER_AGENT = user_agent.strip()
        set_service_user_agent(ACTIVE_USER_AGENT)


# Los motores propios de Playwright arrancan con el User-Agent por defecto hasta que el
# frontend fija el suyo en la primera petición.
set_service_user_agent(DEFAULT_USER_AGENT)
WEB_FETCH_MAX_BYTES = 10 * 1024 * 1024
WEB_FETCH_MAX_REDIRECTS = 5
WEB_FETCH_READ_CHUNK = 64 * 1024
TEXT_CONTENT_TYPE_RE = re.compile(
    r"^(text/|application/(json|xml|xhtml\+xml|javascript|x-javascript|ecmascript)$|[a-z]+/[^;]*\+(json|xml)$)"
)
# Control de cadencia frente a retos anti-bot: mínimo WEB_FETCH_MIN_GAP_S desde la RESPUESTA
# anterior al mismo host; las peticiones en paralelo se escalonan de WEB_FETCH_PARALLEL_STAGGER_S
# en WEB_FETCH_PARALLEL_STAGGER_S para que no coincidan. El timestamp se inicializa al arrancar
# para que la primera petición espere aunque no se haya hecho ninguna antes.
_WEB_FETCH_LOCK = threading.Lock()
_LAST_WEB_FETCH_AT: dict[str, float] = {"duckduckgo.com": time.monotonic()}
_WEB_FETCH_PENDING: dict[str, int] = {}
WEB_FETCH_HOST_PACING_DOMAINS = ("duckduckgo.com",)
WEB_FETCH_MIN_GAP_S = 2.0
WEB_FETCH_PARALLEL_STAGGER_S = 5.0



def _is_public_ip(address: str) -> bool:
    """Una dirección es pública si es global y no multicast; las IPv4 mapeadas en IPv6 se evalúan como IPv4."""
    ip = ipaddress.ip_address(address.split("%", 1)[0])
    if ip.version == 6 and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return ip.is_global and not ip.is_multicast


# Una dirección IPv4 en notación numérica: partes decimales o hexadecimales (0x…), de una a cuatro.
_NUMERIC_HOST = re.compile(r"(?:0x[0-9a-f]*|\d+)(?:\.(?:0x[0-9a-f]*|\d+)){0,3}")


def is_dangerous_host(hostname: str) -> bool:
    """Riesgo de SSRF: metadatos cloud, nombres locales o cualquier dirección resuelta no pública."""
    clean_host = (hostname or "").strip().lower().strip("[]").rstrip(".")
    if not clean_host or clean_host in METADATA_HOSTS or clean_host == "localhost":
        return True
    if clean_host.endswith((".localhost", ".local", ".internal")):
        return True
    if _NUMERIC_HOST.fullmatch(clean_host):
        # Abreviadas, enteras, hexadecimales u octales (127.1, 2130706433, 0x7f.1, 0177.0.0.1): cada
        # resolvedor las interpreta a su manera, así que solo se admite la forma canónica.
        try:
            ipaddress.IPv4Address(clean_host)
        except ValueError:
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

    parsed = urllib.parse.urlsplit(url)
    hostname = (parsed.hostname or "").lower()

    # Hosts sensibles (ej. DuckDuckGo): esperar al menos WEB_FETCH_MIN_GAP_S desde la respuesta
    # anterior y escalar las peticiones en paralelo de a WEB_FETCH_PARALLEL_STAGGER_S.
    pacing_domain = next(
        (domain for domain in WEB_FETCH_HOST_PACING_DOMAINS if hostname == domain or hostname.endswith("." + domain)),
        None,
    )
    if pacing_domain is None:
        return _fetch_web_resource_unpaced(url, params, hostname, parsed)

    with _WEB_FETCH_LOCK:
        pending = _WEB_FETCH_PENDING.get(pacing_domain, 0)
        gap = time.monotonic() - _LAST_WEB_FETCH_AT.get(pacing_domain, 0.0)
        sleep_needed = max(0.0, WEB_FETCH_MIN_GAP_S - gap) + WEB_FETCH_PARALLEL_STAGGER_S * pending
        _WEB_FETCH_PENDING[pacing_domain] = pending + 1
    try:
        if sleep_needed > 0:
            time.sleep(sleep_needed)
        return _fetch_web_resource_unpaced(url, params, hostname, parsed)
    finally:
        # El timestamp marca la respuesta (o el intento) terminado: la próxima petición
        # cuenta los 2 s desde aquí.
        with _WEB_FETCH_LOCK:
            _LAST_WEB_FETCH_AT[pacing_domain] = time.monotonic()
            _WEB_FETCH_PENDING[pacing_domain] = max(0, _WEB_FETCH_PENDING[pacing_domain] - 1)


def _fetch_web_resource_unpaced(url: str, params: dict, hostname: str, parsed) -> dict:
    """Cuerpo de fetch_web_resource sin cadencia: cabeceras, descarga y respuesta."""
    timeout_s = max(0.5, min(float(params.get("timeout_s", 10.0)), 30.0))
    max_bytes = max(1024, min(int(params.get("max_bytes", 2 * 1024 * 1024)), WEB_FETCH_MAX_BYTES))
    as_binary = bool(params.get("binary", False))
    accept = params.get("accept")
    req_headers = {
        "User-Agent": ACTIVE_USER_AGENT,
        "Accept": accept if isinstance(accept, str) and accept else "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
        "Accept-Encoding": "gzip, deflate",
        "Sec-Ch-Ua": '"Not_A Brand";v="8", "Chromium";v="131", "Google Chrome";v="131"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": '"Windows"',
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "Upgrade-Insecure-Requests": "1",
    }
    if hostname.endswith("duckduckgo.com"):
        req_headers["Referer"] = f"{parsed.scheme}://{parsed.netloc}/"

    req = urllib.request.Request(url, headers=req_headers)
    try:
        with _WEB_OPENER.open(req, timeout=timeout_s) as resp:
            content_type = resp.headers.get("Content-Type", "")
            raw_data, truncated = _read_limited_body(resp, resp.headers.get("Content-Encoding", ""), max_bytes)
            # Las cabeceras de transporte ya no describen el cuerpo descomprimido.
            resp_headers = {k: v for k, v in resp.getheaders() if k.lower() not in ("content-encoding", "content-length")}
            # Respuestas 202 u otros retos anti-bot se marcan como error no exitoso.
            if resp.status == 202:
                return {
                    "ok": False,
                    "status": resp.status,
                    "error": "HTTP 202: Reto anti-bot o verificación de anomalía detectada por el servidor remoto.",
                    "text": raw_data.decode("utf-8", errors="replace")
                }
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
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization, X-ZeroChat-Token, X-ZeroChat-Client, X-ZeroChat-Proxy, X-ZeroChat-Blob, X-ZeroChat-Project")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def verify_token(self) -> bool:
        """
        Comprueba el token diario vigente, solo en cabeceras HTTP: el de un día anterior se rechaza.
        X-ZeroChat-Token va antes que Authorization, que tras el proxy inverso lleva la clave del proxy.
        """
        token_candidate = self.headers.get("X-ZeroChat-Token", "").strip()
        if not token_candidate:
            auth_header = self.headers.get("Authorization", "")
            if auth_header.startswith("Bearer "):
                token_candidate = auth_header[7:].strip()
        return bool(token_candidate) and hmac.compare_digest(token_candidate.encode(), current_session_token().encode())

    def do_OPTIONS(self):
        t0 = time.monotonic()
        safe_path = sanitize_log_path(self.path)
        origin = self.headers.get("Origin")
        if not is_allowed_origin(origin, require_origin=True):
            self._log_req("OPTIONS", safe_path)
            self.send_response(403)
            self.end_headers()
            self._log_res(403, safe_path, (time.monotonic() - t0) * 1000, f"Origen no permitido: '{origin}'")
            return
        # La comprobación previa precede a cada POST con cabeceras propias, también al latido: no se registra.
        self.send_response(204)
        self.send_cors_headers()
        self.end_headers()

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
        """Solo la interfaz servida en desarrollo y el favicon: la API va por POST."""
        t0 = time.monotonic()
        safe_path = sanitize_log_path(self.path)
        path_clean = self.path.split("?", 1)[0].rstrip("/")
        self._log_req("GET", safe_path)

        origin = self.headers.get("Origin")
        if not is_allowed_origin(origin):
            self.send_response(403)
            self.end_headers()
            self._log_res(403, safe_path, (time.monotonic() - t0) * 1000, f"Origen no permitido: '{origin}'")
            return

        # Servir archivos estáticos del repositorio si estamos en entorno de desarrollo
        if path_clean and self.serve_static_file(path_clean):
            self._log_res(200, safe_path, (time.monotonic() - t0) * 1000)
            return

        # Browsers request this optional public resource without API credentials.
        if path_clean == "/favicon.ico":
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        self._reject(404, {"error": "Not found"}, safe_path, t0, "Ruta GET inexistente")

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
        is_blob_upload = (
            self.headers.get("X-ZeroChat-Blob") == "1"
            or safe_path in ("/zerochat/blobs", "/zerochat/blobs/put")
        )
        body_limit = MAX_BLOB_HTTP_BYTES if is_blob_upload else http_body_limit()
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
        # El tope ampliado de http_body_limit es solo para la exportación de --prompt --export y la subida de blobs.
        if content_len > MAX_HTTP_BODY_BYTES and not (
            isinstance(req, dict) and req.get("method") in ("zerochat/run/export", "zerochat/blobs/put")
        ):
            self._log_req("POST", safe_path)
            self._reject(413, {"error": "Request body too large"}, safe_path, t0, "Cuerpo HTTP excede el límite")
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
            }
        }

    @staticmethod
    def _tool_exception_result(ex: Exception) -> dict:
        return {"content": [{"type": "text", "text": _tool_error(str(ex))}], "isError": True}

    @classmethod
    def _execute_tool(cls, origin: str, tool_name: str, args: dict, ctx: SecurityContext,
                      conversation_id: str = "") -> tuple[dict | None, dict | None, str]:
        """
        Punto único de ejecución de herramientas locales y externas. Un navegador se reserva aquí, al
        ejecutar, para la conversación que lo usa: pedirlo sin llegar a ejecutar no lo ocupa.
        """
        if origin == "local":
            browser = tool_name if tool_name == "browser_action" else None
        else:
            browser = PLAYWRIGHT_SERVER_ID if GLOBAL_MCP_MANAGER.server_of(tool_name) == PLAYWRIGHT_SERVER_ID else None
        if browser and not BROWSER_LEASES.acquire(browser, conversation_id):
            message = (f"The browser is in use by another conversation. It is released after {int(BROWSER_LEASE_IDLE_SECONDS)} "
                       "seconds without use; tell the user or try again later.")
            return {"content": [{"type": "text", "text": _tool_error(message)}], "isError": True}, None, message
        try:
            return cls._run_tool(origin, tool_name, args, ctx)
        finally:
            # El plazo cuenta desde que la acción termina: lo que tarde no acorta lo que el modelo puede razonar después.
            if browser:
                BROWSER_LEASES.acquire(browser, conversation_id)

    @classmethod
    def _run_tool(cls, origin: str, tool_name: str, args: dict, ctx: SecurityContext) -> tuple[dict | None, dict | None, str]:
        """Ejecuta la herramienta y normaliza su resultado: (result, error JSON-RPC, detalle de error)."""
        if origin == "external":
            try:
                result = GLOBAL_MCP_MANAGER.call(tool_name, args)
            except Exception as ex:
                return cls._tool_exception_result(ex), None, str(ex)
            tool_error_info = ""
            if isinstance(result, dict) and result.get("isError"):
                c_list = result.get("content", [])
                if c_list and isinstance(c_list, list) and isinstance(c_list[0], dict):
                    tool_error_info = c_list[0].get("text", "Error en herramienta MCP externa")
                else:
                    tool_error_info = "Error en herramienta MCP externa"
            return result, None, tool_error_info

        handler = LOCAL_TOOL_HANDLERS.get(tool_name)
        if not handler:
            return None, {"code": -32601, "message": f"Herramienta local '{tool_name}' no encontrada."}, ""
        try:
            # Solo las herramientas que actúan en el proyecto declaran ctx.
            takes_project = "ctx" in inspect.signature(handler).parameters
            tool_output_json = handler(**dict(args), **({"ctx": ctx} if takes_project else {}))
        except Exception as ex:
            return cls._tool_exception_result(ex), None, str(ex)
        tool_error_info = ""
        try:
            parsed_out = json.loads(tool_output_json)
            if isinstance(parsed_out, dict) and parsed_out.get("success") is False:
                tool_error_info = str(parsed_out.get("error", "Error en herramienta local"))
        except (json.JSONDecodeError, TypeError, ValueError):
            pass
        return {"content": [{"type": "text", "text": tool_output_json}], "isError": bool(tool_error_info)}, None, tool_error_info

    @staticmethod
    def _with_job_key(args: dict, job_key: str | None) -> dict:
        return {**args, "job_key": job_key} if job_key else args

    @staticmethod
    def _authorize_or_challenge(origin: str, tool_name: str, args: dict, ctx: SecurityContext,
                                job_key: str | None = None, conversation_id: str = "") -> tuple[dict | None, dict | None, str] | None:
        """Evalúa la política de seguridad y devuelve respuesta de denegación o reto si procede."""
        if origin == "external":
            server_id = GLOBAL_MCP_MANAGER.server_of(tool_name) or ""
            server_name = server_id or "external"
        else:
            server_id = ""
            server_name = "mcp-proxy"
        decision = ACCESS_CONTROLLER.evaluate_authorization(
            tool_name, args, context=ctx, server_name=server_name, server_id=server_id
        )
        if decision.status == POLICY_DENY:
            err_msg = f"Bloqueado por política de seguridad: {decision.reason}"
            return {"content": [{"type": "text", "text": f"Error: {err_msg}"}], "isError": True, "securityStatus": "deny", "reason": decision.reason}, None, err_msg
        if decision.status == POLICY_ASK:
            ch = ACCESS_CONTROLLER.create_challenge(
                tool_name, args, decision, server_name=server_name, server_id=server_id, origin=origin,
                context=ctx, job_key=job_key, conversation_id=conversation_id
            )
            return {
                "requiresAuthorization": True,
                "challengeId": ch["id"],
                "toolName": tool_name,
                "serverName": server_name,
                "serverId": server_id,
                "arguments": args,
                "ruleOffer": decision.rule_offer,
                "details": decision.details,
                "content": [{"type": "text", "text": "Esta herramienta requiere autorización del usuario."}],
                "isError": False
            }, None, ""
        return None

    @classmethod
    def _call_tool(cls, origin: str, params: dict, ctx: SecurityContext) -> tuple[dict | None, dict | None, str]:
        """tools/call de los dos endpoints: evalúa, emite un reto o ejecuta por el punto único."""
        tool_name = params.get("name", "")
        if origin == "local" and tool_name not in LOCAL_TOOL_HANDLERS:
            return None, {"code": -32601, "message": f"Herramienta local '{tool_name}' no encontrada."}, ""
        raw_args = params.get("arguments")
        args = dict(raw_args) if isinstance(raw_args, dict) else {}
        meta = params.get("_meta") if isinstance(params.get("_meta"), dict) else {}
        # Ni la clave del trabajo ni la conversación son argumentos del modelo: no se evalúan ni se muestran en el reto.
        job_key = meta.get("zerochatJobKey") if origin == "local" and tool_name == COMMAND_TOOL else None
        conversation_id = str(meta.get("zerochatConversationId") or "")
        gate = cls._authorize_or_challenge(origin, tool_name, args, ctx, job_key, conversation_id)
        return gate if gate is not None else cls._execute_tool(origin, tool_name, cls._with_job_key(args, job_key), ctx, conversation_id)

    def _dispatch_external(self, method: str, params: dict, ctx: SecurityContext) -> tuple[dict | None, dict | None, str]:
        """Atiende /mcp/external. Devuelve (result, error JSON-RPC, detalle de error de herramienta)."""
        if method == "initialize":
            return self._initialize_result({"name": "ZeroChat External MCP Host", "version": VERSION}), None, ""
        if method == "tools/list":
            return {"tools": GLOBAL_MCP_MANAGER.tools()}, None, ""
        if method == "tools/call":
            return self._call_tool("external", params, ctx)
        return None, {"code": -32601, "message": f"Método '{method}' no soportado en /mcp/external."}, ""

    def _dispatch_local(self, method: str, params: dict, ctx: SecurityContext) -> tuple[dict | None, dict | None, str]:
        """Atiende el endpoint local. Devuelve (result, error JSON-RPC, detalle de error de herramienta)."""
        if method == "initialize":
            server_info = {
                "name": "ZeroChat Local Server",
                "version": VERSION,
                "cwd": str(ctx.workspace_dir),
                "os": DETECTED_OS
            }
            return {**self._initialize_result(server_info), "liveState": live_state(ctx)}, None, ""
        if method == "zerochat/heartbeat":
            focus_id = params.get("focus_conversation_id") if isinstance(params, dict) else None
            return live_state(ctx, focus_id), None, ""
        if method == "zerochat/login":
            return self._login(params)
        if method == "tools/list":
            return {"tools": [dict(definition) for definition in LOCAL_TOOLS_DEFINITIONS]}, None, ""
        if method == "tools/call":
            return self._call_tool("local", params, ctx)
        if method == "zerochat/project/set_directory":
            # Lo invoca la interfaz a petición del usuario: no es una herramienta del modelo.
            try:
                return resolve_project_directory(params.get("path"), ctx), None, ""
            except (ValueError, OSError) as exc:
                return None, {"code": -32602, "message": str(exc)}, ""
        if method == "zerochat/diff/open":
            try:
                return open_file_diff(params.get("path"), ctx, bool(params.get("commit_fallback")), bool(params.get("gui"))), None, ""
            except (ValueError, RuntimeError) as exc:
                return None, {"code": -32602, "message": str(exc)}, ""
            except Exception as exc:
                return None, {"code": -32603, "message": f"Error al abrir el visor de diffs: {exc}"}, str(exc)
        if method == "zerochat/diff/configure":
            try:
                return configure_gui_diff_tool(params.get("tool")), None, ""
            except (ValueError, RuntimeError) as exc:
                return None, {"code": -32602, "message": str(exc)}, ""
            except Exception as exc:
                return None, {"code": -32603, "message": f"Error configurando el visor de diffs: {exc}"}, str(exc)
        if method == "zerochat/web/fetch":
            try:
                return fetch_web_resource(params), None, ""
            except (ValueError, PermissionError) as exc:
                return None, {"code": -32602, "message": str(exc)}, ""
            except Exception as exc:
                return None, {"code": -32603, "message": f"Error en transporte web: {exc}"}, str(exc)
        if method.startswith("zerochat/jobs/"):
            return self._dispatch_jobs(method, params, ctx)
        if method.startswith("zerochat/run/"):
            return dispatch_run(method, params, ctx)
        if method in ("zerochat/external/servers/start", "zerochat/external/servers/stop", "zerochat/external/servers/configure"):
            return self._dispatch_server_control(method, params)
        if method.startswith("zerochat/browser/"):
            return self._dispatch_browser(method, params)
        if method.startswith("zerochat/profiles/"):
            return self._dispatch_profiles(method, params)
        if method.startswith("zerochat/conversations/"):
            return self._dispatch_conversations(method, params)
        if method.startswith("zerochat/blobs/"):
            return self._dispatch_blobs(method, params)
        if method.startswith("zerochat/security/"):
            return self._dispatch_security(method, params, ctx)
        return None, {"code": -32601, "message": f"Método '{method}' no soportado."}, ""

    @classmethod
    def _dispatch_security(cls, method: str, params: dict, ctx: SecurityContext) -> tuple[dict | None, dict | None, str]:
        """Gestión de políticas y reglas de seguridad almacenadas en el backend local."""
        params = params if isinstance(params, dict) else {}
        try:
            if method == "zerochat/security/get":
                return {"policies": ACCESS_CONTROLLER.export_state(ctx)}, None, ""
            if method == "zerochat/security/update":
                updated = ACCESS_CONTROLLER.import_state(params, context=ctx)
                return {"policies": updated}, None, ""
            if method == "zerochat/security/authorize":
                challenge_id = params.get("challengeId")
                if not challenge_id or not isinstance(challenge_id, str):
                    return None, {"code": -32602, "message": "challengeId es obligatorio"}, ""
                decision = params.get("decision", "deny")
                if not isinstance(decision, str):
                    return None, {"code": -32602, "message": "decision debe ser un texto"}, ""
                if decision == "deny":
                    ACCESS_CONTROLLER.revoke_challenge(challenge_id, context=ctx)
                    return {"authorized": False, "status": "deny"}, None, ""

                ch = ACCESS_CONTROLLER.authorize_challenge(
                    challenge_id, decision, context=ctx,
                    command_pattern=params.get("commandPattern"), directory_rule=params.get("directoryRule")
                )
                if not ch:
                    return None, {"code": -32002, "message": "Reto no encontrado o no válido"}, ""
                t_origin = ch.get("origin") or "local"
                t_name = ch["toolName"]
                t_args = ch["arguments"] if isinstance(ch.get("arguments"), dict) else {}
                exec_res, exec_err, tool_err = cls._execute_tool(t_origin, t_name, cls._with_job_key(t_args, ch.get("jobKey")), ctx, ch.get("conversationId") or "")
                if exec_err:
                    return None, exec_err, tool_err
                return {"authorized": True, "result": exec_res}, None, tool_err
        except ValueError as exc:
            return None, {"code": -32602, "message": str(exc)}, ""
        except Exception as exc:
            return None, {"code": -32603, "message": f"Error de seguridad: {exc}"}, str(exc)
        return None, {"code": -32601, "message": f"Método '{method}' no soportado."}, ""

    @staticmethod
    def _dispatch_profiles(method: str, params: dict) -> tuple[dict | None, dict | None, str]:
        """Gestión de perfiles generales almacenados en SQLite en el backend local."""
        params = params if isinstance(params, dict) else {}
        try:
            if method == "zerochat/profiles/list":
                return {"profiles": list_general_profiles()}, None, ""
            if method == "zerochat/profiles/save":
                profile_data = params.get("profile")
                if not isinstance(profile_data, dict):
                    return None, {"code": -32602, "message": "profile debe ser un objeto."}, ""
                return {"profile": save_general_profile(profile_data)}, None, ""
            if method == "zerochat/profiles/delete":
                profile_id = params.get("id")
                if not isinstance(profile_id, str) or not profile_id.strip():
                    return None, {"code": -32602, "message": "id debe ser un texto no vacío."}, ""
                return {"deleted": delete_general_profile(profile_id)}, None, ""
        except ValueError as exc:
            return None, {"code": -32602, "message": str(exc)}, ""
        except Exception as exc:
            return None, {"code": -32603, "message": f"Error en gestión de perfiles: {exc}"}, str(exc)
        return None, {"code": -32601, "message": f"Método '{method}' no soportado."}, ""

    @staticmethod
    def _dispatch_conversations(method: str, params: dict) -> tuple[dict | None, dict | None, str]:
        """Gestión de conversaciones y mensajes almacenados en SQLite en el backend local."""
        try:
            if method == "zerochat/conversations/list":
                return {"conversations": list_conversations()}, None, ""
            if method == "zerochat/conversations/get":
                return {"conversation": get_conversation(params.get("id"))}, None, ""
            if method == "zerochat/conversations/save":
                return {"conversation": save_conversation(params.get("conversation"), params.get("messages"))}, None, ""
            if method == "zerochat/conversations/rename":
                return {"renamed": rename_conversation(params.get("id"), params.get("title"))}, None, ""
            if method == "zerochat/conversations/delete":
                if params.get("all") is True:
                    for run_file in get_runs_dir().glob("*.json"):
                        try:
                            cancel_server_run(urllib.parse.unquote(run_file.stem))
                        except (ValueError, OSError):
                            pass
                    return {"deleted": True, "count": delete_all_conversations()}, None, ""
                if "project" in params:
                    deleted_ids = delete_project_conversations(params.get("project"))
                    for deleted_id in deleted_ids:
                        try:
                            cancel_server_run(deleted_id)
                        except (ValueError, OSError):
                            pass
                    return {"deleted": True, "count": len(deleted_ids)}, None, ""
                conv_id = params.get("id")
                if isinstance(conv_id, str) and conv_id.strip():
                    try:
                        cancel_server_run(conv_id)
                    except (ValueError, OSError):
                        pass
                return {"deleted": delete_conversation(params.get("id"))}, None, ""
        except ValueError as exc:
            return None, {"code": -32602, "message": str(exc)}, ""
        except Exception as exc:
            return None, {"code": -32603, "message": f"Error en gestión de conversaciones: {exc}"}, str(exc)
        return None, {"code": -32601, "message": f"Método '{method}' no soportado."}, ""

    @staticmethod
    def _dispatch_blobs(method: str, params: dict) -> tuple[dict | None, dict | None, str]:
        """Gestión de blobs desacoplados de mensajes (imágenes y adjuntos) en SQLite."""
        params = params if isinstance(params, dict) else {}
        try:
            if method == "zerochat/blobs/has":
                ids = params.get("ids")
                if ids is None:
                    ids = []
                return has_blobs(ids), None, ""
            if method == "zerochat/blobs/put":
                raw_data = params.get("data")
                if not raw_data or not isinstance(raw_data, str):
                    raise ValueError("El parámetro 'data' debe ser una cadena en base64 no vacía")
                mime_type = params.get("mimeType") or "application/octet-stream"
                if raw_data.startswith("data:") and ";base64," in raw_data:
                    header, b64_part = raw_data.split(";base64,", 1)
                    if not params.get("mimeType"):
                        mime_type = header[5:]
                    raw_data = b64_part
                try:
                    data_bytes = base64.b64decode(raw_data)
                except Exception as decode_err:
                    raise ValueError(f"Error decodificando base64: {decode_err}")
                saved = put_blob(data_bytes, mime_type=mime_type, blob_id=params.get("id"))
                return {"id": saved["id"], "mimeType": saved["mime_type"], "size": saved["size"]}, None, ""
            if method == "zerochat/blobs/get":
                blob = get_blob(params.get("id"))
                if not blob:
                    return {"blob": None}, None, ""
                return {
                    "blob": {
                        "id": blob["id"],
                        "mimeType": blob["mime_type"],
                        "size": blob["size"],
                        "data": base64.b64encode(blob["data"]).decode("ascii"),
                        "createdAt": blob["created_at"],
                    }
                }, None, ""
        except ValueError as exc:
            return None, {"code": -32602, "message": str(exc)}, ""
        except Exception as exc:
            return None, {"code": -32603, "message": f"Error en gestión de blobs: {exc}"}, str(exc)
        return None, {"code": -32601, "message": f"Método '{method}' no soportado."}, ""

    @staticmethod
    def _login(params: dict) -> tuple[dict | None, dict | None, str]:
        try:
            return login(params), None, ""
        except LoginError as exc:
            error = {"code": exc.code, "message": str(exc)}
            if exc.data:
                error["data"] = exc.data
            return None, error, ""
        except (RuntimeError, OSError) as exc:
            return None, {"code": -32603, "message": f"No se pudo comprobar la contraseña: {exc}"}, str(exc)

    def _serve_login(self, safe_path: str, t0: float) -> bool:
        """Sin token solo se atiende zerochat/login, con un cuerpo pequeño; devuelve False si la petición es otra."""
        try:
            content_len = int(self.headers.get("Content-Length"))
        except (TypeError, ValueError):
            return False
        if not 0 <= content_len <= LOGIN_MAX_BODY_BYTES:
            return False
        try:
            req = json.loads(self.rfile.read(content_len).decode("utf-8"))
        except ValueError:
            return False
        if self._validate_rpc(req) or req["method"] != "zerochat/login":
            return False
        log_detail = f"{safe_path} [rpc: zerochat/login]"
        self._log_req("POST", log_detail)
        self._send_rpc_response(req.get("id"), self._login(req.get("params", {})), log_detail, t0)
        return True

    def _send_rpc_response(self, req_id, outcome: tuple[dict | None, dict | None, str], log_detail: str, t0: float, quiet: bool = False):
        result, error, tool_error_info = outcome
        response_payload = {"jsonrpc": "2.0", "id": req_id}
        if error:
            response_payload["error"] = error
            error_info = f"[{error.get('code')}] {error.get('message')}"
        else:
            response_payload["result"] = result
            error_info = tool_error_info
        if self._send_json_response(200, response_payload) and not quiet:
            self._log_res(200, log_detail, (time.monotonic() - t0) * 1000, error_info=error_info)

    @staticmethod
    def _dispatch_jobs(method: str, params: dict, ctx: SecurityContext) -> tuple[dict | None, dict | None, str]:
        """Control de los comandos del proyecto de la petición desde la interfaz: tarjetas, log y botón de detener."""
        project = ctx.key
        if method == "zerochat/jobs/list":
            return {"jobs": [job.summary() for job in JOBS.list(project)]}, None, ""
        if method == "zerochat/jobs/report":
            ids = params.get("ids")
            if not isinstance(ids, list) or len(ids) > 100 or any(isinstance(i, bool) or not isinstance(i, int) for i in ids):
                return None, {"code": -32602, "message": "ids debe ser una lista de hasta 100 enteros."}, ""
            return {"reports": JOBS.report_finished(ids, project)}, None, ""
        job = JOBS.get(project, job_id=params.get("id"), key=params.get("key"))
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
    def _dispatch_browser(method: str, params: dict) -> tuple[dict | None, dict | None, str]:
        """Configuración, datos y motores propios de Playwright para la sección Navegador de Ajustes."""
        try:
            if method == "zerochat/browser/config/get":
                return load_browser_config(), None, ""
            if method == "zerochat/browser/config/set":
                return save_browser_config(params.get("config")), None, ""
            if method == "zerochat/browser/data/clear":
                return clear_own_browser_data(params.get("engine")), None, ""
            if method == "zerochat/browser/engines/list":
                return BROWSER_ENGINES.list(), None, ""
            if method == "zerochat/browser/engines/install":
                return BROWSER_ENGINES.install(params.get("engine")), None, ""
            if method == "zerochat/browser/engines/remove":
                return BROWSER_ENGINES.remove(params.get("engine")), None, ""
        except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as exc:
            return None, {"code": -32602, "message": str(exc)}, ""
        return None, {"code": -32601, "message": f"Método '{method}' no soportado."}, ""

    @staticmethod
    def _dispatch_server_control(method: str, params: dict) -> tuple[dict | None, dict | None, str]:
        server_id = params.get("serverId")
        opts = params.get("options", {})
        remember = params.get("remember")
        browser = params.get("browser")
        if not isinstance(server_id, str) or not server_id:
            return None, {"code": -32602, "message": "serverId debe ser un texto no vacío."}, ""
        if not isinstance(opts, dict):
            return None, {"code": -32602, "message": "options debe ser un objeto."}, ""
        # Al arrancar, el cliente decide siempre si el servicio se recuerda para la siguiente sesión.
        if method.endswith("/start") and not isinstance(remember, bool):
            return None, {"code": -32602, "message": "remember es obligatorio al arrancar y debe ser un booleano."}, ""
        if method.endswith("/start") and browser is not None:
            if server_id not in SERVICE_LAUNCH:
                return None, {"code": -32602, "message": f"{server_id} no admite elegir navegador."}, ""
            try:
                browser = validate_profile_browser(browser)
            except ValueError as exc:
                return None, {"code": -32602, "message": str(exc)}, ""
        try:
            if method.endswith("/start"):
                servers = GLOBAL_MCP_MANAGER.start(server_id, remember, browser)
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

        capture_frontend_user_agent(self.headers.get("User-Agent", ""))
        mark_browser_active()
        if not self.verify_token():
            # Sin token válido solo cabe identificarse para obtenerlo.
            if self._serve_login(safe_path, t0):
                return
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
            ctx = request_project_context(self.headers.get("X-ZeroChat-Project"), fallback=method == "initialize")
        except ProjectGoneError as ex:
            self._send_rpc_response(req_id, (None, {"code": PROJECT_GONE_CODE, "message": str(ex)}, ""), log_detail, t0, quiet)
            return
        try:
            if "/mcp/external" in req_path:
                outcome = self._dispatch_external(method, params, ctx)
            else:
                outcome = self._dispatch_local(method, params, ctx)
        except Exception as ex:
            outcome = None, {"code": -32603, "message": f"Error interno: {ex}"}, ""
        self._send_rpc_response(req_id, outcome, log_detail, t0, quiet)

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
            [
                executable,
                "--headless",
                "--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests",
                url,
            ],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except OSError as error:
        log_event(f"No se pudo abrir {executable} sin ventana ({error}); se abrirá de la forma normal.")
        return None


_PLAYWRIGHT_CHROMIUM_BINARIES = (
    ("chromium_headless_shell-", (
        "chrome-headless-shell-*/chrome-headless-shell",
        "chrome-headless-shell-*/chrome-headless-shell.exe",
    )),
    ("chromium-", (
        "chrome-*/chrome",
        "chrome-*/chrome.exe",
        "chrome-*/*.app/Contents/MacOS/*",
    )),
)


def playwright_chromium_executable() -> str | None:
    """Ejecutable de Chromium en la caché de Playwright (headless shell o completo), o None."""
    try:
        folders = sorted(
            (child for child in playwright_engine_cache().iterdir() if (child / "INSTALLATION_COMPLETE").is_file()),
            key=lambda path: path.name,
            reverse=True,
        )
    except OSError:
        return None
    for prefix, patterns in _PLAYWRIGHT_CHROMIUM_BINARIES:
        for folder in folders:
            if not folder.name.startswith(prefix):
                continue
            for pattern in patterns:
                for binary in sorted(folder.glob(pattern)):
                    if binary.is_file():
                        return str(binary)
    return None


def launch_playwright_chromium(url: str) -> subprocess.Popen | None:
    """Abre la URL sin ventana con el Chromium instalado en la caché de Playwright."""
    executable = playwright_chromium_executable()
    if not executable:
        log_event("No está instalado el Chromium de Playwright (instálalo desde Ajustes › Navegador o usa --browser).")
        return None
    log_event(f"Abriendo {Path(executable).name} de Playwright sin ventana en la interfaz configurada...")
    try:
        return subprocess.Popen(
            [
                executable,
                "--headless",
                "--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests",
                url,
            ],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except OSError as error:
        log_event(f"No se pudo abrir {executable} de Playwright ({error}).")
        return None

# ==============================================================================
# Modo ejecución desatendida (zerochat.py --prompt)
# ==============================================================================
# El servidor arranca y abre el navegador como siempre, con run=<id> en el fragmento: la interfaz
# pide el prompt, informa del progreso y devuelve el resultado por JSON-RPC zerochat/run/*.

# Plazo total y sin progreso de la interfaz.
RUN_TOTAL_TIMEOUT = 900.0
RUN_IDLE_SECONDS = 180.0
RUN_POLL_SECONDS = 0.2
RUN_PROGRESS_TEXT_MAX = 500
RUN_STREAM_TEXT_MAX = 8000
RUN_PROGRESS_KIND_PATTERN = re.compile(r"[a-z_]{1,32}")
RUN_EXIT_DONE = 0
RUN_EXIT_ERROR = 1
RUN_EXIT_TIMEOUT = 2
RUN_EXIT_SETUP = 3
# Argumentos no válidos, en cualquier modo: argparse usaría 2, que con --prompt es plazo agotado.
RUN_EXIT_ARGS = 4
# Perfil por defecto de --prompt cuando no se indica --profile.
DEFAULT_RUN_PROFILE = "local"
# Formato de --export según la extensión del fichero; la interfaz genera el contenido con ChatExport.
RUN_EXPORT_FORMATS = {".md": "markdown", ".json": "json", ".html": "html"}
# Cuerpo HTTP admitido mientras se espera la exportación: el JSON y el HTML llevan las imágenes incrustadas.
RUN_EXPORT_MAX_BODY_BYTES = 64 * 1024 * 1024
# Tope de descarga para runner.js (evita agotar memoria o disco con respuestas desbordadas).
RUNNER_MAX_BYTES = 4 * 1024 * 1024


def get_runs_dir() -> Path:
    """Directorio persistente con permisos 0700 para los ficheros de situación de ejecuciones en servidor."""
    runs_dir = get_data_dir() / "runs"
    runs_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    if os.name != "nt":
        runs_dir.chmod(0o700)
    return runs_dir


def get_run_state_path(conversation_id: str) -> Path:
    """Ruta al fichero de situación de la conversación en ~/zerochat/runs/."""
    clean_name = urllib.parse.quote(conversation_id.strip(), safe="")
    return get_runs_dir() / f"{clean_name}.json"


def _run_process_alive(data: dict) -> bool:
    """Comprueba si el proceso de una ejecución sigue activo y corresponde al arranque original."""
    pid = data.get("pid")
    if not _pid_alive(pid):
        return False
    saved_start = data.get("pid_start")
    if saved_start:
        current_start = _process_start_token(pid)
        if current_start is not None and current_start != saved_start:
            return False
    return True


def write_run_state(session: RunSession) -> None:
    """Escribe atómicamente el estado en vivo de la ejecución en ~/zerochat/runs/<conversation_id>.json (0600)."""
    if not session.conversation_id:
        return
    state_path = get_run_state_path(session.conversation_id)
    now = int(time.time() * 1000)
    session.updated_at = now
    payload = {
        "run_id": session.run_id,
        "conversation_id": session.conversation_id,
        "pid": session.pid,
        "pid_start": session.pid_start,
        "started_at": session.started_at,
        "updated_at": session.updated_at,
        "status": session.status,
        "step_text": session.step_text,
        "assistant_text": session.assistant_text,
        "reasoning_text": session.reasoning_text,
        "pending": session.pending,
        "error": session.error
    }
    _write_private_text(state_path, json.dumps(payload, ensure_ascii=False, indent=2))


def remove_run_state(conversation_id: str | None) -> None:
    """Elimina el fichero de situación de la conversación al completarse con éxito."""
    if not conversation_id:
        return
    try:
        get_run_state_path(conversation_id).unlink(missing_ok=True)
    except OSError:
        pass


def list_server_runs(focus_conversation_id: str | None = None) -> tuple[list[dict], dict | None]:
    """
    Lee las situaciones en ~/zerochat/runs/*.json. Si un proceso 'running' ya murió,
    lo marca como 'error'. Devuelve (runs, focus_run), donde runs es una lista ligera
    ordenada por started_at, y focus_run es el detalle completo si coincide con focus_conversation_id.
    En un servidor de ejecución (--prompt o --conversation) devuelve ([], None) para que el propio
    worker no se bloquee ni omita el guardado de su conversación.
    """
    if RUN_SESSION is not None:
        return [], None
    runs_dir = get_runs_dir()
    entries = []
    clean_focus_id = focus_conversation_id.strip() if (isinstance(focus_conversation_id, str) and focus_conversation_id.strip()) else None

    for path in sorted(runs_dir.glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        if not isinstance(data, dict):
            continue
        conv_id = data.get("conversation_id")
        if not conv_id or not isinstance(conv_id, str):
            continue

        status = data.get("status")
        if status == "running" and not _run_process_alive(data):
            status = "error"
            data["status"] = "error"
            data["error"] = "El proceso de ejecución terminó inesperadamente."
            data["updated_at"] = int(time.time() * 1000)
            try:
                _write_private_text(path, json.dumps(data, ensure_ascii=False, indent=2))
            except OSError:
                pass

        light = {
            "conversation_id": conv_id,
            "run_id": data.get("run_id"),
            "status": status
        }
        started_at = data.get("started_at", 0)
        entries.append((started_at, light, data))

    entries.sort(key=lambda item: item[0])
    runs = [item[1] for item in entries]

    focus_run = None
    if clean_focus_id:
        for _, _, full_data in entries:
            if full_data.get("conversation_id") == clean_focus_id:
                focus_run = full_data
                break

    return runs, focus_run


def start_server_run(params: dict, ctx: SecurityContext) -> dict:
    """Inicia una ejecución en segundo plano para una conversación, en su proyecto o, si no tiene, en el de la petición."""
    if not isinstance(params, dict):
        raise ValueError("Parámetros no válidos.")
    conv_id = params.get("conversation_id")
    if not isinstance(conv_id, str) or not conv_id.strip():
        raise ValueError("conversation_id requerido.")
    clean_conv_id = _validate_conversation_id(conv_id)
    conv = get_conversation(clean_conv_id)
    if conv is None:
        raise ValueError(f"Conversación '{clean_conv_id}' no encontrada.")

    profile = params.get("profile")
    if not isinstance(profile, str) or not profile.strip():
        conv_profile = conv.get("profileId")
        if isinstance(conv_profile, str) and conv_profile.strip():
            profile = conv_profile.strip()
        else:
            raise ValueError("profile requerido.")
    profile_entry = get_general_profile(profile) or get_general_profile_by_name(profile)
    if not profile_entry:
        raise ValueError(f"Perfil del servidor '{profile}' no encontrado.")
    profile_name = profile_entry.get("name", profile.strip())

    state_path = get_run_state_path(clean_conv_id)
    if state_path.exists():
        try:
            existing = json.loads(state_path.read_text(encoding="utf-8"))
            if isinstance(existing, dict) and existing.get("status") == "running" and _run_process_alive(existing):
                raise ValueError(f"Ya hay una ejecución en marcha para la conversación '{clean_conv_id}'.")
        except (json.JSONDecodeError, OSError):
            pass

    prompt = params.get("prompt")
    if prompt is not None and not isinstance(prompt, str):
        raise ValueError("prompt debe ser una cadena o null.")

    tool_security = params.get("tool_security")
    if tool_security is not None and not isinstance(tool_security, dict):
        raise ValueError("tool_security debe ser un objeto o null.")

    if not find_node_executable():
        raise ValueError(f"Se necesita {NODE_REQUIRED_MESSAGE} para ejecutar tareas en segundo plano en el servidor.")

    project = conv.get("project")
    if project and not Path(project).is_dir():
        raise ValueError(f"La carpeta del proyecto de la conversación ya no existe: {project}")

    run_id = secrets.token_urlsafe(24)
    cmd = [sys.executable, str(Path(__file__).resolve()), "--conversation", clean_conv_id, "--profile", profile_name]
    if prompt:
        cmd.extend(["--prompt", prompt])

    env = dict(os.environ)
    env["ZEROCHAT_RUN_ID"] = run_id
    if tool_security:
        env["ZEROCHAT_RUN_SECURITY"] = json.dumps(tool_security, ensure_ascii=False)

    now = int(time.time() * 1000)
    mark_conversation_server_run(clean_conv_id, profile_name)

    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=DETECTED_OS != "windows" and hasattr(os, "setsid"),
        env=env,
        cwd=project or str(ctx.workspace_dir)
    )

    payload = {
        "run_id": run_id,
        "conversation_id": clean_conv_id,
        "pid": proc.pid,
        "pid_start": _process_start_token(proc.pid),
        "started_at": now,
        "updated_at": now,
        "status": "running",
        "step_text": "",
        "assistant_text": "",
        "reasoning_text": "",
        "pending": None,
        "error": None
    }
    _write_private_text(state_path, json.dumps(payload, ensure_ascii=False, indent=2))

    return {"ok": True, "run_id": run_id, "conversation_id": clean_conv_id, "status": "running"}


def cancel_server_run(conversation_id: str) -> dict:
    """Cancela una ejecución en segundo plano: termina el proceso si sigue en marcha y elimina el fichero."""
    if not isinstance(conversation_id, str) or not conversation_id.strip():
        raise ValueError("conversation_id requerido.")
    clean_conv_id = _validate_conversation_id(conversation_id)
    state_path = get_run_state_path(clean_conv_id)
    if state_path.exists():
        try:
            data = json.loads(state_path.read_text(encoding="utf-8"))
            if isinstance(data, dict) and data.get("status") == "running" and _run_process_alive(data):
                _kill_process_tree(data.get("pid"), grace_seconds=0.05)
        except (json.JSONDecodeError, OSError):
            pass
        remove_run_state(clean_conv_id)
    return {"cancelled": True}


class RunSession:
    """Estado de la ejecución: prompt, opciones, último progreso, exportación, resultado y motivo de un final sin él."""
    def __init__(self, prompt: str | None = None, profile: str | None = None, export_path: Path | None = None, keep_page: bool = False,
                 allow_dangerous_tools: bool = False, conversation_id: str | None = None, run_id: str | None = None,
                 tool_security: dict | None = None, profile_data: dict | None = None):
        env_run_id = os.environ.get("ZEROCHAT_RUN_ID", "").strip()
        self.run_id = run_id.strip() if (run_id and isinstance(run_id, str) and run_id.strip()) else (env_run_id or secrets.token_urlsafe(24))
        self.conversation_id = conversation_id
        self.prompt = prompt
        # Perfil (nombre o id) que la interfaz usa solo en esta ejecución; por defecto, local del servidor.
        self.profile = profile
        self.profile_data = profile_data
        # Fichero donde se escribe la conversación exportada (formato por su extensión); None, sin exportar.
        self.export_path = export_path
        self.exported = False
        self.export_error: str | None = None
        # La interfaz no cierra la página al terminar, para ver la conversación (sin --headless).
        self.keep_page = keep_page
        # La interfaz aprueba también write_file, edit_file y run_command, que si no deniega.
        self.allow_dangerous_tools = allow_dangerous_tools
        if tool_security is not None:
            self.tool_security = tool_security
        elif os.environ.get("ZEROCHAT_RUN_SECURITY"):
            try:
                self.tool_security = json.loads(os.environ["ZEROCHAT_RUN_SECURITY"])
            except (json.JSONDecodeError, TypeError):
                self.tool_security = None
        else:
            self.tool_security = None
        self.lock = threading.Lock()
        self.last_activity = time.monotonic()
        self.prompt_delivered = False
        self.result: dict | None = None
        self.stop_reason: str | None = None
        self.finished = threading.Event()
        self.pid = os.getpid()
        self.pid_start = _process_start_token(self.pid)
        self.started_at = int(time.time() * 1000)
        self.updated_at = self.started_at
        self.status = "running"
        self.step_text = ""
        self.assistant_text = ""
        self.reasoning_text = ""
        self.pending: dict | None = None
        self.error: str | None = None
        if self.conversation_id:
            write_run_state(self)

    def touch(self):
        with self.lock:
            self.last_activity = time.monotonic()

    def idle_seconds(self) -> float:
        with self.lock:
            return time.monotonic() - self.last_activity


RUN_SESSION: RunSession | None = None


def http_body_limit() -> int:
    """Tope del cuerpo que se lee: el general, o el de la exportación mientras se espera (ff-server
    rechaza después cualquier otro método que supere el general)."""
    session = RUN_SESSION
    if session is not None and session.export_path is not None and not session.exported:
        return RUN_EXPORT_MAX_BODY_BYTES
    return MAX_HTTP_BODY_BYTES


def dispatch_run(method: str, params: dict, ctx: SecurityContext) -> tuple[dict | None, dict | None, str]:
    """Métodos zerochat/run/* que usa la interfaz abierta por el modo ejecución."""
    params = params if isinstance(params, dict) else {}
    session = RUN_SESSION
    if method == "zerochat/run/start":
        if session is not None:
            return None, {"code": -32601, "message": "No disponible dentro de un proceso de ejecución."}, ""
        try:
            return start_server_run(params, ctx), None, ""
        except ValueError as exc:
            return None, {"code": -32602, "message": str(exc)}, ""
        except OSError as exc:
            return None, {"code": -32603, "message": f"Error al iniciar ejecución en servidor: {exc}"}, str(exc)
    if method == "zerochat/run/cancel":
        if session is not None:
            return None, {"code": -32601, "message": "No disponible dentro de un proceso de ejecución."}, ""
        try:
            conv_id = params.get("conversation_id")
            return cancel_server_run(conv_id), None, ""
        except ValueError as exc:
            return None, {"code": -32602, "message": str(exc)}, ""
        except OSError as exc:
            return None, {"code": -32603, "message": f"Error al cancelar ejecución en servidor: {exc}"}, str(exc)

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
        return {"prompt": session.prompt, "conversation_id": session.conversation_id, "profile": session.profile,
                "profile_data": session.profile_data,
                "export": export_format, "keep_page": session.keep_page,
                "allow_dangerous_tools": session.allow_dangerous_tools, "tool_security": session.tool_security}, None, ""
    if method == "zerochat/run/progress":
        kind = params.get("kind")
        text = params.get("text", "")
        if not isinstance(kind, str) or not RUN_PROGRESS_KIND_PATTERN.fullmatch(kind) or not isinstance(text, str):
            return None, {"code": -32602, "message": "Progreso no válido."}, ""
        assistant_text = params.get("assistant_text")
        reasoning_text = params.get("reasoning_text")
        if assistant_text is not None and not isinstance(assistant_text, str):
            return None, {"code": -32602, "message": "assistant_text debe ser una cadena."}, ""
        if reasoning_text is not None and not isinstance(reasoning_text, str):
            return None, {"code": -32602, "message": "reasoning_text debe ser una cadena."}, ""
        session.touch()
        truncated_step = text[:RUN_PROGRESS_TEXT_MAX] + "…" if len(text) > RUN_PROGRESS_TEXT_MAX else text
        log_event(f"[run] {kind}{': ' + truncated_step if truncated_step else ''}")
        with session.lock:
            session.step_text = truncated_step
            if assistant_text is not None:
                session.assistant_text = assistant_text[:RUN_STREAM_TEXT_MAX] + ("…" if len(assistant_text) > RUN_STREAM_TEXT_MAX else "")
            if reasoning_text is not None:
                session.reasoning_text = reasoning_text[:RUN_STREAM_TEXT_MAX] + ("…" if len(reasoning_text) > RUN_STREAM_TEXT_MAX else "")
            write_run_state(session)
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
        needs_input = params.get("needs_input")
        is_text = isinstance(text, str) and error is None and needs_input is None
        is_error = isinstance(error, str) and bool(error) and text is None and needs_input is None
        is_needs_input = isinstance(needs_input, dict) and text is None and error is None
        if not (is_text or is_error or is_needs_input):
            return None, {"code": -32602, "message": "El resultado lleva text o error."}, ""
        with session.lock:
            if session.result is not None:
                return None, {"code": -32602, "message": "El resultado ya se recibió."}, ""
            if is_text:
                session.result = {"text": text}
                session.status = "completed"
                remove_run_state(session.conversation_id)
            elif is_needs_input:
                session.result = {"needs_input": needs_input}
                session.status = "needs_input"
                session.pending = needs_input
                write_run_state(session)
            else:
                session.result = {"error": error}
                session.status = "error"
                session.error = error
                write_run_state(session)
        session.finished.set()
        return {"ok": True}, None, ""
    return None, {"code": -32601, "message": f"Método '{method}' no soportado."}, ""


def run_supervisor(server: ThreadingHTTPServer, session: RunSession, runner_proc: subprocess.Popen | None = None, browser_proc: subprocess.Popen | None = None):
    """Detiene el servidor al recibir el resultado, si termina el runner propio o al agotar los plazos."""
    proc = runner_proc if runner_proc is not None else browser_proc
    deadline = time.monotonic() + RUN_TOTAL_TIMEOUT
    while not session.finished.wait(RUN_POLL_SECONDS):
        # El latido o una señal ya detienen el servidor: el resultado queda vacío.
        if _SERVER_SHUTTING_DOWN.is_set():
            return
        if proc is not None and proc.poll() is not None and not session.finished.wait(0.2):
            break
        if time.monotonic() >= deadline:
            session.stop_reason = f"Plazo total agotado ({RUN_TOTAL_TIMEOUT:.0f}s)."
            break
        if session.idle_seconds() > RUN_IDLE_SECONDS:
            session.stop_reason = f"Sin progreso de la interfaz durante {RUN_IDLE_SECONDS:.0f}s."
            break
    if session.result is None and session.conversation_id:
        with session.lock:
            session.status = "error"
            session.error = session.stop_reason or ("El runner se cerró sin resultado." if proc else "La ejecución se interrumpió sin resultado.")
            write_run_state(session)
    stop_zerochat_server(server)


def run_error(message: str):
    """Motivo de un final sin respuesta: va a stderr aunque el registro esté desactivado (--log off)."""
    session = RUN_SESSION
    if session is not None and session.conversation_id and session.result is None:
        with session.lock:
            session.status = "error"
            session.error = message
            write_run_state(session)
    print(timestamp_message(f"[run] {message}"), file=sys.stderr, flush=True)


def run_outcome(session: RunSession) -> tuple[int, str | None]:
    """
    Código de salida y respuesta final (solo si terminó bien), con el motivo de un fallo en stderr;
    una exportación pedida que no se escribió convierte un final correcto en error sin quitar la respuesta.
    """
    if session.export_path and not session.exported:
        run_error(session.export_error or f"La interfaz no envió la conversación para {session.export_path}.")
    if session.result is None:
        run_error(session.stop_reason or session.error or "El runner se cerró o la ejecución se interrumpió sin resultado.")
        return RUN_EXIT_TIMEOUT, None
    if "error" in session.result:
        run_error(f"Error de generación: {session.result['error']}")
        return RUN_EXIT_ERROR, None
    if "needs_input" in session.result:
        log_event("[run] Ejecución pausada a la espera del usuario.")
        return RUN_EXIT_DONE, json.dumps(session.result["needs_input"], ensure_ascii=False)
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


# Versión mínima de Node.js para el runner: el modelo de permisos es estable desde la 22.13 (M65-D1).
NODE_MINIMUM_VERSION = (22, 13)
NODE_REQUIRED_MESSAGE = f"Node.js {'.'.join(map(str, NODE_MINIMUM_VERSION))} o superior"


def find_node_executable() -> str | None:
    """Localiza un ejecutable de Node.js en PATH y comprueba su versión mínima."""
    executable = shutil.which("node")
    if not executable:
        return None
    try:
        res = subprocess.run([executable, "--version"], capture_output=True, text=True, timeout=5)
        if res.returncode != 0:
            return None
        match = re.search(r"v?(\d+)\.(\d+)\.", res.stdout.strip())
        if not match or (int(match.group(1)), int(match.group(2))) < NODE_MINIMUM_VERSION:
            return None
        return executable
    except (OSError, subprocess.SubprocessError):
        return None


def _read_bounded_runner(resp) -> str:
    """Lee runner.js de la respuesta HTTP con tope RUNNER_MAX_BYTES y validación UTF-8."""
    raw_length = resp.headers.get("Content-Length")
    encoding = (resp.headers.get("Content-Encoding") or "").strip().lower()
    if raw_length and not encoding:
        try:
            if int(raw_length) > RUNNER_MAX_BYTES:
                raise RuntimeError(f"runner.js supera el tamaño máximo permitido ({RUNNER_MAX_BYTES} bytes).")
        except ValueError:
            pass
    content, truncated = _read_limited_body(resp, encoding, RUNNER_MAX_BYTES)
    if truncated:
        raise RuntimeError(f"runner.js supera el tamaño máximo permitido ({RUNNER_MAX_BYTES} bytes).")
    if not content:
        raise RuntimeError("runner.js descargado está vacío.")
    try:
        return content.decode("utf-8")
    except UnicodeDecodeError as err:
        raise RuntimeError(f"runner.js descargado no es UTF-8 válido: {err}") from err


def ensure_runner_script() -> Path:
    """
    Obtiene la ruta al runner de Node.js: en entorno de desarrollo local usa js/run-node.js o runner.js;
    en producción lo descarga o actualiza desde GitHub Pages con comprobación condicional ETag/304
    en ~/zerochat/cache/runner.js.
    """
    dev_root = get_dev_root()
    if dev_root is not None:
        local_run_node = dev_root / "js" / "run-node.js"
        if local_run_node.is_file():
            return local_run_node
        local_runner = dev_root / "runner.js"
        if local_runner.is_file():
            return local_runner

    cache_dir = get_data_dir() / "cache"
    cache_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    if os.name != "nt":
        try:
            cache_dir.chmod(0o700)
        except OSError:
            pass
    runner_path = cache_dir / "runner.js"
    etag_path = cache_dir / "runner.etag"

    runner_url = DEFAULT_UI_URL.rsplit("/", 1)[0] + "/runner.js"

    try:
        req = urllib.request.Request(runner_url, headers={"User-Agent": f"ZeroChat/{VERSION}"})
        if runner_path.is_file() and etag_path.is_file():
            try:
                current_etag = etag_path.read_text(encoding="utf-8").strip()
                if current_etag:
                    req.add_header("If-None-Match", current_etag)
            except OSError:
                pass

        with urllib.request.urlopen(req, timeout=5) as resp:
            runner_text = _read_bounded_runner(resp)
            etag = resp.headers.get("ETag")
            _write_private_text(runner_path, runner_text)
            if os.name != "nt":
                try:
                    runner_path.chmod(0o755)
                except OSError:
                    pass
            if etag:
                _write_private_text(etag_path, etag)
            else:
                etag_path.unlink(missing_ok=True)
    except urllib.error.HTTPError as err:
        if err.code == 304 and runner_path.is_file():
            pass
        elif runner_path.is_file():
            log_event(f"No se pudo comprobar actualización de runner.js ({err}); usando versión en caché.")
        else:
            raise RuntimeError(f"Error descargando runner.js desde {runner_url}: {err}") from err
    except (urllib.error.URLError, TimeoutError, OSError) as err:
        if runner_path.is_file():
            log_event(f"No se pudo comprobar actualización de runner.js ({err}); usando versión en caché.")
        else:
            raise RuntimeError(f"No se pudo descargar runner.js ({err}) y no hay copia en caché.") from err

    return runner_path


def launch_node_runner(url: str) -> subprocess.Popen | None:
    """Abre el runner de Node.js sin ventana en segundo plano con el modelo de permisos de Node."""
    node = find_node_executable()
    if not node:
        run_error(f"Se necesita {NODE_REQUIRED_MESSAGE} para la ejecución desatendida. Instálalo o usa --browser.")
        return None
    try:
        runner_path = ensure_runner_script()
    except Exception as exc:
        run_error(f"No se pudo preparar el runner de Node.js: {exc}")
        return None
    log_event(f"Iniciando runner de Node.js ({runner_path.name})...")
    cmd = [node, "--permission"]
    if runner_path.name == "run-node.js":
        # En desarrollo js/run-node.js carga sus módulos por require() dentro de js/.
        cmd.append(f"--allow-fs-read={runner_path.parent}")
    cmd.extend([str(runner_path), url])
    try:
        return subprocess.Popen(
            cmd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except OSError as error:
        run_error(f"No se pudo iniciar el proceso de Node.js ({error}).")
        return None

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


class ZeroChatArgumentParser(argparse.ArgumentParser):
    """Los errores de argumentos salen con RUN_EXIT_ARGS para no confundirse con los códigos de --prompt."""
    def error(self, message):
        self.print_usage(sys.stderr)
        self.exit(RUN_EXIT_ARGS, f"{self.prog}: error: {message}\n")


def build_parser() -> ZeroChatArgumentParser:
    """Opciones de la línea de órdenes."""
    parser = ZeroChatArgumentParser(description=f"ZeroChat Local Server v{VERSION}")
    # Desde Python 3.14 argparse colorea la ayuda con códigos ANSI; la consola la muestra en texto plano.
    parser.color = False
    parser.add_argument("--port", type=int, default=None, help=f"Puerto de escucha (default: ZEROCHAT_PORT o {DEFAULT_PORT}; con --prompt, si está ocupado se usa otro libre salvo con --browser en desarrollo)")
    parser.add_argument("--host", default=os.environ.get("ZEROCHAT_HOST", DEFAULT_HOST), help=f"Host de escucha (default: {DEFAULT_HOST})")
    parser.add_argument("--ui-url", default=None, help="URL de la interfaz web a abrir (por defecto: interfaz local en desarrollo o GitHub Pages)")
    parser.add_argument("--no-browser", action="store_true", help="No abrir automáticamente el navegador")
    parser.add_argument("--keep-server", action="store_true", help="Servidor: seguir en marcha al cerrar el navegador (no se combina con --prompt)")
    parser.add_argument("--no-venv", action="store_true", help="Omitir la comprobación/creación de ~/zerochat/.venv")
    parser.add_argument("--test", action="store_true", help="Ejecutar autocomprobación interna de herramientas")
    parser.add_argument("--list-profiles", action="store_true", help="Listar los perfiles de conexión generales almacenados en el servidor local")
    parser.add_argument("--list-conversations", action="store_true", help="Listar las conversaciones almacenadas en el servidor local")
    parser.add_argument("--prompt", default=None, help="Ejecutar este prompt en la interfaz, imprimir solo la respuesta final y terminar (salida 0 terminado, 1 error de generación, 2 plazo agotado o navegador cerrado, 3 fallo de arranque, 4 argumentos no válidos)")
    parser.add_argument("--conversation", default=None, help="Con --prompt o para continuar, id de la conversación almacenada en SQLite")
    parser.add_argument("--profile", default=None, help=f"Con --prompt o --conversation, perfil (nombre o id) que se usa solo en esta ejecución, sin cambiar el activo (por defecto: {DEFAULT_RUN_PROFILE} del servidor)")
    parser.add_argument("--log", choices=("on", "off"), default=None, help="Mostrar la cabecera y el registro del servidor (default: on; off con --prompt o --conversation)")
    parser.add_argument("--export", default=None, metavar="FICHERO", help=f"Con --prompt o --conversation, guardar la conversación en FICHERO; el formato sale de la extensión ({', '.join(RUN_EXPORT_FORMATS)})")
    parser.add_argument("--browser", action="store_true", help="Con --prompt o --conversation, abrir el navegador predeterminado del usuario en lugar del proceso Node.js sin ventana")
    parser.add_argument("--keep-page", action="store_true", help="Página: con --browser, no cerrar la página al terminar para ver la conversación (no se combina con --headless)")
    parser.add_argument("--allow-dangerous-tools", action="store_true", help="Con --prompt o --conversation, aprobar también las herramientas que escriben o ejecutan (write_file, edit_file, run_command); las demás se aprueban siempre para la sesión")
    parser.add_argument("--headless", action="store_true", help="Con --browser, abrir el navegador predeterminado sin ventana (si ya está abierto puede verse la pestaña)")
    parser.add_argument("--version", action="version", version=f"ZeroChat {VERSION}")
    return parser


def run_session_from_args(parser: ZeroChatArgumentParser, args) -> RunSession | None:
    """Valida las combinaciones de opciones y devuelve la sesión de --prompt o --conversation, si la hay."""
    if args.prompt is None and args.conversation is None:
        if args.browser or args.headless or args.keep_page or args.allow_dangerous_tools or args.profile is not None or args.export is not None:
            parser.error("--browser, --headless, --keep-page, --allow-dangerous-tools, --profile y --export solo se usan con --prompt o --conversation")
        return None
    prompt = None
    if args.prompt is not None:
        prompt = args.prompt.strip()
        if not prompt:
            parser.error("el prompt está vacío")
    conversation_id = None
    conv = None
    if args.conversation is not None:
        raw_conv = args.conversation.strip()
        if not raw_conv:
            parser.error("el identificador de la conversación no puede estar vacío")
        try:
            conversation_id = _validate_conversation_id(raw_conv)
        except ValueError as exc:
            parser.error(str(exc))
        conv = get_conversation(conversation_id)
        if conv is None:
            parser.error(f"no existe la conversación '{conversation_id}'")
        if prompt is None:
            history = conv.get("history") or []
            has_user_or_tool = any(m.get("role") in ("user", "tool") for m in history)
            if not has_user_or_tool:
                parser.error(f"la conversación '{conversation_id}' no tiene turnos para continuar")
    if args.no_browser:
        parser.error("--prompt y --conversation ejecutan la interfaz de forma autónoma: no se combina con --no-browser")
    if args.keep_server:
        parser.error("--prompt y --conversation terminan al devolver el resultado: no se combina con --keep-server (para no cerrar la página, --keep-page)")
    if args.headless and not args.browser:
        parser.error("--headless solo se usa con --browser (--prompt y --conversation ya se ejecutan sin ventana con Node.js)")
    if args.keep_page and (not args.browser or args.headless):
        parser.error("--keep-page necesita la ventana del navegador del usuario (--browser sin --headless)")
    profile_data = None
    if args.profile is not None:
        clean_profile = args.profile.strip()
        if not clean_profile:
            parser.error("--profile no puede estar vacío")
        general_match = get_general_profile_by_name(clean_profile) or get_general_profile(clean_profile)
        profile_name = general_match["name"] if general_match else clean_profile
        profile_data = general_match
    elif conversation_id:
        conv_profile = conv.get("profileId") if conv else None
        if conv_profile:
            match = get_general_profile_by_name(conv_profile) or get_general_profile(conv_profile)
            if not match:
                parser.error(f"no existe el perfil '{conv_profile}' en el servidor; créalo o indica uno con --profile")
            profile_name = match["name"]
            profile_data = match
        else:
            default_match = get_general_profile_by_name(DEFAULT_RUN_PROFILE)
            if default_match is None:
                parser.error(f"no existe el perfil por defecto '{DEFAULT_RUN_PROFILE}' en el servidor; créalo o indica uno con --profile")
            profile_name = default_match["name"]
            profile_data = default_match
    else:
        default_match = get_general_profile_by_name(DEFAULT_RUN_PROFILE)
        if default_match is None:
            parser.error(f"no existe el perfil por defecto '{DEFAULT_RUN_PROFILE}' en el servidor; créalo o indica uno con --profile")
        profile_name = default_match["name"]
        profile_data = default_match
    export_path = None
    if args.export is not None:
        export_path = Path(args.export).expanduser().absolute()
        if export_path.suffix.lower() not in RUN_EXPORT_FORMATS:
            parser.error(f"--export necesita una de estas extensiones: {', '.join(RUN_EXPORT_FORMATS)}")
        if not export_path.parent.is_dir():
            parser.error(f"--export: no existe el directorio {export_path.parent}")
    if conversation_id:
        mark_conversation_server_run(conversation_id, profile_name)
    return RunSession(prompt, profile_name, export_path, args.keep_page, args.allow_dangerous_tools, conversation_id=conversation_id, profile_data=profile_data)


def redirect_log(args):
    """Todo el registro pasa por stdout: con --prompt va a stderr para dejar stdout a la respuesta,
    y con --log off se descarta. Devuelve el stdout original, el de la respuesta."""
    result_out = sys.stdout
    log_enabled = args.log == "on" if args.log else RUN_SESSION is None
    if not log_enabled:
        sys.stdout = open(os.devnull, "w", encoding="utf-8")
    elif RUN_SESSION:
        sys.stdout = sys.stderr
    return result_out


def run_self_test():
    """--test: comprueba las herramientas locales básicas sin arrancar el servidor."""
    print(timestamp_message(f"TEST list_directory {'ok' if json.loads(list_directory('.'))['success'] else 'error'}"))
    print(timestamp_message(f"TEST read_file {'ok' if json.loads(read_file('package.json', max_lines=5))['success'] else 'error'}"))
    print(timestamp_message(f"TEST run_command {'ok' if json.loads(run_command('echo hello'))['success'] else 'error'}"))
    print(timestamp_message("TEST all local tools ready."))


def prepare_environment(args, is_dev: bool):
    """Limpia restos de una sesión anterior, prepara el entorno MCP y lanza las comprobaciones de fondo."""
    orphans = cleanup_orphan_jobs()
    if orphans:
        print(timestamp_message(f"Detenidos {orphans} comando(s) que seguían en marcha de una sesión anterior interrumpida."))
    # Entorno MCP aislado en ambos modos de distribución.
    if not args.no_venv:
        ensure_virtual_environment()
    if not browser_action_availability().get("available"):
        add_notice(
            "browser_action desactivada: para usarla, inicia el servicio 'playwright' en Ajustes → MCP "
            "(se instala solo). Requiere Node.js y disponer de Chrome o Edge en el sistema."
        )
    # Versión remota en segundo plano, solo fuera del entorno de desarrollo local.
    if not is_dev:
        threading.Thread(target=check_version, daemon=True).start()


def reset_session_authorizations():
    """Borra las autorizaciones de sesión y los retos pendientes, y vuelve a aplicar la capa de la ejecución."""
    ACCESS_CONTROLLER.clear_session()
    if RUN_SESSION is not None:
        if RUN_SESSION.tool_security:
            ACCESS_CONTROLLER.apply_session_overlay(RUN_SESSION.tool_security, project_context())
        if RUN_SESSION.allow_dangerous_tools:
            ACCESS_CONTROLLER.apply_session_overlay({
                "tools": {name: {"policy": POLICY_ALLOW} for name in ("write_file", "edit_file", "run_command")}
            }, project_context())


def open_server(args, local_ui: bool) -> ThreadingHTTPServer:
    """Abre el puerto de escucha; con --prompt, si el puerto por defecto está ocupado, usa uno libre."""
    global ACTIVE_PORT, ACTIVE_HOST
    ACTIVE_PORT = args.port if args.port is not None else int(os.environ.get("ZEROCHAT_PORT", DEFAULT_PORT))
    ACTIVE_HOST = args.host
    try:
        return ThreadingHTTPServer((ACTIVE_HOST, ACTIVE_PORT), ZeroChatServerHandler)
    except OSError as exc:
        if not RUN_SESSION:
            raise
        if args.port is not None or local_ui:
            hint = "" if args.port is not None else " (en desarrollo la interfaz local necesita ese puerto: cierra el zerochat que lo usa)"
            run_error(f"No se pudo escuchar en {ACTIVE_HOST}:{ACTIVE_PORT}: {exc}{hint}")
            sys.exit(RUN_EXIT_SETUP)
    # Otro zerochat (u otro programa) usa el puerto por defecto: la ejecución usa uno libre.
    try:
        server = ThreadingHTTPServer((ACTIVE_HOST, 0), ZeroChatServerHandler)
    except OSError as retry_exc:
        run_error(f"No se pudo escuchar en {ACTIVE_HOST}: {retry_exc}")
        sys.exit(RUN_EXIT_SETUP)
    log_event(f"El puerto {ACTIVE_PORT} está ocupado; la ejecución usa el {server.server_address[1]}.")
    ACTIVE_PORT = server.server_address[1]
    return server


def interface_url(args, static_root) -> str:
    """URL de la interfaz: la indicada, la local de desarrollo o la de GitHub Pages."""
    if args.ui_url:
        return args.ui_url
    if static_root:
        return f"http://{ACTIVE_HOST}:{ACTIVE_PORT}/zerochat.html"
    return DEFAULT_UI_URL


def launch_url(ui_url: str) -> str:
    """URL con que zerochat abre el navegador: el token vigente y el servidor van en el fragmento."""
    browser_host = ACTIVE_HOST if ACTIVE_HOST in {"127.0.0.1", "localhost"} else "127.0.0.1"
    fragment = {'token': current_session_token(), 'host': browser_host, 'port': ACTIVE_PORT}
    if RUN_SESSION:
        fragment['run'] = RUN_SESSION.run_id
    return f"{ui_url}#{urlencode(fragment)}"


def print_header(dev_root, ui_url: str, exposure_warning: str | None, exit_on_close: bool):
    """Cabecera del servidor con su configuración (sin el token)."""
    print("=" * 64)
    print(f"  ZeroChat Local Server v{VERSION} (UI {UI_VERSION})")
    print(f"  Directorio de trabajo : {PROJECT_DIR}")
    print(f"  Datos y MCP           : {get_data_dir()}")
    print(f"  Entorno MCP           : {get_venv_dir()}")
    if dev_root is not None:
        print(f"  Modo de ejecución     : Desarrollo local ({dev_root})")
    elif is_installed_runtime():
        print("  Modo de ejecución     : Paquete PyPI (GitHub Pages)")
    else:
        print("  Modo de ejecución     : Producción (Web universal)")
    print(f"  Servidor HTTP         : http://{ACTIVE_HOST}:{ACTIVE_PORT}")
    if exposure_warning:
        print(f"  AVISO                 : {exposure_warning}")
    print("  Token de sesión (diario): configurado")
    print(f"  Destino Web           : {ui_url}")
    if exit_on_close:
        print("  Auto-cierre           : Activado (al cerrar navegador)")
    else:
        print("  Auto-cierre           : Desactivado")
    print("=" * 64, flush=True)


def start_interface(args, parser, server: ThreadingHTTPServer, ui_url: str, result_out):
    """Abre la interfaz: en modo ejecución, con su supervisor; si no, con el control de consola.
    Devuelve el navegador sin ventana lanzado, si lo hay."""
    global CONSOLE_CONTROL
    if not RUN_SESSION:
        CONSOLE_CONTROL = ConsoleControl(server, parser, launch_url=lambda: launch_url(ui_url))
        CONSOLE_CONTROL.start()
        if not args.no_browser:
            launch_browser(launch_url(ui_url))
        return None
    target_url = launch_url(ui_url)
    if not args.browser:
        runner_proc = launch_node_runner(target_url)
        if runner_proc is None:
            server.server_close()
            sys.stdout = result_out
            sys.exit(RUN_EXIT_SETUP)
        threading.Thread(target=run_supervisor, args=(server, RUN_SESSION, runner_proc), daemon=True).start()
        return runner_proc
    headless_browser = launch_headless_browser(target_url) if args.headless else None
    if headless_browser is None and not launch_browser(target_url):
        run_error("No se pudo abrir el navegador.")
        server.server_close()
        sys.stdout = result_out
        sys.exit(RUN_EXIT_SETUP)
    if headless_browser is not None:
        threading.Thread(target=fall_back_when_headless_exits, args=(headless_browser, target_url), daemon=True).start()
    threading.Thread(target=run_supervisor, args=(server, RUN_SESSION, None, headless_browser), daemon=True).start()
    return headless_browser


def start_heartbeat_watchdog(server: ThreadingHTTPServer, require_initial: bool):
    """Detiene el servidor cuando el navegador deja de enviar latidos."""
    threading.Thread(
        target=heartbeat_watchdog,
        args=(server, DEFAULT_HEARTBEAT_GRACE, DEFAULT_HEARTBEAT_TIMEOUT, require_initial),
        daemon=True
    ).start()


def install_signal_handlers(server: ThreadingHTTPServer):
    """Ctrl+C, SIGTERM y el cierre del terminal detienen el servidor de forma ordenada."""
    def shutdown(*_):
        console_log("\n" + timestamp_message("Deteniendo servidor ZeroChat..."))
        stop_zerochat_server(server)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)
    # Cerrar el terminal no debe dejar vivos los comandos, que no reciben sus señales.
    if hasattr(signal, "SIGHUP"):
        signal.signal(signal.SIGHUP, shutdown)


def serve(server: ThreadingHTTPServer):
    """Atiende peticiones hasta la parada y libera después el servidor y la consola."""
    global CONSOLE_CONTROL
    try:
        server.serve_forever()
    finally:
        stop_zerochat_server(server)
        server.server_close()
        if CONSOLE_CONTROL:
            CONSOLE_CONTROL.close()
            CONSOLE_CONTROL = None


def finish_run(headless_browser, result_out):
    """Modo ejecución: escribe la respuesta final en el stdout original y sale con su código."""
    # Firefox sin ventana sigue vivo al cerrar la página; uno ya abierto solo recibió la pestaña.
    if headless_browser is not None and headless_browser.poll() is None:
        _kill_process_tree(headless_browser)
    code, text = run_outcome(RUN_SESSION)
    sys.stdout = result_out
    if text is not None:
        result_out.write(text if text.endswith("\n") else text + "\n")
        result_out.flush()
    sys.exit(code)


def main():
    global RUN_SESSION, EXIT_ON_CLOSE

    parser = build_parser()
    args = parser.parse_args()
    # Los avisos no persisten entre ejecuciones del servidor.
    reset_notices()
    RUN_SESSION = run_session_from_args(parser, args)
    result_out = redirect_log(args)

    if getattr(args, "list_profiles", False):
        profiles = list_general_profiles()
        if not profiles:
            print("No hay perfiles de conexión almacenados en el servidor local.")
        else:
            print("Perfiles de conexión del servidor local:")
            for p in profiles:
                settings = p.get("settings", {})
                model = settings.get("model") or "sin modelo"
                api_type = settings.get("apiType") or "openai"
                api_url = settings.get("apiUrl") or ""
                print(f"- {p['name']} ({api_type} / {model}) [{api_url}]")
        return

    if getattr(args, "list_conversations", False):
        conversations = list_conversations()
        if not conversations:
            print("No hay conversaciones almacenadas en el servidor local.")
        else:
            print("Conversaciones almacenadas:")
            for c in conversations:
                date_str = datetime.datetime.fromtimestamp(c["updatedAt"] / 1000).strftime("%Y-%m-%d %H:%M") if c.get("updatedAt") else ""
                count = c.get("messageCount", 0)
                msg_text = "1 mensaje" if count == 1 else f"{count} mensajes"
                date_suffix = f", {date_str}" if date_str else ""
                print(f"- [{c['id']}] {c['title']} ({msg_text}{date_suffix})")
        return

    if args.test:
        run_self_test()
        return

    dev_root = get_dev_root()
    static_root = get_static_root()
    prepare_environment(args, is_dev=dev_root is not None)
    current_session_token()

    # La interfaz local de desarrollo en el navegador del usuario tiene el puerto en su origen: en otro no vería los datos guardados.
    server = open_server(args, local_ui=static_root is not None and not args.ui_url and args.browser)
    exposure_warning = remote_exposure_warning(ACTIVE_HOST)
    if exposure_warning:
        add_notice(exposure_warning)

    ui_url = interface_url(args, static_root)
    # El modo ejecución (que rechaza --keep-server) detecta con el latido que el navegador se cerró sin devolver resultado.
    EXIT_ON_CLOSE = not args.keep_server
    print_header(dev_root, ui_url, exposure_warning, EXIT_ON_CLOSE)

    headless_browser = start_interface(args, parser, server, ui_url, result_out)
    if EXIT_ON_CLOSE:
        start_heartbeat_watchdog(server, require_initial=not args.no_browser)
    install_signal_handlers(server)
    serve(server)

    if RUN_SESSION:
        finish_run(headless_browser, result_out)

if __name__ == "__main__":
    main()
