/**
 * Aplicación principal del cliente de chat Web (ZeroChat).
 * Arranca los módulos, reúne los elementos del DOM y cablea entre ellos los eventos de la
 * interfaz. La lógica de cada área vive en su módulo; aquí solo queda la coordinación.
 */

(function () {
  'use strict';

  const {
    ChatStorage: Storage, ChatI18n: I18n, ChatDebug: Debug, ChatState: State,
    ChatEngine: Engine, ChatDialogs: Dialogs, ChatConfig: Config,
    ChatProviders: Providers, ChatMCP: MCP,
    ChatUIProject: UIProject, ChatUIFolderPicker: UIFolderPicker, ChatMessageTurns: MessageTurns,
    ChatConversationService: ConversationService, ChatGenerationController: GenerationController,
    ChatUIReasoning: UIReasoning, ChatUIInspector: UIInspector,
    ChatUISidebar: UISidebar, ChatUISettings: UISettings, ChatUIShell: UIShell,
    ChatUITransfer: UITransfer, ChatUIProfiles: UIProfiles, ChatUIComposer: UIComposer,
    ChatUICommandJobs: UICommandJobs, ChatUIConversation: UIConversation,
    ChatUITelemetry: UITelemetry, ChatUIMcp: UIMcp, ChatUIBrowser: UIBrowser,
    ChatUIConnection: UIConnection, ChatRagUI: RagUI, ChatRunMode: RunMode,
    ChatBackendSession: BackendSession, ChatServerRun: ServerRun, ChatTabAlert: TabAlert,
    ChatProfileCheck: ProfileCheck, ChatContextManager: ContextManager
  } = window;
  const { t } = I18n;

  Config.initialize();

  const getRuntimeConfig = () => Config.getActive();
  const getChatHistory = () => State.get('messages');
  const getCurrentSessionId = () => State.get('sessions').activeId;
  // Proyectos plegados o desplegados por el usuario en el historial ("Todos"), solo en este navegador.

  const ELEMENT_IDS = {
    // Barra lateral de chats
    chatSidebar: 'chat-sidebar',
    btnToggleSidebar: 'btn-toggle-sidebar',
    btnCloseSidebar: 'btn-close-sidebar',
    btnSidebarNewTab: 'btn-sidebar-new-tab',
    btnSidebarNewChat: 'btn-sidebar-new-chat',
    btnOpenProjectFiles: 'btn-open-project-files',
    sidebarSearchInput: 'sidebar-search-input',
    sidebarProjectFilter: 'sidebar-project-filter',
    sidebarHistorySwitch: 'sidebar-history-switch',
    sidebarChatsList: 'sidebar-chats-list',
    sidebarSearchStatus: 'sidebar-search-status',
    btnImportChatFile: 'btn-import-chat-file',
    importJsonInput: 'import-json-input',
    btnSyncChats: 'btn-sync-chats',
    btnDeleteAllChats: 'btn-delete-all-chats',
    sidebarViewChat: 'sidebar-view-chat',
    sidebarViewSettings: 'sidebar-view-settings',
    btnSidebarBackToChats: 'btn-sidebar-back-to-chats',
    btnCloseSidebarSettings: 'btn-close-sidebar-settings',
    sidebarSettingsNav: 'sidebar-settings-nav',
    sidebarSettingsProjectLabel: 'sidebar-settings-project-label',
    sidebarRagNav: 'sidebar-rag-nav',
    sidebarSettingsFooter: 'sidebar-settings-footer',
    btnRagBack: 'btn-rag-back',
    btnRagBranches: 'btn-rag-branches',
    btnRagActivate: 'btn-rag-activate',
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
    activeProfileTrigger: 'active-profile-trigger',
    activeProfileName: 'active-profile-name',
    activeProfilePopover: 'active-profile-popover',
    toggleBackgroundRun: 'toggle-background-run',
    profileBackgroundHint: 'profile-background-hint',
    activeProfileList: 'active-profile-list',
    inspectorDialog: 'inspector-dialog',
    inspectorProfileName: 'inspector-profile-name',
    btnCloseInspector: 'btn-close-inspector',
    btnMenuNewProfile: 'btn-menu-new-profile',
    btnMenuCloseProfiles: 'btn-menu-close-profiles',
    // Telemetría de contexto
    connectionTokensBadge: 'connection-tokens-badge',
    connectionTokensText: 'connection-tokens-text',
    contextHubCachePill: 'context-hub-cache-pill',
    contextHubCacheVal: 'context-hub-cache-val',
    contextHubPopover: 'context-hub-popover',
    btnCloseContextPopover: 'btn-close-context-popover',
    btnCompactContext: 'btn-compact-context',
    contextProgressBar: 'context-progress-bar',
    contextMetricUsedVal: 'context-metric-used-val',
    contextMetricLimitVal: 'context-metric-limit-val',
    contextMetricFreeVal: 'context-metric-free-val',
    contextMetricStatusVal: 'context-metric-status-val',
    contextLimitSource: 'context-limit-source',
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
    welcomeProject: 'welcome-project',
    welcomeProjectText: 'welcome-project-text',
    chatForm: 'chat-form',
    userInput: 'user-input',
    btnSend: 'btn-send',
    btnStopStream: 'btn-stop-stream',
    generationStatus: 'generation-status',
    btnAttachFile: 'btn-attach-file',
    agentSupervisionNotice: 'agent-supervision-notice',
    agentSupervisionText: 'agent-supervision-text',
    attentionNotice: 'attention-notice',
    attentionNoticeText: 'attention-notice-text',
    btnDismissAttention: 'btn-dismiss-attention',
    fileInput: 'file-input',
    attachmentsContainer: 'attachments-container',
    // Razonamiento y modo proyecto
    btnReasoning: 'btn-reasoning',
    reasoningSubagentsBadge: 'reasoning-subagents-badge',
    reasoningLabel: 'reasoning-label',
    reasoningProjectLabel: 'reasoning-project-label',
    reasoningSubagentsLabel: 'reasoning-subagents-label',
    reasoningModal: 'reasoning-modal',
    reasoningIntensity: 'reasoning-intensity',
    reasoningIntensityValue: 'reasoning-intensity-value',
    btnCloseReasoning: 'btn-close-reasoning',
    chkSubagents: 'chk-subagents',
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
    settingsProjectBadge: 'settings-project-badge',
    btnCloseSettings: 'btn-close-settings',
    btnSaveSettings: 'btn-save-settings',
    btnClearAllData: 'btn-clear-all-data',
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
    webllmLocalHint: 'webllm-local-hint',
    webllmHelpLink: 'webllm-help-link',
    apiKeyHintText: 'api-key-hint-text',
    apiKeyFreeHelpLink: 'api-key-free-help-link',
    mcpDirectoryRulesProject: 'mcp-directory-rules-project',
    mcpDirectoryRules: 'mcp-directory-rules',
    mcpDirectoryRulesError: 'mcp-directory-rules-error',
    settingWebllmContextWindow: 'setting-webllm-context-window',
    settingWebllmPrefillChunk: 'setting-webllm-prefill-chunk',
    settingSystemPrompt: 'setting-system-prompt',
    settingContextWindow: 'setting-context-window',
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
    folderPickerDialog: 'folder-picker-dialog',
    folderPickerPathForm: 'folder-picker-path-form',
    folderPickerPath: 'folder-picker-path',
    folderPickerRecentSection: 'folder-picker-recent-section',
    folderPickerRecent: 'folder-picker-recent',
    folderPickerCurrent: 'folder-picker-current',
    folderPickerList: 'folder-picker-list',
    folderPickerTruncated: 'folder-picker-truncated',
    folderPickerNewToggle: 'folder-picker-new-toggle',
    folderPickerNewForm: 'folder-picker-new-form',
    folderPickerNewName: 'folder-picker-new-name',
    folderPickerError: 'folder-picker-error',
    folderPickerCancel: 'folder-picker-cancel',
    folderPickerUse: 'folder-picker-use',
    // MCP
    mcpToolsContainer: 'mcp-tools-container',
    mcpLocalToolsCard: 'mcp-local-tools-card',
    mcpLocalToolsCounter: 'mcp-local-tools-counter',
    mcpServersCard: 'mcp-servers-card',
    mcpServersCounter: 'mcp-servers-counter',
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
    UITransfer.ensureDialogMarkup();
    Debug.ensureDialogMarkup();
  }

  // ==========================================================================
  // Conversación
  // ==========================================================================

  const resetComposerInput = (text = '') => UIComposer.setPromptValue(elements, text);

  function getConversationServiceOptions() {
    return {
      renderSessionMessages,
      // Las compactaciones fuera del turno (rama resumida, Compactar) pasan por el mismo interceptor de depuración.
      openDebugInterceptorModal,
      renderSidebarChats,
      onSessionReset: () => {
        UIComposer.clearAttachedFiles(elements);
        UIReasoning.closeReasoningMenu(elements);
        Debug.clearLogs();
        Debug.setStatus('idle');
        Debug.togglePanel(false);
        resetTelemetryDisplay({ syncState: false });
      },
      onSessionSwitched: conversation => {
        // Una conversación de agente se supervisa sin cambiar el proyecto, el perfil ni el modo servidor de la pestaña.
        if (ConversationService.isAgentConversation(conversation)) return undefined;
        applySessionServerMode(conversation);
        return UIProject.followConversationProject(conversation).catch(error => console.warn('[App] Could not open the conversation project:', error));
      },
      isServerMode: () => isServerRunEnabled(),
      getProject: () => MCP.currentProject(),
      getSelectedProject: () => UISidebar.getSelectedProject(elements.sidebarProjectFilter, MCP.currentProject()),
      isAgentsHistory: () => UISidebar.isAgentsHistory(),
      openInNewTab: (sessionId = '') => window.open(buildNewTabUrl(sessionId), '_blank', 'noopener'),
      resetComposerInput: () => resetComposerInput(),
      closeMobileSidebar: () => {
        if (UISidebar.isMobile()) UISidebar.closeSidebar(elements);
      }
    };
  }

  const saveCurrentSession = overrides => ConversationService.saveCurrentSession(getConversationServiceOptions(), overrides);
  const switchToSession = sessionId => ConversationService.switchToSession(sessionId, getConversationServiceOptions());
  const createNewSession = () => ConversationService.createNewSession(getConversationServiceOptions());
  const createConversationBranch = wrapper => ConversationService.createConversationBranch(UIConversation.getMessageRef(wrapper), {
    ...getConversationServiceOptions(),
    onSummarizing: active => (active ? UIConversation.showBranchLoadingIndicator(wrapper) : UIConversation.hideBranchLoadingIndicator(wrapper))
  });

  const renderSidebarChats = () => UISidebar.renderSidebarChats(elements, State.get('sessions').list, getCurrentSessionId(), State.get('mcp').serverRuns, MCP.currentProject());

  const getActiveProfileName = () => getRuntimeConfig().activeProfile?.name || getRuntimeConfig().activeProfile?.id || '';

  // Solo el modo servidor sigue a la conversación: el perfil activo lo gobierna el selector de la pestaña.
  function applySessionServerMode(conversation) {
    if (!conversation || ConversationService.isAgentConversation(conversation)) return;
    UIProfiles.setServerMode(ServerRun.isServerConversation(conversation) && ServerRun.isAvailable());
  }

  const isServerRunEnabled = () => ServerRun.isAvailable() && UIProfiles.isServerMode();

  function syncServerRunControl() {
    if (!ServerRun.isAvailable()) {
      if (UIProfiles.isServerMode()) UIProfiles.setServerMode(false);
      else UIProfiles.syncActiveProfileTrigger();
      return;
    }
    const activeId = getCurrentSessionId();
    const session = State.get('sessions')?.list?.find(s => s.id === activeId);
    if (session) applySessionServerMode(session);
    else UIProfiles.syncActiveProfileTrigger();
  }

  const syncLiveServerRun = () => UIConversation.renderLiveServerRun(
    elements.messagesList, elements.welcomeBanner, ServerRun.getActiveRun(), State.get('mcp').focusRun
  );
  const activeAgentSession = () => {
    const session = State.get('sessions')?.list?.find(s => s.id === getCurrentSessionId());
    return ConversationService.isAgentConversation(session) ? session : null;
  };
  const isAgentServerBlocked = () => Boolean(activeAgentSession()) && !ServerRun.isAvailable();

  /**
   * Una conversación de agente es de solo lectura: el compositor solo se abre para contestar su ask_user pendiente,
   * con el servidor conectado para reanudarla allí. Los retos de herramienta se responden en su tarjeta.
   */
  const isAgentComposerLocked = () => Boolean(activeAgentSession())
    && !(ServerRun.isAvailable() && RunMode.pendingAskUserQuestion(getChatHistory()));

  function syncComposerBusyControls() {
    const agent = activeAgentSession();
    const locked = isAgentComposerLocked();
    elements.chatContainer.classList.toggle('agent-supervision', Boolean(agent));
    elements.agentSupervisionNotice.hidden = !agent;
    elements.agentSupervisionText.textContent = agent ? t('agent_supervision_notice', { agent: agent.agent }) : '';
    elements.userInput.readOnly = locked;
    elements.userInput.placeholder = locked ? t('agent_supervision_placeholder') : t('input_placeholder');
    elements.btnAttachFile.disabled = locked;
    UIComposer.syncGenerationControls(elements, ServerRun.isComposerBusy());
    if (locked) elements.btnSend.disabled = true;
  }

  function handleStopCurrentGeneration() {
    if (ServerRun.isActiveSessionRunning()) {
      ServerRun.cancelActive().catch(error => console.warn('[App] Could not cancel server run:', error));
      return;
    }
    GenerationController.handleStopGeneration();
  }

  async function handleHistoricalToolAuthorization(decision, { toolName, args }) {
    if (isBusy() || ServerRun.isActiveSessionRunning() || isAgentServerBlocked()) return;
    const decisionType = (typeof decision === 'object' && decision !== null) ? decision.decision : decision;
    const nextMessages = decisionType === 'deny'
      ? getChatHistory().map(msg => {
        if (msg.role !== 'tool') return msg;
        try {
          if (JSON.parse(msg.content || '{}')?.awaitingApproval) {
            return { ...msg, content: JSON.stringify({ success: false, error: 'Execution denied by the user.' }) };
          }
        } catch (_) { /* texto plano */ }
        return msg;
      })
      : RunMode.prepareConversationForContinuation(getChatHistory());
    State.replaceMessages(nextMessages);
    renderSessionMessages(getChatHistory());
    await saveCurrentSession();
    await handleSendMessage({ resume: true, ...(decisionType === 'deny' ? {} : { toolDecision: { toolName, args, decision } }) });
  }

  const messageCallbacks = {
    onReuse: text => resetComposerInput(text),
    onDelete: () => UIConversation.removeLastTurn({
      messagesList: elements.messagesList,
      welcomeBanner: elements.welcomeBanner,
      saveSession: saveCurrentSession,
      onReuse: text => resetComposerInput(text)
    }),
    onBranch: createConversationBranch,
    onToolAuthorization: handleHistoricalToolAuthorization
  };

  function renderSessionMessages(history) {
    UIConversation.renderSessionMessages(elements, history, {
      ...messageCallbacks,
      resetTelemetry: () => resetTelemetryDisplay(),
      updateTelemetry: () => updateConnectionTokensBadge(null, { forcePopover: true })
    });
    syncLiveServerRun();
  }

  /** Envía el compositor. Devuelve { text } o { error }. */
  function handleSendMessage(sendOptions = {}) {
    const agent = activeAgentSession();
    // Lo que se envía en una conversación de agente reanuda su ejecución en el servidor, con su perfil, nunca aquí.
    if (agent && (!ServerRun.isAvailable() || (isAgentComposerLocked() && !sendOptions.resume))) return Promise.resolve(null);
    const runOnServer = Boolean(agent) || isServerRunEnabled();
    return GenerationController.handleSendMessage({
      elements,
      appendUserMessage: (text, originalPrompt, attachedImages) => UIConversation.appendUserMessage(
        elements.messagesList, elements.welcomeBanner, { text, originalPrompt, attachedImages }, messageCallbacks),
      createAssistantMessagePlaceholder: () => UIConversation.createAssistantMessagePlaceholder(elements.messagesList, null, messageCallbacks),
      updateConnectionTokensBadge,
      openDebugInterceptorModal,
      saveCurrentSession,
      runOnServer,
      serverProfile: agent?.profileId || '',
      startServerRun: ({ conversationId, profile }) => ServerRun.start({
        conversationId,
        profile: profile || getActiveProfileName(),
        toolDecision: sendOptions.toolDecision,
        ...(!agent && getRuntimeConfig().subagents === true ? { subagents: true } : {})
      }),
      ...sendOptions
    });
  }

  /** Envía un texto como si el usuario lo hubiera escrito en el compositor. */
  function submitComposerText(text, sendOptions) {
    if (text) {
      elements.userInput.value = text;
      elements.userInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return handleSendMessage(sendOptions);
  }

  async function importConversationSession(newSession) {
    Engine.ensureConversationDate(newSession.history, newSession.createdAt);
    const result = State.importConversation(newSession, newSession.history);
    if (!result.ok) throw new Error(result.reason);
    applySessionServerMode(newSession);
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
    return UIInspector.loadCachedModels(elements, config);
  }

  async function inspectProfile(profile) {
    if (profile.id === getRuntimeConfig().activeProfile?.id) ProfileCheck.recheck();
    elements.inspectorProfileName.textContent = profile.name || '';
    elements.inspectorResults.innerHTML = '';
    if (!elements.inspectorDialog.open) elements.inspectorDialog.showModal();
    await UIInspector.handleRunInspector(elements, getRuntimeConfig(), profile);
  }

  const isBusy = () => State.isConversationBusy();
  const recheckFailedProfile = () => {
    if (State.get('ui').profileCheck.status === 'error') ProfileCheck.recheck();
  };
  const renderProjectPanel = () => UIProject.renderProjectPanel(elements);

  // ==========================================================================
  // Preguntas del agente (ask_user)
  // ==========================================================================

  /** Solo la última pregunta, sin respuesta posterior ni generación en curso, admite elegir opción. */
  function syncAskUserCards() {
    const messages = getChatHistory();
    const last = messages[messages.length - 1];
    const pending = last?.role === 'tool' && last.name === 'ask_user' && !isBusy() && !ServerRun.isActiveSessionRunning() && !isAgentServerBlocked();
    const cards = [...elements.messagesList.querySelectorAll('.ask-user-card')];
    cards.forEach((card, index) => {
      const active = pending && index === cards.length - 1;
      card.classList.toggle('ask-user-answered', !active);
      card.querySelectorAll('[data-ask-option]').forEach(button => { button.disabled = !active; });
    });
  }

  async function handleAskUserOption(button) {
    if (button.disabled || isBusy() || ServerRun.isActiveSessionRunning() || isAgentServerBlocked()) return;
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

  const openDebugInterceptorModal = ({ endpoint, payload }) => Debug.openInterceptorModal({
    endpoint, payload, onSyncDebugState: enabled => syncDebugMessagesState(enabled)
  });

  const applyTheme = theme => UISettings.applyTheme(elements, theme);

  /** Conversaciones de cualquier proyecto que necesitan atención: aviso sobre el compositor y en la pestaña. */
  const getAttentionCounts = (sessions = State.get('sessions'), mcp = State.get('mcp')) => ServerRun.attentionCounts(sessions.list, mcp.serverRuns);
  function syncAttention(counts) {
    UIComposer.renderAttentionNotice(elements, counts);
    TabAlert.setAttention({
      needsInput: counts.agentsNeedsInput + counts.chatsNeedsInput,
      error: counts.agentsError + counts.chatsError
    });
  }

  function applyLanguage(lang) {
    UISettings.applyLanguage(elements, lang);
    UIReasoning.updateReasoningUI(elements, getRuntimeConfig().reasoningEffort);
    UIReasoning.syncProjectIndicator(elements, getRuntimeConfig(), State.get('project'));
    UIProject.syncProjectFilesLink(elements);
    syncLiveServerRun();
    UIComposer.renderAttentionNotice(elements, getAttentionCounts());
  }

  function updateUIFromConfig() {
    const config = getRuntimeConfig();
    UIProfiles.syncActiveProfileTrigger();
    if (elements.activeProfilePopover.open && !elements.activeProfilePopover.hidden) {
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
    syncServerRunControl();
    applyTheme(config.theme);
    applyLanguage(config.language);
    syncComposerBusyControls();
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
    elements.sidebarRagNav.hidden = nav !== 'rag';
    elements.sidebarSettingsFooter.hidden = nav !== 'settings';
    if (nav === 'settings') UISettings.syncProjectScopeLabels(elements);
    else UISidebar.setActiveSettingsSection(elements, '');
  }

  function openSettingsSection(sectionId = 'model') {
    if (sectionId === 'rag') return showSidebarNav(sectionId);
    if (sectionId === 'rag-manage') return RagUI.openManageModal();
    UISettings.openSettingsSection(elements, getRuntimeConfig(), sectionId);
    if (sectionId === 'mcp') {
      UIMcp.verifyActiveConnection().catch(error => console.warn('[App] Could not verify the MCP connection:', error));
    }
  }

  // ==========================================================================
  // Escuchadores de Eventos
  // ==========================================================================

  const buildNewTabUrl = (sessionId = '') => {
    const params = new URLSearchParams(location.search);
    params.delete('project');
    params.delete('chat');
    const session = sessionId ? State.get('sessions').list.find(item => item.id === sessionId) : null;
    const mcp = State.get('mcp');
    const currentCwd = mcp.status === 'connected' ? mcp.serverInfo?.cwd : '';
    const project = session && !ConversationService.isAgentConversation(session) ? (session.project || '') : currentCwd;
    if (project) params.append('project', project);
    if (sessionId) params.append('chat', sessionId);
    const query = params.toString();
    return query ? `${location.pathname}?${query}` : location.pathname;
  };

  const updateNewTabLink = () => {
    elements.btnSidebarNewTab.href = buildNewTabUrl();
  };

  function setupEventListeners() {
    // Ojo de los campos de clave: muestra u oculta el texto del campo que acompaña.
    document.addEventListener('click', event => {
      const button = event.target.closest('.btn-toggle-visibility');
      const input = button?.closest('.input-password-wrapper')?.querySelector('input');
      if (!input) return;
      const reveal = input.type === 'password';
      input.type = reveal ? 'text' : 'password';
      button.setAttribute('aria-pressed', String(reveal));
    });
    UIShell.mount({
      elements,
      onDismissProfiles: () => UIProfiles.closeProfilesModal(false)
    });

    UIComposer.mount(elements, {
      onSendMessage: handleSendMessage,
      onStopGeneration: handleStopCurrentGeneration,
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
      onSwitchSession: sessionId => ConversationService.switchToSession(sessionId, { ...getConversationServiceOptions(), confirmProjectSwitch: true }),
      onRenameSession: sessionId => ConversationService.renameSession(sessionId, getConversationServiceOptions()),
      onDeleteSession: sessionId => ConversationService.deleteSession(sessionId, getConversationServiceOptions()),
      onExportSession: sessionId => UITransfer.openExportModal(sessionId),
      onNewSession: createNewSession,
      searchConversations: (query, onProgress) => Storage.searchConversations(query, { onProgress }),
      renderList: renderSidebarChats,
      onSyncSessions: () => ConversationService.loadSessionsFromStorage(getConversationServiceOptions()),
      onDeleteAllSessions: () => ConversationService.deleteAllSessions(getConversationServiceOptions()),
      onOpenSettingsMode: () => showSidebarNav('settings'),
      onOpenConnection: () => {
        openSettingsSection('connection');
        if (UISidebar.isMobile()) UISidebar.closeSidebar(elements);
      },
      onBackToChats: () => showSidebarNav('settings'),
      onSelectSettingsSection: sectionId => {
        openSettingsSection(sectionId);
        if (sectionId !== 'rag' && UISidebar.isMobile()) UISidebar.closeSidebar(elements);
      }
    });
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

    UIFolderPicker.mount({
      dialog: elements.folderPickerDialog, pathForm: elements.folderPickerPathForm, path: elements.folderPickerPath,
      recentSection: elements.folderPickerRecentSection, recent: elements.folderPickerRecent, current: elements.folderPickerCurrent,
      list: elements.folderPickerList, truncated: elements.folderPickerTruncated, newToggle: elements.folderPickerNewToggle,
      newForm: elements.folderPickerNewForm, newName: elements.folderPickerNewName, error: elements.folderPickerError,
      cancel: elements.folderPickerCancel, use: elements.folderPickerUse
    });

    // Razonamiento (Thinking)
    UIReasoning.mount(elements, {
      onSelectLevel: level => Config.updateRuntime({ reasoningEffort: level }),
      onToggleSubagents: enabled => Config.updateRuntime({ subagents: enabled }),
      handlers: UIProject.createPanelHandlers({
        elements,
        createNewSession,
        removeProjectSessions: (projectPath, deletedIds) =>
          ConversationService.removeProjectSessions(projectPath, deletedIds, getConversationServiceOptions()),
        getChatHistory,
        submitComposerText
      })
    });
    elements.btnReasoning.addEventListener('click', event => {
      event.stopPropagation();
      UIReasoning.toggleReasoningMenu(elements, getRuntimeConfig());
      renderProjectPanel();
      // Al abrirlo se releen las normas y el estado del proyecto: el panel no tiene botón de recarga.
      if (!elements.reasoningModal.hidden) UIProject.refreshProjectContext();
    });
    document.addEventListener('click', event => {
      const modal = elements.reasoningModal;
      if (!modal || modal.hidden) return;
      if (!modal.contains(event.target) && !elements.btnReasoning.contains(event.target)) {
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
      onServerModeChanged: active => {
        const activeId = getCurrentSessionId();
        const existing = State.get('sessions')?.list?.find(s => s.id === activeId);
        if (existing) {
          saveCurrentSession({ serverRun: active, profileId: getActiveProfileName() });
        }
      },
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

    // Al abrir el panel se rellena y se decide si hay turnos cerrados que compactar.
    const syncCompactButton = () => {
      elements.btnCompactContext.disabled = State.isConversationBusy() || !ContextManager.hasCompactableHistory(getChatHistory());
    };
    UITelemetry.mount(elements, () => {
      updateConnectionTokensBadge(null, { forcePopover: true });
      syncCompactButton();
    });
    elements.btnCompactContext.addEventListener('click', async () => {
      elements.btnCompactContext.disabled = true;
      if (await ConversationService.compactCurrentSession(getConversationServiceOptions())) {
        updateConnectionTokensBadge(null, { forcePopover: true });
      }
      syncCompactButton();
    });

    elements.messagesList.addEventListener('click', event => {
      const option = event.target.closest('[data-ask-option]');
      if (option) handleAskUserOption(option);
    });
  }

  function subscribeToState() {
    State.subscribe('streaming', syncComposerBusyControls);
    // Un turno terminado puede indicar que el servidor ya responde: el perfil en error se vuelve a comprobar.
    State.subscribe(state => state.streaming.isGenerating, (generating, wasGenerating) => {
      if (wasGenerating && !generating) recheckFailedProfile();
    });
    State.subscribe(state => state.sessions.activeId, () => {
      syncComposerBusyControls();
      syncLiveServerRun();
      ServerRun.refreshLiveState().catch(() => { /* sin servidor no hay ejecuciones; la espera del estado vivo lo reintenta */ });
    });
    syncComposerBusyControls();

    State.subscribe(state => state.mcp.status, syncServerRunControl);
    State.subscribe(state => state.ui.profileCheck, () => UIProfiles.syncActiveProfileTrigger());
    syncServerRunControl();

    // Lo que la ejecución va grabando se trae de SQLite: la página muestra siempre la conversación grabada.
    State.subscribe(state => state.mcp.focusRun, focusRun => {
      syncLiveServerRun();
      if (!ServerRun.hasNewerSavedSteps(focusRun) || isBusy()) return;
      ConversationService.switchToSession(focusRun.conversation_id, { ...getConversationServiceOptions(), force: true, saveCurrent: false })
        .catch(error => console.warn('[App] Could not reload the server conversation:', error));
    });

    State.subscribe(
      state => state.mcp.serverRuns,
      (serverRuns, previousRuns) => {
        const finishedIds = ServerRun.finishedRunIds(previousRuns, serverRuns);

        renderSidebarChats();
        syncComposerBusyControls();
        syncLiveServerRun();
        setTimeout(syncAskUserCards, 0);

        if (finishedIds.length === 0) return;
        const activeId = getCurrentSessionId();
        if (finishedIds.includes(activeId)) {
          // Esperar al usuario o fallar ya lo avisa el recuento de atención.
          const finishedRun = serverRuns.find(run => run.conversationId === activeId);
          if (!ServerRun.needsAttention(finishedRun?.status)) TabAlert.notifyDone();
          ConversationService.switchToSession(activeId, {
            ...getConversationServiceOptions(),
            force: true,
            saveCurrent: false
          }).catch(error => console.warn('[App] Could not reload completed server conversation:', error));
        }
        if (finishedIds.length === 1 && finishedIds[0] === activeId) return;
        ConversationService.loadSessionsFromStorage(getConversationServiceOptions());
      }
    );

    // La barra muestra las conversaciones del proyecto actual: se repinta al conectar o cambiar de proyecto.
    State.subscribe(state => ({ status: state.mcp.status, cwd: state.mcp.status === 'connected' ? state.mcp.serverInfo?.cwd || '' : '' }), () => {
      renderSidebarChats();
      updateNewTabLink();
      UISettings.syncProjectScopeLabels(elements);
      UISettings.refreshVisibleProjectSecrets(elements);
    });
    const syncSidebarSyncButton = status => { elements.btnSyncChats.hidden = status !== 'connected'; };
    State.subscribe(state => state.mcp.status, syncSidebarSyncButton);
    syncSidebarSyncButton(State.get('mcp').status);
    // Cambios en SQLite fuera de esta pestaña (p. ej. zerochat --prompt u otra pestaña) refrescan el historial.
    State.subscribe(state => state.mcp.conversationsRev, (rev, previousRev) => {
      if (rev && previousRev && rev !== previousRev) {
        ConversationService.loadSessionsFromStorage(getConversationServiceOptions());
      }
    });
    UIProject.subscribe(elements);

    // La conversación se pinta tras actualizar el estado: se sincroniza en la siguiente vuelta.
    const scheduleAskUserSync = () => setTimeout(syncAskUserCards, 0);
    State.subscribe('messages', scheduleAskUserSync);
    State.subscribe('messages', syncComposerBusyControls);
    State.subscribe(state => state.mcp.status, () => {
      syncComposerBusyControls();
      scheduleAskUserSync();
    });
    State.subscribe('streaming', scheduleAskUserSync);

    Config.subscribe((nextConfig, previousConfig) => {
      if (previousConfig.apiType !== nextConfig.apiType) {
        Promise.resolve(Providers.registry.get(previousConfig.apiType)?.deactivate?.())
          .catch(error => console.error('[App] Provider cleanup failed:', error));
      }
      updateUIFromConfig();
    });
  }

  // ==========================================================================
  // Conexión con el servidor local
  // ==========================================================================

  const backendSession = BackendSession.create({
    loadSessions: () => ConversationService.loadSessionsFromStorage(getConversationServiceOptions())
  });

  function init() {
    ensureModalsMarkup();
    cacheDomElements();
    Debug.setElements(elements);
    Debug.setRawLogsEnabled(true);
    Debug.registerGlobalErrorHandlers(window);

    subscribeToState();
    loadCachedModels();
    updateUIFromConfig();
    const initialSessionsLoad = ConversationService.loadSessionsFromStorage(getConversationServiceOptions());
    setupEventListeners();
    if (UISidebar.isMobile()) UISidebar.closeSidebar(elements);

    RagUI.initRagUI();
    UIBrowser.mountBrowserUI(elements.settingsBrowser, openSettingsSection);
    UIConnection.mount({
      openButton: elements.btnOpenConnection, local: elements.settingLocalBackend,
      remoteFields: elements.connectionRemoteFields, url: elements.settingBackendUrl,
      useProxy: elements.settingUseProxy, proxyKeyField: elements.settingProxyKeyField,
      proxyKey: elements.settingProxyKey, connect: elements.btnBackendConnect,
      status: elements.backendConnectionStatus, error: elements.backendConnectionError,
      loginDialog: elements.loginDialog, loginForm: elements.loginForm,
      loginDesc: elements.loginDesc, loginUser: elements.loginUser,
      loginPassword: elements.loginPassword, loginError: elements.loginError,
      loginCancel: elements.loginCancel, loginSubmit: elements.loginSubmit
    }, { connect: backendSession.connectConfigured, login: backendSession.login });
    UIMcp.initMcpUI({
      statusBadge: elements.mcpStatusBadge, statusText: elements.mcpStatusText,
      serverDetails: elements.mcpServerDetails, commandSnippet: elements.mcpTerminalCommand,
      btnCopyCmd: elements.btnMcpCopyCmd, bootstrapCard: elements.mcpBootstrapCard,
      serversCard: elements.mcpServersCard, serversCounter: elements.mcpServersCounter,
      localToolsCard: elements.mcpLocalToolsCard, localToolsCounter: elements.mcpLocalToolsCounter,
      toolsContainer: elements.mcpToolsContainer, serversList: elements.mcpServersList,
      savedAuthsList: elements.mcpSavedAuthsList, btnClearAuths: elements.btnMcpClearAuths
    });

    MCP.manager.setProfileSyncHandler(async serverId => {
      try {
        await MCP.manager.syncProfiles(serverId, {
          onServerChange: UIProfiles.confirmServerProfileSync
        });
        UIProfiles.renderProfileMenu();
        UIProfiles.syncActiveProfileTrigger();
      } catch (error) {
        console.warn('[App] Could not synchronize profiles with backend:', error);
      }
    });
    const launchChatId = BackendSession.parseLaunchChat(location.search);
    if (launchChatId) {
      const cleanParams = new URLSearchParams(location.search);
      cleanParams.delete('chat');
      const cleanQuery = cleanParams.toString();
      history.replaceState(null, '', `${location.pathname}${cleanQuery ? `?${cleanQuery}` : ''}${location.hash}`);
    }
    const startupMcpConnection = backendSession.connectStartup();
    if (launchChatId) {
      startupMcpConnection
        .then(result => (result?.success ? null : initialSessionsLoad))
        .then(() => ConversationService.switchToSession(launchChatId, getConversationServiceOptions()))
        .catch(error => console.warn('[App] Could not open the requested conversation:', error));
    }
    // Al volver a la pestaña se relee enseguida el estado vivo del servidor local (o se reconecta) y se vuelve a
    // comprobar el perfil si había fallado.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      MCP.manager.onPageVisible();
      recheckFailedProfile();
    });
    TabAlert.mount();
    State.subscribe(state => getAttentionCounts(state.sessions, state.mcp), syncAttention);
    syncAttention(getAttentionCounts());
    ProfileCheck.start();
    updateNewTabLink();
    // Registro del Service Worker para aceleración de arranque y soporte offline en móvil.
    registerServiceWorker().then(async reloading => {
      if (reloading) return;
      const connection = await startupMcpConnection;
      if (!connection.success) return;
      await UIMcp.reconcileProjectServices(State.get('mcp').externalServers);
    }).catch(error => console.warn('[App] Could not check MCP services on startup:', error));

    document.documentElement.classList.add('zerochat-ready');
    console.log('💬 ZeroChat initialized with autonomous tools and local Orama knowledge.');
  }

  let serviceWorkerUpdatePrompt = null;

  function promptServiceWorkerUpdate() {
    serviceWorkerUpdatePrompt ||= (async () => {
      const accepted = await Dialogs.confirm(t('pwa_update_available'), {
        type: 'info', title: t('pwa_update_title'), acceptText: t('pwa_update_reload'), cancelText: t('pwa_update_later')
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
    const isSettled = w => ['installed', 'activated', 'redundant'].includes(w.state);
    try {
      const registration = await navigator.serviceWorker.register('./sw.js', { scope: './' });
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) promptServiceWorkerUpdate();
        });
      });
      if (registration.waiting) return await promptServiceWorkerUpdate();
      await registration.update().catch(() => { /* sin red se sigue con la versión instalada */ });
      const worker = registration.installing;
      if (worker && !isSettled(worker)) {
        await new Promise(resolve => worker.addEventListener('statechange', () => { if (isSettled(worker)) resolve(); }));
      }
      if (registration.waiting || (worker?.state === 'installed' && navigator.serviceWorker.controller)) {
        return await promptServiceWorkerUpdate();
      }
      return await (serviceWorkerUpdatePrompt || false);
    } catch (_) {
      return false;
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
