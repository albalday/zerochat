"""Punto único de decisión de permisos (AccessController): evalúa cada llamada, emite retos de un solo uso y guarda las decisiones por sesión de proyecto y en SQLite."""

from __future__ import annotations

import dataclasses
import re
import secrets
import threading
import time
import typing
from pathlib import Path

from security.context import SecurityContext, normalize_directory_path
from security.rules import (
    AUTHORIZE_DECISIONS,
    AccessDecision,
    COMMAND_TOOL,
    DIRECTORY_PATH_TOOLS,
    JOB_CONTROL_TOOL,
    MAX_COMMAND_PATTERNS,
    POLICY_ALLOW,
    POLICY_ASK,
    POLICY_DENY,
    SCOPE_PERMANENT,
    SCOPE_SESSION,
    WORKSPACE_TRUST_PIPE_FILTERS,
    cd_target,
    check_command_pattern_limit,
    clean_pattern_list,
    command_outside_references,
    command_rule_offer,
    directory_rule_offer,
    get_command_arg,
    get_integrated_path_access,
    get_path_arg,
    matches_command_pattern,
    matches_directory_pattern,
    normalize_command_pattern,
    parse_directory_rule,
    split_command,
)
from storage.db import get_security_policy_data, update_security_policy_data
from tools.jobs import JOBS

POLICY_STATE_VERSION = 8
CHALLENGE_TTL_MS = 600_000
MAX_POLICY_ENTRIES = 500
# Proyectos con sesión en memoria: al pasar del tope se olvida la del usado hace más tiempo sin comandos en marcha.
MAX_PROJECT_SESSIONS = 16


@dataclasses.dataclass
class ProjectSession:
    """
    Lo autorizado en la sesión para un proyecto y sus retos pendientes, en memoria mientras dure el servidor.
    Lo comparten todas las pestañas y dispositivos que trabajan en ese proyecto.
    """
    last_used: float = 0.0
    allow_all: bool | None = None
    directory_rules: list[str] | None = None
    tools: dict[str, dict] = dataclasses.field(default_factory=dict)
    servers: dict[str, dict] = dataclasses.field(default_factory=dict)
    command_patterns: list[str] = dataclasses.field(default_factory=list)
    challenges: dict[str, dict] = dataclasses.field(default_factory=dict)

    def entries(self, kind: str) -> dict[str, dict]:
        return self.tools if kind == "tools" else self.servers


