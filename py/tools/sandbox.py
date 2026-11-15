"""Ejecución aislada de JavaScript en un subproceso Node sin credenciales ni permisos."""

from __future__ import annotations

import json
import subprocess
import time

from core.environment import DETECTED_OS, minimal_child_env
from core.process import _kill_process_tree
from run_mode.state import NODE_REQUIRED_MESSAGE, find_node_executable
from tools.sandbox_script import NODE_SANDBOX_ARGS, NODE_SANDBOX_SCRIPT

DEFAULT_SANDBOX_TIMEOUT_MS = 2500
MAX_SANDBOX_TIMEOUT_MS = 30000
MAX_SANDBOX_OUTPUT_LENGTH = 30000
MAX_SANDBOX_LOG_ENTRIES = 200

def _normalize_timeout_ms(timeout_ms: int | float | None) -> int:
    """Valida y acota el timeout del sandbox en milisegundos."""
    if timeout_ms is None:
        return DEFAULT_SANDBOX_TIMEOUT_MS
    if isinstance(timeout_ms, bool) or not isinstance(timeout_ms, (int, float)) or timeout_ms <= 0:
        raise ValueError("timeout_ms debe ser un número positivo")
    return min(int(timeout_ms), MAX_SANDBOX_TIMEOUT_MS)


def execute_js_sandbox(code: str, timeout_ms: int | float | None = None) -> dict:
    """Ejecuta código JavaScript en un subproceso de Node sin entorno, con el script y los indicadores de tools.sandbox_script."""
    if not isinstance(code, str) or not code.strip():
        return {
            "success": False,
            "result": "",
            "logs": [],
            "executionTimeMs": 0,
            "error": "No code provided to execute.",
        }
    resolved_timeout = _normalize_timeout_ms(timeout_ms)
    node_path = find_node_executable()
    if not node_path:
        raise RuntimeError(NODE_REQUIRED_MESSAGE)

    payload = json.dumps({
        "code": code,
        "timeoutMs": resolved_timeout,
        "maxOutputLength": MAX_SANDBOX_OUTPUT_LENGTH,
        "maxLogEntries": MAX_SANDBOX_LOG_ENTRIES,
    })
    started = time.monotonic()
    popen_kwargs = {
        "stdin": subprocess.PIPE,
        "stdout": subprocess.PIPE,
        "stderr": subprocess.PIPE,
        "text": True,
        "encoding": "utf-8",
        "errors": "replace",
        "env": minimal_child_env(),
    }
    if DETECTED_OS != "windows":
        popen_kwargs["start_new_session"] = True
    proc = subprocess.Popen([node_path, *NODE_SANDBOX_ARGS, "-e", NODE_SANDBOX_SCRIPT], **popen_kwargs)
    try:
        stdout, stderr = proc.communicate(input=payload, timeout=(resolved_timeout + 250) / 1000.0)
    except subprocess.TimeoutExpired:
        _kill_process_tree(proc.pid, grace_seconds=0.05)
        try:
            proc.wait(timeout=1.0)
        except subprocess.TimeoutExpired:
            pass
        return {
            "success": False,
            "result": "",
            "logs": [],
            "executionTimeMs": int((time.monotonic() - started) * 1000),
            "error": f"Execution timed out after {resolved_timeout}ms and was terminated.",
        }

    elapsed_ms = int((time.monotonic() - started) * 1000)
    raw = (stdout or "").strip()
    if raw:
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict) and "success" in parsed:
                return parsed
        except json.JSONDecodeError:
            pass
    err_detail = (stderr or raw or f"Sandbox exited with code {proc.returncode}").strip()
    return {
        "success": False,
        "result": "",
        "logs": [],
        "executionTimeMs": elapsed_ms,
        "error": err_detail,
    }
