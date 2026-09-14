/**
 * Módulo de Transferencia para ZeroChat:
 * Gestión del modal de exportación (Markdown, JSON, Print) e importación de conversaciones desde archivo JSON.
 * Reutiliza ChatExport (js/export.js) para los formatos de salida y parseo de datos.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.ChatUITransfer = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function resolveDep(globalName, relPath) {
    if (typeof window !== 'undefined' && window[globalName]) return window[globalName];
    if (typeof globalThis !== 'undefined' && globalThis[globalName]) return globalThis[globalName];
    if (typeof require !== 'undefined') {
      try { return require(relPath); } catch (_) {}
    }
    return null;
  }

  function getI18n() { return resolveDep('ChatI18n', './i18n.js'); }
  function getExport() { return resolveDep('ChatExport', './export.js'); }
  function getDialogs() { return resolveDep('ChatDialogs', './ui-dialogs.js'); }

  function t(key, params) {
    const I18n = getI18n();
    return I18n?.t?.(key, params) || key;
  }

  let activeCleanupFns = [];
  let cachedElements = null;
  let cachedOptions = {};

  function getExportTargetSessionId(elements, fallbackId = '') {
    return elements?.exportModal?.dataset?.sessionId || fallbackId;
  }

  function openExportModal(elements, targetSessionId = null, fallbackId = '') {
    const modal = elements?.exportModal;
    if (modal) {
      if (!modal.dataset) modal.dataset = {};
      modal.dataset.sessionId = targetSessionId || fallbackId;
      if (typeof modal.showModal === 'function') {
        modal.showModal();
      } else {
        modal.style.display = 'block';
      }
    }
  }

  function closeExportModal(elements) {
    const modal = elements?.exportModal;
    if (modal) {
      if (modal.dataset) delete modal.dataset.sessionId;
      if (typeof modal.close === 'function') {
        modal.close();
      } else {
        modal.style.display = 'none';
      }
    }
  }

  async function resolveSessionForExport(elementsOrTargetId, options = {}) {
    const activeId = options.getActiveSessionId ? options.getActiveSessionId() : '';
    const targetId = typeof elementsOrTargetId === 'string' ? elementsOrTargetId : null;
    const els = typeof elementsOrTargetId === 'object' ? elementsOrTargetId : null;
    const id = targetId || getExportTargetSessionId(els, activeId);
    if (!id) return null;

    if (id === activeId) {
      const savedList = options.getSavedSessions ? options.getSavedSessions() : [];
      const sess = savedList.find?.(s => s.id === id) || { id, title: 'ZeroChat_Conversation' };
      const history = options.getHistory ? options.getHistory() : [];
      return { id, sess, history, messages: history };
    }

    if (typeof options.getSession === 'function') {
      const conv = await options.getSession(id);
      const messages = conv?.history || conv?.messages || [];
      return { id, sess: conv, history: messages, messages };
    }

    return null;
  }

  async function exportConversationAsMarkdown(elements, options = {}) {
    const session = await resolveSessionForExport(elements, options);
    const { sess, history } = session || {};
    const title = (sess && sess.title) || 'ZeroChat_Conversation';
    const dateStr = new Date().toISOString().slice(0, 10);
    const Export = getExport();
    const model = options.getModel ? options.getModel() : '';
    const md = Export?.buildMarkdownExport ? Export.buildMarkdownExport(history, { title, model }) : '';
    if (Export?.downloadFile) {
      Export.downloadFile(md, `${title.replace(/[^a-zA-Z0-9_-]/g, '_')}_${dateStr}.md`, 'text/markdown');
    }
    closeExportModal(elements);
  }

  async function exportConversationAsJson(elements, options = {}) {
    const session = await resolveSessionForExport(elements, options);
    const { sess, history } = session || {};
    const title = (sess && sess.title) || 'ZeroChat_Conversation';
    const dateStr = new Date().toISOString().slice(0, 10);
    const Export = getExport();
    const config = options.getConfig ? options.getConfig() : {};
    const jsonStr = Export?.buildJsonExport ? Export.buildJsonExport(sess, history, config) : '{}';
    if (Export?.downloadFile) {
      Export.downloadFile(jsonStr, `${title.replace(/[^a-zA-Z0-9_-]/g, '_')}_${dateStr}.json`, 'application/json');
    }
    closeExportModal(elements);
  }

  async function exportConversationAsPrint(elements, options = {}) {
    const activeId = options.getActiveSessionId ? options.getActiveSessionId() : '';
    const targetId = getExportTargetSessionId(elements, activeId);
    closeExportModal(elements);

    if (targetId && targetId !== activeId && typeof options.onSwitchSession === 'function') {
      await options.onSwitchSession(targetId);
    }

    setTimeout(() => {
      if (typeof window !== 'undefined' && typeof window.print === 'function') {
        window.print();
      }
    }, 200);
  }

  function parseConversationJson(rawText) {
    const data = JSON.parse(rawText);
    if (!data || (!data.messages && !Array.isArray(data))) {
      throw new Error('Estructura de conversación no válida.');
    }
    const messages = Array.isArray(data) ? data : (data.messages || []);
    return { messages, raw: data };
  }

  async function handleImportFileSelected(e, elements, options = {}) {
    const file = e.target?.files && e.target.files[0];
    if (!file) return;

    if (typeof options.isBusy === 'function' && options.isBusy()) {
      if (elements?.importJsonInput) elements.importJsonInput.value = '';
      return;
    }

    const maxBytes = options.maxBytes || (50 * 1024 * 1024);
    const Dialogs = getDialogs();
    if (file.size > maxBytes) {
      if (Dialogs?.alert) {
        await Dialogs.alert(t('err_file_too_large', { name: file.name, max: '50 MB' }), { type: 'error' });
      }
      if (elements?.importJsonInput) elements.importJsonInput.value = '';
      return;
    }

    try {
      const text = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (evt) => resolve(evt.target.result);
        reader.onerror = (evt) => reject(new Error('Error al leer el archivo'));
        reader.readAsText(file);
      });

      const Export = getExport();
      const baseName = file.name.replace(/\.json$/i, '');
      const newSession = Export?.parseImportedJson ? Export.parseImportedJson(text, baseName) : null;
      if (!newSession) throw new Error('Error al procesar el archivo');

      if (typeof options.onImportSuccess === 'function') {
        await options.onImportSuccess(newSession);
      }
    } catch (err) {
      console.error('Error al importar archivo:', err);
      if (Dialogs?.alert) {
        Dialogs.alert(t('chat_import_json_err', { err: err?.message || err }), { type: 'error' });
      }
    } finally {
      if (elements?.importJsonInput) elements.importJsonInput.value = '';
    }
  }

  function mount({ elements, getActiveSessionId, getSavedSessions, getHistory, getSession, getConfig, getModel, onSwitchSession, onImportSuccess, isBusy } = {}) {
    dispose();
    cachedElements = elements || {};
    cachedOptions = { getActiveSessionId, getSavedSessions, getHistory, getSession, getConfig, getModel, onSwitchSession, onImportSuccess, isBusy };

    const els = cachedElements;

    if (els.btnCloseExport) {
      const h = () => closeExportModal(els);
      els.btnCloseExport.addEventListener('click', h);
      activeCleanupFns.push(() => els.btnCloseExport.removeEventListener('click', h));
    }
    if (els.btnCancelExport) {
      const h = () => closeExportModal(els);
      els.btnCancelExport.addEventListener('click', h);
      activeCleanupFns.push(() => els.btnCancelExport.removeEventListener('click', h));
    }
    if (els.btnExportMarkdown) {
      const h = () => exportConversationAsMarkdown(els, cachedOptions);
      els.btnExportMarkdown.addEventListener('click', h);
      activeCleanupFns.push(() => els.btnExportMarkdown.removeEventListener('click', h));
    }
    if (els.btnExportJson) {
      const h = () => exportConversationAsJson(els, cachedOptions);
      els.btnExportJson.addEventListener('click', h);
      activeCleanupFns.push(() => els.btnExportJson.removeEventListener('click', h));
    }
    if (els.btnExportPrint) {
      const h = () => exportConversationAsPrint(els, cachedOptions);
      els.btnExportPrint.addEventListener('click', h);
      activeCleanupFns.push(() => els.btnExportPrint.removeEventListener('click', h));
    }

    if (els.btnImportChatFile) {
      const h = () => { if (els.importJsonInput) els.importJsonInput.click(); };
      els.btnImportChatFile.addEventListener('click', h);
      activeCleanupFns.push(() => els.btnImportChatFile.removeEventListener('click', h));
    }
    if (els.importJsonInput) {
      const h = (e) => handleImportFileSelected(e, els, cachedOptions);
      els.importJsonInput.addEventListener('change', h);
      activeCleanupFns.push(() => els.importJsonInput.removeEventListener('change', h));
    }

    return {
      openExportModal: (targetSessionId) => openExportModal(els, targetSessionId, cachedOptions.getActiveSessionId?.()),
      closeExportModal: () => closeExportModal(els),
      exportConversationAsMarkdown: () => exportConversationAsMarkdown(els, cachedOptions),
      exportConversationAsJson: () => exportConversationAsJson(els, cachedOptions),
      exportConversationAsPrint: () => exportConversationAsPrint(els, cachedOptions),
      handleImportFileSelected: (e) => handleImportFileSelected(e, els, cachedOptions),
      parseConversationJson
    };
  }

  function dispose() {
    activeCleanupFns.forEach(fn => { try { fn(); } catch (_) {} });
    activeCleanupFns = [];
    cachedElements = null;
    cachedOptions = {};
  }

  return {
    openExportModal,
    closeExportModal,
    getExportTargetSessionId,
    resolveSessionForExport,
    exportConversationAsMarkdown,
    exportConversationAsJson,
    exportConversationAsPrint,
    parseConversationJson,
    handleImportFileSelected,
    mount,
    dispose
  };
}));
