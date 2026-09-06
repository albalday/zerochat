/**
 * Módulo de parseo y renderizado de Markdown (ChatMarkdown) con soporte i18n.
 * Parser directo por bloques (Block Tokenizer).
 * - Soporta bloques de código con cabecera, botón de copia y botón de ejecución JS local.
 * - Soporta bloques de razonamiento <think>...</think> (DeepSeek-R1, QwQ, Ollama).
 * - Soporta listas, código inline, negrita, cursiva, encabezados, citas y enlaces.
 */

(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.ChatMarkdown = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const Sandbox = typeof window !== 'undefined' ? (window.ChatSandbox || {}) : {};
  const I18n = typeof window !== 'undefined' ? (window.ChatI18n || {}) : {};
  const resolvedRagImagesCache = new Map();
  const RAG_IMG_PLACEHOLDER = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"%3E%3C/svg%3E';

  function tr(key, fallback, params) {
    if (typeof window !== 'undefined' && window.ChatI18n && window.ChatI18n.t) {
      return window.ChatI18n.t(key, params);
    }
    if (I18n.t) {
      return I18n.t(key, params);
    }
    return fallback;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  /**
   * Sanitiza URLs para prevenir ataques XSS vía javascript:, data:, vbscript: o URLs maliciosas.
   * @param {string} rawUrl - URL sin procesar
   * @returns {string} - URL segura o '#' si es inválida
   */
  function sanitizeUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '#';
    const trimmed = rawUrl.trim();
    if (/^(?:https?:\/\/|mailto:|tel:)/i.test(trimmed)) {
      return escapeHtml(trimmed);
    }
    return '#';
  }

  /**
   * Sanitiza URLs de imágenes (https, http, data:image, blob) para evitar inyecciones XSS.
   * @param {string} rawUrl - URL de imagen
   * @returns {string} - URL segura o '' si es inválida
   */
  function sanitizeImageUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    const trimmed = rawUrl.trim();
    if (/^https?:\/\/[^\s"'<>]+/i.test(trimmed)) {
      return escapeHtml(trimmed);
    }
    if (/^data:image\/(?:png|jpeg|jpg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=\s\.]+/i.test(trimmed)) {
      return trimmed.replace(/\s+/g, '');
    }
    if (/^blob:[^\s"'<>]+/i.test(trimmed)) {
      return escapeHtml(trimmed);
    }
    if (/^rag-image:\/\/[a-zA-Z0-9_\-:]+/i.test(trimmed)) {
      return escapeHtml(trimmed);
    }
    return '';
  }

  function parseInlineMarkdown(text) {
    if (!text) return '';
    let p = text;
    p = p.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    p = p.replace(/\*\*\*(.*?)\*\*\*/g, '<strong><em>$1</em></strong>');
    p = p.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    p = p.replace(/__(.*?)__/g, '<strong>$1</strong>');
    p = p.replace(/\*([^\*\n]+)\*/g, '<em>$1</em>');
    p = p.replace(/_([^_\n]+)_/g, '<em>$1</em>');
    // Imágenes: ![alt](url)
    p = p.replace(/!\[([^\]]*)\]\(([^)]+)\)/gi, function (match, altText, url) {
      const safeSrc = sanitizeImageUrl(url);
      if (!safeSrc) return altText || '';
      const cleanAlt = escapeHtml(altText ? altText.trim() : 'Imagen');
      if (safeSrc.startsWith('rag-image://')) {
        const cachedUrl = resolvedRagImagesCache.get(safeSrc);
        const displaySrc = cachedUrl || RAG_IMG_PLACEHOLDER;
        const resolvedClass = cachedUrl ? ' rag-resolved-image' : '';
        return `<img class="chat-embedded-image inline-image${resolvedClass}" data-rag-src="${safeSrc}" src="${displaySrc}" alt="${cleanAlt}" loading="lazy" />`;
      }
      return `<img class="chat-embedded-image inline-image" src="${safeSrc}" alt="${cleanAlt}" loading="lazy" />`;
    });
    // Enlaces: [texto](url)
    p = p.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (match, linkText, url) {
      const safeHref = sanitizeUrl(url);
      if (safeHref === '#') return linkText;
      return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer">${linkText}</a>`;
    });
    return p;
  }

  function splitTableRow(rowStr) {
    let raw = rowStr.trim();
    if (raw.startsWith('|')) raw = raw.substring(1);
    if (raw.endsWith('|')) raw = raw.substring(0, raw.length - 1);

    const cells = [];
    let current = '';
    let inBacktick = false;

    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (ch === '`') {
        inBacktick = !inBacktick;
        current += ch;
      } else if (ch === '\\' && i + 1 < raw.length && raw[i + 1] === '|') {
        current += '|';
        i++;
      } else if (ch === '|' && !inBacktick) {
        cells.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    cells.push(current.trim());
    return cells;
  }

  function isTableDelimiterRow(rowStr) {
    const trimmed = rowStr.trim();
    if (!trimmed.includes('-')) return false;
    const cells = splitTableRow(trimmed);
    if (cells.length === 0) return false;
    return cells.every(c => /^:?-+:?$/.test(c.trim()));
  }

  function parseAlignments(delimiterRowStr) {
    const cells = splitTableRow(delimiterRowStr);
    return cells.map(c => {
      const trimmed = c.trim();
      const left = trimmed.startsWith(':');
      const right = trimmed.endsWith(':');
      if (left && right) return 'center';
      if (right) return 'right';
      if (left) return 'left';
      return '';
    });
  }

  function renderTableHtml(headerRow, delimiterRow, bodyRows) {
    const headerCells = splitTableRow(headerRow);
    const aligns = parseAlignments(delimiterRow);
    const numCols = Math.max(headerCells.length, aligns.length);

    let html = '<div class="table-container"><table class="markdown-table"><thead><tr>';

    for (let i = 0; i < numCols; i++) {
      const cellText = headerCells[i] !== undefined ? headerCells[i] : '';
      const align = aligns[i] ? ` style="text-align: ${aligns[i]};"` : '';
      html += `<th${align}>${parseInlineMarkdown(cellText)}</th>`;
    }

    html += '</tr></thead>';

    if (bodyRows && bodyRows.length > 0) {
      html += '<tbody>';
      for (const row of bodyRows) {
        const cells = splitTableRow(row);
        html += '<tr>';
        for (let i = 0; i < numCols; i++) {
          const cellText = cells[i] !== undefined ? cells[i] : '';
          const align = aligns[i] ? ` style="text-align: ${aligns[i]};"` : '';
          html += `<td${align}>${parseInlineMarkdown(cellText)}</td>`;
        }
        html += '</tr>';
      }
      html += '</tbody>';
    }

    html += '</table></div>';
    return html;
  }

  function parseMarkdownTables(text) {
    const lines = text.split('\n');
    const result = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      const nextLine = (i + 1 < lines.length) ? lines[i + 1] : null;

      if (line.includes('|') && nextLine && isTableDelimiterRow(nextLine)) {
        const headerRow = line;
        const delimiterRow = nextLine;
        const bodyRows = [];
        i += 2;

        while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|')) {
          bodyRows.push(lines[i]);
          i++;
        }

        result.push('\n' + renderTableHtml(headerRow, delimiterRow, bodyRows) + '\n');
        continue;
      }

      result.push(line);
      i++;
    }

    return result.join('\n');
  }

  /**
   * Parsea segmentos de texto normales (fuera de bloques de código).
   */
  function parseTextMarkdown(text) {
    if (!text) return '';

    let p = escapeHtml(text);

    // Reglas horizontales (---, ***, ___)
    p = p.replace(/^[ \t]*(?:---|\*\*\*|___)[ \t]*$/gm, '<hr>');

    const thoughtTitle = tr('md_thought_title', '💭 Proceso de razonamiento');
    const thoughtReasoning = tr('md_thought_reasoning', '💭 Razonando...');

    // 1. Bloques de pensamiento <think>...</think>, <thought>...</thought>, <reasoning>...</reasoning>
    p = p.replace(/&lt;(think|thought|reasoning)&gt;([\s\S]*?)&lt;\/\1&gt;/gi, function (match, tag, thought) {
      return `
        <details class="thought-block" open>
          <summary class="thought-summary">
            <span>${thoughtTitle}</span>
          </summary>
          <div class="thought-content">${thought.trim().replace(/\n/g, '<br>')}</div>
        </details>
      `;
    });

    p = p.replace(/&lt;(think|thought|reasoning)&gt;([\s\S]*)$/gi, function (match, tag, thought) {
      return `
        <details class="thought-block" open>
          <summary class="thought-summary">
            <span>${thoughtReasoning}</span>
          </summary>
          <div class="thought-content">${thought.trim().replace(/\n/g, '<br>')}</div>
        </details>
      `;
    });

    // 2. Tablas Markdown (GFM Tables)
    p = parseMarkdownTables(p);

    // 3. Código inline `código`
    p = p.replace(/`([^`\n]+)`/g, function (match, code) {
      return `<code>${code}</code>`;
    });

    // 4. Encabezados (# Titulo)
    p = p.replace(/^### (.*$)/gm, '<h3>$1</h3>');
    p = p.replace(/^## (.*$)/gm, '<h2>$1</h2>');
    p = p.replace(/^# (.*$)/gm, '<h1>$1</h1>');

    // 5. Citas / Blockquotes (> texto)
    p = p.replace(/^> (.*$)/gm, '<blockquote>$1</blockquote>');

    // 6. Listas no ordenadas (- item o * item)
    p = p.replace(/(?:^[ \t]*[*-][ \t]+.+(?:\n|$))+/gm, function (match) {
      const lines = match.trim().split('\n');
      const listItems = lines.map(line => {
        const itemContent = line.replace(/^[ \t]*[*-][ \t]+/, '');
        return `<li>${itemContent}</li>`;
      }).join('');
      return `<ul>${listItems}</ul>\n`;
    });

    // 7. Listas ordenadas (1. item)
    p = p.replace(/(?:^[ \t]*\d+\.[ \t]+.+(?:\n|$))+/gm, function (match) {
      const lines = match.trim().split('\n');
      const listItems = lines.map(line => {
        const itemContent = line.replace(/^[ \t]*\d+\.[ \t]+/, '');
        return `<li>${itemContent}</li>`;
      }).join('');
      return `<ol>${listItems}</ol>\n`;
    });

    // 8. Imágenes Markdown: ![alt](url)
    p = p.replace(/!\[([^\]]*)\]\(([^)]+)\)/gi, function (match, altText, url) {
      const safeSrc = sanitizeImageUrl(url);
      if (!safeSrc) return altText || '';
      const cleanAlt = altText ? escapeHtml(altText.trim()) : 'Imagen';
      const caption = cleanAlt && !cleanAlt.startsWith('#img') ? `<figcaption class="chat-image-caption">${cleanAlt}</figcaption>` : '';
      if (safeSrc.startsWith('rag-image://')) {
        const cachedUrl = resolvedRagImagesCache.get(safeSrc);
        const displaySrc = cachedUrl || RAG_IMG_PLACEHOLDER;
        const resolvedClass = cachedUrl ? ' rag-resolved-image' : '';
        return `\n<figure class="chat-image-figure"><img class="chat-embedded-image${resolvedClass}" data-rag-src="${safeSrc}" src="${displaySrc}" alt="${cleanAlt}" loading="lazy" />${caption}</figure>\n`;
      }
      return `\n<figure class="chat-image-figure"><img class="chat-embedded-image" src="${safeSrc}" alt="${cleanAlt}" loading="lazy" />${caption}</figure>\n`;
    });

    // 10. Enlaces [texto](url)
    p = p.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

    // 11. Negrita y cursiva
    p = p.replace(/\*\*\*(.*?)\*\*\*/g, '<strong><em>$1</em></strong>');
    p = p.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    p = p.replace(/__(.*?)__/g, '<strong>$1</strong>');
    p = p.replace(/\*([^\*\n]+)\*/g, '<em>$1</em>');
    p = p.replace(/(?:^|\s)_([^_<>\n]+)_(?=\s|$|[.,;:!?\)])/g, ' <em>$1</em>');

    // 12. Párrafos y saltos de línea
    const chunks = p.split(/\n{2,}/);
    return chunks.map(chunk => {
      const trimmed = chunk.trim();
      if (!trimmed) return '';
      if (
        trimmed.startsWith('<h1') ||
        trimmed.startsWith('<h2') ||
        trimmed.startsWith('<h3') ||
        trimmed.startsWith('<ul') ||
        trimmed.startsWith('<ol') ||
        trimmed.startsWith('<blockquote') ||
        trimmed.startsWith('<details') ||
        trimmed.startsWith('<figure') ||
        trimmed.startsWith('<hr') ||
        trimmed.startsWith('<div class="table-container"')
      ) {
        return trimmed;
      }
      return `<p>${trimmed.replace(/\n/g, '<br>')}</p>`;
    }).filter(Boolean).join('');
  }

  /**
   * Parser principal de Markdown estructurado por bloques.
   */
  function parseMarkdown(markdown) {
    if (!markdown) return '';

    const normalized = markdown.replace(/\r\n/g, '\n');
    const lines = normalized.split('\n');

    let htmlResult = '';
    let inCodeBlock = false;
    let codeLang = '';
    let codeLines = [];
    let textBuffer = [];

    const runTitle = tr('md_run_js_title', 'Ejecutar en sandbox local (sin red ni archivos)');
    const runBtn = tr('md_run_js_btn', 'Ejecutar JS');
    const copyTitle = tr('md_copy_code_title', 'Copiar código');
    const copyBtn = tr('md_copy_code_btn', 'Copiar');

    function flushTextBuffer() {
      if (textBuffer.length === 0) return;
      htmlResult += parseTextMarkdown(textBuffer.join('\n'));
      textBuffer = [];
    }

    function flushCodeBlock() {
      const rawCode = codeLines.join('\n');
      const safeLang = escapeHtml(codeLang || 'javascript');
      const safeCode = escapeHtml(rawCode);
      const rawCodeAttr = encodeURIComponent(rawCode);
      const isJs = safeLang.toLowerCase() === 'javascript' || safeLang.toLowerCase() === 'js';

      const runButtonHtml = isJs ? `
        <button class="btn-run-code" data-code="${rawCodeAttr}" title="${runTitle}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="5 3 19 12 5 21 5 3"></polygon>
          </svg>
          <span>${runBtn}</span>
        </button>
      ` : '';

      htmlResult += `
        <div class="code-block-container">
          <div class="code-block-header">
            <span class="code-lang">${safeLang}</span>
            <div class="code-block-actions">
              ${runButtonHtml}
              <button class="btn-copy-code" data-code="${rawCodeAttr}" title="${copyTitle}">
                <svg class="icon-copy" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                </svg>
                <span>${copyBtn}</span>
              </button>
            </div>
          </div>
          <pre><code class="language-${safeLang}">${safeCode}</code></pre>
          <div class="code-output-container" style="display: none;"></div>
        </div>
      `;
      codeLines = [];
      codeLang = '';
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const fenceMatch = line.match(/^[ \t]*```([a-zA-Z0-9_+#.-]*)\s*$/);

      if (fenceMatch) {
        if (!inCodeBlock) {
          flushTextBuffer();
          inCodeBlock = true;
          codeLang = fenceMatch[1] ? fenceMatch[1].trim() : '';
          codeLines = [];
        } else {
          flushCodeBlock();
          inCodeBlock = false;
        }
      } else if (inCodeBlock) {
        codeLines.push(line);
      } else {
        textBuffer.push(line);
      }
    }

    if (inCodeBlock) {
      flushCodeBlock();
    } else {
      flushTextBuffer();
    }

    return htmlResult;
  }

  function attachCopyCodeListeners(container) {
    if (!container) return;

    // 1. Botones de copiar código
    container.querySelectorAll('.btn-copy-code').forEach(function (button) {
      if (button.dataset.listenerAttached) return;
      button.dataset.listenerAttached = 'true';

      button.addEventListener('click', async function () {
        const rawCode = decodeURIComponent(button.getAttribute('data-code') || '');
        try {
          await navigator.clipboard.writeText(rawCode);
          const span = button.querySelector('span');
          const originalText = span.textContent;
          span.textContent = tr('copied_text', '¡Copiado!');
          button.classList.add('copied');

          setTimeout(function () {
            span.textContent = originalText;
            button.classList.remove('copied');
          }, 2000);
        } catch (err) {
          console.error('Error al copiar al portapapeles:', err);
        }
      });
    });

    // 2. Botones de ejecución local de JavaScript
    container.querySelectorAll('.btn-run-code').forEach(function (button) {
      if (button.dataset.listenerAttached) return;
      button.dataset.listenerAttached = 'true';

      button.addEventListener('click', async function () {
        const rawCode = decodeURIComponent(button.getAttribute('data-code') || '');
        const blockContainer = button.closest('.code-block-container');
        if (!blockContainer) return;

        let outputContainer = blockContainer.querySelector('.code-output-container');
        if (!outputContainer) {
          outputContainer = document.createElement('div');
          outputContainer.className = 'code-output-container';
          blockContainer.appendChild(outputContainer);
        }

        outputContainer.style.display = 'block';
        outputContainer.innerHTML = '<div class="output-header"><span>' + tr('agent_js_title', 'Ejecutando en sandbox local...') + '</span></div>';

        const sandboxRunner = window.ChatSandbox || Sandbox;
        if (sandboxRunner && sandboxRunner.execute) {
          const res = await sandboxRunner.execute(rawCode);
          const statusClass = res.success ? 'success' : 'error';
          const headerTitle = res.success ? `${tr('md_output_title', 'Resultado')} (${res.executionTimeMs}ms)` : `Error (${res.executionTimeMs}ms)`;

          let outputContent = '';
          if (res.logs && res.logs.length > 0) {
            outputContent += `<div class="output-logs"><strong>Console:</strong>\n${escapeHtml(res.logs.join('\n'))}</div>`;
          }
          if (res.result && res.result !== 'undefined') {
            outputContent += `<div class="output-return"><strong>Retorno:</strong> ${escapeHtml(res.result)}</div>`;
          }
          if (res.error) {
            outputContent += `<div class="output-error">${escapeHtml(res.error)}</div>`;
          }
          if (!outputContent) {
            outputContent = `<div class="output-empty">(${tr('empty_response', 'Ejecutado sin salida de consola ni retorno')})</div>`;
          }

          outputContainer.innerHTML = `
            <div class="output-header ${statusClass}">
              <span>${headerTitle}</span>
              <button type="button" class="btn-close-output" title="${tr('md_clear_output', 'Cerrar salida')}">×</button>
            </div>
            <pre class="output-body">${outputContent}</pre>
          `;

          outputContainer.querySelector('.btn-close-output').addEventListener('click', () => {
            outputContainer.style.display = 'none';
          });
        }
      });
    });

    // 3. Botones y cabeceras de colapsar / minimizar tarjetas de herramientas
    container.querySelectorAll('.tool-card-header, .web-card-header, .search-card-header, .chat-chart-header, .btn-tool-collapse').forEach(function (el) {
      if (el.dataset.collapseInit) return;
      el.dataset.collapseInit = 'true';
      el.addEventListener('click', function (e) {
        if (e.target.closest('a')) return;
        if (el.classList.contains('btn-tool-collapse')) {
          e.stopPropagation();
        }
        const card = el.closest('.tool-execution-card, .web-request-card, .web-search-card, .chat-chart-card');
        if (!card) return;
        const isCollapsed = card.classList.toggle('collapsed');
        const btn = card.querySelector('.btn-tool-collapse');
        if (btn) {
          btn.title = isCollapsed ? tr('tool_btn_expand', 'Expandir herramienta') : tr('tool_btn_collapse', 'Minimizar herramienta');
          const span = btn.querySelector('span');
          if (span) span.textContent = isCollapsed ? '▸' : '▾';
        }
      });
    });

    // 4. Resolución de imágenes de la base de conocimiento (rag-image://docId:imgId)
    container.querySelectorAll('img[data-rag-src], img[src^="rag-image://"]').forEach(async function (img) {
      const rawRef = img.getAttribute('data-rag-src') || img.getAttribute('src') || '';
      if (!rawRef || !rawRef.startsWith('rag-image://')) return;

      if (resolvedRagImagesCache.has(rawRef)) {
        const cached = resolvedRagImagesCache.get(rawRef);
        if (img.getAttribute('src') !== cached) {
          img.setAttribute('src', cached);
        }
        img.classList.add('rag-resolved-image');
        return;
      }

      if (img.dataset.ragResolving) return;
      img.dataset.ragResolving = 'true';

      const cleanRef = rawRef.replace(/^rag-image:\/\//i, '');
      const colonIdx = cleanRef.indexOf(':');
      if (colonIdx > 0) {
        const docId = cleanRef.substring(0, colonIdx);
        const imgId = cleanRef.substring(colonIdx + 1);
        const ragStorage = (typeof window !== 'undefined' && window.ChatRagStorage)
          ? window.ChatRagStorage
          : (typeof require !== 'undefined' ? (() => { try { return require('./ragStorage.js'); } catch (e) { return null; } })() : null);
        if (ragStorage && typeof ragStorage.getDocumentImage === 'function') {
          try {
            const imageRecord = await ragStorage.getDocumentImage(docId, imgId);
            if (imageRecord && imageRecord.dataUrl) {
              let finalUrl = imageRecord.dataUrl;
              const fileParser = (typeof window !== 'undefined' && window.ChatFileParser)
                ? window.ChatFileParser
                : (typeof require !== 'undefined' ? (() => { try { return require('./file-parser.js'); } catch (e) { return null; } })() : null);
              if (fileParser && typeof fileParser.convertCmykDataUrlToRgb === 'function') {
                finalUrl = fileParser.convertCmykDataUrlToRgb(finalUrl);
                imageRecord.dataUrl = finalUrl;
                imageRecord.isCmyk = false;
              }
              resolvedRagImagesCache.set(rawRef, finalUrl);
              img.setAttribute('src', finalUrl);
              img.classList.add('rag-resolved-image');
            }
          } catch (e) {
            console.error('Error al resolver imagen RAG:', e);
          } finally {
            delete img.dataset.ragResolving;
          }
        }
      }
    });

  }

  return {
    escapeHtml,
    sanitizeUrl,
    sanitizeImageUrl,
    parseMarkdown,
    renderMarkdown: parseMarkdown,
    attachCopyCodeListeners
  };
});
