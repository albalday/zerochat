"""Herramientas locales complementarias de Playwright MCP: secretos y estado de sesión (cookies/localStorage/IndexedDB) por proyecto."""

from __future__ import annotations

import hashlib
import json
import os
import re
from pathlib import Path

from browser.config import PLAYWRIGHT_SERVER_ID
from mcp.manager import GLOBAL_MCP_MANAGER, public_tool_name
from security.context import SecurityContext
from storage.db import get_project_secret
from tools.common import _tool_error


PLAYWRIGHT_LOCAL_TOOLS = frozenset({"browser_fill_secret", "browser_save_state", "browser_load_state"})
MAX_BROWSER_STATES_PER_PROJECT = 32
_STATE_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")


def _mcp_call_failed(tool_name: str, arguments: dict) -> bool:
    result = GLOBAL_MCP_MANAGER.call(public_tool_name(PLAYWRIGHT_SERVER_ID, tool_name), arguments)
    return bool(isinstance(result, dict) and result.get("isError"))


def _fill_input_secret(secret_value: str, ref: str, element: str, submit: bool) -> str | None:
    clean_ref = ref.strip() if isinstance(ref, str) else ""
    if not clean_ref:
        return "Se requiere un 'ref' no vacío."
    label = element.strip() if isinstance(element, str) and element.strip() else "input field"
    if _mcp_call_failed("browser_type", {
        "element": label,
        "target": clean_ref,
        "text": secret_value,
        "submit": bool(submit),
    }):
        return "Playwright no pudo rellenar el campo del secreto: comprueba la referencia y vuelve a intentarlo."
    return None


def browser_fill_secret(
    secret: str,
    ref: str,
    element: str = "",
    submit: bool = False,
    ctx: SecurityContext | None = None,
) -> str:
    """Introduce un secreto guardado del proyecto en un campo input de Playwright MCP."""
    if ctx is None:
        return _tool_error("Se requiere contexto de proyecto para leer secretos.")
    try:
        secret_value = get_project_secret(ctx.key, secret)
    except ValueError as exc:
        return _tool_error(str(exc))
    if secret_value is None:
        return _tool_error(f"El secreto '{secret}' no está guardado en este proyecto.")
    try:
        err = _fill_input_secret(secret_value, ref, element, submit)
    except Exception:
        return _tool_error("Error ejecutando Playwright MCP al rellenar el secreto.")
    if err:
        return _tool_error(err)
    return json.dumps({"success": True, "secret": secret})


def _browser_state_location(ctx: SecurityContext, name: str) -> tuple[str, Path]:
    if not isinstance(name, str) or not _STATE_NAME_RE.fullmatch(name):
        raise ValueError("State name must be 1-64 characters of letters, digits, '-' or '_'.")
    project_hash = hashlib.sha256(ctx.key.encode("utf-8")).hexdigest()[:24]
    rel_path = f"states/{project_hash}/{name}.json"
    full_path = GLOBAL_MCP_MANAGER.services_root / PLAYWRIGHT_SERVER_ID / "states" / project_hash / f"{name}.json"
    return rel_path, full_path


def _chmod_private(path: Path, mode: int) -> None:
    if os.name != "nt":
        path.chmod(mode)


def browser_save_state(name: str, ctx: SecurityContext | None = None) -> str:
    """Guarda el estado actual del navegador (cookies, localStorage e IndexedDB) bajo el proyecto activo."""
    if ctx is None:
        return _tool_error("Project context is required to save browser state.")
    try:
        _, target = _browser_state_location(ctx, name)
    except ValueError as exc:
        return _tool_error(str(exc))
    states_root = target.parent.parent
    project_dir = target.parent
    states_root.mkdir(parents=True, exist_ok=True)
    _chmod_private(states_root, 0o700)
    project_dir.mkdir(parents=True, exist_ok=True)
    _chmod_private(project_dir, 0o700)
    if not target.exists():
        existing = sum(1 for item in project_dir.iterdir() if item.is_file() and item.suffix == ".json")
        if existing >= MAX_BROWSER_STATES_PER_PROJECT:
            return _tool_error(f"Project reached the maximum of {MAX_BROWSER_STATES_PER_PROJECT} saved browser states.")
    save_code = (
        "async (page) => { "
        f"await page.context().storageState({{ path: {json.dumps(str(target))}, indexedDB: true }}); "
        "return true; "
        "}"
    )
    try:
        failed = _mcp_call_failed("browser_run_code_unsafe", {"code": save_code})
    except Exception:
        return _tool_error("Error running Playwright MCP while saving browser state.")
    if failed or not target.is_file():
        return _tool_error("Playwright could not save the browser state.")
    _chmod_private(target, 0o600)
    return json.dumps({"success": True, "name": name, "saved": True})


def browser_load_state(name: str, ctx: SecurityContext | None = None) -> str:
    """Restaura un estado guardado del navegador (cookies, localStorage e IndexedDB) del proyecto activo."""
    if ctx is None:
        return _tool_error("Project context is required to load browser state.")
    try:
        rel_path, target = _browser_state_location(ctx, name)
    except ValueError as exc:
        return _tool_error(str(exc))
    if not target.is_file():
        return _tool_error(f"Saved browser state '{name}' does not exist for this project.")
    try:
        failed = _mcp_call_failed("browser_set_storage_state", {"filename": rel_path})
    except Exception:
        return _tool_error("Error running Playwright MCP while loading browser state.")
    if failed:
        return _tool_error("Playwright could not restore the browser state.")
    return json.dumps({"success": True, "name": name, "loaded": True})
