/**
 * Módulo de Exportación e Importación (ChatExport) para ZeroChat.
 * Gestiona la serialización a Markdown, JSON estructurado, impresión y parseo de archivos importados.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.ChatExport = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function downloadFile(content, filename, mimeType) {
    if (typeof document === 'undefined' || typeof URL === 'undefined') return false;
    try {
      const blob = new Blob([content], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      return true;
    } catch (e) {
      console.error('ChatExport: Error al descargar archivo:', e);
      return false;
    }
  }

  function buildMarkdownExport(chatHistory, options = {}) {
    const title = options.title || 'ZeroChat_Conversation';
    const model = options.model || (options.t ? options.t('not_specified') : 'No especificado');
    const dateStr = options.date || new Date().toLocaleString();
    const userRole = options.userRole || (options.t ? options.t('role_user') : '👤 Usuario');
    const assistantRole = options.assistantRole || (options.t ? options.t('role_assistant') : '🤖 Asistente');
    const exportDateLabel = options.exportDateLabel || (options.t ? options.t('export_date') : 'Fecha de exportación');
    const modelLabel = options.modelLabel || (options.t ? options.t('field_model') : 'Modelo');

    let md = `# ${title}\n\n*${exportDateLabel}: ${dateStr}*\n*${modelLabel}: ${model}*\n\n---\n\n`;

    (chatHistory || []).forEach(m => {
      if (!m || m.role === 'system') return;
      if (m.role === 'user') {
        const contentStr = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        md += `### ${userRole}\n\n${contentStr}\n\n---\n\n`;
      } else if (m.role === 'assistant' && m.content) {
        md += `### ${assistantRole}\n\n${m.content}\n\n---\n\n`;
      }
    });

    return md;
  }

  function buildJsonExport(sessionMeta = {}, chatHistory = [], appConfig = {}) {
    const title = sessionMeta.title || 'ZeroChat_Conversation';
    const exportData = {
      version: '5.1',
      app: 'ZeroChat',
      exportedAt: new Date().toISOString(),
      session: {
        id: sessionMeta.id || ('session_' + Date.now()),
        title: title,
        createdAt: sessionMeta.createdAt || Date.now(),
        updatedAt: Date.now(),
        history: chatHistory
      },
      config: {
        model: appConfig.model || '',
        apiUrl: appConfig.apiUrl || '',
        apiType: appConfig.apiType || ''
      }
    };
    return JSON.stringify(exportData, null, 2);
  }

  function parseImportedJson(jsonString, defaultTitle = 'Conversación Importada') {
    if (!jsonString || typeof jsonString !== 'string') {
      throw new Error('El contenido proporcionado no es una cadena JSON válida.');
    }

    const data = JSON.parse(jsonString);
    const importedSession = data.session || data;

    if (!importedSession || !Array.isArray(importedSession.history)) {
      throw new Error('El archivo no contiene un historial de chat válido (propiedad history ausente).');
    }

    const newId = 'session_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    return {
      id: newId,
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

  function ensureDialogMarkup() {
    if (typeof document === 'undefined') return;
    const dialog = document.getElementById('export-modal');
    if (dialog && !dialog.firstElementChild) {
      dialog.innerHTML = getExportModalHTML();
    }
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', ensureDialogMarkup);
    } else {
      ensureDialogMarkup();
    }
  }

  return {
    downloadFile,
    buildMarkdownExport,
    buildJsonExport,
    parseImportedJson,
    ensureDialogMarkup,
    getExportModalHTML
  };
}));
