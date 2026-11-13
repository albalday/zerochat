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

    def test_linux_de_escritorio_usa_xdg_open(self):
        popen = self.open_on("linux", {}, which_in("/usr/bin/", "xdg-open"))
        self.assert_detached(popen, ["xdg-open", URL])

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
            # La ruta se compone con Path: en el anfitrión de la prueba lleva su separador.
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

    def test_playwright_chromium_executable_prefiere_headless_shell_y_valida_argumentos_de_prompt(self):
        use_data_dir(self)
        zerochat.save_general_profile({"name": "local", "settings": {"model": "local"}})
        cache = tempfile.TemporaryDirectory()
        self.addCleanup(cache.cleanup)
        full_bin = Path(cache.name) / "chromium-1200" / "chrome-linux64" / "chrome"
        shell_bin = Path(cache.name) / "chromium_headless_shell-1200" / "chrome-headless-shell-linux64" / "chrome-headless-shell"
        full_bin.parent.mkdir(parents=True)
        full_bin.touch()
        shell_bin.parent.mkdir(parents=True)
        shell_bin.touch()

        with patch.dict(os.environ, {"PLAYWRIGHT_BROWSERS_PATH": cache.name}):
            self.assertIsNone(zerochat.playwright_chromium_executable())
            (full_bin.parent.parent / "INSTALLATION_COMPLETE").touch()
            self.assertEqual(zerochat.playwright_chromium_executable(), str(full_bin))
            (shell_bin.parent.parent / "INSTALLATION_COMPLETE").touch()
            self.assertEqual(zerochat.playwright_chromium_executable(), str(shell_bin))

        parser = zerochat.build_parser()
        # --headless y --keep-page exigen --browser; --keep-page no se combina con --headless.
        for bad_args in (
            ["--prompt", "Hola", "--headless"],
            ["--prompt", "Hola", "--keep-page"],
            ["--browser"],
        ):
            with self.subTest(bad_args=bad_args), self.assertRaises(SystemExit) as err:
                zerochat.run_session_from_args(parser, parser.parse_args(bad_args))
            self.assertEqual(err.exception.code, zerochat.RUN_EXIT_ARGS)

    def test_launch_playwright_chromium_y_headless_desactivan_bloqueos_de_red_local(self):
        with patch.object(zerochat, "playwright_chromium_executable", return_value="/bin/chrome-headless-shell"), \
             patch("subprocess.Popen") as mock_popen:
            zerochat.launch_playwright_chromium("https://example.com#token=1")
            args, _ = mock_popen.call_args
            self.assertEqual(args[0], [
                "/bin/chrome-headless-shell",
                "--headless",
                "--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests",
                "https://example.com#token=1",
            ])

        with patch.object(zerochat, "default_browser_executable", return_value="/bin/google-chrome"), \
             patch("subprocess.Popen") as mock_popen:
            zerochat.launch_headless_browser("https://example.com#token=2")
            args, _ = mock_popen.call_args
            self.assertEqual(args[0], [
                "/bin/google-chrome",
                "--headless",
                "--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests",
                "https://example.com#token=2",
            ])
