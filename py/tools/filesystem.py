"""Herramientas de archivos del servidor local: listar, leer, escribir, editar, buscar y diagnosticar dentro de las rutas que autoriza el proyecto."""

from __future__ import annotations

import fnmatch
import itertools
import json
import os
import re
import shutil
import subprocess
from collections.abc import Iterator
from pathlib import Path

from core.environment import get_data_dir, get_no_project_dir
from core.limits import MAX_PATH_LENGTH
from security.context import SecurityContext, project_context
from security.controller import ACCESS_CONTROLLER
from security.rules import POLICY_ALLOW
from tools.common import _atomic_write_text, _tool_error, line_matches, text_terms

IGNORED_WORKSPACE_DIRS = {
    ".git", ".venv", "venv", "node_modules", "__pycache__",
    ".pytest_cache", ".cache", ".gemini", "dist", "build"
}


LIST_DIRECTORY_MAX_ENTRIES = 1000


def _directory_entry(entry: os.DirEntry, target: Path, recursive: bool) -> dict:
    """Datos de una entrada de list_directory; OSError si desaparece o no se puede leer."""
    stat = entry.stat(follow_symlinks=False)
    is_dir = entry.is_dir(follow_symlinks=False)
    try:
        resolved_path = str(Path(entry.path).resolve())
    except (OSError, RuntimeError):
        resolved_path = str(Path(entry.path).absolute())
    data = {
        "name": entry.name,
        "path": resolved_path,
        "type": "directory" if is_dir else "file",
        "size_bytes": None if is_dir else stat.st_size,
        "is_symlink": entry.is_symlink()
    }
    if recursive:
        try:
            data["relative_path"] = Path(entry.path).relative_to(target).as_posix()
        except ValueError:
            data["relative_path"] = entry.name
    return data


def _scan_directory(current: Path, target: Path, depth: int, max_depth: int, recursive: bool, entries: list[dict]):
    """Añade a entries el contenido de current, carpetas primero, sin seguir enlaces y hasta una entrada más del
    tope, que solo sirve para saber que hay más."""
    if depth > max_depth or len(entries) > LIST_DIRECTORY_MAX_ENTRIES:
        return
    try:
        with os.scandir(current) as it:
            items = sorted(it, key=lambda e: (not e.is_dir(follow_symlinks=False), e.name.lower()))
    except OSError:
        return
    for entry in items:
        if len(entries) > LIST_DIRECTORY_MAX_ENTRIES:
            break
        try:
            data = _directory_entry(entry, target, recursive)
            entries.append(data)
            if recursive and data["type"] == "directory" and not data["is_symlink"]:
                _scan_directory(Path(entry.path), target, depth + 1, max_depth, recursive, entries)
        except OSError:
            continue


def list_directory(path: str = ".", recursive: bool = False, *, ctx: SecurityContext) -> str:
    """List files and directories in a local directory with safe bounded recursive traversal."""
    try:
        target = ctx.absolute(path)
        if not target.exists():
            return _tool_error(f"Path '{path}' does not exist.")
        if not target.is_dir():
            return _tool_error(f"Path '{path}' is not a directory.")
        entries: list[dict] = []
        _scan_directory(target, target, 1, 3 if recursive else 1, recursive, entries)
        truncated = len(entries) > LIST_DIRECTORY_MAX_ENTRIES
        entries = entries[:LIST_DIRECTORY_MAX_ENTRIES]
        return json.dumps({
            "success": True,
            "path": str(target),
            "recursive": bool(recursive),
            "total_items": len(entries),
            "truncated": truncated,
            "entries": entries
        }, ensure_ascii=False, indent=2)
    except Exception as e:
        return _tool_error(str(e))


# Códigos de control de terminal (colores, movimiento del cursor) que un log trae y el modelo no necesita.
ANSI_ESCAPE_RE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]")
READ_TAIL_BLOCK_BYTES = 64 * 1024
MAX_READ_LINES = 2000


def _terminal_line(line: str) -> str:
    """Una línea como la deja una terminal: sin códigos de color y, si se reescribe con \\r, su último tramo."""
    ending = "\n" if line.endswith("\n") else ""
    text = ANSI_ESCAPE_RE.sub("", line[:-1] if ending else line).rstrip("\r")
    return text[text.rfind("\r") + 1:] + ending


