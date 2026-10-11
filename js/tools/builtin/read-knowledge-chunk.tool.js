/** Tool module: read_knowledge_chunk. */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') module.exports = factory(require('../../utils.js'));
  else root.ChatBuiltinReadKnowledgeChunkTool = factory(root.ChatUtils);
})(typeof self !== 'undefined' ? self : this, function (Utils) {
  'use strict';

  const { resolveDep } = Utils;

  const getCards = () => resolveDep('ChatToolCards', './tool-cards.js');

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




  const Icons = resolveDep('ChatIcons', './icons.js');
  const DOC_ICON_SVG = Icons.get('file-text', { size: 14 });

  function createLiveCard(args, ui) {
    const card = getCards().createCardWrapper(ui);
    if (!card) return null;
    const Markdown = ui.markdown;
    const t = ui.t;
    const spinner = ui.SPINNER_SVG;
    const title = t('tool_rag_read_title');
    const ids = Array.isArray(args?.chunkIds) && args.chunkIds.length > 0
      ? args.chunkIds
      : (args?.chunkId ? [args.chunkId] : []);
    const targetLabel = ids.length > 1
      ? `${ids.length} fragmentos`
      : (ids[0] || '');
    const loading = t('tool_rag_read_loading', { chunkId: Markdown.escapeHtml(targetLabel) });
    const retrieving = t('tool_rag_read_retrieving');
    card.innerHTML = getCards().renderCardHtml({
      className: 'rag-execution-card',
      titleHtml: `<span>${DOC_ICON_SVG}</span><span>${title}</span>`,
      badgeHtml: `<span class="tool-card-badge status-loading">${spinner} <span>${loading}</span></span>`,
      bodyHtml: `<div class="tool-card-result"><div class="tool-loading-placeholder">${spinner} <span>${retrieving}</span></div></div>`
    }, ui);
    return card;
  }
  function updateLiveCard(card, _args, result = {}, _elapsedMs, ui) {
    if (!card) return;
    const t = ui.t;
    const Markdown = ui.markdown;
    const checkSvg = ui.CHECK_SVG;
    const errorSvg = ui.ERROR_SVG;
    const success = result?.success !== false && !result?.error;
    const content = result?.content || result?.error || '';
    const badge = card.querySelector('.tool-card-badge');
    const retrievedLabel = t('tool_rag_read_retrieved', { chars: content.length });
    const notFoundLabel = result?.error || t('tool_rag_read_not_found');
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
      metadata: { label: definition.name },
      settings: { showInSettings: false },
      isAvailable: config => Boolean(config.activeRagBranchId || (config.activeRagBranchIds && config.activeRagBranchIds.length > 0)),
      execute: async (args, context = {}) => {
        const service = context.services.ragService;
        return service?.readKnowledgeChunk ? service.readKnowledgeChunk(context.activeRagBranchIds, args) : { success: false, error: 'RAG service not available.' };
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

  const toolModule = { id: definition.name, definition, displayMode: 'collapsed', createTool, view: { id: definition.name, displayMode: 'collapsed', createLiveCard, updateLiveCard, renderHistoricalCard } };
  const manifestApi = resolveDep('ChatToolManifest', './tools/tool-manifest.js');
  if (manifestApi?.builtin && !manifestApi.builtin.has(toolModule.id)) manifestApi.builtin.register(toolModule);
  return toolModule;
});
