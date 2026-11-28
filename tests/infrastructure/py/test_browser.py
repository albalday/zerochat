import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend import use_data_dir, zerochat

URL = "http://127.0.0.1:6388/zerochat.html"
TERMUX_BIN = "/data/data/com.termux/files/usr/bin/"
TERMUX_PREFIX = {"PREFIX": "/data/data/com.termux/files/usr"}


def which_in(prefix, *commands):
    return lambda cmd: prefix + cmd if cmd in commands else None


class OpenBrowserTest(unittest.TestCase):
    def open_on(self, platform, environ, which):
        """Abre URL en esa plataforma y devuelve el Popen simulado."""
        with patch("subprocess.Popen") as popen, patch("shutil.which", side_effect=which), \
                patch.dict(os.environ, environ, clear=True), patch.object(sys, "platform", platform):
            self.assertIs(zerochat.open_browser(URL), True)
        return popen

    def assert_detached(self, popen, command):
        popen.assert_called_once()
        args, kwargs = popen.call_args
        self.assertEqual(args[0], command)
        self.assertIs(kwargs.get("start_new_session"), True)
        self.assertEqual((kwargs.get("stdout"), kwargs.get("stderr")), (subprocess.DEVNULL, subprocess.DEVNULL))

    def test_lanzadores_de_escritorio_webbrowser_y_error_diagnosticable(self):
        popen = self.open_on("linux", {}, which_in("/usr/bin/", "xdg-open"))
        self.assert_detached(popen, ["xdg-open", URL])

        popen = self.open_on("linux", {}, which_in("/usr/bin/", "gio"))
        popen.assert_called_once()
        self.assertEqual(popen.call_args.args[0], ["gio", "open", URL])
        self.assertIs(popen.call_args.kwargs.get("start_new_session"), True)

        with patch("shutil.which", return_value=None), patch("webbrowser.open", return_value=True) as webbrowser_open, \
                patch.dict(os.environ, {}, clear=True), patch.object(sys, "platform", "linux"):
            self.assertIs(zerochat.open_browser(URL), True)
        webbrowser_open.assert_called_once_with(URL)

        with patch("shutil.which", return_value=None), patch("webbrowser.open", return_value=False), \
                patch.dict(os.environ, {}, clear=True), patch.object(sys, "platform", "linux"), \
                self.assertRaises(RuntimeError) as raised:
            zerochat.open_browser(URL)
        for detail in ("Ningún lanzador de navegador aceptó", "termux_detectado=False", "webbrowser: devolvió False"):
            self.assertIn(detail, str(raised.exception))

    def test_termux_lanzador_deteccion_y_comando(self):
        cases = [
            ("con_termux_version", "linux", {"TERMUX_VERSION": "0.118"}, which_in(TERMUX_BIN, "termux-open-url", "xdg-open"), ["termux-open-url", URL]),
            ("con_prefix", "linux", TERMUX_PREFIX, which_in(TERMUX_BIN, "termux-open-url", "xdg-open"), ["termux-open-url", URL]),
            ("con_platform_android", "android", {"TERMUX_VERSION": "0.118"}, lambda cmd: TERMUX_BIN + "termux-open-url", ["termux-open-url", URL]),
        ]
        for name, platform, env, which, expected_cmd in cases:
            with self.subTest(name=name):
                popen = self.open_on(platform, env, which)
                self.assert_detached(popen, expected_cmd)

        with self.subTest("prefix_absoluto_sin_path"):
            with patch.object(zerochat.Path, "is_file", return_value=True):
                popen = self.open_on("linux", TERMUX_PREFIX, lambda cmd: None)
            self.assertEqual(popen.call_args.args[0], [str(zerochat.Path(TERMUX_BIN) / "termux-open-url"), URL])

        with self.subTest("comando_manual"):
            url = "https://albalday.github.io/zerochat/zerochat.html#token=test-token&host=127.0.0.1&port=6388"
            with patch.dict(os.environ, TERMUX_PREFIX, clear=True):
                self.assertEqual(zerochat.get_manual_browser_command(url), f"termux-open-url '{url}'")

        with self.subTest("fallo_no_reintenta"):
            with patch("subprocess.Popen", side_effect=PermissionError("permiso denegado")), \
                    patch("shutil.which", return_value=TERMUX_BIN + "termux-open-url"), \
                    patch.dict(os.environ, TERMUX_PREFIX, clear=True), patch.object(sys, "platform", "linux"), \
                    self.assertRaises(RuntimeError) as raised:
                zerochat.open_browser(URL)
            self.assertIn("permiso denegado", str(raised.exception))
            self.assertIn("termux_detectado=True", str(raised.exception))


