/** Connects the agent tools with IndexedDB storage and the Orama index. */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./ragStorage.js'), require('./rag-index.js'));
  } else {
    root.ChatRagService = factory(root.ChatRagStorage, root.ChatRagIndex);
  }
})(typeof self !== 'undefined' ? self : this, function (RagStorage, RagIndex) {
  'use strict';

  function getFileParser() {
    if (typeof window !== 'undefined' && window.ChatFileParser) return window.ChatFileParser;
    if (typeof require !== 'undefined') { try { return require('./file-parser.js'); } catch (_) {} }
    return null;
  }

  function parseArguments(rawArgs) {
    if (!rawArgs) return {};
    if (typeof rawArgs === 'object') return rawArgs;
    try { return JSON.parse(String(rawArgs)); } catch (_) { return { query: String(rawArgs) }; }
  }

  function normalizeBranchIds(input) {
    if (!input) return [];
    const list = Array.isArray(input) ? input : String(input).split(',');
    return Array.from(new Set(list.map(id => String(id || '').trim()).filter(Boolean)));
  }

  const DOCUMENT_REFERENCE_STOPWORDS = new Set([
    'a', 'al', 'and', 'annual', 'archivo', 'de', 'del', 'document', 'documento',
    'el', 'en', 'file', 'for', 'form', 'in', 'informe', 'la', 'las', 'los',
    'of', 'para', 'por', 'report', 'the', 'un', 'una', 'y', '10k', '10q'
  ]);
  function normalizeDocumentReference(value) {
    return String(value || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\.(?:pdf|txt|md|csv|json)\b/g, ' ')
      .replace(/[_\-]+/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\bfy\s*(\d{4})\b/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function documentReferenceTokens(value) {
    return Array.from(new Set(normalizeDocumentReference(value).split(' ')
      .map(token => /^fy\d{4}$/.test(token) ? token.slice(2) : token)
      .filter(token => token && !DOCUMENT_REFERENCE_STOPWORDS.has(token))));
  }

  function selectDocumentCandidate(documents, reference) {
    const queryText = normalizeDocumentReference(reference);
    const queryTokens = documentReferenceTokens(reference);
    if (!queryText || queryTokens.length === 0 || documents.length === 0) {
      return { selected: null, candidates: [], confident: false };
    }

    const prepared = documents.map(document => {
      const normalizedTitle = normalizeDocumentReference(document.title);
      return { ...document, normalizedTitle, titleTokens: new Set(documentReferenceTokens(document.title)) };
    });
    const frequencies = new Map();
    for (const token of queryTokens) {
      frequencies.set(token, prepared.filter(document => document.titleTokens.has(token)).length);
    }
    const rareThreshold = Math.max(1, Math.floor(prepared.length * 0.1));
    const candidates = prepared.map(document => {
      const matchedTerms = queryTokens.filter(token => document.titleTokens.has(token));
      const distinctiveTerms = matchedTerms.filter(token => (frequencies.get(token) || 0) <= rareThreshold);
      let score = matchedTerms.reduce((total, token) => {
        const frequency = frequencies.get(token) || prepared.length;
        let weight = 1 + Math.log2((prepared.length + 1) / (frequency + 1));
        if (/^\d{4}$/.test(token)) weight *= 0.8;
        if (/^[a-z]{1,2}$/.test(token)) weight *= 0.75;
        return total + weight;
      }, 0);
      const exactTitle = queryText === document.normalizedTitle;
      if (exactTitle) score += 10;
      return {
        branchId: document.branchId,
        documentId: document.id,
        title: document.title,
        score,
        matchedTerms,
        distinctiveTerms,
        exactTitle
      };
    }).filter(candidate => candidate.matchedTerms.length > 0)
      .sort((a, b) => b.score - a.score || b.matchedTerms.length - a.matchedTerms.length);

    const best = candidates[0] || null;
    const second = candidates[1] || null;
    const exactTitleCount = candidates.filter(candidate => candidate.exactTitle).length;
    const hasDistinctiveMatch = Boolean(best && (best.distinctiveTerms.length > 0 || (best.exactTitle && exactTitleCount === 1)));
    const leadsClearly = Boolean(best && (!second || (best.exactTitle && exactTitleCount === 1) ||
      best.matchedTerms.length > second.matchedTerms.length || best.score >= second.score * 1.25));
    const confident = Boolean(best && hasDistinctiveMatch && leadsClearly);
    return { selected: confident ? best : null, candidates: candidates.slice(0, 5), confident };
  }

  async function resolveBranches(branchIdsInput) {
    const ids = normalizeBranchIds(branchIdsInput);
    if (ids.length === 0) throw new Error('No hay ninguna rama de conocimiento activa.');
    const branches = (await Promise.all(ids.map(id => RagStorage.getBranchById(id)))).filter(Boolean);
    if (branches.length === 0) throw new Error(`No se encontró ninguna de las ramas especificadas: ${ids.join(', ')}.`);
    return branches;
  }

  async function buildRagSystemContext(branchIds, options = {}) {
    if (!branchIds) return '';
    try {
      const branches = await resolveBranches(branchIds);
      const names = branches.map(b => b.name).join(', ');
      const isCheckpoint = !!options.isCheckpointEnabled;

      const label = branches.length === 1
        ? `[ACTIVE KNOWLEDGE BASE: ${names}]`
        : `[ACTIVE KNOWLEDGE BASES: ${names}]`;

      // Expose the language of the documentary connection so the model knows
      // in what language to formulate queries and what to expect in results.
      const branchLang = branches[0]?.language || options.branchLanguage || null;
      const langNote = branchLang
        ? `\n- Document language: the documents in this knowledge base are written in **${branchLang}**. Formulate search queries in that language for best recall.`
        : '';

      const checkpointRule = isCheckpoint
        ? '\n- After extracting key data from 1-2 documents or before concluding complex inquiries, invoke "agent_checkpoint" to consolidate findings and clear working memory.'
        : '';

      return `${label}\n\nDocument retrieval protocol:${langNote}\n- Start with search_knowledge_base using short, key terms; do not concatenate long phrases.\n- Choose scope before searching: use scope="document" with documentHint for one exact document; use scope="corpus" for comparisons, multiple documents, companies, or years; use scope="auto" only when neither intent is clear.\n- For multi-document retrieval, make one scope="corpus" search. Do not repeat the same query with different documentHint values.\n- Consult list_documents (optionally specifying filter, e.g. filter="Walmart") only if search yields no results, you do not know the available sources, or the query references a document whose exact name you are unsure of.\n- In scope="corpus" results, at most 2 chunks per document are returned; if you need more depth from a specific document, repeat the search with scope="document" and documentHint.\n- After finding relevant chunks, use read_knowledge_chunk with chunkIds for deeper or adjacent content; do not re-search for it.\n- Treat tool outputs as private internal evidence: synthesize and answer directly without reproducing full fragments or technical identifiers.\n- Document images are identified as ![description](rag-image://docId:imgId). If an image can provide relevant information and you have native vision, use read_knowledge_image with its full reference to inspect it before answering; request only what is necessary.${checkpointRule}\n- If evidence is insufficient or you find no conclusive data, state it accurately and conclude; do not invent or wander.`;
    } catch (_) {
      return '';
    }
  }

  async function injectRagContext(systemPrompt, branchIds, options = {}) {
    const context = await buildRagSystemContext(branchIds, options);
    return [context, String(systemPrompt || '').trim()].filter(Boolean).join('\n\n');
  }

  async function listDocuments(branchIds, rawArgs) {
    try {
      const branches = await resolveBranches(branchIds);
      const args = (typeof rawArgs === 'string')
        ? { filter: rawArgs }
        : parseArguments(rawArgs);
      const filterText = String(args.filter || args.query || '').trim();
      const filterTokens = filterText ? documentReferenceTokens(filterText) : [];

      const allDocs = [];
      const sections = [];
      for (const branch of branches) {
        const documents = await RagStorage.getDocumentsByBranch(branch.id);
        const filteredDocs = filterText
          ? documents.filter(doc => {
              const normTitle = normalizeDocumentReference(doc.title);
              const normFilter = normalizeDocumentReference(filterText);
              if (normFilter && normTitle.includes(normFilter)) return true;
              const compactTitle = normTitle.replace(/\s+/g, '');
              const compactFilter = normFilter.replace(/\s+/g, '');
              if (compactFilter && compactTitle.includes(compactFilter)) return true;
              if (filterTokens.length > 0) {
                const titleTokens = new Set(documentReferenceTokens(doc.title));
                return filterTokens.some(tok => titleTokens.has(tok));
              }
              return false;
            })
          : documents;

        allDocs.push(...filteredDocs);
        const filterBadge = filterText ? ` (filtered by "${filterText}")` : '';
        const lines = [`[DOCUMENTS IN ${branch.name}${filterBadge}]`];
        for (const document of filteredDocs) {
          const imgCount = Number.isInteger(document.imageCount) ? document.imageCount : 0;
          const imgLabel = imgCount === 1 ? '1 image' : `${imgCount} images`;
          lines.push(`- ${document.title} (documentId: ${document.id}, ${document.chunkCount} chunks, ${imgLabel}, ${document.fileType})`);
        }
        if (!filteredDocs.length) {
          lines.push(filterText
            ? `No documents matching "${filterText}" were found in this branch.`
            : 'The branch contains no documents.'
          );
        }
        sections.push(lines.join('\n'));
      }
      return {
        success: true,
        branchId: branches[0]?.id || '',
        branchName: branches.map(b => b.name).join(', '),
        branchIds: branches.map(b => b.id),
        filter: filterText || null,
        count: allDocs.length,
        documents: allDocs,
        text: sections.join('\n\n')
      };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  }

  function makeSnippet(content, query, maxLength = 850) {
    if (!content) return '';
    let text = String(content)
      .replace(/[^\S\r\n]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    if (text.length <= maxLength) return text;

    const term = String(query || '').split(/\s+/).find(word => word.length > 3) || '';
    const found = term ? text.toLowerCase().indexOf(term.toLowerCase()) : -1;

    let start = 0;
    if (found > 0) {
      const idealStart = Math.max(0, found - Math.floor(maxLength * 0.35));
      const prevNewline = text.lastIndexOf('\n', idealStart);
      start = (prevNewline >= 0 && idealStart - prevNewline < 80) ? prevNewline + 1 : idealStart;
    }

    let end = start + maxLength;
    if (end < text.length) {
      const nextNewline = text.indexOf('\n', end);
      if (nextNewline >= 0 && nextNewline - end < 80) {
        end = nextNewline;
      }
    }

    const slice = text.slice(start, end).trim();
    return `${start > 0 ? '… ' : ''}${slice}${end < text.length ? ' …' : ''}`;
  }

  async function searchKnowledgeBase(branchIds, rawArgs) {
    const args = parseArguments(rawArgs);
    const query = String(args.query || '').trim();
    if (!query) return { success: false, error: 'La consulta de búsqueda está vacía.' };
    try {
      const branches = await resolveBranches(branchIds);
      const branchNamesById = new Map(branches.map(b => [b.id, b.name]));
      const ids = branches.map(b => b.id);
      const limit = Number(args.limit) > 0 ? Number(args.limit) : 10;
      const requestedScope = ['auto', 'document', 'corpus'].includes(String(args.scope || '').toLowerCase())
        ? String(args.scope).toLowerCase()
        : 'auto';
      const hint = String(args.documentHint || '').trim();
      const documentsByBranch = await Promise.all(branches.map(branch => RagStorage.getDocumentsByBranch(branch.id)));
      const documents = documentsByBranch.flat();

      let selection = { selected: null, candidates: [], confident: false };
      if (requestedScope !== 'corpus') {
        if (hint) {
          selection = selectDocumentCandidate(documents, hint);
        }
        if (!selection.selected) {
          const combinedReference = [hint, query].map(value => String(value || '').trim()).filter(Boolean).join(' ');
          const combinedSelection = selectDocumentCandidate(documents, combinedReference);
          if (combinedSelection.selected) {
            selection = combinedSelection;
          } else if (!selection.candidates.length) {
            selection = combinedSelection;
          }
        }
      }

      let appliedScope = 'corpus';
      let scopeReason = requestedScope === 'corpus'
        ? 'The query requested cross-document coverage.'
        : 'No unambiguous document match found; cross-document search applied.';
      let result;
      let appliedMaxPerDoc = null;
      if (selection.selected && typeof RagIndex.searchDocuments === 'function') {
        appliedScope = 'document';
        scopeReason = `Unambiguous match with title "${selection.selected.title}".`;
        result = await RagIndex.searchDocuments(
          selection.selected.branchId,
          [selection.selected.documentId],
          query,
          { limit, tolerance: args.tolerance }
        );
      } else {
        let dynamicMaxPerDoc = 2;
        const explicitMaxPerDoc = Number(args.maxPerDocument);
        if (Number.isInteger(explicitMaxPerDoc) && explicitMaxPerDoc > 0) {
          dynamicMaxPerDoc = explicitMaxPerDoc;
        } else if (requestedScope !== 'corpus') {
          // Búsqueda auto o document con ambigüedad: si hay pocos documentos o pocos candidatos,
          // permitir 3 o 4 chunks por documento para no perder tablas contables complementarias (ej: P&L + Cash Flows)
          if (documents.length <= 2 || (selection.candidates.length > 0 && selection.candidates.length <= 2)) {
            dynamicMaxPerDoc = 4;
          } else if (documents.length <= 4) {
            dynamicMaxPerDoc = 3;
          }
        }
        appliedMaxPerDoc = dynamicMaxPerDoc;

        const corpusOptions = {
          limit,
          tolerance: args.tolerance,
          groupByDocument: true,
          maxPerDocument: dynamicMaxPerDoc
        };
        result = typeof RagIndex.searchBranches === 'function'
          ? await RagIndex.searchBranches(ids, query, corpusOptions)
          : await RagIndex.searchBranch(ids[0], query, corpusOptions);
      }

      const matches = result.hits.map(hit => {
        const bName = branchNamesById.get(hit.branchId) || branches[0].name;
        return {
          branchId: hit.branchId || branches[0].id,
          branchName: bName,
          documentId: hit.documentId,
          chunkId: hit.chunkId,
          documentTitle: hit.documentTitle,
          sectionTitle: hit.sectionTitle,
          score: hit.score,
          snippet: makeSnippet(hit.content, query)
        };
      });

      const branchLabel = branches.map(b => b.name).join(', ');
      const lines = [
        `[RESULTS IN ${branchLabel} FOR: ${query}]`,
        `Requested scope: ${requestedScope}`,
        `Applied scope: ${appliedScope}`,
        `Reason: ${scopeReason}`
      ];
      if (selection.selected) lines.push(`Selected document: ${selection.selected.title} (${selection.selected.documentId})`);
      if (!selection.selected && selection.candidates.length > 0) {
        lines.push(`Document candidates: ${selection.candidates.map(candidate => candidate.title).join(', ')} (tip: specify documentHint with the target document to retrieve more depth).`);
      }
      for (const match of matches) {
        const branchBadge = branches.length > 1 ? ` [Branch: ${match.branchName}]` : '';
        lines.push(`- ${match.documentTitle} · ${match.sectionTitle}${branchBadge} (chunkId: ${match.chunkId}, score: ${match.score.toFixed(3)})`);
        const indentedSnippet = match.snippet.split('\n').map(line => `  ${line}`).join('\n');
        lines.push(indentedSnippet);
      }
      if (!matches.length) lines.push('No relevant chunks found.');

      return {
        success: true,
        branchId: branches[0]?.id || '',
        branchName: branchLabel,
        branchIds: ids,
        query,
        requestedScope,
        appliedScope,
        scopeReason,
        documentHint: String(args.documentHint || ''),
        selectedDocument: selection.selected,
        documentCandidates: selection.candidates,
        maxChunksPerDocument: appliedScope === 'corpus' ? appliedMaxPerDoc : null,
        matchesCount: matches.length,
        totalMatches: result.count,
        matches,
        text: lines.join('\n')
      };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  }

  async function readKnowledgeChunk(branchIds, rawArgs) {
    const args = parseArguments(rawArgs);
    let requestedIds = [];
    if (Array.isArray(args.chunkIds)) {
      requestedIds = args.chunkIds.map(id => String(id || '').trim()).filter(Boolean);
    } else if (typeof args.chunkIds === 'string' && args.chunkIds.trim()) {
      requestedIds = args.chunkIds.split(/[\s,]+/).map(id => id.trim()).filter(Boolean);
    } else if (args.chunkId) {
      if (Array.isArray(args.chunkId)) {
        requestedIds = args.chunkId.map(id => String(id || '').trim()).filter(Boolean);
      } else if (typeof args.chunkId === 'string' && args.chunkId.includes(',')) {
        requestedIds = args.chunkId.split(/[\s,]+/).map(id => id.trim()).filter(Boolean);
      } else {
        const single = String(args.chunkId || '').trim();
        if (single) requestedIds = [single];
      }
    }

    if (!requestedIds.length) return { success: false, error: 'chunkId o chunkIds es obligatorio.' };
    const MAX_CHUNKS_PER_CALL = 5;
    const uniqueIds = Array.from(new Set(requestedIds)).slice(0, MAX_CHUNKS_PER_CALL);

    try {
      const branches = await resolveBranches(branchIds);
      const allowedBranchIds = new Set(branches.map(b => b.id));
      const docCache = new Map();

      const items = [];
      for (const id of uniqueIds) {
        const chunk = await RagStorage.getChunkById(id);
        if (!chunk || !allowedBranchIds.has(chunk.branchId)) continue;
        let document = docCache.get(chunk.documentId);
        if (!document) {
          document = await RagStorage.getDocumentById(chunk.documentId);
          if (document) docCache.set(chunk.documentId, document);
        }
        const totalChunks = Number.isInteger(document?.chunkCount) ? document.chunkCount : 0;
        const order = Number.isInteger(chunk.order) ? chunk.order : null;
        const prevChunkId = (order !== null && order > 0) ? `${chunk.documentId}:chunk:${order - 1}` : null;
        const nextChunkId = (order !== null && totalChunks > 0 && order + 1 < totalChunks) ? `${chunk.documentId}:chunk:${order + 1}` : null;

        items.push({
          chunkId: chunk.id,
          documentId: chunk.documentId,
          branchId: chunk.branchId,
          documentTitle: document?.title || '',
          sectionTitle: chunk.title,
          order,
          totalChunks,
          prevChunkId,
          nextChunkId,
          documentImageCount: Number.isInteger(document?.imageCount) ? document.imageCount : 0,
          charCount: chunk.content.length,
          content: chunk.content,
          pageStart: chunk.pageStart,
          pageEnd: chunk.pageEnd
        });
      }

      if (!items.length) {
        return {
          success: false,
          error: uniqueIds.length === 1
            ? `No existe el fragmento ${uniqueIds[0]} en las ramas activas.`
            : `Ninguno de los fragmentos solicitados (${uniqueIds.join(', ')}) existe en las ramas activas.`
        };
      }

      if (items.length === 1 && uniqueIds.length === 1) {
        const single = items[0];
        return {
          success: true,
          chunkId: single.chunkId,
          chunkIds: [single.chunkId],
          documentId: single.documentId,
          branchId: single.branchId,
          documentTitle: single.documentTitle,
          sectionTitle: single.sectionTitle,
          order: single.order,
          totalChunks: single.totalChunks,
          prevChunkId: single.prevChunkId,
          nextChunkId: single.nextChunkId,
          documentImageCount: single.documentImageCount,
          charCount: single.charCount,
          content: single.content,
          pageStart: single.pageStart,
          pageEnd: single.pageEnd
        };
      }

      const formattedSections = items.map((item, idx) => {
        const meta = [
          `chunkId: ${item.chunkId}`,
          `Chunk ${Number.isInteger(item.order) ? item.order + 1 : idx + 1} of ${item.totalChunks || '?'}`,
          item.pageStart ? `Page: ${item.pageStart}${item.pageEnd && item.pageEnd !== item.pageStart ? `-${item.pageEnd}` : ''}` : null,
          item.prevChunkId ? `Prev: ${item.prevChunkId}` : null,
          item.nextChunkId ? `Next: ${item.nextChunkId}` : null
        ].filter(Boolean).join(' | ');
        return `### ${item.documentTitle} · ${item.sectionTitle} (${meta})\n\n${item.content}`;
      });

      return {
        success: true,
        chunkId: items[0].chunkId,
        chunkIds: items.map(it => it.chunkId),
        count: items.length,
        items,
        documentTitle: items[0].documentTitle,
        sectionTitle: items.map(it => it.sectionTitle).join(', '),
        charCount: items.reduce((sum, it) => sum + it.charCount, 0),
        content: formattedSections.join('\n\n---\n\n')
      };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  }

  function parseImageReference(value) {
    const match = String(value || '').trim().match(/^rag-image:\/\/([^:\s]+):([^\s:]+)$/i);
    return match ? { documentId: match[1], imageId: match[2] } : null;
  }

  async function readKnowledgeImage(branchIds, rawArgs) {
    const args = parseArguments(rawArgs);
    const imageRef = String(args.imageRef || '').trim();
    const reference = parseImageReference(imageRef);
    if (!reference) return { success: false, error: 'imageRef debe ser una referencia rag-image://docId:imgId válida.' };

    try {
      const branches = await resolveBranches(branchIds);
      const document = await RagStorage.getDocumentById(reference.documentId);
      if (!document || !branches.some(branch => branch.id === document.branchId)) {
        return { success: false, error: `La imagen solicitada no pertenece a las ramas activas.` };
      }
      const image = await RagStorage.getDocumentImage(reference.documentId, reference.imageId);
      if (!image?.dataUrl) return { success: false, error: `No existe una imagen utilizable para ${imageRef}.` };

      const fileParser = getFileParser();
      const dataUrl = image.isCmyk && fileParser?.convertCmykDataUrlToRgb
        ? fileParser.convertCmykDataUrlToRgb(image.dataUrl)
        : image.dataUrl;
      return {
        success: true,
        imageRef,
        documentId: document.id,
        documentTitle: document.title,
        page: Number.isFinite(image.page) ? image.page : null,
        label: String(image.label || ''),
        mimeType: String(image.mimeType || ''),
        dataUrl
      };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  }

  return {
    parseArguments, normalizeBranchIds, resolveBranches,
    normalizeDocumentReference, documentReferenceTokens, selectDocumentCandidate,
    buildRagSystemContext, injectRagContext,
    listDocuments, searchKnowledgeBase, readKnowledgeChunk, readKnowledgeImage,
    parseImageReference
  };
});
