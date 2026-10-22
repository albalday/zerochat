# ==============================================================================
# Herramientas Locales Core
# ==============================================================================

MAX_HTTP_BODY_BYTES = 1024 * 1024
MAX_PATH_LENGTH = 4096
MAX_COMMAND_LENGTH = 16384
BROWSER_ACTIONS = ("navigate", "screenshot", "click", "fill")


def _tool_error(message: str, **extra) -> str:
    """Serializa el resultado de error común de las herramientas locales."""
    return json.dumps({"success": False, "error": message, **extra}, ensure_ascii=False)


def _atomic_write_text(target: Path, text: str):
    """Sustituye el archivo de una vez para no dejarlo a medias si la escritura falla."""
    temp_path = target.with_suffix(target.suffix + f".tmp_{os.getpid()}_{time.time_ns()}")
    with open(temp_path, "w", encoding="utf-8") as f:
        f.write(text)
    temp_path.replace(target)


IGNORED_WORKSPACE_DIRS = {
    ".git", ".venv", "venv", "node_modules", "__pycache__",
    ".pytest_cache", ".cache", ".gemini", "dist", "build"
}


def list_directory(path: str = ".", recursive: bool = False) -> str:
    """List files and directories in a local directory with safe bounded recursive traversal."""
    try:
        target = Path(path).expanduser().resolve()
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
                                    entry_data["relative_path"] = str(Path(entry.path).relative_to(target))
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


def read_file(path: str, start_line: int = 1, end_line: int = None, max_lines: int = 500, max_bytes: int = 100000) -> str:
    """Read text content from a local file in streaming mode with safe ranges and bounds."""
    try:
        target = Path(path).expanduser().resolve()
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


def write_file(path: str, content: str) -> str:
    """Create or overwrite a file completely and atomically."""
    try:
        target = Path(path).expanduser().resolve()
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


def edit_file(path: str, old_str: str, new_str: str, replace_all: bool = False) -> str:
    """Replace old_str with new_str in an existing file: its single occurrence, or all of them with replace_all."""
    try:
        target = Path(path).expanduser().resolve()
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


def set_project_directory(path) -> dict:
    """Cambia el directorio del proyecto: el del proceso, base de las rutas relativas y de los comandos."""
    if not isinstance(path, str) or not path.strip():
        raise ValueError("La ruta del directorio está vacía.")
    if len(path) > MAX_PATH_LENGTH:
        raise ValueError("La ruta del directorio excede el tamaño máximo permitido.")
    target = Path(path.strip()).expanduser().resolve()
    if not target.is_dir():
        raise ValueError(f"'{path}' no existe o no es un directorio.")
    previous = str(Path.cwd().resolve())
    # Los comandos en marcha conservan el directorio en que se lanzaron.
    os.chdir(target)
    return {"cwd": str(target), "previous_cwd": previous}


# Visores gráficos que `git difftool` ya sabe lanzar, en orden de preferencia, con el ejecutable que los delata.
GUI_DIFF_TOOLS = {"vscode": "code", "meld": "meld", "kdiff3": "kdiff3", "kompare": "kompare", "gvimdiff": "gvim"}
# Respaldo cuando no hay ninguno: visor web que se instala en el entorno aislado de ZeroChat.
WEBDIFF_REQUIREMENT = "webdiff==1.4.0"
WEBDIFF_INSTALL_TIMEOUT_SECONDS = 120


def _venv_webdiff() -> Path:
    """Ruta de webdiff dentro de ~/zerochat/.venv, junto al intérprete del entorno."""
    venv_python = get_venv_python(get_venv_dir())
    return venv_python.with_name("webdiff" + venv_python.suffix)


def _find_webdiff() -> str:
    """webdiff del entorno de ZeroChat o, si no, del PATH; '' si no hay ninguno."""
    venv_webdiff = _venv_webdiff()
    if venv_webdiff.exists():
        return str(venv_webdiff)
    return shutil.which("webdiff") or ""


def _diff_tool_settings(tool: str, webdiff_bin: str) -> list:
    """Pares (clave, valor) de git config que deja `tool` como visor gráfico; webdiff no es un visor integrado de git."""
    settings = [("diff.guitool", tool)]
    if tool == "webdiff":
        settings.insert(0, ("difftool.webdiff.cmd", f'"{webdiff_bin}" "$LOCAL" "$REMOTE"'))
    return settings


