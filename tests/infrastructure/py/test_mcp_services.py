import json
import os
import signal
import subprocess
import sys
import time
import unittest
from unittest.mock import Mock, patch

from backend import ZEROCHAT_PY, use_data_dir, zerochat

PUBLIC_TOOL_NAMES = ZEROCHAT_PY.parent / "tests" / "fixtures" / "mcp" / "public-tool-names.json"

HEALTHY_MCP = '''import json, sys
for line in sys.stdin:
    request = json.loads(line)
    method = request.get("method")
    if method == "initialize":
        result = {"protocolVersion": "2024-11-05", "capabilities": {}, "serverInfo": {"name": "healthy", "version": "1"}}
    elif method == "tools/list":
        result = {"tools": []}
    else:
        continue
    print(json.dumps({"jsonrpc": "2.0", "id": request.get("id"), "result": result}), flush=True)
'''

BROKEN_MCP = 'import sys\nprint("intentional MCP startup failure", file=sys.stderr, flush=True)\nsys.exit(3)\n'

LIMITS_MCP = '''import json, subprocess, sys, time
child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(100)"])
with open(sys.argv[1], "w") as pid_file:
    pid_file.write(str(child.pid))

def send(payload):
    sys.stdout.write(payload + "\\n")
    sys.stdout.flush()

for line in sys.stdin:
    request = json.loads(line)
    method, req_id = request.get("method"), request.get("id")
    if method == "initialize":
        result = {"protocolVersion": "2024-11-05", "capabilities": {}, "serverInfo": {"name": "limits", "version": "1"}}
    elif method == "tools/list":
        result = {"tools": [{"name": "big_head"}, {"name": "big_tail"}, {"name": "slow"}, {"name": "echo"}]}
    elif method == "tools/call":
        name = request["params"]["name"]
        content = {"content": [{"type": "text", "text": "x" * (5 * 1024 * 1024)}]}
        if name == "big_head":
            send(json.dumps({"jsonrpc": "2.0", "id": req_id, "result": content}))
            continue
        if name == "big_tail":
            send(json.dumps({"result": content, "jsonrpc": "2.0", "id": req_id}))
            continue
        if name == "slow":
            time.sleep(3)
        result = {"content": [{"type": "text", "text": "ok"}]}
    else:
        continue
    send(json.dumps({"jsonrpc": "2.0", "id": req_id, "result": result}))
'''


def capture_console(test) -> list:
    """Recoge lo que el backend escribe en la consola durante la prueba."""
    traces = []
    patcher = patch.object(zerochat, "console_log", lambda message, **_kwargs: traces.append(message))
    patcher.start()
    test.addCleanup(patcher.stop)
    return traces


def write_service(root, server_id, script_text, args=(), **launch):
    service_dir = root / server_id
    service_dir.mkdir(parents=True)
    entrypoint = service_dir / "server.py"
    entrypoint.write_text(script_text, encoding="utf-8")
    (service_dir / "service.json").write_text(json.dumps({
        "id": server_id,
        "launch": {"executable": sys.executable, "args": [str(entrypoint), *args], "cwd": str(service_dir), "env": {}, **launch},
    }), encoding="utf-8")


def status_of(manager, server_id):
    return next(item for item in manager.list_servers() if item["id"] == server_id)


