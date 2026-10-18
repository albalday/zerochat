# ==============================================================================
# Modo ejecución desatendida (zerochat.py --prompt)
# ==============================================================================
# El servidor arranca y abre el navegador como siempre, con run=<id> en el fragmento: la interfaz
# pide el prompt, informa del progreso y devuelve el resultado por JSON-RPC zerochat/run/*.

# Plazo total y sin progreso de la interfaz; las variables de entorno solo las usan las pruebas.
RUN_TOTAL_TIMEOUT = float(os.environ.get("ZEROCHAT_RUN_TIMEOUT", "900"))
RUN_IDLE_SECONDS = float(os.environ.get("ZEROCHAT_RUN_IDLE_SECONDS", "180"))
RUN_POLL_SECONDS = 0.2
RUN_PROGRESS_TEXT_MAX = 500
RUN_PROGRESS_KIND_PATTERN = re.compile(r"[a-z_]{1,32}")
RUN_EXIT_DONE = 0
RUN_EXIT_ERROR = 1
RUN_EXIT_TIMEOUT = 2
RUN_EXIT_SETUP = 3
# Formato de --export según la extensión del fichero; la interfaz genera el contenido con ChatExport.
RUN_EXPORT_FORMATS = {".md": "markdown", ".json": "json"}


class RunSession:
    """Estado de la ejecución: prompt, opciones, último progreso, exportación, resultado y motivo de un final sin él."""
    def __init__(self, prompt: str, profile: str | None = None, export_path: Path | None = None, keep_open: bool = False):
        self.run_id = secrets.token_urlsafe(24)
        self.prompt = prompt
        # Perfil de conexión (nombre o id) que la interfaz usa solo en esta ejecución; None, el activo.
        self.profile = profile
        # Fichero donde se escribe la conversación exportada (formato por su extensión); None, sin exportar.
        self.export_path = export_path
        self.exported = False
        self.export_error: str | None = None
        # La interfaz no cierra la página al terminar, para ver la conversación (sin --headless).
        self.keep_open = keep_open
        self.lock = threading.Lock()
        self.last_activity = time.monotonic()
        self.prompt_delivered = False
        self.result: dict | None = None
        self.stop_reason: str | None = None
        self.finished = threading.Event()

    def touch(self):
        with self.lock:
            self.last_activity = time.monotonic()

    def idle_seconds(self) -> float:
        with self.lock:
            return time.monotonic() - self.last_activity


RUN_SESSION: RunSession | None = None


def dispatch_run(method: str, params: dict) -> tuple[dict | None, dict | None, str]:
    """Métodos zerochat/run/* que usa la interfaz abierta por el modo ejecución."""
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
        export_format = RUN_EXPORT_FORMATS[session.export_path.suffix.lower()] if session.export_path else None
        return {"prompt": session.prompt, "profile": session.profile, "export": export_format, "keep_open": session.keep_open}, None, ""
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
    if method == "zerochat/run/export":
        content = params.get("content")
        if session.export_path is None or not isinstance(content, str):
            return None, {"code": -32602, "message": "Exportación no pedida o sin contenido."}, ""
        with session.lock:
            if session.exported:
                return None, {"code": -32602, "message": "La exportación ya se recibió."}, ""
            try:
                session.export_path.write_text(content, encoding="utf-8")
            except OSError as exc:
                session.export_error = f"No se pudo escribir {session.export_path}: {exc}"
                return None, {"code": -32603, "message": session.export_error}, ""
            session.exported = True
        session.touch()
        log_event(f"[run] Conversación exportada en {session.export_path}")
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


def run_supervisor(server: ThreadingHTTPServer, session: RunSession):
    """Detiene el servidor al recibir el resultado o al agotar el plazo total o el de inactividad."""
    deadline = time.monotonic() + RUN_TOTAL_TIMEOUT
    while not session.finished.wait(RUN_POLL_SECONDS):
        # El latido o una señal ya detienen el servidor: el resultado queda vacío.
        if _SERVER_SHUTTING_DOWN.is_set():
            return
        if time.monotonic() >= deadline:
            session.stop_reason = f"Plazo total agotado ({RUN_TOTAL_TIMEOUT:.0f}s)."
            break
        if session.idle_seconds() > RUN_IDLE_SECONDS:
            session.stop_reason = f"Sin progreso de la interfaz durante {RUN_IDLE_SECONDS:.0f}s."
            break
    stop_zerochat_server(server)


def run_error(message: str):
    """Motivo de un final sin respuesta: va a stderr aunque el registro esté desactivado (--log off)."""
    print(timestamp_message(f"[run] {message}"), file=sys.stderr, flush=True)


def run_outcome(session: RunSession) -> tuple[int, str | None]:
    """
    Código de salida y respuesta final (solo si terminó bien), con el motivo de un fallo en stderr;
    una exportación pedida que no se escribió convierte un final correcto en error sin quitar la respuesta.
    """
    if session.export_path and not session.exported:
        run_error(session.export_error or f"La interfaz no envió la conversación para {session.export_path}.")
    if session.result is None:
        run_error(session.stop_reason or "El navegador se cerró o la ejecución se interrumpió sin resultado.")
        return RUN_EXIT_TIMEOUT, None
    if "error" in session.result:
        run_error(f"Error de generación: {session.result['error']}")
        return RUN_EXIT_ERROR, None
    log_event("[run] Ejecución terminada.")
    if session.export_path and not session.exported:
        return RUN_EXIT_ERROR, session.result["text"]
    return RUN_EXIT_DONE, session.result["text"]


def fall_back_when_headless_exits(proc: subprocess.Popen, url: str):
    """
    Un navegador sin ventana termina enseguida si su perfil ya está abierto (Firefox avisa de que
    ya está en marcha): si acaba antes de que conecte la interfaz, se abre la pestaña normal.
    """
    proc.wait()
    if not HEARTBEAT_INITIALIZED and not _SERVER_SHUTTING_DOWN.is_set():
        log_event("El navegador sin ventana terminó sin abrir la interfaz (¿ya estaba abierto?); se abre una pestaña de la forma normal.")
        launch_browser(url)
