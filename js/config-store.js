/**
 * Sole runtime configuration boundary. UI and execution must read this store,
 * never the editable profile repository or browser storage directly.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./state.js'), require('./cookies.js'), require('./profile-repository.js'));
  } else {
    root.ChatConfig = factory(root.ChatState, root.ChatStorage, root.ChatProfileRepository);
  }
}(typeof self !== 'undefined' ? self : this, function (State, Storage, Profiles) {
  'use strict';

  const SCHEMA_VERSION = 2;
  const PROFILE_FIELDS = Profiles?.PROFILE_FIELDS || [];
  const DEFAULT_SYSTEM_DATA_PROMPT = '[Formato: Usa siempre Markdown estándar y texto plano. Nunca uses sintaxis ni delimitadores LaTeX ($ o $$); escribe las matemáticas, fórmulas y números directamente en texto legible con símbolos estándar (+, -, ×, /, =).]';
  const DEFAULTS = Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    activeProfile: null,
    apiUrl: 'http://localhost:1234/v1', apiType: 'openai', apiKey: '', model: '',
    systemPrompt: '', systemDataPrompt: DEFAULT_SYSTEM_DATA_PROMPT, temperature: '0.7', reasoningEffort: 'none',
    maxAgentTurns: 15,
    modelReasoningConfig: null,
    enabledTools: { execute_javascript: true, search_web: true, fetch_web_page: true, download_pdf: true, render_chart: true },
    enableRawLogs: false, sendDateTime: true, enableContextCache: true,
    theme: 'light', language: 'es', enableDebugMessages: false,
    activeRagBranchId: '', activeRagBranchIds: []
  });

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

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
    next.apiUrl = String(next.apiUrl || DEFAULTS.apiUrl).trim() || DEFAULTS.apiUrl;
    next.apiType = String(next.apiType || DEFAULTS.apiType).trim() || DEFAULTS.apiType;
    next.apiKey = String(next.apiKey || '').trim();
    next.model = String(next.model || '').trim();
    next.systemPrompt = String(next.systemPrompt || '').trim();
    next.systemDataPrompt = String(next.systemDataPrompt || '').trim();
    next.temperature = String(next.temperature ?? DEFAULTS.temperature);
    next.reasoningEffort = ['off', 'none'].includes(String(next.reasoningEffort).toLowerCase()) ? 'none' : String(next.reasoningEffort || 'none');
    const parsedTurns = Number(next.maxAgentTurns);
    next.maxAgentTurns = Number.isInteger(parsedTurns) && parsedTurns >= 1 ? Math.min(50, Math.max(1, parsedTurns)) : 15;
    next.theme = next.theme === 'dark' ? 'dark' : 'light';
    next.language = next.language === 'en' ? 'en' : 'es';
    next.enabledTools = next.enabledTools && typeof next.enabledTools === 'object' ? clone(next.enabledTools) : clone(DEFAULTS.enabledTools);
    next.enableRawLogs = next.enableRawLogs === true;
    next.enableDebugMessages = next.enableDebugMessages === true;
    next.sendDateTime = next.sendDateTime !== false;
    next.enableContextCache = next.enableContextCache !== false;
    next.activeRagBranchIds = normalizeBranchIds(next.activeRagBranchIds, next.activeRagBranchId ? [next.activeRagBranchId] : []);
    next.activeRagBranchId = next.activeRagBranchIds[0] || '';
    next.modelReasoningConfig = next.modelReasoningConfig && typeof next.modelReasoningConfig === 'object' ? clone(next.modelReasoningConfig) : null;
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
      storage.saveRuntimeConfigV2(next);
    }

    function commit(next) {
      const normalized = normalize(next);
      persist(normalized);
      state.set('config', normalized);
      return state.get('config');
    }

    function initialize() {
      profiles?.initialize?.();
      const stored = storage?.loadRuntimeConfigV2?.();
      if (stored) return commit(stored);

      const initialProfile = profiles?.list?.()[0] || null;
      return initialProfile ? activateProfile(initialProfile.id) : commit(DEFAULTS);
    }

    function getActive() {
      return normalize(state.get('config') || DEFAULTS);
    }

    function updateRuntime(patch = {}) {
      const current = getActive();
      const safePatch = { ...patch };
      delete safePatch.schemaVersion;
      delete safePatch.activeProfile;
      return commit({ ...current, ...safePatch });
    }

    function updateGeneral(patch = {}) {
      return updateRuntime(patch);
    }

    function activateProfile(profileId) {
      const profile = profiles?.get?.(profileId);
      if (!profile) throw new Error('El perfil seleccionado no existe.');
      const patch = {};
      PROFILE_FIELDS.forEach(field => {
        if (profile.settings[field] !== undefined) patch[field] = clone(profile.settings[field]);
      });
      return commit({ ...getActive(), ...patch, activeProfile: profileMetadata(profile) });
    }

    function subscribe(listener) {
      if (!state?.subscribe) throw new Error('El estado global no está disponible.');
      return state.subscribe('config', listener);
    }

    function resetRuntime() {
      return commit(DEFAULTS);
    }

    return { initialize, getActive, updateRuntime, updateGeneral, activateProfile, subscribe, resetRuntime };
  }

  const defaultStore = createConfigStore();
  return { SCHEMA_VERSION, DEFAULT_SYSTEM_DATA_PROMPT, DEFAULTS: clone(DEFAULTS), normalize, createConfigStore, ...defaultStore };
}));
