/**
 * Versioned repository for editable connection profiles.
 * Runtime consumers must use ChatConfig instead of reading this repository.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./cookies.js'), require('./profile-backup.js'));
  } else {
    root.ChatProfileRepository = factory(root.ChatStorage, root.ChatProfileBackup);
  }
}(typeof self !== 'undefined' ? self : this, function (Storage, Backup) {
  'use strict';

  const STORAGE_KEY = 'profiles_v1';
  const SCHEMA_VERSION = 1;
  const READONLY_PROFILE_ID = 'profile:mirror';
  const PROFILE_FIELDS = Object.freeze([
    'apiUrl', 'apiType', 'model', 'systemPrompt', 'temperature',
    'reasoningEffort', 'reasoningTransport', 'maxAgentTurns', 'modelReasoningConfig', 'enabledTools',
    'enableRawLogs', 'enableContextCache', 'contextLimitOverride', 'webllmConfig', 'apiKeyLocked'
  ]);
  const STORAGE_PROFILE_FIELDS = Object.freeze([...PROFILE_FIELDS, 'apiKey']);

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function createId(name) {
    return `profile:${encodeURIComponent(String(name || '').trim())}`;
  }

  const NEW_PROFILE_SETTINGS = Object.freeze({
    apiUrl: 'http://localhost:1234/v1', apiType: 'openai', model: '', systemPrompt: '',
    temperature: '0.7', reasoningEffort: 'medium', reasoningTransport: 'auto', maxAgentTurns: 15, modelReasoningConfig: null,
    enabledTools: { execute_javascript: true, search_web: true, fetch_web_page: true, download_pdf: true, render_chart: true },
    enableRawLogs: false, enableContextCache: true, contextLimitOverride: null, apiKeyLocked: false,
    webllmConfig: {
      context_window_size: 'default',
      prefill_chunk_size: 'default'
    }
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
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('Los datos del perfil no son válidos.');
    const settings = {};
    STORAGE_PROFILE_FIELDS.forEach(key => {
      if (key === 'apiKey') {
        if (source[key] === '' || source[key] === null || source[key] === undefined) {
          settings.apiKey = null;
          return;
        }
        if (!Backup?.validateApiKeySecret) throw new Error('La validación de API keys no está disponible.');
        Backup.validateApiKeySecret(source[key]);
      }
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
      let doc;
      try {
        doc = JSON.parse(raw);
      } catch (_) {
        throw new Error('El almacenamiento de perfiles no es JSON válido.');
      }
      if (!doc || doc.schemaVersion !== SCHEMA_VERSION || !Array.isArray(doc.profiles)) {
        throw new Error('El almacenamiento de perfiles no tiene un formato válido.');
      }
      return { schemaVersion: SCHEMA_VERSION, profiles: doc.profiles.map(normalizeRecord) };
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

    async function load(id, keyMaterial = null) {
      const profile = get(id);
      if (!profile) return null;
      const secret = profile.settings.apiKey;
      if (secret) {
        if (!Backup?.decryptApiKey) throw new Error('El descifrado de API keys no está disponible.');
        profile.settings.apiKey = await Backup.decryptApiKey(secret, keyMaterial || undefined);
      } else {
        profile.settings.apiKey = '';
      }
      return profile;
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
        if (current.profiles[index].settings.apiKeyLocked === true) throw new Error('Los cambios de este perfil están bloqueados.');
        normalized.version = current.profiles[index].version + 1;
      }
      normalized.updatedAt = Date.now();
      if (index >= 0) current.profiles[index] = normalized;
      else current.profiles.push(normalized);
      writeDocument(current);
      return clone(normalized);
    }

    async function saveEditable(record) {
      if (typeof record?.settings?.apiKey !== 'string') throw new Error('La API key del perfil no es válida.');
      if (!Backup?.encryptApiKey) throw new Error('El cifrado de API keys no está disponible.');
      const apiKey = await Backup.encryptApiKey(record.settings.apiKey);
      return save({ ...record, settings: { ...record.settings, apiKey } });
    }

    async function recipherApiKeys(currentKeyMaterial, nextKeyMaterial) {
      const current = initialize();
      const rewritten = [];
      for (const profile of current.profiles) {
        if (profile.id === READONLY_PROFILE_ID || !profile.settings.apiKey) {
          rewritten.push(profile);
          continue;
        }
        const apiKey = await Backup.decryptApiKey(profile.settings.apiKey, currentKeyMaterial);
        const encrypted = await Backup.encryptApiKey(apiKey, nextKeyMaterial);
        rewritten.push({ ...profile, updatedAt: Date.now(), version: profile.version + 1, settings: { ...profile.settings, apiKey: encrypted } });
      }
      writeDocument({ schemaVersion: SCHEMA_VERSION, profiles: rewritten });
      return rewritten.length;
    }

    async function verifyApiKeyMaterial(keyMaterial) {
      const current = initialize();
      for (const profile of current.profiles) {
        if (profile.id !== READONLY_PROFILE_ID && profile.settings.apiKey) {
          await Backup.decryptApiKey(profile.settings.apiKey, keyMaterial);
        }
      }
      return true;
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

    function mergeImported(records) {
      if (!Array.isArray(records) || records.length > 100) throw new Error('La lista de perfiles importados no es válida.');
      const current = initialize();
      const imported = records.map(normalizeRecord).filter(profile => profile.id !== READONLY_PROFILE_ID && profile.name !== MIRROR_PROFILE.name);
      if (imported.length !== records.length) throw new Error('La copia no puede modificar el perfil Espejo.');
      const ids = new Set();
      const names = new Set();
      imported.forEach(profile => {
        if (ids.has(profile.id) || names.has(profile.name)) throw new Error('La copia contiene perfiles duplicados.');
        ids.add(profile.id); names.add(profile.name);
      });
      const editable = current.profiles.filter(profile => profile.id !== READONLY_PROFILE_ID);
      const byId = new Map(editable.map(profile => [profile.id, profile]));
      const existingNames = new Map(editable.map(profile => [profile.name, profile.id]));
      let added = 0;
      let replaced = 0;
      imported.forEach(profile => {
        const nameOwner = existingNames.get(profile.name);
        if (nameOwner && nameOwner !== profile.id) throw new Error(`Ya existe un perfil llamado "${profile.name}" con otro identificador.`);
        if (byId.has(profile.id)) replaced += 1;
        else added += 1;
        byId.set(profile.id, profile);
      });
      writeDocument({ schemaVersion: SCHEMA_VERSION, profiles: [normalizeRecord(MIRROR_PROFILE), ...byId.values()] });
      return { added, replaced, total: imported.length };
    }

    return { initialize, list, get, load, findByName, save, saveEditable, verifyApiKeyMaterial, recipherApiKeys, remove, mergeImported };
  }

  const defaultRepository = createRepository();
  return { STORAGE_KEY, SCHEMA_VERSION, PROFILE_FIELDS, STORAGE_PROFILE_FIELDS, READONLY_PROFILE_ID, MIRROR_PROFILE: clone(MIRROR_PROFILE), NEW_PROFILE_SETTINGS: clone(NEW_PROFILE_SETTINGS), createRepository, ...defaultRepository };
}));
