"""Estado de la ejecución desatendida: la sesión de --prompt o --conversation, su persistencia en SQLite, el arranque en segundo plano, sus códigos de salida y sus métodos zerochat/run/*."""

from __future__ import annotations

import hmac
import json
import os
import re
import secrets
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

from core.environment import DETECTED_OS, get_no_project_dir
from core.limits import MAX_HTTP_BODY_BYTES
from core.logging import console_error, log_event, timestamp_message
from core.live_events import notify_live_change
from core.process import _kill_process_tree, _pid_alive, _process_start_token, wait_pid_exit
from core.rpc import INTERNAL_ERROR, INVALID_PARAMS, METHOD_NOT_FOUND, RpcOutcome, dispatch_table, rpc_error, rpc_result
from security.context import SecurityContext
from storage.db import (
    MAX_PROJECT_ENABLED_TOOLS,
    MAX_PROJECT_TOOL_ID_LENGTH,
    _validate_conversation_id,
    get_conversation_launch,
    validate_agent_id,
    validate_project_prompt,
    delete_orphan_run_states,
    delete_run_state,
    get_conversation,
    get_conversation_updated_at,
    get_general_profile,
    get_general_profile_by_name,
    get_general_profile_with_key,
    get_run_state,
    list_general_profiles,
    list_run_states,
    mark_conversation_server_run,
    upsert_run_state,
)


RUN_PROGRESS_TEXT_MAX = 500
# Permisos denegados que guarda una ejecución en sus avisos (cada uno recortado como el progreso); del resto, solo cuántos.
RUN_WARNINGS_MAX = 20
RUN_PROGRESS_KIND_PATTERN = re.compile(r"[a-z_]{1,32}")
RUN_EXIT_DONE = 0
RUN_EXIT_ERROR = 1
RUN_EXIT_NO_RESULT = 2
RUN_EXIT_SETUP = 3
# Argumentos no válidos, en cualquier modo: argparse usaría 2, que con --prompt es plazo agotado.
RUN_EXIT_ARGS = 4
# Pausada a la espera del usuario (ask_user o una herramienta por aprobar): se reanuda con la conversación.
RUN_EXIT_NEEDS_INPUT = 5
RUN_NEEDS_INPUT_KINDS = ("ask_user", "tool_approval")
# Alcanzó maxSteps o timeout de --run-file: lo hecho queda grabado y se continúa con la conversación.
RUN_EXIT_LIMIT = 6
# Contadores de zerochat/run/usage (la suma de todas las llamadas al modelo de la ejecución) y su tope.
RUN_USAGE_COUNTERS = ("model_calls", "prompt_tokens", "completion_tokens", "cached_tokens", "reasoning_tokens")
RUN_USAGE_MAX = 10 ** 12
# La conversación ya tiene otra ejecución en marcha (p. ej. dos cron solapados con el mismo conversation_id): no se lanza.
RUN_EXIT_BUSY = 7
# Perfil por defecto de --prompt cuando no se indica --profile.
DEFAULT_RUN_PROFILE = "local"
# Formato de --export según la extensión del fichero; la interfaz genera el contenido con ChatExport.
RUN_EXPORT_FORMATS = {".md": "markdown", ".json": "json", ".html": "html"}
# Cuerpo HTTP admitido mientras se espera la exportación: el JSON y el HTML llevan las imágenes incrustadas.
RUN_EXPORT_MAX_BODY_BYTES = 64 * 1024 * 1024
# Petición de --run-file: lo que quien lanza la ejecución fija en ella. Nunca lleva permisos, herramientas ni servicios
# MCP, que salen siempre del entorno guardado del proyecto, así que no puede ampliarlos.
RUN_FILE_TEXT_KEYS = ("conversation_id", "prompt", "profile", "agent")
# Límites opcionales de la ejecución: llamadas al modelo y segundos desde el arranque del proceso, con su máximo.
RUN_FILE_LIMIT_KEYS = {"maxSteps": 1000, "timeout": 24 * 60 * 60}
# El run-file es Markdown: una cabecera fija entre dos líneas '---' con estas claves (`clave: valor`) y un cuerpo con las
# secciones <!-- system --> (systemDataPrompt, el manual del agente) y <!-- prompt --> (la tarea). El texto del cuerpo
# que no va tras ningún marcador es el system.
RUN_FILE_HEADER_KEYS = ("agent", "conversation_id", "profile", "controller", "projectMode", "reasoning", "disabledTools") + tuple(RUN_FILE_LIMIT_KEYS)
RUN_FILE_SECTIONS = {"system": "systemDataPrompt", "prompt": "prompt"}
_RUN_FILE_BOOLEAN_KEYS = ("controller", "projectMode")
_RUN_FILE_SECTION = re.compile(r"<!--[ \t]*(system|prompt)[ \t]*-->[ \t]*")
_MARKDOWN_FENCE = re.compile(r"[ ]{0,3}(`{3,}|~{3,})(.*)")
_MARKDOWN_FENCE_CLOSE = re.compile(r"[ ]{0,3}(`{3,}|~{3,})[ \t]*")
# Lo que una conversación de agente guarda de su lanzamiento (además del perfil) y repite al continuarla.
RUN_LAUNCH_KEYS = ("systemDataPrompt", "projectMode", "controller", "reasoning", "disabledTools") + tuple(RUN_FILE_LIMIT_KEYS)
# disabledTools: lo que se le quita a este agente del entorno guardado de su proyecto, separado por comas en la cabecera.
# Cada nombre es una herramienta, un servicio MCP (todas sus herramientas, sin arrancarlo) o el navegador (browser_action
# o playwright). Solo resta: lo que no está en el entorno no se añade.
MAX_DISABLED_TOOLS = MAX_PROJECT_ENABLED_TOOLS
_DISABLED_TOOL_NAME = re.compile(rf"[^\s,]{{1,{MAX_PROJECT_TOOL_ID_LENGTH}}}")
# Niveles de razonamiento de --run-file (los del selector de la interfaz) y el que usa si no indica ninguno.
RUN_REASONING_LEVELS = ("none", "low", "medium", "high", "xhigh")
DEFAULT_RUN_REASONING = "medium"
# El prompt acaba en la conversación, que se guarda por HTTP: no cabe uno mayor que el cuerpo admitido.
RUN_FILE_MAX_BYTES = MAX_HTTP_BODY_BYTES
# Marca que pasa start_server_run al hijo de una conversación interactiva cuando «Subagentes» está encendido.
ZEROCHAT_RUN_SUBAGENTS_ENV = "ZEROCHAT_RUN_SUBAGENTS"
# Error que escribe el runner al interrumpirse sin resultado (p. ej. SIGTERM); stop_agent lo reconoce para marcar parada.
RUN_INTERRUPTED_ERROR = "El runner se cerró o la ejecución se interrumpió sin resultado."


