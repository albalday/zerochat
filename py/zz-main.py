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
    parser.add_argument("--port", type=int, default=None, help=f"Puerto de escucha (default: ZEROCHAT_PORT o {DEFAULT_PORT}; con --prompt, si está ocupado se usa otro libre salvo en desarrollo)")
    parser.add_argument("--host", default=os.environ.get("ZEROCHAT_HOST", DEFAULT_HOST), help=f"Host de escucha (default: {DEFAULT_HOST})")
    parser.add_argument("--ui-url", default=None, help="URL de la interfaz web a abrir (por defecto: interfaz local en desarrollo o GitHub Pages)")
    parser.add_argument("--no-browser", action="store_true", help="No abrir automáticamente el navegador")
    parser.add_argument("--print-url", action="store_true", help="Imprimir la URL de la interfaz con el token, entre líneas en blanco para copiarla (implica --no-browser)")
    parser.add_argument("--keep-server", action="store_true", help="Servidor: seguir en marcha al cerrar el navegador (no se combina con --prompt)")
    parser.add_argument("--no-venv", action="store_true", help="Omitir la comprobación/creación de ~/zerochat/.venv")
    parser.add_argument("--test", action="store_true", help="Ejecutar autocomprobación interna de herramientas")
    parser.add_argument("--prompt", default=None, help="Ejecutar este prompt en la interfaz, imprimir solo la respuesta final y terminar (salida 0 terminado, 1 error de generación, 2 plazo agotado o navegador cerrado, 3 fallo de arranque, 4 argumentos no válidos)")
    parser.add_argument("--profile", default=None, help="Con --prompt, perfil (nombre o id) que se usa solo en esta ejecución, sin cambiar el activo")
    parser.add_argument("--log", choices=("on", "off"), default=None, help="Mostrar la cabecera y el registro del servidor (default: on; off con --prompt)")
    parser.add_argument("--export", default=None, metavar="FICHERO", help=f"Con --prompt, guardar la conversación en FICHERO; el formato sale de la extensión ({', '.join(RUN_EXPORT_FORMATS)})")
    parser.add_argument("--keep-page", action="store_true", help="Página: con --prompt, no cerrar la página al terminar para ver la conversación (no se combina con --headless)")
    parser.add_argument("--allow-dangerous-tools", action="store_true", help="Con --prompt, aprobar también las herramientas que escriben o ejecutan (write_file, edit_file, run_command); las demás se aprueban siempre para la sesión")
    parser.add_argument("--headless", action="store_true", help="Con --prompt, abrir el navegador predeterminado sin ventana (si ya está abierto puede verse la pestaña)")
    parser.add_argument("--version", action="version", version=f"ZeroChat {VERSION}")
    return parser


def run_session_from_args(parser: ZeroChatArgumentParser, args) -> RunSession | None:
    """Valida las combinaciones de opciones y devuelve la sesión de --prompt, si la hay."""
    # Quien pide la URL la abrirá en otro sitio (otro equipo, un túnel SSH): no se abre el navegador local.
    if args.print_url and args.prompt is None:
        args.no_browser = True
    if args.prompt is None:
        if args.headless or args.keep_page or args.allow_dangerous_tools or args.profile is not None or args.export is not None:
            parser.error("--headless, --keep-page, --allow-dangerous-tools, --profile y --export solo se usan con --prompt")
        return None
    if not args.prompt.strip():
        parser.error("el prompt está vacío")
    if args.no_browser or args.print_url:
        parser.error("--prompt necesita abrir el navegador: no se combina con --no-browser ni con --print-url")
    if args.keep_server:
        parser.error("--prompt termina al devolver el resultado: no se combina con --keep-server (para no cerrar la página, --keep-page)")
    if args.profile is not None and not args.profile.strip():
        parser.error("--profile no puede estar vacío")
    if args.keep_page and args.headless:
        parser.error("--keep-page necesita la ventana del navegador: no se combina con --headless")
    export_path = None
    if args.export is not None:
        export_path = Path(args.export).expanduser().absolute()
        if export_path.suffix.lower() not in RUN_EXPORT_FORMATS:
            parser.error(f"--export necesita una de estas extensiones: {', '.join(RUN_EXPORT_FORMATS)}")
        if not export_path.parent.is_dir():
            parser.error(f"--export: no existe el directorio {export_path.parent}")
    return RunSession(args.prompt.strip(), args.profile.strip() if args.profile else None, export_path, args.keep_page, args.allow_dangerous_tools)


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


def reset_session_credentials():
    """Carga el token diario y renueva la clave de firma de herramientas."""
    global SESSION_TOKEN, TOOL_AUTH_KEY, TOOL_AUTH_SESSION_ID, TOOL_AUTH_NONCES
    SESSION_TOKEN = get_daily_token()
    # A restart deliberately invalidates every browser-side signing credential.
    TOOL_AUTH_KEY = secrets.token_bytes(32)
    TOOL_AUTH_SESSION_ID = secrets.token_urlsafe(18)
    with TOOL_AUTH_NONCES_LOCK:
        TOOL_AUTH_NONCES = {}


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


