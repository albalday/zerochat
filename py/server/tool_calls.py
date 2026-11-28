"""Punto único de ejecución de herramientas (tools/call de los dos endpoints) y métodos de permisos.

Autorizar un reto ejecuta la herramienta pendiente, por eso los métodos zerochat/security/* viven junto a la ejecución.
"""

from __future__ import annotations

import inspect
import json

from browser.config import PLAYWRIGHT_SERVER_ID, load_browser_config
from core.logging import log_event
from core.rpc import INTERNAL_ERROR, INVALID_PARAMS, RpcOutcome, dispatch_table, rpc_error, rpc_result
from mcp.manager import GLOBAL_MCP_MANAGER, public_tool_name
from run_mode.state import current_run_session
from security.context import SecurityContext
from security.controller import ACCESS_CONTROLLER
from security.rules import COMMAND_TOOL, JOB_CONTROL_TOOL, POLICY_ASK, POLICY_DENY
from server.state import BROWSER_LEASES, BROWSER_LEASE_IDLE_SECONDS
from tools.agents import CONTROLLER_TOOLS
from tools.browser_action import close_browser_session
from tools.browser_secret import PLAYWRIGHT_LOCAL_TOOLS
from tools.common import _tool_error
from tools.registry import LOCAL_TOOL_HANDLERS

PLAYWRIGHT_BROWSER_CLOSE = public_tool_name(PLAYWRIGHT_SERVER_ID, "browser_close")

# Un reto que no existe, ya se usó o es de otro proyecto.
CHALLENGE_NOT_FOUND = -32002


def tool_exception_result(ex: Exception) -> dict:
    return {"content": [{"type": "text", "text": _tool_error(str(ex))}], "isError": True}


def execute_tool(origin: str, tool_name: str, args: dict, ctx: SecurityContext,
                 conversation_id: str = "") -> tuple[dict | None, dict | None, str]:
    """
    Punto único de ejecución de herramientas locales y externas. Un navegador se reserva aquí, al
    ejecutar, para la conversación que lo usa: pedirlo sin llegar a ejecutar no lo ocupa.
    """
    if origin == "local":
        if tool_name == "browser_action":
            browser = tool_name
        elif tool_name in PLAYWRIGHT_LOCAL_TOOLS:
            browser = PLAYWRIGHT_SERVER_ID
        else:
            browser = None
    else:
        browser = PLAYWRIGHT_SERVER_ID if GLOBAL_MCP_MANAGER.server_of(tool_name) == PLAYWRIGHT_SERVER_ID else None
    if browser and not BROWSER_LEASES.acquire(browser, conversation_id, reset=lambda: _reset_browser(browser)):
        message = (f"The browser is in use by another conversation. It is released {int(BROWSER_LEASE_IDLE_SECONDS)} "
                   "seconds after its last action; tell the user or try again later. To use a browser at the same "
                   "time as that conversation, run this one on the server: it gets a browser of its own.")
        return {"content": [{"type": "text", "text": _tool_error(message)}], "isError": True}, None, message
    try:
        return run_tool(origin, tool_name, args, ctx)
    finally:
        # El plazo cuenta desde que la acción termina: lo que tarde no acorta lo que el modelo puede razonar después.
        if browser:
            BROWSER_LEASES.release(browser, conversation_id)


def _reset_browser(browser: str) -> None:
    """Deja en blanco el navegador que pasa a otra conversación (M98-D17): sin cookies, sesiones ni páginas de la
    anterior. Playwright con «Tu navegador» es el del usuario y no se toca."""
    try:
        if browser == "browser_action":
            close_browser_session()
        elif load_browser_config()["mode"] == "own":
            # Con --isolated, cerrar el navegador tira todo su estado; la siguiente acción abre otro vacío.
            GLOBAL_MCP_MANAGER.call(PLAYWRIGHT_BROWSER_CLOSE, {})
    except ValueError:
        pass  # Playwright MCP detenido: no queda nada de la conversación anterior.
    except Exception as exc:  # noqa: BLE001 - la conversación nueva sigue; queda en el registro
        log_event(f"[Browser] Could not reset the {browser} browser for another conversation: {exc}")


