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
