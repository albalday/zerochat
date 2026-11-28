"""Métodos JSON-RPC de los comandos del proyecto para la interfaz: lista, tarjetas, log, detener y cortar esperas."""

from __future__ import annotations

import time

from core.limits import LONG_POLL_MAX_WAIT_MS
from core.rpc import INVALID_PARAMS, RpcOutcome, dispatch_table, parse_nonneg_int, rpc_error, rpc_not_supported, rpc_result
from security.context import SecurityContext
from tools.job_waits import WAITS
from tools.jobs import JOBS, JOB_LOG_PAGE_BYTES, job_details


def _report(params: dict, project: str) -> RpcOutcome:
    ids = params.get("ids")
    if not isinstance(ids, list) or len(ids) > 100 or any(isinstance(i, bool) or not isinstance(i, int) for i in ids):
        return rpc_error(INVALID_PARAMS, "ids debe ser una lista de hasta 100 enteros.")
    return rpc_result({"reports": JOBS.report_finished(ids, project)})


def _log(params: dict, job) -> RpcOutcome:
    tail = params.get("tail")
    offset = params.get("offset", 0)
    limit = params.get("limit", JOB_LOG_PAGE_BYTES)
    try:
        wait_ms = parse_nonneg_int(params.get("wait_ms"), "wait_ms")
        if tail is not None:
            start = max(0, job.total - parse_nonneg_int(tail, "tail"))
        else:
            start = parse_nonneg_int(offset, "offset")
    except ValueError as exc:
        return rpc_error(INVALID_PARAMS, str(exc))
    if isinstance(limit, bool) or not isinstance(limit, int) or limit <= 0:
        return rpc_error(INVALID_PARAMS, "limit debe ser un entero positivo.")
    if wait_ms > 0 and tail is None and not job.done.is_set() and start >= job.total:
        job.wait_change(start, min(wait_ms, LONG_POLL_MAX_WAIT_MS) / 1000.0)
    text, next_offset = job.read_range(start, min(limit, JOB_LOG_PAGE_BYTES))
    return rpc_result({
        "text": text,
        "offset": start,
        "next": next_offset,
        "total": job.total,
        "done": job.done.is_set(),
        "details": job.summary(),
    })


def _stop(_params: dict, job) -> RpcOutcome:
    JOBS.stop(job, "user")
    return rpc_result({**job_details(job), "jobs": JOBS.running_summaries(job.project)})


PROJECT_JOB_METHODS = {
    "zerochat/jobs/list": lambda _params, project: rpc_result({"jobs": [job.summary() for job in JOBS.list(project)]}),
    "zerochat/jobs/report": _report,
    "zerochat/jobs/end_wait": lambda params, project: rpc_result({"ended": WAITS.cancel(params.get("key"), project)}),
}
# Métodos sobre un comando concreto, que se localiza por su id o por la clave de la invocación.
SINGLE_JOB_METHODS = {
    "zerochat/jobs/get": lambda _params, job: rpc_result(job_details(job)),
    "zerochat/jobs/log": _log,
    "zerochat/jobs/stop": _stop,
}


def dispatch_jobs(method: str, params: dict, ctx: SecurityContext) -> RpcOutcome:
    """Comandos del proyecto de la petición: tarjetas, log y botón de detener de la interfaz."""
    if method in PROJECT_JOB_METHODS:
        return dispatch_table(PROJECT_JOB_METHODS, method, params, ctx.key)
    if method not in SINGLE_JOB_METHODS:
        return rpc_not_supported(method)
    key = params.get("key")
    job = JOBS.get(ctx.key, job_id=params.get("id"), key=key)
    if job is None and method == "zerochat/jobs/log" and params.get("id") is None and isinstance(key, str) and key:
        # La tarjeta pide el log por la clave antes de que se lance el comando: con wait_ms espera a que se lance.
        # Por id no se espera: un id que no existe ya no existirá.
        try:
            wait_ms = min(parse_nonneg_int(params.get("wait_ms"), "wait_ms"), LONG_POLL_MAX_WAIT_MS)
        except ValueError as exc:
            return rpc_error(INVALID_PARAMS, str(exc))
        started = time.monotonic()
        job = JOBS.wait_registered(ctx.key, key, wait_ms / 1000.0) if wait_ms > 0 else None
        # Lo que queda de la espera es para la salida nueva.
        params = {**params, "wait_ms": max(0, wait_ms - int((time.monotonic() - started) * 1000))}
    if job is None:
        return rpc_error(INVALID_PARAMS, "Comando no encontrado: puede pertenecer a una sesión anterior de ZeroChat.")
    return dispatch_table(SINGLE_JOB_METHODS, method, params, job)
