def is_termux_environment() -> bool:
    """Devuelve si el proceso se ejecuta dentro de la instalación de Termux."""
    termux_prefix = "/data/data/com.termux/files/usr"
    return bool(
        os.environ.get("TERMUX_VERSION")
        or os.environ.get("PREFIX", "").startswith(termux_prefix)
        or sys.prefix.startswith(termux_prefix)
    )


def get_manual_browser_command(url: str) -> str | None:
    """Devuelve un comando pegable para abrir la sesión cuando Termux no pudo hacerlo."""
    if is_termux_environment():
        return shlex.join(["termux-open-url", url])
    return None


def get_termux_open_url_executable() -> str | None:
    """Localiza termux-open-url incluso si el venv recibió un PATH incompleto."""
    if shutil.which("termux-open-url"):
        return "termux-open-url"

    prefix = os.environ.get("PREFIX", "/data/data/com.termux/files/usr")
    executable = Path(prefix) / "bin" / "termux-open-url"
    if executable.is_file():
        return str(executable)
    return None


def browser_launch_diagnostics(attempts: list[str]) -> str:
    """Resume el entorno y los lanzadores comprobados sin exponer la URL de sesión."""
    termux_prefix = os.environ.get("PREFIX", "(no definido)")
    configured_path = os.environ.get("PATH", "(no definido)")
    termux_binary = Path(termux_prefix) / "bin" / "termux-open-url" if termux_prefix != "(no definido)" else None
    lines = [
        f"plataforma={sys.platform}",
        f"termux_detectado={is_termux_environment()}",
        f"TERMUX_VERSION={'definido' if os.environ.get('TERMUX_VERSION') else 'no definido'}",
        f"PREFIX={termux_prefix}",
        f"PATH={configured_path}",
        f"termux-open-url_en_PATH={shutil.which('termux-open-url') or 'no encontrado'}",
        f"termux-open-url_en_PREFIX={str(termux_binary) if termux_binary and termux_binary.is_file() else 'no encontrado'}",
        f"xdg-open={shutil.which('xdg-open') or 'no encontrado'}",
        f"gio={shutil.which('gio') or 'no encontrado'}",
        "intentos=" + ("; ".join(attempts) if attempts else "ninguno"),
    ]
    return "\n  ".join(lines)


def open_browser(url: str) -> bool:
    """
    Abre la URL en el navegador predeterminado del usuario respetando el entorno del sistema.
    En Termux usa termux-open-url para delegar la apertura en Android. En el resto de
    Linux prioriza xdg-open o gio para respetar el gestor de ventanas y mimeapps.list,
    desacoplando el proceso hijo para evitar ruidos en la terminal.
    """
    attempts = []
    if is_termux_environment():
        termux_open_url = get_termux_open_url_executable()
        if not termux_open_url:
            raise FileNotFoundError(
                "Termux fue detectado, pero no se encontró termux-open-url.\n  "
                + browser_launch_diagnostics(["termux-open-url: no localizado"])
            )
        try:
            subprocess.Popen(
                [termux_open_url, url],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
            return True
        except OSError as error:
            raise RuntimeError(
                f"termux-open-url no pudo iniciarse: {type(error).__name__}: {error}\n  "
                + browser_launch_diagnostics(["termux-open-url: error al iniciar"])
            ) from error
    elif sys.platform.startswith("linux"):
        for cmd in ("xdg-open", "gio"):
            if shutil.which(cmd):
                try:
                    args = ["gio", "open", url] if cmd == "gio" else ["xdg-open", url]
                    subprocess.Popen(
                        args,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        start_new_session=True,
                    )
                    return True
                except OSError as error:
                    attempts.append(f"{cmd}: {type(error).__name__}: {error}")
            else:
                attempts.append(f"{cmd}: no encontrado")
    elif sys.platform == "darwin":
        if shutil.which("open"):
            try:
                subprocess.Popen(
                    ["open", url],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    start_new_session=True,
                )
                return True
            except OSError as error:
                attempts.append(f"open: {type(error).__name__}: {error}")
    elif sys.platform == "win32":
        try:
            os.startfile(url)
            return True
        except OSError as error:
            attempts.append(f"os.startfile: {type(error).__name__}: {error}")

    try:
        if webbrowser.open(url):
            return True
    except Exception as error:
        attempts.append(f"webbrowser: {type(error).__name__}: {error}")
        raise RuntimeError(
            "El navegador predeterminado rechazó la URL de ZeroChat.\n  "
            + browser_launch_diagnostics(attempts)
        ) from error
    attempts.append("webbrowser: devolvió False")
    raise RuntimeError(
        "Ningún lanzador de navegador aceptó la URL de ZeroChat.\n  "
        + browser_launch_diagnostics(attempts)
    )


def launch_browser(url: str) -> bool:
    """Abre el navegador en la URL de la sesión y muestra información o diagnóstico en consola."""
    termux_detected = is_termux_environment()
    if termux_detected:
        log_event("Termux detectado; se abrirá mediante termux-open-url.")
    log_event("Abriendo navegador en la interfaz configurada...")
    try:
        if not open_browser(url):
            raise RuntimeError("El lanzador de navegador devolvió un resultado sin éxito.")
        return True
    except Exception as e:
        log_event(f"No se pudo abrir el navegador automáticamente: {e}")
        console_log("  Traza de diagnóstico:", flush=True)
        traceback.print_exc()
        manual_command = get_manual_browser_command(url)
        if manual_command:
            console_log("  Termux detectado. Prueba este comando exacto:", flush=True)
            console_log(f"  {manual_command}", flush=True)
        return False





def default_browser_executable() -> str | None:
    """Ejecutable del navegador predeterminado en Linux (xdg-settings y su fichero .desktop), o None."""
    if not sys.platform.startswith("linux") or is_termux_environment() or not shutil.which("xdg-settings"):
        return None
    try:
        desktop = subprocess.run(["xdg-settings", "get", "default-web-browser"], capture_output=True, text=True, timeout=5).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None
    if not desktop.endswith(".desktop") or "/" in desktop:
        return None
    data_dirs = [os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")]
    data_dirs += (os.environ.get("XDG_DATA_DIRS") or "/usr/local/share:/usr/share").split(":")
    for data_dir in data_dirs:
        entry = Path(data_dir) / "applications" / desktop
        if not entry.is_file():
            continue
        try:
            lines = entry.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            return None
        exec_line = next((line[5:] for line in lines if line.startswith("Exec=")), "")
        try:
            tokens = [token for token in shlex.split(exec_line) if token != "env" and "=" not in token]
        except ValueError:
            return None
        # Flatpak o Snap envuelven el navegador: no admiten sus opciones directamente.
        if not tokens or Path(tokens[0]).name in ("flatpak", "snap"):
            return None
        return shutil.which(tokens[0])
    return None


def launch_headless_browser(url: str) -> subprocess.Popen | None:
    """
    Abre la URL en el navegador predeterminado con --headless y el perfil normal del usuario.
    Si el navegador ya está abierto, este suele recibir la URL como una pestaña visible.
    Devuelve el proceso lanzado, o None si no se pudo y hay que abrirlo de la forma normal.
    """
    executable = default_browser_executable()
    if not executable:
        log_event("No se pudo identificar el navegador predeterminado para abrirlo sin ventana; se abrirá de la forma normal.")
        return None
    log_event(f"Abriendo {Path(executable).name} sin ventana en la interfaz configurada...")
    try:
        return subprocess.Popen(
            [executable, "--headless", url],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except OSError as error:
        log_event(f"No se pudo abrir {executable} sin ventana ({error}); se abrirá de la forma normal.")
        return None
