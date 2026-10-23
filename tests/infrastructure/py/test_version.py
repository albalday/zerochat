import contextlib
import io
import unittest
from unittest.mock import patch

from backend import zerochat


class VersionTest(unittest.TestCase):
    def setUp(self):
        zerochat.reset_notices()
        self.addCleanup(zerochat.reset_notices)

    def test_en_el_repositorio_no_se_comprueba_la_version(self):
        self.assertIsNotNone(zerochat.get_dev_root())
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            zerochat.check_version()
        self.assertNotIn("Nueva versión disponible", output.getvalue())
        self.assertNotIn("_read_package_version", output.getvalue())
        self.assertEqual(zerochat.get_notices(), ())

    def test_las_versiones_se_comparan_como_semver_y_solo_major_minor_actualiza_el_ejecutable(self):
        self.assertEqual(zerochat.parse_version("7.0.5"), (7, 0, 5))
        self.assertGreater(zerochat.parse_version("7.0.10"), zerochat.parse_version("7.0.5"))
        self.assertFalse(zerochat.parse_version("7.0.5") > zerochat.parse_version("7.0.5"))
        self.assertFalse(zerochat.has_new_backend_version("7.4.9", "7.4"))
        self.assertTrue(zerochat.has_new_backend_version("7.5.0", "7.4"))

    def test_los_avisos_son_transitorios_y_rechazan_el_texto_vacio(self):
        zerochat.add_notice("Aviso de prueba")
        self.assertEqual(zerochat.get_notices(), ("Aviso de prueba",))
        self.assertEqual(zerochat.get_notices(), ("Aviso de prueba",), "Mostrarlos no los elimina")
        with self.assertRaises(ValueError):
            zerochat.add_notice("  ")

    def test_la_comprobacion_consulta_github_pages_para_la_interfaz_y_github_para_el_ejecutable(self):
        newer_version = f"{int(zerochat.VERSION.split('.')[0]) + 1}.0.0"
        with patch.object(zerochat, "get_dev_root", return_value=None), \
                patch.object(zerochat, "is_installed_runtime", return_value=True), \
                patch.object(zerochat, "_read_remote_ui_version", return_value="99.1.2"), \
                patch.object(zerochat, "_read_remote_backend_version", return_value=newer_version):
            zerochat.check_version()
        ui_notice, backend_notice = zerochat.get_notices()[-2:]
        self.assertIn("Interfaz web en GitHub Pages: v99.1.2", ui_notice)
        self.assertIn("Nueva versión del servidor disponible", backend_notice)
        self.assertIn("-m pip install --upgrade", backend_notice)

        with patch.object(zerochat, "_read_remote_content", return_value="<title>ZeroChat v8.2.2</title>"):
            self.assertEqual(zerochat._read_remote_ui_version(), "8.2.2")
        with patch.object(zerochat, "_read_remote_content", return_value='SOURCE_BACKEND_VERSION = "8.2.0"'):
            self.assertEqual(zerochat._read_remote_backend_version(), "8.2.0")
