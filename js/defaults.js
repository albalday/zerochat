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

  const WEBLLM_MOBILE_CONTEXT_WINDOW_SIZE = 4096;
  const WEBLLM_DESKTOP_CONTEXT_WINDOW_SIZE = 16384;

  // Se usa el dispositivo y no el ancho de ventana: lo que limita es la memoria de la GPU.
  function isMobileDevice(nav = typeof navigator !== 'undefined' ? navigator : null) {
    if (!nav) return false;
    if (typeof nav.userAgentData?.mobile === 'boolean') return nav.userAgentData.mobile;
    return /Android|iPhone|iPad|iPod|Mobile/i.test(String(nav.userAgent || ''));
  }

  function getWebllmDefaultContextWindowSize(nav) {
    return isMobileDevice(nav) ? WEBLLM_MOBILE_CONTEXT_WINDOW_SIZE : WEBLLM_DESKTOP_CONTEXT_WINDOW_SIZE;
  }

  return Object.freeze({
    DEFAULT_THEME: 'dark',
    WEBLLM_CONTEXT_WINDOW_SIZES: Object.freeze([4096, 8192, 16384, 32768, 65536, 131072]),
    WEBLLM_MOBILE_CONTEXT_WINDOW_SIZE,
    WEBLLM_DESKTOP_CONTEXT_WINDOW_SIZE,
    WEBLLM_DEFAULT_CONTEXT_WINDOW_SIZE: getWebllmDefaultContextWindowSize(),
    isMobileDevice,
    getWebllmDefaultContextWindowSize
  });
});
