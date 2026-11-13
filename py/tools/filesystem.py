"""Herramientas de archivos del servidor local: listar, leer, escribir, editar, buscar y diagnosticar dentro de las rutas que autoriza el proyecto."""

from __future__ import annotations

import fnmatch
import json
import os
import re
import shutil
import subprocess
from pathlib import Path

from core.limits import MAX_PATH_LENGTH
from security.context import SecurityContext
from tools.common import _atomic_write_text, _tool_error

IGNORED_WORKSPACE_DIRS = {
    ".git", ".venv", "venv", "node_modules", "__pycache__",
    ".pytest_cache", ".cache", ".gemini", "dist", "build"
}


def list_directory(path: str = ".", recursive: bool = False, *, ctx: SecurityContext) -> str:
    """List files and directories in a local directory with safe bounded recursive traversal."""
    try:
        target = ctx.absolute(path)
        if not target.exists():
            return _tool_error(f"Path '{path}' does not exist.")
        if not target.is_dir():
            return _tool_error(f"Path '{path}' is not a directory.")

        max_depth = 3 if recursive else 1
        entries = []

        def _scan(current_path: Path, current_depth: int):
            if current_depth > max_depth or len(entries) >= 1000:
                return
            try:
                with os.scandir(current_path) as it:
                    items = list(it)
                    items.sort(key=lambda e: (not e.is_dir(follow_symlinks=False), e.name.lower()))
                    for entry in items:
                        if len(entries) >= 1000:
                            break
                        try:
                            stat = entry.stat(follow_symlinks=False)
                            is_dir = entry.is_dir(follow_symlinks=False)
                            try:
                                resolved_path = str(Path(entry.path).resolve())
                            except (OSError, RuntimeError):
                                resolved_path = str(Path(entry.path).absolute())
                            entry_data = {
                                "name": entry.name,
                                "path": resolved_path,
                                "type": "directory" if is_dir else "file",
                                "size_bytes": None if is_dir else stat.st_size,
                                "is_symlink": entry.is_symlink()
                            }
                            if recursive:
                                try:
                                    entry_data["relative_path"] = Path(entry.path).relative_to(target).as_posix()
                                except ValueError:
                                    entry_data["relative_path"] = entry.name
                            entries.append(entry_data)
                            if recursive and is_dir and not entry.is_symlink():
                                _scan(Path(entry.path), current_depth + 1)
                        except (PermissionError, FileNotFoundError, OSError):
                            continue
            except (PermissionError, FileNotFoundError, OSError):
                pass

        _scan(target, 1)

        return json.dumps({
            "success": True,
            "path": str(target),
            "recursive": bool(recursive),
            "total_items": len(entries),
            "entries": entries
        }, ensure_ascii=False, indent=2)
    except Exception as e:
        return _tool_error(str(e))


