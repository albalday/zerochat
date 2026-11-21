"""Navegador de Playwright MCP: configuración guardada y argumentos de arranque."""

from __future__ import annotations

import os
import re
import shutil
import sys
from pathlib import Path

from core.environment import get_data_dir
from core.logging import log_event
from storage.db import get_secret, get_setting, set_setting


# Configuración del navegador de Playwright MCP (sección Navegador de Ajustes).
# Modo propio: un motor de Playwright en memoria (--isolated), o con almacenamiento persistente con nombre
# en ~/zerochat/playwright/profile/<motor>/<nombre>.
# Modo del usuario: su Chrome, Edge o Chromium mediante la extensión de Playwright (--extension).
BROWSER_MODES = ("own", "user")
OWN_BROWSER_ENGINES = ("chromium", "firefox", "webkit")
USER_BROWSERS = ("chrome", "msedge", "chromium")
BROWSER_CONFIG_DEFAULTS = {"mode": "own", "engine": "chromium", "userBrowser": "chrome", "headless": True, "extensionToken": ""}
BROWSER_CONFIG_KEY = "browser"
BROWSER_EXTENSION_TOKEN_KEY = "browser:extension_token"  # noqa: S105 - nombre de fila en la tabla secrets
# Identificador de la extensión de Playwright en la tienda de Chrome, que también usa Edge.
PLAYWRIGHT_SERVER_ID = "playwright"
PLAYWRIGHT_EXTENSION_ID = "mmlmfjhmonkocbjadbfplnigmagldckm"
# Token que muestra la extensión: con él la conexión no pide aceptarla en el navegador.
_EXTENSION_TOKEN = re.compile(r"^[A-Za-z0-9_-]{0,256}$")
_BROWSER_CONFIG_CHOICES = {"mode": BROWSER_MODES, "engine": OWN_BROWSER_ENGINES, "userBrowser": USER_BROWSERS}


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


def _playwright_launch(user_agent: str | None = None) -> tuple[list[str], dict[str, str]]:
    """Argumentos y entorno de Playwright MCP según la configuración guardada."""
    config = load_browser_config()
    return playwright_launch_args(config, user_agent), playwright_launch_env(config)


# User-Agent que usan los motores propios de Playwright; lo fija el servidor con el User-Agent
# activo de las salidas web (ff-server) para que ambos compartan el mismo fingerprint.
SERVICE_USER_AGENT: str | None = None


def set_service_user_agent(user_agent: str | None) -> None:
    global SERVICE_USER_AGENT
    SERVICE_USER_AGENT = user_agent


# Argumentos y entorno que añade ZeroChat al arrancar un servicio gestionado,
# calculados en cada arranque.
SERVICE_LAUNCH = {PLAYWRIGHT_SERVER_ID: lambda: _playwright_launch(SERVICE_USER_AGENT)}
