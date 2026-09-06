/** Tool autocontenida: fetch_web_page. */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') module.exports = factory();
  else root.ChatBuiltinFetchWebPageTool = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const definition = {
    name: 'fetch_web_page',
    description: 'Descarga y lee el texto y contenido de una página web pública o artículo HTML a partir de su URL (ej: "https://es.wikipedia.org/wiki/Sol").',
    parameters: { type: 'object', properties: { url: { type: 'string', description: 'URL de la página web a consultar.' } }, required: ['url'] }
  };

  function getUrl(args) {
    return args?.url || args?.URL || args?.uri || args?.link || args?.href || args?.path || args?.input || (typeof args === 'string' ? args : '');
  }

  function createCardWrapper(ui) {
    if (ui?.createCardWrapper) return ui.createCardWrapper();
    const doc = ui?.document || (typeof document !== 'undefined' ? document : null);
    if (!doc) return null;
    const cardDiv = doc.createElement('div');
    cardDiv.className = 'tool-card-wrapper';
    return cardDiv;
  }

  const GLOBE_ICON_SVG = '<svg class="ui-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>';

  function createLiveCard(args, ui) {
    const cardDiv = createCardWrapper(ui);
    if (!cardDiv) return null;
    const Markdown = ui?.markdown || { escapeHtml: (value) => String(value || ''), sanitizeUrl: (value) => String(value || '') };
    const t = ui?.t || ((key) => key);
    const spinner = ui?.SPINNER_SVG || '';
    const chevron = ui?.CHEVRON_SVG || '';
    const url = getUrl(args);
    cardDiv.innerHTML = `<div class="web-request-card"><div class="web-card-header"><div class="web-card-title"><span>${GLOBE_ICON_SVG}</span><span>${t('tool_web_title')}</span></div><div class="tool-card-header-actions"><span class="web-card-badge status-loading">${spinner} <span>${t('tool_badge_fetching') || 'Consultando...'}</span></span><button type="button" class="btn-tool-collapse" title="${t('tool_btn_collapse') || 'Minimizar'}">${chevron}</button></div></div><div class="tool-card-collapsible-body"><div class="web-card-section web-request-section"><div class="section-label">${t('tool_web_requested_url')}</div><div class="url-badge"><a href="${Markdown.sanitizeUrl(url)}" target="_blank" rel="noopener noreferrer">${Markdown.escapeHtml(url)}</a></div></div><div class="web-card-section web-response-section"><div class="section-label section-response-label">${t('tool_web_receiving') || 'Recibiendo contenido...'}</div><div class="web-response-body tool-loading-placeholder">${spinner} <span>${t('tool_loading_web')}</span></div></div></div></div>`;
    return cardDiv;
  }

  function updateLiveCard(cardDiv, _args, result = {}, elapsedMs = 0, ui) {
    if (!cardDiv) return;
    const Markdown = ui?.markdown || { escapeHtml: (value) => String(value || '') };
    const t = ui?.t || ((key) => key);
    const checkSvg = ui?.CHECK_SVG || '';
    const errorSvg = ui?.ERROR_SVG || '';
    const success = result?.success !== false && !result?.error;
    const status = result?.status || (success ? 200 : 500);
    const content = result?.content || result?.error || '';
    const badge = cardDiv.querySelector('.web-card-badge');
    if (badge) {
      badge.className = `web-card-badge ${success ? 'status-success' : 'status-error'}`;
      badge.innerHTML = success
        ? `${checkSvg} <span>HTTP ${status} OK (${elapsedMs || 0}ms)</span>`
        : `${errorSvg} <span>HTTP ${status} Error (${elapsedMs || 0}ms)</span>`;
    }
    const label = cardDiv.querySelector('.section-response-label');
    if (label) label.textContent = t('tool_web_content_received', { size: `${content.length} chars` }) || `Contenido recibido (${content.length} caracteres):`;
    const body = cardDiv.querySelector('.web-response-body');
    if (body) { body.className = 'web-response-body'; body.innerHTML = `<code>${Markdown.escapeHtml(content.slice(0, 1500))}${content.length > 1500 ? '...' : ''}</code>`; }
  }

  function renderHistoricalCard(args, toolMessage, ui) {
    const cardDiv = createLiveCard(args, ui);
    if (!cardDiv) return null;
    let result = {};
    if (toolMessage?.content) { try { result = JSON.parse(toolMessage.content); } catch (e) { result = { content: toolMessage.content }; } }
    updateLiveCard(cardDiv, args, result, 0, ui);
    return cardDiv;
  }

  function createTool(Tool) {
    if (typeof Tool !== 'function') throw new Error('La clase Tool es necesaria para crear fetch_web_page.');
    return new Tool({
      id: definition.name,
      definition,
      aliases: ['fetchwebpage', 'fetch_web', 'fetch_url', 'get_web_page', 'read_web_page', 'web_fetch', 'browse_web', 'webpage'],
      category: 'web',
      metadata: { icon: 'globe', label: definition.name },
      settings: {
        titleKey: 'agent_web_title', titleFallback: 'Navegación Web en Tiempo Real',
        descKey: 'agent_web_desc', descFallback: 'Permite al modelo invocar fetch_web_page para consultar páginas web públicas y extraer su contenido textual en tiempo real.',
        icon: 'globe', defaultEnabled: true, showInSettings: true
      },
      promptGuide: (lang) => lang === 'en'
        ? '- `fetch_web_page(url="...")`: Reads and extracts clean text content from public web pages or HTML articles.'
        : '- `fetch_web_page(url="...")`: Lee y extrae el texto de páginas web públicas o artículos HTML.',
      execute: async (args, context = {}) => {
        const WebBrowser = context.services?.webBrowser;
        if (!WebBrowser || !WebBrowser.fetchPage) return { success: false, error: 'Módulo WebBrowser no disponible.' };
        return WebBrowser.fetchPage(getUrl(args), context.options || {});
      },
      result: {
        toModel: (_args, result) => JSON.stringify(result || {}),
        toMarkdown: (args) => `> **fetch_web_page**\n> URL: "${args.url || ''}"\n\n`
      },
      displayMode: 'collapsed',
      view: { id: definition.name, displayMode: 'collapsed', createLiveCard, updateLiveCard, renderHistoricalCard }
    });
  }

  const toolModule = { id: definition.name, definition, displayMode: 'collapsed', createTool, getUrl, view: { id: definition.name, displayMode: 'collapsed', createLiveCard, updateLiveCard, renderHistoricalCard } };
  let manifestApi = null;
  if (typeof window !== 'undefined' && window.ChatToolManifest) manifestApi = window.ChatToolManifest;
  else if (typeof require !== 'undefined') { try { manifestApi = require('../tool-manifest.js'); } catch (e) {} }
  if (manifestApi?.builtin && !manifestApi.builtin.has(toolModule.id)) manifestApi.builtin.register(toolModule);
  return toolModule;
});
