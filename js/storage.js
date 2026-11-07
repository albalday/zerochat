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

  function setStorageItem(name, value) {
    try {
      localStorage.setItem(`${STORAGE_PREFIX}${name}`, String(value ?? ''));
    } catch (error) {
      console.warn(`[ChatStorage] Could not save ${name} in localStorage:`, error);
    }
  }

  const getStorageItem = name => localStorage.getItem(`${STORAGE_PREFIX}${name}`);
  const deleteStorageItem = name => localStorage.removeItem(`${STORAGE_PREFIX}${name}`);

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

  const conversationRange = id => IDBKeyRange.bound([id, -Infinity], [id, Infinity]);

  function toConversationHeader(record) {
    const { id, title, createdAt, updatedAt, messageCount } = record;
    return { id, title, createdAt, updatedAt, messageCount };
  }

  function toMessageRecord(message, conversationId, position, id) {
    const record = { id, conversationId, position, role: message.role || 'user', content: message.content !== undefined ? message.content : '' };
    for (const field of OPTIONAL_MESSAGE_FIELDS) if (message[field]) record[field] = message[field];
    return record;
  }

  const fromMessageRecord = ({ conversationId, position, ...message }) => message;

  const getMCP = () => resolveDep('ChatMCP', './mcp.js');

  function isBackendConnected() {
    try {
      const mcp = getMCP();
      return Boolean(mcp?.manager?.isProxyConnected());
    } catch {
      return false;
    }
  }

  async function requestBackendStorage(method, params = {}) {
    const mcp = getMCP();
    if (!mcp?.manager?.isProxyConnected()) return null;
    return mcp.manager.requestExternalControl(method, params);
  }

  async function getBackendConversationsList(filterText = '') {
    const result = await requestBackendStorage('zerochat/conversations/list', { filter: filterText });
    return Array.isArray(result?.conversations) ? result.conversations : [];
  }

  async function getBackendConversation(sessionId) {
    if (!sessionId) return null;
    const result = await requestBackendStorage('zerochat/conversations/get', { id: sessionId });
    return result?.conversation || null;
  }

  async function saveBackendConversation(sessionMeta, messages = []) {
    if (!sessionMeta?.id) return false;
    const result = await requestBackendStorage('zerochat/conversations/save', {
      conversation: sessionMeta,
      messages
    });
    return Boolean(result?.conversation);
  }

  async function renameBackendConversation(sessionId, newTitle) {
    if (!sessionId || !newTitle) return false;
    const result = await requestBackendStorage('zerochat/conversations/rename', {
      id: sessionId,
      title: newTitle.trim()
    });
    return result?.renamed === true;
  }

  async function deleteBackendConversation(sessionId) {
    if (!sessionId) return false;
    const result = await requestBackendStorage('zerochat/conversations/delete', { id: sessionId });
    return result?.deleted === true;
  }

  async function deleteAllBackendConversations() {
    const result = await requestBackendStorage('zerochat/conversations/delete', { all: true });
    return result?.deleted === true;
  }

  /**
   * Cabeceras de las conversaciones en IndexedDB, de la más reciente a la más antigua.
   * @param {string} filterText - Filtro opcional por título
   */
  function getIndexedDBConversationsList(filterText = '') {
    const filter = filterText.toLowerCase().trim();
    return attempt('read the conversation list', async db => {
      const store = db.transaction(STORES.conversations, 'readonly').objectStore(STORES.conversations);
      const records = await requestResult(store.index('by_updatedAt').getAll());
      return records.reverse()
        .filter(record => !filter || record.title.toLowerCase().includes(filter))
        .map(toConversationHeader);
    });
  }

  /** Conversación completa con sus mensajes en IndexedDB; null si no existe. */
  function getIndexedDBConversation(sessionId) {
    if (!sessionId) return Promise.resolve(null);
    return attempt('read the conversation', async db => {
      const tx = db.transaction([STORES.conversations, STORES.messages], 'readonly');
      const conversation = await requestResult(tx.objectStore(STORES.conversations).get(sessionId));
      if (!conversation) return null;
      const messages = await getAllByIndex(tx.objectStore(STORES.messages), 'by_conversation', conversationRange(sessionId));
      return { ...toConversationHeader(conversation), history: messages.map(fromMessageRecord) };
    });
  }

  /** Guarda una conversación en IndexedDB y sustituye sus mensajes. */
  function saveIndexedDBConversation(sessionMeta, messages = []) {
    if (!sessionMeta?.id) return Promise.resolve(false);
    const sessionId = sessionMeta.id;
    const now = Date.now();
    return attempt('save the conversation', async db => {
      const tx = db.transaction([STORES.conversations, STORES.messages], 'readwrite');
      tx.objectStore(STORES.conversations).put({
        id: sessionId,
        title: sessionMeta.title || '',
        createdAt: sessionMeta.createdAt || now,
        updatedAt: sessionMeta.updatedAt || now,
        messageCount: messages.length
      });
      const messageStore = tx.objectStore(STORES.messages);
      await deleteByIndex(messageStore, 'by_conversation', conversationRange(sessionId));
      const seenIds = new Set();
      messages.forEach((message, position) => {
        const id = message.id && !seenIds.has(message.id) ? message.id : createId(`msg_${sessionId}`);
        seenIds.add(id);
        messageStore.put(toMessageRecord(message, sessionId, position, id));
      });
      await transactionDone(tx);
      return true;
    });
  }

  /** Elimina una conversación y sus mensajes en IndexedDB. */
  function deleteIndexedDBConversation(sessionId) {
    if (!sessionId) return Promise.resolve(false);
    return attempt('delete the conversation', async db => {
      const tx = db.transaction([STORES.conversations, STORES.messages], 'readwrite');
      tx.objectStore(STORES.conversations).delete(sessionId);
      await deleteByIndex(tx.objectStore(STORES.messages), 'by_conversation', conversationRange(sessionId));
      await transactionDone(tx);
      return true;
    });
  }

  function deleteAllIndexedDBConversations() {
    return attempt('delete the conversations', async db => {
      const tx = db.transaction([STORES.conversations, STORES.messages], 'readwrite');
      tx.objectStore(STORES.conversations).clear();
      tx.objectStore(STORES.messages).clear();
      await transactionDone(tx);
      return true;
    });
  }

  function renameIndexedDBConversation(sessionId, newTitle) {
    if (!sessionId || !newTitle) return Promise.resolve(false);
    return attempt('rename the conversation', async db => {
      const tx = db.transaction(STORES.conversations, 'readwrite');
      const store = tx.objectStore(STORES.conversations);
      const conversation = await requestResult(store.get(sessionId));
      if (conversation) store.put({ ...conversation, title: newTitle.trim(), updatedAt: Date.now() });
      await transactionDone(tx);
      return Boolean(conversation);
    });
  }

  /**
   * Cabeceras de las conversaciones: del backend si está conectado, o de IndexedDB.
   */
  async function getConversationsList(filterText = '') {
    if (isBackendConnected()) {
      try {
        const backendList = await getBackendConversationsList(filterText);
        if (Array.isArray(backendList)) return backendList;
      } catch (err) {
        console.warn('[ChatStorage] Backend conversation list failed, falling back to IndexedDB:', err);
      }
    }
    return getIndexedDBConversationsList(filterText);
  }

  /**
   * Conversación completa: del backend si está conectado, o de IndexedDB si no existe o sin conexión.
   */
  async function getConversation(sessionId) {
    if (!sessionId) return null;
    if (isBackendConnected()) {
      try {
        const backendConv = await getBackendConversation(sessionId);
        if (backendConv) {
          saveIndexedDBConversation(toConversationHeader(backendConv), backendConv.history).catch(() => {});
          return backendConv;
        }
      } catch (err) {
        console.warn('[ChatStorage] Backend get conversation failed, falling back to IndexedDB:', err);
      }
    }
    return getIndexedDBConversation(sessionId);
  }

  /**
   * Guarda una conversación en IndexedDB (respaldo local) y en el backend si está conectado.
   */
  async function saveConversation(sessionMeta, messages = []) {
    if (!sessionMeta?.id) return false;
    const localSaved = await saveIndexedDBConversation(sessionMeta, messages);
    if (isBackendConnected()) {
      try {
        await saveBackendConversation(sessionMeta, messages);
      } catch (err) {
        console.warn('[ChatStorage] Backend save conversation failed, kept in IndexedDB:', err);
      }
    }
    return localSaved;
  }

  /** Elimina una conversación de IndexedDB y del backend local. */
  async function deleteConversation(sessionId) {
    if (!sessionId) return false;
    const localDeleted = await deleteIndexedDBConversation(sessionId);
    if (isBackendConnected()) {
      try {
        await deleteBackendConversation(sessionId);
      } catch (err) {
        console.warn('[ChatStorage] Backend delete conversation failed:', err);
      }
    }
    return localDeleted;
  }

  /** Elimina todas las conversaciones de IndexedDB y del backend local. */
  async function deleteAllConversations() {
    const localDeleted = await deleteAllIndexedDBConversations();
    if (isBackendConnected()) {
      try {
        await deleteAllBackendConversations();
      } catch (err) {
        console.warn('[ChatStorage] Backend delete all conversations failed:', err);
      }
    }
    return localDeleted;
  }

  /** Renombra una conversación en IndexedDB y en el backend local. */
  async function renameConversation(sessionId, newTitle) {
    if (!sessionId || !newTitle) return false;
    const localRenamed = await renameIndexedDBConversation(sessionId, newTitle);
    if (isBackendConnected()) {
      try {
        await renameBackendConversation(sessionId, newTitle);
      } catch (err) {
        console.warn('[ChatStorage] Backend rename conversation failed:', err);
      }
    }
    return localRenamed;
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
    isBackendConnected,
    getIndexedDBConversationsList,
    getIndexedDBConversation,
    saveIndexedDBConversation,
    getBackendConversationsList,
    getBackendConversation,
    saveBackendConversation,
    renameBackendConversation,
    deleteBackendConversation,
    deleteAllBackendConversations
  };
});
