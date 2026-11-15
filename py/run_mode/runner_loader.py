"""Cargador del runner de Node.js: descarga los módulos de la interfaz como un navegador y los ejecuta.

El servidor lo lanza con `node --permission -e RUNNER_LOADER_SCRIPT <caché> <url de la interfaz>`. Desde la
carpeta de la interfaz (GitHub Pages en producción, este servidor en desarrollo) descarga `js/run-node.js` y,
siguiendo sus `require('./…')`, los módulos que usa, en paralelo; los ejecuta con un `require` mínimo que los
busca en lo descargado (los de Node, como `node:crypto`, van al `require` real). Lo que se ejecuta es lo que se
publica: no hay empaquetado ni copia versionada.

Cada descarga completa sustituye la caché (un JSON con la carpeta de origen y los ficheros). Solo se usa si la
interfaz no responde, para seguir funcionando sin conexión con un modelo local; una respuesta de error de la
interfaz (un 404) es un fallo, no un motivo para ejecutar la copia anterior. Las librerías de terceros que se
cargan bajo demanda (`ChatVendorLoader`) siguen el mismo camino con `globalThis.ChatRunnerSource`.
"""

from __future__ import annotations

# Tope de lo descargado en una ejecución: la interfaz completa ocupa unas pocas centenas de KiB.
RUNNER_MAX_BYTES = 16 * 1024 * 1024

RUNNER_LOADER_SCRIPT = r"""
'use strict';
const fs = require('node:fs');
const vm = require('node:vm');

const [cacheFile, uiUrl] = process.argv.slice(1);
const base = new URL('.', uiUrl.split('#')[0]).href;
const ENTRY = 'js/run-node.js';
const MAX_BYTES = __MAX_BYTES__;
const REQUIRE_RE = /require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;

function resolveKey(from, spec) {
  const href = new URL(spec, base + from).href;
  if (!href.startsWith(base)) throw new Error(`Module outside the interface folder: ${spec}`);
  return href.slice(base.length);
}

// Solo un fallo de red (fetch lanza) permite usar la caché: una respuesta de error o un tope superado, no.
async function download(key) {
  let response;
  try {
    response = await fetch(base + key);
  } catch (cause) {
    const error = new Error(`${base + key}: ${cause.cause?.code || cause.message}`);
    error.offline = true;
    throw error;
  }
  if (!response.ok) throw new Error(`${base + key}: HTTP ${response.status}`);
  return response.text();
}

async function downloadGraph() {
  const files = {};
  const seen = new Set([ENTRY]);
  let pending = [ENTRY];
  let total = 0;
  while (pending.length) {
    const texts = await Promise.all(pending.map(key => download(key)));
    const next = [];
    pending.forEach((key, index) => {
      files[key] = texts[index];
      total += texts[index].length;
      for (const match of texts[index].matchAll(REQUIRE_RE)) {
        const dep = resolveKey(key, match[1]);
        if (!seen.has(dep)) {
          seen.add(dep);
          next.push(dep);
        }
      }
    });
    if (total > MAX_BYTES) throw new Error(`The runner modules exceed ${MAX_BYTES} bytes.`);
    pending = next;
  }
  return files;
}

function readCache() {
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    return cached && cached.base === base && cached.files && typeof cached.files === 'object' ? cached.files : null;
  } catch {
    return null;
  }
}

function writeCache(files) {
  try {
    fs.writeFileSync(cacheFile + '.tmp', JSON.stringify({ base, files }), { mode: 0o600 });
    fs.renameSync(cacheFile + '.tmp', cacheFile);
  } catch (error) {
    console.error(`[RunnerLoader] Could not update the cache: ${error.message}`);
  }
}

function execute(files) {
  const modules = new Map();
  const load = key => {
    if (modules.has(key)) return modules.get(key).exports;
    if (typeof files[key] !== 'string') throw new Error(`Module not downloaded: ${key}`);
    const module = { exports: {} };
    modules.set(key, module);
    const filename = base + key;
    const wrapper = vm.runInThisContext(`(function (exports, require, module, __filename, __dirname) {${files[key]}\n})`, { filename });
    const localRequire = spec => (spec.startsWith('.') ? load(resolveKey(key, spec)) : require(spec));
    wrapper.call(module.exports, module.exports, localRequire, module, filename, new URL('.', filename).href);
    return module.exports;
  };
  return load(ENTRY);
}

(async () => {
  let files;
  try {
    files = await downloadGraph();
    writeCache(files);
  } catch (error) {
    files = error.offline ? readCache() : null;
    if (!files) throw error;
    console.error(`[RunnerLoader] ${base} is unreachable (${error.message}); using the cached copy.`);
  }
  // Las librerías de terceros se piden al usarlas: se descargan igual y se añaden a la caché.
  globalThis.ChatRunnerSource = async key => {
    try {
      files[key] = await download(key);
      writeCache(files);
    } catch (error) {
      if (!error.offline || typeof files[key] !== 'string') throw error;
    }
    return files[key];
  };
  await execute(files).startHeadlessRun([uiUrl]);
})().catch(error => {
  console.error('[RunnerLoader] Fatal error:', error);
  process.exit(1);
});
""".replace("__MAX_BYTES__", str(RUNNER_MAX_BYTES))