def _count_lines(target: Path) -> int:
    lines = 0
    last = b""
    with open(target, "rb") as handle:
        while chunk := handle.read(1024 * 1024):
            lines += chunk.count(b"\n")
            last = chunk[-1:]
    return lines + (1 if last and last != b"\n" else 0)


def _read_tail(target: Path, tail_lines: int, max_bytes: int) -> str:
    """Las últimas tail_lines líneas, leyendo el fichero desde el final por bloques y sin pasar de max_bytes."""
    file_size = target.stat().st_size
    wanted = max(1, min(int(tail_lines), MAX_READ_LINES))
    data = b""
    with open(target, "rb") as handle:
        position = file_size
        # Una línea más de las pedidas: la primera del bloque puede estar a medias.
        while position > 0 and data.count(b"\n") <= wanted and len(data) < max_bytes:
            step = min(READ_TAIL_BLOCK_BYTES, position)
            position -= step
            handle.seek(position)
            data = handle.read(step) + data
    truncated_bytes = len(data) > max_bytes
    if truncated_bytes:
        data = data[-max_bytes:]
    # Solo \n separa líneas: splitlines también parte en \r y desharía las barras de progreso.
    parts = data.decode("utf-8", errors="replace").split("\n")
    lines = [part + "\n" for part in parts[:-1]] + ([parts[-1]] if parts[-1] else [])
    if (position > 0 or truncated_bytes) and lines:
        lines = lines[1:]
    lines = lines[-wanted:]
    total_lines = _count_lines(target)
    start_line = total_lines - len(lines) + 1
    return json.dumps({
        "success": True,
        "path": str(target),
        "size_bytes": file_size,
        "total_lines": total_lines,
        "start_line": start_line,
        "end_line": total_lines,
        "lines_returned": len(lines),
        "truncated": start_line > 1,
        "content": "".join(_terminal_line(line) for line in lines)
    }, ensure_ascii=False, indent=2)


# Pasado el rango pedido, read_file sigue contando líneas para total_lines hasta este número más allá del inicio.
READ_COUNT_AHEAD_LINES = 50000


def _read_line_range(target: Path, start: int, count: int, max_bytes: int) -> tuple[list[str], int, bool]:
    """Hasta count líneas desde start sin pasar de max_bytes (la última, cortada). Devuelve las líneas, las que
    se han contado (todas, o hasta READ_COUNT_AHEAD_LINES más allá de start) y si se cortó por bytes."""
    selected: list[str] = []
    used = 0
    total_lines = 0
    with open(target, "r", encoding="utf-8", errors="replace") as f:
        for line_no, line in enumerate(f, 1):
            total_lines = line_no
            if line_no < start:
                continue
            if len(selected) >= count:
                if line_no > start + READ_COUNT_AHEAD_LINES:
                    break
                continue
            encoded = line.encode("utf-8")
            if used + len(encoded) > max_bytes:
                if max_bytes > used:
                    selected.append(encoded[:max_bytes - used].decode("utf-8", errors="ignore"))
                return selected, total_lines, True
            selected.append(line)
            used += len(encoded)
    return selected, total_lines, False


# Tope por defecto de read_file: alineado con los 60.000 chars de web/MCP, por debajo de los 64.000 de ChatContextManager.
READ_FILE_DEFAULT_MAX_BYTES = 60000


def read_file(path: str, start_line: int = 1, end_line: int = None, max_lines: int = 500, max_bytes: int = READ_FILE_DEFAULT_MAX_BYTES,
              tail_lines: int | None = None, *, ctx: SecurityContext) -> str:
    """Read text content from a local file in streaming mode with safe ranges and bounds, or its last lines."""
    try:
        target = ctx.absolute(path)
        if not target.exists():
            return _tool_error(f"File '{path}' does not exist.")
        if not target.is_file():
            return _tool_error(f"Path '{path}' is not a regular file.")

        file_size = target.stat().st_size
        safe_max_bytes = max(1024, min(int(max_bytes), 2000000))
        if tail_lines is not None:
            return _read_tail(target, tail_lines, safe_max_bytes)
        start = max(1, int(start_line))
        if end_line is not None:
            count = min(max(start, int(end_line)) - start + 1, MAX_READ_LINES)
        else:
            count = max(1, min(int(max_lines), MAX_READ_LINES))

        selected, total_lines, truncated_bytes = _read_line_range(target, start, count, safe_max_bytes)
        return json.dumps({
            "success": True,
            "path": str(target),
            "size_bytes": file_size,
            "total_lines": total_lines,
            "start_line": start,
            "end_line": start + len(selected) - 1,
            "lines_returned": len(selected),
            "truncated": truncated_bytes or start + count - 1 < total_lines,
            "content": "".join(selected)
        }, ensure_ascii=False, indent=2)
    except Exception as e:
        return _tool_error(str(e))


