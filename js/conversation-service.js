/**
 * Servicio de Dominio para Gestión de Conversaciones y Sesiones de Chat (ZeroChat).
 * Coordina el ciclo de vida de las sesiones (crear, guardar, renombrar, borrar, cambiar de sesión,
 * bifurcar ramas / branching y persistir en State y Storage).
 *
 * Las opciones que recibe cada operación son los callbacks de presentación de app.js:
 * renderSessionMessages, renderSidebarChats, onSessionReset, resetComposerInput y closeSidebar.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./utils.js'), require('./i18n.js'), require('./message-turns.js'));
  } else {
    root.ChatConversationService = factory(root.ChatUtils, root.ChatI18n, root.ChatMessageTurns);
  }
}(typeof self !== 'undefined' ? self : this, function (Utils, I18n, MessageTurns) {
  'use strict';

  const { resolveDep, createId, clone } = Utils;
  const { t } = I18n;

  const getState = () => resolveDep('ChatState', './state.js');
  const getStorage = () => resolveDep('ChatStorage', './storage.js');
  const getDialogs = () => resolveDep('ChatDialogs', './ui-dialogs.js');
  const getEngine = () => resolveDep('ChatEngine', './chat-engine.js');
  const getConfig = () => resolveDep('ChatConfig', './config-store.js');
  const getGenerationController = () => resolveDep('ChatGenerationController', './generation-controller.js');

  const getHistory = () => getState().get('messages');
  const getActiveSessionId = () => getState().get('sessions').activeId;
  const getSavedSessions = () => getState().get('sessions').list;

  function createInitialChatHistory() {
    const config = getConfig().getActive();
    const Engine = getEngine();
    return [{
      id: 'system_root',
      role: 'system',
      content: Engine.getConfiguredSystemPrompt(config),
      contextDateAnchor: Engine.getConversationDateAnchor()
    }];
  }

  function blockSessionTransitionIfBusy(messageKey) {
    if (!getState().isConversationBusy()) return false;
    getDialogs().alert(t(messageKey));
    return true;
  }

  function activateConversation(sessionId, history, blockedMessageKey, options) {
    if (!getState().replaceConversation({ sessionId, messages: history }).ok) {
      getDialogs().alert(t(blockedMessageKey));
      return false;
    }
    options.onSessionReset();
    return true;
  }

  /** Muestra la sesión activa tras cambiarla; en pantallas estrechas cierra la barra lateral. */
  function showActiveSession(options, { resetComposer }) {
    options.renderSessionMessages(getHistory());
    options.renderSidebarChats();
    if (resetComposer) options.resetComposerInput();
    if (window.innerWidth < 900) options.closeSidebar();
  }

  async function loadSessionsFromStorage(options) {
    let sessions = [];
    try {
      sessions = await getStorage().getConversationsList();
    } catch (error) {
      console.warn('[ConversationService] Could not load saved conversations:', error);
    }
    getState().replaceConversation({ sessionId: createId('session'), sessions, messages: createInitialChatHistory() });
    options.renderSessionMessages(getHistory());
    options.renderSidebarChats();
  }

  function deriveTitle(history) {
    const firstUser = history.find(message => message.role === 'user');
    const candidate = String(firstUser?.content || '').split('\n')[0].replace(/[#*`_>[\]]/g, '').trim();
    return candidate.length > 35 ? `${candidate.substring(0, 32)}…` : candidate;
  }

  async function saveCurrentSession(options) {
    const State = getState();
    const Storage = getStorage();
    const history = getHistory();
    const sessionId = getActiveSessionId();

    if (!history.some(message => message.role === 'user')) {
      State.removeSession(sessionId);
      await Storage.deleteConversation(sessionId);
      options.renderSidebarChats();
      return;
    }

    const now = Date.now();
    const existing = getSavedSessions().find(session => session.id === sessionId);
    const session = existing
      ? { ...existing, updatedAt: now, messageCount: history.length }
      : { id: sessionId, title: '', createdAt: now, updatedAt: now, messageCount: history.length };
    if (!session.title) session.title = deriveTitle(history) || t('chat_untitled');

    State.saveSessionMetadata(session);
    await Storage.saveConversation(session, history);
    options.renderSidebarChats();
  }

  async function switchToSession(sessionId, options) {
    const { force = false, saveCurrent = true } = options;
    if (!force && sessionId === getActiveSessionId()) return;
    if (blockSessionTransitionIfBusy('chat_switch_blocked_generating')) return false;
    if (saveCurrent) await saveCurrentSession(options);

    const conversation = await getStorage().getConversation(sessionId);
    if (!conversation) return;
    const history = conversation.history.length > 0 ? [...conversation.history] : createInitialChatHistory();
    getEngine().ensureConversationDate(history, conversation.createdAt);

    if (!activateConversation(conversation.id, history, 'chat_switch_blocked_generating', options)) return false;
    showActiveSession(options, { resetComposer: false });
    return true;
  }

  async function createNewSession(options) {
    const { saveCurrent = true } = options;
    if (blockSessionTransitionIfBusy('chat_new_blocked_generating')) return false;
    if (saveCurrent) await saveCurrentSession(options);
    if (!activateConversation(createId('session'), createInitialChatHistory(), 'chat_new_blocked_generating', options)) return false;
    showActiveSession(options, { resetComposer: true });
    return true;
  }

  function getBranchBoundaryIndex(wrapper, history) {
    const messageIds = new Set((wrapper.getAttribute('data-msg-ids') || '').split(',').filter(Boolean));
    for (const attribute of ['data-msg-id', 'data-base-id']) {
      const value = wrapper.getAttribute(attribute);
      if (value) messageIds.add(value);
    }
    let boundary = -1;
    history.forEach((message, index) => {
      if (messageIds.has(message.id) || messageIds.has(MessageTurns.extractBaseId(message.id))) boundary = index;
    });
    return boundary;
  }

  function setAssistantGroupMessageIds(wrapper, history) {
    let lastUserIndex = -1;
    for (let index = history.length - 1; index >= 0; index--) {
      if (history[index].role === 'user') {
        lastUserIndex = index;
        break;
      }
    }
    const ids = history.slice(lastUserIndex + 1).map(message => message.id);
    if (ids.length > 0) wrapper.setAttribute('data-msg-ids', ids.join(','));
  }

  /** Copia profunda de los mensajes con identificadores propios de la sesión destino. */
  function renumberForSession(messages, sessionId) {
    return clone(messages).map((message, index) => ({ ...message, id: `msg_${sessionId}_${index}` }));
  }

  function cloneBranchHistory(history, boundary, sessionId) {
    return renumberForSession(history.slice(0, boundary + 1), sessionId);
  }

  function shouldOfferBranchSummary(history, boundary) {
    const dialogue = history.slice(0, boundary + 1).filter(message => message.role !== 'system');
    return dialogue.filter(message => message.role === 'user').length >= 2 || dialogue.length >= 4;
  }

  async function summarizeHistory(params) {
    const config = getConfig().getActive();
    const activeProfile = await resolveDep('ChatUIProfiles', './ui-profiles.js').loadProfileUnlocked(config.activeProfile?.id);
    const summarize = getEngine().createHistorySummarizer({
      apiUrl: config.apiUrl,
      apiType: config.apiType,
      apiKey: activeProfile?.settings?.apiKey || '',
      model: config.model,
      signal: params.signal
    });
    return summarize(params);
  }

  /** Historial de la rama con el contexto previo resumido; null si no se pudo resumir. */
  async function summarizeBranchHistory(history, boundary, sessionId, signal) {
    const config = getConfig().getActive();
    // La respuesta de anclaje se conserva literal tras el resumen, así que no se resume.
    const compacted = await resolveDep('ChatContextManager', './context-manager.js').compressHistory({
      messages: history.slice(0, boundary),
      summarizeFn: params => summarizeHistory({ ...params, signal }),
      options: {
        model: config.model,
        totalContextLimit: config.modelContextLimit || config.contextLimitOverride
      }
    });
    return compacted.compressed
      ? renumberForSession([...compacted.messages, history[boundary]], sessionId)
      : null;
  }

  /** Decide si la rama se resume; null si el usuario cancela la bifurcación. */
  async function askBranchMode(history, boundary) {
    if (!shouldOfferBranchSummary(history, boundary)) return { summarize: false };
    const decision = await getDialogs().confirm(t('chat_branch_dialog_message'), {
      title: t('chat_branch_dialog_title'),
      acceptText: t('chat_branch_dialog_accept'),
      cancelText: t('notice_cancel'),
      checkbox: t('chat_branch_dialog_checkbox'),
      checkboxDefault: true
    });
    return decision.accepted ? { summarize: decision.checkboxChecked } : null;
  }

  /**
   * Historial de una rama resumida. Si el resumen falla, ofrece bifurcar con el historial
   * completo; null si se cancela o la conversación quedó ocupada.
   */
  async function buildSummarizedBranchHistory(wrapper, history, boundary, sessionId) {
    const State = getState();
    const UIConversation = resolveDep('ChatUIConversation', './ui-conversation.js');
    UIConversation.showBranchLoadingIndicator(wrapper, t('chat_branch_summarizing'));
    let cancelled = false;
    let summarized = null;
    try {
      // Mientras se resume, la conversación cuenta como ocupada y el botón de parar la cancela.
      summarized = await getGenerationController().runCancellableTask(async signal => {
        State.setGenerationStatus({ phase: 'custom', text: t('chat_branch_summarizing') });
        const result = await summarizeBranchHistory(history, boundary, sessionId, signal);
        cancelled = signal.aborted;
        return result;
      });
    } catch (err) {
      console.warn('[ConversationService] Could not summarize the branch history:', err);
    } finally {
      State.clearGenerationStatus();
      UIConversation.hideBranchLoadingIndicator(wrapper);
    }

    if (cancelled || blockSessionTransitionIfBusy('chat_new_blocked_generating')) return null;
    if (summarized) return summarized;
    const useFullHistory = await getDialogs().confirm(t('chat_branch_summary_failed'), {
      title: t('chat_branch_dialog_title'),
      acceptText: t('chat_branch_dialog_accept'),
      cancelText: t('notice_cancel')
    });
    return useFullHistory ? cloneBranchHistory(history, boundary, sessionId) : null;
  }

  async function createConversationBranch(wrapper, options) {
    if (blockSessionTransitionIfBusy('chat_new_blocked_generating')) return false;

    const history = getHistory();
    const boundary = getBranchBoundaryIndex(wrapper, history);
    if (boundary < 0) return false;

    await saveCurrentSession(options);
    if (blockSessionTransitionIfBusy('chat_new_blocked_generating')) return false;

    const mode = await askBranchMode(history, boundary);
    if (!mode || blockSessionTransitionIfBusy('chat_new_blocked_generating')) return false;

    const parentSessionId = getActiveSessionId();
    const parentTitle = getSavedSessions().find(session => session.id === parentSessionId)?.title || t('chat_untitled');
    const branchSessionId = createId('session');
    const branchHistory = mode.summarize
      ? await buildSummarizedBranchHistory(wrapper, history, boundary, branchSessionId)
      : cloneBranchHistory(history, boundary, branchSessionId);
    if (!branchHistory) return false;

    const now = Date.now();
    const branchSession = {
      id: branchSessionId,
      title: t('chat_branch_title', { title: parentTitle }),
      createdAt: now,
      updatedAt: now,
      messageCount: branchHistory.length
    };

    const Storage = getStorage();
    if (!await Storage.saveConversation(branchSession, branchHistory)) {
      getDialogs().alert(t('chat_branch_error'), { type: 'error' });
      return false;
    }
    if (!activateConversation(branchSessionId, branchHistory, 'chat_new_blocked_generating', options)) {
      await Storage.deleteConversation(branchSessionId);
      return false;
    }
    getState().saveSessionMetadata(branchSession);
    showActiveSession(options, { resetComposer: true });
    return true;
  }

  async function deleteSession(sessionId, options) {
    if (!await getDialogs().confirm(t('chat_delete_confirm'))) return;
    if (blockSessionTransitionIfBusy('chat_delete_blocked_generating')) return;

    const activeId = getActiveSessionId();
    if (!getState().removeSession(sessionId).ok) {
      getDialogs().alert(t('chat_delete_blocked_generating'));
      return;
    }
    await getStorage().deleteConversation(sessionId);

    const remaining = getSavedSessions();
    if (remaining.length === 0) {
      await createNewSession({ ...options, saveCurrent: false });
    } else if (activeId === sessionId) {
      await switchToSession(remaining[0].id, { ...options, force: true, saveCurrent: false });
    } else {
      options.renderSidebarChats();
    }
  }

  async function deleteAllSessions(options) {
    if (getSavedSessions().length === 0) return;
    if (blockSessionTransitionIfBusy('chat_delete_blocked_generating')) return;
    if (!await getDialogs().confirm(t('chat_delete_all_confirm'))) return;
    if (blockSessionTransitionIfBusy('chat_delete_blocked_generating')) return;

    if (!await getStorage().deleteAllConversations()) {
      getDialogs().alert(t('chat_delete_history_err'), { type: 'error' });
      return;
    }
    getState().set('sessions', { activeId: null, list: [] });
    await createNewSession({ ...options, saveCurrent: false });
  }

  async function renameSession(sessionId, options) {
    const current = getSavedSessions().find(session => session.id === sessionId);
    if (!current) return;
    const newTitle = (await getDialogs().prompt(t('prompt_rename_conversation'), current.title))?.trim();
    if (!newTitle) return;
    // La sesión pudo borrarse mientras el diálogo estaba abierto.
    const session = getSavedSessions().find(item => item.id === sessionId);
    if (!session) return;
    getState().saveSessionMetadata({ ...session, title: newTitle, updatedAt: Date.now() });
    await getStorage().renameConversation(sessionId, newTitle);
    options.renderSidebarChats();
  }

  return {
    blockSessionTransitionIfBusy,
    loadSessionsFromStorage,
    saveCurrentSession,
    switchToSession,
    createNewSession,
    setAssistantGroupMessageIds,
    createConversationBranch,
    deleteSession,
    deleteAllSessions,
    renameSession
  };
}));
