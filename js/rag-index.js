/** In-memory Orama indexes derived from chunks stored in IndexedDB. */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('@orama/orama'), require('./ragStorage.js'));
  } else {
    root.ChatRagIndex = factory(root.ZeroChatOrama, root.ChatRagStorage);
  }
})(typeof self !== 'undefined' ? self : this, function (Orama, RagStorage) {
  'use strict';

  const indexes = new Map();
  const builds = new Map();
  const documentIndexes = new Map();
  const documentBuilds = new Map();
  const revisions = new Map();


  function documentCacheKey(branchId, documentId) {
    return `${branchId}:${documentId}`;
  }

  async function createSearchIndex(branch, chunks, documents) {
    const documentsById = new Map(documents.map(document => [document.id, document]));
    const db = await Orama.create({
      schema: {
        id: 'string',
        branchId: 'string',
        documentId: 'string',
        chunkId: 'string',
        rawTitle: 'string',
        documentTitle: 'string',
        sectionTitle: 'string',
        content: 'string',
        fileType: 'string',
        order: 'number'
      },
      components: { tokenizer: { language: branch.language || 'spanish', stemming: false } }
    });
    if (chunks.length > 0) {
      const records = chunks.map(chunk => {
        const document = documentsById.get(chunk.documentId) || {};
        const rawDocTitle = document.title || '';
        const unsluggedDocTitle = rawDocTitle.replace(/[_\-]+/g, ' ');
        const searchableDocTitle = unsluggedDocTitle !== rawDocTitle
          ? `${rawDocTitle} ${unsluggedDocTitle}`
          : rawDocTitle;
        return {
          id: chunk.id,
          branchId: chunk.branchId || branch.id,
          documentId: chunk.documentId,
          chunkId: chunk.id,
          rawTitle: rawDocTitle,
          documentTitle: searchableDocTitle,
          sectionTitle: chunk.title || '',
          content: chunk.content || '',
          fileType: document.fileType || '',
          order: chunk.order || 0
        };
      });
      await Orama.insertMultiple(db, records, 250);
    }
    return db;
  }

  async function buildBranchIndex(branchId) {
    if (!branchId) throw new Error('A branch is required to build the index.');
    if (indexes.has(branchId)) return indexes.get(branchId);
    if (builds.has(branchId)) return builds.get(branchId);

    const revision = revisions.get(branchId) || 0;
    const pending = (async () => {
      const branch = await RagStorage.getBranchById(branchId);
      if (!branch) throw new Error(`No existe la rama ${branchId}.`);
      const [chunks, documents] = await Promise.all([
        RagStorage.getChunksByBranch(branchId),
        RagStorage.getDocumentsByBranch(branchId)
      ]);
      const db = await createSearchIndex(branch, chunks, documents);
      if ((revisions.get(branchId) || 0) === revision) indexes.set(branchId, db);
      return db;
    })();

    builds.set(branchId, pending);
    try {
      return await pending;
    } finally {
      if (builds.get(branchId) === pending) builds.delete(branchId);
    }
  }

  async function buildDocumentIndex(branchId, documentId) {
    if (!branchId || !documentId) throw new Error('A branch and a document are required to build the index.');
    const key = documentCacheKey(branchId, documentId);
    if (documentIndexes.has(key)) return documentIndexes.get(key);
    if (documentBuilds.has(key)) return documentBuilds.get(key);

    const revision = revisions.get(branchId) || 0;
    const pending = (async () => {
      const [branch, document] = await Promise.all([
        RagStorage.getBranchById(branchId),
        RagStorage.getDocumentById(documentId)
      ]);
      if (!branch) throw new Error(`No existe la rama ${branchId}.`);
      if (!document || document.branchId !== branchId) {
        throw new Error(`No existe el documento ${documentId} en la rama ${branchId}.`);
      }
      const chunks = await RagStorage.getChunksByDocument(documentId);
      const db = await createSearchIndex(branch, chunks, [document]);
      if ((revisions.get(branchId) || 0) === revision) documentIndexes.set(key, db);
      return db;
    })();

    documentBuilds.set(key, pending);
    try {
      return await pending;
    } finally {
      if (documentBuilds.get(key) === pending) documentBuilds.delete(key);
    }
  }

  const COMMON_STOPWORDS = new Set([
    'of', 'the', 'in', 'and', 'to', 'for', 'with', 'on', 'at', 'from', 'by', 'an', 'a',
    'de', 'la', 'el', 'los', 'las', 'en', 'y', 'del', 'al', 'por', 'con', 'para'
  ]);

  function prepareSearchQuery(rawQuery) {
    if (!rawQuery) return { cleanedTerm: '', tolerance: 0 };
    // 1. Eliminar extensiones de archivo que solo añaden ruido (.pdf, .txt, etc.)
    let cleaned = String(rawQuery).replace(/\.(?:pdf|txt|md|csv|json)\b/gi, ' ');
    // 2. Eliminar operadores booleanos aislados en mayúsculas
    cleaned = cleaned.replace(/\b(?:OR|AND|NOT)\b/g, ' ');
    // 3. Normalizar guiones y barras bajas a espacios para que "3M_2018_10K" se busque como términos individuales
    cleaned = cleaned.replace(/[_\-]+/g, ' ');
    // 4. Limpiar comillas, corchetes y caracteres conflictivos para el tokenizador
    cleaned = cleaned.replace(/["'()[\]{}#*:;]/g, ' ');
    cleaned = cleaned.replace(/\s+/g, ' ').trim();

    // 5. Filtrar palabras vacías (stopwords) comunes cuando hay múltiples términos
    const tokens = cleaned.split(/\s+/).filter(Boolean);
    const nonStopTokens = tokens.filter(t => !COMMON_STOPWORDS.has(t.toLowerCase()));
    const effectiveTokens = (tokens.length > 2 && nonStopTokens.length > 0) ? nonStopTokens : tokens;
    const finalTerm = effectiveTokens.join(' ');

    // 6. Tolerancia inteligente:
    // Si contiene tokens cortos (<= 3 caracteres como "3M", "AMD", "Q1", "SEC"), usar tolerance 0
    // para evitar falsos positivos por distancia Levenshtein (ej. "3M" <-> "TM" o "PM")
    const hasShortToken = effectiveTokens.some(t => t.length > 0 && t.length <= 3);
    const tolerance = hasShortToken ? 0 : 1;

    return { cleanedTerm: finalTerm || String(rawQuery).trim(), tolerance };
  }

  async function searchIndex(db, term, options = {}) {
    const rawQuery = String(term || '').trim();
    if (!rawQuery) return { count: 0, elapsed: null, hits: [] };
    const { cleanedTerm, tolerance: autoTolerance } = prepareSearchQuery(rawQuery);
    if (!cleanedTerm) return { count: 0, elapsed: null, hits: [] };

    const tolerance = Number.isInteger(options.tolerance) ? options.tolerance : autoTolerance;
    const limit = Number(options.limit) > 0 ? Number(options.limit) : 10;

    const searchParams = {
      term: cleanedTerm,
      properties: ['documentTitle', 'sectionTitle', 'content'],
      boost: {
        documentTitle: 5,
        sectionTitle: 2,
        content: 1
      },
      limit,
      tolerance
    };
    if (options.groupByDocument) {
      searchParams.groupBy = {
        properties: ['documentId'],
        maxResult: Number(options.maxPerDocument) > 0 ? Number(options.maxPerDocument) : 2
      };
    }
    const result = await Orama.search(db, searchParams);
    let rawHits = result.hits || [];
    if (options.groupByDocument && Array.isArray(result.groups)) {
      const groups = result.groups.map(group => Array.isArray(group.result) ? group.result : []);
      const groupedHits = [];
      const maxPerDocument = Number(options.maxPerDocument) > 0 ? Number(options.maxPerDocument) : 2;
      for (let round = 0; round < maxPerDocument && groupedHits.length < limit; round += 1) {
        for (const group of groups) {
          if (group[round]) groupedHits.push(group[round]);
          if (groupedHits.length >= limit) break;
        }
      }
      rawHits = groupedHits;
    }
    return {
      count: result.count || 0,
      elapsed: result.elapsed || null,
      hits: rawHits.map(hit => ({
        id: hit.id,
        score: hit.score,
        documentId: hit.document.documentId,
        chunkId: hit.document.chunkId,
        documentTitle: hit.document.rawTitle || hit.document.documentTitle,
        sectionTitle: hit.document.sectionTitle,
        content: hit.document.content,
        order: hit.document.order,
        branchId: hit.document.branchId
      }))
    };
  }

  async function searchBranch(branchId, term, options = {}) {
    const db = await buildBranchIndex(branchId);
    return searchIndex(db, term, options);
  }

  async function searchDocuments(branchId, documentIds, term, options = {}) {
    const ids = Array.from(new Set((Array.isArray(documentIds) ? documentIds : [documentIds])
      .map(id => String(id || '').trim()).filter(Boolean)));
    if (!branchId || ids.length === 0) return { count: 0, elapsed: null, hits: [] };
    const limit = Number(options.limit) > 0 ? Number(options.limit) : 10;
    const results = await Promise.all(ids.map(async documentId => {
      const db = await buildDocumentIndex(branchId, documentId);
      return searchIndex(db, term, { ...options, limit });
    }));
    const hits = results.flatMap(result => result.hits || [])
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, limit);
    return {
      count: results.reduce((total, result) => total + (result.count || 0), 0),
      elapsed: null,
      hits
    };
  }

  async function searchBranches(branchIds, term, options = {}) {
    const list = Array.isArray(branchIds) ? branchIds : (branchIds ? [branchIds] : []);
    const cleanIds = Array.from(new Set(list.map(id => String(id || '').trim()).filter(Boolean)));
    if (cleanIds.length === 0) return { count: 0, elapsed: null, hits: [] };
    if (cleanIds.length === 1) return searchBranch(cleanIds[0], term, options);

    const limit = Number(options.limit) > 0 ? Number(options.limit) : 10;
    const branchResults = await Promise.all(
      cleanIds.map(async (id) => {
        try {
          const res = await searchBranch(id, term, { ...options, limit });
          return (res.hits || []).map(hit => ({ ...hit, branchId: id }));
        } catch (_) {
          return [];
        }
      })
    );

    const allHits = branchResults.flat();
    allHits.sort((a, b) => (b.score || 0) - (a.score || 0));
    const topHits = allHits.slice(0, limit);

    return {
      count: allHits.length,
      elapsed: null,
      hits: topHits
    };
  }

  function invalidateBranch(branchId) {
    indexes.delete(branchId);
    builds.delete(branchId);
    const prefix = `${branchId}:`;
    for (const key of documentIndexes.keys()) if (key.startsWith(prefix)) documentIndexes.delete(key);
    for (const key of documentBuilds.keys()) if (key.startsWith(prefix)) documentBuilds.delete(key);
    revisions.set(branchId, (revisions.get(branchId) || 0) + 1);
  }

  function clearCache() {
    indexes.clear();
    builds.clear();
    documentIndexes.clear();
    documentBuilds.clear();
    revisions.clear();
  }

  return {
    buildBranchIndex, buildDocumentIndex,
    searchBranch, searchBranches, searchDocuments,
    invalidateBranch, clearCache
  };
});