# Procesos de ejecución (PID y huella de arranque) cuyo final espera un hilo, y los que ya terminaron: uno que lanzó
# otra instancia puede seguir figurando como vivo (zombi) hasta que lo recoge quien lo lanzó.
_EXIT_WATCHED: set[tuple[int, str | None]] = set()
# Por orden de final y con tope: uno de hace más de MAX_EXITED_RUNS finales ya lo recogió quien lo lanzó, y un PID
# reutilizado no engaña a run_process_alive porque lleva otra huella de arranque.
_EXITED: dict[tuple[int, str | None], None] = {}
MAX_EXITED_RUNS = 1024
_EXIT_LOCK = threading.Lock()


def _remember_exit(key: tuple[int, str | None]) -> None:
    """Anota el final de un proceso de ejecución, olvidando el más antiguo por encima de MAX_EXITED_RUNS (con _EXIT_LOCK)."""
    _EXITED[key] = None
    while len(_EXITED) > MAX_EXITED_RUNS:
        del _EXITED[next(iter(_EXITED))]


def _header_value(key: str, raw: str):
    """El valor de una clave de la cabecera: true/false y los enteros de los límites se convierten; lo demás queda como
    texto, que parse_run_request rechaza con el mensaje de esa clave si no vale."""
    if key in _RUN_FILE_BOOLEAN_KEYS and raw in ("true", "false"):
        return raw == "true"
    if key in RUN_FILE_LIMIT_KEYS and raw.isascii() and raw.isdigit():
        return int(raw)
    return raw


def _next_fence(line: str, fence: tuple[str, int] | None) -> tuple[str, int] | None:
    """Actualiza el estado de un bloque cercado Markdown (``` o ~~~, según CommonMark)."""
    if fence is None:
        match = _MARKDOWN_FENCE.fullmatch(line)
        if not match:
            return None
        marker, info = match.groups()
        # Una cerca con acentos graves no admite más acentos en la línea de apertura (evita ```código``` en línea).
        return (marker[0], len(marker)) if marker[0] == "~" or "`" not in info else None
    match = _MARKDOWN_FENCE_CLOSE.fullmatch(line)
    if match and match.group(1)[0] == fence[0] and len(match.group(1)) >= fence[1]:
        return None
    return fence


def _split_run_sections(lines: list[str]) -> tuple[str, list[tuple[str, str]], bool]:
    """Parte las líneas del cuerpo por <!-- system --> / <!-- prompt --> fuera de bloques cercados, e indica si quedó
    una cerca sin cerrar."""
    lead, sections, current, buf, fence = "", [], None, [], None
    for line in lines:
        if fence is None:
            section = _RUN_FILE_SECTION.fullmatch(line)
            if section:
                if current is None:
                    lead = "\n".join(buf)
                else:
                    sections.append((current, "\n".join(buf)))
                current, buf = section.group(1), []
                continue
        fence = _next_fence(line, fence)
        buf.append(line)
    if current is None:
        lead = "\n".join(buf)
    else:
        sections.append((current, "\n".join(buf)))
    return lead, sections, fence is not None


def _run_request_object(raw: bytes) -> dict:
    """Los campos del run-file Markdown, sin pasar del tope ni llevar claves fuera de RUN_FILE_HEADER_KEYS."""
    if len(raw) > RUN_FILE_MAX_BYTES:
        raise ValueError(f"no puede superar {RUN_FILE_MAX_BYTES} bytes")
    try:
        lines = raw.decode("utf-8-sig").replace("\r\n", "\n").split("\n")
    except UnicodeDecodeError as exc:
        raise ValueError(f"no es texto UTF-8: {exc}") from exc
    end = next((i for i, line in enumerate(lines) if i > 0 and line.strip() == "---"), None)
    if lines[0].strip() != "---" or end is None:
        raise ValueError("debe empezar con su cabecera entre dos líneas '---'")
    data: dict = {}
    for line in lines[1:end]:
        if not line.strip():
            continue
        key, colon, value = (part.strip() for part in line.partition(":"))
        if not colon or key not in RUN_FILE_HEADER_KEYS:
            raise ValueError(f"campo desconocido en la cabecera: {line.strip()[:80]}")
        if key in data:
            raise ValueError(f"{key} aparece dos veces en la cabecera")
        data[key] = _header_value(key, value)
    lead, sections, _ = _split_run_sections(lines[end + 1:])
    for name, content in sections:
        if RUN_FILE_SECTIONS[name] in data:
            raise ValueError(f"la sección <!-- {name} --> aparece dos veces")
        data[RUN_FILE_SECTIONS[name]] = content
    if lead.strip():
        if "systemDataPrompt" in data:
            raise ValueError("hay texto antes de las secciones: ponlo dentro de <!-- system --> o de <!-- prompt -->")
        data["systemDataPrompt"] = lead
    return data


def format_run_request(request: dict) -> str:
    """El run-file Markdown de una petición ya validada: parse_run_request lo devuelve igual."""
    lines = ["---"]
    for key in RUN_FILE_HEADER_KEYS:
        if key in request:
            value = request[key]
            text = ("true" if value else "false") if isinstance(value, bool) else ", ".join(value) if isinstance(value, list) else str(value)
            if "\n" in text or "\r" in text:
                raise ValueError(f"{key} no puede tener saltos de línea")
            lines.append(f"{key}: {text}")
    lines.append("---")
    for name, key in RUN_FILE_SECTIONS.items():
        if key in request:
            _, sections, unclosed = _split_run_sections(request[key].replace("\r\n", "\n").split("\n"))
            if sections:
                raise ValueError(f"{key} no puede tener una línea con el marcador de una sección")
            if key == "systemDataPrompt" and "prompt" in request and unclosed:
                raise ValueError(f"{key} no puede dejar un bloque de código sin cerrar")
            lines += [f"<!-- {name} -->", request[key]]
    return "\n".join(lines) + "\n"


