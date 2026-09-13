/**
 * Portable, encrypted backups for connection-profile definitions.
 * The embedded key deliberately provides transport/privacy protection only:
 * anyone with the ZeroChat source can recover it.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('node:crypto').webcrypto);
  } else {
    root.ChatProfileBackup = factory(root.crypto);
  }
}(typeof self !== 'undefined' ? self : this, function (cryptoApi) {
  'use strict';

  const FORMAT = 'zerochat-profile-backup';
  const VERSION = 1;
  const MAX_FILE_BYTES = 1024 * 1024;
  const MASTER_KEY = 'ZeroChat profile transfer key v1';

  function cryptoOrThrow() {
    if (!cryptoApi?.subtle || typeof cryptoApi.getRandomValues !== 'function') {
      throw new Error('El navegador no permite cifrar copias de perfiles.');
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
      throw new Error('El archivo de perfiles cifrado no es válido.');
    }
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(value, 'base64'));
    const binary = atob(value);
    return Uint8Array.from(binary, char => char.charCodeAt(0));
  }

  async function getKey() {
    const c = cryptoOrThrow();
    const material = new TextEncoder().encode(MASTER_KEY);
    const digest = await c.subtle.digest('SHA-256', material);
    return c.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  function validateProfiles(profiles) {
    if (!Array.isArray(profiles) || profiles.length > 100) throw new Error('La copia contiene una lista de perfiles no válida.');
    profiles.forEach(profile => {
      if (!profile || typeof profile !== 'object' || Array.isArray(profile) ||
          typeof profile.id !== 'string' || typeof profile.name !== 'string' ||
          !profile.name.trim() || !profile.settings || typeof profile.settings !== 'object' || Array.isArray(profile.settings)) {
        throw new Error('La copia contiene un perfil no válido.');
      }
      if (profile.id.length > 256 || profile.name.length > 256 || String(profile.description || '').length > 10000) {
        throw new Error('La copia contiene campos de perfil demasiado largos.');
      }
    });
    return profiles;
  }

  async function encryptProfiles(profiles) {
    validateProfiles(profiles);
    const c = cryptoOrThrow();
    const plaintext = new TextEncoder().encode(JSON.stringify({ format: FORMAT, version: VERSION, profiles }));
    if (plaintext.byteLength > MAX_FILE_BYTES) throw new Error('La copia de perfiles supera el tamaño permitido.');
    const iv = c.getRandomValues(new Uint8Array(12));
    const ciphertext = await c.subtle.encrypt({ name: 'AES-GCM', iv }, await getKey(), plaintext);
    return JSON.stringify({ format: FORMAT, version: VERSION, algorithm: 'AES-GCM', iv: encodeBase64(iv), ciphertext: encodeBase64(new Uint8Array(ciphertext)) });
  }

  async function encryptApiKey(value) {
    const c = cryptoOrThrow();
    const iv = c.getRandomValues(new Uint8Array(12));
    const ciphertext = await c.subtle.encrypt({ name: 'AES-GCM', iv }, await getKey(), new TextEncoder().encode(String(value || '')));
    return { format: 'zerochat-profile-secret', version: VERSION, algorithm: 'AES-GCM', iv: encodeBase64(iv), ciphertext: encodeBase64(new Uint8Array(ciphertext)) };
  }

  function validateApiKeySecret(secret) {
    if (!secret || typeof secret !== 'object' || Array.isArray(secret) ||
        secret.format !== 'zerochat-profile-secret' || secret.version !== VERSION || secret.algorithm !== 'AES-GCM') {
      throw new Error('La API key cifrada no es válida.');
    }
    const iv = decodeBase64(secret.iv);
    const ciphertext = decodeBase64(secret.ciphertext);
    if (iv.length !== 12 || ciphertext.length < 16) throw new Error('La API key cifrada no es válida.');
    return { iv, ciphertext };
  }

  async function decryptApiKey(secret) {
    const { iv, ciphertext } = validateApiKeySecret(secret);
    const plaintext = await cryptoOrThrow().subtle.decrypt({ name: 'AES-GCM', iv }, await getKey(), ciphertext);
    return new TextDecoder().decode(plaintext);
  }

  async function decryptProfiles(serialized) {
    if (typeof serialized !== 'string' || serialized.length > MAX_FILE_BYTES * 2) throw new Error('El archivo de perfiles supera el tamaño permitido.');
    let envelope;
    try { envelope = JSON.parse(serialized); } catch (_) { throw new Error('El archivo de perfiles no es JSON válido.'); }
    if (!envelope || envelope.format !== FORMAT || envelope.version !== VERSION || envelope.algorithm !== 'AES-GCM') {
      throw new Error('El formato de copia de perfiles no es compatible.');
    }
    try {
      const plaintext = await cryptoOrThrow().subtle.decrypt({ name: 'AES-GCM', iv: decodeBase64(envelope.iv) }, await getKey(), decodeBase64(envelope.ciphertext));
      const document = JSON.parse(new TextDecoder().decode(plaintext));
      if (!document || document.format !== FORMAT || document.version !== VERSION) throw new Error('invalid');
      return validateProfiles(document.profiles);
    } catch (error) {
      if (error?.message?.startsWith('La copia')) throw error;
      throw new Error('No se pudo descifrar o validar la copia de perfiles.');
    }
  }

  return { FORMAT, VERSION, MAX_FILE_BYTES, encryptProfiles, decryptProfiles, encryptApiKey, decryptApiKey, validateApiKeySecret };
}));
