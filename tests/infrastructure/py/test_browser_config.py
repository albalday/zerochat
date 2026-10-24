import json
import os
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from backend import ZEROCHAT_PY, use_data_dir, zerochat

CONTRACT = json.loads((ZEROCHAT_PY.parent / "tests" / "fixtures" / "mcp" / "contract.json").read_text(encoding="utf-8"))

# CLI simulado de Playwright: --dry-run da las rutas de esta versión; install escribe el progreso
# como sin terminal, espera a que exista "go" y falla con webkit.
PLAYWRIGHT_CLI = '''
const fs = require("fs"), path = require("path");
const cache = CACHE;
const titles = {"chromium": "Chrome for Testing 1", "chromium-headless-shell": "Chrome Headless Shell 1", "firefox": "Firefox 2", "webkit": "WebKit 3"};
const dir = name => path.join(cache, name.replace(/-/g, "_") + "-1");
const args = process.argv.slice(2);
if (args.includes("--dry-run")) {
  for (const name of args.slice(2)) console.log(titles[name] + " (playwright " + name + " v1)\\n  Install location:    " + dir(name) + "\\n");
  process.exit(0);
}
const engine = args[1];
if (engine === "webkit") { console.error("Host system is missing dependencies"); process.exit(1); }
const names = engine === "chromium" ? ["chromium", "chromium-headless-shell"] : [engine];
console.log("Downloading " + titles[names[0]] + " (playwright " + names[0] + " v1) from https://example.invalid");
console.log("|■■■■■■■■■■■■■■■■■■■■■■■■                                                        |  30% of 10 MiB");
const wait = () => {
  if (!fs.existsSync(path.join(cache, "go"))) return setTimeout(wait, 20);
  for (const name of names) { fs.mkdirSync(dir(name), {recursive: true}); fs.writeFileSync(path.join(dir(name), "INSTALLATION_COMPLETE"), ""); }
};
wait();
'''


def playwright_running(status):
    return patch.object(zerochat.GLOBAL_MCP_MANAGER, "list_servers", return_value=[{"id": "playwright", "status": status}])


