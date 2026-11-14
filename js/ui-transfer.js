/**
 * Diálogo de exportación de una conversación (Markdown, JSON, HTML o impresión) e importación de una
 * conversación desde su JSON. Los formatos los genera ChatExport.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./utils.js'), require('./i18n.js'));
  } else {
    root.ChatUITransfer = factory(root.ChatUtils, root.ChatI18n);
  }
}(typeof self !== 'undefined' ? self : this, function (Utils, I18n) {
  'use strict';

  const { resolveDep } = Utils;
  const { t } = I18n;

  const getExport = () => resolveDep('ChatExport', './export.js');
  const getDialogs = () => resolveDep('ChatDialogs', './ui-dialogs.js');

  // Elementos y callbacks de la aplicación, fijados en mount().
  let els = null;
  let options = {};
  let cleanups = [];

  const targetSessionId = () => els.exportModal.dataset.sessionId || options.getActiveSessionId();
  const fileBaseName = title => `${title.replace(/[^a-zA-Z0-9_-]/g, '_')}_${new Date().toISOString().slice(0, 10)}`;

  /** Abre el diálogo para exportar la conversación indicada (la activa si no se indica). */
  function openExportModal(sessionId) {
    els.exportModal.dataset.sessionId = sessionId || options.getActiveSessionId();
    els.exportModal.showModal();
  }

  function closeExportModal() {
    delete els.exportModal.dataset.sessionId;
    els.exportModal.close();
  }

  /** Metadatos e historial de una conversación: la activa está en memoria, el resto en el almacenamiento. */
  async function resolveSessionForExport(id) {
    if (id === options.getActiveSessionId()) {
      const session = options.getSavedSessions().find(item => item.id === id) || { id, title: '' };
      return { session, history: options.getHistory() };
    }
    const conversation = await options.getSession(id);
    return { session: conversation, history: conversation.history || conversation.messages || [] };
  }

  /** Muestra la conversación indicada si no es la activa, para los formatos que salen de la página. */
  async function showConversation(id) {
    if (id !== options.getActiveSessionId()) await options.onSwitchSession(id);
  }

  /**
   * Conversación indicada (la activa si no se indica) en el formato de ChatExport, con su título; un
   * formato que sale de la página cambia antes a esa conversación.
   */
  async function buildConversationExport(format, sessionId = options.getActiveSessionId()) {
    if (getExport().isRenderedFormat(format)) await showConversation(sessionId);
    const { session, history } = await resolveSessionForExport(sessionId);
    return { title: session.title || 'ZeroChat_Conversation', ...(await getExport().buildConversationExport(format, session, history, options.getConfig())) };
  }

  async function downloadConversation(format) {
    const { title, content, extension, mimeType } = await buildConversationExport(format, targetSessionId());
    Utils.downloadFile(content, `${fileBaseName(title)}.${extension}`, mimeType);
    closeExportModal();
  }

  /** Imprime la conversación: si no es la activa, cambia antes a ella. */
  async function exportConversationAsPrint() {
    const id = targetSessionId();
    closeExportModal();
    await showConversation(id);
    setTimeout(() => window.print(), 200);
  }

  async function handleImportFileSelected() {
    const input = els.importJsonInput;
    const file = input.files[0];
    try {
      if (!file || await options.isBusy()) return;
      const check = resolveDep('ChatAttachments', './attachments.js').validateFileSize(file);
      if (!check.valid) {
        await getDialogs().alert(t('err_file_too_large', { name: file.name, max: Utils.formatBytes(check.maxBytes) }), { type: 'error' });
        return;
      }
      const session = getExport().parseImportedJson(await file.text(), file.name.replace(/\.json$/i, ''));
      await options.onImportSuccess(session);
    } catch (error) {
      console.error('[UITransfer] Conversation import failed:', error);
      await getDialogs().alert(t('chat_import_json_err', { err: error?.message || error }), { type: 'error' });
    } finally {
      input.value = '';
    }
  }

  /**
   * Conecta el diálogo de exportación y la importación. `callbacks` aporta getActiveSessionId,
   * getSavedSessions, getHistory, getSession, getConfig, onSwitchSession, onImportSuccess e isBusy.
   */
  function mount({ elements, ...callbacks }) {
    cleanups.forEach(cleanup => cleanup());
    cleanups = [];
    els = elements;
    options = callbacks;
    const listen = (target, type, handler) => {
      target.addEventListener(type, handler);
      cleanups.push(() => target.removeEventListener(type, handler));
    };
    listen(els.exportModal, 'close', () => { delete els.exportModal.dataset.sessionId; });
    listen(els.btnCloseExport, 'click', closeExportModal);
    listen(els.btnCancelExport, 'click', closeExportModal);
    listen(els.btnExportMarkdown, 'click', () => downloadConversation('markdown'));
    listen(els.btnExportJson, 'click', () => downloadConversation('json'));
    listen(els.btnExportHtml, 'click', () => downloadConversation('html'));
    listen(els.btnExportPrint, 'click', exportConversationAsPrint);
    listen(els.btnImportChatFile, 'click', () => els.importJsonInput.click());
    listen(els.importJsonInput, 'change', handleImportFileSelected);
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
    if (dialog && !dialog.firstElementChild) dialog.innerHTML = getExportModalHTML();
  }

  return { mount, openExportModal, buildConversationExport, ensureDialogMarkup };
}));
