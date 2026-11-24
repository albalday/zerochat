import json
import os
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from backend import use_data_dir, use_project, zerochat


def use_fresh_jobs(test):
    """Da a la prueba su propio registro de comandos, que se detiene y se borra al terminar."""
    jobs = zerochat.JobManager()
    patcher = patch.object(zerochat, "JOBS", jobs)
    patcher.start()
    test.addCleanup(patcher.stop)
    test.addCleanup(jobs.shutdown)


def wait_dead(pid):
    if not zerochat.wait_pid_exit(pid, 5):
        raise AssertionError(f"El proceso {pid} sigue vivo")


def run(command, **kwargs):
    return json.loads(zerochat.run_command(command, **kwargs, ctx=zerochat.project_context()))


def check(job_id, **kwargs):
    return json.loads(zerochat.check_command(job_id, **kwargs, ctx=zerochat.project_context()))


@unittest.skipIf(os.name == "nt", "Comandos POSIX")
class RunCommandTest(unittest.TestCase):
    def setUp(self):
        self.data_dir = use_data_dir(self)
        self.project = (self.data_dir / "project").resolve()
        (self.project / "src").mkdir(parents=True)
        use_project(self, self.project)
        use_fresh_jobs(self)

    def test_la_salida_une_stdout_y_stderr_y_nada_pasa_de_una_llamada_a_otra(self):
        result = run("echo uno; echo dos >&2; echo tres; exit 3")
        self.assertEqual((result["success"], result["status"], result["exit_code"]), (False, "exited", 3))
        self.assertEqual(result["output"], "uno\ndos\ntres\n")
        self.assertIsInstance(result["job_id"], int)
        self.assertNotIn("cwd", result)

        # Ni el directorio ni las variables pasan a la llamada siguiente.
        self.assertEqual(run("cd src && export ZC_TEST_VAR=1 && pwd")["output"].strip(), str(self.project / "src"))
        self.assertEqual(run('pwd; echo "var=$ZC_TEST_VAR"')["output"], f"{self.project}\nvar=\n")
        for bad in ("", "   "):
            self.assertIs(run(bad)["success"], False)

    def test_el_proyecto_de_la_peticion_es_la_raiz_de_rutas_relativas_y_comandos(self):
        dev_root = zerochat.get_dev_root()
        process_cwd = Path.cwd()
        (self.project / "note.txt").write_text("hola", encoding="utf-8")
        ctx = zerochat.SecurityContext(self.project)
        for bad in ("", "   ", None, 7, "x" * 5000, str(self.project / "missing"), str(self.project / "note.txt")):
            with self.subTest(path=bad):
                with self.assertRaises(ValueError):
                    zerochat.resolve_project_directory(bad, ctx)

        self.assertEqual(zerochat.resolve_project_directory(str(self.project), ctx), {"cwd": str(self.project)})
        self.assertTrue(json.loads(zerochat.read_file("note.txt", ctx=ctx))["content"].startswith("hola"))
        self.assertEqual(run("pwd")["output"].strip(), str(self.project))

        # cd solo vale dentro del comando: el proyecto (y las rutas relativas) siguen en la raíz.
        self.assertEqual(run("cd src && pwd")["output"].strip(), str(self.project / "src"))
        self.assertEqual(run("cd src; pwd")["output"].strip(), str(self.project / "src"))

        # Una ruta relativa se resuelve contra el proyecto de la petición; el servidor no la guarda.
        src = zerochat.resolve_project_directory("src", ctx)["cwd"]
        self.assertEqual(src, str(self.project / "src"))
        self.assertEqual(zerochat.PROJECT_DIR, self.project)
        src_ctx = zerochat.SecurityContext(Path(src))
        self.assertEqual(json.loads(zerochat.run_command("pwd", ctx=src_ctx))["output"].strip(), src)
        self.assertEqual(run("pwd")["output"].strip(), str(self.project))
        # El proceso nunca cambia de directorio: el proyecto viaja en el contexto.
        self.assertEqual(Path.cwd(), process_cwd)
        self.assertEqual(zerochat.get_dev_root(), dev_root)
        self.assertNotIn("resolve_project_directory", zerochat.LOCAL_TOOL_HANDLERS)

    def test_un_comando_que_agota_su_plazo_pasa_a_segundo_plano_y_detenerlo_mata_a_sus_descendientes(self):
        pid_file = self.data_dir / "descendiente.pid"
        started = time.monotonic()
        result = run(f"sh -c 'echo $$ > {pid_file}; exec sleep 100' & echo antes; sleep 100", timeout_seconds=1)
        self.assertLess(time.monotonic() - started, 6)
        self.assertEqual((result["success"], result["status"], result["output"]), (True, "running", "antes\n"))
        self.assertIn("moved to the background", result["note"])
        self.assertIn(f"check_command(job_id={result['job_id']}", result["note"])
        job = zerochat.JOBS.get(str(self.project), job_id=result["job_id"])
        self.assertEqual((job.background, job.done.is_set()), (True, False))
        self.assertIn(result["job_id"], [item["id"] for item in zerochat.live_state(zerochat.project_context())["jobs"] if item["background"]])
        stopped = check(result["job_id"], stop=True)
        self.assertEqual((stopped["status"], stopped["stopped_by"]), ("stopped", "model"))
        wait_dead(int(pid_file.read_text().strip()))

        # Lo que deja en marcha un comando que ya ha terminado no sobrevive como huérfano.
        leftover = self.data_dir / "leftover.fifo"
        os.mkfifo(leftover)
        result = run(f"(sh -c 'echo $$ > {leftover}; exec sleep 100' &); read pid < {leftover}; echo fin $pid")
        self.assertEqual(result["status"], "exited")
        self.assertRegex(result["output"], r"^fin \d+\n$")
        wait_dead(int(result["output"].split()[1]))

    def test_la_salida_larga_se_trunca_y_el_log_conserva_comienzo_y_final(self):
        result = run("python3 -c \"print('x' * 5000000)\"", timeout_seconds=30)
        self.assertIs(result["success"], True)
        self.assertIs(result["truncated"], True)
        self.assertLess(len(result["output"]), 20000)
        log_file = Path(result["log_file"])
        self.assertEqual(log_file.stat().st_size, 5000001)

        # Un log que supera el tope conserva comienzo y final, con una marca en medio.
        with patch.object(zerochat, "JOB_LOG_HEAD_BYTES", 1000), patch.object(zerochat, "JOB_LOG_TAIL_BYTES", 1000):
            result = run("seq 1 20000")
        job = zerochat.JOBS.get(str(self.project), job_id=result["job_id"])
        self.assertTrue(result["output"].endswith("20000\n"))
        self.assertIs(result["truncated"], True)
        text, next_offset = job.read_range(0, 10 ** 9)
        self.assertTrue(text.startswith("1\n2\n") and text.endswith("19999\n20000\n"))
        self.assertIn("bytes of output discarded", text)
        self.assertEqual(next_offset, job.total)
        content = log_file.with_name(f"job-{job.id}.log").read_text(encoding="utf-8")
        self.assertTrue(content.startswith("1\n2\n") and content.endswith("20000\n"))
        self.assertIn("bytes of output discarded", content)


