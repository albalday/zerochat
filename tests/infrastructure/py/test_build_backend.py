import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[3]
BUILD_BACKEND_PATH = ROOT_DIR / "scripts" / "build-backend.py"

_spec = importlib.util.spec_from_file_location("build_backend_script", BUILD_BACKEND_PATH)
assert _spec is not None and _spec.loader is not None
build_mod = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = build_mod
_spec.loader.exec_module(build_mod)


class BuildBackendCompilerTest(unittest.TestCase):
    def _write_tree(self, files: dict[str, str]) -> Path:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        py_dir = Path(tmp.name) / "py"
        py_dir.mkdir(parents=True, exist_ok=True)
        for rel, content in files.items():
            target = py_dir / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")
        return py_dir

    def test_compila_dag_en_espacio_plano_deduplica_imports_y_ordena_transicion(self):
        # z_base aparece alfabéticamente después de a_consumer para verificar orden topológico real.
        py_dir = self._write_tree({
            "core/__init__.py": "",
            "core/z_base.py": (
                "from __future__ import annotations\n"
                "import json\n"
                "from pathlib import Path\n\n"
                "BASE_VAL = 10\n\n"
                "def get_base() -> int:\n"
                "    return BASE_VAL\n"
            ),
            "app/__init__.py": "",
            "app/a_consumer.py": (
                "from __future__ import annotations\n"
                "import json\n"
                "from pathlib import Path\n"
                "from core.z_base import get_base, BASE_VAL\n\n"
                "def total() -> int:\n"
                "    return get_base() + BASE_VAL\n"
            ),
            "zz-legacy.py": (
                "import os\n"
                "def legacy_fn() -> int:\n"
                "    return total() + 1\n"
            ),
        })

        compiled = build_mod.compile_backend(py_dir)

        # Imports stdlib y __future__ deduplicados.
        self.assertEqual(compiled.count("from __future__ import annotations"), 1)
        self.assertEqual(compiled.count("import json"), 1)
        self.assertEqual(compiled.count("from pathlib import Path"), 1)
        self.assertNotIn("from core.z_base import", compiled)

        # Paquetes antes de prefijados y dependencia antes que consumidor.
        self.assertLess(compiled.index("def get_base()"), compiled.index("def total()"))
        self.assertLess(compiled.index("def total()"), compiled.index("def legacy_fn()"))

        # Espacio de nombres plano: sustituir get_base afecta directamente a total() y legacy_fn().
        ns: dict = {}
        exec(compile(compiled, "zerochat.py", "exec"), ns)
        self.assertEqual(ns["legacy_fn"](), 21)
        ns["BASE_VAL"] = 50
        self.assertEqual(ns["legacy_fn"](), 101)

    def test_rechaza_imports_internos_no_permitidos(self):
        invalid_cases = [
            ("import paquete", {
                "core/__init__.py": "",
                "core/limits.py": "LIMIT = 1\n",
                "app/__init__.py": "",
                "app/mod.py": "import core.limits\n",
            }),
            ("from paquete import modulo (acceso por atributo)", {
                "core/__init__.py": "",
                "core/limits.py": "LIMIT = 1\n",
                "app/__init__.py": "",
                "app/mod.py": "from core import limits\n",
            }),
            ("alias en import interno", {
                "core/__init__.py": "",
                "core/limits.py": "LIMIT = 1\n",
                "app/__init__.py": "",
                "app/mod.py": "from core.limits import LIMIT as L\n",
            }),
            ("import relativo", {
                "core/__init__.py": "",
                "core/limits.py": "LIMIT = 1\n",
                "core/other.py": "from .limits import LIMIT\n",
            }),
            ("import *", {
                "core/__init__.py": "",
                "core/limits.py": "LIMIT = 1\n",
                "app/__init__.py": "",
                "app/mod.py": "from core.limits import *\n",
            }),
            ("prefijo py.", {
                "core/__init__.py": "",
                "core/limits.py": "LIMIT = 1\n",
                "app/__init__.py": "",
                "app/mod.py": "from py.core.limits import LIMIT\n",
            }),
            ("modulo paquete importa prefijado", {
                "aa-legacy.py": "OLD = 1\n",
                "core/__init__.py": "",
                "core/mod.py": "from aa_legacy import OLD\n",
            }),
            ("simbolo inexistente en modulo destino", {
                "core/__init__.py": "",
                "core/limits.py": "LIMIT = 1\n",
                "app/__init__.py": "",
                "app/mod.py": "from core.limits import MISSING\n",
            }),
        ]

        for label, files in invalid_cases:
            with self.subTest(case=label):
                py_dir = self._write_tree(files)
                with self.assertRaises(build_mod.BackendBuildError):
                    build_mod.compile_backend(py_dir)

    def test_detecta_ciclos_y_colisiones_de_simbolos(self):
        py_cycle = self._write_tree({
            "a/__init__.py": "",
            "a/one.py": "from b.two import Y\nX = 1\n",
            "b/__init__.py": "",
            "b/two.py": "from a.one import X\nY = 2\n",
        })
        with self.assertRaises(build_mod.BackendBuildError) as cm_cycle:
            build_mod.compile_backend(py_cycle)
        self.assertIn("circular", str(cm_cycle.exception).lower())

        py_collision = self._write_tree({
            "a/__init__.py": "",
            "a/one.py": "SHARED = 1\n",
            "b/__init__.py": "",
            "b/two.py": "SHARED = 2\n",
        })
        with self.assertRaises(build_mod.BackendBuildError) as cm_col:
            build_mod.compile_backend(py_collision)
        self.assertIn("SHARED", str(cm_col.exception))


if __name__ == "__main__":
    unittest.main()
