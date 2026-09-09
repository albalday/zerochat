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

  let lastContextDiagnostics = null;

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
        messages.push({ role: 'system', content: m.content || '' });
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
          ? '\n*Agent checkpoint:* When gathering information from multiple searches or documents, or before concluding, invoke "agent_checkpoint" to consolidate facts and clear working memory.'
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

    if (messages.length > 0 && messages[0].role === 'system') {
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
        totalContextLimit: appConfig.modelContextLimit,
        ...options
      });
      lastContextDiagnostics = optimization.diagnostics || null;
      return optimization.messages;
    }

    return messages;
  }

  /**
   * Ejecuta el bucle agéntico multi-turno de inferencia, streaming y herramientas.
   * @param {Object} params - Parámetros de ejecución.
   * @returns {Promise<{ success: boolean, finalAssistantText: string, accumulatedMarkdown: string, stats: Object, cancelled?: boolean, error?: any }>}
   */
  async function executeAgentTurnLoop(params = {}) {
    const {
      apiUrl,
      apiType,
      apiKey,
      model,
      temperature,
      reasoningEffort,
      chatHistory = [],
      appConfig = {},
      assistantMsgId = `asst_${Date.now()}`,
      activeRagBranchId = '',
      activeRagBranchIds = [],
      currentRagSystemContext = '',
      signal,
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

    const resolvedActiveRagBranchIds = (Array.isArray(activeRagBranchIds) && activeRagBranchIds.length > 0)
      ? activeRagBranchIds
      : (activeRagBranchId ? [activeRagBranchId] : (appConfig.activeRagBranchIds || (appConfig.activeRagBranchId ? [appConfig.activeRagBranchId] : [])));
    const resolvedActiveRagBranchId = activeRagBranchId || resolvedActiveRagBranchIds[0] || (appConfig.activeRagBranchId || '');

    const API = getAPI();
    const AgentCore = getAgentCore();
    const Markdown = getMarkdown();
    const parseMd = Markdown.parseMarkdown || function (txt) { return txt; };
    const attachEvts = attachListeners || Markdown.attachCopyCodeListeners || function () {};
    const scrollFn = scrollToBottom || function () {};

    if (!API || !API.streamChatCompletion) {
      const err = new Error('El módulo ChatAPI no está disponible.');
      if (typeof onLog === 'function') onLog('error', err.message);
      return { success: false, error: err };
    }

    if (!model || model.trim() === '') {
      const err = new Error('No se ha seleccionado ningún modelo de inferencia.');
      if (typeof onLog === 'function') onLog('error', err.message);
      return { success: false, error: err };
    }

    const maxAgentTurns = params.maxAgentTurns || appConfig.maxAgentTurns || 15;
    const toolCallSignatures = [];
    let turnIndex = 0;
    let accumulatedConversationMarkdown = '';
    let finalAssistantText = '';
    let finalStats = null;
    let isCancelled = false;
    let consecutiveDataCalls = 0;
    const DATA_TOOL_NAMES = new Set(['search_knowledge_base', 'read_knowledge_chunk', 'list_documents', 'search_web', 'fetch_web_page', 'download_pdf']);

    while (turnIndex < maxAgentTurns) {
      if (signal && signal.aborted) {
        isCancelled = true;
        break;
      }

      let turnBlock = null;
      if (container && typeof document !== 'undefined') {
        if (turnIndex === 0) {
          container.innerHTML = '';
        }
        turnBlock = document.createElement('div');
        turnBlock.className = 'agentic-turn-block';
        container.appendChild(turnBlock);
      }

      if (typeof onTurnStart === 'function') {
        onTurnStart({ turnIndex, turnBlock });
      }

      let currentTurnText = '';
      let turnToolCalls = null;
      let turnFinalStats = null;
      let streamError = null;

      const effectiveMessages = buildEffectiveMessages(chatHistory, appConfig, {
        currentRagSystemContext,
        activeRagBranchId: resolvedActiveRagBranchId,
        activeRagBranchIds: resolvedActiveRagBranchIds
      });

      const AgentCore = getAgentCore();
      const activeToolDefs = (AgentCore && AgentCore.registry && typeof AgentCore.registry.getActiveDefinitions === 'function')
        ? AgentCore.registry.getActiveDefinitions({ ...appConfig, activeRagBranchId: resolvedActiveRagBranchId, activeRagBranchIds: resolvedActiveRagBranchIds })
        : [];

      const streamResult = await API.streamChatCompletion({
        apiUrl: apiUrl || appConfig.apiUrl,
        apiType: apiType || appConfig.apiType,
        apiKey: apiKey || appConfig.apiKey,
        model: model || appConfig.model,
        messages: effectiveMessages,
        temperature: temperature !== undefined ? temperature : appConfig.temperature,
        reasoningEffort: reasoningEffort || appConfig.reasoningEffort || 'none',
        tools: activeToolDefs,
        enableTools: activeToolDefs.length > 0,
        activeRagBranchId: resolvedActiveRagBranchId || '',
        activeRagBranchIds: resolvedActiveRagBranchIds,
        signal: signal,

        onBeforeRequest: onBeforeRequest,

        onReasoningChunk: function (chunk) {
          if (typeof onReasoningChunk === 'function') {
            onReasoningChunk(chunk);
          } else if (typeof onLog === 'function') {
            onLog('thinking', chunk);
          }
        },

        onLog: function (logData) {
          if (typeof onLog === 'function' && logData && logData.type !== 'thinking') {
            onLog(logData.type, logData.text);
          }
        },

        onChunk: function (fullTextSoFar, delta, stats) {
          currentTurnText = fullTextSoFar;
          if (turnBlock) {
            turnBlock.innerHTML = injectStreamingCursor(parseMd(currentTurnText));
            attachEvts(turnBlock);
          }
          if (stats && typeof onStats === 'function') onStats(stats);
          if (typeof onChunk === 'function') onChunk({ turnIndex, fullText: currentTurnText, delta, stats });
          scrollFn();
        },

        onDone: function (finalText, stats, toolCalls) {
          currentTurnText = finalText || currentTurnText;
          turnFinalStats = stats;
          turnToolCalls = toolCalls;
        },

        onError: function (error) {
          streamError = error;
        }
      });

      if (streamResult && streamResult.cancelled) {
        if (turnBlock && !currentTurnText && turnBlock.parentNode) {
          turnBlock.parentNode.removeChild(turnBlock);
        }
        return { success: false, cancelled: true };
      }

      if (streamError) {
        if (signal && signal.aborted) {
          return { success: false, cancelled: true };
        }
        if (typeof onLog === 'function') onLog('error', streamError.message || String(streamError));
        return { success: false, error: streamError, currentTurnText };
      }

      if (streamResult) {
        currentTurnText = streamResult.accumulatedText || currentTurnText;
        turnToolCalls = streamResult.toolCalls || turnToolCalls;
        turnFinalStats = streamResult.stats || turnFinalStats;
      }

      // CASO A: No tool calls — final turn
      if (!turnToolCalls || turnToolCalls.length === 0) {
        // If the model returned empty text after a tool turn, log it and move on
        if ((!currentTurnText || currentTurnText.trim() === '') && turnIndex > 0 && chatHistory.length > 0 && chatHistory[chatHistory.length - 1].role === 'tool') {
          if (typeof onLog === 'function') onLog('warn', 'Model ended the tool loop without producing a response.');
        }

        if (turnBlock) {
          const I18n = getI18n();
          const emptyResponse = I18n && typeof I18n.uiText === 'function'
            ? I18n.uiText('empty_response', '(Empty response)')
            : '(Empty response)';
          turnBlock.innerHTML = parseMd(currentTurnText || emptyResponse);
          attachEvts(turnBlock);
        }

        chatHistory.push({
          id: `${assistantMsgId}_final`,
          role: 'assistant',
          content: currentTurnText
        });

        finalAssistantText = currentTurnText;
        finalStats = turnFinalStats;
        if (finalStats && typeof onStats === 'function') onStats(finalStats);

        return {
          success: true,
          finalAssistantText,
          accumulatedMarkdown: (accumulatedConversationMarkdown ? accumulatedConversationMarkdown : '') + currentTurnText,
          stats: finalStats,
          chatHistory
        };
      }

      // CASO B: Procesar llamadas a herramientas (soporte para llamadas individuales y en paralelo)
      const currentSignatures = turnToolCalls.map(tc => {
        const rawFuncName = tc.function?.name || '';
        const normName = API.normalizeToolName ? API.normalizeToolName(rawFuncName) : rawFuncName.toLowerCase().replace(/_/g, '');
        const argsStr = typeof tc.function?.arguments === 'object'
          ? JSON.stringify(tc.function.arguments)
          : String(tc.function?.arguments || '').trim();
        return `${normName}:${argsStr}`;
      });

      // Protección contra Bucles Infinitos (repetición idéntica de llamadas)
      const allRepeated = currentSignatures.length > 0 && currentSignatures.every(sig => {
        return toolCallSignatures.filter(s => s === sig).length >= 2;
      });

      if (allRepeated) {
        if (typeof onLog === 'function') {
          onLog('error', '[Protección Bucle Infinito]: Herramientas invocadas repetidamente con los mismos argumentos. Interrumpiendo ciclo agéntico.');
        }
        const loopWarning = `\n\n> ⚠️ *[Infinite Loop Protection]*: Tools were repeatedly invoked with identical parameters without progress. Halting agent turn loop.`;
        currentTurnText = (currentTurnText || '') + loopWarning;
        if (turnBlock) {
          turnBlock.innerHTML = parseMd(currentTurnText);
          attachEvts(turnBlock);
        }

        chatHistory.push({
          id: `${assistantMsgId}_final`,
          role: 'assistant',
          content: currentTurnText
        });

        finalAssistantText = currentTurnText;
        finalStats = turnFinalStats;
        if (finalStats && typeof onStats === 'function') onStats(finalStats);

        return {
          success: true,
          loopDetected: true,
          finalAssistantText,
          accumulatedMarkdown: (accumulatedConversationMarkdown ? accumulatedConversationMarkdown : '') + currentTurnText,
          stats: finalStats,
          contextDiagnostics: lastContextDiagnostics,
          chatHistory
        };
      }
      for (const sig of currentSignatures) {
        toolCallSignatures.push(sig);
      }

      // Limpiar llamadas a herramientas emitidas accidentalmente como texto crudo
      const trimmedAcc = (currentTurnText || '').trim();
      if (
        trimmedAcc.startsWith('<|') ||
        trimmedAcc.startsWith('<tool_call') ||
        trimmedAcc.startsWith('<function_call') ||
        trimmedAcc.startsWith('call:') ||
        trimmedAcc.startsWith('{"name"') ||
        trimmedAcc.startsWith('```json\n{"name"') ||
        trimmedAcc.startsWith('download_pdf(') ||
        trimmedAcc.startsWith('downloadpdf(') ||
        trimmedAcc.startsWith('fetch_web_page(') ||
        trimmedAcc.startsWith('fetchwebpage(') ||
        trimmedAcc.startsWith('search_web(') ||
        trimmedAcc.startsWith('searchweb(') ||
        trimmedAcc.startsWith('execute_javascript(') ||
        trimmedAcc.startsWith('executejs(')
      ) {
        currentTurnText = '';
      }

      if (currentTurnText && turnBlock) {
        turnBlock.innerHTML = parseMd(currentTurnText);
        attachEvts(turnBlock);
      } else if (turnBlock) {
        turnBlock.remove();
      }

      const executedResults = [];
      for (let i = 0; i < turnToolCalls.length; i++) {
        if (signal && signal.aborted) break;
        const tc = turnToolCalls[i];
        const rawFuncName = tc.function?.name || '';

        if (typeof onToolCallStart === 'function') {
          onToolCallStart({ turnIndex, toolCall: tc, toolIndex: i, totalTools: turnToolCalls.length });
        }

        let toolExecRes = null;
        if (AgentCore && AgentCore.dispatchToolCall) {
          toolExecRes = await AgentCore.dispatchToolCall(tc, {
            container: container,
            onLog: onLog,
            attachListeners: attachEvts,
            scrollToBottom: scrollFn,
            language: appConfig.language || 'es',
            signal: signal,
            activeRagBranchId: resolvedActiveRagBranchId,
            activeRagBranchIds: resolvedActiveRagBranchIds,
            compactHistory: () => {
              const ContextManager = getContextManager();
              if (ContextManager && typeof ContextManager.compactToolHistory === 'function') {
                const compacted = ContextManager.compactToolHistory(chatHistory);
                chatHistory.length = 0;
                chatHistory.push(...compacted);
              }
            }
          });
        } else {
          toolExecRes = {
            success: false,
            resultText: 'Error: Módulo de ejecución de herramientas no disponible.',
            markdownBlock: `> ❌ **${rawFuncName}**: Módulo de ejecución no disponible.`
          };
        }

        if (typeof onToolCallEnd === 'function') {
          onToolCallEnd({ turnIndex, toolCall: tc, result: toolExecRes, toolIndex: i, totalTools: turnToolCalls.length });
        }
        executedResults.push({ tc, toolExecRes, rawFuncName, index: i });
      }

      if (turnFinalStats && typeof onStats === 'function') onStats(turnFinalStats);
      scrollFn();

      // Guardar turno del asistente con la lista completa de tool_calls
      chatHistory.push({
        id: `${assistantMsgId}_turn_${turnIndex}_assistant`,
        role: 'assistant',
        content: currentTurnText || null,
        tool_calls: turnToolCalls
      });

      const isCheckpointActive = Boolean(appConfig?.enabledTools?.agent_checkpoint);
      let hasCheckpointInTurn = false;

      // Guardar respuesta de cada herramienta ejecutada
      let combinedMarkdownBlocks = '';
      for (const item of executedResults) {
        const { tc, toolExecRes, rawFuncName, index } = item;
        const isCheckpoint = rawFuncName === 'agent_checkpoint' || rawFuncName === 'checkpoint';
        if (isCheckpoint) {
          hasCheckpointInTurn = true;
        }

        let toolContent = toolExecRes.resultText;

        // Inyección agéntica activa si se encadenan consultas de datos sin checkpoint
        if (isCheckpointActive) {
          if (DATA_TOOL_NAMES.has(rawFuncName)) {
            consecutiveDataCalls++;
            if (consecutiveDataCalls >= 2) {
              const nudge = '[MANDATORY AGENT NOTICE: You have queried data sources across multiple turns. Before answering or if you still need more data (e.g. other years or documents), you MUST invoke the "agent_checkpoint" tool detailing your findings so far and what information is missing.]\n\n';
              toolContent = nudge + (toolContent || '');
            }
          } else if (isCheckpoint) {
            consecutiveDataCalls = 0;
          }
        }

        const toolMessage = {
          id: `${assistantMsgId}_turn_${turnIndex}_tool_${tc.id || index}_${Date.now()}`,
          role: 'tool',
          tool_call_id: tc.id || `call_${Date.now()}_${index}`,
          name: rawFuncName,
          content: toolContent
        };
        if (rawFuncName === 'read_knowledge_image' && toolExecRes.result?.success && toolExecRes.result.dataUrl) {
          toolMessage.images = [{
            dataUrl: toolExecRes.result.dataUrl,
            imageRef: toolExecRes.result.imageRef,
            documentTitle: toolExecRes.result.documentTitle,
            page: toolExecRes.result.page
          }];
        }
        chatHistory.push(toolMessage);
        if (toolExecRes.markdownBlock) {
          combinedMarkdownBlocks += (combinedMarkdownBlocks ? '\n\n' : '') + toolExecRes.markdownBlock;
        }
      }

      // Si este turno ejecutó un checkpoint, compactar inmediatamente el historial de herramientas previas
      if (hasCheckpointInTurn) {
        const ContextManager = getContextManager();
        if (ContextManager && typeof ContextManager.compactToolHistory === 'function') {
          const compacted = ContextManager.compactToolHistory(chatHistory);
          chatHistory.length = 0;
          chatHistory.push(...compacted);
        }
      }

      accumulatedConversationMarkdown += (currentTurnText ? currentTurnText + '\n\n' : '') + combinedMarkdownBlocks + '\n\n';

      turnIndex++;
    }

    // CASO C: Si se agotaron los turnos máximos tras una herramienta, síntesis final obligatoria
    if (turnIndex >= maxAgentTurns && chatHistory.length > 0 && chatHistory[chatHistory.length - 1].role === 'tool' && !(signal && signal.aborted)) {
      let finalSynthBlock = null;
      if (container && typeof document !== 'undefined') {
        finalSynthBlock = document.createElement('div');
        finalSynthBlock.className = 'agentic-turn-block';
        container.appendChild(finalSynthBlock);
      }

      let finalSynthText = '';
      let finalSynthStats = null;
      const synthMessages = buildEffectiveMessages(chatHistory, appConfig, {
        currentRagSystemContext,
        activeRagBranchId: resolvedActiveRagBranchId,
        activeRagBranchIds: resolvedActiveRagBranchIds,
        forceSystemPromptGuide: true
      });

      const isRagActive = Boolean(resolvedActiveRagBranchId || (resolvedActiveRagBranchIds && resolvedActiveRagBranchIds.length > 0));
      const isRagUsed = isRagActive || chatHistory.some(m => m.name === 'search_knowledge_base' || m.name === 'read_knowledge_chunk' || m.name === 'read_knowledge_image' || m.name === 'list_documents');

      const synthPrompt = isRagUsed
        ? 'Based on the information gathered from the tools above, answer my initial question directly. If the requested information or data was not found in the consulted documents, clearly state that no data was found to answer the question, instead of summarizing or dumping the consulted fragments.'
        : 'Based on all the information gathered from the tools above, answer my initial question directly, clearly, and concisely. Cite sources briefly or via inline links without writing lengthy summaries or redundant explanations of the consulted sources.';

      synthMessages.push({
        role: 'user',
        content: synthPrompt
      });

      try {
        await API.streamChatCompletion({
          apiUrl: apiUrl || appConfig.apiUrl,
          apiType: apiType || appConfig.apiType,
          apiKey: apiKey || appConfig.apiKey,
          model: model || appConfig.model,
          messages: synthMessages,
          temperature: temperature !== undefined ? temperature : appConfig.temperature,
          reasoningEffort: reasoningEffort || appConfig.reasoningEffort || 'none',
          tools: [],
          enableTools: false,
          toolChoice: 'none',
          activeRagBranchId: resolvedActiveRagBranchId || '',
          activeRagBranchIds: resolvedActiveRagBranchIds,
          signal: signal,

          onReasoningChunk: function (chunk) {
            if (typeof onReasoningChunk === 'function') {
              onReasoningChunk(chunk);
            } else if (typeof onLog === 'function') {
              onLog('thinking', chunk);
            }
          },
          onLog: function (logData) {
            if (typeof onLog === 'function' && logData && logData.type !== 'thinking') onLog(logData.type, logData.text);
          },
          onChunk: function (fullTextSoFar, delta, stats) {
            finalSynthText = fullTextSoFar;
            if (finalSynthBlock) {
              finalSynthBlock.innerHTML = injectStreamingCursor(parseMd(finalSynthText));
              attachEvts(finalSynthBlock);
            }
            if (stats && typeof onStats === 'function') onStats(stats);
            scrollFn();
          },
          onDone: function (finalText, stats) {
            finalSynthText = finalText || finalSynthText;
            finalSynthStats = stats;
          }
        });
      } catch (synthErr) {
        if (typeof onLog === 'function') onLog('warn', `Error en síntesis final: ${synthErr.message}`);
      }

      if (!finalSynthText || finalSynthText.trim() === '') {
        if (isRagUsed) {
          finalSynthText = 'No data was found in the consulted documents to answer your question.';
        } else {
          const toolResults = chatHistory
            .filter(m => m.role === 'tool' && m.content)
            .map(m => m.content)
            .filter(Boolean);

          if (toolResults.length > 0) {
            finalSynthText = '### Summary of Consulted Information\n\n' + toolResults.join('\n\n---\n\n');
          }
        }
      }

      if (finalSynthText) {
        if (finalSynthBlock) {
          finalSynthBlock.innerHTML = parseMd(finalSynthText);
          attachEvts(finalSynthBlock);
        }
        chatHistory.push({
          id: `${assistantMsgId}_final`,
          role: 'assistant',
          content: finalSynthText
        });
      }

      finalAssistantText = finalSynthText;
      finalStats = finalSynthStats;
      if (finalStats && typeof onStats === 'function') onStats(finalStats);
    }

    return {
      success: true,
      finalAssistantText,
      accumulatedMarkdown: (accumulatedConversationMarkdown ? accumulatedConversationMarkdown : '') + finalAssistantText,
      stats: finalStats,
      contextDiagnostics: lastContextDiagnostics,
      chatHistory
    };
  }

  return {
    getConversationDateAnchor,
    ensureConversationDate,
    getConfiguredSystemPrompt,
    getToolsSystemPromptGuide,
    injectStreamingCursor,
    buildEffectiveMessages,
    executeAgentTurnLoop,
    getLastContextDiagnostics: () => lastContextDiagnostics,
    extractBaseId,
    removeTurnFromHistory
  };
});
