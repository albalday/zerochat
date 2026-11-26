"""check_agents, launch_agent, stop_agent y prune_agents: las herramientas de un agente controlador. Lo es una
ejecución --run-file con controller: true, una ejecución en segundo plano de un chat con «Subagentes» y cada
conversación del servidor de la interfaz, que solo las ofrece al modelo con «Subagentes» encendido.

check_agents lee conversaciones y ejecuciones de SQLite filtrando estrictamente por un proyecto (el de la ejecución o,
con project, otro sobre el que sus reglas de directorio den lectura) y por tener agente: nunca chats humanos (sin agent)
ni la conversación del propio controlador, y con wait_seconds espera sin sondeo a que cambien. launch_agent lanza un
run-file (o un agente en línea) de ese proyecto separado del controlador, con el entorno guardado y los permisos del
proyecto en que se ejecuta (con project, X sobre esa carpeta además de R sobre el run-file), y nunca el de otro
controlador: no hay anidamiento. stop_agent detiene una conversación en marcha que este controlador lanzó en esta
ejecución. prune_agents borra, solo bajo petición, las conversaciones antiguas de los agentes (nunca hay limpieza
automática).
"""

from __future__ import annotations

import json
import time
import uuid
from pathlib import Path

from core.environment import get_no_project_dir
from core.limits import TOOL_WAIT_MAX_SECONDS
from core.live_events import live_change_seq, wait_live_change
from core.process import _kill_process_tree
from run_mode.state import (
    MAX_CONCURRENT_RUNS,
    RUN_FILE_LIMIT_KEYS,
    RUN_FILE_MAX_BYTES,
    RUN_REASONING_LEVELS,
    ControllerState,
    check_no_active_run,
    current_run_session,
    format_run_request,
    launch_run_file,
    parse_run_request,
    run_process_alive,
    running_run_count,
    watch_run_exit,
)
from security.context import SecurityContext, normalize_directory_path
from security.controller import ACCESS_CONTROLLER
from storage.db import (
    MAX_AGENT_ID_LENGTH,
    MAX_CONVERSATION_ID_LENGTH,
    MAX_PROJECT_PROMPT_LENGTH,
    MAX_PROJECT_TOOL_ID_LENGTH,
    delete_conversation,
    delete_run_state,
    get_conversation,
    get_conversation_launch,
    get_project_environment,
    get_run_state,
    list_conversations,
    upsert_run_state,
)
from tools.common import _tool_error

AGENTS_TOOL = "check_agents"
LAUNCH_AGENT_TOOL = "launch_agent"
STOP_AGENT_TOOL = "stop_agent"
PRUNE_AGENTS_TOOL = "prune_agents"
# Las herramientas del controlador: se publican juntas en el servidor de la interfaz y en una ejecución controladora,
# que además las autoriza; nunca en otra ejecución.
CONTROLLER_TOOLS = (AGENTS_TOOL, LAUNCH_AGENT_TOOL, STOP_AGENT_TOOL, PRUNE_AGENTS_TOOL)
# Tope del prompt que launch_agent pone en lugar del del run-file.
MAX_LAUNCH_PROMPT_LENGTH = 32768
# Respuesta final de cada agente en el listado: entera hasta AGENT_LIST_RESULT_MAX_CHARS, y entre todas como mucho
# AGENT_LIST_TOTAL_CHARS; la que no cabe se omite con su longitud (result_chars) para leerla en el detalle.
AGENT_LIST_RESULT_MAX_CHARS = 4000
AGENT_LIST_TOTAL_CHARS = 24000
# Bloque de la respuesta final que devuelve el detalle por página (offset y next_offset).
AGENT_RESULT_PAGE_CHARS = 20000
# Texto de los mensajes del último turno que devuelve el detalle con include_turn, entre todos.
AGENT_TURN_MAX_CHARS = 20000
# Tope de wait_seconds: el único de las esperas de herramientas (TOOL_WAIT_MAX_SECONDS).
AGENT_MAX_WAIT = TOOL_WAIT_MAX_SECONDS
# Los agentes corren en otros procesos: su final llega sin sondeo (se espera su PID, watch_run_exit), pero una
# ejecución nueva (lanzada por cron o por un script) solo se ve en SQLite, así que la espera la relee cada tanto.
AGENT_WAIT_RECHECK_SECONDS = 5.0
# Estados que cortan una espera aunque otros agentes sigan en marcha: alguien tiene que mirarlos.
AGENT_ATTENTION_STATUSES = ("needs_input", "error")
# Tope de keep en prune_agents: cuántas conversaciones recientes de cada agente puede pedir conservar el controlador.
AGENT_PRUNE_KEEP_MAX = 1000
# Lo que se da al agente para cerrar antes de matarlo al detenerlo (stop_agent), y el error con que queda su ejecución.
AGENT_STOP_GRACE_SECONDS = 2.0
AGENT_STOPPED_ERROR = "Stopped by its controller."
# Estados que la limpieza nunca borra: una ejecución en marcha o una pausa que espera a una persona.
AGENT_PRUNE_PROTECTED = ("running", "needs_input")


