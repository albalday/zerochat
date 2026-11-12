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

SCOPE_PERMANENT = "permanent"
SCOPE_SESSION = "session"

POLICY_STATE_VERSION = 6
CHALLENGE_TTL_MS = 600_000
AUTHORIZE_DECISIONS = ("allow_once", "allow_session", "allow_project", "allow_always", "allow_server_always")
MAX_POLICY_ENTRIES = 500

DIRECTORY_RULE_PATTERN = re.compile(r"^(R|W|RW):(.+)$")
COMMAND_TOOL = "run_command"
JOB_CONTROL_TOOL = "check_command"
# Herramientas integradas que acceden al sistema de archivos por su argumento de ruta.
READ_PATH_TOOLS = frozenset(("read_file", "list_directory", "search_files", "get_diagnostics"))
WRITE_PATH_TOOLS = frozenset(("edit_file", "write_file"))
DIRECTORY_PATH_TOOLS = frozenset(("list_directory", "search_files", "get_diagnostics"))

MAX_COMMAND_PATTERNS = 50
COMMAND_PATTERN_FORBIDDEN = re.compile(r"[;&|<>$`'\"\\\n\r]")
# Lo que nunca cubre un comodín: expansión de la shell (variables, llaves, comillas invertidas, ~ inicial),
# un segmento '..' o un glob que lo alcance ('.?'), y en los argumentos del '*' final, una ruta absoluta.
COMMAND_WILDCARD_UNSAFE = re.compile(r"[$`{}]|(?:^|[=:])~|(?:^|[/\\=:])\.\.(?:[/\\]|$)|(?:^|/)\.[^/]*[*?\[]")
COMMAND_ABSOLUTE_ARG = re.compile(r"(?:^|[=:])(?:[/\\]|[A-Za-z]:[/\\])")
SYSTEM_BIN_DIRS = ("/usr/bin/", "/bin/", "/usr/local/bin/")
SUBCOMMAND_TOKEN = re.compile(r"[A-Za-z][A-Za-z0-9_.:-]*")

SAFE_REDIRECTION_PATTERN = re.compile(r"&>\s*/dev/null|\d?>>?\s*/dev/null|\d?>&\d")
# Lo que impide validar un comando por partes: sustitución de comandos o de procesos y saltos de línea.
SHELL_SPLIT_UNSUPPORTED = re.compile(r"[`\n\r]|\$\(|[<>]\(")
# Palabras que cambian cómo se ejecuta lo que sigue (bloques, bucles, prefijos o cambios de carpeta ocultos).
SHELL_KEYWORDS = frozenset(["if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac",
                            "select", "function", "{", "}", "!", "[[", "time", "coproc", "pushd", "popd", "builtin",
                            "set-location", "sl", "chdir", "push-location", "pop-location"])
ENV_ASSIGNMENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*=.*")
# Un cd a una carpeta que solo la shell conoce: variables, ~, comodines o la anterior.
CD_UNSAFE_TARGET = re.compile(r"[$~*?\[{]")

WORKSPACE_TRUST_PIPE_FILTERS = frozenset([
    "head", "tail", "grep", "egrep", "fgrep", "rg", "wc", "sort", "uniq", "cut", "tr", "column", "nl", "cat", "jq"
])
WORKSPACE_TRUST_GLOBAL_COMMANDS = re.compile(r"(?:^|\s)(?:sudo|su|doas|mkfs|reboot|shutdown|systemctl)\b")
WORKSPACE_TRUST_OUTSIDE_REFERENCE = re.compile(r"(?:^|[\s=:'\"])(?:[\\/~]|[A-Za-z]:[\\/])|\$|(?:^|[\s=:'\"\\/])\.\.(?=[\s\\/'\"]|$)")


# Proyecto por defecto: la carpeta de arranque, para las peticiones que no indican el suyo (la primera
# conexión de una pestaña, las ejecuciones en servidor). El proceso nunca cambia de directorio: cada
# petición recibe su proyecto en un SecurityContext.
PROJECT_DIR = Path.cwd().resolve()


