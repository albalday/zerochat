/** Tool module: read_knowledge_image. */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') module.exports = factory();
  else root.ChatBuiltinReadKnowledgeImageTool = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const definition = {
    name: 'read_knowledge_image',
    description: 'Recupera una imagen de un documento del RAG para inspeccionarla visualmente. Úsala solo si tienes capacidad de visión nativa y consideras que puede aportar información relevante. Proporciona una referencia completa rag-image://docId:imgId obtenida del documento; no inventes identificadores. Si no puedes procesar imágenes, no uses esta herramienta.',
    parameters: { type: 'object', properties: { imageRef: { type: 'string', description: 'Referencia completa rag-image://docId:imgId obtenida de un documento del RAG.' } }, required: ['imageRef'] }
  };
  function getRagService(context = {}) {
    if (context.services?.ragService) return context.services.ragService;
    if (typeof window !== 'undefined' && window.ChatRagService) return window.ChatRagService;
    if (typeof require !== 'undefined') { try { return require('../../rag-service.js'); } catch (_) {} }
    return null;
  }
  function getBranchIds(context = {}) { return context.activeRagBranchIds || context.activeRagBranchId || context.branchId || context.config?.activeRagBranchIds || context.config?.activeRagBranchId || ''; }
  function createLiveCard(args, ui) {
    if (ui?.createCardWrapper) return ui.createCardWrapper();
    const doc = ui?.document || (typeof document !== 'undefined' ? document : null);
    if (!doc) return null;
    const cardDiv = doc.createElement('div');
    cardDiv.className = 'tool-card-wrapper';
    const t = ui?.t || ((key) => key);
    cardDiv.innerHTML = `<div class="rag-image-card"><div class="rag-card-header"><span>${t('tool_rag_image_title') || 'Imagen RAG'}</span>: <code>${args?.imageRef || ''}</code></div></div>`;
    return cardDiv;
  }

  function updateLiveCard(cardDiv, args, result, _elapsedMs, ui) {
    if (!cardDiv) return;
    const t = ui?.t || ((key) => key);
    const content = result?.success ? (result.documentTitle || result.imageRef) : (result?.error || 'Error');
    cardDiv.innerHTML = `<div class="rag-image-card"><div class="rag-card-header"><span>${t('tool_rag_image_title') || 'Imagen RAG'}</span>: <code>${args?.imageRef || ''}</code></div><div class="rag-card-body">${content}</div></div>`;
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
        return service?.readKnowledgeImage ? service.readKnowledgeImage(getBranchIds(context), args) : { success: false, error: 'Servicio de RAG no disponible.' };
      },
      result: {
        toModel: (_args, result) => result?.success ? `Imagen recuperada: ${result.imageRef}${result.documentTitle ? ` (${result.documentTitle}${result.page ? `, página ${result.page}` : ''})` : ''}. Analízala visualmente para responder.` : JSON.stringify(result || {}),
        toMarkdown: (args, result) => result?.success ? `> **read_knowledge_image** (${result.imageRef})\n\n` : `> **read_knowledge_image** (${args?.imageRef || ''}) · ${result?.error || 'Error'}\n\n`
      },
      displayMode: 'collapsed',
      view: { id: definition.name, displayMode: 'collapsed', createLiveCard, updateLiveCard, renderHistoricalCard }
    });
  }
  const toolModule = { id: definition.name, definition, displayMode: 'collapsed', createTool, getRagService, view: { id: definition.name, displayMode: 'collapsed', createLiveCard, updateLiveCard, renderHistoricalCard } };
  let manifestApi = null;
  if (typeof window !== 'undefined' && window.ChatToolManifest) manifestApi = window.ChatToolManifest;
  else if (typeof require !== 'undefined') { try { manifestApi = require('../tool-manifest.js'); } catch (_) {} }
  if (manifestApi?.builtin && !manifestApi.builtin.has(toolModule.id)) manifestApi.builtin.register(toolModule);
  return toolModule;
});
