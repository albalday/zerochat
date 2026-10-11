/** Tool autocontenida: fetch_web_page. */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') module.exports = factory();
  else root.ChatBuiltinFetchWebPageTool = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const Cards = (typeof window !== 'undefined' && window.ChatToolCards) || require('../../tool-cards.js');

  const definition = {
    name: 'fetch_web_page',
    description: 'Downloads and reads the text and content of a public web page or HTML article from its URL (e.g. "https://en.wikipedia.org/wiki/Sun").',
    parameters: { type: 'object', properties: { url: { type: 'string', description: 'URL of the web page to read.' } }, required: ['url'] }
  };

  const view = Cards.createWebRequestView({
    id: definition.name,
    icon: 'globe',
    className: 'web-request-card',
    titleKey: 'tool_web_title',
    badgeKey: 'tool_badge_fetching',
    loadingKey: 'tool_loading_web',
    statusLabel: (result, success) => `HTTP ${result?.status || (success ? 200 : 500)} ${success ? 'OK' : 'Error'}`
  });

  function createTool(Tool) {
    if (typeof Tool !== 'function') throw new Error('La clase Tool es necesaria para crear fetch_web_page.');
    return new Tool({
      id: definition.name,
      definition,
      aliases: ['fetchwebpage', 'fetch_web', 'fetch_url', 'get_web_page', 'read_web_page', 'web_fetch', 'browse_web', 'webpage'],
      category: 'web',
      metadata: { label: definition.name },
      settings: { titleKey: 'agent_web_title', descKey: 'agent_web_desc', defaultEnabled: true, showInSettings: true },
      promptGuide: () => '- `fetch_web_page(url="...")`: Downloads and extracts clean text content from public web pages or HTML articles.',
      execute: async (args, context = {}) => {
        const WebBrowser = context.services?.webBrowser;
        if (!WebBrowser || !WebBrowser.fetchPage) return { success: false, error: 'WebBrowser module not available.' };
        return WebBrowser.fetchPage(Cards.getUrlArg(args), context.options || {});
      },
      result: {
        toModel: (_args, result) => JSON.stringify(result || {}),
        toMarkdown: (args) => `> **fetch_web_page**\n> URL: "${args.url || ''}"\n\n`
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
