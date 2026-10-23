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

    def test_termux_se_prioriza_aunque_haya_xdg_open(self):
        popen = self.open_on("linux", {"TERMUX_VERSION": "0.118"}, which_in(TERMUX_BIN, "termux-open-url", "xdg-open"))
        self.assert_detached(popen, ["termux-open-url", URL])

    def test_linux_de_escritorio_usa_xdg_open(self):
        popen = self.open_on("linux", {}, which_in("/usr/bin/", "xdg-open"))
        self.assert_detached(popen, ["xdg-open", URL])

    def test_termux_se_detecta_por_prefix_sin_termux_version(self):
        popen = self.open_on("linux", TERMUX_PREFIX, which_in(TERMUX_BIN, "termux-open-url", "xdg-open"))
        self.assertEqual(popen.call_args.args[0], ["termux-open-url", URL])

    def test_termux_se_prioriza_aunque_python_se_identifique_como_android(self):
        popen = self.open_on("android", {"TERMUX_VERSION": "0.118"}, lambda cmd: TERMUX_BIN + "termux-open-url")
        self.assertEqual(popen.call_args.args[0], ["termux-open-url", URL])

    def test_termux_recibe_un_comando_manual_seguro_que_conserva_el_token(self):
        url = "https://albalday.github.io/zerochat/zerochat.html#token=test-token&host=127.0.0.1&port=6388"
        with patch.dict(os.environ, TERMUX_PREFIX, clear=True):
            self.assertEqual(zerochat.get_manual_browser_command(url), f"termux-open-url '{url}'")

    def test_termux_usa_la_ruta_absoluta_de_prefix_si_el_venv_no_hereda_path(self):
        with patch.object(zerochat.Path, "is_file", return_value=True):
            popen = self.open_on("linux", TERMUX_PREFIX, lambda cmd: None)
        self.assertEqual(popen.call_args.args[0], [TERMUX_BIN + "termux-open-url", URL])

    def test_termux_informa_del_fallo_de_lanzamiento_sin_probar_otro_lanzador(self):
        with patch("subprocess.Popen", side_effect=PermissionError("permiso denegado")), \
                patch("shutil.which", return_value=TERMUX_BIN + "termux-open-url"), \
                patch.dict(os.environ, TERMUX_PREFIX, clear=True), patch.object(sys, "platform", "linux"), \
                self.assertRaises(RuntimeError) as raised:
            zerochat.open_browser(URL)
        self.assertIn("permiso denegado", str(raised.exception))
        self.assertIn("termux_detectado=True", str(raised.exception))

    def test_linux_sin_xdg_open_usa_gio(self):
        popen = self.open_on("linux", {}, which_in("/usr/bin/", "gio"))
        popen.assert_called_once()
        self.assertEqual(popen.call_args.args[0], ["gio", "open", URL])
        self.assertIs(popen.call_args.kwargs.get("start_new_session"), True)

    def test_sin_lanzadores_del_sistema_se_usa_webbrowser(self):
        with patch("shutil.which", return_value=None), patch("webbrowser.open", return_value=True) as webbrowser_open, \
                patch.dict(os.environ, {}, clear=True), patch.object(sys, "platform", "linux"):
            self.assertIs(zerochat.open_browser(URL), True)
        webbrowser_open.assert_called_once_with(URL)

    def test_un_navegador_que_rechaza_la_url_deja_un_error_diagnosticable(self):
        with patch("shutil.which", return_value=None), patch("webbrowser.open", return_value=False), \
                patch.dict(os.environ, {}, clear=True), patch.object(sys, "platform", "linux"), \
                self.assertRaises(RuntimeError) as raised:
            zerochat.open_browser(URL)
        for detail in ("Ningún lanzador de navegador aceptó", "termux_detectado=False", "webbrowser: devolvió False"):
            self.assertIn(detail, str(raised.exception))


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
