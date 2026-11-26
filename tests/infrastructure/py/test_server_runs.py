import io
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.parse
from pathlib import Path
from unittest import mock
from backend import ZEROCHAT_PY, use_data_dir, use_project, zerochat

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


def post_rpc(method, sent_token, user_agent=None, project=None) -> int:
    """Una petición HTTP entera al manejador, en memoria (sin sockets ni plazos de red); devuelve su estado."""
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": {}}).encode()
    agent = f"User-Agent: {user_agent}\r\n" if user_agent else ""
    agent += f"X-ZeroChat-Project: {urllib.parse.quote(str(project))}\r\n" if project else ""
    head = (f"POST / HTTP/1.0\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n{agent}"
            f"X-ZeroChat-Token: {sent_token}\r\nContent-Length: {len(body)}\r\n\r\n").encode()
    connection = mock.Mock(sent=bytearray())
    connection.makefile.side_effect = lambda mode, *args: io.BytesIO(head + body) if "r" in mode else io.BytesIO()
    connection.sendall.side_effect = connection.sent.extend
    with mock.patch("sys.stderr", io.StringIO()):
        zerochat.ZeroChatServerHandler(connection, ("127.0.0.1", 50000), mock.Mock())
    return int(bytes(connection.sent).split(b" ", 2)[1])


def save_conv(*conversation_ids):
    """Conversaciones guardadas para filas de runs: list_server_runs limpia las terminadas sin conversación."""
    for conv_id in conversation_ids:
        zerochat.save_conversation({"id": conv_id, "title": conv_id, "updatedAt": 1}, [{"id": f"{conv_id}_u", "role": "user", "content": "Hola"}])


def upsert_run(fields):
    """Guarda un estado de ejecución completo con los campos que importan a cada prueba."""
    now = int(time.time() * 1000)
    zerochat.upsert_run_state({
        "pid": None, "pid_start": None, "started_at": now, "updated_at": now,
        "step_text": "", "pending": None, "error": None, **fields,
    })


