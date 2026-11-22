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

  function normalizeUniqueIdList(value) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map(String).map(id => id.trim()).filter(Boolean))];
  }

  function normalizeMcpServers(value) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter(id => typeof id === 'string').map(id => id.trim()).filter(Boolean))];
  }

  function normalizeProjectEnvironment(env = {}) {
    const source = env && typeof env === 'object' && !Array.isArray(env) ? env : {};
    const enabledTools = {};
    if (source.enabledTools && typeof source.enabledTools === 'object' && !Array.isArray(source.enabledTools)) {
      for (const [key, val] of Object.entries(source.enabledTools)) {
        const cleanKey = String(key || '').trim();
        if (cleanKey && typeof val === 'boolean') enabledTools[cleanKey] = val;
      }
    }
    return {
      systemDataPrompt: typeof source.systemDataPrompt === 'string' ? source.systemDataPrompt.trim() : null,
      enabledTools,
      mcpServers: normalizeMcpServers(source.mcpServers),
      browser: Defaults.BROWSER_TOOLS.includes(source.browser) ? source.browser : DEFAULTS.browser,
      activeRagBranchIds: normalizeUniqueIdList(source.activeRagBranchIds),
      updatedAt: Number.isFinite(Number(source.updatedAt)) ? Number(source.updatedAt) : 0
    };
  }

  function getProjectEnvironment(projectKey) {
    const key = String(projectKey || '').trim() || 'general';
    const all = Storage.loadProjectEnvironments();
    return Object.hasOwn(all, key) ? normalizeProjectEnvironment(all[key]) : null;
  }

  function saveProjectEnvironmentBackup(projectKey, env) {
    const key = String(projectKey || '').trim() || 'general';
    const normalized = normalizeProjectEnvironment(env);
    Storage.saveProjectEnvironment(key, normalized);
    return normalized;
  }

  function projectEnvironmentPatch(source) {
    return source
      ? {
          systemDataPrompt: source.systemDataPrompt === null ? DEFAULTS.systemDataPrompt : source.systemDataPrompt,
          enabledTools: clone(source.enabledTools),
          mcpServers: clone(source.mcpServers),
          browser: source.browser,
          activeRagBranchIds: clone(source.activeRagBranchIds)
        }
      : {
          systemDataPrompt: DEFAULTS.systemDataPrompt,
          enabledTools: {},
          mcpServers: [],
          browser: DEFAULTS.browser,
          activeRagBranchIds: []
        };
  }

  /**
   * Aplica el entorno del proyecto activo a la configuración en ejecución. Si el servidor entrega
   * un entorno guardado, lo respalda; si no hay entorno guardado en el servidor o sin conexión, aplica
   * el respaldo local (solo sin servidor) o los valores predeterminados para no arrastrar el proyecto previo.
   */
  function applyProjectEnvironment(projectKey, serverEnv = null) {
    const key = String(projectKey || '').trim() || 'general';
    let source = null;
    if (serverEnv && typeof serverEnv === 'object') {
      if (serverEnv.saved) source = saveProjectEnvironmentBackup(key, serverEnv);
    } else {
      source = getProjectEnvironment(key);
    }
    return updateRuntime(projectEnvironmentPatch(source));
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
    Object.assign(next, Utils.normalizeConnectionSettings(next));
    next.projectMode = next.projectMode !== false;
    next.activeRagBranchIds = normalizeUniqueIdList(next.activeRagBranchIds);
    next.mcpServers = normalizeMcpServers(next.mcpServers);
    next.browser = Defaults.BROWSER_TOOLS.includes(next.browser) ? next.browser : DEFAULTS.browser;
    next.modelReasoningConfig = next.modelReasoningConfig && typeof next.modelReasoningConfig === 'object' ? clone(next.modelReasoningConfig) : null;
    const webllmConfig = next.webllmConfig && typeof next.webllmConfig === 'object' ? clone(next.webllmConfig) : clone(DEFAULTS.webllmConfig);
    // Solo se admiten los tamaños ofrecidos en la interfaz; los valores antiguos pasan al predeterminado.
    if (!Defaults.WEBLLM_CONTEXT_WINDOW_SIZES.includes(Number(webllmConfig.context_window_size))) {
      webllmConfig.context_window_size = WEBLLM_DEFAULT_CONTEXT_WINDOW_SIZE;
    }
    next.webllmConfig = webllmConfig;
    if (!next.activeProfile || typeof next.activeProfile !== 'object') next.activeProfile = null;
    next.sessionOnly = next.sessionOnly === true;
    return next;
  }

  function profileMetadata(profile) {
    return {
      id: profile.id,
      name: profile.name,
      version: profile.version,
      updatedAt: profile.updatedAt,
      appliedAt: Date.now()
    };
  }

  const GLOBAL_PREFERENCE_KEYS = Object.freeze([
    'activeProfile',
    'theme',
    'language',
    'enableDebugMessages',
    'localBackend',
    'backendUrl',
    'useProxy',
    'proxyKey',
    'projectMode'
  ]);

  function pickGlobalPreferences(source) {
    const prefs = {};
    if (!source || typeof source !== 'object') return prefs;
    for (const key of GLOBAL_PREFERENCE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(source, key)) prefs[key] = clone(source[key]);
    }
    return prefs;
  }

  function persist(next) {
    // Un perfil activado solo para esta página (modo ejecución) no cambia la configuración guardada.
    if (next.sessionOnly) return;
    Storage.saveRuntimeConfigV2(pickGlobalPreferences(next));
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
    const globalPrefs = stored ? pickGlobalPreferences(stored) : {};
    let fallbackProfile = null;
    let activeProfile = null;
    try {
      fallbackProfile = Profiles.get(Profiles.READONLY_PROFILE_ID) || Profiles.list()[0] || null;
      if (globalPrefs.activeProfile?.id) {
        activeProfile = Profiles.get(globalPrefs.activeProfile.id);
      }
    } catch (_) { /* perfiles no disponibles: sin perfil de respaldo */ }
    const generalPatch = projectEnvironmentPatch(getProjectEnvironment('general'));
    const base = { ...DEFAULTS, ...globalPrefs, ...generalPatch, modelContextLimit: null };
    const profileToApply = activeProfile || fallbackProfile;
    if (profileToApply) {
      try {
        return commit(applyProfile(base, profileToApply));
      } catch (_) { /* perfiles no disponibles: se conserva la configuración base */ }
    }
    return commit(base);
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

  /** Activa un perfil; con sessionOnly, ni él ni ningún cambio posterior de esta página se guardan. */
  function activateProfile(profileId, { sessionOnly = false } = {}) {
    const profile = Profiles.get(profileId);
    if (!profile) throw new Error('The selected profile does not exist.');
    const next = applyProfile(getActive(), profile);
    return commit(sessionOnly ? { ...next, sessionOnly: true } : next);
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

  /** Reaplica o degrada el perfil activo tras una sincronización si cambió o dejó de existir. */
  function refreshActiveProfile() {
    const current = getActive();
    const activeId = current.activeProfile?.id;
    if (!activeId) return current;
    const profile = Profiles.get(activeId);
    if (!profile) return activateFallbackProfile();
    if (profile.version === current.activeProfile.version && profile.updatedAt === current.activeProfile.updatedAt) {
      return current;
    }
    return activateProfile(activeId, { sessionOnly: current.sessionOnly });
  }

  function subscribe(listener) {
    return State.subscribe('config', listener);
  }

  return {
    DEFAULT_SYSTEM_DATA_PROMPT, GLOBAL_PREFERENCE_KEYS, normalize,
    getProjectEnvironment, saveProjectEnvironmentBackup, applyProjectEnvironment,
    initialize, getActive, updateRuntime, activateProfile, activateFallbackProfile, refreshActiveProfile, subscribe
  };
}));
