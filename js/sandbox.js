/**
 * Módulo de ejecución de JavaScript local (ChatSandbox).
 * 
 * - Ejecución desacoplada mediante Web Worker en hilo independiente cuando está disponible (evita bloqueos del hilo principal).
 * - Control de tiempo de ejecución (Timeout) con terminación forzada del Worker (worker.terminate()).
 * - Límites de salida y protección de flujo (truncamiento de texto y límite de logs de consola).
 * - Mitigación en el Worker de APIs no deseadas para cálculos (red y sub-workers).
 * - Fallback controlado para entornos sin soporte nativo de Web Worker.
 * 
 * NOTA DE SEGURIDAD Y VIGILANCIA TÉCNICA:
 * Este módulo es una herramienta de apoyo para facilitar cálculos matemáticos, manipulación de
 * datos y algoritmos del modelo. No debe considerarse un sandbox de seguridad a nivel de sistema
 * operativo ni un entorno de ejecución hostil aislado. Su uso está pensado bajo el conocimiento,
 * supervisión y vigilancia consciente de un usuario técnico.
 */

(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.ChatSandbox = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULT_TIMEOUT_MS = 2500;
  const MAX_OUTPUT_LENGTH = 30000;
  const MAX_LOG_ENTRIES = 200;

  /**
   * Código fuente del Worker aislado empaquetado como texto estático.
   */
  const WORKER_CODE = `
  self.onmessage = function(e) {
    const notifyParent = typeof self.postMessage === 'function' ? self.postMessage.bind(self) : null;
    const { id, code, maxOutputLength, maxLogEntries } = e.data;
    const logs = [];

    function formatValue(v) {
      if (v === null) return 'null';
      if (v === undefined) return 'undefined';
      if (typeof v === 'bigint') return v.toString();
      if (typeof v === 'object') {
        try {
          return JSON.stringify(v, function(key, value) {
            return typeof value === 'bigint' ? value.toString() : value;
          }, 2);
        } catch (err) {
          return String(v);
        }
      }
      return String(v);
    }

    function addLog(prefix, args) {
      if (logs.length >= maxLogEntries) return;
      let text = args.map(formatValue).join(' ');
      if (prefix) text = '[' + prefix + '] ' + text;
      if (text.length > maxOutputLength) {
        text = text.substring(0, maxOutputLength) + '... [Salida truncada]';
      }
      logs.push(text);
    }

    const customConsole = {
      log: (...args) => addLog('', args),
      info: (...args) => addLog('INFO', args),
      warn: (...args) => addLog('WARN', args),
      error: (...args) => addLog('ERROR', args)
    };

    try {
      const blockedGlobals = [
        'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource',
        'importScripts', 'indexedDB', 'Worker', 'SharedWorker', 'ServiceWorker',
        'postMessage', 'addEventListener', 'removeEventListener'
      ];

      // 1. Neutralizar recursivamente en la cadena de prototipos del Worker (WorkerGlobalScope, etc.)
      const rootObj = typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : null);
      if (rootObj) {
        let currentProto = rootObj;
        while (currentProto && currentProto !== Object.prototype) {
          blockedGlobals.forEach(function(name) {
            try {
              Object.defineProperty(currentProto, name, {
                value: undefined,
                writable: false,
                configurable: false
              });
            } catch (err) {
              try { currentProto[name] = undefined; } catch (_) {}
            }
          });
          currentProto = Object.getPrototypeOf(currentProto);
        }
      }

      // 2. Eliminar explícitamente importScripts de self y prototipos
      try {
        if (typeof self !== 'undefined') delete self.importScripts;
        if (typeof WorkerGlobalScope !== 'undefined') {
          delete WorkerGlobalScope.prototype.importScripts;
        }
      } catch (_) {}

      const paramNames = ['console', ...blockedGlobals];
      const paramValues = [customConsole, ...blockedGlobals.map(() => undefined)];

      const trimmed = (code || '').trim();
      const isStatement = /^(?:while|for|if|let|const|var|function|class|try|throw|switch|do)\\b/.test(trimmed) ||
                          trimmed.includes(';') || trimmed.includes('\\n') || trimmed.includes('return');
      let wrappedBody;
      if (!isStatement) {
        wrappedBody = '"use strict"; return (' + trimmed + ');';
      } else {
        wrappedBody = '"use strict";\\n' + trimmed;
      }

      const isAsync = /\\bawait\\b/.test(trimmed);
      let runner;
      if (isAsync) {
        runner = new Function(...paramNames, '"use strict"; return (async function() {\\n' + wrappedBody + '\\n})();');
      } else {
        runner = new Function(...paramNames, wrappedBody);
      }

      // 3. Desactivar invocación de Function.prototype.constructor durante la ejecución
      // para neutralizar vectores de escape vía prototipos como ({}).constructor.constructor('return this')()
      const origFunctionConstructor = Function.prototype.constructor;
      let rawResult;
      try {
        Function.prototype.constructor = function() {
          throw new Error('La creación dinámica de funciones está restringida en el sandbox.');
        };
        rawResult = runner.apply(null, paramValues);
      } finally {
        try { Function.prototype.constructor = origFunctionConstructor; } catch (_) {}
      }

      Promise.resolve(rawResult).then(function(resolvedResult) {
        let formattedResult = resolvedResult !== undefined ? formatValue(resolvedResult) : (logs.length > 0 ? logs.join('\\n') : 'undefined');
        if (formattedResult && formattedResult.length > maxOutputLength) {
          formattedResult = formattedResult.substring(0, maxOutputLength) + '... [Salida truncada por límite de tamaño]';
        }

        const msg = {
          id: id,
          success: true,
          result: formattedResult,
          logs: logs
        };
        if (notifyParent) notifyParent(msg);
        else self.postMessage(msg);
      }).catch(function(asyncErr) {
        const msg = {
          id: id,
          success: false,
          result: '',
          logs: logs,
          error: (asyncErr && (asyncErr.message || asyncErr.toString())) || 'Error en ejecución asíncrona'
        };
        if (notifyParent) notifyParent(msg);
        else self.postMessage(msg);
      });
    } catch (err) {
      const msg = {
        id: id,
        success: false,
        result: '',
        logs: logs,
        error: err.toString()
      };
      if (notifyParent) notifyParent(msg);
      else self.postMessage(msg);
    }
  };
  `;

  /**
   * Ejecuta código JavaScript utilizando un Web Worker en un hilo independiente.
   */
  function executeWithWorker(code, timeoutMs) {
    return new Promise((resolve) => {
      let workerUrl = null;
      let worker = null;
      let isResolved = false;
      const startTime = performance.now();

      function cleanup() {
        if (worker) {
          try {
            worker.terminate();
          } catch (e) {}
          worker = null;
        }
        if (workerUrl && typeof URL !== 'undefined' && URL.revokeObjectURL) {
          try {
            URL.revokeObjectURL(workerUrl);
          } catch (e) {}
          workerUrl = null;
        }
      }

      const timer = setTimeout(() => {
        if (!isResolved) {
          isResolved = true;
          cleanup();
          const elapsed = (performance.now() - startTime).toFixed(2);
          resolve({
            success: false,
            result: '',
            logs: [],
            executionTimeMs: parseFloat(elapsed),
            error: `Tiempo de ejecución excedido (Timeout de ${timeoutMs}ms). El Worker fue terminado forzosamente.`
          });
        }
      }, timeoutMs);

      try {
        const blob = new Blob([WORKER_CODE], { type: 'application/javascript' });
        workerUrl = URL.createObjectURL(blob);
        worker = new Worker(workerUrl);

        worker.onmessage = function (e) {
          if (!isResolved) {
            isResolved = true;
            clearTimeout(timer);
            const data = e.data || {};
            cleanup();
            const elapsed = (performance.now() - startTime).toFixed(2);
            resolve({
              success: Boolean(data.success),
              result: data.result || '',
              logs: data.logs || [],
              executionTimeMs: parseFloat(elapsed),
              error: data.error
            });
          }
        };

        worker.onerror = function (err) {
          if (!isResolved) {
            isResolved = true;
            clearTimeout(timer);
            cleanup();
            const elapsed = (performance.now() - startTime).toFixed(2);
            resolve({
              success: false,
              result: '',
              logs: [],
              executionTimeMs: parseFloat(elapsed),
              error: (err && err.message) || String(err)
            });
          }
        };

        worker.postMessage({
          id: Date.now(),
          code: code,
          maxOutputLength: MAX_OUTPUT_LENGTH,
          maxLogEntries: MAX_LOG_ENTRIES
        });
      } catch (err) {
        if (!isResolved) {
          isResolved = true;
          clearTimeout(timer);
          cleanup();
          const elapsed = (performance.now() - startTime).toFixed(2);
          resolve({
            success: false,
            result: '',
            logs: [],
            executionTimeMs: parseFloat(elapsed),
            error: err.toString()
          });
        }
      }
    });
  }

  /**
   * Fallback de ejecución controlada para entornos donde Web Worker no esté disponible.
   */
  function executeWithFallback(code, timeoutMs) {
    return new Promise((resolve) => {
      const logs = [];
      const startTime = performance.now();
      let isResolved = false;

      function formatValue(v) {
        if (v === null) return 'null';
        if (v === undefined) return 'undefined';
        if (typeof v === 'bigint') return v.toString();
        if (typeof v === 'object') {
          try {
            return JSON.stringify(v, function(key, value) {
              return typeof value === 'bigint' ? value.toString() : value;
            }, 2);
          } catch (e) {
            return String(v);
          }
        }
        return String(v);
      }

      function addLog(prefix, args) {
        if (logs.length >= MAX_LOG_ENTRIES) return;
        let text = args.map(formatValue).join(' ');
        if (prefix) text = '[' + prefix + '] ' + text;
        if (text.length > MAX_OUTPUT_LENGTH) {
          text = text.substring(0, MAX_OUTPUT_LENGTH) + '... [Salida truncada]';
        }
        logs.push(text);
      }

      const customConsole = {
        log: (...args) => addLog('', args),
        info: (...args) => addLog('INFO', args),
        warn: (...args) => addLog('WARN', args),
        error: (...args) => addLog('ERROR', args)
      };

      const timer = setTimeout(() => {
        if (!isResolved) {
          isResolved = true;
          const elapsed = (performance.now() - startTime).toFixed(2);
          resolve({
            success: false,
            result: '',
            logs: logs,
            executionTimeMs: parseFloat(elapsed),
            error: `Tiempo de ejecución excedido (Timeout de ${timeoutMs}ms).`
          });
        }
      }, timeoutMs);

      try {
        const blockedGlobals = [
          'window', 'document', 'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource',
          'localStorage', 'sessionStorage', 'indexedDB', 'cookie', 'location', 'navigator',
          'parent', 'top', 'frames', 'opener', 'Worker', 'SharedWorker', 'ServiceWorker',
          'FileReader', 'DecompressionStream', 'CompressionStream', 'alert', 'confirm', 'prompt',
          'open', 'close', 'postMessage', 'importScripts'
        ];

        const paramNames = ['console', ...blockedGlobals];
        const paramValues = [customConsole, ...blockedGlobals.map(() => undefined)];

        const trimmedCode = (code || '').trim();
        const isStatement = /^(?:while|for|if|let|const|var|function|class|try|throw|switch|do)\b/.test(trimmedCode) ||
                            trimmedCode.includes(';') || trimmedCode.includes('\n') || trimmedCode.includes('return');
        let wrappedBody;
        if (!isStatement) {
          wrappedBody = `"use strict"; return (${trimmedCode});`;
        } else {
          wrappedBody = `"use strict";\n${trimmedCode}`;
        }

        const isAsync = /\bawait\b/.test(trimmedCode);
        let runner;
        if (isAsync) {
          runner = new Function(...paramNames, `"use strict"; return (async function() {\n${wrappedBody}\n})();`);
        } else {
          runner = new Function(...paramNames, wrappedBody);
        }
        const rawResult = runner.apply(null, paramValues);

        Promise.resolve(rawResult).then(function(resolvedResult) {
          clearTimeout(timer);
          if (!isResolved) {
            isResolved = true;
            const elapsed = (performance.now() - startTime).toFixed(2);
            let formattedResult = resolvedResult !== undefined ? formatValue(resolvedResult) : (logs.length > 0 ? logs.join('\n') : 'undefined');
            if (formattedResult && formattedResult.length > MAX_OUTPUT_LENGTH) {
              formattedResult = formattedResult.substring(0, MAX_OUTPUT_LENGTH) + '... [Salida truncada por límite de tamaño]';
            }
            resolve({
              success: true,
              result: formattedResult,
              logs: logs,
              executionTimeMs: parseFloat(elapsed)
            });
          }
        }).catch(function(asyncErr) {
          clearTimeout(timer);
          if (!isResolved) {
            isResolved = true;
            const elapsed = (performance.now() - startTime).toFixed(2);
            resolve({
              success: false,
              result: '',
              logs: logs,
              executionTimeMs: parseFloat(elapsed),
              error: (asyncErr && (asyncErr.message || asyncErr.toString())) || 'Error en ejecución asíncrona'
            });
          }
        });
      } catch (err) {
        clearTimeout(timer);
        if (!isResolved) {
          isResolved = true;
          const elapsed = (performance.now() - startTime).toFixed(2);
          resolve({
            success: false,
            result: '',
            logs: logs,
            executionTimeMs: parseFloat(elapsed),
            error: err.toString()
          });
        }
      }
    });
  }

  /**
   * Ejecuta código JavaScript en un iframe con sandbox (origen opaco "null"),
   * Content Security Policy (connect-src 'none') y Web Worker interno.
   * Proporciona defensa en profundidad:
   * 1. Origen "null" que bloquea acceso a localStorage, IndexedDB, cookies y window.parent.
   * 2. CSP connect-src 'none' que bloquea fetch, XHR, WebSockets y exfiltración de red.
   * 3. Hilo independiente no bloqueante con timeout watchdog que destruye el iframe si se excede el tiempo.
   */
  function executeWithIframe(code, timeoutMs) {
    return new Promise((resolve) => {
      const doc = typeof document !== 'undefined' ? document : null;
      if (!doc || typeof doc.createElement !== 'function') {
        return resolve(executeWithFallback(code, timeoutMs));
      }

      const container = doc.body || doc.documentElement;
      if (!container) {
        return resolve(executeWithFallback(code, timeoutMs));
      }

      const id = 'exec_' + Math.random().toString(36).slice(2) + '_' + Date.now();
      const startTime = performance.now();
      let isResolved = false;
      let iframe = doc.createElement('iframe');
      iframe.sandbox = 'allow-scripts';
      iframe.style.display = 'none';
      iframe.setAttribute('aria-hidden', 'true');

      const IFRAME_DOC = `<!DOCTYPE html>
<html>
<head>
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; connect-src 'none'; style-src 'none'; img-src 'none'; object-src 'none';">
</head>
<body>
  <script>
    (function() {
      let activeWorker = null;
      let workerUrl = null;

      function executeDirectly(payload) {
        const notifyParent = function(msg) { window.parent.postMessage(msg, '*'); };
        const id = payload.id;
        const code = payload.code;
        const maxOutputLength = payload.maxOutputLength || ${MAX_OUTPUT_LENGTH};
        const maxLogEntries = payload.maxLogEntries || ${MAX_LOG_ENTRIES};
        const logs = [];

        function formatValue(v) {
          if (v === null) return 'null';
          if (v === undefined) return 'undefined';
          if (typeof v === 'bigint') return v.toString();
          if (typeof v === 'object') {
            try {
              return JSON.stringify(v, function(k, val) {
                return typeof val === 'bigint' ? val.toString() : val;
              }, 2);
            } catch(e) {
              return String(v);
            }
          }
          return String(v);
        }

        function addLog(prefix, args) {
          if (logs.length >= maxLogEntries) return;
          let text = args.map(formatValue).join(' ');
          if (prefix) text = '[' + prefix + '] ' + text;
          if (text.length > maxOutputLength) {
            text = text.substring(0, maxOutputLength) + '... [Salida truncada]';
          }
          logs.push(text);
        }

        const customConsole = {
          log: function(...args) { addLog('', args); },
          info: function(...args) { addLog('INFO', args); },
          warn: function(...args) { addLog('WARN', args); },
          error: function(...args) { addLog('ERROR', args); }
        };

        try {
          const trimmed = (code || '').trim();
          const isStatement = /^(?:while|for|if|let|const|var|function|class|try|throw|switch|do)\\b/.test(trimmed) ||
                              trimmed.includes(';') || trimmed.includes('\\n') || trimmed.includes('return');
          let wrapped;
          if (!isStatement) {
            wrapped = '"use strict"; return (' + trimmed + ');';
          } else {
            wrapped = '"use strict";\\n' + trimmed;
          }

          const isAsync = /\\bawait\\b/.test(trimmed);
          let runner;
          if (isAsync) {
            runner = new Function('console', '"use strict"; return (async function() {\\n' + wrapped + '\\n})();');
          } else {
            runner = new Function('console', wrapped);
          }

          const rawResult = runner(customConsole);
          Promise.resolve(rawResult).then(function(res) {
            let formatted = res !== undefined ? formatValue(res) : (logs.length > 0 ? logs.join('\\n') : 'undefined');
            if (formatted && formatted.length > maxOutputLength) {
              formatted = formatted.substring(0, maxOutputLength) + '... [Salida truncada por límite de tamaño]';
            }
            notifyParent({ id: id, success: true, result: formatted, logs: logs });
          }).catch(function(err) {
            notifyParent({ id: id, success: false, result: '', logs: logs, error: (err && err.message) || String(err) });
          });
        } catch(err) {
          notifyParent({ id: id, success: false, result: '', logs: logs, error: (err && err.message) || String(err) });
        }
      }

      window.addEventListener('message', function(e) {
        if (!e.data || !e.data.id) return;
        const payload = e.data;
        const canUseWorker = typeof Worker !== 'undefined' && typeof Blob !== 'undefined' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function';
        if (canUseWorker) {
          try {
            const blob = new Blob([${JSON.stringify(WORKER_CODE)}], { type: 'application/javascript' });
            workerUrl = URL.createObjectURL(blob);
            activeWorker = new Worker(workerUrl);

            activeWorker.onmessage = function(wEvt) {
              window.parent.postMessage(wEvt.data, '*');
              if (activeWorker) { try { activeWorker.terminate(); } catch(_) {} activeWorker = null; }
              if (workerUrl) { try { URL.revokeObjectURL(workerUrl); } catch(_) {} workerUrl = null; }
            };

            activeWorker.onerror = function(wErr) {
              window.parent.postMessage({
                id: payload.id,
                success: false,
                result: '',
                logs: [],
                error: (wErr && wErr.message) || String(wErr)
              }, '*');
              if (activeWorker) { try { activeWorker.terminate(); } catch(_) {} activeWorker = null; }
              if (workerUrl) { try { URL.revokeObjectURL(workerUrl); } catch(_) {} workerUrl = null; }
            };

            activeWorker.postMessage(payload);
            return;
          } catch(err) {
            // Fallback directo en el iframe si Worker es bloqueado en origen null
          }
        }
        executeDirectly(payload);
      });

      window.parent.postMessage({ type: 'sandbox_ready' }, '*');
    })();
  <` + `/script>
</body>
</html>`;

      iframe.srcdoc = IFRAME_DOC;

      function cleanup() {
        if (onMessage) {
          window.removeEventListener('message', onMessage);
          onMessage = null;
        }
        if (iframe) {
          try { iframe.remove(); } catch (_) {}
          iframe = null;
        }
      }

      const timer = setTimeout(() => {
        if (!isResolved) {
          isResolved = true;
          cleanup();
          const elapsed = (performance.now() - startTime).toFixed(2);
          resolve({
            success: false,
            result: '',
            logs: [],
            executionTimeMs: parseFloat(elapsed),
            error: `Tiempo de ejecución excedido (Timeout de ${timeoutMs}ms). El entorno aislado fue terminado forzosamente.`
          });
        }
      }, timeoutMs);

      let onMessage = function(e) {
        if (!iframe || e.source !== iframe.contentWindow) return;
        if (e.data && e.data.type === 'sandbox_ready') {
          iframe.contentWindow.postMessage({
            id: id,
            code: code,
            maxOutputLength: MAX_OUTPUT_LENGTH,
            maxLogEntries: MAX_LOG_ENTRIES
          }, '*');
        } else if (e.data && e.data.id === id) {
          if (!isResolved) {
            isResolved = true;
            clearTimeout(timer);
            cleanup();
            const elapsed = (performance.now() - startTime).toFixed(2);
            resolve({
              success: Boolean(e.data.success),
              result: e.data.result || '',
              logs: e.data.logs || [],
              executionTimeMs: parseFloat(elapsed),
              error: e.data.error
            });
          }
        }
      };

      window.addEventListener('message', onMessage);
      container.appendChild(iframe);
    });
  }

  /**
   * Ejecuta código JavaScript de forma aislada.
   * En entorno de navegador con DOM disponible, utiliza un iframe con sandbox (origen "null") y CSP restrictivo.
   * En otros entornos (Node.js o sin DOM), recurre a Web Worker o fallback controlado.
   * 
   * @param {string} code - Código JS a ejecutar
   * @param {number} timeoutMs - Límite de tiempo máximo en ms
   * @returns {Promise<{ success: boolean, result: string, logs: string[], executionTimeMs: number, error?: string }>}
   */
  async function execute(code, timeoutMs = DEFAULT_TIMEOUT_MS) {
    let effectiveTimeout = DEFAULT_TIMEOUT_MS;
    if (typeof timeoutMs === 'number' && !isNaN(timeoutMs) && timeoutMs > 0) {
      effectiveTimeout = timeoutMs;
    } else if (typeof timeoutMs === 'object' && timeoutMs !== null) {
      const parsed = timeoutMs.timeoutMs || timeoutMs.timeout;
      if (typeof parsed === 'number' && !isNaN(parsed) && parsed > 0) {
        effectiveTimeout = parsed;
      }
    }

    if (!code || typeof code !== 'string') {
      return {
        success: false,
        result: '',
        logs: [],
        executionTimeMs: 0,
        error: 'No se proporcionó código JavaScript para ejecutar.'
      };
    }

    const hasDom = typeof document !== 'undefined' && typeof document.createElement === 'function';
    if (hasDom) {
      return executeWithIframe(code, effectiveTimeout);
    }

    const isWorkerSupported = typeof Worker !== 'undefined' &&
                              typeof Blob !== 'undefined' &&
                              typeof URL !== 'undefined' &&
                              typeof URL.createObjectURL === 'function';

    if (isWorkerSupported) {
      return executeWithWorker(code, effectiveTimeout);
    } else {
      return executeWithFallback(code, effectiveTimeout);
    }
  }

  return {
    execute,
    executeWithIframe,
    executeWithWorker,
    executeWithFallback,
    MAX_OUTPUT_LENGTH,
    MAX_LOG_ENTRIES
  };
});

