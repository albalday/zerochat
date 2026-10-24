/**
 * Aplicación principal del cliente de chat Web (ZeroChat).
 * Arranca los módulos, reúne los elementos del DOM y cablea entre ellos los eventos de la
 * interfaz. La lógica de cada área vive en su módulo; aquí solo queda la coordinación.
 */

(function () {
  'use strict';

  const {
    ChatUtils: Utils,
    ChatStorage: Storage,
    ChatI18n: I18n,
    ChatDebug: Debug,
    ChatState: State,
    ChatEngine: Engine,
    ChatDefaults: Defaults,
    ChatDialogs: Dialogs,
    ChatConfig: Config,
    ChatProfileRepository: Profiles,
    ChatProviders: Providers,
    ChatMCP: MCP,
    ChatToolSecurity: ToolSecurity,
    ChatProjectContext: ProjectContext,
    ChatMessageTurns: MessageTurns,
    ChatConversationService: ConversationService,
    ChatGenerationController: GenerationController,
    ChatUIReasoning: UIReasoning,
    ChatUIInspector: UIInspector,
    ChatModelCatalog: ModelCatalog,
    ChatUISidebar: UISidebar,
    ChatUISettings: UISettings,
    ChatUIShell: UIShell,
    ChatUITransfer: UITransfer,
    ChatUIProfiles: UIProfiles,
    ChatUIComposer: UIComposer,
    ChatUICommandJobs: UICommandJobs,
    ChatUIConversation: UIConversation,
    ChatUITelemetry: UITelemetry,
    ChatUIMcp: UIMcp,
    ChatUIBrowser: UIBrowser,
    ChatUIConnection: UIConnection,
    ChatRagUI: RagUI,
    ChatRunMode: RunMode,
    ChatExport: Export
  } = window;
  const { t } = I18n;

  Config.initialize();

  const getRuntimeConfig = () => Config.getActive();
  const getChatHistory = () => State.get('messages');
  const getCurrentSessionId = () => State.get('sessions').activeId;

  const ELEMENT_IDS = {
    // Barra lateral de chats
    chatSidebar: 'chat-sidebar',
    btnToggleSidebar: 'btn-toggle-sidebar',
    btnCloseSidebar: 'btn-close-sidebar',
    btnSidebarNewTab: 'btn-sidebar-new-tab',
    btnSidebarNewChat: 'btn-sidebar-new-chat',
    sidebarSearchInput: 'sidebar-search-input',
    sidebarChatsList: 'sidebar-chats-list',
    btnImportChatFile: 'btn-import-chat-file',
    importJsonInput: 'import-json-input',
    btnDeleteAllChats: 'btn-delete-all-chats',
    sidebarViewChat: 'sidebar-view-chat',
    sidebarViewSettings: 'sidebar-view-settings',
    btnSidebarBackToChats: 'btn-sidebar-back-to-chats',
    btnCloseSidebarSettings: 'btn-close-sidebar-settings',
    sidebarSettingsNav: 'sidebar-settings-nav',
    sidebarEncryptionNav: 'sidebar-encryption-nav',
    sidebarRagNav: 'sidebar-rag-nav',
    sidebarSettingsFooter: 'sidebar-settings-footer',
    btnEncryptionBack: 'btn-encryption-back',
    btnEncryptionPassword: 'btn-encryption-password',
    btnEncryptionDefault: 'btn-encryption-default',
    btnRagBack: 'btn-rag-back',
    btnRagBranches: 'btn-rag-branches',
    btnRagActivate: 'btn-rag-activate',
    sidebarBackdrop: 'sidebar-backdrop',
    chatContainer: 'chat-container',
    // Modal de exportación
    exportModal: 'export-modal',
    btnCloseExport: 'btn-close-export',
    btnCancelExport: 'btn-cancel-export',
    btnExportMarkdown: 'btn-export-markdown',
    btnExportJson: 'btn-export-json',
    btnExportHtml: 'btn-export-html',
    btnExportPrint: 'btn-export-print',
    // Perfil activo e inspector
    activeProfileMenu: 'active-profile-menu',
    activeProfileTrigger: 'active-profile-trigger',
    activeProfileName: 'active-profile-name',
    activeProfilePopover: 'active-profile-popover',
    activeProfileList: 'active-profile-list',
    inspectorDialog: 'inspector-dialog',
    inspectorProfileName: 'inspector-profile-name',
    btnCloseInspector: 'btn-close-inspector',
    btnMenuNewProfile: 'btn-menu-new-profile',
    btnMenuExportProfiles: 'btn-menu-export-profiles',
    btnMenuCloseProfiles: 'btn-menu-close-profiles',
    // Telemetría de contexto
    connectionTokensBadge: 'connection-tokens-badge',
    connectionTokensText: 'connection-tokens-text',
    contextHubCachePill: 'context-hub-cache-pill',
    contextHubCacheVal: 'context-hub-cache-val',
    contextHubPopover: 'context-hub-popover',
    btnCloseContextPopover: 'btn-close-context-popover',
    contextProgressBar: 'context-progress-bar',
    contextMetricUsedVal: 'context-metric-used-val',
    contextMetricLimitVal: 'context-metric-limit-val',
    contextMetricFreeVal: 'context-metric-free-val',
    contextMetricStatusVal: 'context-metric-status-val',
    contextLimitSource: 'context-limit-source',
    contextLimitOverrideInput: 'context-limit-override-input',
    btnSaveContextLimitOverride: 'btn-save-context-limit-override',
    contextMetricCachedReadVal: 'context-metric-cached-read-val',
    contextMetricCachedWriteVal: 'context-metric-cached-write-val',
    contextMetricTurnPromptVal: 'context-metric-turn-prompt-val',
    contextMetricTurnCompletionVal: 'context-metric-turn-completion-val',
    contextMetricTurnSpeedVal: 'context-metric-turn-speed-val',
    contextMetricTurnLatencyVal: 'context-metric-turn-latency-val',
    // Conversación y compositor
    btnOpenSettings: 'btn-open-settings',
    btnOpenConnection: 'btn-open-connection',
    messagesList: 'messages-list',
    btnScrollBottom: 'btn-scroll-bottom',
    welcomeBanner: 'welcome-banner',
    chatForm: 'chat-form',
    userInput: 'user-input',
    btnSend: 'btn-send',
    btnStopStream: 'btn-stop-stream',
    generationStatus: 'generation-status',
    btnAttachFile: 'btn-attach-file',
    fileInput: 'file-input',
    attachmentsContainer: 'attachments-container',
    // Razonamiento y modo proyecto
    btnReasoning: 'btn-reasoning',
    reasoningLabel: 'reasoning-label',
    reasoningProjectLabel: 'reasoning-project-label',
    reasoningMenu: 'reasoning-menu',
    reasoningIntensity: 'reasoning-intensity',
    reasoningIntensityValue: 'reasoning-intensity-value',
    btnCloseReasoning: 'btn-close-reasoning',
    projectModePanel: 'project-mode-panel',
    // Panel de Debug & Logs
    btnToggleDebug: 'btn-toggle-debug',
    debugPanel: 'debug-panel',
    debugStatusIndicator: 'debug-status-indicator',
    btnCopyDebug: 'btn-copy-debug',
    btnClearDebug: 'btn-clear-debug',
    btnCloseDebug: 'btn-close-debug',
    debugLogContent: 'debug-log-content',
    chkEnableDebugMessages: 'chk-enable-debug-messages',
    debugMessagesStatusBadge: 'debug-messages-status-badge',
    // Modal de Depuración de Mensajes Salientes (Interceptor)
    debugInterceptorDialog: 'debug-interceptor-dialog',
    btnMaximizeDebugModal: 'btn-maximize-debug-modal',
    debugModalEndpointBadge: 'debug-modal-endpoint-badge',
    btnFormatDebugJson: 'btn-format-debug-json',
    btnCopyDebugJson: 'btn-copy-debug-json',
    txtDebugPayload: 'txt-debug-payload',
    debugJsonError: 'debug-json-error',
    btnDebugSendDisable: 'btn-debug-send-disable',
    btnDebugSend: 'btn-debug-send',
    btnCloseDebugModal: 'btn-close-debug-modal',
    // Modal de Configuración y perfiles
    settingsDialog: 'settings-dialog',
    settingsForm: 'settings-form',
    settingsSectionTitle: 'settings-section-title',
    btnCloseSettings: 'btn-close-settings',
    btnSaveSettings: 'btn-save-settings',
    btnClearAllData: 'btn-clear-all-data',
    btnToggleKey: 'btn-toggle-key',
    profilesDialog: 'profiles-dialog',
    btnCloseProfiles: 'btn-close-profiles',
    settingProfileName: 'setting-profile-name',
    settingProfileDescription: 'setting-profile-description',
    profileSelectHelper: 'profile-select-helper',
    btnSaveProfile: 'btn-save-profile',
    profileActionFeedback: 'profile-action-feedback',
    profileSaveQueryHint: 'profile-save-query-hint',
    settingApiType: 'setting-api-type',
    settingApiUrl: 'setting-api-url',
    btnQueryServer: 'btn-query-server',
    serverQueryStatus: 'server-query-status',
    settingApiKey: 'setting-api-key',
    settingApiKeyLocked: 'setting-api-key-locked',
    apiKeyLockControl: 'api-key-lock-control',
    apiKeyLockedStatus: 'api-key-locked-status',
    settingModel: 'setting-model',
    modelDatalist: 'model-datalist',
    modelSelectHelper: 'model-select-helper',
    webllmParamsPanel: 'webllm-params-panel',
    profileChapterConnection: 'profile-chapter-connection',
    profileSummaryConnection: 'profile-summary-connection',
    profileSummaryWebllm: 'profile-summary-webllm',
    profileSummaryBehavior: 'profile-summary-behavior',
    profileSummaryMcp: 'profile-summary-mcp',
    profileSummaryBrowser: 'profile-summary-browser',
    profileBrowser: 'profile-browser',
    profileSummaryMcpWarning: 'profile-summary-mcp-warning',
    profileMcpServers: 'profile-mcp-servers',
    profileMcpDisconnected: 'profile-mcp-disconnected',
    webllmLocalHint: 'webllm-local-hint',
    webllmHelpLink: 'webllm-help-link',
    apiKeyHintText: 'api-key-hint-text',
    apiKeyFreeHelpLink: 'api-key-free-help-link',
    mcpDirectoryRules: 'mcp-directory-rules',
    mcpDirectoryRulesError: 'mcp-directory-rules-error',
    settingWebllmContextWindow: 'setting-webllm-context-window',
    settingWebllmPrefillChunk: 'setting-webllm-prefill-chunk',
    settingSystemPrompt: 'setting-system-prompt',
    settingSystemDataPrompt: 'setting-system-data-prompt',
    settingTemperature: 'setting-temperature',
    temperatureVal: 'temperature-val',
    temperatureHint: 'temperature-hint',
    inspectorResults: 'inspector-results',
    agentToolsContainer: 'agent-tools-container',
    settingsBrowser: 'settings-browser',
    // Conexión con el servidor local e identificación
    settingLocalBackend: 'setting-local-backend',
    connectionRemoteFields: 'connection-remote-fields',
    settingBackendUrl: 'setting-backend-url',
    settingUseProxy: 'setting-use-proxy',
    settingProxyKeyField: 'setting-proxy-key-field',
    settingProxyKey: 'setting-proxy-key',
    btnBackendConnect: 'btn-backend-connect',
    backendConnectionStatus: 'backend-connection-status',
    backendConnectionError: 'backend-connection-error',
    loginDialog: 'login-dialog',
    loginForm: 'login-form',
    loginDesc: 'login-desc',
    loginUser: 'login-user',
    loginPassword: 'login-password',
    loginError: 'login-error',
    loginCancel: 'login-cancel',
    loginSubmit: 'login-submit',
    // MCP
    mcpToolsContainer: 'mcp-tools-container',
    mcpServersList: 'mcp-servers-list',
    mcpStatusBadge: 'mcp-status-badge',
    mcpStatusText: 'mcp-status-text',
    mcpServerDetails: 'mcp-server-details',
    mcpTerminalCommand: 'mcp-terminal-command',
    btnMcpCopyCmd: 'btn-mcp-copy-cmd',
    mcpBootstrapCard: 'mcp-bootstrap-card',
    mcpSavedAuthsList: 'mcp-saved-auths-list',
    btnMcpClearAuths: 'btn-mcp-clear-auths'
  };

  let elements = {};

  function cacheDomElements() {
    elements = Object.fromEntries(Object.entries(ELEMENT_IDS).map(([key, id]) => [key, document.getElementById(id)]));
    elements.sidebarSettingsItems = document.querySelectorAll('.sidebar-settings-item');
    elements.debugTabs = document.querySelectorAll('.debug-tab');
    elements.themeButtons = document.querySelectorAll('.btn-theme-toggle');
    elements.langButtons = document.querySelectorAll('.btn-lang-toggle');
  }

  function ensureModalsMarkup() {
    UISettings.ensureDialogMarkup();
    UIProfiles.ensureDialogMarkup();
    RagUI.ensureDialogMarkup();
    Export.ensureDialogMarkup();
    Debug.ensureDialogMarkup();
  }

  // ==========================================================================
  // Conversación
  // ==========================================================================

  function resetComposerInput(text = '') {
    UIComposer.setPromptValue(elements, text);
  }

  function getConversationServiceOptions() {
    return {
      renderSessionMessages,
      renderSidebarChats,
      onSessionReset: () => {
        UIComposer.clearAttachedFiles(elements);
        UIReasoning.closeReasoningMenu(elements);
        Debug.clearLogs();
        Debug.setStatus('idle');
        Debug.togglePanel(false);
        resetTelemetryDisplay({ syncState: false });
      },
      resetComposerInput: () => resetComposerInput(),
      closeMobileSidebar: () => {
        if (UISidebar.isMobile()) UISidebar.closeSidebar(elements);
      }
    };
  }

  const saveCurrentSession = () => ConversationService.saveCurrentSession(getConversationServiceOptions());
  const switchToSession = sessionId => ConversationService.switchToSession(sessionId, getConversationServiceOptions());
  const createNewSession = () => ConversationService.createNewSession(getConversationServiceOptions());
  const createConversationBranch = wrapper => ConversationService.createConversationBranch(UIConversation.getMessageRef(wrapper), {
    ...getConversationServiceOptions(),
    onSummarizing: active => (active ? UIConversation.showBranchLoadingIndicator(wrapper) : UIConversation.hideBranchLoadingIndicator(wrapper))
  });

  function renderSidebarChats() {
    UISidebar.renderSidebarChats(elements, State.get('sessions').list, getCurrentSessionId());
  }

  function removeMessage(wrapper) {
    UIConversation.removeMessage(wrapper, {
      messagesList: elements.messagesList,
      welcomeBanner: elements.welcomeBanner,
      saveSession: saveCurrentSession
    });
  }

  const messageCallbacks = {
    onReuse: text => resetComposerInput(text),
    onDelete: removeMessage,
    onBranch: createConversationBranch
  };

  function renderSessionMessages(history) {
    UIConversation.renderSessionMessages(elements, history, {
      ...messageCallbacks,
      resetTelemetry: () => resetTelemetryDisplay(),
      updateTelemetry: () => updateConnectionTokensBadge(null, { forcePopover: true })
    });
  }

  /** Envía el compositor; el modo ejecución pasa onProgress. Devuelve { text } o { error }. */
  function handleSendMessage({ onProgress } = {}) {
    return GenerationController.handleSendMessage({
      elements,
      appendUserMessage: (text, originalPrompt, attachedImages) => UIConversation.appendUserMessage(
        elements.messagesList, elements.welcomeBanner, { text, originalPrompt, attachedImages }, messageCallbacks),
      createAssistantMessagePlaceholder: () => UIConversation.createAssistantMessagePlaceholder(elements.messagesList, null, messageCallbacks),
      updateConnectionTokensBadge,
      openDebugInterceptorModal,
      saveCurrentSession,
      onProgress
    });
  }

  /** Envía un texto como si el usuario lo hubiera escrito en el compositor. */
  function submitComposerText(text, sendOptions) {
    elements.userInput.value = text;
    elements.userInput.dispatchEvent(new Event('input', { bubbles: true }));
    return handleSendMessage(sendOptions);
  }

  async function importConversationSession(newSession) {
    Engine.ensureConversationDate(newSession.history, newSession.createdAt);
    const result = State.importConversation(newSession, newSession.history);
    if (!result.ok) throw new Error(result.reason);
    renderSessionMessages(getChatHistory());
    await saveCurrentSession();
    await Dialogs.alert(t('chat_imported_success'), { type: 'success' });
  }

  // ==========================================================================
  // Modelos, perfiles e inspector
  // ==========================================================================

  function loadCachedModels(targetConfig) {
    const config = targetConfig || {
      apiUrl: elements.settingApiUrl.value || getRuntimeConfig().apiUrl,
      apiType: elements.settingApiType.value || getRuntimeConfig().apiType
    };
    const models = UIInspector.loadCachedModels(elements, config);
    syncPublishedModelContextLimit();
    return models;
  }

  function syncPublishedModelContextLimit() {
    const config = getRuntimeConfig();
    const publishedLimit = config.apiType === 'webllm'
      ? Number(config.webllmConfig.context_window_size) || Defaults.WEBLLM_DEFAULT_CONTEXT_WINDOW_SIZE
      : ModelCatalog.getContextLimit(config.model);
    if (!publishedLimit || config.modelContextLimit === publishedLimit) return;
    Config.updateRuntime({ modelContextLimit: publishedLimit });
  }

  async function inspectProfile(profile) {
    elements.inspectorProfileName.textContent = profile.name || '';
    elements.inspectorResults.innerHTML = '';
    if (!elements.inspectorDialog.open) elements.inspectorDialog.showModal();
    await UIInspector.handleRunInspector(elements, getRuntimeConfig(), profile);
    syncPublishedModelContextLimit();
  }

  async function saveContextLimitOverride() {
    const contextLimitOverride = UITelemetry.parseContextCapacity(elements.contextLimitOverrideInput.value);
    if (!contextLimitOverride) {
      await Dialogs.alert(t('context_limit_override_invalid'));
      return;
    }
    const activeProfile = getRuntimeConfig().activeProfile;
    const profile = activeProfile && Profiles.get(activeProfile.id);
    if (!profile) {
      await Dialogs.alert(t('context_limit_override_profile_required'));
      return;
    }
    if (profile.settings.apiKeyLocked === true) {
      await Dialogs.alert(t('err_profile_read_only'));
      return;
    }
    try {
      const savedProfile = Profiles.save({ ...profile, settings: { ...profile.settings, contextLimitOverride } });
      UIProfiles.activateConnectionProfile(savedProfile.id);
      updateConnectionTokensBadge(null, { forcePopover: true });
    } catch (error) {
      console.error('[App] Could not save the context limit override:', error);
      await Dialogs.alert(t('context_limit_override_save_error'));
    }
  }

  // ==========================================================================
  // Razonamiento y modo proyecto
  // ==========================================================================

  const isBusy = () => State.isConversationBusy();

  const projectPanelHandlers = {
    toggle(enabled) {
      Config.updateRuntime({ projectMode: Boolean(enabled) });
    },
    async decline() {
      const cwd = State.get('project').cwd;
      if (!cwd) return;
      const confirmed = await Dialogs.confirm(t('project_decline_confirm', { cwd }));
      // El servidor puede haber cambiado de directorio mientras se esperaba la respuesta.
      if (!confirmed || State.get('project').cwd !== cwd) return;
      Config.updateRuntime({ projectDeclined: [...getRuntimeConfig().projectDeclined, cwd] });
    },
    reactivate() {
      const cwd = State.get('project').cwd;
      Config.updateRuntime({ projectDeclined: getRuntimeConfig().projectDeclined.filter(path => path !== cwd) });
    },
    reload() {
      refreshProjectContext();
    },
    async changeDirectory() {
      try {
        const result = await ProjectContext.changeDirectory({
          askPath: cwd => Dialogs.prompt(t('project_directory_prompt'), cwd, { title: t('project_directory_title') }),
          isBusy
        });
        if (result?.reason === 'error') {
          await Dialogs.alert(t('project_directory_error', { error: result.error }), { type: 'error' });
        }
      } catch (error) {
        console.error('[App] Project directory change failed:', error);
        await Dialogs.alert(error?.message || String(error), { type: 'error' });
      }
    },
    async initialize() {
      try {
        await ProjectContext.initialize({
          askConfirmation: ({ cwd, rule }) => Dialogs.confirm(t('project_initialize_confirm', { cwd, dir: rule.slice(3) })),
          isBusy,
          startConversation: async () => {
            if (getChatHistory().some(message => message.role !== 'system')) await createNewSession();
          },
          sendPrompt: async prompt => {
            UIReasoning.closeReasoningMenu(elements);
            await submitComposerText(prompt);
          }
        });
      } catch (error) {
        console.error('[App] Project initialization failed:', error);
        await Dialogs.alert(error?.message || String(error), { type: 'error' });
      }
    }
  };

  function refreshProjectContext() {
    ProjectContext.refresh().catch(error => console.warn('[App] Could not refresh project context:', error));
  }

  /** El indicador del botón siempre; el panel solo con el menú abierto (renderizado bajo demanda). */
  function renderProjectPanel() {
    const config = getRuntimeConfig();
    const project = State.get('project');
    UIReasoning.syncProjectIndicator(elements, config, project);
    if (elements.reasoningMenu.hidden) return;
    UIReasoning.renderProjectPanel(elements, {
      config,
      project,
      canInitialize: ProjectContext.canInitialize(),
      canChangeDirectory: ProjectContext.canChangeDirectory(),
      busy: isBusy()
    });
  }

  // ==========================================================================
  // Preguntas del agente (ask_user)
  // ==========================================================================

  /** Solo la última pregunta, sin respuesta posterior ni generación en curso, admite elegir opción. */
  function syncAskUserCards() {
    const messages = getChatHistory();
    const last = messages[messages.length - 1];
    const pending = last?.role === 'tool' && last.name === 'ask_user' && !isBusy();
    const cards = [...elements.messagesList.querySelectorAll('.ask-user-card')];
    cards.forEach((card, index) => {
      const active = pending && index === cards.length - 1;
      card.classList.toggle('ask-user-answered', !active);
      card.querySelectorAll('[data-ask-option]').forEach(button => { button.disabled = !active; });
    });
  }

  async function handleAskUserOption(button) {
    if (button.disabled || isBusy()) return;
    const label = button.getAttribute('data-ask-option');
    if (!label) return;
    // Lo que el usuario ya hubiera escrito acompaña a la opción como aclaración.
    const typed = elements.userInput.value.trim();
    elements.messagesList.querySelectorAll('[data-ask-option]').forEach(option => { option.disabled = true; });
    await submitComposerText(typed ? `${label}\n\n${typed}` : label);
  }

  // ==========================================================================
  // Depuración, telemetría y configuración visible
  // ==========================================================================

  function syncDebugMessagesState(enabled, persist = true) {
    const value = Boolean(enabled);
    elements.chkEnableDebugMessages.checked = value;
    elements.debugMessagesStatusBadge.textContent = value ? 'ON' : 'OFF';
    elements.debugMessagesStatusBadge.className = `debug-status-pill ${value ? 'on' : 'off'}`;
    if (persist) Config.updateRuntime({ enableDebugMessages: value });
  }

  function openDebugInterceptorModal({ endpoint, payload }) {
    return Debug.openInterceptorModal({
      endpoint,
      payload,
      onSyncDebugState: enabled => syncDebugMessagesState(enabled)
    });
  }

  function applyTheme(theme) {
    UISettings.applyTheme(elements, theme);
  }

  function applyLanguage(lang) {
    UISettings.applyLanguage(elements, lang);
    UIReasoning.updateReasoningUI(elements, getRuntimeConfig().reasoningEffort);
  }

  function updateUIFromConfig() {
    const config = getRuntimeConfig();
    elements.activeProfileName.textContent = config.activeProfile?.name || '';
    if (!elements.activeProfilePopover.hidden) {
      UIProfiles.renderProfileMenu();
    }
    // El diálogo contiene un borrador de perfil. Las notificaciones de la
    // configuración activa (telemetría, caché, etc.) no deben sobrescribirlo.
    if (!elements.profilesDialog.open) {
      elements.settingApiType.value = config.apiType;
      elements.settingApiUrl.value = config.apiUrl;
      elements.settingModel.value = config.model;
      if (config.model) elements.modelSelectHelper.value = config.model;
    }
    UIReasoning.updateReasoningUI(elements, config.reasoningEffort);
    UIReasoning.syncProjectIndicator(elements, config, State.get('project'));
    applyTheme(config.theme);
    applyLanguage(config.language);
    syncDebugMessagesState(config.enableDebugMessages, false);
    updateConnectionTokensBadge(null);
  }

  function updateConnectionTokensBadge(stats, options = {}) {
    if (stats) State.set('telemetry', { stats });
    const vm = UITelemetry.computeTelemetryViewModel({
      stats: stats || State.get('telemetry').stats,
      config: getRuntimeConfig(),
      chatHistory: getChatHistory()
    });
    UITelemetry.renderTelemetry(elements, vm, options);
  }

  function resetTelemetryDisplay({ syncState = true } = {}) {
    if (syncState) State.set('telemetry', { stats: null });
    UITelemetry.resetTelemetry(elements, getRuntimeConfig(), getChatHistory());
  }

  // ==========================================================================
  // Navegación de ajustes en la barra lateral
  // ==========================================================================

  function showSidebarNav(nav) {
    elements.sidebarSettingsNav.hidden = nav !== 'settings';
    elements.sidebarEncryptionNav.hidden = nav !== 'encryption';
    elements.sidebarRagNav.hidden = nav !== 'rag';
    elements.sidebarSettingsFooter.hidden = nav !== 'settings';
    if (nav !== 'settings') UISidebar.setActiveSettingsSection(elements, '');
  }

  function openSettingsSection(sectionId = 'model') {
    if (sectionId === 'encryption' || sectionId === 'rag') {
      showSidebarNav(sectionId);
      return;
    }
    if (sectionId === 'rag-manage') {
      RagUI.openManageModal();
      return;
    }
    UISettings.openSettingsSection(elements, getRuntimeConfig(), sectionId);
    if (sectionId === 'mcp') {
      UIMcp.verifyActiveConnection().catch(error => console.warn('[App] Could not verify the MCP connection:', error));
    }
  }

  // ==========================================================================
  // Escuchadores de Eventos
  // ==========================================================================

  function updateNewTabLink() {
    elements.btnSidebarNewTab.href = location.pathname + location.search;
  }

  function setupEventListeners() {
    UIShell.mount({
      elements,
      onViewportChange: () => UIReasoning.positionReasoningMenu(elements),
      onDismissProfiles: () => UIProfiles.closeProfilesModal(false)
    });

    UIComposer.mount(elements, {
      onSendMessage: handleSendMessage,
      onStopGeneration: GenerationController.handleStopGeneration,
      getLastPrompt: () => MessageTurns.getLastUserPrompt(getChatHistory())
    });
    UICommandJobs.mount({ messagesList: elements.messagesList });
    UIConversation.mountScrollToBottomButton(elements.messagesList, elements.btnScrollBottom);

    // Parada ordenada ante cierre de página o recarga durante generación
    const stopOnUnload = () => {
      if (GenerationController.isGenerating()) GenerationController.handleStopGeneration();
    };
    window.addEventListener('beforeunload', stopOnUnload);
    window.addEventListener('pagehide', stopOnUnload);

    // Barra Lateral de Chats y navegación de configuración
    UISidebar.mount(elements, {
      onSwitchSession: switchToSession,
      onRenameSession: sessionId => ConversationService.renameSession(sessionId, getConversationServiceOptions()),
      onDeleteSession: sessionId => ConversationService.deleteSession(sessionId, getConversationServiceOptions()),
      onExportSession: sessionId => UITransfer.openExportModal(sessionId),
      onNewSession: createNewSession,
      onSearchInput: renderSidebarChats,
      onDeleteAllSessions: () => ConversationService.deleteAllSessions(getConversationServiceOptions()),
      onOpenSettingsMode: () => showSidebarNav('settings'),
      onOpenConnection: () => {
        openSettingsSection('connection');
        if (UISidebar.isMobile()) UISidebar.closeSidebar(elements);
      },
      onBackToChats: () => showSidebarNav('settings'),
      onSelectSettingsSection: sectionId => {
        openSettingsSection(sectionId);
        if (sectionId !== 'encryption' && sectionId !== 'rag' && UISidebar.isMobile()) UISidebar.closeSidebar(elements);
      }
    });
    elements.btnEncryptionBack.addEventListener('click', () => showSidebarNav('settings'));
    elements.btnEncryptionPassword.addEventListener('click', () => UIProfiles.handleEncryptionPassword());
    elements.btnEncryptionDefault.addEventListener('click', () => UIProfiles.handleUseDefaultEncryptionKey());
    elements.btnRagBack.addEventListener('click', () => showSidebarNav('settings'));
    elements.btnRagBranches.addEventListener('click', () => openSettingsSection('rag-manage'));
    elements.btnRagActivate.addEventListener('click', () => RagUI.openActivationModal());

    elements.btnSidebarNewTab.addEventListener('click', updateNewTabLink);
    elements.btnSidebarNewTab.addEventListener('pointerdown', updateNewTabLink);

    // Exportación (disparada desde cada chat en la barra lateral) e importación de conversaciones
    UITransfer.mount({
      elements,
      getActiveSessionId: getCurrentSessionId,
      getSavedSessions: () => State.get('sessions').list,
      getHistory: getChatHistory,
      getSession: id => Storage.getConversation(id),
      getConfig: getRuntimeConfig,
      onSwitchSession: switchToSession,
      onImportSuccess: importConversationSession,
      isBusy: () => ConversationService.blockSessionTransitionIfBusy('chat_import_blocked_generating')
    });

    // Razonamiento (Thinking)
    UIReasoning.mount(elements, {
      onSelectLevel: level => Config.updateRuntime({ reasoningEffort: level }),
      handlers: projectPanelHandlers
    });
    elements.btnReasoning.addEventListener('click', event => {
      event.stopPropagation();
      UIReasoning.toggleReasoningMenu(elements, getRuntimeConfig());
      renderProjectPanel();
    });
    document.addEventListener('click', event => {
      if (elements.reasoningMenu.hidden) return;
      if (!elements.reasoningMenu.contains(event.target) && !elements.btnReasoning.contains(event.target)) {
        UIReasoning.closeReasoningMenu(elements);
      }
    });

    // Panel de Debug & Logs
    elements.btnToggleDebug.addEventListener('click', () => Debug.togglePanel());
    elements.btnCloseDebug.addEventListener('click', () => Debug.togglePanel(false));
    elements.btnClearDebug.addEventListener('click', () => Debug.clearLogs());
    elements.btnCopyDebug.addEventListener('click', () => Debug.copyLogs());
    elements.debugTabs.forEach(tab => {
      tab.addEventListener('click', () => {
        elements.debugTabs.forEach(other => {
          other.classList.toggle('active', other === tab);
          other.setAttribute('aria-pressed', String(other === tab));
        });
        Debug.filterLogs(tab.getAttribute('data-debug-tab') || 'all');
      });
    });
    elements.chkEnableDebugMessages.addEventListener('change', () => syncDebugMessagesState(elements.chkEnableDebugMessages.checked));

    // Modal de Configuración & Perfiles
    UISettings.mount({
      elements,
      getRuntimeConfig,
      callbacks: {
        loadCachedModels,
        onConfigSaved: savedConfig => {
          const history = getChatHistory();
          if (history[0]?.role !== 'system') return;
          history[0].content = Engine.getConfiguredSystemPrompt(savedConfig);
          State.replaceMessages(history);
        },
        populateProfileSelector: id => UIProfiles.populateProfileSelector(id)
      }
    });
    UIProfiles.mount({
      elements,
      getRuntimeConfig,
      loadCachedModels,
      resetTelemetryDisplay,
      updateUIFromConfig,
      inspectProfile,
      closeSettingsModal: () => UISettings.closeSettingsModal(elements)
    });

    elements.btnQueryServer.addEventListener('click', async event => {
      event.preventDefault();
      if (await UIInspector.handleQueryServer(elements, getRuntimeConfig())) {
        UIProfiles.setProfileQueryState(true);
      }
    });
    elements.btnCloseInspector.addEventListener('click', () => elements.inspectorDialog.close());

    const bindPreference = (buttons, attribute, apply, key) => buttons.forEach(button => {
      button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        const value = button.getAttribute(attribute);
        apply(value);
        Config.updateRuntime({ [key]: value });
      });
    });
    bindPreference(elements.themeButtons, 'data-theme', applyTheme, 'theme');
    bindPreference(elements.langButtons, 'data-lang', applyLanguage, 'language');

    UITelemetry.mount(elements, () => updateConnectionTokensBadge(null, { forcePopover: true }));
    elements.btnSaveContextLimitOverride.addEventListener('click', saveContextLimitOverride);

    elements.messagesList.addEventListener('click', event => {
      const option = event.target.closest('[data-ask-option]');
      if (option) handleAskUserOption(option);
    });
  }

  function subscribeToState() {
    const syncGenerationControls = streaming => UIComposer.syncGenerationControls(elements, streaming.isGenerating);
    State.subscribe('streaming', syncGenerationControls);
    syncGenerationControls(State.get('streaming'));

    // El proyecto depende del servidor local: se recalcula al conectar, cambiar de cwd o de herramientas.
    State.subscribe(
      state => ({ status: state.mcp.status, cwd: state.mcp.serverInfo?.cwd || '', tools: state.mcp.tools.length }),
      refreshProjectContext
    );
    State.subscribe('project', renderProjectPanel);
    // Al terminar un turno el agente puede haber creado o actualizado los ficheros del proyecto.
    State.subscribe(state => ({ generating: state.streaming.isGenerating }), ({ generating }) => {
      if (!generating && getRuntimeConfig().projectMode === true) refreshProjectContext();
      // «Cambiar…» solo está activo sin generación en curso.
      renderProjectPanel();
    });
    // Estado inicial coherente con la configuración aunque el servidor no llegue a conectar.
    refreshProjectContext();

    // La conversación se pinta tras actualizar el estado: se sincroniza en la siguiente vuelta.
    const scheduleAskUserSync = () => setTimeout(syncAskUserCards, 0);
    State.subscribe('messages', scheduleAskUserSync);
    State.subscribe('streaming', scheduleAskUserSync);

    Config.subscribe((nextConfig, previousConfig) => {
      if (previousConfig.apiType !== nextConfig.apiType) {
        Promise.resolve(Providers.registry.get(previousConfig.apiType)?.deactivate?.())
          .catch(error => console.error('[App] Provider cleanup failed:', error));
      }
      updateUIFromConfig();
      if (nextConfig.projectMode !== previousConfig.projectMode ||
          JSON.stringify(nextConfig.projectDeclined) !== JSON.stringify(previousConfig.projectDeclined)) {
        refreshProjectContext();
      }
      renderProjectPanel();
    });
  }

  // ==========================================================================
  // Conexión con el servidor local
  // ==========================================================================

  // El fragmento se usa exclusivamente para el primer arranque desde zerochat.py.
  // Después la sesión se resuelve mediante una cookie del mismo origen.
  let runBackendSession = null;

  function persistBackendSessionFromLaunchFragment() {
    const hashParams = Utils.readLaunchFragment(location.hash);
    const token = hashParams.get('token');
    if (!token) return;
    // zerochat.py abre la página con un servidor de este equipo: el fragmento no admite otro.
    const host = hashParams.get('host');
    const port = Number(hashParams.get('port'));
    const local = ['127.0.0.1', 'localhost'].includes(host) && Number.isInteger(port) && port > 0 && port < 65536;
    const session = local ? Storage.normalizeBackendSession({ token, url: `http://${host}:${port}` }) : null;
    // El servidor de --prompt puede estar en otro puerto y termina con la ejecución: su conexión
    // queda en esta página y la cookie sigue apuntando las demás pestañas al servidor normal.
    if (hashParams.has('run')) {
      runBackendSession = session;
    } else if (session && !Storage.setBackendSession(session)) {
      console.warn('[App] Could not persist the initial backend session.');
    }
    history.replaceState(null, '', location.pathname + location.search);
  }

  /** Destino de la conexión configurada: el servidor local por defecto o el remoto, con la clave del proxy si lo usa. */
  function configuredTarget() {
    const config = getRuntimeConfig();
    if (config.localBackend) return { url: Defaults.LOCAL_BACKEND_URL, proxyKey: null };
    return { url: config.backendUrl, proxyKey: config.useProxy ? config.proxyKey : null };
  }

  /** Clave del proxy para `url`: solo si es la URL configurada y usa el proxy; si no, null. */
  function proxyKeyFor(url) {
    const target = configuredTarget();
    return url === target.url ? target.proxyKey : null;
  }

  /** Guarda la sesión: en la pestaña de una ejecución solo en memoria, para no pisar la cookie de las demás. */
  function saveBackendSession(session) {
    if (runBackendSession) runBackendSession = session;
    else if (!Storage.setBackendSession(session)) console.warn('[App] Could not persist the backend session.');
  }

  /** Conecta con el destino configurado, con el token de la sesión si es de esa URL; un 401 pide identificarse. */
  function connectConfiguredBackend() {
    const target = configuredTarget();
    const session = Storage.getBackendSession();
    const token = session?.url === target.url ? session.token : null;
    MCP.manager.setSessionToken(token);
    if (token) ToolSecurity.manager.setSessionToken(token);
    return MCP.manager.connectProxy({ ...target, token });
  }

  /** Se identifica en el destino de la conexión, guarda el token diario en la sesión y conecta con él. */
  async function loginBackend(user, password) {
    const { url, proxyKey } = MCP.manager.target;
    const token = await MCP.manager.login(user, password);
    saveBackendSession({ token, url });
    ToolSecurity.manager.setSessionToken(token);
    return MCP.manager.connectProxy({ url, proxyKey, token });
  }

  /**
   * Conecta con zerochat.py si hay sesión guardada (sin ella no sondea el equipo, para no disparar el
   * aviso de acceso a la red local del navegador); devuelve el resultado de la conexión.
   */
  function connectBackend() {
    persistBackendSessionFromLaunchFragment();
    const session = runBackendSession || Storage.getBackendSession();
    if (!session) return Promise.resolve({ success: false });
    ToolSecurity.manager.setSessionToken(session.token);
    return MCP.manager.connectProxy({ url: session.url, proxyKey: proxyKeyFor(session.url), token: session.token }).catch(error => {
      console.warn('[App] Could not connect to the local server on startup:', error);
      return { success: false };
    });
  }

  function init() {
    ensureModalsMarkup();
    cacheDomElements();
    Debug.setElements(elements);
    Debug.setRawLogsEnabled(true);
    Debug.registerGlobalErrorHandlers(window);

    subscribeToState();
    loadCachedModels();
    updateUIFromConfig();
    const sessionsLoaded = ConversationService.loadSessionsFromStorage(getConversationServiceOptions());
    setupEventListeners();
    if (UISidebar.isMobile()) UISidebar.closeSidebar(elements);

    RagUI.initRagUI();
    UIBrowser.mountBrowserUI(elements.settingsBrowser, openSettingsSection);
    UIConnection.mount({
      openButton: elements.btnOpenConnection,
      local: elements.settingLocalBackend,
      remoteFields: elements.connectionRemoteFields,
      url: elements.settingBackendUrl,
      useProxy: elements.settingUseProxy,
      proxyKeyField: elements.settingProxyKeyField,
      proxyKey: elements.settingProxyKey,
      connect: elements.btnBackendConnect,
      status: elements.backendConnectionStatus,
      error: elements.backendConnectionError,
      loginDialog: elements.loginDialog,
      loginForm: elements.loginForm,
      loginDesc: elements.loginDesc,
      loginUser: elements.loginUser,
      loginPassword: elements.loginPassword,
      loginError: elements.loginError,
      loginCancel: elements.loginCancel,
      loginSubmit: elements.loginSubmit
    }, { connect: connectConfiguredBackend, login: loginBackend });
    UIBrowser.mountProfileBrowser(elements.profileBrowser);
    UIMcp.initMcpUI({
      statusBadge: elements.mcpStatusBadge,
      statusText: elements.mcpStatusText,
      serverDetails: elements.mcpServerDetails,
      commandSnippet: elements.mcpTerminalCommand,
      btnCopyCmd: elements.btnMcpCopyCmd,
      bootstrapCard: elements.mcpBootstrapCard,
      toolsContainer: elements.mcpToolsContainer,
      serversList: elements.mcpServersList,
      savedAuthsList: elements.mcpSavedAuthsList,
      btnClearAuths: elements.btnMcpClearAuths
    });

    // Un paquete de perfiles exportado abre la página para importarlos: no arranca el chat.
    if (UIProfiles.startImportMode(elements)) return;

    // connectBackend quita el fragmento de arranque: el modo ejecución se lee antes.
    const runId = RunMode.readRunId(location.hash);
    const startupMcpConnection = connectBackend();
    // Sin latido periódico (servidor sin auto-cierre), volver a la pestaña relee el servidor local.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') MCP.manager.onPageVisible();
    });
    updateNewTabLink();
    if (runId) {
      RunMode.start(runId, {
        startupConnection: startupMcpConnection,
        connectBackend,
        sessionsLoaded,
        activateSessionProfile: profileId => UIProfiles.activateConnectionProfile(profileId, { sessionOnly: true }),
        exportConversation: async format => (await UITransfer.buildConversationExport(format)).content,
        submitComposerText,
        stopGeneration: GenerationController.handleStopGeneration
      });
    } else {
      // Registro del Service Worker para aceleración de arranque y soporte offline en móvil; el modo
      // ejecución no lo hace porque su aviso de actualización es un diálogo que la terminaría.
      registerServiceWorker().then(async reloading => {
        if (reloading) return;
        const connection = await startupMcpConnection;
        if (!connection.success) return;
        await UIProfiles.startActiveProfileServers();
        await UIMcp.offerStoppedExternalServices(State.get('mcp').externalServers);
      }).catch(error => console.warn('[App] Could not check MCP services on startup:', error));
    }

    document.documentElement.classList.add('zerochat-ready');
    console.log('💬 ZeroChat initialized with autonomous tools and local Orama knowledge.');
  }

  let serviceWorkerUpdatePrompt = null;

  function promptServiceWorkerUpdate() {
    serviceWorkerUpdatePrompt ||= (async () => {
      const accepted = await Dialogs.confirm(t('pwa_update_available'), {
        type: 'info',
        title: t('pwa_update_title'),
        acceptText: t('pwa_update_reload'),
        cancelText: t('pwa_update_later')
      });
      if (accepted) location.reload();
      return accepted;
    })();
    return serviceWorkerUpdatePrompt;
  }

  /** Registra el Service Worker; devuelve true si el usuario eligió recargar para actualizar. */
  async function registerServiceWorker() {
    if (!('serviceWorker' in navigator) || !['http:', 'https:'].includes(location.protocol)) return false;
    if (document.readyState !== 'complete') {
      await new Promise(resolve => window.addEventListener('load', resolve, { once: true }));
    }
    try {
      const registration = await navigator.serviceWorker.register('./sw.js', { scope: './' });
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) promptServiceWorkerUpdate();
        });
      });
      if (registration.waiting) return await promptServiceWorkerUpdate();
      await registration.update().catch(() => {});
      const worker = registration.installing;
      if (worker && !['installed', 'activated', 'redundant'].includes(worker.state)) {
        await new Promise(resolve => {
          worker.addEventListener('statechange', () => {
            if (['installed', 'activated', 'redundant'].includes(worker.state)) resolve();
          });
        });
      }
      if (registration.waiting || (worker?.state === 'installed' && navigator.serviceWorker.controller)) {
        return await promptServiceWorkerUpdate();
      }
      return await (serviceWorkerUpdatePrompt || false);
    } catch (_) {
      return false;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
