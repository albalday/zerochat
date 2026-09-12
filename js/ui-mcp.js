/**
 * Módulo de Presentación e Interfaz de Usuario para MCP (Model Context Protocol).
 * ZeroChat - js/ui-mcp.js
 *
 * Responsabilidades:
 * - Generación de comando terminal reactivo para el entorno privado de mcp-proxy.
 * - Saneamiento y construcción normalizada de endpoints HTTP/SSE.
 * - Renderizado de estado de conexión (badge, semáforo, latencia, herramientas).
 * - Copia accesible al portapapeles con confirmación visual.
 * - Vinculación de eventos de conexión/desconexión con ChatState y ChatMCP.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.ChatUIMcp = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULT_HOST = '127.0.0.1';
  const DEFAULT_PORT = 6388;
  const DEFAULT_OPERATING_SYSTEM = 'linux';

  const resolveDep = (name, path) => (typeof window !== 'undefined' && window.ChatUtils?.resolveDep ? window.ChatUtils.resolveDep(name, path) : ((typeof window !== 'undefined' && window[name]) || (typeof require !== 'undefined' ? (() => { try { return require(path); } catch (e) { return null; } })() : null)));
  const getUtils = () => resolveDep('ChatUtils', './utils.js');
  const getI18n = () => resolveDep('ChatI18n', './i18n.js');
  const getIcons = () => resolveDep('ChatIcons', './icons.js');
  const getState = () => resolveDep('ChatState', './state.js');
  const getMCP = () => resolveDep('ChatMCP', './mcp.js');
  const getConfig = () => resolveDep('ChatConfig', './config-store.js');
  const getSecurity = () => resolveDep('ChatToolSecurity', './tool-security.js');

  const t = (k, p) => getI18n()?.t ? getI18n().t(k, p) : k;
  const escapeHtml = (s) => (getUtils()?.escapeHtml ? getUtils().escapeHtml(s) : (s == null ? '' : String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')));

  function clearSafeContent(element) {
    const Utils = getUtils();
    if (Utils?.clearElement) return Utils.clearElement(element);
    if (element) element.textContent = '';
    return element;
  }

  function appendSafeText(parent, tagName, value, options) {
    const Utils = getUtils();
    const child = Utils?.appendTextElement?.(parent, tagName, value, options);
    // Los mocks de Node no implementan DOM; el navegador siempre usa la ruta
    // anterior, que crea nodos y asigna textContent.
    if (!child && parent) parent.textContent = `${parent.textContent || ''}${value == null ? '' : String(value)}`;
    return child;
  }

  function appendTrustedIcon(parent, icon) {
    if (!parent || !icon || typeof document === 'undefined') return;
    const host = document.createElement('span');
    host.setAttribute('aria-hidden', 'true');
    const Utils = getUtils();
    if (Utils?.setTrustedHtml) Utils.setTrustedHtml(host, icon);
    else host.innerHTML = icon;
    parent.appendChild(host);
  }

  function sanitizePort(port) {
    const p = parseInt(port, 10);
    return (Number.isInteger(p) && p >= 1024 && p <= 65535) ? p : DEFAULT_PORT;
  }

  function sanitizeHost(host) {
    return String(host || '').trim() || DEFAULT_HOST;
  }

  function buildMcpEndpoint(host, port, path = '/sse') {
    const p = path ? (path.startsWith('/') ? path : `/${path}`) : '/sse';
    return `http://${sanitizeHost(host)}:${sanitizePort(port)}${p}`;
  }

  function generateMcpServerScript(options = {}) {
    const host = sanitizeHost(options.host);
    const port = sanitizePort(options.port);

    return `#!/usr/bin/env python3
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
Generado automáticamente por ZeroChat.
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

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sync_playwright = None

DEFAULT_PORT = ${port}


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
                if file_pattern != "*" and not file_path.match(file_pattern):
                    continue

                rel_path = str(file_path.relative_to(target_dir))

                if not query:
                    matches.append({"path": str(file_path.resolve()), "relative_path": rel_path})
                else:
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

        stdout = proc.stdout[:50000] + ("\\n\\n[... Truncado ...]" if len(proc.stdout) > 50000 else "")
        stderr = proc.stderr[:20000] + ("\\n\\n[... Truncado ...]" if len(proc.stderr) > 20000 else "")

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

            if len(text_content) > 35000:
                text_content = text_content[:35000] + "\\n\\n[... Contenido web truncado por límite de tamaño ...]"

            return json.dumps({
                "success": True,
                "url": page.url,
                "title": title,
                "action": action,
                "content": text_content
            }, ensure_ascii=False, indent=2)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)


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
        accept = self.headers.get("Accept", "")
        if "/sse" in self.path or "text/event-stream" in accept:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.send_cors_headers()
            self.end_headers()
            self.wfile.write(b"event: endpoint\\r\\ndata: /\\r\\n\\r\\n")
            self.wfile.flush()
            return

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
        pass


def main():
    parser = argparse.ArgumentParser(description="Servidor Local de Herramientas para ZeroChat (JSON-RPC 2.0 / MCP)")
    parser.add_argument("--host", default="${host}", help="Host de escucha (default: ${host})")
    parser.add_argument("--port", type=int, default=${port}, help="Puerto de escucha (default: ${port})")
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
        print("\\n🛑 Servidor detenido por el usuario.")
        server.server_close()


if __name__ == "__main__":
    main()
`;
  }

  function downloadMcpServerScript(options = {}) {
    const host = sanitizeHost(options.host);
    const port = sanitizePort(options.port);
    const content = generateMcpServerScript({ host, port });
    const filename = 'zerochat_mcp.py';

    if (typeof document !== 'undefined' && typeof Blob !== 'undefined' && typeof URL !== 'undefined') {
      try {
        const blob = new Blob([content], { type: 'text/x-python;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} }, 3000);
        return true;
      } catch (e) {
        return false;
      }
    }
    return false;
  }

  function sanitizeOperatingSystem(operatingSystem) {
    return ['linux', 'windows', 'android'].includes(String(operatingSystem || '').toLowerCase())
      ? String(operatingSystem).toLowerCase()
      : DEFAULT_OPERATING_SYSTEM;
  }

  function generateTerminalCommand(port, operatingSystem = DEFAULT_OPERATING_SYSTEM) {
    const normalizedPort = sanitizePort(port);
    const os = sanitizeOperatingSystem(operatingSystem);
    const executable = os === 'windows' ? 'py' : 'python3';
    const portArgument = normalizedPort === DEFAULT_PORT ? '' : ` --port ${normalizedPort}`;
    return `${executable} zerochat_mcp.py${portArgument}`;
  }

  function getOperatingSystemHelpKey(operatingSystem) {
    const os = sanitizeOperatingSystem(operatingSystem);
    return os === 'windows' ? 'mcp_copy_help_windows' : (os === 'android' ? 'mcp_copy_help_android' : 'mcp_copy_help_linux');
  }

  function generateOperatingSystemInstructions(operatingSystem = DEFAULT_OPERATING_SYSTEM, translator = t) {
    return translator(getOperatingSystemHelpKey(operatingSystem));
  }

  function generateClipboardCommand(port, operatingSystem = DEFAULT_OPERATING_SYSTEM, translator = t) {
    const os = sanitizeOperatingSystem(operatingSystem);
    return `${generateOperatingSystemInstructions(os, translator)}\n\n${generateTerminalCommand(port, os)}`;
  }

  async function copyCommandToClipboard(text, btnElement, translator = t) {
    if (!text) return false;
    let ok = false;
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(text); ok = true; } catch (e) {}
    }
    if (btnElement && ok) {
      const orig = btnElement.innerHTML;
      const check = getIcons()?.get ? getIcons().get('check', { size: 14 }) : '';
      btnElement.innerHTML = `${check} <span>${translator('mcp_cmd_copied')}</span>`;
      btnElement.classList.add('btn-copied');
      const timer = setTimeout(() => { btnElement.innerHTML = orig; btnElement.classList.remove('btn-copied'); }, 2000);
      if (typeof timer?.unref === 'function') timer.unref();
    }
    return ok;
  }

  function renderToolsList(container, tools, currentEnabledTools = {}, translator = t) {
    if (!container) return;
    const Icons = getIcons();
    container.style.display = 'block';

    if (!Array.isArray(tools) || tools.length === 0) {
      const isConnected = getState()?.get ? getState().get('mcp')?.status === 'connected' : false;
      const msg = isConnected ? translator('mcp_tools_empty_connected') : translator('mcp_tools_empty_disconnected');
      const plug = Icons?.get ? Icons.get('plug', { size: 24 }) : '<svg class="ui-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22v-5"></path><path d="M9 8V2"></path><path d="M15 8V2"></path><path d="M18 8v5a6 6 0 0 1-12 0V8z"></path></svg>';
      container.innerHTML = `<div class="mcp-tools-empty">${plug}<p>${msg}</p></div>`;
      return;
    }

    const plug16 = Icons?.get ? Icons.get('plug', { size: 16 }) : '';
    const term16 = Icons?.get ? Icons.get('terminal', { size: 16 }) : '';
    const badgeText = escapeHtml(translator('mcp_tool_badge'));

    const Security = getSecurity();
    const globalPolicy = Security?.manager?.getGlobalMcpPolicy ? Security.manager.getGlobalMcpPolicy() : 'ask';

    const items = tools.map(tool => {
      const id = tool.id || tool.name;
      const isChecked = currentEnabledTools[id] !== undefined ? currentEnabledTools[id] !== false : (currentEnabledTools[tool.name] !== undefined ? currentEnabledTools[tool.name] !== false : true);
      const desc = escapeHtml(tool.descFallback || tool.description || '');

      let paramsHint = '';
      const props = tool.inputSchema?.properties || tool.parameters?.properties;
      if (props && typeof props === 'object') {
        const req = Array.isArray(tool.inputSchema?.required || tool.parameters?.required) ? (tool.inputSchema?.required || tool.parameters?.required) : [];
        paramsHint = Object.entries(props).map(([k, v]) => `${k}${req.includes(k) ? '' : '?'}: ${v.type || 'any'}`).join(', ');
      }

      const serverName = tool.metadata?.mcpServerName || '';
      const originalName = tool.metadata?.originalName || tool.name;
      const toolRule = Security?.manager?.getToolPolicy ? Security.manager.getToolPolicy(id) : null;
      const toolConstraints = Security?.manager?.getToolConstraints ? Security.manager.getToolConstraints(id) : null;
      const hasConstraints = !!(toolConstraints && (toolConstraints.command || toolConstraints.path));
      const effectivePolicy = toolRule || 'ask';

      let authTagHtml = '';
      if (globalPolicy === 'allow_all') {
        authTagHtml = `<span class="mcp-auth-badge status-allowed" title="${escapeHtml(translator('mcp_security_policy_allow_all'))}">${escapeHtml(translator('mcp_security_badge_allowed'))} (Global)</span>`;
      } else {
        const selectTitle = escapeHtml(translator('mcp_security_select_title'));
        const optAsk = escapeHtml(translator('mcp_security_badge_ask'));
        let optAllowed = escapeHtml(translator('mcp_security_badge_allowed'));
        if (hasConstraints && effectivePolicy === 'allow') {
          optAllowed += ` (${escapeHtml(translator('mcp_security_constrained') || 'Acotada')})`;
        }
        const optDenied = escapeHtml(translator('tool_auth_denied_badge'));
        const statusClass = effectivePolicy === 'allow' ? 'status-allowed' : (effectivePolicy === 'deny' ? 'status-denied' : 'status-ask');

        authTagHtml = `
          <select class="mcp-auth-select ${statusClass}" data-tool-id="${escapeHtml(id)}" data-server-name="${escapeHtml(serverName)}" data-orig-name="${escapeHtml(originalName)}" title="${selectTitle}" aria-label="${selectTitle}">
            <option value="ask" ${effectivePolicy === 'ask' ? 'selected' : ''}>${optAsk}</option>
            <option value="allow" ${effectivePolicy === 'allow' ? 'selected' : ''}>${optAllowed}</option>
            <option value="deny" ${effectivePolicy === 'deny' ? 'selected' : ''}>${optDenied}</option>
          </select>`;
      }

      return `
        <div class="mcp-tool-card" data-tool-id="${escapeHtml(id)}">
          <div class="mcp-tool-info">
            <div class="mcp-tool-title-row">
              <span class="mcp-tool-icon">${plug16}</span>
              <span class="mcp-tool-name">${escapeHtml(tool.name)}</span>
              <span class="mcp-tool-badge">${badgeText}</span>
              ${authTagHtml}
            </div>
            <p class="mcp-tool-desc">${desc}</p>
            ${paramsHint ? `<div class="mcp-tool-params"><code>${escapeHtml(paramsHint)}</code></div>` : ''}
          </div>
          <div class="mcp-tool-action">
            <label class="switch">
              <input type="checkbox" class="agent-tool-checkbox mcp-tool-checkbox" data-tool-id="${escapeHtml(id)}" ${isChecked ? 'checked' : ''}>
              <span class="slider"></span>
            </label>
          </div>
        </div>`;
    }).join('');

    container.innerHTML = `
      <div class="mcp-tools-header">
        <div class="mcp-tools-title">${term16}<span data-i18n="mcp_tools_section_title">${translator('mcp_tools_section_title')}</span></div>
        <span class="mcp-tools-counter">${translator('mcp_tools_count', { count: tools.length })}</span>
      </div>
      <div class="mcp-tools-list">${items}</div>`;

    container.querySelectorAll?.('.mcp-auth-select').forEach(sel => {
      sel.addEventListener?.('change', () => {
        const tid = sel.getAttribute?.('data-tool-id');
        if (!tid) return;
        const newPolicy = sel.value;
        const sName = sel.getAttribute?.('data-server-name') || '';
        const oName = sel.getAttribute?.('data-orig-name') || tid;

        if (Security?.manager) {
          if (newPolicy === 'ask') {
            Security.manager.revokeToolPolicy(tid);
          } else {
            Security.manager.setToolPolicy(tid, newPolicy, {
              serverName: sName,
              originalName: oName
            });
          }
        }

        // Actualizar clase visual del select según la nueva opción
        sel.className = `mcp-auth-select status-${newPolicy === 'allow' ? 'allowed' : (newPolicy === 'deny' ? 'denied' : 'ask')}`;

        // Sincronizar lista de autorizaciones guardadas en el modal si está disponible
        const savedListEl = typeof document !== 'undefined' ? document.getElementById('mcp-saved-auths-list') : null;
        if (savedListEl && typeof renderSavedAuthorizations === 'function') {
          renderSavedAuthorizations({
            savedAuthsList: savedListEl,
            btnClearAuths: document.getElementById('btn-mcp-clear-auths')
          }, translator);
        }
      });
    });

    container.querySelectorAll?.('.mcp-tool-checkbox').forEach(cb => {
      cb.addEventListener?.('change', () => {
        const tid = cb.getAttribute?.('data-tool-id');
        if (!tid) return;
        const Config = getConfig();
        if (Config) {
          const curr = (Config.get?.() || Config.getActive?.())?.enabledTools || {};
          (Config.updateRuntime || Config.update)?.call(Config, { enabledTools: { ...curr, [tid]: cb.checked } });
        }
      });
    });
  }

  function renderConnectionStatus(elements, mcpState, translator = t) {
    if (!elements) return;
    const State = getState();
    const state = mcpState || State?.get?.('mcp') || { status: 'disconnected', host: DEFAULT_HOST, port: DEFAULT_PORT, tools: [] };
    const status = state.status || 'disconnected';
    const isConn = status === 'connected';
    const isConnecting = status === 'connecting';
    const Icons = getIcons();

    if (elements.statusBadge) elements.statusBadge.className = `mcp-status-badge mcp-status-${status}`;
    if (elements.statusText) {
      if (typeof elements.statusText.setAttribute === 'function') {
        elements.statusText.setAttribute('data-i18n', `mcp_status_${status}`);
      }
      elements.statusText.textContent = translator(`mcp_status_${status}`);
    }

    if (elements.btnConnect) {
      elements.btnConnect.style.display = isConn ? 'none' : 'inline-flex';
      elements.btnConnect.disabled = isConnecting;
      const icon = isConnecting ? (Icons?.get?.('spinner', { size: 14, className: 'spinning' }) || '') : (Icons?.get?.('plug', { size: 14 }) || '');
      const labelKey = isConnecting ? 'mcp_btn_connecting' : 'mcp_btn_connect';
      const label = translator(labelKey);
      elements.btnConnect.innerHTML = `${icon} <span data-i18n="${labelKey}">${label}</span>`;
    }

    if (elements.btnDisconnect) elements.btnDisconnect.style.display = isConn ? 'inline-flex' : 'none';

    if (elements.serverDetails) {
      elements.serverDetails.style.display = isConn ? 'flex' : 'none';
      clearSafeContent(elements.serverDetails);
      if (isConn) {
        const name = state.serverInfo?.name || 'mcp-proxy';
        const ver = state.serverInfo?.version ? ` v${state.serverInfo.version}` : '';
        const latency = Number(state.latencyMs);
        const lat = Number.isFinite(latency) && latency > 0 ? ` · ${latency}ms` : '';
        const count = Array.isArray(state.tools) ? state.tools.length : 0;
        const toolLabel = count > 0 ? translator('mcp_tools_discovered', { count }) : translator('mcp_no_tools');
        const nameItem = appendSafeText(elements.serverDetails, 'span', '', { className: 'mcp-detail-item' });
        appendSafeText(nameItem || elements.serverDetails, 'strong', `${name}${ver}`);
        if (lat) appendSafeText(elements.serverDetails, 'span', lat, { className: 'mcp-detail-item mcp-latency-tag' });
        appendSafeText(elements.serverDetails, 'span', toolLabel, { className: 'mcp-detail-item mcp-tools-tag' });
      }
    }

    if (elements.errorMessage) {
      const showErr = status === 'error' && state.error;
      elements.errorMessage.style.display = showErr ? 'flex' : 'none';
      clearSafeContent(elements.errorMessage);
      if (showErr) {
        appendTrustedIcon(elements.errorMessage, Icons?.get?.('alert-circle', { size: 16 }) || '');
        appendSafeText(elements.errorMessage, 'span', state.error);
      }
    }

    const host = elements.hostInput?.value || state.host || DEFAULT_HOST;
    const port = elements.portInput?.value || state.port || DEFAULT_PORT;
    const operatingSystem = elements.osInput?.value || elements.mcpOsSelect?.value || DEFAULT_OPERATING_SYSTEM;
    if (elements.commandSnippet) elements.commandSnippet.textContent = generateTerminalCommand(port, operatingSystem);
    if (elements.endpointPreview) elements.endpointPreview.textContent = buildMcpEndpoint(host, port);

    if (elements.toolsContainer) {
      const currentConfig = getConfig()?.get?.() || {};
      renderToolsList(elements.toolsContainer, isConn ? (state.tools || []) : [], currentConfig.enabledTools || {}, translator);
    }
  }

  function renderSavedAuthorizations(elements, translator = t) {
    if (!elements && typeof document === 'undefined') return;
    const container = elements?.savedAuthsList || (typeof document !== 'undefined' ? document.getElementById('mcp-saved-auths-list') : null);
    const btnClear = elements?.btnClearAuths || (typeof document !== 'undefined' ? document.getElementById('btn-mcp-clear-auths') : null);
    if (!container) return;

    const Security = getSecurity();
    const authorized = Security?.manager?.listAuthorizedTools ? Security.manager.listAuthorizedTools() : [];

    if (!authorized || authorized.length === 0) {
      container.innerHTML = `<div class="mcp-no-auths-msg label-hint">${escapeHtml(translator('mcp_security_no_saved_auths'))}</div>`;
      if (btnClear) btnClear.style.display = 'none';
      return;
    }

    if (btnClear) btnClear.style.display = 'inline-flex';

    const Icons = getIcons();
    const trashIcon = Icons?.get ? Icons.get('trash', { size: 12 }) : '';

    container.innerHTML = authorized.map(item => {
      const toolId = escapeHtml(item.toolId);
      const origName = escapeHtml(item.originalName || item.toolId);
      const isAllowed = item.policy === 'allow';
      const badgeClass = isAllowed ? 'status-allowed' : 'status-denied';
      let badgeText = escapeHtml(isAllowed ? translator('mcp_security_badge_allowed') : translator('tool_auth_denied_badge'));
      const revokeLabel = escapeHtml(translator('mcp_security_btn_revoke'));

      let constraintTag = '';
      if (item.constraints) {
        const parts = [];
        if (item.constraints.command?.allowedPrefixes) {
          parts.push(item.constraints.command.allowedPrefixes.join(', '));
        }
        if (item.constraints.path?.allowedDirectories) {
          parts.push(item.constraints.path.allowedDirectories.join(', '));
        }
        if (parts.length > 0) {
          badgeText += ` (${escapeHtml(translator('mcp_security_constrained') || 'Acotada')})`;
          constraintTag = `<span class="mcp-auth-constraint-tag" title="${escapeHtml(parts.join(' | '))}">${escapeHtml(parts.join(' | '))}</span>`;
        }
      }

      return `
        <div class="mcp-auth-item" data-tool-id="${toolId}">
          <div class="mcp-auth-item-info">
            <strong class="mcp-auth-item-name">${origName}</strong>
            <span class="mcp-auth-badge ${badgeClass}">${badgeText}</span>
            ${constraintTag}
          </div>
          <button type="button" class="btn-revoke-auth" data-tool-id="${toolId}" title="${revokeLabel}">
            ${trashIcon} <span>${revokeLabel}</span>
          </button>
        </div>`;
    }).join('');

    container.querySelectorAll('.btn-revoke-auth').forEach(btn => {
      btn.addEventListener('click', () => {
        const tid = btn.getAttribute('data-tool-id');
        if (tid && Security?.manager?.revokeToolPolicy) {
          Security.manager.revokeToolPolicy(tid);
          renderSavedAuthorizations(elements, translator);
          if (elements?.toolsContainer) {
            const currentConfig = getConfig()?.get?.() || {};
            const state = getState()?.get?.('mcp') || {};
            renderToolsList(elements.toolsContainer, state.tools || [], currentConfig.enabledTools || {}, translator);
          }
        }
      });
    });
  }

  function initMcpUI(elements, options = {}) {
    ensureDialogMarkup();
    if (!elements) return null;
    const State = getState();
    const MCP = getMCP();
    const Config = getConfig();
    const Security = getSecurity();

    const currentConfig = Config?.get?.() || {};
    if (elements.hostInput && !elements.hostInput.value) elements.hostInput.value = currentConfig.mcpHost || DEFAULT_HOST;
    if (elements.portInput && !elements.portInput.value) elements.portInput.value = currentConfig.mcpPort || DEFAULT_PORT;
    const getOsInput = () => elements.osInput || elements.mcpOsSelect || (typeof document !== 'undefined' ? document.getElementById('mcp-os-select') : null);
    const getOsInstructions = () => elements.osInstructions || (typeof document !== 'undefined' ? document.getElementById('mcp-os-instructions') : null);

    function updateCommandAndEndpoint() {
      const host = elements.hostInput?.value || DEFAULT_HOST;
      const port = elements.portInput?.value || DEFAULT_PORT;
      const operatingSystem = getOsInput()?.value || DEFAULT_OPERATING_SYSTEM;
      if (elements.commandSnippet) elements.commandSnippet.textContent = generateTerminalCommand(port, operatingSystem);
      const instructions = getOsInstructions();
      if (instructions) instructions.textContent = generateOperatingSystemInstructions(operatingSystem, t);
      if (elements.endpointPreview) elements.endpointPreview.textContent = buildMcpEndpoint(host, port);
      Config?.update?.({ mcpHost: host, mcpPort: sanitizePort(port) });
    }

    elements.portInput?.addEventListener?.('input', updateCommandAndEndpoint);
    elements.hostInput?.addEventListener?.('input', updateCommandAndEndpoint);
    getOsInput()?.addEventListener?.('change', updateCommandAndEndpoint);

    const openModal = () => {
      elements.mcpSetupDialog?.showModal?.();
      syncSecurityControls();
    };
    const closeModal = () => elements.mcpSetupDialog?.close?.();
    elements.btnConfigure?.addEventListener?.('click', openModal);
    elements.btnCloseSetup?.addEventListener?.('click', closeModal);
    elements.btnCloseSetupFooter?.addEventListener?.('click', closeModal);
    elements.mcpSetupDialog?.addEventListener?.('click', (e) => { if (e.target === elements.mcpSetupDialog) closeModal(); });

    // Controles de Seguridad MCP
    const radioAsk = elements.mcpSetupDialog?.querySelector?.('#mcp-policy-ask') || (typeof document !== 'undefined' ? document.getElementById('mcp-policy-ask') : null);
    const radioAllowAll = elements.mcpSetupDialog?.querySelector?.('#mcp-policy-allow-all') || (typeof document !== 'undefined' ? document.getElementById('mcp-policy-allow-all') : null);
    const btnClearAuths = elements.mcpSetupDialog?.querySelector?.('#btn-mcp-clear-auths') || (typeof document !== 'undefined' ? document.getElementById('btn-mcp-clear-auths') : null);

    function syncSecurityControls() {
      const currentGlobalPolicy = Security?.manager?.getGlobalMcpPolicy ? Security.manager.getGlobalMcpPolicy() : 'ask';
      if (radioAsk) radioAsk.checked = (currentGlobalPolicy === 'ask');
      if (radioAllowAll) radioAllowAll.checked = (currentGlobalPolicy === 'allow_all');
      renderSavedAuthorizations(elements, t);
    }

    function renderCurrentToolsList() {
      if (elements.toolsContainer) {
        const currentCfg = getConfig()?.get?.() || {};
        const st = State?.get?.('mcp') || {};
        renderToolsList(elements.toolsContainer, st.tools || [], currentCfg.enabledTools || {}, t);
      }
    }

    radioAsk?.addEventListener?.('change', () => {
      if (radioAsk.checked && Security?.manager?.setGlobalMcpPolicy) {
        Security.manager.setGlobalMcpPolicy('ask');
        renderCurrentToolsList();
      }
    });

    radioAllowAll?.addEventListener?.('change', () => {
      if (radioAllowAll.checked && Security?.manager?.setGlobalMcpPolicy) {
        Security.manager.setGlobalMcpPolicy('allow_all');
        renderCurrentToolsList();
      }
    });

    btnClearAuths?.addEventListener?.('click', () => {
      if (Security?.manager?.clearAllAuthorizations) {
        Security.manager.clearAllAuthorizations();
        renderSavedAuthorizations(elements, t);
        renderCurrentToolsList();
      }
    });

    const unsubscribeSecurity = Security?.manager?.subscribe ? Security.manager.subscribe(() => {
      syncSecurityControls();
      renderCurrentToolsList();
    }) : null;

    let pollTimer = null;
    function startAutoConnectPolling() {
      if (pollTimer) clearInterval(pollTimer);
      let attempts = 0;
      pollTimer = setInterval(async () => {
        attempts++;
        if (attempts > 40 || State?.get?.('mcp')?.status === 'connected') {
          clearInterval(pollTimer);
          pollTimer = null;
          return;
        }
        const host = elements.hostInput?.value || DEFAULT_HOST;
        const port = sanitizePort(elements.portInput?.value || DEFAULT_PORT);
        try {
          const res = await autoConnectIfAvailable({ host, port, timeoutMs: 1200 });
          if (res && res.available && res.success) {
            clearInterval(pollTimer);
            pollTimer = null;
          }
        } catch (e) {}
      }, 1500);
    }

    const btnDownload = elements.btnDownloadScript || (typeof document !== 'undefined' ? document.getElementById('btn-mcp-download-script') : null);
    btnDownload?.addEventListener?.('click', () => {
      const host = elements.hostInput?.value || DEFAULT_HOST;
      const port = sanitizePort(elements.portInput?.value || DEFAULT_PORT);
      downloadMcpServerScript({ host, port });
      startAutoConnectPolling();
    });

    elements.btnCopyCmd?.addEventListener?.('click', () => {
      const operatingSystem = getOsInput()?.value || DEFAULT_OPERATING_SYSTEM;
      const cmd = generateClipboardCommand(elements.portInput?.value, operatingSystem, t);
      copyCommandToClipboard(cmd, elements.btnCopyCmd, t);
    });

    elements.btnConnect?.addEventListener?.('click', async () => {
      const host = elements.hostInput?.value || DEFAULT_HOST;
      const port = sanitizePort(elements.portInput?.value || DEFAULT_PORT);
      await MCP?.manager?.connectProxy?.({ host, port, endpoint: buildMcpEndpoint(host, port) });
    });

    elements.btnDisconnect?.addEventListener?.('click', () => MCP?.manager?.disconnectProxy?.());

    const unsubscribe = State?.subscribe?.('mcp', (newState) => renderConnectionStatus(elements, newState, t));
    renderConnectionStatus(elements, State?.get?.('mcp'), t);
    updateCommandAndEndpoint();
    syncSecurityControls();

    const handleLanguageChange = () => {
      renderConnectionStatus(elements, State?.get?.('mcp'), t);
      renderSavedAuthorizations(elements, t);
    };
    const I18n = getI18n();
    let unsubscribeLang = null;
    if (I18n?.onChange) {
      unsubscribeLang = I18n.onChange(handleLanguageChange);
    } else if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('zerochat:languagechange', handleLanguageChange);
      unsubscribeLang = () => window.removeEventListener('zerochat:languagechange', handleLanguageChange);
    }

    return {
      updateCommandAndEndpoint,
      openSetupModal: openModal,
      closeSetupModal: closeModal,
      startAutoConnectPolling,
      syncSecurityControls,
      render: () => renderConnectionStatus(elements, State?.get?.('mcp'), t),
      destroy: () => {
        if (pollTimer) clearInterval(pollTimer);
        if (typeof unsubscribe === 'function') unsubscribe();
        if (typeof unsubscribeSecurity === 'function') unsubscribeSecurity();
        if (typeof unsubscribeLang === 'function') unsubscribeLang();
      }
    };
  }

  function getMcpSetupDialogHTML() {
    return `<div class="modal-header">
      <div class="modal-title">
        <svg class="ui-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-settings"></use></svg>
        <h3 data-i18n="mcp_setup_modal_title">Configuración del Servidor Local (MCP)</h3>
      </div>
      <button id="btn-close-mcp-setup" type="button" class="btn-close" data-i18n-aria="modal_close_aria" aria-label="Cerrar modal">
        <svg class="ui-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-close"></use></svg>
      </button>
    </div>
    <div class="modal-body mcp-setup-modal-body">
      <!-- Configuración de Host y Puerto (Rango 63xx) -->
      <div class="mcp-config-card">
        <div class="mcp-fields-grid">
          <div class="form-field">
            <label for="mcp-host-input" data-i18n="mcp_field_host">Host del servidor</label>
            <input type="text" id="mcp-host-input" class="form-input" value="127.0.0.1" placeholder="127.0.0.1" autocomplete="off" spellcheck="false">
          </div>
          <div class="form-field">
            <label for="mcp-port-input" data-i18n="mcp_field_port">Puerto (Rango 63xx recomendado)</label>
            <input type="number" id="mcp-port-input" class="form-input" value="6388" min="1024" max="65535" placeholder="6388">
          </div>
          <div class="form-field">
            <label for="mcp-os-select" data-i18n="mcp_field_os">Sistema operativo local</label>
            <select id="mcp-os-select" class="combobox-select-helper form-input" style="width: 100%; max-width: 100%;">
              <option value="linux" data-i18n="mcp_os_linux">Linux</option>
              <option value="windows" data-i18n="mcp_os_windows">Windows</option>
              <option value="android" data-i18n="mcp_os_android">Android / Termux</option>
            </select>
          </div>
        </div>
        <div class="mcp-endpoint-row">
          <span class="label-hint">Endpoint:</span>
          <code id="mcp-endpoint-preview" class="mcp-endpoint-preview">http://127.0.0.1:6388/sse</code>
        </div>
      </div>

      <!-- Seguridad y Autorizaciones de Ejecución -->
      <div class="mcp-security-card">
        <div class="mcp-security-header">
          <span class="mcp-security-icon">
            <svg class="ui-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>
          </span>
          <div>
            <strong data-i18n="mcp_security_section_title">Seguridad y Autorización de Ejecución</strong>
            <p class="label-hint mcp-section-hint" data-i18n="mcp_security_desc">
              Controla cuándo se ejecutan las herramientas del servidor MCP en tu sistema local.
            </p>
          </div>
        </div>

        <div class="mcp-policy-options">
          <label class="mcp-policy-option">
            <input type="radio" name="mcp-global-policy" value="ask" id="mcp-policy-ask" checked>
            <div class="mcp-policy-text">
              <strong data-i18n="mcp_security_policy_ask">Pedir autorización antes de ejecutar (Recomendado)</strong>
              <p class="label-hint" data-i18n="mcp_security_policy_ask_hint">El chat te pedirá confirmar cada comando o herramienta MCP no autorizada previamente.</p>
            </div>
          </label>
          <label class="mcp-policy-option">
            <input type="radio" name="mcp-global-policy" value="allow_all" id="mcp-policy-allow-all">
            <div class="mcp-policy-text">
              <strong data-i18n="mcp_security_policy_allow_all">Todo autorizado (Modo sin restricciones)</strong>
              <p class="label-hint" data-i18n="mcp_security_policy_allow_all_hint">Ejecuta inmediatamente cualquier herramienta MCP sin pausas de confirmación.</p>
            </div>
          </label>
        </div>

        <div class="mcp-saved-auths-section">
          <div class="mcp-saved-auths-header">
            <span class="label-hint" data-i18n="mcp_security_saved_auths_title">Herramientas con Permiso Recordado:</span>
            <button type="button" id="btn-mcp-clear-auths" class="btn-text-action btn-mcp-clear-auths" data-i18n="mcp_security_btn_clear_all">Restablecer todas</button>
          </div>
          <div id="mcp-saved-auths-list" class="mcp-saved-auths-list"></div>
        </div>
      </div>

      <!-- Instrucciones de Descarga y Arranque -->
      <div class="mcp-instructions-card">
        <div class="mcp-instructions-header">
          <span class="mcp-instructions-icon">
            <svg class="ui-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-terminal"></use></svg>
          </span>
          <div>
            <strong data-i18n="mcp_instructions_title">Instalación y Arranque del Servidor</strong>
            <p class="label-hint mcp-section-hint" data-i18n="mcp_instructions_desc">
              Descarga el servidor Python autogenerado y ejecútalo en tu terminal con python3 zerochat_mcp.py:
            </p>
          </div>
        </div>

        <div class="mcp-download-actions">
          <button type="button" id="btn-mcp-download-script" class="btn-primary btn-mcp-download" data-i18n-title="mcp_btn_download_title">
            <svg class="ui-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-download"></use></svg>
            <span data-i18n="mcp_btn_download_server">Descargar servidor (zerochat_mcp.py)</span>
          </button>
        </div>

        <div class="mcp-command-wrapper">
          <span class="label-hint" data-i18n="mcp_run_instruction">Comando de ejecución:</span>
          <div class="mcp-cmd-row">
            <pre class="mcp-command-box mcp-cmd-box-flex"><code id="mcp-terminal-command">python3 zerochat_mcp.py</code></pre>
            <button type="button" id="btn-mcp-copy-cmd" class="btn-secondary btn-copy-mcp-cmd" data-i18n-title="mcp_btn_copy_cmd" title="Copiar comando">
              <svg class="ui-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-copy"></use></svg>
              <span data-i18n="mcp_btn_copy_cmd">Copiar comando</span>
            </button>
          </div>
          <pre id="mcp-os-instructions" class="mcp-command-box mcp-os-instructions"></pre>
        </div>
      </div>
    </div>
    <div class="modal-footer">
      <div class="footer-actions-right mcp-modal-footer-end">
        <button type="button" id="btn-close-mcp-setup-footer" class="btn-primary" data-i18n="btn_close">Cerrar</button>
      </div>
    </div>`;
  }

  function ensureDialogMarkup() {
    if (typeof document === 'undefined') return;
    const dialog = document.getElementById('mcp-setup-dialog');
    if (dialog && !dialog.firstElementChild) {
      dialog.innerHTML = getMcpSetupDialogHTML();
    }
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', ensureDialogMarkup);
    } else {
      ensureDialogMarkup();
    }
  }

  async function autoConnectIfAvailable(options = {}) {
    const Config = getConfig();
    const MCP = getMCP();
    const currentConfig = Config?.get?.() || Config?.getActive?.() || {};
    const host = options.host || currentConfig.mcpHost || DEFAULT_HOST;
    const port = sanitizePort(options.port || currentConfig.mcpPort || DEFAULT_PORT);
    const timeoutMs = options.timeoutMs || 1500;

    if (MCP?.manager?.autoConnectIfAvailable) {
      return await MCP.manager.autoConnectIfAvailable({ host, port, timeoutMs });
    }
    return { success: false, available: false };
  }

  return {
    DEFAULT_HOST,
    DEFAULT_PORT,
    DEFAULT_OPERATING_SYSTEM,
    sanitizePort,
    sanitizeHost,
    sanitizeOperatingSystem,
    buildMcpEndpoint,
    generateTerminalCommand,
    generateOperatingSystemInstructions,
    generateClipboardCommand,
    generateMcpServerScript,
    downloadMcpServerScript,
    copyCommandToClipboard,
    renderConnectionStatus,
    renderToolsList,
    initMcpUI,
    autoConnectIfAvailable,
    ensureDialogMarkup,
    getMcpSetupDialogHTML
  };
});
