"""check_agents: estado de los agentes que vigila un agente master, solo en la ejecución --run-file con watchAgents.

Lee conversaciones y ejecuciones de SQLite filtrando estrictamente por el proyecto de la ejecución y por los patrones de
watchAgents: nunca chats humanos (sin agent) ni conversaciones de otros proyectos. Con wait_seconds espera, sin que el
modelo tenga que sondear, a que cambie el estado de alguno de los agentes consultados.
"""

from __future__ import annotations

import json
import time

from core.environment import get_no_project_dir
from core.live_events import live_change_seq, wait_live_change
from run_mode.state import RUNNER_TOOL_WAIT_MAX, current_run_session, run_process_alive, watch_run_exit
from security.context import SecurityContext, normalize_directory_path
from storage.db import agent_matches, get_conversation, get_run_state, list_conversations
from tools.common import _tool_error

AGENTS_TOOL = "check_agents"
# Resumen de la respuesta final de cada agente en el listado.
AGENT_RESULT_SUMMARY_CHARS = 500
# Texto de los mensajes del último turno que devuelve el detalle, entre todos.
AGENT_TURN_MAX_CHARS = 20000
# Tope de wait_seconds: solo existe en modo ejecución, donde el runner de Node no espera más una respuesta.
AGENT_MAX_WAIT = RUNNER_TOOL_WAIT_MAX
# Los agentes corren en otros procesos: su final llega sin sondeo (se espera su PID, watch_run_exit), pero una
# ejecución nueva (lanzada por cron o por un script) solo se ve en SQLite, así que la espera la relee cada tanto.
AGENT_WAIT_RECHECK_SECONDS = 5.0


def _clip(text: str, limit: int) -> tuple[str, bool]:
    return (text, False) if len(text) <= limit else (text[:limit], True)


def _conversation_project(ctx: SecurityContext) -> str:
    """El proyecto de las conversaciones de esta ejecución: su carpeta, o vacío en la carpeta general."""
    return "" if ctx.key == normalize_directory_path(str(get_no_project_dir())) else ctx.key


def _watched_conversations(ctx: SecurityContext, patterns: tuple[str, ...], own_id: str) -> list[dict]:
    """Conversaciones de agentes vigilados del proyecto, de la más reciente a la más antigua, sin la del propio master."""
    project = _conversation_project(ctx)
    return [conv for conv in list_conversations()
            if conv["id"] != own_id and (conv.get("project") or "") == project and agent_matches(conv.get("agent"), patterns)]


def _agent_state(conv: dict, run: dict) -> dict:
    """Estado de la última ejecución de una conversación de agente, con la respuesta final resumida. Una en marcha
    cuyo proceso ya no existe terminó sin poder guardar su final: se da como error."""
    result, clipped = _clip(run.get("result_text") or "", AGENT_RESULT_SUMMARY_CHARS)
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
        "result_text": result,
        **({"result_truncated": True} if clipped else {}),
    }


def _last_turn(history: list[dict]) -> tuple[list[dict], bool]:
    """Mensajes desde el último del usuario, con AGENT_TURN_MAX_CHARS de texto entre todos; True si se recortó."""
    start = max((index for index, message in enumerate(history) if message.get("role") == "user"), default=0)
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


def _wait_for_change(read, wait: float) -> tuple[list[tuple[dict, dict]] | None, str]:
    """Relee con read() hasta que cambie alguna conversación consultada o su estado (una nueva, otra que termina o
    se pausa), o pase wait. Devuelve lo último leído y el motivo."""
    def signature(selected):
        return None if selected is None else [(conv["id"], _agent_state(conv, run)["status"]) for conv, run in selected]

    deadline = time.monotonic() + wait
    seq = live_change_seq()
    selected = read()
    initial = signature(selected)
    while True:
        for _conv, run in selected or ():
            if run.get("status") == "running" and run.get("pid"):
                watch_run_exit(run["pid"], run.get("pid_start"))
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return selected, "wait_elapsed"
        seq = wait_live_change(seq, min(remaining, AGENT_WAIT_RECHECK_SECONDS))
        selected = read()
        if signature(selected) != initial:
            return selected, "agent_changed"


def check_agents(agent: str | None = None, conversation_id: str | None = None, wait_seconds: int = 0,
                 ctx: SecurityContext | None = None) -> str:
    """Sin argumentos, el estado de cada agente vigilado (su conversación más reciente); con agent o conversation_id,
    además los mensajes de su último turno. Con wait_seconds, antes espera como mucho ese tiempo a que cambie."""
    session = current_run_session()
    patterns = session.watch_agents if session is not None else ()
    if not patterns or ctx is None:
        return _tool_error("check_agents is only available in a --run-file run with watchAgents.")
    own_id = session.conversation_id or session.new_conversation_id or ""

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
    if conversation_id is None and agent is None:
        return json.dumps({"success": True, "agents": [_agent_state(conv, run) for conv, run in selected], **extra}, ensure_ascii=False)
    conv, run = selected[0]
    full = get_conversation(conv["id"]) or {}
    messages, truncated = _last_turn(full.get("history") or [])
    return json.dumps({"success": True, **_agent_state(conv, run), "last_turn": messages,
                       **({"last_turn_truncated": True} if truncated else {}), **extra}, ensure_ascii=False)
