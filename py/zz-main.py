# ==============================================================================
# Punto de Entrada Principal (CLI)
# ==============================================================================

def is_loopback_host(host: str) -> bool:
    """Indica si el host de escucha solo acepta conexiones del propio equipo."""
    value = (host or "").strip().strip("[]").lower()
    if value == "localhost":
        return True
    try:
        return ipaddress.ip_address(value).is_loopback
    except ValueError:
        return False


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
    parser.color = False
    parser.add_argument("--port", type=int, default=None, help=f"Puerto de escucha (default: ZEROCHAT_PORT o {DEFAULT_PORT}; con --prompt, si está ocupado se usa otro libre salvo con --browser en desarrollo)")
    parser.add_argument("--host", default=os.environ.get("ZEROCHAT_HOST", DEFAULT_HOST), help=f"Host de escucha (default: {DEFAULT_HOST})")
    parser.add_argument("--ui-url", default=None, help="URL de la interfaz web a abrir (por defecto: interfaz local en desarrollo o GitHub Pages)")
    parser.add_argument("--no-browser", action="store_true", help="No abrir automáticamente el navegador")
    parser.add_argument("--keep-server", action="store_true", help="Servidor: seguir en marcha al cerrar el navegador (no se combina con --prompt)")
    parser.add_argument("--no-venv", action="store_true", help="Omitir la comprobación/creación de ~/zerochat/.venv")
    parser.add_argument("--test", action="store_true", help="Ejecutar autocomprobación interna de herramientas")
    parser.add_argument("--list-profiles", action="store_true", help="Listar los perfiles de conexión generales almacenados en el servidor local")
    parser.add_argument("--list-conversations", action="store_true", help="Listar las conversaciones almacenadas en el servidor local")
    parser.add_argument("--prompt", default=None, help="Ejecutar este prompt en la interfaz, imprimir solo la respuesta final y terminar (salida 0 terminado, 1 error de generación, 2 plazo agotado o navegador cerrado, 3 fallo de arranque, 4 argumentos no válidos)")
    parser.add_argument("--conversation", default=None, help="Con --prompt o para continuar, id de la conversación almacenada en SQLite")
    parser.add_argument("--profile", default=None, help=f"Con --prompt o --conversation, perfil (nombre o id) que se usa solo en esta ejecución, sin cambiar el activo (por defecto: {DEFAULT_RUN_PROFILE} del servidor)")
    parser.add_argument("--log", choices=("on", "off"), default=None, help="Mostrar la cabecera y el registro del servidor (default: on; off con --prompt o --conversation)")
    parser.add_argument("--export", default=None, metavar="FICHERO", help=f"Con --prompt o --conversation, guardar la conversación en FICHERO; el formato sale de la extensión ({', '.join(RUN_EXPORT_FORMATS)})")
    parser.add_argument("--browser", action="store_true", help="Con --prompt o --conversation, abrir el navegador predeterminado del usuario en lugar del proceso Node.js sin ventana")
    parser.add_argument("--keep-page", action="store_true", help="Página: con --browser, no cerrar la página al terminar para ver la conversación (no se combina con --headless)")
    parser.add_argument("--allow-dangerous-tools", action="store_true", help="Con --prompt o --conversation, aprobar también las herramientas que escriben o ejecutan (write_file, edit_file, run_command); las demás se aprueban siempre para la sesión")
    parser.add_argument("--headless", action="store_true", help="Con --browser, abrir el navegador predeterminado sin ventana (si ya está abierto puede verse la pestaña)")
    parser.add_argument("--version", action="version", version=f"ZeroChat {VERSION}")
    return parser


