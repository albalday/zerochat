"""Esperas de check_command a un comando: vuelven cuando termina, cuando una línea nueva de su salida contiene un
texto o al agotar el plazo, que es un máximo. La persona puede cortarlas con la clave de la invocación."""

from __future__ import annotations

import threading
import time

from tools.common import line_matches

# Cada cuánto comprueba una espera si la persona la ha cortado.
WAIT_SLICE_SECONDS = 0.25


class CancellableWaits:
    """Esperas en curso, por la clave de su invocación: zerochat/jobs/end_wait corta la de esa clave."""

    def __init__(self):
        self._lock = threading.Lock()
        self._waits: dict[str, threading.Event] = {}

    def open(self, key: str | None) -> threading.Event:
        """Registra una espera que se puede cortar con cancel(key); sin clave no se puede cortar."""
        event = threading.Event()
        if key:
            with self._lock:
                self._waits[key] = event
        return event

    def close(self, key: str | None):
        if key:
            with self._lock:
                self._waits.pop(key, None)

    def cancel(self, key) -> bool:
        """Corta la espera con esa clave; devuelve si había una en curso."""
        with self._lock:
            event = self._waits.get(key) if isinstance(key, str) else None
        if event is None:
            return False
        event.set()
        return True


WAITS = CancellableWaits()


def _wait_job(job, wait: float, terms: tuple[str, ...] | None, cancel: threading.Event) -> tuple[str, str | None]:
    """Espera a que termine el comando (CommandJob), a que una línea nueva de su salida contenga alguno de terms
    o a que pase wait.

    Recorre la salida que el modelo aún no ha visto, línea a línea; la última línea, si no está completa,
    solo se compara cuando el comando termina. Devuelve el motivo y la línea que coincidió.
    """
    deadline = time.monotonic() + wait
    pos = job.model_cursor
    partial = ""
    while True:
        finished = job.done.is_set()
        total = job.total
        if terms is not None and total > pos:
            text, pos = job.read_range(pos, total - pos)
            lines = (partial + text).split("\n")
            partial = lines.pop()
            for line in lines:
                if line_matches(line, terms):
                    return "pattern_matched", line
        if finished and (terms is None or pos >= job.total):
            if terms is not None and partial and line_matches(partial, terms):
                return "pattern_matched", partial
            return "command_finished", None
        if cancel.is_set():
            return "wait_ended_by_user", None
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return "wait_elapsed", None
        if terms is None:
            job.done.wait(min(remaining, WAIT_SLICE_SECONDS))
        else:
            job.wait_change(pos, min(remaining, WAIT_SLICE_SECONDS))
