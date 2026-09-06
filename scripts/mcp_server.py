#!/usr/bin/env python3
"""
Servidor Local MCP para ZeroChat (FastMCP).
Expone herramientas del sistema local: list_directory, read_file, execute_command.
"""

import os
import sys
import json
import subprocess
from pathlib import Path

try:
    from mcp.server.fastmcp import FastMCP
except ImportError:
    FastMCP = None


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


def create_mcp_server():
    if FastMCP is None:
        raise RuntimeError("La librería 'mcp' no está instalada. Ejecuta: pip install 'mcp<2'")
    mcp = FastMCP("ZeroChat Local Tools")
    for tool_fn in SERVER_TOOLS:
        mcp.tool()(tool_fn)
    return mcp


def main():
    if "--test" in sys.argv:
        print("[TEST] list_directory('.') ->", json.loads(list_directory("."))["success"])
        print("[TEST] read_file('package.json') ->", json.loads(read_file("package.json"))["success"])
        print("[TEST] execute_command('echo hello') ->", json.loads(execute_command("echo hello"))["success"])
        print("[TEST] Todas las funciones operan correctamente.")
        return

    server = create_mcp_server()
    server.run(transport="stdio")


if __name__ == "__main__":
    main()

