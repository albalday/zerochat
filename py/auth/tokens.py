"""Gestión de tokens de sesión y credenciales de ejecución: token local diario, sesiones remotas (login) y tokens acotados del runner."""

from __future__ import annotations

import dataclasses
import datetime
import hmac
import json
import os
import secrets
import threading
import time

from core.environment import _write_private_text, get_data_dir
from core.logging import log_event


MAX_REMOTE_TOKENS = 16
RUNNER_EXTERNAL_METHODS = frozenset({
    "initialize",
    "notifications/initialized",
    "tools/list",
    "tools/call",
})
RUNNER_ALLOWED_METHODS = frozenset({
    "initialize",
    "notifications/initialized",
    "tools/list",
    "tools/call",
    "zerochat/run/prompt",
    "zerochat/run/progress",
    "zerochat/run/export",
    "zerochat/run/result",
    "zerochat/web/fetch",
    "zerochat/jobs/stop",
    "zerochat/heartbeat",
    "zerochat/external/servers/start",
    "zerochat/external/servers/stop",
    "zerochat/sandbox/execute",
})


@dataclasses.dataclass(frozen=True)
class TokenGrant:
    """Credencial autenticada con su tipo, fecha de emisión y alcance sobre la API."""
    token: str
    kind: str  # "local" | "remote" | "runner"
    date: str
    created_at: float
    run_id: str | None = None
    conversation_id: str | None = None

    def allows(self, req_path: str, method: str, params: dict | None = None) -> bool:
        """Indica si esta credencial autoriza el método JSON-RPC solicitado en la ruta dada."""
        if self.kind in ("local", "remote"):
            return True
        if self.kind != "runner":
            return False
        if "/mcp/external" in req_path:
            return method in RUNNER_EXTERNAL_METHODS
        if method in RUNNER_ALLOWED_METHODS:
            return True
        if self.conversation_id and isinstance(params, dict):
            if method == "zerochat/conversations/get":
                return params.get("id") == self.conversation_id
            if method == "zerochat/conversations/save":
                conv = params.get("conversation")
                return isinstance(conv, dict) and conv.get("id") == self.conversation_id
        return False


def get_daily_token() -> str:
    """Devuelve un token de sesión diario persistido en ~/zerochat/config/token.json."""
    config_dir = get_data_dir() / "config"
    config_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    token_file = config_dir / "token.json"
    if os.name != "nt":
        # Corrige también directorios y tokens creados por versiones anteriores con la umask.
        config_dir.chmod(0o700)
        if token_file.exists():
            token_file.chmod(0o600)
    today = datetime.date.today().isoformat()
    if token_file.exists():
        try:
            data = json.loads(token_file.read_text(encoding="utf-8"))
            if data.get("date") == today and data.get("token") and isinstance(data["token"], str):
                return data["token"]
        except (OSError, json.JSONDecodeError):
            pass
    token = secrets.token_urlsafe(32)
    try:
        _write_private_text(token_file, json.dumps({"token": token, "date": today}, indent=2))
    except OSError as err:
        log_event(f"[zerochat] Advertencia: no se pudo guardar el token diario en {token_file}: {err}")
    return token


# Lo que caduca con cada token (las autorizaciones de sesión): lo registran las capas que lo guardan.
TOKEN_ROTATION_HOOKS: list = []


def on_token_rotation(hook):
    """Registra una función que se llama, sin argumentos, cada vez que se carga un token nuevo."""
    TOKEN_ROTATION_HOOKS.append(hook)
    return hook


# Token local diario, sesiones remotas y tokens de runner activos en memoria bajo el mismo cerrojo.
SESSION_TOKEN = ""
SESSION_TOKEN_DATE = ""
ACTIVE_GRANTS: dict[str, TokenGrant] = {}
SESSION_TOKEN_LOCK = threading.Lock()


def _refresh_daily_locked(today: str) -> str:
    """Renueva el token local al cambiar de día, limpia sesiones remotas caducadas y avisa a los hooks."""
    global SESSION_TOKEN, SESSION_TOKEN_DATE
    if SESSION_TOKEN_DATE != today:
        SESSION_TOKEN = get_daily_token()
        SESSION_TOKEN_DATE = today
        expired = [tok for tok, grant in ACTIVE_GRANTS.items() if grant.kind == "remote" and grant.date != today]
        for tok in expired:
            ACTIVE_GRANTS.pop(tok, None)
        for hook in TOKEN_ROTATION_HOOKS:
            hook()
    return SESSION_TOKEN


def current_session_token() -> str:
    """
    Token diario vigente para el navegador local: al cambiar el día carga o genera el nuevo.
    """
    today = datetime.date.today().isoformat()
    with SESSION_TOKEN_LOCK:
        return _refresh_daily_locked(today)


def issue_login_token() -> str:
    """Emite una credencial independiente de usuario para una sesión remota autenticada por zerochat/login."""
    today = datetime.date.today().isoformat()
    with SESSION_TOKEN_LOCK:
        _refresh_daily_locked(today)
        remote_grants = [g for g in ACTIVE_GRANTS.values() if g.kind == "remote"]
        while len(remote_grants) >= MAX_REMOTE_TOKENS:
            oldest = min(remote_grants, key=lambda g: g.created_at)
            ACTIVE_GRANTS.pop(oldest.token, None)
            remote_grants.remove(oldest)
        token = secrets.token_urlsafe(32)
        ACTIVE_GRANTS[token] = TokenGrant(
            token=token,
            kind="remote",
            date=today,
            created_at=time.monotonic(),
        )
        return token


def issue_runner_token(run_id: str, conversation_id: str | None = None) -> str:
    """Emite una credencial acotada para el proceso runner de Node.js ligada a su ejecución."""
    today = datetime.date.today().isoformat()
    with SESSION_TOKEN_LOCK:
        _refresh_daily_locked(today)
        token = secrets.token_urlsafe(32)
        ACTIVE_GRANTS[token] = TokenGrant(
            token=token,
            kind="runner",
            date=today,
            created_at=time.monotonic(),
            run_id=run_id,
            conversation_id=conversation_id,
        )
        return token


def revoke_token(token: str | None) -> bool:
    """Revoca una credencial emitida en memoria (sesión remota o runner)."""
    if not token:
        return False
    with SESSION_TOKEN_LOCK:
        return ACTIVE_GRANTS.pop(token, None) is not None


def resolve_token(token_candidate: str) -> TokenGrant | None:
    """Valida una credencial en tiempo constante y devuelve su TokenGrant o None."""
    if not token_candidate or not isinstance(token_candidate, str):
        return None
    today = datetime.date.today().isoformat()
    candidate_bytes = token_candidate.encode()
    with SESSION_TOKEN_LOCK:
        local_token = _refresh_daily_locked(today)
        if local_token and hmac.compare_digest(candidate_bytes, local_token.encode()):
            return TokenGrant(token=local_token, kind="local", date=SESSION_TOKEN_DATE, created_at=0.0)
        matched: TokenGrant | None = None
        for grant in ACTIVE_GRANTS.values():
            if hmac.compare_digest(candidate_bytes, grant.token.encode()):
                matched = grant
        if matched is None:
            return None
        if matched.kind == "remote" and matched.date != today:
            ACTIVE_GRANTS.pop(matched.token, None)
            return None
        return matched
