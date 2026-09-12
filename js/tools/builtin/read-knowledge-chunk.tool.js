/** Tool module: read_knowledge_chunk. */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') module.exports = factory();
  else root.ChatBuiltinReadKnowledgeChunkTool = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const definition = {
    name: 'read_knowledge_chunk',
    description: 'Reads the full content of one or several previously located chunks. Accepts chunkId for a single chunk or chunkIds (list of identifiers) to retrieve up to 5 at once in a single turn (prefer 1-2 chunks for dense financial tables). Use as internal evidence; then synthesize and respond.',
    parameters: {
      type: 'object',
      properties: {
        chunkIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of chunk identifiers to read simultaneously in a single turn (max 5; prefer 1-2 for dense tables).'
        },
        chunkId: {
          type: 'string',
          description: 'Unique chunk identifier (chunkId). Accepted as an alternative or complement to chunkIds.'
        }
      }
    }
  };

  function getRagService(context = {}) {
    if (context.services?.ragService) return context.services.ragService;
    if (typeof window !== 'undefined' && window.ChatRagService) return window.ChatRagService;
    if (typeof require !== 'undefined') { try { return require('../../rag-service.js'); } catch (_) {} }
    return null;
  }

  function getBranchIds(context = {}) {
    return context.activeRagBranchIds || context.activeRagBranchId || context.branchId || context.config?.activeRagBranchIds || context.config?.activeRagBranchId || '';
  }
  const getBranchId = getBranchIds;

  function createCardWrapper(ui) {
    if (ui?.createCardWrapper) return ui.createCardWrapper();
    const doc = ui?.document || (typeof document !== 'undefined' ? document : null);
    if (!doc) return null;
    const card = doc.createElement('div');
    card.className = 'tool-card-wrapper';
    return card;
  }

  const DOC_ICON_SVG = '<svg class="ui-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>';

  const safeEscapeHtml = (value) => String(value || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function createLiveCard(args, ui) {
    const card = createCardWrapper(ui);
    if (!card) return null;
    const Markdown = ui?.markdown || (typeof window !== 'undefined' && window.ChatMarkdown) || (typeof window !== 'undefined' && window.ChatUtils) || { escapeHtml: safeEscapeHtml };
    const t = ui?.t || ((key, params) => key);
    const spinner = ui?.SPINNER_SVG || '';
    const chevron = ui?.CHEVRON_SVG || '';
    const title = t('tool_rag_read_title') || 'Fragmento de conocimiento';
    const ids = Array.isArray(args?.chunkIds) && args.chunkIds.length > 0
      ? args.chunkIds
      : (args?.chunkId ? [args.chunkId] : []);
    const targetLabel = ids.length > 1
      ? `${ids.length} fragmentos`
      : (ids[0] || '');
    const loading = t('tool_rag_read_loading', { chunkId: Markdown.escapeHtml(targetLabel) }) || `Leyendo ${Markdown.escapeHtml(targetLabel)}...`;
    const retrieving = t('tool_rag_read_retrieving') || 'Recuperando texto desde IndexedDB...';
    card.innerHTML = `<div class="tool-execution-card rag-execution-card"><div class="tool-card-header"><div class="tool-card-title"><span>${DOC_ICON_SVG}</span><span>${title}</span></div><div class="tool-card-header-actions"><span class="tool-card-badge status-loading">${spinner} <span>${loading}</span></span><button type="button" class="btn-tool-collapse" title="${t('tool_btn_collapse') || 'Minimizar'}">${chevron}</button></div></div><div class="tool-card-collapsible-body"><div class="tool-card-result"><div class="tool-loading-placeholder">${spinner} <span>${retrieving}</span></div></div></div></div>`;
    return card;
  }
  function updateLiveCard(card, _args, result = {}, _elapsedMs, ui) {
    if (!card) return;
    const t = ui?.t || ((key, params) => key);
    const Markdown = ui?.markdown || (typeof window !== 'undefined' && window.ChatMarkdown) || (typeof window !== 'undefined' && window.ChatUtils) || { escapeHtml: safeEscapeHtml };
    const checkSvg = ui?.CHECK_SVG || '';
    const errorSvg = ui?.ERROR_SVG || '';
    const success = result?.success !== false && !result?.error;
    const content = result?.content || result?.error || '';
    const badge = card.querySelector('.tool-card-badge');
    const count = result?.count || (result?.chunkIds?.length) || 1;
    const countLabel = count > 1 ? `${count} fragmentos recuperados` : 'Fragmento recuperado';
    const retrievedLabel = t('tool_rag_read_retrieved', { chars: content.length }) || `${countLabel} (${content.length} caracteres)`;
    const notFoundLabel = result?.error || t('tool_rag_read_not_found') || 'No encontrado';
    if (badge) {
      badge.className = `tool-card-badge ${success ? 'status-success' : 'status-error'}`;
      badge.innerHTML = success ? `${checkSvg} <span>${retrievedLabel}</span>` : `${errorSvg} <span>${Markdown.escapeHtml(notFoundLabel)}</span>`;
    }
    const body = card.querySelector('.tool-card-result');
    if (body) body.innerHTML = `<pre class="tool-result-pre"><code>${Markdown.escapeHtml(content.slice(0, 3000))}${content.length > 3000 ? '\n…' : ''}</code></pre>`;
  }
  function renderHistoricalCard(args, message, ui) {
    const card = createLiveCard(args, ui); if (!card) return null;
    let result = {}; try { result = JSON.parse(message?.content || '{}'); } catch (_) { result = { content: message?.content || '' }; }
    updateLiveCard(card, args, result, 0, ui); return card;
  }

  function createTool(Tool) {
    if (typeof Tool !== 'function') throw new Error('La clase Tool es necesaria para crear read_knowledge_chunk.');
    return new Tool({
      id: definition.name,
      definition,
      aliases: [],
      category: 'rag',
      metadata: { icon: 'file-text', label: definition.name },
      settings: { showInSettings: false },
      isAvailable: config => Boolean(config.activeRagBranchId || (config.activeRagBranchIds && config.activeRagBranchIds.length > 0)),
      execute: async (args, context = {}) => {
        const service = getRagService(context);
        return service?.readKnowledgeChunk ? service.readKnowledgeChunk(getBranchIds(context), args) : { success: false, error: 'Servicio de RAG no disponible.' };
      },
      result: {
        toModel: (_args, result) => result?.content || JSON.stringify(result || {}),
        toMarkdown: (args, result) => {
          const ids = result?.chunkIds || (args?.chunkIds) || [args?.chunkId || ''];
          return `> **read_knowledge_chunk** (${ids.join(', ')})\n\n`;
        }
      },
      displayMode: 'collapsed',
      view: { id: definition.name, displayMode: 'collapsed', createLiveCard, updateLiveCard, renderHistoricalCard }
    });
  }

  const toolModule = { id: definition.name, definition, displayMode: 'collapsed', createTool, getRagService, getBranchId, view: { id: definition.name, displayMode: 'collapsed', createLiveCard, updateLiveCard, renderHistoricalCard } };
  let manifestApi = null;
  if (typeof window !== 'undefined' && window.ChatToolManifest) manifestApi = window.ChatToolManifest;
  else if (typeof require !== 'undefined') { try { manifestApi = require('../tool-manifest.js'); } catch (_) {} }
  if (manifestApi?.builtin && !manifestApi.builtin.has(toolModule.id)) manifestApi.builtin.register(toolModule);
  return toolModule;
});
