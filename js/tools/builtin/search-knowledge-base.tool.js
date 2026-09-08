/** Tool autocontenida: search_knowledge_base. */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') module.exports = factory();
  else root.ChatBuiltinSearchKnowledgeBaseTool = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const definition = {
    name: 'search_knowledge_base',
    description: 'Searches for relevant text chunks or images in the knowledge base. Use scope="document" with documentHint when the user mentions a specific document or filter (e.g. "AMD_2015_10K.pdf"), scope="corpus" for cross-document searches, or scope="auto" (default).',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Term, topic, metric, or keywords to search in the document or knowledge base (direct terms, no quotes).' },
        scope: {
          type: 'string',
          enum: ['auto', 'document', 'corpus'],
          description: 'Search scope: "document" for a specific identifiable source, "corpus" for multiple sources, "auto" when unclear. Defaults to "auto".'
        },
        documentHint: {
          type: 'string',
          description: 'Exact name, filename, or filter for the source mentioned by the user (e.g. "AMD_2015_10K.pdf", "WALMART_2015_10K.pdf").'
        },
        limit: { type: 'integer', description: 'Optional number of chunks to return (default 10).' }
      },
      required: ['query']
    }
  };

  function getBranchIds(context = {}) {
    return context.activeRagBranchIds || context.activeRagBranchId || context.branchId || context.config?.activeRagBranchIds || context.config?.activeRagBranchId || '';
  }
  const getBranchId = getBranchIds;

  function getRagService(context = {}) {
    if (context.services?.ragService) return context.services.ragService;
    if (typeof window !== 'undefined' && window.ChatRagService) return window.ChatRagService;
    if (typeof require !== 'undefined') {
      try { return require('../../rag-service.js'); } catch (e) {}
    }
    return null;
  }

  const DB_ICON_SVG = '<svg class="ui-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"></ellipse><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path></svg>';

  function createCardWrapper(ui) {
    if (ui?.createCardWrapper) return ui.createCardWrapper();
    const doc = ui?.document || (typeof document !== 'undefined' ? document : null);
    if (!doc) return null;
    const card = doc.createElement('div');
    card.className = 'tool-card-wrapper';
    return card;
  }

  function createLiveCard(args, ui) {
    const card = createCardWrapper(ui);
    if (!card) return null;
    const Markdown = ui?.markdown || { escapeHtml: (v) => String(v || '') };
    const t = ui?.t || ((key, params) => key);
    const spinner = ui?.SPINNER_SVG || '';
    const chevron = ui?.CHEVRON_SVG || '';
    const query = args?.query || args?.q || args?.search || '';
    const title = t('tool_rag_search_title', { query: Markdown.escapeHtml(query) }) || `Conocimiento local: "${Markdown.escapeHtml(query)}"`;
    const loading = t('tool_rag_search_loading') || 'Buscando con Orama...';
    const building = t('tool_rag_search_building') || 'Construyendo el índice local...';
    card.innerHTML = `<div class="tool-execution-card rag-execution-card"><div class="tool-card-header"><div class="tool-card-title"><span>${DB_ICON_SVG}</span><span>${title}</span></div><div class="tool-card-header-actions"><span class="tool-card-badge status-loading">${spinner} <span>${loading}</span></span><button type="button" class="btn-tool-collapse" title="${t('tool_btn_collapse') || 'Minimizar'}">${chevron}</button></div></div><div class="tool-card-collapsible-body"><div class="tool-card-result"><div class="tool-loading-placeholder">${spinner} <span>${building}</span></div></div></div></div>`;
    return card;
  }

  function updateLiveCard(card, _args, result = {}, elapsedMs = 0, ui) {
    if (!card) return;
    const t = ui?.t || ((key, params) => key);
    const Markdown = ui?.markdown || { escapeHtml: (v) => String(v || '') };
    const checkSvg = ui?.CHECK_SVG || '';
    const errorSvg = ui?.ERROR_SVG || '';
    const success = result?.success !== false && !result?.error;
    const count = result?.matchesCount ?? 0;
    const text = result?.text || (typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result || ''));
    const badge = card.querySelector('.tool-card-badge');
    const matchesLabel = t('tool_rag_search_matches', { count, plural: count === 1 ? '' : 's', scope: result?.appliedScope || 'auto' }) || `${count} coincidencia${count === 1 ? '' : 's'} · ${result?.appliedScope || 'auto'}`;
    const errorLabel = result?.error || t('tool_err_query') || 'Error al consultar';
    if (badge) {
      badge.className = `tool-card-badge ${success ? 'status-success' : 'status-error'}`;
      badge.innerHTML = success ? `${checkSvg} <span>${matchesLabel} (${elapsedMs || 0}ms)</span>` : `${errorSvg} <span>${errorLabel}</span>`;
    }
    const body = card.querySelector('.tool-card-result');
    if (body) body.innerHTML = `<pre class="tool-result-pre"><code>${Markdown.escapeHtml(text.slice(0, 3000))}${text.length > 3000 ? '\n... (texto completo truncado en tarjeta)' : ''}</code></pre>`;
  }
  function renderHistoricalCard(args, message, ui) { const card = createLiveCard(args, ui); if (!card) return null; let result = {}; if (message?.content) { try { result = JSON.parse(message.content); } catch (e) { result = { text: message.content }; } } updateLiveCard(card, args, result, 0, ui); return card; }

  function createTool(Tool) {
    if (typeof Tool !== 'function') throw new Error('La clase Tool es necesaria para crear search_knowledge_base.');
    return new Tool({
      id: definition.name,
      definition,
      aliases: ['search_kb', 'searchknowledgebase', 'search_documents', 'search_knowledge', 'buscar_en_documentos'],
      category: 'rag',
      metadata: { icon: 'search', label: definition.name },
      settings: { showInSettings: false },
      isAvailable: (config = {}) => Boolean(config.activeRagBranchId || (config.activeRagBranchIds && config.activeRagBranchIds.length > 0)),
      execute: async (args, context = {}) => {
        const RagService = getRagService(context);
        if (!RagService?.searchKnowledgeBase) return { success: false, error: 'Servicio de RAG no disponible.' };
        return RagService.searchKnowledgeBase(getBranchIds(context), args);
      },
      result: {
        toModel: (_args, result) => result?.text || JSON.stringify(result || {}),
        toMarkdown: (args, result) => `> **search_knowledge_base** ("${args.query || ''}") [${result?.matchesCount || 0} coincidencias]\n\n`
      },
      displayMode: 'collapsed',
      view: { id: definition.name, displayMode: 'collapsed', createLiveCard, updateLiveCard, renderHistoricalCard }
    });
  }

  const toolModule = { id: definition.name, definition, displayMode: 'collapsed', createTool, getBranchId, getRagService, view: { id: definition.name, displayMode: 'collapsed', createLiveCard, updateLiveCard, renderHistoricalCard } };
  let manifestApi = null;
  if (typeof window !== 'undefined' && window.ChatToolManifest) manifestApi = window.ChatToolManifest;
  else if (typeof require !== 'undefined') { try { manifestApi = require('../tool-manifest.js'); } catch (e) {} }
  if (manifestApi?.builtin && !manifestApi.builtin.has(toolModule.id)) manifestApi.builtin.register(toolModule);
  return toolModule;
});
