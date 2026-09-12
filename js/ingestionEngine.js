/** Deterministic, local document ingestion for the ZeroChat knowledge base. */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') module.exports = factory();
  else root.ChatIngestionEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function getRagStorage() {
    if (typeof window !== 'undefined') return window.ChatRagStorage;
    try { return require('./ragStorage.js'); } catch (_) { return null; }
  }
  function getRagIndex() {
    if (typeof window !== 'undefined') return window.ChatRagIndex;
    try { return require('./rag-index.js'); } catch (_) { return null; }
  }
  function getFileParser() {
    if (typeof window !== 'undefined') return window.ChatFileParser;
    try { return require('./file-parser.js'); } catch (_) { return null; }
  }

  function normalizeExtractedText(rawText) {
    if (!rawText) return '';
    let text = typeof rawText === 'string' ? rawText : String(rawText);
    if (text.normalize) text = text.normalize('NFKC');
    return text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
      .replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
  }

  async function readPlainText(file) {
    if (!file) return '';
    if (typeof file === 'string') return file;
    if (typeof file.content === 'string') return file.content;
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(file)) return file.toString('utf8');
    if (typeof file.text === 'function') return file.text();
    if (typeof FileReader !== 'undefined') {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error || new Error('No se pudo leer el archivo.'));
        reader.readAsText(file, 'utf-8');
      });
    }
    throw new Error('No se pudo leer el archivo de texto.');
  }

  async function extractTextFromPlainText(file) {
    return normalizeExtractedText(await readPlainText(file));
  }

  async function toArrayBuffer(file) {
    if (file instanceof ArrayBuffer) return file;
    if (file instanceof Uint8Array) return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(file)) return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
    if (file && typeof file.arrayBuffer === 'function') return file.arrayBuffer();
    if (typeof FileReader !== 'undefined') {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error('No se pudo leer el PDF.'));
        reader.readAsArrayBuffer(file);
      });
    }
    throw new Error('No se pudo obtener el contenido binario del archivo.');
  }

  const MAX_DECOMPRESSED_TEXT_BYTES = 50 * 1024 * 1024;

  function archiveFormatFromName(fileName) {
    const name = String(fileName || '').toLowerCase();
    if (/\.(?:tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz|tar\.zst|tzst)$/.test(name)) return 'tar';
    if (/\.zip$/.test(name)) return 'zip';
    if (/\.(?:gz|gzip)$/.test(name)) return 'gzip';
    if (/\.(?:bz2|xz|zst)$/.test(name)) return 'compressed';
    return '';
  }

  function archiveFormatFromBytes(bytes) {
    if (!bytes || bytes.length < 2) return '';
    if (bytes[0] === 0x1F && bytes[1] === 0x8B) return 'gzip';
    if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4B && [0x03, 0x05, 0x07].includes(bytes[2]) && [0x04, 0x06, 0x08].includes(bytes[3])) return 'zip';
    if (bytes[0] === 0x42 && bytes[1] === 0x5A && bytes[2] === 0x68) return 'compressed';
    if (bytes.length >= 6 && bytes[0] === 0xFD && bytes[1] === 0x37 && bytes[2] === 0x7A && bytes[3] === 0x58 && bytes[4] === 0x5A && bytes[5] === 0x00) return 'compressed';
    if (bytes.length >= 4 && bytes[0] === 0x28 && bytes[1] === 0xB5 && bytes[2] === 0x2F && bytes[3] === 0xFD) return 'compressed';
    return '';
  }

  async function getArchiveFormat(file) {
    const byName = archiveFormatFromName(file?.name);
    if (byName) return byName;
    try {
      const header = file?.slice ? file.slice(0, 16) : file;
      const bytes = new Uint8Array(await toArrayBuffer(header));
      return archiveFormatFromBytes(bytes);
    } catch (_) {
      return '';
    }
  }

  async function readTextStream(stream, maxBytes = MAX_DECOMPRESSED_TEXT_BYTES) {
    const reader = stream.getReader();
    const decoder = new TextDecoder('utf-8');
    let total = 0;
    let text = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`El contenido descomprimido supera el límite de ${Math.round(maxBytes / 1024 / 1024)} MB.`);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  }

  async function readGzipText(file, options = {}) {
    if (typeof DecompressionStream === 'undefined' || typeof Blob === 'undefined') {
      throw new Error('Este navegador no puede descomprimir archivos gzip.');
    }
    const bytes = await toArrayBuffer(file);
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return readTextStream(stream, options.maxDecompressedBytes || MAX_DECOMPRESSED_TEXT_BYTES);
  }

  function unsupportedArchiveMessage(format) {
    if (format === 'tar') return 'El archivo es un contenedor TAR comprimido. Extrae los logs o usa archivos .gz individuales.';
    if (format === 'zip') return 'El archivo es un ZIP. Extrae los logs o usa archivos .gz individuales.';
    return 'El archivo está comprimido en un formato no compatible. Extrae su contenido antes de indexarlo.';
  }

  async function extractTextFromPDF(file) {
    const bytes = await toArrayBuffer(file);
    const parser = getFileParser();
    if (!parser?.extractTextFromPdf) throw new Error('El extractor de PDF no está disponible.');
    return normalizeExtractedText(await parser.extractTextFromPdf(bytes));
  }

  async function extractDocumentContent(file, fileType) {
    const archiveFormat = await getArchiveFormat(file);
    if (archiveFormat && archiveFormat !== 'gzip') throw new Error(unsupportedArchiveMessage(archiveFormat));
    if (archiveFormat === 'gzip') {
      let rawText;
      try {
        rawText = await readGzipText(file);
      } catch (error) {
        if (String(error?.message || error).includes('navegador no puede')) throw error;
        throw new Error('No se pudo descomprimir el archivo gzip. El archivo puede estar dañado.');
      }
      if (!isLikelyText(rawText)) throw new Error('El contenido del archivo gzip no parece contener texto legible.');
      return { text: normalizeExtractedText(rawText), images: [] };
    }
    if (fileType === 'pdf') {
      const bytes = await toArrayBuffer(file);
      const parser = getFileParser();
      if (!parser) throw new Error('El extractor de PDF no está disponible.');
      if (typeof parser.parsePdfDocument === 'function') {
        const parsed = await parser.parsePdfDocument(bytes);
        return {
          text: normalizeExtractedText(parsed.text),
          images: parsed.images || []
        };
      }
      const rawText = await parser.extractTextFromPdf(bytes);
      return { text: normalizeExtractedText(rawText), images: [] };
    }

    if (fileType === 'md') {
      let rawText = await extractTextFromPlainText(file);
      const images = [];
      let imgCounter = 1;
      rawText = rawText.replace(/!\[([^\]]*)\]\((data:image\/(?:png|jpeg|jpg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=\s]+)\)/gi, (match, alt, dataUrl) => {
        const imgId = `img_${imgCounter++}`;
        const cleanDataUrl = dataUrl.replace(/\s+/g, '');
        const mimeMatch = cleanDataUrl.match(/^data:(image\/[a-zA-Z+]+);base64,/);
        const mimeType = mimeMatch ? mimeMatch[1] : 'image/png';
        const label = (alt && alt.trim()) || `Imagen ${imgCounter - 1}`;
        images.push({
          id: imgId,
          page: 1,
          width: 0,
          height: 0,
          mimeType,
          dataUrl: cleanDataUrl,
          label
        });
        return `![${label}](rag-image://__DOC_ID__:${imgId})`;
      });
      return { text: normalizeExtractedText(rawText), images };
    }

    const rawText = await readPlainText(file);
    if (!isLikelyText(rawText)) throw new Error('El archivo no parece contener texto legible.');
    return { text: normalizeExtractedText(rawText), images: [] };
  }

  function detectSectionHeading(line) {
    const value = String(line || '').trim();
    if (!value || value.length > 140) return '';
    const markdown = value.match(/^#{1,6}\s+(.+)$/);
    if (markdown) return markdown[1].trim();
    const numbered = value.match(/^(?:\d+(?:\.\d+)*|[IVXLCDM]+)[.)]?\s+(.+)$/i);
    if (numbered) return numbered[1].trim();
    if (/^(?:cap[ií]tulo|chapter|secci[oó]n|section|anexo|appendix)\s+[\w.-]+/i.test(value)) return value;
    if (value.length <= 80 && /^[A-ZÁÉÍÓÚÜÑ0-9][^.!?]*$/.test(value) && value.split(/\s+/).length <= 12) return value;
    return '';
  }

  function findPageRange(content) {
    const pages = Array.from(String(content).matchAll(/---\s*P[aá]gina\s+(\d+)\s*---/gi), match => Number(match[1]));
    return pages.length ? { pageStart: Math.min(...pages), pageEnd: Math.max(...pages) } : { pageStart: null, pageEnd: null };
  }

  function findSafeCut(text, maxChars) {
    if (text.length <= maxChars) return text.length;
    const floor = Math.floor(maxChars * 0.65);
    for (const separator of ['\n\n', '\n', '. ', '; ', ', ', ' ']) {
      const index = text.lastIndexOf(separator, maxChars);
      if (index >= floor) return index + separator.length;
    }
    return maxChars;
  }

  function tailOverlap(text, overlapChars) {
    if (!overlapChars || text.length <= overlapChars) return '';
    const tail = text.slice(-overlapChars);
    const boundary = tail.search(/(?:\n\n|[.!?]\s)/);
    return (boundary >= 0 ? tail.slice(boundary).trimStart() : tail).trim();
  }

  function partitionTextIntoChunks(rawText, options = {}) {
    const text = normalizeExtractedText(rawText);
    if (!text) return [];
    const maxChars = Math.max(1000, Number(options.maxChars) || 6000);
    const requestedOverlap = options.overlapChars === undefined ? 400 : Number(options.overlapChars);
    const overlapChars = Math.max(0, Math.min(Math.floor(maxChars * 0.2), requestedOverlap || 0));
    const chunks = [];
    let remaining = text;
    let overlap = '';
    while (remaining) {
      const cut = findSafeCut(remaining, maxChars);
      const body = remaining.slice(0, cut).trim();
      const content = [overlap, body].filter(Boolean).join('\n\n');
      const firstHeading = content.split('\n').map(detectSectionHeading).find(Boolean);
      chunks.push({ order: chunks.length, title: firstHeading || `Fragmento ${chunks.length + 1}`, content, ...findPageRange(content) });
      remaining = remaining.slice(cut).trimStart();
      overlap = remaining ? tailOverlap(body, overlapChars) : '';
    }
    return chunks;
  }

  function detectFileType(file) {
    const name = String(file?.name || '').toLowerCase();
    if (name.endsWith('.pdf') || file?.type === 'application/pdf') return 'pdf';
    if (name.endsWith('.md') || name.endsWith('.markdown') || file?.type === 'text/markdown') return 'md';
    if (/^(?:image|audio|video)\//i.test(String(file?.type || ''))) return null;
    return 'txt';
  }

  function isLikelyText(value) {
    const text = String(value || '');
    if (!text || text.includes('\0')) return false;
    const controls = (text.match(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g) || []).length;
    return controls <= Math.max(1, Math.floor(text.length * 0.01));
  }

  const MAX_DOCUMENT_SIZE = 50 * 1024 * 1024; // 50 MB límite por documento

  async function processDocumentQueue(files, branchId, onProgress, options = {}) {
    const queue = Array.isArray(files) ? files : Array.from(files || []);
    const storage = getRagStorage();
    const index = getRagIndex();
    if (!storage) throw new Error('El almacenamiento RAG no está disponible.');
    if (!branchId) throw new Error('Se requiere una rama de destino.');
    const result = { total: queue.length, processed: 0, failed: 0, documents: [], errors: [] };
    const maxFileSize = Number(options.maxFileSize) || MAX_DOCUMENT_SIZE;
    const emit = (fileIndex, fileName, status, message, percent, errorDetails) => {
      if (typeof onProgress === 'function') {
        const finishedFiles = result.processed + result.failed;
        const isFinished = status === 'completed' || status === 'error';
        const overallPercent = queue.length
          ? Math.min(100, ((finishedFiles + (isFinished ? 0 : (Number(percent) || 0) / 100)) / queue.length) * 100)
          : 100;
        onProgress({
          fileIndex, totalFiles: queue.length, fileName, status, message, percent, errorDetails,
          processedFiles: result.processed, failedFiles: result.failed, finishedFiles, overallPercent
        });
      }
    };
    for (let fileIndex = 0; fileIndex < queue.length; fileIndex++) {
      const file = queue[fileIndex];
      const fileName = file?.name || `documento_${fileIndex + 1}.txt`;
      const fileType = detectFileType(file);
      try {
        if (file && typeof file.size === 'number' && file.size > maxFileSize) {
          throw new Error('El archivo supera el tamaño máximo permitido (50 MB).');
        }
        if (!fileType) throw new Error('El archivo no parece contener texto legible.');
        emit(fileIndex, fileName, 'extracting', `Extrayendo texto de ${fileName}…`, 10);
        const { text: extracted, images } = await extractDocumentContent(file, fileType);
        if (!extracted) throw new Error('El archivo no contiene texto extraíble.');
        emit(fileIndex, fileName, 'chunking', `Particionando ${fileName}…`, 45);

        const documentId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? `doc_${crypto.randomUUID()}`
          : `doc_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
        const preparedText = extracted.replace(/rag-image:\/\/__DOC_ID__:/g, `rag-image://${documentId}:`);

        const chunks = partitionTextIntoChunks(preparedText, options);
        if (!chunks.length) throw new Error('No se pudieron generar fragmentos del documento.');
        emit(fileIndex, fileName, 'saving', `Guardando ${fileName} en IndexedDB…`, 75);
        const document = await storage.saveDocument({
          id: documentId,
          branchId, title: fileName, fileType, mimeType: file?.type || '',
          fileSize: Number(file?.size) || preparedText.length, chunks
        }, images);
        if (index?.invalidateBranch) index.invalidateBranch(branchId);
        result.processed++;
        result.documents.push(document);
        emit(fileIndex, fileName, 'completed', `${fileName} indexado (${chunks.length} fragmentos, ${(images && images.length) || 0} imágenes).`, 100);
      } catch (error) {
        const message = error?.message || String(error);
        result.failed++;
        result.errors.push({ fileName, error: message });
        emit(fileIndex, fileName, 'error', `Error en ${fileName}: ${message}`, 0, message);
      }
    }
    return result;
  }

  return { normalizeExtractedText, extractTextFromPlainText, extractTextFromPDF, detectSectionHeading, partitionTextIntoChunks, detectFileType, isLikelyText, getArchiveFormat, readGzipText, processDocumentQueue, MAX_DOCUMENT_SIZE };
});
