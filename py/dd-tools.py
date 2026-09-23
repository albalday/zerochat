# ==============================================================================
# Herramientas Locales Core
# ==============================================================================

def list_directory(path: str = ".", recursive: bool = False) -> str:
    """Lista los archivos y carpetas de un directorio local, con soporte recursivo acotado."""
    try:
        target = Path(path).expanduser().resolve()
        if not target.exists():
            return json.dumps({"success": False, "error": f"La ruta '{path}' no existe."}, ensure_ascii=False)
        if not target.is_dir():
            return json.dumps({"success": False, "error": f"La ruta '{path}' no es un directorio."}, ensure_ascii=False)

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
                            entry_data = {
                                "name": entry.name,
                                "path": str(Path(entry.path).resolve()),
                                "type": "directory" if is_dir else "file",
                                "size_bytes": None if is_dir else stat.st_size,
                                "is_symlink": entry.is_symlink()
                            }
                            if recursive:
                                entry_data["relative_path"] = str(Path(entry.path).resolve().relative_to(target))
                            entries.append(entry_data)
                            if recursive and is_dir and not entry.is_symlink():
                                _scan(Path(entry.path), current_depth + 1)
                        except (PermissionError, FileNotFoundError):
                            continue
            except (PermissionError, FileNotFoundError):
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
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)


def read_file(path: str, start_line: int = 1, end_line: int = None, max_lines: int = 500, max_bytes: int = 100000) -> str:
    """Lee el contenido de texto de un archivo local en streaming con rangos y límites seguros."""
    try:
        target = Path(path).expanduser().resolve()
        if not target.exists():
            return json.dumps({"success": False, "error": f"El archivo '{path}' no existe."}, ensure_ascii=False)
        if not target.is_file():
            return json.dumps({"success": False, "error": f"La ruta '{path}' no es un archivo regular."}, ensure_ascii=False)

        file_size = target.stat().st_size
        safe_max_bytes = max(1024, min(int(max_bytes), 2000000))
        safe_start_line = max(1, int(start_line))

        if end_line is not None:
            safe_end_line = max(safe_start_line, int(end_line))
            target_line_count = safe_end_line - safe_start_line + 1
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
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)


def write_file(path: str, content: str) -> str:
    """Crea o sobrescribe un archivo completo de forma atómica."""
    try:
        target = Path(path).expanduser().resolve()
        target.parent.mkdir(parents=True, exist_ok=True)
        temp_path = target.with_suffix(target.suffix + f".tmp_{os.getpid()}_{time.time_ns()}")
        with open(temp_path, "w", encoding="utf-8") as f:
            f.write(content)
        temp_path.replace(target)
        bytes_written = len(content.encode("utf-8"))
        return json.dumps({
            "success": True,
            "path": str(target),
            "bytes_written": bytes_written
        }, ensure_ascii=False, indent=2)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)


