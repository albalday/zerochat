DEFAULT_HEARTBEAT_TIMEOUT = float(os.environ.get("ZEROCHAT_HEARTBEAT_TIMEOUT", "60.0"))
DEFAULT_HEARTBEAT_GRACE = float(os.environ.get("ZEROCHAT_HEARTBEAT_GRACE", "45.0"))
DEFAULT_HEARTBEAT_POLL = float(os.environ.get("ZEROCHAT_HEARTBEAT_POLL", "5.0"))
HEARTBEAT_LAST_SEEN = 0.0
HEARTBEAT_INITIALIZED = False
HEARTBEAT_WATCHDOG_STOP = threading.Event()
_SERVER_SHUTTING_DOWN = threading.Event()
# Si el servidor se detiene al cerrar el navegador, cerrar la pestaña detiene también los comandos.
EXIT_ON_CLOSE = False
# zerochat/run/progress ya se registra con su propio texto en dispatch_run.
QUIET_RPC_METHODS = frozenset({"zerochat/heartbeat", "zerochat/jobs/get", "zerochat/jobs/log", "zerochat/jobs/list", "zerochat/run/progress"})


def mark_browser_active():
    """Registra la presencia del navegador ante cualquier petición de un origen permitido, aunque su
    token haya caducado: el auto-cierre no detiene el servidor ni sus comandos al cambiar el día."""
    global HEARTBEAT_LAST_SEEN, HEARTBEAT_INITIALIZED
    HEARTBEAT_LAST_SEEN = time.monotonic()
    HEARTBEAT_INITIALIZED = True


def live_state(focus_conversation_id: str | None = None) -> dict:
    """
    Estado del servidor que la interfaz sigue en vivo, en initialize y en cada zerochat/heartbeat:
    cwd, para notar que otra pestaña ha cambiado el directorio del proyecto; jobs, los comandos en
    marcha, para mostrarlos y avisar antes de cerrar si se detendrían; exit_on_close; playwright, si
    se puede navegar aunque se haya instalado o quitado durante la sesión; servers, los servicios
    MCP externos aunque otra pestaña los cambie o su proceso muera; runs, lista ligera de ejecuciones
    en segundo plano; y focus_run, estado detallado de la ejecución enfocada por el usuario.
    """
    runs, focus_run = list_server_runs(focus_conversation_id)
    return {
        "cwd": str(Path.cwd().resolve()),
        "jobs": [job.summary() for job in JOBS.running()],
        "exit_on_close": EXIT_ON_CLOSE,
        "playwright": playwright_status(),
        "servers": GLOBAL_MCP_MANAGER.list_servers(),
        "runs": runs,
        "focus_run": focus_run
    }


def stop_zerochat_server(server: ThreadingHTTPServer):
    """Detiene limpiamente el servidor y todos los subsistemas evitando reentradas."""
    if _SERVER_SHUTTING_DOWN.is_set():
        return
    _SERVER_SHUTTING_DOWN.set()
    HEARTBEAT_WATCHDOG_STOP.set()
    running = JOBS.running()
    if running:
        console_log(timestamp_message(f"Deteniendo {len(running)} comando(s) en marcha: " + ", ".join(job.command[:60] for job in running)))
    JOBS.stop_all("shutdown")
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
            runs, _ = list_server_runs()
            if any(r.get("status") == "running" for r in runs):
                continue
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

METADATA_HOSTS = frozenset({
    "169.254.169.254",
    "metadata.google.internal",
    "instance-data",
    "100.100.100.200",
})
DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
# El User-Agent activo se sustituye por el de la primera petición del frontend (variabilidad de
# fingerprint); sin frontend (--prompt/--conversation) se queda el valor por defecto.
ACTIVE_USER_AGENT = DEFAULT_USER_AGENT


def capture_frontend_user_agent(user_agent: str) -> None:
    """Adopta el User-Agent de la primera petición del frontend como User-Agent de las salidas web."""
    global ACTIVE_USER_AGENT
    if ACTIVE_USER_AGENT is DEFAULT_USER_AGENT and isinstance(user_agent, str) and user_agent.strip():
        ACTIVE_USER_AGENT = user_agent.strip()
        set_service_user_agent(ACTIVE_USER_AGENT)


