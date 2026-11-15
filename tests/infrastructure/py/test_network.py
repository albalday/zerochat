import email.message
import gzip
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import urllib.request

from backend import zerochat


class LoopbackTest(unittest.TestCase):
    def test_solo_fuera_de_loopback_se_avisa_de_la_exposicion_remota(self):
        for host in ("127.0.0.1", "127.0.0.2", "localhost", "LOCALHOST", "::1", "[::1]", "::ffff:127.0.0.1"):
            with self.subTest(host=host):
                self.assertTrue(zerochat.is_loopback_host(host))
                self.assertIsNone(zerochat.remote_exposure_warning(host))
        for host in ("0.0.0.0", "::", "192.168.1.10", "::ffff:192.168.1.10", "mi-equipo.local", ""):
            with self.subTest(host=host):
                self.assertFalse(zerochat.is_loopback_host(host))
                warning = zerochat.remote_exposure_warning(host)
                self.assertIn("ejecutar comandos", warning)
                self.assertIn("sin cifrar", warning)



class DevelopmentStaticFilesTest(unittest.TestCase):
    """Servidor de desarrollo: solo cuando zerochat.py está en el repositorio y sin salir de su raíz."""

    def make_repo(self, base: Path) -> Path:
        (base / "js").mkdir(parents=True)
        (base / "css").mkdir()
        (base / "zerochat.html").write_text("<html></html>", encoding="utf-8")
        return base

    def test_el_modo_desarrollo_depende_de_donde_esta_zerochat_py_y_no_de_la_carpeta_actual(self):
        with tempfile.TemporaryDirectory() as tmp:
            looks_like_dev = self.make_repo(Path(tmp, "parece-el-repo").resolve())
            installed = Path(tmp, "site-packages").resolve()
            installed.mkdir()
            cwd = os.getcwd()
            self.addCleanup(os.chdir, cwd)
            os.chdir(looks_like_dev)
            # Un zerochat instalado, arrancado dentro de una carpeta que parece el repositorio, no sirve nada.
            with patch.object(zerochat, "__file__", str(installed / "zerochat.py")):
                self.assertIsNone(zerochat.get_dev_root())
                self.assertIsNone(zerochat.get_static_root())
            with patch.object(zerochat, "__file__", str(looks_like_dev / "zerochat.py")):
                self.assertEqual(zerochat.get_dev_root(), looks_like_dev)

    def test_se_sirve_lo_que_hay_bajo_la_raiz_salvo_ocultos_y_lo_que_sale_de_ella(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = self.make_repo(Path(tmp, "repo").resolve())
            outside = Path(tmp, "fuera.txt")
            outside.write_text("no", encoding="utf-8")
            (root / "todo.txt").write_text("notas", encoding="utf-8")
            (root / "js" / "app.js").write_text("//", encoding="utf-8")
            (root / ".git").mkdir()
            (root / ".git" / "config").write_text("x", encoding="utf-8")
            (root / ".env").write_text("CLAVE=1", encoding="utf-8")
            os.symlink(outside, root / "js" / "enlace.txt")
            served = lambda rel: zerochat.static_file_target(root, rel)
            self.assertEqual(served("/js/app.js"), root / "js" / "app.js")
            self.assertEqual(served("/todo.txt?v=1"), root / "todo.txt")
            for rel in ("/.git/config", "/.env", "/js/../.env", "/js/enlace.txt", "/../fuera.txt", "/js", "/", "/no-existe.js"):
                with self.subTest(rel=rel):
                    self.assertIsNone(served(rel))

    def test_una_url_con_un_segmento_de_puntos_se_reconoce_tambien_codificada(self):
        for path in ("/js/../todo.txt", "/..", "/js/%2e%2e/x", "/js/%2E%2E/x", "/js\\..\\x", "/a/..?b=c"):
            with self.subTest(path=path):
                self.assertTrue(zerochat.has_dot_segment(path))
        for path in ("/", "/zerochat.html", "/js/app.min.js", "/files.html?path=../x", "/a..b/c", "/mcp/external"):
            with self.subTest(path=path):
                self.assertFalse(zerochat.has_dot_segment(path))


class WebFetchTest(unittest.TestCase):
    def test_is_dangerous_host_rechaza_nombres_locales_y_direcciones_no_publicas(self):
        dangerous = (
            "169.254.169.254", "metadata.google.internal", "127.0.0.1", "localhost", "printer.local",
            "10.0.0.1", "192.168.1.1", "100.64.0.1", "::ffff:127.0.0.1",
            # Notaciones numéricas no canónicas, que cada resolvedor interpreta a su manera
            "127.1", "2130706433", "0x7f.1", "0177.0.0.1",
        )
        for host in dangerous:
            with self.subTest(host=host):
                self.assertIs(zerochat.is_dangerous_host(host), True)
        self.assertIs(zerochat.is_dangerous_host("8.8.8.8"), False)
        # Un nombre hecho solo de letras hexadecimales no es una notación numérica: se resuelve como cualquier otro.
        public = [(None, None, None, "", ("93.184.216.34", 0))]
        with patch.object(zerochat.socket, "getaddrinfo", return_value=public):
            self.assertIs(zerochat.is_dangerous_host("cafe.de"), False)

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

    def test_se_siguen_web_fetch_max_redirects_redirecciones_y_una_mas_es_error(self):
        class Chain(BaseHTTPRequestHandler):
            # /r/<n> redirige a /r/<n-1>; /r/0 responde.
            def do_GET(self):
                remaining = int(self.path.rsplit("/", 1)[1])
                if remaining:
                    self.send_response(302)
                    self.send_header("Location", f"/r/{remaining - 1}")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header("Content-Type", "text/plain")
                self.send_header("Content-Length", "2")
                self.end_headers()
                self.wfile.write(b"ok")

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Chain)
        self.addCleanup(server.server_close)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.shutdown)
        base = f"http://127.0.0.1:{server.server_address[1]}/r"
        limit = zerochat.WEB_FETCH_MAX_REDIRECTS
        with patch.object(zerochat, "is_dangerous_host", return_value=False):
            followed = zerochat.fetch_web_resource({"url": f"{base}/{limit}"})
            refused = zerochat.fetch_web_resource({"url": f"{base}/{limit + 1}"})
        self.assertEqual((followed["ok"], followed["text"], followed["url"]), (True, "ok", f"{base}/0"))
        self.assertEqual((refused["ok"], refused["status"]), (False, 302))
        self.assertIn("infinite loop", refused["error"])

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
