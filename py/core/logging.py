"""Registro en consola con la hora local; la consola interactiva, si existe, recibe las líneas."""

from __future__ import annotations

import time

CONSOLE_CONTROL = None


def set_console_control(control):
    """Fija la consola interactiva que recibe las líneas del registro (None para escribir directamente)."""
    global CONSOLE_CONTROL
    CONSOLE_CONTROL = control


def console_log(message: str, *, flush: bool = True):
    if CONSOLE_CONTROL:
        CONSOLE_CONTROL.log(message, flush=flush)
    else:
        print(message, flush=flush)


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
