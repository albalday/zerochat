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
from backend import use_data_dir, use_project, zerochat

# Proyecto de la petición, distinto del proyecto por defecto del servidor.
CTX = zerochat.SecurityContext(Path(tempfile.gettempdir()).resolve())


def dispatch_run(method, params):
    return zerochat.dispatch_run(method, params, CTX)


class Waiting(threading.Event):
    """Se activa cuando un hilo entra a esperar en la condición; timeouts guarda el plazo de cada espera (None: sin plazo)."""

    def __init__(self):
        super().__init__()
        self.timeouts: list[float | None] = []


def waiting_on(test, condition) -> Waiting:
    """Waiting de condition: el cambio llega con la espera ya en curso."""
    waiting = Waiting()
    real_wait = condition.wait

    def wait(timeout=None):
        waiting.timeouts.append(timeout)
        waiting.set()
        return real_wait(timeout)

    patcher = mock.patch.object(condition, "wait", side_effect=wait)
    patcher.start()
    test.addCleanup(patcher.stop)
    return waiting


def start_worker(test) -> subprocess.Popen:
    """Proceso que hace de ejecución en segundo plano: la prueba decide cuándo termina."""
    worker = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(100)"])
    test.addCleanup(worker.wait)
    test.addCleanup(worker.kill)
    return worker


def upsert_run(fields):
    """Guarda un estado de ejecución completo con los campos que importan a cada prueba."""
    now = int(time.time() * 1000)
    zerochat.upsert_run_state({
        "pid": None, "pid_start": None, "started_at": now, "updated_at": now,
        "step_text": "", "pending": None, "error": None, **fields,
    })


