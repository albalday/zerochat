"""Supervisión de la ejecución desatendida: plazos, final del runner o del navegador, y descarga y arranque de runner.js con Node."""

from __future__ import annotations

import os
import subprocess
import time
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

from auth.tokens import revoke_token
from browser.launch import launch_browser
from core.environment import _write_private_text, get_data_dir, get_dev_root
from core.logging import log_event
from core.version import DEFAULT_UI_URL, VERSION
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
from web.fetch import _read_limited_body


# Tope de descarga para runner.js (evita agotar memoria o disco con respuestas desbordadas).
RUNNER_MAX_BYTES = 4 * 1024 * 1024


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


def _read_bounded_runner(resp) -> str:
    """Lee runner.js de la respuesta HTTP con tope RUNNER_MAX_BYTES y validación UTF-8."""
    raw_length = resp.headers.get("Content-Length")
    encoding = (resp.headers.get("Content-Encoding") or "").strip().lower()
    if raw_length and not encoding:
        try:
            if int(raw_length) > RUNNER_MAX_BYTES:
                raise RuntimeError(f"runner.js supera el tamaño máximo permitido ({RUNNER_MAX_BYTES} bytes).")
        except ValueError:
            pass
    content, truncated = _read_limited_body(resp, encoding, RUNNER_MAX_BYTES)
    if truncated:
        raise RuntimeError(f"runner.js supera el tamaño máximo permitido ({RUNNER_MAX_BYTES} bytes).")
    if not content:
        raise RuntimeError("runner.js descargado está vacío.")
    try:
        return content.decode("utf-8")
    except UnicodeDecodeError as err:
        raise RuntimeError(f"runner.js descargado no es UTF-8 válido: {err}") from err


def _dev_runner_script() -> Path | None:
    """En el repositorio, js/run-node.js o, si no está, el runner.js compilado."""
    dev_root = get_dev_root()
    if dev_root is None:
        return None
    return next((path for path in (dev_root / "js" / "run-node.js", dev_root / "runner.js") if path.is_file()), None)


def _chmod_quietly(path: Path, mode: int):
    """Permisos POSIX si se pueden poner; en Windows no se aplican."""
    if os.name != "nt":
        try:
            path.chmod(mode)
        except OSError:
            pass


def _download_runner(url: str, runner_path: Path, etag_path: Path):
    """Descarga runner.js si cambió desde la copia en caché (If-None-Match); un 304 llega como HTTPError."""
    # url sale de DEFAULT_UI_URL, una URL https fija.
    req = urllib.request.Request(url, headers={"User-Agent": f"ZeroChat/{VERSION}"})  # noqa: S310
    if runner_path.is_file() and etag_path.is_file():
        try:
            current_etag = etag_path.read_text(encoding="utf-8").strip()
            if current_etag:
                req.add_header("If-None-Match", current_etag)
        except OSError:
            pass
    with urllib.request.urlopen(req, timeout=5) as resp:  # noqa: S310
        runner_text = _read_bounded_runner(resp)
        etag = resp.headers.get("ETag")
    _write_private_text(runner_path, runner_text)
    _chmod_quietly(runner_path, 0o755)
    if etag:
        _write_private_text(etag_path, etag)
    else:
        etag_path.unlink(missing_ok=True)


def ensure_runner_script() -> Path:
    """
    Obtiene la ruta al runner de Node.js: en entorno de desarrollo local usa js/run-node.js o runner.js;
    en producción lo descarga o actualiza desde GitHub Pages con comprobación condicional ETag/304
    en ~/zerochat/cache/runner.js.
    """
    dev_runner = _dev_runner_script()
    if dev_runner is not None:
        return dev_runner

    cache_dir = get_data_dir() / "cache"
    cache_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    _chmod_quietly(cache_dir, 0o700)
    runner_path = cache_dir / "runner.js"
    runner_url = DEFAULT_UI_URL.rsplit("/", 1)[0] + "/runner.js"
    try:
        _download_runner(runner_url, runner_path, cache_dir / "runner.etag")
    except urllib.error.HTTPError as err:
        if not runner_path.is_file():
            raise RuntimeError(f"Error descargando runner.js desde {runner_url}: {err}") from err
        if err.code != 304:
            log_event(f"No se pudo comprobar actualización de runner.js ({err}); usando versión en caché.")
    except (urllib.error.URLError, TimeoutError, OSError) as err:
        if not runner_path.is_file():
            raise RuntimeError(f"No se pudo descargar runner.js ({err}) y no hay copia en caché.") from err
        log_event(f"No se pudo comprobar actualización de runner.js ({err}); usando versión en caché.")
    return runner_path


def launch_node_runner(url: str) -> subprocess.Popen | None:
    """Abre el runner de Node.js sin ventana en segundo plano con el modelo de permisos de Node.

    Hereda el entorno de quien lanza zerochat (NODE_EXTRA_CA_CERTS, TZ, LANG...): ejecuta código propio, no el del
    modelo, que va al sandbox sin entorno; un runner.js alterado vendría con una interfaz alterada que ya puede más."""
    node = find_node_executable()
    if not node:
        run_error(f"Se necesita {NODE_REQUIRED_MESSAGE} para la ejecución desatendida. Instálalo o usa --browser.")
        return None
    try:
        runner_path = ensure_runner_script()
    except Exception as exc:
        run_error(f"No se pudo preparar el runner de Node.js: {exc}")
        return None
    log_event(f"Iniciando runner de Node.js ({runner_path.name})...")
    cmd = [node, "--permission"]
    if runner_path.name == "run-node.js":
        # En desarrollo js/run-node.js carga sus módulos por require() dentro de js/.
        cmd.append(f"--allow-fs-read={runner_path.parent}")
    cmd.extend([str(runner_path), url])
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
