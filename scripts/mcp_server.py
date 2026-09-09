#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "mcp>=1.0.0,<2",
#     "uvicorn>=0.30.0",
#     "starlette>=0.27.0",
# ]
# ///
"""
Servidor Local MCP para ZeroChat (FastMCP nativo sobre SSE).
Expone herramientas del sistema local: list_directory, read_file, execute_command.
"""

import os
import sys
import json
import argparse
import subprocess
from pathlib import Path

try:
    from mcp.server.fastmcp import FastMCP
except ImportError:
    FastMCP = None


def ensure_dependencies():
    """Garantiza la disponibilidad de 'mcp' y 'uvicorn', creando un venv privado si es necesario."""
    if is_termux_environment():
        return
    try:
        import mcp  # noqa: F401
        import uvicorn  # noqa: F401
        import starlette  # noqa: F401
        return
    except ImportError:
        pass

    env_dir = Path.home() / ".zerochat" / "mcp-env"
    is_win = sys.platform == "win32"
    py_bin = env_dir / ("Scripts/python.exe" if is_win else "bin/python3")
    pip_bin = env_dir / ("Scripts/pip.exe" if is_win else "bin/pip")

    if not py_bin.exists():
        print(f"[ZeroChat MCP] Configurando entorno virtual privado en {env_dir}...")
        import venv
        venv.create(env_dir, with_pip=True)
        print("[ZeroChat MCP] Instalando dependencias de FastMCP ('mcp<2')...")
        subprocess.run([str(pip_bin), "install", "-U", "mcp<2"], check=True)

    if Path(sys.executable).resolve() != py_bin.resolve():
        print("[ZeroChat MCP] Re-ejecutando con el entorno privado...")
        if is_win:
            sys.exit(subprocess.call([str(py_bin)] + sys.argv))
        else:
            os.execv(str(py_bin), [str(py_bin)] + sys.argv)


def is_termux_environment() -> bool:
    """Detecta Termux sin depender de módulos externos ni de la versión de Android."""
    return bool(os.environ.get("TERMUX_VERSION") or "com.termux" in sys.prefix or "com.termux" in sys.executable)


def list_directory(path: str = ".", max_depth: int = 1) -> str:
    """Recorre un directorio local y devuelve la lista estructurada de archivos y subcarpetas con sus tamaños y tipos."""
    try:
        target = Path(path).expanduser().resolve()
        if not target.exists():
            return json.dumps({"success": False, "error": f"La ruta '{path}' no existe."})
        if not target.is_dir():
            return json.dumps({"success": False, "error": f"La ruta '{path}' no es un directorio."})

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
        return json.dumps({"success": True, "path": str(target), "total_items": len(entries), "entries": entries}, ensure_ascii=False, indent=2)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)


def read_file(path: str, max_bytes: int = 100000) -> str:
    """Lee el contenido de texto de un archivo local con límite de seguridad."""
    try:
        target = Path(path).expanduser().resolve()
        if not target.exists():
            return json.dumps({"success": False, "error": f"El archivo '{path}' no existe."})
        if not target.is_file():
            return json.dumps({"success": False, "error": f"La ruta '{path}' no es un archivo regular."})

        file_size = target.stat().st_size
        safe_limit = max(1024, min(int(max_bytes), 2000000))
        with open(target, "r", encoding="utf-8", errors="replace") as f:
            content = f.read(safe_limit)

        return json.dumps({
            "success": True,
            "path": str(target),
            "size_bytes": file_size,
            "bytes_read": len(content.encode("utf-8")),
            "truncated": file_size > safe_limit,
            "content": content
        }, ensure_ascii=False, indent=2)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)


