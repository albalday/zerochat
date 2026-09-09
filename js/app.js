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
  const State = window.ChatState || {};
  const ContextManager = window.ChatContextManager || {};
  const AgentCore = window.ChatAgentCore || {};
  const Engine = window.ChatEngine || {};
  const UIReasoning = window.ChatUIReasoning || {};
  const UIInspector = window.ChatUIInspector || {};
  const UISidebar = window.ChatUISidebar || {};
  const UISettings = window.ChatUISettings || {};
  const Config = window.ChatConfig || {};
  const Profiles = window.ChatProfileRepository || {};

  function t(key, params) {
    if (I18n.t) return I18n.t(key, params);
    return key;
  }

  function getMsgIcon(name, size = 12) {
    if (typeof window !== 'undefined' && window.ChatIcons && window.ChatIcons.has(name)) {
      return window.ChatIcons.get(name, { size });
    }
    return '';
  }

  // Estado de la aplicación
  const fallbackConfig = {
    apiUrl: 'http://localhost:1234/v1',
    apiType: 'openai',
    apiKey: '',
    model: '',
    systemPrompt: '',
    systemDataPrompt: '',
    temperature: '0.7',
    reasoningEffort: 'none',
    theme: 'light',
    language: 'es',
    enabledTools: {
      execute_javascript: true,
      search_web: true,
      fetch_web_page: true,
      download_pdf: true,
      render_chart: true
    },
    enableRawLogs: false,
    enableDebugMessages: false,
    activeRagBranchId: ''
  };

  if (Config.initialize) Config.initialize();

  function getRuntimeConfig() {
    return Config.getActive ? Config.getActive() : { ...fallbackConfig };
  }

  // Transitional read-through facade for legacy helpers inside this module.
  // It owns no data: every read is resolved from the canonical runtime store.
  const appConfig = new Proxy({}, {
    get: (_target, key) => getRuntimeConfig()[key],
    ownKeys: () => Reflect.ownKeys(getRuntimeConfig()),
    getOwnPropertyDescriptor: (_target, key) => ({ enumerable: true, configurable: true, value: getRuntimeConfig()[key] })
  });

  let currentAbortController = null;

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

      activeProfileSelect: document.getElementById('active-profile-select'),
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
      btnCloneProfile: document.getElementById('btn-clone-profile'),
      btnSaveProfile: document.getElementById('btn-save-profile'),
      btnDeleteProfile: document.getElementById('btn-delete-profile'),
      profileActionFeedback: document.getElementById('profile-action-feedback'),
      settingApiType: document.getElementById('setting-api-type'),
      settingApiUrl: document.getElementById('setting-api-url'),
      btnQueryServer: document.getElementById('btn-query-server'),
      serverQueryStatus: document.getElementById('server-query-status'),
      settingApiKey: document.getElementById('setting-api-key'),
      settingModel: document.getElementById('setting-model'),
      modelDatalist: document.getElementById('model-datalist'),
      modelSelectHelper: document.getElementById('model-select-helper'),
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
      settingEnableRawLogs: document.getElementById('setting-enable-raw-logs'),
      mcpStatusBadge: document.getElementById('mcp-status-badge'),
      mcpStatusText: document.getElementById('mcp-status-text'),
      btnMcpConnect: document.getElementById('btn-mcp-connect'),
      btnMcpDisconnect: document.getElementById('btn-mcp-disconnect'),
      mcpServerDetails: document.getElementById('mcp-server-details'),
      mcpErrorMessage: document.getElementById('mcp-error-message'),
      mcpHostInput: document.getElementById('mcp-host-input'),
      mcpPortInput: document.getElementById('mcp-port-input'),
      mcpOsSelect: document.getElementById('mcp-os-select'),
      mcpEndpointPreview: document.getElementById('mcp-endpoint-preview'),
      mcpTerminalCommand: document.getElementById('mcp-terminal-command'),
      mcpOsInstructions: document.getElementById('mcp-os-instructions'),
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

  function getRagSystemContext() {
    return State.get ? (State.get('agent')?.ragSystemContext || '') : '';
  }

  function setRagSystemContext(context) {
    if (State.set) State.set('agent', { ragSystemContext: typeof context === 'string' ? context : '' });
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

  function isDateTimeInitialTurn(m) {
    if (!m || m.role !== 'user') return false;
    const content = typeof m.content === 'string' ? m.content : (m.content?.[0]?.text || '');
    return content.startsWith('La fecha y hora actual es:') ||
           content.startsWith('Fecha y hora actual:') ||
           content.startsWith('The current date and time is:') ||
           content.startsWith('Current date and time:');
  }

  function createInitialChatHistory() {
    return [
      { id: 'system_root', role: 'system', content: getConfiguredSystemPrompt(),
        contextDateAnchor: Engine.getConversationDateAnchor(appConfig.language || 'es') }
    ];
  }

  function initializeSessionState(sessionId, history, blockedMessageKey) {
    const initialization = State.replaceConversation
      ? State.replaceConversation({ sessionId, messages: history })
      : (State.initializeConversation
          ? State.initializeConversation({ sessionId, messages: history })
          : { ok: true });

    if (!initialization.ok) {
      ChatDialogs.alert(t(blockedMessageKey));
      return false;
    }

    clearAttachedFiles();
    closeReasoningMenu();
    clearDebugLogs();
    setDebugStatus('idle');
    toggleDebugPanel(false);
    resetTelemetryDisplay({ syncState: false });
    return true;
  }

  function blockSessionTransitionIfBusy(messageKey) {
    const isBusy = State.isConversationBusy?.() === true;
    if (!isBusy) return false;
    ChatDialogs.alert(t(messageKey));
    return true;
  }

  // ==========================================================================
  // Modelos y Consulta al Servidor (API Query & Combobox)
  // ==========================================================================

  function loadCachedModels() {
    if (UIInspector.loadCachedModels) {
      return UIInspector.loadCachedModels(elements, appConfig);
    }
    return [];
  }

  async function handleQueryServer() {
    if (UIInspector.handleQueryServer) {
      await UIInspector.handleQueryServer(elements, appConfig);
    }
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
      UIReasoning.toggleReasoningMenu(elements, appConfig, selectReasoningLevel, toggleCheckpointAgent);
    }
  }

  function selectReasoningLevel(level) {
    if (UIReasoning.selectReasoningLevel) {
      UIReasoning.selectReasoningLevel(elements, getRuntimeConfig(), level, (reasoningEffort) => {
        if (Config.updateRuntime) Config.updateRuntime({ reasoningEffort });
      });
    }
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
    if (elements.activeProfileSelect && Profiles.list) {
      const active = config.activeProfile?.id || '';
      const editLabel = ChatI18n?.t ? ChatI18n.t('edit_profiles') : 'Editar perfiles';
      const profileOptions = Profiles.list().map(profile => `<option value="${Markdown.escapeHtml(profile.id)}"${profile.id === active ? ' selected' : ''}>${Markdown.escapeHtml(profile.name)}</option>`).join('');
      elements.activeProfileSelect.innerHTML = `${profileOptions}<option value="__edit_profiles__">${Markdown.escapeHtml(editLabel)}</option>`;
      if (active) {
        elements.activeProfileSelect.value = active;
      }
    }
    if (elements.settingsActiveProfileName) {
      elements.settingsActiveProfileName.textContent = config.activeProfile?.name || t('connection_no_active_profile');
    }
    if (elements.settingApiType) {
      elements.settingApiType.value = config.apiType || 'openai';
    }
    if (elements.settingApiUrl) {
      elements.settingApiUrl.value = config.apiUrl || 'http://localhost:1234/v1';
    }
    if (elements.settingApiKey) {
      elements.settingApiKey.value = config.apiKey || '';
    }
    if (elements.settingModel) {
      elements.settingModel.value = config.model || '';
    }
    if (elements.modelSelectHelper && config.model) {
      elements.modelSelectHelper.value = config.model;
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
    if (elements.messagesList) {
      elements.messagesList.scrollTop = elements.messagesList.scrollHeight;
    }
  }

  // ==========================================================================
  // Gestión de Archivos Adjuntos
  // ==========================================================================

  function renderAttachedFiles() {
    if (Attachments.renderChips) {
      Attachments.renderChips(elements.attachmentsContainer, () => autoResizeTextarea());
    }
  }

  function clearAttachedFiles() {
    if (Attachments.clearFiles) {
      Attachments.clearFiles();
      renderAttachedFiles();
    }
    if (elements.fileInput) elements.fileInput.value = '';
  }

  async function processFiles(files) {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        let parsed;
        if (FileParser.parseFile) {
          parsed = await FileParser.parseFile(file);
        } else {
          const text = await readFileAsText(file);
          parsed = {
            name: file.name,
            size: file.size,
            type: 'text',
            content: text
          };
        }
        if (Attachments.addFile) Attachments.addFile(parsed);
      } catch (err) {
        console.error(`Error processing file ${file.name}:`, err);
        ChatDialogs.alert(t('err_file_process', { name: file.name, err: err.message || err }), { type: 'error' });
      }
    }
    renderAttachedFiles();
    if (elements.userInput) elements.userInput.focus();
  }

  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsText(file);
    });
  }

  // ==========================================================================
  // Renderizado de Mensajes con Acciones y Estadísticas
  // ==========================================================================

  function extractBaseId(id) {
    if (!id || typeof id !== 'string') return '';
    return id.replace(/(?:_turn_\d+_(?:assistant|tool.*)|_final)$/, '');
  }

  function removeMessage(wrapper) {
    if (!wrapper) return;
    const msgId = wrapper.getAttribute('data-msg-id') || '';
    const baseId = wrapper.getAttribute('data-base-id') || extractBaseId(msgId);
    const rawMsgIds = wrapper.getAttribute('data-msg-ids') || '';
    const explicitIds = rawMsgIds ? rawMsgIds.split(',').filter(Boolean) : [];

    wrapper.remove();

    if (explicitIds.length > 0 || baseId || msgId) {
      let removedCount = 0;
      if (State.removeTurn) {
        const res = State.removeTurn({ msgId, baseId, explicitIds });
        removedCount = res.removedCount || 0;
      }
      if (removedCount > 0 && typeof addDebugLog === 'function') {
        addDebugLog('system', t('msg_deleted_log', { id: msgId || baseId, count: removedCount }));
      }
    }

    const remainingMessages = elements.messagesList.querySelectorAll('.message-wrapper');
    if (remainingMessages.length === 0 && elements.welcomeBanner) {
      elements.messagesList.appendChild(elements.welcomeBanner);
      elements.welcomeBanner.style.display = 'block';
    }

    // Persistir eliminación en el almacenamiento de la sesión
    saveCurrentSession();
  }

  function appendUserMessage(text, originalPrompt, attachedImages, existingMsgId) {
    if (elements.welcomeBanner && elements.welcomeBanner.parentNode) {
      elements.welcomeBanner.style.display = 'none';
    }

    const msgId = existingMsgId || ((typeof crypto !== 'undefined' && crypto.randomUUID)
      ? 'msg_usr_' + crypto.randomUUID()
      : 'msg_usr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9));

    const wrapper = document.createElement('div');
    wrapper.className = 'message-wrapper user';
    wrapper.setAttribute('data-msg-id', msgId);

    const row = document.createElement('div');
    row.className = 'message-row user';

    const contentWrapper = document.createElement('div');
    contentWrapper.className = 'message-content-wrapper';

    const content = document.createElement('div');
    content.className = 'message-content';
    content.textContent = text;

    // Miniaturas visuales de imágenes adjuntas
    if (attachedImages && attachedImages.length > 0) {
      const imagesGrid = document.createElement('div');
      imagesGrid.className = 'message-images-grid';
      attachedImages.forEach(img => {
        const itemDiv = document.createElement('div');
        itemDiv.className = 'message-image-item';
        itemDiv.innerHTML = `
          <img src="${img.dataUrl}" alt="${Markdown.escapeHtml(img.name)}" class="message-image-thumb" title="${Markdown.escapeHtml(img.name)}">
          <div class="message-image-caption">${Markdown.escapeHtml(img.name)}</div>
        `;
        const imgEl = itemDiv.querySelector('img');
        if (imgEl) {
          imgEl.addEventListener('click', () => {
            window.open(img.dataUrl, '_blank');
          });
        }
        imagesGrid.appendChild(itemDiv);
      });
      content.appendChild(imagesGrid);
    }

    const footerRow = document.createElement('div');
    footerRow.className = 'message-footer-row';

    const actions = document.createElement('div');
    actions.className = 'message-actions';

    const btnReuse = document.createElement('button');
    btnReuse.type = 'button';
    btnReuse.className = 'btn-msg-action';
    btnReuse.innerHTML = getMsgIcon('edit', 14);
    btnReuse.title = t('btn_reuse_title');
    btnReuse.setAttribute('aria-label', t('btn_reuse_title'));
    btnReuse.addEventListener('click', () => {
      elements.userInput.value = originalPrompt || text;
      autoResizeTextarea();
      elements.userInput.focus();
    });

    const btnDelete = document.createElement('button');
    btnDelete.type = 'button';
    btnDelete.className = 'btn-msg-action btn-delete';
    btnDelete.innerHTML = getMsgIcon('trash', 14);
    btnDelete.title = t('btn_delete_usr_title');
    btnDelete.setAttribute('aria-label', t('btn_delete_usr_title'));
    btnDelete.addEventListener('click', () => removeMessage(wrapper));

    actions.appendChild(btnReuse);
    actions.appendChild(btnDelete);
    footerRow.appendChild(actions);

    contentWrapper.appendChild(content);
    contentWrapper.appendChild(footerRow);

    row.appendChild(contentWrapper);
    wrapper.appendChild(row);

    elements.messagesList.appendChild(wrapper);
    // Animar solo mensajes nuevos en tiempo real (no historial)
    if (!existingMsgId) {
      wrapper.classList.add('is-new-message');
      wrapper.addEventListener('animationend', () => wrapper.classList.remove('is-new-message'), { once: true });
    }
    scrollToBottom();

    return msgId;
  }

  function createAssistantMessagePlaceholder(existingMsgId) {
    const rawId = existingMsgId || ((typeof crypto !== 'undefined' && crypto.randomUUID)
      ? 'msg_ast_' + crypto.randomUUID()
      : 'msg_ast_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9));
    const baseId = extractBaseId(rawId) || rawId;
    const msgId = existingMsgId ? rawId : baseId;

    const wrapper = document.createElement('div');
    wrapper.className = 'message-wrapper assistant';
    wrapper.setAttribute('data-msg-id', msgId);
    wrapper.setAttribute('data-base-id', baseId);

    const row = document.createElement('div');
    row.className = 'message-row assistant';

    const contentWrapper = document.createElement('div');
    contentWrapper.className = 'message-content-wrapper';

    const content = document.createElement('div');
    content.className = 'message-content';
    content.innerHTML = '<span class="streaming-cursor initial-cursor"></span>';

    const footerRow = document.createElement('div');
    footerRow.className = 'message-footer-row';

    const statsContainer = document.createElement('div');
    statsContainer.className = 'message-stats';
    statsContainer.style.display = 'none';

    const actions = document.createElement('div');
    actions.className = 'message-actions';
    actions.style.display = 'none';

    const btnCopy = document.createElement('button');
    btnCopy.type = 'button';
    btnCopy.className = 'btn-msg-action btn-copy-full';
    btnCopy.innerHTML = getMsgIcon('copy', 14);
    btnCopy.title = t('btn_copy_title');
    btnCopy.setAttribute('aria-label', t('btn_copy_title'));

    const btnDelete = document.createElement('button');
    btnDelete.type = 'button';
    btnDelete.className = 'btn-msg-action btn-delete';
    btnDelete.innerHTML = getMsgIcon('trash', 14);
    btnDelete.title = t('btn_delete_ast_title');
    btnDelete.setAttribute('aria-label', t('btn_delete_ast_title'));
    btnDelete.addEventListener('click', () => removeMessage(wrapper));

    actions.appendChild(btnCopy);
    actions.appendChild(btnDelete);

    footerRow.appendChild(statsContainer);
    footerRow.appendChild(actions);

    contentWrapper.appendChild(content);
    contentWrapper.appendChild(footerRow);

    row.appendChild(contentWrapper);
    wrapper.appendChild(row);

    elements.messagesList.appendChild(wrapper);
    // Animar solo mensajes nuevos en tiempo real (no historial)
    if (!existingMsgId) {
      wrapper.classList.add('is-new-message');
      wrapper.addEventListener('animationend', () => wrapper.classList.remove('is-new-message'), { once: true });
    }
    scrollToBottom();

    return { wrapper, row, content, footerRow, actions, btnCopy, statsContainer, msgId };
  }

  // ==========================================================================
  // Envío de Mensaje y Streaming
  // ==========================================================================

  async function handleSendMessage() {
    const rawText = elements.userInput.value.trim();
    const currentFiles = Attachments.getFiles ? Attachments.getFiles() : [];
    if ((!rawText && currentFiles.length === 0) || State.isConversationBusy?.()) return;
    // One immutable snapshot per turn prevents profile changes from modifying
    // an in-flight request.
    const runtimeConfig = getRuntimeConfig();

    const { fullPrompt, displayText, imageAttachments } = Attachments.buildAttachmentsPayload
      ? Attachments.buildAttachmentsPayload(rawText, currentFiles)
      : { fullPrompt: rawText, displayText: rawText, imageAttachments: [] };

    const userMsgId = appendUserMessage(displayText, rawText, imageAttachments);
    const historyEntry = { id: userMsgId, role: 'user', content: fullPrompt };
    if (imageAttachments.length > 0) {
      historyEntry.images = imageAttachments;
    }
    if (State.appendMessage) {
      State.appendMessage(historyEntry);
    }

    const generationSessionId = getCurrentSessionId();

    elements.userInput.value = '';
    clearAttachedFiles();
    autoResizeTextarea();
    closeReasoningMenu();

    State.set('streaming', { isGenerating: true, status: 'streaming', error: null });

    currentAbortController = new AbortController();
    // Mostrar indicador de escritura hasta que llegue el primer chunk
    showTypingIndicator();
    const { wrapper, row, content, actions, btnCopy, statsContainer, msgId: assistantMsgId } = createAssistantMessagePlaceholder();
    removeTypingIndicator();
    const attachListeners = (el) => attachListenersToContainer(el);

    if (!API.streamChatCompletion) {
      row.classList.add('message-error');
      content.innerHTML = 'Error: Chat API module not loaded.';
      finishGeneration();
      return;
    }

    if (!runtimeConfig.model || runtimeConfig.model.trim() === '') {
      row.classList.add('message-error');
      content.innerHTML = `
        <div style="display:flex; align-items:flex-start; gap:0.5rem;">
          <span>⚠️</span>
          <div>
            <strong>${t('err_no_model_title')}</strong>
            <p style="margin-top: 0.25rem;">${t('err_no_model_desc', { url: runtimeConfig.apiUrl })}</p>
          </div>
        </div>
      `;
      actions.style.display = 'inline-flex';
      finishGeneration();
      return;
    }

    function updateStatsDisplay(stats) {
      if (!stats) return;
      statsContainer.style.display = 'inline-flex';
      const clockSvg = getMsgIcon('clock', 11);
      const zapSvg = getMsgIcon('zap', 11);
      const docSvg = getMsgIcon('file-text', 11);
      const dbSvg = getMsgIcon('database', 11);

      const cacheHtml = (stats.cachedTokens && stats.cachedTokens > 0)
        ? `<span>•</span><span class="stat-item stat-item-cache" title="${t('stat_cache_title')}">${dbSvg} <span>${t('stat_cache_tokens', { tokens: stats.cachedTokens })}</span></span>`
        : '';
      statsContainer.innerHTML = `
        <span class="stat-item" title="${t('stat_ttft_title')}">${clockSvg} <span>${t('stat_ttft', { sec: stats.ttftSec })}</span></span>
        <span>•</span>
        <span class="stat-item" title="${t('stat_speed_title')}">${zapSvg} <span>${t('stat_speed', { speed: stats.tokensPerSec })}</span></span>
        <span>•</span>
        <span class="stat-item" title="${t('stat_total_time_title')}">${clockSvg} <span>${t('stat_total_time', { sec: stats.totalSec })}</span></span>
        <span>•</span>
        <span class="stat-item" title="${t('stat_tokens_title')}">${docSvg} <span>${t('stat_tokens', { tokens: stats.tokens })}</span></span>${cacheHtml}
      `;
      updateConnectionTokensBadge(stats);
    }

    const activeRagBranchIds = Array.isArray(runtimeConfig.activeRagBranchIds)
      ? runtimeConfig.activeRagBranchIds
      : (runtimeConfig.activeRagBranchId ? [runtimeConfig.activeRagBranchId] : []);
    const activeRagBranchId = activeRagBranchIds[0] || runtimeConfig.activeRagBranchId || '';

    // Cargar únicamente la instrucción compacta de las ramas activas.
    if (activeRagBranchIds.length > 0 && window.ChatRagService && window.ChatRagService.buildRagSystemContext) {
      try {
        setRagSystemContext(await window.ChatRagService.buildRagSystemContext(activeRagBranchIds, {
          isCheckpointEnabled: !!(runtimeConfig.enabledTools && runtimeConfig.enabledTools.agent_checkpoint),
          lang: runtimeConfig.language || 'es'
        }));
      } catch (err) {
        console.warn('Error al cargar contexto inicial de RAG:', err);
        setRagSystemContext('');
      }
    } else {
      setRagSystemContext('');
    }

    try {
      const runner = window.ChatEngine || Engine;
      const loopResult = await runner.executeAgentTurnLoop({
        apiUrl: runtimeConfig.apiUrl,
        apiType: runtimeConfig.apiType,
        apiKey: runtimeConfig.apiKey,
        model: runtimeConfig.model,
        temperature: runtimeConfig.temperature,
        reasoningEffort: runtimeConfig.reasoningEffort || 'none',
        maxAgentTurns: runtimeConfig.maxAgentTurns ? Number(runtimeConfig.maxAgentTurns) : 15,
        chatHistory: getChatHistory(),
        appConfig: runtimeConfig,
        assistantMsgId: assistantMsgId,
        activeRagBranchId: activeRagBranchId,
        activeRagBranchIds: activeRagBranchIds,
        currentRagSystemContext: getRagSystemContext(),
        signal: currentAbortController.signal,
        container: content,

        onBeforeRequest: runtimeConfig.enableDebugMessages ? async function ({ endpoint, headers, payload }) {
          return await openDebugInterceptorModal({ endpoint, headers, payload });
        } : null,

        onReasoningChunk: function (chunk) {
          if (getCurrentSessionId() !== generationSessionId) return;
          addDebugLog('thinking', chunk);
          setDebugStatus('streaming', t('debug_status_thinking'));
        },

        onLog: function (type, text) {
          if (getCurrentSessionId() !== generationSessionId) return;
          addDebugLog(type, text);
        },

        onStats: function (stats) {
          if (getCurrentSessionId() !== generationSessionId) return;
          updateStatsDisplay(stats);
        },

        onChunk: function ({ turnIndex, fullText, delta, stats }) {
          if (getCurrentSessionId() !== generationSessionId) return;
          if (stats) updateStatsDisplay(stats);
          scrollToBottom();
        },

        scrollToBottom: () => scrollToBottom(),
        attachListeners: (el) => attachListeners(el)
      });

      if (getCurrentSessionId() !== generationSessionId) {
        console.warn('[ZeroChat] Inferencia descartada por cambio de sesión.');
        return;
      }

      if (loopResult && Array.isArray(loopResult.chatHistory) && State.replaceMessages) {
        State.replaceMessages(loopResult.chatHistory);
      }

      if (loopResult && loopResult.cancelled) {
        if (wrapper && !wrapper.querySelector('.agentic-turn-block') && wrapper.parentNode) {
          wrapper.parentNode.removeChild(wrapper);
        }
        setDebugStatus('idle');
        return;
      }

      if (loopResult && loopResult.error) {
        if (currentAbortController && currentAbortController.signal.aborted) {
          return;
        }
        setDebugStatus('error', t('debug_status_error'));
        addDebugLog('error', loopResult.error.message || String(loopResult.error));
        row.classList.add('message-error');
        content.innerHTML = `
          <div class="network-error-card">
            <span>⚠️</span>
            <div>
              <strong>${t('err_server_connect_title')}</strong>
              <p style="margin-top: 0.25rem;">
                ${Markdown.escapeHtml ? Markdown.escapeHtml(loopResult.error.message || String(loopResult.error)) : String(loopResult.error)}
              </p>
              <p style="margin-top: 0.25rem; font-size: 0.75rem; color: var(--text-muted);">
                ${t('err_server_connect_hint', { url: appConfig.apiUrl })}
              </p>
            </div>
          </div>
        `;
        actions.style.display = 'inline-flex';
        return;
      }

      if (loopResult && loopResult.stats) {
        updateStatsDisplay(loopResult.stats);
        updateConnectionTokensBadge(loopResult.stats, loopResult.contextDiagnostics, { forcePopover: true });
      }

      actions.style.display = 'inline-flex';
      btnCopy.onclick = async () => {
        try {
          const fullMd = loopResult?.accumulatedMarkdown || loopResult?.finalAssistantText || '';
          await navigator.clipboard.writeText(fullMd);
          btnCopy.innerHTML = getMsgIcon('check', 14);
          btnCopy.title = t('copied_text');
          btnCopy.setAttribute('aria-label', t('copied_text'));
          btnCopy.classList.add('copied');
          setTimeout(() => {
            btnCopy.innerHTML = getMsgIcon('copy', 14);
            btnCopy.title = t('btn_copy_title');
            btnCopy.setAttribute('aria-label', t('btn_copy_title'));
            btnCopy.classList.remove('copied');
          }, 2000);
        } catch (err) {
          console.error('Error copying composite response:', err);
        }
      };

      setDebugStatus('done', t('debug_status_done'));
    } catch (err) {
      console.error('[ZeroChat] Error durante inferencia agéntica:', err);
      if (!(currentAbortController && currentAbortController.signal.aborted)) {
        setDebugStatus('error', t('debug_status_error'));
        addDebugLog('error', err.message || String(err));
        row.classList.add('message-error');
        content.innerHTML = `
          <div class="network-error-card">
            <span>⚠️</span>
            <div>
              <strong>${t('err_server_connect_title')}</strong>
              <p style="margin-top: 0.25rem;">
                ${Markdown.escapeHtml ? Markdown.escapeHtml(err.message || String(err)) : String(err)}
              </p>
              <p style="margin-top: 0.25rem; font-size: 0.75rem; color: var(--text-muted);">
                ${t('err_server_connect_hint', { url: appConfig.apiUrl })}
              </p>
            </div>
          </div>
        `;
        actions.style.display = 'inline-flex';
      }
    } finally {
      finishGeneration({ skipSave: getCurrentSessionId() !== generationSessionId });
    }
  }

  function finishGeneration({ skipSave = false } = {}) {
    removeTypingIndicator(); // Seguridad: limpiar si quedó activo
    State.set('streaming', { isGenerating: false, status: 'idle' });
    if (elements.btnSend) elements.btnSend.disabled = false;
    if (elements.btnStopStream) elements.btnStopStream.style.display = 'none';

    currentAbortController = null;
    if (elements.userInput) elements.userInput.focus();
    if (!skipSave) {
      try {
        saveCurrentSession();
      } catch (saveErr) {
        console.warn('[ZeroChat] Error al guardar sesión en finishGeneration:', saveErr);
      }
    }
    scrollToBottom();
  }

  function handleStopGeneration() {
    if (currentAbortController) {
      currentAbortController.abort();
    }
  }

  // ==========================================================================
  // Modal de Configuración & Gestión de Perfiles
  // ==========================================================================

  /**
   * Puebla el combobox auxiliar y el datalist con todos los perfiles disponibles.
   */
  function populateProfileSelector(selectedProfileName) {
    if (!Profiles.list) return;
    const profiles = Profiles.list();

    if (elements.profileDatalist) {
      elements.profileDatalist.innerHTML = '';
      profiles.forEach(profile => {
        const opt = document.createElement('option');
        opt.value = profile.name;
        elements.profileDatalist.appendChild(opt);
      });
    }

    if (elements.profileSelectHelper) {
      elements.profileSelectHelper.innerHTML = `<option value="" disabled data-i18n="profile_select_default">▾ Elegir perfil guardado...</option>`;
      profiles.forEach(profile => {
        const opt = document.createElement('option');
        opt.value = profile.id;
        opt.textContent = profile.name;
        if (profile.id === selectedProfileName) {
          opt.selected = true;
        }
        elements.profileSelectHelper.appendChild(opt);
      });
    }

    if (elements.settingProfileName) {
      const selected = profiles.find(profile => profile.id === selectedProfileName);
      elements.settingProfileName.value = selected?.name || '';
    }
    if (elements.settingProfileDescription) {
      const selected = profiles.find(profile => profile.id === selectedProfileName);
      elements.settingProfileDescription.value = selected?.description || '';
    }
  }

  function applyProfileToForm(profileData) {
    if (UISettings.applyProfileToForm) {
      UISettings.applyProfileToForm(elements, profileData);
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

    const currentHistory = getChatHistory();
    if (currentHistory.length > 0 && currentHistory[0].role === 'system') {
      currentHistory[0].content = getConfiguredSystemPrompt(savedConfig);
      if (State.replaceMessages) {
        State.replaceMessages(currentHistory);
      }
    }

    updateUIFromConfig();

    if (typeof populateProfileSelector === 'function') {
      populateProfileSelector(savedConfig.activeProfile?.id || '');
    }

    if (closeModal) {
      closeSettingsModal();
    } else {
      showProfileFeedback(t('msg_profile_saved', { name: savedConfig.activeProfile?.name || 'actual' }) || 'Configuración actualizada.', 'success');
    }
  }

  function handleSaveProfile() {
    const name = String(elements.settingProfileName?.value || '').trim();
    if (!name || !Profiles.save) return false;
    const selected = Profiles.get?.(elements.profileSelectHelper?.value || '') || null;
    const sameName = Profiles.findByName?.(name) || null;
    if (selected && sameName && sameName.id !== selected.id) {
      showProfileFeedback(t('err_profile_name_exists', { name }) || `Ya existe un perfil llamado "${name}".`, 'error');
      return false;
    }
    // El selector mantiene la identidad del perfil en edición, incluso si se renombra.
    const existing = selected || sameName;
    const baseSettings = existing?.settings || getRuntimeConfig();
    const saved = Profiles.save({
      id: existing?.id || `profile:${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name,
      description: elements.settingProfileDescription?.value.trim() || '',
      settings: {
        ...baseSettings,
        apiType: elements.settingApiType?.value || baseSettings.apiType,
        apiUrl: elements.settingApiUrl?.value.trim() || baseSettings.apiUrl,
        apiKey: elements.settingApiKey?.value.trim() || '',
        model: elements.settingModel?.value.trim() || '',
        systemPrompt: elements.settingSystemPrompt?.value.trim() || '',
        temperature: elements.settingTemperature?.value || baseSettings.temperature || '0.7',
        maxAgentTurns: elements.settingMaxAgentTurns?.value ? Number(elements.settingMaxAgentTurns.value) : (baseSettings.maxAgentTurns || 15)
      }
    });
    populateProfileSelector(saved.id);
    setSelectedProfileAsDefault(saved);
    showProfileFeedback(t('msg_profile_saved', { name }) || `Perfil "${name}" guardado con éxito.`, 'success');
    return true;
  }

  function activateProfileTab(tabBtn) {
    const targetPane = document.getElementById(tabBtn?.getAttribute('data-profile-tab'));
    if (!targetPane) return;
    const isNameTab = targetPane.id === 'profile-tab-name-pane';
    elements.profileTabs.forEach(button => {
      const active = button === tabBtn;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    });
    elements.profilePanes.forEach(pane => pane.classList.toggle('active', pane === targetPane));
    [elements.btnNewProfile, elements.btnCloneProfile].forEach(button => {
      if (button) button.disabled = !isNameTab;
    });
  }

  function setSelectedProfileAsDefault(profile) {
    if (!profile || !Config.activateProfile) return;
    Config.activateProfile(profile.id);
    updateUIFromConfig();
  }

  async function handleDeleteProfile() {
    const id = elements.profileSelectHelper?.value || '';
    const profile = Profiles.get ? Profiles.get(id) : null;
    if (!profile || !await ChatDialogs.confirm(t('confirm_delete_profile', { name: profile.name }))) return;
    const currentProfile = Profiles.get ? Profiles.get(id) : null;
    if (!currentProfile || currentProfile.name !== profile.name) return;
    if (Profiles.remove?.(currentProfile.id)) {
      populateProfileSelector('');
      showProfileFeedback(t('msg_profile_deleted', { name: currentProfile.name }) || `Perfil "${currentProfile.name}" eliminado.`, 'success');
      updateUIFromConfig();
    }
  }

  async function requestNewProfileName(message) {
    const name = String(await ChatDialogs.prompt(message) || '').trim();
    if (!name) return null;
    if (Profiles.findByName?.(name)) {
      showProfileFeedback(t('err_profile_name_exists', { name }) || `Ya existe un perfil llamado "${name}".`, 'error');
      return null;
    }
    return name;
  }

  function saveProfileRecord(name, settings, description = '') {
    if (!Profiles.save) return null;
    const saved = Profiles.save({
      id: `profile:${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name,
      description,
      settings
    });
    populateProfileSelector(saved.id);
    applyProfileToForm(saved.settings);
    setSelectedProfileAsDefault(saved);
    return saved;
  }

  async function handleNewProfile() {
    const name = await requestNewProfileName(t('prompt_new_profile_name') || 'Nombre del nuevo perfil:');
    if (!name) return;
    const saved = saveProfileRecord(name, Profiles.NEW_PROFILE_SETTINGS || { apiType: 'openai', apiUrl: '', apiKey: '', model: '' });
    if (saved) showProfileFeedback(t('msg_profile_created', { name }) || `Perfil "${name}" creado.`, 'success');
  }

  async function handleCloneProfile() {
    const source = Profiles.get?.(elements.profileSelectHelper?.value || '');
    if (!source) {
      showProfileFeedback(t('err_profile_select_to_clone') || 'Selecciona un perfil para clonarlo.', 'error');
      return;
    }
    const name = await requestNewProfileName(t('prompt_clone_profile_name', { name: source.name }) || `Nombre de la copia de "${source.name}":`);
    if (!name) return;
    const saved = saveProfileRecord(name, source.settings, source.description || '');
    if (saved) showProfileFeedback(t('msg_profile_cloned', { name }) || `Perfil clonado como "${name}".`, 'success');
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
    if (!elements.profilesDialog) return;
    const activeId = getRuntimeConfig().activeProfile?.id || '';
    populateProfileSelector(activeId);
    const activeProfile = Profiles.get?.(activeId);
    applyProfileToForm(activeProfile?.settings || getRuntimeConfig());
    if (elements.serverQueryStatus) elements.serverQueryStatus.style.display = 'none';
    if (elements.profileActionFeedback) elements.profileActionFeedback.style.display = 'none';
    activateProfileTab(document.getElementById('profile-tab-name'));
    if (typeof loadCachedModels === 'function') loadCachedModels();
    if (typeof elements.profilesDialog.showModal === 'function') elements.profilesDialog.showModal();
  }

  function closeProfilesModal() {
    if (elements.profilesDialog?.open && typeof elements.profilesDialog.close === 'function') {
      elements.profilesDialog.close();
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
    let sessionsList = [];
    try {
      await Storage.initDB();
      sessionsList = await Storage.getConversationsList();
    } catch (e) {
      console.warn('Error al cargar sesiones de chat:', e);
      sessionsList = [];
    }

    if (!Array.isArray(sessionsList)) {
      sessionsList = [];
    }

    // Siempre iniciar en un chat nuevo al abrir o recargar la página (F5 / Ctrl+F5)
    const nextSessionId = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? 'session_' + crypto.randomUUID()
      : 'session_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    const initialHistory = createInitialChatHistory();

    if (State.initializeConversation) {
      State.initializeConversation({ sessionId: nextSessionId, sessions: sessionsList, messages: initialHistory });
    }

    renderSessionMessages(getChatHistory());
    renderSidebarChats();
  }

  async function saveCurrentSession() {
    const history = getChatHistory();
    const currId = getCurrentSessionId();
    const sessionsList = getSavedSessions();

    // Comprobar si hay preguntas reales del usuario además de los turnos de inicialización de fecha/hora
    const hasRealUserMessages = Array.isArray(history) && history.some(m => {
      if (!m || m.role !== 'user') return false;
      return !isDateTimeInitialTurn(m);
    });
    
    // Si la conversación no tiene preguntas reales del usuario, no guardarla como sesión activa en el sidebar
    if (!hasRealUserMessages) {
      if (State.removeSession) {
        State.removeSession(currId);
      }
      await Storage.deleteConversation(currId);
      renderSidebarChats();
      return;
    }

    let sess = sessionsList.find(s => s.id === currId);
    const now = Date.now();
    if (!sess) {
      sess = {
        id: currId,
        title: t('chat_untitled') || 'Nueva conversación',
        createdAt: now,
        updatedAt: now,
        messageCount: history.length
      };
    } else {
      sess = Object.assign({}, sess, {
        updatedAt: now,
        messageCount: history.length
      });
    }

    // Auto-generar título a partir del primer mensaje real del usuario
    const isUntitled = !sess.title ||
      sess.title === t('chat_untitled') ||
      sess.title === 'Nueva conversación' ||
      sess.title === 'New conversation';

    if (isUntitled && history.length > 1) {
      const firstRealUser = history.find(m => m.role === 'user' && !isDateTimeInitialTurn(m));
      if (firstRealUser && firstRealUser.content) {
        const rawContent = typeof firstRealUser.content === 'string' ? firstRealUser.content : (firstRealUser.content[0]?.text || '');
        const candidate = rawContent.split('\n')[0].replace(/[#*`_>\[\]]/g, '').trim();
        if (candidate) {
          sess.title = candidate.length > 35 ? candidate.substring(0, 32) + '…' : candidate;
        }
      }
    }

    if (State.saveSessionMetadata) {
      State.saveSessionMetadata(sess);
    }
    await Storage.saveConversation(sess, history);

    renderSidebarChats();
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

  async function switchToSession(sessionId) {
    if (sessionId === getCurrentSessionId()) return;
    if (blockSessionTransitionIfBusy('chat_switch_blocked_generating')) return false;
    await saveCurrentSession();

    let targetConv = null;
    if (Storage.getConversation) {
      targetConv = await Storage.getConversation(sessionId);
    }

    if (!targetConv) {
      const found = getSavedSessions().find(s => s.id === sessionId);
      if (found && found.history) targetConv = found;
    }

    if (!targetConv) return;

    const restoredHistory = targetConv.history && targetConv.history.length > 0 ? [...targetConv.history] : [
      { id: 'system_root', role: 'system', content: getConfiguredSystemPrompt() }
    ];

    Engine.ensureConversationDate(restoredHistory, appConfig.language || 'es', targetConv.createdAt);

    if (!initializeSessionState(targetConv.id, restoredHistory, 'chat_switch_blocked_generating')) return false;
    renderSessionMessages(getChatHistory());
    renderSidebarChats();

    if (window.innerWidth < 900) {
      closeSidebar();
    }
    return true;
  }

  async function createNewSession({ saveCurrent = true } = {}) {
    if (blockSessionTransitionIfBusy('chat_new_blocked_generating')) return false;

    if (saveCurrent) await saveCurrentSession();

    const nextSessionId = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? 'session_' + crypto.randomUUID()
      : 'session_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    const nextHistory = createInitialChatHistory();
    if (!initializeSessionState(nextSessionId, nextHistory, 'chat_new_blocked_generating')) return false;
    renderSessionMessages(getChatHistory());
    renderSidebarChats();

    if (elements.userInput) {
      elements.userInput.value = '';
      autoResizeTextarea();
      elements.userInput.focus();
    }

    if (window.innerWidth < 900) {
      closeSidebar();
    }
    return true;
  }

  async function deleteSession(sessionId, event) {
    if (event) event.stopPropagation();
    if (!await ChatDialogs.confirm(t('chat_delete_confirm'))) return;
    if (blockSessionTransitionIfBusy('chat_delete_blocked_generating')) return;

    const currId = getCurrentSessionId();
    if (State.removeSession) {
      const res = State.removeSession(sessionId);
      if (!res.ok && res.reason === 'generation-active') {
        ChatDialogs.alert(t('chat_delete_blocked_generating'));
        return;
      }
    }

    await Storage.deleteConversation(sessionId);

    const remainingSessions = getSavedSessions();
    if (remainingSessions.length === 0) {
      await createNewSession({ saveCurrent: false });
    } else if (currId === sessionId) {
      const next = remainingSessions[0];
      await switchToSession(next.id);
    } else {
      renderSidebarChats();
    }
  }

  async function deleteAllSessions() {
    const sessionsList = getSavedSessions();
    if (!sessionsList || sessionsList.length === 0) return;
    if (blockSessionTransitionIfBusy('chat_delete_blocked_generating')) return;
    if (!await ChatDialogs.confirm(t('chat_delete_all_confirm'))) return;
    if (blockSessionTransitionIfBusy('chat_delete_blocked_generating')) return;

    const deleted = await Storage.deleteAllConversations();
    if (!deleted) {
      ChatDialogs.alert(t('chat_delete_history_err'), { type: 'error' });
      return;
    }

    if (State.set) {
      State.set('sessions', { activeId: null, list: [] });
    }

    await createNewSession({ saveCurrent: false });
  }

  async function renameSession(sessionId, event) {
    if (event) event.stopPropagation();
    let sess = getSavedSessions().find(s => s.id === sessionId);
    if (!sess) return;

    const newTitle = await ChatDialogs.prompt(t('prompt_rename_conversation'), sess.title || '');
    if (newTitle !== null && newTitle.trim() !== '') {
      sess = getSavedSessions().find(s => s.id === sessionId);
      if (!sess) return;
      sess.title = newTitle.trim();
      sess.updatedAt = Date.now();
      if (State.saveSessionMetadata) {
        State.saveSessionMetadata(sess);
      }
      if (Storage.renameConversation) {
        await Storage.renameConversation(sessionId, sess.title);
      }
      renderSidebarChats();
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

  function renderStoredToolCard(tc, toolMsg) {
    if (ToolCards.renderHistoricalToolCard) {
      return ToolCards.renderHistoricalToolCard(tc, toolMsg);
    }
    return null;
  }

  function attachListenersToContainer(container) {
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
    if (!elements.messagesList) return;
    elements.messagesList.innerHTML = '';

    // Filtrar system messages y omitir del chat visual el par inicial de fecha/hora
    const nonSystem = (history || []).filter(m => m && m.role !== 'system');
    let validMessages = nonSystem;
    if (nonSystem.length >= 2 && isDateTimeInitialTurn(nonSystem[0]) && nonSystem[1].role === 'assistant' && (nonSystem[1].content === 'OK' || nonSystem[1].content === 'OK.')) {
      validMessages = nonSystem.slice(2);
    }

    if (validMessages.length === 0) {
      if (elements.welcomeBanner) {
        elements.messagesList.appendChild(elements.welcomeBanner);
        elements.welcomeBanner.style.display = 'block';
      }
      resetTelemetryDisplay();
      return;
    }

    if (elements.welcomeBanner) {
      elements.welcomeBanner.style.display = 'none';
    }

    // Agrupar mensajes en turnos: Usuario y Bloques del Asistente (incluyendo tool_calls y tools)
    let i = 0;
    while (i < validMessages.length) {
      const msg = validMessages[i];

      if (msg.role === 'user') {
        let text = '';
        let images = msg.images || [];
        if (typeof msg.content === 'string') {
          text = msg.content;
        } else if (Array.isArray(msg.content)) {
          const textPart = msg.content.find(c => c.type === 'text');
          text = textPart ? textPart.text : '';
          msg.content.forEach(c => {
            if (c.type === 'image_url' && c.image_url?.url) {
              if (!images.some(img => img.dataUrl === c.image_url.url)) {
                images.push({ name: 'Imagen adjunta', dataUrl: c.image_url.url });
              }
            }
          });
        }
        appendUserMessage(text, text, images, msg.id);
        i++;
      } else {
        // Bloque del Asistente (puede incluir múltiples turnos internos, llamadas a herramientas y resultados)
        const assistantGroup = [];
        const firstAssistantId = msg.id || ('msg_ast_' + Date.now());

        while (i < validMessages.length && validMessages[i].role !== 'user') {
          const item = validMessages[i];
          if (item && !item.id) {
            item.id = (typeof crypto !== 'undefined' && crypto.randomUUID)
              ? 'msg_ast_' + crypto.randomUUID()
              : 'msg_ast_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
          }
          assistantGroup.push(item);
          i++;
        }

        const groupMsgIds = assistantGroup.map(m => m.id).filter(Boolean);
        let groupBaseId = '';
        for (const item of assistantGroup) {
          if (item.id) {
            const base = extractBaseId(item.id);
            if (base && base !== item.id) {
              groupBaseId = base;
              break;
            }
          }
        }
        if (!groupBaseId && assistantGroup.length > 0 && assistantGroup[0].id) {
          groupBaseId = extractBaseId(assistantGroup[0].id) || assistantGroup[0].id;
        }

        const { wrapper, content, actions, btnCopy } = createAssistantMessagePlaceholder(groupBaseId || firstAssistantId);
        if (groupBaseId) {
          wrapper.setAttribute('data-base-id', groupBaseId);
        }
        if (groupMsgIds.length > 0) {
          wrapper.setAttribute('data-msg-ids', groupMsgIds.join(','));
        }
        content.innerHTML = ''; // Limpiar el cursor inicial de streaming

        let fullAssistantMarkdown = '';

        for (let g = 0; g < assistantGroup.length; g++) {
          const item = assistantGroup[g];

          if (item.role === 'assistant') {
            // 1. Si tiene contenido de texto (razonamiento, tablas markdown, texto normal)
            if (item.content) {
              const turnBlock = document.createElement('div');
              turnBlock.className = 'agentic-turn-block';
              turnBlock.innerHTML = Markdown.renderMarkdown ? Markdown.renderMarkdown(item.content) : item.content;
              content.appendChild(turnBlock);
              fullAssistantMarkdown += (fullAssistantMarkdown ? '\n\n' : '') + item.content;
            }

            // 2. Si tiene llamadas a herramientas (tool_calls)
            if (Array.isArray(item.tool_calls) && item.tool_calls.length > 0) {
              item.tool_calls.forEach(tc => {
                // Buscar el mensaje 'tool' correspondiente
                const toolMsg = assistantGroup.find(m => m.role === 'tool' && (m.tool_call_id === tc.id || m.name === tc.function?.name));
                const cardEl = renderStoredToolCard(tc, toolMsg);
                if (cardEl) {
                  content.appendChild(cardEl);
                }
              });
            }
          }
        }

        // Si no se generó ningún contenido visual en el asistente
        if (content.children.length === 0) {
          content.innerHTML = `<p><em>${Markdown.escapeHtml ? Markdown.escapeHtml(t('no_text_response')) : t('no_text_response')}</em></p>`;
        }

        // Configurar botón de copia
        if (btnCopy) {
          btnCopy.onclick = async () => {
            if (navigator.clipboard) {
              await navigator.clipboard.writeText(fullAssistantMarkdown || content.innerText);
              btnCopy.innerHTML = getMsgIcon('check', 14);
              btnCopy.title = t('copied_text');
              btnCopy.setAttribute('aria-label', t('copied_text'));
              btnCopy.classList.add('copied');
              setTimeout(() => {
                btnCopy.innerHTML = getMsgIcon('copy', 14);
                btnCopy.title = t('btn_copy_title');
                btnCopy.setAttribute('aria-label', t('btn_copy_title'));
                btnCopy.classList.remove('copied');
              }, 2000);
            }
          };
        }

        if (actions) actions.style.display = 'inline-flex';

        // Adjuntar listeners de código, ejecución y minimizado de herramientas
        attachListenersToContainer(content);
      }
    }

    scrollToBottom();
    updateConnectionTokensBadge(null, null, { forcePopover: true });
  }

  // ==========================================================================
  // Modal de Exportación e Importación de Conversaciones
  // ==========================================================================

  function getExportTargetSessionId() {
    return elements.exportModal?.dataset?.sessionId || getCurrentSessionId();
  }

  function openExportModal(targetSessionId = null) {
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
    const id = getExportTargetSessionId();
    if (id === getCurrentSessionId()) {
      return { sess: getSavedSessions().find(s => s.id === id), history: getChatHistory() };
    }
    const conv = (Storage && Storage.getConversation) ? await Storage.getConversation(id) : null;
    return { sess: conv, history: conv?.history || [] };
  }

  async function exportConversationAsMarkdown() {
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
    const targetId = getExportTargetSessionId();
    closeExportModal();
    if (targetId && targetId !== getCurrentSessionId()) {
      await switchToSession(targetId);
    }
    setTimeout(() => {
      window.print();
    }, 200);
  }

  function handleImportFileSelected(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;

    if (blockSessionTransitionIfBusy('chat_import_blocked_generating')) {
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
    if (!e.clipboardData || !e.clipboardData.items) return;
    const items = e.clipboardData.items;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type && items[i].type.startsWith('image/')) {
        const file = items[i].getAsFile();
        if (file) {
          e.preventDefault();
          if (FileParser.parseFile) {
            FileParser.parseFile(file).then(parsed => {
              if (Attachments.addFile) Attachments.addFile(parsed);
              renderAttachedFiles();
            }).catch(err => {
              console.error('Error pasting image:', err);
            });
          }
        }
      }
    }
  }

  // ==========================================================================
  // Ajuste Dinámico de Altura de Viewport (Android / Tablets / iOS / Teclados)
  // ==========================================================================

  function updateViewportHeight() {
    let vh = window.innerHeight;
    if (window.visualViewport) {
      vh = window.visualViewport.height;
    }
    document.documentElement.style.setProperty('--app-height', `${vh}px`);
  }

  function setupViewportListeners() {
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
    // Fallback para navegadores sin soporte de closedby="any"
    // Solo actúa si el atributo no está soportado
    document.querySelectorAll('dialog:not(#notice-dialog)').forEach(dialog => {
      dialog.addEventListener('click', e => {
        // Si el clic fue directamente en el fondo del dialog (no en su contenido)
        if (e.target === dialog) {
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
      if (!elements.btnComposerMcp) return;
      const st = mcpState || State.get('mcp') || {};
      const status = st.status || 'disconnected';
      elements.btnComposerMcp.classList.remove('mcp-connected', 'mcp-connecting', 'mcp-disconnected', 'mcp-error');
      elements.btnComposerMcp.classList.add(`mcp-${status}`);
      const labelKey = `mcp_status_${status}`;
      const statusText = ChatI18n?.t ? ChatI18n.t(labelKey) : status;
      elements.btnComposerMcp.title = `MCP: ${statusText}`;
      elements.btnComposerMcp.setAttribute('aria-label', `MCP: ${statusText}`);
    }
    State.subscribe('mcp', (newState) => updateComposerMcpState(newState));
    updateComposerMcpState(State.get('mcp'));
    window.addEventListener('zerochat:languagechange', () => {
      updateComposerMcpState(State.get('mcp'));
      if (elements.activeProfileSelect) {
        const editOpt = elements.activeProfileSelect.querySelector('option[value="__edit_profiles__"]');
        if (editOpt) {
          editOpt.textContent = ChatI18n?.t ? ChatI18n.t('edit_profiles') : 'Editar perfiles';
        }
      }
    });


    // Barra Lateral de Chats (Sidebar)
    if (elements.btnToggleSidebar) {
      elements.btnToggleSidebar.addEventListener('click', toggleSidebar);
    }
    if (elements.activeProfileSelect) {
      const profileBadge = elements.activeProfileSelect.closest('.composer-profile-badge');
      if (profileBadge) {
        profileBadge.addEventListener('click', (event) => {
          if (event.target !== elements.activeProfileSelect) {
            if (typeof elements.activeProfileSelect.showPicker === 'function') {
              try {
                elements.activeProfileSelect.showPicker();
              } catch (_) {}
            }
          }
        });
      }
      elements.activeProfileSelect.addEventListener('change', function () {
        if (!this.value) return;
        if (this.value === '__edit_profiles__') {
          const activeId = getRuntimeConfig().activeProfile?.id || '';
          const hasOption = Array.from(this.options).some(o => o.value === activeId);
          if (activeId && hasOption) {
            this.value = activeId;
          } else if (this.options.length > 1) {
            this.selectedIndex = 0;
          }
          openProfilesModal();
          return;
        }
        if (!Config.activateProfile) return;
        Config.activateProfile(this.value);
      });
    }
    if (elements.btnCloseSidebar) {
      elements.btnCloseSidebar.addEventListener('click', closeSidebar);
    }
    if (elements.btnSidebarNewChat) {
      elements.btnSidebarNewChat.addEventListener('click', createNewSession);
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
      elements.btnCloseProfiles.addEventListener('click', closeProfilesModal);
    }
    if (elements.btnCancelProfiles) {
      elements.btnCancelProfiles.addEventListener('click', closeProfilesModal);
    }
    if (elements.profilesDialog) {
      elements.profilesDialog.addEventListener('click', function (e) {
        if (e.target === elements.profilesDialog) closeProfilesModal();
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
      });
    }

    if (elements.settingProfileName) {
      elements.settingProfileName.addEventListener('change', function () {
        const typedName = this.value.trim();
        if (!typedName) return;
        if (Profiles.findByName) {
          const profile = Profiles.findByName(typedName);
          if (profile) {
            applyProfileToForm(profile.settings);
            if (elements.profileSelectHelper) {
              elements.profileSelectHelper.value = profile.id;
            }
            if (elements.settingProfileDescription) {
              elements.settingProfileDescription.value = profile.description || '';
            }
            setSelectedProfileAsDefault(profile);
          }
        }
      });
    }

    if (elements.btnSaveProfile) {
      elements.btnSaveProfile.addEventListener('click', (e) => {
        e.preventDefault();
        if (handleSaveProfile()) closeProfilesModal();
      });
    }

    if (elements.btnNewProfile) {
      elements.btnNewProfile.addEventListener('click', handleNewProfile);
    }

    if (elements.btnCloneProfile) {
      elements.btnCloneProfile.addEventListener('click', handleCloneProfile);
    }

    if (elements.btnDeleteProfile) {
      elements.btnDeleteProfile.addEventListener('click', (e) => {
        e.preventDefault();
        handleDeleteProfile();
      });
    }

    if (elements.settingApiType) {
      elements.settingApiType.addEventListener('change', function () {
        const val = this.value;
        const currentUrl = elements.settingApiUrl ? elements.settingApiUrl.value.trim() : '';

        const isDefaultOrEmpty = !currentUrl ||
          currentUrl === 'http://localhost:1234/v1' ||
          currentUrl === 'http://localhost:11434' ||
          currentUrl === 'https://api.openai.com/v1' ||
          currentUrl === 'https://openrouter.ai/api/v1' ||
          currentUrl === 'https://api.anthropic.com/v1' ||
          currentUrl === 'https://generativelanguage.googleapis.com/v1beta/openai';

        if (isDefaultOrEmpty && elements.settingApiUrl) {
          if (val === 'openai') elements.settingApiUrl.value = 'http://localhost:1234/v1';
          else if (val === 'ollama') elements.settingApiUrl.value = 'http://localhost:11434';
          else if (val === 'openrouter') elements.settingApiUrl.value = 'https://openrouter.ai/api/v1';
          else if (val === 'claude') elements.settingApiUrl.value = 'https://api.anthropic.com/v1';
          else if (val === 'gemini') elements.settingApiUrl.value = 'https://generativelanguage.googleapis.com/v1beta/openai';
        }
      });
    }

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
      });
    }

    if (elements.settingModel) {
      elements.settingModel.addEventListener('input', function () {
        const val = this.value.trim();
        if (elements.modelSelectHelper) {
          elements.modelSelectHelper.value = val;
        }
      });

      elements.settingModel.addEventListener('change', function () {
        const val = this.value.trim();
        if (elements.modelSelectHelper) {
          elements.modelSelectHelper.value = val;
        }
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
      elements.btnToggleKey.textContent = isPass ? '🔒' : '👁️';
    });

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
  }

  function ensureModalsMarkup() {
    if (UISettings && typeof UISettings.ensureDialogMarkup === 'function') UISettings.ensureDialogMarkup();
    if (window.ChatUIMcp && typeof window.ChatUIMcp.ensureDialogMarkup === 'function') window.ChatUIMcp.ensureDialogMarkup();
    if (window.ChatRagUI && typeof window.ChatRagUI.ensureDialogMarkup === 'function') window.ChatRagUI.ensureDialogMarkup();
    if (window.ChatExport && typeof window.ChatExport.ensureDialogMarkup === 'function') window.ChatExport.ensureDialogMarkup();
    if (Debug && typeof Debug.ensureDialogMarkup === 'function') Debug.ensureDialogMarkup();
  }

  function init() {
    ensureModalsMarkup();
    cacheDomElements();
    if (Debug.setElements) Debug.setElements(elements);
    if (Debug.setRawLogsEnabled) Debug.setRawLogsEnabled(appConfig.enableRawLogs);

    if (State.subscribe) {
      State.subscribe('streaming', (streamingState) => {
        const isGenerating = Boolean(streamingState.isGenerating);
        if (elements.btnSend) elements.btnSend.disabled = isGenerating;
        if (elements.btnStopStream) elements.btnStopStream.style.display = isGenerating ? 'inline-flex' : 'none';
      });
    }

    if (Config.subscribe) {
      Config.subscribe((nextConfig) => {
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
        mcpOsSelect: elements.mcpOsSelect,
        endpointPreview: elements.mcpEndpointPreview,
        commandSnippet: elements.mcpTerminalCommand,
        osInstructions: elements.mcpOsInstructions,
        btnCopyCmd: elements.btnMcpCopyCmd,
        toolsContainer: elements.mcpToolsContainer
      });
      const currentCfg = getRuntimeConfig();
      if (window.ChatMCP?.manager?.connectProxy) {
        window.ChatMCP.manager.connectProxy({
          host: currentCfg?.mcpHost || '127.0.0.1',
          port: currentCfg?.mcpPort || 6388,
          silentOnFailure: true
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
      applyLanguage,
      switchToSession,
      createNewSession,
      deleteSession,
      renameSession,
      exportConversationAsMarkdown,
      exportConversationAsJson,
      exportConversationAsPrint
    };

    // Fase 6: configurar light-dismiss fallback para navegadores sin closedby
    setupLightDismissDialogs();

    console.log('💬 ZeroChat initialized with autonomous tools and local Orama knowledge.');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
