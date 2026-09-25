# ==============================================================================
# Punto de Entrada Principal (CLI)
# ==============================================================================

def main():
    global ACTIVE_PORT, ACTIVE_HOST, SESSION_TOKEN, CONSOLE_CONTROL

    parser = argparse.ArgumentParser(description=f"ZeroChat Local Server v{VERSION}")
    parser.add_argument("--port", type=int, default=int(os.environ.get("ZEROCHAT_PORT", DEFAULT_PORT)), help=f"Puerto de escucha (default: {DEFAULT_PORT})")
    parser.add_argument("--host", default=os.environ.get("ZEROCHAT_HOST", DEFAULT_HOST), help=f"Host de escucha (default: {DEFAULT_HOST})")
    parser.add_argument("--token", default=None, help="Fijar un token de sesión específico (opcional)")
    parser.add_argument("--ui-url", default=None, help="URL de la interfaz web a abrir (por defecto: interfaz local en desarrollo o GitHub Pages)")
    parser.add_argument("--no-browser", action="store_true", help="No abrir automáticamente el navegador")
    parser.add_argument("--no-exit-on-close", action="store_true", help="No detener el servidor automáticamente al cerrar el navegador")
    parser.add_argument("--no-venv", action="store_true", help="Omitir la comprobación/creación de ~/zerochat/.venv")
    parser.add_argument("--test", action="store_true", help="Ejecutar autocomprobación interna de herramientas")
    parser.add_argument("--version", action="version", version=f"ZeroChat {VERSION}")
    args = parser.parse_args()

    if args.test:
        print(f"[{time.strftime('%H:%M:%S')}] TEST list_directory {'ok' if json.loads(list_directory('.'))['success'] else 'error'}")
        print(f"[{time.strftime('%H:%M:%S')}] TEST read_file {'ok' if json.loads(read_file('package.json', max_lines=5))['success'] else 'error'}")
        print(f"[{time.strftime('%H:%M:%S')}] TEST execute_command {'ok' if json.loads(execute_command('echo hello'))['success'] else 'error'}")
        print(f"[{time.strftime('%H:%M:%S')}] TEST all local tools ready.")
        return

    # 1. Asegurar el entorno MCP aislado en ambos modos de distribución.
    if not args.no_venv:
        ensure_virtual_environment()

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
    if args.token:
        SESSION_TOKEN = args.token
    else:
        SESSION_TOKEN = get_daily_token()

    server = ThreadingHTTPServer((ACTIVE_HOST, ACTIVE_PORT), ZeroChatServerHandler)

    if args.ui_url:
        ui_url = args.ui_url
    elif static_root:
        ui_url = f"http://{ACTIVE_HOST}:{ACTIVE_PORT}/zerochat.html"
    else:
        ui_url = DEFAULT_UI_URL

    browser_host = ACTIVE_HOST if ACTIVE_HOST in {"127.0.0.1", "localhost"} else "127.0.0.1"
    target_url = f"{ui_url}#{urlencode({'token': SESSION_TOKEN, 'host': browser_host, 'port': ACTIVE_PORT})}"
    exit_on_close = not args.no_exit_on_close

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
        print(f"  Modo de ejecución     : Producción (Web universal)")
    print(f"  Servidor HTTP/SSE     : http://{ACTIVE_HOST}:{ACTIVE_PORT}")
    print("  Token de sesión (diario): configurado")
    print(f"  Destino Web           : {ui_url}")
    if exit_on_close:
        print(f"  Auto-cierre           : Activado (al cerrar navegador)")
    else:
        print(f"  Auto-cierre           : Desactivado")
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
        console_log(f"\n[{time.strftime('%H:%M:%S')}] Deteniendo servidor ZeroChat...")
        stop_zerochat_server(server)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

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
