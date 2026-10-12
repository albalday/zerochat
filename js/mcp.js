/**
 * Integración MCP (Model Context Protocol) de ZeroChat con el servidor local zerochat.py.
 *
 * - Transporte JSON-RPC 2.0 sobre HTTP y SSE (EventSource o fetch en streaming).
 * - El servidor local expone sus herramientas (`mcp_proxy`) y las de los servicios MCP externos que
 *   gestiona por stdio (`mcp_external`); el navegador no lanza procesos.
 * - Las cabeceras y tokens solo viven en el cliente HTTP: nunca llegan al prompt ni al ejecutor de
 *   JavaScript. Cada herramienta indica el servidor del que procede.
 * - Las peticiones tienen plazo (AbortController) y las respuestas se truncan para no desbordar el
 *   contexto.
 */

(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./utils.js'), require('./i18n.js'), require('./icons.js'), require('./defaults.js'));
  } else {
    root.ChatMCP = factory(root.ChatUtils, root.ChatI18n, root.ChatIcons, root.ChatDefaults);
  }
})(typeof self !== 'undefined' ? self : this, function (Utils, I18n, Icons, Defaults) {
  'use strict';

  const { fetchWithTimeout, resolveDep, escapeHtml } = Utils;

  // Shared wire contract with public_tool_name in zerochat.py: keep a-y, A-Z
  // and 0-9, and escape anything else as z<hex code point>z. The lowercase z is
  // escaped too because it opens every escape; tool components keep underscores.
  function publicToolName(serverId, originalName) {
    const encode = (value, tool = false) => {
      if (typeof value !== 'string' || !value || value.length > 256) {
        throw new Error('Invalid MCP name component');
      }
      // MCP function names and the registry preserve ASCII case.  Keeping it
      // makes names supplied by a remote service readable to people and models.
      return Array.from(value, ch => /^[a-yA-Z0-9]$/.test(ch) || (tool && ch === '_')
        ? ch : `z${ch.codePointAt(0).toString(16)}z`).join('');
    };
    const name = serverId === null ? encode(originalName, true)
      : `${encode(serverId)}_${encode(originalName, true)}`;
    if (name.length > 64) throw new Error('MCP public name exceeds 64 characters');
    return name;
  }

  const PROXY_ID = 'mcp_proxy';
  const EXTERNAL_ID = 'mcp_external';
  const DEFAULT_TIMEOUT_MS = 15000;
  const LOCAL_COMMAND_TOOL = 'run_command';
  const LOCAL_COMMAND_CHECK_TOOL = 'check_command';
  const EXTERNAL_START_POLL_ATTEMPTS = 10;
  const EXTERNAL_START_POLL_INTERVAL_MS = 15000;
  // Cubre los límites del backend (npm install y descarga del navegador, 600 s cada uno)
  // y la espera de la autorización OAuth.
  const EXTERNAL_LONG_START_POLL_ATTEMPTS = 80;
  const HEARTBEAT_INTERVAL_MS = 10000;
  const MAX_OUTPUT_LENGTH = 60000;
  const MAX_IMAGE_BASE64_LENGTH = 8 * 1024 * 1024;
  const SAFE_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
  const TOOL_AUTH_VERSION = 'zerochat-tool-auth-v1';
  const UNREACHABLE_SERVER_ERROR = 'Cannot reach the local server at that address and port. Make sure zerochat is running in your terminal.';

  const getAgentCore = () => resolveDep('ChatAgentCore', './agent-core.js');
  const getState = () => resolveDep('ChatState', './state.js');
  const getCommandCard = () => resolveDep('ChatCommandCard', './command-card.js');
  const getSecurity = () => resolveDep('ChatToolSecurity', './tool-security.js');

  const proxyEndpoint = (host, port) => `http://${host}:${port}/sse`;

  /** Imagen base64 segura (tipo permitido y tamaño acotado) como data URL; null si no lo es. */
  function toSafeImageDataUrl(base64, mimeType) {
    const type = String(mimeType || 'image/png').toLowerCase();
    if (!SAFE_IMAGE_MIME_TYPES.has(type) || typeof base64 !== 'string' || base64.length === 0 ||
        base64.length > MAX_IMAGE_BASE64_LENGTH || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
      return null;
    }
    return `data:${type};base64,${base64}`;
  }

  function parseDataUrl(value) {
    const match = String(value || '').match(/^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/i);
    return match ? { mimeType: match[1].toLowerCase(), base64: match[2] } : null;
  }

  /**
   * Una herramienta del servidor local puede devolver una captura en `image_base64`: se separa del
   * texto para entregarla al modelo como evidencia visual y no como base64 dentro del contexto.
   */
  function extractImageFromMcpText(textOutput) {
    let parsed;
    try {
      parsed = JSON.parse(textOutput);
    } catch (_) {
      return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.image_base64 !== 'string') return null;
    const embedded = parseDataUrl(parsed.image_base64);
    const mimeType = String(embedded?.mimeType || parsed.mime_type || parsed.mimeType || 'image/png').toLowerCase();
    const imageBase64 = embedded?.base64 || parsed.image_base64;
    if (!toSafeImageDataUrl(imageBase64, mimeType)) return null;
    parsed.image_base64 = `[Base64 image (${mimeType}), length: ${imageBase64.length} chars - attached as visual evidence]`;
    return { content: JSON.stringify(parsed, null, 2), imageBase64, mimeType };
  }

  function getSafeMcpImageDataUrl(result) {
    return toSafeImageDataUrl(result?.image_base64, result?.mime_type);
  }

  function getSafeMcpImageFromMessage(message) {
    const image = message?.images?.find(item => item?.dataUrl);
    const parsed = parseDataUrl(image?.dataUrl);
    return parsed ? toSafeImageDataUrl(parsed.base64, parsed.mimeType) : null;
  }

  /** Texto del resultado de una herramienta MCP para el modelo, la tarjeta y la exportación. */
  function getResultText(result) {
    if (result.content) return result.content;
    if (result.rawResult) return typeof result.rawResult === 'string' ? result.rawResult : JSON.stringify(result.rawResult, null, 2);
    return result.error || I18n.t('tool_no_output');
  }

  /**
   * Sondea de forma no destructiva un endpoint MCP para verificar conectividad y latencia.
   */
  async function probeConnection(url, options = {}) {
    const timeoutMs = options.timeoutMs || 4000;
    const startTime = performance.now();
    const normalizedUrl = (url || '').trim();
    if (!normalizedUrl) return { success: false, error: 'Invalid or empty URL', latencyMs: 0 };

    const client = new McpClient({ url: normalizedUrl, timeoutMs, token: options.token });
    const latency = () => Math.max(1, Math.round(performance.now() - startTime));
    const describe = message => (/Failed to fetch|NetworkError|ECONNREFUSED/.test(message) ? UNREACHABLE_SERVER_ERROR : message);
    try {
      const initResult = await client.initialize({ timeoutMs });
      if (initResult.success) {
        return { success: true, latencyMs: latency(), serverInfo: initResult.serverInfo, capabilities: initResult.capabilities };
      }
      return { success: false, error: describe(initResult.error), latencyMs: latency() };
    } catch (err) {
      return { success: false, error: describe(err.message || 'Connection error'), latencyMs: latency() };
    } finally {
      client.disconnect();
    }
  }

  function isTransportFailure(error) {
    if (!error || error.name === 'AbortError') return false;
    const message = String(error.message || error).toLowerCase();
    return /network|fetch|econnrefused|timeout|mcp connection closed|http 5\d\d|http 404/.test(message);
  }

  function base64Url(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  }

  function base64UrlBytes(value) {
    const padded = String(value).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(value).length + 3) % 4);
    return Uint8Array.from(atob(padded), char => char.charCodeAt(0));
  }

  function hex(bytes) {
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  }

  const formatJsonRpcError = error => `MCP error${error.code ? ` (${error.code})` : ''}: ${error.message || JSON.stringify(error)}`;

  /**
   * Cliente de Protocolo MCP (Model Context Protocol) basado en JSON-RPC 2.0 sobre HTTP.
   */
  class McpClient {
    constructor(config = {}) {
      this.id = config.id || `mcp_server_${Date.now()}`;
      this.name = config.name || 'MCP Server';
      this.url = (config.url || '').trim().replace(/\/+$/, '');
      this.postUrl = null;
      this.isSseActive = false;
      this.sseSource = null;
      this.sseReader = null;
      this.pendingRequests = new Map();
      this.headers = config.headers || {};
      this.timeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS;
      this.token = config.token || null;
      this.requestId = 1;
      this.serverCapabilities = null;
      this.serverInfo = null;
      this.toolAuthorization = null;
    }

    /** Solo el servidor local firma las llamadas a sus herramientas. */
    get isLocalServer() {
      return this.id === PROXY_ID || this.id === EXTERNAL_ID;
    }

    /**
     * Cierra de forma limpia la conexión SSE activa y resetea las URLs efímeras de sesión.
     */
    disconnect() {
      this.sseSource?.close();
      this.sseSource = null;
      this.sseReader?.cancel().catch(() => {});
      this.sseReader = null;
      this.isSseActive = false;
      this.postUrl = null;
      for (const request of this.pendingRequests.values()) {
        clearTimeout(request.timer);
        request.reject(new Error('MCP connection closed'));
      }
      this.pendingRequests.clear();
    }

    /**
     * Construye las cabeceras HTTP necesarias, incluyendo autenticación si está configurada.
     */
    buildHeaders() {
      const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream, */*',
        'X-ZeroChat-Client': '1'
      };
      if (this.token) {
        headers['Authorization'] = `Bearer ${this.token}`;
        headers['X-ZeroChat-Token'] = this.token;
      }
      return Object.assign(headers, this.headers);
    }

    async buildToolAuthorizationHeaders(targetUrl, body) {
      const credentials = this.toolAuthorization;
      if (!credentials) throw new Error('Local tool authorization is unavailable. Reconnect to ZeroChat.');
      const expiresAt = Date.now() + credentials.ttlMs;
      const nonceBytes = new Uint8Array(16);
      crypto.getRandomValues(nonceBytes);
      const nonce = base64Url(nonceBytes);
      const bodyHash = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body))));
      const path = new URL(targetUrl).pathname.replace(/\/$/, '') || '/';
      const signatureBase = JSON.stringify([TOOL_AUTH_VERSION, credentials.sessionId, 'POST', path, expiresAt, nonce, bodyHash]);
      const key = await crypto.subtle.importKey('raw', base64UrlBytes(credentials.key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const signature = base64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signatureBase))));
      return {
        'X-ZeroChat-Tool-Session': credentials.sessionId,
        'X-ZeroChat-Tool-Expires': String(expiresAt),
        'X-ZeroChat-Tool-Nonce': nonce,
        'X-ZeroChat-Tool-Signature': signature
      };
    }

    async buildRequestHeaders(targetUrl, body, options) {
      const headers = this.buildHeaders();
      if (options.toolAuthorization && this.isLocalServer) {
        Object.assign(headers, await this.buildToolAuthorizationHeaders(targetUrl, body));
      }
      return headers;
    }

    /**
     * Inicia o reutiliza la conexión SSE persistente para recibir el endpoint y respuestas asíncronas.
     */
    async connectSseStream(options = {}) {
      if (!options.forceReconnect && this.postUrl && this.isSseActive) return this.postUrl;
      this.disconnect();
      const timeoutMs = options.timeoutMs || 4000;

      return new Promise(resolve => {
        let settled = false;
        const finish = url => {
          if (settled) return;
          settled = true;
          this.postUrl = url;
          resolve(url);
        };

        let source;
        const timer = setTimeout(() => {
          source?.close();
          if (this.sseSource === source) this.isSseActive = false;
          finish(this.url);
        }, timeoutMs);
        // Sin canal SSE, las peticiones se envían directamente a la URL del servidor.
        const fallBackToPost = () => {
          clearTimeout(timer);
          if (source && this.sseSource !== source) return;
          this.isSseActive = false;
          finish(this.url);
        };

        // EventSource cannot send authentication or custom HTTP headers.
        if (typeof EventSource !== 'undefined' && !this.token && Object.keys(this.headers).length === 0) {
          const es = new EventSource(this.url);
          source = es;
          this.sseSource = es;
          this.isSseActive = true;
          es.addEventListener('endpoint', evt => {
            clearTimeout(timer);
            finish(new URL((evt.data || '').trim(), this.url).toString());
          });
          es.addEventListener('message', evt => this._handleJsonRpcMessage(evt.data));
          es.onerror = () => {
            es.close();
            fallBackToPost();
          };
          return;
        }

        const controller = new AbortController();
        source = { close: () => {
          controller.abort();
          clearTimeout(timer);
          finish(this.url);
        } };
        this.sseSource = source;
        fetch(this.url, {
          headers: { ...this.buildHeaders(), 'Accept': 'text/event-stream' },
          signal: controller.signal,
          // Firefox retiene otro GET a la misma URL mientras escribe en caché un stream abierto.
          cache: 'no-store',
          redirect: 'error'
        }).then(async res => {
          if (controller.signal.aborted || this.sseSource !== source) return;
          if (!res.ok || !res.body) {
            source.close();
            fallBackToPost();
            return;
          }
          const reader = res.body.getReader();
          this.sseReader = reader;
          this.isSseActive = true;
          const decoder = new TextDecoder();
          let buffer = '';
          while (!controller.signal.aborted && this.sseSource === source) {
            const { done, value } = await reader.read();
            if (controller.signal.aborted || this.sseSource !== source) return;
            if (done) {
              fallBackToPost();
              return;
            }
            buffer += decoder.decode(value, { stream: true });
            const chunks = buffer.split(/\r?\n\r?\n/);
            buffer = chunks.pop() || '';
            for (const chunk of chunks) {
              if (chunk.length > MAX_OUTPUT_LENGTH) throw new Error('MCP SSE event too large');
              const endpointMatch = chunk.match(/event:\s*endpoint\s*\n\s*data:\s*([^\r\n]+)/);
              if (endpointMatch) {
                const fullUrl = new URL(endpointMatch[1].trim(), this.url);
                if (fullUrl.origin !== new URL(this.url).origin) throw new Error('MCP SSE endpoint must have the same origin');
                clearTimeout(timer);
                finish(fullUrl.toString());
                continue;
              }
              const msgMatch = chunk.match(/(?:event:\s*message\s*\n\s*)?data:\s*([^\r\n]+)/);
              if (msgMatch) this._handleJsonRpcMessage(msgMatch[1]);
            }
            if (buffer.length > MAX_OUTPUT_LENGTH) throw new Error('MCP SSE event too large');
          }
        }).catch(() => {
          if (this.sseSource !== source) return;
          source.close();
          fallBackToPost();
        });
      });
    }

    _handleJsonRpcMessage(raw) {
      let data;
      try {
        data = JSON.parse(String(raw).trim());
      } catch (e) {
        console.warn('[MCP] Ignoring malformed JSON-RPC message:', e);
        return;
      }
      const pending = data && this.pendingRequests.get(data.id);
      if (!pending) return;
      this.pendingRequests.delete(data.id);
      clearTimeout(pending.timer);
      if (data.error) pending.reject(new Error(formatJsonRpcError(data.error)));
      else pending.resolve(data.result);
    }

    /**
     * Resuelve la URL adecuada para enviar peticiones POST al servidor MCP.
     */
    async resolvePostUrl(options = {}) {
      if (!options.forceReconnect && this.postUrl && this.isSseActive) return this.postUrl;
      if (this.url.endsWith('/sse') || options.isSse) return this.connectSseStream(options);
      return this.postUrl || this.url;
    }

    /**
     * Despacha una petición JSON-RPC 2.0 al endpoint del servidor MCP.
     */
    async request(method, params = {}, options = {}) {
      if (!this.url) throw new Error(`MCP server '${this.name}' has no URL.`);

      const isSseEndpoint = this.url.endsWith('/sse') || options.isSse;
      const targetUrl = await this.resolvePostUrl(options);
      const id = this.requestId++;
      const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      const timeoutMs = options.timeoutMs || this.timeoutMs;
      // Con señal propia (las herramientas) cancela quien llama: un comando puede durar minutos.
      const fetchTimeoutMs = options.signal ? 0 : timeoutMs;
      const post = async url => fetchWithTimeout(url, {
        method: 'POST',
        headers: await this.buildRequestHeaders(url, body, options),
        body,
        signal: options.signal
      }, fetchTimeoutMs);
      const retry = () => {
        this.disconnect();
        return this.request(method, params, { ...options, _isRetry: true, forceReconnect: true });
      };

      let res;
      try {
        res = await post(targetUrl);
      } catch (fetchErr) {
        // Un timeout no es un fallo de red: reintentar desconectaría el canal y
        // reenviaría la petición, que no tiene por qué ser idempotente.
        if (fetchErr.name === 'AbortError') throw fetchErr;
        // En caso de fallo de red en endpoint SSE, reconectar y reintentar una única vez
        if (!options.toolAuthorization && !options._isRetry && (isSseEndpoint || this.postUrl)) return retry();
        throw fetchErr;
      }

      // Un 404 de la sesión SSE indica que caducó o que el servidor se reinició: se reconecta una vez.
      if (res.status === 404 && !options._isRetry && (isSseEndpoint || targetUrl.includes('session_id') || this.postUrl)) return retry();

      // Si targetUrl devolvió 405 y no habíamos probado SSE, intentamos SSE
      if (res.status === 405 && !isSseEndpoint) {
        const resolved = await this.connectSseStream({ ...options, isSse: true });
        if (resolved !== targetUrl) res = await post(resolved);
      }

      // Con 202 Accepted la respuesta llega por el canal SSE.
      if (res.status === 202) {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            if (!this.pendingRequests.delete(id)) return;
            const error = new Error(`Timed out waiting for request #${id} (${method})`);
            error.code = 'MCP_REQUEST_TIMEOUT';
            reject(error);
          }, timeoutMs);
          this.pendingRequests.set(id, { resolve, reject, timer });
        });
      }

      if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        throw new Error(`MCP server responded with HTTP ${res.status}: ${errorText.slice(0, 200)}`);
      }
      const data = await res.json();
      if (data.error) throw new Error(formatJsonRpcError(data.error));
      return data.result;
    }

    /**
     * Negocia el protocolo e inicializa la sesión MCP (initialize).
     */
    async initialize(options = {}) {
      let result;
      try {
        result = await this.request('initialize', {
          protocolVersion: '2024-11-05',
          capabilities: { roots: { listChanged: false }, sampling: {} },
          clientInfo: { name: 'ZeroChat', version: Defaults.APP_VERSION }
        }, options);
      } catch (err) {
        return { success: false, error: err.message };
      }

      this.serverCapabilities = result?.capabilities || {};
      this.serverInfo = result?.serverInfo || { name: this.name, version: 'unknown' };
      const auth = result?.toolAuthorization;
      if (this.isLocalServer && auth?.version === TOOL_AUTH_VERSION && typeof auth.sessionId === 'string' &&
          typeof auth.key === 'string' && Number.isInteger(auth.ttlMs) && auth.ttlMs > 0 && auth.ttlMs <= 30_000) {
        this.toolAuthorization = { sessionId: auth.sessionId, key: auth.key, ttlMs: auth.ttlMs };
      }
      await this.notify('notifications/initialized', {});
      return { success: true, serverInfo: this.serverInfo, capabilities: this.serverCapabilities };
    }

    /**
     * Envía una notificación JSON-RPC (sin esperar resultado).
     */
    async notify(method, params = {}) {
      try {
        const targetUrl = await this.resolvePostUrl();
        const res = await fetch(targetUrl, {
          method: 'POST',
          headers: this.buildHeaders(),
          body: JSON.stringify({ jsonrpc: '2.0', method, params })
        });
        if (res.status === 404 && this.postUrl) this.disconnect();
      } catch (e) {
        console.warn(`[MCP] Notification ${method} could not be sent:`, e);
      }
    }

    /**
     * Descubre las herramientas disponibles en el servidor MCP (tools/list).
     */
    async listTools(options = {}) {
      const result = await this.request('tools/list', {}, options);
      return Array.isArray(result?.tools) ? result.tools : [];
    }

    /**
     * Invoca una herramienta en el servidor MCP (tools/call).
     */
    async callTool(name, args = {}, options = {}) {
      const startTime = performance.now();
      const result = await this.request('tools/call', {
        name,
        arguments: args,
        ...(options.meta ? { _meta: options.meta } : {})
      }, options);
      const elapsed = parseFloat((performance.now() - startTime).toFixed(2));

      let textOutput = '';
      if (Array.isArray(result?.content)) {
        textOutput = result.content.map(item => {
          if (item.type === 'text') return item.text || '';
          if (item.type === 'image') return `[Embedded image: ${item.mimeType || 'image/png'}]`;
          if (item.type === 'resource') return `[Resource: ${item.resource?.uri || 'URI'}]\n${item.resource?.text || ''}`;
          return JSON.stringify(item);
        }).join('\n\n').trim();
      } else if (typeof result === 'string') {
        textOutput = result;
      } else if (result) {
        textOutput = JSON.stringify(result, null, 2);
      }

      const extractedImage = extractImageFromMcpText(textOutput);
      if (extractedImage) textOutput = extractedImage.content;
      if (textOutput.length > MAX_OUTPUT_LENGTH) {
        textOutput = textOutput.slice(0, MAX_OUTPUT_LENGTH) + '\n\n[... MCP content truncated due to size limit ...]';
      }

      const isError = result?.isError === true;
      return {
        success: !isError,
        isError,
        content: textOutput,
        rawResult: result,
        ...(extractedImage ? { image_base64: extractedImage.imageBase64, mime_type: extractedImage.mimeType } : {}),
        executionTimeMs: elapsed
      };
    }
  }

  function formatMcpMarkdown(toolName, args, result, serverName) {
    const argStr = args && Object.keys(args).length ? JSON.stringify(args, null, 2) : '';
    const parts = [`> **${toolName}** (*${serverName}*)`];
    if (argStr) parts.push(`> \`\`\`json\n> ${argStr.split('\n').join('\n> ')}\n> \`\`\``);
    parts.push(`> \`\`\`\n> ${String(getResultText(result)).split('\n').join('\n> ')}\n> \`\`\``);
    return parts.join('\n');
  }

  function appendMcpScreenshot(card, dataUrl, t) {
    const figure = card.ownerDocument.createElement('figure');
    figure.className = 'mcp-screenshot-preview';
    const image = card.ownerDocument.createElement('img');
    image.className = 'mcp-screenshot-image';
    image.src = dataUrl;
    image.alt = t('mcp_screenshot_alt');
    image.loading = 'lazy';
    image.decoding = 'async';
    const caption = card.ownerDocument.createElement('figcaption');
    caption.textContent = t('mcp_screenshot_caption');
    figure.append(image, caption);
    card.querySelector('.tool-card-result').appendChild(figure);
  }

  function createMcpToolView(toolName, serverName) {
    const iconSvg = Icons.get('plug', { size: 14 });
    const codeBlock = text => `<pre class="tool-card-code"><code>${escapeHtml(text)}</code></pre>`;

    const renderCard = (args, contentHtml, badgeHtml, ui, collapsed) => {
      const card = ui.createCardWrapper('mcp-card');
      const argStr = args && Object.keys(args).length ? escapeHtml(JSON.stringify(args, null, 2)) : '';
      card.innerHTML = resolveDep('ChatToolCards', './tool-cards.js').renderCardHtml({
        collapsed,
        titleHtml: `${iconSvg}<span>${escapeHtml(toolName)}</span>`,
        titleSuffixHtml: `<span class="tool-card-tag">${escapeHtml(serverName)}</span>`,
        badgeHtml,
        bodyHtml: `${argStr ? `<div class="mcp-input-summary"><code>${argStr}</code></div>` : ''}<div class="tool-card-result">${contentHtml}</div>`
      });
      return card;
    };

    return {
      createLiveCard: (args, ui) => {
        const running = `${ui.SPINNER_SVG} <span>${ui.t('tool_badge_executing')}</span>`;
        return renderCard(args, `<div class="tool-loading-placeholder">${running}</div>`, `<span class="tool-card-badge status-loading">${running}</span>`, ui, false);
      },
      updateLiveCard: (card, args, result, elapsedMs, ui) => {
        const isSuccess = result.success !== false && !result.error && !result.isError;
        const badge = card.querySelector('.tool-card-badge');
        badge.className = `tool-card-badge ${isSuccess ? 'status-success' : 'status-error'}`;
        badge.innerHTML = isSuccess
          ? `${ui.CHECK_SVG} <span>${ui.t('tool_status_success')} (${elapsedMs}ms)</span>`
          : `${ui.ERROR_SVG} <span>${ui.t('tool_status_error', { ms: elapsedMs })}</span>`;
        card.querySelector('.tool-card-result').innerHTML = codeBlock(getResultText(result));
        const screenshot = getSafeMcpImageDataUrl(result);
        if (!screenshot) return false;
        appendMcpScreenshot(card, screenshot, ui.t);
        return true;
      },
      renderHistoricalCard: (args, message, ui) => {
        const out = typeof message?.content === 'string' ? message.content : (message?.content ? JSON.stringify(message.content, null, 2) : '');
        const badge = `<span class="tool-card-badge status-success">${ui.CHECK_SVG} <span>${ui.t('tool_status_success')}</span></span>`;
        const card = renderCard(args, codeBlock(out), badge, ui, true);
        const screenshot = getSafeMcpImageFromMessage(message);
        if (screenshot) appendMcpScreenshot(card, screenshot, ui.t);
        return card;
      }
    };
  }

  /** Resumen serializable de una herramienta para ChatState y los ajustes. */
  function summarizeTool(tool) {
    return {
      name: tool.name,
      description: tool.metadata.description,
      inputSchema: tool.parameters,
      available: tool.metadata.available,
      metadata: {
        mcpServerName: tool.metadata.mcpServerName,
        mcpServerId: tool.metadata.mcpServerId,
        originalName: tool.metadata.originalName
      }
    };
  }

  /**
   * Proveedor de herramientas MCP integrado en la arquitectura AgentCore (McpToolProvider).
   */
  class McpToolProvider {
    constructor(client, options = {}) {
      this.client = client;
      this.id = options.id || `mcp_prov_${client.id}`;
      this.name = options.name || client.name;
      this.serverName = client.name;
      this.serverUrl = client.url;
      this.onTransportFailure = options.onTransportFailure || null;
      this.cachedTools = [];
    }

    /**
     * Descubre las herramientas remotas del servidor MCP y las transforma en instancias Tool.
     */
    async discoverTools(options = {}) {
      const { Tool } = getAgentCore();
      const initialization = await this.client.initialize(options);
      if (!initialization.success) throw new Error(initialization.error);
      const rawTools = await this.client.listTools(options);
      const external = this.client.id === EXTERNAL_ID;
      const isProxy = this.client.id === PROXY_ID;
      const toolInstances = [];

      for (const rt of rawTools) {
        const sourceServer = external ? rt.metadata?.mcpServerId : this.client.id;
        const serverName = external ? sourceServer : this.serverName;
        const toolName = external ? rt.metadata?.originalName : rt.name;
        // run_command del servidor local: tarjeta propia y detención del comando al abortar.
        const isLocalCommand = isProxy && toolName === LOCAL_COMMAND_TOOL;
        const namespacedName = publicToolName(isProxy ? null : sourceServer, toolName);
        if (external && rt.name !== namespacedName) throw new Error('Invalid external MCP public name');
        if (toolInstances.some(tool => tool.name === namespacedName)) throw new Error('Duplicate MCP public name');
        const available = rt.availability?.available !== false;

        toolInstances.push(new Tool({
          // El nombre público ya identifica el servidor; repetirlo en la descripción gasta contexto.
          definition: { name: namespacedName, description: rt.description || toolName, parameters: rt.inputSchema },
          category: 'mcp',
          isAvailable: () => available && (!isProxy || getState().get('mcp').status === 'connected'),
          settings: { defaultEnabled: available, showInSettings: true },
          metadata: {
            iconSvg: Icons.get('plug', { size: 14 }),
            mcpServerName: serverName,
            mcpServerUrl: this.serverUrl,
            originalName: toolName,
            mcpServerId: sourceServer,
            description: rt.description || '',
            available
          },
          execute: async (args, context) => {
            // Un comando del servidor local sigue vivo aunque se aborte la petición: se detiene
            // con la clave de la invocación, que el servidor conoce antes de devolver su job_id.
            const jobKey = isLocalCommand ? context.invocationId : null;
            const stopJob = () => {
              this.client.request('zerochat/jobs/stop', { key: jobKey }).catch(() => {});
            };
            if (jobKey) context.signal?.addEventListener('abort', stopJob, { once: true });
            try {
              return await this.client.callTool(rt.name, args, {
                signal: context.signal,
                timeoutMs: options.timeoutMs,
                toolAuthorization: context.toolAuthorization === true,
                meta: jobKey ? { zerochatJobKey: jobKey } : undefined
              });
            } catch (error) {
              if (isProxy && isTransportFailure(error)) await this.onTransportFailure?.(error);
              throw error;
            } finally {
              if (jobKey) context.signal?.removeEventListener('abort', stopJob);
            }
          },
          result: {
            toModel: (args, result) => getResultText(result),
            toMarkdown: (args, result) => formatMcpMarkdown(toolName, args, result, serverName)
          },
          view: isLocalCommand ? getCommandCard().createView() : createMcpToolView(toolName, serverName)
        }));
      }

      this.cachedTools = toolInstances;
      return toolInstances;
    }

    /**
     * Devuelve las herramientas descubiertas registradas en este proveedor.
     */
    getTools() {
      return this.cachedTools;
    }
  }

  // Con la interfaz servida por el propio zerochat.py el latido usa una ruta relativa.
  function getHeartbeatUrl(host, port) {
    const local = ['127.0.0.1', 'localhost'];
    const pagePort = location.port || (location.protocol === 'https:' ? '443' : '80');
    const samePage = location.protocol.startsWith('http') && String(port) === pagePort &&
      (location.hostname === host || (local.includes(location.hostname) && local.includes(host)));
    return samePage ? '/zerochat/heartbeat' : `http://${host}:${port}/zerochat/heartbeat`;
  }

  /**
   * Conexión con el servidor local: sus herramientas, las de los servicios MCP externos que gestiona,
   * los comandos en segundo plano y el directorio del proyecto.
   */
  class McpManager {
    constructor() {
      this.clients = new Map();
      this.sessionToken = null;
      this.healthCheckPromise = null;
      this.externalStartupNoticeShown = false;
      this.heartbeatTarget = null;
      this.heartbeatTimer = null;
      this.heartbeatCheckInFlight = false;
    }

    setSessionToken(token) {
      this.sessionToken = token ? String(token).trim() : null;
      for (const client of this.clients.values()) client.token = this.sessionToken;
    }

    getSessionToken() {
      return this.sessionToken;
    }

    /** Cierra el cliente y retira del registro las herramientas de su proveedor. */
    dropClient(clientId) {
      getAgentCore().registry.unregisterProvider(`mcp_prov_${clientId}`);
      this.clients.get(clientId)?.disconnect();
      this.clients.delete(clientId);
    }

    /** Descubre las herramientas de un cliente y las registra; devuelve sus resúmenes. */
    async registerClient(client, options = {}) {
      const provider = new McpToolProvider(client, options);
      const tools = await provider.discoverTools();
      getAgentCore().registry.registerProvider(provider);
      this.clients.set(client.id, client);
      return tools.map(summarizeTool);
    }

    /**
     * Publica el directorio del proyecto que informa el servidor local (al cambiarlo o en el
     * heartbeat) para que el modo proyecto y la regla de lectura por defecto lo sigan.
     */
    syncProjectDirectory(cwd) {
      const State = getState();
      const current = State.get('mcp');
      const next = typeof cwd === 'string' ? cwd.trim() : '';
      if (!next || current.status !== 'connected' || !current.serverInfo || current.serverInfo.cwd === next) return false;
      getSecurity().manager.setStartupDirectory(next);
      State.set('mcp', { serverInfo: { ...current.serverInfo, cwd: next } });
      return true;
    }

    async markProxyUnavailable(error) {
      const message = error?.message || String(error || 'MCP connection unavailable');
      await this.disconnectProxy();
      getState().set('mcp', { status: 'error', error: message });
      this.stopHeartbeat();
      return { success: false, error: message };
    }

    async verifyProxyConnection({ timeoutMs = 1500 } = {}) {
      if (this.healthCheckPromise) return this.healthCheckPromise;
      const State = getState();
      const current = State.get('mcp');
      if (current.status !== 'connected') return { success: false, skipped: true };
      const run = (async () => {
        State.set('mcp', { status: 'checking', error: null });
        const probe = await probeConnection(current.endpoint, { timeoutMs, token: this.sessionToken });
        if (!probe.success) {
          await this.markProxyUnavailable(new Error(probe.error));
          return { success: false, probe };
        }
        if (probe.serverInfo.cwd) getSecurity().manager.setStartupDirectory(probe.serverInfo.cwd);
        State.set('mcp', { status: 'connected', serverInfo: probe.serverInfo, latencyMs: probe.latencyMs, error: null });
        return { success: true, probe };
      })();
      this.healthCheckPromise = run;
      try {
        return await run;
      } finally {
        this.healthCheckPromise = null;
      }
    }

    /**
     * Conecta con zerochat.py en el host y puerto indicados y registra sus herramientas. Con
     * silentOnFailure (la comprobación del arranque) un servidor apagado deja el estado en
     * 'disconnected' en lugar de 'error'.
     */
    async connectProxy({ host, port, timeoutMs = 1500, silentOnFailure = false, token = null, notifyStartup = true }) {
      if (token) this.setSessionToken(token);
      const endpoint = proxyEndpoint(host, port);
      const State = getState();
      if (!silentOnFailure) State.set('mcp', { status: 'connecting', host, port, endpoint, error: null });

      const probe = await probeConnection(endpoint, { timeoutMs, token: this.sessionToken });
      if (!probe.success) {
        if (this.clients.has(PROXY_ID)) await this.disconnectProxy();
        State.set('mcp', {
          status: silentOnFailure ? 'disconnected' : 'error',
          host, port, endpoint,
          error: silentOnFailure ? null : probe.error,
          latencyMs: silentOnFailure ? null : probe.latencyMs,
          serverInfo: null, tools: [], commandJobs: []
        });
        return { success: false, available: false, probe, error: probe.error };
      }

      this.dropClient(PROXY_ID);
      if (probe.serverInfo.cwd) getSecurity().manager.setStartupDirectory(probe.serverInfo.cwd);
      const client = new McpClient({ id: PROXY_ID, name: probe.serverInfo.name || 'zerochat', url: endpoint, token: this.sessionToken });
      let tools = [];
      let error = null;
      try {
        tools = await this.registerClient(client, { onTransportFailure: failure => this.markProxyUnavailable(failure) });
      } catch (err) {
        error = err.message;
      }

      State.set('mcp', {
        status: error ? 'error' : 'connected',
        host, port, endpoint,
        serverInfo: probe.serverInfo,
        tools,
        latencyMs: probe.latencyMs,
        error
      });
      if (error) return { success: false, available: true, probe, error, tools };

      const externalSync = await this.syncExternalServers().catch(() => null);
      if (notifyStartup) this.notifyStoppedExternalServices(externalSync?.status?.servers);
      if (this.sessionToken) this.startHeartbeat(host, port);
      return { success: true, available: true, probe, tools, externalSync };
    }

    notifyStoppedExternalServices(servers) {
      if (this.externalStartupNoticeShown || !Array.isArray(servers)) return false;
      if (!servers.some(server => server?.enabled === true && server?.status === 'stopped')) return false;
      this.externalStartupNoticeShown = true;
      resolveDep('ChatUIMcp', './ui-mcp.js').offerStoppedExternalServices(servers)
        .catch(error => console.warn('[MCP] Could not restore previous MCP services:', error));
      return true;
    }

    /**
     * Desconecta el servidor local y sus servicios externos y deja el estado en desconectado.
     */
    async disconnectProxy() {
      this.dropClient(PROXY_ID);
      this.dropClient(EXTERNAL_ID);
      getState().set('mcp', { status: 'disconnected', serverInfo: null, tools: [], latencyMs: null, error: null, externalServers: [], externalTools: [], commandJobs: [] });
      return { success: true };
    }

    /**
     * Latido periódico al servidor local: publica su directorio de trabajo y sus comandos en
     * segundo plano y, si no responde, comprueba la conexión.
     */
    startHeartbeat(host, port) {
      const target = { host, port, token: this.sessionToken };
      const changed = !this.heartbeatTarget || ['host', 'port', 'token'].some(key => this.heartbeatTarget[key] !== target[key]);
      this.heartbeatTarget = target;
      if (changed) this.sendHeartbeat();
      if (!this.heartbeatTimer) this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), HEARTBEAT_INTERVAL_MS);
    }

    stopHeartbeat() {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      this.heartbeatCheckInFlight = false;
    }

    async sendHeartbeat() {
      const { host, port, token } = this.heartbeatTarget;
      try {
        const response = await fetch(getHeartbeatUrl(host, port), {
          method: 'GET',
          cache: 'no-store',
          mode: 'cors',
          headers: { 'X-ZeroChat-Token': token }
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok || payload?.ok !== true) throw new Error(`Heartbeat HTTP ${response.status}`);
        // Otra pestaña o el modelo pueden haber cambiado el directorio del proyecto.
        this.syncProjectDirectory(payload.cwd);
        this.syncCommandJobs(payload.jobs, { exitOnClose: payload.exit_on_close === true });
      } catch (_) {
        if (this.heartbeatCheckInFlight) return;
        this.heartbeatCheckInFlight = true;
        try {
          await this.verifyProxyConnection({ timeoutMs: 1500 });
        } finally {
          this.heartbeatCheckInFlight = false;
        }
      }
    }

    /** Petición de control al servidor local (comandos, servicios externos, proyecto). */
    async requestExternalControl(method, params = {}, options = {}) {
      const client = this.clients.get(PROXY_ID);
      if (!client) throw new Error('The local tool server is not connected.');
      return client.request(method, params, options);
    }

    /**
     * Publica en ChatState los comandos en segundo plano que siguen en marcha en el servidor
     * local. Los esperados ya se ven en su tarjeta mientras el turno los espera. Solo escribe
     * si cambia el conjunto, no en cada latido.
     */
    syncCommandJobs(jobs, { exitOnClose } = {}) {
      const State = getState();
      const current = State.get('mcp');
      if (current.status !== 'connected') return false;
      const next = (Array.isArray(jobs) ? jobs : [])
        .filter(job => job && Number.isInteger(job.id) && job.status === 'running' && job.background === true)
        .map(job => ({
          id: job.id,
          command: typeof job.command === 'string' ? job.command : '',
          startedAt: Number.isFinite(job.started_at) ? job.started_at : Date.now()
        }));
      const signature = list => JSON.stringify(list.map(job => [job.id, job.command, job.startedAt]));
      const exit = typeof exitOnClose === 'boolean' ? exitOnClose : current.exitOnClose === true;
      if (signature(next) === signature(current.commandJobs) && exit === (current.exitOnClose === true)) return false;
      State.set('mcp', { commandJobs: next, exitOnClose: exit });
      return true;
    }

    /** Vuelve a leer del servidor los comandos en marcha, tras lanzar o detener alguno. */
    async refreshCommandJobs() {
      try {
        const result = await this.requestExternalControl('zerochat/jobs/list', {});
        return this.syncCommandJobs(result?.jobs);
      } catch (_) {
        return false;
      }
    }

    /**
     * Nota en inglés para el modelo con los comandos en segundo plano de esta conversación que
     * han terminado sin que los haya visto terminar. Vacía si no hay ninguno.
     */
    async buildCommandNotes(messages) {
      const CommandCard = getCommandCard();
      const lastStatus = new Map();
      for (const message of messages) {
        if (message.role !== 'tool' || ![LOCAL_COMMAND_TOOL, LOCAL_COMMAND_CHECK_TOOL].includes(message.name)) continue;
        const data = CommandCard.parseResult(message.content);
        if (data && Number.isInteger(data.job_id)) lastStatus.set(data.job_id, data.status);
      }
      const ids = [...lastStatus].filter(([, status]) => status === 'running').map(([id]) => id).slice(-100);
      if (!ids.length) return '';
      let reports = [];
      try {
        reports = (await this.requestExternalControl('zerochat/jobs/report', { ids }, { timeoutMs: 3000 }))?.reports || [];
      } catch (_) {
        return '';
      }
      if (!reports.length) return '';
      const lines = ['Background commands that finished since your last turn:'];
      for (const report of reports) {
        const duration = CommandCard.formatDuration(report.elapsed_s);
        const outcome = report.status === 'stopped'
          ? `was stopped by ${report.stop_reason === 'user' ? 'the user' : 'ZeroChat'} after ${duration}`
          : `exited with code ${report.exit_code} after ${duration}`;
        lines.push(`- job_id ${report.id} \`${String(report.command || '').split('\n')[0]}\` ${outcome}.`);
        if (report.tail) lines.push('  Last lines:', ...String(report.tail).split('\n').map(line => `    ${line}`));
      }
      lines.push('For more output, read the log file with read_file or search_files: ' + reports.map(report => `job_id ${report.id}: ${report.log_file}`).join('; ') + '.');
      return lines.join('\n');
    }

    /** Cambia el directorio del proyecto en el servidor local a petición del usuario. */
    async setProjectDirectory(path) {
      const result = await this.requestExternalControl('zerochat/project/set_directory', { path });
      this.syncProjectDirectory(result?.cwd);
      return result;
    }

    async refreshExternalProvider() {
      const control = this.clients.get(PROXY_ID);
      if (!control) throw new Error('The local tool server is not connected.');
      this.dropClient(EXTERNAL_ID);
      const client = new McpClient({
        id: EXTERNAL_ID,
        name: 'ZeroChat External MCP Host',
        url: `${control.url.replace(/\/sse\/?$/, '')}/mcp/external`,
        token: this.sessionToken
      });
      try {
        const tools = await this.registerClient(client);
        getState().set('mcp', { externalTools: tools });
        return { success: true, toolCount: tools.length, tools };
      } catch (error) {
        return { success: false, error: error.message || String(error), tools: [] };
      }
    }

    async fetchExternalServers(options = {}) {
      try {
        return await this.requestExternalControl('zerochat/external/status', {}, options);
      } catch (error) {
        if (options.throwOnError) throw error;
        return { servers: [] };
      }
    }

    async syncExternalServers() {
      const status = await this.fetchExternalServers();
      let externalTools = [];
      if (status.servers.some(server => server.status === 'running')) {
        const refresh = await this.refreshExternalProvider();
        if (refresh.success) externalTools = refresh.tools;
      } else {
        this.dropClient(EXTERNAL_ID);
      }
      getState().set('mcp', { externalServers: status.servers, externalTools });
      return { status, externalTools };
    }

    async startExternalServer(serverId, onWait = null) {
      let result = null;
      try {
        result = await this.requestExternalControl('zerochat/external/servers/start', { serverId });
      } catch (error) {
        // El timeout inicial no implica fallo: el backend puede estar aún
        // iniciando el servicio (p. ej. esperando la autorización OAuth).
        if (error.name !== 'AbortError' && error.code !== 'MCP_REQUEST_TIMEOUT') throw error;
      }
      if (result) {
        await this.syncExternalServers().catch(() => {});
        return result;
      }
      // Cada fase (installing, starting) dispone de su propio presupuesto de esperas.
      let phase = null;
      let attempt = 0;
      for (;;) {
        let status;
        try {
          status = await this.fetchExternalServers({ throwOnError: true });
        } catch (cause) {
          const error = new Error('Unable to check MCP startup status.', { cause });
          error.code = 'EXTERNAL_START_STATUS_UNAVAILABLE';
          throw error;
        }
        const server = (status?.servers || []).find(item => item?.id === serverId);
        if (server?.status === 'running') {
          await this.syncExternalServers();
          return status;
        }
        if (server?.status !== 'starting' && server?.status !== 'installing') {
          const error = new Error(`MCP server '${serverId}' did not start: ${server?.status || 'unknown'}`);
          error.code = 'EXTERNAL_START_STATUS_UNAVAILABLE';
          error.externalServer = server;
          throw error;
        }
        if (server.status !== phase) {
          phase = server.status;
          attempt = 0;
        }
        const maxAttempts = server.oauthUrl || server.status === 'installing'
          ? EXTERNAL_LONG_START_POLL_ATTEMPTS
          : EXTERNAL_START_POLL_ATTEMPTS;
        if (attempt >= maxAttempts) {
          const error = new Error(`MCP server '${serverId}' is still starting after ${maxAttempts} waits.`);
          error.code = 'EXTERNAL_START_WAIT_TIMEOUT';
          error.externalServer = server;
          throw error;
        }
        attempt += 1;
        onWait?.(attempt, maxAttempts, server.status, server);
        await new Promise(resolve => setTimeout(resolve, EXTERNAL_START_POLL_INTERVAL_MS));
      }
    }

    async stopExternalServer(serverId) {
      const result = await this.requestExternalControl('zerochat/external/servers/stop', { serverId });
      await this.syncExternalServers().catch(() => {});
      return result;
    }

    async configureExternalServer(serverId, options) {
      return this.requestExternalControl('zerochat/external/servers/configure', { serverId, options });
    }
  }

  const manager = new McpManager();

  return {
    McpClient,
    McpToolProvider,
    McpManager,
    probeConnection,
    publicToolName,
    manager
  };
});