def detect_gui_diff_tool() -> dict:
    """Visor que proponer cuando Git no tiene ninguno: el primero instalado o, si no hay, webdiff.

    Incluye las órdenes exactas que aplicará configure_gui_diff_tool, para mostrarlas antes de confirmar.
    """
    tool = next((name for name, binary in GUI_DIFF_TOOLS.items() if shutil.which(binary)), "webdiff")
    webdiff_bin = _find_webdiff()
    return {
        "tool": tool,
        "install": tool == "webdiff" and not webdiff_bin,
        "commands": [
            shlex.join(["git", "config", "--global", key, value])
            for key, value in _diff_tool_settings(tool, webdiff_bin or str(_venv_webdiff()))
        ],
    }


def _install_webdiff() -> str:
    """Instala webdiff en ~/zerochat/.venv y devuelve la ruta del ejecutable."""
    ensure_virtual_environment()
    venv_python = get_venv_python(get_venv_dir())
    if not venv_python.exists():
        raise RuntimeError(f"No se pudo preparar el entorno virtual de ZeroChat: falta {venv_python}")
    res = subprocess.run(
        [str(venv_python), "-m", "pip", "install", WEBDIFF_REQUIREMENT],
        capture_output=True,
        text=True,
        timeout=WEBDIFF_INSTALL_TIMEOUT_SECONDS,
        check=False
    )
    if res.returncode != 0:
        raise RuntimeError(f"Error instalando webdiff: {(res.stderr or res.stdout).strip()[-500:]}")
    webdiff = _venv_webdiff()
    if not webdiff.exists():
        raise RuntimeError(f"webdiff se instaló pero no aparece en {webdiff}")
    return str(webdiff)


def configure_gui_diff_tool(tool) -> dict:
    """Deja `tool` como visor gráfico global de Git, instalando antes webdiff si es el elegido y falta."""
    if not isinstance(tool, str) or (tool != "webdiff" and tool not in GUI_DIFF_TOOLS):
        raise ValueError(f"Visor de diffs '{tool}' no reconocido.")
    git_bin = shutil.which("git")
    if not git_bin:
        raise RuntimeError("Git no está instalado o no se encuentra en el PATH del sistema.")

    webdiff_bin = ""
    if tool == "webdiff":
        webdiff_bin = _find_webdiff() or _install_webdiff()
    elif not shutil.which(GUI_DIFF_TOOLS[tool]):
        raise ValueError(f"'{GUI_DIFF_TOOLS[tool]}' no está en el PATH del sistema.")

    for key, value in _diff_tool_settings(tool, webdiff_bin):
        subprocess.run([git_bin, "config", "--global", key, value], capture_output=True, timeout=5, check=True)
    return {"tool": tool}


def _configured_gui_diff_tool(git_bin: str, repo_root: Path) -> str:
    """Herramienta gráfica que usaría `git difftool --gui`, o '' si no hay ninguna configurada.

    Sin diff.guitool ni merge.guitool, git recurre a diff.tool o adivina una, que puede ser de
    terminal (vimdiff): lanzada sin terminal quedaría invisible y colgada.
    """
    for key in ("diff.guitool", "merge.guitool"):
        res = subprocess.run(
            [git_bin, "config", "--get", key],
            cwd=str(repo_root),
            capture_output=True,
            text=True,
            timeout=5,
            check=False
        )
        if res.returncode == 0 and res.stdout.strip():
            return res.stdout.strip()
    return ""


