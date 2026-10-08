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

  function formatHistoryTranscript(messages = []) {
    const lines = [];
    (messages || []).forEach(m => {
      if (!m) return;
      if (m._isSummaryBlock) {
        lines.push(`[Previous Checkpoint Summary]:\n${m.content}`);
      } else if (m.role === 'user') {
        let text = '';
        if (typeof m.content === 'string') {
          text = m.content;
        } else if (Array.isArray(m.content)) {
          text = m.content.map(part => (part && part.text) ? part.text : '').filter(Boolean).join(' ');
        }
        if (text) lines.push(`User: ${text}`);
      } else if (m.role === 'assistant') {
        const text = typeof m.content === 'string' ? m.content : '';
        if (text) {
          lines.push(`Assistant: ${text}`);
        } else if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
          const names = m.tool_calls.map(tc => tc.function?.name || 'tool').join(', ');
          lines.push(`Assistant: [Used tools: ${names}]`);
        }
      } else if (m.role === 'tool') {
        const name = m.name || 'tool';
        const raw = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
        const snippet = raw.length > 500 ? raw.slice(0, 500) + '...' : raw;
        lines.push(`Tool (${name}): ${snippet}`);
      }
    });
    return lines.join('\n\n');
  }

  async function resolveActiveApiKey(runtimeConfig, options = {}) {
    const Profiles = resolveDep('ChatProfileRepository', './profile-repository.js') || (typeof window !== 'undefined' ? window.ChatProfileRepository : null);
    const profileId = runtimeConfig?.activeProfile?.id;
    if (profileId && Profiles?.load) {
      try {
        const activeProfile = await Profiles.load(profileId);
        if (activeProfile?.settings?.apiKey) {
          return activeProfile.settings.apiKey;
        }
      } catch (err) {
        if (err?.code === 'PASSWORD_REQUIRED') {
          const Dialogs = getDialogs();
          const Backup = resolveDep('ChatProfileBackup', './profile-backup.js');
          const password = await Dialogs?.prompt(t('crypto_current_password_prompt'), '', {
            inputType: 'password', title: t('crypto_password_title')
          });
          if (password && Backup?.keyMaterialFromPassword) {
            const keyMaterial = await Backup.keyMaterialFromPassword(password);
            const activeProfile = await Profiles.load(profileId, keyMaterial);
            Backup.cacheKeyMaterial?.(keyMaterial);
            if (activeProfile?.settings?.apiKey) {
              return activeProfile.settings.apiKey;
            }
          }
        }
      }
    }
    return runtimeConfig?.apiKey || '';
  }

  async function defaultSummarizeHistory({ systemPrompt, messages, signal }, options = {}) {
    const API = resolveDep('ChatAPI', './api.js');
    if (!API || typeof API.streamChatCompletion !== 'function') return '';
    const Config = getConfig();
    const runtimeConfig = options.getRuntimeConfig ? options.getRuntimeConfig() : (Config?.getActive?.() || {});
    const apiKey = await resolveActiveApiKey(runtimeConfig, options);
    const transcript = formatHistoryTranscript(messages);

    const response = await API.streamChatCompletion({
      apiUrl: runtimeConfig.apiUrl,
      apiType: runtimeConfig.apiType,
      apiKey,
      model: runtimeConfig.model,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `Here is the conversation history to consolidate into a checkpoint:\n\n<conversation_history>\n${transcript}\n</conversation_history>\n\nGenerate the replacement checkpoint now.`
        }
      ],
      temperature: 0,
      reasoningEffort: 'none',
      enableTools: false,
      toolChoice: 'none',
      signal
    });
    return response?.accumulatedText || '';
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
      if (UIConv?.showBranchLoadingIndicator) {
        UIConv.showBranchLoadingIndicator(wrapper, t('chat_branch_summarizing'));
      }
      if (State?.setGenerationStatus) {
        State.setGenerationStatus({ phase: 'custom', text: t('chat_branch_summarizing') });
      }
      try {
        const ContextManager = resolveDep('ChatContextManager', './context-manager.js');
        const summarizeFn = typeof options.summarizeHistory === 'function'
          ? options.summarizeHistory
          : ((params) => defaultSummarizeHistory(params, options));
        const sourceHistory = history.slice(0, boundary + 1);
        const runtimeConfig = options.getRuntimeConfig ? options.getRuntimeConfig() : (getConfig()?.getActive?.() || {});

        if (ContextManager && typeof ContextManager.compressHistory === 'function') {
          const compacted = await ContextManager.compressHistory({
            messages: sourceHistory,
            summarizeFn,
            options: {
              model: runtimeConfig.model,
              totalContextLimit: runtimeConfig.modelContextLimit || runtimeConfig.contextLimitOverride
            }
          });
          if (compacted && compacted.compressed && Array.isArray(compacted.messages)) {
            branchHistory = createBranchHistoryWithSummary(compacted.messages, history[boundary], branchSessionId);
          }
        }
      } catch (err) {
        console.warn('[ZeroChat] Error al generar resumen para rama:', err);
      } finally {
        if (State?.setGenerationStatus) {
          State.setGenerationStatus({ phase: 'idle' });
        }
        if (UIConv?.hideBranchLoadingIndicator) {
          UIConv.hideBranchLoadingIndicator(wrapper);
        }
      }

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
    formatHistoryTranscript,
    defaultSummarizeHistory,
    createConversationBranch,
    deleteSession,
    deleteAllSessions,
    renameSession
  };
}));
