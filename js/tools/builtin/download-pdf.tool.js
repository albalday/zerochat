/** Tool autocontenida: download_pdf. */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') module.exports = factory();
  else root.ChatBuiltinDownloadPdfTool = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const Cards = (typeof window !== 'undefined' && window.ChatToolCards) || require('../../tool-cards.js');

  const definition = {
    name: 'download_pdf',
    description: 'Downloads a PDF file or document from a web URL and extracts all its readable text to analyze and include in the context (e.g. "https://arxiv.org/pdf/2310.06825.pdf").',
    parameters: { type: 'object', properties: { url: { type: 'string', description: 'Direct URL of the PDF document to download and extract.' } }, required: ['url'] }
  };

  const view = Cards.createWebRequestView({
    id: definition.name,
    icon: 'file-text',
    className: 'web-request-card pdf-request-card',
    titleKey: 'tool_pdf_title',
    badgeKey: 'tool_badge_downloading',
    loadingKey: 'tool_loading_pdf',
    statusLabel: (_result, success) => `PDF ${success ? 'OK' : 'Error'}`
  });

  function createTool(Tool) {
    if (typeof Tool !== 'function') throw new Error('La clase Tool es necesaria para crear download_pdf.');
    return new Tool({
      id: definition.name,
      definition,
      aliases: ['downloadpdf', 'fetch_pdf', 'download_pdf_document', 'fetch_pdf_document', 'download_file', 'getpdf', 'readpdf'],
      category: 'web',
      metadata: { label: definition.name },
      settings: { titleKey: 'agent_pdf_title', descKey: 'agent_pdf_desc', defaultEnabled: true, showInSettings: true },
      promptGuide: () => '- `download_pdf(url="...")`: Downloads a PDF file from a URL and extracts its readable text into the prompt context.',
      execute: async (args, context = {}) => {
        const WebBrowser = context.services?.webBrowser;
        if (!WebBrowser || !WebBrowser.fetchPage) return { success: false, error: 'WebBrowser module not available.' };
        return WebBrowser.fetchPage(Cards.getUrlArg(args), context.options || {});
      },
      result: {
        toModel: (_args, result) => JSON.stringify(result || {}),
        toMarkdown: (args) => `> **download_pdf**\n> URL: "${args.url || ''}"\n\n`
      },
      displayMode: 'collapsed',
      view
    });
  }

  const toolModule = { id: definition.name, definition, displayMode: 'collapsed', createTool, view };
  let manifestApi = null;
  if (typeof window !== 'undefined' && window.ChatToolManifest) manifestApi = window.ChatToolManifest;
  else if (typeof require !== 'undefined') { try { manifestApi = require('../tool-manifest.js'); } catch (e) { /* módulo opcional: no disponible en este entorno */ } }
  if (manifestApi?.builtin && !manifestApi.builtin.has(toolModule.id)) manifestApi.builtin.register(toolModule);
  return toolModule;
});
