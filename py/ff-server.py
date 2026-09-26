DEFAULT_HEARTBEAT_TIMEOUT = float(os.environ.get("ZEROCHAT_HEARTBEAT_TIMEOUT", "60.0"))
DEFAULT_HEARTBEAT_GRACE = float(os.environ.get("ZEROCHAT_HEARTBEAT_GRACE", "45.0"))
DEFAULT_HEARTBEAT_POLL = float(os.environ.get("ZEROCHAT_HEARTBEAT_POLL", "5.0"))
HEARTBEAT_LAST_SEEN = 0.0
HEARTBEAT_INITIALIZED = False
HEARTBEAT_WATCHDOG_STOP = threading.Event()
_SERVER_SHUTTING_DOWN = threading.Event()


def mark_browser_active():
    """Registra la presencia activa del navegador ante cualquier petición válida."""
    global HEARTBEAT_LAST_SEEN, HEARTBEAT_INITIALIZED
    HEARTBEAT_LAST_SEEN = time.monotonic()
    HEARTBEAT_INITIALIZED = True


def stop_zerochat_server(server: ThreadingHTTPServer):
    """Detiene limpiamente el servidor y todos los subsistemas evitando reentradas."""
    if _SERVER_SHUTTING_DOWN.is_set():
        return
    _SERVER_SHUTTING_DOWN.set()
    HEARTBEAT_WATCHDOG_STOP.set()
    GLOBAL_MCP_MANAGER.close()
    threading.Thread(target=server.shutdown, daemon=True).start()


