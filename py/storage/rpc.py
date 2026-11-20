"""Métodos JSON-RPC de los datos guardados en SQLite: perfiles del servidor, conversaciones y blobs."""

from __future__ import annotations

import base64
import urllib.parse

from core.logging import log_event
from core.rpc import INTERNAL_ERROR, INVALID_PARAMS, RpcOutcome, dispatch_table, rpc_error, rpc_result
from run_mode.state import cancel_server_run, get_runs_dir
from storage.db import (
    commit_conversation_upload,
    delete_all_conversations,
    delete_conversation,
    delete_general_profile,
    delete_project_conversations,
    get_blob,
    get_general_profile_with_key,
    get_conversation,
    has_blobs,
    list_conversations,
    list_general_profiles,
    put_blob,
    rename_conversation,
    save_conversation,
    save_conversation_chunk,
    save_general_profile,
)


def _guarded(handlers: dict, method: str, params: dict, failure: str) -> RpcOutcome:
    """Atiende el método con su tabla; un ValueError es un parámetro no válido y otro fallo, un error interno."""
    try:
        return dispatch_table(handlers, method, params)
    except ValueError as exc:
        return rpc_error(INVALID_PARAMS, str(exc))
    except Exception as exc:
        return rpc_error(INTERNAL_ERROR, f"{failure}: {exc}", str(exc))


# --- Perfiles del servidor -------------------------------------------------------------


def _save_profile(params: dict) -> RpcOutcome:
    profile_data = params.get("profile")
    if not isinstance(profile_data, dict):
        return rpc_error(INVALID_PARAMS, "profile debe ser un objeto.")
    return rpc_result({"profile": save_general_profile(profile_data)})


def _delete_profile(params: dict) -> RpcOutcome:
    profile_id = params.get("id")
    if not isinstance(profile_id, str) or not profile_id.strip():
        return rpc_error(INVALID_PARAMS, "id debe ser un texto no vacío.")
    return rpc_result({"deleted": delete_general_profile(profile_id)})


def _reveal_profile(params: dict) -> RpcOutcome:
    """El perfil con su API key bajo demanda cuando la interfaz ejecuta en el navegador o edita un perfil
    cuya clave solo está en el servidor (docs/M75-apikeys.md), y deja constancia en el registro."""
    profile_id = params.get("id")
    profile = get_general_profile_with_key(profile_id) if isinstance(profile_id, str) else None
    if profile is None:
        return rpc_error(INVALID_PARAMS, "Perfil del servidor no encontrado.")
    log_event(f"Se entrega a la interfaz el perfil del servidor {profile['name']} con su clave")
    return rpc_result({"profile": profile})


# El listado y lo que devuelve guardar no llevan la API key, solo hasApiKey.
PROFILE_METHODS = {
    "zerochat/profiles/list": lambda _params: rpc_result({"profiles": list_general_profiles()}),
    "zerochat/profiles/reveal": _reveal_profile,
    "zerochat/profiles/save": _save_profile,
    "zerochat/profiles/delete": _delete_profile,
}


def dispatch_profiles(method: str, params: dict) -> RpcOutcome:
    """Perfiles generales almacenados en SQLite en el backend local."""
    return _guarded(PROFILE_METHODS, method, params if isinstance(params, dict) else {}, "Error en gestión de perfiles")


# --- Conversaciones --------------------------------------------------------------------


def _cancel_runs(conversation_ids):
    """Borrar una conversación detiene su ejecución en servidor, si la hay."""
    for conversation_id in conversation_ids:
        try:
            cancel_server_run(conversation_id)
        except (ValueError, OSError):
            pass


def _rpc_delete_conversations(params: dict) -> RpcOutcome:
    if params.get("all") is True:
        _cancel_runs(urllib.parse.unquote(run_file.stem) for run_file in get_runs_dir().glob("*.json"))
        return rpc_result({"deleted": True, "count": delete_all_conversations()})
    if "project" in params:
        deleted_ids = delete_project_conversations(params.get("project"))
        _cancel_runs(deleted_ids)
        return rpc_result({"deleted": True, "count": len(deleted_ids)})
    conv_id = params.get("id")
    if isinstance(conv_id, str) and conv_id.strip():
        _cancel_runs([conv_id])
    return rpc_result({"deleted": delete_conversation(params.get("id"))})


def _rpc_save_conversation(params: dict) -> RpcOutcome:
    if not isinstance(params, dict):
        raise ValueError("Los parámetros deben ser un objeto")
    upload_id = params.get("uploadId")
    if upload_id is not None:
        if params.get("messages") is not None:
            raise ValueError("No se puede combinar uploadId y messages")
        return rpc_result({"conversation": commit_conversation_upload(params.get("conversation"), upload_id)})
    return rpc_result({"conversation": save_conversation(params.get("conversation"), params.get("messages"))})


CONVERSATION_METHODS = {
    "zerochat/conversations/list": lambda _params: rpc_result({"conversations": list_conversations()}),
    "zerochat/conversations/get": lambda params: rpc_result({"conversation": get_conversation(params.get("id"))}),
    "zerochat/conversations/save": _rpc_save_conversation,
    "zerochat/conversations/save_chunk": lambda params: rpc_result(save_conversation_chunk(params)),
    "zerochat/conversations/rename": lambda params: rpc_result(
        {"renamed": rename_conversation(params.get("id"), params.get("title"))}),
    "zerochat/conversations/delete": _rpc_delete_conversations,
}


def dispatch_conversations(method: str, params: dict) -> RpcOutcome:
    """Conversaciones y mensajes almacenados en SQLite en el backend local."""
    return _guarded(CONVERSATION_METHODS, method, params, "Error en gestión de conversaciones")


# --- Blobs (imágenes y adjuntos, aparte de los mensajes) ----------------------------------


def _put_blob(params: dict) -> RpcOutcome:
    raw_data = params.get("data")
    if not raw_data or not isinstance(raw_data, str):
        raise ValueError("El parámetro 'data' debe ser una cadena en base64 no vacía")
    mime_type = params.get("mimeType") or "application/octet-stream"
    if raw_data.startswith("data:") and ";base64," in raw_data:
        header, b64_part = raw_data.split(";base64,", 1)
        if not params.get("mimeType"):
            mime_type = header[5:]
        raw_data = b64_part
    try:
        data_bytes = base64.b64decode(raw_data)
    except Exception as decode_err:
        raise ValueError(f"Error decodificando base64: {decode_err}") from decode_err
    saved = put_blob(data_bytes, mime_type=mime_type, blob_id=params.get("id"))
    return rpc_result({"id": saved["id"], "mimeType": saved["mime_type"], "size": saved["size"]})


def _get_blob(params: dict) -> RpcOutcome:
    blob = get_blob(params.get("id"))
    if not blob:
        return rpc_result({"blob": None})
    return rpc_result({
        "blob": {
            "id": blob["id"],
            "mimeType": blob["mime_type"],
            "size": blob["size"],
            "data": base64.b64encode(blob["data"]).decode("ascii"),
            "createdAt": blob["created_at"],
        }
    })


BLOB_METHODS = {
    "zerochat/blobs/has": lambda params: rpc_result(has_blobs(params.get("ids") if params.get("ids") is not None else [])),
    "zerochat/blobs/put": _put_blob,
    "zerochat/blobs/get": _get_blob,
}


def dispatch_blobs(method: str, params: dict) -> RpcOutcome:
    """Blobs desacoplados de los mensajes (imágenes y adjuntos) en SQLite."""
    return _guarded(BLOB_METHODS, method, params if isinstance(params, dict) else {}, "Error en gestión de blobs")
