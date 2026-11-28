"""Reglas de permisos sin estado: políticas, reglas de directorio, patrones de comando y ofertas de regla."""

from __future__ import annotations

import dataclasses
import functools
import itertools
import re
import shlex

from core.environment import DETECTED_OS
from security.context import normalize_directory_path

# Shell con la que run_command ejecuta los comandos (tools/jobs.py): PowerShell en Windows y sh en el resto.
# Los comandos se parten y se leen con sus reglas: en PowerShell la \ es un carácter más (C:\x), el escape
# es la comilla invertida y dentro de comillas la comilla se repite ('it''s').
COMMAND_SHELL = "powershell" if DETECTED_OS == "windows" else "posix"

POLICY_ALLOW = "allow"
POLICY_DENY = "deny"
POLICY_ASK = "ask"
SCOPE_PERMANENT = "permanent"
SCOPE_SESSION = "session"
AUTHORIZE_DECISIONS = ("allow_once", "allow_session", "allow_project", "allow_always", "allow_server_always")
DIRECTORY_RULE_PATTERN = re.compile(r"^([RWX]+):(.+)$")
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
# Cada redirección acaba donde acaba la palabra: '>/dev/null.txt', '2>&10' o '>$null.txt' son otra cosa.
_REDIRECTION_END = r"(?=[\s;&|)]|$)"
SAFE_REDIRECTION_PATTERN = re.compile(rf"(?:&>\s*/dev/null|\d?>>?\s*/dev/null|\d?>&\d){_REDIRECTION_END}")
# En PowerShell /dev/null es un fichero más: lo que se descarta va a $null.
POWERSHELL_SAFE_REDIRECTION_PATTERN = re.compile(rf"(?:[\d*]?>>?\s*\$null|\d?>&\d){_REDIRECTION_END}")
# Lo que impide validar un comando por partes: sustitución de comandos o de procesos y saltos de línea, y en
# PowerShell además los bloques de script ({ }), que ejecutan lo que llevan dentro.
SHELL_SPLIT_UNSUPPORTED = re.compile(r"[`\n\r]|\$\(|[<>]\(")
POWERSHELL_SPLIT_UNSUPPORTED = re.compile(r"[`\n\r{}]|\$\(|[<>]\(")
# PowerShell también acepta como comillas las tipográficas: se leen como las ASCII.
_POWERSHELL_QUOTES = str.maketrans({"\u2018": "'", "\u2019": "'", "\u201a": "'", "\u201b": "'",
                                    "\u201c": '"', "\u201d": '"', "\u201e": '"'})
# Palabras que cambian cómo se ejecuta lo que sigue (bloques, bucles, prefijos, cambios de carpeta ocultos o texto
# que se vuelve a leer como comando: eval, source, iex).
SHELL_KEYWORDS = frozenset(["if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac",
                            "select", "function", "{", "}", "!", "[[", "time", "coproc", "pushd", "popd", "builtin",
                            "eval", "exec", "source", ".", "set-location", "sl", "chdir", "push-location",
                            "pop-location", "iex", "invoke-expression"])
ENV_ASSIGNMENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*=.*")
# Un cd a una carpeta que solo la shell conoce: variables, ~, comodines o la anterior.
CD_UNSAFE_TARGET = re.compile(r"[$~*?\[{]")
WORKSPACE_TRUST_PIPE_FILTERS = frozenset([
    "head", "tail", "grep", "egrep", "fgrep", "rg", "wc", "sort", "uniq", "cut", "tr", "column", "nl", "cat", "jq"
])
# Órdenes que actúan sobre todo el sistema (privilegios, discos, energía, servicios): nunca son locales
# al proyecto aunque no lleven rutas. mkfs incluye su familia (mkfs.ext4, mkfs.vfat...).
WORKSPACE_TRUST_GLOBAL_COMMANDS = frozenset([
    "sudo", "su", "doas", "pkexec", "run0", "mkfs", "reboot", "shutdown", "poweroff", "halt", "systemctl"
])
# Las de Windows solo cuentan con PowerShell: en sh, 'npm run format' no formatea ningún disco.
POWERSHELL_GLOBAL_COMMANDS = WORKSPACE_TRUST_GLOBAL_COMMANDS | frozenset([
    "runas", "gsudo", "format", "diskpart", "bcdedit", "restart-computer", "stop-computer", "format-volume",
    "clear-disk", "initialize-disk", "stop-service", "restart-service", "set-service"
])
# Lo que separa palabras dentro de un argumento que otra shell volvería a interpretar (sh -c '...').
_NESTED_WORD_SEPARATORS = re.compile(r"[\s;&|()<>`'\"]+")
WORKSPACE_TRUST_OUTSIDE_REFERENCE = re.compile(r"(?:^|[\s=:'\"])(?:[\\/~]|[A-Za-z]:[\\/])|\$|(?:^|[\s=:'\"\\/])\.\.(?=[\s\\/'\"]|$)")
_COMMAND_PATH_START = re.compile(r"^(?:[/\\]|(?:\.\.(?:$|[/\\]))|[A-Za-z]:[\\/])")
_COMMAND_INTERNAL_OUTSIDE_REF = re.compile(r"[\s:'\"](?:[\\/~]|[A-Za-z]:[\\/]|\.\.(?:$|[\s\\/]))")


