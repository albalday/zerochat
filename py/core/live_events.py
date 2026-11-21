"""Avisos de cambio del estado vivo que sigue el latido: cada dominio avisa y server/state despierta a quien espera."""

from __future__ import annotations

import typing

_LIVE_CHANGE_HOOKS: list[typing.Callable[[], None]] = []


def on_live_change(hook: typing.Callable[[], None]):
    """Registra una función sin argumentos que se llama cuando cambia algo del estado vivo."""
    _LIVE_CHANGE_HOOKS.append(hook)
    return hook


def notify_live_change() -> None:
    """Avisa a los registrados de que el estado vivo (comandos, servicios, motores, ejecuciones o conversaciones) cambió."""
    for hook in list(_LIVE_CHANGE_HOOKS):
        hook()
