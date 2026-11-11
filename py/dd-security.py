# ==============================================================================
# Motor de Control de Acceso y Seguridad de Herramientas (AccessController)
# ==============================================================================

GLOBAL_POLICY_ASK = "ask"
GLOBAL_POLICY_ALLOW_ALL = "allow_all"
GLOBAL_POLICY_WORKSPACE_TRUST = "workspace_trust"
GLOBAL_POLICIES = (GLOBAL_POLICY_ASK, GLOBAL_POLICY_ALLOW_ALL, GLOBAL_POLICY_WORKSPACE_TRUST)

POLICY_ALLOW = "allow"
POLICY_DENY = "deny"
POLICY_ASK = "ask"
POLICIES = (POLICY_ALLOW, POLICY_DENY, POLICY_ASK)

SCOPE_PERMANENT = "permanent"
SCOPE_SESSION = "session"
SCOPES = (SCOPE_PERMANENT, SCOPE_SESSION)

POLICY_STATE_VERSION = 5
CHALLENGE_TTL_MS = 600_000
AUTHORIZE_DECISIONS = ("allow_once", "allow_session", "allow_always", "allow_server_always")
MAX_POLICY_ENTRIES = 500

DIRECTORY_RULE_PATTERN = re.compile(r"^(R|W|RW):(.+)$")
COMMAND_TOOL = "run_command"
JOB_CONTROL_TOOL = "check_command"

SAFE_REDIRECTION_PATTERN = re.compile(r"&>\s*/dev/null|\d?>>?\s*/dev/null|\d?>&\d")

WORKSPACE_TRUST_PIPE_FILTERS = frozenset([
    "head", "tail", "grep", "egrep", "fgrep", "rg", "wc", "sort", "uniq", "cut", "tr", "column", "nl", "cat", "jq"
])
WORKSPACE_TRUST_GLOBAL_COMMANDS = re.compile(r"(?:^|\s)(?:sudo|su|doas|mkfs|reboot|shutdown|systemctl)\b")
WORKSPACE_TRUST_OUTSIDE_REFERENCE = re.compile(r"(?:^|[\s=:'\"])(?:[\\/~]|[A-Za-z]:[\\/])|\$|(?:^|[\s=:'\"\\/])\.\.(?=[\s\\/'\"]|$)")


@dataclasses.dataclass
class SecurityContext:
    """Contexto de seguridad desacoplado para ejecuciones o sesiones."""
    workspace_dir: Path = dataclasses.field(default_factory=lambda: Path.cwd().resolve())

    def resolve_path(self, path_str: str) -> Path | None:
        """Resuelve una ruta relativa al espacio de trabajo. Rechaza referencias no resueltas."""
        if not isinstance(path_str, str) or contains_unresolved_reference(path_str):
            return None
        norm = normalize_directory_path(path_str)
        if not norm:
            return None
        try:
            target = Path(norm)
            if not target.is_absolute():
                target = (self.workspace_dir / target).resolve(strict=False)
            else:
                target = target.resolve(strict=False)
            return target
        except (ValueError, RuntimeError, OSError):
            return None

    def is_inside_workspace(self, path_str: str) -> bool:
        """Determina si la ruta reside estrictamente dentro del espacio de trabajo del contexto."""
        resolved = self.resolve_path(path_str)
        if resolved is None:
            return False
        try:
            resolved.relative_to(self.workspace_dir.resolve())
            return True
        except ValueError:
            return False


def contains_unresolved_reference(value: str) -> bool:
    """Detecta variables de entorno ($VAR, ${VAR}) o expansiones de usuario (~)."""
    if not isinstance(value, str):
        return False
    trimmed = value.strip()
    if not trimmed:
        return False
    if trimmed.startswith("~"):
        return True
    return bool(re.search(r"\$(?:\{[^}]+\}|[A-Za-z_][A-Za-z0-9_]*)", trimmed))


def normalize_directory_path(value: str) -> str:
    """Normaliza rutas posix/windows colapsando . y .. de forma determinista."""
    if not isinstance(value, str) or not value.strip() or "\0" in value:
        return ""
    if contains_unresolved_reference(value):
        return ""
    trimmed = value.strip().replace("\\", "/")
    is_absolute = bool(re.match(r"^(/|[A-Za-z]:/?)", trimmed))
    parts = []
    for part in trimmed.split("/"):
        if not part or part == ".":
            continue
        if part == "..":
            if parts:
                parts.pop()
            else:
                return ""
        else:
            parts.append(part)
    prefix = "/" if trimmed.startswith("/") else ""
    joined = "/".join(parts)
    if is_absolute and not joined.startswith("/") and not re.match(r"^[A-Za-z]:", joined):
        joined = prefix + joined
    return joined or (prefix or ".")


def parse_directory_rule(raw_rule: str) -> dict | None:
    """Parsea una regla 'R:path', 'W:path' o 'RW:path' normalizando su ruta."""
    if not isinstance(raw_rule, str):
        return None
    match = DIRECTORY_RULE_PATTERN.match(raw_rule.strip())
    if not match:
        return None
    access = match.group(1)
    raw_path = match.group(2)
    path = normalize_directory_path(raw_path)
    if not path:
        return None
    return {"access": access, "path": path, "rule": f"{access}:{path}"}


