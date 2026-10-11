/** Tool autocontenida: search_web. */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') module.exports = factory(require('../../utils.js'), require('../../icons.js'));
  else root.ChatBuiltinSearchWebTool = factory(root.ChatUtils, root.ChatIcons);
})(typeof self !== 'undefined' ? self : this, function (Utils, Icons) {
  'use strict';

  const { resolveDep } = Utils;

  const getCards = () => resolveDep('ChatToolCards', './tool-cards.js');

  const definition = {
    name: 'search_web',
    description: 'Searches the internet in real time for up-to-date information, news, articles, and web links using DuckDuckGo.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search terms or query (e.g. "INE population Ceuta census", "DeepSeek R1").' } },
      required: ['query']
    }
  };

  function getQuery(args) {
    return args?.query || args?.q || args?.search || args?.keyword || args?.term || args?.input || (typeof args === 'string' ? args : '');
  }


  const SEARCH_ICON_SVG = Icons.get('search', { size: 14 });
  const LINK_ICON_SVG = Icons.get('external-link', { size: 12 });

  function createLiveCard(args, ui) {
    const cardDiv = getCards().createCardWrapper(ui);
    if (!cardDiv) return null;
    const Markdown = ui.markdown;
    const t = ui.t;
    const spinner = ui.SPINNER_SVG;
    cardDiv.innerHTML = getCards().renderCardHtml({
      className: 'web-search-card',
      titleHtml: `<span>${SEARCH_ICON_SVG}</span><span>${t('tool_search_title')}</span>`,
      badgeHtml: `<span class="tool-card-badge status-loading">${spinner} <span>${t('tool_badge_searching')}</span></span>`,
      bodyHtml: `<div class="search-query-section"><div class="section-label">${t('tool_search_query')}</div><div class="query-badge">${SEARCH_ICON_SVG} <strong>${Markdown.escapeHtml(getQuery(args))}</strong></div></div><div class="search-results-section"><div class="section-label search-sources-label">${t('tool_search_searching')}</div><div class="search-results-list tool-loading-placeholder">${spinner} <span>${t('tool_loading_search')}</span></div></div>`
    }, ui);
    return cardDiv;
  }

  function updateLiveCard(cardDiv, _args, result = {}, elapsedMs = 0, ui) {
    if (!cardDiv) return;
    const Markdown = ui.markdown;
    const t = ui.t;
    const checkSvg = ui.CHECK_SVG;
    const errorSvg = ui.ERROR_SVG;
    const isSuccess = result?.success !== false && !result?.error;
    const count = result?.count || (Array.isArray(result?.results) ? result.results.length : 0);
    const badge = cardDiv.querySelector('.tool-card-badge');
    if (badge) {
      badge.className = `tool-card-badge ${isSuccess ? 'status-success' : 'status-error'}`;
      badge.innerHTML = isSuccess
        ? `${checkSvg} <span>${t('tool_search_sources_count', { count, ms: elapsedMs || 0 })}</span>`
        : `${errorSvg} <span>${t('tool_status_error', { ms: elapsedMs || 0 })}</span>`;
    }
    const label = cardDiv.querySelector('.search-sources-label');
    if (label) label.textContent = t('tool_search_sources_label');
    const list = cardDiv.querySelector('.search-results-list');
    if (!list) return;
    if (result?.results?.length) {
      list.innerHTML = result.results.map(item => `<div class="search-result-item"><div><a href="${Markdown.sanitizeUrl(item.url)}" target="_blank" rel="noopener noreferrer">${LINK_ICON_SVG} ${Markdown.escapeHtml(item.title)}</a> <small style="opacity:0.75;">(${Markdown.escapeHtml(item.source || 'web')})</small></div>${item.snippet ? `<div class="search-result-snippet">${Markdown.escapeHtml(item.snippet)}</div>` : ''}</div>`).join('');
    } else if (result?.markdown) list.innerHTML = `<div class="search-result-snippet">${Markdown.renderMarkdown(result.markdown)}</div>`;
    else list.innerHTML = `<div class="search-result-snippet"><em>${t('tool_search_empty')}</em></div>`;
  }

  function renderHistoricalCard(args, toolMessage, ui) {
    const cardDiv = createLiveCard(args, ui);
    if (!cardDiv) return null;
    let result = {};
    if (toolMessage?.content) {
      try { result = JSON.parse(toolMessage.content); } catch (e) { result = { markdown: toolMessage.content }; }
    }
    updateLiveCard(cardDiv, args, result, 0, ui);
    return cardDiv;
  }

  function createTool(Tool) {
    if (typeof Tool !== 'function') throw new Error('La clase Tool es necesaria para crear search_web.');
    return new Tool({
      id: definition.name,
      definition,
      aliases: ['searchweb', 'web_search', 'duckduckgo_search', 'duckduckgo', 'search_internet', 'internet_search', 'search'],
      category: 'web',
      metadata: { label: definition.name },
      settings: {
        titleKey: 'agent_search_title',
        descKey: 'agent_search_desc',
        defaultEnabled: true, showInSettings: true
      },
      promptGuide: () => '- `search_web(query="...")`: Searches up-to-date information, news, articles, and links on the internet using DuckDuckGo.',
      execute: async (args, context = {}) => {
        const WebSearch = context.services?.webSearch;
        if (!WebSearch || !WebSearch.search) return { success: false, error: 'WebSearch module not available.' };
        return WebSearch.search(getQuery(args), context.language || context.lang || 'es');
      },
      result: {
        toModel: (_args, result) => result?.markdown || JSON.stringify(result || {}),
        toMarkdown: (args, result) => {
          const resultText = result?.markdown || JSON.stringify(result || {});
          return `> 🔍 **search_web** (${result?.count || 0} fuentes)\n> Query: "${args.query || ''}"\n> \`\`\`markdown\n> ${resultText.split('\n').join('\n> ')}\n> \`\`\``;
        }
      },
      displayMode: 'collapsed',
      view: { id: definition.name, displayMode: 'collapsed', createLiveCard, updateLiveCard, renderHistoricalCard }
    });
  }

  const toolModule = { id: definition.name, definition, displayMode: 'collapsed', createTool, getQuery, view: { id: definition.name, displayMode: 'collapsed', createLiveCard, updateLiveCard, renderHistoricalCard } };
  const manifestApi = resolveDep('ChatToolManifest', './tools/tool-manifest.js');
  if (manifestApi?.builtin && !manifestApi.builtin.has(toolModule.id)) manifestApi.builtin.register(toolModule);
  return toolModule;
});