def run_tool(origin: str, tool_name: str, args: dict, ctx: SecurityContext) -> tuple[dict | None, dict | None, str]:
    """Ejecuta la herramienta y normaliza su resultado: (result, error JSON-RPC, detalle de error)."""
    if origin == "external":
        try:
            result = GLOBAL_MCP_MANAGER.call(tool_name, args)
        except Exception as ex:
            return tool_exception_result(ex), None, str(ex)
        tool_error_info = ""
        if isinstance(result, dict) and result.get("isError"):
            c_list = result.get("content", [])
            if c_list and isinstance(c_list, list) and isinstance(c_list[0], dict):
                tool_error_info = c_list[0].get("text", "Error en herramienta MCP externa")
            else:
                tool_error_info = "Error en herramienta MCP externa"
        return result, None, tool_error_info

    handler = LOCAL_TOOL_HANDLERS.get(tool_name)
    if not handler:
        return None, {"code": -32601, "message": f"Herramienta local '{tool_name}' no encontrada."}, ""
    try:
        # Solo las herramientas que actúan en el proyecto declaran ctx.
        takes_project = "ctx" in inspect.signature(handler).parameters
        tool_output_json = handler(**dict(args), **({"ctx": ctx} if takes_project else {}))
    except Exception as ex:
        return tool_exception_result(ex), None, str(ex)
    tool_error_info = ""
    try:
        parsed_out = json.loads(tool_output_json)
        if isinstance(parsed_out, dict) and parsed_out.get("success") is False:
            tool_error_info = str(parsed_out.get("error", "Error en herramienta local"))
    except (json.JSONDecodeError, TypeError, ValueError):
        pass
    return {"content": [{"type": "text", "text": tool_output_json}], "isError": bool(tool_error_info)}, None, tool_error_info


def with_job_key(args: dict, job_key: str | None) -> dict:
    return {**args, "job_key": job_key} if job_key else args


def _denied(tool_name: str, reason: str, detail: str = "") -> tuple[dict, None, str]:
    """Denegación por política; en una ejecución desatendida queda además en sus avisos."""
    session = current_run_session()
    if session is not None:
        session.add_warning(f"{tool_name}: {detail or reason}")
    err_msg = f"Bloqueado por política de seguridad: {detail or reason}"
    return {
        "content": [{"type": "text", "text": f"Error: {err_msg}"}],
        "isError": True,
        "securityStatus": "deny",
        "reason": reason
    }, None, err_msg


def _awaiting_approval(tool_name: str, args: dict, server_name: str, server_id: str, decision) -> tuple[dict, None, str]:
    """
    Lo que en la interfaz sería un reto, en una ejecución desatendida (local o de un servicio MCP externo) es una pausa:
    no se ejecuta, el runner cierra el turno y la ejecución termina en needs_input (tool_approval). La persona la
    aprueba o deniega en la interfaz y la reanudación ejecuta esa llamada (take_approved_call).
    """
    log_event(f"[run] {tool_name}: a la espera de que la persona la apruebe ({decision.details or decision.reason})")
    return {
        "awaitingApproval": True,
        "toolName": tool_name,
        "serverName": server_name,
        "serverId": server_id,
        "arguments": args,
        "ruleOffer": decision.rule_offer,
        "details": decision.details,
        "content": [{"type": "text", "text": "This tool needs the user's approval: the run pauses until they answer."}],
        "isError": False
    }, None, ""


def authorize_or_challenge(origin: str, tool_name: str, args: dict, ctx: SecurityContext,
                           job_key: str | None = None, conversation_id: str = "") -> tuple[dict | None, dict | None, str] | None:
    """Evalúa la política de seguridad y devuelve respuesta de denegación o reto si procede."""
    if origin == "external":
        server_id = GLOBAL_MCP_MANAGER.server_of(tool_name) or ""
        server_name = server_id or "external"
    else:
        server_id = ""
        server_name = "mcp-proxy"
    decision = ACCESS_CONTROLLER.evaluate_authorization(
        tool_name, args, context=ctx, server_name=server_name, server_id=server_id
    )
    if decision.status == POLICY_DENY:
        return _denied(tool_name, decision.reason)
    if decision.status == POLICY_ASK:
        session = current_run_session()
        if session is not None:
            if session.take_approved_call(tool_name, args):
                log_event(f"[run] {tool_name}: se ejecuta la llamada que la persona aprobó al reanudar")
                return None
            return _awaiting_approval(tool_name, args, server_name, server_id, decision)
        ch =ACCESS_CONTROLLER.create_challenge(
            tool_name, args, decision, server_name=server_name, server_id=server_id, origin=origin,
            context=ctx, job_key=job_key, conversation_id=conversation_id
        )
        return {
            "requiresAuthorization": True,
            "challengeId": ch["id"],
            "toolName": tool_name,
            "serverName": server_name,
            "serverId": server_id,
            "arguments": args,
            "ruleOffer": decision.rule_offer,
            "details": decision.details,
            "content": [{"type": "text", "text": "Esta herramienta requiere autorización del usuario."}],
            "isError": False
        }, None, ""
    return None


