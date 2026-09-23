
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

DETECTED_OS = "windows" if sys.platform.startswith("win") else ("android" if "ANDROID_ROOT" in os.environ else "linux")


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
        console_log(f"[{time.strftime('%H:%M:%S')}] [zerochat] Inicializando entorno virtual en {venv_dir}...", flush=True)
        try:
            venv.create(venv_dir, with_pip=True, clear=False)
            console_log(f"[{time.strftime('%H:%M:%S')}] [zerochat] Entorno virtual preparado con éxito.", flush=True)
        except Exception as err:
            console_log(f"[{time.strftime('%H:%M:%S')}] [zerochat] Advertencia al crear venv: {err}. Continuando con intérprete actual.", flush=True)
            return

def parse_version(ver: str) -> tuple[int, ...]:
    """Convierte una cadena de versión semántica en tupla de enteros para comparación."""
    parts = []
    for piece in ver.split("."):
        clean = "".join(filter(str.isdigit, piece))
        if clean:
            parts.append(int(clean))
    return tuple(parts)


def _read_remote_version(url: str) -> str | None:
    """Obtiene una versión publicada desde package.json o la API JSON de PyPI."""
    req = urllib.request.Request(url, headers={"User-Agent": f"ZeroChat/{VERSION}"})
    with urllib.request.urlopen(req, timeout=3) as resp:
        content = resp.read(4096).decode("utf-8", errors="ignore")
    try:
        data = json.loads(content)
        if isinstance(data, dict):
            candidate = data.get("version")
            if not isinstance(candidate, str) and isinstance(data.get("info"), dict):
                candidate = data["info"].get("version")
            if isinstance(candidate, str):
                return candidate.strip()
    except (json.JSONDecodeError, TypeError):
        pass
    match = re.search(r'["\']?version["\']?\s*[:=]\s*["\'](\d+\.\d+\.\d+)["\']', content)
    return match.group(1) if match else None


def has_new_backend_version(remote_version: str, local_version: str = VERSION) -> bool:
    """Compara solo major.minor: los parches pertenecen a la interfaz web."""
    return parse_version(compatibility_version(remote_version)) > parse_version(compatibility_version(local_version))


def check_version():
    """Informa de actualizaciones del backend, sin avisar por parches web."""
    if get_dev_root() is not None:
        return
    try:
        installed = is_installed_runtime()
        remote_ver = _read_remote_version(PYPI_VERSION_URL if installed else REMOTE_VERSION_URL)
        if remote_ver and re.match(r"^\d+(\.\d+)+", remote_ver) and has_new_backend_version(remote_ver):
            console_log(f"[{time.strftime('%H:%M:%S')}] [zerochat] Nueva versión del servidor disponible (Local: {VERSION}, Remota: {compatibility_version(remote_ver)})", flush=True)
            if installed:
                console_log(f"[{time.strftime('%H:%M:%S')}] [zerochat] Actualiza cuando quieras con: {sys.executable} -m pip install --upgrade --no-cache-dir zerochat", flush=True)
            else:
                console_log(f"[{time.strftime('%H:%M:%S')}] [zerochat] Actualiza con: curl -sSL {REMOTE_SCRIPT_URL} -o zerochat.py", flush=True)
    except Exception:
        # Modo offline o timeout ignorado de forma segura
        pass


