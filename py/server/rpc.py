"""Métodos JSON-RPC de los dos endpoints del servidor: una tabla por método exacto y otra por grupo (prefijo).

Cada método vive junto a su dominio (storage/rpc.py, tools/jobs_rpc.py, run_mode/state.py…); aquí solo se
decide quién atiende cada uno.
"""

from __future__ import annotations

from auth.login import LoginError, login
from browser.rpc import dispatch_browser
from core.environment import DETECTED_OS
from core.rpc import INTERNAL_ERROR, INVALID_PARAMS, METHOD_NOT_FOUND, RpcOutcome, dispatch_table, rpc_error, rpc_not_supported, rpc_result
from core.version import VERSION
from mcp.manager import GLOBAL_MCP_MANAGER
from mcp.rpc import SERVER_CONTROL_METHODS, dispatch_server_control
from run_mode.state import dispatch_run
from security.context import SecurityContext
from server.state import live_state
from server.tool_calls import call_tool, dispatch_security
from storage.rpc import dispatch_blobs, dispatch_conversations, dispatch_profiles
from tools.diff import configure_gui_diff_tool, open_file_diff
from tools.filesystem import resolve_project_directory
from tools.jobs_rpc import dispatch_jobs
from tools.project_files import dispatch_files
from tools.registry import LOCAL_TOOLS_DEFINITIONS
from tools.sandbox import execute_js_sandbox
from web.fetch import fetch_web_resource


def initialize_result(server_info: dict) -> dict:
    return {
        "protocolVersion": "2024-11-05",
        "serverInfo": server_info,
        "capabilities": {
            "tools": {"listChanged": True}
        }
    }


def rpc_login(params: dict) -> RpcOutcome:
    """zerochat/login: identificación con la cuenta del sistema; se atiende también sin token."""
    try:
        return rpc_result(login(params))
    except LoginError as exc:
        error = {"code": exc.code, "message": str(exc)}
        if exc.data:
            error["data"] = exc.data
        return None, error, ""
    except (RuntimeError, OSError) as exc:
        return rpc_error(INTERNAL_ERROR, f"No se pudo comprobar la contraseña: {exc}", str(exc))


def _initialize(_params: dict, ctx: SecurityContext) -> RpcOutcome:
    server_info = {
        "name": "ZeroChat Local Server",
        "version": VERSION,
        "cwd": str(ctx.workspace_dir),
        "os": DETECTED_OS
    }
    return rpc_result({**initialize_result(server_info), "liveState": live_state(ctx)})


def _heartbeat(params: dict, ctx: SecurityContext) -> RpcOutcome:
    return rpc_result(live_state(ctx, params.get("focus_conversation_id")))


def _set_project_directory(params: dict, ctx: SecurityContext) -> RpcOutcome:
    # Lo invoca la interfaz a petición del usuario: no es una herramienta del modelo.
    try:
        return rpc_result(resolve_project_directory(params.get("path"), ctx))
    except (ValueError, OSError) as exc:
        return rpc_error(INVALID_PARAMS, str(exc))


def _open_diff(params: dict, ctx: SecurityContext) -> RpcOutcome:
    try:
        return rpc_result(open_file_diff(params.get("path"), ctx, bool(params.get("commit_fallback")), bool(params.get("gui"))))
    except (ValueError, RuntimeError) as exc:
        return rpc_error(INVALID_PARAMS, str(exc))
    except Exception as exc:
        return rpc_error(INTERNAL_ERROR, f"Error al abrir el visor de diffs: {exc}", str(exc))


def _configure_diff(params: dict, _ctx: SecurityContext) -> RpcOutcome:
    try:
        return rpc_result(configure_gui_diff_tool(params.get("tool")))
    except (ValueError, RuntimeError) as exc:
        return rpc_error(INVALID_PARAMS, str(exc))
    except Exception as exc:
        return rpc_error(INTERNAL_ERROR, f"Error configurando el visor de diffs: {exc}", str(exc))


