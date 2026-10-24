import json
import unittest
from unittest import mock

from backend import use_data_dir, zerochat


class LoginTest(unittest.TestCase):
    """zerochat/login con la comprobación de la contraseña del sistema simulada."""

    def setUp(self):
        self.token_file = use_data_dir(self) / "config" / "token.json"
        self.clock = 1000.0
        self.checked = []
        for target, value in (
            ("LOGIN_FAILURES", 0),
            ("LOGIN_LOCKED_UNTIL", 0.0),
            ("SESSION_TOKEN_DATE", ""),
            ("system_account", lambda: "ana"),
            ("check_system_password", lambda user, password: self.checked.append(user) or password == "buena"),
        ):
            patcher = mock.patch.object(zerochat, target, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        patcher = mock.patch.object(zerochat.time, "monotonic", lambda: self.clock)
        patcher.start()
        self.addCleanup(patcher.stop)

    def attempt(self, user="ana", password="buena"):
        try:
            return zerochat.login({"user": user, "password": password})
        except zerochat.LoginError as exc:
            return exc

    def test_la_cuenta_que_ejecuta_zerochat_recibe_el_token_diario(self):
        result = self.attempt()
        self.assertEqual(result, {"token": json.loads(self.token_file.read_text(encoding="utf-8"))["token"]})

    def test_otro_usuario_falla_como_una_contrasena_erronea_sin_delatar_la_cuenta(self):
        result = self.attempt(user="root")
        self.assertEqual(result.code, zerochat.LOGIN_FAILED_CODE)
        self.assertEqual(self.checked, ["ana"], "se comprueba la contraseña de la cuenta propia también con otro usuario")
        self.assertEqual(zerochat.LOGIN_FAILURES, 1)

    def test_usuario_y_contrasena_son_textos_acotados(self):
        limit = zerochat.LOGIN_MAX_FIELD_LENGTH
        for params in ({}, {"user": "ana"}, {"user": "", "password": "x"}, {"user": "ana", "password": 7},
                       {"user": "ana", "password": "x" * (limit + 1)}):
            with self.subTest(params=params):
                with self.assertRaises(zerochat.LoginError) as raised:
                    zerochat.login(params)
                self.assertEqual(raised.exception.code, -32602)
        self.assertEqual(self.checked, [])
        self.assertEqual(self.attempt(password="x" * limit).code, zerochat.LOGIN_FAILED_CODE)

    def test_tras_n_fallos_seguidos_el_intento_n_mas_1_se_rechaza_sin_comprobarlo_hasta_que_pasa_el_bloqueo(self):
        limit = zerochat.LOGIN_MAX_FAILURES
        for _ in range(limit - 1):
            self.attempt(password="mala")
        # Un acierto antes del tope pone a cero la cuenta de fallos.
        self.assertIn("token", self.attempt())
        for _ in range(limit):
            self.assertEqual(self.attempt(password="mala").code, zerochat.LOGIN_FAILED_CODE)
        self.assertEqual(len(self.checked), 2 * limit)

        locked = self.attempt()
        self.assertEqual(locked.code, zerochat.LOGIN_LOCKED_CODE)
        self.assertEqual(locked.data, {"retryAfter": int(zerochat.LOGIN_LOCKOUT_SECONDS)})
        self.assertEqual(len(self.checked), 2 * limit, "el intento N+1 no llega a comprobar la contraseña")

        self.clock += zerochat.LOGIN_LOCKOUT_SECONDS - 0.5
        self.assertEqual(self.attempt().data, {"retryAfter": 1})
        self.clock += 0.5
        self.assertIn("token", self.attempt())
