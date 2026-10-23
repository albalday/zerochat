/**
 * Persistencia de la base de conocimiento local en ZeroChatDB. Documentos, imágenes extraídas y
 * fragmentos se guardan en almacenes separados; los índices de búsqueda son datos derivados.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./utils.js'), require('./storage-db.js'));
  } else {
    root.ChatRagStorage = factory(root.ChatUtils, root.ZeroChatDB);
  }
})(typeof self !== 'undefined' ? self : this, function (Utils, Database) {
  'use strict';

  const { createId } = Utils;
  const { STORES, openDatabase, requestResult, transactionDone, deleteByIndex, getAllByIndex } = Database;
  const DOCUMENT_STORES = [STORES.ragDocuments, STORES.ragImages, STORES.ragChunks];
  const BACKUP_SCHEMA = 'zerochat-knowledge';
  const BACKUP_VERSION = 2;

  class RagStorageError extends Error {
    constructor(message, details = {}) { super(message); this.name = 'RagStorageError'; this.details = details; }
  }
  class ValidationError extends RagStorageError {
    constructor(message, details = {}) { super(message, details); this.name = 'ValidationError'; }
  }
  class QuotaExceededError extends RagStorageError {
    constructor(details = {}) { super('The browser storage quota has been exceeded.', details); this.name = 'QuotaExceededError'; }
  }
  class NotFoundError extends RagStorageError {
    constructor(message, details = {}) { super(message, details); this.name = 'NotFoundError'; }
  }

  function isQuotaError(error) {
    return Boolean(error && (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED' || error.code === 22 || error.code === 1014));
  }

  /** Traduce los fallos de escritura a errores propios: cuota agotada o fallo genérico con su acción. */
  function writeError(action, error) {
    if (isQuotaError(error)) return new QuotaExceededError({ error });
    return new RagStorageError(`The ${action} failed: ${error.message || error}`, { error });
  }

  const yieldToUi = () => new Promise(resolve => setTimeout(resolve, 0));

  /** Informa del progreso y cede el hilo cada diez documentos. */
  async function reportProgress(onProgress, current, total, docTitle) {
    if (typeof onProgress !== 'function') return;
    onProgress({ current, total, percent: Math.round((current / total) * 100), docTitle });
    if (current % 10 === 0) await yieldToUi();
  }

  async function readStore(storeName, read) {
    const db = await openDatabase();
    return read(db.transaction(storeName, 'readonly').objectStore(storeName));
  }

  function validateBranch(input) {
    if (!input || typeof input !== 'object' || !String(input.name || '').trim()) {
      throw new ValidationError('The branch name is required.');
    }
    const now = Date.now();
    return {
      id: String(input.id || createId('branch')),
      name: String(input.name).trim(),
      description: String(input.description || '').trim(),
      language: String(input.language || 'spanish').trim().toLowerCase(),
      createdAt: Number(input.createdAt) || now,
      updatedAt: Number(input.updatedAt) || now
    };
  }

  function validateChunk(chunk, index, document) {
    if (!chunk || typeof chunk !== 'object' || !String(chunk.content || '').trim()) {
      throw new ValidationError(`Chunk ${index + 1} contains no text.`);
    }
    const order = Number.isInteger(chunk.order) ? chunk.order : index;
    return {
      id: String(chunk.id || `${document.id}:chunk:${order}`),
      branchId: document.branchId,
      documentId: document.id,
      order,
      title: String(chunk.title || `Chunk ${order + 1}`).trim(),
      content: String(chunk.content),
      charCount: String(chunk.content).length,
      pageStart: Number.isFinite(chunk.pageStart) ? chunk.pageStart : null,
      pageEnd: Number.isFinite(chunk.pageEnd) ? chunk.pageEnd : null,
      createdAt: Number(chunk.createdAt) || document.createdAt
    };
  }

  function validateDocument(data) {
    if (!data || typeof data !== 'object') throw new ValidationError('The document must be an object.');
    if (!String(data.branchId || '').trim()) throw new ValidationError('The document requires a branch.');
    if (!String(data.title || '').trim()) throw new ValidationError('The document title is required.');
    const fileType = String(data.fileType || 'txt').toLowerCase();
    if (!['pdf', 'txt', 'md', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp'].includes(fileType)) throw new ValidationError(`Unsupported file type: ${fileType}.`);
    const now = Date.now();
    const document = {
      id: String(data.id || createId('doc')),
      branchId: String(data.branchId).trim(),
      title: String(data.title).trim(),
      path: String(data.path || data.title).trim(),
      fileType,
      mimeType: String(data.mimeType || ''),
      fileSize: Number(data.fileSize) || 0,
      chunkCount: 0,
      imageCount: Math.max(0, Math.floor(Number(data.imageCount) || 0)),
      createdAt: Number(data.createdAt) || now,
      updatedAt: Number(data.updatedAt) || now
    };
    const chunks = (Array.isArray(data.chunks) ? data.chunks : []).map((chunk, index) => validateChunk(chunk, index, document));
    document.chunkCount = chunks.length;
    return { document, chunks };
  }

  async function createBranch(nameOrData, description = '', language = '') {
    const branch = validateBranch(typeof nameOrData === 'string'
      ? { name: nameOrData, description, language }
      : nameOrData);
    try {
      const db = await openDatabase();
      const tx = db.transaction(STORES.ragBranches, 'readwrite');
      tx.objectStore(STORES.ragBranches).add(branch);
      await transactionDone(tx);
      return branch;
    } catch (error) {
      throw writeError('branch creation', error);
    }
  }

  async function getBranches() {
    const branches = await readStore(STORES.ragBranches, store => requestResult(store.getAll()));
    return branches.sort((a, b) => b.createdAt - a.createdAt);
  }

  async function getBranchById(id) {
    if (!id) return null;
    return (await readStore(STORES.ragBranches, store => requestResult(store.get(String(id))))) || null;
  }

  async function requireBranch(id) {
    const branch = await getBranchById(id);
    if (!branch) throw new NotFoundError(`Branch ${id} does not exist.`);
    return branch;
  }

  async function updateBranch(id, updates = {}) {
    const current = await requireBranch(id);
    const next = validateBranch({ ...current, ...updates, id: current.id, createdAt: current.createdAt, updatedAt: Date.now() });
    const db = await openDatabase();
    const tx = db.transaction(STORES.ragBranches, 'readwrite');
    tx.objectStore(STORES.ragBranches).put(next);
    await transactionDone(tx);
    return next;
  }

  async function deleteBranch(id) {
    await requireBranch(id);
    const docs = await getDocumentsByBranch(id);
    const db = await openDatabase();
    const tx = db.transaction([STORES.ragBranches, ...DOCUMENT_STORES], 'readwrite');
    tx.objectStore(STORES.ragBranches).delete(id);
    await Promise.all(DOCUMENT_STORES.map(name => deleteByIndex(tx.objectStore(name), 'by_branchId', id)));
    await transactionDone(tx);
    return { success: true, deletedBranchId: id, deletedDocumentsCount: docs.length };
  }

  function writeDocument(tx, document, chunks, images) {
    tx.objectStore(STORES.ragDocuments).add(document);
    if (images.length > 0) {
      tx.objectStore(STORES.ragImages).put({ documentId: document.id, branchId: document.branchId, images });
    }
    for (const chunk of chunks) tx.objectStore(STORES.ragChunks).add(chunk);
  }

  async function removeDocumentRecords(tx, id) {
    tx.objectStore(STORES.ragDocuments).delete(id);
    tx.objectStore(STORES.ragImages).delete(id);
    await deleteByIndex(tx.objectStore(STORES.ragChunks), 'by_documentId', id);
  }

  /** Guarda un documento con sus fragmentos e imágenes; si `replaceId` existe, lo sustituye en la misma transacción. */
  async function storeDocument(data, images, replaceId = null) {
    const docImages = Array.isArray(images) ? images : [];
    const { document, chunks } = validateDocument({ ...data, imageCount: docImages.length });
    try {
      const db = await openDatabase();
      const tx = db.transaction(DOCUMENT_STORES, 'readwrite');
      if (replaceId) await removeDocumentRecords(tx, replaceId);
      writeDocument(tx, document, chunks, docImages);
      await transactionDone(tx);
    } catch (error) {
      throw writeError(replaceId ? 'document replacement' : 'document save', error);
    }
    await updateBranch(document.branchId, { updatedAt: Date.now() });
    return document;
  }

  async function saveDocument(data, images = []) {
    await requireBranch(data?.branchId);
    return storeDocument(data, images);
  }

  async function replaceDocument(oldDocId, data, images = []) {
    const existing = await getDocumentById(oldDocId);
    if (!existing) throw new NotFoundError(`Document ${oldDocId} does not exist.`);
    return storeDocument({ ...data, branchId: existing.branchId }, images, oldDocId);
  }

  async function findDocumentByPath(branchId, path) {
    if (!branchId || !path) return null;
    const cleanPath = String(path).trim();
    const docs = await getDocumentsByBranch(branchId);
    return docs.find(doc => doc.path === cleanPath || doc.title === cleanPath) || null;
  }

  async function getDocumentImages(documentId) {
    if (!documentId) return [];
    const record = await readStore(STORES.ragImages, store => requestResult(store.get(String(documentId))));
    return record?.images || [];
  }

  async function getDocumentImage(documentId, imageId) {
    const cleanId = String(imageId || '').trim();
    const images = await getDocumentImages(documentId);
    return images.find(img => img.id === cleanId || `${documentId}:${img.id}` === cleanId) || null;
  }

  async function getDocumentsByBranch(branchId) {
    if (!branchId) return [];
    const docs = await readStore(STORES.ragDocuments, store => getAllByIndex(store, 'by_branchId', branchId));
    return docs.sort((a, b) => b.createdAt - a.createdAt);
  }

  async function getDocumentById(id) {
    if (!id) return null;
    return (await readStore(STORES.ragDocuments, store => requestResult(store.get(String(id))))) || null;
  }

  async function getChunksByBranch(branchId) {
    if (!branchId) return [];
    const chunks = await readStore(STORES.ragChunks, store => getAllByIndex(store, 'by_branchId', branchId));
    return chunks.sort((a, b) => a.createdAt - b.createdAt || a.order - b.order);
  }

  async function getChunksByDocument(documentId) {
    if (!documentId) return [];
    const chunks = await readStore(STORES.ragChunks, store => getAllByIndex(store, 'by_documentId', documentId));
    return chunks.sort((a, b) => a.order - b.order);
  }

  /** Formas que usa el modelo para citar un fragmento: doc:chunk:N, doc#N, doc/N o doc:N. */
  function parseChunkAlias(id) {
    const match = id.match(/^([a-zA-Z0-9_-]+)[#:/](?:chunk:?)?(\d+)$/i);
    return match ? { docId: match[1], order: Number.parseInt(match[2], 10) } : null;
  }

  /** Busca un fragmento por su id, un alias o el id del documento (su primer fragmento). */
  async function getChunkById(id) {
    if (!id) return null;
    const cleanId = String(id).trim();
    const exact = await readStore(STORES.ragChunks, store => requestResult(store.get(cleanId)));
    if (exact) return exact;
    const alias = parseChunkAlias(cleanId);
    const docChunks = await getChunksByDocument(alias ? alias.docId : cleanId);
    if (!alias) return docChunks[0] || null;
    return docChunks.find(chunk => chunk.order === alias.order) || docChunks[alias.order] || null;
  }

  async function deleteDocument(id) {
    if (!(await getDocumentById(id))) return false;
    const db = await openDatabase();
    const tx = db.transaction(DOCUMENT_STORES, 'readwrite');
    await removeDocumentRecords(tx, id);
    await transactionDone(tx);
    return true;
  }

  async function buildDocumentExport(document) {
    const chunks = await getChunksByDocument(document.id);
    const images = await getDocumentImages(document.id);
    return {
      id: document.id,
      title: document.title,
      fileType: document.fileType,
      mimeType: document.mimeType,
      fileSize: document.fileSize,
      imageCount: document.imageCount || images.length,
      images: images.length > 0 ? images : undefined,
      chunks: chunks.map(({ order, title, content, pageStart, pageEnd }) => ({ order, title, content, pageStart, pageEnd }))
    };
  }

  /**
   * Copia de seguridad de una rama como Blob JSON, comprimido con gzip si el navegador lo permite
   * y no se pide lo contrario. Los documentos se serializan uno a uno para no duplicar la rama en memoria.
   */
  async function exportBranchBlob(branchId, { compress = true, onProgress } = {}) {
    const branch = await requireBranch(branchId);
    const documents = await getDocumentsByBranch(branchId);
    const safeName = String(branch.name).normalize('NFKD')
      .replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'knowledge';
    const header = JSON.stringify({
      schema: BACKUP_SCHEMA,
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      branch: { name: branch.name, description: branch.description, language: branch.language }
    });

    const encoder = new TextEncoder();
    let index = 0;
    let stream = new ReadableStream({
      start(controller) { controller.enqueue(encoder.encode(`${header.slice(0, -1)},"documents":[\n`)); },
      async pull(controller) {
        if (index >= documents.length) {
          controller.enqueue(encoder.encode('\n]}'));
          controller.close();
          return;
        }
        const document = documents[index++];
        controller.enqueue(encoder.encode((index > 1 ? ',\n' : '') + JSON.stringify(await buildDocumentExport(document))));
        await reportProgress(onProgress, index, documents.length, document.title);
      }
    });
    const compressed = compress && typeof CompressionStream !== 'undefined';
    if (compressed) stream = stream.pipeThrough(new CompressionStream('gzip'));
    const blob = await new Response(stream).blob();
    return {
      blob: compressed ? blob : new Blob([blob], { type: 'application/json' }),
      compressed,
      filename: `${safeName}.zerochat-knowledge.json${compressed ? '.gz' : ''}`
    };
  }

  async function isGzipBlob(blob) {
    const bytes = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
    return bytes[0] === 0x1F && bytes[1] === 0x8B;
  }

  /**
   * Texto de un fichero de copia de seguridad de exportBranchBlob. Se descomprime si es gzip por su
   * extensión o, aunque lo hayan renombrado, por su firma.
   */
  async function readBackupText(file) {
    if (file.name.toLowerCase().endsWith('.gz') || await isGzipBlob(file)) {
      return new Response(file.stream().pipeThrough(new DecompressionStream('gzip'))).text();
    }
    return file.text();
  }

  /** Cambia las referencias rag-image:// de los fragmentos al nuevo id del documento. */
  function remapImageReferences(chunks, oldDocId, newDocId) {
    if (!oldDocId || oldDocId === newDocId) return chunks;
    const from = `rag-image://${oldDocId}:`;
    const to = `rag-image://${newDocId}:`;
    return chunks.map(chunk => chunk.content?.includes(from) ? { ...chunk, content: chunk.content.split(from).join(to) } : chunk);
  }

  /** Restaura una copia de seguridad como rama nueva; si algo falla, borra la rama a medio importar. */
  async function importBranch(backup, onProgress) {
    let data = backup;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); }
      catch (error) { throw new ValidationError('The backup is not valid JSON.', { error }); }
    }
    if (!data || data.schema !== BACKUP_SCHEMA || data.version !== BACKUP_VERSION || !data.branch || !Array.isArray(data.documents)) {
      throw new ValidationError('Unsupported knowledge backup format.');
    }
    const branch = await createBranch(data.branch);
    try {
      let current = 0;
      for (const document of data.documents) {
        const targetDocId = !document.id || (await getDocumentById(document.id)) ? createId('doc') : document.id;
        const images = document.images || [];
        await saveDocument({
          id: targetDocId,
          branchId: branch.id,
          title: document.title,
          fileType: document.fileType,
          mimeType: document.mimeType,
          fileSize: document.fileSize,
          chunks: remapImageReferences(Array.isArray(document.chunks) ? document.chunks : [], document.id, targetDocId)
        }, images);
        await reportProgress(onProgress, ++current, data.documents.length, document.title);
      }
      return branch;
    } catch (error) {
      try {
        await deleteBranch(branch.id);
      } catch (rollbackError) {
        console.warn('[RagStorage] Import rollback failed:', rollbackError);
      }
      throw error;
    }
  }

  return {
    createBranch, getBranches, getBranchById, updateBranch, deleteBranch,
    saveDocument, replaceDocument, findDocumentByPath, getDocumentsByBranch, getDocumentById,
    getChunksByBranch, getChunksByDocument, getChunkById, deleteDocument,
    getDocumentImages, getDocumentImage,
    exportBranchBlob, readBackupText, importBranch
  };
});
