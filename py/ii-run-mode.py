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
RUN_STREAM_TEXT_MAX = 8000
RUN_PROGRESS_KIND_PATTERN = re.compile(r"[a-z_]{1,32}")
RUN_EXIT_DONE = 0
RUN_EXIT_ERROR = 1
RUN_EXIT_TIMEOUT = 2
RUN_EXIT_SETUP = 3
# Argumentos no válidos, en cualquier modo: argparse usaría 2, que con --prompt es plazo agotado.
RUN_EXIT_ARGS = 4
# Perfil por defecto de --prompt cuando no se indica --profile.
DEFAULT_RUN_PROFILE = "local"
# Formato de --export según la extensión del fichero; la interfaz genera el contenido con ChatExport.
RUN_EXPORT_FORMATS = {".md": "markdown", ".json": "json", ".html": "html"}
# Cuerpo HTTP admitido mientras se espera la exportación: el JSON y el HTML llevan las imágenes incrustadas.
RUN_EXPORT_MAX_BODY_BYTES = 64 * 1024 * 1024


def get_runs_dir() -> Path:
    """Directorio persistente con permisos 0700 para los ficheros de situación de ejecuciones en servidor."""
    runs_dir = get_data_dir() / "runs"
    runs_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    if os.name != "nt":
        runs_dir.chmod(0o700)
    return runs_dir


def get_run_state_path(conversation_id: str) -> Path:
    """Ruta al fichero de situación de la conversación en ~/zerochat/runs/."""
    clean_name = urllib.parse.quote(conversation_id.strip(), safe="")
    return get_runs_dir() / f"{clean_name}.json"


def _run_process_alive(data: dict) -> bool:
    """Comprueba si el proceso de una ejecución sigue activo y corresponde al arranque original."""
    pid = data.get("pid")
    if not _pid_alive(pid):
        return False
    saved_start = data.get("pid_start")
    if saved_start:
        current_start = _process_start_token(pid)
        if current_start is not None and current_start != saved_start:
            return False
    return True


def write_run_state(session: RunSession) -> None:
    """Escribe atómicamente el estado en vivo de la ejecución en ~/zerochat/runs/<conversation_id>.json (0600)."""
    if not session.conversation_id:
        return
    state_path = get_run_state_path(session.conversation_id)
    now = int(time.time() * 1000)
    session.updated_at = now
    payload = {
        "run_id": session.run_id,
        "conversation_id": session.conversation_id,
        "pid": session.pid,
        "pid_start": session.pid_start,
        "started_at": session.started_at,
        "updated_at": session.updated_at,
        "status": session.status,
        "step_text": session.step_text,
        "assistant_text": session.assistant_text,
        "reasoning_text": session.reasoning_text,
        "pending": session.pending,
        "error": session.error
    }
    _write_private_text(state_path, json.dumps(payload, ensure_ascii=False, indent=2))


def remove_run_state(conversation_id: str | None) -> None:
    """Elimina el fichero de situación de la conversación al completarse con éxito."""
    if not conversation_id:
        return
    try:
        get_run_state_path(conversation_id).unlink(missing_ok=True)
    except OSError:
        pass


def _kill_pid_tree(pid: int) -> None:
    """Termina el proceso por su PID y su grupo o árbol de procesos si es líder de su grupo."""
    if not _pid_alive(pid) or pid == os.getpid():
        return
    try:
        if DETECTED_OS == "windows":
            subprocess.run(
                ["taskkill", "/PID", str(pid), "/T", "/F"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)
            )
        elif hasattr(os, "killpg") and hasattr(os, "getpgid"):
            try:
                if os.getpgid(pid) == pid:
                    os.killpg(pid, signal.SIGTERM)
                    time.sleep(0.05)
                    if _pid_alive(pid):
                        os.killpg(pid, signal.SIGKILL)
                else:
                    os.kill(pid, signal.SIGTERM)
                    time.sleep(0.05)
                    if _pid_alive(pid):
                        os.kill(pid, signal.SIGKILL)
            except OSError:
                try:
                    os.kill(pid, signal.SIGKILL)
                except OSError:
                    pass
        else:
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass
    except (ProcessLookupError, PermissionError, OSError):
        pass


