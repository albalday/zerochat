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
        'importScripts', 'indexedDB', 'Worker', 'SharedWorker', 'ServiceWorker'
      ];

      // Neutralizar en self y globalThis dentro del Worker para mitigar llamadas accidentales a red o sub-workers
      blockedGlobals.forEach(function(name) {
        try { self[name] = undefined; } catch (e) {}
        try { if (typeof globalThis !== 'undefined') globalThis[name] = undefined; } catch (e) {}
      });

      const paramNames = ['console', ...blockedGlobals, 'postMessage', 'addEventListener', 'removeEventListener'];
      const paramValues = [customConsole, ...blockedGlobals.map(() => undefined), undefined, undefined, undefined];

      const trimmed = (code || '').trim();
      let wrappedBody;
      if (!trimmed.includes('return') && !trimmed.includes(';') && !trimmed.includes('\\n')) {
        wrappedBody = '"use strict"; return (' + trimmed + ');';
      } else {
        wrappedBody = '"use strict";\\n' + trimmed;
      }

      const runner = new Function(...paramNames, wrappedBody);
      const rawResult = runner.apply(null, paramValues);

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
        let wrappedBody;
        if (!trimmedCode.includes('return') && !trimmedCode.includes(';') && !trimmedCode.includes('\n')) {
          wrappedBody = `"use strict"; return (${trimmedCode});`;
        } else {
          wrappedBody = `"use strict";\n${trimmedCode}`;
        }

        const runner = new Function(...paramNames, wrappedBody);
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
   * Ejecuta código JavaScript de forma aislada.
   * Utiliza Web Worker cuando está disponible; en caso contrario, recurre al fallback controlado.
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
    executeWithWorker,
    executeWithFallback,
    MAX_OUTPUT_LENGTH,
    MAX_LOG_ENTRIES
  };
});

