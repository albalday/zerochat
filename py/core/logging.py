"""Registro en consola con la hora local; la consola interactiva, si existe, recibe las líneas."""

from __future__ import annotations

import sys
import threading
import time

CONSOLE_CONTROL = None
# Una línea del registro se escribe entera o no se escribe: al salir, mute_console espera a la que esté en curso.
_WRITE_LOCK = threading.Lock()
_MUTED = False


def set_console_control(control):
    """Fija la consola interactiva que recibe las líneas del registro (None para escribir directamente)."""
    global CONSOLE_CONTROL
    CONSOLE_CONTROL = control


def current_console_control():
    """Consola interactiva que recibe el registro, o None."""
    return CONSOLE_CONTROL


def console_log(message: str, *, flush: bool = True):
    with _WRITE_LOCK:
        if _MUTED:
            return
        if CONSOLE_CONTROL:
            CONSOLE_CONTROL.log(message, flush=flush)
        else:
            print(message, flush=flush)


def console_error(message: str):
    """Una línea en stderr aunque el registro esté desactivado, con el mismo cierre que console_log."""
    with _WRITE_LOCK:
        if not _MUTED:
            print(message, file=sys.stderr, flush=True)


def mute_console():
    """
    Al salir, el registro calla: los hilos en segundo plano que sigan vivos (peticiones del runner, servicios MCP)
    no escriben mientras se cierra el intérprete, que abortaría si uno tuviera tomada la salida al vaciarla.
    """
    global _MUTED
    with _WRITE_LOCK:
        _MUTED = True
        sys.stdout.flush()
        sys.stderr.flush()


def timestamp_message(message: str) -> str:
    """Antepone la hora local con el formato común de la consola."""
    return f"[{time.strftime('%H:%M:%S')}] {message}"


def log_event(message: str):
    """Registra en consola un evento con la hora local."""
    console_log(timestamp_message(message))


def format_log_error(msg: str, max_len: int = 160) -> str:
    """Limpia y trunca mensajes de error para mantener el log en una sola línea legible."""
    if not msg:
        return ""
    cleaned = " ".join(str(msg).strip().splitlines())
    if len(cleaned) > max_len:
        return cleaned[:max_len - 3] + "..."
    return cleaned
