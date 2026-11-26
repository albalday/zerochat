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

    def test_el_token_diario_es_estable_y_con_el_servidor_en_marcha_el_del_dia_anterior_se_renueva(self):
        token = zerochat.get_daily_token()
        self.assertEqual(zerochat.get_daily_token(), token)
        self.assertGreater(len(token), 20)

        old = "x" * 43
        with mock.patch.multiple(zerochat, SESSION_TOKEN=old, SESSION_TOKEN_DATE="2000-01-01", ACTIVE_HOST="127.0.0.1", ACTIVE_PORT=6388):
            handler = object.__new__(zerochat.ZeroChatServerHandler)
            handler.headers = {"X-ZeroChat-Token": old}
            self.assertIsNone(handler._resolve_grant())
            new_token = json.loads(self.token_file.read_text(encoding="utf-8"))["token"]
            self.assertNotEqual(new_token, old)
            # Tras el proxy inverso, Authorization lleva la clave del proxy y el token va en X-ZeroChat-Token.
            handler.headers = {"X-ZeroChat-Token": new_token, "Authorization": "Bearer clave-del-proxy"}
            self.assertIsNotNone(handler._resolve_grant())
            handler.headers = {"Authorization": f"Bearer {new_token}"}
            self.assertIsNotNone(handler._resolve_grant())
            # La consola abre el navegador con el token vigente, no con el del arranque.
            self.assertIn(f"#token={new_token}&", zerochat.launch_url("http://127.0.0.1:6388/zerochat.html"))

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

    def test_runner_token_acota_metodos_y_conversacion_y_se_revoca(self):
        runner_token = zerochat.issue_runner_token("run-1", conversation_id="conv-1")
        grant = zerochat.resolve_token(runner_token)
        self.assertIsNotNone(grant)
        self.assertEqual(grant.kind, "runner")
        self.assertTrue(grant.allows("tools/call", {"name": "read_file"}))
        self.assertTrue(grant.allows("zerochat/run/prompt", {}))
        self.assertTrue(grant.allows("zerochat/sandbox/execute", {"code": "1+1"}))
        self.assertTrue(grant.allows("zerochat/conversations/get", {"id": "conv-1"}))
        self.assertTrue(grant.allows("zerochat/conversations/save", {"conversation": {"id": "conv-1"}}))
        self.assertTrue(grant.allows("zerochat/conversations/save_chunk", {"conversationId": "conv-1"}))
        self.assertFalse(grant.allows("zerochat/conversations/save_chunk", {"conversationId": "conv-2"}))
        self.assertTrue(grant.allows("zerochat/conversations/cancel_upload", {"conversationId": "conv-1"}))
        self.assertFalse(grant.allows("zerochat/conversations/cancel_upload", {"conversationId": "conv-2"}))
        self.assertFalse(grant.allows("zerochat/conversations/get", {"id": "conv-2"}))
        self.assertFalse(grant.allows("zerochat/conversations/list", {}))
        self.assertFalse(grant.allows("zerochat/security/policies", {}))
        self.assertFalse(grant.allows("zerochat/profiles/list", {}))
        self.assertFalse(grant.allows("zerochat/blobs/put", {}))

        zerochat.revoke_token(runner_token)
        self.assertIsNone(zerochat.resolve_token(runner_token))

    def test_permitir_solo_esta_vez_no_guarda_nada_ni_al_reanudar_ni_al_rotar_el_token(self):
        # Antes se guardaba por nombre: la primera llamada a run_command pasaba con cualquier argumento.
        controller = zerochat.AccessController()
        ctx = zerochat.SecurityContext(self.config_dir)
        once = {"toolName": "run_command", "args": {"command": "sudo npm test"}, "decision": "allow_once"}
        controller.apply_tool_decision(once, ctx)
        for args in ({"command": "sudo npm test"}, {"command": "sudo rm -rf build"}):
            with self.subTest(args=args):
                decision = controller.evaluate_authorization("run_command", args, ctx)
                self.assertEqual((decision.allowed, decision.requires_approval), (False, True))
        # La rotación del token limpia las autorizaciones de sesión: tampoco concede «solo esta vez».
        with mock.patch.object(zerochat, "RUN_SESSION", None), \
                mock.patch.object(zerochat, "ACCESS_CONTROLLER", controller), \
                mock.patch.object(zerochat, "project_context", return_value=ctx):
            zerochat.reset_session_authorizations()
        self.assertTrue(controller.evaluate_authorization("run_command", {"command": "sudo npm test"}, ctx).requires_approval)
        # Las decisiones que sí se guardan siguen aplicándose al reanudar.
        controller.apply_tool_decision({"toolName": "run_command", "args": {"command": "sudo npm test"},
                                        "decision": {"decision": "allow_session", "commandPattern": "sudo npm test"}}, ctx)
        self.assertTrue(controller.evaluate_authorization("run_command", {"command": "sudo npm test"}, ctx).allowed)