def open_file_diff(path: str, commit_fallback: bool = False) -> dict:
    """Abre un visor externo de diffs (git difftool) para comparar el fichero actual frente a Git HEAD, su último commit o fichero vacío.

    Sin visor gráfico configurado no lanza nada y devuelve en `setup` el que propone configurar.
    """
    if not isinstance(path, str) or not path.strip():
        raise ValueError("La ruta del archivo está vacía.")
    if len(path) > MAX_PATH_LENGTH:
        raise ValueError("La ruta del archivo excede el tamaño máximo permitido.")

    target = Path(path.strip()).expanduser().resolve()
    if not target.exists():
        raise ValueError(f"El archivo '{path}' no existe.")
    if not target.is_file():
        raise ValueError(f"'{path}' no es un archivo regular.")

    git_bin = shutil.which("git")
    if not git_bin:
        raise RuntimeError("Git no está instalado o no se encuentra en el PATH del sistema.")

    try:
        res = subprocess.run(
            [git_bin, "rev-parse", "--show-toplevel"],
            cwd=str(target.parent),
            capture_output=True,
            text=True,
            timeout=5,
            check=False
        )
    except Exception as err:
        raise RuntimeError(f"Error comprobando repositorio Git: {err}")

    if res.returncode != 0:
        raise ValueError(f"El archivo '{target.name}' no pertenece a ningún repositorio Git.")

    repo_root = Path(res.stdout.strip()).resolve()
    if not _configured_gui_diff_tool(git_bin, repo_root):
        return {"success": False, "setup": detect_gui_diff_tool()}

    has_head = subprocess.run(
        [git_bin, "rev-parse", "--verify", "HEAD"],
        cwd=str(repo_root),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=5,
        check=False
    ).returncode == 0

    in_head = False
    has_working_tree_diff = True
    if has_head:
        try:
            rel_path = target.relative_to(repo_root).as_posix()
            in_head = subprocess.run(
                [git_bin, "cat-file", "-e", f"HEAD:{rel_path}"],
                cwd=str(repo_root),
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=5,
                check=False
            ).returncode == 0
            if in_head:
                diff_check = subprocess.run(
                    [git_bin, "diff", "--quiet", "HEAD", "--", str(target)],
                    cwd=str(repo_root),
                    timeout=5,
                    check=False
                )
                has_working_tree_diff = (diff_check.returncode != 0)
        except ValueError:
            in_head = False

    cmd = [git_bin, "difftool", "--no-prompt", "--gui"]

    mode = "working_tree"
    last_commit = ""
    if has_working_tree_diff:
        if in_head:
            cmd.extend(["HEAD", "--", str(target)])
        else:
            cmd.extend(["--no-index", "--", os.devnull, str(target)])
    else:
        # No hay cambios pendientes en el árbol de trabajo. Comprobar historial del archivo.
        rel_path = target.relative_to(repo_root).as_posix()
        log_res = subprocess.run(
            [git_bin, "log", "-n", "1", "--format=%H", "--", rel_path],
            cwd=str(repo_root),
            capture_output=True,
            text=True,
            timeout=5,
            check=False
        )
        last_commit = log_res.stdout.strip() if log_res.returncode == 0 else ""
        if not commit_fallback or not last_commit:
            return {
                "success": True,
                "has_diff": False,
                "in_head": in_head,
                "has_commit_history": bool(last_commit),
                "last_commit": last_commit or None,
                "path": str(target)
            }

        mode = "commit"
        parent_check = subprocess.run(
            [git_bin, "rev-parse", "--verify", f"{last_commit}~1"],
            cwd=str(repo_root),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=5,
            check=False
        )
        if parent_check.returncode == 0:
            cmd.extend([f"{last_commit}~1", last_commit, "--", str(target)])
        else:
            cmd.extend(["4b825dc642cb6eb9a060e54bf8d69288fbee4904", last_commit, "--", str(target)])

    popen_kwargs = {
        "cwd": str(repo_root),
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
    }
    if os.name == "nt":
        popen_kwargs["creationflags"] = (
            getattr(subprocess, "DETACHED_PROCESS", 0) |
            getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        )
    else:
        popen_kwargs["start_new_session"] = True

    proc = subprocess.Popen(cmd, **popen_kwargs)
    return {
        "success": True,
        "has_diff": True,
        "mode": mode,
        "pid": proc.pid,
        "path": str(target),
        "in_head": in_head,
        "commit": last_commit or None
    }


def search_files(query: str, path: str = ".", file_pattern: str = None, max_results: int = 100) -> str:
    """Recursively search for plain text or regular expressions across project files."""
    try:
        target = Path(path).expanduser().resolve()
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
                                    rel_path = str(fpath.relative_to(target))
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


def get_diagnostics(path: str | None = None) -> str:
    """Retrieve syntax diagnostics and code errors for a file or the entire workspace."""
    try:
        if path is not None and str(path).strip():
            target = Path(str(path).strip()).expanduser().resolve()
        else:
            target = Path.cwd().resolve()

        if not target.exists():
            return _tool_error(f"Path '{path}' does not exist.")

        diagnostics: list[dict] = []
        files_checked = 0

        def check_single_file(fpath: Path) -> list[dict]:
            ext = fpath.suffix.lower()
            file_diags: list[dict] = []
            try:
                rel_display = str(fpath.relative_to(Path.cwd()))
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


