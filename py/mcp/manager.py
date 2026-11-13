"""Gestor de servicios MCP: descubrimiento en ~/zerochat/services, preferencias, arranque y parada, y nombres públicos de sus herramientas."""

from __future__ import annotations

import dataclasses
import json
import os
import re
import shutil
import subprocess
import sys
import threading
from pathlib import Path

from browser.config import PLAYWRIGHT_SERVER_ID, SERVICE_LAUNCH
from browser.engines import on_playwright_status
from core.environment import get_data_dir, get_venv_dir, get_venv_python
from core.logging import log_event
from mcp.managed_services import materialize_managed_services
from mcp.stdio_client import (
    DEFAULT_MCP_CALL_TIMEOUT_SECONDS,
    StdioMcpClient,
    _mcp_trace_text,
    _positive_seconds,
)


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
    """Estado de un servicio MCP en este proceso: fase del ciclo de vida, cliente, último error y
    modo y navegador con los que arrancó (solo los servicios de SERVICE_LAUNCH)."""
    phase: str = "stopped"  # stopped, installing, starting, running o error
    client: StdioMcpClient | None = None
    error: str | None = None
    browser: dict | None = None


def service_status(record: McpServiceRecord, alive: bool, exit_code: int | None) -> tuple[str, str | None]:
    """Estado público y error de un servicio a partir de su registro y de si su proceso sigue vivo:
    el proceso de un servicio en marcha puede morir sin que nadie lo detenga."""
    if record.phase != "running" or alive:
        return record.phase, record.error
    if exit_code is not None:
        return "error", f"MCP process exited with code {exit_code}"
    return "error", "MCP process is not responding"


