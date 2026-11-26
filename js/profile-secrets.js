/**
 * Cifrado local de las API keys de los perfiles en el navegador (AES-GCM).
 * Sin contraseña se usa una clave integrada que solo evita guardar la clave en claro: cualquiera con
 * el código de ZeroChat puede recuperarla. Con contraseña, la clave se deriva con PBKDF2 y una sal
 * aleatoria propia de este navegador.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('node:crypto').webcrypto, require('./storage.js'));
  } else {
    root.ChatProfileSecrets = factory(root.crypto, root.ChatStorage);
  }
}(typeof self !== 'undefined' ? self : this, function (cryptoApi, Storage) {
  'use strict';

  const SECRET_FORMAT = 'zerochat-profile-secret';
  const VERSION = 2;
  const DEFAULT_KEY = 'ZeroChat local API key';
  const KEY_CACHE = 'crypto_session_v2';
  const KEY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  const PASSWORD_SALT = 'crypto_salt_v1';
  const PASSWORD_SALT_BYTES = 16;
  const PBKDF2_ITERATIONS = 600000;

  function cryptoOrThrow() {
    if (!cryptoApi?.subtle || typeof cryptoApi.getRandomValues !== 'function') {
      throw new Error('This browser cannot encrypt API keys.');
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
      throw new Error('The encrypted API key is not valid.');
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
      digest = new Uint8Array(await c.subtle.digest('SHA-256', new TextEncoder().encode(DEFAULT_KEY)));
    }
    return c.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  function getCachedKeyMaterial() {
    try {
      const value = JSON.parse(Storage.getStorageItem(KEY_CACHE) || 'null');
      if (Number.isFinite(value?.expiresAt) && value.expiresAt > Date.now() && decodeBase64(value.keyHash).length === 32) {
        return value.keyHash;
      }
    } catch (_) { /* caché corrupta: se descarta */ }
    Storage.deleteStorageItem(KEY_CACHE);
    return null;
  }

  function cacheKeyMaterial(keyHash, ttlMs = KEY_CACHE_TTL_MS) {
    if (decodeBase64(keyHash).length !== 32 || !Number.isFinite(ttlMs) || ttlMs < 1) return false;
    Storage.setStorageItem(KEY_CACHE, JSON.stringify({ keyHash, expiresAt: Date.now() + ttlMs }));
    return true;
  }

  const clearCachedKeyMaterial = () => Storage.deleteStorageItem(KEY_CACHE);

  /** Sal de las contraseñas de este navegador; se crea la primera vez que se usa. */
  function passwordSalt() {
    const stored = Storage.getStorageItem(PASSWORD_SALT);
    if (stored) {
      const salt = decodeBase64(stored);
      if (salt.length !== PASSWORD_SALT_BYTES) throw new Error('The encryption salt is not valid.');
      return salt;
    }
    const salt = cryptoOrThrow().getRandomValues(new Uint8Array(PASSWORD_SALT_BYTES));
    Storage.setStorageItem(PASSWORD_SALT, encodeBase64(salt));
    return salt;
  }

  async function keyMaterialFromPassword(password) {
    if (typeof password !== 'string' || !password) throw new Error('The encryption password is not valid.');
    const subtle = cryptoOrThrow().subtle;
    const base = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: passwordSalt(), iterations: PBKDF2_ITERATIONS }, base, 256);
    return encodeBase64(new Uint8Array(bits));
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

  async function encryptApiKey(value, keyMaterial = getCachedKeyMaterial()) {
    const c = cryptoOrThrow();
    const iv = c.getRandomValues(new Uint8Array(12));
    const ciphertext = await c.subtle.encrypt({ name: 'AES-GCM', iv }, await getKey(keyMaterial), new TextEncoder().encode(String(value || '')));
    return { format: SECRET_FORMAT, version: VERSION, algorithm: 'AES-GCM', iv: encodeBase64(iv), ciphertext: encodeBase64(new Uint8Array(ciphertext)) };
  }

  /** Cifrada con una versión anterior del formato: ya no se puede abrir y el perfil la olvida. */
  function isOutdatedApiKeySecret(secret) {
    return secret?.format === SECRET_FORMAT && secret.version !== VERSION;
  }

  function validateApiKeySecret(secret) {
    if (!secret || typeof secret !== 'object' || Array.isArray(secret) ||
        secret.format !== SECRET_FORMAT || secret.version !== VERSION || secret.algorithm !== 'AES-GCM') {
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

  return { VERSION, encryptApiKey, decryptApiKey, validateApiKeySecret, isOutdatedApiKeySecret, keyMaterialFromPassword, withPassword, getCachedKeyMaterial, cacheKeyMaterial, clearCachedKeyMaterial };
}));
