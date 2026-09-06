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

  function decodePdfHexString(hex) {
    if (!hex) return '';
    let cleanHex = hex.replace(/\s+/g, '');
    if (cleanHex.length % 2 !== 0) cleanHex += '0';
    let str = '';

    if (cleanHex.toUpperCase().startsWith('FEFF')) {
      for (let i = 4; i < cleanHex.length; i += 4) {
        const code = parseInt(cleanHex.slice(i, i + 4), 16);
        if (!isNaN(code) && code > 0) str += String.fromCharCode(code);
      }
      return str;
    }

    for (let i = 0; i < cleanHex.length; i += 2) {
      const code = parseInt(cleanHex.slice(i, i + 2), 16);
      if (!isNaN(code) && code >= 32) str += String.fromCharCode(code);
    }
    return str;
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

  function isReadablePdfText(str) {
    if (!str || str.length < 3) return false;
    let printable = 0;
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      if ((code >= 32 && code <= 126) || (code >= 160 && code <= 255) || code === 10 || code === 13 || code === 9) {
        printable++;
      }
    }
    const ratio = printable / str.length;
    if (/SF\d{6}|afii\d+|upblock|dnblock|triagup|dmacron/.test(str)) return false;
    return ratio >= 0.70;
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

  /**
   * Decodifica y convierte JPEGs en espacio de color CMYK / Adobe YCCK a formato sRGB legible.
   */
  function convertCmykJpegToRgbDataUrl(data) {
    try {
      let offset = 0;
      function readUint16() {
        const val = (data[offset] << 8) | data[offset + 1];
        offset += 2;
        return val;
      }

      if (readUint16() !== 0xFFD8) return null;

      const quantTables = [];
      const huffmanTablesDC = [];
      const huffmanTablesAC = [];
      let frame = null;
      let adobeTransform = -1;

      while (offset < data.length) {
        if (data[offset] !== 0xFF) { offset++; continue; }
        while (data[offset] === 0xFF) offset++;
        const marker = data[offset++];

        if (marker === 0xD9) break;
        if (marker === 0xDA) { // SOS
          readUint16();
          const numScanComponents = data[offset++];
          const scanComponents = [];
          for (let i = 0; i < numScanComponents; i++) {
            const id = data[offset++];
            const byte = data[offset++];
            scanComponents.push({ id, dcTable: (byte >> 4) & 0x0F, acTable: byte & 0x0F });
          }
          offset += 3;

          const scanBytes = [];
          while (offset < data.length) {
            if (data[offset] === 0xFF) {
              if (data[offset + 1] === 0x00) {
                scanBytes.push(0xFF);
                offset += 2;
              } else if (data[offset + 1] >= 0xD0 && data[offset + 1] <= 0xD7) {
                offset += 2;
              } else {
                break;
              }
            } else {
              scanBytes.push(data[offset++]);
            }
          }

          if (!frame || frame.numComponents !== 4) return null;

          let maxH = 1, maxV = 1;
          for (const comp of frame.components) {
            if (comp.hSample > maxH) maxH = comp.hSample;
            if (comp.vSample > maxV) maxV = comp.vSample;
          }

          const mcuWidth = maxH * 8;
          const mcuHeight = maxV * 8;
          const mcusPerRow = Math.ceil(frame.width / mcuWidth);
          const mcusPerCol = Math.ceil(frame.height / mcuHeight);

          let bitPos = 0;
          function readBit() {
            const byteIdx = bitPos >> 3;
            const bitIdx = 7 - (bitPos & 7);
            bitPos++;
            return (scanBytes[byteIdx] >> bitIdx) & 1;
          }
          function readBits(n) {
            let val = 0;
            for (let i = 0; i < n; i++) val = (val << 1) | readBit();
            return val;
          }
          function readHuffman(tree) {
            let node = tree;
            while (node.sym === undefined) {
              const bit = readBit();
              node = node[bit];
              if (!node) throw new Error('Invalid Huffman code');
            }
            return node.sym;
          }
          function extend(val, bits) {
            const vt = 1 << (bits - 1);
            if (val < vt) return val + (-1 << bits) + 1;
            return val;
          }

          function idct(block, out) {
            const temp = new Float64Array(64);
            const C = Math.PI / 16;
            for (let i = 0; i < 8; i++) {
              for (let j = 0; j < 8; j++) {
                let sum = 0;
                for (let k = 0; k < 8; k++) {
                  const s = block[i * 8 + k];
                  if (s === 0) continue;
                  const c = k === 0 ? 0.7071067811865475 : 1;
                  sum += c * s * Math.cos((2 * j + 1) * k * C);
                }
                temp[i * 8 + j] = sum * 0.5;
              }
            }
            for (let j = 0; j < 8; j++) {
              for (let i = 0; i < 8; i++) {
                let sum = 0;
                for (let k = 0; k < 8; k++) {
                  const s = temp[k * 8 + j];
                  if (s === 0) continue;
                  const c = k === 0 ? 0.7071067811865475 : 1;
                  sum += c * s * Math.cos((2 * i + 1) * k * C);
                }
                let val = Math.round(sum * 0.5) + 128;
                if (val < 0) val = 0;
                else if (val > 255) val = 255;
                out[i * 8 + j] = val;
              }
            }
          }

          const ZIGZAG = [
             0,  1,  8, 16,  9,  2,  3, 10,
            17, 24, 32, 25, 18, 11,  4,  5,
            12, 19, 26, 33, 40, 48, 41, 34,
            27, 20, 13,  6,  7, 14, 21, 28,
            35, 42, 49, 56, 57, 50, 43, 36,
            29, 22, 15, 23, 30, 37, 44, 51,
            58, 59, 52, 45, 38, 31, 39, 46,
            53, 60, 61, 54, 47, 55, 62, 63
          ];

          const compBuffers = frame.components.map(comp => {
            const w = mcusPerRow * comp.hSample * 8;
            const h = mcusPerCol * comp.vSample * 8;
            return {
              data: new Uint8Array(w * h),
              width: w,
              height: h,
              hSample: comp.hSample,
              vSample: comp.vSample,
              quantTable: quantTables[comp.quantId],
              dcPred: 0
            };
          });

          for (let mcuY = 0; mcuY < mcusPerCol; mcuY++) {
            for (let mcuX = 0; mcuX < mcusPerRow; mcuX++) {
              for (let c = 0; c < frame.numComponents; c++) {
                const comp = compBuffers[c];
                const scanComp = scanComponents.find(sc => sc.id === frame.components[c].id);
                const dcTree = huffmanTablesDC[scanComp.dcTable];
                const acTree = huffmanTablesAC[scanComp.acTable];

                for (let v = 0; v < comp.vSample; v++) {
                  for (let h = 0; h < comp.hSample; h++) {
                    const block = new Int32Array(64);
                    const dcLen = readHuffman(dcTree);
                    let dcDiff = 0;
                    if (dcLen > 0) dcDiff = extend(readBits(dcLen), dcLen);
                    comp.dcPred += dcDiff;
                    block[0] = comp.dcPred * comp.quantTable[0];

                    let k = 1;
                    while (k < 64) {
                      const acByte = readHuffman(acTree);
                      const rrr = (acByte >> 4) & 0x0F;
                      const sss = acByte & 0x0F;
                      if (sss === 0) {
                        if (rrr === 0) break;
                        if (rrr === 15) { k += 16; continue; }
                      }
                      k += rrr;
                      if (k >= 64) break;
                      const acVal = extend(readBits(sss), sss);
                      block[ZIGZAG[k]] = acVal * comp.quantTable[ZIGZAG[k]];
                      k++;
                    }

                    const blockOut = new Uint8Array(64);
                    idct(block, blockOut);

                    const startX = (mcuX * comp.hSample + h) * 8;
                    const startY = (mcuY * comp.vSample + v) * 8;
                    for (let row = 0; row < 8; row++) {
                      const destOffset = (startY + row) * comp.width + startX;
                      for (let col = 0; col < 8; col++) {
                        comp.data[destOffset + col] = blockOut[row * 8 + col];
                      }
                    }
                  }
                }
              }
            }
          }

          function getCompVal(cIdx, x, y) {
            const b = compBuffers[cIdx];
            return b.data[Math.floor(y * b.vSample / maxV) * b.width + Math.floor(x * b.hSample / maxH)];
          }

          const isYCCK = (adobeTransform === 2 || adobeTransform === -1);
          const rgbBytes = new Uint8Array(frame.width * frame.height * 3);
          let rgbPos = 0;

          for (let y = 0; y < frame.height; y++) {
            for (let x = 0; x < frame.width; x++) {
              const c0 = getCompVal(0, x, y);
              const c1 = getCompVal(1, x, y);
              const c2 = getCompVal(2, x, y);
              const c3 = getCompVal(3, x, y);

              let r, g, b;
              if (isYCCK) {
                const yVal = c0;
                const cb = c1 - 128;
                const cr = c2 - 128;
                const kNorm = (255 - c3) / 255;
                r = (yVal + 1.402 * cr) * kNorm;
                g = (yVal - 0.344136 * cb - 0.714136 * cr) * kNorm;
                b = (yVal + 1.772 * cb) * kNorm;
              } else {
                const c = c0 / 255, m = c1 / 255, y_ = c2 / 255, k = c3 / 255;
                r = 255 * (1 - c) * (1 - k);
                g = 255 * (1 - m) * (1 - k);
                b = 255 * (1 - y_) * (1 - k);
              }
              rgbBytes[rgbPos++] = Math.max(0, Math.min(255, Math.round(r)));
              rgbBytes[rgbPos++] = Math.max(0, Math.min(255, Math.round(g)));
              rgbBytes[rgbPos++] = Math.max(0, Math.min(255, Math.round(b)));
            }
          }

          if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
            try {
              const canvas = document.createElement('canvas');
              canvas.width = frame.width;
              canvas.height = frame.height;
              const ctx = canvas.getContext('2d');
              if (ctx) {
                const imgData = ctx.createImageData(frame.width, frame.height);
                const d = imgData.data;
                let sIdx = 0;
                for (let i = 0; i < d.length; i += 4) {
                  d[i] = rgbBytes[sIdx++];
                  d[i + 1] = rgbBytes[sIdx++];
                  d[i + 2] = rgbBytes[sIdx++];
                  d[i + 3] = 255;
                }
                ctx.putImageData(imgData, 0, 0);
                return canvas.toDataURL('image/jpeg', 0.85);
              }
            } catch (e) {}
          }

          return encodeRgbToJpegDataUrl(frame.width, frame.height, rgbBytes, 80);
        }

        const length = readUint16();
        const nextMarkerOffset = offset + length - 2;

        if (marker === 0xDB) {
          let p = offset;
          while (p < nextMarkerOffset) {
            const info = data[p++];
            const tableId = info & 0x0F;
            const is16Bit = (info >> 4) !== 0;
            const table = new Int32Array(64);
            for (let i = 0; i < 64; i++) {
              table[i] = is16Bit ? ((data[p++] << 8) | data[p++]) : data[p++];
            }
            quantTables[tableId] = table;
          }
        } else if (marker === 0xC0 || marker === 0xC2) {
          const precision = data[offset++];
          const height = readUint16();
          const width = readUint16();
          const numComponents = data[offset++];
          const components = [];
          for (let i = 0; i < numComponents; i++) {
            const id = data[offset++];
            const byte = data[offset++];
            const quantId = data[offset++];
            components.push({ id, hSample: (byte >> 4) & 0x0F, vSample: byte & 0x0F, quantId });
          }
          frame = { precision, height, width, numComponents, components };
        } else if (marker === 0xC4) {
          let p = offset;
          while (p < nextMarkerOffset) {
            const info = data[p++];
            const isAC = (info >> 4) !== 0;
            const tableId = info & 0x0F;
            const counts = new Uint8Array(16);
            for (let i = 0; i < 16; i++) counts[i] = data[p++];
            const symbols = [];
            for (let i = 0; i < 16; i++) {
              const syms = [];
              for (let j = 0; j < counts[i]; j++) syms.push(data[p++]);
              symbols.push(syms);
            }
            const tree = buildHuffmanTree(counts, symbols);
            if (isAC) huffmanTablesAC[tableId] = tree;
            else huffmanTablesDC[tableId] = tree;
          }
        } else if (marker === 0xEE) {
          if (length >= 14 && data[offset] === 0x41 && data[offset+1] === 0x64 && data[offset+2] === 0x6F && data[offset+3] === 0x62 && data[offset+4] === 0x65) {
            adobeTransform = data[offset + 11];
          }
        }
        offset = nextMarkerOffset;
      }
    } catch (e) {}
    return null;
  }

  function buildHuffmanTree(counts, symbols) {
    const root = {};
    let code = 0;
    for (let len = 1; len <= 16; len++) {
      const syms = symbols[len - 1];
      for (let i = 0; i < syms.length; i++) {
        const sym = syms[i];
        let node = root;
        for (let bit = len - 1; bit >= 0; bit--) {
          const b = (code >> bit) & 1;
          if (!node[b]) node[b] = {};
          node = node[b];
        }
        node.sym = sym;
        code++;
      }
      code <<= 1;
    }
    return root;
  }

  function encodeRgbToJpegDataUrl(width, height, rgb, quality = 80) {
    try {
      const q = Math.max(1, Math.min(100, quality));
      const scale = q < 50 ? Math.floor(5000 / q) : Math.floor(200 - q * 2);

      const defaultYTable = [
        16, 11, 10, 16, 24, 40, 51, 61,
        12, 12, 14, 19, 26, 58, 60, 55,
        14, 13, 16, 24, 40, 57, 69, 56,
        14, 17, 22, 29, 51, 87, 80, 62,
        18, 22, 37, 56, 68, 109, 103, 77,
        24, 35, 55, 64, 81, 104, 113, 92,
        49, 64, 78, 87, 103, 121, 120, 101,
        72, 92, 95, 98, 112, 100, 103, 99
      ];

      const defaultUVTable = [
        17, 18, 24, 47, 99, 99, 99, 99,
        18, 21, 26, 66, 99, 99, 99, 99,
        24, 26, 56, 99, 99, 99, 99, 99,
        47, 66, 99, 99, 99, 99, 99, 99,
        99, 99, 99, 99, 99, 99, 99, 99,
        99, 99, 99, 99, 99, 99, 99, 99,
        99, 99, 99, 99, 99, 99, 99, 99,
        99, 99, 99, 99, 99, 99, 99, 99
      ];

      const yTable = new Uint8Array(64);
      const uvTable = new Uint8Array(64);
      for (let i = 0; i < 64; i++) {
        const yVal = Math.floor((defaultYTable[i] * scale + 50) / 100);
        const uvVal = Math.floor((defaultUVTable[i] * scale + 50) / 100);
        yTable[i] = Math.max(1, Math.min(255, yVal));
        uvTable[i] = Math.max(1, Math.min(255, uvVal));
      }

      const ZIGZAG = [
         0,  1,  8, 16,  9,  2,  3, 10,
        17, 24, 32, 25, 18, 11,  4,  5,
        12, 19, 26, 33, 40, 48, 41, 34,
        27, 20, 13,  6,  7, 14, 21, 28,
        35, 42, 49, 56, 57, 50, 43, 36,
        29, 22, 15, 23, 30, 37, 44, 51,
        58, 59, 52, 45, 38, 31, 39, 46,
        53, 60, 61, 54, 47, 55, 62, 63
      ];

      const yQuant = new Float32Array(64);
      const uvQuant = new Float32Array(64);
      const AAN_SCALE = [1.0, 1.387039845, 1.306562965, 1.175875602, 1.0, 0.785694958, 0.541196100, 0.275899379];
      for (let row = 0; row < 8; row++) {
        for (let col = 0; col < 8; col++) {
          const idx = row * 8 + col;
          yQuant[idx] = 1.0 / (yTable[ZIGZAG[idx]] * AAN_SCALE[row] * AAN_SCALE[col] * 8);
          uvQuant[idx] = 1.0 / (uvTable[ZIGZAG[idx]] * AAN_SCALE[row] * AAN_SCALE[col] * 8);
        }
      }

      const std_dc_lum_nr = [0, 0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
      const std_dc_lum_val = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
      const std_dc_chr_nr = [0, 0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
      const std_dc_chr_val = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

      const std_ac_lum_nr = [0, 0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
      const std_ac_lum_val = [
        0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
        0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
        0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
        0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
        0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
        0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
        0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
        0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
        0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
        0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
        0xf9, 0xfa
      ];

      const std_ac_chr_nr = [0, 0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77];
      const std_ac_chr_val = [
        0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
        0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0,
        0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
        0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
        0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
        0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
        0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5,
        0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3,
        0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
        0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
        0xf9, 0xfa
      ];

      function computeHuffmanTable(nrcodes, values) {
        const huff = [];
        let code = 0;
        let k = 0;
        for (let i = 1; i <= 16; i++) {
          for (let j = 1; j <= nrcodes[i]; j++) {
            huff[values[k]] = { code, len: i };
            k++;
            code++;
          }
          code <<= 1;
        }
        return huff;
      }

      const dcLumHuff = computeHuffmanTable(std_dc_lum_nr, std_dc_lum_val);
      const dcChrHuff = computeHuffmanTable(std_dc_chr_nr, std_dc_chr_val);
      const acLumHuff = computeHuffmanTable(std_ac_lum_nr, std_ac_lum_val);
      const acChrHuff = computeHuffmanTable(std_ac_chr_nr, std_ac_chr_val);

      const byteStream = [];
      let bitBuf = 0;
      let bitCnt = 0;

      function writeBits(code, len) {
        bitBuf = (bitBuf << len) | code;
        bitCnt += len;
        while (bitCnt >= 8) {
          const b = (bitBuf >> (bitCnt - 8)) & 0xFF;
          byteStream.push(b);
          if (b === 0xFF) byteStream.push(0x00);
          bitCnt -= 8;
        }
      }

      function flushBits() {
        if (bitCnt > 0) {
          const b = (bitBuf << (8 - bitCnt)) & 0xFF;
          byteStream.push(b);
          if (b === 0xFF) byteStream.push(0x00);
          bitBuf = 0;
          bitCnt = 0;
        }
      }

      function writeWord(w) {
        byteStream.push((w >> 8) & 0xFF, w & 0xFF);
      }

      writeWord(0xFFD8);
      writeWord(0xFFE0);
      writeWord(16);
      byteStream.push(0x4A, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0);

      writeWord(0xFFDB);
      writeWord(132);
      byteStream.push(0x00);
      for (let i = 0; i < 64; i++) byteStream.push(yTable[ZIGZAG[i]]);
      byteStream.push(0x01);
      for (let i = 0; i < 64; i++) byteStream.push(uvTable[ZIGZAG[i]]);

      writeWord(0xFFC0);
      writeWord(17);
      byteStream.push(8);
      writeWord(height);
      writeWord(width);
      byteStream.push(3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1);

      function writeDHT(nr, val, cls, id) {
        writeWord(0xFFC4);
        writeWord(2 + 1 + 16 + val.length);
        byteStream.push((cls << 4) | id);
        for (let i = 1; i <= 16; i++) byteStream.push(nr[i]);
        for (let i = 0; i < val.length; i++) byteStream.push(val[i]);
      }
      writeDHT(std_dc_lum_nr, std_dc_lum_val, 0, 0);
      writeDHT(std_ac_lum_nr, std_ac_lum_val, 1, 0);
      writeDHT(std_dc_chr_nr, std_dc_chr_val, 0, 1);
      writeDHT(std_ac_chr_nr, std_ac_chr_val, 1, 1);

      writeWord(0xFFDA);
      writeWord(12);
      byteStream.push(3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0);

      function fdct(block, quant) {
        const out = new Int32Array(64);
        const tmp = new Float32Array(64);

        for (let i = 0; i < 8; i++) {
          const i8 = i * 8;
          const d0 = block[i8] + block[i8 + 7];
          const d7 = block[i8] - block[i8 + 7];
          const d1 = block[i8 + 1] + block[i8 + 6];
          const d6 = block[i8 + 1] - block[i8 + 6];
          const d2 = block[i8 + 2] + block[i8 + 5];
          const d5 = block[i8 + 2] - block[i8 + 5];
          const d3 = block[i8 + 3] + block[i8 + 4];
          const d4 = block[i8 + 3] - block[i8 + 4];

          const e0 = d0 + d3;
          const e3 = d0 - d3;
          const e1 = d1 + d2;
          const e2 = d1 - d2;

          tmp[i8] = e0 + e1;
          tmp[i8 + 4] = e0 - e1;
          const z1 = (e2 + e3) * 0.707106781;
          tmp[i8 + 2] = e3 + z1;
          tmp[i8 + 6] = e3 - z1;

          const f0 = d4 + d5;
          const f1 = d5 + d6;
          const f2 = d6 + d7;

          const z2 = (f0 - f2) * 0.382683432;
          const z3 = f0 * 0.541196100 + z2;
          const z4 = f2 * 1.306562965 + z2;
          const z5 = f1 * 0.707106781;

          const g0 = d7 + z5;
          const g1 = d7 - z5;

          tmp[i8 + 5] = g1 + z3;
          tmp[i8 + 3] = g1 - z3;
          tmp[i8 + 1] = g0 + z4;
          tmp[i8 + 7] = g0 - z4;
        }

        for (let j = 0; j < 8; j++) {
          const d0 = tmp[j] + tmp[56 + j];
          const d7 = tmp[j] - tmp[56 + j];
          const d1 = tmp[8 + j] + tmp[48 + j];
          const d6 = tmp[8 + j] - tmp[48 + j];
          const d2 = tmp[16 + j] + tmp[40 + j];
          const d5 = tmp[16 + j] - tmp[40 + j];
          const d3 = tmp[24 + j] + tmp[32 + j];
          const d4 = tmp[24 + j] - tmp[32 + j];

          const e0 = d0 + d3;
          const e3 = d0 - d3;
          const e1 = d1 + d2;
          const e2 = d1 - d2;

          out[j] = Math.round((e0 + e1) * quant[j]);
          out[32 + j] = Math.round((e0 - e1) * quant[32 + j]);
          const z1 = (e2 + e3) * 0.707106781;
          out[16 + j] = Math.round((e3 + z1) * quant[16 + j]);
          out[48 + j] = Math.round((e3 - z1) * quant[48 + j]);

          const f0 = d4 + d5;
          const f1 = d5 + d6;
          const f2 = d6 + d7;

          const z2 = (f0 - f2) * 0.382683432;
          const z3 = f0 * 0.541196100 + z2;
          const z4 = f2 * 1.306562965 + z2;
          const z5 = f1 * 0.707106781;

          const g0 = d7 + z5;
          const g1 = d7 - z5;

          out[40 + j] = Math.round((g1 + z3) * quant[40 + j]);
          out[24 + j] = Math.round((g1 - z3) * quant[24 + j]);
          out[8 + j] = Math.round((g0 + z4) * quant[8 + j]);
          out[56 + j] = Math.round((g0 - z4) * quant[56 + j]);
        }

        return out;
      }

      function encodeCategory(val) {
        if (val === 0) return { bits: 0, len: 0 };
        const absVal = Math.abs(val);
        let len = 0;
        while (absVal >= (1 << len)) len++;
        const bits = val < 0 ? (val + (1 << len) - 1) : val;
        return { bits, len };
      }

      function encodeBlock(block, quant, dcHuff, acHuff, prevDC) {
        const dct = fdct(block, quant);
        const dcDiff = dct[0] - prevDC;
        const dcCat = encodeCategory(dcDiff);
        const dcH = dcHuff[dcCat.len];
        writeBits(dcH.code, dcH.len);
        if (dcCat.len > 0) writeBits(dcCat.bits, dcCat.len);

        let r = 0;
        for (let k = 1; k < 64; k++) {
          const val = dct[ZIGZAG[k]];
          if (val === 0) {
            r++;
          } else {
            while (r > 15) {
              const zrl = acHuff[0xF0];
              writeBits(zrl.code, zrl.len);
              r -= 16;
            }
            const acCat = encodeCategory(val);
            const acSym = (r << 4) | acCat.len;
            const acH = acHuff[acSym];
            writeBits(acH.code, acH.len);
            writeBits(acCat.bits, acCat.len);
            r = 0;
          }
        }
        if (r > 0) {
          const eob = acHuff[0x00];
          writeBits(eob.code, eob.len);
        }
        return dct[0];
      }

      const mcusX = Math.ceil(width / 8);
      const mcusY = Math.ceil(height / 8);
      const yData = new Float32Array(mcusX * 8 * mcusY * 8);
      const cbData = new Float32Array(mcusX * 8 * mcusY * 8);
      const crData = new Float32Array(mcusX * 8 * mcusY * 8);

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const sIdx = (y * width + x) * 3;
          const r = rgb[sIdx];
          const g = rgb[sIdx + 1];
          const b = rgb[sIdx + 2];
          const dIdx = y * (mcusX * 8) + x;
          yData[dIdx] = (0.299 * r + 0.587 * g + 0.114 * b) - 128;
          cbData[dIdx] = (-0.168736 * r - 0.331264 * g + 0.5 * b);
          crData[dIdx] = (0.5 * r - 0.418688 * g - 0.081312 * b);
        }
      }

      let prevYDC = 0, prevCbDC = 0, prevCrDC = 0;
      const yBlock = new Float32Array(64);
      const cbBlock = new Float32Array(64);
      const crBlock = new Float32Array(64);

      for (let mY = 0; mY < mcusY; mY++) {
        for (let mX = 0; mX < mcusX; mX++) {
          for (let r = 0; r < 8; r++) {
            for (let c = 0; c < 8; c++) {
              const sX = Math.min(width - 1, mX * 8 + c);
              const sY = Math.min(height - 1, mY * 8 + r);
              const idx = sY * (mcusX * 8) + sX;
              const bIdx = r * 8 + c;
              yBlock[bIdx] = yData[idx];
              cbBlock[bIdx] = cbData[idx];
              crBlock[bIdx] = crData[idx];
            }
          }
          prevYDC = encodeBlock(yBlock, yQuant, dcLumHuff, acLumHuff, prevYDC);
          prevCbDC = encodeBlock(cbBlock, uvQuant, dcChrHuff, acChrHuff, prevCbDC);
          prevCrDC = encodeBlock(crBlock, uvQuant, dcChrHuff, acChrHuff, prevCrDC);
        }
      }

      flushBits();
      writeWord(0xFFD9);

      const uint8 = new Uint8Array(byteStream);
      return `data:image/jpeg;base64,${bytesToBase64(uint8)}`;
    } catch (e) {
      return null;
    }
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

  /**
   * Convierte un Data URL JPEG en espacio de color CMYK / YCCK a un Data URL JPEG sRGB bajo demanda.
   */
  function convertCmykDataUrlToRgb(dataUrl) {
    if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/jpeg;base64,')) {
      return dataUrl;
    }
    try {
      const b64 = dataUrl.substring('data:image/jpeg;base64,'.length);
      let bytes;
      if (typeof Buffer !== 'undefined') {
        bytes = new Uint8Array(Buffer.from(b64, 'base64'));
      } else if (typeof atob === 'function') {
        const bin = atob(b64);
        bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      } else {
        return dataUrl;
      }
      const converted = convertCmykJpegToRgbDataUrl(bytes);
      return converted || dataUrl;
    } catch (_) {
      return dataUrl;
    }
  }

  return {
    formatBytes,
    parseFile,
    extractTextFromPdf,
    parsePdfDocument,
    convertCmykJpegToRgbDataUrl,
    convertCmykDataUrlToRgb,
    decodePdfShiftedText,
    unshiftAsciiString,
    collapseSpacedLettersAndNumbers,
    collapseVerticallySplitGlyphs,
    parsePdfStreamText
  };
});
