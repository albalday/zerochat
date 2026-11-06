import os
import stat
import unittest
from backend import use_data_dir, zerochat


class StorageEngineTest(unittest.TestCase):
    def setUp(self):
        self.data_dir = use_data_dir(self)
        self.storage_dir = self.data_dir / "storage"
        self.db_path = self.storage_dir / "zerochat.db"

    def test_inicializacion_crea_tablas_y_aplica_migraciones(self):
        zerochat.init_storage(self.db_path)
        self.assertTrue(self.db_path.exists())
        with zerochat.connect_storage(self.db_path) as conn:
            tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table';").fetchall()}
            self.assertIn("schema_migrations", tables)
            self.assertIn("profiles", tables)

    @unittest.skipIf(os.name == "nt", "Permisos POSIX")
    def test_permisos_directorio_0700_y_fichero_0600(self):
        zerochat.init_storage(self.db_path)
        dir_mode = stat.S_IMODE(self.storage_dir.stat().st_mode)
        db_mode = stat.S_IMODE(self.db_path.stat().st_mode)
        self.assertEqual(dir_mode, 0o700)
        self.assertEqual(db_mode, 0o600)

    def test_guardar_listar_recuperar_y_borrar_perfil_general(self):
        rev_before = zerochat.get_profiles_revision()
        sample = {
            "name": "OpenAI GPT-4o",
            "description": "Perfil de prueba en backend",
            "settings": {
                "apiUrl": "https://api.openai.com/v1",
                "apiType": "openai",
                "model": "gpt-4o",
                "apiKey": "sk-secret-12345678"
            }
        }
        saved = zerochat.save_general_profile(sample, self.db_path)
        self.assertEqual(saved["name"], "OpenAI GPT-4o")
        self.assertTrue(saved["general"])
        self.assertEqual(saved["settings"]["apiKey"], "sk-secret-12345678")
        self.assertGreater(zerochat.get_profiles_revision(), rev_before)

        # Listado sin secretos
        listed = zerochat.list_general_profiles(include_secrets=False, db_path=self.db_path)
        self.assertEqual(len(listed), 1)
        self.assertIsNone(listed[0]["settings"]["apiKey"])
        self.assertTrue(listed[0]["settings"]["hasApiKey"])

        # Recuperación por ID
        found_by_id = zerochat.get_general_profile(saved["id"], include_secrets=True, db_path=self.db_path)
        self.assertIsNotNone(found_by_id)
        self.assertEqual(found_by_id["settings"]["apiKey"], "sk-secret-12345678")

        # Recuperación por nombre exacto y con prefijo Z-
        by_exact = zerochat.get_general_profile_by_name("OpenAI GPT-4o", db_path=self.db_path)
        self.assertIsNotNone(by_exact)
        self.assertEqual(by_exact["id"], saved["id"])

        by_prefix_space = zerochat.get_general_profile_by_name("Z- OpenAI GPT-4o", db_path=self.db_path)
        self.assertIsNotNone(by_prefix_space)
        self.assertEqual(by_prefix_space["id"], saved["id"])

        by_prefix_nospace = zerochat.get_general_profile_by_name("Z-OpenAI GPT-4o", db_path=self.db_path)
        self.assertIsNotNone(by_prefix_nospace)
        self.assertEqual(by_prefix_nospace["id"], saved["id"])

        # Actualización de perfil
        updated_sample = {**saved, "description": "Descripción actualizada"}
        updated = zerochat.save_general_profile(updated_sample, self.db_path)
        self.assertEqual(updated["version"], 2)
        self.assertEqual(updated["description"], "Descripción actualizada")

        # Borrado de perfil
        deleted = zerochat.delete_general_profile(saved["id"], self.db_path)
        self.assertTrue(deleted)
        self.assertEqual(len(zerochat.list_general_profiles(db_path=self.db_path)), 0)
        self.assertFalse(zerochat.delete_general_profile("inexistente", self.db_path))

    def test_validacion_rechaza_nombres_vacios_o_duplicados(self):
        with self.assertRaises(ValueError):
            zerochat.save_general_profile({"name": "  "}, self.db_path)

        zerochat.save_general_profile({"name": "Unico", "settings": {}}, self.db_path)
        with self.assertRaises(ValueError):
            zerochat.save_general_profile({"name": "Unico", "id": "profile:distinto", "settings": {}}, self.db_path)

    def test_live_state_incluye_profiles_revision(self):
        state = zerochat.live_state()
        self.assertIn("profiles_revision", state)
        self.assertIsInstance(state["profiles_revision"], int)

    def test_rpc_dispatch_profiles_crud(self):
        handler = object.__new__(zerochat.ZeroChatServerHandler)

        # 1. Save vía RPC
        payload = {
            "name": "Z-Claude Sonnet",
            "description": "Perfil general via RPC",
            "settings": {"apiUrl": "https://api.anthropic.com/v1", "model": "claude-3-5-sonnet", "apiKey": "sk-ant-test"}
        }
        res, err, _ = handler._dispatch_profiles("zerochat/profiles/save", {"profile": payload})
        self.assertIsNone(err)
        self.assertEqual(res["profile"]["name"], "Z-Claude Sonnet")
        prof_id = res["profile"]["id"]

        # 2. List vía RPC sin secretos por defecto
        res, err, _ = handler._dispatch_profiles("zerochat/profiles/list", {})
        self.assertIsNone(err)
        self.assertEqual(len(res["profiles"]), 1)
        self.assertIsNone(res["profiles"][0]["settings"]["apiKey"])
        self.assertTrue(res["profiles"][0]["settings"]["hasApiKey"])

        # 3. Get vía RPC con secretos
        res, err, _ = handler._dispatch_profiles("zerochat/profiles/get", {"id": prof_id})
        self.assertIsNone(err)
        self.assertEqual(res["profile"]["settings"]["apiKey"], "sk-ant-test")

        # 4. Delete vía RPC
        res, err, _ = handler._dispatch_profiles("zerochat/profiles/delete", {"id": prof_id})
        self.assertIsNone(err)
        self.assertTrue(res["deleted"])

        # 5. Get no encontrado
        _, err, _ = handler._dispatch_profiles("zerochat/profiles/get", {"id": "no-existe"})
        self.assertIsNotNone(err)
        self.assertEqual(err["code"], -32602)

    def test_cli_resolucion_perfiles_desde_sqlite(self):
        # Guardamos un perfil general en SQLite
        zerochat.save_general_profile({
            "name": "Z- DeepSeek",
            "settings": {"apiUrl": "https://api.deepseek.com", "model": "deepseek-chat", "apiKey": "sk-ds-key"}
        }, self.db_path)

        parser = zerochat.build_parser()

        # Búsqueda tolerante sin Z-
        args = parser.parse_args(["--prompt", "Hola", "--profile", "DeepSeek"])
        session = zerochat.run_session_from_args(parser, args)
        self.assertIsNotNone(session)
        self.assertEqual(session.profile, "Z- DeepSeek")
        self.assertIsNotNone(session.profile_record)
        self.assertEqual(session.profile_record["settings"]["apiKey"], "sk-ds-key")

        # Búsqueda con perfil no existente en backend (fallback como string para el navegador)
        args_unknown = parser.parse_args(["--prompt", "Hola", "--profile", "Desconocido"])
        session_unknown = zerochat.run_session_from_args(parser, args_unknown)
        self.assertEqual(session_unknown.profile, "Desconocido")
        self.assertIsNone(session_unknown.profile_record)
