"""Visor de diferencias (zerochat/diff/open): diff frente a Git HEAD en HTML propio o con git difftool."""

from __future__ import annotations

import base64
import html
import os
import re
import shlex
import shutil
import subprocess
from pathlib import Path

from core.environment import ensure_virtual_environment, get_venv_dir, get_venv_python
from core.limits import MAX_PATH_LENGTH
from security.context import SecurityContext


# Visores gráficos que `git difftool` ya sabe lanzar, en orden de preferencia, con el ejecutable que los delata.
GUI_DIFF_TOOLS = {"vscode": "code", "meld": "meld", "kdiff3": "kdiff3", "kompare": "kompare", "gvimdiff": "gvim"}
# Respaldo cuando no hay ninguno: visor web que se instala en el entorno aislado de ZeroChat.
WEBDIFF_REQUIREMENT = "webdiff==1.4.0"
WEBDIFF_INSTALL_TIMEOUT_SECONDS = 120
DIFF_CONTEXT_LINES = 5


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
    """Herramienta gráfica que usaría `git difftool --gui`, o '' si no hay ninguna configurada."""
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


def _open_gui_file_diff(path: str, ctx: SecurityContext, commit_fallback: bool = False) -> dict:
    """Abre un visor externo de diffs (git difftool) en una ventana del sistema operativo."""
    if not isinstance(path, str) or not path.strip():
        raise ValueError("La ruta del archivo está vacía.")
    if len(path) > MAX_PATH_LENGTH:
        raise ValueError("La ruta del archivo excede el tamaño máximo permitido.")

    target = ctx.absolute(path)
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


