"""Métodos JSON-RPC de los servicios MCP externos: arrancar, detener y configurar desde la interfaz."""

from __future__ import annotations

from core.rpc import INVALID_PARAMS, RpcOutcome, parse_nonneg_int, rpc_error, rpc_result
from mcp.manager import GLOBAL_MCP_MANAGER

SERVER_CONTROL_METHODS = frozenset({
    "zerochat/external/servers/start",
    "zerochat/external/servers/wait",
    "zerochat/external/servers/stop",
    "zerochat/external/servers/configure",
    "zerochat/external/servers/secret",
})


def dispatch_server_control(method: str, params: dict) -> RpcOutcome:
    server_id = params.get("serverId")
    opts = params.get("options", {})
    if not isinstance(server_id, str) or not server_id:
        return rpc_error(INVALID_PARAMS, "serverId debe ser un texto no vacío.")
    if not isinstance(opts, dict):
        return rpc_error(INVALID_PARAMS, "options debe ser un objeto.")
    if method == "zerochat/external/servers/secret":
        return _set_secret(server_id, params)
    try:
        if method == "zerochat/external/servers/start":
            wait_ms = parse_nonneg_int(params.get("wait_ms"), "wait_ms")
            if wait_ms is not None and wait_ms > 0:
                GLOBAL_MCP_MANAGER.start_async(server_id)
                return rpc_result(GLOBAL_MCP_MANAGER.wait_server(server_id, wait_ms=wait_ms))
            servers = GLOBAL_MCP_MANAGER.start(server_id)
        elif method == "zerochat/external/servers/wait":
            since_rev = parse_nonneg_int(params.get("since_rev"), "since_rev")
            wait_ms = parse_nonneg_int(params.get("wait_ms"), "wait_ms", 25000)
            return rpc_result(GLOBAL_MCP_MANAGER.wait_server(
                server_id,
                since_rev=since_rev,
                wait_ms=25000 if wait_ms is None else wait_ms,
            ))
        elif method == "zerochat/external/servers/stop":
            servers = GLOBAL_MCP_MANAGER.stop(server_id)
        else:
            servers = GLOBAL_MCP_MANAGER.configure(server_id, opts)
    except KeyError as exc:
        return rpc_error(INVALID_PARAMS, str(exc.args[0]) if exc.args else str(exc))
    except ValueError as exc:
        return rpc_error(INVALID_PARAMS, str(exc))
    return rpc_result({"servers": servers, "externalTools": GLOBAL_MCP_MANAGER.tools()})


def _set_secret(server_id: str, params: dict) -> RpcOutcome:
    """Guarda el secreto `name` del servicio (o lo borra con value null). Solo escritura: ningún método lo devuelve."""
    name, value = params.get("name"), params.get("value")
    if not isinstance(name, str) or not name:
        return rpc_error(INVALID_PARAMS, "name debe ser un texto no vacío.")
    if value is not None and not isinstance(value, str):
        return rpc_error(INVALID_PARAMS, "value debe ser un texto o null.")
    try:
        servers = GLOBAL_MCP_MANAGER.set_secret(server_id, name, value)
        return rpc_result({"servers": servers, "externalTools": GLOBAL_MCP_MANAGER.tools()})
    except KeyError as exc:
        return rpc_error(INVALID_PARAMS, str(exc.args[0]) if exc.args else str(exc))
    except ValueError as exc:
        return rpc_error(INVALID_PARAMS, str(exc))