class ManagedServicesTest(unittest.TestCase):
    def setUp(self):
        self.data_dir = use_data_dir(self)
        self.root = self.data_dir / "services"

    def test_reinstalar_los_archivos_gestionados_conserva_datos_y_servicios_del_usuario(self):
        zerochat.materialize_managed_services(self.root)
        managed_service = self.root / "playwright" / "service.json"
        runtime_marker = self.root / "playwright" / ".installed.json"
        user_service = self.root / "custom" / "service.json"
        managed_service.write_text("modified", encoding="utf-8")
        runtime_marker.write_text("keep", encoding="utf-8")
        user_service.parent.mkdir(parents=True)
        user_service.write_text('{"id":"custom"}', encoding="utf-8")

        zerochat.materialize_managed_services(self.root)

        # La copia de zerochat.py es la de services/: falla si se edita sin npm run build:backend.
        repo_services = ZEROCHAT_PY.parent / "services"
        for relative_path, content in zerochat.MANAGED_SERVICE_FILES.items():
            with self.subTest(path=relative_path):
                self.assertEqual((self.root / relative_path).read_text(encoding="utf-8"), content)
                self.assertEqual((repo_services / relative_path).read_text(encoding="utf-8"), content)
        self.assertEqual(runtime_marker.read_text(encoding="utf-8"), "keep")
        self.assertEqual(user_service.read_text(encoding="utf-8"), '{"id":"custom"}')

    def test_composio_se_lanza_con_su_cliente_oauth_y_el_protocolo_legacy(self):
        args = json.loads(zerochat.MANAGED_SERVICE_FILES["composio/service.json"])["launch"]["args"]
        self.assertEqual(json.loads(args[args.index("--static-oauth-client-metadata") + 1])["client_name"], "zerochat-mcp-remote")
        self.assertEqual(args[args.index("--protocol") + 1], "legacy")

    def test_las_trazas_ocultan_el_state_y_el_code_de_oauth(self):
        trace = zerochat._mcp_trace_text("https://auth.example/authorize?state=csrf-value&code=oauth-code&scope=openid")
        self.assertNotIn("csrf-value", trace)
        self.assertNotIn("oauth-code", trace)
        self.assertIn("scope=openid", trace)

    def test_un_mcp_propio_conserva_su_api_key_local_y_la_pasa_desde_launch_env(self):
        traces = capture_console(self)
        custom = self.root / "custom-key"
        custom.mkdir(parents=True)
        definition = {"id": "custom-key", "launch": {
            "executable": "${pythonExecutable}", "args": [],
            "env": {"SERVICE_API_KEY": "fixture-key", "HOME": "${serviceDir}"},
        }}
        config = custom / "service.json"
        config.write_text(json.dumps(definition), encoding="utf-8")
        config.chmod(0o600)
        manager = zerochat.McpServiceManager(self.root)
        self.addCleanup(manager.close)
        zerochat.materialize_managed_services(self.root)
        self.assertEqual(json.loads(config.read_text()), definition)
        self.assertEqual(config.stat().st_mode & 0o777, 0o600)
        client = Mock(tools=[])
        client.running.return_value = True
        with patch.dict(os.environ, {"SERVICE_API_KEY": "inherited-fixture"}), \
                patch.object(zerochat, "StdioMcpClient", return_value=client) as constructor:
            manager.start("custom-key", remember=True)
            env = constructor.call_args.args[3]
            self.assertEqual((env["SERVICE_API_KEY"], env["HOME"]), ("fixture-key", str(custom)))
            self.assertIn("PATH", env)
            self.assertEqual(os.environ["SERVICE_API_KEY"], "inherited-fixture")
            client.start.assert_called_once()
        self.assertNotIn("fixture-key", "".join(traces))
        self.assertEqual(status_of(manager, "custom-key")["status"], "running")


class ServiceStatusTest(unittest.TestCase):
    def test_el_estado_publico_sale_del_registro_y_de_si_el_proceso_sigue_vivo(self):
        Record = zerochat.McpServiceRecord
        # (registro, proceso vivo, código de salida) -> (estado, error)
        for record, alive, exit_code, expected in (
            (Record(), False, None, ("stopped", None)),
            (Record(phase="installing"), False, None, ("installing", None)),
            (Record(phase="starting"), True, None, ("starting", None)),
            (Record(phase="error", error="OAuth failed"), False, 1, ("error", "OAuth failed")),
            (Record(phase="running"), True, None, ("running", None)),
            (Record(phase="running"), False, 3, ("error", "MCP process exited with code 3")),
            (Record(phase="running"), False, 0, ("error", "MCP process exited with code 0")),
            (Record(phase="running"), False, None, ("error", "MCP process is not responding")),
        ):
            with self.subTest(phase=record.phase, alive=alive, exit_code=exit_code):
                self.assertEqual(zerochat.service_status(record, alive, exit_code), expected)

    def test_detener_o_cerrar_el_gestor_deja_el_servicio_detenido_y_sin_error(self):
        manager = zerochat.McpServiceManager(use_data_dir(self) / "services")
        self.addCleanup(manager.close)
        client = Mock(tools=[{"name": "lookup"}], oauth_url=None, process=None)
        client.running.return_value = True
        for action in (lambda: manager.stop("playwright"), manager.close):
            with self.subTest(action=action):
                manager.records["playwright"] = zerochat.McpServiceRecord(phase="running", client=client, browser={"mode": "user", "userBrowser": "chrome"})
                self.assertEqual((status_of(manager, "playwright")["status"], status_of(manager, "playwright")["toolCount"]), ("running", 1))
                client.stop.reset_mock()
                action()
                client.stop.assert_called_once()
                status = status_of(manager, "playwright")
                self.assertEqual((status["status"], status["error"], status["toolCount"], status["browser"]), ("stopped", None, 0, None))
                self.assertEqual(manager.tools(), [])


