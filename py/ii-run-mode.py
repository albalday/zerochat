# ==============================================================================
# Modo ejecución desatendida (zerochat.py --prompt / --prompt-file)
# ==============================================================================
# El backend lanza su propio Firefox sobre una copia del perfil con la configuración real de
# ZeroChat; la interfaz pide el prompt, informa del progreso y devuelve el resultado por JSON-RPC.

RUN_DEFAULT_TIMEOUT = 900
# Sin progreso de la interfaz durante este plazo se da la ejecución por colgada.
RUN_IDLE_SECONDS = float(os.environ.get("ZEROCHAT_RUN_IDLE_SECONDS", "180"))
RUN_POLL_SECONDS = 0.2
RUN_BROWSER_CLOSE_GRACE = 3.0
RUN_PROGRESS_TEXT_MAX = 500
RUN_PROGRESS_KIND_PATTERN = re.compile(r"[a-z_]{1,32}")
RUN_EXIT_DONE = 0
RUN_EXIT_ERROR = 1
RUN_EXIT_TIMEOUT = 2
RUN_EXIT_SETUP = 3


class RunSession:
    """Estado de la única ejecución en curso: prompt, último progreso y resultado."""
    def __init__(self, prompt: str):
        self.run_id = secrets.token_urlsafe(24)
        self.prompt = prompt
        self.lock = threading.Lock()
        self.last_activity = time.monotonic()
        self.prompt_delivered = False
        self.result: dict | None = None
        self.finished = threading.Event()
        self.interrupted = threading.Event()

    def touch(self):
        with self.lock:
            self.last_activity = time.monotonic()

    def idle_seconds(self) -> float:
        with self.lock:
            return time.monotonic() - self.last_activity


RUN_SESSION: RunSession | None = None


def dispatch_run(method: str, params: dict) -> tuple[dict | None, dict | None, str]:
    """Métodos zerochat/run/* que usa la interfaz lanzada por el modo ejecución."""
    session = RUN_SESSION
    if session is None:
        return None, {"code": -32601, "message": "El servidor no está en modo ejecución."}, ""
    run_id = params.get("run_id")
    if not isinstance(run_id, str) or not hmac.compare_digest(run_id, session.run_id):
        return None, {"code": -32602, "message": "run_id no válido."}, ""
    if method == "zerochat/run/prompt":
        with session.lock:
            if session.prompt_delivered:
                return None, {"code": -32602, "message": "El prompt ya se entregó."}, ""
            session.prompt_delivered = True
        session.touch()
        return {"prompt": session.prompt}, None, ""
    if method == "zerochat/run/progress":
        kind = params.get("kind")
        text = params.get("text", "")
        if not isinstance(kind, str) or not RUN_PROGRESS_KIND_PATTERN.fullmatch(kind) or not isinstance(text, str):
            return None, {"code": -32602, "message": "Progreso no válido."}, ""
        session.touch()
        if len(text) > RUN_PROGRESS_TEXT_MAX:
            text = text[:RUN_PROGRESS_TEXT_MAX] + "…"
        log_event(f"[run] {kind}{': ' + text if text else ''}")
        return {"ok": True}, None, ""
    if method == "zerochat/run/result":
        text = params.get("text")
        error = params.get("error")
        if not ((isinstance(text, str) and error is None) or (isinstance(error, str) and error and text is None)):
            return None, {"code": -32602, "message": "El resultado lleva text o error."}, ""
        with session.lock:
            if session.result is not None:
                return None, {"code": -32602, "message": "El resultado ya se recibió."}, ""
            session.result = {"text": text} if error is None else {"error": error}
        session.finished.set()
        return {"ok": True}, None, ""
    return None, {"code": -32601, "message": f"Método '{method}' no soportado."}, ""


def read_run_prompt(prompt: str | None, prompt_file: str | None) -> str:
    """Prompt de --prompt o de --prompt-file ('-' lee la entrada estándar)."""
    if prompt_file is not None:
        try:
            prompt = sys.stdin.read() if prompt_file == "-" else Path(prompt_file).read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as exc:
            raise RunSetupError(f"No se pudo leer el prompt de {prompt_file}: {exc}") from exc
    if not prompt or not prompt.strip():
        raise RunSetupError("El prompt está vacío.")
    return prompt.strip()


def _stop_browser(proc: subprocess.Popen | None, headless: bool):
    """Deja cerrar sola la ventana visible un momento y mata después todo el grupo del navegador."""
    if proc is None:
        return
    if not headless:
        try:
            proc.wait(timeout=RUN_BROWSER_CLOSE_GRACE)
        except subprocess.TimeoutExpired:
            pass
    _kill_process_tree(proc)
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        log_event(f"[run] El navegador (PID {proc.pid}) no terminó tras matarlo.")


