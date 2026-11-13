"""Topes compartidos por varios módulos: tamaño de las peticiones HTTP, rutas, comandos y nombres JSON-RPC."""

from __future__ import annotations

MAX_HTTP_BODY_BYTES = 1024 * 1024
MAX_PATH_LENGTH = 4096
MAX_COMMAND_LENGTH = 16384
MAX_RPC_METHOD_LENGTH = 128
MAX_TOOL_NAME_LENGTH = 128
