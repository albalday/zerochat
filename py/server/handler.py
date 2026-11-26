"""Servidor HTTP JSON-RPC del backend local: orígenes admitidos, token e identificación, despacho por grupos de métodos y punto único de ejecución de herramientas."""

from __future__ import annotations

import json
import re
import socketserver
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from auth.login import LOGIN_MAX_BODY_BYTES
from auth.tokens import TokenGrant, resolve_token
from core.environment import get_static_root, is_loopback_host
from core.limits import MAX_HTTP_BODY_BYTES, MAX_RPC_METHOD_LENGTH, MAX_TOOL_NAME_LENGTH
from core.logging import format_log_error, log_event
from core.version import VERSION
from run_mode.state import current_run_session, http_body_limit
from security.context import PROJECT_GONE_CODE, ProjectGoneError, request_project_context
from server.state import mark_browser_active
from server.rpc import dispatch_local, rpc_login
from storage.db import MAX_BLOB_HTTP_BYTES
from tools.registry import validate_local_tool_arguments
from web.fetch import capture_frontend_user_agent


def sanitize_log_path(raw_path: str) -> str:
    """Oculta tokens de sesión o parámetros sensibles en la query string para logs seguros."""
    if not raw_path or "?" not in raw_path:
        return raw_path or "/"
    path, query = raw_path.split("?", 1)
    safe_query = re.sub(r'(token=)[^&]+', r'\1***', query, flags=re.IGNORECASE)
    return f"{path}?{safe_query}"


def has_dot_segment(raw_path: str) -> bool:
    """Una URL cuya ruta tiene un segmento `..`, también codificado o con barra invertida: ninguna de ZeroChat lo lleva."""
    path = urllib.parse.unquote(raw_path.split("?", 1)[0].split("#", 1)[0])
    return ".." in re.split(r"[/\\]", path)


def static_file_target(root: Path, rel_path: str) -> Path | None:
    """
    Fichero que sirve el servidor de desarrollo para rel_path: lo que hay bajo la raíz del repositorio,
    salvo ficheros ocultos (.git, .env, .zerochat) y rutas que al resolverse salen de ella (enlaces simbólicos).
    """
    clean_rel = rel_path.split("?", 1)[0].lstrip("/")
    if not clean_rel:
        return None
    base = root.resolve()
    target = (base / clean_rel).resolve()
    try:
        parts = target.relative_to(base).parts
    except ValueError:
        return None
    if any(part.startswith(".") for part in parts) or not target.is_file():
        return None
    return target


def is_allowed_origin(origin: str | None, require_origin: bool = False) -> bool:
    """Verifica si el origen CORS está autorizado."""
    if origin is None or origin == "null":
        return not require_origin
    origin_lower = origin.lower()
    if origin_lower == "https://albalday.github.io" or origin_lower.startswith("https://albalday.github.io/"):
        return True
    if origin_lower == "http://127.0.0.1" or origin_lower.startswith("http://127.0.0.1:"):
        return True
    if origin_lower == "http://localhost" or origin_lower.startswith("http://localhost:"):
        return True
    return False


# zerochat/run/progress ya se registra con su propio texto en dispatch_run; zerochat/run/usage llega tras cada paso.
QUIET_RPC_METHODS = frozenset({
    "zerochat/heartbeat",
    "zerochat/jobs/get",
    "zerochat/jobs/log",
    "zerochat/jobs/list",
    "zerochat/run/progress",
    "zerochat/run/usage",
    "zerochat/project/context",
})
DEV_CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8",
    ".map": "application/json",
}


