#!/usr/bin/env python3
"""
test-composio-oauth.py — Herramienta de diagnóstico para el flujo OAuth de Composio.

Lanza mcp-remote/proxy.js exactamente igual que lo hace ZeroChat (incluyendo la
variable BROWSER que apunta a zerochat-open-url) y muestra en tiempo real toda la
salida del proceso para trazar el diálogo OAuth.

Uso:
    python3 scripts/test-composio-oauth.py [opciones]

Opciones:
    --no-browser-fix   Usar termux-open-url directo (reproduce el comportamiento pre-8.7.0)
    --verbose          Mostrar también las líneas JSON-RPC que se envían/reciben
    --clean            Borrar los tokens OAuth almacenados antes de arrancar (fuerza re-autenticación)
    --sleep N          Esperar N segundos antes de lanzar (para cambiarse de app y probar el caso sin foco)

El script envía el handshake MCP mínimo (initialize → notifications/initialized → tools/list)
para que mcp-remote complete el arranque y lance el OAuth si no hay tokens válidos.
Pulsa Ctrl+C para salir.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path


# ---------------------------------------------------------------------------
# Configuración — rutas derivadas de la instalación estándar de ZeroChat
# ---------------------------------------------------------------------------

def find_zerochat_data_dir() -> Path:
    """Devuelve ~/zerochat como directorio de datos de ZeroChat."""
    return Path.home() / "zerochat"


def find_node() -> str:
    node = shutil.which("node")
    if not node:
        sys.exit("ERROR: No se encontró 'node' en el PATH. Instala Node.js >= 18.")
    return node


def find_termux_open_url() -> str | None:
    """Localiza termux-open-url incluso si el PATH del venv es incompleto."""
    if shutil.which("termux-open-url"):
        return "termux-open-url"
    prefix = os.environ.get("PREFIX", "/data/data/com.termux/files/usr")
    candidate = Path(prefix) / "bin" / "termux-open-url"
    if candidate.is_file():
        return str(candidate)
    return None


def is_termux() -> bool:
    return bool(
        os.environ.get("TERMUX_VERSION")
        or os.environ.get("PREFIX", "").startswith("/data/data/com.termux/files/usr")
        or sys.prefix.startswith("/data/data/com.termux/files/usr")
    )


# ---------------------------------------------------------------------------
# Trazador en tiempo real de stdout/stderr del proceso hijo
# ---------------------------------------------------------------------------

class LineTracer:
    """Lee líneas de un stream y las imprime con prefijo y timestamp."""

    def __init__(self, stream, label: str, verbose: bool = False):
        self._stream = stream
        self._label = label
        self._verbose = verbose
        self._thread = threading.Thread(target=self._run, daemon=True)

    def start(self):
        self._thread.start()
        return self

    def _run(self):
        try:
            for raw in self._stream:
                line = raw.rstrip("\n\r")
                if not line:
                    continue
                # Filtrar líneas JSON-RPC si no estamos en modo verbose
                if not self._verbose and line.startswith("{") and '"jsonrpc"' in line:
                    continue
                ts = time.strftime("%H:%M:%S")
                print(f"[{ts}] [{self._label}] {line}", flush=True)
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Protocolo MCP mínimo — apenas lo necesario para disparar el OAuth
# ---------------------------------------------------------------------------

def send_rpc(proc: subprocess.Popen, method: str, params: dict, req_id: int | None = None) -> None:
    msg: dict = {"jsonrpc": "2.0", "method": method, "params": params}
    if req_id is not None:
        msg["id"] = req_id
    line = json.dumps(msg) + "\n"
    proc.stdin.write(line)
    proc.stdin.flush()


def read_response(proc: subprocess.Popen, req_id: int, timeout: float = 150.0) -> dict:
    """Lee líneas de stdout hasta encontrar la respuesta al req_id dado."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"El proceso terminó con código {proc.returncode}")
        try:
            chunk = proc.stdout.readline()
            if not chunk:
                time.sleep(0.05)
                continue
            line = chunk.strip()
            if not line:
                continue
            msg = json.loads(line)
            if msg.get("id") == req_id:
                return msg
        except json.JSONDecodeError:
            continue
        except Exception as exc:
            raise RuntimeError(f"Error leyendo stdout: {exc}") from exc
    raise TimeoutError(f"Timeout esperando respuesta al id={req_id}")


