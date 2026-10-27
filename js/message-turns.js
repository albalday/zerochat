/** Pure conversation-turn rules shared by state, engine, service and views. */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.ChatMessageTurns = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function extractBaseId(id) {
    if (!id || typeof id !== 'string') return '';
    return id.replace(/(?:_turn_\d+_(?:assistant|tool.*)|_final)$/, '');
  }

  // A tool result belongs to the assistant turn that opened the current run of tool results.
  function hasMatchingToolCall(messages, toolMessage) {
    if (!Array.isArray(messages) || !toolMessage) return false;
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message?.role === 'tool') continue;
      return message?.role === 'assistant' && Array.isArray(message.tool_calls) &&
        message.tool_calls.some(call => call && (call.id === toolMessage.tool_call_id ||
          (call.function && call.function.name === toolMessage.name)));
    }
    return false;
  }

  function dropOrphanToolMessages(messages) {
    if (!Array.isArray(messages)) return [];
    const sanitized = [];
    for (const message of messages) {
      if (message?.role === 'tool' && !hasMatchingToolCall(sanitized, message)) continue;
      sanitized.push(message);
    }
    return sanitized;
  }

  // Callers normalize their public selection contracts before reaching this rule.
  function removeSelectedTurn(history, { msgId = '', baseId = '', explicitIds = [] } = {}) {
    if (!Array.isArray(history)) return [];
    const ids = new Set(Array.isArray(explicitIds) || explicitIds instanceof Set ? explicitIds : []);
    if (msgId) ids.add(msgId);
    if (baseId) ids.add(baseId);
    const isTarget = message => {
      const id = message?.id;
      return Boolean(id && (ids.has(id) ||
        (baseId && id.startsWith(`${baseId}_`)) ||
        (msgId && id.startsWith(`${msgId}_`))));
    };
    const deletedCalls = new Set();
    for (const message of history) {
      if (!isTarget(message)) continue;
      if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) if (call?.id) deletedCalls.add(call.id);
      }
      if (message.role === 'tool' && message.tool_call_id) deletedCalls.add(message.tool_call_id);
    }
    const remaining = history.filter(message => message && !isTarget(message) &&
      !(message.role === 'tool' && message.tool_call_id && deletedCalls.has(message.tool_call_id)));
    return dropOrphanToolMessages(remaining);
  }

  function getLastUserPrompt(messages) {
    if (!Array.isArray(messages)) return '';
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message?.role !== 'user') continue;
      if (typeof message.content === 'string') return message.content;
      const textPart = Array.isArray(message.content) ? message.content.find(part => part?.type === 'text') : null;
      return textPart?.text || '';
    }
    return '';
  }

  /**
   * Sanea los límites de turnos en un historial:
   * 1. Descarta mensajes 'tool' huérfanos (sin llamada previa del asistente).
   * 2. Limpia tool_calls de turnos del asistente que no fueron respondidas por mensajes 'tool'
   *    (p. ej. al bifurcar o tras interrupción), evitando llamadas abiertas que provocan
   *    errores 400 en las APIs de proveedores.
   */
  function sanitizeTurnBoundaries(messages) {
    if (!Array.isArray(messages)) return [];
    const withValidTools = dropOrphanToolMessages(messages);
    const result = [];

    for (let i = 0; i < withValidTools.length; i++) {
      const current = withValidTools[i];
      if (!current) continue;

      if (current.role === 'assistant' && Array.isArray(current.tool_calls) && current.tool_calls.length > 0) {
        // Cada resultado responde a una sola llamada: la de su id o, si no la hay, la primera
        // pendiente con su nombre (llamadas paralelas a la misma herramienta).
        const answeredCalls = new Set();
        for (let j = i + 1; j < withValidTools.length; j++) {
          const next = withValidTools[j];
          if (next?.role !== 'tool') break;
          const pending = current.tool_calls.filter(call => call && !answeredCalls.has(call));
          const answered = pending.find(call => call.id === next.tool_call_id) ||
            pending.find(call => call.function?.name === next.name);
          if (answered) answeredCalls.add(answered);
        }

        const validCalls = current.tool_calls.filter(call => answeredCalls.has(call));
        if (validCalls.length === 0) {
          if (typeof current.content === 'string' && current.content.trim()) {
            const { tool_calls: _tc, ...rest } = current;
            result.push(rest);
          }
          continue;
        }

        result.push({ ...current, tool_calls: validCalls });
        continue;
      }

      result.push(current);
    }

    return result;
  }

  return { extractBaseId, hasMatchingToolCall, dropOrphanToolMessages, removeSelectedTurn, getLastUserPrompt, sanitizeTurnBoundaries };
});
