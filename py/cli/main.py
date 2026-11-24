"""Punto de entrada de zerochat: argumentos de la línea de órdenes, arranque del servidor, interfaz, ejecución desatendida y cierre."""

from __future__ import annotations

import argparse
import json
import os
import signal
import sys
import tempfile
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlencode

from auth.tokens import current_session_token, issue_runner_token, on_token_rotation
from browser.launch import launch_browser
from cli.console import ConsoleControl
from core.environment import (
    DEFAULT_HOST,
    DEFAULT_PORT,
    active_address,
    add_notice,
    ensure_virtual_environment,
    get_data_dir,
    get_dev_root,
    get_no_project_dir,
    get_static_root,
    is_loopback_host,
    get_venv_dir,
    reset_notices,
    set_active_address,
)
from core.logging import console_log, current_console_control, mute_console, set_console_control, timestamp_message
from core.version import DEFAULT_UI_URL, UI_VERSION, VERSION, check_version, is_installed_runtime
from run_mode.state import (
    DEFAULT_RUN_PROFILE,
    RUN_EXIT_ARGS,
    RUN_EXIT_BUSY,
    RUN_EXIT_SETUP,
    RUN_EXPORT_FORMATS,
    RUN_FILE_MAX_BYTES,
    RUN_LAUNCH_KEYS,
    RunSession,
    announce_run_conversation,
    check_no_active_run,
    current_run_session,
    discard_unstarted_run,
    parse_run_request,
    run_error,
    run_outcome,
    set_run_session,
)
from mcp.manager import GLOBAL_MCP_MANAGER
from run_mode.supervisor import launch_node_runner, run_supervisor
from security.context import SecurityContext, project_context, set_default_project_dir
from security.controller import ACCESS_CONTROLLER
from security.rules import (
    COMMAND_TOOL,
    POLICY_ALLOW,
    POLICY_DENY,
    get_integrated_path_access,
)
from server.handler import ZeroChatHTTPServer, ZeroChatServerHandler
from server.state import (
    DEFAULT_HEARTBEAT_GRACE,
    DEFAULT_HEARTBEAT_TIMEOUT,
    heartbeat_watchdog,
    set_exit_on_close,
    stop_zerochat_server,
)
from storage.db import (
    _validate_conversation_id,
    get_conversation,
    get_conversation_launch,
    get_general_profile,
    get_general_profile_by_name,
    get_general_profile_with_key,
    get_project_environment,
    list_general_profiles,
    mark_conversation_server_run,
)
from tools.agents import MASTER_TOOLS
from tools.browser_action import browser_action_availability
from tools.filesystem import list_directory, read_file, write_file
from tools.jobs import cleanup_orphan_jobs, run_command
from tools.registry import LOCAL_TOOL_HANDLERS


def remote_exposure_warning(host: str) -> str | None:
    """Devuelve el aviso de exposición en red si el host no es de bucle local."""
    if is_loopback_host(host):
        return None
    return (
        f"Escuchando en {host}: cualquiera en la red con el token puede ejecutar comandos "
        "en este equipo y el tráfico HTTP va sin cifrar."
    )


class ZeroChatArgumentParser(argparse.ArgumentParser):
    """Los errores de argumentos salen con RUN_EXIT_ARGS para no confundirse con los códigos de --prompt."""
    def error(self, message):
        self.print_usage(sys.stderr)
        self.exit(RUN_EXIT_ARGS, f"{self.prog}: error: {message}\n")


