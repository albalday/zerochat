/**
 * Formatos de exportación e importación de conversaciones (ChatExport): Markdown, JSON de sesión y
 * descarga de archivos.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./utils.js'), require('./i18n.js'), require('./defaults.js'));
  } else {
    root.ChatExport = factory(root.ChatUtils, root.ChatI18n, root.ChatDefaults);
  }
}(typeof self !== 'undefined' ? self : this, function (Utils, I18n, Defaults) {
  'use strict';

  const { createId } = Utils;
  const { t } = I18n;
  const DEFAULT_TITLE = 'ZeroChat_Conversation';

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
    parseImportedJson,
    ensureDialogMarkup
  };
}));
