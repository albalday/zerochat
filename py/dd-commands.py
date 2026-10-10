# ==============================================================================
# Ejecución de comandos y tareas en segundo plano
# ==============================================================================

COMMAND_DEFAULT_TIMEOUT = 30
COMMAND_MAX_TIMEOUT = 600
COMMAND_MAX_WAIT = 600
# Lo que espera un comando en segundo plano antes de responder: deja ver un fallo inmediato.
BACKGROUND_STARTUP_WAIT = 2.5
MAX_RUNNING_JOBS = 8
MAX_FINISHED_JOBS = 50
# El log de cada tarea conserva su comienzo en disco y su final en memoria mientras corre.
JOB_LOG_HEAD_BYTES = 4 * 1024 * 1024
JOB_LOG_TAIL_BYTES = 1024 * 1024
JOB_STOP_GRACE_SECONDS = 3.0
JOB_DRAIN_SECONDS = 2.0
JOB_KEY_PATTERN = re.compile(r"[A-Za-z0-9_-]{8,64}")
# Lo que se lee de cada extremo de la salida nueva antes de recortarla para el modelo.
MODEL_OUTPUT_READ_BYTES = 64 * 1024
CARD_TAIL_BYTES = 2048
JOB_LOG_PAGE_BYTES = 256 * 1024


def truncate_terminal_output(text: str, max_chars: int = 8000, head_lines: int = 50, tail_lines: int = 30) -> tuple[str, bool]:
    """Outputs >8,000 characters are truncated to first 50 lines + warning + last 30 lines."""
    if len(text) <= max_chars:
        return text, False
    lines = text.splitlines(keepends=True)
    if len(lines) <= head_lines + tail_lines:
        half = max_chars // 2
        return (
            text[:half]
            + f"\n\n[... Output truncated due to length ({len(text)} total characters) ...]\n\n"
            + text[-half:],
            True
        )
    omitted = len(lines) - head_lines - tail_lines
    head = "".join(lines[:head_lines])
    tail = "".join(lines[-tail_lines:])
    warning = f"\n\n[... Output truncated: omitted {omitted} lines ({len(text)} total characters) ...]\n\n"
    return head + warning + tail, True


def _powershell_executable() -> str:
    return shutil.which("powershell") or shutil.which("pwsh") or "powershell.exe"


def _kill_process_tree(proc: subprocess.Popen):
    """Termina el proceso y sus descendientes (grupo POSIX o árbol de Windows) para no dejar huérfanos."""
    try:
        if DETECTED_OS == "windows":
            # TerminateProcess solo alcanza al hijo directo: npm.cmd o npx dejarían vivo a node.
            subprocess.run(
                ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)
            )
            if proc.poll() is None:
                proc.kill()
        elif hasattr(os, "killpg") and hasattr(os, "getpgid"):
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        else:
            proc.kill()
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass


def _utf8_boundary(data: bytes) -> int:
    """Primer byte que comienza un carácter UTF-8, para no partir uno multibyte."""
    start = 0
    while start < min(len(data), 3) and (data[start] & 0xC0) == 0x80:
        start += 1
    return start


def _powershell_runner(command: str) -> str:
    """Envuelve el comando para que PowerShell devuelva su código de salida real."""
    return (
        "$ErrorActionPreference = 'Continue'\n"
        "$LASTEXITCODE = $null\n"
        "$__ret = 0\n"
        "try {\n"
        "    . {\n"
        f"{command}\n"
        "    }\n"
        "    if ($LASTEXITCODE -ne $null) {\n"
        "        $__ret = $LASTEXITCODE\n"
        "    } elseif (-not $?) {\n"
        "        $__ret = 1\n"
        "    }\n"
        "} catch {\n"
        "    $__ret = 1\n"
        "    [Console]::Error.WriteLine($_)\n"
        "}\n"
        "exit $__ret\n"
    )


