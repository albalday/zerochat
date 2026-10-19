/**
 * Diálogo de ajustes (modelo, herramientas, servidor local y permisos), tema e idioma, y las piezas
 * del editor de perfiles que comparte con ChatUIProfiles: formulario, menú y campos del proveedor.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./utils.js'), require('./i18n.js'), require('./icons.js'), require('./defaults.js'));
  } else {
    root.ChatUISettings = factory(root.ChatUtils, root.ChatI18n, root.ChatIcons, root.ChatDefaults);
  }
})(typeof self !== 'undefined' ? self : this, function (Utils, I18n, Icons, Defaults) {
  'use strict';

  const { resolveDep, escapeHtml } = Utils;
  const { t } = I18n;

  const getAgentCore = () => resolveDep('ChatAgentCore', './agent-core.js');
  const getProviders = () => resolveDep('ChatProviders', './providers.js');
  const getDataResetService = () => resolveDep('ChatDataResetService', './data-reset-service.js');
  const getDialogs = () => resolveDep('ChatDialogs', './ui-dialogs.js');
  const getConfig = () => resolveDep('ChatConfig', './config-store.js');
  const getUIMcp = () => resolveDep('ChatUIMcp', './ui-mcp.js');
  const getToolSecurity = () => resolveDep('ChatToolSecurity', './tool-security.js');
  const getSidebar = () => resolveDep('ChatUISidebar', './ui-sidebar.js');
  const getState = () => resolveDep('ChatState', './state.js');

  const FREE_TIER_HELP = { openrouter: 'help/openrouter-free.html', gemini: 'help/gemini-free.html' };
  const SECTION_TITLES = { model: 'settings_model', agent: 'settings_agent', mcp: 'settings_mcp', permissions: 'settings_permissions' };

  const markActive = (buttons, attribute, value) => buttons.forEach(button => button.classList.toggle('active', button.getAttribute(attribute) === value));
  const getAdapter = elements => getProviders().registry.get(elements.settingApiType.value || 'openai');
  const isProfileLocked = elements => elements.profilesDialog.dataset.profileLocked === 'true';

  function applyTheme(elements, theme) {
    const effective = theme === 'dark' ? 'dark' : 'light';
    if (effective === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
    markActive(elements.themeButtons, 'data-theme', effective);
    return effective;
  }

  /** Cambia el idioma de la interfaz; ChatI18n traduce los textos marcados con data-i18n*. */
  function applyLanguage(elements, lang) {
    const target = I18n.setLanguage(lang === 'en' ? 'en' : 'es');
    markActive(elements.langButtons, 'data-lang', target);
    return target;
  }

  /** Interruptores de las herramientas nativas que se configuran en los ajustes. */
  function renderAgentToolsUI(container, enabledTools) {
    const AgentCore = getAgentCore();
    const tools = AgentCore.registry.listTools().filter(tool => tool.category !== 'mcp' && tool.settings.showInSettings);
    container.innerHTML = tools.map(tool => {
      const { titleKey, descKey, defaultEnabled } = tool.settings;
      const checked = AgentCore.isToolEnabled(enabledTools, tool.name, defaultEnabled);
      return `<div class="setting-toggle-card">
        <div class="toggle-card-info">
          <div class="toggle-card-title"><span data-i18n="${escapeHtml(titleKey)}">${escapeHtml(t(titleKey))}</span></div>
          <p class="toggle-card-desc" data-i18n="${escapeHtml(descKey)}">${escapeHtml(t(descKey))}</p>
        </div>
        <label class="switch">
          <input type="checkbox" class="agent-tool-checkbox" data-tool-id="${escapeHtml(tool.name)}" ${checked ? 'checked' : ''}>
          <span class="slider"></span>
        </label>
      </div>`;
    }).join('');
  }

  function gatherEnabledToolsFromUI(container) {
    return Object.fromEntries([...container.querySelectorAll('.agent-tool-checkbox')].map(checkbox => [checkbox.dataset.toolId, checkbox.checked]));
  }

  /** Carga en el editor de perfiles los ajustes de conexión de un perfil. */
  function applyProfileToForm(elements, profileData) {
    if (profileData.apiType !== undefined) elements.settingApiType.value = profileData.apiType;
    const defaultEndpoint = getAdapter(elements).getConnectionConfig().endpoint || '';
    elements.settingApiUrl.value = profileData.apiUrl || defaultEndpoint;
    const locked = profileData.apiKeyLocked === true;
    elements.settingApiKeyLocked.checked = locked;
    elements.profilesDialog.dataset.profileLocked = String(locked);
    elements.apiKeyLockControl.hidden = locked;
    elements.apiKeyLockedStatus.hidden = !locked;
    if (profileData.model !== undefined) {
      elements.settingModel.value = profileData.model;
      elements.modelSelectHelper.value = profileData.model;
    }
    if (profileData.systemPrompt !== undefined) elements.settingSystemPrompt.value = profileData.systemPrompt;
    if (profileData.temperature !== undefined) {
      elements.settingTemperature.value = profileData.temperature;
      elements.temperatureVal.textContent = profileData.temperature;
    }
    const webllmConfig = profileData.webllmConfig || {};
    const selectValue = (select, value, fallback) => {
      select.value = value && value !== 'default' ? String(value) : fallback;
      if (!select.value) select.value = fallback;
    };
    selectValue(elements.settingWebllmContextWindow, webllmConfig.context_window_size, String(Defaults.WEBLLM_DEFAULT_CONTEXT_WINDOW_SIZE));
    selectValue(elements.settingWebllmPrefillChunk, webllmConfig.prefill_chunk_size, 'default');
    renderProfileMcpServers(elements, profileData.mcpServers || []);
    syncProviderFields(elements);
    syncApiKeyLock(elements);
  }

  const providerSupportsTemperature = elements => getAdapter(elements).getCapabilities().temperature !== false;

  /**
   * Activa los campos del editor según el bloqueo del perfil: con `readOnly` (Espejo) o bloqueado no
   * se edita nada; la clave oculta y la temperatura no admitida quedan siempre desactivadas.
   */
  function syncApiKeyLock(elements, readOnly = false) {
    const disabled = readOnly || isProfileLocked(elements);
    elements.profilesDialog.querySelectorAll('.modal-body input, .modal-body textarea, .modal-body select, .modal-body button').forEach(control => {
      if (control === elements.profileSelectHelper) return;
      control.disabled = disabled
        || (control === elements.settingApiKey && control.closest('.api-key-field').hidden)
        || (control === elements.settingTemperature && !providerSupportsTemperature(elements));
    });
    elements.settingApiKeyLocked.disabled = disabled;
  }

  /** Ajusta el editor al proveedor elegido: endpoint, credenciales, temperatura y campos de WebLLM. */
  function syncProviderFields(elements) {
    const providerId = elements.settingApiType.value || 'openai';
    const connection = getAdapter(elements).getConnectionConfig();
    const urlInput = elements.settingApiUrl;
    if (connection.endpoint) {
      urlInput.placeholder = connection.endpoint;
      if (connection.endpointReadOnly || !urlInput.value.trim()) urlInput.value = connection.endpoint;
    }
    urlInput.readOnly = connection.endpointReadOnly === true;
    urlInput.required = connection.endpointReadOnly !== true;

    const supportsTemperature = providerSupportsTemperature(elements);
    elements.settingTemperature.disabled = isProfileLocked(elements) || !supportsTemperature;
    const temperatureHintKey = supportsTemperature ? 'field_temperature_hint' : 'field_temperature_unsupported_hint';
    elements.temperatureHint.dataset.i18n = temperatureHintKey;
    elements.temperatureHint.textContent = t(temperatureHintKey);

    const credentials = connection.credentials !== false;
    elements.settingApiKey.disabled = !credentials;
    elements.settingApiKey.closest('.api-key-field').hidden = !credentials;
    const apiKeyHintKey = ['openai', 'ollama'].includes(providerId) ? 'field_api_key_hint' : 'field_api_key_required_hint';
    elements.apiKeyHintText.dataset.i18n = apiKeyHintKey;
    elements.apiKeyHintText.textContent = t(apiKeyHintKey);
    const helpUrl = FREE_TIER_HELP[providerId];
    elements.apiKeyFreeHelpLink.hidden = !helpUrl;
    if (helpUrl) elements.apiKeyFreeHelpLink.href = helpUrl;

    const isWebLLM = providerId === 'webllm';
    elements.webllmLocalHint.hidden = !isWebLLM;
    elements.webllmHelpLink.hidden = !isWebLLM;
    elements.webllmParamsPanel.hidden = !isWebLLM;
  }

  /** Configuración resultante del formulario sobre la configuración en ejecución. */
  function gatherCurrentFormConfig(elements, appConfig) {
    const valueOr = (select, fallback) => select.value.trim() || fallback || 'default';
    return {
      ...appConfig,
      apiUrl: elements.settingApiUrl.value.trim(),
      apiType: elements.settingApiType.value,
      model: elements.settingModel.value.trim(),
      webllmConfig: {
        context_window_size: valueOr(elements.settingWebllmContextWindow, appConfig.webllmConfig?.context_window_size),
        prefill_chunk_size: valueOr(elements.settingWebllmPrefillChunk, appConfig.webllmConfig?.prefill_chunk_size)
      },
      // El límite publicado pertenece a la conexión en ejecución, no al formulario.
      modelContextLimit: null,
      systemPrompt: elements.settingSystemPrompt.value.trim(),
      systemDataPrompt: elements.settingSystemDataPrompt.value.trim(),
      temperature: elements.settingTemperature.value,
      enabledTools: {
        ...appConfig.enabledTools,
        ...gatherEnabledToolsFromUI(elements.agentToolsContainer),
        ...gatherEnabledToolsFromUI(elements.mcpToolsContainer)
      },
      activeRagBranchIds: [...appConfig.activeRagBranchIds]
    };
  }

  function showProfileFeedback(elements, message, type = 'success') {
    const feedback = elements.profileActionFeedback;
    feedback.hidden = false;
    feedback.className = `server-query-status status-${type}`;
    feedback.textContent = message;
    setTimeout(() => { feedback.hidden = true; }, 4000);
  }

  const setSettingsFormDirty = (elements, dirty) => { elements.settingsDialog.dataset.settingsDirty = String(Boolean(dirty)); };
  const isSettingsFormDirty = elements => elements.settingsDialog.dataset.settingsDirty === 'true';

  /**
   * Abre los ajustes en una sección. Si ya estaban abiertos con cambios sin guardar, los conserva y
   * solo cambia de sección.
   */
  function openSettingsSection(elements, appConfig, sectionId = 'model') {
    const preservePendingChanges = elements.settingsDialog.open && isSettingsFormDirty(elements);
    if (!preservePendingChanges) {
      elements.settingSystemDataPrompt.value = appConfig.systemDataPrompt || '';
      applyTheme(elements, appConfig.theme);
      applyLanguage(elements, appConfig.language);
      renderAgentToolsUI(elements.agentToolsContainer, appConfig.enabledTools);
    }
    getUIMcp().syncSecurityControls();

    const targetId = SECTION_TITLES[sectionId] ? sectionId : 'model';
    elements.settingsDialog.querySelectorAll('.settings-section-pane').forEach(section => {
      section.classList.toggle('active', section.id === `settings-${targetId}`);
    });
    elements.settingsSectionTitle.setAttribute('data-i18n', SECTION_TITLES[targetId]);
    elements.settingsSectionTitle.textContent = t(SECTION_TITLES[targetId]);
    getSidebar().setActiveSettingsSection(elements, targetId);

    if (!elements.settingsDialog.open) elements.settingsDialog.showModal();
    if (!preservePendingChanges) setSettingsFormDirty(elements, false);
    // Las acciones de la sección MCP se aplican al momento: Guardar solo aparece si hay cambios de otra sección.
    elements.btnSaveSettings.hidden = targetId === 'mcp' && !preservePendingChanges;
  }

  /** Guarda las reglas de directorios; si alguna no es válida muestra el error y devuelve false. */
  function saveDirectoryRulesFromSettings(elements) {
    const input = elements.mcpDirectoryRules;
    const rules = input.value.split(/\r?\n/).map(rule => rule.trim()).filter(Boolean);
    try {
      input.value = getToolSecurity().manager.setDirectoryRules(rules).join('\n');
      elements.mcpDirectoryRulesError.textContent = '';
      return true;
    } catch (error) {
      elements.mcpDirectoryRulesError.textContent = error?.message || t('mcp_directory_rules_invalid');
      return false;
    }
  }

  function saveMcpGlobalPolicyFromSettings(elements) {
    const checked = elements.settingsDialog.querySelector('input[name="mcp-global-policy"]:checked');
    if (checked) getToolSecurity().manager.setGlobalMcpPolicy(checked.value);
  }

  /** Cierra los ajustes; con cambios sin guardar pide confirmación salvo con `force`. */
  async function closeSettingsModal(elements, force = false) {
    if (!force && isSettingsFormDirty(elements) && !await getDialogs().confirm(t('confirm_settings_unsaved_changes'))) return false;
    elements.settingsDialog.close();
    setSettingsFormDirty(elements, false);
    getSidebar().setSidebarMode(elements, 'chat');
    return true;
  }

  /** Cierra los ajustes y vuelve a la lista de secciones de la barra lateral. */
  async function closeSettingsPanelOnly(elements, force = false) {
    if (!await closeSettingsModal(elements, force)) return false;
    const Sidebar = getSidebar();
    Sidebar.setSidebarMode(elements, 'settings');
    if (Sidebar.isMobile()) Sidebar.openSidebar(elements);
    return true;
  }

  async function saveCurrentSettings(elements, appConfig, callbacks) {
    if (!saveDirectoryRulesFromSettings(elements)) return false;
    saveMcpGlobalPolicyFromSettings(elements);
    const savedConfig = getConfig().updateRuntime(gatherCurrentFormConfig(elements, appConfig));
    setSettingsFormDirty(elements, false);
    callbacks.loadCachedModels();
    callbacks.onConfigSaved(savedConfig);
    callbacks.populateProfileSelector(savedConfig.activeProfile?.id || '');
    await closeSettingsPanelOnly(elements, true);
    return true;
  }

  let cleanups = [];

  /**
   * Conecta el diálogo de ajustes y los controles del editor de perfiles que no dependen del perfil.
   * `callbacks` aporta loadCachedModels, onConfigSaved y populateProfileSelector.
   */
  function mount({ elements, getRuntimeConfig, callbacks }) {
    cleanups.forEach(cleanup => cleanup());
    cleanups = [];
    const listen = (target, type, handler) => {
      target.addEventListener(type, handler);
      cleanups.push(() => target.removeEventListener(type, handler));
    };
    const dialog = elements.settingsDialog;
    const markModified = () => setSettingsFormDirty(elements, true);
    // Los controles de la sección MCP se aplican al momento y no dejan cambios pendientes. Se mira la
    // ruta del evento porque aplicar un interruptor vuelve a pintar la lista y retira el control.
    const markFormModified = event => {
      if (!event.composedPath().some(node => node.id === 'settings-mcp')) markModified();
    };

    listen(elements.btnCloseSettings, 'click', () => closeSettingsPanelOnly(elements));
    listen(elements.settingsForm, 'submit', event => {
      event.preventDefault();
      saveCurrentSettings(elements, getRuntimeConfig(), callbacks);
    });
    listen(dialog, 'input', markFormModified);
    listen(dialog, 'change', markFormModified);
    listen(dialog, 'click', event => {
      if (event.target === dialog) closeSettingsPanelOnly(elements);
    });
    listen(dialog, 'cancel', event => {
      if (!isSettingsFormDirty(elements)) return;
      event.preventDefault();
      closeSettingsPanelOnly(elements);
    });
    listen(elements.agentToolsContainer, 'change', event => {
      const checkbox = event.target.closest('.agent-tool-checkbox');
      if (!checkbox) return;
      const Config = getConfig();
      Config.updateRuntime({ enabledTools: { ...Config.getActive().enabledTools, [checkbox.dataset.toolId]: checkbox.checked } });
    });
    listen(elements.btnClearAllData, 'click', () => getDataResetService().resetAllData());
    listen(elements.settingTemperature, 'input', event => { elements.temperatureVal.textContent = event.target.value; });
    listen(elements.btnToggleKey, 'click', () => {
      const reveal = elements.settingApiKey.type === 'password';
      elements.settingApiKey.type = reveal ? 'text' : 'password';
      elements.btnToggleKey.innerHTML = Icons.get(reveal ? 'eye-off' : 'eye', { size: 15 });
    });
  }

  function getSettingsDialogHTML() {
    return `<div class="modal-header settings-section-header">
      <div class="modal-title">
        <h3 id="settings-section-title" data-i18n="settings_model">Modelo</h3>
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
        <div id="settings-model" class="settings-section-pane active">
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
        <div id="settings-agent" class="settings-section-pane">
          <div class="settings-section-intro">
            <p data-i18n="agent_intro">Configura las herramientas agénticas que se transmiten al modelo.</p>
          </div>

          <!-- Contenedor dinámico de herramientas agénticas registradas -->
          <div id="agent-tools-container" class="agent-tools-container"></div>
        </div>

        <!-- Sección: Servidor Local (MCP) -->
        <div id="settings-mcp" class="settings-section-pane">
          <!-- Estado del servidor local -->
          <div class="mcp-status-card">
            <div class="mcp-status-header">
              <div class="mcp-title-group">
                <span class="mcp-header-icon">
                  <svg class="ui-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-server"></use></svg>
                </span>
                <strong data-i18n="mcp_connection_title">Servidor Local</strong>
                <span id="mcp-server-details" class="mcp-server-details" hidden></span>
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
              <pre class="mcp-command-box mcp-cmd-box-flex"><code id="mcp-terminal-command">pip install zerochat
zerochat</code></pre>
              <button type="button" id="btn-mcp-copy-cmd" class="btn-secondary btn-copy-mcp-cmd" data-i18n-title="mcp_btn_copy_cmd" title="Copiar comando">
                <svg class="ui-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-copy"></use></svg>
                <span data-i18n="mcp_btn_copy_cmd">Copiar comando</span>
              </button>
            </div>
            <p class="label-hint mcp-section-hint" data-i18n="mcp_bootstrap_direct">Alternativa sin instalación: descarga zerochat.py y ejecútalo con Python.</p>
            <a href="help/mcp.html" target="_blank" rel="noopener noreferrer" class="mcp-bootstrap-help" data-i18n="mcp_bootstrap_help">Abrir ayuda de MCP</a>
          </div>

          <!-- Tarjeta de Servidores MCP Disponibles -->
          <div id="mcp-servers-card" class="mcp-status-card">
            <div class="mcp-status-header">
              <div class="mcp-title-group">
                <span class="mcp-header-icon">
                  <svg class="ui-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-server"></use></svg>
                </span>
                <strong data-i18n="mcp_servers_section_title">Servidores MCP Disponibles</strong>
              </div>
            </div>
            <p class="label-hint mcp-section-hint" data-i18n="mcp_servers_section_desc">Servicios MCP externos configurados en el servidor local listos para arrancar de forma individual.</p>
            <div id="mcp-servers-list" class="mcp-servers-list"></div>
          </div>

          <!-- Contenedor dinámico de herramientas MCP registradas -->
          <div id="mcp-tools-container" class="mcp-tools-container"></div>
        </div>

        <!-- Sección: Permisos de ejecución MCP -->
        <div id="settings-permissions" class="settings-section-pane">
          <!-- Tarjeta 1: Política Global de Ejecución -->
          <div class="mcp-status-card">
            <div class="mcp-status-header">
              <div class="mcp-title-group">
                <span class="mcp-header-icon">
                  <svg class="ui-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-shield"></use></svg>
                </span>
                <strong data-i18n="mcp_security_section_title">Seguridad y Autorización de Ejecución</strong>
              </div>
            </div>
            <p class="label-hint mcp-section-hint" data-i18n="mcp_security_desc">Controla cuándo se ejecutan las herramientas del servidor MCP en tu sistema local.</p>

            <div class="mcp-policy-options">
              <label class="mcp-policy-option">
                <input type="radio" name="mcp-global-policy" value="ask" id="mcp-policy-ask" checked>
                <div class="mcp-policy-text">
                  <strong data-i18n="mcp_security_policy_ask">Pedir autorización antes de ejecutar (Recomendado)</strong>
                  <p class="label-hint" data-i18n="mcp_security_policy_ask_hint">El chat te pedirá confirmar cada comando o herramienta MCP no autorizada previamente.</p>
                </div>
              </label>
              <label class="mcp-policy-option">
                <input type="radio" name="mcp-global-policy" value="workspace_trust" id="mcp-policy-workspace-trust">
                <div class="mcp-policy-text">
                  <strong data-i18n="mcp_security_policy_workspace_trust">Confiar en el espacio de trabajo (Workspace Trust)</strong>
                  <p class="label-hint" data-i18n="mcp_security_policy_workspace_trust_hint">Confía automáticamente en operaciones y archivos dentro del directorio del proyecto (CWD). Pregunta para accesos externos o comandos globales.</p>
                </div>
              </label>
              <label class="mcp-policy-option">
                <input type="radio" name="mcp-global-policy" value="allow_all" id="mcp-policy-allow-all">
                <div class="mcp-policy-text">
                  <strong data-i18n="mcp_security_policy_allow_all">Todo autorizado (Modo desatendido)</strong>
                  <p class="label-hint" data-i18n="mcp_security_policy_allow_all_hint">Ejecuta inmediatamente cualquier herramienta MCP sin pausas de confirmación.</p>
                </div>
              </label>
            </div>
          </div>

          <!-- Tarjeta 2: Directorios Permitidos -->
          <div class="mcp-status-card">
            <div class="mcp-status-header">
              <div class="mcp-title-group">
                <span class="mcp-header-icon">
                  ${Icons.get('folder', { size: 20 })}
                </span>
                <strong data-i18n="mcp_directory_rules_title">Directorios permitidos</strong>
              </div>
            </div>
            <p class="label-hint mcp-section-hint" data-i18n="mcp_directory_rules_hint">Una regla por línea: R: para leer, W: para modificar y RW: para ambas operaciones. Usa * para un segmento y ** para subdirectorios.</p>
            <div class="form-field">
              <textarea id="mcp-directory-rules" rows="4" spellcheck="false" data-i18n-aria-label="mcp_directory_rules_title" aria-label="Directorios permitidos"></textarea>
            </div>
            <p id="mcp-directory-rules-error" class="label-hint" role="status" aria-live="polite"></p>
          </div>

          <!-- Tarjeta 3: Herramientas y Servidores Autorizados -->
          <div class="mcp-status-card">
            <div class="mcp-status-header">
              <div class="mcp-title-group">
                <span class="mcp-header-icon">
                  ${Icons.get('check', { size: 20 })}
                </span>
                <strong data-i18n="mcp_security_saved_auths_title">Herramientas y Servidores Autorizados</strong>
              </div>
              <button type="button" id="btn-mcp-clear-auths" class="btn-danger-outline btn-mcp-clear-auths" hidden data-i18n-title="mcp_security_btn_clear_all" data-i18n-aria="mcp_security_btn_clear_all" title="Restablecer todas" aria-label="Restablecer todas">
                <svg class="ui-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><use href="#icon-trash"></use></svg>
                <span data-i18n="mcp_security_btn_clear_all">Restablecer todas</span>
              </button>
            </div>
            <p class="label-hint mcp-section-hint" data-i18n="mcp_security_saved_auths_desc">Decisiones recordadas en esta sesión o de forma permanente, y servidores MCP de confianza.</p>
            <div id="mcp-saved-auths-list" class="mcp-saved-auths-list"></div>
          </div>
        </div>

      </div>
    </form>`;
  }


  /** Menú del perfil activo: cada perfil con inspeccionar, editar y, salvo Espejo, borrar. */
  function renderProfileMenu(elements, profiles, activeId) {
    const READONLY_PROFILE_ID = resolveDep('ChatProfileRepository', './profile-repository.js').READONLY_PROFILE_ID;
    const actionButton = (profile, action, icon, titleKey) => {
      const title = t(titleKey);
      return `<button type="button" class="btn-profile-item-action btn-profile-item-${action}" data-profile-action="${action}" data-target-id="${escapeHtml(profile.id)}" title="${escapeHtml(title)}" aria-label="${escapeHtml(`${title}: ${profile.name}`)}">${Icons.get(icon, { size: 14 })}</button>`;
    };
    elements.activeProfileList.innerHTML = profiles.map(profile => {
      const active = profile.id === activeId;
      const description = profile.id === READONLY_PROFILE_ID ? t('profile_mirror_description') : profile.description;
      return `<div class="header-profile-item${active ? ' active' : ''}">
        <button type="button" class="header-profile-option${active ? ' active' : ''}" data-profile-id="${escapeHtml(profile.id)}" role="menuitemradio" aria-checked="${active}" title="${escapeHtml(profile.name)}">
          <span class="header-profile-option-name">${escapeHtml(profile.name)}</span>
          ${description ? `<span class="header-profile-option-description">${escapeHtml(description)}</span>` : ''}
        </button>
        <div class="header-profile-item-actions">
          ${actionButton(profile, 'inspect', 'search', 'btn_inspect_profile_title')}
          ${actionButton(profile, 'edit', 'edit', 'btn_edit_profile_title')}
          ${profile.id === READONLY_PROFILE_ID ? '' : actionButton(profile, 'delete', 'trash', 'btn_delete_profile_item_title')}
        </div>
      </div>`;
    }).join('');
  }

  /** Resumen de cada capítulo del editor de perfiles, visible con el capítulo plegado. */
  function syncProfileChapterSummaries(elements) {
    const optionText = select => select.selectedOptions[0]?.textContent.trim() || '';
    const model = elements.settingModel.value.trim();
    elements.profileSummaryConnection.textContent = `${model || t('profile_summary_no_model')} · ${optionText(elements.settingApiType)}`;
    elements.profileSummaryWebllm.textContent = `${optionText(elements.settingWebllmContextWindow)} · ${optionText(elements.settingWebllmPrefillChunk)}`;
    const behavior = [t(elements.settingSystemPrompt.value.trim() ? 'profile_summary_custom_prompt' : 'profile_summary_no_prompt')];
    if (providerSupportsTemperature(elements)) behavior.push(t('profile_summary_temperature', { val: elements.settingTemperature.value }));
    elements.profileSummaryBehavior.textContent = behavior.join(' · ');
    const servers = [...elements.profileMcpServers.querySelectorAll('.profile-mcp-checkbox:checked')];
    elements.profileSummaryMcp.textContent = servers.map(checkbox => checkbox.dataset.name).join(', ') || t('profile_summary_none');
    const missing = servers.filter(checkbox => checkbox.dataset.missing === 'true').length;
    elements.profileSummaryMcpWarning.parentElement.hidden = missing === 0;
    elements.profileSummaryMcpWarning.textContent = t('profile_mcp_missing_count', { count: missing });
  }

  /**
   * Servicios MCP externos que el perfil puede arrancar: los del servidor local y los que el perfil
   * pide sin estar configurados en él, marcados como no disponibles.
   */
  function renderProfileMcpServers(elements, selectedIds) {
    const mcp = getState().get('mcp');
    const connected = mcp.status === 'connected';
    const language = I18n.getLanguage();
    const known = connected ? mcp.externalServers : [];
    const rows = known.map(server => ({
      id: server.id,
      name: getUIMcp().getServiceName(server, language),
      status: t(`mcp_external_status_${server.status || 'stopped'}`),
      missing: false
    }));
    selectedIds.filter(id => !known.some(server => server.id === id)).forEach(id => rows.push({
      id, name: id, status: t(connected ? 'profile_mcp_not_configured' : 'profile_mcp_unknown'), missing: connected
    }));
    elements.profileMcpDisconnected.hidden = connected;
    elements.profileMcpServers.innerHTML = rows.length === 0
      ? `<p class="label-hint">${escapeHtml(t('profile_mcp_empty'))}</p>`
      : rows.map(row => `<label class="profile-mcp-server${row.missing ? ' is-missing' : ''}">
          <input type="checkbox" class="profile-mcp-checkbox" value="${escapeHtml(row.id)}" data-name="${escapeHtml(row.name)}" data-missing="${row.missing}"${selectedIds.includes(row.id) ? ' checked' : ''}>
          <span class="profile-mcp-name">${escapeHtml(row.name)}</span>
          <span class="profile-mcp-status">${escapeHtml(row.status)}</span>
        </label>`).join('');
  }

  const gatherProfileMcpServers = elements => [...elements.profileMcpServers.querySelectorAll('.profile-mcp-checkbox:checked')].map(checkbox => checkbox.value);

  /** Al abrir el editor solo se despliega la conexión. */
  function resetProfileChapters(elements) {
    elements.profilesDialog.querySelectorAll('.profile-chapter').forEach(chapter => {
      chapter.open = chapter === elements.profileChapterConnection;
    });
  }

  /** Estado del botón de guardar y de los campos del editor de perfiles. */
  function syncProfileEditor(elements, readOnly, canSave) {
    syncProfileChapterSummaries(elements);
    elements.btnSaveProfile.disabled = readOnly || isProfileLocked(elements) || !canSave;
    syncApiKeyLock(elements, readOnly);
    if (readOnly) elements.profileSaveQueryHint.textContent = t('err_profile_read_only');
  }

  /** Capítulo plegable del editor de perfiles; su cabecera resume el contenido aunque esté cerrado. */
  const profileChapter = (id, summaryId, titleKey, body, warningId = '') => `<details id="${id}" class="profile-chapter">
          <summary class="profile-chapter-summary"><svg class="ui-icon profile-chapter-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><use href="#icon-chevron-right"></use></svg><span class="profile-chapter-title" data-i18n="${titleKey}">${t(titleKey)}</span><span id="${summaryId}" class="profile-chapter-detail"></span>${warningId ? `<span class="profile-chapter-warning" hidden>${Icons.get('alert-triangle', { size: 12 })}<span id="${warningId}"></span></span>` : ''}</summary>
          <div class="profile-chapter-body">${body}</div>
        </details>`;

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
        <div id="profile-action-feedback" class="server-query-status" hidden></div>

        <div class="form-field"><label for="setting-profile-name"><strong data-i18n="field_profile_name_label">Nombre del Perfil</strong></label><input type="text" id="setting-profile-name" data-i18n-placeholder="field_profile_placeholder" placeholder="Nombre del perfil (ej: LM Studio, Ollama, OpenRouter...)" autocomplete="off"></div>
        <div class="form-field"><label for="setting-profile-description"><strong data-i18n="field_profile_description_label">Descripción</strong></label><textarea id="setting-profile-description" rows="2" data-i18n-placeholder="field_profile_description_placeholder" placeholder="Describe brevemente este perfil..."></textarea></div>

        ${profileChapter('profile-chapter-connection', 'profile-summary-connection', 'profile_chapter_connection', `
            <div class="form-field"><label for="setting-api-type"><strong data-i18n="field_api_type">Tipo de Interfaz / Protocolo</strong></label><select id="setting-api-type" class="combobox-select-helper setting-api-type"><option value="openai" selected>OpenAI / LM Studio / LocalAI / vLLM (/v1)</option><option value="ollama">Ollama (/api/tags)</option><option value="openrouter">OpenRouter (/api/v1)</option><option value="claude">Anthropic Claude (/v1)</option><option value="gemini">Google Gemini (OpenAI compat)</option><option value="webllm">WebLLM (WebGPU local)</option><option value="mirror" data-i18n="profile_mirror_type">Espejo (sin red)</option></select></div>
            <div class="form-field"><label for="setting-api-url"><strong data-i18n="field_api_url">URL del Servidor / Endpoint de Chat</strong></label><div class="input-with-button-wrapper"><input type="url" id="setting-api-url" placeholder="http://localhost:1234/v1" required><button type="button" id="btn-query-server" class="btn-query-server" data-i18n-title="btn_query_title" title="Consultar modelos disponibles y capacidades de la API en el servidor"><svg class="ui-icon query-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-search"></use></svg><span class="query-btn-text" data-i18n="btn_query_text">Query</span></button></div><div class="webllm-info-bar"><span id="webllm-local-hint" class="label-hint webllm-local-hint" hidden data-i18n="webllm_local_hint">Ejecución local en este navegador.</span><a id="webllm-help-link" class="webllm-help-link" href="help/webllm.html" target="_blank" rel="noopener noreferrer" hidden><svg class="ui-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-help-circle"></use></svg><span data-i18n="webllm_help_link">Guía de configuración WebLLM</span><svg class="ui-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-external-link"></use></svg></a></div><div id="server-query-status" class="server-query-status" hidden></div><span id="profile-save-query-hint" class="label-hint" data-i18n="profile_save_changes_required">Realiza algún cambio en el perfil para habilitar el guardado.</span></div>
            <div class="form-field api-key-field"><label for="setting-api-key"><strong data-i18n="field_api_key">Clave de API (API Key)</strong><span class="label-hint"><span id="api-key-hint-text" data-i18n="field_api_key_hint">Opcional si usas un servidor local (LM Studio / Ollama / LocalAI).</span> <a id="api-key-free-help-link" href="" target="_blank" rel="noopener noreferrer" data-i18n="field_api_key_free_help" hidden>Cómo obtener una API key gratuita</a></span></label><div class="input-password-wrapper"><input type="password" id="setting-api-key" placeholder="sk-..." autocomplete="off"><button type="button" id="btn-toggle-key" class="btn-toggle-visibility" data-i18n-title="btn_toggle_key_title" title="Mostrar/Ocultar clave"><svg class="ui-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-eye"></use></svg></button></div></div>
            <div class="form-field"><label for="setting-model"><strong data-i18n="field_model">Nombre del Modelo</strong><span class="label-hint" data-i18n="field_model_hint">Selecciona de la lista del servidor o escribe cualquier nombre personalizado.</span></label><div class="combobox-wrapper"><input type="text" id="setting-model" list="model-datalist" data-i18n-placeholder="field_model_placeholder" placeholder="Escribe o pulsa Query para consultar modelos..." autocomplete="off"><select id="model-select-helper" class="combobox-select-helper" title="Seleccionar modelo de la lista"><option value="" disabled selected data-i18n="model_select_default">▾ Elegir modelo detectado...</option></select><datalist id="model-datalist"></datalist></div></div>
        `)}
        ${profileChapter('webllm-params-panel', 'profile-summary-webllm', 'webllm_params_title', `
            <div class="webllm-params-grid"><div class="webllm-param-item"><label for="setting-webllm-context-window"><span data-i18n="field_webllm_context_window">Ventana de contexto (context_window_size)</span><select id="setting-webllm-context-window" class="combobox-select-helper"><option value="4096">4096 (4K)</option><option value="8192">8192 (8K)</option><option value="16384">16384 (16K)</option><option value="32768">32768 (32K)</option><option value="65536">65536 (64K)</option><option value="131072">131072 (128K)</option></select></label></div><div class="webllm-param-item"><label for="setting-webllm-prefill-chunk"><span data-i18n="field_webllm_prefill_chunk">Bloque de prefill (prefill_chunk_size)</span><select id="setting-webllm-prefill-chunk" class="combobox-select-helper"><option value="default" selected data-i18n="webllm_opt_default">Por defecto del modelo</option><option value="512">512</option><option value="1024">1024</option><option value="2048">2048</option><option value="4096">4096</option></select></label></div></div>
        `)}
        ${profileChapter('profile-chapter-behavior', 'profile-summary-behavior', 'profile_chapter_behavior', `
            <div class="form-field">
              <label for="setting-system-prompt"><strong data-i18n="field_system_prompt">Prompt del Sistema (Opcional)</strong><span class="label-hint" data-i18n="field_system_prompt_hint">Instrucciones base personalizadas que guían el comportamiento del asistente (opcional).</span></label>
              <textarea id="setting-system-prompt" rows="4" data-i18n-placeholder="field_system_prompt_placeholder" placeholder="Escribe aquí tus instrucciones personalizadas para el modelo (opcional)..."></textarea>
            </div>
            <div class="form-field">
              <label for="setting-temperature"><strong><span data-i18n="field_temperature">Temperatura</span>: <span id="temperature-val">0.7</span></strong><span class="label-hint" id="temperature-hint" data-i18n="field_temperature_hint">Controla la creatividad de las respuestas (0 = determinista/preciso, 1 = creativo).</span></label>
              <input type="range" id="setting-temperature" min="0" max="1.5" step="0.1" value="0.7">
            </div>
        `)}
        ${profileChapter('profile-chapter-mcp', 'profile-summary-mcp', 'profile_chapter_mcp', `
            <p class="label-hint" data-i18n="profile_mcp_hint">${t('profile_mcp_hint')}</p>
            <p id="profile-mcp-disconnected" class="label-hint" data-i18n="profile_mcp_disconnected" hidden>${t('profile_mcp_disconnected')}</p>
            <div id="profile-mcp-servers" class="profile-mcp-servers"></div>
        `, 'profile-summary-mcp-warning')}
      </div>
    </form>`;
  }


  /** Inserta el marcado de los diálogos de ajustes y de perfil, que zerochat.html deja vacíos. */
  function ensureDialogMarkup() {
    const settingsDialog = document.getElementById('settings-dialog');
    if (!settingsDialog.firstElementChild) settingsDialog.innerHTML = getSettingsDialogHTML();
    const profilesDialog = document.getElementById('profiles-dialog');
    if (!profilesDialog.firstElementChild) profilesDialog.innerHTML = getProfilesDialogHTML();
  }

  return {
    applyTheme,
    applyLanguage,
    applyProfileToForm,
    syncProviderFields,
    syncApiKeyLock,
    gatherCurrentFormConfig,
    showProfileFeedback,
    renderProfileMenu,
    syncProfileEditor,
    resetProfileChapters,
    gatherProfileMcpServers,
    openSettingsSection,
    closeSettingsModal,
    ensureDialogMarkup,
    mount
  };
});
