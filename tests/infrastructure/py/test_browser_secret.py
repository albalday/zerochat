"""Pruebas de browser_fill_secret para rellenar campos en Playwright MCP sin exponer secretos."""

import json
import unittest
from unittest.mock import patch

from backend import use_data_dir, zerochat


class BrowserFillSecretTest(unittest.TestCase):
    def setUp(self):
        self.data_dir = use_data_dir(self)
        self.proj_dir = self.data_dir / "bancos"
        self.proj_dir.mkdir(parents=True)
        self.ctx = zerochat.SecurityContext(self.proj_dir.resolve())
        zerochat.save_project_secret(self.ctx.key, "BANK_PIN", "4072")

    def test_rellena_input_via_browser_type_y_nunca_expone_el_secreto(self):
        calls = []

        def fake_call(public_name, args):
            calls.append((public_name, args))
            return {"content": [{"type": "text", "text": "typed"}], "isError": False}

        with patch.object(zerochat.GLOBAL_MCP_MANAGER, "call", side_effect=fake_call):
            raw = zerochat.browser_fill_secret(
                secret="BANK_PIN",
                ref="e12",
                element="Clave",
                submit=True,
                ctx=self.ctx,
            )
        self.assertNotIn("4072", raw)
        data = json.loads(raw)
        self.assertEqual(data, {"success": True, "secret": "BANK_PIN"})
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][1], {"element": "Clave", "target": "e12", "text": "4072", "submit": True})

        # Ni un error de Playwright ni una excepción reflejan texto crudo ni el secreto
        with patch.object(zerochat.GLOBAL_MCP_MANAGER, "call", return_value={"isError": True, "content": [{"type": "text", "text": 'locator.type("4072") failed'}]}):
            raw_input_err = zerochat.browser_fill_secret(secret="BANK_PIN", ref="e1", ctx=self.ctx)
        self.assertNotIn("4072", raw_input_err)
        self.assertNotIn("locator.type", raw_input_err)

        with patch.object(zerochat.GLOBAL_MCP_MANAGER, "call", side_effect=RuntimeError("fallo con 4072 en texto")):
            raw_exc = zerochat.browser_fill_secret(secret="BANK_PIN", ref="e1", ctx=self.ctx)
        self.assertNotIn("4072", raw_exc)
        self.assertNotIn("fallo con", raw_exc)

    def test_comparte_browser_lease_con_playwright(self):
        zerochat.BROWSER_LEASES._holders.clear()
        self.addCleanup(zerochat.BROWSER_LEASES._holders.clear)
        self.assertTrue(zerochat.BROWSER_LEASES.acquire(zerochat.PLAYWRIGHT_SERVER_ID, "conv_a"))
        for name, args in (
            ("browser_fill_secret", {"secret": "BANK_PIN", "ref": "e1"}),
            ("browser_save_state", {"name": "kutxabank"}),
            ("browser_load_state", {"name": "kutxabank"}),
        ):
            res, err, _ = zerochat.execute_tool("local", name, args, self.ctx, "conv_b")
            self.assertIsNone(err)
            self.assertTrue(res["isError"], name)

    def test_browser_save_y_load_state_aislan_por_proyecto_validan_nombre_permisos_y_tope(self):
        import os
        import stat
        from pathlib import Path

        services_root = self.data_dir / "services"
        other_proj = self.data_dir / "otro_proj"
        other_proj.mkdir()
        other_ctx = zerochat.SecurityContext(other_proj.resolve())

        def fake_call(public_name, args):
            rel = args["filename"]
            target = services_root / zerochat.PLAYWRIGHT_SERVER_ID / rel
            if public_name.endswith("browser_storage_state"):
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text('{"cookies":[{"name":"sid","value":"secret"}]}', encoding="utf-8")
            return {"content": [{"type": "text", "text": "ok"}], "isError": False}

        with patch.object(zerochat.GLOBAL_MCP_MANAGER, "services_root", services_root), \
             patch.object(zerochat.GLOBAL_MCP_MANAGER, "call", side_effect=fake_call) as call_mock:
            # Nombres inválidos (path traversal, puntos, vacío) se rechazan antes de tocar Playwright
            for bad in ("", "../etc", "a/b", "a.json", "x" * 65):
                self.assertFalse(json.loads(zerochat.browser_save_state(bad, ctx=self.ctx))["success"], bad)
                self.assertFalse(json.loads(zerochat.browser_load_state(bad, ctx=self.ctx))["success"], bad)
            call_mock.assert_not_called()

            # Guardar y restaurar en el mismo proyecto
            saved = json.loads(zerochat.browser_save_state("kutxabank", ctx=self.ctx))
            self.assertEqual(saved, {"success": True, "name": "kutxabank", "saved": True})
            rel_saved = call_mock.call_args_list[-1].args[1]["filename"]
            saved_file = Path(services_root / zerochat.PLAYWRIGHT_SERVER_ID / rel_saved)
            self.assertTrue(saved_file.is_file())
            if os.name != "nt":
                self.assertEqual(stat.S_IMODE(saved_file.stat().st_mode), 0o600)
                self.assertEqual(stat.S_IMODE(saved_file.parent.stat().st_mode), 0o700)

            loaded = json.loads(zerochat.browser_load_state("kutxabank", ctx=self.ctx))
            self.assertEqual(loaded, {"success": True, "name": "kutxabank", "loaded": True})
            # Aislamiento: otro proyecto no ve el estado guardado de bancos
            self.assertFalse(json.loads(zerochat.browser_load_state("kutxabank", ctx=other_ctx))["success"])

            # Tope por proyecto N / N+1 (sobrescribir uno existente sigue permitido)
            limit = zerochat.MAX_BROWSER_STATES_PER_PROJECT
            for i in range(limit - 1):
                self.assertTrue(json.loads(zerochat.browser_save_state(f"s_{i}", ctx=self.ctx))["success"])
            self.assertTrue(json.loads(zerochat.browser_save_state("kutxabank", ctx=self.ctx))["success"])
            over = json.loads(zerochat.browser_save_state("extra_over", ctx=self.ctx))
            self.assertFalse(over["success"])
            self.assertIn(str(limit), over["error"])


if __name__ == "__main__":
    unittest.main()