class CommandJob:
    """Un comando lanzado por run_command: su proceso, su log y su estado."""

    def __init__(self, job_id: int, key: str | None, command: str, cwd: str, background: bool, log_path: Path):
        self.id = job_id
        self.key = key
        self.command = command
        self.cwd = cwd
        self.background = background
        self.log_path = log_path
        self.started_at = time.time()
        self._started_mono = time.monotonic()
        self.ended_mono: float | None = None
        self.ended_at: float | None = None
        self.exit_code: int | None = None
        self.status = "running"
        self.stop_reason: str | None = None
        self.timeout_seconds: int | None = None
        # Hasta dónde ha leído el modelo la salida, y si ya ha visto el final.
        self.model_cursor = 0
        self.reported = False
        self.proc: subprocess.Popen | None = None
        self.runner_path: Path | None = None
        self.done = threading.Event()
        self._lock = threading.Lock()
        self._log = open(log_path, "wb")
        self._head_len = 0
        self._tail = bytearray()
        self._tail_start = 0
        self._total = 0
        self._tail_file_offset = 0
        self._finalized = False
        self._reader: threading.Thread | None = None

    # --- Salida -------------------------------------------------------------

    def _append(self, chunk: bytes):
        with self._lock:
            self._total += len(chunk)
            room = JOB_LOG_HEAD_BYTES - self._head_len
            if room > 0:
                part = chunk[:room]
                self._log.write(part)
                self._log.flush()
                self._head_len += len(part)
                self._tail_start = self._head_len
                chunk = chunk[room:]
            if chunk:
                self._tail.extend(chunk)
                overflow = len(self._tail) - JOB_LOG_TAIL_BYTES
                if overflow > 0:
                    del self._tail[:overflow]
                    self._tail_start += overflow

    def _read_output(self, stream):
        try:
            while True:
                chunk = stream.read1(65536) if hasattr(stream, "read1") else stream.read(65536)
                if not chunk:
                    break
                self._append(chunk)
        except (OSError, ValueError):
            pass

    def start_reader(self, stream):
        self._reader = threading.Thread(target=self._read_output, args=(stream,), daemon=True)
        self._reader.start()

    def _finalize_log(self):
        """Al terminar, el final retenido en memoria pasa al fichero tras una marca de recorte."""
        if self._reader:
            # Un proceso que escape del grupo puede mantener el pipe abierto: no esperar sin límite.
            self._reader.join(JOB_DRAIN_SECONDS)
        with self._lock:
            marker = b""
            dropped = self._tail_start - self._head_len
            if dropped > 0:
                marker = f"\n[... {dropped} bytes of output discarded ...]\n".encode("utf-8")
                self._log.write(marker)
            self._tail_file_offset = self._head_len + len(marker)
            self._log.write(bytes(self._tail))
            self._log.close()
            self._tail = bytearray()
            self._finalized = True

    @property
    def total(self) -> int:
        return self._total

    @property
    def truncated_log(self) -> bool:
        return self._tail_start > self._head_len

    def read_range(self, start: int, max_bytes: int) -> tuple[str, int]:
        """Devuelve la salida desde la posición start (como mucho max_bytes) y la posición siguiente.

        Las posiciones cuentan los bytes producidos por el comando; el tramo descartado del medio
        se sustituye por una marca.
        """
        with self._lock:
            pos = max(0, min(start, self._total))
            remaining = max(0, max_bytes)
            pieces: list[bytes] = []
            if remaining and pos < self._head_len:
                count = min(remaining, self._head_len - pos)
                with open(self.log_path, "rb") as handle:
                    handle.seek(pos)
                    pieces.append(handle.read(count))
                pos += count
                remaining -= count
            if remaining and self._head_len <= pos < self._tail_start:
                pieces.append(f"\n[... {self._tail_start - self._head_len} bytes of output discarded ...]\n".encode("utf-8"))
                pos = self._tail_start
            if remaining and self._tail_start <= pos < self._total:
                count = min(remaining, self._total - pos)
                offset = pos - self._tail_start
                if self._finalized:
                    with open(self.log_path, "rb") as handle:
                        handle.seek(self._tail_file_offset + offset)
                        pieces.append(handle.read(count))
                else:
                    pieces.append(bytes(self._tail[offset:offset + count]))
                pos += count
        data = b"".join(pieces)
        if start > 0:
            data = data[_utf8_boundary(data):]
        return data.decode("utf-8", errors="replace"), pos

    def output_since(self, start: int) -> str:
        """La salida desde start, leyendo solo su comienzo y su final si es muy larga."""
        total = self._total
        if total - start <= 2 * MODEL_OUTPUT_READ_BYTES:
            return self.read_range(start, total - start)[0]
        head, _ = self.read_range(start, MODEL_OUTPUT_READ_BYTES)
        tail, _ = self.read_range(total - MODEL_OUTPUT_READ_BYTES, MODEL_OUTPUT_READ_BYTES)
        omitted = total - start - 2 * MODEL_OUTPUT_READ_BYTES
        return head + f"\n[... {omitted} bytes omitted ...]\n" + tail

    def tail_text(self, max_bytes: int = CARD_TAIL_BYTES) -> str:
        return self.read_range(max(0, self._total - max_bytes), max_bytes)[0]

    # --- Estado -------------------------------------------------------------

    def elapsed(self) -> float:
        end = self.ended_mono if self.ended_mono is not None else time.monotonic()
        return round(end - self._started_mono, 1)

    def summary(self) -> dict:
        return {
            "id": self.id,
            "key": self.key,
            "command": self.command if len(self.command) <= 300 else self.command[:300] + "…",
            "cwd": self.cwd,
            "background": self.background,
            "status": self.status,
            "exit_code": self.exit_code,
            "stop_reason": self.stop_reason,
            "started_at": int(self.started_at * 1000),
            "ended_at": int(self.ended_at * 1000) if self.ended_at else None,
            "elapsed_s": self.elapsed(),
            "output_bytes": self._total
        }


