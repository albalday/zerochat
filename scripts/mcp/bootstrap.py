#!/usr/bin/env python3
"""Bootstrap y host descargable de servicios MCP externos para ZeroChat.

Descarga y verifica la release de servicios externos si no está presente o
requiere actualización, y ejecuta el bucle de control stdio de servicios.
"""
from __future__ import annotations

import argparse
import atexit
import hashlib
import json
import os
import queue
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

MAX_LINE_BYTES = 16 * 1024 * 1024


def download(source_url, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(source_url, timeout=30) as response:
        data = response.read(2 * 1024 * 1024 + 1)
    if len(data) > 2 * 1024 * 1024:
        raise RuntimeError("Downloaded bootstrap artifact is too large")
    destination.write_bytes(data)


def download_release(source_url, release):
    manifest_path = release / "release.json"
    download(source_url.rstrip("/") + "/release.json", manifest_path)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("schemaVersion") != 1 or not isinstance(manifest.get("files"), list):
        raise RuntimeError("Invalid external MCP release manifest")
    for item in manifest["files"]:
        relative = Path(str(item.get("path", "")))
        target = (release / relative).resolve()
        if not relative.parts or relative.is_absolute() or release.resolve() not in target.parents:
            raise RuntimeError("Unsafe external MCP release path")
        download(source_url.rstrip("/") + "/" + relative.as_posix(), target)
        if hashlib.sha256(target.read_bytes()).hexdigest() != item.get("sha256"):
            raise RuntimeError("External MCP release integrity check failed")


def validate_mcp_source_url(url: str) -> None:
    """Valida que la URL de release para servicios MCP externos provenga de un origen seguro."""
    if not url or not isinstance(url, str):
        raise RuntimeError("URL de release MCP no válida")
    url_lower = url.lower()
    if url_lower.startswith("https://albalday.github.io/zerochat/"):
        return
    if url_lower.startswith("http://127.0.0.1:") or url_lower.startswith("http://localhost:"):
        return
    raise RuntimeError(f"Origen de descarga MCP no autorizado: {url}")


def public_tool_name(server_id, original):
    """Same injective, lowercase wire encoding as js/mcp.js publicToolName."""
    def encode(value, tool=False):
        if not isinstance(value, str) or not value or len(value) > 256:
            raise ValueError("Invalid MCP name component")
        return "".join(ch if ("a" <= ch <= "y" or "0" <= ch <= "9" or (tool and ch == "_"))
                       else f"z{ord(ch):x}z" for ch in value)
    name = f"mcp_{encode(server_id)}_{encode(original, True)}"
    if len(name) > 64:
        raise ValueError("MCP public name exceeds 64 characters")
    return name


class StdioClient:
    def __init__(self, command, args, cwd, env):
        self.command, self.args, self.cwd, self.env = command, list(args), cwd, env
        self.process = None
        self.tools, self.info = [], {}
        self._pending, self._lock, self._next = {}, threading.Lock(), 0
        self._alive = False

    def running(self):
        return self._alive and self.process and self.process.poll() is None

    def start(self, timeout=30):
        self.process = subprocess.Popen([self.command, *self.args], stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1,
            cwd=self.cwd, env=self.env, start_new_session=True)
        self._alive = True
        threading.Thread(target=self._read, daemon=True).start()
        threading.Thread(target=self._drain_stderr, daemon=True).start()
        self.info = self.request("initialize", {
            "protocolVersion": "2024-11-05", "clientInfo": {"name": "ZeroChat external host", "version": "1"}, "capabilities": {}
        }, timeout).get("serverInfo", {})
        self.notify("notifications/initialized")
        self.tools = self.request("tools/list", {}, timeout).get("tools", [])
        if not isinstance(self.tools, list):
            self.tools = []

    def _drain_stderr(self):
        if self.process and self.process.stderr:
            for _ in self.process.stderr:
                pass

    def _read(self):
        try:
            for line in self.process.stdout:
                if len(line.encode("utf-8")) > MAX_LINE_BYTES:
                    continue
                try:
                    message = json.loads(line)
                except (TypeError, ValueError):
                    continue
                request_id = message.get("id")
                if request_id is not None:
                    with self._lock:
                        waiter = self._pending.pop(request_id, None)
                    if waiter:
                        waiter.put(message)
        finally:
            self._alive = False
            with self._lock:
                pending = list(self._pending.values())
                self._pending.clear()
            for waiter in pending:
                waiter.put({"error": {"message": "MCP process ended unexpectedly"}})

    def request(self, method, params, timeout=30):
        if not self.running():
            raise RuntimeError("MCP process is not running")
        with self._lock:
            self._next += 1
            request_id = self._next
            waiter = queue.Queue(maxsize=1)
            self._pending[request_id] = waiter
            self.process.stdin.write(json.dumps({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}) + "\n")
            self.process.stdin.flush()
        try:
            response = waiter.get(timeout=timeout)
        except queue.Empty as exc:
            with self._lock:
                self._pending.pop(request_id, None)
            raise TimeoutError(f"MCP request timed out: {method}") from exc
        if response.get("error"):
            raise RuntimeError(str(response["error"].get("message", "MCP request failed")))
        return response.get("result", {})

    def notify(self, method):
        if self.running():
            with self._lock:
                self.process.stdin.write(json.dumps({"jsonrpc": "2.0", "method": method}) + "\n")
                self.process.stdin.flush()

    def stop(self):
        self._alive = False
        if not self.process:
            return
        try:
            self.process.terminate()
            self.process.wait(timeout=3)
        except (OSError, subprocess.TimeoutExpired):
            try:
                self.process.kill()
            except OSError:
                pass
        self.process = None
        self.tools = []


class ExternalHost:
    def __init__(self, home, services_root):
        self.home, self.services_root = Path(home), Path(services_root)
        self.clients, self.errors, self.states = {}, {}, {}
        self.config_path = self.home / "config" / "services.json"
        self.config_path.parent.mkdir(parents=True, exist_ok=True)
        self.services = self._load_services()
        self.preferences = self._load_preferences()

    def _load_json(self, path):
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)

    def _load_services(self):
        servers = {}
        if not self.services_root.is_dir():
            raise RuntimeError("External MCP services directory is missing")
        for directory in sorted(self.services_root.glob("*.mcp")):
            if not directory.is_dir():
                continue
            server = self._load_json(directory / "service.json")
            server_id = server.get("id")
            if not isinstance(server_id, str) or not server_id or directory.name != f"{server_id}.mcp":
                raise RuntimeError("Invalid external MCP server id")
            server["_directory"] = directory
            servers[server_id] = server
        return servers

    def _load_preferences(self):
        try:
            value = self._load_json(self.config_path)
            return value if isinstance(value, dict) else {}
        except FileNotFoundError:
            return {}

    def _save_preferences(self):
        temporary = self.config_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(self.preferences, indent=2), encoding="utf-8")
        temporary.replace(self.config_path)

    def _service(self, server_id):
        if server_id not in self.services:
            raise KeyError("Unknown external MCP server")
        return self.services[server_id]

    def list_servers(self):
        result = []
        for server_id, server in self.services.items():
            client = self.clients.get(server_id)
            running = bool(client and client.running())
            pref = self.preferences.get(server_id, {})
            result.append({
                "id": server_id, "displayName": server.get("displayName", {}),
                "description": server.get("description", {}), "enabled": pref.get("enabled", server.get("enabledByDefault", False)),
                "status": "running" if running else self.states.get(server_id, "available"),
                "installed": (self.home / "services" / server_id / "current" / "installation.json").exists(),
                "toolCount": len(client.tools) if running else 0, "error": self.errors.get(server_id),
                "options": server.get("options", []),
                "userOptions": pref.get("options", {})
            })
        return result

    def configure(self, server_id, enabled=None, options=None):
        self._service(server_id)
        if enabled is not None and not isinstance(enabled, bool):
            raise ValueError("enabled must be boolean")
        if options is not None and not isinstance(options, dict):
            raise ValueError("options must be an object")
        entry = self.preferences.setdefault(server_id, {})
        if enabled is not None:
            entry["enabled"] = enabled
        if options is not None:
            opts = entry.setdefault("options", {})
            opts.update(options)
        self._save_preferences()
        return self.list_servers()

    def _expand(self, value, values):
        if not isinstance(value, str):
            raise ValueError("Invalid process argument")
        for key, replacement in values.items():
            value = value.replace("${" + key + "}", str(replacement))
        if "${" in value:
            raise ValueError("Unknown process variable")
        return value

    def _prepare_service(self, server_id, server):
        service_dir = self.home / "services" / server_id / "current"
        service_dir.mkdir(parents=True, exist_ok=True)
        marker = service_dir / "installation.json"
        if not marker.exists():
            self.states[server_id] = "installing"
            installer = self._load_json(server["_directory"] / "installer.json")
            kind = installer.get("type", "npm")
            installation = {"type": kind}
            if kind == "npm":
                product = installer.get("product", {})
                package = product.get("package")
                version = product.get("version")
                if not isinstance(package, str) or not isinstance(version, str):
                    raise RuntimeError("Npm installer must define an exact package version")
                node, npm = shutil.which("node"), shutil.which("npm")
                if not node or not npm:
                    raise RuntimeError("Node.js 18 or newer and npm are required to install this MCP service")
                manifest = service_dir / "package.json"
                manifest.write_text(json.dumps({"private": True, "dependencies": {package: version}}, indent=2), encoding="utf-8")
                subprocess.run([npm, "install", "--ignore-scripts", "--no-audit", "--no-fund"], cwd=service_dir, check=True, timeout=600)
                installation.update({"nodeExecutable": node, "package": package, "version": version})
                browser = product.get("browser")
                if browser is not None:
                    if browser not in ("chrome", "chromium", "firefox", "webkit"):
                        raise RuntimeError("Unsupported Playwright browser distribution")
                    playwright_cli = service_dir / "node_modules" / "playwright" / "cli.js"
                    if not playwright_cli.is_file():
                        raise RuntimeError("Playwright browser installer is unavailable")
                    subprocess.run([node, str(playwright_cli), "install", browser], cwd=service_dir, check=True, timeout=600)
                    installation["browser"] = browser
            elif kind != "none":
                raise RuntimeError("Unsupported MCP service installer")
            marker.write_text(json.dumps(installation), encoding="utf-8")
        else:
            installer = self._load_json(server["_directory"] / "installer.json")
            product = installer.get("product", {}) if installer.get("type") == "npm" else {}
            browser = product.get("browser")
            if browser is not None:
                if browser not in ("chrome", "chromium", "firefox", "webkit"):
                    raise RuntimeError("Unsupported Playwright browser distribution")
                installation = self._load_json(marker)
                if installation.get("browser") != browser:
                    node = shutil.which("node")
                    playwright_cli = service_dir / "node_modules" / "playwright" / "cli.js"
                    if not node or not playwright_cli.is_file():
                        raise RuntimeError("Playwright browser installer is unavailable")
                    self.states[server_id] = "installing"
                    subprocess.run([node, str(playwright_cli), "install", browser], cwd=service_dir, check=True, timeout=600)
                    installation["browser"] = browser
                    marker.write_text(json.dumps(installation), encoding="utf-8")
        node = shutil.which("node")
        return {
            "serviceDir": service_dir,
            "serviceSourceDir": server["_directory"],
            "nodeExecutable": node or "",
            "pythonExecutable": sys.executable
        }

    def start(self, server_id):
        server = self._service(server_id)
        current = self.clients.get(server_id)
        if current and current.running():
            return self.list_servers()
        self.states[server_id] = "starting"
        try:
            values = self._prepare_service(server_id, server)
            pref = self.preferences.get(server_id, {})
            user_opts = pref.get("options", {})
            for opt in server.get("options", []):
                opt_id = opt.get("id")
                if not opt_id:
                    continue
                val = user_opts.get(opt_id, opt.get("default"))
                values[f"option:{opt_id}"] = str(val)

            launch = server.get("launch", {})
            command = self._expand(launch.get("executable"), values)
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
            env.update({key: self._expand(value, values) for key, value in launch.get("env", {}).items()})
            client = StdioClient(command, args, str(values["serviceDir"]), env)
            client.start(int(launch.get("handshakeTimeoutSeconds", 30)))
            self.clients[server_id] = client
            self.states[server_id] = "running"
            self.errors.pop(server_id, None)
        except Exception as exc:
            self.states[server_id] = "needs_attention"
            self.errors[server_id] = str(exc)
        return self.list_servers()

    def stop(self, server_id):
        self._service(server_id)
        client = self.clients.pop(server_id, None)
        if client:
            client.stop()
        self.states[server_id] = "stopped"
        return self.list_servers()

    def tools(self):
        tools = []
        for server_id, client in self.clients.items():
            if client.running():
                for tool in client.tools:
                    copy = dict(tool)
                    original = copy.get("name", "")
                    copy["name"] = public_tool_name(server_id, original)
                    if any(item["name"] == copy["name"] for item in tools):
                        raise ValueError("Duplicate MCP public name")
                    copy["metadata"] = {"mcpServerId": server_id, "originalName": original}
                    tools.append(copy)
        return tools

    def call(self, name, arguments):
        # Resolve only advertised names; never infer a target by splitting input.
        for tool in self.tools():
            if tool["name"] == name:
                metadata = tool["metadata"]
                client = self.clients[metadata["mcpServerId"]]
                return client.request("tools/call", {"name": metadata["originalName"], "arguments": arguments or {}})
        raise KeyError("Unknown external MCP tool")

    def close(self):
        for client in list(self.clients.values()):
            client.stop()


