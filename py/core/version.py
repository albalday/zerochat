"""Versiones del backend y de la interfaz, y direcciones desde las que se publican."""

from __future__ import annotations

import importlib.metadata
import json
import re
from pathlib import Path

SOURCE_BACKEND_VERSION = "10.14.0"


def _read_source_version(filename: str) -> str | None:
    """Lee la versión de un archivo del repositorio cuando se ejecuta desde fuentes."""
    try:
        version_file = Path(__file__).resolve().parent / filename
        if version_file.is_file():
            content = version_file.read_text(encoding="utf-8")
            match = re.search(r'version\s*=\s*"([0-9]+\.[0-9]+\.[0-9]+)"', content)
            if match:
                return match.group(1)
    except (OSError, re.error):
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
    except (OSError, json.JSONDecodeError):
        pass
    return BACKEND_PACKAGE_VERSION


def compatibility_version(version: str) -> str:
    """La interfaz y el backend son compatibles si comparten major.minor."""
    parts = version.split(".")
    return ".".join(parts[:2]) if len(parts) >= 2 else version


BACKEND_PACKAGE_VERSION = _read_backend_version()
VERSION = compatibility_version(BACKEND_PACKAGE_VERSION)
UI_VERSION = _read_ui_version()
DEFAULT_UI_URL = "https://albalday.github.io/zerochat/zerochat.html"
REMOTE_SCRIPT_URL = "https://raw.githubusercontent.com/albalday/zerochat/master/zerochat.py"
