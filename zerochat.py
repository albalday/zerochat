#!/usr/bin/env python3
"""
ZeroChat - Backend Local Unificado y Gestor de Entorno

Proporciona:
1. Auto-creación, actualización y ejecución en el entorno virtual local `./zerochat`.
2. Servidor local HTTP y Server-Sent Events (SSE) con autenticación estricta por token efímero.
3. Herramientas locales seguras: read_file, edit_file, list_directory, execute_command.
4. Apertura automática del navegador apuntando a zerochat.html con token en el fragmento hash.
"""

from __future__ import annotations

import argparse
import atexit
import datetime
import hmac
import json
import os
import platform
import queue
import re
import secrets
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.request
from urllib.parse import urlencode
import venv
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

def _read_package_version() -> str:
    try:
        pkg_path = Path(__file__).resolve().parent / "package.json"
        if pkg_path.is_file():
            import json
            data = json.loads(pkg_path.read_text(encoding="utf-8"))
            if "version" in data and isinstance(data["version"], str):
                return data["version"].strip()
    except Exception:
        pass
    return "7.1.2"

VERSION = _read_package_version()
DEFAULT_PORT = 6388
DEFAULT_HOST = "127.0.0.1"
DEFAULT_UI_URL = "https://albalday.github.io/zerochat/zerochat.html"
REMOTE_VERSION_URL = "https://raw.githubusercontent.com/albalday/zerochat/master/package.json"
REMOTE_SCRIPT_URL = "https://raw.githubusercontent.com/albalday/zerochat/master/zerochat.py"

def get_venv_dir() -> Path:
    """Devuelve la ruta absoluta al directorio del entorno virtual ./zerochat."""
    return (Path.cwd() / "zerochat").resolve()


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


