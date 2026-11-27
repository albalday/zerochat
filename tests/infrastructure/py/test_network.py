import email.message
import gzip
from http.server import BaseHTTPRequestHandler
import io
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import urllib.request

from backend import use_data_dir, zerochat


class ServerBindTest(unittest.TestCase):
    def test_el_servidor_arranca_sin_resolver_el_nombre_del_equipo(self):
        # HTTPServer.server_bind llama a socket.getfqdn, que sin DNS inverso tarda decenas de segundos (macOS).
        with patch("socket.getfqdn", side_effect=AssertionError("getfqdn")):
            server = zerochat.ZeroChatHTTPServer(("127.0.0.1", 0), zerochat.ZeroChatServerHandler)
        self.addCleanup(server.server_close)
        self.assertEqual((server.server_name, server.server_port), ("127.0.0.1", server.server_address[1]))
        self.assertNotEqual(server.server_port, 0)


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
            os.chdir(looks_like_dev)
            # Se vuelve antes de borrar la carpeta temporal: Windows no borra la carpeta actual de un proceso.
            try:
                # Un zerochat instalado, arrancado dentro de una carpeta que parece el repositorio, no sirve nada.
                with patch.object(zerochat, "__file__", str(installed / "zerochat.py")):
                    self.assertIsNone(zerochat.get_dev_root())
                    self.assertIsNone(zerochat.get_static_root())
            finally:
                os.chdir(cwd)
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
            for rel in ("/.git/config", "/.env", "/js/../.env", "/js/enlace.txt", "/../fuera.txt", "/js", "/", "/no-existe.js", "/a\x00b.html"):
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
        # Las IPs literales se evalúan sin consultar DNS.
        with patch.object(zerochat.socket, "getaddrinfo", side_effect=AssertionError("no debe resolver IP literal")):
            self.assertIs(zerochat.is_dangerous_host("127.0.0.1"), True)
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
        with patch.object(zerochat, "WEB_FETCH_MAX_BYTES", 32):
            data, truncated = zerochat._read_limited_body(io.BytesIO(bomb), "gzip", limit)
        self.assertTrue(truncated)

    def test_se_siguen_web_fetch_max_redirects_redirecciones_y_una_mas_es_error(self):
        class Chain(BaseHTTPRequestHandler):
            # /r/<n> redirige a /r/<n-1>; /r/0 responde; /meta redirige a los metadatos cloud.
            def do_GET(self):
                if self.path == "/meta":
                    self.send_response(302)
                    self.send_header("Location", "http://169.254.169.254/latest/")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
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

        server = zerochat.ZeroChatHTTPServer(("127.0.0.1", 0), Chain)
        self.addCleanup(server.server_close)
        threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True).start()
        self.addCleanup(server.shutdown)
        base = f"http://127.0.0.1:{server.server_address[1]}/r"
        limit = zerochat.WEB_FETCH_MAX_REDIRECTS
        with patch.object(zerochat, "is_dangerous_host", return_value=False):
            followed = zerochat.fetch_web_resource({"url": f"{base}/{limit}"})
            refused = zerochat.fetch_web_resource({"url": f"{base}/{limit + 1}"})
        self.assertEqual((followed["ok"], followed["text"], followed["url"]), (True, "ok", f"{base}/0"))
        self.assertEqual((refused["ok"], refused["status"]), (False, 302))
        self.assertIn("infinite loop", refused["error"])
        # Una redirección a un destino bloqueado se rechaza como la URL pedida (-32602 en el RPC), no como fallo de red.
        with patch.object(zerochat, "is_dangerous_host", side_effect=lambda host: host == "169.254.169.254"), \
                self.assertRaises(PermissionError):
            zerochat.fetch_web_resource({"url": base.rsplit("/", 1)[0] + "/meta"})

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

    def test_duckduckgo_lleva_cabeceras_pasa_por_el_limitador_y_detecta_reto_202(self):
        use_data_dir(self)
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
        timeouts = []

        def opener(req, timeout=10.0):
            captured_requests.append(req)
            timeouts.append(timeout)
            return MockResponse(status=202 if "anomaly" in req.full_url else 200)

        policy = zerochat.RatePolicy(concurrency=1, min_interval_s=0.4)
        with patch.object(zerochat, "is_dangerous_host", return_value=False), \
                patch.object(zerochat, "RATE_LIMITER", zerochat.RateLimiter()), \
                patch.dict(zerochat.WEB_FETCH_DOMAIN_LIMITS, {"duckduckgo.com": policy}, clear=True), \
                patch.object(zerochat._WEB_OPENER, "open", opener):
            # 1. Subdominio de DuckDuckGo: lleva cabeceras de navegación, espera la separación y la descuenta del plazo.
            res = zerochat.fetch_web_resource({"url": "https://html.duckduckgo.com/html/?q=a", "timeout_s": 5})
            self.assertTrue(res["ok"])
            self.assertLess(timeouts[-1], 5 - 0.2)
            req = captured_requests[0]
            self.assertEqual(req.headers.get("User-agent"), zerochat.effective_user_agent())
            self.assertEqual(req.headers.get("Referer"), "https://html.duckduckgo.com/")
            self.assertEqual(req.headers.get("Sec-fetch-dest"), "document")
            self.assertEqual(req.headers.get("Sec-fetch-mode"), "navigate")
            self.assertIn("Chromium", req.headers.get("Sec-ch-ua"))

            # 2. Otro dominio no espera ni pierde plazo.
            zerochat.fetch_web_resource({"url": "https://example.com/", "timeout_s": 5})
            self.assertEqual(timeouts[-1], 5)

            # 3. Si el turno no llega dentro del plazo, falla enseguida con el motivo, sin descargar.
            slow = zerochat.RatePolicy(concurrency=1, min_interval_s=10)
            with patch.dict(zerochat.WEB_FETCH_DOMAIN_LIMITS, {"duckduckgo.com": slow}, clear=True):
                busy = zerochat.fetch_web_resource({"url": "https://duckduckgo.com/html/?q=b", "timeout_s": 2})
            self.assertEqual((busy["ok"], len(timeouts)), (False, 2))
            self.assertIn("duckduckgo.com está ocupado", busy["error"])

            # 4. Respuesta 202 se detecta como reto/anomalía y devuelve ok: False.
            with patch.dict(zerochat.WEB_FETCH_DOMAIN_LIMITS, {}, clear=True):
                res_202 = zerochat.fetch_web_resource({"url": "https://html.duckduckgo.com/anomaly"})
            self.assertEqual((res_202["ok"], res_202["status"]), (False, 202))
            self.assertIn("Reto anti-bot", res_202["error"])

    def test_capture_frontend_user_agent(self):
        """El User-Agent de la primera petición del frontend se adopta; el resto no lo toca."""
        use_data_dir(self)
        original = zerochat.ACTIVE_USER_AGENT
        original_service = zerochat.SERVICE_USER_AGENT
        original_captured = zerochat._FRONTEND_USER_AGENT_CAPTURED
        try:
            zerochat.ACTIVE_USER_AGENT = zerochat.DEFAULT_USER_AGENT
            zerochat.set_service_user_agent(zerochat.DEFAULT_USER_AGENT, from_frontend=False)
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
            zerochat.set_service_user_agent(original_service, from_frontend=original_captured)
