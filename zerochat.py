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
import hmac
import json
import os
import platform
import secrets
import signal
import subprocess
import sys
import threading
import time
import urllib.request
import venv
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

VERSION = "7.0.0"
DEFAULT_PORT = 6388
DEFAULT_HOST = "127.0.0.1"
DEFAULT_UI_URL = "https://albalday.github.io/zerochat/zerochat.html"
REMOTE_VERSION_URL = "https://raw.githubusercontent.com/albalday/zerochat/master/zerochat.py"

# Estado de sesión en memoria
SESSION_TOKEN = secrets.token_urlsafe(32)
ACTIVE_PORT = DEFAULT_PORT
ACTIVE_HOST = DEFAULT_HOST

DETECTED_OS = "windows" if sys.platform.startswith("win") else ("android" if "ANDROID_ROOT" in os.environ else "linux")

# ==============================================================================
# Gestión Automática del Entorno Virtual (./zerochat)
# ==============================================================================

def get_venv_dir() -> Path:
    """Devuelve la ruta absoluta al directorio del entorno virtual ./zerochat."""
    return (Path.cwd() / "zerochat").resolve()


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


def check_version():
    """Comprueba si hay una nueva versión de zerochat.py en el repositorio remoto."""
    try:
        req = urllib.request.Request(REMOTE_VERSION_URL, headers={"User-Agent": f"ZeroChat/{VERSION}"})
        with urllib.request.urlopen(req, timeout=3) as resp:
            content = resp.read(2048).decode("utf-8", errors="ignore")
            for line in content.splitlines():
                if line.startswith("VERSION ="):
                    remote_ver = line.split("=")[1].strip().strip('"').strip("'")
                    if remote_ver and remote_ver != VERSION:
                        print(f"[{time.strftime('%H:%M:%S')}] [zerochat] ¡Nueva versión disponible! (Local: {VERSION}, Remota: {remote_ver})", flush=True)
                        print(f"[{time.strftime('%H:%M:%S')}] [zerochat] Actualiza con: curl -sSL {REMOTE_VERSION_URL} -o zerochat.py", flush=True)
                    break
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


class ZeroChatServerHandler(BaseHTTPRequestHandler):
    server_version = f"ZeroChatServer/{VERSION}"

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
        return hmac.compare_digest(token_candidate, SESSION_TOKEN)

    def do_OPTIONS(self):
        origin = self.headers.get("Origin")
        if not is_allowed_origin(origin):
            self.send_response(403)
            self.end_headers()
            return
        self.send_response(204)
        self.send_cors_headers()
        self.end_headers()

    def do_GET(self):
        origin = self.headers.get("Origin")
        if not is_allowed_origin(origin):
            self.send_response(403)
            self.end_headers()
            return

        if not self.verify_token():
            err_msg = json.dumps({"error": "Unauthorized: invalid or missing session token"}).encode("utf-8")
            self.send_response(401)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(err_msg)))
            self.send_cors_headers()
            self.end_headers()
            self.wfile.write(err_msg)
            return

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

    def do_POST(self):
        origin = self.headers.get("Origin")
        if not is_allowed_origin(origin):
            self.send_response(403)
            self.end_headers()
            return

        if not self.verify_token():
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
            return

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
                    "version": VERSION
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
                        "content": [{"type": "text", "text": tool_output_json}],
                        "isError": False
                    }
                except Exception as ex:
                    result = {
                        "content": [{"type": "text", "text": json.dumps({"success": False, "error": str(ex)}, ensure_ascii=False)}],
                        "isError": True
                    }
            else:
                error = {"code": -32601, "message": f"Herramienta local '{tool_name}' no encontrada."}
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
        # Silenciar logs ruidosos por defecto
        pass


# ==============================================================================
# Punto de Entrada Principal (CLI)
# ==============================================================================

def main():
    global ACTIVE_PORT, ACTIVE_HOST, SESSION_TOKEN

    parser = argparse.ArgumentParser(description=f"ZeroChat Local Server v{VERSION}")
    parser.add_argument("--port", type=int, default=int(os.environ.get("ZEROCHAT_PORT", DEFAULT_PORT)), help=f"Puerto de escucha (default: {DEFAULT_PORT})")
    parser.add_argument("--host", default=os.environ.get("ZEROCHAT_HOST", DEFAULT_HOST), help=f"Host de escucha (default: {DEFAULT_HOST})")
    parser.add_argument("--token", default=None, help="Fijar un token de sesión específico (opcional)")
    parser.add_argument("--ui-url", default=DEFAULT_UI_URL, help="URL de la interfaz web a abrir")
    parser.add_argument("--no-browser", action="store_true", help="No abrir automáticamente el navegador")
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

    # 2. Comprobar versión remota en segundo plano
    threading.Thread(target=check_version, daemon=True).start()

    ACTIVE_PORT = args.port
    ACTIVE_HOST = args.host
    if args.token:
        SESSION_TOKEN = args.token

    server = ThreadingHTTPServer((ACTIVE_HOST, ACTIVE_PORT), ZeroChatServerHandler)

    # 3. Construir URL y lanzar navegador
    target_url = f"{args.ui_url}#token={SESSION_TOKEN}&port={ACTIVE_PORT}"

    print("=" * 64)
    print(f"  ZeroChat Local Server v{VERSION}")
    print(f"  Directorio de trabajo : {Path.cwd()}")
    print(f"  Entorno virtual       : {get_venv_dir()}")
    print(f"  Servidor HTTP/SSE     : http://{ACTIVE_HOST}:{ACTIVE_PORT}")
    print(f"  Token de sesión       : {SESSION_TOKEN}")
    print(f"  Destino Web           : {args.ui_url}")
    print("=" * 64, flush=True)

    if not args.no_browser:
        print(f"[{time.strftime('%H:%M:%S')}] Abriendo navegador en {target_url}...", flush=True)
        try:
            webbrowser.open(target_url)
        except Exception as e:
            print(f"[{time.strftime('%H:%M:%S')}] No se pudo abrir el navegador automáticamente: {e}", flush=True)

    def shutdown(*_):
        print(f"\n[{time.strftime('%H:%M:%S')}] Deteniendo servidor ZeroChat...")
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