def heartbeat_watchdog(server: ThreadingHTTPServer, initial_grace_seconds: float = DEFAULT_HEARTBEAT_GRACE, inactivity_timeout_seconds: float = DEFAULT_HEARTBEAT_TIMEOUT, require_initial_connection: bool = True):
    """
    Supervisa la presencia de la pestaña del navegador mediante latidos HTTP.
    Si el navegador se cierra o deja de emitir latidos, detiene el servidor automáticamente.
    """
    start_time = time.monotonic()
    poll_interval = min(DEFAULT_HEARTBEAT_POLL, max(0.02, inactivity_timeout_seconds / 2))
    while not HEARTBEAT_WATCHDOG_STOP.is_set():
        if HEARTBEAT_WATCHDOG_STOP.wait(timeout=poll_interval):
            break

        now = time.monotonic()

        # 1. Periodo de gracia inicial (solo si zerochat abrió el navegador)
        if not HEARTBEAT_INITIALIZED:
            if require_initial_connection and (now - start_time > initial_grace_seconds):
                console_log(f"[{time.strftime('%H:%M:%S')}] Tiempo de espera del navegador agotado ({initial_grace_seconds:.0f}s). Deteniendo servidor ZeroChat...", flush=True)
                stop_zerochat_server(server)
                break
            continue

        # 2. Inactividad tras haber recibido latidos
        if now - HEARTBEAT_LAST_SEEN > inactivity_timeout_seconds:
            console_log(f"[{time.strftime('%H:%M:%S')}] Navegador desconectado (cierre detectado). Deteniendo servidor ZeroChat...", flush=True)
            stop_zerochat_server(server)
            break


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
        now = time.strftime("%H:%M:%S")
        console_log(f"[{now}] --> {method} {detail}", flush=True)

    def _log_res(self, status: int, detail: str, duration_ms: float, error_info: str = ""):
        now = time.strftime("%H:%M:%S")
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
        console_log(f"[{now}] <-- {status_text} {detail}{err_suffix} ({duration_ms:.1f}ms)", flush=True)

    def serve_static_file(self, rel_path: str) -> bool:
        """Sirve recursos estáticos solo desde el repositorio de desarrollo."""
        static_root = get_static_root()
        if not static_root:
            return False

        clean_rel = rel_path.split("?", 1)[0].lstrip("/")
        if not clean_rel:
            return False

        target_path = (static_root / clean_rel).resolve()
        try:
            rel_parts = target_path.relative_to(static_root.resolve()).parts
        except ValueError:
            return False

        # Whitelist de archivos y carpetas autorizados para servir la interfaz web
        is_allowed_static = (
            clean_rel == "zerochat.html" or
            clean_rel in ("manifest.webmanifest", "sw.js", "favicon.ico") or
            clean_rel.startswith("js/") or
            clean_rel.startswith("css/") or
            clean_rel.startswith("help/")
        )
        if not is_allowed_static:
            return False

        # Protección: bloquear archivos ocultos, datos y dependencias locales.
        for part in rel_parts:
            if part.startswith(".") and part != ".":
                return False
            if part in ("zerochat", "node_modules", ".git", "tests"):
                return False

        if not target_path.is_file():
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
        if clean_rel == "sw.js":
            self.send_header("Service-Worker-Allowed", "/")
        self.send_cors_headers()
        self.end_headers()
        self.wfile.write(data)
        return True

    def send_cors_headers(self):
        origin = self.headers.get("Origin")
        if not is_allowed_origin(origin, require_origin=True):
            return
        self.send_header("Access-Control-Allow-Origin", origin if origin else "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization, X-ZeroChat-Token, X-ZeroChat-Client")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def verify_token(self) -> bool:
        """Comprueba el token de sesión exclusivamente en cabeceras HTTP."""
        auth_header = self.headers.get("Authorization", "")
        token_candidate = None
        if auth_header.startswith("Bearer "):
            token_candidate = auth_header[7:].strip()
        elif "X-ZeroChat-Token" in self.headers:
            token_candidate = self.headers.get("X-ZeroChat-Token", "").strip()

        if not token_candidate:
            return False
        is_valid = hmac.compare_digest(token_candidate, SESSION_TOKEN)
        if is_valid:
            mark_browser_active()
        return is_valid

    def do_OPTIONS(self):
        t0 = time.monotonic()
        safe_path = sanitize_log_path(self.path)
        path_clean = self.path.split("?", 1)[0].rstrip("/")
        is_heartbeat = path_clean == "/zerochat/heartbeat"
        if not is_heartbeat:
            self._log_req("OPTIONS", safe_path)
        origin = self.headers.get("Origin")
        if not is_allowed_origin(origin, require_origin=True):
            self.send_response(403)
            self.end_headers()
            self._log_res(403, safe_path, (time.monotonic() - t0) * 1000, f"Origen no permitido: '{origin}'")
            return
        self.send_response(204)
        self.send_cors_headers()
        self.end_headers()
        if not is_heartbeat:
            self._log_res(204, safe_path, (time.monotonic() - t0) * 1000)

    def _send_json_response(self, status: int, data: dict):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        t0 = time.monotonic()
        safe_path = sanitize_log_path(self.path)
        path_clean = self.path.split("?", 1)[0].rstrip("/")
        is_heartbeat = path_clean == "/zerochat/heartbeat"

        origin = self.headers.get("Origin")
        if not is_allowed_origin(origin):
            if not is_heartbeat:
                self._log_req("GET", safe_path)
            self.send_response(403)
            self.end_headers()
            self._log_res(403, safe_path, (time.monotonic() - t0) * 1000, f"Origen no permitido: '{origin}'")
            return

        # Servir archivos estáticos del repositorio si estamos en entorno de desarrollo
        if path_clean and self.serve_static_file(path_clean):
            self._log_req("GET", safe_path)
            self._log_res(200, safe_path, (time.monotonic() - t0) * 1000)
            return

        if not is_heartbeat:
            self._log_req("GET", safe_path)

        if not self.verify_token():
            err_msg = json.dumps({"error": "Unauthorized: invalid or missing session token"}).encode("utf-8")
            self.send_response(401)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(err_msg)))
            self.send_cors_headers()
            self.end_headers()
            self.wfile.write(err_msg)
            self._log_res(401, safe_path, (time.monotonic() - t0) * 1000, "Token de sesión ausente o inválido")
            return

        if is_heartbeat:
            mark_browser_active()
            self._send_json_response(200, {"ok": True})
            return

        accept = self.headers.get("Accept", "")
        if "/sse" in self.path or "text/event-stream" in accept:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.send_cors_headers()
            self.end_headers()
            endpoint_data = b"/mcp/external" if "/mcp/external" in self.path else b"/"
            self.wfile.write(b"event: endpoint\r\ndata: " + endpoint_data + b"\r\n\r\n")
            self.wfile.flush()
            self._log_res(200, f"{safe_path} [SSE canal activo]", (time.monotonic() - t0) * 1000)
            return

        # Status general
        res_data = json.dumps({
            "status": "active",
            "server": "ZeroChat Local Server",
            "version": VERSION,
            "tools_count": len(LOCAL_TOOLS_DEFINITIONS),
            "browser_action": browser_action_availability(),
            "os": DETECTED_OS
        }, ensure_ascii=False, indent=2).encode("utf-8")

        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(res_data)))
        self.send_cors_headers()
        self.end_headers()
        self.wfile.write(res_data)
        self._log_res(200, safe_path, (time.monotonic() - t0) * 1000)

    def do_POST(self):
        t0 = time.monotonic()
        safe_path = sanitize_log_path(self.path)
        origin = self.headers.get("Origin")
        if not is_allowed_origin(origin):
            self._log_req("POST", safe_path)
            self.send_response(403)
            self.end_headers()
            self._log_res(403, safe_path, (time.monotonic() - t0) * 1000, f"Origen no permitido: '{origin}'")
            return

        if not self.verify_token():
            self._log_req("POST", safe_path)
            err_msg = json.dumps({
                "jsonrpc": "2.0",
                "id": None,
                "error": {"code": -32000, "message": "Unauthorized: invalid or missing session token"}
            }).encode("utf-8")
            self.send_response(401)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(err_msg)))
            self.send_cors_headers()
            self.end_headers()
            self.wfile.write(err_msg)
            self._log_res(401, safe_path, (time.monotonic() - t0) * 1000, "Token de sesión ausente o inválido")
            return

        raw_content_len = self.headers.get("Content-Length")
        try:
            content_len = int(raw_content_len)
        except (TypeError, ValueError):
            self._log_req("POST", safe_path)
            self._send_json_response(400, {"error": "Invalid Content-Length"})
            self._log_res(400, safe_path, (time.monotonic() - t0) * 1000, "Content-Length inválido")
            return
        if content_len < 0:
            self._log_req("POST", safe_path)
            self._send_json_response(400, {"error": "Invalid Content-Length"})
            self._log_res(400, safe_path, (time.monotonic() - t0) * 1000, "Content-Length negativo")
            return
        if content_len > MAX_HTTP_BODY_BYTES:
            self._log_req("POST", safe_path)
            if content_len <= MAX_HTTP_BODY_BYTES * 2:
                try:
                    self.rfile.read(content_len)
                except Exception:
                    pass
            self.close_connection = True
            self._send_json_response(413, {"error": "Request body too large"})
            self._log_res(413, safe_path, (time.monotonic() - t0) * 1000, "Cuerpo HTTP excede el límite")
            return
        post_data = self.rfile.read(content_len)

        try:
            req = json.loads(post_data.decode("utf-8"))
        except Exception as err:
            self._log_req("POST", safe_path)
            err_resp = json.dumps({
                "jsonrpc": "2.0",
                "id": None,
                "error": {"code": -32700, "message": f"Parse error: {str(err)}"}
            }).encode("utf-8")
            self.send_response(400)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_cors_headers()
            self.end_headers()
            self.wfile.write(err_resp)
            self._log_res(400, safe_path, (time.monotonic() - t0) * 1000, f"Error parseando JSON: {err}")
            return

        if not isinstance(req, dict):
            self._send_json_response(400, {"error": "Request must be a JSON object"})
            self._log_res(400, safe_path, (time.monotonic() - t0) * 1000, "La solicitud JSON no es un objeto")
            return

        req_id = req.get("id")
        method = req.get("method")
        params = req.get("params", {})
        if req.get("jsonrpc") != "2.0":
            self._send_json_response(400, {"error": "Invalid JSON-RPC version"})
            self._log_res(400, safe_path, (time.monotonic() - t0) * 1000, "Versión JSON-RPC inválida")
            return
        if req_id is not None and (isinstance(req_id, bool) or not isinstance(req_id, (str, int, float))):
            self._send_json_response(400, {"error": "Invalid JSON-RPC id"})
            self._log_res(400, safe_path, (time.monotonic() - t0) * 1000, "id JSON-RPC inválido")
            return
        if not isinstance(method, str) or not method or len(method) > MAX_RPC_METHOD_LENGTH:
            self._send_json_response(400, {"error": "Invalid JSON-RPC method"})
            self._log_res(400, safe_path, (time.monotonic() - t0) * 1000, "Método JSON-RPC inválido")
            return
        if not isinstance(params, dict):
            self._send_json_response(400, {"error": "Invalid JSON-RPC params"})
            self._log_res(400, safe_path, (time.monotonic() - t0) * 1000, "params JSON-RPC inválidos")
            return

        if method == "tools/call":
            tool_name = params.get("name")
            tool_args = params.get("arguments", {})
            if not isinstance(tool_name, str) or not tool_name or len(tool_name) > MAX_TOOL_NAME_LENGTH:
                self._send_json_response(400, {"error": "Invalid tool name"})
                self._log_res(400, safe_path, (time.monotonic() - t0) * 1000, "Nombre de herramienta inválido")
                return
            if not isinstance(tool_args, dict):
                self._send_json_response(400, {"error": "Invalid tool arguments"})
                self._log_res(400, safe_path, (time.monotonic() - t0) * 1000, "Argumentos de herramienta inválidos")
                return
            tool_args_error = validate_local_tool_arguments(tool_name, tool_args)
            if tool_args_error:
                self._send_json_response(400, {"error": tool_args_error})
                self._log_res(400, safe_path, (time.monotonic() - t0) * 1000, tool_args_error)
                return

        req_path = self.path.split("?", 1)[0].rstrip("/")

        # Determinar etiqueta de seguimiento para la petición y respuesta (sin datos sensibles)
        tool_name = params.get("name", "") if isinstance(params, dict) else ""
        if method == "tools/call" and tool_name:
            action_tag = f"[tools/call: {tool_name}]"
        elif method:
            action_tag = f"[rpc: {method}]"
        elif req_path.startswith("/zerochat/external/servers/"):
            action_tag = f"[REST: {req_path}]"
        else:
            action_tag = f"[{safe_path}]"

        self._log_req("POST", f"{safe_path} {action_tag}")

        if req_id is None and (method or "").startswith("notifications/"):
            self.send_response(204)
            self.send_cors_headers()
            self.end_headers()
            self._log_res(204, f"{safe_path} {action_tag}", (time.monotonic() - t0) * 1000)
            return

        result = None
        error = None
        tool_error_info = ""
        is_external_endpoint = "/mcp/external" in req_path

        if is_external_endpoint:
            if method == "initialize":
                result = {
                    "protocolVersion": "2024-11-05",
                    "serverInfo": {
                        "name": "ZeroChat External MCP Host",
                        "version": VERSION
                    },
                    "capabilities": {
                        "tools": {"listChanged": True}
                    }
                }
            elif method == "tools/list":
                result = {"tools": GLOBAL_MCP_MANAGER.tools()}
            elif method == "tools/call":
                tool_name = params.get("name", "") if isinstance(params, dict) else ""
                tool_args = params.get("arguments", {}) if isinstance(params, dict) else {}
                try:
                    result = GLOBAL_MCP_MANAGER.call(tool_name, tool_args)
                    if isinstance(result, dict) and result.get("isError"):
                        c_list = result.get("content", [])
                        if c_list and isinstance(c_list, list) and isinstance(c_list[0], dict):
                            tool_error_info = c_list[0].get("text", "Error en herramienta MCP externa")
                        else:
                            tool_error_info = "Error en herramienta MCP externa"
                except Exception as ex:
                    tool_error_info = str(ex)
                    result = {
                        "content": [{"type": "text", "text": json.dumps({"success": False, "error": str(ex)}, ensure_ascii=False)}],
                        "isError": True
                    }
            else:
                error = {"code": -32601, "message": f"Método '{method}' no soportado en /mcp/external."}
        else:
            if method == "initialize":
                result = {
                    "protocolVersion": "2024-11-05",
                    "serverInfo": {
                        "name": "ZeroChat Local Server",
                        "version": VERSION
                    },
                    "capabilities": {
                        "tools": {"listChanged": True}
                    }
                }
            elif method == "tools/list":
                browser_availability = browser_action_availability()
                tools = []
                for definition in LOCAL_TOOLS_DEFINITIONS:
                    item = dict(definition)
                    if item.get("name") == "browser_action":
                        item["availability"] = browser_availability
                    tools.append(item)
                result = {"tools": tools}
            elif method == "tools/availability":
                requested_name = params.get("name", "") if isinstance(params, dict) else ""
                if requested_name != "browser_action":
                    error = {"code": -32602, "message": "Herramienta no compatible con comprobación de disponibilidad."}
                else:
                    result = browser_action_availability()
            elif method == "tools/call":
                tool_name = params.get("name", "") if isinstance(params, dict) else ""
                tool_args = params.get("arguments", {}) if isinstance(params, dict) else {}

                if tool_name in LOCAL_TOOL_HANDLERS:
                    handler = LOCAL_TOOL_HANDLERS[tool_name]
                    try:
                        tool_output_json = handler(**tool_args)
                        is_tool_err = False
                        try:
                            parsed_out = json.loads(tool_output_json)
                            if isinstance(parsed_out, dict) and parsed_out.get("success") is False:
                                is_tool_err = True
                                tool_error_info = str(parsed_out.get("error", "Error en herramienta local"))
                        except Exception:
                            pass

                        result = {
                            "content": [{"type": "text", "text": tool_output_json}],
                            "isError": is_tool_err
                        }
                    except Exception as ex:
                        tool_error_info = str(ex)
                        result = {
                            "content": [{"type": "text", "text": json.dumps({"success": False, "error": str(ex)}, ensure_ascii=False)}],
                            "isError": True
                        }
                elif tool_name.startswith("mcp_"):
                    try:
                        result = GLOBAL_MCP_MANAGER.call(tool_name, tool_args)
                        if isinstance(result, dict) and result.get("isError"):
                            c_list = result.get("content", [])
                            if c_list and isinstance(c_list, list) and isinstance(c_list[0], dict):
                                tool_error_info = c_list[0].get("text", "Error en herramienta MCP")
                            else:
                                tool_error_info = "Error en herramienta MCP"
                    except Exception as ex:
                        tool_error_info = str(ex)
                        result = {
                            "content": [{"type": "text", "text": json.dumps({"success": False, "error": str(ex)}, ensure_ascii=False)}],
                            "isError": True
                        }
                else:
                    error = {"code": -32601, "message": f"Herramienta local '{tool_name}' no encontrada."}
            elif method == "zerochat/external/status":
                result = {
                    "host": "running",
                    "version": VERSION,
                    "servers": GLOBAL_MCP_MANAGER.list_servers()
                }
            elif method == "zerochat/external/servers/start":
                server_id = params.get("serverId") or req.get("serverId")
                servers = GLOBAL_MCP_MANAGER.start(server_id)
                result = {"servers": servers}
            elif method == "zerochat/external/servers/stop":
                server_id = params.get("serverId") or req.get("serverId")
                servers = GLOBAL_MCP_MANAGER.stop(server_id)
                result = {"servers": servers}
            elif method == "zerochat/external/servers/configure":
                server_id = params.get("serverId") or req.get("serverId")
                opts = params.get("options") or req.get("options", {})
                servers = GLOBAL_MCP_MANAGER.configure(server_id, opts)
                result = {"servers": servers}
            else:
                error = {"code": -32601, "message": f"Método '{method}' no soportado."}

        response_payload = {"jsonrpc": "2.0", "id": req_id}
        error_info = ""
        if error:
            response_payload["error"] = error
            error_info = f"[{error.get('code')}] {error.get('message')}"
        else:
            response_payload["result"] = result
            if tool_error_info:
                error_info = tool_error_info

        resp_bytes = json.dumps(response_payload, ensure_ascii=False).encode("utf-8")

        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(resp_bytes)))
        self.send_cors_headers()
        self.end_headers()
        self.wfile.write(resp_bytes)
        self._log_res(200, f"{safe_path} {action_tag}", (time.monotonic() - t0) * 1000, error_info=error_info)

    def log_message(self, format, *args):
        # Silenciar logs ruidosos por defecto
        pass