def write_file(path: str, content: str, *, ctx: SecurityContext) -> str:
    """Create or overwrite a file completely and atomically."""
    try:
        target = ctx.absolute(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        _atomic_write_text(target, content)
        bytes_written = len(content.encode("utf-8"))
        return json.dumps({
            "success": True,
            "path": str(target),
            "bytes_written": bytes_written
        }, ensure_ascii=False, indent=2)
    except Exception as e:
        return _tool_error(str(e))


def edit_file(path: str, old_str: str, new_str: str, replace_all: bool = False, *, ctx: SecurityContext) -> str:
    """Replace old_str with new_str in an existing file: its single occurrence, or all of them with replace_all."""
    try:
        target = ctx.absolute(path)
        if not target.exists():
            return _tool_error(f"File '{path}' does not exist. Use read_file to verify existing paths.")
        if not target.is_file():
            return _tool_error(f"Path '{path}' is not a regular file.")

        with open(target, "r", encoding="utf-8", errors="replace") as f:
            file_text = f.read()

        if not old_str:
            return _tool_error("old_str is empty. Provide the exact text to replace.")
        occurrences = file_text.count(old_str)
        if occurrences == 0:
            return _tool_error(f"Target text was not found in '{path}'. Check exact file content with read_file.")
        if occurrences > 1 and not replace_all:
            return _tool_error(f"Found {occurrences} matches for the snippet in '{path}'. Provide more surrounding context in old_str to ensure a unique match, or set replace_all to replace every match.")

        updated_text = file_text.replace(old_str, new_str) if replace_all else file_text.replace(old_str, new_str, 1)
        _atomic_write_text(target, updated_text)
        return json.dumps({
            "success": True,
            "path": str(target),
            "bytes_written": len(updated_text.encode("utf-8")),
            "replacements": occurrences if replace_all else 1
        }, ensure_ascii=False, indent=2)
    except Exception as e:
        return _tool_error(str(e))


def _existing_directory(path, ctx: SecurityContext) -> Path:
    """La carpeta `path` (relativa al proyecto de la petición) resuelta; ValueError si no es una carpeta."""
    if not isinstance(path, str) or not path.strip():
        raise ValueError("La ruta del directorio está vacía.")
    if len(path) > MAX_PATH_LENGTH:
        raise ValueError("La ruta del directorio excede el tamaño máximo permitido.")
    target = ctx.absolute(path)
    if not target.is_dir():
        raise ValueError(f"'{path}' no existe o no es un directorio.")
    return target


def resolve_project_directory(path, ctx: SecurityContext) -> dict:
    """
    Valida la carpeta que elige una pestaña como proyecto (relativa al suyo actual). El servidor no la
    guarda: la pestaña la envía en cada petición (X-ZeroChat-Project) y otras pestañas siguen en la suya.
    """
    # Cambiar de proyecto no borra nada: cada proyecto conserva su propia sesión.
    return {"cwd": str(_existing_directory(path, ctx))}


PROJECT_CONTEXT_MAX_BYTES = 16384


def _can_read_project_file(rel_path: str, ctx: SecurityContext) -> bool:
    path = str(ctx.workspace_dir / rel_path)
    return ACCESS_CONTROLLER.evaluate_authorization(
        "read_file", {"path": path}, context=ctx, server_name="mcp-proxy", server_id=""
    ).status == POLICY_ALLOW


def _read_project_text(rel_path: str, ctx: SecurityContext, max_lines: int = MAX_READ_LINES) -> tuple[str, dict | None, str]:
    """Lee un fichero del proyecto: devuelve (status, {content, truncated}, error)."""
    try:
        target = ctx.absolute(rel_path)
        if not target.exists():
            return "missing", None, ""
        if not target.is_file():
            return "error", None, f"Path '{rel_path}' is not a regular file."
        selected, total_lines, truncated_bytes = _read_line_range(target, 1, max_lines, PROJECT_CONTEXT_MAX_BYTES)
        return "ok", {"content": "".join(selected), "truncated": truncated_bytes or max_lines < total_lines}, ""
    except OSError as exc:
        return "error", None, str(exc)


def read_project_context(ctx: SecurityContext) -> dict:
    """
    Contexto del modo proyecto (.zerochat/task.py, .zerochat/state.md y AGENTS.md) en una sola lectura,
    sujeta a las mismas reglas de lectura que read_file sin abrir retos interactivos.
    """
    if not _can_read_project_file(".zerochat/task.py", ctx):
        return {"status": "denied"}
    helper_status, _, helper_err = _read_project_text(".zerochat/task.py", ctx, max_lines=1)
    if helper_status != "ok":
        return {"status": helper_status, **({"error": helper_err} if helper_err else {})}
    if not _can_read_project_file(".zerochat/state.md", ctx):
        return {"status": "denied"}
    state_status, state_data, state_err = _read_project_text(".zerochat/state.md", ctx)
    if state_status == "error":
        return {"status": "error", "error": state_err}
    rules_data = None
    if _can_read_project_file("AGENTS.md", ctx):
        _, rules_data, _ = _read_project_text("AGENTS.md", ctx)
    empty = {"content": "", "truncated": False}
    return {
        "status": "ok",
        "rules": rules_data or empty,
        "state": state_data or empty,
    }


# Subcarpetas de una respuesta del selector de carpeta de trabajo: una carpeta con más avisa de las que faltan.
MAX_BROWSE_ENTRIES = 1000


def browse_directories(params: dict, ctx: SecurityContext) -> dict:
    """
    Subcarpetas no ocultas de `path` (vacía, el proyecto de la petición), por nombre, para que la persona
    elija la carpeta de trabajo. Como set_directory, no es una herramienta del modelo: no la limita la
    carpeta del proyecto, solo lo que el usuario del sistema puede leer, y nunca muestra ficheros.
    """
    path = params.get("path")
    target = ctx.workspace_dir.resolve() if path in (None, "") else _existing_directory(path, ctx)
    names = []
    try:
        with os.scandir(target) as items:
            for item in items:
                if item.name.startswith("."):
                    continue
                try:
                    if item.is_dir():
                        names.append(item.name)
                except OSError:
                    continue
    except OSError as exc:
        raise ValueError(f"No se puede leer '{target}': {exc.strerror or exc}") from exc
    names.sort(key=lambda name: (name.lower(), name))
    return {
        "path": str(target),
        "parent": None if target.parent == target else str(target.parent),
        "directories": names[:MAX_BROWSE_ENTRIES],
        "total": len(names),
        "truncated": len(names) > MAX_BROWSE_ENTRIES,
    }


def create_project_directory(params: dict, ctx: SecurityContext) -> dict:
    """
    Crea la carpeta `name` dentro de `parent` para usarla como proyecto. Solo bajo la carpeta personal del
    usuario: crear un proyecto no necesita escribir en el resto del sistema. El nombre es un solo nivel
    y no oculto, porque el selector no muestra las ocultas.
    """
    name = params.get("name")
    if not isinstance(name, str) or not name.strip():
        raise ValueError("El nombre de la carpeta está vacío.")
    name = name.strip()
    if len(name) > 255 or any(sep in name for sep in ("/", "\\", "\0")) or name.startswith("."):
        raise ValueError(f"'{name}' no es un nombre de carpeta válido: sin separadores y sin empezar por un punto.")
    parent = _existing_directory(params.get("parent"), ctx)
    home = Path.home().resolve()
    if parent != home and home not in parent.parents:
        raise ValueError(f"Solo se pueden crear carpetas dentro de {home}.")
    target = parent / name
    try:
        target.mkdir()
    except FileExistsError as exc:
        raise ValueError(f"'{target}' ya existe.") from exc
    except OSError as exc:
        raise ValueError(f"No se puede crear '{target}': {exc.strerror or exc}") from exc
    return {"path": str(target)}


def validate_deletable_project_dir(ctx: SecurityContext) -> Path:
    """Comprueba que la carpeta del proyecto puede borrarse sin tocar raíces, ~, general, ~/zerochat ni la carpeta de
    arranque, que es el proyecto por defecto del servidor: sin ella, cada pestaña nueva abriría una carpeta inexistente."""
    target = ctx.workspace_dir.resolve()
    no_project = get_no_project_dir().resolve()
    data_dir = get_data_dir().resolve()
    home = Path.home().resolve()
    if target == target.parent or target == home or target == no_project:
        raise ValueError("No se puede borrar la carpeta general, la carpeta personal ni una raíz del sistema.")
    if target == data_dir or target in data_dir.parents:
        raise ValueError("No se puede borrar la carpeta de datos de ZeroChat.")
    if target == project_context().workspace_dir:
        raise ValueError("Es la carpeta con la que arrancó ZeroChat: arráncalo desde otra para borrarla.")
    return target


def _walk_project_files(target: Path) -> Iterator[Path]:
    """Ficheros bajo target en orden, sin los directorios ignorados ni los ocultos, y sin los enlaces simbólicos
    que salen de target (no se lee nada fuera de la carpeta que se autorizó)."""
    for root, dirs, files in os.walk(target):
        dirs[:] = [d for d in dirs if d not in IGNORED_WORKSPACE_DIRS and not d.startswith(".")]
        for fname in sorted(files):
            fpath = Path(root) / fname
            try:
                if fpath.is_symlink() and not fpath.resolve().is_relative_to(target):
                    continue
            except (OSError, ValueError):
                continue
            yield fpath


SEARCH_MAX_FILE_BYTES = 2 * 1024 * 1024
SEARCH_LINE_CHARS = 300


def _search_lines(fpath: Path, target: Path, terms: tuple[str, ...], limit: int) -> list[dict]:
    """Hasta limit líneas de fpath que contienen alguno de los textos; un fichero que no se puede leer no tiene ninguna."""
    try:
        rel_path = fpath.relative_to(target).as_posix()
    except ValueError:
        rel_path = str(fpath)
    found = []
    try:
        with open(fpath, "r", encoding="utf-8", errors="ignore") as f:
            for line_idx, line in enumerate(f, 1):
                if line_matches(line, terms):
                    found.append({"file": str(fpath), "relative_path": rel_path, "line_number": line_idx,
                                  "content": line.rstrip("\r\n")[:SEARCH_LINE_CHARS]})
                    if len(found) >= limit:
                        break
    except OSError:
        pass
    return found


def search_files(query: str, path: str = ".", file_pattern: str = None, max_results: int = 100, *, ctx: SecurityContext) -> str:
    """
    Busca texto fijo, sin distinguir mayúsculas, en un fichero o en los de una carpeta: la consulta es uno o varios
    textos separados por | y no una expresión regular, porque re no suelta el GIL y una expresión con retroceso
    catastrófico congelaría todo el servidor (como en check_command). Las búsquedas reales son texto fijo.
    """
    try:
        target = ctx.absolute(path)
        if not target.exists():
            return _tool_error(f"Path '{path}' does not exist.")
        terms = text_terms(query)
        if not terms:
            return _tool_error("query needs at least one text, such as 'validate_token|check_token'.")

        try:
            safe_max_results = max(1, min(int(max_results), 500))
        except (TypeError, ValueError):
            safe_max_results = 100

        matches = []
        files_searched = 0
        root = target if target.is_dir() else target.parent
        for fpath in _walk_project_files(target) if target.is_dir() else (target,):
            if file_pattern and not fnmatch.fnmatch(fpath.name, file_pattern):
                continue
            try:
                if fpath.stat().st_size > SEARCH_MAX_FILE_BYTES:
                    continue
            except OSError:
                continue
            files_searched += 1
            # Una coincidencia más del tope dice si hay más, sin dar truncated con exactamente el tope.
            matches.extend(_search_lines(fpath, root, terms, safe_max_results + 1 - len(matches)))
            if len(matches) > safe_max_results:
                break
        truncated = len(matches) > safe_max_results
        matches = matches[:safe_max_results]

        payload = {
            "success": True,
            "path": str(target),
            "query": query,
            "file_pattern": file_pattern,
            "files_searched": files_searched,
            "total_matches": len(matches),
            "truncated": truncated,
            "matches": matches
        }
        return json.dumps(payload, ensure_ascii=False, indent=2)
    except Exception as e:
        return _tool_error(str(e))


def _diagnostic(file: str, line: int, column: int, message: str) -> dict:
    return {"file": file, "line": line, "column": column, "severity": "error", "message": message}


def _python_diagnostics(fpath: Path, display: str) -> list[dict]:
    try:
        compile(fpath.read_text(encoding="utf-8", errors="replace"), str(fpath), "exec")
    except SyntaxError as e:
        return [_diagnostic(display, e.lineno or 1, e.offset or 1, f"SyntaxError: {e.msg}")]
    return []


def _js_diagnostics(fpath: Path, display: str) -> list[dict]:
    """node --check, si hay node; sin él no se comprueba nada."""
    node_bin = shutil.which("node")
    if not node_bin:
        return []
    try:
        res = subprocess.run([node_bin, "--check", str(fpath)], capture_output=True, text=True, timeout=10)
    except (subprocess.SubprocessError, OSError):
        return []
    if res.returncode == 0:
        return []
    stderr = res.stderr or ""
    line_match = re.search(r':(\d+)\n([^\n]+)\n(\s*)\^', stderr)
    line = int(line_match.group(1)) if line_match else 1
    col = len(line_match.group(3)) + 1 if line_match else 1
    msg_match = re.search(r'(SyntaxError:[^\n]+)', stderr)
    msg = msg_match.group(1) if msg_match else (stderr.strip().splitlines()[-1] if stderr.strip() else "Syntax error")
    return [_diagnostic(display, line, col, msg)]


def _json_diagnostics(fpath: Path, display: str) -> list[dict]:
    try:
        json.loads(fpath.read_text(encoding="utf-8", errors="replace"))
    except json.JSONDecodeError as e:
        return [_diagnostic(display, e.lineno, e.colno, f"JSONDecodeError: {e.msg}")]
    return []


# Comprobación de sintaxis por extensión: un lenguaje nuevo es una entrada más.
DIAGNOSTIC_CHECKS = {
    ".py": _python_diagnostics,
    ".js": _js_diagnostics, ".mjs": _js_diagnostics, ".cjs": _js_diagnostics,
    ".json": _json_diagnostics,
}
DIAGNOSTICS_MAX_FILES = 200


def _file_diagnostics(fpath: Path, workspace_dir: Path) -> list[dict]:
    check = DIAGNOSTIC_CHECKS.get(fpath.suffix.lower())
    if check is None:
        return []
    try:
        display = fpath.relative_to(workspace_dir).as_posix()
    except ValueError:
        display = str(fpath)
    return check(fpath, display)


def get_diagnostics(path: str | None = None, *, ctx: SecurityContext) -> str:
    """Retrieve syntax diagnostics and code errors for a file or the entire workspace."""
    try:
        target = ctx.absolute(path) if path is not None and str(path).strip() else ctx.workspace_dir

        if not target.exists():
            return _tool_error(f"Path '{path}' does not exist.")

        if target.is_file():
            checked = [target]
        else:
            checkable = (fp for fp in _walk_project_files(target) if fp.suffix.lower() in DIAGNOSTIC_CHECKS)
            checked = list(itertools.islice(checkable, DIAGNOSTICS_MAX_FILES + 1))
        truncated = len(checked) > DIAGNOSTICS_MAX_FILES
        checked = checked[:DIAGNOSTICS_MAX_FILES]
        files_checked = len(checked)
        diagnostics = [diag for fp in checked for diag in _file_diagnostics(fp, ctx.workspace_dir)]

        msg = f"Found {len(diagnostics)} issue(s)." if diagnostics else "No diagnostic issues found."

        return json.dumps({
            "success": True,
            "path": str(target),
            "files_checked": files_checked,
            "truncated": truncated,
            "error_count": len(diagnostics),
            "diagnostics": diagnostics,
            "message": msg
        }, ensure_ascii=False, indent=2)
    except Exception as e:
        return _tool_error(str(e))