@unittest.skipIf(os.name == "nt", "Comandos POSIX")
class BackgroundCommandTest(unittest.TestCase):
    def setUp(self):
        self.data_dir = use_data_dir(self)
        self.project = (self.data_dir / "project").resolve()
        self.project.mkdir()
        use_project(self, self.project)
        use_fresh_jobs(self)
        patcher = patch.object(zerochat, "BACKGROUND_STARTUP_WAIT", 0.25)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _gate(self, name: str) -> Path:
        """FIFO en que el comando se queda bloqueado con `read _ < gate` hasta que la prueba la abre."""
        gate = self.project / name
        os.mkfifo(gate)
        return gate

    def _open_gate(self, gate: Path):
        # O_RDWR no espera a que haya lector: la línea queda en la tubería hasta que el comando la lee.
        fd = os.open(gate, os.O_RDWR | os.O_NONBLOCK)
        self.addCleanup(os.close, fd)
        os.write(fd, b"go\n")

    def _follow_log(self, job_id: int, size: int, offset: int = 0) -> tuple[str, int]:
        """Sigue el log por long-poll, como la tarjeta, hasta tener size bytes; devuelve el texto y el siguiente offset."""
        text = ""
        while len(text) < size:
            page, err, _ = zerochat.dispatch_jobs("zerochat/jobs/log", {"id": job_id, "offset": offset, "wait_ms": 5000},
                                                  zerochat.project_context())
            self.assertIsNone(err)
            self.assertTrue(page["text"], f"El log no avanzó en 5 s: {text!r}")
            text, offset = text + page["text"], page["next"]
        return text, offset

    def test_check_command_sigue_la_salida_nueva_y_detiene_el_comando(self):
        failed = run("echo ocupado; exit 4", background=True)
        self.assertEqual((failed["status"], failed["exit_code"], failed["output"]), ("exited", 4, "ocupado\n"))

        gate = self._gate("gate-follow")
        started = time.monotonic()
        first = run(f"echo uno; read _ < '{gate}'; echo dos; echo tres", background=True, job_key="clave-de-prueba")
        self.assertLess(time.monotonic() - started, 2)
        self.assertEqual((first["status"], first["output"]), ("running", "uno\n"))
        self.assertIn("check_command", first["note"])
        job_id = first["job_id"]
        self.assertEqual(zerochat.JOBS.get(str(self.project), key="clave-de-prueba").id, job_id)

        # Solo devuelve lo que el modelo aún no ha visto, y wait_seconds vuelve en cuanto termina el comando.
        nothing = check(job_id)
        self.assertEqual((nothing["status"], nothing["new_output"]), ("running", ""))
        self._open_gate(gate)
        finished = check(job_id, wait_seconds=10)
        self.assertEqual((finished["returned_because"], finished["status"], finished["exit_code"], finished["new_output"]),
                         ("command_finished", "exited", 0, "dos\ntres\n"))
        self.assertIs(zerochat.JOBS.get(str(self.project), job_id=job_id).reported, True)

        for kwargs in ({"job_id": 9999}, {}, {"wait_seconds": 1, "pattern": "x"}):
            with self.subTest(kwargs=kwargs):
                invalid = json.loads(zerochat.check_command(**kwargs, ctx=zerochat.project_context()))
                self.assertIs(invalid["success"], False)

    def test_las_esperas_de_comandos_no_pasan_del_tope_unico_en_la_interfaz_ni_en_modo_ejecucion(self):
        # El fetch de Node del runner corta a los 300 s sin respuesta: run_command y check_command responden antes
        # del mismo tope (TOOL_WAIT_MAX_SECONDS) se pidan los segundos que se pidan, con o sin ejecución desatendida.
        self.assertLess(zerochat.TOOL_WAIT_MAX_SECONDS, 300)
        self.assertEqual((zerochat.COMMAND_MAX_TIMEOUT, zerochat.COMMAND_MAX_WAIT, zerochat.AGENT_MAX_WAIT), (zerochat.TOOL_WAIT_MAX_SECONDS,) * 3)
        for run_session in (None, zerochat.RunSession("Hola")):
            with self.subTest(run_mode=run_session is not None):
                gate = self._gate(f"gate-tope-{run_session is not None}")
                with patch.object(zerochat, "COMMAND_MAX_TIMEOUT", 1), patch.object(zerochat, "COMMAND_MAX_WAIT", 1), \
                        patch.object(zerochat, "RUN_SESSION", run_session):
                    started = time.monotonic()
                    moved = run(f"read _ < '{gate}'", timeout_seconds=600)
                    self.assertLess(time.monotonic() - started, 10)
                    self.assertEqual(moved["status"], "running")
                    self.assertIn("Still running after 1 s", moved["note"])
                    self.assertIn("wait_seconds=1)", moved["note"])
                    started = time.monotonic()
                    waited = check(moved["job_id"], wait_seconds=600)
                    self.assertLess(time.monotonic() - started, 10)
                    self.assertEqual((waited["returned_because"], waited["status"]), ("wait_elapsed", "running"))
                self._open_gate(gate)
                self.assertEqual(check(moved["job_id"], wait_seconds=10)["returned_because"], "command_finished")

    def test_check_command_vuelve_en_cuanto_una_linea_nueva_cumple_el_patron(self):
        # Texto literal con | (no regex: (a+)+$ contra 40 «a» y «!» no bloquea ni casa) y sin distinguir mayúsculas.
        gate = self._gate("gate-pattern")
        server = run(f"echo arrancando; read _ < '{gate}'; printf 'a%.0s' $(seq 40); printf '!\\nServer listening(8080)\\n'; exec sleep 100", background=True)
        self._open_gate(gate)
        started = time.monotonic()
        matched = check(server["job_id"], wait_seconds=30, pattern="(a+)+$|LISTENING(")
        self.assertLess(time.monotonic() - started, 5)
        self.assertLess(matched["waited_s"], 5)
        self.assertEqual((matched["status"], matched["returned_because"], matched["matched_line"]),
                         ("running", "pattern_matched", "Server listening(8080)"))
        self.assertEqual(matched["new_output"], "a" * 40 + "!\nServer listening(8080)\n")
        # Solo cuenta la salida nueva: la línea ya vista no vuelve a coincidir.
        started = time.monotonic()
        again = check(server["job_id"], wait_seconds=1, pattern="listening")
        self.assertGreaterEqual(time.monotonic() - started, 0.9)
        self.assertEqual((again["returned_because"], again["new_output"]), ("wait_elapsed", ""))
        self.assertNotIn("matched_line", again)
        self.assertIn("No new output while waiting", again["note"])
        self.assertNotIn("note", matched)
        for empty in ("|", " | "):
            with self.subTest(pattern=empty):
                invalid = check(server["job_id"], wait_seconds=1, pattern=empty)
                self.assertIs(invalid["success"], False)
                self.assertIn("at least one text", invalid["error"])
        check(server["job_id"], stop=True)

        # Al terminar el comando se compara también una última línea sin salto de línea.
        unterminated_gate = self._gate("gate-unterminated")
        unterminated = run(f"read _ < '{unterminated_gate}'; printf 'fatal error: disk full'", background=True)
        self._open_gate(unterminated_gate)
        result = check(unterminated["job_id"], wait_seconds=10, pattern="fatal")
        self.assertEqual((result["returned_because"], result["matched_line"]), ("pattern_matched", "fatal error: disk full"))

    def test_la_espera_que_llega_por_tools_call_se_corta_con_la_clave_de_su_invocacion(self):
        # Como en uso real: la interfaz manda la clave en _meta.zerochatJobKey y end_wait corta la espera sin detener el comando.
        ctx = zerochat.project_context()
        server = run("exec sleep 100", background=True)
        end_wait = lambda key: zerochat.dispatch_jobs("zerochat/jobs/end_wait", {"key": key}, ctx)[0]
        for arguments in ({"job_id": server["job_id"], "wait_seconds": 30}, {"job_id": server["job_id"], "wait_seconds": 30, "pattern": "nunca"}):
            with self.subTest(arguments=arguments):
                key = "espera-por-tools-call-1"
                results, opened = [], threading.Event()
                real_open = zerochat.WAITS.open

                def tracked_open(*args):
                    event = real_open(*args)
                    opened.set()
                    return event

                call = {"name": "check_command", "arguments": arguments, "_meta": {"zerochatJobKey": key}}
                waiter = threading.Thread(target=lambda: results.append(zerochat.dispatch_local("tools/call", call, ctx)))
                started = time.monotonic()
                with patch.object(zerochat.WAITS, "open", side_effect=tracked_open):
                    waiter.start()
                    self.assertTrue(opened.wait(5), "check_command no llegó a esperar")
                self.assertIs(end_wait(key)["ended"], True)
                waiter.join(5)
                self.assertLess(time.monotonic() - started, 5, "La espera no se cortó")
                result, error, _ = results[0]
                self.assertIsNone(error)
                self.assertEqual(json.loads(result["content"][0]["text"])["returned_because"], "wait_ended_by_user")
                self.assertIs(end_wait(key)["ended"], False, "Una espera terminada ya no se puede cortar")
        self.assertEqual(check(server["job_id"])["status"], "running")
        check(server["job_id"], stop=True)

    def test_jobs_log_long_poll_despierta_al_llegar_salida_nueva(self):
        ctx = zerochat.project_context()
        gate = self._gate("log-gate")
        job = run(f"printf 'uno\\n'; read _ < '{gate}'; printf 'dos\\n'; exec sleep 100", background=True)
        first, offset = self._follow_log(job["job_id"], len("uno\n"))
        self.assertEqual(first, "uno\n")
        # La puerta se abre cuando la petición ya espera salida nueva: es la salida la que la despierta.
        command_job = zerochat.JOBS.get(str(self.project), job_id=job["job_id"])
        real_wait = command_job.wait_change

        def open_then_wait(*args):
            self._open_gate(gate)
            return real_wait(*args)

        started = time.monotonic()
        with patch.object(command_job, "wait_change", side_effect=open_then_wait) as waited:
            second, err, _ = zerochat.dispatch_jobs("zerochat/jobs/log", {"id": job["job_id"], "offset": offset, "wait_ms": 5000}, ctx)
        self.assertEqual(waited.call_count, 1)
        self.assertIsNone(err)
        self.assertLess(time.monotonic() - started, 3)
        self.assertIn("dos", second["text"])
        check(job["job_id"], stop=True)

    def test_jobs_log_por_clave_espera_a_que_se_lance_el_comando(self):
        # La tarjeta pide el log por la clave de su invocación antes de que tools/call lance el comando.
        ctx = zerochat.project_context()
        log = lambda key, wait_ms: zerochat.dispatch_jobs("zerochat/jobs/log", {"key": key, "tail": 1024, "wait_ms": wait_ms}, ctx)

        def wait_in_background(key, wait_ms):
            entered, results = threading.Event(), []
            real = zerochat.JOBS.wait_registered

            def tracked(*args):
                entered.set()
                return real(*args)

            patcher = patch.object(zerochat.JOBS, "wait_registered", side_effect=tracked)
            patcher.start()
            self.addCleanup(patcher.stop)
            waiter = threading.Thread(target=lambda: results.append(log(key, wait_ms)))
            waiter.start()
            self.assertTrue(entered.wait(5))
            return waiter, results

        waiter, results = wait_in_background("tarjeta-antes-de-lanzar", 10000)
        started = time.monotonic()
        job = run("exec sleep 100", background=True, job_key="tarjeta-antes-de-lanzar")
        waiter.join(5)
        self.assertLess(time.monotonic() - started, 5)
        page, err, _ = results[0]
        self.assertIsNone(err)
        self.assertEqual(page["details"]["id"], job["job_id"])

        # Una clave que nadie lanza vuelve al vencer la espera, y sin espera enseguida.
        for wait_ms in (0, 200):
            with self.subTest(wait_ms=wait_ms):
                started = time.monotonic()
                _, err, _ = log("nunca-lanzada", wait_ms)
                elapsed = time.monotonic() - started
                self.assertIn("Comando no encontrado", err["message"])
                self.assertGreaterEqual(elapsed, wait_ms / 1000)
                self.assertLess(elapsed, wait_ms / 1000 + 2)

        # Solo se espera por una clave sin id: una clave vacía o un id que no existe fallan enseguida.
        for params in ({"key": ""}, {"id": 9999, "key": "tarjeta-antes-de-lanzar"}, {"id": 9999, "key": "nunca-lanzada"}):
            with self.subTest(params=params):
                started = time.monotonic()
                _, err, _ = zerochat.dispatch_jobs("zerochat/jobs/log", {**params, "tail": 0, "wait_ms": 5000}, ctx)
                self.assertIn("Comando no encontrado", err["message"])
                self.assertLess(time.monotonic() - started, 1)

        # Al apagar se cortan las esperas pendientes.
        waiter, results = wait_in_background("nunca-lanzada", 30000)
        started = time.monotonic()
        zerochat.JOBS.stop_all()
        waiter.join(5)
        self.assertLess(time.monotonic() - started, 5)
        self.assertIn("Comando no encontrado", results[0][1]["message"])

    def test_el_latido_publica_la_ultima_linea_de_cada_comando_en_marcha_recortada_en_el_borde(self):
        limit = zerochat.LAST_LINE_MAX_CHARS
        # (comando, su salida, la última línea publicada)
        cases = [
            ("printf 'uno\\ndos\\n\\n'", "uno\ndos\n\n", "dos"),
            # Una barra de progreso que se reescribe con \r: su último tramo.
            ("printf 'descargando 10%%\\rdescargando 55%%\\r'", "descargando 10%\rdescargando 55%\r", "descargando 55%"),
            (f"head -c {limit} /dev/zero | tr '\\0' a; echo", "a" * limit + "\n", "a" * limit),
            (f"head -c {limit + 1} /dev/zero | tr '\\0' a; echo", "a" * (limit + 1) + "\n", "a" * (limit - 1) + "…"),
        ]
        ctx = zerochat.project_context()
        for command, output, expected in cases:
            with self.subTest(command=command):
                job = run(f"{command}; exec sleep 100", background=True)
                # La salida no cambia la firma rev (no despierta los latidos en espera): se espera por el log y
                # el latido, que calcula last_line al leer, se pide una vez con la salida completa.
                self.assertEqual(self._follow_log(job["job_id"], len(output))[0], output)
                published = next(item for item in zerochat.live_state(ctx)["jobs"] if item["id"] == job["job_id"])
                self.assertEqual(published["last_line"], expected)
                check(job["job_id"], stop=True)

    def test_un_comando_identico_a_otro_en_marcha_no_se_relanza_y_se_indica_cual_seguir(self):
        first = run("exec sleep 100", background=True)
        again = run("  exec sleep 100 ", timeout_seconds=1)
        self.assertIs(again["success"], False)
        self.assertIn(f"already running as job_id {first['job_id']}", again["error"])
        self.assertEqual(len(zerochat.JOBS.running(str(self.project))), 1, "No se lanza un segundo proceso")
        # En otro proyecto es otro comando.
        other = zerochat.SecurityContext(self.data_dir.resolve())
        elsewhere = json.loads(zerochat.run_command("exec sleep 100", background=True, ctx=other))
        self.assertEqual(elsewhere["status"], "running")
        json.loads(zerochat.check_command(elsewhere["job_id"], stop=True, ctx=other))
        # Detenido el primero, se puede lanzar de nuevo.
        check(first["job_id"], stop=True)
        relaunched = run("exec sleep 100", background=True)
        self.assertEqual(relaunched["status"], "running")
        check(relaunched["job_id"], stop=True)

    def test_cada_proyecto_solo_ve_y_detiene_sus_comandos(self):
        other = zerochat.SecurityContext(self.data_dir.resolve())
        alive = run("exec sleep 100", background=True)
        foreign = json.loads(zerochat.check_command(alive["job_id"], stop=True, ctx=other))
        self.assertIs(foreign["success"], False, "Otro proyecto no puede consultarlo ni detenerlo")
        self.assertEqual(zerochat.JOBS.running(str(other.workspace_dir)), [])
        self.assertEqual([job.id for job in zerochat.JOBS.running(str(self.project))], [alive["job_id"]])
        self.assertIsNone(zerochat.JOBS.get(str(other.workspace_dir), job_id=alive["job_id"]))
        self.assertEqual(check(alive["job_id"], stop=True)["status"], "stopped")

    def test_un_final_no_visto_se_entrega_una_sola_vez(self):
        # Los finales ya vistos y los comandos vivos nunca se entregan.
        seen = run("echo visto", background=True)
        zerochat.JOBS.get(str(self.project), job_id=seen["job_id"]).done.wait(5)
        check(seen["job_id"])
        unseen_gate = self._gate("gate-unseen")
        unseen = run(f"echo a; read _ < '{unseen_gate}'; echo fin; exit 3", background=True)
        self._open_gate(unseen_gate)
        zerochat.JOBS.get(str(self.project), job_id=unseen["job_id"]).done.wait(5)
        alive = run("exec sleep 100", background=True)
        reports = zerochat.JOBS.report_finished([unseen["job_id"], seen["job_id"], alive["job_id"], 9999, unseen["job_id"]], str(self.project))
        self.assertEqual([report["id"] for report in reports], [unseen["job_id"]])
        self.assertEqual((reports[0]["exit_code"], reports[0]["tail"]), (3, "a\nfin"))
        self.assertTrue(reports[0]["log_file"].endswith(".log"))
        self.assertEqual(zerochat.JOBS.report_finished([unseen["job_id"]], str(self.project)), [])
        self.assertEqual(check(unseen["job_id"])["new_output"], "")

    def test_se_conservan_max_finished_jobs_comandos_terminados_y_al_pasar_se_borra_el_mas_antiguo_con_su_log(self):
        ctx = zerochat.project_context()
        limit = zerochat.MAX_FINISHED_JOBS
        jobs = []
        for _ in range(limit + 1):
            job = zerochat.JOBS.start("exit 0", False, ctx)
            self.assertTrue(job.done.wait(5))
            jobs.append(job)
        # Al lanzar el último había exactamente el tope de terminados: no se descartó ninguno.
        self.assertEqual([job.id for job in zerochat.JOBS.list(ctx.key)], [job.id for job in jobs])
        self.assertTrue(jobs[0].log_path.exists())
        # Con uno más terminado, el siguiente arranque descarta el más antiguo y su log.
        newest = zerochat.JOBS.start("exit 0", False, ctx)
        self.assertTrue(newest.done.wait(5))
        self.assertIsNone(zerochat.JOBS.get(ctx.key, job_id=jobs[0].id))
        self.assertFalse(jobs[0].log_path.exists())
        self.assertIsNotNone(zerochat.JOBS.get(ctx.key, job_id=jobs[1].id))

    def test_hay_un_limite_de_comandos_simultaneos_y_al_apagar_se_detienen_y_se_borran_los_logs(self):
        with patch.object(zerochat, "MAX_RUNNING_JOBS", 1):
            busy = run("sleep 100", background=True)
            refused = run("echo otro")
        self.assertIs(refused["success"], False)
        self.assertIn("Too many commands", refused["error"])

        log_dir = zerochat.JOBS.get(str(self.project), job_id=busy["job_id"]).log_path.parent
        zerochat.JOBS.shutdown()
        self.assertEqual(zerochat.JOBS.get(str(self.project), job_id=busy["job_id"]).status, "stopped")
        self.assertFalse(log_dir.exists())


