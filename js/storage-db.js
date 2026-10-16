/**
 * Conexión y esquema de la base IndexedDB de ZeroChat. Todos los datos persistentes viven en una
 * sola base para que los módulos no compitan con versiones o actualizaciones distintas.
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
  const DB_VERSION = 5;
  const STORES = Object.freeze({
    conversations: 'conversations',
    messages: 'messages',
    ragBranches: 'rag_branches',
    ragDocuments: 'rag_documents',
    ragImages: 'rag_images',
    ragChunks: 'rag_chunks'
  });

  let dbPromise = null;

  /** Sin compatibilidad con esquemas anteriores: una versión nueva recrea la base vacía. */
  function createSchema(db) {
    Array.from(db.objectStoreNames).forEach(name => db.deleteObjectStore(name));

    db.createObjectStore(STORES.conversations, { keyPath: 'id' }).createIndex('by_updatedAt', 'updatedAt');
    // Los mensajes se leen en orden por [conversationId, position].
    db.createObjectStore(STORES.messages, { keyPath: 'id' }).createIndex('by_conversation', ['conversationId', 'position']);

    db.createObjectStore(STORES.ragBranches, { keyPath: 'id' });
    db.createObjectStore(STORES.ragDocuments, { keyPath: 'id' }).createIndex('by_branchId', 'branchId');
    db.createObjectStore(STORES.ragImages, { keyPath: 'documentId' }).createIndex('by_branchId', 'branchId');
    const chunks = db.createObjectStore(STORES.ragChunks, { keyPath: 'id' });
    chunks.createIndex('by_branchId', 'branchId');
    chunks.createIndex('by_documentId', 'documentId');
  }

  /** Conexión compartida; se rechaza si el navegador no puede abrir la base. */
  function openDatabase() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => createSchema(request.result);
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); dbPromise = null; };
        resolve(db);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('The database upgrade is blocked by another ZeroChat tab.'));
    });
    dbPromise.catch(() => { dbPromise = null; });
    return dbPromise;
  }

  async function closeDatabase() {
    if (!dbPromise) return;
    const pending = dbPromise;
    dbPromise = null;
    (await pending.catch(() => null))?.close();
  }

  /** Espera a que termine una petición. */
  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /** Espera a que se confirme una transacción. */
  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('Transaction aborted.'));
    });
  }

  /** Borra los registros de un índice que coinciden con la consulta. */
  function deleteByIndex(store, indexName, query) {
    const request = store.index(indexName).openKeyCursor(query);
    return new Promise((resolve, reject) => {
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) { resolve(); return; }
        store.delete(cursor.primaryKey);
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Lee con un cursor los registros de un índice. Evita el límite de IPC de Chromium con getAll()
   * ("The serialized value is too large") en ramas con cientos de documentos.
   */
  function getAllByIndex(store, indexName, query) {
    const request = store.index(indexName).openCursor(query);
    const results = [];
    return new Promise((resolve, reject) => {
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) { resolve(results); return; }
        results.push(cursor.value);
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
  }

  async function deleteOriginDatabases() {
    await closeDatabase();
    // No se enumera el origen: con file:// Chromium puede agrupar archivos ajenos en el mismo
    // almacenamiento. ZeroChat solo es dueña de esta base; los modelos WebLLM se borran de Cache Storage.
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(DB_NAME);
      const timer = setTimeout(() => reject(new Error('ZeroChat IndexedDB deletion timed out.')), 10000);
      timer?.unref?.();
      request.onsuccess = () => { clearTimeout(timer); resolve(); };
      request.onerror = () => { clearTimeout(timer); reject(request.error || new Error('ZeroChat IndexedDB deletion failed.')); };
      // Una conexión puede recibir su versionchange justo después: se sigue esperando al éxito.
      request.onblocked = () => {};
    });
  }

  return {
    DB_NAME, DB_VERSION, STORES,
    openDatabase, closeDatabase, deleteOriginDatabases,
    requestResult, transactionDone, deleteByIndex, getAllByIndex
  };
});