def render_diff_html(
    diff_text: str,
    filename: str,
    rel_path: str = "",
    mode: str = "working_tree",
    commit: str | None = None,
    full_file_bytes: bytes | None = None
) -> str:
    """Genera una página HTML autocontenida y visualmente limpia con el diff para mostrar en una pestaña nueva."""
    diff_lines = diff_text.splitlines()
    rows = []
    old_num = 0
    new_num = 0
    in_hunk = False
    additions = 0
    deletions = 0

    hunk_re = re.compile(r"^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$")

    for line in diff_lines:
        hunk_match = hunk_re.match(line)
        if hunk_match:
            old_num = int(hunk_match.group(1))
            new_num = int(hunk_match.group(2))
            in_hunk = True
            rows.append({
                "type": "hunk",
                "old_num": "",
                "new_num": "",
                "sign": "@",
                "text": line,
            })
            continue

        if not in_hunk:
            rows.append({
                "type": "meta",
                "old_num": "",
                "new_num": "",
                "sign": " ",
                "text": line,
            })
            continue

        if line.startswith("+"):
            additions += 1
            rows.append({
                "type": "add",
                "old_num": "",
                "new_num": str(new_num),
                "sign": "+",
                "text": line[1:],
            })
            new_num += 1
        elif line.startswith("-"):
            deletions += 1
            rows.append({
                "type": "del",
                "old_num": str(old_num),
                "new_num": "",
                "sign": "-",
                "text": line[1:],
            })
            old_num += 1
        elif line.startswith(" "):
            rows.append({
                "type": "ctx",
                "old_num": str(old_num),
                "new_num": str(new_num),
                "sign": " ",
                "text": line[1:],
            })
            old_num += 1
            new_num += 1
        else:
            rows.append({
                "type": "meta",
                "old_num": "",
                "new_num": "",
                "sign": " ",
                "text": line,
            })

    table_rows = []
    for row in rows:
        r_type = row["type"]
        old_n = row["old_num"]
        new_n = row["new_num"]
        sign = html.escape(row["sign"])
        txt = html.escape(row["text"])
        table_rows.append(
            f'<tr class="row-{r_type}">'
            f'<td class="line-num">{old_n}</td>'
            f'<td class="line-num">{new_n}</td>'
            f'<td class="line-sign">{sign}</td>'
            f'<td class="line-code">{txt}</td>'
            f'</tr>'
        )

    mode_label = f"Commit {commit[:7]}" if (mode == "commit" and commit) else "Working Tree vs HEAD"
    display_title = filename or "diff"
    display_path = rel_path or filename or ""

    btn_html = ""
    script_html = ""
    if full_file_bytes is not None:
        b64_content = base64.b64encode(full_file_bytes).decode("ascii")
        btn_html = (
            '<button type="button" class="btn-full-file" onclick="openFullFile()">'
            '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
            '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>'
            '<polyline points="14 2 14 8 20 8"></polyline>'
            '<line x1="16" y1="13" x2="8" y2="13"></line>'
            '<line x1="16" y1="17" x2="8" y2="17"></line>'
            '<polyline points="10 9 9 9 8 9"></polyline>'
            '</svg>'
            '<span>Abrir fichero completo</span>'
            '</button>'
        )
        script_html = f"""  <script>
    function openFullFile() {{
      const b64 = "{b64_content}";
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {{
        bytes[i] = binary.charCodeAt(i);
      }}
      const blob = new Blob([bytes], {{ type: "text/plain;charset=utf-8" }});
      window.open(URL.createObjectURL(blob), "_blank");
    }}
  </script>"""

    return f"""<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Diff: {html.escape(display_title)}</title>
  <style>
    :root {{
      --bg: #ffffff;
      --fg: #1f2328;
      --header-bg: #f6f8fa;
      --border: #d0d7de;
      --hunk-bg: #ddf4ff;
      --hunk-fg: #0969da;
      --add-bg: #dafbe1;
      --add-fg: #1a7f37;
      --add-num-bg: #aceebb;
      --del-bg: #ffebe9;
      --del-fg: #cf222e;
      --del-num-bg: #ffd7d5;
      --meta-fg: #656d76;
      --linenum-fg: #8c959f;
      --linenum-bg: #f6f8fa;
      --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    }}
    @media (prefers-color-scheme: dark) {{
      :root {{
        --bg: #0d1117;
        --fg: #e6edf3;
        --header-bg: #161b22;
        --border: #30363d;
        --hunk-bg: rgba(56, 139, 253, 0.15);
        --hunk-fg: #58a6ff;
        --add-bg: rgba(46, 160, 67, 0.15);
        --add-fg: #3fb950;
        --add-num-bg: rgba(46, 160, 67, 0.25);
        --del-bg: rgba(248, 81, 73, 0.15);
        --del-fg: #f85149;
        --del-num-bg: rgba(248, 81, 73, 0.25);
        --meta-fg: #8b949e;
        --linenum-fg: #6e7681;
        --linenum-bg: #161b22;
      }}
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      padding: 16px;
      background: var(--bg);
      color: var(--fg);
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      line-height: 1.5;
    }}
    .diff-container {{
      max-width: 1400px;
      margin: 0 auto;
      border: 1px solid var(--border);
      border-radius: 6px;
      overflow: hidden;
      background: var(--bg);
    }}
    .diff-header {{
      padding: 12px 16px;
      background: var(--header-bg);
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 12px;
    }}
    .diff-title-group {{
      display: flex;
      align-items: baseline;
      gap: 10px;
      flex-wrap: wrap;
    }}
    .diff-title {{
      margin: 0;
      font-size: 16px;
      font-weight: 600;
      font-family: var(--font-mono);
    }}
    .diff-path {{
      font-size: 13px;
      color: var(--meta-fg);
      font-family: var(--font-mono);
    }}
    .diff-meta {{
      display: flex;
      gap: 10px;
      align-items: center;
    }}
    .diff-badge {{
      font-size: 12px;
      padding: 2px 8px;
      border-radius: 12px;
      border: 1px solid var(--border);
      background: var(--bg);
      color: var(--meta-fg);
      font-family: var(--font-mono);
    }}
    .diff-stat {{
      font-size: 13px;
      font-weight: 600;
      font-family: var(--font-mono);
    }}
    .stat-add {{ color: var(--add-fg); }}
    .stat-del {{ color: var(--del-fg); }}
    .btn-full-file {{
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 3px 10px;
      font-size: 12px;
      font-weight: 500;
      color: var(--fg);
      background: var(--header-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      cursor: pointer;
      font-family: inherit;
      transition: background 0.15s ease, border-color 0.15s ease;
    }}
    .btn-full-file:hover {{
      background: var(--border);
    }}
    .diff-table {{
      width: 100%;
      border-collapse: collapse;
      font-family: var(--font-mono);
      font-size: 12px;
      line-height: 1.45;
    }}
    .diff-table td {{
      padding: 1px 8px;
      vertical-align: top;
    }}
    .line-num {{
      width: 1%;
      min-width: 44px;
      text-align: right;
      color: var(--linenum-fg);
      background: var(--linenum-bg);
      user-select: none;
      border-right: 1px solid var(--border);
    }}
    .line-sign {{
      width: 1%;
      min-width: 20px;
      text-align: center;
      user-select: none;
      font-weight: bold;
    }}
    .line-code {{
      white-space: pre-wrap;
      word-break: break-all;
    }}
    .row-add {{ background: var(--add-bg); color: var(--add-fg); }}
    .row-add .line-num {{ background: var(--add-num-bg); }}
    .row-del {{ background: var(--del-bg); color: var(--del-fg); }}
    .row-del .line-num {{ background: var(--del-num-bg); }}
    .row-hunk {{
      background: var(--hunk-bg);
      color: var(--hunk-fg);
      border-top: 1px solid var(--border);
      border-bottom: 1px solid var(--border);
    }}
    .row-meta {{ color: var(--meta-fg); background: var(--header-bg); }}
  </style>
</head>
<body>
  <div class="diff-container">
    <header class="diff-header">
      <div class="diff-title-group">
        <h1 class="diff-title">{html.escape(display_title)}</h1>
        {f'<span class="diff-path">{html.escape(display_path)}</span>' if display_path != display_title else ''}
      </div>
      <div class="diff-meta">
        <span class="diff-badge">{html.escape(mode_label)}</span>
        <span class="diff-stat stat-add">+{additions}</span>
        <span class="diff-stat stat-del">-{deletions}</span>
        {btn_html}
      </div>
    </header>
    <table class="diff-table">
      <tbody>
        {"".join(table_rows)}
      </tbody>
    </table>
  </div>
  {script_html}
</body>
</html>"""


