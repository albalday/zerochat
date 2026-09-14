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
Servidor Local de Herramientas para ZeroChat con Soporte MCP Stdio.
Proporciona:
1. Herramientas locales básicas esenciales (list_directory, read_file, edit_file, execute_command).
2. Cliente y gestor MCP para arrancar y consumir servidores MCP externos por stdio (ej. Playwright).
3. Router unificado HTTP / JSON-RPC 2.0 para ZeroChat.

No requiere librerías externas (funciona con la librería estándar de Python).
Generado automáticamente por ZeroChat.
"""

import os
import sys
import json
import time
import queue
import argparse
import platform
import threading
import subprocess
from pathlib import Path
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

DEFAULT_PORT = ${port}


# ==============================================================================
# Cliente MCP Stdio y Gestor de Procesos
# ==============================================================================

class StdioMcpClient:
    """Cliente ligero para servidores MCP ejecutados como subprocesos por stdio."""

    def __init__(self, command, args=None, env=None, cwd=None):
        self.command = command
        self.args = list(args or [])
        self.env = env or os.environ.copy()
        self.cwd = cwd or os.getcwd()
        self.process = None
        self._req_id = 0
        self._pending = {}
        self._lock = threading.Lock()
        self._reader_thread = None
        self._running = False
        self.server_info = None
        self.tools = []

    def is_running(self):
        return self._running and self.process is not None and self.process.poll() is None

    def start(self, timeout=10.0):
        """Inicia el subproceso y realiza el handshake de inicialización MCP."""
        if self.is_running():
            return self.server_info

        cmd = [self.command] + self.args
        try:
            self.process = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
                cwd=self.cwd,
                env=self.env
            )
        except Exception as err:
            raise RuntimeError(f"Error al arrancar proceso MCP '{self.command}': {err}")

        self._running = True
        self._reader_thread = threading.Thread(target=self._read_stdout, daemon=True)
        self._reader_thread.start()

        # Handshake: initialize
        init_res = self.send_request("initialize", {
            "protocolVersion": "2024-11-05",
            "clientInfo": {
                "name": "ZeroChat-Python-Host",
                "version": "1.0.0"
            },
            "capabilities": {}
        }, timeout=timeout)

        self.server_info = init_res.get("serverInfo", {})

        # Handshake: notifications/initialized
        self.send_notification("notifications/initialized")
        return self.server_info

    def _read_stdout(self):
        """Lee líneas JSON-RPC de stdout y despierta las solicitudes pendientes."""
        while self._running and self.process and self.process.stdout:
            try:
                line = self.process.stdout.readline()
                if not line:
                    break
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
                        event, result_box = waiter
                        result_box["response"] = msg
                        event.set()
            except Exception:
                break

    def send_request(self, method, params=None, timeout=15.0):
        if not self.is_running():
            raise RuntimeError(f"El servidor MCP '{self.command}' no está en ejecución.")

        with self._lock:
            self._req_id += 1
            req_id = self._req_id
            event = threading.Event()
            result_box = {}
            self._pending[req_id] = (event, result_box)

        req_payload = {
            "jsonrpc": "2.0",
            "id": req_id,
            "method": method,
            "params": params or {}
        }
        line = json.dumps(req_payload) + "\\n"

        try:
            self.process.stdin.write(line)
            self.process.stdin.flush()
        except Exception as err:
            with self._lock:
                self._pending.pop(req_id, None)
            raise RuntimeError(f"Error escribiendo en stdin de '{self.command}': {err}")

        signaled = event.wait(timeout=timeout)
        if not signaled:
            with self._lock:
                self._pending.pop(req_id, None)
            raise TimeoutError(f"Timeout ({timeout}s) esperando respuesta de '{self.command}' para método '{method}'.")

        resp = result_box.get("response", {})
        if "error" in resp:
            err = resp["error"]
            raise RuntimeError(f"Error MCP [{err.get('code')}]: {err.get('message')}")

        return resp.get("result", {})

    def send_notification(self, method, params=None):
        if not self.is_running():
            return
        notif = {
            "jsonrpc": "2.0",
            "method": method,
            "params": params or {}
        }
        line = json.dumps(notif) + "\\n"
        try:
            self.process.stdin.write(line)
            self.process.stdin.flush()
        except Exception:
            pass

    def list_tools(self, timeout=10.0):
        res = self.send_request("tools/list", {}, timeout=timeout)
        self.tools = res.get("tools", [])
        return self.tools

    def call_tool(self, name, arguments=None, timeout=30.0):
        res = self.send_request("tools/call", {
            "name": name,
            "arguments": arguments or {}
        }, timeout=timeout)
        return res

    def stop(self):
        self._running = False
        if self.process:
            try:
                self.process.terminate()
                self.process.wait(timeout=2.0)
            except Exception:
                try:
                    self.process.kill()
                except Exception:
                    pass
            self.process = None
        self.tools = []


class McpProcessManager:
    """Gestiona múltiples servidores MCP externos y sus ciclos de vida."""

    def __init__(self, server_configs=None):
        self.server_configs = dict(server_configs or {})
        self.clients = {}
        self.errors = {}

    def register_server_config(self, server_id, config):
        self.server_configs[server_id] = config

    def start_server(self, server_id, timeout=10.0):
        cfg = self.server_configs.get(server_id)
        if not cfg:
            raise KeyError(f"Servidor MCP '{server_id}' no encontrado en la configuración.")

        client = self.clients.get(server_id)
        if client and client.is_running():
            return {
                "server_id": server_id,
                "status": "running",
                "tools": client.tools
            }

        command = cfg.get("command")
        args = cfg.get("args", [])
        cwd = cfg.get("cwd")
        env = cfg.get("env")

        client = StdioMcpClient(command, args=args, env=env, cwd=cwd)
        try:
            client.start(timeout=timeout)
            tools = client.list_tools(timeout=timeout)
            self.clients[server_id] = client
            self.errors.pop(server_id, None)
            return {
                "server_id": server_id,
                "status": "running",
                "tool_count": len(tools),
                "tools": tools
            }
        except Exception as err:
            self.errors[server_id] = str(err)
            client.stop()
            raise

    def stop_server(self, server_id):
        client = self.clients.pop(server_id, None)
        if client:
            client.stop()
        return {"server_id": server_id, "status": "stopped"}

    def stop_all(self):
        for sid in list(self.clients.keys()):
            self.stop_server(sid)

    def get_server_status(self, server_id):
        cfg = self.server_configs.get(server_id, {})
        client = self.clients.get(server_id)
        is_active = client.is_running() if client else False
        return {
            "id": server_id,
            "name": cfg.get("name", server_id),
            "command": cfg.get("command", ""),
            "status": "running" if is_active else "stopped",
            "tool_count": len(client.tools) if is_active else 0,
            "tools": client.tools if is_active else [],
            "error": self.errors.get(server_id)
        }

    def list_servers(self):
        return [self.get_server_status(sid) for sid in self.server_configs]

    def get_all_active_tools(self):
        all_tools = []
        for server_id, client in self.clients.items():
            if client.is_running():
                for t in client.tools:
                    tool_copy = dict(t)
                    orig_name = t.get("name", "")
                    namespaced_name = f"mcp__{server_id}__{orig_name}"
                    tool_copy["name"] = namespaced_name
                    tool_copy["original_name"] = orig_name
                    tool_copy["server_id"] = server_id
                    all_tools.append(tool_copy)
        return all_tools

    def call_tool(self, namespaced_name_or_original, arguments=None, timeout=30.0):
        if namespaced_name_or_original.startswith("mcp__"):
            parts = namespaced_name_or_original.split("__", 2)
            if len(parts) == 3:
                server_id = parts[1]
                orig_tool_name = parts[2]
                client = self.clients.get(server_id)
                if not client or not client.is_running():
                    raise RuntimeError(f"El servidor MCP '{server_id}' no está en ejecución.")
                return client.call_tool(orig_tool_name, arguments, timeout=timeout)

        for server_id, client in self.clients.items():
            if client.is_running():
                for t in client.tools:
                    if t.get("name") == namespaced_name_or_original:
                        return client.call_tool(namespaced_name_or_original, arguments, timeout=timeout)

        raise KeyError(f"Herramienta MCP '{namespaced_name_or_original}' no encontrada en ningún servidor activo.")


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
            content = content.encode("utf-8")[:safe_max_bytes].decode("utf-8", errors="ignore")
            truncated_bytes = True

        return json.dumps({
            "success": True,
            "path": str(target),
            "total_lines": total_lines,
            "start_line": safe_start_line,
            "lines_returned": len(selected_lines),
            "truncated": truncated_bytes or (end_idx < total_lines),
            "content": content
        }, ensure_ascii=False, indent=2)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)


def edit_file(path: str, content: str, mode: str = "write", target_content: str = None) -> str:
    """Crea, edita o reemplaza fragmentos en un archivo local de texto de forma segura."""
    try:
        target = Path(path).expanduser().resolve()
        target.parent.mkdir(parents=True, exist_ok=True)

        if mode == "write":
            with open(target, "w", encoding="utf-8") as f:
                f.write(content)
            return json.dumps({"success": True, "path": str(target), "mode": "write", "bytes_written": len(content.encode("utf-8"))}, ensure_ascii=False)

        elif mode == "append":
            with open(target, "a", encoding="utf-8") as f:
                f.write(content)
            return json.dumps({"success": True, "path": str(target), "mode": "append", "bytes_appended": len(content.encode("utf-8"))}, ensure_ascii=False)

        elif mode == "replace_chunk":
            if not target.exists():
                return json.dumps({"success": False, "error": f"El archivo '{path}' no existe para realizar reemplazo."}, ensure_ascii=False)
            if target_content is None:
                return json.dumps({"success": False, "error": "El parámetro 'target_content' es obligatorio cuando mode='replace_chunk'."}, ensure_ascii=False)

            with open(target, "r", encoding="utf-8", errors="replace") as f:
                original = f.read()

            if target_content not in original:
                return json.dumps({"success": False, "error": "El fragmento 'target_content' no se encontró en el archivo."}, ensure_ascii=False)

            count = original.count(target_content)
            if count > 1:
                return json.dumps({"success": False, "error": f"El fragmento 'target_content' aparece {count} veces. Debe ser único para reemplazo seguro."}, ensure_ascii=False)

            modified = original.replace(target_content, content, 1)
            with open(target, "w", encoding="utf-8") as f:
                f.write(modified)

            return json.dumps({"success": True, "path": str(target), "mode": "replace_chunk", "replacements": 1}, ensure_ascii=False)

        else:
            return json.dumps({"success": False, "error": f"Modo desconocido '{mode}'. Use 'write', 'append' o 'replace_chunk'."}, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)


DETECTED_OS = platform.system()
DETECTED_SHELL = os.environ.get("SHELL", "cmd.exe" if DETECTED_OS == "Windows" else "/bin/bash")


def execute_command(command: str, cwd: str = ".", timeout_seconds: int = 60) -> str:
    """Ejecuta un comando en la shell del sistema y captura stdout, stderr y código de retorno."""
    try:
        work_dir = Path(cwd).expanduser().resolve()
        if not work_dir.exists() or not work_dir.is_dir():
            return json.dumps({"success": False, "error": f"El directorio de trabajo '{cwd}' no existe o no es un directorio."}, ensure_ascii=False)

        safe_timeout = max(1, min(int(timeout_seconds), 300))
        use_shell = True
        shell_executable = DETECTED_SHELL if DETECTED_OS != "Windows" else None

        result = subprocess.run(
            command,
            cwd=str(work_dir),
            shell=use_shell,
            executable=shell_executable,
            capture_output=True,
            text=True,
            timeout=safe_timeout
        )

        return json.dumps({
            "success": (result.returncode == 0),
            "command": command,
            "returncode": result.returncode,
            "stdout": result.stdout,
            "stderr": result.stderr,
            "os_info": {
                "system": DETECTED_OS,
                "shell": DETECTED_SHELL,
                "cwd": str(work_dir)
            }
        }, ensure_ascii=False, indent=2)
    except subprocess.TimeoutExpired:
        return json.dumps({"success": False, "command": command, "error": f"Tiempo de ejecución excedido ({timeout_seconds}s)."}, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"success": False, "command": command, "error": str(e)}, ensure_ascii=False)


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
            self.wfile.write(b"event: endpoint\\r\\ndata: /\\r\\n\\r\\n")
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
            combined_tools = list(LOCAL_TOOLS_DEFINITIONS)
            mcp_tools = mcp_manager.get_all_active_tools()
            combined_tools.extend(mcp_tools)
            result = {
                "tools": combined_tools
            }
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
    parser.add_argument("--host", default="${host}", help="Host de escucha (default: ${host})")
    parser.add_argument("--port", type=int, default=${port}, help=f"Puerto de escucha (default: {DEFAULT_PORT})")
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
        print("\\n🛑 Deteniendo servidor y procesos MCP asociados...")
        mcp_manager.stop_all()
        server.server_close()


if __name__ == "__main__":
    main()
`;
  }  function sanitizePort(port) {
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
Servidor Local de Herramientas para ZeroChat con Soporte MCP Stdio.
Proporciona:
1. Herramientas locales básicas esenciales (list_directory, read_file, edit_file, execute_command).
2. Entorno de trabajo local controlado (.zerochat/mcp/) para servidores MCP externos (ej. Playwright).
3. Router unificado HTTP / JSON-RPC 2.0 para ZeroChat.

No requiere librerías externas (funciona con la librería estándar de Python).
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

# Rutas del entorno controlado .zerochat/mcp/
SCRIPT_DIR = Path(__file__).resolve().parent
MCP_DIR = Path.cwd() / ".zerochat" / "mcp"
CONFIG_FILE = MCP_DIR / "mcp_servers.json"
CLIENT_FILE = MCP_DIR / "mcp_client.py"

DEFAULT_PORT = ${port}


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
            content = content.encode("utf-8")[:safe_max_bytes].decode("utf-8", errors="ignore")
            truncated_bytes = True

        return json.dumps({
            "success": True,
            "path": str(target),
            "size_bytes": file_size,
            "total_lines": total_lines,
            "start_line": safe_start_line,
            "lines_returned": len(selected_lines),
            "truncated": truncated_bytes or (end_idx < total_lines),
            "content": content
        }, ensure_ascii=False, indent=2)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)


def edit_file(path: str, content: str, mode: str = "write", target_content: str = None) -> str:
    """Crea, edita o reemplaza fragmentos en un archivo local de texto de forma segura."""
    try:
        target = Path(path).expanduser().resolve()
        target.parent.mkdir(parents=True, exist_ok=True)

        if mode == "write":
            with open(target, "w", encoding="utf-8") as f:
                f.write(content)
            return json.dumps({"success": True, "path": str(target), "mode": "write", "bytes_written": len(content.encode("utf-8"))}, ensure_ascii=False)

        elif mode == "append":
            with open(target, "a", encoding="utf-8") as f:
                f.write(content)
            return json.dumps({"success": True, "path": str(target), "mode": "append", "bytes_appended": len(content.encode("utf-8"))}, ensure_ascii=False)

        elif mode == "replace_chunk":
            if not target.exists():
                return json.dumps({"success": False, "error": f"El archivo '{path}' no existe para realizar reemplazo."}, ensure_ascii=False)
            if target_content is None:
                return json.dumps({"success": False, "error": "El parámetro 'target_content' es obligatorio cuando mode='replace_chunk'."}, ensure_ascii=False)

            with open(target, "r", encoding="utf-8", errors="replace") as f:
                original = f.read()

            if target_content not in original:
                return json.dumps({"success": False, "error": "El fragmento 'target_content' no se encontró en el archivo."}, ensure_ascii=False)

            count = original.count(target_content)
            if count > 1:
                return json.dumps({"success": False, "error": f"El fragmento 'target_content' aparece {count} veces. Debe ser único para reemplazo seguro."}, ensure_ascii=False)

            modified = original.replace(target_content, content, 1)
            with open(target, "w", encoding="utf-8") as f:
                f.write(modified)

            return json.dumps({"success": True, "path": str(target), "mode": "replace_chunk", "replacements": 1}, ensure_ascii=False)

        else:
            return json.dumps({"success": False, "error": f"Modo desconocido '{mode}'. Use 'write', 'append' o 'replace_chunk'."}, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)


DETECTED_OS = platform.system()
DETECTED_SHELL = os.environ.get("SHELL", "cmd.exe" if DETECTED_OS == "Windows" else "/bin/bash")


def execute_command(command: str, cwd: str = ".", timeout_seconds: int = 60) -> str:
    """Ejecuta un comando en la shell del sistema y captura stdout, stderr y código de retorno."""
    try:
        work_dir = Path(cwd).expanduser().resolve()
        if not work_dir.exists() or not work_dir.is_dir():
            return json.dumps({"success": False, "error": f"El directorio de trabajo '{cwd}' no existe o no es un directorio."}, ensure_ascii=False)

        safe_timeout = max(1, min(int(timeout_seconds), 300))
        use_shell = True
        shell_executable = DETECTED_SHELL if DETECTED_OS != "Windows" else None

        result = subprocess.run(
            command,
            cwd=str(work_dir),
            shell=use_shell,
            executable=shell_executable,
            capture_output=True,
            text=True,
            timeout=safe_timeout
        )

        return json.dumps({
            "success": (result.returncode == 0),
            "command": command,
            "returncode": result.returncode,
            "stdout": result.stdout,
            "stderr": result.stderr,
            "os_info": {
                "system": DETECTED_OS,
                "shell": DETECTED_SHELL,
                "cwd": str(work_dir)
            }
        }, ensure_ascii=False, indent=2)
    except subprocess.TimeoutExpired:
        return json.dumps({"success": False, "command": command, "error": f"Tiempo de ejecución excedido ({timeout_seconds}s)."}, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"success": False, "command": command, "error": str(e)}, ensure_ascii=False)


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
# Servidores MCP Externos Configurados y Entorno Controlado (.zerochat/mcp/)
# ==============================================================================

DEFAULT_MCP_SERVERS = {
    "playwright": {
        "id": "playwright",
        "name": "Playwright Browser",
        "description": "Navegación web, interacción y capturas mediante Playwright MCP",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-playwright"],
        "cwd": str(MCP_DIR)
    }
}

mcp_manager_instance = None


def is_env_installed():
    return CLIENT_FILE.exists() and CONFIG_FILE.exists()


def load_server_configs():
    if CONFIG_FILE.exists():
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return dict(DEFAULT_MCP_SERVERS)


def save_server_configs(configs):
    MCP_DIR.mkdir(parents=True, exist_ok=True)
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(configs, f, indent=2, ensure_ascii=False)


def get_mcp_manager(force_reload=False):
    global mcp_manager_instance
    if mcp_manager_instance is not None and not force_reload:
        return mcp_manager_instance

    for d in [MCP_DIR, SCRIPT_DIR]:
        if str(d) not in sys.path:
            sys.path.insert(0, str(d))

    try:
        from mcp_client import StdioMcpClient, McpProcessManager
        configs = load_server_configs()
        mcp_manager_instance = McpProcessManager(configs)
        return mcp_manager_instance
    except ImportError:
        return None


def setup_mcp_environment(client_code=None):
    MCP_DIR.mkdir(parents=True, exist_ok=True)

    if not CLIENT_FILE.exists():
        if client_code:
            with open(CLIENT_FILE, "w", encoding="utf-8") as f:
                f.write(client_code)
        elif (SCRIPT_DIR / "mcp_client.py").exists():
            with open(SCRIPT_DIR / "mcp_client.py", "r", encoding="utf-8") as src:
                content = src.read()
            with open(CLIENT_FILE, "w", encoding="utf-8") as dst:
                dst.write(content)
        else:
            import urllib.request
            url = "https://raw.githubusercontent.com/albalday/zerochat/dev/scripts/mcp_client.py"
            try:
                with urllib.request.urlopen(url, timeout=15) as resp:
                    content = resp.read().decode("utf-8")
                with open(CLIENT_FILE, "w", encoding="utf-8") as dst:
                    dst.write(content)
            except Exception as e:
                url_master = "https://raw.githubusercontent.com/albalday/zerochat/master/scripts/mcp_client.py"
                try:
                    with urllib.request.urlopen(url_master, timeout=15) as resp:
                        content = resp.read().decode("utf-8")
                    with open(CLIENT_FILE, "w", encoding="utf-8") as dst:
                        dst.write(content)
                except Exception as e2:
                    raise RuntimeError(f"Error al descargar mcp_client.py: {e} / {e2}")

    if not CONFIG_FILE.exists():
        save_server_configs(DEFAULT_MCP_SERVERS)

    mgr = get_mcp_manager(force_reload=True)
    return {
        "success": True,
        "installed": True,
        "mcp_dir": str(MCP_DIR),
        "servers": mgr.list_servers() if mgr else []
    }


def save_mcp_server(server_dict):
    if not isinstance(server_dict, dict) or not server_dict.get("id"):
        raise ValueError("Configuración de servidor inválida: 'id' es requerido.")
    sid = server_dict["id"]
    if not server_dict.get("cwd"):
        server_dict["cwd"] = str(MCP_DIR)
    configs = load_server_configs()
    configs[sid] = server_dict
    save_server_configs(configs)
    mgr = get_mcp_manager()
    if mgr:
        mgr.register_server_config(sid, server_dict)
    return {
        "success": True,
        "server": mgr.get_server_status(sid) if mgr else server_dict,
        "servers": mgr.list_servers() if mgr else list(configs.values())
    }


def delete_mcp_server(server_id):
    if not server_id:
        raise ValueError("server_id es requerido.")
    configs = load_server_configs()
    configs.pop(server_id, None)
    save_server_configs(configs)
    mgr = get_mcp_manager()
    if mgr:
        mgr.unregister_server(server_id)
    return {
        "success": True,
        "servers": mgr.list_servers() if mgr else list(configs.values())
    }


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
            self.wfile.write(b"event: endpoint\\r\\ndata: /\\r\\n\\r\\n")
            self.wfile.flush()
            return

        if self.path == "/mcp/status":
            mgr = get_mcp_manager()
            res_data = json.dumps({
                "success": True,
                "installed": is_env_installed(),
                "mcp_dir": str(MCP_DIR),
                "servers": mgr.list_servers() if mgr else []
            }, ensure_ascii=False, indent=2).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(res_data)))
            self.send_cors_headers()
            self.end_headers()
            self.wfile.write(res_data)
            return

        if self.path == "/mcp/servers":
            mgr = get_mcp_manager()
            res_data = json.dumps({
                "success": True,
                "servers": mgr.list_servers() if mgr else []
            }, ensure_ascii=False, indent=2).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(res_data)))
            self.send_cors_headers()
            self.end_headers()
            self.wfile.write(res_data)
            return

        mgr = get_mcp_manager()
        active_mcp_tools = mgr.get_all_active_tools() if mgr else []
        res_data = json.dumps({
            "status": "active",
            "server": "ZeroChat Local Server",
            "version": "2.0.0",
            "local_tools_count": len(LOCAL_TOOLS_DEFINITIONS),
            "mcp_tools_count": len(active_mcp_tools),
            "total_tools_count": len(LOCAL_TOOLS_DEFINITIONS) + len(active_mcp_tools),
            "servers": mgr.list_servers() if mgr else [],
            "mcp_env": {
                "installed": is_env_installed(),
                "mcp_dir": str(MCP_DIR)
            },
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

        if self.path == "/mcp/status":
            mgr = get_mcp_manager()
            body = json.dumps({
                "success": True,
                "installed": is_env_installed(),
                "mcp_dir": str(MCP_DIR),
                "servers": mgr.list_servers() if mgr else []
            }).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_cors_headers()
            self.end_headers()
            self.wfile.write(body)
            return

        if self.path == "/mcp/setup_env":
            try:
                res = setup_mcp_environment(req.get("client_code"))
                body = json.dumps(res).encode("utf-8")
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

        if self.path == "/mcp/servers/save":
            try:
                srv = req.get("server") or req.get("config") or (req if req.get("id") else None)
                res = save_mcp_server(srv)
                body = json.dumps(res).encode("utf-8")
                self.send_response(200)
            except Exception as err:
                body = json.dumps({"success": False, "error": str(err)}).encode("utf-8")
                self.send_response(400)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_cors_headers()
            self.end_headers()
            self.wfile.write(body)
            return

        if self.path == "/mcp/servers/delete":
            try:
                sid = req.get("server_id")
                res = delete_mcp_server(sid)
                body = json.dumps(res).encode("utf-8")
                self.send_response(200)
            except Exception as err:
                body = json.dumps({"success": False, "error": str(err)}).encode("utf-8")
                self.send_response(400)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_cors_headers()
            self.end_headers()
            self.wfile.write(body)
            return

        if self.path == "/mcp/register":
            server_id = req.get("server_id")
            cfg = req.get("config", {})
            if not server_id:
                body = json.dumps({"success": False, "error": "server_id es obligatorio"}).encode("utf-8")
                self.send_response(400)
            else:
                mgr = get_mcp_manager()
                if mgr:
                    mgr.register_server_config(server_id, cfg)
                    body = json.dumps({"success": True, "server": mgr.get_server_status(server_id)}).encode("utf-8")
                else:
                    body = json.dumps({"success": True, "server": {"id": server_id, "status": "stopped"}}).encode("utf-8")
                self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_cors_headers()
            self.end_headers()
            self.wfile.write(body)
            return

        if self.path == "/mcp/start":
            server_id = req.get("server_id")
            mgr = get_mcp_manager()
            if not mgr:
                body = json.dumps({"success": False, "error": "Entorno MCP no inicializado. Ejecute /mcp/setup_env primero."}).encode("utf-8")
                self.send_response(400)
            else:
                if req.get("config"):
                    mgr.register_server_config(server_id, req.get("config"))
                try:
                    res = mgr.start_server(server_id)
                    body = json.dumps({"success": True, "server": mgr.get_server_status(server_id), "tools": res.get("tools", [])}).encode("utf-8")
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
            mgr = get_mcp_manager()
            if mgr:
                res = mgr.stop_server(server_id)
            else:
                res = {"server_id": server_id, "status": "stopped"}
            body = json.dumps({"success": True, "server": res}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_cors_headers()
            self.end_headers()
            self.wfile.write(body)
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
                    "version": "2.0.0"
                },
                "capabilities": {
                    "tools": {"listChanged": True}
                }
            }
        elif method == "tools/list":
            combined_tools = list(LOCAL_TOOLS_DEFINITIONS)
            mgr = get_mcp_manager()
            if mgr:
                combined_tools.extend(mgr.get_all_active_tools())
            result = {
                "tools": combined_tools
            }
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
                mgr = get_mcp_manager()
                if not mgr:
                    error = {"code": -32601, "message": f"Herramienta '{tool_name}' no encontrada."}
                else:
                    try:
                        mcp_res = mgr.call_tool(tool_name, tool_args)
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
        elif method == "mcp/status":
            mgr = get_mcp_manager()
            result = {
                "success": True,
                "installed": is_env_installed(),
                "mcp_dir": str(MCP_DIR),
                "servers": mgr.list_servers() if mgr else []
            }
        elif method == "mcp/setup_env":
            try:
                result = setup_mcp_environment(params.get("client_code"))
            except Exception as ex:
                error = {"code": -32000, "message": str(ex)}
        elif method == "mcp/servers/save":
            try:
                srv = params.get("server") or params.get("config") or (params if params.get("id") else None)
                result = save_mcp_server(srv)
            except Exception as ex:
                error = {"code": -32602, "message": str(ex)}
        elif method == "mcp/servers/delete":
            try:
                sid = params.get("server_id")
                result = delete_mcp_server(sid)
            except Exception as ex:
                error = {"code": -32602, "message": str(ex)}
        elif method == "mcp/servers":
            mgr = get_mcp_manager()
            result = {"servers": mgr.list_servers() if mgr else []}
        elif method == "mcp/start":
            mgr = get_mcp_manager()
            if not mgr:
                error = {"code": -32000, "message": "Entorno MCP no inicializado."}
            else:
                sid = params.get("server_id")
                try:
                    res = mgr.start_server(sid)
                    result = {"success": True, "server": mgr.get_server_status(sid), "tools": res.get("tools", [])}
                except Exception as ex:
                    error = {"code": -32000, "message": str(ex)}
        elif method == "mcp/stop":
            mgr = get_mcp_manager()
            if not mgr:
                result = {"success": True, "server": {"server_id": params.get("server_id"), "status": "stopped"}}
            else:
                sid = params.get("server_id")
                res = mgr.stop_server(sid)
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
    parser.add_argument("--host", default="${host}", help="Host de escucha (default: ${host})")
    parser.add_argument("--port", type=int, default=${port}, help=f"Puerto de escucha (default: {DEFAULT_PORT})")
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
    print(f"🔌 Directorio de trabajo MCP: {MCP_DIR}")
    print(f"💻 Sistema Operativo: {DETECTED_OS} | Shell: {DETECTED_SHELL}")
    print("📡 Esperando conexiones de ZeroChat (HTTP / SSE)...")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\\n🛑 Deteniendo servidor y procesos MCP asociados...")
        mgr = get_mcp_manager()
        if mgr:
            mgr.stop_all()
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

  function renderExternalServers(container, servers, isConnected, translator = t) {
    if (!container) return;
    if (!isConnected) {
      container.innerHTML = `<div class="mcp-servers-empty label-hint">${escapeHtml(translator('mcp_tools_empty_disconnected'))}</div>`;
      return;
    }
    if (!Array.isArray(servers) || servers.length === 0) {
      container.innerHTML = `<div class="mcp-servers-empty label-hint">${escapeHtml(translator('mcp_servers_empty'))}</div>`;
      return;
    }

    container.innerHTML = servers.map(server => {
      const isRunning = server.status === 'running';
      const statusText = escapeHtml(isRunning ? translator('mcp_server_status_running') : translator('mcp_server_status_stopped'));
      const btnText = escapeHtml(isRunning ? translator('mcp_btn_stop_server') : translator('mcp_btn_start_server'));
      const toolCount = server.tool_count || (server.tools ? server.tools.length : 0);
      const toolCountHtml = isRunning && toolCount > 0 ? `<span class="mcp-server-tool-count">${escapeHtml(translator('mcp_servers_count_tools', { count: toolCount }))}</span>` : '';
      const desc = escapeHtml(server.description || server.command || '');
      const err = server.error ? `<p class="mcp-server-error">${escapeHtml(server.error)}</p>` : '';

      return `
        <div class="mcp-server-item" data-server-id="${escapeHtml(server.id)}">
          <div class="mcp-server-info">
            <div class="mcp-server-title-row">
              <strong class="mcp-server-name">${escapeHtml(server.name || server.id)}</strong>
              <span class="mcp-server-badge status-${isRunning ? 'running' : 'stopped'}">${statusText}</span>
              ${toolCountHtml}
            </div>
            ${desc ? `<p class="mcp-server-desc">${desc}</p>` : ''}
            ${err}
          </div>
          <div class="mcp-server-actions">
            <button type="button" class="btn-mcp-server-toggle ${isRunning ? 'btn-danger' : 'btn-secondary'}" data-server-id="${escapeHtml(server.id)}" data-action="${isRunning ? 'stop' : 'start'}">
              ${btnText}
            </button>
          </div>
        </div>`;
    }).join('');

    container.querySelectorAll?.('.btn-mcp-server-toggle').forEach(btn => {
      btn.addEventListener?.('click', async () => {
        const sid = btn.getAttribute?.('data-server-id');
        const act = btn.getAttribute?.('data-action');
        if (!sid) return;
        btn.disabled = true;
        const MCP = getMCP();
        try {
          if (act === 'start') {
            await MCP?.manager?.startExternalServer?.(sid);
          } else {
            await MCP?.manager?.stopExternalServer?.(sid);
          }
          const updated = await MCP?.manager?.fetchExternalServers?.();
          renderExternalServers(container, updated?.servers || [], true, translator);

          const toolsContainer = typeof document !== 'undefined' ? document.getElementById('mcp-tools-container') : null;
          if (toolsContainer) {
            const currentConfig = getConfig()?.get?.() || {};
            const st = getState()?.get?.('mcp') || {};
            renderToolsList(toolsContainer, st.tools || [], currentConfig.enabledTools || {}, translator);
          }
        } catch (e) {
          console.error('[MCP UI] Error toggling server:', e);
        } finally {
          btn.disabled = false;
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

    const serversListEl = elements.serversList || (typeof document !== 'undefined' ? document.getElementById('mcp-servers-list') : null);
    if (serversListEl) {
      renderExternalServers(serversListEl, isConn ? (state.servers || []) : [], isConn, translator);
      if (isConn && (!state.servers || state.servers.length === 0)) {
        const MCP = getMCP();
        MCP?.manager?.fetchExternalServers?.().then(res => {
          if (res && res.servers) {
            renderExternalServers(serversListEl, res.servers, true, translator);
          }
        }).catch(() => {});
      }
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
      syncExternalServers();
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

    function syncExternalServers() {
      const serversListEl = elements.mcpSetupDialog?.querySelector?.('#mcp-servers-list') || (typeof document !== 'undefined' ? document.getElementById('mcp-servers-list') : null);
      if (serversListEl) {
        const st = State?.get?.('mcp') || {};
        const isConn = st.status === 'connected';
        renderExternalServers(serversListEl, isConn ? (st.servers || []) : [], isConn, t);
        if (isConn) {
          MCP?.manager?.fetchExternalServers?.().then(res => {
            if (res && res.servers) {
              renderExternalServers(serversListEl, res.servers, true, t);
            }
          }).catch(() => {});
        }
      }
    }

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

    function persistMcpAutoConnect(enabled, host = null, port = null) {
      const Config = getConfig();
      if (!Config) return;
      const patch = { mcpAutoConnect: enabled === true };
      if (host) patch.mcpHost = host;
      if (port) patch.mcpPort = sanitizePort(port);
      (Config.updateRuntime || Config.update)?.call(Config, patch);
    }

    elements.btnCopyCmd?.addEventListener?.('click', () => {
      const operatingSystem = getOsInput()?.value || DEFAULT_OPERATING_SYSTEM;
      const cmd = generateClipboardCommand(elements.portInput?.value, operatingSystem, t);
      copyCommandToClipboard(cmd, elements.btnCopyCmd, t);
    });

    elements.btnConnect?.addEventListener?.('click', async () => {
      const host = elements.hostInput?.value || DEFAULT_HOST;
      const port = sanitizePort(elements.portInput?.value || DEFAULT_PORT);
      persistMcpAutoConnect(true, host, port);
      await MCP?.manager?.connectProxy?.({ host, port, endpoint: buildMcpEndpoint(host, port) });
    });

    elements.btnDisconnect?.addEventListener?.('click', () => {
      persistMcpAutoConnect(false);
      MCP?.manager?.disconnectProxy?.();
    });

    const unsubscribe = State?.subscribe?.('mcp', (newState) => {
      if (newState?.status === 'connected') {
        persistMcpAutoConnect(true, newState.host, newState.port);
      }
      renderConnectionStatus(elements, newState, t);
    });
    renderConnectionStatus(elements, State?.get?.('mcp'), t);
    updateCommandAndEndpoint();
    syncSecurityControls();

    const handleLanguageChange = () => {
      renderConnectionStatus(elements, State?.get?.('mcp'), t);
      renderSavedAuthorizations(elements, t);
      syncExternalServers();
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
      syncExternalServers,
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

      <!-- Servidores MCP Externos (stdio) -->
      <div class="mcp-servers-card" id="mcp-servers-card">
        <div class="mcp-servers-header">
          <span class="mcp-servers-icon">
            <svg class="ui-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-plug"></use></svg>
          </span>
          <div>
            <strong data-i18n="mcp_servers_section_title">Servidores MCP Externos</strong>
            <p class="label-hint mcp-section-hint" data-i18n="mcp_servers_desc">
              Servidores stdio gestionados por el servidor local (ej. Playwright para navegación web).
            </p>
          </div>
        </div>
        <div id="mcp-servers-list" class="mcp-servers-list"></div>
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
    renderExternalServers,
    initMcpUI,
    autoConnectIfAvailable,
    ensureDialogMarkup,
    getMcpSetupDialogHTML
  };
});
