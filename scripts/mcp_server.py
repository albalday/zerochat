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
from pathlib import Path
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

# Importar cliente MCP desde el mismo directorio o PYTHONPATH
SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

try:
    from mcp_client import StdioMcpClient, McpProcessManager
except ImportError:
    from scripts.mcp_client import StdioMcpClient, McpProcessManager

DEFAULT_PORT = 6388

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
# Servidores MCP Externos Configurados
# ==============================================================================

DEFAULT_MCP_SERVERS = {
    "playwright": {
        "id": "playwright",
        "name": "Playwright Browser",
        "description": "Navegación web, interacción y capturas mediante Playwright MCP",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-playwright"]
    }
}

mcp_manager = McpProcessManager(DEFAULT_MCP_SERVERS)


# ==============================================================================
# Servidor HTTP JSON-RPC 2.0 y Router Unificado
# ==============================================================================

class ZeroChatLocalServerHandler(BaseHTTPRequestHandler):
    server_version = "ZeroChatLocalServer/2.0.0"

    def send_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_cors_headers()
        self.end_headers()

    def do_GET(self):
        accept = self.headers.get("Accept", "")
        if "/sse" in self.path or "text/event-stream" in accept:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.send_cors_headers()
            self.end_headers()
            self.wfile.write(b"event: endpoint\r\ndata: /\r\n\r\n")
            self.wfile.flush()
            return

        if self.path == "/mcp/servers":
            res_data = json.dumps({
                "success": True,
                "servers": mcp_manager.list_servers()
            }, ensure_ascii=False, indent=2).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(res_data)))
            self.send_cors_headers()
            self.end_headers()
            self.wfile.write(res_data)
            return

        # Estado general
        active_mcp_tools = mcp_manager.get_all_active_tools()
        res_data = json.dumps({
            "status": "active",
            "server": "ZeroChat Local Server",
            "version": "2.0.0",
            "local_tools_count": len(LOCAL_TOOLS_DEFINITIONS),
            "mcp_tools_count": len(active_mcp_tools),
            "total_tools_count": len(LOCAL_TOOLS_DEFINITIONS) + len(active_mcp_tools),
            "servers": mcp_manager.list_servers(),
            "os": DETECTED_OS
        }, ensure_ascii=False, indent=2).encode("utf-8")

        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(res_data)))
        self.send_cors_headers()
        self.end_headers()
        self.wfile.write(res_data)

    def do_POST(self):
        content_len = int(self.headers.get("Content-Length", 0))
        post_data = self.rfile.read(content_len) if content_len > 0 else b"{}"

        try:
            req = json.loads(post_data.decode("utf-8"))
        except Exception as err:
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
            return

        # Endpoints REST de ciclo de vida MCP
        if self.path == "/mcp/register":
            server_id = req.get("server_id")
            cfg = req.get("config", {})
            if not server_id:
                body = json.dumps({"success": False, "error": "server_id es obligatorio"}).encode("utf-8")
                self.send_response(400)
            else:
                mcp_manager.register_server_config(server_id, cfg)
                body = json.dumps({"success": True, "server": mcp_manager.get_server_status(server_id)}).encode("utf-8")
                self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_cors_headers()
            self.end_headers()
            self.wfile.write(body)
            return

        if self.path == "/mcp/start":
            server_id = req.get("server_id")
            if req.get("config"):
                mcp_manager.register_server_config(server_id, req.get("config"))
            try:
                res = mcp_manager.start_server(server_id)
                body = json.dumps({"success": True, "server": mcp_manager.get_server_status(server_id), "tools": res.get("tools", [])}).encode("utf-8")
                self.send_response(200)
            except Exception as err:
                body = json.dumps({"success": False, "error": str(err)}).encode("utf-8")
                self.send_response(500)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_cors_headers()
            self.end_headers()
            self.wfile.write(body)
            return

        if self.path == "/mcp/stop":
            server_id = req.get("server_id")
            res = mcp_manager.stop_server(server_id)
            body = json.dumps({"success": True, "server": res}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_cors_headers()
            self.end_headers()
            self.wfile.write(body)
            return

        # Protocolo JSON-RPC 2.0 estándar
        req_id = req.get("id")
        method = req.get("method")
        params = req.get("params", {})

        if req_id is None and (method or "").startswith("notifications/"):
            self.send_response(204)
            self.send_cors_headers()
            self.end_headers()
            return

        result = None
        error = None

        if method == "initialize":
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
            # Agregación: Herramientas locales + Herramientas de servidores MCP activos
            combined_tools = list(LOCAL_TOOLS_DEFINITIONS)
            mcp_tools = mcp_manager.get_all_active_tools()
            combined_tools.extend(mcp_tools)
            result = {
                "tools": combined_tools
            }
        elif method == "tools/call":
            tool_name = params.get("name", "")
            tool_args = params.get("arguments", {})

            # 1. ¿Es una herramienta local propia?
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
            # 2. ¿Es una herramienta MCP de servidor externo activo?
            else:
                try:
                    mcp_res = mcp_manager.call_tool(tool_name, tool_args)
                    result = mcp_res
                except KeyError:
                    error = {"code": -32601, "message": f"Herramienta '{tool_name}' no encontrada."}
                except Exception as ex:
                    result = {
                        "content": [
                            {"type": "text", "text": json.dumps({"success": False, "error": str(ex)}, ensure_ascii=False)}
                        ],
                        "isError": True
                    }
        elif method == "mcp/servers":
            result = {"servers": mcp_manager.list_servers()}
        elif method == "mcp/start":
            sid = params.get("server_id")
            try:
                res = mcp_manager.start_server(sid)
                result = {"success": True, "server": mcp_manager.get_server_status(sid), "tools": res.get("tools", [])}
            except Exception as ex:
                error = {"code": -32000, "message": str(ex)}
        elif method == "mcp/stop":
            sid = params.get("server_id")
            res = mcp_manager.stop_server(sid)
            result = {"success": True, "server": res}
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

    def log_message(self, format, *args):
        pass


def main():
    parser = argparse.ArgumentParser(description="Servidor Local de Herramientas para ZeroChat con Soporte MCP Stdio")
    parser.add_argument("--host", default="127.0.0.1", help="Host de escucha (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"Puerto de escucha (default: {DEFAULT_PORT})")
    parser.add_argument("--test", action="store_true", help="Ejecutar comprobación interna de herramientas locales")
    args = parser.parse_args()

    if args.test:
        print("[TEST] list_directory('.') ->", json.loads(list_directory("."))["success"])
        print("[TEST] read_file('package.json') ->", json.loads(read_file("package.json", max_lines=5))["success"])
        print("[TEST] execute_command('echo hello') ->", json.loads(execute_command("echo hello"))["success"])
        print("[TEST] Herramientas locales operativas.")
        return

    server = ThreadingHTTPServer((args.host, args.port), ZeroChatLocalServerHandler)
    print(f"🚀 [ZeroChat Local Server v2.0] Activo en http://{args.host}:{args.port}")
    print(f"🛠️  Herramientas locales (Core): {', '.join(LOCAL_TOOL_HANDLERS.keys())}")
    print(f"🔌 Servidores MCP configurados: {', '.join(DEFAULT_MCP_SERVERS.keys())}")
    print(f"💻 Sistema Operativo: {DETECTED_OS} | Shell: {DETECTED_SHELL}")
    print("📡 Esperando conexiones de ZeroChat (HTTP / SSE)...")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n🛑 Deteniendo servidor y procesos MCP asociados...")
        mcp_manager.stop_all()
        server.server_close()


if __name__ == "__main__":
    main()