class AccessController:
    """Motor de control de acceso y autorización del backend (PDP/PEP)."""

    def __init__(self):
        self._lock = threading.RLock()
        self.sessions: dict[str, ProjectSession] = {}

    def _session(self, context: SecurityContext) -> ProjectSession:
        """
        Sesión del proyecto de la petición, creada vacía la primera vez. Con MAX_PROJECT_SESSIONS proyectos
        en memoria, olvida la del usado hace más tiempo que no tenga comandos en marcha (como mucho hay 8
        comandos a la vez, así que siempre queda alguno sin ellos).
        """
        with self._lock:
            session = self.sessions.get(context.key)
            if session is None:
                if len(self.sessions) >= MAX_PROJECT_SESSIONS:
                    idle = [k for k in self.sessions if not JOBS.running(k)]
                    del self.sessions[min(idle, key=lambda k: self.sessions[k].last_used)]
                session = self.sessions[context.key] = ProjectSession()
            session.last_used = time.monotonic()
            return session

    @staticmethod
    def _normalize_global(raw: dict | None) -> dict:
        """Única definición de las políticas globales guardadas en SQLite."""
        data = raw if isinstance(raw, dict) else {}
        # run_command nunca se guarda autorizado entero: sus permisos permanentes son patrones.
        tools = {tid: entry for tid, entry in dict(data.get("tools") or {}).items()
                 if not (tid == COMMAND_TOOL and isinstance(entry, dict) and entry.get("policy") == POLICY_ALLOW)}
        raw_patterns = data.get("commandPatterns")
        patterns = list(raw_patterns) if isinstance(raw_patterns, list) else []
        return {
            "version": POLICY_STATE_VERSION,
            "tools": tools,
            "servers": dict(data.get("servers") or {}),
            "commandPatterns": patterns,
        }

    @staticmethod
    def _normalize_project(raw: dict | None) -> dict:
        """Única definición de las políticas por proyecto guardadas en SQLite."""
        data = raw if isinstance(raw, dict) else {}
        raw_rules = data.get("directoryRules")
        raw_patterns = data.get("commandPatterns")
        return {
            "allowAll": data.get("allowAll") is True,
            "directoryRules": list(raw_rules) if isinstance(raw_rules, list) else None,
            "commandPatterns": list(raw_patterns) if isinstance(raw_patterns, list) else [],
        }

    @staticmethod
    def _compact_project(project_state: dict) -> dict | None:
        """Omite la fila del proyecto en SQLite cuando todo queda en sus valores por defecto."""
        stored: dict = {}
        if project_state["allowAll"]:
            stored["allowAll"] = True
        if project_state["directoryRules"] is not None:
            stored["directoryRules"] = list(project_state["directoryRules"])
        if project_state["commandPatterns"]:
            stored["commandPatterns"] = list(project_state["commandPatterns"])
        return stored or None

    def _read_permanent_state(self, context: SecurityContext) -> tuple[dict, dict]:
        """Lee el estado permanente global y del proyecto en SQLite; un fallo se propaga."""
        raw_global, raw_project = get_security_policy_data(context.key)
        return self._normalize_global(raw_global), self._normalize_project(raw_project)

    def _update_permanent(self, context: SecurityContext, mutator: typing.Callable[[dict, dict, int], None]) -> tuple[dict, dict | None]:
        """Lectura-modificación-escritura transaccional sobre las filas global y del proyecto."""
        def apply(raw_global: dict | None, raw_project: dict | None, other_pattern_count: int) -> tuple[dict, dict | None]:
            global_state = self._normalize_global(raw_global)
            project_state = self._normalize_project(raw_project)
            mutator(global_state, project_state, other_pattern_count)
            check_command_pattern_limit(global_state["commandPatterns"], project_state["commandPatterns"], other_pattern_count)
            self._check_entry_limit({
                "directoryRules": project_state["directoryRules"] or [],
                "tools": global_state["tools"],
                "servers": global_state["servers"],
            })
            return global_state, self._compact_project(project_state)
        return update_security_policy_data(context.key, apply)

    def _effective_state(self, context: SecurityContext) -> dict:
        """Una sola lectura del estado permanente combinada con la capa de sesión del proyecto."""
        global_state, project_state = self._read_permanent_state(context)
        default_rule = self.get_default_directory_rule(context)
        with self._lock:
            session = self._session(context)
            if session.directory_rules is not None:
                dir_rules = list(session.directory_rules)
            elif project_state["directoryRules"] is not None:
                dir_rules = list(project_state["directoryRules"])
            else:
                dir_rules = [default_rule]
            return {
                "allowAll": session.allow_all if session.allow_all is not None else project_state["allowAll"],
                "directoryRules": dir_rules,
                "tools": {**global_state["tools"], **session.tools},
                "servers": {**global_state["servers"], **session.servers},
                "commandPatterns": {
                    "global": list(global_state["commandPatterns"]),
                    "project": list(project_state["commandPatterns"]),
                    "session": list(session.command_patterns)
                }
            }

    def _command_patterns(self, view: dict) -> list[str]:
        """Patrones que rigen en el proyecto: los de todos los proyectos, los de este y los de la sesión."""
        patterns = view["commandPatterns"]
        return [*patterns["global"], *patterns["project"], *patterns["session"]]

    def export_state(self, context: SecurityContext) -> dict:
        return {
            "version": POLICY_STATE_VERSION,
            **self._effective_state(context)
        }

    @staticmethod
    def _validate_directory_rules(raw_rules: list | tuple) -> list[str]:
        if not isinstance(raw_rules, (list, tuple)):
            raise ValueError("Las reglas de directorio deben ser una lista.")
        parsed_rules = []
        for raw in raw_rules:
            rule_obj = parse_directory_rule(raw)
            if not rule_obj:
                raise ValueError(f"Regla de directorio inválida: '{raw}'. Formato esperado: combinación de R, W y X (p. ej. R:path, RW:path, RWX:path).")
            parsed_rules.append(rule_obj["rule"])
        return list(dict.fromkeys(parsed_rules))

    @staticmethod
    def _validate_policy_entries(raw_entries: dict, kind: str, scope: str) -> dict:
        kind_desc = "herramientas" if kind == "tools" else "servidores"
        kind_label = "la herramienta" if kind == "tools" else "el servidor"
        if not isinstance(raw_entries, dict):
            raise ValueError(f"{kind} debe ser un diccionario de {kind_desc}.")
        clean_map = {}
        for item_id, entry in raw_entries.items():
            clean_key = str(item_id).strip()
            if not clean_key:
                continue
            if entry is None:
                clean_map[clean_key] = None
                continue
            if not isinstance(entry, dict):
                raise ValueError(f"La entrada para {kind_label} '{item_id}' debe ser un diccionario o None.")
            pol = entry.get("policy")
            if pol not in (POLICY_ALLOW, POLICY_DENY):
                raise ValueError(f"Política inválida para {kind_label} '{item_id}': '{pol}'. Válidas: allow, deny.")
            # Como en un reto (allow_always), run_command solo se autoriza siempre con patrones de comando.
            if kind == "tools" and clean_key == COMMAND_TOOL and pol == POLICY_ALLOW and scope == SCOPE_PERMANENT:
                raise ValueError("allow_always_requires_command_pattern")
            clean_map[clean_key] = AccessController._make_entry(
                kind, pol, scope,
                server_name=str(entry.get("serverName", "") or ""),
                original_name=str(entry.get("originalName", "") or "")
            )
        return clean_map

    @staticmethod
    def _make_entry(kind: str, policy: str, scope: str, server_name: str = "", original_name: str = "") -> dict:
        """Única forma de una entrada de política de herramienta o servidor."""
        entry = {
            "policy": policy,
            "scope": scope,
            "grantedAt": int(time.time() * 1000),
            "serverName": server_name
        }
        if kind == "tools":
            entry["originalName"] = original_name
        return entry

    @staticmethod
    def _check_entry_limit(state: dict):
        """Único tope de entradas, sobre el estado resultante (guardado o capa de sesión)."""
        dir_rules = state.get("directoryRules")
        dir_count = sum(len(v) for v in dir_rules.values()) if isinstance(dir_rules, dict) else len(dir_rules or [])
        total = dir_count + len(state.get("tools") or {}) + len(state.get("servers") or {})
        if total > MAX_POLICY_ENTRIES:
            raise ValueError(f"El número total de entradas ({total}) supera el máximo permitido ({MAX_POLICY_ENTRIES}).")

    def _validate_state_payload(self, state: dict, scope: str) -> tuple[bool | None, list[str] | None, dict | None, dict | None]:
        if not isinstance(state, dict):
            raise ValueError("El estado de políticas debe ser un diccionario.")

        clean_allow_all = None
        if "allowAll" in state:
            if not isinstance(state["allowAll"], bool):
                raise ValueError("allowAll debe ser un booleano.")
            clean_allow_all = state["allowAll"]

        clean_rules = self._validate_directory_rules(state["directoryRules"]) if "directoryRules" in state else None
        clean_tools = self._validate_policy_entries(state["tools"], "tools", scope) if "tools" in state else None
        clean_servers = self._validate_policy_entries(state["servers"], "servers", scope) if "servers" in state else None
        return clean_allow_all, clean_rules, clean_tools, clean_servers

    @staticmethod
    def _validate_command_patterns_patch(raw) -> dict:
        """Valida un parche de commandPatterns: {global, project} para el proyecto activo."""
        if not isinstance(raw, dict):
            raise ValueError("commandPatterns debe ser un diccionario con global y project.")
        return {
            "global": clean_pattern_list(raw.get("global") or [], "commandPatterns.global"),
            "project": clean_pattern_list(raw.get("project") or [], "commandPatterns.project"),
        }

    def import_state(self, state: dict, context: SecurityContext):
        """
        Aplica un parche parcial persistente (None revoca) y devuelve el estado exportado.
        `addDirectoryRules` añade reglas a las guardadas dentro de la misma transacción y
        `commandPatterns` sustituye los patrones globales y del proyecto actual sin tocar otros proyectos.
        """
        clean_allow_all, clean_rules, clean_tools, clean_servers = self._validate_state_payload(state, SCOPE_PERMANENT)
        added_rules = self._validate_directory_rules(state["addDirectoryRules"]) if "addDirectoryRules" in state else []
        clean_patterns = self._validate_command_patterns_patch(state["commandPatterns"]) if "commandPatterns" in state else None

        project = context.key
        default_rule = self.get_default_directory_rule(context)

        def mutator(global_state: dict, project_state: dict, _other_patterns: int) -> None:
            self._apply_state_patch(global_state, project_state, default_rule, clean_allow_all, clean_rules, added_rules, clean_tools, clean_servers, clean_patterns)
        self._update_permanent(context, mutator)
        self._forget_session_overrides(project, clean_allow_all, clean_rules, added_rules, clean_tools, clean_servers)
        return self.export_state(context)

    def _apply_state_patch(self, global_state: dict, project_state: dict, default_rule: str, clean_allow_all, clean_rules, added_rules, clean_tools, clean_servers, clean_patterns):
        """Aplica sobre el estado guardado los apartados del parche que vienen (None es «no cambiar»)."""
        if clean_allow_all is not None:
            project_state["allowAll"] = clean_allow_all
        if clean_rules is not None:
            project_state["directoryRules"] = None if clean_rules == [default_rule] else clean_rules
        if added_rules:
            base_rules = project_state["directoryRules"] if project_state["directoryRules"] is not None else [default_rule]
            project_state["directoryRules"] = self._append_rules(base_rules, added_rules)
        if clean_tools is not None:
            global_state["tools"] = self._apply_entry_patch(global_state.get("tools"), clean_tools)
        if clean_servers is not None:
            global_state["servers"] = self._apply_entry_patch(global_state.get("servers"), clean_servers)
        if clean_patterns is not None:
            global_state["commandPatterns"] = clean_pattern_list(clean_patterns["global"], "commandPatterns.global")
            project_state["commandPatterns"] = clean_pattern_list(clean_patterns["project"], "commandPatterns.project")

    def _forget_session_overrides(self, project: str, clean_allow_all, clean_rules, added_rules, clean_tools, clean_servers):
        """Lo guardado sustituye o revoca lo equivalente en la sesión (las reglas y permitir todo, solo en su proyecto)."""
        with self._lock:
            for key, session in self.sessions.items():
                if key == project:
                    if clean_allow_all is not None:
                        session.allow_all = None
                    if clean_rules is not None:
                        session.directory_rules = None
                    elif added_rules and session.directory_rules is not None:
                        session.directory_rules = self._append_rules(session.directory_rules, added_rules)
                for kind, patch in (("tools", clean_tools), ("servers", clean_servers)):
                    for item_id in patch or {}:
                        session.entries(kind).pop(item_id, None)

    @staticmethod
    def _append_rules(rules: list[str], new_rules: list[str]) -> list[str]:
        return list(dict.fromkeys(list(rules) + list(new_rules)))

    @staticmethod
    def _apply_entry_patch(current: dict | None, patch: dict) -> dict:
        """Aplica un parche de entradas (None revoca); conserva grantedAt si la política no cambia."""
        result = dict(current or {})
        for item_id, entry in patch.items():
            if entry is None:
                result.pop(item_id, None)
                continue
            previous = result.get(item_id) or {}
            same_grant = previous.get("policy") == entry["policy"]
            result[item_id] = {**entry, "grantedAt": previous["grantedAt"]} if same_grant and previous.get("grantedAt") else entry
        return result

    def apply_session_overlay(self, state: dict, context: SecurityContext):
        """
        Aplica una capa de políticas temporal en memoria para una ejecución en servidor, sin persistir.
        De los patrones de comando solo toma los de sesión: los guardados se leen de la misma base de datos.
        """
        clean_allow_all, clean_rules, clean_tools, clean_servers = self._validate_state_payload(state, SCOPE_SESSION)
        raw_patterns = state.get("commandPatterns")
        session_patterns = self._limit_patterns(clean_pattern_list(raw_patterns.get("session") or [], "commandPatterns.session")) \
            if isinstance(raw_patterns, dict) else None

        with self._lock:
            session = self._session(context)
            rules = clean_rules if clean_rules is not None else session.directory_rules
            tools = self._apply_entry_patch(session.tools, clean_tools or {})
            servers = self._apply_entry_patch(session.servers, clean_servers or {})
            self._check_entry_limit({"directoryRules": rules, "tools": tools, "servers": servers})
            if clean_allow_all is not None:
                session.allow_all = clean_allow_all
            session.directory_rules, session.tools, session.servers = rules, tools, servers
            if session_patterns is not None:
                session.command_patterns = session_patterns
        return self.export_state(context)

    @staticmethod
    def _limit_patterns(patterns: list[str]) -> list[str]:
        if len(patterns) > MAX_COMMAND_PATTERNS:
            raise ValueError(f"Hay {len(patterns)} patrones de comando; el máximo es {MAX_COMMAND_PATTERNS}.")
        return patterns

    @staticmethod
    def get_default_directory_rule(context: SecurityContext) -> str:
        base = normalize_directory_path(str(context.workspace_dir))
        return f"RWX:{base}" if base == "/" else f"RWX:{base}/**"

    @staticmethod
    def _resolve_rule_pattern(pattern: str, workspace_dir: Path | None = None) -> str:
        base, sep, rest = pattern.partition("*")
        if base:
            # Mismo resolutor que SecurityContext.resolve_path (destino y base de la regla).
            target = Path(base)
            if workspace_dir and not target.is_absolute():
                target = Path(workspace_dir) / target
            real_base = normalize_directory_path(str(target.resolve(strict=False)))
            if sep and base.endswith("/") and not real_base.endswith("/"):
                real_base += "/"
        else:
            real_base = ""
        return f"{real_base}{sep}{rest}"

    def evaluate_directory_rule(self, access: str, path: str, user_rules: list[str],
                                ctx: SecurityContext) -> dict:
        resolved_target = ctx.resolve_path(path)
        if resolved_target is None:
            return {"allowed": False, "rule": None, "path": ""}
        normalized_dest = normalize_directory_path(str(resolved_target))
        if not normalized_dest:
            return {"allowed": False, "rule": None, "path": ""}

        full_rule = self._full_directory_access_rule(user_rules, access)
        if full_rule:
            return {"allowed": True, "rule": full_rule, "path": normalized_dest}

        for raw_rule in user_rules:
            parsed = parse_directory_rule(raw_rule)
            if not parsed:
                continue
            rule_pattern = self._resolve_rule_pattern(parsed["path"], ctx.workspace_dir)
            if matches_directory_pattern(normalized_dest, rule_pattern) and all(ch in parsed["access"] for ch in access):
                return {"allowed": True, "rule": parsed["rule"], "path": normalized_dest}

        return {"allowed": False, "rule": None, "path": normalized_dest}

    def clear_session(self):
        """Olvida lo autorizado en la sesión y los retos pendientes de todos los proyectos."""
        with self._lock:
            self.sessions.clear()

    def apply_tool_decision(self, tool_decision: dict | None, context: SecurityContext, server_id: str = "") -> None:
        """Aplica en AccessController la decisión aprobada por el usuario antes de reanudar una ejecución."""
        if not isinstance(tool_decision, dict):
            return
        tool_name = tool_decision.get("toolName")
        if not isinstance(tool_name, str) or not tool_name.strip():
            return
        tool_name = tool_name.strip()
        raw_dec = tool_decision.get("decision")
        if isinstance(raw_dec, dict):
            dec_type = raw_dec.get("decision")
            raw_pattern = raw_dec.get("commandPattern")
            raw_dir_rule = raw_dec.get("directoryRule")
        else:
            dec_type = raw_dec
            raw_pattern = None
            raw_dir_rule = None
        # «Solo esta vez» no guarda nada, ni en sesión ni de forma permanente: al reanudar, el runner contesta
        # con ella el reto de esa misma llamada, que se ejecuta y se consume. Tampoco vuelve con la rotación del token.
        if not isinstance(dec_type, str) or dec_type not in AUTHORIZE_DECISIONS or dec_type == "allow_once":
            return
        pattern = normalize_command_pattern(raw_pattern) if (raw_pattern and tool_name == COMMAND_TOOL) else None
        rules = self._validate_directory_rules([raw_dir_rule]) if raw_dir_rule else []
        challenge = {
            "toolName": tool_name,
            "serverName": server_id or "mcp-proxy",
            "serverId": server_id,
        }
        self._record_decision(challenge, dec_type, pattern, rules, context)

    def create_challenge(self, tool_name: str, args: dict, decision: AccessDecision, *, context: SecurityContext,
                         server_name: str = "", server_id: str = "", origin: str = "local",
                         job_key: str | None = None, conversation_id: str = "") -> dict:
        """Genera un reto estructurado para solicitar confirmación interactiva al usuario."""
        challenge_id = f"auth_{secrets.token_urlsafe(16)}"
        now = int(time.time() * 1000)
        with self._lock:
            challenges = self._session(context).challenges
            expired = [cid for cid, c in challenges.items() if now - c.get("createdAt", 0) > CHALLENGE_TTL_MS]
            for cid in expired:
                challenges.pop(cid, None)

            challenge_data = {
                "id": challenge_id,
                "toolName": tool_name,
                "arguments": args,
                "serverName": server_name or decision.server_name,
                "serverId": server_id or decision.server_id,
                "origin": origin,
                "jobKey": job_key,
                "conversationId": conversation_id,
                "createdAt": now
            }
            challenges[challenge_id] = challenge_data
            return challenge_data

    def authorize_challenge(self, challenge_id: str, decision: str, *, context: SecurityContext,
                            command_pattern: str | None = None, directory_rule: str | None = None) -> dict | None:
        """
        Valida la decisión, consume el reto (una única ejecución) y registra la decisión.
        Devuelve el reto consumido, o None si no existe en el proyecto de la petición, caducó o la decisión
        no aplica. Una decisión mal formada lanza ValueError y deja el reto pendiente.
        """
        now = int(time.time() * 1000)
        with self._lock:
            challenges = self._session(context).challenges
            challenge = challenges.get(challenge_id)
            if not challenge:
                return None
            if now - challenge.get("createdAt", 0) > CHALLENGE_TTL_MS:
                challenges.pop(challenge_id, None)
                return None
            if decision not in AUTHORIZE_DECISIONS:
                return None
            if decision == "allow_server_always" and not challenge.get("serverId"):
                return None
            pattern = self._validate_command_pattern(decision, command_pattern, challenge)
            rules = self._validate_directory_rules([directory_rule]) if directory_rule else []
            challenges.pop(challenge_id)
        self._record_decision(challenge, decision, pattern, rules, context)
        return challenge

    def revoke_challenge(self, challenge_id: str, *, context: SecurityContext) -> bool:
        with self._lock:
            return self._session(context).challenges.pop(challenge_id, None) is not None

    @staticmethod
    def _validate_command_pattern(decision: str, raw_pattern: str | None, challenge: dict) -> str | None:
        """Patrón de una decisión sobre run_command: obligatorio para siempre o proyecto y que cubra el comando del reto."""
        is_command = challenge["toolName"] == COMMAND_TOOL
        if decision == "allow_project" and (not is_command or not raw_pattern):
            raise ValueError("allow_project_requires_command_pattern")
        if decision == "allow_always" and is_command and not raw_pattern:
            raise ValueError("allow_always_requires_command_pattern")
        if raw_pattern is None or decision not in ("allow_session", "allow_project", "allow_always"):
            return None
        if not is_command:
            raise ValueError("Solo run_command admite patrones de comando.")
        pattern = normalize_command_pattern(raw_pattern)
        command = get_command_arg(challenge["arguments"])
        if not any(matches_command_pattern(segment, pattern) for _, segment in split_command(command) or []):
            raise ValueError(f"El patrón '{pattern}' no cubre ningún subcomando de '{command}'.")
        return pattern

    def _record_decision(self, challenge: dict, decision: str, pattern: str | None, rules: list[str],
                         context: SecurityContext):
        """
        Registra la respuesta del usuario a un reto. La sesión queda en memoria; la política permanente y la
        regla de directorio se escriben en una sola transacción y un error de persistencia se propaga.
        """
        tool, server_name, server_id = challenge["toolName"], challenge["serverName"], challenge["serverId"]
        if decision == "allow_session":
            self._allow_for_session(context, tool, server_name, pattern)
        permanent = decision in ("allow_project", "allow_always", "allow_server_always")
        if not permanent and not rules:
            return
        project = context.key

        def mutator(global_state: dict, project_state: dict, _other_patterns: int) -> None:
            self._store_decision(global_state, project_state, decision, pattern, tool, server_name, server_id)
            if rules:
                base_rules = project_state["directoryRules"] if project_state["directoryRules"] is not None else [self.get_default_directory_rule(context)]
                project_state["directoryRules"] = self._append_rules(base_rules, rules)
        self._update_permanent(context, mutator)
        self._drop_superseded_session_entries(decision, pattern, tool, server_id, project, rules)

    def _allow_for_session(self, context: SecurityContext, tool: str, server_name: str, pattern: str | None):
        """«Permitir en la sesión»: el patrón de comando aprobado o, sin él, la herramienta."""
        with self._lock:
            session = self._session(context)
            if pattern:
                session.command_patterns = self._limit_patterns(
                    clean_pattern_list(session.command_patterns + [pattern], "commandPatterns.session"))
            else:
                session.tools[tool] = self._make_entry("tools", POLICY_ALLOW, SCOPE_SESSION, server_name, tool)

    def _store_decision(self, global_state: dict, project_state: dict, decision: str, pattern: str | None, tool: str,
                        server_name: str, server_id: str):
        """Guarda una decisión permanente: el patrón del proyecto o global, la herramienta o el servidor."""
        if pattern and decision == "allow_project":
            project_state["commandPatterns"] = clean_pattern_list([*project_state["commandPatterns"], pattern], "commandPatterns.project")
        elif pattern and decision == "allow_always":
            global_state["commandPatterns"] = clean_pattern_list([*global_state["commandPatterns"], pattern], "commandPatterns.global")
        elif decision == "allow_always":
            global_state["tools"][tool] = self._make_entry("tools", POLICY_ALLOW, SCOPE_PERMANENT, server_name, tool)
        elif decision == "allow_server_always":
            global_state["servers"][server_id] = self._make_entry("servers", POLICY_ALLOW, SCOPE_PERMANENT, server_name or server_id)

    def _drop_superseded_session_entries(self, decision: str, pattern: str | None, tool: str, server_id: str,
                                         project: str, rules: list[str]):
        """Lo que se acaba de guardar sustituye a lo equivalente en la sesión (las reglas de carpeta, solo en su proyecto)."""
        with self._lock:
            for key, session in self.sessions.items():
                if decision == "allow_always" and not pattern:
                    session.tools.pop(tool, None)
                elif decision == "allow_server_always":
                    session.servers.pop(server_id, None)
                if key == project and rules and session.directory_rules is not None:
                    session.directory_rules = self._append_rules(session.directory_rules, rules)

    def evaluate_authorization(self, tool_name: str, raw_args: dict | None, context: SecurityContext,
                               server_name: str = "", server_id: str = "") -> AccessDecision:
        """
        Evalúa si la invocación de una herramienta está permitida, denegada o requiere confirmación.
        Jerarquía:
        1. Lista negra explícita (deny individual o de servidor).
        2. Herramientas de control de procesos (check_command).
        3. Interruptor allowAll del proyecto -> allow incondicional.
        4. Política granular de herramienta -> allow.
        5. Política de servidor completo -> allow incondicional para sus herramientas.
        6. run_command: reglas de directorio (RWX:/** permite todo; X habilita la carpeta) y patrones de comando.
        7. Herramientas con ruta: reglas de directorio.
        8. Por defecto -> ask (solicitar confirmación), con la regla sugerida si la hay.
        """
        status, reason, details, offer = self._evaluate(tool_name, dict(raw_args or {}), context, server_id)
        return AccessDecision(allowed=status == POLICY_ALLOW, status=status, reason=reason,
                              requires_approval=status == POLICY_ASK, tool_id=tool_name, server_name=server_name,
                              server_id=server_id, details=details, rule_offer=offer)

    def _evaluate(self, tool_name: str, args: dict, ctx: SecurityContext, server_id: str) -> tuple[str, str, str, dict | None]:
        view = self._effective_state(ctx)
        tool_policy = (view["tools"].get(tool_name) or {}).get("policy")
        server_policy = (view["servers"].get(server_id) or {}).get("policy") if server_id else None
        if tool_policy == POLICY_DENY:
            return POLICY_DENY, "granular_deny_rule", "", None
        if server_policy == POLICY_DENY:
            return POLICY_DENY, "server_deny_rule", "", None
        if tool_name == JOB_CONTROL_TOOL:
            return POLICY_ALLOW, "job_control_tool", "", None
        if view["allowAll"]:
            return POLICY_ALLOW, "project_allow_all", "", None
        if tool_policy == POLICY_ALLOW:
            return POLICY_ALLOW, "granular_allow_rule", "", None
        if server_policy == POLICY_ALLOW:
            return POLICY_ALLOW, "server_allow_rule", "", None
        if tool_name == COMMAND_TOOL:
            return self._evaluate_command(get_command_arg(args), view, ctx)
        access = get_integrated_path_access(tool_name)
        path = get_path_arg(args) or ("." if tool_name in DIRECTORY_PATH_TOOLS else "")
        if access and path:
            return self._evaluate_path(tool_name, access, path, view, ctx)
        return POLICY_ASK, "mcp_default_ask", "", None

    @staticmethod
    def _full_directory_access_rule(rules: list[str], access: str = "RWX") -> str | None:
        """Primera regla sobre la raíz (/** o /) que cubre `access`, o None."""
        for raw in rules:
            parsed = parse_directory_rule(raw)
            if parsed is not None and all(ch in parsed["access"] for ch in access) and parsed["path"] in ("/**", "/"):
                return parsed["rule"]
        return None

    @classmethod
    def _has_full_directory_access(cls, rules: list[str]) -> bool:
        """Indica si el proyecto tiene acceso RWX a todo el sistema de ficheros (RWX:/** o RWX:/)."""
        return cls._full_directory_access_rule(rules, "RWX") is not None

    @staticmethod
    def _command_target(cwd: Path, raw_path: str) -> str:
        return raw_path if re.match(r"^(/|[A-Za-z]:[\\/])", raw_path) else str(cwd / raw_path)

    def _is_allowed_trust_segment(self, segment: str, cwd: Path, directory_rules: list[str], ctx: SecurityContext) -> bool:
        """Subcomando permitido por las reglas del proyecto: local o con rutas dentro de reglas RW."""
        refs = command_outside_references(segment)
        if refs is None:
            return False
        return all(
            self.evaluate_directory_rule("RW", self._command_target(cwd, ref), directory_rules, ctx)["allowed"]
            for ref in refs
        )

    def _evaluate_command(self, raw_command: str, view: dict, ctx: SecurityContext) -> tuple[str, str, str, dict | None]:
        """
        Valida cada subcomando por separado: con RWX:/** el proyecto queda sin restricción de comandos.
        En otro caso, la carpeta donde se ejecuta (inicial y tras cada cd) requiere permiso X en directoryRules;
        cada cd debe llevar a una carpeta cubierta por las reglas de directorio, y el resto tiene que estar
        cubierto por un patrón o quedarse en el proyecto o en reglas RW del proyecto (tras una tubería, solo
        un filtro).
        """
        if self._has_full_directory_access(view["directoryRules"]):
            return POLICY_ALLOW, "directory_rule_allow", "", None
        if not self.evaluate_directory_rule("X", str(ctx.workspace_dir), view["directoryRules"], ctx)["allowed"]:
            return (POLICY_ASK, "command_directory_without_execute",
                    f"La carpeta no tiene permiso de ejecución (X): {ctx.workspace_dir}", None)
        segments = split_command(raw_command)
        if segments is None:
            return (POLICY_ASK, "command_chaining_requires_approval",
                    f"El comando usa sintaxis de shell que no se puede validar por partes: {raw_command}", None)
        patterns = self._command_patterns(view)
        cwd, by_rule, uncovered = ctx.workspace_dir, False, []
        for operator, segment in segments:
            directory = cd_target(segment)
            if directory is not None:
                target = self._command_target(cwd, directory)
                if not any(self.evaluate_directory_rule(a, target, view["directoryRules"], ctx)["allowed"] for a in ("R", "W", "X")):
                    return (POLICY_ASK, "command_directory_outside_rules",
                            f"El comando se ejecuta fuera de las reglas de directorio: {directory}", None)
                cwd = ctx.resolve_path(target) or cwd
                if not self.evaluate_directory_rule("X", str(cwd), view["directoryRules"], ctx)["allowed"]:
                    return (POLICY_ASK, "command_directory_without_execute",
                            f"La carpeta no tiene permiso de ejecución (X): {cwd}", None)
            elif any(matches_command_pattern(segment, p) for p in patterns):
                continue
            elif self._is_allowed_trust_segment(segment, cwd, view["directoryRules"], ctx) and (
                    operator != "|" or segment.split()[0] in WORKSPACE_TRUST_PIPE_FILTERS):
                by_rule = True
            else:
                uncovered.append(segment)
        if not uncovered:
            return POLICY_ALLOW, "directory_rule_allow" if by_rule else "command_pattern_allow", "", None
        reason, details = (
            ("command_outside_allowed_patterns", f"Comando fuera de los patrones autorizados: {'; '.join(uncovered)}")
            if patterns
            else ("command_outside_directory_rules", "El comando accede a recursos globales o rutas fuera de las reglas de directorio.")
        )
        return POLICY_ASK, reason, details, command_rule_offer(uncovered)

    def _evaluate_path(self, tool_name: str, access: str, path: str, view: dict, ctx: SecurityContext) -> tuple[str, str, str, dict | None]:
        """Herramientas integradas de ficheros: reglas de directorio del proyecto."""
        dir_eval = self.evaluate_directory_rule(access, path, view["directoryRules"], ctx)
        if dir_eval["allowed"]:
            return POLICY_ALLOW, "directory_rule_allow", "", None
        return (POLICY_ASK, "directory_rule_required", f"La ruta no coincide con una regla {access}: {path}",
                directory_rule_offer(tool_name, access, dir_eval["path"] or path))


ACCESS_CONTROLLER = AccessController()