# El del servidor de la interfaz, que es de un solo usuario: uno para todas sus conversaciones y pestañas, en memoria
# hasta que el servidor se cierra, como el de una ejecución.
INTERFACE_CONTROLLER = ControllerState()


def _clip(text: str, limit: int) -> tuple[str, bool]:
    return (text, False) if len(text) <= limit else (text[:limit], True)


def _conversation_project(ctx: SecurityContext) -> str:
    """El proyecto de las conversaciones de esta ejecución: su carpeta, o vacío en la carpeta general."""
    return "" if ctx.key == normalize_directory_path(str(get_no_project_dir())) else ctx.key


def _target_project(ctx: SecurityContext, project: str | None, access: str) -> SecurityContext:
    """El proyecto sobre el que actúa el controlador: el suyo o, con project, otra carpeta sobre la que sus reglas de
    directorio den `access` (R para consultar, X para lanzar, RW para borrar). ValueError con el motivo si no vale."""
    if project is None:
        return ctx
    if not isinstance(project, str) or not project.strip():
        raise ValueError("project must be the folder of a project.")
    try:
        folder = ctx.absolute(project.strip())
    except ValueError as exc:
        raise ValueError(f"project is not a valid folder: {exc}") from exc
    if not folder.is_dir():
        raise ValueError(f"The project folder does not exist: {folder}")
    target = SecurityContext(workspace_dir=folder)
    if target.key != ctx.key and not ACCESS_CONTROLLER.allows_path(access, str(folder), ctx):
        raise ValueError(f"This project's directory rules do not give {access} access to {folder}.")
    return target


def _agent_conversations(ctx: SecurityContext, own_id: str, state: ControllerState) -> list[dict]:
    """Conversaciones de agentes del proyecto, de la más reciente a la más antigua, sin la del propio controlador.
    Incluye las que este controlador lanzó y el agente aún no ha guardado: su fila de runs ya está en marcha."""
    project = _conversation_project(ctx)
    convs = [conv for conv in list_conversations()
             if conv["id"] != own_id and conv.get("agent") and (conv.get("project") or "") == project]
    saved = {conv["id"] for conv in convs}
    pending = [{"id": conv_id, **meta} for conv_id, meta in state.launched_agents.items()
               if conv_id not in saved and meta["project"] == project]
    if not pending:
        return convs
    return sorted(convs + pending, key=lambda conv: conv.get("updatedAt") or 0, reverse=True)


def _agent_state(conv: dict, run: dict) -> dict:
    """Estado de la última ejecución de una conversación de agente, sin su respuesta final (la añaden el listado y el
    detalle). Una en marcha cuyo proceso ya no existe terminó sin poder guardar su final: se da como error."""
    died = run.get("status") == "running" and not run_process_alive(run)
    return {
        "agent": conv["agent"],
        "conversation_id": conv["id"],
        "status": "error" if died else run.get("status"),
        "updated_at": run.get("updated_at") or conv.get("updatedAt"),
        "finished_at": run.get("finished_at"),
        "step_text": run.get("step_text") or "",
        "pending": run.get("pending"),
        "error": "The agent's run process ended unexpectedly." if died else run.get("error"),
        "warnings": run.get("warnings") or [],
        "usage": run.get("usage"),
    }


