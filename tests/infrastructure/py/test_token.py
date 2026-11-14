import json
import os
import stat
import unittest
from unittest import mock

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

    def test_con_el_servidor_en_marcha_el_token_del_dia_anterior_se_rechaza_y_se_genera_el_nuevo(self):
        old = "x" * 43
        with mock.patch.multiple(zerochat, SESSION_TOKEN=old, SESSION_TOKEN_DATE="2000-01-01", ACTIVE_HOST="127.0.0.1", ACTIVE_PORT=6388):
            handler = object.__new__(zerochat.ZeroChatServerHandler)
            handler.headers = {"X-ZeroChat-Token": old}
            self.assertFalse(handler.verify_token())
            token = json.loads(self.token_file.read_text(encoding="utf-8"))["token"]
            self.assertNotEqual(token, old)
            # Tras el proxy inverso, Authorization lleva la clave del proxy y el token va en X-ZeroChat-Token.
            handler.headers = {"X-ZeroChat-Token": token, "Authorization": "Bearer clave-del-proxy"}
            self.assertTrue(handler.verify_token())
            handler.headers = {"Authorization": f"Bearer {token}"}
            self.assertTrue(handler.verify_token())
            # La consola abre el navegador con el token vigente, no con el del arranque.
            self.assertIn(f"#token={token}&", zerochat.launch_url("http://127.0.0.1:6388/zerochat.html"))

    def test_runner_token_acota_metodos_y_conversacion_y_se_revoca(self):
        runner_token = zerochat.issue_runner_token("run-1", conversation_id="conv-1")
        grant = zerochat.resolve_token(runner_token)
        self.assertIsNotNone(grant)
        self.assertEqual(grant.kind, "runner")
        self.assertTrue(grant.allows("/mcp", "tools/call", {"name": "read_file"}))
        self.assertTrue(grant.allows("/mcp", "zerochat/run/prompt", {}))
        self.assertTrue(grant.allows("/mcp", "zerochat/sandbox/execute", {"code": "1+1"}))
        self.assertTrue(grant.allows("/mcp", "zerochat/conversations/get", {"id": "conv-1"}))
        self.assertTrue(grant.allows("/mcp", "zerochat/conversations/save", {"conversation": {"id": "conv-1"}}))
        self.assertFalse(grant.allows("/mcp", "zerochat/conversations/get", {"id": "conv-2"}))
        self.assertFalse(grant.allows("/mcp", "zerochat/conversations/list", {}))
        self.assertFalse(grant.allows("/mcp", "zerochat/security/policies", {}))
        self.assertFalse(grant.allows("/mcp", "zerochat/profiles/list", {}))
        self.assertFalse(grant.allows("/mcp", "zerochat/blobs/put", {}))

        zerochat.revoke_token(runner_token)
        self.assertIsNone(zerochat.resolve_token(runner_token))

    def test_tool_decision_allow_once_autoriza_una_sola_invocacion(self):
        controller = zerochat.AccessController()
        ctx = zerochat.SecurityContext(self.config_dir)
        controller.apply_tool_decision({"toolName": "run_command", "decision": "allow_once"}, ctx)
        first = controller.evaluate_authorization("run_command", {"command": "echo hi"}, ctx)
        self.assertTrue(first.allowed)
        second = controller.evaluate_authorization("run_command", {"command": "echo hi"}, ctx)
        self.assertFalse(second.allowed)
        self.assertTrue(second.requires_approval)
