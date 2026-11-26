/**
 * Versioned repository for editable profiles.
 * Runtime consumers must use ChatConfig instead of reading this repository.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./storage.js'), require('./profile-backup.js'), require('./utils.js'), require('./defaults.js'));
  } else {
    root.ChatProfileRepository = factory(root.ChatStorage, root.ChatProfileBackup, root.ChatUtils, root.ChatDefaults);
  }
}(typeof self !== 'undefined' ? self : this, function (Storage, Backup, Utils, Defaults) {
  'use strict';

  const STORAGE_KEY = 'profiles_v1';
  const SCHEMA_VERSION = 1;
  const READONLY_PROFILE_ID = 'profile:mirror';
  const PROFILE_FIELDS = Object.freeze([
    'apiUrl', 'apiType', 'model', 'contextWindow', 'systemPrompt', 'temperature',
    'reasoningEffort', 'modelReasoningConfig',
    'enableRawLogs', 'enableContextCache', 'webllmConfig', 'apiKeyLocked'
  ]);
  const STORAGE_PROFILE_FIELDS = Object.freeze([...PROFILE_FIELDS, 'apiKey']);

  const { clone } = Utils;

  function createId(name) {
    return `profile:${encodeURIComponent(String(name || '').trim())}`;
  }

  const NEW_PROFILE_SETTINGS = Object.freeze({
    apiUrl: 'http://localhost:1234/v1', apiType: 'openai', model: '', contextWindow: null, systemPrompt: '',
    temperature: '0.7', reasoningEffort: 'medium', modelReasoningConfig: null,
    enableRawLogs: false, enableContextCache: true, apiKeyLocked: false,
    webllmConfig: {
      context_window_size: String(Defaults.WEBLLM_DEFAULT_CONTEXT_WINDOW_SIZE),
      prefill_chunk_size: 'default'
    }
  });

  const MIRROR_PROFILE = Object.freeze({
    id: READONLY_PROFILE_ID,
    name: 'Espejo',
    description: '',
    settings: {
      ...NEW_PROFILE_SETTINGS, apiUrl: 'mirror://local', apiType: 'mirror', model: 'mirror'
    }
  });

  function validTimestamp(value, fallback = Date.now()) {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? num : fallback;
  }

  function normalizeSettings(source = {}, isGeneral = false) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('The profile data is not valid.');
    const settings = {};
    STORAGE_PROFILE_FIELDS.forEach(key => {
      if (key === 'apiKey') {
        if (source[key] === '' || source[key] === null || source[key] === undefined) {
          settings.apiKey = null;
          return;
        }
        if (isGeneral && typeof source[key] === 'string') {
          settings.apiKey = source[key];
          return;
        }
        Backup.validateApiKeySecret(source[key]);
      }
      if (key === 'contextWindow') {
        if (source[key] === '' || source[key] === null || source[key] === undefined) {
          settings.contextWindow = null;
          return;
        }
        const num = Number(source[key]);
        settings.contextWindow = Number.isFinite(num) && num > 0 ? Math.floor(num) : null;
        return;
      }
      if (source[key] !== undefined) settings[key] = clone(source[key]);
    });
    return settings;
  }

  function normalizeRecord(record = {}, isGeneral = false) {
    const name = String(record.name || '').trim();
    if (!name) throw new Error('The profile name cannot be empty.');
    const general = Boolean(isGeneral);
    const settings = normalizeSettings(record.settings || record, general);
    const hasLocalSecret = Boolean(settings.apiKey && (typeof settings.apiKey === 'object' || typeof settings.apiKey === 'string'));
    return {
      id: String(record.id || createId(name)),
      name,
      description: String(record.description || '').trim(),
      general,
      synced: general ? false : Boolean(record.synced),
      hasApiKey: record.hasApiKey !== undefined ? Boolean(record.hasApiKey) : hasLocalSecret,
      schemaVersion: SCHEMA_VERSION,
      version: Number.isInteger(record.version) && record.version > 0 ? record.version : 1,
      updatedAt: validTimestamp(record.updatedAt),
      settings
    };
  }

  function readDocument() {
    const raw = Storage.getStorageItem(STORAGE_KEY);
    if (!raw) return null;
    let doc;
    try {
      doc = JSON.parse(raw);
    } catch (_) {
      throw new Error('The profile storage is not valid JSON.');
    }
    if (!doc || doc.schemaVersion !== SCHEMA_VERSION || !Array.isArray(doc.profiles)) {
      throw new Error('The profile storage has an invalid format.');
    }
    const serverId = typeof doc.serverId === 'string' && doc.serverId.trim() ? doc.serverId.trim() : null;
    return {
      schemaVersion: SCHEMA_VERSION,
      serverId,
      profiles: doc.profiles.map(rec => normalizeRecord(rec))
    };
  }

  function writeDocument(document) {
    Storage.setStorageItem(STORAGE_KEY, JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      serverId: document.serverId || null,
      profiles: document.profiles
    }));
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

    const document = { schemaVersion: SCHEMA_VERSION, serverId: null, profiles: [normalizeRecord(MIRROR_PROFILE)] };
    writeDocument(document);
    return clone(document);
  }

  // Perfiles del servidor que una ejecución en el servidor usa solo en memoria: el suyo y los que
  // switch_model puede activar. No se guardan ni aparecen en list().
  const sessionProfiles = new Map();
  // Los que llegan sin su API key (`{ keyless: true }`): load() la pide a sessionKeyLoader la primera vez que
  // se usan, para que del servidor solo salga la clave del perfil que se activa.
  const keylessSessionProfiles = new Set();
  let sessionKeyLoader = null;

  function registerSessionProfile(profile, { keyless = false } = {}) {
    if (!profile || typeof profile !== 'object') {
      clearSessionProfile();
      return null;
    }
    const name = String(profile.name || '').trim();
    if (!name) throw new Error('The profile name cannot be empty.');
    const rawApiKey = typeof profile.apiKey === 'string'
      ? profile.apiKey
      : (typeof profile.settings?.apiKey === 'string' ? profile.settings.apiKey : '');
    const sourceSettings = profile.settings || {};
    const settings = { ...sourceSettings, apiKey: rawApiKey };
    const record = normalizeRecord({ ...profile, settings }, true);
    sessionProfiles.set(record.id, record);
    if (keyless) keylessSessionProfiles.add(record.id);
    else keylessSessionProfiles.delete(record.id);
    return clone(record);
  }

  /** `loader(id)` devuelve el perfil completo, con su API key, de un perfil de sesión registrado sin ella. */
  function setSessionKeyLoader(loader) {
    sessionKeyLoader = typeof loader === 'function' ? loader : null;
  }

  function listSessionProfiles() {
    return [...sessionProfiles.values()].map(clone);
  }

  function clearSessionProfile() {
    sessionProfiles.clear();
    keylessSessionProfiles.clear();
  }

  function list() {
    return initialize().profiles;
  }

  function get(id) {
    const cleanId = String(id || '');
    const session = sessionProfiles.get(cleanId) || [...sessionProfiles.values()].find(profile => profile.name === cleanId);
    if (session) return clone(session);
    return list().find(profile => profile.id === cleanId) || null;
  }

  async function load(id, keyMaterial = null) {
    const profile = get(id);
    if (!profile) return null;
    if (keylessSessionProfiles.has(profile.id) && sessionKeyLoader) {
      const full = await sessionKeyLoader(profile.id);
      if (full?.id !== profile.id) throw new Error(`The local server did not return the profile ${profile.name}.`);
      registerSessionProfile(full);
      return load(profile.id, keyMaterial);
    }
    const cloned = clone(profile);
    if (cloned.general) {
      cloned.settings = cloned.settings || {};
      if (typeof cloned.settings.apiKey !== 'string') {
        cloned.settings.apiKey = '';
      }
      return cloned;
    }
    const secret = cloned.settings.apiKey;
    cloned.settings.apiKey = secret ? await Backup.decryptApiKey(secret, keyMaterial || undefined) : '';
    return cloned;
  }

  // La interfaz de perfiles fija al montarse cómo pedir la contraseña de cifrado actual; sin ella,
  // cargar un perfil con la API key cifrada por contraseña falla con PASSWORD_REQUIRED.
  let requestPassword = null;

  /** `request()` pide la contraseña de cifrado actual y resuelve null si el usuario cancela. */
  function setPasswordPrompt(request) {
    requestPassword = request;
  }

  /** Perfil con su API key descifrada; pide la contraseña si está cifrada con ella. Los fallos se propagan. */
  async function loadUnlocked(id) {
    if (!id) return null;
    return Backup.withPassword(keyMaterial => load(id, keyMaterial), requestPassword);
  }

  function findByName(name) {
    const cleanName = String(name || '').trim();
    if (!cleanName) return null;
    const session = [...sessionProfiles.values()].find(profile => profile.name === cleanName);
    if (session) return clone(session);
    return list().find(profile => profile.name === cleanName) || null;
  }

  function save(record, { synced = false, preserveUpdatedAt = false } = {}) {
    const current = initialize();
    const normalized = normalizeRecord(record, false);
    if (normalized.id === READONLY_PROFILE_ID || normalized.name === MIRROR_PROFILE.name) {
      throw new Error('The Mirror profile cannot be modified.');
    }
    const index = current.profiles.findIndex(profile => profile.id === normalized.id);
    if (index >= 0) {
      if (!preserveUpdatedAt && current.profiles[index].settings.apiKeyLocked === true) {
        throw new Error('Changes to this profile are locked.');
      }
      normalized.version = preserveUpdatedAt
        ? Math.max(current.profiles[index].version, Number(record.version) || 1)
        : current.profiles[index].version + 1;
    }
    normalized.updatedAt = preserveUpdatedAt ? validTimestamp(record.updatedAt) : Date.now();
    normalized.synced = Boolean(synced);
    if (index >= 0) current.profiles[index] = normalized;
    else current.profiles.push(normalized);
    writeDocument(current);
    return clone(normalized);
  }

  async function saveEditable(record, options = {}) {
    if (typeof record?.settings?.apiKey !== 'string') throw new Error('The profile API key is not valid.');
    const rawKey = record.settings.apiKey;
    const apiKey = rawKey ? await Backup.encryptApiKey(rawKey) : null;
    return save({ ...record, hasApiKey: Boolean(rawKey), settings: { ...record.settings, apiKey } }, options);
  }

  async function recipherApiKeys(currentKeyMaterial, nextKeyMaterial) {
    const current = initialize();
    const rewritten = [];
    let reciphered = 0;
    for (const profile of current.profiles) {
      if (profile.id === READONLY_PROFILE_ID || !profile.settings.apiKey) {
        rewritten.push(profile);
        continue;
      }
      const apiKey = await Backup.decryptApiKey(profile.settings.apiKey, currentKeyMaterial);
      const encrypted = await Backup.encryptApiKey(apiKey, nextKeyMaterial);
      rewritten.push({ ...profile, version: profile.version + 1, settings: { ...profile.settings, apiKey: encrypted } });
      reciphered += 1;
    }
    writeDocument({ ...current, profiles: rewritten });
    return reciphered;
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
    const cleanId = String(id || '');
    if (cleanId === READONLY_PROFILE_ID) return false;
    const current = initialize();
    const index = current.profiles.findIndex(profile => profile.id === cleanId);
    if (index < 0) return false;
    current.profiles.splice(index, 1);
    writeDocument(current);
    return true;
  }

  function mergeImported(records) {
    if (!Array.isArray(records) || records.length > 100) throw new Error('The imported profile list is not valid.');
    const current = initialize();
    const imported = records.map(rec => normalizeRecord(rec, false)).filter(profile => profile.id !== READONLY_PROFILE_ID && profile.name !== MIRROR_PROFILE.name);
    if (imported.length !== records.length) throw new Error(`The backup cannot modify the ${MIRROR_PROFILE.name} profile.`);
    const ids = new Set();
    const names = new Set();
    imported.forEach(profile => {
      if (ids.has(profile.id) || names.has(profile.name)) throw new Error('The backup contains duplicate profiles.');
      ids.add(profile.id); names.add(profile.name);
    });
    const editable = current.profiles.filter(profile => profile.id !== READONLY_PROFILE_ID);
    const byId = new Map(editable.map(profile => [profile.id, profile]));
    const existingNames = new Map(editable.map(profile => [profile.name, profile.id]));
    let added = 0;
    let replaced = 0;
    imported.forEach(profile => {
      const nameOwner = existingNames.get(profile.name);
      if (nameOwner && nameOwner !== profile.id) throw new Error(`A profile named "${profile.name}" already exists with another identifier.`);
      if (byId.has(profile.id)) replaced += 1;
      else added += 1;
      byId.set(profile.id, { ...profile, synced: false });
    });
    writeDocument({ ...current, profiles: [normalizeRecord(MIRROR_PROFILE), ...byId.values()] });
    return { added, replaced, total: imported.length };
  }

  async function resolveRemoteApiKey(remote, existing, revealRemote) {
    if (!remote.hasApiKey) return null;
    const isNewer = !existing || (validTimestamp(remote.updatedAt, 0) > validTimestamp(existing.updatedAt, 0));
    if (!isNewer && existing.settings?.apiKey) {
      return existing.settings.apiKey;
    }
    if (typeof revealRemote !== 'function') return null;
    const revealed = await revealRemote(remote.id);
    if (revealed?.id !== remote.id) {
      throw new Error(`The local server did not return the profile ${remote.name}.`);
    }
    const rawKey = typeof revealed.settings?.apiKey === 'string' ? revealed.settings.apiKey : '';
    return rawKey ? Backup.encryptApiKey(rawKey) : null;
  }

  async function remoteToLocalRecord(remote, { existing = null, revealRemote = null } = {}) {
    const apiKey = await resolveRemoteApiKey(remote, existing, revealRemote);
    return normalizeRecord({
      id: remote.id,
      name: remote.name,
      description: remote.description || '',
      synced: true,
      hasApiKey: Boolean(apiKey || (!revealRemote && remote.hasApiKey)),
      version: existing ? Math.max(existing.version, Number(remote.version) || 1) : (Number(remote.version) || 1),
      updatedAt: validTimestamp(remote.updatedAt),
      settings: {
        ...(remote.settings || {}),
        apiKey
      }
    }, false);
  }

  async function buildRemoteUploadPayload(local, passwordPrompt) {
    const settings = { ...local.settings };
    if (local.settings.apiKey) {
      settings.apiKey = await Backup.withPassword(
        keyMaterial => Backup.decryptApiKey(local.settings.apiKey, keyMaterial),
        passwordPrompt
      );
    } else if (local.hasApiKey) {
      delete settings.apiKey;
    } else {
      settings.apiKey = '';
    }
    return {
      id: local.id,
      name: local.name,
      description: local.description,
      updatedAt: local.updatedAt,
      settings
    };
  }

  /**
   * Sincroniza la lista única del navegador con un servidor identificado por `serverId`.
   * Conserva el `updatedAt` de origen y, si el servidor cambia respecto al guardado, consulta `onServerChange`.
   */
  async function syncWithBackend({ serverId, listRemote, saveRemote, revealRemote = null, onServerChange = null, onPasswordRequired = requestPassword }) {
    const cleanServerId = typeof serverId === 'string' ? serverId.trim() : '';
    if (!cleanServerId) throw new Error('The backend server identifier is required.');

    const doc = initialize();
    let editableLocal = doc.profiles.filter(profile => profile.id !== READONLY_PROFILE_ID);
    const remoteList = (await listRemote()).filter(profile => profile?.id && profile.id !== READONLY_PROFILE_ID);

    const serverChanged = Boolean(doc.serverId && doc.serverId !== cleanServerId);
    const firstServerConflict = Boolean(!doc.serverId && editableLocal.length > 0 && remoteList.length > 0);
    if ((serverChanged && editableLocal.length > 0) || firstServerConflict) {
      const choice = typeof onServerChange === 'function'
        ? await onServerChange({
          previousServerId: doc.serverId,
          nextServerId: cleanServerId,
          localCount: editableLocal.length,
          remoteCount: remoteList.length
        })
        : 'merge';
      if (choice !== 'merge') return { cancelled: true, serverId: doc.serverId };
      editableLocal = editableLocal.map(profile => ({ ...profile, synced: false }));
    }

    const remoteMap = new Map(remoteList.map(profile => [profile.id, profile]));
    const nextProfiles = [];
    let uploaded = 0;
    let downloaded = 0;
    let deletedLocal = 0;
    let pendingPassword = 0;

    const pushLocal = async local => {
      try {
        const payload = await buildRemoteUploadPayload(local, onPasswordRequired);
        const saved = await saveRemote(payload);
        nextProfiles.push(normalizeRecord({
          ...local,
          version: Math.max(local.version, Number(saved?.version) || 1),
          updatedAt: validTimestamp(saved?.updatedAt, local.updatedAt),
          synced: true
        }, false));
        uploaded += 1;
      } catch (error) {
        if (error?.code === 'PASSWORD_REQUIRED' && error.cancelled) {
          nextProfiles.push(normalizeRecord({ ...local, synced: false }, false));
          pendingPassword += 1;
          return;
        }
        throw error;
      }
    };

    for (const local of editableLocal) {
      const remote = remoteMap.get(local.id);
      if (!remote) {
        if (local.synced) {
          deletedLocal += 1;
          continue;
        }
        await pushLocal(local);
        continue;
      }

      remoteMap.delete(local.id);
      const localTime = validTimestamp(local.updatedAt, 0);
      const remoteTime = validTimestamp(remote.updatedAt, 0);
      if (remoteTime > localTime) {
        nextProfiles.push(await remoteToLocalRecord(remote, { existing: local, revealRemote }));
        downloaded += 1;
      } else if (localTime > remoteTime) {
        await pushLocal(local);
      } else {
        nextProfiles.push(await remoteToLocalRecord(remote, { existing: local, revealRemote }));
      }
    }

    for (const remote of remoteMap.values()) {
      nextProfiles.push(await remoteToLocalRecord(remote, { revealRemote }));
      downloaded += 1;
    }

    writeDocument({
      schemaVersion: SCHEMA_VERSION,
      serverId: cleanServerId,
      profiles: [normalizeRecord(MIRROR_PROFILE), ...nextProfiles]
    });

    return {
      cancelled: false,
      serverId: cleanServerId,
      uploaded,
      downloaded,
      deletedLocal,
      pendingPassword
    };
  }

  return {
    STORAGE_KEY, PROFILE_FIELDS, READONLY_PROFILE_ID, NEW_PROFILE_SETTINGS: clone(NEW_PROFILE_SETTINGS),
    createId, initialize, list, get, load, setPasswordPrompt, loadUnlocked, findByName, save, saveEditable, verifyApiKeyMaterial, recipherApiKeys, remove, mergeImported, syncWithBackend,
    registerSessionProfile, setSessionKeyLoader, listSessionProfiles, clearSessionProfile
  };
}));