def run_session_from_args(parser: ZeroChatArgumentParser, args) -> RunSession | None:
    """Valida las combinaciones de opciones y devuelve la sesión de --prompt o --conversation, si la hay."""
    if args.prompt is None and args.conversation is None:
        if args.browser or args.headless or args.keep_page or args.allow_dangerous_tools or args.profile is not None or args.export is not None:
            parser.error("--browser, --headless, --keep-page, --allow-dangerous-tools, --profile y --export solo se usan con --prompt o --conversation")
        return None
    prompt = None
    if args.prompt is not None:
        prompt = args.prompt.strip()
        if not prompt:
            parser.error("el prompt está vacío")
    conversation_id = None
    conv = None
    if args.conversation is not None:
        raw_conv = args.conversation.strip()
        if not raw_conv:
            parser.error("el identificador de la conversación no puede estar vacío")
        try:
            conversation_id = _validate_conversation_id(raw_conv)
        except ValueError as exc:
            parser.error(str(exc))
        conv = get_conversation(conversation_id)
        if conv is None:
            parser.error(f"no existe la conversación '{conversation_id}'")
        if prompt is None:
            history = conv.get("history") or []
            has_user_or_tool = any(m.get("role") in ("user", "tool") for m in history)
            if not has_user_or_tool:
                parser.error(f"la conversación '{conversation_id}' no tiene turnos para continuar")
    if args.no_browser:
        parser.error("--prompt y --conversation ejecutan la interfaz de forma autónoma: no se combina con --no-browser")
    if args.keep_server:
        parser.error("--prompt y --conversation terminan al devolver el resultado: no se combina con --keep-server (para no cerrar la página, --keep-page)")
    if args.headless and not args.browser:
        parser.error("--headless solo se usa con --browser (--prompt y --conversation ya se ejecutan sin ventana con Node.js)")
    if args.keep_page and (not args.browser or args.headless):
        parser.error("--keep-page necesita la ventana del navegador del usuario (--browser sin --headless)")
    profile_data = None
    if args.profile is not None:
        clean_profile = args.profile.strip()
        if not clean_profile:
            parser.error("--profile no puede estar vacío")
        general_match = get_general_profile_by_name(clean_profile) or get_general_profile(clean_profile)
        profile_name = general_match["name"] if general_match else clean_profile
        profile_data = general_match
    elif conversation_id:
        conv_profile = conv.get("profileId") if conv else None
        if conv_profile:
            match = get_general_profile_by_name(conv_profile) or get_general_profile(conv_profile)
            if not match:
                parser.error(f"no existe el perfil '{conv_profile}' en el servidor; créalo o indica uno con --profile")
            profile_name = match["name"]
            profile_data = match
        else:
            default_match = get_general_profile_by_name(DEFAULT_RUN_PROFILE)
            if default_match is None:
                parser.error(f"no existe el perfil por defecto '{DEFAULT_RUN_PROFILE}' en el servidor; créalo o indica uno con --profile")
            profile_name = default_match["name"]
            profile_data = default_match
    else:
        default_match = get_general_profile_by_name(DEFAULT_RUN_PROFILE)
        if default_match is None:
            parser.error(f"no existe el perfil por defecto '{DEFAULT_RUN_PROFILE}' en el servidor; créalo o indica uno con --profile")
        profile_name = default_match["name"]
        profile_data = default_match
    export_path = None
    if args.export is not None:
        export_path = Path(args.export).expanduser().absolute()
        if export_path.suffix.lower() not in RUN_EXPORT_FORMATS:
            parser.error(f"--export necesita una de estas extensiones: {', '.join(RUN_EXPORT_FORMATS)}")
        if not export_path.parent.is_dir():
            parser.error(f"--export: no existe el directorio {export_path.parent}")
    if conversation_id:
        mark_conversation_server_run(conversation_id, profile_name)
    return RunSession(prompt, profile_name, export_path, args.keep_page, args.allow_dangerous_tools, conversation_id=conversation_id, profile_data=profile_data)


def redirect_log(args):
    """Todo el registro pasa por stdout: con --prompt va a stderr para dejar stdout a la respuesta,
    y con --log off se descarta. Devuelve el stdout original, el de la respuesta."""
    result_out = sys.stdout
    log_enabled = args.log == "on" if args.log else RUN_SESSION is None
    if not log_enabled:
        sys.stdout = open(os.devnull, "w", encoding="utf-8")
    elif RUN_SESSION:
        sys.stdout = sys.stderr
    return result_out


def run_self_test():
    """--test: comprueba las herramientas locales básicas sin arrancar el servidor."""
    print(timestamp_message(f"TEST list_directory {'ok' if json.loads(list_directory('.'))['success'] else 'error'}"))
    print(timestamp_message(f"TEST read_file {'ok' if json.loads(read_file('package.json', max_lines=5))['success'] else 'error'}"))
    print(timestamp_message(f"TEST run_command {'ok' if json.loads(run_command('echo hello'))['success'] else 'error'}"))
    print(timestamp_message("TEST all local tools ready."))


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
    if RUN_SESSION is not None:
        if RUN_SESSION.tool_security:
            ACCESS_CONTROLLER.apply_session_overlay(RUN_SESSION.tool_security, project_context())
        if RUN_SESSION.allow_dangerous_tools:
            ACCESS_CONTROLLER.apply_session_overlay({
                "tools": {name: {"policy": POLICY_ALLOW} for name in ("write_file", "edit_file", "run_command")}
            }, project_context())