def _agent_options(data: dict) -> dict:
    """projectMode (sin él, --run-file no inyecta AGENTS.md ni .zerochat/state.md: el agente sigue su propio manual),
    reasoning (el nivel de razonamiento de la ejecución, DEFAULT_RUN_REASONING si no lo indica) y controller (la
    ejecución consulta y lanza los agentes del proyecto con check_agents y launch_agent)."""
    for key in _RUN_FILE_BOOLEAN_KEYS:
        if key in data and not isinstance(data[key], bool):
            raise ValueError(f"{key} debe ser true o false")
    options = {"projectMode": data.get("projectMode", False)}
    reasoning = data.get("reasoning", DEFAULT_RUN_REASONING)
    if reasoning not in RUN_REASONING_LEVELS:
        raise ValueError(f"reasoning debe ser uno de: {', '.join(RUN_REASONING_LEVELS)}")
    options["reasoning"] = reasoning
    if data.get("controller") is True:
        options["controller"] = True
    if "disabledTools" in data:
        options["disabledTools"] = _disabled_tools(data["disabledTools"])
    return options


def _disabled_tools(raw) -> list[str]:
    """Los nombres de disabledTools, sin repetir; ValueError si alguno está vacío o no es un nombre."""
    names = [name.strip() for name in raw.split(",")] if isinstance(raw, str) else None
    if not names or not all(_DISABLED_TOOL_NAME.fullmatch(name) for name in names):
        raise ValueError(f"disabledTools debe ser una lista de nombres separados por comas, de hasta {MAX_PROJECT_TOOL_ID_LENGTH} caracteres sin espacios")
    names = list(dict.fromkeys(names))
    if len(names) > MAX_DISABLED_TOOLS:
        raise ValueError(f"disabledTools no puede tener más de {MAX_DISABLED_TOOLS} nombres")
    return names


def parse_run_request(raw: bytes) -> dict:
    """Valida el contenido de --run-file y devuelve sus campos limpios; ValueError con el motivo si no vale."""
    data = _run_request_object(raw)
    request = {}
    for key in RUN_FILE_TEXT_KEYS:
        if key in data:
            value = data[key]
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"{key} debe ser un texto no vacío")
            request[key] = value.strip()
    if "conversation_id" in request:
        request["conversation_id"] = _validate_conversation_id(request["conversation_id"])
    if "agent" in request:
        request["agent"] = validate_agent_id(request["agent"])
    if "systemDataPrompt" in data:
        if not isinstance(data["systemDataPrompt"], str):
            raise ValueError("systemDataPrompt debe ser un texto")
        request["systemDataPrompt"] = validate_project_prompt(data["systemDataPrompt"])
    request.update(_agent_options(data))
    for key, maximum in RUN_FILE_LIMIT_KEYS.items():
        if key in data:
            value = data[key]
            if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= maximum:
                raise ValueError(f"{key} debe ser un entero entre 1 y {maximum}")
            request[key] = value
    return request


def run_process_alive(data: dict) -> bool:
    """Comprueba si el proceso de una ejecución sigue activo y corresponde al arranque original."""
    pid = data.get("pid")
    saved_start = data.get("pid_start")
    with _EXIT_LOCK:
        if (pid, saved_start) in _EXITED:
            return False
    if not _pid_alive(pid):
        return False
    if saved_start:
        current_start = _process_start_token(pid)
        if current_start is not None and current_start != saved_start:
            return False
    return True


def watch_run_exit(pid: int, pid_start: str | None, proc: subprocess.Popen | None = None) -> None:
    """
    Espera en un hilo, sin sondeo, a que termine el proceso de una ejecución y avisa del cambio del estado vivo: su
    final (completada, a la espera del usuario o con error) ya está en SQLite cuando termina. Con proc, el que lanzó
    este servidor (start_server_run), lo espera con Popen.wait y así lo recoge; si no, por su PID.
    """
    key = (pid, pid_start)
    with _EXIT_LOCK:
        if key in _EXIT_WATCHED or key in _EXITED:
            return
        _EXIT_WATCHED.add(key)

    def wait():
        if proc is not None:
            proc.wait()
            exited = True
        else:
            exited = wait_pid_exit(pid, None)
        if exited is None:
            return  # No se puede esperar: se queda en _EXIT_WATCHED para no reintentarlo.
        with _EXIT_LOCK:
            _EXIT_WATCHED.discard(key)
            _remember_exit(key)
        notify_live_change()

    threading.Thread(target=wait, name=f"run-exit-{pid}", daemon=True).start()


def write_run_state(session: RunSession) -> None:
    """Guarda atómicamente en SQLite el estado de la ejecución, si alguien la sigue (state_conversation_id)."""
    if not session.state_conversation_id:
        return
    now = int(time.time() * 1000)
    session.updated_at = now
    warnings = list(session.warnings)
    if session.warnings_omitted:
        warnings.append(f"… y {session.warnings_omitted} permiso(s) denegado(s) más")
    payload = {
        "run_id": session.run_id,
        "conversation_id": session.state_conversation_id,
        "pid": session.pid,
        "pid_start": session.pid_start,
        "started_at": session.started_at,
        "updated_at": session.updated_at,
        "status": session.status,
        "step_text": session.step_text,
        "pending": session.pending,
        "error": session.error,
        "finished_at": None if session.status == "running" else now,
        "result_text": session.result_text,
        "warnings": warnings,
        "usage": session.usage,
    }
    upsert_run_state(payload)


def discard_unstarted_run(session: RunSession | None) -> None:
    """Una ejecución que sale antes de lanzar su runner (proyecto sin entorno guardado, sin Node, sin puerto...) no deja
    fila en runs: borra la suya (la de su run_id; la de otra ejecución de la conversación no se toca)."""
    if session is None or session.runner_started or not session.state_conversation_id:
        return
    try:
        row = get_run_state(session.state_conversation_id)
    except (ValueError, sqlite3.Error, OSError):
        return
    if row and row.get("run_id") == session.run_id:
        remove_run_state(session.state_conversation_id)


def remove_run_state(conversation_id: str | None) -> None:
    """Elimina de SQLite el estado de la ejecución de la conversación al cancelarla."""
    if not conversation_id:
        return
    try:
        delete_run_state(conversation_id)
    except ValueError:
        pass  # Un identificador no válido nunca tuvo estado guardado.
    except (sqlite3.Error, OSError) as err:
        log_event(f"[zerochat] No se pudo borrar el estado de la ejecución de '{conversation_id}': {err}")


