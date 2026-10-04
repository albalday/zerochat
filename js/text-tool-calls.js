/**
 * Llamadas a herramientas en texto (formato `<tool_call>{json}</tool_call>`).
 * Permite el uso de herramientas con proveedores o modelos sin function calling nativo:
 * describe las herramientas en el prompt de sistema, convierte el historial de
 * `tool_calls`/`tool` a texto y extrae las llamadas emitidas por el modelo.
 * Compatible con file://, http:// y Node.js.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.ChatTextToolCalls = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const OPEN_TAG = '<tool_call>';
  const CLOSE_TAG = '</tool_call>';
  const BLOCK_PATTERN = /<tool_call>([\s\S]*?)(?:<\/tool_call>|$)/g;

  function contentToText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.filter(part => part?.type === 'text').map(part => part.text || '').join('\n');
    }
    if (content === undefined || content === null) return '';
    return typeof content === 'object' ? JSON.stringify(content) : String(content);
  }

  /**
   * Instrucciones de sistema con las firmas de las herramientas disponibles.
   */
  function buildToolsPrompt(toolsList) {
    if (!Array.isArray(toolsList) || toolsList.length === 0) return '';
    const signatures = toolsList.map(tool => JSON.stringify(tool)).join('\n');
    return [
      '# Tools',
      '',
      'You may call one or more functions to assist with the user query.',
      '',
      'You are provided with function signatures within <tools></tools> XML tags:',
      '<tools>',
      signatures,
      '</tools>',
      '',
      'For each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:',
      OPEN_TAG,
      '{"name": <function-name>, "arguments": <args-json-object>}',
      CLOSE_TAG,
      '',
      'Tool results are returned within <tool_response></tool_response> XML tags. Never write <tool_response> yourself or invent tool results. When no tool is needed, answer directly.'
    ].join('\n');
  }

  function formatToolCall(call) {
    const name = call?.function?.name || call?.name || '';
    const rawArgs = call?.function?.arguments ?? call?.arguments ?? {};
    let args = rawArgs;
    if (typeof rawArgs === 'string') {
      try { args = rawArgs.trim() ? JSON.parse(rawArgs) : {}; } catch (_) { args = rawArgs; }
    }
    return `${OPEN_TAG}\n${JSON.stringify({ name, arguments: args })}\n${CLOSE_TAG}`;
  }

  /**
   * Convierte `assistant.tool_calls` y los mensajes `tool` a texto plano:
   * las llamadas se incrustan en el turno del asistente y los resultados
   * consecutivos se agrupan en un turno de usuario con `<tool_response>`.
   */
  function toTextMessages(messages) {
    if (!Array.isArray(messages)) return [];
    const result = [];
    let pendingResponses = [];
    const flushResponses = () => {
      if (pendingResponses.length === 0) return;
      result.push({ role: 'user', content: pendingResponses.join('\n') });
      pendingResponses = [];
    };
    for (const message of messages) {
      if (message?.role === 'tool') {
        pendingResponses.push(`<tool_response>\n${contentToText(message.content)}\n</tool_response>`);
        continue;
      }
      flushResponses();
      if (message?.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        const text = contentToText(message.content).trim();
        const calls = message.tool_calls.map(formatToolCall).join('\n');
        result.push({ role: 'assistant', content: text ? `${text}\n${calls}` : calls });
      } else if (message?.role === 'assistant' && typeof message.content !== 'string') {
        const { tool_calls: _toolCalls, ...rest } = message;
        result.push({ ...rest, content: contentToText(message.content) });
      } else {
        result.push(message);
      }
    }
    flushResponses();
    return result;
  }

  /**
   * Prepara los mensajes de una petición en modo texto: convierte el historial
   * y añade las firmas de herramientas al prompt de sistema inicial.
   */
  function prepareMessages(messages, toolsList) {
    const converted = toTextMessages(messages);
    const toolsPrompt = buildToolsPrompt(toolsList);
    if (!toolsPrompt) return converted;
    if (converted[0]?.role === 'system') {
      const systemText = contentToText(converted[0].content).trim();
      converted[0] = { ...converted[0], content: systemText ? `${systemText}\n\n${toolsPrompt}` : toolsPrompt };
    } else {
      converted.unshift({ role: 'system', content: toolsPrompt });
    }
    return converted;
  }

  function parseBlock(rawBlock) {
    const body = String(rawBlock || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    if (!body) return null;
    let parsed;
    try { parsed = JSON.parse(body); } catch (_) { return null; }
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    const calls = [];
    for (const entry of entries) {
      const source = entry?.function && typeof entry.function === 'object' ? entry.function : entry;
      const name = typeof source?.name === 'string' ? source.name.trim() : '';
      if (!name) return null;
      const args = source.arguments ?? source.parameters ?? {};
      calls.push({ name, arguments: typeof args === 'string' ? args : JSON.stringify(args) });
    }
    return calls;
  }

  /**
   * Extrae las llamadas `<tool_call>` de una respuesta completa.
   * Devuelve el texto sin los bloques y las llamadas en formato OpenAI, o
   * `toolCalls: null` (con el texto intacto) si no hay ninguna llamada válida.
   */
  function extractToolCalls(text) {
    const source = String(text || '');
    if (!source.includes(OPEN_TAG)) return { text: source, toolCalls: null };
    const calls = [];
    for (const match of source.matchAll(BLOCK_PATTERN)) {
      const blockCalls = parseBlock(match[1]);
      if (blockCalls) calls.push(...blockCalls);
    }
    if (calls.length === 0) return { text: source, toolCalls: null };
    const stamp = Date.now();
    return {
      text: source.replace(BLOCK_PATTERN, '').trim(),
      toolCalls: calls.map((call, index) => ({
        id: `call_text_${stamp}_${index}`,
        type: 'function',
        function: call
      }))
    };
  }

  /**
   * Texto que puede mostrarse durante el streaming: oculta bloques completos,
   * un bloque todavía abierto y un prefijo parcial de `<tool_call>` al final.
   */
  function visibleText(text) {
    let visible = String(text || '');
    if (visible.includes(OPEN_TAG)) visible = visible.replace(BLOCK_PATTERN, '');
    for (let length = Math.min(OPEN_TAG.length - 1, visible.length); length > 0; length--) {
      if (visible.endsWith(OPEN_TAG.slice(0, length))) {
        return visible.slice(0, -length);
      }
    }
    return visible;
  }

  return { OPEN_TAG, CLOSE_TAG, buildToolsPrompt, toTextMessages, prepareMessages, extractToolCalls, visibleText };
});
