/** Tool module: read_knowledge_image. */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') module.exports = factory();
  else root.ChatBuiltinReadKnowledgeImageTool = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const definition = {
    name: 'read_knowledge_image',
    description: 'Retrieves an image from a RAG document to inspect it visually. Use only if you have native vision capability and the image may provide relevant information. Provide a full rag-image://docId:imgId reference obtained from the document; do not invent identifiers. If you cannot process images, do not use this tool.',
    parameters: { type: 'object', properties: { imageRef: { type: 'string', description: 'Full rag-image://docId:imgId reference obtained from a RAG document.' } }, required: ['imageRef'] }
  };
  function getRagService(context = {}) {
    if (context.services?.ragService) return context.services.ragService;
    if (typeof window !== 'undefined' && window.ChatRagService) return window.ChatRagService;
    if (typeof require !== 'undefined') { try { return require('../../rag-service.js'); } catch (_) { /* módulo opcional: no disponible en este entorno */ } }
    return null;
  }
  function getBranchIds(context = {}) { return context.activeRagBranchIds || context.activeRagBranchId || context.branchId || context.config?.activeRagBranchIds || context.config?.activeRagBranchId || ''; }
  function getMarkdown(ui) {
    if (ui?.markdown?.escapeHtml) return ui.markdown;
    if (typeof window !== 'undefined' && window.ChatMarkdown?.escapeHtml) return window.ChatMarkdown;
    if (typeof require !== 'undefined') {
      try {
        const md = require('../../markdown.js');
        if (md?.escapeHtml) return md;
      } catch (_) { /* módulo opcional: no disponible en este entorno */ }
    }
    return {
      escapeHtml: value => String(value || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
    };
  }

  const getCards = () => typeof window !== 'undefined' && window.ChatToolCards || require('../../tool-cards.js');

  function createLiveCard(args, ui) {
    const card = getCards().createCardWrapper(ui);
    if (!card) return null;
    const t = ui?.t || (key => key);
    const md = getMarkdown(ui);
    card.innerHTML = getCards().renderCardHtml({
      titleHtml: `<span>${md.escapeHtml(t('tool_rag_image_title'))}</span>`,
      badgeHtml: `<span class="tool-card-badge status-loading">${ui?.SPINNER_SVG || ''}<span>${md.escapeHtml(t('tool_badge_executing'))}</span></span>`,
      bodyHtml: `<div class="tool-card-result"><code>${md.escapeHtml(args?.imageRef || '')}</code><div class="rag-image-result"></div></div>`
    }, ui);
    return card;
  }

  function updateLiveCard(card, _args, result, elapsedMs, ui) {
    if (!card) return;
    const t = ui?.t || (key => key);
    const success = result?.success !== false && !result?.error;
    const badge = card.querySelector('.tool-card-badge');
    if (badge) {
      badge.className = `tool-card-badge ${success ? 'status-success' : 'status-error'}`;
      badge.innerHTML = `${success ? ui?.CHECK_SVG || '' : ui?.ERROR_SVG || ''}<span>${getMarkdown(ui).escapeHtml(t(success ? 'tool_status_success' : 'tool_status_error', { ms: elapsedMs || 0 }))}</span>`;
    }
    const body = card.querySelector('.rag-image-result');
    if (body) body.textContent = success ? result?.documentTitle || result?.imageRef || '' : result?.error || '';
  }

  function renderHistoricalCard(args, toolMessage, ui) {
    const cardDiv = createLiveCard(args, ui);
    if (!cardDiv) return null;
    let result = {};
    if (toolMessage?.content) {
      try { result = JSON.parse(toolMessage.content); } catch (_) { result = { content: toolMessage.content }; }
    }
    updateLiveCard(cardDiv, args, result, 0, ui);
    return cardDiv;
  }

  function createTool(Tool) {
    if (typeof Tool !== 'function') throw new Error('La clase Tool es necesaria para crear read_knowledge_image.');
    return new Tool({
      id: definition.name,
      definition,
      aliases: [],
      category: 'rag',
      metadata: { icon: 'image', label: definition.name },
      settings: { showInSettings: false },
      isAvailable: config => Boolean(config.activeRagBranchId || (config.activeRagBranchIds && config.activeRagBranchIds.length > 0)),
      execute: async (args, context = {}) => {
        const service = getRagService(context);
        return service?.readKnowledgeImage ? service.readKnowledgeImage(getBranchIds(context), args) : { success: false, error: 'RAG service not available.' };
      },
      result: {
        toModel: (_args, result) => result?.success ? `Image retrieved: ${result.imageRef}${result.documentTitle ? ` (${result.documentTitle}${result.page ? `, page ${result.page}` : ''})` : ''}. Inspect it visually to answer.` : JSON.stringify(result || {}),
        toMarkdown: (args, result) => result?.success ? `> **read_knowledge_image** (${result.imageRef})\n\n` : `> **read_knowledge_image** (${args?.imageRef || ''}) · ${result?.error || 'Error'}\n\n`
      },
      displayMode: 'collapsed',
      view: { id: definition.name, displayMode: 'collapsed', createLiveCard, updateLiveCard, renderHistoricalCard }
    });
  }
  const toolModule = { id: definition.name, definition, displayMode: 'collapsed', createTool, getRagService, view: { id: definition.name, displayMode: 'collapsed', createLiveCard, updateLiveCard, renderHistoricalCard } };
  let manifestApi = null;
  if (typeof window !== 'undefined' && window.ChatToolManifest) manifestApi = window.ChatToolManifest;
  else if (typeof require !== 'undefined') { try { manifestApi = require('../tool-manifest.js'); } catch (_) { /* módulo opcional: no disponible en este entorno */ } }
  if (manifestApi?.builtin && !manifestApi.builtin.has(toolModule.id)) manifestApi.builtin.register(toolModule);
  return toolModule;
});