def list_server_runs(focus_conversation_id: str | None = None) -> tuple[list[dict], dict | None]:
    """
    Lee las ejecuciones en la tabla `runs` de SQLite. Si un proceso 'running' ya murió,
    lo marca como 'error'. Devuelve (runs, focus_run), donde runs es una lista ligera de las que no han
    terminado bien, ordenada por started_at, y focus_run es el detalle completo (también de una 'completed',
    con su respuesta y sus avisos) si coincide con focus_conversation_id.
    En un servidor de ejecución (--prompt o --conversation) devuelve ([], None) para que el propio
    worker no se bloquee ni omita el guardado de su conversación.
    """
    if RUN_SESSION is not None:
        return [], None
    entries = []
    clean_focus_id = focus_conversation_id.strip() if (isinstance(focus_conversation_id, str) and focus_conversation_id.strip()) else None

    for data in list_run_states():
        conv_id = data.get("conversation_id")
        if not conv_id or not isinstance(conv_id, str):
            continue

        status = data.get("status")
        if status == "running" and run_process_alive(data):
            watch_run_exit(data["pid"], data.get("pid_start"))
        elif status == "running":
            now = int(time.time() * 1000)
            status = "error"
            data["status"] = "error"
            data["error"] = "El proceso de ejecución terminó inesperadamente."
            data["updated_at"] = now
            data["finished_at"] = now
            # Aunque no se pueda guardar, el latido ya la entrega en error.
            try:
                upsert_run_state(data)
            except (sqlite3.Error, OSError) as err:
                log_event(f"[zerochat] No se pudo marcar en error la ejecución de '{conv_id}': {err}")

        light = {
            "conversation_id": conv_id,
            "run_id": data.get("run_id"),
            "status": status
        }
        started_at = data.get("started_at", 0)
        entries.append((started_at, light, data))

    # Filas sin conversación de ejecuciones que ya no siguen (fallaron antes de guardarla): no son de nadie.
    try:
        orphans = set(delete_orphan_run_states())
    except (sqlite3.Error, OSError) as err:
        log_event(f"[zerochat] No se pudieron limpiar las ejecuciones sin conversación: {err}")
        orphans = set()
    entries = [entry for entry in entries if entry[1]["conversation_id"] not in orphans]
    entries.sort(key=lambda item: item[0])
    # Las completadas solo interesan a quien sigue su conversación: el latido no las arrastra todas.
    runs = [item[1] for item in entries if item[1]["status"] != "completed"]

    focus_run = None
    if clean_focus_id:
        for _, _, full_data in entries:
            if full_data.get("conversation_id") == clean_focus_id:
                # La interfaz recarga la conversación grabada cuando cambia esta fecha (el runner graba cada paso).
                focus_run = {**full_data, "conversation_updated_at": _conversation_updated_at(clean_focus_id)}
                break

    return runs, focus_run


def _conversation_updated_at(conversation_id: str) -> int | None:
    try:
        return get_conversation_updated_at(conversation_id)
    except ValueError:
        return None


def _run_target(params: dict) -> tuple[str, dict, str]:
    """La conversación de la ejecución y el nombre de su perfil: el pedido o, si no, el de la conversación."""
    conv_id = params.get("conversation_id")
    if not isinstance(conv_id, str) or not conv_id.strip():
        raise ValueError("conversation_id requerido.")
    clean_conv_id = _validate_conversation_id(conv_id)
    conv = get_conversation(clean_conv_id)
    if conv is None:
        raise ValueError(f"Conversación '{clean_conv_id}' no encontrada.")
    # Una conversación de agente se reanuda con el perfil de su lanzamiento, no con el que pida la interfaz.
    launch = get_conversation_launch(clean_conv_id) if conv.get("agent") else None
    profile = (launch or {}).get("profile") or params.get("profile")
    if not isinstance(profile, str) or not profile.strip():
        conv_profile = conv.get("profileId")
        if not isinstance(conv_profile, str) or not conv_profile.strip():
            raise ValueError("profile requerido.")
        profile = conv_profile.strip()
    profile_entry = get_general_profile(profile) or get_general_profile_by_name(profile)
    if not profile_entry:
        raise ValueError(f"Perfil del servidor '{profile}' no encontrado.")
    return clean_conv_id, conv, profile_entry.get("name", profile.strip())


def check_no_active_run(conv_id: str, own_run_id: str | None = None):
    """Una conversación solo tiene una ejecución en marcha. `own_run_id` es la del proceso que pregunta: el hijo que
    lanza zerochat/run/start ya está anotado con su run_id antes de arrancar y no se cuenta como otra."""
    existing = get_run_state(conv_id)
    if existing and existing.get("status") == "running" and existing.get("run_id") != own_run_id and run_process_alive(existing):
        raise ValueError(f"Ya hay una ejecución en marcha para la conversación '{conv_id}'.")


# Ejecuciones en marcha a la vez en esta máquina, las lance la interfaz o un agente: frena a un orquestador
# que lanza demasiados agentes y a un agente que se relanza en cadena.
MAX_CONCURRENT_RUNS = 8


def running_run_count() -> int:
    """Ejecuciones en marcha con su proceso vivo en toda la máquina: las que cuenta MAX_CONCURRENT_RUNS."""
    return sum(1 for data in list_run_states() if data.get("status") == "running" and run_process_alive(data))


def check_run_capacity():
    """ValueError si ya hay MAX_CONCURRENT_RUNS ejecuciones vivas. Dos lanzamientos en el mismo instante pueden pasar
    uno de más, y una ejecución arrancada a mano (zerochat --prompt) no se frena, aunque cuenta."""
    if running_run_count() >= MAX_CONCURRENT_RUNS:
        raise ValueError(f"Too many runs in progress ({MAX_CONCURRENT_RUNS} at a time on this machine): "
                         "wait for one to finish before starting another.")


