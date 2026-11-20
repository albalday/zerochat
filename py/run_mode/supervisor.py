"""Supervisión de la ejecución desatendida: plazos, final del runner o del navegador, y arranque del runner de Node."""

from __future__ import annotations

import os
import subprocess
import tempfile
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path
from typing import IO

from auth.tokens import revoke_token
from browser.launch import launch_browser
from core.environment import get_data_dir, get_dev_root
from core.logging import log_event
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
    heartbeat_initialized,
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
                   browser_proc: subprocess.Popen | None = None, runner_log: IO[bytes] | None = None):
    """Detiene el servidor al recibir el resultado o si termina el runner propio. Sin plazos: lo que dura una ejecución
    lo decide quien la lanza (la cancela o la interrumpe), y cada paso cerrado ya está grabado."""
    proc = runner_proc if runner_proc is not None else browser_proc
    wake = threading.Event()
    proc_done = threading.Event()
    session.set_wake_event(wake)
    register_shutdown_event(wake)
    try:
        if proc is not None:
            def _watch_proc():
                proc.wait()
                proc_done.set()
                wake.set()
            threading.Thread(target=_watch_proc, name="run-proc-wait", daemon=True).start()
        wake.wait()
        # El latido o una señal ya detienen el servidor: el resultado queda vacío.
        if _SERVER_SHUTTING_DOWN.is_set():
            return
        if proc_done.is_set() and not session.finished.wait(0.2):
            if runner_proc is not None:
                session.stop_reason = runner_exit_reason(runner_proc, runner_log)
    finally:
        unregister_shutdown_event(wake)
        session.set_wake_event(None)
    if session.result is None and session.conversation_id:
        with session.lock:
            session.status = "error"
            session.error = session.stop_reason or ("El runner se cerró sin resultado." if proc else "La ejecución se interrumpió sin resultado.")
            write_run_state(session)
    if session.runner_token:
        revoke_token(session.runner_token)
    stop_zerochat_server(server)


def fall_back_when_headless_exits(proc: subprocess.Popen, url: str):
    """
    Un navegador sin ventana termina enseguida si su perfil ya está abierto (Firefox avisa de que
    ya está en marcha): si acaba antes de que conecte la interfaz, se abre la pestaña normal.
    """
    proc.wait()
    if not heartbeat_initialized() and not _SERVER_SHUTTING_DOWN.is_set():
        log_event("El navegador sin ventana terminó sin abrir la interfaz (¿ya estaba abierto?); se abre una pestaña de la forma normal.")
        launch_browser(url)


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
        run_error(f"Se necesita {NODE_REQUIRED_MESSAGE} para la ejecución desatendida. Instálalo o usa --browser.")
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
