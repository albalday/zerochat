#!/usr/bin/env python3
"""Verifica que el wheel instala el comando y contiene la interfaz local."""

from __future__ import annotations

import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path


def run(*args: str, **kwargs):
    return subprocess.run(args, check=True, text=True, capture_output=True, **kwargs)


def main() -> None:
    dist_dir = Path(sys.argv[1] if len(sys.argv) > 1 else "dist")
    wheels = sorted(dist_dir.glob("zerochat-*.whl"))
    if len(wheels) != 1:
        raise SystemExit("Se esperaba exactamente un wheel de ZeroChat")

    temp_dir = Path(tempfile.mkdtemp(prefix="zerochat-wheel-"))
    try:
        venv_dir = temp_dir / "venv"
        run(sys.executable, "-m", "venv", str(venv_dir))
        python = venv_dir / ("Scripts/python.exe" if sys.platform.startswith("win") else "bin/python")
        executable = venv_dir / ("Scripts/zerochat.exe" if sys.platform.startswith("win") else "bin/zerochat")
        run(str(python), "-m", "pip", "install", "--no-deps", str(wheels[0]))
        version = run(str(executable), "--version").stdout.strip()
        if not version.startswith("ZeroChat "):
            raise SystemExit(f"Salida de versión inesperada: {version!r}")
        assets = run(str(python), "-c", "import zerochat; print(zerochat.get_static_root())").stdout.strip()
        if not (Path(assets) / "zerochat.html").is_file():
            raise SystemExit("El wheel no contiene zerochat.html")

        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        data_dir = temp_dir / "state"
        process = subprocess.Popen(
            [str(executable), "--port", str(port), "--token", "packaging-test-token", "--no-browser", "--no-exit-on-close"],
            cwd=temp_dir,
            env={**os.environ, "ZEROCHAT_DATA_DIR": str(data_dir)},
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            for _ in range(30):
                try:
                    with urllib.request.urlopen(f"http://127.0.0.1:{port}/zerochat.html", timeout=1) as response:
                        if response.status == 200:
                            break
                except OSError:
                    time.sleep(0.1)
            else:
                output, errors = process.communicate(timeout=1)
                raise SystemExit(f"El paquete no sirvió la interfaz local: {output} {errors}")
            if (temp_dir / "zerochat").exists():
                raise SystemExit("El paquete creó un venv en el directorio de trabajo")
            if not (data_dir / "services" / "dummy_mcp" / "service.json").is_file():
                raise SystemExit("El paquete no inicializó los servicios MCP en su directorio de estado")
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


if __name__ == "__main__":
    main()
