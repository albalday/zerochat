import os
import sqlite3
import stat
import unittest
from unittest import mock
from backend import use_data_dir, zerochat


class StorageEngineTest(unittest.TestCase):
    def setUp(self):
        self.data_dir = use_data_dir(self)
        self.storage_dir = self.data_dir / "storage"
        self.db_path = self.storage_dir / "zerochat.db"

    def test_inicializacion_permisos_y_migracion_a_base_existente(self):
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
        # Una clave guardada en claro antes de la migración 7.
        conn.execute("INSERT INTO profiles (id, name, settings_json, api_key, created_at, updated_at) "
                     "VALUES ('profile:viejo', 'Viejo', '{\"model\":\"gpt-4\",\"mcpServers\":[\"memory\"],\"playwrightBrowser\":{\"mode\":\"own\",\"engine\":\"chromium\"}}', 'sk-en-claro', 1, 1);")
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

        # Al abrir con zerochat.open_storage, se deben aplicar todas las migraciones sin errores y fijar permisos 0700/0600
        with zerochat.open_storage() as conn:
            tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table';").fetchall()}
            migrations = {row["version"] for row in conn.execute("SELECT version FROM schema_migrations;").fetchall()}
            columns = {row["name"] for row in conn.execute("PRAGMA table_info(conversations);").fetchall()}
            stored_key = conn.execute("SELECT api_key FROM profiles WHERE id = 'profile:viejo';").fetchone()["api_key"]
        for expected_table in ("schema_migrations", "profiles", "conversations", "messages", "blobs", "conversation_blobs", "security_policies", "project_environments", "settings", "runs"):
            self.assertIn(expected_table, tables)
        self.assertEqual(migrations, {1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14})
        self.assertIn("extra_json", columns)
        if os.name != "nt":
            self.assertEqual(stat.S_IMODE(self.storage_dir.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(self.db_path.stat().st_mode), 0o600)
            # SQLite puede borrar -wal/-shm entre procesos concurrentes mientras se aseguran permisos.
            wal_path = self.db_path.with_name(self.db_path.name + "-wal")
            wal_path.write_bytes(b"")
            orig_chmod = type(wal_path).chmod

            def unlink_wal_then_chmod(path, mode):
                if path == wal_path:
                    path.unlink(missing_ok=True)
                return orig_chmod(path, mode)

            with mock.patch.object(type(wal_path), "chmod", unlink_wal_then_chmod):
                with zerochat.open_storage():
                    pass
        # La 7 ofusca la clave que estaba en claro y la 9 retira mcpServers/playwrightBrowser de los perfiles.
        self.assertNotIn("sk-en-claro", stored_key)
        migrated_profile = zerochat.get_general_profile_with_key("profile:viejo")
        self.assertEqual(migrated_profile["settings"]["apiKey"], "sk-en-claro")
        self.assertNotIn("mcpServers", migrated_profile["settings"])
        self.assertNotIn("playwrightBrowser", migrated_profile["settings"])

        # list_conversations y save_conversation funcionan correctamente tras la migración
        saved = zerochat.save_conversation({
            "id": "migrated_conv_1",
            "title": "Migrada con éxito",
            "profileId": "deepseek"
        }, [{"id": "m1", "role": "user", "content": "hola"}])
        self.assertEqual(saved["profileId"], "deepseek")
        listed = zerochat.list_conversations()
        self.assertTrue(any(c["id"] == "migrated_conv_1" and c["profileId"] == "deepseek" for c in listed))

    def test_guardar_listar_recuperar_actualizar_y_borrar_perfil_general(self):
        first_id = zerochat.get_server_id()
        self.assertTrue(first_id)
        self.assertEqual(zerochat.get_server_id(), first_id)
        self.assertEqual(zerochat.live_state(zerochat.project_context())["serverId"], first_id)

        sample = {
            "name": "OpenAI GPT-4o",
            "description": "Perfil de prueba en backend",
            "updatedAt": 1700000123456,
            "settings": {
                "apiUrl": "https://api.openai.com/v1",
                "apiType": "openai",
                "model": "gpt-4o",
                "apiKey": "sk-secret-12345678"
            }
        }
        saved = zerochat.save_general_profile(sample)
        self.assertEqual(saved["id"], "profile:OpenAI%20GPT-4o")
        self.assertEqual(saved["name"], "OpenAI GPT-4o")
        self.assertEqual(saved["updatedAt"], 1700000123456)
        self.assertTrue(saved["general"])
        # Ni lo guardado ni el listado ni la búsqueda llevan la clave: solo hasApiKey.
        listed = zerochat.list_general_profiles()
        found_by_id = zerochat.get_general_profile(saved["id"])
        for profile in (saved, listed[0], found_by_id):
            self.assertNotIn("apiKey", profile["settings"])
            self.assertTrue(profile["hasApiKey"])
        self.assertEqual(len(listed), 1)
        self.assertEqual(zerochat.get_general_profile_with_key(saved["id"])["settings"]["apiKey"], "sk-secret-12345678")
        self.assertIsNone(zerochat.get_general_profile_with_key("inexistente"))
        # En disco va ofuscada: el texto de la clave no aparece en la base de datos.
        with zerochat.open_storage() as conn:
            stored = conn.execute("SELECT api_key FROM profiles WHERE id = ?;", (saved["id"],)).fetchone()["api_key"]
        self.assertTrue(stored.startswith(zerochat.OBFUSCATION_PREFIX))
        self.assertNotIn("sk-secret", stored)

        by_name = zerochat.get_general_profile_by_name("OpenAI GPT-4o")
        self.assertIsNotNone(by_name)
        self.assertEqual(by_name["id"], saved["id"])

        # Actualizar sin enviar apiKey conserva la existente; enviar "" la vacía
        updated = zerochat.save_general_profile({**saved, "updatedAt": 1700000999000, "description": "Descripción actualizada", "settings": {"model": "gpt-4.1"}})
        self.assertEqual(updated["version"], 2)
        self.assertEqual(updated["updatedAt"], 1700000999000)
        self.assertEqual(updated["description"], "Descripción actualizada")
        self.assertEqual(zerochat.get_general_profile_with_key(saved["id"])["settings"]["apiKey"], "sk-secret-12345678")

        cleared_key = zerochat.save_general_profile({**updated, "settings": {"model": "gpt-4.1", "apiKey": ""}})
        self.assertFalse(cleared_key["hasApiKey"])
        self.assertEqual(zerochat.get_general_profile_with_key(saved["id"])["settings"]["apiKey"], "")

        self.assertTrue(zerochat.delete_general_profile(saved["id"]))
        self.assertEqual(len(zerochat.list_general_profiles()), 0)
        self.assertFalse(zerochat.delete_general_profile("inexistente"))

    def test_validacion_bordes_duplicados_espejo_y_bloqueo(self):
        for bad_ts in (0, -5, "123", True):
            with self.subTest(bad_ts=bad_ts):
                with self.assertRaises(ValueError):
                    zerochat.save_general_profile({"name": "Bad TS", "updatedAt": bad_ts, "settings": {}})
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
        payload = {
            "name": "Claude Sonnet",
            "description": "Perfil general via RPC",
            "settings": {"apiUrl": "https://api.anthropic.com/v1", "model": "claude-3-5-sonnet", "apiKey": "sk-ant-test"}
        }
        res, err, _ = zerochat.dispatch_profiles("zerochat/profiles/save", {"profile": payload})
        self.assertIsNone(err)
        self.assertEqual(res["profile"]["name"], "Claude Sonnet")
        prof_id = res["profile"]["id"]

        res, err, _ = zerochat.dispatch_profiles("zerochat/profiles/list", {})
        self.assertIsNone(err)
        self.assertEqual(len(res["profiles"]), 1)
        self.assertNotIn("apiKey", res["profiles"][0]["settings"])
        self.assertTrue(res["profiles"][0]["hasApiKey"])

        # Solo reveal, que se usa al pulsar Editar, entrega la clave a la interfaz, y lo deja en el registro.
        with mock.patch.object(zerochat, "log_event") as logged:
            res, err, _ = zerochat.dispatch_profiles("zerochat/profiles/reveal", {"id": prof_id})
        self.assertIsNone(err)
        self.assertEqual(res["profile"]["settings"]["apiKey"], "sk-ant-test")
        self.assertIn("Claude Sonnet", logged.call_args.args[0])
        _, err, _ = zerochat.dispatch_profiles("zerochat/profiles/reveal", {"id": "profile:inexistente"})
        self.assertEqual(err["code"], zerochat.INVALID_PARAMS)

        res, err, _ = zerochat.dispatch_profiles("zerochat/profiles/delete", {"id": prof_id})
        self.assertIsNone(err)
        self.assertTrue(res["deleted"])

    def test_rpc_dispatch_conversations_crud(self):
        # 1. Guardar conversación mediante dispatch_local
        payload1 = {
            "conversation": {"id": "rpc_conv_1", "title": "Conversación RPC", "createdAt": 1700000000000, "updatedAt": 1700000001000},
            "messages": [{"id": "m1", "role": "user", "content": "Hola desde RPC"}]
        }
        res, err, _ = zerochat.dispatch_local("zerochat/conversations/save", payload1, zerochat.project_context())
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
        res, err, _ = zerochat.dispatch_conversations("zerochat/conversations/save", payload2)
        self.assertIsNone(err)
        self.assertEqual(res["conversation"]["id"], "rpc_conv_2")
        self.assertEqual(res["conversation"]["messageCount"], 1)

        # 3. Listar conversaciones
        res, err, _ = zerochat.dispatch_local("zerochat/conversations/list", {}, zerochat.project_context())
        self.assertIsNone(err)
        self.assertEqual(len(res["conversations"]), 2)
        self.assertEqual(res["conversations"][0]["id"], "rpc_conv_2")

        # 4. Obtener conversación completa por id
        res, err, _ = zerochat.dispatch_local("zerochat/conversations/get", {"id": "rpc_conv_1"}, zerochat.project_context())
        self.assertIsNone(err)
        self.assertIsNotNone(res["conversation"])
        self.assertEqual(res["conversation"]["id"], "rpc_conv_1")
        self.assertEqual(len(res["conversation"]["history"]), 1)
        self.assertEqual(res["conversation"]["history"][0]["content"], "Hola desde RPC")

        res_inexist, err_inexist, _ = zerochat.dispatch_conversations("zerochat/conversations/get", {"id": "inexistente"})
        self.assertIsNone(err_inexist)
        self.assertIsNone(res_inexist["conversation"])

        # 5. Renombrar conversación
        res, err, _ = zerochat.dispatch_local("zerochat/conversations/rename", {"id": "rpc_conv_1", "title": "Título Modificado"}, zerochat.project_context())
        self.assertIsNone(err)
        self.assertTrue(res["renamed"])
        self.assertIsInstance(res.get("updatedAt"), int)

        res_get, _, _ = zerochat.dispatch_conversations("zerochat/conversations/get", {"id": "rpc_conv_1"})
        self.assertEqual(res_get["conversation"]["title"], "Título Modificado")
        self.assertEqual(res_get["conversation"]["updatedAt"], res["updatedAt"])

        res_ren_inexist, err, _ = zerochat.dispatch_conversations("zerochat/conversations/rename", {"id": "inexistente", "title": "Nuevo"})
        self.assertIsNone(err)
        self.assertFalse(res_ren_inexist["renamed"])

        # 6. Borrar una conversación
        res, err, _ = zerochat.dispatch_local("zerochat/conversations/delete", {"id": "rpc_conv_1"}, zerochat.project_context())
        self.assertIsNone(err)
        self.assertTrue(res["deleted"])

        res_del_inexist, err, _ = zerochat.dispatch_conversations("zerochat/conversations/delete", {"id": "rpc_conv_1"})
        self.assertIsNone(err)
        self.assertFalse(res_del_inexist["deleted"])

        # 7. Borrar todos los chats
        res, err, _ = zerochat.dispatch_conversations("zerochat/conversations/delete", {"all": True, "agents": False})
        self.assertIsNone(err)
        self.assertTrue(res["deleted"])
        self.assertEqual(res["count"], 1)

        res_empty, _, _ = zerochat.dispatch_conversations("zerochat/conversations/list", {})
        self.assertEqual(len(res_empty["conversations"]), 0)

    def test_rpc_dispatch_conversations_validaciones(self):
        # get: id vacío o ausente (-32602)
        for bad_id in ({}, {"id": ""}, {"id": "   "}, {"id": 123}):
            with self.subTest(bad_id=bad_id):
                _, err, _ = zerochat.dispatch_conversations("zerochat/conversations/get", bad_id)
                self.assertIsNotNone(err)
                self.assertEqual(err["code"], -32602)

        # save: conversation no objeto o ausente (-32602)
        for bad_conv in ({}, {"conversation": None}, {"conversation": "no-dict"}):
            with self.subTest(bad_conv=bad_conv):
                _, err, _ = zerochat.dispatch_conversations("zerochat/conversations/save", bad_conv)
                self.assertIsNotNone(err)
                self.assertEqual(err["code"], -32602)

        # save: messages no lista (-32602)
        _, err, _ = zerochat.dispatch_conversations("zerochat/conversations/save", {"conversation": {"id": "x"}, "messages": "no-lista"})
        self.assertIsNotNone(err)
        self.assertEqual(err["code"], -32602)

        # save: límite de título N+1 (-32602)
        _, err, _ = zerochat.dispatch_conversations("zerochat/conversations/save", {
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
                _, err, _ = zerochat.dispatch_conversations("zerochat/conversations/rename", bad_rename)
                self.assertIsNotNone(err)
                self.assertEqual(err["code"], -32602)

        # rename: título N+1 (-32602)
        _, err, _ = zerochat.dispatch_conversations("zerochat/conversations/rename", {
            "id": "x",
            "title": "t" * (zerochat.MAX_CONVERSATION_TITLE_LENGTH + 1)
        })
        self.assertIsNotNone(err)
        self.assertEqual(err["code"], -32602)

        # delete: id vacío sin all=True (-32602)
        # En bloque exige el historial (agents): nunca borra chats y agentes a la vez.
        for bad_delete in ({}, {"id": ""}, {"id": "   "}, {"id": 123}, {"all": True}, {"project": "/p"}, {"all": True, "agents": "si"}):
            with self.subTest(bad_delete=bad_delete):
                _, err, _ = zerochat.dispatch_conversations("zerochat/conversations/delete", bad_delete)
                self.assertIsNotNone(err)
                self.assertEqual(err["code"], -32602)

        # método no soportado (-32601)
        _, err, _ = zerochat.dispatch_conversations("zerochat/conversations/desconocido", {})
        self.assertIsNotNone(err)
        self.assertEqual(err["code"], -32601)

    def test_cli_resolucion_perfiles(self):
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

        args = parser.parse_args(["--prompt", "Hola", "--profile", "DeepSeek"])
        session = zerochat.run_session_from_args(parser, args)
        self.assertIsNotNone(session)
        self.assertEqual(session.profile, "DeepSeek")

        args_unknown = parser.parse_args(["--prompt", "Hola", "--profile", "Desconocido"])
        session_unknown = zerochat.run_session_from_args(parser, args_unknown)
        self.assertEqual(session_unknown.profile, "Desconocido")

    def test_guardar_listar_recuperar_actualizar_renombrar_y_borrar_conversacion(self):
        meta = {
            "id": "session_test_123",
            "title": "Conversación de prueba",
            "createdAt": 1700000000000,
            "updatedAt": 1700000001000,
            "profileId": "deepseek",
            "serverRun": True
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

        retrieved = zerochat.get_conversation("session_test_123")
        self.assertIsNotNone(retrieved)
        self.assertEqual(retrieved["id"], "session_test_123")
        self.assertEqual(retrieved["title"], "Conversación de prueba")

        # Una petición externa de conversations/save no puede fijar agent
        res_ext, err_ext, _ = zerochat.dispatch_conversations("zerochat/conversations/save", {
            "conversation": {"id": "conv_ext_no_agent", "title": "General", "agent": "suplantado"},
            "messages": [{"id": "u1", "role": "user", "content": "hola"}],
        })
        self.assertIsNone(err_ext)
        self.assertNotIn("agent", res_ext["conversation"])
        zerochat.delete_conversation("conv_ext_no_agent")
        self.assertEqual(retrieved["profileId"], "deepseek")
        self.assertEqual(retrieved["serverRun"], True)
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

        # Actualizar mensajes de una conversación existente con metadatos mínimos preserva profileId y serverRun
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
        self.assertEqual(len(zerochat.get_conversation("session_test_123")["history"]), 3)

        # El proyecto se fija al crear la conversación (también en general) y no cambia al guardar desde otro proyecto
        self.assertNotIn("project", zerochat.save_conversation({"id": "session_test_123", "project": "/repo/a"}, new_messages))
        with_project = zerochat.save_conversation({"id": "session_proj_a", "project": "/repo/a"}, new_messages)
        self.assertEqual(with_project["project"], "/repo/a")
        moved = zerochat.save_conversation({"id": "session_proj_a", "project": "/repo/b"}, new_messages)
        self.assertEqual(moved["project"], "/repo/a")
        zerochat.delete_conversation("session_proj_a")
        with self.assertRaises(ValueError):
            zerochat.save_conversation({"id": "session_test_123", "project": ["/repo"]}, new_messages)

        # El agente solo se fija al crear la conversación: no se añade a una existente, ni cambia ni se quita después.
        self.assertNotIn("agent", zerochat.save_conversation({"id": "session_test_123", "agent": "informes.diario"}, new_messages))
        agent_conv = zerochat.save_conversation({"id": "session_agente", "agent": "informes.diario"}, new_messages)
        self.assertEqual(agent_conv["agent"], "informes.diario")
        self.assertEqual(zerochat.save_conversation({"id": "session_agente", "agent": "informes.semanal"}, new_messages)["agent"], "informes.diario")
        self.assertEqual(zerochat.save_conversation({"id": "session_agente"}, new_messages)["agent"], "informes.diario")
        self.assertEqual(next(c for c in zerochat.list_conversations() if c["id"] == "session_agente")["agent"], "informes.diario")
        # Formato <nombre> o <subconjunto>.<nombre> con tope en el borde exacto: MAX_AGENT_ID_LENGTH caracteres sí y uno más no.
        for at_limit in ("a." + "b" * (zerochat.MAX_AGENT_ID_LENGTH - 2), "b" * zerochat.MAX_AGENT_ID_LENGTH):
            self.assertEqual(zerochat.validate_agent_id(at_limit), at_limit)
            with self.assertRaisesRegex(ValueError, "agent debe ser"):
                zerochat.validate_agent_id(at_limit + "b")
        self.assertEqual(zerochat.validate_agent_id("informes"), "informes")
        for invalid in ("a.b.c", "Informes.diario", "informes.", ".diario", "inf ormes.d", "", 3):
            with self.assertRaisesRegex(ValueError, "agent debe ser"):
                zerochat.save_conversation({"id": "session_agente_mal", "agent": invalid}, new_messages)
        self.assertTrue(zerochat.delete_conversation("session_agente"))

        # Desactivar explícitamente serverRun lo actualiza sin borrar profileId
        toggled = zerochat.save_conversation({"id": "session_test_123", "serverRun": False}, new_messages)
        self.assertEqual(toggled["serverRun"], False)
        self.assertEqual(toggled["profileId"], "deepseek")

        # Borrar conversación y verificar borrado en cascada en la tabla messages
        with zerochat.open_storage() as conn:
            self.assertGreater(conn.execute("SELECT COUNT(*) FROM messages WHERE conversation_id = 'session_test_123';").fetchone()[0], 0)

        self.assertTrue(zerochat.delete_conversation("session_test_123"))
        self.assertIsNone(zerochat.get_conversation("session_test_123"))
        self.assertFalse(zerochat.delete_conversation("session_test_123"))

        with zerochat.open_storage() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM messages WHERE conversation_id = 'session_test_123';").fetchone()[0], 0)

        # Borrar todo
        self.assertEqual(len(zerochat.delete_conversations(None, False)), 1)
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

    def test_blobs_crud_deduplicacion_y_limites(self):
        import base64
        data1 = b"Hello, ZeroChat Blob Storage!"
        sha1 = zerochat.hashlib.sha256(data1).hexdigest()

        # put_blob calcula el hash SHA-256 y re-guardar mismos datos es idempotente
        saved1 = zerochat.put_blob(data1, mime_type="text/plain")
        self.assertEqual((saved1["id"], saved1["mime_type"], saved1["size"]), (sha1, "text/plain", len(data1)))
        self.assertEqual(zerochat.put_blob(data1, mime_type="text/plain", blob_id=sha1)["id"], sha1)

        # get_blob y has_blobs
        retrieved = zerochat.get_blob(sha1)
        self.assertEqual((retrieved["id"], retrieved["mime_type"], retrieved["size"], retrieved["data"]),
                         (sha1, "text/plain", len(data1), data1))
        fake_id = "0" * 64
        self.assertEqual(zerochat.has_blobs([sha1, fake_id]), {"existing": [sha1], "missing": [fake_id]})

        # Validaciones y borde exacto N y N+1 en MAX_BLOB_SIZE
        for bad_data, bad_id in ((b"", None), ("no es bytes", None), (b"datos", "invalido"),
                                 (b"datos", "1" * 63), (b"datos", "1" * 65), (b"datos", "a" * 64)):
            with self.subTest(bad_id=bad_id), self.assertRaises(ValueError):
                zerochat.put_blob(bad_data, blob_id=bad_id)

        data_limit = b"x" * zerochat.MAX_BLOB_SIZE
        with mock.patch("zerochat.open_storage") as mock_open:
            mock_open.return_value.__enter__.return_value = mock.MagicMock()
            self.assertEqual(zerochat.put_blob(data_limit)["size"], zerochat.MAX_BLOB_SIZE)

        class BigBytes(bytes):
            def __len__(self):
                return zerochat.MAX_BLOB_SIZE + 1

        with self.assertRaises(ValueError):
            zerochat.put_blob(BigBytes())
        with self.assertRaises(ValueError):
            zerochat.has_blobs(["f" * 64] * 1001)

        # RPC zerochat/blobs/*
        raw = b"png-binary-content-test"
        b64 = base64.b64encode(raw).decode("ascii")
        expected_id = zerochat.hashlib.sha256(raw).hexdigest()
        res, err, _ = zerochat.dispatch_local("zerochat/blobs/put", {"mimeType": "image/png", "data": f"data:image/png;base64,{b64}"}, zerochat.project_context())
        self.assertIsNone(err)
        self.assertEqual((res["id"], res["mimeType"], res["size"]), (expected_id, "image/png", len(raw)))
        res, err, _ = zerochat.dispatch_local("zerochat/blobs/get", {"id": expected_id}, zerochat.project_context())
        self.assertIsNone(err)
        self.assertEqual((res["blob"]["id"], res["blob"]["data"]), (expected_id, b64))
        res, err, _ = zerochat.dispatch_local("zerochat/blobs/has", {"ids": [expected_id, "0" * 64]}, zerochat.project_context())
        self.assertEqual((err, res["existing"], res["missing"]), (None, [expected_id], ["0" * 64]))
        self.assertEqual(zerochat.dispatch_local("zerochat/blobs/put", {}, zerochat.project_context())[1]["code"], -32602)

    def test_borrar_o_actualizar_conversaciones_borra_los_blobs_que_quedan_sin_referencia(self):
        def blob(data):
            return zerochat.put_blob(data, mime_type="image/png")["id"]

        def save(conv_id, blob_ids, project=None):
            meta = {"id": conv_id, "title": conv_id, **({"project": project} if project else {})}
            images = [{"blobId": blob_id, "mimeType": "image/png"} for blob_id in blob_ids]
            zerochat.save_conversation(meta, [{"id": "m1", "role": "user", "content": "x", "images": images}])

        own, shared, pending = blob(b"propia"), blob(b"compartida"), blob(b"subida sin guardar")
        save("conv_a", [own, shared])
        save("conv_b", [shared])
        # Al guardar quitando las imágenes de una conversación, desaparece el blob propio y se conserva el compartido.
        save("conv_a", [shared])
        self.assertIsNone(zerochat.get_blob(own))
        self.assertIsNotNone(zerochat.get_blob(shared))

        own2 = blob(b"propia-2")
        save("conv_a", [own2, shared])
        # Borrar una conversación borra el blob que solo ella usaba y conserva el compartido y el pendiente.
        self.assertTrue(zerochat.delete_conversation("conv_a"))
        self.assertIsNone(zerochat.get_blob(own2))
        self.assertIsNotNone(zerochat.get_blob(shared))
        self.assertIsNotNone(zerochat.get_blob(pending))

        project_blob = blob(b"del proyecto")
        save("conv_p", [project_blob, shared], project="/proj")
        self.assertEqual(zerochat.delete_conversations("/proj", False), ["conv_p"])
        self.assertIsNone(zerochat.get_blob(project_blob))
        self.assertIsNotNone(zerochat.get_blob(shared))

        save("conv_keep", [shared], project="/keep")
        self.assertEqual(zerochat.delete_conversations("", False), ["conv_b"])
        self.assertIsNotNone(zerochat.get_blob(shared))

        self.assertEqual(len(zerochat.delete_conversations(None, False)), 1)
        self.assertIsNone(zerochat.get_blob(shared))
        self.assertIsNotNone(zerochat.get_blob(pending))

    def test_conversations_revision_cambia_al_guardar_renombrar_y_borrar(self):
        rev0 = zerochat.conversations_revision()
        self.assertEqual(zerochat.live_state(zerochat.project_context())["conversations_rev"], rev0)
        zerochat.save_conversation({"id": "conv_rev_1", "title": "Primera", "updatedAt": 1000}, [{"id": "m1", "role": "user", "content": "hola"}])
        rev1 = zerochat.conversations_revision()
        self.assertNotEqual(rev1, rev0)
        zerochat.rename_conversation("conv_rev_1", "Renombrada")
        rev2 = zerochat.conversations_revision()
        self.assertNotEqual(rev2, rev1)
        zerochat.delete_conversation("conv_rev_1")
        rev3 = zerochat.conversations_revision()
        self.assertNotEqual(rev3, rev2)

    def test_guardado_por_tramos_y_topes_temporales(self):
        zerochat._PENDING_CONVERSATION_UPLOADS.clear()
        self.addCleanup(zerochat._PENDING_CONVERSATION_UPLOADS.clear)

        # 1. Tramos de mensajes + mensaje partido con emojis se consolidan atómicamente en SQLite.
        uid = "upload_ok_1"
        res, err, _ = zerochat.dispatch_conversations("zerochat/conversations/save_chunk", {
            "uploadId": uid,
            "conversationId": "conv_chunked_1",
            "chunkIndex": 0,
            "totalChunks": 3,
            "messages": [{"id": "m1", "role": "user", "content": "Inicio"}],
        })
        self.assertIsNone(err)
        self.assertEqual(res["receivedChunks"], 1)

        res, err, _ = zerochat.dispatch_conversations("zerochat/conversations/save_chunk", {
            "uploadId": uid,
            "conversationId": "conv_chunked_1",
            "chunkIndex": 1,
            "totalChunks": 3,
            "messagePart": {
                "partIndex": 0,
                "totalParts": 2,
                "content": "Parte 1 🚀 ",
                "message": {"id": "m2", "role": "assistant", "content": "", "tool_calls": [{"id": "tc1"}]},
            },
        })
        self.assertIsNone(err)
        res, err, _ = zerochat.dispatch_conversations("zerochat/conversations/save_chunk", {
            "uploadId": uid,
            "conversationId": "conv_chunked_1",
            "chunkIndex": 2,
            "totalChunks": 3,
            "messagePart": {"partIndex": 1, "totalParts": 2, "content": "Parte 2"},
        })
        self.assertIsNone(err)

        # Antes del commit final no existe en SQLite.
        self.assertIsNone(zerochat.get_conversation("conv_chunked_1"))
        res, err, _ = zerochat.dispatch_conversations("zerochat/conversations/save", {
            "conversation": {"id": "conv_chunked_1", "title": "Por tramos"},
            "uploadId": uid,
        })
        self.assertIsNone(err)
        self.assertEqual(res["conversation"]["messageCount"], 2)
        saved = zerochat.get_conversation("conv_chunked_1")
        self.assertEqual(saved["history"][1]["content"], "Parte 1 🚀 Parte 2")
        self.assertEqual(saved["history"][1]["tool_calls"], [{"id": "tc1"}])
        self.assertEqual(len(zerochat._PENDING_CONVERSATION_UPLOADS), 0)

        # 2. Errores de protocolo (incompleta, fuera de orden, mezcla uploadId+messages) devuelven -32602.
        _, err, _ = zerochat.dispatch_conversations("zerochat/conversations/save_chunk", {
            "uploadId": "upload_inc", "conversationId": "conv_inc", "chunkIndex": 0, "totalChunks": 2,
            "messages": [{"id": "mi1", "role": "user", "content": "a"}],
        })
        self.assertIsNone(err)
        _, err, _ = zerochat.dispatch_conversations("zerochat/conversations/save", {
            "conversation": {"id": "conv_inc", "title": "Incompleta"},
            "uploadId": "upload_inc",
        })
        self.assertEqual(err["code"], -32602)
        self.assertIsNone(zerochat.get_conversation("conv_inc"))

        _, err, _ = zerochat.dispatch_conversations("zerochat/conversations/save", {
            "conversation": {"id": "conv_inc", "title": "Mezcla"},
            "uploadId": "upload_inc",
            "messages": [],
        })
        self.assertEqual(err["code"], -32602)

        # Cancelar libera la subida pendiente, solo si coincide su conversación.
        cancel = {"uploadId": "upload_inc", "conversationId": "otra_conv"}
        res, err, _ = zerochat.dispatch_conversations("zerochat/conversations/cancel_upload", cancel)
        self.assertEqual((err, res), (None, {"cancelled": False}))
        self.assertIn("upload_inc", zerochat._PENDING_CONVERSATION_UPLOADS)
        res, err, _ = zerochat.dispatch_conversations("zerochat/conversations/cancel_upload", {**cancel, "conversationId": "conv_inc"})
        self.assertEqual((err, res), (None, {"cancelled": True}))
        self.assertNotIn("upload_inc", zerochat._PENDING_CONVERSATION_UPLOADS)

        # 3. Topes exactos N y N+1: MAX_CONVERSATION_UPLOAD_CHUNKS, MAX_PENDING_CONVERSATION_UPLOADS y MAX_STAGED_CONVERSATION_BYTES.
        zerochat._PENDING_CONVERSATION_UPLOADS.clear()
        _, err, _ = zerochat.dispatch_conversations("zerochat/conversations/save_chunk", {
            "uploadId": "upload_chunks_ok", "conversationId": "c_chunks",
            "chunkIndex": 0, "totalChunks": zerochat.MAX_CONVERSATION_UPLOAD_CHUNKS,
            "messages": [],
        })
        self.assertIsNone(err)
        _, err, _ = zerochat.dispatch_conversations("zerochat/conversations/save_chunk", {
            "uploadId": "upload_chunks_over", "conversationId": "c_chunks",
            "chunkIndex": 0, "totalChunks": zerochat.MAX_CONVERSATION_UPLOAD_CHUNKS + 1,
            "messages": [],
        })
        self.assertEqual(err["code"], -32602)

        zerochat._PENDING_CONVERSATION_UPLOADS.clear()
        for idx in range(zerochat.MAX_PENDING_CONVERSATION_UPLOADS):
            _, err, _ = zerochat.dispatch_conversations("zerochat/conversations/save_chunk", {
                "uploadId": f"up_{idx}", "conversationId": f"c_{idx}",
                "chunkIndex": 0, "totalChunks": 2, "messages": [],
            })
            self.assertIsNone(err)
        _, err, _ = zerochat.dispatch_conversations("zerochat/conversations/save_chunk", {
            "uploadId": "up_overflow", "conversationId": "c_over",
            "chunkIndex": 0, "totalChunks": 2, "messages": [],
        })
        self.assertEqual(err["code"], -32602)

        # Al caducar el TTL se purgan las subidas viejas y entra una nueva.
        zerochat._PENDING_CONVERSATION_UPLOADS["up_0"]["updated_at"] -= zerochat.CONVERSATION_UPLOAD_TTL_SECONDS + 1
        _, err, _ = zerochat.dispatch_conversations("zerochat/conversations/save_chunk", {
            "uploadId": "up_reclaimed", "conversationId": "c_reclaimed",
            "chunkIndex": 0, "totalChunks": 2, "messages": [],
        })
        self.assertIsNone(err)

        zerochat._PENDING_CONVERSATION_UPLOADS.clear()
        with mock.patch.object(zerochat, "MAX_STAGED_CONVERSATION_BYTES", 64):
            _, err, _ = zerochat.dispatch_conversations("zerochat/conversations/save_chunk", {
                "uploadId": "up_bytes", "conversationId": "c_bytes",
                "chunkIndex": 0, "totalChunks": 2,
                "messages": [{"id": "1", "role": "user", "content": "x"}],
            })
            self.assertIsNone(err)
            _, err, _ = zerochat.dispatch_conversations("zerochat/conversations/save_chunk", {
                "uploadId": "up_bytes", "conversationId": "c_bytes",
                "chunkIndex": 1, "totalChunks": 2,
                "messages": [{"id": "2", "role": "user", "content": "y" * 64}],
            })
            self.assertEqual(err["code"], -32602)

    def test_entorno_por_proyecto_sqlite_y_rpc(self):
        project_a = self.data_dir / "proj_a"
        project_b = self.data_dir / "proj_b"
        project_a.mkdir()
        project_b.mkdir()
        ctx_a = zerochat.SecurityContext(workspace_dir=project_a.resolve())
        ctx_b = zerochat.SecurityContext(workspace_dir=project_b.resolve())
        ctx_general = zerochat.SecurityContext(workspace_dir=zerochat.get_no_project_dir().resolve())

        # Proyecto nuevo devuelve valores base sin fila persistida en SQLite.
        initial_a, err, _ = zerochat.dispatch_local("initialize", {}, ctx_a)
        self.assertIsNone(err)
        self.assertEqual(initial_a["projectEnvironment"]["saved"], False)
        self.assertEqual(initial_a["projectEnvironment"]["browser"], "browser_action")
        self.assertEqual(initial_a["projectEnvironment"]["mcpServers"], [])
        self.assertEqual(initial_a["projectEnvironment"]["activeRagBranchIds"], [])

        # Parche parcial en proyecto A y en general quedan aislados; otro parche parcial conserva el resto.
        res_a, err, _ = zerochat.dispatch_local("zerochat/project/environment/set", {
            "systemDataPrompt": "  Usa Python 3.  ",
            "enabledTools": {"search_web": False, "run_command": True},
            "mcpServers": [" memory ", "memory", "brave"],
            "browser": "playwright",
            "activeRagBranchIds": [" branch-1 ", "branch-1", "branch-2"],
        }, ctx_a)
        self.assertIsNone(err)
        env_a = res_a["projectEnvironment"]
        self.assertTrue(env_a["saved"])
        self.assertEqual(env_a["systemDataPrompt"], "Usa Python 3.")
        self.assertEqual(env_a["enabledTools"], {"search_web": False, "run_command": True})
        self.assertEqual(env_a["mcpServers"], ["memory", "brave"])
        self.assertEqual(env_a["browser"], "playwright")
        self.assertEqual(env_a["activeRagBranchIds"], ["branch-1", "branch-2"])

        # Actualizar solo browser conserva systemDataPrompt, enabledTools, mcpServers y activeRagBranchIds de A.
        updated_a, err, _ = zerochat.dispatch_local("zerochat/project/environment/set", {"browser": "none"}, ctx_a)
        self.assertIsNone(err)
        self.assertEqual(updated_a["projectEnvironment"]["systemDataPrompt"], "Usa Python 3.")
        self.assertEqual(updated_a["projectEnvironment"]["mcpServers"], ["memory", "brave"])
        self.assertEqual(updated_a["projectEnvironment"]["activeRagBranchIds"], ["branch-1", "branch-2"])
        self.assertEqual(updated_a["projectEnvironment"]["browser"], "none")

        # general usa su propia fila (get_no_project_dir) sin mezclarse con A ni B.
        _, err, _ = zerochat.dispatch_local("zerochat/project/environment/set", {"mcpServers": ["github"]}, ctx_general)
        self.assertIsNone(err)
        init_general, err, _ = zerochat.dispatch_local("initialize", {}, ctx_general)
        self.assertIsNone(err)
        self.assertEqual(init_general["projectEnvironment"]["mcpServers"], ["github"])

        # zerochat/project/set_directory entrega el entorno del nuevo proyecto (B vacío, A guardado).
        switched_b, err, _ = zerochat.dispatch_local("zerochat/project/set_directory", {"path": str(project_b)}, ctx_a)
        self.assertIsNone(err)
        self.assertEqual(switched_b["projectEnvironment"]["saved"], False)
        switched_a, err, _ = zerochat.dispatch_local("zerochat/project/set_directory", {"path": str(project_a)}, ctx_b)
        self.assertIsNone(err)
        self.assertEqual(switched_a["projectEnvironment"]["browser"], "none")
        self.assertEqual(switched_a["projectEnvironment"]["mcpServers"], ["memory", "brave"])

        # Topes en el borde exacto N / N+1 y rechazo de entradas inválidas.
        max_prompt = "x" * zerochat.MAX_PROJECT_PROMPT_LENGTH
        _, err, _ = zerochat.dispatch_local("zerochat/project/environment/set", {"systemDataPrompt": max_prompt}, ctx_b)
        self.assertIsNone(err)
        _, err, _ = zerochat.dispatch_local("zerochat/project/environment/set", {"systemDataPrompt": max_prompt + "x"}, ctx_b)
        self.assertEqual(err["code"], -32602)

        max_servers = [f"srv_{i}" for i in range(zerochat.MAX_PROJECT_MCP_SERVERS)]
        _, err, _ = zerochat.dispatch_local("zerochat/project/environment/set", {"mcpServers": max_servers}, ctx_b)
        self.assertIsNone(err)
        _, err, _ = zerochat.dispatch_local("zerochat/project/environment/set", {"mcpServers": [*max_servers, "extra"]}, ctx_b)
        self.assertEqual(err["code"], -32602)

        max_branches = [f"branch_{i}" for i in range(zerochat.MAX_PROJECT_RAG_BRANCHES)]
        _, err, _ = zerochat.dispatch_local("zerochat/project/environment/set", {"activeRagBranchIds": max_branches}, ctx_b)
        self.assertIsNone(err)
        _, err, _ = zerochat.dispatch_local("zerochat/project/environment/set", {"activeRagBranchIds": [*max_branches, "extra"]}, ctx_b)
        self.assertEqual(err["code"], -32602)

        max_tools = {f"tool_{i}": True for i in range(zerochat.MAX_PROJECT_ENABLED_TOOLS)}
        _, err, _ = zerochat.dispatch_local("zerochat/project/environment/set", {"enabledTools": max_tools}, ctx_b)
        self.assertIsNone(err)
        _, err, _ = zerochat.dispatch_local("zerochat/project/environment/set", {"enabledTools": {**max_tools, "tool_extra": False}}, ctx_b)
        self.assertEqual(err["code"], -32602)

        max_id = "t" * zerochat.MAX_PROJECT_TOOL_ID_LENGTH
        _, err, _ = zerochat.dispatch_local("zerochat/project/environment/set", {"enabledTools": {max_id: True}, "mcpServers": [max_id]}, ctx_b)
        self.assertIsNone(err)
        _, err, _ = zerochat.dispatch_local("zerochat/project/environment/set", {"enabledTools": {max_id + "x": True}}, ctx_b)
        self.assertEqual(err["code"], -32602)
        _, err, _ = zerochat.dispatch_local("zerochat/project/environment/set", {"mcpServers": [max_id + "x"]}, ctx_b)
        self.assertEqual(err["code"], -32602)

        for invalid in (
            {"unknownField": 1},
            {"browser": "chrome"},
            {"enabledTools": {"bad": "yes"}},
            {"mcpServers": ["ok", ""]},
        ):
            _, err, _ = zerochat.dispatch_local("zerochat/project/environment/set", invalid, ctx_b)
            self.assertEqual(err["code"], -32602, invalid)

        # JSON corrupto en SQLite falla explícitamente sin devolver valores por defecto.
        with zerochat.open_storage() as conn:
            conn.execute("UPDATE project_environments SET config_json = '{corrupt' WHERE project_key = ?;", (ctx_a.key,))
            conn.commit()
        with self.assertRaisesRegex(RuntimeError, "corrupto"):
            zerochat.get_project_environment(ctx_a.key)