# Finales en los que el agente no entregó respuesta: lo que avanzó sigue en su conversación guardada.
AGENT_CUT_STATUSES = ("limit", "error")


def _final_answer(conv: dict, state: dict, run: dict) -> tuple[str, bool]:
    """La respuesta final y si es parcial: la que entregó o, si se cortó (límite, error o proceso muerto) sin
    entregarla, el último texto del asistente en su conversación, que dice al menos dónde se quedó."""
    result = run.get("result_text") or ""
    if result or state["status"] not in AGENT_CUT_STATUSES:
        return result, False
    history = (get_conversation(conv["id"]) or {}).get("history") or []
    partial = next((message["content"].strip() for message in reversed(history) if message.get("role") == "assistant"
                    and isinstance(message.get("content"), str) and message["content"].strip()), "")
    return partial, bool(partial)


def _runs() -> dict:
    """Ejecuciones en marcha en la máquina frente al tope, para que el controlador lance en tandas sin chocar con él."""
    return {"running": running_run_count(), "max": MAX_CONCURRENT_RUNS}


def _delivered_key(conv: dict, run: dict) -> tuple[str, str]:
    """La clave de una respuesta entregada, que cambia con cada ejecución de la conversación."""
    return conv["id"], run.get("run_id") or ""


def _listing(selected: list[tuple[dict, dict]], state: ControllerState) -> dict:
    """El listado con la respuesta final entera de cada agente mientras quepa (por agente y entre todos); la que no,
    sin texto y con result_chars, y la ya entregada en esta ejecución, sin texto y con result_seen."""
    budget, agents, omitted, seen = AGENT_LIST_TOTAL_CHARS, [], False, False
    delivered = state.delivered_results
    for conv, run in selected:
        entry = _agent_state(conv, run)
        key = _delivered_key(conv, run)
        if key in delivered:
            result_chars, partial = delivered[key]
            if partial:
                entry["partial"] = True
            entry.update(result_seen=True, result_chars=result_chars)
            seen = True
            agents.append(entry)
            continue
        result, partial = _final_answer(conv, entry, run)
        if partial:
            entry["partial"] = True
        if len(result) <= min(AGENT_LIST_RESULT_MAX_CHARS, budget):
            entry["result_text"] = result
            budget -= len(result)
            if result:
                delivered[key] = (len(result), partial)
        else:
            entry["result_chars"] = len(result)
            omitted = True
        agents.append(entry)
    notes = [note for flag, note in (
        (omitted, "Final answers that did not fit are omitted (see result_chars): read them with check_agents(conversation_id=...)."),
        (seen, "Final answers with result_seen were already delivered in this run: read one again with check_agents(conversation_id=...).")) if flag]
    return {"agents": agents, **({"note": " ".join(notes)} if notes else {})}


def _result_page(result: str, offset: int) -> dict:
    """Un bloque de AGENT_RESULT_PAGE_CHARS de la respuesta final desde offset; next_offset es None en el último."""
    end = offset + AGENT_RESULT_PAGE_CHARS
    return {"result_text": result[offset:end], "result_chars": len(result), "offset": offset,
            "next_offset": end if end < len(result) else None}


def _last_turn(history: list[dict]) -> tuple[list[dict], bool]:
    """Mensajes desde el último del usuario, con AGENT_TURN_MAX_CHARS de texto entre todos; True si se recortó.
    La evidencia visual de las herramientas (user con _toolEvidence, M67-D1) es parte del turno, no su inicio."""
    start = max((index for index, message in enumerate(history)
                 if message.get("role") == "user" and not message.get("_toolEvidence")), default=0)
    budget, truncated, messages = AGENT_TURN_MAX_CHARS, False, []
    for message in history[start:]:
        content, clipped = _clip("" if message.get("content") is None else str(message["content"]), budget)
        budget -= len(content)
        truncated = truncated or clipped
        entry = {"role": message.get("role"), "content": content}
        if message.get("name"):
            entry["name"] = message["name"]
        calls = [call.get("function", {}).get("name") for call in message.get("tool_calls") or [] if isinstance(call, dict)]
        if calls:
            entry["tool_calls"] = calls
        messages.append(entry)
    return messages, truncated


