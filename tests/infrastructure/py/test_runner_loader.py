import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from functools import partial
from http.server import BaseHTTPRequestHandler, SimpleHTTPRequestHandler
from pathlib import Path
from unittest import mock

from backend import ZEROCHAT_PY, use_data_dir, zerochat

# Una interfaz mínima: js/run-node.js con dependencias en dos niveles, una que sube de carpeta, y una librería
# que se pide al usarla (como ChatVendorLoader). startHeadlessRun imprime lo que ve y termina.
SITE = {
    "js/run-node.js": """
const a = require('./a.js');
const os = require('node:os');
module.exports = {
  startHeadlessRun: async argv => {
    const vendor = await globalThis.ChatRunnerSource('js/vendor/lib.js');
    console.log(JSON.stringify({ a: a.value, argv, vendor, node: typeof os.platform }));
  }
};""",
    "js/a.js": "module.exports = { value: 'a+' + require('./tools/b.js').value };",
    "js/tools/b.js": "module.exports = { value: 'b+' + require('../c.js').value };",
    "js/c.js": "module.exports = { value: 'c' };",
    "js/vendor/lib.js": "vendor-v1",
}


class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


class RecordingSite(Quiet):
    """Sirve la interfaz y anota las rutas que se piden; las de dropped cierran la conexión sin responder, como
    una red que se corta."""
    requests: list[str] = []
    dropped: set[str] = set()

    def do_GET(self):
        self.requests.append(self.path)
        if self.path in self.dropped:
            self.close_connection = True
            self.request.shutdown(socket.SHUT_RDWR)
            return
        super().do_GET()


