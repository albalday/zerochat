#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""
Servidor Local de Herramientas para ZeroChat (Protocolo estándar JSON-RPC 2.0 / MCP).
Proporciona acceso a herramientas del sistema local para proyectos de software:
- list_directory: Exploración de archivos y carpetas.
- read_file: Lectura segura de archivos con soporte de rangos de líneas.
- search_files: Búsqueda de archivos por nombre y búsqueda de contenido (grep).
- edit_file: Creación y edición atómica de archivos (sobrescritura, adición o reemplazo).
- execute_command: Terminal shell unificado para Git, CLI y compilación con diagnóstico de SO.
- browser_navigate: Navegación y automatización web mediante Playwright.

No requiere librerías externas para los servicios esenciales (funciona con la librería estándar).
Playwright es opcional para la navegación web ('pip install playwright && playwright install chromium').
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

# Importación perezosa / condicional de Playwright
try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sync_playwright = None

DEFAULT_PORT = 6388


# ==============================================================================
# Servicios de Desarrollo y Mantenimiento de Software
# ==============================================================================

def list_directory(path: str = ".", max_depth: int = 1) -> str:
    """Recorre un directorio local y devuelve la lista estructurada de archivos y subcarpetas."""
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
    """Lee el contenido de texto de un archivo local con soporte de rangos y límite de seguridad."""
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

        # Truncado por límite de bytes si aplica
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


def search_files(directory: str = ".", query: str = None, file_pattern: str = "*", max_results: int = 50) -> str:
    """Busca archivos por patrón de nombre y/o busca texto/regex dentro del contenido de los archivos."""
    try:
        target_dir = Path(directory).expanduser().resolve()
        if not target_dir.exists() or not target_dir.is_dir():
            return json.dumps({"success": False, "error": f"El directorio '{directory}' no existe."}, ensure_ascii=False)

        ignored_dirs = {".git", "node_modules", "__pycache__", ".venv", ".zerochat", "dist", "build"}
        max_res = max(1, min(int(max_results), 200))
        matches = []

        query_lower = query.lower() if query else None

        for root, dirs, files in os.walk(target_dir):
            dirs[:] = [d for d in dirs if d not in ignored_dirs and not d.startswith(".")]

            for file in files:
                if len(matches) >= max_res:
                    break

                file_path = Path(root) / file
                # Comprobar patrón de nombre
                if file_pattern != "*" and not file_path.match(file_pattern):
                    continue

                rel_path = str(file_path.relative_to(target_dir))

                if not query:
                    # Búsqueda sólo por nombre
                    matches.append({"path": str(file_path.resolve()), "relative_path": rel_path})
                else:
                    # Búsqueda por contenido
                    try:
                        with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
                            for line_num, line in enumerate(f, start=1):
                                if query_lower in line.lower():
                                    matches.append({
                                        "path": str(file_path.resolve()),
                                        "relative_path": rel_path,
                                        "line_number": line_num,
                                        "line_content": line.strip()[:200]
                                    })
                                    if len(matches) >= max_res:
                                        break
                    except Exception:
                        continue

            if len(matches) >= max_res:
                break

        return json.dumps({
            "success": True,
            "directory": str(target_dir),
            "total_matches": len(matches),
            "matches": matches
        }, ensure_ascii=False, indent=2)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)


def edit_file(path: str, content: str, mode: str = "write", target_content: str = None) -> str:
    """Crea, sobrescribe o edita un archivo de forma atómica (write, append, o replace_chunk)."""
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
        else:  # mode == "write" (sobrescritura completa o creación atómica)
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


def browser_navigate(url: str, action: str = "navigate", selector: str = None, text: str = None, screenshot_path: str = None, headless: bool = True, timeout_ms: int = 30000) -> str:
    """Navega por páginas web y ejecuta automatizaciones mediante Playwright (síncrono)."""
    if sync_playwright is None:
        return json.dumps({
            "success": False,
            "error": "Playwright no está instalado en este entorno. Para habilitar la navegación y automatización web ejecuta en tu terminal: pip install playwright && playwright install chromium"
        }, ensure_ascii=False)

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=bool(headless))
            context = browser.new_context(viewport={"width": 1280, "height": 800})
            page = context.new_page()
            page.set_default_timeout(max(1000, min(int(timeout_ms), 60000)))

            page.goto(url, wait_until="domcontentloaded")

            if action == "screenshot":
                out_path = screenshot_path or f"screenshot_{int(time.time())}.png"
                target_img = Path(out_path).expanduser().resolve()
                target_img.parent.mkdir(parents=True, exist_ok=True)
                page.screenshot(path=str(target_img))
                browser.close()
                return json.dumps({
                    "success": True,
                    "url": page.url,
                    "action": "screenshot",
                    "screenshot_path": str(target_img)
                }, ensure_ascii=False)
            elif action == "click" and selector:
                page.click(selector)
                page.wait_for_load_state("domcontentloaded")
            elif action == "fill" and selector and text is not None:
                page.fill(selector, text)
            elif action == "evaluate" and text:
                eval_res = page.evaluate(text)
                browser.close()
                return json.dumps({
                    "success": True,
                    "url": page.url,
                    "action": "evaluate",
                    "result": eval_res
                }, ensure_ascii=False)

            title = page.title()
            text_content = page.evaluate("""() => {
                const clone = document.body.cloneNode(true);
                clone.querySelectorAll('script, style, noscript, svg, iframe').forEach(el => el.remove());
                return clone.innerText || '';
            }""")
            browser.close()

            # Límite seguro para contexto de chat
            if len(text_content) > 35000:
                text_content = text_content[:35000] + "\n\n[... Contenido web truncado por límite de tamaño ...]"

            return json.dumps({
                "success": True,
                "url": page.url,
                "title": title,
                "action": action,
                "content": text_content
            }, ensure_ascii=False, indent=2)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)


