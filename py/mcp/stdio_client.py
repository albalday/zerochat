"""Cliente MCP por stdio: arranque del proceso, mensajes JSON-RPC acotados, plazos y cierre con sus descendientes."""

from __future__ import annotations

import json
import os
import queue
import re
import signal
import subprocess
import threading

from core.environment import DETECTED_OS
from core.process import _kill_process_tree
from core.version import VERSION


# Un mensaje MCP admite imágenes en base64, pero no puede agotar la memoria del backend.
MAX_MCP_MESSAGE_CHARS = 16 * 1024 * 1024
MAX_MCP_STDERR_LINE_CHARS = 64 * 1024
DEFAULT_MCP_CALL_TIMEOUT_SECONDS = 30


def _mcp_trace_text(value: object, max_len: int = 1000) -> str:
    """Normaliza diagnósticos MCP para consola sin exponer secretos comunes."""
    text = " ".join(str(value).strip().splitlines())
    text = re.sub(r"(?i)(\b(?:api[_-]?key|token|secret|password)\b\s*[=:]\s*)\S+", r"\1***", text)
    text = re.sub(r"(?i)(--(?:api[_-]?key|token|secret|password)\s+)\S+", r"\1***", text)
    text = re.sub(r"(?i)([?&](?:access_token|code|id_token|refresh_token|state)=)[^&\s]+", r"\1***", text)
    return text[:max_len - 3] + "..." if len(text) > max_len else text


def _read_bounded_line(stream, limit: int) -> tuple[str, str | None]:
    """Lee una línea de como mucho limit caracteres.

    Si la línea es más larga, consume y descarta el resto sin retenerlo en memoria y
    devuelve el comienzo junto con el último fragmento leído (para diagnóstico).
    """
    line = stream.readline(limit + 1)
    if len(line) <= limit or line.endswith("\n"):
        return line, None
    tail = line
    while True:
        chunk = stream.readline(limit)
        if not chunk:
            break
        tail = chunk
        if chunk.endswith("\n"):
            break
    return line[:limit], tail


def _positive_seconds(value, default: float) -> float:
    """Normaliza un plazo en segundos declarado en service.json."""
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value <= 0:
        return default
    return float(value)


class StdioMcpClient:
    max_message_chars = MAX_MCP_MESSAGE_CHARS

    def __init__(self, command: str, args: list[str], cwd: str, env: dict[str, str], trace=None,
                 call_timeout: float = DEFAULT_MCP_CALL_TIMEOUT_SECONDS):
        self.command = command
        self.args = args
        self.cwd = cwd
        self.env = env
        self.call_timeout = call_timeout
        self.process: subprocess.Popen | None = None
        self._pending: dict[int, queue.Queue] = {}
        self._next = 0
        self._lock = threading.Lock()
        # Escribir en stdin puede bloquear si el hijo no lee: nunca con _lock tomado,
        # porque el lector de stdout lo necesita para entregar respuestas.
        self._write_lock = threading.Lock()
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
            bufsize=1,
            # Grupo propio para terminar también npm, node o navegadores lanzados por el MCP.
            start_new_session=DETECTED_OS != "windows" and hasattr(os, "setsid")
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
        stderr = self.process.stderr
        while True:
            raw_line, _ = _read_bounded_line(stderr, MAX_MCP_STDERR_LINE_CHARS)
            if not raw_line:
                break
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
            stdout = self.process.stdout
            while True:
                line, tail = _read_bounded_line(stdout, self.max_message_chars)
                if not line:
                    break
                if tail is not None:
                    self._reject_oversized(line, tail)
                    continue
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
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

    _HEAD_ID_RE = re.compile(r'^\s*\{\s*"jsonrpc"\s*:\s*"2\.0"\s*,\s*"id"\s*:\s*(\d+)')
    _TAIL_ID_RE = re.compile(r'"id"\s*:\s*(\d+)\s*\}\s*$')

    def _reject_oversized(self, head: str, tail: str):
        """Responde con error a la petición cuya respuesta supera el límite de tamaño."""
        message = f"MCP response exceeds {self.max_message_chars} characters"
        self._trace(f"discarded oversized message: {message}")
        match = self._HEAD_ID_RE.match(head) or self._TAIL_ID_RE.search(tail)
        with self._lock:
            if match:
                waiter = self._pending.pop(int(match.group(1)), None)
                waiters = [waiter] if waiter else []
            else:
                # Sin identificador no se sabe a quién pertenece: falla todo lo pendiente.
                waiters = list(self._pending.values())
                self._pending.clear()
        for waiter in waiters:
            waiter.put({"error": {"message": message}})

    def _write(self, payload: str):
        with self._write_lock:
            self.process.stdin.write(payload)
            self.process.stdin.flush()

    def request(self, method: str, params: dict, timeout: float = DEFAULT_MCP_CALL_TIMEOUT_SECONDS) -> dict:
        if not self.running():
            raise RuntimeError("MCP process is not running")
        with self._lock:
            self._next += 1
            req_id = self._next
            waiter = queue.Queue(maxsize=1)
            self._pending[req_id] = waiter
        payload = json.dumps({"jsonrpc": "2.0", "id": req_id, "method": method, "params": params}) + "\n"
        try:
            self._write(payload)
        except Exception as exc:
            self._alive = False
            with self._lock:
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
            try:
                self._write(json.dumps({"jsonrpc": "2.0", "method": method}) + "\n")
            except (OSError, ValueError):
                self._alive = False

    def _signal_group(self, sig) -> bool:
        """Envía la señal al grupo del MCP; devuelve False si no hay grupo propio."""
        if DETECTED_OS == "windows" or not hasattr(os, "killpg"):
            return False
        try:
            os.killpg(self.process.pid, sig)
        except ProcessLookupError:
            pass
        except OSError:
            return False
        return True

    def stop(self):
        self._alive = False
        if not self.process:
            return
        if DETECTED_OS == "windows":
            # Windows no tiene SIGKILL ni grupos POSIX: se elimina el árbol completo de una vez.
            _kill_process_tree(self.process)
            try:
                self.process.wait(timeout=2)
            except (OSError, subprocess.TimeoutExpired):
                pass
            self.process = None
            self.tools = []
            return
        try:
            if not self._signal_group(signal.SIGTERM):
                self.process.terminate()
            self.process.wait(timeout=2)
        except (OSError, subprocess.TimeoutExpired):
            pass
        # Los descendientes que sigan vivos se eliminan aunque el proceso principal ya terminara.
        if not self._signal_group(signal.SIGKILL):
            try:
                self.process.kill()
            except OSError:
                pass
        self.process = None
        self.tools = []
