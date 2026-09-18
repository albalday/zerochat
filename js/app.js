/**
 * Aplicación principal del cliente de chat Web (ZeroChat).
 * Desarrollo 100% asistido por IA: colaboración entre Codex y Antigravity para implementar
 * un motor RAG local funcional utilizando la librería externa Orama como vendor autónomo,
 * iterando e implementando sin tocar una sola línea de código manual por parte del usuario.
 * Incluye:
 * - Soporte Multi-idioma (Castellano / Inglés) con autodetección por navegador y persistencia.
 * - Selector de nivel de razonamiento (Thinking/CoT) con detección automática de capacidades del modelo.
 * - Nuevo chat abriendo en una nueva pestaña.
 * - Estadísticas y acciones agrupadas en la misma línea debajo de la respuesta.
 * - Borrado de preguntas y respuestas individuales.
 * - Copia de respuesta completa al portapapeles.
 * - Estadísticas en tiempo real (tokens, tiempo, tokens/segundo).
 * - Adjuntar archivos de texto y código con vista previa y arrastrar/soltar.
 * - Compatibilidad total con file:// y http://.
 */

(function () {
  'use strict';

  // Módulos globales
  const Utils = window.ChatUtils || {};
  const Storage = window.ChatStorage || {};
  const Markdown = window.ChatMarkdown || {};
  const API = window.ChatAPI || {};
  const FileParser = window.ChatFileParser || {};
  const Sandbox = window.ChatSandbox || {};
  const Charts = window.ChatCharts || {};
  const WebBrowser = window.ChatWebBrowser || {};
  const WebSearch = window.ChatWebSearch || {};
  const I18n = window.ChatI18n || {};
  const Debug = window.ChatDebug || {};
  const ToolCards = window.ChatToolCards || {};
  const Attachments = window.ChatAttachments || {};
  const Export = window.ChatExport || {};
  const ProfileBackup = window.ChatProfileBackup || {};
  const State = window.ChatState || {};
  const ContextManager = window.ChatContextManager || {};
  const AgentCore = window.ChatAgentCore || {};
  const Engine = window.ChatEngine || {};
  const UIReasoning = window.ChatUIReasoning || {};
  const GenerationStatus = window.ChatUIGenerationStatus || {};
  const UIInspector = window.ChatUIInspector || {};
  const UISidebar = window.ChatUISidebar || {};
  const UISettings = window.ChatUISettings || {};
  const Config = window.ChatConfig;
  const Profiles = window.ChatProfileRepository || {};
  const Providers = window.ChatProviders || {};
  const UIShell = window.ChatUIShell || {};
  const UITransfer = window.ChatUITransfer || {};
  const UIProfiles = window.ChatUIProfiles || {};
  const UIComposer = window.ChatUIComposer || {};
  const ConversationService = window.ChatConversationService || {};
  const UIConversation = window.ChatUIConversation || {};
  const GenerationController = window.ChatGenerationController || {};

  function t(key, params) {
    if (I18n.t) return I18n.t(key, params);
    return key;
  }

  function getMsgIcon(name, size = 12) {
    if (typeof window !== 'undefined' && window.ChatIcons && window.ChatIcons.has(name)) {
      return window.ChatIcons.get(name, { size });
    }
    try {
      const icons = require('./icons.js');
      if (icons && icons.has(name)) return icons.get(name, { size });
    } catch (_) {}
    return '';
  }

  if (typeof Config?.initialize !== 'function' || typeof Config?.getActive !== 'function') {
    throw new Error('ZeroChat requires ChatConfig before application startup.');
  }

  try {
    Config.initialize();
  } catch (error) {
    console.warn('Error durante la inicialización de configuración:', error);
  }

  function getRuntimeConfig() {
    return Config.getActive();
  }

  // Transitional read-through facade for legacy helpers inside this module.
  // It owns no data: every read is resolved from the canonical runtime store.
  const appConfig = new Proxy({}, {
    get: (_target, key) => getRuntimeConfig()[key],
    ownKeys: () => Reflect.ownKeys(getRuntimeConfig()),
    getOwnPropertyDescriptor: (_target, key) => ({ enumerable: true, configurable: true, value: getRuntimeConfig()[key] })
  });

  function getChatHistory() {
    return State.get ? (State.get('messages') || []) : [];
  }

  function getCurrentSessionId() {
    return State.get ? (State.get('sessions')?.activeId || '') : '';
  }

  function getSavedSessions() {
    return State.get ? (State.get('sessions')?.list || []) : [];
  }

  // Referencias al DOM
  let elements = {};

  function cacheDomElements() {
    elements = {
      // Barra lateral de chats
      chatSidebar: document.getElementById('chat-sidebar'),
      btnToggleSidebar: document.getElementById('btn-toggle-sidebar'),
      btnCloseSidebar: document.getElementById('btn-close-sidebar'),
      btnSidebarNewTab: document.getElementById('btn-sidebar-new-tab'),
      btnSidebarNewChat: document.getElementById('btn-sidebar-new-chat'),
      sidebarSearchInput: document.getElementById('sidebar-search-input'),
      sidebarChatsList: document.getElementById('sidebar-chats-list'),
      btnImportChatFile: document.getElementById('btn-import-chat-file'),
      importJsonInput: document.getElementById('import-json-input'),
      btnDeleteAllChats: document.getElementById('btn-delete-all-chats'),

      // Modal de exportación
      exportModal: document.getElementById('export-modal'),
      btnCloseExport: document.getElementById('btn-close-export'),
      btnCancelExport: document.getElementById('btn-cancel-export'),
      btnExportMarkdown: document.getElementById('btn-export-markdown'),
      btnExportJson: document.getElementById('btn-export-json'),
      btnExportPrint: document.getElementById('btn-export-print'),

      activeProfileMenu: document.getElementById('active-profile-menu'),
      activeProfileTrigger: document.getElementById('active-profile-trigger'),
      activeProfileName: document.getElementById('active-profile-name'),
      activeProfilePopover: document.getElementById('active-profile-popover'),
      activeProfileList: document.getElementById('active-profile-list'),
      btnEditProfiles: document.getElementById('btn-edit-profiles'),
      connectionTokensBadge: document.getElementById('connection-tokens-badge'),
      connectionTokensText: document.getElementById('connection-tokens-text'),
      contextHubCachePill: document.getElementById('context-hub-cache-pill'),
      contextHubCacheVal: document.getElementById('context-hub-cache-val'),
      contextHubPopover: document.getElementById('context-hub-popover'),
      btnCloseContextPopover: document.getElementById('btn-close-context-popover'),
      contextProgressBar: document.getElementById('context-progress-bar'),
      contextMetricUsedVal: document.getElementById('context-metric-used-val'),
      contextMetricLimitVal: document.getElementById('context-metric-limit-val'),
      contextMetricFreeVal: document.getElementById('context-metric-free-val'),
      contextMetricStatusVal: document.getElementById('context-metric-status-val'),
      contextLimitSource: document.getElementById('context-limit-source'),
      contextLimitOverrideInput: document.getElementById('context-limit-override-input'),
      btnSaveContextLimitOverride: document.getElementById('btn-save-context-limit-override'),
      contextMetricCachedReadVal: document.getElementById('context-metric-cached-read-val'),
      contextMetricCachedWriteVal: document.getElementById('context-metric-cached-write-val'),
      contextMetricTurnPromptVal: document.getElementById('context-metric-turn-prompt-val'),
      contextMetricTurnCompletionVal: document.getElementById('context-metric-turn-completion-val'),
      contextMetricTurnSpeedVal: document.getElementById('context-metric-turn-speed-val'),
      contextMetricTurnLatencyVal: document.getElementById('context-metric-turn-latency-val'),
      btnOpenSettings: document.getElementById('btn-open-settings'),
      messagesList: document.getElementById('messages-list'),
      welcomeBanner: document.getElementById('welcome-banner'),
      chatForm: document.getElementById('chat-form'),
      userInput: document.getElementById('user-input'),
      btnSend: document.getElementById('btn-send'),
      btnStopStream: document.getElementById('btn-stop-stream'),
      generationStatus: document.getElementById('generation-status'),
      btnComposerTools: document.getElementById('btn-composer-tools'),
      btnComposerMcp: document.getElementById('btn-composer-mcp'),

      // Razonamiento (Thinking)
      btnReasoning: document.getElementById('btn-reasoning'),
      reasoningLabel: document.getElementById('reasoning-label'),
      reasoningMenu: document.getElementById('reasoning-menu'),
      reasoningOptionsContainer: document.getElementById('reasoning-options-container'),
      reasoningModelBadge: document.getElementById('reasoning-model-badge'),
      chkReasoningAgentCheckpoint: document.getElementById('chk-reasoning-agent-checkpoint'),

      // Panel de Debug & Logs
      btnToggleDebug: document.getElementById('btn-toggle-debug'),
      debugPanel: document.getElementById('debug-panel'),
      debugStatusIndicator: document.getElementById('debug-status-indicator'),
      btnCopyDebug: document.getElementById('btn-copy-debug'),
      btnClearDebug: document.getElementById('btn-clear-debug'),
      btnToggleAutoscroll: document.getElementById('btn-toggle-autoscroll'),
      btnCloseDebug: document.getElementById('btn-close-debug'),
      debugLogContent: document.getElementById('debug-log-content'),
      debugTabs: document.querySelectorAll('.debug-tab'),
      chkEnableDebugMessages: document.getElementById('chk-enable-debug-messages'),
      debugMessagesStatusBadge: document.getElementById('debug-messages-status-badge'),
      chkEnableRaw: document.getElementById('chk-enable-raw'),
      rawStatusBadge: document.getElementById('raw-status-badge'),

      // Modal de Depuración de Mensajes Salientes (Interceptor)
      debugInterceptorDialog: document.getElementById('debug-interceptor-dialog'),
      btnMaximizeDebugModal: document.getElementById('btn-maximize-debug-modal'),
      btnCloseDebugModal: document.getElementById('btn-close-debug-modal'),
      debugModalEndpointBadge: document.getElementById('debug-modal-endpoint-badge'),
      btnFormatDebugJson: document.getElementById('btn-format-debug-json'),
      btnCopyDebugJson: document.getElementById('btn-copy-debug-json'),
      txtDebugPayload: document.getElementById('txt-debug-payload'),
      debugJsonError: document.getElementById('debug-json-error'),
      btnDebugCancel: document.getElementById('btn-debug-cancel'),
      btnDebugSendDisable: document.getElementById('btn-debug-send-disable'),
      btnDebugSend: document.getElementById('btn-debug-send'),

      // Adjuntos
      btnAttachFile: document.getElementById('btn-attach-file'),
      fileInput: document.getElementById('file-input'),
      attachmentsContainer: document.getElementById('attachments-container'),

      // Ayuda y documentación
      welcomeHelpLink: document.getElementById('welcome-help-link'),

      // Información sobre ejecución y almacenamiento
      btnOpenExecutionInfo: document.getElementById('btn-open-execution-info'),
      executionInfoDialog: document.getElementById('execution-info-dialog'),
      executionStorageScope: document.getElementById('execution-storage-scope'),
      btnCloseExecutionInfo: document.getElementById('btn-close-execution-info'),
      btnCloseExecutionInfoFooter: document.getElementById('btn-close-execution-info-footer'),

      // Modal de Configuración
      settingsDialog: document.getElementById('settings-dialog'),
      settingsActiveProfileName: document.getElementById('settings-active-profile-name'),
      settingsForm: document.getElementById('settings-form'),
      btnCloseSettings: document.getElementById('btn-close-settings'),
      btnCancelSettings: document.getElementById('btn-cancel-settings'),
      btnResetSettings: document.getElementById('btn-reset-settings'),
      btnClearAllData: document.getElementById('btn-clear-all-data'),
      btnToggleKey: document.getElementById('btn-toggle-key'),
      profilesDialog: document.getElementById('profiles-dialog'),
      profilesForm: document.getElementById('profiles-form'),
      btnManageProfiles: document.getElementById('btn-manage-profiles'),
      btnCloseProfiles: document.getElementById('btn-close-profiles'),
      btnCancelProfiles: document.getElementById('btn-cancel-profiles'),
      settingProfileName: document.getElementById('setting-profile-name'),
      settingProfileDescription: document.getElementById('setting-profile-description'),
      profileSelectHelper: document.getElementById('profile-select-helper'),
      profileDatalist: document.getElementById('profile-datalist'),
      profileTabs: document.querySelectorAll('#profiles-dialog [data-profile-tab]'),
      profilePanes: document.querySelectorAll('#profiles-dialog .modal-tab-pane'),
      btnNewProfile: document.getElementById('btn-new-profile'),
      btnExportProfiles: document.getElementById('btn-export-profiles'),
      btnImportProfiles: document.getElementById('btn-import-profiles'),
      profilesImportInput: document.getElementById('profiles-import-input'),
      btnSaveProfile: document.getElementById('btn-save-profile'),
      btnDeleteProfile: document.getElementById('btn-delete-profile'),
      profileActionFeedback: document.getElementById('profile-action-feedback'),
      profileSaveQueryHint: document.getElementById('profile-save-query-hint'),
      settingApiType: document.getElementById('setting-api-type'),
      settingApiUrl: document.getElementById('setting-api-url'),
      btnQueryServer: document.getElementById('btn-query-server'),
      serverQueryStatus: document.getElementById('server-query-status'),
      settingApiKey: document.getElementById('setting-api-key'),
      settingApiKeyLocked: document.getElementById('setting-api-key-locked'),
      apiKeyLockControl: document.getElementById('api-key-lock-control'),
      apiKeyLockedStatus: document.getElementById('api-key-locked-status'),
      settingModel: document.getElementById('setting-model'),
      modelDatalist: document.getElementById('model-datalist'),
      modelSelectHelper: document.getElementById('model-select-helper'),
      btnWebllmParams: document.getElementById('btn-webllm-params'),
      webllmParamsPanel: document.getElementById('webllm-params-panel'),
      settingWebllmContextWindow: document.getElementById('setting-webllm-context-window'),
      settingWebllmPrefillChunk: document.getElementById('setting-webllm-prefill-chunk'),
      settingSystemPrompt: document.getElementById('setting-system-prompt'),
      settingSystemDataPrompt: document.getElementById('setting-system-data-prompt'),
      settingTemperature: document.getElementById('setting-temperature'),
      temperatureVal: document.getElementById('temperature-val'),
      settingMaxAgentTurns: document.getElementById('setting-max-agent-turns'),
      maxAgentTurnsVal: document.getElementById('max-agent-turns-val'),
      themeButtons: document.querySelectorAll('.btn-theme-toggle'),
      langButtons: document.querySelectorAll('.btn-lang-toggle'),
      modalTabs: document.querySelectorAll('#settings-dialog .modal-tabs-nav .modal-tab-btn'),
      modalPanes: document.querySelectorAll('#settings-dialog .modal-tab-pane'),
      btnRunInspector: document.getElementById('btn-run-inspector'),
      inspectorResults: document.getElementById('inspector-results'),
      agentToolsContainer: document.getElementById('agent-tools-container'),
      mcpToolsContainer: document.getElementById('mcp-tools-container'),
      mcpServersList: document.getElementById('mcp-servers-list'),
      settingEnableRawLogs: document.getElementById('setting-enable-raw-logs'),
      mcpStatusBadge: document.getElementById('mcp-status-badge'),
      mcpStatusText: document.getElementById('mcp-status-text'),
      btnMcpConnect: document.getElementById('btn-mcp-connect'),
      btnMcpDisconnect: document.getElementById('btn-mcp-disconnect'),
      mcpServerDetails: document.getElementById('mcp-server-details'),
      mcpErrorMessage: document.getElementById('mcp-error-message'),
      mcpHostInput: document.getElementById('mcp-host-input'),
      mcpPortInput: document.getElementById('mcp-port-input'),
      mcpEndpointPreview: document.getElementById('mcp-endpoint-preview'),
      mcpTerminalCommand: document.getElementById('mcp-terminal-command'),
      btnMcpCopyCmd: document.getElementById('btn-mcp-copy-cmd'),
      btnMcpConfigure: document.getElementById('btn-mcp-configure'),
      mcpSetupDialog: document.getElementById('mcp-setup-dialog'),
      btnCloseMcpSetup: document.getElementById('btn-close-mcp-setup'),
      btnCloseMcpSetupFooter: document.getElementById('btn-close-mcp-setup-footer'),
      // Fase 7: backdrop para drawer en móvil
      sidebarBackdrop: document.getElementById('sidebar-backdrop'),
    };
  }

  function getConfiguredSystemPrompt(config = appConfig) {
    if (Engine.getConfiguredSystemPrompt) return Engine.getConfiguredSystemPrompt(config);
    return [config.systemPrompt, config.systemDataPrompt].map(value => String(value || '').trim()).filter(Boolean).join('\n\n');
  }

  function isHttpExecution() {
    if (UIShell.isHttpExecution) return UIShell.isHttpExecution();
    return typeof window !== 'undefined' && ['http:', 'https:'].includes(window.location.protocol);
  }

  function updateExecutionInfo() {
    if (UIShell.updateExecutionInfo) return UIShell.updateExecutionInfo(elements);
    const httpExecution = isHttpExecution();
    if (elements.executionStorageScope) {
      elements.executionStorageScope.textContent = t(httpExecution ? 'execution_info_http' : 'execution_info_file');
    }
  }

  function openExecutionInfo() {
    if (UIShell.openExecutionInfo) return UIShell.openExecutionInfo(elements);
    if (!elements.executionInfoDialog) return;
    updateExecutionInfo();
    if (!elements.executionInfoDialog.open) elements.executionInfoDialog.showModal();
  }

  function closeExecutionInfo() {
    if (UIShell.closeExecutionInfo) return UIShell.closeExecutionInfo(elements);
    if (elements.executionInfoDialog?.open) elements.executionInfoDialog.close();
  }



  function applyTheme(theme) {
    if (UISettings.applyTheme) {
      UISettings.applyTheme(elements, appConfig, theme);
    }
  }

  function applyLanguage(lang) {
    if (UISettings.applyLanguage) {
      UISettings.applyLanguage(elements, appConfig, lang, { updateReasoningUI });
    }
  }

  function getConversationServiceOptions() {
    return {
      storage: Storage,
      getRuntimeConfig,
      language: appConfig.language || 'es',
      getConfiguredSystemPrompt: (cfg) => getConfiguredSystemPrompt(cfg),
      getChatHistory,
      getCurrentSessionId,
      getSavedSessions,
      renderSessionMessages: (history) => renderSessionMessages(history),
      renderSidebarChats: () => renderSidebarChats(),
      onSessionReset: () => {
        clearAttachedFiles();
        closeReasoningMenu();
        clearDebugLogs();
        setDebugStatus('idle');
        toggleDebugPanel(false);
        resetTelemetryDisplay({ syncState: false });
      },
      resetComposerInput: () => {
        if (elements.userInput) {
          elements.userInput.value = '';
          autoResizeTextarea();
          elements.userInput.focus();
        }
      },
      closeSidebar: () => closeSidebar()
    };
  }




  function blockSessionTransitionIfBusy(messageKey) {
    if (ConversationService.blockSessionTransitionIfBusy) {
      return ConversationService.blockSessionTransitionIfBusy(messageKey);
    }
    const isBusy = State.isConversationBusy?.() === true;
    if (!isBusy) return false;
    ChatDialogs.alert(t(messageKey));
    return true;
  }

  // ==========================================================================
  // Modelos y Consulta al Servidor (API Query & Combobox)
  // ==========================================================================

  function loadCachedModels(targetConfig) {
    if (UIInspector.loadCachedModels) {
      const config = targetConfig || {
        apiUrl: elements.settingApiUrl?.value || appConfig?.apiUrl,
        apiType: elements.settingApiType?.value || appConfig?.apiType
      };
      const models = UIInspector.loadCachedModels(elements, config);
      syncPublishedModelContextLimit();
      return models;
    }
    return [];
  }

  function syncPublishedModelContextLimit() {
    const config = getRuntimeConfig();
    let publishedLimit = null;
    if (config.apiType === 'webllm') {
      const customSize = Number(config.webllmConfig?.context_window_size);
      if (Number.isFinite(customSize) && customSize > 0) {
        publishedLimit = Math.floor(customSize);
      } else {
        publishedLimit = UIInspector.getModelContextLimit?.(config.model) || 4096;
      }
    } else {
      publishedLimit = UIInspector.getModelContextLimit?.(config.model);
    }
    if (!publishedLimit || config.modelContextLimit === publishedLimit || !Config.updateRuntime) return false;
    Config.updateRuntime({ modelContextLimit: publishedLimit });
    return true;
  }

  async function handleQueryServer() {
    if (UIInspector.handleQueryServer) {
      const querySucceeded = await UIInspector.handleQueryServer(elements, appConfig);
      if (querySucceeded) {
        setProfileQueryState(true);
      }
      return querySucceeded;
    }
    return false;
  }

  // ==========================================================================
  // Provider Inspector (Diagnóstico de Capacidades)
  // ==========================================================================

  async function handleRunInspector() {
    if (UIInspector.handleRunInspector) {
      await UIInspector.handleRunInspector(elements, appConfig);
    }
  }

  // ==========================================================================
  // Control Dinámico de Nivel de Razonamiento (Thinking / CoT)
  // ==========================================================================

  function positionReasoningMenu() {
    if (UIReasoning.positionReasoningMenu) {
      UIReasoning.positionReasoningMenu(elements);
    }
  }

  function toggleCheckpointAgent(enabled) {
    const currentTools = (appConfig && appConfig.enabledTools) ? appConfig.enabledTools : {};
    const updatedTools = { ...currentTools, agent_checkpoint: Boolean(enabled) };
    if (Config.updateRuntime) {
      Config.updateRuntime({ enabledTools: updatedTools });
    }
  }

  function toggleReasoningMenu() {
    if (UIReasoning.toggleReasoningMenu) {
      UIReasoning.toggleReasoningMenu(elements, appConfig, selectReasoningLevel, toggleCheckpointAgent, selectReasoningTransport);
    }
  }

  function selectReasoningLevel(level) {
    if (UIReasoning.selectReasoningLevel) {
      UIReasoning.selectReasoningLevel(elements, getRuntimeConfig(), level, (reasoningEffort) => {
        if (Config.updateRuntime) Config.updateRuntime({ reasoningEffort });
      });
    }
  }

  function selectReasoningTransport(reasoningTransport) {
    if (Config.updateRuntime) Config.updateRuntime({ reasoningTransport });
    closeReasoningMenu();
  }

  function updateReasoningUI(level) {
    if (UIReasoning.updateReasoningUI) {
      UIReasoning.updateReasoningUI(elements, level);
    }
  }

  function closeReasoningMenu() {
    if (UIReasoning.closeReasoningMenu) {
      UIReasoning.closeReasoningMenu(elements);
    }
  }

  // ==========================================================================
  // ==========================================================================
  // Panel Lateral de Razonamiento, Streaming & Logs (Debug)
  // ==========================================================================

  function toggleDebugPanel(forceOpen) {
    if (Debug.togglePanel) Debug.togglePanel(forceOpen);
  }

  function setDebugStatus(status, text) {
    if (Debug.setStatus) Debug.setStatus(status, text);
  }

  function clearDebugLogs() {
    if (Debug.clearLogs) Debug.clearLogs();
  }

  async function copyDebugLogs() {
    if (Debug.copyLogs) await Debug.copyLogs();
  }

  function addDebugLog(type, text, rawData) {
    if (Debug.addLog) Debug.addLog(type, text, rawData);
  }

  function setGenerationStatus(update = {}) {
    const genStatus = window.ChatUIGenerationStatus || GenerationStatus;
    if (genStatus?.setStatus) {
      return genStatus.setStatus(elements.generationStatus, update);
    }
    const raw = typeof update === 'string' ? { text: update } : (update || {});
    const isGenerating = Boolean(State.get?.('streaming')?.isGenerating);
    const phase = String(raw.phase || (raw.text || raw.message ? 'custom' : 'idle'));
    if (!isGenerating && phase !== 'idle') return;

    let next;
    if (State.setGenerationStatus) {
      next = State.setGenerationStatus(raw);
    } else {
      const ui = State.get?.('ui') || {};
      const current = ui.generationStatus || { phase: 'idle', percent: null, startedAt: null };
      const phaseChanged = phase !== current.phase;
      next = phaseChanged
        ? { text: '', message: '', detail: '', percent: null, ...raw, phase, startedAt: Date.now() }
        : { ...current, ...raw, phase, startedAt: current.startedAt || Date.now() };
      State.set('ui', { ...ui, generationStatus: next });
    }
    genStatus.render?.(elements.generationStatus, next);
  }

  function clearGenerationStatus() {
    const genStatus = window.ChatUIGenerationStatus || GenerationStatus;
    if (genStatus?.clearStatus) {
      return genStatus.clearStatus(elements.generationStatus);
    }
    if (State.clearGenerationStatus) {
      State.clearGenerationStatus();
    } else {
      const ui = State.get?.('ui') || {};
      State.set('ui', { ...ui, generationStatus: { phase: 'idle', percent: null, text: '', message: '', detail: '', startedAt: null } });
    }
    genStatus.render?.(elements.generationStatus, { phase: 'idle' });
  }

  function filterDebugLogs(tabId) {
    if (Debug.filterLogs) Debug.filterLogs(tabId);
  }

  function syncDebugMessagesState(enabled, persist = true) {
    const value = Boolean(enabled);
    if (elements.chkEnableDebugMessages) {
      elements.chkEnableDebugMessages.checked = value;
    }
    if (elements.debugMessagesStatusBadge) {
      elements.debugMessagesStatusBadge.textContent = value ? 'ON' : 'OFF';
      elements.debugMessagesStatusBadge.className = 'debug-status-pill ' + (value ? 'on' : 'off');
    }
    if (persist && Config.updateGeneral) Config.updateGeneral({ enableDebugMessages: value });
  }

  function openDebugInterceptorModal({ endpoint, headers, payload }) {
    if (Debug.openInterceptorModal) {
      return Debug.openInterceptorModal({
        endpoint,
        headers,
        payload,
        onSyncDebugState: (enabled) => syncDebugMessagesState(enabled)
      });
    }
    return Promise.resolve({ cancel: false, modifiedPayload: null });
  }

  function updateUIFromConfig() {
    const config = getRuntimeConfig();
    // El diálogo contiene un borrador de perfil. Las notificaciones de la
    // configuración activa (telemetría, caché, etc.) no deben sobrescribirlo.
    const profileEditorOpen = elements.profilesDialog?.open === true;
    if (elements.activeProfileName) elements.activeProfileName.textContent = config.activeProfile?.name || 'Espejo';
    if (elements.activeProfilePopover && !elements.activeProfilePopover.hidden) {
      let profileList = [];
      try { profileList = Profiles.list ? Profiles.list() : []; } catch (_) {}
      UISettings.renderProfileMenu(elements, profileList, config.activeProfile?.id);
    }
    if (elements.settingsActiveProfileName) {
      let mirrorName = 'Espejo';
      try { mirrorName = Profiles.get?.(Profiles.READONLY_PROFILE_ID)?.name || 'Espejo'; } catch (_) {}
      elements.settingsActiveProfileName.textContent = config.activeProfile?.name || mirrorName;
    }
    if (!profileEditorOpen) {
      if (elements.settingApiType) {
        elements.settingApiType.value = config.apiType || 'openai';
      }
      if (elements.settingApiUrl) {
        elements.settingApiUrl.value = config.apiUrl || 'http://localhost:1234/v1';
      }
      if (elements.settingModel) {
        elements.settingModel.value = config.model || '';
      }
      if (elements.modelSelectHelper && config.model) {
        elements.modelSelectHelper.value = config.model;
      }
    }
    updateReasoningUI(config.reasoningEffort || 'none');
    applyTheme(config.theme || 'light');
    applyLanguage(config.language || 'es');

    const isRawEnabled = config.enableRawLogs === true;
    if (elements.chkEnableRaw) {
      elements.chkEnableRaw.checked = isRawEnabled;
    }
    if (elements.rawStatusBadge) {
      elements.rawStatusBadge.className = isRawEnabled ? 'raw-status-badge active' : 'raw-status-badge';
      elements.rawStatusBadge.textContent = isRawEnabled ? t('raw_status_active') : t('raw_status_inactive');
    }
    if (elements.settingEnableRawLogs) {
      elements.settingEnableRawLogs.checked = isRawEnabled;
    }

    syncDebugMessagesState(config.enableDebugMessages, false);
    updateConnectionTokensBadge(null);
  }

  function getUITelemetry() {
    return window.ChatUITelemetry || (typeof require !== 'undefined' ? (() => { try { return require('./ui-telemetry.js'); } catch (e) { return null; } })() : null);
  }

  function updateConnectionTokensBadge(stats, diagnostics, options = {}) {
    const UITel = getUITelemetry();
    if (!UITel || !elements.connectionTokensBadge) return;

    if (stats) {
      State.set('telemetry', prev => ({ ...(prev || {}), stats }));
    }
    if (diagnostics) {
      State.set('telemetry', prev => ({ ...(prev || {}), diagnostics }));
    }

    const telState = State.get ? State.get('telemetry') : {};
    const effectiveStats = stats || telState?.stats || null;
    const effectiveDiag = diagnostics || telState?.diagnostics || null;

    const runtimeCfg = (State.get ? State.get('config') : (window.ChatConfig ? window.ChatConfig.getConfig() : {})) || appConfig;
    const CM = window.ChatContextManager || (typeof require !== 'undefined' ? (() => { try { return require('./context-manager.js'); } catch (e) { return null; } })() : null);

    const vm = UITel.computeTelemetryViewModel({
      stats: effectiveStats,
      diagnostics: effectiveDiag,
      config: runtimeCfg,
      chatHistory: getChatHistory(),
      contextManager: CM
    });

    UITel.renderTelemetry(elements, vm, options, t);
  }

  function resetTelemetryDisplay({ syncState = true } = {}) {
    const UITel = getUITelemetry();
    if (syncState && State.set) {
      State.set('telemetry', { stats: null, diagnostics: null, lastTurnStats: null });
    }
    if (UITel && elements.connectionTokensBadge) {
      const runtimeCfg = (State.get ? State.get('config') : (window.ChatConfig ? window.ChatConfig.getConfig() : {})) || appConfig;
      const CM = window.ChatContextManager || (typeof require !== 'undefined' ? (() => { try { return require('./context-manager.js'); } catch (e) { return null; } })() : null);
      UITel.resetTelemetry(elements, runtimeCfg, getChatHistory(), CM, t);
    }
  }

  // field-sizing:content gestiona el auto-resize en CSS (Baseline 2024).
  // Esta función solo actúa como fallback para navegadores sin soporte.
  function autoResizeTextarea() {
    if (UIComposer.autoResizeTextarea) {
      return UIComposer.autoResizeTextarea(elements);
    }
    if (CSS && CSS.supports && CSS.supports('field-sizing', 'content')) return;
    if (!elements.userInput) return;
    if (!elements.userInput.value) {
      elements.userInput.style.height = '';
      return;
    }
    elements.userInput.style.height = 'auto';
    const newHeight = Math.min(elements.userInput.scrollHeight, 160);
    elements.userInput.style.height = `${newHeight}px`;
  }

  function scrollToBottom() {
    if (UIConversation.scrollToBottom) {
      return UIConversation.scrollToBottom(elements.messagesList);
    }
    if (elements.messagesList) {
      elements.messagesList.scrollTop = elements.messagesList.scrollHeight;
    }
  }

  // ==========================================================================
  // Gestión de Archivos Adjuntos
  // ==========================================================================


  function clearAttachedFiles() {
    if (UIComposer.clearAttachedFiles) {
      return UIComposer.clearAttachedFiles(elements);
    }
  }

  async function processFiles(files) {
    if (UIComposer.processFiles) {
      return UIComposer.processFiles(elements, files);
    }
  }


  // ==========================================================================
  // Renderizado de Mensajes con Acciones y Estadísticas
  // ==========================================================================



  function removeMessage(wrapper) {
    if (UIConversation.removeMessage) {
      return UIConversation.removeMessage(wrapper, {
        messagesList: elements.messagesList,
        welcomeBanner: elements.welcomeBanner,
        isBusy: () => State.isConversationBusy?.(),
        removeTurn: (payload) => State.removeTurn?.(payload),
        saveSession: () => saveCurrentSession(),
        addDebugLog: (type, text) => (typeof addDebugLog === 'function' ? addDebugLog(type, text) : null)
      });
    }
  }

  function appendUserMessage(text, originalPrompt, attachedImages, existingMsgId) {
    if (UIConversation.appendUserMessage) {
      return UIConversation.appendUserMessage(elements.messagesList, elements.welcomeBanner, {
        text,
        originalPrompt,
        attachedImages,
        existingMsgId
      }, {
        onReuse: (txt) => {
          if (elements.userInput) {
            elements.userInput.value = txt;
            autoResizeTextarea();
            elements.userInput.focus();
          }
        },
        onDelete: (wrapper) => removeMessage(wrapper)
      });
    }
  }

  function createAssistantMessagePlaceholder(existingMsgId) {
    if (UIConversation.createAssistantMessagePlaceholder) {
      return UIConversation.createAssistantMessagePlaceholder(elements.messagesList, existingMsgId, {
        welcomeBanner: elements.welcomeBanner,
        onBranch: (wrapper) => createConversationBranch(wrapper),
        onDelete: (wrapper) => removeMessage(wrapper)
      });
    }
  }

  // ==========================================================================
  // Envío de Mensaje y Streaming
  // ==========================================================================

  function getGenerationControllerOptions() {
    return {
      elements,
      getRuntimeConfig,
      getCurrentSessionId,
      getChatHistory,
      setGenerationStatus,
      clearGenerationStatus,
      showTypingIndicator,
      removeTypingIndicator,
      createAssistantMessagePlaceholder,
      appendUserMessage,
      attachListenersToContainer,
      scrollToBottom,
      updateConnectionTokensBadge,
      addDebugLog,
      setDebugStatus,
      openDebugInterceptorModal,
      saveCurrentSession,
      clearAttachedFiles,
      autoResizeTextarea,
      closeReasoningMenu,
      setAssistantGroupMessageIds
    };
  }

  async function handleSendMessage() {
    if (GenerationController.handleSendMessage) {
      return await GenerationController.handleSendMessage(getGenerationControllerOptions());
    }
  }


  function handleStopGeneration() {
    if (GenerationController.handleStopGeneration) {
      return GenerationController.handleStopGeneration();
    }
  }

  // ==========================================================================
  // Modal de Configuración & Gestión de Perfiles
  // ==========================================================================

  function getProfilesHelperOptions() {
    return {
      getRuntimeConfig,
      loadCachedModels,
      resetTelemetryDisplay,
      updateUIFromConfig,
      updateReasoningUI
    };
  }

  /**
   * Puebla el combobox auxiliar y el datalist con todos los perfiles disponibles.
   */
  function populateProfileSelector(selectedProfileName) {
    if (UIProfiles.populateProfileSelector) {
      return UIProfiles.populateProfileSelector(elements, selectedProfileName);
    }
  }

  async function applyProfileToForm(profileData, profileId = null) {
    if (UIProfiles.applyProfileToForm) {
      return UIProfiles.applyProfileToForm(elements, profileData, profileId, getProfilesHelperOptions());
    }
  }

  function gatherCurrentFormConfig() {
    if (UISettings.gatherCurrentFormConfig) {
      return UISettings.gatherCurrentFormConfig(elements, appConfig);
    }
    return appConfig;
  }

  function showProfileFeedback(msg, type = 'success') {
    if (UISettings.showProfileFeedback) {
      UISettings.showProfileFeedback(elements, msg, type);
    }
  }

  function saveCurrentSettings(closeModal = true) {
    const newConfig = gatherCurrentFormConfig();
    const savedConfig = Config.updateRuntime ? Config.updateRuntime(newConfig) : newConfig;
    loadCachedModels();

    const currentHistory = getChatHistory();
    if (currentHistory.length > 0 && currentHistory[0].role === 'system') {
      currentHistory[0].content = getConfiguredSystemPrompt(savedConfig);
      if (State.replaceMessages) {
        State.replaceMessages(currentHistory);
      }
    }

    if (typeof populateProfileSelector === 'function') {
      populateProfileSelector(savedConfig.activeProfile?.id || '');
    }

    if (closeModal) {
      closeSettingsModal();
    } else {
      showProfileFeedback(t('msg_profile_saved', { name: savedConfig.activeProfile?.name || 'actual' }) || 'Configuración actualizada.', 'success');
    }
  }



  function syncProfileSaveState() {
    if (UIProfiles.syncProfileSaveState) {
      return UIProfiles.syncProfileSaveState(elements, getProfilesHelperOptions());
    }
  }

  async function handleSaveProfile() {
    if (UIProfiles.handleSaveProfile) {
      return UIProfiles.handleSaveProfile(elements, getProfilesHelperOptions());
    }
    return false;
  }

  function isProfileQueryReady() {
    if (UIProfiles.isProfileQueryReady) {
      return UIProfiles.isProfileQueryReady(elements);
    }
    return elements.profilesDialog?.dataset.queryReady === 'true';
  }

  function isProfileFormDirty() {
    if (UIProfiles.isProfileFormDirty) {
      return UIProfiles.isProfileFormDirty(elements, getProfilesHelperOptions());
    }
    return elements.profilesDialog?.dataset.profileDirty === 'true';
  }

  function setProfileDirty(dirty = true) {
    if (UIProfiles.setProfileDirty) {
      return UIProfiles.setProfileDirty(elements, dirty);
    }
    if (elements.profilesDialog) {
      if (!elements.profilesDialog.dataset) elements.profilesDialog.dataset = {};
      elements.profilesDialog.dataset.profileDirty = String(Boolean(dirty));
    }
  }

  function setProfileQueryState(ready) {
    if (UIProfiles.setProfileQueryState) {
      return UIProfiles.setProfileQueryState(elements, ready, getProfilesHelperOptions());
    }
  }

  function activateProfileTab(tabBtn) {
    if (UIProfiles.activateProfileTab) {
      return UIProfiles.activateProfileTab(elements, tabBtn);
    }
  }

  function setSelectedProfileAsDefault(profile) {
    if (UIProfiles.setSelectedProfileAsDefault) {
      return UIProfiles.setSelectedProfileAsDefault(profile, getProfilesHelperOptions());
    }
  }

  function activateConnectionProfile(profileId) {
    if (UIProfiles.activateConnectionProfile) {
      return UIProfiles.activateConnectionProfile(profileId, getProfilesHelperOptions());
    }
  }


  function openProfileMenu() {
    if (UIProfiles.openProfileMenu) {
      return UIProfiles.openProfileMenu(elements, getProfilesHelperOptions());
    }
  }

  function closeProfileMenu() {
    if (UIProfiles.closeProfileMenu) {
      return UIProfiles.closeProfileMenu(elements);
    }
  }

  async function handleDeleteProfile() {
    if (UIProfiles.handleDeleteProfile) {
      return UIProfiles.handleDeleteProfile(elements, getProfilesHelperOptions());
    }
  }

  async function handleNewProfile() {
    if (UIProfiles.handleNewProfile) {
      return UIProfiles.handleNewProfile(elements, getProfilesHelperOptions());
    }
  }

  async function handleExportProfiles() {
    if (UIProfiles.handleExportProfiles) {
      return UIProfiles.handleExportProfiles(elements);
    }
  }

  async function handleImportProfiles(event) {
    if (UIProfiles.handleImportProfiles) {
      return UIProfiles.handleImportProfiles(event, elements, getProfilesHelperOptions());
    }
  }

  function openSettingsModal(initialTabId = 'tab-general') {
    if (UISettings.openSettingsModal) {
      UISettings.openSettingsModal(elements, getRuntimeConfig(), {
        populateProfileSelector,
        loadCachedModels,
        updateReasoningUI
      }, initialTabId);
    }
  }

  function openProfilesModal() {
    if (UIProfiles.openProfilesModal) {
      return UIProfiles.openProfilesModal(elements, getProfilesHelperOptions());
    }
  }

  function resetProfileFormToSelected() {
    if (UIProfiles.resetProfileFormToSelected) {
      return UIProfiles.resetProfileFormToSelected(elements, getProfilesHelperOptions());
    }
  }

  async function closeProfilesModal(force = false) {
    if (UIProfiles.closeProfilesModal) {
      return UIProfiles.closeProfilesModal(elements, force, getProfilesHelperOptions());
    }
  }

  function closeSettingsModal() {
    if (UISettings.closeSettingsModal) {
      UISettings.closeSettingsModal(elements);
    }
  }

  function handleSaveSettings(e) {
    if (e && e.preventDefault) e.preventDefault();
    saveCurrentSettings(true);
  }

  function handleResetSettings() {
    if (UISettings.handleResetSettings) {
      UISettings.handleResetSettings(elements, Config.DEFAULTS || getRuntimeConfig());
    }
  }

  function handleClearAllData() {
    if (UISettings.handleClearAllData) {
      UISettings.handleClearAllData();
    }
  }

  // ==========================================================================
  // Gestión de Múltiples Sesiones de Chat (Sidebar & IndexedDB Storage)
  // ==========================================================================

  async function loadSessionsFromStorage() {
    if (ConversationService.loadSessionsFromStorage) {
      return await ConversationService.loadSessionsFromStorage(getConversationServiceOptions());
    }
  }

  async function saveCurrentSession() {
    if (ConversationService.saveCurrentSession) {
      return await ConversationService.saveCurrentSession(getConversationServiceOptions());
    }
  }

  function renderSidebarChats(filterText = '') {
    if (UISidebar.renderSidebarChats) {
      UISidebar.renderSidebarChats(elements, getSavedSessions(), getCurrentSessionId(), {
        onSwitchSession: switchToSession,
        onRenameSession: renameSession,
        onDeleteSession: deleteSession,
        onExportSession: (sessionId, e) => {
          if (e && e.stopPropagation) e.stopPropagation();
          openExportModal(sessionId);
        }
      }, { groupByDate: true });
    }
  }

  async function switchToSession(sessionId, opts = {}) {
    if (ConversationService.switchToSession) {
      return await ConversationService.switchToSession(sessionId, Object.assign({}, getConversationServiceOptions(), opts));
    }
  }

  async function createNewSession(opts = {}) {
    if (ConversationService.createNewSession) {
      return await ConversationService.createNewSession(Object.assign({}, getConversationServiceOptions(), opts));
    }
  }


  function setAssistantGroupMessageIds(wrapper, history) {
    if (ConversationService.setAssistantGroupMessageIds) {
      return ConversationService.setAssistantGroupMessageIds(wrapper, history);
    }
  }


  async function createConversationBranch(wrapper) {
    if (ConversationService.createConversationBranch) {
      return await ConversationService.createConversationBranch(wrapper, getConversationServiceOptions());
    }
  }

  async function deleteSession(sessionId, event) {
    if (ConversationService.deleteSession) {
      return await ConversationService.deleteSession(sessionId, event, getConversationServiceOptions());
    }
  }

  async function deleteAllSessions() {
    if (ConversationService.deleteAllSessions) {
      return await ConversationService.deleteAllSessions(getConversationServiceOptions());
    }
  }

  async function renameSession(sessionId, event) {
    if (ConversationService.renameSession) {
      return await ConversationService.renameSession(sessionId, event, getConversationServiceOptions());
    }
  }

  function toggleSidebar() {
    if (UISidebar.toggleSidebar) {
      UISidebar.toggleSidebar(elements);
    }
  }


  function closeSidebar() {
    if (UISidebar.closeSidebar) {
      UISidebar.closeSidebar(elements);
    }
  }


  function attachListenersToContainer(container) {
    if (UIConversation.attachListenersToContainer) {
      return UIConversation.attachListenersToContainer(container);
    }
    if (!container) return;
    if (Markdown.attachCopyCodeListeners) {
      Markdown.attachCopyCodeListeners(container);
    }
    if (Markdown.attachRunJsListeners) {
      Markdown.attachRunJsListeners(container, (code, outputEl) => {
        if (Sandbox && Sandbox.execute) {
          Sandbox.execute(code).then(res => {
            if (outputEl) {
              outputEl.textContent = res.success ? (res.result || res.logs.join('\n') || 'undefined') : `Error: ${res.error}`;
            }
          });
        }
      });
    }
  }

  function renderSessionMessages(history) {
    if (UIConversation.renderSessionMessages) {
      return UIConversation.renderSessionMessages(elements, history, {
        onBranch: (wrapper) => createConversationBranch(wrapper),
        onDelete: (wrapper) => removeMessage(wrapper),
        onReuse: (txt) => {
          if (elements.userInput) {
            elements.userInput.value = txt;
            autoResizeTextarea();
            elements.userInput.focus();
          }
        },
        resetTelemetry: () => resetTelemetryDisplay(),
        updateTelemetry: () => updateConnectionTokensBadge(null, null, { forcePopover: true })
      });
    }
  }

  // ==========================================================================
  // Modal de Exportación e Importación de Conversaciones
  // ==========================================================================

  function getExportTransferOptions() {
    return {
      getActiveSessionId: () => getCurrentSessionId(),
      getSavedSessions: () => getSavedSessions(),
      getHistory: () => getChatHistory(),
      getSession: async (id) => (Storage && Storage.getConversation) ? await Storage.getConversation(id) : null,
      getConfig: () => appConfig,
      getModel: () => appConfig.model,
      onSwitchSession: async (id) => await switchToSession(id)
    };
  }

  function getExportTargetSessionId() {
    if (UITransfer.getExportTargetSessionId) return UITransfer.getExportTargetSessionId(elements, getCurrentSessionId());
    return elements.exportModal?.dataset?.sessionId || getCurrentSessionId();
  }

  function openExportModal(targetSessionId = null) {
    if (UITransfer.openExportModal) {
      UITransfer.openExportModal(elements, targetSessionId, getCurrentSessionId());
      return;
    }
    if (elements.exportModal) {
      elements.exportModal.dataset.sessionId = targetSessionId || getCurrentSessionId();
      if (typeof elements.exportModal.showModal === 'function') {
        elements.exportModal.showModal();
      } else {
        elements.exportModal.style.display = 'block';
      }
    }
  }

  function closeExportModal() {
    if (UITransfer.closeExportModal) {
      UITransfer.closeExportModal(elements);
      return;
    }
    if (elements.exportModal) {
      delete elements.exportModal.dataset.sessionId;
      if (typeof elements.exportModal.close === 'function') {
        elements.exportModal.close();
      } else {
        elements.exportModal.style.display = 'none';
      }
    }
  }

  async function getSessionForExport() {
    if (UITransfer.resolveSessionForExport) {
      return await UITransfer.resolveSessionForExport(elements, getExportTransferOptions());
    }
    const id = getExportTargetSessionId();
    if (id === getCurrentSessionId()) {
      return { sess: getSavedSessions().find(s => s.id === id), history: getChatHistory() };
    }
    const conv = (Storage && Storage.getConversation) ? await Storage.getConversation(id) : null;
    return { sess: conv, history: conv?.history || [] };
  }

  async function exportConversationAsMarkdown() {
    if (UITransfer.exportConversationAsMarkdown) {
      await UITransfer.exportConversationAsMarkdown(elements, getExportTransferOptions());
      return;
    }
    const { sess, history } = await getSessionForExport();
    const title = (sess && sess.title) || 'ZeroChat_Conversation';
    const dateStr = new Date().toISOString().slice(0, 10);
    const md = Export.buildMarkdownExport ? Export.buildMarkdownExport(history, { title, model: appConfig.model }) : '';
    if (Export.downloadFile) {
      Export.downloadFile(md, `${title.replace(/[^a-zA-Z0-9_-]/g, '_')}_${dateStr}.md`, 'text/markdown');
    }
    closeExportModal();
  }

  async function exportConversationAsJson() {
    if (UITransfer.exportConversationAsJson) {
      await UITransfer.exportConversationAsJson(elements, getExportTransferOptions());
      return;
    }
    const { sess, history } = await getSessionForExport();
    const title = (sess && sess.title) || 'ZeroChat_Conversation';
    const dateStr = new Date().toISOString().slice(0, 10);
    const jsonStr = Export.buildJsonExport ? Export.buildJsonExport(sess, history, appConfig) : '{}';
    if (Export.downloadFile) {
      Export.downloadFile(jsonStr, `${title.replace(/[^a-zA-Z0-9_-]/g, '_')}_${dateStr}.json`, 'application/json');
    }
    closeExportModal();
  }

  async function exportConversationAsPrint() {
    if (UITransfer.exportConversationAsPrint) {
      await UITransfer.exportConversationAsPrint(elements, getExportTransferOptions());
      return;
    }
    const targetId = getExportTargetSessionId();
    closeExportModal();
    if (targetId && targetId !== getCurrentSessionId()) {
      await switchToSession(targetId);
    }
    setTimeout(() => {
      window.print();
    }, 200);
  }

  async function handleImportFileSelected(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;

    if (blockSessionTransitionIfBusy('chat_import_blocked_generating')) {
      if (elements.importJsonInput) elements.importJsonInput.value = '';
      return;
    }

    const maxBytes = (typeof Attachments !== 'undefined' && Attachments?.MAX_FILE_SIZE) || (50 * 1024 * 1024);
    if (file.size > maxBytes) {
      await ChatDialogs.alert(t('err_file_too_large', { name: file.name, max: '50 MB' }), { type: 'error' });
      if (elements.importJsonInput) elements.importJsonInput.value = '';
      return;
    }

    const reader = new FileReader();
    reader.onload = async function(evt) {
      try {
        const newSession = Export.parseImportedJson ? Export.parseImportedJson(evt.target.result, file.name.replace('.json', '')) : null;
        if (!newSession) throw new Error('Error al procesar el archivo');

        Engine.ensureConversationDate(newSession.history, appConfig.language || 'es', newSession.createdAt);

        if (State.importConversation) {
          const res = State.importConversation(newSession, newSession.history);
          if (!res.ok) {
            throw new Error(res.reason);
          }
        }

        renderSessionMessages(getChatHistory());
        await saveCurrentSession();
        ChatDialogs.alert(t('chat_imported_success'), { type: 'success' });
      } catch (err) {
        ChatDialogs.alert(t('chat_import_json_err', { err: err.message || err }), { type: 'error' });
      }
      if (elements.importJsonInput) elements.importJsonInput.value = '';
    };
    reader.readAsText(file);
  }

  // ==========================================================================
  // Pegado de Imágenes desde el Portapapeles (Ctrl + V)
  // ==========================================================================

  function handlePasteEvent(e) {
    if (UIComposer.handlePasteEvent) {
      return UIComposer.handlePasteEvent(e, elements);
    }
  }

  // ==========================================================================
  // Ajuste Dinámico de Altura de Viewport (Android / Tablets / iOS / Teclados)
  // ==========================================================================

  function updateViewportHeight() {
    if (UIShell.updateViewportHeight) return UIShell.updateViewportHeight();
    let vh = window.innerHeight;
    if (window.visualViewport) {
      vh = window.visualViewport.height;
    }
    document.documentElement.style.setProperty('--app-height', `${vh}px`);
  }

  function setupViewportListeners() {
    if (UIShell.setupViewportListeners) {
      return UIShell.setupViewportListeners(elements, {
        onViewportChange: () => positionReasoningMenu()
      });
    }
    updateViewportHeight();
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', () => {
        updateViewportHeight();
        positionReasoningMenu();
      });
      window.visualViewport.addEventListener('scroll', () => {
        updateViewportHeight();
        positionReasoningMenu();
      });
    }
    window.addEventListener('resize', () => {
      updateViewportHeight();
      positionReasoningMenu();
    });
    window.addEventListener('orientationchange', () => {
      setTimeout(() => { updateViewportHeight(); positionReasoningMenu(); }, 100);
      setTimeout(() => { updateViewportHeight(); positionReasoningMenu(); }, 300);
    });

    if (elements.userInput) {
      elements.userInput.addEventListener('focus', () => {
        setTimeout(() => {
          updateViewportHeight();
          positionReasoningMenu();
          if (elements.userInput) {
            elements.userInput.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          }
        }, 150);
      });
    }
  }

  // ==========================================================================
  // Fase 8 — Indicador de Escritura del Asistente
  // ==========================================================================


  let typingIndicatorEl = null;

  function showTypingIndicator() {
    if (UIConversation.showTypingIndicator) {
      return UIConversation.showTypingIndicator(elements.messagesList);
    }
    if (typingIndicatorEl) return;
    const wrapper = document.createElement('div');
    wrapper.id = 'typing-indicator-wrapper';
    wrapper.className = 'message-wrapper assistant';
    const row = document.createElement('div');
    row.className = 'message-row assistant';
    const indicator = document.createElement('div');
    indicator.className = 'typing-indicator';
    indicator.innerHTML = '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';
    row.appendChild(indicator);
    wrapper.appendChild(row);
    typingIndicatorEl = wrapper;
    if (elements.messagesList) {
      elements.messagesList.appendChild(wrapper);
      scrollToBottom();
    }
  }

  function removeTypingIndicator() {
    if (UIConversation.removeTypingIndicator) {
      UIConversation.removeTypingIndicator();
    }
    if (typingIndicatorEl && typingIndicatorEl.parentNode) {
      typingIndicatorEl.parentNode.removeChild(typingIndicatorEl);
    }
    typingIndicatorEl = null;
  }

  // ==========================================================================
  // Fase 6 — View Transitions para Cambio de Pestaña y Light-Dismiss
  // ==========================================================================

  function switchModalTab(tabBtn, allTabs, allPanes) {
    const targetTabId = tabBtn.getAttribute('data-tab');
    if (!targetTabId) return;

    allTabs.forEach(b => b.classList.remove('active'));
    allPanes.forEach(p => p.classList.remove('active'));
    tabBtn.classList.add('active');
    const targetPane = document.getElementById(targetTabId);
    if (targetPane) targetPane.classList.add('active');
  }

  function setupLightDismissDialogs() {
    if (UIShell.setupLightDismissDialogs) {
      return UIShell.setupLightDismissDialogs(document, {
        onDismissProfiles: () => closeProfilesModal()
      });
    }
    // Fallback para navegadores sin soporte de closedby="any"
    // Solo actúa si el atributo no está soportado nativamente
    if ('closedBy' in HTMLDialogElement.prototype) return;
    document.querySelectorAll('dialog[closedby="any"]:not(#notice-dialog)').forEach(dialog => {
      dialog.addEventListener('click', e => {
        // Si el clic fue directamente en el fondo del dialog (no en su contenido)
        if (e.target === dialog) {
          if (dialog.id === 'profiles-dialog') {
            closeProfilesModal();
            return;
          }
          dialog.close();
        }
      });
    });
  }

  // ==========================================================================
  // Escuchadores de Eventos
  // ==========================================================================

  function setupEventListeners() {
    setupViewportListeners();

    if (elements.btnOpenExecutionInfo) {
      elements.btnOpenExecutionInfo.addEventListener('click', openExecutionInfo);
    }
    if (elements.btnCloseExecutionInfo) {
      elements.btnCloseExecutionInfo.addEventListener('click', closeExecutionInfo);
    }
    if (elements.btnCloseExecutionInfoFooter) {
      elements.btnCloseExecutionInfoFooter.addEventListener('click', closeExecutionInfo);
    }
    if (elements.executionInfoDialog) {
      elements.executionInfoDialog.addEventListener('click', event => {
        if (event.target === elements.executionInfoDialog) closeExecutionInfo();
      });
    }

    // Formulario de chat
    elements.chatForm.addEventListener('submit', function (e) {
      e.preventDefault();
      handleSendMessage();
    });

    // Tecla Enter y Pegado
    elements.userInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSendMessage();
      }
    });

    elements.userInput.addEventListener('input', autoResizeTextarea);
    elements.userInput.addEventListener('paste', handlePasteEvent);

    // Botones de acción
    elements.btnStopStream.addEventListener('click', handleStopGeneration);

    // Parada ordenada ante cierre de página o recarga durante generación
    if (typeof window !== 'undefined' && window.addEventListener) {
      const handleWindowUnload = () => {
        if (GenerationController?.isGenerating?.()) {
          handleStopGeneration();
        }
      };
      window.addEventListener('beforeunload', handleWindowUnload);
      window.addEventListener('pagehide', handleWindowUnload);
    }



    if (elements.btnOpenSettings) {
      elements.btnOpenSettings.addEventListener('click', () => openSettingsModal('tab-general'));
    }
    if (elements.btnComposerTools) {
      elements.btnComposerTools.addEventListener('click', () => openSettingsModal('tab-agent'));
    }
    if (elements.btnComposerMcp) {
      elements.btnComposerMcp.addEventListener('click', () => openSettingsModal('tab-mcp'));
    }

    function updateComposerMcpState(mcpState) {
      if (UIComposer.updateComposerMcpState) {
        return UIComposer.updateComposerMcpState(elements, mcpState);
      }
    }
    State.subscribe('mcp', (newState) => updateComposerMcpState(newState));
    updateComposerMcpState(State.get('mcp'));
    window.addEventListener('zerochat:languagechange', () => {
      updateComposerMcpState(State.get('mcp'));
      updateExecutionInfo();
    });


    // Barra Lateral de Chats (Sidebar)
    if (elements.btnToggleSidebar) {
      elements.btnToggleSidebar.addEventListener('click', toggleSidebar);
    }
    if (elements.activeProfileTrigger) {
      elements.activeProfileTrigger.addEventListener('click', () => {
        const isOpen = elements.activeProfileTrigger.getAttribute('aria-expanded') === 'true';
        if (isOpen) closeProfileMenu();
        else openProfileMenu();
      });
    }
    if (elements.activeProfileList) {
      elements.activeProfileList.addEventListener('click', (event) => {
        const option = event.target.closest('[data-profile-id]');
        if (!option || !elements.activeProfileList.contains(option)) return;
        if (!Profiles.get(option.dataset.profileId)) return;
        activateConnectionProfile(option.dataset.profileId);
        closeProfileMenu();
        elements.activeProfileTrigger.focus();
      });
    }
    elements.activeProfileMenu?.addEventListener('keydown', event => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      if (elements.activeProfilePopover.hidden) openProfileMenu();
      const buttons = [...elements.activeProfileList.querySelectorAll('button'), elements.btnEditProfiles];
      const index = buttons.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    });
    elements.activeProfileMenu?.addEventListener('focusout', event => {
      if (!elements.activeProfileMenu.contains(event.relatedTarget)) closeProfileMenu();
    });
    if (elements.btnEditProfiles) {
      elements.btnEditProfiles.addEventListener('click', () => {
        closeProfileMenu();
        openProfilesModal();
      });
    }
    document.addEventListener('click', (event) => {
      if (elements.activeProfileMenu && !elements.activeProfileMenu.contains(event.target)) closeProfileMenu();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || elements.activeProfileTrigger?.getAttribute('aria-expanded') !== 'true') return;
      closeProfileMenu();
      elements.activeProfileTrigger.focus();
    });
    if (elements.btnCloseSidebar) {
      elements.btnCloseSidebar.addEventListener('click', closeSidebar);
    }
    if (elements.sidebarBackdrop) {
      elements.sidebarBackdrop.addEventListener('click', closeSidebar);
    }
    if (elements.btnSidebarNewChat) {
      elements.btnSidebarNewChat.addEventListener('click', createNewSession);
    }
    if (elements.btnSidebarNewTab) {
      elements.btnSidebarNewTab.addEventListener('click', updateNewTabLink);
      elements.btnSidebarNewTab.addEventListener('pointerdown', updateNewTabLink);
    }
    if (elements.sidebarSearchInput) {
      elements.sidebarSearchInput.addEventListener('input', () => {
        renderSidebarChats(elements.sidebarSearchInput.value);
      });
    }
    if (elements.btnImportChatFile && elements.importJsonInput) {
      elements.btnImportChatFile.addEventListener('click', () => elements.importJsonInput.click());
      elements.importJsonInput.addEventListener('change', handleImportFileSelected);
    }
    if (elements.btnDeleteAllChats) {
      elements.btnDeleteAllChats.addEventListener('click', deleteAllSessions);
    }

    // Modal de Exportación (disparado desde cada chat en la barra lateral)
    if (elements.exportModal) {
      elements.exportModal.addEventListener('close', () => {
        delete elements.exportModal.dataset.sessionId;
      });
    }
    if (elements.btnCloseExport) {
      elements.btnCloseExport.addEventListener('click', closeExportModal);
    }
    if (elements.btnCancelExport) {
      elements.btnCancelExport.addEventListener('click', closeExportModal);
    }
    if (elements.btnExportMarkdown) {
      elements.btnExportMarkdown.addEventListener('click', exportConversationAsMarkdown);
    }
    if (elements.btnExportJson) {
      elements.btnExportJson.addEventListener('click', exportConversationAsJson);
    }
    if (elements.btnExportPrint) {
      elements.btnExportPrint.addEventListener('click', exportConversationAsPrint);
    }

    // Razonamiento (Thinking)
    if (elements.btnReasoning) {
      elements.btnReasoning.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleReasoningMenu();
      });
    }

    document.addEventListener('click', (e) => {
      if (elements.reasoningMenu && elements.reasoningMenu.style.display !== 'none') {
        const isClickInsideMenu = elements.reasoningMenu.contains(e.target);
        const isClickInsideButton = elements.btnReasoning && elements.btnReasoning.contains(e.target);
        if (!isClickInsideMenu && !isClickInsideButton) {
          closeReasoningMenu();
        }
      }
    });

    // Panel de Debug & Logs
    if (elements.btnToggleDebug) {
      elements.btnToggleDebug.addEventListener('click', () => {
        toggleDebugPanel();
      });
    }

    if (elements.btnCloseDebug) {
      elements.btnCloseDebug.addEventListener('click', () => {
        toggleDebugPanel(false);
      });
    }

    if (elements.btnClearDebug) {
      elements.btnClearDebug.addEventListener('click', clearDebugLogs);
    }

    if (elements.btnCopyDebug) {
      elements.btnCopyDebug.addEventListener('click', copyDebugLogs);
    }

    if (elements.btnToggleAutoscroll) {
      elements.btnToggleAutoscroll.addEventListener('click', () => {
        isDebugAutoscroll = !isDebugAutoscroll;
        elements.btnToggleAutoscroll.classList.toggle('active', isDebugAutoscroll);
      });
    }

    if (elements.debugTabs && elements.debugTabs.length > 0) {
      elements.debugTabs.forEach(tab => {
        tab.addEventListener('click', () => {
          elements.debugTabs.forEach(t => t.classList.remove('active'));
          tab.classList.add('active');
          const filter = tab.getAttribute('data-debug-tab') || 'all';
          filterDebugLogs(filter);
        });
      });
    }

    function syncRawLogsState(enabled) {
      const value = Boolean(enabled);
      if (Debug.setRawLogsEnabled) Debug.setRawLogsEnabled(enabled);
      if (elements.chkEnableRaw) elements.chkEnableRaw.checked = enabled;
      if (elements.settingEnableRawLogs) elements.settingEnableRawLogs.checked = enabled;
      if (elements.rawStatusBadge) {
        elements.rawStatusBadge.className = enabled ? 'raw-status-badge active' : 'raw-status-badge';
        elements.rawStatusBadge.textContent = enabled ? t('raw_status_active') : t('raw_status_inactive');
      }
      if (Config.updateRuntime) Config.updateRuntime({ enableRawLogs: value });
    }

    if (elements.chkEnableRaw) {
      elements.chkEnableRaw.addEventListener('change', () => {
        syncRawLogsState(elements.chkEnableRaw.checked);
      });
    }

    if (elements.settingEnableRawLogs) {
      elements.settingEnableRawLogs.addEventListener('change', () => {
        syncRawLogsState(elements.settingEnableRawLogs.checked);
      });
    }

    if (elements.chkEnableDebugMessages) {
      elements.chkEnableDebugMessages.addEventListener('change', () => {
        syncDebugMessagesState(elements.chkEnableDebugMessages.checked);
      });
    }

    // Adjuntos de archivos
    elements.btnAttachFile.addEventListener('click', () => {
      elements.fileInput.click();
    });

    elements.fileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length > 0) {
        processFiles(Array.from(e.target.files));
      }
    });

    // Soporte de Arrastrar y Soltar (Drag and Drop)
    elements.chatForm.addEventListener('dragover', (e) => {
      e.preventDefault();
      elements.chatForm.classList.add('drag-over');
    });

    elements.chatForm.addEventListener('dragleave', () => {
      elements.chatForm.classList.remove('drag-over');
    });

    elements.chatForm.addEventListener('drop', (e) => {
      e.preventDefault();
      elements.chatForm.classList.remove('drag-over');
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        processFiles(Array.from(e.dataTransfer.files));
      }
    });

    // Modal de Configuración & Perfiles
    elements.btnCloseSettings.addEventListener('click', closeSettingsModal);
    elements.btnCancelSettings.addEventListener('click', closeSettingsModal);
    elements.settingsForm.addEventListener('submit', handleSaveSettings);
    elements.btnResetSettings.addEventListener('click', handleResetSettings);
    if (elements.btnClearAllData) {
      elements.btnClearAllData.addEventListener('click', handleClearAllData);
    }
    if (elements.btnManageProfiles) {
      elements.btnManageProfiles.addEventListener('click', openProfilesModal);
    }
    if (elements.btnCloseProfiles) {
      elements.btnCloseProfiles.addEventListener('click', () => {
        closeProfilesModal();
      });
    }
    if (elements.btnCancelProfiles) {
      elements.btnCancelProfiles.addEventListener('click', () => {
        closeProfilesModal();
      });
    }
    if (elements.profilesDialog) {
      const markProfileModified = (e) => {
        if (e && (e.target === elements.profileSelectHelper || e.target === elements.profilesImportInput)) {
          return;
        }
        setProfileDirty(true);
        syncProfileSaveState();
      };
      elements.profilesDialog.addEventListener('input', markProfileModified);
      elements.profilesDialog.addEventListener('change', markProfileModified);
      elements.profilesDialog.addEventListener('cancel', function (e) {
        if (!isProfileQueryReady() && !isProfileFormDirty()) {
          setProfileQueryState(false);
          setProfileDirty(false);
          resetProfileFormToSelected();
          return;
        }
        e.preventDefault();
        closeProfilesModal();
      });
    }

    if (elements.profileSelectHelper) {
      elements.profileSelectHelper.addEventListener('change', function () {
        const selectedId = this.value;
        const profile = Profiles.get ? Profiles.get(selectedId) : null;
        if (!profile) return;
        if (elements.settingProfileName) {
          elements.settingProfileName.value = profile.name;
        }
        if (elements.settingProfileDescription) {
          elements.settingProfileDescription.value = profile.description || '';
        }
        applyProfileToForm(profile.settings);
        setSelectedProfileAsDefault(profile);
        setProfileQueryState(false);
        setProfileDirty(false);
        if (typeof loadCachedModels === 'function') loadCachedModels();
        syncProfileSaveState();
      });
    }

    if (elements.settingProfileName) {
      elements.settingProfileName.addEventListener('change', function () {
        const typedName = this.value.trim();
        if (!typedName) return;
        if (Profiles.findByName) {
          const profile = Profiles.findByName(typedName);
          if (profile) {
            if (elements.profileSelectHelper) {
              elements.profileSelectHelper.value = profile.id;
            }
            applyProfileToForm(profile.settings, profile.id);
            if (elements.settingProfileDescription) {
              elements.settingProfileDescription.value = profile.description || '';
            }
            setSelectedProfileAsDefault(profile);
            setProfileQueryState(false);
            setProfileDirty(false);
            if (typeof loadCachedModels === 'function') loadCachedModels();
            syncProfileSaveState();
          }
        }
      });
    }

    if (elements.btnSaveProfile) {
      elements.btnSaveProfile.addEventListener('click', (e) => {
        e.preventDefault();
        handleSaveProfile().then(saved => { if (saved) closeProfilesModal(true); }).catch(error => showProfileFeedback(error.message, 'error'));
      });
    }

    if (elements.btnNewProfile) {
      elements.btnNewProfile.addEventListener('click', handleNewProfile);
    }

    if (elements.btnExportProfiles) {
      elements.btnExportProfiles.addEventListener('click', handleExportProfiles);
    }

    if (elements.btnImportProfiles && elements.profilesImportInput) {
      elements.btnImportProfiles.addEventListener('click', () => elements.profilesImportInput.click());
      elements.profilesImportInput.addEventListener('change', handleImportProfiles);
    }

    if (elements.btnDeleteProfile) {
      elements.btnDeleteProfile.addEventListener('click', (e) => {
        e.preventDefault();
        handleDeleteProfile();
      });
    }

    if (elements.settingApiType) {
      elements.settingApiType.addEventListener('change', function () {
        setProfileQueryState(false);
        const val = this.value;
        const currentUrl = elements.settingApiUrl ? elements.settingApiUrl.value.trim() : '';

        const knownEndpoints = Providers.registry?.getConnectionEndpoints?.() || [];
        const isDefaultOrEmpty = !currentUrl || knownEndpoints.includes(currentUrl);

        if (isDefaultOrEmpty && elements.settingApiUrl) {
          const endpoint = Providers.registry?.get?.(val)?.getConnectionConfig?.().endpoint;
          if (endpoint) elements.settingApiUrl.value = endpoint;
        }
        UISettings.syncProviderFields?.(elements);
        if (typeof loadCachedModels === 'function') {
          loadCachedModels();
        }
        setProfileDirty(true);
        syncProfileSaveState();
      });
    }
    [elements.settingApiUrl, elements.settingApiKey].forEach(input => {
      input?.addEventListener('input', () => setProfileQueryState(false));
    });

    if (elements.btnQueryServer) {
      elements.btnQueryServer.addEventListener('click', (e) => {
        e.preventDefault();
        handleQueryServer();
      });
    }

    if (elements.btnRunInspector) {
      elements.btnRunInspector.addEventListener('click', (e) => {
        e.preventDefault();
        handleRunInspector();
      });
    }

    if (elements.modelSelectHelper) {
      elements.modelSelectHelper.addEventListener('change', function () {
        if (this.value) {
          elements.settingModel.value = this.value;
        }
        setProfileDirty(true);
        syncProfileSaveState();
      });
    }

    if (elements.settingModel) {
      elements.settingModel.addEventListener('input', function () {
        const val = this.value.trim();
        if (elements.modelSelectHelper) {
          elements.modelSelectHelper.value = val;
        }
        setProfileDirty(true);
        syncProfileSaveState();
      });

      elements.settingModel.addEventListener('change', function () {
        const val = this.value.trim();
        if (elements.modelSelectHelper) {
          elements.modelSelectHelper.value = val;
        }
        setProfileDirty(true);
        syncProfileSaveState();
      });
    }

    if (elements.modalTabs && elements.modalTabs.length > 0) {
      elements.modalTabs.forEach(tabBtn => {
        tabBtn.addEventListener('click', function (e) {
          e.preventDefault();
          switchModalTab(tabBtn, elements.modalTabs, elements.modalPanes);
        });
      });
    }

    if (elements.profileTabs && elements.profileTabs.length > 0) {
      elements.profileTabs.forEach(tabBtn => {
        tabBtn.addEventListener('click', function (e) {
          e.preventDefault();
          activateProfileTab(tabBtn);
        });
      });
    }

    if (elements.themeButtons && elements.themeButtons.length > 0) {
      elements.themeButtons.forEach(btn => {
        btn.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          const targetTheme = btn.getAttribute('data-theme') || 'light';
          applyTheme(targetTheme);
          if (Config.updateGeneral) Config.updateGeneral({ theme: targetTheme });
        });
      });
    }

    if (elements.langButtons && elements.langButtons.length > 0) {
      elements.langButtons.forEach(btn => {
        btn.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          const targetLang = btn.getAttribute('data-lang') || 'es';
          applyLanguage(targetLang);
          if (Config.updateGeneral) Config.updateGeneral({ language: targetLang });
        });
      });
    }

    elements.settingTemperature.addEventListener('input', function (e) {
      elements.temperatureVal.textContent = e.target.value;
    });

    if (elements.settingMaxAgentTurns && elements.maxAgentTurnsVal) {
      elements.settingMaxAgentTurns.addEventListener('input', function (e) {
        elements.maxAgentTurnsVal.textContent = e.target.value;
      });
    }

    elements.btnToggleKey.addEventListener('click', function () {
      const isPass = elements.settingApiKey.type === 'password';
      elements.settingApiKey.type = isPass ? 'text' : 'password';
      elements.btnToggleKey.innerHTML = getMsgIcon(isPass ? 'eye-off' : 'eye', 15);
    });

    if (elements.btnWebllmParams && elements.webllmParamsPanel) {
      elements.btnWebllmParams.addEventListener('click', function () {
        const isHidden = elements.webllmParamsPanel.hidden;
        elements.webllmParamsPanel.hidden = !isHidden;
        elements.btnWebllmParams.classList.toggle('active', isHidden);
      });
    }

    elements.settingsDialog.addEventListener('click', function (e) {
      if (e.target === elements.settingsDialog) {
        closeSettingsModal();
      }
    });

    const UITel = getUITelemetry();
    if (UITel && UITel.bindPopoverEvents) {
      UITel.bindPopoverEvents(elements, () => {
        updateConnectionTokensBadge(null, null, { forcePopover: true });
      });
    }
    if (elements.btnSaveContextLimitOverride && elements.contextLimitOverrideInput) {
      elements.btnSaveContextLimitOverride.addEventListener('click', async function () {
        const UITel = getUITelemetry();
        const contextLimitOverride = UITel?.parseContextCapacity?.(elements.contextLimitOverrideInput.value);
        if (!contextLimitOverride) {
          await ChatDialogs.alert(t('context_limit_override_invalid'));
          return;
        }
        const activeProfile = getRuntimeConfig().activeProfile;
        const profile = activeProfile && Profiles.get?.(activeProfile.id);
        if (!profile || !Profiles.save) {
          await ChatDialogs.alert(t('context_limit_override_profile_required'));
          return;
        }
        if (profile.settings.apiKeyLocked === true) {
          await ChatDialogs.alert(t('err_profile_read_only'));
          return;
        }
        try {
          const savedProfile = Profiles.save({ ...profile, settings: { ...profile.settings, contextLimitOverride } });
          activateConnectionProfile(savedProfile.id);
          updateConnectionTokensBadge(null, null, { forcePopover: true });
        } catch (error) {
          console.error('Could not save context limit override:', error);
          await ChatDialogs.alert(t('context_limit_override_save_error'));
        }
      });
    }
  }

  function ensureModalsMarkup() {
    if (UISettings && typeof UISettings.ensureDialogMarkup === 'function') UISettings.ensureDialogMarkup();
    if (window.ChatUIMcp && typeof window.ChatUIMcp.ensureDialogMarkup === 'function') window.ChatUIMcp.ensureDialogMarkup();
    if (window.ChatRagUI && typeof window.ChatRagUI.ensureDialogMarkup === 'function') window.ChatRagUI.ensureDialogMarkup();
    if (window.ChatExport && typeof window.ChatExport.ensureDialogMarkup === 'function') window.ChatExport.ensureDialogMarkup();
    if (Debug && typeof Debug.ensureDialogMarkup === 'function') Debug.ensureDialogMarkup();
  }

  const HEARTBEAT_INTERVAL_MS = 10000;
  let heartbeatTimer = null;
  let activeHeartbeatTarget = null;

  function buildHeartbeatUrl(host, port, token) {
    const encToken = encodeURIComponent(token);
    if (typeof window !== 'undefined' && window.location && window.location.protocol.startsWith('http')) {
      const locHost = window.location.hostname;
      const locPort = window.location.port || (window.location.protocol === 'https:' ? '443' : '80');
      const isSamePort = String(port) === String(locPort);
      const isLocalHostMatch = (locHost === host) ||
        (['127.0.0.1', 'localhost'].includes(locHost) && ['127.0.0.1', 'localhost'].includes(host));
      if (isSamePort && isLocalHostMatch) {
        return `/zerochat/heartbeat?token=${encToken}`;
      }
    }
    return `http://${host}:${port}/zerochat/heartbeat?token=${encToken}`;
  }

  function sendHeartbeatPing() {
    if (!activeHeartbeatTarget || typeof fetch !== 'function') return;
    const endpoint = buildHeartbeatUrl(activeHeartbeatTarget.host, activeHeartbeatTarget.port, activeHeartbeatTarget.token);
    fetch(endpoint, {
      method: 'GET',
      cache: 'no-store',
      mode: 'cors'
    }).catch(() => {
      // Ignorar silenciosamente desconexiones si el servidor ya se ha cerrado
    });
  }

  function startServerHeartbeat(host, port, token) {
    if (!token || !host || !port) return;
    const targetChanged = !activeHeartbeatTarget
      || activeHeartbeatTarget.host !== host
      || activeHeartbeatTarget.port !== port
      || activeHeartbeatTarget.token !== token;

    activeHeartbeatTarget = { host, port, token };
    updateNewTabLink();

    if (targetChanged) {
      sendHeartbeatPing();
    }

    if (!heartbeatTimer) {
      heartbeatTimer = setInterval(sendHeartbeatPing, HEARTBEAT_INTERVAL_MS);
    }
  }

  function stopServerHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function getNewTabUrl() {
    if (typeof window === 'undefined' || !window.location) return '';
    const base = (window.location.pathname || '') + (window.location.search || '');
    const token = (typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('zerochat_mcp_token') : null)
      || window.ChatMCP?.manager?.getSessionToken()
      || activeHeartbeatTarget?.token;
    const port = (typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('zerochat_mcp_port') : null)
      || activeHeartbeatTarget?.port
      || getRuntimeConfig()?.mcpPort
      || 6388;

    if (token) {
      return `${base}#token=${encodeURIComponent(token)}&port=${encodeURIComponent(port)}`;
    }
    return base || window.location.href;
  }

  function updateNewTabLink() {
    if (!elements?.btnSidebarNewTab) return;
    const url = getNewTabUrl();
    if (url) {
      elements.btnSidebarNewTab.href = url;
    }
  }

  function init() {
    ensureModalsMarkup();
    cacheDomElements();
    if (Debug.setElements) Debug.setElements(elements);
    if (Debug.setRawLogsEnabled) Debug.setRawLogsEnabled(appConfig.enableRawLogs);
    if (Debug.registerGlobalErrorHandlers && typeof window !== 'undefined') Debug.registerGlobalErrorHandlers(window);

    if (State.subscribe) {
      const syncGenerationControls = (streamingState) => {
        const isGenerating = Boolean(streamingState.isGenerating);
        if (UIComposer.syncGenerationControls) {
          UIComposer.syncGenerationControls(elements, isGenerating, { clearGenerationStatus });
        } else {
          if (elements.btnSend) elements.btnSend.disabled = isGenerating;
          if (elements.btnStopStream) elements.btnStopStream.style.display = isGenerating ? 'inline-flex' : 'none';
          if (!isGenerating) clearGenerationStatus();
        }
      };
      State.subscribe('streaming', syncGenerationControls);
      syncGenerationControls(State.get?.('streaming') || {});
    }

    if (Config.subscribe) {
      Config.subscribe((nextConfig, previousConfig) => {
        if (previousConfig?.apiType && previousConfig.apiType !== nextConfig?.apiType) {
          Promise.resolve(Providers.registry?.get?.(previousConfig.apiType)?.deactivate?.())
            .catch(error => console.error('Provider cleanup failed:', error));
        }
        updateUIFromConfig();
      });
    }

    loadCachedModels();
    updateUIFromConfig();
    loadSessionsFromStorage();
    setupEventListeners();

    if (window.ChatRagUI && window.ChatRagUI.initRagUI) {
      window.ChatRagUI.initRagUI();
    }

    if (window.ChatUIMcp && window.ChatUIMcp.initMcpUI) {
      window.ChatUIMcp.initMcpUI({
        statusBadge: elements.mcpStatusBadge,
        statusText: elements.mcpStatusText,
        btnConnect: elements.btnMcpConnect,
        btnDisconnect: elements.btnMcpDisconnect,
        btnConfigure: elements.btnMcpConfigure,
        mcpSetupDialog: elements.mcpSetupDialog,
        btnCloseSetup: elements.btnCloseMcpSetup,
        btnCloseSetupFooter: elements.btnCloseMcpSetupFooter,
        serverDetails: elements.mcpServerDetails,
        errorMessage: elements.mcpErrorMessage,
        hostInput: elements.mcpHostInput,
        portInput: elements.mcpPortInput,
        endpointPreview: elements.mcpEndpointPreview,
        commandSnippet: elements.mcpTerminalCommand,
        btnCopyCmd: elements.btnMcpCopyCmd,
        toolsContainer: elements.mcpToolsContainer,
        serversList: elements.mcpServersList
      });

      // Extraer token y port pasados desde zerochat.py por hash o query string
      function extractSessionParams() {
        let token = null;
        let port = null;
        try {
          if (typeof window !== 'undefined' && window.location) {
            const hashRaw = (window.location.hash || '').replace(/^#/, '');
            const hashParams = new URLSearchParams(hashRaw);
            const queryParams = new URLSearchParams(window.location.search || '');
            token = hashParams.get('token') || queryParams.get('token');
            port = hashParams.get('port') || queryParams.get('port');

            if (token && window.history && typeof window.history.replaceState === 'function') {
              // Limpiar el fragmento de la barra de direcciones para no exponer el token
              const cleanUrl = window.location.pathname + (window.location.search ? window.location.search.replace(/([?&])token=[^&]+(&|$)/, '$1').replace(/[?&]$/, '') : '');
              window.history.replaceState(null, '', cleanUrl || window.location.pathname);
            }
          }
        } catch (err) {
          console.warn('Error leyendo parámetros de sesión:', err);
        }
        return { token, port };
      }

      const initialParams = extractSessionParams();
      let incomingToken = initialParams.token;
      let incomingPort = initialParams.port;

      if (incomingToken) {
        try {
          if (typeof sessionStorage !== 'undefined') {
            sessionStorage.setItem('zerochat_mcp_token', incomingToken);
          }
        } catch (_) {}
      } else {
        try {
          if (typeof sessionStorage !== 'undefined') {
            incomingToken = sessionStorage.getItem('zerochat_mcp_token');
          }
        } catch (_) {}
      }

      if (incomingPort) {
        try {
          if (typeof sessionStorage !== 'undefined') {
            sessionStorage.setItem('zerochat_mcp_port', incomingPort);
          }
        } catch (_) {}
      } else {
        try {
          if (typeof sessionStorage !== 'undefined') {
            incomingPort = sessionStorage.getItem('zerochat_mcp_port');
          }
        } catch (_) {}
      }

      const effectiveToken = incomingToken || window.ChatMCP?.manager?.getSessionToken();
      if (effectiveToken && window.ChatMCP?.manager?.setSessionToken) {
        window.ChatMCP.manager.setSessionToken(effectiveToken);
      }

      const currentCfg = getRuntimeConfig();
      const targetPort = incomingPort ? parseInt(incomingPort, 10) : (currentCfg?.mcpPort || 6388);
      const targetHost = currentCfg?.mcpHost || '127.0.0.1';

      if ((effectiveToken || currentCfg?.mcpAutoConnect) && window.ChatMCP?.manager?.connectProxy) {
        window.ChatMCP.manager.connectProxy({
          host: targetHost,
          port: targetPort,
          token: effectiveToken,
          silentOnFailure: !effectiveToken
        });
      }

      // Iniciar latido periódico al servidor local zerochat.py si hay token de sesión activo
      if (effectiveToken) {
        startServerHeartbeat(targetHost, targetPort, effectiveToken);
      }
      updateNewTabLink();

      if (typeof window !== 'undefined' && window.addEventListener) {
        window.addEventListener('hashchange', () => {
          const updated = extractSessionParams();
          if (updated.token) {
            incomingToken = updated.token;
            try { sessionStorage.setItem('zerochat_mcp_token', updated.token); } catch (_) {}
            if (window.ChatMCP?.manager?.setSessionToken) {
              window.ChatMCP.manager.setSessionToken(updated.token);
            }
          }
          if (updated.port) {
            incomingPort = updated.port;
            try { sessionStorage.setItem('zerochat_mcp_port', updated.port); } catch (_) {}
          }
          const activeTok = updated.token || sessionStorage.getItem('zerochat_mcp_token') || window.ChatMCP?.manager?.getSessionToken();
          const activePort = updated.port ? parseInt(updated.port, 10) : (sessionStorage.getItem('zerochat_mcp_port') ? parseInt(sessionStorage.getItem('zerochat_mcp_port'), 10) : (currentCfg?.mcpPort || 6388));
          if (activeTok) {
            if (window.ChatMCP?.manager?.connectProxy) {
              window.ChatMCP.manager.connectProxy({
                host: targetHost,
                port: activePort,
                token: activeTok,
                silentOnFailure: true
              });
            }
            startServerHeartbeat(targetHost, activePort, activeTok);
            updateNewTabLink();
          }
        });
      }
    }

    window.ChatApp = {
      toggleReasoningMenu,
      updateReasoningUI,
      toggleDebugPanel,
      addDebugLog,
      clearDebugLogs,
      setDebugStatus,
      setGenerationStatus,
      clearGenerationStatus,
      applyLanguage,
      switchToSession,
      createNewSession,
      createConversationBranch,
      deleteSession,
      renameSession,
      openExecutionInfo,
      exportConversationAsMarkdown,
      exportConversationAsJson,
      exportConversationAsPrint,
      startServerHeartbeat,
      stopServerHeartbeat,
      getNewTabUrl,
      updateNewTabLink
    };

    // Fase 6: configurar light-dismiss fallback para navegadores sin closedby
    setupLightDismissDialogs();

    // Registro del Service Worker para aceleración de arranque y soporte offline en móvil
    registerServiceWorker();

    document.documentElement.classList.add('zerochat-ready');
    console.log('💬 ZeroChat initialized with autonomous tools and local Orama knowledge.');
  }

  function registerServiceWorker() {
    if (typeof window !== 'undefined' &&
        'serviceWorker' in navigator &&
        (location.protocol === 'http:' || location.protocol === 'https:')) {
      const register = () => {
        navigator.serviceWorker.register('./sw.js', { scope: './' })
          .catch(() => {});
      };
      if (document.readyState === 'complete') {
        register();
      } else {
        window.addEventListener('load', register, { once: true });
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