def start_server_run(params: dict) -> dict:
    """Inicia una ejecución en segundo plano para una conversación, en su proyecto o, si no tiene, en la carpeta general."""
    if not isinstance(params, dict):
        raise ValueError("Parámetros no válidos.")
    clean_conv_id, conv, profile_name = _run_target(params)
    check_no_active_run(clean_conv_id)
    check_run_capacity()

    prompt = params.get("prompt")
    if prompt is not None and not isinstance(prompt, str):
        raise ValueError("prompt debe ser una cadena o null.")

    tool_security = params.get("tool_security")
    if tool_security is not None and not isinstance(tool_security, dict):
        raise ValueError("tool_security debe ser un objeto o null.")
    subagents = params.get("subagents", False)
    if not isinstance(subagents, bool):
        raise ValueError("subagents debe ser true o false.")

    if not find_node_executable():
        raise ValueError(f"Se necesita {NODE_REQUIRED_MESSAGE} para ejecutar tareas en segundo plano en el servidor.")

    project = conv.get("project")
    if project and not Path(project).is_dir():
        raise ValueError(f"La carpeta del proyecto de la conversación ya no existe: {project}")

    run_id = secrets.token_urlsafe(24)
    cmd = [sys.executable, str(Path(__file__).resolve()), "--conversation", clean_conv_id, f"--profile={profile_name}"]
    if prompt:
        cmd.append(f"--prompt={prompt}")

    env = dict(os.environ)
    env["ZEROCHAT_RUN_ID"] = run_id
    if tool_security:
        env["ZEROCHAT_RUN_SECURITY"] = json.dumps(tool_security, ensure_ascii=False)
    if subagents and not conv.get("agent"):
        env[ZEROCHAT_RUN_SUBAGENTS_ENV] = "1"
    else:
        env.pop(ZEROCHAT_RUN_SUBAGENTS_ENV, None)

    now = int(time.time() * 1000)
    mark_conversation_server_run(clean_conv_id, profile_name)

    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=DETECTED_OS != "windows" and hasattr(os, "setsid"),
        env=env,
        cwd=project or str(get_no_project_dir())
    )

    payload = {
        "run_id": run_id,
        "conversation_id": clean_conv_id,
        "pid": proc.pid,
        "pid_start": _process_start_token(proc.pid),
        "started_at": now,
        "updated_at": now,
        "status": "running",
        "step_text": "",
        "pending": None,
        "error": None
    }
    upsert_run_state(payload)
    watch_run_exit(proc.pid, payload["pid_start"], proc)

    return {"ok": True, "run_id": run_id, "conversation_id": clean_conv_id, "status": "running"}


def launch_run_file(request: dict, cwd: Path) -> dict:
    """
    Lanza `zerochat --run-file -` con la petición ya validada (con su conversation_id) en la carpeta cwd, separado de
    este proceso: no es un comando de run_command, así que sigue aunque esta ejecución termine. Su fila de runs queda
    en marcha con el run_id que recibe en ZEROCHAT_RUN_ID antes de que arranque. ValueError si no se puede lanzar.
    """
    conv_id = request["conversation_id"]
    check_no_active_run(conv_id)
    check_run_capacity()
    if not find_node_executable():
        raise ValueError(f"Se necesita {NODE_REQUIRED_MESSAGE} para lanzar agentes.")
    run_id = secrets.token_urlsafe(24)
    env = {key: value for key, value in os.environ.items() if key not in ("ZEROCHAT_RUN_SECURITY", ZEROCHAT_RUN_SUBAGENTS_ENV)}
    env["ZEROCHAT_RUN_ID"] = run_id
    proc = subprocess.Popen(
        [sys.executable, str(Path(__file__).resolve()), "--run-file", "-"],
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=DETECTED_OS != "windows" and hasattr(os, "setsid"),
        env=env,
        cwd=str(cwd),
    )
    now = int(time.time() * 1000)
    payload = {"run_id": run_id, "conversation_id": conv_id, "pid": proc.pid, "pid_start": _process_start_token(proc.pid),
               "started_at": now, "updated_at": now, "status": "running", "step_text": "", "pending": None, "error": None}
    upsert_run_state(payload)
    watch_run_exit(proc.pid, payload["pid_start"], proc)
    data = format_run_request(request).encode("utf-8")

    def write_request():
        # Hasta RUN_FILE_MAX_BYTES no caben en la tubería: la escritura espera a que el hijo lea, fuera de este hilo.
        try:
            if proc.stdin is not None:
                proc.stdin.write(data)
                proc.stdin.close()
        except OSError:
            pass  # Si el proceso ya terminó, su final queda en su fila (watch_run_exit) como el de cualquier ejecución.

    threading.Thread(target=write_request, name=f"run-file-stdin-{proc.pid}", daemon=True).start()
    return {"run_id": run_id, "pid": proc.pid}


def cancel_server_run(conversation_id: str) -> dict:
    """Cancela una ejecución en segundo plano: termina el proceso si sigue en marcha y elimina su estado."""
    if not isinstance(conversation_id, str) or not conversation_id.strip():
        raise ValueError("conversation_id requerido.")
    clean_conv_id = _validate_conversation_id(conversation_id)
    data = get_run_state(clean_conv_id)
    if data:
        if data.get("status") == "running" and run_process_alive(data):
            _kill_process_tree(data.get("pid"), grace_seconds=0.05)
        remove_run_state(clean_conv_id)
    return {"cancelled": True}


def _approved_call(tool_security) -> tuple[str, dict] | None:
    """(nombre, argumentos) de tool_decision, la llamada que la persona aprobó al reanudar; None sin aprobación."""
    decision = tool_security.get("tool_decision") if isinstance(tool_security, dict) else None
    if not isinstance(decision, dict):
        return None
    tool_name, args, choice = decision.get("toolName"), decision.get("args"), decision.get("decision")
    choice = choice.get("decision") if isinstance(choice, dict) else choice
    if not isinstance(tool_name, str) or not tool_name or not isinstance(args, dict) or choice in (None, "deny"):
        return None
    return tool_name, args


class ControllerState:
    """Lo que un controlador recuerda mientras vive: las conversaciones que lanzó con launch_agent
    ({id: {agent, project, updatedAt}}), que check_agents ve desde el lanzamiento, antes de que el agente las guarde, y
    las respuestas finales ya entregadas, por (conversación, run_id) -> (result_chars, partial), que el listado no repite
    ni relee en conversaciones cortadas. Lo tiene cada ejecución y cada conversación del servidor de la interfaz."""
    def __init__(self):
        self.launched_agents: dict[str, dict] = {}
        self.delivered_results: dict[tuple[str, str], tuple[int, bool]] = {}


