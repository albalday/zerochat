"""Ejecución aislada de JavaScript en un subproceso Node sin credenciales ni permisos."""

from __future__ import annotations

import json
import subprocess
import time

from core.environment import DETECTED_OS, minimal_child_env
from core.process import _kill_process_tree
from run_mode.state import NODE_REQUIRED_MESSAGE, find_node_executable

DEFAULT_SANDBOX_TIMEOUT_MS = 2500
MAX_SANDBOX_TIMEOUT_MS = 30000
MAX_SANDBOX_OUTPUT_LENGTH = 30000
MAX_SANDBOX_LOG_ENTRIES = 200

_NODE_SANDBOX_SCRIPT = r"""
const vm = require("node:vm");

for (const key of ["fetch", "WebSocket", "XMLHttpRequest", "EventSource"]) {
  try { delete globalThis[key]; } catch {}
}

function formatValue(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return String(value);
  try {
    return JSON.stringify(value, (_k, item) => (typeof item === "bigint" ? item.toString() : item), 2);
  } catch {
    return String(value);
  }
}

function truncate(text, maxLen) {
  return text.length > maxLen ? `${text.slice(0, maxLen)}... [output truncated]` : text;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

(async () => {
  const started = Date.now();
  const payload = JSON.parse(await readStdin());
  const code = String(payload.code ?? "");
  const timeoutMs = Number(payload.timeoutMs) || 2500;
  const maxOutputLength = Number(payload.maxOutputLength) || 30000;
  const maxLogEntries = Number(payload.maxLogEntries) || 200;
  const logs = [];
  const addLog = (prefix, args) => {
    if (logs.length >= maxLogEntries) return;
    const text = args.map(formatValue).join(" ");
    logs.push(truncate(prefix ? `[${prefix}] ${text}` : text, maxOutputLength));
  };
  const customConsole = {
    log: (...args) => addLog("", args),
    info: (...args) => addLog("INFO", args),
    warn: (...args) => addLog("WARN", args),
    error: (...args) => addLog("ERROR", args),
  };
  const trimmed = code.trim();
  const isStatement = /^(?:while|for|if|let|const|var|function|class|try|throw|switch|do)\b/.test(trimmed) ||
    trimmed.includes(";") || trimmed.includes("\n") || trimmed.includes("return");
  const body = isStatement ? `"use strict";\n${trimmed}` : `"use strict"; return (${trimmed});`;
  const isAsync = /\bawait\b/.test(trimmed);
  const wrapper = isAsync ? `(async function() {\n${body}\n})()` : `(function() {\n${body}\n})()`;

  const sandboxContext = Object.create(null);
  Object.assign(sandboxContext, {
    console: customConsole,
    Math, JSON, Date, RegExp, Array, Object, String, Number, Boolean, Symbol, BigInt,
    Map, Set, WeakMap, WeakSet, Promise,
    Error, TypeError, RangeError, SyntaxError, URIError,
    parseInt, parseFloat, isNaN, isFinite,
    encodeURI, decodeURI, encodeURIComponent, decodeURIComponent,
  });
  const context = vm.createContext(sandboxContext);
  vm.runInContext(
    'Function.prototype.constructor = function () { throw new Error("Dynamic function creation is not allowed in the sandbox."); };',
    context
  );
  const keepAlive = setTimeout(() => {}, timeoutMs + 2000);
  try {
    const script = new vm.Script(wrapper);
    const value = await Promise.resolve(script.runInContext(context, { timeout: timeoutMs, breakOnSigint: true }));
    const out = {
      success: true,
      result: value !== undefined ? truncate(formatValue(value), maxOutputLength) : (logs.length > 0 ? logs.join("\n") : "undefined"),
      logs,
      executionTimeMs: Date.now() - started,
    };
    process.stdout.write(JSON.stringify(out));
  } catch (err) {
    const isTimeout = err && (err.code === "ERR_SCRIPT_EXECUTION_TIMEOUT" || /timed out/i.test(err.message || ""));
    const message = isTimeout
      ? `Execution timed out after ${timeoutMs}ms and was terminated.`
      : (err && err.message ? err.message : String(err));
    process.stdout.write(JSON.stringify({
      success: false,
      result: "",
      logs,
      executionTimeMs: Date.now() - started,
      error: message,
    }));
  } finally {
    clearTimeout(keepAlive);
  }
})();
""".strip()


def _normalize_timeout_ms(timeout_ms: int | float | None) -> int:
    """Valida y acota el timeout del sandbox en milisegundos."""
    if timeout_ms is None:
        return DEFAULT_SANDBOX_TIMEOUT_MS
    if isinstance(timeout_ms, bool) or not isinstance(timeout_ms, (int, float)) or timeout_ms <= 0:
        raise ValueError("timeout_ms debe ser un número positivo")
    return min(int(timeout_ms), MAX_SANDBOX_TIMEOUT_MS)


def execute_js_sandbox(code: str, timeout_ms: int | float | None = None) -> dict:
    """Ejecuta código JavaScript en un subproceso Node aislado con `--permission` y sin entorno."""
    if not isinstance(code, str) or not code.strip():
        return {
            "success": False,
            "result": "",
            "logs": [],
            "executionTimeMs": 0,
            "error": "No code provided to execute.",
        }
    resolved_timeout = _normalize_timeout_ms(timeout_ms)
    node_path = find_node_executable()
    if not node_path:
        raise RuntimeError(NODE_REQUIRED_MESSAGE)

    payload = json.dumps({
        "code": code,
        "timeoutMs": resolved_timeout,
        "maxOutputLength": MAX_SANDBOX_OUTPUT_LENGTH,
        "maxLogEntries": MAX_SANDBOX_LOG_ENTRIES,
    })
    started = time.monotonic()
    popen_kwargs = {
        "stdin": subprocess.PIPE,
        "stdout": subprocess.PIPE,
        "stderr": subprocess.PIPE,
        "text": True,
        "encoding": "utf-8",
        "errors": "replace",
        "env": minimal_child_env(),
    }
    if DETECTED_OS != "windows":
        popen_kwargs["start_new_session"] = True
    proc = subprocess.Popen([node_path, "--permission", "-e", _NODE_SANDBOX_SCRIPT], **popen_kwargs)
    try:
        stdout, stderr = proc.communicate(input=payload, timeout=(resolved_timeout + 250) / 1000.0)
    except subprocess.TimeoutExpired:
        _kill_process_tree(proc.pid, grace_seconds=0.05)
        try:
            proc.wait(timeout=1.0)
        except subprocess.TimeoutExpired:
            pass
        return {
            "success": False,
            "result": "",
            "logs": [],
            "executionTimeMs": int((time.monotonic() - started) * 1000),
            "error": f"Execution timed out after {resolved_timeout}ms and was terminated.",
        }

    elapsed_ms = int((time.monotonic() - started) * 1000)
    raw = (stdout or "").strip()
    if raw:
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict) and "success" in parsed:
                return parsed
        except json.JSONDecodeError:
            pass
    err_detail = (stderr or raw or f"Sandbox exited with code {proc.returncode}").strip()
    return {
        "success": False,
        "result": "",
        "logs": [],
        "executionTimeMs": elapsed_ms,
        "error": err_detail,
    }
