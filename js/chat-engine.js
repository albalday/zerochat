/**
 * Motor Agéntico de Mensajería y Streaming (ChatEngine) para ZeroChat.
 * Responsable de:
 * - Construcción y anclaje de mensajes efectivos (System Prompt, Context-Caching, RAG context).
 * - Orquestación del bucle agéntico multi-turno (turnos asistentes y llamadas a herramientas).
 * - Streaming de tokens, reasoning/thinking chunks y cálculo de métricas en tiempo real.
 * - Presentación de la parada por bucle que detecta AgentRuntime.
 */

(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./message-turns.js'), require('./utils.js'), require('./i18n.js'));
  } else {
    root.ChatEngine = factory(root.ChatMessageTurns, root.ChatUtils, root.ChatI18n);
  }
})(typeof self !== 'undefined' ? self : this, function (MessageTurns, Utils, I18n) {
  'use strict';

  function getAPI() {
    return resolveDep('ChatAPI', './api.js');
  }

  function getProjectContext() {
    return resolveDep('ChatProjectContext', './project-context.js');
  }

  function getAgentCore() {
    return resolveDep('ChatAgentCore', './agent-core.js');
  }

  function getMarkdown() {
    return resolveDep('ChatMarkdown', './markdown.js');
  }

  function getContextManager() {
    return resolveDep('ChatContextManager', './context-manager.js');
  }


  const { serializeContent, resolveDep } = Utils;

  /** Genera una referencia de fecha inicial, sin hora y coherente con la zona local (siempre en inglés para el modelo). */
  function getConversationDateAnchor(startedAt = Date.now()) {
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
  function ensureConversationDate(chatHistory, startedAt = Date.now()) {
    const root = chatHistory.find(m => m.role === 'system' && !m._isSummaryBlock) || chatHistory[0];
    if (!root) return getConversationDateAnchor(startedAt);
    if (!root.contextDateAnchor) root.contextDateAnchor = getConversationDateAnchor(startedAt);
    return root.contextDateAnchor;
  }


  function getConfiguredSystemPrompt(appConfig = {}) {
    return [appConfig.systemPrompt, appConfig.systemDataPrompt]
      .map(value => String(value || '').trim())
      .filter(Boolean)
      .join('\n\n');
  }

  function getUIConversation() {
    return resolveDep('ChatUIConversation', './ui-conversation.js');
  }

  /**
   * Construye el array de mensajes normalizado y enriquecido para la API de inferencia.
   * @param {Array} chatHistory - Historial de mensajes de la conversación.
   * @param {Object} appConfig - Configuración activa de la aplicación.
   * @param {Object} [options={}] - Opciones de contexto (ej: currentRagSystemContext).
   * @returns {Array} - Array de mensajes listo para streamChatCompletion.
   */
  function buildEffectiveMessages(chatHistory = [], appConfig = {}, options = {}) {
    const rawMessages = (chatHistory || []).filter(m => m && m.role);
    const messages = [];
    // El razonamiento solo se reenvía en el turno en curso, desde el último mensaje del usuario.
    const currentTurnStart = rawMessages.map(m => m.role).lastIndexOf('user');

    rawMessages.forEach((m, index) => {
      if (m.role === 'user') {
        // Aviso de comandos en segundo plano terminados, guardado con el mensaje y no visible en el chat.
        const userText = m.commandNotes ? `${m.commandNotes}\n\n${m.content || ''}` : m.content;
        if (m.images && Array.isArray(m.images) && m.images.length > 0) {
          const contentParts = [];
          if (userText) {
            contentParts.push({ type: 'text', text: userText });
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
          messages.push({ role: 'user', content: userText || '' });
        }
      } else if (m.role === 'assistant') {
        const item = { role: 'assistant', content: m.content !== undefined ? m.content : '' };
        if (m.tool_calls && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
          item.tool_calls = m.tool_calls;
        }
        const replay = m.reasoningReplay;
        if (index > currentTurnStart && replay && typeof replay.field === 'string' && typeof replay.text === 'string') {
          item[replay.field] = replay.text;
          if (typeof replay.signature === 'string') item.reasoning_signature = replay.signature;
        }
        messages.push(item);
      } else if (m.role === 'tool') {
        const toolCallId = m.tool_call_id || `call_${Date.now()}`;
        const toolName = m.name || 'tool';
        const toolContent = serializeContent(m.content);

        if (!MessageTurns.hasMatchingToolCall(messages, { tool_call_id: toolCallId, name: toolName })) {
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

        // La imagen recuperada por RAG o por browser_action se entrega como evidencia visual en el
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
        } else if ((toolName === 'browser_action' || toolName.endsWith('browser_action')) && image) {
          messages.push({
            role: 'user',
            content: [
              { type: 'text', text: `Screenshot captured by ${toolName}${image.url ? ` (${image.url})` : ''}:` },
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

    const AgentCore = getAgentCore();
    const isToolsEnabled = options.enableTools ?? AgentCore.registry.getActiveTools(appConfig).length > 0;

    // Las herramientas en texto (<tool_call>) reciben sus firmas en el payload del adaptador.
    const caps = getAPI().getProviderCapabilities(appConfig.apiUrl, appConfig.apiType, appConfig.model);
    const providerReceivesToolSignatures = caps.tools !== false || caps.textTools === true;

    // 2. Instrucción de flujo para herramientas (estable)
    let toolsGuide = '';
    if (isToolsEnabled) {
      toolsGuide = providerReceivesToolSignatures
        ? AgentCore.TOOL_WORKFLOW_INSTRUCTION
        : AgentCore.registry.getActivePromptGuide(appConfig);
    }

    // 3. Directiva proactiva de Base de Conocimiento activa (estable por rama)
    if (appConfig.activeRagBranchIds.length > 0) {
      const ragInstruction = `*Knowledge Base active:* Follow the document-consultation protocol above. Use 'list_documents' only when you explicitly need a complete inventory.`;
      toolsGuide = toolsGuide ? `${toolsGuide}\n\n${ragInstruction}` : ragInstruction;
    }

    // Normas y estado del proyecto: estables mientras no cambien sus ficheros.
    const projectBlock = options.projectContext ? getProjectContext().buildPromptBlock(options.projectContext) : '';
    const directoryLine = isToolsEnabled && options.projectDirectory
      ? `*Project directory:* ${options.projectDirectory}. Relative paths in local tools resolve against it.`
      : '';

    // Ensamblar bloque estable
    let fullSystemPrompt = [baseSystemPrompt, toolsGuide, directoryLine, projectBlock].filter(Boolean).join('\n\n');

    // 4. Inyección de contexto dinámico al final para preservar el prefijo en caché:
    // a) Contexto RAG recuperado para esta consulta
    const ragContext = options.currentRagSystemContext || '';
    if (ragContext) {
      fullSystemPrompt = fullSystemPrompt ? `${fullSystemPrompt}\n\n${ragContext}` : ragContext;
    }

    // b) Fecha inicial persistida de la conversación (siempre activa)
    const dateAnchor = ensureConversationDate(chatHistory);
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
    const optimization = getContextManager().buildOptimizedContext(messages, {
      model: appConfig.model,
      totalContextLimit: appConfig.modelContextLimit || appConfig.contextLimitOverride,
      ...options
    });
    return optimization.messages;
  }

  /**
   * Ejecuta el bucle agéntico multi-turno de inferencia, streaming y herramientas.
   * @param {Object} params - Parámetros de ejecución.
   * @returns {Promise<{ success: boolean, finalAssistantText: string, accumulatedMarkdown: string, stats: Object, cancelled?: boolean, error?: any }>}
   */
  async function executeAgentTurnLoop(params) {
    const {
      chatHistory,
      appConfig,
      assistantMsgId,
      currentRagSystemContext = '',
      projectContext = null,
      projectDirectory = '',
      container,
      onReasoningChunk,
      onLog,
      onStats,
      onBeforeRequest,
      onGenerationStatus,
      scrollToBottom
    } = params;
    const AgentCore = getAgentCore();
    const UIConversation = getUIConversation();
    const turnBlocks = new Map();
    const turnMarkdown = new Map();

    const getTurnMarkdown = turnIndex => {
      if (!turnMarkdown.has(turnIndex)) {
        turnMarkdown.set(turnIndex, { text: '', toolBlocks: [] });
      }
      return turnMarkdown.get(turnIndex);
    };

    const llm = {
      apiUrl: appConfig.apiUrl,
      apiType: appConfig.apiType,
      apiKey: params.apiKey,
      model: appConfig.model
    };
    const summarizerAddendum = getProjectContext().SUMMARIZER_PROJECT_ADDENDUM;
    const renderBlock = (block, text, options) => UIConversation.renderAssistantBlock(block, text, options);

    const result = await AgentCore.runtime.execute({
      ...llm,
      temperature: appConfig.temperature,
      reasoningEffort: appConfig.reasoningEffort,
      messages: chatHistory,
      signal: params.signal,
      appendFinalMessage: true,
      contextOptions: {
        totalContextLimit: appConfig.modelContextLimit || appConfig.contextLimitOverride,
        // En modo proyecto el resumen marca lo pendiente de registrar; nunca escribe en el proyecto.
        ...(projectContext?.status === 'ready' ? { summarizerAddendum } : {})
      },
      summarizeHistory: createHistorySummarizer({ ...llm, signal: params.signal, onBeforeRequest }),
      onBeforeRequest,
      onGenerationStatus,
      createMessageId: (kind, info) => {
        if (kind === 'final') return `${assistantMsgId}_final`;
        if (kind === 'assistant') return `${assistantMsgId}_turn_${info.stepIndex}_assistant`;
        return `${assistantMsgId}_turn_${info.stepIndex}_tool_${info.toolCall?.id || info.toolIndex}_${Date.now()}`;
      },
      prepareMessages: messages => ({
        messages: buildEffectiveMessages(messages, appConfig, {
          currentRagSystemContext,
          projectContext,
          projectDirectory
        })
      }),
      resolveToolDefinitions: () => AgentCore.registry.getActiveDefinitions(appConfig),
      dispatchToolCall: async (toolCall, context) => AgentCore.dispatchToolCall(toolCall, {
        container,
        onLog,
        attachListeners: getMarkdown().attachContentListeners,
        scrollToBottom,
        language: appConfig.language,
        activeRagBranchIds: appConfig.activeRagBranchIds,
        ...context
      }),
      callbacks: {
        onGenerationStatus,
        onStepStart: turnIndex => {
          if (turnIndex === 0) container.innerHTML = '';
          turnBlocks.set(turnIndex, UIConversation.createAssistantBlock(container));
          scrollToBottom();
        },
        onCompactionStart: turnIndex => {
          // The notice occupies the block already opened for this step, so it
          // stays above the response, which continues in a fresh block.
          renderBlock(turnBlocks.get(turnIndex), I18n.t('chat_context_compacting'));
          turnBlocks.set(turnIndex, UIConversation.createAssistantBlock(container));
          scrollToBottom();
        },
        onChunk: (text, delta, stats, turnIndex) => {
          renderBlock(turnBlocks.get(turnIndex), text, { streaming: true });
          if (stats) onStats(stats);
          scrollToBottom();
        },
        onReasoningChunk: chunk => onReasoningChunk(chunk),
        onLog: logData => {
          if (logData.type !== 'thinking') onLog(logData.type, logData.text);
        },
        onToolStart: toolCall => {
          onGenerationStatus({ phase: 'tool', text: I18n.t('generation_status_tool', { name: toolCall.function.name }) });
        },
        onToolComplete: (toolCall, execution, _content, turnIndex) => {
          if (execution?.markdownBlock) getTurnMarkdown(turnIndex).toolBlocks.push(execution.markdownBlock);
        },
        onStepDone: (turnIndex, step) => {
          const block = turnBlocks.get(turnIndex);
          if (step.type === 'tool_execution') {
            getTurnMarkdown(turnIndex).text = step.assistantMsg?.content || '';
          } else if (step.type === 'loop_detected') {
            getTurnMarkdown(turnIndex).text = step.text || step.assistantMsg?.content || '';
          }
          const text = (step.type === 'final_response' || step.type === 'loop_detected') ? step.text : step.assistantMsg?.content;
          if (text) {
            renderBlock(block, text);
          } else {
            block.remove();
            turnBlocks.delete(turnIndex);
          }
          scrollToBottom();
        },
        onLoopDetected: () => {
          onGenerationStatus({ phase: 'error', text: I18n.t('generation_status_loop_detected') });
          onLog('error', '[Loop protection]: tools were called repeatedly with the same arguments. Stopping the agent loop.');
        },
        onDone: finalText => {
          const block = turnBlocks.get(Math.max(...turnBlocks.keys(), 0));
          if (block && finalText) renderBlock(block, finalText);
          scrollToBottom();
        }
      }
    });

    if (Array.isArray(result.history)) {
      chatHistory.length = 0;
      chatHistory.push(...result.history);
    }
    if (result.status === 'cancelled') return { success: false, cancelled: true };
    if (result.error) return { success: false, error: result.error };
    const turnTexts = [...turnMarkdown.entries()]
      .sort(([left], [right]) => left - right)
      .flatMap(([, turn]) => [turn.text, ...turn.toolBlocks])
      .filter(Boolean);
    const hasFinalInTurn = result.finalText && turnTexts.some(txt => txt && txt.includes(result.finalText));
    const accumulatedMarkdown = turnTexts
      .concat(hasFinalInTurn ? [] : (result.finalText ? [result.finalText] : []))
      .filter(Boolean)
      .join('\n\n');
    return {
      success: result.success,
      loopDetected: result.loopDetected,
      finalAssistantText: result.finalText || '',
      accumulatedMarkdown,
      stats: result.stats,
      chatHistory: result.history
    };
  }

  /**
   * Resumidor para ContextManager.compressHistory: pide al proveedor el checkpoint que sustituye
   * al historial, sin herramientas ni razonamiento. Lo usan la compactación y las ramas resumidas.
   */
  function createHistorySummarizer({ apiUrl, apiType, apiKey = '', model, signal, onBeforeRequest } = {}) {
    return async ({ systemPrompt, messages }) => {
      const response = await getAPI().streamChatCompletion({
        apiUrl,
        apiType,
        apiKey,
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages,
          { role: 'user', content: 'Generate the replacement checkpoint now.' }
        ],
        temperature: 0,
        reasoningEffort: 'none',
        toolChoice: 'none',
        signal,
        onBeforeRequest
      });
      return response?.accumulatedText || '';
    };
  }

  return {
    getConversationDateAnchor,
    createHistorySummarizer,
    ensureConversationDate,
    getConfiguredSystemPrompt,
    buildEffectiveMessages,
    executeAgentTurnLoop
  };
});
