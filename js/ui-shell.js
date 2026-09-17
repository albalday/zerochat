/**
 * Módulo UI Shell para ZeroChat:
 * Gestión de altura de viewport adaptativo, listeners de orientación y redimensionamiento,
 * diálogo de información de ejecución / alcance de almacenamiento y fallback de light-dismiss.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.ChatUIShell = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function resolveI18n() {
    if (typeof window !== 'undefined' && window.ChatI18n) return window.ChatI18n;
    if (typeof require !== 'undefined') {
      try { return require('./i18n.js'); } catch (_) {}
    }
    return null;
  }

  function t(key, params) {
    const I18n = resolveI18n();
    return I18n?.t?.(key, params) || key;
  }

  let activeCleanupFns = [];
  let cachedElements = null;

  function isHttpExecution(win) {
    const w = win || (typeof window !== 'undefined' ? window : null);
    return Boolean(w && ['http:', 'https:'].includes(w.location?.protocol));
  }

  function updateViewportHeight(doc, win) {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    const w = win || (typeof window !== 'undefined' ? window : null);
    if (!d || !w) return;
    let vh = w.innerHeight;
    if (w.visualViewport) {
      vh = w.visualViewport.height;
    }
    if (d.documentElement?.style?.setProperty) {
      d.documentElement.style.setProperty('--app-height', `${vh}px`);
    }
  }

  function updateExecutionInfo(elements) {
    const els = elements || cachedElements || {};
    const httpExecution = isHttpExecution();
    if (els.executionStorageScope) {
      els.executionStorageScope.textContent = t(httpExecution ? 'execution_info_http' : 'execution_info_file');
    }
  }

  function openExecutionInfo(elements) {
    const els = elements || cachedElements || {};
    if (!els.executionInfoDialog) return;
    updateExecutionInfo(els);
    if (!els.executionInfoDialog.open && els.executionInfoDialog.showModal) {
      els.executionInfoDialog.showModal();
    }
  }

  function closeExecutionInfo(elements) {
    const els = elements || cachedElements || {};
    if (els.executionInfoDialog?.open && els.executionInfoDialog.close) {
      els.executionInfoDialog.close();
    }
  }

  function setupViewportListeners(elements, callbacks = {}) {
    const w = typeof window !== 'undefined' ? window : null;
    const d = typeof document !== 'undefined' ? document : null;
    if (!w || !d) return () => {};

    const cleanups = [];
    const triggerChange = () => {
      updateViewportHeight(d, w);
      if (typeof callbacks.onViewportChange === 'function') {
        callbacks.onViewportChange();
      }
    };

    updateViewportHeight(d, w);

    if (w.visualViewport) {
      const onVvResize = () => triggerChange();
      const onVvScroll = () => triggerChange();
      w.visualViewport.addEventListener('resize', onVvResize);
      w.visualViewport.addEventListener('scroll', onVvScroll);
      cleanups.push(() => {
        w.visualViewport.removeEventListener('resize', onVvResize);
        w.visualViewport.removeEventListener('scroll', onVvScroll);
      });
    }

    const onWinResize = () => triggerChange();
    w.addEventListener('resize', onWinResize);
    cleanups.push(() => w.removeEventListener('resize', onWinResize));

    const onOrientationChange = () => {
      const t1 = setTimeout(() => triggerChange(), 100);
      const t2 = setTimeout(() => triggerChange(), 300);
      cleanups.push(() => { clearTimeout(t1); clearTimeout(t2); });
    };
    w.addEventListener('orientationchange', onOrientationChange);
    cleanups.push(() => w.removeEventListener('orientationchange', onOrientationChange));

    const userInput = elements?.userInput;
    if (userInput && userInput.addEventListener) {
      let focusTimeout = null;
      const onFocus = () => {
        focusTimeout = setTimeout(() => {
          triggerChange();
          if (userInput.scrollIntoView) {
            userInput.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          }
        }, 150);
      };
      userInput.addEventListener('focus', onFocus);
      cleanups.push(() => {
        userInput.removeEventListener('focus', onFocus);
        if (focusTimeout) clearTimeout(focusTimeout);
      });
    }

    return () => {
      cleanups.forEach(fn => { try { fn(); } catch (_) {} });
    };
  }

  function setupLightDismissDialogs(doc, callbacks = {}) {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    if (!d || typeof HTMLDialogElement === 'undefined') return () => {};
    if ('closedBy' in HTMLDialogElement.prototype) return () => {};

    const cleanups = [];
    const dialogs = d.querySelectorAll ? d.querySelectorAll('dialog[closedby="any"]:not(#notice-dialog)') : [];
    dialogs.forEach(dialog => {
      const handler = (e) => {
        if (e.target === dialog) {
          if (dialog.id === 'profiles-dialog') {
            if (typeof callbacks.onDismissProfiles === 'function') {
              callbacks.onDismissProfiles();
              return;
            }
          }
          if (typeof dialog.close === 'function') {
            dialog.close();
          }
        }
      };
      dialog.addEventListener('click', handler);
      cleanups.push(() => dialog.removeEventListener('click', handler));
    });

    return () => {
      cleanups.forEach(fn => { try { fn(); } catch (_) {} });
    };
  }

  function mount({ elements, onViewportChange, onDismissProfiles } = {}) {
    dispose();
    cachedElements = elements || {};

    const cleanupViewport = setupViewportListeners(cachedElements, { onViewportChange });
    activeCleanupFns.push(cleanupViewport);

    const cleanupLightDismiss = setupLightDismissDialogs(document, { onDismissProfiles });
    activeCleanupFns.push(cleanupLightDismiss);

    if (cachedElements.btnOpenExecutionInfo) {
      const onOpen = () => openExecutionInfo(cachedElements);
      cachedElements.btnOpenExecutionInfo.addEventListener('click', onOpen);
      activeCleanupFns.push(() => cachedElements.btnOpenExecutionInfo.removeEventListener('click', onOpen));
    }
    if (cachedElements.btnCloseExecutionInfo) {
      const onClose = () => closeExecutionInfo(cachedElements);
      cachedElements.btnCloseExecutionInfo.addEventListener('click', onClose);
      activeCleanupFns.push(() => cachedElements.btnCloseExecutionInfo.removeEventListener('click', onClose));
    }
    if (cachedElements.btnCloseExecutionInfoFooter) {
      const onCloseFooter = () => closeExecutionInfo(cachedElements);
      cachedElements.btnCloseExecutionInfoFooter.addEventListener('click', onCloseFooter);
      activeCleanupFns.push(() => cachedElements.btnCloseExecutionInfoFooter.removeEventListener('click', onCloseFooter));
    }

    return {
      openExecutionInfo: () => openExecutionInfo(cachedElements),
      closeExecutionInfo: () => closeExecutionInfo(cachedElements),
      updateExecutionInfo: () => updateExecutionInfo(cachedElements),
      updateViewportHeight: () => updateViewportHeight(document, window)
    };
  }

  function dispose() {
    activeCleanupFns.forEach(fn => { try { fn(); } catch (_) {} });
    activeCleanupFns = [];
    cachedElements = null;
  }

  return {
    isHttpExecution,
    updateViewportHeight,
    updateExecutionInfo,
    openExecutionInfo,
    closeExecutionInfo,
    setupViewportListeners,
    setupLightDismissDialogs,
    mount,
    dispose
  };
}));