def build_parser() -> ZeroChatArgumentParser:
    """Opciones de la línea de órdenes."""
    parser = ZeroChatArgumentParser(description=f"ZeroChat Local Server v{VERSION}")
    # Desde Python 3.14 argparse colorea la ayuda con códigos ANSI; la consola la muestra en texto plano.
    parser.color = False  # pyright: ignore[reportAttributeAccessIssue] (atributo de Python 3.14)
    parser.add_argument("--port", type=int, default=None, help=f"Puerto de escucha (default: ZEROCHAT_PORT o {DEFAULT_PORT}; en modo ejecución, uno libre que elige el sistema)")
    parser.add_argument("--host", default=None, help=f"Host de escucha (default: ZEROCHAT_HOST o {DEFAULT_HOST}; el modo ejecución escucha siempre en {DEFAULT_HOST})")
    parser.add_argument("--ui-url", default=None, help="URL de la interfaz web a abrir (por defecto: interfaz local en desarrollo o GitHub Pages)")
    parser.add_argument("--no-browser", action="store_true", help="No abrir automáticamente el navegador")
    parser.add_argument("--keep-server", action="store_true", help="Servidor: seguir en marcha al cerrar el navegador (no se combina con --prompt)")
    parser.add_argument("--no-venv", action="store_true", help="Omitir la comprobación/creación de ~/zerochat/.venv")
    parser.add_argument("--test", action="store_true", help="Ejecutar autocomprobación interna de herramientas")
    parser.add_argument("--list-profiles", action="store_true", help="Listar los perfiles de conexión generales almacenados en el servidor local")
    parser.add_argument("--prompt", default=None, help="Ejecutar este prompt sin interfaz gráfica con Node.js, imprimir solo la respuesta final y terminar (salida 0 terminado, 1 error de generación, 2 runner cerrado sin resultado, 3 fallo de arranque, 4 argumentos no válidos, 5 pausada a la espera del usuario, con su pregunta en la salida, 6 límite de --run-file alcanzado)")
    parser.add_argument("--conversation", default=None, help="Con --prompt o para continuar, id de la conversación almacenada en SQLite")
    parser.add_argument("--run-file", default=None, metavar="FICHERO", help="Ejecutar la petición del fichero JSON (- para leerla de stdin) en lugar de --prompt, --conversation y --profile: prompt, conversation_id (la continúa o, si no existe, la crea con ese id), profile, agent (<subconjunto>.<nombre>: marca la conversación nueva como de ese agente), systemDataPrompt, watchAgents (patrones de agentes del proyecto que vigila con check_agents), projectMode (true inyecta AGENTS.md y .zerochat/state.md; por defecto no), reasoning (none, low, medium, high o xhigh; medium por defecto), maxSteps y timeout (segundos); exige un entorno de proyecto guardado, del que salen siempre herramientas y permisos")
    parser.add_argument("--profile", default=None, help=f"Con --prompt o --conversation, perfil (nombre o id) que se usa solo en esta ejecución, sin cambiar el activo (por defecto: {DEFAULT_RUN_PROFILE} del servidor)")
    parser.add_argument("--log", choices=("on", "off"), default=None, help="Mostrar la cabecera y el registro del servidor (default: on; off en modo ejecución)")
    parser.add_argument("--export", default=None, metavar="FICHERO", help=f"Con --prompt, --conversation o --run-file, guardar la conversación en FICHERO; el formato sale de la extensión ({', '.join(RUN_EXPORT_FORMATS)})")
    parser.add_argument("--version", action="version", version=f"ZeroChat {VERSION}")
    return parser


def _check_run_flags(parser: ZeroChatArgumentParser, args):
    """Combinaciones de opciones que no admite el modo ejecución."""
    if args.no_browser:
        parser.error("--prompt, --conversation y --run-file ejecutan la interfaz de forma autónoma: no se combina con --no-browser")
    if args.keep_server:
        parser.error("--prompt, --conversation y --run-file terminan al devolver el resultado: no se combina con --keep-server")
    if args.host is not None:
        parser.error(f"--prompt, --conversation y --run-file solo atienden a su runner en {DEFAULT_HOST}: no se combina con --host")


def _run_prompt(parser: ZeroChatArgumentParser, raw_prompt: str | None) -> str | None:
    if raw_prompt is None:
        return None
    prompt = raw_prompt.strip()
    if not prompt:
        parser.error("el prompt está vacío")
    return prompt


def _run_conversation(parser: ZeroChatArgumentParser, raw_id: str | None, prompt: str | None,
                      allow_new: bool = False) -> tuple[str | None, dict | None, str | None]:
    """La conversación de la ejecución: (id, conversación) si existe y, sin prompt, tiene un turno que continuar.
    Con allow_new (--run-file), un id que no existe es el de la conversación nueva que empieza el prompt: (None, None, id)."""
    if raw_id is None:
        return None, None, None
    raw_conv = raw_id.strip()
    if not raw_conv:
        parser.error("el identificador de la conversación no puede estar vacío")
    try:
        conversation_id = _validate_conversation_id(raw_conv)
    except ValueError as exc:
        parser.error(str(exc))
    conv = get_conversation(conversation_id)
    if conv is None:
        if not allow_new:
            parser.error(f"no existe la conversación '{conversation_id}'")
        if prompt is None:
            parser.error(f"la conversación '{conversation_id}' no existe y no hay prompt para empezarla")
        return None, None, conversation_id
    if prompt is None and not any(m.get("role") in ("user", "tool") for m in conv.get("history") or []):
        parser.error(f"la conversación '{conversation_id}' no tiene turnos para continuar")
    return conversation_id, conv, None


