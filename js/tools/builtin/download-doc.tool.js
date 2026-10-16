/** Herramienta nativa download_doc. */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') module.exports = factory(require('../../utils.js'));
  else root.ChatBuiltinDownloadDocTool = factory(root.ChatUtils);
})(typeof self !== 'undefined' ? self : this, function (Utils) {
  'use strict';

  const Cards = Utils.resolveDep('ChatToolCards', './tool-cards.js');

  return {
    definition: {
      name: 'download_doc',
      description: 'Downloads a PDF or office document (docx, xlsx, pptx, odt, ods, odp) from a web URL and extracts its readable text, tables and slides to analyze and include in the context (e.g. "https://arxiv.org/pdf/2310.06825.pdf").',
      parameters: { type: 'object', properties: { url: { type: 'string', description: 'Direct URL of the PDF or office document to download and extract.' } }, required: ['url'] }
    },
    aliases: ['download_pdf', 'fetch_doc', 'fetch_pdf', 'download_document', 'download_pdf_document', 'fetch_pdf_document', 'download_file', 'getdoc', 'readdoc', 'getpdf', 'readpdf'],
    category: 'web',
    settings: { titleKey: 'agent_doc_title', descKey: 'agent_doc_desc' },
    promptGuide: '- `download_doc(url="...")`: Downloads a PDF or office document (docx, xlsx, pptx, odt, ods, odp) from a URL and extracts its readable text into the prompt context.',
    execute: (args, context) => context.services.webBrowser.fetchPage(Cards.getUrlArg(args)),
    result: {
      toModel: (_args, result) => JSON.stringify(result),
      toMarkdown: args => `> **download_doc**\n> URL: "${Cards.getUrlArg(args)}"\n\n`
    },
    view: Cards.createWebRequestView({
      icon: 'file-text',
      className: 'web-request-card doc-request-card',
      titleKey: 'tool_doc_title',
      badgeKey: 'tool_badge_downloading',
      loadingKey: 'tool_loading_doc',
      statusLabel: (_result, success) => `DOC ${success ? 'OK' : 'Error'}`
    })
  };
});

