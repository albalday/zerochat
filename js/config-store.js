/**
 * Sole runtime configuration boundary. UI and execution must read this store,
 * never the editable profile repository or browser storage directly.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./state.js'), require('./cookies.js'), require('./profile-repository.js'), require('./defaults.js'), require('./utils.js'));
  } else {
    root.ChatConfig = factory(root.ChatState, root.ChatStorage, root.ChatProfileRepository, root.ChatDefaults, root.ChatUtils);
  }
}(typeof self !== 'undefined' ? self : this, function (State, Storage, Profiles, Defaults, Utils) {
  'use strict';

  const SCHEMA_VERSION = 3;
  const DEFAULT_THEME = Defaults.DEFAULT_THEME;
  const WEBLLM_DEFAULT_CONTEXT_WINDOW_SIZE = String(Defaults.WEBLLM_DEFAULT_CONTEXT_WINDOW_SIZE);
  const PROFILE_FIELDS = Profiles?.PROFILE_FIELDS || [];
  const DEFAULT_SYSTEM_DATA_PROMPT = '[Format: Always use standard Markdown and plain text. Never use LaTeX syntax or delimiters ($ or $$); write mathematics, formulas, and numbers directly in readable text using standard symbols (+, -, ×, /, =).]';
  const DEFAULTS = Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    activeProfile: null,
    apiUrl: 'http://localhost:1234/v1', apiType: 'openai', model: '', modelContextLimit: null, contextLimitOverride: null,
    systemPrompt: '', systemDataPrompt: DEFAULT_SYSTEM_DATA_PROMPT, temperature: '0.7', reasoningEffort: 'medium', reasoningTransport: 'auto',
    maxAgentTurns: 40,
    modelReasoningConfig: null,
    enabledTools: { execute_javascript: true, search_web: true, fetch_web_page: true, download_pdf: true, render_chart: true },
    enableRawLogs: false, enableContextCache: true,
    apiKeyLocked: false,
    theme: DEFAULT_THEME, language: 'es', enableDebugMessages: false,
    activeRagBranchId: '', activeRagBranchIds: [],
    mcpHost: '127.0.0.1', mcpPort: 6388, mcpAutoConnect: false,
    webllmConfig: {
      context_window_size: WEBLLM_DEFAULT_CONTEXT_WINDOW_SIZE,
      prefill_chunk_size: 'default'
    }
  });

  const { clone } = Utils;
  const RETIRED_TOOL_IDS = Object.freeze(['agent_checkpoint', 'update_plan', 'finish_task']);

  function normalizeBranchIds(value, fallback) {
    const values = Array.isArray(value) ? value : (value ? [value] : fallback || []);
    return values.map(String).map(id => id.trim()).filter(Boolean);
  }

  function normalize(config = {}) {
    const next = { ...clone(DEFAULTS), ...clone(config), schemaVersion: SCHEMA_VERSION };
    delete next.activeProfileName;
    delete next.enableAgentJs;
    delete next.enableAgentWeb;
    delete next.enableAgentSearch;
    delete next.enableAgentChart;
    delete next.sendDateTime;
    next.apiUrl = String(next.apiUrl || DEFAULTS.apiUrl).trim() || DEFAULTS.apiUrl;
    next.apiType = String(next.apiType || DEFAULTS.apiType).trim() || DEFAULTS.apiType;
    delete next.apiKey;
    next.model = String(next.model || '').trim();
    const contextLimit = Number(next.modelContextLimit);
    next.modelContextLimit = Number.isFinite(contextLimit) && contextLimit > 0 ? Math.floor(contextLimit) : null;
    const contextLimitOverride = Number(next.contextLimitOverride);
    next.contextLimitOverride = Number.isFinite(contextLimitOverride) && contextLimitOverride > 0 ? Math.floor(contextLimitOverride) : null;
    next.systemPrompt = String(next.systemPrompt || '').trim();
    next.systemDataPrompt = String(next.systemDataPrompt || '').trim();
    next.temperature = String(next.temperature ?? DEFAULTS.temperature);
    next.reasoningEffort = ['off', 'none'].includes(String(next.reasoningEffort).toLowerCase()) ? 'none' : String(next.reasoningEffort || DEFAULTS.reasoningEffort);
    next.reasoningTransport = ['omit', 'send-none'].includes(next.reasoningTransport) ? next.reasoningTransport : 'auto';
    const parsedTurns = Number(next.maxAgentTurns);
    next.maxAgentTurns = Number.isInteger(parsedTurns) ? Math.min(200, Math.max(5, parsedTurns)) : 40;
    next.theme = next.theme === 'dark' ? 'dark' : 'light';
    next.language = next.language === 'en' ? 'en' : 'es';
    next.enabledTools = next.enabledTools && typeof next.enabledTools === 'object' ? clone(next.enabledTools) : clone(DEFAULTS.enabledTools);
    RETIRED_TOOL_IDS.forEach(id => delete next.enabledTools[id]);
    next.enableRawLogs = next.enableRawLogs === true;
    next.enableDebugMessages = next.enableDebugMessages === true;
    next.enableContextCache = next.enableContextCache !== false;
    next.mcpHost = String(next.mcpHost || DEFAULTS.mcpHost).trim() || DEFAULTS.mcpHost;
    const parsedMcpPort = Number(next.mcpPort);
    next.mcpPort = Number.isInteger(parsedMcpPort) && parsedMcpPort >= 1024 && parsedMcpPort <= 65535 ? parsedMcpPort : DEFAULTS.mcpPort;
    next.mcpAutoConnect = next.mcpAutoConnect === true;
    next.activeRagBranchIds = normalizeBranchIds(next.activeRagBranchIds, next.activeRagBranchId ? [next.activeRagBranchId] : []);
    next.activeRagBranchId = next.activeRagBranchIds[0] || '';
    next.modelReasoningConfig = next.modelReasoningConfig && typeof next.modelReasoningConfig === 'object' ? clone(next.modelReasoningConfig) : null;
    const webllmConfig = next.webllmConfig && typeof next.webllmConfig === 'object' ? clone(next.webllmConfig) : clone(DEFAULTS.webllmConfig);
    // Solo se admiten los tamaños ofrecidos en la interfaz; los valores antiguos pasan al predeterminado.
    if (!Defaults.WEBLLM_CONTEXT_WINDOW_SIZES.includes(Number(webllmConfig.context_window_size))) {
      webllmConfig.context_window_size = WEBLLM_DEFAULT_CONTEXT_WINDOW_SIZE;
    }
    next.webllmConfig = webllmConfig;
    if (!next.activeProfile || typeof next.activeProfile !== 'object') next.activeProfile = null;
    return next;
  }

  function profileMetadata(profile) {
    return { id: profile.id, name: profile.name, version: profile.version, appliedAt: Date.now() };
  }

  function createConfigStore(options = {}) {
    const state = options.state || State;
    const storage = options.storage || Storage;
    const profiles = options.profiles || Profiles;

    function persist(next) {
      if (!storage?.saveRuntimeConfigV2) throw new Error('El almacenamiento de configuración no está disponible.');
      storage.saveRuntimeConfigV2({ ...next, modelContextLimit: null });
    }

    function commit(next) {
      const normalized = normalize(next);
      persist(normalized);
      state.set('config', normalized);
      return state.get('config');
    }

    function initialize() {
      try {
        profiles?.initialize?.();
      } catch (error) {
        console.warn('No se pudo inicializar el repositorio de perfiles:', error);
      }
      const stored = storage?.loadRuntimeConfigV2?.();
      let fallbackProfile = null;
      try {
        fallbackProfile = profiles?.get?.(profiles?.READONLY_PROFILE_ID) || profiles?.list?.()[0] || null;
      } catch (_) { /* perfiles no disponibles: sin perfil de respaldo */ }
      if (stored) {
        const config = { ...stored, modelContextLimit: null };
        // Version 2 used 15 as the shipped default. Migrate only that legacy
        // default once; any other persisted choice remains untouched.
        if (Number(stored.schemaVersion) < SCHEMA_VERSION && Number(config.maxAgentTurns) === 15) {
          config.maxAgentTurns = DEFAULTS.maxAgentTurns;
        }
        try {
          if (!profiles?.get?.(config.activeProfile?.id) && fallbackProfile) {
            return commit(applyProfile(config, fallbackProfile));
          }
        } catch (_) { /* perfiles no disponibles: se conserva la configuración guardada */ }
        return commit(config);
      }

      try {
        return fallbackProfile ? activateProfile(fallbackProfile.id) : commit(DEFAULTS);
      } catch (_) {
        return commit(DEFAULTS);
      }
    }

    function getActive() {
      return normalize(state.get('config') || DEFAULTS);
    }

    function updateRuntime(patch = {}) {
      const current = getActive();
      const safePatch = { ...patch };
      delete safePatch.schemaVersion;
      delete safePatch.activeProfile;
      const connectionChanged = ['apiUrl', 'apiType', 'model'].some(key => Object.prototype.hasOwnProperty.call(safePatch, key)
        && safePatch[key] !== current[key]);
      if (connectionChanged && !Object.prototype.hasOwnProperty.call(safePatch, 'modelContextLimit')) {
        safePatch.modelContextLimit = null;
      }
      return commit({ ...current, ...safePatch });
    }

    function updateGeneral(patch = {}) {
      return updateRuntime(patch);
    }

    function activateProfile(profileId) {
      const profile = profiles?.get?.(profileId);
      if (!profile) throw new Error('El perfil seleccionado no existe.');
      return commit(applyProfile(getActive(), profile));
    }

    function applyProfile(config, profile) {
      const patch = {};
      PROFILE_FIELDS.forEach(field => {
        patch[field] = clone(profile.settings[field] !== undefined ? profile.settings[field] : DEFAULTS[field]);
      });
      return {
        ...config,
        ...patch,
        modelContextLimit: null,
        contextLimitOverride: profile.settings.contextLimitOverride ?? null,
        activeProfile: profileMetadata(profile)
      };
    }

    function activateFallbackProfile() {
      const fallbackProfile = profiles?.get?.(profiles?.READONLY_PROFILE_ID) || profiles?.list?.()[0] || null;
      return fallbackProfile ? activateProfile(fallbackProfile.id) : commit(DEFAULTS);
    }

    function subscribe(listener) {
      if (!state?.subscribe) throw new Error('El estado global no está disponible.');
      return state.subscribe('config', listener);
    }

    function resetRuntime() {
      const mirror = profiles?.get?.(profiles?.READONLY_PROFILE_ID);
      return commit(mirror ? applyProfile(DEFAULTS, mirror) : DEFAULTS);
    }

    return {
      initialize,
      getActive,
      get: getActive,
      updateRuntime,
      updateGeneral,
      update: updateRuntime,
      activateProfile,
      activateFallbackProfile,
      subscribe,
      resetRuntime
    };
  }

  const defaultStore = createConfigStore();
  return { SCHEMA_VERSION, DEFAULT_SYSTEM_DATA_PROMPT, DEFAULTS: clone(DEFAULTS), normalize, createConfigStore, ...defaultStore };
}));
