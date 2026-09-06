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
 *      el cliente HTTP y NUNCA se inyectan en el prompt del sistema ni son accesibles para el sandbox
 *      de ejecución de JavaScript.
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
      client = new McpClient({ url: normalizedUrl, timeoutMs });
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

      // Si initialize no devuelve éxito estricto, probamos un GET simple por si el endpoint SSE está activo
      const probeRes = await fetchWithTimeout(normalizedUrl, {
        method: 'GET',
        headers: { 'Accept': 'text/event-stream, application/json, */*' }
      }, timeoutMs).catch(() => null);

      if (probeRes) {
        return {
          success: true,
          latencyMs,
          serverInfo: { name: 'mcp-proxy', version: 'active' },
          capabilities: {}
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
        'Accept': 'application/json, text/event-stream, */*'
      };
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
          if (typeof EventSource !== 'undefined') {
            const es = new EventSource(this.url);
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
          if (item.type === 'image') return `[Imagen embebida: ${item.mimeType || 'image/png'}]`;
          if (item.type === 'resource') return `[Recurso: ${item.resource?.uri || 'URI'}]\n${item.resource?.text || ''}`;
          return JSON.stringify(item);
        }).join('\n\n').trim();
      } else if (typeof result === 'string') {
        textOutput = result;
      } else if (result) {
        textOutput = JSON.stringify(result, null, 2);
      }

      if (textOutput.length > MAX_OUTPUT_LENGTH) {
        textOutput = textOutput.slice(0, MAX_OUTPUT_LENGTH) + '\n\n[... Contenido MCP truncado por límite de tamaño ...]';
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
      const esc = ui?.markdown?.escapeHtml || String;
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
        const esc = ui?.markdown?.escapeHtml || String;
        const t = ui?.t || (k => k);
        const isSuccess = result?.success !== false && !result?.error && !result?.isError;
        const badge = cardDiv.querySelector('.tool-card-badge');
        if (badge) {
          badge.className = `tool-card-badge ${isSuccess ? 'status-success' : 'status-error'}`;
          badge.innerHTML = isSuccess ? `${ui?.CHECK_SVG || '✔'} <span>${t('tool_status_success') || 'OK'} (${elapsedMs}ms)</span>` : `${ui?.ERROR_SVG || '✖'} <span>Error (${elapsedMs}ms)</span>`;
        }
        const resEl = cardDiv.querySelector('.tool-card-result');
        if (resEl) {
          const out = result?.content || (result?.rawResult ? (typeof result.rawResult === 'string' ? result.rawResult : JSON.stringify(result.rawResult, null, 2)) : (result?.error || 'Sin salida'));
          resEl.innerHTML = `<pre class="tool-card-code"><code>${esc(out)}</code></pre>`;
        }
        const card = cardDiv.querySelector?.('.tool-execution-card') || (cardDiv.matches?.('.tool-execution-card') ? cardDiv : null);
        if (card) {
          card.classList.add('collapsed');
          const btn = card.querySelector('.btn-tool-collapse');
          if (btn) btn.title = t('tool_btn_expand') || 'Expandir';
        }
      },
      renderHistoricalCard: (args, message, ui) => {
        if (typeof document === 'undefined') return null;
        const esc = ui?.markdown?.escapeHtml || String;
        const t = ui?.t || (k => k);
        const badge = `<span class="tool-card-badge status-success">${ui?.CHECK_SVG || '✔'} <span>${t('tool_status_success') || 'OK'}</span></span>`;
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
        if (!rt.name) continue;

        const safeServerId = this.client.id.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
        const namespacedName = `mcp__${safeServerId}__${rt.name}`;
        const toolName = rt.name;

        const tool = new AgentCore.Tool({
          id: namespacedName,
          name: namespacedName,
          description: rt.description ? `[MCP: ${this.serverName}] ${rt.description}` : `[MCP: ${this.serverName}] Herramienta ${toolName}`,
          parameters: rt.inputSchema || { type: 'object', properties: {} },
          aliases: [toolName, `mcp_${toolName}`, `${safeServerId}_${toolName}`],
          category: 'mcp',
          isAvailable: () => {
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
            defaultEnabled: true,
            showInSettings: true
          },
          metadata: {
            icon: 'plug',
            iconSvg: getMcpIconSvg(14),
            label: toolName,
            mcpServerName: this.serverName,
            mcpServerUrl: this.serverUrl,
            originalName: rt.name,
            mcpServerId: this.client.id,
            description: rt.description || ''
          },
          execute: async (args, context = {}) => {
            return this.client.callTool(rt.name, args, {
              signal: context.signal,
              timeoutMs: options.timeoutMs
            });
          },
          result: {
            toModel: (args, result, outcome) => {
              if (result?.content) return result.content;
              if (result?.rawResult) {
                if (typeof result.rawResult === 'string') return result.rawResult;
                return JSON.stringify(result.rawResult);
              }
              return outcome?.error || result?.error || 'Sin salida';
            },
            toMarkdown: (args, result, outcome) => {
              return formatMcpMarkdown(toolName, args, result, outcome, this.serverName);
            }
          },
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
      this.loadConfig();
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
        } else if (typeof localStorage !== 'undefined') {
          raw = localStorage.getItem(this.storageKey);
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
        } else if (typeof localStorage !== 'undefined') {
          localStorage.setItem(this.storageKey, serialized);
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

      const id = serverConfig.id || `mcp_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
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

      const client = new McpClient(serverConfig);
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
        name: serverConfig.name
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
            descFallback: t.settings?.descFallback || t.metadata?.description || t.description || ''
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

    /**
     * Conecta con mcp-proxy en el host y puerto configurados, registrando sus herramientas.
     */
    async connectProxy({ host = '127.0.0.1', port = 6388, endpoint = null } = {}, registry = null) {
      const targetEndpoint = endpoint || `http://${host}:${port}/sse`;
      const State = getState();
      if (State?.set) State.set('mcp', { status: 'connecting', host, port, endpoint: targetEndpoint, error: null });

      const probe = await probeConnection(targetEndpoint);
      if (!probe.success) {
        if (State?.set) State.set('mcp', { status: 'error', host, port, endpoint: targetEndpoint, error: probe.error, latencyMs: probe.latencyMs, serverInfo: null, tools: [] });
        return probe;
      }

      if (this.clients.has('mcp_proxy')) {
        try { this.clients.get('mcp_proxy').disconnect(); } catch (e) {}
        this.clients.delete('mcp_proxy');
      }

      this.addServer({ id: 'mcp_proxy', name: probe.serverInfo?.name || 'mcp-proxy', url: targetEndpoint, enabled: true });
      const registerResult = await this.connectAndRegisterServer('mcp_proxy', registry);

      if (State?.set) {
        State.set('mcp', {
          status: registerResult.success ? 'connected' : 'error',
          host, port, endpoint: targetEndpoint,
          serverInfo: probe.serverInfo,
          tools: registerResult.tools || [],
          lastConnected: Date.now(),
          latencyMs: probe.latencyMs,
          error: registerResult.success ? null : registerResult.error
        });
      }

      return { success: registerResult.success, probe, register: registerResult, tools: registerResult.tools || [] };
    }

    /**
     * Desconecta el proxy y actualiza el estado global a desconectado.
     */
    disconnectProxy(registry = null) {
      const AgentCore = getAgentCore();
      const targetRegistry = registry || AgentCore?.registry;
      if (targetRegistry?.unregisterProvider) targetRegistry.unregisterProvider('mcp_prov_mcp_proxy');
      this.providers.delete('mcp_proxy');

      if (this.clients.has('mcp_proxy')) {
        try { this.clients.get('mcp_proxy').disconnect(); } catch (e) {}
        this.clients.delete('mcp_proxy');
      }

      const State = getState();
      if (State?.set) State.set('mcp', { status: 'disconnected', serverInfo: null, tools: [], latencyMs: null, error: null });
      return { success: true };
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