class McpServiceManager:
    def __init__(self, services_root: Path | None = None):
        # Crearlo no toca el disco: el gestor global existe desde que se importa zerochat.
        self.services_root = Path(services_root) if services_root else get_data_dir() / "services"
        self.config_file = get_data_dir() / "config" / "services.json"
        self.records: dict[str, McpServiceRecord] = {}
        self._lock = threading.Lock()
        self._materialized = False
        self._services: dict[str, dict] | None = None
        self._preferences: dict | None = None

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
        # La primera vez copia los servicios gestionados, sin borrar datos ni servicios del usuario.
        if not self._materialized:
            self.services_root.mkdir(parents=True, exist_ok=True)
            materialize_managed_services(self.services_root)
            self._materialized = True
        servers = {}
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
        if self.config_file.exists():
            try:
                return json.loads(self.config_file.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                return {}
        return {}

    def _save_preferences(self):
        try:
            self.config_file.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.config_file.with_suffix(".tmp")
            tmp.write_text(json.dumps(self.preferences, indent=2), encoding="utf-8")
            tmp.replace(self.config_file)
        except OSError as err:
            log_event(f"[zerochat] Advertencia al guardar preferencias MCP en {self.config_file}: {err}")

    def _remember(self, server_id: str, enabled: bool):
        """Único sitio que guarda si un servicio queda activo para ofrecerlo en la siguiente sesión: lo
        marca un arranque con remember y lo desmarca detenerlo. Un reinicio (detener y arrancar con el
        valor previo) lo conserva, y un arranque sin remember, como el de un perfil, no lo cambia."""
        self.preferences.setdefault(server_id, {})["enabled"] = enabled
        self._save_preferences()

    def list_servers(self) -> list[dict]:
        self.services = self._load_services()
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
                "enabled": pref.get("enabled", server.get("enabledByDefault", False)),
                "status": status,
                "toolCount": len(client.tools) if running else 0,
                "error": error,
                "options": server.get("options", []),
                "userOptions": pref.get("options", {}),
                "oauthUrl": client.oauth_url if client else None,
                "browser": record.browser if running else None,
            })

        return result


    def _expand(self, value: str, values: dict[str, str]) -> str:
        if not isinstance(value, str):
            raise ValueError("Invalid process argument")
        for key, replacement in values.items():
            value = value.replace("${" + key + "}", str(replacement))
        return value

    def _prepare_service(self, server_id: str, server: dict) -> dict[str, str]:
        service_dir = server["_directory"]
        installer_file = service_dir / "installer.json"
        node = shutil.which("node") or "node"
        npm = shutil.which("npm") or "npm"

        if installer_file.exists():
            self._trace(server_id, f"reading installer: {installer_file.name}")
            marker = service_dir / ".installed.json"
            try:
                installer = json.loads(installer_file.read_text(encoding="utf-8"))
            except Exception as e:
                raise RuntimeError(f"Error leyendo installer.json: {e}")
            kind = installer.get("type", "npm")
            if kind == "npm":
                product = installer.get("product", {})
                package = product.get("package")
                version = product.get("version")
                if not package or not version:
                    raise RuntimeError("El instalador npm debe definir package y version")
                if not shutil.which("node") or not shutil.which("npm"):
                    raise RuntimeError("Node.js y npm son necesarios para instalar este servicio MCP")

                self._check_node_requirement(server_id, installer, node)

                package_dir = service_dir / "node_modules" / Path(*package.split("/"))
                needs_install = not marker.exists() or not package_dir.is_dir()
                if not needs_install:
                    try:
                        installation = json.loads(marker.read_text(encoding="utf-8"))
                        if installation.get("package") != package or installation.get("version") != version:
                            needs_install = True
                    except (OSError, json.JSONDecodeError):
                        needs_install = True

                if needs_install:
                    self.records[server_id].phase = "installing"
                    self._trace(server_id, f"installing npm package: {package}@{version}")
                    manifest = service_dir / "package.json"
                    manifest.write_text(json.dumps({"private": True, "dependencies": {package: version}}, indent=2), encoding="utf-8")
                    res = subprocess.run([npm, "install", "--ignore-scripts", "--no-audit", "--no-fund"], cwd=service_dir, capture_output=True, text=True, timeout=600)
                    if res.returncode != 0:
                        raise RuntimeError(f"Fallo instalando dependencias npm: {res.stderr or res.stdout}")
                    self._trace(server_id, f"npm package installed: {package}@{version}")
                    installation = {"type": "npm", "package": package, "version": version, "nodeExecutable": node}
                    browser = product.get("browser")
                    if browser:
                        playwright_cli = service_dir / "node_modules" / "playwright" / "cli.js"
                        if not playwright_cli.is_file():
                            raise RuntimeError("No se encontró Playwright después de instalar el servicio MCP")
                        browser_result = subprocess.run(
                            [node, str(playwright_cli), "install", browser], cwd=service_dir,
                            capture_output=True, text=True, timeout=600
                        )
                        if browser_result.returncode != 0:
                            raise RuntimeError(
                                f"Fallo instalando el navegador {browser} de Playwright: "
                                f"{browser_result.stderr or browser_result.stdout}"
                            )
                        installation["browser"] = browser
                    marker.write_text(json.dumps(installation, indent=2), encoding="utf-8")
                else:
                    self._trace(server_id, f"npm package already installed: {package}@{version}")

        venv_python = get_venv_python(get_venv_dir())
        return {
            "serviceDir": str(service_dir),
            "pythonExecutable": str(venv_python) if venv_python.is_file() else sys.executable,
            "nodeExecutable": node
        }

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

    def start(self, server_id: str, remember: bool, browser: dict | None = None) -> list[dict]:
        """Arranca un servicio; con remember lo guarda como activo para ofrecerlo en la siguiente sesión.
        `browser` es el navegador que exige el perfil activo, solo para Playwright MCP."""
        with self._lock:
            self.services = self._load_services()
            server = self.services.get(server_id)
            if not server:
                raise KeyError(f"Servidor MCP desconocido: {server_id}")
            record = self.records.setdefault(server_id, McpServiceRecord())
            if record.client and record.client.running():
                return self.list_servers()
            record.phase, record.error = "starting", None
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
                    values[f"option:{opt_id}"] = str(val)
                    if opt.get("type") == "boolean":
                        option_args.extend(opt.get("argsWhenTrue", []) if val else opt.get("argsWhenFalse", []))

                launch = server.get("launch", {})
                command = self._expand(launch.get("executable", sys.executable), values)
                args = [self._expand(arg, values) for arg in launch.get("args", []) + option_args]
                env = os.environ.copy()
                for k, v in launch.get("env", {}).items():
                    env[k] = self._expand(v, values)
                record.browser = None
                if server_id in SERVICE_LAUNCH:
                    extra_args, extra_env, record.browser = SERVICE_LAUNCH[server_id](browser)
                    args += extra_args
                    env.update(extra_env)

                client = StdioMcpClient(
                    command, args, str(service_dir), env,
                    trace=lambda message: self._trace(server_id, message),
                    call_timeout=_positive_seconds(launch.get("callTimeoutSeconds"), DEFAULT_MCP_CALL_TIMEOUT_SECONDS)
                )
                # _prepare_service puede haber dejado el estado en "installing".
                record.phase, record.client = "starting", client
                client.start(int(launch.get("handshakeTimeoutSeconds", 15)))
                record.phase = "running"
                if remember:
                    self._remember(server_id, True)
                self._trace(server_id, "started successfully")
            except Exception as exc:
                record.phase, record.error = "error", str(exc)
                self._trace(server_id, f"start failed: {exc}")
                stale, record.client = record.client or client, None
                if stale:
                    stale.stop()
            return self.list_servers()

    def stop(self, server_id: str) -> list[dict]:
        with self._lock:
            self.services = self._load_services()
            record = self.records.pop(server_id, McpServiceRecord())
            if server_id not in self.services and not record.client:
                raise KeyError(f"Servidor MCP desconocido: {server_id}")
            if record.client:
                record.client.stop()
            self._remember(server_id, False)
            return self.list_servers()

    def configure(self, server_id: str, options: dict | None = None) -> list[dict]:
        with self._lock:
            self.services = self._load_services()
            if server_id not in self.services:
                raise KeyError(f"Servidor MCP desconocido: {server_id}")
            entry = self.preferences.setdefault(server_id, {})
            if options is not None:
                opts = entry.setdefault("options", {})
                opts.update(options)
            self._save_preferences()
            return self.list_servers()

    def _running_clients(self) -> list[tuple[str, StdioMcpClient]]:
        return [(server_id, record.client) for server_id, record in self.records.items()
                if record.client and record.client.running()]

    def tools(self) -> list[dict]:
        aggregated = []
        seen: set[str] = set()
        with self._lock:
            for server_id, client in self._running_clients():
                for t in client.tools:
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
                        "originalName": original
                    }
                    aggregated.append(tcopy)
        return aggregated

    def _resolve_tool(self, public_name: str) -> tuple[str, StdioMcpClient, str] | None:
        with self._lock:
            for server_id, client in self._running_clients():
                for t in client.tools:
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
        return decoded or None

    def call(self, public_name: str, arguments: dict) -> dict:
        resolved = self._resolve_tool(public_name)
        if not resolved:
            raise ValueError(f"Herramienta externa '{public_name}' no disponible o servidor detenido.")
        # La llamada puede durar decenas de segundos: no debe bloquear al resto de servidores.
        _, client, original_name = resolved
        return client.request("tools/call", {"name": original_name, "arguments": arguments}, timeout=client.call_timeout)

    def close(self):
        with self._lock:
            for record in self.records.values():
                if record.client:
                    record.client.stop()
                record.phase, record.client, record.error = "stopped", None, None


GLOBAL_MCP_MANAGER = McpServiceManager()


@on_playwright_status
def _playwright_service_running() -> bool:
    return any(server["id"] == PLAYWRIGHT_SERVER_ID and server["status"] in ("running", "starting", "installing")
               for server in GLOBAL_MCP_MANAGER.list_servers())
