/**
 * Ejecución de JavaScript local (ChatSandbox).
 *
 * El código se ejecuta en un iframe con sandbox="allow-scripts" (origen opaco), CSP sin red y,
 * dentro, un Web Worker sin APIs de red; un plazo elimina el iframe si no responde.
 *
 * NOTA DE SEGURIDAD: es una herramienta de apoyo para cálculos y manipulación de datos bajo la
 * supervisión de un usuario técnico, no un aislamiento de seguridad del sistema operativo.
 */

(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./utils.js'));
  } else {
    root.ChatSandbox = factory(root.ChatUtils);
  }
})(typeof self !== 'undefined' ? self : this, function (Utils) {
  'use strict';

  const { createId } = Utils;

  const DEFAULT_TIMEOUT_MS = 2500;
  const MAX_OUTPUT_LENGTH = 30000;
  const MAX_LOG_ENTRIES = 200;

  // APIs que el código no recibe en el Worker: las de red y de otros hilos. En el iframe el origen
  // opaco y la CSP ya las bloquean.
  const WORKER_BLOCKED_GLOBALS = [
    'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource',
    'importScripts', 'indexedDB', 'Worker', 'SharedWorker', 'ServiceWorker',
    'postMessage', 'addEventListener', 'removeEventListener'
  ];

  /**
   * Ejecuta `code` con una consola propia y resuelve { success, result, logs, error }. Se envía al
   * Worker y al iframe con toString(), así que no usa nada de fuera de su cuerpo.
   */
  function runCode({ code, maxOutputLength, maxLogEntries, blockedGlobals }) {
    const logs = [];
    const formatValue = value => {
      if (value === null) return 'null';
      if (value === undefined) return 'undefined';
      if (typeof value === 'bigint') return value.toString();
      if (typeof value !== 'object') return String(value);
      try {
        return JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item), 2);
      } catch (_) {
        return String(value);
      }
    };
    const truncate = text => (text.length > maxOutputLength ? `${text.slice(0, maxOutputLength)}... [output truncated]` : text);
    const addLog = (prefix, args) => {
      if (logs.length >= maxLogEntries) return;
      const text = args.map(formatValue).join(' ');
      logs.push(truncate(prefix ? `[${prefix}] ${text}` : text));
    };
    const customConsole = {
      log: (...args) => addLog('', args),
      info: (...args) => addLog('INFO', args),
      warn: (...args) => addLog('WARN', args),
      error: (...args) => addLog('ERROR', args)
    };
    const failure = error => ({ success: false, result: '', logs, error: (error && error.message) || String(error) });

    // Sin Function.prototype.constructor no se escapa con ({}).constructor.constructor('return this')().
    // Se restaura cuando termina el código, también el asíncrono: no al volver la primera vez.
    const originalConstructor = Function.prototype.constructor;
    const restoreConstructor = () => { Function.prototype.constructor = originalConstructor; };
    try {
      const trimmed = code.trim();
      const isStatement = /^(?:while|for|if|let|const|var|function|class|try|throw|switch|do)\b/.test(trimmed) ||
        trimmed.includes(';') || trimmed.includes('\n') || trimmed.includes('return');
      const body = isStatement ? `"use strict";\n${trimmed}` : `"use strict"; return (${trimmed});`;
      const source = /\bawait\b/.test(trimmed) ? `"use strict"; return (async function() {\n${body}\n})();` : body;
      const runner = new Function('console', ...blockedGlobals, source);
      let rawResult;
      Function.prototype.constructor = function () {
        throw new Error('Dynamic function creation is not allowed in the sandbox.');
      };
      try {
        rawResult = runner(customConsole, ...blockedGlobals.map(() => undefined));
      } catch (error) {
        restoreConstructor();
        throw error;
      }
      return Promise.resolve(rawResult).finally(restoreConstructor).then(
        value => ({ success: true, result: value !== undefined ? truncate(formatValue(value)) : (logs.length > 0 ? logs.join('\n') : 'undefined'), logs }),
        failure
      );
    } catch (error) {
      return Promise.resolve(failure(error));
    }
  }

  // El Worker anula las APIs bloqueadas en toda la cadena de prototipos de su ámbito global antes de
  // ejecutar; la respuesta usa el postMessage capturado antes de anularlo.
  const WORKER_CODE = `
  const runCode = ${runCode.toString()};
  const blockedGlobals = ${JSON.stringify(WORKER_BLOCKED_GLOBALS)};
  self.onmessage = function (event) {
    const reply = self.postMessage.bind(self);
    let scope = self;
    while (scope && scope !== Object.prototype) {
      for (const name of blockedGlobals) {
        try {
          Object.defineProperty(scope, name, { value: undefined, writable: false, configurable: false });
        } catch (_) {
          try { scope[name] = undefined; } catch (_ignored) { /* propiedad no anulable */ }
        }
      }
      scope = Object.getPrototypeOf(scope);
    }
    runCode({ ...event.data, blockedGlobals }).then(result => reply({ id: event.data.id, ...result }));
  };
  `;

  // Documento del iframe: ejecuta en un Worker y, si el navegador no lo permite en un origen
  // opaco, en el propio iframe.
  const IFRAME_DOC = `<!DOCTYPE html>
<html>
<head>
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; connect-src 'none'; style-src 'none'; img-src 'none'; object-src 'none';">
</head>
<body>
  <script>
    (function () {
      const runCode = ${runCode.toString()};
      const reply = message => window.parent.postMessage(message, '*');
      window.addEventListener('message', function (event) {
        const payload = event.data;
        if (!payload || !payload.id) return;
        try {
          const workerUrl = URL.createObjectURL(new Blob([${JSON.stringify(WORKER_CODE)}], { type: 'application/javascript' }));
          const worker = new Worker(workerUrl);
          const finish = message => {
            reply(message);
            worker.terminate();
            URL.revokeObjectURL(workerUrl);
          };
          worker.onmessage = workerEvent => finish(workerEvent.data);
          worker.onerror = workerError => finish({ id: payload.id, success: false, result: '', logs: [], error: workerError.message || String(workerError) });
          worker.postMessage(payload);
        } catch (_) {
          runCode({ ...payload, blockedGlobals: [] }).then(result => reply({ id: payload.id, ...result }));
        }
      });
      reply({ type: 'sandbox_ready' });
    })();
  <` + `/script>
</body>
</html>`;

  /** Espera el resultado con un plazo; al vencer llama a `stop` y devuelve el error. */
  function withTimeout(execution, timeoutMs, stop) {
    const startTime = performance.now();
    let timer;
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => {
        if (typeof stop === 'function') stop();
        resolve({ success: false, result: '', logs: [], error: `Execution timed out after ${timeoutMs}ms and was terminated.` });
      }, timeoutMs);
    });
    return Promise.race([execution, timeout]).then(result => {
      clearTimeout(timer);
      return { ...result, executionTimeMs: parseFloat((performance.now() - startTime).toFixed(2)) };
    });
  }

  const NODE_SANDBOX_CHILD_SCRIPT = [
    'const vm = require("node:vm");',
    'for (const k of ["fetch", "WebSocket", "XMLHttpRequest", "EventSource"]) { try { delete globalThis[k]; } catch { /* ignore non-configurable */ } }',
    'function formatValue(v) {',
    '  if (v === null) return "null";',
    '  if (v === undefined) return "undefined";',
    '  if (typeof v === "bigint") return v.toString();',
    '  if (typeof v !== "object") return String(v);',
    '  try { return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2); } catch { return String(v); }',
    '}',
    'const truncate = (t, m) => (t.length > m ? `${t.slice(0, m)}... [output truncated]` : t);',
    '(async () => {',
    '  const chunks = [];',
    '  for await (const c of process.stdin) chunks.push(c);',
    '  const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));',
    '  const code = String(payload.code ?? "");',
    '  const timeoutMs = Number(payload.timeoutMs) || 2500;',
    '  const maxOut = Number(payload.maxOutputLength) || 30000;',
    '  const maxLogs = Number(payload.maxLogEntries) || 200;',
    '  const logs = [];',
    '  const addLog = (p, args) => { if (logs.length < maxLogs) logs.push(truncate(p ? `[${p}] ${args.map(formatValue).join(" ")}` : args.map(formatValue).join(" "), maxOut)); };',
    '  const customConsole = { log: (...a) => addLog("", a), info: (...a) => addLog("INFO", a), warn: (...a) => addLog("WARN", a), error: (...a) => addLog("ERROR", a) };',
    '  const trimmed = code.trim();',
    '  const isStmt = /^(?:while|for|if|let|const|var|function|class|try|throw|switch|do)\\b/.test(trimmed) || trimmed.includes(";") || trimmed.includes("\\n") || trimmed.includes("return");',
    '  const body = isStmt ? `"use strict";\\n${trimmed}` : `"use strict"; return (${trimmed});`;',
    '  const wrapper = /\\bawait\\b/.test(trimmed) ? `(async function() {\\n${body}\\n})()` : `(function() {\\n${body}\\n})()`;',
    '  const sandboxContext = Object.assign(Object.create(null), { console: customConsole, Math, JSON, Date, RegExp, Array, Object, String, Number, Boolean, Symbol, BigInt, Map, Set, WeakMap, WeakSet, Promise, Error, TypeError, RangeError, SyntaxError, URIError, parseInt, parseFloat, isNaN, isFinite, encodeURI, decodeURI, encodeURIComponent, decodeURIComponent });',
    '  const context = vm.createContext(sandboxContext);',
    '  vm.runInContext(\'Function.prototype.constructor = function () { throw new Error("Dynamic function creation is not allowed in the sandbox."); };\', context);',
    '  const keepAlive = setTimeout(() => {}, timeoutMs + 2000);',
    '  try {',
    '    const value = await Promise.resolve(new vm.Script(wrapper).runInContext(context, { timeout: timeoutMs, breakOnSigint: true }));',
    '    process.stdout.write(JSON.stringify({ success: true, result: value !== undefined ? truncate(formatValue(value), maxOut) : (logs.length > 0 ? logs.join("\\n") : "undefined"), logs }));',
    '  } catch (err) {',
    '    const isTimeout = err && (err.code === "ERR_SCRIPT_EXECUTION_TIMEOUT" || /timed out/i.test(err.message || ""));',
    '    process.stdout.write(JSON.stringify({ success: false, result: "", logs, error: isTimeout ? `Execution timed out after ${timeoutMs}ms and was terminated.` : ((err && err.message) || String(err)) }));',
    '  } finally {',
    '    clearTimeout(keepAlive);',
    '  }',
    '})();'
  ].join('\n');

  function executeInNode(code, timeoutMs) {
    const mcpManager = globalThis.ChatMCP?.manager;
    if (mcpManager?.isProxyConnected?.()) {
      return mcpManager.requestExternalControl(
        'zerochat/sandbox/execute',
        { code, timeout_ms: timeoutMs },
        { timeoutMs: timeoutMs + 5000 }
      );
    }
    const { spawn } = require('node:child_process');
    const env = process.platform === 'win32' && process.env.SYSTEMROOT
      ? { SYSTEMROOT: process.env.SYSTEMROOT }
      : {};
    let child = null;
    const execution = new Promise(resolve => {
      child = spawn(process.execPath, ['--permission', '-e', NODE_SANDBOX_CHILD_SCRIPT], {
        env,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      const stdoutChunks = [];
      const stderrChunks = [];
      let settled = false;
      const finish = payload => {
        if (settled) return;
        settled = true;
        resolve(payload);
      };
      child.stdout.on('data', chunk => stdoutChunks.push(chunk));
      child.stderr.on('data', chunk => stderrChunks.push(chunk));
      child.on('error', err => finish({ success: false, result: '', logs: [], error: err?.message || String(err) }));
      child.on('close', exitCode => {
        const raw = Buffer.concat(stdoutChunks).toString('utf8').trim();
        if (raw) {
          try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object' && 'success' in parsed) {
              finish(parsed);
              return;
            }
          } catch (_) { /* fall through to stderr */ }
        }
        const stderrText = Buffer.concat(stderrChunks).toString('utf8').trim();
        finish({
          success: false,
          result: '',
          logs: [],
          error: stderrText || raw || `Sandbox exited with code ${exitCode}`
        });
      });
      child.stdin.end(JSON.stringify({
        code,
        timeoutMs,
        maxOutputLength: MAX_OUTPUT_LENGTH,
        maxLogEntries: MAX_LOG_ENTRIES
      }));
    });
    return withTimeout(execution, timeoutMs, () => {
      try { child?.kill('SIGKILL'); } catch { /* process already exited */ }
    });
  }

  function executeInIframe(code, timeoutMs) {
    const id = createId('exec');
    const iframe = document.createElement('iframe');
    iframe.sandbox = 'allow-scripts';
    iframe.hidden = true;
    iframe.setAttribute('aria-hidden', 'true');
    iframe.srcdoc = IFRAME_DOC;
    let onMessage;
    const cleanup = () => {
      window.removeEventListener('message', onMessage);
      iframe.remove();
    };
    const execution = new Promise(resolve => {
      onMessage = event => {
        if (event.source !== iframe.contentWindow) return;
        if (event.data?.type === 'sandbox_ready') {
          iframe.contentWindow.postMessage({ id, code, maxOutputLength: MAX_OUTPUT_LENGTH, maxLogEntries: MAX_LOG_ENTRIES }, '*');
        } else if (event.data?.id === id) {
          cleanup();
          const { success, result, logs, error } = event.data;
          resolve({ success: Boolean(success), result: result || '', logs: logs || [], error });
        }
      };
      window.addEventListener('message', onMessage);
      document.body.appendChild(iframe);
    });
    return withTimeout(execution, timeoutMs, cleanup);
  }

  /**
   * Ejecuta código JavaScript aislado.
   * @param {string} code
   * @param {number} [timeoutMs] - Plazo en ms; un valor que no sea un número finito positivo usa el de por defecto.
   * @returns {Promise<{ success: boolean, result: string, logs: string[], executionTimeMs: number, error?: string }>}
   */
  async function execute(code, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const effectiveTimeout = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
    if (!code || typeof code !== 'string') {
      return { success: false, result: '', logs: [], executionTimeMs: 0, error: 'No JavaScript code was provided.' };
    }
    if (typeof document === 'undefined' || !document.createElement) {
      return executeInNode(code, effectiveTimeout);
    }
    return executeInIframe(code, effectiveTimeout);
  }

  return { execute };
});
