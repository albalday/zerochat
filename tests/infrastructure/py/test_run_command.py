import json
import os
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from backend import use_data_dir, zerochat


def use_fresh_jobs(test):
    """Da a la prueba su propio registro de comandos, que se detiene y se borra al terminar."""
    jobs = zerochat.JobManager()
    patcher = patch.object(zerochat, "JOBS", jobs)
    patcher.start()
    test.addCleanup(patcher.stop)
    test.addCleanup(jobs.shutdown)


def wait_dead(pid):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return
        time.sleep(0.05)
    raise AssertionError(f"El proceso {pid} sigue vivo")


def run(command, **kwargs):
    return json.loads(zerochat.run_command(command, **kwargs))


@unittest.skipIf(os.name == "nt", "Comandos POSIX")
class RunCommandTest(unittest.TestCase):
    def setUp(self):
        self.data_dir = use_data_dir(self)
        self.project = (self.data_dir / "project").resolve()
        (self.project / "src").mkdir(parents=True)
        self.addCleanup(os.chdir, Path.cwd())
        use_fresh_jobs(self)

    def test_la_salida_une_stdout_y_stderr_y_nada_pasa_de_una_llamada_a_otra(self):
        os.chdir(self.project)
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

    def test_set_project_directory_mueve_la_raiz_de_rutas_relativas_y_comandos(self):
        dev_root = zerochat.get_dev_root()
        start = Path.cwd().resolve()
        (self.project / "note.txt").write_text("hola", encoding="utf-8")
        for bad in ("", "   ", None, 7, "x" * 5000, str(self.project / "missing"), str(self.project / "note.txt")):
            with self.subTest(path=bad):
                with self.assertRaises(ValueError):
                    zerochat.set_project_directory(bad)
                self.assertEqual(Path.cwd().resolve(), start)

        self.assertEqual(zerochat.set_project_directory(str(self.project)), {"cwd": str(self.project), "previous_cwd": str(start)})
        self.assertEqual(Path.cwd().resolve(), self.project)
        self.assertTrue(json.loads(zerochat.read_file("note.txt"))["content"].startswith("hola"))
        self.assertEqual(run("pwd")["output"].strip(), str(self.project))

        # cd solo vale dentro del comando: el proyecto (y las rutas relativas) siguen en la raíz.
        self.assertEqual(run("cd src && pwd")["output"].strip(), str(self.project / "src"))
        self.assertEqual(Path.cwd().resolve(), self.project)
        self.assertIs(json.loads(zerochat.read_file("note.txt"))["success"], True)

        # Una ruta relativa se resuelve contra el proyecto actual y los comandos arrancan en la nueva raíz.
        self.assertEqual(zerochat.set_project_directory("src")["cwd"], str(self.project / "src"))
        self.assertEqual(run("pwd")["output"].strip(), str(self.project / "src"))
        self.assertEqual(zerochat.get_dev_root(), dev_root)
        self.assertNotIn("set_project_directory", zerochat.LOCAL_TOOL_HANDLERS)

    def test_el_plazo_agotado_mata_tambien_a_los_descendientes(self):
        pid_file = self.data_dir / "timeout.pid"
        started = time.monotonic()
        result = run(f"sh -c 'echo $$ > {pid_file}; exec sleep 100' & echo antes; sleep 100", timeout_seconds=1)
        self.assertEqual((result["success"], result["status"]), (False, "timeout"))
        self.assertIn("timed out after 1 s", result["error"])
        self.assertIn("background=true", result["note"])
        self.assertEqual(result["output"], "antes\n")
        self.assertLess(time.monotonic() - started, 6)
        wait_dead(int(pid_file.read_text().strip()))

        # Lo que deja en marcha un comando que ya ha terminado no sobrevive como huérfano.
        leftover = self.data_dir / "leftover.pid"
        result = run(f"(sh -c 'echo $$ > {leftover}; exec sleep 100' &); while [ ! -s {leftover} ]; do sleep 0.05; done; echo fin")
        self.assertEqual((result["status"], result["output"]), ("exited", "fin\n"))
        wait_dead(int(leftover.read_text().strip()))

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
        job = zerochat.JOBS.get(job_id=result["job_id"])
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
        use_data_dir(self)
        use_fresh_jobs(self)
        patcher = patch.object(zerochat, "BACKGROUND_STARTUP_WAIT", 0.1)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_un_fallo_inmediato_se_ve_en_la_propia_respuesta(self):
        failed = run("echo ocupado; exit 4", background=True)
        self.assertEqual((failed["status"], failed["exit_code"], failed["output"]), ("exited", 4, "ocupado\n"))

    def test_check_command_sigue_la_salida_nueva_y_detiene_el_comando(self):
        started = time.monotonic()
        first = run("echo uno; sleep 0.5; echo dos; sleep 0.2; echo tres", background=True, job_key="clave-de-prueba")
        self.assertLess(time.monotonic() - started, 2)
        self.assertEqual((first["status"], first["output"]), ("running", "uno\n"))
        self.assertIn("check_command", first["note"])
        job_id = first["job_id"]
        self.assertEqual(zerochat.JOBS.get(key="clave-de-prueba").id, job_id)

        # Solo devuelve lo que el modelo aún no ha visto.
        nothing = json.loads(zerochat.check_command(job_id))
        self.assertEqual((nothing["status"], nothing["new_output"]), ("running", ""))
        finished = json.loads(zerochat.check_command(job_id, wait_seconds=10))
        self.assertEqual((finished["status"], finished["exit_code"], finished["new_output"]), ("exited", 0, "dos\ntres\n"))
        self.assertIs(zerochat.JOBS.get(job_id=job_id).reported, True)

        server = run("echo escuchando; exec sleep 100", background=True)
        stopped = json.loads(zerochat.check_command(server["job_id"], stop=True))
        self.assertEqual((stopped["success"], stopped["status"], stopped["stopped_by"]), (True, "stopped", "model"))

        unknown = json.loads(zerochat.check_command(9999))
        self.assertIs(unknown["success"], False)
        self.assertIn("Unknown job_id", unknown["error"])

    def test_un_final_no_visto_se_entrega_una_sola_vez(self):
        # Los finales ya vistos y los comandos vivos nunca se entregan.
        seen = run("echo visto", background=True)
        zerochat.JOBS.get(job_id=seen["job_id"]).done.wait(5)
        json.loads(zerochat.check_command(seen["job_id"]))
        unseen = run("echo a; sleep 0.5; echo fin; exit 3", background=True)
        zerochat.JOBS.get(job_id=unseen["job_id"]).done.wait(5)
        alive = run("exec sleep 100", background=True)
        reports = zerochat.JOBS.report_finished([unseen["job_id"], seen["job_id"], alive["job_id"], 9999, unseen["job_id"]])
        self.assertEqual([report["id"] for report in reports], [unseen["job_id"]])
        self.assertEqual((reports[0]["exit_code"], reports[0]["tail"]), (3, "a\nfin"))
        self.assertTrue(reports[0]["log_file"].endswith(".log"))
        self.assertEqual(zerochat.JOBS.report_finished([unseen["job_id"]]), [])
        self.assertEqual(json.loads(zerochat.check_command(unseen["job_id"]))["new_output"], "")

    def test_hay_un_limite_de_comandos_simultaneos_y_al_apagar_se_detienen_y_se_borran_los_logs(self):
        with patch.object(zerochat, "MAX_RUNNING_JOBS", 1):
            busy = run("sleep 100", background=True)
            refused = run("echo otro")
        self.assertIs(refused["success"], False)
        self.assertIn("Too many commands", refused["error"])

        log_dir = zerochat.JOBS.get(job_id=busy["job_id"]).log_path.parent
        zerochat.JOBS.shutdown()
        self.assertEqual(zerochat.JOBS.get(job_id=busy["job_id"]).status, "stopped")
        self.assertFalse(log_dir.exists())
        self.assertNotIn("bash", zerochat.LOCAL_TOOL_HANDLERS)
        self.assertNotIn("execute_command", zerochat.LOCAL_TOOL_HANDLERS)


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

    def test_la_instancia_apunta_sus_comandos_en_marcha_y_los_borra_al_terminar(self):
        with patch.object(zerochat, "BACKGROUND_STARTUP_WAIT", 0.2):
            started = run("exec sleep 100", background=True)
        job = zerochat.JOBS.get(job_id=started["job_id"])
        own = job.log_path.parent
        self.assertEqual(json.loads((own / "owner.json").read_text(encoding="utf-8"))["pid"], os.getpid())
        registry = json.loads((own / "jobs.json").read_text(encoding="utf-8"))
        self.assertEqual(registry[str(job.id)], {"pgid": job.proc.pid, "start": zerochat._process_start_token(job.proc.pid)})
        zerochat.check_command(job.id, stop=True)
        self.assertEqual(json.loads((own / "jobs.json").read_text(encoding="utf-8")), {})
        zerochat.JOBS.shutdown()
        self.assertFalse(own.exists())


@unittest.skipUnless(os.name == "nt", "Job Object de Windows")
class WindowsJobObjectTest(unittest.TestCase):
    def test_cada_comando_queda_en_un_job_object_que_lo_mata_si_zerochat_termina(self):
        import ctypes
        from ctypes import wintypes

        use_data_dir(self)
        use_fresh_jobs(self)
        job = zerochat.JOBS.start("Start-Sleep -Seconds 30", background=True)
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.IsProcessInJob.argtypes = [wintypes.HANDLE, wintypes.HANDLE, ctypes.POINTER(wintypes.BOOL)]
        inside = wintypes.BOOL(False)
        self.assertTrue(kernel32.IsProcessInJob(int(job.proc._handle), zerochat.JOBS._windows_job._handle, ctypes.byref(inside)))
        self.assertTrue(inside.value)
        zerochat.JOBS.stop(job, "user")
        self.assertEqual(job.status, "stopped")
