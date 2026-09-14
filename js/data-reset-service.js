/**
 * Servicio de Borrado Global de Datos y Parada Previa de Operaciones para ZeroChat.
 * Detiene generaciones en curso, confirma con el usuario vía ChatDialogs y limpia
 * IndexedDB, cachés de modelos y almacenamiento web de forma segura.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.ChatDataResetService = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function resolveDep(globalName, relPath) {
    if (typeof window !== 'undefined' && window[globalName]) return window[globalName];
    if (typeof globalThis !== 'undefined' && globalThis[globalName]) return globalThis[globalName];
    if (typeof require !== 'undefined') {
      try { return require(relPath); } catch (_) {}
    }
    return null;
  }

  function getI18n() { return resolveDep('ChatI18n', './i18n.js'); }
  function getDialogs() { return resolveDep('ChatDialogs', './ui-dialogs.js'); }
  function getStorage() { return resolveDep('ChatStorage', './cookies.js'); }
  function getProviders() { return resolveDep('ChatProviders', './providers.js'); }

  function t(key, params) {
    const I18n = getI18n();
    return I18n?.t?.(key, params) || key;
  }

  async function requestResetConfirmation() {
    const Dialogs = getDialogs();
    if (Dialogs && typeof Dialogs.confirm === 'function') {
      return await Dialogs.confirm(t('confirm_clear_all_data'));
    }
    return true;
  }

  /**
   * Ejecuta el proceso de borrado global:
   * 1. Detiene cualquier controlador de aborto activo.
   * 2. Pide confirmación al usuario (salvo que skipConfirm sea true).
   * 3. Desactiva proveedores locales activos (WebLLM, etc.).
   * 4. Invoca la limpieza completa de almacenamiento con ChatStorage.clearAllStorage().
   * 5. Notifica el resultado y recarga la página o invoca onComplete.
   *
   * @param {Object} options
   * @param {AbortController|Function} [options.abortController]
   * @param {boolean} [options.skipConfirm=false]
   * @param {boolean} [options.reload=true]
   * @param {Function} [options.onComplete]
   * @returns {Promise<{ confirmed: boolean, success: boolean, error?: string }>}
   */
  async function resetAllData(options = {}) {
    const {
      abortController = null,
      skipConfirm = false,
      reload = true,
      onComplete = null
    } = options;

    if (!skipConfirm) {
      const confirmed = await requestResetConfirmation();
      if (!confirmed) {
        return { confirmed: false, success: false };
      }
    }

    // 1. Detener cualquier generación activa
    try {
      if (typeof abortController === 'function') {
        abortController();
      } else if (abortController && typeof abortController.abort === 'function') {
        abortController.abort();
      }
    } catch (abortErr) {
      console.warn('Error al detener operaciones previas al borrado:', abortErr);
    }

    // 2. Desactivar proveedores locales si están registrados
    try {
      const providers = getProviders();
      await providers?.registry?.get?.('webllm')?.deactivate?.();
    } catch (providerErr) {
      console.warn('Error al desactivar proveedor previo al borrado:', providerErr);
    }

    // 3. Limpiar almacenamiento
    const Storage = getStorage();
    let success = true;
    let error = null;

    try {
      if (Storage && typeof Storage.clearAllStorage === 'function') {
        success = await Storage.clearAllStorage();
        if (!success && typeof Storage.getLastClearAllStorageError === 'function') {
          error = Storage.getLastClearAllStorageError();
        }
      } else {
        try { if (typeof localStorage !== 'undefined') localStorage.clear(); } catch (_) {}
        try { if (typeof sessionStorage !== 'undefined') sessionStorage.clear(); } catch (_) {}
      }
    } catch (storageErr) {
      success = false;
      error = storageErr?.message || String(storageErr);
      console.error('Error durante la limpieza de almacenamiento:', storageErr);
    }

    // 4. Notificar o alertar
    if (typeof onComplete === 'function') {
      await onComplete({ success, error });
    } else if (!success) {
      const Dialogs = getDialogs();
      if (Dialogs && typeof Dialogs.alert === 'function') {
        const msg = error ? t('clear_all_data_failed_detail', { detail: error }) : t('clear_all_data_failed');
        await Dialogs.alert(msg, { type: 'error' });
      }
    }

    // 5. Recargar si fue exitoso y se solicitó
    if (success && reload && typeof window !== 'undefined' && window.location && typeof window.location.reload === 'function') {
      window.location.reload();
    }

    return { confirmed: true, success, error };
  }

  return {
    requestResetConfirmation,
    resetAllData,
    reset: resetAllData
  };
}));
