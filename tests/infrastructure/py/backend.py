"""Carga zerochat.py una sola vez por proceso para todas las pruebas de unittest."""

import importlib.util
import os
import select
import sys
import tempfile
from pathlib import Path
from unittest import mock

ZEROCHAT_PY = Path(__file__).resolve().parents[3] / "zerochat.py"


def load_zerochat(name: str):
    """Ejecuta zerochat.py como un módulo nuevo con ese nombre."""
    spec = importlib.util.spec_from_file_location(name, ZEROCHAT_PY)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


# El gestor MCP global fija su directorio de datos al importarse: el proceso de pruebas usa uno
# temporal, nunca el del usuario.
_PROCESS_DATA_DIR = tempfile.TemporaryDirectory(prefix="zerochat-py-tests-")
os.environ["ZEROCHAT_DATA_DIR"] = _PROCESS_DATA_DIR.name
zerochat = load_zerochat("zerochat")


def use_project(test, path: Path):
    """Fija el proyecto del servidor para la prueba (sin cambiar el directorio del proceso) y devuelve su contexto."""
    patcher = mock.patch.object(zerochat, "PROJECT_DIR", Path(path).resolve())
    patcher.start()
    test.addCleanup(patcher.stop)
    return zerochat.project_context()


def use_data_dir(test) -> Path:
    """
    Da a la prueba un ZEROCHAT_DATA_DIR temporal propio, que se borra al terminar. Devuelve su ruta canónica,
    la que usa zerochat: el temporal puede pasar por un enlace (/var en macOS) o un nombre corto (RUNNER~1 en Windows).
    """
    data_dir = tempfile.TemporaryDirectory()
    test.addCleanup(data_dir.cleanup)
    patcher = mock.patch.dict(os.environ, {"ZEROCHAT_DATA_DIR": data_dir.name})
    patcher.start()
    test.addCleanup(patcher.stop)
    return Path(data_dir.name).resolve()


def wait_pid_exit(pid: int, timeout: float = 5.0) -> bool:
    """
    Espera sin sondeo a que termine un proceso que no es hijo de la prueba (los hijos se esperan con Popen.wait):
    pidfd en Linux y kqueue en macOS. Devuelve False si sigue vivo al vencer timeout.
    """
    try:
        if hasattr(os, "pidfd_open"):
            fd = os.pidfd_open(pid)
            try:
                return bool(select.select([fd], [], [], timeout)[0])
            finally:
                os.close(fd)
        queue = select.kqueue()
        try:
            event = select.kevent(pid, filter=select.KQ_FILTER_PROC, flags=select.KQ_EV_ADD | select.KQ_EV_ONESHOT,
                                  fflags=select.KQ_NOTE_EXIT)
            return bool(queue.control([event], 1, timeout))
        finally:
            queue.close()
    except ProcessLookupError:
        return True
