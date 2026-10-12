/**
 * Diálogo de exportación de una conversación (Markdown, JSON o impresión) e importación de una
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

  /** Metadatos e historial de la conversación a exportar: la activa está en memoria, el resto en el almacenamiento. */
  async function resolveSessionForExport() {
    const id = targetSessionId();
    if (id === options.getActiveSessionId()) {
      const session = options.getSavedSessions().find(item => item.id === id) || { id, title: '' };
      return { session, history: options.getHistory() };
    }
    const conversation = await options.getSession(id);
    return { session: conversation, history: conversation.history || conversation.messages || [] };
  }

  async function exportConversationAsMarkdown() {
    const { session, history } = await resolveSessionForExport();
    const title = session.title || 'ZeroChat_Conversation';
    const Export = getExport();
    Export.downloadFile(Export.buildMarkdownExport(history, { title, model: options.getConfig().model }), `${fileBaseName(title)}.md`, 'text/markdown');
    closeExportModal();
  }

  async function exportConversationAsJson() {
    const { session, history } = await resolveSessionForExport();
    const Export = getExport();
    Export.downloadFile(Export.buildJsonExport(session, history, options.getConfig()), `${fileBaseName(session.title || 'ZeroChat_Conversation')}.json`, 'application/json');
    closeExportModal();
  }

  /** Imprime la conversación: si no es la activa, cambia antes a ella. */
  async function exportConversationAsPrint() {
    const id = targetSessionId();
    closeExportModal();
    if (id !== options.getActiveSessionId()) await options.onSwitchSession(id);
    setTimeout(() => window.print(), 200);
  }

  async function handleImportFileSelected() {
    const input = els.importJsonInput;
    const file = input.files[0];
    try {
      if (!file || options.isBusy()) return;
      const check = resolveDep('ChatAttachments', './attachments.js').validateFileSize(file);
      if (!check.valid) {
        await getDialogs().alert(t('err_file_too_large', { name: file.name, max: Utils.formatBytes(check.maxBytes) }), { type: 'error' });
        return;
      }
      const session = getExport().parseImportedJson(await file.text(), file.name.replace(/\.json$/i, ''));
      await options.onImportSuccess(session);
    } catch (error) {
      console.error('[UITransfer] Conversation import failed:', error);
      getDialogs().alert(t('chat_import_json_err', { err: error?.message || error }), { type: 'error' });
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
    listen(els.btnExportMarkdown, 'click', exportConversationAsMarkdown);
    listen(els.btnExportJson, 'click', exportConversationAsJson);
    listen(els.btnExportPrint, 'click', exportConversationAsPrint);
    listen(els.btnImportChatFile, 'click', () => els.importJsonInput.click());
    listen(els.importJsonInput, 'change', handleImportFileSelected);
  }

  return { mount, openExportModal };
}));
