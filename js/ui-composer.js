/**
 * Módulo de Interfaz de Usuario para el Compositor de Mensajes (ZeroChat).
 * Gestiona el formulario del chat, textarea con auto-ajuste de altura,
 * eventos de teclado (Enter / Shift+Enter), portapapeles (imágenes), arrastrar y soltar (drag & drop),
 * renderizado de adjuntos, y sincronización de controles de generación (Enviar / Parar).
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./utils.js'), require('./i18n.js'), require('./icons.js'));
  } else {
    root.ChatUIComposer = factory(root.ChatUtils, root.ChatI18n, root.ChatIcons);
  }
}(typeof self !== 'undefined' ? self : this, function (Utils, I18n, Icons) {
  'use strict';

  const { resolveDep, formatBytes, setTrustedHtml } = Utils;
  const { t } = I18n;

  const getAttachments = () => resolveDep('ChatAttachments', './attachments.js');
  const getFileParser = () => resolveDep('ChatFileParser', './file-parser.js');
  const getDialogs = () => resolveDep('ChatDialogs', './ui-dialogs.js');
  const getGenerationStatus = () => resolveDep('ChatUIGenerationStatus', './ui-generation-status.js');

  const listeners = Utils.createListenerGroup();
  const { listen } = listeners;

  // field-sizing:content ajusta la altura en CSS; esto cubre los navegadores que aún no lo admiten.
  function autoResizeTextarea(elements) {
    if (CSS.supports('field-sizing', 'content')) return;
    const input = elements.userInput;
    if (!input.value) {
      input.style.height = '';
      return;
    }
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  }

  /** Escribe un texto en el compositor y le devuelve el foco, como si lo hubiera tecleado el usuario. */
  function setPromptValue(elements, text) {
    elements.userInput.value = text;
    autoResizeTextarea(elements);
    elements.userInput.focus();
  }

  /** Chip de un adjunto; su botón de quitar lleva el índice que lee el listener delegado de mount(). */
  function createFileChip(file, index) {
    const chip = document.createElement('div');
    chip.className = 'file-chip';

    // Los SVG proceden exclusivamente de Icons.
    const icon = document.createElement('span');
    icon.className = 'file-chip-icon';
    setTrustedHtml(icon, Icons.get(file.type === 'image' ? 'image' : 'file-text', { size: 14 }));

    const name = document.createElement('span');
    name.className = 'file-chip-name';
    name.textContent = file.name;
    name.title = file.name;

    const size = document.createElement('span');
    size.className = 'file-chip-size';
    size.textContent = `(${formatBytes(file.size)})`;

    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'file-chip-remove';
    removeButton.dataset.index = String(index);
    removeButton.title = t('btn_delete');
    removeButton.setAttribute('aria-label', t('btn_delete'));
    setTrustedHtml(removeButton, Icons.get('close', { size: 12 }));

    chip.append(icon, name, size, removeButton);
    return chip;
  }

  function renderAttachedFiles(elements) {
    const files = getAttachments().getFiles();
    elements.attachmentsContainer.replaceChildren(...files.map(createFileChip));
    elements.attachmentsContainer.hidden = files.length === 0;
  }

  function removeAttachedFile(elements, index) {
    getAttachments().removeFileAt(index);
    renderAttachedFiles(elements);
    autoResizeTextarea(elements);
  }

  function clearAttachedFiles(elements) {
    getAttachments().clearFiles();
    renderAttachedFiles(elements);
    elements.fileInput.value = '';
  }

  async function processFiles(elements, files) {
    const Attachments = getAttachments();
    const Dialogs = getDialogs();
    for (const file of files) {
      const check = Attachments.validateFileSize(file);
      if (!check.valid) {
        await Dialogs.alert(t('err_file_too_large', { name: file.name, max: formatBytes(check.maxBytes) }), { type: 'error' });
        continue;
      }
      try {
        Attachments.addFile(await getFileParser().parseFile(file));
      } catch (err) {
        console.error(`Error processing file ${file.name}:`, err);
        await Dialogs.alert(t('err_file_process', { name: file.name, err: err.message || err }), { type: 'error' });
      }
    }
    renderAttachedFiles(elements);
    elements.userInput.focus();
  }

  function handlePasteEvent(event, elements) {
    const images = [...(event.clipboardData?.items || [])]
      .filter(item => item.type.startsWith('image/'))
      .map(item => item.getAsFile())
      .filter(Boolean);
    if (!images.length) return;
    event.preventDefault();
    processFiles(elements, images);
  }

  function syncGenerationControls(elements, isGenerating) {
    elements.btnSend.disabled = isGenerating;
    elements.btnStopStream.hidden = !isGenerating;
    if (!isGenerating) getGenerationStatus().clearStatus(elements.generationStatus);
  }

  function mount(elements, { onSendMessage, onStopGeneration, getLastPrompt }) {
    listeners.dispose();
    const { chatForm, userInput } = elements;

    listen(chatForm, 'submit', event => {
      event.preventDefault();
      onSendMessage();
    });
    listen(chatForm, 'dragover', event => {
      event.preventDefault();
      chatForm.classList.add('drag-over');
    });
    listen(chatForm, 'dragleave', () => chatForm.classList.remove('drag-over'));
    listen(chatForm, 'drop', event => {
      event.preventDefault();
      chatForm.classList.remove('drag-over');
      if (event.dataTransfer?.files.length) processFiles(elements, Array.from(event.dataTransfer.files));
    });

    listen(userInput, 'keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        onSendMessage();
        return;
      }
      const plainArrowUp = event.key === 'ArrowUp' && !event.isComposing && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
      if (!plainArrowUp || userInput.value.trim()) return;
      const lastPrompt = getLastPrompt();
      if (!lastPrompt) return;
      event.preventDefault();
      setPromptValue(elements, lastPrompt);
      userInput.setSelectionRange(lastPrompt.length, lastPrompt.length);
    });
    listen(userInput, 'input', () => autoResizeTextarea(elements));
    listen(userInput, 'paste', event => handlePasteEvent(event, elements));

    listen(elements.attachmentsContainer, 'click', event => {
      const removeButton = event.target.closest('.file-chip-remove');
      if (removeButton) removeAttachedFile(elements, Number(removeButton.dataset.index));
    });
    listen(elements.btnStopStream, 'click', () => onStopGeneration());
    listen(elements.btnAttachFile, 'click', () => elements.fileInput.click());
    listen(elements.fileInput, 'change', event => {
      if (event.target.files.length) processFiles(elements, Array.from(event.target.files));
    });
  }

  return {
    autoResizeTextarea,
    setPromptValue,
    clearAttachedFiles,
    syncGenerationControls,
    mount
  };
}));
