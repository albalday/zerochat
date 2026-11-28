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

  // Respaldo prudente cuando el proveedor no publica el límite de contexto del modelo.
  const DEFAULT_CONTEXT_LIMIT = 128000;
  // Contexto que se asume para un modelo WebLLM sin dato propio.
  const WEBLLM_DEFAULT_CONTEXT = 4096;
  // Presupuesto de entrada: el contexto menos la salida reservada y un margen de seguridad, con un mínimo.
  const RESERVED_OUTPUT_TOKENS = 4096;
  const SAFETY_MARGIN_RATIO = 0.10;
  const MIN_INPUT_BUDGET = 1024;

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
      details.max_model_len ?? entry?.max_model_len,
      details.inputTokenLimit ?? entry?.inputTokenLimit
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
    const totalLimit = options.totalContextLimit || DEFAULT_CONTEXT_LIMIT;
    const safetyMargin = Math.ceil(totalLimit * SAFETY_MARGIN_RATIO);
    return Math.max(MIN_INPUT_BUDGET, totalLimit - RESERVED_OUTPUT_TOKENS - safetyMargin);
  }

  // ==========================================================================
  // 2. Abstracción de Estimación de Tokens (Token Estimator)
  // ==========================================================================

  // Caracteres por token que asume el estimador para código o JSON y para texto.
  const CODE_CHARS_PER_TOKEN = 2.9;
  const TEXT_CHARS_PER_TOKEN = 3.6;

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
    const ratio = isCodeOrJson ? CODE_CHARS_PER_TOKEN : TEXT_CHARS_PER_TOKEN;

    return Math.max(1, Math.ceil(len / ratio));
  }

  /**
   * Estima los tokens de un único mensaje (incluyendo multimodales, tool_calls, tool results,
   * imágenes adjuntas antes de convertirse en image_url, commandNotes y reasoningReplay).
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

    // Imágenes adjuntas en el historial antes de expandirse a bloques image_url (user y tool)
    if (Array.isArray(message.images) && message.images.length > 0 && !Array.isArray(message.content)) {
      message.images.forEach(img => {
        if (img && img.dataUrl) tokens += 1200;
      });
    }

    // Notas internas de comandos en segundo plano terminados
    if (typeof message.commandNotes === 'string' && message.commandNotes) {
      tokens += estimateTextTokens(message.commandNotes);
    }

    // Razonamiento reenviado dentro del turno en curso (buildEffectiveMessages o workingMessages)
    let hasInlineReasoning = false;
    ['reasoning_content', 'reasoning', 'thinking'].forEach(field => {
      if (typeof message[field] === 'string' && message[field]) {
        tokens += estimateTextTokens(message[field]);
        hasInlineReasoning = true;
      }
    });
    if (!hasInlineReasoning && typeof message.reasoningReplay?.text === 'string' && message.reasoningReplay.text) {
      tokens += estimateTextTokens(message.reasoningReplay.text);
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
   * Estima los tokens totales de las definiciones Function Calling enviadas en `payload.tools`.
   */
  function estimateToolDefinitionsTokens(tools = []) {
    if (!Array.isArray(tools) || tools.length === 0) return 0;
    let tokens = 0;
    for (const tool of tools) {
      if (!tool || typeof tool !== 'object') continue;
      tokens += 12; // Overhead por definición
      try {
        tokens += estimateTextTokens(JSON.stringify(tool));
      } catch (_) { /* definición no serializable */ }
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
  const ACTIVE_RECENT_BUDGET_RATIO = 0.45;          // Fracción máxima de inputBudget reservada a pasos recientes completos del turno en curso
  const WINDOW_HYSTERESIS_TARGET_RATIO = 0.65;      // Objetivo de histéresis al recortar el turno en curso para preservar la caché KV varios pasos
  const CHARS_PER_TOKEN_ESTIMATE = 3;               // Relación conservadora caracteres/token para convertir presupuestos
  const EXCLUDED_STEPS_NOTE_MAX_CHARS = 4000;       // Tope de la nota sintética determinista que resume las llamadas excluidas del turno activo
  // La nota lleva argumentos JSON: se reserva lo que el estimador cuenta para una nota del tope con su separador.
  const EXCLUDED_STEPS_NOTE_RESERVE_TOKENS = Math.ceil((EXCLUDED_STEPS_NOTE_MAX_CHARS + 2) / CODE_CHARS_PER_TOKEN);
  const EXCLUDED_CALL_ARG_MAX_CHARS = 160;          // Tope por argumento canónico en la nota sintética de pasos excluidos

  const { serializeContent } = Utils;

  /**
   * Extrae `{ name, argsText }` de un `tool_call`: los argumentos tal como llegaron o, con `canonical`, en el texto
   * canónico que también usa el control de bucles (Utils.canonicalToolArguments).
   */
  function readToolCallSpec(tc, { canonical = false } = {}) {
    const name = tc?.function?.name || tc?.name || 'tool';
    const rawArgs = tc?.function?.arguments ?? tc?.arguments;
    if (canonical) return { name, argsText: Utils.canonicalToolArguments(rawArgs) };
    if (typeof rawArgs === 'string') return { name, argsText: rawArgs };
    let argsText = '';
    if (rawArgs && typeof rawArgs === 'object') {
      try { argsText = JSON.stringify(rawArgs); } catch (_) { argsText = ''; }
    }
    return { name, argsText };
  }

  /**
   * Reparte un presupuesto total de caracteres entre varios elementos: los que caben en la cuota
   * inicial se conservan íntegros y su sobrante se redistribuye equitativamente entre los demás.
   */
  function allocateProportionalLimits(lengths, totalBudget, { minShare = 150, maxPerItem = Infinity } = {}) {
    const initialShare = Math.floor(totalBudget / lengths.length);
    let remaining = totalBudget;
    const limits = new Array(lengths.length);
    const oversized = [];

    lengths.forEach((len, idx) => {
      if (len <= initialShare) {
        limits[idx] = len;
        remaining -= len;
      } else {
        oversized.push(idx);
      }
    });

    if (oversized.length > 0) {
      const share = Math.min(maxPerItem, Math.max(minShare, Math.floor(remaining / oversized.length)));
      for (const idx of oversized) limits[idx] = share;
    }

    return { limits, hasOversized: oversized.length > 0 };
  }

  /**
   * Construye una nota sintética determinista (sin llamar al modelo) que lista las llamadas a herramientas
   * de los pasos del turno en curso excluidos por la ventana deslizante, para que el modelo no repita lecturas ya hechas.
   */
  function buildExcludedStepsNote(excludedActiveBlocks) {
    const entries = [];
    for (const block of excludedActiveBlocks) {
      const assistant = block[0];
      if (!assistant || assistant.role !== 'assistant' || !Array.isArray(assistant.tool_calls)) continue;
      for (const tc of assistant.tool_calls) {
        const { name, argsText: rawArgs } = readToolCallSpec(tc, { canonical: true });
        const argsText = rawArgs.length > EXCLUDED_CALL_ARG_MAX_CHARS
          ? `${rawArgs.slice(0, EXCLUDED_CALL_ARG_MAX_CHARS)}…`
          : rawArgs;
        entries.push(argsText && argsText !== '{}' ? `- ${name}(${argsText})` : `- ${name}()`);
      }
    }
    if (entries.length === 0) return null;

    const header = `[Earlier tool calls in this turn omitted from context (${excludedActiveBlocks.length} steps, ${entries.length} calls) to stay within the context window — do not repeat them unless needed]:\n`;
    const full = header + entries.join('\n');
    if (full.length <= EXCLUDED_STEPS_NOTE_MAX_CHARS) return full;

    // Conservar las llamadas más recientes que quepan (las que el modelo más probablemente repetiría), con el aviso de
    // las más antiguas omitidas delante de ellas: la nota mide `used` más ese aviso.
    const omittedNotice = omitted => `[... ${omitted} earlier tool call(s) omitted from this summary due to size limit ...]`;
    let used = header.length;
    let first = entries.length;
    while (first > 1) {
      const next = used + 1 + entries[first - 1].length;
      if (next + omittedNotice(first - 1).length > EXCLUDED_STEPS_NOTE_MAX_CHARS) break;
      used = next;
      first--;
    }
    return `${header}${[omittedNotice(first), ...entries.slice(first)].join('\n')}`;
  }

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

    const cappedLengths = toolIndices.map(idx => Math.min(serialized.get(idx).length, maxPerToolChars));
    const totalAfterIndividual = cappedLengths.reduce((acc, len) => acc + len, 0);

    // Si el lote completo cabe en maxBatchChars (o solo hay una herramienta), basta el techo individual.
    if (toolIndices.length === 1 || !maxBatchChars || totalAfterIndividual <= maxBatchChars) {
      return block.map((m, idx) => (serialized.has(idx)
        ? { ...m, content: truncateToolContent(serialized.get(idx), maxPerToolChars, m.name) }
        : m));
    }

    const { limits } = allocateProportionalLimits(cappedLengths, maxBatchChars, { minShare: 200, maxPerItem: maxPerToolChars });
    const limitByIdx = new Map(toolIndices.map((idx, pos) => [idx, limits[pos]]));

    return block.map((m, idx) => (serialized.has(idx)
      ? { ...m, content: truncateToolContent(serialized.get(idx), limitByIdx.get(idx), m.name) }
      : m));
  }

  /**
   * Trunca de forma equilibrada una salida multisección (como múltiples fragmentos devueltos por read_knowledge_chunk).
   * En lugar de cortar el 70% central de todo el texto (lo que elimina por completo fragmentos enteros del medio),
   * distribuye el presupuesto proporcionalmente entre las secciones para que cada fragmento conserve su cabecera,
   * contexto y datos numéricos clave. Devuelve null si el reparto no cabe en `maxChars` (muchas secciones cortas:
   * la cuota mínima por sección y sus avisos superarían el tope).
   */
  function truncateMultiSectionToolContent(sections, maxChars, toolName) {
    const separator = '\n\n---\n\n';
    const availableBudget = maxChars - separator.length * (sections.length - 1);
    if (availableBudget <= 0) return null;

    const { limits, hasOversized } = allocateProportionalLimits(sections.map(s => s.length), availableBudget, { minShare: 150 });
    if (!hasOversized) return sections.join(separator);

    const result = sections.map((sec, idx) => (sec.length <= limits[idx]
      ? sec
      : truncateMiddle(sec, limits[idx], omitted => `[... Truncated fragment ${idx + 1}: ${omitted} characters omitted from ${toolName} ...]`)
    )).join(separator);
    return result.length <= maxChars ? result : null;
  }

  /**
   * Recorta un texto a `maxChars` conservando el 70 % inicial y el 20 % final, con el aviso que devuelve
   * `notice(caracteresOmitidos)` en medio.
   */
  function truncateMiddle(str, maxChars, notice) {
    const head = str.slice(0, Math.floor(maxChars * 0.7));
    const tail = str.slice(-Math.floor(maxChars * 0.2));
    return `${head}\n\n${notice(str.length - head.length - tail.length)}\n\n${tail}`;
  }

  /**
   * Trunca de forma segura el contenido de un resultado de herramienta; una salida en secciones `---` (fragmentos de
   * read_knowledge_chunk) reparte el tope entre ellas para no perder fragmentos enteros si el reparto cabe en el tope.
   */
  function truncateToolContent(content, maxChars = DEFAULT_MAX_ACTIVE_TOOL_CHARS, toolName = 'tool') {
    const str = serializeContent(content);
    if (str.length <= maxChars) {
      return str;
    }

    // Si el contenido contiene múltiples secciones separadas por '---' (típico de read_knowledge_chunk)
    if (str.includes('\n\n---\n\n')) {
      const sections = str.split('\n\n---\n\n');
      const balanced = sections.length > 1 ? truncateMultiSectionToolContent(sections, maxChars, toolName) : null;
      if (balanced !== null) return balanced;
    }

    return truncateMiddle(str, maxChars, omitted => `[... Truncated by ChatContextManager: ${omitted} characters omitted from the ${toolName} output ...]`);
  }

  /**
   * Compacta y poda los resultados de herramientas de turnos pasados completados.
   */
  function pruneHistoricalToolMessage(m) {
    if (!m || m.role !== 'tool') return m;
    const contentStr = serializeContent(m.content);

    if (contentStr.length <= DEFAULT_MAX_HISTORICAL_TOOL_CHARS) {
      return m;
    }

    const truncated = truncateToolContent(contentStr, DEFAULT_MAX_HISTORICAL_TOOL_CHARS, m.name || 'tool');
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
  // Marca del mensaje user que no abre turno (la nota de cambio de modelo de AgentRuntime): el turno en curso sigue
  // siendo el del último mensaje de la persona, que no se poda ni queda fuera de la ventana. No viaja al proveedor.
  const TURN_CONTINUATION_FLAG = '_turnContinuation';
  function stripInternalFlags(message) {
    if (!message[TOOL_EVIDENCE_FLAG] && !message[TURN_CONTINUATION_FLAG]) return message;
    const { [TOOL_EVIDENCE_FLAG]: _evidence, [TURN_CONTINUATION_FLAG]: _continuation, ...rest } = message;
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
   * Techo de los resultados de herramientas de un bloque del turno en curso: individual (DEFAULT_MAX_ACTIVE_TOOL_CHARS)
   * y agregado por lote, ambos acotados al presupuesto de entrada.
   */
  function createActiveBlockCap(inputBudget) {
    const batchChars = Math.max(
      DEFAULT_MAX_HISTORICAL_TOOL_CHARS,
      Math.floor(inputBudget * ACTIVE_BATCH_BUDGET_RATIO * CHARS_PER_TOKEN_ESTIMATE)
    );
    const perToolChars = Math.min(DEFAULT_MAX_ACTIVE_TOOL_CHARS, batchChars);
    return block => capToolBatchBlock(block, perToolChars, batchChars);
  }

  /** Añade `text` al final del contenido (texto o partes multimodales) de una copia de `message`. */
  function appendTextToMessage(message, text) {
    if (Array.isArray(message.content)) return { ...message, content: [...message.content, { type: 'text', text }] };
    return { ...message, content: message.content ? `${message.content}\n\n${text}` : text };
  }

  /**
   * Poda los pasos del turno en curso (`blocks` desde `lastUserBlockIdx + 1`) cuando no caben en el presupuesto:
   * reaplica el corte recordado, reserva ACTIVE_RECENT_BUDGET_RATIO para los pasos recientes completos y, si aun así
   * se supera, poda también los recientes hasta el objetivo de histéresis. Modifica `blocks` y devuelve el nuevo
   * corte de poda y si la ventana debe avanzar también el de exclusión porque la poda no bajó al objetivo.
   */
  function pruneActiveTurn(blocks, { lastUserBlockIdx, pruneEndIdx: previousPruneEndIdx, excludeEndIdx, fixedTokens, lastBlockTokens, inputBudget, model, pruneBlock }) {
    const tokensOf = block => estimateHistoryTokens(block, model);
    let pruneEndIdx = previousPruneEndIdx;
    for (let bIdx = lastUserBlockIdx + 1; bIdx <= pruneEndIdx; bIdx++) blocks[bIdx] = pruneBlock(blocks[bIdx]);

    const firstKeptIdx = Math.max(lastUserBlockIdx + 1, excludeEndIdx + 1);
    const userBlockTokens = tokensOf(blocks[lastUserBlockIdx]);
    const activeTurnTokens = () => fixedTokens + userBlockTokens
      + blocks.slice(firstKeptIdx).reduce((acc, block) => acc + tokensOf(block), 0);
    if (activeTurnTokens() <= inputBudget) return { pruneEndIdx, exclusionCutDue: false };

    // Pasos recientes completos hasta la reserva (contando el último bloque); los anteriores se podan.
    const recentCapTokens = Math.max(lastBlockTokens, Math.floor(inputBudget * ACTIVE_RECENT_BUDGET_RATIO));
    let recentUsed = lastBlockTokens;
    let newPruneEndIdx = lastUserBlockIdx;
    for (let bIdx = blocks.length - 1; bIdx > lastUserBlockIdx; bIdx--) {
      if (bIdx <= pruneEndIdx) {
        newPruneEndIdx = Math.max(newPruneEndIdx, bIdx);
        break;
      }
      const blockTokens = tokensOf(blocks[bIdx]);
      if (recentUsed + blockTokens > recentCapTokens) {
        newPruneEndIdx = bIdx;
        break;
      }
      recentUsed += blockTokens;
    }
    for (let bIdx = pruneEndIdx + 1; bIdx <= newPruneEndIdx; bIdx++) blocks[bIdx] = pruneBlock(blocks[bIdx]);
    pruneEndIdx = Math.max(pruneEndIdx, newPruneEndIdx);

    // Si sigue sin caber, se podan también los recientes (nunca el último bloque) hasta el objetivo de histéresis.
    const targetTokens = Math.floor(inputBudget * WINDOW_HYSTERESIS_TARGET_RATIO);
    let total = activeTurnTokens();
    if (total > inputBudget) {
      for (let bIdx = pruneEndIdx + 1; bIdx < blocks.length; bIdx++) {
        const before = tokensOf(blocks[bIdx]);
        blocks[bIdx] = pruneBlock(blocks[bIdx]);
        total -= before - tokensOf(blocks[bIdx]);
        pruneEndIdx = bIdx;
        if (total <= targetTokens) break;
      }
    }
    return { pruneEndIdx, exclusionCutDue: total > targetTokens };
  }

  /**
   * Ventana deslizante contigua de más reciente a más antiguo: se detiene en el primer bloque que no cabe (sin huecos),
   * respeta el corte de exclusión recordado y conserva siempre el `user` del turno en curso, al que adjunta la nota de
   * los pasos del turno que quedan fuera. Si hace falta un corte nuevo, abre margen hasta el objetivo de histéresis.
   */
  function slideWindow(blocks, { lastUserBlockIdx, excludeEndIdx, exclusionCutDue, fixedTokens, inputBudget, model }) {
    const tokensOf = block => estimateHistoryTokens(block, model);
    const hasActiveTurn = lastUserBlockIdx !== -1;
    const userBlock = hasActiveTurn ? blocks[lastUserBlockIdx] : null;
    const userTokens = userBlock ? tokensOf(userBlock) : 0;
    const hadExcludedActive = hasActiveTurn && excludeEndIdx > lastUserBlockIdx;

    const keptWithPreviousCut = blocks.reduce((acc, block, bIdx) => (
      bIdx === lastUserBlockIdx || bIdx <= excludeEndIdx ? acc : acc + tokensOf(block)
    ), 0);
    const needsNewCut = exclusionCutDue
      || fixedTokens + userTokens + (hadExcludedActive ? EXCLUDED_STEPS_NOTE_RESERVE_TOKENS : 0) + keptWithPreviousCut > inputBudget;
    const noteReserve = hadExcludedActive || (needsNewCut && hasActiveTurn) ? EXCLUDED_STEPS_NOTE_RESERVE_TOKENS : 0;
    const reservedTokens = fixedTokens + userTokens + noteReserve;
    const windowLimit = needsNewCut
      ? Math.max(reservedTokens, Math.floor(inputBudget * WINDOW_HYSTERESIS_TARGET_RATIO))
      : inputBudget;

    const included = [];
    let remaining = windowLimit - reservedTokens;
    let reachedUser = false;
    let cutIdx = -1;
    let newExcludeEndIdx = excludeEndIdx;
    for (let bIdx = blocks.length - 1; bIdx >= 0; bIdx--) {
      if (bIdx === lastUserBlockIdx) {
        included.unshift(userBlock);
        reachedUser = true;
        continue;
      }
      if (bIdx <= excludeEndIdx) {
        cutIdx = bIdx;
        break;
      }
      const blockTokens = tokensOf(blocks[bIdx]);
      if (blockTokens > remaining) {
        newExcludeEndIdx = Math.max(newExcludeEndIdx, bIdx);
        cutIdx = bIdx;
        break;
      }
      included.unshift(blocks[bIdx]);
      remaining -= blockTokens;
    }

    // Queda fuera todo lo anterior al corte salvo el `user` del turno en curso.
    const excluded = blocks.slice(0, cutIdx + 1).filter((_, bIdx) => bIdx !== lastUserBlockIdx);
    if (userBlock && !reachedUser) {
      const excludedActive = blocks.slice(lastUserBlockIdx + 1, cutIdx + 1);
      const note = excludedActive.length > 0 ? buildExcludedStepsNote(excludedActive) : null;
      included.unshift(note ? [appendTextToMessage(userBlock[0], note), ...userBlock.slice(1)] : userBlock);
    }
    return {
      included,
      excludedCount: excluded.reduce((acc, block) => acc + block.length, 0),
      excludeEndIdx: newExcludeEndIdx
    };
  }

  /**
   * Construye el contexto optimizado aplicando presupuesto, poda y ventana deslizante.
   * `options.activeTurnCut` (`{ cut: null }`, uno por ejecución del bucle) guarda entre pasos el corte de poda y
   * exclusión del turno en curso para que el prefijo enviado no cambie en cada paso; sin él no hay histéresis.
   */
  function buildOptimizedContext(rawMessages = [], options = {}) {
    const model = options.model || '';
    const inputBudget = calculateInputBudget(options);

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

    // 3. El último bloque atómico (último user o paso en curso) se envía siempre, con el techo activo.
    const atomicBlocks = groupIntoAtomicBlocks(conversationMessages);
    const lastBlock = atomicBlocks.pop();
    const capActiveBlock = createActiveBlockCap(inputBudget);
    const processedLastBlock = capActiveBlock(lastBlock);

    const systemTokens = estimateHistoryTokens(systemMessages, model);
    const extraInputTokens = Number.isFinite(options.extraInputTokens) && options.extraInputTokens > 0
      ? Math.round(options.extraInputTokens)
      : 0;
    const lastBlockTokens = estimateHistoryTokens(processedLastBlock, model);
    // Lo que se envía siempre: sistema, definiciones de herramientas, calibración y último bloque.
    const fixedTokens = systemTokens + estimateToolDefinitionsTokens(options.toolDefinitions) + extraInputTokens + lastBlockTokens;

    // 4. Los turnos cerrados (antes del último user) se podan; los pasos del turno en curso llevan el techo activo y
    // solo se podan si el turno no cabe. Sin un user en curso (el último bloque es el user) no hay turno activo.
    const opensTurn = block => block[0]?.role === 'user' && !block[0][TURN_CONTINUATION_FLAG];
    const lastTurnStartsAtLastBlock = opensTurn(lastBlock);
    const lastUserBlockIdx = lastTurnStartsAtLastBlock ? -1 : atomicBlocks.findLastIndex(opensTurn);
    const hasActiveTurn = lastUserBlockIdx !== -1;

    let prunedToolsCount = 0;
    const pruneBlock = block => block
      // Al podar un bloque se retira también su evidencia visual: el resultado textual ya describe la imagen.
      .filter(m => !m?.[TOOL_EVIDENCE_FLAG])
      .map(m => {
        if (m.role !== 'tool') return m;
        const pruned = pruneHistoricalToolMessage(m);
        if (pruned._prunedByContextManager) prunedToolsCount++;
        return pruned;
      });
    const blocks = atomicBlocks.map((block, bIdx) => (
      lastTurnStartsAtLastBlock || bIdx < lastUserBlockIdx ? pruneBlock(block) : capActiveBlock(block)
    ));

    // Histéresis: el corte de poda y exclusión de la ejecución avanza de una vez y se mantiene mientras los pasos
    // nuevos quepan, preservando el prefijo de la caché KV. Solo vale para el mismo presupuesto y turno.
    const activeTurnCut = options.activeTurnCut || null;
    let previousCut = hasActiveTurn ? activeTurnCut?.cut || null : null;
    if (previousCut && (previousCut.budget !== inputBudget || previousCut.userBlockIdx !== lastUserBlockIdx)) previousCut = null;
    const lastIdx = blocks.length - 1;
    const excludeEndIdx = previousCut ? Math.min(previousCut.excludeEndIdx, lastIdx) : -1;
    let pruneEndIdx = previousCut ? Math.min(previousCut.pruneEndIdx, lastIdx) : lastUserBlockIdx;
    let exclusionCutDue = false;
    if (hasActiveTurn) {
      ({ pruneEndIdx, exclusionCutDue } = pruneActiveTurn(blocks, {
        lastUserBlockIdx, pruneEndIdx, excludeEndIdx, fixedTokens, lastBlockTokens, inputBudget, model, pruneBlock
      }));
    }

    // 5. Ventana deslizante contigua
    const window = slideWindow(blocks, { lastUserBlockIdx, excludeEndIdx, exclusionCutDue, fixedTokens, inputBudget, model });

    if (activeTurnCut) {
      activeTurnCut.cut = hasActiveTurn && (pruneEndIdx > lastUserBlockIdx || window.excludeEndIdx >= 0)
        ? { budget: inputBudget, userBlockIdx: lastUserBlockIdx, pruneEndIdx, excludeEndIdx: window.excludeEndIdx }
        : null;
    }

    // 6. Ensamblado final de la lista de mensajes, sin la marca interna de la evidencia visual
    const finalMessages = [
      ...systemMessages,
      ...window.included.flat(),
      ...processedLastBlock
    ].map(stripInternalFlags);

    return {
      messages: finalMessages,
      diagnostics: {
        budget: inputBudget,
        totalTokens: estimateHistoryTokens(finalMessages, model),
        systemTokens,
        includedCount: finalMessages.length,
        excludedCount: window.excludedCount,
        prunedToolsCount,
        strategy: window.excludedCount > 0 ? 'sliding_window_truncated' : 'full_history'
      }
    };
  }

  // ==========================================================================
  // 5. Sistema de Compresión y Resumen Inteligente de Memoria (Memory Compression)
  // ==========================================================================

  const SUMMARIZER_SYSTEM_PROMPT = `You consolidate a conversation checkpoint. Create one concise, cumulative summary of the checkpoint supplied, if any, and every subsequent message supplied. Preserve user goals, decisions, verified facts, tool calls and their results, open questions, and details needed to continue. Do not mention this instruction or omit relevant information merely because of its source.`;
  // Se compacta cuando lo que se enviaría alcanza esta fracción del presupuesto de entrada,
  const COMPRESSION_THRESHOLD_RATIO = 0.70;
  // con al menos estos mensajes de turnos cerrados desde el último checkpoint
  const MIN_MESSAGES_TO_COMPRESS = 2;
  // y si esos turnos cerrados ocupan al menos esta fracción del presupuesto.
  const MIN_COMPRESSIBLE_BUDGET_RATIO = 0.20;

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
   * Evalúa si una conversación amerita compresión según presupuesto y volumen real de turnos cerrados.
   */
  function shouldCompress(messages = [], options = {}) {
    if (!Array.isArray(messages) || messages.length < 8) {
      return false;
    }

    const lastCheckpointIndex = messages.reduce((lastIndex, message, index) => (
      message && message._isSummaryBlock ? index : lastIndex
    ), -1);
    const keepActiveTurn = options.keepActiveTurn !== false;
    const activeTurnStart = keepActiveTurn ? findActiveTurnStartIndex(messages) : -1;
    const compressibleEnd = activeTurnStart !== -1 ? activeTurnStart : messages.length;
    const messagesSinceCheckpoint = messages.slice(lastCheckpointIndex + 1, compressibleEnd)
      .filter(message => message && message.role && message.role !== 'system');

    if (messagesSinceCheckpoint.length < MIN_MESSAGES_TO_COMPRESS) {
      return false;
    }

    const model = options.model || '';
    const inputBudget = calculateInputBudget(options);
    const extraInputTokens = Number.isFinite(options.extraInputTokens) && options.extraInputTokens > 0
      ? Math.round(options.extraInputTokens)
      : 0;
    // Se mide lo que buildOptimizedContext enviaría, no el historial crudo: los resultados de turnos cerrados van podados
    // y sin sus imágenes, y los del turno en curso con su techo individual y por lote.
    const asSentClosed = m => {
      if (!m || m.role !== 'tool') return m;
      const { images: _images, ...pruned } = pruneHistoricalToolMessage(m);
      return pruned;
    };
    const closedSent = messages.slice(0, compressibleEnd).map(asSentClosed);
    const capActiveBlock = createActiveBlockCap(inputBudget);
    const activeSent = groupIntoAtomicBlocks(messages.slice(compressibleEnd)).flatMap(capActiveBlock);
    const totalTokens = estimateHistoryTokens(closedSent, model)
      + estimateHistoryTokens(activeSent, model)
      + estimateToolDefinitionsTokens(options.toolDefinitions)
      + extraInputTokens;
    if (totalTokens < (inputBudget * COMPRESSION_THRESHOLD_RATIO)) {
      return false;
    }

    // Evitar gastar una llamada al resumidor e invalidar la caché cuando los turnos cerrados apenas ocupan contexto.
    const compressibleTokens = estimateHistoryTokens(messagesSinceCheckpoint.map(asSentClosed), model);
    if (compressibleTokens < (inputBudget * MIN_COMPRESSIBLE_BUDGET_RATIO)) {
      return false;
    }

    return true;
  }

  /**
   * Construye una transcripción neutral en texto plano del historial para el resumidor.
   * Evita enviar turnos conversacionales nativos (role: 'assistant'/'tool') que inducen
   * inercia de rol agéntico o emisión de nuevas llamadas a herramientas.
   * Acota siempre la transcripción al presupuesto de entrada del modelo resumidor (`calculateInputBudget`).
   */
  function formatHistoryTranscript(messages = [], options = {}) {
    if (!Array.isArray(messages) || messages.length === 0) return '';
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
            const { name, argsText } = readToolCallSpec(tc);
            // Los argumentos (p. ej. el contenido de write_file) tienen el mismo tope que los resultados.
            return argsText ? `${name}(${truncateToolContent(argsText, DEFAULT_MAX_HISTORICAL_TOOL_CHARS, name)})` : name;
          });
          parts.push(`[Called tools: ${callDescs.join(', ')}]`);
        }
        if (parts.length > 0) lines.push(`Assistant: ${parts.join('\n')}`);
      } else if (m.role === 'tool') {
        const name = m.name || 'tool';
        const rawContent = typeof m.content === 'string' ? m.content : (m.content ? JSON.stringify(m.content) : '');
        const contentStr = rawContent.length > DEFAULT_MAX_HISTORICAL_TOOL_CHARS
          ? truncateToolContent(rawContent, DEFAULT_MAX_HISTORICAL_TOOL_CHARS, name)
          : rawContent;
        lines.push(`Tool (${name}): ${contentStr}`);
      }
    });

    const transcript = lines.join('\n\n');
    const maxTranscriptChars = Math.max(2000, Math.floor(calculateInputBudget(options) * 0.8 * 2.5));
    // Corte simple, sin el reparto por secciones de truncateToolContent: un `---` dentro de un resultado no divide la transcripción.
    if (transcript.length <= maxTranscriptChars) return transcript;
    return truncateMiddle(transcript, maxTranscriptChars, omitted => `[... Transcript truncated: ${omitted} characters omitted to fit the summarizer budget ...]`);
  }

  /**
   * Comprime y consolida de forma segura los turnos antiguos de una conversación.
   * Por defecto (`keepActiveTurn: true`) resume solo los turnos cerrados anteriores al último mensaje `user`
   * y conserva intactos ese mensaje `user` y los pasos del turno en curso.
   */
  /**
   * Lo que compressHistory resumiría: el diálogo entre el último checkpoint y el turno en curso (si se conserva).
   */
  function compressibleDialogue(messages, keepActiveTurn = true) {
    const lastCheckpointIndex = messages.findLastIndex(m => m && m._isSummaryBlock);
    const activeTurnStart = keepActiveTurn ? findActiveTurnStartIndex(messages) : -1;
    const compressibleEnd = activeTurnStart !== -1 ? activeTurnStart : messages.length;
    const dialogue = messages.slice(lastCheckpointIndex + 1, compressibleEnd).filter(m => m && m.role && m.role !== 'system');
    return { activeTurnStart, compressibleEnd, dialogue };
  }

  /** Hay diálogo tras el último checkpoint que resumir a petición del usuario (fuera de un turno en marcha). */
  function hasCompactableHistory(messages) {
    return Array.isArray(messages) && compressibleDialogue(messages, false).dialogue.length > 0;
  }

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

    messages.forEach(m => {
      if (m && m._isSummaryBlock) {
        checkpoint = m;
      } else if (m && m.role === 'system') {
        systemMessages.push(m);
      }
    });

    const { activeTurnStart, compressibleEnd, dialogue } = compressibleDialogue(messages, options.keepActiveTurn !== false);
    const activeTurnMessages = activeTurnStart !== -1
      ? messages.slice(activeTurnStart).filter(m => m && m.role && m.role !== 'system')
      : [];

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
    estimateToolDefinitionsTokens,
    estimateHistoryTokens,
    truncateToolContent,
    buildOptimizedContext,
    TOOL_EVIDENCE_FLAG,
    TURN_CONTINUATION_FLAG,
    getContextDiagnostics,
    shouldCompress,
    hasCompactableHistory,
    compressHistory,
    formatHistoryTranscript
  };
}));