class RunSession(ControllerState):
    """Estado de la ejecución: prompt, opciones, último progreso, exportación, resultado y motivo de un final sin él."""
    def __init__(self, prompt: str | None = None, profile: str | None = None, export_path: Path | None = None,
                 conversation_id: str | None = None, run_id: str | None = None,
                 tool_security: dict | None = None, profile_data: dict | None = None,
                 new_conversation_id: str | None = None, system_data_prompt: str | None = None,
                 max_steps: int | None = None, timeout_seconds: int | None = None, project_mode: bool | None = None,
                 agent: str | None = None, launch: dict | None = None, controller: bool = False, disabled_tools: tuple[str, ...] = (),
                 track_run: bool = False, reasoning: str | None = None, subagents: bool = False):
        super().__init__()
        env_run_id = os.environ.get("ZEROCHAT_RUN_ID", "").strip()
        self.run_id = run_id.strip() if (run_id and isinstance(run_id, str) and run_id.strip()) else (env_run_id or secrets.token_urlsafe(24))
        self.conversation_id = conversation_id
        # Sin --conversation, la conversación nueva que guarda la ejecución: la de --run-file o, si no, una que elige el
        # servidor (mismo formato que createId('session')). A ella se ata la credencial del runner, que no puede escribir
        # en ninguna otra.
        self.new_conversation_id = None if conversation_id else (new_conversation_id or f"session_{uuid.uuid4()}")
        # Conversación cuyo estado se guarda en la tabla runs: la que indicó quien lanzó la ejecución (--conversation o
        # --run-file), o cualquier ejecución con agent / --run-file aunque cree id nuevo; un --prompt suelto no deja fila.
        self.state_conversation_id = conversation_id or new_conversation_id or (self.new_conversation_id if (agent or track_run) else None)
        self.prompt = prompt
        # systemDataPrompt de --run-file: sustituye al del proyecto solo en esta ejecución (run_project_environment).
        self.system_data_prompt = system_data_prompt
        # agent de --run-file: marca la conversación nueva como de ese agente (run_conversation_meta).
        self.agent = agent
        # Petición de lanzamiento de un agente (--run-file): finish_run la guarda en su conversación.
        self.launch = launch
        # Controladora: la de controller: true de --run-file o la de un chat lanzado en segundo plano con «Subagentes»
        # (nunca la de un agente). Publica y autoriza las herramientas del controlador solo en esta ejecución.
        self.controller = bool(controller or (subagents and not agent and not track_run))
        # disabledTools de --run-file: lo que run_project_environment le quita del entorno del proyecto.
        self.disabled_tools = tuple(disabled_tools)
        # projectMode de --run-file: si el runner inyecta las normas y el estado del proyecto; None (--prompt y
        # --conversation) deja el modo proyecto por defecto del runner.
        self.project_mode = project_mode
        # reasoning de --run-file (o de su lanzamiento al continuarla): el runner lo aplica tras activar el perfil;
        # None (--prompt, --conversation de un chat) deja el del perfil.
        self.reasoning = reasoning
        # Límites de --run-file: el de pasos lo aplica el bucle del runner y el de tiempo, run_supervisor.
        self.max_steps = max_steps
        self.timeout_seconds = timeout_seconds
        self.started_monotonic = time.monotonic()
        # Perfil (nombre o id) que la interfaz usa solo en esta ejecución; por defecto, local del servidor.
        self.profile = profile
        self.profile_data = profile_data
        # Fichero donde se escribe la conversación exportada (formato por su extensión); None, sin exportar.
        self.export_path = export_path
        self.exported = False
        self.export_error: str | None = None
        if tool_security is not None:
            self.tool_security = tool_security
        elif os.environ.get("ZEROCHAT_RUN_SECURITY"):
            try:
                self.tool_security = json.loads(os.environ["ZEROCHAT_RUN_SECURITY"])
            except (json.JSONDecodeError, TypeError):
                self.tool_security = None
        else:
            self.tool_security = None
        self._approved_call = _approved_call(self.tool_security)
        self.lock = threading.Lock()
        self.prompt_delivered = False
        self.result: dict | None = None
        self.stop_reason: str | None = None
        self.finished = threading.Event()
        self._wake: threading.Event | None = None
        self.pid = os.getpid()
        self.pid_start = _process_start_token(self.pid)
        self.started_at = int(time.time() * 1000)
        self.updated_at = self.started_at
        self.status = "running"
        self.step_text = ""
        self.pending: dict | None = None
        self.error: str | None = None
        self.result_text: str | None = None
        self.warnings: list[str] = []
        self.warnings_omitted = 0
        # Tokens acumulados que informa el runner (zerochat/run/usage); None hasta su primera llamada al modelo.
        self.usage: dict | None = None
        self.runner_token: str | None = None
        # Si llegó a lanzarse el runner de Node: antes de eso, salir no deja fila (discard_unstarted_run).
        self.runner_started = False
        write_run_state(self)

    def set_wake_event(self, event: threading.Event | None) -> None:
        """Asocia un evento compartido al que despertar cuando llegue el resultado."""
        with self.lock:
            self._wake = event
            if event is not None and self.finished.is_set():
                event.set()

    def add_warning(self, text: str, label: str = "Permiso denegado") -> None:
        """Anota un aviso (por defecto, un permiso denegado): en la fila de runs, para quien sigue la ejecución, y en
        stderr, para una persona."""
        console_error(timestamp_message(f"[run] {label}: {text}"))
        with self.lock:
            if len(self.warnings) < RUN_WARNINGS_MAX:
                self.warnings.append(_capped(text, RUN_PROGRESS_TEXT_MAX))
            else:
                self.warnings_omitted += 1
            write_run_state(self)

    def reach_limit(self, message: str) -> bool:
        """Termina la ejecución en un límite, si no tenía ya resultado; despierta a quien la espera."""
        with self.lock:
            if self.result is not None:
                return False
            self.result = {"limit": message}
            self.status = "limit"
            self.error = message
            write_run_state(self)
        self.signal_finished()
        return True

    def signal_finished(self) -> None:
        """Marca la ejecución como terminada y despierta a quien la espera con set_wake_event."""
        self.finished.set()
        with self.lock:
            wake = self._wake
        if wake is not None:
            wake.set()

    def take_approved_call(self, tool_name: str, args: dict) -> bool:
        """Si es la llamada que la persona aprobó en la tarjeta pausada (mismo nombre y argumentos), la consume:
        su reto lo contesta este servidor, una sola vez, porque la credencial del runner no puede resolver retos."""
        with self.lock:
            if self._approved_call is None or self._approved_call != (tool_name, args):
                return False
            self._approved_call = None
            return True


RUN_SESSION: RunSession | None = None


def set_run_session(session: RunSession | None):
    """Fija la ejecución desatendida de este proceso (None si atiende a la interfaz)."""
    global RUN_SESSION
    RUN_SESSION = session


def current_run_session() -> RunSession | None:
    """Ejecución desatendida de este proceso, o None si atiende a la interfaz."""
    return RUN_SESSION


def run_project_environment(env: dict) -> dict:
    """El entorno del proyecto que recibe la interfaz, sin escribir nada en SQLite: en una ejecución, con su
    systemDataPrompt propio en lugar del guardado y sin lo que quita su disabledTools (sus servicios MCP fuera de
    mcpServers, para que no se arranquen; el navegador, en none; las herramientas, desactivadas en enabledTools)."""
    session = RUN_SESSION
    if session is None:
        return env
    if session.system_data_prompt is not None:
        env = {**env, "systemDataPrompt": session.system_data_prompt}
    disabled = set(session.disabled_tools)
    if disabled:
        env = {**env, "mcpServers": [server for server in env.get("mcpServers") or [] if server not in disabled],
               "browser": "none" if env.get("browser") in disabled else env.get("browser"),
               "enabledTools": {**(env.get("enabledTools") or {}), **dict.fromkeys(sorted(disabled), False)}}
    return env


