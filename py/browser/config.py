"""Navegador de Playwright MCP: configuración guardada, navegador de cada perfil y argumentos de arranque."""

from __future__ import annotations

import json
import os
import re
import shutil
import sys
from pathlib import Path

from core.environment import _write_private_text, get_data_dir
from core.logging import log_event


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
