"""Control de frecuencia y paralelismo de las llamadas salientes, por recurso (un dominio web o un servicio MCP).

No es un control de gasto: solo evita saturar un sitio o un servicio (retos anti-bot de DuckDuckGo, límites por
segundo de una API). La cuenta vive en memoria de este proceso; una ejecución en servidor (--prompt, --conversation)
lleva la suya.
"""

from __future__ import annotations

import contextlib
import dataclasses
import threading
import time
from collections.abc import Iterator

# Lo más que una llamada espera su turno; si haría falta más, falla enseguida con RateLimitBusy.
RATE_LIMIT_MAX_WAIT_S = 30.0


@dataclasses.dataclass(frozen=True)
class RatePolicy:
    """`concurrency` llamadas a la vez y `min_interval_s` desde la respuesta anterior al mismo recurso."""
    concurrency: int = 1
    min_interval_s: float = 0.0


class RateLimitBusy(Exception):
    """El recurso no queda libre dentro de la espera admitida."""

    def __init__(self, key: str, max_wait_s: float):
        super().__init__(f"{key} está ocupado: hay demasiadas llamadas seguidas o a la vez y no queda libre en "
                         f"{max_wait_s:.0f} s. Espera un poco antes de volver a llamarlo.")


@dataclasses.dataclass
class _ResourceState:
    active: int
    last_done: float


def parse_rate_policy(value) -> RatePolicy | None:
    """La política de un `rateLimit` declarado ({"concurrency", "minIntervalS"}), o None si no declara ninguna válida."""
    if not isinstance(value, dict):
        return None
    concurrency, interval = value.get("concurrency", 1), value.get("minIntervalS", 0)
    if isinstance(concurrency, bool) or not isinstance(concurrency, int) or not 1 <= concurrency <= 64:
        return None
    if isinstance(interval, bool) or not isinstance(interval, int | float) or not 0 <= interval <= 60:
        return None
    return RatePolicy(concurrency=concurrency, min_interval_s=float(interval))


class RateLimiter:
    """Turnos por recurso. La separación se cuenta desde la respuesta anterior, y al arrancar el proceso como si
    acabara de haber una: la primera llamada tras arrancar también espera, como las siguientes."""

    def __init__(self):
        self._condition = threading.Condition()
        self._resources: dict[str, _ResourceState] = {}
        self._started = time.monotonic()

    @contextlib.contextmanager
    def slot(self, key: str, policy: RatePolicy, max_wait_s: float = RATE_LIMIT_MAX_WAIT_S) -> Iterator[float]:
        """Espera el turno del recurso `key` y devuelve los segundos esperados; RateLimitBusy si no llega a tiempo."""
        started = time.monotonic()
        deadline = started + max(0.0, max_wait_s)
        with self._condition:
            state = self._resources.setdefault(key, _ResourceState(0, self._started))
            while True:
                now = time.monotonic()
                gap = policy.min_interval_s - (now - state.last_done)
                if state.active < policy.concurrency and gap <= 0:
                    break
                # Con hueco libre se sabe cuánto falta; sin él, hasta que termine otra llamada.
                wait = gap if state.active < policy.concurrency else deadline - now
                if now + max(wait, 0.0) > deadline or deadline - now <= 0:
                    raise RateLimitBusy(key, max_wait_s)
                self._condition.wait(max(wait, 0.001))
            state.active += 1
        waited = time.monotonic() - started
        try:
            yield waited
        finally:
            with self._condition:
                state.active -= 1
                state.last_done = time.monotonic()
                self._condition.notify_all()


RATE_LIMITER = RateLimiter()
