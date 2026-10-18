/**
 * Módulo de parseo y renderizado de Markdown (ChatMarkdown) con soporte i18n.
 * Parser directo por bloques (Block Tokenizer).
 * - Soporta bloques de código con cabecera, botón de copia y botón de ejecución JS local.
 * - Soporta bloques de razonamiento <think>...</think> (DeepSeek-R1, QwQ, Ollama).
 * - Soporta listas, código inline, negrita, cursiva, encabezados, citas y enlaces.
 */

(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./utils.js'), require('./i18n.js'), require('./icons.js'));
  } else {
    root.ChatMarkdown = factory(root.ChatUtils, root.ChatI18n, root.ChatIcons);
  }
})(typeof self !== 'undefined' ? self : this, function (Utils, I18n, Icons) {
  'use strict';

  const resolvedRagImagesCache = new Map();
  const RAG_IMG_PLACEHOLDER = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"%3E%3C/svg%3E';

  const { escapeHtml, sanitizeUrl, sanitizeImageUrl, resolveDep } = Utils;
  // Las URL de imagen se validan sobre texto ya escapado (parseTextMarkdown), así que
  // el valor de sanitizeImageUrl puede interpolarse en atributos sin escaparlo de nuevo.

  // El código en línea se aparta antes de las tablas y las demás reglas para que |, *, _,
  // enlaces o imágenes dentro de él se muestren literales; se restaura al terminar.
  const CODE_PLACEHOLDER = /\u0000(\d+)\u0000/g;

  function protectInlineCode(text, codes) {
    return text.replace(/`([^`\n]+)`/g, function (match, code) {
      codes.push(`<code>${code}</code>`);
      return `\u0000${codes.length - 1}\u0000`;
    });
  }

  function restoreInlineCode(html, codes) {
    return codes.length ? html.replace(CODE_PLACEHOLDER, (match, index) => codes[Number(index)] || '') : html;
  }

  // Celdas de tabla: su código en línea ya lo apartó parseTextMarkdown.
  /**
   * Imagen Markdown: en línea (celdas de tabla) o como figura con su pie. Las rag-image:// se
   * muestran con un marcador hasta que attachContentListeners las carga.
   */
  function renderImage(altText, url, inline) {
    const safeSrc = sanitizeImageUrl(url);
    if (!safeSrc) return altText || '';
    const alt = altText?.trim() || I18n.t('md_image_alt');
    const isRag = safeSrc.startsWith('rag-image://');
    const cachedUrl = isRag ? resolvedRagImagesCache.get(safeSrc) : null;
    const classes = ['chat-embedded-image', inline ? 'inline-image' : '', cachedUrl ? 'rag-resolved-image' : ''].filter(Boolean).join(' ');
    const source = isRag ? `data-rag-src="${safeSrc}" src="${cachedUrl || RAG_IMG_PLACEHOLDER}"` : `src="${safeSrc}"`;
    const title = altText?.trim() ? `${altText.trim()} — ${I18n.t('image_open_tab')}` : I18n.t('image_open_tab');
    const img = `<img class="${classes}" ${source} alt="${escapeHtml(alt)}" title="${escapeHtml(title)}" loading="lazy" />`;
    if (inline) return img;
    const caption = altText && !altText.trim().startsWith('#img') ? `<figcaption class="chat-image-caption">${escapeHtml(altText.trim())}</figcaption>` : '';
    return `\n<figure class="chat-image-figure">${img}${caption}</figure>\n`;
  }

  function parseInlineMarkdown(text) {
    if (!text) return '';
    let p = text;
    p = p.replace(/\*\*\*(.*?)\*\*\*/g, '<strong><em>$1</em></strong>');
    p = p.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    p = p.replace(/__(.*?)__/g, '<strong>$1</strong>');
    p = p.replace(/\*([^\*\n]+)\*/g, '<em>$1</em>');
    p = p.replace(/_([^_\n]+)_/g, '<em>$1</em>');
    // Imágenes: ![alt](url)
    p = p.replace(/!\[([^\]]*)\]\(([^)]+)\)/gi, (match, altText, url) => renderImage(altText, url, true));
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

  function tableToCsv(tableElement) {
    if (!tableElement) return '';
    const rows = [];
    tableElement.querySelectorAll('tr').forEach(tr => {
      const row = [];
      tr.querySelectorAll('th, td').forEach(cell => {
        const text = (cell.innerText || cell.textContent || '').trim();
        if (text.includes('"') || text.includes(',') || text.includes('\n') || text.includes('\r')) {
          row.push(`"${text.replace(/"/g, '""')}"`);
        } else {
          row.push(text);
        }
      });
      if (row.length > 0) {
        rows.push(row.join(','));
      }
    });
    return rows.join('\r\n');
  }

  function renderTableHtml(headerRow, delimiterRow, bodyRows) {
    const headerCells = splitTableRow(headerRow);
    const aligns = parseAlignments(delimiterRow);
    const numCols = Math.max(headerCells.length, aligns.length);

    const tableTitle = I18n.t('md_table_title');
    const copyTitle = I18n.t('md_copy_table_csv_title');
    const copyBtn = I18n.t('md_copy_table_csv_btn');
    const exportTitle = I18n.t('md_export_table_csv_title');
    const exportBtn = I18n.t('md_export_table_csv_btn');

    let html = `<div class="table-container"><div class="table-header"><span class="table-title">${Icons.get('file-text', { size: 13, className: 'icon-table' })}<span>${tableTitle}</span></span><div class="table-actions"><button class="btn-copy-table-csv" title="${copyTitle}">${Icons.get('copy', { size: 13, className: 'icon-copy' })}<span>${copyBtn}</span></button><button class="btn-export-table-csv" title="${exportTitle}">${Icons.get('download', { size: 13, className: 'icon-download' })}<span>${exportBtn}</span></button></div></div><div class="table-scroll-wrapper"><table class="markdown-table"><thead><tr>`;

    for (let i = 0; i < numCols; i++) {
      const cellText = headerCells[i] !== undefined ? headerCells[i] : '';
      const align = aligns[i] ? ` class="align-${aligns[i]}"` : '';
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
          const align = aligns[i] ? ` class="align-${aligns[i]}"` : '';
          html += `<td${align}>${parseInlineMarkdown(cellText)}</td>`;
        }
        html += '</tr>';
      }
      html += '</tbody>';
    }

    html += '</table></div></div>';
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

  const LATEX_MATH_SYMBOLS = Object.freeze({
    // Flechas
    rightarrow: '→',
    to: '→',
    leftarrow: '←',
    gets: '←',
    Rightarrow: '⇒',
    implies: '⇒',
    Leftarrow: '⇐',
    leftrightarrow: '\u2194',
    iff: '⇔',
    uparrow: '↑',
    downarrow: '↓',
    nearrow: '\u2197',
    searrow: '\u2198',
    mapsto: '↦',

    // Comparacion y relaciones
    le: '≤',
    leq: '≤',
    ge: '≥',
    geq: '≥',
    ne: '≠',
    neq: '≠',
    approx: '≈',
    sim: '∼',
    simeq: '≃',
    equiv: '≡',
    cong: '≅',
    propto: '∝',
    ll: '≪',
    gg: '≫',

    // Operaciones aritmeticas y algebra
    times: '×',
    div: '÷',
    pm: '±',
    mp: '∓',
    cdot: '·',
    circ: '∘',
    bullet: '•',
    star: '★',
    ast: '∗',

    // Logica y teoria de conjuntos
    in: '∈',
    notin: '∉',
    ni: '∋',
    subset: '⊂',
    subseteq: '⊆',
    supset: '⊃',
    supseteq: '⊇',
    cap: '∩',
    cup: '∪',
    setminus: '∖',
    emptyset: '∅',
    forall: '∀',
    exists: '∃',
    nexists: '∄',
    land: '∧',
    lor: '∨',
    neg: '¬',
    lnot: '¬',
    top: '⊤',
    bot: '⊥',

    // Calculo y miscelanea
    infty: '∞',
    partial: '∂',
    nabla: '∇',
    sum: '∑',
    prod: '∏',
    int: '∫',
    oint: '∮',
    angle: '∠',
    perp: '⊥',
    parallel: '∥',
    ldots: '…',
    cdots: '…',
    dots: '…',

    // Letras griegas minusculas
    alpha: 'α',
    beta: 'β',
    gamma: 'γ',
    delta: 'δ',
    epsilon: 'ε',
    varepsilon: 'ε',
    zeta: 'ζ',
    eta: 'η',
    theta: 'θ',
    vartheta: 'ϑ',
    iota: 'ι',
    kappa: 'κ',
    lambda: 'λ',
    mu: 'μ',
    nu: 'ν',
    xi: 'ξ',
    pi: 'π',
    varpi: 'ϖ',
    rho: 'ρ',
    varrho: 'ϱ',
    sigma: 'σ',
    varsigma: 'ς',
    tau: 'τ',
    upsilon: 'υ',
    phi: 'φ',
    varphi: 'ϕ',
    chi: 'χ',
    psi: 'ψ',
    omega: 'ω',

    // Letras griegas mayusculas
    Gamma: 'Γ',
    Delta: 'Δ',
    Theta: 'Θ',
    Lambda: 'Λ',
    Xi: 'Ξ',
    Pi: 'Π',
    Sigma: 'Σ',
    Upsilon: 'Υ',
    Phi: 'Φ',
    Psi: 'Ψ',
    Omega: 'Ω'
  });

  const SUPERSCRIPT_MAP = Object.freeze({
    '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
    '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
    '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾',
    'n': 'ⁿ', 'i': 'ⁱ'
  });

  const SUBSCRIPT_MAP = Object.freeze({
    '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄',
    '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',
    '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎',
    'a': 'ₐ', 'e': 'ₑ', 'o': 'ₒ', 'x': 'ₓ', 'i': 'ᵢ',
    'j': 'ⱼ', 'n': 'ₙ'
  });

  /**
   * Normaliza una expresión matemática a texto limpio con símbolos Unicode.
   */
  function normalizeMathContent(content) {
    let p = content;

    // 1. Comandos de formato habituales
    p = p.replace(/\\(?:text|mathrm|mathbf|mathit|boldsymbol)\s*\{([^}]+)\}/g, '$1');
    p = p.replace(/\\frac\s*\{([^}]+)\}\s*\{([^}]+)\}/g, (match, n, d) => {
      const num = n.trim();
      const den = d.trim();
      const parenN = /[+\-\s]/.test(num);
      const parenD = /[+\-\s]/.test(den);
      return `${parenN ? `(${num})` : num}/${parenD ? `(${den})` : den}`;
    });
    p = p.replace(/\\sqrt\s*\[([^\]]+)\]\s*\{([^}]+)\}/g, '^$1√($2)');
    p = p.replace(/\\sqrt\s*\{([^}]+)\}/g, '√($1)');
    p = p.replace(/\\sqrt\b/g, '√');

    // 2. Espaciado y llaves LaTeX
    p = p.replace(/\\(?:quad|qquad)/g, '  ');
    p = p.replace(/\\[,;:]/g, ' ');
    p = p.replace(/\\!/g, '');
    p = p.replace(/\\\{/g, '{').replace(/\\\}/g, '}');

    // 3. Mapeo de símbolos matemáticos y letras griegas
    p = p.replace(/\\([A-Za-z]+)(?:\{\})?/g, (match, name) => {
      return Object.prototype.hasOwnProperty.call(LATEX_MATH_SYMBOLS, name)
        ? LATEX_MATH_SYMBOLS[name]
        : match;
    });

    // 4. Superíndices y subíndices matemáticos seguros
    p = p.replace(/(?<=[a-zA-Z0-9\)])\^\{([0-9+\-ni()]+)\}/g, (match, inner) => {
      return inner.split('').map(c => SUPERSCRIPT_MAP[c] || c).join('');
    });
    p = p.replace(/(?<=[a-zA-Z0-9\)])_\{([0-9+\-aeoxijn()]+)\}/g, (match, inner) => {
      return inner.split('').map(c => SUBSCRIPT_MAP[c] || c).join('');
    });
    p = p.replace(/(?<=[a-zA-Z0-9\)])\^([0-9ni])/g, (match, c) => SUPERSCRIPT_MAP[c] || match);

    return p;
  }

  function isMathContent(inner) {
    const trimmed = inner.trim();
    if (!trimmed) return false;
    if (/^[\d.,\s\-+/%]+$/.test(trimmed)) return false;
    if (trimmed.includes('\\') || trimmed.includes('^') || trimmed.includes('_')) return true;
    if (/[=<>≈≠≤≥±×÷√]/.test(trimmed)) return true;
    if (/^[a-zA-Z]$/.test(trimmed)) return true;
    return false;
  }

  /**
   * Normaliza sintaxis LaTeX matemática estrictamente dentro de delimitadores matemáticos
   * ($...$, $$...$$, \(...\), \[...\]) a texto limpio con símbolos Unicode.
   */
  function normalizeMathNotation(text) {
    if (!text || (!text.includes('\\') && !text.includes('$'))) {
      return text;
    }

    let p = text;

    // 1. Delimitadores de bloque: $$...$$ y \[...\]
    p = p.replace(/\$\$([\s\S]*?)\$\$/g, (match, inner) => normalizeMathContent(inner));
    p = p.replace(/\\\[([\s\S]*?)\\\]/g, (match, inner) => normalizeMathContent(inner));

    // 2. Delimitadores inline LaTeX: \(...\)
    p = p.replace(/\\\(([\s\S]*?)\\\)/g, (match, inner) => normalizeMathContent(inner));

    // 3. Delimitadores inline $: $...$
    // Cierra solo cuando no va seguido inmediatamente de un dígito (?!\d) para preservar precios ($50, $5/$10, $10-$20)
    p = p.replace(/(?<!\\)\$([^\s$](?:[^$\n]*?[^\s$])?)\$(?!\d)/g, (match, inner) => {
      if (isMathContent(inner)) {
        return normalizeMathContent(inner);
      }
      return match;
    });

    return p;
  }

  /**
   * Parsea segmentos de texto normales (fuera de bloques de código).
   */
  function parseTextMarkdown(text) {
    if (!text) return '';

    let p = escapeHtml(text).replace(/\u0000/g, '');
    const codes = [];

    // Reglas horizontales (---, ***, ___)
    p = p.replace(/^[ \t]*(?:---|\*\*\*|___)[ \t]*$/gm, '<hr>');

  const thoughtTitle = I18n.t('md_thought_title');
  const thoughtReasoning = I18n.t('md_thought_reasoning');

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

    // 2. Código inline `código`
    p = protectInlineCode(p, codes);

    // 2b. Normalización de notación matemática y LaTeX a Unicode fuera de código inline
    p = normalizeMathNotation(p);

    // 3. Tablas Markdown (GFM Tables)
    p = parseMarkdownTables(p);

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
    p = p.replace(/!\[([^\]]*)\]\(([^)]+)\)/gi, (match, altText, url) => renderImage(altText, url, false));

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
    return restoreInlineCode(chunks.map(chunk => {
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
    }).filter(Boolean).join(''), codes);
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

    const copyTitle = I18n.t('md_copy_code_title');
    const copyBtn = I18n.t('md_copy_code_btn');

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

      const trimmedLang = (codeLang || '').trim().toLowerCase();
      const isPreviewable = /^(html|htm|svg)$/i.test(trimmedLang);
      const previewTitle = I18n.t('md_preview_code_title');
      const previewBtn = I18n.t('md_preview_code_btn');

      const previewActionHtml = isPreviewable
        ? `<button class="btn-preview-code" data-code="${rawCodeAttr}" data-lang="${escapeHtml(trimmedLang)}" title="${previewTitle}">
            ${Icons.get('external-link', { size: 13, className: 'icon-preview' })}
            <span>${previewBtn}</span>
          </button>`
        : '';

      htmlResult += `
        <div class="code-block-container">
          <div class="code-block-header">
            <span class="code-lang">${safeLang}</span>
            <div class="code-block-actions">
              ${previewActionHtml}
              <button class="btn-copy-code" data-code="${rawCodeAttr}" title="${copyTitle}">
                ${Icons.get('copy', { size: 13, className: 'icon-copy' })}
                <span>${copyBtn}</span>
              </button>
            </div>
          </div>
          <pre><code class="language-${safeLang}">${safeCode}</code></pre>
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

  function bindCopyButtons(container) {
    container.querySelectorAll('.btn-copy-code:not([data-listener-attached])').forEach(button => {
      button.dataset.listenerAttached = 'true';
      button.addEventListener('click', () => {
        const feedback = `${Icons.get('check', { size: 13, className: 'icon-copy' })}<span>${escapeHtml(I18n.t('copied_text'))}</span>`;
        Utils.copyToClipboard(decodeURIComponent(button.dataset.code || ''), button, feedback);
      });
    });
  }

  function bindPreviewButtons(container) {
    container.querySelectorAll('.btn-preview-code:not([data-listener-attached])').forEach(button => {
      button.dataset.listenerAttached = 'true';
      button.addEventListener('click', () => {
        const rawCode = decodeURIComponent(button.dataset.code || '');
        const lang = (button.dataset.lang || 'html').toLowerCase();
        const mimeType = lang === 'svg' ? 'image/svg+xml;charset=utf-8' : 'text/html;charset=utf-8';
        Utils.openDocumentInNewTab(rawCode, mimeType);
      });
    });
  }

  /**
   * Desplaza la lista de mensajes lo justo para ver la tarjeta recién desplegada; si no cabe,
   * deja visible su cabecera.
   */
  function revealExpandedCard(card) {
    const messagesList = card.closest('#messages-list');
    if (!messagesList) return;
    const cardRect = card.getBoundingClientRect();
    const listRect = messagesList.getBoundingClientRect();
    const margin = 16;
    const overflow = Math.min(cardRect.bottom - listRect.bottom + margin, cardRect.top - listRect.top - margin);
    if (overflow <= 0) return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    messagesList.scrollTo({ top: messagesList.scrollTop + overflow, behavior: reducedMotion ? 'auto' : 'smooth' });
  }

  /** Pliega y despliega las tarjetas de herramientas y gráficos desde su cabecera o su botón. */
  function bindCollapsibleCards(container) {
    container.querySelectorAll('.tool-card-header:not([data-collapse-init]), .chat-chart-header:not([data-collapse-init]), .btn-tool-collapse:not([data-collapse-init])').forEach(el => {
      el.dataset.collapseInit = 'true';
      el.addEventListener('click', event => {
        if (event.target.closest('a')) return;
        if (el.classList.contains('btn-tool-collapse')) event.stopPropagation();
        const card = el.closest('.tool-execution-card, .chat-chart-card');
        if (!card) return;
        const isCollapsed = card.classList.toggle('collapsed');
        const btn = card.querySelector('.btn-tool-collapse');
        if (btn) btn.title = I18n.t(isCollapsed ? 'tool_btn_expand' : 'tool_btn_collapse');
        if (!isCollapsed) revealExpandedCard(card);
      });
    });
  }

  /** Imagen rag-image://docId:imgId guardada en la base de conocimiento, como data URL; null si no existe. */
  async function loadRagImage(ref) {
    if (resolvedRagImagesCache.has(ref)) return resolvedRagImagesCache.get(ref);
    const reference = Utils.parseRagImageRef(ref);
    if (!reference) return null;
    const imageRecord = await resolveDep('ChatRagStorage', './ragStorage.js').getDocumentImage(reference.documentId, reference.imageId);
    if (!imageRecord?.dataUrl) return null;
    const finalUrl = await resolveDep('ChatFileParser', './file-parser.js').convertCmykDataUrlToRgb(imageRecord.dataUrl);
    resolvedRagImagesCache.set(ref, finalUrl);
    return finalUrl;
  }

  /** Sustituye las imágenes rag-image://docId:imgId por la imagen guardada en la base de conocimiento. */
  function resolveRagImages(container) {
    container.querySelectorAll('img[data-rag-src]').forEach(async img => {
      if (img.dataset.ragResolving) return;
      img.dataset.ragResolving = 'true';
      try {
        const finalUrl = await loadRagImage(img.dataset.ragSrc);
        if (!finalUrl) return;
        img.src = finalUrl;
        img.classList.add('rag-resolved-image');
      } catch (error) {
        console.error('[ChatMarkdown] Could not resolve a knowledge image:', error);
      } finally {
        delete img.dataset.ragResolving;
      }
    });
  }

  /** Permite pulsar cualquier imagen embebida en la conversación para verla a tamaño completo en nueva pestaña. */
  function bindImagePreview(container) {
    container.querySelectorAll('img.chat-embedded-image:not([data-preview-init])').forEach(img => {
      img.dataset.previewInit = 'true';
      Utils.makeImageOpenable(img, () => img.currentSrc || img.getAttribute('src'));
    });
  }

  function bindTableActions(container) {
    container.querySelectorAll('.btn-copy-table-csv:not([data-listener-attached])').forEach(button => {
      button.dataset.listenerAttached = 'true';
      button.addEventListener('click', () => {
        const tableContainer = button.closest('.table-container');
        const table = tableContainer?.querySelector('.markdown-table');
        if (!table) return;
        const csv = tableToCsv(table);
        const feedback = `${Icons.get('check', { size: 13, className: 'icon-copy' })}<span>${escapeHtml(I18n.t('md_table_copied'))}</span>`;
        Utils.copyToClipboard(csv, button, feedback);
      });
    });

    container.querySelectorAll('.btn-export-table-csv:not([data-listener-attached])').forEach(button => {
      button.dataset.listenerAttached = 'true';
      button.addEventListener('click', () => {
        const tableContainer = button.closest('.table-container');
        const table = tableContainer?.querySelector('.markdown-table');
        if (!table) return;
        const csv = tableToCsv(table);
        resolveDep('ChatExport', './export.js').downloadFile(csv, 'tabla.csv', 'text/csv;charset=utf-8');
      });
    });
  }

  /**
   * Activa el contenido generado por parseMarkdown y las tarjetas de herramientas: copiar y
   * ejecutar código, plegar tarjetas y cargar las imágenes de la base de conocimiento. Es seguro
   * llamarla varias veces sobre el mismo contenedor.
   */
  function attachContentListeners(container) {
    bindCopyButtons(container);
    bindPreviewButtons(container);
    bindTableActions(container);
    bindCollapsibleCards(container);
    resolveRagImages(container);
    bindImagePreview(container);
  }

  return {
    escapeHtml,
    sanitizeUrl,
    sanitizeImageUrl,
    parseMarkdown,
    loadRagImage,
    attachContentListeners
  };
});
