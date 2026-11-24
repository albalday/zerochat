"""Topes compartidos por varios módulos: tamaño de las peticiones HTTP, rutas, comandos y nombres JSON-RPC."""

from __future__ import annotations

MAX_HTTP_BODY_BYTES = 1024 * 1024
MAX_PATH_LENGTH = 4096
MAX_COMMAND_LENGTH = 16384
MAX_RPC_METHOD_LENGTH = 128
MAX_TOOL_NAME_LENGTH = 128
LONG_POLL_MAX_WAIT_MS = 30000
# Lo más que una herramienta retiene su respuesta (run_command, check_command, check_agents), en la interfaz y en el
# runner: el fetch de Node corta a los 300 s sin recibir cabeceras (headersTimeout de undici) y los navegadores tienen
# plazos parecidos, así que un tope único por debajo vale para los dos.
TOOL_WAIT_MAX_SECONDS = 240
