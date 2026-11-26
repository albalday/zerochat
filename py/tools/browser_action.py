"""Herramienta browser_action: una sesión persistente de Playwright con los motores propios o el navegador del sistema."""

from __future__ import annotations

import atexit
import collections
import json
import os
import shutil
import subprocess
import threading
import urllib.parse

from browser.engines import (
    ENGINE_CACHE_ENTRIES,
    cached_engine_entries,
    playwright_service_cli,
    playwright_service_module,
    system_browsers,
)
from core.environment import DETECTED_OS
from core.process import _kill_process_tree
from tools.common import _tool_error
from web.fetch import is_metadata_host

BROWSER_ACTIONS = ("navigate", "screenshot", "click", "fill")
# Plazo de cada respuesta del proceso del navegador (y de su arranque): sus acciones tienen ya plazos de 15-30 s,
# así que pasado este el proceso está colgado y se termina.
BROWSER_ACTION_TIMEOUT_SECONDS = 60
# Últimas líneas de stderr que se conservan para explicar un arranque fallido.
BROWSER_STDERR_TAIL_LINES = 20


class PersistentBrowserSession:
    """Manages a persistent headless browser session (Playwright) for browser_action."""

    def __init__(self):
        self._lock = threading.Lock()
        self._process: subprocess.Popen | None = None
        self._stderr_tail: collections.deque[str] = collections.deque(maxlen=BROWSER_STDERR_TAIL_LINES)
        atexit.register(self.close)

    @staticmethod
    def _drain_stderr(proc: subprocess.Popen, tail: collections.deque):
        """Lee stderr entero (sin leerlo, el proceso se bloquearía al llenarse la tubería) y guarda su final."""
        try:
            for line in proc.stderr:
                tail.append(line.rstrip())
        except (OSError, ValueError, TypeError):
            pass

    def _read_line(self, proc: subprocess.Popen) -> str | None:
        """Una línea de stdout ("" si el proceso la cerró), o None si no llega en el plazo: el proceso se termina."""
        box: list[str] = []
        reader = threading.Thread(target=lambda: box.append(proc.stdout.readline()), daemon=True)
        reader.start()
        reader.join(BROWSER_ACTION_TIMEOUT_SECONDS)
        if reader.is_alive():
            self._close_locked()
            return None
        return box[0] if box else ""

    def _ensure_running(self) -> subprocess.Popen:
        if self._process is not None and self._process.poll() is None:
            return self._process

        node = shutil.which("node")
        if not node:
            raise RuntimeError("Node.js is not installed or not found in system PATH.")

        runner_js = """
const readline = require('readline');
let playwright;
try {
  playwright = require(process.env.ZEROCHAT_PLAYWRIGHT_MODULE);
} catch (e) {
  console.log(JSON.stringify({
    success: false,
    error: "Playwright is not available. Start the Playwright service once in Settings > MCP to install it."
  }));
  process.exit(1);
}

(async () => {
  let browser, context, page;
  try {
    const candidates = [
      {},                      // 1. Playwright bundled Chromium
      { channel: 'chrome' },   // 2. System Google Chrome
      { channel: 'msedge' },   // 3. System Microsoft Edge
      { channel: 'chromium' }  // 4. Playwright full Chromium, if only the headless shell is missing
    ];
    let lastErr = null;
    for (const cand of candidates) {
      try {
        browser = await playwright.chromium.launch({ ...cand, headless: true });
        if (browser) break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!browser) {
      throw lastErr || new Error('No Chromium-based browser found (Playwright, Chrome, Edge, or Chromium).');
    }
    context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    page = await context.newPage();
  } catch (err) {
    console.log(JSON.stringify({ success: false, error: 'Failed to start browser: ' + err.message }));
    process.exit(1);
  }

  console.log(JSON.stringify({ ready: true }));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let req;
    try {
      req = JSON.parse(line);
    } catch (e) {
      console.log(JSON.stringify({ success: false, error: 'Invalid command JSON' }));
      continue;
    }

    try {
      const act = req.action;
      if (act === 'navigate') {
        if (!req.url) throw new Error("Parameter 'url' is required for action 'navigate'");
        await page.goto(req.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        console.log(JSON.stringify({
          success: true,
          action: 'navigate',
          url: page.url(),
          title: await page.title()
        }));
      } else if (act === 'screenshot') {
        if (req.url && req.url !== page.url()) {
          await page.goto(req.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        }
        // Con la máquina cargada, Chromium puede no haber pintado aún ningún fotograma:
        // esperar dos fotogramas garantiza que hay algo que capturar.
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const buf = await page.screenshot({ fullPage: false });
        console.log(JSON.stringify({
          success: true,
          action: 'screenshot',
          image_base64: buf.toString('base64'),
          mime_type: 'image/png',
          url: page.url(),
          title: await page.title()
        }));
      } else if (act === 'click') {
        if (!req.selector) throw new Error("Parameter 'selector' is required for action 'click'");
        await page.click(req.selector, { timeout: 15000 });
        console.log(JSON.stringify({
          success: true,
          action: 'click',
          selector: req.selector,
          url: page.url()
        }));
      } else if (act === 'fill') {
        if (!req.selector) throw new Error("Parameter 'selector' is required for action 'fill'");
        await page.fill(req.selector, req.value || '', { timeout: 15000 });
        console.log(JSON.stringify({
          success: true,
          action: 'fill',
          selector: req.selector,
          value: req.value || '',
          url: page.url()
        }));
      } else if (act === 'close') {
        await browser.close();
        console.log(JSON.stringify({ success: true, action: 'close' }));
        process.exit(0);
      } else {
        console.log(JSON.stringify({ success: false, error: 'Unsupported action: ' + act }));
      }
    } catch (err) {
      console.log(JSON.stringify({ success: false, error: err.message, action: req.action }));
    }
  }
})();
"""
        proc = subprocess.Popen(
            [node, "-e", runner_js],
            env={**os.environ, "ZEROCHAT_PLAYWRIGHT_MODULE": str(playwright_service_module())},
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1,
            # Grupo propio: al terminarlo se termina también Chromium.
            start_new_session=DETECTED_OS != "windows",
        )
        self._process = proc
        self._stderr_tail.clear()
        drain = threading.Thread(target=self._drain_stderr, args=(proc, self._stderr_tail), daemon=True)
        drain.start()
        first_line = self._read_line(proc)
        if first_line is None:
            raise RuntimeError(f"The headless browser did not start within {BROWSER_ACTION_TIMEOUT_SECONDS} s.")
        if not first_line:
            drain.join(1)
            err = "\n".join(self._stderr_tail)
            self._process = None
            raise RuntimeError(f"Failed to initialize headless browser: {err or 'process terminated unexpectedly'}")
        data = json.loads(first_line)
        if not data.get("ready"):
            self._process = None
            raise RuntimeError(data.get("error", "Unknown error starting browser"))

        return proc

    def execute(self, command: dict) -> dict:
        with self._lock:
            try:
                proc = self._ensure_running()
            except Exception as e:
                return {"success": False, "error": str(e)}

            req_json = json.dumps(command, ensure_ascii=False) + "\n"
            try:
                proc.stdin.write(req_json)
                proc.stdin.flush()
                resp_line = self._read_line(proc)
                if resp_line is None:
                    return {"success": False, "error": f"The browser did not answer within {BROWSER_ACTION_TIMEOUT_SECONDS} s and was closed."}
                if not resp_line:
                    self._close_locked()
                    return {"success": False, "error": "Browser process closed unexpectedly."}
                return json.loads(resp_line)
            except Exception as e:
                self._close_locked()
                return {"success": False, "error": f"Error executing browser action: {e}"}

    def close(self):
        with self._lock:
            self._close_locked()

    def _close_locked(self):
        """Cierra el navegador con self._lock tomado: se lo pide y, si no termina, termina su grupo de procesos."""
        proc, self._process = self._process, None
        if proc is None or proc.poll() is not None:
            return
        try:
            proc.stdin.write(json.dumps({"action": "close"}) + "\n")
            proc.stdin.flush()
            proc.wait(timeout=2)
        except (OSError, ValueError, subprocess.SubprocessError):
            _kill_process_tree(proc)