def interface_urls(args, static_root) -> tuple[str, str]:
    """Devuelve la URL de la interfaz y la de destino, con el token y el servidor en el fragmento."""
    if args.ui_url:
        ui_url = args.ui_url
    elif static_root:
        ui_url = f"http://{ACTIVE_HOST}:{ACTIVE_PORT}/zerochat.html"
    else:
        ui_url = DEFAULT_UI_URL
    browser_host = ACTIVE_HOST if ACTIVE_HOST in {"127.0.0.1", "localhost"} else "127.0.0.1"
    fragment = {'token': SESSION_TOKEN, 'host': browser_host, 'port': ACTIVE_PORT}
    if RUN_SESSION:
        fragment['run'] = RUN_SESSION.run_id
    return ui_url, f"{ui_url}#{urlencode(fragment)}"


def print_header(dev_root, ui_url: str, exposure_warning: str | None, exit_on_close: bool):
    """Cabecera del servidor con su configuración (sin el token)."""
    print("=" * 64)
    print(f"  ZeroChat Local Server v{VERSION} (UI {UI_VERSION})")
    print(f"  Directorio de trabajo : {Path.cwd()}")
    print(f"  Datos y MCP           : {get_data_dir()}")
    print(f"  Entorno MCP           : {get_venv_dir()}")
    if dev_root is not None:
        print(f"  Modo de ejecución     : Desarrollo local ({dev_root})")
    elif is_installed_runtime():
        print("  Modo de ejecución     : Paquete PyPI (GitHub Pages)")
    else:
        print("  Modo de ejecución     : Producción (Web universal)")
    print(f"  Servidor HTTP/SSE     : http://{ACTIVE_HOST}:{ACTIVE_PORT}")
    if exposure_warning:
        print(f"  AVISO                 : {exposure_warning}")
    print("  Token de sesión (diario): configurado")
    print(f"  Destino Web           : {ui_url}")
    if exit_on_close:
        print("  Auto-cierre           : Activado (al cerrar navegador)")
    else:
        print("  Auto-cierre           : Desactivado")
    print("=" * 64, flush=True)


def start_interface(args, parser, server: ThreadingHTTPServer, target_url: str, result_out):
    """Abre la interfaz: en modo ejecución, con su supervisor; si no, con el control de consola.
    Devuelve el navegador sin ventana de --headless, si se lanzó."""
    global CONSOLE_CONTROL
    if args.print_url:
        # Líneas en blanco alrededor para seleccionarla y copiarla con facilidad (p. ej. en una consola SSH del móvil).
        print("\n" * 5 + target_url + "\n" * 5, flush=True)
    if not RUN_SESSION:
        CONSOLE_CONTROL = ConsoleControl(server, parser, target_url=target_url)
        CONSOLE_CONTROL.start()
        if not args.no_browser:
            launch_browser(target_url)
        return None
    headless_browser = launch_headless_browser(target_url) if args.headless else None
    if headless_browser is None and not launch_browser(target_url):
        run_error("No se pudo abrir el navegador.")
        server.server_close()
        sys.stdout = result_out
        sys.exit(RUN_EXIT_SETUP)
    if headless_browser is not None:
        threading.Thread(target=fall_back_when_headless_exits, args=(headless_browser, target_url), daemon=True).start()
    threading.Thread(target=run_supervisor, args=(server, RUN_SESSION), daemon=True).start()
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

    if args.test:
        run_self_test()
        return

    dev_root = get_dev_root()
    static_root = get_static_root()
    prepare_environment(args, is_dev=dev_root is not None)
    reset_session_credentials()

    # La interfaz local de desarrollo tiene el puerto en su origen: en otro no vería los datos guardados.
    server = open_server(args, local_ui=static_root is not None and not args.ui_url)
    exposure_warning = remote_exposure_warning(ACTIVE_HOST)
    if exposure_warning:
        add_notice(exposure_warning)

    ui_url, target_url = interface_urls(args, static_root)
    # El modo ejecución (que rechaza --keep-server) detecta con el latido que el navegador se cerró sin devolver resultado.
    EXIT_ON_CLOSE = not args.keep_server
    print_header(dev_root, ui_url, exposure_warning, EXIT_ON_CLOSE)

    headless_browser = start_interface(args, parser, server, target_url, result_out)
    if EXIT_ON_CLOSE:
        start_heartbeat_watchdog(server, require_initial=not args.no_browser)
    install_signal_handlers(server)
    serve(server)

    if RUN_SESSION:
        finish_run(headless_browser, result_out)


if __name__ == "__main__":
    main()