def run_conversation_meta(session_meta):
    """La cabecera de una conversación que se guarda en una ejecución: añade `agent` a la nueva y, si tiene `launch`
    (--run-file con agente, nueva o continuada), incluye `launch`, `serverRun` y `profileId` desde el primer guardado."""
    session = RUN_SESSION
    if session is None or not isinstance(session_meta, dict):
        return session_meta
    target_id = session.conversation_id or session.new_conversation_id
    if not target_id or session_meta.get("id") != target_id:
        return session_meta
    patched = dict(session_meta)
    if session.agent and session_meta.get("id") == session.new_conversation_id:
        patched["agent"] = session.agent
    if session.launch:
        patched["launch"] = session.launch
        patched["serverRun"] = True
        if session.profile:
            patched["profileId"] = session.profile
    return patched


def http_body_limit() -> int:
    """Tope del cuerpo que se lee: el general, o el de la exportación mientras se espera (ff-server
    rechaza después cualquier otro método que supere el general)."""
    session = RUN_SESSION
    if session is not None and session.export_path is not None and not session.exported:
        return RUN_EXPORT_MAX_BODY_BYTES
    return MAX_HTTP_BODY_BYTES


def _rpc_start(params: dict, _ctx: SecurityContext, session: RunSession | None) -> RpcOutcome:
    if session is not None:
        return rpc_error(METHOD_NOT_FOUND, "No disponible dentro de un proceso de ejecución.")
    try:
        return rpc_result(start_server_run(params))
    except ValueError as exc:
        return rpc_error(INVALID_PARAMS, str(exc))
    except OSError as exc:
        return rpc_error(INTERNAL_ERROR, f"Error al iniciar ejecución en servidor: {exc}", str(exc))


def _rpc_cancel(params: dict, ctx: SecurityContext, session: RunSession | None) -> RpcOutcome:
    if session is not None:
        return rpc_error(METHOD_NOT_FOUND, "No disponible dentro de un proceso de ejecución.")
    try:
        return rpc_result(cancel_server_run(params.get("conversation_id")))
    except ValueError as exc:
        return rpc_error(INVALID_PARAMS, str(exc))
    except OSError as exc:
        return rpc_error(INTERNAL_ERROR, f"Error al cancelar ejecución en servidor: {exc}", str(exc))


def _rpc_prompt(params: dict, session: RunSession) -> RpcOutcome:
    with session.lock:
        if session.prompt_delivered:
            return rpc_error(INVALID_PARAMS, "El prompt ya se entregó.")
        session.prompt_delivered = True
    export_format = RUN_EXPORT_FORMATS[session.export_path.suffix.lower()] if session.export_path else None
    # tool_security lo aplica este servidor: las políticas (reset_session_authorizations) y la llamada aprobada en la
    # tarjeta pausada (take_approved_call), así que el runner no recibe nada de él.
    return rpc_result({"prompt": session.prompt, "conversation_id": session.conversation_id,
                       "new_conversation_id": session.new_conversation_id, "profile": session.profile,
                       "profile_data": session.profile_data,
                       # Para switch_model, que busca por nombre: el runner no puede listar los perfiles con su credencial.
                       # El listado no lleva API keys; la del que active la pide con zerochat/run/profile.
                       "profiles": list_general_profiles(),
                       "export": export_format, "max_steps": session.max_steps, "project_mode": session.project_mode,
                       "reasoning": session.reasoning, "subagents": session.controller, "disabled_tools": list(session.disabled_tools)})


def _rpc_profile(params: dict, session: RunSession) -> RpcOutcome:
    """Un perfil del servidor con su API key, para el runner que lo activa con switch_model; queda en el registro."""
    profile_id = params.get("id")
    profile = get_general_profile_with_key(profile_id) if isinstance(profile_id, str) else None
    if profile is None:
        return rpc_error(INVALID_PARAMS, "Perfil del servidor no encontrado.")
    log_event(f"[run] Se entrega al runner el perfil {profile['name']} con su clave")
    return rpc_result({"profile": profile})


def _capped(text: str, limit: int) -> str:
    return text[:limit] + ("…" if len(text) > limit else "")


def _rpc_progress(params: dict, session: RunSession) -> RpcOutcome:
    kind = params.get("kind")
    text = params.get("text", "")
    if not isinstance(kind, str) or not RUN_PROGRESS_KIND_PATTERN.fullmatch(kind) or not isinstance(text, str):
        return rpc_error(INVALID_PARAMS, "Progreso no válido.")
    # Un aviso del runner (p. ej. un nombre de disabledTools que no es nada de la ejecución) va a los avisos, no al paso.
    if kind == "warning":
        session.add_warning(text, label="Aviso")
        return rpc_result({"ok": True})
    truncated_step = _capped(text, RUN_PROGRESS_TEXT_MAX)
    log_event(f"[run] {kind}{': ' + truncated_step if truncated_step else ''}")
    with session.lock:
        session.step_text = truncated_step
        write_run_state(session)
    return rpc_result({"ok": True})


def _rpc_usage(params: dict, session: RunSession) -> RpcOutcome:
    """Tokens acumulados de la ejecución hasta su último paso: el runner los manda tras cada llamada al modelo, así
    que quedan en la fila aunque la ejecución se corte por tiempo o muera."""
    usage = {key: params.get(key) for key in RUN_USAGE_COUNTERS}
    estimated = params.get("estimated")
    if any(isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= RUN_USAGE_MAX
           for value in usage.values()) or not isinstance(estimated, bool):
        return rpc_error(INVALID_PARAMS, "Consumo no válido.")
    with session.lock:
        session.usage = {**usage, "estimated": estimated}
        write_run_state(session)
    return rpc_result({"ok": True})


def _rpc_export(params: dict, session: RunSession) -> RpcOutcome:
    content = params.get("content")
    if session.export_path is None or not isinstance(content, str):
        return rpc_error(INVALID_PARAMS, "Exportación no pedida o sin contenido.")
    with session.lock:
        if session.exported:
            return rpc_error(INVALID_PARAMS, "La exportación ya se recibió.")
        try:
            session.export_path.write_text(content, encoding="utf-8")
        except OSError as exc:
            session.export_error = f"No se pudo escribir {session.export_path}: {exc}"
            return rpc_error(INTERNAL_ERROR, session.export_error)
        session.exported = True
    log_event(f"[run] Conversación exportada en {session.export_path}")
    return rpc_result({"ok": True})


