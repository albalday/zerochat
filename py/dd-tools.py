# ==============================================================================
# Herramientas Locales Core
# ==============================================================================

def list_directory(path: str = ".", recursive: bool = False) -> str:
    """List files and directories in a local directory with safe bounded recursive traversal."""
    try:
        target = Path(path).expanduser().resolve()
        if not target.exists():
            return json.dumps({"success": False, "error": f"Path '{path}' does not exist."}, ensure_ascii=False)
        if not target.is_dir():
            return json.dumps({"success": False, "error": f"Path '{path}' is not a directory."}, ensure_ascii=False)

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
    """Read text content from a local file in streaming mode with safe ranges and bounds."""
    try:
        target = Path(path).expanduser().resolve()
        if not target.exists():
            return json.dumps({"success": False, "error": f"File '{path}' does not exist."}, ensure_ascii=False)
        if not target.is_file():
            return json.dumps({"success": False, "error": f"Path '{path}' is not a regular file."}, ensure_ascii=False)

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
    """Create or overwrite a file completely and atomically."""
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
    """Modify an existing file surgically or atomically."""
    try:
        target = Path(path).expanduser().resolve()

        # Preferred surgical mode (old_str -> new_str)
        if old_str is not None and new_str is not None:
            if not target.exists():
                return json.dumps({"success": False, "error": f"File '{path}' does not exist. Use read_file to verify existing paths."}, ensure_ascii=False)
            if not target.is_file():
                return json.dumps({"success": False, "error": f"Path '{path}' is not a regular file."}, ensure_ascii=False)

            with open(target, "r", encoding="utf-8", errors="replace") as f:
                file_text = f.read()

            occurrences = file_text.count(old_str)
            if occurrences == 0:
                return json.dumps({
                    "success": False,
                    "error": f"Target text was not found in '{path}'. Check exact file content with read_file."
                }, ensure_ascii=False)
            if occurrences > 1:
                return json.dumps({
                    "success": False,
                    "error": f"Found {occurrences} matches for the snippet in '{path}'. Provide more surrounding context in old_str to ensure a unique match."
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

        # Legacy modes (write, append, replace_chunk)
        if content is None:
            return json.dumps({"success": False, "error": "Must provide old_str and new_str for surgical edit, or content for compatible modes."}, ensure_ascii=False)

        target.parent.mkdir(parents=True, exist_ok=True)
        if mode == "append":
            with open(target, "a", encoding="utf-8") as f:
                f.write(content)
            bytes_written = len(content.encode("utf-8"))
        elif mode == "replace_chunk":
            if not target.exists():
                return json.dumps({"success": False, "error": f"File '{path}' does not exist for replace_chunk."}, ensure_ascii=False)
            if not target_content:
                return json.dumps({"success": False, "error": "target_content is required in replace_chunk mode."}, ensure_ascii=False)

            with open(target, "r", encoding="utf-8", errors="replace") as f:
                existing = f.read()

            if target_content not in existing:
                return json.dumps({"success": False, "error": "target_content was not found in the file."}, ensure_ascii=False)

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
    """Outputs >8,000 characters are truncated to first 50 lines + warning + last 30 lines."""
    if len(text) <= max_chars:
        return text, False
    lines = text.splitlines(keepends=True)
    if len(lines) <= head_lines + tail_lines:
        half = max_chars // 2
        return (
            text[:half]
            + f"\n\n[... Output truncated due to length ({len(text)} total characters) ...]\n\n"
            + text[-half:],
            True
        )
    omitted = len(lines) - head_lines - tail_lines
    head = "".join(lines[:head_lines])
    tail = "".join(lines[-tail_lines:])
    warning = f"\n\n[... Output truncated: omitted {omitted} lines ({len(text)} total characters) ...]\n\n"
    return head + warning + tail, True


class PersistentBashSession:
    """Maintains working directory (cwd) and environment variables across successive calls."""
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
                        "error": f"Command timed out after {timeout_seconds} seconds (terminated with SIGKILL).",
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
    """Execute a command in an interactive persistent bash shell session."""
    return BASH_SESSION.run(command, timeout_seconds=timeout_seconds)


def execute_command(command: str, cwd: str = ".", timeout_seconds: int = 60) -> str:
    """Execute a command in the system shell and capture stdout and stderr."""
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
        return json.dumps({"success": False, "error": f"Command timed out after {timeout_seconds} seconds."}, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)


def search_files(query: str, path: str = ".", file_pattern: str = None, max_results: int = 100) -> str:
    """Recursively search for plain text or regular expressions across project files."""
    try:
        target = Path(path).expanduser().resolve()
        if not target.exists():
            return json.dumps({"success": False, "error": f"Path '{path}' does not exist."}, ensure_ascii=False)
        if not target.is_dir():
            return json.dumps({"success": False, "error": f"Path '{path}' is not a directory."}, ensure_ascii=False)

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


def get_diagnostics(path: str | None = None) -> str:
    """Retrieve syntax diagnostics and code errors for a file or the entire workspace."""
    try:
        if path is not None and str(path).strip():
            target = Path(str(path).strip()).expanduser().resolve()
        else:
            target = Path.cwd().resolve()

        if not target.exists():
            return json.dumps({
                "success": False,
                "error": f"Path '{path}' does not exist."
            }, ensure_ascii=False)

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
                    except Exception:
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
            ignore_dirs = {".git", "node_modules", ".venv", "venv", "dist", "build", "__pycache__", ".gemini", ".cache"}
            max_scan = 200
            for root, dirs, files in os.walk(target):
                dirs[:] = [d for d in dirs if d not in ignore_dirs and not d.startswith(".")]
                for fname in sorted(files):
                    fp = Path(root) / fname
                    if fp.suffix.lower() in (".py", ".js", ".mjs", ".cjs", ".json"):
                        files_checked += 1
                        diagnostics.extend(check_single_file(fp))
                        if files_checked >= max_scan:
                            break
                if files_checked >= max_scan:
                    break

        error_count = sum(1 for d in diagnostics if d.get("severity") == "error")
        warning_count = sum(1 for d in diagnostics if d.get("severity") == "warning")
        msg = f"Found {len(diagnostics)} issue(s)." if diagnostics else "No diagnostic issues found."

        return json.dumps({
            "success": True,
            "path": str(target),
            "files_checked": files_checked,
            "error_count": error_count,
            "warning_count": warning_count,
            "diagnostics": diagnostics,
            "message": msg
        }, ensure_ascii=False, indent=2)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)


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
  playwright = require('playwright');
} catch (e1) {
  try {
    const path = require('path');
    const home = process.env.HOME || process.env.USERPROFILE || '';
    playwright = require(path.join(home, 'zerochat', 'services', 'playwright', 'node_modules', 'playwright'));
  } catch (e2) {
    console.log(JSON.stringify({
      success: false,
      error: "Playwright is not available. Install it with 'npm install playwright' or enable the Playwright MCP service."
    }));
    process.exit(1);
  }
}

