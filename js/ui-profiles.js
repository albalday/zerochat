/**
 * Módulo de Interfaz de Usuario para Perfiles de Conexión (ZeroChat).
 * Gestiona el modal de edición de perfiles, pestañas, detección de cambios sin guardar (dirty state),
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
  function getConfig() { return resolveDep('ChatConfig', './config-store.js'); }
  function getProviders() { return resolveDep('ChatProviders', './providers.js'); }
  function getExport() { return resolveDep('ChatExport', './export.js'); }
  function getDialogs() { return resolveDep('ChatDialogs', './ui-dialogs.js'); }
  function getUISettings() { return resolveDep('ChatUISettings', './ui-settings.js'); }
  function getStorage() { return resolveDep('ChatStorage', './cookies.js'); }

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
    if (typeof WebLLM?.isModelCompleted === 'function') {
      return WebLLM.isModelCompleted(modelId);
    }
    const Storage = getStorage();
    if (!Storage?.getStorageItem) return false;
    try {
      const key = WebLLM?.COMPLETED_MODELS_STORAGE_KEY || 'webllm_completed_models_v1';
      const raw = Storage.getStorageItem(key);
      const list = JSON.parse(raw || '[]');
      return Array.isArray(list) && list.includes(modelId);
    } catch (_) {
      return false;
    }
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
      const id = profileId || els.profileSelectHelper?.value || currentActiveId;
      const keyInput = els.settingApiKey;
      if (keyInput) {
        keyInput._loadedApiKey = undefined;
        keyInput.value = '';
      }
      UISettings.applyProfileToForm(els, profileData);
      syncProfileSaveState(els, opts);
      try {
        const profile = id ? await Profiles?.load?.(id) : null;
        const currentSelectedId = els.profileSelectHelper?.value || opts.getRuntimeConfig?.()?.activeProfile?.id;
        if (!keyInput || currentSelectedId !== id) return;
        const apiKey = profile?.settings?.apiKey || '';
        keyInput.value = apiKey;
        keyInput._loadedApiKey = apiKey;
        syncProfileSaveState(els, opts);
      } catch (error) {
        const currentSelectedId = els.profileSelectHelper?.value || opts.getRuntimeConfig?.()?.activeProfile?.id;
        if (currentSelectedId !== id) return;
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

  function isProfileFormDirty(elements, options = {}) {
    const els = elements || cachedElements || {};
    const opts = options || cachedOptions || {};
    const Profiles = getProfiles();
    const Config = getConfig();
    const runtimeConfig = opts.getRuntimeConfig ? opts.getRuntimeConfig() : (Config?.getActive?.() || {});
    const selectedId = els.profileSelectHelper?.value || runtimeConfig.activeProfile?.id || '';
    const profile = Profiles?.get ? Profiles.get(selectedId) : null;
    const baseSettings = profile?.settings || runtimeConfig;

    if (els.settingProfileName) {
      const currentName = els.settingProfileName.value.trim();
      const baseName = (profile?.name || '').trim();
      if (currentName !== baseName) return true;
    }

    if (els.settingProfileDescription) {
      const currentDesc = els.settingProfileDescription.value.trim();
      const baseDesc = (profile?.description || '').trim();
      if (currentDesc !== baseDesc) return true;
    }

    if (els.settingApiType) {
      const currentType = els.settingApiType.value;
      const baseType = baseSettings.apiType || 'openai';
      if (currentType !== baseType) return true;
    }

    if (els.settingApiUrl) {
      const currentUrl = els.settingApiUrl.value.trim();
      const baseUrl = (baseSettings.apiUrl || '').trim();
      if (currentUrl !== baseUrl) return true;
    }

    if (els.settingApiKey) {
      const currentKey = els.settingApiKey.value.trim();
      const baseKey = els.settingApiKey._loadedApiKey;
      if (baseKey === undefined) return false;
      if (currentKey !== baseKey) return true;
    }
    if (els.settingApiKeyLocked && els.settingApiKeyLocked.checked !== (baseSettings.apiKeyLocked === true)) return true;

    if (els.settingModel) {
      const currentModel = els.settingModel.value.trim();
      const baseModel = (baseSettings.model || '').trim();
      if (currentModel !== baseModel) return true;
    }

    if (els.settingSystemPrompt) {
      const currentPrompt = els.settingSystemPrompt.value.trim();
      const basePrompt = (baseSettings.systemPrompt || '').trim();
      if (currentPrompt !== basePrompt) return true;
    }

    if (els.settingTemperature) {
      const currentTemp = Number(els.settingTemperature.value);
      const baseTemp = Number(baseSettings.temperature ?? 0.7);
      if (!Number.isNaN(currentTemp) && !Number.isNaN(baseTemp)) {
        if (Math.abs(currentTemp - baseTemp) > 0.001) return true;
      } else if (String(els.settingTemperature.value) !== String(baseSettings.temperature ?? '0.7')) {
        return true;
      }
    }

    if (els.settingWebllmContextWindow) {
      const currentVal = els.settingWebllmContextWindow.value || 'default';
      const rawBase = baseSettings.webllmConfig?.context_window_size;
      const baseVal = (rawBase && rawBase !== 'default') ? String(rawBase) : 'default';
      if (currentVal !== baseVal) return true;
    }

    if (els.settingWebllmPrefillChunk) {
      const currentVal = els.settingWebllmPrefillChunk.value || 'default';
      const rawBase = baseSettings.webllmConfig?.prefill_chunk_size;
      const baseVal = (rawBase && rawBase !== 'default') ? String(rawBase) : 'default';
      if (currentVal !== baseVal) return true;
    }

    return false;
  }

  function canSaveProfile(elements, options = {}) {
    return isProfileFormDirty(elements, options);
  }

  function syncProfileSaveState(elements, options = {}) {
    const els = elements || cachedElements || {};
    const opts = options || cachedOptions || {};
    const Profiles = getProfiles();
    const canSave = canSaveProfile(els, opts);
    const isReadOnly = els.profileSelectHelper?.value === Profiles?.READONLY_PROFILE_ID;
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
        if (!isProfileFormDirty(els, opts)) {
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

  function activateProfileTab(elements, tabBtn) {
    const els = elements || cachedElements || {};
    const targetPane = document.getElementById(tabBtn?.getAttribute?.('data-profile-tab'));
    if (!targetPane) return;
    const isNameTab = targetPane.id === 'profile-tab-name-pane';
    if (els.profileTabs?.forEach) {
      els.profileTabs.forEach(button => {
        const active = button === tabBtn;
        button.classList.toggle('active', active);
        button.setAttribute('aria-selected', String(active));
      });
    }
    if (els.profilePanes?.forEach) {
      els.profilePanes.forEach(pane => pane.classList.toggle('active', pane === targetPane));
    }
    if (els.btnNewProfile) {
      els.btnNewProfile.disabled = !isNameTab;
    }
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
    const selected = Profiles.get?.(els.profileSelectHelper?.value || '') || null;
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

    const existing = selected || sameName;
    const baseSettings = existing?.settings || runtimeConfig;
    const UISettings = getUISettings();
    const formConfig = UISettings?.gatherCurrentFormConfig ? UISettings.gatherCurrentFormConfig(els, runtimeConfig) : runtimeConfig;
    const apiKey = els.settingApiKey?.value.trim() || '';
    const description = els.settingProfileDescription?.value.trim() || '';
    const apiType = els.settingApiType?.value || baseSettings.apiType;
    const apiUrl = els.settingApiUrl?.value.trim() || baseSettings.apiUrl;
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
    if (els.settingApiKey) els.settingApiKey._loadedApiKey = apiKey;
    setSelectedProfileAsDefault(saved, opts);
    setProfileQueryState(els, false);
    showProfileFeedback(els, t('msg_profile_saved', { name }) || `Perfil "${name}" guardado con éxito.`, 'success');
    return true;
  }

  async function handleDeleteProfile(elements, options = {}) {
    const els = elements || cachedElements || {};
    const opts = options || cachedOptions || {};
    const Profiles = getProfiles();
    const Config = getConfig();
    const Dialogs = getDialogs();
    const runtimeConfig = opts.getRuntimeConfig ? opts.getRuntimeConfig() : (Config?.getActive?.() || {});

    const id = els.profileSelectHelper?.value || '';
    const profile = Profiles?.get ? Profiles.get(id) : null;
    if (profile?.id === Profiles?.READONLY_PROFILE_ID) {
      showProfileFeedback(els, t('err_profile_read_only'), 'error');
      return;
    }
    if (!profile) return;
    if (Dialogs?.confirm && !await Dialogs.confirm(t('confirm_delete_profile', { name: profile.name }))) return;

    const currentProfile = Profiles?.get ? Profiles.get(id) : null;
    if (!currentProfile || currentProfile.name !== profile.name) return;
    if (Profiles?.remove?.(currentProfile.id)) {
      if (runtimeConfig.activeProfile?.id === currentProfile.id) {
        Config?.activateFallbackProfile?.();
      }
      const nextActiveId = (opts.getRuntimeConfig ? opts.getRuntimeConfig() : (Config?.getActive?.() || {})).activeProfile?.id || '';
      populateProfileSelector(els, nextActiveId);
      applyProfileToForm(els, opts.getRuntimeConfig ? opts.getRuntimeConfig() : (Config?.getActive?.() || {}));
      setProfileQueryState(els, false);
      showProfileFeedback(els, t('msg_profile_deleted', { name: currentProfile.name }) || `Perfil "${currentProfile.name}" eliminado.`, 'success');
      if (typeof opts.updateUIFromConfig === 'function') opts.updateUIFromConfig();
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
    const saved = await saveProfileRecord(els, name, Profiles?.NEW_PROFILE_SETTINGS || { apiType: 'openai', apiUrl: '', model: '' }, '', opts);
    if (saved) showProfileFeedback(els, t('msg_profile_created', { name }) || `Perfil "${name}" creado.`, 'success');
  }

  async function handleExportProfiles(elements) {
    const els = elements || cachedElements || {};
    const ProfileBackup = getProfileBackup();
    const Export = getExport();
    const Profiles = getProfiles();
    try {
      if (!ProfileBackup?.encryptProfiles || !Export?.downloadFile || !Profiles?.list) {
        throw new Error('La copia de perfiles no está disponible.');
      }
      const profiles = Profiles.list().filter(profile => profile.id !== Profiles.READONLY_PROFILE_ID);
      const encrypted = await ProfileBackup.encryptProfiles(profiles);
      const date = new Date().toISOString().slice(0, 10);
      if (!Export.downloadFile(encrypted, `zerochat_profiles_${date}.zcp`, 'application/json')) {
        throw new Error('No se pudo descargar el archivo.');
      }
      showProfileFeedback(els, t('msg_profiles_exported'), 'success');
    } catch (error) {
      showProfileFeedback(els, t('err_profiles_backup', { err: error?.message || t('notice_error') }), 'error');
    }
  }

  async function handleImportProfiles(event, elements, options = {}) {
    const els = elements || cachedElements || {};
    const opts = options || cachedOptions || {};
    const ProfileBackup = getProfileBackup();
    const Profiles = getProfiles();
    const Dialogs = getDialogs();
    const Config = getConfig();
    const file = event?.target?.files?.[0];

    try {
      if (!file || !ProfileBackup?.decryptProfiles || !Profiles?.mergeImported) return;
      if (Number(file.size) > (ProfileBackup.MAX_FILE_BYTES || 1024 * 1024) * 2) {
        throw new Error('El archivo supera el tamaño permitido.');
      }
      let rawText = '';
      if (typeof opts.readFileAsText === 'function') {
        rawText = await opts.readFileAsText(file);
      } else if (file.text) {
        rawText = await file.text();
      }

      const imported = await ProfileBackup.decryptProfiles(rawText);
      if (Dialogs?.confirm && !await Dialogs.confirm(t('confirm_import_profiles', { count: imported.length }))) return;
      Profiles.mergeImported(imported);
      const runtimeConfig = opts.getRuntimeConfig ? opts.getRuntimeConfig() : (Config?.getActive?.() || {});
      const activeId = runtimeConfig.activeProfile?.id || '';
      if (Profiles.get?.(activeId)) activateConnectionProfile(activeId, opts);
      else Config?.activateFallbackProfile?.();

      const nextActive = (opts.getRuntimeConfig ? opts.getRuntimeConfig() : (Config?.getActive?.() || {})).activeProfile?.id || '';
      populateProfileSelector(els, nextActive);
      applyProfileToForm(els, opts.getRuntimeConfig ? opts.getRuntimeConfig() : (Config?.getActive?.() || {}));
      setProfileQueryState(els, false);
      showProfileFeedback(els, t('msg_profiles_imported'), 'success');
      if (typeof opts.updateUIFromConfig === 'function') opts.updateUIFromConfig();
    } catch (error) {
      showProfileFeedback(els, t('err_profiles_backup', { err: error?.message || t('notice_error') }), 'error');
    } finally {
      if (event?.target) event.target.value = '';
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

  function openProfilesModal(elements, options = {}) {
    const els = elements || cachedElements || {};
    const opts = options || cachedOptions || {};
    closeProfileMenu(els);
    if (typeof opts.closeSettingsModal === 'function') opts.closeSettingsModal();

    const Config = getConfig();
    const Profiles = getProfiles();
    const runtimeConfig = opts.getRuntimeConfig ? opts.getRuntimeConfig() : (Config?.getActive?.() || {});
    const activeId = runtimeConfig.activeProfile?.id || '';
    populateProfileSelector(els, activeId);
    const activeProfile = Profiles?.get ? Profiles.get(activeId) : null;
    applyProfileToForm(els, activeProfile?.settings || runtimeConfig, activeId, opts);
    if (els.serverQueryStatus) els.serverQueryStatus.style.display = 'none';
    if (els.profileActionFeedback) els.profileActionFeedback.style.display = 'none';
    setProfileQueryState(els, false);
    const nameTab = document.getElementById('profile-tab-name') || els.profileTabs?.[0];
    if (nameTab) activateProfileTab(els, nameTab);
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
    resetProfileFormToSelected(els, opts);
    if (typeof els.profilesDialog.close === 'function') {
      els.profilesDialog.close();
    } else {
      els.profilesDialog.style.display = 'none';
    }
    return true;
  }

  function mount({ elements, getRuntimeConfig, updateUIFromConfig, loadCachedModels, resetTelemetryDisplay, closeSettingsModal, readFileAsText } = {}) {
    dispose();
    cachedElements = elements || {};
    cachedOptions = { getRuntimeConfig, updateUIFromConfig, loadCachedModels, resetTelemetryDisplay, closeSettingsModal, readFileAsText };

    const els = cachedElements;

    if (els.profilesDialog) {
      const onCancel = (e) => {
        e.preventDefault();
        closeProfilesModal(els, false, cachedOptions);
      };
      els.profilesDialog.addEventListener('cancel', onCancel);
      activeCleanupFns.push(() => els.profilesDialog.removeEventListener('cancel', onCancel));
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
        }
        setProfileQueryState(els, false);
      };
      els.profileSelectHelper.addEventListener('change', onChange);
      activeCleanupFns.push(() => els.profileSelectHelper.removeEventListener('change', onChange));
    }

    if (els.settingProfileName) {
      const onChange = () => syncProfileSaveState(els, cachedOptions);
      els.settingProfileName.addEventListener('change', onChange);
      activeCleanupFns.push(() => els.settingProfileName.removeEventListener('change', onChange));
    }

    if (els.settingApiType) {
      const onChange = () => {
        setProfileQueryState(els, false);
        syncProfileSaveState(els, cachedOptions);
      };
      els.settingApiType.addEventListener('change', onChange);
      activeCleanupFns.push(() => els.settingApiType.removeEventListener('change', onChange));
    }

    if (els.modelSelectHelper) {
      const onChange = () => {
        if (els.settingModel) {
          els.settingModel.value = els.modelSelectHelper.value;
          syncProfileSaveState(els, cachedOptions);
        }
      };
      els.modelSelectHelper.addEventListener('change', onChange);
      activeCleanupFns.push(() => els.modelSelectHelper.removeEventListener('change', onChange));
    }

    if (els.settingModel) {
      const onInput = () => syncProfileSaveState(els, cachedOptions);
      els.settingModel.addEventListener('input', onInput);
      activeCleanupFns.push(() => els.settingModel.removeEventListener('input', onInput));
    }

    if (els.profileTabs?.forEach) {
      els.profileTabs.forEach(tabBtn => {
        const onClick = (e) => {
          e.preventDefault();
          activateProfileTab(els, tabBtn);
        };
        tabBtn.addEventListener('click', onClick);
        activeCleanupFns.push(() => tabBtn.removeEventListener('click', onClick));
      });
    }

    if (els.btnSaveProfile) {
      const onClick = () => handleSaveProfile(els, cachedOptions);
      els.btnSaveProfile.addEventListener('click', onClick);
      activeCleanupFns.push(() => els.btnSaveProfile.removeEventListener('click', onClick));
    }

    if (els.btnDeleteProfile) {
      const onClick = () => handleDeleteProfile(els, cachedOptions);
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

    if (els.btnImportProfiles) {
      const onClick = () => { if (els.profilesImportInput) els.profilesImportInput.click(); };
      els.btnImportProfiles.addEventListener('click', onClick);
      activeCleanupFns.push(() => els.btnImportProfiles.removeEventListener('click', onClick));
    }

    if (els.profilesImportInput) {
      const onChange = (e) => handleImportProfiles(e, els, cachedOptions);
      els.profilesImportInput.addEventListener('change', onChange);
      activeCleanupFns.push(() => els.profilesImportInput.removeEventListener('change', onChange));
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

    return {
      populateProfileSelector: (name) => populateProfileSelector(els, name),
      applyProfileToForm: (data, id) => applyProfileToForm(els, data, id, cachedOptions),
      syncProfileSaveState: () => syncProfileSaveState(els, cachedOptions),
      isProfileFormDirty: () => isProfileFormDirty(els, cachedOptions),
      openProfilesModal: () => openProfilesModal(els, cachedOptions),
      closeProfilesModal: (force) => closeProfilesModal(els, force, cachedOptions),
      handleSaveProfile: () => handleSaveProfile(els, cachedOptions),
      handleDeleteProfile: () => handleDeleteProfile(els, cachedOptions),
      handleNewProfile: () => handleNewProfile(els, cachedOptions)
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
    isProfileQueryReady,
    setProfileQueryState,
    activateProfileTab,
    openProfilesModal,
    closeProfilesModal,
    resetProfileFormToSelected,
    handleSaveProfile,
    handleDeleteProfile,
    handleNewProfile,
    handleExportProfiles,
    handleImportProfiles,
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
