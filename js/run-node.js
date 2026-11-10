/**
 * Host headless para la ejecución desatendida en Node.js (zerochat --prompt y --conversation).
 * Ensambla los módulos de dominio compartidos (ChatRunMode, ChatEngine, ChatMCP, ChatConfig, ChatState)
 * sin acoplamiento al DOM del navegador, consumiendo los adaptadores de js/headless-adapters.js.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(
      require('./utils.js'),
      require('./state.js'),
      require('./config-store.js'),
      require('./profile-repository.js'),
      require('./mcp.js'),
      require('./tool-security.js'),
      require('./tool-cards.js'),
      require('./chat-engine.js'),
      require('./export.js'),
      require('./run-mode.js'),
      require('./headless-adapters.js')
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
  const { createMemoryStorage, createHeadlessTurnView, createHeadlessConversationStore } = HeadlessAdapters;

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
    createMemoryStorage();
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
          const sessionMeta = sessionsList.find(s => s.id === activeSessionId) || { id: activeSessionId };
          await conversationStore.saveConversation(sessionMeta, loopResult.chatHistory);
        }
      }

      if (loopResult.error) {
        return { error: loopResult.error.message || String(loopResult.error) };
      }
      return { text: loopResult.finalAssistantText || '' };
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
      const messages = conversation.messages || conversation.history || [];
      const currentList = State.get('sessions')?.list || [];
      const sessionEntry = {
        id: sessionId,
        title: conversation.title || 'Conversation',
        updatedAt: conversation.updatedAt || Date.now(),
        profileId: conversation.profileId || null
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