def call_tool(params: dict, ctx: SecurityContext) -> tuple[dict | None, dict | None, str]:
    """tools/call: evalúa, emite un reto o ejecuta la herramienta (local o de un servicio MCP) por el punto único."""
    tool_name = params.get("name", "")
    if tool_name in LOCAL_TOOL_HANDLERS:
        origin = "local"
    elif GLOBAL_MCP_MANAGER.server_of(tool_name):
        origin = "external"
    else:
        return None, {"code": -32601, "message": f"Herramienta local '{tool_name}' no encontrada."}, ""
    session = current_run_session()
    if session is not None and session.disabled_tools:
        disabled = set(session.disabled_tools)
        server_id = GLOBAL_MCP_MANAGER.server_of(tool_name) if origin == "external" else None
        if (tool_name in disabled or (server_id and server_id in disabled)
                or (origin == "local" and tool_name in PLAYWRIGHT_LOCAL_TOOLS and PLAYWRIGHT_SERVER_ID in disabled)):
            return {
                "content": [{"type": "text", "text": _tool_error(f"Herramienta '{tool_name}' desactivada en esta ejecución.")}],
                "isError": True,
            }, None, ""
    raw_args = params.get("arguments")
    args = dict(raw_args) if isinstance(raw_args, dict) else {}
    meta = params.get("_meta") if isinstance(params.get("_meta"), dict) else {}
    # Ni la clave de la invocación ni la conversación son argumentos del modelo: no se evalúan ni se muestran en
    # el reto. Con ella se detiene un run_command y se corta la espera de un check_command (zerochat/jobs/*).
    job_key = meta.get("zerochatJobKey") if origin == "local" and tool_name in (COMMAND_TOOL, JOB_CONTROL_TOOL) else None
    conversation_id = str(meta.get("zerochatConversationId") or "")
    # Las del controlador no piden permiso: lo dio quien lo pidió («Subagentes» en la interfaz o controller: true), y
    # fuera de un controlador sus manejadores se niegan. Con project, sus reglas de directorio deciden sin preguntar.
    if origin == "local" and tool_name in CONTROLLER_TOOLS:
        return execute_tool(origin, tool_name, args, ctx, conversation_id)
    gate = authorize_or_challenge(origin, tool_name, args, ctx, job_key, conversation_id)
    return gate if gate is not None else execute_tool(origin, tool_name, with_job_key(args, job_key), ctx, conversation_id)


def _authorize(params: dict, ctx: SecurityContext) -> RpcOutcome:
    """Resuelve un reto: lo deniega o, si se permite, ejecuta la herramienta pendiente por el punto único."""
    challenge_id = params.get("challengeId")
    if not challenge_id or not isinstance(challenge_id, str):
        return rpc_error(INVALID_PARAMS, "challengeId es obligatorio")
    decision = params.get("decision", "deny")
    if not isinstance(decision, str):
        return rpc_error(INVALID_PARAMS, "decision debe ser un texto")
    if decision == "deny":
        ACCESS_CONTROLLER.revoke_challenge(challenge_id, context=ctx)
        return rpc_result({"authorized": False, "status": "deny"})
    ch = ACCESS_CONTROLLER.authorize_challenge(
        challenge_id, decision, context=ctx,
        command_pattern=params.get("commandPattern"), directory_rule=params.get("directoryRule")
    )
    if not ch:
        return rpc_error(CHALLENGE_NOT_FOUND, "Reto no encontrado o no válido")
    t_origin = ch.get("origin") or "local"
    t_args = ch["arguments"] if isinstance(ch.get("arguments"), dict) else {}
    exec_res, exec_err, tool_err = execute_tool(t_origin, ch["toolName"], with_job_key(t_args, ch.get("jobKey")), ctx, ch.get("conversationId") or "")
    if exec_err:
        return None, exec_err, tool_err
    return {"authorized": True, "result": exec_res, "policies": ACCESS_CONTROLLER.export_state(ctx)}, None, tool_err


SECURITY_METHODS = {
    "zerochat/security/update": lambda params, ctx: rpc_result({"policies": ACCESS_CONTROLLER.import_state(params, context=ctx)}),
    "zerochat/security/authorize": _authorize,
}


def dispatch_security(method: str, params: dict, ctx: SecurityContext) -> RpcOutcome:
    """Políticas y reglas de seguridad almacenadas en el backend local, y resolución de retos."""
    try:
        return dispatch_table(SECURITY_METHODS, method, params if isinstance(params, dict) else {}, ctx)
    except ValueError as exc:
        return rpc_error(INVALID_PARAMS, str(exc))
    except Exception as exc:
        return rpc_error(INTERNAL_ERROR, f"Error de seguridad: {exc}", str(exc))
