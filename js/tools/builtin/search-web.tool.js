/** Herramienta nativa search_web. */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') module.exports = factory(require('../../utils.js'), require('../../icons.js'));
  else root.ChatBuiltinSearchWebTool = factory(root.ChatUtils, root.ChatIcons);
})(typeof self !== 'undefined' ? self : this, function (Utils, Icons) {
  'use strict';

  const { escapeHtml, resolveDep } = Utils;
  const getCards = () => resolveDep('ChatToolCards', './tool-cards.js');

  const SEARCH_ICON_SVG = Icons.get('search', { size: 14 });
  const LINK_ICON_SVG = Icons.get('external-link', { size: 12 });

  const getQuery = args => args.query || args.q || args.search || args.keyword || args.term || args.input || '';

  function createLiveCard(args, ui) {
    const cardDiv = ui.createCardWrapper();
    cardDiv.innerHTML = getCards().renderCardHtml({
      className: 'web-search-card',
      titleHtml: `<span>${SEARCH_ICON_SVG}</span><span>${ui.t('tool_search_title')}</span>`,
      badgeHtml: `<span class="tool-card-badge status-loading">${ui.SPINNER_SVG} <span>${ui.t('tool_badge_searching')}</span></span>`,
      bodyHtml: `<div class="search-query-section"><div class="section-label">${ui.t('tool_search_query')}</div><div class="query-badge">${SEARCH_ICON_SVG} <strong>${escapeHtml(getQuery(args))}</strong></div></div><div class="search-results-section"><div class="section-label search-sources-label">${ui.t('tool_search_searching')}</div><div class="search-results-list tool-loading-placeholder">${ui.SPINNER_SVG} <span>${ui.t('tool_loading_search')}</span></div></div>`
    });
    return cardDiv;
  }

  function updateLiveCard(cardDiv, _args, result, elapsedMs, ui) {
    const success = result.success !== false && !result.error;
    const results = Array.isArray(result.results) ? result.results : [];
    getCards().renderStatusBadge(cardDiv.querySelector('.tool-card-badge'), success, success
      ? ui.t('tool_search_sources_count', { count: result.count || results.length, ms: elapsedMs })
      : ui.t('tool_status_error', { ms: elapsedMs }));
    cardDiv.querySelector('.search-sources-label').textContent = ui.t('tool_search_sources_label');
    const list = cardDiv.querySelector('.search-results-list');
    list.className = 'search-results-list';
    const markdown = result.markdown || result.content;
    if (results.length) {
      list.innerHTML = results.map(item => `<div class="search-result-item"><div><a href="${ui.markdown.sanitizeUrl(item.url)}" target="_blank" rel="noopener noreferrer">${LINK_ICON_SVG} ${escapeHtml(item.title)}</a> <small class="search-result-source">(${escapeHtml(item.source || 'web')})</small></div>${item.snippet ? `<div class="search-result-snippet">${escapeHtml(item.snippet)}</div>` : ''}</div>`).join('');
    } else if (markdown) {
      list.innerHTML = `<div class="search-result-snippet">${ui.markdown.parseMarkdown(markdown)}</div>`;
    } else {
      list.innerHTML = `<div class="search-result-snippet"><em>${ui.t('tool_search_empty')}</em></div>`;
    }
  }

  return {
    definition: {
      name: 'search_web',
      description: 'Searches the internet in real time for up-to-date information, news, articles, and web links using DuckDuckGo.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Search terms or query (e.g. "INE population Ceuta census", "DeepSeek R1").' } },
        required: ['query']
      }
    },
    aliases: ['web_search', 'duckduckgo_search', 'duckduckgo', 'search_internet', 'internet_search', 'search'],
    category: 'web',
    settings: { titleKey: 'agent_search_title', descKey: 'agent_search_desc' },
    promptGuide: '- `search_web(query="...")`: Searches up-to-date information, news, articles, and links on the internet using DuckDuckGo.',
    execute: (args, context) => context.services.webSearch.search(getQuery(args), context.language),
    result: {
      toModel: (_args, result) => result.markdown || JSON.stringify(result),
      toMarkdown: (args, result) => {
        const resultText = result.markdown || JSON.stringify(result);
        return `> 🔍 **search_web** (${result.count || 0} sources)\n> Query: "${getQuery(args)}"\n> \`\`\`markdown\n> ${resultText.split('\n').join('\n> ')}\n> \`\`\``;
      }
    },
    view: { createLiveCard, updateLiveCard }
  };
});
