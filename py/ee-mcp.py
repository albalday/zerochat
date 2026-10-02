# ==============================================================================
# Servidor HTTP JSON-RPC 2.0 y SSE con Autenticación por Token
# ==============================================================================

MAX_HTTP_BODY_BYTES = 1024 * 1024
MAX_RPC_METHOD_LENGTH = 128
MAX_TOOL_NAME_LENGTH = 128
MAX_PATH_LENGTH = 4096
MAX_COMMAND_LENGTH = 16384


def validate_local_tool_arguments(tool_name: str, arguments: dict) -> str | None:
    """Valida tipos y límites de las herramientas locales antes de ejecutarlas."""
    schemas = {
        "list_directory": {
            "path": (str, MAX_PATH_LENGTH),
            "recursive": (bool, None)
        },
        "read_file": {
            "path": (str, MAX_PATH_LENGTH),
            "start_line": (int, None),
            "end_line": (int, None),
            "max_lines": (int, None),
            "max_bytes": (int, None)
        },
        "write_file": {
            "path": (str, MAX_PATH_LENGTH),
            "content": (str, MAX_HTTP_BODY_BYTES)
        },
        "edit_file": {
            "path": (str, MAX_PATH_LENGTH),
            "old_str": (str, MAX_HTTP_BODY_BYTES),
            "new_str": (str, MAX_HTTP_BODY_BYTES),
            "content": (str, MAX_HTTP_BODY_BYTES),
            "mode": (str, 32),
            "target_content": (str, MAX_HTTP_BODY_BYTES)
        },
        "bash": {
            "command": (str, MAX_COMMAND_LENGTH),
            "timeout_seconds": (int, None)
        },
        "search_files": {
            "query": (str, 4096),
            "path": (str, MAX_PATH_LENGTH),
            "file_pattern": (str, 256)
        },
        "execute_command": {
            "command": (str, MAX_COMMAND_LENGTH),
            "cwd": (str, MAX_PATH_LENGTH),
            "timeout_seconds": (int, None)
        },
        "get_diagnostics": {
            "path": (str, MAX_PATH_LENGTH)
        },
        "browser_action": {
            "action": (str, 32),
            "url": (str, 4096),
            "selector": (str, 1024),
            "value": (str, MAX_HTTP_BODY_BYTES)
        }
    }
    schema = schemas.get(tool_name)
    if schema is None:
        return None

    for name, value in arguments.items():
        expected = schema.get(name)
        if expected is None:
            return f"Argumento no permitido: {name}"
        expected_type, max_length = expected
        if expected_type is bool:
            if not isinstance(value, bool):
                return f"Tipo inválido para '{name}'"
        else:
            if isinstance(value, bool) or not isinstance(value, expected_type):
                return f"Tipo inválido para '{name}'"
        if max_length is not None and len(value) > max_length:
            return f"'{name}' excede el tamaño máximo permitido"

    required = {
        "read_file": ("path",),
        "write_file": ("path", "content"),
        "edit_file": ("path",),
        "bash": ("command",),
        "search_files": ("query",),
        "execute_command": ("command",),
        "browser_action": ("action",)
    }
    for name in required.get(tool_name, ()):
        if name not in arguments:
            return f"Falta el argumento obligatorio: {name}"

    if tool_name == "edit_file":
        has_surgical = "old_str" in arguments and "new_str" in arguments
        has_legacy = "content" in arguments
        if not has_surgical and not has_legacy:
            return "Faltan argumentos obligatorios: especifica 'old_str' y 'new_str' o 'content'"

    if tool_name == "browser_action":
        if arguments.get("action") not in ("navigate", "screenshot", "click", "fill"):
            return f"Acción de navegador no permitida: {arguments.get('action')}"

    return None

def sanitize_log_path(raw_path: str) -> str:
    """Oculta tokens de sesión o parámetros sensibles en la query string para logs seguros."""
    if not raw_path or "?" not in raw_path:
        return raw_path or "/"
    path, query = raw_path.split("?", 1)
    safe_query = re.sub(r'(token=)[^&]+', r'\1***', query, flags=re.IGNORECASE)
    return f"{path}?{safe_query}"


def format_log_error(msg: str, max_len: int = 160) -> str:
    """Limpia y trunca mensajes de error para mantener el log en una sola línea legible."""
    if not msg:
        return ""
    cleaned = " ".join(str(msg).strip().splitlines())
    if len(cleaned) > max_len:
        return cleaned[:max_len - 3] + "..."
    return cleaned


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