class RunnerLoaderTest(unittest.TestCase):
    def setUp(self):
        base = use_data_dir(self)
        self.site = base / "site"
        for name, text in SITE.items():
            (self.site / name).parent.mkdir(parents=True, exist_ok=True)
            # Con LF también en Windows: el tope cuenta lo que se sirve.
            (self.site / name).write_text(text, encoding="utf-8", newline="")
        self.cache_dir = base / "cache"
        self.cache_dir.mkdir()
        RecordingSite.requests = []
        RecordingSite.dropped = set()
        self.server = zerochat.ZeroChatHTTPServer(("127.0.0.1", 0), partial(RecordingSite, directory=str(self.site)))
        threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/zerochat.html#run=r1"

    def go_offline(self):
        """Sin servidor que escuche: la conexión se rechaza, como sin red."""
        self.server.shutdown()
        self.server.server_close()

    def run_loader(self, policy=None):
        node = zerochat.find_node_executable()
        cmd = [node, "--permission", f"--allow-fs-read={self.cache_dir}", f"--allow-fs-write={self.cache_dir}",
               "-e", zerochat.RUNNER_LOADER_SCRIPT, str(self.cache_dir / "modules.json"),
               policy or zerochat.RUNNER_CACHE_BY_VERSION]
        env = {**os.environ, zerochat.RUNNER_URL_ENV: self.url}
        RecordingSite.requests.clear()
        # Con su stdin abierto mientras corre, como lo lanza launch_node_runner: cerrarlo es que murió quien lo lanzó.
        with tempfile.TemporaryFile("w+", encoding="utf-8") as out, tempfile.TemporaryFile("w+", encoding="utf-8") as err:
            proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=out, stderr=err, env=env)
            try:
                proc.wait(timeout=30)
            finally:
                proc.stdin.close()
                if proc.poll() is None:
                    proc.kill()
                    proc.wait()
            out.seek(0)
            err.seek(0)
            return subprocess.CompletedProcess(cmd, proc.returncode, out.read(), err.read())

    def test_el_runner_termina_cuando_se_cierra_su_stdin_al_morir_quien_lo_lanzo(self):
        # Una interfaz que acepta la conexión y nunca responde: el runner seguiría esperando por su cuenta.
        silent = socket.create_server(("127.0.0.1", 0))
        self.addCleanup(silent.close)
        url = f"http://127.0.0.1:{silent.getsockname()[1]}/zerochat.html#run=r1"
        with mock.patch.object(zerochat, "_runner_cache_file", return_value=self.cache_dir / "modules.json"):
            proc, stderr_log = zerochat.launch_node_runner(url)
        self.addCleanup(stderr_log.close)
        self.addCleanup(lambda: proc.poll() is None and proc.kill())
        # Al morir quien lo lanzó, aunque sea con SIGKILL, el sistema cierra su extremo de la tubería: igual que esto.
        proc.stdin.close()
        self.assertEqual(proc.wait(timeout=10), 1)
        stderr_log.seek(0)
        self.assertIn(b"The zerochat process that launched the runner is gone", stderr_log.read())

    def publish(self, version=None, c_value="c"):
        """Publica la interfaz con esa versión en el título (sin título si es None) y el valor de js/c.js."""
        page = self.site / "zerochat.html"
        if version is None:
            page.unlink(missing_ok=True)
        else:
            page.write_text(f"<html><head><title>ZeroChat v{version}</title></head></html>", encoding="utf-8")
        (self.site / "js" / "c.js").write_text(f"module.exports = {{ value: '{c_value}' }};", encoding="utf-8")

    def loaded(self, policy=None):
        result = self.run_loader(policy)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)["a"], result.stderr

    def test_con_la_version_publicada_de_la_cache_no_se_pide_ningun_modulo(self):
        self.publish("1.0.0")
        self.assertEqual(self.loaded()[0], "a+b+c")
        self.assertIn("/js/run-node.js", RecordingSite.requests)

        # Misma versión: un módulo cambiado sin subirla no se ve, y solo se pide la página.
        self.publish("1.0.0", "c2")
        value, stderr = self.loaded()
        self.assertEqual((value, RecordingSite.requests), ("a+b+c", ["/zerochat.html"]))
        self.assertIn("Using the cached modules of version 1.0.0", stderr)

        self.publish("1.0.1", "c2")
        value, stderr = self.loaded()
        self.assertEqual(value, "a+b+c2")
        self.assertIn("/js/vendor/lib.js", RecordingSite.requests)
        self.assertRegex(stderr, r"Downloaded 4 modules \(\d+ KiB\) in \d+ ms")

        # Sin versión legible en la página o en modo desarrollo (always) se descarga todo.
        self.publish(None, "c3")
        self.assertEqual(self.loaded()[0], "a+b+c3")
        self.publish("1.0.1", "c4")
        self.assertEqual(self.loaded(zerochat.RUNNER_CACHE_ALWAYS_DOWNLOAD)[0], "a+b+c4")
        self.assertNotIn("/zerochat.html", RecordingSite.requests)

    def test_descarga_los_modulos_y_sin_conexion_usa_la_ultima_copia(self):
        online = self.run_loader()
        self.assertEqual(online.returncode, 0, online.stderr)
        self.assertEqual(json.loads(online.stdout), {"a": "a+b+c", "argv": [self.url], "vendor": "vendor-v1", "node": "function"})
        cached = json.loads((self.cache_dir / "modules.json").read_text(encoding="utf-8"))
        self.assertEqual(sorted(cached["files"]), sorted(SITE))

        # Una copia nueva publicada sustituye a la guardada.
        (self.site / "js" / "c.js").write_text("module.exports = { value: 'c2' };", encoding="utf-8")
        self.assertEqual(json.loads(self.run_loader().stdout)["a"], "a+b+c2")

        # Una respuesta HTTP de error no ejecuta la copia guardada.
        (self.site / "js" / "tools" / "b.js").unlink()
        failed_http = self.run_loader()
        self.assertEqual((failed_http.returncode, failed_http.stdout), (1, ""))
        self.assertIn("js/tools/b.js: HTTP 404", failed_http.stderr)

        # Sin conexión sí usa la copia guardada; si tampoco hay copia guardada, falla.
        self.go_offline()
        offline = self.run_loader()
        self.assertEqual(offline.returncode, 0, offline.stderr)
        self.assertEqual(json.loads(offline.stdout)["a"], "a+b+c2")
        self.assertIn("using the cached copy", offline.stderr)

        (self.cache_dir / "modules.json").unlink()
        no_cache = self.run_loader()
        self.assertEqual(no_cache.returncode, 1)
        self.assertIn("Fatal error", no_cache.stderr)

    def test_lo_descargado_tiene_tope_de_tamano(self):
        others = sum(len(text) for name, text in SITE.items() if name not in ("js/c.js", "js/vendor/lib.js"))
        head = "module.exports = { value: 'c' };//"
        for extra, code in ((0, 0), (1, 1)):
            with self.subTest(extra=extra):
                padding = zerochat.RUNNER_MAX_BYTES - others - len(head) + extra
                (self.site / "js" / "c.js").write_text(head + "x" * padding, encoding="utf-8", newline="")
                result = self.run_loader()
                self.assertEqual(result.returncode, code, result.stderr)
                if code:
                    self.assertIn(f"exceed {zerochat.RUNNER_MAX_BYTES} bytes", result.stderr)

    def test_el_tope_cuenta_bytes_utf8_y_tambien_cada_libreria_bajo_demanda(self):
        limit = zerochat.RUNNER_MAX_BYTES
        others = sum(len(text) for name, text in SITE.items() if name not in ("js/c.js", "js/vendor/lib.js"))
        head = "module.exports = { value: 'c' };//"
        # Caben en el tope contando caracteres, pero «é» son dos bytes: uno de más.
        padding = limit - others - len(head)
        (self.site / "js" / "c.js").write_text(head + "x" * (padding - 1) + "é", encoding="utf-8", newline="")
        result = self.run_loader()
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn(f"exceed {limit} bytes", result.stderr)

        (self.site / "js" / "c.js").write_text(SITE["js/c.js"], encoding="utf-8", newline="")
        vendor = self.site / "js" / "vendor" / "lib.js"
        for extra, code in ((0, 0), (1, 1)):
            with self.subTest(extra=extra):
                vendor.write_bytes(b"v" * (limit + extra))
                result = self.run_loader(zerochat.RUNNER_CACHE_ALWAYS_DOWNLOAD)
                self.assertEqual(result.returncode, code, result.stderr[-2000:])
                if code:
                    self.assertIn(f"exceed {limit} bytes", result.stderr)

    def test_la_copia_guardada_conserva_su_version_aunque_no_se_lea_la_publicada(self):
        self.publish("1.0.0")
        self.assertEqual(self.loaded()[0], "a+b+c")
        # Se corta la página y run-node.js, pero la librería llega: se guarda con la versión de la copia, no con null.
        RecordingSite.dropped = {"/zerochat.html", "/js/run-node.js"}
        value, stderr = self.loaded()
        self.assertEqual(value, "a+b+c")
        self.assertIn("using the cached copy", stderr)
        self.assertIn("/js/vendor/lib.js", RecordingSite.requests)
        cached = json.loads((self.cache_dir / "modules.json").read_text(encoding="utf-8"))
        self.assertEqual(cached["version"], "1.0.0")
        RecordingSite.dropped = set()
        self.assertIn("Using the cached modules of version 1.0.0", self.loaded()[1])


