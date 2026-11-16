import hashlib
import io
import json
import os
import signal
import subprocess
import sys
import threading
import time
import unittest
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import Mock, patch

from backend import ZEROCHAT_PY, use_data_dir, zerochat

PUBLIC_TOOL_NAMES = ZEROCHAT_PY.parent / "tests" / "fixtures" / "mcp" / "public-tool-names.json"
REPO_SERVICES = ZEROCHAT_PY.parent / "services"
CONTRACT = json.loads((ZEROCHAT_PY.parent / "tests" / "fixtures" / "mcp" / "contract.json").read_text(encoding="utf-8"))

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

    def test_composio_se_lanza_con_su_cliente_oauth_y_el_protocolo_legacy(self):
        args = json.loads((REPO_SERVICES / "composio" / "service.json").read_text(encoding="utf-8"))["launch"]["args"]
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


    def test_el_secreto_de_un_servicio_solo_llega_a_su_entorno_y_sin_el_no_arranca(self):
        traces = capture_console(self)
        service_dir = self.root / "brave"
        service_dir.mkdir(parents=True)
        (service_dir / "service.json").write_text(json.dumps({
            "id": "brave",
            "secrets": [{"name": "BRAVE_API_KEY", "label": {"es": "Clave", "en": "Key"}}, {"name": "no válido"}],
            "launch": {"executable": "${pythonExecutable}", "args": ["${secret:BRAVE_API_KEY}"],
                       "env": {"BRAVE_API_KEY": "${secret:BRAVE_API_KEY}"}},
        }), encoding="utf-8")
        manager = zerochat.McpServiceManager(self.root)
        self.addCleanup(manager.close)
        global_manager = patch.object(zerochat, "GLOBAL_MCP_MANAGER", manager)
        global_manager.start()
        self.addCleanup(global_manager.stop)
        client = Mock(tools=[])
        client.running.return_value = True

        # Sin la clave guardada no arranca y dice cuál falta; el listado solo dice si está guardada.
        with patch.object(zerochat, "StdioMcpClient", return_value=client) as constructor:
            manager.start("brave", remember=False)
            constructor.assert_not_called()
        self.assertIn("BRAVE_API_KEY", status_of(manager, "brave")["error"])
        self.assertEqual(status_of(manager, "brave")["secrets"], [{"name": "BRAVE_API_KEY", "label": {"es": "Clave", "en": "Key"}, "configured": False}])

        outcome, error, _ = zerochat.dispatch_server_control("zerochat/external/servers/secret", {"serverId": "brave", "name": "BRAVE_API_KEY", "value": "bsa-secreta"})
        self.assertIsNone(error)
        self.assertNotIn("bsa-secreta", json.dumps(outcome))
        self.assertTrue(status_of(manager, "brave")["secrets"][0]["configured"])
        with patch.object(zerochat, "StdioMcpClient", return_value=client) as constructor:
            manager.start("brave", remember=False)
            command, args, _cwd, env = constructor.call_args.args[:4]
        # En el entorno sí; en los argumentos, que se ven en la lista de procesos, no se sustituye.
        self.assertEqual(env["BRAVE_API_KEY"], "bsa-secreta")
        self.assertEqual(args, ["${secret:BRAVE_API_KEY}"])
        self.assertNotIn("bsa-secreta", "".join(traces))

        # Cambiar la clave detiene el servicio en marcha (su proceso tiene la anterior); borrarla lo deja sin poder arrancar.
        zerochat.dispatch_server_control("zerochat/external/servers/secret", {"serverId": "brave", "name": "BRAVE_API_KEY", "value": None})
        client.stop.assert_called()
        self.assertFalse(status_of(manager, "brave")["secrets"][0]["configured"])
        self.assertIsNone(zerochat.get_secret("mcp:brave:BRAVE_API_KEY"))

        # Solo los secretos que declara el servicio, y con un valor de texto no vacío y acotado.
        for params in ({"name": "OTRA_KEY", "value": "x"}, {"name": "BRAVE_API_KEY", "value": 3},
                       {"name": "BRAVE_API_KEY", "value": "  "},
                       {"name": "BRAVE_API_KEY", "value": "k" * (zerochat.MAX_SECRET_LENGTH + 1)}):
            with self.subTest(params=params):
                _, error, _ = zerochat.dispatch_server_control("zerochat/external/servers/secret", {"serverId": "brave", **params})
                self.assertEqual(error["code"], zerochat.INVALID_PARAMS)
        zerochat.dispatch_server_control("zerochat/external/servers/secret", {"serverId": "brave", "name": "BRAVE_API_KEY", "value": "k" * zerochat.MAX_SECRET_LENGTH})
        self.assertEqual(zerochat.get_secret("mcp:brave:BRAVE_API_KEY"), "k" * zerochat.MAX_SECRET_LENGTH)
        with zerochat.open_storage() as conn:
            stored = conn.execute("SELECT value FROM secrets;").fetchone()["value"]
        self.assertTrue(stored.startswith(zerochat.OBFUSCATION_PREFIX))


