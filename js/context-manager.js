/**
 * Módulo de Gestión Inteligente del Contexto (ChatContextManager) para ZeroChat.
 * Gestiona el presupuesto de tokens,
 * ventana deslizante segura con preservación de pares agénticos, control de resultados de herramientas
 * y sistema de compresión/resumen estructurado del historial.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./utils.js'));
  } else {
    root.ChatContextManager = factory(root.ChatUtils);
  }
}(typeof self !== 'undefined' ? self : this, function (Utils) {
  'use strict';

  // ==========================================================================
  // 1. Presupuestos y Ventanas de Contexto
  // ==========================================================================

  // Only a fallback. The authoritative value must come from the provider.
  const DEFAULT_CONTEXT_LIMIT = 1000000;
  // Contexto que se asume para un modelo WebLLM sin dato propio.
  const WEBLLM_DEFAULT_CONTEXT = 4096;

  /** Id de una entrada del catálogo de modelos: la cadena misma o su id o nombre. */
  const catalogModelId = model => (typeof model === 'string' ? model : (model?.id || model?.name || '')).trim();

  /** Entrada del catálogo para un modelo: por id exacto, sin `models/` ni `:latest`, o por sufijo de ruta. */
  function findModelInCatalog(models, targetModel) {
    const target = String(targetModel || '').trim().toLowerCase();
    if (!target) return null;
    const idOf = model => catalogModelId(model).toLowerCase();
    const base = id => id.replace(/^models\//, '').replace(/:latest$/, '');
    return models.find(model => idOf(model) === target)
      || models.find(model => base(idOf(model)) === base(target))
      || models.find(model => idOf(model).endsWith(`/${target}`) || target.endsWith(`/${idOf(model)}`))
      || null;
  }

  /**
   * Contexto de un modelo según su entrada del catálogo del proveedor: primero el cargado en el
   * servidor, luego el nominal y por último los tokens máximos declarados; null si no lo publica.
   */
  function getModelContextLimit(model, catalog) {
    const selected = String(model || '').trim();
    if (!selected) return null;
    const entry = findModelInCatalog(catalog, selected);
    const details = entry?.details || entry || {};
    const meta = details.meta || entry?.meta || {};
    const smallest = values => {
      const valid = values.map(Number).filter(value => Number.isFinite(value) && value > 0);
      return valid.length ? Math.floor(Math.min(...valid)) : null;
    };

    const active = smallest([details.loaded_context_length, meta.n_ctx]);
    if (active) return active;
    const nominal = smallest([
      details.max_context_length,
      meta.n_ctx_train,
      details.context_length ?? entry?.context_length,
      details.context_window ?? entry?.context_window,
      details.max_model_len ?? entry?.max_model_len
    ]);
    if (nominal) return nominal;
    const declared = smallest([details.max_context_tokens ?? details.max_tokens]);
    if (declared) return declared;
    return details.webllmCache || selected.includes('-MLC') ? WEBLLM_DEFAULT_CONTEXT : null;
  }

  /**
   * Calcula el presupuesto de entrada disponible deduciendo salida máxima y margen de seguridad.
   */
  function calculateInputBudget(options = {}) {
    if (options.maxInputTokens && options.maxInputTokens > 0) {
      return options.maxInputTokens;
    }

    const totalLimit = options.totalContextLimit || DEFAULT_CONTEXT_LIMIT;
    const maxOutput = options.maxOutputTokens || 4096;
    const safetyMargin = Math.ceil(totalLimit * (options.safetyMarginRatio || 0.10));

    const inputBudget = Math.max(1024, totalLimit - maxOutput - safetyMargin);
    return inputBudget;
  }

  // ==========================================================================
  // 2. Abstracción de Estimación de Tokens (Token Estimator)
  // ==========================================================================

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

    // Razonamiento reenviado dentro del turno en curso (buildEffectiveMessages)
    ['reasoning_content', 'reasoning'].forEach(field => {
      if (typeof message[field] === 'string') tokens += estimateTextTokens(message[field]);
    });

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

  const DEFAULT_MAX_ACTIVE_TOOL_CHARS = 64000;      // Red de seguridad del turno en curso (por encima de los 60.000 de web, MCP y read_file)
  const DEFAULT_MAX_HISTORICAL_TOOL_CHARS = 4000;   // Poda para herramientas de turnos pasados ya cerrados
  const ACTIVE_BATCH_BUDGET_RATIO = 0.30;           // Fracción máxima de inputBudget para la suma de resultados tool de un mismo paso
  const CHARS_PER_TOKEN_ESTIMATE = 3;               // Relación conservadora caracteres/token para convertir presupuestos

  const { serializeContent } = Utils;

  /**
   * Reparte un presupuesto agregado de caracteres entre los mensajes `tool` de un mismo bloque atómico
   * (lote de llamadas paralelas), respetando también el techo individual `maxPerToolChars`.
   * Los resultados cortos se conservan íntegros y su sobrante se reparte entre los más largos.
   */
  function capToolBatchBlock(block, maxPerToolChars, maxBatchChars) {
    const toolIndices = [];
    const serialized = new Map();
    block.forEach((m, idx) => {
      if (m && m.role === 'tool') {
        toolIndices.push(idx);
        serialized.set(idx, serializeContent(m.content));
      }
    });
    if (toolIndices.length === 0) return block;

    // Primero calcular la longitud tras el techo individual.
    const cappedLengths = new Map();
    let totalAfterIndividual = 0;
    for (const idx of toolIndices) {
      const len = Math.min(serialized.get(idx).length, maxPerToolChars);
      cappedLengths.set(idx, len);
      totalAfterIndividual += len;
    }

    // Si el lote completo cabe en maxBatchChars (o solo hay una herramienta), basta el techo individual.
    if (toolIndices.length === 1 || !maxBatchChars || totalAfterIndividual <= maxBatchChars) {
      return block.map((m, idx) => (serialized.has(idx)
        ? { ...m, content: truncateToolContent(serialized.get(idx), maxPerToolChars, m.name) }
        : m));
    }

    // Reparto proporcional con redistribución del sobrante (igual que truncateMultiSectionToolContent).
    const initialShare = Math.floor(maxBatchChars / toolIndices.length);
    let remainingBudget = maxBatchChars;
    const oversized = [];
    const limits = new Map();

    for (const idx of toolIndices) {
      const len = cappedLengths.get(idx);
      if (len <= initialShare) {
        limits.set(idx, len);
        remainingBudget -= len;
      } else {
        oversized.push(idx);
      }
    }

    if (oversized.length > 0) {
      const shareForOversized = Math.min(maxPerToolChars, Math.max(200, Math.floor(remainingBudget / oversized.length)));
      for (const idx of oversized) {
        limits.set(idx, shareForOversized);
      }
    }

    return block.map((m, idx) => {
      if (!serialized.has(idx)) return m;
      const limit = limits.get(idx);
      return { ...m, content: truncateToolContent(serialized.get(idx), limit, m.name) };
    });
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

  // Marca del mensaje user con la evidencia visual de una racha de resultados (ChatEngine); no viaja al proveedor.
  const TOOL_EVIDENCE_FLAG = '_toolEvidence';

  function stripToolEvidenceFlag(message) {
    if (!message[TOOL_EVIDENCE_FLAG]) return message;
    const { [TOOL_EVIDENCE_FLAG]: _flag, ...rest } = message;
    return rest;
  }

  /**
   * Agrupa los mensajes en bloques atómicos indivisibles para no romper sintaxis de Function Calling.
   * Un bloque puede ser:
   * - Un mensaje regular de usuario o asistente.
   * - Un par asistente (con tool_calls) + sus correspondientes mensajes tool (role: 'tool') y, si la
   *   hay, la evidencia visual de esos resultados.
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
        // y la evidencia visual de sus resultados, que no tiene sentido sin ellos
        if (i < messages.length && messages[i][TOOL_EVIDENCE_FLAG]) {
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

    // Aplicar techo de seguridad individual y agregado por lote a herramientas del turno en curso (acotado al inputBudget)
    const isExplicitActiveToolChars = typeof options.maxActiveToolChars === 'number';
    const maxBatchCharsFromBudget = Math.max(
      maxHistoricalToolChars,
      Math.floor(inputBudget * ACTIVE_BATCH_BUDGET_RATIO * CHARS_PER_TOKEN_ESTIMATE)
    );
    const effectiveMaxActiveChars = isExplicitActiveToolChars
      ? maxActiveToolChars
      : Math.min(maxActiveToolChars, maxBatchCharsFromBudget);
    const effectiveMaxBatchChars = typeof options.maxActiveBatchToolChars === 'number'
      ? Math.max(1, Math.floor(options.maxActiveBatchToolChars))
      : (isExplicitActiveToolChars ? 0 : maxBatchCharsFromBudget);
    const capActiveBlock = block => capToolBatchBlock(block, effectiveMaxActiveChars, effectiveMaxBatchChars);

    const processedLastBlock = capActiveBlock(lastBlock);

    const systemTokens = estimateHistoryTokens(systemMessages, model);
    const lastBlockTokens = estimateHistoryTokens(processedLastBlock, model);

    let currentTokens = systemTokens + lastBlockTokens;

    // 4. Poda para turnos pasados cerrados (anteriores al último mensaje user) y poda progresiva intra-turno si el
    // turno en curso supera el presupuesto por sí solo: mantiene a techo activo solo los pasos más recientes que quepan
    // en el presupuesto activo, conservando siempre el mensaje user del turno.
    const lastTurnStartsAtLastBlock = lastBlock[0]?.role === 'user';
    let lastUserBlockIdx = -1;
    if (!lastTurnStartsAtLastBlock) {
      for (let i = atomicBlocks.length - 1; i >= 0; i--) {
        if (atomicBlocks[i][0]?.role === 'user') {
          lastUserBlockIdx = i;
          break;
        }
      }
    }

    let prunedToolsCount = 0;
    let processedHistoricalBlocks = atomicBlocks.map((block, bIdx) => {
      const isClosedTurn = lastTurnStartsAtLastBlock || bIdx < lastUserBlockIdx;
      if (!isClosedTurn) return capActiveBlock(block);
      return block.map(m => {
        if (m.role !== 'tool') return m;
        const pruned = pruneHistoricalToolMessage(m, maxHistoricalToolChars);
        if (pruned._prunedByContextManager) prunedToolsCount++;
        return pruned;
      });
    });

    // Si los bloques del turno en curso (del último user en adelante) superan por sí solos inputBudget,
    // podar progresivamente a maxHistoricalToolChars los pasos más antiguos del propio turno activo.
    if (!lastTurnStartsAtLastBlock && lastUserBlockIdx !== -1) {
      const activeBlocksTokens = processedHistoricalBlocks
        .slice(lastUserBlockIdx)
        .reduce((acc, block) => acc + estimateHistoryTokens(block, model), 0);
      if (currentTokens + activeBlocksTokens > inputBudget) {
        const userBlockTokens = estimateHistoryTokens(processedHistoricalBlocks[lastUserBlockIdx], model);
        let activeRemaining = inputBudget - currentTokens - userBlockTokens;
        for (let bIdx = processedHistoricalBlocks.length - 1; bIdx > lastUserBlockIdx; bIdx--) {
          const block = processedHistoricalBlocks[bIdx];
          const blockTokens = estimateHistoryTokens(block, model);
          if (blockTokens <= activeRemaining) {
            activeRemaining -= blockTokens;
            continue;
          }
          const prunedBlock = block.map(m => {
            if (m.role !== 'tool') return m;
            const pruned = pruneHistoricalToolMessage(m, maxHistoricalToolChars);
            if (pruned._prunedByContextManager) prunedToolsCount++;
            return pruned;
          });
          processedHistoricalBlocks[bIdx] = prunedBlock;
          activeRemaining -= estimateHistoryTokens(prunedBlock, model);
        }
      }
    }

    // 5. Ventana deslizante contigua hacia atrás (de más reciente a más antiguo): se detiene al primer
    // bloque que no cabe para no dejar huecos intermedios ni invalidar la caché KV de prefijo.
    // Si el turno en curso se cortó antes de llegar a su mensaje `user`, ese `user` se preserva siempre.
    const includedHistoricalBlocks = [];
    let excludedMessagesCount = 0;
    const reservedUserBlock = (!lastTurnStartsAtLastBlock && lastUserBlockIdx !== -1)
      ? processedHistoricalBlocks[lastUserBlockIdx]
      : null;
    const reservedUserTokens = reservedUserBlock ? estimateHistoryTokens(reservedUserBlock, model) : 0;
    let remainingBudget = inputBudget - currentTokens - reservedUserTokens;
    let reachedUserBlock = false;

    for (let bIdx = processedHistoricalBlocks.length - 1; bIdx >= 0; bIdx--) {
      if (bIdx === lastUserBlockIdx) {
        includedHistoricalBlocks.unshift(reservedUserBlock);
        currentTokens += reservedUserTokens;
        reachedUserBlock = true;
        continue;
      }
      const block = processedHistoricalBlocks[bIdx];
      const blockTokens = estimateHistoryTokens(block, model);

      if (blockTokens <= remainingBudget) {
        includedHistoricalBlocks.unshift(block);
        currentTokens += blockTokens;
        remainingBudget -= blockTokens;
      } else {
        for (let skipped = bIdx; skipped >= 0; skipped--) {
          if (skipped === lastUserBlockIdx) continue;
          excludedMessagesCount += processedHistoricalBlocks[skipped].length;
        }
        break;
      }
    }
    if (reservedUserBlock && !reachedUserBlock) {
      includedHistoricalBlocks.unshift(reservedUserBlock);
      currentTokens += reservedUserTokens;
    }

    // 6. Ensamblado final de la lista de mensajes, sin la marca interna de la evidencia visual
    const finalMessages = [
      ...systemMessages,
      ...includedHistoricalBlocks.flat(),
      ...processedLastBlock
    ].map(stripToolEvidenceFlag);

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
   * Índice del mensaje `user` que abre el turno en curso si no es un mensaje de evidencia visual; -1 si no hay ninguno.
   */
  function findActiveTurnStartIndex(messages = []) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m && m.role === 'user' && !m[TOOL_EVIDENCE_FLAG]) return i;
    }
    return -1;
  }

  /**
   * Evalúa si una conversación amerita compresión según presupuesto y volumen de turnos cerrados.
   */
  function shouldCompress(messages = [], options = {}) {
    if (!Array.isArray(messages) || messages.length < 8) {
      return false;
    }

    const minMessagesToCompress = options.minMessagesToCompress || 2;
    const lastCheckpointIndex = messages.reduce((lastIndex, message, index) => (
      message && message._isSummaryBlock ? index : lastIndex
    ), -1);
    const keepActiveTurn = options.keepActiveTurn !== false;
    const activeTurnStart = keepActiveTurn ? findActiveTurnStartIndex(messages) : -1;
    const compressibleEnd = activeTurnStart !== -1 ? activeTurnStart : messages.length;
    const messagesSinceCheckpoint = messages.slice(lastCheckpointIndex + 1, compressibleEnd)
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
   * Construye una transcripción neutral en texto plano del historial para el resumidor.
   * Evita enviar turnos conversacionales nativos (role: 'assistant'/'tool') que inducen
   * inercia de rol agéntico o emisión de nuevas llamadas a herramientas.
   * Si se pasa `maxTranscriptChars` (o `totalContextLimit`/`maxInputTokens`), acota la transcripción
   * para que quepa holgadamente en el presupuesto de entrada del modelo resumidor.
   */
  function formatHistoryTranscript(messages = [], options = {}) {
    if (!Array.isArray(messages) || messages.length === 0) return '';
    const maxToolChars = options.maxHistoricalToolChars || DEFAULT_MAX_HISTORICAL_TOOL_CHARS;
    const lines = [];

    messages.forEach(m => {
      if (!m || !m.role) return;
      if (m._isSummaryBlock) {
        lines.push(`[Previous Checkpoint Summary]:\n${m.content || ''}`);
        return;
      }
      if (m.role === 'user') {
        let text = '';
        if (typeof m.content === 'string') {
          text = m.content;
        } else if (Array.isArray(m.content)) {
          text = m.content.filter(part => part?.type === 'text').map(part => part.text || '').join('\n');
        }
        if (m.commandNotes) text = text ? `${m.commandNotes}\n${text}` : m.commandNotes;
        if (text) lines.push(`User: ${text}`);
      } else if (m.role === 'assistant') {
        const text = typeof m.content === 'string' ? m.content.trim() : '';
        const toolCalls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
        const parts = [];
        if (text) parts.push(text);
        if (toolCalls.length > 0) {
          const callDescs = toolCalls.map(tc => {
            const name = tc?.function?.name || tc?.name || 'tool';
            const rawArgs = tc?.function?.arguments ?? tc?.arguments;
            let argsStr = '';
            if (typeof rawArgs === 'string') {
              argsStr = rawArgs;
            } else if (rawArgs && typeof rawArgs === 'object') {
              try { argsStr = JSON.stringify(rawArgs); } catch (_) { argsStr = ''; }
            }
            // Los argumentos (p. ej. el contenido de write_file) tienen el mismo tope que los resultados.
            return argsStr ? `${name}(${truncateToolContent(argsStr, maxToolChars, name)})` : name;
          });
          parts.push(`[Called tools: ${callDescs.join(', ')}]`);
        }
        if (parts.length > 0) lines.push(`Assistant: ${parts.join('\n')}`);
      } else if (m.role === 'tool') {
        const name = m.name || 'tool';
        const rawContent = typeof m.content === 'string' ? m.content : (m.content ? JSON.stringify(m.content) : '');
        const contentStr = rawContent.length > maxToolChars
          ? truncateToolContent(rawContent, maxToolChars, name)
          : rawContent;
        lines.push(`Tool (${name}): ${contentStr}`);
      }
    });

    const transcript = lines.join('\n\n');
    let maxTranscriptChars = typeof options.maxTranscriptChars === 'number' && options.maxTranscriptChars > 0
      ? Math.floor(options.maxTranscriptChars)
      : 0;
    if (!maxTranscriptChars && (options.totalContextLimit || options.maxInputTokens)) {
      // Dejar margen para las instrucciones del resumidor y la salida del checkpoint (~2.5 chars/token del 80% del presupuesto).
      maxTranscriptChars = Math.max(2000, Math.floor(calculateInputBudget(options) * 0.8 * 2.5));
    }
    if (maxTranscriptChars > 0 && transcript.length > maxTranscriptChars) {
      return truncateToolContent(transcript, maxTranscriptChars, 'conversation_history');
    }
    return transcript;
  }

  /**
   * Comprime y consolida de forma segura los turnos antiguos de una conversación.
   * Por defecto (`keepActiveTurn: true`) resume solo los turnos cerrados anteriores al último mensaje `user`
   * y conserva intactos ese mensaje `user` y los pasos del turno en curso.
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
    // memory passed to the summarizer; every later closed-turn message is passed verbatim.
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

    const keepActiveTurn = options.keepActiveTurn !== false;
    const activeTurnStart = keepActiveTurn ? findActiveTurnStartIndex(messages) : -1;
    const compressibleEnd = activeTurnStart !== -1 ? activeTurnStart : messages.length;
    const activeTurnMessages = activeTurnStart !== -1
      ? messages.slice(activeTurnStart).filter(m => m && m.role && m.role !== 'system')
      : [];

    const dialogue = messages.slice(lastCheckpointIndex + 1, compressibleEnd)
      .filter(m => m && m.role && m.role !== 'system');
    if (dialogue.length === 0 || typeof summarizeFn !== 'function') {
      return { messages, compressed: false, reason: dialogue.length === 0 ? 'no_new_dialogue' : 'summarizer_unavailable' };
    }

    const originalTokens = estimateHistoryTokens([...(checkpoint ? [checkpoint] : []), ...dialogue], options.model);
    let summaryContent = '';
    try {
      const addendum = typeof options.summarizerAddendum === 'string' ? options.summarizerAddendum.trim() : '';
      summaryContent = await summarizeFn({
        systemPrompt: addendum ? `${SUMMARIZER_SYSTEM_PROMPT}\n\n${addendum}` : SUMMARIZER_SYSTEM_PROMPT,
        checkpoint,
        dialogue,
        messages: [...(checkpoint ? [checkpoint] : []), ...dialogue],
        options
      });
    } catch (err) {
      return { messages, compressed: false, reason: 'summarization_failed', error: err };
    }

    const trimmedSummary = typeof summaryContent === 'string' ? summaryContent.trim() : '';
    if (!trimmedSummary) {
      return { messages, compressed: false, reason: 'empty_summary' };
    }

    try {
      const parsed = JSON.parse(trimmedSummary);
      if (parsed && typeof parsed === 'object') {
        if (parsed.name && (parsed.arguments !== undefined || parsed.parameters !== undefined)) {
          return { messages, compressed: false, reason: 'invalid_summary' };
        }
        if (Array.isArray(parsed.tool_calls) && parsed.tool_calls.length > 0) {
          return { messages, compressed: false, reason: 'invalid_summary' };
        }
      }
    } catch (_) {
      // Si no es un JSON válido, el texto no representa una llamada a herramienta serializada.
    }

    // 5. Construir el bloque de memoria sintético
    const memoryBlock = {
      id: `summary_${Date.now()}`,
      role: 'system',
      content: trimmedSummary,
      _isSummaryBlock: true,
      _compressedMetadata: {
        timestamp: Date.now(),
        originalMessagesCount: (checkpoint ? 1 : 0) + dialogue.length,
        originalEstimatedTokens: originalTokens,
        replacesThroughIndex: compressibleEnd - 1
      }
    };

    // 6. Ensamblar la nueva historia comprimida conservando el turno en curso
    const newMessages = [
      ...systemMessages,
      memoryBlock,
      ...activeTurnMessages
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
    const totalLimit = options.totalContextLimit || DEFAULT_CONTEXT_LIMIT;
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
    WEBLLM_DEFAULT_CONTEXT,
    catalogModelId,
    findModelInCatalog,
    getModelContextLimit,
    calculateInputBudget,
    estimateTextTokens,
    estimateMessageTokens,
    truncateToolContent,
    buildOptimizedContext,
    TOOL_EVIDENCE_FLAG,
    getContextDiagnostics,
    shouldCompress,
    compressHistory,
    formatHistoryTranscript
  };
}));
