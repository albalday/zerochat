
def get_dev_root() -> Path | None:
    """
    Detecta si zerochat.py se está ejecutando en el directorio de desarrollo del repositorio.
    Comprueba si existen zerochat.html, js/ y css/ en el directorio del script o en cwd.
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


def get_daily_token() -> str:
    """Devuelve un token de sesión diario persistido en ~/zerochat/config/token.json."""
    config_dir = get_data_dir() / "config"
    config_dir.mkdir(parents=True, exist_ok=True)
    token_file = config_dir / "token.json"
    today = datetime.date.today().isoformat()
    if token_file.exists():
        try:
            data = json.loads(token_file.read_text(encoding="utf-8"))
            if data.get("date") == today and data.get("token") and isinstance(data["token"], str):
                return data["token"]
        except Exception:
            pass
    token = secrets.token_urlsafe(32)
    try:
        tmp_file = token_file.with_suffix(".tmp")
        tmp_file.write_text(json.dumps({"token": token, "date": today}, indent=2), encoding="utf-8")
        tmp_file.replace(token_file)
    except Exception:
        pass
    return token


# Estado de sesión en memoria (generación diaria por defecto)
SESSION_TOKEN = get_daily_token()
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
    venv_py = get_venv_python(venv_dir)

    # 1. Crear el venv si no existe
    if not venv_py.exists():
        log_event(f"[zerochat] Inicializando entorno virtual en {venv_dir}...")
        try:
            venv.create(venv_dir, with_pip=True, clear=False)
            log_event("[zerochat] Entorno virtual preparado con éxito.")
        except Exception as err:
            log_event(f"[zerochat] Advertencia al crear venv: {err}. Continuando con intérprete actual.")
            return

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
    content = _read_remote_content(REMOTE_UI_VERSION_URL)
    match = re.search(r"<title>\s*ZeroChat\s+v(\d+\.\d+\.\d+)\s*</title>", content, re.IGNORECASE)
    return match.group(1) if match else None


def _read_remote_backend_version() -> str | None:
    """Extrae la versión estática del ejecutable publicado en GitHub."""
    content = _read_remote_content(REMOTE_BACKEND_VERSION_URL)
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
    except Exception:
        # Modo offline o timeout ignorado de forma segura
        pass
