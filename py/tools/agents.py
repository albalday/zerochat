"""check_agents y launch_agent: los agentes que vigila y lanza un agente master, solo en la ejecución --run-file con
watchAgents.

Leen conversaciones y ejecuciones de SQLite filtrando estrictamente por un proyecto (el de la ejecución o, con project,
otro sobre el que sus reglas de directorio den lectura) y por los patrones de watchAgents: nunca chats humanos (sin
agent). launch_agent lanza un run-file de ese proyecto separado del master, con el entorno guardado y los permisos del
proyecto en que se ejecuta. Con wait_seconds espera, sin que el
modelo tenga que sondear, a que cambie el estado de alguno de los agentes consultados. Con prune_keep borra, solo
cuando el master lo pide, las conversaciones antiguas de sus agentes vigilados (nunca hay limpieza automática).
"""

from __future__ import annotations

import json
import time
import uuid
from pathlib import Path

from core.environment import get_no_project_dir
from core.limits import TOOL_WAIT_MAX_SECONDS
from core.live_events import live_change_seq, wait_live_change
from run_mode.state import (
    RUN_FILE_MAX_BYTES,
    check_no_active_run,
    current_run_session,
    launch_run_file,
    parse_run_request,
    run_process_alive,
    watch_run_exit,
)
from security.context import SecurityContext, normalize_directory_path
from security.controller import ACCESS_CONTROLLER
from storage.db import (
    agent_matches,
    delete_conversation,
    delete_run_state,
    get_conversation,
    get_project_environment,
    get_run_state,
    list_conversations,
)
from tools.common import _tool_error

AGENTS_TOOL = "check_agents"
LAUNCH_AGENT_TOOL = "launch_agent"
# Las herramientas del master: se publican y autorizan juntas, solo en una ejecución --run-file con watchAgents.
MASTER_TOOLS = (AGENTS_TOOL, LAUNCH_AGENT_TOOL)
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
# Tope de prune_keep: cuántas conversaciones recientes de cada agente puede pedir conservar el master.
AGENT_PRUNE_KEEP_MAX = 1000
# Estados que la limpieza nunca borra: una ejecución en marcha o una pausa que espera a una persona.
AGENT_PRUNE_PROTECTED = ("running", "needs_input")


def _clip(text: str, limit: int) -> tuple[str, bool]:
    return (text, False) if len(text) <= limit else (text[:limit], True)


def _conversation_project(ctx: SecurityContext) -> str:
    """El proyecto de las conversaciones de esta ejecución: su carpeta, o vacío en la carpeta general."""
    return "" if ctx.key == normalize_directory_path(str(get_no_project_dir())) else ctx.key


def _target_project(ctx: SecurityContext, project: str | None, access: str) -> SecurityContext:
    """El proyecto sobre el que actúa el master: el suyo o, con project, otra carpeta sobre la que sus reglas de
    directorio den `access` (R para consultar y lanzar, RW para borrar). ValueError con el motivo si no vale."""
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


def _watched_conversations(ctx: SecurityContext, patterns: tuple[str, ...], own_id: str) -> list[dict]:
    """Conversaciones de agentes vigilados del proyecto, de la más reciente a la más antigua, sin la del propio master.
    Incluye las que este master lanzó y el agente aún no ha guardado: su fila de runs ya está en marcha."""
    project = _conversation_project(ctx)
    convs = [conv for conv in list_conversations()
             if conv["id"] != own_id and (conv.get("project") or "") == project and agent_matches(conv.get("agent"), patterns)]
    session = current_run_session()
    saved = {conv["id"] for conv in convs}
    pending = [{"id": conv_id, **meta} for conv_id, meta in (session.launched_agents if session else {}).items()
               if conv_id not in saved and meta["project"] == project and agent_matches(meta["agent"], patterns)]
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


def _listing(selected: list[tuple[dict, dict]]) -> dict:
    """El listado con la respuesta final entera de cada agente mientras quepa (por agente y entre todos); la que no,
    sin texto y con result_chars."""
    budget, agents, omitted = AGENT_LIST_TOTAL_CHARS, [], False
    for conv, run in selected:
        result = run.get("result_text") or ""
        entry = _agent_state(conv, run)
        if len(result) <= min(AGENT_LIST_RESULT_MAX_CHARS, budget):
            entry["result_text"] = result
            budget -= len(result)
        else:
            entry["result_chars"] = len(result)
            omitted = True
        agents.append(entry)
    note = ("Final answers that did not fit are omitted (see result_chars): read them with check_agents(conversation_id=...)."
            if omitted else None)
    return {"agents": agents, **({"note": note} if note else {})}


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


