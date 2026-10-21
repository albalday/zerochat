/**
 * Diálogo de ajustes (modelo, herramientas, servidor local y permisos), tema e idioma.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./utils.js'), require('./i18n.js'), require('./icons.js'));
  } else {
    root.ChatUISettings = factory(root.ChatUtils, root.ChatI18n, root.ChatIcons);
  }
})(typeof self !== 'undefined' ? self : this, function (Utils, I18n, Icons) {
  'use strict';

  const { resolveDep, escapeHtml } = Utils;
  const { t } = I18n;

  const getAgentCore = () => resolveDep('ChatAgentCore', './agent-core.js');
  const getDataResetService = () => resolveDep('ChatDataResetService', './data-reset-service.js');
  const getDialogs = () => resolveDep('ChatDialogs', './ui-dialogs.js');
  const getConfig = () => resolveDep('ChatConfig', './config-store.js');
  const getUIMcp = () => resolveDep('ChatUIMcp', './ui-mcp.js');
  const getToolSecurity = () => resolveDep('ChatToolSecurity', './tool-security.js');
  const getSidebar = () => resolveDep('ChatUISidebar', './ui-sidebar.js');
  const getUIBrowser = () => resolveDep('ChatUIBrowser', './ui-browser.js');

  const SECTION_TITLES = { model: 'settings_model', agent: 'settings_agent', mcp: 'settings_mcp', browser: 'settings_browser', permissions: 'settings_permissions' };

  const markActive = (buttons, attribute, value) => buttons.forEach(button => button.classList.toggle('active', button.getAttribute(attribute) === value));

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

  /**
   * Cambios de los campos propios de Ajustes sobre la configuración en ejecución. La conexión y el
   * modelo pertenecen al editor de perfiles, que puede estar mostrando otro perfil.
   */
  function gatherSettingsFormConfig(elements, appConfig) {
    return {
      systemDataPrompt: elements.settingSystemDataPrompt.value.trim(),
      browser: getUIBrowser().getTool(),
      enabledTools: {
        ...appConfig.enabledTools,
        ...gatherEnabledToolsFromUI(elements.agentToolsContainer),
        ...gatherEnabledToolsFromUI(elements.mcpToolsContainer)
      }
    };
  }

  /** Pinta la política MCP global y las reglas de directorios guardadas en ChatToolSecurity. */
  function loadPermissionControls(elements) {
    const security = getToolSecurity().manager;
    const policy = security.getGlobalMcpPolicy();
    elements.settingsDialog.querySelectorAll('input[name="mcp-global-policy"]').forEach(radio => { radio.checked = radio.value === policy; });
    elements.mcpDirectoryRules.value = security.getDirectoryRules().join('\n');
    elements.mcpDirectoryRulesError.textContent = '';
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
      getUIBrowser().load(appConfig.browser);
      loadPermissionControls(elements);
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
    if (!await getUIBrowser().save()) {
      openSettingsSection(elements, appConfig, 'browser');
      return false;
    }
    const savedConfig = getConfig().updateRuntime(gatherSettingsFormConfig(elements, appConfig));
    setSettingsFormDirty(elements, false);
    callbacks.loadCachedModels();
    callbacks.onConfigSaved(savedConfig);
    callbacks.populateProfileSelector(savedConfig.activeProfile?.id || '');
    await closeSettingsPanelOnly(elements, true);
    return true;
  }

  let cleanups = [];

  /**
   * Conecta el diálogo de ajustes.
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
    listen(elements.btnClearAllData, 'click', () => getDataResetService().resetAllData());
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
              <a href="help/mcp.html#crear-mcp-con-agente" target="_blank" rel="noopener noreferrer" class="mcp-servers-create-help" data-i18n="mcp_servers_create_help" data-i18n-href="mcp_servers_create_help_href">Añadir un MCP con el agente</a>
            </div>
            <p class="label-hint mcp-section-hint" data-i18n="mcp_servers_section_desc">Servicios MCP externos configurados en el servidor local listos para arrancar de forma individual.</p>
            <div id="mcp-servers-list" class="mcp-servers-list"></div>
          </div>

          <!-- Contenedor dinámico de herramientas MCP registradas -->
          <div id="mcp-tools-container" class="mcp-tools-container"></div>
        </div>

        <!-- Sección: Navegador (la pinta ChatUIBrowser) -->
        <div id="settings-browser" class="settings-section-pane"></div>

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


  /** Inserta el marcado del diálogo de ajustes, que zerochat.html deja vacío. */
  function ensureDialogMarkup() {
    const settingsDialog = document.getElementById('settings-dialog');
    if (!settingsDialog.firstElementChild) settingsDialog.innerHTML = getSettingsDialogHTML();
  }

  return {
    applyTheme,
    applyLanguage,
    openSettingsSection,
    closeSettingsModal,
    ensureDialogMarkup,
    mount
  };
});
