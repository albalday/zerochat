# Persistencia local de zerochat.py con SQLite embebido para perfiles de conexión generales y conversaciones.
_STORAGE_LOCK = threading.RLock()
_INITIALIZED_DB: Path | None = None
READONLY_PROFILE_ID = "profile:mirror"
MIRROR_PROFILE_NAME = "Espejo"
MAX_PROFILE_NAME_LENGTH = 128
MAX_PROFILE_DESCRIPTION_LENGTH = 2048
MAX_CONVERSATION_ID_LENGTH = 128
MAX_CONVERSATION_TITLE_LENGTH = 256
MAX_BLOB_SIZE = 50 * 1024 * 1024
MAX_BLOB_HTTP_BYTES = 72 * 1024 * 1024

STORAGE_MIGRATIONS = [
    (1, "001_create_profiles_table", """
        CREATE TABLE IF NOT EXISTS profiles (
            id TEXT PRIMARY KEY,
            name TEXT UNIQUE NOT NULL,
            description TEXT DEFAULT '',
            settings_json TEXT NOT NULL,
            api_key TEXT DEFAULT '',
            version INTEGER DEFAULT 1,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_profiles_name ON profiles(name);
        CREATE INDEX IF NOT EXISTS idx_profiles_updated_at ON profiles(updated_at);
    """),
    (2, "002_create_conversations_tables", """
        CREATE TABLE IF NOT EXISTS conversations (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            message_count INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at);

        CREATE TABLE IF NOT EXISTS messages (
            conversation_id TEXT NOT NULL,
            position INTEGER NOT NULL,
            id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            extra_json TEXT DEFAULT '{}',
            FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
            PRIMARY KEY (conversation_id, position)
        );
    """),
    (3, "003_create_blobs_table", """
        CREATE TABLE IF NOT EXISTS blobs (
            id TEXT PRIMARY KEY,
            mime_type TEXT NOT NULL,
            size INTEGER NOT NULL,
            data BLOB NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_blobs_created_at ON blobs(created_at);
    """),
    (4, "004_add_extra_json_to_conversations", """
        ALTER TABLE conversations ADD COLUMN extra_json TEXT DEFAULT '{}';
    """)
]


def get_storage_dir() -> Path:
    """Directorio persistente con permisos 0700 para la base de datos local de ZeroChat."""
    storage_dir = get_data_dir() / "storage"
    storage_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    if os.name != "nt":
        storage_dir.chmod(0o700)
    return storage_dir


def get_storage_db_path() -> Path:
    """Ruta al archivo SQLite principal de ZeroChat."""
    return get_storage_dir() / "zerochat.db"


def _secure_db_files(db_path: Path):
    """Garantiza permisos 0600 en el archivo SQLite y sus auxiliares de journaling en POSIX."""
    if os.name == "nt":
        return
    if not db_path.exists():
        fd = os.open(db_path, os.O_WRONLY | os.O_CREAT, 0o600)
        os.close(fd)
    for target in (db_path, db_path.with_name(db_path.name + "-wal"), db_path.with_name(db_path.name + "-shm")):
        if target.exists():
            target.chmod(0o600)


def _apply_migrations(conn: sqlite3.Connection):
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
    conn.commit()


@contextlib.contextmanager
def open_storage():
    """Abre una conexión SQLite segura con migraciones aplicadas y la cierra al salir."""
    global _INITIALIZED_DB
    with _STORAGE_LOCK:
        db_path = get_storage_db_path()
        needs_init = _INITIALIZED_DB != db_path or not db_path.exists()
        _secure_db_files(db_path)
        conn = sqlite3.connect(str(db_path), timeout=5.0)
        try:
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode=WAL;")
            conn.execute("PRAGMA foreign_keys=ON;")
            conn.execute("PRAGMA busy_timeout=5000;")
            _secure_db_files(db_path)
            if needs_init:
                _apply_migrations(conn)
                _INITIALIZED_DB = db_path
            yield conn
        finally:
            conn.close()


