import io
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock
from backend import use_data_dir, zerochat

# Proyecto de la petición, distinto del proyecto por defecto del servidor.
CTX = zerochat.SecurityContext(Path(tempfile.gettempdir()).resolve())


def dispatch_run(method, params):
    return zerochat.dispatch_run(method, params, CTX)


class ServerRunsInfrastructureTest(unittest.TestCase):
    def setUp(self):
        self.data_dir = use_data_dir(self)
        self.runs_dir = self.data_dir / "runs"

    def tearDown(self):
        zerochat.RUN_SESSION = None

    def test_fichero_situacion_permisos_estructura_topes_y_ciclo_de_vida(self):
        conv_id = "session_test_run_123"
        session = zerochat.RunSession(
            conversation_id=conv_id,
            run_id="run_custom_test_abc",
            tool_security={"directoryRules": ["R:/workspace"], "tool_decision": {"toolName": "write_file", "args": {}, "decision": "allow_once"}}
        )
        state_path = zerochat.get_run_state_path(conv_id)
        self.assertTrue(state_path.exists())
        if os.name != "nt":
            self.assertEqual(stat.S_IMODE(self.runs_dir.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(state_path.stat().st_mode), 0o600)

        data = json.loads(state_path.read_text("utf-8"))
        self.assertEqual(data["run_id"], "run_custom_test_abc")
        self.assertEqual(data["conversation_id"], conv_id)
        self.assertEqual(data["status"], "running")
        self.assertEqual(data["step_text"], "")
        self.assertIsNone(data["pending"])
        self.assertIsNone(data["error"])
        self.assertEqual(data["pid"], os.getpid())

        # zerochat/run/prompt entrega conversation_id y nada de tool_security, que aplica este servidor.
        zerochat.RUN_SESSION = session
        prompt_res, err, _ = dispatch_run("zerochat/run/prompt", {"run_id": session.run_id})
        self.assertIsNone(err)
        self.assertEqual(prompt_res["conversation_id"], conv_id)
        self.assertNotIn("tool_security", prompt_res)
        self.assertNotIn("tool_decision", prompt_res)

        # zerochat/run/progress actualiza el paso con borde exacto N (500) y N+1 (501)
        dispatch_run("zerochat/run/progress", {
            "run_id": session.run_id,
            "kind": "tool",
            "text": "a" * zerochat.RUN_PROGRESS_TEXT_MAX
        })
        self.assertEqual(json.loads(state_path.read_text("utf-8"))["step_text"], "a" * zerochat.RUN_PROGRESS_TEXT_MAX)
        prog_res, err, _ = dispatch_run("zerochat/run/progress", {
            "run_id": session.run_id,
            "kind": "tool",
            "text": "b" * (zerochat.RUN_PROGRESS_TEXT_MAX + 1)
        })
        self.assertEqual((err, prog_res), (None, {"ok": True}))
        self.assertEqual(json.loads(state_path.read_text("utf-8"))["step_text"], ("b" * zerochat.RUN_PROGRESS_TEXT_MAX) + "…")

        # zerochat/run/result con needs_input guarda estado needs_input y pending
        res_outcome, err, _ = dispatch_run("zerochat/run/result", {
            "run_id": session.run_id,
            "needs_input": {"kind": "ask_user", "question": "¿Deseas continuar?"}
        })
        self.assertIsNone(err)
        self.assertEqual(res_outcome, {"ok": True})
        self.assertTrue(session.finished.is_set())

        data = json.loads(state_path.read_text("utf-8"))
        self.assertEqual(data["status"], "needs_input")
        self.assertEqual(data["pending"], {"kind": "ask_user", "question": "¿Deseas continuar?"})
        self.assertTrue(state_path.exists())

        # run_outcome con needs_input devuelve código 0 y JSON en text
        code, text = zerochat.run_outcome(session)
        self.assertEqual(code, zerochat.RUN_EXIT_DONE)
        self.assertEqual(json.loads(text), {"kind": "ask_user", "question": "¿Deseas continuar?"})

        # Nueva sesión con resultado error actualiza el fichero de situación
        session_err = zerochat.RunSession(conversation_id=conv_id)
        zerochat.RUN_SESSION = session_err
        dispatch_run("zerochat/run/result", {
            "run_id": session_err.run_id,
            "error": "Modelo no disponible"
        })
        self.assertTrue(state_path.exists())
        data_err = json.loads(state_path.read_text("utf-8"))
        self.assertEqual(data_err["status"], "error")
        self.assertEqual(data_err["error"], "Modelo no disponible")

        # Nueva sesión con resultado text elimina el fichero de situación al completarse
        session2 = zerochat.RunSession(conversation_id=conv_id)
        self.assertTrue(state_path.exists())
        zerochat.RUN_SESSION = session2
        dispatch_run("zerochat/run/result", {
            "run_id": session2.run_id,
            "text": "Respuesta final completa."
        })
        self.assertFalse(state_path.exists())

    def test_cli_argumentos_conversation(self):
        # Crear perfil por defecto local para pruebas CLI
        zerochat.save_general_profile({"name": "local", "settings": {}})
        parser = zerochat.build_parser()

        # Conversación inexistente rechaza con código 4 (RUN_EXIT_ARGS)
        with self.assertRaises(SystemExit) as cm:
            zerochat.run_session_from_args(parser, parser.parse_args(["--conversation", "no_existe_123"]))
        self.assertEqual(cm.exception.code, zerochat.RUN_EXIT_ARGS)

        # ID vacío rechaza con código 4
        with self.assertRaises(SystemExit) as cm:
            zerochat.run_session_from_args(parser, parser.parse_args(["--conversation", "   "]))
        self.assertEqual(cm.exception.code, zerochat.RUN_EXIT_ARGS)

        # Conversación existente vacía (solo system) sin --prompt rechaza con código 4
        zerochat.save_conversation({"id": "conv_vacia", "title": "Vacía"}, [
            {"id": "sys_1", "role": "system", "content": "Prompt base"}
        ])
        with self.assertRaises(SystemExit) as cm:
            zerochat.run_session_from_args(parser, parser.parse_args(["--conversation", "conv_vacia"]))
        self.assertEqual(cm.exception.code, zerochat.RUN_EXIT_ARGS)

        # Conversación existente con mensaje user sin --prompt se acepta
        zerochat.save_conversation({"id": "conv_con_user", "title": "Con turno"}, [
            {"id": "sys_1", "role": "system", "content": "Prompt base"},
            {"id": "usr_1", "role": "user", "content": "¿Qué hora es?"}
        ])
        session = zerochat.run_session_from_args(parser, parser.parse_args(["--conversation", "conv_con_user"]))
        self.assertIsNotNone(session)
        self.assertIsNone(session.prompt)
        self.assertEqual(session.conversation_id, "conv_con_user")
        self.assertEqual(session.profile, "local")

        # --conversation no se aprueba solo: con --allow-dangerous-tools es un error de argumentos, con o sin --prompt.
        for extra in ([], ["--prompt", "sigue"]):
            with self.subTest(extra=extra), self.assertRaises(SystemExit) as cm:
                zerochat.run_session_from_args(parser, parser.parse_args(["--conversation", "conv_con_user", "--allow-dangerous-tools", *extra]))
            self.assertEqual(cm.exception.code, zerochat.RUN_EXIT_ARGS)

        # Conversación con profileId resuelve su propio perfil general sin --profile explícito
        zerochat.save_general_profile({"name": "test-cron-profile", "settings": {}})
        zerochat.save_conversation({"id": "conv_con_perfil", "title": "Con perfil propio", "profileId": "test-cron-profile"}, [
            {"id": "sys_1", "role": "system", "content": "Prompt base"},
            {"id": "usr_2", "role": "user", "content": "¿Cuál es mi perfil?"}
        ])
        session_perfil = zerochat.run_session_from_args(parser, parser.parse_args(["--conversation", "conv_con_perfil"]))
        self.assertIsNotNone(session_perfil)
        self.assertEqual(session_perfil.profile, "test-cron-profile")
        conv_updated = zerochat.get_conversation("conv_con_perfil")
        self.assertEqual(conv_updated.get("serverRun"), True)

        # Conversación cuyo perfil asociado no existe termina con error de argumentos
        zerochat.save_conversation({"id": "conv_con_perfil_inexistente", "title": "Perfil roto", "profileId": "fantasma"}, [
            {"id": "usr_1", "role": "user", "content": "test"}
        ])
        with self.assertRaises(SystemExit):
            with mock.patch("sys.stderr", io.StringIO()):
                zerochat.run_session_from_args(parser, parser.parse_args(["--conversation", "conv_con_perfil_inexistente"]))

        # Conversación con --prompt se acepta
        session_with_prompt = zerochat.run_session_from_args(parser, parser.parse_args([
            "--conversation", "conv_vacia",
            "--prompt", "Nuevo prompt"
        ]))
        self.assertIsNotNone(session_with_prompt)
        self.assertEqual(session_with_prompt.prompt, "Nuevo prompt")
        self.assertEqual(session_with_prompt.conversation_id, "conv_vacia")

    def test_supervisor_detiene_y_registra_error_si_cierra_sin_resultado(self):
        conv_id = "session_supervisor_test"
        session = zerochat.RunSession(conversation_id=conv_id)
        state_path = zerochat.get_run_state_path(conv_id)
        self.assertTrue(state_path.exists())

        limit = zerochat.RUNNER_ERROR_TAIL_BYTES
        for written, kept in ((limit, limit), (limit + 1, limit), (0, 0)):
            with self.subTest(written=written), tempfile.TemporaryFile() as log:
                text = ("x" * (written - 6) + "Error!") if written else ""
                log.write(text.encode("utf-8"))
                log.flush()
                reason = zerochat.runner_exit_reason(mock.Mock(returncode=3), log)
                prefix = "El runner de Node.js terminó con el código 3 sin resultado"
                self.assertEqual(reason, f"{prefix}: {text[-kept:]}" if kept else f"{prefix}.")

        # Parar el servidor de verdad marcaría el apagado global para el resto de la suite.
        with tempfile.TemporaryFile() as log, mock.patch.object(zerochat, "stop_zerochat_server"):
            log.write(b"Error fatal en runner")
            log.flush()
            mock_proc = mock.Mock(returncode=3)
            mock_proc.poll.return_value = 3
            zerochat.run_supervisor(mock.Mock(), session, runner_proc=mock_proc, runner_log=log)
        data = json.loads(state_path.read_text("utf-8"))
        self.assertEqual(data["status"], "error")
        self.assertEqual(data["error"], "El runner de Node.js terminó con el código 3 sin resultado: Error fatal en runner")

    def test_el_runner_exige_node_22_13_o_superior(self):
        def found(version):
            result = zerochat.subprocess.CompletedProcess(["node", "--version"], 0, stdout=f"{version}\n", stderr="")
            with mock.patch.object(zerochat.shutil, "which", return_value="/usr/bin/node"), \
                 mock.patch.object(zerochat.subprocess, "run", return_value=result):
                return zerochat.find_node_executable()

        self.assertIsNone(found("v21.7.3"))
        self.assertIsNone(found("v22.12.9"))
        self.assertEqual(found("v22.13.0"), "/usr/bin/node")
        self.assertEqual(found("v24.0.0"), "/usr/bin/node")

    def test_launch_node_runner_usa_modelo_de_permisos(self):
        url = "http://127.0.0.1:9999/zerochat.html#run=r1"
        cache_dir = self.data_dir / "cache" / "runner"
        # Instalado ejecuta la caché de la versión publicada; en el repositorio de desarrollo descarga siempre.
        for dev_root, policy in ((None, zerochat.RUNNER_CACHE_BY_VERSION), (Path("/repo"), zerochat.RUNNER_CACHE_ALWAYS_DOWNLOAD)):
            with self.subTest(policy=policy), mock.patch.object(zerochat, "get_dev_root", return_value=dev_root), \
                    mock.patch.object(zerochat, "find_node_executable", return_value="/usr/bin/node"), \
                    mock.patch("subprocess.Popen", return_value=mock.Mock()) as popen:
                _proc, stderr_log = zerochat.launch_node_runner(url)
                self.addCleanup(stderr_log.close)
                self.assertIs(popen.call_args.kwargs["stderr"], stderr_log)
                # Del disco solo toca su caché; ni procesos, ni workers, ni inspector.
                self.assertEqual(popen.call_args.args[0], [
                    "/usr/bin/node", "--permission", f"--allow-fs-read={cache_dir}", f"--allow-fs-write={cache_dir}",
                    "-e", zerochat.RUNNER_LOADER_SCRIPT, str(cache_dir / "modules.json"), url, policy,
                ])
        if os.name != "nt":
            self.assertEqual(stat.S_IMODE(cache_dir.stat().st_mode), 0o700)

    def test_list_server_runs_orden_focus_proceso_muerto_y_aislamiento_worker(self):
        runs, focus = zerochat.list_server_runs()
        self.assertEqual(runs, [])
        self.assertIsNone(focus)

        now = int(time.time() * 1000)
        state1 = {
            "run_id": "run_1",
            "conversation_id": "conv_1",
            "pid": os.getpid(),
            "started_at": now + 100,
            "updated_at": now + 100,
            "status": "running",
            "step_text": "step 1",
            "pending": None,
            "error": None
        }
        state2 = {
            "run_id": "run_2",
            "conversation_id": "conv_2",
            "pid": os.getpid(),
            "started_at": now,
            "updated_at": now,
            "status": "needs_input",
            "step_text": "step 2",
            "pending": {"kind": "ask_user", "text": "confirm?"},
            "error": None
        }
        state_dead = {
            "run_id": "run_dead",
            "conversation_id": "conv_dead",
            "pid": 4194304,
            "started_at": now + 200,
            "updated_at": now + 200,
            "status": "running",
            "step_text": "in progress",
            "pending": None,
            "error": None
        }
        zerochat.get_run_state_path("conv_1").write_text(json.dumps(state1), encoding="utf-8")
        zerochat.get_run_state_path("conv_2").write_text(json.dumps(state2), encoding="utf-8")
        path_dead = zerochat.get_run_state_path("conv_dead")
        path_dead.write_text(json.dumps(state_dead), encoding="utf-8")

        runs, focus = zerochat.list_server_runs(focus_conversation_id="conv_1")
        self.assertEqual(len(runs), 3)
        self.assertEqual(runs[0], {"conversation_id": "conv_2", "run_id": "run_2", "status": "needs_input"})
        self.assertEqual(runs[1], {"conversation_id": "conv_1", "run_id": "run_1", "status": "running"})
        self.assertEqual(runs[2], {"conversation_id": "conv_dead", "run_id": "run_dead", "status": "error"})
        self.assertIsNotNone(focus)
        self.assertEqual(focus["conversation_id"], "conv_1")
        self.assertEqual(focus["step_text"], "step 1")
        # Sin la conversación en SQLite no hay fecha de grabación; con ella, la de su último guardado.
        self.assertIsNone(focus["conversation_updated_at"])
        zerochat.save_conversation({"id": "conv_1", "title": "uno", "updatedAt": now + 500}, [])
        _, focus = zerochat.list_server_runs(focus_conversation_id="conv_1")
        self.assertEqual(focus["conversation_updated_at"], now + 500)

        _, focus_miss = zerochat.list_server_runs(focus_conversation_id="conv_otro")
        self.assertIsNone(focus_miss)

        disk_dead = json.loads(path_dead.read_text("utf-8"))
        self.assertEqual(disk_dead["status"], "error")
        self.assertIn("inesperadamente", disk_dead["error"])

        # En un servidor worker (RUN_SESSION activo), list_server_runs devuelve ([], None)
        zerochat.RUN_SESSION = zerochat.RunSession(prompt="worker")
        self.assertEqual(zerochat.list_server_runs(focus_conversation_id="conv_1"), ([], None))
        zerochat.RUN_SESSION = None

        # live_state y zerochat/heartbeat exponen runs y focus_run
        state = zerochat.live_state(zerochat.project_context())
        self.assertEqual(len(state["runs"]), 3)
        self.assertIsNone(state["focus_run"])
        state_focused = zerochat.live_state(zerochat.project_context(), focus_conversation_id="conv_1")
        self.assertEqual(state_focused["focus_run"]["step_text"], "step 1")
        hb_res, hb_err, _ = zerochat.dispatch_local("zerochat/heartbeat", {"focus_conversation_id": "conv_1"}, zerochat.project_context())
        self.assertIsNone(hb_err)
        self.assertEqual(hb_res["focus_run"]["conversation_id"], "conv_1")

    def test_start_cancel_y_dispatch_server_run(self):
        zerochat.save_general_profile({"name": "valid-profile", "settings": {}})
        project = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, project, True)
        zerochat.save_conversation({"id": "conv_proj", "title": "P", "project": project}, [])
        zerochat.save_conversation({"id": "conv_gone", "title": "G", "project": os.path.join(project, "borrado")}, [])
        zerochat.save_conversation({"id": "conv_val", "title": "Val"}, [])

        for invalid_params in (
            "no_es_dict",
            {"conversation_id": "", "profile": "valid-profile"},
            {"conversation_id": "no_existe", "profile": "valid-profile"},
            {"conversation_id": "conv_val", "profile": ""},
            {"conversation_id": "conv_val", "profile": "no_existe_prof"},
            {"conversation_id": "conv_val", "profile": "valid-profile", "prompt": 123},
            {"conversation_id": "conv_val", "profile": "valid-profile", "tool_security": "invalido"},
            {"conversation_id": "conv_gone", "profile": "valid-profile"}
        ):
            with self.assertRaises(ValueError):
                zerochat.start_server_run(invalid_params)

        mock_proc = mock.Mock()
        mock_proc.pid = os.getpid()

        # Popen falso para todo subprocess: la huella de arranque, que fuera de Linux usa ps, se toma antes.
        start_token = zerochat._process_start_token(os.getpid())
        with mock.patch.object(zerochat, "find_node_executable", return_value="/usr/bin/node"), \
             mock.patch.object(zerochat, "_process_start_token", return_value=start_token), \
             mock.patch("subprocess.Popen", return_value=mock_proc) as mock_popen:
            zerochat.start_server_run({"conversation_id": "conv_proj", "profile": "valid-profile"})
            self.assertEqual(mock_popen.call_args.kwargs["cwd"], project)
            zerochat.remove_run_state("conv_proj")
            mock_popen.reset_mock()

            res, err, _ = dispatch_run("zerochat/run/start", {
                "conversation_id": "conv_val",
                "profile": "valid-profile",
                "prompt": "Genera reporte",
                "tool_security": {"directoryRules": ["R:/test"]}
            })
            self.assertIsNone(err)
            self.assertTrue(res["ok"])
            self.assertEqual(res["conversation_id"], "conv_val")
            self.assertEqual(res["status"], "running")
            run_id = res["run_id"]

            mock_popen.assert_called_once()
            args, kwargs = mock_popen.call_args
            self.assertEqual(kwargs["cwd"], str(zerochat.get_data_dir() / "general"))
            cmd = args[0]
            self.assertEqual(cmd[0], sys.executable)
            self.assertIn("--conversation", cmd)
            self.assertEqual(cmd[cmd.index("--conversation") + 1], "conv_val")
            self.assertIn("--profile", cmd)
            self.assertEqual(cmd[cmd.index("--profile") + 1], "valid-profile")
            self.assertIn("--prompt", cmd)
            self.assertEqual(cmd[cmd.index("--prompt") + 1], "Genera reporte")

            env = kwargs["env"]
            self.assertEqual(env["ZEROCHAT_RUN_ID"], run_id)
            self.assertEqual(json.loads(env["ZEROCHAT_RUN_SECURITY"])["directoryRules"], ["R:/test"])

            state_path = zerochat.get_run_state_path("conv_val")
            self.assertTrue(state_path.exists())
            if os.name != "nt":
                self.assertEqual(stat.S_IMODE(state_path.stat().st_mode), 0o600)
            conv_data = zerochat.get_conversation("conv_val")
            self.assertEqual(conv_data.get("serverRun"), True)
            self.assertEqual(conv_data.get("profileId"), "valid-profile")

            # Conflicto mientras la ejecución sigue en marcha
            with self.assertRaises(ValueError) as cm:
                zerochat.start_server_run({"conversation_id": "conv_val", "profile": "valid-profile"})
            self.assertIn("en marcha", str(cm.exception))

        # cancel_server_run mata el proceso cuando está running y coincide pid_start
        with mock.patch.object(zerochat, "_kill_process_tree") as mock_kill:
            res_c, err_c, _ = dispatch_run("zerochat/run/cancel", {"conversation_id": "conv_val"})
            self.assertIsNone(err_c)
            self.assertTrue(res_c["cancelled"])
            mock_kill.assert_called_once_with(os.getpid(), grace_seconds=0.05)
            self.assertFalse(state_path.exists())

        # Si el fichero está en needs_input o pid_start no coincide (PID reutilizado), cancel_server_run borra el fichero sin matar el PID
        state_path.write_text(json.dumps({
            "run_id": "run_paused",
            "conversation_id": "conv_val",
            "pid": os.getpid(),
            "status": "needs_input"
        }), encoding="utf-8")
        with mock.patch.object(zerochat, "_kill_process_tree") as mock_kill_paused:
            zerochat.cancel_server_run("conv_val")
            mock_kill_paused.assert_not_called()
            self.assertFalse(state_path.exists())

        state_path.write_text(json.dumps({
            "run_id": "run_reused_pid",
            "conversation_id": "conv_val",
            "pid": os.getpid(),
            "pid_start": "token_de_proceso_anterior_distinto",
            "status": "running"
        }), encoding="utf-8")
        with mock.patch.object(zerochat, "_kill_process_tree") as mock_kill_reused:
            zerochat.cancel_server_run("conv_val")
            mock_kill_reused.assert_not_called()
            self.assertFalse(state_path.exists())

    def test_cualquier_peticion_de_un_origen_permitido_es_presencia_y_la_inactividad_detiene_el_servidor(self):
        token = "heartbeat-test-token"
        today = zerochat.datetime.date.today().isoformat()
        # ACTIVE_USER_AGENT propio: la petición de la prueba no fija el User-Agent de las salidas web.
        patches = mock.patch.multiple(zerochat, SESSION_TOKEN=token, SESSION_TOKEN_DATE=today, HEARTBEAT_INITIALIZED=False,
                                      HEARTBEAT_LAST_SEEN=0.0, ACTIVE_USER_AGENT="test-agent")
        patches.start()
        self.addCleanup(patches.stop)
        server = zerochat.ThreadingHTTPServer(("127.0.0.1", 0), zerochat.ZeroChatServerHandler)
        self.addCleanup(server.server_close)
        threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True).start()
        self.addCleanup(server.shutdown)
        base = f"http://127.0.0.1:{server.server_address[1]}"

        def post(path, method, sent_token):
            body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": {}}).encode()
            request = zerochat.urllib.request.Request(f"{base}{path}", data=body, headers={
                "Content-Type": "application/json", "X-ZeroChat-Token": sent_token})
            try:
                with zerochat.urllib.request.urlopen(request, timeout=5) as response:
                    return response.status
            except zerochat.urllib.error.HTTPError as error:
                return error.code

        def renews(path, method, sent_token, status):
            before = zerochat.HEARTBEAT_LAST_SEEN
            time.sleep(0.05)  # más que la resolución de time.monotonic en Windows (~16 ms)
            self.assertEqual(post(path, method, sent_token), status)
            self.assertGreater(zerochat.HEARTBEAT_LAST_SEEN, before, (path, method, sent_token))

        renews("/", "zerochat/heartbeat", token, 200)
        self.assertTrue(zerochat.HEARTBEAT_INITIALIZED)
        # Un token caducado o erróneo (401) también es presencia: el auto-cierre no salta al cambiar el día.
        renews("/", "zerochat/heartbeat", "token-caducado", 401)
        # Cualquier otra RPC autenticada renueva la presencia sin zerochat/heartbeat.
        renews("/", "tools/list", token, 200)

        with mock.patch.object(zerochat, "stop_zerochat_server") as stop:
            zerochat.heartbeat_watchdog(server, inactivity_timeout_seconds=0.1)
        stop.assert_called_once_with(server)

    def test_heartbeat_watchdog_no_apaga_si_hay_run_activo(self):
        state_path = zerochat.get_run_state_path("conv_watchdog")
        state_path.write_text(json.dumps({
            "run_id": "run_wd",
            "conversation_id": "conv_watchdog",
            "pid": os.getpid(),
            "status": "running"
        }), encoding="utf-8")

        mock_server = mock.Mock()
        zerochat.HEARTBEAT_INITIALIZED = True
        zerochat.HEARTBEAT_LAST_SEEN = time.monotonic() - 100.0

        def stop_after_delay():
            time.sleep(0.15)
            state_path.write_text(json.dumps({
                "run_id": "run_wd",
                "conversation_id": "conv_watchdog",
                "pid": os.getpid(),
                "status": "completed"
            }), encoding="utf-8")

        threading.Thread(target=stop_after_delay, daemon=True).start()

        with mock.patch.object(zerochat, "stop_zerochat_server") as mock_stop:
            zerochat.heartbeat_watchdog(mock_server, inactivity_timeout_seconds=0.05)
            mock_stop.assert_called_once_with(mock_server)

    def test_borrar_conversaciones_limpia_runs(self):
        state_path1 = zerochat.get_run_state_path("conv_del_1")
        state_path1.write_text(json.dumps({
            "run_id": "run_1",
            "conversation_id": "conv_del_1",
            "pid": 33333,
            "status": "needs_input"
        }), encoding="utf-8")
        state_path2 = zerochat.get_run_state_path("conv_del_2")
        state_path2.write_text(json.dumps({
            "run_id": "run_2",
            "conversation_id": "conv_del_2",
            "pid": 33334,
            "status": "needs_input"
        }), encoding="utf-8")

        zerochat.save_conversation({"id": "conv_del_1", "title": "Del 1"}, [])
        zerochat.save_conversation({"id": "conv_del_2", "title": "Del 2", "project": "/repo/b"}, [])
        zerochat.save_conversation({"id": "conv_del_3", "title": "Del 3", "project": "/repo/c"}, [])

        zerochat.dispatch_conversations("zerochat/conversations/delete", {"id": "conv_del_1"})
        self.assertFalse(state_path1.exists())
        self.assertTrue(state_path2.exists())

        # Por proyecto: solo sus conversaciones y sus ejecuciones.
        result, error, _ = zerochat.dispatch_conversations("zerochat/conversations/delete", {"project": "/repo/c"})
        self.assertIsNone(error)
        self.assertEqual(result["count"], 1)
        self.assertTrue(state_path2.exists())
        self.assertEqual([c["id"] for c in zerochat.list_conversations()], ["conv_del_2"])
        _, error, _ = zerochat.dispatch_conversations("zerochat/conversations/delete", {"project": "  "})
        self.assertEqual(error["code"], -32602)

        zerochat.dispatch_conversations("zerochat/conversations/delete", {"all": True})
        self.assertFalse(state_path2.exists())


class FinishRunOutputTest(unittest.TestCase):
    """Al terminar, la salida de la respuesta solo lleva la respuesta y el registro calla: un hilo en segundo plano
    que escribiera mientras se cierra el intérprete lo haría abortar (_enter_buffered_busy)."""

    def test_tras_la_respuesta_ninguna_linea_del_registro_llega_a_ninguna_salida(self):
        session = zerochat.RunSession(prompt="hola")
        session.result = {"text": "respuesta"}
        log, answer = io.StringIO(), io.StringIO()
        with mock.patch.object(zerochat, "RUN_SESSION", session), mock.patch.object(zerochat, "_MUTED", False), \
             mock.patch.object(sys, "stdout", log):
            with self.assertRaises(SystemExit) as exit_info:
                zerochat.finish_run(None, answer)
            late = threading.Thread(target=zerochat.log_event, args=("línea tardía",))
            late.start()
            late.join()
            zerochat.run_error("error tardío")
        self.assertEqual(exit_info.exception.code, zerochat.RUN_EXIT_DONE)
        self.assertEqual(answer.getvalue(), "respuesta\n")
        self.assertIn("Ejecución terminada", log.getvalue())
        self.assertNotIn("tardía", log.getvalue())