class QuietFiles(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


def service_definition(server_id, version, *args):
    return json.dumps({"id": server_id, "version": version, "launch": {"executable": sys.executable, "args": list(args)}})


class ServiceCatalogTest(unittest.TestCase):
    """Servicios incluidos que se actualizan desde services/manifest.json en la carpeta de la interfaz."""

    def setUp(self):
        data_dir = use_data_dir(self)
        self.root = data_dir / "services"
        self.site = data_dir / "site"
        self.site.mkdir()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietFiles, directory=str(self.site)))
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.base = zerochat.catalog_base(f"http://127.0.0.1:{self.server.server_address[1]}/zerochat.html#token=t")
        self.manager = zerochat.McpServiceManager(self.root)
        self.addCleanup(self.manager.close)
        self.traces = capture_console(self)

    def publish(self, services):
        """Publica en la interfaz los servicios {id: (versión, {ruta: texto})} y su catálogo."""
        catalog = {}
        for server_id, (version, files) in services.items():
            digests = {}
            for path, text in {"service.json": service_definition(server_id, version), **files}.items():
                target = self.site / "services" / server_id / path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(text.encode("utf-8"))
                digests[path] = hashlib.sha256(text.encode("utf-8")).hexdigest()
            catalog[server_id] = {"version": version, "files": digests}
        (self.site / "services" / "manifest.json").write_text(json.dumps({"schemaVersion": 1, "services": catalog}), encoding="utf-8")

    def installed(self, server_id, path):
        return (self.root / server_id / path).read_text(encoding="utf-8")

    def test_solo_se_actualizan_los_servicios_que_cambian_de_version_y_se_conservan_sus_datos(self):
        self.publish({"demo": ("1.0.0", {"README.md": "demo 1"}), "other": ("1.0.0", {"README.md": "other 1"})})
        self.assertEqual(self.manager.refresh_catalog(self.base), ["demo", "other"])
        self.assertEqual(self.installed("demo", "service.json"), service_definition("demo", "1.0.0"))
        data = {"demo/memory.jsonl": "data", "demo/.installed.json": "marker", "demo/node_modules/pkg/index.js": "pkg",
                "custom/service.json": '{"id":"custom"}'}
        for path, text in data.items():
            (self.root / path).parent.mkdir(parents=True, exist_ok=True)
            (self.root / path).write_text(text, encoding="utf-8")

        # Un fichero cambiado con la misma versión no se descarga.
        self.publish({"demo": ("1.0.0", {"README.md": "demo 1"}), "other": ("1.0.0", {"README.md": "other 1b"})})
        self.assertEqual(self.manager.refresh_catalog(self.base), [])
        self.assertEqual(self.installed("other", "README.md"), "other 1")

        self.publish({"demo": ("2.0.0", {"README.md": "demo 2"}), "other": ("1.0.0", {"README.md": "other 1b"})})
        self.assertEqual(self.manager.refresh_catalog(self.base), ["demo"])
        self.assertEqual(self.installed("demo", "README.md"), "demo 2")
        for path, text in data.items():
            self.assertEqual((self.root / path).read_text(encoding="utf-8"), text)
        self.assertEqual(sorted(server["id"] for server in self.manager.list_servers()), ["custom", "demo", "other"])

    def test_un_servicio_actualizado_en_marcha_se_reinicia_con_su_navegador_y_los_detenidos_no_arrancan(self):
        self.publish({"demo": ("1.0.0", {}), "idle": ("1.0.0", {})})
        self.manager.refresh_catalog(self.base)
        old = Mock(tools=[])
        old.running.return_value = True
        old.stop.side_effect = lambda: old.running.configure_mock(return_value=False)
        browser = {"mode": "own", "engine": "firefox"}
        self.manager.records["demo"] = zerochat.McpServiceRecord(phase="running", client=old, browser=browser)
        new = Mock(tools=[])
        new.running.return_value = True
        self.publish({"demo": ("2.0.0", {}), "idle": ("2.0.0", {})})
        with patch.object(zerochat, "StdioMcpClient", return_value=new) as constructor, \
                patch.object(self.manager, "_start_locked", wraps=self.manager._start_locked) as start:
            self.assertEqual(self.manager.refresh_catalog(self.base), ["demo", "idle"])
        old.stop.assert_called_once()
        start.assert_called_once_with("demo", False, browser)
        constructor.assert_called_once()
        new.start.assert_called_once()
        self.assertEqual(status_of(self.manager, "demo")["status"], "running")
        self.assertEqual(status_of(self.manager, "idle")["status"], "stopped")
        self.assertNotIn("demo", self.manager.preferences)

    def test_sin_catalogo_o_con_un_fichero_que_no_coincide_se_mantiene_lo_instalado(self):
        self.publish({"demo": ("1.0.0", {"README.md": "demo 1"}), "other": ("1.0.0", {})})
        self.manager.refresh_catalog(self.base)
        self.publish({"demo": ("2.0.0", {"README.md": "demo 2"}), "other": ("2.0.0", {})})
        (self.site / "services" / "demo" / "README.md").write_text("tampered", encoding="utf-8")
        self.assertEqual(self.manager.refresh_catalog(self.base), ["other"])
        self.assertEqual(self.installed("demo", "README.md"), "demo 1")
        self.assertEqual(json.loads(self.installed("demo", "service.json"))["version"], "1.0.0")
        self.assertIn("demo/README.md no coincide con la huella del catálogo", "\n".join(self.traces))

        self.server.shutdown()
        self.server.server_close()
        self.assertEqual(self.manager.refresh_catalog(self.base), [])
        self.assertIn("se usan los servicios instalados", self.traces[-1])
        self.assertEqual(sorted(server["id"] for server in self.manager.list_servers()), ["demo", "other"])

    def test_el_catalogo_no_admite_rutas_fuera_del_servicio_ni_ocultas(self):
        digest = "0" * 64
        def catalog(server_id="demo", files=None, schema=1):
            files = {"service.json": digest, **(files or {})}
            return json.dumps({"schemaVersion": schema, "services": {server_id: {"version": "1", "files": files}}}).encode()
        self.assertEqual(list(zerochat.parse_catalog(catalog(files={"sub/server.py": digest}))), ["demo"])
        invalid = {
            "ruta que sube": catalog(files={"../other/service.json": digest}),
            "segmento ..": catalog(files={"sub/../../x": digest}),
            "ruta absoluta": catalog(files={"/etc/x": digest}),
            "fichero oculto": catalog(files={".installed.json": digest}),
            "id con ruta": catalog(server_id="../demo"),
            "huella no válida": catalog(files={"README.md": "x"}),
            "sin service.json": json.dumps({"schemaVersion": 1, "services": {"demo": {"version": "1", "files": {}}}}).encode(),
            "otra versión del catálogo": catalog(schema=2),
        }
        for label, raw in invalid.items():
            with self.subTest(label), self.assertRaises(ValueError):
                zerochat.parse_catalog(raw)

    def test_cada_descarga_admite_catalog_max_bytes_y_uno_mas_se_rechaza(self):
        (self.site / "file").write_bytes(b"x" * 64)
        url = self.base + "file"
        with patch.object(zerochat, "CATALOG_MAX_BYTES", 64):
            self.assertEqual(len(zerochat.download(url)), 64)
        with patch.object(zerochat, "CATALOG_MAX_BYTES", 63), self.assertRaisesRegex(ValueError, "excede 63 bytes"):
            zerochat.download(url)

    def test_el_catalogo_del_repositorio_esta_al_dia_con_services(self):
        catalog = zerochat.parse_catalog((REPO_SERVICES / "manifest.json").read_bytes())
        self.assertEqual(sorted(catalog), sorted(d.name for d in REPO_SERVICES.iterdir() if (d / "service.json").is_file()))
        for server_id, entry in catalog.items():
            definition = json.loads((REPO_SERVICES / server_id / "service.json").read_text(encoding="utf-8"))
            self.assertEqual(entry["version"], definition["version"], server_id)
            for path, digest in entry["files"].items():
                # Con LF, como se publica, también en un checkout de Windows que lo pase a CRLF.
                data = (REPO_SERVICES / server_id / path).read_bytes().replace(b"\r\n", b"\n")
                self.assertEqual(hashlib.sha256(data).hexdigest(), digest, f"{server_id}/{path}: npm run build:managed-services")


