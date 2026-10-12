/** Herramienta nativa list_documents. */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') module.exports = factory(require('../../utils.js'), require('../../i18n.js'));
  else root.ChatBuiltinListDocumentsTool = factory(root.ChatUtils, root.ChatI18n);
})(typeof self !== 'undefined' ? self : this, function (Utils, I18n) {
  'use strict';

  const { t } = I18n;
  const Cards = Utils.resolveDep('ChatToolCards', './tool-cards.js');

  return {
    definition: {
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
    },
    aliases: ['list_knowledge_base', 'list_docs', 'get_documents', 'listar_documentos'],
    category: 'rag',
    settings: { showInSettings: false },
    isAvailable: config => config.activeRagBranchIds.length > 0,
    execute: (args, context) => context.services.ragService.listDocuments(context.activeRagBranchIds, args),
    result: {
      toModel: (_args, result) => result.text || JSON.stringify(result),
      toMarkdown: (args, result) => `> **list_documents** (${result.count || 0} indexed documents${args.filter ? `, filter "${args.filter}"` : ''})\n\n`
    },
    view: Cards.createTextResultView({
      icon: 'layers',
      title: () => t('tool_rag_list_title'),
      loadingLabel: () => t('tool_rag_list_loading'),
      placeholderKey: 'tool_rag_list_retrieving',
      successLabel: (result, elapsedMs) => `${t('tool_rag_list_indexed', { count: result.count ?? 0, plural: result.count === 1 ? '' : 's' })} (${elapsedMs}ms)`,
      errorKey: 'tool_err_query',
      getText: result => result.text || result.content || ''
    })
  };
});
