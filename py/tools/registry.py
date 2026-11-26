"""Registro de las herramientas locales: definiciones publicadas al modelo, manejadores y validación de argumentos contra su esquema."""

from __future__ import annotations

from core.environment import DETECTED_OS
from core.limits import MAX_COMMAND_LENGTH, MAX_HTTP_BODY_BYTES, MAX_PATH_LENGTH
from storage.db import MAX_AGENT_ID_LENGTH, MAX_CONVERSATION_ID_LENGTH
from tools.agents import (
    AGENT_LIST_RESULT_MAX_CHARS,
    AGENT_LIST_TOTAL_CHARS,
    AGENT_MAX_WAIT,
    AGENT_PRUNE_KEEP_MAX,
    AGENT_RESULT_PAGE_CHARS,
    AGENTS_TOOL,
    LAUNCH_AGENT_TOOL,
    MAX_LAUNCH_PROMPT_LENGTH,
    check_agents,
    launch_agent,
)
from tools.browser_action import BROWSER_ACTIONS, browser_action
from tools.browser_secret import BROWSER_SECRET_MODES, browser_fill_secret
from tools.filesystem import READ_FILE_DEFAULT_MAX_BYTES, edit_file, get_diagnostics, list_directory, read_file, search_files, write_file
from tools.jobs import (
    COMMAND_DEFAULT_TIMEOUT,
    COMMAND_MAX_TIMEOUT,
    CHECK_PATTERN_MAX_CHARS,
    COMMAND_MAX_WAIT,
    check_command,
    run_command,
)

