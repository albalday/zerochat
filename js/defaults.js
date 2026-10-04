/**
 * Valores predeterminados compartidos por el arranque y la configuración.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.ChatDefaults = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  return Object.freeze({
    DEFAULT_THEME: 'dark',
    WEBLLM_CONTEXT_WINDOW_SIZES: Object.freeze([4096, 8192, 16384, 32768, 65536, 131072]),
    WEBLLM_DEFAULT_CONTEXT_WINDOW_SIZE: 16384
  });
});