def execute_command(command: str, cwd: str = ".", timeout_seconds: int = 30) -> str:
    """Ejecuta un comando en la terminal local y devuelve stdout, stderr y código de salida."""
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
        return json.dumps({
            "success": proc.returncode == 0,
            "command": command,
            "cwd": target_cwd,
            "returncode": proc.returncode,
            "stdout": stdout,
            "stderr": stderr,
            "truncated": len(proc.stdout) > 50000 or len(proc.stderr) > 20000
        }, ensure_ascii=False, indent=2)
    except subprocess.TimeoutExpired:
        return json.dumps({"success": False, "command": command, "error": f"Excedió el tiempo límite ({timeout_seconds}s).", "returncode": -1})
    except Exception as e:
        return json.dumps({"success": False, "command": command, "error": str(e), "returncode": -1})


SERVER_TOOLS = [list_directory, read_file, execute_command]
DEFAULT_PORT = 6388


def run_termux_server(host: str = "127.0.0.1", port: int = DEFAULT_PORT):
    """Transporte MCP SSE sin wheels nativos, pensado para el Python de Termux."""
    import queue
    import threading
    import uuid
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from urllib.parse import parse_qs, urlparse

    sessions = {}
    sessions_lock = threading.Lock()
    tool_schemas = [
        {"name": "list_directory", "description": list_directory.__doc__, "inputSchema": {"type": "object", "properties": {"path": {"type": "string", "default": "."}, "max_depth": {"type": "integer", "default": 1}}}},
        {"name": "read_file", "description": read_file.__doc__, "inputSchema": {"type": "object", "properties": {"path": {"type": "string"}, "max_bytes": {"type": "integer", "default": 100000}}, "required": ["path"]}},
        {"name": "execute_command", "description": execute_command.__doc__, "inputSchema": {"type": "object", "properties": {"command": {"type": "string"}, "cwd": {"type": "string", "default": "."}, "timeout_seconds": {"type": "integer", "default": 30}}, "required": ["command"]}}
    ]

    def rpc_response(request_id, result=None, error=None):
        response = {"jsonrpc": "2.0", "id": request_id}
        response["error" if error else "result"] = error if error else result
        return response

    def handle_rpc(payload):
        method = payload.get("method")
        request_id = payload.get("id")
        if request_id is None:
            return None
        if method == "initialize":
            return rpc_response(request_id, {"protocolVersion": payload.get("params", {}).get("protocolVersion", "2024-11-05"), "capabilities": {"tools": {}}, "serverInfo": {"name": "ZeroChat Local Tools", "version": "termux-stdlib"}})
        if method == "tools/list":
            return rpc_response(request_id, {"tools": tool_schemas})
        if method == "tools/call":
            params = payload.get("params", {})
            name = params.get("name")
            arguments = params.get("arguments") or {}
            tool = next((fn for fn in SERVER_TOOLS if fn.__name__ == name), None)
            if tool is None:
                return rpc_response(request_id, error={"code": -32601, "message": f"Tool not found: {name}"})
            try:
                output = tool(**arguments)
                return rpc_response(request_id, {"content": [{"type": "text", "text": output}], "isError": False})
            except Exception as exc:
                return rpc_response(request_id, {"content": [{"type": "text", "text": str(exc)}], "isError": True})
        return rpc_response(request_id, error={"code": -32601, "message": f"Method not found: {method}"})

    class TermuxMcpHandler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def send_cors_headers(self):
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, Accept")
            self.send_header("Access-Control-Allow-Private-Network", "true")

        def do_OPTIONS(self):
            self.send_response(204)
            self.send_cors_headers()
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_GET(self):
            if urlparse(self.path).path != "/sse":
                self.send_error(404)
                return
            session_id = str(uuid.uuid4())
            messages = queue.Queue()
            with sessions_lock:
                sessions[session_id] = messages
            try:
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Connection", "keep-alive")
                self.send_cors_headers()
                self.end_headers()
                endpoint = f"/messages/?session_id={session_id}"
                self.wfile.write(f"event: endpoint\ndata: {endpoint}\n\n".encode())
                self.wfile.flush()
                while True:
                    try:
                        message = messages.get(timeout=15)
                    except queue.Empty:
                        self.wfile.write(b": keep-alive\n\n")
                        self.wfile.flush()
                        continue
                    if message is None:
                        break
                    self.wfile.write(f"event: message\ndata: {json.dumps(message, ensure_ascii=False)}\n\n".encode())
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                with sessions_lock:
                    sessions.pop(session_id, None)

        def do_POST(self):
            parsed = urlparse(self.path)
            if parsed.path != "/messages/":
                self.send_error(404)
                return
            session_id = parse_qs(parsed.query).get("session_id", [None])[0]
            with sessions_lock:
                messages = sessions.get(session_id)
            if messages is None:
                self.send_error(404, "Unknown MCP session")
                return
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 2_000_000:
                self.send_error(413)
                return
            try:
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
                response = handle_rpc(payload)
            except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
                self.send_error(400, "Invalid JSON")
                return
            if response is not None:
                messages.put(response)
            self.send_response(202)
            self.send_cors_headers()
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, format, *args):
            return

    print(f"[ZeroChat MCP] Termux stdlib server activo en http://{host}:{port}/sse")
    ThreadingHTTPServer((host, port), TermuxMcpHandler).serve_forever()


