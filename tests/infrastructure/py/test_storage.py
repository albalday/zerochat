import io
import os
import sqlite3
import stat
import sys
import unittest
from unittest import mock
from backend import use_data_dir, zerochat


class StorageEngineTest(unittest.TestCase):
    def setUp(self):
        self.data_dir = use_data_dir(self)
        self.storage_dir = self.data_dir / "storage"
        self.db_path = self.storage_dir / "zerochat.db"

    def test_inicializacion_crea_tablas_y_aplica_migraciones(self):
        with zerochat.open_storage() as conn:
            tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table';").fetchall()}
            migrations = {row["version"] for row in conn.execute("SELECT version FROM schema_migrations;").fetchall()}
            columns = {row["name"] for row in conn.execute("PRAGMA table_info(conversations);").fetchall()}
        self.assertTrue(self.db_path.exists())
        self.assertIn("schema_migrations", tables)
        self.assertIn("profiles", tables)
        self.assertIn("conversations", tables)
        self.assertIn("messages", tables)
        self.assertIn("blobs", tables)
        self.assertIn("security_policies", tables)
        self.assertEqual(migrations, {1, 2, 3, 4, 5})
        self.assertIn("extra_json", columns)

    def test_migracion_v4_aplica_a_base_existente(self):
        # Simula una base existente con migraciones 1, 2 y 3 aplicadas (sin extra_json en conversations)
        self.storage_dir.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(self.db_path))
        conn.execute("""
            CREATE TABLE schema_migrations (
                version INTEGER PRIMARY KEY,
                applied_at INTEGER NOT NULL,
                description TEXT NOT NULL
            );
        """)
        conn.execute("INSERT INTO schema_migrations VALUES (1, 1000, '001_create_profiles_table');")
        conn.execute("""
            CREATE TABLE profiles (
                id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, description TEXT DEFAULT '',
                settings_json TEXT NOT NULL, api_key TEXT DEFAULT '', version INTEGER DEFAULT 1,
                created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
            );
        """)
        conn.execute("INSERT INTO schema_migrations VALUES (2, 2000, '002_create_conversations_tables');")
        conn.execute("""
            CREATE TABLE conversations (
                id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL, message_count INTEGER NOT NULL DEFAULT 0
            );
        """)
        conn.execute("""
            CREATE TABLE messages (
                conversation_id TEXT NOT NULL, position INTEGER NOT NULL, id TEXT NOT NULL,
                role TEXT NOT NULL, content TEXT NOT NULL, extra_json TEXT DEFAULT '{}',
                FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
                PRIMARY KEY (conversation_id, position)
            );
        """)
        conn.execute("INSERT INTO schema_migrations VALUES (3, 3000, '003_create_blobs_table');")
        conn.execute("""
            CREATE TABLE blobs (
                id TEXT PRIMARY KEY, mime_type TEXT NOT NULL, size INTEGER NOT NULL,
                data BLOB NOT NULL, created_at INTEGER NOT NULL
            );
        """)
        conn.commit()
        conn.close()

        # Al abrir con zerochat.open_storage, se deben aplicar las migraciones 4 y 5 sin errores
        with zerochat.open_storage() as conn:
            migrations = {row["version"] for row in conn.execute("SELECT version FROM schema_migrations;").fetchall()}
            columns = {row["name"] for row in conn.execute("PRAGMA table_info(conversations);").fetchall()}
        self.assertEqual(migrations, {1, 2, 3, 4, 5})
        self.assertIn("extra_json", columns)

        # list_conversations y save_conversation funcionan correctamente tras la migración
        saved = zerochat.save_conversation({
            "id": "migrated_conv_1",
            "title": "Migrada con éxito",
            "profileId": "deepseek"
        }, [{"id": "m1", "role": "user", "content": "hola"}])
        self.assertEqual(saved["profileId"], "deepseek")
        listed = zerochat.list_conversations()
        self.assertTrue(any(c["id"] == "migrated_conv_1" and c["profileId"] == "deepseek" for c in listed))

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

    def test_rpc_dispatch_conversations_crud(self):
        handler = object.__new__(zerochat.ZeroChatServerHandler)

        # 1. Guardar conversación mediante _dispatch_local
        payload1 = {
            "conversation": {"id": "rpc_conv_1", "title": "Conversación RPC", "createdAt": 1700000000000, "updatedAt": 1700000001000},
            "messages": [{"id": "m1", "role": "user", "content": "Hola desde RPC"}]
        }
        res, err, _ = handler._dispatch_local("zerochat/conversations/save", payload1)
        self.assertIsNone(err)
        self.assertEqual(res["conversation"]["id"], "rpc_conv_1")
        self.assertEqual(res["conversation"]["title"], "Conversación RPC")
        self.assertEqual(res["conversation"]["messageCount"], 1)

        # 2. Guardar segunda conversación
        payload2 = {
            "conversation": {
                "id": "rpc_conv_2",
                "title": "Segunda conversación de prueba",
                "createdAt": 1700000002000,
                "updatedAt": 1700000003000
            },
            "messages": [{"id": "m2", "role": "user", "content": "Otro mensaje"}]
        }
        res, err, _ = handler._dispatch_conversations("zerochat/conversations/save", payload2)
        self.assertIsNone(err)
        self.assertEqual(res["conversation"]["id"], "rpc_conv_2")
        self.assertEqual(res["conversation"]["messageCount"], 1)

        # 3. Listar conversaciones
        res, err, _ = handler._dispatch_local("zerochat/conversations/list", {})
        self.assertIsNone(err)
        self.assertEqual(len(res["conversations"]), 2)
        self.assertEqual(res["conversations"][0]["id"], "rpc_conv_2")

        # 4. Obtener conversación completa por id
        res, err, _ = handler._dispatch_local("zerochat/conversations/get", {"id": "rpc_conv_1"})
        self.assertIsNone(err)
        self.assertIsNotNone(res["conversation"])
        self.assertEqual(res["conversation"]["id"], "rpc_conv_1")
        self.assertEqual(len(res["conversation"]["history"]), 1)
        self.assertEqual(res["conversation"]["history"][0]["content"], "Hola desde RPC")

        res_inexist, err_inexist, _ = handler._dispatch_conversations("zerochat/conversations/get", {"id": "inexistente"})
        self.assertIsNone(err_inexist)
        self.assertIsNone(res_inexist["conversation"])

        # 5. Renombrar conversación
        res, err, _ = handler._dispatch_local("zerochat/conversations/rename", {"id": "rpc_conv_1", "title": "Título Modificado"})
        self.assertIsNone(err)
        self.assertTrue(res["renamed"])

        res, _, _ = handler._dispatch_conversations("zerochat/conversations/get", {"id": "rpc_conv_1"})
        self.assertEqual(res["conversation"]["title"], "Título Modificado")

        res_ren_inexist, err, _ = handler._dispatch_conversations("zerochat/conversations/rename", {"id": "inexistente", "title": "Nuevo"})
        self.assertIsNone(err)
        self.assertFalse(res_ren_inexist["renamed"])

        # 6. Borrar una conversación
        res, err, _ = handler._dispatch_local("zerochat/conversations/delete", {"id": "rpc_conv_1"})
        self.assertIsNone(err)
        self.assertTrue(res["deleted"])

        res_del_inexist, err, _ = handler._dispatch_conversations("zerochat/conversations/delete", {"id": "rpc_conv_1"})
        self.assertIsNone(err)
        self.assertFalse(res_del_inexist["deleted"])

        # 7. Borrar todas las conversaciones
        res, err, _ = handler._dispatch_conversations("zerochat/conversations/delete", {"all": True})
        self.assertIsNone(err)
        self.assertTrue(res["deleted"])
        self.assertEqual(res["count"], 1)

        res_empty, _, _ = handler._dispatch_conversations("zerochat/conversations/list", {})
        self.assertEqual(len(res_empty["conversations"]), 0)

    def test_rpc_dispatch_conversations_validaciones(self):
        handler = object.__new__(zerochat.ZeroChatServerHandler)

        # get: id vacío o ausente (-32602)
        for bad_id in ({}, {"id": ""}, {"id": "   "}, {"id": 123}):
            with self.subTest(bad_id=bad_id):
                _, err, _ = handler._dispatch_conversations("zerochat/conversations/get", bad_id)
                self.assertIsNotNone(err)
                self.assertEqual(err["code"], -32602)

        # save: conversation no objeto o ausente (-32602)
        for bad_conv in ({}, {"conversation": None}, {"conversation": "no-dict"}):
            with self.subTest(bad_conv=bad_conv):
                _, err, _ = handler._dispatch_conversations("zerochat/conversations/save", bad_conv)
                self.assertIsNotNone(err)
                self.assertEqual(err["code"], -32602)

        # save: messages no lista (-32602)
        _, err, _ = handler._dispatch_conversations("zerochat/conversations/save", {"conversation": {"id": "x"}, "messages": "no-lista"})
        self.assertIsNotNone(err)
        self.assertEqual(err["code"], -32602)

        # save: límite de título N+1 (-32602)
        _, err, _ = handler._dispatch_conversations("zerochat/conversations/save", {
            "conversation": {"id": "x", "title": "t" * (zerochat.MAX_CONVERSATION_TITLE_LENGTH + 1)}
        })
        self.assertIsNotNone(err)
        self.assertEqual(err["code"], -32602)

        # rename: id o título vacío (-32602)
        for bad_rename in (
            {"id": "x", "title": ""},
            {"id": "x", "title": "   "},
            {"id": "", "title": "Valido"},
            {"id": 12, "title": "Valido"},
            {"id": "x", "title": 123}
        ):
            with self.subTest(bad_rename=bad_rename):
                _, err, _ = handler._dispatch_conversations("zerochat/conversations/rename", bad_rename)
                self.assertIsNotNone(err)
                self.assertEqual(err["code"], -32602)

        # rename: título N+1 (-32602)
        _, err, _ = handler._dispatch_conversations("zerochat/conversations/rename", {
            "id": "x",
            "title": "t" * (zerochat.MAX_CONVERSATION_TITLE_LENGTH + 1)
        })
        self.assertIsNotNone(err)
        self.assertEqual(err["code"], -32602)

        # delete: id vacío sin all=True (-32602)
        for bad_delete in ({}, {"id": ""}, {"id": "   "}, {"id": 123}):
            with self.subTest(bad_delete=bad_delete):
                _, err, _ = handler._dispatch_conversations("zerochat/conversations/delete", bad_delete)
                self.assertIsNotNone(err)
                self.assertEqual(err["code"], -32602)

        # método no soportado (-32601)
        _, err, _ = handler._dispatch_conversations("zerochat/conversations/desconocido", {})
        self.assertIsNotNone(err)
        self.assertEqual(err["code"], -32601)

    def test_cli_resolucion_perfiles_desde_sqlite(self):
        parser = zerochat.build_parser()
        # Sin --profile y sin local guardado en SQLite, falla con RUN_EXIT_ARGS (4).
        with self.assertRaises(SystemExit) as missing_default:
            zerochat.run_session_from_args(parser, parser.parse_args(["--prompt", "Hola"]))
        self.assertEqual(missing_default.exception.code, zerochat.RUN_EXIT_ARGS)

        zerochat.save_general_profile({
            "name": "DeepSeek",
            "settings": {"apiUrl": "https://api.deepseek.com", "model": "deepseek-chat", "apiKey": "sk-ds-key"}
        })
        zerochat.save_general_profile({
            "name": "local",
            "settings": {"apiUrl": "http://localhost:1234/v1", "model": "local-model"}
        })

        default_session = zerochat.run_session_from_args(parser, parser.parse_args(["--prompt", "Hola"]))
        self.assertEqual(default_session.profile, "local")

        for arg in ("DeepSeek", "Z- DeepSeek"):
            with self.subTest(arg=arg):
                args = parser.parse_args(["--prompt", "Hola", "--profile", arg])
                session = zerochat.run_session_from_args(parser, args)
                self.assertIsNotNone(session)
                self.assertEqual(session.profile, "DeepSeek")

        args_unknown = parser.parse_args(["--prompt", "Hola", "--profile", "Desconocido"])
        session_unknown = zerochat.run_session_from_args(parser, args_unknown)
        self.assertEqual(session_unknown.profile, "Desconocido")

    def test_cli_list_conversations(self):
        output_empty = io.StringIO()
        with mock.patch.object(sys, "argv", ["zerochat.py", "--list-conversations"]), mock.patch.object(sys, "stdout", output_empty):
            zerochat.main()
        self.assertIn("No hay conversaciones almacenadas en el servidor local.", output_empty.getvalue())

        zerochat.save_conversation(
            {"id": "conv_cli_1", "title": "Charla CLI", "updatedAt": 1700000000000},
            [{"role": "user", "content": "Hola"}]
        )
        zerochat.save_conversation(
            {"id": "conv_cli_2", "title": "Segunda charla", "updatedAt": 1700000010000},
            [{"role": "user", "content": "Hola 1"}, {"role": "assistant", "content": "Hola 2"}]
        )

        output_full = io.StringIO()
        with mock.patch.object(sys, "argv", ["zerochat.py", "--list-conversations"]), mock.patch.object(sys, "stdout", output_full):
            zerochat.main()
        val = output_full.getvalue()
        self.assertIn("Conversaciones almacenadas:", val)
        self.assertIn("- [conv_cli_2] Segunda charla (2 mensajes,", val)
        self.assertIn("- [conv_cli_1] Charla CLI (1 mensaje,", val)

    def test_guardar_listar_recuperar_actualizar_renombrar_y_borrar_conversacion(self):
        meta = {
            "id": "session_test_123",
            "title": "Conversación de prueba",
            "createdAt": 1700000000000,
            "updatedAt": 1700000001000,
            "profileId": "deepseek",
            "serverRun": True,
            "extra": {"cron": {"enabled": True}, "tags": ["prod"]}
        }
        messages = [
            {"id": "system_root", "role": "system", "content": "Prompt del sistema"},
            {"id": "msg_1", "role": "user", "content": "¿Cómo estás?"},
            {"id": "msg_2", "role": "assistant", "content": "¡Bien! ¿En qué te ayudo?", "tool_calls": [{"id": "call_1", "name": "test"}]}
        ]
        saved = zerochat.save_conversation(meta, messages)
        self.assertEqual(saved["id"], "session_test_123")
        self.assertEqual(saved["title"], "Conversación de prueba")
        self.assertEqual(saved["messageCount"], 3)
        self.assertEqual(saved["profileId"], "deepseek")
        self.assertEqual(saved["serverRun"], True)
        self.assertEqual(saved["extra"]["cron"], {"enabled": True})
        self.assertEqual(saved["extra"]["tags"], ["prod"])

        retrieved = zerochat.get_conversation("session_test_123")
        self.assertIsNotNone(retrieved)
        self.assertEqual(retrieved["id"], "session_test_123")
        self.assertEqual(retrieved["title"], "Conversación de prueba")
        self.assertEqual(retrieved["profileId"], "deepseek")
        self.assertEqual(retrieved["serverRun"], True)
        self.assertEqual(retrieved["extra"]["cron"], {"enabled": True})
        self.assertEqual(len(retrieved["history"]), 3)
        self.assertEqual(retrieved["history"][0]["id"], "system_root")
        self.assertEqual(retrieved["history"][1]["content"], "¿Cómo estás?")
        self.assertEqual(retrieved["history"][2]["tool_calls"], [{"id": "call_1", "name": "test"}])

        # Guardar una segunda conversación más reciente con el mismo id de mensaje inicial ('system_root')
        meta2 = {
            "id": "session_test_456",
            "title": "Otra charla sobre arquitectura",
            "createdAt": 1700000002000,
            "updatedAt": 1700000003000
        }
        zerochat.save_conversation(meta2, [
            {"id": "system_root", "role": "system", "content": "Otro sistema"},
            {"id": "msg_1", "role": "user", "content": "Hola"}
        ])
        self.assertEqual(len(zerochat.get_conversation("session_test_123")["history"]), 3)
        self.assertEqual(len(zerochat.get_conversation("session_test_456")["history"]), 2)

        listed = zerochat.list_conversations()
        self.assertEqual(len(listed), 2)
        self.assertEqual(listed[0]["id"], "session_test_456")  # Más reciente primero
        self.assertEqual(listed[1]["id"], "session_test_123")

        # Renombrar conversación
        self.assertTrue(zerochat.rename_conversation("session_test_123", "Título Renombrado"))
        renamed = zerochat.get_conversation("session_test_123")
        self.assertEqual(renamed["title"], "Título Renombrado")

        # Actualizar mensajes de una conversación existente con metadatos mínimos preserva profileId, serverRun y extra
        new_messages = [
            {"id": "msg_1", "role": "user", "content": "¿Cómo estás?"},
            {"id": "msg_2", "role": "assistant", "content": "¡Bien!"},
            {"id": "msg_4", "role": "user", "content": "Genial."}
        ]
        updated = zerochat.save_conversation({"id": "session_test_123"}, new_messages)
        self.assertEqual(updated["messageCount"], 3)
        self.assertEqual(updated["title"], "Título Renombrado")
        self.assertEqual(updated["profileId"], "deepseek")
        self.assertEqual(updated["serverRun"], True)
        self.assertEqual(updated["extra"]["cron"], {"enabled": True})
        self.assertEqual(len(zerochat.get_conversation("session_test_123")["history"]), 3)

        # El proyecto se fija la primera vez y no cambia al guardar desde otro proyecto
        with_project = zerochat.save_conversation({"id": "session_test_123", "project": "/repo/a"}, new_messages)
        self.assertEqual(with_project["project"], "/repo/a")
        moved = zerochat.save_conversation({"id": "session_test_123", "project": "/repo/b", "extra": {"project": "/repo/b"}}, new_messages)
        self.assertEqual(moved["project"], "/repo/a")
        with self.assertRaises(ValueError):
            zerochat.save_conversation({"id": "session_test_123", "project": ["/repo"]}, new_messages)

        # Desactivar explícitamente serverRun lo actualiza sin borrar profileId ni extra
        toggled = zerochat.save_conversation({"id": "session_test_123", "serverRun": False}, new_messages)
        self.assertEqual(toggled["serverRun"], False)
        self.assertEqual(toggled["profileId"], "deepseek")
        self.assertEqual(toggled["extra"]["cron"], {"enabled": True})

        # Borrar conversación y verificar borrado en cascada en la tabla messages
        with zerochat.open_storage() as conn:
            self.assertGreater(conn.execute("SELECT COUNT(*) FROM messages WHERE conversation_id = 'session_test_123';").fetchone()[0], 0)

        self.assertTrue(zerochat.delete_conversation("session_test_123"))
        self.assertIsNone(zerochat.get_conversation("session_test_123"))
        self.assertFalse(zerochat.delete_conversation("session_test_123"))

        with zerochat.open_storage() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM messages WHERE conversation_id = 'session_test_123';").fetchone()[0], 0)

        # Borrar todo
        deleted_count = zerochat.delete_all_conversations()
        self.assertEqual(deleted_count, 1)
        self.assertEqual(len(zerochat.list_conversations()), 0)

    def test_validacion_bordes_conversaciones(self):
        max_title = "t" * zerochat.MAX_CONVERSATION_TITLE_LENGTH
        max_id = "i" * zerochat.MAX_CONVERSATION_ID_LENGTH

        saved_max = zerochat.save_conversation({"id": max_id, "title": max_title}, [])
        self.assertEqual(len(saved_max["id"]), zerochat.MAX_CONVERSATION_ID_LENGTH)
        self.assertEqual(len(saved_max["title"]), zerochat.MAX_CONVERSATION_TITLE_LENGTH)

        # Borde N+1 en título (257) e ID (129)
        with self.assertRaises(ValueError):
            zerochat.save_conversation({"id": "valid_id", "title": "t" * (zerochat.MAX_CONVERSATION_TITLE_LENGTH + 1)})

        with self.assertRaises(ValueError):
            zerochat.save_conversation({"id": "i" * (zerochat.MAX_CONVERSATION_ID_LENGTH + 1), "title": "Valido"})

        # ID vacío o no string
        for bad_id in ("", "   ", None):
            with self.subTest(bad_id=bad_id):
                with self.assertRaises(ValueError):
                    zerochat.save_conversation({"id": bad_id, "title": "Valido"})

        # Título vacío se conserva vacío como en IndexedDB
        saved_empty = zerochat.save_conversation({"id": "empty_title_id", "title": "   "})
        self.assertEqual(saved_empty["title"], "")

        # rename con N+1
        with self.assertRaises(ValueError):
            zerochat.rename_conversation("empty_title_id", "t" * (zerochat.MAX_CONVERSATION_TITLE_LENGTH + 1))

        # Inexistentes devuelven None/False sin lanzar excepción
        self.assertIsNone(zerochat.get_conversation("no_existe"))
        self.assertFalse(zerochat.rename_conversation("no_existe", "Nuevo"))
        self.assertFalse(zerochat.delete_conversation("no_existe"))

    def test_blobs_crud_y_deduplicacion(self):
        data1 = b"Hello, ZeroChat Blob Storage!"
        sha1 = zerochat.hashlib.sha256(data1).hexdigest()

        # put_blob calcula el hash SHA-256
        saved1 = zerochat.put_blob(data1, mime_type="text/plain")
        self.assertEqual(saved1["id"], sha1)
        self.assertEqual(saved1["mime_type"], "text/plain")
        self.assertEqual(saved1["size"], len(data1))

        # Re-guardar mismos datos es idempotente
        saved2 = zerochat.put_blob(data1, mime_type="text/plain", blob_id=sha1)
        self.assertEqual(saved2["id"], sha1)

        # get_blob recupera los bytes exactos
        retrieved = zerochat.get_blob(sha1)
        self.assertIsNotNone(retrieved)
        self.assertEqual(retrieved["id"], sha1)
        self.assertEqual(retrieved["mime_type"], "text/plain")
        self.assertEqual(retrieved["size"], len(data1))
        self.assertEqual(retrieved["data"], data1)

        # has_blobs consulta existentes y faltantes
        fake_id = "0" * 64
        status = zerochat.has_blobs([sha1, fake_id])
        self.assertEqual(status["existing"], [sha1])
        self.assertEqual(status["missing"], [fake_id])

    def test_blobs_validaciones_y_limites(self):
        # Vacío o no-bytes
        with self.assertRaises(ValueError):
            zerochat.put_blob(b"")
        with self.assertRaises(ValueError):
            zerochat.put_blob("no es bytes")

        # ID inválido
        with self.assertRaises(ValueError):
            zerochat.put_blob(b"datos", blob_id="invalido")
        with self.assertRaises(ValueError):
            zerochat.put_blob(b"datos", blob_id="1" * 63)
        with self.assertRaises(ValueError):
            zerochat.put_blob(b"datos", blob_id="1" * 65)

        # ID no coincide con el hash
        with self.assertRaises(ValueError):
            zerochat.put_blob(b"datos", blob_id="a" * 64)

        # Borde exacto N y N+1 en MAX_BLOB_SIZE
        data_limit = b"x" * zerochat.MAX_BLOB_SIZE
        # N: se acepta con mock en memoria sin escribir a disco para no agotar espacio
        with mock.patch("zerochat.open_storage") as mock_open:
            mock_conn = mock.MagicMock()
            mock_open.return_value.__enter__.return_value = mock_conn
            res = zerochat.put_blob(data_limit)
            self.assertEqual(res["size"], zerochat.MAX_BLOB_SIZE)

        # N+1: se rechaza con ValueError
        class BigBytes(bytes):
            def __len__(self):
                return zerochat.MAX_BLOB_SIZE + 1

        with self.assertRaises(ValueError):
            zerochat.put_blob(BigBytes())

        # has_blobs límite de 1000 IDs
        valid_id = "f" * 64
        with self.assertRaises(ValueError):
            zerochat.has_blobs([valid_id] * 1001)

    def test_rpc_dispatch_blobs(self):
        import base64
        handler = object.__new__(zerochat.ZeroChatServerHandler)
        raw = b"png-binary-content-test"
        b64 = base64.b64encode(raw).decode("ascii")
        expected_id = zerochat.hashlib.sha256(raw).hexdigest()

        # zerochat/blobs/put
        res, err, _ = handler._dispatch_local("zerochat/blobs/put", {
            "mimeType": "image/png",
            "data": f"data:image/png;base64,{b64}"
        })
        self.assertIsNone(err)
        self.assertEqual(res["id"], expected_id)
        self.assertEqual(res["mimeType"], "image/png")
        self.assertEqual(res["size"], len(raw))

        # zerochat/blobs/get
        res, err, _ = handler._dispatch_local("zerochat/blobs/get", {"id": expected_id})
        self.assertIsNone(err)
        self.assertEqual(res["blob"]["id"], expected_id)
        self.assertEqual(res["blob"]["data"], b64)

        # zerochat/blobs/has
        res, err, _ = handler._dispatch_local("zerochat/blobs/has", {"ids": [expected_id, "0" * 64]})
        self.assertIsNone(err)
        self.assertEqual(res["existing"], [expected_id])
        self.assertEqual(res["missing"], ["0" * 64])

        # Error en put sin data
        res, err, _ = handler._dispatch_local("zerochat/blobs/put", {})
        self.assertEqual(err["code"], -32602)
