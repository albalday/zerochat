/** Tool autocontenida: list_documents. */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') module.exports = factory(require('../../utils.js'), require('../../icons.js'));
  else root.ChatBuiltinListDocumentsTool = factory(root.ChatUtils, root.ChatIcons);
})(typeof self !== 'undefined' ? self : this, function (Utils, Icons) {
  'use strict';

  const { resolveDep } = Utils;

  const getCards = () => resolveDep('ChatToolCards', './tool-cards.js');

  const definition = {
    name: 'list_documents',
    description: 'Returns the catalog of available documents (title, chunks, and images). Accepts an optional filter to narrow documents by title keywords (e.g. "Walmart", "2020", "10K"). Use it when you do not know the available sources or when a previous search did not find the expected document.',
    parameters: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          description: 'Optional keyword, company name, year, or topic to filter document titles (e.g. "Walmart", "2020", "10-K"). If omitted, returns all documents.'
        }
      },
      required: []
    }
  };



  const LAYERS_ICON_SVG = Icons.get('layers', { size: 14 });


  function createLiveCard(_args, ui) {
    const card = getCards().createCardWrapper(ui);
    if (!card) return null;
    const t = ui.t;
    const spinner = ui.SPINNER_SVG;
    const title = t('tool_rag_list_title');
    const loading = t('tool_rag_list_loading');
    const retrieving = t('tool_rag_list_retrieving');
    card.innerHTML = getCards().renderCardHtml({
      className: 'rag-execution-card',
      titleHtml: `<span>${LAYERS_ICON_SVG}</span><span>${title}</span>`,
      badgeHtml: `<span class="tool-card-badge status-loading">${spinner} <span>${loading}</span></span>`,
      bodyHtml: `<div class="tool-card-result"><div class="tool-loading-placeholder">${spinner} <span>${retrieving}</span></div></div>`
    }, ui);
    return card;
  }

  function updateLiveCard(card, _args, result = {}, elapsedMs = 0, ui) {
    if (!card) return;
    const t = ui.t;
    const Markdown = ui.markdown;
    const checkSvg = ui.CHECK_SVG;
    const errorSvg = ui.ERROR_SVG;
    const success = result?.success !== false && !result?.error;
    const count = result?.count ?? 0;
    const text = result?.text || (typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result || ''));
    const indexedLabel = t('tool_rag_list_indexed', { count, plural: count === 1 ? '' : 's' });
    const errorLabel = result?.error || t('tool_err_query');
    const badge = card.querySelector('.tool-card-badge');
    if (badge) {
      badge.className = `tool-card-badge ${success ? 'status-success' : 'status-error'}`;
      badge.innerHTML = success ? `${checkSvg} <span>${indexedLabel} (${elapsedMs || 0}ms)</span>` : `${errorSvg} <span>${Markdown.escapeHtml(errorLabel)}</span>`;
    }
    const body = card.querySelector('.tool-card-result');
    if (body) body.innerHTML = `<pre class="tool-result-pre"><code>${Markdown.escapeHtml(text.slice(0, 3000))}${text.length > 3000 ? `\n${Markdown.escapeHtml(t('tool_card_truncated'))}` : ''}</code></pre>`;
  }
  function renderHistoricalCard(args, message, ui) { const card = createLiveCard(args, ui); if (!card) return null; let result = {}; if (message?.content) { try { result = JSON.parse(message.content); } catch (e) { result = { text: message.content }; } } updateLiveCard(card, args, result, 0, ui); return card; }

  function createTool(Tool) {
    if (typeof Tool !== 'function') throw new Error('La clase Tool es necesaria para crear list_documents.');
    return new Tool({
      id: definition.name,
      definition,
      aliases: ['listdocuments', 'list_knowledge_base', 'list_docs', 'get_documents', 'listar_documentos'],
      category: 'rag',
      metadata: { label: definition.name },
      settings: { showInSettings: false },
      isAvailable: config => config.activeRagBranchIds.length > 0,
      execute: async (args = {}, context = {}) => {
        const RagService = context.services.ragService;
        if (!RagService?.listDocuments) return { success: false, error: 'RAG service not available.' };
        return RagService.listDocuments(context.activeRagBranchIds, args);
      },
      result: {
        toModel: (_args, result) => result?.text || JSON.stringify(result || {}),
        toMarkdown: (args, result) => {
          const filterSuffix = args?.filter ? ` filtrado por "${args.filter}"` : '';
          return `> **list_documents** (${result?.count || 0} documentos indexados${filterSuffix})\n\n`;
        }
      },
      displayMode: 'collapsed',
      view: { id: definition.name, displayMode: 'collapsed', createLiveCard, updateLiveCard, renderHistoricalCard }
    });
  }

  const toolModule = { id: definition.name, definition, displayMode: 'collapsed', createTool, view: { id: definition.name, displayMode: 'collapsed', createLiveCard, updateLiveCard, renderHistoricalCard } };
  const manifestApi = resolveDep('ChatToolManifest', './tools/tool-manifest.js');
  if (manifestApi?.builtin && !manifestApi.builtin.has(toolModule.id)) manifestApi.builtin.register(toolModule);
  return toolModule;
});