def _selected(ctx: SecurityContext, own_id: str, state: ControllerState, agent: str | None,
              conversation_id: str | None) -> list[tuple[dict, dict]] | None:
    """Las conversaciones consultadas con su ejecución: sin agent ni conversation_id, todas las que lanzó este
    controlador en esta ejecución (varias del mismo agente si repartió el trabajo) y la más reciente de cada agente;
    si no, la de agent o la de conversation_id. None si agent o conversation_id no es de un agente del proyecto."""
    convs = _agent_conversations(ctx, own_id, state)
    if conversation_id is not None:
        picked = [conv for conv in convs if conv["id"] == conversation_id][:1]
    elif agent is not None:
        picked = [conv for conv in convs if conv["agent"] == agent][:1]
    else:
        launched = state.launched_agents
        seen: set[str] = set()
        picked = []
        for conv in convs:  # De la más reciente a la más antigua.
            if conv["agent"] not in seen or conv["id"] in launched:
                picked.append(conv)
            seen.add(conv["agent"])
        return [(conv, get_run_state(conv["id"]) or {}) for conv in picked]
    return [(conv, get_run_state(conv["id"]) or {}) for conv in picked] or None


def _wait_reason(selected: list[tuple[dict, dict]] | None, attention: dict[str, str]) -> str | None:
    """Por qué deja de esperar con lo leído, o None para seguir: ninguna consultada en marcha (not_running), o una
    que pasa a needs_input o error durante la espera (needs_attention); attention es el estado de cada una al empezar."""
    if selected is None:
        return "not_running"
    statuses = {conv["id"]: _agent_state(conv, run)["status"] for conv, run in selected}
    if any(status in AGENT_ATTENTION_STATUSES and attention.get(conv_id) != status for conv_id, status in statuses.items()):
        return "needs_attention"
    if all(status != "running" for status in statuses.values()):
        return "not_running"
    return None


def _wait_for_change(read, wait: float) -> tuple[list[tuple[dict, dict]] | None, str]:
    """Relee con read() mientras alguna conversación consultada siga en marcha, como mucho wait: vuelve en cuanto
    ninguna lo está (también al empezar, sin esperar) o cuando una pasa a necesitar a alguien. Devuelve lo último
    leído y el motivo (not_running, needs_attention o wait_elapsed)."""
    deadline = time.monotonic() + wait
    seq = live_change_seq()
    selected = read()
    attention = {conv["id"]: _agent_state(conv, run)["status"] for conv, run in selected or ()}
    while True:
        reason = _wait_reason(selected, attention)
        if reason:
            return selected, reason
        for _conv, run in selected or ():
            if run.get("status") == "running" and run.get("pid"):
                watch_run_exit(run["pid"], run.get("pid_start"))
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return selected, "wait_elapsed"
        seq = wait_live_change(seq, min(remaining, AGENT_WAIT_RECHECK_SECONDS))
        selected = read()


def _prune(convs: list[dict], agent: str | None, keep: int) -> str:
    """Borra las conversaciones de cada agente (o solo de agent) salvo las keep más recientes, con su fila
    de runs; las que están en marcha o esperan a una persona se conservan y se indican."""
    deleted, skipped, seen = [], [], {}
    for conv in convs:  # De la más reciente a la más antigua.
        if agent is not None and conv["agent"] != agent:
            continue
        seen[conv["agent"]] = seen.get(conv["agent"], 0) + 1
        if seen[conv["agent"]] <= keep:
            continue
        status = _agent_state(conv, get_run_state(conv["id"]) or {})["status"]
        if status in AGENT_PRUNE_PROTECTED:
            skipped.append({"agent": conv["agent"], "conversation_id": conv["id"], "status": status})
            continue
        if delete_conversation(conv["id"]):
            delete_run_state(conv["id"])
            deleted.append({"agent": conv["agent"], "conversation_id": conv["id"]})
    return json.dumps({"success": True, "deleted": deleted, "skipped": skipped}, ensure_ascii=False)


