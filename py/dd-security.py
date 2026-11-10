# ==============================================================================
# Motor de Control de Acceso y Seguridad de Herramientas (AccessController)
# ==============================================================================

GLOBAL_POLICY_ASK = "ask"
GLOBAL_POLICY_ALLOW_ALL = "allow_all"
GLOBAL_POLICY_WORKSPACE_TRUST = "workspace_trust"
GLOBAL_POLICIES = (GLOBAL_POLICY_ASK, GLOBAL_POLICY_ALLOW_ALL, GLOBAL_POLICY_WORKSPACE_TRUST)

TOOL_POLICY_ALLOW = "allow"
TOOL_POLICY_DENY = "deny"
TOOL_POLICY_ASK = "ask"
TOOL_POLICIES = (TOOL_POLICY_ALLOW, TOOL_POLICY_DENY, TOOL_POLICY_ASK)

SERVER_POLICY_ALLOW = "allow"
SERVER_POLICY_DENY = "deny"
SERVER_POLICY_ASK = "ask"
SERVER_POLICIES = (SERVER_POLICY_ALLOW, SERVER_POLICY_DENY, SERVER_POLICY_ASK)

SCOPE_PERMANENT = "permanent"
SCOPE_SESSION = "session"
SCOPES = (SCOPE_PERMANENT, SCOPE_SESSION)

DIRECTORY_RULE_PATTERN = re.compile(r"^(R|W|RW):(.+)$")
COMMAND_TOOL = "run_command"
JOB_CONTROL_TOOL = "check_command"

LOCAL_MANAGED_TOOLS = frozenset([
    "read_file", "list_directory", "search_files", "get_diagnostics",
    "edit_file", "write_file", "run_command", "check_command", "browser_action"
])

SAFE_REDIRECTION_PATTERN = re.compile(r"&>\s*/dev/null|\d?>>?\s*/dev/null|\d?>&\d")

WORKSPACE_TRUST_PIPE_FILTERS = frozenset([
    "head", "tail", "grep", "egrep", "fgrep", "rg", "wc", "sort", "uniq", "cut", "tr", "column", "nl", "cat", "jq"
])
WORKSPACE_TRUST_GLOBAL_COMMANDS = re.compile(r"(?:^|\s)(?:sudo|su|doas|mkfs|reboot|shutdown|systemctl)\b")
WORKSPACE_TRUST_OUTSIDE_REFERENCE = re.compile(r"(?:^|[\s=:'\"])(?:[\\/~]|[A-Za-z]:[\\/])|\$|(?:^|[\s=:'\"\\/])\.\.(?=[\s\\/'\"]|$)")


@dataclasses.dataclass
class SecurityContext:
    """Contexto de seguridad desacoplado para ejecuciones, sesiones o usuarios futuros."""
    workspace_dir: Path = dataclasses.field(default_factory=lambda: Path.cwd().resolve())
    user_id: str | None = None
    session_id: str | None = None

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
                target = (self.workspace_dir / target).resolve()
            else:
                target = target.resolve()
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


def get_rule_offer(tool_name: str, args: dict, auth_eval: dict) -> dict | None:
    """Genera la regla sugerida para confirmaciones permanentes en la interfaz."""
    command = get_command_arg(args)
    if command and not auth_eval.get("directoryAccess"):
        base_name = get_command_base_name(command)
        if not base_name:
            return None
        short_name = base_name.split("/")[-1]
        return {
            "type": "command",
            "command": base_name,
            "constraints": {
                "command": {"allowedPrefixes": [short_name], "allowChaining": False, "allowPipes": False}
            }
        }
    path = auth_eval.get("directoryPath") or get_path_arg(args)
    if not path or not normalize_directory_path(path):
        return None
    access = auth_eval.get("directoryAccess") or ("W" if re.search(r"(?:^|_)(?:edit|write)_file$", tool_name) else "R")
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
    directory_rule: str = ""
    directory_access: str = ""
    directory_path: str = ""
    rule_offer: dict | None = None
    scope: str = ""
    constraints: dict | None = None

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
            "directoryRule": self.directory_rule,
            "directoryAccess": self.directory_access,
            "directoryPath": self.directory_path,
            "ruleOffer": self.rule_offer,
            "scope": self.scope,
            "constraints": self.constraints
        }


