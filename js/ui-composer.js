/**
 * Módulo de Interfaz de Usuario para el Compositor de Mensajes (ZeroChat).
 * Gestiona el formulario del chat, textarea con auto-ajuste de altura,
 * eventos de teclado (Enter / Shift+Enter), portapapeles (imágenes), arrastrar y soltar (drag & drop),
 * renderizado de adjuntos, y sincronización de controles de generación (Enviar / Parar).
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.ChatUIComposer = factory();
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
  function getAttachments() { return resolveDep('ChatAttachments', './attachments.js'); }
  function getFileParser() { return resolveDep('ChatFileParser', './file-parser.js'); }
  function getDialogs() { return resolveDep('ChatDialogs', './ui-dialogs.js'); }
  function getState() { return resolveDep('ChatState', './state.js'); }

  function t(key, params) {
    const I18n = getI18n();
    return I18n?.t?.(key, params) || key;
  }

  let activeCleanupFns = [];
  let cachedElements = null;

  // field-sizing:content gestiona el auto-resize en CSS (Baseline 2024).
  // Esta función actúa como fallback para navegadores sin soporte.
  function autoResizeTextarea(elements) {
    const els = elements || cachedElements || {};
    if (typeof CSS !== 'undefined' && CSS.supports && CSS.supports('field-sizing', 'content')) return;
    if (!els.userInput || !els.userInput.style) return;
    if (!els.userInput.value) {
      els.userInput.style.height = '';
      return;
    }
    els.userInput.style.height = 'auto';
    const newHeight = Math.min(els.userInput.scrollHeight, 160);
    els.userInput.style.height = `${newHeight}px`;
  }

  function focusInput(elements) {
    const els = elements || cachedElements || {};
    if (els.userInput && typeof els.userInput.focus === 'function') {
      els.userInput.focus();
    }
  }

  function clearInput(elements) {
    const els = elements || cachedElements || {};
    if (els.userInput) {
      els.userInput.value = '';
    }
    autoResizeTextarea(els);
  }

  function getPromptValue(elements) {
    const els = elements || cachedElements || {};
    return (els.userInput?.value || '').trim();
  }

  function setPromptValue(elements, text) {
    const els = elements || cachedElements || {};
    if (els.userInput) {
      els.userInput.value = text || '';
    }
    autoResizeTextarea(els);
    focusInput(els);
  }

  function renderAttachedFiles(elements) {
    const els = elements || cachedElements || {};
    const Attachments = getAttachments();
    if (Attachments?.renderChips) {
      Attachments.renderChips(els.attachmentsContainer, () => autoResizeTextarea(els));
    }
  }

  function clearAttachedFiles(elements) {
    const els = elements || cachedElements || {};
    const Attachments = getAttachments();
    if (Attachments?.clearFiles) {
      Attachments.clearFiles();
      renderAttachedFiles(els);
    }
    if (els.fileInput) els.fileInput.value = '';
  }

  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsText(file);
    });
  }

  async function processFiles(elements, files) {
    const els = elements || cachedElements || {};
    const Attachments = getAttachments();
    const FileParser = getFileParser();
    const Dialogs = getDialogs();
    const maxBytes = Attachments?.MAX_FILE_SIZE || (50 * 1024 * 1024);

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file && typeof file.size === 'number' && file.size > maxBytes) {
        if (Dialogs?.alert) {
          await Dialogs.alert(t('err_file_too_large', { name: file.name, max: '50 MB' }), { type: 'error' });
        }
        continue;
      }
      try {
        let parsed;
        if (FileParser?.parseFile) {
          parsed = await FileParser.parseFile(file);
        } else {
          const text = await readFileAsText(file);
          parsed = {
            name: file.name,
            size: file.size,
            type: 'text',
            content: text
          };
        }
        if (Attachments?.addFile) Attachments.addFile(parsed);
      } catch (err) {
        console.error(`Error processing file ${file.name}:`, err);
        if (Dialogs?.alert) {
          Dialogs.alert(t('err_file_process', { name: file.name, err: err.message || err }), { type: 'error' });
        }
      }
    }
    renderAttachedFiles(els);
    focusInput(els);
  }

  function handlePasteEvent(e, elements) {
    const els = elements || cachedElements || {};
    if (!e.clipboardData || !e.clipboardData.items) return;
    const items = e.clipboardData.items;
    const FileParser = getFileParser();
    const Attachments = getAttachments();

    for (let i = 0; i < items.length; i++) {
      if (items[i].type && items[i].type.startsWith('image/')) {
        const file = items[i].getAsFile();
        if (file) {
          e.preventDefault();
          if (FileParser?.parseFile) {
            FileParser.parseFile(file).then(parsed => {
              if (Attachments?.addFile) Attachments.addFile(parsed);
              renderAttachedFiles(els);
            }).catch(err => {
              console.error('Error pasting image:', err);
            });
          }
        }
      }
    }
  }

  function updateComposerMcpState(elements, mcpState) {
    const els = elements || cachedElements || {};
    if (!els.btnComposerMcp) return;
    const State = getState();
    const st = mcpState || State?.get?.('mcp') || {};
    const status = st.status || 'disconnected';
    els.btnComposerMcp.classList.remove('mcp-connected', 'mcp-connecting', 'mcp-disconnected', 'mcp-error');
    els.btnComposerMcp.classList.add(`mcp-${status}`);
    const labelKey = `mcp_status_${status}`;
    const statusText = t(labelKey) || status;
    els.btnComposerMcp.title = `MCP: ${statusText}`;
    els.btnComposerMcp.setAttribute('aria-label', `MCP: ${statusText}`);
  }

  function syncGenerationControls(elements, isGenerating, options = {}) {
    const els = elements || cachedElements || {};
    const generating = Boolean(isGenerating);
    if (els.btnSend) els.btnSend.disabled = generating;
    if (els.btnStopStream) els.btnStopStream.style.display = generating ? 'inline-flex' : 'none';
    if (!generating && typeof options.clearGenerationStatus === 'function') {
      options.clearGenerationStatus();
    }
  }

  function mount(elements, { onSendMessage, onStopGeneration, onOpenSettings } = {}) {
    dispose();
    cachedElements = elements || {};
    const els = cachedElements;

    if (els.chatForm) {
      const onSubmit = function (e) {
        e.preventDefault();
        if (typeof onSendMessage === 'function') onSendMessage();
      };
      els.chatForm.addEventListener('submit', onSubmit);
      activeCleanupFns.push(() => els.chatForm.removeEventListener('submit', onSubmit));

      const onDragOver = function (e) {
        e.preventDefault();
        els.chatForm.classList.add('drag-over');
      };
      els.chatForm.addEventListener('dragover', onDragOver);
      activeCleanupFns.push(() => els.chatForm.removeEventListener('dragover', onDragOver));

      const onDragLeave = function () {
        els.chatForm.classList.remove('drag-over');
      };
      els.chatForm.addEventListener('dragleave', onDragLeave);
      activeCleanupFns.push(() => els.chatForm.removeEventListener('dragleave', onDragLeave));

      const onDrop = function (e) {
        e.preventDefault();
        els.chatForm.classList.remove('drag-over');
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          processFiles(els, Array.from(e.dataTransfer.files));
        }
      };
      els.chatForm.addEventListener('drop', onDrop);
      activeCleanupFns.push(() => els.chatForm.removeEventListener('drop', onDrop));
    }

    if (els.userInput) {
      const onKeyDown = function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          if (typeof onSendMessage === 'function') onSendMessage();
        }
      };
      els.userInput.addEventListener('keydown', onKeyDown);
      activeCleanupFns.push(() => els.userInput.removeEventListener('keydown', onKeyDown));

      const onInput = function () {
        autoResizeTextarea(els);
      };
      els.userInput.addEventListener('input', onInput);
      activeCleanupFns.push(() => els.userInput.removeEventListener('input', onInput));

      const onPaste = function (e) {
        handlePasteEvent(e, els);
      };
      els.userInput.addEventListener('paste', onPaste);
      activeCleanupFns.push(() => els.userInput.removeEventListener('paste', onPaste));

      const onFocus = function () {
        if (typeof window !== 'undefined' && window.visualViewport) {
          setTimeout(() => {
            if (els.userInput) {
              els.userInput.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }
          }, 300);
        }
      };
      els.userInput.addEventListener('focus', onFocus);
      activeCleanupFns.push(() => els.userInput.removeEventListener('focus', onFocus));
    }

    if (els.btnStopStream) {
      const onStop = function () {
        if (typeof onStopGeneration === 'function') onStopGeneration();
      };
      els.btnStopStream.addEventListener('click', onStop);
      activeCleanupFns.push(() => els.btnStopStream.removeEventListener('click', onStop));
    }

    if (els.btnAttachFile) {
      const onAttach = function () {
        if (els.fileInput && typeof els.fileInput.click === 'function') {
          els.fileInput.click();
        }
      };
      els.btnAttachFile.addEventListener('click', onAttach);
      activeCleanupFns.push(() => els.btnAttachFile.removeEventListener('click', onAttach));
    }

    if (els.fileInput) {
      const onChange = function (e) {
        if (e.target.files && e.target.files.length > 0) {
          processFiles(els, Array.from(e.target.files));
        }
      };
      els.fileInput.addEventListener('change', onChange);
      activeCleanupFns.push(() => els.fileInput.removeEventListener('change', onChange));
    }

    if (els.btnComposerTools) {
      const onTools = function () {
        if (typeof onOpenSettings === 'function') onOpenSettings('tab-agent');
      };
      els.btnComposerTools.addEventListener('click', onTools);
      activeCleanupFns.push(() => els.btnComposerTools.removeEventListener('click', onTools));
    }

    if (els.btnComposerMcp) {
      const onMcp = function () {
        if (typeof onOpenSettings === 'function') onOpenSettings('tab-mcp');
      };
      els.btnComposerMcp.addEventListener('click', onMcp);
      activeCleanupFns.push(() => els.btnComposerMcp.removeEventListener('click', onMcp));
    }

    return {
      autoResizeTextarea: () => autoResizeTextarea(els),
      focusInput: () => focusInput(els),
      clearInput: () => clearInput(els),
      getPromptValue: () => getPromptValue(els),
      setPromptValue: (text) => setPromptValue(els, text),
      renderAttachedFiles: () => renderAttachedFiles(els),
      clearAttachedFiles: () => clearAttachedFiles(els),
      syncGenerationControls: (isGenerating, opts) => syncGenerationControls(els, isGenerating, opts),
      updateComposerMcpState: (st) => updateComposerMcpState(els, st)
    };
  }

  function dispose() {
    activeCleanupFns.forEach(fn => { try { fn(); } catch (_) {} });
    activeCleanupFns = [];
    cachedElements = null;
  }

  return {
    autoResizeTextarea,
    focusInput,
    clearInput,
    getPromptValue,
    setPromptValue,
    renderAttachedFiles,
    clearAttachedFiles,
    readFileAsText,
    processFiles,
    handlePasteEvent,
    updateComposerMcpState,
    syncGenerationControls,
    mount,
    dispose
  };
}));
