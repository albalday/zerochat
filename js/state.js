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

  function createInitialState(overrides = {}) {
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
          render_chart: true
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
        activeId: 'session_' + Date.now(),
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
        loopWarning: false
      },

      // 6. Telemetría de Contexto y Tokens
      telemetry: {
        stats: null,
        diagnostics: null,
        lastTurnStats: null
      },

      // 7. Estado de la Interfaz (UI)
      ui: {
        sidebarOpen: false,
        reasoningMenuOpen: false,
        debugPanelOpen: false,
        activeModal: null // null | 'settings' | 'export' | 'debug_interceptor'
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
      }
    };

    if (overrides && typeof overrides === 'object') {
      for (const k of Object.keys(overrides)) {
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

    return {
      getState,
      get,
      setState,
      set,
      subscribe,
      reset
    };
  }

  // Instancia singleton por defecto para la aplicación
  const defaultStore = createStore();

  return {
    createStore,
    createInitialState,
    getState: defaultStore.getState,
    get: defaultStore.get,
    setState: defaultStore.setState,
    set: defaultStore.set,
    subscribe: defaultStore.subscribe,
    reset: defaultStore.reset
  };
}));