def get_daily_token() -> str:
    """Devuelve un token de sesión diario persistido en ./zerochat/config/token.json."""
    config_dir = get_venv_dir() / "config"
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
    Comprueba si existe el entorno virtual en ./zerochat. Si no existe, lo crea.
    Si el proceso actual no se está ejecutando bajo dicho entorno, se re-ejecuta.
    """
    venv_dir = get_venv_dir()
    venv_py = get_venv_python(venv_dir)

    # 1. Crear el venv si no existe
    if not venv_py.exists():
        print(f"[{time.strftime('%H:%M:%S')}] [zerochat] Inicializando entorno virtual en {venv_dir}...", flush=True)
        try:
            venv.create(venv_dir, with_pip=True, clear=False)
            print(f"[{time.strftime('%H:%M:%S')}] [zerochat] Entorno virtual preparado con éxito.", flush=True)
        except Exception as err:
            print(f"[{time.strftime('%H:%M:%S')}] [zerochat] Advertencia al crear venv: {err}. Continuando con intérprete actual.", flush=True)
            return

    # 2. Comprobar si ya estamos ejecutándonos dentro del venv
    try:
        current_py = Path(sys.executable).resolve()
        target_py = venv_py.resolve()
        if current_py != target_py and target_py.exists():
            print(f"[{time.strftime('%H:%M:%S')}] [zerochat] Re-ejecutando bajo {venv_py}...", flush=True)
            # Re-ejecutar con los mismos argumentos
            args = [str(target_py), str(Path(__file__).resolve())] + sys.argv[1:]
            os.execv(str(target_py), args)
    except Exception as err:
        print(f"[{time.strftime('%H:%M:%S')}] [zerochat] Error en re-ejecución: {err}. Continuando.", flush=True)


def parse_version(ver: str) -> tuple[int, ...]:
    """Convierte una cadena de versión semántica en tupla de enteros para comparación."""
    parts = []
    for piece in ver.split("."):
        clean = "".join(filter(str.isdigit, piece))
        if clean:
            parts.append(int(clean))
    return tuple(parts)


def check_version():
    """Comprueba si hay una nueva versión de zerochat.py en el repositorio remoto (solo en modo producción/standalone)."""
    if get_dev_root() is not None:
        return
    try:
        req = urllib.request.Request(REMOTE_VERSION_URL, headers={"User-Agent": f"ZeroChat/{VERSION}"})
        with urllib.request.urlopen(req, timeout=3) as resp:
            content = resp.read(2048).decode("utf-8", errors="ignore")
            remote_ver = None
            try:
                data = json.loads(content)
                if isinstance(data, dict) and "version" in data and isinstance(data["version"], str):
                    remote_ver = data["version"].strip()
            except Exception:
                pass
            if not remote_ver:
                match = re.search(r'["\']?version["\']?\s*[:=]\s*["\'](\d+\.\d+\.\d+)["\']', content)
                if match:
                    remote_ver = match.group(1)
            if remote_ver and re.match(r"^\d+(\.\d+)+", remote_ver):
                if parse_version(remote_ver) > parse_version(VERSION):
                    print(f"[{time.strftime('%H:%M:%S')}] [zerochat] ¡Nueva versión disponible! (Local: {VERSION}, Remota: {remote_ver})", flush=True)
                    print(f"[{time.strftime('%H:%M:%S')}] [zerochat] Actualiza con: curl -sSL {REMOTE_SCRIPT_URL} -o zerochat.py", flush=True)
    except Exception:
        # Modo offline o timeout ignorado de forma segura
        pass


# ==============================================================================
# Herramientas Locales Core
# ==============================================================================

def list_directory(path: str = ".", max_depth: int = 1) -> str:
    """Recorre un directorio local y devuelve la lista de archivos y carpetas."""
    try:
        target = Path(path).expanduser().resolve()
        if not target.exists():
            return json.dumps({"success": False, "error": f"La ruta '{path}' no existe."}, ensure_ascii=False)
        if not target.is_dir():
            return json.dumps({"success": False, "error": f"La ruta '{path}' no es un directorio."}, ensure_ascii=False)

        entries = []
        for entry in os.scandir(target):
            try:
                stat = entry.stat(follow_symlinks=False)
                is_dir = entry.is_dir(follow_symlinks=False)
                entries.append({
                    "name": entry.name,
                    "path": str(Path(entry.path).resolve()),
                    "type": "directory" if is_dir else "file",
                    "size_bytes": None if is_dir else stat.st_size,
                    "is_symlink": entry.is_symlink()
                })
            except (PermissionError, FileNotFoundError):
                continue

        entries.sort(key=lambda e: (e["type"] != "directory", e["name"].lower()))
        return json.dumps({
            "success": True,
            "path": str(target),
            "total_items": len(entries),
            "entries": entries
        }, ensure_ascii=False, indent=2)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)


def read_file(path: str, start_line: int = 1, max_lines: int = 500, max_bytes: int = 100000) -> str:
    """Lee el contenido de texto de un archivo local con rangos y límites seguros."""
    try:
        target = Path(path).expanduser().resolve()
        if not target.exists():
            return json.dumps({"success": False, "error": f"El archivo '{path}' no existe."}, ensure_ascii=False)
        if not target.is_file():
            return json.dumps({"success": False, "error": f"La ruta '{path}' no es un archivo regular."}, ensure_ascii=False)

        file_size = target.stat().st_size
        safe_max_bytes = max(1024, min(int(max_bytes), 2000000))
        safe_start_line = max(1, int(start_line))
        safe_max_lines = max(1, min(int(max_lines), 2000))

        with open(target, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()

        total_lines = len(lines)
        start_idx = safe_start_line - 1
        end_idx = min(start_idx + safe_max_lines, total_lines)

        selected_lines = lines[start_idx:end_idx] if start_idx < total_lines else []
        content = "".join(selected_lines)

        truncated_bytes = False
        if len(content.encode("utf-8")) > safe_max_bytes:
            content = content[:safe_max_bytes]
            truncated_bytes = True

        return json.dumps({
            "success": True,
            "path": str(target),
            "size_bytes": file_size,
            "total_lines": total_lines,
            "start_line": safe_start_line,
            "lines_returned": len(selected_lines),
            "truncated": truncated_bytes or end_idx < total_lines,
            "content": content
        }, ensure_ascii=False, indent=2)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)


def edit_file(path: str, content: str, mode: str = "write", target_content: str = None) -> str:
    """Crea, sobrescribe o edita un archivo de forma atómica."""
    try:
        target = Path(path).expanduser().resolve()
        target.parent.mkdir(parents=True, exist_ok=True)

        if mode == "append":
            with open(target, "a", encoding="utf-8") as f:
                f.write(content)
            bytes_written = len(content.encode("utf-8"))
        elif mode == "replace_chunk":
            if not target.exists():
                return json.dumps({"success": False, "error": f"El archivo '{path}' no existe para replace_chunk."}, ensure_ascii=False)
            if not target_content:
                return json.dumps({"success": False, "error": "target_content es obligatorio en modo replace_chunk."}, ensure_ascii=False)

            with open(target, "r", encoding="utf-8", errors="replace") as f:
                existing = f.read()

            if target_content not in existing:
                return json.dumps({"success": False, "error": "target_content no fue encontrado en el archivo."}, ensure_ascii=False)

            new_text = existing.replace(target_content, content, 1)
            temp_path = target.with_suffix(target.suffix + f".tmp_{os.getpid()}")
            with open(temp_path, "w", encoding="utf-8") as f:
                f.write(new_text)
            temp_path.replace(target)
            bytes_written = len(new_text.encode("utf-8"))
        else:  # write
            temp_path = target.with_suffix(target.suffix + f".tmp_{os.getpid()}")
            with open(temp_path, "w", encoding="utf-8") as f:
                f.write(content)
            temp_path.replace(target)
            bytes_written = len(content.encode("utf-8"))

        return json.dumps({
            "success": True,
            "path": str(target),
            "mode": mode,
            "bytes_written": bytes_written
        }, ensure_ascii=False, indent=2)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)


def execute_command(command: str, cwd: str = ".", timeout_seconds: int = 60) -> str:
    """Ejecuta un comando en la shell del sistema y devuelve stdout y stderr."""
    try:
        target_cwd = Path(cwd).expanduser().resolve()
        if not target_cwd.exists() or not target_cwd.is_dir():
            target_cwd = Path.cwd()

        proc = subprocess.run(
            command,
            cwd=str(target_cwd),
            shell=True,
            capture_output=True,
            text=True,
            timeout=max(1, min(int(timeout_seconds), 300)),
            encoding="utf-8",
            errors="replace"
        )
        return json.dumps({
            "success": proc.returncode == 0,
            "returncode": proc.returncode,
            "stdout": proc.stdout,
            "stderr": proc.stderr,
            "cwd": str(target_cwd)
        }, ensure_ascii=False, indent=2)
    except subprocess.TimeoutExpired:
        return json.dumps({"success": False, "error": f"Comando excedió el tiempo límite de {timeout_seconds} segundos."}, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)


LOCAL_TOOLS_DEFINITIONS = [
    {
        "name": "list_directory",
        "description": "Lista archivos y carpetas en un directorio local.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Ruta relativa o absoluta (por defecto '.')"},
                "max_depth": {"type": "integer", "description": "Profundidad máxima", "default": 1}
            }
        }
    },
    {
        "name": "read_file",
        "description": "Lee el contenido de texto de un archivo local.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Ruta del archivo"},
                "start_line": {"type": "integer", "description": "Línea inicial (1-indexed)", "default": 1},
                "max_lines": {"type": "integer", "description": "Número máximo de líneas a leer", "default": 500},
                "max_bytes": {"type": "integer", "description": "Límite máximo de bytes", "default": 100000}
            },
            "required": ["path"]
        }
    },
    {
        "name": "edit_file",
        "description": "Crea, sobrescribe o modifica un archivo local de forma atómica.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Ruta del archivo a editar"},
                "content": {"type": "string", "description": "Contenido a escribir o reemplazar"},
                "mode": {"type": "string", "enum": ["write", "append", "replace_chunk"], "default": "write"},
                "target_content": {"type": "string", "description": "Texto exacto a reemplazar cuando mode='replace_chunk'"}
            },
            "required": ["path", "content"]
        }
    },
    {
        "name": "execute_command",
        "description": "Ejecuta un comando en la shell del sistema y captura la salida.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "Comando a ejecutar"},
                "cwd": {"type": "string", "description": "Directorio de trabajo (por defecto '.')"},
                "timeout_seconds": {"type": "integer", "description": "Tiempo límite en segundos", "default": 60}
            },
            "required": ["command"]
        }
    }
]

LOCAL_TOOL_HANDLERS = {
    "list_directory": list_directory,
    "read_file": read_file,
    "edit_file": edit_file,
    "execute_command": execute_command
}

# ==============================================================================
# Servidor HTTP JSON-RPC 2.0 y SSE con Autenticación por Token
# ==============================================================================

def sanitize_log_path(raw_path: str) -> str:
    """Oculta tokens de sesión o parámetros sensibles en la query string para logs seguros."""
    if not raw_path or "?" not in raw_path:
        return raw_path or "/"
    path, query = raw_path.split("?", 1)
    safe_query = re.sub(r'(token=)[^&]+', r'\1***', query, flags=re.IGNORECASE)
    return f"{path}?{safe_query}"


def format_log_error(msg: str, max_len: int = 160) -> str:
    """Limpia y trunca mensajes de error para mantener el log en una sola línea legible."""
    if not msg:
        return ""
    cleaned = " ".join(str(msg).strip().splitlines())
    if len(cleaned) > max_len:
        return cleaned[:max_len - 3] + "..."
    return cleaned


def is_allowed_origin(origin: str | None) -> bool:
    """Verifica si el origen CORS está autorizado."""
    if origin is None or origin == "null":
        return True
    origin_lower = origin.lower()
    if origin_lower == "https://albalday.github.io" or origin_lower.startswith("https://albalday.github.io/"):
        return True
    if origin_lower == "http://127.0.0.1" or origin_lower.startswith("http://127.0.0.1:"):
        return True
    if origin_lower == "http://localhost" or origin_lower.startswith("http://localhost:"):
        return True
    return False


def public_tool_name(server_id: str, original: str) -> str:
    """Codificación inyectiva de nombres de herramientas MCP idéntica a publicToolName en js/mcp.js."""
    def encode(value: str, tool: bool = False) -> str:
        if not isinstance(value, str) or not value or len(value) > 256:
            raise ValueError("Componente de nombre MCP no válido")
        return "".join(ch if ("a" <= ch <= "y" or "0" <= ch <= "9" or (tool and ch == "_"))
                       else f"z{ord(ch):x}z" for ch in value)
    name = f"mcp_{encode(server_id)}_{encode(original, True)}"
    if len(name) > 64:
        raise ValueError(f"El nombre público de la herramienta MCP excede 64 caracteres: {name}")
    return name


class StdioMcpClient:
    def __init__(self, command: str, args: list[str], cwd: str, env: dict[str, str]):
        self.command = command
        self.args = args
        self.cwd = cwd
        self.env = env
        self.process: subprocess.Popen | None = None
        self._pending: dict[int, queue.Queue] = {}
        self._next = 0
        self._lock = threading.Lock()
        self._alive = False
        self.tools: list[dict] = []

    def running(self) -> bool:
        return self._alive and self.process is not None and self.process.poll() is None

    def start(self, handshake_timeout: int = 30):
        cmd = [self.command] + self.args
        self.process = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=self.cwd,
            env=self.env,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1
        )
        self._alive = True
        threading.Thread(target=self._drain_stderr, daemon=True).start()
        threading.Thread(target=self._read_stdout, daemon=True).start()

        self.request("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "zerochat", "version": VERSION}
        }, timeout=handshake_timeout)
        self.notify("notifications/initialized")
        tools_resp = self.request("tools/list", {}, timeout=10)
        self.tools = tools_resp.get("tools", [])

    def _drain_stderr(self):
        if self.process and self.process.stderr:
            for _ in self.process.stderr:
                pass

    def _read_stdout(self):
        try:
            if not self.process or not self.process.stdout:
                return
            for line in self.process.stdout:
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except Exception:
                    continue
                req_id = msg.get("id")
                if req_id is not None:
                    with self._lock:
                        waiter = self._pending.pop(req_id, None)
                    if waiter:
                        waiter.put(msg)
        finally:
            self._alive = False
            with self._lock:
                pending = list(self._pending.values())
                self._pending.clear()
            for waiter in pending:
                waiter.put({"error": {"message": "MCP process ended unexpectedly"}})

    def request(self, method: str, params: dict, timeout: int = 30) -> dict:
        if not self.running():
            raise RuntimeError("MCP process is not running")
        with self._lock:
            self._next += 1
            req_id = self._next
            waiter = queue.Queue(maxsize=1)
            self._pending[req_id] = waiter
            payload = json.dumps({"jsonrpc": "2.0", "id": req_id, "method": method, "params": params}) + "\n"
            try:
                self.process.stdin.write(payload)
                self.process.stdin.flush()
            except Exception as exc:
                self._alive = False
                self._pending.pop(req_id, None)
                raise RuntimeError(f"Failed writing to MCP process: {exc}") from exc
        try:
            response = waiter.get(timeout=timeout)
        except queue.Empty as exc:
            with self._lock:
                self._pending.pop(req_id, None)
            raise TimeoutError(f"MCP request timed out: {method}") from exc
        if response.get("error"):
            raise RuntimeError(str(response["error"].get("message", "MCP request failed")))
        return response.get("result", {})

    def notify(self, method: str):
        if self.running():
            with self._lock:
                try:
                    self.process.stdin.write(json.dumps({"jsonrpc": "2.0", "method": method}) + "\n")
                    self.process.stdin.flush()
                except Exception:
                    self._alive = False

    def stop(self):
        self._alive = False
        if not self.process:
            return
        try:
            self.process.terminate()
            self.process.wait(timeout=2)
        except (OSError, subprocess.TimeoutExpired):
            try:
                self.process.kill()
            except OSError:
                pass
        self.process = None
        self.tools = []


class McpServiceManager:
    def __init__(self, services_root: Path | None = None):
        if services_root:
            self.services_root = Path(services_root)
        else:
            candidates = [
                Path.cwd() / "services",
                get_venv_dir() / "services"
            ]
            self.services_root = candidates[0] if candidates[0].is_dir() else candidates[1]
        self.services_root.mkdir(parents=True, exist_ok=True)
        self.config_file = get_venv_dir() / "config" / "services.json"
        self.config_file.parent.mkdir(parents=True, exist_ok=True)
        self.clients: dict[str, StdioMcpClient] = {}
        self.states: dict[str, str] = {}
        self.errors: dict[str, str] = {}
        self._lock = threading.Lock()
        self._ensure_default_services()
        self.services = self._load_services()
        self.preferences = self._load_preferences()

    def _ensure_default_services(self):
        dummy_dir = self.services_root / "dummy_mcp"
        dummy_dir.mkdir(parents=True, exist_ok=True)
        service_json_file = dummy_dir / "service.json"
        dummy_server_file = dummy_dir / "dummy_mcp_server.py"

        if not service_json_file.exists():
            service_json_file.write_text(json.dumps({
                "schemaVersion": 1,
                "id": "dummy_mcp",
                "displayName": {
                    "es": "MCP de prueba",
                    "en": "Test MCP"
                },
                "description": {
                    "es": "Servicio MCP mínimo para comprobar la infraestructura externa.",
                    "en": "Minimal MCP service for verifying the external infrastructure."
                },
                "enabledByDefault": False,
                "transport": "stdio",
                "launch": {
                    "executable": "${pythonExecutable}",
                    "args": ["${serviceDir}/dummy_mcp_server.py"],
                    "cwd": "${serviceDir}",
                    "env": {},
                    "handshakeTimeoutSeconds": 10
                }
            }, indent=2), encoding="utf-8")

        if not dummy_server_file.exists():
            dummy_server_file.write_text('''#!/usr/bin/env python3
import json, sys

def reply(req_id, result=None, error=None):
    resp = {"jsonrpc": "2.0", "id": req_id}
    if error: resp["error"] = error
    else: resp["result"] = result
    sys.stdout.write(json.dumps(resp) + "\\n")
    sys.stdout.flush()

for raw in sys.stdin:
    try: req = json.loads(raw)
    except: continue
    req_id, method, params = req.get("id"), req.get("method"), req.get("params", {})
    if method == "initialize":
        reply(req_id, {
            "protocolVersion": "2024-11-05",
            "serverInfo": {"name": "ZeroChat Dummy MCP", "version": "1.0.0"},
            "capabilities": {"tools": {}}
        })
    elif method == "tools/list":
        reply(req_id, {"tools": [{
            "name": "echo",
            "description": "Echo back a message for testing.",
            "inputSchema": {
                "type": "object",
                "properties": {"message": {"type": "string", "description": "Message to echo."}},
                "required": ["message"]
            }
        }]})
    elif method == "tools/call":
        if params.get("name") != "echo":
            reply(req_id, error={"code": -32601, "message": "Tool not found"})
            continue
        msg = params.get("arguments", {}).get("message", "")
        reply(req_id, {
            "content": [{"type": "text", "text": f"echo: {msg}"}],
            "isError": False
        })
''', encoding="utf-8")

        # 2. playwright
        playwright_dir = self.services_root / "playwright"
        playwright_dir.mkdir(parents=True, exist_ok=True)
        pw_service = playwright_dir / "service.json"
        pw_installer = playwright_dir / "installer.json"
        if not pw_service.exists():
            pw_service.write_text(json.dumps({
                "schemaVersion": 1,
                "id": "playwright",
                "displayName": {
                    "es": "Playwright MCP",
                    "en": "Playwright MCP"
                },
                "description": {
                    "es": "Automatización de navegador mediante el servidor MCP oficial de Playwright.",
                    "en": "Browser automation through the official Playwright MCP server."
                },
                "enabledByDefault": False,
                "transport": "stdio",
                "launch": {
                    "executable": "${nodeExecutable}",
                    "args": ["${serviceDir}/node_modules/@playwright/mcp/cli.js", "--browser=chromium"],
                    "cwd": "${serviceDir}",
                    "env": {},
                    "handshakeTimeoutSeconds": 30
                },
                "options": [
                    {
                        "id": "headless",
                        "type": "boolean",
                        "label": {
                            "es": "Navegación en segundo plano (Headless)",
                            "en": "Headless background mode"
                        },
                        "description": {
                            "es": "Desactívalo para ver la ventana del navegador durante la automatización",
                            "en": "Disable to display the browser window during automation"
                        },
                        "default": True,
                        "argsWhenTrue": ["--headless"],
                        "argsWhenFalse": []
                    }
                ]
            }, indent=2), encoding="utf-8")
        if not pw_installer.exists():
            pw_installer.write_text(json.dumps({
                "schemaVersion": 1,
                "type": "npm",
                "product": {
                    "package": "@playwright/mcp",
                    "version": "0.0.81",
                    "browser": "chromium"
                }
            }, indent=2), encoding="utf-8")

        # 3. memory
        memory_dir = self.services_root / "memory"
        memory_dir.mkdir(parents=True, exist_ok=True)
        mem_service = memory_dir / "service.json"
        mem_installer = memory_dir / "installer.json"
        if not mem_service.exists():
            mem_service.write_text(json.dumps({
                "schemaVersion": 1,
                "id": "memory",
                "displayName": {
                    "es": "Memoria y Grafos (Knowledge Graph)",
                    "en": "Memory & Knowledge Graph"
                },
                "description": {
                    "es": "Almacenamiento persistente de entidades, preferencias y contexto histórico estructurado en un grafo de conocimiento.",
                    "en": "Persistent storage of entities, preferences, and historical context structured as a knowledge graph."
                },
                "enabledByDefault": False,
                "transport": "stdio",
                "launch": {
                    "executable": "${nodeExecutable}",
                    "args": ["${serviceDir}/node_modules/@modelcontextprotocol/server-memory/dist/index.js"],
                    "cwd": "${serviceDir}",
                    "env": {
                        "MEMORY_FILE_PATH": "${serviceDir}/memory.jsonl"
                    },
                    "handshakeTimeoutSeconds": 30
                }
            }, indent=2), encoding="utf-8")
        if not mem_installer.exists():
            mem_installer.write_text(json.dumps({
                "schemaVersion": 1,
                "type": "npm",
                "product": {
                    "package": "@modelcontextprotocol/server-memory",
                    "version": "2026.8.31"
                }
            }, indent=2), encoding="utf-8")

        # 4. lsp
        lsp_dir = self.services_root / "lsp"
        lsp_dir.mkdir(parents=True, exist_ok=True)
        lsp_service = lsp_dir / "service.json"
        lsp_installer = lsp_dir / "installer.json"
        if not lsp_service.exists():
            lsp_service.write_text(json.dumps({
                "schemaVersion": 1,
                "id": "lsp",
                "displayName": {
                    "es": "LSP y Navegación de Código",
                    "en": "LSP & Code Intelligence"
                },
                "description": {
                    "es": "Servidor de protocolos de lenguaje (LSP): salto a definiciones, búsqueda de símbolos, referencias e inspección de tipos sin sobrecargar el contexto.",
                    "en": "Language Server Protocol (LSP) server: jump to definitions, symbol search, references, and type inspection without context overload."
                },
                "enabledByDefault": False,
                "transport": "stdio",
                "launch": {
                    "executable": "${nodeExecutable}",
                    "args": ["${serviceDir}/node_modules/@axivo/mcp-lsp/dist/index.js"],
                    "cwd": "${serviceDir}",
                    "env": {},
                    "handshakeTimeoutSeconds": 30
                }
            }, indent=2), encoding="utf-8")
        if not lsp_installer.exists():
            lsp_installer.write_text(json.dumps({
                "schemaVersion": 1,
                "type": "npm",
                "product": {
                    "package": "@axivo/mcp-lsp",
                    "version": "1.0.5"
                }
            }, indent=2), encoding="utf-8")

    def _load_services(self) -> dict[str, dict]:
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
            except Exception:
                continue
        return servers

    def _load_preferences(self) -> dict:
        if self.config_file.exists():
            try:
                return json.loads(self.config_file.read_text(encoding="utf-8"))
            except Exception:
                return {}
        return {}

    def _save_preferences(self):
        try:
            tmp = self.config_file.with_suffix(".tmp")
            tmp.write_text(json.dumps(self.preferences, indent=2), encoding="utf-8")
            tmp.replace(self.config_file)
        except Exception:
            pass

    def list_servers(self) -> list[dict]:
        self.services = self._load_services()
        result = []
        for server_id, server in self.services.items():
            client = self.clients.get(server_id)
            running = bool(client and client.running())
            pref = self.preferences.get(server_id, {})
            result.append({
                "id": server_id,
                "displayName": server.get("displayName", {}),
                "description": server.get("description", {}),
                "enabled": pref.get("enabled", server.get("enabledByDefault", False)),
                "status": "running" if running else self.states.get(server_id, "stopped"),
                "toolCount": len(client.tools) if running else 0,
                "error": self.errors.get(server_id),
                "options": server.get("options", []),
                "userOptions": pref.get("options", {})
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
                    raise RuntimeError("Node.js 18+ y npm son necesarios para instalar este servicio MCP")

                needs_install = not marker.exists()
                if not needs_install:
                    try:
                        installation = json.loads(marker.read_text(encoding="utf-8"))
                        if installation.get("package") != package or installation.get("version") != version:
                            needs_install = True
                    except Exception:
                        needs_install = True

                if needs_install:
                    self.states[server_id] = "installing"
                    manifest = service_dir / "package.json"
                    manifest.write_text(json.dumps({"private": True, "dependencies": {package: version}}, indent=2), encoding="utf-8")
                    res = subprocess.run([npm, "install", "--ignore-scripts", "--no-audit", "--no-fund"], cwd=service_dir, capture_output=True, text=True, timeout=600)
                    if res.returncode != 0:
                        raise RuntimeError(f"Fallo instalando dependencias npm: {res.stderr or res.stdout}")
                    installation = {"type": "npm", "package": package, "version": version, "nodeExecutable": node}
                    browser = product.get("browser")
                    if browser:
                        playwright_cli = service_dir / "node_modules" / "playwright" / "cli.js"
                        if playwright_cli.is_file():
                            subprocess.run([node, str(playwright_cli), "install", browser], cwd=service_dir, capture_output=True, text=True, timeout=600)
                            installation["browser"] = browser
                    marker.write_text(json.dumps(installation, indent=2), encoding="utf-8")

        return {
            "serviceDir": str(service_dir),
            "pythonExecutable": sys.executable,
            "nodeExecutable": node
        }

    def start(self, server_id: str) -> list[dict]:
        with self._lock:
            self.services = self._load_services()
            server = self.services.get(server_id)
            if not server:
                raise KeyError(f"Servidor MCP desconocido: {server_id}")
            current = self.clients.get(server_id)
            if current and current.running():
                return self.list_servers()
            self.states[server_id] = "starting"
            try:
                service_dir = server["_directory"]
                values = self._prepare_service(server_id, server)
                pref = self.preferences.get(server_id, {})
                user_opts = pref.get("options", {})
                for opt in server.get("options", []):
                    opt_id = opt.get("id")
                    if opt_id:
                        val = user_opts.get(opt_id, opt.get("default"))
                        values[f"option:{opt_id}"] = str(val)

                launch = server.get("launch", {})
                command = self._expand(launch.get("executable", sys.executable), values)
                args = [self._expand(arg, values) for arg in launch.get("args", [])]
                for opt in server.get("options", []):
                    opt_id = opt.get("id")
                    if not opt_id:
                        continue
                    val = user_opts.get(opt_id, opt.get("default"))
                    if opt.get("type") == "boolean":
                        extra = opt.get("argsWhenTrue", []) if val else opt.get("argsWhenFalse", [])
                        args.extend([self._expand(a, values) for a in extra])

                env = os.environ.copy()
                for k, v in launch.get("env", {}).items():
                    env[k] = self._expand(v, values)

                client = StdioMcpClient(command, args, str(service_dir), env)
                client.start(int(launch.get("handshakeTimeoutSeconds", 15)))
                self.clients[server_id] = client
                self.states[server_id] = "running"
                self.errors.pop(server_id, None)
                entry = self.preferences.setdefault(server_id, {})
                entry["enabled"] = True
                self._save_preferences()
            except Exception as exc:
                self.states[server_id] = "error"
                self.errors[server_id] = str(exc)
                if server_id in self.clients:
                    self.clients.pop(server_id).stop()
            return self.list_servers()

    def stop(self, server_id: str) -> list[dict]:
        with self._lock:
            client = self.clients.pop(server_id, None)
            if client:
                client.stop()
            self.states[server_id] = "stopped"
            self.errors.pop(server_id, None)
            entry = self.preferences.setdefault(server_id, {})
            entry["enabled"] = False
            self._save_preferences()
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

    def tools(self) -> list[dict]:
        aggregated = []
        with self._lock:
            for server_id, client in self.clients.items():
                if not client.running():
                    continue
                for t in client.tools:
                    try:
                        pname = public_tool_name(server_id, t["name"])
                        tcopy = dict(t)
                        tcopy["name"] = pname
                        tcopy["metadata"] = {
                            "mcpServerId": server_id,
                            "originalName": t["name"]
                        }
                        aggregated.append(tcopy)
                    except Exception:
                        continue
        return aggregated

    def call(self, public_name: str, arguments: dict) -> dict:
        with self._lock:
            for server_id, client in self.clients.items():
                if not client.running():
                    continue
                for t in client.tools:
                    if public_tool_name(server_id, t["name"]) == public_name:
                        return client.request("tools/call", {"name": t["name"], "arguments": arguments})
        raise ValueError(f"Herramienta externa '{public_name}' no disponible o servidor detenido.")

    def close(self):
        with self._lock:
            for client in list(self.clients.values()):
                client.stop()
            self.clients.clear()


GLOBAL_MCP_MANAGER = McpServiceManager()

DEFAULT_HEARTBEAT_TIMEOUT = float(os.environ.get("ZEROCHAT_HEARTBEAT_TIMEOUT", "60.0"))
DEFAULT_HEARTBEAT_GRACE = float(os.environ.get("ZEROCHAT_HEARTBEAT_GRACE", "45.0"))
DEFAULT_HEARTBEAT_POLL = float(os.environ.get("ZEROCHAT_HEARTBEAT_POLL", "5.0"))
HEARTBEAT_LAST_SEEN = 0.0
HEARTBEAT_INITIALIZED = False
HEARTBEAT_WATCHDOG_STOP = threading.Event()
_SERVER_SHUTTING_DOWN = threading.Event()


def mark_browser_active():
    """Registra la presencia activa del navegador ante cualquier petición válida."""
    global HEARTBEAT_LAST_SEEN, HEARTBEAT_INITIALIZED
    HEARTBEAT_LAST_SEEN = time.monotonic()
    HEARTBEAT_INITIALIZED = True


def stop_zerochat_server(server: ThreadingHTTPServer):
    """Detiene limpiamente el servidor y todos los subsistemas evitando reentradas."""
    if _SERVER_SHUTTING_DOWN.is_set():
        return
    _SERVER_SHUTTING_DOWN.set()
    HEARTBEAT_WATCHDOG_STOP.set()
    GLOBAL_MCP_MANAGER.close()
    threading.Thread(target=server.shutdown, daemon=True).start()


def heartbeat_watchdog(server: ThreadingHTTPServer, initial_grace_seconds: float = DEFAULT_HEARTBEAT_GRACE, inactivity_timeout_seconds: float = DEFAULT_HEARTBEAT_TIMEOUT, require_initial_connection: bool = True):
    """
    Supervisa la presencia de la pestaña del navegador mediante latidos HTTP.
    Si el navegador se cierra o deja de emitir latidos, detiene el servidor automáticamente.
    """
    start_time = time.monotonic()
    poll_interval = min(DEFAULT_HEARTBEAT_POLL, max(0.02, inactivity_timeout_seconds / 2))
    while not HEARTBEAT_WATCHDOG_STOP.is_set():
        if HEARTBEAT_WATCHDOG_STOP.wait(timeout=poll_interval):
            break

        now = time.monotonic()

        # 1. Periodo de gracia inicial (solo si zerochat abrió el navegador)
        if not HEARTBEAT_INITIALIZED:
            if require_initial_connection and (now - start_time > initial_grace_seconds):
                print(f"[{time.strftime('%H:%M:%S')}] Tiempo de espera del navegador agotado ({initial_grace_seconds:.0f}s). Deteniendo servidor ZeroChat...", flush=True)
                stop_zerochat_server(server)
                break
            continue

        # 2. Inactividad tras haber recibido latidos
        if now - HEARTBEAT_LAST_SEEN > inactivity_timeout_seconds:
            print(f"[{time.strftime('%H:%M:%S')}] Navegador desconectado (cierre detectado). Deteniendo servidor ZeroChat...", flush=True)
            stop_zerochat_server(server)
            break


DEV_CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8",
    ".map": "application/json",
}


class ZeroChatServerHandler(BaseHTTPRequestHandler):
    server_version = f"ZeroChatServer/{VERSION}"

    def _log_req(self, method: str, detail: str):
        now = time.strftime("%H:%M:%S")
        print(f"[{now}] --> {method} {detail}", flush=True)

    def _log_res(self, status: int, detail: str, duration_ms: float, error_info: str = ""):
        now = time.strftime("%H:%M:%S")
        status_text = {
            200: "200 OK",
            204: "204 No Content",
            400: "400 Bad Request",
            401: "401 Unauthorized",
            403: "403 Forbidden",
            404: "404 Not Found",
            500: "500 Internal Server Error",
        }.get(status, str(status))
        err_suffix = f" - ERROR: {format_log_error(error_info)}" if error_info else ""
        print(f"[{now}] <-- {status_text} {detail}{err_suffix} ({duration_ms:.1f}ms)", flush=True)

    def serve_static_dev_file(self, rel_path: str) -> bool:
        """Sirve un archivo estático del repositorio si existe y estamos en el directorio de desarrollo."""
        dev_root = get_dev_root()
        if not dev_root:
            return False

        clean_rel = rel_path.split("?", 1)[0].lstrip("/")
        if not clean_rel:
            return False

        target_path = (dev_root / clean_rel).resolve()
        try:
            rel_parts = target_path.relative_to(dev_root.resolve()).parts
        except ValueError:
            return False

        # Whitelist de archivos y carpetas autorizados para servir la interfaz web
        is_allowed_static = (
            clean_rel == "zerochat.html" or
            clean_rel in ("manifest.webmanifest", "sw.js", "favicon.ico") or
            clean_rel.startswith("js/") or
            clean_rel.startswith("css/") or
            clean_rel.startswith("help/")
        )
        if not is_allowed_static:
            return False

        # Protección: bloquear archivos ocultos y entorno virtual ./zerochat
        for part in rel_parts:
            if part.startswith(".") and part != ".":
                return False
            if part in ("zerochat", "node_modules", ".git", "tests"):
                return False

        if not target_path.is_file():
            return False

        ext = target_path.suffix.lower()
        content_type = DEV_CONTENT_TYPES.get(ext, "application/octet-stream")
        try:
            data = target_path.read_bytes()
        except Exception:
            return False

        mark_browser_active()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        if clean_rel == "sw.js":
            self.send_header("Service-Worker-Allowed", "/")
        self.send_cors_headers()
        self.end_headers()
        self.wfile.write(data)
        return True

    def send_cors_headers(self):
        origin = self.headers.get("Origin")
        if not is_allowed_origin(origin):
            return
        self.send_header("Access-Control-Allow-Origin", origin if origin else "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization, X-ZeroChat-Token, X-ZeroChat-Client")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def verify_token(self) -> bool:
        """Comprueba el token efímero de sesión en cabeceras o query string."""
        auth_header = self.headers.get("Authorization", "")
        token_candidate = None
        if auth_header.startswith("Bearer "):
            token_candidate = auth_header[7:].strip()
        elif "X-ZeroChat-Token" in self.headers:
            token_candidate = self.headers.get("X-ZeroChat-Token", "").strip()
        elif "?" in self.path:
            query = self.path.split("?", 1)[1]
            for part in query.split("&"):
                if part.startswith("token="):
                    token_candidate = part.split("=", 1)[1].strip()
                    break

        if not token_candidate:
            return False
        is_valid = hmac.compare_digest(token_candidate, SESSION_TOKEN)
        if is_valid:
            mark_browser_active()
        return is_valid

    def do_OPTIONS(self):
        t0 = time.monotonic()
        safe_path = sanitize_log_path(self.path)
        path_clean = self.path.split("?", 1)[0].rstrip("/")
        is_heartbeat = path_clean == "/zerochat/heartbeat"
        if not is_heartbeat:
            self._log_req("OPTIONS", safe_path)
        origin = self.headers.get("Origin")
        if not is_allowed_origin(origin):
            self.send_response(403)
            self.end_headers()
            self._log_res(403, safe_path, (time.monotonic() - t0) * 1000, f"Origen no permitido: '{origin}'")
            return
        self.send_response(204)
        self.send_cors_headers()
        self.end_headers()
        if not is_heartbeat:
            self._log_res(204, safe_path, (time.monotonic() - t0) * 1000)

    def _send_json_response(self, status: int, data: dict):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        t0 = time.monotonic()
        safe_path = sanitize_log_path(self.path)
        path_clean = self.path.split("?", 1)[0].rstrip("/")
        is_heartbeat = path_clean == "/zerochat/heartbeat"

        origin = self.headers.get("Origin")
        if not is_allowed_origin(origin):
            if not is_heartbeat:
                self._log_req("GET", safe_path)
            self.send_response(403)
            self.end_headers()
            self._log_res(403, safe_path, (time.monotonic() - t0) * 1000, f"Origen no permitido: '{origin}'")
            return

        # Servir archivos estáticos del repositorio si estamos en entorno de desarrollo
        if path_clean and self.serve_static_dev_file(path_clean):
            self._log_req("GET", safe_path)
            self._log_res(200, safe_path, (time.monotonic() - t0) * 1000)
            return

        if not is_heartbeat:
            self._log_req("GET", safe_path)

        if not self.verify_token():
            err_msg = json.dumps({"error": "Unauthorized: invalid or missing session token"}).encode("utf-8")
            self.send_response(401)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(err_msg)))
            self.send_cors_headers()
            self.end_headers()
            self.wfile.write(err_msg)
            self._log_res(401, safe_path, (time.monotonic() - t0) * 1000, "Token de sesión ausente o inválido")
            return

        if is_heartbeat:
            mark_browser_active()
            self._send_json_response(200, {"ok": True})
            return

        accept = self.headers.get("Accept", "")
        if "/sse" in self.path or "text/event-stream" in accept:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.send_cors_headers()
            self.end_headers()
            endpoint_data = b"/mcp/external" if "/mcp/external" in self.path else b"/"
            self.wfile.write(b"event: endpoint\r\ndata: " + endpoint_data + b"\r\n\r\n")
            self.wfile.flush()
            self._log_res(200, f"{safe_path} [SSE canal activo]", (time.monotonic() - t0) * 1000)
            return

        # Status general
        res_data = json.dumps({
            "status": "active",
            "server": "ZeroChat Local Server",
            "version": VERSION,
            "tools_count": len(LOCAL_TOOLS_DEFINITIONS),
            "os": DETECTED_OS
        }, ensure_ascii=False, indent=2).encode("utf-8")

        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(res_data)))
        self.send_cors_headers()
        self.end_headers()
        self.wfile.write(res_data)
        self._log_res(200, safe_path, (time.monotonic() - t0) * 1000)

    def do_POST(self):
        t0 = time.monotonic()
        safe_path = sanitize_log_path(self.path)
        origin = self.headers.get("Origin")
        if not is_allowed_origin(origin):
            self._log_req("POST", safe_path)
            self.send_response(403)
            self.end_headers()
            self._log_res(403, safe_path, (time.monotonic() - t0) * 1000, f"Origen no permitido: '{origin}'")
            return

        if not self.verify_token():
            self._log_req("POST", safe_path)
            err_msg = json.dumps({
                "jsonrpc": "2.0",
                "id": None,
                "error": {"code": -32000, "message": "Unauthorized: invalid or missing session token"}
            }).encode("utf-8")
            self.send_response(401)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(err_msg)))
            self.send_cors_headers()
            self.end_headers()
            self.wfile.write(err_msg)
            self._log_res(401, safe_path, (time.monotonic() - t0) * 1000, "Token de sesión ausente o inválido")
            return

        content_len = int(self.headers.get("Content-Length", 0))
        post_data = self.rfile.read(content_len) if content_len > 0 else b"{}"

        try:
            req = json.loads(post_data.decode("utf-8"))
        except Exception as err:
            self._log_req("POST", safe_path)
            err_resp = json.dumps({
                "jsonrpc": "2.0",
                "id": None,
                "error": {"code": -32700, "message": f"Parse error: {str(err)}"}
            }).encode("utf-8")
            self.send_response(400)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_cors_headers()
            self.end_headers()
            self.wfile.write(err_resp)
            self._log_res(400, safe_path, (time.monotonic() - t0) * 1000, f"Error parseando JSON: {err}")
            return

        req_path = self.path.split("?", 1)[0].rstrip("/")
        req_id = req.get("id")
        method = req.get("method")
        params = req.get("params", {})

        # Determinar etiqueta de seguimiento para la petición y respuesta (sin datos sensibles)
        tool_name = params.get("name", "") if isinstance(params, dict) else ""
        if method == "tools/call" and tool_name:
            action_tag = f"[tools/call: {tool_name}]"
        elif method:
            action_tag = f"[rpc: {method}]"
        elif req_path.startswith("/zerochat/external/servers/"):
            action_tag = f"[REST: {req_path}]"
        else:
            action_tag = f"[{safe_path}]"

        self._log_req("POST", f"{safe_path} {action_tag}")

        if req_id is None and (method or "").startswith("notifications/"):
            self.send_response(204)
            self.send_cors_headers()
            self.end_headers()
            self._log_res(204, f"{safe_path} {action_tag}", (time.monotonic() - t0) * 1000)
            return

        result = None
        error = None
        tool_error_info = ""
        is_external_endpoint = "/mcp/external" in req_path

        if is_external_endpoint:
            if method == "initialize":
                result = {
                    "protocolVersion": "2024-11-05",
                    "serverInfo": {
                        "name": "ZeroChat External MCP Host",
                        "version": VERSION
                    },
                    "capabilities": {
                        "tools": {"listChanged": True}
                    }
                }
            elif method == "tools/list":
                result = {"tools": GLOBAL_MCP_MANAGER.tools()}
            elif method == "tools/call":
                tool_name = params.get("name", "") if isinstance(params, dict) else ""
                tool_args = params.get("arguments", {}) if isinstance(params, dict) else {}
                try:
                    result = GLOBAL_MCP_MANAGER.call(tool_name, tool_args)
                    if isinstance(result, dict) and result.get("isError"):
                        c_list = result.get("content", [])
                        if c_list and isinstance(c_list, list) and isinstance(c_list[0], dict):
                            tool_error_info = c_list[0].get("text", "Error en herramienta MCP externa")
                        else:
                            tool_error_info = "Error en herramienta MCP externa"
                except Exception as ex:
                    tool_error_info = str(ex)
                    result = {
                        "content": [{"type": "text", "text": json.dumps({"success": False, "error": str(ex)}, ensure_ascii=False)}],
                        "isError": True
                    }
            else:
                error = {"code": -32601, "message": f"Método '{method}' no soportado en /mcp/external."}
        else:
            if method == "initialize":
                result = {
                    "protocolVersion": "2024-11-05",
                    "serverInfo": {
                        "name": "ZeroChat Local Server",
                        "version": VERSION
                    },
                    "capabilities": {
                        "tools": {"listChanged": True}
                    }
                }
            elif method == "tools/list":
                result = {"tools": list(LOCAL_TOOLS_DEFINITIONS)}
            elif method == "tools/call":
                tool_name = params.get("name", "") if isinstance(params, dict) else ""
                tool_args = params.get("arguments", {}) if isinstance(params, dict) else {}

                if tool_name in LOCAL_TOOL_HANDLERS:
                    handler = LOCAL_TOOL_HANDLERS[tool_name]
                    try:
                        tool_output_json = handler(**tool_args)
                        is_tool_err = False
                        try:
                            parsed_out = json.loads(tool_output_json)
                            if isinstance(parsed_out, dict) and parsed_out.get("success") is False:
                                is_tool_err = True
                                tool_error_info = str(parsed_out.get("error", "Error en herramienta local"))
                        except Exception:
                            pass

                        result = {
                            "content": [{"type": "text", "text": tool_output_json}],
                            "isError": is_tool_err
                        }
                    except Exception as ex:
                        tool_error_info = str(ex)
                        result = {
                            "content": [{"type": "text", "text": json.dumps({"success": False, "error": str(ex)}, ensure_ascii=False)}],
                            "isError": True
                        }
                elif tool_name.startswith("mcp_"):
                    try:
                        result = GLOBAL_MCP_MANAGER.call(tool_name, tool_args)
                        if isinstance(result, dict) and result.get("isError"):
                            c_list = result.get("content", [])
                            if c_list and isinstance(c_list, list) and isinstance(c_list[0], dict):
                                tool_error_info = c_list[0].get("text", "Error en herramienta MCP")
                            else:
                                tool_error_info = "Error en herramienta MCP"
                    except Exception as ex:
                        tool_error_info = str(ex)
                        result = {
                            "content": [{"type": "text", "text": json.dumps({"success": False, "error": str(ex)}, ensure_ascii=False)}],
                            "isError": True
                        }
                else:
                    error = {"code": -32601, "message": f"Herramienta local '{tool_name}' no encontrada."}
            elif method == "zerochat/external/status":
                result = {
                    "host": "running",
                    "version": VERSION,
                    "servers": GLOBAL_MCP_MANAGER.list_servers()
                }
            elif method == "zerochat/external/servers/start":
                server_id = params.get("serverId") or req.get("serverId")
                servers = GLOBAL_MCP_MANAGER.start(server_id)
                result = {"servers": servers}
            elif method == "zerochat/external/servers/stop":
                server_id = params.get("serverId") or req.get("serverId")
                servers = GLOBAL_MCP_MANAGER.stop(server_id)
                result = {"servers": servers}
            elif method == "zerochat/external/servers/configure":
                server_id = params.get("serverId") or req.get("serverId")
                opts = params.get("options") or req.get("options", {})
                servers = GLOBAL_MCP_MANAGER.configure(server_id, opts)
                result = {"servers": servers}
            else:
                error = {"code": -32601, "message": f"Método '{method}' no soportado."}

        response_payload = {"jsonrpc": "2.0", "id": req_id}
        error_info = ""
        if error:
            response_payload["error"] = error
            error_info = f"[{error.get('code')}] {error.get('message')}"
        else:
            response_payload["result"] = result
            if tool_error_info:
                error_info = tool_error_info

        resp_bytes = json.dumps(response_payload, ensure_ascii=False).encode("utf-8")

        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(resp_bytes)))
        self.send_cors_headers()
        self.end_headers()
        self.wfile.write(resp_bytes)
        self._log_res(200, f"{safe_path} {action_tag}", (time.monotonic() - t0) * 1000, error_info=error_info)

    def log_message(self, format, *args):
        # Silenciar logs ruidosos por defecto
        pass

def is_termux_environment() -> bool:
    """Devuelve si el proceso se ejecuta dentro de la instalación de Termux."""
    termux_prefix = "/data/data/com.termux/files/usr"
    return bool(
        os.environ.get("TERMUX_VERSION")
        or os.environ.get("PREFIX", "").startswith(termux_prefix)
        or sys.prefix.startswith(termux_prefix)
    )


def open_browser(url: str) -> bool:
    """
    Abre la URL en el navegador predeterminado del usuario respetando el entorno del sistema.
    En Termux usa termux-open-url para delegar la apertura en Android. En el resto de
    Linux prioriza xdg-open o gio para respetar el gestor de ventanas y mimeapps.list,
    desacoplando el proceso hijo para evitar ruidos en la terminal.
    """
    if sys.platform.startswith("linux"):
        if is_termux_environment() and shutil.which("termux-open-url"):
            try:
                subprocess.Popen(
                    ["termux-open-url", url],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    start_new_session=True,
                )
                return True
            except Exception:
                pass
        for cmd in ("xdg-open", "gio"):
            if shutil.which(cmd):
                try:
                    args = ["gio", "open", url] if cmd == "gio" else ["xdg-open", url]
                    subprocess.Popen(
                        args,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        start_new_session=True,
                    )
                    return True
                except Exception:
                    pass
    elif sys.platform == "darwin":
        if shutil.which("open"):
            try:
                subprocess.Popen(
                    ["open", url],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    start_new_session=True,
                )
                return True
            except Exception:
                pass
    elif sys.platform == "win32":
        try:
            os.startfile(url)
            return True
        except Exception:
            pass

    try:
        return webbrowser.open(url)
    except Exception:
        return False


# ==============================================================================
# Punto de Entrada Principal (CLI)
# ==============================================================================

def main():
    global ACTIVE_PORT, ACTIVE_HOST, SESSION_TOKEN

    parser = argparse.ArgumentParser(description=f"ZeroChat Local Server v{VERSION}")
    parser.add_argument("--port", type=int, default=int(os.environ.get("ZEROCHAT_PORT", DEFAULT_PORT)), help=f"Puerto de escucha (default: {DEFAULT_PORT})")
    parser.add_argument("--host", default=os.environ.get("ZEROCHAT_HOST", DEFAULT_HOST), help=f"Host de escucha (default: {DEFAULT_HOST})")
    parser.add_argument("--token", default=None, help="Fijar un token de sesión específico (opcional)")
    parser.add_argument("--ui-url", default=None, help="URL de la interfaz web a abrir (por defecto: interfaz local en desarrollo o GitHub Pages)")
    parser.add_argument("--no-browser", action="store_true", help="No abrir automáticamente el navegador")
    parser.add_argument("--no-exit-on-close", action="store_true", help="No detener el servidor automáticamente al cerrar el navegador")
    parser.add_argument("--no-venv", action="store_true", help="Omitir la comprobación/creación del venv ./zerochat")
    parser.add_argument("--test", action="store_true", help="Ejecutar autocomprobación interna de herramientas")
    args = parser.parse_args()

    if args.test:
        print(f"[{time.strftime('%H:%M:%S')}] TEST list_directory {'ok' if json.loads(list_directory('.'))['success'] else 'error'}")
        print(f"[{time.strftime('%H:%M:%S')}] TEST read_file {'ok' if json.loads(read_file('package.json', max_lines=5))['success'] else 'error'}")
        print(f"[{time.strftime('%H:%M:%S')}] TEST execute_command {'ok' if json.loads(execute_command('echo hello'))['success'] else 'error'}")
        print(f"[{time.strftime('%H:%M:%S')}] TEST all local tools ready.")
        return

    # 1. Asegurar entorno virtual ./zerochat salvo que se indique --no-venv
    if not args.no_venv:
        ensure_virtual_environment()

    # 2. Detectar entorno de desarrollo y resolver URL de destino
    dev_root = get_dev_root()
    is_dev = dev_root is not None

    # 3. Comprobar versión remota en segundo plano (solo fuera del entorno de desarrollo local)
    if not is_dev:
        threading.Thread(target=check_version, daemon=True).start()

    ACTIVE_PORT = args.port
    ACTIVE_HOST = args.host
    if args.token:
        SESSION_TOKEN = args.token
    else:
        SESSION_TOKEN = get_daily_token()

    server = ThreadingHTTPServer((ACTIVE_HOST, ACTIVE_PORT), ZeroChatServerHandler)

    if args.ui_url:
        ui_url = args.ui_url
    elif is_dev:
        ui_url = f"http://{ACTIVE_HOST}:{ACTIVE_PORT}/zerochat.html"
    else:
        ui_url = DEFAULT_UI_URL

    browser_host = ACTIVE_HOST if ACTIVE_HOST in {"127.0.0.1", "localhost"} else "127.0.0.1"
    target_url = f"{ui_url}#{urlencode({'token': SESSION_TOKEN, 'host': browser_host, 'port': ACTIVE_PORT})}"
    exit_on_close = not args.no_exit_on_close

    print("=" * 64)
    print(f"  ZeroChat Local Server v{VERSION}")
    print(f"  Directorio de trabajo : {Path.cwd()}")
    print(f"  Entorno virtual       : {get_venv_dir()}")
    if is_dev:
        print(f"  Modo de ejecución     : Desarrollo local ({dev_root})")
    else:
        print(f"  Modo de ejecución     : Producción (Web universal)")
    print(f"  Servidor HTTP/SSE     : http://{ACTIVE_HOST}:{ACTIVE_PORT}")
    print("  Token de sesión (diario): configurado")
    print(f"  Destino Web           : {ui_url}")
    if exit_on_close:
        print(f"  Auto-cierre           : Activado (al cerrar navegador)")
    else:
        print(f"  Auto-cierre           : Desactivado")
    print("=" * 64, flush=True)

    if not args.no_browser:
        print(f"[{time.strftime('%H:%M:%S')}] Abriendo navegador en la interfaz configurada...", flush=True)
        try:
            if not open_browser(target_url):
                print(f"[{time.strftime('%H:%M:%S')}] No se pudo abrir el navegador automáticamente.", flush=True)
        except Exception as e:
            print(f"[{time.strftime('%H:%M:%S')}] No se pudo abrir el navegador automáticamente: {e}", flush=True)

    if exit_on_close:
        require_initial = not args.no_browser
        threading.Thread(
            target=heartbeat_watchdog,
            args=(server, DEFAULT_HEARTBEAT_GRACE, DEFAULT_HEARTBEAT_TIMEOUT, require_initial),
            daemon=True
        ).start()

    def shutdown(*_):
        print(f"\n[{time.strftime('%H:%M:%S')}] Deteniendo servidor ZeroChat...")
        stop_zerochat_server(server)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    try:
        server.serve_forever()
    finally:
        stop_zerochat_server(server)
        server.server_close()


if __name__ == "__main__":
    main()
