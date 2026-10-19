/**
 * Interfaz de los perfiles: menú del perfil activo, editor de perfiles con detección de
 * cambios sin guardar, borrado, exportación cifrada, importación desde un paquete exportado y
 * contraseña de cifrado de las API keys.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./utils.js'), require('./i18n.js'), require('./icons.js'));
  } else {
    root.ChatUIProfiles = factory(root.ChatUtils, root.ChatI18n, root.ChatIcons);
  }
}(typeof self !== 'undefined' ? self : this, function (Utils, I18n, Icons) {
  'use strict';

  const { resolveDep, createId, escapeHtml } = Utils;
  const { t } = I18n;

  const getProfiles = () => resolveDep('ChatProfileRepository', './profile-repository.js');
  const getProfileBackup = () => resolveDep('ChatProfileBackup', './profile-backup.js');
  const getProfileExportBundle = () => resolveDep('ChatProfileExportBundle', './profile-export-bundle.js');
  const getConfig = () => resolveDep('ChatConfig', './config-store.js');
  const getProviders = () => resolveDep('ChatProviders', './providers.js');
  const getWebLLM = () => resolveDep('ChatWebLLM', './providers-webllm.js');
  const getExport = () => resolveDep('ChatExport', './export.js');
  const getDialogs = () => resolveDep('ChatDialogs', './ui-dialogs.js');
  const getUISettings = () => resolveDep('ChatUISettings', './ui-settings.js');
  const getUIMcp = () => resolveDep('ChatUIMcp', './ui-mcp.js');

  // Elementos y callbacks de la aplicación, fijados en mount().
  let els = null;
  let options = {};
  let cleanups = [];

  const runtimeConfig = () => options.getRuntimeConfig();
  const selectedProfileId = () => els.profileSelectHelper.value;
  const showProfileFeedback = (message, type = 'success') => getUISettings().showProfileFeedback(els, message, type);

  function listen(target, type, handler) {
    target.addEventListener(type, handler);
    cleanups.push(() => target.removeEventListener(type, handler));
  }

  /** Muestra en el editor el perfil indicado: su id, nombre y descripción. */
  function populateProfileSelector(profileId) {
    const profile = getProfiles().get(profileId);
    els.profileSelectHelper.value = profileId || '';
    els.settingProfileName.value = profile?.name || '';
    els.settingProfileDescription.value = profile?.description || '';
  }

  // Un cambio en el formulario lo marca como modificado hasta guardar, descartar o cambiar de perfil.
  const isProfileFormDirty = () => els.profilesDialog.dataset.profileDirty === 'true';
  const isProfileQueryReady = () => els.profilesDialog.dataset.queryReady === 'true';

  function setProfileDirty(dirty) {
    els.profilesDialog.dataset.profileDirty = String(Boolean(dirty));
  }

  function setProfileQueryState(ready) {
    els.profilesDialog.dataset.queryReady = String(Boolean(ready));
    syncProfileSaveState();
  }

  function canSaveProfile() {
    if (!els.settingProfileName.value.trim()) return false;
    return isProfileFormDirty() || isProfileQueryReady();
  }

  function syncProfileSaveState() {
    const canSave = canSaveProfile();
    const isReadOnly = selectedProfileId() === getProfiles().READONLY_PROFILE_ID;
    getUISettings().syncProfileEditor(els, isReadOnly);

    // Mientras se descifra la API key del perfil no se puede editar ni guardar.
    const keyUnavailable = els.settingApiKey._loadedApiKey === undefined;
    if (keyUnavailable) els.settingApiKey.disabled = true;
    els.btnSaveProfile.disabled = keyUnavailable;
    if (isReadOnly) return;
    const selectedModel = (els.settingModel.value || els.modelSelectHelper.value).trim();
    if (!els.settingProfileName.value.trim()) {
      els.profileSaveQueryHint.textContent = t('field_profile_placeholder');
    } else if (!canSave) {
      els.profileSaveQueryHint.textContent = t('profile_save_changes_required');
    } else if (els.settingApiType.value === 'webllm' && selectedModel && getWebLLM().isModelCompleted(selectedModel)) {
      els.profileSaveQueryHint.textContent = t('webllm_query_optional');
    } else {
      els.profileSaveQueryHint.textContent = t('profile_save_pending');
    }
  }

  /**
   * Carga en el formulario los ajustes de un perfil. La API key se descifra después (puede pedir la
   * contraseña) y solo se escribe si el usuario sigue en el mismo perfil.
   */
  async function applyProfileToForm(profileData, profileId) {
    const keyInput = els.settingApiKey;
    keyInput._loadedApiKey = undefined;
    keyInput.value = '';
    setProfileDirty(false);
    getUISettings().applyProfileToForm(els, profileData);
    syncProfileSaveState();
    try {
      const profile = await loadProfileUnlocked(profileId);
      if (selectedProfileId() !== profileId) return;
      const apiKey = profile?.settings?.apiKey || '';
      keyInput.value = apiKey;
      keyInput._loadedApiKey = apiKey;
    } catch (error) {
      if (selectedProfileId() !== profileId) return;
      showProfileFeedback(t('err_profiles_backup', { err: error?.message || t('notice_error') }), 'error');
    }
    syncProfileSaveState();
  }

  /**
   * Activa un perfil y arranca sus servicios MCP externos y, si es la herramienta de navegación, Playwright MCP.
   * Devuelve una promesa con { started, unavailable }, para que cada llamada decida cómo avisar.
   */
  function activateConnectionProfile(profileId, activationOptions) {
    getWebLLM().adapter.disposeActiveEngine().catch(() => {});
    getConfig().activateProfile(profileId, activationOptions);
    options.loadCachedModels();
    options.resetTelemetryDisplay();
    return getUIMcp().startProfileServers(runtimeConfig());
  }

  /**
   * Avisa de los servicios MCP que ha arrancado el perfil, que siguen en marcha hasta que el usuario
   * los detenga, y de los que no ha podido arrancar.
   */
  async function reportProfileServers({ started, unavailable }) {
    const lines = [];
    if (started.length > 0) lines.push(t('profile_mcp_started', { names: started.join(', ') }));
    if (unavailable.length > 0) lines.push(t('profile_mcp_unavailable', { names: unavailable.join(', ') }));
    if (lines.length === 0) return;
    await getDialogs().alert(lines.join('\n\n'), { type: unavailable.length > 0 ? 'warning' : 'info' });
  }

  /** Activa un perfil desde la interfaz y avisa de los servicios MCP que ha arrancado o no. */
  function activateProfileFromUI(profileId) {
    activateConnectionProfile(profileId).then(reportProfileServers)
      .catch(error => console.warn('[UIProfiles] Could not start the profile MCP servers:', error));
  }

  /** Arranca los servicios MCP del perfil activo al conectar con el servidor local. */
  function startActiveProfileServers() {
    return getUIMcp().startProfileServers(runtimeConfig()).then(reportProfileServers);
  }

  function setProfileMenuOpen(open) {
    els.activeProfileTrigger.setAttribute('aria-expanded', String(open));
    els.activeProfilePopover.hidden = !open;
  }

  function openProfileMenu() {
    getUISettings().renderProfileMenu(els, getProfiles().list(), runtimeConfig().activeProfile?.id);
    setProfileMenuOpen(true);
  }

  const closeProfileMenu = () => setProfileMenuOpen(false);

  async function handleSaveProfile() {
    const Profiles = getProfiles();
    if (els.settingApiKey._loadedApiKey === undefined) return false;
    // Sin nada que guardar, Guardar cierra el panel como en el resto de paneles.
    if (!isProfileFormDirty() && !isProfileQueryReady()) return true;
    if (els.profilesDialog.dataset.profileLocked === 'true') return false;
    if (!canSaveProfile()) {
      showProfileFeedback(t('field_profile_placeholder'), 'error');
      return false;
    }
    const name = els.settingProfileName.value.trim();
    const selected = Profiles.get(selectedProfileId());
    const sameName = Profiles.findByName(name);
    if (selected?.id === Profiles.READONLY_PROFILE_ID || sameName?.id === Profiles.READONLY_PROFILE_ID) {
      showProfileFeedback(t('err_profile_read_only'), 'error');
      return false;
    }
    if (sameName && sameName.id !== selected?.id) {
      showProfileFeedback(t('err_profile_name_exists', { name }), 'error');
      return false;
    }

    const baseSettings = selected?.settings || Profiles.NEW_PROFILE_SETTINGS;
    const formConfig = getUISettings().gatherCurrentFormConfig(els, runtimeConfig());
    const apiType = els.settingApiType.value || baseSettings.apiType;
    const apiKey = els.settingApiKey.value.trim();
    const saved = await Profiles.saveEditable({
      id: selected?.id || createId('profile'),
      name,
      description: els.settingProfileDescription.value.trim(),
      settings: {
        ...baseSettings,
        apiType,
        apiUrl: els.settingApiUrl.value.trim() || baseSettings.apiUrl || getProviders().registry.get(apiType).getConnectionConfig().endpoint,
        apiKey,
        apiKeyLocked: els.settingApiKeyLocked.checked,
        model: els.settingModel.value.trim(),
        systemPrompt: els.settingSystemPrompt.value.trim(),
        temperature: els.settingTemperature.value || baseSettings.temperature,
        webllmConfig: formConfig.webllmConfig,
        mcpServers: getUISettings().gatherProfileMcpServers(els)
      }
    });

    populateProfileSelector(saved.id);
    els.settingApiKey._loadedApiKey = apiKey;
    setProfileDirty(false);
    setProfileQueryState(false);
    activateProfileFromUI(saved.id);
    showProfileFeedback(t('msg_profile_saved', { name }), 'success');
    return true;
  }

  async function handleDeleteProfileById(profileId) {
    const Profiles = getProfiles();
    const profile = Profiles.get(profileId);
    if (!profile || profileId === Profiles.READONLY_PROFILE_ID) {
      showProfileFeedback(t('err_profile_read_only'), 'error');
      return false;
    }
    if (!await getDialogs().confirm(t('confirm_delete_profile', { name: profile.name }))) return false;
    if (!Profiles.remove(profile.id)) return false;
    if (runtimeConfig().activeProfile?.id === profile.id) getConfig().activateFallbackProfile();
    const nextActiveId = runtimeConfig().activeProfile?.id || '';
    populateProfileSelector(nextActiveId);
    applyProfileToForm(runtimeConfig(), nextActiveId);
    setProfileQueryState(false);
    // El control del perfil activo se actualiza también si el borrado no cambió la configuración.
    options.updateUIFromConfig();
    getUISettings().renderProfileMenu(els, Profiles.list(), nextActiveId);
    showProfileFeedback(t('msg_profile_deleted', { name: profile.name }), 'success');
    return true;
  }

  async function handleInspectProfile(profileId) {
    try {
      const profile = await loadProfileUnlocked(profileId);
      if (!profile) return;
      closeProfileMenu();
      await options.inspectProfile(profile);
    } catch (error) {
      if (!error?.cancelled) showProfileFeedback(t('err_profiles_backup', { err: error?.message || t('notice_error') }), 'error');
    }
  }

  async function handleExportProfiles() {
    const Profiles = getProfiles();
    const ProfileBackup = getProfileBackup();
    try {
      const profiles = Profiles.list().filter(profile => profile.id !== Profiles.READONLY_PROFILE_ID);
      if (profiles.length === 0) {
        showProfileFeedback(t('err_no_profiles_to_export'), 'error');
        return;
      }
      const keyMaterial = await resolveCurrentKeyForRecipher();
      if (keyMaterial === undefined) return;
      if (keyMaterial) ProfileBackup.cacheKeyMaterial(keyMaterial);
      const encrypted = await ProfileBackup.encryptProfiles(profiles, keyMaterial);
      const date = new Date().toISOString().slice(0, 10);
      const htmlBundle = getProfileExportBundle().generateExportHTML(encrypted, { profileCount: profiles.length, appLocation: window.location });
      if (!getExport().downloadFile(htmlBundle, `zerochat_profiles_${date}.html`, 'text/html')) {
        throw new Error('The file could not be downloaded.');
      }
      showProfileFeedback(t('msg_profiles_exported_html'), 'success');
    } catch (error) {
      showProfileFeedback(t('err_profiles_backup', { err: error?.message || t('notice_error') }), 'error');
    }
  }

  /** Perfil con su API key descifrada; pide la contraseña si está cifrada. Los fallos se propagan. */
  async function loadProfileUnlocked(profileId) {
    if (!profileId) return null;
    return getProfileBackup().withPassword(
      keyMaterial => getProfiles().load(profileId, keyMaterial),
      () => requestEncryptionPassword(t('crypto_current_password_prompt'))
    );
  }

  /**
   * Modo importación: un paquete de perfiles exportado abrió esta página (#mode=import) y le envía
   * sus datos cifrados por postMessage. Devuelve true si la página arrancó en ese modo; al terminar,
   * bien o mal, se recarga sin el fragmento para arrancar con normalidad.
   */
  function startImportMode(elements) {
    const hashParams = new URLSearchParams(location.hash.replace(/^#/, ''));
    if (hashParams.get('mode') !== 'import') return false;
    const transferId = hashParams.get('transferId') || '';
    const validTransfer = /^[A-Za-z0-9_-]{16,128}$/.test(transferId);

    elements.messagesList.hidden = true;
    elements.chatForm.hidden = true;
    const banner = document.createElement('div');
    banner.className = 'import-waiting-banner';
    banner.innerHTML = `<div class="import-waiting-content">${Icons.get('download', { size: 64 })}
      <h2>${escapeHtml(t('profile_import_waiting_title'))}</h2>
      <p>${escapeHtml(t('profile_import_waiting_desc'))}</p></div>`;
    document.body.appendChild(banner);

    let importInProgress = false;
    window.addEventListener('message', async event => {
      const data = event.data;
      if (!validTransfer || importInProgress || data?.type !== 'import_profiles' ||
          data.transferId !== transferId || event.source !== window.opener) return;
      importInProgress = true;
      const reply = result => {
        if (!event.source.closed) event.source.postMessage({ type: 'import_result', transferId, ...result }, '*');
      };
      try {
        if (typeof data.payload !== 'string' || !data.payload) throw new Error('Invalid payload format');
        const Backup = getProfileBackup();
        const imported = await Backup.withPassword(
          keyMaterial => Backup.decryptProfiles(data.payload, keyMaterial),
          () => requestEncryptionPassword(t('crypto_current_password_prompt'))
        );
        if (!Array.isArray(imported) || imported.length === 0) throw new Error('No valid profiles found in payload');
        if (!await getDialogs().confirm(t('confirm_auto_import_profiles', { count: imported.length }))) {
          throw new Error('Import cancelled by user');
        }
        const result = getProfiles().mergeImported(imported);
        reply({ success: true, result: { added: result.added, replaced: result.replaced, total: result.total } });
        await getDialogs().alert(t('msg_profiles_auto_imported', { added: result.added, replaced: result.replaced }));
      } catch (error) {
        console.error('[UIProfiles] Profile import failed:', error);
        reply({ success: false, error: error.message });
        await getDialogs().alert(t('err_auto_import_failed', { err: error.message }));
      } finally {
        history.replaceState(null, '', location.pathname + location.search);
        location.reload();
      }
    });

    if (validTransfer && window.opener && !window.opener.closed) {
      const notifyReady = () => window.opener.postMessage({ type: 'zerochat_import_ready', transferId }, '*');
      if (document.readyState === 'complete') notifyReady();
      else window.addEventListener('load', notifyReady, { once: true });
    }
    return true;
  }

  function requestEncryptionPassword(message) {
    return getDialogs().prompt(message, '', {
      inputType: 'password',
      title: t('crypto_password_title'),
      acceptText: t('notice_accept'),
      cancelText: t('notice_cancel')
    });
  }

  /** Clave actual de las API keys: la guardada en la sesión o la de la contraseña; undefined si se cancela. */
  async function resolveCurrentKeyForRecipher() {
    const Profiles = getProfiles();
    const Backup = getProfileBackup();
    const cached = Backup.getCachedKeyMaterial();
    try {
      await Profiles.verifyApiKeyMaterial(cached);
      return cached;
    } catch (error) {
      if (error?.code !== 'PASSWORD_REQUIRED') throw error;
    }
    const password = await requestEncryptionPassword(t('crypto_current_password_prompt'));
    if (password === null) return undefined;
    const keyMaterial = await Backup.keyMaterialFromPassword(password);
    await Profiles.verifyApiKeyMaterial(keyMaterial);
    return keyMaterial;
  }

  async function handleEncryptionPassword() {
    const Dialogs = getDialogs();
    const Backup = getProfileBackup();
    const nextPassword = await requestEncryptionPassword(t('crypto_new_password_prompt'));
    if (nextPassword === null) return;
    if (!nextPassword) {
      await Dialogs.alert(t('crypto_password_empty'), { type: 'error' });
      return;
    }
    const confirmation = await requestEncryptionPassword(t('crypto_confirm_password_prompt'));
    if (confirmation === null) return;
    if (nextPassword !== confirmation) {
      await Dialogs.alert(t('crypto_password_mismatch'), { type: 'error' });
      return;
    }
    try {
      const current = await resolveCurrentKeyForRecipher();
      if (current === undefined) return;
      const next = await Backup.keyMaterialFromPassword(nextPassword);
      await getProfiles().recipherApiKeys(current, next);
      Backup.cacheKeyMaterial(next);
      await Dialogs.alert(t('crypto_password_saved'), { type: 'success' });
    } catch (error) {
      await Dialogs.alert(t('crypto_password_error', { err: error?.message || t('notice_error') }), { type: 'error' });
    }
  }

  async function handleUseDefaultEncryptionKey() {
    const Dialogs = getDialogs();
    if (!await Dialogs.confirm(t('crypto_default_confirm'), { type: 'warning' })) return;
    try {
      const current = await resolveCurrentKeyForRecipher();
      if (current === undefined) return;
      const reciphered = await getProfiles().recipherApiKeys(current, null);
      getProfileBackup().clearCachedKeyMaterial();
      await Dialogs.alert(t(reciphered ? 'crypto_default_saved' : 'crypto_default_no_api_keys'), { type: 'success' });
    } catch (error) {
      await Dialogs.alert(t('crypto_password_error', { err: error?.message || t('notice_error') }), { type: 'error' });
    }
  }

  function hideEditorStatus() {
    els.serverQueryStatus.hidden = true;
    els.profileActionFeedback.hidden = true;
  }

  function resetProfileFormToSelected() {
    const profile = getProfiles().get(selectedProfileId());
    applyProfileToForm(profile?.settings || runtimeConfig(), selectedProfileId());
    hideEditorStatus();
    setProfileQueryState(false);
  }

  function showProfilesDialog() {
    hideEditorStatus();
    getUISettings().resetProfileChapters(els);
    setProfileQueryState(false);
    setProfileDirty(false);
    options.loadCachedModels();
    syncProfileSaveState();
    if (!els.profilesDialog.open) els.profilesDialog.showModal();
  }

  /** Abre el editor vacío para un perfil nuevo: no hereda nombre, clave ni bloqueo del anterior. */
  function openNewProfileModal() {
    closeProfileMenu();
    options.closeSettingsModal();
    els.profilesDialog.dataset.profileLocked = 'false';
    populateProfileSelector('');
    applyProfileToForm(getProfiles().NEW_PROFILE_SETTINGS, '');
    els.settingApiKey._loadedApiKey = '';
    els.settingApiKeyLocked.checked = false;
    const UISettings = getUISettings();
    UISettings.syncProviderFields(els);
    UISettings.syncApiKeyLock(els, false);
    showProfilesDialog();
    els.settingProfileName.focus();
  }

  function openProfilesModal(targetProfileId = null) {
    closeProfileMenu();
    options.closeSettingsModal();
    const profileId = targetProfileId || runtimeConfig().activeProfile?.id || '';
    populateProfileSelector(profileId);
    applyProfileToForm(getProfiles().get(profileId)?.settings || runtimeConfig(), profileId);
    showProfilesDialog();
  }

  let isClosingProfilesModal = false;

  /** Cierra el editor; con cambios o una consulta sin guardar pide confirmación salvo con `force`. */
  async function closeProfilesModal(force = false) {
    if (!els.profilesDialog.open || isClosingProfilesModal) return false;
    const hasUnsavedQuery = isProfileQueryReady();
    if (!force && (hasUnsavedQuery || isProfileFormDirty())) {
      isClosingProfilesModal = true;
      try {
        const discard = await getDialogs().confirm(t(hasUnsavedQuery ? 'confirm_profile_query_not_saved' : 'confirm_profile_unsaved_changes'));
        if (!discard) {
          els.btnSaveProfile.focus();
          return false;
        }
      } finally {
        isClosingProfilesModal = false;
      }
    }
    setProfileDirty(false);
    resetProfileFormToSelected();
    els.profilesDialog.close();
    return true;
  }

  /** Cambia al perfil guardado cuyo nombre se escribe en el editor. */
  function switchToProfile(profile) {
    els.profileSelectHelper.value = profile.id;
    applyProfileToForm(profile.settings, profile.id);
    els.settingProfileDescription.value = profile.description || '';
    activateProfileFromUI(profile.id);
    setProfileQueryState(false);
    setProfileDirty(false);
  }

  function bindEditor() {
    listen(els.profilesDialog, 'cancel', event => {
      if (!isProfileQueryReady() && !isProfileFormDirty()) {
        resetProfileFormToSelected();
        return;
      }
      event.preventDefault();
      closeProfilesModal(false);
    });
    const onModify = () => {
      setProfileDirty(true);
      syncProfileSaveState();
    };
    listen(els.profilesDialog, 'input', onModify);
    listen(els.profilesDialog, 'change', onModify);

    listen(els.settingProfileName, 'change', () => {
      const profile = getProfiles().findByName(els.settingProfileName.value.trim());
      if (profile) switchToProfile(profile);
      syncProfileSaveState();
    });
    listen(els.settingProfileName, 'input', syncProfileSaveState);

    listen(els.settingApiType, 'change', () => {
      const registry = getProviders().registry;
      const currentUrl = els.settingApiUrl.value.trim();
      // Una URL vacía o de otro proveedor conocido se sustituye por la del proveedor elegido.
      if (!currentUrl || registry.getConnectionEndpoints().includes(currentUrl)) {
        const endpoint = registry.get(els.settingApiType.value).getConnectionConfig().endpoint;
        if (endpoint) els.settingApiUrl.value = endpoint;
      }
      getUISettings().syncProviderFields(els);
      options.loadCachedModels();
      setProfileQueryState(false);
    });
    for (const input of [els.settingApiUrl, els.settingApiKey]) {
      listen(input, 'input', () => setProfileQueryState(false));
    }
    listen(els.modelSelectHelper, 'change', () => {
      els.settingModel.value = els.modelSelectHelper.value;
    });
    const syncModelHelper = () => { els.modelSelectHelper.value = els.settingModel.value.trim(); };
    listen(els.settingModel, 'input', syncModelHelper);
    listen(els.settingModel, 'change', syncModelHelper);

    listen(els.btnSaveProfile, 'click', event => {
      event.preventDefault();
      handleSaveProfile()
        .then(saved => { if (saved) closeProfilesModal(true); })
        .catch(error => showProfileFeedback(error?.message || String(error), 'error'));
    });
    listen(els.btnCloseProfiles, 'click', () => closeProfilesModal(false));
  }

  function bindMenu() {
    listen(els.activeProfileTrigger, 'click', event => {
      event.stopPropagation();
      if (els.activeProfilePopover.hidden) openProfileMenu();
      else closeProfileMenu();
    });
    listen(els.btnMenuNewProfile, 'click', openNewProfileModal);
    listen(els.btnMenuExportProfiles, 'click', handleExportProfiles);
    listen(els.btnMenuCloseProfiles, 'click', () => {
      closeProfileMenu();
      els.activeProfileTrigger.focus();
    });

    listen(els.activeProfileList, 'click', async event => {
      const actionBtn = event.target.closest('[data-profile-action]');
      if (actionBtn) {
        event.stopPropagation();
        const { profileAction, targetId } = actionBtn.dataset;
        if (profileAction === 'edit') openProfilesModal(targetId);
        else if (profileAction === 'inspect') await handleInspectProfile(targetId);
        else if (profileAction === 'delete') await handleDeleteProfileById(targetId);
        return;
      }
      const option = event.target.closest('[data-profile-id]');
      if (!option || !getProfiles().get(option.dataset.profileId)) return;
      activateProfileFromUI(option.dataset.profileId);
      options.updateUIFromConfig();
      closeProfileMenu();
      els.activeProfileTrigger.focus();
    });

    listen(els.activeProfileMenu, 'keydown', event => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      if (els.activeProfilePopover.hidden) openProfileMenu();
      const buttons = [...els.activeProfileList.querySelectorAll('button')];
      const index = buttons.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    });
    listen(els.activeProfileMenu, 'focusout', event => {
      if (!els.activeProfileMenu.contains(event.relatedTarget)) closeProfileMenu();
    });
    listen(document, 'click', event => {
      if (!els.activeProfileMenu.contains(event.target)) closeProfileMenu();
    });
    listen(document, 'keydown', event => {
      if (event.key !== 'Escape' || els.activeProfileTrigger.getAttribute('aria-expanded') !== 'true') return;
      closeProfileMenu();
      els.activeProfileTrigger.focus();
    });
  }

  /**
   * Conecta el menú y el editor de perfiles. `callbacks` aporta getRuntimeConfig, updateUIFromConfig,
   * loadCachedModels, resetTelemetryDisplay, closeSettingsModal e inspectProfile.
   */
  function mount({ elements, ...callbacks }) {
    cleanups.forEach(cleanup => cleanup());
    cleanups = [];
    els = elements;
    options = callbacks;
    bindEditor();
    bindMenu();
  }

  return {
    mount,
    populateProfileSelector,
    setProfileQueryState,
    closeProfilesModal,
    activateConnectionProfile,
    startActiveProfileServers,
    handleEncryptionPassword,
    handleUseDefaultEncryptionKey,
    loadProfileUnlocked,
    startImportMode
  };
}));