def _run_file_request(parser: ZeroChatArgumentParser, path: str) -> dict:
    """La petición de --run-file, leída del fichero o de stdin (-) sin pasar del tope y validada."""
    try:
        if path == "-":
            raw = sys.stdin.buffer.read(RUN_FILE_MAX_BYTES + 1)
        else:
            with open(Path(path).expanduser(), "rb") as handle:
                raw = handle.read(RUN_FILE_MAX_BYTES + 1)
        return parse_run_request(raw)
    except OSError as exc:
        parser.error(f"--run-file: no se pudo leer {path}: {exc}")
    except ValueError as exc:
        parser.error(f"--run-file: {exc}")


def _run_profile(parser: ZeroChatArgumentParser, raw_profile: str | None, conv: dict | None) -> tuple[str, dict | None]:
    """El perfil de la ejecución (su nombre y, si existe en el servidor, el perfil con su API key, que el runner recibe
    en profile_data): el de --profile, el de la conversación o DEFAULT_RUN_PROFILE.

    Un --profile que no existe en el servidor se pasa por su nombre; el de la conversación y el por defecto tienen que existir.
    """
    if raw_profile is not None:
        clean_profile = raw_profile.strip()
        if not clean_profile:
            parser.error("--profile no puede estar vacío")
        match = get_general_profile_by_name(clean_profile) or get_general_profile(clean_profile)
        return (match["name"] if match else clean_profile), (get_general_profile_with_key(match["id"]) if match else None)
    conv_profile = conv.get("profileId") if conv else None
    if conv_profile:
        match = get_general_profile_by_name(conv_profile) or get_general_profile(conv_profile)
        if not match:
            parser.error(f"no existe el perfil '{conv_profile}' en el servidor; créalo o indica uno con --profile")
        return match["name"], get_general_profile_with_key(match["id"])
    match = get_general_profile_by_name(DEFAULT_RUN_PROFILE)
    if match is None:
        parser.error(f"no existe el perfil por defecto '{DEFAULT_RUN_PROFILE}' en el servidor; créalo o indica uno con --profile")
    return match["name"], get_general_profile_with_key(match["id"])


def _run_export_path(parser: ZeroChatArgumentParser, args) -> Path | None:
    if args.export is None:
        return None
    export_path = Path(args.export).expanduser().absolute()
    if export_path.suffix.lower() not in RUN_EXPORT_FORMATS:
        parser.error(f"--export necesita una de estas extensiones: {', '.join(RUN_EXPORT_FORMATS)}")
    if not export_path.parent.is_dir():
        parser.error(f"--export: no existe el directorio {export_path.parent}")
    return export_path


