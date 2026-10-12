/** Herramienta nativa search_knowledge_base. */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') module.exports = factory(require('../../utils.js'), require('../../i18n.js'));
  else root.ChatBuiltinSearchKnowledgeBaseTool = factory(root.ChatUtils, root.ChatI18n);
})(typeof self !== 'undefined' ? self : this, function (Utils, I18n) {
  'use strict';

  const { t } = I18n;
  const Cards = Utils.resolveDep('ChatToolCards', './tool-cards.js');

  return {
    definition: {
      name: 'search_knowledge_base',
      description: 'Searches relevant knowledge-base chunks. Use scope="document" with documentHint for one exact source, scope="corpus" for comparisons or multiple sources, and scope="auto" only when the target scope is unclear. For multi-document retrieval, make one corpus search instead of repeating the same query per document.',
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
          limit: { type: 'integer', description: 'Optional number of chunks to return (default 10).' },
          maxPerDocument: { type: 'integer', description: 'Optional maximum number of chunks per document in corpus search (defaults dynamically to 2-4 depending on document candidates).' }
        },
        required: ['query']
      }
    },
    aliases: ['search_kb', 'search_documents', 'search_knowledge', 'buscar_en_documentos'],
    category: 'rag',
    settings: { showInSettings: false },
    isAvailable: config => config.activeRagBranchIds.length > 0,
    execute: (args, context) => context.services.ragService.searchKnowledgeBase(context.activeRagBranchIds, args),
    result: {
      toModel: (_args, result) => result.text || JSON.stringify(result),
      toMarkdown: (args, result) => `> **search_knowledge_base** ("${args.query || ''}") [${result.matchesCount || 0} matches]\n\n`
    },
    view: Cards.createTextResultView({
      icon: 'database',
      title: args => t('tool_rag_search_title', { query: args.query || args.q || args.search || '' }),
      loadingLabel: () => t('tool_rag_search_loading'),
      placeholderKey: 'tool_rag_search_building',
      successLabel: (result, elapsedMs) => `${t('tool_rag_search_matches', { count: result.matchesCount ?? 0, plural: result.matchesCount === 1 ? '' : 's', scope: result.appliedScope || 'auto' })} (${elapsedMs}ms)`,
      errorKey: 'tool_err_query',
      getText: result => result.text || result.content || ''
    })
  };
});
