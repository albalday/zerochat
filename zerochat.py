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
import binascii
import codecs
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
import random
import re
import secrets
import select
import shlex
import shutil
import signal
import socket
import socketserver
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import typing
import urllib.error
import urllib.parse
import urllib.request
import uuid
import venv
import webbrowser
import zlib
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Callable, IO
from urllib.parse import urlencode

# --- core.limits ---
"""Topes compartidos por varios módulos: tamaño de las peticiones HTTP, rutas, comandos y nombres JSON-RPC."""


MAX_HTTP_BODY_BYTES = 1024 * 1024
MAX_PATH_LENGTH = 4096
MAX_COMMAND_LENGTH = 16384
MAX_RPC_METHOD_LENGTH = 128
MAX_TOOL_NAME_LENGTH = 128
LONG_POLL_MAX_WAIT_MS = 30000
# Lo más que una herramienta retiene su respuesta (run_command, check_command, check_agents), en la interfaz y en el
# runner: el fetch de Node corta a los 300 s sin recibir cabeceras (headersTimeout de undici) y los navegadores tienen
# plazos parecidos, así que un tope único por debajo vale para los dos.
TOOL_WAIT_MAX_SECONDS = 240

# --- core.live_events ---
"""Avisos de cambio del estado vivo que sigue el latido: cada dominio avisa y server/state despierta a quien espera."""



_LIVE_CHANGE_HOOKS: list[typing.Callable[[], None]] = []
# Secuencia de avisos, para que quien espera un cambio no pierda uno que llegue mientras relee (wait_live_change).
_LIVE_CHANGE_COND = threading.Condition()
_LIVE_CHANGE_SEQ = 0


def on_live_change(hook: typing.Callable[[], None]):
    """Registra una función sin argumentos que se llama cuando cambia algo del estado vivo."""
    _LIVE_CHANGE_HOOKS.append(hook)
    return hook


def notify_live_change() -> None:
    """Avisa a los registrados de que el estado vivo (comandos, servicios, motores, ejecuciones o conversaciones) cambió."""
    global _LIVE_CHANGE_SEQ
    with _LIVE_CHANGE_COND:
        _LIVE_CHANGE_SEQ += 1
        _LIVE_CHANGE_COND.notify_all()
    for hook in list(_LIVE_CHANGE_HOOKS):
        hook()


def live_change_seq() -> int:
    """Número del último aviso: se toma antes de leer el estado y se pasa a wait_live_change."""
    with _LIVE_CHANGE_COND:
        return _LIVE_CHANGE_SEQ


def wait_live_change(seq: int, timeout: float) -> int:
    """Espera como mucho timeout segundos a un aviso posterior a seq, sin sondeo; devuelve el número del último."""
    deadline = time.monotonic() + max(0.0, timeout)
    with _LIVE_CHANGE_COND:
        while _LIVE_CHANGE_SEQ == seq:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            _LIVE_CHANGE_COND.wait(remaining)
        return _LIVE_CHANGE_SEQ

# --- core.logging ---
"""Registro en consola con la hora local; la consola interactiva, si existe, recibe las líneas."""



CONSOLE_CONTROL = None
# Una línea del registro se escribe entera o no se escribe: al salir, mute_console espera a la que esté en curso.
_WRITE_LOCK = threading.Lock()
_MUTED = False


def set_console_control(control):
    """Fija la consola interactiva que recibe las líneas del registro (None para escribir directamente)."""
    global CONSOLE_CONTROL
    CONSOLE_CONTROL = control


def current_console_control():
    """Consola interactiva que recibe el registro, o None."""
    return CONSOLE_CONTROL


def console_log(message: str, *, flush: bool = True):
    with _WRITE_LOCK:
        if _MUTED:
            return
        if CONSOLE_CONTROL:
            CONSOLE_CONTROL.log(message, flush=flush)
        else:
            print(message, flush=flush)


def console_error(message: str):
    """Una línea en stderr aunque el registro esté desactivado, con el mismo cierre que console_log."""
    with _WRITE_LOCK:
        if not _MUTED:
            print(message, file=sys.stderr, flush=True)


def mute_console():
    """
    Al salir, el registro calla: los hilos en segundo plano que sigan vivos (peticiones del runner, servicios MCP)
    no escriben mientras se cierra el intérprete, que abortaría si uno tuviera tomada la salida al vaciarla.
    """
    global _MUTED
    with _WRITE_LOCK:
        _MUTED = True
        sys.stdout.flush()
        sys.stderr.flush()


def timestamp_message(message: str) -> str:
    """Antepone la hora local con el formato común de la consola."""
    return f"[{time.strftime('%H:%M:%S')}] {message}"


def log_event(message: str):
    """Registra en consola un evento con la hora local."""
    console_log(timestamp_message(message))


def format_log_error(msg: str, max_len: int = 160) -> str:
    """Limpia y trunca mensajes de error para mantener el log en una sola línea legible."""
    if not msg:
        return ""
    cleaned = " ".join(str(msg).strip().splitlines())
    if len(cleaned) > max_len:
        return cleaned[:max_len - 3] + "..."
    return cleaned

# --- browser.launch ---
"""Apertura de la interfaz en el navegador del usuario o en Termux."""





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


def _spawn_detached(args: list[str]):
    """Lanza el abridor sin atarlo a la terminal; OSError si no se puede iniciar."""
    subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)


def _open_in_termux(url: str):
    termux_open_url = get_termux_open_url_executable()
    if not termux_open_url:
        raise FileNotFoundError(
            "Termux fue detectado, pero no se encontró termux-open-url.\n  "
            + browser_launch_diagnostics(["termux-open-url: no localizado"])
        )
    try:
        _spawn_detached([termux_open_url, url])
    except OSError as error:
        raise RuntimeError(
            f"termux-open-url no pudo iniciarse: {type(error).__name__}: {error}\n  "
            + browser_launch_diagnostics(["termux-open-url: error al iniciar"])
        ) from error


def _system_openers(url: str) -> list[tuple[str, list[str] | None]]:
    """Abridores del sistema por orden: (nombre, orden). Una orden None es os.startfile."""
    if sys.platform.startswith("linux"):
        return [("xdg-open", ["xdg-open", url]), ("gio", ["gio", "open", url])]
    if sys.platform == "darwin":
        return [("open", ["open", url])] if shutil.which("open") else []
    if sys.platform == "win32":
        return [("os.startfile", None)]
    return []


def _open_with_system(url: str, attempts: list[str]) -> bool:
    """Prueba los abridores del sistema y anota en attempts por qué falla cada uno."""
    for name, args in _system_openers(url):
        if args is not None and not shutil.which(args[0]):
            attempts.append(f"{name}: no encontrado")
            continue
        try:
            if args is None:
                os.startfile(url)  # pyright: ignore[reportAttributeAccessIssue] - solo existe en Windows
            else:
                _spawn_detached(args)
            return True
        except OSError as error:
            attempts.append(f"{name}: {type(error).__name__}: {error}")
    return False


def open_browser(url: str) -> bool:
    """
    Abre la URL en el navegador predeterminado del usuario respetando el entorno del sistema.
    En Termux usa termux-open-url para delegar la apertura en Android. En el resto de
    Linux prioriza xdg-open o gio para respetar el gestor de ventanas y mimeapps.list,
    desacoplando el proceso hijo para evitar ruidos en la terminal.
    """
    if is_termux_environment():
        _open_in_termux(url)
        return True
    attempts: list[str] = []
    if _open_with_system(url, attempts):
        return True

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

# --- core.environment ---
"""Entorno de ejecución: sistema operativo, directorios de datos y de desarrollo y entorno virtual."""




DETECTED_OS = "windows" if sys.platform.startswith("win") else ("macos" if sys.platform == "darwin" else ("android" if "ANDROID_ROOT" in os.environ else "linux"))
DEFAULT_PORT = 6388
DEFAULT_HOST = "127.0.0.1"
NOTICES: list[str] = []
NOTICES_LOCK = threading.Lock()


@functools.lru_cache(maxsize=1)
def minimal_child_env() -> dict[str, str]:
    """Entorno vacío para procesos de Node que ejecutan código no confiable (solo SYSTEMROOT en Windows)."""
    if DETECTED_OS == "windows" and "SYSTEMROOT" in os.environ:
        return {"SYSTEMROOT": os.environ["SYSTEMROOT"]}
    return {}


def get_dev_root() -> Path | None:
    """
    Raíz del repositorio de desarrollo si este zerochat.py está en ella (junto a zerochat.html, js/ y css/).
    Solo cuenta la carpeta del propio script, no la carpeta desde la que se arranca: un zerochat instalado
    nunca entra en modo desarrollo, aunque se lance dentro de una carpeta que lo parezca.
    """
    script_dir = Path(__file__).resolve().parent
    if (script_dir / "zerochat.html").is_file() and (script_dir / "js").is_dir() and (script_dir / "css").is_dir():
        return script_dir
    return None


def get_static_root() -> Path | None:
    """La interfaz local solo se sirve al ejecutar el repositorio de desarrollo."""
    return get_dev_root()


def is_loopback_host(host: str) -> bool:
    """Indica si un host o una dirección es del propio equipo (también ::ffff:127.0.0.1)."""
    value = (host or "").strip().strip("[]").lower()
    if value == "localhost":
        return True
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return False
    mapped = getattr(address, "ipv4_mapped", None)
    return address.is_loopback or bool(mapped and mapped.is_loopback)


def get_data_dir() -> Path:
    """Devuelve el directorio local que concentra el estado y los MCP de ZeroChat."""
    configured = os.environ.get("ZEROCHAT_DATA_DIR", "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    return (Path.home() / "zerochat").resolve()


# Carpeta de los chats sin proyecto (los hechos sin conexión o fuera de un proyecto): el cliente guarda
# su proyecto vacío y la nombra por su último nivel, igual que a los demás proyectos.
NO_PROJECT_DIR_NAME = "general"


def get_no_project_dir() -> Path:
    """Devuelve la carpeta de trabajo de los chats sin proyecto y la crea si falta."""
    target = get_data_dir() / NO_PROJECT_DIR_NAME
    target.mkdir(mode=0o700, parents=True, exist_ok=True)
    return target


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


ACTIVE_PORT = DEFAULT_PORT
ACTIVE_HOST = DEFAULT_HOST


def set_active_address(host: str, port: int):
    """Fija el host y el puerto en los que escucha este proceso; los lee quien compone la URL de la interfaz."""
    global ACTIVE_HOST, ACTIVE_PORT
    ACTIVE_HOST, ACTIVE_PORT = host, port


def active_address() -> tuple[str, int]:
    """Host y puerto en los que escucha este proceso."""
    return ACTIVE_HOST, ACTIVE_PORT


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

# --- auth.tokens ---
"""Gestión de tokens de sesión y credenciales de ejecución: token local diario, sesiones remotas (login) y tokens acotados del runner."""





MAX_REMOTE_TOKENS = 16
RUNNER_ALLOWED_METHODS = frozenset({
    "initialize",
    "notifications/initialized",
    "tools/list",
    "tools/call",
    "zerochat/run/prompt",
    "zerochat/run/profile",
    "zerochat/run/progress",
    "zerochat/run/usage",
    "zerochat/run/export",
    "zerochat/run/result",
    "zerochat/web/fetch",
    "zerochat/jobs/stop",
    "zerochat/heartbeat",
    "zerochat/external/servers/start",
    "zerochat/external/servers/stop",
    "zerochat/sandbox/execute",
})


@dataclasses.dataclass(frozen=True)
class TokenGrant:
    """Credencial autenticada con su tipo, fecha de emisión y alcance sobre la API."""
    token: str
    kind: str  # "local" | "remote" | "runner"
    date: str
    created_at: float
    run_id: str | None = None
    conversation_id: str | None = None

    def allows(self, method: str, params: dict | None = None) -> bool:
        """Indica si esta credencial autoriza el método JSON-RPC solicitado."""
        if self.kind in ("local", "remote"):
            return True
        if self.kind != "runner":
            return False
        if method in RUNNER_ALLOWED_METHODS:
            return True
        if self.conversation_id and isinstance(params, dict):
            if method == "zerochat/conversations/get":
                return params.get("id") == self.conversation_id
            if method == "zerochat/conversations/save":
                conv = params.get("conversation")
                return isinstance(conv, dict) and conv.get("id") == self.conversation_id
            if method in ("zerochat/conversations/save_chunk", "zerochat/conversations/cancel_upload"):
                return params.get("conversationId") == self.conversation_id
        return False


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


# Lo que caduca con cada token (las autorizaciones de sesión): lo registran las capas que lo guardan.
TOKEN_ROTATION_HOOKS: list = []


def on_token_rotation(hook):
    """Registra una función que se llama, sin argumentos, cada vez que se carga un token nuevo."""
    TOKEN_ROTATION_HOOKS.append(hook)
    return hook


# Token local diario, sesiones remotas y tokens de runner activos en memoria bajo el mismo cerrojo.
SESSION_TOKEN = ""
SESSION_TOKEN_DATE = ""
ACTIVE_GRANTS: dict[str, TokenGrant] = {}
SESSION_TOKEN_LOCK = threading.Lock()


def _refresh_daily_locked(today: str) -> str:
    """Renueva el token local al cambiar de día, limpia sesiones remotas caducadas y avisa a los hooks."""
    global SESSION_TOKEN, SESSION_TOKEN_DATE
    if SESSION_TOKEN_DATE != today:
        SESSION_TOKEN = get_daily_token()
        SESSION_TOKEN_DATE = today
        expired = [tok for tok, grant in ACTIVE_GRANTS.items() if grant.kind == "remote" and grant.date != today]
        for tok in expired:
            ACTIVE_GRANTS.pop(tok, None)
        for hook in TOKEN_ROTATION_HOOKS:
            hook()
    return SESSION_TOKEN


def current_session_token() -> str:
    """
    Token diario vigente para el navegador local: al cambiar el día carga o genera el nuevo.
    """
    today = datetime.date.today().isoformat()
    with SESSION_TOKEN_LOCK:
        return _refresh_daily_locked(today)


def issue_login_token() -> str:
    """Emite una credencial independiente de usuario para una sesión remota autenticada por zerochat/login."""
    today = datetime.date.today().isoformat()
    with SESSION_TOKEN_LOCK:
        _refresh_daily_locked(today)
        remote_grants = [g for g in ACTIVE_GRANTS.values() if g.kind == "remote"]
        while len(remote_grants) >= MAX_REMOTE_TOKENS:
            oldest = min(remote_grants, key=lambda g: g.created_at)
            ACTIVE_GRANTS.pop(oldest.token, None)
            remote_grants.remove(oldest)
        token = secrets.token_urlsafe(32)
        ACTIVE_GRANTS[token] = TokenGrant(
            token=token,
            kind="remote",
            date=today,
            created_at=time.monotonic(),
        )
        return token


def issue_runner_token(run_id: str, conversation_id: str | None = None) -> str:
    """Emite una credencial acotada para el proceso runner de Node.js ligada a su ejecución."""
    today = datetime.date.today().isoformat()
    with SESSION_TOKEN_LOCK:
        _refresh_daily_locked(today)
        token = secrets.token_urlsafe(32)
        ACTIVE_GRANTS[token] = TokenGrant(
            token=token,
            kind="runner",
            date=today,
            created_at=time.monotonic(),
            run_id=run_id,
            conversation_id=conversation_id,
        )
        return token


def revoke_token(token: str | None) -> bool:
    """Revoca una credencial emitida en memoria (sesión remota o runner)."""
    if not token:
        return False
    with SESSION_TOKEN_LOCK:
        return ACTIVE_GRANTS.pop(token, None) is not None


def resolve_token(token_candidate: str) -> TokenGrant | None:
    """Valida una credencial en tiempo constante y devuelve su TokenGrant o None."""
    if not token_candidate or not isinstance(token_candidate, str):
        return None
    today = datetime.date.today().isoformat()
    candidate_bytes = token_candidate.encode()
    with SESSION_TOKEN_LOCK:
        local_token = _refresh_daily_locked(today)
        if local_token and hmac.compare_digest(candidate_bytes, local_token.encode()):
            return TokenGrant(token=local_token, kind="local", date=SESSION_TOKEN_DATE, created_at=0.0)
        matched: TokenGrant | None = None
        for grant in ACTIVE_GRANTS.values():
            if hmac.compare_digest(candidate_bytes, grant.token.encode()):
                matched = grant
        if matched is None:
            return None
        if matched.kind == "remote" and matched.date != today:
            ACTIVE_GRANTS.pop(matched.token, None)
            return None
        return matched

# --- auth.login ---
"""Identificación con la cuenta del sistema que ejecuta zerochat (PAM o LogonUserW) para obtener el token diario."""





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
    advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)  # pyright: ignore[reportAttributeAccessIssue] (solo en Windows)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)  # pyright: ignore[reportAttributeAccessIssue] (solo en Windows)
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
    return {"token": issue_login_token()}

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
                if _exits_within(pid, proc, grace_seconds):
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


def _exits_within(pid: int, proc: subprocess.Popen | None, seconds: float) -> bool:
    """Si el proceso termina antes de seconds segundos: el Popen propio se espera; de otro solo se tiene el PID."""
    if proc is not None:
        try:
            proc.wait(timeout=seconds)
            return True
        except subprocess.TimeoutExpired:
            return False
    exited = wait_pid_exit(pid, seconds)
    if exited is None:
        time.sleep(seconds)
        return not _pid_alive(pid)
    return exited


def _windows_kernel32():
    """kernel32 con los prototipos que usan la huella de arranque y la comprobación de vida de un proceso."""
    from ctypes import wintypes
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)  # pyright: ignore[reportAttributeAccessIssue] (solo en Windows)
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.GetExitCodeProcess.restype = wintypes.BOOL
    kernel32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    kernel32.GetProcessTimes.restype = wintypes.BOOL
    kernel32.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
    kernel32.WaitForSingleObject.restype = wintypes.DWORD
    kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    return kernel32


# PROCESS_QUERY_LIMITED_INFORMATION: basta para leer la hora de creación y el código de salida.
_WINDOWS_PROCESS_QUERY = 0x1000
_WINDOWS_SYNCHRONIZE = 0x00100000
_WINDOWS_INFINITE = 0xFFFFFFFF


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
        return ctypes.get_last_error() == 5  # ERROR_ACCESS_DENIED: existe, pero es de otra cuenta  # pyright: ignore[reportAttributeAccessIssue] (solo en Windows)
    try:
        exit_code = wintypes.DWORD()
        return bool(kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code))) and exit_code.value == 259  # STILL_ACTIVE
    finally:
        kernel32.CloseHandle(handle)


@functools.cache
def pid_exit_waitable() -> bool:
    """Si este sistema sabe esperar sin sondeo a que termine un proceso por su PID (wait_pid_exit)."""
    if sys.platform == "linux":
        try:
            os.close(os.pidfd_open(os.getpid()))
            return True
        except OSError:
            return False  # Núcleo anterior a pidfd (Linux 5.3).
    return sys.platform in ("darwin", "win32")


def wait_pid_exit(pid: int, timeout: float | None) -> bool | None:
    """
    Espera como mucho timeout segundos (None: sin plazo) a que termine un proceso del que solo se tiene el PID
    (de un Popen propio basta Popen.wait), sin sondeo: pidfd en Linux, kqueue en macOS y su handle en Windows.
    Devuelve si terminó, o None si no se puede esperar (pid_exit_waitable, o un proceso de otra cuenta en Windows).
    """
    if not pid_exit_waitable():
        return None
    try:
        if sys.platform == "linux":
            fd = os.pidfd_open(pid)
            try:
                # poll y no select: select no admite descriptores por encima de FD_SETSIZE (1024).
                poller = select.poll()
                poller.register(fd, select.POLLIN)
                return bool(poller.poll(None if timeout is None else max(0, int(timeout * 1000))))
            finally:
                os.close(fd)
        if sys.platform == "darwin":
            queue = select.kqueue()
            try:
                event = select.kevent(pid, filter=select.KQ_FILTER_PROC, flags=select.KQ_EV_ADD | select.KQ_EV_ONESHOT,
                                      fflags=select.KQ_NOTE_EXIT)
                return bool(queue.control([event], 1, timeout))
            finally:
                queue.close()
        return _windows_wait_pid_exit(pid, timeout)
    except ProcessLookupError:
        return True


def _windows_wait_pid_exit(pid: int, timeout: float | None) -> bool | None:
    kernel32 = _windows_kernel32()
    handle = kernel32.OpenProcess(_WINDOWS_SYNCHRONIZE, False, pid)
    if not handle:
        # ERROR_ACCESS_DENIED: existe, pero es de otra cuenta; si no, ya no existe.
        return None if ctypes.get_last_error() == 5 else True  # pyright: ignore[reportAttributeAccessIssue] (solo en Windows)
    try:
        wait_ms = _WINDOWS_INFINITE if timeout is None else max(0, int(timeout * 1000))
        return kernel32.WaitForSingleObject(handle, wait_ms) == 0  # WAIT_OBJECT_0
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

# --- core.rate_limit ---
"""Control de frecuencia y paralelismo de las llamadas salientes, por recurso (un dominio web o un servicio MCP).

No es un control de gasto: solo evita saturar un sitio o un servicio (retos anti-bot de DuckDuckGo, límites por
segundo de una API). La cuenta vive en memoria de este proceso; una ejecución en servidor (--prompt, --conversation)
lleva la suya.
"""



# Lo más que una llamada espera su turno; si haría falta más, falla enseguida con RateLimitBusy.
RATE_LIMIT_MAX_WAIT_S = 30.0


@dataclasses.dataclass(frozen=True)
class RatePolicy:
    """`concurrency` llamadas a la vez y `min_interval_s` desde la respuesta anterior al mismo recurso."""
    concurrency: int = 1
    min_interval_s: float = 0.0


class RateLimitBusy(Exception):
    """El recurso no queda libre dentro de la espera admitida."""

    def __init__(self, key: str, max_wait_s: float):
        super().__init__(f"{key} está ocupado: hay demasiadas llamadas seguidas o a la vez y no queda libre en "
                         f"{max_wait_s:.0f} s. Espera un poco antes de volver a llamarlo.")


@dataclasses.dataclass
class _ResourceState:
    active: int
    last_done: float


def parse_rate_policy(value) -> RatePolicy | None:
    """La política de un `rateLimit` declarado ({"concurrency", "minIntervalS"}), o None si no declara ninguna válida."""
    if not isinstance(value, dict):
        return None
    concurrency, interval = value.get("concurrency", 1), value.get("minIntervalS", 0)
    if isinstance(concurrency, bool) or not isinstance(concurrency, int) or not 1 <= concurrency <= 64:
        return None
    if isinstance(interval, bool) or not isinstance(interval, int | float) or not 0 <= interval <= 60:
        return None
    return RatePolicy(concurrency=concurrency, min_interval_s=float(interval))


class RateLimiter:
    """Turnos por recurso. La separación se cuenta desde la respuesta anterior, y al arrancar el proceso como si
    acabara de haber una: la primera llamada tras arrancar también espera, como las siguientes."""

    def __init__(self):
        self._condition = threading.Condition()
        self._resources: dict[str, _ResourceState] = {}
        self._started = time.monotonic()

    @contextlib.contextmanager
    def slot(self, key: str, policy: RatePolicy, max_wait_s: float = RATE_LIMIT_MAX_WAIT_S) -> Iterator[float]:
        """Espera el turno del recurso `key` y devuelve los segundos esperados; RateLimitBusy si no llega a tiempo."""
        started = time.monotonic()
        deadline = started + max(0.0, max_wait_s)
        with self._condition:
            state = self._resources.setdefault(key, _ResourceState(0, self._started))
            while True:
                now = time.monotonic()
                gap = policy.min_interval_s - (now - state.last_done)
                if state.active < policy.concurrency and gap <= 0:
                    break
                # Con hueco libre se sabe cuánto falta; sin él, hasta que termine otra llamada.
                wait = gap if state.active < policy.concurrency else deadline - now
                if now + max(wait, 0.0) > deadline or deadline - now <= 0:
                    raise RateLimitBusy(key, max_wait_s)
                self._condition.wait(max(wait, 0.001))
            state.active += 1
        waited = time.monotonic() - started
        try:
            yield waited
        finally:
            with self._condition:
                state.active -= 1
                state.last_done = time.monotonic()
                self._condition.notify_all()


RATE_LIMITER = RateLimiter()

# --- core.rpc ---
"""Respuestas de los métodos JSON-RPC del servidor: (resultado, error JSON-RPC, detalle para el registro)."""



METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603

RpcOutcome = tuple[dict | None, dict | None, str]


def rpc_result(result) -> RpcOutcome:
    return result, None, ""


def rpc_error(code: int, message: str, detail: str = "") -> RpcOutcome:
    return None, {"code": code, "message": message}, detail


def rpc_not_supported(method: str) -> RpcOutcome:
    return rpc_error(METHOD_NOT_FOUND, f"Método '{method}' no soportado.")


def dispatch_table(handlers: dict[str, Callable[..., RpcOutcome]], method: str, *args) -> RpcOutcome:
    """Atiende el método con su función de la tabla, que recibe *args; sin ella, «no soportado»."""
    handler = handlers.get(method)
    return handler(*args) if handler else rpc_not_supported(method)


def parse_optional_nonneg_int(value, label: str) -> int | None:
    """Valida un parámetro entero no negativo (sin booleanos) que puede faltar (None)."""
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{label} debe ser un entero no negativo.")
    return value


def parse_nonneg_int(value, label: str, default: int = 0) -> int:
    """Valida un parámetro entero no negativo (sin booleanos); devuelve `default` si falta."""
    parsed = parse_optional_nonneg_int(value, label)
    return default if parsed is None else parsed

# --- core.version ---
"""Versiones del backend y de la interfaz, y direcciones desde las que se publican."""




SOURCE_BACKEND_VERSION = "10.43.0"


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
# Versión publicada de la interfaz: la del título de zerochat.html, sin distinguir mayúsculas. La leen este módulo
# y el cargador del runner de Node, en Python y en JavaScript: el patrón es válido en los dos.
UI_VERSION_TITLE_PATTERN = r"<title>\s*ZeroChat\s+v(\d+\.\d+\.\d+)\s*</title>"


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
    # Solo se llama con las URL https fijas de este módulo.
    req = urllib.request.Request(url, headers={"User-Agent": f"ZeroChat/{VERSION}"})  # noqa: S310
    with urllib.request.urlopen(req, timeout=3) as resp:  # noqa: S310
        return resp.read(4096).decode("utf-8", errors="ignore")


def _read_remote_ui_version() -> str | None:
    """Extrae la versión del título de la interfaz servida por GitHub Pages."""
    content = _read_remote_content(DEFAULT_UI_URL)
    match = re.search(UI_VERSION_TITLE_PATTERN, content, re.IGNORECASE)
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


def is_installed_runtime() -> bool:
    """Identifica el ejecutable instalado desde PyPI, sin confundirlo con el repositorio."""
    if get_dev_root() is not None:
        return False
    try:
        return importlib.metadata.version("zerochat") == BACKEND_PACKAGE_VERSION
    except importlib.metadata.PackageNotFoundError:
        return False

# --- mcp.catalog ---
"""Catálogo de los servicios MCP incluidos: `services/manifest.json`, publicado junto a la interfaz.

El catálogo, generado por scripts/build-managed-services.mjs, da por servicio su versión y la huella sha256 de cada
fichero. Se descarga de la carpeta de la interfaz (GitHub Pages en producción, este servidor en desarrollo), como el
runner de Node: actualizar un servicio no exige publicar zerochat en PyPI. Solo se copian los servicios cuya versión
instalada difiere, y de ellos solo los ficheros del catálogo: node_modules, .installed.json y los datos del servicio
(como memory.jsonl) se conservan, y los servicios del usuario no se tocan.
"""




CATALOG_PATH = "services/manifest.json"
CATALOG_SCHEMA_VERSION = 1
# Tope de cada descarga (el catálogo y cada fichero): los de ahora ocupan unos pocos KiB.
CATALOG_MAX_BYTES = 1024 * 1024
CATALOG_TIMEOUT_SECONDS = 10
SERVICE_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
# Rutas relativas sin segmentos ocultos ni '..': un segmento no empieza por punto.
SERVICE_FILE_PATTERN = re.compile(r"^[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$")
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
SERVICE_DEFINITION = "service.json"


def catalog_base(ui_url: str) -> str:
    """Carpeta de la interfaz, de la que cuelga services/."""
    return urllib.parse.urljoin(ui_url.split("#")[0], ".")


def download(url: str) -> bytes:
    """Descarga acotada a CATALOG_MAX_BYTES de un recurso de la carpeta de la interfaz."""
    if urllib.parse.urlsplit(url).scheme not in ("http", "https"):
        raise ValueError(f"URL del catálogo no admitida: {url}")
    req = urllib.request.Request(url, headers={"User-Agent": f"ZeroChat/{VERSION}", "Cache-Control": "no-cache"})  # noqa: S310
    with urllib.request.urlopen(req, timeout=CATALOG_TIMEOUT_SECONDS) as resp:  # noqa: S310
        data = resp.read(CATALOG_MAX_BYTES + 1)
    if len(data) > CATALOG_MAX_BYTES:
        raise ValueError(f"{url} excede {CATALOG_MAX_BYTES} bytes")
    return data


def parse_catalog(raw: bytes) -> dict[str, dict]:
    """{id: {"version", "files": {ruta: sha256}}} del catálogo; ValueError si no es válido."""
    try:
        catalog = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"El catálogo de servicios no es JSON válido: {exc}") from exc
    if not isinstance(catalog, dict) or catalog.get("schemaVersion") != CATALOG_SCHEMA_VERSION:
        raise ValueError(f"El catálogo de servicios no es de la versión {CATALOG_SCHEMA_VERSION}")
    services = catalog.get("services")
    if not isinstance(services, dict):
        raise ValueError("El catálogo de servicios no tiene services")
    for server_id, entry in services.items():
        if not SERVICE_ID_PATTERN.match(server_id):
            raise ValueError(f"Id de servicio no válido en el catálogo: {server_id!r}")
        if not isinstance(entry, dict) or not isinstance(entry.get("version"), str) or not entry["version"]:
            raise ValueError(f"El servicio {server_id} del catálogo no tiene version")
        files = entry.get("files")
        if not isinstance(files, dict) or SERVICE_DEFINITION not in files:
            raise ValueError(f"El servicio {server_id} del catálogo no incluye {SERVICE_DEFINITION}")
        for path, digest in files.items():
            if not SERVICE_FILE_PATTERN.match(path) or not isinstance(digest, str) or not SHA256_PATTERN.match(digest):
                raise ValueError(f"Fichero no válido en el servicio {server_id} del catálogo: {path!r}")
    return services


def installed_version(services_root: Path, server_id: str) -> str | None:
    """Versión del service.json instalado, o None si falta o no se puede leer."""
    try:
        definition = json.loads((services_root / server_id / SERVICE_DEFINITION).read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    version = definition.get("version") if isinstance(definition, dict) else None
    return version if isinstance(version, str) else None


def download_service(base: str, server_id: str, entry: dict) -> dict[str, bytes]:
    """Ficheros de un servicio del catálogo, comprobados contra su huella; ValueError si alguno no coincide."""
    files = {}
    for path, digest in entry["files"].items():
        data = download(urllib.parse.urljoin(base, f"services/{server_id}/{path}"))
        if hashlib.sha256(data).hexdigest() != digest:
            raise ValueError(f"{server_id}/{path} no coincide con la huella del catálogo")
        files[path] = data
    try:
        definition = json.loads(files[SERVICE_DEFINITION].decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"{server_id}/{SERVICE_DEFINITION} no es JSON válido: {exc}") from exc
    if not isinstance(definition, dict) or definition.get("id") != server_id or definition.get("version") != entry["version"]:
        raise ValueError(f"{server_id}/{SERVICE_DEFINITION} no tiene el id y la versión del catálogo")
    return files


def install_service(services_root: Path, server_id: str, files: dict[str, bytes]) -> None:
    """Escribe los ficheros del servicio, cada uno de forma atómica; service.json, con la versión, el último."""
    service_dir = services_root / server_id
    for path in sorted(files, key=lambda name: name == SERVICE_DEFINITION):
        destination = service_dir / path
        destination.parent.mkdir(parents=True, exist_ok=True)
        tmp = destination.with_name(destination.name + ".tmp")
        tmp.write_bytes(files[path])
        tmp.replace(destination)

# --- mcp.stdio_client ---
"""Cliente MCP por stdio: arranque del proceso, mensajes JSON-RPC acotados, plazos y cierre con sus descendientes."""





# Un mensaje MCP admite imágenes en base64, pero no puede agotar la memoria del backend.
MAX_MCP_MESSAGE_CHARS = 16 * 1024 * 1024
MAX_MCP_STDERR_LINE_CHARS = 64 * 1024
DEFAULT_MCP_CALL_TIMEOUT_SECONDS = 30


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
                 call_timeout: float = DEFAULT_MCP_CALL_TIMEOUT_SECONDS, on_oauth_url=None):
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
        self._on_oauth_url = on_oauth_url

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
                    if self._on_oauth_url:
                        self._on_oauth_url(url)
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

# --- run_mode.runner_loader ---
"""Cargador del runner de Node.js: descarga los módulos de la interfaz como un navegador y los ejecuta.

El servidor lo lanza con `node --permission -e RUNNER_LOADER_SCRIPT <caché> <url de la interfaz> <política>`. Desde la
carpeta de la interfaz (GitHub Pages en producción, este servidor en desarrollo) descarga `js/run-node.js` y,
siguiendo sus `require('./…')`, los módulos que usa, en paralelo; los ejecuta con un `require` mínimo que los
busca en lo descargado (los de Node, como `node:crypto`, van al `require` real). Lo que se ejecuta es lo que se
publica: no hay empaquetado ni copia versionada.

Cada descarga completa sustituye la caché (un JSON con la carpeta de origen, la versión publicada y los ficheros).
Con la política `version` (la instalada), una sola petición lee la versión publicada del título de la interfaz: si
es la de la caché, se ejecuta la caché sin pedir ningún módulo; si es otra o no se puede leer, se descarga todo. La
descarga completa tarda de 0,5 a 0,7 s desde GitHub Pages con su CDN caliente y unos 6 s en frío (45 módulos,
811 KiB), y la versión de 0,1 a 0,25 s. En desarrollo (política `always`) se descarga siempre: los módulos cambian
sin subir la versión. Sin conexión, sea cual sea la versión, se usa la caché para seguir con un modelo local; una
respuesta de error de la interfaz (un 404) es un fallo, no un motivo para ejecutar la copia anterior. Las librerías
de terceros que se cargan bajo demanda (`ChatVendorLoader`) siguen el mismo camino con `globalThis.ChatRunnerSource`.
"""




# Política de caché del runner: ejecutar la caché si es de la versión publicada, o descargar siempre (desarrollo).
RUNNER_CACHE_BY_VERSION = "version"
RUNNER_CACHE_ALWAYS_DOWNLOAD = "always"

# Tope de lo descargado en una ejecución: la interfaz completa ocupa unas pocas centenas de KiB.
RUNNER_MAX_BYTES = 16 * 1024 * 1024

RUNNER_LOADER_SCRIPT = r"""
'use strict';
const fs = require('node:fs');
const vm = require('node:vm');

const [cacheFile, uiUrl, cachePolicy] = process.argv.slice(1);
const pageUrl = uiUrl.split('#')[0];
const base = new URL('.', pageUrl).href;
const ENTRY = 'js/run-node.js';
const MAX_BYTES = __MAX_BYTES__;
const VERSION_RE = new RegExp(__VERSION_PATTERN__, 'i');
const REQUIRE_RE = /require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;

function resolveKey(from, spec) {
  const href = new URL(spec, base + from).href;
  if (!href.startsWith(base)) throw new Error(`Module outside the interface folder: ${spec}`);
  return href.slice(base.length);
}

// Solo un fallo de red (fetch lanza) permite usar la caché: una respuesta de error o un tope superado, no.
async function download(key) {
  let response;
  try {
    response = await fetch(base + key);
  } catch (cause) {
    const error = new Error(`${base + key}: ${cause.cause?.code || cause.message}`);
    error.offline = true;
    throw error;
  }
  if (!response.ok) throw new Error(`${base + key}: HTTP ${response.status}`);
  return response.text();
}

async function downloadGraph() {
  const files = {};
  const seen = new Set([ENTRY]);
  let pending = [ENTRY];
  let total = 0;
  while (pending.length) {
    const texts = await Promise.all(pending.map(key => download(key)));
    const next = [];
    pending.forEach((key, index) => {
      files[key] = texts[index];
      total += texts[index].length;
      for (const match of texts[index].matchAll(REQUIRE_RE)) {
        const dep = resolveKey(key, match[1]);
        if (!seen.has(dep)) {
          seen.add(dep);
          next.push(dep);
        }
      }
    });
    if (total > MAX_BYTES) throw new Error(`The runner modules exceed ${MAX_BYTES} bytes.`);
    pending = next;
  }
  return files;
}

// Versión publicada de la interfaz, o null si no se puede leer: entonces se descarga todo.
async function publishedVersion() {
  if (cachePolicy !== '__BY_VERSION__') return null;
  try {
    const response = await fetch(pageUrl);
    return response.ok ? (VERSION_RE.exec(await response.text()) || [])[1] || null : null;
  } catch {
    return null;
  }
}

function readCache() {
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    return cached && cached.base === base && cached.files && typeof cached.files === 'object' ? cached : null;
  } catch {
    return null;
  }
}

function writeCache(files, version) {
  try {
    fs.writeFileSync(cacheFile + '.tmp', JSON.stringify({ base, version, files }), { mode: 0o600 });
    fs.renameSync(cacheFile + '.tmp', cacheFile);
  } catch (error) {
    console.error(`[RunnerLoader] Could not update the cache: ${error.message}`);
  }
}

function execute(files) {
  const modules = new Map();
  const load = key => {
    if (modules.has(key)) return modules.get(key).exports;
    if (typeof files[key] !== 'string') throw new Error(`Module not downloaded: ${key}`);
    const module = { exports: {} };
    modules.set(key, module);
    const filename = base + key;
    const wrapper = vm.runInThisContext(`(function (exports, require, module, __filename, __dirname) {${files[key]}\n})`, { filename });
    const localRequire = spec => (spec.startsWith('.') ? load(resolveKey(key, spec)) : require(spec));
    wrapper.call(module.exports, module.exports, localRequire, module, filename, new URL('.', filename).href);
    return module.exports;
  };
  return load(ENTRY);
}

async function loadFiles(version) {
  const cached = readCache();
  if (version && cached && cached.version === version) {
    console.error(`[RunnerLoader] Using the cached modules of version ${version}.`);
    return { files: cached.files, current: true };
  }
  const started = Date.now();
  try {
    const files = await downloadGraph();
    writeCache(files, version);
    const kib = Math.round(Object.values(files).reduce((sum, text) => sum + text.length, 0) / 1024);
    console.error(`[RunnerLoader] Downloaded ${Object.keys(files).length} modules (${kib} KiB) in ${Date.now() - started} ms.`);
    return { files, current: false };
  } catch (error) {
    if (!error.offline || !cached) throw error;
    console.error(`[RunnerLoader] ${base} is unreachable (${error.message}); using the cached copy.`);
    return { files: cached.files, current: false };
  }
}

(async () => {
  const version = await publishedVersion();
  const { files, current } = await loadFiles(version);
  // Las librerías de terceros se piden al usarlas: con la caché de la versión publicada salen de ella si ya están;
  // si no, se descargan y se añaden a la caché.
  globalThis.ChatRunnerSource = async key => {
    if (current && typeof files[key] === 'string') return files[key];
    try {
      files[key] = await download(key);
      writeCache(files, version);
    } catch (error) {
      if (!error.offline || typeof files[key] !== 'string') throw error;
    }
    return files[key];
  };
  await execute(files).startHeadlessRun([uiUrl]);
})().catch(error => {
  console.error('[RunnerLoader] Fatal error:', error);
  process.exit(1);
});
""".replace("__MAX_BYTES__", str(RUNNER_MAX_BYTES)).replace("__VERSION_PATTERN__", json.dumps(UI_VERSION_TITLE_PATTERN)).replace(
    "__BY_VERSION__", RUNNER_CACHE_BY_VERSION)

# --- security.context ---
"""Proyecto de cada petición (SecurityContext): carpeta canónica, rutas resueltas contra ella y clave de su sesión."""




# Proyecto por defecto: la carpeta de arranque, para las peticiones que no indican el suyo (la primera
# conexión de una pestaña, las ejecuciones en servidor). El proceso nunca cambia de directorio: cada
# petición recibe su proyecto en un SecurityContext.
PROJECT_DIR = Path.cwd().resolve()


def project_context() -> "SecurityContext":
    """Contexto del proyecto por defecto del servidor."""
    return SecurityContext(PROJECT_DIR)


def set_default_project_dir(path: Path) -> Path:
    """Fija el proyecto por defecto del servidor antes de atender peticiones (p. ej. al reanudar --conversation)."""
    global PROJECT_DIR
    PROJECT_DIR = path.resolve()
    return PROJECT_DIR


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
        raw = str(path).strip()
        if not raw or "\0" in raw:
            raise ValueError(f"Ruta no válida: '{path}'.")
        expanded = Path(raw).expanduser()
        if contains_unresolved_reference(str(expanded)):
            raise ValueError(f"Ruta no válida: '{path}'.")
        candidate = expanded if expanded.is_absolute() else self.workspace_dir / expanded
        norm = normalize_directory_path(str(candidate))
        if not norm:
            raise ValueError(f"Ruta no válida: '{path}'.")
        return Path(norm).resolve()

    def resolve_path(self, path_str: str) -> Path | None:
        """La ruta de absolute() para evaluar permisos; None si no es válida o lleva referencias sin resolver ('~', '$VAR')."""
        if not isinstance(path_str, str) or contains_unresolved_reference(path_str):
            return None
        try:
            return self.absolute(path_str)
        except (ValueError, RuntimeError, OSError):
            return None


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

# --- security.rules ---
"""Reglas de permisos sin estado: políticas, reglas de directorio, patrones de comando y ofertas de regla."""




# Shell con la que run_command ejecuta los comandos (tools/jobs.py): PowerShell en Windows y sh en el resto.
# Los comandos se parten y se leen con sus reglas: en PowerShell la \ es un carácter más (C:\x), el escape
# es la comilla invertida y dentro de comillas la comilla se repite ('it''s').
COMMAND_SHELL = "powershell" if DETECTED_OS == "windows" else "posix"

POLICY_ALLOW = "allow"
POLICY_DENY = "deny"
POLICY_ASK = "ask"
SCOPE_PERMANENT = "permanent"
SCOPE_SESSION = "session"
AUTHORIZE_DECISIONS = ("allow_once", "allow_session", "allow_project", "allow_always", "allow_server_always")
DIRECTORY_RULE_PATTERN = re.compile(r"^([RWX]+):(.+)$")
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
# En PowerShell /dev/null es un fichero más: lo que se descarta va a $null.
POWERSHELL_SAFE_REDIRECTION_PATTERN = re.compile(r"[\d*]?>>?\s*\$null\b|\d?>&\d")
# Lo que impide validar un comando por partes: sustitución de comandos o de procesos y saltos de línea, y en
# PowerShell además los bloques de script ({ }), que ejecutan lo que llevan dentro.
SHELL_SPLIT_UNSUPPORTED = re.compile(r"[`\n\r]|\$\(|[<>]\(")
POWERSHELL_SPLIT_UNSUPPORTED = re.compile(r"[`\n\r{}]|\$\(|[<>]\(")
# PowerShell también acepta como comillas las tipográficas: se leen como las ASCII.
_POWERSHELL_QUOTES = str.maketrans({"\u2018": "'", "\u2019": "'", "\u201a": "'", "\u201b": "'",
                                    "\u201c": '"', "\u201d": '"', "\u201e": '"'})
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
# Órdenes que actúan sobre todo el sistema (privilegios, discos, energía, servicios): nunca son locales
# al proyecto aunque no lleven rutas. mkfs incluye su familia (mkfs.ext4, mkfs.vfat...).
WORKSPACE_TRUST_GLOBAL_COMMANDS = frozenset([
    "sudo", "su", "doas", "pkexec", "run0", "mkfs", "reboot", "shutdown", "poweroff", "halt", "systemctl"
])
# Las de Windows solo cuentan con PowerShell: en sh, 'npm run format' no formatea ningún disco.
POWERSHELL_GLOBAL_COMMANDS = WORKSPACE_TRUST_GLOBAL_COMMANDS | frozenset([
    "runas", "gsudo", "format", "diskpart", "bcdedit", "restart-computer", "stop-computer", "format-volume",
    "clear-disk", "initialize-disk", "stop-service", "restart-service", "set-service"
])
# Lo que separa palabras dentro de un argumento que otra shell volvería a interpretar (sh -c '...').
_NESTED_WORD_SEPARATORS = re.compile(r"[\s;&|()<>`'\"]+")
WORKSPACE_TRUST_OUTSIDE_REFERENCE = re.compile(r"(?:^|[\s=:'\"])(?:[\\/~]|[A-Za-z]:[\\/])|\$|(?:^|[\s=:'\"\\/])\.\.(?=[\s\\/'\"]|$)")
_COMMAND_PATH_START = re.compile(r"^(?:[/\\]|(?:\.\.(?:$|[/\\]))|[A-Za-z]:[\\/])")
_COMMAND_INTERNAL_OUTSIDE_REF = re.compile(r"[\s:'\"](?:[\\/~]|[A-Za-z]:[\\/]|\.\.(?:$|[\s\\/]))")


def parse_directory_rule(raw_rule: str) -> dict | None:
    """Parsea una regla '<permisos>:path' (combinación sin repetidos de R, W, X) normalizando su ruta."""
    if not isinstance(raw_rule, str):
        return None
    match = DIRECTORY_RULE_PATTERN.match(raw_rule.strip())
    if not match:
        return None
    raw_access = match.group(1)
    if len(set(raw_access)) != len(raw_access):
        return None
    access = "".join(ch for ch in ("R", "W", "X") if ch in raw_access)
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
    powershell = COMMAND_SHELL == "powershell"
    if not isinstance(cmd, str):
        return None
    if powershell:
        cmd = cmd.translate(_POWERSHELL_QUOTES)
    if (POWERSHELL_SPLIT_UNSUPPORTED if powershell else SHELL_SPLIT_UNSUPPORTED).search(cmd):
        return None
    text = (POWERSHELL_SAFE_REDIRECTION_PATTERN if powershell else SAFE_REDIRECTION_PATTERN).sub(" ", cmd)
    segments, current, operator, quote, i = [], "", "", "", 0
    while i < len(text):
        ch = text[i]
        two = text[i:i + 2]
        if quote:
            # En PowerShell la \ no escapa: "C:\" cierra la comilla.
            if ch == "\\" and quote == '"' and not powershell:
                current += two
                i += 2
                continue
            quote = "" if ch == quote else quote
        elif ch == "\\" and not powershell:
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
        words = split_words(segment)
    except ValueError:
        return False
    if not words or words[0].lower() in SHELL_KEYWORDS:
        return False
    # Un cd tras variables ('x=1 cd /etc') o tras 'command' también cambia la carpeta: no se admite.
    rest = list(itertools.dropwhile(ENV_ASSIGNMENT.fullmatch, words))
    if rest[rest[:1] == ["command"]:][:1] == ["cd"] and not _is_cd(words[0]):
        return False
    return not _is_cd(words[0]) or (len(words) == 2 and not words[1].startswith("-") and not CD_UNSAFE_TARGET.search(words[1]))


def _is_cd(word: str) -> bool:
    """PowerShell no distingue mayúsculas en los nombres de órdenes: CD también cambia de carpeta."""
    return (word.lower() if COMMAND_SHELL == "powershell" else word) == "cd"


def split_words(segment: str) -> list[str]:
    """Palabras de un subcomando tal como las verá la shell de run_command, sin comillas; ValueError si queda una sin cerrar."""
    if COMMAND_SHELL != "powershell":
        return shlex.split(segment)
    text = segment.translate(_POWERSHELL_QUOTES)
    words, current, quote, in_word, i = [], "", "", False, 0
    while i < len(text):
        ch = text[i]
        if quote:
            if ch == quote and text[i + 1:i + 2] == quote:
                current += ch
                i += 2
                continue
            if ch == quote:
                quote = ""
            else:
                current += ch
        elif ch in "'\"":
            quote, in_word = ch, True
        elif ch.isspace():
            if in_word:
                words.append(current)
            current, in_word = "", False
        else:
            current, in_word = current + ch, True
        i += 1
    if quote:
        raise ValueError("Comillas sin cerrar.")
    if in_word:
        words.append(current)
    return words


def cd_target(segment: str) -> str | None:
    """Carpeta de un subcomando 'cd <dir>' ya validado por split_command, o None si no es un cd."""
    words = split_words(segment)
    return words[1] if _is_cd(words[0]) else None


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


def invokes_global_command(segment: str) -> bool:
    """
    Si el subcomando nombra una orden global en cualquier palabra, tal como la verá la shell: sin comillas
    ni escapes, por su nombre aunque vaya con ruta, y también dentro de un argumento que otra shell
    reinterpretaría (sh -c 'sudo ls'), sin distinguir mayúsculas ni .exe. Cualquier posición cuenta, así que
    también las que van tras env, command, nice o xargs. Un subcomando que no se puede partir cuenta como global.
    """
    try:
        tokens = split_words(segment)
    except ValueError:
        return True
    global_commands = POWERSHELL_GLOBAL_COMMANDS if COMMAND_SHELL == "powershell" else WORKSPACE_TRUST_GLOBAL_COMMANDS
    for token in tokens:
        for word in _NESTED_WORD_SEPARATORS.split(token):
            base = word.rsplit("/", 1)[-1]
            # Una \ es un escape para una shell anidada (sh -c 's\udo') o un separador de ruta en Windows.
            for name in (base.replace("\\", ""), base.rsplit("\\", 1)[-1]):
                name = name.lower().removesuffix(".exe")
                if name in global_commands or name.startswith("mkfs."):
                    return True
    return False


def is_workspace_local_command(segment: str) -> bool:
    """Filtro de Workspace Trust para un subcomando: sin órdenes globales ni referencias fuera del proyecto."""
    return not invokes_global_command(segment) and not WORKSPACE_TRUST_OUTSIDE_REFERENCE.search(segment)


def command_outside_references(segment: str) -> list[str] | None:
    """
    Rutas externas o con '..' que aparecen como argumentos del subcomando para validarlas frente a
    directoryRules; [] si es local al proyecto, o None si lleva órdenes globales, $, ~ o texto con
    rutas incrustadas no validables como argumento de ruta.
    """
    if is_workspace_local_command(segment):
        return []
    if invokes_global_command(segment) or "$" in segment or "~" in segment:
        return None
    try:
        tokens = split_words(segment)
    except ValueError:
        return None
    if not tokens:
        return None
    refs = []
    for token in tokens:
        if not WORKSPACE_TRUST_OUTSIDE_REFERENCE.search(token):
            continue
        candidate = token.split("=", 1)[1] if ("=" in token and not _COMMAND_PATH_START.match(token)) else token
        tail = candidate[2:] if re.match(r"^[A-Za-z]:[\\/]", candidate) else candidate[1:]
        if not _COMMAND_PATH_START.match(candidate) or _COMMAND_INTERNAL_OUTSIDE_REF.search(tail):
            return None
        refs.append(candidate)
    return refs


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
        args = split_words(command)
    except ValueError:
        return False
    if not words or len(args) < len(words) or (len(args) > len(words) and not rest):
        return False
    first = next((args[0][len(d):] for d in SYSTEM_BIN_DIRS if args[0].startswith(d)), args[0])
    for (regex, wildcard), arg in zip(words, [first, *args[1:]], strict=False):
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


def check_command_pattern_limit(global_patterns: list[str], project_patterns: list[str], other_project_count: int) -> None:
    """Comprueba que el total de patrones globales y de todos los proyectos no supere MAX_COMMAND_PATTERNS."""
    total = len(global_patterns) + len(project_patterns) + other_project_count
    if total > MAX_COMMAND_PATTERNS:
        raise ValueError(f"Hay {total} patrones de comando; el máximo es {MAX_COMMAND_PATTERNS}.")


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

# --- storage.obfuscation ---
"""Ofuscación simple de los secretos que el backend guarda en SQLite (API keys de los perfiles del servidor).

No es cifrado: la clave sale de este código, así que cualquiera que lo tenga recupera el secreto. Evita que una
clave se lea al abrir la base de datos o al buscar texto en el disco; la protección real son los permisos 0600 de
la carpeta de datos del usuario (docs/M75-apikeys.md).
"""



OBFUSCATION_PREFIX = "zc1:"
_OBFUSCATION_KEY = b"ZeroChat backend secret obfuscation v1"
_OBFUSCATION_NONCE_BYTES = 16


def _obfuscation_keystream(nonce: bytes, length: int) -> bytes:
    blocks = (hashlib.sha256(_OBFUSCATION_KEY + nonce + counter.to_bytes(4, "big")).digest()
              for counter in range((length + 31) // 32))
    return b"".join(blocks)[:length]


def obfuscate_secret(value: str) -> str:
    """El secreto tal como se guarda; vacío si no hay secreto. Un nonce aleatorio hace distintas dos copias iguales."""
    if not value:
        return ""
    data = value.encode("utf-8")
    nonce = secrets.token_bytes(_OBFUSCATION_NONCE_BYTES)
    mixed = bytes(a ^ b for a, b in zip(data, _obfuscation_keystream(nonce, len(data)), strict=True))
    return OBFUSCATION_PREFIX + base64.b64encode(nonce + mixed).decode("ascii")


def reveal_secret(stored: str) -> str:
    """El secreto original de lo guardado con obfuscate_secret; vacío si no hay secreto."""
    if not stored:
        return ""
    if not stored.startswith(OBFUSCATION_PREFIX):
        raise ValueError("El secreto guardado no tiene un formato válido")
    try:
        raw = base64.b64decode(stored[len(OBFUSCATION_PREFIX):], validate=True)
    except binascii.Error as exc:
        raise ValueError("El secreto guardado no tiene un formato válido") from exc
    nonce, mixed = raw[:_OBFUSCATION_NONCE_BYTES], raw[_OBFUSCATION_NONCE_BYTES:]
    if len(nonce) != _OBFUSCATION_NONCE_BYTES:
        raise ValueError("El secreto guardado no tiene un formato válido")
    return bytes(a ^ b for a, b in zip(mixed, _obfuscation_keystream(nonce, len(mixed)), strict=True)).decode("utf-8")

# --- storage.db ---
"""Almacenamiento local en SQLite (~/zerochat/storage/zerochat.db): perfiles del servidor, conversaciones, blobs y políticas de seguridad."""





# Persistencia local de zerochat.py con SQLite embebido para perfiles de conexión generales y conversaciones.
_STORAGE_LOCK = threading.RLock()
_INITIALIZED_DB: Path | None = None
READONLY_PROFILE_ID = "profile:mirror"
MIRROR_PROFILE_NAME = "Espejo"
MAX_PROFILE_NAME_LENGTH = 128
MAX_PROFILE_DESCRIPTION_LENGTH = 2048
MAX_CONVERSATION_ID_LENGTH = 128
MAX_CONVERSATION_TITLE_LENGTH = 256
# Identificador de agente de una conversación: <subconjunto>.<nombre>, dos niveles dentro de su proyecto.
MAX_AGENT_ID_LENGTH = 64
_AGENT_SEGMENT = r"[a-z0-9_-]+"
_AGENT_ID_PATTERN = re.compile(rf"{_AGENT_SEGMENT}\.{_AGENT_SEGMENT}")
# Patrón de watchAgents: todos los agentes del proyecto, los de un subconjunto o uno concreto.
_AGENT_WATCH_PATTERN = re.compile(rf"\*|{_AGENT_SEGMENT}\.(?:\*|{_AGENT_SEGMENT})")
MAX_BLOB_SIZE = 50 * 1024 * 1024
MAX_BLOB_HTTP_BYTES = 72 * 1024 * 1024
CONVERSATION_UPLOAD_TTL_SECONDS = 300
MAX_PENDING_CONVERSATION_UPLOADS = 16
MAX_STAGED_CONVERSATION_BYTES = 64 * 1024 * 1024
MAX_CONVERSATION_UPLOAD_CHUNKS = 512
_UPLOAD_ID_PATTERN = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")
_PENDING_CONVERSATION_UPLOADS: dict[str, dict] = {}


def _obfuscate_saved_api_keys(conn: sqlite3.Connection):
    """Las API keys de los perfiles del servidor, guardadas en claro hasta ahora, pasan a guardarse ofuscadas."""
    rows = conn.execute("SELECT id, api_key FROM profiles WHERE api_key != '';").fetchall()
    for row in rows:
        if not row["api_key"].startswith(OBFUSCATION_PREFIX):
            conn.execute("UPDATE profiles SET api_key = ? WHERE id = ?;", (obfuscate_secret(row["api_key"]), row["id"]))


def _strip_profile_mcp_and_browser(conn: sqlite3.Connection):
    """Retira `mcpServers` y `playwrightBrowser` de todos los perfiles: el entorno de ejecución pasa a definirse por proyecto."""
    rows = conn.execute("SELECT id, settings_json FROM profiles;").fetchall()
    for row in rows:
        try:
            settings = json.loads(row["settings_json"])
        except (json.JSONDecodeError, TypeError):
            continue
        if not isinstance(settings, dict):
            continue
        removed = any(key in settings for key in ("mcpServers", "playwrightBrowser"))
        if not removed:
            continue
        settings.pop("mcpServers", None)
        settings.pop("playwrightBrowser", None)
        conn.execute("UPDATE profiles SET settings_json = ? WHERE id = ?;", (json.dumps(settings), row["id"]))


# Cada migración es SQL o, si necesita código (ofuscar), una función que recibe la conexión.
STORAGE_MIGRATIONS: list[tuple[int, str, str | typing.Callable[[sqlite3.Connection], None]]] = [
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
    """),
    (6, "006_create_conversation_blobs_table", """
        CREATE TABLE IF NOT EXISTS conversation_blobs (
            conversation_id TEXT NOT NULL,
            blob_id TEXT NOT NULL,
            FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
            PRIMARY KEY (conversation_id, blob_id)
        );
        CREATE INDEX IF NOT EXISTS idx_conversation_blobs_blob_id ON conversation_blobs(blob_id);
        INSERT OR IGNORE INTO conversation_blobs (conversation_id, blob_id)
        SELECT DISTINCT messages.conversation_id, TRIM(json_extract(image.value, '$.blobId'))
        FROM messages, json_each(messages.extra_json, '$.images') AS image
        WHERE json_valid(messages.extra_json)
            AND json_extract(image.value, '$.blobId') IS NOT NULL
            AND TRIM(json_extract(image.value, '$.blobId')) != '';
    """),
    (7, "007_obfuscate_profile_api_keys", _obfuscate_saved_api_keys),
    (8, "008_create_secrets_table", """
        CREATE TABLE IF NOT EXISTS secrets (
            name TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
    """),
    (9, "009_strip_profile_mcp_and_browser", _strip_profile_mcp_and_browser),
    (10, "010_create_project_environments_table", """
        CREATE TABLE IF NOT EXISTS project_environments (
            project_key TEXT PRIMARY KEY,
            config_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
    """),
    (11, "011_create_settings_and_runs_tables", """
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS runs (
            conversation_id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            pid INTEGER,
            pid_start TEXT,
            started_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            status TEXT NOT NULL,
            step_text TEXT NOT NULL DEFAULT '',
            pending_json TEXT,
            error TEXT
        );
    """),
    (12, "012_split_security_policies_by_project", """
        DELETE FROM security_policies WHERE id = 'default';
    """),
    # La fila de una ejecución sigue al terminar bien: quien la lanzó lee en ella el final, la respuesta y los avisos.
    (13, "013_add_run_outcome_columns", """
        ALTER TABLE runs ADD COLUMN finished_at INTEGER;
        ALTER TABLE runs ADD COLUMN result_text TEXT;
        ALTER TABLE runs ADD COLUMN warnings_json TEXT;
    """),
    # Tokens que lleva gastados la ejecución (zerochat/run/usage), para quien la lanzó y el master que la vigila.
    (14, "014_add_run_usage_column", """
        ALTER TABLE runs ADD COLUMN usage_json TEXT;
    """),
]
# Tope de un secreto guardado (una API key cabe de sobra).
MAX_SECRET_LENGTH = 4096
# Herramienta de navegación de cada proyecto (sección Navegador de Ajustes).
BROWSER_TOOLS = ("none", "browser_action", "playwright")
PROJECT_ENVIRONMENT_FIELDS = ("systemDataPrompt", "enabledTools", "mcpServers", "browser", "activeRagBranchIds")
PROJECT_ENVIRONMENT_KEYS = frozenset(PROJECT_ENVIRONMENT_FIELDS)
MAX_PROJECT_PROMPT_LENGTH = 32768
MAX_PROJECT_MCP_SERVERS = 64
MAX_PROJECT_RAG_BRANCHES = 64
MAX_PROJECT_ENABLED_TOOLS = 256
MAX_PROJECT_TOOL_ID_LENGTH = 128


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
    db_path.chmod(0o600)
    for sidecar in (db_path.with_name(db_path.name + "-wal"), db_path.with_name(db_path.name + "-shm")):
        # SQLite borra los auxiliares WAL al cerrar la última conexión de otro proceso.
        with contextlib.suppress(FileNotFoundError):
            sidecar.chmod(0o600)


def _apply_migrations(conn: sqlite3.Connection):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at INTEGER NOT NULL,
            description TEXT NOT NULL
        );
    """)
    applied = {row["version"] for row in conn.execute("SELECT version FROM schema_migrations;").fetchall()}
    for version, description, migration in STORAGE_MIGRATIONS:
        if version not in applied:
            if callable(migration):
                migration(conn)
            else:
                conn.executescript(migration)
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


@contextlib.contextmanager
def _immediate_transaction(conn: sqlite3.Connection):
    """Transacción de escritura BEGIN IMMEDIATE sobre `conn`: COMMIT al salir y ROLLBACK si sale una excepción."""
    conn.isolation_level = None
    conn.execute("BEGIN IMMEDIATE;")
    try:
        yield conn
    except BaseException:
        conn.execute("ROLLBACK;")
        raise
    conn.execute("COMMIT;")


def normalize_profile_id(name: str, given_id: str | None = None) -> str:
    """Genera o normaliza un identificador único para el perfil."""
    if given_id and isinstance(given_id, str) and given_id.strip():
        clean = given_id.strip()
        return clean if clean.startswith("profile:") else f"profile:{clean}"
    clean_name = urllib.parse.quote(name.strip(), safe="-_.!~*'()")
    return f"profile:{clean_name}"


def _parse_optional_timestamp(value, field_name: str) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
        raise ValueError(f"{field_name} debe ser una marca de tiempo positiva")
    return int(value)


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
    """Transforma una fila SQLite en el objeto de perfil del servidor, sin su API key: solo `hasApiKey`.
    La clave la entrega get_general_profile_with_key al runner o bajo demanda con zerochat/profiles/reveal."""
    try:
        settings = json.loads(row["settings_json"])
    except (json.JSONDecodeError, TypeError):
        settings = {}
    settings.pop("apiKey", None)
    return {
        "id": row["id"],
        "name": row["name"],
        "description": row["description"] or "",
        "general": True,
        "hasApiKey": bool(row["api_key"]),
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


def get_general_profile_with_key(profile_id: str) -> dict | None:
    """El perfil del servidor con su API key en settings.apiKey (vacía si no tiene), o None si no existe."""
    if not profile_id or not isinstance(profile_id, str) or not profile_id.strip():
        return None
    with open_storage() as conn:
        row = conn.execute("SELECT * FROM profiles WHERE id = ?;", (normalize_profile_id("", profile_id),)).fetchone()
        if not row:
            return None
        profile = _row_to_profile(row)
        profile["settings"]["apiKey"] = reveal_secret(row["api_key"] or "")
        return profile


def get_general_profile_by_name(name: str) -> dict | None:
    """Recupera un perfil de servidor por su nombre."""
    if not name or not isinstance(name, str) or not name.strip():
        return None
    with open_storage() as conn:
        row = conn.execute("SELECT * FROM profiles WHERE name = ? COLLATE NOCASE;", (name.strip(),)).fetchone()
        return _row_to_profile(row) if row else None


def save_general_profile(record: dict) -> dict:
    """Guarda (crea o actualiza) un perfil en SQLite conservando el updatedAt de origen si se indica."""
    profile_id, name, description, settings, api_key = validate_profile_payload(record)
    now = int(time.time() * 1000)
    updated_at = _parse_optional_timestamp(record.get("updatedAt"), "updatedAt") or now
    created_at = _parse_optional_timestamp(record.get("createdAt"), "createdAt") or updated_at

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
            final_api_key = (existing["api_key"] or "") if api_key is None else obfuscate_secret(api_key)
            conn.execute("""
                UPDATE profiles
                SET name = ?, description = ?, settings_json = ?, api_key = ?, version = ?, updated_at = ?
                WHERE id = ?;
            """, (name, description, json.dumps(settings), final_api_key, version, updated_at, profile_id))
        else:
            conn.execute("""
                INSERT INTO profiles (id, name, description, settings_json, api_key, version, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, 1, ?, ?);
            """, (profile_id, name, description, json.dumps(settings), obfuscate_secret(api_key or ""), created_at, updated_at))

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


def _validate_conversation_id(session_id) -> str:
    if not isinstance(session_id, str) or not session_id.strip():
        raise ValueError("El identificador de la conversación no puede estar vacío")
    clean = session_id.strip()
    if len(clean) > MAX_CONVERSATION_ID_LENGTH:
        raise ValueError(f"El identificador no puede superar {MAX_CONVERSATION_ID_LENGTH} caracteres")
    return clean


def validate_agent_id(agent) -> str:
    """El identificador de agente <subconjunto>.<nombre> (minúsculas, cifras, _ y -), sin pasar de MAX_AGENT_ID_LENGTH."""
    if not isinstance(agent, str) or len(agent) > MAX_AGENT_ID_LENGTH or not _AGENT_ID_PATTERN.fullmatch(agent):
        raise ValueError(f"agent debe ser <subconjunto>.<nombre> con minúsculas, cifras, _ o - y hasta {MAX_AGENT_ID_LENGTH} caracteres")
    return agent


def validate_agent_watch_pattern(pattern) -> str:
    """Un patrón de watchAgents: '*', '<subconjunto>.*' o '<subconjunto>.<nombre>', con el tope de un identificador."""
    if not isinstance(pattern, str) or len(pattern) > MAX_AGENT_ID_LENGTH or not _AGENT_WATCH_PATTERN.fullmatch(pattern):
        raise ValueError("watchAgents admite '*', '<subconjunto>.*' o '<subconjunto>.<nombre>'")
    return pattern


def agent_matches(agent, patterns) -> bool:
    """Si el agente de una conversación lo cubre alguno de los patrones de watchAgents; una sin agente, nunca."""
    if not isinstance(agent, str) or not agent:
        return False
    return any(pattern in ("*", agent) or (pattern.endswith(".*") and agent.startswith(pattern[:-1])) for pattern in patterns)


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
    if extra.get("agent"):
        header["agent"] = extra["agent"]
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


def get_conversation_updated_at(session_id: str) -> int | None:
    """Fecha de la última grabación de la conversación, sin leer sus mensajes; None si no existe."""
    clean_id = _validate_conversation_id(session_id)
    with open_storage() as conn:
        row = conn.execute("SELECT updated_at FROM conversations WHERE id = ?;", (clean_id,)).fetchone()
        return int(row["updated_at"]) if row else None


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


def _extract_message_blob_ids(messages: list[dict]) -> set[str]:
    """Extrae los identificadores de blob no vacíos referenciados por las imágenes de los mensajes."""
    blob_ids: set[str] = set()
    for msg in messages:
        images = msg.get("images")
        if not isinstance(images, list):
            continue
        for image in images:
            if isinstance(image, dict):
                blob_id = image.get("blobId")
                if isinstance(blob_id, str) and blob_id.strip():
                    blob_ids.add(blob_id.strip())
    return blob_ids


def _delete_orphan_blobs(conn: sqlite3.Connection, candidates: set[str]):
    """Elimina de `blobs` los candidatos que ya no referencia ninguna conversación."""
    if not candidates:
        return
    candidate_list = list(candidates)
    still_used: set[str] = set()
    for start in range(0, len(candidate_list), 500):
        batch = candidate_list[start:start + 500]
        marks = ",".join("?" for _ in batch)
        rows = conn.execute(
            f"SELECT DISTINCT blob_id FROM conversation_blobs WHERE blob_id IN ({marks});",  # noqa: S608
            batch,
        ).fetchall()
        still_used.update(row["blob_id"] for row in rows)
    orphans = [(blob_id,) for blob_id in candidates - still_used]
    if orphans:
        conn.executemany("DELETE FROM blobs WHERE id = ?;", orphans)


def _conversation_extra(session_meta: dict) -> dict:
    """Campos de extra_json que trae la petición: el perfil, el modo servidor, el proyecto y el agente."""
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
    if session_meta.get("agent") is not None:
        extra["agent"] = validate_agent_id(session_meta["agent"])
    if isinstance(session_meta.get("launch"), dict):
        extra["launch"] = session_meta["launch"]
    return extra


def _merge_saved_header(existing, session_meta: dict, created_at: int, title: str, extra: dict) -> tuple[int, str, dict]:
    """Completa la cabecera con la guardada: su fecha de creación y su título si la petición no los trae, y su
    extra_json debajo del nuevo. El proyecto y el agente se fijan al crear la conversación; cuando guarda la interfaz
    (sin `launch` en `session_meta`) una conversación de agente conserva también su `launch` y su `profile_id`."""
    if not session_meta.get("createdAt") and existing["created_at"]:
        created_at = int(existing["created_at"])
    if not title and existing["title"]:
        title = existing["title"]
    existing_extra = json.loads(existing["extra_json"]) if existing["extra_json"] else {}
    extra = {**existing_extra, **extra}
    if existing_extra.get("project"):
        extra["project"] = existing_extra["project"]
    extra.pop("agent", None)
    if existing_extra.get("agent"):
        extra["agent"] = existing_extra["agent"]
        if "launch" not in session_meta and existing_extra.get("profile_id"):
            extra["profile_id"] = existing_extra["profile_id"]
    return created_at, title, extra


def _replace_messages(conn: sqlite3.Connection, session_id: str, messages: list[dict]):
    conn.execute("DELETE FROM messages WHERE conversation_id = ?;", (session_id,))
    for pos, msg in enumerate(messages):
        msg_id = str(msg.get("id") or "").strip() or f"msg_{session_id}_{pos}"
        role = str(msg.get("role") or "user").strip()
        content = "" if msg.get("content") is None else str(msg.get("content"))
        extra = {k: v for k, v in msg.items() if k not in ("id", "role", "content", "conversationId", "position")}
        conn.execute("""
            INSERT INTO messages (conversation_id, position, id, role, content, extra_json)
            VALUES (?, ?, ?, ?, ?, ?);
        """, (session_id, pos, msg_id, role, content, json.dumps(extra) if extra else "{}"))


def _replace_conversation_blobs(conn: sqlite3.Connection, session_id: str, blob_ids: set[str]):
    """Sustituye los blobs que referencia la conversación y borra los que ya no referencia nadie."""
    old_blob_ids = {
        row["blob_id"]
        for row in conn.execute("SELECT blob_id FROM conversation_blobs WHERE conversation_id = ?;", (session_id,))
    }
    conn.execute("DELETE FROM conversation_blobs WHERE conversation_id = ?;", (session_id,))
    if blob_ids:
        conn.executemany(
            "INSERT OR IGNORE INTO conversation_blobs (conversation_id, blob_id) VALUES (?, ?);",
            [(session_id, blob_id) for blob_id in blob_ids],
        )
    _delete_orphan_blobs(conn, old_blob_ids - blob_ids)


def save_conversation(session_meta: dict, messages: list[dict] | None = None) -> dict:
    """Guarda o actualiza una conversación y sustituye sus mensajes atómicamente."""
    if not isinstance(session_meta, dict):
        raise ValueError("Los metadatos de la conversación deben ser un objeto")
    if messages is None:
        messages = []
    if not isinstance(messages, list):
        raise ValueError("Los mensajes de la conversación deben ser una lista")
    if not all(isinstance(msg, dict) for msg in messages):
        raise ValueError("Cada mensaje debe ser un objeto")
    new_blob_ids = _extract_message_blob_ids(messages)

    session_id = _validate_conversation_id(session_meta.get("id"))
    raw_title = session_meta.get("title")
    title = _validate_conversation_title("" if raw_title is None else raw_title, allow_empty=True)

    now = int(time.time() * 1000)
    created_at = int(session_meta.get("createdAt") or now)
    updated_at = int(session_meta.get("updatedAt") or now)
    # extra_json guarda el perfil, el modo servidor, el proyecto y el agente; la cabecera los expone como campos propios.
    extra = _conversation_extra(session_meta)

    with open_storage() as conn:
        existing = conn.execute("SELECT created_at, extra_json, title FROM conversations WHERE id = ?;", (session_id,)).fetchone()
        if existing:
            created_at, title, extra = _merge_saved_header(existing, session_meta, created_at, title, extra)
        conn.execute("""
            INSERT INTO conversations (id, title, created_at, updated_at, message_count, extra_json)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                title = excluded.title,
                updated_at = excluded.updated_at,
                message_count = excluded.message_count,
                extra_json = excluded.extra_json;
        """, (session_id, title, created_at, updated_at, len(messages), json.dumps(extra, ensure_ascii=False) if extra else "{}"))
        _replace_messages(conn, session_id, messages)
        _replace_conversation_blobs(conn, session_id, new_blob_ids)
        conn.commit()
        row = conn.execute("SELECT * FROM conversations WHERE id = ?;", (session_id,)).fetchone()
        saved = _row_to_conversation_header(row)
    notify_live_change()
    return saved


def _validate_int_in_range(value, name: str, min_value: int, max_value: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{name} debe ser un entero")
    if value < min_value or value > max_value:
        raise ValueError(f"{name} fuera de rango ({min_value}..{max_value})")
    return value


def _validate_upload_id(upload_id) -> str:
    if not isinstance(upload_id, str) or not _UPLOAD_ID_PATTERN.fullmatch(upload_id):
        raise ValueError("uploadId no válido")
    return upload_id


def _purge_expired_conversation_uploads(now: float):
    expired = [
        uid for uid, entry in _PENDING_CONVERSATION_UPLOADS.items()
        if now - entry["updated_at"] > CONVERSATION_UPLOAD_TTL_SECONDS
    ]
    for uid in expired:
        del _PENDING_CONVERSATION_UPLOADS[uid]


def _parse_chunk_payload(messages, message_part) -> tuple[int, list[dict] | None, tuple | None]:
    if messages is not None and message_part is not None:
        raise ValueError("No se puede combinar messages y messagePart")
    if messages is None and message_part is None:
        raise ValueError("Cada tramo debe incluir messages o messagePart")
    if messages is not None:
        if not isinstance(messages, list) or not all(isinstance(msg, dict) for msg in messages):
            raise ValueError("Los mensajes del tramo deben ser una lista de objetos")
        return len(json.dumps(messages, ensure_ascii=False).encode("utf-8")), messages, None
    if not isinstance(message_part, dict):
        raise ValueError("messagePart debe ser un objeto")
    total_parts = _validate_int_in_range(message_part.get("totalParts"), "totalParts", 1, MAX_CONVERSATION_UPLOAD_CHUNKS)
    part_index = _validate_int_in_range(message_part.get("partIndex"), "partIndex", 0, total_parts - 1)
    content = message_part.get("content")
    if not isinstance(content, str):
        raise ValueError("content de messagePart debe ser texto")
    msg_shell = message_part.get("message")
    if part_index == 0 and not isinstance(msg_shell, dict):
        raise ValueError("El primer fragmento debe incluir message")
    if part_index > 0 and msg_shell is not None:
        raise ValueError("Solo el primer fragmento debe incluir message")
    shell_bytes = len(json.dumps(msg_shell, ensure_ascii=False).encode("utf-8")) if part_index == 0 else 0
    return len(content.encode("utf-8")) + shell_bytes, None, (part_index, total_parts, content, msg_shell)


def _acquire_conversation_upload_entry(
    upload_id: str,
    conv_id: str,
    chunk_index: int,
    total_chunks: int,
    chunk_bytes: int,
    part_info: tuple | None,
    now: float,
) -> dict:
    staged_bytes = sum(item["bytes"] for item in _PENDING_CONVERSATION_UPLOADS.values())
    if staged_bytes + chunk_bytes > MAX_STAGED_CONVERSATION_BYTES:
        raise ValueError("Se superó el límite temporal de subida de conversaciones")
    if chunk_index == 0:
        if upload_id in _PENDING_CONVERSATION_UPLOADS:
            raise ValueError("uploadId ya existe")
        if len(_PENDING_CONVERSATION_UPLOADS) >= MAX_PENDING_CONVERSATION_UPLOADS:
            raise ValueError("Demasiadas subidas de conversación en curso")
        if part_info is not None and part_info[0] != 0:
            raise ValueError("El primer fragmento de un mensaje parcial debe tener partIndex 0")
        entry = {
            "conversation_id": conv_id,
            "total_chunks": total_chunks,
            "next_index": 0,
            "messages": [],
            "partial_message": None,
            "bytes": 0,
            "updated_at": now,
        }
        _PENDING_CONVERSATION_UPLOADS[upload_id] = entry
        return entry
    entry = _PENDING_CONVERSATION_UPLOADS.get(upload_id)
    if not entry:
        raise ValueError("Subida de conversación no encontrada o caducada")
    if entry["conversation_id"] != conv_id or entry["total_chunks"] != total_chunks:
        raise ValueError("La cabecera del tramo no coincide con la subida")
    if entry["next_index"] != chunk_index:
        raise ValueError("Tramo de conversación fuera de orden")
    return entry


def _apply_chunk_message_part(entry: dict, part_info: tuple):
    part_index, total_parts, content, msg_shell = part_info
    if part_index == 0:
        if entry["partial_message"] is not None:
            raise ValueError("Ya hay un mensaje parcial en curso")
        entry["partial_message"] = {
            "message": dict(msg_shell),
            "parts": [content],
            "next_part": 1,
            "total_parts": total_parts,
        }
    else:
        partial = entry["partial_message"]
        if not partial or partial["total_parts"] != total_parts or partial["next_part"] != part_index:
            raise ValueError("Fragmento de mensaje fuera de orden")
        partial["parts"].append(content)
        partial["next_part"] += 1
    partial = entry["partial_message"]
    if partial and partial["next_part"] == partial["total_parts"]:
        full_msg = dict(partial["message"])
        full_msg["content"] = "".join(partial["parts"])
        entry["messages"].append(full_msg)
        entry["partial_message"] = None


def save_conversation_chunk(params: dict) -> dict:
    """Almacena temporalmente un tramo de mensajes de una conversación para su guardado atómico final."""
    if not isinstance(params, dict):
        raise ValueError("Los parámetros deben ser un objeto")
    upload_id = _validate_upload_id(params.get("uploadId"))
    conv_id = _validate_conversation_id(params.get("conversationId"))
    total_chunks = _validate_int_in_range(params.get("totalChunks"), "totalChunks", 1, MAX_CONVERSATION_UPLOAD_CHUNKS)
    chunk_index = _validate_int_in_range(params.get("chunkIndex"), "chunkIndex", 0, total_chunks - 1)
    chunk_bytes, messages, part_info = _parse_chunk_payload(params.get("messages"), params.get("messagePart"))

    with _STORAGE_LOCK:
        now = time.monotonic()
        _purge_expired_conversation_uploads(now)
        entry = _acquire_conversation_upload_entry(
            upload_id, conv_id, chunk_index, total_chunks, chunk_bytes, part_info, now
        )
        if messages is not None:
            if entry["partial_message"] is not None:
                raise ValueError("Faltan fragmentos del mensaje parcial anterior")
            entry["messages"].extend(messages)
        elif part_info is not None:
            _apply_chunk_message_part(entry, part_info)
        entry["next_index"] = chunk_index + 1
        entry["bytes"] += chunk_bytes
        entry["updated_at"] = now
        return {"ok": True, "uploadId": upload_id, "receivedChunks": entry["next_index"]}


def cancel_conversation_upload(params: dict) -> dict:
    """Libera la subida por tramos pendiente de una conversación (un tramo falló y no se va a consolidar)."""
    if not isinstance(params, dict):
        raise ValueError("Los parámetros deben ser un objeto")
    upload_id = _validate_upload_id(params.get("uploadId"))
    conv_id = _validate_conversation_id(params.get("conversationId"))
    with _STORAGE_LOCK:
        entry = _PENDING_CONVERSATION_UPLOADS.get(upload_id)
        if not entry or entry["conversation_id"] != conv_id:
            return {"cancelled": False}
        del _PENDING_CONVERSATION_UPLOADS[upload_id]
    return {"cancelled": True}


def commit_conversation_upload(session_meta: dict, upload_id: str) -> dict:
    """Consolida atómicamente en SQLite una conversación subida por tramos."""
    if not isinstance(session_meta, dict):
        raise ValueError("Los metadatos de la conversación deben ser un objeto")
    session_id = _validate_conversation_id(session_meta.get("id"))
    clean_upload_id = _validate_upload_id(upload_id)
    with _STORAGE_LOCK:
        _purge_expired_conversation_uploads(time.monotonic())
        entry = _PENDING_CONVERSATION_UPLOADS.get(clean_upload_id)
        if not entry:
            raise ValueError("Subida de conversación no encontrada o caducada")
        if entry["conversation_id"] != session_id:
            raise ValueError("La conversación no coincide con la subida")
        if entry["next_index"] != entry["total_chunks"] or entry["partial_message"] is not None:
            raise ValueError("La subida de conversación está incompleta")
        messages = _PENDING_CONVERSATION_UPLOADS.pop(clean_upload_id)["messages"]
    return save_conversation(session_meta, messages)


def _patch_conversation_extra(session_id: str, patch: dict) -> bool:
    """Añade campos al extra_json de una conversación que existe; False si no existe o no se pudo guardar."""
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
            cur_extra.update(patch)
            conn.execute("UPDATE conversations SET extra_json = ? WHERE id = ?;", (json.dumps(cur_extra, ensure_ascii=False), clean_id))
            conn.commit()
    except (sqlite3.Error, OSError, json.JSONDecodeError):
        return False
    notify_live_change()
    return True


def mark_conversation_server_run(session_id: str, profile_name: str | None = None) -> bool:
    """Marca la conversación en SQLite como ejecutada en servidor asociándole el perfil."""
    patch: dict = {"server_run": True}
    if profile_name:
        patch["profile_id"] = str(profile_name).strip()
    return _patch_conversation_extra(session_id, patch)


def get_conversation_launch(session_id: str) -> dict | None:
    """La petición de lanzamiento guardada de una conversación de agente, o None si no la tiene."""
    clean_id = _validate_conversation_id(session_id)
    with open_storage() as conn:
        row = conn.execute("SELECT extra_json FROM conversations WHERE id = ?;", (clean_id,)).fetchone()
    extra = json.loads(row["extra_json"]) if row and row["extra_json"] else {}
    launch = extra.get("launch")
    return launch if isinstance(launch, dict) else None


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
        changed = cursor.rowcount > 0
    if changed:
        notify_live_change()
    return changed


def _delete_conversations_in_transaction(conn: sqlite3.Connection, where: str, params: tuple) -> list[str]:
    """Borra, dentro de la transacción abierta de `conn`, las conversaciones que cumplen `where` y sus blobs huérfanos."""
    ids = [row["id"] for row in conn.execute(f"SELECT id FROM conversations WHERE {where};", params)]  # noqa: S608
    if ids:
        marks = ",".join("?" for _ in ids)
        candidates = {
            row["blob_id"]
            for row in conn.execute(
                f"SELECT DISTINCT blob_id FROM conversation_blobs WHERE conversation_id IN ({marks});",  # noqa: S608
                ids,
            )
        }
        conn.execute(f"DELETE FROM conversations WHERE id IN ({marks});", ids)  # noqa: S608
        _delete_orphan_blobs(conn, candidates)
    return ids


def _delete_conversations(conn: sqlite3.Connection, where: str, params: tuple) -> list[str]:
    """
    Borra en una transacción las conversaciones que cumplen `where`, con sus mensajes en cascada, y los
    blobs que solo ellas referenciaban. Solo se consideran los blobs de las conversaciones borradas: uno
    subido para una conversación que aún no se ha guardado no se toca.
    """
    with _immediate_transaction(conn):
        ids = _delete_conversations_in_transaction(conn, where, params)
    if ids:
        notify_live_change()
    return ids


def delete_conversation(session_id: str) -> bool:
    """Elimina una conversación con sus mensajes y los blobs que solo ella usaba."""
    clean_id = _validate_conversation_id(session_id)
    with open_storage() as conn:
        return bool(_delete_conversations(conn, "id = ?", (clean_id,)))


def delete_conversations(project: str | None, agents: bool) -> list[str]:
    """
    Borra en bloque un historial con sus mensajes y blobs propios: las conversaciones de agentes (`agents`) o los
    chats, de un proyecto (vacío para la carpeta general) o de todos (`project` None). Nunca los dos a la vez.
    """
    if not isinstance(agents, bool):
        raise ValueError("agents debe ser un booleano")
    where = [f"json_extract(extra_json, '$.agent') IS {'NOT ' if agents else ''}NULL"]
    params: tuple = ()
    if project is not None:
        if not isinstance(project, str) or (project and not project.strip()) or len(project) > MAX_PATH_LENGTH:
            raise ValueError("El proyecto de las conversaciones debe ser una ruta")
        if project.strip():
            where.append("json_extract(extra_json, '$.project') = ?")
            params = (project.strip(),)
        else:
            where.append("(json_extract(extra_json, '$.project') IS NULL OR json_extract(extra_json, '$.project') = '')")
    with open_storage() as conn:
        return _delete_conversations(conn, " AND ".join(where), params)


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
        rows = conn.execute(f"SELECT id FROM blobs WHERE id IN ({placeholders});", unique_ids).fetchall()  # noqa: S608
        existing_set = {row["id"] for row in rows}
        return {
            "existing": [bid for bid in unique_ids if bid in existing_set],
            "missing": [bid for bid in unique_ids if bid not in existing_set],
        }


GLOBAL_SECURITY_POLICY_ID = "global"
# Prefijo único de lo guardado por proyecto: la fila de políticas es `project:<key>` y cada secreto `project:<key>:<NOMBRE>`.
PROJECT_KEY_PREFIX = "project:"


def clean_project_key(project_key) -> str:
    """Clave de proyecto sin espacios alrededor; vacía es un error."""
    clean_key = str(project_key or "").strip()
    if not clean_key:
        raise ValueError("project_key es obligatorio")
    return clean_key


def project_security_policy_id(project_key: str) -> str:
    """Clave de fila en `security_policies` para un proyecto concreto."""
    return f"{PROJECT_KEY_PREFIX}{clean_project_key(project_key)}"


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


def _upsert_security_policy_row(conn: sqlite3.Connection, row_id: str, data: dict, now: int) -> None:
    conn.execute("""
        INSERT INTO security_policies (id, data_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            data_json = excluded.data_json,
            updated_at = excluded.updated_at;
    """, (row_id, json.dumps(data, ensure_ascii=False), now))


def _count_other_project_patterns(conn: sqlite3.Connection, excluded_id: str) -> int:
    rows = conn.execute(
        "SELECT data_json FROM security_policies WHERE substr(id, 1, ?) = ? AND id != ?;",
        (len(PROJECT_KEY_PREFIX), PROJECT_KEY_PREFIX, excluded_id),
    ).fetchall()
    total = 0
    for row in rows:
        parsed = _parse_security_policy_row(row)
        if parsed and isinstance(parsed.get("commandPatterns"), list):
            total += len(parsed["commandPatterns"])
    return total


def get_security_policy_data(project_key: str) -> tuple[dict | None, dict | None]:
    """Recupera de SQLite las políticas globales y las del proyecto (None si aún no existen)."""
    proj_id = project_security_policy_id(project_key)
    with open_storage() as conn:
        global_row = conn.execute("SELECT data_json FROM security_policies WHERE id = ?;", (GLOBAL_SECURITY_POLICY_ID,)).fetchone()
        proj_row = conn.execute("SELECT data_json FROM security_policies WHERE id = ?;", (proj_id,)).fetchone()
        return _parse_security_policy_row(global_row), _parse_security_policy_row(proj_row)


def update_security_policy_data(
    project_key: str,
    mutator: typing.Callable[[dict | None, dict | None, int], tuple[dict, dict | None]],
) -> tuple[dict, dict | None]:
    """Ejecuta una lectura-modificación-escritura atómica sobre la fila global y la del proyecto en BEGIN IMMEDIATE."""
    proj_id = project_security_policy_id(project_key)
    with open_storage() as conn:
        with _immediate_transaction(conn):
            global_row = conn.execute("SELECT data_json FROM security_policies WHERE id = ?;", (GLOBAL_SECURITY_POLICY_ID,)).fetchone()
            proj_row = conn.execute("SELECT data_json FROM security_policies WHERE id = ?;", (proj_id,)).fetchone()
            other_pattern_count = _count_other_project_patterns(conn, proj_id)
            new_global, new_project = mutator(
                _parse_security_policy_row(global_row),
                _parse_security_policy_row(proj_row),
                other_pattern_count,
            )
            now = int(time.time() * 1000)
            _upsert_security_policy_row(conn, GLOBAL_SECURITY_POLICY_ID, new_global, now)
            if new_project is None:
                conn.execute("DELETE FROM security_policies WHERE id = ?;", (proj_id,))
            else:
                _upsert_security_policy_row(conn, proj_id, new_project, now)
            return new_global, new_project


def _write_secret_on_conn(conn: sqlite3.Connection, name: str, value: str, now: int):
    conn.execute("""
        INSERT INTO secrets (name, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
    """, (name, obfuscate_secret(value), now))


def save_secret(name: str, value: str):
    """Guarda ofuscado el secreto `name` (por ejemplo mcp:<servicio>:<VARIABLE>); nunca se devuelve a la interfaz."""
    if not isinstance(value, str) or not value.strip():
        raise ValueError("El secreto no puede estar vacío")
    if len(value) > MAX_SECRET_LENGTH:
        raise ValueError(f"El secreto no puede superar {MAX_SECRET_LENGTH} caracteres")
    with open_storage() as conn:
        _write_secret_on_conn(conn, name, value.strip(), int(time.time() * 1000))
        conn.commit()


def delete_secret(name: str) -> bool:
    with open_storage() as conn:
        cursor = conn.execute("DELETE FROM secrets WHERE name = ?;", (name,))
        conn.commit()
        return cursor.rowcount > 0


def get_setting(key: str):
    """Lee un ajuste JSON guardado en la tabla `settings`; None si no existe."""
    with open_storage() as conn:
        row = conn.execute("SELECT value_json FROM settings WHERE key = ?;", (key,)).fetchone()
        if not row:
            return None
        return json.loads(row["value_json"])


def _write_setting_on_conn(conn: sqlite3.Connection, key: str, value, now: int):
    conn.execute("""
        INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at;
    """, (key, json.dumps(value, ensure_ascii=False), now))


def set_setting(key: str, value, *, secret_name: str | None = None, secret: str = "") -> None:
    """Guarda un ajuste JSON en `settings`; con `secret_name`, guarda (o borra si va vacío) en la misma transacción su secreto ofuscado."""
    now = int(time.time() * 1000)
    with open_storage() as conn:
        with _immediate_transaction(conn):
            _write_setting_on_conn(conn, key, value, now)
            if secret_name and secret:
                _write_secret_on_conn(conn, secret_name, secret, now)
            elif secret_name:
                conn.execute("DELETE FROM secrets WHERE name = ?;", (secret_name,))


def _json_column(raw):
    if not raw:
        return None
    try:
        return json.loads(raw)
    except (ValueError, TypeError):
        return None


def _row_to_run_state(row: sqlite3.Row) -> dict:
    return {
        "run_id": row["run_id"],
        "conversation_id": row["conversation_id"],
        "pid": row["pid"],
        "pid_start": row["pid_start"],
        "started_at": row["started_at"],
        "updated_at": row["updated_at"],
        "status": row["status"],
        "step_text": row["step_text"] or "",
        "pending": _json_column(row["pending_json"]),
        "error": row["error"],
        "finished_at": row["finished_at"],
        "result_text": row["result_text"],
        "warnings": _json_column(row["warnings_json"]) or [],
        "usage": _json_column(row["usage_json"]),
    }


def upsert_run_state(payload: dict) -> None:
    """Guarda o actualiza en SQLite el estado de una ejecución; los campos de su final son opcionales (una que empieza)."""
    conv_id = _validate_conversation_id(payload["conversation_id"])
    pending = payload["pending"]
    pending_json = json.dumps(pending, ensure_ascii=False) if pending is not None else None
    warnings = payload.get("warnings")
    warnings_json = json.dumps(warnings, ensure_ascii=False) if warnings else None
    usage = payload.get("usage")
    usage_json = json.dumps(usage, ensure_ascii=False) if usage else None
    with open_storage() as conn:
        conn.execute("""
            INSERT INTO runs (conversation_id, run_id, pid, pid_start, started_at, updated_at, status, step_text, pending_json, error,
                              finished_at, result_text, warnings_json, usage_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(conversation_id) DO UPDATE SET
                run_id = excluded.run_id,
                pid = excluded.pid,
                pid_start = excluded.pid_start,
                started_at = excluded.started_at,
                updated_at = excluded.updated_at,
                status = excluded.status,
                step_text = excluded.step_text,
                pending_json = excluded.pending_json,
                error = excluded.error,
                finished_at = excluded.finished_at,
                result_text = excluded.result_text,
                warnings_json = excluded.warnings_json,
                usage_json = excluded.usage_json;
        """, (
            conv_id,
            payload["run_id"],
            payload["pid"],
            payload["pid_start"],
            payload["started_at"],
            payload["updated_at"],
            payload["status"],
            payload["step_text"] or "",
            pending_json,
            payload["error"],
            payload.get("finished_at"),
            payload.get("result_text"),
            warnings_json,
            usage_json,
        ))
        conn.commit()
    notify_live_change()


def delete_orphan_run_states() -> list[str]:
    """Borra las filas de runs que ya no están en marcha y cuya conversación no existe (una ejecución que falló antes
    de guardarla); devuelve sus conversation_id. Las que siguen en marcha se conservan: su agente aún no la ha guardado."""
    with open_storage() as conn:
        with _immediate_transaction(conn):
            ids = [row["conversation_id"] for row in conn.execute(
                "SELECT conversation_id FROM runs WHERE status != 'running' "
                "AND conversation_id NOT IN (SELECT id FROM conversations);")]
            if ids:
                conn.executemany("DELETE FROM runs WHERE conversation_id = ?;", [(conv_id,) for conv_id in ids])
    if ids:
        notify_live_change()
    return ids


def get_run_state(conversation_id: str) -> dict | None:
    """Recupera de SQLite el estado en vivo de la ejecución de una conversación."""
    clean_id = _validate_conversation_id(conversation_id)
    with open_storage() as conn:
        row = conn.execute("SELECT * FROM runs WHERE conversation_id = ?;", (clean_id,)).fetchone()
        return _row_to_run_state(row) if row else None


def list_run_states() -> list[dict]:
    """Lista todas las ejecuciones registradas en SQLite ordenadas por inicio."""
    with open_storage() as conn:
        rows = conn.execute("SELECT * FROM runs ORDER BY started_at ASC, conversation_id ASC;").fetchall()
        return [_row_to_run_state(row) for row in rows]


def delete_run_state(conversation_id: str) -> bool:
    """Elimina de SQLite el estado de la ejecución de una conversación."""
    clean_id = _validate_conversation_id(conversation_id)
    with open_storage() as conn:
        cursor = conn.execute("DELETE FROM runs WHERE conversation_id = ?;", (clean_id,))
        conn.commit()
        deleted = cursor.rowcount > 0
    if deleted:
        notify_live_change()
    return deleted


def get_secret(name: str) -> str | None:
    """El secreto original, para quien lo usa en el backend (el arranque de un servicio); None si no está guardado."""
    with open_storage() as conn:
        row = conn.execute("SELECT value FROM secrets WHERE name = ?;", (name,)).fetchone()
        return reveal_secret(row["value"]) if row else None


def secret_names(prefix: str) -> set[str]:
    """Nombres de los secretos guardados que empiezan por `prefix`, sin leer sus valores."""
    with open_storage() as conn:
        rows = conn.execute("SELECT name FROM secrets WHERE substr(name, 1, ?) = ?;", (len(prefix), prefix)).fetchall()
        return {row["name"] for row in rows}


SERVER_ID_KEY = "system:server_id"


def conversations_revision() -> str:
    """Firma ligera del estado de conversaciones en SQLite para detectar cambios externos."""
    with open_storage() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS n, COALESCE(MAX(updated_at), 0) AS m, COALESCE(SUM(updated_at), 0) AS s FROM conversations;"
        ).fetchone()
        return f"{row['n']}:{row['m']}:{int(row['s'])}"


def get_server_id() -> str:
    """Identificador único y persistente de este servidor en SQLite."""
    with _STORAGE_LOCK:
        existing = get_secret(SERVER_ID_KEY)
        if existing:
            return existing
        server_id = str(uuid.uuid4())
        save_secret(SERVER_ID_KEY, server_id)
        return server_id


def _empty_project_environment() -> dict:
    return {
        "systemDataPrompt": None,
        "enabledTools": {},
        "mcpServers": [],
        "browser": "browser_action",
        "activeRagBranchIds": [],
        "saved": False,
        "updatedAt": 0,
    }


def _clean_project_tool_id(raw, label: str) -> str:
    if not isinstance(raw, str):
        raise ValueError(f"{label} debe ser un texto")
    clean = raw.strip()
    if not clean or len(clean) > MAX_PROJECT_TOOL_ID_LENGTH:
        raise ValueError(f"{label} debe tener entre 1 y {MAX_PROJECT_TOOL_ID_LENGTH} caracteres")
    return clean


def validate_project_prompt(prompt) -> str | None:
    """systemDataPrompt de un proyecto (o de --run-file): texto acotado sin espacios alrededor, o None."""
    if prompt is None:
        return None
    if not isinstance(prompt, str):
        raise ValueError("systemDataPrompt debe ser texto o null")
    clean = prompt.strip()
    if len(clean) > MAX_PROJECT_PROMPT_LENGTH:
        raise ValueError(f"systemDataPrompt no puede superar {MAX_PROJECT_PROMPT_LENGTH} caracteres")
    return clean


def _validate_enabled_tools(tools) -> dict[str, bool]:
    if not isinstance(tools, dict):
        raise ValueError("enabledTools debe ser un objeto")
    if len(tools) > MAX_PROJECT_ENABLED_TOOLS:
        raise ValueError(f"enabledTools no puede superar {MAX_PROJECT_ENABLED_TOOLS} herramientas")
    clean_tools: dict[str, bool] = {}
    for key, value in tools.items():
        clean_key = _clean_project_tool_id(key, "enabledTools")
        if not isinstance(value, bool):
            raise ValueError(f"El estado de '{clean_key}' debe ser un booleano")
        clean_tools[clean_key] = value
    return clean_tools


def _validate_project_id_list(raw, label: str, max_items: int) -> list[str]:
    if not isinstance(raw, list):
        raise ValueError(f"{label} debe ser una lista")
    unique_items = list(dict.fromkeys(_clean_project_tool_id(item, label) for item in raw))
    if len(unique_items) > max_items:
        raise ValueError(f"Un proyecto no puede tener más de {max_items} entradas en {label}")
    return unique_items


def _validate_project_browser(browser) -> str:
    if browser not in BROWSER_TOOLS:
        raise ValueError(f"browser debe ser uno de: {', '.join(BROWSER_TOOLS)}")
    return browser


_PROJECT_ENV_VALIDATORS = {
    "systemDataPrompt": validate_project_prompt,
    "enabledTools": _validate_enabled_tools,
    "mcpServers": lambda raw: _validate_project_id_list(raw, "mcpServers", MAX_PROJECT_MCP_SERVERS),
    "browser": _validate_project_browser,
    "activeRagBranchIds": lambda raw: _validate_project_id_list(raw, "activeRagBranchIds", MAX_PROJECT_RAG_BRANCHES),
}


def validate_project_environment_patch(raw) -> dict:
    """Valida un parche parcial del entorno de ejecución de un proyecto."""
    if not isinstance(raw, dict):
        raise ValueError("El entorno del proyecto debe ser un objeto JSON")
    unknown = sorted(set(raw) - PROJECT_ENVIRONMENT_KEYS)
    if unknown:
        raise ValueError(f"Campos desconocidos en el entorno del proyecto: {', '.join(unknown)}")
    return {key: _PROJECT_ENV_VALIDATORS[key](raw[key]) for key in raw}


def _row_to_project_environment(row) -> dict:
    try:
        data = json.loads(row["config_json"])
    except (ValueError, TypeError) as exc:
        raise RuntimeError(f"El entorno guardado del proyecto está corrupto: {exc}") from exc
    if not isinstance(data, dict):
        raise RuntimeError("El entorno guardado del proyecto no es un objeto JSON.")
    base = _empty_project_environment()
    validated = validate_project_environment_patch({k: v for k, v in data.items() if k in PROJECT_ENVIRONMENT_KEYS})
    return {**base, **validated, "saved": True, "updatedAt": int(row["updated_at"])}


def get_project_environment(project_key: str) -> dict:
    """Devuelve el entorno guardado del proyecto (`general` usa get_no_project_dir()), o los valores base."""
    clean_key = clean_project_key(project_key)
    with open_storage() as conn:
        row = conn.execute(
            "SELECT config_json, updated_at FROM project_environments WHERE project_key = ?;",
            (clean_key,),
        ).fetchone()
        return _row_to_project_environment(row) if row else _empty_project_environment()


def save_project_environment(project_key: str, raw_patch: dict) -> dict:
    """Actualiza atómicamente en SQLite el entorno de ejecución guardado del proyecto."""
    clean_key = clean_project_key(project_key)
    patch = validate_project_environment_patch(raw_patch)
    now = int(time.time() * 1000)
    with open_storage() as conn:
        with _immediate_transaction(conn):
            row = conn.execute(
                "SELECT config_json, updated_at FROM project_environments WHERE project_key = ?;",
                (clean_key,),
            ).fetchone()
            base = _row_to_project_environment(row) if row else _empty_project_environment()
            stored = {key: patch[key] if key in patch else base[key] for key in PROJECT_ENVIRONMENT_FIELDS}
            conn.execute("""
                INSERT INTO project_environments (project_key, config_json, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(project_key) DO UPDATE SET
                    config_json = excluded.config_json,
                    updated_at = excluded.updated_at;
            """, (clean_key, json.dumps(stored, ensure_ascii=False), now))
            return {**stored, "saved": True, "updatedAt": now}


MAX_PROJECT_SECRETS = 50
PROJECT_SECRET_NAME_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,63}$")


def project_secret_prefix(project_key: str) -> str:
    return f"{project_security_policy_id(project_key)}:"


def validate_project_secret_name(name) -> str:
    if not isinstance(name, str):
        raise ValueError("El nombre del secreto debe ser texto")
    clean = name.strip()
    if not PROJECT_SECRET_NAME_PATTERN.match(clean):
        raise ValueError("El nombre del secreto debe empezar por letra y usar solo letras, cifras o _ (máximo 64)")
    return clean


def project_secret_key(project_key: str, name: str) -> str:
    return f"{project_secret_prefix(project_key)}{validate_project_secret_name(name)}"


def list_project_secret_names(project_key: str) -> list[str]:
    """Nombres de los secretos guardados del proyecto, sin leer ni devolver sus valores."""
    prefix = project_secret_prefix(project_key)
    return sorted(key[len(prefix):] for key in secret_names(prefix))


def save_project_secret(project_key: str, name: str, value: str) -> list[str]:
    clean_name = validate_project_secret_name(name)
    if not isinstance(value, str) or not value.strip():
        raise ValueError("El secreto no puede estar vacío")
    clean_val = value.strip()
    if len(clean_val) > MAX_SECRET_LENGTH:
        raise ValueError(f"El secreto no puede superar {MAX_SECRET_LENGTH} caracteres")
    prefix = project_secret_prefix(project_key)
    full_key = f"{prefix}{clean_name}"
    now = int(time.time() * 1000)
    with open_storage() as conn:
        with _immediate_transaction(conn):
            rows = conn.execute(
                "SELECT name FROM secrets WHERE substr(name, 1, ?) = ?;",
                (len(prefix), prefix),
            ).fetchall()
            existing = {row["name"] for row in rows}
            if full_key not in existing and len(existing) >= MAX_PROJECT_SECRETS:
                raise ValueError(f"Un proyecto no puede tener más de {MAX_PROJECT_SECRETS} secretos")
            _write_secret_on_conn(conn, full_key, clean_val, now)
            existing.add(full_key)
    return sorted(key[len(prefix):] for key in existing)


def delete_project_secret(project_key: str, name: str) -> list[str]:
    delete_secret(project_secret_key(project_key, name))
    return list_project_secret_names(project_key)


def get_project_secret(project_key: str, name: str) -> str | None:
    """Valor real del secreto del proyecto, solo para uso interno del backend."""
    return get_secret(project_secret_key(project_key, name))


def delete_project_storage(project_key: str) -> list[str]:
    """
    Elimina en una sola transacción las conversaciones del proyecto (con sus blobs huérfanos y sus filas de
    `runs`), su entorno guardado, sus políticas de seguridad y sus secretos. Las filas de `runs` no guardan
    el proyecto: se cruzan por `conversation_id` con el proyecto de la conversación. Si alguna de esas
    ejecuciones sigue en marcha, no borra nada.
    """
    clean_key = clean_project_key(project_key)
    prefix = project_secret_prefix(clean_key)
    project_where = "json_extract(extra_json, '$.project') = ?"
    with open_storage() as conn:
        with _immediate_transaction(conn):
            running = conn.execute(
                f"SELECT 1 FROM runs WHERE status = 'running' AND conversation_id IN (SELECT id FROM conversations WHERE {project_where}) LIMIT 1;",  # noqa: S608
                (clean_key,),
            ).fetchone()
            if running:
                raise ValueError("Detén los comandos y ejecuciones activas del proyecto antes de borrarlo.")
            conn.execute(
                f"DELETE FROM runs WHERE conversation_id IN (SELECT id FROM conversations WHERE {project_where});",  # noqa: S608
                (clean_key,),
            )
            deleted_ids = _delete_conversations_in_transaction(conn, project_where, (clean_key,))
            conn.execute("DELETE FROM project_environments WHERE project_key = ?;", (clean_key,))
            conn.execute("DELETE FROM security_policies WHERE id = ?;", (project_security_policy_id(clean_key),))
            conn.execute("DELETE FROM secrets WHERE substr(name, 1, ?) = ?;", (len(prefix), prefix))
    notify_live_change()
    return deleted_ids


def _has_prefix_match(conn: sqlite3.Connection, query: str, p1: str, p2: str) -> bool:
    return conn.execute(query, (len(p1), p1, len(p2), p2)).fetchone() is not None


def has_nested_project_data(project_key: str) -> bool:
    """True si existen entornos, políticas, secretos o conversaciones guardadas de subproyectos bajo `project_key`."""
    clean_key = str(project_key or "").strip().rstrip("/\\")
    if not clean_key:
        return False
    p_slash, p_back = f"{clean_key}/", f"{clean_key}\\"
    prefixed_slash, prefixed_back = f"{PROJECT_KEY_PREFIX}{p_slash}", f"{PROJECT_KEY_PREFIX}{p_back}"
    with open_storage() as conn:
        if _has_prefix_match(
            conn,
            "SELECT 1 FROM project_environments WHERE substr(project_key, 1, ?) = ? OR substr(project_key, 1, ?) = ? LIMIT 1;",
            p_slash,
            p_back,
        ):
            return True
        if _has_prefix_match(
            conn,
            "SELECT 1 FROM security_policies WHERE substr(id, 1, ?) = ? OR substr(id, 1, ?) = ? LIMIT 1;",
            prefixed_slash,
            prefixed_back,
        ):
            return True
        if _has_prefix_match(
            conn,
            "SELECT 1 FROM secrets WHERE substr(name, 1, ?) = ? OR substr(name, 1, ?) = ? LIMIT 1;",
            prefixed_slash,
            prefixed_back,
        ):
            return True
        if _has_prefix_match(
            conn,
            "SELECT 1 FROM conversations WHERE substr(json_extract(extra_json, '$.project'), 1, ?) = ? OR substr(json_extract(extra_json, '$.project'), 1, ?) = ? LIMIT 1;",
            p_slash,
            p_back,
        ):
            return True
    return False

# --- browser.config ---
"""Navegador de Playwright MCP: configuración guardada y argumentos de arranque."""





# Configuración del navegador de Playwright MCP (sección Navegador de Ajustes).
# Modo propio: un motor de Playwright o canal del sistema en memoria (--isolated), o con almacenamiento
# persistente con nombre en ~/zerochat/playwright/profile/<motor>/<nombre>.
# Modo del usuario: su Chrome, Edge o Chromium mediante la extensión de Playwright (--extension).
BROWSER_MODES = ("own", "user")
OWN_BROWSER_ENGINES = ("chromium", "firefox", "webkit")
OWN_SYSTEM_ENGINES = ("chrome", "msedge", "system-chromium")
ALL_OWN_ENGINES = (*OWN_BROWSER_ENGINES, *OWN_SYSTEM_ENGINES)
USER_BROWSERS = ("chrome", "msedge", "chromium")
USER_AGENT_MODES = ("auto", "rotate", "custom")
USER_AGENT_MAX_LEN = 512
BROWSER_CONFIG_DEFAULTS = {
    "mode": "own",
    "engine": "chromium",
    "userBrowser": "chrome",
    "headless": True,
    "extensionToken": "",
    "userAgentMode": "auto",
    "userAgent": "",
}
BROWSER_CONFIG_KEY = "browser"
LAST_FRONTEND_USER_AGENT_KEY = "browser:last_user_agent"
BROWSER_EXTENSION_TOKEN_KEY = "browser:extension_token"  # noqa: S105 - nombre de fila en la tabla secrets
# Identificador de la extensión de Playwright en la tienda de Chrome, que también usa Edge.
PLAYWRIGHT_SERVER_ID = "playwright"
PLAYWRIGHT_EXTENSION_ID = "mmlmfjhmonkocbjadbfplnigmagldckm"
# Token que muestra la extensión: con él la conexión no pide aceptarla en el navegador.
_EXTENSION_TOKEN = re.compile(r"^[A-Za-z0-9_-]{0,256}$")
_BROWSER_CONFIG_CHOICES = {
    "mode": BROWSER_MODES,
    "engine": ALL_OWN_ENGINES,
    "userBrowser": USER_BROWSERS,
    "userAgentMode": USER_AGENT_MODES,
}
MODERN_USER_AGENTS = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0",
)
# User-Agent por defecto de las salidas web y de los motores propios hasta que el frontend fija el suyo.
DEFAULT_USER_AGENT = MODERN_USER_AGENTS[0]


def own_browser_profile_dir(engine: str) -> Path:
    return get_data_dir() / "playwright" / "profile" / engine


def _validate_user_agent(value) -> str:
    if not isinstance(value, str):
        raise ValueError("userAgent debe ser una cadena")
    if len(value) > USER_AGENT_MAX_LEN or any(ch in value for ch in ("\r", "\n", "\x00")):
        raise ValueError(f"userAgent debe tener hasta {USER_AGENT_MAX_LEN} caracteres sin saltos de línea")
    return value.strip()


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
    config["userAgent"] = _validate_user_agent(config["userAgent"])
    if config["userAgentMode"] == "custom" and not config["userAgent"]:
        raise ValueError("userAgent es obligatorio cuando userAgentMode es custom")
    return config


def load_browser_config() -> dict:
    try:
        stored = get_setting(BROWSER_CONFIG_KEY)
        token = get_secret(BROWSER_EXTENSION_TOKEN_KEY) or ""
        if stored is None and not token:
            return dict(BROWSER_CONFIG_DEFAULTS)
        if stored is not None and not isinstance(stored, dict):
            raise ValueError("La configuración del navegador debe ser un objeto")
        return validate_browser_config({**(stored or {}), "extensionToken": token})
    except (OSError, ValueError, TypeError) as err:
        log_event(f"[zerochat] Configuración del navegador no válida en SQLite, se usan los valores por defecto: {err}")
        return dict(BROWSER_CONFIG_DEFAULTS)


def save_browser_config(raw) -> dict:
    config = validate_browser_config(raw)
    public_config = {key: value for key, value in config.items() if key != "extensionToken"}
    set_setting(BROWSER_CONFIG_KEY, public_config, secret_name=BROWSER_EXTENSION_TOKEN_KEY, secret=config["extensionToken"])
    return config


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


def _require_chromium_install() -> tuple[str, Path]:
    install = chromium_install()
    if not install:
        raise RuntimeError("No se encuentra Chromium en el sistema: elige otro navegador en Ajustes › Navegador.")
    return install


def playwright_launch_args(config: dict, user_agent: str | None = None) -> list[str]:
    """Argumentos de Playwright MCP para la configuración del navegador."""
    if config["mode"] == "user":
        # La extensión maneja el navegador abierto del usuario: siempre con ventana.
        if config["userBrowser"] != "chromium":
            return ["--extension", f"--browser={config['userBrowser']}"]
        # Chromium no es un canal de Playwright: se da su ejecutable y su perfil, con el canal chrome
        # para que no lo lance sin sandbox si no está abierto.
        executable, data_dir = _require_chromium_install()
        return ["--extension", "--browser=chrome", f"--executable-path={executable}", f"--user-data-dir={data_dir}"]
    if config["engine"] == "system-chromium":
        executable, _ = _require_chromium_install()
        args = ["--browser=chrome", "--isolated", f"--executable-path={executable}"]
    else:
        args = [f"--browser={config['engine']}", "--isolated"]
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


def _playwright_launch(service_user_agent: str | None = None) -> tuple[list[str], dict[str, str]]:
    """Argumentos y entorno de Playwright MCP según la configuración guardada."""
    config = load_browser_config()
    effective_ua = resolve_playwright_user_agent(config, service_user_agent)
    return playwright_launch_args(config, effective_ua), playwright_launch_env(config)


# User-Agent que usan los motores propios de Playwright; lo fija el servidor con el User-Agent
# activo de las salidas web (web/fetch) para que ambos compartan el mismo fingerprint.
SERVICE_USER_AGENT: str | None = DEFAULT_USER_AGENT
_FRONTEND_USER_AGENT_CAPTURED: bool = False


def set_service_user_agent(user_agent: str | None, *, from_frontend: bool = False) -> None:
    global SERVICE_USER_AGENT, _FRONTEND_USER_AGENT_CAPTURED
    SERVICE_USER_AGENT = user_agent
    _FRONTEND_USER_AGENT_CAPTURED = from_frontend


def load_last_frontend_user_agent() -> str | None:
    """Último User-Agent real capturado del navegador y guardado en SQLite, o None si no hay."""
    try:
        stored = get_setting(LAST_FRONTEND_USER_AGENT_KEY)
    except (OSError, ValueError, TypeError, sqlite3.Error):
        return None
    try:
        return _validate_user_agent(stored) or None
    except ValueError:
        return None


def save_last_frontend_user_agent(user_agent: str) -> None:
    """Persiste en SQLite el User-Agent real del navegador para reutilizarlo en ejecuciones desatendidas."""
    try:
        cleaned = _validate_user_agent(user_agent)
        if cleaned:
            set_setting(LAST_FRONTEND_USER_AGENT_KEY, cleaned)
    except (OSError, ValueError, TypeError, sqlite3.Error):
        return


def resolve_playwright_user_agent(config: dict, service_user_agent: str | None = None) -> str | None:
    """User-Agent efectivo para un arranque de Playwright en modo propio según userAgentMode."""
    mode = config.get("userAgentMode", "auto")
    if mode == "custom":
        custom = config.get("userAgent", "").strip()
        if custom:
            return custom
    if mode == "rotate":
        candidates: list[str] = []
        for candidate in (load_last_frontend_user_agent(), *MODERN_USER_AGENTS, service_user_agent):
            if isinstance(candidate, str) and candidate.strip() and candidate not in candidates:
                candidates.append(candidate)
        return random.choice(candidates) if candidates else service_user_agent  # noqa: S311 - rotación de fingerprint, no criptografía
    if _FRONTEND_USER_AGENT_CAPTURED and service_user_agent:
        return service_user_agent
    return load_last_frontend_user_agent() or service_user_agent


# Argumentos y entorno que añade ZeroChat al arrancar un servicio gestionado,
# calculados en cada arranque.
SERVICE_LAUNCH = {PLAYWRIGHT_SERVER_ID: lambda: _playwright_launch(SERVICE_USER_AGENT)}

# --- browser.engines ---
"""Motores propios de Playwright (listar, instalar y quitar) y navegadores del sistema con la extensión de Playwright."""





# Si Playwright MCP está en marcha: lo registra el gestor de servicios MCP (on_playwright_status).
PLAYWRIGHT_STATUS_CHECK: list = []


def on_playwright_status(check):
    """Registra la función, sin argumentos, que dice si Playwright MCP está arrancando o en marcha."""
    PLAYWRIGHT_STATUS_CHECK[:] = [check]
    return check


def _playwright_active() -> bool:
    return any(check() for check in PLAYWRIGHT_STATUS_CHECK)


def clear_own_browser_data(engine) -> dict:
    """Borra el perfil persistente del motor (cookies, sesiones, almacenamiento de los sitios)."""
    if engine not in ALL_OWN_ENGINES:
        raise ValueError(f"engine debe ser uno de: {', '.join(ALL_OWN_ENGINES)}")
    # El navegador abierto tiene el perfil bloqueado y volvería a escribirlo.
    if _playwright_active():
        raise ValueError("Detén Playwright MCP antes de borrar los datos del navegador.")
    shutil.rmtree(own_browser_profile_dir(engine), ignore_errors=True)
    return {"cleared": engine}


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
        self._changed = threading.Condition(self._lock)
        self._rev = 0
        self._stopping = False
        self._jobs: dict[str, dict] = {}
        self._locations_cache: tuple[tuple[str, int], dict[str, tuple[str, Path]]] | None = None

    def close(self):
        """Despierta cualquier long-poll pendiente en list() al detener el servidor."""
        with self._changed:
            self._stopping = True
            self._changed.notify_all()

    @staticmethod
    def _run_cli(cli: Path, *args: str, timeout: float) -> subprocess.CompletedProcess:
        return subprocess.run([shutil.which("node") or "node", str(cli), *args], cwd=cli.parent,
                              capture_output=True, text=True, timeout=timeout)

    def _locations(self, cli: Path) -> dict[str, tuple[str, Path]]:
        """Entradas de la caché de esta versión de Playwright: nombre -> (título con versión, ruta)."""
        key = (str(cli), cli.stat().st_mtime_ns)
        cached = self._locations_cache
        if cached is not None and cached[0] == key:
            return cached[1]
        names = [name for entries in ENGINE_CACHE_ENTRIES.values() for name in entries]
        result = self._run_cli(cli, "install", "--dry-run", *names, timeout=30)
        if result.returncode != 0:
            raise RuntimeError(f"Playwright no pudo listar sus navegadores: {(result.stderr or result.stdout).strip()}")
        locations = {name: (title, Path(location.strip())) for title, name, location in _DRY_RUN_ENTRY.findall(result.stdout)}
        self._locations_cache = (key, locations)
        return locations

    def _notify_locked(self):
        self._rev += 1
        self._changed.notify_all()

    def list(self, *, since_rev: int | None = None, wait_ms: int = 0, engines_only: bool = False) -> dict:
        """Navegadores del sistema y motores de Playwright; con since_rev/wait_ms espera cambios sin re-escanear navegadores del sistema."""
        if since_rev is not None and wait_ms > 0:
            with self._changed:
                self._changed.wait_for(
                    lambda: self._stopping or self._rev != since_rev or not any(j.get("status") == "installing" for j in self._jobs.values()),
                    min(wait_ms, LONG_POLL_MAX_WAIT_MS) / 1000.0,
                )
        cli = playwright_service_cli()
        with self._lock:
            rev = self._rev
            jobs = {engine: dict(job) for engine, job in self._jobs.items()}
        result: dict = {"rev": rev, "engines": [], "config": load_browser_config()}
        if not engines_only:
            result["systemBrowsers"] = system_browsers()
            result["extensions"] = user_browser_extensions()
        if not cli.is_file():
            return result
        locations = self._locations(cli)
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
            self._notify_locked()
        notify_live_change()
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
                            self._notify_locked()
                        elif percent:
                            self._jobs[engine]["percent"] = min(100, int(percent.group(1)))
                            self._notify_locked()
                code = proc.wait()
            finally:
                timer.cancel()
            if code != 0:
                raise RuntimeError("\n".join(lines[-5:]) or f"código {code}")
            with self._lock:
                self._jobs.pop(engine, None)
                self._notify_locked()
            log_event(f"[zerochat] Motor {engine} de Playwright instalado")
        except (OSError, RuntimeError, subprocess.SubprocessError) as err:
            with self._lock:
                self._jobs[engine] = {"status": "error", "error": format_log_error(str(err), 500)}
                self._notify_locked()
            log_event(f"[zerochat] Fallo instalando el motor {engine} de Playwright: {format_log_error(str(err))}")
        notify_live_change()

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
            self._notify_locked()
        notify_live_change()
        result = self.list()
        # La configuración no se queda con un motor quitado si hay otro instalado.
        config = result["config"]
        replacement = next((item["id"] for item in result["engines"] if item["installed"]), None)
        if config["engine"] == engine and replacement:
            result["config"] = save_browser_config({**config, "engine": replacement})
        return result


BROWSER_ENGINES = BrowserEngines()

# --- browser.rpc ---
"""Métodos JSON-RPC de la sección Navegador de Ajustes: configuración, datos y motores propios de Playwright."""





def _engines_list(params: dict) -> RpcOutcome:
    since_rev = parse_optional_nonneg_int(params.get("since_rev"), "since_rev")
    wait_ms = parse_nonneg_int(params.get("wait_ms"), "wait_ms")
    engines_only = params.get("engines_only", False)
    if not isinstance(engines_only, bool):
        raise ValueError("engines_only debe ser un booleano")
    return rpc_result(BROWSER_ENGINES.list(since_rev=since_rev, wait_ms=wait_ms, engines_only=engines_only))


BROWSER_METHODS = {
    "zerochat/browser/config/set": lambda params: rpc_result(save_browser_config(params.get("config"))),
    "zerochat/browser/data/clear": lambda params: rpc_result(clear_own_browser_data(params.get("engine"))),
    "zerochat/browser/engines/list": _engines_list,
    "zerochat/browser/engines/install": lambda params: rpc_result(BROWSER_ENGINES.install(params.get("engine"))),
    "zerochat/browser/engines/remove": lambda params: rpc_result(BROWSER_ENGINES.remove(params.get("engine"))),
}


def dispatch_browser(method: str, params: dict) -> RpcOutcome:
    try:
        return dispatch_table(BROWSER_METHODS, method, params)
    except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as exc:
        return rpc_error(INVALID_PARAMS, str(exc))

# --- mcp.manager ---
"""Gestor de servicios MCP: descubrimiento en ~/zerochat/services, actualización desde el catálogo, preferencias,
arranque y parada, y nombres públicos de sus herramientas."""





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


@dataclasses.dataclass
class McpServiceRecord:
    """Estado de un servicio MCP en este proceso: fase del ciclo de vida, cliente y último error."""
    phase: str = "stopped"  # stopped, installing, starting, running o error
    client: StdioMcpClient | None = None
    error: str | None = None


# Nombre de la variable de entorno de un secreto que declara un servicio en su service.json ("secrets").
SERVICE_SECRET_NAME_PATTERN = re.compile(r"[A-Z][A-Z0-9_]{0,63}")
MAX_OPTION_TEXT_LENGTH = 1024


def service_secrets(server: dict) -> list[dict]:
    """Los secretos que declara el servicio: [{"name", "label"}], solo los de nombre válido."""
    declared = server.get("secrets")
    if not isinstance(declared, list):
        return []
    return [{"name": item["name"], "label": item.get("label", {})} for item in declared
            if isinstance(item, dict) and isinstance(item.get("name"), str) and SERVICE_SECRET_NAME_PATTERN.fullmatch(item["name"])]


# Nombre de una herramienta nativa que una herramienta del servicio sustituye ("tools" de su service.json).
NATIVE_TOOL_NAME_PATTERN = re.compile(r"[a-z][a-z0-9_]{0,63}")


def service_tool_settings(server: dict, original: str) -> dict:
    """Lo que el service.json declara de una herramienta en "tools": las nativas que sustituye mientras está activa
    (replaces) y si empieza activada (enabledByDefault). La interfaz decide qué nativas se pueden sustituir."""
    declared = server.get("tools")
    entry = declared.get(original) if isinstance(declared, dict) else None
    if not isinstance(entry, dict):
        return {"replaces": [], "enabledByDefault": True}
    replaces = entry.get("replaces")
    return {
        "replaces": [name for name in replaces if isinstance(name, str) and NATIVE_TOOL_NAME_PATTERN.fullmatch(name)]
        if isinstance(replaces, list) else [],
        "enabledByDefault": entry.get("enabledByDefault") is not False,
    }


def service_secret_key(server_id: str, name: str) -> str:
    """Nombre con el que se guarda en SQLite el secreto `name` del servicio."""
    return f"mcp:{server_id}:{name}"


def service_status(record: McpServiceRecord, alive: bool, exit_code: int | None) -> tuple[str, str | None]:
    """Estado público y error de un servicio a partir de su registro y de si su proceso sigue vivo:
    el proceso de un servicio en marcha puede morir sin que nadie lo detenga."""
    if record.phase != "running" or alive:
        return record.phase, record.error
    if exit_code is not None:
        return "error", f"MCP process exited with code {exit_code}"
    return "error", "MCP process is not responding"


# Cada cuánto se vuelve a mirar el catálogo publicado con el servidor en marcha.
CATALOG_REFRESH_SECONDS = 3600


def _npm_install_needed(marker: Path, package_dir: Path, package: str, version: str) -> bool:
    """Falta la instalación, o la registrada en marker es de otro paquete o versión."""
    if not marker.exists() or not package_dir.is_dir():
        return True
    try:
        installation = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return True
    return installation.get("package") != package or installation.get("version") != version


def _install_playwright_browser(service_dir: Path, browser: str, node: str):
    playwright_cli = service_dir / "node_modules" / "playwright" / "cli.js"
    if not playwright_cli.is_file():
        raise RuntimeError("No se encontró Playwright después de instalar el servicio MCP")
    result = subprocess.run([node, str(playwright_cli), "install", browser], cwd=service_dir, capture_output=True, text=True, timeout=600)
    if result.returncode != 0:
        raise RuntimeError(f"Fallo instalando el navegador {browser} de Playwright: {result.stderr or result.stdout}")


class McpServiceManager:
    def __init__(self, services_root: Path | None = None):
        # Crearlo no toca el disco: el gestor global existe desde que se importa zerochat.
        self.services_root = Path(services_root) if services_root else get_data_dir() / "services"
        self.records: dict[str, McpServiceRecord] = {}
        # _lock serializa arrancar, parar y configurar (un arranque puede durar minutos instalando).
        # _state_changed guarda _state_rev y _starting, y es el único que toma start_async para marcar
        # en "starting" el registro antes de que su hilo de arranque llegue a _lock: por eso tools() y
        # list_servers() leen records sin tomar _lock.
        self._lock = threading.Lock()
        self._state_changed = threading.Condition()
        self._state_rev = 0
        self._starting: set[str] = set()
        self._catalog_stop = threading.Event()
        self._services: dict[str, dict] | None = None
        self._preferences: dict | None = None

    def _notify_state_changed(self):
        with self._state_changed:
            self._state_rev += 1
            self._state_changed.notify_all()
        notify_live_change()

    @property
    def services(self) -> dict[str, dict]:
        if self._services is None:
            self._services = self._load_services()
        return self._services

    @services.setter
    def services(self, value: dict[str, dict]):
        self._services = value

    @property
    def preferences(self) -> dict:
        if self._preferences is None:
            self._preferences = self._load_preferences()
        return self._preferences

    @staticmethod
    def _trace(server_id: str, message: str):
        log_event(f"[MCP {server_id}] {_mcp_trace_text(message)}")

    def _load_services(self) -> dict[str, dict]:
        servers = {}
        if not self.services_root.is_dir():
            return servers
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
        try:
            stored = get_setting("mcp_services")
            return stored if isinstance(stored, dict) else {}
        except (OSError, ValueError) as err:
            log_event(f"[zerochat] Advertencia al leer preferencias MCP en SQLite: {err}")
            return {}

    def _save_preferences(self):
        try:
            set_setting("mcp_services", self.preferences)
        except (OSError, ValueError) as err:
            log_event(f"[zerochat] Advertencia al guardar preferencias MCP en SQLite: {err}")

    def list_servers(self) -> list[dict]:
        self.services = self._load_services()
        saved_secrets = secret_names("mcp:")
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
                "status": status,
                "toolCount": len(client.tools) if running else 0,
                "error": error,
                "options": server.get("options", []),
                "userOptions": pref.get("options", {}),
                "oauthUrl": client.oauth_url if client else None,
                # Solo si cada secreto está guardado: su valor nunca sale del backend.
                "secrets": [{**secret, "configured": service_secret_key(server_id, secret["name"]) in saved_secrets}
                            for secret in service_secrets(server)],
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

        if installer_file.exists():
            self._trace(server_id, f"reading installer: {installer_file.name}")
            try:
                installer = json.loads(installer_file.read_text(encoding="utf-8"))
            except Exception as e:
                raise RuntimeError(f"Error leyendo installer.json: {e}") from e
            if installer.get("type", "npm") == "npm":
                self._prepare_npm_service(server_id, service_dir, installer, node)

        venv_python = get_venv_python(get_venv_dir())
        return {
            "serviceDir": str(service_dir),
            "pythonExecutable": str(venv_python) if venv_python.is_file() else sys.executable,
            "nodeExecutable": node
        }

    def _prepare_npm_service(self, server_id: str, service_dir: Path, installer: dict, node: str):
        """Instala el paquete npm del servicio (y su navegador de Playwright) si falta o cambió de versión."""
        product = installer.get("product", {})
        package = product.get("package")
        version = product.get("version")
        if not package or not version:
            raise RuntimeError("El instalador npm debe definir package y version")
        if not shutil.which("node") or not shutil.which("npm"):
            raise RuntimeError("Node.js y npm son necesarios para instalar este servicio MCP")
        self._check_node_requirement(server_id, installer, node)

        marker = service_dir / ".installed.json"
        package_dir = service_dir / "node_modules" / Path(*package.split("/"))
        if not _npm_install_needed(marker, package_dir, package, version):
            self._trace(server_id, f"npm package already installed: {package}@{version}")
            return
        self.records[server_id].phase = "installing"
        self._notify_state_changed()
        self._trace(server_id, f"installing npm package: {package}@{version}")
        manifest = service_dir / "package.json"
        manifest.write_text(json.dumps({"private": True, "dependencies": {package: version}}, indent=2), encoding="utf-8")
        npm = shutil.which("npm") or "npm"
        res = subprocess.run([npm, "install", "--ignore-scripts", "--no-audit", "--no-fund"], cwd=service_dir, capture_output=True, text=True, timeout=600)
        if res.returncode != 0:
            raise RuntimeError(f"Fallo instalando dependencias npm: {res.stderr or res.stdout}")
        self._trace(server_id, f"npm package installed: {package}@{version}")
        installation = {"type": "npm", "package": package, "version": version, "nodeExecutable": node}
        browser = product.get("browser")
        if browser:
            _install_playwright_browser(service_dir, browser, node)
            installation["browser"] = browser
        marker.write_text(json.dumps(installation, indent=2), encoding="utf-8")

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
        """Arranca un servicio MCP externo y devuelve la lista actualizada de servicios."""
        try:
            with self._lock:
                self.services = self._load_services()
                self._start_locked(server_id)
                return self.list_servers()
        finally:
            with self._state_changed:
                self._starting.discard(server_id)
                self._state_changed.notify_all()

    def start_async(self, server_id: str) -> int:
        """Lanza en segundo plano el arranque de un servicio MCP y devuelve la revisión inicial."""
        if server_id not in self.services:
            self.services = self._load_services()
        if server_id not in self.services:
            raise KeyError(f"Servidor MCP desconocido: {server_id}")
        with self._state_changed:
            record = self.records.setdefault(server_id, McpServiceRecord())
            if record.client and record.client.running():
                return self._state_rev
            should_launch = server_id not in self._starting
            if should_launch:
                self._starting.add(server_id)
                record.phase, record.error = "starting", None
                self._state_rev += 1
                self._state_changed.notify_all()
            rev = self._state_rev
        if should_launch:
            notify_live_change()
            threading.Thread(target=self.start, args=(server_id,), name=f"mcp-start-{server_id}", daemon=True).start()
        return rev

    def wait_server(self, server_id: str, wait_ms: int, since_rev: int | None = None) -> dict:
        """Espera cambios de fase, aparición de oauthUrl o fin del arranque de un servicio MCP."""
        if server_id not in self.services:
            self.services = self._load_services()
        if server_id not in self.services:
            raise KeyError(f"Servidor MCP desconocido: {server_id}")
        deadline = time.monotonic() + min(max(0, wait_ms), LONG_POLL_MAX_WAIT_MS) / 1000.0
        with self._state_changed:
            while True:
                record = self.records.get(server_id)
                phase = record.phase if record else "stopped"
                oauth_url = record.client.oauth_url if record and record.client else None
                terminal = phase not in ("installing", "starting")
                if since_rev is None:
                    changed = bool(oauth_url) or phase == "installing"
                else:
                    changed = self._state_rev != since_rev
                if terminal or changed:
                    break
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                self._state_changed.wait(remaining)
            rev = self._state_rev
        return {"servers": self.list_servers(), "externalTools": self.tools(), "rev": rev}

    def _start_locked(self, server_id: str):
        server = self.services.get(server_id)
        if not server:
            raise KeyError(f"Servidor MCP desconocido: {server_id}")
        record = self.records.setdefault(server_id, McpServiceRecord())
        if record.client and record.client.running():
            return
        record.phase, record.error = "starting", None
        self._notify_state_changed()
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
                if opt.get("type") == "text":
                    text_val = "" if val is None else str(val).strip()
                    if opt.get("required") and not text_val:
                        raise RuntimeError(f"Falta configurar {opt_id} en Ajustes › MCP.")
                    values[f"option:{opt_id}"] = text_val
                else:
                    values[f"option:{opt_id}"] = "" if val is None else str(val)
                if opt.get("type") == "boolean":
                    option_args.extend(opt.get("argsWhenTrue", []) if val else opt.get("argsWhenFalse", []))

            launch = server.get("launch", {})
            command = self._expand(launch.get("executable", sys.executable), values)
            args = [self._expand(arg, values) for arg in launch.get("args", []) + option_args]
            # Los secretos solo se sustituyen en las variables de entorno: en los argumentos se verían en la lista de procesos.
            env_values = {**values, **self._secret_values(server_id, server)}
            env = os.environ.copy()
            for k, v in launch.get("env", {}).items():
                env[k] = self._expand(v, env_values)
            if server_id in SERVICE_LAUNCH:
                extra_args, extra_env = SERVICE_LAUNCH[server_id]()
                args += extra_args
                env.update(extra_env)

            client = StdioMcpClient(
                command, args, str(service_dir), env,
                trace=lambda message: self._trace(server_id, message),
                call_timeout=_positive_seconds(launch.get("callTimeoutSeconds"), DEFAULT_MCP_CALL_TIMEOUT_SECONDS),
                on_oauth_url=lambda _url: self._notify_state_changed(),
            )
            # _prepare_service puede haber dejado el estado en "installing".
            record.phase, record.client = "starting", client
            self._notify_state_changed()
            client.start(int(launch.get("handshakeTimeoutSeconds", 15)))
            record.phase = "running"
            self._notify_state_changed()
            self._trace(server_id, "started successfully")
        except Exception as exc:
            record.phase, record.error = "error", str(exc)
            self._notify_state_changed()
            self._trace(server_id, f"start failed: {exc}")
            stale, record.client = record.client or client, None
            if stale:
                stale.stop()

    @staticmethod
    def _secret_values(server_id: str, server: dict) -> dict[str, str]:
        """Los secretos que declara el servicio, como marcadores ${secret:NOMBRE}; sin uno guardado no arranca."""
        values = {}
        for secret in service_secrets(server):
            value = get_secret(service_secret_key(server_id, secret["name"]))
            if not value:
                raise RuntimeError(f"Falta la clave {secret['name']}: guárdala en Ajustes › MCP.")
            values[f"secret:{secret['name']}"] = value
        return values

    def set_secret(self, server_id: str, name: str, value: str | None) -> list[dict]:
        """Guarda (o borra, con None) un secreto que el servicio declara. Si está en marcha se detiene, porque su proceso
        tiene el valor anterior; se vuelve a iniciar cuando se quiera (el perfil o la persona), ya con el nuevo."""
        with self._lock:
            self.services = self._load_services()
            server = self.services.get(server_id)
            if not server:
                raise KeyError(f"Servidor MCP desconocido: {server_id}")
            if name not in {secret["name"] for secret in service_secrets(server)}:
                raise KeyError(f"{server_id} no declara el secreto {name}")
            key = service_secret_key(server_id, name)
            if value is None:
                delete_secret(key)
            else:
                save_secret(key, value)
            self._trace(server_id, f"secret {name} {'deleted' if value is None else 'saved'}")
            record = self.records.pop(server_id, None)
            if record and record.client:
                record.client.stop()
            self._notify_state_changed()
            return self.list_servers()

    def stop(self, server_id: str) -> list[dict]:
        with self._lock:
            self.services = self._load_services()
            record = self.records.pop(server_id, McpServiceRecord())
            if server_id not in self.services and not record.client:
                raise KeyError(f"Servidor MCP desconocido: {server_id}")
            if record.client:
                record.client.stop()
            self._notify_state_changed()
            return self.list_servers()

    @staticmethod
    def _normalize_option_value(spec: dict, key: str, value):
        opt_type = spec.get("type")
        if opt_type == "boolean":
            if not isinstance(value, bool):
                raise ValueError(f"La opción {key} debe ser booleana.")
            return value
        if opt_type == "text":
            if not isinstance(value, str):
                raise ValueError(f"La opción {key} debe ser texto.")
            normalized = value.strip()
            if len(normalized) > MAX_OPTION_TEXT_LENGTH:
                raise ValueError(f"La opción {key} supera {MAX_OPTION_TEXT_LENGTH} caracteres.")
            return normalized
        return value

    def configure(self, server_id: str, options: dict | None = None) -> list[dict]:
        with self._lock:
            self.services = self._load_services()
            server = self.services.get(server_id)
            if not server:
                raise KeyError(f"Servidor MCP desconocido: {server_id}")
            entry = self.preferences.setdefault(server_id, {})
            changed = False
            if options is not None:
                declared = {opt["id"]: opt for opt in server.get("options", []) if isinstance(opt, dict) and opt.get("id")}
                opts = entry.setdefault("options", {})
                for key, value in options.items():
                    spec = declared.get(key)
                    if not spec:
                        raise ValueError(f"Opción desconocida para {server_id}: {key}")
                    normalized = self._normalize_option_value(spec, key, value)
                    if opts.get(key) != normalized:
                        opts[key] = normalized
                        changed = True
            self._save_preferences()
            if changed:
                record = self.records.pop(server_id, None)
                if record and record.client:
                    record.client.stop()
            self._notify_state_changed()
            return self.list_servers()

    def _running_clients(self) -> list[tuple[str, StdioMcpClient]]:
        return [(server_id, record.client) for server_id, record in list(self.records.items())
                if record.client and record.client.running()]

    def tools(self) -> list[dict]:
        aggregated = []
        seen: set[str] = set()
        for server_id, client in self._running_clients():
            for t in list(client.tools):
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
                    "originalName": original,
                    **service_tool_settings(self.services.get(server_id, {}), original),
                }
                aggregated.append(tcopy)
        return aggregated

    def _resolve_tool(self, public_name: str) -> tuple[str, StdioMcpClient, str] | None:
        for server_id, client in self._running_clients():
            for t in list(client.tools):
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
        return decoded if decoded in self.services else None

    def call(self, public_name: str, arguments: dict) -> dict:
        resolved = self._resolve_tool(public_name)
        if not resolved:
            raise ValueError(f"Herramienta externa '{public_name}' no disponible o servidor detenido.")
        # La llamada puede durar decenas de segundos: no debe bloquear al resto de servidores.
        server_id, client, original_name = resolved
        request = lambda: client.request("tools/call", {"name": original_name, "arguments": arguments}, timeout=client.call_timeout)
        # Frecuencia y paralelismo que declara el servicio (rateLimit), para todas sus herramientas juntas: no
        # saturar su API. RateLimitBusy llega al modelo como el error de la herramienta.
        policy = parse_rate_policy(self.services.get(server_id, {}).get("rateLimit"))
        if policy is None:
            return request()
        with RATE_LIMITER.slot(f"mcp:{server_id}", policy):
            return request()

    def start_catalog_refresh(self, ui_url: str):
        """Mantiene al día los servicios incluidos con el catálogo de la carpeta de la interfaz: lo mira ahora y
        después cada CATALOG_REFRESH_SECONDS, en un hilo propio para no retrasar el arranque ni las peticiones."""
        base = catalog_base(ui_url)

        def loop():
            while True:
                self.refresh_catalog(base)
                if self._catalog_stop.wait(CATALOG_REFRESH_SECONDS):
                    return

        threading.Thread(target=loop, name="mcp-catalog", daemon=True).start()

    def refresh_catalog(self, base: str) -> list[str]:
        """Actualiza los servicios cuya versión difiere de la del catálogo y reinicia los que estaban en marcha.
        Sin red, o con un catálogo no válido, se quedan los instalados; un servicio que no se puede descargar
        entero no se toca. Devuelve los ids actualizados."""
        try:
            catalog = parse_catalog(download(urllib.parse.urljoin(base, CATALOG_PATH)))
        except Exception as exc:
            log_event(f"[MCP catalog] {base}{CATALOG_PATH} no disponible; se usan los servicios instalados: {exc}")
            return []
        downloads = {}
        for server_id, entry in catalog.items():
            if installed_version(self.services_root, server_id) == entry["version"]:
                continue
            try:
                downloads[server_id] = download_service(base, server_id, entry)
            except Exception as exc:
                log_event(f"[MCP catalog] {server_id} {entry['version']} no se pudo descargar; se mantiene el instalado: {exc}")
        if downloads:
            self._install_updates(downloads, catalog)
        return sorted(downloads)

    def _install_updates(self, downloads: dict[str, dict[str, bytes]], catalog: dict[str, dict]):
        with self._lock:
            for server_id, files in downloads.items():
                install_service(self.services_root, server_id, files)
                log_event(f"[MCP catalog] {server_id} actualizado a la versión {catalog[server_id]['version']}")
            self.services = self._load_services()
            for server_id in downloads:
                record = self.records.get(server_id)
                if not (record and record.client and record.client.running()):
                    continue
                self._trace(server_id, "restarting with the updated version")
                record.client.stop()
                self._start_locked(server_id)
        if downloads:
            self._notify_state_changed()

    def close(self):
        self._catalog_stop.set()
        with self._lock:
            for record in self.records.values():
                if record.client:
                    record.client.stop()
                record.phase, record.client, record.error = "stopped", None, None
        self._notify_state_changed()


GLOBAL_MCP_MANAGER = McpServiceManager()


@on_playwright_status
def _playwright_service_running() -> bool:
    return any(server["id"] == PLAYWRIGHT_SERVER_ID and server["status"] in ("running", "starting", "installing")
               for server in GLOBAL_MCP_MANAGER.list_servers())

# --- mcp.rpc ---
"""Métodos JSON-RPC de los servicios MCP externos: arrancar, detener y configurar desde la interfaz."""



SERVER_CONTROL_METHODS = frozenset({
    "zerochat/external/servers/start",
    "zerochat/external/servers/wait",
    "zerochat/external/servers/stop",
    "zerochat/external/servers/configure",
    "zerochat/external/servers/secret",
})


def dispatch_server_control(method: str, params: dict) -> RpcOutcome:
    server_id = params.get("serverId")
    opts = params.get("options", {})
    if not isinstance(server_id, str) or not server_id:
        return rpc_error(INVALID_PARAMS, "serverId debe ser un texto no vacío.")
    if not isinstance(opts, dict):
        return rpc_error(INVALID_PARAMS, "options debe ser un objeto.")
    if method == "zerochat/external/servers/secret":
        return _set_secret(server_id, params)
    try:
        if method == "zerochat/external/servers/start":
            wait_ms = parse_nonneg_int(params.get("wait_ms"), "wait_ms")
            if wait_ms > 0:
                GLOBAL_MCP_MANAGER.start_async(server_id)
                return rpc_result(GLOBAL_MCP_MANAGER.wait_server(server_id, wait_ms))
            servers = GLOBAL_MCP_MANAGER.start(server_id)
        elif method == "zerochat/external/servers/wait":
            return rpc_result(GLOBAL_MCP_MANAGER.wait_server(
                server_id,
                parse_nonneg_int(params.get("wait_ms"), "wait_ms"),
                since_rev=parse_optional_nonneg_int(params.get("since_rev"), "since_rev"),
            ))
        elif method == "zerochat/external/servers/stop":
            servers = GLOBAL_MCP_MANAGER.stop(server_id)
        else:
            servers = GLOBAL_MCP_MANAGER.configure(server_id, opts)
    except KeyError as exc:
        return rpc_error(INVALID_PARAMS, str(exc.args[0]) if exc.args else str(exc))
    except ValueError as exc:
        return rpc_error(INVALID_PARAMS, str(exc))
    return rpc_result({"servers": servers, "externalTools": GLOBAL_MCP_MANAGER.tools()})


def _set_secret(server_id: str, params: dict) -> RpcOutcome:
    """Guarda el secreto `name` del servicio (o lo borra con value null). Solo escritura: ningún método lo devuelve."""
    name, value = params.get("name"), params.get("value")
    if not isinstance(name, str) or not name:
        return rpc_error(INVALID_PARAMS, "name debe ser un texto no vacío.")
    if value is not None and not isinstance(value, str):
        return rpc_error(INVALID_PARAMS, "value debe ser un texto o null.")
    try:
        servers = GLOBAL_MCP_MANAGER.set_secret(server_id, name, value)
        return rpc_result({"servers": servers, "externalTools": GLOBAL_MCP_MANAGER.tools()})
    except KeyError as exc:
        return rpc_error(INVALID_PARAMS, str(exc.args[0]) if exc.args else str(exc))
    except ValueError as exc:
        return rpc_error(INVALID_PARAMS, str(exc))

# --- run_mode.state ---
"""Estado de la ejecución desatendida: la sesión de --prompt o --conversation, su persistencia en SQLite, el arranque en segundo plano, sus códigos de salida y sus métodos zerochat/run/*."""





RUN_PROGRESS_TEXT_MAX = 500
# Permisos denegados que guarda una ejecución en sus avisos (cada uno recortado como el progreso); del resto, solo cuántos.
RUN_WARNINGS_MAX = 20
RUN_PROGRESS_KIND_PATTERN = re.compile(r"[a-z_]{1,32}")
RUN_EXIT_DONE = 0
RUN_EXIT_ERROR = 1
RUN_EXIT_NO_RESULT = 2
RUN_EXIT_SETUP = 3
# Argumentos no válidos, en cualquier modo: argparse usaría 2, que con --prompt es plazo agotado.
RUN_EXIT_ARGS = 4
# Pausada a la espera del usuario (ask_user o una herramienta por aprobar): se reanuda con la conversación.
RUN_EXIT_NEEDS_INPUT = 5
RUN_NEEDS_INPUT_KINDS = ("ask_user", "tool_approval")
# Alcanzó maxSteps o timeout de --run-file: lo hecho queda grabado y se continúa con la conversación.
RUN_EXIT_LIMIT = 6
# Contadores de zerochat/run/usage (la suma de todas las llamadas al modelo de la ejecución) y su tope.
RUN_USAGE_COUNTERS = ("model_calls", "prompt_tokens", "completion_tokens", "cached_tokens", "reasoning_tokens")
RUN_USAGE_MAX = 10 ** 12
# La conversación ya tiene otra ejecución en marcha (p. ej. dos cron solapados con el mismo conversation_id): no se lanza.
RUN_EXIT_BUSY = 7
# Perfil por defecto de --prompt cuando no se indica --profile.
DEFAULT_RUN_PROFILE = "local"
# Formato de --export según la extensión del fichero; la interfaz genera el contenido con ChatExport.
RUN_EXPORT_FORMATS = {".md": "markdown", ".json": "json", ".html": "html"}
# Cuerpo HTTP admitido mientras se espera la exportación: el JSON y el HTML llevan las imágenes incrustadas.
RUN_EXPORT_MAX_BODY_BYTES = 64 * 1024 * 1024
# Petición de --run-file: lo que quien lanza la ejecución fija en ella. Nunca lleva permisos, herramientas ni servicios
# MCP, que salen siempre del entorno guardado del proyecto, así que no puede ampliarlos.
RUN_FILE_TEXT_KEYS = ("conversation_id", "prompt", "profile", "agent")
# Límites opcionales de la ejecución: llamadas al modelo y segundos desde el arranque del proceso, con su máximo.
RUN_FILE_LIMIT_KEYS = {"maxSteps": 1000, "timeout": 24 * 60 * 60}
RUN_FILE_KEYS = frozenset(RUN_FILE_TEXT_KEYS + ("systemDataPrompt", "projectMode", "watchAgents", "reasoning") + tuple(RUN_FILE_LIMIT_KEYS))
# Lo que una conversación de agente guarda de su lanzamiento (además del perfil) y repite al continuarla.
RUN_LAUNCH_KEYS = ("systemDataPrompt", "projectMode", "watchAgents", "reasoning") + tuple(RUN_FILE_LIMIT_KEYS)
# Niveles de razonamiento de --run-file (los del selector de la interfaz) y el que usa si no indica ninguno.
RUN_REASONING_LEVELS = ("none", "low", "medium", "high", "xhigh")
DEFAULT_RUN_REASONING = "medium"
# Patrones de watchAgents que admite una ejecución (agentes que vigila con check_agents).
MAX_WATCH_AGENTS = 32
# El prompt acaba en la conversación, que se guarda por HTTP: no cabe uno mayor que el cuerpo admitido.
RUN_FILE_MAX_BYTES = MAX_HTTP_BODY_BYTES


# Procesos de ejecución (PID y huella de arranque) cuyo final espera un hilo, y los que ya terminaron: uno que lanzó
# otra instancia puede seguir figurando como vivo (zombi) hasta que lo recoge quien lo lanzó.
_EXIT_WATCHED: set[tuple[int, str | None]] = set()
_EXITED: set[tuple[int, str | None]] = set()
_EXIT_LOCK = threading.Lock()


def _run_request_object(raw: bytes) -> dict:
    """El objeto JSON de --run-file, sin pasar del tope ni llevar campos fuera de RUN_FILE_KEYS."""
    if len(raw) > RUN_FILE_MAX_BYTES:
        raise ValueError(f"no puede superar {RUN_FILE_MAX_BYTES} bytes")
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"no es JSON válido: {exc}") from exc
    if not isinstance(data, dict):
        raise ValueError("debe ser un objeto JSON")
    unknown = sorted(set(data) - RUN_FILE_KEYS)
    if unknown:
        raise ValueError(f"campos desconocidos: {', '.join(unknown)}")
    return data


def _agent_options(data: dict) -> dict:
    """projectMode (sin él, --run-file no inyecta AGENTS.md ni .zerochat/state.md: el agente sigue su propio manual),
    reasoning (el nivel de razonamiento de la ejecución, DEFAULT_RUN_REASONING si no lo indica) y watchAgents (los
    agentes que la ejecución puede consultar con check_agents)."""
    if "projectMode" in data and not isinstance(data["projectMode"], bool):
        raise ValueError("projectMode debe ser true o false")
    options = {"projectMode": data.get("projectMode", False)}
    reasoning = data.get("reasoning", DEFAULT_RUN_REASONING)
    if reasoning not in RUN_REASONING_LEVELS:
        raise ValueError(f"reasoning debe ser uno de: {', '.join(RUN_REASONING_LEVELS)}")
    options["reasoning"] = reasoning
    if "watchAgents" in data:
        patterns = data["watchAgents"]
        if not isinstance(patterns, list) or not 1 <= len(patterns) <= MAX_WATCH_AGENTS:
            raise ValueError(f"watchAgents debe ser una lista de 1 a {MAX_WATCH_AGENTS} patrones")
        options["watchAgents"] = list(dict.fromkeys(validate_agent_watch_pattern(pattern) for pattern in patterns))
    return options


def parse_run_request(raw: bytes) -> dict:
    """Valida el contenido de --run-file y devuelve sus campos limpios; ValueError con el motivo si no vale."""
    data = _run_request_object(raw)
    request = {}
    for key in RUN_FILE_TEXT_KEYS:
        if key in data:
            value = data[key]
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"{key} debe ser un texto no vacío")
            request[key] = value.strip()
    if "conversation_id" in request:
        request["conversation_id"] = _validate_conversation_id(request["conversation_id"])
    if "agent" in request:
        request["agent"] = validate_agent_id(request["agent"])
    if "systemDataPrompt" in data:
        if not isinstance(data["systemDataPrompt"], str):
            raise ValueError("systemDataPrompt debe ser un texto")
        request["systemDataPrompt"] = validate_project_prompt(data["systemDataPrompt"])
    request.update(_agent_options(data))
    for key, maximum in RUN_FILE_LIMIT_KEYS.items():
        if key in data:
            value = data[key]
            if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= maximum:
                raise ValueError(f"{key} debe ser un entero entre 1 y {maximum}")
            request[key] = value
    return request


def run_process_alive(data: dict) -> bool:
    """Comprueba si el proceso de una ejecución sigue activo y corresponde al arranque original."""
    pid = data.get("pid")
    saved_start = data.get("pid_start")
    with _EXIT_LOCK:
        if (pid, saved_start) in _EXITED:
            return False
    if not _pid_alive(pid):
        return False
    if saved_start:
        current_start = _process_start_token(pid)
        if current_start is not None and current_start != saved_start:
            return False
    return True


def watch_run_exit(pid: int, pid_start: str | None, proc: subprocess.Popen | None = None) -> None:
    """
    Espera en un hilo, sin sondeo, a que termine el proceso de una ejecución y avisa del cambio del estado vivo: su
    final (completada, a la espera del usuario o con error) ya está en SQLite cuando termina. Con proc, el que lanzó
    este servidor (start_server_run), lo espera con Popen.wait y así lo recoge; si no, por su PID.
    """
    key = (pid, pid_start)
    with _EXIT_LOCK:
        if key in _EXIT_WATCHED or key in _EXITED:
            return
        _EXIT_WATCHED.add(key)

    def wait():
        if proc is not None:
            proc.wait()
            exited = True
        else:
            exited = wait_pid_exit(pid, None)
        if exited is None:
            return  # No se puede esperar: se queda en _EXIT_WATCHED para no reintentarlo.
        with _EXIT_LOCK:
            _EXIT_WATCHED.discard(key)
            _EXITED.add(key)
        notify_live_change()

    threading.Thread(target=wait, name=f"run-exit-{pid}", daemon=True).start()


def write_run_state(session: RunSession) -> None:
    """Guarda atómicamente en SQLite el estado de la ejecución, si alguien la sigue (state_conversation_id)."""
    if not session.state_conversation_id:
        return
    now = int(time.time() * 1000)
    session.updated_at = now
    warnings = list(session.warnings)
    if session.warnings_omitted:
        warnings.append(f"… y {session.warnings_omitted} permiso(s) denegado(s) más")
    payload = {
        "run_id": session.run_id,
        "conversation_id": session.state_conversation_id,
        "pid": session.pid,
        "pid_start": session.pid_start,
        "started_at": session.started_at,
        "updated_at": session.updated_at,
        "status": session.status,
        "step_text": session.step_text,
        "pending": session.pending,
        "error": session.error,
        "finished_at": None if session.status == "running" else now,
        "result_text": session.result_text,
        "warnings": warnings,
        "usage": session.usage,
    }
    upsert_run_state(payload)


def discard_unstarted_run(session: RunSession | None) -> None:
    """Una ejecución que sale antes de lanzar su runner (proyecto sin entorno guardado, sin Node, sin puerto...) no deja
    fila en runs: borra la suya (la de su run_id; la de otra ejecución de la conversación no se toca)."""
    if session is None or session.runner_started or not session.state_conversation_id:
        return
    try:
        row = get_run_state(session.state_conversation_id)
    except (ValueError, sqlite3.Error, OSError):
        return
    if row and row.get("run_id") == session.run_id:
        remove_run_state(session.state_conversation_id)


def remove_run_state(conversation_id: str | None) -> None:
    """Elimina de SQLite el estado de la ejecución de la conversación al cancelarla."""
    if not conversation_id:
        return
    try:
        delete_run_state(conversation_id)
    except ValueError:
        pass  # Un identificador no válido nunca tuvo estado guardado.
    except (sqlite3.Error, OSError) as err:
        log_event(f"[zerochat] No se pudo borrar el estado de la ejecución de '{conversation_id}': {err}")


def list_server_runs(focus_conversation_id: str | None = None) -> tuple[list[dict], dict | None]:
    """
    Lee las ejecuciones en la tabla `runs` de SQLite. Si un proceso 'running' ya murió,
    lo marca como 'error'. Devuelve (runs, focus_run), donde runs es una lista ligera de las que no han
    terminado bien, ordenada por started_at, y focus_run es el detalle completo (también de una 'completed',
    con su respuesta y sus avisos) si coincide con focus_conversation_id.
    En un servidor de ejecución (--prompt o --conversation) devuelve ([], None) para que el propio
    worker no se bloquee ni omita el guardado de su conversación.
    """
    if RUN_SESSION is not None:
        return [], None
    entries = []
    clean_focus_id = focus_conversation_id.strip() if (isinstance(focus_conversation_id, str) and focus_conversation_id.strip()) else None

    for data in list_run_states():
        conv_id = data.get("conversation_id")
        if not conv_id or not isinstance(conv_id, str):
            continue

        status = data.get("status")
        if status == "running" and run_process_alive(data):
            watch_run_exit(data["pid"], data.get("pid_start"))
        elif status == "running":
            now = int(time.time() * 1000)
            status = "error"
            data["status"] = "error"
            data["error"] = "El proceso de ejecución terminó inesperadamente."
            data["updated_at"] = now
            data["finished_at"] = now
            # Aunque no se pueda guardar, el latido ya la entrega en error.
            try:
                upsert_run_state(data)
            except (sqlite3.Error, OSError) as err:
                log_event(f"[zerochat] No se pudo marcar en error la ejecución de '{conv_id}': {err}")

        light = {
            "conversation_id": conv_id,
            "run_id": data.get("run_id"),
            "status": status
        }
        started_at = data.get("started_at", 0)
        entries.append((started_at, light, data))

    # Filas sin conversación de ejecuciones que ya no siguen (fallaron antes de guardarla): no son de nadie.
    try:
        orphans = set(delete_orphan_run_states())
    except (sqlite3.Error, OSError) as err:
        log_event(f"[zerochat] No se pudieron limpiar las ejecuciones sin conversación: {err}")
        orphans = set()
    entries = [entry for entry in entries if entry[1]["conversation_id"] not in orphans]
    entries.sort(key=lambda item: item[0])
    # Las completadas solo interesan a quien sigue su conversación: el latido no las arrastra todas.
    runs = [item[1] for item in entries if item[1]["status"] != "completed"]

    focus_run = None
    if clean_focus_id:
        for _, _, full_data in entries:
            if full_data.get("conversation_id") == clean_focus_id:
                # La interfaz recarga la conversación grabada cuando cambia esta fecha (el runner graba cada paso).
                focus_run = {**full_data, "conversation_updated_at": _conversation_updated_at(clean_focus_id)}
                break

    return runs, focus_run


def _conversation_updated_at(conversation_id: str) -> int | None:
    try:
        return get_conversation_updated_at(conversation_id)
    except ValueError:
        return None


def _run_target(params: dict) -> tuple[str, dict, str]:
    """La conversación de la ejecución y el nombre de su perfil: el pedido o, si no, el de la conversación."""
    conv_id = params.get("conversation_id")
    if not isinstance(conv_id, str) or not conv_id.strip():
        raise ValueError("conversation_id requerido.")
    clean_conv_id = _validate_conversation_id(conv_id)
    conv = get_conversation(clean_conv_id)
    if conv is None:
        raise ValueError(f"Conversación '{clean_conv_id}' no encontrada.")
    # Una conversación de agente se reanuda con el perfil de su lanzamiento, no con el que pida la interfaz.
    launch = get_conversation_launch(clean_conv_id) if conv.get("agent") else None
    profile = (launch or {}).get("profile") or params.get("profile")
    if not isinstance(profile, str) or not profile.strip():
        conv_profile = conv.get("profileId")
        if not isinstance(conv_profile, str) or not conv_profile.strip():
            raise ValueError("profile requerido.")
        profile = conv_profile.strip()
    profile_entry = get_general_profile(profile) or get_general_profile_by_name(profile)
    if not profile_entry:
        raise ValueError(f"Perfil del servidor '{profile}' no encontrado.")
    return clean_conv_id, conv, profile_entry.get("name", profile.strip())


def check_no_active_run(conv_id: str, own_run_id: str | None = None):
    """Una conversación solo tiene una ejecución en marcha. `own_run_id` es la del proceso que pregunta: el hijo que
    lanza zerochat/run/start ya está anotado con su run_id antes de arrancar y no se cuenta como otra."""
    existing = get_run_state(conv_id)
    if existing and existing.get("status") == "running" and existing.get("run_id") != own_run_id and run_process_alive(existing):
        raise ValueError(f"Ya hay una ejecución en marcha para la conversación '{conv_id}'.")


def start_server_run(params: dict) -> dict:
    """Inicia una ejecución en segundo plano para una conversación, en su proyecto o, si no tiene, en la carpeta general."""
    if not isinstance(params, dict):
        raise ValueError("Parámetros no válidos.")
    clean_conv_id, conv, profile_name = _run_target(params)
    check_no_active_run(clean_conv_id)

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
        cwd=project or str(get_no_project_dir())
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
        "pending": None,
        "error": None
    }
    upsert_run_state(payload)
    watch_run_exit(proc.pid, payload["pid_start"], proc)

    return {"ok": True, "run_id": run_id, "conversation_id": clean_conv_id, "status": "running"}


def launch_run_file(request: dict, cwd: Path) -> dict:
    """
    Lanza `zerochat --run-file -` con la petición ya validada (con su conversation_id) en la carpeta cwd, separado de
    este proceso: no es un comando de run_command, así que sigue aunque esta ejecución termine. Su fila de runs queda
    en marcha con el run_id que recibe en ZEROCHAT_RUN_ID antes de que arranque. ValueError si no se puede lanzar.
    """
    conv_id = request["conversation_id"]
    check_no_active_run(conv_id)
    if not find_node_executable():
        raise ValueError(f"Se necesita {NODE_REQUIRED_MESSAGE} para lanzar agentes.")
    run_id = secrets.token_urlsafe(24)
    env = {key: value for key, value in os.environ.items() if key != "ZEROCHAT_RUN_SECURITY"}
    env["ZEROCHAT_RUN_ID"] = run_id
    proc = subprocess.Popen(
        [sys.executable, str(Path(__file__).resolve()), "--run-file", "-"],
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=DETECTED_OS != "windows" and hasattr(os, "setsid"),
        env=env,
        cwd=str(cwd),
    )
    now = int(time.time() * 1000)
    payload = {"run_id": run_id, "conversation_id": conv_id, "pid": proc.pid, "pid_start": _process_start_token(proc.pid),
               "started_at": now, "updated_at": now, "status": "running", "step_text": "", "pending": None, "error": None}
    upsert_run_state(payload)
    watch_run_exit(proc.pid, payload["pid_start"], proc)
    try:
        if proc.stdin is not None:
            proc.stdin.write(json.dumps(request, ensure_ascii=False).encode("utf-8"))
            proc.stdin.close()
    except OSError:
        pass  # Si el proceso ya terminó, su final queda en su fila (watch_run_exit) como el de cualquier ejecución.
    return {"run_id": run_id, "pid": proc.pid}


def cancel_server_run(conversation_id: str) -> dict:
    """Cancela una ejecución en segundo plano: termina el proceso si sigue en marcha y elimina su estado."""
    if not isinstance(conversation_id, str) or not conversation_id.strip():
        raise ValueError("conversation_id requerido.")
    clean_conv_id = _validate_conversation_id(conversation_id)
    data = get_run_state(clean_conv_id)
    if data:
        if data.get("status") == "running" and run_process_alive(data):
            _kill_process_tree(data.get("pid"), grace_seconds=0.05)
        remove_run_state(clean_conv_id)
    return {"cancelled": True}


def _approved_call(tool_security) -> tuple[str, dict] | None:
    """(nombre, argumentos) de tool_decision, la llamada que la persona aprobó al reanudar; None sin aprobación."""
    decision = tool_security.get("tool_decision") if isinstance(tool_security, dict) else None
    if not isinstance(decision, dict):
        return None
    tool_name, args, choice = decision.get("toolName"), decision.get("args"), decision.get("decision")
    choice = choice.get("decision") if isinstance(choice, dict) else choice
    if not isinstance(tool_name, str) or not tool_name or not isinstance(args, dict) or choice in (None, "deny"):
        return None
    return tool_name, args


class RunSession:
    """Estado de la ejecución: prompt, opciones, último progreso, exportación, resultado y motivo de un final sin él."""
    def __init__(self, prompt: str | None = None, profile: str | None = None, export_path: Path | None = None,
                 conversation_id: str | None = None, run_id: str | None = None,
                 tool_security: dict | None = None, profile_data: dict | None = None,
                 new_conversation_id: str | None = None, system_data_prompt: str | None = None,
                 max_steps: int | None = None, timeout_seconds: int | None = None, project_mode: bool | None = None,
                 agent: str | None = None, launch: dict | None = None, watch_agents: tuple[str, ...] = (),
                 track_run: bool = False, reasoning: str | None = None):
        env_run_id = os.environ.get("ZEROCHAT_RUN_ID", "").strip()
        self.run_id = run_id.strip() if (run_id and isinstance(run_id, str) and run_id.strip()) else (env_run_id or secrets.token_urlsafe(24))
        self.conversation_id = conversation_id
        # Sin --conversation, la conversación nueva que guarda la ejecución: la de --run-file o, si no, una que elige el
        # servidor (mismo formato que createId('session')). A ella se ata la credencial del runner, que no puede escribir
        # en ninguna otra.
        self.new_conversation_id = None if conversation_id else (new_conversation_id or f"session_{uuid.uuid4()}")
        # Conversación cuyo estado se guarda en la tabla runs: la que indicó quien lanzó la ejecución (--conversation o
        # --run-file), o cualquier ejecución con agent / --run-file aunque cree id nuevo; un --prompt suelto no deja fila.
        self.state_conversation_id = conversation_id or new_conversation_id or (self.new_conversation_id if (agent or track_run) else None)
        self.prompt = prompt
        # systemDataPrompt de --run-file: sustituye al del proyecto solo en esta ejecución (run_project_environment).
        self.system_data_prompt = system_data_prompt
        # agent de --run-file: marca la conversación nueva como de ese agente (run_conversation_meta).
        self.agent = agent
        # Petición de lanzamiento de un agente (--run-file): finish_run la guarda en su conversación.
        self.launch = launch
        # watchAgents de --run-file: habilita y autoriza check_agents solo en esta ejecución.
        self.watch_agents = tuple(watch_agents)
        # Conversaciones que este master lanzó con launch_agent ({id: {agent, project, updatedAt}}): check_agents las
        # ve desde el lanzamiento, antes de que el agente las guarde en conversations.
        self.launched_agents: dict[str, dict] = {}
        # projectMode de --run-file: si el runner inyecta las normas y el estado del proyecto; None (--prompt y
        # --conversation) deja el modo proyecto por defecto del runner.
        self.project_mode = project_mode
        # reasoning de --run-file (o de su lanzamiento al continuarla): el runner lo aplica tras activar el perfil;
        # None (--prompt, --conversation de un chat) deja el del perfil.
        self.reasoning = reasoning
        # Límites de --run-file: el de pasos lo aplica el bucle del runner y el de tiempo, run_supervisor.
        self.max_steps = max_steps
        self.timeout_seconds = timeout_seconds
        # Perfil (nombre o id) que la interfaz usa solo en esta ejecución; por defecto, local del servidor.
        self.profile = profile
        self.profile_data = profile_data
        # Fichero donde se escribe la conversación exportada (formato por su extensión); None, sin exportar.
        self.export_path = export_path
        self.exported = False
        self.export_error: str | None = None
        if tool_security is not None:
            self.tool_security = tool_security
        elif os.environ.get("ZEROCHAT_RUN_SECURITY"):
            try:
                self.tool_security = json.loads(os.environ["ZEROCHAT_RUN_SECURITY"])
            except (json.JSONDecodeError, TypeError):
                self.tool_security = None
        else:
            self.tool_security = None
        self._approved_call = _approved_call(self.tool_security)
        self.lock = threading.Lock()
        self.prompt_delivered = False
        self.result: dict | None = None
        self.stop_reason: str | None = None
        self.finished = threading.Event()
        self._wake: threading.Event | None = None
        self.pid = os.getpid()
        self.pid_start = _process_start_token(self.pid)
        self.started_at = int(time.time() * 1000)
        self.updated_at = self.started_at
        self.status = "running"
        self.step_text = ""
        self.pending: dict | None = None
        self.error: str | None = None
        self.result_text: str | None = None
        self.warnings: list[str] = []
        self.warnings_omitted = 0
        # Tokens acumulados que informa el runner (zerochat/run/usage); None hasta su primera llamada al modelo.
        self.usage: dict | None = None
        self.runner_token: str | None = None
        # Si llegó a lanzarse el runner de Node: antes de eso, salir no deja fila (discard_unstarted_run).
        self.runner_started = False
        write_run_state(self)

    def set_wake_event(self, event: threading.Event | None) -> None:
        """Asocia un evento compartido al que despertar cuando llegue el resultado."""
        with self.lock:
            self._wake = event
            if event is not None and self.finished.is_set():
                event.set()

    def add_warning(self, text: str) -> None:
        """Anota un permiso denegado: en la fila de runs, para quien sigue la ejecución, y en stderr, para una persona."""
        console_error(timestamp_message(f"[run] Permiso denegado: {text}"))
        with self.lock:
            if len(self.warnings) < RUN_WARNINGS_MAX:
                self.warnings.append(_capped(text, RUN_PROGRESS_TEXT_MAX))
            else:
                self.warnings_omitted += 1
            write_run_state(self)

    def reach_limit(self, message: str) -> bool:
        """Termina la ejecución en un límite, si no tenía ya resultado; despierta a quien la espera."""
        with self.lock:
            if self.result is not None:
                return False
            self.result = {"limit": message}
            self.status = "limit"
            self.error = message
            write_run_state(self)
        self.signal_finished()
        return True

    def signal_finished(self) -> None:
        """Marca la ejecución como terminada y despierta a quien la espera con set_wake_event."""
        self.finished.set()
        with self.lock:
            wake = self._wake
        if wake is not None:
            wake.set()

    def take_approved_call(self, tool_name: str, args: dict) -> bool:
        """Si es la llamada que la persona aprobó en la tarjeta pausada (mismo nombre y argumentos), la consume:
        su reto lo contesta este servidor, una sola vez, porque la credencial del runner no puede resolver retos."""
        with self.lock:
            if self._approved_call is None or self._approved_call != (tool_name, args):
                return False
            self._approved_call = None
            return True


RUN_SESSION: RunSession | None = None


def set_run_session(session: RunSession | None):
    """Fija la ejecución desatendida de este proceso (None si atiende a la interfaz)."""
    global RUN_SESSION
    RUN_SESSION = session


def current_run_session() -> RunSession | None:
    """Ejecución desatendida de este proceso, o None si atiende a la interfaz."""
    return RUN_SESSION


def run_project_environment(env: dict) -> dict:
    """El entorno del proyecto que recibe la interfaz: en una ejecución con systemDataPrompt propio, ese en lugar del
    guardado, sin escribirlo en SQLite."""
    session = RUN_SESSION
    if session is None or session.system_data_prompt is None:
        return env
    return {**env, "systemDataPrompt": session.system_data_prompt}


def run_conversation_meta(session_meta):
    """La cabecera de una conversación que se guarda en una ejecución: añade `agent` a la nueva y, si tiene `launch`
    (--run-file con agente, nueva o continuada), incluye `launch`, `serverRun` y `profileId` desde el primer guardado."""
    session = RUN_SESSION
    if session is None or not isinstance(session_meta, dict):
        return session_meta
    target_id = session.conversation_id or session.new_conversation_id
    if not target_id or session_meta.get("id") != target_id:
        return session_meta
    patched = dict(session_meta)
    if session.agent and session_meta.get("id") == session.new_conversation_id:
        patched["agent"] = session.agent
    if session.launch:
        patched["launch"] = session.launch
        patched["serverRun"] = True
        if session.profile:
            patched["profileId"] = session.profile
    return patched


def http_body_limit() -> int:
    """Tope del cuerpo que se lee: el general, o el de la exportación mientras se espera (ff-server
    rechaza después cualquier otro método que supere el general)."""
    session = RUN_SESSION
    if session is not None and session.export_path is not None and not session.exported:
        return RUN_EXPORT_MAX_BODY_BYTES
    return MAX_HTTP_BODY_BYTES


def _rpc_start(params: dict, _ctx: SecurityContext, session: RunSession | None) -> RpcOutcome:
    if session is not None:
        return rpc_error(METHOD_NOT_FOUND, "No disponible dentro de un proceso de ejecución.")
    try:
        return rpc_result(start_server_run(params))
    except ValueError as exc:
        return rpc_error(INVALID_PARAMS, str(exc))
    except OSError as exc:
        return rpc_error(INTERNAL_ERROR, f"Error al iniciar ejecución en servidor: {exc}", str(exc))


def _rpc_cancel(params: dict, ctx: SecurityContext, session: RunSession | None) -> RpcOutcome:
    if session is not None:
        return rpc_error(METHOD_NOT_FOUND, "No disponible dentro de un proceso de ejecución.")
    try:
        return rpc_result(cancel_server_run(params.get("conversation_id")))
    except ValueError as exc:
        return rpc_error(INVALID_PARAMS, str(exc))
    except OSError as exc:
        return rpc_error(INTERNAL_ERROR, f"Error al cancelar ejecución en servidor: {exc}", str(exc))


def _rpc_prompt(params: dict, session: RunSession) -> RpcOutcome:
    with session.lock:
        if session.prompt_delivered:
            return rpc_error(INVALID_PARAMS, "El prompt ya se entregó.")
        session.prompt_delivered = True
    export_format = RUN_EXPORT_FORMATS[session.export_path.suffix.lower()] if session.export_path else None
    # tool_security lo aplica este servidor: las políticas (reset_session_authorizations) y la llamada aprobada en la
    # tarjeta pausada (take_approved_call), así que el runner no recibe nada de él.
    return rpc_result({"prompt": session.prompt, "conversation_id": session.conversation_id,
                       "new_conversation_id": session.new_conversation_id, "profile": session.profile,
                       "profile_data": session.profile_data,
                       # Para switch_model, que busca por nombre: el runner no puede listar los perfiles con su credencial.
                       # El listado no lleva API keys; la del que active la pide con zerochat/run/profile.
                       "profiles": list_general_profiles(),
                       "export": export_format, "max_steps": session.max_steps, "project_mode": session.project_mode,
                       "reasoning": session.reasoning})


def _rpc_profile(params: dict, session: RunSession) -> RpcOutcome:
    """Un perfil del servidor con su API key, para el runner que lo activa con switch_model; queda en el registro."""
    profile_id = params.get("id")
    profile = get_general_profile_with_key(profile_id) if isinstance(profile_id, str) else None
    if profile is None:
        return rpc_error(INVALID_PARAMS, "Perfil del servidor no encontrado.")
    log_event(f"[run] Se entrega al runner el perfil {profile['name']} con su clave")
    return rpc_result({"profile": profile})


def _capped(text: str, limit: int) -> str:
    return text[:limit] + ("…" if len(text) > limit else "")


def _rpc_progress(params: dict, session: RunSession) -> RpcOutcome:
    kind = params.get("kind")
    text = params.get("text", "")
    if not isinstance(kind, str) or not RUN_PROGRESS_KIND_PATTERN.fullmatch(kind) or not isinstance(text, str):
        return rpc_error(INVALID_PARAMS, "Progreso no válido.")
    truncated_step = _capped(text, RUN_PROGRESS_TEXT_MAX)
    log_event(f"[run] {kind}{': ' + truncated_step if truncated_step else ''}")
    with session.lock:
        session.step_text = truncated_step
        write_run_state(session)
    return rpc_result({"ok": True})


def _rpc_usage(params: dict, session: RunSession) -> RpcOutcome:
    """Tokens acumulados de la ejecución hasta su último paso: el runner los manda tras cada llamada al modelo, así
    que quedan en la fila aunque la ejecución se corte por tiempo o muera."""
    usage = {key: params.get(key) for key in RUN_USAGE_COUNTERS}
    estimated = params.get("estimated")
    if any(isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= RUN_USAGE_MAX
           for value in usage.values()) or not isinstance(estimated, bool):
        return rpc_error(INVALID_PARAMS, "Consumo no válido.")
    with session.lock:
        session.usage = {**usage, "estimated": estimated}
        write_run_state(session)
    return rpc_result({"ok": True})


def _rpc_export(params: dict, session: RunSession) -> RpcOutcome:
    content = params.get("content")
    if session.export_path is None or not isinstance(content, str):
        return rpc_error(INVALID_PARAMS, "Exportación no pedida o sin contenido.")
    with session.lock:
        if session.exported:
            return rpc_error(INVALID_PARAMS, "La exportación ya se recibió.")
        try:
            session.export_path.write_text(content, encoding="utf-8")
        except OSError as exc:
            session.export_error = f"No se pudo escribir {session.export_path}: {exc}"
            return rpc_error(INTERNAL_ERROR, session.export_error)
        session.exported = True
    log_event(f"[run] Conversación exportada en {session.export_path}")
    return rpc_result({"ok": True})


def _rpc_result(params: dict, session: RunSession) -> RpcOutcome:
    text = params.get("text")
    error = params.get("error")
    needs_input = params.get("needs_input")
    is_text = isinstance(text, str) and error is None and needs_input is None
    is_error = isinstance(error, str) and bool(error) and text is None and needs_input is None
    limit = params.get("limit")
    is_needs_input = (isinstance(needs_input, dict) and needs_input.get("kind") in RUN_NEEDS_INPUT_KINDS
                      and isinstance(needs_input.get("text"), str) and text is None and error is None)
    # El único límite que ve el runner es el de pasos; el de tiempo lo aplica este servidor.
    is_limit = limit == "steps" and session.max_steps is not None and text is None and error is None and needs_input is None
    if limit is not None and not is_limit:
        return rpc_error(INVALID_PARAMS, "limit solo puede ser steps en una ejecución con maxSteps.")
    if is_limit:
        if not session.reach_limit(f"Límite de {session.max_steps} pasos alcanzado."):
            return rpc_error(INVALID_PARAMS, "El resultado ya se recibió.")
        return rpc_result({"ok": True})
    if not (is_text or is_error or is_needs_input):
        return rpc_error(INVALID_PARAMS, "El resultado lleva text, error, needs_input con kind y text, o limit.")
    with session.lock:
        if session.result is not None:
            return rpc_error(INVALID_PARAMS, "El resultado ya se recibió.")
        if is_text:
            session.result = {"text": text}
            session.status = "completed"
            session.result_text = text
            write_run_state(session)
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
    session.signal_finished()
    return rpc_result({"ok": True})


# La interfaz del servidor principal lanza y detiene ejecuciones; la de una ejecución (con su run_id) le
# pide el prompt e informa del progreso, la exportación y el resultado.
RUN_CONTROL_METHODS = {"zerochat/run/start": _rpc_start, "zerochat/run/cancel": _rpc_cancel}
RUN_SESSION_METHODS = {
    "zerochat/run/prompt": _rpc_prompt,
    "zerochat/run/profile": _rpc_profile,
    "zerochat/run/progress": _rpc_progress,
    "zerochat/run/usage": _rpc_usage,
    "zerochat/run/export": _rpc_export,
    "zerochat/run/result": _rpc_result,
}


def dispatch_run(method: str, params: dict, ctx: SecurityContext) -> RpcOutcome:
    """Métodos zerochat/run/*: el control de ejecuciones y los de la interfaz abierta por el modo ejecución."""
    params = params if isinstance(params, dict) else {}
    session = RUN_SESSION
    if method in RUN_CONTROL_METHODS:
        return RUN_CONTROL_METHODS[method](params, ctx, session)
    if session is None:
        return rpc_error(METHOD_NOT_FOUND, "El servidor no está en modo ejecución.")
    run_id = params.get("run_id")
    if not isinstance(run_id, str) or not hmac.compare_digest(run_id, session.run_id):
        return rpc_error(INVALID_PARAMS, "run_id no válido.")
    return dispatch_table(RUN_SESSION_METHODS, method, params, session)


def run_error(message: str):
    """Motivo de un final sin respuesta: va a stderr aunque el registro esté desactivado (--log off)."""
    session = RUN_SESSION
    if session is not None and session.result is None:
        with session.lock:
            session.status = "error"
            session.error = message
            write_run_state(session)
    console_error(timestamp_message(f"[run] {message}"))


def announce_run_conversation(session: RunSession):
    """
    Con --run-file, una línea en stderr (también con --log off) con la conversación de la ejecución, para que un
    orquestador de shell la siga sin HTTP: `[run] conversation_id=<id> new=<true|false>`, nueva si no existía.
    """
    console_error(f"[run] conversation_id={session.conversation_id or session.new_conversation_id} "
                  f"new={'false' if session.conversation_id else 'true'}")


def run_outcome(session: RunSession) -> tuple[int, str | None]:
    """
    Código de salida y texto para stdout: la respuesta final o, si se pausó, lo que espera del usuario; el motivo de un
    fallo va a stderr. Una exportación pedida que no se escribió convierte un final correcto en error sin quitar la respuesta.
    """
    if session.export_path and not session.exported:
        run_error(session.export_error or f"La interfaz no envió la conversación para {session.export_path}.")
    if session.result is None:
        run_error(session.stop_reason or session.error or "El runner se cerró o la ejecución se interrumpió sin resultado.")
        return RUN_EXIT_NO_RESULT, None
    if "limit" in session.result:
        console_error(timestamp_message(f"[run] {session.result['limit']} Lo hecho queda grabado en la conversación."))
        return RUN_EXIT_LIMIT, None
    if "error" in session.result:
        run_error(f"Error de generación: {session.result['error']}")
        return RUN_EXIT_ERROR, None
    if "needs_input" in session.result:
        pending = session.result["needs_input"]
        console_error(timestamp_message("[run] Ejecución pausada a la espera del usuario."))
        if pending["kind"] == "tool_approval":
            return RUN_EXIT_NEEDS_INPUT, f"Pendiente de aprobar la herramienta {pending['text']}."
        return RUN_EXIT_NEEDS_INPUT, pending["text"]
    log_event("[run] Ejecución terminada.")
    if session.export_path and not session.exported:
        return RUN_EXIT_ERROR, session.result["text"]
    return RUN_EXIT_DONE, session.result["text"]


# Versión mínima de Node.js para el runner: el modelo de permisos es estable desde la 22.13 (M65-D1).
NODE_MINIMUM_VERSION = (22, 13)
NODE_REQUIRED_MESSAGE = f"Node.js {'.'.join(map(str, NODE_MINIMUM_VERSION))} o superior"


def find_node_executable() -> str | None:
    """Localiza un ejecutable de Node.js en PATH y comprueba su versión mínima."""
    executable = shutil.which("node")
    if not executable:
        return None
    try:
        res = subprocess.run([executable, "--version"], capture_output=True, text=True, timeout=15)
        if res.returncode != 0:
            return None
        match = re.search(r"v?(\d+)\.(\d+)\.", res.stdout.strip())
        if not match or (int(match.group(1)), int(match.group(2))) < NODE_MINIMUM_VERSION:
            return None
        return executable
    except (OSError, subprocess.SubprocessError):
        return None

# --- storage.rpc ---
"""Métodos JSON-RPC de los datos guardados en SQLite: perfiles del servidor, conversaciones y blobs."""





def _guarded(handlers: dict, method: str, params: dict, failure: str) -> RpcOutcome:
    """Atiende el método con su tabla; un ValueError es un parámetro no válido y otro fallo, un error interno."""
    try:
        return dispatch_table(handlers, method, params)
    except ValueError as exc:
        return rpc_error(INVALID_PARAMS, str(exc))
    except Exception as exc:
        return rpc_error(INTERNAL_ERROR, f"{failure}: {exc}", str(exc))


# --- Perfiles del servidor -------------------------------------------------------------


def _save_profile(params: dict) -> RpcOutcome:
    profile_data = params.get("profile")
    if not isinstance(profile_data, dict):
        return rpc_error(INVALID_PARAMS, "profile debe ser un objeto.")
    return rpc_result({"profile": save_general_profile(profile_data)})


def _delete_profile(params: dict) -> RpcOutcome:
    profile_id = params.get("id")
    if not isinstance(profile_id, str) or not profile_id.strip():
        return rpc_error(INVALID_PARAMS, "id debe ser un texto no vacío.")
    return rpc_result({"deleted": delete_general_profile(profile_id)})


def _reveal_profile(params: dict) -> RpcOutcome:
    """El perfil con su API key bajo demanda cuando la interfaz ejecuta en el navegador o edita un perfil
    cuya clave solo está en el servidor (docs/M75-apikeys.md), y deja constancia en el registro."""
    profile_id = params.get("id")
    profile = get_general_profile_with_key(profile_id) if isinstance(profile_id, str) else None
    if profile is None:
        return rpc_error(INVALID_PARAMS, "Perfil del servidor no encontrado.")
    log_event(f"Se entrega a la interfaz el perfil del servidor {profile['name']} con su clave")
    return rpc_result({"profile": profile})


# El listado y lo que devuelve guardar no llevan la API key, solo hasApiKey.
PROFILE_METHODS = {
    "zerochat/profiles/list": lambda _params: rpc_result({"profiles": list_general_profiles()}),
    "zerochat/profiles/reveal": _reveal_profile,
    "zerochat/profiles/save": _save_profile,
    "zerochat/profiles/delete": _delete_profile,
}


def dispatch_profiles(method: str, params: dict) -> RpcOutcome:
    """Perfiles generales almacenados en SQLite en el backend local."""
    return _guarded(PROFILE_METHODS, method, params if isinstance(params, dict) else {}, "Error en gestión de perfiles")


# --- Conversaciones --------------------------------------------------------------------


def _cancel_runs(conversation_ids):
    """Borrar una conversación detiene su ejecución en servidor, si la hay."""
    for conversation_id in conversation_ids:
        try:
            cancel_server_run(conversation_id)
        except (ValueError, OSError):
            pass


def _rpc_delete_conversations(params: dict) -> RpcOutcome:
    # En bloque, un solo historial (agents: chats o agentes) de un proyecto o de todos.
    if params.get("all") is True or "project" in params:
        deleted_ids = delete_conversations(None if params.get("all") is True else params.get("project"), params.get("agents"))
        _cancel_runs(deleted_ids)
        return rpc_result({"deleted": True, "count": len(deleted_ids)})
    conv_id = params.get("id")
    if isinstance(conv_id, str) and conv_id.strip():
        _cancel_runs([conv_id])
    return rpc_result({"deleted": delete_conversation(params.get("id"))})


def _rpc_save_conversation(params: dict) -> RpcOutcome:
    if not isinstance(params, dict):
        raise ValueError("Los parámetros deben ser un objeto")
    upload_id = params.get("uploadId")
    raw_conv = params.get("conversation")
    if isinstance(raw_conv, dict) and "launch" in raw_conv:
        raw_conv = {k: v for k, v in raw_conv.items() if k != "launch"}
    conversation = run_conversation_meta(raw_conv)
    if upload_id is not None:
        if params.get("messages") is not None:
            raise ValueError("No se puede combinar uploadId y messages")
        return rpc_result({"conversation": commit_conversation_upload(conversation, upload_id)})
    return rpc_result({"conversation": save_conversation(conversation, params.get("messages"))})


def _rpc_rename_conversation(params: dict) -> RpcOutcome:
    conv_id = params.get("id")
    renamed = rename_conversation(conv_id, params.get("title"))
    updated_at = get_conversation_updated_at(conv_id) if renamed and isinstance(conv_id, str) else None
    return rpc_result({"renamed": renamed, **({"updatedAt": updated_at} if updated_at is not None else {})})


CONVERSATION_METHODS = {
    "zerochat/conversations/list": lambda _params: rpc_result({"conversations": list_conversations()}),
    "zerochat/conversations/get": lambda params: rpc_result({"conversation": get_conversation(params.get("id"))}),
    "zerochat/conversations/save": _rpc_save_conversation,
    "zerochat/conversations/save_chunk": lambda params: rpc_result(save_conversation_chunk(params)),
    "zerochat/conversations/cancel_upload": lambda params: rpc_result(cancel_conversation_upload(params)),
    "zerochat/conversations/rename": _rpc_rename_conversation,
    "zerochat/conversations/delete": _rpc_delete_conversations,
}


def dispatch_conversations(method: str, params: dict) -> RpcOutcome:
    """Conversaciones y mensajes almacenados en SQLite en el backend local."""
    return _guarded(CONVERSATION_METHODS, method, params, "Error en gestión de conversaciones")


# --- Blobs (imágenes y adjuntos, aparte de los mensajes) ----------------------------------


def _put_blob(params: dict) -> RpcOutcome:
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
        raise ValueError(f"Error decodificando base64: {decode_err}") from decode_err
    saved = put_blob(data_bytes, mime_type=mime_type, blob_id=params.get("id"))
    return rpc_result({"id": saved["id"], "mimeType": saved["mime_type"], "size": saved["size"]})


def _get_blob(params: dict) -> RpcOutcome:
    blob = get_blob(params.get("id"))
    if not blob:
        return rpc_result({"blob": None})
    return rpc_result({
        "blob": {
            "id": blob["id"],
            "mimeType": blob["mime_type"],
            "size": blob["size"],
            "data": base64.b64encode(blob["data"]).decode("ascii"),
            "createdAt": blob["created_at"],
        }
    })


BLOB_METHODS = {
    "zerochat/blobs/has": lambda params: rpc_result(has_blobs(params.get("ids") if params.get("ids") is not None else [])),
    "zerochat/blobs/put": _put_blob,
    "zerochat/blobs/get": _get_blob,
}


def dispatch_blobs(method: str, params: dict) -> RpcOutcome:
    """Blobs desacoplados de los mensajes (imágenes y adjuntos) en SQLite."""
    return _guarded(BLOB_METHODS, method, params if isinstance(params, dict) else {}, "Error en gestión de blobs")

# --- tools.common ---
"""Utilidades comunes de las herramientas locales: el resultado de error, la escritura atómica de archivos y la
búsqueda de textos separados por | (check_command y search_files)."""




def _tool_error(message: str, **extra) -> str:
    """Serializa el resultado de error común de las herramientas locales."""
    return json.dumps({"success": False, "error": message, **extra}, ensure_ascii=False)


def text_terms(query: str) -> tuple[str, ...]:
    """Textos de una consulta separados por | ('error|listening on'), en minúsculas y sin los vacíos."""
    return tuple(term.strip().lower() for term in query.split("|") if term.strip())


def line_matches(line: str, terms: tuple[str, ...]) -> bool:
    """Si la línea contiene alguno de los textos, sin distinguir mayúsculas. Es texto, no una expresión
    regular: el tiempo es lineal y ninguna entrada puede bloquear el servidor (re no suelta el GIL)."""
    lowered = line.lower()
    return any(term in lowered for term in terms)


def _atomic_write_text(target: Path, text: str):
    """Sustituye el archivo de una vez para no dejarlo a medias si la escritura falla."""
    temp_path = target.with_suffix(target.suffix + f".tmp_{os.getpid()}_{time.time_ns()}")
    with open(temp_path, "w", encoding="utf-8") as f:
        f.write(text)
    temp_path.replace(target)

# --- tools.browser_action ---
"""Herramienta browser_action: una sesión persistente de Playwright con los motores propios o el navegador del sistema."""




BROWSER_ACTIONS = ("navigate", "screenshot", "click", "fill")


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
        // Con la máquina cargada, Chromium puede no haber pintado aún ningún fotograma:
        // esperar dos fotogramas garantiza que hay algo que capturar.
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
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

# --- tools.browser_secret ---
"""Relleno seguro de secretos del proyecto en Playwright MCP sin exponer valores al modelo."""





BROWSER_SECRET_MODES = ("input", "keypad")


def _scrub_secret(text: str, secret_value: str) -> str:
    return text.replace(secret_value, "***") if secret_value and text else text


def _mcp_call_error(tool_name: str, arguments: dict, secret_value: str) -> str | None:
    result = GLOBAL_MCP_MANAGER.call(public_tool_name(PLAYWRIGHT_SERVER_ID, tool_name), arguments)
    if not (isinstance(result, dict) and result.get("isError")):
        return None
    parts = [str(item.get("text") or "") for item in (result.get("content") or []) if isinstance(item, dict)]
    detail = _scrub_secret(" ".join(p for p in parts if p).strip(), secret_value)
    return detail or f"Playwright {tool_name} failed."


def _fill_input_secret(secret_value: str, ref: str, element: str, submit: bool) -> str | None:
    clean_ref = ref.strip() if isinstance(ref, str) else ""
    if not clean_ref:
        return "El modo 'input' requiere un 'ref' no vacío."
    label = element.strip() if isinstance(element, str) and element.strip() else "input field"
    return _mcp_call_error("browser_type", {
        "element": label,
        "target": clean_ref,
        "text": secret_value,
        "submit": bool(submit),
    }, secret_value)


def _is_xy_target(target) -> bool:
    if not isinstance(target, (list, tuple)) or len(target) != 2:
        return False
    return all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in target)


def _click_keypad_target(target, secret_value: str) -> str | None:
    if isinstance(target, str) and target.strip():
        return _mcp_call_error("browser_click", {"element": "keypad button", "target": target.strip()}, secret_value)
    if _is_xy_target(target):
        return _mcp_call_error("browser_mouse_click_xy", {
            "x": float(target[0]),
            "y": float(target[1]),
        }, secret_value)
    return "Cada entrada de keypad_map debe ser un 'ref' de texto o coordenadas [x, y]."


def _fill_keypad_secret(secret_value: str, keypad_map) -> str | None:
    if not isinstance(keypad_map, dict) or not keypad_map:
        return "El modo 'keypad' requiere un objeto keypad_map no vacío."
    if any(ch not in keypad_map for ch in secret_value):
        return "keypad_map no cubre todos los caracteres del secreto."
    for ch in secret_value:
        err = _click_keypad_target(keypad_map[ch], secret_value)
        if err:
            return err
    return None


def browser_fill_secret(
    secret: str,
    mode: str,
    ref: str = "",
    element: str = "",
    submit: bool = False,
    keypad_map: dict | None = None,
    ctx: SecurityContext | None = None,
) -> str:
    """Introduce un secreto guardado del proyecto en un campo input o teclado virtual de Playwright MCP."""
    if ctx is None:
        return _tool_error("Se requiere contexto de proyecto para leer secretos.")
    if mode not in BROWSER_SECRET_MODES:
        return _tool_error(f"Modalidad no válida: {mode}")
    try:
        secret_value = get_project_secret(ctx.key, secret)
    except ValueError as exc:
        return _tool_error(str(exc))
    if secret_value is None:
        return _tool_error(f"El secreto '{secret}' no está guardado en este proyecto.")
    try:
        err = (
            _fill_input_secret(secret_value, ref, element, submit)
            if mode == "input"
            else _fill_keypad_secret(secret_value, keypad_map)
        )
    except Exception as exc:
        return _tool_error(f"Error ejecutando Playwright MCP: {_scrub_secret(str(exc), secret_value)}")
    if err:
        return _tool_error(err)
    payload: dict = {"success": True, "mode": mode, "secret": secret}
    if mode == "keypad":
        payload["steps"] = len(secret_value)
    return json.dumps(payload)

# --- tools.diff ---
"""Visor de diferencias (zerochat/diff/open): diff frente a Git HEAD en HTML propio o con git difftool."""





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


# Árbol vacío de Git: la base del diff del primer commit de un archivo.
GIT_EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
# Un archivo que no está en HEAD se compara entero con /dev/null.
NEW_FILE_REVISIONS = ["--no-index"]


def _git_succeeds(git_bin: str, repo_root: Path, *args: str) -> bool:
    return subprocess.run(
        [git_bin, *args], cwd=str(repo_root), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5, check=False
    ).returncode == 0


def _git_tracked_file(path: str, ctx: SecurityContext) -> tuple[Path, str, Path]:
    """Valida el archivo del diff y devuelve (archivo, git, raíz de su repositorio)."""
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
            [git_bin, "rev-parse", "--show-toplevel"], cwd=str(target.parent), capture_output=True, text=True, timeout=5, check=False
        )
    except Exception as err:
        raise RuntimeError(f"Error comprobando repositorio Git: {err}") from err
    if res.returncode != 0:
        raise ValueError(f"El archivo '{target.name}' no pertenece a ningún repositorio Git.")
    return target, git_bin, Path(res.stdout.strip()).resolve()


def _repo_relative(target: Path, repo_root: Path) -> str | None:
    try:
        return target.relative_to(repo_root).as_posix()
    except ValueError:
        return None


def _working_tree_state(git_bin: str, repo_root: Path, target: Path, rel_path: str | None) -> tuple[bool, bool]:
    """(está en HEAD, tiene cambios sin confirmar). Un archivo que no está en HEAD cuenta como cambiado entero."""
    if rel_path is None or not _git_succeeds(git_bin, repo_root, "rev-parse", "--verify", "HEAD"):
        return False, True
    if not _git_succeeds(git_bin, repo_root, "cat-file", "-e", f"HEAD:{rel_path}"):
        return False, True
    diff_check = subprocess.run([git_bin, "diff", "--quiet", "HEAD", "--", str(target)], cwd=str(repo_root), timeout=5, check=False)
    return True, diff_check.returncode != 0


def _last_commit_of(git_bin: str, repo_root: Path, rel_path: str) -> str:
    res = subprocess.run(
        [git_bin, "log", "-n", "1", "--format=%H", "--", rel_path], cwd=str(repo_root), capture_output=True, text=True, timeout=5, check=False
    )
    return res.stdout.strip() if res.returncode == 0 else ""


def _commit_range(git_bin: str, repo_root: Path, commit: str) -> list[str]:
    """Las dos revisiones del diff de un commit: su padre, o el árbol vacío si es el primero, y él mismo."""
    parent = f"{commit}~1"
    return [parent if _git_succeeds(git_bin, repo_root, "rev-parse", "--verify", parent) else GIT_EMPTY_TREE, commit]


def _no_diff_result(target: Path, in_head: bool, last_commit: str) -> dict:
    return {
        "success": True,
        "has_diff": False,
        "in_head": in_head,
        "has_commit_history": bool(last_commit),
        "last_commit": last_commit or None,
        "path": str(target)
    }


def _diff_revisions(git_bin: str, repo_root: Path, target: Path, rel_path: str | None,
                    commit_fallback: bool) -> tuple[list[str] | None, bool, str]:
    """Qué comparar: los argumentos de revisión de git diff/difftool (sin el archivo), si está en HEAD y el commit.

    Con cambios sin confirmar se compara con HEAD (o con nada si el archivo es nuevo); sin ellos, con commit_fallback,
    el último commit del archivo. None si no hay nada que comparar.
    """
    in_head, changed = _working_tree_state(git_bin, repo_root, target, rel_path)
    if changed:
        return (["HEAD"] if in_head else NEW_FILE_REVISIONS), in_head, ""
    last_commit = _last_commit_of(git_bin, repo_root, rel_path or target.name)
    if not commit_fallback or not last_commit:
        return None, in_head, last_commit
    return _commit_range(git_bin, repo_root, last_commit), in_head, last_commit


def _diff_command(base: list[str], target: Path, *, prefix: list[str]) -> list[str]:
    """git diff/difftool con las revisiones de _diff_revisions; un archivo nuevo se compara con /dev/null."""
    if base == NEW_FILE_REVISIONS:
        return [*prefix, "--no-index", "--", os.devnull, str(target)]
    return [*prefix, *base, "--", str(target)]


def _open_gui_file_diff(path: str, ctx: SecurityContext, commit_fallback: bool = False) -> dict:
    """Abre un visor externo de diffs (git difftool) en una ventana del sistema operativo."""
    target, git_bin, repo_root = _git_tracked_file(path, ctx)
    if not _configured_gui_diff_tool(git_bin, repo_root):
        return {"success": False, "setup": detect_gui_diff_tool()}
    rel_path = _repo_relative(target, repo_root)
    base, in_head, last_commit = _diff_revisions(git_bin, repo_root, target, rel_path, commit_fallback)
    if base is None:
        return _no_diff_result(target, in_head, last_commit)
    mode = "commit" if last_commit else "working_tree"
    cmd = _diff_command(base, target, prefix=[git_bin, "difftool", "--no-prompt", "--gui"])

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
    target, git_bin, repo_root = _git_tracked_file(path, ctx)
    rel_path = _repo_relative(target, repo_root)
    base, in_head, last_commit = _diff_revisions(git_bin, repo_root, target, rel_path, commit_fallback)
    if base is None:
        return _no_diff_result(target, in_head, last_commit)
    mode = "commit" if last_commit else "working_tree"
    cmd = _diff_command(base, target, prefix=[git_bin, "diff", f"-U{context_lines}"])
    diff_text = subprocess.run(cmd, cwd=str(repo_root), capture_output=True, text=True, timeout=10, check=False).stdout
    if not diff_text.strip():
        return _no_diff_result(target, in_head, last_commit)
    rel_path = rel_path or target.name
    html_content = render_diff_html(
        diff_text=diff_text,
        filename=target.name,
        rel_path=rel_path,
        mode=mode,
        commit=last_commit or None,
        full_file_bytes=_full_file_bytes(git_bin, repo_root, target, rel_path, last_commit)
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


def _full_file_bytes(git_bin: str, repo_root: Path, target: Path, rel_path: str, commit: str) -> bytes | None:
    """El archivo entero para el visor: el del commit si se muestra uno, si no el del disco (hasta 5 MB)."""
    if commit:
        show_res = subprocess.run([git_bin, "show", f"{commit}:{rel_path}"], cwd=str(repo_root), capture_output=True, timeout=5, check=False)
        if show_res.returncode == 0:
            return show_res.stdout
    try:
        if target.is_file() and target.stat().st_size <= 5_000_000:
            return target.read_bytes()
    except OSError:
        pass
    return None


def open_file_diff(path: str, ctx: SecurityContext, commit_fallback: bool = False, gui: bool = False, context_lines: int = DIFF_CONTEXT_LINES) -> dict:
    """Obtiene el diff de un archivo asociado a Git.

    Por defecto genera el diff con el visor propio de ZeroChat (HTML y texto), apto para
    ejecución local y remota sin depender de visores gráficos instalados en el sistema operativo.
    Con `gui=True` lanza el visor gráfico externo configurado en Git (difftool).
    """
    if gui:
        return _open_gui_file_diff(path, ctx, commit_fallback)
    return generate_file_diff(path, ctx, commit_fallback, context_lines=context_lines)

# --- tools.job_waits ---
"""Esperas de check_command a un comando: vuelven cuando termina, cuando una línea nueva de su salida contiene un
texto o al agotar el plazo, que es un máximo. La persona puede cortarlas con la clave de la invocación."""





class _WakeableJob(typing.Protocol):
    """Lo que una espera necesita del comando (CommandJob): despertar a quien espera su salida."""

    def wake_waiters(self) -> None: ...


class CancellableWaits:
    """Esperas en curso, por la clave de su invocación: zerochat/jobs/end_wait corta la de esa clave."""

    def __init__(self):
        self._lock = threading.Lock()
        self._waits: dict[str, tuple[threading.Event, _WakeableJob]] = {}

    def open(self, key: str | None, job: _WakeableJob) -> threading.Event:
        """Registra una espera que se puede cortar con cancel(key); sin clave no se puede cortar."""
        event = threading.Event()
        if key:
            with self._lock:
                self._waits[key] = (event, job)
        return event

    def close(self, key: str | None):
        if key:
            with self._lock:
                self._waits.pop(key, None)

    def cancel(self, key) -> bool:
        """Corta la espera con esa clave y despierta al hilo que espera en job._changed."""
        with self._lock:
            entry = self._waits.get(key) if isinstance(key, str) else None
        if entry is None:
            return False
        event, job = entry
        event.set()
        job.wake_waiters()
        return True


WAITS = CancellableWaits()


def _wait_job(job, wait: float, terms: tuple[str, ...] | None, cancel: threading.Event) -> tuple[str, str | None]:
    """Espera a que termine el comando (CommandJob), a que una línea nueva de su salida contenga alguno de terms
    o a que pase wait.

    Recorre la salida que el modelo aún no ha visto, línea a línea; la última línea, si no está completa,
    solo se compara cuando el comando termina. Devuelve el motivo y la línea que coincidió.
    """
    deadline = time.monotonic() + wait
    pos = job.model_cursor
    partial = ""
    while True:
        finished = job.done.is_set()
        total = job.total
        if terms is not None and total > pos:
            text, pos = job.read_range(pos, total - pos)
            lines = (partial + text).split("\n")
            partial = lines.pop()
            for line in lines:
                if line_matches(line, terms):
                    return "pattern_matched", line
        if finished and (terms is None or pos >= job.total):
            if terms is not None and partial and line_matches(partial, terms):
                return "pattern_matched", partial
            return "command_finished", None
        if cancel.is_set():
            return "wait_ended_by_user", None
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return "wait_elapsed", None
        job.wait_change(pos if terms is not None else None, remaining, cancel)

# --- tools.jobs ---
"""Comandos del servidor local (run_command y check_command): tareas con su log, plazos, segundo plano y limpieza de huérfanos."""




COMMAND_DEFAULT_TIMEOUT = 30
# Lo que run_command espera antes de pasar el comando a segundo plano y check_command espera su final, como mucho.
COMMAND_MAX_TIMEOUT = TOOL_WAIT_MAX_SECONDS
COMMAND_MAX_WAIT = TOOL_WAIT_MAX_SECONDS
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
# check_command(pattern): longitud máxima de la expresión y de la línea que se devuelve al coincidir.
CHECK_PATTERN_MAX_CHARS = 200
MATCHED_LINE_MAX_CHARS = 500
# Última línea de salida de cada comando en marcha en el latido, para su tarjeta plegada.
LAST_LINE_MAX_CHARS = 200
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

            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)  # pyright: ignore[reportAttributeAccessIssue] (solo en Windows)
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
            return bool(self._kernel32.AssignProcessToJobObject(self._handle, int(proc._handle)))  # pyright: ignore[reportAttributeAccessIssue] (solo en Windows)
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
        # Hasta dónde ha leído el modelo la salida, y si ya ha visto el final.
        self.model_cursor = 0
        self.reported = False
        self.proc: subprocess.Popen | None = None
        self.leader_start: str | None = None
        self.runner_path: Path | None = None
        self.done = threading.Event()
        self._lock = threading.Lock()
        # Avisa a quien espera en check_command de que hay salida nueva o de que el comando terminó.
        self._changed = threading.Condition(self._lock)
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
            self._changed.notify_all()

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

    def wait_change(self, seen_total: int | None, timeout: float, cancel: threading.Event | None = None):
        """Espera como mucho timeout segundos a que haya salida nueva, termine o se cancele la espera."""
        with self._changed:
            self._changed.wait_for(
                lambda: (seen_total is not None and self._total > seen_total)
                or self.done.is_set()
                or (cancel is not None and cancel.is_set()),
                timeout,
            )

    def wake_waiters(self):
        """Despierta a quien espera en wait_change (fin del comando o espera cortada)."""
        with self._changed:
            self._changed.notify_all()

    def tail_text(self, max_bytes: int = CARD_TAIL_BYTES) -> str:
        return self.read_range(max(0, self._total - max_bytes), max_bytes)[0]

    def last_line(self) -> str:
        """Última línea no vacía de la salida; de una barra de progreso que se reescribe con \\r, su último tramo."""
        for line in reversed(self.tail_text().split("\n")):
            text = line.rstrip("\r").rsplit("\r", 1)[-1].strip()
            if text:
                return text if len(text) <= LAST_LINE_MAX_CHARS else text[:LAST_LINE_MAX_CHARS - 1] + "…"
        return ""

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
        # Avisa de cada comando lanzado a quien espera uno por la clave de su invocación (wait_registered).
        self._registered = threading.Condition(self._lock)
        self._closing = False
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
            # Relanzar lo que ya está en marcha duplica el trabajo (dos envíos a la misma cola, dos
            # servidores en el mismo puerto): se sigue el que hay.
            same = next((job for job in self._jobs.values()
                         if job.status == "running" and job.project == project.key and job.command.strip() == command.strip()), None)
            if same is not None:
                raise ValueError(
                    f"This command is already running as job_id {same.id} (for {int(same.elapsed())} s). Do not run it again: "
                    f"follow it with check_command(job_id={same.id}, wait_seconds={COMMAND_MAX_WAIT}), or stop it first with "
                    f"check_command(job_id={same.id}, stop=true) if you really need a new run."
                )
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
        with self._registered:
            self._registered.notify_all()
        notify_live_change()
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
            # La salida va a un pipe, no a una terminal: sin esto Python la retiene en el búfer hasta salir
            # y ni la tarjeta, ni check_command, ni su pattern ven nada mientras el programa trabaja.
            env={**os.environ, "PYTHONUNBUFFERED": "1"},
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
        if job.stop_reason:
            job.status = "stopped"
        else:
            job.status = "exited"
        self._write_registry()
        job.done.set()
        job.wake_waiters()
        notify_live_change()

    def get(self, project: str, job_id=None, key=None) -> CommandJob | None:
        with self._lock:
            return self._find(project, job_id, key)

    def _find(self, project: str, job_id, key) -> CommandJob | None:
        """Comando del proyecto por su id o, sin id, por la clave de su invocación; con self._lock tomado."""
        jobs = [job for job in self._jobs.values() if job.project == project]
        if isinstance(job_id, int) and not isinstance(job_id, bool):
            return next((job for job in jobs if job.id == job_id), None)
        if isinstance(key, str) and key:
            return next((job for job in jobs if job.key == key), None)
        return None

    def wait_registered(self, project: str, key: str, timeout: float) -> CommandJob | None:
        """Espera como mucho timeout segundos a que se lance el comando de esa invocación (la tarjeta de la
        interfaz se crea antes de que llegue tools/call, que además puede esperar la autorización del usuario)."""
        with self._registered:
            self._registered.wait_for(lambda: self._closing or self._find(project, None, key) is not None, timeout)
            return self._find(project, None, key)

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

    def running_summaries(self, project: str | None) -> list[dict]:
        return [{**job.summary(), "last_line": job.last_line()} for job in self.running(project)]

    def stop_all(self, reason: str = "shutdown"):
        with self._registered:
            self._closing = True
            self._registered.notify_all()
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


def _job_result(job: CommandJob, note: str | None = None, output_field: str = "output", extra: dict | None = None) -> str:
    """Resultado para el modelo con la salida que aún no ha visto."""
    start = job.model_cursor
    total = job.total
    output, truncated = truncate_terminal_output(job.output_since(start))
    job.model_cursor = total
    # Detener un comando a propósito no es un fallo; sí lo son salir con error o agotar el plazo.
    failed = job.status == "exited" and job.exit_code != 0
    result = {"success": not failed, "status": job.status, "job_id": job.id}
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
    if extra:
        result.update(extra)
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
                f"Running in background. Follow it with check_command(job_id={job.id}, wait_seconds={COMMAND_MAX_WAIT}, pattern='error|Traceback'), "
                f"which returns when it finishes, prints an error or after {COMMAND_MAX_WAIT} s, and stop it with check_command(job_id={job.id}, stop=true)."
            ))
        return _job_result(job)
    timeout = _clamp_seconds(timeout_seconds, COMMAND_DEFAULT_TIMEOUT, 1, COMMAND_MAX_TIMEOUT)
    if not job.done.wait(timeout):
        # No se mata: lo hecho no se pierde y relanzarlo no lo duplica.
        job.background = True
        return _job_result(job, note=(
            f"Still running after {timeout} s, so it was moved to the background instead of being killed. "
            f"Do not run it again. Follow it with check_command(job_id={job.id}, wait_seconds={COMMAND_MAX_WAIT}) "
            f"and stop it with check_command(job_id={job.id}, stop=true)."
        ))
    return _job_result(job)


def check_command(job_id: int | None = None, wait_seconds: int = 0, stop: bool = False, pattern: str | None = None,
                  job_key: str | None = None, *, ctx: SecurityContext) -> str:
    """Estado y salida nueva de un comando lanzado por run_command; puede esperarlo, con un patrón, o detenerlo.
    wait_seconds es un máximo: la espera vuelve en cuanto el comando termina. La persona puede cortarla con
    zerochat/jobs/end_wait y la clave de la invocación."""
    if job_id is None:
        return _tool_error("job_id is required: give the job_id returned by run_command.", os=DETECTED_OS)
    job = JOBS.get(ctx.key, job_id=job_id)
    if job is None:
        return _tool_error(f"Unknown job_id {job_id}. It may belong to a previous ZeroChat session or to another project.", os=DETECTED_OS)
    terms = None
    if pattern:
        terms = text_terms(pattern)
        if not terms:
            return _tool_error("pattern needs at least one text, such as 'error|listening on'.", os=DETECTED_OS)
    if stop:
        JOBS.stop(job, "model")
        return _job_result(job, output_field="new_output")
    wait = _clamp_seconds(wait_seconds, 0, 0, COMMAND_MAX_WAIT)
    if not wait and terms is None:
        return _job_result(job, output_field="new_output")
    cancel = WAITS.open(job_key, job)
    started = time.monotonic()
    try:
        reason, line = _wait_job(job, wait, terms, cancel)
    finally:
        WAITS.close(job_key)
    extra = {"returned_because": reason, "waited_s": round(time.monotonic() - started, 1)}
    if reason == "wait_elapsed" and job.total == job.model_cursor and not job.done.is_set():
        extra["note"] = (
            "No new output while waiting. The command may still be working without printing, or write its progress "
            "to a log file: read that file with read_file. It is still running: wait again or check that file."
        )
    if line is not None:
        extra["matched_line"] = line if len(line) <= MATCHED_LINE_MAX_CHARS else line[:MATCHED_LINE_MAX_CHARS] + "…"
    return _job_result(job, output_field="new_output", extra=extra)


def job_details(job: CommandJob) -> dict:
    """Estado del comando para su tarjeta en la interfaz, con el final de su salida."""
    return {**job.summary(), "tail": job.tail_text()}

# --- security.controller ---
"""Punto único de decisión de permisos (AccessController): evalúa cada llamada, emite retos de un solo uso y guarda las decisiones por sesión de proyecto y en SQLite."""




POLICY_STATE_VERSION = 8
CHALLENGE_TTL_MS = 600_000
MAX_POLICY_ENTRIES = 500
# Proyectos con sesión en memoria: al pasar del tope se olvida la del usado hace más tiempo sin comandos en marcha.
MAX_PROJECT_SESSIONS = 16


@dataclasses.dataclass
class ProjectSession:
    """
    Lo autorizado en la sesión para un proyecto y sus retos pendientes, en memoria mientras dure el servidor.
    Lo comparten todas las pestañas y dispositivos que trabajan en ese proyecto.
    """
    last_used: float = 0.0
    allow_all: bool | None = None
    directory_rules: list[str] | None = None
    tools: dict[str, dict] = dataclasses.field(default_factory=dict)
    servers: dict[str, dict] = dataclasses.field(default_factory=dict)
    command_patterns: list[str] = dataclasses.field(default_factory=list)
    challenges: dict[str, dict] = dataclasses.field(default_factory=dict)

    def entries(self, kind: str) -> dict[str, dict]:
        return self.tools if kind == "tools" else self.servers


@dataclasses.dataclass(frozen=True)
class PolicyPatch:
    """Parche de políticas ya validado; None en un apartado es «no cambiar»."""
    allow_all: bool | None = None
    directory_rules: list[str] | None = None
    tools: dict | None = None
    servers: dict | None = None
    added_rules: list[str] = dataclasses.field(default_factory=list)
    command_patterns: dict | None = None


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
    def _normalize_global(raw: dict | None) -> dict:
        """Única definición de las políticas globales guardadas en SQLite."""
        data = raw if isinstance(raw, dict) else {}
        # run_command nunca se guarda autorizado entero: sus permisos permanentes son patrones.
        tools = {tid: entry for tid, entry in dict(data.get("tools") or {}).items()
                 if not (tid == COMMAND_TOOL and isinstance(entry, dict) and entry.get("policy") == POLICY_ALLOW)}
        raw_patterns = data.get("commandPatterns")
        patterns = list(raw_patterns) if isinstance(raw_patterns, list) else []
        return {
            "version": POLICY_STATE_VERSION,
            "tools": tools,
            "servers": dict(data.get("servers") or {}),
            "commandPatterns": patterns,
        }

    @staticmethod
    def _normalize_project(raw: dict | None) -> dict:
        """Única definición de las políticas por proyecto guardadas en SQLite."""
        data = raw if isinstance(raw, dict) else {}
        raw_rules = data.get("directoryRules")
        raw_patterns = data.get("commandPatterns")
        return {
            "allowAll": data.get("allowAll") is True,
            "directoryRules": list(raw_rules) if isinstance(raw_rules, list) else None,
            "commandPatterns": list(raw_patterns) if isinstance(raw_patterns, list) else [],
        }

    @staticmethod
    def _compact_project(project_state: dict) -> dict | None:
        """Omite la fila del proyecto en SQLite cuando todo queda en sus valores por defecto."""
        stored: dict = {}
        if project_state["allowAll"]:
            stored["allowAll"] = True
        if project_state["directoryRules"] is not None:
            stored["directoryRules"] = list(project_state["directoryRules"])
        if project_state["commandPatterns"]:
            stored["commandPatterns"] = list(project_state["commandPatterns"])
        return stored or None

    def _read_permanent_state(self, context: SecurityContext) -> tuple[dict, dict]:
        """Lee el estado permanente global y del proyecto en SQLite; un fallo se propaga."""
        raw_global, raw_project = get_security_policy_data(context.key)
        return self._normalize_global(raw_global), self._normalize_project(raw_project)

    def _update_permanent(self, context: SecurityContext, mutator: typing.Callable[[dict, dict], None]) -> tuple[dict, dict | None]:
        """Lectura-modificación-escritura transaccional sobre las filas global y del proyecto."""
        def apply(raw_global: dict | None, raw_project: dict | None, other_pattern_count: int) -> tuple[dict, dict | None]:
            global_state = self._normalize_global(raw_global)
            project_state = self._normalize_project(raw_project)
            mutator(global_state, project_state)
            check_command_pattern_limit(global_state["commandPatterns"], project_state["commandPatterns"], other_pattern_count)
            self._check_entry_limit({
                "directoryRules": project_state["directoryRules"] or [],
                "tools": global_state["tools"],
                "servers": global_state["servers"],
            })
            return global_state, self._compact_project(project_state)
        return update_security_policy_data(context.key, apply)

    def _effective_state(self, context: SecurityContext) -> dict:
        """Una sola lectura del estado permanente combinada con la capa de sesión del proyecto."""
        global_state, project_state = self._read_permanent_state(context)
        default_rule = self.get_default_directory_rule(context)
        with self._lock:
            session = self._session(context)
            if session.directory_rules is not None:
                dir_rules = list(session.directory_rules)
            elif project_state["directoryRules"] is not None:
                dir_rules = list(project_state["directoryRules"])
            else:
                dir_rules = [default_rule]
            return {
                "allowAll": session.allow_all if session.allow_all is not None else project_state["allowAll"],
                "directoryRules": dir_rules,
                "tools": {**global_state["tools"], **session.tools},
                "servers": {**global_state["servers"], **session.servers},
                "commandPatterns": {
                    "global": list(global_state["commandPatterns"]),
                    "project": list(project_state["commandPatterns"]),
                    "session": list(session.command_patterns)
                }
            }

    def _command_patterns(self, view: dict) -> list[str]:
        """Patrones que rigen en el proyecto: los de todos los proyectos, los de este y los de la sesión."""
        patterns = view["commandPatterns"]
        return [*patterns["global"], *patterns["project"], *patterns["session"]]

    def export_state(self, context: SecurityContext) -> dict:
        return {
            "version": POLICY_STATE_VERSION,
            **self._effective_state(context)
        }

    @staticmethod
    def _validate_directory_rules(raw_rules: list | tuple) -> list[str]:
        if not isinstance(raw_rules, (list, tuple)):
            raise ValueError("Las reglas de directorio deben ser una lista.")
        parsed_rules = []
        for raw in raw_rules:
            rule_obj = parse_directory_rule(raw)
            if not rule_obj:
                raise ValueError(f"Regla de directorio inválida: '{raw}'. Formato esperado: combinación de R, W y X (p. ej. R:path, RW:path, RWX:path).")
            parsed_rules.append(rule_obj["rule"])
        return list(dict.fromkeys(parsed_rules))

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
        dir_rules = state.get("directoryRules")
        dir_count = sum(len(v) for v in dir_rules.values()) if isinstance(dir_rules, dict) else len(dir_rules or [])
        total = dir_count + len(state.get("tools") or {}) + len(state.get("servers") or {})
        if total > MAX_POLICY_ENTRIES:
            raise ValueError(f"El número total de entradas ({total}) supera el máximo permitido ({MAX_POLICY_ENTRIES}).")

    def _validate_state_payload(self, state: dict, scope: str) -> PolicyPatch:
        if not isinstance(state, dict):
            raise ValueError("El estado de políticas debe ser un diccionario.")

        clean_allow_all = None
        if "allowAll" in state:
            if not isinstance(state["allowAll"], bool):
                raise ValueError("allowAll debe ser un booleano.")
            clean_allow_all = state["allowAll"]

        clean_rules = self._validate_directory_rules(state["directoryRules"]) if "directoryRules" in state else None
        clean_tools = self._validate_policy_entries(state["tools"], "tools", scope) if "tools" in state else None
        clean_servers = self._validate_policy_entries(state["servers"], "servers", scope) if "servers" in state else None
        return PolicyPatch(allow_all=clean_allow_all, directory_rules=clean_rules, tools=clean_tools, servers=clean_servers)

    @staticmethod
    def _validate_command_patterns_patch(raw) -> dict:
        """Valida un parche de commandPatterns: {global, project} para el proyecto activo."""
        if not isinstance(raw, dict):
            raise ValueError("commandPatterns debe ser un diccionario con global y project.")
        return {
            "global": clean_pattern_list(raw.get("global") or [], "commandPatterns.global"),
            "project": clean_pattern_list(raw.get("project") or [], "commandPatterns.project"),
        }

    def import_state(self, state: dict, context: SecurityContext):
        """
        Aplica un parche parcial persistente (None revoca) y devuelve el estado exportado.
        `addDirectoryRules` añade reglas a las guardadas dentro de la misma transacción y
        `commandPatterns` sustituye los patrones globales y del proyecto actual sin tocar otros proyectos.
        """
        patch = dataclasses.replace(
            self._validate_state_payload(state, SCOPE_PERMANENT),
            added_rules=self._validate_directory_rules(state["addDirectoryRules"]) if "addDirectoryRules" in state else [],
            command_patterns=self._validate_command_patterns_patch(state["commandPatterns"]) if "commandPatterns" in state else None,
        )
        default_rule = self.get_default_directory_rule(context)

        def mutator(global_state: dict, project_state: dict) -> None:
            self._apply_state_patch(global_state, project_state, default_rule, patch)
        self._update_permanent(context, mutator)
        self._forget_session_overrides(context.key, patch)
        return self.export_state(context)

    def _apply_state_patch(self, global_state: dict, project_state: dict, default_rule: str, patch: PolicyPatch):
        """Aplica sobre el estado guardado los apartados del parche que vienen (None es «no cambiar»)."""
        if patch.allow_all is not None:
            project_state["allowAll"] = patch.allow_all
        if patch.directory_rules is not None:
            project_state["directoryRules"] = None if patch.directory_rules == [default_rule] else patch.directory_rules
        if patch.added_rules:
            base_rules = project_state["directoryRules"] if project_state["directoryRules"] is not None else [default_rule]
            project_state["directoryRules"] = self._append_rules(base_rules, patch.added_rules)
        if patch.tools is not None:
            global_state["tools"] = self._apply_entry_patch(global_state.get("tools"), patch.tools)
        if patch.servers is not None:
            global_state["servers"] = self._apply_entry_patch(global_state.get("servers"), patch.servers)
        if patch.command_patterns is not None:
            global_state["commandPatterns"] = clean_pattern_list(patch.command_patterns["global"], "commandPatterns.global")
            project_state["commandPatterns"] = clean_pattern_list(patch.command_patterns["project"], "commandPatterns.project")

    def _forget_session_overrides(self, project: str, patch: PolicyPatch):
        """Lo guardado sustituye o revoca lo equivalente en la sesión (las reglas y permitir todo, solo en su proyecto)."""
        with self._lock:
            for key, session in self.sessions.items():
                if key == project:
                    if patch.allow_all is not None:
                        session.allow_all = None
                    if patch.directory_rules is not None:
                        session.directory_rules = None
                    elif patch.added_rules and session.directory_rules is not None:
                        session.directory_rules = self._append_rules(session.directory_rules, patch.added_rules)
                for kind, entries in (("tools", patch.tools), ("servers", patch.servers)):
                    for item_id in entries or {}:
                        session.entries(kind).pop(item_id, None)

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
        patch = self._validate_state_payload(state, SCOPE_SESSION)
        raw_patterns = state.get("commandPatterns")
        session_patterns = self._limit_patterns(clean_pattern_list(raw_patterns.get("session") or [], "commandPatterns.session")) \
            if isinstance(raw_patterns, dict) else None

        with self._lock:
            session = self._session(context)
            rules = patch.directory_rules if patch.directory_rules is not None else session.directory_rules
            tools = self._apply_entry_patch(session.tools, patch.tools or {})
            servers = self._apply_entry_patch(session.servers, patch.servers or {})
            self._check_entry_limit({"directoryRules": rules, "tools": tools, "servers": servers})
            if patch.allow_all is not None:
                session.allow_all = patch.allow_all
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
        return f"RWX:{base}" if base == "/" else f"RWX:{base}/**"

    @staticmethod
    def _resolve_rule_pattern(pattern: str, workspace_dir: Path | None = None) -> str:
        base, sep, rest = pattern.partition("*")
        if base:
            # Mismo resolutor que SecurityContext.resolve_path (destino y base de la regla).
            target = Path(base)
            if workspace_dir and not target.is_absolute():
                target = Path(workspace_dir) / target
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

        full_rule = self._full_directory_access_rule(user_rules, access)
        if full_rule:
            return {"allowed": True, "rule": full_rule, "path": normalized_dest}

        for raw_rule in user_rules:
            parsed = parse_directory_rule(raw_rule)
            if not parsed:
                continue
            rule_pattern = self._resolve_rule_pattern(parsed["path"], ctx.workspace_dir)
            if matches_directory_pattern(normalized_dest, rule_pattern) and all(ch in parsed["access"] for ch in access):
                return {"allowed": True, "rule": parsed["rule"], "path": normalized_dest}

        return {"allowed": False, "rule": None, "path": normalized_dest}

    def allows_path(self, access: str, path: str, context: SecurityContext) -> bool:
        """Si las reglas de directorio del proyecto (o su allowAll) dan `access` sobre `path`, sin preguntar: para las
        herramientas que actúan sobre otra carpeta en una ejecución desatendida (check_agents y launch_agent)."""
        view = self._effective_state(context)
        return bool(view["allowAll"]) or self.evaluate_directory_rule(access, path, view["directoryRules"], context)["allowed"]

    def clear_session(self):
        """Olvida lo autorizado en la sesión y los retos pendientes de todos los proyectos."""
        with self._lock:
            self.sessions.clear()

    def drop_project_session(self, project_key: str) -> None:
        """Olvida la sesión en memoria de un proyecto concreto (p. ej. al borrarlo)."""
        with self._lock:
            self.sessions.pop(project_key, None)

    def apply_tool_decision(self, tool_decision: dict | None, context: SecurityContext, server_id: str = "") -> None:
        """Aplica en AccessController la decisión aprobada por el usuario antes de reanudar una ejecución."""
        if not isinstance(tool_decision, dict):
            return
        tool_name = tool_decision.get("toolName")
        if not isinstance(tool_name, str) or not tool_name.strip():
            return
        tool_name = tool_name.strip()
        raw_dec = tool_decision.get("decision")
        if isinstance(raw_dec, dict):
            dec_type = raw_dec.get("decision")
            raw_pattern = raw_dec.get("commandPattern")
            raw_dir_rule = raw_dec.get("directoryRule")
        else:
            dec_type = raw_dec
            raw_pattern = None
            raw_dir_rule = None
        # «Solo esta vez» no guarda nada, ni en sesión ni de forma permanente: al reanudar, el runner contesta
        # con ella el reto de esa misma llamada, que se ejecuta y se consume. Tampoco vuelve con la rotación del token.
        if not isinstance(dec_type, str) or dec_type not in AUTHORIZE_DECISIONS or dec_type == "allow_once":
            return
        pattern = normalize_command_pattern(raw_pattern) if (raw_pattern and tool_name == COMMAND_TOOL) else None
        rules = self._validate_directory_rules([raw_dir_rule]) if raw_dir_rule else []
        challenge = {
            "toolName": tool_name,
            "serverName": server_id or "mcp-proxy",
            "serverId": server_id,
        }
        self._record_decision(challenge, dec_type, pattern, rules, context)

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
            rules = self._validate_directory_rules([directory_rule]) if directory_rule else []
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
            self._allow_for_session(context, tool, server_name, pattern)
        permanent = decision in ("allow_project", "allow_always", "allow_server_always")
        if not permanent and not rules:
            return
        project = context.key

        def mutator(global_state: dict, project_state: dict) -> None:
            self._store_decision(global_state, project_state, decision, pattern, tool, server_name, server_id)
            if rules:
                base_rules = project_state["directoryRules"] if project_state["directoryRules"] is not None else [self.get_default_directory_rule(context)]
                project_state["directoryRules"] = self._append_rules(base_rules, rules)
        self._update_permanent(context, mutator)
        self._drop_superseded_session_entries(decision, pattern, tool, server_id, project, rules)

    def _allow_for_session(self, context: SecurityContext, tool: str, server_name: str, pattern: str | None):
        """«Permitir en la sesión»: el patrón de comando aprobado o, sin él, la herramienta."""
        with self._lock:
            session = self._session(context)
            if pattern:
                session.command_patterns = self._limit_patterns(
                    clean_pattern_list(session.command_patterns + [pattern], "commandPatterns.session"))
            else:
                session.tools[tool] = self._make_entry("tools", POLICY_ALLOW, SCOPE_SESSION, server_name, tool)

    def _store_decision(self, global_state: dict, project_state: dict, decision: str, pattern: str | None, tool: str,
                        server_name: str, server_id: str):
        """Guarda una decisión permanente: el patrón del proyecto o global, la herramienta o el servidor."""
        if pattern and decision == "allow_project":
            project_state["commandPatterns"] = clean_pattern_list([*project_state["commandPatterns"], pattern], "commandPatterns.project")
        elif pattern and decision == "allow_always":
            global_state["commandPatterns"] = clean_pattern_list([*global_state["commandPatterns"], pattern], "commandPatterns.global")
        elif decision == "allow_always":
            global_state["tools"][tool] = self._make_entry("tools", POLICY_ALLOW, SCOPE_PERMANENT, server_name, tool)
        elif decision == "allow_server_always":
            global_state["servers"][server_id] = self._make_entry("servers", POLICY_ALLOW, SCOPE_PERMANENT, server_name or server_id)

    def _drop_superseded_session_entries(self, decision: str, pattern: str | None, tool: str, server_id: str,
                                         project: str, rules: list[str]):
        """Lo que se acaba de guardar sustituye a lo equivalente en la sesión (las reglas de carpeta, solo en su proyecto)."""
        with self._lock:
            for key, session in self.sessions.items():
                if decision == "allow_always" and not pattern:
                    session.tools.pop(tool, None)
                elif decision == "allow_server_always":
                    session.servers.pop(server_id, None)
                if key == project and rules and session.directory_rules is not None:
                    session.directory_rules = self._append_rules(session.directory_rules, rules)

    def evaluate_authorization(self, tool_name: str, raw_args: dict | None, context: SecurityContext,
                               server_name: str = "", server_id: str = "") -> AccessDecision:
        """
        Evalúa si la invocación de una herramienta está permitida, denegada o requiere confirmación.
        Jerarquía:
        1. Lista negra explícita (deny individual o de servidor).
        2. Herramientas de control de procesos (check_command).
        3. Interruptor allowAll del proyecto -> allow incondicional.
        4. Política granular de herramienta -> allow.
        5. Política de servidor completo -> allow incondicional para sus herramientas.
        6. run_command: reglas de directorio (RWX:/** permite todo; X habilita la carpeta) y patrones de comando.
        7. Herramientas con ruta: reglas de directorio.
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
        if view["allowAll"]:
            return POLICY_ALLOW, "project_allow_all", "", None
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

    @staticmethod
    def _full_directory_access_rule(rules: list[str], access: str = "RWX") -> str | None:
        """Primera regla sobre la raíz (/** o /) que cubre `access`, o None."""
        for raw in rules:
            parsed = parse_directory_rule(raw)
            if parsed is not None and all(ch in parsed["access"] for ch in access) and parsed["path"] in ("/**", "/"):
                return parsed["rule"]
        return None

    @classmethod
    def _has_full_directory_access(cls, rules: list[str]) -> bool:
        """Indica si el proyecto tiene acceso RWX a todo el sistema de ficheros (RWX:/** o RWX:/)."""
        return cls._full_directory_access_rule(rules, "RWX") is not None

    @staticmethod
    def _command_target(cwd: Path, raw_path: str) -> str:
        return raw_path if re.match(r"^(/|[A-Za-z]:[\\/])", raw_path) else str(cwd / raw_path)

    def _is_allowed_trust_segment(self, segment: str, cwd: Path, directory_rules: list[str], ctx: SecurityContext) -> bool:
        """Subcomando permitido por las reglas del proyecto: local o con rutas dentro de reglas RW."""
        refs = command_outside_references(segment)
        if refs is None:
            return False
        return all(
            self.evaluate_directory_rule("RW", self._command_target(cwd, ref), directory_rules, ctx)["allowed"]
            for ref in refs
        )

    def _evaluate_command(self, raw_command: str, view: dict, ctx: SecurityContext) -> tuple[str, str, str, dict | None]:
        """
        Valida cada subcomando por separado: con RWX:/** el proyecto queda sin restricción de comandos.
        En otro caso, la carpeta donde se ejecuta (inicial y tras cada cd) requiere permiso X en directoryRules;
        cada cd debe llevar a una carpeta cubierta por las reglas de directorio, y el resto tiene que estar
        cubierto por un patrón o quedarse en el proyecto o en reglas RW del proyecto (tras una tubería, solo
        un filtro).
        """
        if self._has_full_directory_access(view["directoryRules"]):
            return POLICY_ALLOW, "directory_rule_allow", "", None
        if not self.evaluate_directory_rule("X", str(ctx.workspace_dir), view["directoryRules"], ctx)["allowed"]:
            return (POLICY_ASK, "command_directory_without_execute",
                    f"La carpeta no tiene permiso de ejecución (X): {ctx.workspace_dir}", None)
        segments = split_command(raw_command)
        if segments is None:
            return (POLICY_ASK, "command_chaining_requires_approval",
                    f"El comando usa sintaxis de shell que no se puede validar por partes: {raw_command}", None)
        patterns = self._command_patterns(view)
        cwd, by_rule, uncovered = ctx.workspace_dir, False, []
        for operator, segment in segments:
            directory = cd_target(segment)
            if directory is not None:
                target = self._command_target(cwd, directory)
                if not any(self.evaluate_directory_rule(a, target, view["directoryRules"], ctx)["allowed"] for a in ("R", "W", "X")):
                    return (POLICY_ASK, "command_directory_outside_rules",
                            f"El comando se ejecuta fuera de las reglas de directorio: {directory}", None)
                cwd = ctx.resolve_path(target) or cwd
                if not self.evaluate_directory_rule("X", str(cwd), view["directoryRules"], ctx)["allowed"]:
                    return (POLICY_ASK, "command_directory_without_execute",
                            f"La carpeta no tiene permiso de ejecución (X): {cwd}", None)
            elif any(matches_command_pattern(segment, p) for p in patterns):
                continue
            elif self._is_allowed_trust_segment(segment, cwd, view["directoryRules"], ctx) and (
                    operator != "|" or segment.split()[0] in WORKSPACE_TRUST_PIPE_FILTERS):
                by_rule = True
            else:
                uncovered.append(segment)
        if not uncovered:
            return POLICY_ALLOW, "directory_rule_allow" if by_rule else "command_pattern_allow", "", None
        reason, details = (
            ("command_outside_allowed_patterns", f"Comando fuera de los patrones autorizados: {'; '.join(uncovered)}")
            if patterns
            else ("command_outside_directory_rules", "El comando accede a recursos globales o rutas fuera de las reglas de directorio.")
        )
        return POLICY_ASK, reason, details, command_rule_offer(uncovered)

    def _evaluate_path(self, tool_name: str, access: str, path: str, view: dict, ctx: SecurityContext) -> tuple[str, str, str, dict | None]:
        """Herramientas integradas de ficheros: reglas de directorio del proyecto."""
        dir_eval = self.evaluate_directory_rule(access, path, view["directoryRules"], ctx)
        if dir_eval["allowed"]:
            return POLICY_ALLOW, "directory_rule_allow", "", None
        return (POLICY_ASK, "directory_rule_required", f"La ruta no coincide con una regla {access}: {path}",
                directory_rule_offer(tool_name, access, dir_eval["path"] or path))


ACCESS_CONTROLLER = AccessController()

# --- server.state ---
"""Estado del servidor local en marcha: presencia del navegador por latido, auto-cierre, apagado, préstamo del navegador y estado vivo que publica el latido."""




DEFAULT_HEARTBEAT_TIMEOUT = 60.0
DEFAULT_HEARTBEAT_GRACE = 45.0
# Las ejecuciones --conversation corren en otro proceso y solo se ven en SQLite. Su final llega sin sondeo (se
# espera su PID, watch_run_exit), pero no su progreso (step_text): el latido en espera relee cada tanto mientras
# la interfaz muestra la conversación de una en marcha. Donde no se puede esperar un PID, el latido y el
# vigilante releen así con cualquiera en marcha.
_EXTERNAL_RUN_POLL_SECONDS = 1.0
_WATCHDOG_RUN_RECHECK_SECONDS = 1.0
# Campos de cada comando que cambian sin parar mientras corre: no cuentan en la firma `rev` (si no, cada
# línea de salida despertaría a todos los latidos) y se refrescan al vencer cada espera.
_VOLATILE_JOB_FIELDS = frozenset({"elapsed_s", "output_bytes", "last_line"})
HEARTBEAT_LAST_SEEN = 0.0
HEARTBEAT_INITIALIZED = False
HEARTBEAT_WATCHDOG_STOP = threading.Event()
_LIVE_STATE_COND = threading.Condition()
_LIVE_STATE_SEQ = 0
_WATCHDOG_COND = threading.Condition()
_SERVER_SHUTTING_DOWN = threading.Event()
_SHUTDOWN_LOCK = threading.Lock()
_SHUTDOWN_LISTENERS: set[threading.Event] = set()
# Si el servidor se detiene al cerrar el navegador, cerrar la pestaña detiene también los comandos.
EXIT_ON_CLOSE = False


def register_shutdown_event(event: threading.Event) -> None:
    """Registra un evento que se activa al iniciar el apagado del servidor."""
    with _SHUTDOWN_LOCK:
        if _SERVER_SHUTTING_DOWN.is_set():
            event.set()
        else:
            _SHUTDOWN_LISTENERS.add(event)


def unregister_shutdown_event(event: threading.Event) -> None:
    with _SHUTDOWN_LOCK:
        _SHUTDOWN_LISTENERS.discard(event)


def set_exit_on_close(value: bool):
    """Fija si cerrar el navegador detiene el servidor (sin --keep-server)."""
    global EXIT_ON_CLOSE
    EXIT_ON_CLOSE = value


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


def notify_live_state_changed() -> None:
    """Despierta a los latidos en espera y al watchdog ante cambios del estado vivo."""
    global _LIVE_STATE_SEQ
    with _LIVE_STATE_COND:
        _LIVE_STATE_SEQ += 1
        _LIVE_STATE_COND.notify_all()
    with _WATCHDOG_COND:
        _WATCHDOG_COND.notify_all()


on_live_change(notify_live_state_changed)


def mark_browser_active():
    """Registra la presencia del navegador ante cualquier petición de un origen permitido, aunque su
    token haya caducado: el auto-cierre no detiene el servidor ni sus comandos al cambiar el día."""
    global HEARTBEAT_LAST_SEEN, HEARTBEAT_INITIALIZED
    with _WATCHDOG_COND:
        HEARTBEAT_LAST_SEEN = time.monotonic()
        HEARTBEAT_INITIALIZED = True
        _WATCHDOG_COND.notify_all()


def heartbeat_initialized() -> bool:
    """Si el navegador ha dado ya alguna señal de vida."""
    return HEARTBEAT_INITIALIZED


def _live_state_rev(state: dict) -> str:
    stable = {
        **state,
        "jobs": [{k: v for k, v in job.items() if k not in _VOLATILE_JOB_FIELDS} for job in state["jobs"]],
    }
    encoded = json.dumps(stable, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()[:16]


def live_state(ctx: SecurityContext, focus_conversation_id: str | None = None) -> dict:
    """
    Estado del servidor que la interfaz sigue en vivo, en initialize y en cada zerochat/heartbeat:
    cwd, el proyecto de la pestaña que pregunta (su cabecera X-ZeroChat-Project); jobs, los comandos en
    marcha con su última línea de salida, para mostrarlos y avisar antes de cerrar si se detendrían; exit_on_close; playwright, si
    se puede navegar aunque se haya instalado o quitado durante la sesión; servers, los servicios
    MCP externos aunque otra pestaña los cambie o su proceso muera; runs, lista ligera de ejecuciones
    en segundo plano; y focus_run, estado detallado de la ejecución enfocada por el usuario.
    """
    runs, focus_run = list_server_runs(focus_conversation_id)
    state = {
        "serverId": get_server_id(),
        "cwd": str(ctx.workspace_dir),
        "jobs": JOBS.running_summaries(ctx.key),
        "exit_on_close": EXIT_ON_CLOSE,
        "playwright": playwright_status(),
        "servers": GLOBAL_MCP_MANAGER.list_servers(),
        "externalTools": GLOBAL_MCP_MANAGER.tools(),
        "runs": runs,
        "focus_run": focus_run,
        "conversations_rev": conversations_revision()
    }
    state["rev"] = _live_state_rev(state)
    return state


def wait_live_state(
    ctx: SecurityContext,
    focus_conversation_id: str | None = None,
    since_rev: str | None = None,
    wait_ms: int = 0,
) -> dict:
    """Devuelve el estado vivo; con since_rev y wait_ms espera a que cambie su firma sin sondeo activo."""
    deadline = time.monotonic() + min(max(0, wait_ms), LONG_POLL_MAX_WAIT_MS) / 1000.0
    while True:
        with _LIVE_STATE_COND:
            seq = _LIVE_STATE_SEQ
        state = live_state(ctx, focus_conversation_id)
        if not since_rev or state["rev"] != since_rev or _SERVER_SHUTTING_DOWN.is_set():
            return state
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return state
        slice_s = min(remaining, _EXTERNAL_RUN_POLL_SECONDS) if _rereads_runs(state) else remaining
        with _LIVE_STATE_COND:
            if _LIVE_STATE_SEQ == seq and not _SERVER_SHUTTING_DOWN.is_set():
                _LIVE_STATE_COND.wait(slice_s)


def _rereads_runs(state: dict) -> bool:
    """Si el latido en espera debe releer SQLite cada _EXTERNAL_RUN_POLL_SECONDS (ver arriba)."""
    focus = state.get("focus_run")
    if isinstance(focus, dict) and focus.get("status") == "running":
        return True
    return not pid_exit_waitable() and any(r.get("status") == "running" for r in state["runs"])


def stop_zerochat_server(server: ThreadingHTTPServer):
    """Detiene limpiamente el servidor y todos los subsistemas evitando reentradas."""
    if _SERVER_SHUTTING_DOWN.is_set():
        return
    _SERVER_SHUTTING_DOWN.set()
    with _SHUTDOWN_LOCK:
        for listener in list(_SHUTDOWN_LISTENERS):
            listener.set()
    HEARTBEAT_WATCHDOG_STOP.set()
    notify_live_state_changed()
    running = JOBS.running(None)
    if running:
        console_log(timestamp_message(f"Deteniendo {len(running)} comando(s) en marcha: " + ", ".join(job.command[:60] for job in running)))
    JOBS.stop_all("shutdown")
    GLOBAL_MCP_MANAGER.close()
    BROWSER_ENGINES.close()
    threading.Thread(target=server.shutdown, daemon=True).start()


def _watchdog_wait_step(
    start_time: float,
    initial_grace_seconds: float,
    inactivity_timeout_seconds: float,
    require_initial_connection: bool,
) -> str | None:
    """Espera en _WATCHDOG_COND hasta que venza el plazo actual; devuelve el mensaje de cierre o None."""
    with _WATCHDOG_COND:
        while not HEARTBEAT_WATCHDOG_STOP.is_set():
            if not HEARTBEAT_INITIALIZED:
                if not require_initial_connection:
                    _WATCHDOG_COND.wait()
                    continue
                remaining = start_time + initial_grace_seconds - time.monotonic()
                if remaining <= 0:
                    return f"Tiempo de espera del navegador agotado ({initial_grace_seconds:.0f}s). Deteniendo servidor ZeroChat..."
                _WATCHDOG_COND.wait(remaining)
                continue
            remaining = HEARTBEAT_LAST_SEEN + inactivity_timeout_seconds - time.monotonic()
            if remaining > 0:
                _WATCHDOG_COND.wait(remaining)
                continue
            return "Navegador desconectado (cierre detectado). Deteniendo servidor ZeroChat..."
    return None


def heartbeat_watchdog(server: ThreadingHTTPServer, initial_grace_seconds: float = DEFAULT_HEARTBEAT_GRACE, inactivity_timeout_seconds: float = DEFAULT_HEARTBEAT_TIMEOUT, require_initial_connection: bool = True):
    """
    Supervisa la presencia de la pestaña del navegador mediante latidos HTTP.
    Si el navegador se cierra o deja de emitir latidos, detiene el servidor automáticamente.
    """
    start_time = time.monotonic()
    run_recheck_seconds = min(_WATCHDOG_RUN_RECHECK_SECONDS, max(0.05, inactivity_timeout_seconds))
    while not HEARTBEAT_WATCHDOG_STOP.is_set():
        reason = _watchdog_wait_step(start_time, initial_grace_seconds, inactivity_timeout_seconds, require_initial_connection)
        if reason is None:
            return
        if HEARTBEAT_INITIALIZED:
            with _LIVE_STATE_COND:
                seq = _LIVE_STATE_SEQ
            runs, _ = list_server_runs()
            if any(r.get("status") == "running" for r in runs):
                # Hasta que termine alguna (lo avisa watch_run_exit, que list_server_runs pone en marcha) o vuelva el navegador.
                with _WATCHDOG_COND:
                    if not pid_exit_waitable():
                        _WATCHDOG_COND.wait(run_recheck_seconds)
                    elif _LIVE_STATE_SEQ == seq and not HEARTBEAT_WATCHDOG_STOP.is_set():
                        _WATCHDOG_COND.wait()
                continue
        log_event(reason)
        stop_zerochat_server(server)
        return

# --- cli.console ---
"""Consola interactiva del servidor: una línea de ayuda tras un rato sin actividad y órdenes de teclado (abrir la interfaz, salir)."""




CONSOLE_STATUS_IDLE_SECONDS = 8.0


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

# --- run_mode.supervisor ---
"""Supervisión de la ejecución desatendida: plazos, final del runner y arranque del runner de Node."""





# Final de la salida de error del runner que acompaña al motivo de un final sin resultado.
RUNNER_ERROR_TAIL_BYTES = 2000


def runner_exit_reason(proc: subprocess.Popen, stderr_log: IO[bytes] | None) -> str:
    """Por qué terminó el runner sin resultado: su código de salida y el final de su salida de error."""
    tail = ""
    if stderr_log is not None:
        try:
            size = stderr_log.seek(0, os.SEEK_END)
            stderr_log.seek(max(0, size - RUNNER_ERROR_TAIL_BYTES))
            tail = stderr_log.read().decode("utf-8", "replace").strip()
        except (OSError, ValueError):
            tail = ""
    reason = f"El runner de Node.js terminó con el código {proc.returncode} sin resultado"
    return f"{reason}: {tail}" if tail else f"{reason}."


def run_supervisor(server: ThreadingHTTPServer, session: RunSession, runner_proc: subprocess.Popen | None = None,
                   runner_log: IO[bytes] | None = None):
    """Detiene el servidor al recibir el resultado, si termina el runner propio o al vencer el timeout de --run-file,
    contado desde el arranque del proceso: entonces termina el runner, y lo hecho ya está grabado. Sin timeout, lo que
    dura una ejecución lo decide quien la lanza (la cancela o la interrumpe)."""
    wake = threading.Event()
    proc_done = threading.Event()
    session.set_wake_event(wake)
    register_shutdown_event(wake)
    try:
        if runner_proc is not None:
            def _watch_proc():
                runner_proc.wait()
                proc_done.set()
                wake.set()
            threading.Thread(target=_watch_proc, name="run-proc-wait", daemon=True).start()
        deadline = None if session.timeout_seconds is None else session.started_at / 1000 + session.timeout_seconds
        woken = wake.wait(None if deadline is None else max(0.0, deadline - time.time()))
        # El latido o una señal ya detienen el servidor: el resultado queda vacío.
        if _SERVER_SHUTTING_DOWN.is_set():
            return
        if not woken and session.reach_limit(f"Límite de {session.timeout_seconds} s alcanzado."):
            if runner_proc is not None:
                _kill_process_tree(runner_proc, grace_seconds=1.0)
        if proc_done.is_set() and not session.finished.wait(0.2):
            if runner_proc is not None:
                session.stop_reason = runner_exit_reason(runner_proc, runner_log)
    finally:
        unregister_shutdown_event(wake)
        session.set_wake_event(None)
    if session.result is None:
        with session.lock:
            session.status = "error"
            session.error = session.stop_reason or ("El runner se cerró sin resultado." if runner_proc else "La ejecución se interrumpió sin resultado.")
            write_run_state(session)
    if session.runner_token:
        revoke_token(session.runner_token)
    stop_zerochat_server(server)


def _runner_cache_file() -> Path:
    """La caché de los módulos del runner, en una carpeta privada que es lo único del disco que puede tocar."""
    cache_dir = get_data_dir() / "cache" / "runner"
    cache_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    if os.name != "nt":
        try:
            cache_dir.chmod(0o700)
        except OSError:
            pass
    return cache_dir / "modules.json"


def launch_node_runner(url: str) -> tuple[subprocess.Popen, IO[bytes]] | None:
    """Abre el runner de Node.js sin ventana en segundo plano con el modelo de permisos de Node; devuelve el proceso
    y su salida de error, en un fichero temporal sin nombre, para explicar un final sin resultado (runner_exit_reason).

    El cargador (runner_loader.py) descarga los módulos de la interfaz de url y solo puede leer y escribir su caché.
    Hereda el entorno de quien lanza zerochat (NODE_EXTRA_CA_CERTS, TZ, LANG...): ejecuta código propio, no el del
    modelo, que va al sandbox sin entorno; un runner alterado vendría con una interfaz alterada que ya puede más."""
    node = find_node_executable()
    if not node:
        run_error(f"Se necesita {NODE_REQUIRED_MESSAGE} para la ejecución desatendida.")
        return None
    try:
        cache_file = _runner_cache_file()
    except OSError as exc:
        run_error(f"No se pudo preparar la caché del runner de Node.js: {exc}")
        return None
    log_event("Iniciando runner de Node.js...")
    cache_dir = cache_file.parent
    # En desarrollo los módulos cambian sin subir la versión: se descargan siempre.
    cache_policy = RUNNER_CACHE_ALWAYS_DOWNLOAD if get_dev_root() is not None else RUNNER_CACHE_BY_VERSION
    cmd = [node, "--permission", f"--allow-fs-read={cache_dir}", f"--allow-fs-write={cache_dir}",
           "-e", RUNNER_LOADER_SCRIPT, str(cache_file), url, cache_policy]
    try:
        stderr_log = tempfile.TemporaryFile()  # noqa: SIM115 - vive lo que la ejecución; se cierra al salir
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=stderr_log,
            start_new_session=True,
        )
        return proc, stderr_log
    except OSError as error:
        run_error(f"No se pudo iniciar el proceso de Node.js ({error}).")
        return None

# --- tools.agents ---
"""check_agents y launch_agent: los agentes que vigila y lanza un agente master, solo en la ejecución --run-file con
watchAgents.

Leen conversaciones y ejecuciones de SQLite filtrando estrictamente por un proyecto (el de la ejecución o, con project,
otro sobre el que sus reglas de directorio den lectura) y por los patrones de watchAgents: nunca chats humanos (sin
agent). launch_agent lanza un run-file de ese proyecto separado del master, con el entorno guardado y los permisos del
proyecto en que se ejecuta. Con wait_seconds espera, sin que el
modelo tenga que sondear, a que cambie el estado de alguno de los agentes consultados. Con prune_keep borra, solo
cuando el master lo pide, las conversaciones antiguas de sus agentes vigilados (nunca hay limpieza automática).
"""




AGENTS_TOOL = "check_agents"
LAUNCH_AGENT_TOOL = "launch_agent"
# Las herramientas del master: se publican y autorizan juntas, solo en una ejecución --run-file con watchAgents.
MASTER_TOOLS = (AGENTS_TOOL, LAUNCH_AGENT_TOOL)
# Tope del prompt que launch_agent pone en lugar del del run-file.
MAX_LAUNCH_PROMPT_LENGTH = 32768
# Respuesta final de cada agente en el listado: entera hasta AGENT_LIST_RESULT_MAX_CHARS, y entre todas como mucho
# AGENT_LIST_TOTAL_CHARS; la que no cabe se omite con su longitud (result_chars) para leerla en el detalle.
AGENT_LIST_RESULT_MAX_CHARS = 4000
AGENT_LIST_TOTAL_CHARS = 24000
# Bloque de la respuesta final que devuelve el detalle por página (offset y next_offset).
AGENT_RESULT_PAGE_CHARS = 20000
# Texto de los mensajes del último turno que devuelve el detalle con include_turn, entre todos.
AGENT_TURN_MAX_CHARS = 20000
# Tope de wait_seconds: el único de las esperas de herramientas (TOOL_WAIT_MAX_SECONDS).
AGENT_MAX_WAIT = TOOL_WAIT_MAX_SECONDS
# Los agentes corren en otros procesos: su final llega sin sondeo (se espera su PID, watch_run_exit), pero una
# ejecución nueva (lanzada por cron o por un script) solo se ve en SQLite, así que la espera la relee cada tanto.
AGENT_WAIT_RECHECK_SECONDS = 5.0
# Estados que cortan una espera aunque otros agentes sigan en marcha: alguien tiene que mirarlos.
AGENT_ATTENTION_STATUSES = ("needs_input", "error")
# Tope de prune_keep: cuántas conversaciones recientes de cada agente puede pedir conservar el master.
AGENT_PRUNE_KEEP_MAX = 1000
# Estados que la limpieza nunca borra: una ejecución en marcha o una pausa que espera a una persona.
AGENT_PRUNE_PROTECTED = ("running", "needs_input")


def _clip(text: str, limit: int) -> tuple[str, bool]:
    return (text, False) if len(text) <= limit else (text[:limit], True)


def _conversation_project(ctx: SecurityContext) -> str:
    """El proyecto de las conversaciones de esta ejecución: su carpeta, o vacío en la carpeta general."""
    return "" if ctx.key == normalize_directory_path(str(get_no_project_dir())) else ctx.key


def _target_project(ctx: SecurityContext, project: str | None, access: str) -> SecurityContext:
    """El proyecto sobre el que actúa el master: el suyo o, con project, otra carpeta sobre la que sus reglas de
    directorio den `access` (R para consultar y lanzar, RW para borrar). ValueError con el motivo si no vale."""
    if project is None:
        return ctx
    if not isinstance(project, str) or not project.strip():
        raise ValueError("project must be the folder of a project.")
    try:
        folder = ctx.absolute(project.strip())
    except ValueError as exc:
        raise ValueError(f"project is not a valid folder: {exc}") from exc
    if not folder.is_dir():
        raise ValueError(f"The project folder does not exist: {folder}")
    target = SecurityContext(workspace_dir=folder)
    if target.key != ctx.key and not ACCESS_CONTROLLER.allows_path(access, str(folder), ctx):
        raise ValueError(f"This project's directory rules do not give {access} access to {folder}.")
    return target


def _watched_conversations(ctx: SecurityContext, patterns: tuple[str, ...], own_id: str) -> list[dict]:
    """Conversaciones de agentes vigilados del proyecto, de la más reciente a la más antigua, sin la del propio master.
    Incluye las que este master lanzó y el agente aún no ha guardado: su fila de runs ya está en marcha."""
    project = _conversation_project(ctx)
    convs = [conv for conv in list_conversations()
             if conv["id"] != own_id and (conv.get("project") or "") == project and agent_matches(conv.get("agent"), patterns)]
    session = current_run_session()
    saved = {conv["id"] for conv in convs}
    pending = [{"id": conv_id, **meta} for conv_id, meta in (session.launched_agents if session else {}).items()
               if conv_id not in saved and meta["project"] == project and agent_matches(meta["agent"], patterns)]
    if not pending:
        return convs
    return sorted(convs + pending, key=lambda conv: conv.get("updatedAt") or 0, reverse=True)


def _agent_state(conv: dict, run: dict) -> dict:
    """Estado de la última ejecución de una conversación de agente, sin su respuesta final (la añaden el listado y el
    detalle). Una en marcha cuyo proceso ya no existe terminó sin poder guardar su final: se da como error."""
    died = run.get("status") == "running" and not run_process_alive(run)
    return {
        "agent": conv["agent"],
        "conversation_id": conv["id"],
        "status": "error" if died else run.get("status"),
        "updated_at": run.get("updated_at") or conv.get("updatedAt"),
        "finished_at": run.get("finished_at"),
        "step_text": run.get("step_text") or "",
        "pending": run.get("pending"),
        "error": "The agent's run process ended unexpectedly." if died else run.get("error"),
        "warnings": run.get("warnings") or [],
        "usage": run.get("usage"),
    }


def _listing(selected: list[tuple[dict, dict]]) -> dict:
    """El listado con la respuesta final entera de cada agente mientras quepa (por agente y entre todos); la que no,
    sin texto y con result_chars."""
    budget, agents, omitted = AGENT_LIST_TOTAL_CHARS, [], False
    for conv, run in selected:
        result = run.get("result_text") or ""
        entry = _agent_state(conv, run)
        if len(result) <= min(AGENT_LIST_RESULT_MAX_CHARS, budget):
            entry["result_text"] = result
            budget -= len(result)
        else:
            entry["result_chars"] = len(result)
            omitted = True
        agents.append(entry)
    note = ("Final answers that did not fit are omitted (see result_chars): read them with check_agents(conversation_id=...)."
            if omitted else None)
    return {"agents": agents, **({"note": note} if note else {})}


def _result_page(result: str, offset: int) -> dict:
    """Un bloque de AGENT_RESULT_PAGE_CHARS de la respuesta final desde offset; next_offset es None en el último."""
    end = offset + AGENT_RESULT_PAGE_CHARS
    return {"result_text": result[offset:end], "result_chars": len(result), "offset": offset,
            "next_offset": end if end < len(result) else None}


def _last_turn(history: list[dict]) -> tuple[list[dict], bool]:
    """Mensajes desde el último del usuario, con AGENT_TURN_MAX_CHARS de texto entre todos; True si se recortó."""
    start = max((index for index, message in enumerate(history) if message.get("role") == "user"), default=0)
    budget, truncated, messages = AGENT_TURN_MAX_CHARS, False, []
    for message in history[start:]:
        content, clipped = _clip("" if message.get("content") is None else str(message["content"]), budget)
        budget -= len(content)
        truncated = truncated or clipped
        entry = {"role": message.get("role"), "content": content}
        if message.get("name"):
            entry["name"] = message["name"]
        calls = [call.get("function", {}).get("name") for call in message.get("tool_calls") or [] if isinstance(call, dict)]
        if calls:
            entry["tool_calls"] = calls
        messages.append(entry)
    return messages, truncated


def _selected(ctx: SecurityContext, patterns: tuple[str, ...], own_id: str, agent: str | None,
              conversation_id: str | None) -> list[tuple[dict, dict]] | None:
    """Las conversaciones consultadas con su ejecución: la más reciente de cada agente vigilado, la de agent o la de
    conversation_id; None si agent o conversation_id no es de un agente vigilado."""
    convs = _watched_conversations(ctx, patterns, own_id)
    if conversation_id is not None:
        picked = [conv for conv in convs if conv["id"] == conversation_id][:1]
    elif agent is not None:
        picked = [conv for conv in convs if conv["agent"] == agent][:1]
    else:
        latest: dict[str, dict] = {}
        for conv in convs:
            latest.setdefault(conv["agent"], conv)
        return [(conv, get_run_state(conv["id"]) or {}) for conv in latest.values()]
    return [(conv, get_run_state(conv["id"]) or {}) for conv in picked] or None


def _wait_reason(selected: list[tuple[dict, dict]] | None, attention: dict[str, str]) -> str | None:
    """Por qué deja de esperar con lo leído, o None para seguir: ninguna consultada en marcha (not_running), o una
    que pasa a needs_input o error durante la espera (needs_attention); attention es el estado de cada una al empezar."""
    if selected is None:
        return "not_running"
    statuses = {conv["id"]: _agent_state(conv, run)["status"] for conv, run in selected}
    if any(status in AGENT_ATTENTION_STATUSES and attention.get(conv_id) != status for conv_id, status in statuses.items()):
        return "needs_attention"
    if all(status != "running" for status in statuses.values()):
        return "not_running"
    return None


def _wait_for_change(read, wait: float) -> tuple[list[tuple[dict, dict]] | None, str]:
    """Relee con read() mientras alguna conversación consultada siga en marcha, como mucho wait: vuelve en cuanto
    ninguna lo está (también al empezar, sin esperar) o cuando una pasa a necesitar a alguien. Devuelve lo último
    leído y el motivo (not_running, needs_attention o wait_elapsed)."""
    deadline = time.monotonic() + wait
    seq = live_change_seq()
    selected = read()
    attention = {conv["id"]: _agent_state(conv, run)["status"] for conv, run in selected or ()}
    while True:
        reason = _wait_reason(selected, attention)
        if reason:
            return selected, reason
        for _conv, run in selected or ():
            if run.get("status") == "running" and run.get("pid"):
                watch_run_exit(run["pid"], run.get("pid_start"))
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return selected, "wait_elapsed"
        seq = wait_live_change(seq, min(remaining, AGENT_WAIT_RECHECK_SECONDS))
        selected = read()


def _prune(convs: list[dict], agent: str | None, keep: int) -> str:
    """Borra las conversaciones de cada agente vigilado (o solo de agent) salvo las keep más recientes, con su fila
    de runs; las que están en marcha o esperan a una persona se conservan y se indican."""
    deleted, skipped, seen = [], [], {}
    for conv in convs:  # De la más reciente a la más antigua.
        if agent is not None and conv["agent"] != agent:
            continue
        seen[conv["agent"]] = seen.get(conv["agent"], 0) + 1
        if seen[conv["agent"]] <= keep:
            continue
        status = _agent_state(conv, get_run_state(conv["id"]) or {})["status"]
        if status in AGENT_PRUNE_PROTECTED:
            skipped.append({"agent": conv["agent"], "conversation_id": conv["id"], "status": status})
            continue
        if delete_conversation(conv["id"]):
            delete_run_state(conv["id"])
            deleted.append({"agent": conv["agent"], "conversation_id": conv["id"]})
    return json.dumps({"success": True, "deleted": deleted, "skipped": skipped}, ensure_ascii=False)


def check_agents(agent: str | None = None, conversation_id: str | None = None, wait_seconds: int = 0,
                 prune_keep: int | None = None, project: str | None = None, offset: int = 0, include_turn: bool = False,
                 ctx: SecurityContext | None = None) -> str:
    """Sin argumentos, el estado de cada agente vigilado (su conversación más reciente) con su respuesta final si cabe;
    con agent o conversation_id, su respuesta final por bloques desde offset y, con include_turn, los mensajes de su
    último turno. Con wait_seconds, antes espera como mucho ese tiempo a que cambie.
    Con prune_keep, en lugar de eso borra las conversaciones antiguas de los agentes vigilados (o de agent). Con
    project, los agentes de esa carpeta en lugar de los del proyecto de la ejecución."""
    session = current_run_session()
    patterns = session.watch_agents if session is not None else ()
    if not patterns or ctx is None:
        return _tool_error("check_agents is only available in a --run-file run with watchAgents.")
    own_id = session.conversation_id or session.new_conversation_id or ""
    try:
        ctx = _target_project(ctx, project, "RW" if prune_keep is not None else "R")
    except ValueError as exc:
        return _tool_error(str(exc))
    detail = agent is not None or conversation_id is not None
    if (offset or include_turn) and (prune_keep is not None or not detail):
        return _tool_error("offset and include_turn go with agent or conversation_id.")
    if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0:
        return _tool_error("offset must be a non-negative integer.")
    if prune_keep is not None:
        if conversation_id is not None or wait_seconds:
            return _tool_error("prune_keep goes alone or with agent, without conversation_id or wait_seconds.")
        return _checked_prune(_watched_conversations(ctx, patterns, own_id), agent, prune_keep)

    def read():
        return _selected(ctx, patterns, own_id, agent, conversation_id)

    wait = max(0, min(int(wait_seconds or 0), AGENT_MAX_WAIT))
    extra = {}
    if wait:
        started = time.monotonic()
        selected, reason = _wait_for_change(read, wait)
        extra = {"returned_because": reason, "waited_s": round(time.monotonic() - started, 1)}
    else:
        selected = read()
    if selected is None:
        return _tool_error("That agent or conversation is not a watched agent of this project.")
    if not detail:
        return json.dumps({"success": True, **_listing(selected), **extra}, ensure_ascii=False)
    return _detail(*selected[0], offset, include_turn, extra)


def _checked_prune(convs: list[dict], agent: str | None, keep) -> str:
    if isinstance(keep, bool) or not isinstance(keep, int) or not 0 <= keep <= AGENT_PRUNE_KEEP_MAX:
        return _tool_error(f"prune_keep must be an integer between 0 and {AGENT_PRUNE_KEEP_MAX}.")
    if agent is not None and not any(conv["agent"] == agent for conv in convs):
        return _tool_error("That agent is not a watched agent of this project.")
    return _prune(convs, agent, keep)


def _detail(conv: dict, run: dict, offset: int, include_turn: bool, extra: dict) -> str:
    """El detalle de una conversación: su estado, un bloque de su respuesta final y, con include_turn, su último turno."""
    result = run.get("result_text") or ""
    if offset > len(result):
        return _tool_error(f"offset {offset} is past the end of the final answer ({len(result)} characters).")
    turn = {}
    if include_turn:
        messages, truncated = _last_turn((get_conversation(conv["id"]) or {}).get("history") or [])
        turn = {"last_turn": messages, **({"last_turn_truncated": True} if truncated else {})}
    return json.dumps({"success": True, **_agent_state(conv, run), **_result_page(result, offset), **turn, **extra},
                      ensure_ascii=False)

def launch_agent(run_file: str | None = None, prompt: str | None = None, project: str | None = None,
                 ctx: SecurityContext | None = None) -> str:
    """Lanza el run-file `run_file` (ruta dentro del proyecto) de un agente vigilado, separado de este master, y
    devuelve su conversation_id y run_id. Con prompt sustituye el del fichero; con project, el run-file y la ejecución
    son de esa carpeta, con su entorno guardado y sus permisos."""
    session = current_run_session()
    patterns = session.watch_agents if session is not None else ()
    if not patterns or ctx is None:
        return _tool_error("launch_agent is only available in a --run-file run with watchAgents.")
    if not isinstance(run_file, str) or not run_file.strip():
        return _tool_error("run_file is required: the path of the agent's run-file JSON in the project, such as agents/report.json.")
    try:
        target = _target_project(ctx, project, "R")
        path = target.absolute(run_file.strip())
        if not path.is_relative_to(target.workspace_dir.resolve()):
            raise ValueError(f"run_file must be inside the project folder {target.workspace_dir}.")
        if not ACCESS_CONTROLLER.allows_path("R", str(path), ctx):
            raise ValueError(f"This project's directory rules do not give R access to {path}.")
        with open(path, "rb") as handle:
            request = parse_run_request(handle.read(RUN_FILE_MAX_BYTES + 1))
        return _launch(request, prompt, target, patterns, own_id=session.conversation_id or session.new_conversation_id or "")
    except OSError as exc:
        return _tool_error(f"Could not read the run-file: {exc}")
    except ValueError as exc:
        return _tool_error(str(exc))


def _launch(request: dict, prompt: str | None, target: SecurityContext, patterns: tuple[str, ...], own_id: str) -> str:
    agent = request.get("agent")
    if not agent or not agent_matches(agent, patterns):
        raise ValueError("The run-file must set an agent that matches this run's watchAgents.")
    if prompt is not None:
        if not isinstance(prompt, str) or not prompt.strip():
            raise ValueError("prompt must be a non-empty text.")
        request["prompt"] = prompt.strip()
    if "prompt" not in request and "conversation_id" not in request:
        raise ValueError("The run-file needs a prompt (or give one in prompt).")
    if not get_project_environment(target.key)["saved"]:
        raise ValueError(f"The project {target.workspace_dir} has no saved environment: save its tools and permissions in the UI first.")
    conv_id = request.get("conversation_id")
    conv = get_conversation(conv_id) if conv_id else None
    if conv_id == own_id:
        raise ValueError("A master cannot launch its own conversation.")
    if conv is not None and ((conv.get("project") or "") != _conversation_project(target) or conv.get("agent") != agent):
        raise ValueError(f"The conversation {conv_id} belongs to another project or agent.")
    request["conversation_id"] = conv_id or f"session_{uuid.uuid4()}"
    try:
        check_no_active_run(request["conversation_id"])
    except ValueError:
        raise ValueError(f"The conversation {request['conversation_id']} is already running: nothing was launched.") from None
    launched = launch_run_file(request, Path(target.workspace_dir))
    session = current_run_session()
    if session is not None:
        session.launched_agents[request["conversation_id"]] = {
            "agent": agent, "project": _conversation_project(target), "updatedAt": int(time.time() * 1000)}
    return json.dumps({"success": True, "agent": agent, "conversation_id": request["conversation_id"], "new": conv is None,
                       "run_id": launched["run_id"], "project": target.key,
                       "note": "It runs on its own: follow it with check_agents (with the same project), which can wait for it."},
                      ensure_ascii=False)

# --- tools.filesystem ---
"""Herramientas de archivos del servidor local: listar, leer, escribir, editar, buscar y diagnosticar dentro de las rutas que autoriza el proyecto."""




IGNORED_WORKSPACE_DIRS = {
    ".git", ".venv", "venv", "node_modules", "__pycache__",
    ".pytest_cache", ".cache", ".gemini", "dist", "build"
}


LIST_DIRECTORY_MAX_ENTRIES = 1000


def _directory_entry(entry: os.DirEntry, target: Path, recursive: bool) -> dict:
    """Datos de una entrada de list_directory; OSError si desaparece o no se puede leer."""
    stat = entry.stat(follow_symlinks=False)
    is_dir = entry.is_dir(follow_symlinks=False)
    try:
        resolved_path = str(Path(entry.path).resolve())
    except (OSError, RuntimeError):
        resolved_path = str(Path(entry.path).absolute())
    data = {
        "name": entry.name,
        "path": resolved_path,
        "type": "directory" if is_dir else "file",
        "size_bytes": None if is_dir else stat.st_size,
        "is_symlink": entry.is_symlink()
    }
    if recursive:
        try:
            data["relative_path"] = Path(entry.path).relative_to(target).as_posix()
        except ValueError:
            data["relative_path"] = entry.name
    return data


def _scan_directory(current: Path, target: Path, depth: int, max_depth: int, recursive: bool, entries: list[dict]):
    """Añade a entries el contenido de current, carpetas primero, sin seguir enlaces y hasta el tope de entradas."""
    if depth > max_depth or len(entries) >= LIST_DIRECTORY_MAX_ENTRIES:
        return
    try:
        with os.scandir(current) as it:
            items = sorted(it, key=lambda e: (not e.is_dir(follow_symlinks=False), e.name.lower()))
    except OSError:
        return
    for entry in items:
        if len(entries) >= LIST_DIRECTORY_MAX_ENTRIES:
            break
        try:
            data = _directory_entry(entry, target, recursive)
            entries.append(data)
            if recursive and data["type"] == "directory" and not data["is_symlink"]:
                _scan_directory(Path(entry.path), target, depth + 1, max_depth, recursive, entries)
        except OSError:
            continue


def list_directory(path: str = ".", recursive: bool = False, *, ctx: SecurityContext) -> str:
    """List files and directories in a local directory with safe bounded recursive traversal."""
    try:
        target = ctx.absolute(path)
        if not target.exists():
            return _tool_error(f"Path '{path}' does not exist.")
        if not target.is_dir():
            return _tool_error(f"Path '{path}' is not a directory.")
        entries: list[dict] = []
        _scan_directory(target, target, 1, 3 if recursive else 1, recursive, entries)
        return json.dumps({
            "success": True,
            "path": str(target),
            "recursive": bool(recursive),
            "total_items": len(entries),
            "entries": entries
        }, ensure_ascii=False, indent=2)
    except Exception as e:
        return _tool_error(str(e))


# Códigos de control de terminal (colores, movimiento del cursor) que un log trae y el modelo no necesita.
ANSI_ESCAPE_RE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]")
READ_TAIL_BLOCK_BYTES = 64 * 1024
MAX_READ_LINES = 2000


def _terminal_line(line: str) -> str:
    """Una línea como la deja una terminal: sin códigos de color y, si se reescribe con \\r, su último tramo."""
    ending = "\n" if line.endswith("\n") else ""
    text = ANSI_ESCAPE_RE.sub("", line[:-1] if ending else line).rstrip("\r")
    return text[text.rfind("\r") + 1:] + ending


def _count_lines(target: Path) -> int:
    lines = 0
    last = b""
    with open(target, "rb") as handle:
        while chunk := handle.read(1024 * 1024):
            lines += chunk.count(b"\n")
            last = chunk[-1:]
    return lines + (1 if last and last != b"\n" else 0)


def _read_tail(target: Path, tail_lines: int, max_bytes: int) -> str:
    """Las últimas tail_lines líneas, leyendo el fichero desde el final por bloques y sin pasar de max_bytes."""
    file_size = target.stat().st_size
    wanted = max(1, min(int(tail_lines), MAX_READ_LINES))
    data = b""
    with open(target, "rb") as handle:
        position = file_size
        # Una línea más de las pedidas: la primera del bloque puede estar a medias.
        while position > 0 and data.count(b"\n") <= wanted and len(data) < max_bytes:
            step = min(READ_TAIL_BLOCK_BYTES, position)
            position -= step
            handle.seek(position)
            data = handle.read(step) + data
    truncated_bytes = len(data) > max_bytes
    if truncated_bytes:
        data = data[-max_bytes:]
    # Solo \n separa líneas: splitlines también parte en \r y desharía las barras de progreso.
    parts = data.decode("utf-8", errors="replace").split("\n")
    lines = [part + "\n" for part in parts[:-1]] + ([parts[-1]] if parts[-1] else [])
    if (position > 0 or truncated_bytes) and lines:
        lines = lines[1:]
    lines = lines[-wanted:]
    total_lines = _count_lines(target)
    start_line = total_lines - len(lines) + 1
    return json.dumps({
        "success": True,
        "path": str(target),
        "size_bytes": file_size,
        "total_lines": total_lines,
        "start_line": start_line,
        "end_line": total_lines,
        "lines_returned": len(lines),
        "truncated": start_line > 1,
        "content": "".join(_terminal_line(line) for line in lines)
    }, ensure_ascii=False, indent=2)


# Pasado el rango pedido, read_file sigue contando líneas para total_lines hasta este número más allá del inicio.
READ_COUNT_AHEAD_LINES = 50000


def _read_line_range(target: Path, start: int, count: int, max_bytes: int) -> tuple[list[str], int, bool]:
    """Hasta count líneas desde start sin pasar de max_bytes (la última, cortada). Devuelve las líneas, las que
    se han contado (todas, o hasta READ_COUNT_AHEAD_LINES más allá de start) y si se cortó por bytes."""
    selected: list[str] = []
    used = 0
    total_lines = 0
    with open(target, "r", encoding="utf-8", errors="replace") as f:
        for line_no, line in enumerate(f, 1):
            total_lines = line_no
            if line_no < start:
                continue
            if len(selected) >= count:
                if line_no > start + READ_COUNT_AHEAD_LINES:
                    break
                continue
            encoded = line.encode("utf-8")
            if used + len(encoded) > max_bytes:
                if max_bytes > used:
                    selected.append(encoded[:max_bytes - used].decode("utf-8", errors="ignore"))
                return selected, total_lines, True
            selected.append(line)
            used += len(encoded)
    return selected, total_lines, False


def read_file(path: str, start_line: int = 1, end_line: int = None, max_lines: int = 500, max_bytes: int = 100000,
              tail_lines: int | None = None, *, ctx: SecurityContext) -> str:
    """Read text content from a local file in streaming mode with safe ranges and bounds, or its last lines."""
    try:
        target = ctx.absolute(path)
        if not target.exists():
            return _tool_error(f"File '{path}' does not exist.")
        if not target.is_file():
            return _tool_error(f"Path '{path}' is not a regular file.")

        file_size = target.stat().st_size
        safe_max_bytes = max(1024, min(int(max_bytes), 2000000))
        if tail_lines is not None:
            return _read_tail(target, tail_lines, safe_max_bytes)
        start = max(1, int(start_line))
        if end_line is not None:
            count = min(max(start, int(end_line)) - start + 1, MAX_READ_LINES)
        else:
            count = max(1, min(int(max_lines), MAX_READ_LINES))

        selected, total_lines, truncated_bytes = _read_line_range(target, start, count, safe_max_bytes)
        return json.dumps({
            "success": True,
            "path": str(target),
            "size_bytes": file_size,
            "total_lines": total_lines,
            "start_line": start,
            "end_line": start + len(selected) - 1,
            "lines_returned": len(selected),
            "truncated": truncated_bytes or start + count - 1 < total_lines,
            "content": "".join(selected)
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


def _existing_directory(path, ctx: SecurityContext) -> Path:
    """La carpeta `path` (relativa al proyecto de la petición) resuelta; ValueError si no es una carpeta."""
    if not isinstance(path, str) or not path.strip():
        raise ValueError("La ruta del directorio está vacía.")
    if len(path) > MAX_PATH_LENGTH:
        raise ValueError("La ruta del directorio excede el tamaño máximo permitido.")
    target = ctx.absolute(path)
    if not target.is_dir():
        raise ValueError(f"'{path}' no existe o no es un directorio.")
    return target


def resolve_project_directory(path, ctx: SecurityContext) -> dict:
    """
    Valida la carpeta que elige una pestaña como proyecto (relativa al suyo actual). El servidor no la
    guarda: la pestaña la envía en cada petición (X-ZeroChat-Project) y otras pestañas siguen en la suya.
    """
    # Cambiar de proyecto no borra nada: cada proyecto conserva su propia sesión.
    return {"cwd": str(_existing_directory(path, ctx))}


PROJECT_CONTEXT_MAX_BYTES = 16384


def _can_read_project_file(rel_path: str, ctx: SecurityContext) -> bool:
    path = str(ctx.workspace_dir / rel_path)
    return ACCESS_CONTROLLER.evaluate_authorization(
        "read_file", {"path": path}, context=ctx, server_name="mcp-proxy", server_id=""
    ).status == POLICY_ALLOW


def _read_project_text(rel_path: str, ctx: SecurityContext, max_lines: int = MAX_READ_LINES) -> tuple[str, dict | None, str]:
    """Lee un fichero del proyecto: devuelve (status, {content, truncated}, error)."""
    try:
        target = ctx.absolute(rel_path)
        if not target.exists():
            return "missing", None, ""
        if not target.is_file():
            return "error", None, f"Path '{rel_path}' is not a regular file."
        selected, total_lines, truncated_bytes = _read_line_range(target, 1, max_lines, PROJECT_CONTEXT_MAX_BYTES)
        return "ok", {"content": "".join(selected), "truncated": truncated_bytes or max_lines < total_lines}, ""
    except OSError as exc:
        return "error", None, str(exc)


def read_project_context(ctx: SecurityContext) -> dict:
    """
    Contexto del modo proyecto (.zerochat/task.py, .zerochat/state.md y AGENTS.md) en una sola lectura,
    sujeta a las mismas reglas de lectura que read_file sin abrir retos interactivos.
    """
    if not _can_read_project_file(".zerochat/task.py", ctx):
        return {"status": "denied"}
    helper_status, _, helper_err = _read_project_text(".zerochat/task.py", ctx, max_lines=1)
    if helper_status != "ok":
        return {"status": helper_status, **({"error": helper_err} if helper_err else {})}
    if not _can_read_project_file(".zerochat/state.md", ctx):
        return {"status": "denied"}
    state_status, state_data, state_err = _read_project_text(".zerochat/state.md", ctx)
    if state_status == "error":
        return {"status": "error", "error": state_err}
    rules_data = None
    if _can_read_project_file("AGENTS.md", ctx):
        _, rules_data, _ = _read_project_text("AGENTS.md", ctx)
    empty = {"content": "", "truncated": False}
    return {
        "status": "ok",
        "rules": rules_data or empty,
        "state": state_data or empty,
    }


# Subcarpetas de una respuesta del selector de carpeta de trabajo: una carpeta con más avisa de las que faltan.
MAX_BROWSE_ENTRIES = 1000


def browse_directories(params: dict, ctx: SecurityContext) -> dict:
    """
    Subcarpetas no ocultas de `path` (vacía, el proyecto de la petición), por nombre, para que la persona
    elija la carpeta de trabajo. Como set_directory, no es una herramienta del modelo: no la limita la
    carpeta del proyecto, solo lo que el usuario del sistema puede leer, y nunca muestra ficheros.
    """
    path = params.get("path")
    target = ctx.workspace_dir.resolve() if path in (None, "") else _existing_directory(path, ctx)
    names = []
    try:
        with os.scandir(target) as items:
            for item in items:
                if item.name.startswith("."):
                    continue
                try:
                    if item.is_dir():
                        names.append(item.name)
                except OSError:
                    continue
    except OSError as exc:
        raise ValueError(f"No se puede leer '{target}': {exc.strerror or exc}") from exc
    names.sort(key=lambda name: (name.lower(), name))
    return {
        "path": str(target),
        "parent": None if target.parent == target else str(target.parent),
        "directories": names[:MAX_BROWSE_ENTRIES],
        "total": len(names),
        "truncated": len(names) > MAX_BROWSE_ENTRIES,
    }


def create_project_directory(params: dict, ctx: SecurityContext) -> dict:
    """
    Crea la carpeta `name` dentro de `parent` para usarla como proyecto. Solo bajo la carpeta personal del
    usuario: crear un proyecto no necesita escribir en el resto del sistema. El nombre es un solo nivel
    y no oculto, porque el selector no muestra las ocultas.
    """
    name = params.get("name")
    if not isinstance(name, str) or not name.strip():
        raise ValueError("El nombre de la carpeta está vacío.")
    name = name.strip()
    if len(name) > 255 or any(sep in name for sep in ("/", "\\", "\0")) or name.startswith("."):
        raise ValueError(f"'{name}' no es un nombre de carpeta válido: sin separadores y sin empezar por un punto.")
    parent = _existing_directory(params.get("parent"), ctx)
    home = Path.home().resolve()
    if parent != home and home not in parent.parents:
        raise ValueError(f"Solo se pueden crear carpetas dentro de {home}.")
    target = parent / name
    try:
        target.mkdir()
    except FileExistsError as exc:
        raise ValueError(f"'{target}' ya existe.") from exc
    except OSError as exc:
        raise ValueError(f"No se puede crear '{target}': {exc.strerror or exc}") from exc
    return {"path": str(target)}


def validate_deletable_project_dir(ctx: SecurityContext) -> Path:
    """Comprueba que la carpeta del proyecto puede borrarse sin tocar raíces, ~, general ni ~/zerochat."""
    target = ctx.workspace_dir.resolve()
    no_project = get_no_project_dir().resolve()
    data_dir = get_data_dir().resolve()
    home = Path.home().resolve()
    if target == target.parent or target == home or target == no_project:
        raise ValueError("No se puede borrar la carpeta general, la carpeta personal ni una raíz del sistema.")
    if target == data_dir or target in data_dir.parents:
        raise ValueError("No se puede borrar la carpeta de datos de ZeroChat.")
    return target


def _walk_project_files(target: Path) -> Iterator[Path]:
    """Ficheros bajo target en orden, sin los directorios ignorados ni los ocultos, y sin los enlaces simbólicos
    que salen de target (no se lee nada fuera de la carpeta que se autorizó)."""
    for root, dirs, files in os.walk(target):
        dirs[:] = [d for d in dirs if d not in IGNORED_WORKSPACE_DIRS and not d.startswith(".")]
        for fname in sorted(files):
            fpath = Path(root) / fname
            try:
                if fpath.is_symlink() and not fpath.resolve().is_relative_to(target):
                    continue
            except (OSError, ValueError):
                continue
            yield fpath


SEARCH_MAX_FILE_BYTES = 2 * 1024 * 1024
SEARCH_LINE_CHARS = 300


def _search_lines(fpath: Path, target: Path, terms: tuple[str, ...], limit: int) -> list[dict]:
    """Hasta limit líneas de fpath que contienen alguno de los textos; un fichero que no se puede leer no tiene ninguna."""
    try:
        rel_path = fpath.relative_to(target).as_posix()
    except ValueError:
        rel_path = str(fpath)
    found = []
    try:
        with open(fpath, "r", encoding="utf-8", errors="ignore") as f:
            for line_idx, line in enumerate(f, 1):
                if line_matches(line, terms):
                    found.append({"file": str(fpath), "relative_path": rel_path, "line_number": line_idx,
                                  "content": line.rstrip("\r\n")[:SEARCH_LINE_CHARS]})
                    if len(found) >= limit:
                        break
    except OSError:
        pass
    return found


def search_files(query: str, path: str = ".", file_pattern: str = None, max_results: int = 100, *, ctx: SecurityContext) -> str:
    """
    Busca texto fijo, sin distinguir mayúsculas, en un fichero o en los de una carpeta: la consulta es uno o varios
    textos separados por | y no una expresión regular, porque re no suelta el GIL y una expresión con retroceso
    catastrófico congelaría todo el servidor (como en check_command). Las búsquedas reales son texto fijo.
    """
    try:
        target = ctx.absolute(path)
        if not target.exists():
            return _tool_error(f"Path '{path}' does not exist.")
        terms = text_terms(query)
        if not terms:
            return _tool_error("query needs at least one text, such as 'validate_token|check_token'.")

        try:
            safe_max_results = max(1, min(int(max_results), 500))
        except (TypeError, ValueError):
            safe_max_results = 100

        matches = []
        files_searched = 0
        root = target if target.is_dir() else target.parent
        for fpath in _walk_project_files(target) if target.is_dir() else (target,):
            if file_pattern and not fnmatch.fnmatch(fpath.name, file_pattern):
                continue
            try:
                if fpath.stat().st_size > SEARCH_MAX_FILE_BYTES:
                    continue
            except OSError:
                continue
            files_searched += 1
            matches.extend(_search_lines(fpath, root, terms, safe_max_results - len(matches)))
            if len(matches) >= safe_max_results:
                break

        payload = {
            "success": True,
            "path": str(target),
            "query": query,
            "file_pattern": file_pattern,
            "files_searched": files_searched,
            "total_matches": len(matches),
            "truncated": len(matches) >= safe_max_results,
            "matches": matches
        }
        return json.dumps(payload, ensure_ascii=False, indent=2)
    except Exception as e:
        return _tool_error(str(e))


def _diagnostic(file: str, line: int, column: int, message: str) -> dict:
    return {"file": file, "line": line, "column": column, "severity": "error", "message": message}


def _python_diagnostics(fpath: Path, display: str) -> list[dict]:
    try:
        compile(fpath.read_text(encoding="utf-8", errors="replace"), str(fpath), "exec")
    except SyntaxError as e:
        return [_diagnostic(display, e.lineno or 1, e.offset or 1, f"SyntaxError: {e.msg}")]
    return []


def _js_diagnostics(fpath: Path, display: str) -> list[dict]:
    """node --check, si hay node; sin él no se comprueba nada."""
    node_bin = shutil.which("node")
    if not node_bin:
        return []
    try:
        res = subprocess.run([node_bin, "--check", str(fpath)], capture_output=True, text=True, timeout=10)
    except (subprocess.SubprocessError, OSError):
        return []
    if res.returncode == 0:
        return []
    stderr = res.stderr or ""
    line_match = re.search(r':(\d+)\n([^\n]+)\n(\s*)\^', stderr)
    line = int(line_match.group(1)) if line_match else 1
    col = len(line_match.group(3)) + 1 if line_match else 1
    msg_match = re.search(r'(SyntaxError:[^\n]+)', stderr)
    msg = msg_match.group(1) if msg_match else (stderr.strip().splitlines()[-1] if stderr.strip() else "Syntax error")
    return [_diagnostic(display, line, col, msg)]


def _json_diagnostics(fpath: Path, display: str) -> list[dict]:
    try:
        json.loads(fpath.read_text(encoding="utf-8", errors="replace"))
    except json.JSONDecodeError as e:
        return [_diagnostic(display, e.lineno, e.colno, f"JSONDecodeError: {e.msg}")]
    return []


# Comprobación de sintaxis por extensión: un lenguaje nuevo es una entrada más.
DIAGNOSTIC_CHECKS = {
    ".py": _python_diagnostics,
    ".js": _js_diagnostics, ".mjs": _js_diagnostics, ".cjs": _js_diagnostics,
    ".json": _json_diagnostics,
}
DIAGNOSTICS_MAX_FILES = 200


def _file_diagnostics(fpath: Path, workspace_dir: Path) -> list[dict]:
    check = DIAGNOSTIC_CHECKS.get(fpath.suffix.lower())
    if check is None:
        return []
    try:
        display = fpath.relative_to(workspace_dir).as_posix()
    except ValueError:
        display = str(fpath)
    return check(fpath, display)


def get_diagnostics(path: str | None = None, *, ctx: SecurityContext) -> str:
    """Retrieve syntax diagnostics and code errors for a file or the entire workspace."""
    try:
        target = ctx.absolute(path) if path is not None and str(path).strip() else ctx.workspace_dir

        if not target.exists():
            return _tool_error(f"Path '{path}' does not exist.")

        if target.is_file():
            checked = [target]
        else:
            checkable = (fp for fp in _walk_project_files(target) if fp.suffix.lower() in DIAGNOSTIC_CHECKS)
            checked = list(itertools.islice(checkable, DIAGNOSTICS_MAX_FILES))
        files_checked = len(checked)
        diagnostics = [diag for fp in checked for diag in _file_diagnostics(fp, ctx.workspace_dir)]

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

# --- tools.jobs_rpc ---
"""Métodos JSON-RPC de los comandos del proyecto para la interfaz: lista, tarjetas, log, detener y cortar esperas."""





def _report(params: dict, project: str) -> RpcOutcome:
    ids = params.get("ids")
    if not isinstance(ids, list) or len(ids) > 100 or any(isinstance(i, bool) or not isinstance(i, int) for i in ids):
        return rpc_error(INVALID_PARAMS, "ids debe ser una lista de hasta 100 enteros.")
    return rpc_result({"reports": JOBS.report_finished(ids, project)})


def _log(params: dict, job) -> RpcOutcome:
    tail = params.get("tail")
    offset = params.get("offset", 0)
    limit = params.get("limit", JOB_LOG_PAGE_BYTES)
    try:
        wait_ms = parse_nonneg_int(params.get("wait_ms"), "wait_ms")
        if tail is not None:
            start = max(0, job.total - parse_nonneg_int(tail, "tail"))
        else:
            start = parse_nonneg_int(offset, "offset")
    except ValueError as exc:
        return rpc_error(INVALID_PARAMS, str(exc))
    if isinstance(limit, bool) or not isinstance(limit, int) or limit <= 0:
        return rpc_error(INVALID_PARAMS, "limit debe ser un entero positivo.")
    if wait_ms > 0 and tail is None and not job.done.is_set() and start >= job.total:
        job.wait_change(start, min(wait_ms, LONG_POLL_MAX_WAIT_MS) / 1000.0)
    text, next_offset = job.read_range(start, min(limit, JOB_LOG_PAGE_BYTES))
    return rpc_result({
        "text": text,
        "offset": start,
        "next": next_offset,
        "total": job.total,
        "done": job.done.is_set(),
        "details": job.summary(),
    })


def _stop(_params: dict, job) -> RpcOutcome:
    JOBS.stop(job, "user")
    return rpc_result({**job_details(job), "jobs": JOBS.running_summaries(job.project)})


PROJECT_JOB_METHODS = {
    "zerochat/jobs/list": lambda _params, project: rpc_result({"jobs": [job.summary() for job in JOBS.list(project)]}),
    "zerochat/jobs/report": _report,
    "zerochat/jobs/end_wait": lambda params, _project: rpc_result({"ended": WAITS.cancel(params.get("key"))}),
}
# Métodos sobre un comando concreto, que se localiza por su id o por la clave de la invocación.
SINGLE_JOB_METHODS = {
    "zerochat/jobs/get": lambda _params, job: rpc_result(job_details(job)),
    "zerochat/jobs/log": _log,
    "zerochat/jobs/stop": _stop,
}


def dispatch_jobs(method: str, params: dict, ctx: SecurityContext) -> RpcOutcome:
    """Comandos del proyecto de la petición: tarjetas, log y botón de detener de la interfaz."""
    if method in PROJECT_JOB_METHODS:
        return dispatch_table(PROJECT_JOB_METHODS, method, params, ctx.key)
    if method not in SINGLE_JOB_METHODS:
        return rpc_not_supported(method)
    key = params.get("key")
    job = JOBS.get(ctx.key, job_id=params.get("id"), key=key)
    if job is None and method == "zerochat/jobs/log" and params.get("id") is None and isinstance(key, str) and key:
        # La tarjeta pide el log por la clave antes de que se lance el comando: con wait_ms espera a que se lance.
        # Por id no se espera: un id que no existe ya no existirá.
        try:
            wait_ms = min(parse_nonneg_int(params.get("wait_ms"), "wait_ms"), LONG_POLL_MAX_WAIT_MS)
        except ValueError as exc:
            return rpc_error(INVALID_PARAMS, str(exc))
        started = time.monotonic()
        job = JOBS.wait_registered(ctx.key, key, wait_ms / 1000.0) if wait_ms > 0 else None
        # Lo que queda de la espera es para la salida nueva.
        params = {**params, "wait_ms": max(0, wait_ms - int((time.monotonic() - started) * 1000))}
    if job is None:
        return rpc_error(INVALID_PARAMS, "Comando no encontrado: puede pertenecer a una sesión anterior de ZeroChat.")
    return dispatch_table(SINGLE_JOB_METHODS, method, params, job)

# --- tools.project_files ---
"""Navegador de ficheros del proyecto para la interfaz: lista, lee y descarga sin salir de su carpeta.

Lo usa la persona, no el modelo: lo limita la carpeta del proyecto de la petición, no el motor de permisos.
"""




# Entradas de una carpeta en una respuesta: una carpeta con más (node_modules) avisa de las que faltan.
MAX_LIST_ENTRIES = 2000
# Bytes del comienzo que deciden si un fichero es texto: un byte nulo o un UTF-8 no válido lo hacen binario.
TEXT_SNIFF_BYTES = 8192
# Un texto más grande no se abre en una pestaña: se descarga.
MAX_TEXT_VIEW_BYTES = 2 * 1024 * 1024
DOWNLOAD_PAGE_BYTES = 512 * 1024
MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024


def _project_root(ctx: SecurityContext) -> Path:
    return ctx.workspace_dir.resolve()


def _inside(ctx: SecurityContext, path) -> tuple[Path, Path]:
    """La ruta pedida, resuelta con sus enlaces simbólicos, y la raíz; ValueError si sale de la carpeta del proyecto."""
    root = _project_root(ctx)
    if path in (None, ""):
        return root, root
    if not isinstance(path, str):
        raise ValueError("path debe ser una cadena.")
    target = ctx.absolute(path)
    if target != root and root not in target.parents:
        raise ValueError("La ruta queda fuera de la carpeta del proyecto.")
    return target, root


def _relative(target: Path, root: Path) -> str:
    return "" if target == root else target.relative_to(root).as_posix()


def list_project_dir(params: dict, ctx: SecurityContext) -> dict:
    """Carpetas primero y después ficheros, por nombre, con su tamaño y fecha; como mucho MAX_LIST_ENTRIES."""
    target, root = _inside(ctx, params.get("path"))
    if not target.is_dir():
        raise ValueError("La carpeta no existe.")
    entries = []
    with os.scandir(target) as items:
        for item in items:
            try:
                is_dir = item.is_dir()
                info = item.stat()
            except OSError:
                continue
            entries.append({
                "name": item.name,
                "type": "dir" if is_dir else "file",
                "size": None if is_dir else info.st_size,
                "modified": int(info.st_mtime * 1000),
            })
    entries.sort(key=lambda entry: (entry["type"] != "dir", entry["name"].lower(), entry["name"]))
    return {
        "path": _relative(target, root),
        "entries": entries[:MAX_LIST_ENTRIES],
        "total": len(entries),
        "truncated": len(entries) > MAX_LIST_ENTRIES,
    }


def _regular_file(params: dict, ctx: SecurityContext) -> tuple[Path, Path]:
    target, root = _inside(ctx, params.get("path"))
    if not target.is_file():
        raise ValueError("El fichero no existe.")
    return target, root


def read_project_file(params: dict, ctx: SecurityContext) -> dict:
    """El texto de un fichero, o que es binario o demasiado grande para abrirlo (entonces se descarga)."""
    target, root = _regular_file(params, ctx)
    size = target.stat().st_size
    result = {"path": _relative(target, root), "size": size}
    with open(target, "rb") as handle:
        head = handle.read(TEXT_SNIFF_BYTES)
    try:
        # Incremental: un carácter de varios bytes cortado al final del comienzo no lo hace binario.
        codecs.getincrementaldecoder("utf-8")().decode(head, final=len(head) == size)
    except UnicodeDecodeError:
        return {**result, "binary": True}
    if b"\0" in head:
        return {**result, "binary": True}
    if size > MAX_TEXT_VIEW_BYTES:
        return {**result, "binary": False, "too_large": True}
    try:
        text = target.read_bytes().decode("utf-8")
    except UnicodeDecodeError:
        return {**result, "binary": True}
    return {**result, "binary": False, "text": text}


def download_project_file(params: dict, ctx: SecurityContext) -> dict:
    """Una página del fichero en base64 desde offset; la interfaz las pide hasta done."""
    target, root = _regular_file(params, ctx)
    size = target.stat().st_size
    if size > MAX_DOWNLOAD_BYTES:
        raise ValueError(f"El fichero ocupa más de {MAX_DOWNLOAD_BYTES // (1024 * 1024)} MB y no se descarga desde aquí.")
    offset = params.get("offset", 0)
    if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0 or offset > size:
        raise ValueError("offset debe ser un entero entre 0 y el tamaño del fichero.")
    with open(target, "rb") as handle:
        handle.seek(offset)
        chunk = handle.read(DOWNLOAD_PAGE_BYTES)
    following = offset + len(chunk)
    return {
        "path": _relative(target, root),
        "name": target.name,
        "size": size,
        "data": base64.b64encode(chunk).decode("ascii"),
        "next": following,
        "done": following >= size,
    }


def dispatch_files(method: str, params: dict, ctx: SecurityContext) -> tuple[dict | None, dict | None, str]:
    """zerochat/files/list, zerochat/files/read y zerochat/files/download sobre la carpeta del proyecto."""
    params = params if isinstance(params, dict) else {}
    handlers = {
        "zerochat/files/list": list_project_dir,
        "zerochat/files/read": read_project_file,
        "zerochat/files/download": download_project_file,
    }
    handler = handlers.get(method)
    if handler is None:
        return None, {"code": -32601, "message": f"Método '{method}' no soportado."}, ""
    try:
        return handler(params, ctx), None, ""
    except (ValueError, OSError) as exc:
        return None, {"code": -32602, "message": str(exc)}, str(exc)

# --- tools.registry ---
"""Registro de las herramientas locales: definiciones publicadas al modelo, manejadores y validación de argumentos contra su esquema."""



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
        "description": "Read a text file, whole or by line range, or only its last lines with tail_lines (like tail -n): use tail_lines for logs that keep growing.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "maxLength": MAX_PATH_LENGTH, "description": "File path"},
                "start_line": {"type": "integer", "description": "First line (1-based)", "default": 1},
                "end_line": {"type": "integer", "description": "Last line (inclusive)"},
                "max_lines": {"type": "integer", "description": "Line cap if no end_line", "default": 500},
                "max_bytes": {"type": "integer", "description": "Byte cap", "default": 100000},
                "tail_lines": {
                    "type": "integer",
                    "description": "Return only the last N lines (max 2000), without terminal color codes and keeping the last state of progress bars; start_line and end_line are ignored"
                }
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
        "description": (
            "Search project files for plain text, case-insensitively, and return each matching line with its file and line number. "
            "Searches a directory recursively or a single file. Example: search_files(query='validate_token|check_token', path='src')."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "maxLength": 4096,
                    "description": "One or more texts separated by |, searched as plain text (not a regular expression); a line matches if it contains any of them"
                },
                "path": {"type": "string", "maxLength": MAX_PATH_LENGTH, "description": "Directory to search recursively, or a single file (defaults to '.')", "default": "."},
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
            "It waits up to timeout_seconds; a command still running then is not killed: it keeps running in the background "
            "and the result gives its job_id. "
            "Use background=true from the start for anything that takes minutes (generations, builds, training, long test suites) "
            "and for servers or watchers that do not finish on its own; then follow it with check_command. "
            f"Never run a command again while it is still running. Host OS: {DETECTED_OS}."
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
                "timeout_seconds": {"type": "integer", "description": f"Seconds to wait for the command before moving it to the background (default {COMMAND_DEFAULT_TIMEOUT}, max {COMMAND_MAX_TIMEOUT}). Ignored with background=true.", "default": COMMAND_DEFAULT_TIMEOUT},
                "background": {"type": "boolean", "description": "Return after a few seconds and keep the command running; returns a job_id for check_command.", "default": False}
            },
            "required": ["command"]
        }
    },
    {
        "name": "check_command",
        "description": (
            "Check a command started by run_command: returns its status and the output produced since the last check. "
            "Use wait_seconds to wait for it to finish (a maximum: it returns as soon as the command ends), add pattern to "
            "return as soon as a new output line matches it, "
            f"or stop=true to terminate it. Example: check_command(job_id=4, wait_seconds={COMMAND_MAX_WAIT}, pattern='error|Traceback') "
            f"returns when the command finishes, prints an error, or after {COMMAND_MAX_WAIT} s. To follow a long command until it finishes "
            f"(also when the user asks to be told when it ends), call it again with wait_seconds={COMMAND_MAX_WAIT} each time it returns still running."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "job_id": {"type": "integer", "description": "job_id returned by run_command"},
                "wait_seconds": {"type": "integer", "description": f"Maximum seconds to wait for the command to finish; returns earlier when it does (default 0, max {COMMAND_MAX_WAIT})", "default": 0},
                "stop": {"type": "boolean", "description": "Terminate the command and its child processes", "default": False},
                "pattern": {
                    "type": "string",
                    "maxLength": CHECK_PATTERN_MAX_CHARS,
                    "description": "One or more texts separated by |, searched case-insensitively as plain text (not a regular expression) in each new output line; with wait_seconds, returns as soon as a line contains one"
                }
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
    },
    {
        "name": "browser_fill_secret",
        "description": (
            "Fill a saved project secret into Playwright MCP without exposing its value to the model or chat history. "
            "Use mode='input' with ref (for text/password inputs via browser_type) or mode='keypad' with keypad_map "
            "mapping each character (e.g. '0'..'9') to its button ref or [x, y] coordinates for virtual keypads."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "secret": {"type": "string", "maxLength": 64, "description": "Name of the saved project secret"},
                "mode": {"type": "string", "enum": list(BROWSER_SECRET_MODES), "maxLength": 16, "description": "Target mode: 'input' or 'keypad'"},
                "ref": {"type": "string", "maxLength": 128, "description": "Playwright snapshot element ref for mode='input'"},
                "element": {"type": "string", "maxLength": 256, "description": "Human-readable description of the input element"},
                "submit": {"type": "boolean", "description": "Press Enter after typing in mode='input'", "default": False},
                "keypad_map": {"type": "object", "description": "Map of character -> button ref string or [x, y] coordinates for mode='keypad'"}
            },
            "required": ["secret", "mode"]
        }
    }
]
# Solo se publica en una ejecución --run-file con watchAgents (server/rpc.py), que además la autoriza; fuera de ella
# el manejador se niega a responder.
CHECK_AGENTS_DEFINITION = {
    "name": AGENTS_TOOL,
    "description": (
        "Status of the agents that this run supervises (watchAgents), in this project or, with project, in another one. Without arguments, one entry per "
        "agent with its latest conversation: status (running, needs_input, completed, error, limit), step, pending input, "
        f"error, warnings, token usage of the run and its final answer when it fits ({AGENT_LIST_RESULT_MAX_CHARS} characters each, "
        f"{AGENT_LIST_TOTAL_CHARS} in all; otherwise only result_chars). With agent or conversation_id, the final answer in blocks of "
        f"{AGENT_RESULT_PAGE_CHARS} characters (pass next_offset as offset for the next one) and, with include_turn=true, the messages of its last turn. "
        "To wait for the agents instead of calling it repeatedly, give wait_seconds: it keeps waiting while any of the "
        "agents asked about is running and returns at once when none is (returned_because: not_running), as soon as one "
        "of them turns needs_input or error (needs_attention) or when the time is up (wait_elapsed); call it again with "
        "wait_seconds while they are still running. Agents started with launch_agent are listed from the start. To clean up old conversations of the watched agents "
        "(for example, one per scheduled run), give prune_keep=N, optionally with agent: it deletes all but the N most recent "
        "conversations of each agent, never one that is running or waiting for the user, and lists what it deleted and skipped."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "agent": {"type": "string", "maxLength": MAX_AGENT_ID_LENGTH, "description": "Agent id <set>.<name>: details of its latest conversation"},
            "conversation_id": {"type": "string", "maxLength": MAX_CONVERSATION_ID_LENGTH, "description": "Details of this agent conversation"},
            "wait_seconds": {"type": "integer", "description": f"Maximum seconds to wait for a change of the agents asked about before answering (default 0, max {AGENT_MAX_WAIT})", "default": 0},
            "prune_keep": {"type": "integer", "description": f"Delete the older conversations of the watched agents (or of agent), keeping this many most recent per agent (0 to {AGENT_PRUNE_KEEP_MAX}); only when asked, never running or waiting ones"},
            "project": {"type": "string", "maxLength": MAX_PATH_LENGTH, "description": "Folder of another project whose agents to check (default: this run's project); its directory rules must give R (RW to prune)"},
            "offset": {"type": "integer", "description": "With agent or conversation_id: character offset of the final answer to read from (the next_offset of the previous call)", "default": 0},
            "include_turn": {"type": "boolean", "description": "With agent or conversation_id: also return the messages of its last turn, including tool results", "default": False}
        }
    }
}
LAUNCH_AGENT_DEFINITION = {
    "name": LAUNCH_AGENT_TOOL,
    "description": (
        "Start a watched agent from its run-file JSON (for example agents/report.json) as a separate run that keeps going "
        "after this run ends, and return its conversation_id and run_id. The run-file's agent must match watchAgents; it "
        "runs with the saved environment and permissions of its project. Give prompt to replace the run-file's prompt, "
        "and project to launch an agent of another project. Then follow it with check_agents, which can wait for it."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "run_file": {"type": "string", "maxLength": MAX_PATH_LENGTH, "description": "Path of the agent's run-file JSON inside the project"},
            "prompt": {"type": "string", "maxLength": MAX_LAUNCH_PROMPT_LENGTH, "description": "Task for this run, instead of the run-file's prompt"},
            "project": {"type": "string", "maxLength": MAX_PATH_LENGTH, "description": "Folder of another project to launch the agent in (default: this run's project); its directory rules must give R"}
        },
        "required": ["run_file"]
    }
}
# Las de un master, que solo se publican en una ejecución --run-file con watchAgents.
MASTER_TOOL_DEFINITIONS = (CHECK_AGENTS_DEFINITION, LAUNCH_AGENT_DEFINITION)

LOCAL_TOOL_HANDLERS = {
    "list_directory": list_directory,
    "read_file": read_file,
    "write_file": write_file,
    "edit_file": edit_file,
    "run_command": run_command,
    "check_command": check_command,
    "search_files": search_files,
    "get_diagnostics": get_diagnostics,
    "browser_action": browser_action,
    "browser_fill_secret": browser_fill_secret,
    AGENTS_TOOL: check_agents,
    LAUNCH_AGENT_TOOL: launch_agent,
}


ARGUMENT_TYPES = {"string": str, "integer": int, "boolean": bool, "object": dict}


def _argument_error(name: str, value, prop: dict | None) -> str | None:
    """Por qué no vale un argumento según su propiedad del esquema, o None si vale."""
    if prop is None:
        return f"Argumento no permitido: {name}"
    expected_type = ARGUMENT_TYPES.get(prop.get("type"))
    if expected_type is None:
        return f"Tipo no admitido en la definición de '{name}': {prop.get('type')}"
    # bool es subclase de int: un booleano no vale como entero.
    if not isinstance(value, expected_type) or (expected_type is not bool and isinstance(value, bool)):
        return f"Tipo inválido para '{name}'"
    max_length = prop.get("maxLength")
    if max_length is not None and len(value) > max_length:
        return f"'{name}' excede el tamaño máximo permitido"
    return None


def validate_local_tool_arguments(tool_name: str, arguments: dict) -> str | None:
    """Valida tipos y límites de las herramientas locales a partir de su definición canónica."""
    definition = next((item for item in (*LOCAL_TOOLS_DEFINITIONS, *MASTER_TOOL_DEFINITIONS) if item["name"] == tool_name), None)
    if definition is None:
        return None

    schema = definition.get("inputSchema", {})
    properties = schema.get("properties", {})
    for name, value in arguments.items():
        error = _argument_error(name, value, properties.get(name))
        if error:
            return error

    for name in schema.get("required", ()):
        if name not in arguments:
            return f"Falta el argumento obligatorio: {name}"

    if tool_name == "browser_action":
        if arguments.get("action") not in BROWSER_ACTIONS:
            return f"Acción de navegador no permitida: {arguments.get('action')}"
    if tool_name == "browser_fill_secret":
        if arguments.get("mode") not in BROWSER_SECRET_MODES:
            return f"Modalidad no permitida: {arguments.get('mode')}"

    return None

# --- server.tool_calls ---
"""Punto único de ejecución de herramientas (tools/call de los dos endpoints) y métodos de permisos.

Autorizar un reto ejecuta la herramienta pendiente, por eso los métodos zerochat/security/* viven junto a la ejecución.
"""




# Un reto que no existe, ya se usó o es de otro proyecto.
CHALLENGE_NOT_FOUND = -32002


def tool_exception_result(ex: Exception) -> dict:
    return {"content": [{"type": "text", "text": _tool_error(str(ex))}], "isError": True}


def execute_tool(origin: str, tool_name: str, args: dict, ctx: SecurityContext,
                 conversation_id: str = "") -> tuple[dict | None, dict | None, str]:
    """
    Punto único de ejecución de herramientas locales y externas. Un navegador se reserva aquí, al
    ejecutar, para la conversación que lo usa: pedirlo sin llegar a ejecutar no lo ocupa.
    """
    if origin == "local":
        if tool_name == "browser_action":
            browser = tool_name
        elif tool_name == "browser_fill_secret":
            browser = PLAYWRIGHT_SERVER_ID
        else:
            browser = None
    else:
        browser = PLAYWRIGHT_SERVER_ID if GLOBAL_MCP_MANAGER.server_of(tool_name) == PLAYWRIGHT_SERVER_ID else None
    if browser and not BROWSER_LEASES.acquire(browser, conversation_id):
        message = (f"The browser is in use by another conversation. It is released after {int(BROWSER_LEASE_IDLE_SECONDS)} "
                   "seconds without use; tell the user or try again later.")
        return {"content": [{"type": "text", "text": _tool_error(message)}], "isError": True}, None, message
    try:
        return run_tool(origin, tool_name, args, ctx)
    finally:
        # El plazo cuenta desde que la acción termina: lo que tarde no acorta lo que el modelo puede razonar después.
        if browser:
            BROWSER_LEASES.acquire(browser, conversation_id)


def run_tool(origin: str, tool_name: str, args: dict, ctx: SecurityContext) -> tuple[dict | None, dict | None, str]:
    """Ejecuta la herramienta y normaliza su resultado: (result, error JSON-RPC, detalle de error)."""
    if origin == "external":
        try:
            result = GLOBAL_MCP_MANAGER.call(tool_name, args)
        except Exception as ex:
            return tool_exception_result(ex), None, str(ex)
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
        return tool_exception_result(ex), None, str(ex)
    tool_error_info = ""
    try:
        parsed_out = json.loads(tool_output_json)
        if isinstance(parsed_out, dict) and parsed_out.get("success") is False:
            tool_error_info = str(parsed_out.get("error", "Error en herramienta local"))
    except (json.JSONDecodeError, TypeError, ValueError):
        pass
    return {"content": [{"type": "text", "text": tool_output_json}], "isError": bool(tool_error_info)}, None, tool_error_info


def with_job_key(args: dict, job_key: str | None) -> dict:
    return {**args, "job_key": job_key} if job_key else args


def _denied(tool_name: str, reason: str, detail: str = "") -> tuple[dict, None, str]:
    """Denegación por política; en una ejecución desatendida queda además en sus avisos."""
    session = current_run_session()
    if session is not None:
        session.add_warning(f"{tool_name}: {detail or reason}")
    err_msg = f"Bloqueado por política de seguridad: {detail or reason}"
    return {
        "content": [{"type": "text", "text": f"Error: {err_msg}"}],
        "isError": True,
        "securityStatus": "deny",
        "reason": reason
    }, None, err_msg


def _awaiting_approval(tool_name: str, args: dict, server_name: str, server_id: str, decision) -> tuple[dict, None, str]:
    """
    Lo que en la interfaz sería un reto, en una ejecución desatendida (local o de un servicio MCP externo) es una pausa:
    no se ejecuta, el runner cierra el turno y la ejecución termina en needs_input (tool_approval). La persona la
    aprueba o deniega en la interfaz y la reanudación ejecuta esa llamada (take_approved_call).
    """
    log_event(f"[run] {tool_name}: a la espera de que la persona la apruebe ({decision.details or decision.reason})")
    return {
        "awaitingApproval": True,
        "toolName": tool_name,
        "serverName": server_name,
        "serverId": server_id,
        "arguments": args,
        "ruleOffer": decision.rule_offer,
        "details": decision.details,
        "content": [{"type": "text", "text": "This tool needs the user's approval: the run pauses until they answer."}],
        "isError": False
    }, None, ""


def authorize_or_challenge(origin: str, tool_name: str, args: dict, ctx: SecurityContext,
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
        return _denied(tool_name, decision.reason)
    if decision.status == POLICY_ASK:
        session = current_run_session()
        if session is not None:
            if session.take_approved_call(tool_name, args):
                log_event(f"[run] {tool_name}: se ejecuta la llamada que la persona aprobó al reanudar")
                return None
            return _awaiting_approval(tool_name, args, server_name, server_id, decision)
        ch =ACCESS_CONTROLLER.create_challenge(
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


def call_tool(params: dict, ctx: SecurityContext) -> tuple[dict | None, dict | None, str]:
    """tools/call: evalúa, emite un reto o ejecuta la herramienta (local o de un servicio MCP) por el punto único."""
    tool_name = params.get("name", "")
    if tool_name in LOCAL_TOOL_HANDLERS:
        origin = "local"
    elif GLOBAL_MCP_MANAGER.server_of(tool_name):
        origin = "external"
    else:
        return None, {"code": -32601, "message": f"Herramienta local '{tool_name}' no encontrada."}, ""
    raw_args = params.get("arguments")
    args = dict(raw_args) if isinstance(raw_args, dict) else {}
    meta = params.get("_meta") if isinstance(params.get("_meta"), dict) else {}
    # Ni la clave de la invocación ni la conversación son argumentos del modelo: no se evalúan ni se muestran en
    # el reto. Con ella se detiene un run_command y se corta la espera de un check_command (zerochat/jobs/*).
    job_key = meta.get("zerochatJobKey") if origin == "local" and tool_name in (COMMAND_TOOL, JOB_CONTROL_TOOL) else None
    conversation_id = str(meta.get("zerochatConversationId") or "")
    gate = authorize_or_challenge(origin, tool_name, args, ctx, job_key, conversation_id)
    return gate if gate is not None else execute_tool(origin, tool_name, with_job_key(args, job_key), ctx, conversation_id)


def _authorize(params: dict, ctx: SecurityContext) -> RpcOutcome:
    """Resuelve un reto: lo deniega o, si se permite, ejecuta la herramienta pendiente por el punto único."""
    challenge_id = params.get("challengeId")
    if not challenge_id or not isinstance(challenge_id, str):
        return rpc_error(INVALID_PARAMS, "challengeId es obligatorio")
    decision = params.get("decision", "deny")
    if not isinstance(decision, str):
        return rpc_error(INVALID_PARAMS, "decision debe ser un texto")
    if decision == "deny":
        ACCESS_CONTROLLER.revoke_challenge(challenge_id, context=ctx)
        return rpc_result({"authorized": False, "status": "deny"})
    ch = ACCESS_CONTROLLER.authorize_challenge(
        challenge_id, decision, context=ctx,
        command_pattern=params.get("commandPattern"), directory_rule=params.get("directoryRule")
    )
    if not ch:
        return rpc_error(CHALLENGE_NOT_FOUND, "Reto no encontrado o no válido")
    t_origin = ch.get("origin") or "local"
    t_args = ch["arguments"] if isinstance(ch.get("arguments"), dict) else {}
    exec_res, exec_err, tool_err = execute_tool(t_origin, ch["toolName"], with_job_key(t_args, ch.get("jobKey")), ctx, ch.get("conversationId") or "")
    if exec_err:
        return None, exec_err, tool_err
    return {"authorized": True, "result": exec_res, "policies": ACCESS_CONTROLLER.export_state(ctx)}, None, tool_err


SECURITY_METHODS = {
    "zerochat/security/update": lambda params, ctx: rpc_result({"policies": ACCESS_CONTROLLER.import_state(params, context=ctx)}),
    "zerochat/security/authorize": _authorize,
}


def dispatch_security(method: str, params: dict, ctx: SecurityContext) -> RpcOutcome:
    """Políticas y reglas de seguridad almacenadas en el backend local, y resolución de retos."""
    try:
        return dispatch_table(SECURITY_METHODS, method, params if isinstance(params, dict) else {}, ctx)
    except ValueError as exc:
        return rpc_error(INVALID_PARAMS, str(exc))
    except Exception as exc:
        return rpc_error(INTERNAL_ERROR, f"Error de seguridad: {exc}", str(exc))

# --- tools.sandbox_script ---
"""Proceso hijo de execute_javascript en Node. Generated from scripts/sandbox-child.js by scripts/build-sandbox-script.mjs. Do not edit."""


NODE_SANDBOX_ARGS = ["--permission","--disallow-code-generation-from-strings"]
NODE_SANDBOX_SCRIPT = "'use strict';\n// Proceso hijo de execute_javascript en Node: ejecuta el c\u00f3digo del modelo en un contexto de node:vm.\n// Fuente \u00fanica: scripts/build-sandbox-script.mjs genera de aqu\u00ed py/tools/sandbox_script.py y\n// js/sandbox-node-script.js. Se lanza con `node --permission --disallow-code-generation-from-strings -e`.\n//\n// node:vm no es una frontera de seguridad, as\u00ed que hay tres capas:\n//  1. El contexto no recibe ning\u00fan objeto de este proceso: trae sus propios Object, Array, Promise\u2026, y\n//     console y el formato del resultado se definen dentro. Entre los dos lados solo cruzan cadenas, y\n//     el resultado se recoge por sondeo: ni siquiera se espera su promesa, que entregar\u00eda funciones de\n//     este lado a su `then`.\n//  2. Nadie genera c\u00f3digo desde cadenas: ni el contexto (codeGeneration) ni este proceso (el indicador\n//     de arranque). Si un objeto de aqu\u00ed se filtrara (un error de import()), su constructor de funciones\n//     no servir\u00eda para ejecutar nada.\n//  3. Antes de ejecutar el c\u00f3digo, este proceso se queda sin process, require ni module en su global.\nconst vm = require('node:vm');\n\nconst POLL_MS = 5;\nconst stdin = process.stdin;\nconst writeOut = process.stdout.write.bind(process.stdout);\n\nasync function readStdin() {\n  const chunks = [];\n  for await (const chunk of stdin) chunks.push(chunk);\n  return Buffer.concat(chunks).toString('utf8');\n}\n\nconst positiveInt = (value, fallback) => (Number.isInteger(value) && value > 0 ? value : fallback);\n\n// Se ejecuta dentro del contexto: todo lo que crea pertenece al contexto. Guarda las funciones que usa\n// antes de que el c\u00f3digo del modelo pueda cambiarlas.\nconst prelude = (maxOutputLength, maxLogEntries) => `(() => {\n  \"use strict\";\n  const stringify = JSON.stringify;\n  const toText = String;\n  const resolved = Promise.resolve.bind(Promise);\n  const then = Function.prototype.call.bind(Promise.prototype.then);\n  const push = Function.prototype.call.bind(Array.prototype.push);\n  const join = Function.prototype.call.bind(Array.prototype.join);\n  const map = Function.prototype.call.bind(Array.prototype.map);\n  const slice = Function.prototype.call.bind(String.prototype.slice);\n  const maxOut = ${maxOutputLength};\n  const maxLogs = ${maxLogEntries};\n  const logs = [];\n  let outcome;\n\n  function formatValue(value) {\n    if (value === null) return \"null\";\n    if (value === undefined) return \"undefined\";\n    if (typeof value === \"bigint\") return value.toString();\n    if (typeof value !== \"object\") return toText(value);\n    try {\n      return stringify(value, (_key, item) => (typeof item === \"bigint\" ? item.toString() : item), 2);\n    } catch {\n      return toText(value);\n    }\n  }\n  const truncate = text => (text.length > maxOut ? slice(text, 0, maxOut) + \"... [output truncated]\" : text);\n  function addLog(prefix, args) {\n    if (logs.length >= maxLogs) return;\n    const text = join(map(args, formatValue), \" \");\n    push(logs, truncate(prefix ? \"[\" + prefix + \"] \" + text : text));\n  }\n  const finish = value => {\n    outcome = stringify({\n      success: true,\n      result: value !== undefined ? truncate(formatValue(value)) : (logs.length > 0 ? join(logs, \"\\\\n\") : \"undefined\"),\n      logs\n    });\n  };\n  const fail = error => {\n    let message;\n    try {\n      message = error && error.message ? toText(error.message) : toText(error);\n    } catch {\n      message = \"Error\";\n    }\n    outcome = stringify({ success: false, result: \"\", logs, error: message });\n  };\n\n  globalThis.console = {\n    log: (...args) => addLog(\"\", args),\n    info: (...args) => addLog(\"INFO\", args),\n    warn: (...args) => addLog(\"WARN\", args),\n    error: (...args) => addLog(\"ERROR\", args)\n  };\n  Object.defineProperty(globalThis, \"__sandbox\", {\n    value: Object.freeze({\n      run(fn) {\n        try {\n          then(resolved(fn()), finish, fail);\n        } catch (error) {\n          fail(error);\n        }\n      },\n      outcome: () => outcome\n    })\n  });\n})();`;\n\n(async () => {\n  const started = Date.now();\n  const payload = JSON.parse(await readStdin());\n  const code = String(payload.code ?? '');\n  const timeoutMs = positiveInt(payload.timeoutMs, 2500);\n  const maxOutputLength = positiveInt(payload.maxOutputLength, 30000);\n  const maxLogEntries = positiveInt(payload.maxLogEntries, 200);\n\n  const respond = result => writeOut(JSON.stringify({ ...result, executionTimeMs: Date.now() - started }));\n  const failure = error => respond({ success: false, result: '', logs: [], error });\n\n  // Capa 3: lo que un c\u00f3digo que alcanzara este global usar\u00eda para abrir una conexi\u00f3n o cargar m\u00f3dulos.\n  for (const key of ['process', 'require', 'module', 'exports', '__filename', '__dirname', 'fetch', 'WebSocket', 'XMLHttpRequest', 'EventSource']) {\n    delete globalThis[key];\n  }\n\n  const trimmed = code.trim();\n  const isStatement = /^(?:while|for|if|let|const|var|function|class|try|throw|switch|do)\\b/.test(trimmed)\n    || trimmed.includes(';') || trimmed.includes('\\n') || trimmed.includes('return');\n  const body = isStatement ? `\"use strict\";\\n${trimmed}` : `\"use strict\"; return (${trimmed});`;\n  const wrapper = `__sandbox.run(${/\\bawait\\b/.test(trimmed) ? 'async ' : ''}function () {\\n${body}\\n});`;\n\n  const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });\n  vm.runInContext(prelude(maxOutputLength, maxLogEntries), context);\n  try {\n    new vm.Script(wrapper).runInContext(context, { timeout: timeoutMs });\n  } catch (err) {\n    const timedOut = err && err.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT';\n    failure(timedOut ? `Execution timed out after ${timeoutMs}ms and was terminated.` : (err && err.message ? String(err.message) : String(err)));\n    return;\n  }\n\n  // El resultado es una cadena que deja el contexto; quien lanza este proceso lo mata al vencer el plazo.\n  const readOutcome = new vm.Script('__sandbox.outcome()');\n  const poll = setInterval(() => {\n    let raw;\n    try {\n      raw = readOutcome.runInContext(context, { timeout: 100 });\n    } catch {\n      return;\n    }\n    if (typeof raw !== 'string') return;\n    clearInterval(poll);\n    let parsed;\n    try {\n      parsed = JSON.parse(raw);\n    } catch {\n      parsed = null;\n    }\n    if (!parsed || typeof parsed !== 'object') {\n      failure('The sandbox returned an unreadable result.');\n      return;\n    }\n    const logs = Array.isArray(parsed.logs) ? parsed.logs.filter(item => typeof item === 'string').slice(0, maxLogEntries) : [];\n    if (parsed.success === true) respond({ success: true, result: String(parsed.result ?? ''), logs });\n    else respond({ success: false, result: '', logs, error: String(parsed.error ?? 'Error') });\n  }, POLL_MS);\n})();"

# --- tools.sandbox ---
"""Ejecución aislada de JavaScript en un subproceso Node sin credenciales ni permisos."""




DEFAULT_SANDBOX_TIMEOUT_MS = 2500
MAX_SANDBOX_TIMEOUT_MS = 30000
MAX_SANDBOX_OUTPUT_LENGTH = 30000
MAX_SANDBOX_LOG_ENTRIES = 200

def _normalize_timeout_ms(timeout_ms: int | float | None) -> int:
    """Valida y acota el timeout del sandbox en milisegundos."""
    if timeout_ms is None:
        return DEFAULT_SANDBOX_TIMEOUT_MS
    if isinstance(timeout_ms, bool) or not isinstance(timeout_ms, (int, float)) or timeout_ms <= 0:
        raise ValueError("timeout_ms debe ser un número positivo")
    return min(int(timeout_ms), MAX_SANDBOX_TIMEOUT_MS)


def execute_js_sandbox(code: str, timeout_ms: int | float | None = None) -> dict:
    """Ejecuta código JavaScript en un subproceso de Node sin entorno, con el script y los indicadores de tools.sandbox_script."""
    if not isinstance(code, str) or not code.strip():
        return {
            "success": False,
            "result": "",
            "logs": [],
            "executionTimeMs": 0,
            "error": "No code provided to execute.",
        }
    resolved_timeout = _normalize_timeout_ms(timeout_ms)
    node_path = find_node_executable()
    if not node_path:
        raise RuntimeError(NODE_REQUIRED_MESSAGE)

    payload = json.dumps({
        "code": code,
        "timeoutMs": resolved_timeout,
        "maxOutputLength": MAX_SANDBOX_OUTPUT_LENGTH,
        "maxLogEntries": MAX_SANDBOX_LOG_ENTRIES,
    })
    started = time.monotonic()
    popen_kwargs = {
        "stdin": subprocess.PIPE,
        "stdout": subprocess.PIPE,
        "stderr": subprocess.PIPE,
        "text": True,
        "encoding": "utf-8",
        "errors": "replace",
        "env": minimal_child_env(),
    }
    if DETECTED_OS != "windows":
        popen_kwargs["start_new_session"] = True
    proc = subprocess.Popen([node_path, *NODE_SANDBOX_ARGS, "-e", NODE_SANDBOX_SCRIPT], **popen_kwargs)
    try:
        stdout, stderr = proc.communicate(input=payload, timeout=(resolved_timeout + 250) / 1000.0)
    except subprocess.TimeoutExpired:
        _kill_process_tree(proc, grace_seconds=0.05)
        try:
            proc.wait(timeout=1.0)
        except subprocess.TimeoutExpired:
            pass
        return {
            "success": False,
            "result": "",
            "logs": [],
            "executionTimeMs": int((time.monotonic() - started) * 1000),
            "error": f"Execution timed out after {resolved_timeout}ms and was terminated.",
        }

    elapsed_ms = int((time.monotonic() - started) * 1000)
    raw = (stdout or "").strip()
    if raw:
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict) and "success" in parsed:
                return parsed
        except json.JSONDecodeError:
            pass
    err_detail = (stderr or raw or f"Sandbox exited with code {proc.returncode}").strip()
    return {
        "success": False,
        "result": "",
        "logs": [],
        "executionTimeMs": elapsed_ms,
        "error": err_detail,
    }

# --- web.fetch ---
"""Transporte web saliente del servidor (zerochat/web/fetch): anti-SSRF en la URL y en cada redirección, cuerpo acotado, cabeceras de navegador y frecuencia por dominio."""




METADATA_HOSTS = frozenset({
    "169.254.169.254",
    "metadata.google.internal",
    "instance-data",
    "100.100.100.200",
})
# El User-Agent activo se sustituye por el de la primera petición del frontend (variabilidad de
# fingerprint); sin frontend (--prompt/--conversation) se usa el último guardado o el por defecto.
ACTIVE_USER_AGENT = DEFAULT_USER_AGENT
# Último User-Agent real guardado en SQLite: se lee una sola vez por proceso, no en cada petición web.
_STORED_USER_AGENT: str | None = None
_STORED_USER_AGENT_LOADED = False


def capture_frontend_user_agent(user_agent: str) -> None:
    """Adopta y persiste el User-Agent de la primera petición del frontend para las salidas web y Playwright."""
    global ACTIVE_USER_AGENT, _STORED_USER_AGENT, _STORED_USER_AGENT_LOADED
    cleaned = user_agent.strip() if isinstance(user_agent, str) else ""
    if ACTIVE_USER_AGENT is DEFAULT_USER_AGENT and cleaned:
        ACTIVE_USER_AGENT = cleaned
        set_service_user_agent(ACTIVE_USER_AGENT, from_frontend=True)
        save_last_frontend_user_agent(cleaned)
        _STORED_USER_AGENT, _STORED_USER_AGENT_LOADED = cleaned, True


def effective_user_agent() -> str:
    """User-Agent activo del servidor o, en desatendido sin frontend, el último capturado del navegador."""
    global _STORED_USER_AGENT, _STORED_USER_AGENT_LOADED
    if ACTIVE_USER_AGENT is not DEFAULT_USER_AGENT:
        return ACTIVE_USER_AGENT
    if not _STORED_USER_AGENT_LOADED:
        _STORED_USER_AGENT, _STORED_USER_AGENT_LOADED = load_last_frontend_user_agent(), True
    return _STORED_USER_AGENT or DEFAULT_USER_AGENT


WEB_FETCH_MAX_BYTES = 10 * 1024 * 1024
WEB_FETCH_MAX_REDIRECTS = 5
WEB_FETCH_READ_CHUNK = 64 * 1024
TEXT_CONTENT_TYPE_RE = re.compile(
    r"^(text/|application/(json|xml|xhtml\+xml|javascript|x-javascript|ecmascript)$|[a-z]+/[^;]*\+(json|xml)$)"
)
# Frecuencia por dominio frente a retos anti-bot: DuckDuckGo responde con un reto (HTTP 202) a peticiones seguidas o
# simultáneas, así que van de una en una y con 2 s desde la respuesta anterior. Vale para cualquier herramienta que
# pida el dominio o un subdominio, no solo para search_web.
WEB_FETCH_DOMAIN_LIMITS = {
    "duckduckgo.com": RatePolicy(concurrency=1, min_interval_s=2.0),
}


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

    timeout_s = max(0.5, min(float(params.get("timeout_s", 10.0)), 30.0))
    limited = next((domain for domain in WEB_FETCH_DOMAIN_LIMITS if hostname == domain or hostname.endswith("." + domain)), None)
    if limited is None:
        return _fetch_web_resource_unpaced(url, params, hostname, parsed, timeout_s)
    # La espera del turno sale del plazo de la petición: la interfaz no espera más que ese plazo y su margen.
    try:
        with RATE_LIMITER.slot(limited, WEB_FETCH_DOMAIN_LIMITS[limited], max_wait_s=timeout_s - 0.5) as waited:
            return _fetch_web_resource_unpaced(url, params, hostname, parsed, max(0.5, timeout_s - waited))
    except RateLimitBusy as exc:
        return {"ok": False, "status": 0, "error": str(exc)}


def _fetch_web_resource_unpaced(url: str, params: dict, hostname: str, parsed, timeout_s: float) -> dict:
    """Cuerpo de fetch_web_resource sin el control de frecuencia: cabeceras, descarga y respuesta."""
    max_bytes = max(1024, min(int(params.get("max_bytes", 2 * 1024 * 1024)), WEB_FETCH_MAX_BYTES))
    as_binary = bool(params.get("binary", False))
    accept = params.get("accept")
    req_headers = {
        "User-Agent": effective_user_agent(),
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

    # El esquema (http/https) se valida antes, también en cada redirección.
    req = urllib.request.Request(url, headers=req_headers)  # noqa: S310
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

# --- server.rpc ---
"""Métodos JSON-RPC del servidor local: una tabla por método exacto y otra por grupo (prefijo).

Cada método vive junto a su dominio (storage/rpc.py, tools/jobs_rpc.py, run_mode/state.py…); aquí solo se
decide quién atiende cada uno.
"""





def _local_tools() -> list[dict]:
    """Las herramientas locales; check_agents y launch_agent, solo en la ejecución --run-file que vigila agentes (watchAgents)."""
    session = current_run_session()
    extra = MASTER_TOOL_DEFINITIONS if session is not None and session.watch_agents else ()
    return [dict(definition) for definition in (*LOCAL_TOOLS_DEFINITIONS, *extra)]


def rpc_login(params: dict) -> RpcOutcome:
    """zerochat/login: identificación con la cuenta del sistema; se atiende también sin token."""
    try:
        return rpc_result(login(params))
    except LoginError as exc:
        error = {"code": exc.code, "message": str(exc)}
        if exc.data:
            error["data"] = exc.data
        return None, error, ""
    except (RuntimeError, OSError) as exc:
        return rpc_error(INTERNAL_ERROR, f"No se pudo comprobar la contraseña: {exc}", str(exc))


def _initialize(_params: dict, ctx: SecurityContext) -> RpcOutcome:
    return rpc_result({
        "protocolVersion": "2024-11-05",
        "serverInfo": {
            "name": "ZeroChat Local Server",
            "version": VERSION,
            "cwd": str(ctx.workspace_dir),
            "noProjectDir": str(get_no_project_dir()),
            "os": DETECTED_OS,
        },
        "capabilities": {
            "tools": {"listChanged": True},
        },
        "tools": _local_tools(),
        "policies": ACCESS_CONTROLLER.export_state(ctx),
        "projectContext": read_project_context(ctx),
        "projectEnvironment": run_project_environment(get_project_environment(ctx.key)),
        "liveState": live_state(ctx),
    })


def _heartbeat(params: dict, ctx: SecurityContext) -> RpcOutcome:
    since_rev = params.get("since_rev")
    if since_rev is not None and not isinstance(since_rev, str):
        return rpc_error(INVALID_PARAMS, "since_rev debe ser texto")
    try:
        wait_ms = parse_nonneg_int(params.get("wait_ms"), "wait_ms")
    except ValueError as exc:
        return rpc_error(INVALID_PARAMS, str(exc))
    return rpc_result(wait_live_state(ctx, params.get("focus_conversation_id"), since_rev=since_rev, wait_ms=wait_ms))


def _set_project_directory(params: dict, ctx: SecurityContext) -> RpcOutcome:
    # Lo invoca la interfaz a petición del usuario: no es una herramienta del modelo.
    try:
        resolved = resolve_project_directory(params.get("path"), ctx)
        next_ctx = SecurityContext(workspace_dir=Path(resolved["cwd"]))
        return rpc_result({
            **resolved,
            "policies": ACCESS_CONTROLLER.export_state(next_ctx),
            "projectContext": read_project_context(next_ctx),
            "projectEnvironment": run_project_environment(get_project_environment(next_ctx.key)),
        })
    except (ValueError, OSError) as exc:
        return rpc_error(INVALID_PARAMS, str(exc))


def _set_project_environment(params: dict, ctx: SecurityContext) -> RpcOutcome:
    try:
        return rpc_result({"projectEnvironment": save_project_environment(ctx.key, params)})
    except ValueError as exc:
        return rpc_error(INVALID_PARAMS, str(exc))


def _browse_directories(params: dict, ctx: SecurityContext) -> RpcOutcome:
    # Como set_directory, lo invoca la interfaz para que la persona elija la carpeta de trabajo.
    try:
        return rpc_result(browse_directories(params, ctx))
    except (ValueError, OSError) as exc:
        return rpc_error(INVALID_PARAMS, str(exc))


def _create_directory(params: dict, ctx: SecurityContext) -> RpcOutcome:
    try:
        return rpc_result(create_project_directory(params, ctx))
    except (ValueError, OSError) as exc:
        return rpc_error(INVALID_PARAMS, str(exc))


def _list_project_secrets(_params: dict, ctx: SecurityContext) -> RpcOutcome:
    try:
        return rpc_result({"secrets": list_project_secret_names(ctx.key)})
    except ValueError as exc:
        return rpc_error(INVALID_PARAMS, str(exc))


def _set_project_secret(params: dict, ctx: SecurityContext) -> RpcOutcome:
    try:
        return rpc_result({"secrets": save_project_secret(ctx.key, params.get("name"), params.get("value"))})
    except ValueError as exc:
        return rpc_error(INVALID_PARAMS, str(exc))


def _delete_project_secret(params: dict, ctx: SecurityContext) -> RpcOutcome:
    try:
        return rpc_result({"secrets": delete_project_secret(ctx.key, params.get("name"))})
    except ValueError as exc:
        return rpc_error(INVALID_PARAMS, str(exc))


def _delete_project(params: dict, ctx: SecurityContext) -> RpcOutcome:
    try:
        delete_directory = bool(params.get("deleteDirectory"))
        confirm_path = str(params.get("confirmPath") or "").strip()
        if JOBS.running(ctx.key):
            raise ValueError("Detén los comandos y ejecuciones activas del proyecto antes de borrarlo.")
        target = None
        if delete_directory:
            target = validate_deletable_project_dir(ctx)
            if confirm_path != ctx.key and confirm_path != str(target):
                raise ValueError("La ruta de confirmación no coincide con el directorio del proyecto.")
            if has_nested_project_data(ctx.key):
                raise ValueError("Existen subproyectos guardados dentro de este directorio: borra primero sus datos.")
        # Primero los datos (atómico y con la comprobación de ejecuciones en marcha); el disco, solo si eso salió bien.
        deleted_ids = delete_project_storage(ctx.key)
        ACCESS_CONTROLLER.drop_project_session(ctx.key)
        if target is not None and target.exists():
            shutil.rmtree(target)
        return rpc_result({
            "deleted": ctx.key,
            "deletedDirectory": delete_directory,
            "deletedConversationIds": deleted_ids,
            "fallback": str(get_no_project_dir()) if delete_directory else None,
        })
    except (ValueError, OSError) as exc:
        return rpc_error(INVALID_PARAMS, str(exc))


def _open_diff(params: dict, ctx: SecurityContext) -> RpcOutcome:
    try:
        return rpc_result(open_file_diff(params.get("path"), ctx, bool(params.get("commit_fallback")), bool(params.get("gui"))))
    except (ValueError, RuntimeError) as exc:
        return rpc_error(INVALID_PARAMS, str(exc))
    except Exception as exc:
        return rpc_error(INTERNAL_ERROR, f"Error al abrir el visor de diffs: {exc}", str(exc))


def _configure_diff(params: dict, _ctx: SecurityContext) -> RpcOutcome:
    try:
        return rpc_result(configure_gui_diff_tool(params.get("tool")))
    except (ValueError, RuntimeError) as exc:
        return rpc_error(INVALID_PARAMS, str(exc))
    except Exception as exc:
        return rpc_error(INTERNAL_ERROR, f"Error configurando el visor de diffs: {exc}", str(exc))


def _web_fetch(params: dict, _ctx: SecurityContext) -> RpcOutcome:
    try:
        return rpc_result(fetch_web_resource(params))
    except (ValueError, PermissionError) as exc:
        return rpc_error(INVALID_PARAMS, str(exc))
    except Exception as exc:
        return rpc_error(INTERNAL_ERROR, f"Error en transporte web: {exc}", str(exc))


def _sandbox_execute(params: dict, _ctx: SecurityContext) -> RpcOutcome:
    try:
        return rpc_result(execute_js_sandbox(params.get("code"), timeout_ms=params.get("timeout_ms")))
    except ValueError as exc:
        return rpc_error(INVALID_PARAMS, str(exc))
    except Exception as exc:
        return rpc_error(INTERNAL_ERROR, f"Error en sandbox JS: {exc}", str(exc))


LOCAL_METHODS = {
    "initialize": _initialize,
    "zerochat/heartbeat": _heartbeat,
    "zerochat/login": lambda params, _ctx: rpc_login(params),
    "tools/list": lambda _params, _ctx: rpc_result({"tools": _local_tools() + GLOBAL_MCP_MANAGER.tools()}),
    "tools/call": call_tool,
    "zerochat/project/context": lambda _params, ctx: rpc_result(read_project_context(ctx)),
    "zerochat/project/environment/set": _set_project_environment,
    "zerochat/project/set_directory": _set_project_directory,
    "zerochat/project/browse": _browse_directories,
    "zerochat/project/create_directory": _create_directory,
    "zerochat/project/delete": _delete_project,
    "zerochat/project/secrets/list": _list_project_secrets,
    "zerochat/project/secrets/set": _set_project_secret,
    "zerochat/project/secrets/delete": _delete_project_secret,
    "zerochat/diff/open": _open_diff,
    "zerochat/diff/configure": _configure_diff,
    "zerochat/web/fetch": _web_fetch,
    "zerochat/sandbox/execute": _sandbox_execute,
}


def _server_control(method: str, params: dict, _ctx: SecurityContext) -> RpcOutcome:
    return dispatch_server_control(method, params) if method in SERVER_CONTROL_METHODS else rpc_not_supported(method)


# Grupos de métodos, por prefijo: cada despachador recibe (method, params, ctx).
LOCAL_METHOD_GROUPS = (
    ("zerochat/jobs/", dispatch_jobs),
    ("zerochat/files/", dispatch_files),
    ("zerochat/run/", dispatch_run),
    ("zerochat/external/servers/", _server_control),
    ("zerochat/browser/", lambda method, params, _ctx: dispatch_browser(method, params)),
    ("zerochat/profiles/", lambda method, params, _ctx: dispatch_profiles(method, params)),
    ("zerochat/conversations/", lambda method, params, _ctx: dispatch_conversations(method, params)),
    ("zerochat/blobs/", lambda method, params, _ctx: dispatch_blobs(method, params)),
    ("zerochat/security/", dispatch_security),
)


def dispatch_local(method: str, params: dict, ctx: SecurityContext) -> RpcOutcome:
    """Endpoint local: (resultado, error JSON-RPC, detalle de error de herramienta)."""
    if method in LOCAL_METHODS:
        return LOCAL_METHODS[method](params, ctx)
    for prefix, dispatcher in LOCAL_METHOD_GROUPS:
        if method.startswith(prefix):
            return dispatcher(method, params, ctx)
    return rpc_not_supported(method)

# --- server.handler ---
"""Servidor HTTP JSON-RPC del backend local: orígenes admitidos, token e identificación, despacho por grupos de métodos y punto único de ejecución de herramientas."""





def sanitize_log_path(raw_path: str) -> str:
    """Oculta tokens de sesión o parámetros sensibles en la query string para logs seguros."""
    if not raw_path or "?" not in raw_path:
        return raw_path or "/"
    path, query = raw_path.split("?", 1)
    safe_query = re.sub(r'(token=)[^&]+', r'\1***', query, flags=re.IGNORECASE)
    return f"{path}?{safe_query}"


def has_dot_segment(raw_path: str) -> bool:
    """Una URL cuya ruta tiene un segmento `..`, también codificado o con barra invertida: ninguna de ZeroChat lo lleva."""
    path = urllib.parse.unquote(raw_path.split("?", 1)[0].split("#", 1)[0])
    return ".." in re.split(r"[/\\]", path)


def static_file_target(root: Path, rel_path: str) -> Path | None:
    """
    Fichero que sirve el servidor de desarrollo para rel_path: lo que hay bajo la raíz del repositorio,
    salvo ficheros ocultos (.git, .env, .zerochat) y rutas que al resolverse salen de ella (enlaces simbólicos).
    """
    clean_rel = rel_path.split("?", 1)[0].lstrip("/")
    if not clean_rel:
        return None
    base = root.resolve()
    target = (base / clean_rel).resolve()
    try:
        parts = target.relative_to(base).parts
    except ValueError:
        return None
    if any(part.startswith(".") for part in parts) or not target.is_file():
        return None
    return target


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


# zerochat/run/progress ya se registra con su propio texto en dispatch_run; zerochat/run/usage llega tras cada paso.
QUIET_RPC_METHODS = frozenset({
    "zerochat/heartbeat",
    "zerochat/jobs/get",
    "zerochat/jobs/log",
    "zerochat/jobs/list",
    "zerochat/run/progress",
    "zerochat/run/usage",
    "zerochat/project/context",
})
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
        """
        La interfaz del repositorio de desarrollo, sin token: solo en desarrollo (get_static_root) y solo
        a clientes del propio equipo, aunque el servidor escuche en otra dirección con --host.
        """
        static_root = get_static_root()
        if not static_root or not is_loopback_host(self.client_address[0]):
            return False
        target_path = static_file_target(static_root, rel_path)
        if target_path is None:
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
        if target_path == static_root.resolve() / "sw.js":
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

    def _resolve_grant(self) -> TokenGrant | None:
        """
        Comprueba la credencial en cabeceras HTTP y devuelve su TokenGrant o None.
        X-ZeroChat-Token va antes que Authorization, que tras el proxy inverso lleva la clave del proxy.
        """
        token_candidate = self.headers.get("X-ZeroChat-Token", "").strip()
        if not token_candidate:
            auth_header = self.headers.get("Authorization", "")
            if auth_header.startswith("Bearer "):
                token_candidate = auth_header[7:].strip()
        return resolve_token(token_candidate)

    def _reject_dot_segment(self, verb: str, safe_path: str, t0: float) -> bool:
        """Responde 400 a una URL con `..` antes de mirar el origen, el token o el cuerpo; devuelve si lo hizo."""
        if not has_dot_segment(self.path):
            return False
        self._log_req(verb, safe_path)
        # El cuerpo de un POST no se lee: la conexión no se reutiliza.
        self.close_connection = True
        self._reject(400, {"error": "Invalid path"}, safe_path, t0, "Ruta con un segmento '..'")
        return True

    def do_OPTIONS(self):
        t0 = time.monotonic()
        safe_path = sanitize_log_path(self.path)
        if self._reject_dot_segment("OPTIONS", safe_path, t0):
            return
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
        if self._reject_dot_segment("GET", safe_path, t0):
            return
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

    def _read_rpc_request(self, safe_path: str, t0: float) -> dict | None:
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
        return req

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
        self._send_rpc_response(req.get("id"), rpc_login(req.get("params", {})), log_detail, t0)
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

    def do_POST(self):
        t0 = time.monotonic()
        safe_path = sanitize_log_path(self.path)
        if self._reject_dot_segment("POST", safe_path, t0):
            return
        origin = self.headers.get("Origin")
        if not is_allowed_origin(origin):
            self._log_req("POST", safe_path)
            self.send_response(403)
            self.end_headers()
            self._log_res(403, safe_path, (time.monotonic() - t0) * 1000, f"Origen no permitido: '{origin}'")
            return

        capture_frontend_user_agent(self.headers.get("User-Agent", ""))
        mark_browser_active()
        grant = self._resolve_grant()
        # Una ejecución solo atiende a su runner: ni el token diario ni sesiones remotas, ni zerochat/login.
        run = current_run_session() is not None
        if run and grant is not None and grant.kind != "runner":
            grant = None
        if grant is None:
            # Sin token válido solo cabe identificarse para obtenerlo, salvo en una ejecución.
            if not run and self._serve_login(safe_path, t0):
                return
            self._log_req("POST", safe_path)
            self._reject(401, {
                "jsonrpc": "2.0",
                "id": None,
                "error": {"code": -32000, "message": "Unauthorized: invalid or missing session token"}
            }, safe_path, t0, "Token de sesión ausente o inválido")
            return

        req = self._read_rpc_request(safe_path, t0)
        if req is None:
            return
        req_id = req.get("id")
        method = req["method"]
        params = req.get("params", {})

        if not grant.allows(method, params):
            self._log_req("POST", f"{safe_path} [rpc: {method}]")
            self._reject(403, {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -32000, "message": "Forbidden: method not permitted for this token"}
            }, safe_path, t0, f"Método '{method}' no permitido para el token ({grant.kind})")
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
            ctx = request_project_context(self.headers.get("X-ZeroChat-Project"), fallback=method == "initialize")
        except ProjectGoneError as ex:
            self._send_rpc_response(req_id, (None, {"code": PROJECT_GONE_CODE, "message": str(ex)}, ""), log_detail, t0, quiet)
            return
        try:
            outcome = dispatch_local(method, params, ctx)
        except Exception as ex:
            outcome = None, {"code": -32603, "message": f"Error interno: {ex}"}, ""
        self._send_rpc_response(req_id, outcome, log_detail, t0, quiet)

    def log_message(self, format, *args):
        # Silenciar logs ruidosos por defecto
        pass


class ZeroChatHTTPServer(ThreadingHTTPServer):
    """Servidor del backend con una cola de conexiones amplia: la interfaz en desarrollo y el runner de Node piden
    decenas de módulos a la vez, y con la cola de 5 por defecto macOS descarta las que sobran (el cliente agota el
    plazo de conexión) y Windows las reinicia."""
    request_queue_size = 128

    def server_bind(self):
        """Como HTTPServer.server_bind, sin socket.getfqdn: su resolución inversa del host puede tardar decenas de
        segundos (en macOS sin DNS inverso, ~35 s) y el nombre del servidor no se usa."""
        socketserver.TCPServer.server_bind(self)
        host, port = self.server_address[:2]
        self.server_name = str(host)
        self.server_port = port

# --- cli.main ---
"""Punto de entrada de zerochat: argumentos de la línea de órdenes, arranque del servidor, interfaz, ejecución desatendida y cierre."""





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
    parser.color = False  # pyright: ignore[reportAttributeAccessIssue] (atributo de Python 3.14)
    parser.add_argument("--port", type=int, default=None, help=f"Puerto de escucha (default: ZEROCHAT_PORT o {DEFAULT_PORT}; en modo ejecución, uno libre que elige el sistema)")
    parser.add_argument("--host", default=None, help=f"Host de escucha (default: ZEROCHAT_HOST o {DEFAULT_HOST}; el modo ejecución escucha siempre en {DEFAULT_HOST})")
    parser.add_argument("--ui-url", default=None, help="URL de la interfaz web a abrir (por defecto: interfaz local en desarrollo o GitHub Pages)")
    parser.add_argument("--no-browser", action="store_true", help="No abrir automáticamente el navegador")
    parser.add_argument("--keep-server", action="store_true", help="Servidor: seguir en marcha al cerrar el navegador (no se combina con --prompt)")
    parser.add_argument("--no-venv", action="store_true", help="Omitir la comprobación/creación de ~/zerochat/.venv")
    parser.add_argument("--test", action="store_true", help="Ejecutar autocomprobación interna de herramientas")
    parser.add_argument("--list-profiles", action="store_true", help="Listar los perfiles de conexión generales almacenados en el servidor local")
    parser.add_argument("--prompt", default=None, help="Ejecutar este prompt sin interfaz gráfica con Node.js, imprimir solo la respuesta final y terminar (salida 0 terminado, 1 error de generación, 2 runner cerrado sin resultado, 3 fallo de arranque, 4 argumentos no válidos, 5 pausada a la espera del usuario, con su pregunta en la salida, 6 límite de --run-file alcanzado)")
    parser.add_argument("--conversation", default=None, help="Con --prompt o para continuar, id de la conversación almacenada en SQLite")
    parser.add_argument("--run-file", default=None, metavar="FICHERO", help="Ejecutar la petición del fichero JSON (- para leerla de stdin) en lugar de --prompt, --conversation y --profile: prompt, conversation_id (la continúa o, si no existe, la crea con ese id), profile, agent (<subconjunto>.<nombre>: marca la conversación nueva como de ese agente), systemDataPrompt, watchAgents (patrones de agentes del proyecto que vigila con check_agents), projectMode (true inyecta AGENTS.md y .zerochat/state.md; por defecto no), reasoning (none, low, medium, high o xhigh; medium por defecto), maxSteps y timeout (segundos); exige un entorno de proyecto guardado, del que salen siempre herramientas y permisos")
    parser.add_argument("--profile", default=None, help=f"Con --prompt o --conversation, perfil (nombre o id) que se usa solo en esta ejecución, sin cambiar el activo (por defecto: {DEFAULT_RUN_PROFILE} del servidor)")
    parser.add_argument("--log", choices=("on", "off"), default=None, help="Mostrar la cabecera y el registro del servidor (default: on; off en modo ejecución)")
    parser.add_argument("--export", default=None, metavar="FICHERO", help=f"Con --prompt, --conversation o --run-file, guardar la conversación en FICHERO; el formato sale de la extensión ({', '.join(RUN_EXPORT_FORMATS)})")
    parser.add_argument("--version", action="version", version=f"ZeroChat {VERSION}")
    return parser


def _check_run_flags(parser: ZeroChatArgumentParser, args):
    """Combinaciones de opciones que no admite el modo ejecución."""
    if args.no_browser:
        parser.error("--prompt, --conversation y --run-file ejecutan la interfaz de forma autónoma: no se combina con --no-browser")
    if args.keep_server:
        parser.error("--prompt, --conversation y --run-file terminan al devolver el resultado: no se combina con --keep-server")
    if args.host is not None:
        parser.error(f"--prompt, --conversation y --run-file solo atienden a su runner en {DEFAULT_HOST}: no se combina con --host")


def _run_prompt(parser: ZeroChatArgumentParser, raw_prompt: str | None) -> str | None:
    if raw_prompt is None:
        return None
    prompt = raw_prompt.strip()
    if not prompt:
        parser.error("el prompt está vacío")
    return prompt


def _run_conversation(parser: ZeroChatArgumentParser, raw_id: str | None, prompt: str | None,
                      allow_new: bool = False) -> tuple[str | None, dict | None, str | None]:
    """La conversación de la ejecución: (id, conversación) si existe y, sin prompt, tiene un turno que continuar.
    Con allow_new (--run-file), un id que no existe es el de la conversación nueva que empieza el prompt: (None, None, id)."""
    if raw_id is None:
        return None, None, None
    raw_conv = raw_id.strip()
    if not raw_conv:
        parser.error("el identificador de la conversación no puede estar vacío")
    try:
        conversation_id = _validate_conversation_id(raw_conv)
    except ValueError as exc:
        parser.error(str(exc))
    conv = get_conversation(conversation_id)
    if conv is None:
        if not allow_new:
            parser.error(f"no existe la conversación '{conversation_id}'")
        if prompt is None:
            parser.error(f"la conversación '{conversation_id}' no existe y no hay prompt para empezarla")
        return None, None, conversation_id
    if prompt is None and not any(m.get("role") in ("user", "tool") for m in conv.get("history") or []):
        parser.error(f"la conversación '{conversation_id}' no tiene turnos para continuar")
    return conversation_id, conv, None


def _run_file_request(parser: ZeroChatArgumentParser, path: str) -> dict:
    """La petición de --run-file, leída del fichero o de stdin (-) sin pasar del tope y validada."""
    try:
        if path == "-":
            raw = sys.stdin.buffer.read(RUN_FILE_MAX_BYTES + 1)
        else:
            with open(Path(path).expanduser(), "rb") as handle:
                raw = handle.read(RUN_FILE_MAX_BYTES + 1)
        return parse_run_request(raw)
    except OSError as exc:
        parser.error(f"--run-file: no se pudo leer {path}: {exc}")
    except ValueError as exc:
        parser.error(f"--run-file: {exc}")


def _run_profile(parser: ZeroChatArgumentParser, raw_profile: str | None, conv: dict | None) -> tuple[str, dict | None]:
    """El perfil de la ejecución (su nombre y, si existe en el servidor, el perfil con su API key, que el runner recibe
    en profile_data): el de --profile, el de la conversación o DEFAULT_RUN_PROFILE.

    Un --profile que no existe en el servidor se pasa por su nombre; el de la conversación y el por defecto tienen que existir.
    """
    if raw_profile is not None:
        clean_profile = raw_profile.strip()
        if not clean_profile:
            parser.error("--profile no puede estar vacío")
        match = get_general_profile_by_name(clean_profile) or get_general_profile(clean_profile)
        return (match["name"] if match else clean_profile), (get_general_profile_with_key(match["id"]) if match else None)
    conv_profile = conv.get("profileId") if conv else None
    if conv_profile:
        match = get_general_profile_by_name(conv_profile) or get_general_profile(conv_profile)
        if not match:
            parser.error(f"no existe el perfil '{conv_profile}' en el servidor; créalo o indica uno con --profile")
        return match["name"], get_general_profile_with_key(match["id"])
    match = get_general_profile_by_name(DEFAULT_RUN_PROFILE)
    if match is None:
        parser.error(f"no existe el perfil por defecto '{DEFAULT_RUN_PROFILE}' en el servidor; créalo o indica uno con --profile")
    return match["name"], get_general_profile_with_key(match["id"])


def _run_export_path(parser: ZeroChatArgumentParser, args) -> Path | None:
    if args.export is None:
        return None
    export_path = Path(args.export).expanduser().absolute()
    if export_path.suffix.lower() not in RUN_EXPORT_FORMATS:
        parser.error(f"--export necesita una de estas extensiones: {', '.join(RUN_EXPORT_FORMATS)}")
    if not export_path.parent.is_dir():
        parser.error(f"--export: no existe el directorio {export_path.parent}")
    return export_path


def run_session_from_args(parser: ZeroChatArgumentParser, args) -> RunSession | None:
    """Valida las combinaciones de opciones y devuelve la sesión de --prompt, --conversation o --run-file, si la hay."""
    request: dict = {}
    if args.run_file is not None:
        if args.prompt is not None or args.conversation is not None or args.profile is not None:
            parser.error("--run-file ya lleva el prompt, la conversación y el perfil: no se combina con --prompt, --conversation ni --profile")
        request = _run_file_request(parser, args.run_file)
        if "prompt" not in request and "conversation_id" not in request:
            parser.error("--run-file necesita prompt o conversation_id")
        raw_prompt, raw_conversation, raw_profile = request.get("prompt"), request.get("conversation_id"), request.get("profile")
    elif args.prompt is None and args.conversation is None:
        if args.profile is not None or args.export is not None:
            parser.error("--profile y --export solo se usan con --prompt, --conversation o --run-file")
        return None
    else:
        raw_prompt, raw_conversation, raw_profile = args.prompt, args.conversation, args.profile
    prompt = _run_prompt(parser, raw_prompt)
    conversation_id, conv, new_conversation_id = _run_conversation(parser, raw_conversation, prompt, allow_new=args.run_file is not None)
    # El agente se fija al crear la conversación: continuarla con otro, o sin él, mezclaría historiales.
    if args.run_file is not None and conv is not None and conv.get("agent") != request.get("agent"):
        parser.error(f"la conversación '{conversation_id}' es del agente '{conv.get('agent') or '(ninguno)'}', no de "
                     f"'{request.get('agent') or '(ninguno)'}'")
    # Continuar sin --run-file (la interfaz o --conversation) una conversación de agente repite su último lanzamiento:
    # su perfil, su manual (systemDataPrompt), su projectMode y sus límites, no los de quien la reanuda.
    options = request
    if args.run_file is None and conv is not None and conv.get("agent"):
        options = {"projectMode": False, "agent": conv["agent"], **(get_conversation_launch(conversation_id) or {})}
        launch_profile = options.get("profile")
        if launch_profile and raw_profile is not None and raw_profile.strip() != launch_profile:
            parser.error(f"la conversación '{conversation_id}' es del agente '{conv['agent']}' y se continúa con el perfil "
                         f"de su lanzamiento, '{launch_profile}', no con '{raw_profile.strip()}'")
        raw_profile = launch_profile or raw_profile
    _check_run_flags(parser, args)
    _require_no_active_run(conversation_id or new_conversation_id)
    profile_name, profile_data = _run_profile(parser, raw_profile, conv)
    export_path = _run_export_path(parser, args)
    if conversation_id and args.run_file is None:
        mark_conversation_server_run(conversation_id, profile_name)
    launch = None
    if args.run_file is not None and request.get("agent"):
        launch = {"profile": profile_name, **{key: request[key] for key in RUN_LAUNCH_KEYS if key in request}}
    return RunSession(prompt, profile_name, export_path, conversation_id=conversation_id, profile_data=profile_data,
                      new_conversation_id=new_conversation_id, system_data_prompt=options.get("systemDataPrompt"),
                      max_steps=options.get("maxSteps"), timeout_seconds=options.get("timeout"),
                      project_mode=options.get("projectMode"), agent=options.get("agent"), launch=launch,
                      watch_agents=tuple(options.get("watchAgents") or ()), track_run=args.run_file is not None,
                      reasoning=options.get("reasoning"))


def _require_no_active_run(conversation_id: str | None):
    """Como zerochat/run/start, la CLI no lanza una segunda ejecución de una conversación que ya tiene otra en marcha
    (--conversation, o --run-file con conversation_id fijo, p. ej. dos cron solapados): sale con RUN_EXIT_BUSY. Va antes
    de crear la RunSession, que anota su propio estado sobre el de la otra. El hijo de zerochat/run/start ya está
    anotado con el run_id que recibe en ZEROCHAT_RUN_ID."""
    if not conversation_id:
        return
    try:
        check_no_active_run(conversation_id, own_run_id=os.environ.get("ZEROCHAT_RUN_ID", "").strip() or None)
    except ValueError as exc:
        run_error(str(exc))
        sys.exit(RUN_EXIT_BUSY)


def redirect_log(args):
    """Todo el registro pasa por stdout: con --prompt va a stderr para dejar stdout a la respuesta,
    y con --log off se descarta. Devuelve el stdout original, el de la respuesta."""
    result_out = sys.stdout
    session = current_run_session()
    log_enabled = args.log == "on" if args.log else session is None
    if not log_enabled:
        sys.stdout = open(os.devnull, "w", encoding="utf-8")
    elif session:
        sys.stdout = sys.stderr
    return result_out


def run_self_test() -> bool:
    """
    --test: comprueba las herramientas locales básicas sin arrancar el servidor, en una carpeta temporal
    propia para no depender de dónde se ejecute. Devuelve si todas funcionan.
    """
    with tempfile.TemporaryDirectory(prefix="zerochat-test-") as folder:
        ctx = SecurityContext(Path(folder).resolve())
        checks = {
            "write_file": lambda: write_file("prueba.txt", "hola\n", ctx=ctx),
            "list_directory": lambda: list_directory(".", ctx=ctx),
            "read_file": lambda: read_file("prueba.txt", ctx=ctx),
            "run_command": lambda: run_command("echo hola", ctx=ctx),
        }
        passed = True
        for name, check in checks.items():
            ok = json.loads(check()).get("success") is True
            passed = passed and ok
            print(timestamp_message(f"TEST {name} {'ok' if ok else 'error'}"))
    print(timestamp_message("TEST all local tools ready." if passed else "TEST some local tools failed."))
    return passed


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


@on_token_rotation
def reset_session_authorizations():
    """Borra las autorizaciones de sesión y los retos pendientes, y vuelve a aplicar la capa de la ejecución."""
    ACCESS_CONTROLLER.clear_session()
    session = current_run_session()
    if session is not None:
        ctx = project_context()
        if session.tool_security:
            ACCESS_CONTROLLER.apply_session_overlay(session.tool_security, ctx)
            tool_decision = session.tool_security.get("tool_decision")
            if isinstance(tool_decision, dict):
                tool_name = tool_decision.get("toolName") or ""
                server_id = GLOBAL_MCP_MANAGER.server_of(tool_name) or ""
                ACCESS_CONTROLLER.apply_tool_decision(tool_decision, ctx, server_id=server_id)
        permanent_tools = ACCESS_CONTROLLER.export_state(ctx).get("tools") or {}
        ACCESS_CONTROLLER.apply_session_overlay({
            "allowAll": False,
            "tools": {
                name: {"policy": POLICY_ALLOW}
                for name in LOCAL_TOOL_HANDLERS
                if name != COMMAND_TOOL
                and (name not in MASTER_TOOLS or session.watch_agents)
                and not get_integrated_path_access(name)
                and (permanent_tools.get(name) or {}).get("policy") != POLICY_DENY
            }
        }, ctx)


def open_server(args) -> ThreadingHTTPServer:
    """
    Abre el puerto de escucha y publica la dirección real: con --port 0, el puerto que elige el sistema. Una ejecución
    (--prompt, --conversation, --run-file) solo atiende a su runner: escucha en DEFAULT_HOST, sin ZEROCHAT_HOST, y,
    salvo --port, en un puerto libre del sistema, nunca en el del servidor principal (DEFAULT_PORT o ZEROCHAT_PORT).
    """
    run = current_run_session() is not None
    host = DEFAULT_HOST if run else (args.host or os.environ.get("ZEROCHAT_HOST", DEFAULT_HOST))
    if args.port is not None:
        port = args.port
    else:
        port = 0 if run else int(os.environ.get("ZEROCHAT_PORT", DEFAULT_PORT))
    try:
        server = ZeroChatHTTPServer((host, port), ZeroChatServerHandler)
    except OSError as exc:
        if not run:
            raise
        run_error(f"No se pudo escuchar en {host}:{port}: {exc}")
        sys.exit(RUN_EXIT_SETUP)
    set_active_address(host, server.server_address[1])
    return server


def interface_url(args, static_root) -> str:
    """URL de la interfaz: la indicada, la local de desarrollo o la de GitHub Pages."""
    if args.ui_url:
        return args.ui_url
    if static_root:
        host, port = active_address()
        return f"http://{host}:{port}/zerochat.html"
    return DEFAULT_UI_URL


def launch_url(ui_url: str, token: str | None = None) -> str:
    """URL con que zerochat abre el navegador: el token vigente y el servidor van en el fragmento."""
    host, port = active_address()
    browser_host = host if host in {"127.0.0.1", "localhost"} else "127.0.0.1"
    fragment = {'token': token if token is not None else current_session_token(), 'host': browser_host, 'port': port}
    session = current_run_session()
    if session:
        fragment['run'] = session.run_id
    return f"{ui_url}#{urlencode(fragment)}"


def print_header(dev_root, ui_url: str, exposure_warning: str | None, exit_on_close: bool):
    """Cabecera del servidor con su configuración (sin el token)."""
    print("=" * 64)
    print(f"  ZeroChat Local Server v{VERSION} (UI {UI_VERSION})")
    print(f"  Directorio de trabajo : {project_context().workspace_dir}")
    print(f"  Datos y MCP           : {get_data_dir()}")
    print(f"  Entorno MCP           : {get_venv_dir()}")
    if dev_root is not None:
        print(f"  Modo de ejecución     : Desarrollo local ({dev_root})")
    elif is_installed_runtime():
        print("  Modo de ejecución     : Paquete PyPI (GitHub Pages)")
    else:
        print("  Modo de ejecución     : Producción (Web universal)")
    host, port = active_address()
    print(f"  Servidor HTTP         : http://{host}:{port}")
    if exposure_warning:
        print(f"  AVISO                 : {exposure_warning}")
    print("  Token de sesión (diario): configurado")
    print(f"  Destino Web           : {ui_url}")
    if exit_on_close:
        print("  Auto-cierre           : Activado (al cerrar navegador)")
    else:
        print("  Auto-cierre           : Desactivado")
    print("=" * 64, flush=True)


def start_interface(args, parser, server: ThreadingHTTPServer, ui_url: str):
    """Abre la interfaz: en modo ejecución con el runner de Node.js y su supervisor; si no, con el navegador y control de consola."""
    session = current_run_session()
    if not session:
        console = ConsoleControl(server, parser, launch_url=lambda: launch_url(ui_url))
        set_console_control(console)
        console.start()
        if not args.no_browser:
            launch_browser(launch_url(ui_url))
        return
    session.runner_token = issue_runner_token(session.run_id, session.conversation_id or session.new_conversation_id)
    runner = launch_node_runner(launch_url(ui_url, token=session.runner_token))
    if runner is None:
        server.server_close()
        mute_console()
        sys.exit(RUN_EXIT_SETUP)
    runner_proc, runner_log = runner
    session.runner_started = True
    threading.Thread(target=run_supervisor, args=(server, session, runner_proc, runner_log), daemon=True).start()


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
    try:
        server.serve_forever(poll_interval=0.05)
    finally:
        stop_zerochat_server(server)
        server.server_close()
        console = current_console_control()
        if console:
            console.close()
            set_console_control(None)


def finish_run(result_out):
    """Modo ejecución: escribe la respuesta final en el stdout original y sale con su código."""
    session = current_run_session()
    # Una conversación nueva de --run-file (ya guardada por el runner) la continúa la interfaz en el servidor con su
    # perfil, como las de --conversation, que se marcan al empezar porque ya existen.
    if session.new_conversation_id == session.state_conversation_id:
        mark_conversation_server_run(session.new_conversation_id, session.profile)
    code, text = run_outcome(session)
    # El registro sigue donde estaba (stderr o nada): result_out solo recibe la respuesta.
    mute_console()
    if text is not None:
        result_out.write(text if text.endswith("\n") else text + "\n")
        result_out.flush()
    sys.exit(code)


def _apply_conversation_project(parser: ZeroChatArgumentParser, session: RunSession | None):
    """Fija el proyecto por defecto al de la conversación indicada en --conversation."""
    if not session or not session.conversation_id:
        return
    conv = get_conversation(session.conversation_id)
    if not isinstance(conv, dict):
        return
    conv_project = conv.get("project")
    if conv_project:
        if not Path(conv_project).is_dir():
            parser.error(f"la carpeta del proyecto de la conversación ya no existe: {conv_project}")
        set_default_project_dir(Path(conv_project))
    else:
        set_default_project_dir(get_no_project_dir())


def require_saved_environment():
    """--run-file solo se ejecuta en un proyecto con entorno guardado: sus herramientas, servicios MCP y permisos
    salen siempre de él, nunca del fichero, así que sin él la ejecución usaría valores que nadie ha decidido."""
    ctx = project_context()
    try:
        saved = get_project_environment(ctx.key)["saved"]
    except RuntimeError as exc:
        run_error(str(exc))
        sys.exit(RUN_EXIT_SETUP)
    if not saved:
        run_error(f"El proyecto {ctx.workspace_dir} no tiene entorno guardado: guarda sus herramientas y permisos en la interfaz antes de usarlo con --run-file.")
        sys.exit(RUN_EXIT_SETUP)


def _prepare_run_environment(parser: ZeroChatArgumentParser, args, session: RunSession | None):
    _apply_conversation_project(parser, session)
    if args.run_file is not None:
        require_saved_environment()
        if session and session.conversation_id:
            mark_conversation_server_run(session.conversation_id, session.profile)
        if session:
            announce_run_conversation(session)


def main():
    parser = build_parser()
    args = parser.parse_args()
    # Los avisos no persisten entre ejecuciones del servidor.
    reset_notices()
    session = run_session_from_args(parser, args)
    set_run_session(session)
    try:
        _start(parser, args, session)
    except SystemExit:
        # Salir antes de lanzar el runner (entorno sin guardar, sin Node, puerto ocupado...) no deja fila en runs.
        discard_unstarted_run(session)
        raise


def _start(parser: ZeroChatArgumentParser, args, session: RunSession | None):
    """Prepara y arranca el servidor y, en modo ejecución, el runner de Node; vuelve al detenerse el servidor."""
    _prepare_run_environment(parser, args, session)
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

    if args.test:
        sys.exit(0 if run_self_test() else 1)

    dev_root = get_dev_root()
    static_root = get_static_root()
    prepare_environment(args, is_dev=dev_root is not None)
    current_session_token()

    server = open_server(args)
    exposure_warning = remote_exposure_warning(active_address()[0])
    if exposure_warning:
        add_notice(exposure_warning)

    ui_url = interface_url(args, static_root)
    # El modo ejecución (que rechaza --keep-server) detecta con el latido que el runner se cerró sin devolver resultado.
    exit_on_close = not args.keep_server
    set_exit_on_close(exit_on_close)
    print_header(dev_root, ui_url, exposure_warning, exit_on_close)
    # Los servicios MCP incluidos se actualizan desde el catálogo publicado junto a la interfaz.
    GLOBAL_MCP_MANAGER.start_catalog_refresh(ui_url)

    start_interface(args, parser, server, ui_url)
    if exit_on_close:
        start_heartbeat_watchdog(server, require_initial=not args.no_browser)
    install_signal_handlers(server)
    serve(server)

    if current_run_session():
        finish_run(result_out)

if __name__ == "__main__":
    main()