def matches_directory_pattern(path: str, pattern: str) -> bool:
    """Comprueba si una ruta cumple un patrón con soporte para /** y prefijos."""
    if pattern.endswith("/**") and path == pattern[:-3]:
        return True
    if "*" not in pattern:
        if path == pattern:
            return True
        prefix = pattern if pattern.endswith("/") else f"{pattern}/"
        if path.startswith(prefix):
            return True
    escaped = re.escape(pattern).replace(r"\*\*\/", ".*").replace(r"\*\*", ".*").replace(r"\*", "[^/]*")
    return bool(re.fullmatch(escaped, path))


def has_command_chaining(cmd: str) -> bool:
    """Detecta sintaxis de shell que encadena o bifurca ejecuciones."""
    if not isinstance(cmd, str):
        return False
    return bool(re.search(r"[;\n\r`]|&&|\|\||\$\(|[<>]\(", cmd) or re.search(r"(?<!>|\d)&(?!\d|>)", cmd))


def has_file_redirection(cmd: str) -> bool:
    """Detecta redirecciones a ficheros no seguras."""
    if not isinstance(cmd, str):
        return False
    sanitized = SAFE_REDIRECTION_PATTERN.sub(" ", cmd)
    return bool(re.search(r"[<>]", sanitized))


def split_leading_cd(cmd: str) -> dict | None:
    """Separa un comando inicial 'cd <dir> && <cmd>'."""
    if not isinstance(cmd, str):
        return None
    match = re.match(r"^cd\s+(\"[^\"]*\"|'[^']*'|[^\s;&|<>`$()'\"]+)\s*&&\s*(\S[\s\S]*)$", cmd.strip())
    if not match:
        return None
    raw_dir = match.group(1).strip()
    if (raw_dir.startswith('"') and raw_dir.endswith('"')) or (raw_dir.startswith("'") and raw_dir.endswith("'")):
        clean_dir = raw_dir[1:-1]
    else:
        clean_dir = raw_dir
    return {"directory": clean_dir, "command": match.group(2).strip()}


def get_command_base_name(cmd: str) -> str:
    """Devuelve el nombre del ejecutable principal omitiendo 'cd <dir> &&'."""
    trimmed = str(cmd or "").strip()
    cd_part = split_leading_cd(trimmed)
    command_str = cd_part["command"] if cd_part else trimmed
    tokens = command_str.split()
    return tokens[0] if tokens else ""


def get_command_arg(args: dict | None) -> str:
    """Extrae el argumento de comando con soporte de alias habituales."""
    if not isinstance(args, dict):
        return ""
    val = args.get("command") or args.get("cmd") or args.get("script") or ""
    return str(val).strip()


def get_path_arg(args: dict | None) -> str:
    """Extrae la ruta con soporte de alias habituales."""
    if not isinstance(args, dict):
        return ""
    val = args.get("path") or args.get("filepath") or args.get("file") or args.get("directory") or args.get("dir") or ""
    return str(val).strip() if isinstance(val, str) else ""


def get_integrated_path_access(tool_name: str) -> str:
    """Clasifica el tipo de acceso al sistema de archivos ('R' o 'W') de herramientas core."""
    if tool_name in ("read_file", "list_directory", "search_files", "get_diagnostics"):
        return "R"
    if tool_name in ("edit_file", "write_file"):
        return "W"
    return ""


def is_workspace_local_command(cmd: str) -> bool:
    """Filtro de seguridad para la política workspace_trust."""
    if not cmd or has_command_chaining(cmd) or has_file_redirection(cmd):
        return False
    piped_stages = cmd.split("|")[1:]
    for stage in piped_stages:
        first_token = stage.strip().split()[0] if stage.strip().split() else ""
        if first_token not in WORKSPACE_TRUST_PIPE_FILTERS:
            return False
    return not WORKSPACE_TRUST_GLOBAL_COMMANDS.search(cmd) and not WORKSPACE_TRUST_OUTSIDE_REFERENCE.search(cmd)


def matches_command_prefix(command: str, prefix: str) -> bool:
    """Verifica si un comando cumple un prefijo autorizado."""
    clean_prefix = str(prefix).rstrip("*").strip()
    if not clean_prefix:
        return False
    prefixes = [
        clean_prefix,
        f"/usr/bin/{clean_prefix}",
        f"/bin/{clean_prefix}",
        f"/usr/local/bin/{clean_prefix}"
    ]
    for p in prefixes:
        if command == p:
            return True
        if p.endswith("/") and command.startswith(p):
            return True
        if command.startswith(f"{p} ") or command.startswith(f"{p}\t"):
            return True
    return False


def evaluate_command_constraint(cmd_val: str, command_constraints: dict) -> tuple[bool, bool, str, str]:
    """Evalúa restricciones granulares de comando (encadenamiento, patrones prohibidos y prefijos)."""
    if not cmd_val or not isinstance(cmd_val, str) or not isinstance(command_constraints, dict):
        return True, False, "", ""
    trimmed = cmd_val.strip()
    cd_part = split_leading_cd(trimmed)
    command = cd_part["command"] if cd_part else trimmed

    if command_constraints.get("allowChaining") is not True:
        has_unauthorized_pipe = (command_constraints.get("allowPipes") is not True) and ("|" in command)
        if has_command_chaining(command) or has_file_redirection(command) or has_unauthorized_pipe:
            return False, False, "command_chaining_requires_approval", f"Comando contiene encadenamiento no autorizado: {trimmed}"

    denied_patterns = command_constraints.get("deniedPatterns")
    if isinstance(denied_patterns, (list, tuple)):
        for pattern in denied_patterns:
            if isinstance(pattern, str) and pattern in trimmed:
                return False, True, "command_matches_denied_pattern", f"The command contains a blocked pattern ({pattern}): {trimmed}"

    allowed_prefixes = command_constraints.get("allowedPrefixes")
    if isinstance(allowed_prefixes, (list, tuple)) and len(allowed_prefixes) > 0:
        matched = any(matches_command_prefix(command, p) for p in allowed_prefixes if isinstance(p, str))
        if not matched:
            return False, False, "command_outside_allowed_prefixes", f"Comando fuera de los prefijos autorizados: {trimmed}"

    return True, False, "", ""