# Los motores propios de Playwright arrancan con el User-Agent por defecto hasta que el
# frontend fija el suyo en la primera petición.
set_service_user_agent(DEFAULT_USER_AGENT)
WEB_FETCH_MAX_BYTES = 10 * 1024 * 1024
WEB_FETCH_MAX_REDIRECTS = 5
WEB_FETCH_READ_CHUNK = 64 * 1024
TEXT_CONTENT_TYPE_RE = re.compile(
    r"^(text/|application/(json|xml|xhtml\+xml|javascript|x-javascript|ecmascript)$|[a-z]+/[^;]*\+(json|xml)$)"
)
# Control de cadencia frente a retos anti-bot: mínimo WEB_FETCH_MIN_GAP_S desde la RESPUESTA
# anterior al mismo host; las peticiones en paralelo se escalonan de WEB_FETCH_PARALLEL_STAGGER_S
# en WEB_FETCH_PARALLEL_STAGGER_S para que no coincidan. El timestamp se inicializa al arrancar
# para que la primera petición espere aunque no se haya hecho ninguna antes.
_WEB_FETCH_LOCK = threading.Lock()
_LAST_WEB_FETCH_AT: dict[str, float] = {"duckduckgo.com": time.monotonic()}
_WEB_FETCH_PENDING: dict[str, int] = {}
WEB_FETCH_HOST_PACING_DOMAINS = ("duckduckgo.com",)
WEB_FETCH_MIN_GAP_S = 2.0
WEB_FETCH_PARALLEL_STAGGER_S = 5.0



def _is_public_ip(address: str) -> bool:
    """Una dirección es pública si es global y no multicast; las IPv4 mapeadas en IPv6 se evalúan como IPv4."""
    ip = ipaddress.ip_address(address.split("%", 1)[0])
    if ip.version == 6 and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return ip.is_global and not ip.is_multicast


def is_dangerous_host(hostname: str) -> bool:
    """Riesgo de SSRF: metadatos cloud, nombres locales o cualquier dirección resuelta no pública."""
    clean_host = (hostname or "").strip().lower().strip("[]").rstrip(".")
    if not clean_host or clean_host in METADATA_HOSTS or clean_host == "localhost":
        return True
    if clean_host.endswith((".localhost", ".local", ".internal")):
        return True
    try:
        infos = socket.getaddrinfo(clean_host, None, proto=socket.IPPROTO_TCP)
    except (socket.gaierror, UnicodeError):
        # Sin resolución no hay conexión posible: la petición fallará por sí misma.
        return False
    return any(not _is_public_ip(info[4][0]) for info in infos)


def _validate_web_url(url: str) -> str:
    """Valida esquema y host de una URL de descarga (también de cada redirección)."""
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError(f"Protocolo no permitido: '{parsed.scheme}'. Solo se admite http y https.")
    if not parsed.hostname:
        raise ValueError("URL sin nombre de host válido.")
    if is_dangerous_host(parsed.hostname):
        raise PermissionError("Acceso bloqueado: intento de acceso a servicios internos o metadatos de infraestructura (SSRF).")
    return url


