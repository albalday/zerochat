import json
import os
import re
import socket
import subprocess
import sys
import threading
import unittest
from functools import partial
from http.server import BaseHTTPRequestHandler, SimpleHTTPRequestHandler, ThreadingHTTPServer
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


class RunnerLoaderTest(unittest.TestCase):
    def setUp(self):
        base = use_data_dir(self)
        self.site = base / "site"
        for name, text in SITE.items():
            (self.site / name).parent.mkdir(parents=True, exist_ok=True)
            (self.site / name).write_text(text, encoding="utf-8")
        self.cache_dir = base / "cache"
        self.cache_dir.mkdir()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), partial(Quiet, directory=str(self.site)))
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/zerochat.html#run=r1"

    def go_offline(self):
        """Sin servidor que escuche: la conexión se rechaza, como sin red."""
        self.server.shutdown()
        self.server.server_close()

    def run_loader(self):
        node = zerochat.find_node_executable()
        cmd = [node, "--permission", f"--allow-fs-read={self.cache_dir}", f"--allow-fs-write={self.cache_dir}",
               "-e", zerochat.RUNNER_LOADER_SCRIPT, str(self.cache_dir / "modules.json"), self.url]
        return subprocess.run(cmd, capture_output=True, text=True, timeout=30)

    def test_descarga_los_modulos_y_sin_conexion_usa_la_ultima_copia(self):
        online = self.run_loader()
        self.assertEqual(online.returncode, 0, online.stderr)
        self.assertEqual(json.loads(online.stdout), {"a": "a+b+c", "argv": [self.url], "vendor": "vendor-v1", "node": "function"})
        cached = json.loads((self.cache_dir / "modules.json").read_text(encoding="utf-8"))
        self.assertEqual(sorted(cached["files"]), sorted(SITE))

        # Una copia nueva publicada sustituye a la guardada.
        (self.site / "js" / "c.js").write_text("module.exports = { value: 'c2' };", encoding="utf-8")
        self.assertEqual(json.loads(self.run_loader().stdout)["a"], "a+b+c2")

        self.go_offline()
        offline = self.run_loader()
        self.assertEqual(offline.returncode, 0, offline.stderr)
        self.assertEqual(json.loads(offline.stdout)["a"], "a+b+c2")
        self.assertIn("using the cached copy", offline.stderr)

    def test_una_respuesta_de_error_no_ejecuta_la_copia_guardada(self):
        self.assertEqual(self.run_loader().returncode, 0)
        (self.site / "js" / "tools" / "b.js").unlink()
        result = self.run_loader()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        self.assertIn("js/tools/b.js: HTTP 404", result.stderr)

    def test_sin_conexion_ni_copia_guardada_falla(self):
        self.go_offline()
        result = self.run_loader()
        self.assertEqual(result.returncode, 1)
        self.assertIn("Fatal error", result.stderr)

    def test_lo_descargado_tiene_tope_de_tamano(self):
        others = sum(len(text) for name, text in SITE.items() if name not in ("js/c.js", "js/vendor/lib.js"))
        head = "module.exports = { value: 'c' };//"
        for extra, code in ((0, 0), (1, 1)):
            with self.subTest(extra=extra):
                padding = zerochat.RUNNER_MAX_BYTES - others - len(head) + extra
                (self.site / "js" / "c.js").write_text(head + "x" * padding, encoding="utf-8")
                result = self.run_loader()
                self.assertEqual(result.returncode, code, result.stderr)
                if code:
                    self.assertIn(f"exceed {zerochat.RUNNER_MAX_BYTES} bytes", result.stderr)


class FakeModel(BaseHTTPRequestHandler):
    """API compatible con OpenAI que responde siempre lo mismo, en streaming o no.

    Guarda el modelo de cada petición; si el último mensaje del usuario pide «cambia a <perfil>», el primer
    paso de ese turno llama a switch_model, y «ejecuta X» a run_command con X."""
    REPLY = "Hola desde el modelo falso"
    requests: list = []

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
        last = request["messages"][-1]
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
        model = ThreadingHTTPServer(("127.0.0.1", 0), FakeModel)
        threading.Thread(target=model.serve_forever, daemon=True).start()
        self.addCleanup(model.server_close)
        self.addCleanup(model.shutdown)
        api_url = f"http://127.0.0.1:{model.server_address[1]}/v1"
        zerochat.save_general_profile({"name": "local", "settings": {"apiType": "openai", "apiUrl": api_url, "model": "fake"}})
        zerochat.save_general_profile({"name": "Otro", "settings": {"apiType": "openai", "apiUrl": api_url, "model": "fake-otro"}})
        FakeModel.requests = []

    def run_zerochat(self, *args):
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        return subprocess.run([sys.executable, str(ZEROCHAT_PY), "--no-venv", "--port", str(port), *args],
                              capture_output=True, text=True, timeout=120)

    def test_prompt_guarda_una_conversacion_nueva_que_luego_continua(self):
        first = self.run_zerochat("--prompt", "di hola")
        self.assertEqual((first.returncode, first.stdout), (0, FakeModel.REPLY + "\n"), first.stderr)
        saved = zerochat.list_conversations()
        self.assertEqual(len(saved), 1)
        conversation_id = saved[0]["id"]
        self.assertRegex(conversation_id, r"^session_[0-9a-f-]{36}$")

        second = self.run_zerochat("--conversation", conversation_id, "--prompt", "otra vez")
        self.assertEqual((second.returncode, second.stdout), (0, FakeModel.REPLY + "\n"), second.stderr)
        history = zerochat.get_conversation(conversation_id)["history"]
        self.assertEqual([message["role"] for message in history], ["user", "assistant", "user", "assistant"])

    def test_switch_model_cambia_a_otro_perfil_del_servidor(self):
        result = self.run_zerochat("--prompt", "cambia a otro y saluda")
        self.assertEqual((result.returncode, result.stdout), (0, FakeModel.REPLY + "\n"), result.stderr)
        chat = [request for request in FakeModel.requests if request.get("stream")]
        self.assertEqual([request["model"] for request in chat], ["fake", "fake-otro"])
        history = zerochat.get_conversation(zerochat.list_conversations()[0]["id"])["history"]
        switched = json.loads(next(message for message in history if message["role"] == "tool")["content"])
        self.assertEqual((switched["success"], switched["profile"], switched["model"]), (True, "Otro", "fake-otro"))

    def test_conversation_ejecuta_una_sola_vez_la_llamada_aprobada_al_reanudar(self):
        # La credencial del runner no puede resolver retos: la llamada aprobada la contesta el servidor de la ejecución.
        zerochat.save_conversation({"id": "session_once", "title": "una vez"}, [])
        decision = {"toolName": "run_command", "args": {"command": "echo hola"}, "decision": "allow_once"}
        with mock.patch.dict(os.environ, {"ZEROCHAT_RUN_SECURITY": json.dumps({"tool_decision": decision})}):
            result = self.run_zerochat("--conversation", "session_once", "--prompt", "ejecuta echo hola")
        self.assertEqual((result.returncode, result.stdout), (0, FakeModel.REPLY + "\n"), result.stderr)
        tool = next(message for message in zerochat.get_conversation("session_once")["history"] if message["role"] == "tool")
        self.assertIn("hola", tool["content"])
        self.assertNotIn("403", tool["content"])