_BROWSER_SESSION = PersistentBrowserSession()


def close_browser_session():
    """Cierra el navegador de browser_action, si está abierto (al detener el servidor)."""
    _BROWSER_SESSION.close()


def browser_action_availability() -> dict:
    """Comprueba requisitos locales sin lanzar Node.js ni Chromium."""
    if not shutil.which("node"):
        return {"available": False, "error": "Node.js is not installed or not found in system PATH."}
    # Solo el Playwright del servicio, no el node_modules de la carpeta desde la que arranca el servidor.
    if not playwright_service_cli().is_file():
        return {"available": False, "error": "Playwright is not available."}
    # El runner prueba las entradas de Chromium de Playwright y los canales chrome y msedge.
    browsers = system_browsers()
    if cached_engine_entries() & set(ENGINE_CACHE_ENTRIES["chromium"]) or browsers["chrome"] or browsers["msedge"]:
        return {"available": True}
    return {"available": False, "error": "Playwright Chromium is not installed."}


def playwright_status() -> dict:
    """Playwright del servicio y browser_action tal como están ahora, para el latido del cliente."""
    return {"installed": playwright_service_cli().is_file(), "browserAction": browser_action_availability()}


def browser_url_error(url: str) -> str | None:
    """Por qué browser_action no abre la URL, o None: solo http(s), y nunca metadatos cloud ni enlace local.
    localhost y la red privada sí, para probar webs en desarrollo. Solo se valida la URL pedida: lo que la
    página abra después queda fuera."""
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https"):
        return f"browser_action only opens http:// and https:// URLs, not '{parsed.scheme or url}'."
    if not parsed.hostname:
        return "The URL has no valid host name."
    if is_metadata_host(parsed.hostname):
        return "Access blocked: the URL points to cloud metadata or a link-local address."
    return None


def browser_action(action: str, url: str | None = None, selector: str | None = None, value: str | None = None) -> str:
    """Control a headless browser for UI testing and visual inspection."""
    try:
        act = (action or "").strip().lower()
        if act not in BROWSER_ACTIONS:
            return _tool_error(f"Invalid browser action: '{action}'. Valid actions: {', '.join(BROWSER_ACTIONS)}.")

        cmd = {"action": act}
        if url:
            cmd["url"] = str(url).strip()
            error = browser_url_error(cmd["url"])
            if error:
                return _tool_error(error)
        if selector:
            cmd["selector"] = str(selector).strip()
        if value is not None:
            cmd["value"] = str(value)

        result = _BROWSER_SESSION.execute(cmd)
        return json.dumps(result, ensure_ascii=False, indent=2)
    except Exception as e:
        return _tool_error(str(e))
