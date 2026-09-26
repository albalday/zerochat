#!/usr/bin/env python3
"""
ZeroChat - Backend Local Unificado y Gestor de Entorno

Proporciona:
1. Auto-creación del entorno MCP local `~/zerochat/.venv`.
2. Servidor local HTTP y Server-Sent Events (SSE) con autenticación estricta por token efímero.
3. Herramientas locales seguras: read_file, edit_file, list_directory, execute_command.
4. Apertura automática del navegador apuntando a zerochat.html con token en el fragmento hash.
"""

from __future__ import annotations

import argparse
import ast
import atexit
import datetime
import fnmatch
import hmac
import importlib.metadata
import json
import os
import platform
import queue
import re
import secrets
import shutil
import shlex
import signal
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.request
from urllib.parse import urlencode
import venv
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SOURCE_BACKEND_VERSION = "7.11.0"

def _read_source_version(filename: str) -> str | None:
    """Lee la versión de un archivo del repositorio cuando se ejecuta desde fuentes."""
    try:
        version_file = Path(__file__).resolve().parent / filename
        if version_file.is_file():
            content = version_file.read_text(encoding="utf-8")
            match = re.search(r'version\s*=\s*"([0-9]+\.[0-9]+\.[0-9]+)"', content)
            if match:
                return match.group(1)
    except Exception:
        pass
    return None


def _read_backend_version() -> str:
    """Devuelve la versión publicada del backend, sin depender de package.json instalado."""
    source_version = _read_source_version("pyproject.toml")
    if source_version:
        return source_version
    try:
        return importlib.metadata.version("zerochat")
    except importlib.metadata.PackageNotFoundError:
        return SOURCE_BACKEND_VERSION


def _read_ui_version() -> str:
    """Devuelve la versión de la interfaz cuando se ejecuta desde el repositorio."""
    try:
        pkg_path = Path(__file__).resolve().parent / "package.json"
        if pkg_path.is_file():
            data = json.loads(pkg_path.read_text(encoding="utf-8"))
            if isinstance(data.get("version"), str):
                return data["version"].strip()
    except Exception:
        pass
    return BACKEND_PACKAGE_VERSION


def compatibility_version(version: str) -> str:
    """La interfaz y el backend son compatibles si comparten major.minor."""
    parts = version.split(".")
    return ".".join(parts[:2]) if len(parts) >= 2 else version

BACKEND_PACKAGE_VERSION = _read_backend_version()
VERSION = compatibility_version(BACKEND_PACKAGE_VERSION)
UI_VERSION = _read_ui_version()
DEFAULT_PORT = 6388
DEFAULT_HOST = "127.0.0.1"
DEFAULT_UI_URL = "https://albalday.github.io/zerochat/zerochat.html"
REMOTE_VERSION_URL = "https://raw.githubusercontent.com/albalday/zerochat/master/package.json"
PYPI_VERSION_URL = "https://pypi.org/pypi/zerochat/json"
REMOTE_SCRIPT_URL = "https://raw.githubusercontent.com/albalday/zerochat/master/zerochat.py"
CONSOLE_STATUS_IDLE_SECONDS = 8.0
CONSOLE_CONTROL = None
NOTICES: list[str] = []
NOTICES_LOCK = threading.Lock()
