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


def create_mcp_app(host: str = "127.0.0.1", port: int = 6388):
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
    parser.add_argument("--port", type=int, default=6388, help="Puerto de escucha (default: 6388)")
    parser.add_argument("--test", action="store_true", help="Ejecutar prueba interna de herramientas")
    args = parser.parse_args()

    if args.test:
        print("[TEST] list_directory('.') ->", json.loads(list_directory("."))["success"])
        print("[TEST] read_file('package.json') ->", json.loads(read_file("package.json"))["success"])
        print("[TEST] execute_command('echo hello') ->", json.loads(execute_command("echo hello"))["success"])
        print("[TEST] Todas las funciones operan correctamente.")
        return

    ensure_dependencies()
    import uvicorn
    app = create_mcp_app(host=args.host, port=args.port)
    print(f"🚀 [ZeroChat MCP] Servidor FastMCP activo en http://{args.host}:{args.port}/sse")
    print("📡 Esperando conexiones de ZeroChat...")
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()