def run_session_from_args(parser: ZeroChatArgumentParser, args) -> RunSession | None:
    """Valida las combinaciones de opciones y devuelve la sesión de --prompt, --conversation o --run-file, si la hay."""
    request: dict = {}
    if args.run_file is not None:
        if args.prompt is not None or args.conversation is not None or args.profile is not None:
            parser.error("--run-file ya lleva el prompt, la conversación y el perfil: no se combina con --prompt, --conversation ni --profile")
        request = _run_file_request(parser, args.run_file)
        if "prompt" not in request and "conversation_id" not in request:
            parser.error("--run-file necesita prompt o conversation_id")
        raw_prompt, raw_conversation, raw_profile = request.get("prompt"), request.get("conversation_id"), request.get("profile")
    elif args.prompt is None and args.conversation is None:
        if args.profile is not None or args.export is not None:
            parser.error("--profile y --export solo se usan con --prompt, --conversation o --run-file")
        return None
    else:
        raw_prompt, raw_conversation, raw_profile = args.prompt, args.conversation, args.profile
    prompt = _run_prompt(parser, raw_prompt)
    conversation_id, conv, new_conversation_id = _run_conversation(parser, raw_conversation, prompt, allow_new=args.run_file is not None)
    # El agente se fija al crear la conversación: continuarla con otro, o sin él, mezclaría historiales.
    if args.run_file is not None and conv is not None and conv.get("agent") != request.get("agent"):
        parser.error(f"la conversación '{conversation_id}' es del agente '{conv.get('agent') or '(ninguno)'}', no de "
                     f"'{request.get('agent') or '(ninguno)'}'")
    # Continuar sin --run-file (la interfaz o --conversation) una conversación de agente repite su último lanzamiento:
    # su perfil, su manual (systemDataPrompt), su projectMode y sus límites, no los de quien la reanuda.
    options = request
    if args.run_file is None and conv is not None and conv.get("agent"):
        options = {"projectMode": False, "agent": conv["agent"], **(get_conversation_launch(conversation_id) or {})}
        launch_profile = options.get("profile")
        if launch_profile and raw_profile is not None and raw_profile.strip() != launch_profile:
            parser.error(f"la conversación '{conversation_id}' es del agente '{conv['agent']}' y se continúa con el perfil "
                         f"de su lanzamiento, '{launch_profile}', no con '{raw_profile.strip()}'")
        raw_profile = launch_profile or raw_profile
    _check_run_flags(parser, args)
    _require_no_active_run(conversation_id or new_conversation_id)
    profile_name, profile_data = _run_profile(parser, raw_profile, conv)
    export_path = _run_export_path(parser, args)
    if conversation_id and args.run_file is None:
        mark_conversation_server_run(conversation_id, profile_name)
    launch = None
    if args.run_file is not None and request.get("agent"):
        launch = {"profile": profile_name, **{key: request[key] for key in RUN_LAUNCH_KEYS if key in request}}
    return RunSession(prompt, profile_name, export_path, conversation_id=conversation_id, profile_data=profile_data,
                      new_conversation_id=new_conversation_id, system_data_prompt=options.get("systemDataPrompt"),
                      max_steps=options.get("maxSteps"), timeout_seconds=options.get("timeout"),
                      project_mode=options.get("projectMode"), agent=options.get("agent"), launch=launch,
                      watch_agents=tuple(options.get("watchAgents") or ()), track_run=args.run_file is not None,
                      reasoning=options.get("reasoning"))


def _require_no_active_run(conversation_id: str | None):
    """Como zerochat/run/start, la CLI no lanza una segunda ejecución de una conversación que ya tiene otra en marcha
    (--conversation, o --run-file con conversation_id fijo, p. ej. dos cron solapados): sale con RUN_EXIT_BUSY. Va antes
    de crear la RunSession, que anota su propio estado sobre el de la otra. El hijo de zerochat/run/start ya está
    anotado con el run_id que recibe en ZEROCHAT_RUN_ID."""
    if not conversation_id:
        return
    try:
        check_no_active_run(conversation_id, own_run_id=os.environ.get("ZEROCHAT_RUN_ID", "").strip() or None)
    except ValueError as exc:
        run_error(str(exc))
        sys.exit(RUN_EXIT_BUSY)


def redirect_log(args):
    """Todo el registro pasa por stdout: con --prompt va a stderr para dejar stdout a la respuesta,
    y con --log off se descarta. Devuelve el stdout original, el de la respuesta."""
    result_out = sys.stdout
    session = current_run_session()
    log_enabled = args.log == "on" if args.log else session is None
    if not log_enabled:
        sys.stdout = open(os.devnull, "w", encoding="utf-8")
    elif session:
        sys.stdout = sys.stderr
    return result_out


def run_self_test() -> bool:
    """
    --test: comprueba las herramientas locales básicas sin arrancar el servidor, en una carpeta temporal
    propia para no depender de dónde se ejecute. Devuelve si todas funcionan.
    """
    with tempfile.TemporaryDirectory(prefix="zerochat-test-") as folder:
        ctx = SecurityContext(Path(folder).resolve())
        checks = {
            "write_file": lambda: write_file("prueba.txt", "hola\n", ctx=ctx),
            "list_directory": lambda: list_directory(".", ctx=ctx),
            "read_file": lambda: read_file("prueba.txt", ctx=ctx),
            "run_command": lambda: run_command("echo hola", ctx=ctx),
        }
        passed = True
        for name, check in checks.items():
            ok = json.loads(check()).get("success") is True
            passed = passed and ok
            print(timestamp_message(f"TEST {name} {'ok' if ok else 'error'}"))
    print(timestamp_message("TEST all local tools ready." if passed else "TEST some local tools failed."))
    return passed


