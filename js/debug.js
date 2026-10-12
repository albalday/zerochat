/**
 * Panel de depuración (ChatDebug): registro filtrable por pestañas (todo, razonamiento, herramientas,
 * red y crudo), estado de la generación y diálogo que intercepta el payload antes de enviarlo.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./utils.js'), require('./i18n.js'), require('./icons.js'));
  } else {
    root.ChatDebug = factory(root.ChatUtils, root.ChatI18n, root.ChatIcons);
  }
}(typeof self !== 'undefined' ? self : this, function (Utils, I18n, Icons) {
  'use strict';

  const { resolveDep, escapeHtml } = Utils;
  const { t } = I18n;

  const MAX_RAW_ENTRIES = 2000;
  const TAG_KEYS = {
    network: 'debug_tag_network',
    tool: 'debug_tag_tool',
    stats: 'debug_tag_stats',
    error: 'debug_tag_error',
    warning: 'debug_tag_warning',
    system: 'debug_tag_system'
  };
  const STATUS_KEYS = { streaming: 'debug_status_streaming', done: 'debug_status_done', error: 'debug_status_error' };
  // Tipos de entrada que muestra cada pestaña; «todo» muestra todos salvo los crudos.
  const NETWORK_TYPES = new Set(['network', 'stats', 'error', 'warning']);

  // Elementos de la aplicación, fijados con setElements().
  let dom = {};
  let activeFilter = 'all';
  let activeThinkingBlock = null;
  let rawLogsEnabled = true;

  function setElements(elements) {
    dom = elements;
  }

  function setRawLogsEnabled(enabled) {
    rawLogsEnabled = Boolean(enabled);
  }

  const getFormattedTime = () => new Date().toTimeString().split(' ')[0];

  // Sigue el final del log salvo que el usuario haya subido; force vuelve a engancharlo.
  function scrollLogToBottom(force = false) {
    resolveDep('ChatUIConversation', './ui-conversation.js').scrollToBottom(dom.debugLogContent, { force });
  }

  function isVisibleIn(filter, type) {
    if (filter === 'all') return type !== 'raw';
    if (filter === 'network') return NETWORK_TYPES.has(type);
    return filter === type;
  }

  function togglePanel(forceOpen) {
    const shouldOpen = forceOpen !== undefined ? forceOpen : dom.debugPanel.hidden;
    dom.debugPanel.hidden = !shouldOpen;
    dom.btnToggleDebug.classList.toggle('active', shouldOpen);
    dom.btnToggleDebug.setAttribute('aria-expanded', String(shouldOpen));
    if (shouldOpen) scrollLogToBottom(true);
  }

  function setStatus(status, text) {
    dom.debugStatusIndicator.className = `debug-status-indicator ${status || 'idle'}`;
    dom.debugStatusIndicator.textContent = text || t(STATUS_KEYS[status] || 'debug_status_idle');
  }

  function clearLogs() {
    dom.debugLogContent.innerHTML = `
      <div class="debug-entry debug-entry-system" data-type="system">
        <span class="debug-time">[${getFormattedTime()}]</span>
        <span class="debug-tag system">[${escapeHtml(t('debug_tag_system'))}]</span>
        <span class="debug-msg">${escapeHtml(t('debug_sys_cleared'))}</span>
      </div>
    `;
    activeThinkingBlock = null;
  }

  function copyLogs() {
    return Utils.copyToClipboard(dom.debugLogContent.innerText, dom.btnCopyDebug, Icons.get('check', { size: 13 }));
  }

  function createEntry(type, tagHtml, messageHtml, className = `debug-entry-${type}`) {
    const entry = document.createElement('div');
    entry.className = `debug-entry ${className}`;
    entry.dataset.type = type;
    entry.innerHTML = `
      <div class="debug-entry-header">
        <span class="debug-time">[${getFormattedTime()}]</span>
        ${tagHtml}
      </div>
      <div class="debug-msg">${messageHtml}</div>
    `;
    entry.hidden = !isVisibleIn(activeFilter, type);
    dom.debugLogContent.appendChild(entry);
    return entry;
  }

  /**
   * Añade una entrada al registro. El razonamiento ('thinking') se acumula en un bloque hasta la
   * siguiente entrada de otro tipo; las crudas ('raw') solo se guardan si están activadas.
   */
  function addLog(type, text, rawData) {
    if (type === 'raw') {
      if (!rawLogsEnabled) return;
      const isOutgoing = rawData?.subtype === 'outgoing' || String(text).startsWith('>>>');
      createEntry('raw', `<span class="debug-tag raw">${isOutgoing ? 'RAW OUT' : 'RAW IN'}</span>`, escapeHtml(text), `debug-entry-raw ${isOutgoing ? 'raw-outgoing' : 'raw-incoming'}`);
      // Las entradas crudas se acotan para no acumular memoria.
      const rawEntries = dom.debugLogContent.querySelectorAll('[data-type="raw"]');
      if (rawEntries.length > MAX_RAW_ENTRIES) rawEntries[0].remove();
    } else if (type === 'thinking') {
      if (!activeThinkingBlock) {
        activeThinkingBlock = createEntry('thinking', `<span class="debug-tag thinking">${escapeHtml(t('debug_tag_thinking'))}</span>`, '').querySelector('.debug-msg');
      }
      activeThinkingBlock.textContent += text;
    } else {
      activeThinkingBlock = null;
      const entryType = type || 'info';
      createEntry(entryType, `<span class="debug-tag ${escapeHtml(entryType)}">[${escapeHtml(t(TAG_KEYS[entryType] || 'debug_tag_info'))}]</span>`, escapeHtml(text));
    }
    scrollLogToBottom();
  }

  function filterLogs(tabId) {
    activeFilter = tabId;
    dom.debugLogContent.querySelectorAll('.debug-entry').forEach(entry => {
      entry.hidden = !isVisibleIn(tabId, entry.dataset.type);
    });
    scrollLogToBottom(true);
  }

  const MAXIMIZE_SVG = Icons.get('shuffle', { size: 14 });
  const RESTORE_SVG = '<svg class="ui-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20"></polyline><polyline points="20 10 14 10 14 4"></polyline><line x1="14" y1="10" x2="21" y2="3"></line><line x1="3" y1="21" x2="10" y2="14"></line></svg>';

  /**
   * Muestra el payload saliente para revisarlo o editarlo. Resuelve { cancel: true } al cancelar o
   * { cancel: false, modifiedPayload } al enviar; «enviar y parar» desactiva además el interceptor.
   */
  function openInterceptorModal({ endpoint, payload, onSyncDebugState }) {
    return new Promise(resolve => {
      const dialog = dom.debugInterceptorDialog;
      const showJsonError = error => {
        dom.debugJsonError.textContent = t('debug_json_error_invalid', { error: error.message });
        dom.debugJsonError.hidden = false;
      };
      let isMaximized = false;
      dom.btnMaximizeDebugModal.innerHTML = MAXIMIZE_SVG;
      dom.debugModalEndpointBadge.textContent = `POST ${endpoint}`;
      dom.txtDebugPayload.value = JSON.stringify(payload, null, 2);
      dom.debugJsonError.hidden = true;
      dom.debugJsonError.textContent = '';

      const buttons = [dom.btnMaximizeDebugModal, dom.btnDebugSend, dom.btnDebugSendDisable, dom.btnCloseDebugModal, dom.btnFormatDebugJson, dom.btnCopyDebugJson];
      const finish = result => {
        if (dialog.open) dialog.close();
        dialog.classList.remove('maximized');
        buttons.forEach(button => { button.onclick = null; });
        resolve(result);
      };
      const send = disableDebug => {
        let editedJson = null;
        const raw = dom.txtDebugPayload.value.trim();
        if (raw) {
          try {
            editedJson = JSON.parse(raw);
          } catch (error) {
            showJsonError(error);
            return;
          }
        }
        if (disableDebug) onSyncDebugState(false);
        finish({ cancel: false, modifiedPayload: editedJson });
      };

      dom.btnMaximizeDebugModal.onclick = () => {
        isMaximized = !isMaximized;
        dialog.classList.toggle('maximized', isMaximized);
        dom.btnMaximizeDebugModal.innerHTML = isMaximized ? RESTORE_SVG : MAXIMIZE_SVG;
      };
      dom.btnFormatDebugJson.onclick = () => {
        try {
          dom.txtDebugPayload.value = JSON.stringify(JSON.parse(dom.txtDebugPayload.value), null, 2);
          dom.debugJsonError.hidden = true;
        } catch (error) {
          showJsonError(error);
        }
      };
      dom.btnCopyDebugJson.onclick = () => Utils.copyToClipboard(dom.txtDebugPayload.value, dom.btnCopyDebugJson,
        `${Icons.get('check', { size: 13 })}<span>${escapeHtml(t('copied_text'))}</span>`);
      dom.btnDebugSend.onclick = () => send(false);
      dom.btnDebugSendDisable.onclick = () => send(true);
      dom.btnCloseDebugModal.onclick = () => finish({ cancel: true });
      dialog.showModal();
      dom.txtDebugPayload.focus();
    });
  }

  function getDebugInterceptorDialogHTML() {
    return `<div class="modal-header">
      <div class="modal-title">
        <h3 data-i18n="debug_modal_title">Debug</h3>
      </div>
      <div class="modal-header-actions">
        <div class="debug-modal-send-actions">
          <button type="button" id="btn-debug-send-disable" class="btn-debug-header-action btn-debug-header-stop" data-i18n="btn_send_and_stop_debug"><svg class="ui-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-stop"></use></svg><span>Enviar y parar debug</span></button>
          <button type="button" id="btn-debug-send" class="btn-debug-header-action btn-debug-header-send" data-i18n="btn_send"><svg class="ui-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-send"></use></svg><span>Enviar</span></button>
        </div>
        <button type="button" id="btn-maximize-debug-modal" class="modal-btn-action" data-i18n-title="btn_maximize_title" title="Maximizar / Restaurar">
          <svg class="ui-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-shuffle"></use></svg>
        </button>
        <button type="button" id="btn-close-debug-modal" class="modal-btn-close" data-i18n-title="btn_cancel" title="Cancelar envío"><svg class="ui-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-close"></use></svg></button>
      </div>
    </div>
    
    <div class="debug-modal-body">
      <div class="debug-modal-info">
        <p data-i18n="debug_modal_desc">
          Revisa o modifica el payload JSON antes de enviarlo al servidor. Puedes editar cualquier mensaje, parámetros o herramientas.
        </p>
      </div>

      <div class="debug-editor-wrapper">
        <div class="debug-editor-header">
          <span id="debug-modal-endpoint-badge" class="debug-endpoint-badge">POST /v1/chat/completions</span>
          <div class="debug-editor-actions">
            <button type="button" id="btn-format-debug-json" class="btn-secondary btn-debug-editor-action" title="Formatear JSON">
              <svg class="ui-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-sparkles"></use></svg>
              <span data-i18n="btn_format_json">Formatear</span>
            </button>
            <button type="button" id="btn-copy-debug-json" class="btn-secondary btn-debug-editor-action" title="Copiar todo al portapapeles">
              <svg class="ui-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-copy"></use></svg>
              <span data-i18n="btn_copy_all">Copiar todo</span>
            </button>
          </div>
        </div>
        <textarea id="txt-debug-payload" class="debug-payload-textarea" spellcheck="false" wrap="off"></textarea>
        <div id="debug-json-error" class="debug-json-error" hidden></div>
      </div>

    </div>`;
  }

  /** Inserta el marcado del diálogo interceptor, que zerochat.html deja vacío. */
  function ensureDialogMarkup() {
    const dialog = document.getElementById('debug-interceptor-dialog');
    if (!dialog.firstElementChild) dialog.innerHTML = getDebugInterceptorDialogHTML();
  }

  /** Registra en el panel los errores y las promesas rechazadas sin capturar; ignora las cancelaciones. */
  function registerGlobalErrorHandlers(targetWindow) {
    const isAbort = error => error?.name === 'AbortError' || (typeof error?.message === 'string' && error.message.includes('aborted'));
    targetWindow.addEventListener('unhandledrejection', event => {
      if (isAbort(event.reason)) return;
      addLog('error', `[Unhandled Promise] ${event.reason?.stack || event.reason?.message || String(event.reason || 'Unknown unhandled rejection')}`);
    });
    targetWindow.addEventListener('error', event => {
      if (isAbort(event.error)) return;
      const source = event.filename ? ` at ${event.filename}:${event.lineno || 0}` : '';
      addLog('error', `[Runtime Error] ${event.message || event.error?.message || 'Runtime error'}${source}`);
    });
  }

  return {
    setElements,
    setRawLogsEnabled,
    togglePanel,
    setStatus,
    clearLogs,
    copyLogs,
    addLog,
    filterLogs,
    openInterceptorModal,
    ensureDialogMarkup,
    registerGlobalErrorHandlers
  };
}));