class RememberTest(unittest.TestCase):
    def setUp(self):
        data_dir = use_data_dir(self)
        self.root = data_dir / "services"
        self.preferences = data_dir / "config" / "services.json"
        (self.root / "demo").mkdir(parents=True)
        (self.root / "demo" / "service.json").write_text(json.dumps({"id": "demo", "launch": {"args": []}}), encoding="utf-8")

    def run_actions(self, remembered, actions, fails=False):
        """Aplica las acciones a un servicio con ese estado recordado de la sesión anterior y devuelve
        si queda recordado para la siguiente."""
        if remembered is not None:
            self.preferences.write_text(json.dumps({"demo": {"enabled": remembered}}), encoding="utf-8")
        client = Mock(tools=[], oauth_url=None, process=None)
        client.running.return_value = True
        if fails:
            client.start.side_effect = RuntimeError("handshake failed")
        manager = zerochat.McpServiceManager(self.root)
        self.addCleanup(manager.close)
        with patch.object(zerochat, "StdioMcpClient", return_value=client):
            for action, *remember in actions:
                if action == "start":
                    manager.start("demo", remember=remember[0])
                elif action == "stop":
                    manager.stop("demo")
                else:
                    # Reinicio de McpManager.withExternalServerStopped (js/mcp.js): arranca con el valor previo.
                    before = status_of(manager, "demo")["enabled"]
                    manager.stop("demo")
                    manager.start("demo", remember=before)
        return status_of(zerochat.McpServiceManager(self.root), "demo")["enabled"]

    def test_solo_un_arranque_con_remember_lo_recuerda_y_detenerlo_lo_olvida(self):
        # (descripción, recordado antes, acciones, recordado después)
        for name, remembered, actions, expected in (
            ("arranque desde Ajustes › MCP", None, [("start", True)], True),
            ("arranque sin remember", None, [("start", False)], False),
            ("arranque de un perfil sobre uno recordado", True, [("start", False)], True),
            ("arranque de un perfil sobre uno olvidado", False, [("start", False)], False),
            ("detener", True, [("start", False), ("stop",)], False),
            ("reinicio de uno recordado", True, [("start", False), ("restart",)], True),
            ("reinicio de uno arrancado por un perfil", None, [("start", False), ("restart",)], False),
            ("reinicio tras arrancarlo desde Ajustes", None, [("start", True), ("restart",)], True),
        ):
            with self.subTest(name):
                self.preferences.unlink(missing_ok=True)
                self.assertIs(self.run_actions(remembered, actions), expected)
        self.preferences.unlink()
        self.assertIs(self.run_actions(None, [("start", True)], fails=True), False, "un arranque fallido no se recuerda")