def open_server(args, local_ui: bool) -> ThreadingHTTPServer:
    """Abre el puerto de escucha; con --prompt, si el puerto por defecto está ocupado, usa uno libre."""
    global ACTIVE_PORT, ACTIVE_HOST
    ACTIVE_PORT = args.port if args.port is not None else int(os.environ.get("ZEROCHAT_PORT", DEFAULT_PORT))
    ACTIVE_HOST = args.host
    try:
        return ThreadingHTTPServer((ACTIVE_HOST, ACTIVE_PORT), ZeroChatServerHandler)
    except OSError as exc:
        if not RUN_SESSION:
            raise
        if args.port is not None or local_ui:
            hint = "" if args.port is not None else " (en desarrollo la interfaz local necesita ese puerto: cierra el zerochat que lo usa)"
            run_error(f"No se pudo escuchar en {ACTIVE_HOST}:{ACTIVE_PORT}: {exc}{hint}")
            sys.exit(RUN_EXIT_SETUP)
    # Otro zerochat (u otro programa) usa el puerto por defecto: la ejecución usa uno libre.
    try:
        server = ThreadingHTTPServer((ACTIVE_HOST, 0), ZeroChatServerHandler)
    except OSError as retry_exc:
        run_error(f"No se pudo escuchar en {ACTIVE_HOST}: {retry_exc}")
        sys.exit(RUN_EXIT_SETUP)
    log_event(f"El puerto {ACTIVE_PORT} está ocupado; la ejecución usa el {server.server_address[1]}.")
    ACTIVE_PORT = server.server_address[1]
    return server


def interface_url(args, static_root) -> str:
    """URL de la interfaz: la indicada, la local de desarrollo o la de GitHub Pages."""
    if args.ui_url:
        return args.ui_url
    if static_root:
        return f"http://{ACTIVE_HOST}:{ACTIVE_PORT}/zerochat.html"
    return DEFAULT_UI_URL


def launch_url(ui_url: str) -> str:
    """URL con que zerochat abre el navegador: el token vigente y el servidor van en el fragmento."""
    browser_host = ACTIVE_HOST if ACTIVE_HOST in {"127.0.0.1", "localhost"} else "127.0.0.1"
    fragment = {'token': current_session_token(), 'host': browser_host, 'port': ACTIVE_PORT}
    if RUN_SESSION:
        fragment['run'] = RUN_SESSION.run_id
    return f"{ui_url}#{urlencode(fragment)}"


def print_header(dev_root, ui_url: str, exposure_warning: str | None, exit_on_close: bool):
    """Cabecera del servidor con su configuración (sin el token)."""
    print("=" * 64)
    print(f"  ZeroChat Local Server v{VERSION} (UI {UI_VERSION})")
    print(f"  Directorio de trabajo : {PROJECT_DIR}")
    print(f"  Datos y MCP           : {get_data_dir()}")
    print(f"  Entorno MCP           : {get_venv_dir()}")
    if dev_root is not None:
        print(f"  Modo de ejecución     : Desarrollo local ({dev_root})")
    elif is_installed_runtime():
        print("  Modo de ejecución     : Paquete PyPI (GitHub Pages)")
    else:
        print("  Modo de ejecución     : Producción (Web universal)")
    print(f"  Servidor HTTP         : http://{ACTIVE_HOST}:{ACTIVE_PORT}")
    if exposure_warning:
        print(f"  AVISO                 : {exposure_warning}")
    print("  Token de sesión (diario): configurado")
    print(f"  Destino Web           : {ui_url}")
    if exit_on_close:
        print("  Auto-cierre           : Activado (al cerrar navegador)")
    else:
        print("  Auto-cierre           : Desactivado")
    print("=" * 64, flush=True)


