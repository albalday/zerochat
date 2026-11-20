"""Métodos JSON-RPC de la sección Navegador de Ajustes: configuración, datos y motores propios de Playwright."""

from __future__ import annotations

import subprocess

from browser.config import save_browser_config
from browser.engines import BROWSER_ENGINES, clear_own_browser_data
from core.rpc import INVALID_PARAMS, RpcOutcome, dispatch_table, rpc_error, rpc_result

def _engines_list(params: dict) -> RpcOutcome:
    since_rev = params.get("since_rev")
    wait_ms = params.get("wait_ms", 0)
    engines_only = params.get("engines_only", False)
    if since_rev is not None and (isinstance(since_rev, bool) or not isinstance(since_rev, int) or since_rev < 0):
        raise ValueError("since_rev debe ser un entero no negativo")
    if isinstance(wait_ms, bool) or not isinstance(wait_ms, int) or wait_ms < 0:
        raise ValueError("wait_ms debe ser un entero no negativo")
    if not isinstance(engines_only, bool):
        raise ValueError("engines_only debe ser un booleano")
    return rpc_result(BROWSER_ENGINES.list(since_rev=since_rev, wait_ms=wait_ms, engines_only=engines_only))


BROWSER_METHODS = {
    "zerochat/browser/config/set": lambda params: rpc_result(save_browser_config(params.get("config"))),
    "zerochat/browser/data/clear": lambda params: rpc_result(clear_own_browser_data(params.get("engine"))),
    "zerochat/browser/engines/list": _engines_list,
    "zerochat/browser/engines/install": lambda params: rpc_result(BROWSER_ENGINES.install(params.get("engine"))),
    "zerochat/browser/engines/remove": lambda params: rpc_result(BROWSER_ENGINES.remove(params.get("engine"))),
}


def dispatch_browser(method: str, params: dict) -> RpcOutcome:
    try:
        return dispatch_table(BROWSER_METHODS, method, params)
    except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as exc:
        return rpc_error(INVALID_PARAMS, str(exc))