def parse_directory_rule(raw_rule: str) -> dict | None:
    """Parsea una regla '<permisos>:path' (combinación sin repetidos de R, W, X) normalizando su ruta."""
    if not isinstance(raw_rule, str):
        return None
    match = DIRECTORY_RULE_PATTERN.match(raw_rule.strip())
    if not match:
        return None
    raw_access = match.group(1)
    if len(set(raw_access)) != len(raw_access):
        return None
    access = "".join(ch for ch in ("R", "W", "X") if ch in raw_access)
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
    # /**/ también casa ninguna carpeta intermedia: /a/**/b cubre /a/b.
    escaped = re.escape(pattern).replace(r"\*\*/", "(?:.*/)?").replace(r"\*\*", ".*").replace(r"\*", "[^/]*")
    return bool(re.fullmatch(escaped, path))


def split_command(cmd: str) -> list[tuple[str, str]] | None:
    """
    Parte un comando por sus operadores de shell fuera de comillas (&&, ||, ; y |) en
    [(operador anterior, subcomando)], para validar cada subcomando por separado. None si usa algo
    que no se puede validar por partes: sustitución de comandos, saltos de línea, '&' en segundo
    plano, subshells, redirecciones a ficheros (salvo las de SAFE_REDIRECTION_PATTERN), palabras
    reservadas de la shell, comillas sin cerrar, un subcomando vacío o un cd que no sea 'cd <dir>'.
    """
    powershell = COMMAND_SHELL == "powershell"
    if not isinstance(cmd, str):
        return None
    if powershell:
        cmd = cmd.translate(_POWERSHELL_QUOTES)
    if (POWERSHELL_SPLIT_UNSUPPORTED if powershell else SHELL_SPLIT_UNSUPPORTED).search(cmd):
        return None
    text = (POWERSHELL_SAFE_REDIRECTION_PATTERN if powershell else SAFE_REDIRECTION_PATTERN).sub(" ", cmd)
    segments, current, operator, quote, i = [], "", "", "", 0
    while i < len(text):
        ch = text[i]
        two = text[i:i + 2]
        if quote:
            # En PowerShell la \ no escapa: "C:\" cierra la comilla.
            if ch == "\\" and quote == '"' and not powershell:
                current += two
                i += 2
                continue
            quote = "" if ch == quote else quote
        elif ch == "\\" and not powershell:
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
        words = split_words(segment)
    except ValueError:
        return False
    if not words or words[0].lower() in SHELL_KEYWORDS:
        return False
    # Un cd tras variables ('x=1 cd /etc') o tras 'command' y sus opciones ('command -p cd', 'command -- cd')
    # también cambia la carpeta: no se admite.
    rest = list(itertools.dropwhile(ENV_ASSIGNMENT.fullmatch, words))
    if rest[:1] == ["command"]:
        rest = list(itertools.dropwhile(lambda word: word.startswith("-"), rest[1:]))
    if rest[:1] == ["cd"] and not _is_cd(words[0]):
        return False
    return not _is_cd(words[0]) or (len(words) == 2 and not words[1].startswith("-") and not CD_UNSAFE_TARGET.search(words[1]))


def _is_cd(word: str) -> bool:
    """PowerShell no distingue mayúsculas en los nombres de órdenes: CD también cambia de carpeta."""
    return (word.lower() if COMMAND_SHELL == "powershell" else word) == "cd"


