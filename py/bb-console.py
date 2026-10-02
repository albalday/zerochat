class ConsoleControl:
    """Muestra una sola línea de ayuda tras un periodo de inactividad en consola."""
    def __init__(self, server: ThreadingHTTPServer, parser: argparse.ArgumentParser, target_url: str | None = None):
        self.server = server
        self.parser = parser
        self.target_url = target_url
        self.last_activity = time.monotonic()
        self.lock = threading.Lock()
        self.enabled = bool(getattr(sys.stdout, "isatty", lambda: False)())
        self._keyboard_enabled = bool(getattr(sys.stdin, "isatty", lambda: False)())
        self._idle_timer: threading.Timer | None = None
        self._keyboard_stop = threading.Event()
        self._keyboard_thread: threading.Thread | None = None
        self._timer_generation = 0
        self._closed = False

    def start(self):
        if self.enabled:
            self._reset_idle_timer()
        if self._keyboard_enabled:
            self._keyboard_thread = threading.Thread(target=self._keyboard_loop, name="zerochat-console-input", daemon=True)
            self._keyboard_thread.start()

    def close(self):
        with self.lock:
            self._closed = True
            self._keyboard_stop.set()
            if self._idle_timer:
                self._idle_timer.cancel()
                self._idle_timer = None

    def _reset_idle_timer(self):
        with self.lock:
            if self._closed:
                return
            self.last_activity = time.monotonic()
            self._timer_generation += 1
            if self._idle_timer:
                self._idle_timer.cancel()
            generation = self._timer_generation
            self._idle_timer = threading.Timer(CONSOLE_STATUS_IDLE_SECONDS, self._show_commands_once, args=(generation,))
            self._idle_timer.daemon = True
            self._idle_timer.start()

    def _show_commands_once(self, generation: int):
        with self.lock:
            if self._closed or generation != self._timer_generation:
                return
            commands = "[h] ayuda · [n] Navegador"
            if get_notices():
                commands += " · [i] información"
            print(f"Comandos de consola: {commands} · [x] salir ordenadamente", flush=True)
            self._idle_timer = None

    def log(self, message: str, *, flush: bool = True):
        print(message, flush=flush)
        if self.enabled:
            self._reset_idle_timer()

    def show_help(self):
        print(self.parser.format_help().rstrip(), flush=True)

    def show_notices(self):
        notices = get_notices()
        if not notices:
            return
        print("Información:", flush=True)
        for notice in notices:
            print(f"- {notice}", flush=True)

    def _handle_command(self, command: str):
        key = command.strip().lower()
        if key == "h":
            self.show_help()
        elif key == "n" and self.target_url:
            launch_browser(self.target_url)
        elif key == "i":
            self.show_notices()
        elif key == "x":
            self.log(timestamp_message("Deteniendo servidor ZeroChat..."))
            stop_zerochat_server(self.server)

    def _keyboard_loop(self):
        """Lee comandos normales terminados con Intro, sin alterar el terminal."""
        while not self._keyboard_stop.is_set():
            line = sys.stdin.readline()
            if not line:
                return
            self._handle_command(line)


def console_log(message: str, *, flush: bool = True):
    if CONSOLE_CONTROL:
        CONSOLE_CONTROL.log(message, flush=flush)
    else:
        print(message, flush=flush)


def timestamp_message(message: str) -> str:
    """Antepone la hora local con el formato común de la consola."""
    return f"[{time.strftime('%H:%M:%S')}] {message}"


def log_event(message: str):
    """Registra en consola un evento con la hora local."""
    console_log(timestamp_message(message))
