import json
import os
import stat
import unittest

from backend import load_zerochat, use_data_dir, zerochat


class DailyTokenTest(unittest.TestCase):
    def setUp(self):
        self.config_dir = use_data_dir(self) / "config"
        self.token_file = self.config_dir / "token.json"

    def test_el_token_diario_es_estable_en_el_mismo_dia_y_largo(self):
        token = zerochat.get_daily_token()
        self.assertEqual(zerochat.get_daily_token(), token)
        self.assertGreater(len(token), 20)

    @unittest.skipIf(os.name == "nt", "Permisos POSIX")
    def test_un_token_caducado_se_renueva_privado_y_solo_main_lo_genera(self):
        self.addCleanup(os.umask, os.umask(0o022))
        self.config_dir.mkdir(mode=0o755)
        self.token_file.write_text(json.dumps({"token": "x" * 43, "date": "2000-01-01"}), encoding="utf-8")
        self.token_file.chmod(0o644)

        # Importar el módulo no genera ni modifica el token: solo lo hace main().
        fresh = load_zerochat("zerochat_token_import_test")
        self.assertEqual(fresh.SESSION_TOKEN, "")
        self.assertEqual(json.loads(self.token_file.read_text(encoding="utf-8"))["token"], "x" * 43)

        token = zerochat.get_daily_token()
        self.assertEqual(stat.S_IMODE(self.config_dir.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(self.token_file.stat().st_mode), 0o600)
        self.assertEqual(json.loads(self.token_file.read_text(encoding="utf-8"))["token"], token)
        self.assertNotEqual(token, "x" * 43)
        self.assertFalse((self.config_dir / "token.json.tmp").exists())

        # Un token vigente creado con la umask por una versión anterior también se corrige.
        self.token_file.chmod(0o644)
        self.assertEqual(zerochat.get_daily_token(), token)
        self.assertEqual(stat.S_IMODE(self.token_file.stat().st_mode), 0o600)