def generate_file_diff(path: str, ctx: SecurityContext, commit_fallback: bool = False, context_lines: int = DIFF_CONTEXT_LINES) -> dict:
    """Calcula y devuelve el diff de un archivo frente a Git HEAD o su último commit, incluyendo HTML."""
    if not isinstance(path, str) or not path.strip():
        raise ValueError("La ruta del archivo está vacía.")
    if len(path) > MAX_PATH_LENGTH:
        raise ValueError("La ruta del archivo excede el tamaño máximo permitido.")

    target = ctx.absolute(path)
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
    rel_path = target.name
    try:
        rel_path = target.relative_to(repo_root).as_posix()
    except ValueError:
        pass

    if has_head:
        try:
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

    mode = "working_tree"
    last_commit = ""
    diff_text = ""

    if has_working_tree_diff:
        if in_head:
            cmd = [git_bin, "diff", f"-U{context_lines}", "HEAD", "--", str(target)]
        else:
            cmd = [git_bin, "diff", f"-U{context_lines}", "--no-index", "--", os.devnull, str(target)]
        diff_res = subprocess.run(cmd, cwd=str(repo_root), capture_output=True, text=True, timeout=10, check=False)
        diff_text = diff_res.stdout
    else:
        # No hay cambios pendientes en el árbol de trabajo. Comprobar historial del archivo.
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
            cmd = [git_bin, "diff", f"-U{context_lines}", f"{last_commit}~1", last_commit, "--", str(target)]
        else:
            cmd = [git_bin, "diff", f"-U{context_lines}", "4b825dc642cb6eb9a060e54bf8d69288fbee4904", last_commit, "--", str(target)]
        diff_res = subprocess.run(cmd, cwd=str(repo_root), capture_output=True, text=True, timeout=10, check=False)
        diff_text = diff_res.stdout

    if not diff_text.strip():
        return {
            "success": True,
            "has_diff": False,
            "in_head": in_head,
            "has_commit_history": bool(last_commit),
            "last_commit": last_commit or None,
            "path": str(target)
        }

    full_file_bytes = None
    if mode == "commit" and last_commit:
        show_res = subprocess.run(
            [git_bin, "show", f"{last_commit}:{rel_path}"],
            cwd=str(repo_root),
            capture_output=True,
            timeout=5,
            check=False
        )
        if show_res.returncode == 0:
            full_file_bytes = show_res.stdout
    if full_file_bytes is None:
        try:
            if target.is_file() and target.stat().st_size <= 5_000_000:
                full_file_bytes = target.read_bytes()
        except (OSError, PermissionError):
            full_file_bytes = None

    html_content = render_diff_html(
        diff_text=diff_text,
        filename=target.name,
        rel_path=rel_path,
        mode=mode,
        commit=last_commit or None,
        full_file_bytes=full_file_bytes
    )

    return {
        "success": True,
        "has_diff": True,
        "mode": mode,
        "path": str(target),
        "in_head": in_head,
        "commit": last_commit or None,
        "diff": diff_text,
        "html": html_content
    }


def open_file_diff(path: str, ctx: SecurityContext, commit_fallback: bool = False, gui: bool = False, context_lines: int = DIFF_CONTEXT_LINES) -> dict:
    """Obtiene el diff de un archivo asociado a Git.

    Por defecto genera el diff con el visor propio de ZeroChat (HTML y texto), apto para
    ejecución local y remota sin depender de visores gráficos instalados en el sistema operativo.
    Con `gui=True` lanza el visor gráfico externo configurado en Git (difftool).
    """
    if gui:
        return _open_gui_file_diff(path, ctx, commit_fallback)
    return generate_file_diff(path, ctx, commit_fallback, context_lines=context_lines)