def list_server_runs(focus_conversation_id: str | None = None) -> tuple[list[dict], dict | None]:
    """
    Lee las situaciones en ~/zerochat/runs/*.json. Si un proceso 'running' ya murió,
    lo marca como 'error'. Devuelve (runs, focus_run), donde runs es una lista ligera
    ordenada por started_at, y focus_run es el detalle completo si coincide con focus_conversation_id.
    En un servidor de ejecución (--prompt o --conversation) devuelve ([], None) para que el propio
    worker no se bloquee ni omita el guardado de su conversación.
    """
    if RUN_SESSION is not None:
        return [], None
    runs_dir = get_runs_dir()
    entries = []
    clean_focus_id = focus_conversation_id.strip() if (isinstance(focus_conversation_id, str) and focus_conversation_id.strip()) else None

    for path in sorted(runs_dir.glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        if not isinstance(data, dict):
            continue
        conv_id = data.get("conversation_id")
        if not conv_id or not isinstance(conv_id, str):
            continue

        status = data.get("status")
        if status == "running" and not _run_process_alive(data):
            status = "error"
            data["status"] = "error"
            data["error"] = "El proceso de ejecución terminó inesperadamente."
            data["updated_at"] = int(time.time() * 1000)
            try:
                _write_private_text(path, json.dumps(data, ensure_ascii=False, indent=2))
            except OSError:
                pass

        light = {
            "conversation_id": conv_id,
            "run_id": data.get("run_id"),
            "status": status
        }
        started_at = data.get("started_at", 0)
        entries.append((started_at, light, data))

    entries.sort(key=lambda item: item[0])
    runs = [item[1] for item in entries]

    focus_run = None
    if clean_focus_id:
        for _, _, full_data in entries:
            if full_data.get("conversation_id") == clean_focus_id:
                focus_run = full_data
                break

    return runs, focus_run


def start_server_run(params: dict) -> dict:
    """Inicia una ejecución en segundo plano para una conversación."""
    if not isinstance(params, dict):
        raise ValueError("Parámetros no válidos.")
    conv_id = params.get("conversation_id")
    if not isinstance(conv_id, str) or not conv_id.strip():
        raise ValueError("conversation_id requerido.")
    clean_conv_id = _validate_conversation_id(conv_id)
    conv = get_conversation(clean_conv_id)
    if conv is None:
        raise ValueError(f"Conversación '{clean_conv_id}' no encontrada.")

    profile = params.get("profile")
    if not isinstance(profile, str) or not profile.strip():
        conv_profile = conv.get("profileId")
        if isinstance(conv_profile, str) and conv_profile.strip():
            profile = conv_profile.strip()
        else:
            raise ValueError("profile requerido.")
    profile_entry = get_general_profile(profile) or get_general_profile_by_name(profile)
    if not profile_entry:
        raise ValueError(f"Perfil del servidor '{profile}' no encontrado.")
    profile_name = profile_entry.get("name", profile.strip())

    state_path = get_run_state_path(clean_conv_id)
    if state_path.exists():
        try:
            existing = json.loads(state_path.read_text(encoding="utf-8"))
            if isinstance(existing, dict) and existing.get("status") == "running" and _run_process_alive(existing):
                raise ValueError(f"Ya hay una ejecución en marcha para la conversación '{clean_conv_id}'.")
        except (json.JSONDecodeError, OSError):
            pass

    prompt = params.get("prompt")
    if prompt is not None and not isinstance(prompt, str):
        raise ValueError("prompt debe ser una cadena o null.")

    tool_security = params.get("tool_security")
    if tool_security is not None and not isinstance(tool_security, dict):
        raise ValueError("tool_security debe ser un objeto o null.")

    if not playwright_chromium_executable():
        raise ValueError("No está instalado el Chromium de Playwright (instálalo desde Ajustes › Navegador).")

    run_id = secrets.token_urlsafe(24)
    cmd = [sys.executable, str(Path(__file__).resolve()), "--conversation", clean_conv_id, "--profile", profile_name]
    if prompt:
        cmd.extend(["--prompt", prompt])

    env = dict(os.environ)
    env["ZEROCHAT_RUN_ID"] = run_id
    if tool_security:
        env["ZEROCHAT_RUN_SECURITY"] = json.dumps(tool_security, ensure_ascii=False)

    now = int(time.time() * 1000)
    mark_conversation_server_run(clean_conv_id, profile_name)

    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=DETECTED_OS != "windows" and hasattr(os, "setsid"),
        env=env
    )

    payload = {
        "run_id": run_id,
        "conversation_id": clean_conv_id,
        "pid": proc.pid,
        "pid_start": _process_start_token(proc.pid),
        "started_at": now,
        "updated_at": now,
        "status": "running",
        "step_text": "",
        "assistant_text": "",
        "reasoning_text": "",
        "pending": None,
        "error": None
    }
    _write_private_text(state_path, json.dumps(payload, ensure_ascii=False, indent=2))

    return {"ok": True, "run_id": run_id, "conversation_id": clean_conv_id, "status": "running"}


