"""Utilidades comunes de las herramientas locales: el resultado de error, la escritura atómica de archivos y la
búsqueda de textos separados por | (check_command y search_files)."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path


def _tool_error(message: str, **extra) -> str:
    """Serializa el resultado de error común de las herramientas locales."""
    return json.dumps({"success": False, "error": message, **extra}, ensure_ascii=False)


def text_terms(query: str) -> tuple[str, ...]:
    """Textos de una consulta separados por | ('error|listening on'), en minúsculas y sin los vacíos."""
    return tuple(term.strip().lower() for term in query.split("|") if term.strip())


def line_matches(line: str, terms: tuple[str, ...]) -> bool:
    """Si la línea contiene alguno de los textos, sin distinguir mayúsculas. Es texto, no una expresión
    regular: el tiempo es lineal y ninguna entrada puede bloquear el servidor (re no suelta el GIL)."""
    lowered = line.lower()
    return any(term in lowered for term in terms)


def _atomic_write_text(target: Path, text: str):
    """Sustituye el archivo de una vez para no dejarlo a medias si la escritura falla."""
    temp_path = target.with_suffix(target.suffix + f".tmp_{os.getpid()}_{time.time_ns()}")
    with open(temp_path, "w", encoding="utf-8") as f:
        f.write(text)
    temp_path.replace(target)
