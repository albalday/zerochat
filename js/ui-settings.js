/**
 * Módulo de Interfaz de Usuario para Configuración, Perfiles y Herramientas.
 * ZeroChat - js/ui-settings.js
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.ChatUISettings = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function resolveDep(globalName, relPath) {
    if (typeof window !== 'undefined' && window[globalName]) return window[globalName];
    if (typeof globalThis !== 'undefined' && globalThis[globalName]) return globalThis[globalName];
    if (typeof require !== 'undefined') { try { return require(relPath); } catch (e) { return null; } }
    return null;
  }

  const getI18n = () => resolveDep('ChatI18n', './i18n.js');
  const getStorage = () => resolveDep('ChatStorage', './cookies.js') || (typeof globalThis !== 'undefined' ? globalThis.Storage : null);
  const getAgentCore = () => resolveDep('ChatAgentCore', './agent-core.js');
  const getMarkdown = () => resolveDep('ChatMarkdown', './markdown.js');

  function t(key, params) {
    const I18n = getI18n();
    if (I18n && typeof I18n.t === 'function') return I18n.t(key, params);
    return key;
  }

  function escapeHtml(str) {
    const Markdown = getMarkdown();
    if (Markdown && typeof Markdown.escapeHtml === 'function') {
      return Markdown.escapeHtml(str);
    }
    return String(str || '').replace(/[&<>"']/g, (m) => {
      switch (m) {
        case '&': return '&amp;';
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '"': return '&quot;';
        case "'": return '&#39;';
        default: return m;
      }
    });
  }

  function applyTheme(elements, appConfig, theme) {
    const doc = (typeof document !== 'undefined') ? document : null;
    const root = doc ? doc.documentElement : null;
    const effective = (theme === 'dark') ? 'dark' : 'light';
    if (root) {
      if (effective === 'dark') {
        root.setAttribute('data-theme', 'dark');
      } else {
        root.removeAttribute('data-theme');
      }
    }

    if (elements?.themeButtons && elements.themeButtons.length > 0) {
      elements.themeButtons.forEach(btn => {
        if (btn.getAttribute('data-theme') === effective) {
          btn.classList.add('active');
        } else {
          btn.classList.remove('active');
        }
      });
    }
    return effective;
  }

  function applyLanguage(elements, appConfig, lang, callbacks = {}) {
    const target = (lang === 'en') ? 'en' : 'es';
    const I18n = getI18n();
    if (I18n?.setLanguage) {
      I18n.setLanguage(target, true);
    }
    if (elements?.currentLangLabel) {
      elements.currentLangLabel.textContent = target.toUpperCase();
    }

    if (elements?.langButtons && elements.langButtons.length > 0) {
      elements.langButtons.forEach(btn => {
        if (btn.getAttribute('data-lang') === target) {
          btn.classList.add('active');
        } else {
          btn.classList.remove('active');
        }
      });
    }

    if (elements?.currentProfileName) {
      const activeProf = appConfig?.activeProfile?.name || appConfig?.activeProfileName || 'Local chat';
      elements.currentProfileName.textContent = activeProf;
    }
    if (elements?.currentModelName) {
      elements.currentModelName.textContent = appConfig?.model ? appConfig.model : t('no_model');
    }

    if (typeof callbacks.updateReasoningUI === 'function' && appConfig) {
      callbacks.updateReasoningUI(appConfig.reasoningEffort);
    }

    if (elements?.settingSystemPrompt) {
      elements.settingSystemPrompt.setAttribute('placeholder', t('field_system_prompt_placeholder'));
    }
    if (elements?.settingSystemDataPrompt) {
      elements.settingSystemDataPrompt.setAttribute('placeholder', t('field_system_data_prompt_placeholder'));
    }
    return target;
  }

  function renderAgentToolsUI(container, currentEnabledTools = {}) {
    if (!container) return;
    const AgentCore = getAgentCore();
    const tools = (AgentCore?.registry && typeof AgentCore.registry.listToolsForUI === 'function')
      ? AgentCore.registry.listToolsForUI()
      : [];

    container.innerHTML = '';
    const doc = container.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (!doc) return;

    tools.forEach(tool => {
      const isChecked = currentEnabledTools[tool.id] !== undefined
        ? currentEnabledTools[tool.id] !== false
        : (currentEnabledTools[tool.name] !== undefined ? currentEnabledTools[tool.name] !== false : tool.defaultEnabled !== false);

      const title = t(tool.titleKey) || tool.titleFallback || tool.name;
      const desc = t(tool.descKey) || tool.descFallback || '';

      const card = doc.createElement('div');
      card.className = 'setting-toggle-card';
      card.innerHTML = `
        <div class="toggle-card-info">
          <div class="toggle-card-title">
            <span data-i18n="${escapeHtml(tool.titleKey)}">${escapeHtml(title)}</span>
          </div>
          <p class="toggle-card-desc" data-i18n="${escapeHtml(tool.descKey)}">${escapeHtml(desc)}</p>
        </div>
        <label class="switch">
          <input type="checkbox" class="agent-tool-checkbox" data-tool-id="${escapeHtml(tool.id)}" ${isChecked ? 'checked' : ''}>
          <span class="slider"></span>
        </label>
      `;
      container.appendChild(card);
    });
  }

  function gatherEnabledToolsFromUI(container) {
    const map = {};
    if (!container) return map;
    container.querySelectorAll('.agent-tool-checkbox').forEach(cb => {
      const tid = cb.getAttribute('data-tool-id');
      if (tid) map[tid] = cb.checked;
    });
    return map;
  }

  function applyProfileToForm(elements, profileData) {
    if (!elements || !profileData) return;

    if (elements.settingApiType && profileData.apiType !== undefined) {
      elements.settingApiType.value = profileData.apiType;
    }
    if (elements.settingApiUrl && profileData.apiUrl !== undefined) {
      elements.settingApiUrl.value = profileData.apiUrl;
    }
    if (elements.settingApiKey && profileData.apiKey !== undefined) {
      elements.settingApiKey.value = profileData.apiKey;
    }
    if (elements.settingModel && profileData.model !== undefined) {
      elements.settingModel.value = profileData.model;
    }
    if (elements.modelSelectHelper && profileData.model !== undefined) {
      elements.modelSelectHelper.value = profileData.model;
    }
    if (elements.settingSystemPrompt && profileData.systemPrompt !== undefined) {
      elements.settingSystemPrompt.value = profileData.systemPrompt;
    }
    if (elements.settingSystemDataPrompt && profileData.systemDataPrompt !== undefined) {
      elements.settingSystemDataPrompt.value = profileData.systemDataPrompt;
    }
    if (elements.settingTemperature && profileData.temperature !== undefined) {
      elements.settingTemperature.value = profileData.temperature;
      if (elements.temperatureVal) {
        elements.temperatureVal.textContent = profileData.temperature;
      }
    }
    if (elements.settingMaxAgentTurns && profileData.maxAgentTurns !== undefined) {
      elements.settingMaxAgentTurns.value = profileData.maxAgentTurns;
      if (elements.maxAgentTurnsVal) {
        elements.maxAgentTurnsVal.textContent = profileData.maxAgentTurns;
      }
    }
    if (elements.agentToolsContainer) {
      renderAgentToolsUI(elements.agentToolsContainer, profileData.enabledTools || {});
    }
    if (elements.settingEnableRawLogs && profileData.enableRawLogs !== undefined) {
      elements.settingEnableRawLogs.checked = profileData.enableRawLogs === true;
    }
    if (elements.settingSendDateTime && profileData.sendDateTime !== undefined) {
      elements.settingSendDateTime.checked = profileData.sendDateTime !== false;
    }
    if (elements.settingEnableContextCache && profileData.enableContextCache !== undefined) {
      elements.settingEnableContextCache.checked = profileData.enableContextCache !== false;
    }
  }

  function gatherCurrentFormConfig(elements, appConfig) {
    const profileName = (elements?.settingProfileName && elements.settingProfileName.value.trim())
      ? elements.settingProfileName.value.trim()
      : ((elements?.profileSelectHelper && elements.profileSelectHelper.value)
        ? elements.profileSelectHelper.value
        : (appConfig?.activeProfile?.name || 'Local chat'));
    const selectedModel = elements?.settingModel ? elements.settingModel.value.trim() : '';

    return {
      activeProfileName: profileName,
      apiUrl: elements?.settingApiUrl ? elements.settingApiUrl.value.trim() : (appConfig?.apiUrl || 'http://localhost:1234/v1'),
      apiType: elements?.settingApiType ? elements.settingApiType.value : (appConfig?.apiType || 'openai'),
      apiKey: elements?.settingApiKey ? elements.settingApiKey.value.trim() : '',
      model: selectedModel,
      systemPrompt: appConfig?.systemPrompt || '',
      systemDataPrompt: elements?.settingSystemDataPrompt ? elements.settingSystemDataPrompt.value.trim() : (appConfig?.systemDataPrompt || ''),
      temperature: appConfig?.temperature || '0.7',
      reasoningEffort: appConfig?.reasoningEffort || 'none',
      maxAgentTurns: elements?.settingMaxAgentTurns ? Number(elements.settingMaxAgentTurns.value) : (appConfig?.maxAgentTurns || 15),
      modelReasoningConfig: appConfig?.modelReasoningConfig || null,
      theme: appConfig?.theme || 'light',
      language: appConfig?.language || 'es',
      enabledTools: gatherEnabledToolsFromUI(elements?.agentToolsContainer),
      enableRawLogs: elements?.settingEnableRawLogs ? elements.settingEnableRawLogs.checked : Boolean(appConfig?.enableRawLogs),
      enableDebugMessages: Boolean(appConfig?.enableDebugMessages),
      sendDateTime: elements?.settingSendDateTime ? elements.settingSendDateTime.checked : true,
      enableContextCache: elements?.settingEnableContextCache ? elements.settingEnableContextCache.checked : (appConfig?.enableContextCache !== false),
      activeRagBranchId: appConfig?.activeRagBranchId || '',
      activeRagBranchIds: Array.isArray(appConfig?.activeRagBranchIds) ? [...appConfig.activeRagBranchIds] : []
    };
  }

  function showProfileFeedback(elements, msg, type = 'success') {
    if (!elements || !elements.profileActionFeedback) return;
    elements.profileActionFeedback.style.display = 'block';
    elements.profileActionFeedback.className = `server-query-status status-${type}`;
    elements.profileActionFeedback.textContent = msg;
    setTimeout(() => {
      if (elements.profileActionFeedback) {
        elements.profileActionFeedback.style.display = 'none';
      }
    }, 4000);
  }

  function handleSaveProfile(elements, appConfig, saveProfile) {
    const currentConfig = gatherCurrentFormConfig(elements, appConfig);
    const name = currentConfig.activeProfileName || 'Local chat';
    if (typeof saveProfile === 'function') saveProfile(name, currentConfig);
    showProfileFeedback(elements, t('msg_profile_saved', { name }) || `Perfil "${name}" guardado con éxito.`, 'success');
    return currentConfig;
  }

  function handleDeleteProfile(elements, removeProfile) {
    const name = (elements?.settingProfileName && elements.settingProfileName.value.trim())
      ? elements.settingProfileName.value.trim()
      : ((elements?.profileSelectHelper && elements.profileSelectHelper.value)
        ? elements.profileSelectHelper.value
        : '');
    if (!name) return;

    const confirmMsg = t('confirm_delete_profile', { name }) || `¿Estás seguro de que deseas eliminar el perfil "${name}"?`;
    if (!confirm(confirmMsg)) return;

    if (typeof removeProfile === 'function' && removeProfile(name)) {
      showProfileFeedback(elements, t('msg_profile_deleted', { name }) || `Perfil "${name}" eliminado.`, 'success');
    }
  }

  function openSettingsModal(elements, appConfig, callbacks = {}) {
    if (!elements || !elements.settingsDialog) return;
    if (elements.settingsActiveProfileName) {
      elements.settingsActiveProfileName.textContent = appConfig?.activeProfile?.name || t('connection_no_active_profile');
    }
    if (elements.settingSystemDataPrompt) elements.settingSystemDataPrompt.value = appConfig?.systemDataPrompt || '';

    applyTheme(elements, appConfig, appConfig?.theme || 'light');
    applyLanguage(elements, appConfig, appConfig?.language || 'es', callbacks);

    if (elements.agentToolsContainer) {
      renderAgentToolsUI(elements.agentToolsContainer, appConfig?.enabledTools || {});
    }
    if (elements.settingEnableRawLogs) {
      elements.settingEnableRawLogs.checked = appConfig?.enableRawLogs === true;
    }
    if (elements.settingSendDateTime) {
      elements.settingSendDateTime.checked = appConfig?.sendDateTime !== false;
    }

    const settingsTabs = elements.settingsDialog?.querySelectorAll ? elements.settingsDialog.querySelectorAll('.modal-tabs-nav .modal-tab-btn') : elements.modalTabs;
    const settingsPanes = elements.settingsDialog?.querySelectorAll ? elements.settingsDialog.querySelectorAll('.modal-tab-pane') : elements.modalPanes;
    if (settingsTabs && settingsTabs.length > 0) {
      settingsTabs.forEach(b => b.classList.remove('active'));
      if (settingsPanes) settingsPanes.forEach(p => p.classList.remove('active'));
      settingsTabs[0].classList.add('active');
      const doc = elements.settingsDialog?.ownerDocument || document;
      const firstPane = doc.getElementById(settingsTabs[0].getAttribute('data-tab'));
      if (firstPane) firstPane.classList.add('active');
    }

    if (typeof elements.settingsDialog.showModal === 'function') {
      elements.settingsDialog.showModal();
    }
  }

  function closeSettingsModal(elements) {
    if (elements?.settingsDialog && typeof elements.settingsDialog.close === 'function') {
      elements.settingsDialog.close();
    }
  }

  function handleResetSettings(elements, defaults = {}) {
    if (defaults && typeof defaults === 'object') {
      if (elements.settingApiType) elements.settingApiType.value = defaults.apiType || 'openai';
      if (elements.settingApiUrl) elements.settingApiUrl.value = defaults.apiUrl;
      if (elements.settingApiKey) elements.settingApiKey.value = defaults.apiKey;
      if (elements.settingModel) elements.settingModel.value = defaults.model;
      if (elements.settingSystemDataPrompt) elements.settingSystemDataPrompt.value = defaults.systemDataPrompt || '';

      applyTheme(elements, null, defaults.theme || 'light');
      applyLanguage(elements, null, defaults.language || 'es');

      if (elements.modelSelectHelper) elements.modelSelectHelper.value = defaults.model;
      if (elements.agentToolsContainer) renderAgentToolsUI(elements.agentToolsContainer, defaults.enabledTools || {});
      if (elements.settingEnableRawLogs) elements.settingEnableRawLogs.checked = defaults.enableRawLogs === true;
      if (elements.settingSendDateTime) elements.settingSendDateTime.checked = defaults.sendDateTime !== false;
      return defaults;
    }
    return defaults;
  }

  async function handleClearAllData() {
    if (!confirm(t('confirm_clear_all_data'))) return;
    const Storage = getStorage();
    let cleared = true;
    if (Storage?.clearAllStorage) {
      try {
        cleared = await Storage.clearAllStorage();
      } catch (error) {
        console.warn('No se pudieron borrar todos los datos locales:', error);
        cleared = false;
      }
    } else {
      try { localStorage.clear(); } catch (e) {}
      try { sessionStorage.clear(); } catch (e) {}
    }
    if (cleared === false) {
      alert('No se pudo borrar el historial de chats. Revisa la consola para más detalles.');
      return;
    }
    if (typeof window !== 'undefined' && window.location) {
      window.location.reload();
    }
  }

  return {
    applyTheme,
    applyLanguage,
    renderAgentToolsUI,
    gatherEnabledToolsFromUI,
    applyProfileToForm,
    gatherCurrentFormConfig,
    showProfileFeedback,
    handleSaveProfile,
    handleDeleteProfile,
    openSettingsModal,
    closeSettingsModal,
    handleResetSettings,
    handleClearAllData
  };
});
