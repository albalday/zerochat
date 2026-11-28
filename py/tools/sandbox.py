"""Ejecución aislada de JavaScript en un subproceso Node sin credenciales ni permisos."""

from __future__ import annotations

import json
import math
import subprocess
import threading
import time

from core.environment import DETECTED_OS, minimal_child_env
from core.process import _kill_process_tree
from run_mode.state import NODE_REQUIRED_TOOL_ERROR, find_node_executable
from tools.sandbox_script import NODE_SANDBOX_ARGS, NODE_SANDBOX_MAX_OUTPUT_BYTES, NODE_SANDBOX_SCRIPT

DEFAULT_SANDBOX_TIMEOUT_MS = 2500
MAX_SANDBOX_TIMEOUT_MS = 30000
MAX_SANDBOX_OUTPUT_LENGTH = 30000
MAX_SANDBOX_LOG_ENTRIES = 200

def _normalize_timeout_ms(timeout_ms: int | float | None) -> int:
    """Valida y acota el timeout del sandbox en milisegundos."""
    if timeout_ms is None:
        return DEFAULT_SANDBOX_TIMEOUT_MS
    # json.loads admite Infinity y NaN: int() los rechazaría con OverflowError/ValueError sin este mensaje.
    if isinstance(timeout_ms, bool) or not isinstance(timeout_ms, (int, float)) or not math.isfinite(timeout_ms) or timeout_ms <= 0:
        raise ValueError("timeout_ms debe ser un número positivo")
    return min(int(timeout_ms), MAX_SANDBOX_TIMEOUT_MS)


def _failure(error: str, elapsed_ms: int) -> dict:
    return {"success": False, "result": "", "logs": [], "executionTimeMs": elapsed_ms, "error": error}


def _run_child(node_path: str, payload: str, timeout_s: float) -> tuple[str, bytes, bytes, int | None]:
    """
    Lanza el hijo de Node, le pasa `payload` por stdin y lee stdout y stderr hasta NODE_SANDBOX_MAX_OUTPUT_BYTES
    cada uno. Devuelve (estado, stdout, stderr, código): estado "done", "timeout" o "overflow"; al vencer el plazo
    o pasar el tope el hijo se mata en vez de seguir leyendo.
    """
    popen_kwargs: dict = {"stdin": subprocess.PIPE, "stdout": subprocess.PIPE, "stderr": subprocess.PIPE,
                          "env": minimal_child_env()}
    if DETECTED_OS != "windows":
        popen_kwargs["start_new_session"] = True
    proc = subprocess.Popen([node_path, *NODE_SANDBOX_ARGS, "-e", NODE_SANDBOX_SCRIPT], **popen_kwargs)
    outputs: dict[str, bytes] = {}
    overflow = threading.Event()

    def read_bounded(name: str, stream) -> None:
        data = stream.read(NODE_SANDBOX_MAX_OUTPUT_BYTES + 1)
        outputs[name] = data
        if len(data) > NODE_SANDBOX_MAX_OUTPUT_BYTES:
            overflow.set()
            _kill_process_tree(proc, grace_seconds=0.05)

    readers = [threading.Thread(target=read_bounded, args=(name, stream), daemon=True)
               for name, stream in (("stdout", proc.stdout), ("stderr", proc.stderr))]
    for reader in readers:
        reader.start()
    status = "done"
    try:
        try:
            proc.stdin.write(payload.encode("utf-8"))
            proc.stdin.close()
        except OSError:
            pass  # El hijo ya terminó: su salida explica por qué.
        try:
            proc.wait(timeout=timeout_s)
        except subprocess.TimeoutExpired:
            status = "timeout"
            _kill_process_tree(proc, grace_seconds=0.05)
            try:
                proc.wait(timeout=1.0)
            except subprocess.TimeoutExpired:
                pass
    finally:
        for reader in readers:
            reader.join(timeout=1.0)
        for stream in (proc.stdout, proc.stderr):
            stream.close()
    if status == "done" and overflow.is_set():
        status = "overflow"
    return status, outputs.get("stdout", b""), outputs.get("stderr", b""), proc.returncode


def execute_js_sandbox(code: str, timeout_ms: int | float | None = None) -> dict:
    """Ejecuta código JavaScript en un subproceso de Node sin entorno, con el script y los indicadores de tools.sandbox_script."""
    if not isinstance(code, str) or not code.strip():
        return _failure("No code provided to execute.", 0)
    resolved_timeout = _normalize_timeout_ms(timeout_ms)
    node_path = find_node_executable()
    if not node_path:
        raise RuntimeError(f"{NODE_REQUIRED_TOOL_ERROR} to run execute_javascript.")

    payload = json.dumps({
        "code": code,
        "timeoutMs": resolved_timeout,
        "maxOutputLength": MAX_SANDBOX_OUTPUT_LENGTH,
        "maxLogEntries": MAX_SANDBOX_LOG_ENTRIES,
    })
    started = time.monotonic()
    status, stdout, stderr, returncode = _run_child(node_path, payload, (resolved_timeout + 250) / 1000.0)
    elapsed_ms = int((time.monotonic() - started) * 1000)
    if status == "timeout":
        return _failure(f"Execution timed out after {resolved_timeout}ms and was terminated.", elapsed_ms)
    if status == "overflow":
        return _failure(f"The sandbox output exceeded {NODE_SANDBOX_MAX_OUTPUT_BYTES} bytes and was discarded.", elapsed_ms)
    raw = stdout.decode("utf-8", errors="replace").strip()
    if raw:
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict) and "success" in parsed:
                return parsed
        except json.JSONDecodeError:
            pass
    err_detail = (stderr.decode("utf-8", errors="replace") or raw or f"Sandbox exited with code {returncode}").strip()
    return _failure(err_detail, elapsed_ms)
