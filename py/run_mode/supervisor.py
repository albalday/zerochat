"""Supervisión de la ejecución desatendida: plazos, final del runner o del navegador, y arranque del runner de Node."""

from __future__ import annotations

import os
import subprocess
import time
from http.server import ThreadingHTTPServer
from pathlib import Path

from auth.tokens import revoke_token
from browser.launch import launch_browser
from core.environment import get_data_dir
from core.logging import log_event
from run_mode.runner_loader import RUNNER_LOADER_SCRIPT
from run_mode.state import (
    NODE_REQUIRED_MESSAGE,
    RUN_IDLE_SECONDS,
    RUN_POLL_SECONDS,
    RUN_TOTAL_TIMEOUT,
    RunSession,
    find_node_executable,
    run_error,
    write_run_state,
)
from server.state import _SERVER_SHUTTING_DOWN, heartbeat_initialized, stop_zerochat_server


def run_supervisor(server: ThreadingHTTPServer, session: RunSession, runner_proc: subprocess.Popen | None = None, browser_proc: subprocess.Popen | None = None):
    """Detiene el servidor al recibir el resultado, si termina el runner propio o al agotar los plazos."""
    proc = runner_proc if runner_proc is not None else browser_proc
    deadline = time.monotonic() + RUN_TOTAL_TIMEOUT
    while not session.finished.wait(RUN_POLL_SECONDS):
        # El latido o una señal ya detienen el servidor: el resultado queda vacío.
        if _SERVER_SHUTTING_DOWN.is_set():
            return
        if proc is not None and proc.poll() is not None and not session.finished.wait(0.2):
            break
        if time.monotonic() >= deadline + session.waited_seconds():
            session.stop_reason = f"Plazo total agotado ({RUN_TOTAL_TIMEOUT:.0f}s, sin contar las esperas)."
            break
        if session.idle_seconds() > RUN_IDLE_SECONDS:
            session.stop_reason = f"Sin progreso de la interfaz durante {RUN_IDLE_SECONDS:.0f}s."
            break
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


def launch_node_runner(url: str) -> subprocess.Popen | None:
    """Abre el runner de Node.js sin ventana en segundo plano con el modelo de permisos de Node.

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
    cmd = [node, "--permission", f"--allow-fs-read={cache_dir}", f"--allow-fs-write={cache_dir}",
           "-e", RUNNER_LOADER_SCRIPT, str(cache_file), url]
    try:
        return subprocess.Popen(
            cmd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except OSError as error:
        run_error(f"No se pudo iniciar el proceso de Node.js ({error}).")
        return None
