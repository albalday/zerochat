# Configuración del navegador de Playwright MCP (sección Navegador de Ajustes).
# Modo propio: un motor de Playwright con perfil persistente en ~/zerochat/playwright/profile/<motor>.
# Modo del usuario: su Chrome, Edge o Chromium mediante la extensión de Playwright (--extension).
BROWSER_MODES = ("own", "user")
OWN_BROWSER_ENGINES = ("chromium", "firefox", "webkit")
USER_BROWSERS = ("chrome", "msedge", "chromium")
BROWSER_CONFIG_DEFAULTS = {"mode": "own", "engine": "chromium", "userBrowser": "chrome", "headless": True, "extensionToken": ""}
# Identificador de la extensión de Playwright en la tienda de Chrome, que también usa Edge.
PLAYWRIGHT_EXTENSION_ID = "mmlmfjhmonkocbjadbfplnigmagldckm"
# Token que muestra la extensión: con él la conexión no pide aceptarla en el navegador.
_EXTENSION_TOKEN = re.compile(r"^[A-Za-z0-9_-]{0,256}$")
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
    return any(server["id"] == "playwright" and server["status"] in ("running", "starting", "installing")
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


def playwright_launch_args(config: dict) -> list[str]:
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
    profile_dir = own_browser_profile_dir(config["engine"])
    for directory in (profile_dir.parent.parent, profile_dir.parent, profile_dir):
        directory.mkdir(mode=0o700, exist_ok=True)
    args = [f"--browser={config['engine']}", f"--user-data-dir={profile_dir}"]
    if config["headless"]:
        args.append("--headless")
    return args


def playwright_launch_env(config: dict) -> dict[str, str]:
    """Entorno de Playwright MCP: el token de la extensión, que no aparece en la línea de órdenes ni en el log."""
    if config["mode"] == "user" and config["extensionToken"]:
        return {"PLAYWRIGHT_MCP_EXTENSION_TOKEN": config["extensionToken"]}
    return {}


def _playwright_launch() -> tuple[list[str], dict[str, str]]:
    config = load_browser_config()
    return playwright_launch_args(config), playwright_launch_env(config)


# Argumentos y entorno que añade ZeroChat al arrancar un servicio gestionado, calculados en cada arranque.
SERVICE_LAUNCH = {"playwright": _playwright_launch}


# Motores propios de Playwright: cada uno se compone de las entradas de la caché que instala
# "playwright install <motor>"; ffmpeg es común y no se quita.
ENGINE_CACHE_ENTRIES = {"chromium": ("chromium", "chromium-headless-shell"), "firefox": ("firefox",), "webkit": ("webkit",)}
ENGINE_INSTALL_TIMEOUT_SECONDS = 1200
_DRY_RUN_ENTRY = re.compile(r"^(.+?) \(playwright (\S+) v\d+\)\n\s+Install location:\s+(.+)$", re.MULTILINE)
_INSTALL_PERCENT = re.compile(r"(\d{1,3})% of ")
_INSTALL_DOWNLOAD = re.compile(r"^Downloading (.+?) \(playwright ")


def playwright_service_cli() -> Path:
    return get_data_dir() / "services" / "playwright" / "node_modules" / "playwright" / "cli.js"


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
        cli = playwright_service_cli()
        result = {"systemBrowsers": system_browsers(), "extensions": user_browser_extensions(), "engines": []}
        if not cli.is_file():
            return {**result, "available": False, "error": "Playwright MCP is not installed."}
        try:
            version = json.loads((cli.parent / "package.json").read_text(encoding="utf-8")).get("version")
            locations = self._locations(cli)
        except (OSError, json.JSONDecodeError, RuntimeError, subprocess.SubprocessError) as err:
            return {**result, "available": False, "error": str(err)}
        with self._lock:
            jobs = {engine: dict(job) for engine, job in self._jobs.items()}
        for engine, entries in ENGINE_CACHE_ENTRIES.items():
            title = locations.get(entries[0], (engine,))[0]
            installed = all(name in locations and (locations[name][1] / "INSTALLATION_COMPLETE").is_file() for name in entries)
            result["engines"].append({"id": engine, "title": title, "installed": installed, **jobs.get(engine, {})})
        return {**result, "available": True, "playwrightVersion": version}

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
