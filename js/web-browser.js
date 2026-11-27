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
 *    - Casi ninguna web permite CORS, así que leerlas exige un proxy. webFetch elige la ruta:
 *        a) Con el backend local conectado: el backend, para todo (leer y descargar).
 *        b) Sin backend, para leer (search_web, fetch_web_page): Jina Reader (r.jina.ai) con
 *           X-Return-Format: html, que devuelve el HTML de la página. No devuelve los bytes
 *           originales de un fichero, así que no sirve para descargar.
 *        c) Sin backend, para descargar (download_doc, download_image): petición directa del
 *           navegador, que solo funciona con las webs que permiten CORS. Solo lleva la cabecera
 *           Accept, CORS-safelisted: otra (como User-Agent) forzaría un preflight que muchos
 *           servidores rechazan.
 *    - fetchPage lee de una sola vez: un PDF u ofimático por la extensión de su URL se descarga
 *      (fetchBinaryResource) y se extrae en el navegador; el resto se pide con webFetch como página,
 *      y si su Content-Type es de documento se extrae igual.
 *
 * 2. Mitigación de SSRF (Server-Side Request Forgery) en el Cliente Web:
 *    - Los agentes LLM pueden recibir o generar URLs arbitrarias. webFetch, por donde pasa toda
 *      petición web, aplica validación estricta (validateUrlForFetch) antes de despacharla:
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
    module.exports = factory(require('./utils.js'), require('./html-document.js'));
  } else {
    root.ChatWebBrowser = factory(root.ChatUtils, root.ChatHtmlDocument);
  }
})(typeof self !== 'undefined' ? self : this, function (Utils, HtmlDocument) {
  'use strict';

  const MAX_CONTENT_LENGTH = 60000;
  // Jina Reader tarda varios segundos en devolver la página.
  const READ_TIMEOUT_MS = 20000;
  const MAX_BINARY_BYTES = 10 * 1024 * 1024;
  const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
  const TRUNCATION_NOTICE = '\n\n[... Content truncated at the size limit ...]';
  const JINA_READER_URL = 'https://r.jina.ai/';

  function getFileParser() {
    return resolveDep('ChatFileParser', './file-parser.js');
  }
  function getOfficeParser() {
    return resolveDep('ChatOfficeParser', './office-parser.js');
  }

  const { resolveDep, fetchWithTimeout, toVisionImage, formatBytes, IMAGE_MIME_TYPES, SAFE_IMAGE_MIME_TYPES } = Utils;

  const getMcpManager = () => resolveDep('ChatMCP', './mcp.js').manager;

  function base64ToArrayBuffer(base64String) {
    const binary = atob(base64String || '');
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  /** Respuesta del backend con la forma de Response que consumen las estrategias. */
  function backendResponse(res) {
    const ok = Boolean(res?.ok) && res.status >= 200 && res.status < 300;
    const status = res?.status || 0;
    const headers = res?.headers || {};
    return {
      ok,
      status,
      statusText: ok ? 'OK' : (res?.error || 'Error'),
      headers: {
        get: name => {
          const lower = String(name).toLowerCase();
          const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === lower);
          if (entry) return entry[1];
          return lower === 'content-type' ? (res?.content_type || '') : null;
        }
      },
      byteSize: res?.byte_size || 0,
      truncated: res?.truncated === true,
      text: async () => (typeof res?.text === 'string' ? res.text : new TextDecoder().decode(base64ToArrayBuffer(res?.base64))),
      json: async () => JSON.parse(typeof res?.text === 'string' ? res.text : new TextDecoder().decode(base64ToArrayBuffer(res?.base64))),
      arrayBuffer: async () => (typeof res?.base64 === 'string' ? base64ToArrayBuffer(res.base64) : new TextEncoder().encode(res?.text || '').buffer),
      error: ok ? undefined : (res?.error || `HTTP ${status}`)
    };
  }

  /** Respuesta de fetch con la forma común de webFetch. */
  function browserResponse(res, error, maxBytes = null) {
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
      byteSize: 0,
      truncated: false,
      text: () => res.text(),
      json: () => res.json(),
      arrayBuffer: () => (maxBytes ? readBodyUpTo(res, maxBytes) : res.arrayBuffer()),
      error: res.ok ? undefined : error
    };
  }

  /**
   * Cuerpo de una descarga directa leído hasta `maxBytes + 1` bytes: lo que pase del tope basta para rechazarlo
   * sin cargar el fichero entero en memoria (el backend corta igual en `maxBytes` y lo marca `truncated`).
   */
  async function readBodyUpTo(res, maxBytes) {
    const reader = res.body?.getReader?.();
    if (!reader) return res.arrayBuffer();
    const limit = maxBytes + 1;
    const chunks = [];
    let length = 0;
    while (length < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      const piece = value.subarray(0, limit - length);
      chunks.push(piece);
      length += piece.byteLength;
    }
    if (length === limit) reader.cancel().catch(() => { /* ya se leyó lo necesario para rechazarlo por tamaño */ });
    const body = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body.buffer;
  }

  /** Respuesta de webFetch para una URL rechazada antes de hacer ninguna petición. */
  function rejectedResponse(error) {
    const empty = () => Promise.reject(new Error(error));
    return {
      ok: false,
      status: 0,
      statusText: error,
      headers: { get: () => null },
      byteSize: 0,
      truncated: false,
      text: empty,
      json: empty,
      arrayBuffer: empty,
      error
    };
  }

  /** Mensaje de error de Jina Reader (`readableMessage` o `message` de su JSON) o el estado HTTP. */
  async function readJinaError(res) {
    try {
      const data = await res.clone().json();
      const detail = data?.readableMessage || data?.message;
      if (typeof detail === 'string' && detail) return `Jina Reader answered HTTP ${res.status}: ${detail}`;
    } catch (_) { /* cuerpo sin JSON: basta el estado */ }
    return `Jina Reader answered HTTP ${res.status}`;
  }

  /**
   * Petición web de ZeroChat. Valida la URL (validateUrlForFetch) antes de cualquier petición: es el
   * único punto de validación, y una URL rechazada devuelve `ok` false con el motivo en `error`.
   * Elige el proxy, porque casi ninguna web permite CORS:
   * - con el backend local conectado, el backend (sin CORS, con su User-Agent, su validación
   *   anti-SSRF y `truncated` si el cuerpo supera `maxBytes`), para leer y para descargar;
   * - sin backend y para leer (`binary` false), Jina Reader, que devuelve el HTML de la página;
   * - sin backend y para descargar (`binary` true), fetch directo con solo Accept, que solo
   *   funciona con las webs que permiten CORS.
   * @param {string} url
   * @param {{ timeoutMs?: number, maxBytes?: number, binary?: boolean, accept?: string }} [options]
   */
  async function webFetch(rawUrl, { timeoutMs = 8000, maxBytes = DEFAULT_MAX_BYTES, binary = false, accept = '*/*' } = {}) {
    const validation = validateUrlForFetch(rawUrl);
    if (!validation.valid) return rejectedResponse(validation.error);
    const { url } = validation;
    const mcp = getMcpManager();
    if (mcp.isProxyConnected()) {
      return backendResponse(await mcp.fetchWebResource(url, { accept, timeoutMs, maxBytes, binary }));
    }

    if (binary) {
      const res = await fetchWithTimeout(url, { headers: { Accept: accept } }, timeoutMs);
      return browserResponse(res, `HTTP ${res.status}: ${res.statusText}`, maxBytes);
    }

    const res = await fetchWithTimeout(`${JINA_READER_URL}${url}`, { headers: { Accept: 'text/html', 'X-Return-Format': 'html' } }, timeoutMs);
    return browserResponse(res, res.ok ? undefined : await readJinaError(res));
  }

  // Las mismas reglas que is_dangerous_host de py/web/fetch.py, que además resuelve el nombre.
  const METADATA_HOSTS = new Set(['169.254.169.254', 'metadata.google.internal', 'instance-data', '100.100.100.200']);
  const LOCAL_NAME_SUFFIX = /\.(?:localhost|local|internal)$/;

  /**
   * IPv4 no pública: sin red (0/8), privadas, CGNAT (100.64/10), loopback, enlace local, multidifusión y reservadas,
   * y los rangos especiales de RFC 6890 (192.0.0/24, documentación 192.0.2/24, 198.51.100/24, 203.0.113/24, pruebas 198.18/15).
   */
  function isPrivateIpv4([a, b, c]) {
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113);
  }

  /** Los 8 grupos de 16 bits de una IPv6 en la forma comprimida y hexadecimal que da URL, o null. */
  function ipv6Groups(host) {
    const halves = host.split('::');
    if (halves.length > 2) return null;
    const parse = part => (part ? part.split(':').map(group => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN)) : []);
    const [head, tail = []] = halves.map(parse);
    if (halves.length === 2 && 8 - head.length - tail.length < 1) return null;
    const groups = halves.length === 2 ? [...head, ...Array(8 - head.length - tail.length).fill(0), ...tail] : head;
    return groups.length === 8 && groups.every(Number.isInteger) ? groups : null;
  }

  /**
   * IPv6 no pública: sin especificar y loopback, ULA (fc00::/7), enlace local (fe80::/10), local de sitio (fec0::/10),
   * multidifusión, documentación, descarte (100::/64), Teredo y ORCHID (2001::/23), 6to4 (2002::/16), NAT64 de uso local
   * (64:ff9b:1::/48), compatible (::/96) y traducida (::ffff:0:0:0/96). La mapeada (::ffff:0:0/96) y la NAT64 (64:ff9b::/96)
   * llegan a la IPv4 que llevan dentro, que es la que se evalúa. Una dirección que no se puede leer se trata como no pública.
   */
  function isPrivateIpv6(host) {
    const groups = ipv6Groups(host);
    if (!groups) return true;
    const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
    const leadingZeros = count => groups.slice(0, count).every(group => group === 0);
    const embeddedIpv4 = () => isPrivateIpv4([g6 >> 8, g6 & 255, g7 >> 8, g7 & 255]);
    if (leadingZeros(5) && g5 === 0xffff) return embeddedIpv4();
    if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return embeddedIpv4();
    return (g0 & 0xfe00) === 0xfc00 || (g0 & 0xffc0) === 0xfe80 || (g0 & 0xffc0) === 0xfec0 || (g0 & 0xff00) === 0xff00
      || (g0 === 0x2001 && g1 === 0x0db8) || (g0 === 0x2001 && g1 < 0x0200) || g0 === 0x2002
      || (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) || (g0 === 0x0064 && g1 === 0xff9b && g2 === 1)
      || leadingZeros(6) || (leadingZeros(4) && g4 === 0xffff && g5 === 0);
  }

  /**
   * Riesgo de SSRF en un host ya normalizado por URL (las formas decimal, hexadecimal, octal o abreviada de una IPv4
   * llegan como a.b.c.d y las IPv6, comprimidas): metadatos cloud, nombres locales y direcciones no públicas.
   */
  function isDangerousIpAddress(hostname) {
    // Todos los puntos finales: localhost.. es localhost para el resolutor.
    const host = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
    if (!host || METADATA_HOSTS.has(host) || host === 'localhost' || LOCAL_NAME_SUFFIX.test(host)) return true;
    const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4) return isPrivateIpv4(ipv4.slice(1).map(Number));
    return host.includes(':') && isPrivateIpv6(host);
  }

  const URL_SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

  /** URL tal como se pedirá: sin espacios, con https:// si no trae esquema y normalizada si se puede analizar. */
  function toWebUrl(rawUrl) {
    if (typeof rawUrl !== 'string') return '';
    const trimmed = rawUrl.trim();
    if (!trimmed) return '';
    const url = URL_SCHEME.test(trimmed) ? trimmed : 'https://' + trimmed;
    try {
      return new URL(url).toString();
    } catch (_) {
      return url;
    }
  }

  /**
   * Valida la URL de destino para prevenir SSRF en servicios de metadatos o esquemas no seguros.
   */
  function validateUrlForFetch(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') {
      return { valid: false, error: 'No valid URL was given.' };
    }

    const scheme = rawUrl.trim().match(URL_SCHEME)?.[1].toLowerCase();
    if (scheme && scheme !== 'http' && scheme !== 'https') {
      return { valid: false, error: `Protocol not allowed: ${scheme}:. Only http:// and https:// are supported.` };
    }

    try {
      const parsed = new URL(toWebUrl(rawUrl));
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { valid: false, error: `Protocol not allowed: ${parsed.protocol}. Only http:// and https:// are supported.` };
      }

      // usuario:clave@ viajaría a Jina Reader o en el Referer de las búsquedas: no se envía a nadie.
      if (parsed.username || parsed.password) {
        return { valid: false, error: 'URLs with credentials (user:password@host) are not allowed: they would be sent to third-party services.' };
      }

      const hostname = parsed.hostname.toLowerCase();
      if (isDangerousIpAddress(hostname)) {
        return { valid: false, error: 'Access blocked: the URL points to internal services, local resources or infrastructure metadata (SSRF protection).' };
      }

      return { valid: true, url: parsed.toString() };
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
   * Extrae el texto legible y estructurado de un documento HTML (ChatHtmlDocument: DOMParser del navegador o árbol ligero en Node.js).
   */
  function extractReadableTextFromHtml(htmlString, targetUrl) {
    const doc = HtmlDocument.parseHtml(htmlString);

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

    const suffix = doc.truncated && doc.truncationNotice ? `\n\n${doc.truncationNotice}` : '';
    const fullOutput = headerInfo + text + suffix;
    if (fullOutput.length > MAX_CONTENT_LENGTH) {
      return fullOutput.slice(0, MAX_CONTENT_LENGTH) + TRUNCATION_NOTICE;
    }
    return fullOutput;
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
   * Documento PDF u ofimático por la extensión de su URL: se descarga una sola vez con
   * fetchBinaryResource (límites de tamaño, vacío y plazo) y se lee en local.
   */
  async function readDocument(url, docType) {
    const binaryResult = await fetchBinaryResource(url, {
      timeoutMs: READ_TIMEOUT_MS,
      accept: docType === 'pdf' ? 'application/pdf,*/*' : '*/*',
      resourceKind: 'document'
    });
    if (!binaryResult.success) return { success: false, status: binaryResult.status, error: binaryResult.error || 'Error downloading the document' };

    const contentType = (binaryResult.contentType || '').toLowerCase();
    const type = detectDocumentType(documentFileName(url), contentType);
    return {
      success: true,
      content: await describeDownloadedDocument(binaryResult.arrayBuffer, url, contentType, type),
      byteSize: binaryResult.byteSize,
      status: binaryResult.status || 200,
      isPdf: type === 'pdf'
    };
  }

  /**
   * Página web con webFetch (backend local si está conectado o, si no, Jina Reader). Un documento
   * sin extensión en la URL se reconoce por el Content-Type: el backend lo entrega en base64.
   */
  async function readPage(url) {
    const res = await webFetch(url, {
      timeoutMs: READ_TIMEOUT_MS,
      maxBytes: MAX_BINARY_BYTES,
      accept: 'text/html,application/xhtml+xml,application/json,application/pdf,text/plain;q=0.9,*/*;q=0.8'
    });
    if (!res.ok) return { success: false, status: res.status, error: res.error || `HTTP ${res.status}: ${res.statusText}` };

    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    const docType = detectDocumentType(documentFileName(url), contentType);
    if (docType) {
      // Un documento cortado no se puede leer: se rechaza en vez de extraer un fichero incompleto.
      if (res.truncated) return { success: false, status: res.status, error: `Document exceeds the size limit of ${formatBytes(MAX_BINARY_BYTES)}.` };
      const arrayBuffer = await res.arrayBuffer();
      return {
        success: true,
        content: await describeDownloadedDocument(arrayBuffer, url, contentType, docType),
        byteSize: arrayBuffer.byteLength,
        status: res.status,
        isPdf: docType === 'pdf'
      };
    }

    const rawText = await res.text();
    let content = (rawText.includes('<html') || rawText.includes('<!DOCTYPE'))
      ? extractReadableTextFromHtml(rawText, url)
      : rawText;
    if (res.truncated) content += TRUNCATION_NOTICE;
    return { success: true, content, byteSize: res.byteSize || rawText.length, status: res.status, isPdf: false };
  }

  /**
   * Consulta una página web o descarga un documento PDF u ofimático y devuelve el contenido legible.
   */
  async function fetchPage(rawUrl) {
    const url = toWebUrl(rawUrl);
    const startTime = performance.now();
    const elapsed = () => parseFloat((performance.now() - startTime).toFixed(2));
    const docType = detectDocumentType(documentFileName(url));

    let result;
    try {
      result = docType ? await readDocument(url, docType) : await readPage(url);
    } catch (err) {
      console.warn(`[WebBrowser] Could not read ${url}:`, err.message);
      result = { success: false, error: err.message };
    }
    if (!result.success) {
      return {
        success: false,
        url,
        content: '',
        elapsedMs: elapsed(),
        error: `The web page could not be accessed or the document downloaded (${result.error || 'connection error or network block'}).`
      };
    }

    // Un contenido que ya trae el aviso (respuesta truncada) se recorta sin él para no repetirlo ni partirlo.
    const body = result.content.endsWith(TRUNCATION_NOTICE) ? result.content.slice(0, -TRUNCATION_NOTICE.length) : result.content;
    const content = body.length > MAX_CONTENT_LENGTH || body !== result.content
      ? body.slice(0, MAX_CONTENT_LENGTH) + TRUNCATION_NOTICE
      : body;
    return {
      success: true,
      url,
      status: result.status || 200,
      content,
      byteSize: result.byteSize || content.length,
      isPdf: result.isPdf,
      elapsedMs: elapsed()
    };
  }

  const MAX_IMAGE_BYTES = MAX_BINARY_BYTES;

  const VISION_IMAGE_MIME_TYPES = SAFE_IMAGE_MIME_TYPES;

  /**
   * Descarga un recurso web binario (ArrayBuffer) con webFetch de forma segura.
   * webFetch valida la URL (anti-SSRF); aquí se aplican los límites de tamaño y el timeout.
   * En caso de error de red o bloqueo de CORS, falla de inmediato sin reintentos externos ni cuelgues.
   */
  async function fetchBinaryResource(rawUrl, options = {}) {
    const url = toWebUrl(rawUrl);
    const startTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const maxBytes = options.maxBytes || MAX_BINARY_BYTES;
    const timeoutMs = options.timeoutMs || 8000;
    const resourceKind = options.resourceKind || 'resource';
    const label = resourceKind.charAt(0).toUpperCase() + resourceKind.slice(1);
    const calcElapsed = () => parseFloat(((typeof performance !== 'undefined' ? performance.now() : Date.now()) - startTime).toFixed(2));

    let res = null;
    try {
      res = await webFetch(url, {
        timeoutMs,
        maxBytes,
        binary: true,
        accept: options.accept || '*/*'
      });
    } catch (err) {
      const isTimeout = err?.name === 'AbortError' || /abort/i.test(err?.message || '');
      return {
        success: false,
        url,
        error: isTimeout
          ? `The download timed out after ${timeoutMs}ms.`
          : `The ${resourceKind} could not be downloaded (${err?.message || 'connection error or network block'}).${getMcpManager().isProxyConnected() ? '' : ' Without the local ZeroChat server, only sites that allow CORS can be downloaded.'}`,
        elapsedMs: calcElapsed()
      };
    }

    if (!res.ok) {
      return {
        success: false,
        url,
        status: res.status,
        error: res.error || `HTTP ${res.status}: ${res.statusText || 'Error fetching resource'}`,
        elapsedMs: calcElapsed()
      };
    }

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
        error: `The ${resourceKind} is empty (0 bytes).`,
        elapsedMs: calcElapsed()
      };
    }

    // El backend corta en maxBytes y lo indica con `truncated`; el navegador entrega el cuerpo entero.
    if (res.truncated || byteLength > maxBytes) {
      return {
        success: false,
        url,
        status: res.status,
        error: `${label} exceeds the size limit of ${formatBytes(maxBytes)}.`,
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
   * y tamaño máximo, y la devuelve como dataUrl base64 para modelos de visión (WebP pasa a JPEG).
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

    let image;
    try {
      image = await toVisionImage(new Uint8Array(binaryResult.arrayBuffer), mimeType);
    } catch (error) {
      return {
        success: false,
        url: binaryResult.url,
        status: binaryResult.status,
        error: `The ${mimeType} image could not be decoded: ${error.message}`,
        elapsedMs: binaryResult.elapsedMs
      };
    }

    return {
      success: true,
      url: binaryResult.url,
      status: binaryResult.status,
      mimeType: image.mimeType,
      byteSize: image.bytes.byteLength,
      fileName: fileName || 'image',
      dataUrl: image.dataUrl,
      elapsedMs: binaryResult.elapsedMs
    };
  }

  return {
    webFetch,
    fetchPage,
    fetchImage,
    fetchBinaryResource,
    validateUrlForFetch,
    detectVisionImageMimeType,
    extractReadableTextFromHtml,
    MAX_IMAGE_BYTES
  };
});
