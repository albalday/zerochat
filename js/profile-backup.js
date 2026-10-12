/**
 * Portable, encrypted backups for connection-profile definitions.
 * The embedded key deliberately provides transport/privacy protection only:
 * anyone with the ZeroChat source can recover it.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('node:crypto').webcrypto, require('./storage.js'));
  } else {
    root.ChatProfileBackup = factory(root.crypto, root.ChatStorage);
  }
}(typeof self !== 'undefined' ? self : this, function (cryptoApi, Storage) {
  'use strict';

  const FORMAT = 'zerochat-profile-backup';
  const VERSION = 1;
  const MAX_FILE_BYTES = 1024 * 1024;
  const MASTER_KEY = 'ZeroChat profile transfer key v1';
  const KEY_CACHE = 'crypto_session_v1';
  const KEY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

  function cryptoOrThrow() {
    if (!cryptoApi?.subtle || typeof cryptoApi.getRandomValues !== 'function') {
      throw new Error('This browser cannot encrypt profile backups.');
    }
    return cryptoApi;
  }

  function encodeBase64(bytes) {
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
    let binary = '';
    bytes.forEach(byte => { binary += String.fromCharCode(byte); });
    return btoa(binary);
  }

  function decodeBase64(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
      throw new Error('The encrypted profile file is not valid.');
    }
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(value, 'base64'));
    const binary = atob(value);
    return Uint8Array.from(binary, char => char.charCodeAt(0));
  }

  async function getKey(keyMaterial = null) {
    const c = cryptoOrThrow();
    let digest;
    if (keyMaterial) {
      digest = decodeBase64(keyMaterial);
      if (digest.length !== 32) throw new Error('The cached encryption key is not valid.');
    } else {
      const material = new TextEncoder().encode(MASTER_KEY);
      digest = new Uint8Array(await c.subtle.digest('SHA-256', material));
    }
    return c.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  function getCachedKeyMaterial() {
    try {
      const value = JSON.parse(Storage.getStorageItem(KEY_CACHE) || 'null');
      if (value?.version === 1 && Number.isFinite(value.expiresAt) && value.expiresAt > Date.now() && decodeBase64(value.keyHash).length === 32) {
        return value.keyHash;
      }
    } catch (_) { /* caché corrupta: se descarta */ }
    Storage.deleteStorageItem(KEY_CACHE);
    return null;
  }

  function cacheKeyMaterial(keyHash, ttlMs = KEY_CACHE_TTL_MS) {
    if (decodeBase64(keyHash).length !== 32 || !Number.isFinite(ttlMs) || ttlMs < 1) return false;
    Storage.setStorageItem(KEY_CACHE, JSON.stringify({ version: 1, keyHash, expiresAt: Date.now() + ttlMs }));
    return true;
  }

  const clearCachedKeyMaterial = () => Storage.deleteStorageItem(KEY_CACHE);

  async function keyMaterialFromPassword(password) {
    if (typeof password !== 'string' || !password) throw new Error('The encryption password is not valid.');
    return encodeBase64(new Uint8Array(await cryptoOrThrow().subtle.digest('SHA-256', new TextEncoder().encode(password))));
  }

  /**
   * Ejecuta `operation(keyMaterial)` con la clave por defecto y, si exige contraseña, la pide con
   * `requestPassword`, reintenta con la clave derivada y la guarda en caché. Si el usuario cancela,
   * relanza el error PASSWORD_REQUIRED con `cancelled: true`.
   */
  async function withPassword(operation, requestPassword) {
    try {
      return await operation();
    } catch (error) {
      if (error?.code !== 'PASSWORD_REQUIRED' || typeof requestPassword !== 'function') throw error;
      const password = await requestPassword();
      if (password === null || password === undefined) {
        error.cancelled = true;
        throw error;
      }
      const keyMaterial = await keyMaterialFromPassword(password);
      const result = await operation(keyMaterial);
      cacheKeyMaterial(keyMaterial);
      return result;
    }
  }

  function validateProfiles(profiles) {
    if (!Array.isArray(profiles) || profiles.length > 100) throw new Error('The backup contains an invalid profile list.');
    profiles.forEach(profile => {
      if (!profile || typeof profile !== 'object' || Array.isArray(profile) ||
          typeof profile.id !== 'string' || typeof profile.name !== 'string' ||
          !profile.name.trim() || !profile.settings || typeof profile.settings !== 'object' || Array.isArray(profile.settings)) {
        throw new Error('The backup contains an invalid profile.');
      }
      if (profile.id.length > 256 || profile.name.length > 256 || String(profile.description || '').length > 10000) {
        throw new Error('The backup contains profile fields that are too long.');
      }
    });
    return profiles;
  }

  async function encryptProfiles(profiles, keyMaterial = getCachedKeyMaterial()) {
    validateProfiles(profiles);
    const c = cryptoOrThrow();
    const plaintext = new TextEncoder().encode(JSON.stringify({ format: FORMAT, version: VERSION, profiles }));
    if (plaintext.byteLength > MAX_FILE_BYTES) throw new Error('The profile backup exceeds the allowed size.');
    const iv = c.getRandomValues(new Uint8Array(12));
    const ciphertext = await c.subtle.encrypt({ name: 'AES-GCM', iv }, await getKey(keyMaterial), plaintext);
    return JSON.stringify({ format: FORMAT, version: VERSION, algorithm: 'AES-GCM', iv: encodeBase64(iv), ciphertext: encodeBase64(new Uint8Array(ciphertext)) });
  }

  async function encryptApiKey(value, keyMaterial = getCachedKeyMaterial()) {
    const c = cryptoOrThrow();
    const iv = c.getRandomValues(new Uint8Array(12));
    const ciphertext = await c.subtle.encrypt({ name: 'AES-GCM', iv }, await getKey(keyMaterial), new TextEncoder().encode(String(value || '')));
    return { format: 'zerochat-profile-secret', version: VERSION, algorithm: 'AES-GCM', iv: encodeBase64(iv), ciphertext: encodeBase64(new Uint8Array(ciphertext)) };
  }

  function validateApiKeySecret(secret) {
    if (!secret || typeof secret !== 'object' || Array.isArray(secret) ||
        secret.format !== 'zerochat-profile-secret' || secret.version !== VERSION || secret.algorithm !== 'AES-GCM') {
      throw new Error('The encrypted API key is not valid.');
    }
    const iv = decodeBase64(secret.iv);
    const ciphertext = decodeBase64(secret.ciphertext);
    if (iv.length !== 12 || ciphertext.length < 16) throw new Error('The encrypted API key is not valid.');
    return { iv, ciphertext };
  }

  async function decryptApiKey(secret, keyMaterial = getCachedKeyMaterial()) {
    const { iv, ciphertext } = validateApiKeySecret(secret);
    const c = cryptoOrThrow();
    try {
      const plaintext = await c.subtle.decrypt({ name: 'AES-GCM', iv }, await getKey(), ciphertext);
      return new TextDecoder().decode(plaintext);
    } catch (defaultError) {
      if (!keyMaterial) throw Object.assign(new Error('The encryption password is required to open this API key.'), { code: 'PASSWORD_REQUIRED' });
      try {
        const plaintext = await c.subtle.decrypt({ name: 'AES-GCM', iv }, await getKey(keyMaterial), ciphertext);
        return new TextDecoder().decode(plaintext);
      } catch (_) {
        throw Object.assign(new Error('The encryption password is wrong or the API key is damaged.'), { code: 'PASSWORD_REQUIRED' });
      }
    }
  }

  async function decryptProfiles(serialized, keyMaterial = getCachedKeyMaterial()) {
    if (typeof serialized !== 'string' || serialized.length > MAX_FILE_BYTES * 2) throw new Error('The profile file exceeds the allowed size.');
    let envelope;
    try { envelope = JSON.parse(serialized); } catch (_) { throw new Error('The profile file is not valid JSON.'); }
    if (!envelope || envelope.format !== FORMAT || envelope.version !== VERSION || envelope.algorithm !== 'AES-GCM') {
      throw new Error('The profile backup format is not supported.');
    }
    try {
      let plaintext;
      try {
        plaintext = await cryptoOrThrow().subtle.decrypt({ name: 'AES-GCM', iv: decodeBase64(envelope.iv) }, await getKey(), decodeBase64(envelope.ciphertext));
      } catch (_) {
        if (!keyMaterial) throw Object.assign(new Error('The encryption password is required to open this backup.'), { code: 'PASSWORD_REQUIRED' });
        plaintext = await cryptoOrThrow().subtle.decrypt({ name: 'AES-GCM', iv: decodeBase64(envelope.iv) }, await getKey(keyMaterial), decodeBase64(envelope.ciphertext));
      }
      const document = JSON.parse(new TextDecoder().decode(plaintext));
      if (!document || document.format !== FORMAT || document.version !== VERSION) throw new Error('invalid');
      return validateProfiles(document.profiles);
    } catch (error) {
      if (error?.code === 'PASSWORD_REQUIRED') throw error;
      if (error?.message?.startsWith('La copia')) throw error;
      throw new Error('The profile backup could not be decrypted or validated.');
    }
  }

  return { FORMAT, VERSION, MAX_FILE_BYTES, KEY_CACHE_TTL_MS, encryptProfiles, decryptProfiles, encryptApiKey, decryptApiKey, validateApiKeySecret, keyMaterialFromPassword, withPassword, getCachedKeyMaterial, cacheKeyMaterial, clearCachedKeyMaterial };
}));
