import os
import unittest
from unittest import mock

from backend import zerochat


class SandboxExecutionTest(unittest.TestCase):
    def test_ejecuta_codigo_aislado_sin_entorno_ni_red_ni_fs(self):
        with mock.patch.dict(os.environ, {"ZEROCHAT_SECRET_TEST": "super-secret-value"}):
            res = zerochat.execute_js_sandbox("console.log('hola'); return 21 * 2;")
            self.assertTrue(res["success"], res)
            self.assertEqual(res["result"], "42")
            self.assertEqual(res["logs"], ["hola"])

            # Ni globalThis ni constructor escape pueden ver variables de entorno del padre ni fetch.
            probe = zerochat.execute_js_sandbox(
                "return [typeof process, typeof require, typeof fetch, typeof WebSocket].join(',');"
            )
            self.assertTrue(probe["success"], probe)
            self.assertEqual(probe["result"], "undefined,undefined,undefined,undefined")

            escape = zerochat.execute_js_sandbox("return ({}).constructor.constructor('return process')();")
            self.assertFalse(escape["success"])
            self.assertIn("Dynamic function creation is not allowed", escape["error"])

    def test_bucle_asincrono_infinito_se_mata_por_senal_al_vencer_timeout(self):
        res = zerochat.execute_js_sandbox("while (true) { await Promise.resolve(); }", timeout_ms=150)
        self.assertFalse(res["success"])
        self.assertIn("timed out after 150ms", res["error"])

    def test_timeout_invalido_lanza_error(self):
        with self.assertRaises(ValueError):
            zerochat.execute_js_sandbox("1 + 1", timeout_ms=0)