def get_rule_offer(tool_name: str, args: dict, auth_eval: dict | None = None) -> dict | None:
    """Genera la regla sugerida para confirmaciones permanentes en la interfaz."""
    eval_info = auth_eval or {}
    command = get_command_arg(args)
    if command and not eval_info.get("directoryAccess"):
        base_name = get_command_base_name(command)
        if not base_name:
            return None
        return {
            "type": "command",
            "command": base_name,
            "constraints": {
                "command": {"allowedPrefixes": [base_name], "allowChaining": False, "allowPipes": False}
            }
        }
    path = eval_info.get("directoryPath") or get_path_arg(args)
    if not path or not normalize_directory_path(path):
        return None
    access = eval_info.get("directoryAccess") or ("W" if re.search(r"(?:^|_)(?:edit|write)_file$", tool_name) else "R")
    clean_path = path.replace("\\", "/").rstrip("/")
    if re.search(r"(?:^|_)list_directory$", tool_name):
        folder = clean_path
    else:
        folder = clean_path[:clean_path.rfind("/")] if "/" in clean_path else "."
    dir_path = folder or "/"
    pattern = f"{access}:{dir_path}" if dir_path == "/" else f"{access}:{dir_path}/**"
    return {"type": "directory", "access": access, "directoryRule": pattern}


@dataclasses.dataclass
class AccessDecision:
    """Resultado formal de la evaluación de una llamada a herramienta."""
    allowed: bool
    status: str
    reason: str
    requires_approval: bool = False
    tool_id: str = ""
    server_name: str = ""
    server_id: str = ""
    original_name: str = ""
    details: str = ""
    rule_offer: dict | None = None

    def to_dict(self) -> dict:
        return {
            "allowed": self.allowed,
            "status": self.status,
            "reason": self.reason,
            "requiresApproval": self.requires_approval,
            "toolId": self.tool_id,
            "serverName": self.server_name,
            "serverId": self.server_id,
            "originalName": self.original_name,
            "details": self.details,
            "ruleOffer": self.rule_offer
        }


