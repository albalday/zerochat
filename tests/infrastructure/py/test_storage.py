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
        with zerochat.open_storage() as conn:
            tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table';").fetchall()}
        self.assertTrue(self.db_path.exists())
        self.assertIn("schema_migrations", tables)
        self.assertIn("profiles", tables)

    @unittest.skipIf(os.name == "nt", "Permisos POSIX")
    def test_permisos_directorio_0700_y_fichero_0600(self):
        zerochat.list_general_profiles()
        dir_mode = stat.S_IMODE(self.storage_dir.stat().st_mode)
        db_mode = stat.S_IMODE(self.db_path.stat().st_mode)
        self.assertEqual(dir_mode, 0o700)
        self.assertEqual(db_mode, 0o600)

    def test_guardar_listar_recuperar_actualizar_y_borrar_perfil_general(self):
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
        saved = zerochat.save_general_profile(sample)
        self.assertEqual(saved["name"], "OpenAI GPT-4o")
        self.assertTrue(saved["general"])
        self.assertEqual(saved["settings"]["apiKey"], "sk-secret-12345678")

        listed = zerochat.list_general_profiles()
        self.assertEqual(len(listed), 1)
        self.assertEqual(listed[0]["settings"]["apiKey"], "sk-secret-12345678")

        found_by_id = zerochat.get_general_profile(saved["id"])
        self.assertIsNotNone(found_by_id)
        self.assertEqual(found_by_id["settings"]["apiKey"], "sk-secret-12345678")

        for query in ("OpenAI GPT-4o", "Z- OpenAI GPT-4o", "Z-OpenAI GPT-4o"):
            with self.subTest(query=query):
                by_name = zerochat.get_general_profile_by_name(query)
                self.assertIsNotNone(by_name)
                self.assertEqual(by_name["id"], saved["id"])

        # Actualizar sin enviar apiKey conserva la existente; enviar "" la vacía
        updated = zerochat.save_general_profile({**saved, "description": "Descripción actualizada", "settings": {"model": "gpt-4.1"}})
        self.assertEqual(updated["version"], 2)
        self.assertEqual(updated["description"], "Descripción actualizada")
        self.assertEqual(updated["settings"]["apiKey"], "sk-secret-12345678")

        cleared_key = zerochat.save_general_profile({**updated, "settings": {"model": "gpt-4.1", "apiKey": ""}})
        self.assertEqual(cleared_key["settings"]["apiKey"], "")

        self.assertTrue(zerochat.delete_general_profile(saved["id"]))
        self.assertEqual(len(zerochat.list_general_profiles()), 0)
        self.assertFalse(zerochat.delete_general_profile("inexistente"))

    def test_validacion_bordes_duplicados_espejo_y_bloqueo(self):
        # Borde exacto N y N+1 en nombre (128/129) y descripción (2048/2049)
        max_name = "a" * zerochat.MAX_PROFILE_NAME_LENGTH
        max_desc = "d" * zerochat.MAX_PROFILE_DESCRIPTION_LENGTH
        saved_max = zerochat.save_general_profile({
            "id": "profile:limites",
            "name": max_name,
            "description": max_desc,
            "settings": {}
        })
        self.assertEqual(len(saved_max["name"]), zerochat.MAX_PROFILE_NAME_LENGTH)
        self.assertEqual(len(saved_max["description"]), zerochat.MAX_PROFILE_DESCRIPTION_LENGTH)

        for label, bad_payload in (
            ("empty_name", {"name": "  ", "settings": {}}),
            ("name_N+1", {"name": "a" * (zerochat.MAX_PROFILE_NAME_LENGTH + 1), "settings": {}}),
            ("desc_N+1", {"name": "Valido", "description": "d" * (zerochat.MAX_PROFILE_DESCRIPTION_LENGTH + 1), "settings": {}}),
            ("mirror_name", {"name": "Espejo", "settings": {}}),
            ("mirror_id", {"id": "profile:mirror", "name": "Otro", "settings": {}}),
            ("duplicate_name", {"id": "profile:otro", "name": max_name, "settings": {}}),
        ):
            with self.subTest(case=label):
                with self.assertRaises(ValueError):
                    zerochat.save_general_profile(bad_payload)

        # Un perfil bloqueado no admite cambios pero puede borrarse
        locked = zerochat.save_general_profile({
            "id": "profile:locked",
            "name": "Bloqueado",
            "settings": {"apiKey": "sk-lock", "apiKeyLocked": True}
        })
        with self.assertRaises(ValueError):
            zerochat.save_general_profile({**locked, "description": "Intento de cambio"})
        self.assertTrue(zerochat.delete_general_profile(locked["id"]))

    def test_rpc_dispatch_profiles_crud(self):
        handler = object.__new__(zerochat.ZeroChatServerHandler)

        payload = {
            "name": "Claude Sonnet",
            "description": "Perfil general via RPC",
            "settings": {"apiUrl": "https://api.anthropic.com/v1", "model": "claude-3-5-sonnet", "apiKey": "sk-ant-test"}
        }
        res, err, _ = handler._dispatch_profiles("zerochat/profiles/save", {"profile": payload})
        self.assertIsNone(err)
        self.assertEqual(res["profile"]["name"], "Claude Sonnet")
        prof_id = res["profile"]["id"]

        res, err, _ = handler._dispatch_profiles("zerochat/profiles/list", {})
        self.assertIsNone(err)
        self.assertEqual(len(res["profiles"]), 1)
        self.assertEqual(res["profiles"][0]["settings"]["apiKey"], "sk-ant-test")

        res, err, _ = handler._dispatch_profiles("zerochat/profiles/delete", {"id": prof_id})
        self.assertIsNone(err)
        self.assertTrue(res["deleted"])

    def test_cli_resolucion_perfiles_desde_sqlite(self):
        parser = zerochat.build_parser()
        # Sin --profile y sin Z-local guardado en SQLite, falla con RUN_EXIT_ARGS (4).
        with self.assertRaises(SystemExit) as missing_default:
            zerochat.run_session_from_args(parser, parser.parse_args(["--prompt", "Hola"]))
        self.assertEqual(missing_default.exception.code, zerochat.RUN_EXIT_ARGS)

        zerochat.save_general_profile({
            "name": "DeepSeek",
            "settings": {"apiUrl": "https://api.deepseek.com", "model": "deepseek-chat", "apiKey": "sk-ds-key"}
        })
        zerochat.save_general_profile({
            "name": "Z-local",
            "settings": {"apiUrl": "http://localhost:1234/v1", "model": "local-model"}
        })

        default_session = zerochat.run_session_from_args(parser, parser.parse_args(["--prompt", "Hola"]))
        self.assertEqual(default_session.profile, "Z-local")

        for arg in ("DeepSeek", "Z- DeepSeek"):
            with self.subTest(arg=arg):
                args = parser.parse_args(["--prompt", "Hola", "--profile", arg])
                session = zerochat.run_session_from_args(parser, args)
                self.assertIsNotNone(session)
                self.assertEqual(session.profile, "DeepSeek")

        args_unknown = parser.parse_args(["--prompt", "Hola", "--profile", "Desconocido"])
        session_unknown = zerochat.run_session_from_args(parser, args_unknown)
        self.assertEqual(session_unknown.profile, "Desconocido")