def run_md(fields: dict) -> str:
    """Run-file Markdown con esos campos: prompt y systemDataPrompt en sus secciones y el resto, tal cual, en la cabecera."""
    header = [f"{key}: {str(value).lower() if isinstance(value, bool) else value}"
              for key, value in fields.items() if key not in ("prompt", "systemDataPrompt")]
    lines = ["---", *header, "---"]
    for marker, key in (("system", "systemDataPrompt"), ("prompt", "prompt")):
        if key in fields:
            lines += [f"<!-- {marker} -->", str(fields[key])]
    return "\n".join(lines) + "\n"


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

        # zerochat/run/usage guarda el consumo acumulado (el último que llega) con contadores enteros hasta RUN_USAGE_MAX.
        self.assertIsNone(zerochat.get_run_state(conv_id)["usage"])
        usage = {"model_calls": 2, "prompt_tokens": zerochat.RUN_USAGE_MAX, "completion_tokens": 45, "cached_tokens": 90,
                 "reasoning_tokens": 0, "estimated": False}
        for invalid in ({**usage, "prompt_tokens": zerochat.RUN_USAGE_MAX + 1}, {**usage, "completion_tokens": -1},
                        {**usage, "cached_tokens": 1.5}, {**usage, "model_calls": True}, {**usage, "estimated": "no"},
                        {key: value for key, value in usage.items() if key != "reasoning_tokens"}):
            _, err, _ = dispatch_run("zerochat/run/usage", {"run_id": session.run_id, **invalid})
            self.assertEqual(err["code"], zerochat.INVALID_PARAMS, invalid)
        self.assertIsNone(zerochat.get_run_state(conv_id)["usage"])
        used, err, _ = dispatch_run("zerochat/run/usage", {"run_id": session.run_id, **usage, "extra": 1})
        self.assertEqual((err, used), (None, {"ok": True}))
        self.assertEqual(zerochat.get_run_state(conv_id)["usage"], usage)
        self.assertIn("zerochat/run/usage", zerochat.RUNNER_ALLOWED_METHODS)

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
        self.assertEqual(data["usage"], usage, "El resultado conserva el consumo")
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
        self.assertIsNone(data_err["usage"], "Cada ejecución cuenta lo suyo")
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

    def test_la_plantilla_de_agente_del_modo_agentes_es_un_run_file_valido(self):
        # agents/template.md de templates/project/mode-agent-templates.txt, con sus marcadores rellenos como haría el modelo.
        templates = (ZEROCHAT_PY.parent / "templates" / "project" / "mode-agent-templates.txt").read_text(encoding="utf-8")
        block = re.search(r"agents/template\.md[^\n]*\n```markdown\n(.*?)```", templates, re.S).group(1)
        request = zerochat.parse_run_request(block.replace("<set>.<role>", "informes.diario").replace("<role>", "diario").encode())
        self.assertEqual((request["agent"], request["conversation_id"], request["prompt"]), ("informes.diario", "informes.diario", "Run the scheduled task."))
        self.assertTrue(request["systemDataPrompt"].startswith("You are the diario agent"), "El manual va tras la cabecera, sin marca")
        self.assertIn("exact path of each file", request["systemDataPrompt"])

    def test_la_cli_no_lanza_otra_ejecucion_de_una_conversacion_en_marcha(self):
        zerochat.save_general_profile({"name": "local", "settings": {}})
        zerochat.save_conversation({"id": "conv_cron", "title": "Cron"}, [{"id": "u1", "role": "user", "content": "Tarea"}])
        parser = zerochat.build_parser()
        folder = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, folder, True)
        request = folder / "nueva.md"
        request.write_text(run_md({"prompt": "Hola", "conversation_id": "conv_cron_nueva"}), encoding="utf-8")
        worker = start_worker(self)
        running = {"status": "running", "pid": worker.pid, "pid_start": zerochat._process_start_token(worker.pid)}

        def busy(argv):
            with self.assertRaises(SystemExit) as cm, mock.patch("sys.stderr", io.StringIO()) as err:
                zerochat.run_session_from_args(parser, parser.parse_args(argv))
            self.assertEqual(cm.exception.code, zerochat.RUN_EXIT_BUSY)
            self.assertIn("Ya hay una ejecución en marcha", err.getvalue())

        # --conversation y --run-file con un conversation_id fijo (aún sin crear) que otra ejecución viva ya usa.
        upsert_run({"run_id": "otra", "conversation_id": "conv_cron", **running})
        busy(["--conversation", "conv_cron"])
        upsert_run({"run_id": "otra", "conversation_id": "conv_cron_nueva", **running})
        busy(["--run-file", str(request)])

        # Terminada la otra, se lanza.
        worker.kill()
        worker.wait()
        self.assertIsNotNone(zerochat.run_session_from_args(parser, parser.parse_args(["--conversation", "conv_cron"])))

        # El hijo que lanzó zerochat/run/start ya está anotado con su propio run_id: no es otra ejecución.
        child = start_worker(self)
        upsert_run({"run_id": "propia", "conversation_id": "conv_cron", "status": "running", "pid": child.pid,
                    "pid_start": zerochat._process_start_token(child.pid)})
        with mock.patch.dict(os.environ, {"ZEROCHAT_RUN_ID": "propia"}):
            self.assertEqual(zerochat.run_session_from_args(parser, parser.parse_args(["--conversation", "conv_cron"])).run_id, "propia")

    def test_run_file_valida_la_peticion_crea_o_continua_la_conversacion_y_exige_entorno_guardado(self):
        # Las sesiones de esta prueba quedan anotadas en runs como vivas (son este proceso) y nunca terminan: con un
        # run_id fijo, como el hijo de zerochat/run/start, la siguiente de la misma conversación no las toma por otra.
        run_id = mock.patch.dict(os.environ, {"ZEROCHAT_RUN_ID": "run_de_prueba"})
        run_id.start()
        self.addCleanup(run_id.stop)
        zerochat.save_general_profile({"name": "local", "settings": {}})
        parser = zerochat.build_parser()
        folder = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, folder, True)

        def write_request(data) -> str:
            path = folder / "peticion.md"
            path.write_text(run_md(data) if not isinstance(data, str) else data, encoding="utf-8")
            return str(path)

        parse = lambda fields: zerochat.parse_run_request(run_md(fields).encode())

        def session_from(argv):
            return zerochat.run_session_from_args(parser, parser.parse_args(argv))

        def rejects(argv):
            with self.assertRaises(SystemExit) as cm, mock.patch("sys.stderr", io.StringIO()):
                session_from(argv)
            self.assertEqual(cm.exception.code, zerochat.RUN_EXIT_ARGS)

        # Petición no válida: campos de permisos o herramientas, textos vacíos y un fichero que no es un run-file.
        for invalid in ({"prompt": "Hola", "enabledTools": "run_command"}, {"prompt": "Hola", "tool_security": "{}"},
                        {"prompt": "  "}, {"prompt": "Hola", "watchAgents": "*"}, {"prompt": "Hola", "agent": ""}, "Hola",
                        '{"prompt": "Hola"}', "---\nprofile: local\n<!-- prompt -->\nHola\n"):
            rejects(["--run-file", write_request(invalid)])
        rejects(["--run-file", write_request({"profile": "local"})])
        rejects(["--run-file", str(folder / "no_existe.md")])
        rejects(["--run-file", write_request({"prompt": "Hola"}), "--prompt", "Otro"])
        for text, message in (("---\nprofile: a\nprofile: b\n---\n", "dos veces"), ("---\nsin dos puntos\n---\n", "desconocido"),
                              ("---\n---\n<!-- prompt -->\nA\n<!-- prompt -->\nB\n", "dos veces"),
                              ("---\n---\nManual\n<!-- system -->\nOtro\n", "antes de las secciones"), (b"---\n---\n\xff", "UTF-8")):
            with self.assertRaisesRegex(ValueError, message):
                zerochat.parse_run_request(text if isinstance(text, bytes) else text.encode())

        # Cabecera y secciones: el texto sin marcador es el system, los marcadores van en su propia línea, los saltos de
        # línea de Windows y el BOM no cuentan, y format_run_request escribe lo que parse_run_request devuelve igual.
        self.assertEqual(zerochat.parse_run_request("\ufeff---\r\nagent: diario\r\n---\r\nEres el agente.\r\n<!-- prompt -->\r\n"
                                                    "Usa <!-- prompt --> en el texto.\r\n".encode()),
                         {"agent": "diario", "systemDataPrompt": "Eres el agente.", "prompt": "Usa <!-- prompt --> en el texto.",
                          "projectMode": False, "reasoning": "medium"})
        full = {"agent": "informes.diario", "conversation_id": "fija", "profile": "local", "controller": True, "projectMode": True,
                "reasoning": "high", "disabledTools": ["imap", "run_command"], "maxSteps": 5, "timeout": 60,
                "systemDataPrompt": "Manual con ejemplo:\n```markdown\n<!-- system -->\nEjemplo\n<!-- prompt -->\nHazlo\n```",
                "prompt": "Tarea con ~~~ y ```\n~~~\n<!-- prompt -->\n~~~"}
        self.assertEqual(zerochat.parse_run_request(zerochat.format_run_request(full).encode()), full)
        self.assertNotIn("controller", parse({"prompt": "Hola", "controller": False}), "Solo se guarda cuando es true")
        for unsafe in ({"profile": "a\nb"}, {"prompt": "x\n<!-- system -->\ny"},
                       {"systemDataPrompt": "```\nSin cerrar", "prompt": "Tarea"}):
            with self.assertRaises(ValueError):
                zerochat.format_run_request(unsafe)

        # Tope del fichero en el borde exacto: N bytes se aceptan y N+1 no.
        body = run_md({"prompt": "Hola"})
        at_limit = (body + " " * (zerochat.RUN_FILE_MAX_BYTES - len(body))).encode()
        self.assertEqual(zerochat.parse_run_request(at_limit), {"prompt": "Hola", "projectMode": False, "reasoning": "medium"})
        with self.assertRaisesRegex(ValueError, "no puede superar"):
            zerochat.parse_run_request(at_limit + b" ")

        # Límites: enteros de 1 a su máximo, en el borde exacto.
        for key, maximum in zerochat.RUN_FILE_LIMIT_KEYS.items():
            self.assertEqual(parse({"prompt": "Hola", key: maximum})[key], maximum)
            for invalid in (maximum + 1, 0, True, "", "-1", 2.5, "５"):
                with self.assertRaisesRegex(ValueError, f"{key} debe ser un entero"):
                    parse({"prompt": "Hola", key: invalid})

        # reasoning: uno de los niveles del selector, medium si el fichero no lo indica.
        for level in zerochat.RUN_REASONING_LEVELS:
            self.assertEqual(parse({"prompt": "Hola", "reasoning": level})["reasoning"], level)
        self.assertEqual(zerochat.RUN_REASONING_LEVELS, ("none", "low", "medium", "high", "xhigh"))
        for invalid in ("max", "Medium", "", 2, True):
            with self.assertRaisesRegex(ValueError, "reasoning debe ser"):
                parse({"prompt": "Hola", "reasoning": invalid})
        self.assertIsNone(session_from(["--prompt", "Hola"]).reasoning, "Sin --run-file queda el del perfil")

        # disabledTools: nombres separados por comas, sin repetir y con tope de nombres y de longitud en el borde exacto.
        self.assertEqual(parse({"prompt": "Hola", "disabledTools": " imap ,run_command, imap,mcp_imap_send"})["disabledTools"],
                         ["imap", "run_command", "mcp_imap_send"])
        many = [f"t{index}" for index in range(zerochat.MAX_DISABLED_TOOLS)]
        self.assertEqual(parse({"prompt": "Hola", "disabledTools": ", ".join(many)})["disabledTools"], many)
        long_name = "x" * zerochat.MAX_PROJECT_TOOL_ID_LENGTH
        self.assertEqual(parse({"prompt": "Hola", "disabledTools": long_name})["disabledTools"], [long_name])
        for invalid in ("", "imap,,run_command", "imap, ", "dos palabras", long_name + "x", ", ".join([*many, "otra"])):
            with self.assertRaisesRegex(ValueError, "disabledTools"):
                parse({"prompt": "Hola", "disabledTools": invalid})

        # projectMode y controller: por defecto no; solo admiten true o false.
        self.assertTrue(parse({"prompt": "Hola", "projectMode": True})["projectMode"])
        for key in ("projectMode", "controller"):
            for invalid in ("True", "1", "yes", ""):
                with self.assertRaisesRegex(ValueError, f"{key} debe ser true o false"):
                    parse({"prompt": "Hola", key: invalid})

        # Un conversation_id que no existe es el de la conversación nueva; sin prompt no hay con qué empezarla.
        session = session_from(["--run-file", write_request({
            "conversation_id": "session_orquestador_1", "prompt": " Redacta el informe ", "systemDataPrompt": "Eres el agente de informes.",
            "maxSteps": 20, "timeout": 600})])
        self.assertEqual((session.conversation_id, session.new_conversation_id), (None, "session_orquestador_1"))
        self.assertEqual((session.max_steps, session.timeout_seconds, session.project_mode), (20, 600, False))
        self.assertEqual((session.prompt, session.profile, session.system_data_prompt), ("Redacta el informe", "local", "Eres el agente de informes."))
        rejects(["--run-file", write_request({"conversation_id": "session_orquestador_2"})])

        # Uno que existe se continúa, como --conversation; desde stdin con -. No marca serverRun antes de comprobar el entorno.
        zerochat.save_conversation({"id": "session_orquestador_3", "title": "Agente"}, [{"id": "u1", "role": "user", "content": "Hola"}])
        with mock.patch("sys.stdin", mock.Mock(buffer=io.BytesIO(run_md({"conversation_id": "session_orquestador_3"}).encode()))):
            session = session_from(["--run-file", "-"])
        self.assertEqual((session.conversation_id, session.new_conversation_id, session.prompt), ("session_orquestador_3", None, None))
        self.assertNotIn("serverRun", zerochat.get_conversation("session_orquestador_3"))

        # agent: la conversación nueva de la ejecución lo lleva aunque el runner no lo envíe (también por tramos); otra no.
        # El identificador lo valida validate_agent_id (test_storage.py).
        self.assertEqual(parse({"prompt": "Hola", "agent": "diario"})["agent"], "diario")
        with self.assertRaisesRegex(ValueError, "agent debe ser"):
            parse({"prompt": "Hola", "agent": "a.b.c"})
        def save_as_run(conv_id, chunked):
            zerochat.RUN_SESSION = session_from(["--run-file", write_request({"conversation_id": conv_id, "prompt": "Hola", "agent": "informes.diario"})])
            if chunked:
                _, err, _ = zerochat.dispatch_conversations("zerochat/conversations/save_chunk", {
                    "conversationId": conv_id, "uploadId": f"up_{conv_id}", "chunkIndex": 0, "totalChunks": 1, "messages": []})
                self.assertIsNone(err)
                params = {"conversation": {"id": conv_id}, "uploadId": f"up_{conv_id}"}
            else:
                params = {"conversation": {"id": conv_id}, "messages": []}
            saved, err, _ = zerochat.dispatch_conversations("zerochat/conversations/save", params)
            self.assertIsNone(err)
            return saved["conversation"]

        self.assertEqual(save_as_run("session_agente_1", chunked=False)["agent"], "informes.diario")
        self.assertEqual(save_as_run("session_agente_2", chunked=True)["agent"], "informes.diario")
        other, _, _ = zerochat.dispatch_conversations("zerochat/conversations/save", {"conversation": {"id": "session_humana"}, "messages": []})
        self.assertNotIn("agent", other["conversation"])
        zerochat.RUN_SESSION = None
        # Continuar una conversación existente exige el mismo agente: otro, ninguno o uno sobre una sin agente es error.
        zerochat.save_conversation({"id": "session_agente_1"}, [{"id": "u1", "role": "user", "content": "Hola"}])
        session_from(["--run-file", write_request({"conversation_id": "session_agente_1", "agent": "informes.diario"})])
        rejects(["--run-file", write_request({"conversation_id": "session_agente_1"})])
        rejects(["--run-file", write_request({"conversation_id": "session_agente_1", "agent": "informes.semanal"})])
        rejects(["--run-file", write_request({"conversation_id": "session_orquestador_3", "agent": "informes.diario"})])

        # Sin conversation_id, --run-file (con o sin agent) también deja fila en runs para Pendientes y check_agents.
        ephemeral = session_from(["--run-file", write_request({"prompt": "Efímera", "agent": "informes.efimero"})])
        self.assertEqual(ephemeral.state_conversation_id, ephemeral.new_conversation_id)
        self.assertIsNotNone(zerochat.get_run_state(ephemeral.new_conversation_id))
        zerochat.remove_run_state(ephemeral.new_conversation_id)

        # El lanzamiento de un agente se guarda en su conversación desde el primer guardado y la interfaz, al guardarla, no lo toca ni pisa profileId.
        zerochat.save_general_profile({"name": "informes", "settings": {}})
        session = session_from(["--run-file", write_request({
            "conversation_id": "session_agente_1", "prompt": "Otra vez", "agent": "informes.diario", "profile": "informes",
            "systemDataPrompt": "Manual del agente", "projectMode": True, "maxSteps": 30, "reasoning": "high", "disabledTools": "imap"})])
        launch = {"profile": "informes", "systemDataPrompt": "Manual del agente", "projectMode": True, "maxSteps": 30, "reasoning": "high",
                  "disabledTools": ["imap"]}
        self.assertEqual(session.launch, launch)
        self.assertEqual(session.disabled_tools, ("imap",))
        self.assertEqual(session.reasoning, "high")
        zerochat.RUN_SESSION = session
        saved_step, err, _ = zerochat.dispatch_conversations("zerochat/conversations/save", {
            "conversation": {"id": "session_agente_1"},
            "messages": [{"id": "u1", "role": "user", "content": "Otra vez"}],
        })
        self.assertIsNone(err)
        self.assertNotIn("launch", saved_step["conversation"])
        self.assertEqual((saved_step["conversation"]["serverRun"], saved_step["conversation"]["profileId"]), (True, "informes"))
        self.assertEqual(zerochat.get_conversation_launch("session_agente_1"), launch)
        zerochat.RUN_SESSION = None
        self.assertIsNone(zerochat.RunSession("Hola").launch, "Sin agent no hay lanzamiento que guardar")
        # Mientras la ejecución sigue viva, la interfaz no puede guardar su copia encima; terminada, sí.
        ui_params = {"conversation": {"id": "session_agente_1"}, "messages": []}
        _, err, _ = zerochat.dispatch_conversations("zerochat/conversations/save", ui_params)
        self.assertEqual(err["code"], zerochat.INVALID_PARAMS)
        self.assertEqual(len(zerochat.get_conversation("session_agente_1")["history"]), 1)
        zerochat.remove_run_state("session_agente_1")
        ui_saved, err, _ = zerochat.dispatch_conversations("zerochat/conversations/save", {
            "conversation": {"id": "session_agente_1", "profileId": "local", "launch": {"profile": "local"}},
            "messages": [{"id": "u1", "role": "user", "content": "Hola"}],
        })
        self.assertIsNone(err)
        self.assertNotIn("launch", ui_saved["conversation"])
        self.assertEqual(ui_saved["conversation"]["profileId"], "informes")
        self.assertEqual(zerochat.get_conversation_launch("session_agente_1"), launch)

        # Continuarla sin --run-file (la interfaz con run/start o --conversation) repite su lanzamiento, no el perfil pedido.
        resumed = session_from(["--conversation", "session_agente_1"])
        self.assertEqual((resumed.profile, resumed.system_data_prompt, resumed.max_steps, resumed.timeout_seconds, resumed.project_mode, resumed.agent,
                          resumed.reasoning), ("informes", "Manual del agente", 30, None, True, "informes.diario", "high"))
        # El runner lo recibe con el prompt para aplicarlo tras activar el perfil.
        zerochat.RUN_SESSION = resumed
        delivered, err, _ = zerochat.dispatch_run("zerochat/run/prompt", {"run_id": resumed.run_id}, zerochat.project_context())
        self.assertEqual((err, delivered["reasoning"]), (None, "high"))
        zerochat.RUN_SESSION = None
        self.assertEqual(session_from(["--conversation", "session_agente_1", "--profile", "informes"]).profile, "informes")
        rejects(["--conversation", "session_agente_1", "--profile", "local"])
        self.assertEqual(zerochat._run_target({"conversation_id": "session_agente_1", "profile": "local"})[2], "informes")
        self.assertEqual(zerochat.get_conversation("session_agente_1")["profileId"], "informes")

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
        zerochat.RUN_SESSION = None

        # Ya preparada, --run-file anuncia en stderr, también sin registro, la conversación que sigue: nueva o la indicada.
        zerochat.save_conversation({"id": "session_agente_3", "project": str(ctx.workspace_dir), "agent": "informes.diario"},
                                   [{"id": "u1", "role": "user", "content": "Hola"}])
        for request, new in (({"prompt": "Hola", "agent": "informes.efimero"}, "true"),
                             ({"conversation_id": "session_agente_3", "agent": "informes.diario"}, "false")):
            args = parser.parse_args(["--run-file", write_request(request)])
            session = zerochat.run_session_from_args(parser, args)
            with mock.patch("sys.stderr", io.StringIO()) as stderr:
                zerochat._prepare_run_environment(parser, args, session)
            conv_id = session.conversation_id or session.new_conversation_id
            self.assertEqual(stderr.getvalue(), f"[run] conversation_id={conv_id} new={new}\n")

    def test_check_agents_solo_con_controller_y_solo_agentes_del_proyecto(self):
        ctx = use_project(self, Path(tempfile.mkdtemp()))
        self.addCleanup(shutil.rmtree, ctx.workspace_dir, True)
        names = lambda: [tool["name"] for tool in zerochat._local_tools()]
        check = lambda **args: json.loads(zerochat.check_agents(**args, ctx=ctx))

        # Fuera de una ejecución con controller: true no se publica, no se autoriza en sesión ni responde.
        self.assertNotIn("check_agents", names())
        zerochat.RUN_SESSION = zerochat.RunSession("Hola")
        self.assertNotIn("check_agents", names())
        zerochat.reset_session_authorizations()
        self.assertNotEqual(zerochat.ACCESS_CONTROLLER.evaluate_authorization("check_agents", {}, context=ctx).status, zerochat.POLICY_ALLOW)
        self.assertFalse(check()["success"])
        self.assertIsNone(zerochat.validate_local_tool_arguments("check_agents", {"agent": "a.b"}))
        self.assertIsNotNone(zerochat.validate_local_tool_arguments("check_agents", {"agent": 123}))
        self.assertIsNotNone(zerochat.validate_local_tool_arguments("check_agents", {"extra": "x"}))

        def conv(conv_id, agent=None, project=ctx.key, history=None, updated_at=1000):
            meta = {"id": conv_id, "title": conv_id, "updatedAt": updated_at, "project": project, **({"agent": agent} if agent else {})}
            zerochat.save_conversation(meta, history or [{"id": f"{conv_id}_u", "role": "user", "content": "Empieza"}])

        conv("diario_viejo", "informes.diario", updated_at=1000)
        conv("diario_nuevo", "informes.diario", updated_at=3000, history=[
            {"id": "u1", "role": "user", "content": "Primero"}, {"id": "a1", "role": "assistant", "content": "Hecho"},
            {"id": "u2", "role": "user", "content": "Ahora"},
            {"id": "a2", "role": "assistant", "content": None, "tool_calls": [{"id": "c1", "function": {"name": "ask_user", "arguments": "{}"}}]},
            {"id": "t1", "role": "tool", "tool_call_id": "c1", "name": "ask_user", "content": "{}"}])
        conv("semanal", "informes.semanal", updated_at=2000)
        conv("ventas", "ventas.diario")
        conv("humana")
        conv("otro_proyecto", "informes.otro", project="/otro/proyecto")
        conv("master", "informes.master", updated_at=4000)
        upsert_run({"run_id": "r1", "conversation_id": "diario_nuevo", "status": "needs_input", "pending": {"kind": "ask_user", "text": "¿Mes?"},
                    "result_text": "x" * 10})
        upsert_run({"run_id": "r2", "conversation_id": "semanal", "status": "completed", "result_text": "y" * 20,
                    "warnings": ["run_command: denegado"], "usage": {"model_calls": 3, "prompt_tokens": 900, "completion_tokens": 30,
                                                                      "cached_tokens": 0, "reasoning_tokens": 0, "estimated": True}})

        zerochat.RUN_SESSION = zerochat.RunSession("Vigila", conversation_id="master", controller=True)
        self.assertIn("check_agents", names())
        zerochat.reset_session_authorizations()
        self.assertEqual(zerochat.ACCESS_CONTROLLER.evaluate_authorization("check_agents", {}, context=ctx).status, zerochat.POLICY_ALLOW)

        # Listado: la conversación más reciente de cada agente del proyecto, de cualquier subconjunto, nunca humanas, otros
        # proyectos ni la del propio controlador.
        listed = check()["agents"]
        self.assertEqual([(item["agent"], item["conversation_id"], item["status"]) for item in listed],
                         [("informes.diario", "diario_nuevo", "needs_input"), ("informes.semanal", "semanal", "completed"), ("ventas.diario", "ventas", None)])
        self.assertEqual((listed[0]["pending"], listed[0]["result_text"]), ({"kind": "ask_user", "text": "¿Mes?"}, "x" * 10))
        self.assertEqual((listed[1]["result_text"], listed[1]["warnings"]), ("y" * 20, ["run_command: denegado"]))
        self.assertEqual((listed[0]["usage"], listed[1]["usage"]["prompt_tokens"]), (None, 900))

        # Detalle: por agente (su conversación más reciente) o por conversación de agente; el último turno, solo con include_turn.
        self.assertNotIn("last_turn", check(agent="informes.diario"))
        detail = check(agent="informes.diario", include_turn=True)
        self.assertEqual(detail["conversation_id"], "diario_nuevo")
        self.assertEqual(detail["last_turn"], [{"role": "user", "content": "Ahora"}, {"role": "assistant", "content": "", "tool_calls": ["ask_user"]},
                                               {"role": "tool", "content": "{}", "name": "ask_user"}])
        self.assertEqual(check(conversation_id="diario_viejo")["conversation_id"], "diario_viejo")
        self.assertEqual(check(agent="ventas.diario")["conversation_id"], "ventas")
        for unseen in ({"conversation_id": "humana"}, {"conversation_id": "otro_proyecto"}, {"conversation_id": "master"}, {"agent": "informes.otro"}):
            self.assertFalse(check(**unseen)["success"], unseen)

        # Tope del último turno en el borde exacto: AGENT_TURN_MAX_CHARS de texto entre todos los mensajes, y uno más se recorta.
        turn_limit = zerochat.AGENT_TURN_MAX_CHARS
        for extra, truncated in ((0, False), (1, True)):
            conv("largo", "informes.largo", updated_at=5000, history=[
                {"id": "u", "role": "user", "content": "Haz"}, {"id": "a", "role": "assistant", "content": "z" * (turn_limit - 3 + extra)}])
            detail = check(conversation_id="largo", include_turn=True)
            self.assertEqual((sum(len(m["content"]) for m in detail["last_turn"]), detail.get("last_turn_truncated", False)), (turn_limit, truncated))

        # La evidencia visual que sigue a un resultado de herramienta (M67-D1) no abre un turno nuevo.
        conv("evidencia", "informes.evidencia", updated_at=6000, history=[
            {"id": "u", "role": "user", "content": "Mira"}, {"id": "t", "role": "tool", "content": "png", "name": "browser_action"},
            {"id": "e", "role": "user", "content": "[imagen]", "_toolEvidence": True}, {"id": "a", "role": "assistant", "content": "Visto"}])
        self.assertEqual([m["content"] for m in check(conversation_id="evidencia", include_turn=True)["last_turn"]],
                         ["Mira", "png", "[imagen]", "Visto"])

    def test_check_agents_da_la_respuesta_final_entera_si_cabe_y_por_bloques_en_el_detalle(self):
        ctx = use_project(self, Path(tempfile.mkdtemp()))
        self.addCleanup(shutil.rmtree, ctx.workspace_dir, True)
        check = lambda **args: json.loads(zerochat.check_agents(**args, ctx=ctx))
        per_agent, total, page = zerochat.AGENT_LIST_RESULT_MAX_CHARS, zerochat.AGENT_LIST_TOTAL_CHARS, zerochat.AGENT_RESULT_PAGE_CHARS

        def agents(lengths):
            # Uno por longitud, del más reciente (primero en el listado) al más antiguo.
            for index, length in enumerate(lengths):
                conv_id = f"a{index}"
                zerochat.save_conversation({"id": conv_id, "title": conv_id, "updatedAt": 100000 - index, "project": ctx.key,
                                            "agent": f"informes.n{index}"}, [{"id": "u", "role": "user", "content": "Empieza"}])
                # Una ejecución nueva por llamada: lo que ya se entregó de una ejecución no se repite (otra prueba).
                upsert_run({"run_id": f"r{index}_{len(lengths)}", "conversation_id": conv_id, "status": "completed", "result_text": "r" * length})

        zerochat.RUN_SESSION = zerochat.RunSession("Vigila", conversation_id="master", controller=True)
        # Por agente, entera hasta N; con N+1 se omite con result_chars y una nota para leerla en el detalle.
        agents([per_agent, per_agent + 1, 0])
        listed = check()
        self.assertEqual([(len(item.get("result_text", "")), item.get("result_chars")) for item in listed["agents"]],
                         [(per_agent, None), (0, per_agent + 1), (0, None)])
        self.assertNotIn("result_text", listed["agents"][1])
        self.assertIn("check_agents(conversation_id=", listed["note"])

        # Entre todas, el tope exacto cabe y la siguiente que no cabe se omite aunque sea corta.
        for conv_id in [item["id"] for item in zerochat.list_conversations()]:
            zerochat.delete_conversation(conv_id)
        agents([per_agent] * (total // per_agent) + [1, 0])
        listed = check()["agents"]
        self.assertEqual(sum(len(item.get("result_text", "")) for item in listed), total)
        self.assertEqual((listed[-2].get("result_chars"), listed[-1]["result_text"]), (1, ""))
        zerochat.save_conversation({"id": "solo", "title": "solo", "updatedAt": 1, "project": ctx.key, "agent": "informes.solo"}, [])
        self.assertNotIn("note", json.loads(zerochat.check_agents(agent="informes.solo", ctx=ctx)))

        # Detalle por bloques: N cabe en uno; N+1, en dos, siguiendo next_offset.
        for length, pages in ((page, [(page, None)]), (page + 1, [(page, page), (1, None)])):
            upsert_run({"run_id": "r_solo", "conversation_id": "solo", "status": "completed", "result_text": "".join(chr(97 + i % 26) for i in range(length))})
            offset, got, text = 0, [], ""
            while offset is not None:
                detail = check(conversation_id="solo", offset=offset)
                self.assertEqual((detail["result_chars"], detail["offset"]), (length, offset))
                got.append((len(detail["result_text"]), detail["next_offset"]))
                text += detail["result_text"]
                offset = detail["next_offset"]
            self.assertEqual(got, pages)
            self.assertEqual(text, "".join(chr(97 + i % 26) for i in range(length)))
        self.assertEqual(check(conversation_id="solo", offset=page + 1)["result_text"], "")
        for invalid in ({"conversation_id": "solo", "offset": page + 2}, {"conversation_id": "solo", "offset": -1},
                        {"conversation_id": "solo", "offset": True}, {"offset": 10}, {"include_turn": True},
                        {"agent": "informes.solo", "prune_keep": 1, "include_turn": True}):
            self.assertFalse(check(**invalid)["success"], invalid)

    def test_el_listado_no_repite_lo_ya_entregado_y_dice_cuantas_ejecuciones_hay_en_marcha(self):
        ctx = use_project(self, Path(tempfile.mkdtemp()))
        self.addCleanup(shutil.rmtree, ctx.workspace_dir, True)
        check = lambda **args: json.loads(zerochat.check_agents(**args, ctx=ctx))
        long_text = "x" * (zerochat.AGENT_LIST_RESULT_MAX_CHARS + 1)
        for conv_id, text in (("corto", "Resumen"), ("largo", long_text)):
            zerochat.save_conversation({"id": conv_id, "title": conv_id, "project": ctx.key, "agent": f"lector.{conv_id}"}, [])
            upsert_run({"run_id": f"r_{conv_id}", "conversation_id": conv_id, "status": "completed", "result_text": text})
        upsert_run({"run_id": "r_vivo", "conversation_id": "vivo", "status": "running", "pid": os.getpid(),
                    "pid_start": zerochat._process_start_token(os.getpid())})
        zerochat.RUN_SESSION = zerochat.RunSession("Vigila", conversation_id="master", controller=True)

        first = check()
        self.assertEqual(first["runs"], {"running": zerochat.running_run_count(), "max": zerochat.MAX_CONCURRENT_RUNS})
        self.assertGreaterEqual(first["runs"]["running"], 1)
        self.assertEqual({item["conversation_id"]: item.get("result_text") for item in first["agents"]}, {"corto": "Resumen", "largo": None})
        # La segunda vez, la entregada sale sin texto y con result_seen; la que no cupo, igual que antes.
        second = {item["conversation_id"]: item for item in check()["agents"]}
        self.assertEqual((second["corto"].get("result_seen"), second["corto"]["result_chars"], "result_text" in second["corto"]), (True, 7, False))
        self.assertNotIn("result_seen", second["largo"])
        self.assertIn("already delivered", check()["note"])
        # El detalle la da siempre; leer entera la larga por bloques también cuenta como entregada.
        self.assertEqual(check(conversation_id="corto")["result_text"], "Resumen")
        self.assertEqual(check(conversation_id="largo")["result_chars"], len(long_text))
        self.assertTrue({item["conversation_id"]: item for item in check()["agents"]}["largo"]["result_seen"])
        # Una ejecución nueva de la misma conversación se entrega otra vez, y otra ejecución del controlador también.
        upsert_run({"run_id": "r_corto_2", "conversation_id": "corto", "status": "completed", "result_text": "Otro"})
        self.assertEqual({item["conversation_id"]: item.get("result_text") for item in check()["agents"]}["corto"], "Otro")
        zerochat.RUN_SESSION = zerochat.RunSession("Vigila", conversation_id="master", controller=True)
        self.assertEqual({item["conversation_id"]: item.get("result_text") for item in check()["agents"]}["corto"], "Otro")
        zerochat.RUN_SESSION = None

    def test_un_agente_cortado_sin_respuesta_trae_su_ultimo_texto_como_parcial(self):
        ctx = use_project(self, Path(tempfile.mkdtemp()))
        self.addCleanup(shutil.rmtree, ctx.workspace_dir, True)
        check = lambda **args: json.loads(zerochat.check_agents(**args, ctx=ctx))
        history = [{"id": "u", "role": "user", "content": "Resume"},
                   {"id": "a1", "role": "assistant", "content": "Leídos los capítulos 1 y 2."},
                   {"id": "a2", "role": "assistant", "content": None, "tool_calls": [{"id": "c", "function": {"name": "read_file", "arguments": "{}"}}]},
                   {"id": "t", "role": "tool", "tool_call_id": "c", "name": "read_file", "content": "texto del fichero"},
                   {"id": "a3", "role": "assistant", "content": "  "}]
        alive_dead = {"pid": 2 ** 22 + 12345}
        for conv_id, run in (("limite", {"status": "limit", "error": "Límite de 5 pasos alcanzado."}), ("fallo", {"status": "error", "error": "500"}),
                             ("muerto", {"status": "running", **alive_dead}), ("bien", {"status": "completed", "result_text": "Resumen"}),
                             ("pausa", {"status": "needs_input", "pending": {"kind": "ask_user", "text": "¿Cuál?"}}),
                             ("vacio", {"status": "limit"})):
            zerochat.save_conversation({"id": conv_id, "title": conv_id, "project": ctx.key, "agent": f"lector.{conv_id}"},
                                       history if conv_id != "vacio" else history[:1])
            upsert_run({"run_id": f"r_{conv_id}", "conversation_id": conv_id, **run})
        zerochat.RUN_SESSION = zerochat.RunSession("Vigila", conversation_id="master", controller=True)

        # Límite, error o proceso muerto sin respuesta: el último texto del asistente (no las llamadas ni los vacíos), parcial.
        listed = {item["conversation_id"]: item for item in check()["agents"]}
        for conv_id in ("limite", "fallo", "muerto"):
            self.assertEqual((listed[conv_id]["result_text"], listed[conv_id].get("partial")), ("Leídos los capítulos 1 y 2.", True), conv_id)
        # Ya entregadas en esta ejecución: el siguiente listado no relee get_conversation para las que tenían texto.
        with mock.patch.object(zerochat, "get_conversation", wraps=zerochat.get_conversation) as get_conv:
            relisted = {item["conversation_id"]: item for item in check()["agents"]}
        self.assertEqual([call.args[0] for call in get_conv.call_args_list], ["vacio"])
        for conv_id in ("limite", "fallo", "muerto"):
            self.assertEqual((relisted[conv_id].get("result_seen"), relisted[conv_id].get("partial"), relisted[conv_id].get("result_chars")),
                             (True, True, 27), conv_id)
        detail = check(conversation_id="limite")
        self.assertEqual((detail["result_text"], detail["partial"], detail["result_chars"]), ("Leídos los capítulos 1 y 2.", True, 27))
        # Una respuesta entregada, una pausa o un corte sin ningún texto no son parciales.
        self.assertEqual((listed["bien"]["result_text"], "partial" in listed["bien"]), ("Resumen", False))
        for conv_id in ("pausa", "vacio"):
            self.assertEqual((listed[conv_id]["result_text"], "partial" in listed[conv_id]), ("", False), conv_id)

    def test_check_agents_espera_mientras_haya_agentes_en_marcha_y_vuelve_al_momento_si_no_hay_ninguno(self):
        ctx = use_project(self, Path(tempfile.mkdtemp()))
        self.addCleanup(shutil.rmtree, ctx.workspace_dir, True)
        check = lambda **args: json.loads(zerochat.check_agents(**args, ctx=ctx))
        alive = {"pid": os.getpid(), "pid_start": zerochat._process_start_token(os.getpid())}
        for conv_id, updated_at in (("diario", 1000), ("semanal", 2000), ("mensual", 3000), ("master", 4000)):
            agent = f"informes.{conv_id}"
            zerochat.save_conversation({"id": conv_id, "title": conv_id, "updatedAt": updated_at, "project": ctx.key, "agent": agent},
                                       [{"id": f"{conv_id}_u", "role": "user", "content": "Empieza"}])
        run = lambda conv_id, status, **extra: upsert_run({"run_id": f"r_{conv_id}", "conversation_id": conv_id, "status": status, **extra})
        later = lambda *args, **kwargs: threading.Timer(0.3, run, args, kwargs).start()
        zerochat.RUN_SESSION = zerochat.RunSession("Vigila", conversation_id="master", controller=True)
        self.assertIsNone(zerochat.validate_local_tool_arguments("check_agents", {"wait_seconds": 30}))
        self.assertIsNotNone(zerochat.validate_local_tool_arguments("check_agents", {"wait_seconds": "30"}))

        # (1) Ninguno en marcha (terminados, en pausa o sin ejecución): vuelve al momento, sin agotar wait_seconds.
        run("diario", "completed")
        run("semanal", "needs_input")
        started = time.monotonic()
        result = check(wait_seconds=30)
        self.assertLess(time.monotonic() - started, 2)
        self.assertEqual(result["returned_because"], "not_running")
        self.assertEqual(check(conversation_id="diario", wait_seconds=30)["returned_because"], "not_running")
        self.assertNotIn("returned_because", check())

        # (2) Con varios en marcha sigue esperando hasta que termina el último; el que termina antes no corta la espera.
        run("diario", "running", **alive)
        run("mensual", "running", **alive)
        threading.Timer(0.3, run, ("diario", "completed")).start()
        threading.Timer(0.9, run, ("mensual", "completed")).start()
        started = time.monotonic()
        result = check(wait_seconds=30)
        self.assertGreaterEqual(time.monotonic() - started, 0.9)
        self.assertEqual((result["returned_because"], sorted(item["status"] for item in result["agents"])),
                         ("not_running", ["completed", "completed", "needs_input"]))
        # Uno que pasa a needs_input o error corta la espera aunque otro siga en marcha; el que ya esperaba al empezar, no.
        for status in ("needs_input", "error"):
            run("diario", "running", **alive)
            run("mensual", "running", **alive)
            later("diario", status)
            result = check(wait_seconds=30)
            self.assertEqual(result["returned_because"], "needs_attention", status)
            self.assertEqual({item["agent"]: item["status"] for item in result["agents"]}["informes.mensual"], "running")
        # Sin cambios, vuelve al agotar el plazo con el mismo estado.
        run("diario", "completed")
        started = time.monotonic()
        result = check(wait_seconds=1)
        self.assertGreaterEqual(time.monotonic() - started, 1)
        self.assertEqual(result["returned_because"], "wait_elapsed")

        # Un agente que termina en otro proceso despierta la espera por su PID, sin releer SQLite cada tanto; si murió
        # sin guardar su final se da como error, no como en marcha para siempre.
        worker = start_worker(self)
        run("mensual", "completed")
        run("diario", "running", pid=worker.pid, pid_start=zerochat._process_start_token(worker.pid))
        with mock.patch.object(zerochat, "AGENT_WAIT_RECHECK_SECONDS", 60):
            threading.Timer(0.3, worker.terminate).start()
            started = time.monotonic()
            result = check(agent="informes.diario", wait_seconds=30, include_turn=True)
        self.assertLess(time.monotonic() - started, 10)
        self.assertEqual((result["returned_because"], result["status"], result["error"]), ("needs_attention", "error", "The agent's run process ended unexpectedly."))
        self.assertEqual(result["last_turn"][0]["content"], "Empieza")

        # El plazo tiene tope (por debajo del que el runner de Node espera una respuesta) y uno negativo no espera.
        self.assertLess(zerochat.AGENT_MAX_WAIT, 300)
        self.assertNotIn("returned_because", check(wait_seconds=-5))
        self.assertFalse(check(agent="ventas.diario", wait_seconds=1)["success"])

    def test_check_agents_ve_desde_el_lanzamiento_la_conversacion_que_lanzo_launch_agent(self):
        ctx = use_project(self, Path(tempfile.mkdtemp()).resolve())
        self.addCleanup(shutil.rmtree, ctx.workspace_dir, True)
        (ctx.workspace_dir / "agents").mkdir()
        (ctx.workspace_dir / "agents" / "diario.md").write_text(run_md({"agent": "informes.diario", "prompt": "Haz el informe"}))
        zerochat.save_project_environment(ctx.key, {"systemDataPrompt": "Prompt"})
        zerochat.save_conversation({"id": "anterior", "title": "anterior", "updatedAt": 1000, "project": ctx.key, "agent": "informes.diario"},
                                   [{"id": "u", "role": "user", "content": "Empieza"}])
        upsert_run({"run_id": "r_ant", "conversation_id": "anterior", "status": "completed", "result_text": "Viejo"})
        zerochat.RUN_SESSION = zerochat.RunSession("Vigila", conversation_id="master", controller=True)
        check = lambda **args: json.loads(zerochat.check_agents(**args, ctx=ctx))
        alive = {"pid": os.getpid(), "pid_start": zerochat._process_start_token(os.getpid())}

        def fake_launch(request, _cwd):
            # Como launch_run_file: la fila de runs queda en marcha antes de que el agente guarde su conversación.
            upsert_run({"run_id": "r_nuevo", "conversation_id": request["conversation_id"], "status": "running", **alive})
            return {"run_id": "r_nuevo", "pid": os.getpid()}

        with mock.patch.object(zerochat, "launch_run_file", side_effect=fake_launch):
            launched = json.loads(zerochat.launch_agent(run_file="agents/diario.md", ctx=ctx))
        new_id = launched["conversation_id"]
        self.assertIsNone(zerochat.get_conversation(new_id), "El agente aún no la ha guardado")
        # Sin esperar: la conversación existe para check_agents, en marcha, y es la más reciente de su agente.
        self.assertEqual((check(conversation_id=new_id)["status"]), "running")
        self.assertEqual([(item["conversation_id"], item["status"]) for item in check()["agents"]], [(new_id, "running")])
        # La espera no sale al pasar de no existir a en marcha: sigue hasta que termina.
        threading.Timer(0.3, upsert_run, [{"run_id": "r_nuevo", "conversation_id": new_id, "status": "completed", "result_text": "Nuevo"}]).start()
        result = check(conversation_id=new_id, wait_seconds=30)
        self.assertEqual((result["returned_because"], result["status"], result["result_text"]), ("not_running", "completed", "Nuevo"))
        # Cuando el agente la guarda, se lista una sola vez.
        zerochat.save_conversation({"id": new_id, "title": "nueva", "updatedAt": int(time.time() * 1000), "project": ctx.key,
                                    "agent": "informes.diario"}, [{"id": "u", "role": "user", "content": "Haz el informe"}])
        self.assertEqual([item["conversation_id"] for item in check()["agents"]], [new_id])
        self.assertEqual(check(agent="informes.diario")["conversation_id"], new_id)

        # Repartir el trabajo: el mismo agente lanzado tres veces sale tres veces en el listado (y no la anterior, que no
        # lanzó este controlador), y la espera no vuelve hasta que terminan todas.
        ids = []
        for index in range(2):
            def fake_parallel(request, _cwd, index=index):
                upsert_run({"run_id": f"r_par{index}", "conversation_id": request["conversation_id"], "status": "running", **alive})
                return {"run_id": f"r_par{index}", "pid": os.getpid()}
            with mock.patch.object(zerochat, "launch_run_file", side_effect=fake_parallel):
                ids.append(json.loads(zerochat.launch_agent(agent="informes.diario", prompt=f"Parte {index}", ctx=ctx))["conversation_id"])
        self.assertEqual(sorted(item["conversation_id"] for item in check()["agents"]), sorted([new_id, *ids]))
        threading.Timer(0.3, upsert_run, [{"run_id": "r_par0", "conversation_id": ids[0], "status": "completed", "result_text": "Parte 0"}]).start()
        threading.Timer(0.8, upsert_run, [{"run_id": "r_par1", "conversation_id": ids[1], "status": "completed", "result_text": "Parte 1"}]).start()
        started = time.monotonic()
        result = check(wait_seconds=30)
        self.assertGreaterEqual(time.monotonic() - started, 0.7, "Espera también a la segunda")
        # La de antes ya se entregó en el detalle: no se repite, y las dos nuevas llegan enteras.
        self.assertEqual((result["returned_because"], sorted(item.get("result_text", "visto") for item in result["agents"])),
                         ("not_running", ["Parte 0", "Parte 1", "visto"]))
        # Fuera de lo que lanzó, sigue la más reciente de cada agente: otra ejecución (sin este controlador) ve una.
        zerochat.RUN_SESSION = zerochat.RunSession("Otra", conversation_id="otro_controlador", controller=True)
        self.assertEqual(len(check()["agents"]), 1)

    def test_el_controlador_detiene_solo_lo_que_lanzo_y_queda_en_error_con_lo_que_avanzo(self):
        ctx = use_project(self, Path(tempfile.mkdtemp()).resolve())
        self.addCleanup(shutil.rmtree, ctx.workspace_dir, True)
        zerochat.save_project_environment(ctx.key, {"systemDataPrompt": "Prompt"})
        check = lambda **args: json.loads(zerochat.check_agents(**args, ctx=ctx))
        worker = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(100)"], start_new_session=os.name != "nt")
        self.addCleanup(worker.wait)
        self.addCleanup(worker.kill)
        running = {"status": "running", "pid": worker.pid, "pid_start": zerochat._process_start_token(worker.pid)}

        def fake_launch(request, _cwd):
            upsert_run({"run_id": "r_lanzado", "conversation_id": request["conversation_id"], **running})
            return {"run_id": "r_lanzado", "pid": worker.pid}

        zerochat.RUN_SESSION = zerochat.RunSession("Vigila", conversation_id="master", controller=True)
        with mock.patch.object(zerochat, "launch_run_file", side_effect=fake_launch):
            conv_id = json.loads(zerochat.launch_agent(agent="lector", prompt="Lee", ctx=ctx))["conversation_id"]
        zerochat.save_conversation({"id": conv_id, "title": "lector", "project": ctx.key, "agent": "lector"},
                                   [{"id": "u", "role": "user", "content": "Lee"}, {"id": "a", "role": "assistant", "content": "Voy por la mitad."}])
        # Otro agente en marcha del proyecto (de cron, por ejemplo): no es suyo y no lo para.
        zerochat.save_conversation({"id": "de_cron", "title": "cron", "project": ctx.key, "agent": "lector"}, [])
        upsert_run({"run_id": "r_cron", "conversation_id": "de_cron", "status": "running", "pid": os.getpid(),
                    "pid_start": zerochat._process_start_token(os.getpid())})
        for invalid, reason in (({"conversation_id": "de_cron", "stop": True}, "only stops the agents it launched"),
                                ({"stop": True}, "stop goes alone"), ({"agent": "lector", "stop": True}, "stop goes alone"),
                                ({"conversation_id": conv_id, "stop": True, "wait_seconds": 5}, "stop goes alone")):
            self.assertIn(reason, check(**invalid)["error"], invalid)
        self.assertIsNone(worker.poll(), "Nada se ha parado aún")

        stopped = check(conversation_id=conv_id, stop=True)
        self.assertEqual((stopped["stopped"], stopped["status"], stopped["error"], stopped["result_text"], stopped["partial"]),
                         (True, "error", "Stopped by its controller.", "Voy por la mitad.", True))
        self.assertIsNotNone(worker.wait(timeout=10), "Su proceso ha terminado")
        self.assertEqual(zerochat.get_run_state(conv_id)["status"], "error")
        self.assertEqual(zerochat.get_run_state("de_cron")["status"], "running")
        self.assertIn("is not running (status: error)", check(conversation_id=conv_id, stop=True)["error"])

        # Si el trabajador actualiza usage/warnings o cierra completed durante el plazo de gracia, no se pisa.
        for race_patch, expected in (
            ({"usage": {"model_calls": 3, "prompt_tokens": 10, "completion_tokens": 5, "cached_tokens": 0, "reasoning_tokens": 0, "estimated": False}},
             (True, "error", None, {"model_calls": 3, "prompt_tokens": 10, "completion_tokens": 5, "cached_tokens": 0, "reasoning_tokens": 0, "estimated": False})),
            ({"status": "completed", "result_text": "Terminado justo a tiempo", "error": None},
             (False, "completed", "Terminado justo a tiempo", None)),
        ):
            race_id = f"race_{expected[1]}"
            zerochat.save_conversation({"id": race_id, "title": race_id, "project": ctx.key, "agent": "lector"}, [])
            base = {"run_id": f"r_{race_id}", "conversation_id": race_id, "status": "running",
                    "pid": os.getpid(), "pid_start": zerochat._process_start_token(os.getpid())}
            upsert_run(base)
            zerochat.RUN_SESSION.launched_agents[race_id] = {"agent": "lector", "project": ctx.key, "updatedAt": 1000}
            with mock.patch.object(zerochat, "_kill_process_tree", side_effect=lambda *_, **__: upsert_run({**base, **race_patch})):
                res = check(conversation_id=race_id, stop=True)
            self.assertEqual((res["stopped"], res["status"], res["result_text"] if res["status"] == "completed" else None, res.get("usage")), expected)
        zerochat.RUN_SESSION = None

    def test_check_agents_borra_solo_a_peticion_las_conversaciones_antiguas_de_los_agentes_vigilados(self):
        ctx = use_project(self, Path(tempfile.mkdtemp()))
        self.addCleanup(shutil.rmtree, ctx.workspace_dir, True)
        check = lambda **args: json.loads(zerochat.check_agents(**args, ctx=ctx))

        def conv(conv_id, agent=None, updated_at=1000, project=ctx.key, status=None):
            meta = {"id": conv_id, "title": conv_id, "updatedAt": updated_at, "project": project, **({"agent": agent} if agent else {})}
            zerochat.save_conversation(meta, [{"id": f"{conv_id}_u", "role": "user", "content": "Empieza"}])
            if status:
                alive = {"pid": os.getpid(), "pid_start": zerochat._process_start_token(os.getpid())} if status == "running" else {}
                upsert_run({"run_id": f"r_{conv_id}", "conversation_id": conv_id, "status": status, **alive})

        conv("d1", "informes.diario", 1000, status="completed")
        conv("d2", "informes.diario", 2000, status="needs_input")
        conv("d3", "informes.diario", 3000, status="running")
        conv("d4", "informes.diario", 4000, status="error")
        conv("d5", "informes.diario", 5000, status="completed")
        conv("s1", "informes.semanal", 1000)
        conv("s2", "informes.semanal", 2000)
        conv("ventas", "ventas.diario", 1000)
        conv("humana", None, 1000)
        conv("otro", "informes.diario", 1000, project="/otro/proyecto")
        conv("master", "informes.master", 9000)
        zerochat.RUN_SESSION = zerochat.RunSession("Vigila", conversation_id="master", controller=True)
        existing = lambda: {item["id"] for item in zerochat.list_conversations()}

        for invalid in ({"prune_keep": -1}, {"prune_keep": zerochat.AGENT_PRUNE_KEEP_MAX + 1}, {"prune_keep": True}, {"prune_keep": 1, "wait_seconds": 5},
                        {"prune_keep": 1, "conversation_id": "d1"}, {"prune_keep": 1, "agent": "informes.otro"}):
            self.assertFalse(check(**invalid)["success"], invalid)
        self.assertEqual(len(existing()), 11, "Nada se borra sin prune_keep válido")

        # Con agent: conserva sus N más recientes y nunca borra una en marcha ni una que espera a una persona.
        result = check(agent="informes.diario", prune_keep=1)
        self.assertEqual([item["conversation_id"] for item in result["deleted"]], ["d4", "d1"])
        self.assertEqual([(item["conversation_id"], item["status"]) for item in result["skipped"]], [("d3", "running"), ("d2", "needs_input")])
        self.assertEqual(existing(), {"d2", "d3", "d5", "s1", "s2", "ventas", "humana", "otro", "master"})
        self.assertIsNone(zerochat.get_run_state("d4"), "Con la conversación se va su fila de runs")
        self.assertEqual(zerochat.get_run_state("d3")["status"], "running")

        # Sin agent, cada agente del proyecto; 0 no conserva ninguna. Humanas, otros proyectos y el controlador quedan.
        result = check(prune_keep=0)
        self.assertEqual(sorted(item["conversation_id"] for item in result["deleted"]), ["d5", "s1", "s2", "ventas"])
        self.assertEqual(existing(), {"d2", "d3", "humana", "otro", "master"})

    def test_launch_agent_lanza_separado_un_agente_de_este_u_otro_proyecto_con_permiso_y_nunca_otro_controlador(self):
        ctx = use_project(self, Path(tempfile.mkdtemp()).resolve())
        other = Path(tempfile.mkdtemp()).resolve()
        for folder in (ctx.workspace_dir, other):
            self.addCleanup(shutil.rmtree, folder, True)
            (folder / "agents").mkdir()
            (folder / "agents" / "diario.md").write_text(run_md({"agent": "informes.diario", "prompt": "Haz el informe"}))
        (ctx.workspace_dir / "agents" / "jefe.md").write_text(run_md({"agent": "jefe", "controller": True, "prompt": "Coordina"}))
        (ctx.workspace_dir / "agents" / "anonimo.md").write_text(run_md({"prompt": "Sin agente"}))
        (ctx.workspace_dir / "agents" / "jefe_fijo.md").write_text(run_md({"agent": "jefe", "conversation_id": "jefe_fija", "prompt": "Sigue"}))
        zerochat.save_conversation({"id": "jefe_fija", "title": "jefe", "project": ctx.key, "agent": "jefe",
                                    "launch": {"profile": "local", "controller": True}}, [{"id": "u", "role": "user", "content": "Coordina"}])
        (ctx.workspace_dir / "agents" / "fijo.md").write_text(run_md({"agent": "informes.diario", "conversation_id": "fija", "prompt": "Sigue"}))
        names = lambda: [tool["name"] for tool in zerochat._local_tools()]
        launch = lambda **args: json.loads(zerochat.launch_agent(**args, ctx=ctx))
        check = lambda **args: json.loads(zerochat.check_agents(**args, ctx=ctx))
        launched = []
        fake_launch = lambda request, cwd: launched.append((dict(request), cwd)) or {"run_id": f"run_{len(launched)}", "pid": 1}

        # Solo en una ejecución con controller: true, que la publica y autoriza junto a check_agents.
        zerochat.RUN_SESSION = zerochat.RunSession("Hola")
        self.assertNotIn("launch_agent", names())
        self.assertFalse(launch(run_file="agents/diario.md")["success"])
        zerochat.RUN_SESSION = zerochat.RunSession("Vigila", conversation_id="master", controller=True)
        self.assertIn("launch_agent", names())
        zerochat.reset_session_authorizations()
        self.assertEqual(zerochat.ACCESS_CONTROLLER.evaluate_authorization("launch_agent", {}, context=ctx).status, zerochat.POLICY_ALLOW)
        self.assertIsNone(zerochat.validate_local_tool_arguments("launch_agent", {"run_file": "agents/diario.md", "project": str(other)}))
        self.assertIsNotNone(zerochat.validate_local_tool_arguments("launch_agent", {"max_steps": "5"}))
        self.assertIsNotNone(zerochat.validate_local_tool_arguments("launch_agent", {"controller": True}), "En línea no hay controller")

        with mock.patch.object(zerochat, "launch_run_file", side_effect=fake_launch):
            # Sin entorno guardado no lanza (el hijo saldría con código 3).
            self.assertIn("no saved environment", launch(run_file="agents/diario.md")["error"])
            zerochat.save_project_environment(ctx.key, {"systemDataPrompt": "Prompt"})
            for invalid, reason in (({"run_file": " "}, "run_file must be"), ({"run_file": "../fuera.md"}, "inside the project"),
                                    ({"run_file": "agents/nada.md"}, "Could not read"), ({"run_file": "agents/anonimo.md"}, "must set an agent"),
                                    # Sin anidamiento: ni el run-file ni la conversación de otro controlador.
                                    ({"run_file": "agents/jefe.md"}, "not controllers"), ({"run_file": "agents/jefe_fijo.md"}, "not controllers"),
                                    ({"run_file": "agents/diario.md", "prompt": " "}, "non-empty")):
                self.assertIn(reason, launch(**invalid)["error"], invalid)
            self.assertEqual(launched, [])

            # Una conversación nueva por lanzamiento, con el prompt pedido, en la carpeta del proyecto.
            result = launch(run_file="agents/diario.md", prompt="Informe de marzo")
            self.assertEqual((result["agent"], result["new"], result["run_id"], result["project"]), ("informes.diario", True, "run_1", ctx.key))
            self.assertEqual(result["runs"], {"running": zerochat.running_run_count(), "max": zerochat.MAX_CONCURRENT_RUNS})
            self.assertTrue(result["conversation_id"].startswith("session_"))
            self.assertEqual(launched[0], ({"agent": "informes.diario", "prompt": "Informe de marzo", "projectMode": False, "reasoning": "medium",
                                            "conversation_id": result["conversation_id"]},
                                           ctx.workspace_dir))
            # En línea, sin fichero: la misma petición que daría su run-file, con sus mismas comprobaciones.
            result = launch(agent="informes.linea", system_prompt="Eres el agente en línea.", prompt=" Resume ", max_steps=5, reasoning="low",
                            disabled_tools="imap, run_command")
            self.assertEqual(launched[-1], ({"agent": "informes.linea", "systemDataPrompt": "Eres el agente en línea.", "prompt": "Resume",
                                             "maxSteps": 5, "projectMode": False, "reasoning": "low", "disabledTools": ["imap", "run_command"],
                                             "conversation_id": result["conversation_id"]},
                                            ctx.workspace_dir))
            for invalid, reason in (({}, "agent and prompt"), ({"agent": "informes.linea"}, "agent and prompt"),
                                    ({"run_file": "agents/diario.md", "agent": "informes.diario"}, "not both"),
                                    ({"agent": "a.b.c", "prompt": "x"}, "agent debe ser"), ({"agent": "x", "prompt": "x", "reasoning": "max"}, "reasoning debe ser"),
                                    ({"agent": "x", "prompt": "x", "max_steps": 0}, "maxSteps debe ser"),
                                    ({"agent": "x", "prompt": "x", "profile": "a\nb"}, "saltos de línea"),
                                    ({"agent": "x", "prompt": "x", "system_prompt": "a\n<!-- prompt -->\nb"}, "marcador"),
                                    ({"agent": "jefe", "prompt": "x", "conversation_id": "jefe_fija"}, "not controllers")):
                self.assertIn(reason, launch(**invalid)["error"], invalid)
            self.assertEqual(len(launched), 2)

            # Un conversation_id fijo en marcha no se lanza otra vez.
            upsert_run({"run_id": "r_fija", "conversation_id": "fija", "status": "running", "pid": os.getpid(),
                        "pid_start": zerochat._process_start_token(os.getpid())})
            self.assertIn("already running", launch(run_file="agents/fijo.md")["error"])

            # Otro proyecto: consultar pide R sobre su carpeta, lanzar RX (RW para borrar) y su propio entorno guardado.
            self.assertIn("do not give R access", check(project=str(other))["error"])
            default_rule = zerochat.AccessController.get_default_directory_rule(ctx)
            zerochat.ACCESS_CONTROLLER.import_state({"directoryRules": [default_rule, f"R:{other}/**"]}, ctx)
            self.assertIn("do not give X access", launch(run_file="agents/diario.md", project=str(other))["error"])
            zerochat.ACCESS_CONTROLLER.import_state({"directoryRules": [default_rule, f"X:{other}/**"]}, ctx)
            self.assertIn("do not give R access", launch(run_file="agents/diario.md", project=str(other))["error"])
            # En línea no se lee ningún fichero: basta X, y lo que falta es el entorno guardado de esa carpeta.
            self.assertIn("no saved environment", launch(agent="informes.diario", prompt="Hola", project=str(other))["error"])
            zerochat.ACCESS_CONTROLLER.import_state({"directoryRules": [default_rule, f"RX:{other}/**"]}, ctx)
            self.assertIn("no saved environment", launch(run_file="agents/diario.md", project=str(other))["error"])
            other_key = zerochat.SecurityContext(workspace_dir=other).key
            zerochat.save_project_environment(other_key, {"systemDataPrompt": "Otro"})
            result = launch(run_file="agents/diario.md", project=str(other))
            self.assertEqual((result.get("project"), launched[-1][1], launched[-1][0]["prompt"]), (other_key, other, "Haz el informe"), result)

        # check_agents con project ve los agentes de esa carpeta y no los de la suya; borrar en ella pide RW.
        zerochat.save_conversation({"id": "suya", "title": "suya", "updatedAt": 1000, "project": other_key, "agent": "informes.diario"},
                                   [{"id": "u", "role": "user", "content": "Empieza"}])
        zerochat.save_conversation({"id": "mia", "title": "mia", "updatedAt": 1000, "project": ctx.key, "agent": "informes.diario"},
                                   [{"id": "u", "role": "user", "content": "Empieza"}])
        # El listado de cada proyecto da la más reciente del agente: la que este controlador acaba de lanzar en él.
        self.assertEqual([item["conversation_id"] for item in check(project=str(other))["agents"]], [result["conversation_id"]])
        self.assertEqual((check(project=str(other), conversation_id="suya")["success"], check(conversation_id="suya")["success"]), (True, False))
        self.assertEqual((check(conversation_id="mia")["success"], check(project=str(other), conversation_id="mia")["success"]), (True, False))
        self.assertIn("do not give RW access", check(project=str(other), prune_keep=0)["error"])
        self.assertIn("does not exist", check(project=str(other / "nada"))["error"])

    def test_launch_run_file_arranca_un_proceso_separado_con_su_run_id_y_la_peticion_por_stdin(self):
        ctx = use_project(self, Path(tempfile.mkdtemp()).resolve())
        self.addCleanup(shutil.rmtree, ctx.workspace_dir, True)
        received = ctx.workspace_dir / "recibido.json"
        real_popen = subprocess.Popen
        seen = {}

        def fake_popen(cmd, **kwargs):
            if "--run-file" not in cmd:
                return real_popen(cmd, **kwargs)  # Otros procesos (p. ej. ps en macOS para la huella de arranque).
            seen.update(cmd=cmd, **kwargs)
            # Hace de zerochat --run-file -: guarda lo que recibe por stdin, su carpeta y su entorno; la prueba espera a que termine.
            script = (f"import json, os, sys; f = open({str(received)!r}, 'w'); json.dump({{'request': sys.stdin.read(), "
                      "'cwd': os.getcwd(), 'run_id': os.environ.get('ZEROCHAT_RUN_ID'), "
                      "'security': os.environ.get('ZEROCHAT_RUN_SECURITY')}, f); f.close()")
            seen["proc"] = real_popen([sys.executable, "-c", script], **kwargs)
            return seen["proc"]

        request = {"agent": "informes.diario", "prompt": "Hola", "conversation_id": "session_lanzada"}
        with mock.patch.object(zerochat.subprocess, "Popen", side_effect=fake_popen), \
                mock.patch.object(zerochat, "find_node_executable", return_value="node"), \
                mock.patch.dict(os.environ, {"ZEROCHAT_RUN_SECURITY": "{}", "ZEROCHAT_RUN_ID": "run_del_master"}):
            launched = zerochat.launch_run_file(request, ctx.workspace_dir)
        self.assertEqual(seen["cmd"][-2:], ["--run-file", "-"])
        self.assertEqual(seen["start_new_session"], os.name != "nt", "Sigue aunque termine el master")
        row = zerochat.get_run_state("session_lanzada")
        self.assertEqual((row["status"], row["run_id"], row["pid"]), ("running", launched["run_id"], launched["pid"]))
        self.assertEqual(seen["proc"].wait(timeout=10), 0)
        got = json.loads(received.read_text())
        # Le llega el run-file Markdown de la petición, que lee con --run-file - como cualquier otro.
        self.assertEqual(got, {"request": zerochat.format_run_request(request), "cwd": str(ctx.workspace_dir), "run_id": launched["run_id"], "security": None})
        self.assertEqual(zerochat.parse_run_request(got["request"].encode()), {**request, "projectMode": False, "reasoning": "medium"})
        # Otra vez la misma conversación en marcha: no se lanza.
        upsert_run({**row, "pid": os.getpid(), "pid_start": zerochat._process_start_token(os.getpid())})
        with self.assertRaisesRegex(ValueError, "en marcha"):
            zerochat.launch_run_file(request, ctx.workspace_dir)

    def test_los_finales_recordados_se_acotan_en_max_exited_runs_olvidando_los_mas_antiguos(self):
        saved = dict(zerochat._EXITED)
        self.addCleanup(lambda: (zerochat._EXITED.clear(), zerochat._EXITED.update(saved)))
        zerochat._EXITED.clear()
        limit = zerochat.MAX_EXITED_RUNS
        with zerochat._EXIT_LOCK:
            for pid in range(limit):
                zerochat._remember_exit((pid, "s"))
        self.assertEqual(len(zerochat._EXITED), limit)
        with zerochat._EXIT_LOCK:
            zerochat._remember_exit((limit, "s"))
        self.assertEqual(len(zerochat._EXITED), limit)
        self.assertNotIn((0, "s"), zerochat._EXITED)
        self.assertIn((limit, "s"), zerochat._EXITED)

    def test_una_ejecucion_que_falla_antes_de_lanzar_el_runner_no_deja_fila_en_runs(self):
        folder = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, folder, True)
        run_file = folder / "agente.md"
        run_file.write_text(run_md({"agent": "informes.diario", "conversation_id": "session_sin_entorno", "prompt": "Hola", "profile": "remoto"}))
        # Una conversación nueva en la carpeta general, que no tiene entorno guardado: sale con código 3 sin dejar fila.
        with mock.patch.object(sys, "argv", ["zerochat", "--run-file", str(run_file)]), mock.patch("sys.stderr", io.StringIO()) as stderr, \
                mock.patch.dict(os.environ, {"ZEROCHAT_RUN_ID": ""}), self.assertRaises(SystemExit) as cm:
            zerochat.main()
        self.assertEqual(cm.exception.code, zerochat.RUN_EXIT_SETUP)
        self.assertIn("no tiene entorno guardado", stderr.getvalue())
        self.assertIsNone(zerochat.get_run_state("session_sin_entorno"))

        # Solo borra la suya: la fila de otra ejecución de la conversación se conserva, y una con runner lanzado también.
        session = zerochat.RunSession("Hola", new_conversation_id="session_otra", track_run=True)
        upsert_run({"run_id": "de_otra", "conversation_id": "session_otra", "status": "completed"})
        zerochat.discard_unstarted_run(session)
        self.assertEqual(zerochat.get_run_state("session_otra")["run_id"], "de_otra")
        started = zerochat.RunSession("Hola", new_conversation_id="session_lanzada", track_run=True)
        started.runner_started = True
        zerochat.discard_unstarted_run(started)
        self.assertEqual(zerochat.get_run_state("session_lanzada")["run_id"], started.run_id)
        zerochat.discard_unstarted_run(None)

    def test_list_server_runs_limpia_las_filas_terminadas_sin_conversacion_y_conserva_las_en_marcha(self):
        zerochat.save_conversation({"id": "con_conv", "title": "c", "updatedAt": 1}, [{"id": "u", "role": "user", "content": "Hola"}])
        alive = {"pid": os.getpid(), "pid_start": zerochat._process_start_token(os.getpid())}
        worker = start_worker(self)
        dead = {"pid": worker.pid, "pid_start": zerochat._process_start_token(worker.pid)}
        worker.kill()
        worker.wait()
        upsert_run({"run_id": "r1", "conversation_id": "terminada_sin_conv", "status": "completed"})
        upsert_run({"run_id": "r2", "conversation_id": "error_sin_conv", "status": "error", "error": "x"})
        upsert_run({"run_id": "r3", "conversation_id": "muerta_sin_conv", "status": "running", **dead})
        upsert_run({"run_id": "r4", "conversation_id": "en_marcha_sin_conv", "status": "running", **alive})
        upsert_run({"run_id": "r5", "conversation_id": "con_conv", "status": "error", "error": "fallo"})

        runs, _ = zerochat.list_server_runs()
        # La que murió sin guardar su conversación pasa a error y se limpia en la misma pasada; la que sigue en marcha
        # aún no la ha guardado y se conserva, como una terminada que sí tiene conversación.
        self.assertEqual(sorted((run["conversation_id"], run["status"]) for run in runs), [("con_conv", "error"), ("en_marcha_sin_conv", "running")])
        self.assertEqual(sorted(row["conversation_id"] for row in zerochat.list_run_states()), ["con_conv", "en_marcha_sin_conv"])

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
            # Lo que preguntaría pausa la ejecución sin aviso de denegación; lo denegado de forma permanente sí lo deja.
            paused, _, _ = zerochat.authorize_or_challenge("local", "run_command", {"command": "rm -rf /"}, ctx)
            self.assertTrue(paused["awaitingApproval"])
            self.assertEqual(session.warnings, [])
            zerochat.ACCESS_CONTROLLER.import_state({"tools": {"write_file": {"policy": zerochat.POLICY_DENY}}}, ctx)
            result, _, message = zerochat.authorize_or_challenge("local", "write_file", {"path": "x", "content": "y"}, ctx)
            self.assertEqual(result["securityStatus"], "deny")
            self.assertIn("Permiso denegado: write_file", stderr.getvalue())
            # Tope en el borde exacto: RUN_WARNINGS_MAX avisos se guardan, cada uno recortado en RUN_PROGRESS_TEXT_MAX, y del siguiente solo se cuenta.
            session.add_warning("a" * zerochat.RUN_PROGRESS_TEXT_MAX)
            session.add_warning("b" * (zerochat.RUN_PROGRESS_TEXT_MAX + 1))
            for index in range(3, zerochat.RUN_WARNINGS_MAX):
                session.add_warning(f"aviso {index}")
            self.assertEqual(len(zerochat.get_run_state("session_avisos")["warnings"]), zerochat.RUN_WARNINGS_MAX)
            session.add_warning("uno de más")
        warnings = zerochat.get_run_state("session_avisos")["warnings"]
        self.assertEqual(len(warnings), zerochat.RUN_WARNINGS_MAX + 1)
        self.assertTrue(warnings[0].startswith("write_file: ") and message.endswith(warnings[0].removeprefix("write_file: ")))
        self.assertEqual(warnings[1], "a" * zerochat.RUN_PROGRESS_TEXT_MAX)
        self.assertEqual(warnings[2], ("b" * zerochat.RUN_PROGRESS_TEXT_MAX) + "…")
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

        # Una señal o el latido detienen el servidor: el runner no sigue llamando al modelo por su cuenta.
        stopping = threading.Event()
        stopping.set()
        runner = mock.Mock()
        with mock.patch.object(zerochat, "_SERVER_SHUTTING_DOWN", stopping), mock.patch.object(zerochat, "stop_zerochat_server"), \
                mock.patch.object(zerochat, "_kill_process_tree") as kill:
            zerochat.run_supervisor(mock.Mock(), zerochat.RunSession(conversation_id=conv_id), runner_proc=runner)
        kill.assert_called_once_with(runner, grace_seconds=1.0)

    def test_los_limites_de_pasos_y_tiempo_terminan_con_estado_limit_y_codigo_6(self):
        # El runner solo puede declarar el límite de pasos, y solo en una ejecución que lo tiene.
        sin_tope = zerochat.RunSession("Hola", new_conversation_id="session_sin_tope")
        zerochat.RUN_SESSION = sin_tope
        _, err, _ = dispatch_run("zerochat/run/result", {"run_id": sin_tope.run_id, "limit": "steps"})
        self.assertEqual(err["code"], zerochat.INVALID_PARAMS)
        session = zerochat.RunSession("Hola", new_conversation_id="session_pasos", max_steps=20)
        zerochat.RUN_SESSION = session
        delivered = dispatch_run("zerochat/run/prompt", {"run_id": session.run_id})[0]
        self.assertEqual((delivered["max_steps"], delivered["project_mode"]), (20, None))
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
        # conv_1 sigue en marcha: su fila se conserva aunque su agente aún no haya guardado la conversación.
        save_conv("conv_2", "conv_dead", "conv_ok")
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
        self.assertIsNotNone(disk_dead["finished_at"])
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

    def test_disabled_tools_solo_quita_del_entorno_del_proyecto_y_un_aviso_del_runner_va_a_los_avisos(self):
        use_data_dir(self)
        env = {"systemDataPrompt": "Del proyecto", "mcpServers": ["imap", "calendario"], "browser": "playwright",
               "enabledTools": {"run_command": True, "search_web": False}, "activeRagBranchIds": []}
        zerochat.RUN_SESSION = None
        self.assertIs(zerochat.run_project_environment(env), env, "Fuera de una ejecución, el guardado tal cual")
        zerochat.RUN_SESSION = zerochat.RunSession("Hola", disabled_tools=("imap", "playwright", "run_command", "gmail"))
        self.assertEqual(zerochat.run_project_environment(env), {
            "systemDataPrompt": "Del proyecto", "mcpServers": ["calendario"], "browser": "none", "activeRagBranchIds": [],
            "enabledTools": {"run_command": False, "search_web": False, "imap": False, "playwright": False, "gmail": False}})
        self.assertEqual(env["mcpServers"], ["imap", "calendario"], "No cambia el guardado")
        # Solo resta: lo que el proyecto no tiene no aparece, y el navegador de otro tipo se queda.
        zerochat.RUN_SESSION = zerochat.RunSession("Hola", disabled_tools=("browser_action",), system_data_prompt="Manual")
        self.assertEqual(zerochat.run_project_environment(env)["browser"], "playwright")
        self.assertEqual(zerochat.run_project_environment(env)["systemDataPrompt"], "Manual")

        with mock.patch("sys.stderr", io.StringIO()) as stderr:
            self.assertEqual(zerochat._rpc_progress({"kind": "warning", "text": "disabledTools: imp"}, zerochat.RUN_SESSION), ({"ok": True}, None, ""))
        self.assertEqual(zerochat.RUN_SESSION.warnings, ["disabledTools: imp"])
        self.assertIn("[run] Aviso: disabledTools: imp", stderr.getvalue())
        self.assertEqual(zerochat.RUN_SESSION.step_text, "", "Un aviso no es el paso en curso")
        zerochat.RUN_SESSION = None

    def test_como_mucho_max_concurrent_runs_ejecuciones_vivas_a_la_vez(self):
        """N-1 vivas dejan lanzar, N no (ni desde la interfaz ni desde un agente); las muertas y las terminadas no cuentan."""
        zerochat.save_general_profile({"name": "valid-profile", "settings": {}})
        zerochat.save_conversation({"id": "conv_nueva", "title": "N"}, [])
        start_token = zerochat._process_start_token(os.getpid())
        alive = {"status": "running", "pid": os.getpid(), "pid_start": start_token}
        for i in range(zerochat.MAX_CONCURRENT_RUNS - 1):
            upsert_run({"run_id": f"r{i}", "conversation_id": f"viva{i}", **alive})
        upsert_run({"run_id": "r_muerta", "conversation_id": "muerta", "status": "running", "pid": 2**22 + 12345})
        upsert_run({"run_id": "r_hecha", "conversation_id": "hecha", "status": "completed"})
        zerochat.check_run_capacity()
        upsert_run({"run_id": "r_ultima", "conversation_id": "ultima", **alive})
        full = f"Too many runs in progress \\({zerochat.MAX_CONCURRENT_RUNS} at a time"
        with self.assertRaisesRegex(ValueError, full):
            zerochat.check_run_capacity()
        # Popen falso para todo subprocess: la huella de arranque, que fuera de Linux usa ps, se toma antes.
        with mock.patch.object(zerochat, "_process_start_token", return_value=start_token), mock.patch("subprocess.Popen") as popen:
            with self.assertRaisesRegex(ValueError, full):
                zerochat.start_server_run({"conversation_id": "conv_nueva", "profile": "valid-profile"})
            with self.assertRaisesRegex(ValueError, full):
                zerochat.launch_run_file({"conversation_id": "conv_nueva", "prompt": "Hola"}, Path(tempfile.gettempdir()))
            popen.assert_not_called()

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

        def renews(method, sent_token, status):
            # Un valor que ninguna lectura de time.monotonic() puede dar: renovar es dejar de tenerlo, sin esperar a que avance el reloj.
            zerochat.HEARTBEAT_LAST_SEEN = float("-inf")
            self.assertEqual(post_rpc(method, sent_token), status)
            self.assertNotEqual(zerochat.HEARTBEAT_LAST_SEEN, float("-inf"), (method, sent_token))

        renews("zerochat/heartbeat", token, 200)
        self.assertTrue(zerochat.HEARTBEAT_INITIALIZED)
        # Un token caducado o erróneo (401) también es presencia: el auto-cierre no salta al cambiar el día.
        renews("zerochat/heartbeat", "token-caducado", 401)
        # Cualquier otra RPC autenticada renueva la presencia sin zerochat/heartbeat.
        renews("tools/list", token, 200)

        # Con la última presencia ya más antigua que el plazo, el vigilante detiene el servidor sin esperar nada.
        server = mock.Mock()
        zerochat.HEARTBEAT_LAST_SEEN = time.monotonic() - zerochat.DEFAULT_HEARTBEAT_TIMEOUT - 1
        waiting = waiting_on(self, zerochat._WATCHDOG_COND)
        with mock.patch.object(zerochat, "stop_zerochat_server") as stop:
            zerochat.heartbeat_watchdog(server)
        stop.assert_called_once_with(server)
        self.assertEqual(waiting.timeouts, [], "Decide sin esperar en la condición")

    def test_el_token_del_runner_solo_actua_en_el_proyecto_de_su_ejecucion(self):
        own = zerochat.project_context()
        other = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, other, True)
        runner_token = zerochat.issue_runner_token("run-pin", "conv-pin", own.key)
        self.addCleanup(zerochat.revoke_token, runner_token)
        self.assertEqual(post_rpc("tools/list", runner_token), 200)
        self.assertEqual(post_rpc("tools/list", runner_token, project=own.workspace_dir), 200)
        self.assertEqual(post_rpc("tools/list", runner_token, project=other), 403)

    def test_el_user_agent_real_solo_lo_fija_un_navegador_autenticado_y_nunca_el_runner(self):
        token = "ua-test-token"
        today = zerochat.datetime.date.today().isoformat()
        default = zerochat.DEFAULT_USER_AGENT
        patches = mock.patch.multiple(zerochat, SESSION_TOKEN=token, SESSION_TOKEN_DATE=today, ACTIVE_USER_AGENT=default,
                                      SERVICE_USER_AGENT=default, _FRONTEND_USER_AGENT_CAPTURED=False,
                                      _STORED_USER_AGENT=None, _STORED_USER_AGENT_LOADED=False)
        patches.start()
        self.addCleanup(patches.stop)
        runner_token = zerochat.issue_runner_token("run-ua", "conv-ua", zerochat.project_context().key)
        self.addCleanup(zerochat.revoke_token, runner_token)

        # El fetch del runner de Node manda "node" y un token sin validar no es un navegador: ninguno lo fija.
        self.assertEqual(post_rpc("tools/list", runner_token, user_agent="node"), 200)
        self.assertEqual(post_rpc("tools/list", "token-erroneo", user_agent="Intruso/1.0"), 401)
        self.assertIs(zerochat.ACTIVE_USER_AGENT, default)
        self.assertEqual(zerochat.SERVICE_USER_AGENT, default)
        self.assertIsNone(zerochat.load_last_frontend_user_agent())

        self.assertEqual(post_rpc("tools/list", token, user_agent="Mozilla/5.0 (X11) Navegador/1.0"), 200)
        self.assertEqual(zerochat.SERVICE_USER_AGENT, "Mozilla/5.0 (X11) Navegador/1.0")
        self.assertEqual(zerochat.load_last_frontend_user_agent(), "Mozilla/5.0 (X11) Navegador/1.0")

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
        self.assertFalse(zerochat.run_process_alive({"pid": worker.pid, "pid_start": start}))

    def test_el_latido_en_espera_despierta_al_terminar_una_ejecucion_y_solo_relee_con_su_conversacion_a_la_vista(self):
        ctx = zerochat.SecurityContext(workspace_dir=self.data_dir)
        waiting = waiting_on(self, zerochat._LIVE_STATE_COND)
        save_conv("conv_vista")
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
        save_conv("conv_lp")
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
        zerochat.save_conversation({"id": "conv_del_4", "title": "Agente", "project": "/repo/c", "agent": "informes.diario"}, [])

        zerochat.dispatch_conversations("zerochat/conversations/delete", {"id": "conv_del_1"})
        self.assertIsNone(zerochat.get_run_state("conv_del_1"))
        self.assertIsNotNone(zerochat.get_run_state("conv_del_2"))

        # Por proyecto: solo sus chats y sus ejecuciones; sus conversaciones de agentes siguen.
        result, error, _ = zerochat.dispatch_conversations("zerochat/conversations/delete", {"project": "/repo/c", "agents": False})
        self.assertIsNone(error)
        self.assertEqual(result["count"], 1)
        self.assertIsNotNone(zerochat.get_run_state("conv_del_2"))
        self.assertEqual(sorted(c["id"] for c in zerochat.list_conversations()), ["conv_del_2", "conv_del_4"])
        _, error, _ = zerochat.dispatch_conversations("zerochat/conversations/delete", {"project": "  ", "agents": False})
        self.assertEqual(error["code"], -32602)

        # Todos los agentes no tocan los chats ni sus ejecuciones; todos los chats, sí.
        result, _, _ = zerochat.dispatch_conversations("zerochat/conversations/delete", {"all": True, "agents": True})
        self.assertEqual(result["count"], 1)
        self.assertIsNotNone(zerochat.get_run_state("conv_del_2"))
        zerochat.dispatch_conversations("zerochat/conversations/delete", {"all": True, "agents": False})
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
                zerochat.finish_run(answer)
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
                zerochat.finish_run(io.StringIO())
        marked = zerochat.get_conversation("session_nueva_orquestada")
        self.assertEqual((marked.get("serverRun"), marked.get("profileId")), (True, "oficina"))
        # Una nueva con id del servidor no la sigue nadie: queda como la dejó la interfaz.
        self.assertNotIn("serverRun", zerochat.get_conversation(from_server.new_conversation_id))