class FakeModel(BaseHTTPRequestHandler):
    """API compatible con OpenAI que responde siempre lo mismo, en streaming o no.

    Guarda el modelo de cada petición; si el último mensaje del usuario pide «cambia a <perfil>», el primer
    paso de ese turno llama a switch_model, «ejecuta X» a run_command con X y «lista» a list_directory.
    before_tool_reply, si está, se llama antes de responder a un paso que sigue a resultados de herramientas."""
    REPLY = "Hola desde el modelo falso"
    requests: list = []
    api_keys: list = []
    before_tool_reply = None

    def log_message(self, *_args):
        pass

    def _send(self, content_type: str, body: bytes):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._send("application/json", json.dumps({"data": [{"id": "fake"}]}).encode())

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        FakeModel.requests.append(request)
        FakeModel.api_keys.append(self.headers.get("Authorization"))
        last = request["messages"][-1]
        if last["role"] == "tool" and request.get("stream") and FakeModel.before_tool_reply:
            FakeModel.before_tool_reply()
        text = (last.get("content") or "") if last["role"] == "user" else ""
        switch = re.search(r"cambia a (\w+)", text)
        command = re.search(r"ejecuta (.+)", text)
        call = None
        if switch:
            call = {"index": 0, "id": "call_1", "type": "function",
                    "function": {"name": "switch_model", "arguments": json.dumps({"profile": switch.group(1)})}}
        elif command:
            call = {"index": 0, "id": "call_1", "type": "function",
                    "function": {"name": "run_command", "arguments": json.dumps({"command": command.group(1)})}}
        elif "lista" in text:
            call = {"index": 0, "id": "call_1", "type": "function",
                    "function": {"name": "list_directory", "arguments": json.dumps({"path": "."})}}
        if call and request.get("stream"):
            chunks = [{"choices": [{"index": 0, "delta": {"tool_calls": [call]}}]},
                      {"choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}]}]
            self._send("text/event-stream", b"".join(f"data: {json.dumps(chunk)}\n\n".encode() for chunk in chunks) + b"data: [DONE]\n\n")
            return
        if not request.get("stream"):
            message = {"role": "assistant", "content": self.REPLY}
            self._send("application/json", json.dumps({"choices": [{"index": 0, "message": message, "finish_reason": "stop"}]}).encode())
            return
        chunks = [{"choices": [{"index": 0, "delta": {"content": self.REPLY}}]},
                  {"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}]
        self._send("text/event-stream", b"".join(f"data: {json.dumps(chunk)}\n\n".encode() for chunk in chunks) + b"data: [DONE]\n\n")


class RealNodeRunTest(unittest.TestCase):
    """--prompt y --conversation de principio a fin con Node real: el cargador baja la interfaz del propio servidor
    de desarrollo y el runner, con su credencial limitada, guarda la conversación."""

    def setUp(self):
        use_data_dir(self)
        model = zerochat.ZeroChatHTTPServer(("127.0.0.1", 0), FakeModel)
        threading.Thread(target=model.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True).start()
        self.addCleanup(model.server_close)
        self.addCleanup(model.shutdown)
        api_url = f"http://127.0.0.1:{model.server_address[1]}/v1"
        zerochat.save_general_profile({"name": "local", "settings": {"apiType": "openai", "apiUrl": api_url, "model": "fake", "apiKey": "sk-local"}})
        zerochat.save_general_profile({"name": "Otro", "settings": {"apiType": "openai", "apiUrl": api_url, "model": "fake-otro", "apiKey": "sk-otro"}})
        FakeModel.requests = []
        FakeModel.api_keys = []
        FakeModel.before_tool_reply = None

    def run_zerochat(self, *args):
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        return subprocess.run([sys.executable, str(ZEROCHAT_PY), "--no-venv", "--port", str(port), *args],
                              capture_output=True, text=True, timeout=120)

    def test_prompt_guarda_una_conversacion_nueva_que_luego_continua(self):
        # 1. --prompt crea conversación nueva y cambia de perfil bajo demanda pidiendo solo la clave del que activa.
        first = self.run_zerochat("--prompt", "cambia a otro y saluda")
        self.assertEqual((first.returncode, first.stdout), (0, FakeModel.REPLY + "\n"), first.stderr)
        chat = [(request["model"], key) for request, key in zip(FakeModel.requests, FakeModel.api_keys) if request.get("stream")]
        self.assertEqual(chat, [("fake", "Bearer sk-local"), ("fake-otro", "Bearer sk-otro")])

        saved = zerochat.list_conversations()
        self.assertEqual(len(saved), 1)
        conversation_id = saved[0]["id"]
        self.assertRegex(conversation_id, r"^session_[0-9a-f-]{36}$")
        first_history = zerochat.get_conversation(conversation_id)["history"]
        switched = json.loads(next(message for message in first_history if message["role"] == "tool")["content"])
        self.assertEqual((switched["success"], switched["profile"], switched["model"]), (True, "Otro", "fake-otro"))

        # 2. --conversation continúa esa conversación, autoriza una sola vez la llamada aprobada y graba cada paso antes de acabar el turno.
        seen = []

        def saved_roles():
            for _ in range(400):
                history = zerochat.get_conversation(conversation_id)["history"]
                if sum(1 for message in history if message["role"] == "tool") == 2:
                    break
                threading.Event().wait(0.05)
            seen.append([message["role"] for message in history])

        FakeModel.before_tool_reply = saved_roles
        decision = {"toolName": "run_command", "args": {"command": "echo hola"}, "decision": "allow_once"}
        with mock.patch.dict(os.environ, {"ZEROCHAT_RUN_SECURITY": json.dumps({"tool_decision": decision})}):
            second = self.run_zerochat("--conversation", conversation_id, "--prompt", "ejecuta echo hola")
        self.assertEqual((second.returncode, second.stdout), (0, FakeModel.REPLY + "\n"), second.stderr)
        self.assertEqual(seen, [["user", "assistant", "tool", "assistant", "user", "assistant", "tool"]], second.stderr)
        history = zerochat.get_conversation(conversation_id)["history"]
        self.assertEqual([message["role"] for message in history],
                         ["user", "assistant", "tool", "assistant", "user", "assistant", "tool", "assistant"])
        tool_messages = [message for message in history if message["role"] == "tool"]
        self.assertIn("hola", tool_messages[-1]["content"])
        self.assertNotIn("403", tool_messages[-1]["content"])

    def test_prompt_y_conversation_aplican_entorno_de_proyecto_guardado(self):
        with tempfile.TemporaryDirectory() as proj_tmp:
            proj_path = Path(proj_tmp).resolve()
            proj_dir = str(proj_path)
            zerochat.save_project_environment(zerochat.SecurityContext(proj_path).key, {
                "systemDataPrompt": "Entorno exclusivo proyecto CLI",
                "enabledTools": {"search_web": False},
                "mcpServers": [],
                "browser": "none",
            })
            zerochat.save_conversation({"id": "conv_proj_env", "title": "Proyecto CLI", "project": proj_dir}, [
                {"id": "usr_1", "role": "user", "content": "primer turno"}
            ])
            res = self.run_zerochat("--conversation", "conv_proj_env", "--prompt", "hola")
        self.assertEqual((res.returncode, res.stdout), (0, FakeModel.REPLY + "\n"), res.stderr)
        stream_req = next(req for req in FakeModel.requests if req.get("stream"))
        system_text = "\n".join(str(m.get("content") or "") for m in stream_req["messages"] if m.get("role") == "system")
        tool_names = [tool["function"]["name"] for tool in stream_req.get("tools", [])]
        self.assertIn("Entorno exclusivo proyecto CLI", system_text)
        self.assertNotIn("search_web", tool_names)
        self.assertNotIn("browser_action", tool_names)

