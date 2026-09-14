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

  function isDateTimeInitialTurn(message) {
    if (!message || message.role !== 'user') return false;
    const content = typeof message.content === 'string' ? message.content : (message.content?.[0]?.text || '');
    return content.startsWith('La fecha y hora actual es:') ||
      content.startsWith('Fecha y hora actual:') ||
      content.startsWith('The current date and time is:') ||
      content.startsWith('Current date and time:');
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
    const sanitized = [];
    for (const message of remaining) {
      if (message.role === 'tool') {
        const previous = sanitized[sanitized.length - 1];
        const matches = previous?.role === 'assistant' && Array.isArray(previous.tool_calls) &&
          previous.tool_calls.some(call => call && (call.id === message.tool_call_id ||
            (call.function && call.function.name === message.name)));
        if (!matches) continue;
      }
      sanitized.push(message);
    }
    return sanitized;
  }

  return { extractBaseId, isDateTimeInitialTurn, removeSelectedTurn };
});