def _web_fetch(params: dict, _ctx: SecurityContext) -> RpcOutcome:
    try:
        return rpc_result(fetch_web_resource(params))
    except (ValueError, PermissionError) as exc:
        return rpc_error(INVALID_PARAMS, str(exc))
    except Exception as exc:
        return rpc_error(INTERNAL_ERROR, f"Error en transporte web: {exc}", str(exc))


def _sandbox_execute(params: dict, _ctx: SecurityContext) -> RpcOutcome:
    try:
        return rpc_result(execute_js_sandbox(params.get("code"), timeout_ms=params.get("timeout_ms")))
    except ValueError as exc:
        return rpc_error(INVALID_PARAMS, str(exc))
    except Exception as exc:
        return rpc_error(INTERNAL_ERROR, f"Error en sandbox JS: {exc}", str(exc))


LOCAL_METHODS = {
    "initialize": _initialize,
    "zerochat/heartbeat": _heartbeat,
    "zerochat/login": lambda params, _ctx: rpc_login(params),
    "tools/list": lambda _params, _ctx: rpc_result({"tools": [dict(definition) for definition in LOCAL_TOOLS_DEFINITIONS]}),
    "tools/call": lambda params, ctx: call_tool("local", params, ctx),
    "zerochat/project/set_directory": _set_project_directory,
    "zerochat/diff/open": _open_diff,
    "zerochat/diff/configure": _configure_diff,
    "zerochat/web/fetch": _web_fetch,
    "zerochat/sandbox/execute": _sandbox_execute,
}


def _server_control(method: str, params: dict, _ctx: SecurityContext) -> RpcOutcome:
    return dispatch_server_control(method, params) if method in SERVER_CONTROL_METHODS else rpc_not_supported(method)


# Grupos de métodos, por prefijo: cada despachador recibe (method, params, ctx).
LOCAL_METHOD_GROUPS = (
    ("zerochat/jobs/", dispatch_jobs),
    ("zerochat/files/", dispatch_files),
    ("zerochat/run/", dispatch_run),
    ("zerochat/external/servers/", _server_control),
    ("zerochat/browser/", lambda method, params, _ctx: dispatch_browser(method, params)),
    ("zerochat/profiles/", lambda method, params, _ctx: dispatch_profiles(method, params)),
    ("zerochat/conversations/", lambda method, params, _ctx: dispatch_conversations(method, params)),
    ("zerochat/blobs/", lambda method, params, _ctx: dispatch_blobs(method, params)),
    ("zerochat/security/", dispatch_security),
)


def dispatch_local(method: str, params: dict, ctx: SecurityContext) -> RpcOutcome:
    """Endpoint local: (resultado, error JSON-RPC, detalle de error de herramienta)."""
    if method in LOCAL_METHODS:
        return LOCAL_METHODS[method](params, ctx)
    for prefix, dispatcher in LOCAL_METHOD_GROUPS:
        if method.startswith(prefix):
            return dispatcher(method, params, ctx)
    return rpc_not_supported(method)


EXTERNAL_METHODS = {
    "initialize": lambda _params, _ctx: rpc_result(initialize_result({"name": "ZeroChat External MCP Host", "version": VERSION})),
    "tools/list": lambda _params, _ctx: rpc_result({"tools": GLOBAL_MCP_MANAGER.tools()}),
    "tools/call": lambda params, ctx: call_tool("external", params, ctx),
}


def dispatch_external(method: str, params: dict, ctx: SecurityContext) -> RpcOutcome:
    """Endpoint /mcp/external: las herramientas de los servicios MCP externos."""
    if method in EXTERNAL_METHODS:
        return dispatch_table(EXTERNAL_METHODS, method, params, ctx)
    return rpc_error(METHOD_NOT_FOUND, f"Método '{method}' no soportado en /mcp/external.")