def normalize_profile_id(name: str, given_id: str | None = None) -> str:
    """Genera o normaliza un identificador único para el perfil general."""
    if given_id and isinstance(given_id, str) and given_id.strip():
        clean = given_id.strip()
        return clean if clean.startswith("profile:") else f"profile:{clean}"
    clean_name = urllib.parse.quote(name.strip())
    return f"profile:general-{clean_name}"


def validate_profile_payload(record: dict) -> tuple[str, str, str, dict, str | None]:
    """Valida los campos obligatorios del perfil y separa ajustes de la clave secreta."""
    if not isinstance(record, dict):
        raise ValueError("El perfil debe ser un objeto")
    name = str(record.get("name") or "").strip()
    if not name:
        raise ValueError("El nombre del perfil no puede estar vacío")
    if len(name) > MAX_PROFILE_NAME_LENGTH:
        raise ValueError(f"El nombre del perfil no puede superar {MAX_PROFILE_NAME_LENGTH} caracteres")

    description = str(record.get("description") or "").strip()
    if len(description) > MAX_PROFILE_DESCRIPTION_LENGTH:
        raise ValueError(f"La descripción no puede superar {MAX_PROFILE_DESCRIPTION_LENGTH} caracteres")

    profile_id = normalize_profile_id(name, record.get("id"))
    if profile_id == READONLY_PROFILE_ID or name.lower() == MIRROR_PROFILE_NAME.lower():
        raise ValueError("El perfil Espejo no se puede modificar")

    settings_source = record.get("settings")
    if not isinstance(settings_source, dict):
        raise ValueError("Los ajustes del perfil deben ser un objeto")

    settings = dict(settings_source)
    has_api_key = "apiKey" in settings or "apiKey" in record
    raw_key = settings.pop("apiKey", None)
    if raw_key is None:
        raw_key = record.get("apiKey")
    api_key = str(raw_key or "").strip() if has_api_key else None
    return profile_id, name, description, settings, api_key