class _ValidatingRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Sigue redirecciones solo si el destino supera la misma validación anti-SSRF que la URL pedida."""
    max_redirections = WEB_FETCH_MAX_REDIRECTS

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _validate_web_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_WEB_OPENER = urllib.request.build_opener(_ValidatingRedirectHandler)


def _read_limited_body(stream, content_encoding: str, max_bytes: int) -> tuple[bytes, bool]:
    """Lee el cuerpo ya descomprimido hasta `max_bytes`; indica si había más (truncado)."""
    encoding = (content_encoding or "").strip().lower()
    # MAX_WBITS | 32 detecta la cabecera gzip o zlib.
    decompressor = zlib.decompressobj(zlib.MAX_WBITS | 32) if encoding in ("gzip", "x-gzip", "deflate") else None
    data = bytearray()
    while len(data) <= max_bytes:
        chunk = stream.read(WEB_FETCH_READ_CHUNK)
        if not chunk:
            break
        if decompressor:
            # La salida se limita al hueco restante: un cuerpo comprimido no puede crecer sin tope.
            chunk = decompressor.decompress(chunk, max_bytes + 1 - len(data))
        data += chunk
    truncated = len(data) > max_bytes
    return bytes(data[:max_bytes]), truncated


def is_text_content_type(content_type: str) -> bool:
    """Tipos que se devuelven como texto; el resto viaja en base64."""
    media_type = (content_type or "").split(";", 1)[0].strip().lower()
    return not media_type or bool(TEXT_CONTENT_TYPE_RE.match(media_type))


def fetch_web_resource(params: dict) -> dict:
    """Descarga de forma segura un recurso web vía HTTP/HTTPS para el cliente web."""
    url = params.get("url")
    if not isinstance(url, str) or not url.strip():
        raise ValueError("URL no válida o ausente.")
    url = _validate_web_url(url.strip())

    parsed = urllib.parse.urlsplit(url)
    hostname = (parsed.hostname or "").lower()

    # Hosts sensibles (ej. DuckDuckGo): esperar al menos WEB_FETCH_MIN_GAP_S desde la respuesta
    # anterior y escalar las peticiones en paralelo de a WEB_FETCH_PARALLEL_STAGGER_S.
    pacing_domain = next(
        (domain for domain in WEB_FETCH_HOST_PACING_DOMAINS if hostname == domain or hostname.endswith("." + domain)),
        None,
    )
    if pacing_domain is None:
        return _fetch_web_resource_unpaced(url, params, hostname, parsed)

    with _WEB_FETCH_LOCK:
        pending = _WEB_FETCH_PENDING.get(pacing_domain, 0)
        gap = time.monotonic() - _LAST_WEB_FETCH_AT.get(pacing_domain, 0.0)
        sleep_needed = max(0.0, WEB_FETCH_MIN_GAP_S - gap) + WEB_FETCH_PARALLEL_STAGGER_S * pending
        _WEB_FETCH_PENDING[pacing_domain] = pending + 1
    try:
        if sleep_needed > 0:
            time.sleep(sleep_needed)
        return _fetch_web_resource_unpaced(url, params, hostname, parsed)
    finally:
        # El timestamp marca la respuesta (o el intento) terminado: la próxima petición
        # cuenta los 2 s desde aquí.
        with _WEB_FETCH_LOCK:
            _LAST_WEB_FETCH_AT[pacing_domain] = time.monotonic()
            _WEB_FETCH_PENDING[pacing_domain] = max(0, _WEB_FETCH_PENDING[pacing_domain] - 1)


def _fetch_web_resource_unpaced(url: str, params: dict, hostname: str, parsed) -> dict:
    """Cuerpo de fetch_web_resource sin cadencia: cabeceras, descarga y respuesta."""
    timeout_s = max(0.5, min(float(params.get("timeout_s", 10.0)), 30.0))
    max_bytes = max(1024, min(int(params.get("max_bytes", 2 * 1024 * 1024)), WEB_FETCH_MAX_BYTES))
    as_binary = bool(params.get("binary", False))
    accept = params.get("accept")
    req_headers = {
        "User-Agent": ACTIVE_USER_AGENT,
        "Accept": accept if isinstance(accept, str) and accept else "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
        "Accept-Encoding": "gzip, deflate",
        "Sec-Ch-Ua": '"Not_A Brand";v="8", "Chromium";v="131", "Google Chrome";v="131"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": '"Windows"',
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "Upgrade-Insecure-Requests": "1",
    }
    if hostname.endswith("duckduckgo.com"):
        req_headers["Referer"] = f"{parsed.scheme}://{parsed.netloc}/"

    req = urllib.request.Request(url, headers=req_headers)
    try:
        with _WEB_OPENER.open(req, timeout=timeout_s) as resp:
            content_type = resp.headers.get("Content-Type", "")
            raw_data, truncated = _read_limited_body(resp, resp.headers.get("Content-Encoding", ""), max_bytes)
            # Las cabeceras de transporte ya no describen el cuerpo descomprimido.
            resp_headers = {k: v for k, v in resp.getheaders() if k.lower() not in ("content-encoding", "content-length")}
            # Respuestas 202 u otros retos anti-bot se marcan como error no exitoso.
            if resp.status == 202:
                return {
                    "ok": False,
                    "status": resp.status,
                    "error": "HTTP 202: Reto anti-bot o verificación de anomalía detectada por el servidor remoto.",
                    "text": raw_data.decode("utf-8", errors="replace")
                }
            result = {
                "ok": True,
                "status": resp.status,
                "url": resp.geturl(),
                "content_type": content_type,
                "headers": resp_headers,
                "byte_size": len(raw_data),
                "truncated": truncated
            }
            if as_binary or not is_text_content_type(content_type):
                result["base64"] = base64.b64encode(raw_data).decode("ascii")
                return result
            charset = resp.headers.get_content_charset() or "utf-8"
            try:
                result["text"] = raw_data.decode(charset, errors="replace")
            except LookupError:
                result["text"] = raw_data.decode("utf-8", errors="replace")
            return result
    except urllib.error.HTTPError as he:
        err_body = ""
        try:
            err_body = he.read(2048).decode("utf-8", errors="replace")
        except OSError:
            pass
        return {
            "ok": False,
            "status": he.code,
            "error": f"HTTP {he.code}: {he.reason}",
            "text": err_body
        }
    except Exception as exc:
        return {
            "ok": False,
            "status": 0,
            "error": str(exc)
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
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization, X-ZeroChat-Token, X-ZeroChat-Client, X-ZeroChat-Proxy, X-ZeroChat-Tool-Session, X-ZeroChat-Tool-Expires, X-ZeroChat-Tool-Nonce, X-ZeroChat-Tool-Signature, X-ZeroChat-Blob")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def verify_token(self) -> bool:
        """
        Comprueba el token diario vigente, solo en cabeceras HTTP: el de un día anterior se rechaza.
        X-ZeroChat-Token va antes que Authorization, que tras el proxy inverso lleva la clave del proxy.
        """
        token_candidate = self.headers.get("X-ZeroChat-Token", "").strip()
        if not token_candidate:
            auth_header = self.headers.get("Authorization", "")
            if auth_header.startswith("Bearer "):
                token_candidate = auth_header[7:].strip()
        return bool(token_candidate) and hmac.compare_digest(token_candidate.encode(), current_session_token().encode())

    def do_OPTIONS(self):
        t0 = time.monotonic()
        safe_path = sanitize_log_path(self.path)
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
        is_blob_upload = (
            self.headers.get("X-ZeroChat-Blob") == "1"
            or safe_path in ("/zerochat/blobs", "/zerochat/blobs/put")
        )
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
            }
        }

    @staticmethod
    def _tool_exception_result(ex: Exception) -> dict:
        return {"content": [{"type": "text", "text": _tool_error(str(ex))}], "isError": True}

    @classmethod
    def _execute_tool(cls, origin: str, tool_name: str, args: dict) -> tuple[dict | None, dict | None, str]:
        """Punto único de ejecución y normalización de herramientas locales y externas."""
        if origin == "external":
            try:
                result = GLOBAL_MCP_MANAGER.call(tool_name, args)
            except Exception as ex:
                return cls._tool_exception_result(ex), None, str(ex)
            tool_error_info = ""
            if isinstance(result, dict) and result.get("isError"):
                c_list = result.get("content", [])
                if c_list and isinstance(c_list, list) and isinstance(c_list[0], dict):
                    tool_error_info = c_list[0].get("text", "Error en herramienta MCP externa")
                else:
                    tool_error_info = "Error en herramienta MCP externa"
            return result, None, tool_error_info

        handler = LOCAL_TOOL_HANDLERS.get(tool_name)
        if not handler:
            return None, {"code": -32601, "message": f"Herramienta local '{tool_name}' no encontrada."}, ""
        try:
            tool_output_json = handler(**dict(args))
        except Exception as ex:
            return cls._tool_exception_result(ex), None, str(ex)
        tool_error_info = ""
        try:
            parsed_out = json.loads(tool_output_json)
            if isinstance(parsed_out, dict) and parsed_out.get("success") is False:
                tool_error_info = str(parsed_out.get("error", "Error en herramienta local"))
        except (json.JSONDecodeError, TypeError, ValueError):
            pass
        return {"content": [{"type": "text", "text": tool_output_json}], "isError": bool(tool_error_info)}, None, tool_error_info

    @staticmethod
    def _authorize_or_challenge(origin: str, tool_name: str, args: dict, ctx: SecurityContext) -> tuple[dict | None, dict | None, str] | None:
        """Evalúa la política de seguridad y devuelve respuesta de denegación o reto si procede."""
        if origin == "external":
            server_id = GLOBAL_MCP_MANAGER.server_of(tool_name) or ""
            server_name = server_id or "external"
        else:
            server_id = ""
            server_name = "mcp-proxy"
        decision = ACCESS_CONTROLLER.evaluate_authorization(
            tool_name, args, context=ctx, server_name=server_name, server_id=server_id
        )
        if decision.status == POLICY_DENY:
            err_msg = f"Bloqueado por política de seguridad: {decision.reason}"
            return {"content": [{"type": "text", "text": f"Error: {err_msg}"}], "isError": True, "securityStatus": "deny", "reason": decision.reason}, None, err_msg
        if decision.status == POLICY_ASK:
            ch = ACCESS_CONTROLLER.create_challenge(
                tool_name, args, decision, server_name=server_name, server_id=server_id, origin=origin, context=ctx
            )
            return {
                "requiresAuthorization": True,
                "challengeId": ch["id"],
                "toolName": tool_name,
                "serverName": server_name,
                "serverId": server_id,
                "arguments": args,
                "ruleOffer": decision.rule_offer,
                "details": decision.details,
                "content": [{"type": "text", "text": "Esta herramienta requiere autorización del usuario."}],
                "isError": False
            }, None, ""
        return None

    def _dispatch_external(self, method: str, params: dict) -> tuple[dict | None, dict | None, str]:
        """Atiende /mcp/external. Devuelve (result, error JSON-RPC, detalle de error de herramienta)."""
        if method == "initialize":
            return self._initialize_result({"name": "ZeroChat External MCP Host", "version": VERSION}), None, ""
        if method == "tools/list":
            return {"tools": GLOBAL_MCP_MANAGER.tools()}, None, ""
        if method == "tools/call":
            tool_name = params.get("name", "")
            raw_args = params.get("arguments", {})
            args = raw_args if isinstance(raw_args, dict) else {}
            ctx = SecurityContext(workspace_dir=Path.cwd().resolve())

            gate = self._authorize_or_challenge("external", tool_name, args, ctx)
            if gate is not None:
                return gate

            return self._execute_tool("external", tool_name, args)
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
            return {**self._initialize_result(server_info), "liveState": live_state()}, None, ""
        if method == "zerochat/heartbeat":
            focus_id = params.get("focus_conversation_id") if isinstance(params, dict) else None
            return live_state(focus_id), None, ""
        if method == "zerochat/login":
            return self._login(params)
        if method == "tools/list":
            return {"tools": [dict(definition) for definition in LOCAL_TOOLS_DEFINITIONS]}, None, ""
        if method == "tools/call":
            tool_name = params.get("name", "")
            if tool_name not in LOCAL_TOOL_HANDLERS:
                return None, {"code": -32601, "message": f"Herramienta local '{tool_name}' no encontrada."}, ""
            raw_args = params.get("arguments", {})
            args = dict(raw_args) if isinstance(raw_args, dict) else {}
            meta = params.get("_meta")
            if tool_name == "run_command" and isinstance(meta, dict) and "zerochatJobKey" in meta:
                args["job_key"] = meta.get("zerochatJobKey")
            ctx = SecurityContext(workspace_dir=Path.cwd().resolve())

            gate = self._authorize_or_challenge("local", tool_name, args, ctx)
            if gate is not None:
                return gate

            return self._execute_tool("local", tool_name, args)
        if method == "zerochat/project/set_directory":
            # Lo invoca la interfaz a petición del usuario: no es una herramienta del modelo.
            try:
                return set_project_directory(params.get("path")), None, ""
            except (ValueError, OSError) as exc:
                return None, {"code": -32602, "message": str(exc)}, ""
        if method == "zerochat/diff/open":
            try:
                return open_file_diff(params.get("path"), bool(params.get("commit_fallback")), bool(params.get("gui"))), None, ""
            except (ValueError, RuntimeError) as exc:
                return None, {"code": -32602, "message": str(exc)}, ""
            except Exception as exc:
                return None, {"code": -32603, "message": f"Error al abrir el visor de diffs: {exc}"}, str(exc)
        if method == "zerochat/diff/configure":
            try:
                return configure_gui_diff_tool(params.get("tool")), None, ""
            except (ValueError, RuntimeError) as exc:
                return None, {"code": -32602, "message": str(exc)}, ""
            except Exception as exc:
                return None, {"code": -32603, "message": f"Error configurando el visor de diffs: {exc}"}, str(exc)
        if method == "zerochat/web/fetch":
            try:
                return fetch_web_resource(params), None, ""
            except (ValueError, PermissionError) as exc:
                return None, {"code": -32602, "message": str(exc)}, ""
            except Exception as exc:
                return None, {"code": -32603, "message": f"Error en transporte web: {exc}"}, str(exc)
        if method.startswith("zerochat/jobs/"):
            return self._dispatch_jobs(method, params)
        if method.startswith("zerochat/run/"):
            return dispatch_run(method, params)
        if method in ("zerochat/external/servers/start", "zerochat/external/servers/stop", "zerochat/external/servers/configure"):
            return self._dispatch_server_control(method, params)
        if method.startswith("zerochat/browser/"):
            return self._dispatch_browser(method, params)
        if method.startswith("zerochat/profiles/"):
            return self._dispatch_profiles(method, params)
        if method.startswith("zerochat/conversations/"):
            return self._dispatch_conversations(method, params)
        if method.startswith("zerochat/blobs/"):
            return self._dispatch_blobs(method, params)
        if method.startswith("zerochat/security/"):
            return self._dispatch_security(method, params)
        return None, {"code": -32601, "message": f"Método '{method}' no soportado."}, ""

    @classmethod
    def _dispatch_security(cls, method: str, params: dict) -> tuple[dict | None, dict | None, str]:
        """Gestión de políticas y reglas de seguridad almacenadas en el backend local."""
        params = params if isinstance(params, dict) else {}
        ctx = SecurityContext(workspace_dir=Path.cwd().resolve())
        try:
            if method == "zerochat/security/get":
                return {"policies": ACCESS_CONTROLLER.export_state(ctx)}, None, ""
            if method == "zerochat/security/update":
                updated = ACCESS_CONTROLLER.import_state(params, context=ctx, persist=True)
                return {"policies": updated}, None, ""
            if method == "zerochat/security/authorize":
                challenge_id = params.get("challengeId")
                if not challenge_id or not isinstance(challenge_id, str):
                    return None, {"code": -32602, "message": "challengeId es obligatorio"}, ""
                decision = params.get("decision", "deny")
                if decision == "deny":
                    ACCESS_CONTROLLER.revoke_challenge(challenge_id)
                    return {"authorized": False, "status": "deny"}, None, ""

                constraints = params.get("constraints")
                dir_rule = params.get("directoryRule")
                if not ACCESS_CONTROLLER.authorize_challenge(challenge_id, decision, constraints, dir_rule, context=ctx):
                    return None, {"code": -32002, "message": "Reto no encontrado o no válido"}, ""

                ch = ACCESS_CONTROLLER.consume_challenge(challenge_id)
                if not ch:
                    return None, {"code": -32002, "message": "Error al consumir el reto para ejecución"}, ""
                t_origin = ch.get("origin") or "local"
                t_name = ch["toolName"]
                t_args = ch["arguments"] if isinstance(ch.get("arguments"), dict) else {}
                exec_res, exec_err, tool_err = cls._execute_tool(t_origin, t_name, t_args)
                if exec_err:
                    return None, exec_err, tool_err
                return {"authorized": True, "result": exec_res}, None, tool_err
        except ValueError as exc:
            return None, {"code": -32602, "message": str(exc)}, ""
        except Exception as exc:
            return None, {"code": -32603, "message": f"Error de seguridad: {exc}"}, str(exc)
        return None, {"code": -32601, "message": f"Método '{method}' no soportado."}, ""

    @staticmethod
    def _dispatch_profiles(method: str, params: dict) -> tuple[dict | None, dict | None, str]:
        """Gestión de perfiles generales almacenados en SQLite en el backend local."""
        params = params if isinstance(params, dict) else {}
        try:
            if method == "zerochat/profiles/list":
                return {"profiles": list_general_profiles()}, None, ""
            if method == "zerochat/profiles/save":
                profile_data = params.get("profile")
                if not isinstance(profile_data, dict):
                    return None, {"code": -32602, "message": "profile debe ser un objeto."}, ""
                return {"profile": save_general_profile(profile_data)}, None, ""
            if method == "zerochat/profiles/delete":
                profile_id = params.get("id")
                if not isinstance(profile_id, str) or not profile_id.strip():
                    return None, {"code": -32602, "message": "id debe ser un texto no vacío."}, ""
                return {"deleted": delete_general_profile(profile_id)}, None, ""
        except ValueError as exc:
            return None, {"code": -32602, "message": str(exc)}, ""
        except Exception as exc:
            return None, {"code": -32603, "message": f"Error en gestión de perfiles: {exc}"}, str(exc)
        return None, {"code": -32601, "message": f"Método '{method}' no soportado."}, ""

    @staticmethod
    def _dispatch_conversations(method: str, params: dict) -> tuple[dict | None, dict | None, str]:
        """Gestión de conversaciones y mensajes almacenados en SQLite en el backend local."""
        try:
            if method == "zerochat/conversations/list":
                return {"conversations": list_conversations()}, None, ""
            if method == "zerochat/conversations/get":
                return {"conversation": get_conversation(params.get("id"))}, None, ""
            if method == "zerochat/conversations/save":
                return {"conversation": save_conversation(params.get("conversation"), params.get("messages"))}, None, ""
            if method == "zerochat/conversations/rename":
                return {"renamed": rename_conversation(params.get("id"), params.get("title"))}, None, ""
            if method == "zerochat/conversations/delete":
                if params.get("all") is True:
                    for run_file in get_runs_dir().glob("*.json"):
                        try:
                            cancel_server_run(urllib.parse.unquote(run_file.stem))
                        except (ValueError, OSError):
                            pass
                    return {"deleted": True, "count": delete_all_conversations()}, None, ""
                conv_id = params.get("id")
                if isinstance(conv_id, str) and conv_id.strip():
                    try:
                        cancel_server_run(conv_id)
                    except (ValueError, OSError):
                        pass
                return {"deleted": delete_conversation(params.get("id"))}, None, ""
        except ValueError as exc:
            return None, {"code": -32602, "message": str(exc)}, ""
        except Exception as exc:
            return None, {"code": -32603, "message": f"Error en gestión de conversaciones: {exc}"}, str(exc)
        return None, {"code": -32601, "message": f"Método '{method}' no soportado."}, ""

    @staticmethod
    def _dispatch_blobs(method: str, params: dict) -> tuple[dict | None, dict | None, str]:
        """Gestión de blobs desacoplados de mensajes (imágenes y adjuntos) en SQLite."""
        params = params if isinstance(params, dict) else {}
        try:
            if method == "zerochat/blobs/has":
                ids = params.get("ids")
                if ids is None:
                    ids = []
                return has_blobs(ids), None, ""
            if method == "zerochat/blobs/put":
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
                    raise ValueError(f"Error decodificando base64: {decode_err}")
                saved = put_blob(data_bytes, mime_type=mime_type, blob_id=params.get("id"))
                return {"id": saved["id"], "mimeType": saved["mime_type"], "size": saved["size"]}, None, ""
            if method == "zerochat/blobs/get":
                blob = get_blob(params.get("id"))
                if not blob:
                    return {"blob": None}, None, ""
                return {
                    "blob": {
                        "id": blob["id"],
                        "mimeType": blob["mime_type"],
                        "size": blob["size"],
                        "data": base64.b64encode(blob["data"]).decode("ascii"),
                        "createdAt": blob["created_at"],
                    }
                }, None, ""
        except ValueError as exc:
            return None, {"code": -32602, "message": str(exc)}, ""
        except Exception as exc:
            return None, {"code": -32603, "message": f"Error en gestión de blobs: {exc}"}, str(exc)
        return None, {"code": -32601, "message": f"Método '{method}' no soportado."}, ""

    @staticmethod
    def _login(params: dict) -> tuple[dict | None, dict | None, str]:
        try:
            return login(params), None, ""
        except LoginError as exc:
            error = {"code": exc.code, "message": str(exc)}
            if exc.data:
                error["data"] = exc.data
            return None, error, ""
        except (RuntimeError, OSError) as exc:
            return None, {"code": -32603, "message": f"No se pudo comprobar la contraseña: {exc}"}, str(exc)

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
        self._send_rpc_response(req.get("id"), self._login(req.get("params", {})), log_detail, t0)
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

    @staticmethod
    def _dispatch_jobs(method: str, params: dict) -> tuple[dict | None, dict | None, str]:
        """Control de los comandos desde la interfaz: tarjetas, log y botón de detener."""
        if method == "zerochat/jobs/list":
            return {"jobs": [job.summary() for job in JOBS.list()]}, None, ""
        if method == "zerochat/jobs/report":
            ids = params.get("ids")
            if not isinstance(ids, list) or len(ids) > 100 or any(isinstance(i, bool) or not isinstance(i, int) for i in ids):
                return None, {"code": -32602, "message": "ids debe ser una lista de hasta 100 enteros."}, ""
            return {"reports": JOBS.report_finished(ids)}, None, ""
        job = JOBS.get(job_id=params.get("id"), key=params.get("key"))
        if method in ("zerochat/jobs/get", "zerochat/jobs/log", "zerochat/jobs/stop") and job is None:
            return None, {"code": -32602, "message": "Comando no encontrado: puede pertenecer a una sesión anterior de ZeroChat."}, ""
        if method == "zerochat/jobs/get":
            return job_details(job), None, ""
        if method == "zerochat/jobs/log":
            offset = params.get("offset", 0)
            limit = params.get("limit", JOB_LOG_PAGE_BYTES)
            if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0:
                return None, {"code": -32602, "message": "offset debe ser un entero no negativo."}, ""
            if isinstance(limit, bool) or not isinstance(limit, int) or limit <= 0:
                return None, {"code": -32602, "message": "limit debe ser un entero positivo."}, ""
            text, next_offset = job.read_range(offset, min(limit, JOB_LOG_PAGE_BYTES))
            return {"text": text, "next": next_offset, "total": job.total, "done": job.done.is_set()}, None, ""
        if method == "zerochat/jobs/stop":
            JOBS.stop(job, "user")
            return job_details(job), None, ""
        return None, {"code": -32601, "message": f"Método '{method}' no soportado."}, ""

    @staticmethod
    def _dispatch_browser(method: str, params: dict) -> tuple[dict | None, dict | None, str]:
        """Configuración, datos y motores propios de Playwright para la sección Navegador de Ajustes."""
        try:
            if method == "zerochat/browser/config/get":
                return load_browser_config(), None, ""
            if method == "zerochat/browser/config/set":
                return save_browser_config(params.get("config")), None, ""
            if method == "zerochat/browser/data/clear":
                return clear_own_browser_data(params.get("engine")), None, ""
            if method == "zerochat/browser/engines/list":
                return BROWSER_ENGINES.list(), None, ""
            if method == "zerochat/browser/engines/install":
                return BROWSER_ENGINES.install(params.get("engine")), None, ""
            if method == "zerochat/browser/engines/remove":
                return BROWSER_ENGINES.remove(params.get("engine")), None, ""
        except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as exc:
            return None, {"code": -32602, "message": str(exc)}, ""
        return None, {"code": -32601, "message": f"Método '{method}' no soportado."}, ""

    @staticmethod
    def _dispatch_server_control(method: str, params: dict) -> tuple[dict | None, dict | None, str]:
        server_id = params.get("serverId")
        opts = params.get("options", {})
        remember = params.get("remember")
        browser = params.get("browser")
        if not isinstance(server_id, str) or not server_id:
            return None, {"code": -32602, "message": "serverId debe ser un texto no vacío."}, ""
        if not isinstance(opts, dict):
            return None, {"code": -32602, "message": "options debe ser un objeto."}, ""
        # Al arrancar, el cliente decide siempre si el servicio se recuerda para la siguiente sesión.
        if method.endswith("/start") and not isinstance(remember, bool):
            return None, {"code": -32602, "message": "remember es obligatorio al arrancar y debe ser un booleano."}, ""
        if method.endswith("/start") and browser is not None:
            if server_id not in SERVICE_LAUNCH:
                return None, {"code": -32602, "message": f"{server_id} no admite elegir navegador."}, ""
            try:
                browser = validate_profile_browser(browser)
            except ValueError as exc:
                return None, {"code": -32602, "message": str(exc)}, ""
        try:
            if method.endswith("/start"):
                servers = GLOBAL_MCP_MANAGER.start(server_id, remember, browser)
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

        capture_frontend_user_agent(self.headers.get("User-Agent", ""))
        mark_browser_active()
        if not self.verify_token():
            # Sin token válido solo cabe identificarse para obtenerlo.
            if self._serve_login(safe_path, t0):
                return
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
            if "/mcp/external" in req_path:
                outcome = self._dispatch_external(method, params)
            else:
                outcome = self._dispatch_local(method, params)
        except Exception as ex:
            outcome = None, {"code": -32603, "message": f"Error interno: {ex}"}, ""
        self._send_rpc_response(req_id, outcome, log_detail, t0, quiet)

    def log_message(self, format, *args):
        # Silenciar logs ruidosos por defecto
        pass