def project_context() -> "SecurityContext":
    """Contexto del proyecto por defecto del servidor."""
    return SecurityContext(PROJECT_DIR)


def request_project_context(raw: str | None, *, fallback: bool) -> "SecurityContext":
    """
    Proyecto de una petición: la carpeta absoluta de la cabecera X-ZeroChat-Project (codificada como en
    una URL) o, sin cabecera, el proyecto por defecto. Una carpeta que ya no existe es un error, salvo con
    fallback (initialize), que devuelve el proyecto por defecto para que la pestaña sepa dónde está.
    """
    if not raw:
        return project_context()
    path = Path(urllib.parse.unquote(raw))
    if path.is_absolute() and path.is_dir():
        return SecurityContext(path.resolve())
    if fallback:
        return project_context()
    raise ValueError(f"La carpeta del proyecto de la pestaña ya no existe: {path}")


@dataclasses.dataclass
class SecurityContext:
    """Proyecto en el que actúa una petición: base de sus rutas relativas, de sus comandos y de sus permisos."""
    workspace_dir: Path

    def absolute(self, path: str) -> Path:
        """Ruta de una herramienta resuelta contra la carpeta del proyecto ('~' es la carpeta del usuario)."""
        target = Path(str(path).strip()).expanduser()
        return (target if target.is_absolute() else self.workspace_dir / target).resolve()

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


def split_command(cmd: str) -> list[tuple[str, str]] | None:
    """
    Parte un comando por sus operadores de shell fuera de comillas (&&, ||, ; y |) en
    [(operador anterior, subcomando)], para validar cada subcomando por separado. None si usa algo
    que no se puede validar por partes: sustitución de comandos, saltos de línea, '&' en segundo
    plano, subshells, redirecciones a ficheros (salvo las de SAFE_REDIRECTION_PATTERN), palabras
    reservadas de la shell, comillas sin cerrar, un subcomando vacío o un cd que no sea 'cd <dir>'.
    """
    if not isinstance(cmd, str) or SHELL_SPLIT_UNSUPPORTED.search(cmd):
        return None
    text = SAFE_REDIRECTION_PATTERN.sub(" ", cmd)
    segments, current, operator, quote, i = [], "", "", "", 0
    while i < len(text):
        ch = text[i]
        two = text[i:i + 2]
        if quote:
            if ch == "\\" and quote == '"':
                current += two
                i += 2
                continue
            quote = "" if ch == quote else quote
        elif ch == "\\":
            current += two
            i += 2
            continue
        elif ch in "'\"":
            quote = ch
        elif two in ("&&", "||") or ch in ";|":
            sep = two if two in ("&&", "||") else ch
            segments.append((operator, current.strip()))
            current, operator = "", sep
            i += len(sep)
            continue
        elif ch in "&<>()":
            return None
        current += ch
        i += 1
    segments.append((operator, current.strip()))
    if quote or not all(_is_plain_segment(segment) for _, segment in segments):
        return None
    return segments


def _is_plain_segment(segment: str) -> bool:
    """Un subcomando no vacío, que no empieza por una palabra reservada y, si es un cd, de la forma 'cd <dir>'."""
    try:
        words = shlex.split(segment)
    except ValueError:
        return False
    if not words or words[0].lower() in SHELL_KEYWORDS:
        return False
    # Un cd tras variables ('x=1 cd /etc') o tras 'command' también cambia la carpeta: no se admite.
    rest = list(itertools.dropwhile(ENV_ASSIGNMENT.fullmatch, words))
    if rest[rest[:1] == ["command"]:][:1] == ["cd"] and words[0] != "cd":
        return False
    return words[0] != "cd" or (len(words) == 2 and not words[1].startswith("-") and not CD_UNSAFE_TARGET.search(words[1]))


def cd_target(segment: str) -> str | None:
    """Carpeta de un subcomando 'cd <dir>' ya validado por split_command, o None si no es un cd."""
    words = shlex.split(segment)
    return words[1] if words[0] == "cd" else None


def get_command_arg(args: dict | None) -> str:
    """Argumento `command` de run_command (el manejador no admite otro nombre)."""
    val = args.get("command") if isinstance(args, dict) else None
    return val.strip() if isinstance(val, str) else ""


