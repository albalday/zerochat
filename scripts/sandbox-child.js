'use strict';
// Proceso hijo de execute_javascript en Node: ejecuta el código del modelo en un contexto de node:vm.
// Fuente única: scripts/build-sandbox-script.mjs genera de aquí py/tools/sandbox_script.py y
// js/sandbox-node-script.js. Se lanza con `node --permission --disallow-code-generation-from-strings -e`.
//
// node:vm no es una frontera de seguridad, así que hay tres capas:
//  1. El contexto no recibe ningún objeto de este proceso: trae sus propios Object, Array, Promise…, y
//     console y el formato del resultado se definen dentro. Entre los dos lados solo cruzan cadenas, y
//     el resultado se recoge por sondeo: ni siquiera se espera su promesa, que entregaría funciones de
//     este lado a su `then`.
//  2. Nadie genera código desde cadenas: ni el contexto (codeGeneration) ni este proceso (el indicador
//     de arranque). Si un objeto de aquí se filtrara (un error de import()), su constructor de funciones
//     no serviría para ejecutar nada.
//  3. Antes de ejecutar el código, este proceso se queda sin process, require ni module en su global.
const vm = require('node:vm');

const POLL_MS = 5;
const stdin = process.stdin;
const writeOut = process.stdout.write.bind(process.stdout);

async function readStdin() {
  const chunks = [];
  for await (const chunk of stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const positiveInt = (value, fallback) => (Number.isInteger(value) && value > 0 ? value : fallback);

// Se ejecuta dentro del contexto: todo lo que crea pertenece al contexto. Guarda las funciones que usa
// antes de que el código del modelo pueda cambiarlas.
const prelude = (maxOutputLength, maxLogEntries) => `(() => {
  "use strict";
  const stringify = JSON.stringify;
  const toText = String;
  const resolved = Promise.resolve.bind(Promise);
  const then = Function.prototype.call.bind(Promise.prototype.then);
  const push = Function.prototype.call.bind(Array.prototype.push);
  const join = Function.prototype.call.bind(Array.prototype.join);
  const map = Function.prototype.call.bind(Array.prototype.map);
  const slice = Function.prototype.call.bind(String.prototype.slice);
  const maxOut = ${maxOutputLength};
  const maxLogs = ${maxLogEntries};
  const logs = [];
  let outcome;

  function formatValue(value) {
    if (value === null) return "null";
    if (value === undefined) return "undefined";
    if (typeof value === "bigint") return value.toString();
    if (typeof value !== "object") return toText(value);
    try {
      return stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item), 2);
    } catch {
      return toText(value);
    }
  }
  const truncate = text => (text.length > maxOut ? slice(text, 0, maxOut) + "... [output truncated]" : text);
  function addLog(prefix, args) {
    if (logs.length >= maxLogs) return;
    const text = join(map(args, formatValue), " ");
    push(logs, truncate(prefix ? "[" + prefix + "] " + text : text));
  }
  const finish = value => {
    outcome = stringify({
      success: true,
      result: value !== undefined ? truncate(formatValue(value)) : (logs.length > 0 ? join(logs, "\\n") : "undefined"),
      logs
    });
  };
  const fail = error => {
    let message;
    try {
      message = error && error.message ? toText(error.message) : toText(error);
    } catch {
      message = "Error";
    }
    outcome = stringify({ success: false, result: "", logs, error: message });
  };

  globalThis.console = {
    log: (...args) => addLog("", args),
    info: (...args) => addLog("INFO", args),
    warn: (...args) => addLog("WARN", args),
    error: (...args) => addLog("ERROR", args)
  };
  Object.defineProperty(globalThis, "__sandbox", {
    value: Object.freeze({
      run(fn) {
        try {
          then(resolved(fn()), finish, fail);
        } catch (error) {
          fail(error);
        }
      },
      outcome: () => outcome
    })
  });
})();`;

(async () => {
  const started = Date.now();
  const payload = JSON.parse(await readStdin());
  const code = String(payload.code ?? '');
  const timeoutMs = positiveInt(payload.timeoutMs, 2500);
  const maxOutputLength = positiveInt(payload.maxOutputLength, 30000);
  const maxLogEntries = positiveInt(payload.maxLogEntries, 200);

  const respond = result => writeOut(JSON.stringify({ ...result, executionTimeMs: Date.now() - started }));
  const failure = error => respond({ success: false, result: '', logs: [], error });

  // Capa 3: lo que un código que alcanzara este global usaría para abrir una conexión o cargar módulos.
  for (const key of ['process', 'require', 'module', 'exports', '__filename', '__dirname', 'fetch', 'WebSocket', 'XMLHttpRequest', 'EventSource']) {
    delete globalThis[key];
  }

  const trimmed = code.trim();
  const isStatement = /^(?:while|for|if|let|const|var|function|class|try|throw|switch|do)\b/.test(trimmed)
    || trimmed.includes(';') || trimmed.includes('\n') || trimmed.includes('return');
  const body = isStatement ? `"use strict";\n${trimmed}` : `"use strict"; return (${trimmed});`;
  const wrapper = `__sandbox.run(${/\bawait\b/.test(trimmed) ? 'async ' : ''}function () {\n${body}\n});`;

  const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
  vm.runInContext(prelude(maxOutputLength, maxLogEntries), context);
  try {
    new vm.Script(wrapper).runInContext(context, { timeout: timeoutMs });
  } catch (err) {
    const timedOut = err && err.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT';
    failure(timedOut ? `Execution timed out after ${timeoutMs}ms and was terminated.` : (err && err.message ? String(err.message) : String(err)));
    return;
  }

  // El resultado es una cadena que deja el contexto; quien lanza este proceso lo mata al vencer el plazo.
  const readOutcome = new vm.Script('__sandbox.outcome()');
  const poll = setInterval(() => {
    let raw;
    try {
      raw = readOutcome.runInContext(context, { timeout: 100 });
    } catch {
      return;
    }
    if (typeof raw !== 'string') return;
    clearInterval(poll);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    if (!parsed || typeof parsed !== 'object') {
      failure('The sandbox returned an unreadable result.');
      return;
    }
    const logs = Array.isArray(parsed.logs) ? parsed.logs.filter(item => typeof item === 'string').slice(0, maxLogEntries) : [];
    if (parsed.success === true) respond({ success: true, result: String(parsed.result ?? ''), logs });
    else respond({ success: false, result: '', logs, error: String(parsed.error ?? 'Error') });
  }, POLL_MS);
})();
