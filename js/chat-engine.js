/**
 * Motor Agéntico de Mensajería y Streaming (ChatEngine) para ZeroChat.
 * Responsable de:
 * - Construcción y anclaje de mensajes efectivos (System Prompt, Context-Caching, RAG context).
 * - Orquestación del bucle agéntico multi-turno (turnos asistentes, llamadas a herramientas y síntesis forzada).
 * - Streaming de tokens, reasoning/thinking chunks y cálculo de métricas en tiempo real.
 * - Prevención de bucles infinitos por llamadas idénticas consecutivas.
 */

(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.ChatEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function getAPI() {
    return (typeof window !== 'undefined' && window.ChatAPI)
      ? window.ChatAPI
      : (typeof require !== 'undefined' ? (() => { try { return require('./api.js'); } catch (e) { return {}; } })() : {});
  }

  function getAgentCore() {
    return (typeof window !== 'undefined' && window.ChatAgentCore)
      ? window.ChatAgentCore
      : (typeof require !== 'undefined' ? (() => { try { return require('./agent-core.js'); } catch (e) { return {}; } })() : {});
  }

  function getMarkdown() {
    return (typeof window !== 'undefined' && window.ChatMarkdown)
      ? window.ChatMarkdown
      : (typeof require !== 'undefined' ? (() => { try { return require('./markdown.js'); } catch (e) { return {}; } })() : {});
  }

  function getI18n() {
    return (typeof window !== 'undefined' && window.ChatI18n)
      ? window.ChatI18n
      : (typeof require !== 'undefined' ? (() => { try { return require('./i18n.js'); } catch (e) { return {}; } })() : {});
  }

  function getContextManager() {
    return (typeof window !== 'undefined' && window.ChatContextManager)
      ? window.ChatContextManager
      : (typeof require !== 'undefined' ? (() => { try { return require('./context-manager.js'); } catch (e) { return {}; } })() : {});
  }


  function serializeContent(content) {
    if (typeof content === 'string') return content;
    if (content === undefined) return '';
    if (typeof content === 'object') return JSON.stringify(content);
    return String(content);
  }

  /** Genera una referencia de fecha inicial, sin hora y coherente con la zona local (siempre en inglés para el modelo). */
  function getConversationDateAnchor(lang = 'en', startedAt = Date.now()) {
    let date = new Date(startedAt);
    if (Number.isNaN(date.getTime())) date = new Date();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(date);
    const value = type => parts.find(part => part.type === type).value;
    const isoDate = `${value('year')}-${value('month')}-${value('day')}`;
    return `[Conversation start date: ${isoDate}, Timezone: ${tz}.]`;
  }

  /** Guarda el ancla una sola vez; el metadato no se transmite en el payload. */
  function ensureConversationDate(chatHistory = [], lang = 'es', startedAt = Date.now()) {
    const root = chatHistory.find(m => m && m.role === 'system' && !m._isSummaryBlock)
      || chatHistory.find(m => m && m.role);
    if (!root) return getConversationDateAnchor(lang, startedAt);
    if (typeof root.contextDateAnchor !== 'string' || !root.contextDateAnchor.trim()) {
      root.contextDateAnchor = getConversationDateAnchor(lang, startedAt);
    }
    return root.contextDateAnchor;
  }

  /**
   * Genera la guía de herramientas en texto plano / XML para modelos que no soportan Function Calling nativo en JSON.
   * @param {Object} [appConfig={}] - Configuración activa de herramientas.
   * @param {string} [lang='es'] - Idioma ('es' o 'en').
   * @returns {string} - Guía formateada para el System Prompt.
   */
  function getToolsSystemPromptGuide(appConfig = {}, lang = 'es') {
    const AgentCore = getAgentCore();
    if (AgentCore && AgentCore.registry && typeof AgentCore.registry.getActivePromptGuide === 'function') {
      return AgentCore.registry.getActivePromptGuide(appConfig, lang);
    }
    return '';
  }

  function getConfiguredSystemPrompt(appConfig = {}) {
    return [appConfig.systemPrompt, appConfig.systemDataPrompt]
      .map(value => String(value || '').trim())
      .filter(Boolean)
      .join('\n\n');
  }

  /**
   * Inyecta el cursor de streaming dentro del HTML de forma semánticamente correcta.
   * @param {string} html - HTML renderizado del turno en curso.
   * @returns {string} - HTML con el cursor parpadeante integrado.
   */
  function injectStreamingCursor(html) {
    if (!html || html.trim() === '') {
      return '<span class="streaming-cursor"></span>';
    }
    const trimmed = html.trimEnd();
    const match = trimmed.match(/(<\/(?:p|li|h[1-6]|span|code|strong|em|td|blockquote)>)$/i);
    if (match) {
      const closingTag = match[1];
      return trimmed.slice(0, -closingTag.length) + '<span class="streaming-cursor"></span>' + closingTag;
    }
    return trimmed + '<span class="streaming-cursor"></span>';
  }

  /**
   * Extrae el identificador base de un mensaje eliminando sufijos de turnos internos o finalización.
   * @param {string} id - Identificador del mensaje (ej: 'asst_123_turn_0_assistant', 'asst_123_final').
   * @returns {string} - Identificador base (ej: 'asst_123').
   */
  function extractBaseId(id) {
    if (!id || typeof id !== 'string') return '';
    return id.replace(/(?:_turn_\d+_(?:assistant|tool.*)|_final)$/, '');
  }

  /**
   * Elimina completamente un turno del historial de chat, asegurando que:
   * 1. Se eliminen todos los mensajes del turno (asistente, herramientas y síntesis final).
   * 2. Se eliminen todas las respuestas de herramientas asociadas a las llamadas de ese turno.
   * 3. No queden mensajes 'tool' huérfanos sin llamada previa en el historial.
   *
   * @param {Array} chatHistory - Historial actual de mensajes.
   * @param {Object} options - Parámetros de identificación del turno a eliminar.
   * @param {string} [options.msgId] - ID principal o data-msg-id del contenedor.
   * @param {string} [options.baseId] - Prefijo base del turno (ej: 'msg_ast_123').
   * @param {Array<string>|Set<string>} [options.explicitIds] - Lista de IDs exactos pertenecientes al turno.
   * @returns {Array} - Nuevo historial filtrado y saneado sin turnos ni respuestas huérfanas.
   */
  function removeTurnFromHistory(chatHistory = [], options = {}) {
    if (!Array.isArray(chatHistory) || chatHistory.length === 0) return [];

    const msgId = options.msgId || '';
    const baseId = options.baseId || extractBaseId(msgId);
    const explicitIds = new Set(
      Array.isArray(options.explicitIds)
        ? options.explicitIds
        : (options.explicitIds instanceof Set ? options.explicitIds : [])
    );
    if (msgId) explicitIds.add(msgId);
    if (baseId) explicitIds.add(baseId);

    // Conjunto de tool_call_ids generados en los mensajes eliminados
    const deletedToolCallIds = new Set();

    const isTargetMessage = (m) => {
      if (!m) return false;
      const mid = m.id;
      if (mid) {
        if (explicitIds.has(mid)) return true;
        if (baseId && (mid === baseId || mid.startsWith(`${baseId}_`))) return true;
        if (msgId && (mid === msgId || mid.startsWith(`${msgId}_`))) return true;
      }
      return false;
    };

    // Primera pasada: identificar mensajes objetivo y recolectar IDs de tool_calls
    chatHistory.forEach(m => {
      if (m && isTargetMessage(m)) {
        if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
          m.tool_calls.forEach(tc => {
            if (tc && tc.id) deletedToolCallIds.add(tc.id);
          });
        }
        if (m.role === 'tool' && m.tool_call_id) {
          deletedToolCallIds.add(m.tool_call_id);
        }
      }
    });

    // Filtrar mensajes que coincidan directamente o por su tool_call_id
    const filtered = chatHistory.filter(m => {
      if (!m) return false;
      if (isTargetMessage(m)) return false;
      if (m.role === 'tool' && m.tool_call_id && deletedToolCallIds.has(m.tool_call_id)) {
        return false;
      }
      return true;
    });

    // Segunda pasada: sanear cualquier mensaje 'tool' que haya quedado huérfano
    // (en APIs estándar como OpenAI/Claude/Gemini, un mensaje 'tool' DEBE ir precedido por un 'assistant' con matching tool_call)
    const sanitized = [];
    for (let i = 0; i < filtered.length; i++) {
      const current = filtered[i];
      if (current && current.role === 'tool') {
        const prev = sanitized.length > 0 ? sanitized[sanitized.length - 1] : null;
        const hasMatchingCall = prev && prev.role === 'assistant' && Array.isArray(prev.tool_calls) &&
          prev.tool_calls.some(tc => tc && (tc.id === current.tool_call_id || (tc.function && tc.function.name === current.name)));
        if (hasMatchingCall) {
          sanitized.push(current);
        }
        // Si no tiene asistente previo válido con el tool_call_id, se descarta
      } else {
        sanitized.push(current);
      }
    }

    return sanitized;
  }

  /**
   * Construye el array de mensajes normalizado y enriquecido para la API de inferencia.
   * @param {Array} chatHistory - Historial de mensajes de la conversación.
   * @param {Object} appConfig - Configuración activa de la aplicación.
   * @param {Object} [options={}] - Opciones de contexto (ej: currentRagSystemContext, forceSystemPromptGuide).
   * @returns {Array} - Array de mensajes listo para streamChatCompletion.
   */
  function buildEffectiveMessages(chatHistory = [], appConfig = {}, options = {}) {
    const rawMessages = (chatHistory || []).filter(m => m && m.role);
    const messages = [];

    rawMessages.forEach(m => {
      if (m.role === 'user') {
        if (m.images && Array.isArray(m.images) && m.images.length > 0) {
          const contentParts = [];
          if (m.content) {
            contentParts.push({ type: 'text', text: m.content });
          }
          m.images.forEach(img => {
            if (img && img.dataUrl) {
              contentParts.push({
                type: 'image_url',
                image_url: {
                  url: img.dataUrl
                }
              });
            }
          });
          messages.push({ role: 'user', content: contentParts });
        } else {
          messages.push({ role: 'user', content: m.content || '' });
        }
      } else if (m.role === 'assistant') {
        const item = { role: 'assistant', content: m.content !== undefined ? m.content : '' };
        if (m.tool_calls && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
          item.tool_calls = m.tool_calls;
        }
        messages.push(item);
      } else if (m.role === 'tool') {
        const toolCallId = m.tool_call_id || `call_${Date.now()}`;
        const toolName = m.name || 'tool';
        const toolContent = serializeContent(m.content);

        // Validar que el mensaje previo sea un assistant con el tool_call correspondiente
        const prevMsg = messages.length > 0 ? messages[messages.length - 1] : null;
        const hasMatchingToolCall = prevMsg && prevMsg.role === 'assistant' && Array.isArray(prevMsg.tool_calls) &&
          prevMsg.tool_calls.some(tc => tc.id === toolCallId || (tc.function && tc.function.name === toolName));

        if (!hasMatchingToolCall) {
          messages.push({
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: toolCallId,
              type: 'function',
              function: {
                name: toolName,
                arguments: '{}'
              }
            }]
          });
        }

        messages.push({
          role: 'tool',
          tool_call_id: toolCallId,
          name: toolName,
          content: toolContent
        });

        // La imagen recuperada por RAG se entrega como evidencia visual en el
        // siguiente turno de inferencia, sin convertirla en un mensaje visible
        // ni en texto/base64 dentro del resultado de la herramienta.
        const image = Array.isArray(m.images) ? m.images.find(item => item?.dataUrl) : null;
        if (toolName === 'read_knowledge_image' && image) {
          const provenance = [image.imageRef, image.documentTitle, image.page ? `page ${image.page}` : '']
            .filter(Boolean).join(' · ');
          messages.push({
            role: 'user',
            content: [
              { type: 'text', text: `Visual evidence retrieved by read_knowledge_image${provenance ? `: ${provenance}` : '.'}` },
              { type: 'image_url', image_url: { url: image.dataUrl } }
            ]
          });
        }
      } else if (m.role === 'system') {
        messages.push({
          role: 'system',
          content: m.content || '',
          ...(m._isSummaryBlock ? { _isSummaryBlock: true } : {})
        });
      }
    });

    // 1. Instrucciones base del sistema (máxima estabilidad de prefijo)
    const baseSystemPrompt = getConfiguredSystemPrompt(appConfig);

    const isToolsEnabled = options.enableTools !== undefined
      ? Boolean(options.enableTools)
      : Boolean(appConfig.enabledTools && Object.values(appConfig.enabledTools).some(value => value !== false));

    // Consultar si el modelo soporta llamadas a herramientas nativas
    const API = getAPI();
    let isNativeToolsSupported = true;
    if (API && API.getProviderCapabilities) {
      const caps = API.getProviderCapabilities(appConfig.apiUrl, appConfig.apiType, appConfig.model);
      isNativeToolsSupported = caps ? (caps.tools !== false) : true;
    }

    // 2. Instrucción de flujo para herramientas (estable)
    const lang = appConfig.language || 'es';
    let toolsGuide = '';
    if (isToolsEnabled) {
      if (!isNativeToolsSupported || options.forceSystemPromptGuide) {
        toolsGuide = getToolsSystemPromptGuide(appConfig, lang);
      } else {
        const isCheckpointActive = !!(appConfig?.enabledTools?.agent_checkpoint);
        const checkpointGuidance = isCheckpointActive
          ? '\n*Agent checkpoint:* When gathering information from multiple searches or documents, or before concluding, invoke "agent_checkpoint" to consolidate facts and record the current plan.'
          : '';
        toolsGuide = `*Workflow instruction:* After using tools, answer the user's question directly, clearly, and concisely. Use findings only as evidence, citing sources briefly or via inline links. Avoid lengthy or redundant summaries of consulted sources and do not show raw tool output.${checkpointGuidance}`;
      }
    }

    // 3. Directiva proactiva de Base de Conocimiento activa (estable por rama)
    const activeBranchIds = Array.isArray(options.activeRagBranchIds)
      ? options.activeRagBranchIds
      : (options.activeRagBranchId ? [options.activeRagBranchId] : (appConfig.activeRagBranchIds || (appConfig.activeRagBranchId ? [appConfig.activeRagBranchId] : [])));
    const activeBranchId = options.activeRagBranchId || (Array.isArray(activeBranchIds) ? activeBranchIds[0] : '') || (appConfig.activeRagBranchId || '');

    if (activeBranchId || (Array.isArray(activeBranchIds) && activeBranchIds.length > 0)) {
      const ragInstruction = `*Knowledge Base active:* Follow the document-consultation protocol above. Use 'list_documents' only when you explicitly need a complete inventory.`;
      toolsGuide = toolsGuide ? `${toolsGuide}\n\n${ragInstruction}` : ragInstruction;
    }

    // Ensamblar bloque estable
    let fullSystemPrompt = [baseSystemPrompt, toolsGuide].filter(Boolean).join('\n\n');

    // 4. Inyección de contexto dinámico al final para preservar el prefijo en caché:
    // a) Contexto RAG recuperado para esta consulta
    const ragContext = options.currentRagSystemContext || appConfig.currentRagSystemContext || '';
    if (ragContext) {
      fullSystemPrompt = fullSystemPrompt ? `${fullSystemPrompt}\n\n${ragContext}` : ragContext;
    }

    // b) Fecha inicial persistida de la conversación (siempre activa)
    const dateAnchor = ensureConversationDate(chatHistory, lang);
    fullSystemPrompt = fullSystemPrompt ? `${fullSystemPrompt}\n\n${dateAnchor}` : dateAnchor;

    if (messages.length > 0 && messages[0].role === 'system' && !messages[0]._isSummaryBlock) {
      if (fullSystemPrompt) {
        messages[0].content = fullSystemPrompt;
      } else {
        messages.shift();
      }
    } else if (fullSystemPrompt) {
      messages.unshift({
        role: 'system',
        content: fullSystemPrompt
      });
    }

    // Asegurar que la conversación comience con un turno de usuario válido tras el mensaje del sistema
    const firstNonSysIdx = messages.findIndex(m => m.role !== 'system');
    if (firstNonSysIdx !== -1 && messages[firstNonSysIdx].role === 'assistant') {
      messages.splice(firstNonSysIdx, 0, {
        role: 'user',
        content: 'Continue'
      });
    }

    // Optimización dinámica de contexto, presupuesto de tokens y ventana deslizante
    const ContextManager = getContextManager();
    if (ContextManager && ContextManager.buildOptimizedContext) {
      const optimization = ContextManager.buildOptimizedContext(messages, {
        model: appConfig.model,
        providerType: appConfig.apiType,
        totalContextLimit: appConfig.modelContextLimit || appConfig.contextLimitOverride,
        ...options
      });
      options.onContextPrepared?.(optimization.diagnostics || null);
      return optimization.messages;
    }

    return messages;
  }

  /**
   * Ejecuta el bucle agéntico multi-turno de inferencia, streaming y herramientas.
   * @param {Object} params - Parámetros de ejecución.
   * @returns {Promise<{ success: boolean, finalAssistantText: string, accumulatedMarkdown: string, stats: Object, cancelled?: boolean, error?: any }>}
   */
  async function executeWithAgentRuntime(params = {}) {
    const {
      chatHistory = [],
      appConfig = {},
      assistantMsgId = `asst_${Date.now()}`,
      activeRagBranchId = '',
      activeRagBranchIds = [],
      currentRagSystemContext = '',
      container,
      onTurnStart,
      onChunk,
      onReasoningChunk,
      onLog,
      onStats,
      onBeforeRequest,
      onToolCallStart,
      onToolCallEnd,
      scrollToBottom,
      attachListeners
    } = params;
    const AgentCore = getAgentCore();
    const Markdown = getMarkdown();
    const runtime = AgentCore?.runtime;
    if (!runtime || !AgentCore?.registry || !AgentCore?.dispatchToolCall) {
      return { success: false, error: new Error('El runtime agéntico no está disponible.') };
    }

    const parseMd = Markdown.parseMarkdown || (text => text);
    const attachEvts = attachListeners || Markdown.attachCopyCodeListeners || (() => {});
    const scrollFn = scrollToBottom || (() => {});
    let lastContextDiagnostics = null;
    const resolvedBranchIds = Array.isArray(activeRagBranchIds) && activeRagBranchIds.length > 0
      ? activeRagBranchIds
      : (activeRagBranchId ? [activeRagBranchId] : (appConfig.activeRagBranchIds || (appConfig.activeRagBranchId ? [appConfig.activeRagBranchId] : [])));
    const resolvedBranchId = activeRagBranchId || resolvedBranchIds[0] || appConfig.activeRagBranchId || '';
    const turnBlocks = new Map();
    let synthesisBlock = null;
    const turnMarkdown = new Map();

    const getTurnMarkdown = turnIndex => {
      if (!turnMarkdown.has(turnIndex)) {
        turnMarkdown.set(turnIndex, { text: '', toolBlocks: [] });
      }
      return turnMarkdown.get(turnIndex);
    };

    const result = await runtime.execute({
      apiUrl: params.apiUrl || appConfig.apiUrl,
      apiType: params.apiType || appConfig.apiType,
      apiKey: params.apiKey || appConfig.apiKey,
      model: params.model || appConfig.model,
      temperature: params.temperature !== undefined ? params.temperature : appConfig.temperature,
      reasoningEffort: params.reasoningEffort || appConfig.reasoningEffort || 'none',
      messages: chatHistory,
      signal: params.signal,
      maxSteps: params.maxAgentTurns || appConfig.maxAgentTurns || 15,
      maxRetries: 0,
      autoSynthesize: true,
      synthesizeOnLoop: false,
      appendFinalMessage: true,
      isCheckpointEnabled: Boolean(appConfig.enabledTools?.agent_checkpoint),
      contextOptions: {
        totalContextLimit: appConfig.modelContextLimit || appConfig.contextLimitOverride
      },
      summarizeHistory: async ({ systemPrompt, messages }) => {
        const API = getAPI();
        const response = await API.streamChatCompletion({
          apiUrl: params.apiUrl || appConfig.apiUrl,
          apiType: params.apiType || appConfig.apiType,
          apiKey: params.apiKey || appConfig.apiKey,
          model: params.model || appConfig.model,
          messages: [
            { role: 'system', content: systemPrompt },
            ...messages,
            { role: 'user', content: 'Generate the replacement checkpoint now.' }
          ],
          temperature: 0,
          reasoningEffort: 'none',
          enableTools: false,
          toolChoice: 'none',
          signal: params.signal,
          onBeforeRequest
        });
        return response?.accumulatedText || '';
      },
      onBeforeRequest,
      createMessageId: (kind, info) => {
        if (kind === 'final') return `${assistantMsgId}_final`;
        if (kind === 'assistant') return `${assistantMsgId}_turn_${info.stepIndex}_assistant`;
        return `${assistantMsgId}_turn_${info.stepIndex}_tool_${info.toolCall?.id || info.toolIndex}_${Date.now()}`;
      },
      prepareMessages: (messages, options) => ({
        messages: buildEffectiveMessages(messages, appConfig, {
          currentRagSystemContext,
          activeRagBranchId: resolvedBranchId,
          activeRagBranchIds: resolvedBranchIds,
          forceSystemPromptGuide: Boolean(options.isSynthesis),
          onContextPrepared: diagnostics => { lastContextDiagnostics = diagnostics; }
        }),
        diagnostics: lastContextDiagnostics
      }),
      resolveToolDefinitions: () => AgentCore.registry.getActiveDefinitions({
        ...appConfig,
        activeRagBranchId: resolvedBranchId,
        activeRagBranchIds: resolvedBranchIds
      }),
      dispatchToolCall: async (toolCall, context) => AgentCore.dispatchToolCall(toolCall, {
        container,
        onLog,
        attachListeners: attachEvts,
        scrollToBottom: scrollFn,
        language: appConfig.language || 'es',
        activeRagBranchId: resolvedBranchId,
        activeRagBranchIds: resolvedBranchIds,
        ...context
      }),
      callbacks: {
        onStepStart: turnIndex => {
          if (container && typeof document !== 'undefined') {
            if (turnIndex === 0) container.innerHTML = '';
            const block = document.createElement('div');
            block.className = 'agentic-turn-block';
            container.appendChild(block);
            turnBlocks.set(turnIndex, block);
            if (typeof onTurnStart === 'function') onTurnStart({ turnIndex, turnBlock: block });
          }
        },
        onChunk: (text, delta, stats, turnIndex) => {
          const block = turnBlocks.get(turnIndex) || synthesisBlock;
          if (block) {
            block.innerHTML = injectStreamingCursor(parseMd(text));
            attachEvts(block);
          }
          if (stats && typeof onStats === 'function') onStats(stats);
          if (typeof onChunk === 'function') onChunk({ turnIndex, fullText: text, delta, stats });
          scrollFn();
        },
        onReasoningChunk: (chunk, _accumulated, turnIndex) => {
          if (typeof onReasoningChunk === 'function') onReasoningChunk(chunk, turnIndex);
        },
        onLog: logData => {
          if (typeof onLog === 'function' && logData?.type !== 'thinking') onLog(logData.type, logData.text);
        },
        onToolStart: (toolCall, _tool, turnIndex) => {
          if (typeof onToolCallStart === 'function') onToolCallStart({ turnIndex, toolCall });
        },
        onToolComplete: (toolCall, execution, _content, turnIndex) => {
          if (execution?.markdownBlock) {
            getTurnMarkdown(turnIndex).toolBlocks.push(execution.markdownBlock);
          }
          if (typeof onToolCallEnd === 'function') onToolCallEnd({ turnIndex, toolCall, result: execution });
        },
        onStepDone: (turnIndex, step) => {
          const block = turnBlocks.get(turnIndex);
          if (step.type === 'tool_execution') {
            getTurnMarkdown(turnIndex).text = step.assistantMsg?.content || '';
          }
          if (!block) return;
          const text = step.type === 'final_response' ? step.text : step.assistantMsg?.content;
          if (text) {
            block.innerHTML = parseMd(text);
            attachEvts(block);
          } else if (typeof block.remove === 'function') {
            block.remove();
            turnBlocks.delete(turnIndex);
          }
        },
        onLoopDetected: () => {
          if (typeof onLog === 'function') {
            onLog('error', '[Protección Bucle Infinito]: Herramientas invocadas repetidamente con los mismos argumentos. Interrumpiendo ciclo agéntico.');
          }
        },
        onSynthesize: () => {
          if (container && typeof document !== 'undefined') {
            synthesisBlock = document.createElement('div');
            synthesisBlock.className = 'agentic-turn-block';
            container.appendChild(synthesisBlock);
          }
        },
        onDone: finalText => {
          const block = synthesisBlock || turnBlocks.get(Math.max(...turnBlocks.keys(), 0));
          if (block && finalText) {
            block.innerHTML = parseMd(finalText);
            attachEvts(block);
          }
        }
      }
    });

    if (Array.isArray(result.history)) {
      chatHistory.length = 0;
      chatHistory.push(...result.history);
    }
    if (result.cancelled || result.status === 'cancelled') return { success: false, cancelled: true };
    if (result.error) return { success: false, error: result.error };
    const accumulatedMarkdown = [...turnMarkdown.entries()]
      .sort(([left], [right]) => left - right)
      .flatMap(([, turn]) => [turn.text, ...turn.toolBlocks])
      .filter(Boolean)
      .concat(result.finalText || '')
      .filter(Boolean)
      .join('\n\n');
    return {
      success: result.success,
      loopDetected: result.loopDetected,
      finalAssistantText: result.finalText || '',
      accumulatedMarkdown,
      stats: result.stats,
      contextDiagnostics: lastContextDiagnostics,
      chatHistory: result.history
    };
  }

  async function executeAgentTurnLoop(params = {}) {
    return executeWithAgentRuntime(params);
  }

  return {
    getConversationDateAnchor,
    ensureConversationDate,
    getConfiguredSystemPrompt,
    getToolsSystemPromptGuide,
    injectStreamingCursor,
    buildEffectiveMessages,
    executeAgentTurnLoop,
    extractBaseId,
    removeTurnFromHistory
  };
});