def edit_file(path: str, old_str: str = None, new_str: str = None, content: str = None, mode: str = "surgical", target_content: str = None) -> str:
    """Modifica un archivo existente de forma quirúrgica o atómica."""
    try:
        target = Path(path).expanduser().resolve()

        # Modo quirúrgico preferido (old_str -> new_str)
        if old_str is not None and new_str is not None:
            if not target.exists():
                return json.dumps({"success": False, "error": f"El archivo '{path}' no existe. Usa read_file para verificar las rutas existentes."}, ensure_ascii=False)
            if not target.is_file():
                return json.dumps({"success": False, "error": f"La ruta '{path}' no es un archivo regular."}, ensure_ascii=False)

            with open(target, "r", encoding="utf-8", errors="replace") as f:
                file_text = f.read()

            occurrences = file_text.count(old_str)
            if occurrences == 0:
                return json.dumps({
                    "success": False,
                    "error": f"No se encontró el texto especificado en '{path}'. Comprueba el contenido exacto del archivo con read_file."
                }, ensure_ascii=False)
            if occurrences > 1:
                return json.dumps({
                    "success": False,
                    "error": f"Se encontraron {occurrences} coincidencias para el fragmento en '{path}'. Proporciona mayor contexto circundante en old_str para que la sustitución sea unívoca."
                }, ensure_ascii=False)

            updated_text = file_text.replace(old_str, new_str, 1)
            temp_path = target.with_suffix(target.suffix + f".tmp_{os.getpid()}_{time.time_ns()}")
            with open(temp_path, "w", encoding="utf-8") as f:
                f.write(updated_text)
            temp_path.replace(target)
            return json.dumps({
                "success": True,
                "path": str(target),
                "mode": "surgical",
                "bytes_written": len(updated_text.encode("utf-8")),
                "replacements": 1
            }, ensure_ascii=False, indent=2)

        # Modos legados (write, append, replace_chunk)
        if content is None:
            return json.dumps({"success": False, "error": "Debes proporcionar old_str y new_str para edición quirúrgica, o content para modos compatibles."}, ensure_ascii=False)

        target.parent.mkdir(parents=True, exist_ok=True)
        if mode == "append":
            with open(target, "a", encoding="utf-8") as f:
                f.write(content)
            bytes_written = len(content.encode("utf-8"))
        elif mode == "replace_chunk":
            if not target.exists():
                return json.dumps({"success": False, "error": f"El archivo '{path}' no existe para replace_chunk."}, ensure_ascii=False)
            if not target_content:
                return json.dumps({"success": False, "error": "target_content es obligatorio en modo replace_chunk."}, ensure_ascii=False)

            with open(target, "r", encoding="utf-8", errors="replace") as f:
                existing = f.read()

            if target_content not in existing:
                return json.dumps({"success": False, "error": "target_content no fue encontrado en el archivo."}, ensure_ascii=False)

            new_text = existing.replace(target_content, content, 1)
            temp_path = target.with_suffix(target.suffix + f".tmp_{os.getpid()}_{time.time_ns()}")
            with open(temp_path, "w", encoding="utf-8") as f:
                f.write(new_text)
            temp_path.replace(target)
            bytes_written = len(new_text.encode("utf-8"))
        else:  # write
            temp_path = target.with_suffix(target.suffix + f".tmp_{os.getpid()}_{time.time_ns()}")
            with open(temp_path, "w", encoding="utf-8") as f:
                f.write(content)
            temp_path.replace(target)
            bytes_written = len(content.encode("utf-8"))

        return json.dumps({
            "success": True,
            "path": str(target),
            "mode": mode,
            "bytes_written": bytes_written
        }, ensure_ascii=False, indent=2)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)


def truncate_terminal_output(text: str, max_chars: int = 8000, head_lines: int = 50, tail_lines: int = 30) -> tuple[str, bool]:
    """Salidas >8.000 caracteres se truncan a primeras 50 líneas + aviso + últimas 30 líneas."""
    if len(text) <= max_chars:
        return text, False
    lines = text.splitlines(keepends=True)
    if len(lines) <= head_lines + tail_lines:
        half = max_chars // 2
        return (
            text[:half]
            + f"\n\n[... Salida truncada por longitud ({len(text)} caracteres en total) ...]\n\n"
            + text[-half:],
            True
        )
    omitted = len(lines) - head_lines - tail_lines
    head = "".join(lines[:head_lines])
    tail = "".join(lines[-tail_lines:])
    warning = f"\n\n[... Salida truncada: se omitieron {omitted} líneas ({len(text)} caracteres en total) ...]\n\n"
    return head + warning + tail, True


