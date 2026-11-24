"""Avisos de cambio del estado vivo que sigue el latido: cada dominio avisa y server/state despierta a quien espera."""

from __future__ import annotations

import threading
import time
import typing

_LIVE_CHANGE_HOOKS: list[typing.Callable[[], None]] = []
# Secuencia de avisos, para que quien espera un cambio no pierda uno que llegue mientras relee (wait_live_change).
_LIVE_CHANGE_COND = threading.Condition()
_LIVE_CHANGE_SEQ = 0


def on_live_change(hook: typing.Callable[[], None]):
    """Registra una función sin argumentos que se llama cuando cambia algo del estado vivo."""
    _LIVE_CHANGE_HOOKS.append(hook)
    return hook


def notify_live_change() -> None:
    """Avisa a los registrados de que el estado vivo (comandos, servicios, motores, ejecuciones o conversaciones) cambió."""
    global _LIVE_CHANGE_SEQ
    with _LIVE_CHANGE_COND:
        _LIVE_CHANGE_SEQ += 1
        _LIVE_CHANGE_COND.notify_all()
    for hook in list(_LIVE_CHANGE_HOOKS):
        hook()


def live_change_seq() -> int:
    """Número del último aviso: se toma antes de leer el estado y se pasa a wait_live_change."""
    with _LIVE_CHANGE_COND:
        return _LIVE_CHANGE_SEQ


def wait_live_change(seq: int, timeout: float) -> int:
    """Espera como mucho timeout segundos a un aviso posterior a seq, sin sondeo; devuelve el número del último."""
    deadline = time.monotonic() + max(0.0, timeout)
    with _LIVE_CHANGE_COND:
        while _LIVE_CHANGE_SEQ == seq:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            _LIVE_CHANGE_COND.wait(remaining)
        return _LIVE_CHANGE_SEQ