def _selected(ctx: SecurityContext, patterns: tuple[str, ...], own_id: str, agent: str | None,
              conversation_id: str | None) -> list[tuple[dict, dict]] | None:
    """Las conversaciones consultadas con su ejecución: la más reciente de cada agente vigilado, la de agent o la de
    conversation_id; None si agent o conversation_id no es de un agente vigilado."""
    convs = _watched_conversations(ctx, patterns, own_id)
    if conversation_id is not None:
        picked = [conv for conv in convs if conv["id"] == conversation_id][:1]
    elif agent is not None:
        picked = [conv for conv in convs if conv["agent"] == agent][:1]
    else:
        latest: dict[str, dict] = {}
        for conv in convs:
            latest.setdefault(conv["agent"], conv)
        return [(conv, get_run_state(conv["id"]) or {}) for conv in latest.values()]
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
    """Borra las conversaciones de cada agente vigilado (o solo de agent) salvo las keep más recientes, con su fila
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


def check_agents(agent: str | None = None, conversation_id: str | None = None, wait_seconds: int = 0,
                 prune_keep: int | None = None, project: str | None = None, offset: int = 0, include_turn: bool = False,
                 ctx: SecurityContext | None = None) -> str:
    """Sin argumentos, el estado de cada agente vigilado (su conversación más reciente) con su respuesta final si cabe;
    con agent o conversation_id, su respuesta final por bloques desde offset y, con include_turn, los mensajes de su
    último turno. Con wait_seconds, antes espera como mucho ese tiempo a que cambie.
    Con prune_keep, en lugar de eso borra las conversaciones antiguas de los agentes vigilados (o de agent). Con
    project, los agentes de esa carpeta en lugar de los del proyecto de la ejecución."""
    session = current_run_session()
    patterns = session.watch_agents if session is not None else ()
    if not patterns or ctx is None:
        return _tool_error("check_agents is only available in a --run-file run with watchAgents.")
    own_id = session.conversation_id or session.new_conversation_id or ""
    try:
        ctx = _target_project(ctx, project, "RW" if prune_keep is not None else "R")
    except ValueError as exc:
        return _tool_error(str(exc))
    detail = agent is not None or conversation_id is not None
    if (offset or include_turn) and (prune_keep is not None or not detail):
        return _tool_error("offset and include_turn go with agent or conversation_id.")
    if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0:
        return _tool_error("offset must be a non-negative integer.")
    if prune_keep is not None:
        if conversation_id is not None or wait_seconds:
            return _tool_error("prune_keep goes alone or with agent, without conversation_id or wait_seconds.")
        return _checked_prune(_watched_conversations(ctx, patterns, own_id), agent, prune_keep)

    def read():
        return _selected(ctx, patterns, own_id, agent, conversation_id)

    wait = max(0, min(int(wait_seconds or 0), AGENT_MAX_WAIT))
    extra = {}
    if wait:
        started = time.monotonic()
        selected, reason = _wait_for_change(read, wait)
        extra = {"returned_because": reason, "waited_s": round(time.monotonic() - started, 1)}
    else:
        selected = read()
    if selected is None:
        return _tool_error("That agent or conversation is not a watched agent of this project.")
    if not detail:
        return json.dumps({"success": True, **_listing(selected), **extra}, ensure_ascii=False)
    return _detail(*selected[0], offset, include_turn, extra)


def _checked_prune(convs: list[dict], agent: str | None, keep) -> str:
    if isinstance(keep, bool) or not isinstance(keep, int) or not 0 <= keep <= AGENT_PRUNE_KEEP_MAX:
        return _tool_error(f"prune_keep must be an integer between 0 and {AGENT_PRUNE_KEEP_MAX}.")
    if agent is not None and not any(conv["agent"] == agent for conv in convs):
        return _tool_error("That agent is not a watched agent of this project.")
    return _prune(convs, agent, keep)


def _detail(conv: dict, run: dict, offset: int, include_turn: bool, extra: dict) -> str:
    """El detalle de una conversación: su estado, un bloque de su respuesta final y, con include_turn, su último turno."""
    result = run.get("result_text") or ""
    if offset > len(result):
        return _tool_error(f"offset {offset} is past the end of the final answer ({len(result)} characters).")
    turn = {}
    if include_turn:
        messages, truncated = _last_turn((get_conversation(conv["id"]) or {}).get("history") or [])
        turn = {"last_turn": messages, **({"last_turn_truncated": True} if truncated else {})}
    return json.dumps({"success": True, **_agent_state(conv, run), **_result_page(result, offset), **turn, **extra},
                      ensure_ascii=False)

def launch_agent(run_file: str | None = None, prompt: str | None = None, project: str | None = None,
                 ctx: SecurityContext | None = None) -> str:
    """Lanza el run-file `run_file` (ruta dentro del proyecto) de un agente vigilado, separado de este master, y
    devuelve su conversation_id y run_id. Con prompt sustituye el del fichero; con project, el run-file y la ejecución
    son de esa carpeta, con su entorno guardado y sus permisos."""
    session = current_run_session()
    patterns = session.watch_agents if session is not None else ()
    if not patterns or ctx is None:
        return _tool_error("launch_agent is only available in a --run-file run with watchAgents.")
    if not isinstance(run_file, str) or not run_file.strip():
        return _tool_error("run_file is required: the path of the agent's run-file JSON in the project, such as agents/report.json.")
    try:
        target = _target_project(ctx, project, "R")
        path = target.absolute(run_file.strip())
        if not path.is_relative_to(target.workspace_dir.resolve()):
            raise ValueError(f"run_file must be inside the project folder {target.workspace_dir}.")
        if not ACCESS_CONTROLLER.allows_path("R", str(path), ctx):
            raise ValueError(f"This project's directory rules do not give R access to {path}.")
        with open(path, "rb") as handle:
            request = parse_run_request(handle.read(RUN_FILE_MAX_BYTES + 1))
        return _launch(request, prompt, target, patterns, own_id=session.conversation_id or session.new_conversation_id or "")
    except OSError as exc:
        return _tool_error(f"Could not read the run-file: {exc}")
    except ValueError as exc:
        return _tool_error(str(exc))


def _launch(request: dict, prompt: str | None, target: SecurityContext, patterns: tuple[str, ...], own_id: str) -> str:
    agent = request.get("agent")
    if not agent or not agent_matches(agent, patterns):
        raise ValueError("The run-file must set an agent that matches this run's watchAgents.")
    if prompt is not None:
        if not isinstance(prompt, str) or not prompt.strip():
            raise ValueError("prompt must be a non-empty text.")
        request["prompt"] = prompt.strip()
    if "prompt" not in request and "conversation_id" not in request:
        raise ValueError("The run-file needs a prompt (or give one in prompt).")
    if not get_project_environment(target.key)["saved"]:
        raise ValueError(f"The project {target.workspace_dir} has no saved environment: save its tools and permissions in the UI first.")
    conv_id = request.get("conversation_id")
    conv = get_conversation(conv_id) if conv_id else None
    if conv_id == own_id:
        raise ValueError("A master cannot launch its own conversation.")
    if conv is not None and ((conv.get("project") or "") != _conversation_project(target) or conv.get("agent") != agent):
        raise ValueError(f"The conversation {conv_id} belongs to another project or agent.")
    request["conversation_id"] = conv_id or f"session_{uuid.uuid4()}"
    try:
        check_no_active_run(request["conversation_id"])
    except ValueError:
        raise ValueError(f"The conversation {request['conversation_id']} is already running: nothing was launched.") from None
    launched = launch_run_file(request, Path(target.workspace_dir))
    session = current_run_session()
    if session is not None:
        session.launched_agents[request["conversation_id"]] = {
            "agent": agent, "project": _conversation_project(target), "updatedAt": int(time.time() * 1000)}
    return json.dumps({"success": True, "agent": agent, "conversation_id": request["conversation_id"], "new": conv is None,
                       "run_id": launched["run_id"], "project": target.key,
                       "note": "It runs on its own: follow it with check_agents (with the same project), which can wait for it."},
                      ensure_ascii=False)
