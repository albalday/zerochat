"""Pruebas de browser_fill_secret para input y teclado virtual sin exponer secretos."""

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

    def test_modalidad_input_llama_browser_type_y_nunca_devuelve_el_secreto(self):
        calls = []

        def fake_call(public_name, args):
            calls.append((public_name, args))
            return {"content": [{"type": "text", "text": "typed"}], "isError": False}

        with patch.object(zerochat.GLOBAL_MCP_MANAGER, "call", side_effect=fake_call):
            raw = zerochat.browser_fill_secret(
                secret="BANK_PIN",
                mode="input",
                ref="e12",
                element="Clave",
                submit=True,
                ctx=self.ctx,
            )
        self.assertNotIn("4072", raw)
        data = json.loads(raw)
        self.assertTrue(data["success"])
        self.assertEqual(data["mode"], "input")
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][1], {"element": "Clave", "target": "e12", "text": "4072", "submit": True})

    def test_modalidad_keypad_pulsa_refs_y_coordenadas_en_orden_sin_exponer_secreto(self):
        calls = []

        def fake_call(public_name, args):
            calls.append((public_name, args))
            return {"content": [{"type": "text", "text": "clicked"}], "isError": False}

        keypad = {"4": "e4", "0": [120, 240], "7": "e7", "2": "e2"}
        with patch.object(zerochat.GLOBAL_MCP_MANAGER, "call", side_effect=fake_call):
            raw = zerochat.browser_fill_secret(
                secret="BANK_PIN",
                mode="keypad",
                keypad_map=keypad,
                ctx=self.ctx,
            )
        self.assertNotIn("4072", raw)
        data = json.loads(raw)
        self.assertEqual(data, {"success": True, "mode": "keypad", "secret": "BANK_PIN"}, "sin la longitud del secreto")
        self.assertEqual([c[1].get("target") or (c[1].get("x"), c[1].get("y")) for c in calls], [
            "e4",
            (120.0, 240.0),
            "e7",
            "e2",
        ])

    def test_keypad_incompleto_no_pulsa_nada_y_no_revela_caracter_faltante(self):
        calls = []
        with patch.object(zerochat.GLOBAL_MCP_MANAGER, "call", side_effect=lambda *a: calls.append(a)):
            raw = zerochat.browser_fill_secret(
                secret="BANK_PIN",
                mode="keypad",
                keypad_map={"4": "e4", "0": "e0", "7": "e7"},
                ctx=self.ctx,
            )
        self.assertEqual(calls, [])
        self.assertNotIn("2", raw)
        self.assertNotIn("4072", raw)
        self.assertIn("error", json.loads(raw))

        # Ni una entrada no válida ni un fallo de Playwright a mitad dicen qué tecla (y qué carácter) falló.
        with patch.object(zerochat.GLOBAL_MCP_MANAGER, "call", side_effect=lambda *a: calls.append(a)):
            raw_bad = zerochat.browser_fill_secret(secret="BANK_PIN", mode="keypad", ctx=self.ctx,
                                                   keypad_map={"4": "e4", "0": "e0", "7": "e7", "2": "e2", "9": 5})
        self.assertEqual(calls, [])
        self.assertIn("error", json.loads(raw_bad))
        failures = []
        for failing in ("e4", "e2"):
            fake = lambda _name, args, failing=failing: {"isError": args.get("target") == failing,
                                                        "content": [{"type": "text", "text": f"Ref {args.get('target')} not found"}]}
            with patch.object(zerochat.GLOBAL_MCP_MANAGER, "call", side_effect=fake):
                failures.append(zerochat.browser_fill_secret(secret="BANK_PIN", mode="keypad", ctx=self.ctx,
                                                             keypad_map={"4": "e4", "0": "e0", "7": "e7", "2": "e2"}))
        self.assertEqual(failures[0], failures[1])
        self.assertNotIn("e4", failures[0])

        # Si Playwright lanza una excepción cuyo mensaje contiene el secreto, también se sanea
        with patch.object(zerochat.GLOBAL_MCP_MANAGER, "call", side_effect=RuntimeError("fallo con 4072 en texto")):
            raw_exc = zerochat.browser_fill_secret(secret="BANK_PIN", mode="input", ref="e1", ctx=self.ctx)
        self.assertNotIn("4072", raw_exc)
        self.assertIn("***", raw_exc)

    def test_comparte_browser_lease_con_playwright(self):
        zerochat.BROWSER_LEASES._holders.clear()
        self.addCleanup(zerochat.BROWSER_LEASES._holders.clear)
        self.assertTrue(zerochat.BROWSER_LEASES.acquire(zerochat.PLAYWRIGHT_SERVER_ID, "conv_a"))
        res, err, _ = zerochat.execute_tool(
            "local",
            "browser_fill_secret",
            {"secret": "BANK_PIN", "mode": "input", "ref": "e1"},
            self.ctx,
            "conv_b",
        )
        self.assertIsNone(err)
        self.assertTrue(res["isError"])


if __name__ == "__main__":
    unittest.main()
