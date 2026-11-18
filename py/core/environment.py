"""Entorno de ejecución: sistema operativo, directorios de datos y de desarrollo y entorno virtual."""

from __future__ import annotations

import functools
import ipaddress
import os
import sys
import threading
import venv
from pathlib import Path

from core.logging import log_event

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
