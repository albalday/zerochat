/**
 * Borrado de todos los datos locales: tras confirmarlo, detiene la generación en curso y el motor
 * WebLLM, limpia el almacenamiento y recarga la página.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./utils.js'), require('./i18n.js'));
  } else {
    root.ChatDataResetService = factory(root.ChatUtils, root.ChatI18n);
  }
}(typeof self !== 'undefined' ? self : this, function (Utils, I18n) {
  'use strict';

  const { resolveDep } = Utils;
  const { t } = I18n;

  const getDialogs = () => resolveDep('ChatDialogs', './ui-dialogs.js');
  const getStorage = () => resolveDep('ChatStorage', './cookies.js');

  /**
   * Borra todos los datos si el usuario lo confirma. Si falla, avisa con el motivo y no recarga.
   * @returns {Promise<{ confirmed: boolean, success: boolean, error?: string }>}
   */
  async function resetAllData() {
    if (!await getDialogs().confirm(t('confirm_clear_all_data'))) return { confirmed: false, success: false };

    resolveDep('ChatGenerationController', './generation-controller.js').handleStopGeneration();
    try {
      await resolveDep('ChatWebLLM', './providers-webllm.js').adapter.deactivate();
    } catch (error) {
      console.warn('[ChatDataResetService] Could not stop the WebLLM engine before the reset:', error);
    }

    const Storage = getStorage();
    let success;
    let error = null;
    try {
      success = await Storage.clearAllStorage();
      if (!success) error = Storage.getLastClearAllStorageError();
    } catch (storageError) {
      success = false;
      error = storageError?.message || String(storageError);
      console.error('[ChatDataResetService] Storage reset failed:', storageError);
    }

    if (!success) {
      await getDialogs().alert(error ? t('clear_all_data_failed_detail', { detail: error }) : t('clear_all_data_failed'), { type: 'error' });
      return { confirmed: true, success, error };
    }
    window.location.reload();
    return { confirmed: true, success };
  }

  return { resetAllData };
}));