@unittest.skipIf(os.name == "nt", "Grupos de procesos POSIX")
class OrphanJobsTest(unittest.TestCase):
    def setUp(self):
        use_data_dir(self)
        jobs_tmp = tempfile.TemporaryDirectory()
        self.addCleanup(jobs_tmp.cleanup)
        patcher = patch.object(tempfile, "tempdir", jobs_tmp.name)
        patcher.start()
        self.addCleanup(patcher.stop)
        use_fresh_jobs(self)
        self.base = zerochat._jobs_base_dir()
        self.assertEqual(self.base.parent, Path(jobs_tmp.name))

    def spawn_group(self):
        proc = subprocess.Popen(["sleep", "100"], start_new_session=True)
        self.addCleanup(proc.wait)
        self.addCleanup(proc.kill)
        return proc, {"pgid": proc.pid, "start": zerochat._process_start_token(proc.pid)}

    def session(self, name, owner, jobs):
        directory = self.base / name
        directory.mkdir()
        (directory / "owner.json").write_text(json.dumps(owner), encoding="utf-8")
        (directory / "jobs.json").write_text(json.dumps(jobs), encoding="utf-8")
        return directory

    def test_al_arrancar_se_matan_los_comandos_de_instancias_muertas_sin_tocar_las_vivas(self):
        dead_owner = subprocess.Popen(["true"])
        dead_owner.wait()
        orphan, orphan_entry = self.spawn_group()
        reused, reused_entry = self.spawn_group()
        reused_entry["start"] = "otro-arranque"
        dead = self.session("dead", {"pid": dead_owner.pid, "start": "x"}, {"1": orphan_entry, "2": reused_entry})

        alive_job, alive_entry = self.spawn_group()
        alive = self.session("alive", {"pid": os.getpid(), "start": zerochat._process_start_token(os.getpid())}, {"1": alive_entry})
        # Un proceso vivo con otro arranque no es la instancia registrada: su sesión se limpia.
        impostor_job, impostor_entry = self.spawn_group()
        impostor = self.session("impostor", {"pid": alive_job.pid, "start": "otro-arranque"}, {"1": impostor_entry})

        self.assertEqual(zerochat.cleanup_orphan_jobs(), 2)
        self.assertEqual((orphan.wait(timeout=5), impostor_job.wait(timeout=5)), (-9, -9))
        self.assertIsNone(reused.poll(), "un PID reutilizado por otro proceso no se mata")
        self.assertIsNone(alive_job.poll(), "los comandos de una instancia viva no se tocan")
        self.assertFalse(dead.exists() or impostor.exists())
        self.assertTrue(alive.exists())

        # La propia instancia apunta sus comandos en marcha y limpia su sesión al apagar.
        with patch.object(zerochat, "BACKGROUND_STARTUP_WAIT", 0.05):
            started = run("exec sleep 100", background=True)
        job = zerochat.JOBS.get(str(zerochat.PROJECT_DIR), job_id=started["job_id"])
        own = job.log_path.parent
        self.assertEqual(json.loads((own / "owner.json").read_text(encoding="utf-8"))["pid"], os.getpid())
        registry = json.loads((own / "jobs.json").read_text(encoding="utf-8"))
        self.assertEqual(registry[str(job.id)], {"pgid": job.proc.pid, "start": zerochat._process_start_token(job.proc.pid)})
        check(job.id, stop=True)
        self.assertEqual(json.loads((own / "jobs.json").read_text(encoding="utf-8")), {})
        zerochat.JOBS.shutdown()
        self.assertFalse(own.exists())