class PlaywrightLaunchTest(unittest.TestCase):
    def setUp(self):
        data_dir = use_data_dir(self)
        self.config_file = data_dir / "config" / "browser.json"
        self.own = data_dir / "playwright" / "profile"
        self.manager = zerochat.McpServiceManager()
        self.client = Mock(tools=[])
        self.client.running.return_value = True
        self.launched_env = {}

    def launch_args(self, config, browser=None):
        """Arranca Playwright MCP con ese browser.json y devuelve sus argumentos tras el ejecutable."""
        if config is None:
            self.config_file.unlink(missing_ok=True)
        else:
            self.config_file.write_text(config if isinstance(config, str) else json.dumps(config), encoding="utf-8")
        with patch.object(self.manager, "_prepare_service", return_value={"serviceDir": "/svc", "nodeExecutable": "node", "pythonExecutable": "python"}), \
                patch.object(zerochat, "StdioMcpClient", return_value=self.client) as constructor:
            self.manager.start("playwright", remember=False, browser=browser)
            self.manager.close()
        self.launched_env = constructor.call_args.args[3]
        return constructor.call_args.args[1][1:]

    def own_args(self, engine):
        return [f"--browser={engine}", f"--user-data-dir={self.own / engine}"]

    def test_sin_configuracion_valida_se_usa_el_navegador_propio_sin_ventana(self):
        default_args = [*self.own_args("chromium"), "--headless"]
        self.assertEqual(self.launch_args(None), default_args)
        for directory in (self.own.parent, self.own, self.own / "chromium"):
            with self.subTest(directory=directory):
                self.assertEqual(directory.stat().st_mode & 0o777, 0o700)
        self.assertEqual(self.launch_args("{roto"), default_args)
        self.assertEqual(self.launch_args({"mode": "own", "engine": "opera"}), default_args)
        self.assertEqual(self.launch_args({"mode": "own", "engine": "firefox", "headless": False}), self.own_args("firefox"))

    def test_con_el_navegador_del_usuario_manda_la_extension_y_siempre_hay_ventana(self):
        self.assertEqual(self.launch_args({"mode": "user", "userBrowser": "msedge", "headless": True}), ["--extension", "--browser=msedge"])
        # Chromium no es un canal: su ejecutable y su perfil, con el canal chrome; sin Chromium no arranca.
        with patch.object(zerochat, "chromium_install", return_value=("/usr/bin/chromium", Path("/home/u/.config/chromium"))):
            self.assertEqual(self.launch_args({"mode": "user", "userBrowser": "chromium"}), [
                "--extension", "--browser=chrome", "--executable-path=/usr/bin/chromium", "--user-data-dir=/home/u/.config/chromium"])
        with patch.object(zerochat, "chromium_install", return_value=None), self.assertRaisesRegex(RuntimeError, "Chromium"):
            zerochat.playwright_launch_args({**zerochat.BROWSER_CONFIG_DEFAULTS, "mode": "user", "userBrowser": "chromium"})

    def test_el_navegador_del_perfil_sustituye_en_ese_arranque_solo_modo_navegador_y_ventana_pedida(self):
        settings = {"mode": "own", "engine": "firefox", "headless": False, "extensionToken": "abc"}
        self.assertEqual(self.launch_args(settings, {"mode": "user", "userBrowser": "msedge"}), ["--extension", "--browser=msedge"])
        self.assertEqual(self.launched_env["PLAYWRIGHT_MCP_EXTENSION_TOKEN"], "abc")
        self.assertEqual(self.manager.records["playwright"].browser, {"mode": "user", "userBrowser": "msedge"})
        self.assertEqual(self.launch_args({**settings, "mode": "user"}, {"mode": "own", "engine": "webkit"}), self.own_args("webkit"))
        self.assertEqual(self.launch_args(settings), self.own_args("firefox"))
        self.assertEqual(self.manager.records["playwright"].browser, {"mode": "own", "engine": "firefox", "headless": False})
        headless = {**settings, "headless": True}
        self.assertEqual(self.launch_args(headless, {"mode": "own", "engine": "webkit", "headless": False}), self.own_args("webkit"))
        self.assertEqual(self.manager.records["playwright"].browser, {"mode": "own", "engine": "webkit", "headless": False})
        self.assertEqual(self.launch_args(headless, {"mode": "own", "engine": "webkit"})[-1], "--headless")
        self.assertEqual(self.manager.records["playwright"].browser, {"mode": "own", "engine": "webkit"})

    def test_el_navegador_de_un_perfil_se_valida(self):
        for invalid in (None, [], {"mode": "own"}, {"mode": "own", "engine": "opera"}, {"mode": "user", "userBrowser": "firefox"},
                        {"mode": "own", "engine": "chromium", "headless": True}, {"mode": "user", "userBrowser": "chrome", "headless": False},
                        {"mode": "user", "engine": "chromium"}):
            with self.subTest(browser=invalid), self.assertRaisesRegex(ValueError, "browser debe ser"):
                zerochat.validate_profile_browser(invalid)

    def test_el_token_de_la_extension_va_en_el_entorno_y_solo_con_el_navegador_del_usuario(self):
        token = "abc_DEF-123"
        self.assertEqual(self.launch_args({"mode": "user", "userBrowser": "chrome", "extensionToken": token}), ["--extension", "--browser=chrome"])
        self.assertEqual(self.launched_env["PLAYWRIGHT_MCP_EXTENSION_TOKEN"], token)
        self.launch_args({"mode": "own", "extensionToken": token})
        self.assertNotIn("PLAYWRIGHT_MCP_EXTENSION_TOKEN", self.launched_env)

    def test_lo_guardado_se_valida_solo_lo_lee_el_usuario_y_lo_usa_el_siguiente_arranque(self):
        saved = zerochat.save_browser_config({"engine": "webkit", "headless": False})
        self.assertEqual(saved, {"mode": "own", "engine": "webkit", "userBrowser": "chrome", "headless": False, "extensionToken": ""})
        self.assertEqual(self.config_file.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.launch_args(saved), self.own_args("webkit"))
        for raw, message in (
            ([], "objeto"),
            ({"mode": "own", "extra": 1}, "extra"),
            ({"mode": "remote"}, "mode"),
            ({"userBrowser": "firefox"}, "userBrowser"),
            ({"headless": "no"}, "headless"),
        ):
            with self.subTest(raw=raw), self.assertRaisesRegex(ValueError, message):
                zerochat.save_browser_config(raw)
        self.assertEqual(zerochat.load_browser_config(), saved, "un valor rechazado no cambia lo guardado")

    def test_motores_navegadores_y_tokens_coinciden_con_el_cliente(self):
        # Fixture compartido con tests/unit/test_ui_browser.js.
        self.assertEqual(list(zerochat.OWN_BROWSER_ENGINES), CONTRACT["playwrightEngines"])
        self.assertEqual(list(zerochat.ENGINE_CACHE_ENTRIES), CONTRACT["playwrightEngines"])
        self.assertEqual(list(zerochat.USER_BROWSERS), CONTRACT["userBrowsers"])
        for token in CONTRACT["extensionTokens"]["valid"]:
            with self.subTest(token=token):
                self.assertEqual(zerochat.validate_browser_config({"extensionToken": token})["extensionToken"], token)
        for token in CONTRACT["extensionTokens"]["invalid"]:
            with self.subTest(token=token), self.assertRaisesRegex(ValueError, "extensionToken"):
                zerochat.validate_browser_config({"extensionToken": token})

    def test_borrar_los_datos_quita_solo_el_perfil_de_ese_motor_con_playwright_detenido(self):
        for engine in ("chromium", "firefox", "webkit"):
            (self.own / engine).mkdir(parents=True)
        (self.own / "chromium" / "Cookies").write_text("x")
        with playwright_running("starting"), self.assertRaisesRegex(ValueError, "Detén Playwright MCP"):
            zerochat.clear_own_browser_data("chromium")
        self.assertEqual(zerochat.clear_own_browser_data("chromium"), {"cleared": "chromium"})
        self.assertEqual(sorted(path.name for path in self.own.iterdir()), ["firefox", "webkit"])