class McpStartTest(unittest.TestCase):
    def setUp(self):
        self.root = use_data_dir(self) / "services"
        self.traces = capture_console(self)

    def test_el_arranque_deja_traza_de_exito_y_de_fallo_en_la_consola(self):
        write_service(self.root, "healthy", HEALTHY_MCP, handshakeTimeoutSeconds=2)
        write_service(self.root, "broken", BROKEN_MCP, handshakeTimeoutSeconds=2)
        manager = zerochat.McpServiceManager(self.root)
        self.addCleanup(manager.close)
        self.assertEqual(next(item for item in manager.start("healthy", remember=True) if item["id"] == "healthy")["status"], "running")
        self.assertEqual(next(item for item in manager.start("broken", remember=True) if item["id"] == "broken")["status"], "error")
        time.sleep(0.1)
        manager.close()
        joined = "\n".join(self.traces)
        for trace in ("[MCP healthy] start requested", "[MCP healthy] launching:", "[MCP healthy] handshake completed",
                      "[MCP healthy] started successfully", "[MCP broken] stderr: intentional MCP startup failure",
                      "[MCP broken] start failed:"):
            self.assertIn(trace, joined)

    def test_la_instalacion_termina_en_starting_antes_del_handshake_oauth_y_conserva_errores_reales(self):
        custom = self.root / "oauth-fixture"
        custom.mkdir(parents=True)
        (custom / "service.json").write_text(json.dumps({"id": "oauth-fixture", "launch": {"args": [], "handshakeTimeoutSeconds": 150}}))
        manager = zerochat.McpServiceManager(self.root)
        self.addCleanup(manager.close)

        def prepare(server_id, server):
            self.assertEqual((status_of(manager, server_id)["status"], status_of(manager, server_id)["error"]), ("starting", None))
            manager.records[server_id].phase = "installing"
            self.assertEqual(status_of(manager, server_id)["status"], "installing")
            return {}

        for fail in (True, False):
            with self.subTest(fail=fail):
                manager.records["oauth-fixture"] = zerochat.McpServiceRecord(phase="error", error="Previous failure")
                client = Mock(tools=[])

                def handshake(timeout):
                    self.assertEqual(timeout, 150)
                    self.assertEqual((status_of(manager, "oauth-fixture")["status"], status_of(manager, "oauth-fixture")["error"]), ("starting", None))
                    if fail:
                        raise RuntimeError("OAuth failed")

                client.start.side_effect = handshake
                with patch.object(manager, "_prepare_service", side_effect=prepare), patch.object(zerochat, "StdioMcpClient", return_value=client):
                    manager.start("oauth-fixture", remember=True)
                status = status_of(manager, "oauth-fixture")
                self.assertEqual((status["status"], status["error"]), ("error", "OAuth failed") if fail else ("running", None))
                self.assertEqual(client.stop.call_count, 1 if fail else 0)


class McpToolsTest(unittest.TestCase):
    def setUp(self):
        self.manager = zerochat.McpServiceManager(use_data_dir(self) / "services")
        self.traces = capture_console(self)

    def test_public_tool_name_codifica_igual_que_el_navegador_la_tabla_compartida(self):
        # test_mcp.js comprueba la misma tabla contra publicToolName de js/mcp.js.
        for case in json.loads(PUBLIC_TOOL_NAMES.read_text(encoding="utf-8")):
            with self.subTest(server=case["server"], tool=case["tool"]):
                if case["expected"] is None:
                    with self.assertRaises(ValueError):
                        zerochat.public_tool_name(case["server"], case["tool"])
                else:
                    self.assertEqual(zerochat.public_tool_name(case["server"], case["tool"]), case["expected"])

    def test_una_llamada_a_herramienta_externa_no_bloquea_al_gestor_mientras_se_ejecuta(self):
        client = Mock(tools=[{"name": "lookup"}])
        client.running.return_value = True
        client.call_timeout = 30

        def request(method, params, timeout):
            self.assertFalse(self.manager._lock.locked(), "El lock del gestor no debe mantenerse durante la llamada")
            self.assertEqual((method, params, timeout), ("tools/call", {"name": "lookup", "arguments": {"q": 1}}, client.call_timeout))
            return {"content": []}

        client.request.side_effect = request
        self.manager.records["demo"] = zerochat.McpServiceRecord(phase="running", client=client)
        self.assertEqual(self.manager.call(zerochat.public_tool_name("demo", "lookup"), {"q": 1}), {"content": []})
        with self.assertRaises(ValueError):
            self.manager.call("demo_missing", {})

    def test_se_descartan_y_registran_nombres_publicos_invalidos_o_duplicados(self):
        client = Mock(tools=[{"name": "lookup"}, {"name": "lookup"}, {"name": "x" * 80}, {"name": ""}])
        client.running.return_value = True
        self.manager.records["demo"] = zerochat.McpServiceRecord(phase="running", client=client)
        self.assertEqual([tool["name"] for tool in self.manager.tools()], ["demo_lookup"])
        joined = "\n".join(self.traces)
        self.assertIn("duplicate public name demo_lookup", joined)
        self.assertEqual(joined.count("tool discarded"), 3)