class ProcessAliveTest(unittest.TestCase):
    def test_distingue_un_proceso_vivo_de_uno_terminado_sin_enviarle_senales_en_windows(self):
        finished = subprocess.Popen([zerochat.sys.executable, "-c", "pass"])
        finished.wait()
        real_kill = os.kill
        with patch.object(zerochat.os, "kill", side_effect=real_kill) as kill:
            self.assertTrue(zerochat._pid_alive(os.getpid()))
            self.assertFalse(zerochat._pid_alive(finished.pid))
        # En Windows, os.kill(pid, 0) envía Ctrl+C a la consola del proceso: no debe usarse.
        if os.name == "nt":
            kill.assert_not_called()
        for invalid in (0, -1, True, "1", None):
            self.assertFalse(zerochat._pid_alive(invalid), invalid)


@unittest.skipIf(os.name == "nt", "Señales POSIX")
class KillProcessTreeTest(unittest.TestCase):
    def test_con_solo_el_pid_espera_la_salida_tras_sigterm_hasta_el_plazo_y_despues_lo_fuerza(self):
        # Como la ejecución en servidor de otra instancia: no es un Popen de quien lo termina.
        for on_term, grace, returncode in (("sys.exit(0)", 10, 0), ("None", 0.2, -signal.SIGKILL)):
            with self.subTest(on_term=on_term):
                script = (f"import signal, sys, time\nsignal.signal(signal.SIGTERM, lambda *_: {on_term})\n"
                          "print('listo', flush=True)\ntime.sleep(100)\n")
                proc = subprocess.Popen([zerochat.sys.executable, "-c", script], stdout=subprocess.PIPE, text=True,
                                        start_new_session=True)
                self.addCleanup(proc.wait)
                self.addCleanup(lambda p=proc: p.poll() is None and p.kill())
                self.assertEqual(proc.stdout.readline(), "listo\n")
                proc.stdout.close()
                started = time.monotonic()
                zerochat._kill_process_tree(proc.pid, grace_seconds=grace)
                elapsed = time.monotonic() - started
                self.assertEqual(proc.wait(5), returncode)
                if returncode == 0:
                    self.assertLess(elapsed, 5, "Debe volver en cuanto termina, no al vencer el plazo")
                else:
                    self.assertGreaterEqual(elapsed, grace)


