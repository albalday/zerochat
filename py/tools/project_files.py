"""Navegador de ficheros del proyecto para la interfaz: lista, lee y descarga sin salir de su carpeta.

Lo usa la persona, no el modelo: lo limita la carpeta del proyecto de la petición, no el motor de permisos.
"""

from __future__ import annotations

import base64
import codecs
import os
from pathlib import Path

from security.context import SecurityContext

# Entradas de una carpeta en una respuesta: una carpeta con más (node_modules) avisa de las que faltan.
MAX_LIST_ENTRIES = 2000
# Bytes del comienzo que deciden si un fichero es texto: un byte nulo o un UTF-8 no válido lo hacen binario.
TEXT_SNIFF_BYTES = 8192
# Un texto más grande no se abre en una pestaña: se descarga.
MAX_TEXT_VIEW_BYTES = 2 * 1024 * 1024
DOWNLOAD_PAGE_BYTES = 512 * 1024
MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024


def _project_root(ctx: SecurityContext) -> Path:
    return ctx.workspace_dir.resolve()


def _inside(ctx: SecurityContext, path) -> tuple[Path, Path]:
    """La ruta pedida, resuelta con sus enlaces simbólicos, y la raíz; ValueError si sale de la carpeta del proyecto."""
    root = _project_root(ctx)
    if path in (None, ""):
        return root, root
    if not isinstance(path, str):
        raise ValueError("path debe ser una cadena.")
    target = ctx.absolute(path)
    if target != root and root not in target.parents:
        raise ValueError("La ruta queda fuera de la carpeta del proyecto.")
    return target, root


def _relative(target: Path, root: Path) -> str:
    return "" if target == root else target.relative_to(root).as_posix()


def list_project_dir(params: dict, ctx: SecurityContext) -> dict:
    """Carpetas primero y después ficheros, por nombre, con su tamaño y fecha; como mucho MAX_LIST_ENTRIES."""
    target, root = _inside(ctx, params.get("path"))
    if not target.is_dir():
        raise ValueError("La carpeta no existe.")
    entries = []
    with os.scandir(target) as items:
        for item in items:
            try:
                is_dir = item.is_dir()
                info = item.stat()
            except OSError:
                continue
            entries.append({
                "name": item.name,
                "type": "dir" if is_dir else "file",
                "size": None if is_dir else info.st_size,
                "modified": int(info.st_mtime * 1000),
            })
    entries.sort(key=lambda entry: (entry["type"] != "dir", entry["name"].lower(), entry["name"]))
    return {
        "path": _relative(target, root),
        "entries": entries[:MAX_LIST_ENTRIES],
        "total": len(entries),
        "truncated": len(entries) > MAX_LIST_ENTRIES,
    }


def _regular_file(params: dict, ctx: SecurityContext) -> tuple[Path, Path]:
    target, root = _inside(ctx, params.get("path"))
    if not target.is_file():
        raise ValueError("El fichero no existe.")
    return target, root


def read_project_file(params: dict, ctx: SecurityContext) -> dict:
    """El texto de un fichero, o que es binario o demasiado grande para abrirlo (entonces se descarga)."""
    target, root = _regular_file(params, ctx)
    size = target.stat().st_size
    result = {"path": _relative(target, root), "size": size}
    with open(target, "rb") as handle:
        head = handle.read(TEXT_SNIFF_BYTES)
    try:
        # Incremental: un carácter de varios bytes cortado al final del comienzo no lo hace binario.
        codecs.getincrementaldecoder("utf-8")().decode(head, final=len(head) == size)
    except UnicodeDecodeError:
        return {**result, "binary": True}
    if b"\0" in head:
        return {**result, "binary": True}
    if size > MAX_TEXT_VIEW_BYTES:
        return {**result, "binary": False, "too_large": True}
    try:
        text = target.read_bytes().decode("utf-8")
    except UnicodeDecodeError:
        return {**result, "binary": True}
    return {**result, "binary": False, "text": text}


def download_project_file(params: dict, ctx: SecurityContext) -> dict:
    """Una página del fichero en base64 desde offset; la interfaz las pide hasta done."""
    target, root = _regular_file(params, ctx)
    size = target.stat().st_size
    if size > MAX_DOWNLOAD_BYTES:
        raise ValueError(f"El fichero ocupa más de {MAX_DOWNLOAD_BYTES // (1024 * 1024)} MB y no se descarga desde aquí.")
    offset = params.get("offset", 0)
    if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0 or offset > size:
        raise ValueError("offset debe ser un entero entre 0 y el tamaño del fichero.")
    with open(target, "rb") as handle:
        handle.seek(offset)
        chunk = handle.read(DOWNLOAD_PAGE_BYTES)
    following = offset + len(chunk)
    return {
        "path": _relative(target, root),
        "name": target.name,
        "size": size,
        "data": base64.b64encode(chunk).decode("ascii"),
        "next": following,
        "done": following >= size,
    }


def dispatch_files(method: str, params: dict, ctx: SecurityContext) -> tuple[dict | None, dict | None, str]:
    """zerochat/files/list, zerochat/files/read y zerochat/files/download sobre la carpeta del proyecto."""
    params = params if isinstance(params, dict) else {}
    handlers = {
        "zerochat/files/list": list_project_dir,
        "zerochat/files/read": read_project_file,
        "zerochat/files/download": download_project_file,
    }
    handler = handlers.get(method)
    if handler is None:
        return None, {"code": -32601, "message": f"Método '{method}' no soportado."}, ""
    try:
        return handler(params, ctx), None, ""
    except (ValueError, OSError) as exc:
        return None, {"code": -32602, "message": str(exc)}, str(exc)
