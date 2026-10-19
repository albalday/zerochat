# Configuración del navegador de Playwright MCP (sección Navegador de Ajustes).
# Modo propio: un motor de Playwright con perfil persistente en ~/zerochat/playwright/profile/<motor>.
# Modo del usuario: su Chrome o Edge mediante la extensión Playwright MCP Bridge (--extension).
BROWSER_MODES = ("own", "user")
OWN_BROWSER_ENGINES = ("chromium", "firefox", "webkit")
USER_BROWSERS = ("chrome", "msedge")
BROWSER_CONFIG_DEFAULTS = {"mode": "own", "engine": "chromium", "userBrowser": "chrome", "headless": True}
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


def playwright_launch_args(config: dict) -> list[str]:
    """Argumentos de Playwright MCP para la configuración del navegador."""
    if config["mode"] == "user":
        # La extensión maneja el navegador abierto del usuario: siempre con ventana.
        return ["--extension", f"--browser={config['userBrowser']}"]
    profile_dir = own_browser_profile_dir(config["engine"])
    for directory in (profile_dir.parent.parent, profile_dir.parent, profile_dir):
        directory.mkdir(mode=0o700, exist_ok=True)
    args = [f"--browser={config['engine']}", f"--user-data-dir={profile_dir}"]
    if config["headless"]:
        args.append("--headless")
    return args


# Argumentos que añade ZeroChat al arrancar un servicio gestionado, calculados en cada arranque.
SERVICE_LAUNCH_ARGS = {"playwright": lambda: playwright_launch_args(load_browser_config())}
