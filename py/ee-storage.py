# Persistencia local de zerochat.py con SQLite embebido para perfiles de conexión generales
# y futuras estructuras (conversaciones, mensajes, adjuntos).
_STORAGE_LOCK = threading.RLock()
_PROFILES_REVISION: int = 1

STORAGE_MIGRATIONS = [
    (1, "001_create_profiles_table", """
        CREATE TABLE IF NOT EXISTS profiles (
            id TEXT PRIMARY KEY,
            name TEXT UNIQUE NOT NULL,
            description TEXT DEFAULT '',
            is_general INTEGER DEFAULT 1,
            settings_json TEXT NOT NULL,
            api_key TEXT DEFAULT '',
            version INTEGER DEFAULT 1,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_profiles_name ON profiles(name);
        CREATE INDEX IF NOT EXISTS idx_profiles_updated_at ON profiles(updated_at);
    """)
]


def get_storage_dir() -> Path:
    """Directorio persistente con permisos 0700 para la base de datos local de ZeroChat."""
    storage_dir = get_data_dir() / "storage"
    storage_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    if os.name != "nt":
        try:
            storage_dir.chmod(0o700)
        except OSError:
            pass
    return storage_dir


def get_storage_db_path() -> Path:
    """Ruta al archivo SQLite principal de ZeroChat."""
    return get_storage_dir() / "zerochat.db"


def _secure_db_files(db_path: Path):
    """Garantiza permisos 0600 en el archivo SQLite y sus auxiliares de journaling en POSIX."""
    if os.name == "nt":
        return
    for target in (db_path, db_path.with_name(db_path.name + "-wal"), db_path.with_name(db_path.name + "-shm")):
        if target.exists():
            try:
                target.chmod(0o600)
            except OSError:
                pass


def get_profiles_revision() -> int:
    """Contador de versión para que el latido informe al cliente de cambios en los perfiles."""
    with _STORAGE_LOCK:
        return _PROFILES_REVISION


def bump_profiles_revision() -> int:
    """Incrementa la revisión tras una escritura o borrado de perfil general."""
    global _PROFILES_REVISION
    with _STORAGE_LOCK:
        _PROFILES_REVISION += 1
        return _PROFILES_REVISION


def connect_storage(db_path: Path | None = None) -> sqlite3.Connection:
    """Abre y configura una conexión segura con WAL y soporte para claves foráneas."""
    path = db_path or get_storage_db_path()
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if os.name != "nt":
        try:
            path.parent.chmod(0o700)
        except OSError:
            pass
    conn = sqlite3.connect(str(path), timeout=10.0)
    conn.row_factory = sqlite3.Row
    _secure_db_files(path)
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA foreign_keys=ON;")
    conn.execute("PRAGMA busy_timeout=5000;")
    _secure_db_files(path)
    return conn