def _rpc_result(params: dict, session: RunSession) -> RpcOutcome:
    text = params.get("text")
    error = params.get("error")
    needs_input = params.get("needs_input")
    is_text = isinstance(text, str) and error is None and needs_input is None
    is_error = isinstance(error, str) and bool(error) and text is None and needs_input is None
    limit = params.get("limit")
    is_needs_input = (isinstance(needs_input, dict) and needs_input.get("kind") in RUN_NEEDS_INPUT_KINDS
                      and isinstance(needs_input.get("text"), str) and text is None and error is None)
    # El único límite que ve el runner es el de pasos; el de tiempo lo aplica este servidor.
    is_limit = limit == "steps" and session.max_steps is not None and text is None and error is None and needs_input is None
    if limit is not None and not is_limit:
        return rpc_error(INVALID_PARAMS, "limit solo puede ser steps en una ejecución con maxSteps.")
    if is_limit:
        if not session.reach_limit(f"Límite de {session.max_steps} pasos alcanzado."):
            return rpc_error(INVALID_PARAMS, "El resultado ya se recibió.")
        return rpc_result({"ok": True})
    if not (is_text or is_error or is_needs_input):
        return rpc_error(INVALID_PARAMS, "El resultado lleva text, error, needs_input con kind y text, o limit.")
    with session.lock:
        if session.result is not None:
            return rpc_error(INVALID_PARAMS, "El resultado ya se recibió.")
        if is_text:
            session.result = {"text": text}
            session.status = "completed"
            session.result_text = text
            write_run_state(session)
        elif is_needs_input:
            session.result = {"needs_input": needs_input}
            session.status = "needs_input"
            session.pending = needs_input
            write_run_state(session)
        else:
            session.result = {"error": error}
            session.status = "error"
            session.error = error
            write_run_state(session)
    session.signal_finished()
    return rpc_result({"ok": True})


# La interfaz del servidor principal lanza y detiene ejecuciones; la de una ejecución (con su run_id) le
# pide el prompt e informa del progreso, la exportación y el resultado.
RUN_CONTROL_METHODS = {"zerochat/run/start": _rpc_start, "zerochat/run/cancel": _rpc_cancel}
RUN_SESSION_METHODS = {
    "zerochat/run/prompt": _rpc_prompt,
    "zerochat/run/profile": _rpc_profile,
    "zerochat/run/progress": _rpc_progress,
    "zerochat/run/usage": _rpc_usage,
    "zerochat/run/export": _rpc_export,
    "zerochat/run/result": _rpc_result,
}


def dispatch_run(method: str, params: dict, ctx: SecurityContext) -> RpcOutcome:
    """Métodos zerochat/run/*: el control de ejecuciones y los de la interfaz abierta por el modo ejecución."""
    params = params if isinstance(params, dict) else {}
    session = RUN_SESSION
    if method in RUN_CONTROL_METHODS:
        return RUN_CONTROL_METHODS[method](params, ctx, session)
    if session is None:
        return rpc_error(METHOD_NOT_FOUND, "El servidor no está en modo ejecución.")
    run_id = params.get("run_id")
    if not isinstance(run_id, str) or not hmac.compare_digest(run_id, session.run_id):
        return rpc_error(INVALID_PARAMS, "run_id no válido.")
    return dispatch_table(RUN_SESSION_METHODS, method, params, session)


def run_error(message: str):
    """Motivo de un final sin respuesta: va a stderr aunque el registro esté desactivado (--log off)."""
    session = RUN_SESSION
    if session is not None and session.result is None:
        with session.lock:
            session.status = "error"
            session.error = message
            write_run_state(session)
    console_error(timestamp_message(f"[run] {message}"))


def announce_run_conversation(session: RunSession):
    """
    Con --run-file, una línea en stderr (también con --log off) con la conversación de la ejecución, para que un
    orquestador de shell la siga sin HTTP: `[run] conversation_id=<id> new=<true|false>`, nueva si no existía.
    """
    console_error(f"[run] conversation_id={session.conversation_id or session.new_conversation_id} "
                  f"new={'false' if session.conversation_id else 'true'}")


def run_outcome(session: RunSession) -> tuple[int, str | None]:
    """
    Código de salida y texto para stdout: la respuesta final o, si se pausó, lo que espera del usuario; el motivo de un
    fallo va a stderr. Una exportación pedida que no se escribió convierte un final correcto en error sin quitar la respuesta.
    """
    if session.export_path and not session.exported:
        run_error(session.export_error or f"La interfaz no envió la conversación para {session.export_path}.")
    if session.result is None:
        run_error(session.stop_reason or session.error or RUN_INTERRUPTED_ERROR)
        return RUN_EXIT_NO_RESULT, None
    if "limit" in session.result:
        console_error(timestamp_message(f"[run] {session.result['limit']} Lo hecho queda grabado en la conversación."))
        return RUN_EXIT_LIMIT, None
    if "error" in session.result:
        run_error(f"Error de generación: {session.result['error']}")
        return RUN_EXIT_ERROR, None
    if "needs_input" in session.result:
        pending = session.result["needs_input"]
        console_error(timestamp_message("[run] Ejecución pausada a la espera del usuario."))
        if pending["kind"] == "tool_approval":
            return RUN_EXIT_NEEDS_INPUT, f"Pendiente de aprobar la herramienta {pending['text']}."
        return RUN_EXIT_NEEDS_INPUT, pending["text"]
    log_event("[run] Ejecución terminada.")
    if session.export_path and not session.exported:
        return RUN_EXIT_ERROR, session.result["text"]
    return RUN_EXIT_DONE, session.result["text"]


# Versión mínima de Node.js para el runner: el modelo de permisos es estable desde la 22.13 (M65-D1).
NODE_MINIMUM_VERSION = (22, 13)
NODE_REQUIRED_MESSAGE = f"Node.js {'.'.join(map(str, NODE_MINIMUM_VERSION))} o superior"


def find_node_executable() -> str | None:
    """Localiza un ejecutable de Node.js en PATH y comprueba su versión mínima."""
    executable = shutil.which("node")
    if not executable:
        return None
    try:
        res = subprocess.run([executable, "--version"], capture_output=True, text=True, timeout=15)
        if res.returncode != 0:
            return None
        match = re.search(r"v?(\d+)\.(\d+)\.", res.stdout.strip())
        if not match or (int(match.group(1)), int(match.group(2))) < NODE_MINIMUM_VERSION:
            return None
        return executable
    except (OSError, subprocess.SubprocessError):
        return None