class UserBrowserExtensionTest(unittest.TestCase):
    def test_la_extension_cuenta_como_instalada_si_algun_perfil_la_tiene(self):
        profiles = use_data_dir(self) / "user-browsers"
        (profiles / "chrome" / "Profile 2" / "Extensions" / zerochat.PLAYWRIGHT_EXTENSION_ID / "1.0_0").mkdir(parents=True)
        (profiles / "msedge" / "Default" / "Extensions" / "otra").mkdir(parents=True)
        data_dirs = {"chrome": profiles / "chrome", "msedge": profiles / "msedge", "chromium": None}
        with patch.object(zerochat, "user_browser_data_dir", side_effect=data_dirs.get):
            self.assertEqual(zerochat.user_browser_extensions(), {"chrome": True, "msedge": False, "chromium": False})


@unittest.skipIf(os.name == "nt", "CLI simulado con Node en POSIX")
class BrowserEnginesTest(unittest.TestCase):
    def setUp(self):
        data_dir = use_data_dir(self)
        self.cache = data_dir / "cache"
        self.cli = data_dir / "services" / "playwright" / "node_modules" / "playwright" / "cli.js"
        self.cli.parent.mkdir(parents=True)
        self.cli.write_text(PLAYWRIGHT_CLI.replace("CACHE", json.dumps(str(self.cache))), encoding="utf-8")
        self.cache.mkdir()
        (self.cache / "ffmpeg-1").mkdir()
        self.engines = zerochat.BrowserEngines()

    def engine(self, engine_id):
        return next(item for item in self.engines.list()["engines"] if item["id"] == engine_id)

    def settled(self, engine_id):
        for _ in range(250):
            item = self.engine(engine_id)
            if item.get("status") != "installing":
                return item
            time.sleep(0.02)
        self.fail("la instalación no terminó")

    def test_los_motores_se_listan_instalan_con_progreso_y_quitan_en_su_cache(self):
        self.assertEqual([(item["id"], item["title"], item["installed"]) for item in self.engines.list()["engines"]], [
            ("chromium", "Chrome for Testing 1", False), ("firefox", "Firefox 2", False), ("webkit", "WebKit 3", False)])

        self.engines.install("chromium")
        for _ in range(250):
            progress = self.engine("chromium")
            if progress.get("percent"):
                break
            time.sleep(0.02)
        self.assertEqual(progress, {"id": "chromium", "title": "Chrome for Testing 1", "installed": False,
                                    "status": "installing", "download": "Chrome for Testing 1", "percent": 30})
        for engine_id in ("chromium", "opera"):
            with self.subTest(engine=engine_id), self.assertRaises(ValueError, msg="instalación repetida o motor desconocido"):
                self.engines.install(engine_id)
        (self.cache / "go").write_text("")
        self.assertEqual(self.settled("chromium"), {"id": "chromium", "title": "Chrome for Testing 1", "installed": True})
        self.engines.install("webkit")
        failed = self.settled("webkit")
        self.assertEqual((failed["status"], failed["installed"]), ("error", False))
        self.assertIn("missing dependencies", failed["error"])

        # Quitar un motor exige Playwright MCP detenido y conserva ffmpeg, común a todos.
        with playwright_running("running"), self.assertRaisesRegex(ValueError, "Detén Playwright MCP"):
            self.engines.remove("chromium")
        # Al quitar el motor elegido, la configuración pasa a otro instalado.
        self.engines.install("firefox")
        self.assertTrue(self.settled("firefox")["installed"])
        self.assertIs(next(item for item in self.engines.remove("chromium")["engines"] if item["id"] == "chromium")["installed"], False)
        self.assertEqual(sorted(path.name for path in self.cache.iterdir()), ["ffmpeg-1", "firefox-1", "go"])
        self.assertEqual(zerochat.load_browser_config()["engine"], "firefox")
        self.engines.remove("firefox")
        self.assertEqual(zerochat.load_browser_config()["engine"], "firefox", "sin otro instalado se conserva")

        self.cli.unlink()
        self.assertEqual(self.engines.list(), {"systemBrowsers": zerochat.system_browsers(), "extensions": zerochat.user_browser_extensions(), "engines": []})
