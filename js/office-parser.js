/**
 * Lectura de documentos ofimáticos (ChatOfficeParser).
 *
 * Devuelve `{ text, images }` con el mismo contrato que el lector de PDF: el texto es Markdown
 * y cada imagen incrustada se referencia como `rag-image://__DOC_ID__:<id>`.
 * - docx: mammoth (HTML a Markdown, con tablas y listas).
 * - xlsx: ExcelJS, cada hoja como tabla Markdown con un tope de filas.
 * - pptx, odt, ods, odp: XML del paquete ZIP leído con fflate, con marcadores de diapositiva o página.
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

  const { bytesToBase64 } = Utils;

  const FORMATS_BY_EXTENSION = {
    docx: 'docx', docm: 'docx',
    xlsx: 'xlsx', xlsm: 'xlsx',
    pptx: 'pptx', pptm: 'pptx',
    odt: 'odt', ods: 'ods', odp: 'odp',
    doc: 'doc', xls: 'xls', ppt: 'ppt'
  };
  const FORMAT_NAMES = {
    docx: 'Word', xlsx: 'Excel', pptx: 'PowerPoint',
    odt: 'OpenDocument text', ods: 'OpenDocument spreadsheet', odp: 'OpenDocument presentation'
  };
  const LEGACY_FORMATS = {
    doc: { name: 'Word 97-2003', modern: 'docx' },
    xls: { name: 'Excel 97-2003', modern: 'xlsx' },
    ppt: { name: 'PowerPoint 97-2003', modern: 'pptx' }
  };
  // Mismos tipos que admite ChatUtils.sanitizeImageUrl para poder mostrarse en el chat.
  const IMAGE_MIME_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
  const MAX_SHEET_ROWS = 500;
  const MAX_SHEET_COLUMNS = 50;
  const MAX_IMAGES = 40;
  const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
  const MAX_XML_BYTES = 50 * 1024 * 1024;

  /** Formato ofimático por extensión (`docx`, `xlsx`, `pptx`, `odt`, `ods`, `odp` o los antiguos `doc`, `xls`, `ppt`), o ''. */
  function getOfficeFormat(fileName) {
    const match = String(fileName || '').toLowerCase().match(/\.([a-z]+)$/);
    return (match && FORMATS_BY_EXTENSION[match[1]]) || '';
  }

  // --- Imágenes -------------------------------------------------------------

  function createImageCollector() {
    const images = [];
    return {
      images,
      /** Registra una imagen y devuelve su Markdown, o un marcador de texto si no puede mostrarse. */
      add({ bytes = null, base64 = '', extension = '', page = 1, label }) {
        const ext = String(extension).toLowerCase().replace(/^x-/, '').replace(/\+xml$/, '');
        const mimeType = IMAGE_MIME_TYPES[ext];
        if (!mimeType) return `[Image not shown: ${label} (${(ext || 'unknown').toUpperCase()} format is not supported)]`;
        const sizeBytes = bytes ? bytes.length : Math.floor(base64.length * 3 / 4);
        if (images.length >= MAX_IMAGES || sizeBytes > MAX_IMAGE_BYTES) return `[Image omitted: ${label}]`;
        const id = `img_${images.length + 1}`;
        images.push({ id, page, width: 0, height: 0, sizeBytes, mimeType, dataUrl: `data:${mimeType};base64,${base64 || bytesToBase64(bytes)}`, label });
        return `![${label}](rag-image://__DOC_ID__:${id})`;
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
    while (kept.length && kept[kept.length - 1].every(isEmpty)) kept.pop();
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
    if (!bytes) return `[Image omitted: ${label}]`;
    return collector.add({ bytes, extension: extensionOf(path), page, label });
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
    if (tag === 'p' || tag === 'div') return inlineMarkdown(node).trim();
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
        return { src: '', alt: `[Image not shown: ${label} (linked external image)]` };
      }
      const markdown = collector.add({ base64, extension, label });
      const ref = markdown.match(/\((rag-image:\/\/[^)]+)\)$/);
      return ref ? { src: ref[1], alt: label } : { src: '', alt: markdown };
    });
    const result = await mammoth.convertToHtml({ arrayBuffer }, { convertImage });
    return { text: htmlToMarkdown(result.value), images: collector.images };
  }

  // --- xlsx -----------------------------------------------------------------

  function formatCellValue(value) {
    if (value === null || value === undefined) return '';
    if (value instanceof Date) {
      const iso = value.toISOString();
      return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.replace('.000Z', 'Z');
    }
    if (typeof value !== 'object') return String(value);
    if (Array.isArray(value.richText)) return value.richText.map(part => part.text).join('');
    if ('result' in value) return formatCellValue(value.result);
    if ('text' in value) return formatCellValue(value.text);
    if ('error' in value) return String(value.error);
    if ('formula' in value || 'sharedFormula' in value) return '';
    return String(value);
  }

  async function parseXlsx(arrayBuffer) {
    const ExcelJS = await VendorLoader.load('exceljs');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(arrayBuffer);
    const collector = createImageCollector();
    const sections = workbook.worksheets.map((sheet, sheetIndex) => {
      const rows = [];
      let totalRows = 0;
      const columns = Math.min(sheet.columnCount, MAX_SHEET_COLUMNS);
      sheet.eachRow({ includeEmpty: false }, row => {
        totalRows++;
        if (rows.length >= MAX_SHEET_ROWS) return;
        rows.push(Array.from({ length: columns }, (_, i) => formatCellValue(row.getCell(i + 1).value)));
      });
      const imageRefs = sheet.getImages().map((placement, i) => {
        const image = workbook.getImage(Number(placement.imageId));
        const label = `Image ${i + 1} (sheet "${sheet.name}")`;
        if (!image?.buffer) return `[Image omitted: ${label}]`;
        return collector.add({ bytes: new Uint8Array(image.buffer), extension: image.extension, page: sheetIndex + 1, label });
      });
      const name = sheet.state && sheet.state !== 'visible' ? `${sheet.name} (hidden)` : sheet.name;
      return sheetSection(name, rows, totalRows, imageRefs);
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
          const relation = relationships[attrs['r:embed'] || attrs['r:link']];
          blocks.push(!relation ? `[Image omitted: ${label}]`
            : relation.external ? `[Image not shown: ${label} (linked external image)]`
              : packageImage(pkg, collector, relation.path, slideNumber, label));
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
    const collector = createImageCollector();
    const sections = slideOrder(pkg).map((slidePath, index) => {
      const slideNumber = index + 1;
      const { blocks, relationships } = readSlidePart(pkg, slidePath, collector, slideNumber);
      const notes = Object.values(relationships).find(relation => relation.type === 'notesSlide' && !relation.external);
      if (notes) {
        const noteText = readSlidePart(pkg, notes.path, collector, slideNumber, { images: false }).blocks.join(' ').trim();
        if (noteText) blocks.push(`Notes: ${noteText}`);
      }
      return `--- Slide ${slideNumber} ---\n${joinBlocks(blocks)}`;
    });
    return { text: joinBlocks(sections), images: collector.images };
  }

  // --- OpenDocument (odt, ods, odp) -----------------------------------------

  function repeatCount(value, cap) {
    const count = Number.parseInt(value, 10);
    return Math.min(Number.isFinite(count) && count > 0 ? count : 1, cap);
  }

  /** Estilos de lista numerados por nivel (`estilo|nivel`), definidos en styles.xml o content.xml. */
  function readNumberedListStyles(pkg) {
    const numbered = new Set();
    let current = '';
    for (const part of ['styles.xml', 'content.xml']) {
      walkXml(pkg.text(part), {
        open(name, attrs) {
          if (name === 'text:list-style') current = attrs['style:name'] || '';
          else if (name === 'text:list-level-style-number' && current) numbered.add(`${current}|${attrs['text:level'] || 1}`);
        },
        close(name) {
          if (name === 'text:list-style') current = '';
        }
      });
    }
    return numbered;
  }

  // Marcos de cabecera, pie, fecha y número de página de las diapositivas y sus notas.
  const ODF_SKIPPED_FRAME_CLASSES = new Set(['header', 'footer', 'date-time', 'page-number', 'page']);

  function readOpenDocument(pkg, format, collector) {
    const numberedListStyles = readNumberedListStyles(pkg);
    const blocks = [];
    const links = [];
    const paragraphs = [];
    const lists = [];
    const footnotes = [];
    let skipDepth = 0;
    let noteDepth = 0;
    let page = 1;
    let pageBreaks = false;
    let slide = 0;
    let frameClass = '';
    let frameHasImage = false;
    let notesDepth = 0;
    let slideNotes = [];
    let table = null;
    let row = null;
    let cell = null;
    let imageCount = 0;

    const location = () => (format === 'odp' ? slide : format === 'ods' ? 1 : page);
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
      } else blocks.push(text);
    }

    function addImage(href) {
      imageCount++;
      const where = format === 'odp' ? `slide ${slide}` : format === 'ods' ? `sheet "${table?.name || ''}"` : `page ${page}`;
      const label = `Image ${imageCount} (${where})`;
      const markdown = /^[a-z][a-z0-9+.-]*:/i.test(href)
        ? `[Image not shown: ${label} (linked external image)]`
        : packageImage(pkg, collector, resolvePackagePath('', href), location(), label);
      const paragraph = target();
      if (format === 'ods' && table) table.images.push(markdown);
      else if (paragraph) paragraph.text += ` ${markdown} `;
      else emitBlock(markdown);
    }

    walkXml(pkg.text('content.xml'), {
      open(name, attrs) {
        if (skipDepth) { skipDepth++; return; }
        switch (name) {
          case 'office:annotation': case 'text:tracked-changes': case 'text:note-citation':
          case 'text:page-number': case 'text:page-count': case 'draw:page-thumbnail':
            skipDepth = 1; break;
          case 'text:note': noteDepth++; break;
          case 'presentation:notes': notesDepth++; break;
          case 'draw:page':
            slide++;
            slideNotes = [];
            blocks.push(`--- Slide ${slide} ---`);
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
            if (format === 'odt') { page++; pageBreaks = true; blocks.push(`--- Page ${page} ---`); }
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
            table = { name: attrs['table:name'] || `Sheet ${blocks.length + 1}`, rows: [], totalRows: 0, images: [] };
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
          case 'text:note': noteDepth--; break;
          case 'presentation:notes':
            notesDepth--;
            if (slideNotes.length) blocks.push(`Notes: ${slideNotes.join(' ')}`);
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
              for (let i = 0; i < row.repeat; i++) {
                if (hasContent) table.totalRows++;
                if (table.rows.length < MAX_SHEET_ROWS) table.rows.push(row.cells);
              }
              row = null;
            }
            break;
          case 'table:table':
            if (table) {
              const finished = table;
              table = null;
              if (format === 'ods') blocks.push(sheetSection(finished.name, finished.rows, finished.totalRows, finished.images));
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

    if (pageBreaks) blocks.unshift('--- Page 1 ---');
    if (footnotes.length) blocks.push('Footnotes:', footnotes.map((note, i) => `${i + 1}. ${note}`).join('\n'));
    return joinBlocks(blocks);
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
   * Extrae `{ text, images }` de un documento ofimático según la extensión de `fileName`.
   * Los formatos binarios antiguos (.doc, .xls, .ppt) se rechazan con un mensaje claro.
   */
  async function parseOfficeDocument(arrayBuffer, fileName) {
    const format = getOfficeFormat(fileName);
    const legacy = LEGACY_FORMATS[format];
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
      throw new Error(`The ${FORMAT_NAMES[format]} file could not be read. It may be damaged or password protected.`, { cause: error });
    }
    return { text: result.text || '[The document contains no readable text.]', images: result.images };
  }

  return { getOfficeFormat, parseOfficeDocument };
});