class AccessController:
    """Motor de control de acceso y autorización del backend (PDP/PEP)."""

    def __init__(self):
        self._lock = threading.RLock()
        self._loaded = False
        self.global_policy = GLOBAL_POLICY_ASK
        self.tools: dict[str, dict] = {}
        self.servers: dict[str, dict] = {}
        self.directory_rules: list[str] = []
        self.session_tools: dict[str, dict] = {}
        self.session_servers: dict[str, dict] = {}
        self.pending_challenges: dict[str, dict] = {}

    def _ensure_loaded(self, context: SecurityContext | None = None):
        with self._lock:
            if not self._loaded:
                self._loaded = True
                self.load_from_storage(context=context)

    def load_from_storage(self, policy_id: str = "default", user_id: str | None = None, context: SecurityContext | None = None):
        """Carga las políticas persistidas en SQLite si existen."""
        try:
            get_fn = globals().get("get_security_policy_data")
            if callable(get_fn):
                data = get_fn(policy_id, user_id)
                if data and isinstance(data, dict):
                    self.import_state(data, context=context, persist=False)
        except (sqlite3.Error, ValueError, KeyError, TypeError) as ex:
            logger.debug(f"[Security] No se pudo cargar la política desde almacenamiento: {ex}")

    def save_to_storage(self, policy_id: str = "default", user_id: str | None = None, context: SecurityContext | None = None):
        """Persiste las políticas permanentes actuales en SQLite."""
        try:
            save_fn = globals().get("save_security_policy_data")
            if callable(save_fn):
                state = self.export_state(context)
                save_fn(state, policy_id, user_id)
        except (sqlite3.Error, ValueError, KeyError, TypeError) as ex:
            logger.debug(f"[Security] No se pudo cargar la política desde almacenamiento: {ex}")

    def export_state(self, context: SecurityContext | None = None) -> dict:
        self._ensure_loaded(context)
        with self._lock:
            return {
                "version": 5,
                "globalMcpPolicy": self.global_policy,
                "directoryRules": self.get_directory_rules(context),
                "tools": dict(self.tools),
                "servers": dict(self.servers)
            }

    def import_state(self, state: dict, context: SecurityContext | None = None, persist: bool = True):
        if not isinstance(state, dict):
            raise ValueError("El estado de políticas debe ser un diccionario.")
        with self._lock:
            if "globalMcpPolicy" in state:
                pol = state["globalMcpPolicy"]
                if pol in GLOBAL_POLICIES:
                    self.global_policy = pol
                else:
                    raise ValueError(f"Política global no válida: '{pol}'. Válidas: {GLOBAL_POLICIES}")
            if "directoryRules" in state:
                rules = state["directoryRules"]
                if isinstance(rules, (list, tuple)):
                    self.set_directory_rules(list(rules), context, persist=False)
                else:
                    raise ValueError("Las reglas de directorio deben ser una lista.")
            if "tools" in state:
                tools_map = state["tools"]
                if isinstance(tools_map, dict):
                    self.tools = dict(tools_map)
                else:
                    raise ValueError("tools debe ser un diccionario de herramientas.")
            if "servers" in state:
                servers_map = state["servers"]
                if isinstance(servers_map, dict):
                    self.servers = dict(servers_map)
                else:
                    raise ValueError("servers debe ser un diccionario de servidores.")
        if persist:
            self.save_to_storage(context=context)

    def set_global_policy(self, policy: str, context: SecurityContext | None = None):
        if policy not in GLOBAL_POLICIES:
            raise ValueError(f"Política global inválida: {policy}")
        self._ensure_loaded(context)
        with self._lock:
            self.global_policy = policy
        self.save_to_storage(context=context)

    def get_default_directory_rule(self, context: SecurityContext | None = None) -> str:
        ctx = context or SecurityContext()
        base = normalize_directory_path(str(ctx.workspace_dir))
        return f"RW:{base}" if base == "/" else f"RW:{base}/**"

    def get_directory_rules(self, context: SecurityContext | None = None) -> list[str]:
        self._ensure_loaded(context)
        with self._lock:
            if not self.directory_rules:
                return [self.get_default_directory_rule(context)]
            return list(self.directory_rules)

    def set_directory_rules(self, rules: list[str], context: SecurityContext | None = None, persist: bool = True) -> list[str]:
        if not isinstance(rules, (list, tuple)):
            raise ValueError("Las reglas de directorio deben ser una lista.")
        parsed_rules = []
        for raw in rules:
            rule_obj = parse_directory_rule(raw)
            if not rule_obj:
                raise ValueError(f"Regla de directorio inválida: '{raw}'. Formato esperado: R:path, W:path o RW:path.")
            parsed_rules.append(rule_obj["rule"])
        unique_rules = list(dict.fromkeys(parsed_rules))
        self._ensure_loaded(context)
        with self._lock:
            self.directory_rules = unique_rules or [self.get_default_directory_rule(context)]
            result = list(self.directory_rules)
        if persist:
            self.save_to_storage(context=context)
        return result

    def add_directory_rule(self, rule: str, context: SecurityContext | None = None) -> list[str]:
        current = self.get_directory_rules(context)
        return self.set_directory_rules(current + [rule], context)

    def evaluate_directory_rule(self, access: str, path: str, context: SecurityContext | None = None) -> dict:
        if contains_unresolved_reference(path):
            return {"allowed": False, "rule": None, "path": ""}
        normalized = normalize_directory_path(path)
        if not normalized:
            return {"allowed": False, "rule": None, "path": ""}
        ctx = context or SecurityContext()
        startup_dir = normalize_directory_path(str(ctx.workspace_dir))
        resolved_absolute = None
        if not normalized.startswith("/") and not re.match(r"^[A-Za-z]:", normalized) and startup_dir:
            resolved_absolute = normalize_directory_path(startup_dir if normalized == "." else f"{startup_dir}/{normalized}")

        rules = self.get_directory_rules(ctx)
        for raw_rule in rules:
            parsed = parse_directory_rule(raw_rule)
            if not parsed or (parsed["access"] != access and parsed["access"] != "RW"):
                continue
            if matches_directory_pattern(normalized, parsed["path"]):
                return {"allowed": True, "rule": parsed["rule"], "path": normalized}
            if resolved_absolute and matches_directory_pattern(resolved_absolute, parsed["path"]):
                return {"allowed": True, "rule": parsed["rule"], "path": normalized}
        return {"allowed": False, "rule": None, "path": normalized}

    def evaluate_command_directories(self, args: dict, context: SecurityContext | None = None) -> dict:
        cmd_arg = get_command_arg(args)
        cd_part = split_leading_cd(cmd_arg)
        if not cd_part:
            return {"allowed": True, "directory": None}
        target_dir = cd_part["directory"]
        read_eval = self.evaluate_directory_rule("R", target_dir, context)
        write_eval = self.evaluate_directory_rule("W", target_dir, context)
        allowed = read_eval["allowed"] or write_eval["allowed"]
        return {"allowed": allowed, "directory": target_dir}

    def set_tool_policy(self, tool_id: str, policy: str, scope: str = SCOPE_PERMANENT,
                        constraints: dict | None = None, server_name: str = "", original_name: str = ""):
        if not tool_id or not isinstance(tool_id, str):
            return
        self._ensure_loaded()
        clean_policy = policy if policy in (TOOL_POLICY_ALLOW, TOOL_POLICY_DENY) else TOOL_POLICY_ASK
        with self._lock:
            if clean_policy == TOOL_POLICY_ASK:
                self.revoke_tool_policy(tool_id)
                return
            entry = {
                "policy": clean_policy,
                "scope": scope if scope in SCOPES else SCOPE_PERMANENT,
                "grantedAt": int(time.time() * 1000),
                "lastUsedAt": int(time.time() * 1000),
                "serverName": server_name,
                "originalName": original_name or tool_id,
                "constraints": constraints
            }
            if scope == SCOPE_SESSION:
                self.session_tools[tool_id] = entry
            else:
                self.tools[tool_id] = entry
        if scope != SCOPE_SESSION:
            self.save_to_storage()

    def get_tool_policy(self, tool_id: str) -> dict | None:
        self._ensure_loaded()
        with self._lock:
            return self.session_tools.get(tool_id) or self.tools.get(tool_id)

    def revoke_tool_policy(self, tool_id: str) -> bool:
        self._ensure_loaded()
        with self._lock:
            del_session = self.session_tools.pop(tool_id, None) is not None
            del_perm = self.tools.pop(tool_id, None) is not None
        if del_perm:
            self.save_to_storage()
        return del_session or del_perm

    def set_server_policy(self, server_id: str, policy: str, scope: str = SCOPE_PERMANENT, server_name: str = ""):
        if not server_id or not isinstance(server_id, str):
            return
        clean = server_id.strip()
        self._ensure_loaded()
        clean_policy = policy if policy in (SERVER_POLICY_ALLOW, SERVER_POLICY_DENY) else SERVER_POLICY_ASK
        with self._lock:
            if clean_policy == SERVER_POLICY_ASK:
                self.revoke_server_policy(clean)
                return
            entry = {
                "policy": clean_policy,
                "scope": scope if scope in SCOPES else SCOPE_PERMANENT,
                "grantedAt": int(time.time() * 1000),
                "lastUsedAt": int(time.time() * 1000),
                "serverName": server_name or clean
            }
            if scope == SCOPE_SESSION:
                self.session_servers[clean] = entry
            else:
                self.servers[clean] = entry
        if scope != SCOPE_SESSION:
            self.save_to_storage()

    def get_server_policy(self, server_id: str) -> dict | None:
        clean = str(server_id or "").strip()
        self._ensure_loaded()
        with self._lock:
            return self.session_servers.get(clean) or self.servers.get(clean)

    def revoke_server_policy(self, server_id: str) -> bool:
        clean = str(server_id or "").strip()
        self._ensure_loaded()
        with self._lock:
            del_session = self.session_servers.pop(clean, None) is not None
            del_perm = self.servers.pop(clean, None) is not None
        if del_perm:
            self.save_to_storage()
        return del_session or del_perm

    def clear_session(self):
        """Limpia todas las autorizaciones temporales de la sesión activa."""
        with self._lock:
            self.session_tools.clear()
            self.session_servers.clear()
            self.pending_challenges.clear()

    def create_challenge(self, tool_name: str, args: dict, decision: AccessDecision,
                         server_name: str = "", server_id: str = "") -> dict:
        """Genera un reto estructurado para solicitar confirmación interactiva al usuario."""
        challenge_id = f"auth_{secrets.token_urlsafe(16)}"
        now = int(time.time() * 1000)
        with self._lock:
            expired = [cid for cid, c in self.pending_challenges.items() if now - c.get("createdAt", 0) > 600_000]
            for cid in expired:
                self.pending_challenges.pop(cid, None)

            challenge_data = {
                "id": challenge_id,
                "toolName": tool_name,
                "arguments": args,
                "decision": decision.to_dict(),
                "serverName": server_name,
                "serverId": server_id,
                "createdAt": now,
                "authorized": False,
                "decisionType": None
            }
            self.pending_challenges[challenge_id] = challenge_data
            return challenge_data

    def get_challenge(self, challenge_id: str) -> dict | None:
        with self._lock:
            return self.pending_challenges.get(challenge_id)

    def authorize_challenge(self, challenge_id: str, decision: str | dict,
                            constraints: dict | None = None, directory_rule: str | None = None,
                            context: SecurityContext | None = None) -> bool:
        with self._lock:
            challenge = self.pending_challenges.get(challenge_id)
            if not challenge:
                return False
            dec_type = decision.get("decision") if isinstance(decision, dict) else str(decision)
            if dec_type not in ("allow_once", "allow_session", "allow_always", "allow_server_always"):
                return False
            challenge["authorized"] = True
            challenge["decisionType"] = dec_type
            dec_payload = {
                "decision": dec_type,
                "constraints": constraints or (decision.get("constraints") if isinstance(decision, dict) else None),
                "directoryRule": directory_rule or (decision.get("directoryRule") if isinstance(decision, dict) else None)
            }
            self.record_decision(dec_payload, challenge["decision"], fallback_tool_name=challenge["toolName"], context=context)
            return True

    def consume_challenge(self, challenge_id: str) -> dict | None:
        """Consume y valida un reto previamente autorizado para una ejecución."""
        with self._lock:
            challenge = self.pending_challenges.get(challenge_id)
            if not challenge or not challenge.get("authorized"):
                return None
            if challenge.get("decisionType") == "allow_once":
                return self.pending_challenges.pop(challenge_id)
            return challenge

    def revoke_challenge(self, challenge_id: str) -> bool:
        with self._lock:
            return self.pending_challenges.pop(challenge_id, None) is not None

    def merge_tool_constraints(self, target_tool_id: str, requested: dict | None) -> dict | None:
        """Combina restricciones granulares existentes con nuevas solicitadas."""
        existing_entry = self.get_tool_policy(target_tool_id)
        existing_constraints = existing_entry.get("constraints") if existing_entry else None
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

    def record_decision(self, decision: str | dict, auth_eval: dict | AccessDecision,
                        fallback_tool_name: str = "", context: SecurityContext | None = None):
        """Registra la respuesta de un usuario tras un reto de autorización."""
        decision_dict = decision if isinstance(decision, dict) else {"decision": str(decision)}
        decision_type = decision_dict.get("decision", "")
        eval_dict = auth_eval.to_dict() if isinstance(auth_eval, AccessDecision) else dict(auth_eval)
        target_tool = eval_dict.get("toolId") or fallback_tool_name

        if decision_type == "allow_session":
            self.set_tool_policy(target_tool, TOOL_POLICY_ALLOW, scope=SCOPE_SESSION,
                                 server_name=eval_dict.get("serverName", ""),
                                 original_name=eval_dict.get("originalName", ""))
        elif decision_type == "allow_server_always":
            server_target = decision_dict.get("serverId") or eval_dict.get("serverId")
            if server_target:
                self.set_server_policy(server_target, SERVER_POLICY_ALLOW, scope=SCOPE_PERMANENT,
                                       server_name=eval_dict.get("serverName", ""))
        elif decision_type == "allow_always":
            req_constraints = decision_dict.get("constraints")
            constraints = self.merge_tool_constraints(target_tool, req_constraints)
            self.set_tool_policy(target_tool, TOOL_POLICY_ALLOW, scope=SCOPE_PERMANENT,
                                 constraints=constraints,
                                 server_name=eval_dict.get("serverName", ""),
                                 original_name=eval_dict.get("originalName", ""))
        elif decision_type == "allow_once":
            pass

        if decision_dict.get("directoryRule"):
            try:
                self.add_directory_rule(str(decision_dict["directoryRule"]), context)
            except ValueError:
                pass

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
        self._ensure_loaded(ctx)
        args = dict(raw_args or {})
        tool_name = tool_or_name.get("name", "") if isinstance(tool_or_name, dict) else str(tool_or_name)
        tool_id = tool_name
        orig_name = original_name or (tool_or_name.get("originalName") if isinstance(tool_or_name, dict) else tool_name)
        srv_name = server_name or (tool_or_name.get("serverName") if isinstance(tool_or_name, dict) else "")
        srv_id = server_id or (tool_or_name.get("serverId") if isinstance(tool_or_name, dict) else srv_name)

        def make_decision(status: str, reason: str, extra: dict | None = None) -> AccessDecision:
            payload = extra or {}
            dec = AccessDecision(
                allowed=(status == TOOL_POLICY_ALLOW),
                status=status,
                reason=reason,
                requires_approval=(status == TOOL_POLICY_ASK),
                tool_id=tool_id,
                server_name=srv_name,
                server_id=srv_id,
                original_name=orig_name,
                details=payload.get("details", ""),
                directory_rule=payload.get("directoryRule", ""),
                directory_access=payload.get("directoryAccess", ""),
                directory_path=payload.get("directoryPath", ""),
                scope=payload.get("scope", ""),
                constraints=payload.get("constraints")
            )
            if status == TOOL_POLICY_ASK:
                dec.rule_offer = get_rule_offer(tool_name, args, dec.to_dict())
            return dec

        default_path_tools = {"list_directory", "search_files", "get_diagnostics"}
        if (tool_name in default_path_tools or orig_name in default_path_tools) and not get_path_arg(args):
            args["path"] = "."

        # 1. Denegación explícita (Blacklist)
        tool_entry = self.get_tool_policy(tool_id)
        if tool_entry and tool_entry.get("policy") == TOOL_POLICY_DENY:
            return make_decision(TOOL_POLICY_DENY, "granular_deny_rule")

        if srv_id:
            server_entry = self.get_server_policy(srv_id)
            if server_entry and server_entry.get("policy") == SERVER_POLICY_DENY:
                return make_decision(TOOL_POLICY_DENY, "server_deny_rule")

        # 2. Herramientas auxiliares de control de trabajos
        if tool_name == JOB_CONTROL_TOOL or orig_name == JOB_CONTROL_TOOL:
            return make_decision(TOOL_POLICY_ALLOW, "job_control_tool")

        # 3. Política global allow_all
        if self.global_policy == GLOBAL_POLICY_ALLOW_ALL:
            return make_decision(TOOL_POLICY_ALLOW, "mcp_global_allow_all")

        # 4. Autorización individual de herramienta
        if tool_entry and tool_entry.get("policy") == TOOL_POLICY_ALLOW:
            constraints = tool_entry.get("constraints")
            if constraints and isinstance(constraints, dict):
                cmd_arg = get_command_arg(args)
                if cmd_arg and constraints.get("command"):
                    c_allowed, c_denied, c_reason, c_details = evaluate_command_constraint(cmd_arg, constraints["command"])
                    if c_denied:
                        return make_decision(TOOL_POLICY_DENY, c_reason or "constraint_violation_denied", {"details": c_details})
                    if not c_allowed:
                        return make_decision(TOOL_POLICY_ASK, c_reason or "constraint_outside_scope", {"details": c_details})
                    cmd_dir_eval = self.evaluate_command_directories(args, ctx)
                    if not cmd_dir_eval["allowed"]:
                        return make_decision(TOOL_POLICY_ASK, "command_directory_outside_rules", {
                            "details": f"El comando se ejecuta fuera de las reglas de directorio: {cmd_dir_eval['directory']}"
                        })
            with self._lock:
                tool_entry["lastUsedAt"] = int(time.time() * 1000)
            return make_decision(TOOL_POLICY_ALLOW, "granular_allow_rule", {
                "scope": tool_entry.get("scope", SCOPE_PERMANENT),
                "constraints": tool_entry.get("constraints")
            })

        # 5. Autorización de servidor completo
        if srv_id:
            srv_entry = self.get_server_policy(srv_id)
            if srv_entry and srv_entry.get("policy") == SERVER_POLICY_ALLOW:
                with self._lock:
                    srv_entry["lastUsedAt"] = int(time.time() * 1000)
                return make_decision(TOOL_POLICY_ALLOW, "server_allow_rule", {"scope": srv_entry.get("scope", SCOPE_PERMANENT)})

        # 6. Reglas de Directorio y Workspace Trust
        path_access = get_integrated_path_access(tool_name) or get_integrated_path_access(orig_name)
        path = get_path_arg(args)

        if path_access and path:
            dir_eval = self.evaluate_directory_rule(path_access, path, ctx)
            if dir_eval["allowed"]:
                return make_decision(TOOL_POLICY_ALLOW, "directory_rule_allow", {"directoryRule": dir_eval["rule"]})

            if self.global_policy == GLOBAL_POLICY_WORKSPACE_TRUST:
                if ctx.is_inside_workspace(path):
                    return make_decision(TOOL_POLICY_ALLOW, "workspace_trust_allow")

            return make_decision(TOOL_POLICY_ASK, "directory_rule_required", {
                "details": f"La ruta no coincide con una regla {path_access}: {path}",
                "directoryAccess": path_access if dir_eval["path"] else "",
                "directoryPath": dir_eval["path"] or ""
            })

        if (tool_name == COMMAND_TOOL or orig_name == COMMAND_TOOL) and self.global_policy == GLOBAL_POLICY_WORKSPACE_TRUST:
            cmd_val = get_command_arg(args)
            cd_part = split_leading_cd(cmd_val)
            sub_cmd = cd_part["command"] if cd_part else cmd_val
            is_local = is_workspace_local_command(sub_cmd) and self.evaluate_command_directories(args, ctx)["allowed"]
            if is_local:
                return make_decision(TOOL_POLICY_ALLOW, "workspace_trust_command")
            return make_decision(TOOL_POLICY_ASK, "workspace_trust_external_or_global_command", {
                "details": "El comando accede a recursos globales o rutas fuera del espacio de trabajo."
            })

        # 7. Por defecto: confirmación
        return make_decision(TOOL_POLICY_ASK, "mcp_default_ask")


ACCESS_CONTROLLER = AccessController()
