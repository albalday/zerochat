/**
 * Servicio de Dominio para Gestión de Conversaciones y Sesiones de Chat (ZeroChat).
 * Coordina el ciclo de vida de las sesiones (crear, guardar, renombrar, borrar, cambiar de sesión,
 * bifurcar ramas / branching y persistir en State y Storage).
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./utils.js'), require('./message-turns.js'));
  } else {
    root.ChatConversationService = factory(root.ChatUtils, root.ChatMessageTurns);
  }
}(typeof self !== 'undefined' ? self : this, function (Utils, MessageTurns) {
  'use strict';

  const { resolveDep } = Utils;

  function getI18n() { return resolveDep('ChatI18n', './i18n.js'); }
  function getState() { return resolveDep('ChatState', './state.js'); }
  function getStorage(options = {}) {
    if (options && options.storage) return options.storage;
    return resolveDep('ChatStorage', './cookies.js') || resolveDep('ZeroChatDB', './storage-db.js');
  }
  function getDialogs() { return resolveDep('ChatDialogs', './ui-dialogs.js'); }
  function getEngine() { return resolveDep('ChatEngine', './chat-engine.js'); }
  function getUtils() { return resolveDep('ChatUtils', './utils.js'); }
  function getConfig() { return resolveDep('ChatConfig', './config-store.js'); }
  function getGenerationController() { return resolveDep('ChatGenerationController', './generation-controller.js'); }

  function t(key, params) {
    const I18n = getI18n();
    return I18n?.t?.(key, params) || key;
  }

  const extractBaseId = MessageTurns.extractBaseId;

  const isDateTimeInitialTurn = MessageTurns.isDateTimeInitialTurn;

  function createInitialChatHistory(options = {}) {
    const Engine = getEngine();
    const Config = getConfig();
    const runtimeConfig = options.getRuntimeConfig ? options.getRuntimeConfig() : (Config?.getActive?.() || {});
    const lang = options.language || runtimeConfig.language || 'es';
    const systemPrompt = typeof options.getConfiguredSystemPrompt === 'function'
      ? options.getConfiguredSystemPrompt(runtimeConfig)
      : (runtimeConfig.systemPrompt || '');

    return [
      {
        id: 'system_root',
        role: 'system',
        content: systemPrompt,
        contextDateAnchor: Engine?.getConversationDateAnchor ? Engine.getConversationDateAnchor(lang) : undefined
      }
    ];
  }

  function blockSessionTransitionIfBusy(messageKey) {
    const State = getState();
    const isBusy = State?.isConversationBusy?.() === true;
    if (!isBusy) return false;
    const Dialogs = getDialogs();
    if (Dialogs?.alert) Dialogs.alert(t(messageKey));
    return true;
  }

  function initializeSessionState(sessionId, history, blockedMessageKey, options = {}) {
    const State = getState();
    const initialization = State?.replaceConversation
      ? State.replaceConversation({ sessionId, messages: history })
      : (State?.initializeConversation
          ? State.initializeConversation({ sessionId, messages: history })
          : { ok: true });

    if (!initialization.ok) {
      const Dialogs = getDialogs();
      if (Dialogs?.alert) Dialogs.alert(t(blockedMessageKey));
      return false;
    }

    if (typeof options.onSessionReset === 'function') {
      options.onSessionReset();
    }
    return true;
  }

  async function loadSessionsFromStorage(options = {}) {
    const State = getState();
    const Storage = getStorage(options);
    let sessionsList = [];
    try {
      if (Storage?.initDB) await Storage.initDB();
      if (Storage?.getConversationsList) {
        sessionsList = await Storage.getConversationsList();
      }
    } catch (e) {
      console.warn('Error al cargar sesiones de chat:', e);
      sessionsList = [];
    }

    if (!Array.isArray(sessionsList)) {
      sessionsList = [];
    }

    const nextSessionId = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? 'session_' + crypto.randomUUID()
      : 'session_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    const initialHistory = createInitialChatHistory(options);

    if (State?.initializeConversation) {
      State.initializeConversation({ sessionId: nextSessionId, sessions: sessionsList, messages: initialHistory });
    }

    if (typeof options.renderSessionMessages === 'function') {
      options.renderSessionMessages(options.getChatHistory ? options.getChatHistory() : (State?.getMessages?.() || initialHistory));
    }
    if (typeof options.renderSidebarChats === 'function') {
      options.renderSidebarChats();
    }
  }

  async function saveCurrentSession(options = {}) {
    const State = getState();
    const Storage = getStorage(options);
    const history = options.getChatHistory ? options.getChatHistory() : (State?.getMessages?.() || []);
    const currId = options.getCurrentSessionId ? options.getCurrentSessionId() : (State?.getActiveSessionId?.() || '');
    const sessionsList = options.getSavedSessions ? options.getSavedSessions() : (State?.getSavedSessions?.() || []);

    const hasRealUserMessages = Array.isArray(history) && history.some(m => {
      if (!m || m.role !== 'user') return false;
      return !isDateTimeInitialTurn(m);
    });

    if (!hasRealUserMessages) {
      if (State?.removeSession) {
        State.removeSession(currId);
      }
      if (Storage?.deleteConversation) {
        await Storage.deleteConversation(currId);
      }
      if (typeof options.renderSidebarChats === 'function') {
        options.renderSidebarChats();
      }
      return;
    }

    let sess = sessionsList.find(s => s.id === currId);
    const now = Date.now();
    if (!sess) {
      sess = {
        id: currId,
        title: t('chat_untitled') || 'Nueva conversación',
        createdAt: now,
        updatedAt: now,
        messageCount: history.length
      };
    } else {
      sess = Object.assign({}, sess, {
        updatedAt: now,
        messageCount: history.length
      });
    }

    const isUntitled = !sess.title ||
      sess.title === t('chat_untitled') ||
      sess.title === 'Nueva conversación' ||
      sess.title === 'New conversation';

    if (isUntitled && history.length > 1) {
      const firstRealUser = history.find(m => m.role === 'user' && !isDateTimeInitialTurn(m));
      if (firstRealUser && firstRealUser.content) {
        const rawContent = typeof firstRealUser.content === 'string' ? firstRealUser.content : (firstRealUser.content[0]?.text || '');
        const candidate = rawContent.split('\n')[0].replace(/[#*`_>\[\]]/g, '').trim();
        if (candidate) {
          sess.title = candidate.length > 35 ? candidate.substring(0, 32) + '…' : candidate;
        }
      }
    }

    if (State?.saveSessionMetadata) {
      State.saveSessionMetadata(sess);
    }
    if (Storage?.saveConversation) {
      await Storage.saveConversation(sess, history);
    }

    if (typeof options.renderSidebarChats === 'function') {
      options.renderSidebarChats();
    }
  }

  async function switchToSession(sessionId, options = {}) {
    const { force = false, saveCurrent = true } = options;
    const State = getState();
    const Storage = getStorage(options);
    const Engine = getEngine();
    const Config = getConfig();
    const currId = options.getCurrentSessionId ? options.getCurrentSessionId() : (State?.getActiveSessionId?.() || '');

    if (!force && sessionId === currId) return;
    if (blockSessionTransitionIfBusy('chat_switch_blocked_generating')) return false;
    if (saveCurrent) await saveCurrentSession(options);

    let targetConv = null;
    if (Storage?.getConversation) {
      targetConv = await Storage.getConversation(sessionId);
    }

    const sessionsList = options.getSavedSessions ? options.getSavedSessions() : (State?.getSavedSessions?.() || []);
    if (!targetConv) {
      const found = sessionsList.find(s => s.id === sessionId);
      if (found && found.history) targetConv = found;
    }

    if (!targetConv) return;

    const runtimeConfig = options.getRuntimeConfig ? options.getRuntimeConfig() : (Config?.getActive?.() || {});
    const sysPrompt = typeof options.getConfiguredSystemPrompt === 'function'
      ? options.getConfiguredSystemPrompt(runtimeConfig)
      : (runtimeConfig.systemPrompt || '');

    const restoredHistory = targetConv.history && targetConv.history.length > 0 ? [...targetConv.history] : [
      { id: 'system_root', role: 'system', content: sysPrompt }
    ];

    const lang = options.language || runtimeConfig.language || 'es';
    if (Engine?.ensureConversationDate) {
      Engine.ensureConversationDate(restoredHistory, lang, targetConv.createdAt);
    }

    if (!initializeSessionState(targetConv.id, restoredHistory, 'chat_switch_blocked_generating', options)) return false;
    if (typeof options.renderSessionMessages === 'function') {
      options.renderSessionMessages(options.getChatHistory ? options.getChatHistory() : (State?.getMessages?.() || []));
    }
    if (typeof options.renderSidebarChats === 'function') {
      options.renderSidebarChats();
    }

    if (typeof window !== 'undefined' && window.innerWidth < 900 && typeof options.closeSidebar === 'function') {
      options.closeSidebar();
    }
    return true;
  }

  async function createNewSession(options = {}) {
    const { saveCurrent = true } = options;
    if (blockSessionTransitionIfBusy('chat_new_blocked_generating')) return false;

    if (saveCurrent) await saveCurrentSession(options);

    const nextSessionId = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? 'session_' + crypto.randomUUID()
      : 'session_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);

    const nextHistory = createInitialChatHistory(options);
    if (!initializeSessionState(nextSessionId, nextHistory, 'chat_new_blocked_generating', options)) return false;

    const State = getState();
    if (typeof options.renderSessionMessages === 'function') {
      options.renderSessionMessages(options.getChatHistory ? options.getChatHistory() : (State?.getMessages?.() || []));
    }
    if (typeof options.renderSidebarChats === 'function') {
      options.renderSidebarChats();
    }

    if (typeof options.resetComposerInput === 'function') {
      options.resetComposerInput();
    }

    if (typeof window !== 'undefined' && window.innerWidth < 900 && typeof options.closeSidebar === 'function') {
      options.closeSidebar();
    }
    return true;
  }

  function getBranchBoundaryIndex(wrapper, history) {
    if (!wrapper || !Array.isArray(history)) return -1;
    const messageIds = new Set((wrapper.getAttribute?.('data-msg-ids') || '').split(',').filter(Boolean));
    const messageId = wrapper.getAttribute?.('data-msg-id');
    const baseId = wrapper.getAttribute?.('data-base-id');
    if (messageId) messageIds.add(messageId);
    if (baseId) messageIds.add(baseId);

    let boundary = -1;
    history.forEach((message, index) => {
      if (!message || !message.id) return;
      const messageBaseId = extractBaseId(message.id);
      if (messageIds.has(message.id) || (messageBaseId && messageIds.has(messageBaseId))) {
        boundary = index;
      }
    });
    return boundary;
  }

  function setAssistantGroupMessageIds(wrapper, history) {
    if (!wrapper || !Array.isArray(history)) return;
    let lastUserIndex = -1;
    for (let index = history.length - 1; index >= 0; index--) {
      if (history[index]?.role === 'user') {
        lastUserIndex = index;
        break;
      }
    }
    const ids = history.slice(lastUserIndex + 1).map(message => message?.id).filter(Boolean);
    if (ids.length > 0) wrapper.setAttribute('data-msg-ids', ids.join(','));
  }

  function cloneBranchHistory(history, boundary, sessionId) {
    const Utils = getUtils();
    const sourceHistory = history.slice(0, boundary + 1);
    const clonedHistory = Utils?.clone ? Utils.clone(sourceHistory) : JSON.parse(JSON.stringify(sourceHistory));
    return clonedHistory.map((message, index) => Object.assign({}, message, {
      id: `msg_${sessionId}_${index}`
    }));
  }

  function shouldOfferBranchSummary(history, boundary) {
    if (!Array.isArray(history) || boundary < 0) return false;
    const subHistory = history.slice(0, boundary + 1);
    const nonSystem = subHistory.filter(m => m && m.role !== 'system');
    const userMessages = nonSystem.filter(m => m.role === 'user');
    return userMessages.length >= 2 || nonSystem.length >= 4;
  }

  function createBranchHistoryWithSummary(compactedMessages, anchorMessage, sessionId) {
    const Utils = getUtils();
    const clonedCompacted = Utils?.clone ? Utils.clone(compactedMessages) : JSON.parse(JSON.stringify(compactedMessages));
    const clonedAnchor = Utils?.clone ? Utils.clone(anchorMessage) : JSON.parse(JSON.stringify(anchorMessage));
    const result = clonedCompacted.map((message, index) => Object.assign({}, message, {
      id: `msg_${sessionId}_${index}`
    }));
    if (clonedAnchor) {
      result.push(Object.assign({}, clonedAnchor, {
        id: `msg_${sessionId}_${result.length}`
      }));
    }
    return result;
  }

  /** API key del perfil activo; pide la contraseña si está cifrada. Los fallos se propagan. */
  async function resolveActiveApiKey(runtimeConfig) {
    const Profiles = resolveDep('ChatProfileRepository', './profile-repository.js');
    const profileId = runtimeConfig?.activeProfile?.id;
    if (!profileId || !Profiles?.load) return '';
    const activeProfile = await resolveDep('ChatProfileBackup', './profile-backup.js').withPassword(
      keyMaterial => Profiles.load(profileId, keyMaterial),
      () => getDialogs()?.prompt(t('crypto_current_password_prompt'), '', {
        inputType: 'password', title: t('crypto_password_title')
      })
    );
    return activeProfile?.settings?.apiKey || '';
  }

  async function defaultSummarizeHistory(params, options = {}) {
    const runtimeConfig = options.getRuntimeConfig ? options.getRuntimeConfig() : (getConfig()?.getActive?.() || {});
    const summarize = getEngine().createHistorySummarizer({
      apiUrl: runtimeConfig.apiUrl,
      apiType: runtimeConfig.apiType,
      apiKey: await resolveActiveApiKey(runtimeConfig),
      model: runtimeConfig.model,
      signal: params.signal
    });
    return await summarize(params);
  }

  /** Historial de la rama con el contexto previo resumido; null si no se pudo resumir. */
  async function summarizeBranchHistory(history, boundary, sessionId, signal, options = {}) {
    const ContextManager = resolveDep('ChatContextManager', './context-manager.js');
    const summarizeHistory = typeof options.summarizeHistory === 'function'
      ? options.summarizeHistory
      : (params => defaultSummarizeHistory(params, options));
    const runtimeConfig = options.getRuntimeConfig ? options.getRuntimeConfig() : (getConfig()?.getActive?.() || {});
    const compacted = await ContextManager.compressHistory({
      messages: history.slice(0, boundary + 1),
      summarizeFn: params => summarizeHistory({ ...params, signal }),
      options: {
        model: runtimeConfig.model,
        totalContextLimit: runtimeConfig.modelContextLimit || runtimeConfig.contextLimitOverride
      }
    });
    return compacted?.compressed && Array.isArray(compacted.messages)
      ? createBranchHistoryWithSummary(compacted.messages, history[boundary], sessionId)
      : null;
  }

  async function createConversationBranch(wrapper, options = {}) {
    if (blockSessionTransitionIfBusy('chat_new_blocked_generating')) return false;
    if (wrapper?.querySelector && wrapper.querySelector('.btn-branch-conversation.is-loading')) return false;

    const State = getState();
    const Storage = getStorage(options);
    const history = options.getChatHistory ? options.getChatHistory() : (State?.getMessages?.() || []);
    const boundary = getBranchBoundaryIndex(wrapper, history);
    if (boundary < 0) return false;

    await saveCurrentSession(options);
    if (blockSessionTransitionIfBusy('chat_new_blocked_generating')) return false;

    let summarize = false;
    if (typeof options.summarize === 'boolean') {
      summarize = options.summarize;
    } else if (options.askConfirmation !== false && shouldOfferBranchSummary(history, boundary)) {
      const Dialogs = getDialogs();
      if (Dialogs?.confirm) {
        const decision = await Dialogs.confirm(
          t('chat_branch_dialog_message'),
          {
            title: t('chat_branch_dialog_title'),
            acceptText: t('chat_branch_dialog_accept'),
            cancelText: t('notice_cancel'),
            checkbox: t('chat_branch_dialog_checkbox'),
            checkboxDefault: true
          }
        );
        if (!decision || (typeof decision === 'object' && !decision.accepted)) {
          return false;
        }
        summarize = typeof decision === 'object' ? Boolean(decision.checkboxChecked) : false;
      }
    }

    if (blockSessionTransitionIfBusy('chat_new_blocked_generating')) return false;

    const parentSessionId = options.getCurrentSessionId ? options.getCurrentSessionId() : (State?.getActiveSessionId?.() || '');
    const sessionsList = options.getSavedSessions ? options.getSavedSessions() : (State?.getSavedSessions?.() || []);
    const parentSession = sessionsList.find(session => session.id === parentSessionId);
    const parentTitle = parentSession?.title || t('chat_untitled');
    const branchSessionId = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? 'session_' + crypto.randomUUID()
      : 'session_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);

    let branchHistory = null;
    if (summarize) {
      const UIConv = options.uiConversation || resolveDep('ChatUIConversation', './ui-conversation.js');
      UIConv?.showBranchLoadingIndicator?.(wrapper, t('chat_branch_summarizing'));
      let cancelled = false;
      try {
        // Mientras se resume, la conversación cuenta como ocupada y el botón de parar la cancela.
        branchHistory = await getGenerationController().runCancellableTask(async signal => {
          State?.setGenerationStatus?.({ phase: 'custom', text: t('chat_branch_summarizing') });
          const summarized = await summarizeBranchHistory(history, boundary, branchSessionId, signal, options);
          cancelled = signal.aborted;
          return summarized;
        });
      } catch (err) {
        console.warn('[ZeroChat] Error al generar resumen para rama:', err);
      } finally {
        State?.clearGenerationStatus?.();
        UIConv?.hideBranchLoadingIndicator?.(wrapper);
      }

      if (cancelled) return false;
      if (blockSessionTransitionIfBusy('chat_new_blocked_generating')) return false;

      if (!branchHistory) {
        const Dialogs = getDialogs();
        const fallback = Dialogs?.confirm
          ? await Dialogs.confirm(t('chat_branch_summary_failed'), {
              title: t('chat_branch_dialog_title'),
              acceptText: t('chat_branch_dialog_accept'),
              cancelText: t('notice_cancel')
            })
          : true;
        const accepted = typeof fallback === 'object' ? Boolean(fallback.accepted) : Boolean(fallback);
        if (!accepted) {
          return false;
        }
        summarize = false;
        branchHistory = cloneBranchHistory(history, boundary, branchSessionId);
      }
    } else {
      branchHistory = cloneBranchHistory(history, boundary, branchSessionId);
    }

    const now = Date.now();
    const branchSession = {
      id: branchSessionId,
      title: t('chat_branch_title', { title: parentTitle }),
      createdAt: now,
      updatedAt: now,
      messageCount: branchHistory.length,
      metadata: {
        parentSessionId,
        branchedFromMessageIds: (wrapper?.getAttribute?.('data-msg-ids') || '').split(',').filter(Boolean),
        isSummarizedBranch: Boolean(summarize)
      }
    };

    const Dialogs = getDialogs();
    if (!Storage?.saveConversation || !await Storage.saveConversation(branchSession, branchHistory)) {
      if (Dialogs?.alert) Dialogs.alert(t('chat_branch_error'), { type: 'error' });
      return false;
    }
    if (!initializeSessionState(branchSessionId, branchHistory, 'chat_new_blocked_generating', options)) {
      await Storage?.deleteConversation?.(branchSessionId);
      return false;
    }
    if (State?.saveSessionMetadata) State.saveSessionMetadata(branchSession);
    if (typeof options.renderSessionMessages === 'function') {
      options.renderSessionMessages(options.getChatHistory ? options.getChatHistory() : (State?.getMessages?.() || []));
    }
    if (typeof options.renderSidebarChats === 'function') {
      options.renderSidebarChats();
    }

    if (typeof options.resetComposerInput === 'function') {
      options.resetComposerInput();
    }
    if (typeof window !== 'undefined' && window.innerWidth < 900 && typeof options.closeSidebar === 'function') {
      options.closeSidebar();
    }
    return true;
  }

  async function deleteSession(sessionId, event, options = {}) {
    if (event && event.stopPropagation) event.stopPropagation();
    const Dialogs = getDialogs();
    if (Dialogs?.confirm && !await Dialogs.confirm(t('chat_delete_confirm'))) return;
    if (blockSessionTransitionIfBusy('chat_delete_blocked_generating')) return;

    const State = getState();
    const Storage = getStorage(options);
    const currId = options.getCurrentSessionId ? options.getCurrentSessionId() : (State?.getActiveSessionId?.() || '');

    if (State?.removeSession) {
      const res = State.removeSession(sessionId);
      if (!res.ok && res.reason === 'generation-active') {
        if (Dialogs?.alert) Dialogs.alert(t('chat_delete_blocked_generating'));
        return;
      }
    }

    if (Storage?.deleteConversation) {
      await Storage.deleteConversation(sessionId);
    }

    const remainingSessions = options.getSavedSessions ? options.getSavedSessions() : (State?.getSavedSessions?.() || []);
    if (remainingSessions.length === 0) {
      await createNewSession({ ...options, saveCurrent: false });
    } else if (currId === sessionId) {
      const next = remainingSessions[0];
      await switchToSession(next.id, { ...options, force: true, saveCurrent: false });
    } else {
      if (typeof options.renderSidebarChats === 'function') {
        options.renderSidebarChats();
      }
    }
  }

  async function deleteAllSessions(options = {}) {
    const State = getState();
    const Storage = getStorage(options);
    const Dialogs = getDialogs();
    const sessionsList = options.getSavedSessions ? options.getSavedSessions() : (State?.getSavedSessions?.() || []);
    if (!sessionsList || sessionsList.length === 0) return;
    if (blockSessionTransitionIfBusy('chat_delete_blocked_generating')) return;
    if (Dialogs?.confirm && !await Dialogs.confirm(t('chat_delete_all_confirm'))) return;
    if (blockSessionTransitionIfBusy('chat_delete_blocked_generating')) return;

    const deleted = Storage?.deleteAllConversations ? await Storage.deleteAllConversations() : true;
    if (!deleted) {
      if (Dialogs?.alert) Dialogs.alert(t('chat_delete_history_err'), { type: 'error' });
      return;
    }

    if (State?.set) {
      State.set('sessions', { activeId: null, list: [] });
    }

    await createNewSession({ ...options, saveCurrent: false });
  }

  async function renameSession(sessionId, event, options = {}) {
    if (event && event.stopPropagation) event.stopPropagation();
    const State = getState();
    const Storage = getStorage(options);
    const Dialogs = getDialogs();
    const sessionsList = options.getSavedSessions ? options.getSavedSessions() : (State?.getSavedSessions?.() || []);
    let sess = sessionsList.find(s => s.id === sessionId);
    if (!sess) return;

    const newTitle = Dialogs?.prompt ? await Dialogs.prompt(t('prompt_rename_conversation'), sess.title || '') : null;
    if (newTitle !== null && newTitle.trim() !== '') {
      sess = (options.getSavedSessions ? options.getSavedSessions() : (State?.getSavedSessions?.() || [])).find(s => s.id === sessionId);
      if (!sess) return;
      sess.title = newTitle.trim();
      sess.updatedAt = Date.now();
      if (State?.saveSessionMetadata) {
        State.saveSessionMetadata(sess);
      }
      if (Storage?.renameConversation) {
        await Storage.renameConversation(sessionId, sess.title);
      }
      if (typeof options.renderSidebarChats === 'function') {
        options.renderSidebarChats();
      }
    }
  }

  return {
    extractBaseId,
    isDateTimeInitialTurn,
    createInitialChatHistory,
    blockSessionTransitionIfBusy,
    initializeSessionState,
    loadSessionsFromStorage,
    saveCurrentSession,
    switchToSession,
    createNewSession,
    getBranchBoundaryIndex,
    setAssistantGroupMessageIds,
    cloneBranchHistory,
    shouldOfferBranchSummary,
    createBranchHistoryWithSummary,
    defaultSummarizeHistory,
    createConversationBranch,
    deleteSession,
    deleteAllSessions,
    renameSession
  };
}));