# ---------------------------------------------------------------------------
# Punto de entrada
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--no-browser-fix", action="store_true",
                        help="Usar termux-open-url directo sin notificación (reproduce pre-8.7.0)")
    parser.add_argument("--verbose", "-v", action="store_true",
                        help="Mostrar mensajes JSON-RPC completos")
    parser.add_argument("--clean", action="store_true",
                        help="Borrar tokens OAuth almacenados para forzar re-autenticación")
    parser.add_argument("--sleep", type=int, default=0, metavar="N",
                        help="Esperar N segundos antes de lanzar (para cambiarse de app y probar sin foco)")
    args = parser.parse_args()

    data_dir = find_zerochat_data_dir()
    service_dir = data_dir / "services" / "composio"
    scripts_dir = data_dir / "services" / "scripts"

    # Validaciones previas
    proxy_js = service_dir / "node_modules" / "mcp-remote" / "dist" / "proxy.js"
    if not proxy_js.is_file():
        sys.exit(
            f"ERROR: No se encontró proxy.js en:\n  {proxy_js}\n"
            "Inicia Composio desde ZeroChat al menos una vez para que se instale mcp-remote."
        )

    node = find_node()

    # Limpiar tokens si se pidió
    if args.clean:
        token_store = service_dir / ".mcp-remote-tokens"
        if token_store.exists():
            import shutil as _sh
            _sh.rmtree(token_store, ignore_errors=True)
            print(f"[*] Tokens OAuth eliminados: {token_store}", flush=True)
        else:
            print("[*] --clean: no se encontraron tokens almacenados.", flush=True)

    # Construir entorno igual que McpServiceManager.start()
    env = os.environ.copy()
    env["HOME"] = str(service_dir)
    env["USERPROFILE"] = str(service_dir)

    # Shim xdg-open al inicio del PATH (idéntico a ZeroChat)
    if scripts_dir.is_dir():
        env["PATH"] = str(scripts_dir) + os.pathsep + env.get("PATH", "")

    # BROWSER: wrapper zerochat-open-url (combina intento directo + notificación del sistema)
    # La notificación elude la restricción de Android 10+ de lanzar actividades sin foco.
    termux_detected = is_termux()
    if termux_detected:
        print(f"[*] Termux detectado: platform={sys.platform}", flush=True)
        if not args.no_browser_fix:
            wrapper = scripts_dir / "zerochat-open-url"
            if wrapper.is_file():
                env.setdefault("BROWSER", str(wrapper))
                print(f"[*] BROWSER → wrapper: {wrapper}", flush=True)
                print( "[*]   (termux-open-url + notificación del sistema = funciona sin foco)", flush=True)
            else:
                opener = find_termux_open_url()
                if opener:
                    env.setdefault("BROWSER", opener)
                    print(f"[!] Wrapper no encontrado, fallback directo: {opener}", flush=True)
                else:
                    print("[!] ADVERTENCIA: termux-open-url no encontrado.", flush=True)
        else:
            opener = find_termux_open_url()
            if opener:
                env.setdefault("BROWSER", opener)
                print(f"[!] --no-browser-fix: BROWSER={opener} (sin notificación, falla sin foco).", flush=True)
    else:
        print(f"[*] Entorno: {sys.platform} (no Termux)", flush=True)

    # Countdown si se pidió sleep (para cambiarse de app antes del OAuth)
    if args.sleep > 0:
        print(f"\n[*] Esperando {args.sleep}s — cámbiate a otra app ahora para probar sin foco...", flush=True)
        for i in range(args.sleep, 0, -1):
            print(f"    {i}...", flush=True)
            time.sleep(1)
        print("[*] Lanzando ahora.\n", flush=True)

    # Comando idéntico al de service.json
    cmd = [
        node,
        str(proxy_js),
        "https://connect.composio.dev/mcp",
        "--protocol", "legacy",
        "--static-oauth-client-metadata", '{"client_name":"zerochat-mcp-remote"}',
        "--auth-timeout", "120",
    ]

    print(f"\n[*] Lanzando mcp-remote para Composio...", flush=True)
    print(f"    node: {node}", flush=True)
    print(f"    cwd:  {service_dir}", flush=True)
    print(f"    BROWSER: {env.get('BROWSER', '(no definido)')}", flush=True)
    print(f"    PATH[0]: {env['PATH'].split(os.pathsep)[0]}", flush=True)
    print("\n" + "─" * 60 + "\n", flush=True)

    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=str(service_dir),
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )

    # Trazar stderr en tiempo real (aquí aparecen los logs de mcp-remote y la URL OAuth)
    LineTracer(proc.stderr, "mcp-remote", verbose=args.verbose).start()

    try:
        # 1. initialize
        print("[*] Enviando: initialize", flush=True)
        send_rpc(proc, "initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "test-composio-oauth", "version": "1.0"},
        }, req_id=1)
        resp = read_response(proc, req_id=1, timeout=150)
        if resp.get("error"):
            print(f"[!] Error en initialize: {resp['error']}", flush=True)
        else:
            print("[✓] initialize OK", flush=True)

        # 2. notifications/initialized
        send_rpc(proc, "notifications/initialized", {})

        # 3. tools/list — mcp-remote puede bloquear aquí hasta completar OAuth
        print("[*] Enviando: tools/list  (esperando hasta 150 s — completa el OAuth si es necesario)...", flush=True)
        send_rpc(proc, "tools/list", {}, req_id=2)
        resp = read_response(proc, req_id=2, timeout=150)
        if resp.get("error"):
            print(f"[!] Error en tools/list: {resp['error']}", flush=True)
        else:
            tools = resp.get("result", {}).get("tools", [])
            print(f"[✓] tools/list OK — {len(tools)} herramienta(s) disponibles:", flush=True)
            for t in tools[:10]:
                print(f"    • {t.get('name')}", flush=True)
            if len(tools) > 10:
                print(f"    ... y {len(tools) - 10} más", flush=True)

    except KeyboardInterrupt:
        print("\n[*] Interrumpido por el usuario.", flush=True)
    except TimeoutError as e:
        print(f"\n[!] TIMEOUT: {e}", flush=True)
        print("    Si estás en Termux, comprueba si el navegador se abrió con la URL OAuth.", flush=True)
    except Exception as e:
        print(f"\n[!] ERROR: {e}", flush=True)
    finally:
        print("\n[*] Cerrando proceso...", flush=True)
        try:
            proc.terminate()
            proc.wait(timeout=3)
        except Exception:
            proc.kill()
        print("[*] Listo.", flush=True)


if __name__ == "__main__":
    main()
