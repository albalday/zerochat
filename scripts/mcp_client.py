#!/usr/bin/env python3
"""
Cliente MCP Stdio y Gestor de Procesos para ZeroChat.
Implementa el protocolo estándar Model Context Protocol (MCP) JSON-RPC 2.0
sobre procesos locales ejecutados por stdio (stdin/stdout).
"""

import os
import sys
import json
import time
import queue
import threading
import subprocess
from pathlib import Path


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

        self._running = False
        # Notificar a cualquier petición pendiente que el proceso terminó
        with self._lock:
            for req_id, (event, result_box) in list(self._pending.items()):
                result_box["error"] = "El proceso MCP terminó inesperadamente"
                event.set()
            self._pending.clear()

    def send_notification(self, method, params=None):
        """Envía una notificación JSON-RPC sin esperar respuesta."""
        if not self.is_running():
            raise RuntimeError("El proceso MCP no está en ejecución")
        payload = {
            "jsonrpc": "2.0",
            "method": method
        }
        if params is not None:
            payload["params"] = params
        data = json.dumps(payload) + "\n"
        with self._lock:
            self.process.stdin.write(data)
            self.process.stdin.flush()

    def send_request(self, method, params=None, timeout=15.0):
        """Envía una petición JSON-RPC y espera la respuesta sincrónicamente."""
        if not self.is_running():
            raise RuntimeError("El proceso MCP no está en ejecución")

        with self._lock:
            self._req_id += 1
            req_id = self._req_id
            event = threading.Event()
            result_box = {}
            self._pending[req_id] = (event, result_box)

            payload = {
                "jsonrpc": "2.0",
                "id": req_id,
                "method": method
            }
            if params is not None:
                payload["params"] = params
            data = json.dumps(payload) + "\n"
            self.process.stdin.write(data)
            self.process.stdin.flush()

        # Esperar respuesta
        signaled = event.wait(timeout=timeout)
        if not signaled:
            with self._lock:
                self._pending.pop(req_id, None)
            raise TimeoutError(f"Timeout esperando respuesta de MCP '{method}' ({timeout}s)")

        if "error" in result_box:
            raise RuntimeError(result_box["error"])

        resp = result_box.get("response", {})
        if "error" in resp:
            err = resp["error"]
            err_msg = err.get("message") if isinstance(err, dict) else str(err)
            raise RuntimeError(f"Error MCP [{err.get('code', -1)}]: {err_msg}")

        return resp.get("result", {})

    def list_tools(self, timeout=10.0):
        """Descubre las herramientas expuestas por el servidor MCP."""
        res = self.send_request("tools/list", {}, timeout=timeout)
        raw_tools = res.get("tools", [])
        self.tools = raw_tools if isinstance(raw_tools, list) else []
        return self.tools

    def call_tool(self, name, arguments=None, timeout=30.0):
        """Invoca una herramienta en el servidor MCP."""
        params = {
            "name": name,
            "arguments": arguments or {}
        }
        res = self.send_request("tools/call", params, timeout=timeout)
        return res

    def stop(self):
        """Detiene el proceso MCP limpiamente."""
        self._running = False
        if self.process:
            try:
                if self.process.stdin:
                    self.process.stdin.close()
            except Exception:
                pass
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
        self.clients = {}  # server_id -> StdioMcpClient
        self.errors = {}   # server_id -> error string

    def register_server_config(self, server_id, config):
        self.server_configs[server_id] = config

    def start_server(self, server_id, timeout=10.0):
        cfg = self.server_configs.get(server_id)
        if not cfg:
            raise KeyError(f"Servidor MCP '{server_id}' no encontrado en la configuración.")

        # Si ya está corriendo, devolver sus tools
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
        """Devuelve un mapa de todas las herramientas expuestas por servidores MCP activos."""
        all_tools = []
        for server_id, client in self.clients.items():
            if client.is_running():
                for t in client.tools:
                    tool_copy = dict(t)
                    # Namespace transparente: mcp__<server_id>__<tool_name>
                    orig_name = t.get("name", "")
                    namespaced_name = f"mcp__{server_id}__{orig_name}"
                    tool_copy["name"] = namespaced_name
                    tool_copy["original_name"] = orig_name
                    tool_copy["server_id"] = server_id
                    all_tools.append(tool_copy)
        return all_tools

    def call_tool(self, namespaced_name_or_original, arguments=None, timeout=30.0):
        """Resuelve el servidor responsable y llama a la herramienta."""
        # Comprobar si tiene prefijo mcp__<server_id>__<tool>
        if namespaced_name_or_original.startswith("mcp__"):
            parts = namespaced_name_or_original.split("__", 2)
            if len(parts) == 3:
                server_id = parts[1]
                orig_tool_name = parts[2]
                client = self.clients.get(server_id)
                if not client or not client.is_running():
                    raise RuntimeError(f"El servidor MCP '{server_id}' no está en ejecución.")
                return client.call_tool(orig_tool_name, arguments, timeout=timeout)

        # Si no tiene prefijo, buscar qué servidor activo la posee
        for server_id, client in self.clients.items():
            if client.is_running():
                for t in client.tools:
                    if t.get("name") == namespaced_name_or_original:
                        return client.call_tool(namespaced_name_or_original, arguments, timeout=timeout)

        raise KeyError(f"Herramienta MCP '{namespaced_name_or_original}' no encontrada en ningún servidor activo.")