class JobManager:
    """Registro de los comandos lanzados en esta sesión del servidor."""

    def __init__(self):
        self._jobs: dict[int, CommandJob] = {}
        self._next_id = 1
        self._lock = threading.Lock()
        self._dir: Path | None = None
        atexit.register(self.shutdown)

    def _session_dir(self) -> Path:
        if self._dir is None:
            self._dir = Path(tempfile.mkdtemp(prefix="zerochat_jobs_"))
        return self._dir

    def running_count(self) -> int:
        with self._lock:
            return sum(1 for job in self._jobs.values() if job.status == "running")

    def _prune(self):
        finished = [job for job in self._jobs.values() if job.done.is_set()]
        for job in finished[:max(0, len(finished) - MAX_FINISHED_JOBS)]:
            del self._jobs[job.id]
            try:
                job.log_path.unlink(missing_ok=True)
            except OSError:
                pass

    def start(self, command: str, background: bool, key: str | None = None) -> CommandJob:
        if not isinstance(command, str) or not command.strip():
            raise ValueError("The command is empty.")
        if key is not None and not (isinstance(key, str) and JOB_KEY_PATTERN.fullmatch(key)):
            key = None
        cwd = str(Path.cwd().resolve())
        with self._lock:
            if sum(1 for job in self._jobs.values() if job.status == "running") >= MAX_RUNNING_JOBS:
                raise ValueError(
                    f"Too many commands running ({MAX_RUNNING_JOBS}). "
                    "Stop one with check_command(job_id, stop=true) before starting another."
                )
            self._prune()
            job_id = self._next_id
            self._next_id += 1
            job = CommandJob(job_id, key, command, cwd, background, self._session_dir() / f"job-{job_id}.log")
            self._jobs[job_id] = job
        try:
            self._launch(job)
        except Exception:
            with self._lock:
                self._jobs.pop(job_id, None)
            job._log.close()
            job.log_path.unlink(missing_ok=True)
            raise
        return job

    def _launch(self, job: CommandJob):
        if DETECTED_OS == "windows":
            job.runner_path = job.log_path.with_suffix(".ps1")
            job.runner_path.write_text(_powershell_runner(job.command), encoding="utf-8")
            argv = [_powershell_executable(), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(job.runner_path)]
        else:
            argv = [shutil.which("bash") or shutil.which("sh") or "/bin/sh", "-c", job.command]
        job.proc = subprocess.Popen(
            argv,
            cwd=job.cwd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            # Una sola salida, en el orden en que la escribe el comando, como en una terminal.
            stderr=subprocess.STDOUT,
            start_new_session=DETECTED_OS != "windows" and hasattr(os, "setsid")
        )
        job.start_reader(job.proc.stdout)
        threading.Thread(target=self._watch, args=(job,), daemon=True).start()

    def _watch(self, job: CommandJob):
        proc = job.proc
        if DETECTED_OS != "windows" and hasattr(os, "waitid"):
            # Esperar sin recoger al proceso mantiene reservado su grupo: así se puede matar a lo
            # que haya dejado en marcha sin riesgo de alcanzar a un grupo nuevo con el mismo número.
            try:
                os.waitid(os.P_PID, proc.pid, os.WEXITED | os.WNOWAIT)
                os.killpg(proc.pid, signal.SIGKILL)
            except (OSError, ChildProcessError):
                pass
        returncode = proc.wait()
        job._finalize_log()
        if proc.stdout:
            try:
                proc.stdout.close()
            except OSError:
                pass
        if job.runner_path:
            job.runner_path.unlink(missing_ok=True)
        job.ended_mono = time.monotonic()
        job.ended_at = time.time()
        job.exit_code = returncode
        if job.stop_reason == "timeout":
            job.status = "timeout"
        elif job.stop_reason:
            job.status = "stopped"
        else:
            job.status = "exited"
        job.done.set()

    def get(self, job_id=None, key=None) -> CommandJob | None:
        with self._lock:
            if isinstance(job_id, int) and not isinstance(job_id, bool):
                return self._jobs.get(job_id)
            if isinstance(key, str) and key:
                return next((job for job in self._jobs.values() if job.key == key), None)
        return None

    def list(self) -> list[CommandJob]:
        with self._lock:
            return list(self._jobs.values())

    def stop(self, job: CommandJob, reason: str) -> CommandJob:
        """Termina el grupo del comando: primero con cortesía y, si no basta, a la fuerza."""
        if job.done.is_set():
            return job
        if job.stop_reason is None:
            job.stop_reason = reason
        proc = job.proc
        if DETECTED_OS == "windows":
            _kill_process_tree(proc)
            job.done.wait(JOB_STOP_GRACE_SECONDS)
            return job
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except OSError:
            pass
        if not job.done.wait(JOB_STOP_GRACE_SECONDS):
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except OSError:
                pass
            job.done.wait(JOB_STOP_GRACE_SECONDS)
        return job

    def stop_all(self, reason: str = "shutdown") -> list[CommandJob]:
        running = [job for job in self.list() if not job.done.is_set()]
        threads = [threading.Thread(target=self.stop, args=(job, reason), daemon=True) for job in running]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(JOB_STOP_GRACE_SECONDS * 2 + 1)
        return running

    def shutdown(self):
        self.stop_all("shutdown")
        if self._dir is not None:
            shutil.rmtree(self._dir, ignore_errors=True)


