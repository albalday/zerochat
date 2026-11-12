import io
import json
import os
import shutil
import stat
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock
from backend import use_data_dir, zerochat


class ServerRunsInfrastructureTest(unittest.TestCase):
    def setUp(self):
        self.data_dir = use_data_dir(self)
        self.runs_dir = self.data_dir / "runs"

    def tearDown(self):
        zerochat.RUN_SESSION = None

    @unittest.skipIf(os.name == "nt", "Permisos POSIX")
    def test_permisos_directorio_runs_0700_y_fichero_0600(self):
        session = zerochat.RunSession(conversation_id="conv_permisos_test")
        self.assertTrue(self.runs_dir.exists())
        dir_mode = stat.S_IMODE(self.runs_dir.stat().st_mode)
        self.assertEqual(dir_mode, 0o700)

        state_path = zerochat.get_run_state_path("conv_permisos_test")
        self.assertTrue(state_path.exists())
        file_mode = stat.S_IMODE(state_path.stat().st_mode)
        self.assertEqual(file_mode, 0o600)

    def test_fichero_situacion_estructura_y_ciclo_de_vida(self):
        conv_id = "session_test_run_123"
        session = zerochat.RunSession(
            conversation_id=conv_id,
            run_id="run_custom_test_abc",
            tool_security={"directoryRules": ["R:/workspace"]}
        )
        state_path = zerochat.get_run_state_path(conv_id)
        self.assertTrue(state_path.exists())

        data = json.loads(state_path.read_text("utf-8"))
        self.assertEqual(data["run_id"], "run_custom_test_abc")
        self.assertEqual(data["conversation_id"], conv_id)
        self.assertEqual(data["status"], "running")
        self.assertEqual(data["step_text"], "")
        self.assertEqual(data["assistant_text"], "")
        self.assertEqual(data["reasoning_text"], "")
        self.assertIsNone(data["pending"])
        self.assertIsNone(data["error"])
        self.assertEqual(data["pid"], os.getpid())

        # zerochat/run/prompt entrega conversation_id y tool_security
        zerochat.RUN_SESSION = session
        prompt_res, err, _ = zerochat.dispatch_run("zerochat/run/prompt", {"run_id": session.run_id})
        self.assertIsNone(err)
        self.assertEqual(prompt_res["conversation_id"], conv_id)
        self.assertEqual(prompt_res["tool_security"], {"directoryRules": ["R:/workspace"]})

        # zerochat/run/progress actualiza situación y streaming de texto y razonamiento
        prog_res, err, _ = zerochat.dispatch_run("zerochat/run/progress", {
            "run_id": session.run_id,
            "kind": "tool",
            "text": "run_command: pytest",
            "assistant_text": "Ejecutando pruebas...",
            "reasoning_text": "Pensando el siguiente paso..."
        })
        self.assertIsNone(err)
        self.assertEqual(prog_res, {"ok": True})

        data = json.loads(state_path.read_text("utf-8"))
        self.assertEqual(data["step_text"], "run_command: pytest")
        self.assertEqual(data["assistant_text"], "Ejecutando pruebas...")
        self.assertEqual(data["reasoning_text"], "Pensando el siguiente paso...")

        # zerochat/run/result con needs_input guarda estado needs_input y pending
        res_outcome, err, _ = zerochat.dispatch_run("zerochat/run/result", {
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
        zerochat.dispatch_run("zerochat/run/result", {
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
        zerochat.dispatch_run("zerochat/run/result", {
            "run_id": session2.run_id,
            "text": "Respuesta final completa."
        })
        self.assertFalse(state_path.exists())

    def test_topes_exactos_truncado_en_progreso_y_stream(self):
        conv_id = "session_test_bounds_exact"
        session = zerochat.RunSession(conversation_id=conv_id)
        state_path = zerochat.get_run_state_path(conv_id)
        zerochat.RUN_SESSION = session

        # Borde exacto N (500) y N+1 (501) en step_text (RUN_PROGRESS_TEXT_MAX)
        zerochat.dispatch_run("zerochat/run/progress", {
            "run_id": session.run_id,
            "kind": "tool",
            "text": "a" * zerochat.RUN_PROGRESS_TEXT_MAX
        })
        data = json.loads(state_path.read_text("utf-8"))
        self.assertEqual(data["step_text"], "a" * zerochat.RUN_PROGRESS_TEXT_MAX)
        self.assertFalse(data["step_text"].endswith("…"))

        zerochat.dispatch_run("zerochat/run/progress", {
            "run_id": session.run_id,
            "kind": "tool",
            "text": "b" * (zerochat.RUN_PROGRESS_TEXT_MAX + 1)
        })
        data = json.loads(state_path.read_text("utf-8"))
        self.assertEqual(len(data["step_text"]), zerochat.RUN_PROGRESS_TEXT_MAX + 1)
        self.assertEqual(data["step_text"], ("b" * zerochat.RUN_PROGRESS_TEXT_MAX) + "…")

        # Borde exacto N (8000) y N+1 (8001) en assistant_text y reasoning_text (RUN_STREAM_TEXT_MAX)
        zerochat.dispatch_run("zerochat/run/progress", {
            "run_id": session.run_id,
            "kind": "stream",
            "assistant_text": "t" * zerochat.RUN_STREAM_TEXT_MAX,
            "reasoning_text": "r" * zerochat.RUN_STREAM_TEXT_MAX
        })
        data = json.loads(state_path.read_text("utf-8"))
        self.assertEqual(data["assistant_text"], "t" * zerochat.RUN_STREAM_TEXT_MAX)
        self.assertFalse(data["assistant_text"].endswith("…"))
        self.assertEqual(data["reasoning_text"], "r" * zerochat.RUN_STREAM_TEXT_MAX)
        self.assertFalse(data["reasoning_text"].endswith("…"))

        zerochat.dispatch_run("zerochat/run/progress", {
            "run_id": session.run_id,
            "kind": "stream",
            "assistant_text": "x" * (zerochat.RUN_STREAM_TEXT_MAX + 1),
            "reasoning_text": "y" * (zerochat.RUN_STREAM_TEXT_MAX + 1)
        })
        data = json.loads(state_path.read_text("utf-8"))
        self.assertEqual(data["assistant_text"], ("x" * zerochat.RUN_STREAM_TEXT_MAX) + "…")
        self.assertEqual(data["reasoning_text"], ("y" * zerochat.RUN_STREAM_TEXT_MAX) + "…")

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

        mock_server = mock.Mock()
        mock_proc = mock.Mock()
        mock_proc.poll.return_value = 1  # Navegador terminó

        zerochat.run_supervisor(mock_server, session, browser_proc=mock_proc)
        data = json.loads(state_path.read_text("utf-8"))
        self.assertEqual(data["status"], "error")
        self.assertIn("cerró", data["error"])

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
            "assistant_text": "asst 1",
            "reasoning_text": "reas 1",
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
            "assistant_text": "asst 2",
            "reasoning_text": "reas 2",
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
            "assistant_text": "",
            "reasoning_text": "",
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
        self.assertEqual(focus["assistant_text"], "asst 1")

        _, focus_miss = zerochat.list_server_runs(focus_conversation_id="conv_otro")
        self.assertIsNone(focus_miss)

        disk_dead = json.loads(path_dead.read_text("utf-8"))
        self.assertEqual(disk_dead["status"], "error")
        self.assertIn("inesperadamente", disk_dead["error"])

        # En un servidor worker (RUN_SESSION activo), list_server_runs devuelve ([], None)
        zerochat.RUN_SESSION = zerochat.RunSession(prompt="worker")
        self.assertEqual(zerochat.list_server_runs(focus_conversation_id="conv_1"), ([], None))
        zerochat.RUN_SESSION = None

    def test_start_server_run_arranca_en_el_proyecto_de_la_conversacion(self):
        zerochat.save_general_profile({"name": "valid-profile", "settings": {}})
        project = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, project, True)
        zerochat.save_conversation({"id": "conv_proj", "title": "P", "project": project}, [])
        zerochat.save_conversation({"id": "conv_gone", "title": "G", "project": os.path.join(project, "borrado")}, [])
        mock_proc = mock.Mock()
        mock_proc.pid = os.getpid()
        with mock.patch.object(zerochat, "find_node_executable", return_value="/usr/bin/node"), \
             mock.patch("subprocess.Popen", return_value=mock_proc) as mock_popen:
            zerochat.start_server_run({"conversation_id": "conv_proj", "profile": "valid-profile"})
            self.assertEqual(mock_popen.call_args.kwargs["cwd"], project)
            # Si la carpeta ya no existe no arranca en otra
            with self.assertRaises(ValueError):
                zerochat.start_server_run({"conversation_id": "conv_gone", "profile": "valid-profile"})
            self.assertEqual(mock_popen.call_count, 1)
        zerochat.remove_run_state("conv_proj")

    def test_start_cancel_y_dispatch_server_run(self):
        zerochat.save_general_profile({"name": "valid-profile", "settings": {}})
        zerochat.save_conversation({"id": "conv_val", "title": "Val"}, [])

        for invalid_params in (
            "no_es_dict",
            {"conversation_id": "", "profile": "valid-profile"},
            {"conversation_id": "no_existe", "profile": "valid-profile"},
            {"conversation_id": "conv_val", "profile": ""},
            {"conversation_id": "conv_val", "profile": "no_existe_prof"},
            {"conversation_id": "conv_val", "profile": "valid-profile", "prompt": 123},
            {"conversation_id": "conv_val", "profile": "valid-profile", "tool_security": "invalido"}
        ):
            with self.assertRaises(ValueError):
                zerochat.start_server_run(invalid_params)

        mock_proc = mock.Mock()
        mock_proc.pid = os.getpid()

        with mock.patch.object(zerochat, "find_node_executable", return_value="/usr/bin/node"), \
             mock.patch("subprocess.Popen", return_value=mock_proc) as mock_popen:
            res, err, _ = zerochat.dispatch_run("zerochat/run/start", {
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
            cmd = args[0]
            self.assertEqual(cmd[0], sys.executable)
            self.assertIn("--conversation", cmd)
            self.assertEqual(cmd[cmd.index("--conversation") + 1], "conv_val")
            self.assertIn("--profile", cmd)
            self.assertEqual(cmd[cmd.index("--profile") + 1], "valid-profile")
            self.assertIn("--prompt", cmd)
            self.assertEqual(cmd[cmd.index("--prompt") + 1], "Genera reporte")

            self.assertEqual(kwargs["cwd"], str(zerochat.PROJECT_DIR), "Sin proyecto arranca en el proyecto actual del servidor")
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
        with mock.patch.object(zerochat, "_kill_pid_tree") as mock_kill:
            res_c, err_c, _ = zerochat.dispatch_run("zerochat/run/cancel", {"conversation_id": "conv_val"})
            self.assertIsNone(err_c)
            self.assertTrue(res_c["cancelled"])
            mock_kill.assert_called_once_with(os.getpid())
            self.assertFalse(state_path.exists())

        # Si el fichero está en needs_input o pid_start no coincide (PID reutilizado), cancel_server_run borra el fichero sin matar el PID
        state_path.write_text(json.dumps({
            "run_id": "run_paused",
            "conversation_id": "conv_val",
            "pid": os.getpid(),
            "status": "needs_input"
        }), encoding="utf-8")
        with mock.patch.object(zerochat, "_kill_pid_tree") as mock_kill_paused:
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
        with mock.patch.object(zerochat, "_kill_pid_tree") as mock_kill_reused:
            zerochat.cancel_server_run("conv_val")
            mock_kill_reused.assert_not_called()
            self.assertFalse(state_path.exists())

    def test_live_state_y_heartbeat_con_focus(self):
        state_path = zerochat.get_run_state_path("conv_hb")
        state_path.write_text(json.dumps({
            "run_id": "run_hb",
            "conversation_id": "conv_hb",
            "pid": os.getpid(),
            "started_at": 2000,
            "status": "running",
            "assistant_text": "Live test"
        }), encoding="utf-8")

        state = zerochat.live_state()
        self.assertIn("runs", state)
        self.assertIn("focus_run", state)
        self.assertEqual(len(state["runs"]), 1)
        self.assertEqual(state["runs"][0]["conversation_id"], "conv_hb")
        self.assertIsNone(state["focus_run"])

        state_focused = zerochat.live_state(focus_conversation_id="conv_hb")
        self.assertIsNotNone(state_focused["focus_run"])
        self.assertEqual(state_focused["focus_run"]["assistant_text"], "Live test")

        handler = mock.Mock(spec=zerochat.ZeroChatServerHandler)
        outcome = zerochat.ZeroChatServerHandler._dispatch_local(handler, "zerochat/heartbeat", {
            "focus_conversation_id": "conv_hb"
        })
        result, error, _ = outcome
        self.assertIsNone(error)
        self.assertIsNotNone(result["focus_run"])
        self.assertEqual(result["focus_run"]["conversation_id"], "conv_hb")

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
        zerochat.save_conversation({"id": "conv_del_2", "title": "Del 2"}, [])

        zerochat.ZeroChatServerHandler._dispatch_conversations("zerochat/conversations/delete", {"id": "conv_del_1"})
        self.assertFalse(state_path1.exists())
        self.assertTrue(state_path2.exists())

        zerochat.ZeroChatServerHandler._dispatch_conversations("zerochat/conversations/delete", {"all": True})
        self.assertFalse(state_path2.exists())
