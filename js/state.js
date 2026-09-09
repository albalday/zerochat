/**
 * Módulo de Gestión del Estado Global (ChatState) para ZeroChat.
 * Implementa un Store reactivo, desacoplado, predecible y con una única fuente de verdad,
 * sin dependencias de frameworks externos.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.ChatState = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function clone(obj) {
    if (obj === null || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(clone);
    const copy = {};
    for (const key of Object.keys(obj)) {
      copy[key] = clone(obj[key]);
    }
    return copy;
  }

  function isShallowEqual(a, b) {
    if (Object.is(a, b)) return true;
    if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false;
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    for (let i = 0; i < keysA.length; i++) {
      const k = keysA[i];
      if (!Object.prototype.hasOwnProperty.call(b, k) || !Object.is(a[k], b[k])) {
        return false;
      }
    }
    return true;
  }

  const CANONICAL_SLICES = Object.freeze([
    'config',
    'sessions',
    'messages',
    'streaming',
    'agent',
    'telemetry',
    'ui',
    'mcp',
    'toolSecurity'
  ]);

  function createInitialState(overrides = {}) {
    const DEFAULT_SYSTEM_DATA_PROMPT = '[Format: Always use standard Markdown and plain text. Never use LaTeX syntax or delimiters ($ or $$); write mathematics, formulas, and numbers directly in readable text using standard symbols (+, -, ×, /, =).]';
    const defaultState = {
      // 1. Configuración de la Aplicación y Preferencias
      config: {
        schemaVersion: 2,
        activeProfile: null,
        apiUrl: 'http://localhost:1234/v1',
        apiType: 'openai',
        apiKey: '',
        model: '',
        systemPrompt: '',
        systemDataPrompt: DEFAULT_SYSTEM_DATA_PROMPT,
        temperature: '0.7',
        reasoningEffort: 'none',
        maxAgentTurns: 15,
        theme: 'light',
        language: 'es',
        enabledTools: {
          execute_javascript: true,
          search_web: true,
          fetch_web_page: true,
          download_pdf: true,
          render_chart: true,
          agent_checkpoint: false
        },
        enableRawLogs: false,
        enableDebugMessages: false,
        enableContextCache: true,
        activeRagBranchId: '',
        activeRagBranchIds: [],
        modelReasoningConfig: null,
        mcpHost: '127.0.0.1',
        mcpPort: 6388
      },

      // 2. Sesiones y Conversación Activa
      sessions: {
        activeId: typeof crypto !== 'undefined' && crypto.randomUUID ? ('session_' + crypto.randomUUID()) : ('session_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7)),
        list: []
      },

      // 3. Historial de Mensajes de la Sesión Activa
      messages: [],

      // 4. Estado de Generación / Streaming
      streaming: {
        isGenerating: false,
        stats: null,
        status: 'idle', // 'idle' | 'streaming' | 'thinking' | 'done' | 'error'
        error: null
      },

      // 5. Estado Agéntico y Herramientas
      agent: {
        activeTurnIndex: 0,
        currentTool: null,
        loopWarning: false,
        ragSystemContext: ''
      },

      // 6. Telemetría de Contexto y Tokens
      telemetry: {
        stats: null,
        diagnostics: null,
        lastTurnStats: null
      },

      // 7. Estado de la Interfaz (UI)
      ui: {
        notices: [],
        noticeSequence: 0,
        noticeResult: null,
        sidebarOpen: false,
        reasoningMenuOpen: false,
        debugPanelOpen: false,
        activeModal: null, // null | 'settings' | 'export' | 'debug_interceptor'
        attachedFiles: []
      },

      // 8. Estado de Integración MCP (mcp-proxy)
      mcp: {
        status: 'disconnected', // 'disconnected' | 'connecting' | 'connected' | 'error'
        host: '127.0.0.1',
        port: 6388,
        endpoint: 'http://127.0.0.1:6388/sse',
        serverInfo: null,
        tools: [],
        lastConnected: null,
        latencyMs: null,
        error: null
      },

      // 9. Políticas de Seguridad de Herramientas (MCP y Built-in)
      toolSecurity: {
        globalMcpPolicy: 'ask',
        authorizedCount: 0,
        tools: {}
      }
    };

    if (overrides && typeof overrides === 'object') {
      for (const k of Object.keys(overrides)) {
        if (!CANONICAL_SLICES.includes(k)) {
          throw new Error(`[ChatState] Slice no canónico en overrides: "${k}". Slices permitidos: ${CANONICAL_SLICES.join(', ')}`);
        }
        if (typeof overrides[k] === 'object' && overrides[k] !== null && !Array.isArray(overrides[k])) {
          defaultState[k] = Object.assign({}, defaultState[k], overrides[k]);
        } else {
          defaultState[k] = overrides[k];
        }
      }
    }

    return defaultState;
  }

  function createStore(initialConfigOverrides = {}) {
    let state = createInitialState(initialConfigOverrides);
    const listeners = new Set();
    let isEmitting = false;

    function validateSliceKey(key) {
      if (!CANONICAL_SLICES.includes(key)) {
        throw new Error(`[ChatState] Intento de escritura en slice no canónico: "${key}". Slices permitidos: ${CANONICAL_SLICES.join(', ')}`);
      }
    }

    /**
     * Retorna una instantánea inmutable/clonada del estado global completo.
     */
    function getState() {
      return clone(state);
    }

    /**
     * Retorna una instantánea clonada de una sección específica del estado.
     */
    function get(sliceKey) {
      if (typeof sliceKey !== 'string' || !(sliceKey in state)) {
        return undefined;
      }
      return clone(state[sliceKey]);
    }

    /**
     * Actualiza el estado global de forma atómica y notifica a los suscriptores si hubo cambios reales.
     * Admite un objeto parcial o una función updater `(prevState) => partialState`.
     */
    function setState(partialOrUpdater) {
      const prevState = state;
      const updates = typeof partialOrUpdater === 'function' ? partialOrUpdater(clone(state)) : partialOrUpdater;

      if (!updates || typeof updates !== 'object') {
        return getState();
      }

      let hasChanged = false;
      const nextState = Object.assign({}, state);

      for (const key of Object.keys(updates)) {
        validateSliceKey(key);
        const prevVal = state[key];
        const nextVal = updates[key];

        // Fusión limpia para slices de tipo objeto
        if (
          typeof prevVal === 'object' && prevVal !== null && !Array.isArray(prevVal) &&
          typeof nextVal === 'object' && nextVal !== null && !Array.isArray(nextVal)
        ) {
          const mergedSlice = Object.assign({}, prevVal, nextVal);
          if (!isShallowEqual(prevVal, mergedSlice)) {
            nextState[key] = mergedSlice;
            hasChanged = true;
          }
        } else if (!isShallowEqual(prevVal, nextVal)) {
          nextState[key] = clone(nextVal);
          hasChanged = true;
        }
      }

      if (hasChanged) {
        state = nextState;
        notifyListeners(state, prevState);
      }

      return getState();
    }

    /**
     * Actualiza una sección/slice específica del estado.
     * Ejemplo: `store.set('streaming', { isGenerating: true })`
     */
    function set(sliceKey, update) {
      if (typeof sliceKey !== 'string') return getState();
      validateSliceKey(sliceKey);

      const prevSlice = state[sliceKey];
      let nextSlice;

      if (typeof update === 'function') {
        nextSlice = update(clone(prevSlice));
      } else if (
        typeof prevSlice === 'object' && prevSlice !== null && !Array.isArray(prevSlice) &&
        typeof update === 'object' && update !== null && !Array.isArray(update)
      ) {
        nextSlice = Object.assign({}, prevSlice, update);
      } else {
        nextSlice = update;
      }

      return setState({ [sliceKey]: nextSlice });
    }

    /**
     * Suscribe un listener a cambios del estado.
     * Puede suscribirse a todo el estado, a una clave slice, o a un selector derivado.
     * Retorna una función unsubscribe para cancelar la suscripción.
     *
     * Ejemplos:
     * - `subscribe((newState, prevState) => { ... })`
     * - `subscribe('config', (newConfig, prevConfig) => { ... })`
     * - `subscribe(state => state.streaming.isGenerating, (isGenerating, prevVal) => { ... })`
     */
    function subscribe(selectorOrListener, optionalListener) {
      let listenerEntry;

      if (typeof selectorOrListener === 'function' && typeof optionalListener === 'function') {
        // Modo selector: (state) => selector(state), callback: (selected, prevSelected)
        const selector = selectorOrListener;
        const callback = optionalListener;
        let lastSelectedValue = selector(clone(state));

        listenerEntry = (nextState) => {
          const currentSelectedValue = selector(nextState);
          if (!isShallowEqual(lastSelectedValue, currentSelectedValue)) {
            const prev = lastSelectedValue;
            lastSelectedValue = currentSelectedValue;
            callback(currentSelectedValue, prev);
          }
        };
      } else if (typeof selectorOrListener === 'string' && typeof optionalListener === 'function') {
        // Modo clave de slice: 'streaming', callback: (newStreaming, prevStreaming)
        const sliceKey = selectorOrListener;
        const callback = optionalListener;
        let lastSliceValue = state[sliceKey];

        listenerEntry = (nextState) => {
          const currentSliceValue = nextState[sliceKey];
          if (!isShallowEqual(lastSliceValue, currentSliceValue)) {
            const prev = lastSliceValue;
            lastSliceValue = currentSliceValue;
            callback(clone(currentSliceValue), clone(prev));
          }
        };
      } else if (typeof selectorOrListener === 'function') {
        // Modo listener global: callback(newState, prevState)
        listenerEntry = selectorOrListener;
      } else {
        throw new Error('ChatState.subscribe: Argumentos inválidos');
      }

      listeners.add(listenerEntry);

      return function unsubscribe() {
        listeners.delete(listenerEntry);
      };
    }

    function notifyListeners(nextState, prevState) {
      if (isEmitting) return;
      isEmitting = true;
      try {
        const nextSnapshot = clone(nextState);
        const prevSnapshot = clone(prevState);
        listeners.forEach(fn => {
          try {
            fn(nextSnapshot, prevSnapshot);
          } catch (e) {
            console.error('ChatState listener error:', e);
          }
        });
      } finally {
        isEmitting = false;
      }
    }

    /**
     * Reinicia el estado a los valores por defecto.
     */
    function reset(overrides = {}) {
      const prevState = state;
      state = createInitialState(overrides);
      notifyListeners(state, prevState);
      return getState();
    }

    function isConversationBusy() {
      return Boolean(state.streaming && state.streaming.isGenerating);
    }

    /**
     * Inicializa una conversación nueva sin alterar configuración ni conexiones.
     * Se deniega durante una inferencia para evitar que callbacks pendientes
     * escriban sobre la sesión nueva.
     */
    function initializeConversation({ sessionId, sessions = [], messages = [] } = {}) {
      if (isConversationBusy()) return { ok: false, reason: 'generation-active' };
      if (typeof sessionId !== 'string' || !sessionId.trim()) return { ok: false, reason: 'invalid-session-id' };
      if (!Array.isArray(sessions) || !Array.isArray(messages)) return { ok: false, reason: 'invalid-conversation-state' };

      setState({
        sessions: { activeId: sessionId, list: clone(sessions) },
        messages: clone(messages),
        streaming: { isGenerating: false, stats: null, status: 'idle', error: null },
        agent: { activeTurnIndex: 0, currentTool: null, loopWarning: false, ragSystemContext: '' },
        telemetry: { stats: null, diagnostics: null, lastTurnStats: null },
        ui: Object.assign({}, state.ui, { reasoningMenuOpen: false, debugPanelOpen: false, activeModal: null, attachedFiles: [], notices: [] })
      });

      return { ok: true, state: getState() };
    }

    /**
     * Reemplaza o conmuta la conversación activa de forma atómica y segura.
     * Acepta { sessionId, messages, sessions } o argumentos posicionales (sessionId, messages, sessions).
     */
    function replaceConversation(firstArg, optionalMessages, optionalSessions) {
      let sessionId, messages, sessions;
      if (firstArg && typeof firstArg === 'object' && !Array.isArray(firstArg)) {
        sessionId = firstArg.sessionId;
        messages = firstArg.messages;
        sessions = firstArg.sessions;
      } else {
        sessionId = firstArg;
        messages = optionalMessages;
        sessions = optionalSessions;
      }

      if (isConversationBusy()) return { ok: false, reason: 'generation-active' };
      if (typeof sessionId !== 'string' || !sessionId.trim()) return { ok: false, reason: 'invalid-session-id' };
      if (messages !== undefined && !Array.isArray(messages)) return { ok: false, reason: 'invalid-messages' };
      if (sessions !== undefined && !Array.isArray(sessions)) return { ok: false, reason: 'invalid-sessions' };

      const nextSessions = {
        activeId: sessionId,
        list: sessions !== undefined ? clone(sessions) : clone(state.sessions.list)
      };

      setState({
        sessions: nextSessions,
        messages: Array.isArray(messages) ? clone(messages) : [],
        streaming: { isGenerating: false, stats: null, status: 'idle', error: null },
        agent: { activeTurnIndex: 0, currentTool: null, loopWarning: false, ragSystemContext: '' },
        telemetry: { stats: null, diagnostics: null, lastTurnStats: null },
        ui: Object.assign({}, state.ui, { reasoningMenuOpen: false, debugPanelOpen: false, activeModal: null, attachedFiles: [], notices: [] })
      });

      return { ok: true, state: getState() };
    }

    /**
     * Añade un mensaje individual al historial de la sesión activa tras validación.
     */
    function appendMessage(message) {
      if (!message || typeof message !== 'object') {
        throw new Error('[ChatState] appendMessage: El mensaje debe ser un objeto válido.');
      }
      if (!message.role || typeof message.role !== 'string') {
        throw new Error('[ChatState] appendMessage: El mensaje debe tener una propiedad "role" válida.');
      }
      const cloned = clone(message);
      if (!cloned.id) {
        cloned.id = 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
      }
      setState({ messages: [...state.messages, cloned] });
      return cloned;
    }

    /**
     * Reemplaza el historial de mensajes completo de la sesión activa.
     */
    function replaceMessages(messages) {
      if (!Array.isArray(messages)) {
        throw new Error('[ChatState] replaceMessages: messages debe ser un Array.');
      }
      setState({ messages: clone(messages) });
      return getState().messages;
    }

    /**
     * Elimina un turno de conversación y sanea tool calls y respuestas huérfanas.
     */
    function removeTurn(criteria = {}) {
      if (isConversationBusy()) return { ok: false, reason: 'generation-active', removedCount: 0 };
      const currentMessages = state.messages;
      const initialCount = currentMessages.length;

      let filtered;
      if (typeof criteria === 'function') {
        filtered = currentMessages.filter((m, idx) => !criteria(m, idx));
      } else {
        const msgId = criteria.msgId || '';
        const baseId = criteria.baseId || (msgId && msgId.includes('_') ? msgId.split('_').slice(0, 2).join('_') : '');
        const explicitIds = new Set(
          Array.isArray(criteria.explicitIds)
            ? criteria.explicitIds
            : (criteria.explicitIds instanceof Set ? criteria.explicitIds : [])
        );
        if (msgId) explicitIds.add(msgId);
        if (baseId) explicitIds.add(baseId);

        const isTargetMessage = (m) => {
          if (!m) return false;
          const mid = m.id;
          if (mid) {
            if (explicitIds.has(mid)) return true;
            if (baseId && (mid === baseId || mid.startsWith(`${baseId}_`))) return true;
            if (msgId && (mid === msgId || mid.startsWith(`${msgId}_`))) return true;
          }
          return false;
        };

        const deletedToolCallIds = new Set();
        currentMessages.forEach(m => {
          if (m && isTargetMessage(m)) {
            if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
              m.tool_calls.forEach(tc => {
                if (tc && tc.id) deletedToolCallIds.add(tc.id);
              });
            }
            if (m.role === 'tool' && m.tool_call_id) {
              deletedToolCallIds.add(m.tool_call_id);
            }
          }
        });

        const intermediate = currentMessages.filter(m => {
          if (!m) return false;
          if (isTargetMessage(m)) return false;
          if (m.role === 'tool' && m.tool_call_id && deletedToolCallIds.has(m.tool_call_id)) {
            return false;
          }
          return true;
        });

        filtered = [];
        for (let i = 0; i < intermediate.length; i++) {
          const current = intermediate[i];
          if (current && current.role === 'tool') {
            const prev = filtered.length > 0 ? filtered[filtered.length - 1] : null;
            const hasMatchingCall = prev && prev.role === 'assistant' && Array.isArray(prev.tool_calls) &&
              prev.tool_calls.some(tc => tc && (tc.id === current.tool_call_id || (tc.function && tc.function.name === current.name)));
            if (hasMatchingCall) filtered.push(current);
          } else {
            filtered.push(current);
          }
        }
      }

      const removedCount = initialCount - filtered.length;
      if (removedCount > 0) {
        setState({ messages: filtered });
      }
      return { ok: true, removedCount, messages: getState().messages };
    }

    /**
     * Guarda o actualiza los metadatos de una sesión en el listado de sesiones.
     */
    function saveSessionMetadata(sessionMeta) {
      if (!sessionMeta || typeof sessionMeta !== 'object' || !sessionMeta.id) {
        throw new Error('[ChatState] saveSessionMetadata: Se requiere un objeto de sesión con id válido.');
      }
      const list = clone(state.sessions.list);
      const idx = list.findIndex(s => s.id === sessionMeta.id);
      const clonedMeta = clone(sessionMeta);
      if (idx >= 0) {
        list[idx] = Object.assign({}, list[idx], clonedMeta);
      } else {
        list.unshift(clonedMeta);
      }
      setState({
        sessions: {
          activeId: state.sessions.activeId,
          list
        }
      });
      return clonedMeta;
    }

    /**
     * Elimina una sesión del listado. Si es la activa, pasa a la siguiente o null.
     */
    function removeSession(sessionId) {
      if (typeof sessionId !== 'string' || !sessionId) return { ok: false, reason: 'invalid-id' };
      if (isConversationBusy() && state.sessions.activeId === sessionId) {
        return { ok: false, reason: 'generation-active' };
      }
      const list = state.sessions.list.filter(s => s.id !== sessionId);
      let nextActiveId = state.sessions.activeId;
      if (nextActiveId === sessionId) {
        nextActiveId = list.length > 0 ? list[0].id : null;
      }
      setState({
        sessions: {
          activeId: nextActiveId,
          list
        },
        ui: Object.assign({}, state.ui, { notices: nextActiveId === state.sessions.activeId ? state.ui.notices : [] })
      });
      return { ok: true, activeId: nextActiveId, list };
    }

    /**
     * Importa una conversación con sus metadatos e historial de forma atómica.
     */
    function importConversation(sessionMeta, history = []) {
      if (isConversationBusy()) return { ok: false, reason: 'generation-active' };
      if (!sessionMeta || typeof sessionMeta !== 'object' || !sessionMeta.id) {
        return { ok: false, reason: 'invalid-session-meta' };
      }
      if (!Array.isArray(history)) {
        return { ok: false, reason: 'invalid-history' };
      }

      const list = clone(state.sessions.list);
      const idx = list.findIndex(s => s.id === sessionMeta.id);
      const clonedMeta = clone(sessionMeta);
      if (idx >= 0) {
        list[idx] = Object.assign({}, list[idx], clonedMeta);
      } else {
        list.unshift(clonedMeta);
      }

      setState({
        sessions: { activeId: clonedMeta.id, list },
        messages: clone(history),
        streaming: { isGenerating: false, stats: null, status: 'idle', error: null },
        agent: { activeTurnIndex: 0, currentTool: null, loopWarning: false, ragSystemContext: '' },
        telemetry: { stats: null, diagnostics: null, lastTurnStats: null },
        ui: Object.assign({}, state.ui, { reasoningMenuOpen: false, debugPanelOpen: false, activeModal: null, attachedFiles: [], notices: [] })
      });

      return { ok: true, state: getState() };
    }

    function enqueueNotice(notice) {
      if (!notice || typeof notice.message !== 'string' || typeof notice.title !== 'string' ||
          !['info', 'success', 'error'].includes(notice.type) ||
          (notice.mode !== undefined && !['alert', 'confirm', 'prompt'].includes(notice.mode))) throw new TypeError('Invalid notice');
      notice = { ...notice, mode: notice.mode || 'alert', message: notice.message.slice(0, 10000), title: notice.title.slice(0, 200) };
      const queue = state.ui.notices || [];
      const existing = notice.mode === 'alert' && queue.find(item => item.mode === 'alert' && item.message === notice.message && item.title === notice.title && item.type === notice.type);
      if (existing) return existing.id;
      if (queue.length >= 50) throw new RangeError('Notice queue is full');
      const id = (state.ui.noticeSequence || 0) + 1;
      const item = { id, message: notice.message, title: notice.title, type: notice.type, mode: notice.mode };
      if (notice.mode === 'prompt') item.value = String(notice.value ?? '').slice(0, 10000);
      setState({ ui: Object.assign({}, state.ui, { notices: queue.concat(item), noticeSequence: id }) });
      return id;
    }

    function dismissNotice(id, accepted = false, value = null) {
      if (!(state.ui.notices || []).some(item => item.id === id)) return;
      const result = { id, accepted: accepted === true };
      if (state.ui.notices.find(item => item.id === id).mode === 'prompt') {
        result.value = accepted === true ? String(value ?? '').slice(0, 10000) : null;
      }
      setState({ ui: Object.assign({}, state.ui, { notices: state.ui.notices.filter(item => item.id !== id), noticeResult: result }) });
    }

    /** Define los archivos adjuntos de la UI en el slice `ui.attachedFiles`. */
    function setAttachments(files) {
      if (!Array.isArray(files)) {
        throw new Error('[ChatState] setAttachments: files debe ser un Array.');
      }
      setState({
        ui: Object.assign({}, state.ui, { attachedFiles: clone(files) })
      });
      return getState().ui.attachedFiles;
    }

    /**
     * Limpia los archivos adjuntos de la UI.
     */
    function clearAttachments() {
      return setAttachments([]);
    }

    return {
      getState,
      get,
      setState,
      set,
      subscribe,
      reset,
      isConversationBusy,
      initializeConversation,
      replaceConversation,
      appendMessage,
      replaceMessages,
      removeTurn,
      saveSessionMetadata,
      removeSession,
      importConversation,
      setAttachments,
      clearAttachments,
      enqueueNotice,
      dismissNotice,
      CANONICAL_SLICES
    };
  }

  // Instancia singleton por defecto para la aplicación
  const defaultStore = createStore();

  return {
    createStore,
    createInitialState,
    CANONICAL_SLICES,
    getState: defaultStore.getState,
    get: defaultStore.get,
    setState: defaultStore.setState,
    set: defaultStore.set,
    subscribe: defaultStore.subscribe,
    reset: defaultStore.reset,
    isConversationBusy: defaultStore.isConversationBusy,
    initializeConversation: defaultStore.initializeConversation,
    replaceConversation: defaultStore.replaceConversation,
    appendMessage: defaultStore.appendMessage,
    replaceMessages: defaultStore.replaceMessages,
    removeTurn: defaultStore.removeTurn,
    saveSessionMetadata: defaultStore.saveSessionMetadata,
    removeSession: defaultStore.removeSession,
    importConversation: defaultStore.importConversation,
    setAttachments: defaultStore.setAttachments,
    enqueueNotice: defaultStore.enqueueNotice,
    dismissNotice: defaultStore.dismissNotice,
    clearAttachments: defaultStore.clearAttachments
  };
}));
