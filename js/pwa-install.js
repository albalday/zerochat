/** Mantiene la instalación PWA exclusivamente en las opciones del navegador. */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.ChatPwaInstall = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function handleBeforeInstallPrompt(event) {
    // Suprime la sugerencia automática, también al abrir desde Ayuda.
    // El manifiesto permite seguir instalando desde el menú del navegador.
    event.preventDefault();
  }

  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
  }

  return { handleBeforeInstallPrompt };
});