def _row_to_profile(row: sqlite3.Row) -> dict:
    """Transforma una fila SQLite en el objeto de perfil del servidor."""
    try:
        settings = json.loads(row["settings_json"])
    except (json.JSONDecodeError, TypeError):
        settings = {}

    settings["apiKey"] = row["api_key"] or ""
    return {
        "id": row["id"],
        "name": row["name"],
        "description": row["description"] or "",
        "general": True,
        "schemaVersion": 1,
        "version": row["version"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "settings": settings
    }


def list_general_profiles() -> list[dict]:
    """Lista todos los perfiles de conexión del servidor almacenados en SQLite."""
    with open_storage() as conn:
        rows = conn.execute("SELECT * FROM profiles ORDER BY name COLLATE NOCASE ASC;").fetchall()
        return [_row_to_profile(row) for row in rows]


def get_general_profile(profile_id: str) -> dict | None:
    """Recupera un perfil de servidor por su identificador único."""
    if not profile_id or not isinstance(profile_id, str) or not profile_id.strip():
        return None
    clean_id = normalize_profile_id("", profile_id)
    with open_storage() as conn:
        row = conn.execute("SELECT * FROM profiles WHERE id = ?;", (clean_id,)).fetchone()
        return _row_to_profile(row) if row else None


def get_general_profile_by_name(name: str) -> dict | None:
    """Recupera un perfil de servidor por su nombre."""
    if not name or not isinstance(name, str) or not name.strip():
        return None
    clean = name.strip()
    stripped = clean[2:].strip() if clean[:2].upper() == "Z-" else clean
    candidates = list(dict.fromkeys([clean, stripped, f"Z-{stripped}", f"Z- {stripped}"]))
    with open_storage() as conn:
        for candidate in candidates:
            row = conn.execute("SELECT * FROM profiles WHERE name = ? COLLATE NOCASE;", (candidate,)).fetchone()
            if row:
                return _row_to_profile(row)
        return None


def save_general_profile(record: dict) -> dict:
    """Guarda (crea o actualiza) un perfil de conexión del servidor en SQLite."""
    profile_id, name, description, settings, api_key = validate_profile_payload(record)
    now = int(time.time() * 1000)

    with open_storage() as conn:
        existing = conn.execute("SELECT * FROM profiles WHERE id = ?;", (profile_id,)).fetchone()
        if existing:
            try:
                existing_settings = json.loads(existing["settings_json"])
            except (json.JSONDecodeError, TypeError):
                existing_settings = {}
            if existing_settings.get("apiKeyLocked") is True:
                raise ValueError("Los cambios en este perfil están bloqueados")

        same_name = conn.execute(
            "SELECT id FROM profiles WHERE name = ? COLLATE NOCASE AND id != ?;",
            (name, profile_id)
        ).fetchone()
        if same_name:
            raise ValueError(f"Ya existe un perfil con el nombre '{name}' en el servidor")

        if existing:
            version = existing["version"] + 1
            final_api_key = (existing["api_key"] or "") if api_key is None else api_key
            conn.execute("""
                UPDATE profiles
                SET name = ?, description = ?, settings_json = ?, api_key = ?, version = ?, updated_at = ?
                WHERE id = ?;
            """, (name, description, json.dumps(settings), final_api_key, version, now, profile_id))
        else:
            conn.execute("""
                INSERT INTO profiles (id, name, description, settings_json, api_key, version, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, 1, ?, ?);
            """, (profile_id, name, description, json.dumps(settings), api_key or "", now, now))

        conn.commit()
        saved_row = conn.execute("SELECT * FROM profiles WHERE id = ?;", (profile_id,)).fetchone()
        return _row_to_profile(saved_row)


def delete_general_profile(profile_id: str) -> bool:
    """Elimina un perfil de conexión general de SQLite."""
    if not profile_id or not isinstance(profile_id, str) or not profile_id.strip():
        return False
    clean_id = normalize_profile_id("", profile_id)
    with open_storage() as conn:
        cursor = conn.execute("DELETE FROM profiles WHERE id = ?;", (clean_id,))
        conn.commit()
        return cursor.rowcount > 0


# ==============================================================================
# Almacén de conversaciones y mensajes (M46)
# ==============================================================================

def _validate_conversation_id(session_id) -> str:
    if not isinstance(session_id, str) or not session_id.strip():
        raise ValueError("El identificador de la conversación no puede estar vacío")
    clean = session_id.strip()
    if len(clean) > MAX_CONVERSATION_ID_LENGTH:
        raise ValueError(f"El identificador no puede superar {MAX_CONVERSATION_ID_LENGTH} caracteres")
    return clean


def _validate_conversation_title(title, allow_empty: bool = False) -> str:
    if not isinstance(title, str):
        raise ValueError("El título de la conversación debe ser un texto")
    clean = title.strip()
    if not allow_empty and not clean:
        raise ValueError("El título de la conversación no puede estar vacío")
    if len(clean) > MAX_CONVERSATION_TITLE_LENGTH:
        raise ValueError(f"El título no puede superar {MAX_CONVERSATION_TITLE_LENGTH} caracteres")
    return clean


def _row_to_conversation_header(row: sqlite3.Row) -> dict:
    """Transforma una fila SQLite en la cabecera de una conversación."""
    header = {
        "id": row["id"],
        "title": row["title"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "messageCount": row["message_count"]
    }
    raw_extra = row["extra_json"]
    extra = json.loads(raw_extra) if raw_extra else {}
    if extra:
        header["extra"] = extra
        if "profile_id" in extra:
            header["profileId"] = extra["profile_id"]
        if "server_run" in extra:
            header["serverRun"] = bool(extra["server_run"])
    return header


def _row_to_message(row: sqlite3.Row) -> dict:
    """Transforma una fila SQLite en el objeto de mensaje de la conversación."""
    extra = json.loads(row["extra_json"]) if row["extra_json"] else {}
    return {
        "id": row["id"],
        "role": row["role"],
        "content": row["content"],
        **extra
    }


def list_conversations() -> list[dict]:
    """Lista las cabeceras de conversaciones ordenadas de más reciente a más antigua."""
    with open_storage() as conn:
        rows = conn.execute("SELECT * FROM conversations ORDER BY updated_at DESC;").fetchall()
        return [_row_to_conversation_header(row) for row in rows]


def get_conversation(session_id: str) -> dict | None:
    """Recupera una conversación completa con sus mensajes ordenados por posición."""
    clean_id = _validate_conversation_id(session_id)
    with open_storage() as conn:
        conv_row = conn.execute("SELECT * FROM conversations WHERE id = ?;", (clean_id,)).fetchone()
        if not conv_row:
            return None
        header = _row_to_conversation_header(conv_row)
        msg_rows = conn.execute(
            "SELECT * FROM messages WHERE conversation_id = ? ORDER BY position ASC;",
            (clean_id,)
        ).fetchall()
        return {**header, "history": [_row_to_message(row) for row in msg_rows]}


def save_conversation(session_meta: dict, messages: list[dict] | None = None) -> dict:
    """Guarda o actualiza una conversación y sustituye sus mensajes atómicamente."""
    if not isinstance(session_meta, dict):
        raise ValueError("Los metadatos de la conversación deben ser un objeto")
    if messages is None:
        messages = []
    if not isinstance(messages, list):
        raise ValueError("Los mensajes de la conversación deben ser una lista")

    session_id = _validate_conversation_id(session_meta.get("id"))
    raw_title = session_meta.get("title")
    title = _validate_conversation_title("" if raw_title is None else raw_title, allow_empty=True)

    now = int(time.time() * 1000)
    created_at = int(session_meta.get("createdAt") or now)
    updated_at = int(session_meta.get("updatedAt") or now)

    extra = session_meta.get("extra")
    if not isinstance(extra, dict):
        extra = {}
    else:
        extra = dict(extra)
    profile_id = session_meta.get("profileId")
    if profile_id and isinstance(profile_id, str) and profile_id.strip():
        extra["profile_id"] = profile_id.strip()
    if session_meta.get("serverRun") is not None:
        extra["server_run"] = bool(session_meta.get("serverRun"))

    extra_json = json.dumps(extra, ensure_ascii=False) if extra else "{}"

    with open_storage() as conn:
        conn.execute("""
            INSERT INTO conversations (id, title, created_at, updated_at, message_count, extra_json)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                title = excluded.title,
                updated_at = excluded.updated_at,
                message_count = excluded.message_count,
                extra_json = excluded.extra_json;
        """, (session_id, title, created_at, updated_at, len(messages), extra_json))

        conn.execute("DELETE FROM messages WHERE conversation_id = ?;", (session_id,))

        for pos, msg in enumerate(messages):
            if not isinstance(msg, dict):
                raise ValueError("Cada mensaje debe ser un objeto")
            msg_id = str(msg.get("id") or "").strip() or f"msg_{session_id}_{pos}"
            role = str(msg.get("role") or "user").strip()
            content = "" if msg.get("content") is None else str(msg.get("content"))
            extra = {k: v for k, v in msg.items() if k not in ("id", "role", "content", "conversationId", "position")}
            extra_json = json.dumps(extra) if extra else "{}"

            conn.execute("""
                INSERT INTO messages (conversation_id, position, id, role, content, extra_json)
                VALUES (?, ?, ?, ?, ?, ?);
            """, (session_id, pos, msg_id, role, content, extra_json))

        conn.commit()
        row = conn.execute("SELECT * FROM conversations WHERE id = ?;", (session_id,)).fetchone()
        return _row_to_conversation_header(row)


def rename_conversation(session_id: str, new_title: str) -> bool:
    """Renombra una conversación existente en SQLite."""
    clean_id = _validate_conversation_id(session_id)
    title = _validate_conversation_title(new_title)
    now = int(time.time() * 1000)
    with open_storage() as conn:
        cursor = conn.execute(
            "UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?;",
            (title, now, clean_id)
        )
        conn.commit()
        return cursor.rowcount > 0


def delete_conversation(session_id: str) -> bool:
    """Elimina una conversación y sus mensajes en cascada."""
    clean_id = _validate_conversation_id(session_id)
    with open_storage() as conn:
        cursor = conn.execute("DELETE FROM conversations WHERE id = ?;", (clean_id,))
        conn.commit()
        return cursor.rowcount > 0


def delete_all_conversations() -> int:
    """Elimina todas las conversaciones y sus mensajes en cascada."""
    with open_storage() as conn:
        cursor = conn.execute("DELETE FROM conversations;")
        conn.commit()
        return cursor.rowcount


def _validate_blob_id(blob_id: str) -> str:
    """Valida que el identificador del blob sea un hash SHA-256 en hexadecimal (64 caracteres)."""
    if not isinstance(blob_id, str) or not re.match(r"^[0-9a-f]{64}$", blob_id.strip().lower()):
        raise ValueError(f"ID de blob inválido (debe ser un hash SHA-256 hexadecimal de 64 caracteres): {blob_id}")
    return blob_id.strip().lower()


def put_blob(data_bytes: bytes, mime_type: str = "application/octet-stream", blob_id: str | None = None) -> dict:
    """Almacena un blob binario indexado por su hash SHA-256."""
    if not isinstance(data_bytes, (bytes, bytearray)):
        raise ValueError("Los datos del blob deben ser bytes")
    if len(data_bytes) == 0:
        raise ValueError("El blob no puede estar vacío")
    if len(data_bytes) > MAX_BLOB_SIZE:
        raise ValueError(f"El tamaño del blob ({len(data_bytes)} bytes) excede el máximo permitido ({MAX_BLOB_SIZE} bytes)")

    calc_id = hashlib.sha256(data_bytes).hexdigest()
    if blob_id is not None:
        clean_id = _validate_blob_id(blob_id)
        if clean_id != calc_id:
            raise ValueError(f"El ID del blob ({clean_id}) no coincide con el hash SHA-256 de los datos ({calc_id})")
    else:
        clean_id = calc_id

    mime = (mime_type or "application/octet-stream").strip()
    now = int(time.time() * 1000)
    with open_storage() as conn:
        conn.execute("""
            INSERT INTO blobs (id, mime_type, size, data, created_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                mime_type = excluded.mime_type,
                size = excluded.size,
                data = excluded.data;
        """, (clean_id, mime, len(data_bytes), sqlite3.Binary(data_bytes), now))
        conn.commit()
    return {"id": clean_id, "mime_type": mime, "size": len(data_bytes), "created_at": now}


def get_blob(blob_id: str) -> dict | None:
    """Recupera un blob por su hash SHA-256."""
    clean_id = _validate_blob_id(blob_id)
    with open_storage() as conn:
        row = conn.execute("SELECT id, mime_type, size, data, created_at FROM blobs WHERE id = ?;", (clean_id,)).fetchone()
        if not row:
            return None
        return {
            "id": row["id"],
            "mime_type": row["mime_type"],
            "size": row["size"],
            "data": bytes(row["data"]),
            "created_at": row["created_at"],
        }


def has_blobs(blob_ids: list[str]) -> dict:
    """Comprueba la existencia de una lista de IDs de blobs, devolviendo los existentes y los faltantes."""
    if not isinstance(blob_ids, list):
        raise ValueError("La lista de IDs de blobs debe ser una lista")
    if len(blob_ids) > 1000:
        raise ValueError("No se pueden consultar más de 1000 IDs de blobs a la vez")
    clean_ids = [_validate_blob_id(bid) for bid in blob_ids]
    if not clean_ids:
        return {"existing": [], "missing": []}
    unique_ids = list(dict.fromkeys(clean_ids))
    with open_storage() as conn:
        placeholders = ",".join("?" for _ in unique_ids)
        rows = conn.execute(f"SELECT id FROM blobs WHERE id IN ({placeholders});", unique_ids).fetchall()
        existing_set = {row["id"] for row in rows}
        return {
            "existing": [bid for bid in unique_ids if bid in existing_set],
            "missing": [bid for bid in unique_ids if bid not in existing_set],
        }

