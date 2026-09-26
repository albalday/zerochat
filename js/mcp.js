/**
 * Módulo de Integración MCP (Model Context Protocol) para ZeroChat.
 * Permite la conexión a servidores MCP locales o remotos vía SSE (Server-Sent Events) o HTTP Stream.
 *
 * Características:
 *  - Soporte de transporte HTTP / SSE nativo en navegadores (EventSource / fetch stream).
 *  - Dado que los navegadores no pueden lanzar subprocesos `stdio` directamente,
 *    las conexiones MCP stdio requieren un proxy / bridge local (mcp-bridge o similar).
 *  - Por tanto, ZeroChat implementa el transporte nativo HTTP JSON-RPC 2.0 / SSE / REST para conectarse
 *      a servidores MCP remotos o locales (ej. http://localhost:8000/sse o endpoints de herramientas).
 *      Los servidores que solo admiten stdio pueden exponerse al navegador utilizando un bridge/proxy SSE.
 *
 * 2. Aislamiento de Credenciales y Seguridad:
 *    - Las cabeceras y tokens de autenticación de cada servidor MCP se gestionan exclusivamente en
 *      el cliente HTTP y NUNCA se inyectan en el prompt del sistema ni son accesibles para el ejecutor
 *      de código JavaScript.
 *    - Cada herramienta MCP indica explícitamente el servidor de procedencia para mantener la
 *      trazabilidad de ejecución en todo momento.
 *    - Se aplica control estricto de timeout (AbortController) y truncado de respuestas para evitar
 *      ataques de denegación de servicio o desbordamiento de contexto.
 * ==============================================================================================
 */