class BrowserActionTest(unittest.TestCase):
    def test_busca_playwright_en_los_datos_y_chromium_en_la_cache_o_en_chrome_y_edge(self):
        # Sin lanzar Node ni Chromium.
        data_dir = use_data_dir(self)
        cache = tempfile.TemporaryDirectory()
        self.addCleanup(cache.cleanup)
        engine = Path(cache.name) / "chromium_headless_shell-1200"
        playwright = data_dir / "services" / "playwright" / "node_modules" / "playwright"
        no_browsers = {"chrome": False, "msedge": False, "chromium": True, "firefox": True}
        with patch.dict(os.environ, {"PLAYWRIGHT_BROWSERS_PATH": cache.name}), patch("subprocess.Popen") as popen, \
                patch("shutil.which", return_value="/usr/bin/node"), patch.object(zerochat, "system_browsers", return_value=no_browsers):
            self.assertEqual(zerochat.browser_action_availability(), {"available": False, "error": "Playwright is not available."})
            playwright.mkdir(parents=True)
            (playwright / "cli.js").touch()
            # Una descarga a medias, sin INSTALLATION_COMPLETE, y Chromium del sistema, que el runner no lanza, no cuentan.
            engine.mkdir()
            self.assertEqual(zerochat.browser_action_availability(), {"available": False, "error": "Playwright Chromium is not installed."})
            (engine / "INSTALLATION_COMPLETE").touch()
            self.assertEqual(zerochat.browser_action_availability(), {"available": True})
            self.assertEqual(zerochat.cached_engine_entries(), {"chromium-headless-shell"})
            (engine / "INSTALLATION_COMPLETE").unlink()
            with patch.object(zerochat, "system_browsers", return_value={**no_browsers, "msedge": True}):
                self.assertEqual(zerochat.browser_action_availability(), {"available": True})
            popen.assert_not_called()

            # El runner de Node carga el Playwright de la carpeta de datos real.
            popen.return_value.stdout.readline.return_value = '{"ready": true}'
            zerochat.PersistentBrowserSession()._ensure_running()
            self.assertEqual(popen.call_args.kwargs["env"]["ZEROCHAT_PLAYWRIGHT_MODULE"], str(playwright.resolve()))


REAL_POPEN = subprocess.Popen


class PersistentBrowserSessionTest(unittest.TestCase):
    """El proceso del navegador se sustituye por uno de Python que contesta o no como el de Node."""

    def session_with(self, script):
        class FakeNode(REAL_POPEN):
            # Subclase y no una función: _kill_process_tree comprueba isinstance(proc, subprocess.Popen). Solo sustituye
            # a node: el taskkill de _kill_process_tree en Windows también pasa por Popen.
            def __init__(self, cmd, **kwargs):
                super().__init__([sys.executable, "-c", script] if cmd[:1] == ["node"] else cmd, **kwargs)

            def wait(self, timeout=None):
                return super().wait(timeout=min(timeout, 0.05) if timeout is not None else None)

        patches = (patch.object(zerochat.shutil, "which", return_value="node"), patch.object(zerochat.subprocess, "Popen", FakeNode))
        for patcher in patches:
            patcher.start()
            self.addCleanup(patcher.stop)
        session = zerochat.PersistentBrowserSession()
        self.addCleanup(session.close)
        return session

    def test_un_navegador_que_no_contesta_se_termina_y_uno_que_se_cierra_no_bloquea_la_sesion(self):
        hung = self.session_with('import sys, time; print(\'{"ready": true}\', flush=True); sys.stdin.readline(); time.sleep(60)')
        hung._ensure_running()
        with patch.object(zerochat, "BROWSER_ACTION_TIMEOUT_SECONDS", 0.05):
            result = hung.execute({"action": "navigate", "url": "https://example.com"})
        self.assertIs(result["success"], False)
        self.assertIn("did not answer", result["error"])
        self.assertIsNone(hung._process)

        # Antes, cerrar dentro de execute volvía a tomar el cerrojo y la sesión se quedaba bloqueada para siempre.
        dying = self.session_with('import sys; print(\'{"ready": true}\', flush=True); sys.stdin.readline()')
        self.assertEqual(dying.execute({"action": "navigate"})["error"], "Browser process closed unexpectedly.")
        self.assertEqual(dying.execute({"action": "navigate"})["error"], "Browser process closed unexpectedly.")

        broken = self.session_with('import sys; sys.stderr.write("motivo del fallo\\n" * 5000); sys.exit(1)')
        failed = broken.execute({"action": "navigate"})
        self.assertIn("motivo del fallo", failed["error"])


class BrowserActionUrlTest(unittest.TestCase):
    def test_solo_abre_http_y_https_admite_localhost_y_nunca_metadatos_ni_enlace_local(self):
        public = [(None, None, None, "", ("93.184.216.34", 0))]
        metadata = [(None, None, None, "", ("169.254.169.254", 0))]
        self.assertIsNotNone(zerochat.browser_url_error("http://169.254.169.254\\@example.com"))
        with patch.object(zerochat.socket, "getaddrinfo", return_value=public):
            for url in ("http://localhost:5173/", "http://127.0.0.1:8000/app", "http://192.168.1.10/", "https://example.com/"):
                with self.subTest(url=url):
                    self.assertIsNone(zerochat.browser_url_error(url))
            for url in ("file:///etc/passwd", "data:text/html,<b>x</b>", "javascript:alert(1)", "chrome://settings",
                        "http://169.254.169.254/latest/", "http://metadata.google.internal./", "http://[fe80::1]/",
                        "http://[::ffff:169.254.169.254]/", "http://2852039166/", "http:///sin-host"):
                with self.subTest(url=url):
                    self.assertIsNotNone(zerochat.browser_url_error(url))
        # Un nombre que resuelve a los metadatos tampoco pasa.
        with patch.object(zerochat.socket, "getaddrinfo", return_value=metadata):
            self.assertIsNotNone(zerochat.browser_url_error("http://trampa.example/"))
        with patch.object(zerochat, "_BROWSER_SESSION") as session:
            result = zerochat.browser_action("navigate", url="file:///etc/passwd")
        session.execute.assert_not_called()
        self.assertIn("error", result)
