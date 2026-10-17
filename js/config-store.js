/**
 * Sole runtime configuration boundary. UI and execution must read this store,
 * never the editable profile repository or browser storage directly.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./state.js'), require('./storage.js'), require('./profile-repository.js'), require('./defaults.js'), require('./utils.js'));
  } else {
    root.ChatConfig = factory(root.ChatState, root.ChatStorage, root.ChatProfileRepository, root.ChatDefaults, root.ChatUtils);
  }
}(typeof self !== 'undefined' ? self : this, function (State, Storage, Profiles, Defaults, Utils) {
  'use strict';

  const WEBLLM_DEFAULT_CONTEXT_WINDOW_SIZE = String(Defaults.WEBLLM_DEFAULT_CONTEXT_WINDOW_SIZE);
  const PROFILE_FIELDS = Profiles.PROFILE_FIELDS;
  const DEFAULT_SYSTEM_DATA_PROMPT = Defaults.DEFAULT_SYSTEM_DATA_PROMPT;
  const DEFAULTS = Defaults.CONFIG_DEFAULTS;

  const { clone } = Utils;

  function normalizeBranchIds(value) {
    return (Array.isArray(value) ? value : []).map(String).map(id => id.trim()).filter(Boolean);
  }

  const MAX_DECLINED_PROJECTS = 50;
  const MAX_PROJECT_PATH_LENGTH = 4096;

  /** Rutas cwd rechazadas para el modo proyecto: únicas, acotadas y conservando las más recientes. */
  function normalizeDeclinedProjects(value) {
    const paths = Array.isArray(value) ? value : [];
    const unique = [...new Set(paths
      .filter(item => typeof item === 'string')
      .map(item => item.trim())
      .filter(item => item && item.length <= MAX_PROJECT_PATH_LENGTH))];
    return unique.slice(-MAX_DECLINED_PROJECTS);
  }

  function normalize(config = {}) {
    const next = { ...clone(DEFAULTS), ...clone(config) };
    delete next.activeProfileName;
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
    next.reasoningEffort = String(next.reasoningEffort || DEFAULTS.reasoningEffort);
    next.theme = next.theme === 'dark' ? 'dark' : 'light';
    next.language = next.language === 'en' ? 'en' : 'es';
    next.enabledTools = next.enabledTools && typeof next.enabledTools === 'object' ? clone(next.enabledTools) : clone(DEFAULTS.enabledTools);
    next.enableRawLogs = next.enableRawLogs === true;
    next.enableDebugMessages = next.enableDebugMessages === true;
    next.enableContextCache = next.enableContextCache !== false;
    next.mcpHost = String(next.mcpHost || DEFAULTS.mcpHost).trim() || DEFAULTS.mcpHost;
    const parsedMcpPort = Number(next.mcpPort);
    next.mcpPort = Number.isInteger(parsedMcpPort) && parsedMcpPort >= 1024 && parsedMcpPort <= 65535 ? parsedMcpPort : DEFAULTS.mcpPort;
    next.mcpAutoConnect = next.mcpAutoConnect === true;
    next.projectMode = next.projectMode !== false;
    next.projectDeclined = normalizeDeclinedProjects(next.projectDeclined);
    next.activeRagBranchIds = normalizeBranchIds(next.activeRagBranchIds);
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

  function persist(next) {
    Storage.saveRuntimeConfigV2({ ...next, modelContextLimit: null });
  }

  function commit(next) {
    const normalized = normalize(next);
    persist(normalized);
    State.set('config', normalized);
    return State.get('config');
  }

  function initialize() {
    // Un almacenamiento de perfiles dañado no impide arrancar: se usa la configuración guardada.
    try {
      Profiles.initialize();
    } catch (error) {
      console.warn('[ChatConfig] Could not initialize the profile repository:', error);
    }
    const stored = Storage.loadRuntimeConfigV2();
    let fallbackProfile = null;
    try {
      fallbackProfile = Profiles.get(Profiles.READONLY_PROFILE_ID) || Profiles.list()[0] || null;
    } catch (_) { /* perfiles no disponibles: sin perfil de respaldo */ }
    if (stored) {
      const config = { ...stored, modelContextLimit: null };
      try {
        if (!Profiles.get(config.activeProfile?.id) && fallbackProfile) {
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
    return normalize(State.get('config') || DEFAULTS);
  }

  function updateRuntime(patch = {}) {
    const current = getActive();
    const safePatch = { ...patch };
    delete safePatch.activeProfile;
    const connectionChanged = ['apiUrl', 'apiType', 'model'].some(key => Object.prototype.hasOwnProperty.call(safePatch, key)
      && safePatch[key] !== current[key]);
    if (connectionChanged && !Object.prototype.hasOwnProperty.call(safePatch, 'modelContextLimit')) {
      safePatch.modelContextLimit = null;
    }
    return commit({ ...current, ...safePatch });
  }

  function activateProfile(profileId) {
    const profile = Profiles.get(profileId);
    if (!profile) throw new Error('The selected profile does not exist.');
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
    const fallbackProfile = Profiles.get(Profiles.READONLY_PROFILE_ID) || Profiles.list()[0] || null;
    return fallbackProfile ? activateProfile(fallbackProfile.id) : commit(DEFAULTS);
  }

  function subscribe(listener) {
    return State.subscribe('config', listener);
  }

  return {
    DEFAULT_SYSTEM_DATA_PROMPT, DEFAULTS: clone(DEFAULTS), normalize,
    initialize, getActive, updateRuntime, activateProfile, activateFallbackProfile, subscribe
  };
}));
