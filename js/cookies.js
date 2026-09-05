/**
 * Módulo de almacenamiento y persistencia de configuración y conversaciones (ChatStorage).
 * - Configuración síncrona en localStorage / cookies (preferencias ligeras y API keys).
 * - Persistencia estructurada y asíncrona de conversaciones, mensajes y adjuntos en IndexedDB (ZeroChatDB).
 * - Carga bajo demanda de mensajes para optimizar el consumo de memoria.
 * - Fallback transparente para entornos sin soporte de IndexedDB.
 */

(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./storage-db.js'));
  } else {
    root.ChatStorage = factory(root.ZeroChatDB);
  }
})(typeof self !== 'undefined' ? self : this, function (Database) {
  'use strict';

  const DB_NAME = Database?.DB_NAME || 'ZeroChatDB';
  const DB_VERSION = Database?.DB_VERSION || 2;
  const STORE_CONVERSATIONS = Database?.STORES?.conversations || 'conversations';
  const STORE_MESSAGES = Database?.STORES?.messages || 'messages';
  const STORE_ATTACHMENTS = Database?.STORES?.attachments || 'attachments';

  const STORAGE_PREFIX = 'zerochat_';
  const DEFAULT_EXPIRY_DAYS = 365;
  const memoryStorage = new Map();
  const memoryConversations = new Map();
  const memoryMessages = new Map();

  function isLocalStorageAvailable() {
    try {
      const testKey = '__zerochat_test__';
      localStorage.setItem(testKey, testKey);
      localStorage.removeItem(testKey);
      return true;
    } catch (e) {
      return false;
    }
  }

  const hasLocalStorage = isLocalStorageAvailable();

  function setStorageItem(name, value, days = DEFAULT_EXPIRY_DAYS) {
    const key = `${STORAGE_PREFIX}${name}`;
    const strVal = value ?? '';

    if (hasLocalStorage) {
      try {
        localStorage.setItem(key, String(strVal));
      } catch (e) {}
    }

    if (typeof document !== 'undefined' && location.protocol !== 'file:') {
      try {
        const d = new Date();
        d.setTime(d.getTime() + days * 24 * 60 * 60 * 1000);
        const expires = 'expires=' + d.toUTCString();
        document.cookie = `${encodeURIComponent(key)}=${encodeURIComponent(strVal)};${expires};path=/;SameSite=Lax`;
      } catch (e) {}
    }

    memoryStorage.set(key, String(strVal));
  }

  function getStorageItem(name) {
    const key = `${STORAGE_PREFIX}${name}`;

    if (hasLocalStorage) {
      try {
        const item = localStorage.getItem(key);
        if (item !== null) return item;
      } catch (e) {}
    }

    if (typeof document !== 'undefined' && location.protocol !== 'file:') {
      try {
        const nameEQ = encodeURIComponent(key) + '=';
        const ca = document.cookie.split(';');
        for (let i = 0; i < ca.length; i++) {
          let c = ca[i];
          while (c.charAt(0) === ' ') c = c.substring(1, c.length);
          if (c.indexOf(nameEQ) === 0) {
            return decodeURIComponent(c.substring(nameEQ.length, c.length));
          }
        }
      } catch (e) {}
    }

    if (memoryStorage.has(key)) {
      return memoryStorage.get(key);
    }

    return null;
  }

  function deleteStorageItem(name) {
    const key = `${STORAGE_PREFIX}${name}`;
    if (hasLocalStorage) {
      try {
        localStorage.removeItem(key);
      } catch (e) {}
    }
    if (typeof document !== 'undefined' && location.protocol !== 'file:') {
      try {
        document.cookie = `${encodeURIComponent(key)}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;SameSite=Lax`;
      } catch (e) {}
    }
    memoryStorage.delete(key);
  }

  function loadRuntimeConfigV2() {
    const raw = getStorageItem('runtime_config_v2');
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? JSON.parse(JSON.stringify(parsed))
        : null;
    } catch (_) {
      return null;
    }
  }

  function saveRuntimeConfigV2(config) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error('La configuración operativa debe ser un objeto.');
    }
    setStorageItem('runtime_config_v2', JSON.stringify(config));
    return true;
  }

  async function clearAllStorage() {
    if (hasLocalStorage) {
      try {
        const keysToRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith(STORAGE_PREFIX)) {
            keysToRemove.push(k);
          }
        }
        keysToRemove.forEach(k => localStorage.removeItem(k));
      } catch (e) {}
    }

    try {
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.clear();
      }
    } catch (e) {}

    if (typeof document !== 'undefined') {
      try {
        const cookies = document.cookie.split(';');
        for (let i = 0; i < cookies.length; i++) {
          const cookie = cookies[i];
          const eqPos = cookie.indexOf('=');
          const name = eqPos > -1 ? cookie.substr(0, eqPos).trim() : cookie.trim();
          if (name) {
            document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;SameSite=Lax`;
            document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=;SameSite=Lax`;
          }
        }
      } catch (e) {}
    }

    memoryStorage.clear();
    memoryConversations.clear();
    memoryMessages.clear();

    // Las conversaciones se guardan en IndexedDB, no en localStorage. Esperar a
    // que se complete el borrado evita que reaparezcan tras la recarga.
    return deleteAllConversations();
  }

  // ==========================================================================
  // Capa de Persistencia en IndexedDB para Conversaciones y Mensajes
  // ==========================================================================

  function isIndexedDBAvailable() {
    return Database?.isAvailable ? Database.isAvailable() : (typeof indexedDB !== 'undefined' && indexedDB !== null);
  }

  /**
   * Abre o inicializa la base de datos IndexedDB.
   * @returns {Promise<IDBDatabase|null>}
   */
  function openDatabase() {
    if (!isIndexedDBAvailable()) return Promise.resolve(null);
    return Database?.openDatabase ? Database.openDatabase() : Promise.resolve(null);
  }

  /**
   * Obtiene la lista de cabeceras de conversaciones (sin cargar todos los mensajes en memoria).
   * @param {string} filterText - Filtro opcional por título
   * @returns {Promise<Array<{ id: string, title: string, createdAt: number, updatedAt: number, messageCount: number }>>}
   */
  async function getConversationsList(filterText = '') {
    const db = await openDatabase();
    const filter = filterText.toLowerCase().trim();

    if (!db) {
      // Fallback en memoria / localStorage
      const results = [];
      for (const conv of memoryConversations.values()) {
        if (!filter || (conv.title && conv.title.toLowerCase().includes(filter))) {
          results.push({ ...conv });
        }
      }
      return results.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    }

    return new Promise((resolve) => {
      try {
        const tx = db.transaction([STORE_CONVERSATIONS], 'readonly');
        const store = tx.objectStore(STORE_CONVERSATIONS);
        const index = store.index('by_updatedAt');
        const results = [];

        // Iterar en orden descendente de updatedAt
        const request = index.openCursor(null, 'prev');

        request.onsuccess = function (event) {
          const cursor = event.target.result;
          if (cursor) {
            const val = cursor.value;
            if (!filter || (val.title && val.title.toLowerCase().includes(filter))) {
              results.push({
                id: val.id,
                title: val.title || 'Nueva conversación',
                createdAt: val.createdAt,
                updatedAt: val.updatedAt,
                messageCount: val.messageCount || 0,
                model: val.model || '',
                pinned: Boolean(val.pinned),
                summary: val.summary || ''
              });
            }
            cursor.continue();
          } else {
            resolve(results);
          }
        };

        request.onerror = function () {
          resolve([]);
        };
      } catch (e) {
        console.warn('ChatStorage: Error al leer lista de conversaciones:', e);
        resolve([]);
      }
    });
  }

  /**
   * Carga una conversación completa con sus mensajes ordenados cronológicamente.
   * @param {string} sessionId
   * @returns {Promise<{ id: string, title: string, createdAt: number, updatedAt: number, history: Array } | null>}
   */
  async function getConversation(sessionId) {
    if (!sessionId) return null;
    const db = await openDatabase();

    if (!db) {
      const conv = memoryConversations.get(sessionId);
      if (!conv) return null;
      const msgs = (memoryMessages.get(sessionId) || []).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      return { ...conv, history: msgs };
    }

    return new Promise((resolve) => {
      try {
        const tx = db.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readonly');
        const convStore = tx.objectStore(STORE_CONVERSATIONS);
        const msgStore = tx.objectStore(STORE_MESSAGES);
        const msgIndex = msgStore.index('by_conversationId');

        const convReq = convStore.get(sessionId);

        convReq.onsuccess = function () {
          const conv = convReq.result;
          if (!conv) {
            resolve(null);
            return;
          }

          const msgsReq = msgIndex.getAll(sessionId);
          msgsReq.onsuccess = function () {
            const msgs = msgsReq.result || [];
            msgs.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
            resolve({
              ...conv,
              history: msgs
            });
          };
          msgsReq.onerror = function () {
            resolve({ ...conv, history: [] });
          };
        };

        convReq.onerror = function () {
          resolve(null);
        };
      } catch (e) {
        console.warn('ChatStorage: Error al obtener conversación:', e);
        resolve(null);
      }
    });
  }

  /**
   * Guarda o actualiza una conversación y sus mensajes asociados atómicamente.
   * @param {Object} sessionMeta - { id, title, createdAt, updatedAt, ... }
   * @param {Array} messages - Array de mensajes del chat
   * @returns {Promise<boolean>}
   */
  async function saveConversation(sessionMeta, messages = []) {
    if (!sessionMeta || !sessionMeta.id) return false;
    const db = await openDatabase();
    const sessionId = sessionMeta.id;
    const now = Date.now();

    const conversationRecord = {
      id: sessionId,
      title: sessionMeta.title || 'Nueva conversación',
      createdAt: sessionMeta.createdAt || now,
      updatedAt: sessionMeta.updatedAt || now,
      messageCount: messages.length,
      model: sessionMeta.model || '',
      summary: sessionMeta.summary || '',
      tags: sessionMeta.tags || [],
      pinned: Boolean(sessionMeta.pinned),
      metadata: sessionMeta.metadata || {}
    };

    if (!db) {
      memoryConversations.set(sessionId, conversationRecord);
      memoryMessages.set(sessionId, [...messages]);
      return true;
    }

    return new Promise((resolve) => {
      try {
        const tx = db.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
        const convStore = tx.objectStore(STORE_CONVERSATIONS);
        const msgStore = tx.objectStore(STORE_MESSAGES);
        const msgIndex = msgStore.index('by_conversationId');

        convStore.put(conversationRecord);

        // Borrar mensajes existentes de esta conversación y re-insertar actualizados
        const delReq = msgIndex.openCursor(sessionId);
        delReq.onsuccess = function (e) {
          const cursor = e.target.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          } else {
            // Insertar mensajes actualizados garantizando IDs únicos por mensaje
            const seenMsgIds = new Set();
            messages.forEach((m, idx) => {
              let msgId = m.id;
              if (!msgId || seenMsgIds.has(msgId)) {
                msgId = `msg_${sessionId}_${idx}_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
              }
              seenMsgIds.add(msgId);

              const msgRecord = {
                id: msgId,
                conversationId: sessionId,
                role: m.role || 'user',
                content: m.content !== undefined ? m.content : '',
                tool_calls: m.tool_calls || null,
                tool_call_id: m.tool_call_id || null,
                name: m.name || null,
                stats: m.stats || null,
                createdAt: m.createdAt || (conversationRecord.createdAt + idx * 10)
              };
              if (m.contextDateAnchor) msgRecord.contextDateAnchor = m.contextDateAnchor;
              if (m.images) msgRecord.images = m.images;
              msgStore.put(msgRecord);
            });
          }
        };

        tx.oncomplete = function () {
          resolve(true);
        };

        tx.onerror = function (e) {
          console.warn('ChatStorage: Error en transacción saveConversation:', e.target.error);
          resolve(false);
        };
      } catch (e) {
        console.warn('ChatStorage: Excepción al guardar conversación:', e);
        resolve(false);
      }
    });
  }

  /**
   * Elimina una conversación y todos sus mensajes y adjuntos asociados.
   * @param {string} sessionId
   * @returns {Promise<boolean>}
   */
  async function deleteConversation(sessionId) {
    if (!sessionId) return false;
    const db = await openDatabase();

    if (!db) {
      memoryConversations.delete(sessionId);
      memoryMessages.delete(sessionId);
      return true;
    }

    return new Promise((resolve) => {
      try {
        const tx = db.transaction([STORE_CONVERSATIONS, STORE_MESSAGES, STORE_ATTACHMENTS], 'readwrite');
        const convStore = tx.objectStore(STORE_CONVERSATIONS);
        const msgStore = tx.objectStore(STORE_MESSAGES);
        const msgIndex = msgStore.index('by_conversationId');

        convStore.delete(sessionId);

        const delMsgs = msgIndex.openCursor(sessionId);
        delMsgs.onsuccess = function (e) {
          const cursor = e.target.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          }
        };

        tx.oncomplete = function () {
          resolve(true);
        };

        tx.onerror = function (e) {
          console.warn('ChatStorage: Error al eliminar conversación:', e.target.error);
          resolve(false);
        };
      } catch (e) {
        console.warn('ChatStorage: Excepción al eliminar conversación:', e);
        resolve(false);
      }
    });
  }

  /**
   * Elimina todas las conversaciones y mensajes guardados.
   * @returns {Promise<boolean>}
   */
  async function deleteAllConversations() {
    const db = await openDatabase();

    if (!db) {
      memoryConversations.clear();
      memoryMessages.clear();
      return true;
    }

    return new Promise((resolve) => {
      try {
        const tx = db.transaction([STORE_CONVERSATIONS, STORE_MESSAGES, STORE_ATTACHMENTS], 'readwrite');
        tx.objectStore(STORE_CONVERSATIONS).clear();
        tx.objectStore(STORE_MESSAGES).clear();
        tx.objectStore(STORE_ATTACHMENTS).clear();

        tx.oncomplete = function () {
          resolve(true);
        };

        tx.onerror = function (e) {
          console.warn('ChatStorage: Error al vaciar base de datos:', e.target.error);
          resolve(false);
        };
      } catch (e) {
        console.warn('ChatStorage: Excepción al vaciar conversaciones:', e);
        resolve(false);
      }
    });
  }

  /**
   * Renombra una conversación.
   * @param {string} sessionId
   * @param {string} newTitle
   * @returns {Promise<boolean>}
   */
  async function renameConversation(sessionId, newTitle) {
    if (!sessionId || !newTitle) return false;
    const db = await openDatabase();

    if (!db) {
      const conv = memoryConversations.get(sessionId);
      if (conv) {
        conv.title = newTitle.trim();
        conv.updatedAt = Date.now();
        return true;
      }
      return false;
    }

    return new Promise((resolve) => {
      try {
        const tx = db.transaction([STORE_CONVERSATIONS], 'readwrite');
        const store = tx.objectStore(STORE_CONVERSATIONS);
        const req = store.get(sessionId);

        req.onsuccess = function () {
          const conv = req.result;
          if (conv) {
            conv.title = newTitle.trim();
            conv.updatedAt = Date.now();
            store.put(conv);
          }
        };

        tx.oncomplete = function () {
          resolve(true);
        };

        tx.onerror = function () {
          resolve(false);
        };
      } catch (e) {
        resolve(false);
      }
    });
  }

  /** Inicializa el almacenamiento IndexedDB. */
  async function initDB() {
    const db = await openDatabase();
    if (db) {
    }
    return db;
  }

  return {
    // Configuración Síncrona (localStorage / cookies)
    setStorageItem,
    getStorageItem,
    deleteStorageItem,
    setCookie: setStorageItem,
    getCookie: getStorageItem,
    deleteCookie: deleteStorageItem,
    loadRuntimeConfigV2,
    saveRuntimeConfigV2,
    clearAllStorage,

    // Persistencia Asíncrona en IndexedDB (Conversaciones & Mensajes)
    initDB,
    getConversationsList,
    getConversation,
    saveConversation,
    deleteConversation,
    deleteAllConversations,
    renameConversation,

    // Constantes de esquema exportadas
    DB_NAME,
    DB_VERSION,
    STORE_CONVERSATIONS,
    STORE_MESSAGES,
    STORE_ATTACHMENTS
  };
});
