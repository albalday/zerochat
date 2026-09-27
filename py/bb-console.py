
def format_uptime(seconds: float) -> str:
    """Devuelve una duración breve y estable para la línea de estado de consola."""
    total = max(0, int(seconds))
    hours, remainder = divmod(total, 3600)
    minutes, secs = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}"


class ConsoleControl:
    """Atajos de consola y línea de estado, solo para terminales interactivos."""
    def __init__(self, server: ThreadingHTTPServer, parser: argparse.ArgumentParser, target_url: str | None = None):
        self.server = server
        self.parser = parser
        self.target_url = target_url
        self.started_at = time.monotonic()
        self.last_activity = self.started_at
        self.stop_event = threading.Event()
        self.lock = threading.Lock()
        self.status_visible = False
        self.enabled = bool(getattr(sys.stdin, "isatty", lambda: False)() and getattr(sys.stdout, "isatty", lambda: False)())
        self._threads: list[threading.Thread] = []
        self._terminal_fd: int | None = None
        self._terminal_state = None
        self._closed = False

    def start(self):
        if not self.enabled:
            return
        if os.name != "nt":
            try:
                import termios
                import tty
                self._terminal_fd = sys.stdin.fileno()
                self._terminal_state = termios.tcgetattr(self._terminal_fd)
                tty.setcbreak(self._terminal_fd)
            except (OSError, ValueError):
                self._restore_terminal()
                self.enabled = False
                return
        self._threads = [
            threading.Thread(target=self._status_loop, name="zerochat-console-status", daemon=True),
            threading.Thread(target=self._keyboard_loop, name="zerochat-console-input", daemon=True),
        ]
        for thread in self._threads:
            thread.start()

    def close(self):
        if self._closed:
            return
        self._closed = True
        self.stop_event.set()
        for thread in self._threads:
            if thread is not threading.current_thread():
                thread.join(timeout=1.0)
        self._restore_terminal()
        self.clear_status(final=True)

    def _restore_terminal(self):
        if self._terminal_fd is None or self._terminal_state is None:
            return
        try:
            import termios
            termios.tcsetattr(self._terminal_fd, termios.TCSADRAIN, self._terminal_state)
        except OSError:
            pass
        finally:
            self._terminal_fd = None
            self._terminal_state = None

    def clear_status(self, *, final: bool = False):
        if not self.enabled:
            return
        with self.lock:
            if self.status_visible:
                sys.stdout.write("\r\033[2K")
                self.status_visible = False
            if final:
                sys.stdout.write("\r\n")
            sys.stdout.flush()

    def log(self, message: str, *, flush: bool = True):
        with self.lock:
            if self.enabled and self.status_visible:
                sys.stdout.write("\r\033[2K")
                self.status_visible = False
            print(message, flush=flush)
            self.last_activity = time.monotonic()

    def show_help(self):
        with self.lock:
            if self.status_visible:
                sys.stdout.write("\r\033[2K")
                self.status_visible = False
            commands = "[h] ayuda · [n] Navegador"
            if get_notices():
                commands += " · [i] información"
            print(f"\nComandos de consola: {commands} · [x] salir ordenadamente\n", flush=True)
            print(self.parser.format_help().rstrip(), flush=True)
            self.last_activity = time.monotonic()

    def show_notices(self):
        notices = get_notices()
        if not notices:
            return
        with self.lock:
            if self.status_visible:
                sys.stdout.write("\r\033[2K")
                self.status_visible = False
            print("\nInformación:", flush=True)
            for notice in notices:
                print(f"- {notice}", flush=True)
            print(flush=True)
            self.last_activity = time.monotonic()

    def _render_status(self):
        if not self.enabled:
            return
        uptime = format_uptime(time.monotonic() - self.started_at)
        with self.lock:
            if time.monotonic() - self.last_activity < CONSOLE_STATUS_IDLE_SECONDS:
                return
            commands = "[h] ayuda · [n] Navegador"
            if get_notices():
                commands += " · [i] información"
            sys.stdout.write(f"\r\033[2KZeroChat activo {uptime} · {commands} · [x] salir")
            sys.stdout.flush()
            self.status_visible = True

    def _status_loop(self):
        while not self.stop_event.wait(1.0):
            self._render_status()

    def _handle_key(self, key: str):
        if key.lower() == "h":
            self.show_help()
        elif key.lower() == "n":
            if self.target_url:
                launch_browser(self.target_url)
        elif key.lower() == "i":
            self.show_notices()
        elif key.lower() == "x":
            self.log(f"[{time.strftime('%H:%M:%S')}] Deteniendo servidor ZeroChat...")
            stop_zerochat_server(self.server)

    def _keyboard_loop(self):
        if os.name == "nt":
            import msvcrt
            while not self.stop_event.wait(0.05):
                if msvcrt.kbhit():
                    self._handle_key(msvcrt.getwch())
            return

        import select
        while not self.stop_event.is_set():
            ready, _, _ = select.select([sys.stdin], [], [], 0.1)
            if ready:
                self._handle_key(sys.stdin.read(1))


def console_log(message: str, *, flush: bool = True):
    if CONSOLE_CONTROL:
        CONSOLE_CONTROL.log(message, flush=flush)
    else:
        print(message, flush=flush)
