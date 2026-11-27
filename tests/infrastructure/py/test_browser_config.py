import json
import os
import shutil
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
        self.own = data_dir / "playwright" / "profile"
        # El servicio que el catálogo instala, tal como está en services/.
        service = data_dir / "services" / "playwright" / "service.json"
        service.parent.mkdir(parents=True)
        shutil.copyfile(ZEROCHAT_PY.parent / "services" / "playwright" / "service.json", service)
        self.manager = zerochat.McpServiceManager()
        self.client = Mock(tools=[])
        self.client.running.return_value = True
        self.launched_env = {}

    def launch_args(self, config):
        """Arranca Playwright MCP con esa configuración en SQLite y devuelve sus argumentos tras el ejecutable."""
        if config is None:
            with zerochat.open_storage() as conn:
                conn.execute("DELETE FROM settings WHERE key = ?;", (zerochat.BROWSER_CONFIG_KEY,))
                conn.execute("DELETE FROM secrets WHERE name = ?;", (zerochat.BROWSER_EXTENSION_TOKEN_KEY,))
                conn.commit()
        elif isinstance(config, str):
            with zerochat.open_storage() as conn:
                conn.execute(
                    "INSERT OR REPLACE INTO settings (key, value_json, updated_at) VALUES (?, ?, 0);",
                    (zerochat.BROWSER_CONFIG_KEY, config),
                )
                conn.commit()
        else:
            zerochat.set_setting(zerochat.BROWSER_CONFIG_KEY, config)
        with patch.object(self.manager, "_prepare_service", return_value={"serviceDir": "/svc", "nodeExecutable": "node", "pythonExecutable": "python"}), \
                patch.object(zerochat, "StdioMcpClient", return_value=self.client) as constructor:
            self.manager.start("playwright")
            self.manager.close()
        self.launched_env = constructor.call_args.args[3]
        self.assertEqual(constructor.call_args.args[1][:2], ["/svc/node_modules/@playwright/mcp/cli.js", "--caps=vision,storage"])
        return constructor.call_args.args[1][2:]

    def own_args(self, engine):
        # El motor propio arranca con el User-Agent activo de las salidas web (web/fetch.py).
        return [f"--browser={engine}", "--isolated", f"--user-agent={zerochat.SERVICE_USER_AGENT}"]

    def test_sin_configuracion_valida_se_usa_el_navegador_propio_aislado_sin_ventana(self):
        default_args = [*self.own_args("chromium"), "--headless"]
        self.assertEqual(self.launch_args(None), default_args)
        self.assertFalse(self.own.exists(), "en modo aislado no se crea carpeta de perfil en disco")
        self.assertEqual(self.launch_args("{roto"), default_args)
        self.assertEqual(self.launch_args({"mode": "own", "engine": "opera"}), default_args)
        self.assertEqual(self.launch_args({"mode": "own", "engine": "firefox", "headless": False}), self.own_args("firefox"))

    def test_el_user_agent_solo_aplica_a_los_motores_propios(self):
        """--user-agent viaja con los motores propios; el navegador del usuario pone el suyo."""
        original = zerochat.SERVICE_USER_AGENT
        try:
            zerochat.set_service_user_agent("Mozilla/5.0 (FrontendTest/1.0)")
            self.assertEqual(zerochat.SERVICE_USER_AGENT, "Mozilla/5.0 (FrontendTest/1.0)")
            self.assertEqual(
                zerochat.playwright_launch_args({**zerochat.BROWSER_CONFIG_DEFAULTS, "mode": "own", "engine": "firefox"},
                                                 zerochat.SERVICE_USER_AGENT),
                ["--browser=firefox", "--isolated", "--user-agent=Mozilla/5.0 (FrontendTest/1.0)", "--headless"])
            # Modo user: sin --user-agent.
            self.assertEqual(zerochat.playwright_launch_args({"mode": "user", "userBrowser": "msedge"},
                                                             zerochat.SERVICE_USER_AGENT),
                             ["--extension", "--browser=msedge"])
            # Sin User-Agent: sin la bandera.
            self.assertEqual(zerochat.playwright_launch_args({**zerochat.BROWSER_CONFIG_DEFAULTS, "mode": "own", "engine": "firefox"}, None),
                             ["--browser=firefox", "--isolated", "--headless"])
        finally:
            zerochat.set_service_user_agent(original)

    def test_con_el_navegador_del_usuario_manda_la_extension_el_token_va_en_entorno_y_siempre_hay_ventana(self):
        token = "abc_DEF-123"
        self.assertEqual(self.launch_args({"mode": "user", "userBrowser": "msedge", "headless": True}), ["--extension", "--browser=msedge"])
        self.assertNotIn("PLAYWRIGHT_MCP_EXTENSION_TOKEN", self.launched_env)
        zerochat.save_extension_token(token)
        self.launch_args({"mode": "user", "userBrowser": "msedge"})
        self.assertEqual(self.launched_env["PLAYWRIGHT_MCP_EXTENSION_TOKEN"], token)
        self.launch_args({"mode": "own"})
        self.assertNotIn("PLAYWRIGHT_MCP_EXTENSION_TOKEN", self.launched_env)
        # Chromium no es un canal: su ejecutable y su perfil, con el canal chrome; sin Chromium no arranca.
        with patch.object(zerochat, "chromium_install", return_value=("/usr/bin/chromium", Path("/home/u/.config/chromium"))):
            self.assertEqual(self.launch_args({"mode": "user", "userBrowser": "chromium"}), [
                "--extension", "--browser=chrome", "--executable-path=/usr/bin/chromium", f"--user-data-dir={Path('/home/u/.config/chromium')}"])
        with patch.object(zerochat, "chromium_install", return_value=None), self.assertRaisesRegex(RuntimeError, "Chromium"):
            zerochat.playwright_launch_args({**zerochat.BROWSER_CONFIG_DEFAULTS, "mode": "user", "userBrowser": "chromium"})

    def test_lo_guardado_se_valida_solo_lo_lee_el_usuario_y_lo_usa_el_siguiente_arranque(self):
        saved = zerochat.save_browser_config({"engine": "webkit", "headless": False})
        self.assertEqual(saved, {
            "mode": "own",
            "engine": "webkit",
            "userBrowser": "chrome",
            "headless": False,
            "userAgentMode": "auto",
            "userAgent": "",
        })
        if os.name != "nt":  # Windows no aplica los permisos POSIX de chmod
            self.assertEqual(zerochat.get_storage_db_path().stat().st_mode & 0o777, 0o600)
        self.assertEqual(zerochat.load_browser_config(), saved)
        self.assertEqual(self.launch_args(saved), self.own_args("webkit"))
        for raw, message in (
            ([], "objeto"),
            ({"mode": "own", "extra": 1}, "extra"),
            ({"extensionToken": "tok_1"}, "extensionToken"),
            ({"mode": "remote"}, "mode"),
            ({"userBrowser": "firefox"}, "userBrowser"),
            ({"headless": "no"}, "headless"),
            ({"userAgentMode": "invalid"}, "userAgentMode"),
            ({"userAgentMode": "custom", "userAgent": "  "}, "obligatorio"),
            ({"userAgent": "UA\nEvil"}, "saltos"),
            ({"userAgent": "x" * (zerochat.USER_AGENT_MAX_LEN + 1)}, str(zerochat.USER_AGENT_MAX_LEN)),
        ):
            with self.subTest(raw=raw), self.assertRaisesRegex(ValueError, message):
                zerochat.save_browser_config(raw)
        self.assertEqual(zerochat.load_browser_config(), saved, "un valor rechazado no cambia lo guardado")

    def test_el_token_de_la_extension_es_de_solo_escritura(self):
        """Se guarda ofuscado y ningún método lo devuelve: solo si está guardado."""
        token = "tok_secret_1"
        self.assertEqual(zerochat.dispatch_browser("zerochat/browser/extension_token/set", {"token": token}),
                         ({"extensionTokenConfigured": True}, None, ""))
        with zerochat.open_storage() as conn:
            stored = conn.execute("SELECT value FROM secrets WHERE name = ?;", (zerochat.BROWSER_EXTENSION_TOKEN_KEY,)).fetchone()["value"]
        self.assertTrue(stored.startswith(zerochat.OBFUSCATION_PREFIX))
        saved, _, _ = zerochat.dispatch_browser("zerochat/browser/config/set", {"config": {"mode": "user"}})
        listing, _, _ = zerochat.dispatch_browser("zerochat/browser/engines/list", {"engines_only": True})
        self.assertIs(listing["extensionTokenConfigured"], True)
        for response in (saved, listing):
            self.assertNotIn(token, json.dumps(response))
        self.assertEqual(zerochat.dispatch_browser("zerochat/browser/extension_token/set", {"token": None}),
                         ({"extensionTokenConfigured": False}, None, ""))
        self.assertIsNone(zerochat.get_secret(zerochat.BROWSER_EXTENSION_TOKEN_KEY))
        result, error, _ = zerochat.dispatch_browser("zerochat/browser/extension_token/set", {"token": "mal token"})
        self.assertIsNone(result)
        self.assertIn("token", error["message"])

    def test_canal_chrome_y_modos_de_user_agent_en_modo_propio(self):
        # Los navegadores instalados en modo propio son reales y actualizados: envían su User-Agent, aunque se pida uno
        # personalizado (que entonces puede quedar vacío).
        chrome_cfg = zerochat.save_browser_config({"mode": "own", "engine": "chrome", "headless": True,
                                                   "userAgentMode": "custom", "userAgent": ""})
        self.assertEqual(self.launch_args(chrome_cfg), ["--browser=chrome", "--isolated", "--headless"])
        sys_chromium_cfg = zerochat.save_browser_config({"mode": "own", "engine": "system-chromium", "headless": True})
        with patch.object(zerochat, "chromium_install", return_value=("/usr/bin/chromium", Path("/home/u/.config/chromium"))):
            self.assertEqual(
                self.launch_args(sys_chromium_cfg),
                ["--browser=chrome", "--isolated", "--executable-path=/usr/bin/chromium", "--headless"],
            )
        with patch.object(zerochat, "chromium_install", return_value=None), self.assertRaisesRegex(RuntimeError, "Chromium"):
            zerochat.playwright_launch_args(sys_chromium_cfg)

        # Custom User-Agent prevalece sobre el del servidor.
        custom_cfg = zerochat.save_browser_config({"userAgentMode": "custom", "userAgent": "Mozilla/5.0 Custom/99.0"})
        self.assertEqual(
            self.launch_args(custom_cfg),
            ["--browser=chromium", "--isolated", "--user-agent=Mozilla/5.0 Custom/99.0", "--headless"],
        )

        # Rotate elige dentro del conjunto de UAs modernos (y el guardado si existe).
        rotate_cfg = zerochat.save_browser_config({"userAgentMode": "rotate"})
        args_rotate = self.launch_args(rotate_cfg)
        ua_flag = next(a for a in args_rotate if a.startswith("--user-agent="))
        self.assertIn(ua_flag.split("=", 1)[1], (*zerochat.MODERN_USER_AGENTS, zerochat.SERVICE_USER_AGENT))

        # Auto en desatendido reutiliza el último User-Agent real guardado en SQLite.
        orig_active, orig_service, orig_captured = (
            zerochat.ACTIVE_USER_AGENT,
            zerochat.SERVICE_USER_AGENT,
            zerochat._FRONTEND_USER_AGENT_CAPTURED,
        )
        try:
            zerochat.ACTIVE_USER_AGENT = zerochat.DEFAULT_USER_AGENT
            zerochat.capture_frontend_user_agent("Mozilla/5.0 RealBrowser/144.0")
            self.assertEqual(zerochat.load_last_frontend_user_agent(), "Mozilla/5.0 RealBrowser/144.0")
            # Simulamos un arranque desatendido nuevo donde no hubo petición del frontend.
            zerochat.ACTIVE_USER_AGENT = zerochat.DEFAULT_USER_AGENT
            zerochat.set_service_user_agent(zerochat.DEFAULT_USER_AGENT, from_frontend=False)
            self.assertEqual(zerochat.effective_user_agent(), "Mozilla/5.0 RealBrowser/144.0")
            # Sin captura en este proceso, SQLite se lee una sola vez y no en cada petición web.
            with patch.object(zerochat, "_STORED_USER_AGENT_LOADED", False), \
                    patch.object(zerochat, "load_last_frontend_user_agent", wraps=zerochat.load_last_frontend_user_agent) as load:
                for _ in range(2):
                    self.assertEqual(zerochat.effective_user_agent(), "Mozilla/5.0 RealBrowser/144.0")
                self.assertEqual(load.call_count, 1)
            auto_cfg = zerochat.save_browser_config({"userAgentMode": "auto"})
            self.assertEqual(
                self.launch_args(auto_cfg),
                ["--browser=chromium", "--isolated", "--user-agent=Mozilla/5.0 RealBrowser/144.0", "--headless"],
            )
        finally:
            zerochat.ACTIVE_USER_AGENT = orig_active
            zerochat.set_service_user_agent(orig_service, from_frontend=orig_captured)

    def test_motores_navegadores_y_tokens_coinciden_con_el_cliente(self):
        # Fixture compartido con tests/unit/test_ui_browser.js.
        self.assertEqual(list(zerochat.BROWSER_TOOLS), CONTRACT["browserTools"])
        self.assertEqual(list(zerochat.OWN_BROWSER_ENGINES), CONTRACT["playwrightEngines"])
        self.assertEqual(list(zerochat.OWN_SYSTEM_ENGINES), CONTRACT["ownSystemEngines"])
        self.assertEqual(list(zerochat.USER_AGENT_MODES), CONTRACT["userAgentModes"])
        self.assertEqual(zerochat.USER_AGENT_MAX_LEN, CONTRACT["userAgentMaxLength"])
        self.assertEqual(list(zerochat.ENGINE_CACHE_ENTRIES), CONTRACT["playwrightEngines"])
        self.assertEqual(list(zerochat.USER_BROWSERS), CONTRACT["userBrowsers"])
        for token in CONTRACT["extensionTokens"]["valid"]:
            with self.subTest(token=token):
                self.assertIs(zerochat.save_extension_token(token), True)
                self.assertEqual(zerochat.get_secret(zerochat.BROWSER_EXTENSION_TOKEN_KEY), token)
        for token in CONTRACT["extensionTokens"]["invalid"]:
            with self.subTest(token=token), self.assertRaisesRegex(ValueError, "token"):
                zerochat.save_extension_token(token)



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

    def settled(self, engine_id, since_rev=None):
        deadline = time.monotonic() + 5.0
        rev = since_rev
        while time.monotonic() < deadline:
            data = self.engines.list(since_rev=rev, wait_ms=500, engines_only=rev is not None)
            item = next(item for item in data["engines"] if item["id"] == engine_id)
            if item.get("status") != "installing":
                return item
            rev = data["rev"]
        self.fail("la instalación no terminó")

    def test_los_motores_se_listan_instalan_con_progreso_y_quitan_en_su_cache(self):
        self.assertEqual([(item["id"], item["title"], item["installed"]) for item in self.engines.list()["engines"]], [
            ("chromium", "Chrome for Testing 1", False), ("firefox", "Firefox 2", False), ("webkit", "WebKit 3", False)])

        started = self.engines.install("chromium")
        rev = started["rev"]
        progress = next(item for item in started["engines"] if item["id"] == "chromium")
        for _ in range(10):
            if progress.get("percent"):
                break
            update = self.engines.list(since_rev=rev, wait_ms=1000, engines_only=True)
            self.assertNotIn("systemBrowsers", update)
            self.assertNotIn("extensions", update)
            rev = update["rev"]
            progress = next(item for item in update["engines"] if item["id"] == "chromium")
        self.assertEqual(progress, {"id": "chromium", "title": "Chrome for Testing 1", "installed": False,
                                    "status": "installing", "download": "Chrome for Testing 1", "percent": 30})
        for engine_id in ("chromium", "opera"):
            with self.subTest(engine=engine_id), self.assertRaises(ValueError, msg="instalación repetida o motor desconocido"):
                self.engines.install(engine_id)
        (self.cache / "go").write_text("")
        self.assertEqual(self.settled("chromium", since_rev=rev), {"id": "chromium", "title": "Chrome for Testing 1", "installed": True})
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
        removed = self.engines.remove("chromium")
        self.assertIs(next(item for item in removed["engines"] if item["id"] == "chromium")["installed"], False)
        self.assertEqual(removed["config"]["engine"], "firefox")
        self.assertEqual(sorted(path.name for path in self.cache.iterdir()), ["ffmpeg-1", "firefox-1", "go"])
        self.assertEqual(zerochat.load_browser_config()["engine"], "firefox")
        self.engines.remove("firefox")
        self.assertEqual(zerochat.load_browser_config()["engine"], "firefox", "sin otro instalado se conserva")

        self.cli.unlink()
        listing = self.engines.list()
        self.assertEqual({k: v for k, v in listing.items() if k != "rev"}, {
            "systemBrowsers": zerochat.system_browsers(),
            "extensions": zerochat.user_browser_extensions(),
            "engines": [],
            "config": zerochat.load_browser_config(),
            "extensionTokenConfigured": False,
        })
