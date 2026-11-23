"""Almacenamiento local en SQLite (~/zerochat/storage/zerochat.db): perfiles del servidor, conversaciones, blobs y políticas de seguridad."""

from __future__ import annotations

import contextlib
import hashlib
import json
import math
import os
import re
import sqlite3
import threading
import time
import typing
import urllib.parse
import uuid
from pathlib import Path

from core.environment import get_data_dir
from core.limits import MAX_PATH_LENGTH
from core.live_events import notify_live_change
from storage.obfuscation import OBFUSCATION_PREFIX, obfuscate_secret, reveal_secret


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
CONVERSATION_UPLOAD_TTL_SECONDS = 300
MAX_PENDING_CONVERSATION_UPLOADS = 16
MAX_STAGED_CONVERSATION_BYTES = 64 * 1024 * 1024
MAX_CONVERSATION_UPLOAD_CHUNKS = 512
_UPLOAD_ID_PATTERN = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")
_PENDING_CONVERSATION_UPLOADS: dict[str, dict] = {}


def _obfuscate_saved_api_keys(conn: sqlite3.Connection):
    """Las API keys de los perfiles del servidor, guardadas en claro hasta ahora, pasan a guardarse ofuscadas."""
    rows = conn.execute("SELECT id, api_key FROM profiles WHERE api_key != '';").fetchall()
    for row in rows:
        if not row["api_key"].startswith(OBFUSCATION_PREFIX):
            conn.execute("UPDATE profiles SET api_key = ? WHERE id = ?;", (obfuscate_secret(row["api_key"]), row["id"]))


def _strip_profile_mcp_and_browser(conn: sqlite3.Connection):
    """Retira `mcpServers` y `playwrightBrowser` de todos los perfiles: el entorno de ejecución pasa a definirse por proyecto."""
    rows = conn.execute("SELECT id, settings_json FROM profiles;").fetchall()
    for row in rows:
        try:
            settings = json.loads(row["settings_json"])
        except (json.JSONDecodeError, TypeError):
            continue
        if not isinstance(settings, dict):
            continue
        removed = any(key in settings for key in ("mcpServers", "playwrightBrowser"))
        if not removed:
            continue
        settings.pop("mcpServers", None)
        settings.pop("playwrightBrowser", None)
        conn.execute("UPDATE profiles SET settings_json = ? WHERE id = ?;", (json.dumps(settings), row["id"]))


