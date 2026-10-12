/** Herramienta nativa download_pdf. */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') module.exports = factory(require('../../utils.js'));
  else root.ChatBuiltinDownloadPdfTool = factory(root.ChatUtils);
})(typeof self !== 'undefined' ? self : this, function (Utils) {
  'use strict';

  const Cards = Utils.resolveDep('ChatToolCards', './tool-cards.js');

  return {
    definition: {
      name: 'download_pdf',
      description: 'Downloads a PDF file or document from a web URL and extracts all its readable text to analyze and include in the context (e.g. "https://arxiv.org/pdf/2310.06825.pdf").',
      parameters: { type: 'object', properties: { url: { type: 'string', description: 'Direct URL of the PDF document to download and extract.' } }, required: ['url'] }
    },
    aliases: ['fetch_pdf', 'download_pdf_document', 'fetch_pdf_document', 'download_file', 'getpdf', 'readpdf'],
    category: 'web',
    settings: { titleKey: 'agent_pdf_title', descKey: 'agent_pdf_desc' },
    promptGuide: '- `download_pdf(url="...")`: Downloads a PDF file from a URL and extracts its readable text into the prompt context.',
    execute: (args, context) => context.services.webBrowser.fetchPage(Cards.getUrlArg(args)),
    result: {
      toModel: (_args, result) => JSON.stringify(result),
      toMarkdown: args => `> **download_pdf**\n> URL: "${Cards.getUrlArg(args)}"\n\n`
    },
    view: Cards.createWebRequestView({
      icon: 'file-text',
      className: 'web-request-card pdf-request-card',
      titleKey: 'tool_pdf_title',
      badgeKey: 'tool_badge_downloading',
      loadingKey: 'tool_loading_pdf',
      statusLabel: (_result, success) => `PDF ${success ? 'OK' : 'Error'}`
    })
  };
});