def get_path_arg(args: dict | None) -> str:
    """Argumento `path` de las herramientas integradas de ficheros (el manejador no admite otro nombre)."""
    val = args.get("path") if isinstance(args, dict) else None
    return val.strip() if isinstance(val, str) else ""


def get_integrated_path_access(tool_name: str) -> str:
    """Clasifica el tipo de acceso al sistema de archivos ('R' o 'W') de herramientas core."""
    if tool_name in READ_PATH_TOOLS:
        return "R"
    if tool_name in WRITE_PATH_TOOLS:
        return "W"
    return ""


def is_workspace_local_command(segment: str) -> bool:
    """Filtro de Workspace Trust para un subcomando: sin órdenes globales ni referencias fuera del proyecto."""
    return not WORKSPACE_TRUST_GLOBAL_COMMANDS.search(segment) and not WORKSPACE_TRUST_OUTSIDE_REFERENCE.search(segment)


@functools.lru_cache(maxsize=512)
def compile_command_pattern(pattern: str) -> tuple[tuple[tuple[re.Pattern, bool], ...], bool]:
    """
    Compila un patrón de comando por argumentos: cada palabra es una expresión regular (un `*`
    vale cualquier texto sin `/`) con su marca de comodín, y un `*` suelto al final admite
    cualquier número de argumentos más ('git log *' -> ((git, no), (log, no)), sí).
    """
    words = pattern.split()
    rest = bool(words) and words[-1] == "*"
    if rest:
        words = words[:-1]
    compiled = tuple((re.compile("[^/]*".join(re.escape(part) for part in word.split("*"))), "*" in word)
                     for word in words)
    return compiled, rest


def matches_command_pattern(command: str, pattern: str) -> bool:
    """
    Verifica si un comando cumple un patrón autorizado, argumento a argumento: sin `*` el texto es
    exacto. Un argumento cubierto por un comodín no puede contener `..` ni lo que expande la shell, y
    los del `*` final tampoco una ruta absoluta. Solo cubre un subcomando simple, nunca un cd.
    """
    segments = split_command(command)
    if not segments or len(segments) != 1 or cd_target(segments[0][1]) is not None:
        return False
    command = segments[0][1]
    words, rest = compile_command_pattern(str(pattern))
    try:
        args = shlex.split(command)
    except ValueError:
        return False
    if not words or len(args) < len(words) or (len(args) > len(words) and not rest):
        return False
    first = next((args[0][len(d):] for d in SYSTEM_BIN_DIRS if args[0].startswith(d)), args[0])
    for (regex, wildcard), arg in zip(words, [first, *args[1:]]):
        if not regex.fullmatch(arg) or (wildcard and COMMAND_WILDCARD_UNSAFE.search(arg)):
            return False
    # Los argumentos del '*' final no tienen texto fijo que los acote: tampoco pueden salir del proyecto.
    return not any(COMMAND_WILDCARD_UNSAFE.search(arg) or COMMAND_ABSOLUTE_ARG.search(arg) for arg in args[len(words):])


def normalize_command_pattern(raw: str) -> str:
    """
    Limpia un patrón de comando ('git  status *' -> 'git status *'): el ejecutable sin comodín, sin
    metacaracteres de shell ni comillas y sin `**`, reservado; ValueError si no es válido.
    """
    if not isinstance(raw, str):
        raise ValueError("Cada patrón de comando debe ser un texto.")
    clean = " ".join(raw.split())
    if not clean or "*" in clean.split()[0] or "**" in clean or COMMAND_PATTERN_FORBIDDEN.search(clean):
        raise ValueError(f"Patrón de comando no válido: '{raw}'.")
    return clean


def _is_valid_pattern(raw: str) -> bool:
    try:
        return bool(normalize_command_pattern(raw))
    except ValueError:
        return False


