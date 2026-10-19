/**
 * Formatos de exportación e importación de conversaciones (ChatExport): Markdown, JSON de sesión,
 * HTML como se ve en el chat y descarga de archivos.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./utils.js'), require('./i18n.js'), require('./defaults.js'));
  } else {
    root.ChatExport = factory(root.ChatUtils, root.ChatI18n, root.ChatDefaults);
  }
}(typeof self !== 'undefined' ? self : this, function (Utils, I18n, Defaults) {
  'use strict';

  const { createId, escapeHtml, resolveDep } = Utils;
  const { t } = I18n;
  const DEFAULT_TITLE = 'ZeroChat_Conversation';
  // La copia de la conversación se lee como documento, sin la altura fija de la aplicación, y no
  // ejecuta nada (las imágenes pueden ser data: o remotas).
  const HTML_EXPORT_CSS = 'html, body { height: auto; min-height: 0; overflow: visible; display: block; width: auto; }'
    + ' .chat-container, .messages-list { height: auto; max-height: none; overflow: visible; }';
  // Lo que no aporta sin scripts: acciones de los mensajes, del código, de las tablas y de las tarjetas.
  const HTML_EXPORT_REMOVED = 'script, #welcome-banner, .message-actions, .btn-copy-code, .btn-preview-code, .table-actions, .btn-tool-collapse';
  const HTML_EXPORT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data: http: https:";

  /** Descarga `content` como archivo; devuelve false si el navegador no lo permite. */
  function downloadFile(content, filename, mimeType) {
    try {
      const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      return true;
    } catch (error) {
      console.error('[ChatExport] Download failed:', error);
      return false;
    }
  }

  /** Conversación en Markdown: los mensajes del usuario y las respuestas, sin el prompt de sistema. */
  function buildMarkdownExport(chatHistory, { title = DEFAULT_TITLE, model = '' } = {}) {
    let md = `# ${title}\n\n*${t('export_date')}: ${new Date().toLocaleString()}*\n*${t('export_model')}: ${model || t('not_specified')}*\n\n---\n\n`;
    for (const message of chatHistory) {
      if (message.role === 'user') {
        md += `### ${t('role_user')}\n\n${typeof message.content === 'string' ? message.content : JSON.stringify(message.content)}\n\n---\n\n`;
      } else if (message.role === 'assistant' && message.content) {
        md += `### ${t('role_assistant')}\n\n${message.content}\n\n---\n\n`;
      }
    }
    return md;
  }

  function buildJsonExport(sessionMeta, chatHistory, appConfig) {
    return JSON.stringify({
      version: Defaults.APP_VERSION,
      app: 'ZeroChat',
      exportedAt: new Date().toISOString(),
      session: {
        id: sessionMeta.id,
        title: sessionMeta.title || DEFAULT_TITLE,
        createdAt: sessionMeta.createdAt || Date.now(),
        updatedAt: Date.now(),
        history: chatHistory
      },
      config: { model: appConfig.model, apiUrl: appConfig.apiUrl, apiType: appConfig.apiType }
    }, null, 2);
  }

  /** Reglas CSS de una hoja de la página, dentro de su media si la tiene (print.css). */
  function styleSheetText(sheet) {
    const rules = [...sheet.cssRules].map(rule => rule.cssText).join('\n');
    return sheet.media.mediaText ? `@media ${sheet.media.mediaText} {\n${rules}\n}` : rules;
  }

  /**
   * Conversación pintada en `doc` como HTML autónomo que se ve como en el chat: los mensajes, el
   * CSS de la página, los iconos que usan y las imágenes de la base de conocimiento incrustadas.
   */
  async function buildHtmlExport(doc, { title = DEFAULT_TITLE } = {}) {
    const copy = doc.getElementById('messages-list').cloneNode(true);
    copy.querySelectorAll(HTML_EXPORT_REMOVED).forEach(node => node.remove());
    // Sin scripts las tarjetas no se pliegan: se exportan desplegadas para que se vea su contenido.
    copy.querySelectorAll('.tool-execution-card.collapsed, .chat-chart-card.collapsed').forEach(card => card.classList.remove('collapsed'));
    const Markdown = resolveDep('ChatMarkdown', './markdown.js');
    await Promise.all([...copy.querySelectorAll('img')].map(async img => {
      img.removeAttribute('loading');
      if (!img.dataset.ragSrc) return;
      const dataUrl = await Markdown.loadRagImage(img.dataset.ragSrc).catch(() => null);
      if (dataUrl) img.setAttribute('src', dataUrl);
    }));
    const iconIds = new Set([...copy.querySelectorAll('use')].map(use => (use.getAttribute('href') || '').replace(/^#/, '')));
    const icons = [...iconIds].map(id => doc.getElementById(id)).filter(symbol => symbol?.tagName.toLowerCase() === 'symbol');
    const css = [...doc.styleSheets].map(styleSheetText).join('\n').replace(/<\/style/gi, '<\\/style');
    const attributes = element => element.getAttributeNames().map(name => ` ${name}="${escapeHtml(element.getAttribute(name))}"`).join('');
    return `<!DOCTYPE html>
<html${attributes(doc.documentElement)}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${HTML_EXPORT_CSP}">
<title>${escapeHtml(title)}</title>
<style>
${css}
${HTML_EXPORT_CSS}
</style>
</head>
<body${attributes(doc.body)}>
<svg xmlns="http://www.w3.org/2000/svg" hidden>${icons.map(symbol => symbol.outerHTML).join('')}</svg>
<main class="chat-container">${copy.outerHTML}</main>
</body>
</html>
`;
  }

  // Formatos de exportación de una conversación: los usan el diálogo y zerochat.py --export.
  const CONVERSATION_FORMATS = {
    markdown: {
      extension: 'md',
      mimeType: 'text/markdown',
      build: (session, history, config) => buildMarkdownExport(history, { title: session.title || DEFAULT_TITLE, model: config.model })
    },
    json: {
      extension: 'json',
      mimeType: 'application/json',
      build: buildJsonExport
    },
    // Se genera desde la página: la conversación tiene que ser la que se está viendo.
    html: {
      extension: 'html',
      mimeType: 'text/html',
      rendered: true,
      build: session => buildHtmlExport(document, { title: session.title || DEFAULT_TITLE })
    }
  };

  /** Si el formato se genera desde la conversación pintada en la página y no desde su historial. */
  const isRenderedFormat = format => CONVERSATION_FORMATS[format]?.rendered === true;

  /** Contenido, extensión y tipo MIME de la conversación en el formato indicado (markdown, json o html). */
  async function buildConversationExport(format, session, history, config) {
    const spec = CONVERSATION_FORMATS[format];
    if (!spec) throw new Error(`Unknown export format: ${format}`);
    return { content: await spec.build(session, history, config), extension: spec.extension, mimeType: spec.mimeType };
  }

  /** Sesión nueva a partir de un JSON exportado; conserva el historial con otro id. */
  function parseImportedJson(jsonString, defaultTitle) {
    const data = JSON.parse(jsonString);
    const importedSession = data.session || data;
    if (!importedSession || !Array.isArray(importedSession.history)) {
      throw new Error('The file does not contain a valid chat history (missing history property).');
    }
    return {
      id: createId('session'),
      title: importedSession.title || defaultTitle,
      createdAt: importedSession.createdAt || Date.now(),
      updatedAt: Date.now(),
      history: importedSession.history
    };
  }

  function getExportModalHTML() {
    return `<div class="modal-card">
      <div class="modal-header">
        <div class="modal-title">
          <span class="modal-icon">
            <svg class="ui-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-download"></use></svg>
          </span>
          <h3 data-i18n="export_modal_title">Exportar Conversación</h3>
        </div>
        <button type="button" id="btn-close-export" class="btn-close-modal" data-i18n-title="btn_close_export_title" title="Cerrar modal">
          <svg class="ui-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-close"></use></svg>
        </button>
      </div>

      <div class="modal-body-scrollable">
        <div class="export-options-grid">
          <button type="button" id="btn-export-markdown" class="export-card-btn">
            <span class="export-card-icon">
              <svg class="ui-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-file-text"></use></svg>
            </span>
            <div class="export-card-info">
              <strong data-i18n="export_md_title">Descargar Markdown (.md)</strong>
              <span data-i18n="export_md_desc">Formato limpio con formato, código y tablas legible en cualquier visor.</span>
            </div>
          </button>

          <button type="button" id="btn-export-json" class="export-card-btn">
            <span class="export-card-icon">
              <svg class="ui-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-code"></use></svg>
            </span>
            <div class="export-card-info">
              <strong data-i18n="export_json_title">Descargar JSON de Sesión (.json)</strong>
              <span data-i18n="export_json_desc">Historial estructurado completo con herramientas, imágenes y metadatos para restaurar.</span>
            </div>
          </button>

          <button type="button" id="btn-export-html" class="export-card-btn">
            <span class="export-card-icon">
              <svg class="ui-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-globe"></use></svg>
            </span>
            <div class="export-card-info">
              <strong data-i18n="export_html_title">Descargar HTML (.html)</strong>
              <span data-i18n="export_html_desc">La conversación tal como se ve en el chat, en un único archivo para abrir en cualquier navegador.</span>
            </div>
          </button>

          <button type="button" id="btn-export-print" class="export-card-btn">
            <span class="export-card-icon">
              <svg class="ui-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-printer"></use></svg>
            </span>
            <div class="export-card-info">
              <strong data-i18n="export_pdf_title">Imprimir / Guardar como PDF</strong>
              <span data-i18n="export_pdf_desc">Genera un documento PDF limpio maquetado para lectura e informes.</span>
            </div>
          </button>
        </div>
      </div>

      <div class="modal-footer">
        <button type="button" id="btn-cancel-export" class="btn-secondary" data-i18n="btn_close">Cerrar</button>
      </div>
    </div>`;
  }

  /** Inserta el marcado del diálogo de exportación, que zerochat.html deja vacío. */
  function ensureDialogMarkup() {
    const dialog = document.getElementById('export-modal');
    if (!dialog.firstElementChild) dialog.innerHTML = getExportModalHTML();
  }

  return {
    downloadFile,
    buildMarkdownExport,
    buildJsonExport,
    buildConversationExport,
    isRenderedFormat,
    parseImportedJson,
    ensureDialogMarkup
  };
}));