def read_file(path: str, start_line: int = 1, end_line: int = None, max_lines: int = 500, max_bytes: int = 100000, *, ctx: SecurityContext) -> str:
    """Read text content from a local file in streaming mode with safe ranges and bounds."""
    try:
        target = ctx.absolute(path)
        if not target.exists():
            return _tool_error(f"File '{path}' does not exist.")
        if not target.is_file():
            return _tool_error(f"Path '{path}' is not a regular file.")

        file_size = target.stat().st_size
        safe_max_bytes = max(1024, min(int(max_bytes), 2000000))
        safe_start_line = max(1, int(start_line))

        if end_line is not None:
            safe_end_line = max(safe_start_line, int(end_line))
            target_line_count = min(safe_end_line - safe_start_line + 1, 2000)
            safe_end_line = safe_start_line + target_line_count - 1
        else:
            safe_end_line = None
            target_line_count = max(1, min(int(max_lines), 2000))

        selected_lines = []
        current_bytes = 0
        truncated_bytes = False
        total_lines = 0
        reached_end_bound = False

        with open(target, "r", encoding="utf-8", errors="replace") as f:
            for line_no, line in enumerate(f, 1):
                total_lines = line_no
                if line_no < safe_start_line:
                    continue
                if safe_end_line is not None and line_no > safe_end_line:
                    reached_end_bound = True
                    if line_no > safe_start_line + 50000:
                        break
                    continue
                if safe_end_line is None and len(selected_lines) >= target_line_count:
                    reached_end_bound = True
                    if line_no > safe_start_line + 50000:
                        break
                    continue

                if not reached_end_bound:
                    line_bytes = len(line.encode("utf-8"))
                    if current_bytes + line_bytes > safe_max_bytes:
                        remaining_budget = max(0, safe_max_bytes - current_bytes)
                        if remaining_budget > 0:
                            encoded = line.encode("utf-8")[:remaining_budget]
                            selected_lines.append(encoded.decode("utf-8", errors="ignore"))
                        truncated_bytes = True
                        reached_end_bound = True
                        break
                    else:
                        selected_lines.append(line)
                        current_bytes += line_bytes

        content = "".join(selected_lines)
        last_returned_line = safe_start_line + len(selected_lines) - 1 if selected_lines else safe_start_line - 1

        is_truncated = truncated_bytes or (safe_end_line is not None and safe_end_line < total_lines) or (safe_end_line is None and (safe_start_line + target_line_count - 1) < total_lines)

        return json.dumps({
            "success": True,
            "path": str(target),
            "size_bytes": file_size,
            "total_lines": total_lines,
            "start_line": safe_start_line,
            "end_line": last_returned_line,
            "lines_returned": len(selected_lines),
            "truncated": is_truncated,
            "content": content
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


def resolve_project_directory(path, ctx: SecurityContext) -> dict:
    """
    Valida la carpeta que elige una pestaña como proyecto (relativa al suyo actual). El servidor no la
    guarda: la pestaña la envía en cada petición (X-ZeroChat-Project) y otras pestañas siguen en la suya.
    """
    if not isinstance(path, str) or not path.strip():
        raise ValueError("La ruta del directorio está vacía.")
    if len(path) > MAX_PATH_LENGTH:
        raise ValueError("La ruta del directorio excede el tamaño máximo permitido.")
    target = ctx.absolute(path)
    if not target.is_dir():
        raise ValueError(f"'{path}' no existe o no es un directorio.")
    # Cambiar de proyecto no borra nada: cada proyecto conserva su propia sesión.
    return {"cwd": str(target)}


def search_files(query: str, path: str = ".", file_pattern: str = None, max_results: int = 100, *, ctx: SecurityContext) -> str:
    """Recursively search for plain text or regular expressions across project files."""
    try:
        target = ctx.absolute(path)
        if not target.exists():
            return _tool_error(f"Path '{path}' does not exist.")
        if not target.is_dir():
            return _tool_error(f"Path '{path}' is not a directory.")

        warning = None
        try:
            regex = re.compile(query, re.MULTILINE)
        except re.error as err:
            warning = f"Query '{query}' is not a valid regular expression ({err}); treated as literal text."
            regex = re.compile(re.escape(query), re.MULTILINE)

        try:
            safe_max_results = max(1, min(int(max_results), 500))
        except (TypeError, ValueError):
            safe_max_results = 100

        matches = []
        files_searched = 0
        max_file_size = 2 * 1024 * 1024
        truncated = False

        for root, dirs, files in os.walk(target):
            dirs[:] = [d for d in dirs if d not in IGNORED_WORKSPACE_DIRS and not d.startswith(".")]

            for fname in sorted(files):
                if file_pattern and not fnmatch.fnmatch(fname, file_pattern):
                    continue

                fpath = Path(root) / fname
                try:
                    if fpath.is_symlink():
                        try:
                            if not fpath.resolve().is_relative_to(target):
                                continue
                        except (OSError, ValueError):
                            continue
                    stat = fpath.stat()
                    if stat.st_size > max_file_size:
                        continue
                except OSError:
                    continue

                files_searched += 1
                try:
                    with open(fpath, "r", encoding="utf-8", errors="ignore") as f:
                        for line_idx, line in enumerate(f, 1):
                            if regex.search(line):
                                try:
                                    rel_path = fpath.relative_to(target).as_posix()
                                except ValueError:
                                    rel_path = str(fpath)
                                matches.append({
                                    "file": str(fpath),
                                    "relative_path": rel_path,
                                    "line_number": line_idx,
                                    "content": line.rstrip("\r\n")[:300]
                                })
                                if len(matches) >= safe_max_results:
                                    truncated = True
                                    break
                except (PermissionError, OSError):
                    continue

                if truncated:
                    break
            if truncated:
                break

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
        if warning:
            payload["warning"] = warning

        return json.dumps(payload, ensure_ascii=False, indent=2)
    except Exception as e:
        return _tool_error(str(e))


def get_diagnostics(path: str | None = None, *, ctx: SecurityContext) -> str:
    """Retrieve syntax diagnostics and code errors for a file or the entire workspace."""
    try:
        target = ctx.absolute(path) if path is not None and str(path).strip() else ctx.workspace_dir

        if not target.exists():
            return _tool_error(f"Path '{path}' does not exist.")

        diagnostics: list[dict] = []
        files_checked = 0

        def check_single_file(fpath: Path) -> list[dict]:
            ext = fpath.suffix.lower()
            file_diags: list[dict] = []
            try:
                rel_display = fpath.relative_to(ctx.workspace_dir).as_posix()
            except ValueError:
                rel_display = str(fpath)

            if ext == ".py":
                try:
                    content = fpath.read_text(encoding="utf-8", errors="replace")
                    compile(content, str(fpath), "exec")
                except (SyntaxError, IndentationError) as e:
                    file_diags.append({
                        "file": rel_display,
                        "line": e.lineno or 1,
                        "column": e.offset or 1,
                        "severity": "error",
                        "message": f"SyntaxError: {e.msg}"
                    })
            elif ext in (".js", ".mjs", ".cjs"):
                node_bin = shutil.which("node")
                if node_bin:
                    try:
                        res = subprocess.run([node_bin, "--check", str(fpath)], capture_output=True, text=True, timeout=10)
                        if res.returncode != 0:
                            stderr = res.stderr or ""
                            line_match = re.search(r':(\d+)\n([^\n]+)\n(\s*)\^', stderr)
                            line = int(line_match.group(1)) if line_match else 1
                            col = len(line_match.group(3)) + 1 if line_match else 1
                            msg_match = re.search(r'(SyntaxError:[^\n]+)', stderr)
                            msg = msg_match.group(1) if msg_match else (stderr.strip().splitlines()[-1] if stderr.strip() else "Syntax error")
                            file_diags.append({
                                "file": rel_display,
                                "line": line,
                                "column": col,
                                "severity": "error",
                                "message": msg
                            })
                    except (subprocess.SubprocessError, OSError):
                        pass
            elif ext == ".json":
                try:
                    content = fpath.read_text(encoding="utf-8", errors="replace")
                    json.loads(content)
                except json.JSONDecodeError as e:
                    file_diags.append({
                        "file": rel_display,
                        "line": e.lineno,
                        "column": e.colno,
                        "severity": "error",
                        "message": f"JSONDecodeError: {e.msg}"
                    })
            return file_diags

        if target.is_file():
            files_checked = 1
            diagnostics.extend(check_single_file(target))
        else:
            max_scan = 200
            for root, dirs, files in os.walk(target):
                dirs[:] = [d for d in dirs if d not in IGNORED_WORKSPACE_DIRS and not d.startswith(".")]
                for fname in sorted(files):
                    fp = Path(root) / fname
                    try:
                        if fp.is_symlink():
                            try:
                                if not fp.resolve().is_relative_to(target):
                                    continue
                            except (OSError, ValueError):
                                continue
                    except OSError:
                        continue
                    if fp.suffix.lower() in (".py", ".js", ".mjs", ".cjs", ".json"):
                        files_checked += 1
                        diagnostics.extend(check_single_file(fp))
                        if files_checked >= max_scan:
                            break
                if files_checked >= max_scan:
                    break

        msg = f"Found {len(diagnostics)} issue(s)." if diagnostics else "No diagnostic issues found."

        return json.dumps({
            "success": True,
            "path": str(target),
            "files_checked": files_checked,
            "error_count": len(diagnostics),
            "diagnostics": diagnostics,
            "message": msg
        }, ensure_ascii=False, indent=2)
    except Exception as e:
        return _tool_error(str(e))