def prepare_environment(args, is_dev: bool):
    """Limpia restos de una sesión anterior, prepara el entorno MCP y lanza las comprobaciones de fondo."""
    orphans = cleanup_orphan_jobs()
    if orphans:
        print(timestamp_message(f"Detenidos {orphans} comando(s) que seguían en marcha de una sesión anterior interrumpida."))
    # Entorno MCP aislado en ambos modos de distribución.
    if not args.no_venv:
        ensure_virtual_environment()
    if not browser_action_availability().get("available"):
        add_notice(
            "browser_action desactivada: para usarla, inicia el servicio 'playwright' en Ajustes → MCP "
            "(se instala solo). Requiere Node.js y disponer de Chrome o Edge en el sistema."
        )
    # Versión remota en segundo plano, solo fuera del entorno de desarrollo local.
    if not is_dev:
        threading.Thread(target=check_version, daemon=True).start()


@on_token_rotation
def reset_session_authorizations():
    """Borra las autorizaciones de sesión y los retos pendientes, y vuelve a aplicar la capa de la ejecución."""
    ACCESS_CONTROLLER.clear_session()
    session = current_run_session()
    if session is not None:
        ctx = project_context()
        if session.tool_security:
            ACCESS_CONTROLLER.apply_session_overlay(session.tool_security, ctx)
            tool_decision = session.tool_security.get("tool_decision")
            if isinstance(tool_decision, dict):
                tool_name = tool_decision.get("toolName") or ""
                server_id = GLOBAL_MCP_MANAGER.server_of(tool_name) or ""
                ACCESS_CONTROLLER.apply_tool_decision(tool_decision, ctx, server_id=server_id)
        permanent_tools = ACCESS_CONTROLLER.export_state(ctx).get("tools") or {}
        ACCESS_CONTROLLER.apply_session_overlay({
            "allowAll": False,
            "tools": {
                name: {"policy": POLICY_ALLOW}
                for name in LOCAL_TOOL_HANDLERS
                if name != COMMAND_TOOL
                and (name not in MASTER_TOOLS or session.watch_agents)
                and not get_integrated_path_access(name)
                and (permanent_tools.get(name) or {}).get("policy") != POLICY_DENY
            }
        }, ctx)


def open_server(args) -> ThreadingHTTPServer:
    """
    Abre el puerto de escucha y publica la dirección real: con --port 0, el puerto que elige el sistema. Una ejecución
    (--prompt, --conversation, --run-file) solo atiende a su runner: escucha en DEFAULT_HOST, sin ZEROCHAT_HOST, y,
    salvo --port, en un puerto libre del sistema, nunca en el del servidor principal (DEFAULT_PORT o ZEROCHAT_PORT).
    """
    run = current_run_session() is not None
    host = DEFAULT_HOST if run else (args.host or os.environ.get("ZEROCHAT_HOST", DEFAULT_HOST))
    if args.port is not None:
        port = args.port
    else:
        port = 0 if run else int(os.environ.get("ZEROCHAT_PORT", DEFAULT_PORT))
    try:
        server = ZeroChatHTTPServer((host, port), ZeroChatServerHandler)
    except OSError as exc:
        if not run:
            raise
        run_error(f"No se pudo escuchar en {host}:{port}: {exc}")
        sys.exit(RUN_EXIT_SETUP)
    set_active_address(host, server.server_address[1])
    return server


def interface_url(args, static_root) -> str:
    """URL de la interfaz: la indicada, la local de desarrollo o la de GitHub Pages."""
    if args.ui_url:
        return args.ui_url
    if static_root:
        host, port = active_address()
        return f"http://{host}:{port}/zerochat.html"
    return DEFAULT_UI_URL


