/**
 * Host headless para la ejecución desatendida en Node.js (zerochat --prompt y --conversation).
 * Ensambla los módulos de dominio compartidos (ChatRunMode, ChatEngine, ChatMCP, ChatConfig, ChatState)
 * sin acoplamiento al DOM del navegador, consumiendo los adaptadores de js/headless-adapters.js.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    // En Node.js, registrar secuencialmente en globalThis para que resolveDep resuelva en bundles estáticos
    const Utils = require('./utils.js');
    globalThis.ChatUtils = Utils;

    const MessageTurns = require('./message-turns.js');
    globalThis.ChatMessageTurns = MessageTurns;

    const Defaults = require('./defaults.js');
    globalThis.ChatDefaults = Defaults;

    const State = require('./state.js');
    globalThis.ChatState = State;

    const Storage = require('./storage.js');
    globalThis.ChatStorage = Storage;

    const ContextManager = require('./context-manager.js');
    globalThis.ChatContextManager = ContextManager;

    const Config = require('./config-store.js');
    globalThis.ChatConfig = Config;

    const ProfileRepository = require('./profile-repository.js');
    globalThis.ChatProfileRepository = ProfileRepository;

    const McpResults = require('./mcp-results.js');
    globalThis.ChatMcpResults = McpResults;

    const MCP = require('./mcp.js');
    globalThis.ChatMCP = MCP;

    const HeadlessIcons = {
      get: () => ''
    };
    globalThis.ChatIcons = HeadlessIcons;

    const I18n = require('./i18n.js');
    globalThis.ChatI18n = I18n;

    let authorizationResponder = null;
    const HeadlessToolCards = {
      setAuthorizationResponder: responder => {
        authorizationResponder = responder;
      },
      getAuthorizationResponder: () => authorizationResponder,
      createMcpToolView: () => null,
      getUrlArg: args => args?.url || args?.URL || args?.uri || args?.link || args?.href || args?.path || args?.input || '',
      createWebRequestView: () => ({ createLiveCard: () => null, updateLiveCard: () => null }),
      createTextResultView: () => ({ createLiveCard: () => null, updateLiveCard: () => null }),
      renderCardHtml: () => '',
      renderStatusBadge: () => {}
    };
    globalThis.ChatToolCards = HeadlessToolCards;

    const HeadlessCommandCard = {
      parseResult: raw => {
        const text = typeof raw === 'string' ? raw : (typeof raw?.content === 'string' ? raw.content : null);
        if (!text) return null;
        try {
          const data = JSON.parse(text);
          return data && typeof data === 'object' && typeof data.status === 'string' ? data : null;
        } catch (_) {
          return null;
        }
      },
      formatDuration: () => '',
      isFailure: state => state?.status === 'timeout' || state?.status === 'error' || (state?.status === 'exited' && state?.exitCode !== 0),
      createView: () => ({ createLiveCard: () => null, renderHistoryCard: () => null }),
      createWaitView: () => ({ createLiveCard: () => null, renderHistoryCard: () => null })
    };
    globalThis.ChatCommandCard = HeadlessCommandCard;

    const Markdown = require('./markdown.js');
    globalThis.ChatMarkdown = Markdown;

    const FileParser = require('./file-parser.js');
    globalThis.ChatFileParser = FileParser;

    const OfficeParser = require('./office-parser.js');
    globalThis.ChatOfficeParser = OfficeParser;

    const ToolSecurity = require('./tool-security.js');
    globalThis.ChatToolSecurity = ToolSecurity;

    const ProjectContext = require('./project-context.js');
    globalThis.ChatProjectContext = ProjectContext;

    const Providers = require('./providers.js');
    globalThis.ChatProviders = Providers;

    const TextToolCalls = require('./text-tool-calls.js');
    globalThis.ChatTextToolCalls = TextToolCalls;

    const API = require('./api.js');
    globalThis.ChatAPI = API;

    const WebSearch = require('./web-search.js');
    globalThis.ChatWebSearch = WebSearch;

    const WebBrowser = require('./web-browser.js');
    globalThis.ChatWebBrowser = WebBrowser;

    const SearchWebTool = require('./tools/builtin/search-web.tool.js');
    globalThis.ChatBuiltinSearchWebTool = SearchWebTool;

    const FetchWebPageTool = require('./tools/builtin/fetch-web-page.tool.js');
    globalThis.ChatBuiltinFetchWebPageTool = FetchWebPageTool;

    const DownloadDocTool = require('./tools/builtin/download-doc.tool.js');
    globalThis.ChatBuiltinDownloadDocTool = DownloadDocTool;

    const DownloadImageTool = require('./tools/builtin/download-image.tool.js');
    globalThis.ChatBuiltinDownloadImageTool = DownloadImageTool;

    const AskUserTool = require('./tools/builtin/ask-user.tool.js');
    globalThis.ChatBuiltinAskUserTool = AskUserTool;

    const DelegateTaskTool = require('./tools/builtin/delegate-task.tool.js');
    globalThis.ChatBuiltinDelegateTaskTool = DelegateTaskTool;

    const ExecuteJavascriptTool = require('./tools/builtin/execute-javascript.tool.js');
    globalThis.ChatBuiltinExecuteJavascriptTool = ExecuteJavascriptTool;

    const RenderChartTool = require('./tools/builtin/render-chart.tool.js');
    globalThis.ChatBuiltinRenderChartTool = RenderChartTool;

    const disabledTools = [
      { globalName: 'ChatBuiltinListDocumentsTool', name: 'list_documents' },
      { globalName: 'ChatBuiltinSearchKnowledgeBaseTool', name: 'search_knowledge_base' },
      { globalName: 'ChatBuiltinReadKnowledgeChunkTool', name: 'read_knowledge_chunk' },
      { globalName: 'ChatBuiltinReadKnowledgeImageTool', name: 'read_knowledge_image' }
    ];
    for (const { globalName, name } of disabledTools) {
      if (!globalThis[globalName]) {
        globalThis[globalName] = {
          definition: { name, description: '' },
          isAvailable: () => false,
          settings: { showInSettings: false },
          execute: async () => ({ error: 'Tool not supported in headless environment' })
        };
      }
    }

    if (!globalThis.ChatSandbox) {
      globalThis.ChatSandbox = require('./sandbox.js');
    }
    if (!globalThis.ChatRagService) {
      globalThis.ChatRagService = {};
    }

    const AgentCore = require('./agent-core.js');
    globalThis.ChatAgentCore = AgentCore;

    const Engine = require('./chat-engine.js');
    globalThis.ChatEngine = Engine;

    const Export = require('./export.js');
    globalThis.ChatExport = Export;

    const HeadlessAdapters = require('./headless-adapters.js');
    globalThis.ChatHeadlessAdapters = HeadlessAdapters;

    const RunMode = require('./run-mode.js');
    globalThis.ChatRunMode = RunMode;

    module.exports = factory(
      Utils,
      State,
      Config,
      ProfileRepository,
      MCP,
      ToolSecurity,
      HeadlessToolCards,
      Engine,
      Export,
      RunMode,
      HeadlessAdapters
    );
  } else {
    root.ChatRunNode = factory(
      root.ChatUtils,
      root.ChatState,
      root.ChatConfig,
      root.ChatProfileRepository,
      root.ChatMCP,
      root.ChatToolSecurity,
      root.ChatToolCards,
      root.ChatEngine,
      root.ChatExport,
      root.ChatRunMode,
      root.ChatHeadlessAdapters
    );
  }
}(typeof self !== 'undefined' ? self : this, function (
  Utils,
  State,
  Config,
  ProfileRepository,
  MCP,
  ToolSecurity,
  ToolCards,
  Engine,
  Export,
  RunMode,
  HeadlessAdapters
) {
  'use strict';
  const { readLaunchFragment } = Utils;
  const { createHeadlessTurnView, createHeadlessConversationStore } = HeadlessAdapters;

  /**
   * Extrae los parámetros de conexión y ejecución a partir de argumentos CLI o URL de arranque.
   */
  function parseRunArgs(argv = []) {
    let host = '127.0.0.1';
    let port = null;
    let token = '';
    let runId = '';

    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      if (arg.startsWith('http://') || arg.startsWith('https://') || arg.startsWith('#')) {
        const hashIdx = arg.indexOf('#');
        const hashPart = hashIdx !== -1 ? arg.slice(hashIdx) : '';
        if (hashPart) {
          const params = readLaunchFragment(hashPart);
          host = params.get('host') || host;
          port = params.get('port') ? Number(params.get('port')) : port;
          token = params.get('token') || token;
          runId = params.get('run') || runId;
        }
      } else if (arg === '--url' && i + 1 < argv.length) {
        const targetUrl = argv[++i];
        const hashIdx = targetUrl.indexOf('#');
        if (hashIdx !== -1) {
          const params = readLaunchFragment(targetUrl.slice(hashIdx));
          host = params.get('host') || host;
          port = params.get('port') ? Number(params.get('port')) : port;
          token = params.get('token') || token;
          runId = params.get('run') || runId;
        }
      } else if (arg === '--host' && i + 1 < argv.length) {
        host = argv[++i];
      } else if (arg === '--port' && i + 1 < argv.length) {
        port = Number(argv[++i]);
      } else if (arg === '--token' && i + 1 < argv.length) {
        token = argv[++i];
      } else if (arg === '--run' && i + 1 < argv.length) {
        runId = argv[++i];
      }
    }

    return { host, port, token, runId };
  }

  /**
   * Ejecuta el runner desatendido conectándose al backend Python y orquestando el bucle agéntico.
   */
  async function startHeadlessRun(argv = [], runOptions = {}) {
    const params = parseRunArgs(argv);
    const host = runOptions.host || params.host;
    const port = runOptions.port || params.port;
    const token = runOptions.token || params.token;
    const runId = runOptions.runId || params.runId;

    if (!port || !token || !runId) {
      throw new Error(`Missing required run parameters: port=${port}, token=${Boolean(token)}, runId=${Boolean(runId)}`);
    }

    const backendUrl = `http://${host}:${port}/`;
    let currentAbortController = null;
    let cleanExit = null;

    if (typeof globalThis.window === 'undefined') {
      globalThis.window = {
        close: () => {
          if (cleanExit) cleanExit();
          if (typeof process !== 'undefined' && typeof process.exit === 'function') {
            process.exit(0);
          }
        }
      };
    }

    const stopGeneration = () => {
      if (currentAbortController) currentAbortController.abort();
    };

    if (typeof process !== 'undefined' && typeof process.on === 'function') {
      const onSignal = () => {
        stopGeneration();
        if (typeof process.exit === 'function') process.exit(130);
      };
      process.once('SIGINT', onSignal);
      process.once('SIGTERM', onSignal);
      cleanExit = () => {
        process.removeListener('SIGINT', onSignal);
        process.removeListener('SIGTERM', onSignal);
      };
    }

    const requestBackend = (method, rpcParams = {}, options = {}) =>
      MCP.manager.requestExternalControl(method, rpcParams, options);

    const conversationStore = createHeadlessConversationStore(requestBackend);

    const connectBackend = async () => {
      ToolSecurity.manager.setSessionToken(token);
      return MCP.manager.connectProxy({
        url: backendUrl,
        proxyKey: null,
        token,
        silentOnFailure: true
      });
    };

    const activateSessionProfile = async profileId => {
      Config.activateProfile(profileId, { sessionOnly: true });
      const activeConfig = Config.getActive();
      const { started = [], unavailable = [] } = await MCP.manager.startProfileServers(activeConfig);
      return { started, unavailable };
    };

    const submitComposerText = async (text, sendOptions = {}) => {
      const resume = Boolean(sendOptions.resume);
      if (text && !resume) {
        State.appendMessage({ id: `msg_${Date.now()}`, role: 'user', content: text });
      }

      const activeConfig = Config.getActive();
      const activeProfile = await ProfileRepository.loadUnlocked(activeConfig.activeProfile?.id);
      if (activeProfile?.settings?.apiType === 'webllm' || activeConfig.apiType === 'webllm') {
        return { error: 'WebLLM / WebGPU is not supported in the headless Node.js runner. Use --browser instead.' };
      }
      currentAbortController = new AbortController();

      const view = createHeadlessTurnView({
        getAuthorizationResponder: () => ToolCards.getAuthorizationResponder?.() || null
      });

      const loopResult = await Engine.executeAgentTurnLoop({
        apiKey: activeProfile?.settings?.apiKey || '',
        chatHistory: State.get('messages'),
        appConfig: activeConfig,
        assistantMsgId: `asst_${Date.now()}`,
        signal: currentAbortController.signal,
        view,
        onProgress: sendOptions.onProgress,
        onGenerationStatus: update => {
          sendOptions.onProgress?.({
            kind: update.phase === 'tool' ? 'tool' : 'status',
            text: update.text || update.phase || ''
          });
        }
      });

      if (loopResult.chatHistory) {
        State.replaceMessages(loopResult.chatHistory);
        const activeSessionId = State.get('sessions')?.activeId;
        if (activeSessionId) {
          const sessionsList = State.get('sessions')?.list || [];
          const currentMeta = sessionsList.find(s => s.id === activeSessionId) || { id: activeSessionId };
          const activeConfig = Config.getActive();
          const activeProfileId = currentMeta.profileId || activeConfig?.activeProfile?.id || activeConfig?.activeProfile?.name || null;
          const isServerRun = currentMeta.serverRun !== undefined ? Boolean(currentMeta.serverRun) : true;
          const sessionMeta = {
            ...currentMeta,
            updatedAt: Date.now(),
            messageCount: loopResult.chatHistory.length,
            profileId: activeProfileId,
            serverRun: isServerRun
          };
          await conversationStore.saveConversation(sessionMeta, loopResult.chatHistory);
        }
      }

      if (loopResult.loopDetected) {
        return { error: 'The agent loop was stopped after repeated tool calls.' };
      }
      if (loopResult.error) {
        return { error: loopResult.error.message || String(loopResult.error) };
      }
      return { text: loopResult.finalAssistantText || loopResult.accumulatedMarkdown || '' };
    };

    const exportConversation = async format => {
      const activeSessionId = State.get('sessions')?.activeId;
      const sessionsList = State.get('sessions')?.list || [];
      const sessionMeta = sessionsList.find(s => s.id === activeSessionId) || { id: activeSessionId, title: 'Run' };
      const history = State.get('messages');
      const activeConfig = Config.getActive();
      const result = await Export.buildConversationExport(format, sessionMeta, history, activeConfig);
      return result?.content || '';
    };

    const switchToSession = async sessionId => {
      const conversation = await conversationStore.getConversation(sessionId);
      if (!conversation) throw new Error(`Conversation not found: ${sessionId}`);
      const messages = conversation.history || [];
      const currentList = State.get('sessions')?.list || [];
      const sessionEntry = {
        id: sessionId,
        title: conversation.title || 'Conversation',
        createdAt: conversation.createdAt || Date.now(),
        updatedAt: conversation.updatedAt || Date.now(),
        profileId: conversation.profileId || null,
        serverRun: conversation.serverRun !== undefined ? Boolean(conversation.serverRun) : true
      };
      const updatedList = currentList.some(s => s.id === sessionId)
        ? currentList.map(s => (s.id === sessionId ? { ...s, ...sessionEntry } : s))
        : [...currentList, sessionEntry];

      State.replaceConversation({
        sessionId,
        messages,
        sessions: updatedList
      });
    };

    const startupConnection = connectBackend();

    return RunMode.start(runId, {
      startupConnection,
      connectBackend,
      sessionsLoaded: Promise.resolve(),
      activateSessionProfile,
      submitComposerText,
      stopGeneration,
      exportConversation,
      switchToSession
    });
  }

  if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
    startHeadlessRun(process.argv.slice(2)).catch(error => {
      console.error('[RunNode] Fatal error:', error);
      process.exit(1);
    });
  }

  return {
    parseRunArgs,
    startHeadlessRun
  };
}));
