import os
import unittest
from unittest.mock import patch

from backend import use_data_dir, zerochat


class ProjectDirectoriesTest(unittest.TestCase):
    """Selector de carpeta de trabajo: zerochat/project/browse y zerochat/project/create_directory."""

    def setUp(self):
        data_dir = use_data_dir(self)
        self.home = (data_dir / "home").resolve()
        self.root = self.home / "proyecto"
        for name in ("src", "Docs", "alpha", ".oculta"):
            (self.root / name).mkdir(parents=True)
        (self.root / "README.md").write_text("# Hola\n", encoding="utf-8")
        self.outside = (data_dir / "fuera").resolve()
        self.outside.mkdir()
        self.ctx = zerochat.SecurityContext(self.root)
        home = patch("pathlib.Path.home", return_value=self.home)
        home.start()
        self.addCleanup(home.stop)

    def test_lista_solo_subcarpetas_no_ocultas_por_nombre_y_avisa_si_pasan_del_tope(self):
        listing = zerochat.browse_directories({}, self.ctx)
        self.assertEqual(listing, {
            "path": str(self.root),
            "parent": str(self.home),
            "directories": ["alpha", "Docs", "src"],
            "total": 3,
            "truncated": False,
        })
        # Fuera del proyecto también, y una ruta relativa se resuelve contra él.
        self.assertEqual(zerochat.browse_directories({"path": str(self.outside)}, self.ctx)["directories"], [])
        self.assertEqual(zerochat.browse_directories({"path": "src"}, self.ctx)["path"], str(self.root / "src"))
        for bad in ("   ", 7, str(self.root / "README.md"), str(self.root / "falta")):
            with self.subTest(path=bad), self.assertRaises(ValueError):
                zerochat.browse_directories({"path": bad}, self.ctx)

        with patch.object(zerochat, "MAX_BROWSE_ENTRIES", 3):
            listing = zerochat.browse_directories({}, self.ctx)
            self.assertEqual((len(listing["directories"]), listing["total"], listing["truncated"]), (3, 3, False))
            (self.root / "zeta").mkdir()
            listing = zerochat.browse_directories({}, self.ctx)
            self.assertEqual((listing["directories"], listing["total"], listing["truncated"]), (["alpha", "Docs", "src"], 4, True))

    @unittest.skipIf(os.name == "nt" or os.geteuid() == 0, "los permisos POSIX no limitan a root ni existen en Windows")
    def test_una_carpeta_sin_permiso_de_lectura_es_un_error(self):
        locked = self.root / "src"
        locked.chmod(0)
        self.addCleanup(locked.chmod, 0o755)
        with self.assertRaises(ValueError):
            zerochat.browse_directories({"path": str(locked)}, self.ctx)

    def test_crea_carpetas_de_un_nivel_solo_dentro_de_la_carpeta_personal(self):
        created = zerochat.create_project_directory({"parent": str(self.root), "name": " nuevo "}, self.ctx)
        self.assertEqual(created, {"path": str(self.root / "nuevo")})
        self.assertTrue((self.root / "nuevo").is_dir())
        self.assertEqual(zerochat.create_project_directory({"parent": str(self.home), "name": "x" * 255}, self.ctx)["path"], str(self.home / ("x" * 255)))

        for params in (
            {"parent": str(self.root), "name": "nuevo"},
            {"parent": str(self.root), "name": ""},
            {"parent": str(self.root), "name": "a/b"},
            {"parent": str(self.root), "name": "a\\b"},
            {"parent": str(self.root), "name": ".oculta2"},
            {"parent": str(self.root), "name": ".."},
            {"parent": str(self.root), "name": "x" * 256},
            {"parent": str(self.root), "name": 5},
            {"parent": str(self.root / "falta"), "name": "y"},
            {"parent": str(self.outside), "name": "y"},
            {"parent": str(self.home.parent), "name": "y"},
        ):
            with self.subTest(params=params), self.assertRaises(ValueError):
                zerochat.create_project_directory(params, self.ctx)
        self.assertFalse((self.outside / "y").exists())

        # Un enlace dentro de la carpeta personal que apunta fuera no la deja salir.
        (self.home / "enlace").symlink_to(self.outside, target_is_directory=True)
        with self.assertRaises(ValueError):
            zerochat.create_project_directory({"parent": str(self.home / "enlace"), "name": "y"}, self.ctx)
        self.assertFalse((self.outside / "y").exists())

    def test_la_credencial_del_runner_no_puede_explorar_ni_crear_carpetas(self):
        grant = zerochat.TokenGrant(token="t", kind="runner", date="2026-01-01", created_at=0, run_id="r", conversation_id="c")
        for method in ("zerochat/project/browse", "zerochat/project/create_directory", "zerochat/project/context"):
            self.assertFalse(grant.allows("/", method, {}))
            self.assertTrue(zerochat.TokenGrant(token="t", kind="remote", date="2026-01-01", created_at=0).allows("/", method, {}))

    def test_read_project_context_lee_en_una_sola_llamada_respeta_permisos_y_tope_exacto(self):
        self.assertEqual(zerochat.read_project_context(self.ctx), {"status": "missing"})
        zerochat_dir = self.root / ".zerochat"
        zerochat_dir.mkdir()
        (zerochat_dir / "task.py").write_text("# helper\n", encoding="utf-8")
        (zerochat_dir / "state.md").write_text("- Next task: M1-T1\n", encoding="utf-8")
        limit = zerochat.PROJECT_CONTEXT_MAX_BYTES
        (self.root / "AGENTS.md").write_text("a" * limit, encoding="utf-8")
        ctx_ok = zerochat.read_project_context(self.ctx)
        self.assertEqual(ctx_ok["status"], "ok")
        self.assertEqual((len(ctx_ok["rules"]["content"]), ctx_ok["rules"]["truncated"]), (limit, False))
        self.assertEqual(ctx_ok["state"], {"content": "- Next task: M1-T1\n", "truncated": False})

        # Borde N+1 de PROJECT_CONTEXT_MAX_BYTES
        (self.root / "AGENTS.md").write_text("a" * (limit + 1), encoding="utf-8")
        ctx_trunc = zerochat.read_project_context(self.ctx)
        self.assertEqual((len(ctx_trunc["rules"]["content"]), ctx_trunc["rules"]["truncated"]), (limit, True))

        # Si read_file está denegada, devuelve denied sin lanzar reto
        zerochat.ACCESS_CONTROLLER.import_state({"tools": {"read_file": {"policy": "deny"}}}, self.ctx)
        self.assertEqual(zerochat.read_project_context(self.ctx), {"status": "denied"})


if __name__ == "__main__":
    unittest.main()
