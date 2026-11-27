"""Navegador de Playwright MCP: configuración guardada y argumentos de arranque."""

from __future__ import annotations

import os
import random
import re
import shutil
import sqlite3
import sys
from pathlib import Path

from core.logging import log_event
from storage.db import delete_secret, get_secret, get_setting, save_secret, set_setting


# Configuración del navegador de Playwright MCP (sección Navegador de Ajustes).
# Modo propio: un motor de Playwright o canal del sistema en memoria (--isolated), sin datos guardados al cerrar.
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
    "userAgentMode": "auto",
    "userAgent": "",
}
BROWSER_CONFIG_KEY = "browser"
LAST_FRONTEND_USER_AGENT_KEY = "browser:last_user_agent"
BROWSER_EXTENSION_TOKEN_KEY = "browser:extension_token"  # noqa: S105 - nombre de fila en la tabla secrets
# Identificador de la extensión de Playwright en la tienda de Chrome, que también usa Edge.
PLAYWRIGHT_SERVER_ID = "playwright"
PLAYWRIGHT_EXTENSION_ID = "mmlmfjhmonkocbjadbfplnigmagldckm"
# Token que muestra la extensión: con él la conexión no pide aceptarla en el navegador. Es de solo
# escritura, como los secretos MCP: ningún método lo devuelve, solo si está guardado.
_EXTENSION_TOKEN = re.compile(r"[A-Za-z0-9_-]{1,256}")
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


def sets_user_agent(config: dict) -> bool:
    """Solo los motores de Playwright llevan el User-Agent de ZeroChat: los navegadores instalados y el
    del usuario son navegadores reales y actualizados que envían el suyo."""
    return config["mode"] == "own" and config["engine"] in OWN_BROWSER_ENGINES


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
    config["userAgent"] = _validate_user_agent(config["userAgent"])
    if sets_user_agent(config) and config["userAgentMode"] == "custom" and not config["userAgent"]:
        raise ValueError("userAgent es obligatorio cuando userAgentMode es custom")
    return config


def load_browser_config() -> dict:
    try:
        stored = get_setting(BROWSER_CONFIG_KEY)
        return dict(BROWSER_CONFIG_DEFAULTS) if stored is None else validate_browser_config(stored)
    except (OSError, ValueError, TypeError) as err:
        log_event(f"[zerochat] Configuración del navegador no válida en SQLite, se usan los valores por defecto: {err}")
        return dict(BROWSER_CONFIG_DEFAULTS)


def save_browser_config(raw) -> dict:
    config = validate_browser_config(raw)
    set_setting(BROWSER_CONFIG_KEY, config)
    return config


def extension_token_configured() -> bool:
    return bool(get_secret(BROWSER_EXTENSION_TOKEN_KEY))


def save_extension_token(token) -> bool:
    """Guarda el token de la extensión (o lo borra con None); devuelve si queda guardado."""
    if token is None:
        delete_secret(BROWSER_EXTENSION_TOKEN_KEY)
        return False
    if not isinstance(token, str) or not _EXTENSION_TOKEN.fullmatch(token):
        raise ValueError("token debe tener de 1 a 256 letras, cifras, guiones o guiones bajos, o ser null")
    save_secret(BROWSER_EXTENSION_TOKEN_KEY, token)
    return True


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
    if user_agent and sets_user_agent(config):
        args.append(f"--user-agent={user_agent}")
    if config["headless"]:
        args.append("--headless")
    return args


def playwright_launch_env(config: dict) -> dict[str, str]:
    """Entorno de Playwright MCP: el token de la extensión, que no aparece en la línea de órdenes ni en el log."""
    token = get_secret(BROWSER_EXTENSION_TOKEN_KEY) if config["mode"] == "user" else None
    return {"PLAYWRIGHT_MCP_EXTENSION_TOKEN": token} if token else {}


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