def clean_pattern_list(raw, label: str) -> list[str]:
    """Patrones limpios, sin repetidos ni cubiertos por otro más amplio de la misma lista."""
    if not isinstance(raw, list):
        raise ValueError(f"{label} debe ser una lista de comandos.")
    unique = list(dict.fromkeys(normalize_command_pattern(p) for p in raw))
    return [p for p in unique if not any(q != p and matches_command_pattern(p, q) for q in unique)]


def normalize_command_patterns(raw) -> dict:
    """
    Valida los patrones de comando guardados: `global` (todos los proyectos) y `projects` (ruta absoluta
    del proyecto -> patrones), sin repetidos ni cubiertos por otro más amplio y como máximo
    MAX_COMMAND_PATTERNS en total. Los de sesión nunca forman parte del estado guardado.
    """
    if not isinstance(raw, dict):
        raise ValueError("commandPatterns debe ser un diccionario con global y projects.")
    raw_projects = raw.get("projects") or {}
    if not isinstance(raw_projects, dict):
        raise ValueError("commandPatterns.projects debe ser un diccionario de proyecto a patrones.")
    projects: dict[str, list[str]] = {}
    for raw_path, raw_list in raw_projects.items():
        path = normalize_directory_path(str(raw_path))
        if not path or not re.match(r"^(/|[A-Za-z]:/)", path):
            raise ValueError(f"Proyecto no válido en commandPatterns.projects: '{raw_path}'.")
        patterns = clean_pattern_list(projects.get(path, []) + clean_pattern_list(raw_list, "commandPatterns.projects"), "commandPatterns.projects")
        if patterns:
            projects[path] = patterns
    global_patterns = clean_pattern_list(raw.get("global") or [], "commandPatterns.global")
    total = len(global_patterns) + sum(len(v) for v in projects.values())
    if total > MAX_COMMAND_PATTERNS:
        raise ValueError(f"Hay {total} patrones de comando; el máximo es {MAX_COMMAND_PATTERNS}.")
    return {"global": global_patterns, "projects": projects}


def suggest_command_prefix(command: str) -> str:
    """Prefijo sugerido: ejecutable y, si lo hay, su subcomando ('git status --short' -> 'git status')."""
    tokens = command.split()
    if not tokens:
        return ""
    if len(tokens) > 1 and SUBCOMMAND_TOKEN.fullmatch(tokens[1]):
        return f"{tokens[0]} {tokens[1]}"
    return tokens[0]


def command_rule_offer(commands: list[str]) -> dict | None:
    """
    Un patrón que cubra todos los subcomandos sin autorizar: el programa con su subcomando y '*', o el
    comando exacto si es uno solo y el '*' no lo cubriría. Sin oferta si no hay uno común.
    """
    candidates = [*dict.fromkeys(f"{suggest_command_prefix(c)} *" for c in commands), *commands[:len(commands) == 1]]
    pattern = next((p for p in candidates
                    if _is_valid_pattern(p) and all(matches_command_pattern(c, p) for c in commands)), None)
    return {"type": "command", "command": pattern} if pattern else None