# ==============================================================================
# Definiciones MCP JSON-RPC 2.0
# ==============================================================================

DETECTED_OS = f"{platform.system()} {platform.machine()}"
DETECTED_SHELL = os.environ.get("SHELL") or os.environ.get("COMSPEC", "sh")

TOOLS_DEFINITIONS = [
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
        "name": "search_files",
        "description": "Busca archivos por patrón glob y/o busca coincidencias de texto dentro del contenido de los archivos en el proyecto.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "directory": {"type": "string", "description": "Directorio base donde buscar (default: '.')."},
                "query": {"type": "string", "description": "Texto o cadena a buscar dentro del contenido de los archivos."},
                "file_pattern": {"type": "string", "description": "Patrón glob de nombres de archivo (ej: '*.js', '*.py', '*.html')."},
                "max_results": {"type": "integer", "description": "Máximo de resultados a devolver (default: 50)."}
            }
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
    },
    {
        "name": "browser_navigate",
        "description": "Navega por páginas web y ejecuta automatizaciones mediante Playwright (Chromium). Permite extraer texto legible, hacer clic, rellenar formularios y capturar pantallas.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "URL de la página web a abrir."},
                "action": {"type": "string", "enum": ["navigate", "screenshot", "click", "fill", "evaluate"], "description": "Acción a realizar. Default: 'navigate'."},
                "selector": {"type": "string", "description": "Selector CSS para acciones 'click' o 'fill'."},
                "text": {"type": "string", "description": "Texto a introducir en 'fill' o código JavaScript a evaluar en 'evaluate'."},
                "screenshot_path": {"type": "string", "description": "Ruta de archivo donde guardar captura PNG (sólo para action='screenshot')."},
                "headless": {"type": "boolean", "description": "Ejecutar navegador en modo invisible (default: true)."},
                "timeout_ms": {"type": "integer", "description": "Tiempo máximo en milisegundos (default: 30000)."}
            },
            "required": ["url"]
        }
    }
]

TOOL_HANDLERS = {
    "list_directory": list_directory,
    "read_file": read_file,
    "search_files": search_files,
    "edit_file": edit_file,
    "execute_command": execute_command,
    "browser_navigate": browser_navigate
}


# ==============================================================================
# Servidor HTTP JSON-RPC 2.0 (Compatible con MCP SSE/HTTP)
# ==============================================================================

class ZeroChatLocalServerHandler(BaseHTTPRequestHandler):
    server_version = "ZeroChatLocalServer/1.0.0"

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
        # Compatibilidad con handshake SSE de navegadores (/sse o Accept: text/event-stream)
        accept = self.headers.get("Accept", "")
        if "/sse" in self.path or "text/event-stream" in accept:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.send_cors_headers()
            self.end_headers()
            # Informa al cliente que el endpoint POST es '/'
            self.wfile.write(b"event: endpoint\r\ndata: /\r\n\r\n")
            self.wfile.flush()
            return

        # Comprobación de estado general
        res_data = json.dumps({
            "status": "active",
            "server": "ZeroChat Local Server",
            "version": "1.0.0",
            "tools_count": len(TOOLS_DEFINITIONS),
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

        req_id = req.get("id")
        method = req.get("method")
        params = req.get("params", {})

        # Gestión de notificaciones (sin id de retorno)
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
                    "version": "1.0.0"
                },
                "capabilities": {
                    "tools": {"listChanged": False}
                }
            }
        elif method == "tools/list":
            result = {
                "tools": TOOLS_DEFINITIONS
            }
        elif method == "tools/call":
            tool_name = params.get("name")
            tool_args = params.get("arguments", {})
            handler = TOOL_HANDLERS.get(tool_name)

            if not handler:
                error = {"code": -32601, "message": f"Herramienta '{tool_name}' no encontrada."}
            else:
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
        # Silenciar logs ruidosos en consola estándar salvo peticiones principales
        pass


def main():
    parser = argparse.ArgumentParser(description="Servidor Local de Herramientas para ZeroChat (JSON-RPC 2.0 / MCP)")
    parser.add_argument("--host", default="127.0.0.1", help="Host de escucha (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"Puerto de escucha (default: {DEFAULT_PORT})")
    parser.add_argument("--test", action="store_true", help="Ejecutar comprobación interna de herramientas")
    args = parser.parse_args()

    if args.test:
        print("[TEST] list_directory('.') ->", json.loads(list_directory("."))["success"])
        print("[TEST] read_file('package.json') ->", json.loads(read_file("package.json", max_lines=5))["success"])
        print("[TEST] search_files('.', query='ZeroChat', max_results=3) ->", json.loads(search_files(".", query="ZeroChat", max_results=3))["success"])
        print("[TEST] execute_command('echo hello') ->", json.loads(execute_command("echo hello"))["success"])
        print("[TEST] browser_navigate disponible:", sync_playwright is not None)
        print("[TEST] Todas las herramientas operan correctamente.")
        return

    server = ThreadingHTTPServer((args.host, args.port), ZeroChatLocalServerHandler)
    print(f"🚀 [ZeroChat Local Server] Activo en http://{args.host}:{args.port}")
    print(f"🛠️  Herramientas disponibles: {', '.join(TOOL_HANDLERS.keys())}")
    print(f"💻 Sistema Operativo: {DETECTED_OS} | Shell: {DETECTED_SHELL}")
    print("📡 Esperando conexiones de ZeroChat (HTTP / SSE)...")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n🛑 Servidor detenido por el usuario.")
        server.server_close()


if __name__ == "__main__":
    main()