def split_words(segment: str) -> list[str]:
    """Palabras de un subcomando tal como las verá la shell de run_command, sin comillas; ValueError si queda una sin cerrar."""
    if COMMAND_SHELL != "powershell":
        return shlex.split(segment)
    text = segment.translate(_POWERSHELL_QUOTES)
    words, current, quote, in_word, i = [], "", "", False, 0
    while i < len(text):
        ch = text[i]
        if quote:
            if ch == quote and text[i + 1:i + 2] == quote:
                current += ch
                i += 2
                continue
            if ch == quote:
                quote = ""
            else:
                current += ch
        elif ch in "'\"":
            quote, in_word = ch, True
        elif ch.isspace():
            if in_word:
                words.append(current)
            current, in_word = "", False
        else:
            current, in_word = current + ch, True
        i += 1
    if quote:
        raise ValueError("Comillas sin cerrar.")
    if in_word:
        words.append(current)
    return words


def cd_target(segment: str) -> str | None:
    """Carpeta de un subcomando 'cd <dir>' ya validado por split_command, o None si no es un cd."""
    words = split_words(segment)
    return words[1] if _is_cd(words[0]) else None


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


def invokes_global_command(segment: str) -> bool:
    """
    Si el subcomando nombra una orden global en cualquier palabra, tal como la verá la shell: sin comillas
    ni escapes, por su nombre aunque vaya con ruta, y también dentro de un argumento que otra shell
    reinterpretaría (sh -c 'sudo ls'), sin distinguir mayúsculas ni .exe. Cualquier posición cuenta, así que
    también las que van tras env, command, nice o xargs. Un subcomando que no se puede partir cuenta como global.
    """
    try:
        tokens = split_words(segment)
    except ValueError:
        return True
    global_commands = POWERSHELL_GLOBAL_COMMANDS if COMMAND_SHELL == "powershell" else WORKSPACE_TRUST_GLOBAL_COMMANDS
    for token in tokens:
        for word in _NESTED_WORD_SEPARATORS.split(token):
            base = word.rsplit("/", 1)[-1]
            # Una \ es un escape para una shell anidada (sh -c 's\udo') o un separador de ruta en Windows.
            for name in (base.replace("\\", ""), base.rsplit("\\", 1)[-1]):
                name = name.lower().removesuffix(".exe")
                if name in global_commands or name.startswith("mkfs."):
                    return True
    return False


def is_workspace_local_command(segment: str) -> bool:
    """Filtro de Workspace Trust para un subcomando: sin órdenes globales ni referencias fuera del proyecto."""
    return not invokes_global_command(segment) and not WORKSPACE_TRUST_OUTSIDE_REFERENCE.search(segment)


def command_outside_references(segment: str) -> list[str] | None:
    """
    Rutas externas o con '..' que aparecen como argumentos del subcomando para validarlas frente a
    directoryRules; [] si es local al proyecto, o None si lleva órdenes globales, $, ~, texto con
    rutas incrustadas no validables como argumento de ruta, o si el texto sale del proyecto pero sus
    palabras no dejan ninguna ruta que validar (grep -f"/etc/passwd" . queda en -f/etc/passwd).
    """
    if is_workspace_local_command(segment):
        return []
    if invokes_global_command(segment) or "$" in segment or "~" in segment:
        return None
    try:
        tokens = split_words(segment)
    except ValueError:
        return None
    if not tokens:
        return None
    refs = []
    for token in tokens:
        if not WORKSPACE_TRUST_OUTSIDE_REFERENCE.search(token):
            continue
        candidate = token.split("=", 1)[1] if ("=" in token and not _COMMAND_PATH_START.match(token)) else token
        tail = candidate[2:] if re.match(r"^[A-Za-z]:[\\/]", candidate) else candidate[1:]
        if not _COMMAND_PATH_START.match(candidate) or _COMMAND_INTERNAL_OUTSIDE_REF.search(tail):
            return None
        refs.append(candidate)
    return refs or None


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
        args = split_words(command)
    except ValueError:
        return False
    if not words or len(args) < len(words) or (len(args) > len(words) and not rest):
        return False
    first = next((args[0][len(d):] for d in SYSTEM_BIN_DIRS if args[0].startswith(d)), args[0])
    for (regex, wildcard), arg in zip(words, [first, *args[1:]], strict=False):
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


def check_command_pattern_limit(global_patterns: list[str], project_patterns: list[str], other_project_count: int) -> None:
    """Comprueba que el total de patrones globales y de todos los proyectos no supere MAX_COMMAND_PATTERNS."""
    total = len(global_patterns) + len(project_patterns) + other_project_count
    if total > MAX_COMMAND_PATTERNS:
        raise ValueError(f"Hay {total} patrones de comando; el máximo es {MAX_COMMAND_PATTERNS}.")


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
