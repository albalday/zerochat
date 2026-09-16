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
 *        c) Proxy CORS (AllOrigins): Fallback de contingencia para obtener el HTML crudo.
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
    module.exports = factory();
  } else {
    root.ChatWebBrowser = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_CONTENT_LENGTH = 60000;
  const DEFAULT_TIMEOUT_MS = 12000;

  function getFileParser() {
    if (typeof window !== 'undefined' && window.ChatFileParser) {
      return window.ChatFileParser;
    }
    if (typeof require !== 'undefined') {
      try {
        return require('./file-parser.js');
      } catch (e) {}
    }
    return null;
  }

  function getUtils() {
    if (typeof window !== 'undefined' && window.ChatUtils) return window.ChatUtils;
    if (typeof require !== 'undefined') {
      try { return require('./utils.js'); } catch (e) {}
    }
    return null;
  }

  /**
   * Realiza un fetch con timeout controlado mediante AbortController.
   */
  async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const Utils = getUtils();
    if (Utils && typeof Utils.fetchWithTimeout === 'function') {
      return Utils.fetchWithTimeout(url, options, timeoutMs);
    }
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

    try {
      return await fetch(url, {
        ...options,
        signal: controller ? controller.signal : undefined
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

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
      return { valid: false, error: 'No se proporcionó una URL válida.' };
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
      return { valid: false, error: 'Formato de URL inválido.' };
    }
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
        let text = mainElement ? (mainElement.innerText || mainElement.textContent || '') : '';

        text = text.replace(/\r\n/g, '\n')
                   .replace(/[ \t]+/g, ' ')
                   .replace(/\n\s*\n\s*\n+/g, '\n\n')
                   .trim();

        let headerInfo = `[Título: ${title || 'Sin título'}]\n[URL: ${targetUrl}]\n`;
        if (metaDesc) headerInfo += `[Descripción: ${metaDesc}]\n`;
        headerInfo += '\n--- Contenido de la página ---\n';

        const fullOutput = headerInfo + text;
        if (fullOutput.length > MAX_CONTENT_LENGTH) {
          return fullOutput.slice(0, MAX_CONTENT_LENGTH) + '\n\n[... Contenido truncado por longitud ...]';
        }
        return fullOutput;
      }
    } catch (e) {}

    // Fallback simple basado en expresiones regulares para Node.js o entornos sin DOMParser
    const cleanText = htmlString
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s*\n+/g, '\n\n')
      .trim();

    return cleanText.slice(0, MAX_CONTENT_LENGTH);
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
      throw new Error(`El método fetch() debe implementarse en ${this.constructor.name}`);
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
      // No aplicar gateway a hosts locales
      return !context.isLocalUrl;
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
        throw new Error(`Reader Gateway respondió con HTTP ${res.status}`);
      }

      let content = await res.text();
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
   * Estrategia de descarga y extracción de documentos PDF locales/remotos.
   */
  class LocalPdfStrategy extends BaseFetchStrategy {
    constructor(options = {}) {
      super({ name: 'LocalPdfExtractor', timeoutMs: 10000, ...options });
    }

    async canHandle(url, context = {}) {
      return context.isPdfUrl || false;
    }

    async fetch(url, context = {}) {
      const FileParser = getFileParser();
      if (!FileParser || !FileParser.extractTextFromPdf) {
        throw new Error('El módulo ChatFileParser no está disponible para procesar PDFs.');
      }

      const res = await fetchWithTimeout(url, {
        headers: { 'Accept': 'application/pdf,*/*' }
      }, this.timeoutMs);

      if (!res.ok) {
        throw new Error(`Error descargando PDF (HTTP ${res.status})`);
      }

      const arrayBuffer = await res.arrayBuffer();
      const extractedText = await FileParser.extractTextFromPdf(arrayBuffer);
      const fileName = url.split('/').pop().split('?')[0] || 'documento.pdf';
      const sizeStr = FileParser.formatBytes ? FileParser.formatBytes(arrayBuffer.byteLength) : arrayBuffer.byteLength + ' B';

      const content = `[Documento PDF: ${fileName}]\n[URL: ${url}]\n[Tamaño: ${sizeStr}]\n\n--- Contenido extraído del PDF ---\n\n${extractedText}`;

      return {
        success: true,
        content: content,
        byteSize: arrayBuffer.byteLength,
        status: 200,
        isPdf: true,
        strategy: this.name
      };
    }
  }

  /**
   * Estrategia de acceso mediante Proxy CORS (AllOrigins).
   */
  class CorsProxyStrategy extends BaseFetchStrategy {
    constructor(options = {}) {
      super({ name: 'CorsProxy', timeoutMs: 8000, ...options });
    }

    async canHandle(url, context = {}) {
      return !context.isLocalUrl;
    }

    async fetch(url, context = {}) {
      const allOriginsUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
      const res = await fetchWithTimeout(allOriginsUrl, {}, this.timeoutMs);

      if (!res.ok) {
        throw new Error(`Proxy CORS respondió con HTTP ${res.status}`);
      }

      const data = await res.json();
      const rawHtml = data.contents || '';
      if (!rawHtml) {
        throw new Error('Proxy CORS no devolvió contenido.');
      }

      const content = extractReadableTextFromHtml(rawHtml, url);
      return {
        success: true,
        content: content,
        byteSize: rawHtml.length,
        status: data.status?.http_code || 200,
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
      const FileParser = getFileParser();
      const res = await fetchWithTimeout(url, {
        headers: { 'Accept': 'text/html,application/xhtml+xml,application/json,application/pdf,text/plain;q=0.9,*/*;q=0.8' }
      }, this.timeoutMs);

      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      const isPdf = context.isPdfUrl || contentType.includes('application/pdf');

      let content = '';
      let byteSize = 0;

      if (isPdf && FileParser && FileParser.extractTextFromPdf) {
        const arrayBuffer = await res.arrayBuffer();
        byteSize = arrayBuffer.byteLength;
        const extractedText = await FileParser.extractTextFromPdf(arrayBuffer);
        const fileName = url.split('/').pop().split('?')[0] || 'documento.pdf';
        content = `[Documento PDF: ${fileName}]\n[URL: ${url}]\n\n--- Contenido extraído del PDF ---\n\n${extractedText}`;
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
        new LocalPdfStrategy(),
        new DirectFetchStrategy(),
        new CorsProxyStrategy()
      ];
    }

    /**
     * Registra o añade una estrategia al pipeline.
     */
    addStrategy(strategy, unshift = false) {
      if (unshift) {
        this.strategies.unshift(strategy);
      } else {
        this.strategies.push(strategy);
      }
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
      const isPdfUrl = /\.pdf(\?|#|$)/i.test(url);

      const context = {
        isLocalUrl,
        isPdfUrl,
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
              content = content.slice(0, MAX_CONTENT_LENGTH) + '\n\n[... Contenido truncado por límite de tamaño ...]';
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
          console.warn(`Estrategia ${strategy.name} falló para ${url}:`, err.message);
        }
      }

      const endTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
      return {
        success: false,
        url: url,
        content: '',
        elapsedMs: parseFloat((endTime - startTime).toFixed(2)),
        error: `No se pudo acceder a la página web o descargar el documento (${lastError ? lastError.message : 'Error de conexión o bloqueo de red'}).`
      };
    }
  }

  const pipeline = new PageFetcherPipeline();

  /**
   * Consulta una página web o descarga un documento PDF y devuelve el contenido legible.
   */
  async function fetchPage(rawUrl, options = {}) {
    return pipeline.fetch(rawUrl, options);
  }

  /**
   * Definiciones estándar de herramientas (Tool/Function Calling) para OpenAI y LLMs compatibles.
   */
  const WEB_TOOL_DEFINITION = {
    type: 'function',
    function: {
      name: 'fetch_web_page',
      description: 'Descarga y lee el texto y contenido de una página web o artículo a partir de su URL (ej: "https://es.wikipedia.org/wiki/Sol" o "https://nodejs.org/en/about").',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'URL de la página web a consultar.'
          }
        },
        required: ['url']
      }
    }
  };

  const PDF_TOOL_DEFINITION = {
    type: 'function',
    function: {
      name: 'download_pdf',
      description: 'Descarga un archivo o documento PDF desde una URL web y extrae todo su texto legible para analizarlo e integrarlo en el contexto de la conversación (ej: "https://arxiv.org/pdf/2310.06825.pdf" o "https://ejemplo.com/informe.pdf").',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'URL directa del documento PDF a descargar y extraer.'
          }
        },
        required: ['url']
      }
    }
  };

  return {
    fetchPage,
    downloadPdf: fetchPage,
    validateUrlForFetch,
    extractReadableTextFromHtml,
    BaseFetchStrategy,
    ReaderGatewayStrategy,
    LocalPdfStrategy,
    DirectFetchStrategy,
    CorsProxyStrategy,
    PageFetcherPipeline,
    pipeline,
    WEB_TOOL_DEFINITION,
    PDF_TOOL_DEFINITION
  };
});
