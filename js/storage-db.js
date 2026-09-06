/**
 * Shared IndexedDB connection and schema for ZeroChat.
 * Persistent application data lives in one database so modules never compete
 * with different database versions or upgrade handlers.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.ZeroChatDB = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DB_NAME = 'ZeroChatDB';
  const DB_VERSION = 4;
  const STORES = Object.freeze({
    conversations: 'conversations',
    messages: 'messages',
    attachments: 'attachments',
    ragBranches: 'rag_branches',
    ragDocuments: 'rag_documents',
    ragImages: 'rag_images',
    ragChunks: 'rag_chunks',
    ragMeta: 'rag_meta'
  });

  let dbPromise = null;

  function isAvailable() {
    try {
      return typeof indexedDB !== 'undefined' && indexedDB !== null;
    } catch (_) {
      return false;
    }
  }

  function createIndex(store, name, keyPath, options) {
    if (!store.indexNames.contains(name)) store.createIndex(name, keyPath, options);
  }

  function ensureStore(db, tx, name, options) {
    return db.objectStoreNames.contains(name)
      ? tx.objectStore(name)
      : db.createObjectStore(name, options);
  }

  function upgradeSchema(db, transaction) {
    let store = ensureStore(db, transaction, STORES.conversations, { keyPath: 'id' });
    createIndex(store, 'by_updatedAt', 'updatedAt', { unique: false });
    createIndex(store, 'by_createdAt', 'createdAt', { unique: false });

    store = ensureStore(db, transaction, STORES.messages, { keyPath: 'id' });
    createIndex(store, 'by_conversationId', 'conversationId', { unique: false });
    createIndex(store, 'by_createdAt', 'createdAt', { unique: false });
    createIndex(store, 'by_role', 'role', { unique: false });

    store = ensureStore(db, transaction, STORES.attachments, { keyPath: 'id' });
    createIndex(store, 'by_conversationId', 'conversationId', { unique: false });
    createIndex(store, 'by_messageId', 'messageId', { unique: false });

    store = ensureStore(db, transaction, STORES.ragBranches, { keyPath: 'id' });
    createIndex(store, 'by_createdAt', 'createdAt', { unique: false });

    store = ensureStore(db, transaction, STORES.ragDocuments, { keyPath: 'id' });
    createIndex(store, 'by_branchId', 'branchId', { unique: false });
    createIndex(store, 'by_createdAt', 'createdAt', { unique: false });

    if (db.objectStoreNames.contains('rag_files')) {
      db.deleteObjectStore('rag_files');
    }

    store = ensureStore(db, transaction, STORES.ragImages, { keyPath: 'documentId' });
    createIndex(store, 'by_branchId', 'branchId', { unique: false });

    store = ensureStore(db, transaction, STORES.ragChunks, { keyPath: 'id' });
    createIndex(store, 'by_branchId', 'branchId', { unique: false });
    createIndex(store, 'by_documentId', 'documentId', { unique: false });
    createIndex(store, 'by_createdAt', 'createdAt', { unique: false });

    if (!db.objectStoreNames.contains(STORES.ragMeta)) {
      db.createObjectStore(STORES.ragMeta, { keyPath: 'key' });
    }
  }

  function openDatabase() {
    if (!isAvailable()) return Promise.resolve(null);
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve) => {
      let request;
      try {
        request = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (error) {
        console.warn('[ZeroChatDB] IndexedDB no está disponible:', error);
        resolve(null);
        return;
      }
      request.onupgradeneeded = (event) => upgradeSchema(event.target.result, event.target.transaction);
      request.onsuccess = (event) => {
        const db = event.target.result;
        db.onversionchange = () => { db.close(); dbPromise = null; };
        resolve(db);
      };
      request.onerror = () => {
        console.warn('[ZeroChatDB] No se pudo abrir IndexedDB:', request.error);
        dbPromise = null;
        resolve(null);
      };
      request.onblocked = () => {
        console.warn('[ZeroChatDB] La actualización está bloqueada por otra pestaña.');
        dbPromise = null;
        resolve(null);
      };
    });
    return dbPromise;
  }

  async function closeDatabase() {
    if (!dbPromise) return;
    const db = await dbPromise;
    if (db) db.close();
    dbPromise = null;
  }

  return { DB_NAME, DB_VERSION, STORES, isAvailable, openDatabase, closeDatabase };
});
