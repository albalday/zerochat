"""Motores propios de Playwright (listar, instalar y quitar) y navegadores del sistema con la extensión de Playwright."""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import threading
from pathlib import Path

from browser.config import (
    PLAYWRIGHT_EXTENSION_ID,
    USER_BROWSERS,
    chromium_install,
    extension_token_configured,
    load_browser_config,
    save_browser_config,
)
from core.environment import DETECTED_OS, get_data_dir
from core.limits import LONG_POLL_MAX_WAIT_MS
from core.live_events import notify_live_change
from core.logging import format_log_error, log_event
from core.process import _kill_process_tree


# Si Playwright MCP está en marcha: lo registra el gestor de servicios MCP (on_playwright_status).
PLAYWRIGHT_STATUS_CHECK: list = []


def on_playwright_status(check):
    """Registra la función, sin argumentos, que dice si Playwright MCP está arrancando o en marcha."""
    PLAYWRIGHT_STATUS_CHECK[:] = [check]
    return check


def _playwright_active() -> bool:
    return any(check() for check in PLAYWRIGHT_STATUS_CHECK)


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
        result: dict = {"rev": rev, "engines": [], "config": load_browser_config(), "extensionTokenConfigured": extension_token_configured()}
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
            # Grupo propio: al vencer el plazo se terminan también las descargas que lanza el instalador.
            proc = subprocess.Popen([shutil.which("node") or "node", str(cli), "install", engine], cwd=cli.parent,
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                                    start_new_session=DETECTED_OS != "windows")
            timer = threading.Timer(ENGINE_INSTALL_TIMEOUT_SECONDS, _kill_process_tree, args=(proc,))
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
