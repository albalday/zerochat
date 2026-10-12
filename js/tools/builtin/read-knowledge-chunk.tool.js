/** Herramienta nativa read_knowledge_chunk. */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') module.exports = factory(require('../../utils.js'), require('../../i18n.js'));
  else root.ChatBuiltinReadKnowledgeChunkTool = factory(root.ChatUtils, root.ChatI18n);
})(typeof self !== 'undefined' ? self : this, function (Utils, I18n) {
  'use strict';

  const { t } = I18n;
  const Cards = Utils.resolveDep('ChatToolCards', './tool-cards.js');

  const getChunkIds = args => (Array.isArray(args.chunkIds) && args.chunkIds.length > 0 ? args.chunkIds : (args.chunkId ? [args.chunkId] : []));

  return {
    definition: {
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
    },
    category: 'rag',
    settings: { showInSettings: false },
    isAvailable: config => config.activeRagBranchIds.length > 0,
    execute: (args, context) => context.services.ragService.readKnowledgeChunk(context.activeRagBranchIds, args),
    result: {
      toModel: (_args, result) => result.content || JSON.stringify(result),
      toMarkdown: (args, result) => `> **read_knowledge_chunk** (${(result.chunkIds || getChunkIds(args)).join(', ')})\n\n`
    },
    view: Cards.createTextResultView({
      icon: 'file-text',
      title: () => t('tool_rag_read_title'),
      loadingLabel: args => {
        const ids = getChunkIds(args);
        return t('tool_rag_read_loading', { chunkId: ids.length > 1 ? t('tool_rag_read_many', { count: ids.length }) : (ids[0] || '') });
      },
      placeholderKey: 'tool_rag_read_retrieving',
      successLabel: result => t('tool_rag_read_retrieved', { chars: (result.content || '').length }),
      errorKey: 'tool_rag_read_not_found',
      getText: result => result.content || ''
    })
  };
});