class AccessController:
    """Motor de control de acceso y autorización del backend (PDP/PEP)."""

    def __init__(self):
        self._lock = threading.RLock()
        self.session_global_policy: str | None = None
        self.session_directory_rules: list[str] | None = None
        self.session_tools: dict[str, dict] = {}
        self.session_servers: dict[str, dict] = {}
        self.pending_challenges: dict[str, dict] = {}

    @staticmethod
    def _normalize_state(raw: dict | None) -> dict:
        """Única definición del estado permanente y de sus valores por defecto."""
        data = raw if isinstance(raw, dict) else {}
        return {
            "version": POLICY_STATE_VERSION,
            "globalMcpPolicy": data.get("globalMcpPolicy") or GLOBAL_POLICY_ASK,
            "directoryRules": list(data.get("directoryRules") or []),
            "tools": dict(data.get("tools") or {}),
            "servers": dict(data.get("servers") or {})
        }

    def _read_permanent_state(self) -> dict:
        """Lee el estado permanente de SQLite; un fallo de lectura se propaga al llamador."""
        return self._normalize_state(get_security_policy_data())

    def _update_permanent(self, mutator: typing.Callable[[dict], dict]) -> dict:
        """Lectura-modificación-escritura transaccional sobre el estado permanente normalizado."""
        return update_security_policy_data(lambda raw: mutator(self._normalize_state(raw)))

    def _effective_state(self) -> dict:
        """Una sola lectura del estado permanente combinada con la capa de sesión en memoria."""
        state = self._read_permanent_state()
        with self._lock:
            return {
                "globalMcpPolicy": self.session_global_policy if self.session_global_policy is not None else state["globalMcpPolicy"],
                "directoryRules": list(self.session_directory_rules) if self.session_directory_rules is not None else state["directoryRules"],
                "tools": {**state["tools"], **self.session_tools},
                "servers": {**state["servers"], **self.session_servers}
            }

    @property
    def global_policy(self) -> str:
        return self._effective_state()["globalMcpPolicy"]

    @global_policy.setter
    def global_policy(self, policy: str):
        self.set_global_policy(policy)

    @property
    def tools(self) -> dict[str, dict]:
        return self._read_permanent_state()["tools"]

    @property
    def servers(self) -> dict[str, dict]:
        return self._read_permanent_state()["servers"]

    @property
    def directory_rules(self) -> list[str]:
        return self._read_permanent_state()["directoryRules"]

    def export_state(self, context: SecurityContext | None = None) -> dict:
        return {
            "version": POLICY_STATE_VERSION,
            **self._effective_state(),
            "defaultDirectoryRule": self.get_default_directory_rule(context)
        }

    def _validate_directory_rules(self, raw_rules: list | tuple, context: SecurityContext | None = None) -> list[str]:
        if not isinstance(raw_rules, (list, tuple)):
            raise ValueError("Las reglas de directorio deben ser una lista.")
        parsed_rules = []
        for raw in raw_rules:
            rule_obj = parse_directory_rule(raw)
            if not rule_obj:
                raise ValueError(f"Regla de directorio inválida: '{raw}'. Formato esperado: R:path, W:path o RW:path.")
            parsed_rules.append(rule_obj["rule"])
        unique_rules = list(dict.fromkeys(parsed_rules))
        default_rule = self.get_default_directory_rule(context)
        return [r for r in unique_rules if r != default_rule]

    @staticmethod
    def _validate_policy_entries(raw_entries: dict, kind: str, scope: str) -> dict:
        kind_desc = "herramientas" if kind == "tools" else "servidores"
        kind_label = "la herramienta" if kind == "tools" else "el servidor"
        if not isinstance(raw_entries, dict):
            raise ValueError(f"{kind} debe ser un diccionario de {kind_desc}.")
        clean_map = {}
        for item_id, entry in raw_entries.items():
            clean_key = str(item_id).strip() if kind == "servers" else str(item_id)
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
            constraints = entry.get("constraints")
            if constraints is not None and not isinstance(constraints, dict):
                raise ValueError(f"constraints para {kind_label} '{item_id}' debe ser un diccionario o None.")
            clean_map[clean_key] = AccessController._make_entry(
                kind, pol, scope,
                server_name=str(entry.get("serverName", "") or ""),
                original_name=str(entry.get("originalName", "") or ""),
                constraints=constraints
            )
        return clean_map

    @staticmethod
    def _make_entry(kind: str, policy: str, scope: str, server_name: str = "", original_name: str = "",
                    constraints: dict | None = None) -> dict:
        """Única forma de una entrada de política de herramienta o servidor."""
        entry = {
            "policy": policy,
            "scope": scope,
            "grantedAt": int(time.time() * 1000),
            "serverName": server_name
        }
        if kind == "tools":
            entry["originalName"] = original_name
            entry["constraints"] = constraints
        return entry

    def _session_map(self, kind: str) -> dict[str, dict]:
        return self.session_tools if kind == "tools" else self.session_servers

    def _set_session_entry(self, kind: str, item_id: str, entry: dict):
        with self._lock:
            self._session_map(kind)[item_id] = entry

    @staticmethod
    def _check_entry_limit(state: dict):
        total = len(state.get("directoryRules") or []) + len(state.get("tools") or {}) + len(state.get("servers") or {})
        if total > MAX_POLICY_ENTRIES:
            raise ValueError(f"El número total de entradas ({total}) supera el máximo permitido ({MAX_POLICY_ENTRIES}).")

    def _validate_state_payload(self, state: dict, scope: str, context: SecurityContext | None = None) -> tuple[str | None, list[str] | None, dict | None, dict | None]:
        if not isinstance(state, dict):
            raise ValueError("El estado de políticas debe ser un diccionario.")

        clean_global = None
        if "globalMcpPolicy" in state:
            pol = state["globalMcpPolicy"]
            if pol not in GLOBAL_POLICIES:
                raise ValueError(f"Política global no válida: '{pol}'. Válidas: {GLOBAL_POLICIES}")
            clean_global = pol

        clean_rules = None
        if "directoryRules" in state:
            clean_rules = self._validate_directory_rules(state["directoryRules"], context)

        clean_tools = None
        if "tools" in state:
            clean_tools = self._validate_policy_entries(state["tools"], "tools", scope)

        clean_servers = None
        if "servers" in state:
            clean_servers = self._validate_policy_entries(state["servers"], "servers", scope)

        total_entries = (len(clean_rules) if clean_rules is not None else 0) + \
                        (len([e for e in clean_tools.values() if e is not None]) if clean_tools is not None else 0) + \
                        (len([e for e in clean_servers.values() if e is not None]) if clean_servers is not None else 0)
        if total_entries > MAX_POLICY_ENTRIES:
            raise ValueError(f"El número total de entradas ({total_entries}) supera el máximo permitido ({MAX_POLICY_ENTRIES}).")
        return clean_global, clean_rules, clean_tools, clean_servers

    def import_state(self, state: dict, context: SecurityContext | None = None, persist: bool = True):
        if not persist:
            return self.apply_session_overlay(state, context=context)

        clean_global, clean_rules, clean_tools, clean_servers = self._validate_state_payload(state, SCOPE_PERMANENT, context)

        def mutator(current: dict) -> dict:
            if clean_global is not None:
                current["globalMcpPolicy"] = clean_global
            if clean_rules is not None:
                current["directoryRules"] = clean_rules
            if clean_tools is not None:
                current["tools"] = self._apply_entry_patch(current.get("tools"), clean_tools)
            if clean_servers is not None:
                current["servers"] = self._apply_entry_patch(current.get("servers"), clean_servers)
            self._check_entry_limit(current)
            return current
        self._update_permanent(mutator)
        with self._lock:
            if clean_global is not None:
                self.session_global_policy = None
            if clean_rules is not None:
                self.session_directory_rules = None
            if clean_tools is not None:
                for tool_id in clean_tools:
                    self.session_tools.pop(tool_id, None)
            if clean_servers is not None:
                for srv_id in clean_servers:
                    self.session_servers.pop(srv_id, None)
        return self.export_state(context)

    @staticmethod
    def _apply_entry_patch(current: dict | None, patch: dict) -> dict:
        """Aplica un parche de entradas (None revoca); conserva grantedAt si la concesión no cambia."""
        result = dict(current or {})
        for item_id, entry in patch.items():
            if entry is None:
                result.pop(item_id, None)
                continue
            previous = result.get(item_id) or {}
            same_grant = previous.get("policy") == entry["policy"] and previous.get("constraints") == entry.get("constraints")
            result[item_id] = {**entry, "grantedAt": previous["grantedAt"]} if same_grant and previous.get("grantedAt") else entry
        return result

    def apply_session_overlay(self, state: dict, context: SecurityContext | None = None):
        """Aplica una capa de políticas temporal en memoria para una ejecución en servidor, sin persistir."""
        clean_global, clean_rules, clean_tools, clean_servers = self._validate_state_payload(state, SCOPE_SESSION, context)

        with self._lock:
            if clean_global is not None:
                self.session_global_policy = clean_global
            if clean_rules is not None:
                self.session_directory_rules = clean_rules
            if clean_tools is not None:
                self.session_tools = self._apply_entry_patch(self.session_tools, clean_tools)
            if clean_servers is not None:
                self.session_servers = self._apply_entry_patch(self.session_servers, clean_servers)
        return self.export_state(context)

    def set_global_policy(self, policy: str, context: SecurityContext | None = None):
        if policy not in GLOBAL_POLICIES:
            raise ValueError(f"Política global inválida: {policy}")
        def mutator(state: dict) -> dict:
            state["globalMcpPolicy"] = policy
            return state
        self._update_permanent(mutator)
        with self._lock:
            self.session_global_policy = None

    def get_default_directory_rule(self, context: SecurityContext | None = None) -> str:
        ctx = context or SecurityContext()
        base = normalize_directory_path(str(ctx.workspace_dir))
        return f"RW:{base}" if base == "/" else f"RW:{base}/**"

    def get_directory_rules(self, context: SecurityContext | None = None) -> list[str]:
        return self._effective_state()["directoryRules"]

    def set_directory_rules(self, rules: list[str], context: SecurityContext | None = None, persist: bool = True) -> list[str]:
        clean_rules = self._validate_directory_rules(rules, context)
        if persist:
            def mutator(state: dict) -> dict:
                state["directoryRules"] = clean_rules
                return state
            self._update_permanent(mutator)
            with self._lock:
                self.session_directory_rules = None
        return clean_rules

    def add_directory_rule(self, rule: str, context: SecurityContext | None = None) -> list[str]:
        current = self.get_directory_rules(context)
        return self.set_directory_rules(current + [rule], context)

    @staticmethod
    def _resolve_rule_pattern(pattern: str, workspace_dir: Path | None = None) -> str:
        base, sep, rest = pattern.partition("*")
        if base:
            target = os.path.join(str(workspace_dir), base) if (workspace_dir and not os.path.isabs(base)) else base
            real_base = normalize_directory_path(os.path.realpath(target))
            if sep and base.endswith("/") and not real_base.endswith("/"):
                real_base += "/"
        else:
            real_base = ""
        return f"{real_base}{sep}{rest}"

    def evaluate_directory_rule(self, access: str, path: str, user_rules: list[str],
                                context: SecurityContext | None = None) -> dict:
        ctx = context or SecurityContext()
        resolved_target = ctx.resolve_path(path)
        if resolved_target is None:
            return {"allowed": False, "rule": None, "path": ""}
        normalized_dest = normalize_directory_path(str(resolved_target))
        if not normalized_dest:
            return {"allowed": False, "rule": None, "path": ""}

        matching_user_rules = []
        for raw_rule in user_rules:
            parsed = parse_directory_rule(raw_rule)
            if not parsed:
                continue
            rule_pattern = self._resolve_rule_pattern(parsed["path"], ctx.workspace_dir)
            if matches_directory_pattern(normalized_dest, rule_pattern):
                matching_user_rules.append(parsed)

        for parsed in matching_user_rules:
            if parsed["access"] == access or parsed["access"] == "RW":
                return {"allowed": True, "rule": parsed["rule"], "path": normalized_dest}

        if matching_user_rules:
            return {"allowed": False, "rule": None, "path": normalized_dest}

        default_rule = self.get_default_directory_rule(ctx)
        default_parsed = parse_directory_rule(default_rule)
        if default_parsed and (default_parsed["access"] == access or default_parsed["access"] == "RW"):
            rule_pattern = self._resolve_rule_pattern(default_parsed["path"], ctx.workspace_dir)
            if matches_directory_pattern(normalized_dest, rule_pattern):
                return {"allowed": True, "rule": default_parsed["rule"], "path": normalized_dest}
        return {"allowed": False, "rule": None, "path": normalized_dest}

    def evaluate_command_directories(self, args: dict, user_rules: list[str], context: SecurityContext | None = None) -> dict:
        cmd_arg = get_command_arg(args)
        cd_part = split_leading_cd(cmd_arg)
        if not cd_part:
            return {"allowed": True, "directory": None}
        target_dir = cd_part["directory"]
        read_eval = self.evaluate_directory_rule("R", target_dir, user_rules, context)
        write_eval = self.evaluate_directory_rule("W", target_dir, user_rules, context)
        allowed = read_eval["allowed"] or write_eval["allowed"]
        return {"allowed": allowed, "directory": target_dir}

    def _set_policy(self, kind: str, item_id: str, policy: str, scope: str = SCOPE_PERMANENT,
                    server_name: str = "", original_name: str = "", constraints: dict | None = None):
        if not item_id or not isinstance(item_id, str):
            return
        clean_id = item_id.strip() if kind == "servers" else item_id
        if not clean_id:
            return
        clean_policy = policy if policy in (POLICY_ALLOW, POLICY_DENY) else POLICY_ASK
        if clean_policy == POLICY_ASK:
            self._revoke_policy(kind, clean_id)
            return
        clean_scope = scope if scope in SCOPES else SCOPE_PERMANENT
        entry = self._make_entry(kind, clean_policy, clean_scope, server_name=server_name,
                                 original_name=original_name or clean_id, constraints=constraints)
        if clean_scope == SCOPE_SESSION:
            self._set_session_entry(kind, clean_id, entry)
            return
        def mutator(state: dict) -> dict:
            state.setdefault(kind, {})[clean_id] = entry
            self._check_entry_limit(state)
            return state
        self._update_permanent(mutator)
        with self._lock:
            self._session_map(kind).pop(clean_id, None)

    def _get_policy(self, kind: str, item_id: str) -> dict | None:
        clean_id = str(item_id or "").strip() if kind == "servers" else str(item_id or "")
        if not clean_id:
            return None
        return self._effective_state()[kind].get(clean_id)

    def _revoke_policy(self, kind: str, item_id: str) -> bool:
        clean_id = str(item_id or "").strip() if kind == "servers" else str(item_id or "")
        if not clean_id:
            return False
        with self._lock:
            del_session = self._session_map(kind).pop(clean_id, None) is not None
        del_perm = [False]
        def mutator(state: dict) -> dict:
            container = state.get(kind, {})
            if clean_id in container:
                del container[clean_id]
                del_perm[0] = True
            return state
        self._update_permanent(mutator)
        return del_session or del_perm[0]

    def set_tool_policy(self, tool_id: str, policy: str, scope: str = SCOPE_PERMANENT,
                        constraints: dict | None = None, server_name: str = "", original_name: str = ""):
        self._set_policy("tools", tool_id, policy, scope=scope, server_name=server_name,
                         original_name=original_name, constraints=constraints)

    def get_tool_policy(self, tool_id: str) -> dict | None:
        return self._get_policy("tools", tool_id)

    def revoke_tool_policy(self, tool_id: str) -> bool:
        return self._revoke_policy("tools", tool_id)

    def set_server_policy(self, server_id: str, policy: str, scope: str = SCOPE_PERMANENT, server_name: str = ""):
        self._set_policy("servers", server_id, policy, scope=scope,
                         server_name=server_name or str(server_id or "").strip())

    def get_server_policy(self, server_id: str) -> dict | None:
        return self._get_policy("servers", server_id)

    def revoke_server_policy(self, server_id: str) -> bool:
        return self._revoke_policy("servers", server_id)

    def clear_session(self):
        """Limpia todas las autorizaciones temporales de la sesión activa."""
        with self._lock:
            self.session_global_policy = None
            self.session_directory_rules = None
            self.session_tools.clear()
            self.session_servers.clear()
            self.pending_challenges.clear()

    def create_challenge(self, tool_name: str, args: dict, decision: AccessDecision,
                         server_name: str = "", server_id: str = "", origin: str = "local",
                         context: SecurityContext | None = None) -> dict:
        """Genera un reto estructurado para solicitar confirmación interactiva al usuario."""
        challenge_id = f"auth_{secrets.token_urlsafe(16)}"
        now = int(time.time() * 1000)
        cwd = str((context.workspace_dir if context else Path.cwd()).resolve())
        with self._lock:
            expired = [cid for cid, c in self.pending_challenges.items() if now - c.get("createdAt", 0) > CHALLENGE_TTL_MS]
            for cid in expired:
                self.pending_challenges.pop(cid, None)

            dec_dict = decision.to_dict()
            resolved_server_id = server_id or dec_dict.get("serverId", "")
            dec_dict["serverId"] = resolved_server_id
            challenge_data = {
                "id": challenge_id,
                "toolName": tool_name,
                "arguments": args,
                "decision": dec_dict,
                "serverName": server_name or dec_dict.get("serverName", ""),
                "serverId": resolved_server_id,
                "origin": origin,
                "cwd": cwd,
                "createdAt": now
            }
            self.pending_challenges[challenge_id] = challenge_data
            return challenge_data

    def authorize_challenge(self, challenge_id: str, decision: str,
                            constraints: dict | None = None, directory_rule: str | None = None,
                            context: SecurityContext | None = None) -> dict | None:
        """
        Valida la decisión, consume el reto (una única ejecución) y registra la decisión.
        Devuelve el reto consumido, o None si no existe, caducó, cambió el cwd o la decisión no aplica.
        Una decisión mal formada lanza ValueError y deja el reto pendiente.
        """
        now = int(time.time() * 1000)
        current_cwd = str((context.workspace_dir if context else Path.cwd()).resolve())
        dec_payload = {"decision": decision, "constraints": constraints, "directoryRule": directory_rule}
        with self._lock:
            challenge = self.pending_challenges.get(challenge_id)
            if not challenge:
                return None
            if now - challenge.get("createdAt", 0) > CHALLENGE_TTL_MS or challenge.get("cwd") != current_cwd:
                self.pending_challenges.pop(challenge_id, None)
                return None
            if decision not in AUTHORIZE_DECISIONS:
                return None
            if decision == "allow_server_always" and not challenge.get("serverId"):
                return None
            self._validate_decision(dec_payload, challenge["toolName"], context)
            self.pending_challenges.pop(challenge_id)
        self.record_decision(dec_payload, challenge["decision"], fallback_tool_name=challenge["toolName"], context=context)
        return challenge

    def revoke_challenge(self, challenge_id: str) -> bool:
        with self._lock:
            return self.pending_challenges.pop(challenge_id, None) is not None

    def _validate_decision(self, decision: dict, tool_name: str, context: SecurityContext | None = None) -> list[str]:
        """Valida restricciones y regla de una decisión sin persistir nada; devuelve las reglas nuevas limpias."""
        constraints = decision.get("constraints")
        if constraints is not None and not isinstance(constraints, dict):
            raise ValueError("constraints debe ser un diccionario o None.")
        if decision.get("decision") == "allow_always" and tool_name == COMMAND_TOOL and not (constraints or {}).get("command"):
            raise ValueError("allow_always_requires_constraints")
        rule = decision.get("directoryRule")
        return self._validate_directory_rules([rule], context) if rule else []

    @staticmethod
    def merge_command_constraints(existing_constraints: dict | None, requested: dict | None) -> dict | None:
        """Combina restricciones granulares existentes con nuevas solicitadas."""
        if not requested or not isinstance(requested, dict):
            return existing_constraints
        if not requested.get("command"):
            return requested
        req_cmd = requested["command"]
        ext_cmd = existing_constraints.get("command") if (existing_constraints and isinstance(existing_constraints, dict)) else {}

        raw_prefixes = list(ext_cmd.get("allowedPrefixes") or []) + list(req_cmd.get("allowedPrefixes") or [])
        seen = set()
        merged_prefixes = []
        for p in raw_prefixes:
            if isinstance(p, str) and p.strip() and p.strip() not in seen:
                seen.add(p.strip())
                merged_prefixes.append(p.strip())

        def grants(key: str) -> bool:
            return req_cmd.get(key) is True and (not ext_cmd or ext_cmd.get(key) is True)

        merged_cmd = {
            **ext_cmd,
            **req_cmd,
            "allowedPrefixes": merged_prefixes if merged_prefixes else None,
            "allowChaining": grants("allowChaining"),
            "allowPipes": grants("allowPipes")
        }
        return {"command": merged_cmd}

    def record_decision(self, decision: dict, auth_eval: dict,
                        fallback_tool_name: str = "", context: SecurityContext | None = None):
        """
        Registra la respuesta del usuario a un reto. La política permanente y la regla de directorio
        se escriben en una sola transacción; un error de validación o de persistencia se propaga.
        """
        decision_type = decision.get("decision", "")
        target_tool = auth_eval.get("toolId") or fallback_tool_name
        server_name = auth_eval.get("serverName", "")
        new_rules = self._validate_decision(decision, target_tool, context)

        if decision_type == "allow_session":
            self._set_session_entry("tools", target_tool, self._make_entry(
                "tools", POLICY_ALLOW, SCOPE_SESSION, server_name=server_name,
                original_name=auth_eval.get("originalName", "") or target_tool))

        permanent_kind, permanent_id = None, ""
        if decision_type == "allow_always":
            permanent_kind, permanent_id = "tools", target_tool
        elif decision_type == "allow_server_always":
            permanent_kind, permanent_id = "servers", auth_eval.get("serverId") or ""
            if not permanent_id:
                raise ValueError("allow_server_always requiere un servidor externo válido.")
        if not permanent_kind and not new_rules:
            return

        def mutator(state: dict) -> dict:
            if permanent_kind == "tools":
                existing = (state.get("tools") or {}).get(target_tool) or {}
                constraints = self.merge_command_constraints(existing.get("constraints"), decision.get("constraints"))
                state.setdefault("tools", {})[target_tool] = self._make_entry(
                    "tools", POLICY_ALLOW, SCOPE_PERMANENT, server_name=server_name,
                    original_name=auth_eval.get("originalName", "") or target_tool, constraints=constraints)
            elif permanent_kind == "servers":
                state.setdefault("servers", {})[permanent_id] = self._make_entry(
                    "servers", POLICY_ALLOW, SCOPE_PERMANENT, server_name=server_name or permanent_id)
            if new_rules:
                state["directoryRules"] = list(dict.fromkeys(list(state.get("directoryRules") or []) + new_rules))
            self._check_entry_limit(state)
            return state
        self._update_permanent(mutator)
        with self._lock:
            if permanent_kind:
                self._session_map(permanent_kind).pop(permanent_id, None)
            if new_rules and self.session_directory_rules is not None:
                self.session_directory_rules = list(dict.fromkeys(self.session_directory_rules + new_rules))

    def evaluate_authorization(self, tool_or_name: str | dict, raw_args: dict | None = None,
                               context: SecurityContext | None = None, server_name: str = "",
                               server_id: str = "", original_name: str = "") -> AccessDecision:
        """
        Evalúa si la invocación de una herramienta está permitida, denegada o requiere confirmación.
        Jerarquía:
        1. Lista negra explícita (deny individual o de servidor).
        2. Herramientas de control de procesos (check_command).
        3. Política global allow_all -> allow incondicional.
        4. Política granular de herramienta -> allow (comprobando constraints).
        5. Política de servidor completo -> allow incondicional para sus herramientas.
        6. Reglas de directorio y Workspace Trust.
        7. Por defecto -> ask (solicitar confirmación).
        """
        ctx = context or SecurityContext()
        args = dict(raw_args or {})
        tool_name = tool_or_name.get("name", "") if isinstance(tool_or_name, dict) else str(tool_or_name)
        tool_id = tool_name
        orig_name = original_name or (tool_or_name.get("originalName") if isinstance(tool_or_name, dict) else tool_name)
        srv_name = server_name or (tool_or_name.get("serverName") if isinstance(tool_or_name, dict) else "")
        srv_id = server_id or (tool_or_name.get("serverId", "") if isinstance(tool_or_name, dict) else "")

        def make_decision(status: str, reason: str, extra: dict | None = None) -> AccessDecision:
            payload = extra or {}
            dec = AccessDecision(
                allowed=(status == POLICY_ALLOW),
                status=status,
                reason=reason,
                requires_approval=(status == POLICY_ASK),
                tool_id=tool_id,
                server_name=srv_name,
                server_id=srv_id,
                original_name=orig_name,
                details=payload.get("details", "")
            )
            if status == POLICY_ASK:
                dec.rule_offer = get_rule_offer(tool_name, args, payload)
            return dec

        default_path_tools = {"list_directory", "search_files", "get_diagnostics"}
        if (tool_name in default_path_tools or orig_name in default_path_tools) and not get_path_arg(args):
            args["path"] = "."

        view = self._effective_state()
        global_policy = view["globalMcpPolicy"]
        user_rules = view["directoryRules"]
        tool_entry = view["tools"].get(tool_id)
        server_entry = view["servers"].get(srv_id.strip()) if srv_id else None

        # 1. Denegación explícita (Blacklist)
        if tool_entry and tool_entry.get("policy") == POLICY_DENY:
            return make_decision(POLICY_DENY, "granular_deny_rule")

        if server_entry and server_entry.get("policy") == POLICY_DENY:
            return make_decision(POLICY_DENY, "server_deny_rule")

        # 2. Herramientas auxiliares de control de trabajos
        if tool_name == JOB_CONTROL_TOOL or orig_name == JOB_CONTROL_TOOL:
            return make_decision(POLICY_ALLOW, "job_control_tool")

        # 3. Política global allow_all
        if global_policy == GLOBAL_POLICY_ALLOW_ALL:
            return make_decision(POLICY_ALLOW, "mcp_global_allow_all")

        # 4. Autorización individual de herramienta
        if tool_entry and tool_entry.get("policy") == POLICY_ALLOW:
            constraints = tool_entry.get("constraints")
            if constraints and isinstance(constraints, dict):
                cmd_arg = get_command_arg(args)
                if cmd_arg and constraints.get("command"):
                    c_allowed, c_denied, c_reason, c_details = evaluate_command_constraint(cmd_arg, constraints["command"])
                    if c_denied:
                        return make_decision(POLICY_DENY, c_reason or "constraint_violation_denied", {"details": c_details})
                    if not c_allowed:
                        return make_decision(POLICY_ASK, c_reason or "constraint_outside_scope", {"details": c_details})
                    cmd_dir_eval = self.evaluate_command_directories(args, user_rules, ctx)
                    if not cmd_dir_eval["allowed"]:
                        return make_decision(POLICY_ASK, "command_directory_outside_rules", {
                            "details": f"El comando se ejecuta fuera de las reglas de directorio: {cmd_dir_eval['directory']}"
                        })
            return make_decision(POLICY_ALLOW, "granular_allow_rule")

        # 5. Autorización de servidor completo
        if server_entry and server_entry.get("policy") == POLICY_ALLOW:
            return make_decision(POLICY_ALLOW, "server_allow_rule")

        # 6. Reglas de Directorio y Workspace Trust
        path_access = get_integrated_path_access(tool_name) or get_integrated_path_access(orig_name)
        path = get_path_arg(args)

        if path_access and path:
            dir_eval = self.evaluate_directory_rule(path_access, path, user_rules, ctx)
            if dir_eval["allowed"]:
                return make_decision(POLICY_ALLOW, "directory_rule_allow")

            if global_policy == GLOBAL_POLICY_WORKSPACE_TRUST:
                if ctx.is_inside_workspace(path):
                    return make_decision(POLICY_ALLOW, "workspace_trust_allow")

            return make_decision(POLICY_ASK, "directory_rule_required", {
                "details": f"La ruta no coincide con una regla {path_access}: {path}",
                "directoryAccess": path_access if dir_eval["path"] else "",
                "directoryPath": dir_eval["path"] or ""
            })

        if (tool_name == COMMAND_TOOL or orig_name == COMMAND_TOOL) and global_policy == GLOBAL_POLICY_WORKSPACE_TRUST:
            cmd_val = get_command_arg(args)
            cd_part = split_leading_cd(cmd_val)
            sub_cmd = cd_part["command"] if cd_part else cmd_val
            is_local = is_workspace_local_command(sub_cmd) and self.evaluate_command_directories(args, user_rules, ctx)["allowed"]
            if is_local:
                return make_decision(POLICY_ALLOW, "workspace_trust_command")
            return make_decision(POLICY_ASK, "workspace_trust_external_or_global_command", {
                "details": "El comando accede a recursos globales o rutas fuera del espacio de trabajo."
            })

        # 7. Por defecto: confirmación
        return make_decision(POLICY_ASK, "mcp_default_ask")


ACCESS_CONTROLLER = AccessController()
