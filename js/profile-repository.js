/**
 * Versioned repository for editable connection profiles.
 * Runtime consumers must use ChatConfig instead of reading this repository.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./cookies.js'));
  } else {
    root.ChatProfileRepository = factory(root.ChatStorage);
  }
}(typeof self !== 'undefined' ? self : this, function (Storage) {
  'use strict';

  const STORAGE_KEY = 'profiles_v1';
  const SCHEMA_VERSION = 1;
  const READONLY_PROFILE_ID = 'profile:mirror';
  const PROFILE_FIELDS = Object.freeze([
    'apiUrl', 'apiType', 'apiKey', 'model', 'systemPrompt', 'temperature',
    'reasoningEffort', 'maxAgentTurns', 'modelReasoningConfig', 'enabledTools',
    'enableRawLogs', 'enableContextCache', 'contextLimitOverride'
  ]);

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function createId(name) {
    return `profile:${encodeURIComponent(String(name || '').trim())}`;
  }

  const NEW_PROFILE_SETTINGS = Object.freeze({
    apiUrl: '', apiType: 'openai', apiKey: '', model: '', systemPrompt: '',
    temperature: '0.7', reasoningEffort: 'none', maxAgentTurns: 15, modelReasoningConfig: null,
    enabledTools: { execute_javascript: true, search_web: true, fetch_web_page: true, download_pdf: true, render_chart: true },
    enableRawLogs: false, enableContextCache: true, contextLimitOverride: null
  });

  const MIRROR_PROFILE = Object.freeze({
    id: READONLY_PROFILE_ID,
    name: 'Espejo',
    description: 'Muestra la petición OpenAI sin enviarla.',
    settings: {
      ...NEW_PROFILE_SETTINGS, apiUrl: 'mirror://local', apiType: 'mirror', model: 'mirror'
    }
  });

  function normalizeSettings(source = {}) {
    const settings = {};
    PROFILE_FIELDS.forEach(key => {
      if (source[key] !== undefined) settings[key] = clone(source[key]);
    });
    return settings;
  }

  function normalizeRecord(record = {}) {
    const name = String(record.name || '').trim();
    if (!name) throw new Error('El nombre del perfil no puede estar vacío.');
    return {
      id: String(record.id || createId(name)),
      name,
      description: String(record.description || '').trim(),
      schemaVersion: SCHEMA_VERSION,
      version: Number.isInteger(record.version) && record.version > 0 ? record.version : 1,
      updatedAt: Number(record.updatedAt) || Date.now(),
      settings: normalizeSettings(record.settings || record)
    };
  }

  function createRepository(storage = Storage) {
    function readDocument() {
      const raw = storage?.getStorageItem ? storage.getStorageItem(STORAGE_KEY) : null;
      if (!raw) return null;
      try {
        const doc = JSON.parse(raw);
        if (!doc || doc.schemaVersion !== SCHEMA_VERSION || !Array.isArray(doc.profiles)) return null;
        return {
          schemaVersion: SCHEMA_VERSION,
          profiles: doc.profiles.map(normalizeRecord)
        };
      } catch (_) {
        return null;
      }
    }

    function writeDocument(document) {
      if (!storage?.setStorageItem) throw new Error('El almacenamiento de perfiles no está disponible.');
      storage.setStorageItem(STORAGE_KEY, JSON.stringify(document));
    }

    function initialize() {
      const existing = readDocument();
      if (existing) {
        if (!existing.profiles.some(profile => profile.id === READONLY_PROFILE_ID)) {
          existing.profiles.unshift(normalizeRecord(MIRROR_PROFILE));
          writeDocument(existing);
        }
        return clone(existing);
      }

      const document = { schemaVersion: SCHEMA_VERSION, profiles: [normalizeRecord(MIRROR_PROFILE)] };
      writeDocument(document);
      return clone(document);
    }

    function list() {
      return initialize().profiles;
    }

    function get(id) {
      const cleanId = String(id || '');
      return list().find(profile => profile.id === cleanId) || null;
    }

    function findByName(name) {
      const cleanName = String(name || '').trim();
      return list().find(profile => profile.name === cleanName) || null;
    }

    function save(record) {
      const current = initialize();
      const normalized = normalizeRecord(record);
      if (normalized.id === READONLY_PROFILE_ID || normalized.name === MIRROR_PROFILE.name) {
        throw new Error('El perfil Espejo no se puede modificar.');
      }
      const index = current.profiles.findIndex(profile => profile.id === normalized.id);
      if (index >= 0) {
        normalized.version = current.profiles[index].version + 1;
      }
      normalized.updatedAt = Date.now();
      if (index >= 0) current.profiles[index] = normalized;
      else current.profiles.push(normalized);
      writeDocument(current);
      return clone(normalized);
    }

    function remove(id) {
      if (String(id || '') === READONLY_PROFILE_ID) return false;
      const current = initialize();
      const index = current.profiles.findIndex(profile => profile.id === String(id || ''));
      if (index < 0) return false;
      current.profiles.splice(index, 1);
      writeDocument(current);
      return true;
    }

    return { initialize, list, get, findByName, save, remove };
  }

  const defaultRepository = createRepository();
  return { STORAGE_KEY, SCHEMA_VERSION, PROFILE_FIELDS, READONLY_PROFILE_ID, MIRROR_PROFILE: clone(MIRROR_PROFILE), NEW_PROFILE_SETTINGS: clone(NEW_PROFILE_SETTINGS), createRepository, ...defaultRepository };
}));
