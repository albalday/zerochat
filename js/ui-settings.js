/**
 * Módulo de Interfaz de Usuario para Configuración, Perfiles y Herramientas.
 * ZeroChat - js/ui-settings.js
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./defaults.js'));
  } else {
    root.ChatUISettings = factory(root.ChatDefaults);
  }
})(typeof self !== 'undefined' ? self : this, function (Defaults) {
  'use strict';

  const DEFAULT_THEME = Defaults.DEFAULT_THEME;

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
  const getProviders = () => resolveDep('ChatProviders', './providers.js');
  const getDataResetService = () => resolveDep('ChatDataResetService', './data-reset-service.js');
  const getDialogs = () => resolveDep('ChatDialogs', './ui-dialogs.js');

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
    if (elements?.langButtons && elements.langButtons.length > 0) {
      elements.langButtons.forEach(btn => {
        if (btn.getAttribute('data-lang') === target) {
          btn.classList.add('active');
        } else {
          btn.classList.remove('active');
        }
      });
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
    const welcomeHelp = elements?.welcomeHelpLink || (typeof document !== 'undefined' ? document.getElementById('welcome-help-link') : null);
    if (welcomeHelp) {
      welcomeHelp.href = (target === 'en')
        ? 'help/en/index.html'
        : 'help/index.html';
    }
    return target;
  }

  function renderAgentToolsUI(container, currentEnabledTools = {}) {
    if (!container) return;
    const AgentCore = getAgentCore();
    const allTools = (AgentCore?.registry && typeof AgentCore.registry.listToolsForUI === 'function')
      ? AgentCore.registry.listToolsForUI()
      : [];
    const tools = allTools.filter(t => t.category !== 'mcp');

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
    if (elements.settingApiUrl) {
      const apiType = elements.settingApiType?.value || profileData.apiType || 'openai';
      const defaultEndpoint = getProviders()?.registry?.get?.(apiType)?.getConnectionConfig?.().endpoint || 'http://localhost:1234/v1';
      elements.settingApiUrl.value = (profileData.apiUrl !== undefined && profileData.apiUrl !== '') ? profileData.apiUrl : defaultEndpoint;
    }
    if (elements.settingApiKeyLocked) elements.settingApiKeyLocked.checked = profileData.apiKeyLocked === true;
    if (elements.profilesDialog) elements.profilesDialog.dataset.profileLocked = String(profileData.apiKeyLocked === true);
    if (elements.apiKeyLockControl) elements.apiKeyLockControl.hidden = profileData.apiKeyLocked === true;
    if (elements.apiKeyLockedStatus) elements.apiKeyLockedStatus.hidden = profileData.apiKeyLocked !== true;
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
    if (elements.settingEnableContextCache && profileData.enableContextCache !== undefined) {
      elements.settingEnableContextCache.checked = profileData.enableContextCache !== false;
    }
    const webllmCfg = profileData.webllmConfig || {};
    const setParamSelect = (el, val) => {
      if (!el) return;
      const cleanVal = (val && val !== 'default') ? String(val) : 'default';
      el.value = cleanVal;
      if (!el.value) el.value = 'default';
    };
    setParamSelect(elements.settingWebllmContextWindow, webllmCfg.context_window_size);
    setParamSelect(elements.settingWebllmPrefillChunk, webllmCfg.prefill_chunk_size);
    if (elements?.webllmParamsPanel) elements.webllmParamsPanel.hidden = true;
    if (elements?.btnWebllmParams?.classList) elements.btnWebllmParams.classList.remove('active');
    syncProviderFields(elements);
    syncApiKeyLock(elements);
  }

  function syncApiKeyLock(elements, readOnly = false) {
    const locked = elements?.profilesDialog?.dataset.profileLocked === 'true';
    elements?.profilesDialog?.querySelectorAll('.modal-body input, .modal-body textarea, .modal-body select, .modal-body button').forEach(control => {
      if (control === elements.profileSelectHelper || control.hasAttribute('data-profile-global-action')) return;
      control.disabled = readOnly || locked || (control === elements.settingApiKey && control.closest('.api-key-field')?.hidden === true);
    });
    if (elements?.settingApiKeyLocked) elements.settingApiKeyLocked.disabled = readOnly || locked;
  }

  function syncProviderFields(elements) {
    const providerId = elements?.settingApiType?.value || 'openai';
    const adapter = getProviders()?.registry?.get?.(providerId);
    const connection = adapter?.getConnectionConfig?.() || {};
    const isWebLLM = providerId === 'webllm';
    if (elements?.settingApiUrl) {
      if (connection.endpoint) {
        elements.settingApiUrl.placeholder = connection.endpoint;
      }
      if (connection.endpointReadOnly && connection.endpoint) {
        elements.settingApiUrl.value = connection.endpoint;
      } else if (!elements.settingApiUrl.value.trim() && connection.endpoint) {
        elements.settingApiUrl.value = connection.endpoint;
      }
      elements.settingApiUrl.readOnly = connection.endpointReadOnly === true;
      elements.settingApiUrl.required = connection.endpointReadOnly !== true;
    }
    if (elements?.settingApiKey) elements.settingApiKey.disabled = connection.credentials === false;
    const apiKeyField = elements?.settingApiKey?.closest?.('.api-key-field');
    if (apiKeyField) apiKeyField.hidden = connection.credentials === false;
    const apiKeyHintText = apiKeyField?.querySelector?.('#api-key-hint-text');
    const apiKeyFreeHelpLink = apiKeyField?.querySelector?.('#api-key-free-help-link');
    const freeTierHelp = {
      openrouter: 'help/openrouter-free.html',
      gemini: 'help/gemini-free.html'
    };
    if (apiKeyHintText) {
      const hintKey = ['openai', 'ollama'].includes(providerId)
        ? 'field_api_key_hint'
        : 'field_api_key_required_hint';
      apiKeyHintText.dataset.i18n = hintKey;
      apiKeyHintText.textContent = t(hintKey);
    }
    if (apiKeyFreeHelpLink) {
      const helpUrl = freeTierHelp[providerId];
      apiKeyFreeHelpLink.hidden = !helpUrl;
      if (helpUrl) apiKeyFreeHelpLink.href = helpUrl;
    }
    const field = typeof elements?.settingApiUrl?.closest === 'function'
      ? elements.settingApiUrl.closest('.form-field') : null;
    const hint = field?.querySelector('.webllm-local-hint') || elements?.webllmLocalHint;
    if (hint) hint.hidden = !isWebLLM;
    const helpLink = field?.querySelector('.webllm-help-link') || elements?.webllmHelpLink || (typeof document !== 'undefined' ? document.getElementById('webllm-help-link') : null);
    if (helpLink) helpLink.hidden = providerId !== 'webllm';

    const btnWebllmParams = elements?.btnWebllmParams || (typeof document !== 'undefined' ? document.getElementById('btn-webllm-params') : null);
    const webllmParamsPanel = elements?.webllmParamsPanel || (typeof document !== 'undefined' ? document.getElementById('webllm-params-panel') : null);
    if (btnWebllmParams) btnWebllmParams.hidden = !isWebLLM;
    if (webllmParamsPanel && !isWebLLM) {
      webllmParamsPanel.hidden = true;
      if (btnWebllmParams) btnWebllmParams.classList.remove('active');
    }
  }

  function gatherCurrentFormConfig(elements, appConfig) {
    const profileName = (elements?.settingProfileName && elements.settingProfileName.value.trim())
      ? elements.settingProfileName.value.trim()
      : ((elements?.profileSelectHelper && elements.profileSelectHelper.value)
        ? elements.profileSelectHelper.value
        : (appConfig?.activeProfile?.name || 'Local chat'));
    const selectedModel = elements?.settingModel ? elements.settingModel.value.trim() : '';
    const getParamVal = (el, fallback) => {
      const v = el?.value ? el.value.trim() : '';
      return v || fallback || 'default';
    };
    const prevWebllmConfig = appConfig?.webllmConfig || {};
    const webllmConfig = {
      context_window_size: getParamVal(elements?.settingWebllmContextWindow, prevWebllmConfig.context_window_size),
      prefill_chunk_size: getParamVal(elements?.settingWebllmPrefillChunk, prevWebllmConfig.prefill_chunk_size)
    };
    return {
      activeProfileName: profileName,
      apiUrl: elements?.settingApiUrl ? elements.settingApiUrl.value.trim() : (appConfig?.apiUrl || 'http://localhost:1234/v1'),
      apiType: elements?.settingApiType ? elements.settingApiType.value : (appConfig?.apiType || 'openai'),
      model: selectedModel,
      webllmConfig,
      // El límite publicado pertenece a la conexión en ejecución, no al formulario.
      modelContextLimit: null,
      contextLimitOverride: appConfig?.contextLimitOverride || null,
      systemPrompt: elements?.settingSystemPrompt ? elements.settingSystemPrompt.value.trim() : (appConfig?.systemPrompt || ''),
      systemDataPrompt: elements?.settingSystemDataPrompt ? elements.settingSystemDataPrompt.value.trim() : (appConfig?.systemDataPrompt || ''),
      temperature: elements?.settingTemperature ? elements.settingTemperature.value : (appConfig?.temperature || '0.7'),
      reasoningEffort: appConfig?.reasoningEffort || 'medium',
      reasoningTransport: appConfig?.reasoningTransport || 'auto',
      maxAgentTurns: elements?.settingMaxAgentTurns ? Number(elements.settingMaxAgentTurns.value) : (appConfig?.maxAgentTurns || 15),
      modelReasoningConfig: appConfig?.modelReasoningConfig || null,
      theme: appConfig?.theme || DEFAULT_THEME,
      language: appConfig?.language || 'es',
      enabledTools: {
        ...gatherEnabledToolsFromUI(elements?.agentToolsContainer),
        ...gatherEnabledToolsFromUI(elements?.mcpToolsContainer)
      },
      enableRawLogs: elements?.settingEnableRawLogs ? elements.settingEnableRawLogs.checked : Boolean(appConfig?.enableRawLogs),
      enableDebugMessages: Boolean(appConfig?.enableDebugMessages),
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
    const timer = setTimeout(() => {
      if (elements.profileActionFeedback) {
        elements.profileActionFeedback.style.display = 'none';
      }
    }, 4000);
    if (typeof timer?.unref === 'function') timer.unref();
  }

  const SECTION_TITLES = {
    'tab-model': 'tab_model',
    'tab-agent': 'tab_agent',
    'tab-mcp': 'tab_mcp',
    'tab-permissions': 'tab_permissions',
    'tab-inspector': 'tab_inspector',
    'model': 'tab_model',
    'agent': 'tab_agent',
    'mcp': 'tab_mcp',
    'permissions': 'tab_permissions',
    'inspector': 'tab_inspector'
  };

  function normalizeSectionId(sectionId) {
    if (!sectionId) return 'tab-model';
    if (SECTION_TITLES[sectionId]) {
      return sectionId.startsWith('tab-') ? sectionId : 'tab-' + sectionId;
    }
    const candidate = sectionId.startsWith('tab-') ? sectionId : 'tab-' + sectionId;
    return SECTION_TITLES[candidate] ? candidate : 'tab-model';
  }

  function openSettingsSection(elements, appConfig, callbacks = {}, sectionId = 'tab-model') {
    ensureDialogMarkup();
    if (!elements || !elements.settingsDialog) return;
    const preservePendingChanges = elements.settingsDialog.open && isSettingsFormDirty(elements);
    if (elements.settingsActiveProfileName) {
      elements.settingsActiveProfileName.textContent = appConfig?.activeProfile?.name || 'Espejo';
    }
    if (!preservePendingChanges && elements.settingSystemDataPrompt) elements.settingSystemDataPrompt.value = appConfig?.systemDataPrompt || '';

    if (!preservePendingChanges) {
      applyTheme(elements, appConfig, appConfig?.theme || DEFAULT_THEME);
      applyLanguage(elements, appConfig, appConfig?.language || 'es', callbacks);

      if (elements.agentToolsContainer) {
        renderAgentToolsUI(elements.agentToolsContainer, appConfig?.enabledTools || {});
      }
      if (elements.settingEnableRawLogs) {
        elements.settingEnableRawLogs.checked = appConfig?.enableRawLogs === true;
      }
      if (elements.settingMaxAgentTurns) {
        elements.settingMaxAgentTurns.value = appConfig?.maxAgentTurns || 15;
      }
      if (elements.maxAgentTurnsVal) {
        elements.maxAgentTurnsVal.textContent = appConfig?.maxAgentTurns || 15;
      }
      if (elements.settingEnableContextCache) {
        elements.settingEnableContextCache.checked = appConfig?.enableContextCache !== false;
      }
      if (elements.mcpHostInput) {
        elements.mcpHostInput.value = appConfig?.mcpHost || '127.0.0.1';
      }
      if (elements.mcpPortInput) {
        elements.mcpPortInput.value = appConfig?.mcpPort || 6388;
      }
    }

    const targetId = normalizeSectionId(sectionId);
    const doc = elements.settingsDialog?.ownerDocument || (typeof document !== 'undefined' ? document : null);

    const settingsSections = elements.settingsDialog?.querySelectorAll
      ? elements.settingsDialog.querySelectorAll('.settings-section-pane')
      : elements.settingsSections;

    if (settingsSections && settingsSections.length > 0) {
      settingsSections.forEach(section => section.classList.remove('active'));
      const targetPane = doc ? doc.getElementById(targetId) : null;
      if (targetPane) {
        targetPane.classList.add('active');
      } else if (settingsSections[0]) {
        settingsSections[0].classList.add('active');
      }
    }

    const titleEl = elements.settingsSectionTitle || (doc ? doc.getElementById('settings-section-title') : null);
    if (titleEl) {
      const titleKey = SECTION_TITLES[targetId] || 'tab_connection';
      titleEl.setAttribute('data-i18n', titleKey);
      titleEl.textContent = t(titleKey);
    }

    const Sidebar = resolveDep('ChatUISidebar', './ui-sidebar.js');
    if (Sidebar && typeof Sidebar.setActiveSettingsSection === 'function') {
      Sidebar.setActiveSettingsSection(elements, targetId);
    }

    if (typeof elements.settingsDialog.showModal === 'function') {
      elements.settingsDialog.showModal();
    }
    if (!preservePendingChanges) setSettingsFormDirty(elements, false);
  }

  function setSettingsFormDirty(elements, dirty) {
    if (elements?.settingsDialog?.dataset) {
      elements.settingsDialog.dataset.settingsDirty = String(Boolean(dirty));
    }
  }

  function isSettingsFormDirty(elements) {
    return elements?.settingsDialog?.dataset?.settingsDirty === 'true';
  }

  async function closeSettingsModal(elements, force = false) {
    if (!force && isSettingsFormDirty(elements)) {
      const Dialogs = getDialogs();
      const discard = Dialogs?.confirm
        ? await Dialogs.confirm(t('confirm_settings_unsaved_changes'))
        : false;
      if (!discard) return false;
    }
    if (elements?.settingsDialog && typeof elements.settingsDialog.close === 'function') {
      elements.settingsDialog.close();
    }
    setSettingsFormDirty(elements, false);
    return true;
  }

  async function handleClearAllData() {
    const ResetService = getDataResetService();
    if (ResetService?.resetAllData) {
      return await ResetService.resetAllData();
    }
  }

  function getSettingsDialogHTML() {
    return `<div class="modal-header settings-section-header">
      <div class="modal-title">
        <h3 id="settings-section-title" data-i18n="tab_model">Modelo</h3>
      </div>
      <div class="settings-header-actions">
        <button type="submit" form="settings-form" id="btn-save-settings" class="btn-primary btn-save-header" data-i18n-title="btn_save" title="Guardar configuración" aria-label="Guardar">
          <svg class="ui-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-save"></use></svg>
          <span data-i18n="btn_save_short">Guardar</span>
        </button>
        <button type="button" id="btn-close-settings" class="btn-close" data-i18n-aria="modal_close_aria" aria-label="Cerrar modal">
          <svg class="ui-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-close"></use></svg>
        </button>
      </div>
    </div>

    <form id="settings-form" class="settings-form-wrapper">
      <div class="modal-body">
        <!-- Sección: Modelo y Prompt -->
        <div id="tab-model" class="settings-section-pane active">
          <div class="form-field">
            <label for="setting-system-data-prompt">
              <strong data-i18n="field_system_data_prompt">Perfil del sistema · datos ZeroChat</strong>
              <span class="label-hint" data-i18n="field_system_data_prompt_hint">Instrucciones internas de ZeroChat. Es mejor no modificarlas; añade lo que veas necesario.</span>
            </label>
            <textarea
              id="setting-system-data-prompt"
              rows="5"
              data-i18n-placeholder="field_system_data_prompt_placeholder"
              placeholder="Instrucciones internas de ZeroChat..."
            ></textarea>
          </div>

          <div class="cookie-notice">
            <svg class="ui-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-help-circle"></use></svg>
            <span><strong data-i18n="model_cache_title">Caché de contexto automática</strong><br><span data-i18n="model_cache_desc">El cliente aplica automáticamente las marcas de caché que admita el proveedor. En servidores locales la caché KV se administra en el servidor.</span></span>
          </div>

          <div class="cookie-notice">
            <svg class="ui-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-help-circle"></use></svg>
            <span data-i18n-html="cookie_notice">Toda la configuración se almacena localmente de forma persistente (compatible tanto con <strong>file://</strong> como con servidores web).</span>
          </div>
        </div>

        <!-- Sección: Modo Agente y Herramientas -->
        <div id="tab-agent" class="settings-section-pane">
          <div class="settings-section-intro">
            <p data-i18n="agent_intro">Configura las herramientas agénticas que se transmiten al modelo.</p>
          </div>

          <div class="form-field" style="margin-bottom: 1.25rem;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.35rem;">
              <label for="setting-max-agent-turns" style="margin-bottom: 0;">
                <strong data-i18n="field_max_agent_turns">Límite de turnos agénticos</strong>
              </label>
              <span id="max-agent-turns-val" style="font-size: 0.85rem; font-weight: 600; color: var(--color-primary, #2563eb);">15</span>
            </div>
            <span class="label-hint" data-i18n="field_max_agent_turns_hint">Número máximo de pasos o llamadas consecutivas a herramientas antes de forzar la síntesis final (entre 5 y 35).</span>
            <div style="display: flex; align-items: center; gap: 0.75rem; margin-top: 0.4rem;">
              <input type="range" id="setting-max-agent-turns" min="5" max="35" step="1" value="15" style="flex: 1;">
            </div>
          </div>

          <!-- Contenedor dinámico de herramientas agénticas registradas -->
          <div id="agent-tools-container" class="agent-tools-container"></div>
        </div>

        <!-- Sección: Servidor Local (MCP) -->
        <div id="tab-mcp" class="settings-section-pane">
          <!-- Estado del servidor local -->
          <div class="mcp-status-card">
            <div class="mcp-status-header">
              <div class="mcp-title-group">
                <span class="mcp-header-icon">
                  <svg class="ui-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-server"></use></svg>
                </span>
                <strong data-i18n="mcp_connection_title">Servidor Local</strong>
                <span id="mcp-server-details" class="mcp-server-details" style="display: none;"></span>
              </div>

              <!-- Indicador de Estado -->
              <div class="mcp-status-actions">
                <span id="mcp-status-badge" class="mcp-status-badge mcp-status-disconnected">
                  <span class="mcp-status-dot"></span>
                  <span id="mcp-status-text">Desconectado</span>
                </span>
              </div>
            </div>
          </div>

          <div id="mcp-bootstrap-card" class="mcp-bootstrap-card">
            <div class="mcp-bootstrap-header">
              <svg class="ui-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-terminal"></use></svg>
              <strong data-i18n="mcp_bootstrap_title">MCP requiere el servidor local</strong>
            </div>
            <p class="label-hint mcp-section-hint" data-i18n="mcp_bootstrap_desc">Instala ZeroChat desde PyPI y ejecútalo en un terminal. La aplicación se conectará automáticamente cuando el servidor esté disponible.</p>
            <p id="mcp-reconnect-hint" class="label-hint mcp-section-hint" data-i18n="mcp_reconnect_after_restart">Si el servidor se ha reiniciado, recarga esta página (F5) para volver a conectar.</p>
            <div class="mcp-cmd-row">
              <pre class="mcp-command-box mcp-cmd-box-flex"><code id="mcp-terminal-command">pip install zerochat &amp;&amp; zerochat</code></pre>
              <button type="button" id="btn-mcp-copy-cmd" class="btn-secondary btn-copy-mcp-cmd" data-i18n-title="mcp_btn_copy_cmd" title="Copiar comando">
                <svg class="ui-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-copy"></use></svg>
                <span data-i18n="mcp_btn_copy_cmd">Copiar comando</span>
              </button>
            </div>
            <p class="label-hint mcp-section-hint" data-i18n="mcp_bootstrap_direct">Alternativa sin instalación: descarga zerochat.py y ejecútalo con Python.</p>
            <a href="help/mcp.html" target="_blank" rel="noopener noreferrer" class="mcp-bootstrap-help" data-i18n="mcp_bootstrap_help">Abrir ayuda de MCP</a>
          </div>

          <!-- Tarjeta de Servidores MCP Disponibles -->
          <div id="mcp-servers-card" class="mcp-status-card" style="margin-top: 1rem;">
            <div class="mcp-status-header">
              <div class="mcp-title-group">
                <span class="mcp-header-icon">
                  <svg class="ui-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-cpu"></use></svg>
                </span>
                <strong data-i18n="mcp_servers_section_title">Servidores MCP Disponibles</strong>
              </div>
            </div>
            <p class="label-hint mcp-section-hint" data-i18n="mcp_servers_section_desc">Servicios MCP externos configurados en el servidor local listos para arrancar de forma individual.</p>
            <div id="mcp-servers-list" class="mcp-servers-list"></div>
          </div>

          <!-- Contenedor dinámico de herramientas MCP registradas -->
          <div id="mcp-tools-container" class="mcp-tools-container" style="margin-top: 1rem;"></div>
        </div>

        <!-- Sección: Permisos de ejecución MCP -->
        <div id="tab-permissions" class="settings-section-pane">
          <div class="mcp-security-card">
            <div class="mcp-security-header">
              <span class="mcp-security-icon">
                <svg class="ui-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>
              </span>
              <div>
                <strong data-i18n="mcp_security_section_title">Seguridad y Autorización de Ejecución</strong>
                <p class="label-hint mcp-section-hint" data-i18n="mcp_security_desc">Controla cuándo se ejecutan las herramientas del servidor MCP en tu sistema local.</p>
              </div>
            </div>

            <div class="mcp-policy-options">
              <label class="mcp-policy-option">
                <input type="radio" name="mcp-global-policy" value="ask" id="mcp-policy-ask" checked>
                <div class="mcp-policy-text">
                  <strong data-i18n="mcp_security_policy_ask">Pedir autorización antes de ejecutar (Recomendado)</strong>
                  <p class="label-hint" data-i18n="mcp_security_policy_ask_hint">El chat te pedirá confirmar cada comando o herramienta MCP no autorizada previamente.</p>
                </div>
              </label>
              <label class="mcp-policy-option">
                <input type="radio" name="mcp-global-policy" value="allow_all" id="mcp-policy-allow-all">
                <div class="mcp-policy-text">
                  <strong data-i18n="mcp_security_policy_allow_all">Todo autorizado (Modo sin restricciones)</strong>
                  <p class="label-hint" data-i18n="mcp_security_policy_allow_all_hint">Ejecuta inmediatamente cualquier herramienta MCP sin pausas de confirmación.</p>
                </div>
              </label>
            </div>

            <div class="mcp-saved-auths-section">
              <div class="mcp-saved-auths-header">
                <span class="label-hint" data-i18n="mcp_directory_rules_title">Directorios permitidos</span>
              </div>
              <p class="label-hint" data-i18n="mcp_directory_rules_hint">Una regla por línea: R: para leer, W: para modificar y RW: para ambas operaciones. Usa * para un segmento y ** para subdirectorios.</p>
              <textarea id="mcp-directory-rules" rows="5" spellcheck="false" data-i18n-aria-label="mcp_directory_rules_title" aria-label="Directorios permitidos" style="width: 100%; resize: vertical;"></textarea>
              <p id="mcp-directory-rules-error" class="label-hint" role="status" aria-live="polite"></p>
            </div>

            <div class="mcp-saved-auths-section">
              <div class="mcp-saved-auths-header">
                <span class="label-hint" data-i18n="mcp_security_saved_auths_title">Herramientas con Permiso Recordado:</span>
                <button type="button" id="btn-mcp-clear-auths" class="btn-text-action btn-mcp-clear-auths" data-i18n="mcp_security_btn_clear_all">Restablecer todas</button>
              </div>
              <div id="mcp-saved-auths-list" class="mcp-saved-auths-list"></div>
            </div>
          </div>
        </div>

        <!-- Sección: Inspector de Proveedor -->
        <div id="tab-inspector" class="settings-section-pane">
          <div class="inspector-intro-card">
            <div class="inspector-intro-header">
              <span class="inspector-intro-icon">
                <svg class="ui-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-search"></use></svg>
              </span>
              <div>
                <strong data-i18n="tab_inspector">Inspector de Proveedor</strong>
                <p class="label-hint" style="margin-top: 0.2rem;" data-i18n="inspector_desc">
                  Analiza el endpoint configurado para determinar con precisión qué capacidades soporta, distinguiendo entre capacidades declaradas, inferidas y comprobadas mediante pruebas activas seguras.
                </p>
              </div>
            </div>
            <button type="button" id="btn-run-inspector" class="btn-primary btn-inspector-run" data-i18n-title="btn_run_inspector" title="Ejecutar Diagnóstico de Capacidades" style="margin-top: 0.85rem; width: 100%; display: flex; align-items: center; justify-content: center; gap: 0.5rem; min-height: 40px; padding: 0.6rem;">
              <span class="inspector-btn-icon">
                <svg class="ui-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-zap"></use></svg>
              </span>
              <span class="inspector-btn-text" data-i18n="btn_diagnose_short">Diagnóstico</span>
            </button>
          </div>

          <div id="inspector-results" class="inspector-results-container" style="display: none; margin-top: 1rem;">
            <!-- Renderizado dinámico de informe de capacidades -->
          </div>
        </div>
      </div>
    </form>`;
  }

  function renderProfileMenu(elements, profiles, activeId) {
    const list = elements.activeProfileList;
    if (!list) return;
    const doc = list.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (!doc) return;
    const descriptionFor = profile => profile.id === 'profile:mirror' ? t('profile_mirror_description') : profile.description;
    list.replaceChildren();
    profiles.forEach(profile => {
      const item = doc.createElement('div');
      item.className = 'header-profile-item' + (profile.id === activeId ? ' active' : '');

      const option = doc.createElement('button');
      option.type = 'button';
      option.className = 'header-profile-option' + (profile.id === activeId ? ' active' : '');
      option.dataset.profileId = profile.id;
      option.setAttribute('role', 'menuitemradio');
      option.setAttribute('aria-checked', String(profile.id === activeId));
      option.setAttribute('title', profile.name);

      const name = doc.createElement('span');
      name.className = 'header-profile-option-name';
      name.textContent = profile.name;
      option.appendChild(name);

      const descText = descriptionFor(profile);
      if (descText) {
        const description = doc.createElement('span');
        description.className = 'header-profile-option-description';
        description.textContent = descText;
        option.appendChild(description);
      }
      item.appendChild(option);

      const actions = doc.createElement('div');
      actions.className = 'header-profile-item-actions';

      const editBtn = doc.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'btn-profile-item-action btn-profile-item-edit';
      editBtn.dataset.profileAction = 'edit';
      editBtn.dataset.targetId = profile.id;
      const editTitle = t('btn_edit_profile_title') || 'Editar este perfil';
      editBtn.title = editTitle;
      editBtn.setAttribute('aria-label', `${editTitle}: ${profile.name}`);
      editBtn.innerHTML = '<svg class="ui-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-edit"></use></svg>';
      actions.appendChild(editBtn);

      if (profile.id !== 'profile:mirror') {
        const deleteBtn = doc.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'btn-profile-item-action btn-profile-item-delete';
        deleteBtn.dataset.profileAction = 'delete';
        deleteBtn.dataset.targetId = profile.id;
        const deleteTitle = t('btn_delete_profile_item_title') || t('btn_delete_profile_title') || 'Eliminar este perfil';
        deleteBtn.title = deleteTitle;
        deleteBtn.setAttribute('aria-label', `${deleteTitle}: ${profile.name}`);
        deleteBtn.innerHTML = '<svg class="ui-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-trash"></use></svg>';
        actions.appendChild(deleteBtn);
      }

      item.appendChild(actions);
      list.appendChild(item);
    });
  }

  function syncProfileEditor(elements, readOnly, canSave = null) {
    const locked = elements.profilesDialog?.dataset.profileLocked === 'true';
    if (elements.btnDeleteProfile) elements.btnDeleteProfile.disabled = readOnly;
    const saveAllowed = canSave !== null ? Boolean(canSave) : (elements.profilesDialog?.dataset.queryReady === 'true');
    if (elements.btnSaveProfile) elements.btnSaveProfile.disabled = readOnly || locked || !saveAllowed;
    syncApiKeyLock(elements, readOnly);
    if (elements.profileSaveQueryHint) {
      if (readOnly) {
        elements.profileSaveQueryHint.textContent = t('err_profile_read_only');
      }
    }
  }

  function getProfilesDialogHTML() {
    return `<div class="modal-header settings-section-header">
      <div class="modal-title">
        <h3 data-i18n="profiles_modal_title">Perfil</h3>
      </div>
      <div class="settings-header-actions">
        <label id="api-key-lock-control" class="profile-lock-control" for="setting-api-key-locked"><input type="checkbox" id="setting-api-key-locked"><span data-i18n="profile_api_key_lock">Bloquear cambios</span></label>
        <span id="api-key-locked-status" class="profile-lock-status" hidden data-i18n="profile_api_key_locked">Cambios bloqueados</span>
        <button type="button" id="btn-save-profile" class="btn-primary btn-save-header" data-i18n-title="btn_save_profile_title" title="Guardar todos los valores actuales en este perfil" disabled>
          <svg class="ui-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-save"></use></svg>
          <span data-i18n="btn_save_short">Guardar</span>
        </button>
        <button id="btn-close-profiles" type="button" class="btn-close" data-i18n-aria="modal_close_aria" aria-label="Cerrar modal"><svg class="ui-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-close"></use></svg></button>
      </div>
    </div>
    <form id="profiles-form" class="settings-form-wrapper">
      <div class="modal-body">
        <input type="hidden" id="profile-select-helper">
        <div id="profile-action-feedback" class="server-query-status" style="display: none;"></div>

        <div class="form-field"><label for="setting-profile-name"><strong data-i18n="field_profile_name_label">Nombre del Perfil</strong></label><input type="text" id="setting-profile-name" data-i18n-placeholder="field_profile_placeholder" placeholder="Nombre del perfil (ej: LM Studio, Ollama, OpenRouter...)" autocomplete="off"></div>
        <div class="form-field"><label for="setting-profile-description"><strong data-i18n="field_profile_description_label">Descripción</strong></label><textarea id="setting-profile-description" rows="2" data-i18n-placeholder="field_profile_description_placeholder" placeholder="Describe brevemente este perfil..."></textarea></div>

        <div class="form-field"><label for="setting-api-type"><strong data-i18n="field_api_type">Tipo de Interfaz / Protocolo</strong></label><select id="setting-api-type" class="combobox-select-helper" style="width: 100%; max-width: 100%;"><option value="openai" selected>OpenAI / LM Studio / LocalAI / vLLM (/v1)</option><option value="ollama">Ollama (/api/tags)</option><option value="openrouter">OpenRouter (/api/v1)</option><option value="claude">Anthropic Claude (/v1)</option><option value="gemini">Google Gemini (OpenAI compat)</option><option value="webllm">WebLLM (WebGPU local)</option><option value="mirror" data-i18n="profile_mirror_type">Espejo (sin red)</option></select></div>
        <div class="form-field"><label for="setting-api-url"><strong data-i18n="field_api_url">URL del Servidor / Endpoint de Chat</strong></label><div class="input-with-button-wrapper"><input type="url" id="setting-api-url" placeholder="http://localhost:1234/v1" required><button type="button" id="btn-query-server" class="btn-query-server" data-i18n-title="btn_query_title" title="Consultar modelos disponibles y capacidades de la API en el servidor"><svg class="ui-icon query-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-search"></use></svg><span class="query-btn-text" data-i18n="btn_query_text">Query</span></button></div><div class="webllm-info-bar"><span class="label-hint webllm-local-hint" hidden data-i18n="webllm_local_hint">Ejecución local en este navegador.</span><a id="webllm-help-link" class="webllm-help-link" href="help/webllm.html" target="_blank" rel="noopener noreferrer" hidden><svg class="ui-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-help-circle"></use></svg><span data-i18n="webllm_help_link">Guía de configuración WebLLM</span><svg class="ui-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-external-link"></use></svg></a></div><div id="server-query-status" class="server-query-status" style="display: none;"></div><span id="profile-save-query-hint" class="label-hint" data-i18n="profile_save_changes_required">Realiza algún cambio en el perfil para habilitar el guardado.</span></div>
        <div class="form-field api-key-field"><label for="setting-api-key"><strong data-i18n="field_api_key">Clave de API (API Key)</strong><span class="label-hint"><span id="api-key-hint-text" data-i18n="field_api_key_hint">Opcional si usas un servidor local (LM Studio / Ollama / LocalAI).</span> <a id="api-key-free-help-link" href="" target="_blank" rel="noopener noreferrer" data-i18n="field_api_key_free_help" hidden>Cómo obtener una API key gratuita</a></span></label><div class="input-password-wrapper"><input type="password" id="setting-api-key" placeholder="sk-..." autocomplete="off"><button type="button" id="btn-toggle-key" class="btn-toggle-visibility" data-i18n-title="btn_toggle_key_title" title="Mostrar/Ocultar clave"><svg class="ui-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-eye"></use></svg></button></div></div>
        <div class="form-field"><label for="setting-model"><strong data-i18n="field_model">Nombre del Modelo</strong><span class="label-hint" data-i18n="field_model_hint">Selecciona de la lista del servidor o escribe cualquier nombre personalizado.</span></label><div class="combobox-wrapper"><input type="text" id="setting-model" list="model-datalist" data-i18n-placeholder="field_model_placeholder" placeholder="Escribe o pulsa Query para consultar modelos..." autocomplete="off"><select id="model-select-helper" class="combobox-select-helper" title="Seleccionar modelo de la lista"><option value="" disabled selected data-i18n="model_select_default">▾ Elegir modelo detectado...</option></select><datalist id="model-datalist"></datalist><button type="button" id="btn-webllm-params" class="btn-webllm-params" data-i18n-title="btn_webllm_params_title" title="Parámetros avanzados de rendimiento WebLLM" hidden><svg class="ui-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-settings"></use></svg></button></div><div id="webllm-params-panel" class="webllm-params-panel" hidden><div class="webllm-params-title"><svg class="ui-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-settings"></use></svg><span data-i18n="webllm_params_title">Parámetros de ejecución WebGPU</span></div><div class="webllm-params-grid"><div class="webllm-param-item"><label for="setting-webllm-context-window"><span data-i18n="field_webllm_context_window">Ventana de contexto (context_window_size)</span><select id="setting-webllm-context-window" class="combobox-select-helper"><option value="default" selected data-i18n="webllm_opt_default">Por defecto del modelo</option><option value="2048">2048 (2K)</option><option value="4096">4096 (4K)</option><option value="8192">8192 (8K)</option><option value="16384">16384 (16K)</option><option value="32768">32768 (32K)</option></select></label></div><div class="webllm-param-item"><label for="setting-webllm-prefill-chunk"><span data-i18n="field_webllm_prefill_chunk">Bloque de prefill (prefill_chunk_size)</span><select id="setting-webllm-prefill-chunk" class="combobox-select-helper"><option value="default" selected data-i18n="webllm_opt_default">Por defecto del modelo</option><option value="512">512</option><option value="1024">1024</option><option value="2048">2048</option><option value="4096">4096</option></select></label></div></div></div></div>

        <div class="form-field">
          <label for="setting-system-prompt"><strong data-i18n="field_system_prompt">Prompt del Sistema (Opcional)</strong><span class="label-hint" data-i18n="field_system_prompt_hint">Instrucciones base personalizadas que guían el comportamiento del asistente (opcional).</span></label>
          <textarea id="setting-system-prompt" rows="4" data-i18n-placeholder="field_system_prompt_placeholder" placeholder="Escribe aquí tus instrucciones personalizadas para el modelo (opcional)..."></textarea>
        </div>
        <div class="form-field" style="margin-bottom: 0;">
          <label for="setting-temperature"><strong><span data-i18n="field_temperature">Temperatura</span>: <span id="temperature-val">0.7</span></strong><span class="label-hint" data-i18n="field_temperature_hint">Controla la creatividad de las respuestas (0 = determinista/preciso, 1 = creativo).</span></label>
          <input type="range" id="setting-temperature" min="0" max="1.5" step="0.1" value="0.7">
        </div>
      </div>
    </form>`;
  }

  function ensureDialogMarkup() {
    if (typeof document === 'undefined') return;
    const settingsDialog = document.getElementById('settings-dialog');
    if (settingsDialog && !settingsDialog.firstElementChild) {
      settingsDialog.innerHTML = getSettingsDialogHTML();
    }
    const profilesDialog = document.getElementById('profiles-dialog');
    if (profilesDialog && !profilesDialog.firstElementChild) {
      profilesDialog.innerHTML = getProfilesDialogHTML();
    }
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', ensureDialogMarkup);
    } else {
      ensureDialogMarkup();
    }
  }

  return {
    applyTheme,
    renderProfileMenu,
    syncProfileEditor,
    applyLanguage,
    renderAgentToolsUI,
    gatherEnabledToolsFromUI,
    applyProfileToForm,
    syncProviderFields,
    syncApiKeyLock,
    gatherCurrentFormConfig,
    showProfileFeedback,
    openSettingsSection,
    closeSettingsModal,
    setSettingsFormDirty,
    isSettingsFormDirty,
    handleClearAllData,
    ensureDialogMarkup,
    getSettingsDialogHTML,
    getProfilesDialogHTML
  };
});
