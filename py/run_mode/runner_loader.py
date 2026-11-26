"""Cargador del runner de Node.js: descarga los módulos de la interfaz como un navegador y los ejecuta.

El servidor lo lanza con `node --permission -e RUNNER_LOADER_SCRIPT <caché> <url de la interfaz> <política>` y una
tubería como stdin: cuando se cierra (muere el proceso que lo lanzó), el runner termina. Desde la
carpeta de la interfaz (GitHub Pages en producción, este servidor en desarrollo) descarga `js/run-node.js` y,
siguiendo sus `require('./…')`, los módulos que usa, en paralelo; los ejecuta con un `require` mínimo que los
busca en lo descargado (los de Node, como `node:crypto`, van al `require` real). Lo que se ejecuta es lo que se
publica: no hay empaquetado ni copia versionada.

Cada descarga completa sustituye la caché (un JSON con la carpeta de origen, la versión publicada y los ficheros).
Con la política `version` (la instalada), una sola petición lee la versión publicada del título de la interfaz: si
es la de la caché, se ejecuta la caché sin pedir ningún módulo; si es otra o no se puede leer, se descarga todo. La
descarga completa tarda de 0,5 a 0,7 s desde GitHub Pages con su CDN caliente y unos 6 s en frío (45 módulos,
811 KiB), y la versión de 0,1 a 0,25 s. En desarrollo (política `always`) se descarga siempre: los módulos cambian
sin subir la versión. Sin conexión, sea cual sea la versión, se usa la caché para seguir con un modelo local; una
respuesta de error de la interfaz (un 404) es un fallo, no un motivo para ejecutar la copia anterior. Las librerías
de terceros que se cargan bajo demanda (`ChatVendorLoader`) siguen el mismo camino con `globalThis.ChatRunnerSource`.
"""

from __future__ import annotations

import json

from core.version import UI_VERSION_TITLE_PATTERN

# Política de caché del runner: ejecutar la caché si es de la versión publicada, o descargar siempre (desarrollo).
RUNNER_CACHE_BY_VERSION = "version"
RUNNER_CACHE_ALWAYS_DOWNLOAD = "always"

# Tope de lo descargado en una ejecución: la interfaz completa ocupa unas pocas centenas de KiB.
RUNNER_MAX_BYTES = 16 * 1024 * 1024

RUNNER_LOADER_SCRIPT = r"""
'use strict';
const fs = require('node:fs');
const vm = require('node:vm');

const [cacheFile, uiUrl, cachePolicy] = process.argv.slice(1);

// El proceso zerochat que lanza el runner le da como stdin una tubería en la que nunca escribe: el sistema la cierra
// cuando ese proceso muere, también con SIGKILL, y el runner termina en vez de seguir llamando al modelo por su cuenta.
process.stdin.on('end', () => {
  console.error('[RunnerLoader] The zerochat process that launched the runner is gone; stopping.');
  process.exit(1);
});
process.stdin.resume();
// Solo vigila: no mantiene vivo el proceso cuando el runner ya terminó su trabajo.
process.stdin.unref?.();
const pageUrl = uiUrl.split('#')[0];
const base = new URL('.', pageUrl).href;
const ENTRY = 'js/run-node.js';
const MAX_BYTES = __MAX_BYTES__;
const VERSION_RE = new RegExp(__VERSION_PATTERN__, 'i');
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

// Versión publicada de la interfaz, o null si no se puede leer: entonces se descarga todo.
async function publishedVersion() {
  if (cachePolicy !== '__BY_VERSION__') return null;
  try {
    const response = await fetch(pageUrl);
    return response.ok ? (VERSION_RE.exec(await response.text()) || [])[1] || null : null;
  } catch {
    return null;
  }
}

function readCache() {
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    return cached && cached.base === base && cached.files && typeof cached.files === 'object' ? cached : null;
  } catch {
    return null;
  }
}

function writeCache(files, version) {
  // Temporal propio de este proceso: dos runners que terminan a la vez no escriben el mismo fichero.
  const tmp = `${cacheFile}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ base, version, files }), { mode: 0o600 });
    fs.renameSync(tmp, cacheFile);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
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

async function loadFiles(version) {
  const cached = readCache();
  if (version && cached && cached.version === version) {
    console.error(`[RunnerLoader] Using the cached modules of version ${version}.`);
    return { files: cached.files, current: true };
  }
  const started = Date.now();
  try {
    const files = await downloadGraph();
    writeCache(files, version);
    const kib = Math.round(Object.values(files).reduce((sum, text) => sum + text.length, 0) / 1024);
    console.error(`[RunnerLoader] Downloaded ${Object.keys(files).length} modules (${kib} KiB) in ${Date.now() - started} ms.`);
    return { files, current: false };
  } catch (error) {
    if (!error.offline || !cached) throw error;
    console.error(`[RunnerLoader] ${base} is unreachable (${error.message}); using the cached copy.`);
    return { files: cached.files, current: false };
  }
}

(async () => {
  const version = await publishedVersion();
  const { files, current } = await loadFiles(version);
  // Las librerías de terceros se piden al usarlas: con la caché de la versión publicada salen de ella si ya están;
  // si no, se descargan y se añaden a la caché.
  globalThis.ChatRunnerSource = async key => {
    if (current && typeof files[key] === 'string') return files[key];
    try {
      files[key] = await download(key);
      writeCache(files, version);
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
""".replace("__MAX_BYTES__", str(RUNNER_MAX_BYTES)).replace("__VERSION_PATTERN__", json.dumps(UI_VERSION_TITLE_PATTERN)).replace(
    "__BY_VERSION__", RUNNER_CACHE_BY_VERSION)
