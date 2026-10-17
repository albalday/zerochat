# ==============================================================================
# Perfil de Firefox para el modo ejecución (zerochat.py --prompt)
# ==============================================================================
# Todo lo que depende del navegador y del sistema vive aquí, detrás de tres funciones:
# locate_firefox_profile, create_firefox_run_profile y firefox_launch_command.

class RunSetupError(Exception):
    """Fallo al preparar la ejecución desatendida (código de salida 3)."""


FIREFOX_PROFILE_ROOTS = (Path(".mozilla") / "firefox", Path(".config") / "mozilla" / "firefox")
# Ficheros auxiliares de SQLite: la copia se hace con la API de backup, que ya los incorpora.
SQLITE_SIDECAR_SUFFIXES = ("-wal", "-shm", "-journal")
# La copia es desechable: sin páginas de bienvenida, avisos de navegador predeterminado ni
# restauración de sesión tras matar el proceso; window.close() cierra la pestaña aunque tenga historial.
FIREFOX_RUN_PREFS = {
    "browser.shell.checkDefaultBrowser": False,
    "browser.aboutwelcome.enabled": False,
    "browser.startup.homepage_override.mstone": "ignore",
    "startup.homepage_welcome_url": "",
    "startup.homepage_welcome_url.additional": "",
    "datareporting.policy.dataSubmissionPolicyBypassNotification": True,
    "toolkit.telemetry.reportingpolicy.firstRun": False,
    "browser.sessionstore.resume_from_crash": False,
    "browser.tabs.warnOnClose": False,
    "dom.allow_scripts_to_close_windows": True,
}


def ui_origin(url: str = DEFAULT_UI_URL) -> str:
    """Origen web (esquema://host[:puerto]) de la interfaz."""
    parsed = urllib.parse.urlparse(url)
    return f"{parsed.scheme}://{parsed.netloc}"


def firefox_origin_dir_name(origin: str) -> str:
    """Nombre del directorio de almacenamiento de un origen en storage/default de Firefox."""
    return origin.replace("://", "+++", 1).replace(":", "+")


def _firefox_profile_candidates(root: Path) -> list[Path]:
    """Perfiles de una raíz de Firefox por prioridad: instalaciones, perfil por defecto y el resto."""
    def resolve(path_value: str, is_relative: bool = True) -> Path:
        path = Path(path_value)
        return path if path.is_absolute() or not is_relative else root / path

    def read_ini(name: str) -> configparser.ConfigParser:
        parser = configparser.ConfigParser(interpolation=None)
        try:
            parser.read(root / name, encoding="utf-8")
        except (configparser.Error, UnicodeDecodeError) as exc:
            raise RunSetupError(f"No se pudo leer {root / name}: {exc}") from exc
        return parser

    candidates: list[Path] = []
    installs = read_ini("installs.ini")
    for section in installs.sections():
        if installs.get(section, "Default", fallback=""):
            candidates.append(resolve(installs.get(section, "Default")))
    profiles = read_ini("profiles.ini")
    for section in profiles.sections():
        if section.startswith("Install") and profiles.get(section, "Default", fallback=""):
            candidates.append(resolve(profiles.get(section, "Default")))
    entries = [profiles[section] for section in profiles.sections() if section.startswith("Profile") and profiles.get(section, "Path", fallback="")]
    for entry in sorted(entries, key=lambda item: item.get("Default", "0") != "1"):
        candidates.append(resolve(entry.get("Path"), entry.get("IsRelative", "1") == "1"))
    return list(dict.fromkeys(candidates))


def locate_firefox_profile(origin: str) -> Path:
    """Perfil activo de Firefox que guarda datos de `origin` (~/.mozilla/firefox o ~/.config/mozilla/firefox)."""
    origin_dir = firefox_origin_dir_name(origin)
    roots = [Path.home() / relative for relative in FIREFOX_PROFILE_ROOTS]
    searched = []
    for root in roots:
        if not (root / "profiles.ini").is_file():
            continue
        for profile in _firefox_profile_candidates(root):
            searched.append(str(profile))
            if (profile / "storage" / "default" / origin_dir).is_dir():
                return profile
    if not searched:
        raise RunSetupError("No se encontró ningún perfil de Firefox (profiles.ini) en " + " ni en ".join(str(root) for root in roots))
    raise RunSetupError(f"Ningún perfil de Firefox contiene datos de {origin}: abre ZeroChat una vez en Firefox. Perfiles revisados: {', '.join(searched)}")