(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.ChatMCP = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Shared wire contract with bootstrap.py: escape z and non-lowercase
  // characters as z<hex code point>z; only tool components retain underscores.
  function publicToolName(serverId, originalName) {
    const encode = (value, tool = false) => {
      if (typeof value !== 'string' || !value || value.length > 256) {
        throw new Error('Invalid MCP name component');
      }
      return Array.from(value, ch => /^[a-y0-9]$/.test(ch) || (tool && ch === '_')
        ? ch : `z${ch.codePointAt(0).toString(16)}z`).join('');
    };
    const name = serverId === null ? encode(originalName, true)
      : `mcp_${encode(serverId)}_${encode(originalName, true)}`;
    if (name.length > 64) throw new Error('MCP public name exceeds 64 characters');
    return name;
  }

  const DEFAULT_TIMEOUT_MS = 15000;
  const MAX_OUTPUT_LENGTH = 60000;

  function getAgentCore() {
    if (typeof window !== 'undefined' && window.ChatAgentCore) return window.ChatAgentCore;
    if (typeof require !== 'undefined') {
      try { return require('./agent-core.js'); } catch (e) {}
    }
    return null;
  }

  function getStorage() {
    if (typeof window !== 'undefined' && window.ChatStorage) return window.ChatStorage;
    if (typeof require !== 'undefined') {
      try { return require('./cookies.js'); } catch (e) {}
    }
    return null;
  }

  function getUtils() {
    if (typeof window !== 'undefined' && window.ChatUtils) return window.ChatUtils;
    if (typeof require !== 'undefined') {
      try { return require('./utils.js'); } catch (_) {}
    }
    return null;
  }

  function getState() {
    if (typeof window !== 'undefined' && window.ChatState) return window.ChatState;
    if (typeof require !== 'undefined') {
      try { return require('./state.js'); } catch (e) {}
    }
    return null;
  }

  /**
   * Realiza una petición fetch con timeout controlado mediante AbortController.
   */
  async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

    try {
      const response = await fetch(url, {
        ...options,
        signal: options.signal || (controller ? controller.signal : undefined)
      });
      if (timer) clearTimeout(timer);
      return response;
    } catch (err) {
      if (timer) clearTimeout(timer);
      throw err;
    }
  }

  /**
   * Sondea de forma no destructiva un endpoint MCP / mcp-proxy para verificar conectividad y latencia.
   */
  async function probeConnection(url, options = {}) {
    const timeoutMs = options.timeoutMs || 4000;
    const startTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const normalizedUrl = (url || '').trim();

    if (!normalizedUrl) {
      return { success: false, error: 'URL no válida o vacía', latencyMs: 0 };
    }

    let client = null;
    try {
      client = new McpClient({ url: normalizedUrl, timeoutMs, token: options.token });
      const initResult = await client.initialize({ timeoutMs });
      const endTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const latencyMs = Math.max(1, Math.round(endTime - startTime));

      if (initResult && initResult.success) {
        return {
          success: true,
          latencyMs,
          serverInfo: initResult.serverInfo || { name: 'mcp-proxy', version: 'unknown' },
          capabilities: initResult.capabilities || {}
        };
      }

      let errMsg = initResult?.error || 'No se pudo establecer sesión con el servidor MCP';
      if (errMsg.includes('Failed to fetch') || errMsg.includes('NetworkError') || errMsg.includes('ECONNREFUSED')) {
        errMsg = 'No se puede conectar al proxy en esa dirección y puerto. Asegúrate de haber arrancado mcp-proxy en tu terminal.';
      }

      return {
        success: false,
        error: errMsg,
        latencyMs
      };
    } catch (err) {
      const endTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const latencyMs = Math.max(1, Math.round(endTime - startTime));
      let errMsg = err.message || 'Error de conexión';
      if (errMsg.includes('Failed to fetch') || errMsg.includes('NetworkError') || errMsg.includes('ECONNREFUSED')) {
        errMsg = 'No se puede conectar al proxy en esa dirección y puerto. Asegúrate de haber arrancado mcp-proxy en tu terminal.';
      }
      return {
        success: false,
        error: errMsg,
        latencyMs
      };
    } finally {
      if (client) {
        try {
          client.disconnect();
        } catch (e) {}
      }
    }
  }

  function isTransportFailure(error) {
    if (!error || error?.name === 'AbortError') return false;
    const message = String(error?.message || error).toLowerCase();
    return /network|fetch|econnrefused|timeout|conexión mcp cerrada|http 5\d\d|http 404/.test(message);
  }

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
    }

    /**
     * Cierra de forma limpia la conexión SSE activa y resetea las URLs efímeras de sesión.
     */
    disconnect() {
      if (this.sseSource) {
        try {
          this.sseSource.close();
        } catch (e) {}
        this.sseSource = null;
      }
      if (this.sseReader) {
        try {
          this.sseReader.cancel();
        } catch (e) {}
        this.sseReader = null;
      }
      this.isSseActive = false;
      this.postUrl = null;

      if (this.pendingRequests && this.pendingRequests.size > 0) {
        for (const [id, req] of this.pendingRequests.entries()) {
          if (req.timer) clearTimeout(req.timer);
          if (typeof req.reject === 'function') {
            req.reject(new Error('Conexión MCP cerrada'));
          }
        }
        this.pendingRequests.clear();
      }
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
      if (this.headers && typeof this.headers === 'object') {
        Object.assign(headers, this.headers);
      }
      return headers;
    }

    /**
     * Inicia o reutiliza la conexión SSE persistente para recibir el endpoint y respuestas asíncronas.
     */
    async connectSseStream(options = {}) {
      if (!options.forceReconnect && this.postUrl && this.isSseActive) {
        return this.postUrl;
      }
      if (options.forceReconnect || !this.isSseActive) {
        this.disconnect();
      }

      const timeoutMs = options.timeoutMs || 4000;
      if (!this.pendingRequests) this.pendingRequests = new Map();

      return new Promise((resolve) => {
        let settled = false;
        const finish = (url) => {
          if (!settled) {
            settled = true;
            this.postUrl = url;
            resolve(url);
          }
        };

        const timer = setTimeout(() => finish(this.url), timeoutMs);

        try {
          let sseUrl = this.url;
          if (this.token) {
            const joiner = sseUrl.includes('?') ? '&' : '?';
            sseUrl = `${sseUrl}${joiner}token=${encodeURIComponent(this.token)}`;
          }

          if (typeof EventSource !== 'undefined') {
            const es = new EventSource(sseUrl);
            this.sseSource = es;
            this.isSseActive = true;

            es.addEventListener('endpoint', (evt) => {
              clearTimeout(timer);
              const postPath = (evt.data || '').trim();
              const fullUrl = new URL(postPath, this.url).toString();
              this.postUrl = fullUrl;
              finish(fullUrl);
            });

            es.addEventListener('message', (evt) => {
              this._handleJsonRpcMessage(evt.data);
            });

            es.onerror = () => {
              clearTimeout(timer);
              this.isSseActive = false;
              this.postUrl = null;
              finish(this.url);
            };
          } else {
            // Node.js fallback mediante fetch stream
            fetch(this.url, {
              headers: { 'Accept': 'text/event-stream' }
            }).then(res => {
              if (!res.ok || !res.body) {
                clearTimeout(timer);
                this.isSseActive = false;
                this.postUrl = null;
                return finish(this.url);
              }
              const reader = res.body.getReader ? res.body.getReader() : null;
              if (!reader) {
                clearTimeout(timer);
                this.isSseActive = false;
                this.postUrl = null;
                return finish(this.url);
              }
              this.isSseActive = true;
              this.sseReader = reader;
              const decoder = new TextDecoder();
              let buffer = '';

              const pump = () => {
                reader.read().then(({ done, value }) => {
                  if (done) {
                    this.isSseActive = false;
                    return;
                  }
                  buffer += decoder.decode(value, { stream: true });
                  const chunks = buffer.split('\n\n');
                  buffer = chunks.pop() || '';

                  for (const chunk of chunks) {
                    const endpointMatch = chunk.match(/event:\s*endpoint\s*\n\s*data:\s*([^\r\n]+)/);
                    if (endpointMatch) {
                      clearTimeout(timer);
                      const postPath = endpointMatch[1].trim();
                      const fullUrl = new URL(postPath, this.url).toString();
                      this.postUrl = fullUrl;
                      finish(fullUrl);
                    }
                    const msgMatch = chunk.match(/(?:event:\s*message\s*\n\s*)?data:\s*([^\r\n]+)/);
                    if (msgMatch && !endpointMatch) {
                      this._handleJsonRpcMessage(msgMatch[1]);
                    }
                  }
                  pump();
                }).catch(() => {
                  this.isSseActive = false;
                });
              };
              pump();
            }).catch(() => {
              clearTimeout(timer);
              this.isSseActive = false;
              finish(this.url);
            });
          }
        } catch (e) {
          clearTimeout(timer);
          this.isSseActive = false;
          finish(this.url);
        }
      });
    }

    _handleJsonRpcMessage(raw) {
      try {
        const data = typeof raw === 'string' ? JSON.parse(raw.trim()) : raw;
        if (data && data.id !== undefined && this.pendingRequests.has(data.id)) {
          const pending = this.pendingRequests.get(data.id);
          this.pendingRequests.delete(data.id);
          if (pending.timer) clearTimeout(pending.timer);
          if (data.error) {
            const code = data.error.code ? ` (${data.error.code})` : '';
            pending.reject(new Error(`Error MCP${code}: ${data.error.message || JSON.stringify(data.error)}`));
          } else {
            pending.resolve(data.result);
          }
        }
      } catch (e) {}
    }

    /**
     * Resuelve la URL adecuada para enviar peticiones POST al servidor MCP.
     */
    async resolvePostUrl(options = {}) {
      if (!options.forceReconnect && this.postUrl && this.isSseActive) {
        return this.postUrl;
      }
      if (this.url.endsWith('/sse') || options.isSse) {
        return await this.connectSseStream(options);
      }
      return this.postUrl || this.url;
    }

    /**
     * Despacha una petición JSON-RPC 2.0 al endpoint del servidor MCP.
     */
    async request(method, params = {}, options = {}) {
      if (!this.url) {
        throw new Error(`El servidor MCP '${this.name}' no tiene una URL configurada.`);
      }

      if (!this.pendingRequests) this.pendingRequests = new Map();

      // Si es un endpoint SSE (/sse), conectamos o reutilizamos el canal SSE
      const isSseEndpoint = this.url.endsWith('/sse') || options.isSse;
      let targetUrl = await this.resolvePostUrl(options);

      const id = this.requestId++;
      const payload = {
        jsonrpc: '2.0',
        id: id,
        method: method,
        params: params
      };

      const timeoutMs = options.timeoutMs || this.timeoutMs;
      let res;
      try {
        res = await fetchWithTimeout(targetUrl, {
          method: 'POST',
          headers: this.buildHeaders(),
          body: JSON.stringify(payload),
          signal: options.signal
        }, timeoutMs);
      } catch (fetchErr) {
        // En caso de fallo de red en endpoint SSE, reconectar y reintentar una única vez
        if (!options._isRetry && (isSseEndpoint || this.postUrl)) {
          this.disconnect();
          return this.request(method, params, { ...options, _isRetry: true, forceReconnect: true });
        }
        throw fetchErr;
      }

      // Si targetUrl devolvió 404 (ej. "Could not find session for ID: <uuid>"),
      // la sesión SSE en mcp-proxy expiró o el servidor se reinició.
      // Invalidamos la sesión, forzamos reconexión limpia a /sse y reintentamos.
      if (res.status === 404 && !options._isRetry && (isSseEndpoint || (targetUrl && targetUrl.includes('session_id')) || this.postUrl)) {
        this.disconnect();
        return this.request(method, params, { ...options, _isRetry: true, forceReconnect: true });
      }

      // Si targetUrl devolvió 405 y no habíamos probado SSE, intentamos SSE
      if (res.status === 405 && !isSseEndpoint) {
        const resolved = await this.connectSseStream({ ...options, isSse: true });
        if (resolved && resolved !== targetUrl) {
          res = await fetchWithTimeout(resolved, {
            method: 'POST',
            headers: this.buildHeaders(),
            body: JSON.stringify(payload),
            signal: options.signal
          }, timeoutMs);
        }
      }

      // Si el servidor SSE devuelve 202 Accepted (o 200 sin cuerpo JSON directo), la respuesta llegará vía el stream SSE
      if (res.status === 202) {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            if (this.pendingRequests.has(id)) {
              this.pendingRequests.delete(id);
              reject(new Error(`Timeout esperando respuesta para petición #${id} (${method})`));
            }
          }, timeoutMs);
          this.pendingRequests.set(id, { resolve, reject, timer });
        });
      }

      if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        throw new Error(`Servidor MCP respondió con HTTP ${res.status}: ${errorText.slice(0, 200)}`);
      }

      const data = await res.json();
      if (data.error) {
        const code = data.error.code ? ` (${data.error.code})` : '';
        throw new Error(`Error MCP${code}: ${data.error.message || JSON.stringify(data.error)}`);
      }

      return data.result;
    }

    /**
     * Negocia el protocolo e inicializa la sesión MCP (initialize).
     */
    async initialize(options = {}) {
      try {
        const result = await this.request('initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {
            roots: { listChanged: false },
            sampling: {}
          },
          clientInfo: {
            name: 'ZeroChat',
            version: '5.1.0'
          }
        }, options);

        this.serverCapabilities = result?.capabilities || {};
        this.serverInfo = result?.serverInfo || { name: this.name, version: 'unknown' };

        // Enviar notificación de inicialización completada si el servidor lo soporta
        try {
          await this.notify('notifications/initialized', {});
        } catch (e) {}

        return {
          success: true,
          serverInfo: this.serverInfo,
          capabilities: this.serverCapabilities
        };
      } catch (err) {
        // Fallback tolerante: algunos servidores JSON-RPC no requieren initialize estricto
        return {
          success: false,
          error: err.message
        };
      }
    }

    /**
     * Envía una notificación JSON-RPC (sin esperar resultado).
     */
    async notify(method, params = {}) {
      const targetUrl = await this.resolvePostUrl().catch(() => this.url);
      if (!targetUrl) return;
      const payload = {
        jsonrpc: '2.0',
        method: method,
        params: params
      };
      try {
        const res = await fetch(targetUrl, {
          method: 'POST',
          headers: this.buildHeaders(),
          body: JSON.stringify(payload)
        });
        if (res.status === 404 && this.postUrl) {
          this.disconnect();
        }
      } catch (e) {}
    }

    /**
     * Descubre las herramientas disponibles en el servidor MCP (tools/list).
     */
    async listTools(options = {}) {
      const result = await this.request('tools/list', {}, options);
      const tools = result?.tools || [];
      return Array.isArray(tools) ? tools : [];
    }

    /**
     * Invoca una herramienta en el servidor MCP (tools/call).
     */
    async callTool(name, args = {}, options = {}) {
      const startTime = typeof performance !== 'undefined' ? performance.now() : Date.now();

      const result = await this.request('tools/call', {
        name: name,
        arguments: args
      }, options);

      const endTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const elapsed = parseFloat((endTime - startTime).toFixed(2));

      // Extraer y procesar contenido retornado por MCP
      let textOutput = '';
      let isError = result?.isError === true;
      const contentList = result?.content || [];

      if (Array.isArray(contentList)) {
        textOutput = contentList.map(item => {
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

      if (textOutput.length > MAX_OUTPUT_LENGTH) {
        textOutput = textOutput.slice(0, MAX_OUTPUT_LENGTH) + '\n\n[... MCP content truncated due to size limit ...]';
      }

      return {
        success: !isError,
        isError: isError,
        content: textOutput,
        rawResult: result,
        executionTimeMs: elapsed
      };
    }
  }

  function getMcpIconSvg(size = 14) {
    const Icons = (typeof window !== 'undefined' && window.ChatIcons) || (typeof require !== 'undefined' ? (() => { try { return require('./icons.js'); } catch (e) { return null; } })() : null);
    if (Icons && typeof Icons.get === 'function') {
      return Icons.get('plug', { size });
    }
    return `<svg class="ui-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22v-5"></path><path d="M9 8V2"></path><path d="M15 8V2"></path><path d="M18 8v5a6 6 0 0 1-12 0V8z"></path></svg>`;
  }

  function formatMcpMarkdown(toolName, args, result, outcome, serverName) {
    const raw = result?.content || (result?.rawResult ? (typeof result.rawResult === 'string' ? result.rawResult : JSON.stringify(result.rawResult, null, 2)) : outcome?.error || result?.error || 'Sin salida');
    const argStr = args && typeof args === 'object' && Object.keys(args).length ? JSON.stringify(args, null, 2) : '';
    const parts = [`> 🔌 **${toolName}** (*${serverName || 'MCP'}*)`];
    if (argStr) parts.push(`> \`\`\`json\n> ${argStr.split('\n').join('\n> ')}\n> \`\`\``);
    parts.push(`> \`\`\`\n> ${String(raw).split('\n').join('\n> ')}\n> \`\`\``);
    return parts.join('\n');
  }

  function createMcpToolView(toolName, serverName) {
    const iconSvg = getMcpIconSvg(14);

    const renderCard = (args, contentHtml, badgeHtml, ui, isCollapsed = false) => {
      const esc = ui?.markdown?.escapeHtml || getUtils()?.escapeHtml || (() => '');
      const t = ui?.t || (k => k);
      const card = ui?.createCardWrapper ? ui.createCardWrapper('mcp-card') : document.createElement('div');
      card.className = 'tool-card-wrapper mcp-card';
      const argStr = args && typeof args === 'object' && Object.keys(args).length ? esc(JSON.stringify(args, null, 2)) : '';
      const cardClass = isCollapsed ? 'tool-execution-card collapsed' : 'tool-execution-card';
      const btnTitle = isCollapsed ? (t('tool_btn_expand') || 'Expandir') : (t('tool_btn_collapse') || 'Minimizar');
      card.innerHTML = `
        <div class="${cardClass}">
          <div class="tool-card-header">
            <div class="tool-card-title">${iconSvg}<span>${esc(toolName)}</span><span class="mcp-card-server-tag">${esc(serverName || 'MCP')}</span></div>
            <div class="tool-card-header-actions">
              ${badgeHtml}
              <button type="button" class="btn-tool-collapse" title="${btnTitle}">${ui?.CHEVRON_SVG || '▼'}</button>
            </div>
          </div>
          <div class="tool-card-collapsible-body">
            ${argStr ? `<div class="mcp-input-summary"><code>${argStr}</code></div>` : ''}
            <div class="tool-card-result">${contentHtml}</div>
          </div>
        </div>`;
      return card;
    };

    return {
      displayMode: 'collapsed',
      createLiveCard: (args, ui) => {
        if (typeof document === 'undefined') return null;
        const t = ui?.t || (k => k);
        const spinner = ui?.SPINNER_SVG || '';
        const badge = `<span class="tool-card-badge status-loading">${spinner} <span>${t('tool_badge_executing') || 'Ejecutando...'}</span></span>`;
        const placeholder = `<div class="tool-loading-placeholder">${spinner} <span>${t('tool_badge_executing') || 'Ejecutando...'}</span></div>`;
        return renderCard(args, placeholder, badge, ui, false);
      },
      updateLiveCard: (cardDiv, args, result = {}, elapsedMs = 0, ui) => {
        if (!cardDiv) return;
        const esc = ui?.markdown?.escapeHtml || getUtils()?.escapeHtml || (() => '');
        const t = ui?.t || (k => k);
        const isSuccess = result?.success !== false && !result?.error && !result?.isError;
        const badge = cardDiv.querySelector('.tool-card-badge');
        if (badge) {
          badge.className = `tool-card-badge ${isSuccess ? 'status-success' : 'status-error'}`;
          badge.innerHTML = isSuccess ? `${ui?.CHECK_SVG || ''} <span>${t('tool_status_success') || 'OK'} (${elapsedMs}ms)</span>` : `${ui?.ERROR_SVG || ''} <span>Error (${elapsedMs}ms)</span>`;
        }
        const resEl = cardDiv.querySelector('.tool-card-result');
        if (resEl) {
          const out = result?.content || (result?.rawResult ? (typeof result.rawResult === 'string' ? result.rawResult : JSON.stringify(result.rawResult, null, 2)) : (result?.error || 'Sin salida'));
          resEl.innerHTML = `<pre class="tool-card-code"><code>${esc(out)}</code></pre>`;
        }
      },
      renderHistoricalCard: (args, message, ui) => {
        if (typeof document === 'undefined') return null;
        const esc = ui?.markdown?.escapeHtml || getUtils()?.escapeHtml || (() => '');
        const t = ui?.t || (k => k);
        const badge = `<span class="tool-card-badge status-success">${ui?.CHECK_SVG || ''} <span>${t('tool_status_success') || 'OK'}</span></span>`;
        const out = typeof message?.content === 'string' ? message.content : (message?.content ? JSON.stringify(message.content, null, 2) : '');
        return renderCard(args, `<pre class="tool-card-code"><code>${esc(out)}</code></pre>`, badge, ui, true);
      }
    };
  }

  /**
   * Proveedor de herramientas MCP integrado en la arquitectura AgentCore (McpToolProvider).
   */
  class McpToolProvider {
    constructor(client, options = {}) {
      const AgentCore = getAgentCore();
      this.client = client;
      this.id = options.id || client.id || `mcp_${Date.now()}`;
      this.name = options.name || client.name || 'MCP Tool Provider';
      this.serverName = client.name || 'MCP Server';
      this.serverUrl = client.url || '';
      this.onTransportFailure = typeof options.onTransportFailure === 'function' ? options.onTransportFailure : null;
      this.cachedTools = [];
    }

    /**
     * Descubre las herramientas remotas del servidor MCP y las transforma en instancias Tool.
     */
    async discoverTools(options = {}) {
      const AgentCore = getAgentCore();
      if (!AgentCore || !AgentCore.Tool) {
        throw new Error('Módulo ChatAgentCore no disponible.');
      }

      // Inicializar sesión
      await this.client.initialize(options);

      // Listar herramientas
      const rawTools = await this.client.listTools(options);
      const toolInstances = [];

      for (const rt of rawTools) {
        const external = this.client.id === 'mcp_external';
        const sourceServer = external ? rt.metadata?.mcpServerId : this.client.id;
        const toolName = external ? rt.metadata?.originalName : rt.name;
        const namespacedName = publicToolName(this.client.id === 'mcp_proxy' ? null : sourceServer, toolName);
        if (external && rt.name !== namespacedName) throw new Error('Invalid external MCP public name');
        if (toolInstances.some(tool => tool.name === namespacedName)) throw new Error('Duplicate MCP public name');

        const descPrefix = external ? `[MCP: ${this.serverName}] ` : '';
        const toolDesc = rt.description
          ? `${descPrefix}${rt.description}`
          : (external ? `[MCP: ${this.serverName}] Herramienta ${toolName}` : toolName);

        const tool = new AgentCore.Tool({
          id: namespacedName,
          name: namespacedName,
          description: toolDesc,
          parameters: rt.inputSchema || { type: 'object', properties: {} },
          aliases: [],
          category: 'mcp',
          isAvailable: () => {
            if (rt.availability?.available === false) return false;
            if (this.client.id === 'mcp_proxy') {
              const State = getState();
              return State ? State.get('mcp')?.status === 'connected' : false;
            }
            return true;
          },
          settings: {
            titleFallback: toolName,
            descFallback: rt.description || '',
            icon: 'plug',
            defaultEnabled: rt.availability?.available !== false,
            showInSettings: true
          },
          metadata: {
            icon: 'plug',
            iconSvg: getMcpIconSvg(14),
            label: toolName,
            mcpServerName: this.serverName,
            mcpServerUrl: this.serverUrl,
            originalName: toolName,
            mcpServerId: sourceServer,
            description: rt.description || '',
            available: rt.availability?.available !== false
          },
          execute: async (args, context = {}) => {
            try {
              return await this.client.callTool(rt.name, args, {
                signal: context.signal,
                timeoutMs: options.timeoutMs
              });
            } catch (error) {
              if (this.client.id === 'mcp_proxy' && isTransportFailure(error)) {
                await this.onTransportFailure?.(error);
              }
              throw error;
            }
          },
          result: {
            toModel: (args, result, outcome) => {
              if (result?.content) return result.content;
              if (result?.rawResult) {
                if (typeof result.rawResult === 'string') return result.rawResult;
                return JSON.stringify(result.rawResult);
              }
              return outcome?.error || result?.error || 'No output';
            },
            toMarkdown: (args, result, outcome) => {
              return formatMcpMarkdown(toolName, args, result, outcome, this.serverName);
            }
          },
          displayMode: 'collapsed',
          view: createMcpToolView(toolName, this.serverName),
          formatter: (args, result) => {
            return formatMcpMarkdown(toolName, args, result, null, this.serverName);
          }
        });

        toolInstances.push(tool);
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

  /**
   * Administrador de Servidores MCP y sincronización con ToolRegistry (McpManager).
   */
  class McpManager {
    constructor() {
      this.servers = [];
      this.clients = new Map();
      this.providers = new Map();
      this.storageKey = 'chat_mcp_servers';
      this.sessionToken = null;
      this.healthCheckPromise = null;
      this.loadConfig();
    }

    setSessionToken(token) {
      this.sessionToken = token ? String(token).trim() : null;
      for (const client of this.clients.values()) {
        client.token = this.sessionToken;
      }
    }

    getSessionToken() {
      return this.sessionToken;
    }

    /**
     * Carga la lista de servidores MCP configurados desde el almacenamiento local.
     */
    loadConfig() {
      try {
        const Storage = getStorage();
        let raw = null;
        if (Storage && Storage.getStorageItem) {
          raw = Storage.getStorageItem(this.storageKey);
          if (raw === null && typeof Storage.migrateLegacyStorageItem === 'function') {
            raw = Storage.migrateLegacyStorageItem(this.storageKey);
          }
        }

        if (raw) {
          this.servers = JSON.parse(raw);
        } else {
          this.servers = [];
        }
      } catch (e) {
        this.servers = [];
      }
    }

    /**
     * Guarda la configuración de servidores MCP en el almacenamiento local.
     */
    saveConfig() {
      try {
        const Storage = getStorage();
        const serialized = JSON.stringify(this.servers);
        if (Storage && Storage.setStorageItem) {
          Storage.setStorageItem(this.storageKey, serialized);
        }
      } catch (e) {}
    }

    /**
     * Obtiene la lista de servidores configurados.
     */
    getServers() {
      return [...this.servers];
    }

    /**
     * Añade o actualiza un servidor MCP.
     */
    addServer(serverConfig) {
      if (!serverConfig || !serverConfig.url) {
        throw new Error('La URL del servidor MCP es obligatoria.');
      }

      const id = serverConfig.id || `mcp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const existingIdx = this.servers.findIndex(s => s.id === id);

      const serverData = {
        id: id,
        name: serverConfig.name || 'Servidor MCP',
        url: serverConfig.url.trim(),
        headers: serverConfig.headers || {},
        enabled: serverConfig.enabled !== false,
        lastConnected: null,
        toolCount: 0
      };

      if (existingIdx !== -1) {
        this.servers[existingIdx] = serverData;
      } else {
        this.servers.push(serverData);
      }

      this.saveConfig();
      return serverData;
    }

    /**
     * Elimina un servidor MCP configurado.
     */
    removeServer(id) {
      this.servers = this.servers.filter(s => s.id !== id);
      if (this.clients.has(id)) {
        try {
          this.clients.get(id).disconnect();
        } catch (e) {}
        this.clients.delete(id);
      }
      this.providers.delete(id);
      this.saveConfig();
    }

    /**
     * Obtiene o crea una instancia de McpClient para un servidor.
     */
    getClient(serverId) {
      if (this.clients.has(serverId)) {
        return this.clients.get(serverId);
      }

      const serverConfig = this.servers.find(s => s.id === serverId);
      if (!serverConfig) return null;

      const client = new McpClient({ ...serverConfig, token: this.sessionToken });
      this.clients.set(serverId, client);
      return client;
    }

    /**
     * Descubre y registra las herramientas de un servidor MCP en el ToolRegistry de AgentCore.
     */
    async connectAndRegisterServer(serverId, registry) {
      const AgentCore = getAgentCore();
      const targetRegistry = registry || (AgentCore ? AgentCore.registry : null);
      if (!targetRegistry) return { success: false, error: 'ToolRegistry no disponible' };

      const serverConfig = this.servers.find(s => s.id === serverId);
      if (!serverConfig || !serverConfig.enabled) {
        return { success: false, error: 'Servidor no encontrado o deshabilitado' };
      }

      const client = this.getClient(serverId);
      const provider = new McpToolProvider(client, {
        id: `mcp_prov_${serverId}`,
        name: serverConfig.name,
        onTransportFailure: error => this.markProxyUnavailable(error, targetRegistry)
      });

      try {
        const tools = await provider.discoverTools();
        targetRegistry.registerProvider(provider);

        serverConfig.lastConnected = Date.now();
        serverConfig.toolCount = tools.length;
        this.providers.set(serverId, provider);
        this.saveConfig();

        return {
          success: true,
          toolCount: tools.length,
          tools: tools.map(t => ({
            id: t.id || t.name,
            name: t.name,
            description: t.metadata?.description || t.settings?.descFallback || t.description || '',
            parameters: t.parameters,
            inputSchema: t.parameters,
            category: t.category,
            titleFallback: t.settings?.titleFallback || t.name,
            descFallback: t.settings?.descFallback || t.metadata?.description || t.description || '',
            available: t.metadata?.available !== false
          }))
        };
      } catch (err) {
        return {
          success: false,
          error: err.message
        };
      }
    }

    /**
     * Conecta y sincroniza todos los servidores habilitados con el ToolRegistry.
     */
    async syncAllWithRegistry(registry) {
      const results = [];
      for (const server of this.servers) {
        if (server.enabled) {
          const res = await this.connectAndRegisterServer(server.id, registry);
          results.push({ serverId: server.id, name: server.name, ...res });
        }
      }
      return results;
    }

    /**
     * Sondea la conectividad con un endpoint MCP.
     */
    async probeConnection(url, options = {}) {
      return probeConnection(url, options);
    }

    async markProxyUnavailable(error, registry = null) {
      const State = getState();
      const current = State?.get?.('mcp') || {};
      const message = error?.message || String(error || 'Conexión MCP no disponible');
      await this.disconnectProxy(registry);
      if (State?.set) {
        State.set('mcp', {
          status: 'error', host: current.host, port: current.port, endpoint: current.endpoint,
          serverInfo: null, tools: [], latencyMs: null, error: message,
          externalServers: [], externalTools: [], lastVerified: Date.now()
        });
      }
      if (typeof window !== 'undefined' && window.ChatApp?.stopServerHeartbeat) {
        window.ChatApp.stopServerHeartbeat();
      }
      return { success: false, error: message };
    }

    async verifyProxyConnection({ timeoutMs = 1500, registry = null } = {}) {
      if (this.healthCheckPromise) return this.healthCheckPromise;
      const State = getState();
      const current = State?.get?.('mcp') || {};
      if (current.status !== 'connected') return { success: false, skipped: true };
      const endpoint = current.endpoint || `http://${current.host || '127.0.0.1'}:${current.port || 6388}/sse`;
      const run = (async () => {
        State?.set?.('mcp', { ...current, status: 'checking', error: null });
        const probe = await probeConnection(endpoint, { timeoutMs, token: this.sessionToken });
        if (!probe.success) {
          await this.markProxyUnavailable(new Error(probe.error), registry);
          return { success: false, probe };
        }
        const latest = State?.get?.('mcp') || current;
        State?.set?.('mcp', {
          ...latest, status: 'connected', serverInfo: probe.serverInfo || latest.serverInfo,
          latencyMs: probe.latencyMs, error: null, lastVerified: Date.now()
        });
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
     * Conecta con mcp-proxy en el host y puerto configurados, registrando sus herramientas.
     * Si silentOnFailure es true (p. ej. comprobación inicial de arranque), no marca estado 'error'
     * si el servidor simplemente no está levantado, sino que registra 'disconnected' limpiamente.
     */
    async connectProxy({ host = '127.0.0.1', port = 6388, endpoint = null, timeoutMs = 1500, silentOnFailure = false, token = null } = {}, registry = null) {
      const effectiveToken = token || this.sessionToken;
      if (effectiveToken) {
        this.setSessionToken(effectiveToken);
      }
      const targetEndpoint = endpoint || `http://${host}:${port}/sse`;
      const State = getState();
      if (!silentOnFailure && State?.set) {
        State.set('mcp', { status: 'connecting', host, port, endpoint: targetEndpoint, error: null });
      }

      const probe = await probeConnection(targetEndpoint, { timeoutMs, token: this.sessionToken });
      if (!probe.success) {
        if (this.clients.has('mcp_proxy')) {
          await this.disconnectProxy(registry).catch(() => {});
        }
        if (State?.set) {
          if (silentOnFailure) {
            State.set('mcp', { status: 'disconnected', host, port, endpoint: targetEndpoint, serverInfo: null, tools: [], latencyMs: null, error: null });
          } else {
            State.set('mcp', { status: 'error', host, port, endpoint: targetEndpoint, error: probe.error, latencyMs: probe.latencyMs, serverInfo: null, tools: [] });
          }
        }
        return { success: false, available: false, probe, error: probe.error };
      }

      if (this.clients.has('mcp_proxy')) {
        try { this.clients.get('mcp_proxy').disconnect(); } catch (e) {}
        this.clients.delete('mcp_proxy');
      }

      this.addServer({ id: 'mcp_proxy', name: probe.serverInfo?.name || 'mcp-proxy', url: targetEndpoint, enabled: true });
      const registerResult = await this.connectAndRegisterServer('mcp_proxy', registry);

      if (State?.set) {
        const currentMcp = State.get('mcp') || {};
        State.set('mcp', {
          ...currentMcp,
          status: registerResult.success ? 'connected' : 'error',
          host, port, endpoint: targetEndpoint,
          serverInfo: probe.serverInfo,
          tools: registerResult.tools || [],
          lastConnected: Date.now(),
          latencyMs: probe.latencyMs,
          error: registerResult.success ? null : registerResult.error
        });
      }

      let externalSync = null;
      if (registerResult.success) {
        externalSync = await this.syncExternalServers(registry).catch(() => null);
        if (typeof window !== 'undefined' && window.ChatApp?.startServerHeartbeat && this.sessionToken) {
          window.ChatApp.startServerHeartbeat(host, port, this.sessionToken);
        }
      }

      return {
        success: registerResult.success,
        available: true,
        probe,
        register: registerResult,
        tools: registerResult.tools || [],
        externalSync
      };
    }

    /**
     * Comprueba si el servidor mcp-proxy está disponible delegando en la función estándar connectProxy.
     */
    async autoConnectIfAvailable(options = {}, registry = null) {
      return this.connectProxy({ ...options, silentOnFailure: true }, registry);
    }

    /**
     * Desconecta el proxy y actualiza el estado global a desconectado.
     */
    async disconnectProxy(registry = null) {
      const AgentCore = getAgentCore();
      const targetRegistry = registry || AgentCore?.registry;
      if (targetRegistry?.unregisterProvider) targetRegistry.unregisterProvider('mcp_prov_mcp_proxy');
      this.providers.delete('mcp_proxy');

      if (this.clients.has('mcp_proxy')) {
        try { this.clients.get('mcp_proxy').disconnect(); } catch (e) {}
        this.clients.delete('mcp_proxy');
      }

      if (targetRegistry?.unregisterProvider) targetRegistry.unregisterProvider('mcp_prov_mcp_external');
      this.providers.delete('mcp_external');
      if (this.clients.has('mcp_external')) {
        try { this.clients.get('mcp_external').disconnect(); } catch (e) {}
        this.clients.delete('mcp_external');
      }

      const State = getState();
      if (State?.set) State.set('mcp', { status: 'disconnected', serverInfo: null, tools: [], latencyMs: null, error: null, externalServers: [], externalTools: [] });
      return { success: true };
    }

    getExternalControlClient() {
      return this.getClient('mcp_proxy');
    }

    async requestExternalControl(method, params = {}, options = {}) {
      const client = this.getExternalControlClient();
      if (!client) throw new Error('Servicio local de herramientas no conectado.');
      return client.request(method, params, options);
    }

    async refreshExternalProvider(registry = null) {
      const control = this.getExternalControlClient();
      if (!control) throw new Error('Servicio local de herramientas no conectado.');
      const baseUrl = (control.url || 'http://127.0.0.1:6388/sse').replace(/\/sse\/?$/, '');
      const AgentCore = getAgentCore();
      const targetRegistry = registry || AgentCore?.registry;
      if (this.clients.has('mcp_external')) {
        try { this.clients.get('mcp_external').disconnect(); } catch (_) {}
        this.clients.delete('mcp_external');
      }
      if (targetRegistry?.unregisterProvider) targetRegistry.unregisterProvider('mcp_prov_mcp_external');
      this.providers.delete('mcp_external');
      const client = new McpClient({
        id: 'mcp_external',
        name: 'ZeroChat External MCP Host',
        url: `${baseUrl}/mcp/external`,
        token: this.sessionToken,
        enabled: true
      });
      this.clients.set('mcp_external', client);
      const provider = new McpToolProvider(client, { id: 'mcp_prov_mcp_external', name: 'ZeroChat External MCP Host' });
      let result;
      try {
        const tools = await provider.discoverTools();
        if (targetRegistry?.registerProvider) targetRegistry.registerProvider(provider);
        this.providers.set('mcp_external', provider);
        result = { success: true, toolCount: tools.length, tools };
      } catch (error) {
        this.clients.delete('mcp_external');
        result = { success: false, error: error.message || String(error), tools: [] };
      }
      const State = getState();
      if (State?.set && result.success) {
        const current = State.get('mcp') || {};
        State.set('mcp', { ...current, externalTools: result.tools || [] });
      }
      return result;
    }

    async fetchExternalServers(options = {}) {
      try {
        return await this.requestExternalControl('zerochat/external/status', {}, options);
      } catch (_) {
        return { host: 'running', servers: [] };
      }
    }

    async syncExternalServers(registry = null) {
      const State = getState();
      const status = await this.fetchExternalServers().catch(() => ({ host: 'running', servers: [] }));

      let externalTools = [];
      const hasRunningServers = (status?.servers || []).some(s => s.status === 'running');
      if (hasRunningServers) {
        const refresh = await this.refreshExternalProvider(registry).catch(() => null);
        if (refresh?.success) {
          externalTools = refresh.tools || [];
        }
      } else {
        const AgentCore = getAgentCore();
        const targetRegistry = registry || AgentCore?.registry;
        if (targetRegistry?.unregisterProvider) targetRegistry.unregisterProvider('mcp_prov_mcp_external');
        this.providers.delete('mcp_external');
        if (this.clients.has('mcp_external')) {
          try { this.clients.get('mcp_external').disconnect(); } catch (_) {}
          this.clients.delete('mcp_external');
        }
      }

      if (State?.set) {
        const current = State.get('mcp') || {};
        State.set('mcp', {
          ...current,
          externalHost: status?.host || 'running',
          externalServers: status?.servers || [],
          externalTools
        });
      }

      return { status, externalTools };
    }

    async startExternalServer(serverId, registry = null) {
      const result = await this.requestExternalControl('zerochat/external/servers/start', { serverId });
      await this.syncExternalServers(registry).catch(() => {});
      return result;
    }

    async stopExternalServer(serverId, registry = null) {
      const result = await this.requestExternalControl('zerochat/external/servers/stop', { serverId });
      await this.syncExternalServers(registry).catch(() => {});
      return result;
    }

    async configureExternalServer(serverId, config = {}) {
      return this.requestExternalControl('zerochat/external/servers/configure', {
        serverId,
        options: config.options || config
      });
    }
  }

  const manager = new McpManager();

  return {
    McpClient,
    McpToolProvider,
    McpManager,
    probeConnection,
    manager
  };
});
