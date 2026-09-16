/**
 * Controlador del Ciclo de Vida de Generación e Inferencia (ZeroChat).
 * Orquesta el envío de mensajes, streaming SSE, llamadas a herramientas,
 * control de aborto, captura inmutable de configuración y finalización atómica.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.ChatGenerationController = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function resolveDep(globalName, relPath) {
    if (typeof window !== 'undefined' && window[globalName]) return window[globalName];
    if (typeof globalThis !== 'undefined' && globalThis[globalName]) return globalThis[globalName];
    if (typeof require !== 'undefined') {
      try { return require(relPath); } catch (_) {}
    }
    return null;
  }

  function getState() { return resolveDep('ChatState', './state.js'); }
  function getI18n() { return resolveDep('ChatI18n', './i18n.js'); }
  function getIcons() { return resolveDep('ChatIcons', './icons.js'); }
  function getAPI(options = {}) { return options.api || resolveDep('ChatAPI', './api.js'); }
  function getEngine() { return resolveDep('ChatEngine', './chat-engine.js'); }
  function getProfiles() { return resolveDep('ChatProfileRepository', './profile-repository.js'); }
  function getAttachments() { return resolveDep('ChatAttachments', './attachments.js'); }
  function getConversationService() { return resolveDep('ChatConversationService', './conversation-service.js'); }
  function getUIConversation() { return resolveDep('ChatUIConversation', './ui-conversation.js'); }

  function t(key, params) {
    const I18n = getI18n();
    return I18n?.t ? I18n.t(key, params) : key;
  }

  function getMsgIcon(name, size = 12) {
    const Icons = getIcons();
    if (Icons && Icons.has && Icons.has(name)) {
      return Icons.get(name, { size, className: 'ui-icon' });
    }
    return '';
  }

  let currentAbortController = null;

  function getCurrentAbortController() {
    return currentAbortController;
  }

  function isGenerating() {
    const State = getState();
    return State?.get?.('streaming')?.isGenerating === true || currentAbortController !== null;
  }

  function handleStopGeneration() {
    if (currentAbortController) {
      currentAbortController.abort();
    }
  }

  function finishGeneration(options = {}) {
    const { skipSave = false, error = null, elements = {} } = options;
    const State = getState();
    const UIConversation = getUIConversation();

    if (typeof options.removeTypingIndicator === 'function') {
      options.removeTypingIndicator();
    } else if (UIConversation?.removeTypingIndicator) {
      UIConversation.removeTypingIndicator();
    }

    if (typeof options.clearGenerationStatus === 'function') {
      options.clearGenerationStatus();
    }

    if (State?.set) {
      if (error) {
        State.set('streaming', { isGenerating: false, status: 'error', error: String(error) });
      } else {
        State.set('streaming', { isGenerating: false, status: 'idle', error: null });
      }
    }

    if (elements.btnSend) elements.btnSend.disabled = false;
    if (elements.btnStopStream) elements.btnStopStream.style.display = 'none';

    currentAbortController = null;

    if (elements.userInput) {
      try { elements.userInput.focus(); } catch (_) {}
    }

    if (!skipSave && typeof options.saveCurrentSession === 'function') {
      try {
        options.saveCurrentSession();
      } catch (saveErr) {
        console.warn('[ZeroChat] Error al guardar sesión en finishGeneration:', saveErr);
      }
    }

    if (typeof options.scrollToBottom === 'function') {
      options.scrollToBottom();
    } else if (UIConversation?.scrollToBottom) {
      UIConversation.scrollToBottom(elements.messagesList);
    }
  }

  function updateStatsDisplay(statsContainer, stats, options = {}) {
    if (!stats || !statsContainer) return;
    statsContainer.style.display = 'inline-flex';
    const clockSvg = getMsgIcon('clock', 11);
    const zapSvg = getMsgIcon('zap', 11);
    const docSvg = getMsgIcon('file-text', 11);
    const dbSvg = getMsgIcon('database', 11);

    const cacheHtml = (stats.cachedTokens && stats.cachedTokens > 0)
      ? `<span class="stat-sep stat-sep-4">•</span><span class="stat-item stat-item-cache" title="${t('stat_cache_title')}">${dbSvg} <span>${t('stat_cache_tokens', { tokens: stats.cachedTokens })}</span></span>`
      : '';
    statsContainer.innerHTML = `
      <span class="stat-item stat-item-ttft" title="${t('stat_ttft_title')}">${clockSvg} <span>${t('stat_ttft', { sec: stats.ttftSec })}</span></span>
      <span class="stat-sep stat-sep-1">•</span>
      <span class="stat-item stat-item-speed" title="${t('stat_speed_title')}">${zapSvg} <span>${t('stat_speed', { speed: stats.tokensPerSec })}</span></span>
      <span class="stat-sep stat-sep-2">•</span>
      <span class="stat-item stat-item-total" title="${t('stat_total_time_title')}">${clockSvg} <span>${t('stat_total_time', { sec: stats.totalSec })}</span></span>
      <span class="stat-sep stat-sep-3">•</span>
      <span class="stat-item stat-item-tokens" title="${t('stat_tokens_title')}">${docSvg} <span>${t('stat_tokens', { tokens: stats.tokens })}</span></span>${cacheHtml}
    `;

    if (typeof options.updateConnectionTokensBadge === 'function') {
      options.updateConnectionTokensBadge(stats);
    }
  }

  async function handleSendMessage(options = {}) {
    const elements = options.elements || {};
    const State = getState();
    const Attachments = getAttachments();
    const API = getAPI(options);
    const Engine = getEngine();
    const Profiles = getProfiles();
    const UIConversation = getUIConversation();
    const ConversationService = getConversationService();

    const rawText = (elements.userInput ? elements.userInput.value : (options.text || '')).trim();
    const currentFiles = Attachments?.getFiles ? Attachments.getFiles() : [];
    if ((!rawText && currentFiles.length === 0) || State?.isConversationBusy?.()) return;

    const runtimeConfig = typeof options.getRuntimeConfig === 'function' ? options.getRuntimeConfig() : {};

    const { fullPrompt, displayText, imageAttachments } = Attachments?.buildAttachmentsPayload
      ? Attachments.buildAttachmentsPayload(rawText, currentFiles)
      : { fullPrompt: rawText, displayText: rawText, imageAttachments: [] };

    const appendUser = typeof options.appendUserMessage === 'function'
      ? options.appendUserMessage
      : (UIConversation?.appendUserMessage
          ? (text, origPrompt, imgs) => UIConversation.appendUserMessage(elements.messagesList, elements.welcomeBanner, { text, originalPrompt: origPrompt, attachedImages: imgs }, options)
          : () => 'msg_usr_' + Date.now());

    const userMsgId = appendUser(displayText, rawText, imageAttachments);
    const historyEntry = { id: userMsgId, role: 'user', content: fullPrompt };
    if (imageAttachments.length > 0) {
      historyEntry.images = imageAttachments;
    }
    if (State?.appendMessage) {
      State.appendMessage(historyEntry);
    }

    const getCurrentSessionId = typeof options.getCurrentSessionId === 'function'
      ? options.getCurrentSessionId
      : (() => State?.getActiveSessionId?.() || '');
    const generationSessionId = getCurrentSessionId();
    let generationError = null;

    if (elements.userInput) elements.userInput.value = '';
    if (typeof options.clearAttachedFiles === 'function') options.clearAttachedFiles();
    if (typeof options.autoResizeTextarea === 'function') options.autoResizeTextarea();
    if (typeof options.closeReasoningMenu === 'function') options.closeReasoningMenu();

    if (State?.set) {
      State.set('streaming', { isGenerating: true, status: 'streaming', error: null });
    }
    if (typeof options.setGenerationStatus === 'function') {
      options.setGenerationStatus({ phase: 'generating' });
    }

    currentAbortController = new AbortController();

    if (typeof options.showTypingIndicator === 'function') {
      options.showTypingIndicator();
    } else if (UIConversation?.showTypingIndicator) {
      UIConversation.showTypingIndicator(elements.messagesList);
    }

    const createPlaceholder = typeof options.createAssistantMessagePlaceholder === 'function'
      ? options.createAssistantMessagePlaceholder
      : (UIConversation?.createAssistantMessagePlaceholder
          ? (id) => UIConversation.createAssistantMessagePlaceholder(elements.messagesList, id, options)
          : () => ({ wrapper: null, row: null, content: null, actions: null, btnCopy: null, statsContainer: null, msgId: 'ast_' + Date.now() }));

    const { wrapper, row, content, actions, btnCopy, statsContainer, msgId: assistantMsgId } = createPlaceholder();

    if (typeof options.removeTypingIndicator === 'function') {
      options.removeTypingIndicator();
    } else if (UIConversation?.removeTypingIndicator) {
      UIConversation.removeTypingIndicator();
    }

    const attachListeners = typeof options.attachListenersToContainer === 'function'
      ? options.attachListenersToContainer
      : (el => UIConversation?.attachListenersToContainer ? UIConversation.attachListenersToContainer(el) : null);

    const scrollToBottom = typeof options.scrollToBottom === 'function'
      ? options.scrollToBottom
      : (() => UIConversation?.scrollToBottom ? UIConversation.scrollToBottom(elements.messagesList) : null);

    if (!API?.streamChatCompletion) {
      if (row?.classList?.add) row.classList.add('message-error');
      if (content) content.innerHTML = 'Error: Chat API module not loaded.';
      finishGeneration({ error: 'Error: Chat API module not loaded.', elements, ...options });
      return;
    }

    if (!runtimeConfig.model || runtimeConfig.model.trim() === '') {
      if (row?.classList?.add) row.classList.add('message-error');
      if (content) {
        content.innerHTML = `
          <div style="display:flex; align-items:flex-start; gap:0.5rem;">
            <span style="flex-shrink: 0; display: inline-flex; align-items: center; color: var(--error, #ef4444);">${getMsgIcon('alert-triangle', 18)}</span>
            <div>
              <strong>${t('err_no_model_title')}</strong>
              <p style="margin-top: 0.25rem;">${t('err_no_model_desc', { url: runtimeConfig.apiUrl })}</p>
            </div>
          </div>
        `;
      }
      if (actions) actions.style.display = 'inline-flex';
      finishGeneration({ error: t('err_no_model_title'), elements, ...options });
      return;
    }

    const activeRagBranchIds = Array.isArray(runtimeConfig.activeRagBranchIds)
      ? runtimeConfig.activeRagBranchIds
      : (runtimeConfig.activeRagBranchId ? [runtimeConfig.activeRagBranchId] : []);
    const activeRagBranchId = activeRagBranchIds[0] || runtimeConfig.activeRagBranchId || '';

    const RagService = resolveDep('ChatRagService', './rag-service.js');
    if (activeRagBranchIds.length > 0 && RagService?.buildRagSystemContext) {
      if (typeof options.setGenerationStatus === 'function') {
        options.setGenerationStatus({ phase: 'rag', text: t('generation_status_rag') });
      }
      try {
        const ragContext = await RagService.buildRagSystemContext(activeRagBranchIds, {
          isCheckpointEnabled: !!(runtimeConfig.enabledTools && runtimeConfig.enabledTools.agent_checkpoint),
          lang: runtimeConfig.language || 'es'
        });
        if (State?.set) State.set('agent', { loopWarning: false, ragSystemContext: ragContext });
      } catch (err) {
        console.warn('Error al cargar contexto inicial de RAG:', err);
        if (typeof options.addDebugLog === 'function') {
          options.addDebugLog('warning', `[RAG] Error al cargar contexto inicial: ${err?.message || String(err)}`);
        }
        if (State?.set) State.set('agent', { loopWarning: false, ragSystemContext: '' });
      }
    } else {
      if (State?.set) State.set('agent', { loopWarning: false, ragSystemContext: '' });
    }

    const currentRagSystemContext = State?.get ? (State.get('agent')?.ragSystemContext || '') : '';

    try {
      const runner = Engine || resolveDep('ChatEngine', './chat-engine.js');
      const activeProfile = Profiles?.load ? await Profiles.load(runtimeConfig.activeProfile?.id) : null;
      const getChatHistory = typeof options.getChatHistory === 'function' ? options.getChatHistory : (() => State?.getMessages?.() || []);

      const loopResult = await runner.executeAgentTurnLoop({
        apiUrl: runtimeConfig.apiUrl,
        apiType: runtimeConfig.apiType,
        apiKey: activeProfile?.settings?.apiKey || '',
        model: runtimeConfig.model,
        temperature: runtimeConfig.temperature,
        reasoningEffort: runtimeConfig.reasoningEffort || 'none',
        reasoningTransport: runtimeConfig.reasoningTransport || 'auto',
        maxAgentTurns: runtimeConfig.maxAgentTurns ? Number(runtimeConfig.maxAgentTurns) : 15,
        chatHistory: getChatHistory(),
        appConfig: runtimeConfig,
        assistantMsgId: assistantMsgId,
        activeRagBranchId: activeRagBranchId,
        activeRagBranchIds: activeRagBranchIds,
        currentRagSystemContext: currentRagSystemContext,
        signal: currentAbortController.signal,
        container: content,

        onBeforeRequest: runtimeConfig.enableDebugMessages ? async function ({ endpoint, headers, payload }) {
          if (typeof options.openDebugInterceptorModal === 'function') {
            return await options.openDebugInterceptorModal({ endpoint, headers, payload });
          }
          return { endpoint, headers, payload };
        } : null,

        onReasoningChunk: function (chunk) {
          if (getCurrentSessionId() !== generationSessionId) return;
          if (typeof options.addDebugLog === 'function') options.addDebugLog('thinking', chunk);
          if (typeof options.setDebugStatus === 'function') options.setDebugStatus('streaming', t('debug_status_thinking'));
        },

        onGenerationStatus: function (status) {
          if (getCurrentSessionId() !== generationSessionId) return;
          if (typeof options.setGenerationStatus === 'function') options.setGenerationStatus(status);
        },

        onLog: function (type, txt) {
          if (getCurrentSessionId() !== generationSessionId) return;
          if (typeof options.addDebugLog === 'function') options.addDebugLog(type, txt);
        },

        onStats: function (stats) {
          if (getCurrentSessionId() !== generationSessionId) return;
          updateStatsDisplay(statsContainer, stats, options);
        },

        onChunk: function ({ turnIndex, fullText, delta, stats }) {
          if (getCurrentSessionId() !== generationSessionId) return;
          if (stats) updateStatsDisplay(statsContainer, stats, options);
          scrollToBottom();
        },

        scrollToBottom: () => scrollToBottom(),
        attachListeners: (el) => attachListeners(el)
      });

      if (getCurrentSessionId() !== generationSessionId) {
        console.warn('[ZeroChat] Inferencia descartada por cambio de sesión.');
        return;
      }

      if (loopResult && Array.isArray(loopResult.chatHistory) && State?.replaceMessages) {
        State.replaceMessages(loopResult.chatHistory);
        if (typeof options.setAssistantGroupMessageIds === 'function') {
          options.setAssistantGroupMessageIds(wrapper, getChatHistory());
        } else if (ConversationService?.setAssistantGroupMessageIds) {
          ConversationService.setAssistantGroupMessageIds(wrapper, getChatHistory());
        }
      }

      if (loopResult && loopResult.cancelled) {
        if (wrapper && !wrapper.querySelector?.('.agentic-turn-block') && wrapper.parentNode) {
          wrapper.parentNode.removeChild(wrapper);
        }
        if (typeof options.setDebugStatus === 'function') options.setDebugStatus('idle');
        return;
      }

      if (loopResult && loopResult.loopDetected) {
        if (State?.set) {
          State.set('agent', { loopWarning: true });
        }
        if (typeof options.setDebugStatus === 'function') {
          options.setDebugStatus('error', t('debug_status_loop_detected'));
        }
        if (typeof options.addDebugLog === 'function') {
          options.addDebugLog('error', t('agent_loop_warning_notice'));
        }
      } else if (loopResult && loopResult.error) {
        if (currentAbortController && currentAbortController.signal.aborted) {
          return;
        }
        if (typeof options.setDebugStatus === 'function') options.setDebugStatus('error', t('debug_status_error'));
        if (typeof options.addDebugLog === 'function') options.addDebugLog('error', loopResult.error.message || String(loopResult.error));
        UIConversation.renderConnectionError({ row, content, actions },
          loopResult.error.message || String(loopResult.error), runtimeConfig.apiUrl);
        return;
      }

      if (loopResult && loopResult.stats) {
        updateStatsDisplay(statsContainer, loopResult.stats, options);
        if (typeof options.updateConnectionTokensBadge === 'function') {
          options.updateConnectionTokensBadge(loopResult.stats, loopResult.contextDiagnostics, { forcePopover: true });
        }
      }

      if (actions) actions.style.display = 'inline-flex';
      UIConversation.bindMessageCopy(btnCopy, () => loopResult?.accumulatedMarkdown || loopResult?.finalAssistantText || '');

      if (typeof options.setDebugStatus === 'function' && !loopResult?.loopDetected) {
        options.setDebugStatus('done', t('debug_status_done'));
      }
    } catch (err) {
      console.error('[ZeroChat] Error durante inferencia agéntica:', err);
      const isAborted = Boolean(currentAbortController && currentAbortController.signal.aborted) || err?.name === 'AbortError';
      if (!isAborted) {
        generationError = err?.message || String(err);
        if (typeof options.setDebugStatus === 'function') options.setDebugStatus('error', t('debug_status_error'));
        if (typeof options.addDebugLog === 'function') options.addDebugLog('error', generationError);
        UIConversation.renderConnectionError({ row, content, actions }, generationError, runtimeConfig.apiUrl);
      }
    } finally {
      finishGeneration({
        skipSave: getCurrentSessionId() !== generationSessionId,
        error: generationError,
        elements,
        ...options
      });
    }
  }

  return {
    handleSendMessage,
    finishGeneration,
    handleStopGeneration,
    isGenerating,
    getCurrentAbortController
  };
}));
