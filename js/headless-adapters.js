/**
 * Adaptadores de entorno headless para ejecución sin DOM (Node.js).
 * Implementa las interfaces de vista de turno (TurnView) y persistencia de conversaciones
 * consumidas por ChatEngine y ChatRunMode, abstrayendo el DOM y desacoplando la plataforma.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./utils.js'));
  } else {
    root.ChatHeadlessAdapters = factory(root.ChatUtils);
  }
}(typeof self !== 'undefined' ? self : this, function (Utils) {
  'use strict';

  const { resolveDep } = Utils;
  const getToolCards = () => resolveDep('ChatToolCards');
  const getState = () => resolveDep('ChatState', './state.js');
  const getStorage = () => resolveDep('ChatStorage', './storage.js');
  const getMCP = () => resolveDep('ChatMCP', './mcp.js');
  const getConversationService = () => resolveDep('ChatConversationService', './conversation-service.js');

  /**
   * Vista de turno desacoplada del DOM para ChatEngine.executeAgentTurnLoop.
   * Acumula el texto generado y responde a autorizaciones mediante el responder activo.
   */
  function createHeadlessTurnView(options = {}) {
    const getResponder = typeof options.getAuthorizationResponder === 'function'
      ? options.getAuthorizationResponder
      : () => getToolCards()?.getAuthorizationResponder?.() || null;

    const cards = {
      open(name, args, invocationId) {
        return {
          element: null,
          attachListeners() {},
          nest: () => cards,
          async requestAuthorization(toolCall, authorization) {
            const responder = getResponder();
            if (responder) {
              const toolName = toolCall?.function?.name || toolCall?.name || authorization?.name || name;
              const decision = responder(toolName, authorization?.args || args);
              if (decision) return decision;
            }
            return 'deny';
          },
          complete(_result, _elapsedMs) {}
        };
      }
    };

    return {
      createBlock(_options = {}) {
        let blockText = '';
        return {
          render(text, _renderOptions) {
            blockText = text;
          },
          remove() {
            blockText = '';
          },
          getText() {
            return blockText;
          }
        };
      },
      scrollToBottom() {},
      cards
    };
  }

  /**
   * Adaptador de persistencia de conversaciones contra los endpoints RPC del backend.
   */
  function createHeadlessConversationStore(requestBackend) {
    if (typeof requestBackend !== 'function') {
      throw new Error('requestBackend must be a function');
    }

    return {
      async getConversation(sessionId) {
        if (!sessionId) return null;
        const result = await requestBackend('zerochat/conversations/get', { id: sessionId });
        return result?.conversation || null;
      },
      async saveConversation(sessionMeta, messages = []) {
        if (!sessionMeta?.id) return false;
        await getStorage().saveRemoteConversation(requestBackend, sessionMeta, messages);
        return true;
      }
    };
  }

  /**
   * Gestiona el ciclo de vida de la conversación en entorno headless sobre `store`,
   * reutilizando los metadatos canónicos de ChatConversationService y ChatMCP.currentProject().
   */
  function createHeadlessSessionManager(store) {
    if (!store || typeof store.getConversation !== 'function' || typeof store.saveConversation !== 'function') {
      throw new Error('store must provide getConversation and saveConversation');
    }

    // Las grabaciones van en fila: la de un paso no puede llegar después de la del final del turno.
    let pendingSave = Promise.resolve();

    function saveActiveConversation(history) {
      const State = getState();
      const activeSessionId = State.get('sessions')?.activeId;
      if (!activeSessionId) return pendingSave;
      const list = State.get('sessions')?.list || [];
      const existing = list.find(s => s.id === activeSessionId) || null;
      const sessionMeta = getConversationService().buildSessionMetadata({
        sessionId: activeSessionId,
        existing,
        history,
        options: {
          isServerMode: () => (existing?.serverRun !== undefined ? Boolean(existing.serverRun) : true),
          getProject: () => getMCP().currentProject()
        }
      });
      State.saveSessionMetadata(sessionMeta);
      pendingSave = pendingSave.catch(() => { /* el guardado anterior ya informó de su error a quien lo esperaba */ }).then(() => store.saveConversation(sessionMeta, history));
      return pendingSave;
    }

    async function switchToSession(sessionId) {
      const conversation = await store.getConversation(sessionId);
      if (!conversation) throw new Error(`Conversation not found: ${sessionId}`);
      const State = getState();
      const messages = conversation.history || [];
      const { history: _history, ...header } = conversation;
      const currentList = State.get('sessions')?.list || [];
      const sessionEntry = {
        ...header,
        id: sessionId,
        title: header.title || 'Conversation',
        createdAt: header.createdAt || Date.now(),
        updatedAt: header.updatedAt || Date.now(),
        profileId: header.profileId || null,
        serverRun: header.serverRun !== undefined ? Boolean(header.serverRun) : true
      };
      const updatedList = currentList.some(s => s.id === sessionId)
        ? currentList.map(s => (s.id === sessionId ? { ...s, ...sessionEntry } : s))
        : [...currentList, sessionEntry];

      State.replaceConversation({
        sessionId,
        messages,
        sessions: updatedList
      });
    }

    function startNewSession(sessionId) {
      getState().replaceConversation({ sessionId, messages: [], sessions: [] });
    }

    return {
      saveActiveConversation,
      switchToSession,
      startNewSession
    };
  }

  return {
    createHeadlessTurnView,
    createHeadlessConversationStore,
    createHeadlessSessionManager
  };
}));