def emit(message):
    sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    parser = argparse.ArgumentParser(description="ZeroChat External MCP Bootstrap and Stdio Host")
    parser.add_argument("--home", required=True)
    parser.add_argument("--source-url", required=True)
    options = parser.parse_args()
    validate_mcp_source_url(options.source_url)
    home = Path(options.home).expanduser().resolve()
    release = home / "releases" / "active"
    services = release / "services"
    release.mkdir(parents=True, exist_ok=True)
    download_release(options.source_url, release)
    if not services.is_dir():
        raise RuntimeError("External MCP release is incomplete")

    host = ExternalHost(home, services)
    atexit.register(host.close)
    try:
        for raw in sys.stdin:
            request = None
            if len(raw.encode("utf-8")) > MAX_LINE_BYTES:
                emit({"ok": False, "error": "Control message too large"})
                continue
            try:
                request = json.loads(raw)
                command, request_id = request.get("command"), request.get("requestId")
                if command == "status": result = {"host": "running", "servers": host.list_servers()}
                elif command == "list": result = {"servers": host.list_servers()}
                elif command == "configure": result = {"servers": host.configure(request["serverId"], enabled=request.get("enabled"), options=request.get("options"))}
                elif command == "start": result = {"servers": host.start(request["serverId"])}
                elif command == "stop": result = {"servers": host.stop(request["serverId"])}
                elif command == "tools/list": result = {"tools": host.tools()}
                elif command == "tools/call": result = host.call(request["name"], request.get("arguments", {}))
                elif command == "shutdown": emit({"requestId": request_id, "ok": True, "result": {}}); break
                else: raise ValueError("Unknown external host command")
                emit({"requestId": request_id, "ok": True, "result": result})
            except Exception as exc:
                emit({"requestId": request.get("requestId") if isinstance(request, dict) else None, "ok": False, "error": str(exc)})
    finally:
        host.close()


if __name__ == "__main__":
    main()

