import json
import subprocess
import threading
import unittest
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from backend import use_data_dir, zerochat

# Una interfaz mínima: js/run-node.js con dependencias en dos niveles, una que sube de carpeta, y una librería
# que se pide al usarla (como ChatVendorLoader). startHeadlessRun imprime lo que ve y termina.
SITE = {
    "js/run-node.js": """
const a = require('./a.js');
const os = require('node:os');
module.exports = {
  startHeadlessRun: async argv => {
    const vendor = await globalThis.ChatRunnerSource('js/vendor/lib.js');
    console.log(JSON.stringify({ a: a.value, argv, vendor, node: typeof os.platform }));
  }
};""",
    "js/a.js": "module.exports = { value: 'a+' + require('./tools/b.js').value };",
    "js/tools/b.js": "module.exports = { value: 'b+' + require('../c.js').value };",
    "js/c.js": "module.exports = { value: 'c' };",
    "js/vendor/lib.js": "vendor-v1",
}


class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


class RunnerLoaderTest(unittest.TestCase):
    def setUp(self):
        base = use_data_dir(self)
        self.site = base / "site"
        for name, text in SITE.items():
            (self.site / name).parent.mkdir(parents=True, exist_ok=True)
            (self.site / name).write_text(text, encoding="utf-8")
        self.cache_dir = base / "cache"
        self.cache_dir.mkdir()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), partial(Quiet, directory=str(self.site)))
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/zerochat.html#run=r1"

    def go_offline(self):
        """Sin servidor que escuche: la conexión se rechaza, como sin red."""
        self.server.shutdown()
        self.server.server_close()

    def run_loader(self):
        node = zerochat.find_node_executable()
        cmd = [node, "--permission", f"--allow-fs-read={self.cache_dir}", f"--allow-fs-write={self.cache_dir}",
               "-e", zerochat.RUNNER_LOADER_SCRIPT, str(self.cache_dir / "modules.json"), self.url]
        return subprocess.run(cmd, capture_output=True, text=True, timeout=30)

    def test_descarga_los_modulos_y_sin_conexion_usa_la_ultima_copia(self):
        online = self.run_loader()
        self.assertEqual(online.returncode, 0, online.stderr)
        self.assertEqual(json.loads(online.stdout), {"a": "a+b+c", "argv": [self.url], "vendor": "vendor-v1", "node": "function"})
        cached = json.loads((self.cache_dir / "modules.json").read_text(encoding="utf-8"))
        self.assertEqual(sorted(cached["files"]), sorted(SITE))

        # Una copia nueva publicada sustituye a la guardada.
        (self.site / "js" / "c.js").write_text("module.exports = { value: 'c2' };", encoding="utf-8")
        self.assertEqual(json.loads(self.run_loader().stdout)["a"], "a+b+c2")

        self.go_offline()
        offline = self.run_loader()
        self.assertEqual(offline.returncode, 0, offline.stderr)
        self.assertEqual(json.loads(offline.stdout)["a"], "a+b+c2")
        self.assertIn("using the cached copy", offline.stderr)

    def test_una_respuesta_de_error_no_ejecuta_la_copia_guardada(self):
        self.assertEqual(self.run_loader().returncode, 0)
        (self.site / "js" / "tools" / "b.js").unlink()
        result = self.run_loader()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        self.assertIn("js/tools/b.js: HTTP 404", result.stderr)

    def test_sin_conexion_ni_copia_guardada_falla(self):
        self.go_offline()
        result = self.run_loader()
        self.assertEqual(result.returncode, 1)
        self.assertIn("Fatal error", result.stderr)

    def test_lo_descargado_tiene_tope_de_tamano(self):
        others = sum(len(text) for name, text in SITE.items() if name not in ("js/c.js", "js/vendor/lib.js"))
        head = "module.exports = { value: 'c' };//"
        for extra, code in ((0, 0), (1, 1)):
            with self.subTest(extra=extra):
                padding = zerochat.RUNNER_MAX_BYTES - others - len(head) + extra
                (self.site / "js" / "c.js").write_text(head + "x" * padding, encoding="utf-8")
                result = self.run_loader()
                self.assertEqual(result.returncode, code, result.stderr)
                if code:
                    self.assertIn(f"exceed {zerochat.RUNNER_MAX_BYTES} bytes", result.stderr)