def _copy_sqlite(source: Path, target: Path):
    """
    Copia coherente de una base SQLite en uso con la API de backup. Si Firefox la tiene bloqueada
    en modo exclusivo, copia el fichero y su WAL tal cual y los consolida en la copia.
    """
    try:
        src = sqlite3.connect(f"{source.resolve().as_uri()}?mode=ro", uri=True, timeout=2)
        try:
            # backup() reintenta sin fin mientras la base esté bloqueada: una lectura falla antes.
            src.execute("SELECT count(*) FROM sqlite_master").fetchone()
            dst = sqlite3.connect(target)
            try:
                src.backup(dst)
            finally:
                dst.close()
        finally:
            src.close()
        return
    except sqlite3.OperationalError:
        target.unlink(missing_ok=True)
    shutil.copyfile(source, target)
    wal = source.with_name(source.name + "-wal")
    if wal.is_file():
        shutil.copyfile(wal, target.with_name(target.name + "-wal"))
    conn = sqlite3.connect(target)
    try:
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    finally:
        conn.close()
    for suffix in SQLITE_SIDECAR_SUFFIXES:
        target.with_name(target.name + suffix).unlink(missing_ok=True)


def _copy_origin_storage(source: Path, target: Path):
    """Copia el almacenamiento de un origen (localStorage, IndexedDB, caché, metadatos)."""
    def fail(error: OSError):
        raise error
    for current, _dirs, files in os.walk(source, onerror=fail):
        rel = Path(current).relative_to(source)
        (target / rel).mkdir(mode=0o700, exist_ok=True)
        for name in files:
            if name.endswith(SQLITE_SIDECAR_SUFFIXES):
                continue
            src_file = Path(current) / name
            dst_file = target / rel / name
            if name.endswith(".sqlite"):
                _copy_sqlite(src_file, dst_file)
            else:
                shutil.copyfile(src_file, dst_file)


def _copy_origin_permissions(source: Path, target: Path, origin: str):
    """Copia permissions.sqlite conservando solo los permisos del origen (acceso a la red local incluido)."""
    if not source.is_file():
        return
    _copy_sqlite(source, target)
    conn = sqlite3.connect(target)
    try:
        conn.execute("DELETE FROM moz_perms WHERE origin != ?", (origin,))
        if conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'moz_hosts'").fetchone():
            conn.execute("DELETE FROM moz_hosts")
        conn.commit()
        conn.execute("VACUUM")
    finally:
        conn.close()


def _firefox_pref_line(name: str, value) -> str:
    return f"user_pref({json.dumps(name)}, {json.dumps(value)});"


def create_firefox_run_profile(profile: Path, origin: str) -> Path:
    """
    Crea un perfil temporal 0700 con solo el almacenamiento y los permisos de `origin` copiados de
    `profile`. Contiene credenciales en claro: quien lo crea debe borrarlo al terminar.
    """
    copy_dir = Path(tempfile.mkdtemp(prefix="zerochat-run-"))
    try:
        copy_dir.chmod(0o700)
        origin_dir = firefox_origin_dir_name(origin)
        storage = copy_dir / "storage" / "default"
        storage.mkdir(mode=0o700, parents=True)
        _copy_origin_storage(profile / "storage" / "default" / origin_dir, storage / origin_dir)
        _copy_origin_permissions(profile / "permissions.sqlite", copy_dir / "permissions.sqlite", origin)
        (copy_dir / "user.js").write_text("\n".join(_firefox_pref_line(name, value) for name, value in FIREFOX_RUN_PREFS.items()) + "\n", encoding="utf-8")
    except (OSError, sqlite3.Error) as exc:
        shutil.rmtree(copy_dir, ignore_errors=True)
        raise RunSetupError(f"No se pudo copiar el perfil de Firefox {profile}: {exc}") from exc
    except BaseException:
        shutil.rmtree(copy_dir, ignore_errors=True)
        raise
    return copy_dir


def firefox_launch_command(profile_copy: Path, url: str, headless: bool) -> list[str]:
    """Firefox propio (-no-remote) sobre la copia, sin tocar la instancia del usuario."""
    executable = shutil.which("firefox")
    if not executable:
        raise RunSetupError("No se encontró el ejecutable firefox en el PATH.")
    return [executable, "-no-remote", "-profile", str(profile_copy), *(["--headless"] if headless else []), url]
