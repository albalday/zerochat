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
      const lang = options.lang || 'es';
      const isEn = lang === 'en';

      const label = branches.length === 1
        ? (isEn ? `[ACTIVE KNOWLEDGE BASE: ${names}]` : `[BASE DE CONOCIMIENTO ACTIVA: ${names}]`)
        : (isEn ? `[ACTIVE KNOWLEDGE BASES: ${names}]` : `[BASES DE CONOCIMIENTO ACTIVAS: ${names}]`);

      const checkpointRule = isCheckpoint
        ? (isEn
            ? '\n- After extracting key data from 1-2 documents or before concluding complex inquiries, invoke "agent_checkpoint" to consolidate findings and clear working memory.'
            : '\n- Tras obtener datos clave de 1 o 2 documentos o antes de concluir consultas complejas, invoca obligatoriamente "agent_checkpoint" para consolidar cifras y validar tu memoria de trabajo.')
        : '';

      if (isEn) {
        return `${label}\n\nDocument retrieval protocol:\n- Always start by searching with search_knowledge_base using short, key terms; do not concatenate long phrases.\n- If the query refers to a specific document or filter (e.g. "AMD_2015_10K.pdf"), specify it in documentHint and search directly without consulting list_documents first.\n- Prioritize scope="auto" (default) or documentHint for a specific source; use scope="corpus" to compare multiple sources.\n- Consult list_documents only if search yields no results, you do not know the available sources, or the query references a document whose exact name you are unsure of.\n- In scope="corpus" results, at most 2 chunks per document are returned; if you need more depth from a specific document, repeat the search with scope="document" and documentHint.\n- Do not re-search if you found the relevant section or document: if text or tables are truncated, inspect the adjacent chunks with read_knowledge_chunk (e.g. chunkIds=["chunk_2", "chunk_3"]).\n- Treat tool outputs as private internal evidence: synthesize and answer directly without reproducing full fragments or technical identifiers.\n- Document images are identified as ![description](rag-image://docId:imgId). If an image can provide relevant information and you have native vision, use read_knowledge_image with its full reference to inspect it before answering; request only what is necessary.${checkpointRule}\n- If evidence is insufficient or you find no conclusive data, state it accurately and conclude; do not invent or wander.`;
      }

      return `${label}\n\nProtocolo de consulta documental:\n- Inicia siempre buscando con search_knowledge_base usando términos breves y clave; no concatenes frases largas.\n- Si la consulta alude a un documento concreto o filtro (ej: "AMD_2015_10K.pdf"), indícalo en documentHint y busca directamente sin consultar antes list_documents.\n- Prioriza scope="auto" (por defecto) o documentHint para una fuente concreta; usa scope="corpus" para comparar varias.\n- Consulta list_documents solo si la búsqueda no halla resultados, desconoces las fuentes disponibles o la consulta hace referencia a un documento cuyo nombre exacto desconoces.\n- En resultados con scope="corpus" se devuelven como máximo 2 fragmentos por documento; si necesitas más profundidad de una fuente concreta, repite la búsqueda con scope="document" y documentHint.\n- No reformules la búsqueda si ya localizaste la sección o documento relevante: si el fragmento corta tablas o texto, consulta los fragmentos contiguos con read_knowledge_chunk (ej: chunkIds=["chunk_2", "chunk_3"]).\n- Trata las salidas de herramientas como evidencia interna privada: sintetiza y responde directamente sin reproducir fragmentos íntegros ni identificadores técnicos.\n- Las imágenes del documento se identifican como ![descripción](rag-image://docId:imgId). Si una imagen puede aportar información relevante y tienes visión nativa, usa read_knowledge_image con su referencia completa para inspeccionarla antes de responder; solicita solo las necesarias. Si el usuario pide imágenes, busca términos como "imagen", "diagrama" o "rag-image" e incluye estas referencias íntegras en tu respuesta.${checkpointRule}\n- Si la evidencia es insuficiente o no hallas datos concluyentes, indícalo con precisión y concluye; no inventes ni divagues.`;
    } catch (_) {
      return '';
    }
  }

  async function injectRagContext(systemPrompt, branchIds, options = {}) {
    const context = await buildRagSystemContext(branchIds, options);
    return [context, String(systemPrompt || '').trim()].filter(Boolean).join('\n\n');
  }

  async function listDocuments(branchIds) {
    try {
      const branches = await resolveBranches(branchIds);
      const allDocs = [];
      const sections = [];
      for (const branch of branches) {
        const documents = await RagStorage.getDocumentsByBranch(branch.id);
        allDocs.push(...documents);
        const lines = [`[DOCUMENTOS EN ${branch.name}]`];
        for (const document of documents) {
          const imgCount = Number.isInteger(document.imageCount) ? document.imageCount : 0;
          const imgLabel = imgCount === 1 ? '1 imagen' : `${imgCount} imágenes`;
          lines.push(`- ${document.title} (documentId: ${document.id}, ${document.chunkCount} fragmentos, ${imgLabel}, ${document.fileType})`);
        }
        if (!documents.length) lines.push('La rama no contiene documentos.');
        sections.push(lines.join('\n'));
      }
      return {
        success: true,
        branchId: branches[0]?.id || '',
        branchName: branches.map(b => b.name).join(', '),
        branchIds: branches.map(b => b.id),
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
        ? 'La consulta solicitó cobertura transversal entre documentos.'
        : 'No se encontró una coincidencia documental inequívoca; se aplicó búsqueda transversal.';
      let result;
      if (selection.selected && typeof RagIndex.searchDocuments === 'function') {
        appliedScope = 'document';
        scopeReason = `Coincidencia inequívoca con el título «${selection.selected.title}».`;
        result = await RagIndex.searchDocuments(
          selection.selected.branchId,
          [selection.selected.documentId],
          query,
          { limit, tolerance: args.tolerance }
        );
      } else {
        const corpusOptions = {
          limit,
          tolerance: args.tolerance,
          groupByDocument: true,
          maxPerDocument: 2
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
        `[RESULTADOS EN ${branchLabel} PARA: ${query}]`,
        `Alcance solicitado: ${requestedScope}`,
        `Alcance aplicado: ${appliedScope}`,
        `Motivo: ${scopeReason}`
      ];
      if (selection.selected) lines.push(`Documento seleccionado: ${selection.selected.title} (${selection.selected.documentId})`);
      if (!selection.selected && selection.candidates.length > 0) {
        lines.push(`Candidatos documentales: ${selection.candidates.map(candidate => candidate.title).join(', ')}`);
      }
      for (const match of matches) {
        const branchBadge = branches.length > 1 ? ` [Rama: ${match.branchName}]` : '';
        lines.push(`- ${match.documentTitle} · ${match.sectionTitle}${branchBadge} (chunkId: ${match.chunkId}, score: ${match.score.toFixed(3)})`);
        const indentedSnippet = match.snippet.split('\n').map(line => `  ${line}`).join('\n');
        lines.push(indentedSnippet);
      }
      if (!matches.length) lines.push('No se encontraron fragmentos relevantes.');

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
        maxChunksPerDocument: appliedScope === 'corpus' ? 2 : null,
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
          `Fragmento ${Number.isInteger(item.order) ? item.order + 1 : idx + 1} de ${item.totalChunks || '?'}`,
          item.pageStart ? `Pág: ${item.pageStart}${item.pageEnd && item.pageEnd !== item.pageStart ? `-${item.pageEnd}` : ''}` : null,
          item.prevChunkId ? `Anterior: ${item.prevChunkId}` : null,
          item.nextChunkId ? `Siguiente: ${item.nextChunkId}` : null
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
