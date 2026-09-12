/** Tool autocontenida: download_pdf. */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') module.exports = factory();
  else root.ChatBuiltinDownloadPdfTool = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const definition = {
    name: 'download_pdf',
    description: 'Downloads a PDF file or document from a web URL and extracts all its readable text to analyze and include in the context (e.g. "https://arxiv.org/pdf/2310.06825.pdf").',
    parameters: { type: 'object', properties: { url: { type: 'string', description: 'Direct URL of the PDF document to download and extract.' } }, required: ['url'] }
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

  const PDF_ICON_SVG = '<svg class="ui-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>';

  const safeEscapeHtml = (value) => String(value || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function createLiveCard(args, ui) {
    const cardDiv = createCardWrapper(ui);
    if (!cardDiv) return null;
    const Markdown = ui?.markdown || (typeof window !== 'undefined' && window.ChatMarkdown) || (typeof window !== 'undefined' && window.ChatUtils) || { escapeHtml: safeEscapeHtml, sanitizeUrl: (v) => String(v || '') };
    const t = ui?.t || ((key) => key);
    const spinner = ui?.SPINNER_SVG || '';
    const chevron = ui?.CHEVRON_SVG || '';
    const url = getUrl(args);
    cardDiv.innerHTML = `<div class="web-request-card pdf-request-card"><div class="web-card-header"><div class="web-card-title"><span>${PDF_ICON_SVG}</span><span>${t('tool_pdf_title')}</span></div><div class="tool-card-header-actions"><span class="web-card-badge status-loading">${spinner} <span>${t('tool_badge_downloading') || 'Descargando...'}</span></span><button type="button" class="btn-tool-collapse" title="${t('tool_btn_collapse') || 'Minimizar'}">${chevron}</button></div></div><div class="tool-card-collapsible-body"><div class="web-card-section web-request-section"><div class="section-label">${t('tool_web_requested_url')}</div><div class="url-badge"><a href="${Markdown.sanitizeUrl(url)}" target="_blank" rel="noopener noreferrer">${Markdown.escapeHtml(url)}</a></div></div><div class="web-card-section web-response-section"><div class="section-label section-response-label">${t('tool_web_receiving') || 'Recibiendo contenido...'}</div><div class="web-response-body tool-loading-placeholder">${spinner} <span>${t('tool_loading_pdf')}</span></div></div></div></div>`;
    return cardDiv;
  }

  function updateLiveCard(cardDiv, _args, result = {}, elapsedMs = 0, ui) {
    if (!cardDiv) return;
    const Markdown = ui?.markdown || (typeof window !== 'undefined' && window.ChatMarkdown) || (typeof window !== 'undefined' && window.ChatUtils) || { escapeHtml: safeEscapeHtml, sanitizeUrl: (v) => String(v || '') };
    const t = ui?.t || ((key) => key);
    const checkSvg = ui?.CHECK_SVG || '';
    const errorSvg = ui?.ERROR_SVG || '';
    const success = result?.success !== false && !result?.error;
    const content = result?.content || result?.error || '';
    const badge = cardDiv.querySelector('.web-card-badge');
    if (badge) {
      badge.className = `web-card-badge ${success ? 'status-success' : 'status-error'}`;
      badge.innerHTML = success
        ? `${checkSvg} <span>PDF OK (${elapsedMs || 0}ms)</span>`
        : `${errorSvg} <span>Error PDF (${elapsedMs || 0}ms)</span>`;
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
    if (typeof Tool !== 'function') throw new Error('La clase Tool es necesaria para crear download_pdf.');
    return new Tool({
      id: definition.name,
      definition,
      aliases: ['downloadpdf', 'fetch_pdf', 'download_pdf_document', 'fetch_pdf_document', 'download_file', 'getpdf', 'readpdf'],
      category: 'web',
      metadata: { icon: 'file-text', label: definition.name },
      settings: {
        titleKey: 'agent_pdf_title', titleFallback: 'Descarga y Lectura de Documentos PDF',
        descKey: 'agent_pdf_desc', descFallback: 'Permite al modelo descargar documentos PDF desde la web y extraer todo su texto al contexto en tiempo real.',
        icon: 'file-text', defaultEnabled: true, showInSettings: true
      },
      promptGuide: () => '- `download_pdf(url="...")`: Downloads a PDF file from a URL and extracts its readable text into the prompt context.',
      execute: async (args, context = {}) => {
        const WebBrowser = context.services?.webBrowser;
        if (!WebBrowser || !WebBrowser.downloadPdf) return { success: false, error: 'Módulo WebBrowser no disponible.' };
        return WebBrowser.downloadPdf(getUrl(args), context.options || {});
      },
      result: {
        toModel: (_args, result) => JSON.stringify(result || {}),
        toMarkdown: (args) => `> **download_pdf**\n> URL: "${args.url || ''}"\n\n`
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