def cancel_server_run(conversation_id: str) -> dict:
    """Cancela una ejecución en segundo plano: termina el proceso si sigue en marcha y elimina el fichero."""
    if not isinstance(conversation_id, str) or not conversation_id.strip():
        raise ValueError("conversation_id requerido.")
    clean_conv_id = _validate_conversation_id(conversation_id)
    state_path = get_run_state_path(clean_conv_id)
    if state_path.exists():
        try:
            data = json.loads(state_path.read_text(encoding="utf-8"))
            if isinstance(data, dict) and data.get("status") == "running" and _run_process_alive(data):
                _kill_pid_tree(data.get("pid"))
        except (json.JSONDecodeError, OSError):
            pass
        remove_run_state(clean_conv_id)
    return {"cancelled": True}


class RunSession:
    """Estado de la ejecución: prompt, opciones, último progreso, exportación, resultado y motivo de un final sin él."""
    def __init__(self, prompt: str | None = None, profile: str | None = None, export_path: Path | None = None, keep_page: bool = False,
                 allow_dangerous_tools: bool = False, conversation_id: str | None = None, run_id: str | None = None,
                 tool_security: dict | None = None):
        env_run_id = os.environ.get("ZEROCHAT_RUN_ID", "").strip()
        self.run_id = run_id.strip() if (run_id and isinstance(run_id, str) and run_id.strip()) else (env_run_id or secrets.token_urlsafe(24))
        self.conversation_id = conversation_id
        self.prompt = prompt
        # Perfil (nombre o id) que la interfaz usa solo en esta ejecución; por defecto, local del servidor.
        self.profile = profile
        # Fichero donde se escribe la conversación exportada (formato por su extensión); None, sin exportar.
        self.export_path = export_path
        self.exported = False
        self.export_error: str | None = None
        # La interfaz no cierra la página al terminar, para ver la conversación (sin --headless).
        self.keep_page = keep_page
        # La interfaz aprueba también write_file, edit_file y run_command, que si no deniega.
        self.allow_dangerous_tools = allow_dangerous_tools
        if tool_security is not None:
            self.tool_security = tool_security
        elif os.environ.get("ZEROCHAT_RUN_SECURITY"):
            try:
                self.tool_security = json.loads(os.environ["ZEROCHAT_RUN_SECURITY"])
            except (json.JSONDecodeError, TypeError):
                self.tool_security = None
        else:
            self.tool_security = None
        self.lock = threading.Lock()
        self.last_activity = time.monotonic()
        self.prompt_delivered = False
        self.result: dict | None = None
        self.stop_reason: str | None = None
        self.finished = threading.Event()
        self.pid = os.getpid()
        self.pid_start = _process_start_token(self.pid)
        self.started_at = int(time.time() * 1000)
        self.updated_at = self.started_at
        self.status = "running"
        self.step_text = ""
        self.assistant_text = ""
        self.reasoning_text = ""
        self.pending: dict | None = None
        self.error: str | None = None
        if self.conversation_id:
            write_run_state(self)

    def touch(self):
        with self.lock:
            self.last_activity = time.monotonic()

    def idle_seconds(self) -> float:
        with self.lock:
            return time.monotonic() - self.last_activity


RUN_SESSION: RunSession | None = None


def http_body_limit() -> int:
    """Tope del cuerpo que se lee: el general, o el de la exportación mientras se espera (ff-server
    rechaza después cualquier otro método que supere el general)."""
    session = RUN_SESSION
    if session is not None and session.export_path is not None and not session.exported:
        return RUN_EXPORT_MAX_BODY_BYTES
    return MAX_HTTP_BODY_BYTES


