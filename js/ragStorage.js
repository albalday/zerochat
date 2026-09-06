/**
 * IndexedDB persistence for the ZeroChat local knowledge base.
 * Documents, extracted images and retrieval chunks are stored independently in
 * ZeroChatDB. Search indexes are derived data and never the source of truth.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./storage-db.js'));
  } else {
    root.ChatRagStorage = factory(root.ZeroChatDB);
  }
})(typeof self !== 'undefined' ? self : this, function (Database) {
  'use strict';

  const STORES = Database ? Database.STORES : {
    ragBranches: 'rag_branches', ragDocuments: 'rag_documents',
    ragImages: 'rag_images', ragChunks: 'rag_chunks', ragMeta: 'rag_meta'
  };
  const memory = {
    branches: new Map(), documents: new Map(), images: new Map(), chunks: new Map(), meta: new Map()
  };

  class RagStorageError extends Error {
    constructor(message, details = {}) { super(message); this.name = 'RagStorageError'; this.details = details; }
  }
  class ValidationError extends RagStorageError {
    constructor(message, details = {}) { super(message, details); this.name = 'ValidationError'; }
  }
  class QuotaExceededError extends RagStorageError {
    constructor(message = 'Se ha superado la cuota de almacenamiento del navegador.', details = {}) {
      super(message, details); this.name = 'QuotaExceededError';
    }
  }
  class NotFoundError extends RagStorageError {
    constructor(message, details = {}) { super(message, details); this.name = 'NotFoundError'; }
  }

  function generateId(prefix) {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return `${prefix}_${crypto.randomUUID()}`;
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }

  function isQuotaError(error) {
    return Boolean(error && (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED' || error.code === 22 || error.code === 1014));
  }

  async function openDatabase() {
    return Database && Database.openDatabase ? Database.openDatabase() : null;
  }

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve(true);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new RagStorageError('Transacción cancelada.'));
    });
  }

  async function requestPersistentStorage() {
    try {
      if (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.persist === 'function') {
        return navigator.storage.persist();
      }
    } catch (_) {}
    return false;
  }

  function validateBranch(input) {
    const data = typeof input === 'string' ? { name: input } : input;
    if (!data || typeof data !== 'object' || !String(data.name || '').trim()) {
      throw new ValidationError('El nombre de la rama es obligatorio.');
    }
    const now = Date.now();
    return {
      id: String(data.id || generateId('branch')),
      name: String(data.name).trim(),
      description: String(data.description || '').trim(),
      language: String(data.language || 'spanish').trim().toLowerCase(),
      createdAt: Number(data.createdAt) || now,
      updatedAt: Number(data.updatedAt) || now
    };
  }

  function validateChunk(chunk, index, document) {
    if (!chunk || typeof chunk !== 'object' || !String(chunk.content || '').trim()) {
      throw new ValidationError(`El fragmento ${index + 1} no contiene texto.`);
    }
    const order = Number.isInteger(chunk.order) ? chunk.order : index;
    return {
      id: String(chunk.id || `${document.id}:chunk:${order}`),
      branchId: document.branchId,
      documentId: document.id,
      order,
      title: String(chunk.title || `Fragmento ${order + 1}`).trim(),
      content: String(chunk.content),
      charCount: String(chunk.content).length,
      pageStart: Number.isFinite(chunk.pageStart) ? chunk.pageStart : null,
      pageEnd: Number.isFinite(chunk.pageEnd) ? chunk.pageEnd : null,
      createdAt: Number(chunk.createdAt) || document.createdAt
    };
  }

  function validateDocument(data) {
    if (!data || typeof data !== 'object') throw new ValidationError('El documento debe ser un objeto.');
    if (!String(data.branchId || '').trim()) throw new ValidationError('El documento requiere una rama.');
    if (!String(data.title || '').trim()) throw new ValidationError('El título del documento es obligatorio.');
    const fileType = String(data.fileType || 'txt').toLowerCase();
    if (!['pdf', 'txt', 'md'].includes(fileType)) throw new ValidationError(`Tipo de archivo no soportado: ${fileType}.`);
    const now = Date.now();
    const document = {
      id: String(data.id || generateId('doc')),
      branchId: String(data.branchId).trim(),
      title: String(data.title).trim(),
      fileType,
      mimeType: String(data.mimeType || ''),
      fileSize: Number(data.fileSize) || 0,
      chunkCount: 0,
      imageCount: Math.max(0, Math.floor(Number(data.imageCount) || 0)),
      createdAt: Number(data.createdAt) || now,
      updatedAt: Number(data.updatedAt) || now
    };
    const sourceChunks = Array.isArray(data.chunks) ? data.chunks : [];
    const chunks = sourceChunks.map((chunk, index) => validateChunk(chunk, index, document));
    document.chunkCount = chunks.length;
    return { document, chunks };
  }

  async function getByIndex(storeName, indexName, value) {
    const db = await openDatabase();
    if (!db) return null;
    const tx = db.transaction(storeName, 'readonly');
    const index = tx.objectStore(storeName).index(indexName);
    // Usar openCursor en streaming para evitar el límite de IPC de Chromium
    // ("The serialized value is too large: max=257949696 bytes") en ramas con cientos de documentos
    if (typeof index.openCursor === 'function') {
      return new Promise((resolve, reject) => {
        const results = [];
        try {
          const keyRange = (typeof IDBKeyRange !== 'undefined' && IDBKeyRange && typeof IDBKeyRange.only === 'function')
            ? IDBKeyRange.only(value)
            : value;
          const request = index.openCursor(keyRange);
          request.onsuccess = (event) => {
            const cursor = event.target.result;
            if (cursor) {
              results.push(cursor.value);
              cursor.continue();
            } else {
              resolve(results);
            }
          };
          request.onerror = () => reject(request.error || new Error(`Error en cursor de ${storeName}.${indexName}`));
        } catch (err) {
          if (typeof index.getAll === 'function') {
            requestResult(index.getAll(value)).then(resolve, reject);
          } else {
            reject(err);
          }
        }
      });
    }
    if (typeof index.getAll === 'function') {
      return requestResult(index.getAll(value));
    }
    return [];
  }

  async function createBranch(nameOrData, description = '', language = '') {
    const input = typeof nameOrData === 'string'
      ? { name: nameOrData, description, ...(language ? { language } : {}) }
      : nameOrData;
    const branch = validateBranch(input);
    const db = await openDatabase();
    if (!db) { memory.branches.set(branch.id, branch); return { ...branch }; }
    try {
      const tx = db.transaction(STORES.ragBranches, 'readwrite');
      tx.objectStore(STORES.ragBranches).add(branch);
      await transactionDone(tx);
      return { ...branch };
    } catch (error) {
      if (isQuotaError(error)) throw new QuotaExceededError(undefined, { error });
      throw new RagStorageError(`No se pudo crear la rama: ${error.message || error}`, { error });
    }
  }

  async function getBranches() {
    const db = await openDatabase();
    if (!db) return Array.from(memory.branches.values()).map(v => ({ ...v })).sort((a, b) => b.createdAt - a.createdAt);
    const tx = db.transaction(STORES.ragBranches, 'readonly');
    const values = await requestResult(tx.objectStore(STORES.ragBranches).getAll());
    return values.sort((a, b) => b.createdAt - a.createdAt);
  }

  async function getBranchById(id) {
    if (!id) return null;
    const db = await openDatabase();
    if (!db) return memory.branches.has(id) ? { ...memory.branches.get(id) } : null;
    const tx = db.transaction(STORES.ragBranches, 'readonly');
    return (await requestResult(tx.objectStore(STORES.ragBranches).get(String(id)))) || null;
  }

  async function updateBranch(id, updates = {}) {
    const current = await getBranchById(id);
    if (!current) throw new NotFoundError(`No existe la rama ${id}.`);
    const next = validateBranch({ ...current, ...updates, id: current.id, createdAt: current.createdAt, updatedAt: Date.now() });
    const db = await openDatabase();
    if (!db) { memory.branches.set(next.id, next); return { ...next }; }
    const tx = db.transaction(STORES.ragBranches, 'readwrite');
    tx.objectStore(STORES.ragBranches).put(next);
    await transactionDone(tx);
    return next;
  }

  async function deleteByIndex(store, index, value) {
    const request = store.index(index).openKeyCursor(value);
    return new Promise((resolve, reject) => {
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (!cursor) { resolve(); return; }
        store.delete(cursor.primaryKey);
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
  }

  async function deleteBranch(id) {
    const branch = await getBranchById(id);
    if (!branch) throw new NotFoundError(`No existe la rama ${id}.`);
    const docs = await getDocumentsByBranch(id);
    const db = await openDatabase();
    if (!db) {
      memory.branches.delete(id);
      for (const doc of docs) await deleteDocument(doc.id);
      return { success: true, deletedBranchId: id, deletedDocumentsCount: docs.length };
    }
    const tx = db.transaction([STORES.ragBranches, STORES.ragDocuments, STORES.ragImages, STORES.ragChunks], 'readwrite');
    tx.objectStore(STORES.ragBranches).delete(id);
    await Promise.all([
      deleteByIndex(tx.objectStore(STORES.ragDocuments), 'by_branchId', id),
      deleteByIndex(tx.objectStore(STORES.ragImages), 'by_branchId', id),
      deleteByIndex(tx.objectStore(STORES.ragChunks), 'by_branchId', id)
    ]);
    await transactionDone(tx);
    return { success: true, deletedBranchId: id, deletedDocumentsCount: docs.length };
  }

  async function saveDocument(data, images = []) {
    const docImages = Array.isArray(images) ? images : [];
    const { document, chunks } = validateDocument({ ...data, imageCount: docImages.length });
    if (!(await getBranchById(document.branchId))) throw new NotFoundError(`No existe la rama ${document.branchId}.`);
    const db = await openDatabase();
    if (!db) {
      memory.documents.set(document.id, document);
      if (docImages.length > 0) {
        memory.images.set(document.id, { documentId: document.id, branchId: document.branchId, images: docImages });
      }
      chunks.forEach(chunk => memory.chunks.set(chunk.id, chunk));
      return { ...document };
    }
    try {
      const tx = db.transaction([STORES.ragDocuments, STORES.ragImages, STORES.ragChunks], 'readwrite');
      tx.objectStore(STORES.ragDocuments).add(document);
      if (docImages.length > 0) {
        tx.objectStore(STORES.ragImages).put({
          documentId: document.id,
          branchId: document.branchId,
          images: docImages
        });
      }
      for (const chunk of chunks) tx.objectStore(STORES.ragChunks).add(chunk);
      await transactionDone(tx);
      await updateBranch(document.branchId, { updatedAt: Date.now() });
      return document;
    } catch (error) {
      if (isQuotaError(error)) throw new QuotaExceededError(undefined, { error });
      throw new RagStorageError(`No se pudo guardar el documento: ${error.message || error}`, { error });
    }
  }

  async function getDocumentImages(documentId) {
    if (!documentId) return [];
    const db = await openDatabase();
    if (!db) {
      const rec = memory.images.get(String(documentId));
      return rec?.images || [];
    }
    const tx = db.transaction(STORES.ragImages, 'readonly');
    const rec = await requestResult(tx.objectStore(STORES.ragImages).get(String(documentId)));
    return rec?.images || [];
  }

  async function getDocumentImage(documentId, imageId) {
    const images = await getDocumentImages(documentId);
    if (!images || images.length === 0) return null;
    const cleanId = String(imageId || '').trim();
    return images.find(img => img.id === cleanId || `${documentId}:${img.id}` === cleanId) || null;
  }

  async function getDocumentsByBranch(branchId) {
    if (!branchId) return [];
    const fromDb = await getByIndex(STORES.ragDocuments, 'by_branchId', branchId);
    const values = fromDb || Array.from(memory.documents.values()).filter(doc => doc.branchId === branchId).map(v => ({ ...v }));
    return values.sort((a, b) => b.createdAt - a.createdAt);
  }

  async function getDocumentById(id) {
    if (!id) return null;
    const db = await openDatabase();
    if (!db) return memory.documents.has(id) ? { ...memory.documents.get(id) } : null;
    const tx = db.transaction(STORES.ragDocuments, 'readonly');
    return (await requestResult(tx.objectStore(STORES.ragDocuments).get(String(id)))) || null;
  }

  async function getChunksByBranch(branchId) {
    if (!branchId) return [];
    const fromDb = await getByIndex(STORES.ragChunks, 'by_branchId', branchId);
    const values = fromDb || Array.from(memory.chunks.values()).filter(chunk => chunk.branchId === branchId).map(v => ({ ...v }));
    return values.sort((a, b) => a.createdAt - b.createdAt || a.order - b.order);
  }

  async function getChunksByDocument(documentId) {
    if (!documentId) return [];
    const fromDb = await getByIndex(STORES.ragChunks, 'by_documentId', documentId);
    const values = fromDb || Array.from(memory.chunks.values()).filter(chunk => chunk.documentId === documentId).map(v => ({ ...v }));
    return values.sort((a, b) => a.order - b.order);
  }

  function resolveChunkIdAlias(id) {
    if (!id || typeof id !== 'string') return null;
    const m = id.match(/^([a-zA-Z0-9_-]+)[#:/](?:chunk:?)?(\d+)$/i);
    if (m) {
      return { docId: m[1], order: parseInt(m[2], 10), canonicalId: `${m[1]}:chunk:${m[2]}` };
    }
    return null;
  }

  async function getChunkById(id) {
    if (!id) return null;
    const strId = String(id).trim();
    const db = await openDatabase();
    if (!db) {
      if (memory.chunks.has(strId)) return { ...memory.chunks.get(strId) };
      const alias = resolveChunkIdAlias(strId);
      if (alias && memory.chunks.has(alias.canonicalId)) return { ...memory.chunks.get(alias.canonicalId) };
      if (alias) {
        for (const chunk of memory.chunks.values()) {
          if (chunk.documentId === alias.docId && chunk.order === alias.order) return { ...chunk };
        }
      }
      for (const chunk of memory.chunks.values()) {
        if (chunk.documentId === strId && chunk.order === 0) return { ...chunk };
      }
      return null;
    }

    const tx = db.transaction(STORES.ragChunks, 'readonly');
    const store = tx.objectStore(STORES.ragChunks);
    let record = (await requestResult(store.get(strId))) || null;
    if (record) return record;

    const alias = resolveChunkIdAlias(strId);
    if (alias) {
      record = (await requestResult(store.get(alias.canonicalId))) || null;
      if (record) return record;

      const docChunks = await getChunksByDocument(alias.docId);
      if (docChunks && docChunks.length > 0) {
        const found = docChunks.find(c => c.order === alias.order) || docChunks[alias.order];
        if (found) return found;
      }
    } else {
      const docChunks = await getChunksByDocument(strId);
      if (docChunks && docChunks.length > 0) {
        return docChunks[0];
      }
    }

    return null;
  }

  async function deleteDocument(id) {
    const document = await getDocumentById(id);
    if (!document) return false;
    const db = await openDatabase();
    if (!db) {
      memory.documents.delete(id); memory.images.delete(id);
      for (const [chunkId, chunk] of memory.chunks) if (chunk.documentId === id) memory.chunks.delete(chunkId);
      return true;
    }
    const tx = db.transaction([STORES.ragDocuments, STORES.ragImages, STORES.ragChunks], 'readwrite');
    tx.objectStore(STORES.ragDocuments).delete(id);
    tx.objectStore(STORES.ragImages).delete(id);
    await deleteByIndex(tx.objectStore(STORES.ragChunks), 'by_documentId', id);
    await transactionDone(tx);
    return true;
  }

  async function getStorageEstimate() {
    let usage = 0, quota = 0, persisted = false;
    try {
      if (typeof navigator !== 'undefined' && navigator.storage) {
        if (typeof navigator.storage.estimate === 'function') ({ usage = 0, quota = 0 } = await navigator.storage.estimate());
        if (typeof navigator.storage.persisted === 'function') persisted = await navigator.storage.persisted();
      }
    } catch (_) {}
    const percentUsed = quota > 0 ? (usage / quota) * 100 : 0;
    return { usage, quota, percentUsed, usagePercent: percentUsed.toFixed(2), isPersisted: persisted };
  }

  async function clearAllData() {
    const db = await openDatabase();
    if (!db) {
      Object.values(memory).forEach(store => store.clear());
      return true;
    }
    const names = [STORES.ragBranches, STORES.ragDocuments, STORES.ragImages, STORES.ragChunks, STORES.ragMeta];
    const tx = db.transaction(names, 'readwrite');
    names.forEach(name => tx.objectStore(name).clear());
    await transactionDone(tx);
    return true;
  }

  async function exportBranch(branchId, options = {}) {
    const branch = await getBranchById(branchId);
    if (!branch) throw new NotFoundError(`No existe la rama ${branchId}.`);
    const documents = await getDocumentsByBranch(branchId);
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    const total = documents.length;
    let current = 0;
    const exportedDocuments = [];
    for (const document of documents) {
      const chunks = await getChunksByDocument(document.id);
      const images = await getDocumentImages(document.id);
      exportedDocuments.push({
        id: document.id,
        title: document.title,
        fileType: document.fileType,
        mimeType: document.mimeType,
        fileSize: document.fileSize,
        imageCount: document.imageCount || (images ? images.length : 0),
        images: (images && images.length > 0) ? images : undefined,
        chunks: chunks.map(chunk => ({
          order: chunk.order,
          title: chunk.title,
          content: chunk.content,
          pageStart: chunk.pageStart,
          pageEnd: chunk.pageEnd
        }))
      });
      current++;
      if (onProgress) {
        onProgress({ current, total, percent: Math.round((current / total) * 100), docTitle: document.title });
        if (current % 10 === 0) {
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      }
    }
    return {
      schema: 'zerochat-knowledge',
      version: 2,
      exportedAt: new Date().toISOString(),
      branch: { name: branch.name, description: branch.description, language: branch.language },
      documents: exportedDocuments
    };
  }

  async function exportBranchBlob(branchId, options = {}) {
    const branch = await getBranchById(branchId);
    if (!branch) throw new NotFoundError(`No existe la rama ${branchId}.`);
    const documents = await getDocumentsByBranch(branchId);
    const safeName = String(branch.name || 'conocimiento').normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'conocimiento';

    const compress = options.compress !== false && typeof CompressionStream !== 'undefined';
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    const total = documents.length;
    let current = 0;

    if (typeof TransformStream !== 'undefined' && compress) {
      const ts = new TransformStream();
      const writer = ts.writable.getWriter();
      const cs = new CompressionStream('gzip');
      const compressedStream = ts.readable.pipeThrough(cs);
      const responsePromise = new Response(compressedStream).blob();
      const encoder = new TextEncoder();

      const headerObj = {
        schema: 'zerochat-knowledge',
        version: 2,
        exportedAt: new Date().toISOString(),
        branch: { name: branch.name, description: branch.description, language: branch.language }
      };
      const headerStr = JSON.stringify(headerObj);
      await writer.write(encoder.encode(headerStr.slice(0, -1) + ',"documents":[\n'));

      let first = true;
      for (const document of documents) {
        const chunks = await getChunksByDocument(document.id);
        const images = await getDocumentImages(document.id);
        const docRecord = {
          id: document.id,
          title: document.title,
          fileType: document.fileType,
          mimeType: document.mimeType,
          fileSize: document.fileSize,
          imageCount: document.imageCount || (images ? images.length : 0),
          images: (images && images.length > 0) ? images : undefined,
          chunks: chunks.map(chunk => ({
            order: chunk.order,
            title: chunk.title,
            content: chunk.content,
            pageStart: chunk.pageStart,
            pageEnd: chunk.pageEnd
          }))
        };
        const chunkJson = (first ? '' : ',\n') + JSON.stringify(docRecord);
        first = false;
        await writer.write(encoder.encode(chunkJson));

        current++;
        if (onProgress) {
          onProgress({ current, total, percent: Math.round((current / total) * 100), docTitle: document.title });
          if (current % 10 === 0) {
            await new Promise(resolve => setTimeout(resolve, 0));
          }
        }
      }

      await writer.write(encoder.encode('\n]}'));
      await writer.close();
      const blob = await responsePromise;
      return {
        blob,
        compressed: true,
        filename: `${safeName}.zerochat-knowledge.json.gz`
      };
    }

    const backup = await exportBranch(branchId, { onProgress });
    const jsonStr = JSON.stringify(backup);
    const plainBlob = new Blob([jsonStr], { type: 'application/json' });
    return {
      blob: plainBlob,
      compressed: false,
      filename: `${safeName}.zerochat-knowledge.json`
    };
  }

  async function importBranch(backup, onProgress) {
    let data = backup;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); }
      catch (error) { throw new ValidationError('El respaldo no contiene JSON válido.', { error }); }
    }
    if (!data || data.schema !== 'zerochat-knowledge' || data.version !== 2 || !data.branch || !Array.isArray(data.documents)) {
      throw new ValidationError('Formato de respaldo de conocimiento no compatible.');
    }
    const branch = await createBranch(data.branch);
    try {
      const total = data.documents.length;
      let current = 0;
      for (const document of data.documents) {
        const oldDocId = document.id;
        let targetDocId = oldDocId;
        if (!targetDocId || (await getDocumentById(targetDocId))) {
          targetDocId = generateId('doc');
        }

        // Si cambia el ID del documento, actualizar las referencias a imágenes en los chunks
        const sourceChunks = Array.isArray(document.chunks) ? document.chunks : [];
        const remappedChunks = sourceChunks.map(chunk => {
          if (oldDocId && oldDocId !== targetDocId && chunk.content && chunk.content.includes(`rag-image://${oldDocId}:`)) {
            return {
              ...chunk,
              content: chunk.content.split(`rag-image://${oldDocId}:`).join(`rag-image://${targetDocId}:`)
            };
          }
          return chunk;
        });

        await saveDocument({
          id: targetDocId,
          branchId: branch.id,
          title: document.title,
          fileType: document.fileType,
          mimeType: document.mimeType,
          fileSize: document.fileSize,
          imageCount: document.imageCount || (document.images ? document.images.length : 0),
          chunks: remappedChunks
        }, document.images || []);
        current++;
        if (typeof onProgress === 'function') {
          onProgress({ current, total, percent: Math.round((current / total) * 100), docTitle: document.title });
          if (current % 10 === 0) {
            await new Promise(resolve => setTimeout(resolve, 0));
          }
        }
      }
      return branch;
    } catch (error) {
      try {
        await deleteBranch(branch.id);
      } catch (rollbackError) {
        console.warn('[RagStorage] Error durante el rollback de importación:', rollbackError);
      }
      throw error;
    }
  }

  return {
    createBranch, getBranches, getBranchById, updateBranch, deleteBranch,
    saveDocument, getDocumentsByBranch, getDocumentById,
    getChunksByBranch, getChunksByDocument, getChunkById, deleteDocument,
    getDocumentImages, getDocumentImage,
    getStorageEstimate, requestPersistentStorage, clearAllData, exportBranch, exportBranchBlob, importBranch, openDatabase,
    RagStorageError, ValidationError, QuotaExceededError, NotFoundError,
    DB_NAME: Database?.DB_NAME || 'ZeroChatDB', DB_VERSION: Database?.DB_VERSION || 2,
    STORE_BRANCHES: STORES.ragBranches, STORE_DOCUMENTS: STORES.ragDocuments,
    STORE_IMAGES: STORES.ragImages, STORE_CHUNKS: STORES.ragChunks
  };
});