@unittest.skipUnless(sys.platform == "linux", "pidfd de Linux")
class PidExitWaitTest(unittest.TestCase):
    def test_espera_aunque_el_descriptor_del_proceso_pase_de_fd_setsize(self):
        import resource
        soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
        needed = 1100
        if soft < needed:
            if hard != resource.RLIM_INFINITY and hard < needed:
                self.skipTest(f"RLIMIT_NOFILE no llega a {needed}")
            resource.setrlimit(resource.RLIMIT_NOFILE, (needed, hard))
            self.addCleanup(resource.setrlimit, resource.RLIMIT_NOFILE, (soft, hard))
        # Se ocupan los descriptores libres hasta pasar de 1024 y se suelta el último: el pidfd lo recibe.
        read_end, write_end = os.pipe()
        held = [read_end, write_end]
        self.addCleanup(lambda: [os.close(fd) for fd in held])
        while held[-1] <= 1024:
            held.append(os.dup(read_end))
        os.close(held.pop())

        worker = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(100)"])
        self.addCleanup(worker.wait)
        self.addCleanup(worker.kill)
        self.assertIs(zerochat.wait_pid_exit(worker.pid, 0.1), False)
        worker.terminate()
        self.assertIs(zerochat.wait_pid_exit(worker.pid, 5), True)


@unittest.skipUnless(os.name == "nt", "Job Object de Windows")
class WindowsJobObjectTest(unittest.TestCase):
    def test_cada_comando_queda_en_un_job_object_que_lo_mata_si_zerochat_termina(self):
        import ctypes
        from ctypes import wintypes

        use_data_dir(self)
        use_fresh_jobs(self)
        job = zerochat.JOBS.start("Start-Sleep -Seconds 30", background=True, project=zerochat.SecurityContext(Path.cwd()))
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.IsProcessInJob.argtypes = [wintypes.HANDLE, wintypes.HANDLE, ctypes.POINTER(wintypes.BOOL)]
        inside = wintypes.BOOL(False)
        self.assertTrue(kernel32.IsProcessInJob(int(job.proc._handle), zerochat.JOBS._windows_job._handle, ctypes.byref(inside)))
        self.assertTrue(inside.value)
        zerochat.JOBS.stop(job, "user")
        self.assertEqual(job.status, "stopped")