class PersistentBrowserSession:
    """Manages a persistent headless browser session (Playwright) for browser_action."""

    def __init__(self):
        self._lock = threading.Lock()
        self._process: subprocess.Popen | None = None
        atexit.register(self.close)

    def _ensure_running(self) -> subprocess.Popen:
        if self._process is not None and self._process.poll() is None:
            return self._process

        node = shutil.which("node")
        if not node:
            raise RuntimeError("Node.js is not installed or not found in system PATH.")

        runner_js = """
const readline = require('readline');
let playwright;
try {
  playwright = require(process.env.ZEROCHAT_PLAYWRIGHT_MODULE);
} catch (e) {
  console.log(JSON.stringify({
    success: false,
    error: "Playwright is not available. Start the Playwright service once in Settings > MCP to install it."
  }));
  process.exit(1);
}

(async () => {
  let browser, context, page;
  try {
    const candidates = [
      {},                      // 1. Playwright bundled Chromium
      { channel: 'chrome' },   // 2. System Google Chrome
      { channel: 'msedge' },   // 3. System Microsoft Edge
      { channel: 'chromium' }  // 4. Playwright full Chromium, if only the headless shell is missing
    ];
    let lastErr = null;
    for (const cand of candidates) {
      try {
        browser = await playwright.chromium.launch({ ...cand, headless: true });
        if (browser) break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!browser) {
      throw lastErr || new Error('No Chromium-based browser found (Playwright, Chrome, Edge, or Chromium).');
    }
    context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    page = await context.newPage();
  } catch (err) {
    console.log(JSON.stringify({ success: false, error: 'Failed to start browser: ' + err.message }));
    process.exit(1);
  }

  console.log(JSON.stringify({ ready: true }));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let req;
    try {
      req = JSON.parse(line);
    } catch (e) {
      console.log(JSON.stringify({ success: false, error: 'Invalid command JSON' }));
      continue;
    }

    try {
      const act = req.action;
      if (act === 'navigate') {
        if (!req.url) throw new Error("Parameter 'url' is required for action 'navigate'");
        await page.goto(req.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        console.log(JSON.stringify({
          success: true,
          action: 'navigate',
          url: page.url(),
          title: await page.title()
        }));
      } else if (act === 'screenshot') {
        if (req.url && req.url !== page.url()) {
          await page.goto(req.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        }
        const buf = await page.screenshot({ fullPage: false });
        console.log(JSON.stringify({
          success: true,
          action: 'screenshot',
          image_base64: buf.toString('base64'),
          mime_type: 'image/png',
          url: page.url(),
          title: await page.title()
        }));
      } else if (act === 'click') {
        if (!req.selector) throw new Error("Parameter 'selector' is required for action 'click'");
        await page.click(req.selector, { timeout: 15000 });
        console.log(JSON.stringify({
          success: true,
          action: 'click',
          selector: req.selector,
          url: page.url()
        }));
      } else if (act === 'fill') {
        if (!req.selector) throw new Error("Parameter 'selector' is required for action 'fill'");
        await page.fill(req.selector, req.value || '', { timeout: 15000 });
        console.log(JSON.stringify({
          success: true,
          action: 'fill',
          selector: req.selector,
          value: req.value || '',
          url: page.url()
        }));
      } else if (act === 'close') {
        await browser.close();
        console.log(JSON.stringify({ success: true, action: 'close' }));
        process.exit(0);
      } else {
        console.log(JSON.stringify({ success: false, error: 'Unsupported action: ' + act }));
      }
    } catch (err) {
      console.log(JSON.stringify({ success: false, error: err.message, action: req.action }));
    }
  }
})();
"""
        proc = subprocess.Popen(
            [node, "-e", runner_js],
            env={**os.environ, "ZEROCHAT_PLAYWRIGHT_MODULE": str(playwright_service_module())},
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1
        )
        self._process = proc
        first_line = proc.stdout.readline()
        if not first_line:
            err = proc.stderr.read()
            self._process = None
            raise RuntimeError(f"Failed to initialize headless browser: {err or 'process terminated unexpectedly'}")
        data = json.loads(first_line)
        if not data.get("ready"):
            self._process = None
            raise RuntimeError(data.get("error", "Unknown error starting browser"))

        return proc

    def execute(self, command: dict) -> dict:
        with self._lock:
            try:
                proc = self._ensure_running()
            except Exception as e:
                return {"success": False, "error": str(e)}

            req_json = json.dumps(command, ensure_ascii=False) + "\n"
            try:
                proc.stdin.write(req_json)
                proc.stdin.flush()
                resp_line = proc.stdout.readline()
                if not resp_line:
                    self.close()
                    return {"success": False, "error": "Browser process closed unexpectedly."}
                return json.loads(resp_line)
            except Exception as e:
                self.close()
                return {"success": False, "error": f"Error executing browser action: {e}"}

    def close(self):
        with self._lock:
            if self._process is not None:
                try:
                    if self._process.poll() is None:
                        try:
                            self._process.stdin.write(json.dumps({"action": "close"}) + "\n")
                            self._process.stdin.flush()
                            self._process.wait(timeout=2)
                        except (OSError, subprocess.SubprocessError):
                            self._process.kill()
                except (OSError, subprocess.SubprocessError):
                    pass
                self._process = None