def _controller_context(tool_name: str, ctx: SecurityContext | None, project: str | None,
                        access: str) -> tuple[ControllerState, str, SecurityContext]:
    """El estado y el id de la conversación del controlador, y el proyecto destino: en una ejecución, los suyos, que
    tiene que ser controladora; en el servidor de la interfaz, su estado único y sin conversación propia."""
    if ctx is None:
        raise ValueError(f"{tool_name} needs the project of the call.")
    session = current_run_session()
    if session is not None:
        if not session.controller:
            raise ValueError(f"{tool_name} is only available to a controller: a --run-file run with controller: true "
                             "or a chat with Subagents on.")
        return session, session.conversation_id or session.new_conversation_id or "", _target_project(ctx, project, access)
    return INTERFACE_CONTROLLER, "", _target_project(ctx, project, access)


def check_agents(agent: str | None = None, conversation_id: str | None = None, wait_seconds: int = 0,
                 project: str | None = None, offset: int = 0, include_turn: bool = False,
                 ctx: SecurityContext | None = None) -> str:
    """Sin argumentos, el estado de cada agente del proyecto (y de todos los que lanzó este controlador en esta
    ejecución) con su respuesta final si cabe; con agent o conversation_id, su respuesta final por bloques desde offset
    y, con include_turn, los mensajes de su último turno. Con wait_seconds, antes espera como mucho ese tiempo a que
    cambie. Con project, los agentes de esa carpeta en lugar de los del proyecto de la ejecución."""
    try:
        state, own_id, target = _controller_context(AGENTS_TOOL, ctx, project, "R")
    except ValueError as exc:
        return _tool_error(str(exc))
    detail = agent is not None or conversation_id is not None
    if (offset or include_turn) and not detail:
        return _tool_error("offset and include_turn go with agent or conversation_id.")
    if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0:
        return _tool_error("offset must be a non-negative integer.")

    def read():
        return _selected(target, own_id, state, agent, conversation_id)

    wait = max(0, min(int(wait_seconds or 0), AGENT_MAX_WAIT))
    extra = {}
    if wait:
        started = time.monotonic()
        selected, reason = _wait_for_change(read, wait)
        extra = {"returned_because": reason, "waited_s": round(time.monotonic() - started, 1)}
    else:
        selected = read()
    if selected is None:
        return _tool_error("That agent or conversation is not an agent of this project.")
    if not detail:
        return json.dumps({"success": True, **_listing(selected, state), "runs": _runs(), **extra}, ensure_ascii=False)
    return _detail(*selected[0], state, offset, include_turn, extra)


def stop_agent(conversation_id: str | None = None, project: str | None = None,
               ctx: SecurityContext | None = None) -> str:
    """Detiene una conversación que este controlador lanzó en esta ejecución: mata su proceso con su árbol (runner y
    servicios MCP) y deja su fila en error, para que check_agents la muestre con lo que avanzó (respuesta parcial)."""
    try:
        state, own_id, target = _controller_context(STOP_AGENT_TOOL, ctx, project, "R")
    except ValueError as exc:
        return _tool_error(str(exc))
    if not isinstance(conversation_id, str) or not conversation_id.strip():
        return _tool_error("conversation_id must be a non-empty string.")
    conv_id = conversation_id.strip()
    if conv_id not in state.launched_agents:
        return _tool_error("A controller only stops the agents it launched in this run.")
    selected = _selected(target, own_id, state, None, conv_id)
    if selected is None:
        return _tool_error("That conversation is not an agent of this project.")
    conv, run = selected[0]
    if run.get("status") != "running" or not run_process_alive(run):
        return _tool_error(f"The conversation {conv_id} is not running (status: {_agent_state(conv, run)['status']}).")
    _kill_process_tree(run["pid"], grace_seconds=AGENT_STOP_GRACE_SECONDS)
    # Releer tras el plazo de gracia para conservar usage/warnings recientes o un resultado terminado a tiempo.
    fresh = get_run_state(conv_id) or run
    if fresh.get("status") != "running":
        return _detail(conv, fresh, state, 0, False, {"stopped": False})
    now = int(time.time() * 1000)
    upsert_run_state({**fresh, "status": "error", "error": AGENT_STOPPED_ERROR, "updated_at": now, "finished_at": now})
    return _detail(conv, get_run_state(conv_id) or {}, state, 0, False, {"stopped": True})


