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
                log_event(f"Tiempo de espera del navegador agotado ({initial_grace_seconds:.0f}s). Deteniendo servidor ZeroChat...")
                stop_zerochat_server(server)
                break
            continue

        # 2. Inactividad tras haber recibido latidos
        if now - HEARTBEAT_LAST_SEEN > inactivity_timeout_seconds:
            log_event("Navegador desconectado (cierre detectado). Deteniendo servidor ZeroChat...")
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
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization, X-ZeroChat-Token, X-ZeroChat-Client, X-ZeroChat-Tool-Session, X-ZeroChat-Tool-Expires, X-ZeroChat-Tool-Nonce, X-ZeroChat-Tool-Signature")
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

    def verify_tool_authorization(self, body: bytes, request_path: str) -> str | None:
        """Validate and atomically consume an authorization for one tool call."""
        session_id = self.headers.get("X-ZeroChat-Tool-Session", "")
        expires_raw = self.headers.get("X-ZeroChat-Tool-Expires", "")
        nonce = self.headers.get("X-ZeroChat-Tool-Nonce", "")
        signature = self.headers.get("X-ZeroChat-Tool-Signature", "")
        if (not isinstance(session_id, str) or len(session_id) > 128 or
                not isinstance(nonce, str) or not re.fullmatch(r"[A-Za-z0-9_-]{22,128}", nonce) or
                not isinstance(signature, str) or not re.fullmatch(r"[A-Za-z0-9_-]{43,128}", signature)):
            return "Missing or invalid tool authorization"
        try:
            expires_at = int(expires_raw)
        except (TypeError, ValueError):
            return "Missing or invalid tool authorization"
        now_ms = int(time.time() * 1000)
        if session_id != TOOL_AUTH_SESSION_ID or expires_at < now_ms or expires_at > now_ms + TOOL_AUTH_TTL_MS:
            return "Expired or invalid tool authorization"
        body_hash = hashlib.sha256(body).hexdigest()
        signature_base = json.dumps(
            [TOOL_AUTH_VERSION, session_id, "POST", request_path or "/", expires_at, nonce, body_hash],
            separators=(",", ":"), ensure_ascii=True
        ).encode("utf-8")
        expected = base64.urlsafe_b64encode(hmac.new(TOOL_AUTH_KEY, signature_base, hashlib.sha256).digest()).rstrip(b"=").decode("ascii")
        if not hmac.compare_digest(signature, expected):
            return "Invalid tool authorization signature"
        with TOOL_AUTH_NONCES_LOCK:
            for value, expiry in list(TOOL_AUTH_NONCES.items()):
                if expiry < now_ms:
                    del TOOL_AUTH_NONCES[value]
            if nonce in TOOL_AUTH_NONCES:
                return "Tool authorization was already used"
            if len(TOOL_AUTH_NONCES) >= TOOL_AUTH_MAX_NONCES:
                return "Tool authorization cache is full"
            TOOL_AUTH_NONCES[nonce] = expires_at
        return None

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

        # Browsers request this optional public resource without API credentials.
        if path_clean == "/favicon.ico":
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        if not is_heartbeat:
            self._log_req("GET", safe_path)

        if not self.verify_token():
            self._reject(401, {"error": "Unauthorized: invalid or missing session token"}, safe_path, t0, "Token de sesión ausente o inválido")
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

        self._send_json_response(200, {
            "status": "active",
            "server": "ZeroChat Local Server",
            "version": VERSION,
            "cwd": str(Path.cwd().resolve()),
            "tools_count": len(LOCAL_TOOLS_DEFINITIONS),
            "browser_action": browser_action_availability(),
            "os": DETECTED_OS
        })
        self._log_res(200, safe_path, (time.monotonic() - t0) * 1000)

    def _reject(self, status: int, data: dict, safe_path: str, t0: float, log_message: str):
        self._send_json_response(status, data)
        self._log_res(status, safe_path, (time.monotonic() - t0) * 1000, log_message)

    def _read_rpc_request(self, safe_path: str, t0: float) -> tuple[dict, bytes] | None:
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
        if content_len > MAX_HTTP_BODY_BYTES:
            self._log_req("POST", safe_path)
            if content_len <= MAX_HTTP_BODY_BYTES * 2:
                try:
                    self.rfile.read(content_len)
                except Exception:
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

        rpc_error = self._validate_rpc(req)
        if rpc_error:
            self._log_req("POST", safe_path)
            self._reject(400, {"error": rpc_error[0]}, safe_path, t0, rpc_error[1])
            return None
        return req, post_data

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

    @staticmethod
    def _initialize_result(server_info: dict) -> dict:
        return {
            "protocolVersion": "2024-11-05",
            "serverInfo": server_info,
            "capabilities": {
                "tools": {"listChanged": True}
            },
            "toolAuthorization": {
                "version": TOOL_AUTH_VERSION,
                "sessionId": TOOL_AUTH_SESSION_ID,
                "key": base64.urlsafe_b64encode(TOOL_AUTH_KEY).rstrip(b"=").decode("ascii"),
                "ttlMs": TOOL_AUTH_TTL_MS
            }
        }

    @staticmethod
    def _tool_exception_result(ex: Exception) -> dict:
        return {"content": [{"type": "text", "text": _tool_error(str(ex))}], "isError": True}

    def _dispatch_external(self, method: str, params: dict) -> tuple[dict | None, dict | None, str]:
        """Atiende /mcp/external. Devuelve (result, error JSON-RPC, detalle de error de herramienta)."""
        if method == "initialize":
            return self._initialize_result({"name": "ZeroChat External MCP Host", "version": VERSION}), None, ""
        if method == "tools/list":
            return {"tools": GLOBAL_MCP_MANAGER.tools()}, None, ""
        if method == "tools/call":
            try:
                result = GLOBAL_MCP_MANAGER.call(params["name"], params.get("arguments", {}))
            except Exception as ex:
                return self._tool_exception_result(ex), None, str(ex)
            tool_error_info = ""
            if isinstance(result, dict) and result.get("isError"):
                c_list = result.get("content", [])
                if c_list and isinstance(c_list, list) and isinstance(c_list[0], dict):
                    tool_error_info = c_list[0].get("text", "Error en herramienta MCP externa")
                else:
                    tool_error_info = "Error en herramienta MCP externa"
            return result, None, tool_error_info
        return None, {"code": -32601, "message": f"Método '{method}' no soportado en /mcp/external."}, ""

    def _dispatch_local(self, method: str, params: dict) -> tuple[dict | None, dict | None, str]:
        """Atiende el endpoint local. Devuelve (result, error JSON-RPC, detalle de error de herramienta)."""
        if method == "initialize":
            server_info = {
                "name": "ZeroChat Local Server",
                "version": VERSION,
                "cwd": str(Path.cwd().resolve()),
                "os": DETECTED_OS
            }
            return self._initialize_result(server_info), None, ""
        if method == "tools/list":
            browser_availability = browser_action_availability()
            tools = []
            for definition in LOCAL_TOOLS_DEFINITIONS:
                item = dict(definition)
                if item.get("name") == "browser_action":
                    item["availability"] = browser_availability
                tools.append(item)
            return {"tools": tools}, None, ""
        if method == "tools/availability":
            if params.get("name", "") != "browser_action":
                return None, {"code": -32602, "message": "Herramienta no compatible con comprobación de disponibilidad."}, ""
            return browser_action_availability(), None, ""
        if method == "tools/call":
            tool_name = params["name"]
            handler = LOCAL_TOOL_HANDLERS.get(tool_name)
            if not handler:
                return None, {"code": -32601, "message": f"Herramienta local '{tool_name}' no encontrada."}, ""
            try:
                tool_output_json = handler(**params.get("arguments", {}))
            except Exception as ex:
                return self._tool_exception_result(ex), None, str(ex)
            tool_error_info = ""
            try:
                parsed_out = json.loads(tool_output_json)
                if isinstance(parsed_out, dict) and parsed_out.get("success") is False:
                    tool_error_info = str(parsed_out.get("error", "Error en herramienta local"))
            except Exception:
                pass
            return {"content": [{"type": "text", "text": tool_output_json}], "isError": bool(tool_error_info)}, None, tool_error_info
        if method == "zerochat/external/status":
            return {"host": "running", "version": VERSION, "servers": GLOBAL_MCP_MANAGER.list_servers()}, None, ""
        if method in ("zerochat/external/servers/start", "zerochat/external/servers/stop", "zerochat/external/servers/configure"):
            return self._dispatch_server_control(method, params)
        return None, {"code": -32601, "message": f"Método '{method}' no soportado."}, ""

    @staticmethod
    def _dispatch_server_control(method: str, params: dict) -> tuple[dict | None, dict | None, str]:
        server_id = params.get("serverId")
        opts = params.get("options", {})
        if not isinstance(server_id, str) or not server_id:
            return None, {"code": -32602, "message": "serverId debe ser un texto no vacío."}, ""
        if not isinstance(opts, dict):
            return None, {"code": -32602, "message": "options debe ser un objeto."}, ""
        try:
            if method.endswith("/start"):
                servers = GLOBAL_MCP_MANAGER.start(server_id)
            elif method.endswith("/stop"):
                servers = GLOBAL_MCP_MANAGER.stop(server_id)
            else:
                servers = GLOBAL_MCP_MANAGER.configure(server_id, opts)
        except KeyError as exc:
            return None, {"code": -32602, "message": str(exc.args[0]) if exc.args else str(exc)}, ""
        return {"servers": servers}, None, ""

    def do_POST(self):
        t0 = time.monotonic()
        safe_path = sanitize_log_path(self.path)
        req_path = self.path.split("?", 1)[0].rstrip("/")
        origin = self.headers.get("Origin")
        if not is_allowed_origin(origin):
            self._log_req("POST", safe_path)
            self.send_response(403)
            self.end_headers()
            self._log_res(403, safe_path, (time.monotonic() - t0) * 1000, f"Origen no permitido: '{origin}'")
            return

        if not self.verify_token():
            self._log_req("POST", safe_path)
            self._reject(401, {
                "jsonrpc": "2.0",
                "id": None,
                "error": {"code": -32000, "message": "Unauthorized: invalid or missing session token"}
            }, safe_path, t0, "Token de sesión ausente o inválido")
            return

        parsed = self._read_rpc_request(safe_path, t0)
        if parsed is None:
            return
        req, post_data = parsed
        req_id = req.get("id")
        method = req["method"]
        params = req.get("params", {})

        if method == "tools/call":
            auth_error = self.verify_tool_authorization(post_data, req_path or "/")
            if auth_error:
                self._log_req("POST", safe_path)
                self._reject(403, {"error": auth_error}, safe_path, t0, auth_error)
                return

        # Etiqueta de seguimiento para la petición y respuesta (sin datos sensibles)
        action_tag = f"[tools/call: {params['name']}]" if method == "tools/call" else f"[rpc: {method}]"
        log_detail = f"{safe_path} {action_tag}"
        self._log_req("POST", log_detail)

        if req_id is None and method.startswith("notifications/"):
            self.send_response(204)
            self.send_cors_headers()
            self.end_headers()
            self._log_res(204, log_detail, (time.monotonic() - t0) * 1000)
            return

        try:
            if "/mcp/external" in req_path:
                result, error, tool_error_info = self._dispatch_external(method, params)
            else:
                result, error, tool_error_info = self._dispatch_local(method, params)
        except Exception as ex:
            result, tool_error_info = None, ""
            error = {"code": -32603, "message": f"Error interno: {ex}"}

        response_payload = {"jsonrpc": "2.0", "id": req_id}
        if error:
            response_payload["error"] = error
            error_info = f"[{error.get('code')}] {error.get('message')}"
        else:
            response_payload["result"] = result
            error_info = tool_error_info

        if self._send_json_response(200, response_payload):
            self._log_res(200, log_detail, (time.monotonic() - t0) * 1000, error_info=error_info)

    def log_message(self, format, *args):
        # Silenciar logs ruidosos por defecto
        pass
