import email.message
import importlib.util
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from backend import ZEROCHAT_PY, use_data_dir, zerochat


REPO_ROOT = ZEROCHAT_PY.parent
MAIL_DIR = REPO_ROOT / "services" / "mail"
MAIL_SERVER_PATH = MAIL_DIR / "mail_mcp_server.py"

_spec = importlib.util.spec_from_file_location("mail_mcp_server", MAIL_SERVER_PATH)
assert _spec is not None and _spec.loader is not None
mail_mcp = importlib.util.module_from_spec(_spec)
sys.modules["mail_mcp_server"] = mail_mcp
_spec.loader.exec_module(mail_mcp)


class MailMcpCatalogTest(unittest.TestCase):
    def test_service_json_y_manifest_declaran_secretos_y_send_desactivado(self):
        definition = json.loads((MAIL_DIR / "service.json").read_text(encoding="utf-8"))
        self.assertEqual(definition["id"], "mail")
        self.assertEqual([s["name"] for s in zerochat.service_secrets(definition)],
                         ["MAIL_IMAP_HOST", "MAIL_USER", "MAIL_PASSWORD"])
        self.assertNotIn("${secret:", json.dumps(definition["launch"]["args"]))
        self.assertEqual(definition["launch"]["env"]["MAIL_PASSWORD"], "${secret:MAIL_PASSWORD}")
        self.assertFalse(zerochat.service_tool_settings(definition, "send_email")["enabledByDefault"])
        self.assertTrue(zerochat.service_tool_settings(definition, "read_message")["enabledByDefault"])

        manifest = json.loads((REPO_ROOT / "services" / "manifest.json").read_text(encoding="utf-8"))
        self.assertIn("mail", manifest["services"])
        self.assertIn("mail_mcp_server.py", manifest["services"]["mail"]["files"])


class MailMcpConfigAndParsingTest(unittest.TestCase):
    def test_parse_mail_config_deduce_smtp_y_valida_formato(self):
        gmail = mail_mcp.parse_mail_config({"MAIL_IMAP_HOST": "imap.gmail.com", "MAIL_USER": "a@gmail.com", "MAIL_PASSWORD": "pw"})
        self.assertEqual((gmail["imap_host"], gmail["imap_port"], gmail["smtp_host"], gmail["smtp_port"]),
                         ("imap.gmail.com", 993, "smtp.gmail.com", 465))

        outlook = mail_mcp.parse_mail_config({"MAIL_IMAP_HOST": "outlook.office365.com", "MAIL_USER": "a@outlook.com", "MAIL_PASSWORD": "pw"})
        self.assertEqual((outlook["smtp_host"], outlook["smtp_port"]), ("smtp.office365.com", 587))

        custom = mail_mcp.parse_mail_config({"MAIL_IMAP_HOST": "imap.corp.local:1993|smtp.corp.local:587", "MAIL_USER": "u", "MAIL_PASSWORD": "p"})
        self.assertEqual((custom["imap_host"], custom["imap_port"], custom["smtp_host"], custom["smtp_port"]),
                         ("imap.corp.local", 1993, "smtp.corp.local", 587))

        for bad in (
            {"MAIL_IMAP_HOST": "", "MAIL_USER": "u", "MAIL_PASSWORD": "p"},
            {"MAIL_IMAP_HOST": "imap.gmail.com:99999", "MAIL_USER": "u", "MAIL_PASSWORD": "p"},
            {"MAIL_IMAP_HOST": "bad host", "MAIL_USER": "u", "MAIL_PASSWORD": "p"},
        ):
            with self.assertRaises(ValueError):
                mail_mcp.parse_mail_config(bad)

    def test_truncate_body_borde_exacto_y_extraccion_html_con_adjuntos(self):
        limit = mail_mcp.MAX_BODY_CHARS
        exact, trunc_n = mail_mcp.truncate_body("a" * limit)
        over, trunc_n1 = mail_mcp.truncate_body("a" * (limit + 1))
        self.assertEqual((len(exact), trunc_n), (limit, False))
        self.assertTrue(trunc_n1)
        self.assertTrue(over.startswith("a" * limit))
        self.assertIn(f"Truncado a {limit}", over)

        msg = email.message.EmailMessage()
        msg["Subject"] = "=?utf-8?q?Informe_t=C3=A9cnico?="
        msg.set_content("<script>alert(1)</script><p>Hola <b>mundo</b></p>", subtype="html")
        msg.add_attachment(b"%PDF-1.4...", maintype="application", subtype="pdf", filename="factura.pdf")

        body, attachments, truncated = mail_mcp._extract_body_and_attachments(msg)
        self.assertFalse(truncated)
        self.assertEqual(body, "Hola mundo")
        self.assertNotIn("alert", body)
        self.assertEqual(attachments, [{"filename": "factura.pdf", "content_type": "application/pdf", "size_bytes": 11}])
        self.assertEqual(mail_mcp._decode_mime_header(msg["Subject"]), "Informe técnico")