def create_mcp_app(host: str = "127.0.0.1", port: int = DEFAULT_PORT):
    ensure_dependencies()
    from mcp.server.fastmcp import FastMCP
    from mcp.server.transport_security import TransportSecuritySettings
    from starlette.middleware.cors import CORSMiddleware
    from starlette.types import ASGIApp, Receive, Scope, Send

    # Desactivar protección DNS rebinding para admitir conexiones locales y file:// (Origin: null)
    sec_settings = TransportSecuritySettings(
        enable_dns_rebinding_protection=False,
        allowed_hosts=["*"],
        allowed_origins=["*"]
    )

    mcp = FastMCP(
        "ZeroChat Local Tools",
        host=host,
        port=port,
        transport_security=sec_settings
    )

    for tool_fn in SERVER_TOOLS:
        mcp.tool()(tool_fn)

    app = mcp.sse_app()

    # Middleware para soporte de Private Network Access (PNA) y Origin: null en Chromium
    class PrivateNetworkAccessMiddleware:
        def __init__(self, inner_app: ASGIApp):
            self.inner_app = inner_app

        async def __call__(self, scope: Scope, receive: Receive, send: Send):
            if scope["type"] == "http":
                async def custom_send(message):
                    if message["type"] == "http.response.start":
                        headers = dict(message.get("headers", []))
                        headers[b"access-control-allow-private-network"] = b"true"
                        if b"access-control-allow-origin" not in headers:
                            headers[b"access-control-allow-origin"] = b"*"
                        message["headers"] = list(headers.items())
                    await send(message)
                await self.inner_app(scope, receive, custom_send)
            else:
                await self.inner_app(scope, receive, send)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.add_middleware(PrivateNetworkAccessMiddleware)
    return app


def main():
    parser = argparse.ArgumentParser(description="Servidor Local MCP para ZeroChat (FastMCP nativo SSE)")
    parser.add_argument("--host", default="127.0.0.1", help="Host de escucha (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"Puerto de escucha (default: {DEFAULT_PORT})")
    parser.add_argument("--test", action="store_true", help="Ejecutar prueba interna de herramientas")
    args = parser.parse_args()

    if args.test:
        print("[TEST] list_directory('.') ->", json.loads(list_directory("."))["success"])
        print("[TEST] read_file('package.json') ->", json.loads(read_file("package.json"))["success"])
        print("[TEST] execute_command('echo hello') ->", json.loads(execute_command("echo hello"))["success"])
        print("[TEST] Todas las funciones operan correctamente.")
        return

    if is_termux_environment():
        run_termux_server(host=args.host, port=args.port)
        return

    ensure_dependencies()
    import uvicorn
    app = create_mcp_app(host=args.host, port=args.port)
    print(f"🚀 [ZeroChat MCP] Servidor FastMCP activo en http://{args.host}:{args.port}/sse")
    print("📡 Esperando conexiones de ZeroChat...")
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
