"""Carga zerochat.py una sola vez por proceso para todas las pruebas de unittest."""

import importlib.util
import os
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


# Al importarse, zerochat.py crea el gestor MCP, que copia los servicios gestionados en el
# directorio de datos: el proceso de pruebas usa uno temporal, nunca el del usuario.
_PROCESS_DATA_DIR = tempfile.TemporaryDirectory(prefix="zerochat-py-tests-")
os.environ["ZEROCHAT_DATA_DIR"] = _PROCESS_DATA_DIR.name
zerochat = load_zerochat("zerochat")


def use_data_dir(test) -> Path:
    """Da a la prueba un ZEROCHAT_DATA_DIR temporal propio, que se borra al terminar."""
    data_dir = tempfile.TemporaryDirectory()
    test.addCleanup(data_dir.cleanup)
    patcher = mock.patch.dict(os.environ, {"ZEROCHAT_DATA_DIR": data_dir.name})
    patcher.start()
    test.addCleanup(patcher.stop)
    return Path(data_dir.name)
