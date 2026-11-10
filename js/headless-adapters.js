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
              const decision = responder(toolName);
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
        await requestBackend('zerochat/conversations/save', {
          conversation: sessionMeta,
          messages
        });
        return true;
      }
    };
  }

  return {
    createHeadlessTurnView,
    createHeadlessConversationStore
  };
}));
