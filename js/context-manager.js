/**
 * Módulo de Gestión Inteligente del Contexto (ChatContextManager) para ZeroChat.
 * Gestiona el presupuesto de tokens, estimación adaptable por modelo,
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
  // 1. Presupuestos y Ventanas de Contexto por Proveedor y Modelo
  // ==========================================================================

  const DEFAULT_MODEL_CONTEXT_LIMITS = {
    // Modelos locales y ligeros
    'llama-3': 8192,
    'llama-3.1': 128000,
    'llama-3.2': 128000,
    'llama-3.3': 128000,
    'qwen2.5': 32768,
    'mistral': 32768,
    'phi-3': 128000,
    'phi-4': 16384,
    'gemma-2': 8192,
    'gemma': 32768,

    // OpenAI
    'gpt-4o': 128000,
    'gpt-4o-mini': 128000,
    'gpt-4-turbo': 128000,
    'gpt-3.5-turbo': 16384,
    'o1': 128000,
    'o1-mini': 128000,
    'o3-mini': 128000,

    // Anthropic Claude
    'claude-3-5-sonnet': 200000,
    'claude-3-5-haiku': 200000,
    'claude-3-opus': 200000,

    // Google Gemini
    'gemini-1.5-pro': 1000000,
    'gemini-1.5-flash': 1000000,
    'gemini-2.0-flash': 1000000,
    'gemini-2.0-pro': 1000000
  };

  const DEFAULT_PROVIDER_FALLBACK_LIMITS = {
    ollama: 8192,
    openai: 128000,
    claude: 200000,
    gemini: 1000000,
    openrouter: 64000,
    custom: 32768
  };

  /**
   * Obtiene el límite máximo de contexto del modelo/proveedor.
   */
  function getModelContextLimit(model = '', providerType = 'openai') {
    const cleanModel = String(model || '').toLowerCase().trim();
    for (const [key, limit] of Object.entries(DEFAULT_MODEL_CONTEXT_LIMITS)) {
      if (cleanModel.includes(key)) {
        return limit;
      }
    }
    const cleanType = String(providerType || 'openai').toLowerCase().trim();
    return DEFAULT_PROVIDER_FALLBACK_LIMITS[cleanType] || 32768;
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
   * Trunca de forma segura el contenido de un resultado de herramienta.
   */
  function truncateToolContent(content, maxChars = DEFAULT_MAX_ACTIVE_TOOL_CHARS, toolName = 'tool') {
    const str = serializeContent(content);
    if (str.length <= maxChars) {
      return str;
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

  /**
   * Compacta activamente el contenido de herramientas previas cuando se ejecuta un punto de control (agent_checkpoint).
   * Mantiene intactos role, name, tool_call_id y metadata para no invalidar el protocolo de llamadas del proveedor.
   * @param {Array} messages - Lista de mensajes de la conversación o de trabajo.
   * @param {Object} [options={}] - Opciones de compactación.
   * @returns {Array} Nueva lista de mensajes con resultados voluminosos de herramientas compactados.
   */
  function compactToolHistory(messages = [], options = {}) {
    if (!Array.isArray(messages) || messages.length === 0) return [];
    const maxChars = options.maxCompactedChars || 250;
    const excludeNames = new Set(options.excludeToolNames || ['agent_checkpoint', 'checkpoint', 'agentcheckpoint']);
    const upToIndex = typeof options.upToIndex === 'number' ? options.upToIndex : messages.length;

    return messages.map((m, idx) => {
      if (idx >= upToIndex || !m || m.role !== 'tool') return m;
      const toolName = m.name || 'tool';
      if (excludeNames.has(toolName) || m._compactedByCheckpoint) return m;

      const contentStr = serializeContent(m.content);
      if (contentStr.length <= maxChars) return m;

      const preview = contentStr.slice(0, 100).replace(/\s+/g, ' ').trim();
      return {
        ...m,
        content: `[Salida previa de herramienta ${toolName} compactada en punto de control: "${preview}..."]`,
        _compactedByCheckpoint: true
      };
    });
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
    const processedLastBlock = lastBlock.map(m => {
      if (m.role === 'tool') {
        return {
          ...m,
          content: truncateToolContent(m.content, maxActiveToolChars, m.name)
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

  const SUMMARIZER_SYSTEM_PROMPT = `Eres un motor de consolidación de memoria de contexto para un asistente IA.
Tu objetivo es analizar los turnos de conversación proporcionados y generar un resumen estructurado, denso y conciso.
Conserva obligatoriamente:
- Requisitos y objetivos del usuario.
- Decisiones arquitectónicas, técnicas o de diseño tomadas.
- Hechos, datos verificados y resultados clave de herramientas.
- Tareas pendientes o siguientes pasos.
- Contexto técnico relevante (lenguajes, librerías, parámetros).

Responde estrictamente con el siguiente formato:
### [MEMORIA ESTRUCTURADA DE TURNOS ANTERIORES]
- **Requisitos y Objetivos:** <resumen de peticiones>
- **Decisiones Clave:** <elecciones acordadas>
- **Datos y Hechos Establecidos:** <datos confirmados o fuentes consultadas>
- **Tareas Pendientes:** <siguientes pasos o aspectos por resolver>
- **Contexto Técnico:** <entorno, versiones, configuraciones>`;

  /**
   * Evalúa si una conversación amerita compresión según presupuesto y volumen de turnos.
   */
  function shouldCompress(messages = [], options = {}) {
    if (!Array.isArray(messages) || messages.length < 8) {
      return false;
    }

    const minBlocksToCompress = options.minBlocksToCompress || 6;
    const recentTurnsToKeep = options.recentTurnsToKeep || 4;
    const conversationMessages = messages.filter(m => m && m.role !== 'system');

    if (conversationMessages.length < (minBlocksToCompress + recentTurnsToKeep)) {
      return false;
    }

    // Cooldown para evitar compresiones excesivamente frecuentes
    const lastSummaryMsg = messages.find(m => m && m._isSummaryBlock);
    if (lastSummaryMsg && lastSummaryMsg._compressedMetadata) {
      const turnsSinceSummary = messages.length - (lastSummaryMsg._compressedMetadata.endIndexInHistory || 0);
      if (turnsSinceSummary < (options.cooldownTurns || 4)) {
        return false;
      }
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
  function buildSummarizationTranscript(blocksToCompress = []) {
    const lines = [];

    blocksToCompress.flat().forEach(m => {
      if (!m || !m.role) return;

      if (m.role === 'user') {
        const text = typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.map(p => p.text || '').join(' ') : '');
        lines.push(`[Usuario]: ${text.slice(0, 1500)}`);
      } else if (m.role === 'assistant') {
        if (m.content) {
          lines.push(`[Asistente]: ${String(m.content).slice(0, 1500)}`);
        }
        if (Array.isArray(m.tool_calls)) {
          m.tool_calls.forEach(tc => {
            lines.push(`[Asistente invocó herramienta]: ${tc.function ? tc.function.name : 'tool'}`);
          });
        }
      } else if (m.role === 'tool') {
        const contentStr = serializeContent(m.content);
        lines.push(`[Resultado de herramienta ${m.name || 'tool'}]: ${contentStr.slice(0, 800)}`);
      }
    });

    return lines.join('\n\n');
  }

  /**
   * Resumidor determinista y extractivo de contingencia (fallback sin llamada de red).
   */
  function generateDeterministicSummary(blocksToCompress = []) {
    const userQueries = [];
    const toolExecutions = new Set();
    const keyPhrases = [];

    blocksToCompress.flat().forEach(m => {
      if (m.role === 'user') {
        const txt = typeof m.content === 'string' ? m.content : '';
        if (txt) userQueries.push(txt.slice(0, 120));
      } else if (m.role === 'tool' && m.name) {
        toolExecutions.add(m.name);
      } else if (m.role === 'assistant' && m.content) {
        const firstLine = String(m.content).split('\n')[0].slice(0, 100);
        if (firstLine) keyPhrases.push(firstLine);
      }
    });

    return `### [MEMORIA ESTRUCTURADA DE TURNOS ANTERIORES]
- **Requisitos y Objetivos:** ${userQueries.slice(0, 3).join(' | ') || 'Interacción general'}
- **Decisiones Clave:** Conversación continuada y procesamiento completado.
- **Datos y Hechos Establecidos:** Herramientas empleadas: ${Array.from(toolExecutions).join(', ') || 'Ninguna'}.
- **Tareas Pendientes:** Continuar con las consultas activas.
- **Contexto Técnico:** Turnos previos consolidados automáticamente.`;
  }

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

    const recentTurnsToKeep = options.recentTurnsToKeep || 4;

    // 1. Separar mensajes de sistema y mensajes conversacionales
    const systemMessages = [];
    const conversationMessages = [];

    messages.forEach(m => {
      if (m && m.role === 'system' && !m._isSummaryBlock) {
        systemMessages.push(m);
      } else if (m && m.role) {
        conversationMessages.push(m);
      }
    });

    if (conversationMessages.length <= recentTurnsToKeep) {
      return { messages, compressed: false, reason: 'insufficient_turns' };
    }

    // 2. Agrupar en bloques atómicos
    const atomicBlocks = groupIntoAtomicBlocks(conversationMessages);
    if (atomicBlocks.length <= 2) {
      return { messages, compressed: false, reason: 'insufficient_blocks' };
    }

    // 3. Separar bloques a comprimir de bloques recientes activos
    // Conservar los últimos N bloques intactos
    const blocksToKeepCount = Math.max(1, Math.floor(recentTurnsToKeep / 2));
    const splitIndex = Math.max(1, atomicBlocks.length - blocksToKeepCount);

    const blocksToCompress = atomicBlocks.slice(0, splitIndex);
    const blocksToKeep = atomicBlocks.slice(splitIndex);

    const originalTokens = estimateHistoryTokens(blocksToCompress.flat(), options.model);

    // 4. Generar el resumen estructurado mediante el modelo o fallback determinista
    let summaryContent = '';
    const transcript = buildSummarizationTranscript(blocksToCompress);

    if (typeof summarizeFn === 'function') {
      try {
        summaryContent = await summarizeFn({
          systemPrompt: SUMMARIZER_SYSTEM_PROMPT,
          userPrompt: `Por favor resume y consolida la siguiente conversación previa respetando el formato estructurado:\n\n${transcript}`
        });
      } catch (err) {
        console.warn('ChatContextManager: Error en summarizeFn, usando generador de contingencia:', err);
        summaryContent = generateDeterministicSummary(blocksToCompress);
      }
    } else {
      summaryContent = generateDeterministicSummary(blocksToCompress);
    }

    if (!summaryContent || summaryContent.trim() === '') {
      summaryContent = generateDeterministicSummary(blocksToCompress);
    }

    // 5. Construir el bloque de memoria sintético
    const memoryBlock = {
      id: `summary_${Date.now()}`,
      role: 'system',
      content: summaryContent,
      _isSummaryBlock: true,
      _compressedMetadata: {
        timestamp: Date.now(),
        originalMessagesCount: blocksToCompress.flat().length,
        originalEstimatedTokens: originalTokens,
        endIndexInHistory: blocksToCompress.flat().length
      }
    };

    // 6. Ensamblar la nueva historia comprimida
    const newMessages = [
      ...systemMessages,
      memoryBlock,
      ...blocksToKeep.flat()
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
    getModelContextLimit,
    calculateInputBudget,
    estimateTextTokens,
    estimateMessageTokens,
    estimateHistoryTokens,
    registerEstimator,
    truncateToolContent,
    pruneHistoricalToolMessage,
    compactToolHistory,
    groupIntoAtomicBlocks,
    buildOptimizedContext,
    getContextDiagnostics,
    shouldCompress,
    buildSummarizationTranscript,
    generateDeterministicSummary,
    compressHistory
  };
}));
