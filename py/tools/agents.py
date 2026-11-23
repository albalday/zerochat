"""check_agents: estado de los agentes que vigila un agente master, solo en la ejecución --run-file con watchAgents.

Lee conversaciones y ejecuciones de SQLite filtrando estrictamente por el proyecto de la ejecución y por los patrones de
watchAgents: nunca chats humanos (sin agent) ni conversaciones de otros proyectos.
"""

from __future__ import annotations

import json

from core.environment import get_no_project_dir
from run_mode.state import current_run_session
from security.context import SecurityContext, normalize_directory_path
from storage.db import agent_matches, get_conversation, get_run_state, list_conversations
from tools.common import _tool_error

AGENTS_TOOL = "check_agents"
# Resumen de la respuesta final de cada agente en el listado.
AGENT_RESULT_SUMMARY_CHARS = 500
# Texto de los mensajes del último turno que devuelve el detalle, entre todos.
AGENT_TURN_MAX_CHARS = 20000


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


def _agent_state(conv: dict) -> dict:
    """Estado de la última ejecución de una conversación de agente, con la respuesta final resumida."""
    run = get_run_state(conv["id"]) or {}
    result, clipped = _clip(run.get("result_text") or "", AGENT_RESULT_SUMMARY_CHARS)
    return {
        "agent": conv["agent"],
        "conversation_id": conv["id"],
        "status": run.get("status"),
        "updated_at": run.get("updated_at") or conv.get("updatedAt"),
        "finished_at": run.get("finished_at"),
        "step_text": run.get("step_text") or "",
        "pending": run.get("pending"),
        "error": run.get("error"),
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


def check_agents(agent: str | None = None, conversation_id: str | None = None, ctx: SecurityContext | None = None) -> str:
    """Sin argumentos, el estado de cada agente vigilado (su conversación más reciente); con agent o conversation_id,
    además los mensajes de su último turno."""
    session = current_run_session()
    patterns = session.watch_agents if session is not None else ()
    if not patterns or ctx is None:
        return _tool_error("check_agents is only available in a --run-file run with watchAgents.")
    convs = _watched_conversations(ctx, patterns, session.conversation_id or session.new_conversation_id or "")
    if conversation_id is None and agent is None:
        latest: dict[str, dict] = {}
        for conv in convs:
            latest.setdefault(conv["agent"], conv)
        return json.dumps({"success": True, "agents": [_agent_state(conv) for conv in latest.values()]}, ensure_ascii=False)
    if conversation_id is not None:
        conv = next((item for item in convs if item["id"] == conversation_id), None)
    else:
        conv = next((item for item in convs if item["agent"] == agent), None)
    if conv is None:
        return _tool_error("That agent or conversation is not a watched agent of this project.")
    full = get_conversation(conv["id"]) or {}
    messages, truncated = _last_turn(full.get("history") or [])
    return json.dumps({"success": True, **_agent_state(conv), "last_turn": messages,
                       **({"last_turn_truncated": True} if truncated else {})}, ensure_ascii=False)