_BROWSER_SESSION = PersistentBrowserSession()


def browser_action_availability() -> dict:
    """Comprueba requisitos locales sin lanzar Node.js ni Chromium."""
    if not shutil.which("node"):
        return {"available": False, "error": "Node.js is not installed or not found in system PATH."}
    # Solo el Playwright del servicio, no el node_modules de la carpeta desde la que arranca el servidor.
    if not playwright_service_cli().is_file():
        return {"available": False, "error": "Playwright is not available."}
    # El runner prueba las entradas de Chromium de Playwright y los canales chrome y msedge.
    browsers = system_browsers()
    if cached_engine_entries() & set(ENGINE_CACHE_ENTRIES["chromium"]) or browsers["chrome"] or browsers["msedge"]:
        return {"available": True}
    return {"available": False, "error": "Playwright Chromium is not installed."}


def playwright_status() -> dict:
    """Playwright del servicio y browser_action tal como están ahora, para el latido del cliente."""
    return {"installed": playwright_service_cli().is_file(), "browserAction": browser_action_availability()}


def browser_action(action: str, url: str | None = None, selector: str | None = None, value: str | None = None) -> str:
    """Control a headless browser for UI testing and visual inspection."""
    try:
        act = (action or "").strip().lower()
        if act not in BROWSER_ACTIONS:
            return _tool_error(f"Invalid browser action: '{action}'. Valid actions: {', '.join(BROWSER_ACTIONS)}.")

        cmd = {"action": act}
        if url:
            cmd["url"] = str(url).strip()
        if selector:
            cmd["selector"] = str(selector).strip()
        if value is not None:
            cmd["value"] = str(value)

        result = _BROWSER_SESSION.execute(cmd)
        return json.dumps(result, ensure_ascii=False, indent=2)
    except Exception as e:
        return _tool_error(str(e))