LOCAL_TOOLS_DEFINITIONS = [
    {
        "name": "list_directory",
        "description": "List files and directories in a local directory with safe bounded recursive traversal.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "maxLength": MAX_PATH_LENGTH, "description": "Relative or absolute directory path (defaults to '.')"},
                "recursive": {"type": "boolean", "description": "If true, traverses subdirectories up to depth 3", "default": False}
            }
        }
    },
    {
        "name": "read_file",
        "description": "Read a text file, whole or by line range, or only its last lines with tail_lines (like tail -n): use tail_lines for logs that keep growing.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "maxLength": MAX_PATH_LENGTH, "description": "File path"},
                "start_line": {"type": "integer", "description": "First line (1-based)", "default": 1},
                "end_line": {"type": "integer", "description": "Last line (inclusive)"},
                "max_lines": {"type": "integer", "description": "Line cap if no end_line", "default": 500},
                "max_bytes": {"type": "integer", "description": "Byte cap", "default": READ_FILE_DEFAULT_MAX_BYTES},
                "tail_lines": {
                    "type": "integer",
                    "description": "Return only the last N lines (max 2000), without terminal color codes and keeping the last state of progress bars; start_line and end_line are ignored"
                }
            },
            "required": ["path"]
        }
    },
    {
        "name": "write_file",
        "description": "Create or overwrite a file completely and atomically.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "maxLength": MAX_PATH_LENGTH, "description": "Path to the file to write"},
                "content": {"type": "string", "maxLength": MAX_HTTP_BODY_BYTES, "description": "Full content of the file"}
            },
            "required": ["path", "content"]
        }
    },
    {
        "name": "edit_file",
        "description": (
            "Replace old_str with new_str in an existing file. "
            "For several changes, in this file or in others, emit several edit_file calls in the same response; "
            "they are applied in order, each one on the result of the previous one."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "maxLength": MAX_PATH_LENGTH, "description": "File path"},
                "old_str": {"type": "string", "maxLength": MAX_HTTP_BODY_BYTES, "description": "Exact text to replace; must occur once unless replace_all is true"},
                "new_str": {"type": "string", "maxLength": MAX_HTTP_BODY_BYTES, "description": "Replacement text"},
                "replace_all": {"type": "boolean", "description": "Replace every occurrence of old_str (e.g. to rename an identifier)", "default": False}
            },
            "required": ["path", "old_str", "new_str"]
        }
    },
    {
        "name": "search_files",
        "description": (
            "Search project files for plain text, case-insensitively, and return each matching line with its file and line number. "
            "Searches a directory recursively or a single file. Example: search_files(query='validate_token|check_token', path='src')."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "maxLength": 4096,
                    "description": "One or more texts separated by |, searched as plain text (not a regular expression); a line matches if it contains any of them"
                },
                "path": {"type": "string", "maxLength": MAX_PATH_LENGTH, "description": "Directory to search recursively, or a single file (defaults to '.')", "default": "."},
                "file_pattern": {"type": "string", "maxLength": 256, "description": "Optional glob filter (e.g. *.js, *.py)"},
                "max_results": {"type": "integer", "description": "Maximum number of matching lines to return (default 100, max 500)", "default": 100}
            },
            "required": ["query"]
        }
    },
    {
        "name": "run_command",
        "description": (
            "Run a PowerShell command in the project directory and return its exit code and output (stdout and stderr combined). "
            "Each call starts a fresh PowerShell in the project directory: Set-Location and $env: changes do not carry over to later calls, "
            "so chain them with ; in the same command. "
            if DETECTED_OS == "windows"
            else
            "Run a shell command (bash) in the project directory and return its exit code and output (stdout and stderr combined). "
            "Each call starts a fresh shell in the project directory: cd, export or source/activate do not carry over to later calls, "
            "so chain them with && in the same command. "
        ) + (
            "It waits up to timeout_seconds; a command still running then is not killed: it keeps running in the background "
            "and the result gives its job_id. "
            "Use background=true from the start for anything that takes minutes (generations, builds, training, long test suites) "
            "and for servers or watchers that do not finish on its own; then follow it with check_command. "
            f"Never run a command again while it is still running. Host OS: {DETECTED_OS}."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "maxLength": MAX_COMMAND_LENGTH,
                    "description": (
                        "PowerShell command to run (e.g. git status; npm test)"
                        if DETECTED_OS == "windows"
                        else "Shell command to run (e.g. git status, npm test)"
                    )
                },
                "timeout_seconds": {"type": "integer", "description": f"Seconds to wait for the command before moving it to the background (default {COMMAND_DEFAULT_TIMEOUT}, max {COMMAND_MAX_TIMEOUT}). Ignored with background=true.", "default": COMMAND_DEFAULT_TIMEOUT},
                "background": {"type": "boolean", "description": "Return after a few seconds and keep the command running; returns a job_id for check_command.", "default": False}
            },
            "required": ["command"]
        }
    },
    {
        "name": "check_command",
        "description": (
            "Check a command started by run_command: returns its status and the output produced since the last check. "
            "Use wait_seconds to wait for it to finish (a maximum: it returns as soon as the command ends), add pattern to "
            "return as soon as a new output line matches it, "
            f"or stop=true to terminate it. Example: check_command(job_id=4, wait_seconds={COMMAND_MAX_WAIT}, pattern='error|Traceback') "
            f"returns when the command finishes, prints an error, or after {COMMAND_MAX_WAIT} s. To follow a long command until it finishes "
            f"(also when the user asks to be told when it ends), call it again with wait_seconds={COMMAND_MAX_WAIT} each time it returns still running."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "job_id": {"type": "integer", "description": "job_id returned by run_command"},
                "wait_seconds": {"type": "integer", "description": f"Maximum seconds to wait for the command to finish; returns earlier when it does (default 0, max {COMMAND_MAX_WAIT})", "default": 0},
                "stop": {"type": "boolean", "description": "Terminate the command and its child processes", "default": False},
                "pattern": {
                    "type": "string",
                    "maxLength": CHECK_PATTERN_MAX_CHARS,
                    "description": "One or more texts separated by |, searched case-insensitively as plain text (not a regular expression) in each new output line; with wait_seconds, returns as soon as a line contains one"
                }
            },
            "required": ["job_id"]
        }
    },
    {
        "name": "get_diagnostics",
        "description": "Retrieve syntax diagnostics and code errors for a file or the entire workspace.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "maxLength": MAX_PATH_LENGTH, "description": "Path to the file or directory to inspect (defaults to '.')"}
            }
        }
    },
    {
        "name": "browser_action",
        "description": "Control a headless browser (Playwright) for web navigation, UI testing, and visual inspection via screenshots.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": list(BROWSER_ACTIONS),
                    "maxLength": 32,
                    "description": "Action to perform in the browser"
                },
                "url": {"type": "string", "maxLength": 4096, "description": "Target URL for navigate or screenshot"},
                "selector": {"type": "string", "maxLength": 1024, "description": "CSS selector for click or fill actions"},
                "value": {"type": "string", "maxLength": MAX_HTTP_BODY_BYTES, "description": "Text value to type for fill action"}
            },
            "required": ["action"]
        }
    },
    {
        "name": "browser_fill_secret",
        "description": (
            "Fill a saved project secret into Playwright MCP without exposing its value to the model or chat history. "
            "Use mode='input' with ref (for text/password inputs via browser_type) or mode='keypad' with keypad_map "
            "mapping each character (e.g. '0'..'9') to its button ref or [x, y] coordinates for virtual keypads."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "secret": {"type": "string", "maxLength": 64, "description": "Name of the saved project secret"},
                "mode": {"type": "string", "enum": list(BROWSER_SECRET_MODES), "maxLength": 16, "description": "Target mode: 'input' or 'keypad'"},
                "ref": {"type": "string", "maxLength": 128, "description": "Playwright snapshot element ref for mode='input'"},
                "element": {"type": "string", "maxLength": 256, "description": "Human-readable description of the input element"},
                "submit": {"type": "boolean", "description": "Press Enter after typing in mode='input'", "default": False},
                "keypad_map": {"type": "object", "description": "Map of character -> button ref string or [x, y] coordinates for mode='keypad'"}
            },
            "required": ["secret", "mode"]
        }
    }
]
# Solo se publica en una ejecución --run-file con watchAgents (server/rpc.py), que además la autoriza; fuera de ella
# el manejador se niega a responder.
CHECK_AGENTS_DEFINITION = {
    "name": AGENTS_TOOL,
    "description": (
        "Status of the agents that this run supervises (watchAgents), in this project or, with project, in another one. Without arguments, one entry per "
        "agent with its latest conversation: status (running, needs_input, completed, error, limit), step, pending input, "
        f"error, warnings, token usage of the run and its final answer when it fits ({AGENT_LIST_RESULT_MAX_CHARS} characters each, "
        f"{AGENT_LIST_TOTAL_CHARS} in all; otherwise only result_chars). With agent or conversation_id, the final answer in blocks of "
        f"{AGENT_RESULT_PAGE_CHARS} characters (pass next_offset as offset for the next one) and, with include_turn=true, the messages of its last turn. "
        "To wait for the agents instead of calling it repeatedly, give wait_seconds: it keeps waiting while any of the "
        "agents asked about is running and returns at once when none is (returned_because: not_running), as soon as one "
        "of them turns needs_input or error (needs_attention) or when the time is up (wait_elapsed); call it again with "
        "wait_seconds while they are still running. Agents started with launch_agent are listed from the start. To clean up old conversations of the watched agents "
        "(for example, one per scheduled run), give prune_keep=N, optionally with agent: it deletes all but the N most recent "
        "conversations of each agent, never one that is running or waiting for the user, and lists what it deleted and skipped."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "agent": {"type": "string", "maxLength": MAX_AGENT_ID_LENGTH, "description": "Agent id <set>.<name>: details of its latest conversation"},
            "conversation_id": {"type": "string", "maxLength": MAX_CONVERSATION_ID_LENGTH, "description": "Details of this agent conversation"},
            "wait_seconds": {"type": "integer", "description": f"Maximum seconds to wait for a change of the agents asked about before answering (default 0, max {AGENT_MAX_WAIT})", "default": 0},
            "prune_keep": {"type": "integer", "description": f"Delete the older conversations of the watched agents (or of agent), keeping this many most recent per agent (0 to {AGENT_PRUNE_KEEP_MAX}); only when asked, never running or waiting ones"},
            "project": {"type": "string", "maxLength": MAX_PATH_LENGTH, "description": "Folder of another project whose agents to check (default: this run's project); its directory rules must give R (RW to prune)"},
            "offset": {"type": "integer", "description": "With agent or conversation_id: character offset of the final answer to read from (the next_offset of the previous call)", "default": 0},
            "include_turn": {"type": "boolean", "description": "With agent or conversation_id: also return the messages of its last turn, including tool results", "default": False}
        }
    }
}
LAUNCH_AGENT_DEFINITION = {
    "name": LAUNCH_AGENT_TOOL,
    "description": (
        "Start a watched agent from its run-file JSON (for example agents/report.json) as a separate run that keeps going "
        "after this run ends, and return its conversation_id and run_id. The run-file's agent must match watchAgents; it "
        "runs with the saved environment and permissions of its project. Give prompt to replace the run-file's prompt, "
        "and project to launch an agent of another project. Then follow it with check_agents, which can wait for it."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "run_file": {"type": "string", "maxLength": MAX_PATH_LENGTH, "description": "Path of the agent's run-file JSON inside the project"},
            "prompt": {"type": "string", "maxLength": MAX_LAUNCH_PROMPT_LENGTH, "description": "Task for this run, instead of the run-file's prompt"},
            "project": {"type": "string", "maxLength": MAX_PATH_LENGTH, "description": "Folder of another project to launch the agent in (default: this run's project); its directory rules must give RX"}
        },
        "required": ["run_file"]
    }
}
# Las de un master, que solo se publican en una ejecución --run-file con watchAgents.
MASTER_TOOL_DEFINITIONS = (CHECK_AGENTS_DEFINITION, LAUNCH_AGENT_DEFINITION)

