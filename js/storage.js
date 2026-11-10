/**
 * Almacenamiento de ZeroChat (ChatStorage):
 * - Preferencias y documentos ligeros en localStorage, con el prefijo propio de la aplicación.
 * - Sesión efímera del backend local en una cookie.
 * - Conversaciones y mensajes en IndexedDB (ZeroChatDB), en el orden de la conversación.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./utils.js'), require('./storage-db.js'));
  } else {
    root.ChatStorage = factory(root.ChatUtils, root.ZeroChatDB);
  }
})(typeof self !== 'undefined' ? self : this, function (Utils, Database) {
  'use strict';

  const { createId, normalizeBackendUrl, resolveDep } = Utils;
  const { STORES, openDatabase, requestResult, transactionDone, deleteByIndex, getAllByIndex } = Database;

  const STORAGE_PREFIX = 'zerochat_';
  const BACKEND_SESSION_COOKIE = 'zerochat_backend_session_v1';
  const BACKEND_SESSION_MAX_AGE_SECONDS = 26 * 60 * 60;
  // Campos opcionales de un mensaje que se guardan cuando están presentes.
  const OPTIONAL_MESSAGE_FIELDS = ['tool_calls', 'tool_call_id', 'name', 'stats', 'contextDateAnchor', 'images', 'commandNotes', '_isSummaryBlock', '_compressedMetadata'];
  let lastClearAllStorageError = '';
  const memoryStorageFallback = new Map();

  function getWebStorage() {
    try {
      if (typeof localStorage !== 'undefined') return localStorage;
    } catch (_) {
      // Web storage unavailable or blocked by environment
    }
    return {
      getItem: key => memoryStorageFallback.get(key) ?? null,
      setItem: (key, value) => memoryStorageFallback.set(key, String(value ?? '')),
      removeItem: key => memoryStorageFallback.delete(key)
    };
  }

  function setStorageItem(name, value) {
    try {
      getWebStorage().setItem(`${STORAGE_PREFIX}${name}`, String(value ?? ''));
    } catch (error) {
      console.warn(`[ChatStorage] Could not save ${name} in localStorage:`, error);
    }
  }

  const getStorageItem = name => {
    try {
      return getWebStorage().getItem(`${STORAGE_PREFIX}${name}`);
    } catch (_) {
      return null;
    }
  };

  const deleteStorageItem = name => {
    try {
      getWebStorage().removeItem(`${STORAGE_PREFIX}${name}`);
    } catch (_) {
      // Storage unavailable or read-only
    }
  };

  /** Sesión con el backend: su URL y el token diario que dio al abrir la página o al identificarse. */
  function normalizeBackendSession(session) {
    if (!session || typeof session !== 'object' || Array.isArray(session)) return null;
    const token = typeof session.token === 'string' ? session.token : '';
    const url = normalizeBackendUrl(session.url);
    if (!token || token.length > 512 || token.trim() !== token || /[\u0000-\u001f\u007f]/.test(token)) return null;
    return url ? { token, url } : null;
  }

  // Con file:// no hay cookies: el backend local solo existe cuando la página se sirve por HTTP.
  const cookiesAvailable = () => typeof document !== 'undefined' && location.protocol !== 'file:';

  function writeBackendSessionCookie(value, maxAgeSeconds) {
    const secure = location.protocol === 'https:' ? ';Secure' : '';
    document.cookie = `${BACKEND_SESSION_COOKIE}=${encodeURIComponent(value)};Max-Age=${maxAgeSeconds};Path=/;SameSite=Strict${secure}`;
  }

  function setBackendSession(session, maxAgeSeconds = BACKEND_SESSION_MAX_AGE_SECONDS) {
    const normalized = normalizeBackendSession(session);
    if (!normalized || !Number.isInteger(maxAgeSeconds) || maxAgeSeconds < 1 || !cookiesAvailable()) return false;
    writeBackendSessionCookie(JSON.stringify(normalized), maxAgeSeconds);
    return getBackendSession() !== null;
  }

  function getBackendSession() {
    if (!cookiesAvailable()) return null;
    const prefix = `${BACKEND_SESSION_COOKIE}=`;
    const cookie = document.cookie.split(';').map(part => part.trim()).find(part => part.startsWith(prefix));
    if (!cookie) return null;
    try {
      return normalizeBackendSession(JSON.parse(decodeURIComponent(cookie.slice(prefix.length))));
    } catch (_) {
      return null;
    }
  }

  function loadRuntimeConfigV2() {
    const raw = getStorageItem('runtime_config_v2');
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  function saveRuntimeConfigV2(config) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error('The runtime configuration must be an object.');
    }
    setStorageItem('runtime_config_v2', JSON.stringify(config));
    return true;
  }

  // El origen (albalday.github.io) es compartido con otras aplicaciones: el borrado completo solo
  // toca las claves propias de ZeroChat.
  function removeOwnedStorageKeys(storage) {
    const keys = [];
    for (let i = 0; i < storage.length; i++) keys.push(storage.key(i));
    keys.filter(key => key.startsWith(STORAGE_PREFIX)).forEach(key => storage.removeItem(key));
  }

  // Errores con los que Chromium rechaza OPFS y Service Workers en file://, donde ZeroChat no los usa.
  const isUnsupportedOriginError = error => ['SecurityError', 'NotSupportedError', 'InvalidStateError'].includes(error?.name)
    || /origin .*not supported|URL protocol .*not supported/i.test(error?.message || '');

  const RESET_OPERATIONS = [
    ['localStorage', () => removeOwnedStorageKeys(localStorage)],
    ['sessionStorage', () => removeOwnedStorageKeys(sessionStorage)],
    ['Cookies', () => { if (cookiesAvailable()) writeBackendSessionCookie('', 0); }],
    ['ZeroChat IndexedDB', () => Database.deleteOriginDatabases()],
    ['Cache Storage', async () => {
      if (typeof caches === 'undefined') return;
      const results = await Promise.allSettled((await caches.keys()).map(name => caches.delete(name)));
      if (results.some(result => result.status === 'rejected')) throw new Error('Cache Storage deletion failed.');
    }],
    ['OPFS', async () => {
      if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return;
      try {
        const root = await navigator.storage.getDirectory();
        const removals = [];
        for await (const name of root.keys()) removals.push(root.removeEntry(name, { recursive: true }));
        const results = await Promise.allSettled(removals);
        if (results.some(result => result.status === 'rejected')) throw new Error('OPFS deletion failed.');
      } catch (error) {
        if (!isUnsupportedOriginError(error)) throw error;
      }
    }],
    ['Service Workers', async () => {
      if (typeof navigator === 'undefined' || !navigator.serviceWorker?.getRegistrations) return;
      try {
        await Promise.all((await navigator.serviceWorker.getRegistrations()).map(registration => registration.unregister()));
      } catch (error) {
        if (!isUnsupportedOriginError(error)) throw error;
      }
    }]
  ];

  /** Borra todos los datos locales de ZeroChat; si algo falla, getLastClearAllStorageError() da el motivo. */
  async function clearAllStorage() {
    const results = await Promise.allSettled(RESET_OPERATIONS.map(async ([, run]) => run()));
    const failures = results
      .map((result, index) => result.status === 'rejected'
        ? `${RESET_OPERATIONS[index][0]}: ${result.reason?.message || result.reason || 'unknown error'}`
        : '')
      .filter(Boolean);
    lastClearAllStorageError = failures.join(' · ');
    if (failures.length) console.warn('[ChatStorage] Complete local-data reset failed:', lastClearAllStorageError);
    return failures.length === 0;
  }

  const getLastClearAllStorageError = () => lastClearAllStorageError;

  // ==========================================================================
  // Conversaciones y mensajes en IndexedDB
  // ==========================================================================

  /** Ejecuta una operación de IndexedDB; si falla, avisa y propaga el error estructurado. */
  async function attempt(action, operation) {
    try {
      return await operation(await Database.openDatabase());
    } catch (error) {
      console.warn(`[ChatStorage] Could not ${action}:`, error);
      const wrapped = new Error(`Could not ${action}: ${error?.message || String(error)}`, { cause: error });
      wrapped.code = 'STORAGE_ERROR';
      wrapped.action = action;
      throw wrapped;
    }
  }

  const getMCP = () => resolveDep('ChatMCP', './mcp.js');
  const isBackendConnected = () => getMCP().manager.isProxyConnected();
  const requestBackend = (method, params = {}, options = {}) => getMCP().manager.requestExternalControl(method, params, options);

  const conversationRange = id => IDBKeyRange.bound([id, -Infinity], [id, Infinity]);

  function toConversationHeader(record) {
    const { id, title, createdAt, updatedAt, messageCount, profileId, serverRun, extra } = record;
    const isServerRun = serverRun !== undefined ? Boolean(serverRun) : (extra?.server_run !== undefined ? Boolean(extra.server_run) : undefined);
    return {
      id,
      title,
      createdAt,
      updatedAt,
      messageCount,
      ...(profileId ? { profileId } : {}),
      ...(isServerRun !== undefined ? { serverRun: isServerRun } : {}),
      ...(extra ? { extra } : {})
    };
  }

  function toMessageRecord(message, conversationId, position, messageId) {
    const record = {
      id: `${conversationId}:${position}`,
      messageId,
      conversationId,
      position,
      role: message.role || 'user',
      content: message.content !== undefined ? message.content : ''
    };
    for (const field of OPTIONAL_MESSAGE_FIELDS) if (message[field]) record[field] = message[field];
    return record;
  }

  const fromMessageRecord = ({ id, messageId, conversationId, position, ...message }) => ({
    id: messageId || id,
    ...message
  });

  function readLocalConversationsList() {
    return attempt('read the conversation list', async db => {
      const store = db.transaction(STORES.conversations, 'readonly').objectStore(STORES.conversations);
      const records = await requestResult(store.index('by_updatedAt').getAll());
      return records.reverse().map(toConversationHeader);
    });
  }

  async function readLocalConversation(sessionId) {
    const conversation = await attempt('read the conversation', async db => {
      const tx = db.transaction([STORES.conversations, STORES.messages], 'readonly');
      const conversation = await requestResult(tx.objectStore(STORES.conversations).get(sessionId));
      if (!conversation) return null;
      const messages = await getAllByIndex(tx.objectStore(STORES.messages), 'by_conversation', conversationRange(sessionId));
      return { ...toConversationHeader(conversation), history: messages.map(fromMessageRecord) };
    });
    if (conversation?.history) {
      await hydrateMessageImages(conversation.history);
    }
    return conversation;
  }

  function writeLocalConversation(sessionMeta, messages = []) {
    const sessionId = sessionMeta.id;
    const now = Date.now();
    return attempt('save the conversation', async db => {
      const tx = db.transaction([STORES.conversations, STORES.messages], 'readwrite');
      tx.objectStore(STORES.conversations).put({
        id: sessionId,
        title: sessionMeta.title || '',
        createdAt: sessionMeta.createdAt || now,
        updatedAt: sessionMeta.updatedAt || now,
        messageCount: messages.length,
        ...(sessionMeta.profileId ? { profileId: sessionMeta.profileId } : {}),
        ...(sessionMeta.serverRun !== undefined ? { serverRun: Boolean(sessionMeta.serverRun) } : {}),
        ...(sessionMeta.extra ? { extra: sessionMeta.extra } : {})
      });
      const messageStore = tx.objectStore(STORES.messages);
      await deleteByIndex(messageStore, 'by_conversation', conversationRange(sessionId));
      const seenIds = new Set();
      messages.forEach((message, position) => {
        const messageId = message.id && !seenIds.has(message.id) ? message.id : createId(`msg_${sessionId}`);
        seenIds.add(messageId);
        messageStore.put(toMessageRecord(message, sessionId, position, messageId));
      });
      await transactionDone(tx);
      return true;
    });
  }

  /**
   * Cabeceras de las conversaciones, de la más reciente a la más antigua, sin sus mensajes.
   * Con el backend conectado, descarga las conversaciones remotas a IndexedDB antes de devolver la lista
   * sin subir las conversaciones locales al servidor.
   */
  async function getConversationsList() {
    const localList = await readLocalConversationsList();
    if (!isBackendConnected()) return localList;

    const { conversations: remoteList = [] } = await requestBackend('zerochat/conversations/list');
    const localMap = new Map(localList.map(item => [item.id, item]));

    let downloaded = false;
    for (const remote of remoteList) {
      const local = localMap.get(remote.id);
      if (!local || (remote.updatedAt || 0) > (local.updatedAt || 0)) {
        const { conversation: fullRemote } = await requestBackend('zerochat/conversations/get', { id: remote.id });
        if (fullRemote) {
          await writeLocalConversation(remote, fullRemote.history);
          downloaded = true;
        }
      }
    }

    return downloaded ? readLocalConversationsList() : localList;
  }

  /** Conversación completa con sus mensajes en orden; null si no existe. */
  async function getConversation(sessionId) {
    if (!sessionId) return null;
    if (isBackendConnected()) {
      const result = await requestBackend('zerochat/conversations/get', { id: sessionId });
      if (result?.conversation) {
        if (result.conversation.history) {
          await hydrateMessageImages(result.conversation.history);
        }
        return result.conversation;
      }
    }
    return readLocalConversation(sessionId);
  }

  /**
   * Extrae los blobs de imágenes para guardarlos en el store blobs y deja solo referencias ligeras en messages.
   */
  async function prepareMessagesForStorage(messages) {
    if (!Array.isArray(messages)) return [];
    const prepared = [];
    for (const msg of messages) {
      if (Array.isArray(msg?.images) && msg.images.length > 0) {
        const lightweightImages = [];
        for (const img of msg.images) {
          if (!img || typeof img !== 'object') continue;
          let blobId = img.blobId;
          if (!blobId && img.dataUrl) {
            const blobRecord = await saveBlob({
              dataUrl: img.dataUrl,
              mimeType: img.mimeType,
              size: img.size
            });
            blobId = blobRecord.id;
          }
          const { dataUrl: _dropDataUrl, ...rest } = img;
          lightweightImages.push({
            ...rest,
            name: img.name || '',
            blobId: blobId || '',
            mimeType: img.mimeType || 'image/jpeg',
            size: typeof img.size === 'number' ? img.size : (img.dataUrl ? img.dataUrl.length : 0)
          });
        }
        prepared.push({ ...msg, images: lightweightImages });
      } else {
        prepared.push(msg);
      }
    }
    return prepared;
  }

  /** Hidrata las imágenes de los mensajes recuperando su dataUrl desde el store de blobs o el backend. */
  async function hydrateMessageImages(messages) {
    if (!Array.isArray(messages)) return messages;
    for (const msg of messages) {
      if (Array.isArray(msg?.images)) {
        for (const img of msg.images) {
          if (img?.blobId && !img.dataUrl) {
            let blob = null;
            if (await hasBlob(img.blobId)) {
              blob = await getBlob(img.blobId);
            } else if (isBackendConnected()) {
              try {
                const res = await requestBackend('zerochat/blobs/get', { id: img.blobId });
                if (res?.blob?.data) {
                  blob = await saveBlob({
                    id: res.blob.id,
                    mimeType: res.blob.mimeType,
                    size: res.blob.size,
                    dataUrl: `data:${res.blob.mimeType};base64,${res.blob.data}`
                  });
                }
              } catch (error) {
                // Si el servidor falla o no tiene el blob, se continúa sin interrumpir la carga del mensaje.
                console.warn('[ChatStorage] Could not fetch remote blob:', error);
              }
            }
            if (blob?.dataUrl) {
              img.dataUrl = blob.dataUrl;
            }
          }
        }
      }
    }
    return messages;
  }

  /** Sube al backend los blobs pendientes antes de guardar la conversación. */
  async function syncPendingBlobs(messages) {
    const blobIds = [];
    for (const msg of messages) {
      if (Array.isArray(msg?.images)) {
        for (const img of msg.images) {
          if (img?.blobId) blobIds.push(img.blobId);
        }
      }
    }
    if (blobIds.length === 0) return;
    const uniqueIds = Array.from(new Set(blobIds));
    const { missing = [] } = await requestBackend('zerochat/blobs/has', { ids: uniqueIds });
    for (const blobId of missing) {
      const blob = await getBlob(blobId);
      if (blob?.dataUrl) {
        await requestBackend('zerochat/blobs/put', {
          id: blob.id,
          mimeType: blob.mimeType,
          data: blob.dataUrl
        }, { headers: { 'X-ZeroChat-Blob': '1' } });
      }
    }
  }

  /** Guarda una conversación y sustituye todos sus mensajes. */
  async function saveConversation(sessionMeta, messages = []) {
    if (!sessionMeta?.id) return false;
    const preparedMessages = await prepareMessagesForStorage(messages);
    await writeLocalConversation(sessionMeta, preparedMessages);
    if (isBackendConnected()) {
      await syncPendingBlobs(preparedMessages);
      await requestBackend('zerochat/conversations/save', { conversation: sessionMeta, messages: preparedMessages });
    }
    return true;
  }

  /** Elimina una conversación y todos sus mensajes. */
  async function deleteConversation(sessionId) {
    if (!sessionId) return false;
    await attempt('delete the conversation', async db => {
      const tx = db.transaction([STORES.conversations, STORES.messages], 'readwrite');
      tx.objectStore(STORES.conversations).delete(sessionId);
      await deleteByIndex(tx.objectStore(STORES.messages), 'by_conversation', conversationRange(sessionId));
      await transactionDone(tx);
    });
    if (isBackendConnected()) {
      await requestBackend('zerochat/conversations/delete', { id: sessionId });
    }
    return true;
  }

  async function deleteAllConversations() {
    await attempt('delete the conversations', async db => {
      const tx = db.transaction([STORES.conversations, STORES.messages], 'readwrite');
      tx.objectStore(STORES.conversations).clear();
      tx.objectStore(STORES.messages).clear();
      await transactionDone(tx);
    });
    if (isBackendConnected()) {
      await requestBackend('zerochat/conversations/delete', { all: true });
    }
    return true;
  }

  async function renameConversation(sessionId, newTitle) {
    if (!sessionId || !newTitle) return false;
    const title = newTitle.trim();
    const renamed = await attempt('rename the conversation', async db => {
      const tx = db.transaction(STORES.conversations, 'readwrite');
      const store = tx.objectStore(STORES.conversations);
      const conversation = await requestResult(store.get(sessionId));
      if (conversation) store.put({ ...conversation, title, updatedAt: Date.now() });
      await transactionDone(tx);
      return Boolean(conversation);
    });
    if (isBackendConnected()) {
      await requestBackend('zerochat/conversations/rename', { id: sessionId, title });
    }
    return renamed;
  }

  function dataUrlToBytes(dataUrl) {
    const commaIdx = dataUrl.indexOf(',');
    const b64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  async function computeBlobId(bytes) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /**
   * Guarda un blob en IndexedDB indexado por su hash SHA-256 (deduplicado automáticamente).
   * Admite { dataUrl, mimeType, size?, id? } o { bytes, mimeType, size?, id? }.
   */
  async function saveBlob(blob) {
    if (!blob || typeof blob !== 'object') throw new Error('Blob data is required');
    let bytes = blob.bytes;
    let dataUrl = blob.dataUrl;
    let mimeType = blob.mimeType || 'application/octet-stream';

    if (!bytes && dataUrl) {
      bytes = dataUrlToBytes(dataUrl);
      if (!blob.mimeType && dataUrl.startsWith('data:')) {
        const scIdx = dataUrl.indexOf(';');
        if (scIdx > 5) mimeType = dataUrl.slice(5, scIdx);
      }
    } else if (bytes && !dataUrl) {
      dataUrl = `data:${mimeType};base64,${Utils.bytesToBase64(bytes)}`;
    }

    if (!bytes || bytes.length === 0) throw new Error('Blob data cannot be empty');

    const id = (blob.id || (await computeBlobId(bytes))).trim().toLowerCase();
    const size = typeof blob.size === 'number' ? blob.size : bytes.length;
    const now = Date.now();
    const record = {
      id,
      mimeType,
      size,
      dataUrl,
      createdAt: blob.createdAt || now
    };

    await attempt('save blob', async db => {
      const tx = db.transaction(STORES.blobs, 'readwrite');
      tx.objectStore(STORES.blobs).put(record);
      await transactionDone(tx);
    });

    return record;
  }

  /** Recupera un blob de IndexedDB por su id (hash SHA-256). */
  async function getBlob(id) {
    if (!id || typeof id !== 'string') return null;
    return attempt('get blob', async db => {
      const tx = db.transaction(STORES.blobs, 'readonly');
      const record = await requestResult(tx.objectStore(STORES.blobs).get(id.trim().toLowerCase()));
      return record || null;
    });
  }

  /** Comprueba si existe un blob en IndexedDB por su id. */
  async function hasBlob(id) {
    if (!id || typeof id !== 'string') return false;
    return attempt('check blob existence', async db => {
      const tx = db.transaction(STORES.blobs, 'readonly');
      const count = await requestResult(tx.objectStore(STORES.blobs).count(id.trim().toLowerCase()));
      return count > 0;
    });
  }

  return {
    setStorageItem,
    getStorageItem,
    deleteStorageItem,
    normalizeBackendSession,
    setBackendSession,
    getBackendSession,
    loadRuntimeConfigV2,
    saveRuntimeConfigV2,
    clearAllStorage,
    getLastClearAllStorageError,
    getConversationsList,
    getConversation,
    saveConversation,
    deleteConversation,
    deleteAllConversations,
    renameConversation,
    saveBlob,
    getBlob,
    hasBlob
  };
});