class ZeroChatServerHandler(BaseHTTPRequestHandler):
    server_version = f"ZeroChatServer/{VERSION}"

    def _log_req(self, method: str, detail: str):
        log_event(f"--> {method} {detail}")

    def _log_res(self, status: int, detail: str, duration_ms: float, error_info: str = ""):
        status_text = {
            200: "200 OK",
            204: "204 No Content",
            400: "400 Bad Request",
            401: "401 Unauthorized",
            403: "403 Forbidden",
            404: "404 Not Found",
            500: "500 Internal Server Error",
        }.get(status, str(status))
        err_suffix = f" - ERROR: {format_log_error(error_info)}" if error_info else ""
        log_event(f"<-- {status_text} {detail}{err_suffix} ({duration_ms:.1f}ms)")

    def serve_static_file(self, rel_path: str) -> bool:
        """
        La interfaz del repositorio de desarrollo, sin token: solo en desarrollo (get_static_root) y solo
        a clientes del propio equipo, aunque el servidor escuche en otra dirección con --host.
        """
        static_root = get_static_root()
        if not static_root or not is_loopback_host(self.client_address[0]):
            return False
        target_path = static_file_target(static_root, rel_path)
        if target_path is None:
            return False

        ext = target_path.suffix.lower()
        content_type = DEV_CONTENT_TYPES.get(ext, "application/octet-stream")
        try:
            data = target_path.read_bytes()
        except Exception:
            return False

        mark_browser_active()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        if target_path == static_root.resolve() / "sw.js":
            self.send_header("Service-Worker-Allowed", "/")
        self.send_cors_headers()
        self.end_headers()
        self.wfile.write(data)
        return True

    def send_cors_headers(self):
        origin = self.headers.get("Origin")
        if not is_allowed_origin(origin, require_origin=True):
            return
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization, X-ZeroChat-Token, X-ZeroChat-Client, X-ZeroChat-Proxy, X-ZeroChat-Blob, X-ZeroChat-Project")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def _resolve_grant(self) -> TokenGrant | None:
        """
        Comprueba la credencial en cabeceras HTTP y devuelve su TokenGrant o None.
        X-ZeroChat-Token va antes que Authorization, que tras el proxy inverso lleva la clave del proxy.
        """
        token_candidate = self.headers.get("X-ZeroChat-Token", "").strip()
        if not token_candidate:
            auth_header = self.headers.get("Authorization", "")
            if auth_header.startswith("Bearer "):
                token_candidate = auth_header[7:].strip()
        return resolve_token(token_candidate)

    def _reject_dot_segment(self, verb: str, safe_path: str, t0: float) -> bool:
        """Responde 400 a una URL con `..` antes de mirar el origen, el token o el cuerpo; devuelve si lo hizo."""
        if not has_dot_segment(self.path):
            return False
        self._log_req(verb, safe_path)
        # El cuerpo de un POST no se lee: la conexión no se reutiliza.
        self.close_connection = True
        self._reject(400, {"error": "Invalid path"}, safe_path, t0, "Ruta con un segmento '..'")
        return True

    def do_OPTIONS(self):
        t0 = time.monotonic()
        safe_path = sanitize_log_path(self.path)
        if self._reject_dot_segment("OPTIONS", safe_path, t0):
            return
        origin = self.headers.get("Origin")
        if not is_allowed_origin(origin, require_origin=True):
            self._log_req("OPTIONS", safe_path)
            self.send_response(403)
            self.end_headers()
            self._log_res(403, safe_path, (time.monotonic() - t0) * 1000, f"Origen no permitido: '{origin}'")
            return
        # La comprobación previa precede a cada POST con cabeceras propias, también al latido: no se registra.
        self.send_response(204)
        self.send_cors_headers()
        self.end_headers()

    def _send_json_response(self, status: int, data: dict) -> bool:
        """Envía JSON con cabeceras CORS; devuelve False si el cliente ya cerró la conexión."""
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_cors_headers()
        self.end_headers()
        try:
            self.wfile.write(body)
            return True
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
            return False

    def do_GET(self):
        """Solo la interfaz servida en desarrollo y el favicon: la API va por POST."""
        t0 = time.monotonic()
        safe_path = sanitize_log_path(self.path)
        if self._reject_dot_segment("GET", safe_path, t0):
            return
        path_clean = self.path.split("?", 1)[0].rstrip("/")
        self._log_req("GET", safe_path)

        origin = self.headers.get("Origin")
        if not is_allowed_origin(origin):
            self.send_response(403)
            self.end_headers()
            self._log_res(403, safe_path, (time.monotonic() - t0) * 1000, f"Origen no permitido: '{origin}'")
            return

        # Servir archivos estáticos del repositorio si estamos en entorno de desarrollo
        if path_clean and self.serve_static_file(path_clean):
            self._log_res(200, safe_path, (time.monotonic() - t0) * 1000)
            return

        # Browsers request this optional public resource without API credentials.
        if path_clean == "/favicon.ico":
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        self._reject(404, {"error": "Not found"}, safe_path, t0, "Ruta GET inexistente")

    def _reject(self, status: int, data: dict, safe_path: str, t0: float, log_message: str):
        self._send_json_response(status, data)
        self._log_res(status, safe_path, (time.monotonic() - t0) * 1000, log_message)

    def _read_rpc_request(self, safe_path: str, t0: float) -> dict | None:
        """Lee y valida el cuerpo JSON-RPC; si no es válido responde y devuelve None."""
        try:
            content_len = int(self.headers.get("Content-Length"))
        except (TypeError, ValueError):
            self._log_req("POST", safe_path)
            self._reject(400, {"error": "Invalid Content-Length"}, safe_path, t0, "Content-Length inválido")
            return None
        if content_len < 0:
            self._log_req("POST", safe_path)
            self._reject(400, {"error": "Invalid Content-Length"}, safe_path, t0, "Content-Length negativo")
            return None
        is_blob_upload = self.headers.get("X-ZeroChat-Blob") == "1"
        body_limit = MAX_BLOB_HTTP_BYTES if is_blob_upload else http_body_limit()
        if content_len > body_limit:
            self._log_req("POST", safe_path)
            if content_len <= body_limit * 2:
                try:
                    self.rfile.read(content_len)
                except (OSError, ValueError):
                    pass
            self.close_connection = True
            self._reject(413, {"error": "Request body too large"}, safe_path, t0, "Cuerpo HTTP excede el límite")
            return None
        post_data = self.rfile.read(content_len)

        try:
            req = json.loads(post_data.decode("utf-8"))
        except Exception as err:
            self._log_req("POST", safe_path)
            self._reject(400, {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": f"Parse error: {err}"}},
                         safe_path, t0, f"Error parseando JSON: {err}")
            return None
        # El tope ampliado de http_body_limit es solo para la exportación de --prompt --export y la subida de blobs.
        if content_len > MAX_HTTP_BODY_BYTES and not (
            isinstance(req, dict) and req.get("method") in ("zerochat/run/export", "zerochat/blobs/put")
        ):
            self._log_req("POST", safe_path)
            self._reject(413, {"error": "Request body too large"}, safe_path, t0, "Cuerpo HTTP excede el límite")
            return None

        rpc_error = self._validate_rpc(req)
        if rpc_error:
            self._log_req("POST", safe_path)
            self._reject(400, {"error": rpc_error[0]}, safe_path, t0, rpc_error[1])
            return None
        return req

    @staticmethod
    def _validate_rpc(req) -> tuple[str, str] | None:
        """Devuelve (error público, detalle de log) si la petición no es JSON-RPC 2.0 válida."""
        if not isinstance(req, dict):
            return "Request must be a JSON object", "La solicitud JSON no es un objeto"
        req_id = req.get("id")
        method = req.get("method")
        params = req.get("params", {})
        if req.get("jsonrpc") != "2.0":
            return "Invalid JSON-RPC version", "Versión JSON-RPC inválida"
        if req_id is not None and (isinstance(req_id, bool) or not isinstance(req_id, (str, int, float))):
            return "Invalid JSON-RPC id", "id JSON-RPC inválido"
        if not isinstance(method, str) or not method or len(method) > MAX_RPC_METHOD_LENGTH:
            return "Invalid JSON-RPC method", "Método JSON-RPC inválido"
        if not isinstance(params, dict):
            return "Invalid JSON-RPC params", "params JSON-RPC inválidos"
        if method == "tools/call":
            tool_name = params.get("name")
            tool_args = params.get("arguments", {})
            if not isinstance(tool_name, str) or not tool_name or len(tool_name) > MAX_TOOL_NAME_LENGTH:
                return "Invalid tool name", "Nombre de herramienta inválido"
            if not isinstance(tool_args, dict):
                return "Invalid tool arguments", "Argumentos de herramienta inválidos"
            tool_args_error = validate_local_tool_arguments(tool_name, tool_args)
            if tool_args_error:
                return tool_args_error, tool_args_error
        return None

    def _serve_login(self, safe_path: str, t0: float) -> bool:
        """Sin token solo se atiende zerochat/login, con un cuerpo pequeño; devuelve False si la petición es otra."""
        try:
            content_len = int(self.headers.get("Content-Length"))
        except (TypeError, ValueError):
            return False
        if not 0 <= content_len <= LOGIN_MAX_BODY_BYTES:
            return False
        try:
            req = json.loads(self.rfile.read(content_len).decode("utf-8"))
        except ValueError:
            return False
        if self._validate_rpc(req) or req["method"] != "zerochat/login":
            return False
        log_detail = f"{safe_path} [rpc: zerochat/login]"
        self._log_req("POST", log_detail)
        self._send_rpc_response(req.get("id"), rpc_login(req.get("params", {})), log_detail, t0)
        return True

    def _send_rpc_response(self, req_id, outcome: tuple[dict | None, dict | None, str], log_detail: str, t0: float, quiet: bool = False):
        result, error, tool_error_info = outcome
        response_payload = {"jsonrpc": "2.0", "id": req_id}
        if error:
            response_payload["error"] = error
            error_info = f"[{error.get('code')}] {error.get('message')}"
        else:
            response_payload["result"] = result
            error_info = tool_error_info
        if self._send_json_response(200, response_payload) and not quiet:
            self._log_res(200, log_detail, (time.monotonic() - t0) * 1000, error_info=error_info)

    def _capture_browser_user_agent(self, grant):
        """Solo un navegador autenticado da el User-Agent real: el runner de Node manda el de su fetch ("node")."""
        if grant.kind != "runner":
            capture_frontend_user_agent(self.headers.get("User-Agent", ""))

    def do_POST(self):
        t0 = time.monotonic()
        safe_path = sanitize_log_path(self.path)
        if self._reject_dot_segment("POST", safe_path, t0):
            return
        origin = self.headers.get("Origin")
        if not is_allowed_origin(origin):
            self._log_req("POST", safe_path)
            self.send_response(403)
            self.end_headers()
            self._log_res(403, safe_path, (time.monotonic() - t0) * 1000, f"Origen no permitido: '{origin}'")
            return

        mark_browser_active()
        grant = self._resolve_grant()
        # Una ejecución solo atiende a su runner: ni el token diario ni sesiones remotas, ni zerochat/login.
        run = current_run_session() is not None
        if run and grant is not None and grant.kind != "runner":
            grant = None
        if grant is None:
            # Sin token válido solo cabe identificarse para obtenerlo, salvo en una ejecución.
            if not run and self._serve_login(safe_path, t0):
                return
            self._log_req("POST", safe_path)
            self._reject(401, {
                "jsonrpc": "2.0",
                "id": None,
                "error": {"code": -32000, "message": "Unauthorized: invalid or missing session token"}
            }, safe_path, t0, "Token de sesión ausente o inválido")
            return
        self._capture_browser_user_agent(grant)

        req = self._read_rpc_request(safe_path, t0)
        if req is None:
            return
        req_id = req.get("id")
        method = req["method"]
        params = req.get("params", {})

        if not grant.allows(method, params):
            self._log_req("POST", f"{safe_path} [rpc: {method}]")
            self._reject(403, {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -32000, "message": "Forbidden: method not permitted for this token"}
            }, safe_path, t0, f"Método '{method}' no permitido para el token ({grant.kind})")
            return

        # Etiqueta de seguimiento para la petición y respuesta (sin datos sensibles)
        action_tag = f"[tools/call: {params['name']}]" if method == "tools/call" else f"[rpc: {method}]"
        log_detail = f"{safe_path} {action_tag}"
        # Las consultas periódicas de la interfaz no se registran, como el latido. Un fallo suyo es
        # normal (por ejemplo, preguntar por un comando que el servidor aún no ha registrado).
        quiet = method in QUIET_RPC_METHODS
        if not quiet:
            self._log_req("POST", log_detail)

        if req_id is None and method.startswith("notifications/"):
            self.send_response(204)
            self.send_cors_headers()
            self.end_headers()
            self._log_res(204, log_detail, (time.monotonic() - t0) * 1000)
            return

        try:
            ctx = request_project_context(self.headers.get("X-ZeroChat-Project"), fallback=method == "initialize")
        except ProjectGoneError as ex:
            self._send_rpc_response(req_id, (None, {"code": PROJECT_GONE_CODE, "message": str(ex)}, ""), log_detail, t0, quiet)
            return
        try:
            outcome = dispatch_local(method, params, ctx)
        except Exception as ex:
            outcome = None, {"code": -32603, "message": f"Error interno: {ex}"}, ""
        self._send_rpc_response(req_id, outcome, log_detail, t0, quiet)

    def log_message(self, format, *args):
        # Silenciar logs ruidosos por defecto
        pass


class ZeroChatHTTPServer(ThreadingHTTPServer):
    """Servidor del backend con una cola de conexiones amplia: la interfaz en desarrollo y el runner de Node piden
    decenas de módulos a la vez, y con la cola de 5 por defecto macOS descarta las que sobran (el cliente agota el
    plazo de conexión) y Windows las reinicia."""
    request_queue_size = 128

    def server_bind(self):
        """Como HTTPServer.server_bind, sin socket.getfqdn: su resolución inversa del host puede tardar decenas de
        segundos (en macOS sin DNS inverso, ~35 s) y el nombre del servidor no se usa."""
        socketserver.TCPServer.server_bind(self)
        host, port = self.server_address[:2]
        self.server_name = str(host)
        self.server_port = port

