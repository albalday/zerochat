"""Estado del servidor local en marcha: presencia del navegador por latido, auto-cierre, apagado, préstamo del navegador y estado vivo que publica el latido."""

from __future__ import annotations

import hashlib
import json
import threading
import time
from http.server import ThreadingHTTPServer

from browser.engines import BROWSER_ENGINES
from core.limits import LONG_POLL_MAX_WAIT_MS
from core.live_events import on_live_change
from core.process import pid_exit_waitable
from core.logging import console_log, log_event, timestamp_message
from mcp.manager import GLOBAL_MCP_MANAGER
from run_mode.state import list_server_runs
from security.context import SecurityContext
from storage.db import conversations_revision, get_server_id
from tools.browser_action import close_browser_session, playwright_status
from tools.jobs import JOBS

DEFAULT_HEARTBEAT_TIMEOUT = 60.0
DEFAULT_HEARTBEAT_GRACE = 45.0
# Las ejecuciones --conversation corren en otro proceso y solo se ven en SQLite. Su final llega sin sondeo (se
# espera su PID, watch_run_exit), pero no su progreso (step_text): el latido en espera relee cada tanto mientras
# la interfaz muestra la conversación de una en marcha. Donde no se puede esperar un PID, el latido y el
# vigilante releen así con cualquiera en marcha.
_EXTERNAL_RUN_POLL_SECONDS = 1.0
_WATCHDOG_RUN_RECHECK_SECONDS = 1.0
# Campos de cada comando que cambian sin parar mientras corre: no cuentan en la firma `rev` (si no, cada
# línea de salida despertaría a todos los latidos) y se refrescan al vencer cada espera.
_VOLATILE_JOB_FIELDS = frozenset({"elapsed_s", "output_bytes", "last_line"})
HEARTBEAT_LAST_SEEN = 0.0
HEARTBEAT_INITIALIZED = False
HEARTBEAT_WATCHDOG_STOP = threading.Event()
_LIVE_STATE_COND = threading.Condition()
_LIVE_STATE_SEQ = 0
_WATCHDOG_COND = threading.Condition()
_SERVER_SHUTTING_DOWN = threading.Event()
_SHUTDOWN_LOCK = threading.Lock()
_SHUTDOWN_LISTENERS: set[threading.Event] = set()
# Si el servidor se detiene al cerrar el navegador, cerrar la pestaña detiene también los comandos.
EXIT_ON_CLOSE = False


def register_shutdown_event(event: threading.Event) -> None:
    """Registra un evento que se activa al iniciar el apagado del servidor."""
    with _SHUTDOWN_LOCK:
        if _SERVER_SHUTTING_DOWN.is_set():
            event.set()
        else:
            _SHUTDOWN_LISTENERS.add(event)


def unregister_shutdown_event(event: threading.Event) -> None:
    with _SHUTDOWN_LOCK:
        _SHUTDOWN_LISTENERS.discard(event)


def set_exit_on_close(value: bool):
    """Fija si cerrar el navegador detiene el servidor (sin --keep-server)."""
    global EXIT_ON_CLOSE
    EXIT_ON_CLOSE = value


# Un navegador lo usa una conversación cada vez; queda libre tras este tiempo sin que lo use. Cubre lo que
# el modelo tarda en razonar entre dos acciones, no la espera a otra petición del usuario.
BROWSER_LEASE_IDLE_SECONDS = 60.0


