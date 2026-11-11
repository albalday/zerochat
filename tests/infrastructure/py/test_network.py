import email.message
import gzip
import io
import time
import unittest
import urllib.request

from backend import zerochat


class LoopbackTest(unittest.TestCase):
    def test_solo_fuera_de_loopback_se_avisa_de_la_exposicion_remota(self):
        for host in ("127.0.0.1", "127.0.0.2", "localhost", "LOCALHOST", "::1", "[::1]"):
            with self.subTest(host=host):
                self.assertTrue(zerochat.is_loopback_host(host))
                self.assertIsNone(zerochat.remote_exposure_warning(host))
        for host in ("0.0.0.0", "::", "192.168.1.10", "mi-equipo.local", ""):
            with self.subTest(host=host):
                self.assertFalse(zerochat.is_loopback_host(host))
                warning = zerochat.remote_exposure_warning(host)
                self.assertIn("ejecutar comandos", warning)
                self.assertIn("sin cifrar", warning)


class WebFetchTest(unittest.TestCase):
    def test_is_dangerous_host_rechaza_nombres_locales_y_direcciones_no_publicas(self):
        dangerous = (
            "169.254.169.254", "metadata.google.internal", "127.0.0.1", "localhost", "printer.local",
            "10.0.0.1", "192.168.1.1", "100.64.0.1", "::ffff:127.0.0.1",
            # Formas abreviadas que el resolvedor convierte en loopback
            "127.1", "2130706433",
        )
        for host in dangerous:
            with self.subTest(host=host):
                self.assertIs(zerochat.is_dangerous_host(host), True)
        self.assertIs(zerochat.is_dangerous_host("8.8.8.8"), False)

    def test_cada_redireccion_pasa_la_misma_validacion(self):
        handler = zerochat._ValidatingRedirectHandler()
        request = urllib.request.Request("https://8.8.8.8/start")
        for target in ("http://127.0.0.1:11434/api/tags", "http://169.254.169.254/latest/", "file:///etc/passwd"):
            with self.subTest(target=target), self.assertRaises((PermissionError, ValueError)):
                handler.redirect_request(request, None, 302, "Found", {}, target)
        self.assertEqual(handler.redirect_request(request, None, 302, "Found", {}, "https://8.8.8.8/next").full_url, "https://8.8.8.8/next")

    def test_el_cuerpo_se_limita_tras_descomprimir(self):
        # N bytes caben y N+1 se truncan, también en un gzip que se expande.
        limit = 4096
        for encoding, encode in (("", lambda raw: raw), ("gzip", gzip.compress)):
            with self.subTest(encoding=encoding):
                data, truncated = zerochat._read_limited_body(io.BytesIO(encode(b"a" * limit)), encoding, limit)
                self.assertEqual((len(data), truncated), (limit, False))
                data, truncated = zerochat._read_limited_body(io.BytesIO(encode(b"a" * (limit + 1))), encoding, limit)
                self.assertEqual((len(data), truncated), (limit, True))
        bomb = gzip.compress(b"\0" * (50 * 1024 * 1024))
        data, truncated = zerochat._read_limited_body(io.BytesIO(bomb), "gzip", limit)
        self.assertEqual((len(data), truncated), (limit, True))

    def test_solo_los_tipos_textuales_viajan_como_texto(self):
        # El resto (PDF, imágenes) viaja en base64.
        for content_type in ("text/html; charset=utf-8", "application/json", "application/x-javascript", "application/rss+xml", ""):
            with self.subTest(content_type=content_type):
                self.assertIs(zerochat.is_text_content_type(content_type), True)
        for content_type in ("application/pdf", "image/png", "application/octet-stream",
                             "application/vnd.openxmlformats-officedocument.wordprocessingml.document"):
            with self.subTest(content_type=content_type):
                self.assertIs(zerochat.is_text_content_type(content_type), False)

    def test_fetch_web_resource_rechaza_ssrf_otros_protocolos_y_urls_vacias(self):
        with self.assertRaises(PermissionError):
            zerochat.fetch_web_resource({"url": "http://169.254.169.254/latest/meta-data/"})
        for url in ("ftp://example.com/file", ""):
            with self.subTest(url=url), self.assertRaises(ValueError):
                zerochat.fetch_web_resource({"url": url})

    def test_fetch_web_resource_cabeceras_y_respuesta_202(self):
        class MockResponse:
            def __init__(self, status=200, headers=None, body=b"<html>OK</html>"):
                self.status = status
                self._headers = headers or {"Content-Type": "text/html"}
                self.headers = email.message.EmailMessage()
                for k, v in self._headers.items():
                    self.headers[k] = v
                self._body = io.BytesIO(body)

            def read(self, amt=None):
                return self._body.read(amt)

            def getheaders(self):
                return list(self._headers.items())

            def geturl(self):
                return "https://html.duckduckgo.com/html/?q=test"

            def __enter__(self):
                return self

            def __exit__(self, *args):
                pass

        captured_requests = []
        original_open = zerochat._WEB_OPENER.open
        original_sleep = time.sleep
        try:
            def mock_open(req, timeout=10.0):
                captured_requests.append(req)
                status = 202 if "anomaly" in req.full_url else 200
                return MockResponse(status=status)

            zerochat._WEB_OPENER.open = mock_open
            time.__dict__["sleep"] = lambda _s: None  # sin esperas reales en este test

            # 1. Petición a DuckDuckGo lleva cabeceras de navegación y Referer
            res = zerochat.fetch_web_resource({"url": "https://html.duckduckgo.com/html/?q=test"})
            self.assertTrue(res["ok"])
            req = captured_requests[0]
            self.assertEqual(req.headers.get("User-agent"), zerochat.ACTIVE_USER_AGENT)
            self.assertEqual(req.headers.get("Referer"), "https://html.duckduckgo.com/")
            self.assertEqual(req.headers.get("Sec-fetch-dest"), "document")
            self.assertEqual(req.headers.get("Sec-fetch-mode"), "navigate")
            self.assertIn("Chromium", req.headers.get("Sec-ch-ua"))

            # 2. Petición con respuesta 202 se detecta como reto/anomalía y devuelve ok: False
            res_202 = zerochat.fetch_web_resource({"url": "https://html.duckduckgo.com/anomaly"})
            self.assertFalse(res_202["ok"])
            self.assertEqual(res_202["status"], 202)
            self.assertIn("Reto anti-bot", res_202["error"])
        finally:
            zerochat._WEB_OPENER.open = original_open
            time.__dict__["sleep"] = original_sleep

    def test_fetch_web_resource_cadencia_duckduckgo_por_respuesta(self):
        """Mínimo 2 s desde la respuesta anterior; comprobación determinista sin esperas reales."""
        class MockResponse:
            status = 200
            headers = email.message.EmailMessage({"Content-Type": "text/html"})

            def read(self, amt=None):
                return b""

            def getheaders(self):
                return list(self.headers.items())

            def geturl(self):
                return "https://html.duckduckgo.com/html/?q=test"

            def __enter__(self):
                return self

            def __exit__(self, *args):
                pass

        original_open = zerochat._WEB_OPENER.open
        original_sleep = time.sleep
        original_monotonic = time.monotonic
        slept = []
        now = 1000.0
        try:
            zerochat._WEB_OPENER.open = lambda req, timeout=10.0: MockResponse()
            time.sleep = slept.append
            time.monotonic = lambda: now

            # Si la respuesta previa fue hace 0.5 s, espera exactamente el resto (1.5 s).
            zerochat._LAST_WEB_FETCH_AT["duckduckgo.com"] = now - 0.5
            zerochat.fetch_web_resource({"url": "https://html.duckduckgo.com/html/?q=espera"})
            self.assertEqual(slept, [1.5])

            # Si ya se cumplió el gap mínimo (hace 2 s o más), no espera.
            slept.clear()
            zerochat._LAST_WEB_FETCH_AT["duckduckgo.com"] = now - zerochat.WEB_FETCH_MIN_GAP_S
            zerochat.fetch_web_resource({"url": "https://html.duckduckgo.com/html/?q=sin_espera"})
            self.assertEqual(slept, [])

            # Otros dominios no aplican cadencia de espera.
            slept.clear()
            zerochat.fetch_web_resource({"url": "https://example.com/test"})
            self.assertEqual(slept, [])
        finally:
            zerochat._WEB_OPENER.open = original_open
            time.sleep = original_sleep
            time.monotonic = original_monotonic
            zerochat._WEB_FETCH_PENDING["duckduckgo.com"] = 0

    def test_capture_frontend_user_agent(self):
        """El User-Agent de la primera petición del frontend se adopta; el resto no lo toca."""
        original = zerochat.ACTIVE_USER_AGENT
        original_service = zerochat.SERVICE_USER_AGENT
        try:
            zerochat.ACTIVE_USER_AGENT = zerochat.DEFAULT_USER_AGENT
            zerochat.SERVICE_USER_AGENT = zerochat.DEFAULT_USER_AGENT
            zerochat.capture_frontend_user_agent("  Mozilla/5.0 (FrontendTest/1.0)  ")
            self.assertEqual(zerochat.ACTIVE_USER_AGENT, "Mozilla/5.0 (FrontendTest/1.0)")
            self.assertEqual(zerochat.SERVICE_USER_AGENT, "Mozilla/5.0 (FrontendTest/1.0)")
            # Segunda petición con otro UA: no se sobreescribe.
            zerochat.capture_frontend_user_agent("OtroUA/2.0")
            self.assertEqual(zerochat.ACTIVE_USER_AGENT, "Mozilla/5.0 (FrontendTest/1.0)")
            # Vacíos y no-cadenas se ignoran.
            zerochat.ACTIVE_USER_AGENT = zerochat.DEFAULT_USER_AGENT
            zerochat.capture_frontend_user_agent("   ")
            zerochat.capture_frontend_user_agent(None)
            self.assertIs(zerochat.ACTIVE_USER_AGENT, zerochat.DEFAULT_USER_AGENT)
        finally:
            zerochat.ACTIVE_USER_AGENT = original
            zerochat.SERVICE_USER_AGENT = original_service

    def test_sin_constantes_de_pacing_viejo(self):
        self.assertFalse(hasattr(zerochat, "WEB_FETCH_MIN_DELAY_S"))
        self.assertFalse(hasattr(zerochat, "WEB_FETCH_MAX_DELAY_S"))