class LocalToolArgumentsTest(unittest.TestCase):
    def test_los_argumentos_se_validan_contra_el_esquema_publicado(self):
        validate = zerochat.validate_local_tool_arguments
        self.assertIsNone(validate("edit_file", {"path": "a", "old_str": "x", "new_str": "y", "replace_all": True}))
        self.assertEqual(validate("run_command", {"command": "pwd", "cwd": "/tmp"}), "Argumento no permitido: cwd")
        self.assertEqual(validate("edit_file", {"path": "a", "old_str": "x"}), "Falta el argumento obligatorio: new_str")
        self.assertEqual(validate("edit_file", {"path": "a", "old_str": "x", "new_str": "y", "replace_all": "true"}), "Tipo inválido para 'replace_all'")
        self.assertEqual(validate("run_command", {"command": "pwd", "timeout_seconds": True}), "Tipo inválido para 'timeout_seconds'")


class StdioClientTest(unittest.TestCase):
    def test_detener_en_windows_elimina_el_arbol_de_procesos_sin_senales_posix(self):
        client = zerochat.StdioMcpClient(sys.executable, [], str(use_data_dir(self)), dict(os.environ))
        client.process = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(100)"])
        process = client.process
        self.addCleanup(process.wait)
        self.addCleanup(process.kill)
        calls = []
        real_run = subprocess.run

        def fake_run(cmd, *args, **kwargs):
            if cmd[0] != "taskkill":
                return real_run(cmd, *args, **kwargs)
            calls.append(cmd)
            os.kill(int(cmd[2]), signal.SIGTERM)
            return subprocess.CompletedProcess(cmd, 0)

        sigkill = getattr(signal, "SIGKILL", None)
        if sigkill is not None:
            del signal.SIGKILL
            self.addCleanup(setattr, signal, "SIGKILL", sigkill)
        with patch.object(zerochat, "DETECTED_OS", "windows"), patch.object(zerochat.subprocess, "run", side_effect=fake_run):
            client.stop()
        self.assertEqual(calls, [["taskkill", "/PID", str(process.pid), "/T", "/F"]])
        self.assertIsNotNone(process.poll())
        self.assertEqual((client.process, client.tools), (None, []))

    @unittest.skipIf(os.name == "nt", "Grupos de procesos POSIX")
    def test_acota_los_mensajes_aplica_el_plazo_del_servicio_informa_de_su_caida_y_termina_sus_descendientes(self):
        data_dir = use_data_dir(self)
        root = data_dir / "services"
        child_pid_file = data_dir / "child.pid"
        write_service(root, "limits", LIMITS_MCP, args=[str(child_pid_file)], handshakeTimeoutSeconds=5, callTimeoutSeconds=0.5)
        patcher = patch.object(zerochat.StdioMcpClient, "max_message_chars", 1024 * 1024)
        patcher.start()
        self.addCleanup(patcher.stop)
        manager = zerochat.McpServiceManager(root)
        self.addCleanup(manager.close)
        self.assertEqual(next(item for item in manager.start("limits", remember=True) if item["id"] == "limits")["status"], "running")
        client = manager.records["limits"].client
        self.assertEqual(client.call_timeout, 0.5)

        original_write = client._write

        def write_without_lock(payload):
            self.assertFalse(client._lock.locked(), "No se debe escribir en stdin con el cerrojo de peticiones tomado")
            original_write(payload)

        client._write = write_without_lock

        # Respuestas de 5 MB con el id al principio (SDK Python) o al final (SDK Node).
        for tool in ("big_head", "big_tail"):
            with self.subTest(tool=tool), self.assertRaisesRegex(RuntimeError, "exceeds"):
                manager.call(zerochat.public_tool_name("limits", tool), {})
        # El flujo sigue sincronizado tras descartar los mensajes grandes.
        self.assertEqual(manager.call(zerochat.public_tool_name("limits", "echo"), {})["content"][0]["text"], "ok")

        started = time.monotonic()
        with self.assertRaises(TimeoutError):
            manager.call(zerochat.public_tool_name("limits", "slow"), {})
        self.assertLess(time.monotonic() - started, 2)

        child_pid = int(child_pid_file.read_text())
        os.kill(child_pid, 0)
        # Si el proceso del servicio muere, deja de figurar en marcha y stop() limpia sus descendientes.
        client.process.kill()
        client.process.wait(timeout=5)
        crashed = status_of(manager, "limits")
        self.assertEqual((crashed["status"], crashed["toolCount"]), ("error", 0))
        self.assertTrue(crashed["error"].startswith("MCP process exited with code"))
        manager.stop("limits")
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                os.kill(child_pid, 0)
            except ProcessLookupError:
                return
            time.sleep(0.05)
        self.fail("stop() debe terminar los procesos hijos del MCP")