class BrowserLease:
    """
    Reserva de los navegadores (browser_action y Playwright MCP): la conversación que los usa los conserva
    mientras siga usándolos; otra recibe un error claro hasta que pasen BROWSER_LEASE_IDLE_SECONDS sin uso.
    Sin cola: compartir la página haría que una conversación actuase sobre la de otra.
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._holders: dict[str, tuple[str, float]] = {}

    def acquire(self, resource: str, conversation_id: str) -> bool:
        now = time.monotonic()
        with self._lock:
            holder = self._holders.get(resource)
            if holder and holder[0] != conversation_id and now - holder[1] < BROWSER_LEASE_IDLE_SECONDS:
                return False
            self._holders[resource] = (conversation_id, now)
            return True


BROWSER_LEASES = BrowserLease()


def notify_live_state_changed() -> None:
    """Despierta a los latidos en espera y al watchdog ante cambios del estado vivo."""
    global _LIVE_STATE_SEQ
    with _LIVE_STATE_COND:
        _LIVE_STATE_SEQ += 1
        _LIVE_STATE_COND.notify_all()
    with _WATCHDOG_COND:
        _WATCHDOG_COND.notify_all()


on_live_change(notify_live_state_changed)


def mark_browser_active():
    """Registra la presencia del navegador ante cualquier petición de un origen permitido, aunque su
    token haya caducado: el auto-cierre no detiene el servidor ni sus comandos al cambiar el día."""
    global HEARTBEAT_LAST_SEEN, HEARTBEAT_INITIALIZED
    with _WATCHDOG_COND:
        HEARTBEAT_LAST_SEEN = time.monotonic()
        HEARTBEAT_INITIALIZED = True
        _WATCHDOG_COND.notify_all()


def heartbeat_initialized() -> bool:
    """Si el navegador ha dado ya alguna señal de vida."""
    return HEARTBEAT_INITIALIZED


def _live_state_rev(state: dict) -> str:
    stable = {
        **state,
        "jobs": [{k: v for k, v in job.items() if k not in _VOLATILE_JOB_FIELDS} for job in state["jobs"]],
    }
    encoded = json.dumps(stable, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()[:16]


def live_state(ctx: SecurityContext, focus_conversation_id: str | None = None) -> dict:
    """
    Estado del servidor que la interfaz sigue en vivo, en initialize y en cada zerochat/heartbeat:
    cwd, el proyecto de la pestaña que pregunta (su cabecera X-ZeroChat-Project); jobs, los comandos en
    marcha con su última línea de salida, para mostrarlos y avisar antes de cerrar si se detendrían; exit_on_close; playwright, si
    se puede navegar aunque se haya instalado o quitado durante la sesión; servers, los servicios
    MCP externos aunque otra pestaña los cambie o su proceso muera; runs, lista ligera de ejecuciones
    en segundo plano; y focus_run, estado detallado de la ejecución enfocada por el usuario.
    """
    runs, focus_run = list_server_runs(focus_conversation_id)
    state = {
        "serverId": get_server_id(),
        "cwd": str(ctx.workspace_dir),
        "jobs": JOBS.running_summaries(ctx.key),
        "exit_on_close": EXIT_ON_CLOSE,
        "playwright": playwright_status(),
        "servers": GLOBAL_MCP_MANAGER.list_servers(),
        "externalTools": GLOBAL_MCP_MANAGER.tools(),
        "runs": runs,
        "focus_run": focus_run,
        "conversations_rev": conversations_revision()
    }
    state["rev"] = _live_state_rev(state)
    return state


def wait_live_state(
    ctx: SecurityContext,
    focus_conversation_id: str | None = None,
    since_rev: str | None = None,
    wait_ms: int = 0,
) -> dict:
    """Devuelve el estado vivo; con since_rev y wait_ms espera a que cambie su firma sin sondeo activo."""
    deadline = time.monotonic() + min(max(0, wait_ms), LONG_POLL_MAX_WAIT_MS) / 1000.0
    while True:
        with _LIVE_STATE_COND:
            seq = _LIVE_STATE_SEQ
        state = live_state(ctx, focus_conversation_id)
        if not since_rev or state["rev"] != since_rev or _SERVER_SHUTTING_DOWN.is_set():
            return state
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return state
        slice_s = min(remaining, _EXTERNAL_RUN_POLL_SECONDS) if _rereads_runs(state) else remaining
        with _LIVE_STATE_COND:
            if _LIVE_STATE_SEQ == seq and not _SERVER_SHUTTING_DOWN.is_set():
                _LIVE_STATE_COND.wait(slice_s)


def _rereads_runs(state: dict) -> bool:
    """Si el latido en espera debe releer SQLite cada _EXTERNAL_RUN_POLL_SECONDS (ver arriba)."""
    focus = state.get("focus_run")
    if isinstance(focus, dict) and focus.get("status") == "running":
        return True
    return not pid_exit_waitable() and any(r.get("status") == "running" for r in state["runs"])


def stop_zerochat_server(server: ThreadingHTTPServer):
    """Detiene limpiamente el servidor y todos los subsistemas evitando reentradas."""
    if _SERVER_SHUTTING_DOWN.is_set():
        return
    _SERVER_SHUTTING_DOWN.set()
    with _SHUTDOWN_LOCK:
        for listener in list(_SHUTDOWN_LISTENERS):
            listener.set()
    HEARTBEAT_WATCHDOG_STOP.set()
    notify_live_state_changed()
    running = JOBS.running(None)
    if running:
        console_log(timestamp_message(f"Deteniendo {len(running)} comando(s) en marcha: " + ", ".join(job.command[:60] for job in running)))
    JOBS.stop_all("shutdown")
    GLOBAL_MCP_MANAGER.close()
    BROWSER_ENGINES.close()
    close_browser_session()
    threading.Thread(target=server.shutdown, daemon=True).start()


def _watchdog_wait_step(
    start_time: float,
    initial_grace_seconds: float,
    inactivity_timeout_seconds: float,
    require_initial_connection: bool,
) -> str | None:
    """Espera en _WATCHDOG_COND hasta que venza el plazo actual; devuelve el mensaje de cierre o None."""
    with _WATCHDOG_COND:
        while not HEARTBEAT_WATCHDOG_STOP.is_set():
            if not HEARTBEAT_INITIALIZED:
                if not require_initial_connection:
                    _WATCHDOG_COND.wait()
                    continue
                remaining = start_time + initial_grace_seconds - time.monotonic()
                if remaining <= 0:
                    return f"Tiempo de espera del navegador agotado ({initial_grace_seconds:.0f}s). Deteniendo servidor ZeroChat..."
                _WATCHDOG_COND.wait(remaining)
                continue
            remaining = HEARTBEAT_LAST_SEEN + inactivity_timeout_seconds - time.monotonic()
            if remaining > 0:
                _WATCHDOG_COND.wait(remaining)
                continue
            return "Navegador desconectado (cierre detectado). Deteniendo servidor ZeroChat..."
    return None


def heartbeat_watchdog(server: ThreadingHTTPServer, initial_grace_seconds: float = DEFAULT_HEARTBEAT_GRACE, inactivity_timeout_seconds: float = DEFAULT_HEARTBEAT_TIMEOUT, require_initial_connection: bool = True):
    """
    Supervisa la presencia de la pestaña del navegador mediante latidos HTTP.
    Si el navegador se cierra o deja de emitir latidos, detiene el servidor automáticamente.
    """
    start_time = time.monotonic()
    run_recheck_seconds = min(_WATCHDOG_RUN_RECHECK_SECONDS, max(0.05, inactivity_timeout_seconds))
    while not HEARTBEAT_WATCHDOG_STOP.is_set():
        reason = _watchdog_wait_step(start_time, initial_grace_seconds, inactivity_timeout_seconds, require_initial_connection)
        if reason is None:
            return
        if HEARTBEAT_INITIALIZED:
            with _LIVE_STATE_COND:
                seq = _LIVE_STATE_SEQ
            runs, _ = list_server_runs()
            if any(r.get("status") == "running" for r in runs):
                # Hasta que termine alguna (lo avisa watch_run_exit, que list_server_runs pone en marcha) o vuelva el navegador.
                with _WATCHDOG_COND:
                    if not pid_exit_waitable():
                        _WATCHDOG_COND.wait(run_recheck_seconds)
                    elif _LIVE_STATE_SEQ == seq and not HEARTBEAT_WATCHDOG_STOP.is_set():
                        _WATCHDOG_COND.wait()
                continue
        log_event(reason)
        stop_zerochat_server(server)
        return