def init_storage(db_path: Path | None = None):
    """Ejecuta migraciones pendientes de forma atómica y segura."""
    with _STORAGE_LOCK:
        with connect_storage(db_path) as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS schema_migrations (
                    version INTEGER PRIMARY KEY,
                    applied_at INTEGER NOT NULL,
                    description TEXT NOT NULL
                );
            """)
            applied = {row["version"] for row in conn.execute("SELECT version FROM schema_migrations;").fetchall()}
            for version, description, sql in STORAGE_MIGRATIONS:
                if version not in applied:
                    conn.executescript(sql)
                    conn.execute(
                        "INSERT INTO schema_migrations (version, applied_at, description) VALUES (?, ?, ?);",
                        (version, int(time.time() * 1000), description)
                    )


def normalize_profile_id(name: str, given_id: str | None = None) -> str:
    """Genera o normaliza un identificador único para el perfil general."""
    if given_id and isinstance(given_id, str) and given_id.strip():
        clean = given_id.strip()
        if not clean.startswith("profile:"):
            return f"profile:{clean}"
        return clean
    clean_name = urllib.parse.quote(name.strip())
    return f"profile:{clean_name}"


def validate_profile_payload(record: dict) -> tuple[str, str, str, dict, str]:
    """Valida los campos obligatorios del perfil y separa ajustes de la clave secreta."""
    if not isinstance(record, dict):
        raise ValueError("El perfil debe ser un objeto")
    name = str(record.get("name") or "").strip()
    if not name:
        raise ValueError("El nombre del perfil no puede estar vacío")
    if len(name) > 128:
        raise ValueError("El nombre del perfil no puede superar 128 caracteres")

    description = str(record.get("description") or "").strip()
    if len(description) > 2048:
        raise ValueError("La descripción no puede superar 2048 caracteres")

    settings_source = record.get("settings")
    if settings_source is None and isinstance(record, dict):
        settings_source = record
    if not isinstance(settings_source, dict):
        raise ValueError("Los ajustes del perfil deben ser un objeto")

    settings = dict(settings_source)
    # Extraemos api_key: puede venir en settings o en la raíz del record
    api_key = str(settings.pop("apiKey", None) or record.get("apiKey") or "").strip()
    profile_id = normalize_profile_id(name, record.get("id"))
    return profile_id, name, description, settings, api_key


def _row_to_profile(row: sqlite3.Row, include_secrets: bool = False) -> dict:
    """Transforma una fila SQLite en el objeto de perfil consumible por el frontend y backend."""
    try:
        settings = json.loads(row["settings_json"])
    except (json.JSONDecodeError, TypeError):
        settings = {}

    api_key = row["api_key"] or ""
    if include_secrets:
        settings["apiKey"] = api_key
    else:
        settings["apiKey"] = None
        settings["hasApiKey"] = bool(api_key)

    return {
        "id": row["id"],
        "name": row["name"],
        "description": row["description"] or "",
        "general": True,
        "isGeneral": True,
        "schemaVersion": 1,
        "version": row["version"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "settings": settings
    }


def list_general_profiles(include_secrets: bool = False, db_path: Path | None = None) -> list[dict]:
    """Lista todos los perfiles de conexión generales almacenados en SQLite."""
    init_storage(db_path)
    with _STORAGE_LOCK:
        with connect_storage(db_path) as conn:
            rows = conn.execute("SELECT * FROM profiles ORDER BY name COLLATE NOCASE ASC;").fetchall()
            return [_row_to_profile(row, include_secrets=include_secrets) for row in rows]


def get_general_profile(profile_id: str, include_secrets: bool = True, db_path: Path | None = None) -> dict | None:
    """Recupera un perfil general por su identificador único."""
    if not profile_id or not isinstance(profile_id, str):
        return None
    init_storage(db_path)
    with _STORAGE_LOCK:
        with connect_storage(db_path) as conn:
            row = conn.execute("SELECT * FROM profiles WHERE id = ?;", (profile_id.strip(),)).fetchone()
            if not row:
                # Intento con prefijo si faltaba
                row = conn.execute("SELECT * FROM profiles WHERE id = ?;", (f"profile:{profile_id.strip()}",)).fetchone()
            return _row_to_profile(row, include_secrets=include_secrets) if row else None


def get_general_profile_by_name(name: str, include_secrets: bool = True, db_path: Path | None = None) -> dict | None:
    """Recupera un perfil general por su nombre, tolerando o omitiendo prefijos 'Z-' o 'Z- '."""
    if not name or not isinstance(name, str):
        return None
    init_storage(db_path)
    clean = name.strip()
    candidates = [clean]
    if clean.startswith("Z- "):
        candidates.append(clean[3:].strip())
    elif clean.startswith("Z-"):
        candidates.append(clean[2:].strip())
    else:
        candidates.append(f"Z- {clean}")
        candidates.append(f"Z-{clean}")

    with _STORAGE_LOCK:
        with connect_storage(db_path) as conn:
            for candidate in candidates:
                row = conn.execute("SELECT * FROM profiles WHERE name = ? COLLATE NOCASE;", (candidate,)).fetchone()
                if row:
                    return _row_to_profile(row, include_secrets=include_secrets)
            return None


def save_general_profile(record: dict, db_path: Path | None = None) -> dict:
    """Guarda (crea o actualiza) un perfil de conexión general en SQLite."""
    init_storage(db_path)
    profile_id, name, description, settings, api_key = validate_profile_payload(record)
    now = int(time.time() * 1000)

    with _STORAGE_LOCK:
        with connect_storage(db_path) as conn:
            existing = conn.execute("SELECT * FROM profiles WHERE id = ?;", (profile_id,)).fetchone()
            same_name = conn.execute("SELECT * FROM profiles WHERE name = ? COLLATE NOCASE AND id != ?;", (name, profile_id)).fetchone()
            if same_name:
                raise ValueError(f"Ya existe un perfil con el nombre '{name}'")

            if existing:
                version = existing["version"] + 1
                # Si no se pasó una nueva api_key y la existente tenía una, se conserva
                final_api_key = api_key if api_key or "apiKey" in record.get("settings", {}) else (existing["api_key"] or "")
                conn.execute("""
                    UPDATE profiles
                    SET name = ?, description = ?, settings_json = ?, api_key = ?, version = ?, updated_at = ?
                    WHERE id = ?;
                """, (name, description, json.dumps(settings), final_api_key, version, now, profile_id))
            else:
                version = 1
                conn.execute("""
                    INSERT INTO profiles (id, name, description, is_general, settings_json, api_key, version, created_at, updated_at)
                    VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?);
                """, (profile_id, name, description, json.dumps(settings), api_key, version, now, now))

            conn.commit()
            bump_profiles_revision()
            saved_row = conn.execute("SELECT * FROM profiles WHERE id = ?;", (profile_id,)).fetchone()
            return _row_to_profile(saved_row, include_secrets=True)


def delete_general_profile(profile_id: str, db_path: Path | None = None) -> bool:
    """Elimina un perfil de conexión general de SQLite."""
    if not profile_id or not isinstance(profile_id, str):
        return False
    init_storage(db_path)
    clean_id = profile_id.strip()
    with _STORAGE_LOCK:
        with connect_storage(db_path) as conn:
            cursor = conn.execute("DELETE FROM profiles WHERE id = ? OR id = ?;", (clean_id, f"profile:{clean_id}"))
            conn.commit()
            if cursor.rowcount > 0:
                bump_profiles_revision()
                return True
            return False
