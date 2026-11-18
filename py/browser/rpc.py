"""Métodos JSON-RPC de la sección Navegador de Ajustes: configuración, datos y motores propios de Playwright."""

from __future__ import annotations

import subprocess

from browser.config import save_browser_config
from browser.engines import BROWSER_ENGINES, clear_own_browser_data
from core.rpc import INVALID_PARAMS, RpcOutcome, dispatch_table, rpc_error, rpc_result

BROWSER_METHODS = {
    "zerochat/browser/config/set": lambda params: rpc_result(save_browser_config(params.get("config"))),
    "zerochat/browser/data/clear": lambda params: rpc_result(clear_own_browser_data(params.get("engine"))),
    "zerochat/browser/engines/list": lambda _params: rpc_result(BROWSER_ENGINES.list()),
    "zerochat/browser/engines/install": lambda params: rpc_result(BROWSER_ENGINES.install(params.get("engine"))),
    "zerochat/browser/engines/remove": lambda params: rpc_result(BROWSER_ENGINES.remove(params.get("engine"))),
}


def dispatch_browser(method: str, params: dict) -> RpcOutcome:
    try:
        return dispatch_table(BROWSER_METHODS, method, params)
    except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as exc:
        return rpc_error(INVALID_PARAMS, str(exc))
