import os
import unittest
from unittest import mock

from backend import zerochat


class SandboxExecutionTest(unittest.TestCase):
    def test_ejecuta_codigo_aislado_sin_entorno_ni_red_ni_fs(self):
        with mock.patch.dict(os.environ, {"ZEROCHAT_SECRET_TEST": "super-secret-value"}):
            res = zerochat.execute_js_sandbox(
                "console.log('hola'); return [21 * 2, typeof process, typeof require, typeof fetch, typeof WebSocket].join(',');"
            )
            self.assertTrue(res["success"], res)
            self.assertEqual(res["result"], "42,undefined,undefined,undefined,undefined")
            self.assertEqual(res["logs"], ["hola"])

    def test_el_codigo_no_alcanza_el_proceso_anfitrion_por_ninguna_via_conocida(self):
        # Cada intento devuelve typeof process del proceso de Node si escapa: ninguno debe conseguirlo.
        blocked = "Code generation from strings disallowed"
        attempts = {
            "constructor del contexto": "return typeof ({}).constructor.constructor('return process')();",
            "console del contexto": "return typeof console.log.constructor('return process')();",
            "eval": "return typeof eval('process');",
            "error de import": "try { await import('node:net'); return 'object'; } catch (e) { return typeof e.constructor.constructor('return process')(); }",
            "desbordamiento de pila": "function f(){ try { return f(); } catch (e) { return e; } } return typeof f().constructor.constructor('return process')();",
        }
        for name, code in attempts.items():
            with self.subTest(attempt=name):
                result = zerochat.execute_js_sandbox(code)
                self.assertFalse(result["success"], result)
                self.assertIn(blocked, result["error"])
        # Ni Promise.prototype.then ni Error.prepareStackTrace reciben funciones o `this` del anfitrión.
        isolated = zerochat.execute_js_sandbox(
            "let got = 'sin llamar'; Promise.prototype.then = function (resolve) { got = typeof resolve; };"
            "Error.prepareStackTrace = (e, sites) => sites.map(s => typeof s.getThis()).join(',');"
            "return [got, ...new Set(new Error('x').stack.split(','))].join(':');"
        )
        self.assertEqual((isolated["success"], isolated["result"]), (True, "sin llamar:undefined"))

    def test_bucle_asincrono_infinito_se_mata_por_senal_al_vencer_timeout(self):
        with self.assertRaises(ValueError):
            zerochat.execute_js_sandbox("1 + 1", timeout_ms=0)
        res = zerochat.execute_js_sandbox("while (true) { await Promise.resolve(); }", timeout_ms=150)
        self.assertFalse(res["success"])
        self.assertIn("timed out after 150ms", res["error"])
