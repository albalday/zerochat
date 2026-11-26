"""Gestor de servicios MCP: descubrimiento en ~/zerochat/services, actualización desde el catálogo, preferencias,
arranque y parada, y nombres públicos de sus herramientas."""

from __future__ import annotations

import dataclasses
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.parse
from pathlib import Path

from browser.config import PLAYWRIGHT_SERVER_ID, SERVICE_LAUNCH
from browser.engines import on_playwright_status
from core.environment import get_data_dir, get_venv_dir, get_venv_python
from core.limits import LONG_POLL_MAX_WAIT_MS
from core.live_events import notify_live_change
from core.logging import log_event
from core.rate_limit import RATE_LIMITER, parse_rate_policy
from mcp.catalog import (
    CATALOG_PATH,
    catalog_base,
    download,
    download_service,
    install_service,
    installed_version,
    parse_catalog,
)
from mcp.stdio_client import (
    DEFAULT_MCP_CALL_TIMEOUT_SECONDS,
    StdioMcpClient,
    _mcp_trace_text,
    _positive_seconds,
)
from storage.db import delete_secret, get_secret, get_setting, save_secret, secret_names, set_setting


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
# Marcadores ${clave} de launch (executable, args y env) en service.json.
LAUNCH_PLACEHOLDER_PATTERN = re.compile(r"\$\{([^{}]+)\}")


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
        """Sustituye cada ${clave} conocida en una sola pasada: un valor sustituido (una opción del usuario con el
        texto ${secret:X}) no se vuelve a expandir. Las claves desconocidas quedan tal cual."""
        if not isinstance(value, str):
            raise ValueError("Invalid process argument")
        return LAUNCH_PLACEHOLDER_PATTERN.sub(lambda match: str(values.get(match.group(1), match.group(0))), value)

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
