/**
 * Interfaz de los perfiles: menú del perfil activo, editor de perfiles (marcado, capítulos, campos
 * del proveedor y servicios MCP) con detección de cambios sin guardar, borrado, exportación cifrada,
 * importación desde un paquete exportado y contraseña de cifrado de las API keys.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./utils.js'), require('./i18n.js'), require('./icons.js'), require('./defaults.js'));
  } else {
    root.ChatUIProfiles = factory(root.ChatUtils, root.ChatI18n, root.ChatIcons, root.ChatDefaults);
  }
}(typeof self !== 'undefined' ? self : this, function (Utils, I18n, Icons, Defaults) {
  'use strict';

  const { resolveDep, createId, escapeHtml, EPHEMERAL_ID_PATTERN, readLaunchFragment } = Utils;
  const { t } = I18n;

  const getProfiles = () => resolveDep('ChatProfileRepository', './profile-repository.js');
  const getProfileBackup = () => resolveDep('ChatProfileBackup', './profile-backup.js');
  const getProfileExportBundle = () => resolveDep('ChatProfileExportBundle', './profile-export-bundle.js');
  const getConfig = () => resolveDep('ChatConfig', './config-store.js');
  const getProviders = () => resolveDep('ChatProviders', './providers.js');
  const getWebLLM = () => resolveDep('ChatWebLLM', './providers-webllm.js');
  const getExport = () => resolveDep('ChatExport', './export.js');
  const getDialogs = () => resolveDep('ChatDialogs', './ui-dialogs.js');
  const getUIBrowser = () => resolveDep('ChatUIBrowser', './ui-browser.js');
  const getUIMcp = () => resolveDep('ChatUIMcp', './ui-mcp.js');
  const getState = () => resolveDep('ChatState', './state.js');

  const FREE_TIER_HELP = { openrouter: 'help/openrouter-free.html', gemini: 'help/gemini-free.html' };

  // Elementos y callbacks de la aplicación, fijados en mount().
  let els = null;
  let options = {};
  let cleanups = [];

  const runtimeConfig = () => options.getRuntimeConfig();
  const selectedProfileId = () => els.profileSelectHelper.value;
  const getAdapter = () => getProviders().registry.get(els.settingApiType.value || 'openai');
  const isProfileLocked = () => els.profilesDialog.dataset.profileLocked === 'true';

  function showProfileFeedback(message, type = 'success') {
    const feedback = els.profileActionFeedback;
    feedback.hidden = false;
    feedback.className = `server-query-status status-${type}`;
    feedback.textContent = message;
    setTimeout(() => { feedback.hidden = true; }, 4000);
  }

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
    syncProfileEditor(isReadOnly);

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

  /** Carga en el editor de perfiles los ajustes de conexión de un perfil. */
  function fillProfileForm(profileData) {
    if (profileData.apiType !== undefined) els.settingApiType.value = profileData.apiType;
    const defaultEndpoint = getAdapter().getConnectionConfig().endpoint || '';
    els.settingApiUrl.value = profileData.apiUrl || defaultEndpoint;
    const locked = profileData.apiKeyLocked === true;
    els.settingApiKeyLocked.checked = locked;
    els.profilesDialog.dataset.profileLocked = String(locked);
    els.apiKeyLockControl.hidden = locked;
    els.apiKeyLockedStatus.hidden = !locked;
    if (profileData.model !== undefined) {
      els.settingModel.value = profileData.model;
      els.modelSelectHelper.value = profileData.model;
    }
    if (profileData.systemPrompt !== undefined) els.settingSystemPrompt.value = profileData.systemPrompt;
    if (profileData.temperature !== undefined) {
      els.settingTemperature.value = profileData.temperature;
      els.temperatureVal.textContent = profileData.temperature;
    }
    const webllmConfig = profileData.webllmConfig || {};
    const selectValue = (select, value, fallback) => {
      select.value = value && value !== 'default' ? String(value) : fallback;
      if (!select.value) select.value = fallback;
    };
    selectValue(els.settingWebllmContextWindow, webllmConfig.context_window_size, String(Defaults.WEBLLM_DEFAULT_CONTEXT_WINDOW_SIZE));
    selectValue(els.settingWebllmPrefillChunk, webllmConfig.prefill_chunk_size, 'default');
    renderProfileMcpServers(profileData.mcpServers || []);
    getUIBrowser().loadProfileBrowser(profileData.playwrightBrowser ?? null);
    syncProviderFields();
    syncApiKeyLock();
  }

  const providerSupportsTemperature = () => getAdapter().getCapabilities().temperature !== false;

  /**
   * Activa los campos del editor según el bloqueo del perfil: con `readOnly` (Espejo) o bloqueado no
   * se edita nada; la clave oculta y la temperatura no admitida quedan siempre desactivadas.
   */
  function syncApiKeyLock(readOnly = false) {
    const disabled = readOnly || isProfileLocked();
    els.profilesDialog.querySelectorAll('.modal-body input, .modal-body textarea, .modal-body select, .modal-body button').forEach(control => {
      if (control === els.profileSelectHelper) return;
      control.disabled = disabled
        || (control === els.settingApiKey && control.closest('.api-key-field').hidden)
        || (control === els.settingTemperature && !providerSupportsTemperature());
    });
    els.settingApiKeyLocked.disabled = disabled;
    getUIBrowser().setProfileBrowserDisabled(disabled);
  }

  /** Ajusta el editor al proveedor elegido: endpoint, credenciales, temperatura y campos de WebLLM. */
  function syncProviderFields() {
    const providerId = els.settingApiType.value || 'openai';
    const connection = getAdapter().getConnectionConfig();
    const urlInput = els.settingApiUrl;
    if (connection.endpoint) {
      urlInput.placeholder = connection.endpoint;
      if (connection.endpointReadOnly || !urlInput.value.trim()) urlInput.value = connection.endpoint;
    }
    urlInput.readOnly = connection.endpointReadOnly === true;
    urlInput.required = connection.endpointReadOnly !== true;

    const supportsTemperature = providerSupportsTemperature();
    els.settingTemperature.disabled = isProfileLocked() || !supportsTemperature;
    const temperatureHintKey = supportsTemperature ? 'field_temperature_hint' : 'field_temperature_unsupported_hint';
    els.temperatureHint.dataset.i18n = temperatureHintKey;
    els.temperatureHint.textContent = t(temperatureHintKey);

    const credentials = connection.credentials !== false;
    els.settingApiKey.disabled = !credentials;
    els.settingApiKey.closest('.api-key-field').hidden = !credentials;
    const apiKeyHintKey = ['openai', 'ollama'].includes(providerId) ? 'field_api_key_hint' : 'field_api_key_required_hint';
    els.apiKeyHintText.dataset.i18n = apiKeyHintKey;
    els.apiKeyHintText.textContent = t(apiKeyHintKey);
    const helpUrl = FREE_TIER_HELP[providerId];
    els.apiKeyFreeHelpLink.hidden = !helpUrl;
    if (helpUrl) els.apiKeyFreeHelpLink.href = helpUrl;

    const isWebLLM = providerId === 'webllm';
    els.webllmLocalHint.hidden = !isWebLLM;
    els.webllmHelpLink.hidden = !isWebLLM;
    els.webllmParamsPanel.hidden = !isWebLLM;
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
    fillProfileForm(profileData);
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

  /** Menú del perfil activo: cada perfil con inspeccionar, editar y, salvo Espejo, borrar. */
  function renderProfileMenu() {
    const { READONLY_PROFILE_ID } = getProfiles();
    const activeId = runtimeConfig().activeProfile?.id;
    const actionButton = (profile, action, icon, titleKey) => {
      const title = t(titleKey);
      return `<button type="button" class="btn-profile-item-action btn-profile-item-${action}" data-profile-action="${action}" data-target-id="${escapeHtml(profile.id)}" title="${escapeHtml(title)}" aria-label="${escapeHtml(`${title}: ${profile.name}`)}">${Icons.get(icon, { size: 14 })}</button>`;
    };
    els.activeProfileList.innerHTML = getProfiles().list().map(profile => {
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
  function syncProfileChapterSummaries() {
    const optionText = select => select.selectedOptions[0]?.textContent.trim() || '';
    const model = els.settingModel.value.trim();
    els.profileSummaryConnection.textContent = `${model || t('profile_summary_no_model')} · ${optionText(els.settingApiType)}`;
    els.profileSummaryWebllm.textContent = `${optionText(els.settingWebllmContextWindow)} · ${optionText(els.settingWebllmPrefillChunk)}`;
    const behavior = [t(els.settingSystemPrompt.value.trim() ? 'profile_summary_custom_prompt' : 'profile_summary_no_prompt')];
    if (providerSupportsTemperature()) behavior.push(t('profile_summary_temperature', { val: els.settingTemperature.value }));
    els.profileSummaryBehavior.textContent = behavior.join(' · ');
    const servers = [...els.profileMcpServers.querySelectorAll('.profile-mcp-checkbox:checked')];
    els.profileSummaryMcp.textContent = servers.map(checkbox => checkbox.dataset.name).join(', ') || t('profile_summary_none');
    const missing = servers.filter(checkbox => checkbox.dataset.missing === 'true').length;
    els.profileSummaryMcpWarning.parentElement.hidden = missing === 0;
    els.profileSummaryMcpWarning.textContent = t('profile_mcp_missing_count', { count: missing });
    els.profileSummaryBrowser.textContent = getUIBrowser().profileBrowserSummary();
  }

  /**
   * Servicios MCP externos que el perfil puede arrancar: los del servidor local y los que el perfil
   * pide sin estar configurados en él, marcados como no disponibles.
   */
  function renderProfileMcpServers(selectedIds) {
    const mcp = getState().get('mcp');
    const connected = mcp.status === 'connected';
    const language = I18n.getLanguage();
    // Playwright MCP no se elige aquí: es una opción de Ajustes › Navegador.
    const known = connected ? mcp.externalServers.filter(server => server.id !== 'playwright') : [];
    const rows = known.map(server => ({
      id: server.id,
      name: getUIMcp().getServiceName(server, language),
      status: t(`mcp_external_status_${server.status || 'stopped'}`),
      missing: false
    }));
    selectedIds.filter(id => id !== 'playwright' && !known.some(server => server.id === id)).forEach(id => rows.push({
      id, name: id, status: t(connected ? 'profile_mcp_not_configured' : 'profile_mcp_unknown'), missing: connected
    }));
    els.profileMcpDisconnected.hidden = connected;
    els.profileMcpServers.innerHTML = rows.length === 0
      ? `<p class="label-hint">${escapeHtml(t('profile_mcp_empty'))}</p>`
      : rows.map(row => `<label class="profile-mcp-server${row.missing ? ' is-missing' : ''}">
          <input type="checkbox" class="profile-mcp-checkbox" value="${escapeHtml(row.id)}" data-name="${escapeHtml(row.name)}" data-missing="${row.missing}"${selectedIds.includes(row.id) ? ' checked' : ''}>
          <span class="profile-mcp-name">${escapeHtml(row.name)}</span>
          <span class="profile-mcp-status">${escapeHtml(row.status)}</span>
        </label>`).join('');
  }

  const gatherProfileMcpServers = () => [...els.profileMcpServers.querySelectorAll('.profile-mcp-checkbox:checked')].map(checkbox => checkbox.value);

  /** Al abrir el editor solo se despliega la conexión. */
  function resetProfileChapters() {
    els.profilesDialog.querySelectorAll('.profile-chapter').forEach(chapter => {
      chapter.open = chapter === els.profileChapterConnection;
    });
  }

  /** Estado del botón de guardar y de los campos del editor de perfiles. */
  function syncProfileEditor(readOnly) {
    syncProfileChapterSummaries();
    syncApiKeyLock(readOnly);
    if (readOnly) els.profileSaveQueryHint.textContent = t('err_profile_read_only');
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

        <div class="profile-chapters">
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
        ${profileChapter('profile-chapter-browser', 'profile-summary-browser', 'profile_chapter_browser', `
            <div id="profile-browser"></div>
        `)}
        </div>
      </div>
    </form>`;
  }

  /** Inserta el marcado del diálogo de perfil, que zerochat.html deja vacío. */
  function ensureDialogMarkup() {
    const profilesDialog = document.getElementById('profiles-dialog');
    if (!profilesDialog.firstElementChild) profilesDialog.innerHTML = getProfilesDialogHTML();
  }

  function setProfileMenuOpen(open) {
    els.activeProfileTrigger.setAttribute('aria-expanded', String(open));
    els.activeProfilePopover.hidden = !open;
  }

  function openProfileMenu() {
    renderProfileMenu();
    setProfileMenuOpen(true);
  }

  const closeProfileMenu = () => setProfileMenuOpen(false);

  /** Conexión y modelo del editor de perfiles sobre los ajustes del perfil editado. */
  function gatherProfileFormSettings(baseSettings) {
    const apiType = els.settingApiType.value || baseSettings.apiType;
    const selectOr = (select, fallback) => select.value.trim() || fallback || 'default';
    return {
      apiType,
      apiUrl: els.settingApiUrl.value.trim() || baseSettings.apiUrl || getProviders().registry.get(apiType).getConnectionConfig().endpoint,
      model: els.settingModel.value.trim(),
      systemPrompt: els.settingSystemPrompt.value.trim(),
      temperature: els.settingTemperature.value || baseSettings.temperature,
      webllmConfig: {
        context_window_size: selectOr(els.settingWebllmContextWindow, baseSettings.webllmConfig?.context_window_size),
        prefill_chunk_size: selectOr(els.settingWebllmPrefillChunk, baseSettings.webllmConfig?.prefill_chunk_size)
      }
    };
  }

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
    const apiKey = els.settingApiKey.value.trim();
    const saved = await Profiles.saveEditable({
      id: selected?.id || createId('profile'),
      name,
      description: els.settingProfileDescription.value.trim(),
      settings: {
        ...baseSettings,
        ...gatherProfileFormSettings(baseSettings),
        apiKey,
        apiKeyLocked: els.settingApiKeyLocked.checked,
        mcpServers: gatherProfileMcpServers(),
        playwrightBrowser: getUIBrowser().getProfileBrowser()
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
    renderProfileMenu();
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
    const hashParams = readLaunchFragment(location.hash);
    if (hashParams.get('mode') !== 'import') return false;
    const transferId = hashParams.get('transferId') || '';
    const validTransfer = EPHEMERAL_ID_PATTERN.test(transferId);

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
    resetProfileChapters();
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
    syncProviderFields();
    syncApiKeyLock(false);
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
      syncProviderFields();
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
    listen(els.settingTemperature, 'input', event => { els.temperatureVal.textContent = event.target.value; });
    listen(els.btnToggleKey, 'click', () => {
      const reveal = els.settingApiKey.type === 'password';
      els.settingApiKey.type = reveal ? 'text' : 'password';
      els.btnToggleKey.innerHTML = Icons.get(reveal ? 'eye-off' : 'eye', { size: 15 });
    });
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
    ensureDialogMarkup,
    renderProfileMenu,
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
