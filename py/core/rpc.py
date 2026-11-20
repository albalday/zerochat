"""Respuestas de los métodos JSON-RPC del servidor: (resultado, error JSON-RPC, detalle para el registro)."""

from __future__ import annotations

from typing import Callable

METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603

RpcOutcome = tuple[dict | None, dict | None, str]


def rpc_result(result) -> RpcOutcome:
    return result, None, ""


def rpc_error(code: int, message: str, detail: str = "") -> RpcOutcome:
    return None, {"code": code, "message": message}, detail


def rpc_not_supported(method: str) -> RpcOutcome:
    return rpc_error(METHOD_NOT_FOUND, f"Método '{method}' no soportado.")


def dispatch_table(handlers: dict[str, Callable[..., RpcOutcome]], method: str, *args) -> RpcOutcome:
    """Atiende el método con su función de la tabla, que recibe *args; sin ella, «no soportado»."""
    handler = handlers.get(method)
    return handler(*args) if handler else rpc_not_supported(method)


def parse_nonneg_int(value, label: str, default: int | None = None) -> int | None:
    """Valida un parámetro entero no negativo (sin booleanos); devuelve `default` si es None."""
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{label} debe ser un entero no negativo.")
    return value