def dispatch_run(method: str, params: dict) -> tuple[dict | None, dict | None, str]:
    """Métodos zerochat/run/* que usa la interfaz abierta por el modo ejecución."""
    params = params if isinstance(params, dict) else {}
    session = RUN_SESSION
    if method == "zerochat/run/start":
        if session is not None:
            return None, {"code": -32601, "message": "No disponible dentro de un proceso de ejecución."}, ""
        try:
            return start_server_run(params), None, ""
        except ValueError as exc:
            return None, {"code": -32602, "message": str(exc)}, ""
        except OSError as exc:
            return None, {"code": -32603, "message": f"Error al iniciar ejecución en servidor: {exc}"}, str(exc)
    if method == "zerochat/run/cancel":
        if session is not None:
            return None, {"code": -32601, "message": "No disponible dentro de un proceso de ejecución."}, ""
        try:
            conv_id = params.get("conversation_id")
            return cancel_server_run(conv_id), None, ""
        except ValueError as exc:
            return None, {"code": -32602, "message": str(exc)}, ""
        except OSError as exc:
            return None, {"code": -32603, "message": f"Error al cancelar ejecución en servidor: {exc}"}, str(exc)

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
        return {"prompt": session.prompt, "conversation_id": session.conversation_id, "profile": session.profile,
                "export": export_format, "keep_page": session.keep_page,
                "allow_dangerous_tools": session.allow_dangerous_tools, "tool_security": session.tool_security}, None, ""
    if method == "zerochat/run/progress":
        kind = params.get("kind")
        text = params.get("text", "")
        if not isinstance(kind, str) or not RUN_PROGRESS_KIND_PATTERN.fullmatch(kind) or not isinstance(text, str):
            return None, {"code": -32602, "message": "Progreso no válido."}, ""
        assistant_text = params.get("assistant_text")
        reasoning_text = params.get("reasoning_text")
        if assistant_text is not None and not isinstance(assistant_text, str):
            return None, {"code": -32602, "message": "assistant_text debe ser una cadena."}, ""
        if reasoning_text is not None and not isinstance(reasoning_text, str):
            return None, {"code": -32602, "message": "reasoning_text debe ser una cadena."}, ""
        session.touch()
        truncated_step = text[:RUN_PROGRESS_TEXT_MAX] + "…" if len(text) > RUN_PROGRESS_TEXT_MAX else text
        log_event(f"[run] {kind}{': ' + truncated_step if truncated_step else ''}")
        with session.lock:
            session.step_text = truncated_step
            if assistant_text is not None:
                session.assistant_text = assistant_text[:RUN_STREAM_TEXT_MAX] + ("…" if len(assistant_text) > RUN_STREAM_TEXT_MAX else "")
            if reasoning_text is not None:
                session.reasoning_text = reasoning_text[:RUN_STREAM_TEXT_MAX] + ("…" if len(reasoning_text) > RUN_STREAM_TEXT_MAX else "")
            write_run_state(session)
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
        needs_input = params.get("needs_input")
        is_text = isinstance(text, str) and error is None and needs_input is None
        is_error = isinstance(error, str) and bool(error) and text is None and needs_input is None
        is_needs_input = isinstance(needs_input, dict) and text is None and error is None
        if not (is_text or is_error or is_needs_input):
            return None, {"code": -32602, "message": "El resultado lleva text o error."}, ""
        with session.lock:
            if session.result is not None:
                return None, {"code": -32602, "message": "El resultado ya se recibió."}, ""
            if is_text:
                session.result = {"text": text}
                session.status = "completed"
                remove_run_state(session.conversation_id)
            elif is_needs_input:
                session.result = {"needs_input": needs_input}
                session.status = "needs_input"
                session.pending = needs_input
                write_run_state(session)
            else:
                session.result = {"error": error}
                session.status = "error"
                session.error = error
                write_run_state(session)
        session.finished.set()
        return {"ok": True}, None, ""
    return None, {"code": -32601, "message": f"Método '{method}' no soportado."}, ""


def run_supervisor(server: ThreadingHTTPServer, session: RunSession, browser_proc: subprocess.Popen | None = None):
    """Detiene el servidor al recibir el resultado, si termina el navegador propio o al agotar los plazos."""
    deadline = time.monotonic() + RUN_TOTAL_TIMEOUT
    while not session.finished.wait(RUN_POLL_SECONDS):
        # El latido o una señal ya detienen el servidor: el resultado queda vacío.
        if _SERVER_SHUTTING_DOWN.is_set():
            return
        if browser_proc is not None and browser_proc.poll() is not None and not session.finished.wait(0.2):
            break
        if time.monotonic() >= deadline:
            session.stop_reason = f"Plazo total agotado ({RUN_TOTAL_TIMEOUT:.0f}s)."
            break
        if session.idle_seconds() > RUN_IDLE_SECONDS:
            session.stop_reason = f"Sin progreso de la interfaz durante {RUN_IDLE_SECONDS:.0f}s."
            break
    if session.result is None and session.conversation_id:
        with session.lock:
            session.status = "error"
            session.error = session.stop_reason or "El navegador se cerró o la ejecución se interrumpió sin resultado."
            write_run_state(session)
    stop_zerochat_server(server)


def run_error(message: str):
    """Motivo de un final sin respuesta: va a stderr aunque el registro esté desactivado (--log off)."""
    session = RUN_SESSION
    if session is not None and session.conversation_id and session.result is None:
        with session.lock:
            session.status = "error"
            session.error = message
            write_run_state(session)
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
    if "needs_input" in session.result:
        log_event("[run] Ejecución pausada a la espera del usuario.")
        return RUN_EXIT_DONE, json.dumps(session.result["needs_input"], ensure_ascii=False)
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