LOCAL_TOOLS_DEFINITIONS = [
    {
        "name": "list_directory",
        "description": "List files and directories in a local directory with safe bounded recursive traversal.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "maxLength": MAX_PATH_LENGTH, "description": "Relative or absolute directory path (defaults to '.')"},
                "recursive": {"type": "boolean", "description": "If true, traverses subdirectories up to depth 3", "default": False}
            }
        }
    },
    {
        "name": "read_file",
        "description": "Read a text file, whole or by line range.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "maxLength": MAX_PATH_LENGTH, "description": "File path"},
                "start_line": {"type": "integer", "description": "First line (1-based)", "default": 1},
                "end_line": {"type": "integer", "description": "Last line (inclusive)"},
                "max_lines": {"type": "integer", "description": "Line cap if no end_line", "default": 500},
                "max_bytes": {"type": "integer", "description": "Byte cap", "default": 100000}
            },
            "required": ["path"]
        }
    },
    {
        "name": "write_file",
        "description": "Create or overwrite a file completely and atomically.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "maxLength": MAX_PATH_LENGTH, "description": "Path to the file to write"},
                "content": {"type": "string", "maxLength": MAX_HTTP_BODY_BYTES, "description": "Full content of the file"}
            },
            "required": ["path", "content"]
        }
    },
    {
        "name": "edit_file",
        "description": (
            "Replace old_str with new_str in an existing file. "
            "For several changes, in this file or in others, emit several edit_file calls in the same response; "
            "they are applied in order, each one on the result of the previous one."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "maxLength": MAX_PATH_LENGTH, "description": "File path"},
                "old_str": {"type": "string", "maxLength": MAX_HTTP_BODY_BYTES, "description": "Exact text to replace; must occur once unless replace_all is true"},
                "new_str": {"type": "string", "maxLength": MAX_HTTP_BODY_BYTES, "description": "Replacement text"},
                "replace_all": {"type": "boolean", "description": "Replace every occurrence of old_str (e.g. to rename an identifier)", "default": False}
            },
            "required": ["path", "old_str", "new_str"]
        }
    },
    {
        "name": "search_files",
        "description": "Recursively search for plain text or regular expressions across project files.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "maxLength": 4096, "description": "Plain text string or regular expression to search for"},
                "path": {"type": "string", "maxLength": MAX_PATH_LENGTH, "description": "Base search directory (defaults to '.')", "default": "."},
                "file_pattern": {"type": "string", "maxLength": 256, "description": "Optional glob filter (e.g. *.js, *.py)"},
                "max_results": {"type": "integer", "description": "Maximum number of matching lines to return (default 100, max 500)", "default": 100}
            },
            "required": ["query"]
        }
    },
    {
        "name": "run_command",
        "description": (
            "Run a PowerShell command in the project directory and return its exit code and output (stdout and stderr combined). "
            "Each call starts a fresh PowerShell in the project directory: Set-Location and $env: changes do not carry over to later calls, "
            "so chain them with ; in the same command. "
            if DETECTED_OS == "windows"
            else
            "Run a shell command (bash) in the project directory and return its exit code and output (stdout and stderr combined). "
            "Each call starts a fresh shell in the project directory: cd, export or source/activate do not carry over to later calls, "
            "so chain them with && in the same command. "
        ) + (
            "By default it waits up to timeout_seconds and kills the command if it has not finished. "
            "Use background=true for servers, watchers or anything that does not finish on its own; "
            f"then follow or stop it with check_command. Host OS: {DETECTED_OS}."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "maxLength": MAX_COMMAND_LENGTH,
                    "description": (
                        "PowerShell command to run (e.g. git status; npm test)"
                        if DETECTED_OS == "windows"
                        else "Shell command to run (e.g. git status, npm test)"
                    )
                },
                "timeout_seconds": {"type": "integer", "description": f"Seconds to wait before killing the command (default {COMMAND_DEFAULT_TIMEOUT}, max {COMMAND_MAX_TIMEOUT}). Ignored with background=true.", "default": COMMAND_DEFAULT_TIMEOUT},
                "background": {"type": "boolean", "description": "Return after a few seconds and keep the command running; returns a job_id for check_command.", "default": False}
            },
            "required": ["command"]
        }
    },
    {
        "name": "check_command",
        "description": "Check a command started by run_command: returns its status and the output produced since the last check. Use wait_seconds to wait for it to finish, or stop=true to terminate it.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "job_id": {"type": "integer", "description": "job_id returned by run_command"},
                "wait_seconds": {"type": "integer", "description": f"Seconds to wait for the command to finish before returning (default 0, max {COMMAND_MAX_WAIT})", "default": 0},
                "stop": {"type": "boolean", "description": "Terminate the command and its child processes", "default": False}
            },
            "required": ["job_id"]
        }
    },
    {
        "name": "get_diagnostics",
        "description": "Retrieve syntax diagnostics and code errors for a file or the entire workspace.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "maxLength": MAX_PATH_LENGTH, "description": "Path to the file or directory to inspect (defaults to '.')"}
            }
        }
    },
    {
        "name": "browser_action",
        "description": "Control a headless browser (Playwright) for web navigation, UI testing, and visual inspection via screenshots.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": list(BROWSER_ACTIONS),
                    "maxLength": 32,
                    "description": "Action to perform in the browser"
                },
                "url": {"type": "string", "maxLength": 4096, "description": "Target URL for navigate or screenshot"},
                "selector": {"type": "string", "maxLength": 1024, "description": "CSS selector for click or fill actions"},
                "value": {"type": "string", "maxLength": MAX_HTTP_BODY_BYTES, "description": "Text value to type for fill action"}
            },
            "required": ["action"]
        }
    }
]

LOCAL_TOOL_HANDLERS = {
    "list_directory": list_directory,
    "read_file": read_file,
    "write_file": write_file,
    "edit_file": edit_file,
    "run_command": run_command,
    "check_command": check_command,
    "search_files": search_files,
    "get_diagnostics": get_diagnostics,
    "browser_action": browser_action
}