class ServiceStatusTest(unittest.TestCase):
    def test_el_estado_publico_sale_del_registro_y_de_si_el_proceso_sigue_vivo(self):
        Record = zerochat.McpServiceRecord
        # (registro, proceso vivo, código de salida) -> (estado, error)
        table = (
            (Record(), False, None, ("stopped", None)),
            (Record(phase="installing"), False, None, ("installing", None)),
            (Record(phase="starting"), True, None, ("starting", None)),
            (Record(phase="error", error="OAuth failed"), False, 1, ("error", "OAuth failed")),
            (Record(phase="running"), True, None, ("running", None)),
            (Record(phase="running"), False, 3, ("error", "MCP process exited with code 3")),
            (Record(phase="running"), False, 0, ("error", "MCP process exited with code 0")),
            (Record(phase="running"), False, None, ("error", "MCP process is not responding")),
        )
        for record, alive, exit_code, expected in table:
            with self.subTest(phase=record.phase, alive=alive, exit_code=exit_code):
                self.assertEqual(zerochat.service_status(record, alive, exit_code), expected)
        # Los estados que clasifica js/mcp-status.js (tests/unit/test_ui_mcp.js).
        self.assertEqual({expected[0] for *_, expected in table}, set(CONTRACT["serviceStatuses"]))

    def test_detener_o_cerrar_el_gestor_deja_el_servicio_detenido_y_sin_error(self):
        root = use_data_dir(self) / "services"
        write_service(root, "demo", HEALTHY_MCP)
        manager = zerochat.McpServiceManager(root)
        self.addCleanup(manager.close)
        client = Mock(tools=[{"name": "lookup"}], oauth_url=None, process=None)
        client.running.return_value = True
        for action in (lambda: manager.stop("demo"), manager.close):
            with self.subTest(action=action):
                manager.records["demo"] = zerochat.McpServiceRecord(phase="running", client=client, browser={"mode": "user", "userBrowser": "chrome"})
                self.assertEqual((status_of(manager, "demo")["status"], status_of(manager, "demo")["toolCount"]), ("running", 1))
                client.stop.reset_mock()
                action()
                client.stop.assert_called_once()
                status = status_of(manager, "demo")
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
        limit = zerochat.CHECK_PATTERN_MAX_CHARS
        self.assertIsNone(validate("check_command", {"job_id": 1, "pattern": "a" * limit}))
        self.assertEqual(validate("check_command", {"job_id": 1, "pattern": "a" * (limit + 1)}), "'pattern' excede el tamaño máximo permitido")
        # Un tipo que el validador no conoce se rechaza como error de validación, no con una excepción.
        definition = {"name": "demo_tool", "inputSchema": {"type": "object", "properties": {"items": {"type": "array"}}}}
        with patch.object(zerochat, "LOCAL_TOOLS_DEFINITIONS", [*zerochat.LOCAL_TOOLS_DEFINITIONS, definition]):
            self.assertEqual(validate("demo_tool", {"items": []}), "Tipo no admitido en la definición de 'items': array")


class StdioClientTest(unittest.TestCase):
    def test_un_mensaje_de_max_mcp_message_chars_cabe_y_uno_mas_se_descarta(self):
        limit = zerochat.StdioMcpClient.max_message_chars
        self.assertEqual(limit, zerochat.MAX_MCP_MESSAGE_CHARS)
        line, tail = zerochat._read_bounded_line(io.StringIO("a" * limit + "\n" + "{}\n"), limit)
        self.assertEqual((len(line), tail), (limit + 1, None))
        # El exceso se consume hasta el salto de línea: el mensaje siguiente llega entero.
        stream = io.StringIO("a" * limit + "b\n" + "{}\n")
        line, tail = zerochat._read_bounded_line(stream, limit)
        self.assertEqual(len(line), limit)
        self.assertIsNotNone(tail, "El exceso debe marcarse para descartar el mensaje")
        self.assertEqual(zerochat._read_bounded_line(stream, limit), ("{}\n", None))

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
