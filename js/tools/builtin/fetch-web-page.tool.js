/** Herramienta nativa fetch_web_page. */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') module.exports = factory(require('../../utils.js'));
  else root.ChatBuiltinFetchWebPageTool = factory(root.ChatUtils);
})(typeof self !== 'undefined' ? self : this, function (Utils) {
  'use strict';

  const Cards = Utils.resolveDep('ChatToolCards', './tool-cards.js');

  return {
    definition: {
      name: 'fetch_web_page',
      description: 'Downloads and reads the text and content of a public web page or HTML article from its URL (e.g. "https://en.wikipedia.org/wiki/Sun").',
      parameters: { type: 'object', properties: { url: { type: 'string', description: 'URL of the web page to read.' } }, required: ['url'] }
    },
    aliases: ['fetch_web', 'fetch_url', 'get_web_page', 'read_web_page', 'web_fetch', 'browse_web', 'browse', 'webpage'],
    category: 'web',
    settings: { titleKey: 'agent_web_title', descKey: 'agent_web_desc' },
    promptGuide: '- `fetch_web_page(url="...")`: Downloads and extracts clean text content from public web pages or HTML articles.',
    execute: (args, context) => context.services.webBrowser.fetchPage(Cards.getUrlArg(args)),
    result: {
      toModel: (_args, result) => JSON.stringify(result),
      toMarkdown: args => `> **fetch_web_page**\n> URL: "${Cards.getUrlArg(args)}"\n\n`
    },
    view: Cards.createWebRequestView({
      icon: 'globe',
      className: 'web-request-card',
      titleKey: 'tool_web_title',
      badgeKey: 'tool_badge_fetching',
      loadingKey: 'tool_loading_web',
      statusLabel: (result, success) => `HTTP ${result.status || (success ? 200 : 500)} ${success ? 'OK' : 'Error'}`
    })
  };
});
