/**
 * Módulo de Depuración, Logs e Interceptor de Mensajes (ChatDebug) para ZeroChat.
 * Gestiona el panel de logs, el filtrado por pestañas (Todo, Pensamiento, Herramientas, Red, Raw),
 * el formateo de marcas temporales y la ventana emergente de depuración de payloads salientes.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.ChatDebug = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function getMarkdown() {
    return (typeof window !== 'undefined' && window.ChatMarkdown) ? window.ChatMarkdown : {
      escapeHtml: (str) => String(str || '')
    };
  }

  function getI18n() {
    return (typeof window !== 'undefined' && window.ChatI18n) ? window.ChatI18n : {
      t: (k) => k
    };
  }

  function t(key, params) {
    const i18n = getI18n();
    return i18n.t ? i18n.t(key, params) : key;
  }

  let dom = {};
  let isAutoscroll = true;
  let activeFilter = 'all';
  let activeThinkingBlock = null;
  let rawLogsEnabled = false;

  function setElements(elements) {
    dom = elements || {};
  }

  function setRawLogsEnabled(enabled) {
    rawLogsEnabled = Boolean(enabled);
  }

  function isRawLogsEnabled() {
    return rawLogsEnabled;
  }

  function getFormattedTime() {
    const now = new Date();
    return now.toTimeString().split(' ')[0];
  }

  function toggleAutoscroll() {
    isAutoscroll = !isAutoscroll;
    if (dom.btnToggleAutoscroll) {
      dom.btnToggleAutoscroll.classList.toggle('active', isAutoscroll);
    }
    return isAutoscroll;
  }

  function togglePanel(forceOpen) {
    if (!dom.debugPanel) return;
    const isVisible = dom.debugPanel.style.display !== 'none';
    const shouldOpen = (forceOpen !== undefined) ? forceOpen : !isVisible;

    if (shouldOpen) {
      dom.debugPanel.style.display = 'flex';
      if (dom.btnToggleDebug) dom.btnToggleDebug.classList.add('active');
      if (isAutoscroll && dom.debugLogContent) {
        dom.debugLogContent.scrollTop = dom.debugLogContent.scrollHeight;
      }
    } else {
      dom.debugPanel.style.display = 'none';
      if (dom.btnToggleDebug) dom.btnToggleDebug.classList.remove('active');
    }
  }

  function setStatus(status, text) {
    if (!dom.debugStatusIndicator) return;
    dom.debugStatusIndicator.className = `debug-status-indicator ${status || 'idle'}`;
    let label = text;
    if (!label) {
      if (status === 'streaming') label = t('debug_status_streaming');
      else if (status === 'done') label = t('debug_status_done');
      else if (status === 'error') label = t('debug_status_error');
      else label = t('debug_status_idle');
    }
    dom.debugStatusIndicator.textContent = label;
  }

  function clearLogs() {
    if (!dom.debugLogContent) return;
    dom.debugLogContent.innerHTML = `
      <div class="debug-entry debug-entry-system" data-type="system">
        <span class="debug-time">[${getFormattedTime()}]</span>
        <span class="debug-tag system">[${t('debug_tag_system')}]</span>
        <span class="debug-msg">${t('debug_sys_cleared')}</span>
      </div>
    `;
    activeThinkingBlock = null;
  }

  async function copyLogs() {
    if (!dom.debugLogContent || !dom.btnCopyDebug) return false;
    try {
      const text = dom.debugLogContent.innerText;
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(text);
      }
      const originalHtml = dom.btnCopyDebug.innerHTML;
      dom.btnCopyDebug.innerHTML = '<svg class="ui-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
      setTimeout(() => {
        dom.btnCopyDebug.innerHTML = originalHtml;
      }, 1500);
      return true;
    } catch (e) {
      console.error('ChatDebug: Error al copiar logs:', e);
      return false;
    }
  }

  function getDoc() {
    if (typeof document !== 'undefined') return document;
    if (typeof window !== 'undefined' && window.document) return window.document;
    return null;
  }

  function addLog(type, text, rawData) {
    if (!dom.debugLogContent) return;
    const doc = getDoc();
    if (!doc || typeof doc.createElement !== 'function') return;
    const Markdown = getMarkdown();

    // 1. Logs RAW
    if (type === 'raw') {
      if (!rawLogsEnabled) return;

      const entry = doc.createElement('div');
      const isOutgoing = (rawData && rawData.subtype === 'outgoing') || String(text).startsWith('>>>');
      entry.className = `debug-entry debug-entry-raw ${isOutgoing ? 'raw-outgoing' : 'raw-incoming'}`;
      entry.setAttribute('data-type', 'raw');

      entry.innerHTML = `
        <div class="debug-entry-header">
          <span class="debug-time">[${getFormattedTime()}]</span>
          <span class="debug-tag raw">${isOutgoing ? 'RAW OUT' : 'RAW IN'}</span>
        </div>
        <div class="debug-msg">${Markdown.escapeHtml(text)}</div>
      `;

      if (activeFilter !== 'raw') {
        entry.style.display = 'none';
      }

      dom.debugLogContent.appendChild(entry);
      if (isAutoscroll) {
        dom.debugLogContent.scrollTop = dom.debugLogContent.scrollHeight;
      }
      return;
    }

    // 2. Logs de Razonamiento / Thinking
    if (type === 'thinking') {
      if (!activeThinkingBlock) {
        const entry = doc.createElement('div');
        entry.className = 'debug-entry debug-entry-thinking';
        entry.setAttribute('data-type', 'thinking');
        entry.innerHTML = `
          <div class="debug-entry-header">
            <span class="debug-time">[${getFormattedTime()}]</span>
            <span class="debug-tag thinking">${t('debug_tag_thinking')}</span>
          </div>
          <div class="debug-msg"></div>
        `;
        dom.debugLogContent.appendChild(entry);
        activeThinkingBlock = entry.querySelector('.debug-msg');

        if (activeFilter !== 'all' && activeFilter !== 'thinking') {
          entry.style.display = 'none';
        }
      }

      if (activeThinkingBlock) {
        activeThinkingBlock.textContent += text;
      }

      if (isAutoscroll) {
        dom.debugLogContent.scrollTop = dom.debugLogContent.scrollHeight;
      }
      return;
    }

    // 3. Otros tipos (network, tool, stats, error, system, info)
    activeThinkingBlock = null;

    const entry = doc.createElement('div');
    entry.className = `debug-entry debug-entry-${type || 'info'}`;
    entry.setAttribute('data-type', type || 'info');

    let tagLabel = t('debug_tag_info');
    if (type === 'network') tagLabel = t('debug_tag_network');
    else if (type === 'tool') tagLabel = t('debug_tag_tool');
    else if (type === 'stats') tagLabel = t('debug_tag_stats');
    else if (type === 'error') tagLabel = t('debug_tag_error');
    else if (type === 'warning') tagLabel = t('debug_tag_warning');
    else if (type === 'system') tagLabel = t('debug_tag_system');

    entry.innerHTML = `
      <div class="debug-entry-header">
        <span class="debug-time">[${getFormattedTime()}]</span>
        <span class="debug-tag ${type || 'info'}">[${tagLabel}]</span>
      </div>
      <div class="debug-msg">${Markdown.escapeHtml(text)}</div>
    `;

    if (activeFilter === 'raw') {
      entry.style.display = 'none';
    } else if (activeFilter !== 'all') {
      const match = (activeFilter === type) ||
                    (activeFilter === 'tool' && type === 'tool') ||
                    (activeFilter === 'network' && (type === 'network' || type === 'stats' || type === 'error' || type === 'warning'));
      if (!match) entry.style.display = 'none';
    }

    dom.debugLogContent.appendChild(entry);
    if (isAutoscroll) {
      dom.debugLogContent.scrollTop = dom.debugLogContent.scrollHeight;
    }
  }

  function filterLogs(tabId) {
    activeFilter = tabId;
    if (!dom.debugLogContent) return;

    const entries = dom.debugLogContent.querySelectorAll('.debug-entry');
    entries.forEach(entry => {
      const type = entry.getAttribute('data-type');
      if (tabId === 'all') {
        entry.style.display = (type === 'raw') ? 'none' : 'flex';
      } else if (tabId === 'thinking') {
        entry.style.display = (type === 'thinking') ? 'flex' : 'none';
      } else if (tabId === 'tool') {
        entry.style.display = (type === 'tool') ? 'flex' : 'none';
      } else if (tabId === 'network') {
        entry.style.display = (type === 'network' || type === 'stats' || type === 'error' || type === 'warning') ? 'flex' : 'none';
      } else if (tabId === 'raw') {
        entry.style.display = (type === 'raw') ? 'flex' : 'none';
      }
    });
  }

  function openInterceptorModal({ endpoint, headers, payload, onSyncDebugState }) {
    ensureDialogMarkup();
    return new Promise((resolve) => {
      if (!dom.debugInterceptorDialog) {
        return resolve({ cancel: false, modifiedPayload: null });
      }

      let isMaximized = false;
      const MAXIMIZE_SVG = '<svg class="ui-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"></polyline><polyline points="9 21 3 21 3 15"></polyline><line x1="21" y1="3" x2="14" y2="10"></line><line x1="3" y1="21" x2="10" y2="14"></line></svg>';
      const RESTORE_SVG = '<svg class="ui-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20"></polyline><polyline points="20 10 14 10 14 4"></polyline><line x1="14" y1="10" x2="21" y2="3"></line><line x1="3" y1="21" x2="10" y2="14"></line></svg>';

      if (dom.btnMaximizeDebugModal) {
        dom.btnMaximizeDebugModal.innerHTML = MAXIMIZE_SVG;
      }

      if (dom.debugModalEndpointBadge) {
        dom.debugModalEndpointBadge.textContent = `POST ${endpoint}`;
      }
      if (dom.txtDebugPayload) {
        dom.txtDebugPayload.value = JSON.stringify(payload, null, 2);
      }
      if (dom.debugJsonError) {
        dom.debugJsonError.style.display = 'none';
        dom.debugJsonError.textContent = '';
      }

      function cleanup() {
        if (dom.debugInterceptorDialog.open) {
          dom.debugInterceptorDialog.close();
        }
        dom.debugInterceptorDialog.classList.remove('maximized');
        if (dom.btnMaximizeDebugModal) dom.btnMaximizeDebugModal.onclick = null;
        if (dom.btnDebugCancel) dom.btnDebugCancel.onclick = null;
        if (dom.btnDebugSend) dom.btnDebugSend.onclick = null;
        if (dom.btnDebugSendDisable) dom.btnDebugSendDisable.onclick = null;
        if (dom.btnCloseDebugModal) dom.btnCloseDebugModal.onclick = null;
        if (dom.btnFormatDebugJson) dom.btnFormatDebugJson.onclick = null;
        if (dom.btnCopyDebugJson) dom.btnCopyDebugJson.onclick = null;
      }

      if (dom.btnMaximizeDebugModal) {
        dom.btnMaximizeDebugModal.onclick = () => {
          isMaximized = !isMaximized;
          dom.debugInterceptorDialog.classList.toggle('maximized', isMaximized);
          dom.btnMaximizeDebugModal.innerHTML = isMaximized ? RESTORE_SVG : MAXIMIZE_SVG;
        };
      }

      if (dom.btnFormatDebugJson) {
        dom.btnFormatDebugJson.onclick = () => {
          try {
            const parsed = JSON.parse(dom.txtDebugPayload.value);
            dom.txtDebugPayload.value = JSON.stringify(parsed, null, 2);
            if (dom.debugJsonError) dom.debugJsonError.style.display = 'none';
          } catch (err) {
            if (dom.debugJsonError) {
              dom.debugJsonError.textContent = t('debug_json_error_invalid', { error: err.message });
              dom.debugJsonError.style.display = 'block';
            }
          }
        };
      }

      if (dom.btnCopyDebugJson) {
        dom.btnCopyDebugJson.onclick = async () => {
          try {
            await navigator.clipboard.writeText(dom.txtDebugPayload.value);
            const span = dom.btnCopyDebugJson.querySelector('span');
            if (span) {
              const old = span.textContent;
              span.textContent = 'Copiado';
              setTimeout(() => { span.textContent = old; }, 1500);
            }
          } catch (e) {}
        };
      }

      function handleSend(disableDebug = false) {
        let editedJson = null;
        const raw = dom.txtDebugPayload.value.trim();
        if (raw) {
          try {
            editedJson = JSON.parse(raw);
          } catch (err) {
            if (dom.debugJsonError) {
              dom.debugJsonError.textContent = t('debug_json_error_invalid', { error: err.message });
              dom.debugJsonError.style.display = 'block';
            }
            return;
          }
        }

        if (disableDebug && typeof onSyncDebugState === 'function') {
          onSyncDebugState(false);
        }

        cleanup();
        resolve({ cancel: false, modifiedPayload: editedJson });
      }

      if (dom.btnDebugSend) {
        dom.btnDebugSend.onclick = () => handleSend(false);
      }
      if (dom.btnDebugSendDisable) {
        dom.btnDebugSendDisable.onclick = () => handleSend(true);
      }
      if (dom.btnDebugCancel) {
        dom.btnDebugCancel.onclick = () => {
          cleanup();
          resolve({ cancel: true });
        };
      }
      if (dom.btnCloseDebugModal) {
        dom.btnCloseDebugModal.onclick = () => {
          cleanup();
          resolve({ cancel: true });
        };
      }

      dom.debugInterceptorDialog.showModal();
      if (dom.txtDebugPayload) {
        dom.txtDebugPayload.focus();
      }
    });
  }

  function getDebugInterceptorDialogHTML() {
    return `<div class="modal-header">
      <div class="modal-title">
        <svg class="ui-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-terminal"></use></svg>
        <h3 data-i18n="debug_modal_title">Debug de Mensaje Saliente</h3>
      </div>
      <div class="modal-header-actions">
        <button type="button" id="btn-maximize-debug-modal" class="modal-btn-action" data-i18n-title="btn_maximize_title" title="Maximizar / Restaurar">
          <svg class="ui-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-shuffle"></use></svg>
        </button>
        <button type="button" id="btn-close-debug-modal" class="modal-btn-close" title="Cancelar envío">
          <svg class="ui-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-close"></use></svg>
        </button>
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
            <button type="button" id="btn-format-debug-json" class="btn-tool-mini" title="Formatear JSON">
              <svg class="ui-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-sparkles"></use></svg>
              <span data-i18n="btn_format_json">Formatear</span>
            </button>
            <button type="button" id="btn-copy-debug-json" class="btn-tool-mini" title="Copiar todo al portapapeles">
              <svg class="ui-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-copy"></use></svg>
              <span data-i18n="btn_copy_all">Copiar todo</span>
            </button>
          </div>
        </div>
        <textarea id="txt-debug-payload" class="debug-payload-textarea" spellcheck="false" wrap="off"></textarea>
        <div id="debug-json-error" class="debug-json-error" style="display: none;"></div>
      </div>

      <div class="debug-modal-footer">
        <div class="debug-modal-footer-actions">
          <button type="button" id="btn-debug-cancel" class="btn-secondary" data-i18n="btn_cancel">Cancelar</button>
          <button type="button" id="btn-debug-send-disable" class="btn-secondary-action" data-i18n="btn_send_and_stop_debug">Enviar y parar debug</button>
          <button type="button" id="btn-debug-send" class="btn-primary" data-i18n="btn_send">Enviar</button>
        </div>
      </div>
    </div>`;
  }

  function ensureDialogMarkup() {
    if (typeof document === 'undefined') return;
    const dialog = document.getElementById('debug-interceptor-dialog');
    if (dialog && !dialog.firstElementChild) {
      dialog.innerHTML = getDebugInterceptorDialogHTML();
    }
  }

  let globalHandlersRegistered = false;

  function registerGlobalErrorHandlers(targetWindow = (typeof window !== 'undefined' ? window : null)) {
    if (!targetWindow || typeof targetWindow.addEventListener !== 'function') return false;
    const isDefaultWindow = typeof window !== 'undefined' && targetWindow === window;
    if (isDefaultWindow) {
      if (globalHandlersRegistered) return true;
      globalHandlersRegistered = true;
    }

    targetWindow.addEventListener('unhandledrejection', (event) => {
      try {
        const reason = event?.reason;
        if (reason && (reason.name === 'AbortError' || (typeof reason.message === 'string' && reason.message.includes('aborted')))) {
          return;
        }
        const text = reason?.stack || reason?.message || String(reason || 'Unknown unhandled rejection');
        addLog('error', `[Unhandled Promise] ${text}`);
      } catch (_) {}
    });

    targetWindow.addEventListener('error', (event) => {
      try {
        if (event?.error && (event.error.name === 'AbortError' || (typeof event.error.message === 'string' && event.error.message.includes('aborted')))) {
          return;
        }
        const msg = event?.message || event?.error?.message || 'Runtime error';
        const source = event?.filename ? ` at ${event.filename}:${event.lineno || 0}` : '';
        addLog('error', `[Runtime Error] ${msg}${source}`);
      } catch (_) {}
    });

    return true;
  }

  if (typeof window !== 'undefined') {
    registerGlobalErrorHandlers(window);
  }

  return {
    setElements,
    setRawLogsEnabled,
    isRawLogsEnabled,
    getFormattedTime,
    toggleAutoscroll,
    togglePanel,
    setStatus,
    clearLogs,
    copyLogs,
    addLog,
    filterLogs,
    openInterceptorModal,
    ensureDialogMarkup,
    getDebugInterceptorDialogHTML,
    registerGlobalErrorHandlers
  };
}));
