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

  const { createId, resolveDep } = Utils;

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
    const logLimitNotice = '... [console output limit reached: further logs dropped]';
    let logChars = 0;
    let logsDropped = false;
    const formatValue = value => {
      if (value === null) return 'null';
      if (value === undefined) return 'undefined';
      if (typeof value === 'bigint') return value.toString();
      if (typeof value !== 'object') return String(value);
      try {
        // Un toJSON que devuelve undefined deja a JSON.stringify sin texto.
        const text = JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item), 2);
        return text === undefined ? 'undefined' : text;
      } catch (_) {
        return String(value);
      }
    };
    const truncate = (text, limit = maxOutputLength) => (text.length > limit ? `${text.slice(0, limit)}... [output truncated]` : text);
    // La consola entera cabe en maxLogEntries entradas y en maxOutputLength caracteres contando el salto de línea
    // que las une: la primera que no cabe deja un aviso y las siguientes se descartan.
    const addLog = (prefix, args) => {
      if (logsDropped) return;
      if (logs.length >= maxLogEntries || logChars >= maxOutputLength) {
        logsDropped = true;
        logs.push(logLimitNotice);
        return;
      }
      const text = args.map(formatValue).join(' ');
      const entry = truncate(prefix ? `[${prefix}] ${text}` : text, maxOutputLength - logChars);
      logChars += entry.length + 1;
      logs.push(entry);
    };
    const customConsole = {
      log: (...args) => addLog('', args),
      info: (...args) => addLog('INFO', args),
      warn: (...args) => addLog('WARN', args),
      error: (...args) => addLog('ERROR', args)
    };
    const failure = error => ({ success: false, result: '', logs, error: truncate(String((error && error.message) || String(error))) });

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
    // El mismo proceso hijo que lanza el servidor (scripts/sandbox-child.js).
    const { NODE_SANDBOX_ARGS, NODE_SANDBOX_MAX_OUTPUT_BYTES, NODE_SANDBOX_SCRIPT } = resolveDep('ChatSandboxNodeScript', './sandbox-node-script.js');
    const env = process.platform === 'win32' && process.env.SYSTEMROOT
      ? { SYSTEMROOT: process.env.SYSTEMROOT }
      : {};
    let child = null;
    const execution = new Promise(resolve => {
      child = spawn(process.execPath, [...NODE_SANDBOX_ARGS, '-e', NODE_SANDBOX_SCRIPT], {
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
      // Cada salida se lee hasta NODE_SANDBOX_MAX_OUTPUT_BYTES: al pasarlo el hijo se mata en vez de seguir acumulando.
      const collect = chunks => {
        let bytes = 0;
        return chunk => {
          bytes += chunk.length;
          if (bytes > NODE_SANDBOX_MAX_OUTPUT_BYTES) {
            try { child.kill('SIGKILL'); } catch { /* process already exited */ }
            finish({ success: false, result: '', logs: [], error: `The sandbox output exceeded ${NODE_SANDBOX_MAX_OUTPUT_BYTES} bytes and was discarded.` });
            return;
          }
          chunks.push(chunk);
        };
      };
      child.stdout.on('data', collect(stdoutChunks));
      child.stderr.on('data', collect(stderrChunks));
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