def launch_url(ui_url: str, token: str | None = None) -> str:
    """URL con que zerochat abre el navegador: el token vigente y el servidor van en el fragmento."""
    host, port = active_address()
    browser_host = host if host in {"127.0.0.1", "localhost"} else "127.0.0.1"
    fragment = {'token': token if token is not None else current_session_token(), 'host': browser_host, 'port': port}
    session = current_run_session()
    if session:
        fragment['run'] = session.run_id
    return f"{ui_url}#{urlencode(fragment)}"


def print_header(dev_root, ui_url: str, exposure_warning: str | None, exit_on_close: bool):
    """Cabecera del servidor con su configuración (sin el token)."""
    print("=" * 64)
    print(f"  ZeroChat Local Server v{VERSION} (UI {UI_VERSION})")
    print(f"  Directorio de trabajo : {project_context().workspace_dir}")
    print(f"  Datos y MCP           : {get_data_dir()}")
    print(f"  Entorno MCP           : {get_venv_dir()}")
    if dev_root is not None:
        print(f"  Modo de ejecución     : Desarrollo local ({dev_root})")
    elif is_installed_runtime():
        print("  Modo de ejecución     : Paquete PyPI (GitHub Pages)")
    else:
        print("  Modo de ejecución     : Producción (Web universal)")
    host, port = active_address()
    print(f"  Servidor HTTP         : http://{host}:{port}")
    if exposure_warning:
        print(f"  AVISO                 : {exposure_warning}")
    print("  Token de sesión (diario): configurado")
    print(f"  Destino Web           : {ui_url}")
    if exit_on_close:
        print("  Auto-cierre           : Activado (al cerrar navegador)")
    else:
        print("  Auto-cierre           : Desactivado")
    print("=" * 64, flush=True)


def start_interface(args, parser, server: ThreadingHTTPServer, ui_url: str):
    """Abre la interfaz: en modo ejecución con el runner de Node.js y su supervisor; si no, con el navegador y control de consola."""
    session = current_run_session()
    if not session:
        console = ConsoleControl(server, parser, launch_url=lambda: launch_url(ui_url))
        set_console_control(console)
        console.start()
        if not args.no_browser:
            launch_browser(launch_url(ui_url))
        return
    session.runner_token = issue_runner_token(session.run_id, session.conversation_id or session.new_conversation_id)
    runner = launch_node_runner(launch_url(ui_url, token=session.runner_token))
    if runner is None:
        server.server_close()
        mute_console()
        sys.exit(RUN_EXIT_SETUP)
    runner_proc, runner_log = runner
    session.runner_started = True
    threading.Thread(target=run_supervisor, args=(server, session, runner_proc, runner_log), daemon=True).start()


def start_heartbeat_watchdog(server: ThreadingHTTPServer, require_initial: bool):
    """Detiene el servidor cuando el navegador deja de enviar latidos."""
    threading.Thread(
        target=heartbeat_watchdog,
        args=(server, DEFAULT_HEARTBEAT_GRACE, DEFAULT_HEARTBEAT_TIMEOUT, require_initial),
        daemon=True
    ).start()


def install_signal_handlers(server: ThreadingHTTPServer):
    """Ctrl+C, SIGTERM y el cierre del terminal detienen el servidor de forma ordenada."""
    def shutdown(*_):
        console_log("\n" + timestamp_message("Deteniendo servidor ZeroChat..."))
        stop_zerochat_server(server)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)
    # Cerrar el terminal no debe dejar vivos los comandos, que no reciben sus señales.
    if hasattr(signal, "SIGHUP"):
        signal.signal(signal.SIGHUP, shutdown)


def serve(server: ThreadingHTTPServer):
    """Atiende peticiones hasta la parada y libera después el servidor y la consola."""
    try:
        server.serve_forever(poll_interval=0.05)
    finally:
        stop_zerochat_server(server)
        server.server_close()
        console = current_console_control()
        if console:
            console.close()
            set_console_control(None)


def finish_run(result_out):
    """Modo ejecución: escribe la respuesta final en el stdout original y sale con su código."""
    session = current_run_session()
    # Una conversación nueva de --run-file (ya guardada por el runner) la continúa la interfaz en el servidor con su
    # perfil, como las de --conversation, que se marcan al empezar porque ya existen.
    if session.new_conversation_id == session.state_conversation_id:
        mark_conversation_server_run(session.new_conversation_id, session.profile)
    code, text = run_outcome(session)
    # El registro sigue donde estaba (stderr o nada): result_out solo recibe la respuesta.
    mute_console()
    if text is not None:
        result_out.write(text if text.endswith("\n") else text + "\n")
        result_out.flush()
    sys.exit(code)


