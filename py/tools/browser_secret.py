"""Relleno seguro de secretos del proyecto en Playwright MCP sin exponer valores al modelo."""

from __future__ import annotations

import json

from browser.config import PLAYWRIGHT_SERVER_ID
from mcp.manager import GLOBAL_MCP_MANAGER, public_tool_name
from security.context import SecurityContext
from storage.db import get_project_secret
from tools.common import _tool_error


BROWSER_SECRET_MODES = ("input", "keypad")


def _scrub_secret(text: str, secret_value: str) -> str:
    return text.replace(secret_value, "***") if secret_value and text else text


def _mcp_call_error(tool_name: str, arguments: dict, secret_value: str) -> str | None:
    result = GLOBAL_MCP_MANAGER.call(public_tool_name(PLAYWRIGHT_SERVER_ID, tool_name), arguments)
    if not (isinstance(result, dict) and result.get("isError")):
        return None
    parts = [str(item.get("text") or "") for item in (result.get("content") or []) if isinstance(item, dict)]
    detail = _scrub_secret(" ".join(p for p in parts if p).strip(), secret_value)
    return detail or f"Playwright {tool_name} failed."


def _fill_input_secret(secret_value: str, ref: str, element: str, submit: bool) -> str | None:
    clean_ref = ref.strip() if isinstance(ref, str) else ""
    if not clean_ref:
        return "El modo 'input' requiere un 'ref' no vacío."
    label = element.strip() if isinstance(element, str) and element.strip() else "input field"
    return _mcp_call_error("browser_type", {
        "element": label,
        "target": clean_ref,
        "text": secret_value,
        "submit": bool(submit),
    }, secret_value)


def _is_xy_target(target) -> bool:
    if not isinstance(target, (list, tuple)) or len(target) != 2:
        return False
    return all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in target)


def _click_keypad_target(target, secret_value: str) -> str | None:
    if isinstance(target, str) and target.strip():
        return _mcp_call_error("browser_click", {"element": "keypad button", "target": target.strip()}, secret_value)
    if _is_xy_target(target):
        return _mcp_call_error("browser_mouse_click_xy", {
            "x": float(target[0]),
            "y": float(target[1]),
        }, secret_value)
    return "Cada entrada de keypad_map debe ser un 'ref' de texto o coordenadas [x, y]."


def _fill_keypad_secret(secret_value: str, keypad_map) -> str | None:
    if not isinstance(keypad_map, dict) or not keypad_map:
        return "El modo 'keypad' requiere un objeto keypad_map no vacío."
    if any(ch not in keypad_map for ch in secret_value):
        return "keypad_map no cubre todos los caracteres del secreto."
    for ch in secret_value:
        err = _click_keypad_target(keypad_map[ch], secret_value)
        if err:
            return err
    return None


def browser_fill_secret(
    secret: str,
    mode: str,
    ref: str = "",
    element: str = "",
    submit: bool = False,
    keypad_map: dict | None = None,
    ctx: SecurityContext | None = None,
) -> str:
    """Introduce un secreto guardado del proyecto en un campo input o teclado virtual de Playwright MCP."""
    if ctx is None:
        return _tool_error("Se requiere contexto de proyecto para leer secretos.")
    if mode not in BROWSER_SECRET_MODES:
        return _tool_error(f"Modalidad no válida: {mode}")
    try:
        secret_value = get_project_secret(ctx.key, secret)
    except ValueError as exc:
        return _tool_error(str(exc))
    if secret_value is None:
        return _tool_error(f"El secreto '{secret}' no está guardado en este proyecto.")
    try:
        err = (
            _fill_input_secret(secret_value, ref, element, submit)
            if mode == "input"
            else _fill_keypad_secret(secret_value, keypad_map)
        )
    except Exception as exc:
        return _tool_error(f"Error ejecutando Playwright MCP: {_scrub_secret(str(exc), secret_value)}")
    if err:
        return _tool_error(err)
    payload: dict = {"success": True, "mode": mode, "secret": secret}
    if mode == "keypad":
        payload["steps"] = len(secret_value)
    return json.dumps(payload)