class MailMcpOperationsTest(unittest.TestCase):
    CFG = {"imap_host": "imap.gmail.com", "imap_port": 993, "smtp_host": "smtp.gmail.com", "smtp_port": 465,
           "user": "bot@gmail.com", "password": "app-password"}

    def test_search_read_y_create_draft_por_imap(self):
        sample = email.message.EmailMessage()
        sample["From"] = "Alice <alice@example.com>"
        sample["To"] = "bot@gmail.com"
        sample["Subject"] = "Alerta diaria"
        sample["Date"] = "Thu, 19 Nov 2026 10:00:00 +0100"
        sample["Message-ID"] = "<orig-42@example.com>"
        sample.set_content("Todo en orden en el servidor.")

        conn = MagicMock()
        conn.list.return_value = ("OK", [b'(\\HasNoChildren) "/" "INBOX"', b'(\\Drafts) "/" "[Gmail]/Drafts"'])
        conn.select.return_value = ("OK", [b"1"])
        conn.uid.side_effect = [
            ("OK", [b"10 42"]),
            ("OK", [(b"1 (UID 42 FLAGS (\\Seen))", b"From: Alice <alice@example.com>\r\nSubject: Alerta diaria\r\nDate: Thu, 19 Nov 2026 10:00:00 +0100\r\n")]),
            ("OK", [(b"1 (UID 42 BODY[] {100})", sample.as_bytes())]),
            ("OK", [(b"1 (UID 42)", b"Message-ID: <orig-42@example.com>\r\n")]),
        ]
        conn.append.return_value = ("OK", [b"[APPENDUID 1 99]"])

        with patch.object(mail_mcp, "_open_imap", return_value=conn):
            search_res = mail_mcp.tool_search_messages(self.CFG, {"unseen_only": True, "since_days": 7, "limit": 5})
            self.assertEqual(search_res["total_matched"], 2)
            self.assertEqual(search_res["messages"][0]["uid"], "42")
            self.assertTrue(search_res["messages"][0]["seen"])

            read_res = mail_mcp.tool_read_message(self.CFG, {"uid": "42"})
            self.assertEqual(read_res["subject"], "Alerta diaria")
            self.assertIn("Todo en orden", read_res["body"])
            # Sin mark_seen=True, usa BODY.PEEK[] para no marcar el correo como leído
            self.assertEqual(conn.uid.call_args_list[2].args, ("FETCH", "42", "(BODY.PEEK[])"))

            draft_res = mail_mcp.tool_create_draft(self.CFG, {
                "to": "alice@example.com", "subject": "Re: Alerta diaria", "body": "Recibido.", "reply_to_uid": "42"
            })
            self.assertTrue(draft_res["saved"])
            self.assertEqual(draft_res["folder"], "[Gmail]/Drafts")
            sent_bytes = conn.append.call_args.args[3]
            parsed_draft = email.message_from_bytes(sent_bytes)
            self.assertEqual(parsed_draft["In-Reply-To"], "<orig-42@example.com>")

    def test_validacion_bordes_y_bloqueo_inyeccion_crlf(self):
        with self.assertRaises(ValueError):
            mail_mcp.tool_read_message(self.CFG, {"uid": "42; DELETE"})
        for bad_limit in (0, mail_mcp.MAX_SEARCH_LIMIT + 1, True):
            with self.assertRaises(ValueError):
                mail_mcp.tool_search_messages(self.CFG, {"limit": bad_limit})
        with self.assertRaises(ValueError):
            mail_mcp.tool_send_email(self.CFG, {"to": "a@b.com\r\nBcc: evil@x.com", "subject": "Hi", "body": "Test"})

    def test_send_email_usa_ssl_y_starttls_segun_puerto(self):
        smtp_ssl = MagicMock()
        smtp_ssl.__enter__.return_value = smtp_ssl
        with patch.object(mail_mcp.smtplib, "SMTP_SSL", return_value=smtp_ssl) as mock_ssl:
            res = mail_mcp.tool_send_email(self.CFG, {"to": "dest@example.com", "subject": "Hola", "body": "Cuerpo"})
            self.assertTrue(res["sent"])
            mock_ssl.assert_called_once()
            smtp_ssl.login.assert_called_once_with("bot@gmail.com", "app-password")
            smtp_ssl.send_message.assert_called_once()

        cfg_587 = {**self.CFG, "smtp_port": 587}
        smtp_tls = MagicMock()
        smtp_tls.__enter__.return_value = smtp_tls
        with patch.object(mail_mcp.smtplib, "SMTP", return_value=smtp_tls):
            mail_mcp.tool_send_email(cfg_587, {"to": "dest@example.com", "subject": "Hola", "body": "Cuerpo"})
            smtp_tls.starttls.assert_called_once()
            smtp_tls.login.assert_called_once_with("bot@gmail.com", "app-password")


class MailMcpStdioIntegrationTest(unittest.TestCase):
    def test_stdio_handshake_y_politica_por_defecto_desde_manager(self):
        data_dir = use_data_dir(self)
        services_root = data_dir / "services"
        target_dir = services_root / "mail"
        target_dir.mkdir(parents=True)
        for name in ("service.json", "mail_mcp_server.py"):
            (target_dir / name).write_text((MAIL_DIR / name).read_text(encoding="utf-8"), encoding="utf-8")

        manager = zerochat.McpServiceManager(services_root)
        self.addCleanup(manager.close)
        zerochat.save_secret("mcp:mail:MAIL_IMAP_HOST", "imap.gmail.com")
        zerochat.save_secret("mcp:mail:MAIL_USER", "bot@gmail.com")
        zerochat.save_secret("mcp:mail:MAIL_PASSWORD", "app-secret")

        servers = manager.start("mail")
        mail_status = next(s for s in servers if s["id"] == "mail")
        self.assertEqual(mail_status["status"], "running", mail_status.get("error"))
        tools = {t["name"]: t for t in manager.tools()}
        self.assertIn("mail_search_messages", tools)
        self.assertIn("mail_send_email", tools)
        self.assertFalse(tools["mail_send_email"]["metadata"]["enabledByDefault"])
        self.assertTrue(tools["mail_read_message"]["metadata"]["enabledByDefault"])
        # También una llamada real por stdio devuelve error JSON-RPC controlado cuando faltan parámetros
        err_call = manager.call("mail_read_message", {"uid": "bad"})
        self.assertTrue(err_call["isError"])
        self.assertIn("uid", err_call["content"][0]["text"])
