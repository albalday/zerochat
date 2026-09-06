/** Tool autocontenida: search_web. */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') module.exports = factory();
  else root.ChatBuiltinSearchWebTool = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const definition = {
    name: 'search_web',
    description: 'Busca en internet en tiempo real información actualizada, noticias, artículos y enlaces web utilizando DuckDuckGo.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Términos o consulta de búsqueda (ej: "INE poblacion Ceuta padron", "DeepSeek R1").' } },
      required: ['query']
    }
  };

  function getQuery(args) {
    return args?.query || args?.q || args?.search || args?.keyword || args?.term || args?.input || (typeof args === 'string' ? args : '');
  }

  function createCardWrapper(ui) {
    if (ui?.createCardWrapper) return ui.createCardWrapper();
    const doc = ui?.document || (typeof document !== 'undefined' ? document : null);
    if (!doc) return null;
    const cardDiv = doc.createElement('div');
    cardDiv.className = 'tool-card-wrapper';
    return cardDiv;
  }

  const SEARCH_ICON_SVG = '<svg class="ui-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>';
  const LINK_ICON_SVG = '<svg class="ui-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>';

  function createLiveCard(args, ui) {
    const cardDiv = createCardWrapper(ui);
    if (!cardDiv) return null;
    const Markdown = ui?.markdown || { escapeHtml: (value) => String(value || '') };
    const t = ui?.t || ((key) => key);
    const spinner = ui?.SPINNER_SVG || '';
    const chevron = ui?.CHEVRON_SVG || '';
    cardDiv.innerHTML = `<div class="web-search-card"><div class="search-card-header"><div class="search-card-title"><span>${SEARCH_ICON_SVG}</span><span>${t('tool_search_title') || 'Búsqueda en Internet'}</span></div><div class="tool-card-header-actions"><span class="search-card-badge status-loading">${spinner} <span>${t('tool_badge_searching') || 'Buscando...'}</span></span><button type="button" class="btn-tool-collapse" title="${t('tool_btn_collapse') || 'Minimizar'}">${chevron}</button></div></div><div class="tool-card-collapsible-body"><div class="search-query-section"><div class="section-label">${t('tool_search_query')}</div><div class="query-badge">${SEARCH_ICON_SVG} <strong>${Markdown.escapeHtml(getQuery(args))}</strong></div></div><div class="search-results-section"><div class="section-label search-sources-label">${t('tool_search_searching') || 'Buscando fuentes...'}</div><div class="search-results-list tool-loading-placeholder">${spinner} <span>${t('tool_loading_search') || 'Consultando motores de búsqueda...'}</span></div></div></div></div>`;
    return cardDiv;
  }

  function updateLiveCard(cardDiv, _args, result = {}, elapsedMs = 0, ui) {
    if (!cardDiv) return;
    const Markdown = ui?.markdown || { escapeHtml: (value) => String(value || ''), sanitizeUrl: (value) => String(value || ''), renderMarkdown: (value) => String(value || '') };
    const t = ui?.t || ((key) => key);
    const checkSvg = ui?.CHECK_SVG || '';
    const errorSvg = ui?.ERROR_SVG || '';
    const isSuccess = result?.success !== false && !result?.error;
    const count = result?.count || (Array.isArray(result?.results) ? result.results.length : 0);
    const badge = cardDiv.querySelector('.search-card-badge');
    if (badge) {
      badge.className = `search-card-badge ${isSuccess ? 'status-success' : 'status-error'}`;
      badge.innerHTML = isSuccess
        ? `${checkSvg} <span>${count} fuentes (${elapsedMs || 0}ms)</span>`
        : `${errorSvg} <span>Error búsqueda (${elapsedMs || 0}ms)</span>`;
    }
    const label = cardDiv.querySelector('.search-sources-label');
    if (label) label.textContent = t('tool_search_sources_label') || 'Fuentes y resultados encontrados:';
    const list = cardDiv.querySelector('.search-results-list');
    if (!list) return;
    if (result?.results?.length) {
      list.innerHTML = result.results.map(item => `<div class="search-result-item"><div><a href="${Markdown.sanitizeUrl(item.url)}" target="_blank" rel="noopener noreferrer">${LINK_ICON_SVG} ${Markdown.escapeHtml(item.title)}</a> <small style="opacity:0.75;">(${Markdown.escapeHtml(item.source || 'web')})</small></div>${item.snippet ? `<div class="search-result-snippet">${Markdown.escapeHtml(item.snippet)}</div>` : ''}</div>`).join('');
    } else if (result?.markdown) list.innerHTML = `<div class="search-result-snippet">${Markdown.renderMarkdown(result.markdown)}</div>`;
    else list.innerHTML = `<div class="search-result-snippet"><em>${t('tool_search_empty') || 'No se encontraron resultados relevantes.'}</em></div>`;
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
      metadata: { icon: '🔍', label: definition.name },
      settings: {
        titleKey: 'agent_search_title', titleFallback: 'Búsqueda en DuckDuckGo en Tiempo Real',
        descKey: 'agent_search_desc', descFallback: 'Permite al modelo invocar search_web para buscar información actualizada, definiciones, noticias y enlaces web mediante la API de DuckDuckGo.',
        icon: '🔍', defaultEnabled: true, showInSettings: true
      },
      promptGuide: (lang) => lang === 'en'
        ? '- `search_web(query="...")`: Searches up-to-date information, news, articles, and links on the internet using DuckDuckGo.'
        : '- `search_web(query="...")`: Busca información actualizada, noticias, artículos y enlaces en internet mediante DuckDuckGo.',
      execute: async (args, context = {}) => {
        const WebSearch = context.services?.webSearch;
        if (!WebSearch || !WebSearch.search) return { success: false, error: 'Módulo WebSearch no disponible.' };
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
  let manifestApi = null;
  if (typeof window !== 'undefined' && window.ChatToolManifest) manifestApi = window.ChatToolManifest;
  else if (typeof require !== 'undefined') { try { manifestApi = require('../tool-manifest.js'); } catch (e) {} }
  if (manifestApi?.builtin && !manifestApi.builtin.has(toolModule.id)) manifestApi.builtin.register(toolModule);
  return toolModule;
});
