/**
 * Cargador bajo demanda de librerías de terceros (ChatVendorLoader).
 *
 * Cada librería vive en `js/vendor/<id>.browser.js` como IIFE clásico que define el global
 * `ZeroChat<Id>` (convención que impone `npm run build:vendor`). En el navegador se inyecta
 * una sola vez como `<script>` clásico, lo que funciona también en file://; fuera de
 * PRECACHE_ASSETS, el service worker la guarda en caché la primera vez que se descarga.
 * En Node se evalúa el mismo bundle en el contexto global.
 */

(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    const fs = require('node:fs');
    const path = require('node:path');
    const vm = require('node:vm');
    const runBundle = async (src) => {
      const filename = path.join(__dirname, '..', src);
      vm.runInThisContext(fs.readFileSync(filename, 'utf8'), { filename });
    };
    module.exports = factory(runBundle);
  } else {
    root.ChatVendorLoader = factory(null);
  }
})(typeof self !== 'undefined' ? self : this, function (runBundle) {
  'use strict';

  const VALID_ID = /^[a-z][a-z0-9-]*$/;
  const pending = new Map();

  function bundleSource(id) {
    return `js/vendor/${id}.browser.js`;
  }

  function globalNameFor(id) {
    return 'ZeroChat' + id.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('');
  }

  function unavailableError(id, cause) {
    const error = new Error(`The ${id} library could not be loaded. It is downloaded on first use; connect once so it is cached for offline use.`);
    error.code = 'VENDOR_UNAVAILABLE';
    if (cause) error.cause = cause;
    return error;
  }

  function injectScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.addEventListener('load', () => resolve(), { once: true });
      script.addEventListener('error', () => {
        script.remove();
        reject(new Error(`Failed to load ${src}`));
      }, { once: true });
      document.head.appendChild(script);
    });
  }

  /**
   * Devuelve el global de la librería `id`, cargándola la primera vez.
   * Las llamadas concurrentes comparten la misma carga; un fallo permite reintentar después.
   */
  function load(id) {
    if (typeof id !== 'string' || !VALID_ID.test(id)) {
      return Promise.reject(new Error(`Invalid vendor library id: ${id}`));
    }
    const globalName = globalNameFor(id);
    if (globalThis[globalName]) return Promise.resolve(globalThis[globalName]);
    if (pending.has(id)) return pending.get(id);

    const src = bundleSource(id);
    const loading = (runBundle ? runBundle(src) : injectScript(src))
      .catch(cause => { throw unavailableError(id, cause); })
      .then(() => {
        if (!globalThis[globalName]) throw unavailableError(id, new Error(`${src} did not define ${globalName}`));
        return globalThis[globalName];
      })
      .finally(() => pending.delete(id));
    pending.set(id, loading);
    return loading;
  }

  return { load };
});
