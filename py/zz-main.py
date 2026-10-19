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


def main():
    global ACTIVE_PORT, ACTIVE_HOST, SESSION_TOKEN, CONSOLE_CONTROL, EXIT_ON_CLOSE
    global TOOL_AUTH_KEY, TOOL_AUTH_SESSION_ID, TOOL_AUTH_NONCES, RUN_SESSION

    parser = argparse.ArgumentParser(description=f"ZeroChat Local Server v{VERSION}")
    # Desde Python 3.14 argparse colorea la ayuda con códigos ANSI; la consola la muestra en texto plano.
    parser.color = False
    parser.add_argument("--port", type=int, default=None, help=f"Puerto de escucha (default: ZEROCHAT_PORT o {DEFAULT_PORT}; con --prompt, si está ocupado se usa otro libre salvo en desarrollo)")
    parser.add_argument("--host", default=os.environ.get("ZEROCHAT_HOST", DEFAULT_HOST), help=f"Host de escucha (default: {DEFAULT_HOST})")
    parser.add_argument("--ui-url", default=None, help="URL de la interfaz web a abrir (por defecto: interfaz local en desarrollo o GitHub Pages)")
    parser.add_argument("--no-browser", action="store_true", help="No abrir automáticamente el navegador")
    parser.add_argument("--keep-server", action="store_true", help="Servidor: seguir en marcha al cerrar el navegador (no se combina con --prompt)")
    parser.add_argument("--no-venv", action="store_true", help="Omitir la comprobación/creación de ~/zerochat/.venv")
    parser.add_argument("--test", action="store_true", help="Ejecutar autocomprobación interna de herramientas")
    parser.add_argument("--prompt", default=None, help="Ejecutar este prompt en la interfaz, imprimir solo la respuesta final y terminar (salida 0 terminado, 1 error de generación, 2 plazo agotado o navegador cerrado, 3 fallo de arranque)")
    parser.add_argument("--profile", default=None, help="Con --prompt, perfil de conexión (nombre o id) que se usa solo en esta ejecución, sin cambiar el activo")
    parser.add_argument("--log", choices=("on", "off"), default=None, help="Mostrar la cabecera y el registro del servidor (default: on; off con --prompt)")
    parser.add_argument("--export", default=None, metavar="FICHERO", help=f"Con --prompt, guardar la conversación en FICHERO; el formato sale de la extensión ({', '.join(RUN_EXPORT_FORMATS)})")
    parser.add_argument("--keep-page", action="store_true", help="Página: con --prompt, no cerrar la página al terminar para ver la conversación (no se combina con --headless)")
    parser.add_argument("--allow-dangerous-tools", action="store_true", help="Con --prompt, aprobar también las herramientas que escriben o ejecutan (write_file, edit_file, run_command); las demás se aprueban siempre para la sesión")
    parser.add_argument("--headless", action="store_true", help="Con --prompt, abrir el navegador predeterminado sin ventana (si ya está abierto puede verse la pestaña)")
    parser.add_argument("--version", action="version", version=f"ZeroChat {VERSION}")
    args = parser.parse_args()

    # Los avisos no persisten entre ejecuciones del servidor.
    reset_notices()

    # Modo ejecución: stdout queda solo para la respuesta final; todo el registro va a stderr.
    result_out = sys.stdout
    if args.prompt is None and (args.headless or args.keep_page or args.allow_dangerous_tools or args.profile is not None or args.export is not None):
        parser.error("--headless, --keep-page, --allow-dangerous-tools, --profile y --export solo se usan con --prompt")
    if args.prompt is not None:
        if not args.prompt.strip():
            run_error("El prompt está vacío.")
            sys.exit(RUN_EXIT_SETUP)
        if args.no_browser:
            parser.error("--prompt necesita abrir el navegador: no se combina con --no-browser")
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
        RUN_SESSION = RunSession(args.prompt.strip(), args.profile.strip() if args.profile else None, export_path, args.keep_page, args.allow_dangerous_tools)
    # Todo el registro pasa por stdout: con --prompt va a stderr para dejar stdout a la respuesta,
    # y con --log off se descarta.
    log_enabled = args.log == "on" if args.log else RUN_SESSION is None
    if not log_enabled:
        sys.stdout = open(os.devnull, "w", encoding="utf-8")
    elif RUN_SESSION:
        sys.stdout = sys.stderr

    if args.test:
        print(timestamp_message(f"TEST list_directory {'ok' if json.loads(list_directory('.'))['success'] else 'error'}"))
        print(timestamp_message(f"TEST read_file {'ok' if json.loads(read_file('package.json', max_lines=5))['success'] else 'error'}"))
        print(timestamp_message(f"TEST run_command {'ok' if json.loads(run_command('echo hello'))['success'] else 'error'}"))
        print(timestamp_message("TEST all local tools ready."))
        return

    orphans = cleanup_orphan_jobs()
    if orphans:
        print(timestamp_message(f"Detenidos {orphans} comando(s) que seguían en marcha de una sesión anterior interrumpida."))

    # 1. Asegurar el entorno MCP aislado en ambos modos de distribución.
    if not args.no_venv:
        ensure_virtual_environment()

    browser_availability = browser_action_availability()
    if not browser_availability.get("available"):
        add_notice(
            "browser_action desactivada: para usarla, inicia el servicio 'playwright' en Ajustes → MCP "
            "(se instala solo). Requiere Node.js y disponer de Chrome o Edge en el sistema."
        )

    # 2. Detectar entorno de desarrollo y resolver URL de destino
    dev_root = get_dev_root()
    static_root = get_static_root()
    is_dev = dev_root is not None
    is_installed = is_installed_runtime()

    # 3. Comprobar versión remota en segundo plano (solo fuera del entorno de desarrollo local)
    if not is_dev:
        threading.Thread(target=check_version, daemon=True).start()

    ACTIVE_PORT = args.port if args.port is not None else int(os.environ.get("ZEROCHAT_PORT", DEFAULT_PORT))
    ACTIVE_HOST = args.host
    SESSION_TOKEN = get_daily_token()
    # A restart deliberately invalidates every browser-side signing credential.
    TOOL_AUTH_KEY = secrets.token_bytes(32)
    TOOL_AUTH_SESSION_ID = secrets.token_urlsafe(18)
    with TOOL_AUTH_NONCES_LOCK:
        TOOL_AUTH_NONCES = {}

    # La interfaz local de desarrollo tiene el puerto en su origen: en otro no vería los datos guardados.
    local_ui = static_root is not None and not args.ui_url
    try:
        server = ThreadingHTTPServer((ACTIVE_HOST, ACTIVE_PORT), ZeroChatServerHandler)
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
    exposure_warning = remote_exposure_warning(ACTIVE_HOST)
    if exposure_warning:
        add_notice(exposure_warning)

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
    target_url = f"{ui_url}#{urlencode(fragment)}"
    # El modo ejecución (que rechaza --keep-server) detecta con el latido que el navegador se cerró sin devolver resultado.
    exit_on_close = not args.keep_server
    EXIT_ON_CLOSE = exit_on_close

    print("=" * 64)
    print(f"  ZeroChat Local Server v{VERSION} (UI {UI_VERSION})")
    print(f"  Directorio de trabajo : {Path.cwd()}")
    print(f"  Datos y MCP           : {get_data_dir()}")
    print(f"  Entorno MCP           : {get_venv_dir()}")
    if is_dev:
        print(f"  Modo de ejecución     : Desarrollo local ({dev_root})")
    elif is_installed:
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

    headless_browser = None
    if RUN_SESSION:
        headless_browser = launch_headless_browser(target_url) if args.headless else None
        if headless_browser is None and not launch_browser(target_url):
            run_error("No se pudo abrir el navegador.")
            server.server_close()
            sys.stdout = result_out
            sys.exit(RUN_EXIT_SETUP)
        if headless_browser is not None:
            threading.Thread(target=fall_back_when_headless_exits, args=(headless_browser, target_url), daemon=True).start()
        threading.Thread(target=run_supervisor, args=(server, RUN_SESSION), daemon=True).start()
    else:
        CONSOLE_CONTROL = ConsoleControl(server, parser, target_url=target_url)
        CONSOLE_CONTROL.start()
        if not args.no_browser:
            launch_browser(target_url)

    if exit_on_close:
        require_initial = not args.no_browser
        threading.Thread(
            target=heartbeat_watchdog,
            args=(server, DEFAULT_HEARTBEAT_GRACE, DEFAULT_HEARTBEAT_TIMEOUT, require_initial),
            daemon=True
        ).start()

    def shutdown(*_):
        console_log("\n" + timestamp_message("Deteniendo servidor ZeroChat..."))
        stop_zerochat_server(server)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)
    # Cerrar el terminal no debe dejar vivos los comandos, que no reciben sus señales.
    if hasattr(signal, "SIGHUP"):
        signal.signal(signal.SIGHUP, shutdown)

    try:
        server.serve_forever()
    finally:
        stop_zerochat_server(server)
        server.server_close()
        if CONSOLE_CONTROL:
            CONSOLE_CONTROL.close()
            CONSOLE_CONTROL = None

    if RUN_SESSION:
        # Firefox sin ventana sigue vivo al cerrar la página; uno ya abierto solo recibió la pestaña.
        if headless_browser is not None and headless_browser.poll() is None:
            _kill_process_tree(headless_browser)
        code, text = run_outcome(RUN_SESSION)
        sys.stdout = result_out
        if text is not None:
            result_out.write(text if text.endswith("\n") else text + "\n")
            result_out.flush()
        sys.exit(code)


if __name__ == "__main__":
    main()
