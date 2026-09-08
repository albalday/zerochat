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
      systemPrompt: elements?.settingSystemPrompt ? elements.settingSystemPrompt.value.trim() : (appConfig?.systemPrompt || ''),
      systemDataPrompt: elements?.settingSystemDataPrompt ? elements.settingSystemDataPrompt.value.trim() : (appConfig?.systemDataPrompt || ''),
      temperature: appConfig?.temperature || '0.7',
      reasoningEffort: appConfig?.reasoningEffort || 'none',
      maxAgentTurns: elements?.settingMaxAgentTurns ? Number(elements.settingMaxAgentTurns.value) : (appConfig?.maxAgentTurns || 15),
      modelReasoningConfig: appConfig?.modelReasoningConfig || null,
      theme: appConfig?.theme || 'light',
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

  function openSettingsModal(elements, appConfig, callbacks = {}, initialTabId = 'tab-general') {
    ensureDialogMarkup();
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
    if (elements.mcpHostInput) {
      elements.mcpHostInput.value = appConfig?.mcpHost || '127.0.0.1';
    }
    if (elements.mcpPortInput) {
      elements.mcpPortInput.value = appConfig?.mcpPort || 6388;
    }

    const settingsTabs = elements.settingsDialog?.querySelectorAll ? elements.settingsDialog.querySelectorAll('.modal-tabs-nav .modal-tab-btn') : elements.modalTabs;
    const settingsPanes = elements.settingsDialog?.querySelectorAll ? elements.settingsDialog.querySelectorAll('.modal-tab-pane') : elements.modalPanes;
    if (settingsTabs && settingsTabs.length > 0) {
      settingsTabs.forEach(b => b.classList.remove('active'));
      if (settingsPanes) settingsPanes.forEach(p => p.classList.remove('active'));
      const doc = elements.settingsDialog?.ownerDocument || document;
      let targetTab = Array.from(settingsTabs).find(b => b.getAttribute('data-tab') === initialTabId);
      if (!targetTab) targetTab = settingsTabs[0];
      targetTab.classList.add('active');
      const targetPane = doc.getElementById(targetTab.getAttribute('data-tab'));
      if (targetPane) targetPane.classList.add('active');
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
      if (elements.mcpHostInput) elements.mcpHostInput.value = defaults.mcpHost || '127.0.0.1';
      if (elements.mcpPortInput) elements.mcpPortInput.value = defaults.mcpPort || 6388;
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

  function getSettingsDialogHTML() {
    return `<div class="modal-header">
      <div class="modal-title">
        <svg class="ui-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-settings"></use></svg>
        <h3 data-i18n="modal_title">Configuración del Chat</h3>
      </div>
      <button id="btn-close-settings" class="btn-close" data-i18n-aria="modal_close_aria" aria-label="Cerrar modal">
        <svg class="ui-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-close"></use></svg>
      </button>
    </div>

    <!-- Navegación por pestañas -->
    <div class="modal-tabs-nav">
      <button type="button" class="modal-tab-btn active" data-tab="tab-general">
        <svg class="ui-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-globe"></use></svg>
        <span data-i18n="tab_connection">Conexión</span>
      </button>
      <button type="button" class="modal-tab-btn" data-tab="tab-model">
        <svg class="ui-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-settings"></use></svg>
        <span data-i18n="tab_model">Modelo</span>
      </button>
      <button type="button" class="modal-tab-btn" data-tab="tab-agent">
        <svg class="ui-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-bot"></use></svg>
        <span data-i18n="tab_agent">Agente</span>
      </button>
      <button type="button" class="modal-tab-btn" data-tab="tab-mcp">
        <svg class="ui-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-server"></use></svg>
        <span data-i18n="tab_mcp">MCP</span>
      </button>
      <button type="button" class="modal-tab-btn" data-tab="tab-appearance">
        <svg class="ui-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-palette"></use></svg>
        <span data-i18n="tab_appearance">Visualización</span>
      </button>
      <button type="button" class="modal-tab-btn" data-tab="tab-inspector">
        <svg class="ui-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-search"></use></svg>
        <span data-i18n="tab_inspector">Inspector</span>
      </button>
    </div>

    <form id="settings-form" class="settings-form-wrapper">
      <div class="modal-body">
        <!-- Pestaña 1: Conexión activa -->
        <div id="tab-general" class="modal-tab-pane active">
          <div class="connection-active-card">
            <span class="connection-active-label" data-i18n="connection_active_profile">Perfil activo</span>
            <strong id="settings-active-profile-name"></strong>
            <p data-i18n="connection_active_hint">Los perfiles se seleccionan y editan desde la caja de prompt.</p>
            <button type="button" id="btn-manage-profiles" class="btn-primary" data-i18n="btn_manage_profiles">Gestionar perfiles de conexión</button>
          </div>
        </div>

        <!-- Pestaña 2: Modelo y Prompt -->
        <div id="tab-model" class="modal-tab-pane">
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

        <!-- Pestaña 3: Modo Agente y Herramientas -->
        <div id="tab-agent" class="modal-tab-pane">
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

        <!-- Pestaña 4: Gestor MCP (FastMCP) -->
        <div id="tab-mcp" class="modal-tab-pane">
          <!-- Tarjeta de Estado y Conexión Principal -->
          <div class="mcp-status-card">
            <div class="mcp-status-header">
              <div class="mcp-title-group">
                <span class="mcp-header-icon">
                  <svg class="ui-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-server"></use></svg>
                </span>
                <div>
                  <strong data-i18n="mcp_connection_title">Gestor MCP (FastMCP)</strong>
                  <p class="label-hint" style="margin-top: 0.2rem;" data-i18n="mcp_connection_desc">
                    Servidor local para conectar ZeroChat con herramientas del sistema vía Model Context Protocol (MCP) nativo (HTTP/SSE).
                  </p>
                </div>
              </div>

              <!-- Indicador de Estado y Acciones de Conexión -->
              <div class="mcp-status-actions">
                <span id="mcp-status-badge" class="mcp-status-badge mcp-status-disconnected">
                  <span class="mcp-status-dot"></span>
                  <span id="mcp-status-text">Desconectado</span>
                </span>
                <button type="button" id="btn-mcp-connect" class="btn-primary btn-mcp-action">
                  <svg class="ui-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-plug"></use></svg>
                  <span data-i18n="mcp_btn_connect">Conectar</span>
                </button>
                <button type="button" id="btn-mcp-disconnect" class="btn-secondary btn-mcp-action" style="display: none;">
                  <svg class="ui-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-close"></use></svg>
                  <span data-i18n="mcp_btn_disconnect">Desconectar</span>
                </button>
                <button type="button" id="btn-mcp-configure" class="btn-secondary btn-mcp-action" data-i18n-title="mcp_btn_configure_title" title="Configurar parámetros de conexión e instrucciones">
                  <svg class="ui-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-settings"></use></svg>
                  <span data-i18n="mcp_btn_configure">Configurar</span>
                </button>
              </div>
            </div>

            <!-- Detalles del servidor conectado o latencia -->
            <div id="mcp-server-details" class="mcp-server-details" style="display: none;"></div>

            <!-- Mensaje de error de conexión -->
            <div id="mcp-error-message" class="mcp-error-message" style="display: none;"></div>
          </div>

          <!-- Contenedor dinámico de herramientas MCP registradas -->
          <div id="mcp-tools-container" class="mcp-tools-container"></div>
        </div>

        <!-- Pestaña 5: Visualización e Idioma -->
        <div id="tab-appearance" class="modal-tab-pane">
          <div class="form-field">
            <label>
              <strong data-i18n="field_theme">Tema Visual de la Interfaz</strong>
              <span class="label-hint" data-i18n="field_theme_hint">Selecciona el modo de visualización.</span>
            </label>
            <div class="theme-switcher-group" id="theme-switcher-group">
              <button type="button" class="btn-theme-toggle active" id="btn-theme-light" data-theme="light">
                <svg class="ui-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-sun"></use></svg>
                <span data-i18n="theme_light">Modo Claro</span>
              </button>
              <button type="button" class="btn-theme-toggle" id="btn-theme-dark" data-theme="dark">
                <svg class="ui-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-moon"></use></svg>
                <span data-i18n="theme_dark">Modo Oscuro</span>
              </button>
            </div>
          </div>

          <div class="form-field">
            <label>
              <strong data-i18n="field_language">Idioma de la Interfaz (Language)</strong>
              <span class="label-hint" data-i18n="field_language_hint">Selecciona el idioma visual de la aplicación.</span>
            </label>
            <div class="theme-switcher-group" id="lang-switcher-group">
              <button type="button" class="btn-lang-toggle active" id="btn-lang-es" data-lang="es">
                <span>Español</span>
              </button>
              <button type="button" class="btn-lang-toggle" id="btn-lang-en" data-lang="en">
                <span>English</span>
              </button>
            </div>
          </div>
        </div>

        <!-- Pestaña 6: Inspector de Proveedor -->
        <div id="tab-inspector" class="modal-tab-pane">
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
            <button type="button" id="btn-run-inspector" class="btn-primary btn-inspector-run" style="margin-top: 0.85rem; width: 100%; display: flex; align-items: center; justify-content: center; gap: 0.5rem; padding: 0.6rem;">
              <span class="inspector-btn-icon">
                <svg class="ui-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-zap"></use></svg>
              </span>
              <span class="inspector-btn-text" data-i18n="btn_run_inspector">Ejecutar Diagnóstico de Capacidades</span>
            </button>
          </div>

          <div id="inspector-results" class="inspector-results-container" style="display: none; margin-top: 1rem;">
            <!-- Renderizado dinámico de informe de capacidades -->
          </div>
        </div>
      </div>

      <!-- Pie del Modal FIJO con botones siempre visibles -->
      <div class="modal-footer">
        <div class="footer-actions-left">
          <button type="button" id="btn-reset-settings" class="btn-secondary" data-i18n="btn_reset">Restablecer valores</button>
          <button type="button" id="btn-clear-all-data" class="btn-danger-outline" data-i18n-title="btn_clear_all_data_title" title="Borrar todas las cookies, sesiones y datos locales">
            <svg class="ui-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-trash"></use></svg>
            <span data-i18n="btn_clear_all_data">Borrar todo</span>
          </button>
        </div>
        <div class="footer-actions-right">
          <button type="button" id="btn-cancel-settings" class="btn-secondary" data-i18n="btn_cancel">Cancelar</button>
          <button type="submit" class="btn-primary" data-i18n="btn_save">Guardar Configuración</button>
        </div>
      </div>
    </form>`;
  }

  function getProfilesDialogHTML() {
    return `<div class="modal-header">
      <div class="modal-title">
        <svg class="ui-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-user-plus"></use></svg>
        <h3 data-i18n="profiles_modal_title">Mantenimiento de perfiles</h3>
      </div>
      <button id="btn-close-profiles" type="button" class="btn-close" data-i18n-aria="modal_close_aria" aria-label="Cerrar modal"><svg class="ui-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-close"></use></svg></button>
    </div>
    <div class="modal-tabs-nav profile-tabs-nav" role="tablist" aria-label="Secciones del perfil">
      <button type="button" id="profile-tab-name" class="modal-tab-btn active" role="tab" aria-selected="true" aria-controls="profile-tab-name-pane" data-profile-tab="profile-tab-name-pane"><span data-i18n="profile_tab_name">Nombre</span></button>
      <button type="button" id="profile-tab-settings" class="modal-tab-btn" role="tab" aria-selected="false" aria-controls="profile-tab-settings-pane" data-profile-tab="profile-tab-settings-pane"><span data-i18n="profile_tab_settings">Configuración</span></button>
      <button type="button" id="profile-tab-model" class="modal-tab-btn" role="tab" aria-selected="false" aria-controls="profile-tab-model-pane" data-profile-tab="profile-tab-model-pane"><span data-i18n="profile_tab_model">Modelo</span></button>
    </div>
    <form id="profiles-form" class="settings-form-wrapper">
      <div class="modal-body">
        <div id="profile-tab-name-pane" class="modal-tab-pane active" role="tabpanel" aria-labelledby="profile-tab-name">
        <div class="form-field profile-selection-field">
          <label for="profile-select-helper"><strong data-i18n="field_profile">Perfil de Conexión / Servidor</strong></label>
          <div class="combobox-wrapper profile-combobox-wrapper">
            <select id="profile-select-helper" class="combobox-select-helper" title="Seleccionar perfil existente" style="flex: 1; max-width: 100%;"><option value="" disabled selected data-i18n="profile_select_default">▾ Elegir perfil guardado...</option></select>
            <datalist id="profile-datalist"></datalist>
          </div>
          <div id="profile-action-feedback" class="server-query-status" style="display: none;"></div>
        </div>
          <div class="form-field"><label for="setting-profile-name"><strong data-i18n="field_profile_name_label">Nombre del Perfil</strong></label><input type="text" id="setting-profile-name" list="profile-datalist" data-i18n-placeholder="field_profile_placeholder" placeholder="Nombre del perfil (ej: LM Studio, Ollama, OpenRouter...)" autocomplete="off"></div>
          <div class="form-field"><label for="setting-profile-description"><strong data-i18n="field_profile_description_label">Descripción</strong></label><textarea id="setting-profile-description" rows="3" data-i18n-placeholder="field_profile_description_placeholder" placeholder="Describe brevemente este perfil..."></textarea></div>
        </div>
        <div id="profile-tab-settings-pane" class="modal-tab-pane" role="tabpanel" aria-labelledby="profile-tab-settings">
        <div class="profile-values-card">
          <div class="form-field"><label for="setting-api-type"><strong data-i18n="field_api_type">Tipo de Interfaz / Protocolo</strong></label><select id="setting-api-type" class="combobox-select-helper" style="width: 100%; max-width: 100%;"><option value="openai" selected>OpenAI / LM Studio / LocalAI / vLLM (/v1)</option><option value="ollama">Ollama (/api/tags)</option><option value="openrouter">OpenRouter (/api/v1)</option><option value="claude">Anthropic Claude (/v1)</option><option value="gemini">Google Gemini (OpenAI compat)</option></select></div>
          <div class="form-field"><label for="setting-api-url"><strong data-i18n="field_api_url">URL del Servidor / Endpoint de Chat</strong></label><div class="input-with-button-wrapper"><input type="url" id="setting-api-url" placeholder="http://localhost:1234/v1" required><button type="button" id="btn-query-server" class="btn-query-server" data-i18n-title="btn_query_title" title="Consultar modelos disponibles y capacidades de la API en el servidor"><svg class="ui-icon query-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-search"></use></svg><span class="query-btn-text" data-i18n="btn_query_text">Query</span></button></div><div id="server-query-status" class="server-query-status" style="display: none;"></div></div>
          <div class="form-field"><label for="setting-api-key"><strong data-i18n="field_api_key">Clave de API (API Key)</strong><span class="label-hint" data-i18n="field_api_key_hint">Opcional si usas un servidor local (LM Studio / Ollama / LocalAI).</span></label><div class="input-password-wrapper"><input type="password" id="setting-api-key" placeholder="sk-..." autocomplete="off"><button type="button" id="btn-toggle-key" class="btn-toggle-visibility" data-i18n-title="btn_toggle_key_title" title="Mostrar/Ocultar clave"><svg class="ui-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-eye"></use></svg></button></div></div>
          <div class="form-field" style="margin-bottom: 0;"><label for="setting-model"><strong data-i18n="field_model">Nombre del Modelo</strong><span class="label-hint" data-i18n="field_model_hint">Selecciona de la lista del servidor o escribe cualquier nombre personalizado.</span></label><div class="combobox-wrapper"><input type="text" id="setting-model" list="model-datalist" data-i18n-placeholder="field_model_placeholder" placeholder="Escribe o pulsa Query para consultar modelos..." autocomplete="off"><select id="model-select-helper" class="combobox-select-helper" title="Seleccionar modelo de la lista"><option value="" disabled selected data-i18n="model_select_default">▾ Elegir modelo detectado...</option></select><datalist id="model-datalist"></datalist></div></div>
        </div>
        </div>
        <div id="profile-tab-model-pane" class="modal-tab-pane" role="tabpanel" aria-labelledby="profile-tab-model">
          <div class="profile-values-card">
            <div class="form-field">
              <label for="setting-system-prompt"><strong data-i18n="field_system_prompt">Prompt del Sistema (Opcional)</strong><span class="label-hint" data-i18n="field_system_prompt_hint">Instrucciones base personalizadas que guían el comportamiento del asistente (opcional).</span></label>
              <textarea id="setting-system-prompt" rows="5" data-i18n-placeholder="field_system_prompt_placeholder" placeholder="Escribe aquí tus instrucciones personalizadas para el modelo (opcional)..."></textarea>
            </div>
            <div class="form-field" style="margin-bottom: 0;">
              <label for="setting-temperature"><strong><span data-i18n="field_temperature">Temperatura</span>: <span id="temperature-val">0.7</span></strong><span class="label-hint" data-i18n="field_temperature_hint">Controla la creatividad de las respuestas (0 = determinista/preciso, 1 = creativo).</span></label>
              <input type="range" id="setting-temperature" min="0" max="1.5" step="0.1" value="0.7">
            </div>
          </div>
        </div>
      </div>
      <div class="modal-footer profile-actions-footer">
        <div class="footer-actions-left">
          <button type="button" id="btn-new-profile" class="btn-profile-action btn-secondary" data-i18n-title="btn_new_profile_title" title="Crear un perfil nuevo"><svg class="ui-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-plus"></use></svg><span data-i18n="btn_new_profile">Nuevo</span></button>
          <button type="button" id="btn-clone-profile" class="btn-profile-action btn-secondary" data-i18n-title="btn_clone_profile_title" title="Clonar el perfil seleccionado"><svg class="ui-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-copy"></use></svg><span data-i18n="btn_clone_profile">Clonar</span></button>
          <button type="button" id="btn-delete-profile" class="btn-profile-action btn-delete-profile" data-i18n-title="btn_delete_profile_title" title="Eliminar el perfil seleccionado"><svg class="ui-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-trash"></use></svg><span data-i18n="btn_delete_profile">Borrar</span></button>
        </div>
        <div class="footer-actions-right">
          <button type="button" id="btn-cancel-profiles" class="btn-secondary" data-i18n="btn_close">Cerrar</button>
          <button type="button" id="btn-save-profile" class="btn-profile-action btn-save-profile" data-i18n-title="btn_save_profile_title" title="Guardar todos los valores actuales en este perfil"><svg class="ui-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-save"></use></svg><span data-i18n="btn_save_profile">Guardar</span></button>
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
    handleClearAllData,
    ensureDialogMarkup,
    getSettingsDialogHTML,
    getProfilesDialogHTML
  };
});
