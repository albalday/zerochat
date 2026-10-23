/**
 * Módulo de Gestión de Adjuntos (ChatAttachments) para ZeroChat.
 * Gestiona la lista de archivos adjuntos (texto, código, imágenes, PDF, documentos ofimáticos),
 * su validación de tamaño y el ensamblado del prompt enriquecido con adjuntos. Sus chips los pinta
 * ChatUIComposer.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./utils.js'));
  } else {
    root.ChatAttachments = factory(root.ChatUtils);
  }
}(typeof self !== 'undefined' ? self : this, function (Utils) {
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
        if (file.type === 'image') return `\n\n--- Image: ${file.name} (${Utils.formatBytes(file.size)}) ---`;
        const { label, lang } = file.type === 'pdf' ? { label: 'PDF Document', lang: 'text' }
          : file.type === 'office' ? { label: file.documentKind, lang: 'markdown' }
          : { label: 'File', lang: '' };
        return `\n\n--- ${label}: ${file.name} (${Utils.formatBytes(file.size)}) ---\n\`\`\`${lang}\n${file.content}\n\`\`\``;
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
    clearFiles,
    removeFileAt,
    addFile,
    buildAttachmentsPayload
  };
}));
