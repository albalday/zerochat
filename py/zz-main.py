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
    global ACTIVE_PORT, ACTIVE_HOST, CONSOLE_CONTROL, EXIT_ON_CLOSE

    parser = argparse.ArgumentParser(description=f"ZeroChat Local Server v{VERSION}")
    # Desde Python 3.14 argparse colorea la ayuda con códigos ANSI; la consola la muestra en texto plano.
    parser.color = False
    parser.add_argument("--port", type=int, default=int(os.environ.get("ZEROCHAT_PORT", DEFAULT_PORT)), help=f"Puerto de escucha (default: {DEFAULT_PORT})")
    parser.add_argument("--host", default=os.environ.get("ZEROCHAT_HOST", DEFAULT_HOST), help=f"Host de escucha (default: {DEFAULT_HOST})")
    parser.add_argument("--ui-url", default=None, help="URL de la interfaz web a abrir (por defecto: interfaz local en desarrollo o GitHub Pages)")
    parser.add_argument("--no-browser", action="store_true", help="No abrir automáticamente el navegador")
    parser.add_argument("--no-exit-on-close", action="store_true", help="No detener el servidor automáticamente al cerrar el navegador")
    parser.add_argument("--no-venv", action="store_true", help="Omitir la comprobación/creación de ~/zerochat/.venv")
    parser.add_argument("--test", action="store_true", help="Ejecutar autocomprobación interna de herramientas")
    run_group = parser.add_argument_group("modo ejecución (Linux y Firefox)", "Ejecuta un prompt en la interfaz con la configuración de ZeroChat del perfil de Firefox, imprime solo la respuesta final y termina (0 terminado, 1 error de generación, 2 plazo agotado o navegador cerrado, 3 fallo de preparación)")
    prompt_source = run_group.add_mutually_exclusive_group()
    prompt_source.add_argument("--prompt", default=None, help="Prompt a ejecutar")
    prompt_source.add_argument("--prompt-file", default=None, help="Fichero con el prompt ('-' para la entrada estándar)")
    run_group.add_argument("--headless", action="store_true", help="Ejecutar Firefox sin ventana")
    run_group.add_argument("--timeout", type=int, default=RUN_DEFAULT_TIMEOUT, help=f"Plazo total en segundos (default: {RUN_DEFAULT_TIMEOUT})")
    parser.add_argument("--version", action="version", version=f"ZeroChat {VERSION}")
    args = parser.parse_args()

    # Los avisos no persisten entre ejecuciones del servidor.
    reset_notices()

    run_mode = args.prompt is not None or args.prompt_file is not None
    if not run_mode and (args.headless or args.timeout != RUN_DEFAULT_TIMEOUT):
        parser.error("--headless y --timeout solo se usan con --prompt o --prompt-file")
    if args.timeout <= 0:
        parser.error("--timeout debe ser un número positivo de segundos")
    if run_mode:
        sys.exit(run_mode_main(args))

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

    ACTIVE_PORT = args.port
    ACTIVE_HOST = args.host
    init_session_credentials()

    server = ThreadingHTTPServer((ACTIVE_HOST, ACTIVE_PORT), ZeroChatServerHandler)
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
    target_url = f"{ui_url}#{urlencode({'token': SESSION_TOKEN, 'host': browser_host, 'port': ACTIVE_PORT})}"
    exit_on_close = not args.no_exit_on_close
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


if __name__ == "__main__":
    main()
