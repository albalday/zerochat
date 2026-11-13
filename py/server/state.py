"""Estado del servidor local en marcha: presencia del navegador por latido, auto-cierre, apagado, préstamo del navegador y estado vivo que publica el latido."""

from __future__ import annotations

import threading
import time
from http.server import ThreadingHTTPServer

from core.logging import console_log, log_event, timestamp_message
from mcp.manager import GLOBAL_MCP_MANAGER
from run_mode.state import list_server_runs
from security.context import SecurityContext
from tools.browser_action import playwright_status
from tools.jobs import JOBS

DEFAULT_HEARTBEAT_TIMEOUT = 60.0
DEFAULT_HEARTBEAT_GRACE = 45.0
DEFAULT_HEARTBEAT_POLL = 5.0
HEARTBEAT_LAST_SEEN = 0.0
HEARTBEAT_INITIALIZED = False
HEARTBEAT_WATCHDOG_STOP = threading.Event()
_SERVER_SHUTTING_DOWN = threading.Event()
# Si el servidor se detiene al cerrar el navegador, cerrar la pestaña detiene también los comandos.
EXIT_ON_CLOSE = False


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


def mark_browser_active():
    """Registra la presencia del navegador ante cualquier petición de un origen permitido, aunque su
    token haya caducado: el auto-cierre no detiene el servidor ni sus comandos al cambiar el día."""
    global HEARTBEAT_LAST_SEEN, HEARTBEAT_INITIALIZED
    HEARTBEAT_LAST_SEEN = time.monotonic()
    HEARTBEAT_INITIALIZED = True


def live_state(ctx: SecurityContext, focus_conversation_id: str | None = None) -> dict:
    """
    Estado del servidor que la interfaz sigue en vivo, en initialize y en cada zerochat/heartbeat:
    cwd, el proyecto de la pestaña que pregunta (su cabecera X-ZeroChat-Project); jobs, los comandos en
    marcha, para mostrarlos y avisar antes de cerrar si se detendrían; exit_on_close; playwright, si
    se puede navegar aunque se haya instalado o quitado durante la sesión; servers, los servicios
    MCP externos aunque otra pestaña los cambie o su proceso muera; runs, lista ligera de ejecuciones
    en segundo plano; y focus_run, estado detallado de la ejecución enfocada por el usuario.
    """
    runs, focus_run = list_server_runs(focus_conversation_id)
    return {
        "cwd": str(ctx.workspace_dir),
        "jobs": [job.summary() for job in JOBS.running(ctx.key)],
        "exit_on_close": EXIT_ON_CLOSE,
        "playwright": playwright_status(),
        "servers": GLOBAL_MCP_MANAGER.list_servers(),
        "runs": runs,
        "focus_run": focus_run
    }


def stop_zerochat_server(server: ThreadingHTTPServer):
    """Detiene limpiamente el servidor y todos los subsistemas evitando reentradas."""
    if _SERVER_SHUTTING_DOWN.is_set():
        return
    _SERVER_SHUTTING_DOWN.set()
    HEARTBEAT_WATCHDOG_STOP.set()
    running = JOBS.running(None)
    if running:
        console_log(timestamp_message(f"Deteniendo {len(running)} comando(s) en marcha: " + ", ".join(job.command[:60] for job in running)))
    JOBS.stop_all("shutdown")
    GLOBAL_MCP_MANAGER.close()
    threading.Thread(target=server.shutdown, daemon=True).start()


def heartbeat_watchdog(server: ThreadingHTTPServer, initial_grace_seconds: float = DEFAULT_HEARTBEAT_GRACE, inactivity_timeout_seconds: float = DEFAULT_HEARTBEAT_TIMEOUT, require_initial_connection: bool = True):
    """
    Supervisa la presencia de la pestaña del navegador mediante latidos HTTP.
    Si el navegador se cierra o deja de emitir latidos, detiene el servidor automáticamente.
    """
    start_time = time.monotonic()
    poll_interval = min(DEFAULT_HEARTBEAT_POLL, max(0.02, inactivity_timeout_seconds / 2))
    while not HEARTBEAT_WATCHDOG_STOP.is_set():
        if HEARTBEAT_WATCHDOG_STOP.wait(timeout=poll_interval):
            break

        now = time.monotonic()

        # 1. Periodo de gracia inicial (solo si zerochat abrió el navegador)
        if not HEARTBEAT_INITIALIZED:
            if require_initial_connection and (now - start_time > initial_grace_seconds):
                log_event(f"Tiempo de espera del navegador agotado ({initial_grace_seconds:.0f}s). Deteniendo servidor ZeroChat...")
                stop_zerochat_server(server)
                break
            continue

        # 2. Inactividad tras haber recibido latidos
        if now - HEARTBEAT_LAST_SEEN > inactivity_timeout_seconds:
            runs, _ = list_server_runs()
            if any(r.get("status") == "running" for r in runs):
                continue
            log_event("Navegador desconectado (cierre detectado). Deteniendo servidor ZeroChat...")
            stop_zerochat_server(server)
            break
