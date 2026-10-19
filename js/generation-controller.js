/**
 * Controlador del Ciclo de Vida de Generación e Inferencia (ZeroChat).
 * Orquesta el envío de mensajes, streaming SSE, llamadas a herramientas,
 * control de aborto, captura inmutable de configuración y finalización atómica.
 *
 * handleSendMessage recibe de app.js los elementos del DOM y los callbacks que dependen de su
 * cableado: appendUserMessage, createAssistantMessagePlaceholder, updateConnectionTokensBadge,
 * openDebugInterceptorModal y saveCurrentSession; el modo ejecución añade onProgress. Devuelve
 * { text } con la respuesta final o { error } si no la hubo.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./utils.js'), require('./i18n.js'), require('./icons.js'));
  } else {
    root.ChatGenerationController = factory(root.ChatUtils, root.ChatI18n, root.ChatIcons);
  }
}(typeof self !== 'undefined' ? self : this, function (Utils, I18n, Icons) {
  'use strict';

  const { resolveDep, escapeHtml } = Utils;
  const { t } = I18n;

  const getState = () => resolveDep('ChatState', './state.js');
  const getConfig = () => resolveDep('ChatConfig', './config-store.js');
  const getEngine = () => resolveDep('ChatEngine', './chat-engine.js');
  const getAttachments = () => resolveDep('ChatAttachments', './attachments.js');
  const getUIConversation = () => resolveDep('ChatUIConversation', './ui-conversation.js');
  const getUIComposer = () => resolveDep('ChatUIComposer', './ui-composer.js');
  const getGenerationStatus = () => resolveDep('ChatUIGenerationStatus', './ui-generation-status.js');
  const getDebug = () => resolveDep('ChatDebug', './debug.js');

  let currentAbortController = null;

  function isGenerating() {
    return getState().isConversationBusy() || currentAbortController !== null;
  }

  function handleStopGeneration() {
    currentAbortController?.abort();
  }

  /**
   * Ejecuta una inferencia auxiliar (p. ej. el resumen de una rama) como generación en curso:
   * bloquea envíos y cambios de sesión, habilita el botón de parar y entrega a la tarea su señal.
   */
  async function runCancellableTask(task) {
    if (isGenerating()) throw new Error('A generation is already running.');
    const State = getState();
    const controller = new AbortController();
    currentAbortController = controller;
    State.set('streaming', { isGenerating: true });
    try {
      return await task(controller.signal);
    } finally {
      if (currentAbortController === controller) currentAbortController = null;
      State.set('streaming', { isGenerating: false });
    }
  }

  function finishGeneration(elements, { skipSave, saveCurrentSession }) {
    getUIConversation().removeTypingIndicator();
    getGenerationStatus().clearStatus(elements.generationStatus);
    getState().set('streaming', { isGenerating: false });
    currentAbortController = null;

    // En táctiles, enfocar el composer despliega el teclado virtual sin que el usuario lo pida.
    if (!window.matchMedia('(pointer: coarse)').matches) elements.userInput.focus();
    if (!skipSave) saveCurrentSession();
    getUIConversation().scrollToBottom(elements.messagesList);
  }

  function updateStatsDisplay(statsContainer, stats) {
    statsContainer.hidden = false;
    const clockSvg = Icons.get('clock', { size: 11 });
    const cacheHtml = stats.cachedTokens > 0
      ? `<span class="stat-sep stat-sep-4">•</span><span class="stat-item stat-item-cache" title="${t('stat_cache_title')}">${Icons.get('database', { size: 11 })} <span>${t('stat_cache_tokens', { tokens: stats.cachedTokens })}</span></span>`
      : '';
    statsContainer.innerHTML = `
      <span class="stat-item stat-item-ttft" title="${t('stat_ttft_title')}">${clockSvg} <span>${t('stat_ttft', { sec: stats.ttftSec })}</span></span>
      <span class="stat-sep stat-sep-1">•</span>
      <span class="stat-item stat-item-speed" title="${t('stat_speed_title')}">${Icons.get('zap', { size: 11 })} <span>${t('stat_speed', { speed: stats.tokensPerSec })}</span></span>
      <span class="stat-sep stat-sep-2">•</span>
      <span class="stat-item stat-item-total" title="${t('stat_total_time_title')}">${clockSvg} <span>${t('stat_total_time', { sec: stats.totalSec })}</span></span>
      <span class="stat-sep stat-sep-3">•</span>
      <span class="stat-item stat-item-tokens" title="${t('stat_tokens_title')}">${Icons.get('file-text', { size: 11 })} <span>${t('stat_tokens', { tokens: stats.tokens })}</span></span>${cacheHtml}
    `;
  }

  /** Contexto RAG inicial de las ramas activas; vacío si no hay ramas o si no se pudo recuperar. */
  async function loadRagSystemContext(elements, config) {
    if (config.activeRagBranchIds.length === 0) return '';
    getGenerationStatus().setStatus(elements.generationStatus, { phase: 'rag', text: t('generation_status_rag') });
    try {
      return await resolveDep('ChatRagService', './rag-service.js').buildRagSystemContext(config.activeRagBranchIds, { lang: config.language });
    } catch (err) {
      console.warn('[GenerationController] Could not load the initial RAG context:', err);
      getDebug().addLog('warning', `[RAG] Could not load the initial context: ${err?.message || String(err)}`);
      return '';
    }
  }

  async function handleSendMessage(options) {
    const { elements } = options;
    const State = getState();
    const Attachments = getAttachments();
    const UIConversation = getUIConversation();
    const Debug = getDebug();
    const status = getGenerationStatus();

    const rawText = elements.userInput.value.trim();
    const currentFiles = Attachments.getFiles();
    if ((!rawText && currentFiles.length === 0) || State.isConversationBusy()) {
      return { error: 'There is nothing to send or a generation is already running.' };
    }

    const config = getConfig().getActive();
    const { fullPrompt, displayText, imageAttachments } = Attachments.buildAttachmentsPayload(rawText, currentFiles);
    const userMsgId = options.appendUserMessage(displayText, rawText, imageAttachments);
    State.appendMessage({ id: userMsgId, role: 'user', content: fullPrompt, ...(imageAttachments.length > 0 ? { images: imageAttachments } : {}) });

    const getSessionId = () => State.get('sessions').activeId;
    const generationSessionId = getSessionId();
    const isCurrentSession = () => getSessionId() === generationSessionId;

    elements.userInput.value = '';
    getUIComposer().clearAttachedFiles(elements);
    getUIComposer().autoResizeTextarea(elements);
    resolveDep('ChatUIReasoning', './ui-reasoning.js').closeReasoningMenu(elements);

    State.set('streaming', { isGenerating: true });
    status.setStatus(elements.generationStatus, { phase: 'generating' });
    currentAbortController = new AbortController();

    UIConversation.showTypingIndicator(elements.messagesList);
    const parts = options.createAssistantMessagePlaceholder();
    const { wrapper, content, actions, btnCopy, statsContainer, msgId: assistantMsgId } = parts;
    UIConversation.removeTypingIndicator();
    const scrollToBottom = () => UIConversation.scrollToBottom(elements.messagesList);

    if (!config.model.trim()) {
      UIConversation.renderErrorCard(parts, {
        title: t('err_no_model_title'),
        hintHtml: t('err_no_model_desc', { url: escapeHtml(config.apiUrl) })
      });
      finishGeneration(elements, { skipSave: false, saveCurrentSession: options.saveCurrentSession });
      return { error: 'No model is configured.' };
    }

    const currentRagSystemContext = await loadRagSystemContext(elements, config);

    // Los comandos en segundo plano que han terminado sin que el modelo lo viera se le comunican
    // con este mensaje; la nota queda guardada en él para que el historial no cambie en otros turnos.
    const commandNotes = await resolveDep('ChatMCP', './mcp.js').manager.buildCommandNotes(State.get('messages'));
    if (commandNotes) {
      State.replaceMessages(State.get('messages').map(message => (message.id === userMsgId ? { ...message, commandNotes } : message)));
    }

    // Instantánea del proyecto para todo el turno, como el resto de la configuración capturada.
    const projectContext = config.projectMode === true ? State.get('project') : null;
    // Base de las rutas relativas de las herramientas locales, con o sin modo proyecto.
    const mcpState = State.get('mcp');
    const projectDirectory = mcpState.status === 'connected' ? String(mcpState.serverInfo?.cwd || '') : '';

    try {
      const activeProfile = await resolveDep('ChatUIProfiles', './ui-profiles.js').loadProfileUnlocked(config.activeProfile?.id);
      const loopResult = await getEngine().executeAgentTurnLoop({
        apiKey: activeProfile?.settings?.apiKey || '',
        chatHistory: State.get('messages'),
        appConfig: config,
        assistantMsgId,
        currentRagSystemContext,
        projectContext,
        projectDirectory,
        signal: currentAbortController.signal,
        view: UIConversation.createTurnView(content, { scrollToBottom }),
        onBeforeRequest: config.enableDebugMessages ? options.openDebugInterceptorModal : null,
        onReasoningChunk: chunk => {
          if (!isCurrentSession()) return;
          Debug.addLog('thinking', chunk);
          Debug.setStatus('streaming', t('debug_status_thinking'));
        },
        onGenerationStatus: update => {
          if (isCurrentSession()) status.setStatus(elements.generationStatus, update);
          options.onProgress?.({ kind: update.phase === 'tool' ? 'tool' : 'status', text: update.text || update.phase || '' });
        },
        onProgress: options.onProgress,
        onLog: (type, text) => {
          if (isCurrentSession()) Debug.addLog(type, text);
        },
        onStats: stats => {
          if (!isCurrentSession()) return;
          updateStatsDisplay(statsContainer, stats);
          options.updateConnectionTokensBadge(stats);
        }
      });

      if (!isCurrentSession()) {
        console.warn('[GenerationController] Inference discarded after a session change.');
        return { error: 'The conversation changed during the generation.' };
      }

      if (loopResult.chatHistory) {
        State.replaceMessages(loopResult.chatHistory);
        UIConversation.setAssistantGroupMessageIds(wrapper, State.get('messages'));
      }

      if (loopResult.cancelled) {
        if (!wrapper.querySelector('.tool-call-group, .agentic-turn-block')) wrapper.remove();
        Debug.setStatus('idle');
        return { error: 'The generation was cancelled.' };
      }

      if (loopResult.loopDetected) {
        Debug.setStatus('error', t('debug_status_loop_detected'));
        Debug.addLog('error', t('agent_loop_warning_notice'));
      } else if (loopResult.error) {
        if (currentAbortController.signal.aborted) return { error: 'The generation was cancelled.' };
        const message = loopResult.error.message || String(loopResult.error);
        Debug.setStatus('error', t('debug_status_error'));
        Debug.addLog('error', message);
        if (loopResult.error.name === 'StreamServerError') {
          UIConversation.renderStreamError(parts, loopResult.error.serverMessage);
        } else {
          UIConversation.renderConnectionError(parts, message, config.apiUrl);
        }
        return { error: message };
      } else {
        Debug.setStatus('done', t('debug_status_done'));
      }

      if (loopResult.truncated) UIConversation.renderTruncationNotice(content);

      if (loopResult.stats) {
        updateStatsDisplay(statsContainer, loopResult.stats);
        options.updateConnectionTokensBadge(loopResult.stats, { forcePopover: true });
      }
      actions.hidden = false;
      UIConversation.bindMessageCopy(btnCopy, () => loopResult.accumulatedMarkdown || loopResult.finalAssistantText || '');
      if (loopResult.loopDetected) return { error: 'The agent loop was stopped after repeated tool calls.' };
      return { text: loopResult.finalAssistantText };
    } catch (err) {
      console.error('[GenerationController] Agent inference failed:', err);
      if (currentAbortController.signal.aborted || err?.name === 'AbortError') return { error: 'The generation was cancelled.' };
      const generationError = err?.message || String(err);
      Debug.setStatus('error', t('debug_status_error'));
      Debug.addLog('error', generationError);
      UIConversation.renderConnectionError(parts, generationError, config.apiUrl);
      return { error: generationError };
    } finally {
      finishGeneration(elements, { skipSave: !isCurrentSession(), saveCurrentSession: options.saveCurrentSession });
    }
  }

  return {
    handleSendMessage,
    handleStopGeneration,
    runCancellableTask,
    isGenerating
  };
}));