def prune_agents(keep: int | None = None, agent: str | None = None, project: str | None = None,
                 ctx: SecurityContext | None = None) -> str:
    """Borra las conversaciones antiguas de los agentes del proyecto (o solo de agent) conservando las keep más
    recientes, nunca una en marcha o esperando respuesta, y devuelve las borradas y las conservadas."""
    try:
        state, own_id, target = _controller_context(PRUNE_AGENTS_TOOL, ctx, project, "RW")
    except ValueError as exc:
        return _tool_error(str(exc))
    if isinstance(keep, bool) or not isinstance(keep, int) or not 0 <= keep <= AGENT_PRUNE_KEEP_MAX:
        return _tool_error(f"keep must be an integer between 0 and {AGENT_PRUNE_KEEP_MAX}.")
    convs = _agent_conversations(target, own_id, state)
    if agent is not None and not any(conv["agent"] == agent for conv in convs):
        return _tool_error("That agent is not an agent of this project.")
    return _prune(convs, agent, keep)


def _detail(conv: dict, run: dict, controller: ControllerState, offset: int, include_turn: bool, extra: dict) -> str:
    """El detalle de una conversación: su estado, un bloque de su respuesta final y, con include_turn, su último turno."""
    state = _agent_state(conv, run)
    result, partial = _final_answer(conv, state, run)
    if partial:
        state["partial"] = True
    if offset > len(result):
        return _tool_error(f"offset {offset} is past the end of the final answer ({len(result)} characters).")
    turn = {}
    if include_turn:
        messages, truncated = _last_turn((get_conversation(conv["id"]) or {}).get("history") or [])
        turn = {"last_turn": messages, **({"last_turn_truncated": True} if truncated else {})}
    page = _result_page(result, offset)
    if result and page["next_offset"] is None:
        controller.delivered_results[_delivered_key(conv, run)] = (len(result), partial)
    return json.dumps({"success": True, **state, **page, **turn, **extra},
                      ensure_ascii=False)

# Lo que launch_agent acepta en línea, en lugar de run_file, y el campo del run-file que ocupa cada argumento.
INLINE_LAUNCH_FIELDS = {"agent": "agent", "system_prompt": "systemDataPrompt", "profile": "profile", "reasoning": "reasoning",
                        "max_steps": "maxSteps", "timeout": "timeout", "conversation_id": "conversation_id",
                        "disabled_tools": "disabledTools"}
_RUN_TO_INLINE_FIELDS = {run_key: inline_key for inline_key, run_key in INLINE_LAUNCH_FIELDS.items()}

_RUN_ERROR_PHRASES = (
    ("agent debe ser", f"agent must be <name> or <set>.<name> using lowercase letters, digits, _ or -, up to {MAX_AGENT_ID_LENGTH} characters."),
    ("identificador de la conversación no puede estar vacío", "conversation_id must be a non-empty string."),
    ("identificador no puede superar", f"conversation_id must not exceed {MAX_CONVERSATION_ID_LENGTH} characters."),
    ("reasoning debe ser", f"reasoning must be one of: {', '.join(RUN_REASONING_LEVELS)}."),
    ("no puede superar " + str(RUN_FILE_MAX_BYTES), f"The run-file must not exceed {RUN_FILE_MAX_BYTES} bytes."),
    ("no es texto UTF-8", "The run-file is not valid UTF-8 text."),
    ("debe empezar con su cabecera", "The run-file must start with a header between two '---' lines."),
    ("campo desconocido en la cabecera", "Unknown field in the run-file header."),
    ("aparece dos veces en la cabecera", "Duplicate field in the run-file header."),
    ("aparece dos veces", "Duplicate section in the run-file."),
    ("hay texto antes de las secciones", "Text before sections must go inside <!-- system --> or <!-- prompt -->."),
)