JOBS = JobManager()


def _clamp_seconds(value, default: int, minimum: int, maximum: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        number = default
    return max(minimum, min(number, maximum))


def _job_result(job: CommandJob, note: str | None = None, output_field: str = "output") -> str:
    """Resultado para el modelo con la salida que aún no ha visto."""
    start = job.model_cursor
    total = job.total
    output, truncated = truncate_terminal_output(job.output_since(start))
    job.model_cursor = total
    # Detener un comando a propósito no es un fallo; sí lo son salir con error o agotar el plazo.
    failed = job.status == "timeout" or (job.status == "exited" and job.exit_code != 0)
    result = {"success": not failed, "status": job.status, "job_id": job.id}
    if job.status == "timeout":
        result["error"] = f"Command timed out after {job.timeout_seconds} s and was killed."
    if job.status == "running":
        result["elapsed_s"] = job.elapsed()
    else:
        result["exit_code"] = job.exit_code
        result["duration_s"] = job.elapsed()
        job.reported = True
    result[output_field] = output
    if truncated or job.truncated_log:
        result["truncated"] = True
        result["log_file"] = str(job.log_path)
    if job.status == "stopped":
        result["stopped_by"] = job.stop_reason
    if note:
        result["note"] = note
    return json.dumps(result, ensure_ascii=False, indent=2)


def run_command(command: str, timeout_seconds: int = COMMAND_DEFAULT_TIMEOUT, background: bool = False, job_key: str | None = None) -> str:
    """Ejecuta un comando en una shell nueva en el directorio del proyecto."""
    try:
        job = JOBS.start(command, background=bool(background), key=job_key)
    except (ValueError, OSError) as exc:
        return _tool_error(str(exc), os=DETECTED_OS)
    if background:
        if not job.done.wait(BACKGROUND_STARTUP_WAIT):
            return _job_result(job, note=(
                f"Running in background. Follow it with check_command(job_id={job.id}, wait_seconds=...) "
                f"and stop it with check_command(job_id={job.id}, stop=true)."
            ))
        return _job_result(job)
    timeout = _clamp_seconds(timeout_seconds, COMMAND_DEFAULT_TIMEOUT, 1, COMMAND_MAX_TIMEOUT)
    if not job.done.wait(timeout):
        job.timeout_seconds = timeout
        JOBS.stop(job, "timeout")
        return _job_result(job, note=(
            f"Killed after {timeout} s. If this command is expected to take longer, re-run it with "
            f"a larger timeout_seconds (max {COMMAND_MAX_TIMEOUT}) or with background=true."
        ))
    return _job_result(job)


def check_command(job_id: int, wait_seconds: int = 0, stop: bool = False) -> str:
    """Estado y salida nueva de un comando lanzado por run_command; puede esperarlo o detenerlo."""
    job = JOBS.get(job_id=job_id)
    if job is None:
        return _tool_error(f"Unknown job_id {job_id}. It may belong to a previous ZeroChat session.", os=DETECTED_OS)
    if stop:
        JOBS.stop(job, "model")
    else:
        wait = _clamp_seconds(wait_seconds, 0, 0, COMMAND_MAX_WAIT)
        if wait:
            job.done.wait(wait)
    return _job_result(job, output_field="new_output")


def job_details(job: CommandJob) -> dict:
    """Estado del comando para su tarjeta en la interfaz, con el final de su salida."""
    return {**job.summary(), "tail": job.tail_text()}