class ServerRunsInfrastructureTest(unittest.TestCase):
    def setUp(self):
        self.data_dir = use_data_dir(self)

    def tearDown(self):
        zerochat.RUN_SESSION = None

    def test_fichero_situacion_permisos_estructura_topes_y_ciclo_de_vida(self):
        conv_id = "session_test_run_123"
        session = zerochat.RunSession(
            conversation_id=conv_id,
            run_id="run_custom_test_abc",
            tool_security={"directoryRules": ["R:/workspace"], "tool_decision": {"toolName": "write_file", "args": {}, "decision": "allow_once"}}
        )
        data = zerochat.get_run_state(conv_id)
        self.assertIsNotNone(data)
        if os.name != "nt":
            self.assertEqual(stat.S_IMODE(zerochat.get_storage_dir().stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(zerochat.get_storage_db_path().stat().st_mode), 0o600)

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
        self.assertEqual(zerochat.get_run_state(conv_id)["step_text"], "a" * zerochat.RUN_PROGRESS_TEXT_MAX)
        prog_res, err, _ = dispatch_run("zerochat/run/progress", {
            "run_id": session.run_id,
            "kind": "tool",
            "text": "b" * (zerochat.RUN_PROGRESS_TEXT_MAX + 1)
        })
        self.assertEqual((err, prog_res), (None, {"ok": True}))
        self.assertEqual(zerochat.get_run_state(conv_id)["step_text"], ("b" * zerochat.RUN_PROGRESS_TEXT_MAX) + "…")

        # needs_input necesita un kind conocido y su texto; el válido guarda la pausa y su fin.
        for invalid in ({"kind": "ask_user"}, {"kind": "otro", "text": "x"}, {"kind": "ask_user", "question": "¿Seguir?"}):
            _, err, _ = dispatch_run("zerochat/run/result", {"run_id": session.run_id, "needs_input": invalid})
            self.assertEqual(err["code"], zerochat.INVALID_PARAMS)
        res_outcome, err, _ = dispatch_run("zerochat/run/result", {
            "run_id": session.run_id,
            "needs_input": {"kind": "ask_user", "text": "¿Deseas continuar?"}
        })
        self.assertIsNone(err)
        self.assertEqual(res_outcome, {"ok": True})
        self.assertTrue(session.finished.is_set())

        data = zerochat.get_run_state(conv_id)
        self.assertEqual(data["status"], "needs_input")
        self.assertEqual(data["pending"], {"kind": "ask_user", "text": "¿Deseas continuar?"})
        self.assertIsNotNone(data["finished_at"])

        # La pausa sale con código 5 y, en stdout, lo que espera del usuario en texto.
        with mock.patch("sys.stderr", io.StringIO()):
            self.assertEqual(zerochat.run_outcome(session), (zerochat.RUN_EXIT_NEEDS_INPUT, "¿Deseas continuar?"))
            session.result = {"needs_input": {"kind": "tool_approval", "text": "write_file"}}
            self.assertEqual(zerochat.run_outcome(session), (zerochat.RUN_EXIT_NEEDS_INPUT, "Pendiente de aprobar la herramienta write_file."))

        # Nueva sesión con resultado error actualiza el estado en SQLite
        session_err = zerochat.RunSession(conversation_id=conv_id)
        zerochat.RUN_SESSION = session_err
        dispatch_run("zerochat/run/result", {
            "run_id": session_err.run_id,
            "error": "Modelo no disponible"
        })
        data_err = zerochat.get_run_state(conv_id)
        self.assertEqual(data_err["status"], "error")
        self.assertEqual(data_err["error"], "Modelo no disponible")

        # Al completarse, la fila sigue con la respuesta para quien lanzó la ejecución; el error anterior ya no está.
        session2 = zerochat.RunSession(conversation_id=conv_id)
        self.assertIsNone(zerochat.get_run_state(conv_id)["finished_at"])
        zerochat.RUN_SESSION = session2
        dispatch_run("zerochat/run/result", {
            "run_id": session2.run_id,
            "text": "Respuesta final completa."
        })
        data_done = zerochat.get_run_state(conv_id)
        self.assertEqual((data_done["status"], data_done["result_text"], data_done["error"]), ("completed", "Respuesta final completa.", None))
        self.assertIsNotNone(data_done["finished_at"])

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

    def test_run_file_valida_la_peticion_crea_o_continua_la_conversacion_y_exige_entorno_guardado(self):
        zerochat.save_general_profile({"name": "local", "settings": {}})
        parser = zerochat.build_parser()
        folder = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, folder, True)

        def write_request(data) -> str:
            path = folder / "peticion.json"
            path.write_text(json.dumps(data) if not isinstance(data, str) else data, encoding="utf-8")
            return str(path)

        def session_from(argv):
            return zerochat.run_session_from_args(parser, parser.parse_args(argv))

        def rejects(argv):
            with self.assertRaises(SystemExit) as cm, mock.patch("sys.stderr", io.StringIO()):
                session_from(argv)
            self.assertEqual(cm.exception.code, zerochat.RUN_EXIT_ARGS)

        # Petición no válida: campos de permisos o herramientas, tipos y textos vacíos.
        for invalid in ({"prompt": "Hola", "enabledTools": {"run_command": True}}, {"prompt": "Hola", "tool_security": {}},
                        {"prompt": 3}, {"prompt": "  "}, {"prompt": "Hola", "systemDataPrompt": None}, ["Hola"], "{no json"):
            rejects(["--run-file", write_request(invalid)])
        rejects(["--run-file", write_request({"profile": "local"})])
        rejects(["--run-file", str(folder / "no_existe.json")])
        rejects(["--run-file", write_request({"prompt": "Hola"}), "--prompt", "Otro"])

        # Tope del fichero en el borde exacto: N bytes se aceptan y N+1 no.
        body = json.dumps({"prompt": "Hola"})
        at_limit = (body + " " * (zerochat.RUN_FILE_MAX_BYTES - len(body))).encode()
        self.assertEqual(zerochat.parse_run_request(at_limit), {"prompt": "Hola"})
        with self.assertRaisesRegex(ValueError, "no puede superar"):
            zerochat.parse_run_request(at_limit + b" ")

        # Límites: enteros de 1 a su máximo, en el borde exacto.
        for key, maximum in zerochat.RUN_FILE_LIMIT_KEYS.items():
            self.assertEqual(zerochat.parse_run_request(json.dumps({"prompt": "Hola", key: maximum}).encode())[key], maximum)
            for invalid in (maximum + 1, 0, True, "5", 2.5):
                with self.assertRaisesRegex(ValueError, f"{key} debe ser un entero"):
                    zerochat.parse_run_request(json.dumps({"prompt": "Hola", key: invalid}).encode())

        # Un conversation_id que no existe es el de la conversación nueva; sin prompt no hay con qué empezarla.
        session = session_from(["--run-file", write_request({
            "conversation_id": "session_orquestador_1", "prompt": " Redacta el informe ", "systemDataPrompt": "Eres el agente de informes.",
            "maxSteps": 20, "timeout": 600})])
        self.assertEqual((session.conversation_id, session.new_conversation_id), (None, "session_orquestador_1"))
        self.assertEqual((session.max_steps, session.timeout_seconds), (20, 600))
        self.assertEqual((session.prompt, session.profile, session.system_data_prompt), ("Redacta el informe", "local", "Eres el agente de informes."))
        rejects(["--run-file", write_request({"conversation_id": "session_orquestador_2"})])

        # Uno que existe se continúa, como --conversation; desde stdin con -.
        zerochat.save_conversation({"id": "session_orquestador_3", "title": "Agente"}, [{"id": "u1", "role": "user", "content": "Hola"}])
        with mock.patch("sys.stdin", mock.Mock(buffer=io.BytesIO(json.dumps({"conversation_id": "session_orquestador_3"}).encode()))):
            session = session_from(["--run-file", "-"])
        self.assertEqual((session.conversation_id, session.new_conversation_id, session.prompt), ("session_orquestador_3", None, None))

        # El systemDataPrompt sustituye al guardado en lo que recibe la interfaz, sin escribirlo en SQLite.
        ctx = use_project(self, folder)
        with self.assertRaises(SystemExit) as cm, mock.patch("sys.stderr", io.StringIO()) as stderr:
            zerochat.require_saved_environment()
        self.assertEqual(cm.exception.code, zerochat.RUN_EXIT_SETUP)
        self.assertIn("no tiene entorno guardado", stderr.getvalue())
        zerochat.save_project_environment(ctx.key, {"systemDataPrompt": "Prompt del proyecto"})
        zerochat.require_saved_environment()
        zerochat.RUN_SESSION = zerochat.RunSession("Hola", system_data_prompt="Eres el agente de informes.")
        initialized, err, _ = zerochat.dispatch_local("initialize", {}, ctx)
        self.assertIsNone(err)
        self.assertEqual(initialized["projectEnvironment"]["systemDataPrompt"], "Eres el agente de informes.")
        self.assertEqual(zerochat.get_project_environment(ctx.key)["systemDataPrompt"], "Prompt del proyecto")

    def test_los_permisos_denegados_quedan_en_los_avisos_de_la_ejecucion_con_tope(self):
        ctx = use_project(self, Path(tempfile.mkdtemp()))
        self.addCleanup(shutil.rmtree, ctx.workspace_dir, True)
        # Una ejecución nueva con id del servidor no la sigue nadie: no deja fila.
        zerochat.RunSession("Hola")
        self.assertEqual(zerochat.list_run_states(), [])
        session = zerochat.RunSession("Hola", new_conversation_id="session_avisos")
        zerochat.RUN_SESSION = session
        ask = zerochat.ACCESS_CONTROLLER.evaluate_authorization("run_command", {"command": "rm -rf /"}, context=ctx,
                                                                   server_name="mcp-proxy", server_id="")
        self.assertEqual(ask.status, zerochat.POLICY_ASK)
        with mock.patch("sys.stderr", io.StringIO()) as stderr:
            result, _, message = zerochat.authorize_or_challenge("local", "run_command", {"command": "rm -rf /"}, ctx)
            self.assertEqual(result["securityStatus"], "deny")
            self.assertIn("Permiso denegado: run_command", stderr.getvalue())
            # Tope en el borde exacto: RUN_WARNINGS_MAX avisos se guardan y del siguiente solo se cuenta.
            for index in range(1, zerochat.RUN_WARNINGS_MAX):
                session.add_warning(f"aviso {index}")
            self.assertEqual(len(zerochat.get_run_state("session_avisos")["warnings"]), zerochat.RUN_WARNINGS_MAX)
            session.add_warning("uno de más")
        warnings = zerochat.get_run_state("session_avisos")["warnings"]
        self.assertEqual(len(warnings), zerochat.RUN_WARNINGS_MAX + 1)
        self.assertTrue(warnings[0].startswith("run_command: ") and message.endswith(warnings[0].removeprefix("run_command: ")))
        self.assertEqual(warnings[-1], "… y 1 permiso(s) denegado(s) más")

    def test_supervisor_detiene_y_registra_error_si_cierra_sin_resultado(self):
        conv_id = "session_supervisor_test"
        session = zerochat.RunSession(conversation_id=conv_id)
        self.assertIsNotNone(zerochat.get_run_state(conv_id))

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
            zerochat.run_supervisor(mock.Mock(), session, runner_proc=mock_proc, runner_log=log)
            mock_proc.wait.assert_called_once_with()
        data = zerochat.get_run_state(conv_id)
        self.assertEqual(data["status"], "error")
        self.assertEqual(data["error"], "El runner de Node.js terminó con el código 3 sin resultado: Error fatal en runner")

    def test_los_limites_de_pasos_y_tiempo_terminan_con_estado_limit_y_codigo_6(self):
        # El runner solo puede declarar el límite de pasos, y solo en una ejecución que lo tiene.
        sin_tope = zerochat.RunSession("Hola", new_conversation_id="session_sin_tope")
        zerochat.RUN_SESSION = sin_tope
        _, err, _ = dispatch_run("zerochat/run/result", {"run_id": sin_tope.run_id, "limit": "steps"})
        self.assertEqual(err["code"], zerochat.INVALID_PARAMS)
        session = zerochat.RunSession("Hola", new_conversation_id="session_pasos", max_steps=20)
        zerochat.RUN_SESSION = session
        self.assertEqual(dispatch_run("zerochat/run/prompt", {"run_id": session.run_id})[0]["max_steps"], 20)
        _, err, _ = dispatch_run("zerochat/run/result", {"run_id": session.run_id, "limit": "timeout"})
        self.assertEqual(err["code"], zerochat.INVALID_PARAMS)
        self.assertEqual(dispatch_run("zerochat/run/result", {"run_id": session.run_id, "limit": "steps"})[0], {"ok": True})
        self.assertTrue(session.finished.is_set())
        data = zerochat.get_run_state("session_pasos")
        self.assertEqual((data["status"], data["error"]), ("limit", "Límite de 20 pasos alcanzado."))
        self.assertIsNotNone(data["finished_at"])
        with mock.patch("sys.stderr", io.StringIO()) as stderr:
            self.assertEqual(zerochat.run_outcome(session), (zerochat.RUN_EXIT_LIMIT, None))
        self.assertIn("Límite de 20 pasos alcanzado.", stderr.getvalue())

        # El plazo cuenta desde el arranque: vencido, termina el runner y deja el límite, no un error.
        timed = zerochat.RunSession("Hola", new_conversation_id="session_plazo", timeout_seconds=5)
        timed.started_at -= 5000
        runner_gone = threading.Event()
        runner = mock.Mock(wait=mock.Mock(side_effect=lambda: runner_gone.wait(5)))
        with mock.patch.object(zerochat, "stop_zerochat_server"), \
             mock.patch.object(zerochat, "_kill_process_tree", side_effect=lambda *_, **__: runner_gone.set()) as kill:
            zerochat.run_supervisor(mock.Mock(), timed, runner_proc=runner)
        kill.assert_called_once_with(runner, grace_seconds=1.0)
        data = zerochat.get_run_state("session_plazo")
        self.assertEqual((data["status"], data["error"]), ("limit", "Límite de 5 s alcanzado."))
        # Un resultado que llega tarde ya no cambia el final.
        zerochat.RUN_SESSION = timed
        _, err, _ = dispatch_run("zerochat/run/result", {"run_id": timed.run_id, "text": "tarde"})
        self.assertIn("ya se recibió", err["message"])

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
        upsert_run(state1)
        upsert_run(state2)
        upsert_run(state_dead)
        # Una completada no va en la lista ligera del latido, pero quien sigue su conversación la lee entera.
        upsert_run({"run_id": "run_ok", "conversation_id": "conv_ok", "status": "completed", "finished_at": now,
                    "result_text": "Hecho.", "warnings": ["run_command: denegado"]})
        _, focus_ok = zerochat.list_server_runs(focus_conversation_id="conv_ok")
        self.assertEqual((focus_ok["status"], focus_ok["result_text"], focus_ok["warnings"]), ("completed", "Hecho.", ["run_command: denegado"]))

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

        disk_dead = zerochat.get_run_state("conv_dead")
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
             mock.patch("subprocess.Popen", return_value=mock_proc) as mock_popen, \
             mock.patch.object(zerochat, "watch_run_exit") as watch_exit:
            zerochat.start_server_run({"conversation_id": "conv_proj", "profile": "valid-profile"})
            self.assertEqual(mock_popen.call_args.kwargs["cwd"], project)
            # Espera su final con el Popen que lanzó, que así recoge (prueba de abajo).
            watch_exit.assert_called_once_with(mock_proc.pid, start_token, mock_proc)
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

            self.assertIsNotNone(zerochat.get_run_state("conv_val"))
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
            self.assertIsNone(zerochat.get_run_state("conv_val"))

        # Si el estado está en needs_input o pid_start no coincide (PID reutilizado), cancel_server_run borra el estado sin matar el PID
        upsert_run({
            "run_id": "run_paused",
            "conversation_id": "conv_val",
            "pid": os.getpid(),
            "status": "needs_input"
        })
        with mock.patch.object(zerochat, "_kill_process_tree") as mock_kill_paused:
            zerochat.cancel_server_run("conv_val")
            mock_kill_paused.assert_not_called()
            self.assertIsNone(zerochat.get_run_state("conv_val"))

        upsert_run({
            "run_id": "run_reused_pid",
            "conversation_id": "conv_val",
            "pid": os.getpid(),
            "pid_start": "token_de_proceso_anterior_distinto",
            "status": "running"
        })
        with mock.patch.object(zerochat, "_kill_process_tree") as mock_kill_reused:
            zerochat.cancel_server_run("conv_val")
            mock_kill_reused.assert_not_called()
            self.assertIsNone(zerochat.get_run_state("conv_val"))

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

    def test_heartbeat_watchdog_no_apaga_si_hay_run_activo_y_apaga_en_cuanto_termina_su_proceso(self):
        worker = start_worker(self)
        upsert_run({"run_id": "run_wd", "conversation_id": "conv_watchdog", "pid": worker.pid, "status": "running"})

        mock_server = mock.Mock()
        zerochat.HEARTBEAT_INITIALIZED = True
        zerochat.HEARTBEAT_LAST_SEEN = time.monotonic() - 100.0

        waiting = waiting_on(self, zerochat._WATCHDOG_COND)

        def finish_once_waiting():
            # El latido ya venció: el vigilante solo espera porque la ejecución sigue en marcha. Su proceso
            # termina sin que nadie lo recoja (queda zombi), como el de una ejecución que lanzó la interfaz.
            self.assertTrue(waiting.wait(5))
            worker.terminate()

        threading.Thread(target=finish_once_waiting, daemon=True).start()

        started = time.monotonic()
        with mock.patch.object(zerochat, "stop_zerochat_server") as mock_stop:
            zerochat.heartbeat_watchdog(mock_server, inactivity_timeout_seconds=0.05)
            mock_stop.assert_called_once_with(mock_server)
        self.assertLess(time.monotonic() - started, 5)
        if zerochat.pid_exit_waitable():
            self.assertEqual(waiting.timeouts, [None], "Espera el final de la ejecución sin releer")

    def test_el_proceso_de_una_ejecucion_lanzada_por_el_servidor_se_recoge_al_terminar(self):
        worker = start_worker(self)
        start = zerochat._process_start_token(worker.pid)
        notified = threading.Event()
        with mock.patch.object(zerochat, "notify_live_change", side_effect=notified.set):
            zerochat.watch_run_exit(worker.pid, start, worker)
            worker.terminate()
            self.assertTrue(notified.wait(5))
        # Lo recogió el hilo (returncode), no la prueba: no queda zombi y ya no figura en marcha.
        self.assertIsNotNone(worker.returncode)
        self.assertFalse(zerochat._run_process_alive({"pid": worker.pid, "pid_start": start}))

    def test_el_latido_en_espera_despierta_al_terminar_una_ejecucion_y_solo_relee_con_su_conversacion_a_la_vista(self):
        ctx = zerochat.SecurityContext(workspace_dir=self.data_dir)
        waiting = waiting_on(self, zerochat._LIVE_STATE_COND)
        for focus in (None, "conv_vista"):
            with self.subTest(focus=focus):
                worker = start_worker(self)
                upsert_run({"run_id": f"run_{focus}", "conversation_id": "conv_vista", "pid": worker.pid, "status": "running"})
                initial = zerochat.live_state(ctx, focus)["rev"]
                waiting.clear()
                waiting.timeouts.clear()

                def finish_once_waiting():
                    self.assertTrue(waiting.wait(5))
                    worker.terminate()

                threading.Thread(target=finish_once_waiting, daemon=True).start()
                started = time.monotonic()
                updated = zerochat.wait_live_state(ctx, focus, since_rev=initial, wait_ms=20000)
                self.assertLess(time.monotonic() - started, 5)
                # Murió sin dejar resultado: el latido la entrega en error.
                self.assertEqual([run["status"] for run in updated["runs"]], ["error"])
                if focus:
                    # Su progreso no avisa: con su conversación a la vista se relee cada poco.
                    self.assertLessEqual(waiting.timeouts[0], zerochat._EXTERNAL_RUN_POLL_SECONDS)
                elif zerochat.pid_exit_waitable():
                    self.assertGreater(waiting.timeouts[0], zerochat._EXTERNAL_RUN_POLL_SECONDS, "Sin trocear la espera")

    def test_la_firma_del_estado_vivo_ignora_la_salida_de_los_comandos(self):
        job = {"id": 1, "status": "running", "elapsed_s": 1, "output_bytes": 10, "last_line": "a"}
        state = {"jobs": [job], "runs": []}
        rev = zerochat._live_state_rev(state)
        chatty = {**job, "elapsed_s": 9, "output_bytes": 9000, "last_line": "z"}
        self.assertEqual(zerochat._live_state_rev({**state, "jobs": [chatty]}), rev)
        self.assertNotEqual(zerochat._live_state_rev({**state, "jobs": [{**job, "status": "done"}]}), rev)

    def test_heartbeat_long_poll_despierta_con_cambio(self):
        ctx = zerochat.SecurityContext(workspace_dir=self.data_dir)
        initial = zerochat.live_state(ctx)
        self.assertEqual(initial["rev"], zerochat.live_state(ctx)["rev"])

        waiting = waiting_on(self, zerochat._LIVE_STATE_COND)

        def trigger_change():
            self.assertTrue(waiting.wait(5))
            upsert_run({
                "run_id": "run_lp",
                "conversation_id": "conv_lp",
                "pid": os.getpid(),
                "status": "needs_input"
            })

        started = time.monotonic()
        threading.Thread(target=trigger_change, daemon=True).start()
        updated = zerochat.wait_live_state(ctx, since_rev=initial["rev"], wait_ms=5000)
        self.assertLess(time.monotonic() - started, 2.0)
        self.assertNotEqual(updated["rev"], initial["rev"])
        self.assertEqual([r["conversation_id"] for r in updated["runs"]], ["conv_lp"])
        _, err, _ = zerochat._heartbeat({"wait_ms": -5}, ctx)
        self.assertEqual(err["code"], -32602)

    def test_borrar_conversaciones_limpia_runs(self):
        upsert_run({
            "run_id": "run_1",
            "conversation_id": "conv_del_1",
            "pid": 33333,
            "status": "needs_input"
        })
        upsert_run({
            "run_id": "run_2",
            "conversation_id": "conv_del_2",
            "pid": 33334,
            "status": "needs_input"
        })

        zerochat.save_conversation({"id": "conv_del_1", "title": "Del 1"}, [])
        zerochat.save_conversation({"id": "conv_del_2", "title": "Del 2", "project": "/repo/b"}, [])
        zerochat.save_conversation({"id": "conv_del_3", "title": "Del 3", "project": "/repo/c"}, [])

        zerochat.dispatch_conversations("zerochat/conversations/delete", {"id": "conv_del_1"})
        self.assertIsNone(zerochat.get_run_state("conv_del_1"))
        self.assertIsNotNone(zerochat.get_run_state("conv_del_2"))

        # Por proyecto: solo sus conversaciones y sus ejecuciones.
        result, error, _ = zerochat.dispatch_conversations("zerochat/conversations/delete", {"project": "/repo/c"})
        self.assertIsNone(error)
        self.assertEqual(result["count"], 1)
        self.assertIsNotNone(zerochat.get_run_state("conv_del_2"))
        self.assertEqual([c["id"] for c in zerochat.list_conversations()], ["conv_del_2"])
        _, error, _ = zerochat.dispatch_conversations("zerochat/conversations/delete", {"project": "  "})
        self.assertEqual(error["code"], -32602)

        zerochat.dispatch_conversations("zerochat/conversations/delete", {"all": True})
        self.assertIsNone(zerochat.get_run_state("conv_del_2"))


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

    def test_la_conversacion_nueva_de_run_file_queda_como_ejecucion_en_servidor_con_su_perfil(self):
        use_data_dir(self)
        orchestrated = zerochat.RunSession("Hola", "oficina", new_conversation_id="session_nueva_orquestada")
        from_server = zerochat.RunSession("Hola", "oficina")
        for session in (orchestrated, from_server):
            zerochat.save_conversation({"id": session.new_conversation_id, "title": "Agente"}, [{"id": "u1", "role": "user", "content": "Hola"}])
            session.result = {"text": "hecho"}
            with mock.patch.object(zerochat, "RUN_SESSION", session), mock.patch.object(zerochat, "_MUTED", False), \
                 mock.patch.object(sys, "stdout", io.StringIO()), self.assertRaises(SystemExit):
                zerochat.finish_run(None, io.StringIO())
        marked = zerochat.get_conversation("session_nueva_orquestada")
        self.assertEqual((marked.get("serverRun"), marked.get("profileId")), (True, "oficina"))
        # Una nueva con id del servidor no la sigue nadie: queda como la dejó la interfaz.
        self.assertNotIn("serverRun", zerochat.get_conversation(from_server.new_conversation_id))
