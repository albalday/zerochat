#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""
Servidor Local de Herramientas para ZeroChat con Soporte MCP Stdio.
Proporciona:
1. Herramientas locales básicas esenciales (shell, list_directory, read_file, edit_file).
2. Cliente y gestor MCP para arrancar y consumir servidores MCP externos por stdio.
3. Router unificado HTTP / JSON-RPC 2.0 para ZeroChat.
"""

import os
import sys
import json
import time
import argparse
import platform
import subprocess
import threading
import queue
import signal
from pathlib import Path
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_PORT = 6388
DEFAULT_EXTERNAL_SOURCE_URL = "https://albalday.github.io/zerochat/mcp/releases/stable"


def log_line(message):
    """Write a single safe, timestamped operational log line."""
    print(f"[{time.strftime('%H:%M:%S')}] {message}", flush=True)


def request_type(method):
    """Return a fixed label so request parameters never reach the log."""
    labels = {
        "initialize": "MCP initialize",
        "tools/list": "MCP tools/list",
        "tools/call": "MCP tools/call",
        "zerochat/external/status": "external status",
        "zerochat/external/start": "external start",
        "zerochat/external/stop": "external stop",
        "zerochat/external/servers/list": "external servers/list",
        "zerochat/external/servers/start": "external servers/start",
        "zerochat/external/servers/stop": "external servers/stop",
        "zerochat/external/servers/configure": "external servers/configure"
    }
    return labels.get(method, "MCP unknown")


def http_request_type(path, accept=""):
    if path == "/mcp/external/status":
        return "external HTTP status"
    if path == "/mcp/external/bootstrap/status":
        return "external bootstrap status"
    if "/sse" in path or "text/event-stream" in accept:
        return "MCP SSE endpoint"
    return "HTTP status"


def initialize_runtime_configuration():
    """Read the launch information supplied by ZeroChat without starting MCP products.

    This only selects the source to use later if the user explicitly starts the
    external MCP host. It neither opens a connection nor reads that source.
    """
    default = {"buildChannel": "master", "externalSource": "github-pages", "externalSourceRoot": None}
    raw = os.environ.get("ZMCP_INITIALIZATION")
    if not raw:
        return default
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        return default
    if not isinstance(value, dict):
        return default
    channel = value.get("buildChannel")
    source = value.get("externalSource")
    source_root = value.get("externalSourceRoot")
    if channel not in ("dev", "master") or source not in ("local-copy", "github-pages"):
        return default
    if source == "local-copy" and (not isinstance(source_root, str) or not os.path.isabs(source_root)):
        return default
    return {"buildChannel": channel, "externalSource": source, "externalSourceRoot": source_root}

# ==============================================================================
# Herramientas Locales Básicas (Core)
# ==============================================================================

def list_directory(path: str = ".", max_depth: int = 1) -> str:
    """Recorre un directorio local y devuelve la lista de archivos y subcarpetas con sus tipos y tamaños."""
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
    """Lee el contenido de texto de un archivo local con soporte de rangos y límites seguros."""
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
    """Crea, sobrescribe o edita un archivo de forma atómica (write, append o replace_chunk)."""
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
        else:  # mode == "write"
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
    """Ejecuta un comando en la terminal local y devuelve stdout, stderr y diagnóstico del SO."""
    try:
        target_cwd = str(Path(cwd).expanduser().resolve())
        proc = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            cwd=target_cwd,
            timeout=max(1, min(int(timeout_seconds), 300))
        )

        stdout = proc.stdout[:50000] + ("\n\n[... Truncado ...]" if len(proc.stdout) > 50000 else "")
        stderr = proc.stderr[:20000] + ("\n\n[... Truncado ...]" if len(proc.stderr) > 20000 else "")

        os_info = {
            "system": platform.system(),
            "release": platform.release(),
            "machine": platform.machine(),
            "shell": os.environ.get("SHELL") or os.environ.get("COMSPEC", "sh"),
            "cwd": target_cwd
        }

        return json.dumps({
            "success": proc.returncode == 0,
            "command": command,
            "cwd": target_cwd,
            "returncode": proc.returncode,
            "stdout": stdout,
            "stderr": stderr,
            "truncated": len(proc.stdout) > 50000 or len(proc.stderr) > 20000,
            "os_info": os_info
        }, ensure_ascii=False, indent=2)
    except subprocess.TimeoutExpired:
        return json.dumps({
            "success": False,
            "command": command,
            "error": f"Excedió el tiempo límite ({timeout_seconds}s).",
            "returncode": -1
        }, ensure_ascii=False)
    except Exception as e:
        return json.dumps({
            "success": False,
            "command": command,
            "error": str(e),
            "returncode": -1
        }, ensure_ascii=False)


DETECTED_OS = f"{platform.system()} {platform.machine()}"
DETECTED_SHELL = os.environ.get("SHELL") or os.environ.get("COMSPEC", "sh")

LOCAL_TOOLS_DEFINITIONS = [
    {
        "name": "list_directory",
        "description": "Recorre un directorio local y devuelve la lista estructurada de archivos y subcarpetas con sus tamaños y tipos.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Ruta del directorio a inspeccionar (ej: '.' o './src')."},
                "max_depth": {"type": "integer", "description": "Profundidad máxima de recorrido (default: 1)."}
            }
        }
    },
    {
        "name": "read_file",
        "description": "Lee el contenido de texto de un archivo local con soporte de lectura por rangos de líneas.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Ruta del archivo a leer."},
                "start_line": {"type": "integer", "description": "Línea inicial de lectura (1-based, default: 1)."},
                "max_lines": {"type": "integer", "description": "Número máximo de líneas a leer (default: 500)."},
                "max_bytes": {"type": "integer", "description": "Límite de bytes a leer (default: 100000)."}
            },
            "required": ["path"]
        }
    },
    {
        "name": "edit_file",
        "description": "Crea o edita un archivo de código o texto de forma atómica. Soporta sobrescritura ('write'), anexado ('append') o reemplazo exacto de fragmento ('replace_chunk').",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Ruta del archivo a editar o crear."},
                "content": {"type": "string", "description": "Contenido a escribir o texto de reemplazo."},
                "mode": {"type": "string", "enum": ["write", "append", "replace_chunk"], "description": "Modo de edición: 'write' (sobrescribe/crea), 'append' (anexa al final), 'replace_chunk' (reemplaza target_content). Default: 'write'."},
                "target_content": {"type": "string", "description": "Fragmento exacto a sustituir cuando mode='replace_chunk'."}
            },
            "required": ["path", "content"]
        }
    },
    {
        "name": "execute_command",
        "description": f"Ejecuta un comando en la terminal local del sistema (SO detectado: {DETECTED_OS}, shell: {DETECTED_SHELL}). Úsalo para operaciones de git, compilación, pruebas y gestión del proyecto.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "Comando a ejecutar en la terminal (ej: 'git status', 'npm test')."},
                "cwd": {"type": "string", "description": "Directorio de trabajo (default: '.')."},
                "timeout_seconds": {"type": "integer", "description": "Límite de tiempo en segundos (default: 60, máx: 300)."}
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
# Puente al host MCP externo descargable
# ==============================================================================

class ExternalMcpHostBridge:
    """Lanza el bootstrap descargable y retransmite su protocolo privado.

    El servidor local no conoce productos, catálogos ni comandos de servidores
    externos. Esos datos pertenecen exclusivamente al host descargado.
    """

    def __init__(self, home, source, source_root=None, source_url=DEFAULT_EXTERNAL_SOURCE_URL):
        self.home = Path(home).expanduser().resolve()
        self.source, self.source_root, self.source_url = source, source_root, source_url
        self.process, self._next, self._pending = None, 0, {}
        self._lock = threading.Lock()
        self._bootstrap_lock = threading.Lock()
        self._bootstrap_state = {"state": "idle", "message": ""}

    def running(self):
        return self.process is not None and self.process.poll() is None

    def bootstrap_status(self):
        with self._bootstrap_lock:
            return dict(self._bootstrap_state)

    def _set_bootstrap_state(self, state, message):
        with self._bootstrap_lock:
            self._bootstrap_state = {"state": state, "message": message}

    def start_host_background(self):
        """Start one external-host bootstrap without blocking the HTTP request."""
        with self._bootstrap_lock:
            if self._bootstrap_state["state"] == "running":
                return dict(self._bootstrap_state)
            if self.running():
                self._bootstrap_state = {"state": "completed", "message": "Servicios preparados."}
                return dict(self._bootstrap_state)
            self._bootstrap_state = {"state": "running", "message": "Comprobando servicios..."}
        threading.Thread(target=self._run_bootstrap, daemon=True).start()
        return self.bootstrap_status()

    def _run_bootstrap(self):
        try:
            self._set_bootstrap_state("running", "Arrancando servidores MCP...")
            self.start_host()
            self._set_bootstrap_state("completed", "Servicios preparados.")
        except Exception as err:
            self._set_bootstrap_state("failed", f"Error: {err}")

    def _bootstrap_path(self):
        target = self.home / "bootstrap.py"
        target.parent.mkdir(parents=True, exist_ok=True)
        if self.source == "local-copy":
            root = Path(self.source_root or "").resolve()
            source = root / "bootstrap" / "bootstrap.py"
            if not source.is_file():
                raise RuntimeError("No se encontró el bootstrap MCP local")
            target.write_bytes(source.read_bytes())
        elif not target.exists():
            import urllib.request
            if not self.source_url.startswith("https://"):
                raise RuntimeError("La fuente MCP externa debe usar HTTPS")
            with urllib.request.urlopen(self.source_url.rstrip("/") + "/bootstrap.py", timeout=30) as response:
                data = response.read(2 * 1024 * 1024 + 1)
            if len(data) > 2 * 1024 * 1024:
                raise RuntimeError("El bootstrap MCP supera el límite permitido")
            target.write_bytes(data)
        return target

    def start_host(self):
        if self.running():
            return self.request("status")
        bootstrap = self._bootstrap_path()
        command = [sys.executable, str(bootstrap), "--home", str(self.home), "--source", self.source]
        if self.source == "local-copy":
            command.extend(["--source-root", str(Path(self.source_root).resolve())])
        else:
            command.extend(["--source-url", self.source_url])
        self.process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, bufsize=1, start_new_session=True)
        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._drain_stderr, daemon=True).start()
        return self.request("status", timeout=45)

    def _drain_stderr(self):
        if self.process and self.process.stderr:
            for _ in self.process.stderr:
                pass

    def _read_stdout(self):
        try:
            for line in self.process.stdout:
                try:
                    message = json.loads(line)
                except (TypeError, ValueError):
                    continue
                request_id = message.get("requestId")
                with self._lock:
                    waiter = self._pending.pop(request_id, None)
                if waiter:
                    waiter.put(message)
        finally:
            with self._lock:
                waiters = list(self._pending.values())
                self._pending.clear()
            for waiter in waiters:
                waiter.put({"ok": False, "error": "El host MCP externo terminó"})

    def request(self, command, timeout=30, **params):
        if not self.running():
            raise RuntimeError("Los servicios MCP externos no están arrancados")
        with self._lock:
            self._next += 1
            request_id = self._next
            waiter = queue.Queue(maxsize=1)
            self._pending[request_id] = waiter
            message = {"requestId": request_id, "command": command, **params}
            self.process.stdin.write(json.dumps(message) + "\n")
            self.process.stdin.flush()
        try:
            response = waiter.get(timeout=timeout)
        except queue.Empty as exc:
            with self._lock:
                self._pending.pop(request_id, None)
            raise TimeoutError("El host MCP externo no respondió a tiempo") from exc
        if not response.get("ok"):
            raise RuntimeError(response.get("error", "Error del host MCP externo"))
        return response.get("result", {})

    def stop_host(self):
        if not self.running():
            return {"host": "stopped", "servers": []}
        try:
            self.request("shutdown", timeout=5)
        except Exception:
            pass
        try:
            self.process.terminate()
            self.process.wait(timeout=3)
        except (OSError, subprocess.TimeoutExpired):
            try:
                self.process.kill()
            except OSError:
                pass
        self.process = None
        return {"host": "stopped", "servers": []}


external_host = None


# ==============================================================================
# Servidor HTTP JSON-RPC 2.0 y Router Unificado
# ==============================================================================

class ZeroChatLocalServerHandler(BaseHTTPRequestHandler):
    server_version = "ZeroChatLocalServer/2.0.0"

    def log_request_received(self, kind):
        log_line(f"REQUEST {kind}")

    def log_response_sent(self, kind, status, outcome="ok"):
        log_line(f"RESPONSE {kind} HTTP {status} {outcome}")

    def send_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def do_OPTIONS(self):
        kind = "HTTP OPTIONS"
        self.log_request_received(kind)
        self.send_response(204)
        self.send_cors_headers()
        self.end_headers()
        self.log_response_sent(kind, 204)

    def do_GET(self):
        accept = self.headers.get("Accept", "")
        kind = http_request_type(self.path, accept)
        self.log_request_received(kind)
        if "/sse" in self.path or "text/event-stream" in accept:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.send_cors_headers()
            self.end_headers()
            self.wfile.write(b"event: endpoint\r\ndata: /\r\n\r\n")
            self.wfile.flush()
            self.log_response_sent(kind, 200)
            return

        if self.path == "/mcp/external/bootstrap/status":
            status = external_host.bootstrap_status() if external_host else {"state": "idle", "message": ""}
            res_data = json.dumps(status, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(res_data)))
            self.send_cors_headers()
            self.end_headers()
            self.wfile.write(res_data)
            self.log_response_sent(kind, 200)
            return

        if self.path == "/mcp/external/status":
            status = {"host": "stopped", "servers": []}
            if external_host and external_host.running():
                try:
                    status = external_host.request("status")
                except Exception as err:
                    status = {"host": "error", "servers": [], "error": str(err)}
            res_data = json.dumps({
                "success": True,
                **status
            }, ensure_ascii=False, indent=2).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(res_data)))
            self.send_cors_headers()
            self.end_headers()
            self.wfile.write(res_data)
            self.log_response_sent(kind, 200)
            return

        # Estado general: las herramientas externas no se agregan al servidor local.
        res_data = json.dumps({
            "status": "active",
            "server": "ZeroChat Local Server",
            "version": "2.0.0",
            "local_tools_count": len(LOCAL_TOOLS_DEFINITIONS),
            "mcp_tools_count": 0,
            "total_tools_count": len(LOCAL_TOOLS_DEFINITIONS),
            "external_host": "running" if external_host and external_host.running() else "stopped",
            "os": DETECTED_OS
        }, ensure_ascii=False, indent=2).encode("utf-8")

        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(res_data)))
        self.send_cors_headers()
        self.end_headers()
        self.wfile.write(res_data)
        self.log_response_sent(kind, 200)

    def do_POST(self):
        content_len = int(self.headers.get("Content-Length", 0))
        post_data = self.rfile.read(content_len) if content_len > 0 else b"{}"

        try:
            req = json.loads(post_data.decode("utf-8"))
        except Exception as err:
            kind = "MCP invalid request"
            self.log_request_received(kind)
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
            self.log_response_sent(kind, 400, "error")
            return

        # Protocolo JSON-RPC 2.0 estándar
        req_id = req.get("id")
        method = req.get("method")
        params = req.get("params", {})
        kind = request_type(method)
        self.log_request_received(kind)

        if req_id is None and (method or "").startswith("notifications/"):
            self.send_response(204)
            self.send_cors_headers()
            self.end_headers()
            self.log_response_sent(kind, 204)
            return

        result = None
        error = None

        if self.path == "/mcp/external":
            if not external_host or not external_host.running():
                error = {"code": -32001, "message": "Los servicios MCP externos no están arrancados."}
            elif method == "initialize":
                result = {"protocolVersion": "2024-11-05", "serverInfo": {"name": "ZeroChat External MCP Host", "version": "1"}, "capabilities": {"tools": {}}}
            elif method == "tools/list":
                try:
                    result = external_host.request("tools/list")
                except Exception as ex:
                    error = {"code": -32001, "message": str(ex)}
            elif method == "tools/call":
                try:
                    result = external_host.request("tools/call", name=params.get("name", ""), arguments=params.get("arguments", {}), timeout=60)
                except Exception as ex:
                    error = {"code": -32001, "message": str(ex)}
            else:
                error = {"code": -32601, "message": f"Método externo '{method}' no soportado."}
        elif method == "initialize":
            result = {
                "protocolVersion": "2024-11-05",
                "serverInfo": {
                    "name": "ZeroChat Local Server",
                    "version": "2.0.0"
                },
                "capabilities": {
                    "tools": {"listChanged": True}
                }
            }
        elif method == "tools/list":
            result = {"tools": list(LOCAL_TOOLS_DEFINITIONS)}
        elif method == "tools/call":
            tool_name = params.get("name", "")
            tool_args = params.get("arguments", {})

            if tool_name in LOCAL_TOOL_HANDLERS:
                handler = LOCAL_TOOL_HANDLERS[tool_name]
                try:
                    tool_output_json = handler(**tool_args)
                    result = {
                        "content": [
                            {"type": "text", "text": tool_output_json}
                        ],
                        "isError": False
                    }
                except Exception as ex:
                    result = {
                        "content": [
                            {"type": "text", "text": json.dumps({"success": False, "error": str(ex)}, ensure_ascii=False)}
                        ],
                        "isError": True
                    }
            else:
                error = {"code": -32601, "message": f"Herramienta local '{tool_name}' no encontrada."}
        elif method == "zerochat/external/status":
            result = external_host.request("status") if external_host and external_host.running() else {"host": "stopped", "servers": []}
        elif method == "zerochat/external/start":
            try:
                result = external_host.start_host_background()
            except Exception as ex:
                error = {"code": -32010, "message": str(ex)}
        elif method == "zerochat/external/stop":
            result = external_host.stop_host()
        elif method == "zerochat/external/servers/list":
            result = external_host.request("list") if external_host and external_host.running() else {"servers": []}
        elif method == "zerochat/external/servers/start":
            try:
                result = external_host.request("start", serverId=params.get("serverId"))
            except Exception as ex:
                error = {"code": -32011, "message": str(ex)}
        elif method == "zerochat/external/servers/stop":
            try:
                result = external_host.request("stop", serverId=params.get("serverId"))
            except Exception as ex:
                error = {"code": -32011, "message": str(ex)}
        elif method == "zerochat/external/servers/configure":
            try:
                result = external_host.request("configure", serverId=params.get("serverId"), enabled=params.get("enabled"))
            except Exception as ex:
                error = {"code": -32011, "message": str(ex)}
        else:
            error = {"code": -32601, "message": f"Método '{method}' no soportado."}

        response_payload = {"jsonrpc": "2.0", "id": req_id}
        if error:
            response_payload["error"] = error
        else:
            response_payload["result"] = result

        resp_bytes = json.dumps(response_payload, ensure_ascii=False).encode("utf-8")

        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(resp_bytes)))
        self.send_cors_headers()
        self.end_headers()
        self.wfile.write(resp_bytes)
        self.log_response_sent(kind, 200, "error" if error else "ok")

    def log_message(self, format, *args):
        pass


def main():
    global external_host
    runtime = initialize_runtime_configuration()
    parser = argparse.ArgumentParser(description="Servidor Local de Herramientas para ZeroChat con Soporte MCP Stdio")
    parser.add_argument("--host", default=os.environ.get("ZMCP_DEFAULT_HOST", "127.0.0.1"), help="Host de escucha (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=int(os.environ.get("ZMCP_DEFAULT_PORT", DEFAULT_PORT)), help=f"Puerto de escucha (default: {DEFAULT_PORT})")
    parser.add_argument("--test", action="store_true", help="Ejecutar comprobación interna de herramientas locales")
    parser.add_argument("--mcp-home", default=str(Path.home() / ".zerochat" / "mcp"), help="Directorio privado del host MCP externo")
    parser.add_argument("--mcp-source", choices=("github-pages", "local-copy"), default=runtime["externalSource"], help="Origen del bootstrap MCP externo")
    parser.add_argument("--mcp-source-root", default=runtime["externalSourceRoot"] or str(SCRIPT_DIR / "mcp"), help="Raíz de desarrollo para --mcp-source local-copy")
    parser.add_argument("--mcp-source-url", default=DEFAULT_EXTERNAL_SOURCE_URL, help="URL HTTPS de releases MCP externas")
    args = parser.parse_args()

    if args.test:
        log_line(f"TEST list_directory {'ok' if json.loads(list_directory('.'))['success'] else 'error'}")
        log_line(f"TEST read_file {'ok' if json.loads(read_file('package.json', max_lines=5))['success'] else 'error'}")
        log_line(f"TEST execute_command {'ok' if json.loads(execute_command('echo hello'))['success'] else 'error'}")
        log_line("TEST local tools ready")
        return

    external_host = ExternalMcpHostBridge(args.mcp_home, args.mcp_source, args.mcp_source_root, args.mcp_source_url)
    server = ThreadingHTTPServer((args.host, args.port), ZeroChatLocalServerHandler)
    log_line(f"SERVER active http://{args.host}:{args.port}")
    log_line("SERVER local tools ready")
    log_line("SERVER external MCP stopped")
    log_line("SERVER waiting for MCP connections")

    def shutdown(*_):
        log_line("SERVER stopping")
        external_host.stop_host()
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)
    try:
        server.serve_forever()
    finally:
        external_host.stop_host()
        server.server_close()


if __name__ == "__main__":
    main()