def public_tool_name(server_id: str, original: str) -> str:
    """Codificación inyectiva de nombres de herramientas MCP idéntica a publicToolName en js/mcp.js."""
    def encode(value: str, tool: bool = False) -> str:
        if not isinstance(value, str) or not value or len(value) > 256:
            raise ValueError("Componente de nombre MCP no válido")
        # MCP function names preserve ASCII case, which keeps remote tool
        # names readable while still escaping unsupported characters.
        return "".join(ch if ("a" <= ch <= "z" or "A" <= ch <= "Z" or "0" <= ch <= "9" or (tool and ch == "_"))
                       else f"z{ord(ch):x}z" for ch in value)
    name = f"{encode(server_id)}_{encode(original, True)}"
    if len(name) > 64:
        raise ValueError(f"El nombre público de la herramienta MCP excede 64 caracteres: {name}")
    return name


def _mcp_trace_text(value: object, max_len: int = 1000) -> str:
    """Normaliza diagnósticos MCP para consola sin exponer secretos comunes."""
    text = " ".join(str(value).strip().splitlines())
    text = re.sub(r"(?i)(\b(?:api[_-]?key|token|secret|password)\b\s*[=:]\s*)\S+", r"\1***", text)
    text = re.sub(r"(?i)(--(?:api[_-]?key|token|secret|password)\s+)\S+", r"\1***", text)
    text = re.sub(r"(?i)([?&](?:access_token|code|id_token|refresh_token|state)=)[^&\s]+", r"\1***", text)
    return text[:max_len - 3] + "..." if len(text) > max_len else text


class StdioMcpClient:
    def __init__(self, command: str, args: list[str], cwd: str, env: dict[str, str], trace=None):
        self.command = command
        self.args = args
        self.cwd = cwd
        self.env = env
        self.process: subprocess.Popen | None = None
        self._pending: dict[int, queue.Queue] = {}
        self._next = 0
        self._lock = threading.Lock()
        self._alive = False
        self.tools: list[dict] = []
        self.oauth_url: str | None = None
        self._trace = trace or (lambda _message: None)

    def running(self) -> bool:
        return self._alive and self.process is not None and self.process.poll() is None

    def start(self, handshake_timeout: int = 30):
        cmd = [self.command] + self.args
        self._trace(f"launching: {_mcp_trace_text(' '.join(cmd))}")
        self.process = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=self.cwd,
            env=self.env,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1
        )
        self._alive = True
        threading.Thread(target=self._drain_stderr, daemon=True).start()
        threading.Thread(target=self._read_stdout, daemon=True).start()

        self.request("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "zerochat", "version": VERSION}
        }, timeout=handshake_timeout)
        self.notify("notifications/initialized")
        tools_resp = self.request("tools/list", {}, timeout=10)
        self.tools = tools_resp.get("tools", [])
        self.oauth_url = None  # OAuth completado si llegamos aquí
        self._trace(f"handshake completed; {len(self.tools)} tool(s) available")

    # Patrón que mcp-remote imprime justo antes de la URL OAuth:
    # "Please authorize this client by visiting:\n<url>"
    _OAUTH_URL_RE = re.compile(r'https?://\S{20,}', re.IGNORECASE)
    _OAUTH_HINT_RE = re.compile(r'visiting|authorize|authorization', re.IGNORECASE)

    def _drain_stderr(self):
        if not self.process or not self.process.stderr:
            return
        pending_oauth = False
        for raw_line in self.process.stderr:
            line = _mcp_trace_text(raw_line)
            if not line:
                continue
            self._trace(f"stderr: {line}")
            # Detectar la URL OAuth en el flujo de stderr de mcp-remote.
            # La secuencia típica es: "visiting:\n<url>" en líneas consecutivas.
            if self._OAUTH_HINT_RE.search(line):
                pending_oauth = True
            if pending_oauth:
                m = self._OAUTH_URL_RE.search(line)
                if m:
                    url = m.group(0).rstrip('.,;)')
                    self.oauth_url = url
                    self._trace(f"oauth_url detected for frontend: {_mcp_trace_text(url)}")
                    pending_oauth = False



    def _read_stdout(self):
        try:
            if not self.process or not self.process.stdout:
                return
            for line in self.process.stdout:
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except Exception:
                    continue
                req_id = msg.get("id")
                if req_id is not None:
                    with self._lock:
                        waiter = self._pending.pop(req_id, None)
                    if waiter:
                        waiter.put(msg)
        finally:
            self._alive = False
            if self.process:
                return_code = self.process.poll()
                if return_code is not None:
                    self._trace(f"process exited with code {return_code}")
            with self._lock:
                pending = list(self._pending.values())
                self._pending.clear()
            for waiter in pending:
                waiter.put({"error": {"message": "MCP process ended unexpectedly"}})

    def request(self, method: str, params: dict, timeout: int = 30) -> dict:
        if not self.running():
            raise RuntimeError("MCP process is not running")
        with self._lock:
            self._next += 1
            req_id = self._next
            waiter = queue.Queue(maxsize=1)
            self._pending[req_id] = waiter
            payload = json.dumps({"jsonrpc": "2.0", "id": req_id, "method": method, "params": params}) + "\n"
            try:
                self.process.stdin.write(payload)
                self.process.stdin.flush()
            except Exception as exc:
                self._alive = False
                self._pending.pop(req_id, None)
                raise RuntimeError(f"Failed writing to MCP process: {exc}") from exc
        try:
            response = waiter.get(timeout=timeout)
        except queue.Empty as exc:
            with self._lock:
                self._pending.pop(req_id, None)
            raise TimeoutError(f"MCP request timed out: {method}") from exc
        if response.get("error"):
            raise RuntimeError(str(response["error"].get("message", "MCP request failed")))
        return response.get("result", {})

    def notify(self, method: str):
        if self.running():
            with self._lock:
                try:
                    self.process.stdin.write(json.dumps({"jsonrpc": "2.0", "method": method}) + "\n")
                    self.process.stdin.flush()
                except Exception:
                    self._alive = False

    def stop(self):
        self._alive = False
        if not self.process:
            return
        try:
            self.process.terminate()
            self.process.wait(timeout=2)
        except (OSError, subprocess.TimeoutExpired):
            try:
                self.process.kill()
            except OSError:
                pass
        self.process = None
        self.tools = []


