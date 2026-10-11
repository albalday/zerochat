/**
 * Módulo UI Shell para ZeroChat: altura de viewport adaptativa (teclado virtual, orientación y
 * redimensionamiento) y cierre de diálogos al pulsar fuera en navegadores sin `closedby`.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.ChatUIShell = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  let activeCleanupFns = [];

  function listen(target, type, handler) {
    target.addEventListener(type, handler);
    activeCleanupFns.push(() => target.removeEventListener(type, handler));
  }

  function updateViewportHeight() {
    const height = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    document.documentElement.style.setProperty('--app-height', `${height}px`);
  }

  function setupViewportListeners(elements, onViewportChange) {
    const triggerChange = () => {
      updateViewportHeight();
      onViewportChange();
    };
    updateViewportHeight();

    if (window.visualViewport) {
      listen(window.visualViewport, 'resize', triggerChange);
      listen(window.visualViewport, 'scroll', triggerChange);
    }
    listen(window, 'resize', triggerChange);
    listen(window, 'orientationchange', () => {
      const timers = [setTimeout(triggerChange, 100), setTimeout(triggerChange, 300)];
      activeCleanupFns.push(() => timers.forEach(clearTimeout));
    });

    let focusTimeout = null;
    listen(elements.userInput, 'focus', () => {
      focusTimeout = setTimeout(() => {
        triggerChange();
        elements.userInput.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }, 150);
    });
    activeCleanupFns.push(() => clearTimeout(focusTimeout));
  }

  function setupLightDismissDialogs(onDismissProfiles) {
    if ('closedBy' in HTMLDialogElement.prototype) return;
    document.querySelectorAll('dialog[closedby="any"]:not(#notice-dialog)').forEach(dialog => {
      listen(dialog, 'click', event => {
        if (event.target !== dialog) return;
        if (dialog.id === 'profiles-dialog') onDismissProfiles();
        else dialog.close();
      });
    });
  }

  function mount({ elements, onViewportChange, onDismissProfiles }) {
    dispose();
    setupViewportListeners(elements, onViewportChange);
    setupLightDismissDialogs(onDismissProfiles);
  }

  function dispose() {
    activeCleanupFns.forEach(fn => fn());
    activeCleanupFns = [];
  }

  return { mount };
}));
