"""Token diario de sesión: se guarda en los datos del usuario, caduca al cambiar el día y avisa a quien guarda lo que vale solo para su sesión."""

from __future__ import annotations

import datetime
import json
import os
import secrets
import threading

from core.environment import _write_private_text, get_data_dir
from core.logging import log_event


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


# Token de sesión en memoria y su día; main() lo carga al arrancar y current_session_token() lo renueva.
SESSION_TOKEN = ""
SESSION_TOKEN_DATE = ""
SESSION_TOKEN_LOCK = threading.Lock()


def current_session_token() -> str:
    """
    Token diario vigente: al cambiar el día carga o genera el nuevo, también con el servidor en marcha.
    Cada token abre una sesión: al cargarlo se olvidan, bajo el mismo cerrojo, las autorizaciones de sesión.
    """
    global SESSION_TOKEN, SESSION_TOKEN_DATE
    today = datetime.date.today().isoformat()
    with SESSION_TOKEN_LOCK:
        if SESSION_TOKEN_DATE != today:
            SESSION_TOKEN = get_daily_token()
            SESSION_TOKEN_DATE = today
            for hook in TOKEN_ROTATION_HOOKS:
                hook()
        return SESSION_TOKEN
