"""Métodos JSON-RPC de los servicios MCP externos: arrancar, detener y configurar desde la interfaz."""

from __future__ import annotations

from browser.config import SERVICE_LAUNCH, validate_profile_browser
from core.rpc import INVALID_PARAMS, RpcOutcome, rpc_error, rpc_result
from mcp.manager import GLOBAL_MCP_MANAGER

SERVER_CONTROL_METHODS = frozenset({
    "zerochat/external/servers/start",
    "zerochat/external/servers/stop",
    "zerochat/external/servers/configure",
    "zerochat/external/servers/secret",
})


def dispatch_server_control(method: str, params: dict) -> RpcOutcome:
    server_id = params.get("serverId")
    opts = params.get("options", {})
    remember = params.get("remember")
    browser = params.get("browser")
    starting = method == "zerochat/external/servers/start"
    if not isinstance(server_id, str) or not server_id:
        return rpc_error(INVALID_PARAMS, "serverId debe ser un texto no vacío.")
    if not isinstance(opts, dict):
        return rpc_error(INVALID_PARAMS, "options debe ser un objeto.")
    # Al arrancar, el cliente decide siempre si el servicio se recuerda para la siguiente sesión.
    if starting and not isinstance(remember, bool):
        return rpc_error(INVALID_PARAMS, "remember es obligatorio al arrancar y debe ser un booleano.")
    if starting and browser is not None:
        if server_id not in SERVICE_LAUNCH:
            return rpc_error(INVALID_PARAMS, f"{server_id} no admite elegir navegador.")
        try:
            browser = validate_profile_browser(browser)
        except ValueError as exc:
            return rpc_error(INVALID_PARAMS, str(exc))
    if method == "zerochat/external/servers/secret":
        return _set_secret(server_id, params)
    try:
        if starting:
            servers = GLOBAL_MCP_MANAGER.start(server_id, remember, browser)
        elif method == "zerochat/external/servers/stop":
            servers = GLOBAL_MCP_MANAGER.stop(server_id)
        else:
            servers = GLOBAL_MCP_MANAGER.configure(server_id, opts)
    except KeyError as exc:
        return rpc_error(INVALID_PARAMS, str(exc.args[0]) if exc.args else str(exc))
    return rpc_result({"servers": servers})


def _set_secret(server_id: str, params: dict) -> RpcOutcome:
    """Guarda el secreto `name` del servicio (o lo borra con value null). Solo escritura: ningún método lo devuelve."""
    name, value = params.get("name"), params.get("value")
    if not isinstance(name, str) or not name:
        return rpc_error(INVALID_PARAMS, "name debe ser un texto no vacío.")
    if value is not None and not isinstance(value, str):
        return rpc_error(INVALID_PARAMS, "value debe ser un texto o null.")
    try:
        return rpc_result({"servers": GLOBAL_MCP_MANAGER.set_secret(server_id, name, value)})
    except KeyError as exc:
        return rpc_error(INVALID_PARAMS, str(exc.args[0]) if exc.args else str(exc))
    except ValueError as exc:
        return rpc_error(INVALID_PARAMS, str(exc))
