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

  const { fetchWithTimeout, resolveDep, SAFE_IMAGE_MIME_TYPES } = Utils;

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
  const BROWSER_ACTION_TOOL = 'browser_action';

  /** Playwright del servicio instalado según el último latido; null mientras no se sabe. */
  const playwrightInstalled = () => getState().get('mcp').playwright?.installed ?? null;
  /** browser_action se puede usar ahora: Playwright instalado y un Chromium con el que navegar. */
  const browserActionAvailable = () => getState().get('mcp').playwright?.browserAction?.available === true;
  const LOCAL_COMMAND_CHECK_TOOL = 'check_command';
  const EXTERNAL_START_POLL_ATTEMPTS = 10;
  const EXTERNAL_START_POLL_INTERVAL_MS = 15000;
  // Cubre los límites del backend (npm install y descarga del navegador, 600 s cada uno)
  // y la espera de la autorización OAuth.
  const EXTERNAL_LONG_START_POLL_ATTEMPTS = 80;
  const HEARTBEAT_INTERVAL_MS = 10000;
  // Lo que el servidor local informa en vivo, vacío mientras no hay conexión.
  const LIVE_RESET = Object.freeze({ serverInfo: null, tools: [], externalServers: [], externalTools: [], commandJobs: [], exitOnClose: false, playwright: null });
  const MAX_OUTPUT_LENGTH = 60000;
  const MAX_IMAGE_BASE64_LENGTH = 8 * 1024 * 1024;
  const TOOL_AUTH_VERSION = 'zerochat-tool-auth-v1';
  const UNREACHABLE_SERVER_ERROR = 'Cannot reach the local server at that address and port. Make sure zerochat is running in your terminal.';

  const getAgentCore = () => resolveDep('ChatAgentCore', './agent-core.js');
  const getState = () => resolveDep('ChatState', './state.js');
  const getCommandCard = () => resolveDep('ChatCommandCard', './command-card.js');
  const getToolCards = () => resolveDep('ChatToolCards', './tool-cards.js');
  const getSecurity = () => resolveDep('ChatToolSecurity', './tool-security.js');
  const getConfig = () => resolveDep('ChatConfig', './config-store.js');

  const proxyEndpoint = (host, port) => `http://${host}:${port}/sse`;

  // Escrituras del servidor local cuyo resultado lleva la ruta absoluta del fichero (botón Diff).
  const FILE_WRITE_TOOLS = new Set(['write_file', 'edit_file']);
  const WEB_FETCH_CONTROL_MARGIN_MS = 5000;
  // Plazo de la instalación de webdiff en el backend (120 s) más margen para recibir su error.
  const DIFF_TOOL_SETUP_TIMEOUT_MS = 130000;

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
      // El servidor acepta caducidades entre su hora y su hora + ttlMs: el centro tolera
      // un desfase de reloj de ±ttlMs/2 (navegador en otro equipo, p. ej. por un túnel SSH).
      const expiresAt = Date.now() + Math.floor(credentials.ttlMs / 2);
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
          typeof auth.key === 'string' && Number.isInteger(auth.ttlMs) && auth.ttlMs > 0 && auth.ttlMs <= 60_000) {
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

  /** Resumen serializable de una herramienta para ChatState y los ajustes. */
  function summarizeTool(tool) {
    return {
      name: tool.name,
      description: tool.metadata.description,
      inputSchema: tool.parameters,
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
        const isBrowserAction = isProxy && toolName === BROWSER_ACTION_TOOL;
        const namespacedName = publicToolName(isProxy ? null : sourceServer, toolName);
        if (external && rt.name !== namespacedName) throw new Error('Invalid external MCP public name');
        if (toolInstances.some(tool => tool.name === namespacedName)) throw new Error('Duplicate MCP public name');

        toolInstances.push(new Tool({
          // El nombre público ya identifica el servidor; repetirlo en la descripción gasta contexto.
          definition: { name: namespacedName, description: rt.description || toolName, parameters: rt.inputSchema },
          category: 'mcp',
          isAvailable: () => (!isProxy || getState().get('mcp').status === 'connected') && (!isBrowserAction || browserActionAvailable()),
          settings: { showInSettings: true },
          metadata: {
            iconSvg: Icons.get('plug', { size: 14 }),
            mcpServerName: serverName,
            mcpServerUrl: this.serverUrl,
            originalName: toolName,
            mcpServerId: sourceServer,
            description: rt.description || ''
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
          view: isLocalCommand
            ? getCommandCard().createView()
            : getToolCards().createMcpToolView(toolName, serverName, isProxy && FILE_WRITE_TOOLS.has(toolName))
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

  /** Cambia en ChatState los campos de un servicio externo; su tarjeta en Ajustes › MCP los pinta. */
  function updateExternalServerState(serverId, changes) {
    getState().set('mcp', current => ({
      ...current,
      externalServers: current.externalServers.map(server => (server.id === serverId ? { ...server, ...changes } : server))
    }));
  }

  /** El Playwright MCP en marcha usa otro navegador del que exige el perfil, o no muestra la ventana que pide. */
  function usesOtherBrowser(server, required) {
    return server.id === 'playwright' && Boolean(required) && server.status === 'running'
      && (server.browser?.mode !== required.mode || server.browser.engine !== required.engine || server.browser.userBrowser !== required.userBrowser
        || (required.headless === false && server.browser.headless !== false));
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
      this.heartbeatTarget = null;
      this.heartbeatTimer = null;
      this.heartbeatCheckInFlight = false;
      // Últimos servicios externos que informó el servidor, para no pisar en cada latido lo que la
      // interfaz muestra de una acción en curso, y cuáles estaban en marcha.
      this.liveServers = null;
      this.liveRunning = null;
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
     * Publica en ChatState el estado vivo que informa el servidor local, en el latido o en la respuesta
     * de un control: el directorio del proyecto (que siguen el modo proyecto y la regla de lectura por
     * defecto), los comandos en segundo plano en marcha (los esperados ya se ven en su tarjeta), si el
     * servidor se detiene al cerrar el navegador, Playwright (instalado y browser_action disponible)
     * y los servicios externos, cuyas herramientas se vuelven a registrar si cambian los que están en
     * marcha. Solo lee los campos presentes y solo escribe los que cambian, no en cada latido.
     */
    async applyLiveState(payload) {
      const State = getState();
      const current = State.get('mcp');
      if (current.status !== 'connected' || !payload) return false;
      const next = {};
      const cwd = typeof payload.cwd === 'string' ? payload.cwd.trim() : '';
      if (cwd && current.serverInfo && current.serverInfo.cwd !== cwd) {
        getSecurity().manager.setStartupDirectory(cwd);
        next.serverInfo = { ...current.serverInfo, cwd };
      }
      if (Array.isArray(payload.jobs)) {
        const jobs = payload.jobs
          .filter(job => job && Number.isInteger(job.id) && job.status === 'running' && job.background === true)
          .map(job => ({
            id: job.id,
            command: typeof job.command === 'string' ? job.command : '',
            startedAt: Number.isFinite(job.started_at) ? job.started_at : Date.now()
          }));
        if (JSON.stringify(jobs) !== JSON.stringify(current.commandJobs)) next.commandJobs = jobs;
      }
      if (typeof payload.exit_on_close === 'boolean' && payload.exit_on_close !== current.exitOnClose) next.exitOnClose = payload.exit_on_close;
      if (typeof payload.playwright?.installed === 'boolean') {
        const playwright = { installed: payload.playwright.installed, browserAction: { available: payload.playwright.browserAction?.available === true } };
        if (JSON.stringify(playwright) !== JSON.stringify(current.playwright)) next.playwright = playwright;
      }
      let running = this.liveRunning;
      if (Array.isArray(payload.servers) && JSON.stringify(payload.servers) !== this.liveServers) {
        this.liveServers = JSON.stringify(payload.servers);
        next.externalServers = payload.servers;
        running = payload.servers.filter(server => server?.status === 'running').map(server => `${server.id}:${server.toolCount}`).join();
      }
      if (Object.keys(next).length === 0) return false;
      State.set('mcp', next);
      if (running !== this.liveRunning) {
        this.liveRunning = running;
        await this.refreshExternalTools(running !== '');
      }
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
    async connectProxy({ host, port, timeoutMs = 1500, silentOnFailure = false, token = null }) {
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
          ...LIVE_RESET
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

      // El primer latido trae los servicios externos y el resto del estado vivo.
      this.liveServers = null;
      this.liveRunning = null;
      if (this.sessionToken) await this.startHeartbeat(host, port);
      return { success: true, available: true, probe, tools };
    }

    /**
     * Desconecta el servidor local y sus servicios externos y deja el estado en desconectado.
     */
    async disconnectProxy() {
      this.dropClient(PROXY_ID);
      this.dropClient(EXTERNAL_ID);
      getState().set('mcp', { status: 'disconnected', latencyMs: null, error: null, ...LIVE_RESET });
      return { success: true };
    }

    /**
     * Latido periódico al servidor local: publica su estado vivo (applyLiveState) y, si no responde,
     * comprueba la conexión.
     */
    startHeartbeat(host, port) {
      const target = { host, port, token: this.sessionToken };
      this.heartbeatTarget = target;
      if (!this.heartbeatTimer) this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), HEARTBEAT_INTERVAL_MS);
      // El primero va al conectar.
      return this.sendHeartbeat();
    }

    stopHeartbeat() {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      this.heartbeatCheckInFlight = false;
    }

    /** Lee el latido y publica su estado vivo; devuelve lo leído o falla si el servidor no responde. */
    async readLiveState() {
      const { host, port, token } = this.heartbeatTarget;
      const response = await fetch(getHeartbeatUrl(host, port), {
        method: 'GET',
        cache: 'no-store',
        mode: 'cors',
        headers: { 'X-ZeroChat-Token': token }
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.ok !== true) throw new Error(`Heartbeat HTTP ${response.status}`);
      // Otra pestaña, el modelo o una instalación pueden haber cambiado el estado del servidor.
      await this.applyLiveState(payload);
      return payload;
    }

    async sendHeartbeat() {
      try {
        await this.readLiveState();
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

    /** Comprueba si el proxy del backend local está conectado y activo. */
    isProxyConnected() {
      const State = getState();
      return this.clients.has(PROXY_ID) && State.get('mcp')?.status === 'connected';
    }

    /**
     * Descarga un recurso web a través del backend local autorizado. La petición de control espera
     * un margen sobre el plazo HTTP para recibir el error de plazo del propio backend.
     */
    async fetchWebResource(url, { accept, timeoutMs, maxBytes, binary }) {
      return this.requestExternalControl('zerochat/web/fetch', {
        url,
        accept,
        timeout_s: timeoutMs / 1000,
        max_bytes: maxBytes,
        binary
      }, { timeoutMs: timeoutMs + WEB_FETCH_CONTROL_MARGIN_MS });
    }

    /** Vuelve a leer del servidor los comandos en marcha, tras lanzar o detener alguno. */
    async refreshCommandJobs() {
      try {
        const result = await this.requestExternalControl('zerochat/jobs/list', {});
        return await this.applyLiveState({ jobs: result?.jobs });
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
      await this.applyLiveState({ cwd: result?.cwd });
      return result;
    }

    /**
     * Solicita al backend abrir el visor externo de diffs para un fichero; con `commitFallback`,
     * si no hay cambios pendientes, el del último commit que lo modificó.
     */
    async openFileDiff(path, commitFallback = false) {
      return this.requestExternalControl('zerochat/diff/open', { path, commit_fallback: commitFallback });
    }

    /** Deja `tool` como visor gráfico global de Git; con webdiff puede instalarlo antes, de ahí el plazo amplio. */
    async configureDiffTool(tool) {
      return this.requestExternalControl('zerochat/diff/configure', { tool }, { timeoutMs: DIFF_TOOL_SETUP_TIMEOUT_MS });
    }

    /** Vuelve a registrar las herramientas de los servicios externos, o las retira si no hay ninguno en marcha. */
    async refreshExternalTools(anyRunning) {
      this.dropClient(EXTERNAL_ID);
      let tools = [];
      const control = this.clients.get(PROXY_ID);
      if (anyRunning && control) {
        const client = new McpClient({
          id: EXTERNAL_ID,
          name: 'ZeroChat External MCP Host',
          url: `${control.url.replace(/\/sse\/?$/, '')}/mcp/external`,
          token: this.sessionToken
        });
        try {
          tools = await this.registerClient(client);
        } catch (error) {
          console.warn('[MCP] Could not list the external MCP tools:', error);
        }
      }
      getState().set('mcp', { externalTools: tools });
    }

    /**
     * Arranca un servicio externo; con `remember` el servidor local lo guarda como activo y lo
     * ofrece de nuevo en la siguiente sesión.
     */
    async startExternalServer(serverId, onWait, { remember, browser = null }) {
      let result = null;
      try {
        result = await this.requestExternalControl('zerochat/external/servers/start', { serverId, remember, ...(browser ? { browser } : {}) });
      } catch (error) {
        // El timeout inicial no implica fallo: el backend puede estar aún
        // iniciando el servicio (p. ej. esperando la autorización OAuth).
        if (error.name !== 'AbortError' && error.code !== 'MCP_REQUEST_TIMEOUT') throw error;
      }
      if (result) {
        await this.applyLiveState(result);
        return result;
      }
      // Cada fase (installing, starting) dispone de su propio presupuesto de esperas.
      let phase = null;
      let attempt = 0;
      for (;;) {
        let status;
        try {
          status = await this.readLiveState();
        } catch (cause) {
          const error = new Error('Unable to check MCP startup status.', { cause });
          error.code = 'EXTERNAL_START_STATUS_UNAVAILABLE';
          throw error;
        }
        const server = (status?.servers || []).find(item => item?.id === serverId);
        if (server?.status === 'running') return status;
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
      await this.applyLiveState(result);
      return result;
    }

    async configureExternalServer(serverId, options) {
      const result = await this.requestExternalControl('zerochat/external/servers/configure', { serverId, options });
      await this.applyLiveState(result);
      return result;
    }

    /**
     * Inicia o detiene un servicio externo y refleja el progreso en ChatState. Playwright MCP arranca
     * con el navegador que exija el perfil activo, y la autorización OAuth que pida el arranque se abre
     * una vez en otra pestaña. Devuelve true si la acción terminó correctamente.
     */
    async runExternalServerAction(serverId, action, { remember = true } = {}) {
      updateExternalServerState(serverId, { status: action === 'start' ? 'starting' : 'stopped', error: null, startWait: null, oauthUrl: null });
      let didAutoOpenOAuth = false;
      const reportStartWait = (attempt, total, status = 'starting', serverData = null) => {
        const oauthUrl = serverData?.oauthUrl || null;
        if (oauthUrl && !didAutoOpenOAuth) {
          didAutoOpenOAuth = true;
          window.open(oauthUrl, '_blank');
        }
        updateExternalServerState(serverId, { status, ...(oauthUrl ? { oauthUrl } : {}), error: null, startWait: { attempt, total } });
      };
      try {
        const browser = serverId === 'playwright' ? getConfig().getActive().playwrightBrowser : null;
        if (action === 'start') await this.startExternalServer(serverId, reportStartWait, { remember, ...(browser ? { browser } : {}) });
        else await this.stopExternalServer(serverId);
        return true;
      } catch (error) {
        const stillPending = action === 'start' && (error.code === 'EXTERNAL_START_WAIT_TIMEOUT' ||
          (error.code === 'EXTERNAL_START_STATUS_UNAVAILABLE' && !error.externalServer));
        if (!error.code?.startsWith('EXTERNAL_START_')) console.error(`[MCP] Error trying to ${action} external server:`, error);
        updateExternalServerState(serverId, {
          status: error.externalServer?.status || (stillPending ? 'starting' : (action === 'start' ? 'stopped' : 'running')),
          startWait: null,
          error: I18n.t(stillPending ? 'mcp_external_start_wait_timeout' : 'mcp_external_action_error'),
          ...(error.externalServer?.oauthUrl ? { oauthUrl: error.externalServer.oauthUrl } : {})
        });
        return false;
      }
    }

    /**
     * Ejecuta `action` con el servicio detenido y lo vuelve a arrancar si estaba en marcha, sin cambiar
     * si queda recordado para la siguiente sesión (detenerlo lo desmarca). Devuelve false si no se pudo
     * detener o volver a arrancar.
     */
    async withExternalServerStopped(serverId, action = async () => {}) {
      const server = getState().get('mcp').externalServers.find(item => item.id === serverId);
      const wasRunning = server?.status === 'running';
      const remember = server?.enabled === true;
      if (wasRunning && !await this.runExternalServerAction(serverId, 'stop')) return false;
      let restarted = true;
      try {
        await action();
      } finally {
        if (wasRunning) restarted = await this.runExternalServerAction(serverId, 'start', { remember });
      }
      return restarted;
    }

    /**
     * Arranca los servicios externos de un perfil (los suyos y Playwright MCP si es la herramienta de
     * navegación activa) que no estén ya en marcha, sin parar los demás ni guardarlos como activos para
     * la siguiente sesión. Si el perfil exige otro navegador del que usa Playwright MCP, o su ventana
     * visible, lo reinicia. Devuelve { started, unavailable }: los ids de los que ha arrancado y de los
     * que no están configurados en el servidor local o no han arrancado. Sin conexión no arranca nada.
     */
    async startProfileServers(appConfig) {
      const State = getState();
      const started = [];
      const unavailable = [];
      if (State.get('mcp').status !== 'connected') return { started, unavailable };
      const ids = getAgentCore().activeBrowserTool(appConfig) === 'playwright' ? [...appConfig.mcpServers, 'playwright'] : appConfig.mcpServers;
      for (const id of ids) {
        const server = State.get('mcp').externalServers.find(item => item.id === id);
        if (!server) {
          unavailable.push(id);
          continue;
        }
        if (usesOtherBrowser(server, appConfig.playwrightBrowser)) {
          (await this.withExternalServerStopped(id) ? started : unavailable).push(id);
          continue;
        }
        if (['running', 'starting', 'installing'].includes(server.status)) continue;
        (await this.runExternalServerAction(id, 'start', { remember: false }) ? started : unavailable).push(id);
      }
      return { started, unavailable };
    }
  }

  const manager = new McpManager();

  return {
    McpClient,
    McpToolProvider,
    McpManager,
    probeConnection,
    publicToolName,
    playwrightInstalled,
    browserActionAvailable,
    manager,
    getResultText,
    getSafeMcpImageDataUrl,
    getSafeMcpImageFromMessage
  };
});
