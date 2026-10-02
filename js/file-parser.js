/**
 * Módulo de procesamiento y extracción de contenido de archivos (ChatFileParser).
 * Compatible con file:// y http:// sin dependencias externas.
 * Soporta:
 * - Documentos PDF (extracción y descompresión de texto en streams FlateDecode y objetos BT/ET).
 * - Archivos de código y texto plano (.txt, .md, .js, .py, .html, .css, .json, .csv, etc.).
 * - Imágenes (.png, .jpg, .jpeg, .webp, .gif, .svg).
 */

(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.ChatFileParser = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  function isPdfDelimiterOrWs(charCode) {
    return charCode <= 32 || charCode === 40 || charCode === 41 || charCode === 60 || 
           charCode === 62 || charCode === 91 || charCode === 93 || charCode === 47 || charCode === 37;
  }

  function decodePdfEscapes(str) {
    if (!str) return '';
    return str.replace(/\\([0-7]{1,3})/g, (m, oct) => {
      const code = parseInt(oct, 8);
      return String.fromCharCode(code);
    }).replace(/\\([nrtbf\\()])/g, (m, esc) => {
      switch (esc) {
        case 'n': return '\n';
        case 'r': return '\r';
        case 't': return '\t';
        case 'b': return '\b';
        case 'f': return '\f';
        default: return esc;
      }
    });
  }

  function parseCMapData(text, cmap) {
    if (!text || typeof text !== 'string') return;

    // 1. Extraer bloques beginbfchar ... endbfchar
    const bfcharBlockRegex = /beginbfchar([\s\S]*?)endbfchar/g;
    let block;
    while ((block = bfcharBlockRegex.exec(text)) !== null) {
      const blockText = block[1];
      const bfcharRegex = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g;
      let cm;
      while ((cm = bfcharRegex.exec(blockText)) !== null) {
        const src = cm[1].toLowerCase();
        const dstHex = cm[2];
        let dstChar = '';
        for (let k = 0; k < dstHex.length; k += 4) {
          const code = parseInt(dstHex.slice(k, k + 4), 16);
          if (!isNaN(code)) dstChar += String.fromCharCode(code);
        }
        if (dstChar) {
          cmap.set(src, dstChar);
          if (src.length === 2) cmap.set('00' + src, dstChar);
        }
      }
    }

    // 2. Extraer bloques beginbfrange ... endbfrange
    const bfrangeBlockRegex = /beginbfrange([\s\S]*?)endbfrange/g;
    while ((block = bfrangeBlockRegex.exec(text)) !== null) {
      const blockText = block[1];

      // 2a. beginbfrange con array de destinos: <start> <end> [ <dest1> <dest2> ... ]
      const bfrangeArrayRegex = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\[([\s\S]*?)\]/g;
      let cm;
      while ((cm = bfrangeArrayRegex.exec(blockText)) !== null) {
        const start = parseInt(cm[1], 16);
        const end = parseInt(cm[2], 16);
        const len = cm[1].length;
        const destMatches = cm[3].match(/<([0-9a-fA-F]+)>/g) || [];
        for (let s = start, idx = 0; s <= end && idx < destMatches.length; s++, idx++) {
          const srcHex = s.toString(16).padStart(len, '0').toLowerCase();
          const dstHex = destMatches[idx].replace(/[<>]/g, '');
          let dstChar = '';
          for (let k = 0; k < dstHex.length; k += 4) {
            const code = parseInt(dstHex.slice(k, k + 4), 16);
            if (!isNaN(code)) dstChar += String.fromCharCode(code);
          }
          if (dstChar) {
            cmap.set(srcHex, dstChar);
            if (srcHex.length === 2) cmap.set('00' + srcHex, dstChar);
          }
        }
      }

      // 2b. beginbfrange con destino simple: <start> <end> <destStart>
      const cleanBlockText = blockText.replace(/<[0-9a-fA-F]+>\s*<[0-9a-fA-F]+>\s*\[[\s\S]*?\]/g, '');
      const bfrangeSimpleRegex = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g;
      while ((cm = bfrangeSimpleRegex.exec(cleanBlockText)) !== null) {
        const start = parseInt(cm[1], 16);
        const end = parseInt(cm[2], 16);
        const destStart = parseInt(cm[3], 16);
        const len = cm[1].length;
        for (let s = start; s <= end; s++) {
          const srcHex = s.toString(16).padStart(len, '0').toLowerCase();
          const dstCode = destStart + (s - start);
          const dstChar = String.fromCharCode(dstCode);
          cmap.set(srcHex, dstChar);
          if (srcHex.length === 2) cmap.set('00' + srcHex, dstChar);
        }
      }
    }
  }

  async function parseCMaps(allObjects, fullText, bytes, objOffsets, security = null) {
    const cmap = new Map();
    const toUnicodeObjNums = new Set();
    const cmapByObject = new Map();

    // Buscar referencias /ToUnicode en fullText y en todos los objetos (incluidos los de ObjStm)
    const toUnicodeRegex = /\/ToUnicode\s+(\d+)\s+\d+\s+R/g;
    let m;
    while ((m = toUnicodeRegex.exec(fullText)) !== null) {
      toUnicodeObjNums.add(m[1]);
    }

    for (const [num, body] of allObjects.entries()) {
      let bm;
      const bRegex = /\/ToUnicode\s+(\d+)\s+\d+\s+R/g;
      while ((bm = bRegex.exec(body)) !== null) {
        toUnicodeObjNums.add(bm[1]);
      }
      // Si el objeto ya contiene directamente CMap
      if (body.includes('beginbfchar') || body.includes('beginbfrange')) {
        parseCMapData(body, cmap);
      }
    }

    for (const objNum of toUnicodeObjNums) {
      const localCmap = new Map();
      const body = allObjects.get(String(objNum));
      if (body && (body.includes('beginbfchar') || body.includes('beginbfrange'))) {
        parseCMapData(body, localCmap);
        parseCMapData(body, cmap);
        cmapByObject.set(String(objNum), localCmap);
        continue;
      }

      const offset = objOffsets.get(String(objNum));
      if (offset !== undefined) {
        const streamIdx = fullText.indexOf('stream', offset);
        const endStreamIdx = fullText.indexOf('endstream', streamIdx);
        if (streamIdx !== -1 && endStreamIdx !== -1) {
          let dataStart = streamIdx + 6;
          if (fullText.charCodeAt(dataStart) === 13) dataStart++;
          if (fullText.charCodeAt(dataStart) === 10) dataStart++;
          let dataEnd = endStreamIdx;
          while (dataEnd > dataStart && (fullText.charCodeAt(dataEnd - 1) === 10 || fullText.charCodeAt(dataEnd - 1) === 13 || fullText.charCodeAt(dataEnd - 1) === 32)) {
            dataEnd--;
          }
          try {
            const rawBytes = bytes.subarray(dataStart, dataEnd);
            const generation = Number(body?.match(/^\s*\d+\s+(\d+)\s+obj/)?.[1] || 0);
            const streamBytes = security?.encrypted
              ? decryptPdfObjectBytes(rawBytes, security, Number(objNum), generation)
              : rawBytes;
            const decomp = await decompressDeflateData(streamBytes);
            const toParse = decomp ? new TextDecoder('latin1').decode(decomp) : (streamBytes ? new TextDecoder('latin1').decode(streamBytes) : '');
            if (toParse && (toParse.includes('beginbfchar') || toParse.includes('beginbfrange'))) {
              parseCMapData(toParse, localCmap);
              parseCMapData(toParse, cmap);
              cmapByObject.set(String(objNum), localCmap);
            }
          } catch (e) {}
        }
      }
      if (localCmap.size > 0) cmapByObject.set(String(objNum), localCmap);
    }

    // Los códigos CID solo son únicos dentro de una fuente. Mantener también
    // los mapas por nombre de recurso (/F1, /F2...) evita que el último CMap
    // leído corrompa texto y cifras pertenecientes a otra fuente.
    const cmapByFontObject = new Map();
    for (const [objNum, body] of allObjects.entries()) {
      const match = body.match(/\/ToUnicode\s+(\d+)\s+\d+\s+R/);
      if (!match) continue;
      const localCmap = cmapByObject.get(String(match[1]));
      if (localCmap) cmapByFontObject.set(String(objNum), localCmap);
    }

    const byFontName = new Map();
    for (const body of allObjects.values()) {
      const resourceRegex = /\/([^\s/<>\[\]()]+)\s+(\d+)\s+\d+\s+R/g;
      let resourceMatch;
      while ((resourceMatch = resourceRegex.exec(body)) !== null) {
        const localCmap = cmapByFontObject.get(String(resourceMatch[2]));
        if (localCmap && !byFontName.has(resourceMatch[1])) {
          byFontName.set(resourceMatch[1], localCmap);
        }
      }
    }
    cmap.byFontName = byFontName;

    return cmap;
  }

  function mapPdfLiteralString(lit, cmap) {
    const raw = decodePdfEscapes(lit);
    if (!cmap || cmap.size === 0 || !raw) return raw;

    let decoded = '';
    let hasMapping = false;
    for (let k = 0; k < raw.length; k++) {
      const c1 = raw.charCodeAt(k);
      const hex1 = c1.toString(16).padStart(2, '0').toLowerCase();

      // Probar secuencia de 2 bytes (UTF-16BE / 2-byte CID)
      if (k + 1 < raw.length) {
        const c2 = raw.charCodeAt(k + 1);
        const hex2 = hex1 + c2.toString(16).padStart(2, '0').toLowerCase();
        if (cmap.has(hex2)) {
          decoded += cmap.get(hex2);
          hasMapping = true;
          k++;
          continue;
        }
      }

      // Probar byte nulo + carácter en UTF-16BE estándar
      if (c1 === 0 && k + 1 < raw.length) {
        const c2 = raw.charCodeAt(k + 1);
        const hex2 = '00' + c2.toString(16).padStart(2, '0').toLowerCase();
        if (cmap.has(hex2)) {
          decoded += cmap.get(hex2);
          hasMapping = true;
        } else if (c2 >= 32 && c2 <= 126) {
          decoded += raw.charAt(k + 1);
        }
        k++;
        continue;
      }

      // Probar 1 byte mapeado en CMap
      if (cmap.has(hex1)) {
        decoded += cmap.get(hex1);
        hasMapping = true;
      } else if (c1 >= 32 && c1 <= 126) {
        decoded += raw.charAt(k);
      }
    }

    return (hasMapping || decoded.length >= raw.length * 0.5) ? decoded : raw;
  }

  function parsePdfStreamText(streamString, cmap = new Map()) {
    if (!streamString || typeof streamString !== 'string') return '';

    let out = [];
    let inTextObject = false;
    let activeCmap = cmap;
    const len = streamString.length;
    let i = 0;

    while (i < len) {
      const c = streamString.charCodeAt(i);

      // Check BT (Begin Text)
      if (c === 66 /* B */ && i + 1 < len && streamString.charCodeAt(i + 1) === 84 /* T */) {
        const prev = i > 0 ? streamString.charCodeAt(i - 1) : 32;
        const next = i + 2 < len ? streamString.charCodeAt(i + 2) : 32;
        if (isPdfDelimiterOrWs(prev) && isPdfDelimiterOrWs(next)) {
          inTextObject = true;
          i += 2;
          continue;
        }
      }

      // Check ET (End Text)
      if (c === 69 /* E */ && i + 1 < len && streamString.charCodeAt(i + 1) === 84 /* T */) {
        const prev = i > 0 ? streamString.charCodeAt(i - 1) : 32;
        const next = i + 2 < len ? streamString.charCodeAt(i + 2) : 32;
        if (isPdfDelimiterOrWs(prev) && isPdfDelimiterOrWs(next)) {
          inTextObject = false;
          out.push('\n');
          i += 2;
          continue;
        }
      }

      if (!inTextObject) {
        i++;
        continue;
      }

      // Seleccionar el ToUnicode de la fuente activa indicada por el operador
      // PDF "/Fname size Tf". El mapa agregado queda como fallback.
      if (c === 47 /* / */ && cmap && cmap.byFontName) {
        const fontMatch = streamString.substring(i).match(/^\/([^\s/<>\[\]()]+)\s+[-+]?(?:\d+\.?\d*|\.\d+)\s+Tf\b/);
        if (fontMatch) {
          activeCmap = cmap.byFontName.get(fontMatch[1]) || cmap;
        }
      }

      // Literal string: (texto)
      if (c === 40 /* ( */) {
        let depth = 1;
        let j = i + 1;
        let lit = '';
        while (j < len && depth > 0) {
          const sc = streamString.charCodeAt(j);
          if (sc === 92 /* \ */) {
            lit += streamString.charAt(j) + (j + 1 < len ? streamString.charAt(j + 1) : '');
            j += 2;
            continue;
          }
          if (sc === 40 /* ( */) depth++;
          else if (sc === 41 /* ) */) {
            depth--;
            if (depth === 0) { j++; break; }
          }
          lit += streamString.charAt(j);
          j++;
        }
        if (lit) out.push(mapPdfLiteralString(lit, activeCmap));
        i = j;
        continue;
      }

      // Hex string: <hex>
      if (c === 60 /* < */) {
        if (i + 1 < len && streamString.charCodeAt(i + 1) === 60) {
          i += 2;
          continue;
        }
        let j = i + 1;
        let hex = '';
        while (j < len && streamString.charCodeAt(j) !== 62 /* > */) {
          const hc = streamString.charCodeAt(j);
          if ((hc >= 48 && hc <= 57) || (hc >= 65 && hc <= 70) || (hc >= 97 && hc <= 102)) {
            hex += streamString.charAt(j);
          }
          j++;
        }
        if (j < len && streamString.charCodeAt(j) === 62) j++;
        let decoded = '';
        for (let k = 0; k < hex.length; k += 4) {
          const chunk = hex.slice(k, k + 4).toLowerCase();
          if (activeCmap.has(chunk)) decoded += activeCmap.get(chunk);
          else {
            const sub2 = hex.slice(k, k + 2).toLowerCase();
            if (activeCmap.has(sub2)) { decoded += activeCmap.get(sub2); k -= 2; }
            else {
              const code = parseInt(chunk, 16);
              if (!isNaN(code) && code >= 32 && code < 127) decoded += String.fromCharCode(code);
            }
          }
        }
        if (decoded) out.push(decoded);
        i = j;
        continue;
      }

      // Array TJ: [(str) num (str)] TJ
      if (c === 91 /* [ */) {
        let j = i + 1;
        let arrText = '';
        while (j < len && streamString.charCodeAt(j) !== 93 /* ] */) {
          const ac = streamString.charCodeAt(j);
          if (ac === 40 /* ( */) {
            let depth = 1;
            let k = j + 1;
            let lit = '';
            while (k < len && depth > 0) {
              const sc = streamString.charCodeAt(k);
              if (sc === 92) {
                lit += streamString.charAt(k) + (k + 1 < len ? streamString.charAt(k + 1) : '');
                k += 2;
                continue;
              }
              if (sc === 40) depth++;
              else if (sc === 41) {
                depth--;
                if (depth === 0) { k++; break; }
              }
              lit += streamString.charAt(k);
              k++;
            }
            arrText += mapPdfLiteralString(lit, activeCmap);
            j = k;
            continue;
          } else if (ac === 60 /* < */) {
            if (j + 1 < len && streamString.charCodeAt(j + 1) === 60) { j += 2; continue; }
            let k = j + 1;
            let hex = '';
            while (k < len && streamString.charCodeAt(k) !== 62) {
              const hc = streamString.charCodeAt(k);
              if ((hc >= 48 && hc <= 57) || (hc >= 65 && hc <= 70) || (hc >= 97 && hc <= 102)) {
                hex += streamString.charAt(k);
              }
              k++;
            }
            if (k < len && streamString.charCodeAt(k) === 62) k++;
            for (let m = 0; m < hex.length; m += 4) {
              const chunk = hex.slice(m, m + 4).toLowerCase();
              if (activeCmap.has(chunk)) arrText += activeCmap.get(chunk);
              else {
                const sub2 = hex.slice(m, m + 2).toLowerCase();
                if (activeCmap.has(sub2)) { arrText += activeCmap.get(sub2); m -= 2; }
              }
            }
            j = k;
            continue;
          } else if ((ac >= 48 && ac <= 57) || ac === 45 /* - */) {
            let numStr = '';
            while (j < len && ((streamString.charCodeAt(j) >= 48 && streamString.charCodeAt(j) <= 57) || streamString.charCodeAt(j) === 45 || streamString.charCodeAt(j) === 46)) {
              numStr += streamString.charAt(j);
              j++;
            }
            const num = parseFloat(numStr);
            if (!isNaN(num) && num < -100) arrText += ' ';
            continue;
          }
          j++;
        }
        if (j < len && streamString.charCodeAt(j) === 93) j++;
        if (arrText) out.push(arrText);
        i = j;
        continue;
      }

      // Operadores de salto de línea T*, Td, TD
      if (c === 84 /* T */ && i + 1 < len) {
        const nextC = streamString.charCodeAt(i + 1);
        if (nextC === 42 /* * */ || nextC === 100 /* d */ || nextC === 68 /* D */) {
          const after = i + 2 < len ? streamString.charCodeAt(i + 2) : 32;
          if (isPdfDelimiterOrWs(after)) {
            out.push('\n');
            i += 2;
            continue;
          }
        }
      }

      i++;
    }

    const res = out.join('').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
    return decodePdfShiftedText(res);
  }

  const KNOWN_PDF_ANCHORS = new Set([
    // English
    'LIQUIDITY', 'COAL', 'MINED', 'ASSET', 'ASSETS', 'LIABILITY', 'LIABILITIES',
    'EQUITY', 'REVENUE', 'REVENUES', 'PROFIT', 'PROFITS', 'INCOME', 'EXPENSE', 'EXPENSES',
    'CASH', 'FLOW', 'FLOWS', 'BALANCE', 'SHEET', 'TOTAL', 'MARGIN', 'MARGINS',
    'DIVIDEND', 'DIVIDENDS', 'EARNING', 'EARNINGS', 'SHARE', 'SHARES', 'DEBT',
    'SALES', 'COST', 'COSTS', 'OPERATING', 'FINANCIAL', 'REPORT', 'REPORTS',
    'TAX', 'TAXES', 'NET', 'GROSS', 'CAPITAL', 'EXPENDITURE', 'EXPENDITURES', 'INTEREST', 'PERIOD', 'QUARTER',
    'ANNUAL', 'CURRENT', 'INVESTMENT', 'INVESTMENTS', 'DEPRECIATION', 'AMORTIZATION',
    'PRODUCTION', 'TONNES', 'TONS', 'PRICE', 'PRICES', 'VOLUME', 'SEGMENT', 'RESULTS',
    'AUDIT', 'AUDITED', 'COMPANY', 'CORPORATION', 'GROUP', 'CONSOLIDATED', 'MILLION', 'THOUSAND',
    // Spanish
    'LIQUIDEZ', 'ACTIVO', 'ACTIVOS', 'PASIVO', 'PASIVOS', 'PATRIMONIO', 'NETO',
    'INGRESO', 'INGRESOS', 'GASTO', 'GASTOS', 'BENEFICIO', 'BENEFICIOS',
    'RESULTADO', 'RESULTADOS', 'BALANCE', 'TOTAL', 'MARGEN', 'MARGENES',
    'DIVIDENDO', 'DIVIDENDOS', 'CUENTA', 'CUENTAS', 'PERIODO', 'PERIODOS',
    'EJERCICIO', 'EJERCICIOS', 'VENTA', 'VENTAS', 'COSTE', 'COSTES',
    'FINANCIERO', 'FINANCIEROS', 'FINANCIERA', 'FINANCIERAS', 'INFORME', 'INFORMES',
    'IMPUESTO', 'IMPUESTOS', 'EXPLOTACION', 'CONSOLIDADO', 'CONSOLIDADA',
    'AUDITORIA', 'MEMORIA', 'CAPITAL', 'INTERES', 'INTERESES', 'INVERSION',
    'INVERSIONES', 'DEPRECIACION', 'AMORTIZACION', 'PRODUCCION', 'TONELADAS',
    'PRECIO', 'PRECIOS', 'VOLUMEN', 'EMPRESA', 'SOCIEDAD', 'GRUPO', 'MILLONES', 'MILES'
  ]);

  function unshiftAsciiString(str, offset = 3) {
    if (!str) return '';
    let res = '';
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      if (code >= 33 && code <= 126) {
        const unshifted = code - offset;
        res += (unshifted >= 32 && unshifted <= 126) ? String.fromCharCode(unshifted) : str.charAt(i);
      } else {
        res += str.charAt(i);
      }
    }
    return res;
  }

  function splitKnownConcatenatedWords(str) {
    for (const kw of KNOWN_PDF_ANCHORS) {
      if (str.startsWith(kw) && str.length > kw.length) {
        const rest = str.slice(kw.length);
        if (KNOWN_PDF_ANCHORS.has(rest)) {
          return `${kw} ${rest}`;
        }
      }
    }
    return str;
  }

  function collapseSpacedLettersAndNumbers(text) {
    if (!text || text.length < 3) return text;
    let out = text.replace(/((?:[A-Za-z]\s+){2,}[A-Za-z])/g, (match) => {
      const parts = match.split(/\s{2,}/);
      return parts.map(p => {
        const joined = p.replace(/\s+/g, '');
        return splitKnownConcatenatedWords(joined.toUpperCase());
      }).join(' ');
    });

    out = out.replace(/((?:[\d.,\-+()\/]\s+){2,}[\d.,\-+()\/])/g, (match) => {
      return match.replace(/\s+/g, '');
    });

    return out;
  }

  /**
   * Algunos generadores PDF emiten cada glifo como una operación de texto
   * independiente. El extractor conserva esas operaciones como líneas, por lo
   * que una página termina siendo "C\na\ns\nh\n\nF\nl\no\nw". Solo normalizamos
   * páginas donde este patrón es dominante para no alterar documentos que
   * realmente contienen listas de una letra o tablas verticales.
   */
  function collapseVerticallySplitGlyphs(text) {
    if (!text || typeof text !== 'string') return text;

    return text.split(/(?=--- Página \d+ ---\n)/).map(section => {
      const firstNewline = section.indexOf('\n');
      if (firstNewline < 0) return section;

      const heading = section.slice(0, firstNewline + 1);
      const body = section.slice(firstNewline + 1);
      const nonEmptyLines = body.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      if (nonEmptyLines.length < 20) return section;

      const singleGlyphLines = nonEmptyLines.filter(line => Array.from(line).length === 1).length;
      if (singleGlyphLines / nonEmptyLines.length < 0.65) return section;

      const blocks = body.split(/\r?\n\s*\r?\n+/).map(block => {
        const lines = block.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        if (lines.length >= 2 && lines.every(line => Array.from(line).length === 1)) {
          return lines.join('');
        }
        return lines.join(' ');
      }).filter(Boolean);

      return heading + blocks.join(' ') + '\n\n';
    }).join('');
  }

  function decodePdfShiftedText(text, offset = 3) {
    if (!text || typeof text !== 'string' || text.length < 3) return text;
    const lines = text.split(/\r?\n/);
    let anyDecoded = false;
    let anySpacingNormalized = false;
    let tableContextActive = false;

    const decodedLines = lines.map(line => {
      const trimmed = line.trim();
      if (!trimmed) {
        tableContextActive = false;
        return line;
      }

      // Mantener la ruta original para fuentes con desplazamiento +3. En los
      // PDF normales, además, compactamos glifos separados para que una línea
      // como "C a s h F l o w" sea indexable.
      const candidate = unshiftAsciiString(trimmed, offset);
      const collapsed = collapseSpacedLettersAndNumbers(candidate);
      const rawCollapsed = collapseSpacedLettersAndNumbers(trimmed);
      if (rawCollapsed !== trimmed) anySpacingNormalized = true;

      const candidateUpper = collapsed.toUpperCase();
      const tokens = candidateUpper.split(/[^A-Z]+/);
      let keywordHits = 0;
      for (const tok of tokens) {
        if (tok.length >= 3 && KNOWN_PDF_ANCHORS.has(tok)) {
          keywordHits++;
        }
      }

      const hasBackslashGlitch = /\b[A-Za-z0-9\s]{2,}\\[\s\d]*/.test(trimmed) || /\\(?:\s+|$)/.test(trimmed);
      const hasShiftedNumberFormat = /[0-9:<;]\s*[\/1]\s*[0-9:<;]/.test(trimmed);

      if (keywordHits > 0 || hasBackslashGlitch || (tableContextActive && hasShiftedNumberFormat)) {
        anyDecoded = true;
        tableContextActive = true;
        return collapsed.replace(/[ \t]+/g, ' ').trim();
      }

      return rawCollapsed;
    });

    return (anyDecoded || anySpacingNormalized) ? decodedLines.join('\n') : text;
  }

  async function decompressDeflateData(uint8Array) {
    if (!uint8Array || uint8Array.length === 0) return null;

    if (typeof DecompressionStream !== 'undefined') {
      try {
        const ds = new DecompressionStream('deflate');
        const writer = ds.writable.getWriter();
        const writePromise = writer.write(uint8Array).then(() => writer.close()).catch(() => {});
        const res = new Response(ds.readable);
        const buf = await res.arrayBuffer();
        await writePromise;
        return new Uint8Array(buf);
      } catch (e) {}

      try {
        let rawSlice = uint8Array;
        const isZlib = uint8Array.length > 6 && (uint8Array[0] & 0x0F) === 8 && (((uint8Array[0] << 8) | uint8Array[1]) % 31 === 0);
        if (isZlib) {
          rawSlice = uint8Array.subarray(2, uint8Array.length - 4);
        }
        const dsRaw = new DecompressionStream('deflate-raw');
        const writer = dsRaw.writable.getWriter();
        const writePromise = writer.write(rawSlice).then(() => writer.close()).catch(() => {});
        const res = new Response(dsRaw.readable);
        const buf = await res.arrayBuffer();
        await writePromise;
        return new Uint8Array(buf);
      } catch (e) {}
    }

    if (typeof require !== 'undefined') {
      try {
        const zlib = require('zlib');
        return zlib.inflateSync(uint8Array);
      } catch (e) {
        try {
          const zlib = require('zlib');
          return zlib.inflateRawSync(uint8Array);
        } catch (e2) {}
      }
    }

    return null;
  }

  function bytesToBase64(uint8Array) {
    if (!uint8Array || uint8Array.length === 0) return '';
    if (typeof Buffer !== 'undefined') return Buffer.from(uint8Array).toString('base64');
    let binary = '';
    const len = uint8Array.byteLength;
    const chunkSize = 0x8000;
    for (let i = 0; i < len; i += chunkSize) {
      binary += String.fromCharCode.apply(null, uint8Array.subarray(i, Math.min(i + chunkSize, len)));
    }
    return btoa(binary);
  }

  const PDF_PASSWORD_PADDING = new Uint8Array([
    0x28, 0xBF, 0x4E, 0x5E, 0x4E, 0x75, 0x8A, 0x41,
    0x64, 0x00, 0x4E, 0x56, 0xFF, 0xFA, 0x01, 0x08,
    0x2E, 0x2E, 0x00, 0xB6, 0xD0, 0x68, 0x3E, 0x80,
    0x2F, 0x0C, 0xA9, 0xFE, 0x64, 0x53, 0x69, 0x7A
  ]);

  function concatByteArrays(...arrays) {
    const result = new Uint8Array(arrays.reduce((total, value) => total + value.length, 0));
    let offset = 0;
    for (const value of arrays) {
      result.set(value, offset);
      offset += value.length;
    }
    return result;
  }

  function hexToBytes(hex) {
    const clean = String(hex || '').replace(/\s+/g, '');
    if (!clean || clean.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(clean)) return null;
    const bytes = new Uint8Array(clean.length / 2);
    for (let index = 0; index < bytes.length; index++) bytes[index] = parseInt(clean.slice(index * 2, index * 2 + 2), 16);
    return bytes;
  }

  function md5Bytes(input) {
    const source = input instanceof Uint8Array ? input : new Uint8Array(input || []);
    const paddedLength = Math.ceil((source.length + 9) / 64) * 64;
    const padded = new Uint8Array(paddedLength);
    padded.set(source);
    padded[source.length] = 0x80;
    const view = new DataView(padded.buffer);
    const bitLength = source.length * 8;
    view.setUint32(paddedLength - 8, bitLength >>> 0, true);
    view.setUint32(paddedLength - 4, Math.floor(bitLength / 0x100000000), true);

    const shifts = [
      7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
      5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
      4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
      6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
    ];
    const constants = Array.from({ length: 64 }, (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 0x100000000) >>> 0);
    let a0 = 0x67452301;
    let b0 = 0xEFCDAB89;
    let c0 = 0x98BADCFE;
    let d0 = 0x10325476;

    for (let offset = 0; offset < paddedLength; offset += 64) {
      const words = Array.from({ length: 16 }, (_, index) => view.getUint32(offset + index * 4, true));
      let a = a0, b = b0, c = c0, d = d0;
      for (let index = 0; index < 64; index++) {
        let f, wordIndex;
        if (index < 16) {
          f = (b & c) | (~b & d);
          wordIndex = index;
        } else if (index < 32) {
          f = (d & b) | (~d & c);
          wordIndex = (5 * index + 1) % 16;
        } else if (index < 48) {
          f = b ^ c ^ d;
          wordIndex = (3 * index + 5) % 16;
        } else {
          f = c ^ (b | ~d);
          wordIndex = (7 * index) % 16;
        }
        const sum = (a + f + constants[index] + words[wordIndex]) >>> 0;
        const rotated = ((sum << shifts[index]) | (sum >>> (32 - shifts[index]))) >>> 0;
        const previousD = d;
        d = c;
        c = b;
        b = (b + rotated) >>> 0;
        a = previousD;
      }
      a0 = (a0 + a) >>> 0;
      b0 = (b0 + b) >>> 0;
      c0 = (c0 + c) >>> 0;
      d0 = (d0 + d) >>> 0;
    }

    const digest = new Uint8Array(16);
    const digestView = new DataView(digest.buffer);
    digestView.setUint32(0, a0, true);
    digestView.setUint32(4, b0, true);
    digestView.setUint32(8, c0, true);
    digestView.setUint32(12, d0, true);
    return digest;
  }

  function rc4Bytes(key, input) {
    const state = new Uint8Array(256);
    for (let index = 0; index < 256; index++) state[index] = index;
    let j = 0;
    for (let index = 0; index < 256; index++) {
      j = (j + state[index] + key[index % key.length]) & 0xFF;
      const swap = state[index]; state[index] = state[j]; state[j] = swap;
    }
    const output = new Uint8Array(input.length);
    let i = 0;
    j = 0;
    for (let index = 0; index < input.length; index++) {
      i = (i + 1) & 0xFF;
      j = (j + state[i]) & 0xFF;
      const swap = state[i]; state[i] = state[j]; state[j] = swap;
      output[index] = input[index] ^ state[(state[i] + state[j]) & 0xFF];
    }
    return output;
  }

  function bytesEqual(left, right, length = Math.min(left?.length || 0, right?.length || 0)) {
    if (!left || !right || left.length < length || right.length < length) return false;
    for (let index = 0; index < length; index++) if (left[index] !== right[index]) return false;
    return true;
  }

  function createPdfSecurityContext(allObjects, fullText) {
    const encryptRef = String(fullText || '').match(/\/Encrypt\s+(\d+)\s+(\d+)\s+R/i);
    if (!encryptRef) return null;
    const encryptionBody = allObjects.get(encryptRef[1]);
    if (!encryptionBody) return { encrypted: true, supported: false };
    const filter = encryptionBody.match(/\/Filter\s*\/([A-Za-z0-9]+)/)?.[1] || '';
    const version = Number(encryptionBody.match(/\/V\s+(\d+)/)?.[1] || 0);
    const revision = Number(encryptionBody.match(/\/R\s+(\d+)/)?.[1] || 0);
    const ownerKey = hexToBytes(encryptionBody.match(/\/O\s*<([0-9A-Fa-f\s]+)>/)?.[1]);
    const userKey = hexToBytes(encryptionBody.match(/\/U\s*<([0-9A-Fa-f\s]+)>/)?.[1]);
    const fileId = hexToBytes(String(fullText || '').match(/\/ID\s*\[\s*<([0-9A-Fa-f\s]+)>/)?.[1]);
    const permissions = Number(encryptionBody.match(/\/P\s+(-?\d+)/)?.[1]);
    if (filter !== 'Standard' || ![1, 2].includes(version) || ![2, 3].includes(revision) || !ownerKey || !userKey || !fileId || !Number.isFinite(permissions)) {
      return { encrypted: true, supported: false };
    }

    const keyLength = revision === 2 ? 5 : Math.min(16, Math.max(5, Number(encryptionBody.match(/\/Length\s+(\d+)/)?.[1] || 40) / 8));
    const permissionBytes = new Uint8Array(4);
    new DataView(permissionBytes.buffer).setInt32(0, permissions, true);
    let digest = md5Bytes(concatByteArrays(PDF_PASSWORD_PADDING, ownerKey, permissionBytes, fileId));
    if (revision >= 3) {
      for (let round = 0; round < 50; round++) digest = md5Bytes(digest.slice(0, keyLength));
    }
    const fileKey = digest.slice(0, keyLength);
    let expectedUserKey;
    if (revision === 2) {
      expectedUserKey = rc4Bytes(fileKey, PDF_PASSWORD_PADDING);
    } else {
      expectedUserKey = md5Bytes(concatByteArrays(PDF_PASSWORD_PADDING, fileId));
      expectedUserKey = rc4Bytes(fileKey, expectedUserKey);
      for (let round = 1; round <= 19; round++) {
        const roundKey = fileKey.map(value => value ^ round);
        expectedUserKey = rc4Bytes(roundKey, expectedUserKey);
      }
    }
    const valid = bytesEqual(expectedUserKey, userKey, revision === 2 ? 32 : 16);
    return { encrypted: true, supported: valid, fileKey };
  }

  function decryptPdfObjectBytes(input, security, objectNumber, generationNumber = 0) {
    if (!security?.supported || !security.fileKey) return null;
    const suffix = new Uint8Array([
      objectNumber & 0xFF, (objectNumber >>> 8) & 0xFF, (objectNumber >>> 16) & 0xFF,
      generationNumber & 0xFF, (generationNumber >>> 8) & 0xFF
    ]);
    const digest = md5Bytes(concatByteArrays(security.fileKey, suffix));
    const objectKey = digest.slice(0, Math.min(security.fileKey.length + 5, 16));
    return rc4Bytes(objectKey, input);
  }

  function extractImagesFromPdfObjects(allObjects, objOffsets, bytes, security = null) {
    const imagesByObjNum = new Map();
    let imgCounter = 1;

    for (const [num, body] of allObjects.entries()) {
      if (!/\/Subtype\s*\/Image\b/i.test(body)) continue;

      const widthMatch = body.match(/\/Width\s+(\d+)/);
      const heightMatch = body.match(/\/Height\s+(\d+)/);
      const width = widthMatch ? parseInt(widthMatch[1], 10) : 0;
      const height = heightMatch ? parseInt(heightMatch[1], 10) : 0;

      // Filtrar elementos gráficos irrelevantes o viñetas diminutas
      if (width < 30 || height < 30 || (width * height < 2500)) continue;

      const sIdx = body.indexOf('stream');
      const eIdx = body.indexOf('endstream', sIdx);
      if (sIdx === -1 || eIdx === -1) continue;

      let dStart = sIdx + 6;
      if (body.charCodeAt(dStart) === 13) dStart++;
      if (body.charCodeAt(dStart) === 10) dStart++;
      let dEnd = eIdx;
      while (dEnd > dStart && (body.charCodeAt(dEnd - 1) === 10 || body.charCodeAt(dEnd - 1) === 13 || body.charCodeAt(dEnd - 1) === 32)) {
        dEnd--;
      }

      const offset = objOffsets.get(String(num)) || 0;
      const rawBytes = bytes.subarray(offset + dStart, offset + dEnd);
      if (!rawBytes || rawBytes.length < 50) continue;

      const generation = Number(body.match(/^\s*\d+\s+(\d+)\s+obj/)?.[1] || 0);
      const imageBytes = security?.encrypted
        ? decryptPdfObjectBytes(rawBytes, security, Number(num), generation)
        : rawBytes;
      if (!imageBytes || imageBytes.length < 50) continue;

      const isDct = /\/Filter\s*(?:\/DCTDecode|\[\s*\/DCTDecode\s*\])/i.test(body);
      const isJpx = /\/Filter\s*(?:\/JPXDecode|\[\s*\/JPXDecode\s*\])/i.test(body);

      let mimeType = '';
      let dataUrl = '';

      const isCmyk = body.includes('DeviceCMYK') || body.includes('/ColorSpace/DeviceCMYK') || body.includes('/ColorSpace /DeviceCMYK');

      if ((isDct || (imageBytes[0] === 0xFF && imageBytes[1] === 0xD8)) && imageBytes[0] === 0xFF && imageBytes[1] === 0xD8) {
        mimeType = 'image/jpeg';
        dataUrl = `data:image/jpeg;base64,${bytesToBase64(imageBytes)}`;
      } else if (isJpx && imageBytes.length >= 12 && imageBytes[4] === 0x6A && imageBytes[5] === 0x50) {
        mimeType = 'image/jp2';
        dataUrl = `data:image/jp2;base64,${bytesToBase64(imageBytes)}`;
      } else if (imageBytes[0] === 0x89 && imageBytes[1] === 0x50 && imageBytes[2] === 0x4E && imageBytes[3] === 0x47) {
        mimeType = 'image/png';
        dataUrl = `data:image/png;base64,${bytesToBase64(imageBytes)}`;
      }

      if (dataUrl) {
        imagesByObjNum.set(String(num), {
          id: `img_${imgCounter++}`,
          objNum: String(num),
          width,
          height,
          sizeBytes: imageBytes.length,
          mimeType: mimeType || 'image/jpeg',
          isCmyk: Boolean(isCmyk),
          dataUrl
        });
      }
    }

    return imagesByObjNum;
  }

  /** Extrae texto y objetos de imagen de un PDF de forma interna. */
  async function extractPdfInternal(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const decoder = new TextDecoder('latin1');
    const fullText = decoder.decode(bytes);

    // 1. Mapeo de objetos directos PDF
    const allObjects = new Map();
    const objOffsets = new Map();
    const objRegex = /(\d+)\s+(\d+)\s+obj/g;
    let m;
    while ((m = objRegex.exec(fullText)) !== null) {
      objOffsets.set(m[1], m.index);
    }

    for (const [num, offset] of objOffsets.entries()) {
      const endObj = fullText.indexOf('endobj', offset);
      if (endObj !== -1) {
        allObjects.set(num, fullText.substring(offset, endObj + 6));
      }
    }

    // 2. Descomprimir todos los flujos de objetos comprimidos (/Type /ObjStm) antes de extraer CMaps
    for (const [num, body] of Array.from(allObjects.entries())) {
      if (body.includes('/Type/ObjStm') || body.includes('/Type /ObjStm')) {
        const sIdx = body.indexOf('stream');
        const eIdx = body.indexOf('endstream', sIdx);
        if (sIdx !== -1 && eIdx !== -1) {
          let dStart = sIdx + 6;
          if (body.charCodeAt(dStart) === 13) dStart++;
          if (body.charCodeAt(dStart) === 10) dStart++;
          let rEnd = eIdx;
          if (rEnd > dStart && (body.charCodeAt(rEnd - 1) === 10 || body.charCodeAt(rEnd - 1) === 13)) rEnd--;
          if (rEnd > dStart && (body.charCodeAt(rEnd - 1) === 10 || body.charCodeAt(rEnd - 1) === 13)) rEnd--;

          const offset = objOffsets.get(num) || 0;
          const rawStream = bytes.subarray(offset + dStart, offset + rEnd);
          try {
            const decomp = await decompressDeflateData(rawStream);
            if (decomp) {
              const decStr = decoder.decode(decomp);
              const nMatch = body.match(/\/N\s+(\d+)/);
              const firstMatch = body.match(/\/First\s+(\d+)/);
              const n = nMatch ? parseInt(nMatch[1]) : 0;
              const first = firstMatch ? parseInt(firstMatch[1]) : 0;
              const header = decStr.substring(0, first).trim().split(/\s+/);
              for (let i = 0; i < header.length; i += 2) {
                const oNum = header[i];
                const oOffset = parseInt(header[i + 1]);
                const nextOffset = (i + 3 < header.length) ? parseInt(header[i + 3]) : decStr.length - first;
                const oBody = decStr.substring(first + oOffset, first + nextOffset);
                allObjects.set(oNum, oBody);
              }
            }
          } catch (e) {}
        }
      }
    }

    // 3. Extracción de contexto de seguridad y CMaps / ToUnicode
    const security = createPdfSecurityContext(allObjects, fullText);
    const cmap = await parseCMaps(allObjects, fullText, bytes, objOffsets, security);

    // 3b. Extracción de imágenes XObject (/Subtype /Image)
    const imagesByObjNum = extractImagesFromPdfObjects(allObjects, objOffsets, bytes, security);
    const assignedImages = new Set();
    const allExtractedImages = [];

    // 4. Resolución del catálogo y árbol jerárquico de páginas (Page Tree)
    let catalogObjNum = null;
    for (const [num, body] of allObjects.entries()) {
      if (/\/Type\s*\/Catalog\b/.test(body)) {
        catalogObjNum = num;
        break;
      }
    }

    const catalogBody = catalogObjNum ? (allObjects.get(catalogObjNum) || '') : '';
    const pagesMatch = catalogBody.match(/\/Pages\s+(\d+)\s+\d+\s+R/);

    const pagesList = [];
    function traverse(nodeObjNum) {
      const body = allObjects.get(String(nodeObjNum));
      if (!body) return;
      if (/\/Type\s*\/Page\b/i.test(body) && !/\/Type\s*\/Pages\b/i.test(body)) {
        pagesList.push(nodeObjNum);
        return;
      }
      const kidsMatch = body.match(/\/Kids\s*\[([\s\S]*?)\]/);
      if (kidsMatch) {
        const refs = kidsMatch[1].match(/(\d+)\s+\d+\s+R/g) || [];
        for (const ref of refs) {
          const kidNum = ref.match(/^(\d+)/)[1];
          traverse(kidNum);
        }
      }
    }
    if (pagesMatch) traverse(pagesMatch[1]);

    let pages = [];
    let pageNum = 1;

    // A. Extracción secuencial basada en el Page Tree
    if (pagesList.length > 0) {
      for (const pageObjNum of pagesList) {
        const body = allObjects.get(String(pageObjNum));
        if (!body) continue;

        const contentsMatch = body.match(/\/Contents\s+(?:\[([\s\S]*?)\]|(\d+)\s+\d+\s+R)/);
        let contentObjs = [];
        if (contentsMatch) {
          if (contentsMatch[1]) {
            contentObjs = (contentsMatch[1].match(/(\d+)\s+\d+\s+R/g) || []).map(r => r.match(/^(\d+)/)[1]);
          } else if (contentsMatch[2]) {
            contentObjs = [contentsMatch[2]];
          }
        }

        let pageItems = [];

        // Extraer contenido de streams de texto de la página
        for (const cNum of contentObjs) {
          const cBody = allObjects.get(String(cNum));
          if (!cBody) continue;
          const streamIdx = cBody.indexOf('stream');
          const endStreamIdx = cBody.indexOf('endstream', streamIdx);
          if (streamIdx !== -1 && endStreamIdx !== -1) {
            let dataStart = streamIdx + 6;
            if (cBody.charCodeAt(dataStart) === 13) dataStart++;
            if (cBody.charCodeAt(dataStart) === 10) dataStart++;
            let rawEnd = endStreamIdx;
            if (rawEnd > dataStart && (cBody.charCodeAt(rawEnd - 1) === 10 || cBody.charCodeAt(rawEnd - 1) === 13)) rawEnd--;
            if (rawEnd > dataStart && (cBody.charCodeAt(rawEnd - 1) === 10 || cBody.charCodeAt(rawEnd - 1) === 13)) rawEnd--;

            const offset = objOffsets.get(String(cNum));
            const rawBytes = offset !== undefined
              ? bytes.subarray(offset + dataStart, offset + rawEnd)
              : new Uint8Array(Array.from(cBody.substring(dataStart, rawEnd), ch => ch.charCodeAt(0)));

            try {
              let streamString = '';
              const generation = Number(cBody.match(/^\s*\d+\s+(\d+)\s+obj/)?.[1] || 0);
              const streamBytes = security?.encrypted
                ? decryptPdfObjectBytes(rawBytes, security, Number(cNum), generation)
                : rawBytes;
              const decompressed = await decompressDeflateData(streamBytes);
              if (decompressed) {
                streamString = decoder.decode(decompressed);
              } else {
                streamString = decoder.decode(streamBytes);
              }

              if (streamString) {
                const parsed = parsePdfStreamText(streamString, cmap);
                if (parsed && parsed.length > 0) {
                  pageItems.push(parsed);
                }
              }
            } catch (e) {}
          }
        }

        // Detectar recursos /XObject directos e indirectos de la página
        const resMatch = body.match(/\/Resources\s*(?:<<([\s\S]*?)>>|(\d+)\s+\d+\s+R)/);
        let xobjDict = '';
        if (resMatch) {
          if (resMatch[1]) {
            const xMatch = resMatch[1].match(/\/XObject\s*(?:<<([\s\S]*?)>>|(\d+)\s+\d+\s+R)/);
            if (xMatch) {
              if (xMatch[1]) xobjDict = xMatch[1];
              else if (xMatch[2]) xobjDict = allObjects.get(xMatch[2]) || '';
            }
          } else if (resMatch[2]) {
            const resBody = allObjects.get(resMatch[2]) || '';
            const subXobjMatch = resBody.match(/\/XObject\s*(?:<<([\s\S]*?)>>|(\d+)\s+\d+\s+R)/);
            if (subXobjMatch) {
              if (subXobjMatch[1]) xobjDict = subXobjMatch[1];
              else if (subXobjMatch[2]) xobjDict = allObjects.get(subXobjMatch[2]) || '';
            }
          }
        }

        // Asociar imágenes de esta página
        const pageImages = [];
        let combinedRefs = null;
        for (const [imgObjNum, imgData] of imagesByObjNum.entries()) {
          if (assignedImages.has(imgObjNum)) continue;
          if (combinedRefs === null) {
            combinedRefs = body + ' ' + xobjDict;
            for (const cNum of contentObjs) {
              const cBody = allObjects.get(String(cNum));
              if (cBody) combinedRefs += ' ' + cBody;
            }
          }
          if (combinedRefs.includes(imgObjNum + ' 0 R')) {
            assignedImages.add(imgObjNum);
            imgData.page = pageNum;
            imgData.label = `Diagrama / Imagen (Pág. ${pageNum})`;
            pageImages.push(imgData);
            allExtractedImages.push(imgData);
          }
        }

        for (const img of pageImages) {
          pageItems.push(`\n![${img.label}](rag-image://__DOC_ID__:${img.id})\n`);
        }

        const pageText = pageItems.join('\n\n').replace(/[ \t]+/g, ' ').trim();
        if (pageText.length > 0) {
          pages.push(`--- Página ${pageNum} ---\n${pageText}`);
        }
        pageNum++;
      }
    }

    // Si quedaron imágenes no asociadas directamente al árbol de páginas, asignarlas
    for (const [imgObjNum, imgData] of imagesByObjNum.entries()) {
      if (!assignedImages.has(imgObjNum)) {
        assignedImages.add(imgObjNum);
        imgData.page = 1;
        imgData.label = `Diagrama / Imagen (Pág. 1)`;
        allExtractedImages.push(imgData);
        if (pages.length > 0) {
          pages[0] += `\n\n![${imgData.label}](rag-image://__DOC_ID__:${imgData.id})\n\n`;
        }
      }
    }

    // B. Fallback a escaneo lineal si el árbol de páginas no produjo resultados
    if (pages.length === 0) {
      let currentPageItems = [];
      let pos = 0;
      const len = fullText.length;
      pageNum = 1;

      while (pos < len) {
        const streamIdx = fullText.indexOf('stream', pos);
        if (streamIdx === -1) break;

        const prevChar = streamIdx > 0 ? fullText.charCodeAt(streamIdx - 1) : 32;
        if (prevChar <= 32 || prevChar === 62 || prevChar === 47) {
          let dataStart = streamIdx + 6;
          if (dataStart < len && fullText.charCodeAt(dataStart) === 13) dataStart++;
          if (dataStart < len && fullText.charCodeAt(dataStart) === 10) dataStart++;

          const endStreamIdx = fullText.indexOf('endstream', dataStart);
          if (endStreamIdx !== -1) {
            const dictStart = Math.max(0, streamIdx - 400);
            const dictSlice = fullText.substring(dictStart, streamIdx);
            const isDCT = dictSlice.includes('DCTDecode');
            const isFlate = dictSlice.includes('FlateDecode');
            const isFontOrMeta = dictSlice.includes('/Font') || dictSlice.includes('/Metadata') || dictSlice.includes('/ICCBased');
            let rawEnd = endStreamIdx;
            if (rawEnd > dataStart && (fullText.charCodeAt(rawEnd - 1) === 10 || fullText.charCodeAt(rawEnd - 1) === 13)) rawEnd--;
            if (rawEnd > dataStart && (fullText.charCodeAt(rawEnd - 1) === 10 || fullText.charCodeAt(rawEnd - 1) === 13)) rawEnd--;

            const byteOffset = dataStart;
            const byteLen = rawEnd - dataStart;
            const rawStreamBytes = bytes.subarray(byteOffset, byteOffset + byteLen);

            if (!isFontOrMeta && !isDCT) {
              let streamString = '';
              const objNumMatch = dictSlice.match(/(\d+)\s+(\d+)\s+obj[^\w]*$/);
              const objNum = objNumMatch ? Number(objNumMatch[1]) : 0;
              const generation = objNumMatch ? Number(objNumMatch[2]) : 0;
              const streamBytes = (security?.encrypted && objNum)
                ? decryptPdfObjectBytes(rawStreamBytes, security, objNum, generation)
                : rawStreamBytes;
              if (isFlate) {
                const decompressed = await decompressDeflateData(streamBytes);
                if (decompressed) {
                  streamString = decoder.decode(decompressed);
                }
              } else if (!isDCT) {
                streamString = decoder.decode(streamBytes);
              }

              if (streamString) {
                const parsed = parsePdfStreamText(streamString, cmap);
                if (parsed && parsed.trim().length > 0) {
                  currentPageItems.push(parsed.trim());
                }
              }
            }

            if (currentPageItems.length >= 4) {
              const pageText = currentPageItems.join('\n\n').trim();
              if (pageText.length > 0) {
                pages.push(`--- Página ${pageNum} ---\n${pageText}`);
                pageNum++;
                currentPageItems = [];
              }
            }

            pos = endStreamIdx + 9;
            continue;
          }
        }
        pos = streamIdx + 6;
      }

      if (currentPageItems.length > 0) {
        const pageText = currentPageItems.join('\n\n').trim();
        if (pageText.length > 0) {
          pages.push(`--- Página ${pageNum} ---\n${pageText}`);
        }
      }
    }

    // Fallback si no se pudieron dividir por páginas
    if (pages.length === 0) {
      const directText = parsePdfStreamText(fullText);
      if (directText && directText.trim().length > 0) {
        pages.push(`--- Página 1 ---\n${directText.trim()}`);
      }
    }

    let finalCleanText = pages.join('\n\n').trim();

    if (finalCleanText) {
      finalCleanText = collapseVerticallySplitGlyphs(finalCleanText);
      finalCleanText = decodePdfShiftedText(finalCleanText);
    }

    if (!finalCleanText) {
      const extractionWarning = '[Documento PDF adjunto: No se pudo extraer texto seleccionable. Es posible que el PDF contenga únicamente imágenes escaneadas o esté protegido por contraseña.]';
      if (allExtractedImages.length > 0) {
        const imageReferences = allExtractedImages
          .map(image => `![${image.label || `Imagen extraída (Pág. ${image.page || 1})`}](rag-image://__DOC_ID__:${image.id})`)
          .join('\n\n');
        finalCleanText = `--- Página 1 ---\n${extractionWarning}\n\n[Se recuperaron ${allExtractedImages.length} imagen${allExtractedImages.length === 1 ? '' : 'es'} incrustada${allExtractedImages.length === 1 ? '' : 's'} del PDF.]\n\n${imageReferences}`;
      } else {
        finalCleanText = extractionWarning;
      }
    }

    return {
      text: finalCleanText,
      images: allExtractedImages
    };
  }

  /** Extrae únicamente el texto plano de un PDF sin dependencias externas. */
  async function extractTextFromPdf(arrayBuffer) {
    const res = await extractPdfInternal(arrayBuffer);
    return res.text;
  }

  /** Extrae texto estructurado e imágenes incrustadas de un PDF. */
  async function parsePdfDocument(arrayBuffer) {
    return await extractPdfInternal(arrayBuffer);
  }

  /**
   * Lee y procesa cualquier tipo de archivo (PDF, texto, código, imagen).
   */
  async function parseFile(file) {
    const isPdf = file.name.toLowerCase().endsWith('.pdf') || file.type === 'application/pdf';
    const isImage = file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|svg)$/i.test(file.name);

    if (isPdf) {
      const arrayBuffer = await file.arrayBuffer();
      const extractedText = await extractTextFromPdf(arrayBuffer);
      return {
        name: file.name,
        size: file.size,
        type: 'pdf',
        content: String(extractedText),
        preview: `${file.name} (${formatBytes(file.size)})`
      };
    }

    if (isImage) {
      const base64 = await readFileAsDataUrl(file);
      const mime = file.type || (file.name.toLowerCase().endsWith('.png') ? 'image/png' : file.name.toLowerCase().endsWith('.webp') ? 'image/webp' : file.name.toLowerCase().endsWith('.gif') ? 'image/gif' : file.name.toLowerCase().endsWith('.svg') ? 'image/svg+xml' : 'image/jpeg');
      return {
        name: file.name,
        size: file.size,
        type: 'image',
        mimeType: mime,
        content: `[Imagen adjunta: ${file.name} (${formatBytes(file.size)})]`,
        dataUrl: base64,
        preview: `${file.name} (${formatBytes(file.size)})`
      };
    }

    // Archivos de texto o código
    const text = await readFileAsText(file);
    return {
      name: file.name,
      size: file.size,
      type: 'text',
      content: text,
      preview: `${file.name} (${formatBytes(file.size)})`
    };
  }

  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsText(file);
    });
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  /** Devuelve el número de componentes declarado en la cabecera SOF de un JPEG, o 0 si no se encuentra. */
  function getJpegComponentCount(bytes) {
    if (!bytes || bytes[0] !== 0xFF || bytes[1] !== 0xD8) return 0;
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xFF) return 0;
      const marker = bytes[offset + 1];
      if (marker === 0xFF) { offset++; continue; }
      if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD8)) { offset += 2; continue; }
      if (marker === 0xD9 || marker === 0xDA) return 0;
      const isSof = marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC;
      if (isSof) return offset + 9 < bytes.length ? bytes[offset + 9] : 0;
      offset += 2 + ((bytes[offset + 2] << 8) | bytes[offset + 3]);
    }
    return 0;
  }

  /**
   * Convierte un Data URL JPEG en espacio de color CMYK / YCCK a un Data URL JPEG sRGB bajo demanda.
   * La decodificación la hace el navegador; sin canvas (Node) el Data URL se devuelve sin cambios.
   */
  async function convertCmykDataUrlToRgb(dataUrl) {
    const prefix = 'data:image/jpeg;base64,';
    if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith(prefix)) return dataUrl;
    if (typeof document === 'undefined' || typeof createImageBitmap !== 'function' || typeof atob !== 'function') {
      return dataUrl;
    }
    try {
      const bin = atob(dataUrl.substring(prefix.length));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      if (getJpegComponentCount(bytes) !== 4) return dataUrl;

      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
      try {
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return dataUrl;
        ctx.drawImage(bitmap, 0, 0);
        return canvas.toDataURL('image/jpeg', 0.85);
      } finally {
        bitmap.close();
      }
    } catch (error) {
      console.warn('No se pudo convertir la imagen CMYK a RGB:', error);
      return dataUrl;
    }
  }

  return {
    formatBytes,
    parseFile,
    extractTextFromPdf,
    parsePdfDocument,
    convertCmykDataUrlToRgb,
    decodePdfShiftedText,
    unshiftAsciiString,
    collapseSpacedLettersAndNumbers,
    collapseVerticallySplitGlyphs,
    parsePdfStreamText
  };
});
