"""Métodos JSON-RPC del servidor local: una tabla por método exacto y otra por grupo (prefijo).

Cada método vive junto a su dominio (storage/rpc.py, tools/jobs_rpc.py, run_mode/state.py…); aquí solo se
decide quién atiende cada uno.
"""

from __future__ import annotations

from pathlib import Path

from auth.login import LoginError, login
from browser.rpc import dispatch_browser
from core.environment import DETECTED_OS, get_no_project_dir
from core.rpc import INTERNAL_ERROR, INVALID_PARAMS, RpcOutcome, rpc_error, rpc_not_supported, rpc_result
from core.version import VERSION
from mcp.manager import GLOBAL_MCP_MANAGER
from mcp.rpc import SERVER_CONTROL_METHODS, dispatch_server_control
from run_mode.state import dispatch_run
from security.context import SecurityContext
from security.controller import ACCESS_CONTROLLER
from server.state import live_state
from server.tool_calls import call_tool, dispatch_security
from storage.db import get_project_environment, save_project_environment
from storage.rpc import dispatch_blobs, dispatch_conversations, dispatch_profiles
from tools.diff import configure_gui_diff_tool, open_file_diff
from tools.filesystem import browse_directories, create_project_directory, read_project_context, resolve_project_directory
from tools.jobs_rpc import dispatch_jobs
from tools.project_files import dispatch_files
from tools.registry import LOCAL_TOOLS_DEFINITIONS
from tools.sandbox import execute_js_sandbox
from web.fetch import fetch_web_resource


def _local_tools() -> list[dict]:
    return [dict(definition) for definition in LOCAL_TOOLS_DEFINITIONS]


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
    return rpc_result({
        "protocolVersion": "2024-11-05",
        "serverInfo": {
            "name": "ZeroChat Local Server",
            "version": VERSION,
            "cwd": str(ctx.workspace_dir),
            "noProjectDir": str(get_no_project_dir()),
            "os": DETECTED_OS,
        },
        "capabilities": {
            "tools": {"listChanged": True},
        },
        "tools": _local_tools(),
        "policies": ACCESS_CONTROLLER.export_state(ctx),
        "projectContext": read_project_context(ctx),
        "projectEnvironment": get_project_environment(ctx.key),
        "liveState": live_state(ctx),
    })


def _heartbeat(params: dict, ctx: SecurityContext) -> RpcOutcome:
    return rpc_result(live_state(ctx, params.get("focus_conversation_id")))


def _set_project_directory(params: dict, ctx: SecurityContext) -> RpcOutcome:
    # Lo invoca la interfaz a petición del usuario: no es una herramienta del modelo.
    try:
        resolved = resolve_project_directory(params.get("path"), ctx)
        next_ctx = SecurityContext(workspace_dir=Path(resolved["cwd"]))
        return rpc_result({
            **resolved,
            "policies": ACCESS_CONTROLLER.export_state(next_ctx),
            "projectContext": read_project_context(next_ctx),
            "projectEnvironment": get_project_environment(next_ctx.key),
        })
    except (ValueError, OSError) as exc:
        return rpc_error(INVALID_PARAMS, str(exc))


def _set_project_environment(params: dict, ctx: SecurityContext) -> RpcOutcome:
    try:
        return rpc_result({"projectEnvironment": save_project_environment(ctx.key, params)})
    except ValueError as exc:
        return rpc_error(INVALID_PARAMS, str(exc))


def _browse_directories(params: dict, ctx: SecurityContext) -> RpcOutcome:
    # Como set_directory, lo invoca la interfaz para que la persona elija la carpeta de trabajo.
    try:
        return rpc_result(browse_directories(params, ctx))
    except (ValueError, OSError) as exc:
        return rpc_error(INVALID_PARAMS, str(exc))


def _create_directory(params: dict, ctx: SecurityContext) -> RpcOutcome:
    try:
        return rpc_result(create_project_directory(params, ctx))
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
    "tools/list": lambda _params, _ctx: rpc_result({"tools": _local_tools() + GLOBAL_MCP_MANAGER.tools()}),
    "tools/call": call_tool,
    "zerochat/project/context": lambda _params, ctx: rpc_result(read_project_context(ctx)),
    "zerochat/project/environment/get": lambda _params, ctx: rpc_result({"projectEnvironment": get_project_environment(ctx.key)}),
    "zerochat/project/environment/set": _set_project_environment,
    "zerochat/project/set_directory": _set_project_directory,
    "zerochat/project/browse": _browse_directories,
    "zerochat/project/create_directory": _create_directory,
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
