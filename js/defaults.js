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
    DEFAULT_THEME: 'dark'
  });
});