def start_interface(args, parser, server: ThreadingHTTPServer, ui_url: str, result_out):
    """Abre la interfaz: en modo ejecución, con su supervisor; si no, con el control de consola.
    Devuelve el navegador sin ventana lanzado, si lo hay."""
    global CONSOLE_CONTROL
    if not RUN_SESSION:
        CONSOLE_CONTROL = ConsoleControl(server, parser, launch_url=lambda: launch_url(ui_url))
        CONSOLE_CONTROL.start()
        if not args.no_browser:
            launch_browser(launch_url(ui_url))
        return None
    target_url = launch_url(ui_url)
    if not args.browser:
        runner_proc = launch_node_runner(target_url)
        if runner_proc is None:
            server.server_close()
            sys.stdout = result_out
            sys.exit(RUN_EXIT_SETUP)
        threading.Thread(target=run_supervisor, args=(server, RUN_SESSION, runner_proc), daemon=True).start()
        return runner_proc
    headless_browser = launch_headless_browser(target_url) if args.headless else None
    if headless_browser is None and not launch_browser(target_url):
        run_error("No se pudo abrir el navegador.")
        server.server_close()
        sys.stdout = result_out
        sys.exit(RUN_EXIT_SETUP)
    if headless_browser is not None:
        threading.Thread(target=fall_back_when_headless_exits, args=(headless_browser, target_url), daemon=True).start()
    threading.Thread(target=run_supervisor, args=(server, RUN_SESSION, None, headless_browser), daemon=True).start()
    return headless_browser


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
    global CONSOLE_CONTROL
    try:
        server.serve_forever()
    finally:
        stop_zerochat_server(server)
        server.server_close()
        if CONSOLE_CONTROL:
            CONSOLE_CONTROL.close()
            CONSOLE_CONTROL = None


def finish_run(headless_browser, result_out):
    """Modo ejecución: escribe la respuesta final en el stdout original y sale con su código."""
    # Firefox sin ventana sigue vivo al cerrar la página; uno ya abierto solo recibió la pestaña.
    if headless_browser is not None and headless_browser.poll() is None:
        _kill_process_tree(headless_browser)
    code, text = run_outcome(RUN_SESSION)
    sys.stdout = result_out
    if text is not None:
        result_out.write(text if text.endswith("\n") else text + "\n")
        result_out.flush()
    sys.exit(code)


def main():
    global RUN_SESSION, EXIT_ON_CLOSE

    parser = build_parser()
    args = parser.parse_args()
    # Los avisos no persisten entre ejecuciones del servidor.
    reset_notices()
    RUN_SESSION = run_session_from_args(parser, args)
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

    if getattr(args, "list_conversations", False):
        conversations = list_conversations()
        if not conversations:
            print("No hay conversaciones almacenadas en el servidor local.")
        else:
            print("Conversaciones almacenadas:")
            for c in conversations:
                date_str = datetime.datetime.fromtimestamp(c["updatedAt"] / 1000).strftime("%Y-%m-%d %H:%M") if c.get("updatedAt") else ""
                count = c.get("messageCount", 0)
                msg_text = "1 mensaje" if count == 1 else f"{count} mensajes"
                date_suffix = f", {date_str}" if date_str else ""
                print(f"- [{c['id']}] {c['title']} ({msg_text}{date_suffix})")
        return

    if args.test:
        run_self_test()
        return

    dev_root = get_dev_root()
    static_root = get_static_root()
    prepare_environment(args, is_dev=dev_root is not None)
    current_session_token()

    # La interfaz local de desarrollo en el navegador del usuario tiene el puerto en su origen: en otro no vería los datos guardados.
    server = open_server(args, local_ui=static_root is not None and not args.ui_url and args.browser)
    exposure_warning = remote_exposure_warning(ACTIVE_HOST)
    if exposure_warning:
        add_notice(exposure_warning)

    ui_url = interface_url(args, static_root)
    # El modo ejecución (que rechaza --keep-server) detecta con el latido que el navegador se cerró sin devolver resultado.
    EXIT_ON_CLOSE = not args.keep_server
    print_header(dev_root, ui_url, exposure_warning, EXIT_ON_CLOSE)

    headless_browser = start_interface(args, parser, server, ui_url, result_out)
    if EXIT_ON_CLOSE:
        start_heartbeat_watchdog(server, require_initial=not args.no_browser)
    install_signal_handlers(server)
    serve(server)

    if RUN_SESSION:
        finish_run(headless_browser, result_out)


if __name__ == "__main__":
    main()