def _format_run_error(exc: ValueError, *, inline: bool) -> str:
    """Normaliza al inglés (y a los nombres de argumento en línea) los errores de format/parse_run_request."""
    msg = str(exc)
    for needle, english in _RUN_ERROR_PHRASES:
        if needle in msg:
            return english
    run_field = msg.split(" ", 1)[0]
    field = _RUN_TO_INLINE_FIELDS.get(run_field, run_field) if inline else run_field
    if "no puede superar" in msg:
        return f"{field} must not exceed {MAX_PROJECT_PROMPT_LENGTH} characters."
    if "debe ser true o false" in msg:
        return f"{field} must be true or false."
    if "debe ser un entero entre 1 y" in msg:
        maximum = RUN_FILE_LIMIT_KEYS.get(run_field, "")
        return f"{field} must be an integer between 1 and {maximum}."
    if "debe ser un texto no vacío" in msg:
        return f"{field} must be a non-empty string."
    if "debe ser una lista de nombres" in msg:
        return f"{field} must be a comma-separated list of names, up to {MAX_PROJECT_TOOL_ID_LENGTH} characters without spaces."
    if "no puede tener más de" in msg:
        return f"{field} has too many tool names."
    if "no puede tener saltos de línea" in msg:
        return f"{field} must not contain line breaks."
    if "marcador de una sección" in msg:
        return f"{field} must not contain a line with a section marker."
    if "bloque de código sin cerrar" in msg:
        return f"{field} must not leave an unclosed code block."
    return msg


def _inline_request(fields: dict, prompt: str | None) -> dict:
    """La petición de un agente dado en línea: se escribe y se lee como su run-file, así que vale lo mismo que en él
    (nunca controller ni permisos, herramientas o servicios MCP, que no tienen argumento)."""
    if not fields.get("agent") or (prompt is None and not fields.get("conversation_id")):
        raise ValueError("Without run_file, give the agent inline: agent and prompt (or conversation_id to continue one).")
    if not all(isinstance(value, str) for key, value in fields.items() if key not in ("max_steps", "timeout")):
        raise ValueError("agent, system_prompt, profile, reasoning, conversation_id and disabled_tools must be texts.")
    if prompt is not None and (not isinstance(prompt, str) or not prompt.strip()):
        raise ValueError("prompt must be a non-empty text.")
    run_fields = {INLINE_LAUNCH_FIELDS[key]: value for key, value in fields.items()}
    if prompt is not None:
        run_fields["prompt"] = prompt
    try:
        return parse_run_request(format_run_request(run_fields).encode("utf-8"))
    except ValueError as exc:
        raise ValueError(_format_run_error(exc, inline=True)) from None