def _remove_profile_copy(copy_dir: Path | None):
    if copy_dir is None:
        return
    shutil.rmtree(copy_dir, ignore_errors=True)
    if copy_dir.exists():
        log_event(f"[run] AVISO: no se pudo borrar la copia del perfil {copy_dir}; contiene credenciales, bórrala a mano.")


def _supervise_run(session: RunSession, proc: subprocess.Popen, timeout: float) -> tuple[int, str]:
    """Espera el resultado vigilando el navegador, la inactividad y el plazo total."""
    deadline = time.monotonic() + timeout
    while not session.finished.wait(RUN_POLL_SECONDS):
        if session.interrupted.is_set():
            return RUN_EXIT_TIMEOUT, "Ejecución interrumpida."
        if proc.poll() is not None:
            return RUN_EXIT_TIMEOUT, f"El navegador terminó sin devolver resultado (código {proc.returncode})."
        if time.monotonic() >= deadline:
            return RUN_EXIT_TIMEOUT, f"Plazo total agotado ({timeout:.0f}s)."
        if session.idle_seconds() > RUN_IDLE_SECONDS:
            return RUN_EXIT_TIMEOUT, f"Sin progreso de la interfaz durante {RUN_IDLE_SECONDS:.0f}s."
    if "error" in session.result:
        return RUN_EXIT_ERROR, f"Error de generación: {session.result['error']}"
    return RUN_EXIT_DONE, ""


def run_prompt(prompt: str, headless: bool, timeout: float) -> tuple[int, str | None]:
    """Ejecuta el prompt en la interfaz y devuelve (código de salida, respuesta final si terminó bien)."""
    global RUN_SESSION, ACTIVE_PORT, ACTIVE_HOST
    origin = ui_origin()
    session = RunSession(prompt)
    server = None
    serve_thread = None
    proc = None
    copy_dir = None

    # Una señal no mata el proceso: termina la supervisión y la limpieza borra la copia del perfil.
    def interrupt(*_):
        session.interrupted.set()
    for sig in (signal.SIGINT, signal.SIGTERM, getattr(signal, "SIGHUP", None)):
        if sig is not None:
            signal.signal(sig, interrupt)

    try:
        try:
            profile = locate_firefox_profile(origin)
            log_event(f"[run] Perfil de Firefox: {profile}")
            copy_dir = create_firefox_run_profile(profile, origin)
            init_session_credentials()
            ACTIVE_HOST = DEFAULT_HOST
            server = ThreadingHTTPServer((ACTIVE_HOST, 0), ZeroChatServerHandler)
            ACTIVE_PORT = server.server_address[1]
            RUN_SESSION = session
            serve_thread = threading.Thread(target=server.serve_forever, name="zerochat-run-server", daemon=True)
            serve_thread.start()
            fragment = urlencode({"token": SESSION_TOKEN, "host": ACTIVE_HOST, "port": ACTIVE_PORT, "run": session.run_id})
            command = firefox_launch_command(copy_dir, f"{DEFAULT_UI_URL}#{fragment}", headless)
            proc = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        except (RunSetupError, OSError) as exc:
            log_event(f"[run] {exc}")
            return RUN_EXIT_SETUP, None
        log_event(f"[run] Firefox {'sin ventana' if headless else 'con ventana'} en marcha (PID {proc.pid}); servidor en el puerto {ACTIVE_PORT}.")
        code, message = _supervise_run(session, proc, timeout)
        log_event(f"[run] {message or 'Ejecución terminada.'}")
        return code, session.result["text"] if code == RUN_EXIT_DONE else None
    finally:
        _stop_browser(proc, headless)
        _remove_profile_copy(copy_dir)
        if server is not None:
            stop_zerochat_server(server)
            if serve_thread is not None:
                serve_thread.join(timeout=5)
            server.server_close()
        RUN_SESSION = None


def run_mode_main(args) -> int:
    """Modo ejecución completo: stdout lleva solo la respuesta final; el registro va a stderr."""
    result_out = sys.stdout
    sys.stdout = sys.stderr
    try:
        try:
            prompt = read_run_prompt(args.prompt, args.prompt_file)
        except RunSetupError as exc:
            log_event(f"[run] {exc}")
            return RUN_EXIT_SETUP
        orphans = cleanup_orphan_jobs()
        if orphans:
            log_event(f"Detenidos {orphans} comando(s) que seguían en marcha de una sesión anterior interrumpida.")
        if not args.no_venv:
            ensure_virtual_environment()
        code, text = run_prompt(prompt, args.headless, args.timeout)
    finally:
        sys.stdout = result_out
    if text is not None:
        result_out.write(text if text.endswith("\n") else text + "\n")
        result_out.flush()
    return code