def _apply_conversation_project(parser: ZeroChatArgumentParser, session: RunSession | None):
    """Fija el proyecto por defecto al de la conversación indicada en --conversation."""
    if not session or not session.conversation_id:
        return
    conv = get_conversation(session.conversation_id)
    if not isinstance(conv, dict):
        return
    conv_project = conv.get("project")
    if conv_project:
        if not Path(conv_project).is_dir():
            parser.error(f"la carpeta del proyecto de la conversación ya no existe: {conv_project}")
        set_default_project_dir(Path(conv_project))
    else:
        set_default_project_dir(get_no_project_dir())


def require_saved_environment():
    """--run-file solo se ejecuta en un proyecto con entorno guardado: sus herramientas, servicios MCP y permisos
    salen siempre de él, nunca del fichero, así que sin él la ejecución usaría valores que nadie ha decidido."""
    ctx = project_context()
    try:
        saved = get_project_environment(ctx.key)["saved"]
    except RuntimeError as exc:
        run_error(str(exc))
        sys.exit(RUN_EXIT_SETUP)
    if not saved:
        run_error(f"El proyecto {ctx.workspace_dir} no tiene entorno guardado: guarda sus herramientas y permisos en la interfaz antes de usarlo con --run-file.")
        sys.exit(RUN_EXIT_SETUP)


def _prepare_run_environment(parser: ZeroChatArgumentParser, args, session: RunSession | None):
    _apply_conversation_project(parser, session)
    if args.run_file is not None:
        require_saved_environment()
        if session and session.conversation_id:
            mark_conversation_server_run(session.conversation_id, session.profile)
        if session:
            announce_run_conversation(session)


def main():
    parser = build_parser()
    args = parser.parse_args()
    # Los avisos no persisten entre ejecuciones del servidor.
    reset_notices()
    session = run_session_from_args(parser, args)
    set_run_session(session)
    try:
        _start(parser, args, session)
    except SystemExit:
        # Salir antes de lanzar el runner (entorno sin guardar, sin Node, puerto ocupado...) no deja fila en runs.
        discard_unstarted_run(session)
        raise


def _start(parser: ZeroChatArgumentParser, args, session: RunSession | None):
    """Prepara y arranca el servidor y, en modo ejecución, el runner de Node; vuelve al detenerse el servidor."""
    _prepare_run_environment(parser, args, session)
    result_out = redirect_log(args)

    if getattr(args, "list_profiles", False):
        profiles = list_general_profiles()
        if not profiles:
            print("No hay perfiles de conexión almacenados en el servidor local.")
        else:
            print("Perfiles de conexión del servidor local:")
            for p in profiles:
                settings = p.get("settings", {})
                model = settings.get("model") or "sin modelo"
                api_type = settings.get("apiType") or "openai"
                api_url = settings.get("apiUrl") or ""
                print(f"- {p['name']} ({api_type} / {model}) [{api_url}]")
        return

    if args.test:
        sys.exit(0 if run_self_test() else 1)

    dev_root = get_dev_root()
    static_root = get_static_root()
    prepare_environment(args, is_dev=dev_root is not None)
    current_session_token()

    server = open_server(args)
    exposure_warning = remote_exposure_warning(active_address()[0])
    if exposure_warning:
        add_notice(exposure_warning)

    ui_url = interface_url(args, static_root)
    # El modo ejecución (que rechaza --keep-server) detecta con el latido que el runner se cerró sin devolver resultado.
    exit_on_close = not args.keep_server
    set_exit_on_close(exit_on_close)
    print_header(dev_root, ui_url, exposure_warning, exit_on_close)
    # Los servicios MCP incluidos se actualizan desde el catálogo publicado junto a la interfaz.
    GLOBAL_MCP_MANAGER.start_catalog_refresh(ui_url)

    start_interface(args, parser, server, ui_url)
    if exit_on_close:
        start_heartbeat_watchdog(server, require_initial=not args.no_browser)
    install_signal_handlers(server)
    serve(server)

    if current_run_session():
        finish_run(result_out)


if __name__ == "__main__":
    main()
