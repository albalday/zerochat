/**
 * Módulo de Gestión de Adjuntos (ChatAttachments) para ZeroChat.
 * Gestiona la lista de archivos adjuntos (texto, código, imágenes, PDF, documentos ofimáticos),
 * su renderizado visual en chips y el ensamblado del prompt enriquecido con adjuntos.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./utils.js'), require('./i18n.js'), require('./icons.js'));
  } else {
    root.ChatAttachments = factory(root.ChatUtils, root.ChatI18n, root.ChatIcons);
  }
}(typeof self !== 'undefined' ? self : this, function (Utils, I18n, Icons) {
  'use strict';

  const { resolveDep } = Utils;

  const getState = () => resolveDep('ChatState', './state.js');

  const getFiles = () => getState().get('ui').attachedFiles;
  const setFiles = files => getState().setAttachments([...files]);
  const clearFiles = () => getState().clearAttachments();

  function removeFileAt(index) {
    const files = getFiles();
    if (index >= 0 && index < files.length) {
      files.splice(index, 1);
      setFiles(files);
    }
  }

  function addFile(fileObj) {
    if (fileObj && fileObj.name) {
      const files = getFiles();
      files.push(fileObj);
      setFiles(files);
    }
  }

  function renderChips(container, onRemoveCallback) {

    const files = getFiles();
    if (files.length === 0) {
      container.innerHTML = '';
      container.hidden = true;
      return;
    }

    container.hidden = false;
    container.innerHTML = '';

    files.forEach((file, index) => {
      const chip = document.createElement('div');
      chip.className = 'file-chip';

      const iconName = file.type === 'image' ? 'image' : 'file-text';
      const removeTitle = I18n.t('btn_delete');
      const icon = document.createElement('span');
      icon.className = 'file-chip-icon';
      // Los SVG proceden exclusivamente de Icons.
      Utils.setTrustedHtml(icon, Icons.get(iconName, { size: 14 }));

      const name = document.createElement('span');
      name.className = 'file-chip-name';
      name.textContent = String(file.name || '');
      name.title = String(file.name || '');

      const size = document.createElement('span');
      size.className = 'file-chip-size';
      size.textContent = `(${Utils.formatBytes(file.size)})`;

      const removeButton = document.createElement('button');
      removeButton.type = 'button';
      removeButton.className = 'btn-remove-chip file-chip-remove';
      removeButton.setAttribute('data-index', String(index));
      removeButton.title = String(removeTitle);
      removeButton.setAttribute('aria-label', String(removeTitle));
      Utils.setTrustedHtml(removeButton, Icons.get('close', { size: 12 }));

      removeButton.addEventListener('click', () => {
        removeFileAt(index);
        renderChips(container, onRemoveCallback);
        onRemoveCallback(index);
      });

      chip.appendChild(icon);
      chip.appendChild(name);
      chip.appendChild(size);
      chip.appendChild(removeButton);
      container.appendChild(chip);
    });
  }

  /**
   * Construye el prompt completo y el texto visual a partir del texto del usuario y los adjuntos.
   */
  function buildAttachmentsPayload(rawText = '', files = null) {
    const effectiveFiles = Array.isArray(files) ? files : getFiles();
    let fullPrompt = rawText;
    let displayText = rawText;
    let imageAttachments = [];

    if (effectiveFiles.length > 0) {
      imageAttachments = effectiveFiles.flatMap(f => {
        if (f.type === 'office') return f.images || [];
        return f.type === 'image' && f.dataUrl ? [{ name: f.name, dataUrl: f.dataUrl, mimeType: f.mimeType || 'image/jpeg' }] : [];
      });

      const attachmentsText = effectiveFiles.map(file => {
        if (file.type === 'pdf') {
          return `\n\n--- PDF Document: ${file.name} (${Utils.formatBytes(file.size)}) ---\n\`\`\`text\n${file.content}\n\`\`\``;
        } else if (file.type === 'office') {
          return `\n\n--- ${file.documentKind}: ${file.name} (${Utils.formatBytes(file.size)}) ---\n\`\`\`markdown\n${file.content}\n\`\`\``;
        } else if (file.type === 'image') {
          return `\n\n--- Image: ${file.name} (${Utils.formatBytes(file.size)}) ---`;
        }
        return `\n\n--- File: ${file.name} (${Utils.formatBytes(file.size)}) ---\n\`\`\`\n${file.content}\n\`\`\``;
      }).join('');

      fullPrompt = rawText ? `${rawText}\n${attachmentsText}` : `Attached files for analysis:${attachmentsText}`;

      const fileNamesList = effectiveFiles.map(f => {
        const icon = f.type === 'pdf' ? '📕' : f.type === 'office' ? '📄' : f.type === 'image' ? '🖼️' : '📎';
        return `${icon} ${f.name}`;
      }).join(', ');

      displayText = rawText ? `${rawText}\n\n[${fileNamesList}]` : `[${fileNamesList}]`;
    }

    return {
      fullPrompt,
      displayText,
      imageAttachments
    };
  }

  const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB límite por archivo

  function validateFileSize(file, maxBytes = MAX_FILE_SIZE) {
    if (!file) return { valid: false, reason: 'empty' };
    const size = typeof file.size === 'number' ? file.size : 0;
    if (size > maxBytes) {
      return { valid: false, size, maxBytes, reason: 'too_large' };
    }
    return { valid: true, size, maxBytes };
  }

  return {
    MAX_FILE_SIZE,
    validateFileSize,
    getFiles,
    setFiles,
    clearFiles,
    removeFileAt,
    addFile,
    renderChips,
    buildAttachmentsPayload
  };
}));
