/**
 * Módulo de Interfaz de Usuario para Perfiles de Conexión (ZeroChat).
 * Gestiona el diálogo de edición de perfiles, detección de cambios sin guardar (dirty state),
 * guardado, borrado, importación cifrada, exportación y menú desplegable de perfiles activos.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.ChatUIProfiles = factory();
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
  function getProfiles() { return resolveDep('ChatProfileRepository', './profile-repository.js'); }
  function getProfileBackup() { return resolveDep('ChatProfileBackup', './profile-backup.js'); }
  function getProfileExportBundle() { return resolveDep('ChatProfileExportBundle', './profile-export-bundle.js'); }
  function getConfig() { return resolveDep('ChatConfig', './config-store.js'); }
  function getProviders() { return resolveDep('ChatProviders', './providers.js'); }
  function getExport() { return resolveDep('ChatExport', './export.js'); }
  function getDialogs() { return resolveDep('ChatDialogs', './ui-dialogs.js'); }
  function getUISettings() { return resolveDep('ChatUISettings', './ui-settings.js'); }

  function t(key, params) {
    const I18n = getI18n();
    return I18n?.t?.(key, params) || key;
  }

  let activeCleanupFns = [];
  let cachedElements = null;
  let cachedOptions = {};

  function isDownloadedWebLLMModel(modelId) {
    if (!modelId) return false;
    const providers = getProviders();
    const adapter = providers?.registry?.get?.('webllm');
    if (typeof adapter?.isModelCompleted === 'function') {
      return adapter.isModelCompleted(modelId);
    }
    const WebLLM = resolveDep('ChatWebLLM', './providers-webllm.js');
    return WebLLM?.isModelCompleted?.(modelId) || false;
  }

  function populateProfileSelector(elements, selectedProfileName) {
    const Profiles = getProfiles();
    if (!Profiles?.list) return;
    const profiles = Profiles.list();
    const els = elements || cachedElements || {};

    if (els.profileDatalist) {
      els.profileDatalist.innerHTML = '';
      profiles.forEach(profile => {
        const opt = document.createElement('option');
        opt.value = profile.name;
        els.profileDatalist.appendChild(opt);
      });
    }

    if (els.profileSelectHelper) {
      if (els.profileSelectHelper.tagName === 'SELECT') {
        els.profileSelectHelper.innerHTML = `<option value="" disabled data-i18n="profile_select_default">▾ Elegir perfil guardado...</option>`;
        profiles.forEach(profile => {
          const opt = document.createElement('option');
          opt.value = profile.id;
          opt.textContent = profile.name;
          if (profile.id === selectedProfileName) {
            opt.selected = true;
          }
          els.profileSelectHelper.appendChild(opt);
        });
      }
      els.profileSelectHelper.value = selectedProfileName || '';
    }

    if (els.settingProfileName) {
      const selected = profiles.find(profile => profile.id === selectedProfileName);
      els.settingProfileName.value = selected?.name || '';
    }
    if (els.settingProfileDescription) {
      const selected = profiles.find(profile => profile.id === selectedProfileName);
      els.settingProfileDescription.value = selected?.description || '';
    }
  }

  async function applyProfileToForm(elements, profileData, profileId = null, options = {}) {
    const UISettings = getUISettings();
    const Profiles = getProfiles();
    const Config = getConfig();
    const els = elements || cachedElements || {};
    const opts = options || cachedOptions || {};

    if (UISettings?.applyProfileToForm) {
      const currentActiveId = opts.getRuntimeConfig?.()?.activeProfile?.id || Config?.getActive?.()?.activeProfile?.id;
      const id = profileId !== null ? profileId : (els.profileSelectHelper?.value || currentActiveId);
      const keyInput = els.settingApiKey;
      if (keyInput) {
        keyInput._loadedApiKey = undefined;
        keyInput.value = '';
      }
      setProfileDirty(els, false);
      UISettings.applyProfileToForm(els, profileData);
      syncProfileSaveState(els, opts);
      try {
        let profile = id ? await Profiles?.load?.(id) : null;
        const currentSelectedId = els.profileSelectHelper?.value || opts.getRuntimeConfig?.()?.activeProfile?.id;
        if (!keyInput || currentSelectedId !== id) return;
        const apiKey = profile?.settings?.apiKey || '';
        keyInput.value = apiKey;
        keyInput._loadedApiKey = apiKey;
        if (!isProfileFormDirty(els)) {
          setProfileDirty(els, false);
        }
        syncProfileSaveState(els, opts);
      } catch (error) {
        if (error?.code === 'PASSWORD_REQUIRED' && id) {
          const password = await requestEncryptionPassword(t('crypto_current_password_prompt'));
          if (password !== null) {
            try {
              const Backup = getProfileBackup();
              const keyMaterial = await Backup.keyMaterialFromPassword(password);
              const profile = await Profiles.load(id, keyMaterial);
              Backup.cacheKeyMaterial(keyMaterial);
              if (keyInput && (els.profileSelectHelper?.value || opts.getRuntimeConfig?.()?.activeProfile?.id) === id) {
                keyInput.value = profile?.settings?.apiKey || '';
                keyInput._loadedApiKey = keyInput.value;
                syncProfileSaveState(els, opts);
              }
              return;
            } catch (unlockError) {
              error = unlockError;
            }
          }
        }
        const currentSelectedId = els.profileSelectHelper?.value || opts.getRuntimeConfig?.()?.activeProfile?.id;
        if (currentSelectedId !== id) return;
        if (!isProfileFormDirty(els)) {
          setProfileDirty(els, false);
        }
        syncProfileSaveState(els, opts);
        showProfileFeedback(els, t('err_profiles_backup', { err: error?.message || t('notice_error') }), 'error');
      }
    }
  }

  function showProfileFeedback(elements, msg, type = 'success') {
    const UISettings = getUISettings();
    const els = elements || cachedElements || {};
    if (UISettings?.showProfileFeedback) {
      UISettings.showProfileFeedback(els, msg, type);
    }
  }

  function isProfileQueryReady(elements) {
    const els = elements || cachedElements || {};
    return els.profilesDialog?.dataset?.queryReady === 'true';
  }

  function isProfileFormDirty(elements) {
    const els = elements || cachedElements || {};
    if (els._profileDirty !== undefined) return Boolean(els._profileDirty);
    return els.profilesDialog?.dataset?.profileDirty === 'true';
  }

  function setProfileDirty(elements, dirty = true) {
    const els = elements || cachedElements || {};
    const isDirty = Boolean(dirty);
    els._profileDirty = isDirty;
    if (els.profilesDialog) {
      if (!els.profilesDialog.dataset) els.profilesDialog.dataset = {};
      els.profilesDialog.dataset.profileDirty = String(isDirty);
    }
    return isDirty;
  }

  function canSaveProfile(elements, options = {}) {
    const els = elements || cachedElements || {};
    if (els.settingProfileName && !String(els.settingProfileName.value || '').trim()) {
      return false;
    }
    return isProfileFormDirty(els) || isProfileQueryReady(els);
  }

  function syncProfileSaveState(elements, options = {}) {
    const els = elements || cachedElements || {};
    const opts = options || cachedOptions || {};
    const Profiles = getProfiles();
    const canSave = canSaveProfile(els, opts);
    const currentId = els.profileSelectHelper?.value || els.profilesDialog?.dataset?.profileId || '';
    const isReadOnly = currentId === Profiles?.READONLY_PROFILE_ID;
    const UISettings = getUISettings();
    UISettings?.syncProfileEditor?.(els, isReadOnly, canSave);

    const keyUnavailable = els.settingApiKey?._loadedApiKey === undefined;
    if (keyUnavailable && els.settingApiKey) els.settingApiKey.disabled = true;
    if (keyUnavailable && els.btnSaveProfile) els.btnSaveProfile.disabled = true;
    if (!isReadOnly) {
      if (els.btnSaveProfile) {
        els.btnSaveProfile.disabled = !canSave || keyUnavailable || els.profilesDialog?.dataset?.profileLocked === 'true';
      }
      if (els.profileSaveQueryHint) {
        const apiType = els.settingApiType?.value || '';
        const selectedModel = (els.settingModel?.value || els.modelSelectHelper?.value || '').trim();
        const profileName = String(els.settingProfileName?.value || '').trim();
        if (!profileName) {
          els.profileSaveQueryHint.textContent = t('field_profile_placeholder') || 'Nombre del perfil requerido.';
        } else if (!canSave) {
          els.profileSaveQueryHint.textContent = t('profile_save_changes_required');
        } else if (apiType === 'webllm' && selectedModel && isDownloadedWebLLMModel(selectedModel)) {
          els.profileSaveQueryHint.textContent = t('webllm_query_optional');
        } else {
          els.profileSaveQueryHint.textContent = t('profile_save_pending');
        }
      }
    }
  }

  function setProfileQueryState(elements, ready) {
    const els = elements || cachedElements || {};
    if (els.profilesDialog) {
      if (!els.profilesDialog.dataset) els.profilesDialog.dataset = {};
      els.profilesDialog.dataset.queryReady = String(ready);
    }
    syncProfileSaveState(els);
  }

  function activateConnectionProfile(profileId, options = {}) {
    const Config = getConfig();
    const opts = options || cachedOptions || {};
    if (!profileId || !Config?.activateProfile) return;
    const WebLLM = resolveDep('ChatWebLLM', './providers-webllm.js');
    WebLLM?.adapter?.disposeActiveEngine?.().catch?.(() => {});
    Config.activateProfile(profileId);
    if (typeof opts.loadCachedModels === 'function') opts.loadCachedModels();
    if (typeof opts.resetTelemetryDisplay === 'function') opts.resetTelemetryDisplay();
  }

  function setSelectedProfileAsDefault(profile, options = {}) {
    if (!profile) return;
    activateConnectionProfile(profile.id, options);
  }

  function setProfileMenuOpen(elements, open) {
    const els = elements || cachedElements || {};
    if (!els.activeProfileTrigger || !els.activeProfilePopover) return;
    els.activeProfileTrigger.setAttribute('aria-expanded', String(open));
    els.activeProfilePopover.hidden = !open;
  }

  function openProfileMenu(elements, options = {}) {
    const els = elements || cachedElements || {};
    const opts = options || cachedOptions || {};
    const Profiles = getProfiles();
    const Config = getConfig();
    const runtimeConfig = opts.getRuntimeConfig ? opts.getRuntimeConfig() : (Config?.getActive?.() || {});
    const UISettings = getUISettings();
    UISettings?.renderProfileMenu?.(els, Profiles?.list?.() || [], runtimeConfig.activeProfile?.id);
    setProfileMenuOpen(els, true);
  }

  function closeProfileMenu(elements) {
    const els = elements || cachedElements || {};
    setProfileMenuOpen(els, false);
  }

  async function handleSaveProfile(elements, options = {}) {
    const els = elements || cachedElements || {};
    const opts = options || cachedOptions || {};
    const Profiles = getProfiles();
    const Config = getConfig();
    const runtimeConfig = opts.getRuntimeConfig ? opts.getRuntimeConfig() : (Config?.getActive?.() || {});

    if (els.settingApiKey?._loadedApiKey === undefined) return false;
    if (els.profilesDialog?.dataset?.profileLocked === 'true') return false;
    if (!canSaveProfile(els, opts)) {
      showProfileFeedback(els, t('profile_save_changes_required'), 'error');
      return false;
    }
    const name = String(els.settingProfileName?.value || '').trim();
    if (!name || !Profiles?.saveEditable) return false;
    const selectedId = els.profileSelectHelper?.value || els.profilesDialog?.dataset?.profileId || '';
    const selected = Profiles.get?.(selectedId) || null;
    if (selected?.id === Profiles.READONLY_PROFILE_ID) {
      showProfileFeedback(els, t('err_profile_read_only'), 'error');
      return false;
    }
    const sameName = Profiles.findByName?.(name) || null;
    if (sameName?.id === Profiles.READONLY_PROFILE_ID) {
      showProfileFeedback(els, t('err_profile_read_only'), 'error');
      return false;
    }
    if (selected && sameName && sameName.id !== selected.id) {
      showProfileFeedback(els, t('err_profile_name_exists', { name }) || `Ya existe un perfil llamado "${name}".`, 'error');
      return false;
    }
    if (!selected && sameName) {
      showProfileFeedback(els, t('err_profile_name_exists', { name }) || `Ya existe un perfil llamado "${name}".`, 'error');
      return false;
    }

    const existing = selected;
    const baseSettings = existing?.settings || Profiles?.NEW_PROFILE_SETTINGS || runtimeConfig;
    const UISettings = getUISettings();
    const formConfig = UISettings?.gatherCurrentFormConfig ? UISettings.gatherCurrentFormConfig(els, runtimeConfig) : runtimeConfig;
    const apiKey = els.settingApiKey?.value.trim() || '';
    const description = els.settingProfileDescription?.value.trim() || '';
    const apiType = els.settingApiType?.value || baseSettings.apiType;
    const apiUrl = els.settingApiUrl?.value.trim() || baseSettings.apiUrl || getProviders()?.registry?.get?.(apiType)?.getConnectionConfig?.().endpoint || 'http://localhost:1234/v1';
    const model = els.settingModel?.value.trim() || '';
    const systemPrompt = els.settingSystemPrompt?.value.trim() || '';
    const temperature = els.settingTemperature?.value || baseSettings.temperature || '0.7';
    const maxAgentTurns = els.settingMaxAgentTurns?.value ? Number(els.settingMaxAgentTurns.value) : (baseSettings.maxAgentTurns || 15);
    const apiKeyLocked = els.settingApiKeyLocked?.checked === true;

    const saved = await Profiles.saveEditable({
      id: existing?.id || `profile:${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name,
      description,
      settings: {
        ...baseSettings,
        apiType,
        apiUrl,
        apiKey,
        apiKeyLocked,
        model,
        systemPrompt,
        temperature,
        maxAgentTurns,
        webllmConfig: formConfig?.webllmConfig || baseSettings.webllmConfig || {
          context_window_size: 'default',
          prefill_chunk_size: 'default'
        }
      }
    });

    populateProfileSelector(els, saved.id);
    if (els.profileSelectHelper) els.profileSelectHelper.value = saved.id;
    if (els.profilesDialog) {
      els.profilesDialog.dataset.profileId = saved.id;
      delete els.profilesDialog.dataset.isNew;
    }
    if (els.settingApiKey) els.settingApiKey._loadedApiKey = apiKey;
    setProfileDirty(els, false);
    setProfileQueryState(els, false);
    setSelectedProfileAsDefault(saved, opts);
    syncProfileSaveState(els, opts);
    showProfileFeedback(els, t('msg_profile_saved', { name }) || `Perfil "${name}" guardado con éxito.`, 'success');
    return true;
  }

  async function handleDeleteProfile(elements, options = {}) {
    const els = elements || cachedElements || {};
    const id = els.profileSelectHelper?.value || '';
    return handleDeleteProfileById(id, els, options);
  }

  async function handleDeleteProfileById(profileId, elements, options = {}) {
    const els = elements || cachedElements || {};
    const opts = options || cachedOptions || {};
    const Profiles = getProfiles();
    const Config = getConfig();
    const Dialogs = getDialogs();
    const runtimeConfig = opts.getRuntimeConfig ? opts.getRuntimeConfig() : (Config?.getActive?.() || {});

    if (!profileId || profileId === Profiles?.READONLY_PROFILE_ID || profileId === 'profile:mirror') {
      showProfileFeedback(els, t('err_profile_read_only'), 'error');
      return false;
    }
    const profile = Profiles?.get ? Profiles.get(profileId) : null;
    if (!profile) return false;
    if (Dialogs?.confirm && !await Dialogs.confirm(t('confirm_delete_profile', { name: profile.name }))) return false;

    const currentProfile = Profiles?.get ? Profiles.get(profileId) : null;
    if (!currentProfile) return false;
    if (Profiles?.remove?.(currentProfile.id)) {
      if (runtimeConfig.activeProfile?.id === currentProfile.id) {
        Config?.activateFallbackProfile?.();
      }
      const nextActiveId = (opts.getRuntimeConfig ? opts.getRuntimeConfig() : (Config?.getActive?.() || {})).activeProfile?.id || '';
      populateProfileSelector(els, nextActiveId);
      applyProfileToForm(els, opts.getRuntimeConfig ? opts.getRuntimeConfig() : (Config?.getActive?.() || {}));
      setProfileQueryState(els, false);
      // Keep the active-profile control synchronized even when the deleted
      // profile was not the active one and therefore did not change config.
      if (typeof opts.updateUIFromConfig === 'function') opts.updateUIFromConfig();
      const UISettings = getUISettings();
      UISettings?.renderProfileMenu?.(els, Profiles?.list?.() || [], nextActiveId);
      showProfileFeedback(els, t('msg_profile_deleted', { name: currentProfile.name }) || `Perfil "${currentProfile.name}" eliminado.`, 'success');
      return true;
    }
    return false;
  }

  async function handleMenuNewProfile(elements, options = {}) {
    const els = elements || cachedElements || {};
    const opts = options || cachedOptions || {};
    closeProfileMenu(els);
    openNewProfileModal(els, opts);
    return null;
  }

  async function handleInspectProfile(profileId, elements, options = {}) {
    const els = elements || cachedElements || {};
    const opts = options || cachedOptions || {};
    const Profiles = getProfiles();
    if (!profileId || !Profiles?.load || typeof opts.inspectProfile !== 'function') return false;
    try {
      let profile;
      try {
        profile = await Profiles.load(profileId);
      } catch (error) {
        if (error?.code !== 'PASSWORD_REQUIRED') throw error;
        const password = await requestEncryptionPassword(t('crypto_current_password_prompt'));
        if (password === null) return false;
        const Backup = getProfileBackup();
        const keyMaterial = await Backup.keyMaterialFromPassword(password);
        profile = await Profiles.load(profileId, keyMaterial);
        Backup.cacheKeyMaterial(keyMaterial);
      }
      if (!profile) return false;
      closeProfileMenu(els);
      await opts.inspectProfile(profile);
      return true;
    } catch (error) {
      showProfileFeedback(els, t('err_profiles_backup', { err: error?.message || t('notice_error') }), 'error');
      return false;
    }
  }

  async function requestNewProfileName(message) {
    const Dialogs = getDialogs();
    const Profiles = getProfiles();
    const name = String((Dialogs?.prompt ? await Dialogs.prompt(message) : '') || '').trim();
    if (!name) return null;
    if (Profiles?.findByName?.(name)) {
      showProfileFeedback(null, t('err_profile_name_exists', { name }) || `Ya existe un perfil llamado "${name}".`, 'error');
      return null;
    }
    return name;
  }

  async function saveProfileRecord(elements, name, settings, description = '', options = {}) {
    const Profiles = getProfiles();
    const els = elements || cachedElements || {};
    const opts = options || cachedOptions || {};
    if (!Profiles?.saveEditable) return null;
    const saved = await Profiles.saveEditable({
      id: `profile:${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name,
      description,
      settings: { ...settings, apiKey: '' }
    });
    populateProfileSelector(els, saved.id);
    applyProfileToForm(els, saved.settings, saved.id, opts);
    setSelectedProfileAsDefault(saved, opts);
    setProfileQueryState(els, false);
    return saved;
  }

  async function handleNewProfile(elements, options = {}) {
    const els = elements || cachedElements || {};
    const opts = options || cachedOptions || {};
    const Profiles = getProfiles();
    const name = await requestNewProfileName(t('prompt_new_profile_name') || 'Nombre del nuevo perfil:');
    if (!name) return;
    const defaultSettings = Profiles?.NEW_PROFILE_SETTINGS || { apiType: 'openai', apiUrl: 'http://localhost:1234/v1', model: '' };
    const saved = await saveProfileRecord(els, name, defaultSettings, '', opts);
    if (saved) showProfileFeedback(els, t('msg_profile_created', { name }) || `Perfil "${name}" creado.`, 'success');
  }

  async function handleExportProfiles(elements) {
    const els = elements || cachedElements || {};
    const ProfileBackup = getProfileBackup();
    const ProfileExportBundle = getProfileExportBundle();
    const Export = getExport();
    const Profiles = getProfiles();
    try {
      if (!ProfileBackup?.encryptProfiles || !ProfileExportBundle?.generateExportHTML || !Export?.downloadFile || !Profiles?.list) {
        throw new Error('La exportación de perfiles no está disponible.');
      }
      const profiles = Profiles.list().filter(profile => profile.id !== Profiles.READONLY_PROFILE_ID);

      if (profiles.length === 0) {
        showProfileFeedback(els, t('err_no_profiles_to_export') || 'No hay perfiles para exportar.', 'error');
        return;
      }

      const keyMaterial = await resolveCurrentKeyForRecipher(Profiles, ProfileBackup);
      if (keyMaterial === undefined) return;
      if (keyMaterial) ProfileBackup.cacheKeyMaterial(keyMaterial);
      const encrypted = await ProfileBackup.encryptProfiles(profiles, keyMaterial);
      const date = new Date().toISOString().slice(0, 10);

      // Generar HTML bundle con postMessage
      const htmlBundle = ProfileExportBundle.generateExportHTML(encrypted, {
        profileCount: profiles.length,
        exportDate: date
      });

      // Descargar como HTML
      if (!Export.downloadFile(htmlBundle, `zerochat_profiles_${date}.html`, 'text/html')) {
        throw new Error('No se pudo descargar el archivo.');
      }

      showProfileFeedback(els, t('msg_profiles_exported_html') || 'Perfiles exportados. Abre el archivo HTML descargado para importarlos.', 'success');
    } catch (error) {
      showProfileFeedback(els, t('err_profiles_backup', { err: error?.message || t('notice_error') }), 'error');
    }
  }

  async function requestEncryptionPassword(message) {
    return await getDialogs()?.prompt(message, '', {
      inputType: 'password',
      title: t('crypto_password_title'),
      acceptText: t('notice_accept'),
      cancelText: t('notice_cancel')
    });
  }

  async function resolveCurrentKeyForRecipher(Profiles, Backup) {
    const cached = Backup.getCachedKeyMaterial?.() || null;
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
    const Profiles = getProfiles();
    const Backup = getProfileBackup();
    const Dialogs = getDialogs();
    if (!Profiles?.recipherApiKeys || !Profiles?.verifyApiKeyMaterial || !Backup?.keyMaterialFromPassword || !Dialogs) return;
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
      const current = await resolveCurrentKeyForRecipher(Profiles, Backup);
      if (current === undefined) return;
      const next = await Backup.keyMaterialFromPassword(nextPassword);
      await Profiles.recipherApiKeys(current, next);
      Backup.cacheKeyMaterial(next);
      await Dialogs.alert(t('crypto_password_saved'), { type: 'success' });
    } catch (error) {
      await Dialogs.alert(t('crypto_password_error', { err: error?.message || t('notice_error') }), { type: 'error' });
    }
  }

  async function handleUseDefaultEncryptionKey() {
    const Profiles = getProfiles();
    const Backup = getProfileBackup();
    const Dialogs = getDialogs();
    if (!Profiles?.recipherApiKeys || !Profiles?.verifyApiKeyMaterial || !Backup || !Dialogs) return;
    if (!await Dialogs.confirm(t('crypto_default_confirm'), { type: 'warning' })) return;
    try {
      const current = await resolveCurrentKeyForRecipher(Profiles, Backup);
      if (current === undefined) return;
      const reciphered = await Profiles.recipherApiKeys(current, null);
      Backup.clearCachedKeyMaterial?.();
      await Dialogs.alert(t(reciphered ? 'crypto_default_saved' : 'crypto_default_no_api_keys'), { type: 'success' });
    } catch (error) {
      await Dialogs.alert(t('crypto_password_error', { err: error?.message || t('notice_error') }), { type: 'error' });
    }
  }

  function resetProfileFormToSelected(elements, options = {}) {
    const els = elements || cachedElements || {};
    const opts = options || cachedOptions || {};
    const Profiles = getProfiles();
    const Config = getConfig();
    const runtimeConfig = opts.getRuntimeConfig ? opts.getRuntimeConfig() : (Config?.getActive?.() || {});
    const selectedId = els.profileSelectHelper?.value || runtimeConfig.activeProfile?.id || '';
    const profile = Profiles?.get ? Profiles.get(selectedId) : null;
    applyProfileToForm(els, profile?.settings || runtimeConfig, selectedId, opts);
    if (els.serverQueryStatus) els.serverQueryStatus.style.display = 'none';
    if (els.profileActionFeedback) els.profileActionFeedback.style.display = 'none';
    setProfileQueryState(els, false);
  }

  function openNewProfileModal(elements, options = {}) {
    const els = elements || cachedElements || {};
    const opts = options || cachedOptions || {};
    closeProfileMenu(els);
    if (typeof opts.closeSettingsModal === 'function') opts.closeSettingsModal();

    const Profiles = getProfiles();
    const defaultSettings = Profiles?.NEW_PROFILE_SETTINGS || { apiType: 'openai', apiUrl: 'http://localhost:1234/v1', model: '' };

    if (els.profilesDialog) {
      els.profilesDialog.dataset.profileId = '';
      els.profilesDialog.dataset.profileLocked = 'false';
      els.profilesDialog.dataset.isNew = 'true';
    }
    if (els.profileSelectHelper) {
      els.profileSelectHelper.value = '';
    }

    applyProfileToForm(els, defaultSettings, '', opts);
    if (els.settingProfileName) els.settingProfileName.value = '';
    if (els.settingProfileDescription) els.settingProfileDescription.value = '';
    if (els.settingApiKey) {
      els.settingApiKey.value = '';
      els.settingApiKey._loadedApiKey = '';
    }
    if (els.settingApiKeyLocked) els.settingApiKeyLocked.checked = false;

    if (els.serverQueryStatus) els.serverQueryStatus.style.display = 'none';
    if (els.profileActionFeedback) els.profileActionFeedback.style.display = 'none';
    setProfileQueryState(els, false);
    setProfileDirty(els, false);

    const UISettings = getUISettings();
    UISettings?.syncProviderFields?.(els);
    UISettings?.syncApiKeyLock?.(els, false);

    if (typeof opts.loadCachedModels === 'function') opts.loadCachedModels();
    syncProfileSaveState(els, opts);

    if (els.profilesDialog && !els.profilesDialog.open) {
      if (typeof els.profilesDialog.showModal === 'function') {
        els.profilesDialog.showModal();
      } else {
        els.profilesDialog.style.display = 'block';
      }
    }
    els.settingProfileName?.focus?.();
  }

  function openProfilesModal(elements, options = {}, targetProfileId = null) {
    const els = elements || cachedElements || {};
    const opts = options || cachedOptions || {};
    closeProfileMenu(els);
    if (typeof opts.closeSettingsModal === 'function') opts.closeSettingsModal();

    if (targetProfileId === '__new__') {
      openNewProfileModal(els, opts);
      return;
    }

    const Config = getConfig();
    const Profiles = getProfiles();
    const runtimeConfig = opts.getRuntimeConfig ? opts.getRuntimeConfig() : (Config?.getActive?.() || {});
    const activeId = targetProfileId || runtimeConfig.activeProfile?.id || '';
    if (els.profilesDialog) {
      els.profilesDialog.dataset.profileId = activeId;
      delete els.profilesDialog.dataset.isNew;
    }
    populateProfileSelector(els, activeId);
    const activeProfile = Profiles?.get ? Profiles.get(activeId) : null;
    applyProfileToForm(els, activeProfile?.settings || runtimeConfig, activeId, opts);
    if (els.serverQueryStatus) els.serverQueryStatus.style.display = 'none';
    if (els.profileActionFeedback) els.profileActionFeedback.style.display = 'none';
    setProfileQueryState(els, false);
    setProfileDirty(els, false);
    if (typeof opts.loadCachedModels === 'function') opts.loadCachedModels();
    syncProfileSaveState(els, opts);
    if (els.profilesDialog && !els.profilesDialog.open) {
      if (typeof els.profilesDialog.showModal === 'function') {
        els.profilesDialog.showModal();
      } else {
        els.profilesDialog.style.display = 'block';
      }
    }
  }

  let isClosingProfilesModal = false;

  async function closeProfilesModal(elements, force = false, options = {}) {
    const els = elements || cachedElements || {};
    const opts = options || cachedOptions || {};
    if (!els.profilesDialog?.open) return;
    if (isClosingProfilesModal) return false;
    const Dialogs = getDialogs();

    const hasUnsavedQuery = isProfileQueryReady(els);
    const hasUnsavedChanges = force ? false : isProfileFormDirty(els, opts);

    if (!force && (hasUnsavedQuery || hasUnsavedChanges)) {
      isClosingProfilesModal = true;
      try {
        const msgKey = hasUnsavedQuery ? 'confirm_profile_query_not_saved' : 'confirm_profile_unsaved_changes';
        const discard = Dialogs?.confirm ? await Dialogs.confirm(t(msgKey)) : true;
        if (!discard) {
          els.btnSaveProfile?.focus?.();
          return false;
        }
      } finally {
        isClosingProfilesModal = false;
      }
    }
    setProfileQueryState(els, false);
    setProfileDirty(els, false);
    resetProfileFormToSelected(els, opts);
    if (typeof els.profilesDialog.close === 'function') {
      els.profilesDialog.close();
    } else {
      els.profilesDialog.style.display = 'none';
    }
    return true;
  }

  function mount({ elements, getRuntimeConfig, updateUIFromConfig, loadCachedModels, resetTelemetryDisplay, closeSettingsModal, readFileAsText, inspectProfile } = {}) {
    dispose();
    cachedElements = elements || {};
    cachedOptions = { getRuntimeConfig, updateUIFromConfig, loadCachedModels, resetTelemetryDisplay, closeSettingsModal, readFileAsText, inspectProfile };

    const els = cachedElements;

    if (els.profilesDialog) {
      const onCancel = (e) => {
        if (!isProfileQueryReady(els) && !isProfileFormDirty(els)) {
          setProfileQueryState(els, false, cachedOptions);
          setProfileDirty(els, false);
          resetProfileFormToSelected(els, cachedOptions);
          return;
        }
        e.preventDefault();
        closeProfilesModal(els, false, cachedOptions);
      };
      els.profilesDialog.addEventListener('cancel', onCancel);
      activeCleanupFns.push(() => els.profilesDialog.removeEventListener('cancel', onCancel));

      const onModify = (e) => {
        if (e && (e.target === els.profileSelectHelper || e.target === els.profilesImportInput)) return;
        setProfileDirty(els, true);
        syncProfileSaveState(els, cachedOptions);
      };
      els.profilesDialog.addEventListener('input', onModify);
      els.profilesDialog.addEventListener('change', onModify);
      activeCleanupFns.push(() => els.profilesDialog.removeEventListener('input', onModify));
      activeCleanupFns.push(() => els.profilesDialog.removeEventListener('change', onModify));
    }

    if (els.profileSelectHelper) {
      const onChange = () => {
        const selectedId = els.profileSelectHelper.value;
        const Profiles = getProfiles();
        const profile = Profiles?.get ? Profiles.get(selectedId) : null;
        if (profile) {
          applyProfileToForm(els, profile.settings, profile.id, cachedOptions);
          if (els.settingProfileName) els.settingProfileName.value = profile.name;
          if (els.settingProfileDescription) els.settingProfileDescription.value = profile.description || '';
          setSelectedProfileAsDefault(profile, cachedOptions);
        }
        setProfileQueryState(els, false, cachedOptions);
        setProfileDirty(els, false);
        if (typeof cachedOptions?.loadCachedModels === 'function') {
          cachedOptions.loadCachedModels();
        }
        syncProfileSaveState(els, cachedOptions);
      };
      els.profileSelectHelper.addEventListener('change', onChange);
      activeCleanupFns.push(() => els.profileSelectHelper.removeEventListener('change', onChange));
    }

    if (els.settingProfileName) {
      const onChange = () => {
        const typedName = els.settingProfileName.value.trim();
        if (typedName) {
          const Profiles = getProfiles();
          const profile = Profiles?.findByName ? Profiles.findByName(typedName) : null;
          if (profile) {
            if (els.profileSelectHelper) {
              els.profileSelectHelper.value = profile.id;
            }
            applyProfileToForm(els, profile.settings, profile.id, cachedOptions);
            if (els.settingProfileDescription) {
              els.settingProfileDescription.value = profile.description || '';
            }
            setSelectedProfileAsDefault(profile, cachedOptions);
            setProfileQueryState(els, false, cachedOptions);
            setProfileDirty(els, false);
            if (typeof cachedOptions?.loadCachedModels === 'function') {
              cachedOptions.loadCachedModels();
            }
          }
        }
        syncProfileSaveState(els, cachedOptions);
      };
      const onInput = () => syncProfileSaveState(els, cachedOptions);
      els.settingProfileName.addEventListener('change', onChange);
      els.settingProfileName.addEventListener('input', onInput);
      activeCleanupFns.push(() => {
        els.settingProfileName.removeEventListener('change', onChange);
        els.settingProfileName.removeEventListener('input', onInput);
      });
    }

    if (els.settingApiType) {
      const onChange = () => {
        setProfileQueryState(els, false, cachedOptions);
        const UISettings = getUISettings();
        const Providers = getProviders();
        const val = els.settingApiType.value;
        const currentUrl = els.settingApiUrl ? els.settingApiUrl.value.trim() : '';
        const knownEndpoints = Providers?.registry?.getConnectionEndpoints?.() || [];
        const isDefaultOrEmpty = !currentUrl || knownEndpoints.includes(currentUrl);
        if (isDefaultOrEmpty && els.settingApiUrl) {
          const endpoint = Providers?.registry?.get?.(val)?.getConnectionConfig?.().endpoint;
          if (endpoint) els.settingApiUrl.value = endpoint;
        }
        UISettings?.syncProviderFields?.(els);
        if (typeof cachedOptions?.loadCachedModels === 'function') {
          cachedOptions.loadCachedModels();
        }
        setProfileDirty(els, true);
        syncProfileSaveState(els, cachedOptions);
      };
      els.settingApiType.addEventListener('change', onChange);
      activeCleanupFns.push(() => els.settingApiType.removeEventListener('change', onChange));
    }

    [els.settingApiUrl, els.settingApiKey].forEach(input => {
      if (input) {
        const onInput = () => setProfileQueryState(els, false, cachedOptions);
        input.addEventListener('input', onInput);
        activeCleanupFns.push(() => input.removeEventListener('input', onInput));
      }
    });

    if (els.modelSelectHelper) {
      const onChange = () => {
        if (els.settingModel) {
          els.settingModel.value = els.modelSelectHelper.value;
        }
        setProfileDirty(els, true);
        syncProfileSaveState(els, cachedOptions);
      };
      els.modelSelectHelper.addEventListener('change', onChange);
      activeCleanupFns.push(() => els.modelSelectHelper.removeEventListener('change', onChange));
    }

    if (els.settingModel) {
      const onSyncModel = () => {
        const val = els.settingModel.value.trim();
        if (els.modelSelectHelper) {
          els.modelSelectHelper.value = val;
        }
        setProfileDirty(els, true);
        syncProfileSaveState(els, cachedOptions);
      };
      els.settingModel.addEventListener('input', onSyncModel);
      els.settingModel.addEventListener('change', onSyncModel);
      activeCleanupFns.push(() => {
        els.settingModel.removeEventListener('input', onSyncModel);
        els.settingModel.removeEventListener('change', onSyncModel);
      });
    }

    if (els.btnSaveProfile) {
      const onClick = (e) => {
        if (e && e.preventDefault) e.preventDefault();
        handleSaveProfile(els, cachedOptions)
          .then(saved => {
            if (saved) closeProfilesModal(els, true, cachedOptions);
          })
          .catch(error => {
            const UISettings = getUISettings();
            if (UISettings && typeof UISettings.showProfileFeedback === 'function') {
              UISettings.showProfileFeedback(els, error?.message || String(error), 'error');
            }
          });
      };
      els.btnSaveProfile.addEventListener('click', onClick);
      activeCleanupFns.push(() => els.btnSaveProfile.removeEventListener('click', onClick));
    }

    if (els.btnManageProfiles) {
      const onClick = () => openProfilesModal(els, cachedOptions);
      els.btnManageProfiles.addEventListener('click', onClick);
      activeCleanupFns.push(() => els.btnManageProfiles.removeEventListener('click', onClick));
    }

    if (els.btnHeaderManageProfiles) {
      const onClick = () => openProfilesModal(els, cachedOptions);
      els.btnHeaderManageProfiles.addEventListener('click', onClick);
      activeCleanupFns.push(() => els.btnHeaderManageProfiles.removeEventListener('click', onClick));
    }

    if (els.profilesImportInput) {
      const onChange = (e) => handleImportProfiles(e, els, cachedOptions);
      els.profilesImportInput.addEventListener('change', onChange);
      activeCleanupFns.push(() => els.profilesImportInput.removeEventListener('change', onChange));
    }
    if (els.btnImportProfiles && els.profilesImportInput) {
      const onClick = () => els.profilesImportInput.click();
      els.btnImportProfiles.addEventListener('click', onClick);
      activeCleanupFns.push(() => els.btnImportProfiles.removeEventListener('click', onClick));
    }

    if (els.btnDeleteProfile) {
      const onClick = (e) => {
        if (e && e.preventDefault) e.preventDefault();
        handleDeleteProfile(els, cachedOptions);
      };
      els.btnDeleteProfile.addEventListener('click', onClick);
      activeCleanupFns.push(() => els.btnDeleteProfile.removeEventListener('click', onClick));
    }

    if (els.btnNewProfile) {
      const onClick = () => handleNewProfile(els, cachedOptions);
      els.btnNewProfile.addEventListener('click', onClick);
      activeCleanupFns.push(() => els.btnNewProfile.removeEventListener('click', onClick));
    }

    if (els.btnExportProfiles) {
      const onClick = () => handleExportProfiles(els);
      els.btnExportProfiles.addEventListener('click', onClick);
      activeCleanupFns.push(() => els.btnExportProfiles.removeEventListener('click', onClick));
    }

    if (els.btnCloseProfiles) {
      const onClick = () => closeProfilesModal(els, false, cachedOptions);
      els.btnCloseProfiles.addEventListener('click', onClick);
      activeCleanupFns.push(() => els.btnCloseProfiles.removeEventListener('click', onClick));
    }

    if (els.btnCancelProfiles) {
      const onClick = () => closeProfilesModal(els, false, cachedOptions);
      els.btnCancelProfiles.addEventListener('click', onClick);
      activeCleanupFns.push(() => els.btnCancelProfiles.removeEventListener('click', onClick));
    }

    if (els.activeProfileTrigger) {
      const onClick = (e) => {
        e.stopPropagation();
        const isOpen = els.activeProfilePopover && !els.activeProfilePopover.hidden;
        if (isOpen) closeProfileMenu(els);
        else openProfileMenu(els, cachedOptions);
      };
      els.activeProfileTrigger.addEventListener('click', onClick);
      activeCleanupFns.push(() => els.activeProfileTrigger.removeEventListener('click', onClick));
    }

    if (els.btnEditProfiles) {
      const onClick = () => {
        closeProfileMenu(els);
        openProfilesModal(els, cachedOptions);
      };
      els.btnEditProfiles.addEventListener('click', onClick);
      activeCleanupFns.push(() => els.btnEditProfiles.removeEventListener('click', onClick));
    }

    if (els.btnMenuNewProfile) {
      const onClick = () => handleMenuNewProfile(els, cachedOptions);
      els.btnMenuNewProfile.addEventListener('click', onClick);
      activeCleanupFns.push(() => els.btnMenuNewProfile.removeEventListener('click', onClick));
    }

    if (els.btnMenuExportProfiles) {
      const onClick = () => handleExportProfiles(els);
      els.btnMenuExportProfiles.addEventListener('click', onClick);
      activeCleanupFns.push(() => els.btnMenuExportProfiles.removeEventListener('click', onClick));
    }

    if (els.btnMenuImportProfiles && els.profilesImportInput) {
      const onClick = () => els.profilesImportInput.click();
      els.btnMenuImportProfiles.addEventListener('click', onClick);
      activeCleanupFns.push(() => els.btnMenuImportProfiles.removeEventListener('click', onClick));
    }

    if (els.btnMenuCloseProfiles) {
      const onClick = () => {
        closeProfileMenu(els);
        els.activeProfileTrigger?.focus();
      };
      els.btnMenuCloseProfiles.addEventListener('click', onClick);
      activeCleanupFns.push(() => els.btnMenuCloseProfiles.removeEventListener('click', onClick));
    }

    if (els.activeProfileList) {
      const onClick = async (event) => {
        const actionBtn = event.target.closest('[data-profile-action]');
        if (actionBtn && els.activeProfileList.contains(actionBtn)) {
          event.stopPropagation();
          const action = actionBtn.dataset.profileAction;
          const targetId = actionBtn.dataset.targetId;
          if (action === 'edit') {
            closeProfileMenu(els);
            openProfilesModal(els, cachedOptions, targetId);
          } else if (action === 'inspect') {
            await handleInspectProfile(targetId, els, cachedOptions);
          } else if (action === 'delete') {
            const deleted = await handleDeleteProfileById(targetId, els, cachedOptions);
            if (deleted && typeof cachedOptions?.updateUIFromConfig === 'function') {
              cachedOptions.updateUIFromConfig();
            }
          }
          return;
        }

        const option = event.target.closest('[data-profile-id]');
        if (!option || !els.activeProfileList.contains(option)) return;
        const Profiles = getProfiles();
        if (!Profiles?.get || !Profiles.get(option.dataset.profileId)) return;
        activateConnectionProfile(option.dataset.profileId, cachedOptions);
        if (typeof cachedOptions?.updateUIFromConfig === 'function') {
          cachedOptions.updateUIFromConfig();
        }
        closeProfileMenu(els);
        els.activeProfileTrigger?.focus();
      };
      els.activeProfileList.addEventListener('click', onClick);
      activeCleanupFns.push(() => els.activeProfileList.removeEventListener('click', onClick));
    }

    if (els.activeProfileMenu) {
      const onKeydown = (event) => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        if (els.activeProfilePopover && els.activeProfilePopover.hidden) {
          openProfileMenu(els, cachedOptions);
        }
        const buttons = [...(els.activeProfileList ? els.activeProfileList.querySelectorAll('button') : []), els.btnEditProfiles].filter(Boolean);
        const index = buttons.indexOf(document.activeElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
          : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      };
      const onFocusout = (event) => {
        if (!els.activeProfileMenu.contains(event.relatedTarget)) closeProfileMenu(els);
      };
      els.activeProfileMenu.addEventListener('keydown', onKeydown);
      els.activeProfileMenu.addEventListener('focusout', onFocusout);
      activeCleanupFns.push(() => {
        els.activeProfileMenu.removeEventListener('keydown', onKeydown);
        els.activeProfileMenu.removeEventListener('focusout', onFocusout);
      });
    }

    if (typeof document !== 'undefined') {
      const onDocClick = (event) => {
        if (els.activeProfileMenu && !els.activeProfileMenu.contains(event.target)) {
          closeProfileMenu(els);
        }
      };
      const onDocKeydown = (event) => {
        if (event.key !== 'Escape' || els.activeProfileTrigger?.getAttribute('aria-expanded') !== 'true') return;
        closeProfileMenu(els);
        els.activeProfileTrigger?.focus();
      };
      document.addEventListener('click', onDocClick);
      document.addEventListener('keydown', onDocKeydown);
      activeCleanupFns.push(() => {
        document.removeEventListener('click', onDocClick);
        document.removeEventListener('keydown', onDocKeydown);
      });
    }

    return {
      populateProfileSelector: (name) => populateProfileSelector(els, name),
      applyProfileToForm: (data, id) => applyProfileToForm(els, data, id, cachedOptions),
      syncProfileSaveState: () => syncProfileSaveState(els, cachedOptions),
      isProfileFormDirty: () => isProfileFormDirty(els),
      setProfileDirty: (dirty) => setProfileDirty(els, dirty),
      openProfilesModal: (targetId) => openProfilesModal(els, cachedOptions, targetId),
      openNewProfileModal: () => openNewProfileModal(els, cachedOptions),
      closeProfilesModal: (force) => closeProfilesModal(els, force, cachedOptions),
      handleSaveProfile: () => handleSaveProfile(els, cachedOptions),
      handleDeleteProfile: () => handleDeleteProfile(els, cachedOptions),
      handleDeleteProfileById: (id) => handleDeleteProfileById(id, els, cachedOptions),
      handleNewProfile: () => handleNewProfile(els, cachedOptions),
      handleMenuNewProfile: () => handleMenuNewProfile(els, cachedOptions)
    };
  }

  function dispose() {
    activeCleanupFns.forEach(fn => { try { fn(); } catch (_) {} });
    activeCleanupFns = [];
    cachedElements = null;
    cachedOptions = {};
  }

  return {
    populateProfileSelector,
    applyProfileToForm,
    syncProfileSaveState,
    canSaveProfile,
    isProfileFormDirty,
    setProfileDirty,
    isProfileQueryReady,
    setProfileQueryState,
    openProfilesModal,
    openNewProfileModal,
    closeProfilesModal,
    resetProfileFormToSelected,
    handleSaveProfile,
    handleDeleteProfile,
    handleDeleteProfileById,
    handleNewProfile,
    handleMenuNewProfile,
    handleInspectProfile,
    handleExportProfiles,
    handleEncryptionPassword,
    handleUseDefaultEncryptionKey,
    openProfileMenu,
    closeProfileMenu,
    setProfileMenuOpen,
    activateConnectionProfile,
    setSelectedProfileAsDefault,
    isDownloadedWebLLMModel,
    mount,
    dispose
  };
}));