class PersistentBashSession:
    """Mantiene el directorio de trabajo (cwd) y variables de entorno entre llamadas sucesivas."""
    def __init__(self):
        self._dir = tempfile.mkdtemp(prefix="zerochat_bash_")
        self._cwd_file = Path(self._dir) / "cwd"
        self._env_file = Path(self._dir) / "env.sh"
        self._cwd = str(Path.cwd().resolve())
        self._lock = threading.Lock()
        atexit.register(self.cleanup)

    def cleanup(self):
        try:
            shutil.rmtree(self._dir, ignore_errors=True)
        except Exception:
            pass

    def run(self, command: str, timeout_seconds: int = 30) -> str:
        with self._lock:
            safe_timeout = max(1, min(int(timeout_seconds), 300))
            runner_script = Path(self._dir) / f"runner_{time.time_ns()}.sh"

            script_content = (
                "if [ -f " + shlex.quote(str(self._env_file)) + " ]; then\n"
                "  . " + shlex.quote(str(self._env_file)) + " 2>/dev/null || true\n"
                "fi\n"
                "cd " + shlex.quote(self._cwd) + " 2>/dev/null || true\n"
                "trap '__ret=$?; pwd > " + shlex.quote(str(self._cwd_file)) + "; export -p > " + shlex.quote(str(self._env_file)) + " 2>/dev/null || true; exit $__ret' EXIT\n"
                + command + "\n"
            )

            try:
                with open(runner_script, "w", encoding="utf-8") as f:
                    f.write(script_content)
                runner_script.chmod(0o700)

                proc = subprocess.Popen(
                    ["bash", str(runner_script)],
                    cwd=self._cwd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    start_new_session=True if hasattr(os, "setsid") else False
                )

                try:
                    stdout, stderr = proc.communicate(timeout=safe_timeout)
                    returncode = proc.returncode
                except subprocess.TimeoutExpired:
                    try:
                        if hasattr(os, "killpg") and hasattr(os, "getpgid"):
                            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
                        else:
                            proc.kill()
                    except Exception:
                        try:
                            proc.kill()
                        except Exception:
                            pass
                    proc.communicate()
                    return json.dumps({
                        "success": False,
                        "error": f"Comando excedió el tiempo límite de {timeout_seconds} segundos (terminado con SIGKILL).",
                        "cwd": self._cwd
                    }, ensure_ascii=False)

                if self._cwd_file.is_file():
                    try:
                        saved_cwd = self._cwd_file.read_text(encoding="utf-8").strip()
                        if saved_cwd and Path(saved_cwd).is_dir():
                            self._cwd = saved_cwd
                    except Exception:
                        pass

                truncated_out, was_out_trunc = truncate_terminal_output(stdout)
                truncated_err, was_err_trunc = truncate_terminal_output(stderr)

                return json.dumps({
                    "success": returncode == 0,
                    "returncode": returncode,
                    "stdout": truncated_out,
                    "stderr": truncated_err,
                    "cwd": self._cwd,
                    "truncated": was_out_trunc or was_err_trunc
                }, ensure_ascii=False, indent=2)

            except Exception as e:
                return json.dumps({"success": False, "error": str(e), "cwd": self._cwd}, ensure_ascii=False)
            finally:
                try:
                    if runner_script.is_file():
                        runner_script.unlink()
                except Exception:
                    pass


BASH_SESSION = PersistentBashSession()


def bash(command: str, timeout_seconds: int = 30) -> str:
    """Ejecuta un comando en la shell bash interactiva persistente."""
    return BASH_SESSION.run(command, timeout_seconds=timeout_seconds)


def execute_command(command: str, cwd: str = ".", timeout_seconds: int = 60) -> str:
    """Ejecuta un comando en la shell del sistema y devuelve stdout y stderr."""
    if cwd == "." or cwd == BASH_SESSION._cwd:
        return BASH_SESSION.run(command, timeout_seconds=timeout_seconds)
    try:
        target_cwd = Path(cwd).expanduser().resolve()
        if not target_cwd.exists() or not target_cwd.is_dir():
            target_cwd = Path.cwd()

        proc = subprocess.run(
            command,
            cwd=str(target_cwd),
            shell=True,
            capture_output=True,
            text=True,
            timeout=max(1, min(int(timeout_seconds), 300)),
            encoding="utf-8",
            errors="replace"
        )
        trunc_out, was_out_trunc = truncate_terminal_output(proc.stdout)
        trunc_err, was_err_trunc = truncate_terminal_output(proc.stderr)
        return json.dumps({
            "success": proc.returncode == 0,
            "returncode": proc.returncode,
            "stdout": trunc_out,
            "stderr": trunc_err,
            "cwd": str(target_cwd),
            "truncated": was_out_trunc or was_err_trunc
        }, ensure_ascii=False, indent=2)
    except subprocess.TimeoutExpired:
        return json.dumps({"success": False, "error": f"Comando excedió el tiempo límite de {timeout_seconds} segundos."}, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)


