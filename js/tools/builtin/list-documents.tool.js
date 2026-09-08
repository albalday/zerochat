/** Tool autocontenida: list_documents. */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') module.exports = factory();
  else root.ChatBuiltinListDocumentsTool = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const definition = {
    name: 'list_documents',
    description: 'Returns the catalog of available documents (title, chunks, and images). Use it when you do not know the available sources or when a previous search did not find the expected document.',
    parameters: { type: 'object', properties: {}, required: [] }
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

  const LAYERS_ICON_SVG = '<svg class="ui-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg>';

  function createCardWrapper(ui) {
    if (ui?.createCardWrapper) return ui.createCardWrapper();
    const doc = ui?.document || (typeof document !== 'undefined' ? document : null);
    if (!doc) return null;
    const card = doc.createElement('div');
    card.className = 'tool-card-wrapper';
    return card;
  }

  function createLiveCard(_args, ui) {
    const card = createCardWrapper(ui);
    if (!card) return null;
    const t = ui?.t || ((key) => key);
    const spinner = ui?.SPINNER_SVG || '';
    const chevron = ui?.CHEVRON_SVG || '';
    const title = t('tool_rag_list_title') || 'Base de Conocimiento (Índice de Documentos)';
    const loading = t('tool_rag_list_loading') || 'Consultando documentos indexados...';
    const retrieving = t('tool_rag_list_retrieving') || 'Recuperando documentos desde IndexedDB...';
    card.innerHTML = `<div class="tool-execution-card rag-execution-card"><div class="tool-card-header"><div class="tool-card-title"><span>${LAYERS_ICON_SVG}</span><span>${title}</span></div><div class="tool-card-header-actions"><span class="tool-card-badge status-loading">${spinner} <span>${loading}</span></span><button type="button" class="btn-tool-collapse" title="${t('tool_btn_collapse') || 'Minimizar'}">${chevron}</button></div></div><div class="tool-card-collapsible-body"><div class="tool-card-result"><div class="tool-loading-placeholder">${spinner} <span>${retrieving}</span></div></div></div></div>`;
    return card;
  }

  function updateLiveCard(card, _args, result = {}, elapsedMs = 0, ui) {
    if (!card) return;
    const t = ui?.t || ((key, params) => key);
    const Markdown = ui?.markdown || { escapeHtml: (v) => String(v || '') };
    const checkSvg = ui?.CHECK_SVG || '';
    const errorSvg = ui?.ERROR_SVG || '';
    const success = result?.success !== false && !result?.error;
    const count = result?.count ?? 0;
    const text = result?.text || (typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result || ''));
    const indexedLabel = t('tool_rag_list_indexed', { count, plural: count === 1 ? '' : 's' }) || `${count} doc${count === 1 ? '' : 's'} indexado${count === 1 ? '' : 's'}`;
    const errorLabel = result?.error || t('tool_err_query') || 'Error al consultar';
    const badge = card.querySelector('.tool-card-badge');
    if (badge) {
      badge.className = `tool-card-badge ${success ? 'status-success' : 'status-error'}`;
      badge.innerHTML = success ? `${checkSvg} <span>${indexedLabel} (${elapsedMs || 0}ms)</span>` : `${errorSvg} <span>${errorLabel}</span>`;
    }
    const body = card.querySelector('.tool-card-result');
    if (body) body.innerHTML = `<pre class="tool-result-pre"><code>${Markdown.escapeHtml(text.slice(0, 3000))}${text.length > 3000 ? '\n... (texto completo truncado en tarjeta)' : ''}</code></pre>`;
  }
  function renderHistoricalCard(args, message, ui) { const card = createLiveCard(args, ui); if (!card) return null; let result = {}; if (message?.content) { try { result = JSON.parse(message.content); } catch (e) { result = { text: message.content }; } } updateLiveCard(card, args, result, 0, ui); return card; }

  function createTool(Tool) {
    if (typeof Tool !== 'function') throw new Error('La clase Tool es necesaria para crear list_documents.');
    return new Tool({
      id: definition.name,
      definition,
      aliases: ['listdocuments', 'list_knowledge_base', 'list_docs', 'get_documents', 'listar_documentos'],
      category: 'rag',
      metadata: { icon: 'book-open', label: definition.name },
      settings: { showInSettings: false },
      isAvailable: (config = {}) => Boolean(config.activeRagBranchId || (config.activeRagBranchIds && config.activeRagBranchIds.length > 0)),
      execute: async (_args, context = {}) => {
        const RagService = getRagService(context);
        if (!RagService?.listDocuments) return { success: false, error: 'Servicio de RAG no disponible.' };
        return RagService.listDocuments(getBranchIds(context));
      },
      result: {
        toModel: (_args, result) => result?.text || JSON.stringify(result || {}),
        toMarkdown: (_args, result) => `> **list_documents** (${result?.count || 0} documentos indexados)\n\n`
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
