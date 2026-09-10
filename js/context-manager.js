/**
 * Módulo de Gestión Inteligente del Contexto (ChatContextManager) para ZeroChat.
 * Gestiona el presupuesto de tokens,
 * ventana deslizante segura con preservación de pares agénticos, control de resultados de herramientas
 * y sistema de compresión/resumen estructurado del historial.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.ChatContextManager = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ==========================================================================
  // 1. Presupuestos y Ventanas de Contexto
  // ==========================================================================

  // Only a fallback. The authoritative value must come from the provider.
  const DEFAULT_CONTEXT_LIMIT = 1000000;

  /**
   * Obtiene el límite de contexto publicado por el proveedor o el fallback general.
   */
  function getModelContextLimit(model = '', providerType = 'openai', configuredLimit) {
    const limit = Number(configuredLimit);
    return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_CONTEXT_LIMIT;
  }

  /**
   * Calcula el presupuesto de entrada disponible deduciendo salida máxima y margen de seguridad.
   */
  function calculateInputBudget(options = {}) {
    if (options.maxInputTokens && options.maxInputTokens > 0) {
      return options.maxInputTokens;
    }

    const totalLimit = options.totalContextLimit || getModelContextLimit(options.model, options.providerType);
    const maxOutput = options.maxOutputTokens || 4096;
    const safetyMargin = Math.ceil(totalLimit * (options.safetyMarginRatio || 0.10));

    const inputBudget = Math.max(1024, totalLimit - maxOutput - safetyMargin);
    return inputBudget;
  }

  // ==========================================================================
  // 2. Abstracción de Estimación de Tokens (Token Estimator)
  // ==========================================================================

  const customEstimators = new Map();

  function registerEstimator(pattern, estimatorFn) {
    if (typeof estimatorFn === 'function') {
      customEstimators.set(String(pattern).toLowerCase(), estimatorFn);
    }
  }

  /**
   * Estimador genérico y tolerante para cadenas de texto.
   * Aplica coeficientes según naturaleza del contenido (texto vs código/JSON).
   */
  function estimateTextTokens(text = '') {
    if (!text || typeof text !== 'string') return 0;
    const len = text.length;
    if (len === 0) return 0;

    // Código o JSON (densidad de caracteres de puntuación alta)
    const isCodeOrJson = text.includes('{') || text.includes('function') || text.includes('const ') || text.includes('```');
    const ratio = isCodeOrJson ? 2.9 : 3.6;

    return Math.max(1, Math.ceil(len / ratio));
  }

  /**
   * Estima los tokens de un único mensaje (incluyendo multimodales, tool_calls y tool results).
   */
  function estimateMessageTokens(message, model = '') {
    if (!message || typeof message !== 'object') return 0;

    // Comprobar si existe un estimador específico registrado para este modelo
    const cleanModel = String(model || '').toLowerCase();
    for (const [pattern, estimatorFn] of customEstimators.entries()) {
      if (cleanModel.includes(pattern)) {
        try {
          return estimatorFn(message);
        } catch (e) {
          // Fallback silencioso
        }
      }
    }

    let tokens = 4; // Overhead por mensaje (role, estructura)

    // Contenido textual o array multimodal
    if (typeof message.content === 'string') {
      tokens += estimateTextTokens(message.content);
    } else if (Array.isArray(message.content)) {
      message.content.forEach(part => {
        if (!part) return;
        if (part.type === 'text' && part.text) {
          tokens += estimateTextTokens(part.text);
        } else if (part.type === 'image_url' || part.type === 'image') {
          // Estimación estándar para imágenes (alta resolución ~1200 tokens)
          tokens += 1200;
        }
      });
    }

    // Tool calls emitidas por el asistente
    if (Array.isArray(message.tool_calls)) {
      message.tool_calls.forEach(tc => {
        tokens += 10; // Overhead de tool call
        if (tc.function) {
          tokens += estimateTextTokens(tc.function.name || '');
          const args = typeof tc.function.arguments === 'object'
            ? JSON.stringify(tc.function.arguments)
            : String(tc.function.arguments || '');
          tokens += estimateTextTokens(args);
        }
      });
    }

    return tokens;
  }

  /**
   * Estima los tokens totales de una lista de mensajes.
   */
  function estimateHistoryTokens(messages = [], model = '') {
    if (!Array.isArray(messages)) return 0;
    return messages.reduce((acc, m) => acc + estimateMessageTokens(m, model), 0);
  }

  // ==========================================================================
  // 3. Control y Poda de Resultados de Herramientas (Tool Results)
  // ==========================================================================

  const DEFAULT_MAX_ACTIVE_TOOL_CHARS = 30000;      // ~7.500 tokens para la herramienta del turno actual
  const DEFAULT_MAX_HISTORICAL_TOOL_CHARS = 1200;   // ~300 tokens para herramientas de turnos pasados

  function serializeContent(content) {
    if (typeof content === 'string') return content;
    if (content === undefined) return '';
    if (typeof content === 'object') return JSON.stringify(content);
    return String(content);
  }

  /**
   * Trunca de forma equilibrada una salida multisección (como múltiples fragmentos devueltos por read_knowledge_chunk).
   * En lugar de cortar el 70% central de todo el texto (lo que elimina por completo fragmentos enteros del medio),
   * distribuye el presupuesto proporcionalmente entre las secciones para que cada fragmento conserve su cabecera,
   * contexto y datos numéricos clave.
   */
  function truncateMultiSectionToolContent(sections, maxChars, toolName) {
    const separator = '\n\n---\n\n';
    const totalSeparatorsLength = separator.length * (sections.length - 1);
    const availableBudget = Math.max(sections.length * 200, maxChars - totalSeparatorsLength);

    const initialShare = Math.floor(availableBudget / sections.length);
    let remainingBudget = availableBudget;
    const finalSections = new Array(sections.length);
    const oversizedIndices = [];

    sections.forEach((sec, idx) => {
      if (sec.length <= initialShare) {
        finalSections[idx] = sec;
        remainingBudget -= sec.length;
      } else {
        oversizedIndices.push(idx);
      }
    });

    if (oversizedIndices.length === 0) {
      return sections.join(separator);
    }

    const shareForOversized = Math.max(150, Math.floor(remainingBudget / oversizedIndices.length));
    oversizedIndices.forEach(idx => {
      const sec = sections[idx];
      if (sec.length <= shareForOversized) {
        finalSections[idx] = sec;
      } else {
        const headLen = Math.floor(shareForOversized * 0.7);
        const tailLen = Math.floor(shareForOversized * 0.2);
        const head = sec.slice(0, headLen);
        const tail = sec.slice(-tailLen);
        const omitted = sec.length - (headLen + tailLen);
        finalSections[idx] = `${head}\n\n[... Truncado fragmento ${idx + 1}: ${omitted} caracteres omitidos de ${toolName} ...]\n\n${tail}`;
      }
    });

    return finalSections.join(separator);
  }

  /**
   * Trunca de forma segura el contenido de un resultado de herramienta.
   */
  function truncateToolContent(content, maxChars = DEFAULT_MAX_ACTIVE_TOOL_CHARS, toolName = 'tool') {
    const str = serializeContent(content);
    if (str.length <= maxChars) {
      return str;
    }

    // Si el contenido contiene múltiples secciones separadas por '---' (típico de read_knowledge_chunk)
    if (str.includes('\n\n---\n\n')) {
      const sections = str.split('\n\n---\n\n');
      if (sections.length > 1) {
        return truncateMultiSectionToolContent(sections, maxChars, toolName);
      }
    }

    const head = str.slice(0, Math.floor(maxChars * 0.7));
    const tail = str.slice(-Math.floor(maxChars * 0.2));
    return `${head}\n\n[... Truncado por ChatContextManager: ${str.length - maxChars} caracteres omitidos de la salida de ${toolName} ...]\n\n${tail}`;
  }

  /**
   * Compacta y poda los resultados de herramientas de turnos pasados completados.
   */
  function pruneHistoricalToolMessage(m, maxHistoricalToolChars = DEFAULT_MAX_HISTORICAL_TOOL_CHARS) {
    if (!m || m.role !== 'tool') return m;
    const contentStr = serializeContent(m.content);

    if (contentStr.length <= maxHistoricalToolChars) {
      return m;
    }

    const truncated = truncateToolContent(contentStr, maxHistoricalToolChars, m.name || 'tool');
    return {
      ...m,
      content: truncated,
      _prunedByContextManager: true
    };
  }

  // ==========================================================================
  // 4. Ventana Deslizante con Preservación de Pares Agénticos (Pair-Safe Sliding Window)
  // ==========================================================================

  /**
   * Agrupa los mensajes en bloques atómicos indivisibles para no romper sintaxis de Function Calling.
   * Un bloque puede ser:
   * - Un mensaje regular de usuario o asistente.
   * - Un par asistente (con tool_calls) + sus correspondientes mensajes tool (role: 'tool').
   */
  function groupIntoAtomicBlocks(messages = []) {
    const blocks = [];
    let i = 0;

    while (i < messages.length) {
      const current = messages[i];

      // Caso 1: Asistente con llamadas a herramientas
      if (current.role === 'assistant' && Array.isArray(current.tool_calls) && current.tool_calls.length > 0) {
        const block = [current];
        i++;
        // Recoger todos los mensajes 'tool' consecutivos que responden a este assistant
        while (i < messages.length && messages[i].role === 'tool') {
          block.push(messages[i]);
          i++;
        }
        blocks.push(block);
        continue;
      }

      // Caso 2: Mensaje tool huérfano (se protege en un bloque individual)
      if (current.role === 'tool') {
        blocks.push([current]);
        i++;
        continue;
      }

      // Caso 3: Mensaje regular de usuario, asistente o sistema
      blocks.push([current]);
      i++;
    }

    return blocks;
  }

  /**
   * Construye el contexto optimizado aplicando presupuesto, poda y ventana deslizante.
   */
  function buildOptimizedContext(rawMessages = [], options = {}) {
    const model = options.model || '';
    const providerType = options.providerType || 'openai';
    const inputBudget = calculateInputBudget(options);
    const maxHistoricalToolChars = options.maxHistoricalToolChars || DEFAULT_MAX_HISTORICAL_TOOL_CHARS;
    const maxActiveToolChars = options.maxActiveToolChars || DEFAULT_MAX_ACTIVE_TOOL_CHARS;

    if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
      return {
        messages: [],
        diagnostics: {
          budget: inputBudget,
          totalTokens: 0,
          includedCount: 0,
          excludedCount: 0,
          prunedToolsCount: 0
        }
      };
    }

    // 1. Separar mensajes del Sistema (Header crítico) y bloques de Memoria
    const systemMessages = [];
    const conversationMessages = [];

    rawMessages.forEach(m => {
      if (m && m.role === 'system') {
        systemMessages.push(m);
      } else if (m && m.role) {
        conversationMessages.push(m);
      }
    });

    // 2. Si no hay conversación, retornar solo el sistema
    if (conversationMessages.length === 0) {
      const systemTokens = estimateHistoryTokens(systemMessages, model);
      return {
        messages: systemMessages,
        diagnostics: {
          budget: inputBudget,
          totalTokens: systemTokens,
          systemTokens,
          includedCount: systemMessages.length,
          excludedCount: 0,
          prunedToolsCount: 0
        }
      };
    }

    // 3. Separar el Último Turno (Footer crítico que jamás se elimina)
    // El último turno incluye el último bloque atómico (ej: último user prompt o tool en curso)
    const atomicBlocks = groupIntoAtomicBlocks(conversationMessages);
    const lastBlock = atomicBlocks.pop(); // Último bloque indispensable

    // Aplicar límite al bloque activo si contiene herramientas
    const isExplicitActiveToolChars = typeof options.maxActiveToolChars === 'number';
    const processedLastBlock = lastBlock.map(m => {
      if (m.role === 'tool') {
        const isReadKnowledge = !isExplicitActiveToolChars && (m.name === 'read_knowledge_chunk' || m.name === 'readknowledgechunk');
        const effectiveMaxActiveChars = isReadKnowledge
          ? Math.max(maxActiveToolChars, Math.min(45000, Math.floor(inputBudget * 1.5)))
          : maxActiveToolChars;
        return {
          ...m,
          content: truncateToolContent(m.content, effectiveMaxActiveChars, m.name)
        };
      }
      return m;
    });

    const systemTokens = estimateHistoryTokens(systemMessages, model);
    const lastBlockTokens = estimateHistoryTokens(processedLastBlock, model);

    let currentTokens = systemTokens + lastBlockTokens;
    const remainingBudget = Math.max(0, inputBudget - currentTokens);

    // 4. Poda de herramientas pasadas en los bloques históricos
    let prunedToolsCount = 0;
    const processedHistoricalBlocks = atomicBlocks.map(block => {
      return block.map(m => {
        if (m.role === 'tool') {
          const pruned = pruneHistoricalToolMessage(m, maxHistoricalToolChars);
          if (pruned._prunedByContextManager) prunedToolsCount++;
          return pruned;
        }
        return m;
      });
    });

    // 5. Ventana deslizante hacia atrás (de más reciente a más antiguo)
    const includedHistoricalBlocks = [];
    let excludedMessagesCount = 0;

    for (let bIdx = processedHistoricalBlocks.length - 1; bIdx >= 0; bIdx--) {
      const block = processedHistoricalBlocks[bIdx];
      const blockTokens = estimateHistoryTokens(block, model);

      if (currentTokens + blockTokens <= inputBudget) {
        includedHistoricalBlocks.unshift(block);
        currentTokens += blockTokens;
      } else {
        // Bloque no cabe en el presupuesto: se excluye completo
        excludedMessagesCount += block.length;
      }
    }

    // 6. Ensamblado final de la lista de mensajes
    const finalMessages = [
      ...systemMessages,
      ...includedHistoricalBlocks.flat(),
      ...processedLastBlock
    ];

    const totalFinalTokens = estimateHistoryTokens(finalMessages, model);

    return {
      messages: finalMessages,
      diagnostics: {
        budget: inputBudget,
        totalTokens: totalFinalTokens,
        systemTokens: systemTokens,
        includedCount: finalMessages.length,
        excludedCount: excludedMessagesCount,
        prunedToolsCount: prunedToolsCount,
        strategy: excludedMessagesCount > 0 ? 'sliding_window_truncated' : 'full_history'
      }
    };
  }

  // ==========================================================================
  // 5. Sistema de Compresión y Resumen Inteligente de Memoria (Memory Compression)
  // ==========================================================================

  const SUMMARIZER_SYSTEM_PROMPT = `You consolidate a conversation checkpoint. Create one concise, cumulative summary of the checkpoint supplied, if any, and every subsequent message supplied. Preserve user goals, decisions, verified facts, tool calls and their results, open questions, and details needed to continue. Do not mention this instruction or omit relevant information merely because of its source.`;

  /**
   * Evalúa si una conversación amerita compresión según presupuesto y volumen de turnos.
   */
  function shouldCompress(messages = [], options = {}) {
    if (!Array.isArray(messages) || messages.length < 8) {
      return false;
    }

    const minMessagesToCompress = options.minMessagesToCompress || 2;
    const lastCheckpointIndex = messages.reduce((lastIndex, message, index) => (
      message && message._isSummaryBlock ? index : lastIndex
    ), -1);
    const messagesSinceCheckpoint = messages.slice(lastCheckpointIndex + 1)
      .filter(message => message && message.role && message.role !== 'system');

    if (messagesSinceCheckpoint.length < minMessagesToCompress) {
      return false;
    }

    const model = options.model || '';
    const inputBudget = calculateInputBudget(options);
    const totalTokens = estimateHistoryTokens(messages, model);
    const thresholdRatio = options.compressionThresholdRatio || 0.70;

    return totalTokens >= (inputBudget * thresholdRatio);
  }

  /**
   * Construye el prompt de transcripción para enviar al motor de resumen.
   */
  /**
   * Comprime y consolida de forma segura los turnos antiguos de una conversación.
   */
  async function compressHistory(params = {}) {
    const {
      messages = [],
      summarizeFn = null,
      options = {}
    } = params;

    if (!Array.isArray(messages) || messages.length === 0) {
      return { messages: [], compressed: false, reason: 'empty_messages' };
    }

    // Preserve permanent system messages. A checkpoint is the only historical
    // memory passed to the summarizer; every later message is passed verbatim.
    const systemMessages = [];
    let checkpoint = null;
    let lastCheckpointIndex = -1;

    messages.forEach((m, index) => {
      if (m && m._isSummaryBlock) {
        checkpoint = m;
        lastCheckpointIndex = index;
      } else if (m && m.role === 'system') {
        systemMessages.push(m);
      }
    });

    const dialogue = messages.slice(lastCheckpointIndex + 1).filter(m => m && m.role && m.role !== 'system');
    if (dialogue.length === 0 || typeof summarizeFn !== 'function') {
      return { messages, compressed: false, reason: dialogue.length === 0 ? 'no_new_dialogue' : 'summarizer_unavailable' };
    }

    const originalTokens = estimateHistoryTokens([...(checkpoint ? [checkpoint] : []), ...dialogue], options.model);
    let summaryContent = '';
    try {
      summaryContent = await summarizeFn({
        systemPrompt: SUMMARIZER_SYSTEM_PROMPT,
        checkpoint,
        dialogue,
        messages: [...(checkpoint ? [checkpoint] : []), ...dialogue]
      });
    } catch (err) {
      return { messages, compressed: false, reason: 'summarization_failed', error: err };
    }

    if (typeof summaryContent !== 'string' || summaryContent.trim() === '') {
      return { messages, compressed: false, reason: 'empty_summary' };
    }

    // 5. Construir el bloque de memoria sintético
    const memoryBlock = {
      id: `summary_${Date.now()}`,
      role: 'system',
      content: summaryContent,
      _isSummaryBlock: true,
      _compressedMetadata: {
        timestamp: Date.now(),
        originalMessagesCount: (checkpoint ? 1 : 0) + dialogue.length,
        originalEstimatedTokens: originalTokens,
        replacesThroughIndex: messages.length - 1
      }
    };

    // 6. Ensamblar la nueva historia comprimida
    const newMessages = [
      ...systemMessages,
      memoryBlock,
    ];

    const compressedTokens = estimateHistoryTokens(newMessages, options.model);

    return {
      messages: newMessages,
      compressed: true,
      memoryBlock,
      diagnostics: {
        originalMessagesCount: messages.length,
        newMessagesCount: newMessages.length,
        originalTokens,
        compressedTokens,
        savedTokens: Math.max(0, originalTokens - estimateMessageTokens(memoryBlock, options.model))
      }
    };
  }

  /**
   * Calcula diagnósticos del estado del contexto para telemetría e interfaz de usuario.
   * @param {Array} messages - Historial de mensajes.
   * @param {Object} [options={}] - Parámetros de modelo, proveedor y tokens informados.
   * @returns {Object} Diagnósticos normalizados.
   */
  function getContextDiagnostics(messages = [], options = {}) {
    const model = options.model || '';
    const providerType = options.providerType || 'openai';
    const totalLimit = options.totalContextLimit || getModelContextLimit(model, providerType);
    const budget = calculateInputBudget({ ...options, totalContextLimit: totalLimit });

    const isEstimated = options.usedTokens === undefined || options.usedTokens === null;
    const usedTokens = !isEstimated ? Number(options.usedTokens) : estimateHistoryTokens(messages, model);
    const percentUsed = totalLimit > 0 ? Math.min(100, (usedTokens / totalLimit) * 100) : 0;
    const remainingTokens = Math.max(0, totalLimit - usedTokens);

    return {
      model,
      providerType,
      totalLimit,
      budget,
      usedTokens,
      remainingTokens,
      percentUsed: Number(percentUsed.toFixed(1)),
      isEstimated,
      prunedCount: options.prunedCount || 0,
      excludedCount: options.excludedCount || 0,
      strategy: options.strategy || (options.excludedCount > 0 ? 'sliding_window_truncated' : 'full_history')
    };
  }

  return {
    DEFAULT_CONTEXT_LIMIT,
    getModelContextLimit,
    calculateInputBudget,
    estimateTextTokens,
    estimateMessageTokens,
    estimateHistoryTokens,
    registerEstimator,
    truncateToolContent,
    pruneHistoricalToolMessage,
    groupIntoAtomicBlocks,
    buildOptimizedContext,
    getContextDiagnostics,
    shouldCompress,
    compressHistory
  };
}));