def search_files(query: str, path: str = ".", file_pattern: str = None, max_results: int = 100) -> str:
    """Búsqueda recursiva por texto plano o expresión regular en archivos del proyecto."""
    try:
        target = Path(path).expanduser().resolve()
        if not target.exists():
            return json.dumps({"success": False, "error": f"La ruta '{path}' no existe."}, ensure_ascii=False)
        if not target.is_dir():
            return json.dumps({"success": False, "error": f"La ruta '{path}' no es un directorio."}, ensure_ascii=False)

        try:
            regex = re.compile(query, re.MULTILINE)
        except re.error:
            regex = re.compile(re.escape(query), re.MULTILINE)

        ignored_dirs = {".git", ".venv", "node_modules", "__pycache__", ".pytest_cache", ".cache"}
        matches = []
        files_searched = 0
        max_file_size = 2 * 1024 * 1024
        truncated = False

        for root, dirs, files in os.walk(target):
            dirs[:] = [d for d in dirs if d not in ignored_dirs and not d.startswith(".")]

            for fname in sorted(files):
                if file_pattern and not fnmatch.fnmatch(fname, file_pattern):
                    continue

                fpath = Path(root) / fname
                try:
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
                                if len(matches) >= max_results:
                                    truncated = True
                                    break
                except (PermissionError, OSError):
                    continue

                if truncated:
                    break
            if truncated:
                break

        return json.dumps({
            "success": True,
            "path": str(target),
            "query": query,
            "file_pattern": file_pattern,
            "files_searched": files_searched,
            "total_matches": len(matches),
            "truncated": truncated,
            "matches": matches
        }, ensure_ascii=False, indent=2)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)


LOCAL_TOOLS_DEFINITIONS = [
    {
        "name": "list_directory",
        "description": "Lista archivos y carpetas de un directorio local, con soporte recursivo acotado.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Ruta relativa o absoluta (por defecto '.')"},
                "recursive": {"type": "boolean", "description": "Si es true, recorre subdirectorios hasta profundidad 3", "default": False}
            }
        }
    },
    {
        "name": "read_file",
        "description": "Lee el contenido de texto de un archivo local con rangos y límites seguros.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Ruta del archivo"},
                "start_line": {"type": "integer", "description": "Línea inicial (1-indexed)", "default": 1},
                "end_line": {"type": "integer", "description": "Línea final inclusiva"},
                "max_lines": {"type": "integer", "description": "Número máximo de líneas a leer si no se especifica end_line", "default": 500},
                "max_bytes": {"type": "integer", "description": "Límite máximo de bytes", "default": 100000}
            },
            "required": ["path"]
        }
    },
    {
        "name": "write_file",
        "description": "Crea o sobrescribe un archivo completo de forma atómica.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Ruta del archivo a escribir"},
                "content": {"type": "string", "description": "Contenido completo del archivo"}
            },
            "required": ["path", "content"]
        }
    },
    {
        "name": "edit_file",
        "description": "Edita un archivo existente reemplazando quirúrgicamente old_str por new_str (debe coincidir exactamente 1 vez).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Ruta del archivo a editar"},
                "old_str": {"type": "string", "description": "Fragmento exacto a sustituir (debe ser único en el archivo)"},
                "new_str": {"type": "string", "description": "Nuevo fragmento de reemplazo"},
                "content": {"type": "string", "description": "Contenido a escribir en modo compatible"},
                "mode": {"type": "string", "enum": ["surgical", "write", "append", "replace_chunk"], "default": "surgical"},
                "target_content": {"type": "string", "description": "Texto exacto en modo replace_chunk"}
            },
            "required": ["path"]
        }
    },
    {
        "name": "bash",
        "description": "Ejecuta un comando en la shell interactiva con estado persistente (mantiene cwd y variables de entorno entre llamadas).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "Comando de shell a ejecutar (ej: npm test, git diff)"},
                "timeout_seconds": {"type": "integer", "description": "Tiempo límite en segundos (por defecto 30)", "default": 30}
            },
            "required": ["command"]
        }
    },
    {
        "name": "search_files",
        "description": "Búsqueda recursiva por texto plano o expresión regular en archivos del proyecto.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Cadena o expresión regular a buscar"},
                "path": {"type": "string", "description": "Carpeta base de búsqueda (por defecto '.')", "default": "."},
                "file_pattern": {"type": "string", "description": "Filtro glob opcional (ej: *.js, *.py)"}
            },
            "required": ["query"]
        }
    },
    {
        "name": "execute_command",
        "description": "Ejecuta un comando en la shell del sistema y captura la salida.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "Comando a ejecutar"},
                "cwd": {"type": "string", "description": "Directorio de trabajo (por defecto '.')"},
                "timeout_seconds": {"type": "integer", "description": "Tiempo límite en segundos", "default": 60}
            },
            "required": ["command"]
        }
    }
]

LOCAL_TOOL_HANDLERS = {
    "list_directory": list_directory,
    "read_file": read_file,
    "write_file": write_file,
    "edit_file": edit_file,
    "bash": bash,
    "search_files": search_files,
    "execute_command": execute_command
}

