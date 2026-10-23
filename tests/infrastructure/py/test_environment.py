import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from backend import use_data_dir, zerochat


class EnvironmentTest(unittest.TestCase):
    def test_el_entorno_virtual_vive_en_los_datos_y_no_cambia_el_interprete_del_servidor(self):
        data_dir = use_data_dir(self)
        self.assertEqual(zerochat.get_venv_dir(), data_dir / ".venv")
        current_python = sys.executable
        # El bootstrap de pip pertenece a la biblioteca estándar y multiplica la duración de la prueba.
        real_create = zerochat.venv.create
        with patch.object(zerochat.venv, "create", side_effect=lambda env_dir, **kw: real_create(env_dir, **{**kw, "with_pip": False})):
            zerochat.ensure_virtual_environment()
        self.assertEqual(sys.executable, current_python)
        self.assertTrue(zerochat.get_venv_python(zerochat.get_venv_dir()).is_file())

    def test_un_servicio_mcp_acepta_la_version_de_node_que_cumple_el_minimo(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            service_dir = Path(temp_dir)
            (service_dir / "installer.json").write_text(json.dumps({
                "type": "npm",
                "product": {"package": "example-mcp", "version": "1.0.0"},
                "requirements": {"node": {"minimumMajor": 24}},
            }), encoding="utf-8")
            (service_dir / "node_modules" / "example-mcp").mkdir(parents=True)
            (service_dir / ".installed.json").write_text(json.dumps({"package": "example-mcp", "version": "1.0.0"}), encoding="utf-8")
            with patch.object(zerochat.shutil, "which", side_effect=lambda command: f"/usr/bin/{command}"), \
                    patch.object(zerochat.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout="v24.18.1\n")):
                zerochat.McpServiceManager()._prepare_service("example", {"_directory": service_dir})
