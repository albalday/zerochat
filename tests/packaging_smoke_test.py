#!/usr/bin/env python3
"""Verifica que el wheel instala solo el ejecutable y que instala los servicios MCP del catálogo de la interfaz.

La interfaz es la carpeta de este repositorio servida en local (--ui-url), y no GitHub Pages: la prueba corre antes de
que Pages publique la versión que se prueba."""

from __future__ import annotations

import datetime
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
# El catálogo se descarga en un hilo tras el arranque: margen para que termine.
CATALOG_WAIT_SECONDS = 15


class QuietFiles(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


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
        version = run(str(executable), "--version", cwd=temp_dir).stdout.strip()
        if not version.startswith("ZeroChat "):
            raise SystemExit(f"Salida de versión inesperada: {version!r}")
        static_root = run(str(python), "-c", "import zerochat; print(zerochat.get_static_root())", cwd=temp_dir).stdout.strip()
        if static_root != "None":
            raise SystemExit("El wheel no debe contener recursos web")

        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        home_dir = temp_dir / "home"
        session_token = "packaging-test-token"
        config_dir = home_dir / "zerochat" / "config"
        config_dir.mkdir(parents=True)
        (config_dir / "token.json").write_text(
            json.dumps({"token": session_token, "date": datetime.date.today().isoformat()}),
            encoding="utf-8",
        )
        env = os.environ.copy()
        if sys.platform.startswith("win"):
            env["USERPROFILE"] = str(home_dir)
        else:
            env["HOME"] = str(home_dir)
        interface = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietFiles, directory=str(REPO_ROOT)))
        threading.Thread(target=interface.serve_forever, daemon=True).start()
        ui_url = f"http://127.0.0.1:{interface.server_address[1]}/zerochat.html"
        process = subprocess.Popen(
            [str(executable), "--port", str(port), "--no-browser", "--keep-server", "--ui-url", ui_url],
            cwd=temp_dir,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                try:
                    request = urllib.request.Request(
                        f"http://127.0.0.1:{port}/",
                        data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": "zerochat/heartbeat", "params": {}}).encode(),
                        headers={"Content-Type": "application/json", "X-ZeroChat-Token": session_token},
                    )
                    with urllib.request.urlopen(request, timeout=1) as response:
                        if response.status == 200:
                            break
                except OSError:
                    if process.poll() is not None:
                        output, errors = process.communicate()
                        raise SystemExit(f"El paquete no inició el servidor local: {output} {errors}")
                    time.sleep(0.1)
            else:
                process.terminate()
                try:
                    output, errors = process.communicate(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    output, errors = process.communicate()
                raise SystemExit(f"El paquete no inició el servidor local: {output} {errors}")
            data_dir = home_dir / "zerochat"
            venv_python = data_dir / ".venv" / ("Scripts/python.exe" if sys.platform.startswith("win") else "bin/python")
            if not venv_python.is_file():
                raise SystemExit("El paquete no creó ~/zerochat/.venv para los MCP")
            example_service = data_dir / "services" / "ejemplo" / "service.json"
            catalog_deadline = time.monotonic() + CATALOG_WAIT_SECONDS
            while not example_service.is_file() and time.monotonic() < catalog_deadline:
                time.sleep(0.1)
            if not example_service.is_file():
                raise SystemExit("El paquete no instaló los servicios MCP del catálogo en ~/zerochat")
            if not (data_dir / "services" / "ejemplo" / "README.md").is_file():
                raise SystemExit("El paquete no instaló la guía del MCP de ejemplo")
            example_readme = (data_dir / "services" / "ejemplo" / "README.md").read_text(encoding="utf-8")
            if "services/ejemplo/README.md" not in example_readme:
                raise SystemExit("La guía del MCP de ejemplo no contiene el prompt de referencia")
            if not (data_dir / "services" / "ejemplo" / "installer.json.example").is_file():
                raise SystemExit("El paquete no instaló el ejemplo de installer.json")
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
            interface.shutdown()
            interface.server_close()
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


if __name__ == "__main__":
    main()