# Cada migración es SQL o, si necesita código (ofuscar), una función que recibe la conexión.
STORAGE_MIGRATIONS: list[tuple[int, str, str | typing.Callable[[sqlite3.Connection], None]]] = [
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
    """),
    (5, "005_create_security_policies_table", """
        CREATE TABLE IF NOT EXISTS security_policies (
            id TEXT PRIMARY KEY,
            user_id TEXT,
            data_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_security_policies_user ON security_policies(user_id);
    """),
    (6, "006_create_conversation_blobs_table", """
        CREATE TABLE IF NOT EXISTS conversation_blobs (
            conversation_id TEXT NOT NULL,
            blob_id TEXT NOT NULL,
            FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
            PRIMARY KEY (conversation_id, blob_id)
        );
        CREATE INDEX IF NOT EXISTS idx_conversation_blobs_blob_id ON conversation_blobs(blob_id);
        INSERT OR IGNORE INTO conversation_blobs (conversation_id, blob_id)
        SELECT DISTINCT messages.conversation_id, TRIM(json_extract(image.value, '$.blobId'))
        FROM messages, json_each(messages.extra_json, '$.images') AS image
        WHERE json_valid(messages.extra_json)
            AND json_extract(image.value, '$.blobId') IS NOT NULL
            AND TRIM(json_extract(image.value, '$.blobId')) != '';
    """),
    (7, "007_obfuscate_profile_api_keys", _obfuscate_saved_api_keys),
    (8, "008_create_secrets_table", """
        CREATE TABLE IF NOT EXISTS secrets (
            name TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
    """),
    (9, "009_strip_profile_mcp_and_browser", _strip_profile_mcp_and_browser),
    (10, "010_create_project_environments_table", """
        CREATE TABLE IF NOT EXISTS project_environments (
            project_key TEXT PRIMARY KEY,
            config_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
    """),
    (11, "011_create_settings_and_runs_tables", """
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS runs (
            conversation_id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            pid INTEGER,
            pid_start TEXT,
            started_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            status TEXT NOT NULL,
            step_text TEXT NOT NULL DEFAULT '',
            pending_json TEXT,
            error TEXT
        );
    """),
    (12, "012_split_security_policies_by_project", """
        DELETE FROM security_policies WHERE id = 'default';
    """),
    # La fila de una ejecución sigue al terminar bien: quien la lanzó lee en ella el final, la respuesta y los avisos.
    (13, "013_add_run_outcome_columns", """
        ALTER TABLE runs ADD COLUMN finished_at INTEGER;
        ALTER TABLE runs ADD COLUMN result_text TEXT;
        ALTER TABLE runs ADD COLUMN warnings_json TEXT;
    """),
]
# Tope de un secreto guardado (una API key cabe de sobra).
MAX_SECRET_LENGTH = 4096
# Herramienta de navegación de cada proyecto (sección Navegador de Ajustes).
BROWSER_TOOLS = ("none", "browser_action", "playwright")
PROJECT_ENVIRONMENT_FIELDS = ("systemDataPrompt", "enabledTools", "mcpServers", "browser", "activeRagBranchIds")
PROJECT_ENVIRONMENT_KEYS = frozenset(PROJECT_ENVIRONMENT_FIELDS)
MAX_PROJECT_PROMPT_LENGTH = 32768
MAX_PROJECT_MCP_SERVERS = 64
MAX_PROJECT_RAG_BRANCHES = 64
MAX_PROJECT_ENABLED_TOOLS = 256
MAX_PROJECT_TOOL_ID_LENGTH = 128


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
    db_path.chmod(0o600)
    for sidecar in (db_path.with_name(db_path.name + "-wal"), db_path.with_name(db_path.name + "-shm")):
        # SQLite borra los auxiliares WAL al cerrar la última conexión de otro proceso.
        with contextlib.suppress(FileNotFoundError):
            sidecar.chmod(0o600)


def _apply_migrations(conn: sqlite3.Connection):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at INTEGER NOT NULL,
            description TEXT NOT NULL
        );
    """)
    applied = {row["version"] for row in conn.execute("SELECT version FROM schema_migrations;").fetchall()}
    for version, description, migration in STORAGE_MIGRATIONS:
        if version not in applied:
            if callable(migration):
                migration(conn)
            else:
                conn.executescript(migration)
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
    """Genera o normaliza un identificador único para el perfil."""
    if given_id and isinstance(given_id, str) and given_id.strip():
        clean = given_id.strip()
        return clean if clean.startswith("profile:") else f"profile:{clean}"
    clean_name = urllib.parse.quote(name.strip(), safe="-_.!~*'()")
    return f"profile:{clean_name}"


def _parse_optional_timestamp(value, field_name: str) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
        raise ValueError(f"{field_name} debe ser una marca de tiempo positiva")
    return int(value)


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
    settings.pop("mcpServers", None)
    settings.pop("playwrightBrowser", None)
    has_api_key = "apiKey" in settings or "apiKey" in record
    raw_key = settings.pop("apiKey", None)
    if raw_key is None:
        raw_key = record.get("apiKey")
    api_key = str(raw_key or "").strip() if has_api_key else None
    return profile_id, name, description, settings, api_key


def _row_to_profile(row: sqlite3.Row) -> dict:
    """Transforma una fila SQLite en el objeto de perfil del servidor, sin su API key: solo `hasApiKey`.
    La clave la entrega get_general_profile_with_key al runner o bajo demanda con zerochat/profiles/reveal."""
    try:
        settings = json.loads(row["settings_json"])
    except (json.JSONDecodeError, TypeError):
        settings = {}
    settings.pop("apiKey", None)
    return {
        "id": row["id"],
        "name": row["name"],
        "description": row["description"] or "",
        "general": True,
        "hasApiKey": bool(row["api_key"]),
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


def get_general_profile_with_key(profile_id: str) -> dict | None:
    """El perfil del servidor con su API key en settings.apiKey (vacía si no tiene), o None si no existe."""
    if not profile_id or not isinstance(profile_id, str) or not profile_id.strip():
        return None
    with open_storage() as conn:
        row = conn.execute("SELECT * FROM profiles WHERE id = ?;", (normalize_profile_id("", profile_id),)).fetchone()
        if not row:
            return None
        profile = _row_to_profile(row)
        profile["settings"]["apiKey"] = reveal_secret(row["api_key"] or "")
        return profile


def get_general_profile_by_name(name: str) -> dict | None:
    """Recupera un perfil de servidor por su nombre."""
    if not name or not isinstance(name, str) or not name.strip():
        return None
    with open_storage() as conn:
        row = conn.execute("SELECT * FROM profiles WHERE name = ? COLLATE NOCASE;", (name.strip(),)).fetchone()
        return _row_to_profile(row) if row else None


def save_general_profile(record: dict) -> dict:
    """Guarda (crea o actualiza) un perfil en SQLite conservando el updatedAt de origen si se indica."""
    profile_id, name, description, settings, api_key = validate_profile_payload(record)
    now = int(time.time() * 1000)
    updated_at = _parse_optional_timestamp(record.get("updatedAt"), "updatedAt") or now
    created_at = _parse_optional_timestamp(record.get("createdAt"), "createdAt") or updated_at

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
            final_api_key = (existing["api_key"] or "") if api_key is None else obfuscate_secret(api_key)
            conn.execute("""
                UPDATE profiles
                SET name = ?, description = ?, settings_json = ?, api_key = ?, version = ?, updated_at = ?
                WHERE id = ?;
            """, (name, description, json.dumps(settings), final_api_key, version, updated_at, profile_id))
        else:
            conn.execute("""
                INSERT INTO profiles (id, name, description, settings_json, api_key, version, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, 1, ?, ?);
            """, (profile_id, name, description, json.dumps(settings), obfuscate_secret(api_key or ""), created_at, updated_at))

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
    extra = json.loads(row["extra_json"]) if row["extra_json"] else {}
    if "profile_id" in extra:
        header["profileId"] = extra["profile_id"]
    if "server_run" in extra:
        header["serverRun"] = bool(extra["server_run"])
    if extra.get("project"):
        header["project"] = extra["project"]
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


def get_conversation_updated_at(session_id: str) -> int | None:
    """Fecha de la última grabación de la conversación, sin leer sus mensajes; None si no existe."""
    clean_id = _validate_conversation_id(session_id)
    with open_storage() as conn:
        row = conn.execute("SELECT updated_at FROM conversations WHERE id = ?;", (clean_id,)).fetchone()
        return int(row["updated_at"]) if row else None


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


def _extract_message_blob_ids(messages: list[dict]) -> set[str]:
    """Extrae los identificadores de blob no vacíos referenciados por las imágenes de los mensajes."""
    blob_ids: set[str] = set()
    for msg in messages:
        images = msg.get("images")
        if not isinstance(images, list):
            continue
        for image in images:
            if isinstance(image, dict):
                blob_id = image.get("blobId")
                if isinstance(blob_id, str) and blob_id.strip():
                    blob_ids.add(blob_id.strip())
    return blob_ids


def _delete_orphan_blobs(conn: sqlite3.Connection, candidates: set[str]):
    """Elimina de `blobs` los candidatos que ya no referencia ninguna conversación."""
    if not candidates:
        return
    candidate_list = list(candidates)
    still_used: set[str] = set()
    for start in range(0, len(candidate_list), 500):
        batch = candidate_list[start:start + 500]
        marks = ",".join("?" for _ in batch)
        rows = conn.execute(
            f"SELECT DISTINCT blob_id FROM conversation_blobs WHERE blob_id IN ({marks});",  # noqa: S608
            batch,
        ).fetchall()
        still_used.update(row["blob_id"] for row in rows)
    orphans = [(blob_id,) for blob_id in candidates - still_used]
    if orphans:
        conn.executemany("DELETE FROM blobs WHERE id = ?;", orphans)


def _conversation_extra(session_meta: dict) -> dict:
    """Campos de extra_json que trae la petición: el perfil, el modo servidor y el proyecto."""
    extra = {}
    profile_id = session_meta.get("profileId")
    if profile_id and isinstance(profile_id, str) and profile_id.strip():
        extra["profile_id"] = profile_id.strip()
    if session_meta.get("serverRun") is not None:
        extra["server_run"] = bool(session_meta.get("serverRun"))
    project = session_meta.get("project")
    if project is not None:
        if not isinstance(project, str) or len(project) > MAX_PATH_LENGTH:
            raise ValueError("El proyecto de la conversación debe ser una ruta")
        if project.strip():
            extra["project"] = project.strip()
    return extra


def _merge_saved_header(existing, session_meta: dict, created_at: int, title: str, extra: dict) -> tuple[int, str, dict]:
    """Completa la cabecera con la guardada: su fecha de creación y su título si la petición no los trae, y su
    extra_json debajo del nuevo. El proyecto se fija al crear la conversación y no cambia después."""
    if not session_meta.get("createdAt") and existing["created_at"]:
        created_at = int(existing["created_at"])
    if not title and existing["title"]:
        title = existing["title"]
    existing_extra = json.loads(existing["extra_json"]) if existing["extra_json"] else {}
    extra = {**existing_extra, **extra}
    if existing_extra.get("project"):
        extra["project"] = existing_extra["project"]
    return created_at, title, extra


def _replace_messages(conn: sqlite3.Connection, session_id: str, messages: list[dict]):
    conn.execute("DELETE FROM messages WHERE conversation_id = ?;", (session_id,))
    for pos, msg in enumerate(messages):
        msg_id = str(msg.get("id") or "").strip() or f"msg_{session_id}_{pos}"
        role = str(msg.get("role") or "user").strip()
        content = "" if msg.get("content") is None else str(msg.get("content"))
        extra = {k: v for k, v in msg.items() if k not in ("id", "role", "content", "conversationId", "position")}
        conn.execute("""
            INSERT INTO messages (conversation_id, position, id, role, content, extra_json)
            VALUES (?, ?, ?, ?, ?, ?);
        """, (session_id, pos, msg_id, role, content, json.dumps(extra) if extra else "{}"))


def _replace_conversation_blobs(conn: sqlite3.Connection, session_id: str, blob_ids: set[str]):
    """Sustituye los blobs que referencia la conversación y borra los que ya no referencia nadie."""
    old_blob_ids = {
        row["blob_id"]
        for row in conn.execute("SELECT blob_id FROM conversation_blobs WHERE conversation_id = ?;", (session_id,))
    }
    conn.execute("DELETE FROM conversation_blobs WHERE conversation_id = ?;", (session_id,))
    if blob_ids:
        conn.executemany(
            "INSERT OR IGNORE INTO conversation_blobs (conversation_id, blob_id) VALUES (?, ?);",
            [(session_id, blob_id) for blob_id in blob_ids],
        )
    _delete_orphan_blobs(conn, old_blob_ids - blob_ids)


def save_conversation(session_meta: dict, messages: list[dict] | None = None) -> dict:
    """Guarda o actualiza una conversación y sustituye sus mensajes atómicamente."""
    if not isinstance(session_meta, dict):
        raise ValueError("Los metadatos de la conversación deben ser un objeto")
    if messages is None:
        messages = []
    if not isinstance(messages, list):
        raise ValueError("Los mensajes de la conversación deben ser una lista")
    if not all(isinstance(msg, dict) for msg in messages):
        raise ValueError("Cada mensaje debe ser un objeto")
    new_blob_ids = _extract_message_blob_ids(messages)

    session_id = _validate_conversation_id(session_meta.get("id"))
    raw_title = session_meta.get("title")
    title = _validate_conversation_title("" if raw_title is None else raw_title, allow_empty=True)

    now = int(time.time() * 1000)
    created_at = int(session_meta.get("createdAt") or now)
    updated_at = int(session_meta.get("updatedAt") or now)
    # extra_json guarda el perfil, el modo servidor y el proyecto; la cabecera los expone como campos propios.
    extra = _conversation_extra(session_meta)

    with open_storage() as conn:
        existing = conn.execute("SELECT created_at, extra_json, title FROM conversations WHERE id = ?;", (session_id,)).fetchone()
        if existing:
            created_at, title, extra = _merge_saved_header(existing, session_meta, created_at, title, extra)
        conn.execute("""
            INSERT INTO conversations (id, title, created_at, updated_at, message_count, extra_json)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                title = excluded.title,
                updated_at = excluded.updated_at,
                message_count = excluded.message_count,
                extra_json = excluded.extra_json;
        """, (session_id, title, created_at, updated_at, len(messages), json.dumps(extra, ensure_ascii=False) if extra else "{}"))
        _replace_messages(conn, session_id, messages)
        _replace_conversation_blobs(conn, session_id, new_blob_ids)
        conn.commit()
        row = conn.execute("SELECT * FROM conversations WHERE id = ?;", (session_id,)).fetchone()
        saved = _row_to_conversation_header(row)
    notify_live_change()
    return saved


def _validate_int_in_range(value, name: str, min_value: int, max_value: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{name} debe ser un entero")
    if value < min_value or value > max_value:
        raise ValueError(f"{name} fuera de rango ({min_value}..{max_value})")
    return value


def _validate_upload_id(upload_id) -> str:
    if not isinstance(upload_id, str) or not _UPLOAD_ID_PATTERN.fullmatch(upload_id):
        raise ValueError("uploadId no válido")
    return upload_id


def _purge_expired_conversation_uploads(now: float):
    expired = [
        uid for uid, entry in _PENDING_CONVERSATION_UPLOADS.items()
        if now - entry["updated_at"] > CONVERSATION_UPLOAD_TTL_SECONDS
    ]
    for uid in expired:
        del _PENDING_CONVERSATION_UPLOADS[uid]


def _parse_chunk_payload(messages, message_part) -> tuple[int, list[dict] | None, tuple | None]:
    if messages is not None and message_part is not None:
        raise ValueError("No se puede combinar messages y messagePart")
    if messages is None and message_part is None:
        raise ValueError("Cada tramo debe incluir messages o messagePart")
    if messages is not None:
        if not isinstance(messages, list) or not all(isinstance(msg, dict) for msg in messages):
            raise ValueError("Los mensajes del tramo deben ser una lista de objetos")
        return len(json.dumps(messages, ensure_ascii=False).encode("utf-8")), messages, None
    if not isinstance(message_part, dict):
        raise ValueError("messagePart debe ser un objeto")
    total_parts = _validate_int_in_range(message_part.get("totalParts"), "totalParts", 1, MAX_CONVERSATION_UPLOAD_CHUNKS)
    part_index = _validate_int_in_range(message_part.get("partIndex"), "partIndex", 0, total_parts - 1)
    content = message_part.get("content")
    if not isinstance(content, str):
        raise ValueError("content de messagePart debe ser texto")
    msg_shell = message_part.get("message")
    if part_index == 0 and not isinstance(msg_shell, dict):
        raise ValueError("El primer fragmento debe incluir message")
    if part_index > 0 and msg_shell is not None:
        raise ValueError("Solo el primer fragmento debe incluir message")
    shell_bytes = len(json.dumps(msg_shell, ensure_ascii=False).encode("utf-8")) if part_index == 0 else 0
    return len(content.encode("utf-8")) + shell_bytes, None, (part_index, total_parts, content, msg_shell)


def _acquire_conversation_upload_entry(
    upload_id: str,
    conv_id: str,
    chunk_index: int,
    total_chunks: int,
    chunk_bytes: int,
    part_info: tuple | None,
    now: float,
) -> dict:
    staged_bytes = sum(item["bytes"] for item in _PENDING_CONVERSATION_UPLOADS.values())
    if staged_bytes + chunk_bytes > MAX_STAGED_CONVERSATION_BYTES:
        raise ValueError("Se superó el límite temporal de subida de conversaciones")
    if chunk_index == 0:
        if upload_id in _PENDING_CONVERSATION_UPLOADS:
            raise ValueError("uploadId ya existe")
        if len(_PENDING_CONVERSATION_UPLOADS) >= MAX_PENDING_CONVERSATION_UPLOADS:
            raise ValueError("Demasiadas subidas de conversación en curso")
        if part_info is not None and part_info[0] != 0:
            raise ValueError("El primer fragmento de un mensaje parcial debe tener partIndex 0")
        entry = {
            "conversation_id": conv_id,
            "total_chunks": total_chunks,
            "next_index": 0,
            "messages": [],
            "partial_message": None,
            "bytes": 0,
            "updated_at": now,
        }
        _PENDING_CONVERSATION_UPLOADS[upload_id] = entry
        return entry
    entry = _PENDING_CONVERSATION_UPLOADS.get(upload_id)
    if not entry:
        raise ValueError("Subida de conversación no encontrada o caducada")
    if entry["conversation_id"] != conv_id or entry["total_chunks"] != total_chunks:
        raise ValueError("La cabecera del tramo no coincide con la subida")
    if entry["next_index"] != chunk_index:
        raise ValueError("Tramo de conversación fuera de orden")
    return entry


def _apply_chunk_message_part(entry: dict, part_info: tuple):
    part_index, total_parts, content, msg_shell = part_info
    if part_index == 0:
        if entry["partial_message"] is not None:
            raise ValueError("Ya hay un mensaje parcial en curso")
        entry["partial_message"] = {
            "message": dict(msg_shell),
            "parts": [content],
            "next_part": 1,
            "total_parts": total_parts,
        }
    else:
        partial = entry["partial_message"]
        if not partial or partial["total_parts"] != total_parts or partial["next_part"] != part_index:
            raise ValueError("Fragmento de mensaje fuera de orden")
        partial["parts"].append(content)
        partial["next_part"] += 1
    partial = entry["partial_message"]
    if partial and partial["next_part"] == partial["total_parts"]:
        full_msg = dict(partial["message"])
        full_msg["content"] = "".join(partial["parts"])
        entry["messages"].append(full_msg)
        entry["partial_message"] = None


def save_conversation_chunk(params: dict) -> dict:
    """Almacena temporalmente un tramo de mensajes de una conversación para su guardado atómico final."""
    if not isinstance(params, dict):
        raise ValueError("Los parámetros deben ser un objeto")
    upload_id = _validate_upload_id(params.get("uploadId"))
    conv_id = _validate_conversation_id(params.get("conversationId"))
    total_chunks = _validate_int_in_range(params.get("totalChunks"), "totalChunks", 1, MAX_CONVERSATION_UPLOAD_CHUNKS)
    chunk_index = _validate_int_in_range(params.get("chunkIndex"), "chunkIndex", 0, total_chunks - 1)
    chunk_bytes, messages, part_info = _parse_chunk_payload(params.get("messages"), params.get("messagePart"))

    with _STORAGE_LOCK:
        now = time.monotonic()
        _purge_expired_conversation_uploads(now)
        entry = _acquire_conversation_upload_entry(
            upload_id, conv_id, chunk_index, total_chunks, chunk_bytes, part_info, now
        )
        if messages is not None:
            if entry["partial_message"] is not None:
                raise ValueError("Faltan fragmentos del mensaje parcial anterior")
            entry["messages"].extend(messages)
        elif part_info is not None:
            _apply_chunk_message_part(entry, part_info)
        entry["next_index"] = chunk_index + 1
        entry["bytes"] += chunk_bytes
        entry["updated_at"] = now
        return {"ok": True, "uploadId": upload_id, "receivedChunks": entry["next_index"]}


def commit_conversation_upload(session_meta: dict, upload_id: str) -> dict:
    """Consolida atómicamente en SQLite una conversación subida por tramos."""
    if not isinstance(session_meta, dict):
        raise ValueError("Los metadatos de la conversación deben ser un objeto")
    session_id = _validate_conversation_id(session_meta.get("id"))
    clean_upload_id = _validate_upload_id(upload_id)
    with _STORAGE_LOCK:
        _purge_expired_conversation_uploads(time.monotonic())
        entry = _PENDING_CONVERSATION_UPLOADS.get(clean_upload_id)
        if not entry:
            raise ValueError("Subida de conversación no encontrada o caducada")
        if entry["conversation_id"] != session_id:
            raise ValueError("La conversación no coincide con la subida")
        if entry["next_index"] != entry["total_chunks"] or entry["partial_message"] is not None:
            raise ValueError("La subida de conversación está incompleta")
        messages = _PENDING_CONVERSATION_UPLOADS.pop(clean_upload_id)["messages"]
    return save_conversation(session_meta, messages)


def mark_conversation_server_run(session_id: str, profile_name: str | None = None) -> bool:
    """Marca la conversación en SQLite como ejecutada en servidor asociándole el perfil."""
    try:
        clean_id = _validate_conversation_id(session_id)
    except (ValueError, TypeError):
        return False
    try:
        with open_storage() as conn:
            row = conn.execute("SELECT extra_json FROM conversations WHERE id = ?;", (clean_id,)).fetchone()
            if not row:
                return False
            cur_extra = json.loads(row["extra_json"]) if row["extra_json"] else {}
            cur_extra["server_run"] = True
            if profile_name:
                cur_extra["profile_id"] = str(profile_name).strip()
            conn.execute("UPDATE conversations SET extra_json = ? WHERE id = ?;", (json.dumps(cur_extra, ensure_ascii=False), clean_id))
            conn.commit()
    except (sqlite3.Error, OSError, json.JSONDecodeError):
        return False
    notify_live_change()
    return True


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
        changed = cursor.rowcount > 0
    if changed:
        notify_live_change()
    return changed


def _delete_conversations_in_transaction(conn: sqlite3.Connection, where: str, params: tuple) -> list[str]:
    """Borra, dentro de la transacción abierta de `conn`, las conversaciones que cumplen `where` y sus blobs huérfanos."""
    ids = [row["id"] for row in conn.execute(f"SELECT id FROM conversations WHERE {where};", params)]  # noqa: S608
    if ids:
        marks = ",".join("?" for _ in ids)
        candidates = {
            row["blob_id"]
            for row in conn.execute(
                f"SELECT DISTINCT blob_id FROM conversation_blobs WHERE conversation_id IN ({marks});",  # noqa: S608
                ids,
            )
        }
        conn.execute(f"DELETE FROM conversations WHERE id IN ({marks});", ids)  # noqa: S608
        _delete_orphan_blobs(conn, candidates)
    return ids


def _delete_conversations(conn: sqlite3.Connection, where: str, params: tuple) -> list[str]:
    """
    Borra en una transacción las conversaciones que cumplen `where`, con sus mensajes en cascada, y los
    blobs que solo ellas referenciaban. Solo se consideran los blobs de las conversaciones borradas: uno
    subido para una conversación que aún no se ha guardado no se toca.
    """
    conn.isolation_level = None
    conn.execute("BEGIN IMMEDIATE;")
    try:
        ids = _delete_conversations_in_transaction(conn, where, params)
        conn.execute("COMMIT;")
        if ids:
            notify_live_change()
        return ids
    except Exception:
        conn.execute("ROLLBACK;")
        raise


def delete_conversation(session_id: str) -> bool:
    """Elimina una conversación con sus mensajes y los blobs que solo ella usaba."""
    clean_id = _validate_conversation_id(session_id)
    with open_storage() as conn:
        return bool(_delete_conversations(conn, "id = ?", (clean_id,)))


def delete_project_conversations(project: str) -> list[str]:
    """Elimina las conversaciones de un proyecto (o de la carpeta general si es vacío) con sus mensajes y blobs propios."""
    if not isinstance(project, str) or (project and not project.strip()) or len(project) > MAX_PATH_LENGTH:
        raise ValueError("El proyecto de las conversaciones debe ser una ruta")
    clean_project = project.strip()
    with open_storage() as conn:
        if not clean_project:
            return _delete_conversations(
                conn,
                "json_extract(extra_json, '$.project') IS NULL OR json_extract(extra_json, '$.project') = ''",
                (),
            )
        return _delete_conversations(conn, "json_extract(extra_json, '$.project') = ?", (clean_project,))


def delete_all_conversations() -> int:
    """Elimina todas las conversaciones con sus mensajes y los blobs que estas usaban."""
    with open_storage() as conn:
        return len(_delete_conversations(conn, "1 = 1", ()))


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
        rows = conn.execute(f"SELECT id FROM blobs WHERE id IN ({placeholders});", unique_ids).fetchall()  # noqa: S608
        existing_set = {row["id"] for row in rows}
        return {
            "existing": [bid for bid in unique_ids if bid in existing_set],
            "missing": [bid for bid in unique_ids if bid not in existing_set],
        }


GLOBAL_SECURITY_POLICY_ID = "global"
PROJECT_SECURITY_POLICY_PREFIX = "project:"


def project_security_policy_id(project_key: str) -> str:
    """Clave de fila en `security_policies` para un proyecto concreto."""
    clean_key = str(project_key or "").strip()
    if not clean_key:
        raise ValueError("project_key es obligatorio")
    return f"{PROJECT_SECURITY_POLICY_PREFIX}{clean_key}"


def _parse_security_policy_row(row) -> dict | None:
    """Decodifica la fila de políticas; un JSON corrupto es un error visible, nunca un estado vacío."""
    if not row:
        return None
    try:
        data = json.loads(row["data_json"])
    except (ValueError, TypeError) as exc:
        raise RuntimeError(f"Las políticas de seguridad guardadas están corruptas: {exc}") from exc
    if not isinstance(data, dict):
        raise RuntimeError("Las políticas de seguridad guardadas no son un objeto JSON.")
    return data


def _upsert_security_policy_row(conn: sqlite3.Connection, row_id: str, data: dict, now: int) -> None:
    conn.execute("""
        INSERT INTO security_policies (id, data_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            data_json = excluded.data_json,
            updated_at = excluded.updated_at;
    """, (row_id, json.dumps(data, ensure_ascii=False), now))


def _count_other_project_patterns(conn: sqlite3.Connection, excluded_id: str) -> int:
    rows = conn.execute(
        "SELECT data_json FROM security_policies WHERE id LIKE 'project:%' AND id != ?;",
        (excluded_id,),
    ).fetchall()
    total = 0
    for row in rows:
        parsed = _parse_security_policy_row(row)
        if parsed and isinstance(parsed.get("commandPatterns"), list):
            total += len(parsed["commandPatterns"])
    return total


def get_security_policy_data(project_key: str) -> tuple[dict | None, dict | None]:
    """Recupera de SQLite las políticas globales y las del proyecto (None si aún no existen)."""
    proj_id = project_security_policy_id(project_key)
    with open_storage() as conn:
        global_row = conn.execute("SELECT data_json FROM security_policies WHERE id = ?;", (GLOBAL_SECURITY_POLICY_ID,)).fetchone()
        proj_row = conn.execute("SELECT data_json FROM security_policies WHERE id = ?;", (proj_id,)).fetchone()
        return _parse_security_policy_row(global_row), _parse_security_policy_row(proj_row)


def update_security_policy_data(
    project_key: str,
    mutator: typing.Callable[[dict | None, dict | None, int], tuple[dict, dict | None]],
) -> tuple[dict, dict | None]:
    """Ejecuta una lectura-modificación-escritura atómica sobre la fila global y la del proyecto en BEGIN IMMEDIATE."""
    proj_id = project_security_policy_id(project_key)
    with open_storage() as conn:
        conn.isolation_level = None
        conn.execute("BEGIN IMMEDIATE;")
        try:
            global_row = conn.execute("SELECT data_json FROM security_policies WHERE id = ?;", (GLOBAL_SECURITY_POLICY_ID,)).fetchone()
            proj_row = conn.execute("SELECT data_json FROM security_policies WHERE id = ?;", (proj_id,)).fetchone()
            other_pattern_count = _count_other_project_patterns(conn, proj_id)
            new_global, new_project = mutator(
                _parse_security_policy_row(global_row),
                _parse_security_policy_row(proj_row),
                other_pattern_count,
            )
            now = int(time.time() * 1000)
            _upsert_security_policy_row(conn, GLOBAL_SECURITY_POLICY_ID, new_global, now)
            if new_project is None:
                conn.execute("DELETE FROM security_policies WHERE id = ?;", (proj_id,))
            else:
                _upsert_security_policy_row(conn, proj_id, new_project, now)
            conn.execute("COMMIT;")
            return new_global, new_project
        except Exception:
            conn.execute("ROLLBACK;")
            raise


def _write_secret_on_conn(conn: sqlite3.Connection, name: str, value: str, now: int):
    conn.execute("""
        INSERT INTO secrets (name, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
    """, (name, obfuscate_secret(value), now))


def save_secret(name: str, value: str):
    """Guarda ofuscado el secreto `name` (por ejemplo mcp:<servicio>:<VARIABLE>); nunca se devuelve a la interfaz."""
    if not isinstance(value, str) or not value.strip():
        raise ValueError("El secreto no puede estar vacío")
    if len(value) > MAX_SECRET_LENGTH:
        raise ValueError(f"El secreto no puede superar {MAX_SECRET_LENGTH} caracteres")
    with open_storage() as conn:
        _write_secret_on_conn(conn, name, value.strip(), int(time.time() * 1000))
        conn.commit()


def delete_secret(name: str) -> bool:
    with open_storage() as conn:
        cursor = conn.execute("DELETE FROM secrets WHERE name = ?;", (name,))
        conn.commit()
        return cursor.rowcount > 0


def get_setting(key: str):
    """Lee un ajuste JSON guardado en la tabla `settings`; None si no existe."""
    with open_storage() as conn:
        row = conn.execute("SELECT value_json FROM settings WHERE key = ?;", (key,)).fetchone()
        if not row:
            return None
        return json.loads(row["value_json"])


def _write_setting_on_conn(conn: sqlite3.Connection, key: str, value, now: int):
    conn.execute("""
        INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at;
    """, (key, json.dumps(value, ensure_ascii=False), now))


def set_setting(key: str, value, *, secret_name: str | None = None, secret: str = "") -> None:
    """Guarda un ajuste JSON en `settings`; con `secret_name`, guarda (o borra si va vacío) en la misma transacción su secreto ofuscado."""
    now = int(time.time() * 1000)
    with open_storage() as conn:
        conn.isolation_level = None
        conn.execute("BEGIN IMMEDIATE;")
        try:
            _write_setting_on_conn(conn, key, value, now)
            if secret_name and secret:
                _write_secret_on_conn(conn, secret_name, secret, now)
            elif secret_name:
                conn.execute("DELETE FROM secrets WHERE name = ?;", (secret_name,))
            conn.execute("COMMIT;")
        except Exception:
            conn.execute("ROLLBACK;")
            raise


def _json_column(raw):
    if not raw:
        return None
    try:
        return json.loads(raw)
    except (ValueError, TypeError):
        return None


def _row_to_run_state(row: sqlite3.Row) -> dict:
    return {
        "run_id": row["run_id"],
        "conversation_id": row["conversation_id"],
        "pid": row["pid"],
        "pid_start": row["pid_start"],
        "started_at": row["started_at"],
        "updated_at": row["updated_at"],
        "status": row["status"],
        "step_text": row["step_text"] or "",
        "pending": _json_column(row["pending_json"]),
        "error": row["error"],
        "finished_at": row["finished_at"],
        "result_text": row["result_text"],
        "warnings": _json_column(row["warnings_json"]) or [],
    }


def upsert_run_state(payload: dict) -> None:
    """Guarda o actualiza en SQLite el estado de una ejecución; los campos de su final son opcionales (una que empieza)."""
    conv_id = _validate_conversation_id(payload["conversation_id"])
    pending = payload["pending"]
    pending_json = json.dumps(pending, ensure_ascii=False) if pending is not None else None
    warnings = payload.get("warnings")
    warnings_json = json.dumps(warnings, ensure_ascii=False) if warnings else None
    with open_storage() as conn:
        conn.execute("""
            INSERT INTO runs (conversation_id, run_id, pid, pid_start, started_at, updated_at, status, step_text, pending_json, error,
                              finished_at, result_text, warnings_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(conversation_id) DO UPDATE SET
                run_id = excluded.run_id,
                pid = excluded.pid,
                pid_start = excluded.pid_start,
                started_at = excluded.started_at,
                updated_at = excluded.updated_at,
                status = excluded.status,
                step_text = excluded.step_text,
                pending_json = excluded.pending_json,
                error = excluded.error,
                finished_at = excluded.finished_at,
                result_text = excluded.result_text,
                warnings_json = excluded.warnings_json;
        """, (
            conv_id,
            payload["run_id"],
            payload["pid"],
            payload["pid_start"],
            payload["started_at"],
            payload["updated_at"],
            payload["status"],
            payload["step_text"] or "",
            pending_json,
            payload["error"],
            payload.get("finished_at"),
            payload.get("result_text"),
            warnings_json,
        ))
        conn.commit()
    notify_live_change()


def get_run_state(conversation_id: str) -> dict | None:
    """Recupera de SQLite el estado en vivo de la ejecución de una conversación."""
    clean_id = _validate_conversation_id(conversation_id)
    with open_storage() as conn:
        row = conn.execute("SELECT * FROM runs WHERE conversation_id = ?;", (clean_id,)).fetchone()
        return _row_to_run_state(row) if row else None


def list_run_states() -> list[dict]:
    """Lista todas las ejecuciones registradas en SQLite ordenadas por inicio."""
    with open_storage() as conn:
        rows = conn.execute("SELECT * FROM runs ORDER BY started_at ASC, conversation_id ASC;").fetchall()
        return [_row_to_run_state(row) for row in rows]


def delete_run_state(conversation_id: str) -> bool:
    """Elimina de SQLite el estado de la ejecución de una conversación."""
    clean_id = _validate_conversation_id(conversation_id)
    with open_storage() as conn:
        cursor = conn.execute("DELETE FROM runs WHERE conversation_id = ?;", (clean_id,))
        conn.commit()
        deleted = cursor.rowcount > 0
    if deleted:
        notify_live_change()
    return deleted


def get_secret(name: str) -> str | None:
    """El secreto original, para quien lo usa en el backend (el arranque de un servicio); None si no está guardado."""
    with open_storage() as conn:
        row = conn.execute("SELECT value FROM secrets WHERE name = ?;", (name,)).fetchone()
        return reveal_secret(row["value"]) if row else None


def secret_names(prefix: str) -> set[str]:
    """Nombres de los secretos guardados que empiezan por `prefix`, sin leer sus valores."""
    with open_storage() as conn:
        rows = conn.execute("SELECT name FROM secrets WHERE substr(name, 1, ?) = ?;", (len(prefix), prefix)).fetchall()
        return {row["name"] for row in rows}


SERVER_ID_KEY = "system:server_id"


def conversations_revision() -> str:
    """Firma ligera del estado de conversaciones en SQLite para detectar cambios externos."""
    with open_storage() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS n, COALESCE(MAX(updated_at), 0) AS m, COALESCE(SUM(updated_at), 0) AS s FROM conversations;"
        ).fetchone()
        return f"{row['n']}:{row['m']}:{int(row['s'])}"


def get_server_id() -> str:
    """Identificador único y persistente de este servidor en SQLite."""
    with _STORAGE_LOCK:
        existing = get_secret(SERVER_ID_KEY)
        if existing:
            return existing
        server_id = str(uuid.uuid4())
        save_secret(SERVER_ID_KEY, server_id)
        return server_id


def _empty_project_environment() -> dict:
    return {
        "systemDataPrompt": None,
        "enabledTools": {},
        "mcpServers": [],
        "browser": "browser_action",
        "activeRagBranchIds": [],
        "saved": False,
        "updatedAt": 0,
    }


def _clean_project_tool_id(raw, label: str) -> str:
    if not isinstance(raw, str):
        raise ValueError(f"{label} debe ser un texto")
    clean = raw.strip()
    if not clean or len(clean) > MAX_PROJECT_TOOL_ID_LENGTH:
        raise ValueError(f"{label} debe tener entre 1 y {MAX_PROJECT_TOOL_ID_LENGTH} caracteres")
    return clean


def _validate_project_prompt(prompt) -> str | None:
    if prompt is None:
        return None
    if not isinstance(prompt, str):
        raise ValueError("systemDataPrompt debe ser texto o null")
    clean = prompt.strip()
    if len(clean) > MAX_PROJECT_PROMPT_LENGTH:
        raise ValueError(f"systemDataPrompt no puede superar {MAX_PROJECT_PROMPT_LENGTH} caracteres")
    return clean


def _validate_enabled_tools(tools) -> dict[str, bool]:
    if not isinstance(tools, dict):
        raise ValueError("enabledTools debe ser un objeto")
    if len(tools) > MAX_PROJECT_ENABLED_TOOLS:
        raise ValueError(f"enabledTools no puede superar {MAX_PROJECT_ENABLED_TOOLS} herramientas")
    clean_tools: dict[str, bool] = {}
    for key, value in tools.items():
        clean_key = _clean_project_tool_id(key, "enabledTools")
        if not isinstance(value, bool):
            raise ValueError(f"El estado de '{clean_key}' debe ser un booleano")
        clean_tools[clean_key] = value
    return clean_tools


def _validate_project_id_list(raw, label: str, max_items: int) -> list[str]:
    if not isinstance(raw, list):
        raise ValueError(f"{label} debe ser una lista")
    unique_items = list(dict.fromkeys(_clean_project_tool_id(item, label) for item in raw))
    if len(unique_items) > max_items:
        raise ValueError(f"Un proyecto no puede tener más de {max_items} entradas en {label}")
    return unique_items


def _validate_project_browser(browser) -> str:
    if browser not in BROWSER_TOOLS:
        raise ValueError(f"browser debe ser uno de: {', '.join(BROWSER_TOOLS)}")
    return browser


_PROJECT_ENV_VALIDATORS = {
    "systemDataPrompt": _validate_project_prompt,
    "enabledTools": _validate_enabled_tools,
    "mcpServers": lambda raw: _validate_project_id_list(raw, "mcpServers", MAX_PROJECT_MCP_SERVERS),
    "browser": _validate_project_browser,
    "activeRagBranchIds": lambda raw: _validate_project_id_list(raw, "activeRagBranchIds", MAX_PROJECT_RAG_BRANCHES),
}


def validate_project_environment_patch(raw) -> dict:
    """Valida un parche parcial del entorno de ejecución de un proyecto."""
    if not isinstance(raw, dict):
        raise ValueError("El entorno del proyecto debe ser un objeto JSON")
    unknown = sorted(set(raw) - PROJECT_ENVIRONMENT_KEYS)
    if unknown:
        raise ValueError(f"Campos desconocidos en el entorno del proyecto: {', '.join(unknown)}")
    return {key: _PROJECT_ENV_VALIDATORS[key](raw[key]) for key in raw}


def _row_to_project_environment(row) -> dict:
    try:
        data = json.loads(row["config_json"])
    except (ValueError, TypeError) as exc:
        raise RuntimeError(f"El entorno guardado del proyecto está corrupto: {exc}") from exc
    if not isinstance(data, dict):
        raise RuntimeError("El entorno guardado del proyecto no es un objeto JSON.")
    base = _empty_project_environment()
    validated = validate_project_environment_patch({k: v for k, v in data.items() if k in PROJECT_ENVIRONMENT_KEYS})
    return {**base, **validated, "saved": True, "updatedAt": int(row["updated_at"])}


def get_project_environment(project_key: str) -> dict:
    """Devuelve el entorno guardado del proyecto (`general` usa get_no_project_dir()), o los valores base."""
    clean_key = str(project_key or "").strip()
    if not clean_key:
        raise ValueError("project_key es obligatorio")
    with open_storage() as conn:
        row = conn.execute(
            "SELECT config_json, updated_at FROM project_environments WHERE project_key = ?;",
            (clean_key,),
        ).fetchone()
        return _row_to_project_environment(row) if row else _empty_project_environment()


def save_project_environment(project_key: str, raw_patch: dict) -> dict:
    """Actualiza atómicamente en SQLite el entorno de ejecución guardado del proyecto."""
    clean_key = str(project_key or "").strip()
    if not clean_key:
        raise ValueError("project_key es obligatorio")
    patch = validate_project_environment_patch(raw_patch)
    now = int(time.time() * 1000)
    with open_storage() as conn:
        conn.isolation_level = None
        conn.execute("BEGIN IMMEDIATE;")
        try:
            row = conn.execute(
                "SELECT config_json, updated_at FROM project_environments WHERE project_key = ?;",
                (clean_key,),
            ).fetchone()
            base = _row_to_project_environment(row) if row else _empty_project_environment()
            stored = {key: patch[key] if key in patch else base[key] for key in PROJECT_ENVIRONMENT_FIELDS}
            conn.execute("""
                INSERT INTO project_environments (project_key, config_json, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(project_key) DO UPDATE SET
                    config_json = excluded.config_json,
                    updated_at = excluded.updated_at;
            """, (clean_key, json.dumps(stored, ensure_ascii=False), now))
            conn.execute("COMMIT;")
            return {**stored, "saved": True, "updatedAt": now}
        except Exception:
            conn.execute("ROLLBACK;")
            raise


MAX_PROJECT_SECRETS = 50
PROJECT_SECRET_NAME_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,63}$")


def project_secret_prefix(project_key: str) -> str:
    clean_key = str(project_key or "").strip()
    if not clean_key:
        raise ValueError("project_key es obligatorio")
    return f"project:{clean_key}:"


def validate_project_secret_name(name) -> str:
    if not isinstance(name, str):
        raise ValueError("El nombre del secreto debe ser texto")
    clean = name.strip()
    if not PROJECT_SECRET_NAME_PATTERN.match(clean):
        raise ValueError("El nombre del secreto debe empezar por letra y usar solo letras, cifras o _ (máximo 64)")
    return clean


def project_secret_key(project_key: str, name: str) -> str:
    return f"{project_secret_prefix(project_key)}{validate_project_secret_name(name)}"


def list_project_secret_names(project_key: str) -> list[str]:
    """Nombres de los secretos guardados del proyecto, sin leer ni devolver sus valores."""
    prefix = project_secret_prefix(project_key)
    return sorted(key[len(prefix):] for key in secret_names(prefix))


def save_project_secret(project_key: str, name: str, value: str) -> list[str]:
    clean_name = validate_project_secret_name(name)
    if not isinstance(value, str) or not value.strip():
        raise ValueError("El secreto no puede estar vacío")
    clean_val = value.strip()
    if len(clean_val) > MAX_SECRET_LENGTH:
        raise ValueError(f"El secreto no puede superar {MAX_SECRET_LENGTH} caracteres")
    prefix = project_secret_prefix(project_key)
    full_key = f"{prefix}{clean_name}"
    now = int(time.time() * 1000)
    with open_storage() as conn:
        conn.isolation_level = None
        conn.execute("BEGIN IMMEDIATE;")
        try:
            rows = conn.execute(
                "SELECT name FROM secrets WHERE substr(name, 1, ?) = ?;",
                (len(prefix), prefix),
            ).fetchall()
            existing = {row["name"] for row in rows}
            if full_key not in existing and len(existing) >= MAX_PROJECT_SECRETS:
                raise ValueError(f"Un proyecto no puede tener más de {MAX_PROJECT_SECRETS} secretos")
            _write_secret_on_conn(conn, full_key, clean_val, now)
            conn.execute("COMMIT;")
            existing.add(full_key)
        except Exception:
            conn.execute("ROLLBACK;")
            raise
    return sorted(key[len(prefix):] for key in existing)


def delete_project_secret(project_key: str, name: str) -> list[str]:
    delete_secret(project_secret_key(project_key, name))
    return list_project_secret_names(project_key)


def get_project_secret(project_key: str, name: str) -> str | None:
    """Valor real del secreto del proyecto, solo para uso interno del backend."""
    return get_secret(project_secret_key(project_key, name))


def delete_project_storage(project_key: str) -> list[str]:
    """
    Elimina en una sola transacción las conversaciones del proyecto (con sus blobs huérfanos y sus filas de
    `runs`), su entorno guardado, sus políticas de seguridad y sus secretos. Las filas de `runs` no guardan
    el proyecto: se cruzan por `conversation_id` con el proyecto de la conversación. Si alguna de esas
    ejecuciones sigue en marcha, no borra nada.
    """
    clean_key = str(project_key or "").strip()
    if not clean_key:
        raise ValueError("project_key es obligatorio")
    prefix = project_secret_prefix(clean_key)
    project_where = "json_extract(extra_json, '$.project') = ?"
    with open_storage() as conn:
        conn.isolation_level = None
        conn.execute("BEGIN IMMEDIATE;")
        try:
            running = conn.execute(
                f"SELECT 1 FROM runs WHERE status = 'running' AND conversation_id IN (SELECT id FROM conversations WHERE {project_where}) LIMIT 1;",  # noqa: S608
                (clean_key,),
            ).fetchone()
            if running:
                raise ValueError("Detén los comandos y ejecuciones activas del proyecto antes de borrarlo.")
            conn.execute(
                f"DELETE FROM runs WHERE conversation_id IN (SELECT id FROM conversations WHERE {project_where});",  # noqa: S608
                (clean_key,),
            )
            deleted_ids = _delete_conversations_in_transaction(conn, project_where, (clean_key,))
            conn.execute("DELETE FROM project_environments WHERE project_key = ?;", (clean_key,))
            conn.execute("DELETE FROM security_policies WHERE id = ?;", (project_security_policy_id(clean_key),))
            conn.execute("DELETE FROM secrets WHERE substr(name, 1, ?) = ?;", (len(prefix), prefix))
            conn.execute("COMMIT;")
        except Exception:
            conn.execute("ROLLBACK;")
            raise
    notify_live_change()
    return deleted_ids


def _has_prefix_match(conn: sqlite3.Connection, query: str, p1: str, p2: str) -> bool:
    return conn.execute(query, (len(p1), p1, len(p2), p2)).fetchone() is not None


def has_nested_project_data(project_key: str) -> bool:
    """True si existen entornos, políticas, secretos o conversaciones guardadas de subproyectos bajo `project_key`."""
    clean_key = str(project_key or "").strip().rstrip("/\\")
    if not clean_key:
        return False
    p_slash, p_back = f"{clean_key}/", f"{clean_key}\\"
    pol_slash = f"{PROJECT_SECURITY_POLICY_PREFIX}{p_slash}"
    pol_back = f"{PROJECT_SECURITY_POLICY_PREFIX}{p_back}"
    sec_slash, sec_back = f"project:{p_slash}", f"project:{p_back}"
    with open_storage() as conn:
        if _has_prefix_match(
            conn,
            "SELECT 1 FROM project_environments WHERE substr(project_key, 1, ?) = ? OR substr(project_key, 1, ?) = ? LIMIT 1;",
            p_slash,
            p_back,
        ):
            return True
        if _has_prefix_match(
            conn,
            "SELECT 1 FROM security_policies WHERE substr(id, 1, ?) = ? OR substr(id, 1, ?) = ? LIMIT 1;",
            pol_slash,
            pol_back,
        ):
            return True
        if _has_prefix_match(
            conn,
            "SELECT 1 FROM secrets WHERE substr(name, 1, ?) = ? OR substr(name, 1, ?) = ? LIMIT 1;",
            sec_slash,
            sec_back,
        ):
            return True
        if _has_prefix_match(
            conn,
            "SELECT 1 FROM conversations WHERE substr(json_extract(extra_json, '$.project'), 1, ?) = ? OR substr(json_extract(extra_json, '$.project'), 1, ?) = ? LIMIT 1;",
            p_slash,
            p_back,
        ):
            return True
    return False