class McpServiceManager:
    def __init__(self, services_root: Path | None = None):
        if services_root:
            self.services_root = Path(services_root)
        else:
            self.services_root = get_data_dir() / "services"
        self.services_root.mkdir(parents=True, exist_ok=True)
        self.config_file = get_data_dir() / "config" / "services.json"
        self.config_file.parent.mkdir(parents=True, exist_ok=True)
        self.clients: dict[str, StdioMcpClient] = {}
        self.states: dict[str, str] = {}
        self.errors: dict[str, str] = {}
        self._lock = threading.Lock()
        materialize_managed_services(self.services_root)
        self.services = self._load_services()
        self.preferences = self._load_preferences()

    @staticmethod
    def _trace(server_id: str, message: str):
        console_log(f"[{time.strftime('%H:%M:%S')}] [MCP {server_id}] {_mcp_trace_text(message)}", flush=True)

    def _load_services(self) -> dict[str, dict]:
        servers = {}
        for directory in sorted(self.services_root.iterdir()):
            if not directory.is_dir():
                continue
            service_file = directory / "service.json"
            if not service_file.exists():
                continue
            try:
                server = json.loads(service_file.read_text(encoding="utf-8"))
                server_id = server.get("id") or directory.name.replace(".mcp", "")
                server["id"] = server_id
                server["_directory"] = directory
                servers[server_id] = server
            except Exception:
                continue
        return servers

    def _load_preferences(self) -> dict:
        if self.config_file.exists():
            try:
                return json.loads(self.config_file.read_text(encoding="utf-8"))
            except Exception:
                return {}
        return {}

    def _save_preferences(self):
        try:
            tmp = self.config_file.with_suffix(".tmp")
            tmp.write_text(json.dumps(self.preferences, indent=2), encoding="utf-8")
            tmp.replace(self.config_file)
        except Exception:
            pass

    def list_servers(self) -> list[dict]:
        self.services = self._load_services()
        result = []
        for server_id, server in self.services.items():
            client = self.clients.get(server_id)
            running = bool(client and client.running())
            pref = self.preferences.get(server_id, {})
            result.append({
                "id": server_id,
                "displayName": server.get("displayName", {}),
                "description": server.get("description", {}),
                "help": server.get("help"),
                "remote": server.get("remote"),
                "enabled": pref.get("enabled", server.get("enabledByDefault", False)),
                "status": "running" if running else self.states.get(server_id, "stopped"),
                "toolCount": len(client.tools) if running else 0,
                "error": self.errors.get(server_id),
                "options": server.get("options", []),
                "userOptions": pref.get("options", {}),
                "oauthUrl": client.oauth_url if client else None,
            })

        return result

    def _expand(self, value: str, values: dict[str, str]) -> str:
        if not isinstance(value, str):
            raise ValueError("Invalid process argument")
        for key, replacement in values.items():
            value = value.replace("${" + key + "}", str(replacement))
        return value

    def _prepare_service(self, server_id: str, server: dict) -> dict[str, str]:
        service_dir = server["_directory"]
        installer_file = service_dir / "installer.json"
        node = shutil.which("node") or "node"
        npm = shutil.which("npm") or "npm"

        if installer_file.exists():
            self._trace(server_id, f"reading installer: {installer_file.name}")
            marker = service_dir / ".installed.json"
            try:
                installer = json.loads(installer_file.read_text(encoding="utf-8"))
            except Exception as e:
                raise RuntimeError(f"Error leyendo installer.json: {e}")
            kind = installer.get("type", "npm")
            if kind == "npm":
                product = installer.get("product", {})
                package = product.get("package")
                version = product.get("version")
                if not package or not version:
                    raise RuntimeError("El instalador npm debe definir package y version")
                if not shutil.which("node") or not shutil.which("npm"):
                    raise RuntimeError("Node.js y npm son necesarios para instalar este servicio MCP")

                requirements = installer.get("requirements", {})
                node_requirement = requirements.get("node")
                if node_requirement is None:
                    # Compatibilidad con instaladores creados antes de requirements.node.
                    required_node_major = int(product.get("nodeMajor", 18))
                elif not isinstance(node_requirement, dict):
                    raise RuntimeError("El requisito Node.js debe ser un objeto en installer.json")
                else:
                    required_node_major = node_requirement.get("minimumMajor")
                    if not isinstance(required_node_major, int) or isinstance(required_node_major, bool) or required_node_major < 1:
                        raise RuntimeError("El requisito Node.js debe definir minimumMajor como un entero positivo")
                version_result = subprocess.run(
                    [node, "--version"], capture_output=True, text=True, timeout=5
                )
                version_match = re.match(r"v(\d+)", version_result.stdout.strip())
                if version_result.returncode != 0 or not version_match:
                    raise RuntimeError("No se pudo comprobar la versión de Node.js necesaria para este servicio MCP")
                self._trace(server_id, f"Node.js detected: {version_result.stdout.strip()} (minimum {required_node_major})")
                if int(version_match.group(1)) < required_node_major:
                    raise RuntimeError(
                        f"{server_id} requiere Node.js {required_node_major}+; se detectó {version_result.stdout.strip()}"
                    )

                package_dir = service_dir / "node_modules" / Path(*package.split("/"))
                needs_install = not marker.exists() or not package_dir.is_dir()
                if not needs_install:
                    try:
                        installation = json.loads(marker.read_text(encoding="utf-8"))
                        if installation.get("package") != package or installation.get("version") != version:
                            needs_install = True
                    except Exception:
                        needs_install = True

                if needs_install:
                    self.states[server_id] = "installing"
                    self._trace(server_id, f"installing npm package: {package}@{version}")
                    manifest = service_dir / "package.json"
                    manifest.write_text(json.dumps({"private": True, "dependencies": {package: version}}, indent=2), encoding="utf-8")
                    res = subprocess.run([npm, "install", "--ignore-scripts", "--no-audit", "--no-fund"], cwd=service_dir, capture_output=True, text=True, timeout=600)
                    if res.returncode != 0:
                        raise RuntimeError(f"Fallo instalando dependencias npm: {res.stderr or res.stdout}")
                    self._trace(server_id, f"npm package installed: {package}@{version}")
                    installation = {"type": "npm", "package": package, "version": version, "nodeExecutable": node}
                    browser = product.get("browser")
                    if browser:
                        playwright_cli = service_dir / "node_modules" / "playwright" / "cli.js"
                        if not playwright_cli.is_file():
                            raise RuntimeError("No se encontró Playwright después de instalar el servicio MCP")
                        browser_result = subprocess.run(
                            [node, str(playwright_cli), "install", browser], cwd=service_dir,
                            capture_output=True, text=True, timeout=600
                        )
                        if browser_result.returncode != 0:
                            raise RuntimeError(
                                f"Fallo instalando el navegador {browser} de Playwright: "
                                f"{browser_result.stderr or browser_result.stdout}"
                            )
                        installation["browser"] = browser
                    marker.write_text(json.dumps(installation, indent=2), encoding="utf-8")
                else:
                    self._trace(server_id, f"npm package already installed: {package}@{version}")

        return {
            "serviceDir": str(service_dir),
            "pythonExecutable": str(get_venv_python(get_venv_dir())) if get_venv_python(get_venv_dir()).is_file() else sys.executable,
            "nodeExecutable": node
        }

    def start(self, server_id: str) -> list[dict]:
        with self._lock:
            self.services = self._load_services()
            server = self.services.get(server_id)
            if not server:
                raise KeyError(f"Servidor MCP desconocido: {server_id}")
            current = self.clients.get(server_id)
            if current and current.running():
                return self.list_servers()
            self.states[server_id] = "starting"
            self.errors.pop(server_id, None)
            client = None
            self._trace(server_id, "start requested")
            try:
                service_dir = server["_directory"]
                values = self._prepare_service(server_id, server)
                pref = self.preferences.get(server_id, {})
                user_opts = pref.get("options", {})
                for opt in server.get("options", []):
                    opt_id = opt.get("id")
                    if opt_id:
                        val = user_opts.get(opt_id, opt.get("default"))
                        values[f"option:{opt_id}"] = str(val)

                launch = server.get("launch", {})
                command = self._expand(launch.get("executable", sys.executable), values)
                args = [self._expand(arg, values) for arg in launch.get("args", [])]
                for opt in server.get("options", []):
                    opt_id = opt.get("id")
                    if not opt_id:
                        continue
                    val = user_opts.get(opt_id, opt.get("default"))
                    if opt.get("type") == "boolean":
                        extra = opt.get("argsWhenTrue", []) if val else opt.get("argsWhenFalse", [])
                        args.extend([self._expand(a, values) for a in extra])

                env = os.environ.copy()
                for k, v in launch.get("env", {}).items():
                    env[k] = self._expand(v, values)

                client = StdioMcpClient(
                    command, args, str(service_dir), env,
                    trace=lambda message: self._trace(server_id, message)
                )
                self.states[server_id] = "starting"
                client.start(int(launch.get("handshakeTimeoutSeconds", 15)))
                self.clients[server_id] = client
                self.states[server_id] = "running"
                self.errors.pop(server_id, None)
                entry = self.preferences.setdefault(server_id, {})
                entry["enabled"] = True
                self._save_preferences()
                self._trace(server_id, "started successfully")
            except Exception as exc:
                self.states[server_id] = "error"
                self.errors[server_id] = str(exc)
                self._trace(server_id, f"start failed: {exc}")
                if server_id in self.clients:
                    self.clients.pop(server_id).stop()
                elif client:
                    client.stop()
            return self.list_servers()

    def stop(self, server_id: str) -> list[dict]:
        with self._lock:
            client = self.clients.pop(server_id, None)
            if client:
                client.stop()
            self.states[server_id] = "stopped"
            self.errors.pop(server_id, None)
            entry = self.preferences.setdefault(server_id, {})
            entry["enabled"] = False
            self._save_preferences()
            return self.list_servers()

    def configure(self, server_id: str, options: dict | None = None) -> list[dict]:
        with self._lock:
            self.services = self._load_services()
            if server_id not in self.services:
                raise KeyError(f"Servidor MCP desconocido: {server_id}")
            entry = self.preferences.setdefault(server_id, {})
            if options is not None:
                opts = entry.setdefault("options", {})
                opts.update(options)
            self._save_preferences()
            return self.list_servers()

    def tools(self) -> list[dict]:
        aggregated = []
        with self._lock:
            for server_id, client in self.clients.items():
                if not client.running():
                    continue
                for t in client.tools:
                    try:
                        pname = public_tool_name(server_id, t["name"])
                        tcopy = dict(t)
                        tcopy["name"] = pname
                        tcopy["metadata"] = {
                            "mcpServerId": server_id,
                            "originalName": t["name"]
                        }
                        aggregated.append(tcopy)
                    except Exception:
                        continue
        return aggregated

    def call(self, public_name: str, arguments: dict) -> dict:
        with self._lock:
            for server_id, client in self.clients.items():
                if not client.running():
                    continue
                for t in client.tools:
                    if public_tool_name(server_id, t["name"]) == public_name:
                        return client.request("tools/call", {"name": t["name"], "arguments": arguments})
        raise ValueError(f"Herramienta externa '{public_name}' no disponible o servidor detenido.")

    def close(self):
        with self._lock:
            for client in list(self.clients.values()):
                client.stop()
            self.clients.clear()


GLOBAL_MCP_MANAGER = McpServiceManager()
