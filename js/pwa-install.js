/**
 * Instalación explícita de la PWA.
 * El navegador nunca debe mostrar su sugerencia automática: la instalación solo
 * se solicita como respuesta al botón de la barra lateral.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.ChatPwaInstall = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  let deferredPrompt = null;
  let installButton = null;

  function isStandalone() {
    if (typeof window === 'undefined') return false;
    return window.matchMedia?.('(display-mode: standalone)').matches === true ||
      window.navigator?.standalone === true;
  }

  function isIosSafari() {
    if (typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent || '';
    const isIos = /iPad|iPhone|iPod/.test(ua) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    return isIos && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
  }

  function canShowInstallAction() {
    return !isStandalone() && (Boolean(deferredPrompt) || isIosSafari());
  }

  function updateButton() {
    if (!installButton) return;
    installButton.hidden = !canShowInstallAction();
  }

  function handleBeforeInstallPrompt(event) {
    // Evita que llegar mediante un enlace (por ejemplo desde Ayuda) active un
    // aviso de instalación del navegador.
    event.preventDefault();
    deferredPrompt = event;
    updateButton();
  }

  function handleAppInstalled() {
    deferredPrompt = null;
    updateButton();
  }

  async function requestInstall() {
    if (isIosSafari()) {
      const dialogs = (typeof window !== 'undefined' && window.ChatDialogs) || null;
      const i18n = (typeof window !== 'undefined' && window.ChatI18n) || null;
      if (dialogs?.alert) {
        await dialogs.alert(i18n?.t?.('pwa_install_ios_instructions') || '');
      }
      return { outcome: 'manual' };
    }
    if (!deferredPrompt) return { outcome: 'unavailable' };

    const promptEvent = deferredPrompt;
    deferredPrompt = null;
    updateButton();
    await promptEvent.prompt();
    return promptEvent.userChoice || { outcome: 'dismissed' };
  }

  function setup(button) {
    installButton = button || null;
    if (!installButton) return;
    installButton.addEventListener('click', () => { requestInstall(); });
    updateButton();
  }

  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);
  }

  return {
    setup,
    requestInstall,
    isStandalone,
    isIosSafari,
    canShowInstallAction,
    handleBeforeInstallPrompt,
    handleAppInstalled
  };
});
