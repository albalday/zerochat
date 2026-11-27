/**
 * Ofuscación local de las API keys de los perfiles en el navegador (AES-GCM con una clave integrada): evita
 * guardarlas en claro, pero cualquiera con el código de ZeroChat puede recuperarlas, como el XOR del backend
 * (M75-D3). Las protege lo mismo que a SQLite: la carpeta del perfil del navegador, solo de su usuario.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('node:crypto').webcrypto);
  } else {
    root.ChatProfileSecrets = factory(root.crypto);
  }
}(typeof self !== 'undefined' ? self : this, function (cryptoApi) {
  'use strict';

  const SECRET_FORMAT = 'zerochat-profile-secret';
  const VERSION = 2;
  const DEFAULT_KEY = 'ZeroChat local API key';

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

  async function getKey() {
    const c = cryptoOrThrow();
    const digest = new Uint8Array(await c.subtle.digest('SHA-256', new TextEncoder().encode(DEFAULT_KEY)));
    return c.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  async function encryptApiKey(value) {
    const c = cryptoOrThrow();
    const iv = c.getRandomValues(new Uint8Array(12));
    const ciphertext = await c.subtle.encrypt({ name: 'AES-GCM', iv }, await getKey(), new TextEncoder().encode(String(value || '')));
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

  /** API key descifrada; una que no se puede abrir (dañada o de otro cifrado) lanza API_KEY_UNREADABLE. */
  async function decryptApiKey(secret) {
    const { iv, ciphertext } = validateApiKeySecret(secret);
    const subtle = cryptoOrThrow().subtle;
    const key = await getKey();
    try {
      const plaintext = await subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
      return new TextDecoder().decode(plaintext);
    } catch (_) {
      throw Object.assign(new Error('The stored API key cannot be opened.'), { code: 'API_KEY_UNREADABLE' });
    }
  }

  return { encryptApiKey, decryptApiKey, validateApiKeySecret, isOutdatedApiKeySecret };
}));