(async () => {
  let browser, context, page;
  try {
    const candidates = [
      {},                      // 1. Playwright bundled Chromium
      { channel: 'chrome' },   // 2. System Google Chrome
      { channel: 'msedge' },   // 3. System Microsoft Edge (Windows 10/11)
      { channel: 'chromium' }  // 4. System Chromium (/usr/bin/chromium)
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
                        except Exception:
                            self._process.kill()
                except Exception:
                    pass
                self._process = None


_BROWSER_SESSION = PersistentBrowserSession()


def browser_action_availability() -> dict:
    """Comprueba requisitos locales sin lanzar Node.js ni Chromium."""
    if not shutil.which("node"):
        return {"available": False, "error": "Node.js is not installed or not found in system PATH."}
    playwright_locations = (
        Path.cwd() / "node_modules" / "playwright",
        get_data_dir() / "services" / "playwright" / "node_modules" / "playwright"
    )
    if not any(location.is_dir() for location in playwright_locations):
        return {"available": False, "error": "Playwright is not available."}
    browser_commands = (
        "google-chrome", "google-chrome-stable", "chromium", "chromium-browser",
        "msedge", "msedge.exe", "chrome", "chrome.exe"
    )
    if sys.platform == "darwin":
        playwright_cache = Path.home() / "Library" / "Caches" / "ms-playwright"
    elif sys.platform.startswith("win"):
        playwright_cache = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local")) / "ms-playwright"
    else:
        playwright_cache = Path.home() / ".cache" / "ms-playwright"
    try:
        has_playwright_browser = playwright_cache.is_dir() and any(
            child.is_dir() and child.name.startswith("chromium")
            for child in playwright_cache.iterdir()
        )
    except OSError:
        has_playwright_browser = False
    if has_playwright_browser or any(shutil.which(command) for command in browser_commands):
        return {"available": True}
    return {"available": False, "error": "Playwright Chromium is not installed."}


def browser_action(action: str, url: str | None = None, selector: str | None = None, value: str | None = None) -> str:
    """Control a headless browser for UI testing and visual inspection."""
    try:
        act = (action or "").strip().lower()
        if act not in ("navigate", "screenshot", "click", "fill"):
            return json.dumps({
                "success": False,
                "error": f"Invalid browser action: '{action}'. Valid actions: navigate, screenshot, click, fill."
            }, ensure_ascii=False)

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
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)


LOCAL_TOOLS_DEFINITIONS = [
    {
        "name": "list_directory",
        "description": "List files and directories in a local directory with safe bounded recursive traversal.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Relative or absolute directory path (defaults to '.')"},
                "recursive": {"type": "boolean", "description": "If true, traverses subdirectories up to depth 3", "default": False}
            }
        }
    },
    {
        "name": "read_file",
        "description": "Read text content from a local file with safe ranges and bounds.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Path to the file to read"},
                "start_line": {"type": "integer", "description": "Starting line number (1-indexed)", "default": 1},
                "end_line": {"type": "integer", "description": "Ending line number (inclusive)"},
                "max_lines": {"type": "integer", "description": "Maximum number of lines to read when end_line is omitted", "default": 500},
                "max_bytes": {"type": "integer", "description": "Maximum byte budget", "default": 100000}
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
                "path": {"type": "string", "description": "Path to the file to write"},
                "content": {"type": "string", "description": "Full content of the file"}
            },
            "required": ["path", "content"]
        }
    },
    {
        "name": "edit_file",
        "description": "Edit an existing file surgically by replacing old_str with new_str (must match exactly once).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Path to the file to edit"},
                "old_str": {"type": "string", "description": "Exact snippet to replace (must appear exactly once in the file)"},
                "new_str": {"type": "string", "description": "Replacement snippet"},
                "content": {"type": "string", "description": "Content to write in legacy/compatible mode"},
                "mode": {"type": "string", "enum": ["surgical", "write", "append", "replace_chunk"], "default": "surgical"},
                "target_content": {"type": "string", "description": "Exact target content in replace_chunk mode"}
            },
            "required": ["path"]
        }
    },
    {
        "name": "bash",
        "description": "Execute a command in an interactive persistent shell session (preserves cwd and exported environment variables across calls).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "Shell command to execute (e.g. npm test, git status)"},
                "timeout_seconds": {"type": "integer", "description": "Timeout in seconds (defaults to 30)", "default": 30}
            },
            "required": ["command"]
        }
    },
    {
        "name": "search_files",
        "description": "Recursively search for plain text or regular expressions across project files.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Plain text string or regular expression to search for"},
                "path": {"type": "string", "description": "Base search directory (defaults to '.')", "default": "."},
                "file_pattern": {"type": "string", "description": "Optional glob filter (e.g. *.js, *.py)"}
            },
            "required": ["query"]
        }
    },
    {
        "name": "execute_command",
        "description": "Execute a shell command and capture stdout/stderr.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "Command to execute"},
                "cwd": {"type": "string", "description": "Working directory (defaults to '.')"},
                "timeout_seconds": {"type": "integer", "description": "Timeout in seconds (defaults to 60)", "default": 60}
            },
            "required": ["command"]
        }
    },
    {
        "name": "get_diagnostics",
        "description": "Retrieve syntax diagnostics and code errors for a file or the entire workspace.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Path to the file or directory to inspect (defaults to '.')"}
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
                    "enum": ["navigate", "screenshot", "click", "fill"],
                    "description": "Action to perform in the browser"
                },
                "url": {"type": "string", "description": "Target URL for navigate or screenshot"},
                "selector": {"type": "string", "description": "CSS selector for click or fill actions"},
                "value": {"type": "string", "description": "Text value to type for fill action"}
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
    "bash": bash,
    "search_files": search_files,
    "execute_command": execute_command,
    "get_diagnostics": get_diagnostics,
    "browser_action": browser_action
}
