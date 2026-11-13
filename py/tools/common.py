"""Utilidades comunes de las herramientas locales: el resultado de error y la escritura atómica de archivos."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path


def _tool_error(message: str, **extra) -> str:
    """Serializa el resultado de error común de las herramientas locales."""
    return json.dumps({"success": False, "error": message, **extra}, ensure_ascii=False)


def _atomic_write_text(target: Path, text: str):
    """Sustituye el archivo de una vez para no dejarlo a medias si la escritura falla."""
    temp_path = target.with_suffix(target.suffix + f".tmp_{os.getpid()}_{time.time_ns()}")
    with open(temp_path, "w", encoding="utf-8") as f:
        f.write(text)
    temp_path.replace(target)
