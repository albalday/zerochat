"""Esperas de check_command a un comando: vuelven cuando termina, cuando una línea nueva de su salida contiene un
texto o al agotar el plazo, que es un máximo. La persona puede cortarlas con la clave de la invocación."""

from __future__ import annotations

import threading
import time
import typing

from tools.common import line_matches


class _WakeableJob(typing.Protocol):
    """Lo que una espera necesita del comando (CommandJob): despertar a quien espera su salida."""

    def wake_waiters(self) -> None: ...


class CancellableWaits:
    """Esperas en curso, por la clave de su invocación: zerochat/jobs/end_wait corta la de esa clave."""

    def __init__(self):
        self._lock = threading.Lock()
        self._waits: dict[str, tuple[threading.Event, _WakeableJob]] = {}

    def open(self, key: str | None, job: _WakeableJob) -> threading.Event:
        """Registra una espera que se puede cortar con cancel(key); sin clave no se puede cortar."""
        event = threading.Event()
        if key:
            with self._lock:
                self._waits[key] = (event, job)
        return event

    def close(self, key: str | None):
        if key:
            with self._lock:
                self._waits.pop(key, None)

    def cancel(self, key) -> bool:
        """Corta la espera con esa clave y despierta al hilo que espera en job._changed."""
        with self._lock:
            entry = self._waits.get(key) if isinstance(key, str) else None
        if entry is None:
            return False
        event, job = entry
        event.set()
        job.wake_waiters()
        return True


WAITS = CancellableWaits()

# De una línea que aún no ha terminado se guarda solo su final para compararlo: una salida sin saltos de línea
# (un minificado, un volcado binario) no crece en memoria ni se vuelve a recorrer entera en cada lectura.
WAIT_PARTIAL_MAX_CHARS = 64 * 1024


def _wait_job(job, wait: float, terms: tuple[str, ...] | None, cancel: threading.Event) -> tuple[str, str | None]:
    """Espera a que termine el comando (CommandJob), a que una línea nueva de su salida contenga alguno de terms
    o a que pase wait.

    Recorre la salida que el modelo aún no ha visto, línea a línea (\n o \r); la última línea, si no está completa,
    solo se compara cuando el comando termina, y de ella cuentan sus últimos WAIT_PARTIAL_MAX_CHARS caracteres.
    Devuelve el motivo y la línea que coincidió.
    """
    deadline = time.monotonic() + wait
    pos = job.model_cursor
    partial = ""
    while True:
        finished = job.done.is_set()
        total = job.total
        if terms is not None and total > pos:
            text, pos = job.read_range(pos, total - pos)
            # Una barra de progreso reescribe su línea con \r: cada tramo cuenta como una línea, como en la terminal.
            lines = (partial + text).replace("\r", "\n").split("\n")
            partial = lines.pop()[-WAIT_PARTIAL_MAX_CHARS:]
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
        job.wait_change(pos if terms is not None else None, remaining, cancel)
