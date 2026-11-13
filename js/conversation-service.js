/**
 * Servicio de Dominio para Gestión de Conversaciones y Sesiones de Chat (ZeroChat).
 * Coordina el ciclo de vida de las sesiones (crear, guardar, renombrar, borrar, cambiar de sesión,
 * bifurcar ramas / branching y persistir en State y Storage).
 *
 * Las opciones que recibe cada operación son los callbacks de app.js: los de presentación
 * (renderSessionMessages, renderSidebarChats, onSessionReset, onSessionSwitched, resetComposerInput
 * y closeMobileSidebar) y los que leen la interfaz (isServerMode, getServerProfile y getProject).
 * El servicio no toca el DOM.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./utils.js'), require('./i18n.js'), require('./message-turns.js'));
  } else {
    root.ChatConversationService = factory(root.ChatUtils, root.ChatI18n, root.ChatMessageTurns);
  }
}(typeof self !== 'undefined' ? self : this, function (Utils, I18n, MessageTurns) {
  'use strict';

  const { resolveDep, createId, clone, projectName } = Utils;
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

  async function blockSessionTransitionIfBusy(messageKey) {
    if (!getState().isConversationBusy()) return false;
    await getDialogs().alert(t(messageKey));
    return true;
  }

  async function activateConversation(sessionId, history, blockedMessageKey, options) {
    if (!getState().replaceConversation({ sessionId, messages: history }).ok) {
      await getDialogs().alert(t(blockedMessageKey));
      return false;
    }
    options.onSessionReset();
    return true;
  }

  /** Muestra la sesión activa tras cambiarla; en móvil cierra la barra lateral. */
  function showActiveSession(options, { resetComposer }) {
    options.renderSessionMessages(getHistory());
    options.renderSidebarChats();
    if (resetComposer) options.resetComposerInput();
    options.closeMobileSidebar();
  }

  async function loadSessionsFromStorage(options) {
    let sessions = [];
    try {
      sessions = await getStorage().getConversationsList();
    } catch (error) {
      console.warn('[ConversationService] Could not load saved conversations:', error);
      await getDialogs().alert(t('chat_storage_read_error'), { type: 'error' });
    }
    if (getHistory().length > 0) {
      getState().set('sessions', { activeId: getActiveSessionId(), list: sessions });
      options.renderSidebarChats();
      return;
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

  /**
   * Modo servidor y perfil de una sesión: los de `overrides` o, si no, los de la interfaz. En modo
   * servidor sin perfil elegido conserva el de `base` (la sesión guardada o la de origen de una rama).
   */
  function resolveSessionMode(options, base, overrides = {}) {
    const serverRun = overrides.serverRun !== undefined ? Boolean(overrides.serverRun) : options.isServerMode();
    const activeProfile = getConfig().getActive()?.activeProfile;
    const profileId = overrides.profileId || (serverRun
      ? options.getServerProfile() || base?.profileId || 'local'
      : activeProfile?.name || activeProfile?.id || base?.profileId || '');
    return { serverRun, profileId };
  }

  async function saveCurrentSession(options, overrides = {}) {
    const State = getState();
    const Storage = getStorage();
    const history = getHistory();
    const sessionId = getActiveSessionId();
    if (State.get('mcp').serverRuns.some(run => run.conversationId === sessionId && run.status === 'running')) {
      options.renderSidebarChats();
      return;
    }

    const existing = getSavedSessions().find(session => session.id === sessionId);
    if (!history.some(message => message.role === 'user')) {
      if (existing) {
        State.removeSession(sessionId);
        try {
          await Storage.deleteConversation(sessionId);
        } catch (error) {
          console.warn('[ConversationService] Could not delete empty conversation:', error);
        }
        options.renderSidebarChats();
      }
      return;
    }

    const now = Date.now();
    // El proyecto se fija al crear la conversación: la del directorio del servidor en ese momento.
    const project = existing ? '' : options.getProject();
    const session = {
      ...(existing || { id: sessionId, title: '', createdAt: now, ...(project ? { project } : {}) }),
      updatedAt: now,
      messageCount: history.length,
      ...resolveSessionMode(options, existing, overrides)
    };
    if (!session.title) session.title = deriveTitle(history) || t('chat_untitled');

    State.saveSessionMetadata(session);
    try {
      await Storage.saveConversation(session, history);
    } catch (error) {
      console.warn('[ConversationService] Could not save conversation:', error);
      await getDialogs().alert(t('chat_storage_save_error'), { type: 'error' });
    }
    options.renderSidebarChats();
  }

  async function switchToSession(sessionId, options) {
    const { force = false, saveCurrent = true } = options;
    if (!force && sessionId === getActiveSessionId()) return;
    if (await blockSessionTransitionIfBusy('chat_switch_blocked_generating')) return false;
    if (saveCurrent) await saveCurrentSession(options);

    let conversation = null;
    try {
      conversation = await getStorage().getConversation(sessionId);
    } catch (error) {
      console.warn('[ConversationService] Could not read conversation:', error);
      const notDownloaded = error?.code === getStorage().CONVERSATION_NOT_DOWNLOADED;
      await getDialogs().alert(t(notDownloaded ? 'chat_not_downloaded' : 'chat_storage_read_error'), { type: 'error' });
      return false;
    }
    if (!conversation) return;
    const history = conversation.history.length > 0 ? [...conversation.history] : createInitialChatHistory();
    getEngine().ensureConversationDate(history, conversation.createdAt);

    if (!await activateConversation(conversation.id, history, 'chat_switch_blocked_generating', options)) return false;
    // La cabecera leída se fusiona con la guardada en la lista.
    const { history: _history, ...header } = conversation;
    getState().saveSessionMetadata({ ...header, messageCount: history.length });
    showActiveSession(options, { resetComposer: false });
    options.onSessionSwitched(conversation);
    return true;
  }

  async function createNewSession(options) {
    const { saveCurrent = true } = options;
    if (await blockSessionTransitionIfBusy('chat_new_blocked_generating')) return false;
    if (saveCurrent) await saveCurrentSession(options);
    if (!await activateConversation(createId('session'), createInitialChatHistory(), 'chat_new_blocked_generating', options)) return false;
    showActiveSession(options, { resetComposer: true });
    return true;
  }

  /** Índice del último mensaje del historial que pertenece a la respuesta de anclaje. */
  function getBranchBoundaryIndex({ msgId, baseId, explicitIds }, history) {
    const messageIds = new Set([...explicitIds, msgId, baseId].filter(Boolean));
    let boundary = -1;
    history.forEach((message, index) => {
      if (messageIds.has(message.id) || messageIds.has(MessageTurns.extractBaseId(message.id))) boundary = index;
    });
    return boundary;
  }

  /** Copia profunda de los mensajes con identificadores propios de la sesión destino. */
  function renumberForSession(messages, sessionId) {
    return clone(messages).map((message, index) => ({ ...message, id: `msg_${sessionId}_${index}` }));
  }

  function cloneBranchHistory(history, boundary, sessionId) {
    return renumberForSession(MessageTurns.sanitizeTurnBoundaries(history.slice(0, boundary + 1)), sessionId);
  }

  function shouldOfferBranchSummary(history, boundary) {
    const dialogue = history.slice(0, boundary + 1).filter(message => message.role !== 'system');
    return dialogue.filter(message => message.role === 'user').length >= 2 || dialogue.length >= 4;
  }

  async function summarizeHistory(params) {
    const config = getConfig().getActive();
    const activeProfile = await resolveDep('ChatProfileRepository', './profile-repository.js').loadUnlocked(config.activeProfile?.id);
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
      ? renumberForSession(MessageTurns.sanitizeTurnBoundaries([...compacted.messages, history[boundary]]), sessionId)
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
   * completo; null si se cancela o la conversación quedó ocupada. `onSummarizing(active)` muestra
   * y retira el indicador de progreso en la respuesta de anclaje.
   */
  async function buildSummarizedBranchHistory(history, boundary, sessionId, onSummarizing) {
    const State = getState();
    onSummarizing(true);
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
      onSummarizing(false);
    }

    if (cancelled || await blockSessionTransitionIfBusy('chat_new_blocked_generating')) return null;
    if (summarized) return summarized;
    const useFullHistory = await getDialogs().confirm(t('chat_branch_summary_failed'), {
      title: t('chat_branch_dialog_title'),
      acceptText: t('chat_branch_dialog_accept'),
      cancelText: t('notice_cancel')
    });
    return useFullHistory ? cloneBranchHistory(history, boundary, sessionId) : null;
  }

  /**
   * Crea una rama de la conversación hasta la respuesta `anchor` ({ msgId, baseId, explicitIds },
   * de ChatUIConversation.getMessageRef). `options.onSummarizing` pinta el progreso del resumen.
   */
  async function createConversationBranch(anchor, options) {
    if (await blockSessionTransitionIfBusy('chat_new_blocked_generating')) return false;

    const history = getHistory();
    const boundary = getBranchBoundaryIndex(anchor, history);
    if (boundary < 0) return false;

    await saveCurrentSession(options);
    if (await blockSessionTransitionIfBusy('chat_new_blocked_generating')) return false;

    const mode = await askBranchMode(history, boundary);
    if (!mode || await blockSessionTransitionIfBusy('chat_new_blocked_generating')) return false;

    const parentSession = getSavedSessions().find(session => session.id === getActiveSessionId());
    const branchSessionId = createId('session');
    const branchHistory = mode.summarize
      ? await buildSummarizedBranchHistory(history, boundary, branchSessionId, options.onSummarizing)
      : cloneBranchHistory(history, boundary, branchSessionId);
    if (!branchHistory) return false;

    const now = Date.now();
    const branchSession = {
      id: branchSessionId,
      title: t('chat_branch_title', { title: parentSession?.title || t('chat_untitled') }),
      createdAt: now,
      updatedAt: now,
      messageCount: branchHistory.length,
      ...resolveSessionMode(options, parentSession),
      // La rama es del mismo proyecto que la conversación de la que sale.
      ...(parentSession?.project ? { project: parentSession.project } : {})
    };

    const Storage = getStorage();
    try {
      await Storage.saveConversation(branchSession, branchHistory);
    } catch (error) {
      console.warn('[ConversationService] Could not save branch conversation:', error);
      await getDialogs().alert(t('chat_branch_error'), { type: 'error' });
      return false;
    }
    if (!await activateConversation(branchSessionId, branchHistory, 'chat_new_blocked_generating', options)) {
      try {
        await Storage.deleteConversation(branchSessionId);
      } catch (_) { /* intento de limpieza */ }
      return false;
    }
    getState().saveSessionMetadata(branchSession);
    showActiveSession(options, { resetComposer: true });
    options.onSessionSwitched(branchSession);
    return true;
  }

  async function deleteSession(sessionId, options) {
    if (!await getDialogs().confirm(t('chat_delete_confirm'))) return;
    if (await blockSessionTransitionIfBusy('chat_delete_blocked_generating')) return;

    const activeId = getActiveSessionId();
    if (!getState().removeSession(sessionId).ok) {
      await getDialogs().alert(t('chat_delete_blocked_generating'));
      return;
    }
    try {
      await getStorage().deleteConversation(sessionId);
    } catch (error) {
      console.warn('[ConversationService] Could not delete conversation:', error);
      await getDialogs().alert(t('chat_delete_history_err'), { type: 'error' });
      return;
    }

    const remaining = getSavedSessions();
    if (remaining.length === 0) {
      await createNewSession({ ...options, saveCurrent: false });
    } else if (activeId === sessionId) {
      await switchToSession(remaining[0].id, { ...options, force: true, saveCurrent: false });
    } else {
      options.renderSidebarChats();
    }
  }

  /**
   * Borra el historial. Con un proyecto abierto que tiene conversaciones pregunta por las suyas, con
   * una casilla para borrar todas; sin proyecto, pregunta por todas.
   */
  async function deleteAllSessions(options) {
    const sessions = getSavedSessions();
    if (sessions.length === 0) return;
    if (await blockSessionTransitionIfBusy('chat_delete_blocked_generating')) return;
    const project = options.getProject();
    const projectCount = project ? sessions.filter(session => session.project === project).length : 0;
    let deleteAll = true;
    if (projectCount > 0) {
      const answer = await getDialogs().confirm(t('chat_delete_project_confirm', { name: projectName(project), count: projectCount }), { checkbox: t('chat_delete_all_checkbox') });
      if (!answer.accepted) return;
      deleteAll = answer.checkboxChecked;
    } else if (!await getDialogs().confirm(t('chat_delete_all_confirm'))) {
      return;
    }
    if (await blockSessionTransitionIfBusy('chat_delete_blocked_generating')) return;

    try {
      if (deleteAll) await getStorage().deleteAllConversations();
      else await getStorage().deleteProjectConversations(project);
    } catch (error) {
      console.warn('[ConversationService] Could not delete conversations:', error);
      await getDialogs().alert(t('chat_delete_history_err'), { type: 'error' });
      return;
    }
    const activeId = getActiveSessionId();
    const list = deleteAll ? [] : getSavedSessions().filter(session => session.project !== project);
    const keepActive = list.some(session => session.id === activeId);
    getState().set('sessions', { activeId: keepActive ? activeId : null, list });
    if (keepActive) options.renderSidebarChats();
    else await createNewSession({ ...options, saveCurrent: false });
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
    try {
      await getStorage().renameConversation(sessionId, newTitle);
    } catch (error) {
      console.warn('[ConversationService] Could not rename conversation:', error);
      await getDialogs().alert(t('chat_storage_save_error'), { type: 'error' });
    }
    options.renderSidebarChats();
  }

  return {
    blockSessionTransitionIfBusy,
    loadSessionsFromStorage,
    saveCurrentSession,
    switchToSession,
    createNewSession,
    createConversationBranch,
    deleteSession,
    deleteAllSessions,
    renameSession
  };
}));
