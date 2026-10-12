/** Deterministic, local document ingestion for the ZeroChat knowledge base. */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') module.exports = factory(require('./utils.js'));
  else root.ChatIngestionEngine = factory(root.ChatUtils);
})(typeof self !== 'undefined' ? self : this, function (Utils) {
  'use strict';

  const { resolveDep, createId } = Utils;

  function getRagStorage() {
    return resolveDep('ChatRagStorage', './ragStorage.js');
  }
  function getRagIndex() {
    return resolveDep('ChatRagIndex', './rag-index.js');
  }
  function getFileParser() {
    return resolveDep('ChatFileParser', './file-parser.js');
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
        reader.onerror = () => reject(reader.error || new Error('The file could not be read.'));
        reader.readAsText(file, 'utf-8');
      });
    }
    throw new Error('The text file could not be read.');
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
        reader.onerror = () => reject(reader.error || new Error('The PDF could not be read.'));
        reader.readAsArrayBuffer(file);
      });
    }
    throw new Error('The binary content of the file could not be read.');
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
        throw new Error(`The decompressed content exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB limit.`);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  }

  async function readGzipText(file, options = {}) {
    if (typeof DecompressionStream === 'undefined' || typeof Blob === 'undefined') {
      throw new Error('This browser cannot decompress gzip files.');
    }
    const bytes = await toArrayBuffer(file);
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return readTextStream(stream, options.maxDecompressedBytes || MAX_DECOMPRESSED_TEXT_BYTES);
  }

  function unsupportedArchiveMessage(format) {
    if (format === 'tar') return 'The file is a compressed TAR archive. Extract the logs or use individual .gz files.';
    if (format === 'zip') return 'The file is a ZIP archive. Extract the logs or use individual .gz files.';
    return 'The file is compressed in an unsupported format. Extract its content before indexing it.';
  }

  async function extractDocumentContent(file, fileType) {
    const archiveFormat = await getArchiveFormat(file);
    if (archiveFormat && archiveFormat !== 'gzip') throw new Error(unsupportedArchiveMessage(archiveFormat));
    if (archiveFormat === 'gzip') {
      let rawText;
      try {
        rawText = await readGzipText(file);
      } catch (error) {
        if (String(error?.message || error).includes('cannot decompress')) throw error;
        throw new Error('The gzip file could not be decompressed. It may be damaged.');
      }
      if (!isLikelyText(rawText)) throw new Error('The gzip content does not seem to contain readable text.');
      return { text: normalizeExtractedText(rawText), images: [] };
    }
    if (fileType === 'pdf') {
      const bytes = await toArrayBuffer(file);
      const parsed = await getFileParser().parsePdfDocument(bytes);
      return { text: normalizeExtractedText(parsed.text), images: parsed.images || [] };
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
        const label = (alt && alt.trim()) || `Image ${imgCounter - 1}`;
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
    if (!isLikelyText(rawText)) throw new Error('The file does not seem to contain readable text.');
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
    const pages = Array.from(String(content).matchAll(/---\s*Page\s+(\d+)\s*---/gi), match => Number(match[1]));
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
      chunks.push({ order: chunks.length, title: firstHeading || `Chunk ${chunks.length + 1}`, content, ...findPageRange(content) });
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

  /**
   * Indexa los archivos en la rama, uno tras otro. `onProgress` recibe por archivo su estado
   * (extracting, chunking, saving, completed, skipped, cancelled o error), los contadores globales y
   * en `detail` los fragmentos e imágenes indexados o el error; la interfaz redacta el mensaje.
   */
  async function processDocumentQueue(files, branchId, onProgress, options = {}) {
    const queue = Array.from(files);
    const storage = getRagStorage();
    if (!branchId) throw new Error('A target branch is required.');
    const result = { total: queue.length, processed: 0, replaced: 0, skipped: 0, cancelled: 0, failed: 0, documents: [], errors: [] };
    const maxFileSize = Number(options.maxFileSize) || MAX_DOCUMENT_SIZE;
    const isAborted = () => options.signal?.aborted === true;
    let rememberedDuplicatePolicy = null;
    const processedInSession = new Map();

    const emit = (fileIndex, fileName, status, percent, detail = {}) => {
      if (typeof onProgress !== 'function') return;
      const finishedFiles = result.processed + result.replaced + result.skipped + result.cancelled + result.failed;
      const isFinished = ['completed', 'skipped', 'cancelled', 'error'].includes(status);
      const overallPercent = queue.length
        ? Math.min(100, ((finishedFiles + (isFinished ? 0 : percent / 100)) / queue.length) * 100)
        : 100;
      onProgress({
        fileIndex, totalFiles: queue.length, fileName, status, percent, detail,
        processedFiles: result.processed, replacedFiles: result.replaced, skippedFiles: result.skipped,
        cancelledFiles: result.cancelled, failedFiles: result.failed, finishedFiles, overallPercent
      });
    };
    const fileNameAt = index => queue[index]?.name || `document_${index + 1}.txt`;
    const cancelRemaining = fromIndex => {
      for (let index = fromIndex; index < queue.length; index++) {
        result.cancelled++;
        emit(index, fileNameAt(index), 'cancelled', 0);
      }
    };

    for (let fileIndex = 0; fileIndex < queue.length; fileIndex++) {
      if (isAborted()) {
        cancelRemaining(fileIndex);
        break;
      }

      const file = queue[fileIndex];
      const fullPath = String(file?.webkitRelativePath || file?.path || file?.name || fileNameAt(fileIndex)).trim();
      const fileName = file?.name || fullPath;
      const fileType = detectFileType(file);

      try {
        if (typeof file?.size === 'number' && file.size > maxFileSize) {
          throw new Error(`The file exceeds the maximum allowed size (${Math.round(maxFileSize / 1024 / 1024)} MB).`);
        }
        if (!fileType) throw new Error('The file does not seem to contain readable text.');

        // Un archivo con la misma ruta ya indexado se reemplaza u omite según decida el usuario.
        const existingDoc = processedInSession.get(fullPath) || await storage.findDocumentByPath(branchId, fullPath);
        let action = null;
        if (existingDoc) {
          if (rememberedDuplicatePolicy) {
            action = rememberedDuplicatePolicy;
          } else if (typeof options.onDuplicateConflict === 'function') {
            const decision = await options.onDuplicateConflict({ fullPath, fileName, existingDoc });
            action = decision?.action === 'replace' ? 'replace' : 'ignore';
            if (decision?.applyToAll) rememberedDuplicatePolicy = action;
          } else {
            action = 'ignore';
          }
          if (isAborted()) {
            cancelRemaining(fileIndex);
            break;
          }
          if (action === 'ignore') {
            result.skipped++;
            emit(fileIndex, fileName, 'skipped', 100);
            continue;
          }
        }

        emit(fileIndex, fileName, 'extracting', 10);
        const { text: extracted, images } = await extractDocumentContent(file, fileType);
        if (isAborted()) {
          cancelRemaining(fileIndex);
          break;
        }
        if (!extracted) throw new Error('The file contains no extractable text.');

        emit(fileIndex, fileName, 'chunking', 45);
        const documentId = createId('doc');
        const preparedText = extracted.replace(/rag-image:\/\/__DOC_ID__:/g, `rag-image://${documentId}:`);
        const chunks = partitionTextIntoChunks(preparedText, options);
        if (!chunks.length) throw new Error('No chunks could be generated from the document.');
        if (isAborted()) {
          cancelRemaining(fileIndex);
          break;
        }

        emit(fileIndex, fileName, 'saving', 75);
        const docPayload = {
          id: documentId,
          branchId,
          title: fileName,
          path: fullPath,
          fileType,
          mimeType: file?.type || '',
          fileSize: Number(file?.size) || preparedText.length,
          chunks
        };
        const replacing = action === 'replace';
        const document = replacing
          ? await storage.replaceDocument(existingDoc.id, docPayload, images)
          : await storage.saveDocument(docPayload, images);
        if (replacing) result.replaced++;
        else result.processed++;

        processedInSession.set(fullPath, document);
        getRagIndex().invalidateBranch(branchId);
        result.documents.push(document);
        emit(fileIndex, fileName, 'completed', 100, { replaced: replacing, chunks: chunks.length, images: images?.length || 0 });
      } catch (error) {
        const message = error?.message || String(error);
        result.failed++;
        result.errors.push({ fileName, error: message });
        emit(fileIndex, fileName, 'error', 0, { error: message });
      }
    }
    return result;
  }

  return { normalizeExtractedText, extractTextFromPlainText, detectSectionHeading, partitionTextIntoChunks, detectFileType, isLikelyText, getArchiveFormat, readGzipText, processDocumentQueue, MAX_DOCUMENT_SIZE };
});