def directory_rule_offer(tool_name: str, access: str, path: str) -> dict | None:
    """Regla sugerida para la carpeta de la ruta (la propia ruta en list_directory)."""
    if not normalize_directory_path(path):
        return None
    clean_path = path.replace("\\", "/").rstrip("/")
    if tool_name == "list_directory":
        folder = clean_path
    else:
        folder = clean_path[:clean_path.rfind("/")] if "/" in clean_path else "."
    dir_path = folder or "/"
    rule = f"{access}:{dir_path}" if dir_path == "/" else f"{access}:{dir_path}/**"
    return {"type": "directory", "access": access, "directoryRule": rule}


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
        self.session_command_patterns: list[str] = []
        self.pending_challenges: dict[str, dict] = {}

    @staticmethod
    def _normalize_state(raw: dict | None) -> dict:
        """Única definición del estado permanente y de sus valores por defecto."""
        data = raw if isinstance(raw, dict) else {}
        patterns = data.get("commandPatterns") if isinstance(data.get("commandPatterns"), dict) else {}
        # run_command nunca se guarda autorizado entero: sus permisos permanentes son patrones.
        tools = {tid: entry for tid, entry in dict(data.get("tools") or {}).items()
                 if not (tid == COMMAND_TOOL and isinstance(entry, dict) and entry.get("policy") == POLICY_ALLOW)}
        return {
            "version": POLICY_STATE_VERSION,
            "globalMcpPolicy": data.get("globalMcpPolicy") or GLOBAL_POLICY_ASK,
            "directoryRules": list(data.get("directoryRules") or []),
            "tools": tools,
            "servers": dict(data.get("servers") or {}),
            "commandPatterns": {"global": list(patterns.get("global") or []), "projects": dict(patterns.get("projects") or {})}
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
                "servers": {**state["servers"], **self.session_servers},
                "commandPatterns": {**state["commandPatterns"], "session": list(self.session_command_patterns)}
            }

    @staticmethod
    def _project_key(context: SecurityContext) -> str:
        return normalize_directory_path(str(context.workspace_dir))

    def _command_patterns(self, view: dict, context: SecurityContext) -> list[str]:
        """Patrones que rigen en el proyecto: los de todos los proyectos, los de este y los de la sesión."""
        patterns = view["commandPatterns"]
        return [*patterns["global"], *(patterns["projects"].get(self._project_key(context)) or []), *patterns["session"]]

    def export_state(self, context: SecurityContext) -> dict:
        return {
            "version": POLICY_STATE_VERSION,
            **self._effective_state(),
            "defaultDirectoryRule": self.get_default_directory_rule(context)
        }

    def _validate_directory_rules(self, raw_rules: list | tuple, context: SecurityContext) -> list[str]:
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

    def _session_map(self, kind: str) -> dict[str, dict]:
        return self.session_tools if kind == "tools" else self.session_servers

    @staticmethod
    def _check_entry_limit(state: dict):
        """Único tope de entradas, sobre el estado resultante (guardado o capa de sesión)."""
        total = len(state.get("directoryRules") or []) + len(state.get("tools") or {}) + len(state.get("servers") or {})
        if total > MAX_POLICY_ENTRIES:
            raise ValueError(f"El número total de entradas ({total}) supera el máximo permitido ({MAX_POLICY_ENTRIES}).")

    def _validate_state_payload(self, state: dict, scope: str, context: SecurityContext) -> tuple[str | None, list[str] | None, dict | None, dict | None]:
        if not isinstance(state, dict):
            raise ValueError("El estado de políticas debe ser un diccionario.")

        clean_global = None
        if "globalMcpPolicy" in state:
            pol = state["globalMcpPolicy"]
            if pol not in GLOBAL_POLICIES:
                raise ValueError(f"Política global no válida: '{pol}'. Válidas: {GLOBAL_POLICIES}")
            clean_global = pol

        clean_rules = self._validate_directory_rules(state["directoryRules"], context) if "directoryRules" in state else None
        clean_tools = self._validate_policy_entries(state["tools"], "tools", scope) if "tools" in state else None
        clean_servers = self._validate_policy_entries(state["servers"], "servers", scope) if "servers" in state else None
        return clean_global, clean_rules, clean_tools, clean_servers

    def import_state(self, state: dict, context: SecurityContext):
        """
        Aplica un parche parcial persistente (None revoca) y devuelve el estado exportado.
        `addDirectoryRules` añade reglas a las guardadas dentro de la misma transacción y
        `commandPatterns` sustituye los patrones de comando guardados.
        """
        clean_global, clean_rules, clean_tools, clean_servers = self._validate_state_payload(state, SCOPE_PERMANENT, context)
        added_rules = self._validate_directory_rules(state["addDirectoryRules"], context) if "addDirectoryRules" in state else []
        clean_patterns = normalize_command_patterns(state["commandPatterns"]) if "commandPatterns" in state else None

        def mutator(current: dict) -> dict:
            if clean_global is not None:
                current["globalMcpPolicy"] = clean_global
            if clean_rules is not None:
                current["directoryRules"] = clean_rules
            if added_rules:
                current["directoryRules"] = self._append_rules(current["directoryRules"], added_rules)
            if clean_tools is not None:
                current["tools"] = self._apply_entry_patch(current.get("tools"), clean_tools)
            if clean_servers is not None:
                current["servers"] = self._apply_entry_patch(current.get("servers"), clean_servers)
            if clean_patterns is not None:
                current["commandPatterns"] = clean_patterns
            self._check_entry_limit(current)
            return current
        self._update_permanent(mutator)
        with self._lock:
            if clean_global is not None:
                self.session_global_policy = None
            if clean_rules is not None:
                self.session_directory_rules = None
            elif added_rules and self.session_directory_rules is not None:
                self.session_directory_rules = self._append_rules(self.session_directory_rules, added_rules)
            # Una escritura permanente sustituye o revoca la entrada de sesión de la misma herramienta o servidor.
            for kind, patch in (("tools", clean_tools), ("servers", clean_servers)):
                for item_id in patch or {}:
                    self._session_map(kind).pop(item_id, None)
        return self.export_state(context)

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
        clean_global, clean_rules, clean_tools, clean_servers = self._validate_state_payload(state, SCOPE_SESSION, context)
        raw_patterns = state.get("commandPatterns")
        session_patterns = self._limit_patterns(clean_pattern_list(raw_patterns.get("session") or [], "commandPatterns.session")) \
            if isinstance(raw_patterns, dict) else None

        with self._lock:
            rules = clean_rules if clean_rules is not None else self.session_directory_rules
            tools = self._apply_entry_patch(self.session_tools, clean_tools or {})
            servers = self._apply_entry_patch(self.session_servers, clean_servers or {})
            self._check_entry_limit({"directoryRules": rules, "tools": tools, "servers": servers})
            if clean_global is not None:
                self.session_global_policy = clean_global
            self.session_directory_rules, self.session_tools, self.session_servers = rules, tools, servers
            if session_patterns is not None:
                self.session_command_patterns = session_patterns
        return self.export_state(context)

    @staticmethod
    def _limit_patterns(patterns: list[str]) -> list[str]:
        if len(patterns) > MAX_COMMAND_PATTERNS:
            raise ValueError(f"Hay {len(patterns)} patrones de comando; el máximo es {MAX_COMMAND_PATTERNS}.")
        return patterns

    @staticmethod
    def get_default_directory_rule(context: SecurityContext) -> str:
        base = normalize_directory_path(str(context.workspace_dir))
        return f"RW:{base}" if base == "/" else f"RW:{base}/**"

    @staticmethod
    def _resolve_rule_pattern(pattern: str, workspace_dir: Path | None = None) -> str:
        base, sep, rest = pattern.partition("*")
        if base:
            # Mismo resolutor que SecurityContext.resolve_path (destino y base de la regla).
            target = Path(base) if (not workspace_dir or os.path.isabs(base)) else Path(workspace_dir) / base
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

    def clear_session(self):
        """Limpia todas las autorizaciones temporales de la sesión activa."""
        with self._lock:
            self.session_global_policy = None
            self.session_directory_rules = None
            self.session_tools.clear()
            self.session_servers.clear()
            self.session_command_patterns = []
            self.pending_challenges.clear()

    def create_challenge(self, tool_name: str, args: dict, decision: AccessDecision, *, context: SecurityContext,
                         server_name: str = "", server_id: str = "", origin: str = "local",
                         job_key: str | None = None) -> dict:
        """Genera un reto estructurado para solicitar confirmación interactiva al usuario."""
        challenge_id = f"auth_{secrets.token_urlsafe(16)}"
        now = int(time.time() * 1000)
        cwd = str(context.workspace_dir.resolve())
        with self._lock:
            expired = [cid for cid, c in self.pending_challenges.items() if now - c.get("createdAt", 0) > CHALLENGE_TTL_MS]
            for cid in expired:
                self.pending_challenges.pop(cid, None)

            challenge_data = {
                "id": challenge_id,
                "toolName": tool_name,
                "arguments": args,
                "serverName": server_name or decision.server_name,
                "serverId": server_id or decision.server_id,
                "origin": origin,
                "jobKey": job_key,
                "cwd": cwd,
                "createdAt": now
            }
            self.pending_challenges[challenge_id] = challenge_data
            return challenge_data

    def authorize_challenge(self, challenge_id: str, decision: str, *, context: SecurityContext,
                            command_pattern: str | None = None, directory_rule: str | None = None) -> dict | None:
        """
        Valida la decisión, consume el reto (una única ejecución) y registra la decisión.
        Devuelve el reto consumido, o None si no existe, caducó, cambió el cwd o la decisión no aplica.
        Una decisión mal formada lanza ValueError y deja el reto pendiente.
        """
        now = int(time.time() * 1000)
        current_cwd = str(context.workspace_dir.resolve())
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
            pattern = self._validate_command_pattern(decision, command_pattern, challenge)
            rules = self._validate_directory_rules([directory_rule], context) if directory_rule else []
            self.pending_challenges.pop(challenge_id)
        self._record_decision(challenge, decision, pattern, rules, context)
        return challenge

    def revoke_challenge(self, challenge_id: str) -> bool:
        with self._lock:
            return self.pending_challenges.pop(challenge_id, None) is not None

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
            with self._lock:
                if pattern:
                    self.session_command_patterns = self._limit_patterns(
                        clean_pattern_list(self.session_command_patterns + [pattern], "commandPatterns.session"))
                else:
                    self.session_tools[tool] = self._make_entry("tools", POLICY_ALLOW, SCOPE_SESSION, server_name, tool)
        permanent = decision in ("allow_project", "allow_always", "allow_server_always")
        if not permanent and not rules:
            return
        project = self._project_key(context)

        def mutator(state: dict) -> dict:
            saved = state["commandPatterns"]
            if pattern and decision == "allow_project":
                projects = {**saved["projects"], project: [*(saved["projects"].get(project) or []), pattern]}
                state["commandPatterns"] = normalize_command_patterns({**saved, "projects": projects})
            elif pattern and decision == "allow_always":
                state["commandPatterns"] = normalize_command_patterns({**saved, "global": [*saved["global"], pattern]})
            elif decision == "allow_always":
                state["tools"][tool] = self._make_entry("tools", POLICY_ALLOW, SCOPE_PERMANENT, server_name, tool)
            elif decision == "allow_server_always":
                state["servers"][server_id] = self._make_entry("servers", POLICY_ALLOW, SCOPE_PERMANENT, server_name or server_id)
            if rules:
                state["directoryRules"] = self._append_rules(state["directoryRules"], rules)
            self._check_entry_limit(state)
            return state
        self._update_permanent(mutator)
        with self._lock:
            if decision == "allow_always" and not pattern:
                self.session_tools.pop(tool, None)
            elif decision == "allow_server_always":
                self.session_servers.pop(server_id, None)
            if rules and self.session_directory_rules is not None:
                self.session_directory_rules = self._append_rules(self.session_directory_rules, rules)

    def evaluate_authorization(self, tool_name: str, raw_args: dict | None, context: SecurityContext,
                               server_name: str = "", server_id: str = "") -> AccessDecision:
        """
        Evalúa si la invocación de una herramienta está permitida, denegada o requiere confirmación.
        Jerarquía:
        1. Lista negra explícita (deny individual o de servidor).
        2. Herramientas de control de procesos (check_command).
        3. Política global allow_all -> allow incondicional.
        4. Política granular de herramienta -> allow.
        5. Política de servidor completo -> allow incondicional para sus herramientas.
        6. run_command: patrones de comando y, si no lo cubren, Workspace Trust.
        7. Herramientas con ruta: reglas de directorio y Workspace Trust.
        8. Por defecto -> ask (solicitar confirmación), con la regla sugerida si la hay.
        """
        status, reason, details, offer = self._evaluate(tool_name, dict(raw_args or {}), context, server_id)
        return AccessDecision(allowed=status == POLICY_ALLOW, status=status, reason=reason,
                              requires_approval=status == POLICY_ASK, tool_id=tool_name, server_name=server_name,
                              server_id=server_id, details=details, rule_offer=offer)

    def _evaluate(self, tool_name: str, args: dict, ctx: SecurityContext, server_id: str) -> tuple[str, str, str, dict | None]:
        view = self._effective_state()
        tool_policy = (view["tools"].get(tool_name) or {}).get("policy")
        server_policy = (view["servers"].get(server_id) or {}).get("policy") if server_id else None
        if tool_policy == POLICY_DENY:
            return POLICY_DENY, "granular_deny_rule", "", None
        if server_policy == POLICY_DENY:
            return POLICY_DENY, "server_deny_rule", "", None
        if tool_name == JOB_CONTROL_TOOL:
            return POLICY_ALLOW, "job_control_tool", "", None
        if view["globalMcpPolicy"] == GLOBAL_POLICY_ALLOW_ALL:
            return POLICY_ALLOW, "mcp_global_allow_all", "", None
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

    def _evaluate_command(self, raw_command: str, view: dict, ctx: SecurityContext) -> tuple[str, str, str, dict | None]:
        """
        Valida cada subcomando por separado: un cd tiene que llevar a una carpeta cubierta por las reglas
        de directorio, y los subcomandos siguientes se ejecutan en ella; el resto tiene que estar cubierto
        por un patrón o, con Workspace Trust, quedarse en el proyecto (tras una tubería, solo un filtro).
        Un patrón es una vía más de permitir, nunca una puerta que anule Workspace Trust.
        """
        segments = split_command(raw_command)
        if segments is None:
            return (POLICY_ASK, "command_chaining_requires_approval",
                    f"El comando usa sintaxis de shell que no se puede validar por partes: {raw_command}", None)
        patterns = self._command_patterns(view, ctx)
        trust = view["globalMcpPolicy"] == GLOBAL_POLICY_WORKSPACE_TRUST
        cwd, by_trust, uncovered = ctx.workspace_dir, False, []
        for operator, segment in segments:
            directory = cd_target(segment)
            if directory is not None:
                target = directory if re.match(r"^(/|[A-Za-z]:[\\/])", directory) else str(cwd / directory)
                if not any(self.evaluate_directory_rule(a, target, view["directoryRules"], ctx)["allowed"] for a in ("R", "W")):
                    return (POLICY_ASK, "command_directory_outside_rules",
                            f"El comando se ejecuta fuera de las reglas de directorio: {directory}", None)
                cwd = ctx.resolve_path(target)
            elif any(matches_command_pattern(segment, p) for p in patterns):
                continue
            elif trust and is_workspace_local_command(segment) and (
                    operator != "|" or segment.split()[0] in WORKSPACE_TRUST_PIPE_FILTERS):
                by_trust = True
            else:
                uncovered.append(segment)
        if not uncovered:
            return POLICY_ALLOW, "workspace_trust_command" if by_trust else "command_pattern_allow", "", None
        if trust:
            reason, details = "workspace_trust_external_or_global_command", "El comando accede a recursos globales o rutas fuera del espacio de trabajo."
        else:
            reason, details = ("command_outside_allowed_patterns", f"Comando fuera de los patrones autorizados: {'; '.join(uncovered)}") if patterns else ("mcp_default_ask", "")
        return POLICY_ASK, reason, details, command_rule_offer(uncovered)

    def _evaluate_path(self, tool_name: str, access: str, path: str, view: dict, ctx: SecurityContext) -> tuple[str, str, str, dict | None]:
        """Herramientas integradas de ficheros: reglas de directorio y, con Workspace Trust, el proyecto."""
        dir_eval = self.evaluate_directory_rule(access, path, view["directoryRules"], ctx)
        if dir_eval["allowed"]:
            return POLICY_ALLOW, "directory_rule_allow", "", None
        if view["globalMcpPolicy"] == GLOBAL_POLICY_WORKSPACE_TRUST and ctx.is_inside_workspace(path):
            return POLICY_ALLOW, "workspace_trust_allow", "", None
        return (POLICY_ASK, "directory_rule_required", f"La ruta no coincide con una regla {access}: {path}",
                directory_rule_offer(tool_name, access, dir_eval["path"] or path))


ACCESS_CONTROLLER = AccessController()
