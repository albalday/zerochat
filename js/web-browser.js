/**
 * Módulo de Consulta, Extracción Web y Documentos PDF Desacoplado (ChatWebBrowser) para ZeroChat.
 *
 * ==============================================================================================
 * DOCUMENTACIÓN DEL MODELO DE SEGURIDAD Y LIMITACIONES DEL NAVEGADOR
 * ==============================================================================================
 * 1. Política del Mismo Origen (Same-Origin Policy - SOP) y CORS:
 *    - Los navegadores web prohíben por defecto que el código JavaScript del cliente acceda
 *      directamente al contenido de orígenes web de terceros mediante fetch() o XMLHttpRequest
 *      a menos que el servidor de destino emita cabeceras 'Access-Control-Allow-Origin'.
 *    - Para permitir la lectura universal de artículos y páginas web públicas solicitadas por
 *      el modelo agéntico, ZeroChat utiliza estrategias desacopladas:
 *        a) Gateway Reader para LLMs (ej: Jina Reader / r.jina.ai): Procesa y devuelve Markdown limpio.
 *        b) Petición Directa (DirectFetch): Utilizada para servidores con CORS habilitado o endpoints locales.
 *
 * 2. Mitigación de SSRF (Server-Side Request Forgery) en el Cliente Web:
 *    - Los agentes LLM pueden recibir o generar URLs arbitrarias. ZeroChat aplica validación estricta
 *      antes de despachar cualquier petición:
 *        a) Protocolos: Exclusivamente http:// y https://. Se rechazan esquemas como file://, data://,
 *           javascript://, vbscript://, blob://, etc.
 *        b) Metadatos Cloud: Se bloquean de forma terminante accesos a endpoints de metadatos de
 *           proveedores cloud (AWS / GCP / Azure / DigitalOcean / Alibaba): 169.254.169.254,
 *           metadata.google.internal, instance-data, 100.100.100.200.
 *        c) Evasiones de IP: Detección y normalización de notaciones decimales, octales o hexadecimales
 *           (ej: 2130706433, 0x7f000001) para evitar bypasses de direcciones loopback o locales.
 *        d) Control de Longitud y Timeout: Truncado estricto (MAX_CONTENT_LENGTH) y AbortController
 *           para evitar consumo excesivo de memoria, DoS o desbordamiento de contexto en el LLM.
 * ==============================================================================================
 */

