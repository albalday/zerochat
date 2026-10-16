/**
 * Lectura de documentos ofimáticos (ChatOfficeParser).
 *
 * Devuelve `{ text, images }` con el mismo contrato que el lector de PDF: el texto es Markdown
 * y cada imagen incrustada se referencia como `rag-image://__DOC_ID__:<id>`.
 * - docx: mammoth (HTML a Markdown, con tablas y listas).
 * - xlsx, pptx, odt, ods, odp: XML del paquete ZIP leído con fflate (las hojas de cálculo como tabla Markdown con un tope de filas, las presentaciones con marcadores de diapositiva y los textos con marcadores de página).
 * Las librerías se cargan bajo demanda con ChatVendorLoader. Las macros nunca se ejecutan ni se leen.
 */

(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./utils.js'), require('./vendor-loader.js'));
  } else {
    root.ChatOfficeParser = factory(root.ChatUtils, root.ChatVendorLoader);
  }
})(typeof self !== 'undefined' ? self : this, function (Utils, VendorLoader) {
  'use strict';

  const { bytesToBase64, IMAGE_MIME_TYPES } = Utils;

  const OFFICE_FORMATS = {
    docx: {
      extensions: ['docx', 'docm'],
      mimeTypes: [
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-word.document.macroenabled.12'
      ],
      kind: 'Word document'
    },
    xlsx: {
      extensions: ['xlsx', 'xlsm'],
      mimeTypes: [
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-excel.sheet.macroenabled.12'
      ],
      kind: 'Excel spreadsheet'
    },
    pptx: {
      extensions: ['pptx', 'pptm'],
      mimeTypes: [
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'application/vnd.ms-powerpoint.presentation.macroenabled.12'
      ],
      kind: 'PowerPoint presentation'
    },
    odt: {
      extensions: ['odt'],
      mimeTypes: ['application/vnd.oasis.opendocument.text'],
      kind: 'OpenDocument text'
    },
    ods: {
      extensions: ['ods'],
      mimeTypes: ['application/vnd.oasis.opendocument.spreadsheet'],
      kind: 'OpenDocument spreadsheet'
    },
    odp: {
      extensions: ['odp'],
      mimeTypes: ['application/vnd.oasis.opendocument.presentation'],
      kind: 'OpenDocument presentation'
    },
    doc: {
      extensions: ['doc'],
      mimeTypes: ['application/msword'],
      legacy: { name: 'Word 97-2003', modern: 'docx' }
    },
    xls: {
      extensions: ['xls'],
      mimeTypes: ['application/vnd.ms-excel'],
      legacy: { name: 'Excel 97-2003', modern: 'xlsx' }
    },
    ppt: {
      extensions: ['ppt'],
      mimeTypes: ['application/vnd.ms-powerpoint'],
      legacy: { name: 'PowerPoint 97-2003', modern: 'pptx' }
    }
  };

  const FORMATS_BY_EXTENSION = {};
  const FORMATS_BY_MIME_TYPE = {};
  for (const [format, def] of Object.entries(OFFICE_FORMATS)) {
    for (const ext of def.extensions) FORMATS_BY_EXTENSION[ext] = format;
    for (const mime of def.mimeTypes) FORMATS_BY_MIME_TYPE[mime] = format;
  }

  const MAX_SHEET_ROWS = 500;
  const MAX_SHEET_COLUMNS = 50;
  const MAX_IMAGES = 40;
  const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
  const MAX_XML_BYTES = 50 * 1024 * 1024;

  const omittedImage = label => `[Image omitted: ${label}]`;
  const externalImage = label => `[Image not shown: ${label} (linked external image)]`;

  /**
   * Formato ofimático (`docx`, `xlsx`, `pptx`, `odt`, `ods`, `odp` o los antiguos `doc`, `xls`, `ppt`)
   * por extensión o, si no la hay, por tipo MIME; '' si no es un documento ofimático.
   */
  function getOfficeFormat(fileName, mimeType = '') {
    const match = String(fileName || '').toLowerCase().match(/\.([a-z]+)$/);
    return (match && FORMATS_BY_EXTENSION[match[1]])
      || FORMATS_BY_MIME_TYPE[String(mimeType || '').toLowerCase().split(';')[0].trim()]
      || '';
  }

  /** Nombre legible del tipo de documento para cabeceras de contexto («Word document»…). */
  function getOfficeDocumentKind(format) {
    return OFFICE_FORMATS[format]?.kind || 'Office document';
  }

  /**
   * Sustituye las referencias `rag-image://__DOC_ID__:img_N` por texto donde no hay base de conocimiento
   * (adjuntos y herramientas web). Las `attachedCount` primeras se indican como imágenes adjuntas.
   */
  function replaceImageReferences(text, attachedCount = 0) {
    return String(text || '').replace(/!\[([^\]]*)\]\(rag-image:\/\/__DOC_ID__:img_(\d+)\)/g, (match, label, number) => (
      Number(number) <= attachedCount ? `[Image: ${label} (attached image ${number})]` : `[Image: ${label}]`
    ));
  }

  // --- Imágenes -------------------------------------------------------------

  function createImageCollector() {
    const images = [];
    return {
      images,
      /** Registra una imagen y devuelve `{ id, markdown }`, o marcador de texto si no puede mostrarse. */
      add({ bytes = null, base64 = '', extension = '', page = 1, label }) {
        const ext = String(extension).toLowerCase().replace(/^x-/, '').replace(/\+xml$/, '');
        const mimeType = IMAGE_MIME_TYPES[ext];
        if (!mimeType) return { id: null, markdown: `[Image not shown: ${label} (${(ext || 'unknown').toUpperCase()} format is not supported)]` };
        const sizeBytes = bytes ? bytes.length : Math.floor(base64.length * 3 / 4);
        if (images.length >= MAX_IMAGES || sizeBytes > MAX_IMAGE_BYTES) return { id: null, markdown: omittedImage(label) };
        const id = `img_${images.length + 1}`;
        images.push({ id, page, width: 0, height: 0, sizeBytes, mimeType, dataUrl: `data:${mimeType};base64,${base64 || bytesToBase64(bytes)}`, label });
        return { id, markdown: `![${label}](rag-image://__DOC_ID__:${id})` };
      }
    };
  }

  // --- Markdown -------------------------------------------------------------

  function markdownTable(rows) {
    const width = Math.max(1, ...rows.map(row => row.length));
    const cell = value => String(value ?? '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
    const lines = rows.map(row => `| ${Array.from({ length: width }, (_, i) => cell(row[i])).join(' | ')} |`);
    lines.splice(1, 0, `| ${Array(width).fill('---').join(' | ')} |`);
    return lines.join('\n');
  }

  /** Recorta filas y columnas vacías al final y aplica los topes de hoja. */
  function sheetSection(name, rows, totalRows, imageRefs = []) {
    const isEmpty = value => String(value ?? '').trim() === '';
    const kept = rows.map(row => row.slice(0, MAX_SHEET_COLUMNS));
    const width = kept.reduce((max, row) => {
      let last = row.length;
      while (last > 0 && isEmpty(row[last - 1])) last--;
      return Math.max(max, last);
    }, 0);
    const parts = [`## Sheet: ${name}`];
    if (!kept.length || !width) parts.push('[Empty sheet]');
    else parts.push(markdownTable(kept.map(row => row.slice(0, width))));
    if (totalRows > kept.length && kept.length >= MAX_SHEET_ROWS) parts.push(`[Showing the first ${MAX_SHEET_ROWS} of ${totalRows} rows]`);
    parts.push(...imageRefs);
    return parts.join('\n\n');
  }

  function joinBlocks(blocks) {
    return blocks.filter(block => block && block.trim()).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function section(marker, blocks) {
    const content = joinBlocks(blocks);
    if (!marker) return content;
    return content ? `${marker}\n${content}` : marker;
  }

  // --- XML ------------------------------------------------------------------

  const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

  function decodeXml(text) {
    return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity) => {
      if (entity[0] !== '#') return XML_ENTITIES[entity.toLowerCase()];
      const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      try { return String.fromCodePoint(code); } catch (_) { return match; }
    });
  }

  function parseAttributes(source) {
    const attributes = {};
    for (const [, name, , doubleQuoted, singleQuoted] of source.matchAll(/([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
      attributes[name] = decodeXml(doubleQuoted ?? singleQuoted);
    }
    return attributes;
  }

  /** Recorre un XML como flujo de etiquetas (SAX mínimo); suficiente para el marcado de Office y ODF. */
  function walkXml(xml, { open = () => {}, close = () => {}, text = () => {} }) {
    const tokens = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<[?!][^>]*>|<(\/?)([^\s>/]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)/g;
    for (const [, cdata, closing, name, attributes, selfClosing, content] of xml.matchAll(tokens)) {
      if (cdata !== undefined) text(cdata);
      else if (content !== undefined) text(decodeXml(content));
      else if (!name) continue;
      else if (closing) close(name);
      else {
        open(name, parseAttributes(attributes));
        if (selfClosing) close(name);
      }
    }
  }

  // --- Paquetes ZIP ---------------------------------------------------------

  async function openPackage(arrayBuffer) {
    const fflate = await VendorLoader.load('fflate');
    const files = fflate.unzipSync(new Uint8Array(arrayBuffer), {
      filter: file => file.originalSize <= (/\.(?:xml|rels)$/i.test(file.name) ? MAX_XML_BYTES : MAX_IMAGE_BYTES)
    });
    return {
      text: path => (files[path] ? fflate.strFromU8(files[path]) : ''),
      bytes: path => files[path] || null
    };
  }

  function resolvePackagePath(baseDir, target) {
    const segments = target.startsWith('/') ? [] : baseDir.split('/').filter(Boolean);
    for (const segment of target.split('/')) {
      if (segment === '..') segments.pop();
      else if (segment && segment !== '.') segments.push(segment);
    }
    return segments.join('/');
  }

  function directoryOf(path) {
    return path.slice(0, path.lastIndexOf('/') + 1);
  }

  /** Relaciones OOXML (`_rels/*.rels`): rId -> { path, type, external }. */
  function readRelationships(pkg, partPath) {
    const relsPath = `${directoryOf(partPath)}_rels/${partPath.slice(partPath.lastIndexOf('/') + 1)}.rels`;
    const relationships = {};
    walkXml(pkg.text(relsPath), {
      open(name, attrs) {
        if (name !== 'Relationship' || !attrs.Id) return;
        const external = attrs.TargetMode === 'External';
        relationships[attrs.Id] = {
          path: external ? attrs.Target : resolvePackagePath(directoryOf(partPath), attrs.Target || ''),
          type: String(attrs.Type || '').split('/').pop(),
          external
        };
      }
    });
    return relationships;
  }

  function extensionOf(path) {
    const match = String(path).toLowerCase().match(/\.([a-z0-9]+)$/);
    return match ? match[1] : '';
  }

  function packageImage(pkg, collector, path, page, label) {
    const bytes = pkg.bytes(path);
    if (!bytes) return omittedImage(label);
    return collector.add({ bytes, extension: extensionOf(path), page, label }).markdown;
  }

  /** Markdown de una imagen OOXML según su relación: omitida si falta, marcador si es externa, o incrustada. */
  function relatedImage(pkg, collector, relation, page, label) {
    if (!relation) return omittedImage(label);
    if (relation.external) return externalImage(label);
    return packageImage(pkg, collector, relation.path, page, label);
  }

  // --- docx -----------------------------------------------------------------

  function wrapInline(text, marker) {
    const match = text.match(/^(\s*)([\s\S]*?)(\s*)$/);
    return match[2] ? `${match[1]}${marker}${match[2]}${marker}${match[3]}` : text;
  }

  function inlineMarkdown(node) {
    let out = '';
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        out += child.textContent.replace(/\s+/g, ' ');
        continue;
      }
      if (child.nodeType !== 1) continue;
      const tag = child.tagName.toLowerCase();
      if (tag === 'br') { out += '\n'; continue; }
      if (tag === 'img') {
        const src = child.getAttribute('src') || '';
        const alt = child.getAttribute('alt') || '';
        out += src.startsWith('rag-image://') ? `\n\n![${alt}](${src})\n\n` : `\n\n${alt}\n\n`;
        continue;
      }
      if (tag === 'ul' || tag === 'ol' || tag === 'table') { out += `\n\n${blockMarkdown(child)}\n\n`; continue; }
      const inner = inlineMarkdown(child);
      if (tag === 'strong' || tag === 'b') out += wrapInline(inner, '**');
      else if (tag === 'em' || tag === 'i') out += wrapInline(inner, '*');
      else if (tag === 's' || tag === 'del') out += wrapInline(inner, '~~');
      else if (tag === 'a') {
        const href = child.getAttribute('href') || '';
        out += /^(?:https?:|mailto:)/i.test(href) && inner.trim() ? `[${inner.trim()}](${href})` : inner;
      } else if (tag === 'p') out += (out.trim() ? ' ' : '') + inner;
      else out += inner;
    }
    return out;
  }

  function listMarkdown(list, depth) {
    const ordered = list.tagName.toLowerCase() === 'ol';
    const lines = [];
    let index = 0;
    for (const item of list.children) {
      if (item.tagName.toLowerCase() !== 'li') continue;
      index++;
      const nested = [];
      const content = item.ownerDocument.createElement('span');
      for (const child of [...item.childNodes]) {
        if (child.nodeType === 1 && /^(?:ul|ol)$/i.test(child.tagName)) nested.push(child);
        else content.appendChild(child.cloneNode(true));
      }
      lines.push(`${'  '.repeat(depth)}${ordered ? `${index}.` : '-'} ${inlineMarkdown(content).trim()}`);
      for (const sub of nested) lines.push(listMarkdown(sub, depth + 1));
    }
    return lines.join('\n');
  }

  function blockMarkdown(node) {
    const tag = node.tagName.toLowerCase();
    const heading = tag.match(/^h([1-6])$/);
    if (heading) return `${'#'.repeat(Number(heading[1]))} ${inlineMarkdown(node).trim()}`;
    if (tag === 'ul' || tag === 'ol') return listMarkdown(node, 0);
    if (tag === 'table') {
      const rows = [...node.querySelectorAll('tr')].map(row => [...row.children].map(cell => inlineMarkdown(cell)));
      return rows.length ? markdownTable(rows) : '';
    }
    return inlineMarkdown(node).trim();
  }

  function htmlToMarkdown(html) {
    const doc = new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, 'text/html');
    return joinBlocks([...doc.body.children].map(blockMarkdown));
  }

  async function parseDocx(arrayBuffer) {
    const mammoth = await VendorLoader.load('mammoth');
    const collector = createImageCollector();
    let index = 0;
    const convertImage = mammoth.images.imgElement(async image => {
      index++;
      const label = String(image.altText || '').trim() || `Image ${index}`;
      const extension = String(image.contentType || '').split('/')[1] || '';
      let base64 = '';
      try {
        base64 = await image.readAsBase64String();
      } catch (_) {
        return { src: '', alt: externalImage(label) };
      }
      const { id, markdown } = collector.add({ base64, extension, label });
      return id ? { src: `rag-image://__DOC_ID__:${id}`, alt: label } : { src: '', alt: markdown };
    });
    const result = await mammoth.convertToHtml({ arrayBuffer }, { convertImage });
    return { text: htmlToMarkdown(result.value), images: collector.images };
  }

  // --- xlsx -----------------------------------------------------------------

  /** Como walkXml, pero con los nombres de etiqueta sin prefijo de espacio de nombres (`x:row` -> `row`). */
  function walkLocalXml(xml, { open = () => {}, close = () => {}, text = () => {} }) {
    const local = name => name.slice(name.indexOf(':') + 1);
    walkXml(xml, { open: (name, attrs) => open(local(name), attrs), close: name => close(local(name)), text });
  }

  function colRefToIndex(ref) {
    const match = String(ref || '').match(/^[A-Z]+/i);
    if (!match) return -1;
    const letters = match[0].toUpperCase();
    let index = 0;
    for (let i = 0; i < letters.length; i++) {
      index = index * 26 + (letters.charCodeAt(i) - 64);
    }
    return index - 1;
  }

  // Días entre la época Unix y el origen de los números de serie de Excel (1899-12-30, o 1904-01-01 si `date1904`).
  const EXCEL_EPOCH_DAYS = 25569;
  const EXCEL_EPOCH_DAYS_1904 = 24107;

  function excelSerialToDate(serial, date1904) {
    const iso = new Date(Math.round((serial - (date1904 ? EXCEL_EPOCH_DAYS_1904 : EXCEL_EPOCH_DAYS)) * 86400 * 1000)).toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.replace('.000Z', 'Z');
  }

  function readSharedStrings(pkg) {
    const strings = [];
    let inT = false;
    let inPhonetic = false;
    let current = '';
    walkLocalXml(pkg.text('xl/sharedStrings.xml'), {
      open(name) {
        if (name === 'si') current = '';
        else if (name === 't') inT = true;
        else if (name === 'rPh') inPhonetic = true;
      },
      close(name) {
        if (name === 'si') strings.push(current);
        else if (name === 't') inT = false;
        else if (name === 'rPh') inPhonetic = false;
      },
      text(value) {
        if (inT && !inPhonetic) current += value;
      }
    });
    return strings;
  }

  /** Para cada estilo de celda (`cellXfs`), si su formato numérico es de fecha u hora. */
  function readDateStyles(pkg) {
    const customNumFmts = new Map();
    const cellXfDates = [];
    let inCellXfs = false;
    walkLocalXml(pkg.text('xl/styles.xml'), {
      open(name, attrs) {
        if (name === 'cellXfs') inCellXfs = true;
        else if (name === 'numFmt') {
          if (attrs.numFmtId && attrs.formatCode) customNumFmts.set(attrs.numFmtId, attrs.formatCode);
        } else if (name === 'xf' && inCellXfs) {
          const numFmtId = parseInt(attrs.numFmtId || '0', 10);
          let isDate = (numFmtId >= 14 && numFmtId <= 22) || (numFmtId >= 45 && numFmtId <= 47);
          if (!isDate && customNumFmts.has(attrs.numFmtId)) {
            const cleaned = customNumFmts.get(attrs.numFmtId).replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '');
            isDate = /(?:[ydhms]|am\/pm)/i.test(cleaned);
          }
          cellXfDates.push(isDate);
        }
      },
      close(name) {
        if (name === 'cellXfs') inCellXfs = false;
      }
    });
    return cellXfDates;
  }

  /** Hojas de cálculo del libro en orden (`{ name, hidden, path }`; las hojas de gráfico se ignoran) y su sistema de fechas. */
  function readWorkbook(pkg) {
    const xml = pkg.text('xl/workbook.xml');
    if (!xml) throw new Error('xl/workbook.xml is missing');
    const relationships = readRelationships(pkg, 'xl/workbook.xml');
    const sheets = [];
    let date1904 = false;
    walkLocalXml(xml, {
      open(name, attrs) {
        if (name === 'workbookPr') {
          date1904 = /^(?:1|true)$/i.test(attrs.date1904 || '');
        } else if (name === 'sheet' && attrs.name) {
          const relation = relationships[attrs['r:id']];
          if (relation?.type === 'worksheet' && !relation.external) {
            sheets.push({ name: attrs.name, hidden: Boolean(attrs.state) && attrs.state !== 'visible', path: relation.path });
          }
        }
      }
    });
    return { sheets, date1904 };
  }

  function xlsxCellValue({ type, style }, valueText, inlineText, { sharedStrings, dateStyles, date1904 }) {
    const value = valueText.trim();
    switch (type) {
      case 's': return sharedStrings[parseInt(value, 10)] ?? '';
      case 'inlineStr': return inlineText;
      case 'b': return value === '1' ? 'TRUE' : 'FALSE';
      case 'str': case 'e': return value;
      default: {
        const serial = Number(value);
        return value && dateStyles[style] && Number.isFinite(serial) ? excelSerialToDate(serial, date1904) : value;
      }
    }
  }

  /** Filas con contenido de una hoja (con el tope de filas y columnas) y el rId de su dibujo, si lo tiene. */
  function readSheetRows(xml, context) {
    const rows = [];
    let totalRows = 0;
    let drawingRId = null;
    let row = null;
    let column = -1;
    let cell = null;
    let inValue = false;
    let inText = false;
    let inPhonetic = false;
    let valueText = '';
    let inlineText = '';
    walkLocalXml(xml, {
      open(name, attrs) {
        if (name === 'drawing') drawingRId = attrs['r:id'] || null;
        else if (name === 'row') { row = []; column = -1; }
        else if (name === 'c' && row) {
          column = attrs.r ? colRefToIndex(attrs.r) : column + 1;
          cell = { column, type: attrs.t || 'n', style: parseInt(attrs.s || '0', 10) };
          valueText = '';
          inlineText = '';
        } else if (name === 'v') inValue = true;
        else if (name === 't') inText = true;
        else if (name === 'rPh') inPhonetic = true;
      },
      close(name) {
        if (name === 'v') inValue = false;
        else if (name === 't') inText = false;
        else if (name === 'rPh') inPhonetic = false;
        else if (name === 'c' && cell) {
          if (cell.column >= 0 && cell.column < MAX_SHEET_COLUMNS) {
            while (row.length < cell.column) row.push('');
            row[cell.column] = xlsxCellValue(cell, valueText, inlineText, context);
          }
          cell = null;
        } else if (name === 'row' && row) {
          if (row.some(value => value.trim() !== '')) {
            totalRows++;
            if (rows.length < MAX_SHEET_ROWS) rows.push(row);
          }
          row = null;
        }
      },
      text(value) {
        if (inValue) valueText += value;
        else if (inText && !inPhonetic) inlineText += value;
      }
    });
    return { rows, totalRows, drawingRId };
  }

  function readSheetImages(pkg, collector, sheet, drawingRId, page) {
    const drawingPath = readRelationships(pkg, sheet.path)[drawingRId]?.path;
    if (!drawingPath) return [];
    const relationships = readRelationships(pkg, drawingPath);
    const images = [];
    walkLocalXml(pkg.text(drawingPath), {
      open(name, attrs) {
        if (name !== 'blip') return;
        const label = `Image ${images.length + 1} (sheet "${sheet.name}")`;
        images.push(relatedImage(pkg, collector, relationships[attrs['r:embed'] || attrs['r:link']], page, label));
      }
    });
    return images;
  }

  async function parseXlsx(arrayBuffer) {
    const pkg = await openPackage(arrayBuffer);
    const { sheets, date1904 } = readWorkbook(pkg);
    const context = { sharedStrings: readSharedStrings(pkg), dateStyles: readDateStyles(pkg), date1904 };
    const collector = createImageCollector();
    const sections = sheets.map((sheet, index) => {
      const { rows, totalRows, drawingRId } = readSheetRows(pkg.text(sheet.path), context);
      const images = drawingRId ? readSheetImages(pkg, collector, sheet, drawingRId, index + 1) : [];
      return sheetSection(sheet.hidden ? `${sheet.name} (hidden)` : sheet.name, rows, totalRows, images);
    });
    return { text: joinBlocks(sections), images: collector.images };
  }

  // --- pptx -----------------------------------------------------------------

  function slideOrder(pkg) {
    const relationships = readRelationships(pkg, 'ppt/presentation.xml');
    const slides = [];
    walkXml(pkg.text('ppt/presentation.xml'), {
      open(name, attrs) {
        if (name === 'p:sldId' && relationships[attrs['r:id']]) slides.push(relationships[attrs['r:id']].path);
      }
    });
    return slides;
  }

  /** Texto, tablas e imágenes de una diapositiva o de sus notas. */
  function readSlidePart(pkg, partPath, collector, slideNumber, { images = true } = {}) {
    const relationships = readRelationships(pkg, partPath);
    const blocks = [];
    let paragraph = null;
    let isTitle = false;
    let skipDepth = 0;
    let table = null;
    let row = null;
    let cell = null;
    let imageCount = 0;
    walkXml(pkg.text(partPath), {
      open(name, attrs) {
        if (skipDepth) { skipDepth++; return; }
        if (name === 'a:fld' && attrs.type === 'slidenum') { skipDepth = 1; return; }
        if (name === 'p:sp') isTitle = false;
        else if (name === 'p:ph' && /^(?:title|ctrTitle)$/.test(attrs.type || '')) isTitle = true;
        else if (name === 'a:p') paragraph = '';
        else if (name === 'a:br' && paragraph !== null) paragraph += ' ';
        else if (name === 'a:tbl') table = [];
        else if (name === 'a:tr' && table) row = [];
        else if (name === 'a:tc' && row) cell = [];
        else if (name === 'a:blip' && images) {
          imageCount++;
          const label = `Image ${imageCount} (slide ${slideNumber})`;
          blocks.push(relatedImage(pkg, collector, relationships[attrs['r:embed'] || attrs['r:link']], slideNumber, label));
        }
      },
      close(name) {
        if (skipDepth) { skipDepth--; return; }
        if (name === 'a:p' && paragraph !== null) {
          const text = paragraph.trim();
          if (cell) cell.push(text);
          else if (text) blocks.push(isTitle ? `## ${text}` : text);
          paragraph = null;
        } else if (name === 'a:tc' && cell) { row.push(cell.join(' ')); cell = null; }
        else if (name === 'a:tr' && row) { table.push(row); row = null; }
        else if (name === 'a:tbl' && table) { if (table.length) blocks.push(markdownTable(table)); table = null; }
      },
      text(value) {
        if (!skipDepth && paragraph !== null) paragraph += value;
      }
    });
    return { blocks, relationships };
  }

  async function parsePptx(arrayBuffer) {
    const pkg = await openPackage(arrayBuffer);
    if (!pkg.text('ppt/presentation.xml')) throw new Error('ppt/presentation.xml is missing');
    const collector = createImageCollector();
    const sections = slideOrder(pkg).map((slidePath, index) => {
      const slideNumber = index + 1;
      const { blocks, relationships } = readSlidePart(pkg, slidePath, collector, slideNumber);
      const notes = Object.values(relationships).find(relation => relation.type === 'notesSlide' && !relation.external);
      if (notes) {
        const noteText = readSlidePart(pkg, notes.path, collector, slideNumber, { images: false }).blocks.join(' ').trim();
        if (noteText) blocks.push(`Notes: ${noteText}`);
      }
      return section(`--- Slide ${slideNumber} ---`, blocks);
    });
    return { text: joinBlocks(sections), images: collector.images };
  }

  // --- OpenDocument (odt, ods, odp) -----------------------------------------

  function repeatCount(value, cap) {
    const count = Number.parseInt(value, 10);
    return Math.min(Number.isFinite(count) && count > 0 ? count : 1, cap);
  }

  /** Estilos de lista numerados por nivel (`estilo|nivel`), definidos en styles.xml. */
  function readNumberedListStyles(pkg) {
    const numbered = new Set();
    let current = '';
    walkXml(pkg.text('styles.xml'), {
      open(name, attrs) {
        if (name === 'text:list-style') current = attrs['style:name'] || '';
        else if (name === 'text:list-level-style-number' && current) numbered.add(`${current}|${attrs['text:level'] || 1}`);
      },
      close(name) {
        if (name === 'text:list-style') current = '';
      }
    });
    return numbered;
  }

  // Marcos de cabecera, pie, fecha y número de página de las diapositivas y sus notas.
  const ODF_SKIPPED_FRAME_CLASSES = new Set(['header', 'footer', 'date-time', 'page-number', 'page']);

  function readOpenDocument(pkg, format, collector) {
    const numberedListStyles = readNumberedListStyles(pkg);
    let listStyle = '';
    const sections = [];
    let currentBlocks = [];
    const links = [];
    const paragraphs = [];
    const lists = [];
    const footnotes = [];
    let skipDepth = 0;
    let noteDepth = 0;
    let page = 1;
    let slide = 0;
    let frameClass = '';
    let frameHasImage = false;
    let notesDepth = 0;
    let slideNotes = [];
    let table = null;
    let row = null;
    let cell = null;
    let imageCount = 0;

    function currentLocation() {
      if (format === 'odp') return { page: slide, where: `slide ${slide}` };
      if (format === 'ods') return { page: 1, where: `sheet "${table?.name || ''}"` };
      return { page, where: `page ${page}` };
    }

    const target = () => (paragraphs.length ? paragraphs[paragraphs.length - 1] : null);

    function emitBlock(text) {
      if (!text) return;
      if (noteDepth) footnotes.push(text);
      else if (notesDepth) slideNotes.push(text);
      else if (cell) cell.parts.push(text);
      else if (format === 'ods' && table) table.images.push(text);
      else if (lists.length) {
        const list = lists[lists.length - 1];
        const indent = '  '.repeat(lists.length - 1);
        lists[0].lines.push(list.itemStarted ? `${indent}  ${text}` : `${indent}${list.ordered ? `${list.index}.` : '-'} ${text}`);
        list.itemStarted = true;
      } else currentBlocks.push(text);
    }

    function addImage(href) {
      imageCount++;
      const { page: locPage, where } = currentLocation();
      const label = `Image ${imageCount} (${where})`;
      const markdown = /^[a-z][a-z0-9+.-]*:/i.test(href)
        ? externalImage(label)
        : packageImage(pkg, collector, resolvePackagePath('', href), locPage, label);
      const paragraph = target();
      if (format === 'ods' && table) table.images.push(markdown);
      else if (paragraph) paragraph.text += ` ${markdown} `;
      else emitBlock(markdown);
    }

    walkXml(pkg.text('content.xml'), {
      open(name, attrs) {
        if (skipDepth) { skipDepth++; return; }
        switch (name) {
          case 'text:list-style':
            listStyle = attrs['style:name'] || '';
            break;
          case 'text:list-level-style-number':
            if (listStyle) numberedListStyles.add(`${listStyle}|${attrs['text:level'] || 1}`);
            break;
          case 'office:annotation': case 'text:tracked-changes': case 'text:note-citation':
          case 'text:page-number': case 'text:page-count': case 'draw:page-thumbnail':
            skipDepth = 1; break;
          case 'text:note': noteDepth++; break;
          case 'presentation:notes': notesDepth++; break;
          case 'draw:page':
            if (slide > 0) sections.push(section(`--- Slide ${slide} ---`, currentBlocks));
            slide++;
            currentBlocks = [];
            slideNotes = [];
            break;
          case 'draw:frame':
            frameClass = attrs['presentation:class'] || '';
            frameHasImage = false;
            if (ODF_SKIPPED_FRAME_CLASSES.has(frameClass)) skipDepth = 1;
            break;
          case 'draw:image':
            // LibreOffice guarda varias versiones (p. ej. SVG y PNG) de la misma imagen en un marco.
            if (!frameHasImage && attrs['xlink:href']) addImage(attrs['xlink:href']);
            frameHasImage = true;
            break;
          case 'text:soft-page-break':
            if (format === 'odt') {
              page++;
              sections.push(currentBlocks);
              currentBlocks = [];
            }
            break;
          case 'text:h':
            paragraphs.push({ text: '', heading: repeatCount(attrs['text:outline-level'], 6) });
            break;
          case 'text:p':
            paragraphs.push({ text: '', heading: format === 'odp' && frameClass === 'title' ? 2 : 0 });
            break;
          case 'text:s': if (target()) target().text += ' '.repeat(repeatCount(attrs['text:c'], 100)); break;
          case 'text:tab': case 'text:line-break': if (target()) target().text += ' '; break;
          case 'text:a':
            if (target()) links.push({ paragraph: target(), start: target().text.length, href: attrs['xlink:href'] || '' });
            break;
          case 'text:list': {
            const style = attrs['text:style-name'] || lists[lists.length - 1]?.style || '';
            lists.push({ itemStarted: false, index: 0, style, ordered: numberedListStyles.has(`${style}|${lists.length + 1}`), lines: [] });
            break;
          }
          case 'text:list-item':
            if (lists.length) Object.assign(lists[lists.length - 1], { itemStarted: false, index: lists[lists.length - 1].index + 1 });
            break;
          case 'table:table':
            table = { name: attrs['table:name'] || `Sheet ${currentBlocks.length + 1}`, rows: [], totalRows: 0, images: [] };
            break;
          case 'table:table-row':
            if (table) row = { cells: [], repeat: repeatCount(attrs['table:number-rows-repeated'], MAX_SHEET_ROWS) };
            break;
          case 'table:table-cell': case 'table:covered-table-cell':
            if (row) cell = { parts: [], repeat: repeatCount(attrs['table:number-columns-repeated'], MAX_SHEET_COLUMNS) };
            break;
        }
      },
      close(name) {
        if (skipDepth) { skipDepth--; return; }
        switch (name) {
          case 'text:list-style': listStyle = ''; break;
          case 'text:note': noteDepth--; break;
          case 'presentation:notes':
            notesDepth--;
            if (slideNotes.length) currentBlocks.push(`Notes: ${slideNotes.join(' ')}`);
            break;
          case 'draw:frame': frameClass = ''; break;
          case 'text:a': {
            const link = links.pop();
            if (!link) break;
            const label = link.paragraph.text.slice(link.start).trim();
            if (label && /^(?:https?:|mailto:)/i.test(link.href)) link.paragraph.text = `${link.paragraph.text.slice(0, link.start)}[${label}](${link.href})`;
            break;
          }
          case 'text:h': case 'text:p': {
            const paragraph = paragraphs.pop();
            const text = paragraph.text.replace(/\s+/g, ' ').trim();
            emitBlock(text && paragraph.heading ? `${'#'.repeat(paragraph.heading)} ${text}` : text);
            break;
          }
          case 'text:list': {
            const list = lists.pop();
            if (!lists.length) emitBlock(list.lines.join('\n'));
            break;
          }
          case 'table:table-cell': case 'table:covered-table-cell':
            if (row && cell) {
              const value = cell.parts.join(' ');
              for (let i = 0; i < cell.repeat && row.cells.length < MAX_SHEET_COLUMNS; i++) row.cells.push(value);
              cell = null;
            }
            break;
          case 'table:table-row':
            if (table && row) {
              const hasContent = row.cells.some(value => value.trim());
              if (hasContent) {
                table.totalRows += row.repeat;
                const toPush = Math.min(row.repeat, Math.max(0, MAX_SHEET_ROWS - table.rows.length));
                for (let i = 0; i < toPush; i++) table.rows.push(row.cells);
              }
              row = null;
            }
            break;
          case 'table:table':
            if (table) {
              const finished = table;
              table = null;
              if (format === 'ods') currentBlocks.push(sheetSection(finished.name, finished.rows, finished.totalRows, finished.images));
              else {
                const rows = finished.rows.filter(cells => cells.some(value => value.trim()));
                emitBlock(rows.length ? markdownTable(rows) : '');
              }
            }
            break;
        }
      },
      text(value) {
        if (!skipDepth && target()) target().text += value;
      }
    });

    if (footnotes.length) currentBlocks.push('Footnotes:', footnotes.map((note, i) => `${i + 1}. ${note}`).join('\n'));
    if (format === 'odp') {
      if (slide > 0) sections.push(section(`--- Slide ${slide} ---`, currentBlocks));
      return joinBlocks(sections);
    }
    if (format === 'odt' && sections.length) {
      sections.push(currentBlocks);
      return joinBlocks(sections.map((blks, i) => section(`--- Page ${i + 1} ---`, blks)));
    }
    return joinBlocks(currentBlocks);
  }

  async function parseOpenDocument(arrayBuffer, format) {
    const pkg = await openPackage(arrayBuffer);
    if (!pkg.text('content.xml')) throw new Error('content.xml is missing');
    const collector = createImageCollector();
    return { text: readOpenDocument(pkg, format, collector), images: collector.images };
  }

  // --- API ------------------------------------------------------------------

  const PARSERS = {
    docx: parseDocx,
    xlsx: parseXlsx,
    pptx: parsePptx,
    odt: buffer => parseOpenDocument(buffer, 'odt'),
    ods: buffer => parseOpenDocument(buffer, 'ods'),
    odp: buffer => parseOpenDocument(buffer, 'odp')
  };

  /**
   * Extrae `{ format, text, images }` de un documento ofimático según la extensión de `fileName` o su tipo MIME.
   * Los formatos binarios antiguos (.doc, .xls, .ppt) se rechazan con un mensaje claro.
   */
  async function parseOfficeDocument(arrayBuffer, fileName, mimeType = '') {
    const format = getOfficeFormat(fileName, mimeType);
    const legacy = OFFICE_FORMATS[format]?.legacy;
    if (legacy) {
      throw new Error(`${legacy.name} files (.${format}) are not supported. Save the file as .${legacy.modern} and try again.`);
    }
    const parse = PARSERS[format];
    if (!parse) throw new Error(`${fileName} is not a supported office document.`);
    let result;
    try {
      result = await parse(arrayBuffer);
    } catch (error) {
      if (error?.code === 'VENDOR_UNAVAILABLE') throw error;
      throw new Error(`The ${getOfficeDocumentKind(format)} could not be read. It may be damaged or password protected.`, { cause: error });
    }
    return { format, text: result.text || '[The document contains no readable text.]', images: result.images };
  }

  function isOfficeFormat(format) {
    return Boolean(OFFICE_FORMATS[format]);
  }

  async function parseOfficeFile(file) {
    return parseOfficeDocument(await file.arrayBuffer(), file?.name || '', file?.type || '');
  }

  return { getOfficeFormat, isOfficeFormat, getOfficeDocumentKind, replaceImageReferences, parseOfficeDocument, parseOfficeFile };
});
