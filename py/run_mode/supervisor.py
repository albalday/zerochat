"""Supervisión de la ejecución desatendida: plazos, final del runner y arranque del runner de Node."""

from __future__ import annotations

import os
import subprocess
import tempfile
import threading
import time
from http.server import ThreadingHTTPServer
from pathlib import Path
from typing import IO

from auth.tokens import revoke_token
from core.environment import get_data_dir, get_dev_root
from core.logging import log_event
from core.process import _kill_process_tree
from run_mode.runner_loader import RUNNER_CACHE_ALWAYS_DOWNLOAD, RUNNER_CACHE_BY_VERSION, RUNNER_LOADER_SCRIPT
from run_mode.state import (
    NODE_REQUIRED_MESSAGE,
    RunSession,
    find_node_executable,
    run_error,
    write_run_state,
)
from server.state import (
    _SERVER_SHUTTING_DOWN,
    register_shutdown_event,
    stop_zerochat_server,
    unregister_shutdown_event,
)


# Final de la salida de error del runner que acompaña al motivo de un final sin resultado.
RUNNER_ERROR_TAIL_BYTES = 2000


def runner_exit_reason(proc: subprocess.Popen, stderr_log: IO[bytes] | None) -> str:
    """Por qué terminó el runner sin resultado: su código de salida y el final de su salida de error."""
    tail = ""
    if stderr_log is not None:
        try:
            size = stderr_log.seek(0, os.SEEK_END)
            stderr_log.seek(max(0, size - RUNNER_ERROR_TAIL_BYTES))
            tail = stderr_log.read().decode("utf-8", "replace").strip()
        except (OSError, ValueError):
            tail = ""
    reason = f"El runner de Node.js terminó con el código {proc.returncode} sin resultado"
    return f"{reason}: {tail}" if tail else f"{reason}."


def run_supervisor(server: ThreadingHTTPServer, session: RunSession, runner_proc: subprocess.Popen | None = None,
                   runner_log: IO[bytes] | None = None):
    """Detiene el servidor al recibir el resultado, si termina el runner propio o al vencer el timeout de --run-file,
    contado desde el arranque del proceso: entonces termina el runner, y lo hecho ya está grabado. Sin timeout, lo que
    dura una ejecución lo decide quien la lanza (la cancela o la interrumpe)."""
    wake = threading.Event()
    proc_done = threading.Event()
    session.set_wake_event(wake)
    register_shutdown_event(wake)
    try:
        if runner_proc is not None:
            def _watch_proc():
                runner_proc.wait()
                proc_done.set()
                wake.set()
            threading.Thread(target=_watch_proc, name="run-proc-wait", daemon=True).start()
        deadline = None if session.timeout_seconds is None else session.started_at / 1000 + session.timeout_seconds
        woken = wake.wait(None if deadline is None else max(0.0, deadline - time.time()))
        # El latido o una señal ya detienen el servidor: el resultado queda vacío.
        if _SERVER_SHUTTING_DOWN.is_set():
            return
        if not woken and session.reach_limit(f"Límite de {session.timeout_seconds} s alcanzado."):
            if runner_proc is not None:
                _kill_process_tree(runner_proc, grace_seconds=1.0)
        if proc_done.is_set() and not session.finished.wait(0.2):
            if runner_proc is not None:
                session.stop_reason = runner_exit_reason(runner_proc, runner_log)
    finally:
        unregister_shutdown_event(wake)
        session.set_wake_event(None)
    if session.result is None:
        with session.lock:
            session.status = "error"
            session.error = session.stop_reason or ("El runner se cerró sin resultado." if runner_proc else "La ejecución se interrumpió sin resultado.")
            write_run_state(session)
    if session.runner_token:
        revoke_token(session.runner_token)
    stop_zerochat_server(server)


def _runner_cache_file() -> Path:
    """La caché de los módulos del runner, en una carpeta privada que es lo único del disco que puede tocar."""
    cache_dir = get_data_dir() / "cache" / "runner"
    cache_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    if os.name != "nt":
        try:
            cache_dir.chmod(0o700)
        except OSError:
            pass
    return cache_dir / "modules.json"


def launch_node_runner(url: str) -> tuple[subprocess.Popen, IO[bytes]] | None:
    """Abre el runner de Node.js sin ventana en segundo plano con el modelo de permisos de Node; devuelve el proceso
    y su salida de error, en un fichero temporal sin nombre, para explicar un final sin resultado (runner_exit_reason).

    El cargador (runner_loader.py) descarga los módulos de la interfaz de url y solo puede leer y escribir su caché.
    Hereda el entorno de quien lanza zerochat (NODE_EXTRA_CA_CERTS, TZ, LANG...): ejecuta código propio, no el del
    modelo, que va al sandbox sin entorno; un runner alterado vendría con una interfaz alterada que ya puede más."""
    node = find_node_executable()
    if not node:
        run_error(f"Se necesita {NODE_REQUIRED_MESSAGE} para la ejecución desatendida.")
        return None
    try:
        cache_file = _runner_cache_file()
    except OSError as exc:
        run_error(f"No se pudo preparar la caché del runner de Node.js: {exc}")
        return None
    log_event("Iniciando runner de Node.js...")
    cache_dir = cache_file.parent
    # En desarrollo los módulos cambian sin subir la versión: se descargan siempre.
    cache_policy = RUNNER_CACHE_ALWAYS_DOWNLOAD if get_dev_root() is not None else RUNNER_CACHE_BY_VERSION
    cmd = [node, "--permission", f"--allow-fs-read={cache_dir}", f"--allow-fs-write={cache_dir}",
           "-e", RUNNER_LOADER_SCRIPT, str(cache_file), url, cache_policy]
    try:
        stderr_log = tempfile.TemporaryFile()  # noqa: SIM115 - vive lo que la ejecución; se cierra al salir
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=stderr_log,
            start_new_session=True,
        )
        return proc, stderr_log
    except OSError as error:
        run_error(f"No se pudo iniciar el proceso de Node.js ({error}).")
        return None