LOCAL_TOOL_HANDLERS = {
    "list_directory": list_directory,
    "read_file": read_file,
    "write_file": write_file,
    "edit_file": edit_file,
    "run_command": run_command,
    "check_command": check_command,
    "search_files": search_files,
    "get_diagnostics": get_diagnostics,
    "browser_action": browser_action,
    "browser_fill_secret": browser_fill_secret,
    AGENTS_TOOL: check_agents,
    LAUNCH_AGENT_TOOL: launch_agent,
}


ARGUMENT_TYPES = {"string": str, "integer": int, "boolean": bool, "object": dict}


def _argument_error(name: str, value, prop: dict | None) -> str | None:
    """Por qué no vale un argumento según su propiedad del esquema, o None si vale."""
    if prop is None:
        return f"Argumento no permitido: {name}"
    expected_type = ARGUMENT_TYPES.get(prop.get("type"))
    if expected_type is None:
        return f"Tipo no admitido en la definición de '{name}': {prop.get('type')}"
    # bool es subclase de int: un booleano no vale como entero.
    if not isinstance(value, expected_type) or (expected_type is not bool and isinstance(value, bool)):
        return f"Tipo inválido para '{name}'"
    max_length = prop.get("maxLength")
    if max_length is not None and len(value) > max_length:
        return f"'{name}' excede el tamaño máximo permitido"
    return None


def validate_local_tool_arguments(tool_name: str, arguments: dict) -> str | None:
    """Valida tipos y límites de las herramientas locales a partir de su definición canónica."""
    definition = next((item for item in (*LOCAL_TOOLS_DEFINITIONS, *MASTER_TOOL_DEFINITIONS) if item["name"] == tool_name), None)
    if definition is None:
        return None

    schema = definition.get("inputSchema", {})
    properties = schema.get("properties", {})
    for name, value in arguments.items():
        error = _argument_error(name, value, properties.get(name))
        if error:
            return error

    for name in schema.get("required", ()):
        if name not in arguments:
            return f"Falta el argumento obligatorio: {name}"

    if tool_name == "browser_action":
        if arguments.get("action") not in BROWSER_ACTIONS:
            return f"Acción de navegador no permitida: {arguments.get('action')}"
    if tool_name == "browser_fill_secret":
        if arguments.get("mode") not in BROWSER_SECRET_MODES:
            return f"Modalidad no permitida: {arguments.get('mode')}"

    return None