(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./utils.js'));
  } else {
    root.ChatWebBrowser = factory(root.ChatUtils);
  }
})(typeof self !== 'undefined' ? self : this, function (Utils) {
  'use strict';

  const MAX_CONTENT_LENGTH = 60000;
  const DEFAULT_TIMEOUT_MS = 12000;

  function getFileParser() {
    return resolveDep('ChatFileParser', './file-parser.js');
  }
  function getOfficeParser() {
    return resolveDep('ChatOfficeParser', './office-parser.js');
  }

  const { fetchWithTimeout, resolveDep, bytesToBase64, formatBytes, IMAGE_MIME_TYPES, SAFE_IMAGE_MIME_TYPES } = Utils;

  /**
   * Analiza y normaliza posibles evasiones numéricas (decimal, octal, hex) y rangos privados/locales de direcciones IP.
   */
  function isDangerousIpAddress(hostname, allowLocal = false) {
    if (!hostname) return false;
    const cleanHost = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');

    // Cloud Metadata Endpoints (Siempre bloqueados de forma terminante)
    if (cleanHost === '169.254.169.254' || cleanHost === 'metadata.google.internal' || cleanHost === 'instance-data' || cleanHost === '100.100.100.200') {
      return true;
    }

    // Comprobar si es un número decimal entero representando una IP (ej: 2130706433 = 127.0.0.1 o 2852039166 = 169.254.169.254)
    if (/^\d+$/.test(cleanHost)) {
      const num = parseInt(cleanHost, 10);
      if (!isNaN(num) && num >= 0 && num <= 4294967295) {
        const b1 = (num >>> 24) & 255;
        const b2 = (num >>> 16) & 255;
        if (b1 === 127 || (b1 === 169 && b2 === 254) || b1 === 10 || (b1 === 172 && b2 >= 16 && b2 <= 31) || (b1 === 192 && b2 === 168) || b1 === 0) {
          return true;
        }
      }
    }

    // Comprobar si es notación hexadecimal (ej: 0x7f000001)
    if (/^0x[0-9a-fA-F]+$/.test(cleanHost)) {
      const num = parseInt(cleanHost, 16);
      if (!isNaN(num) && num >= 0 && num <= 4294967295) {
        const b1 = (num >>> 24) & 255;
        const b2 = (num >>> 16) & 255;
        if (b1 === 127 || (b1 === 169 && b2 === 254) || b1 === 10 || (b1 === 172 && b2 >= 16 && b2 <= 31) || (b1 === 192 && b2 === 168) || b1 === 0) {
          return true;
        }
      }
    }

    // Si no se permiten recursos locales/internos, bloquear loopback y rangos privados
    if (!allowLocal) {
      if (cleanHost === 'localhost' || cleanHost === '0.0.0.0' || cleanHost === '127.0.0.1' || cleanHost.startsWith('127.') || cleanHost === '::1' || cleanHost === '0:0:0:0:0:0:0:1') {
        return true;
      }
      if (cleanHost.startsWith('192.168.') || cleanHost.startsWith('10.') || /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(cleanHost) || cleanHost.startsWith('169.254.')) {
        return true;
      }
    }

    return false;
  }

  /**
   * Valida la URL de destino para prevenir SSRF en servicios de metadatos o esquemas no seguros.
   */
  function validateUrlForFetch(rawUrl, options = {}) {
    if (!rawUrl || typeof rawUrl !== 'string') {
      return { valid: false, error: 'No valid URL was given.' };
    }

    let url = rawUrl.trim();
    const schemeMatch = url.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
    if (schemeMatch) {
      const scheme = schemeMatch[1].toLowerCase();
      if (scheme !== 'http' && scheme !== 'https') {
        return { valid: false, error: `Protocolo no permitido: ${scheme}:. Solo se admiten http:// y https://.` };
      }
    } else {
      url = 'https://' + url;
    }

    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { valid: false, error: `Protocolo no permitido: ${parsed.protocol}. Solo se admiten http:// y https://.` };
      }

      const hostname = parsed.hostname.toLowerCase();
      const allowLocal = options.allowLocal === true;
      if (isDangerousIpAddress(hostname, allowLocal)) {
        return { valid: false, error: 'Acceso bloqueado: intento de acceso a servicios internos, recursos locales o de metadatos de infraestructura (SSRF protection).' };
      }

      return { valid: true, url: parsed.toString(), hostname: hostname };
    } catch (e) {
      return { valid: false, error: 'Invalid URL format.' };
    }
  }

  /**
   * Resuelve una URL de imagen (relativa, con barra doble o absoluta) respecto a la URL base.
   */
  function resolveImageUrl(rawUrl, baseUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    const trimmed = rawUrl.trim();
    if (/^data:image\//i.test(trimmed)) {
      return Utils.sanitizeImageUrl(trimmed);
    }
    try {
      const resolved = new URL(trimmed, baseUrl);
      if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
        return resolved.href;
      }
    } catch (_) { /* URL no válida o esquema desconocido */ }
    return '';
  }

  /**
   * Resuelve URLs relativas de imágenes dentro de un bloque Markdown respecto a la URL base.
   */
  function resolveMarkdownImageUrls(markdownText, baseUrl) {
    if (!markdownText || typeof markdownText !== 'string' || !baseUrl) return markdownText;
    return markdownText.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, url) => {
      const resolved = resolveImageUrl(url, baseUrl);
      return resolved ? `![${alt}](${resolved})` : match;
    });
  }

  /**
   * Extrae el texto legible y estructurado de un documento HTML local.
   */
  function extractReadableTextFromHtml(htmlString, targetUrl) {
    try {
      if (typeof DOMParser !== 'undefined') {
        const parser = new DOMParser();
        const doc = parser.parseFromString(htmlString, 'text/html');

        const elementsToRemove = doc.querySelectorAll('script, style, noscript, iframe, svg, canvas, nav, footer, form');
        elementsToRemove.forEach(el => el.remove());

        const title = doc.querySelector('title') ? doc.querySelector('title').innerText.trim() : '';
        const metaDesc = doc.querySelector('meta[name="description"]') ? doc.querySelector('meta[name="description"]').getAttribute('content') : '';

        const mainElement = doc.querySelector('main, article, #content, .content, #main, .main-content') || doc.body;

        const imagesFound = [];
        const seenUrls = new Set();
        const imgNodes = (mainElement || doc.body).querySelectorAll('img');
        imgNodes.forEach(img => {
          const rawSrc = img.getAttribute('src') || img.src || '';
          const resolvedSrc = resolveImageUrl(rawSrc, targetUrl);
          if (!resolvedSrc || seenUrls.has(resolvedSrc)) return;
          const width = parseInt(img.getAttribute('width') || '', 10);
          const height = parseInt(img.getAttribute('height') || '', 10);
          if ((width && width <= 2) || (height && height <= 2)) return;

          seenUrls.add(resolvedSrc);
          const altText = (img.getAttribute('alt') || img.getAttribute('title') || '').trim();
          imagesFound.push({ url: resolvedSrc, alt: altText });

          const label = altText || 'Image';
          const replacement = doc.createTextNode(`\n\n![${label}](${resolvedSrc})\n\n`);
          img.replaceWith(replacement);
        });

        let text = mainElement ? (mainElement.innerText || mainElement.textContent || '') : '';

        text = text.replace(/\r\n/g, '\n')
                   .replace(/[ \t]+/g, ' ')
                   .replace(/\n\s*\n\s*\n+/g, '\n\n')
                   .trim();

        let headerInfo = `[Title: ${title || 'Untitled'}]\n[URL: ${targetUrl}]\n`;
        if (metaDesc) headerInfo += `[Description: ${metaDesc}]\n`;
        if (imagesFound.length > 0) headerInfo += `[Images found on page: ${imagesFound.length}]\n`;
        headerInfo += '\n--- Page content ---\n';

        const fullOutput = headerInfo + text;
        if (fullOutput.length > MAX_CONTENT_LENGTH) {
          return fullOutput.slice(0, MAX_CONTENT_LENGTH) + '\n\n[... Content truncated due to length ...]';
        }
        return fullOutput;
      }
    } catch (e) { /* DOMParser no disponible o HTML ilegible: se usa la extracción por expresiones regulares */ }

    // Fallback simple basado en expresiones regulares para Node.js o entornos sin DOMParser
    let cleanText = htmlString
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
      .replace(/<img\b([^>]*)>/gi, (match, attrs) => {
        if (/\b(?:width|height)=["']?[0-2](?:px)?["']?(?:\s|>|$)/i.test(attrs)) return ' ';
        const srcMatch = attrs.match(/\bsrc=["']([^"']+)["']/i);
        if (!srcMatch) return ' ';
        const resolved = resolveImageUrl(srcMatch[1], targetUrl);
        if (!resolved) return ' ';
        const altMatch = attrs.match(/\b(?:alt|title)=["']([^"']*)["']/i);
        const label = (altMatch ? altMatch[1] : '').trim() || 'Image';
        return `\n\n![${label}](${resolved})\n\n`;
      })
      .replace(/<[^>]+>/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s*\n+/g, '\n\n')
      .trim();

    return cleanText.slice(0, MAX_CONTENT_LENGTH);
  }

  function documentFileName(url) {
    try {
      return decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    } catch (_) {
      return '';
    }
  }

  function detectDocumentType(fileName, contentType = '') {
    if (/\.pdf$/i.test(fileName) || contentType.includes('application/pdf')) return 'pdf';
    return getOfficeParser().getOfficeFormat(fileName, contentType) || '';
  }

  /** Texto de contexto de un PDF o documento ofimático descargado; las imágenes quedan como marcadores. */
  async function describeDownloadedDocument(arrayBuffer, url, contentType = '', docType = '') {
    const fileName = documentFileName(url);
    const type = docType || detectDocumentType(fileName, contentType);
    const header = kind => `[${kind}: ${fileName || 'document'}]\n[URL: ${url}]\n[Size: ${Utils.formatBytes(arrayBuffer.byteLength)}]\n\n`;
    if (type && type !== 'pdf') {
      const OfficeParser = getOfficeParser();
      const { format, text } = await OfficeParser.parseOfficeDocument(arrayBuffer, fileName, contentType);
      return `${header(OfficeParser.getOfficeDocumentKind(format))}--- Content extracted from the document ---\n\n${OfficeParser.replaceImageReferences(text)}`;
    }
    const extractedText = await getFileParser().extractTextFromPdf(arrayBuffer);
    return `${header('PDF document')}--- Content extracted from the PDF ---\n\n${extractedText}`;
  }

  /**
   * Interfaz Base para estrategias de extracción de contenido (FetchStrategy).
   */
  class BaseFetchStrategy {
    constructor(options = {}) {
      this.name = options.name || 'base';
      this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    }

    async canHandle(url, context = {}) {
      return true;
    }

    async fetch(url, context = {}) {
      throw new Error(`fetch() must be implemented by ${this.constructor.name}`);
    }
  }

  /**
   * Estrategia de lectura optimizada para LLM mediante Gateway Reader (Jina Reader).
   */
  class ReaderGatewayStrategy extends BaseFetchStrategy {
    constructor(options = {}) {
      super({ name: 'ReaderGateway', timeoutMs: 12000, ...options });
    }

    async canHandle(url, context = {}) {
      // No aplicar gateway a hosts locales ni a documentos PDF u ofimáticos, que se leen en el navegador.
      return !context.isLocalUrl && !context.isOfficeUrl && !context.isPdfUrl;
    }

    async fetch(url, context = {}) {
      const readerUrl = `https://r.jina.ai/${url}`;
      const res = await fetchWithTimeout(readerUrl, {
        headers: {
          'Accept': 'text/plain',
          'X-Return-Format': 'markdown',
          'X-No-Cache': 'true'
        }
      }, this.timeoutMs);

      if (!res.ok) {
        throw new Error(`Reader gateway answered HTTP ${res.status}`);
      }

      let content = await res.text();
      content = resolveMarkdownImageUrls(content, url);
      return {
        success: true,
        content: content,
        byteSize: content.length,
        status: 200,
        strategy: this.name
      };
    }
  }

  /**
   * Estrategia de descarga y extracción local de documentos PDF y ofimáticos.
   */
  class LocalDocumentStrategy extends BaseFetchStrategy {
    constructor(options = {}) {
      super({ name: 'LocalDocumentExtractor', timeoutMs: 10000, ...options });
    }

    async canHandle(url, context = {}) {
      return Boolean(context.isPdfUrl || context.isOfficeUrl);
    }

    async fetch(url, context = {}) {
      const accept = context.isPdfUrl ? 'application/pdf,*/*' : '*/*';
      const binaryResult = await fetchBinaryResource(url, {
        timeoutMs: this.timeoutMs,
        accept,
        resourceKind: 'document'
      });

      if (!binaryResult.success) {
        throw new Error(binaryResult.error || 'Error downloading the document');
      }

      const contentType = (binaryResult.contentType || '').toLowerCase();
      const docType = detectDocumentType(documentFileName(url), contentType);
      return {
        success: true,
        content: await describeDownloadedDocument(binaryResult.arrayBuffer, url, contentType, docType),
        byteSize: binaryResult.byteSize,
        status: binaryResult.status || 200,
        isPdf: docType === 'pdf',
        strategy: this.name
      };
    }
  }

  /**
   * Estrategia de petición HTTP directa estándar.
   */
  class DirectFetchStrategy extends BaseFetchStrategy {
    constructor(options = {}) {
      super({ name: 'DirectFetch', timeoutMs: 6000, ...options });
    }

    async canHandle(url, context = {}) {
      return true;
    }

    async fetch(url, context = {}) {
      const res = await fetchWithTimeout(url, {
        headers: { 'Accept': 'text/html,application/xhtml+xml,application/json,application/pdf,text/plain;q=0.9,*/*;q=0.8' }
      }, this.timeoutMs);

      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      const docType = detectDocumentType(documentFileName(url), contentType);
      const isPdf = docType === 'pdf';
      const isDocument = Boolean(docType);

      let content = '';
      let byteSize = 0;

      if (isDocument && res.ok) {
        const arrayBuffer = await res.arrayBuffer();
        byteSize = arrayBuffer.byteLength;
        content = await describeDownloadedDocument(arrayBuffer, url, contentType, docType);
      } else {
        const rawText = await res.text();
        byteSize = rawText.length;
        if (rawText.includes('<html') || rawText.includes('<!DOCTYPE')) {
          content = extractReadableTextFromHtml(rawText, url);
        } else {
          content = rawText.slice(0, MAX_CONTENT_LENGTH);
        }
      }

      return {
        success: res.ok,
        content: content,
        byteSize: byteSize,
        status: res.status,
        isPdf: isPdf,
        strategy: this.name,
        error: res.ok ? undefined : `HTTP ${res.status}: ${res.statusText}`
      };
    }
  }

  /**
   * Orquestador de estrategias de lectura web (PageFetcherPipeline).
   */
  class PageFetcherPipeline {
    constructor() {
      this.strategies = [
        new ReaderGatewayStrategy(),
        new LocalDocumentStrategy(),
        new DirectFetchStrategy()
      ];
    }

    /**
     * Ejecuta las estrategias en orden hasta obtener una respuesta exitosa.
     */
    async fetch(rawUrl, options = {}) {
      const validation = validateUrlForFetch(rawUrl, options);
      if (!validation.valid) {
        return {
          success: false,
          url: rawUrl || '',
          content: '',
          elapsedMs: 0,
          error: validation.error
        };
      }

      const url = validation.url;
      const startTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const isLocalUrl = /^(localhost|127\.0\.0\.1|192\.168\.|10\.|0\.0\.0\.0)/i.test(validation.hostname);
      const fileName = documentFileName(url);
      const docType = detectDocumentType(fileName);
      const isPdfUrl = docType === 'pdf';
      const isOfficeUrl = Boolean(docType && docType !== 'pdf');

      const context = {
        isLocalUrl,
        isPdfUrl,
        isOfficeUrl,
        hostname: validation.hostname,
        ...options
      };

      let lastError = null;

      // Si es un host local, intentar DirectFetch prioritariamente
      const executionList = isLocalUrl
        ? [new DirectFetchStrategy({ timeoutMs: 5000 })]
        : this.strategies;

      for (const strategy of executionList) {
        try {
          const can = await strategy.canHandle(url, context);
          if (!can) continue;

          const result = await strategy.fetch(url, context);
          if (result && result.success) {
            let content = result.content || '';
            if (content.length > MAX_CONTENT_LENGTH) {
              content = content.slice(0, MAX_CONTENT_LENGTH) + '\n\n[... Content truncated at the size limit ...]';
            }

            const endTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
            return {
              success: true,
              url: url,
              status: result.status || 200,
              content: content,
              byteSize: result.byteSize || content.length,
              isPdf: result.isPdf || isPdfUrl,
              elapsedMs: parseFloat((endTime - startTime).toFixed(2)),
              strategy: result.strategy || strategy.name
            };
          }
        } catch (err) {
          lastError = err;
          console.warn(`[WebBrowser] Strategy ${strategy.name} failed for ${url}:`, err.message);
        }
      }

      const endTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
      return {
        success: false,
        url: url,
        content: '',
        elapsedMs: parseFloat((endTime - startTime).toFixed(2)),
        error: `The web page could not be accessed or the document downloaded (${lastError ? lastError.message : 'connection error or network block'}).`
      };
    }
  }

  const pipeline = new PageFetcherPipeline();

  /**
   * Consulta una página web o descarga un documento PDF u ofimático y devuelve el contenido legible.
   */
  async function fetchPage(rawUrl, options = {}) {
    return pipeline.fetch(rawUrl, options);
  }

  const MAX_BINARY_BYTES = 10 * 1024 * 1024;
  const MAX_IMAGE_BYTES = MAX_BINARY_BYTES;

  const VISION_IMAGE_MIME_TYPES = SAFE_IMAGE_MIME_TYPES;

  /**
   * Descarga un recurso web binario (ArrayBuffer) directamente en el navegador de forma segura.
   * Valida la URL (anti-SSRF), aplica límites de tamaño y timeout estricto, sin proxies de terceros ni backend.
   * En caso de error de red o bloqueo de CORS, falla de inmediato sin reintentos externos ni cuelgues.
   */
  async function fetchBinaryResource(rawUrl, options = {}) {
    const validation = validateUrlForFetch(rawUrl, options);
    if (!validation.valid) {
      return {
        success: false,
        url: rawUrl || '',
        error: validation.error,
        elapsedMs: 0
      };
    }

    const url = validation.url;
    const startTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const maxBytes = options.maxBytes || MAX_BINARY_BYTES;
    const timeoutMs = options.timeoutMs || 8000;
    const resourceKind = options.resourceKind || 'resource';
    const headers = {
      'Accept': options.accept || '*/*',
      ...(options.headers || {})
    };

    const calcElapsed = () => parseFloat(((typeof performance !== 'undefined' ? performance.now() : Date.now()) - startTime).toFixed(2));

    let res = null;
    try {
      res = await fetchWithTimeout(url, { headers }, timeoutMs);
    } catch (err) {
      const isTimeout = err?.name === 'AbortError' || /abort/i.test(err?.message || '');
      return {
        success: false,
        url,
        error: isTimeout
          ? `The download timed out after ${timeoutMs}ms.`
          : `The ${resourceKind} could not be downloaded (${err?.message || 'connection error or CORS restriction'}).`,
        elapsedMs: calcElapsed()
      };
    }

    if (!res.ok) {
      return {
        success: false,
        url,
        status: res.status,
        error: `HTTP ${res.status}: ${res.statusText || 'Error fetching resource'}`,
        elapsedMs: calcElapsed()
      };
    }

    const label = resourceKind.charAt(0).toUpperCase() + resourceKind.slice(1);

    const contentLength = res.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > maxBytes) {
      return {
        success: false,
        url,
        status: res.status,
        error: `${label} exceeds the size limit of ${formatBytes(maxBytes)} (reported ${formatBytes(parseInt(contentLength, 10))}).`,
        elapsedMs: calcElapsed()
      };
    }

    let arrayBuffer;
    try {
      arrayBuffer = await res.arrayBuffer();
    } catch (bufErr) {
      return {
        success: false,
        url,
        status: res.status,
        error: `Failed to read ${resourceKind} content: ${bufErr.message}`,
        elapsedMs: calcElapsed()
      };
    }

    const byteLength = arrayBuffer.byteLength;
    if (byteLength === 0) {
      return {
        success: false,
        url,
        status: res.status,
        error: `The fetched ${resourceKind} is empty (0 bytes).`,
        elapsedMs: calcElapsed()
      };
    }

    if (byteLength > maxBytes) {
      return {
        success: false,
        url,
        status: res.status,
        error: `${label} exceeds the size limit of ${formatBytes(maxBytes)} (got ${formatBytes(byteLength)}).`,
        elapsedMs: calcElapsed()
      };
    }

    return {
      success: true,
      url,
      status: res.status,
      contentType: res.headers.get('content-type') || '',
      arrayBuffer,
      byteSize: byteLength,
      fileName: documentFileName(url) || resourceKind,
      elapsedMs: calcElapsed()
    };
  }

  /**
   * Determina el tipo MIME de imagen válido para modelos de visión a partir del nombre o Content-Type.
   * Admite únicamente formatos raster estándar: PNG, JPEG, WebP y GIF. Excluye SVG y otros formatos.
   */
  function detectVisionImageMimeType(fileName, contentType = '') {
    const cleanType = String(contentType || '').split(';')[0].trim().toLowerCase();
    if (cleanType === 'image/jpg') return 'image/jpeg';
    if (VISION_IMAGE_MIME_TYPES.has(cleanType)) return cleanType;
    const match = String(fileName || '').toLowerCase().match(/\.([a-z0-9]+)(?:[?#]|$)/i);
    const ext = match ? match[1] : '';
    const resolvedMime = IMAGE_MIME_TYPES[ext];
    if (resolvedMime && VISION_IMAGE_MIME_TYPES.has(resolvedMime)) return resolvedMime;
    return '';
  }

  /**
   * Descarga de forma segura una imagen web, valida su tipo MIME (PNG/JPEG/WebP/GIF)
   * y tamaño máximo, y la devuelve convertida en dataUrl base64 para modelos de visión.
   */
  async function fetchImage(rawUrl, options = {}) {
    const maxBytes = options.maxBytes || MAX_IMAGE_BYTES;
    const timeoutMs = options.timeoutMs || 8000;
    const accept = 'image/png,image/jpeg,image/webp,image/gif;q=0.9,*/*;q=0.8';

    const binaryResult = await fetchBinaryResource(rawUrl, {
      ...options,
      maxBytes,
      timeoutMs,
      accept,
      resourceKind: 'image'
    });

    if (!binaryResult.success) {
      return binaryResult;
    }

    const fileName = binaryResult.fileName || documentFileName(binaryResult.url);
    const mimeType = detectVisionImageMimeType(fileName, binaryResult.contentType);
    if (!mimeType) {
      return {
        success: false,
        url: binaryResult.url,
        status: binaryResult.status,
        error: `Unsupported image format: ${binaryResult.contentType || 'unknown'}. Only PNG, JPEG, WebP, and GIF are supported.`,
        elapsedMs: binaryResult.elapsedMs
      };
    }

    const bytes = new Uint8Array(binaryResult.arrayBuffer);
    const base64 = bytesToBase64(bytes);
    const dataUrl = `data:${mimeType};base64,${base64}`;

    return {
      success: true,
      url: binaryResult.url,
      status: binaryResult.status,
      mimeType,
      byteSize: binaryResult.byteSize,
      fileName: fileName || 'image',
      dataUrl,
      elapsedMs: binaryResult.elapsedMs
    };
  }

  return {
    fetchPage,
    fetchImage,
    fetchBinaryResource,
    validateUrlForFetch,
    detectVisionImageMimeType,
    documentFileName,
    extractReadableTextFromHtml,
    BaseFetchStrategy,
    ReaderGatewayStrategy,
    LocalDocumentStrategy,
    DirectFetchStrategy,
    PageFetcherPipeline,
    pipeline,
    MAX_BINARY_BYTES,
    MAX_IMAGE_BYTES,
    VISION_IMAGE_MIME_TYPES
  };
});
