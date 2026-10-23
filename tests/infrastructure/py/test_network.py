import gzip
import io
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