def launch_agent(run_file: str | None = None, prompt: str | None = None, project: str | None = None,
                 agent: str | None = None, system_prompt: str | None = None, profile: str | None = None,
                 reasoning: str | None = None, max_steps: int | None = None, timeout: int | None = None,
                 conversation_id: str | None = None, disabled_tools: str | None = None, ctx: SecurityContext | None = None) -> str:
    """Lanza un agente separado de este controlador y devuelve su conversation_id y run_id: el de su run-file
    `run_file` (ruta dentro del proyecto) o, sin él, el que se da en línea (agent, system_prompt y prompt, con profile,
    reasoning, max_steps, timeout, conversation_id y disabled_tools opcionales). Con prompt sustituye el del fichero; con project, el
    agente se lanza en esa carpeta, con su entorno guardado y sus permisos."""
    fields = {key: value for key, value in (("agent", agent), ("system_prompt", system_prompt), ("profile", profile),
              ("reasoning", reasoning), ("max_steps", max_steps), ("timeout", timeout), ("conversation_id", conversation_id),
              ("disabled_tools", disabled_tools))
              if value is not None}
    # Lanzar en otra carpeta es ejecutar en ella: el agente corre con su entorno y sus permisos, y prompt sustituye
    # las instrucciones del run-file.
    try:
        state, own_id, target = _controller_context(LAUNCH_AGENT_TOOL, ctx, project, "X")
    except ValueError as exc:
        return _tool_error(str(exc))
    if run_file is None:
        try:
            return _launch(_inline_request(fields, prompt), prompt, target, own_id, state)
        except ValueError as exc:
            return _tool_error(str(exc))
    if fields:
        return _tool_error(f"Give either run_file or the agent inline, not both: {', '.join(fields)} go without run_file.")
    if not isinstance(run_file, str) or not run_file.strip():
        return _tool_error("run_file must be the path of the agent's run-file in the project, such as agents/report.md.")
    try:
        path = target.absolute(run_file.strip())
        if not path.is_relative_to(target.workspace_dir.resolve()):
            raise ValueError(f"run_file must be inside the project folder {target.workspace_dir}.")
        if not ACCESS_CONTROLLER.allows_path("R", str(path), ctx):
            raise ValueError(f"This project's directory rules do not give R access to {path}.")
        with open(path, "rb") as handle:
            try:
                request = parse_run_request(handle.read(RUN_FILE_MAX_BYTES + 1))
            except ValueError as exc:
                raise ValueError(_format_run_error(exc, inline=False)) from None
        return _launch(request, prompt, target, own_id, state)
    except OSError as exc:
        return _tool_error(f"Could not read the run-file: {exc}")
    except ValueError as exc:
        return _tool_error(str(exc))


def _target_conversation(conv_id: str | None, agent: str, target: SecurityContext, own_id: str) -> dict | None:
    """Conversación existente de conv_id (None si es nueva), validando que no sea del controlador ni de otro agente/proyecto."""
    if not conv_id:
        return None
    if conv_id == own_id:
        raise ValueError("A controller cannot launch its own conversation.")
    conv = get_conversation(conv_id)
    if conv is None:
        return None
    if (conv.get("project") or "") != _conversation_project(target) or conv.get("agent") != agent:
        raise ValueError(f"The conversation {conv_id} belongs to another project or agent.")
    if (get_conversation_launch(conv_id) or {}).get("controller"):
        raise ValueError(f"The conversation {conv_id} is of a controller: a controller only launches agents, not controllers.")
    return conv


def _launch(request: dict, prompt: str | None, target: SecurityContext, own_id: str, state: ControllerState) -> str:
    agent = request.get("agent")
    if not agent:
        raise ValueError("The run-file must set an agent.")
    if request.get("controller"):
        raise ValueError("The run-file is of another controller (controller: true): a controller only launches agents, not controllers.")
    if prompt is not None:
        if not isinstance(prompt, str) or not prompt.strip():
            raise ValueError("prompt must be a non-empty text.")
        request["prompt"] = prompt.strip()
    if "prompt" not in request and "conversation_id" not in request:
        raise ValueError("The run-file needs a prompt (or give one in prompt).")
    if not get_project_environment(target.key)["saved"]:
        raise ValueError(f"The project {target.workspace_dir} has no saved environment: save its tools and permissions in the UI first.")
    conv_id = request.get("conversation_id")
    conv = _target_conversation(conv_id, agent, target, own_id)
    if "prompt" not in request and conv is None:
        raise ValueError("The conversation does not exist yet: give prompt to start it.")
    request["conversation_id"] = conv_id or f"session_{uuid.uuid4()}"
    try:
        check_no_active_run(request["conversation_id"])
    except ValueError:
        raise ValueError(f"The conversation {request['conversation_id']} is already running: nothing was launched.") from None
    launched = launch_run_file(request, Path(target.workspace_dir))
    state.launched_agents[request["conversation_id"]] = {
        "agent": agent, "project": _conversation_project(target), "updatedAt": int(time.time() * 1000)}
    return json.dumps({"success": True, "agent": agent, "conversation_id": request["conversation_id"], "new": conv is None,
                       "run_id": launched["run_id"], "project": target.key, "runs": _runs(),
                       "note": "It runs on its own: follow it with check_agents (with the same project), which can wait for it."},
                      ensure_ascii=False)
