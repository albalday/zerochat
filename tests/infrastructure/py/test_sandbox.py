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

            # El contexto no ve process, require ni las funciones de red.
            probe = zerochat.execute_js_sandbox(
                "return [typeof process, typeof require, typeof fetch, typeof WebSocket].join(',');"
            )
            self.assertTrue(probe["success"], probe)
            self.assertEqual(probe["result"], "undefined,undefined,undefined,undefined")

    def test_el_codigo_no_alcanza_el_proceso_anfitrion_por_ninguna_via_conocida(self):
        # Cada intento devuelve typeof process del proceso de Node si escapa: ninguno debe conseguirlo.
        blocked = "Code generation from strings disallowed"
        attempts = {
            # Los objetos del contexto ya no son los del anfitrión, y tampoco se puede generar código.
            "Object heredado": "return typeof Object.constructor('return process')();",
            "literal": "return typeof ({}).constructor.constructor('return process')();",
            "console": "return typeof console.log.constructor('return process')();",
            "Promise": "return typeof Promise.constructor('return process')();",
            "eval": "return typeof eval('process');",
            # import() falla con un error creado por el anfitrión: aun así no sirve para ejecutar nada.
            "error de import": "try { await import('node:net'); return 'object'; } catch (e) { return typeof e.constructor.constructor('return process')(); }",
            "desbordamiento de pila": "function f(){ try { return f(); } catch (e) { return e; } } return typeof f().constructor.constructor('return process')();",
        }
        for name, code in attempts.items():
            with self.subTest(attempt=name):
                result = zerochat.execute_js_sandbox(code)
                self.assertFalse(result["success"], result)
                self.assertIn(blocked, result["error"])
        # El anfitrión no espera la promesa del código: no entrega funciones suyas a un `then` cambiado.
        hijacked = zerochat.execute_js_sandbox(
            "let got = 'sin llamar'; Promise.prototype.then = function (resolve) { got = typeof resolve; }; return got;"
        )
        self.assertEqual((hijacked["success"], hijacked["result"]), (True, "sin llamar"))
        # Los marcos del anfitrión no entregan su `this` a un prepareStackTrace del código.
        frames = zerochat.execute_js_sandbox(
            "Error.prepareStackTrace = (e, sites) => sites.map(s => typeof s.getThis()).join(','); return new Error('x').stack;"
        )
        self.assertTrue(frames["success"], frames)
        self.assertEqual(set(frames["result"].split(",")), {"undefined"})

    def test_bucle_asincrono_infinito_se_mata_por_senal_al_vencer_timeout(self):
        res = zerochat.execute_js_sandbox("while (true) { await Promise.resolve(); }", timeout_ms=150)
        self.assertFalse(res["success"])
        self.assertIn("timed out after 150ms", res["error"])

    def test_timeout_invalido_lanza_error(self):
        with self.assertRaises(ValueError):
            zerochat.execute_js_sandbox("1 + 1", timeout_ms=0)
