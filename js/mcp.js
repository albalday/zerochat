/**
 * Integración MCP (Model Context Protocol) de ZeroChat con el servidor local zerochat.py.
 *
 * - Transporte JSON-RPC 2.0 por POST.
 * - El servidor local expone sus herramientas (`mcp_proxy`) y las de los servicios MCP externos que
 *   gestiona por stdio (`mcp_external`); el navegador no lanza procesos.
 * - Las cabeceras y tokens solo viven en el cliente HTTP: nunca llegan al prompt ni al ejecutor de
 *   JavaScript. Cada herramienta indica el servidor del que procede.
 * - Las peticiones tienen plazo (AbortController) y las respuestas se truncan para no desbordar el
 *   contexto.
 */

(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./utils.js'), require('./i18n.js'), require('./icons.js'), require('./defaults.js'), require('./mcp-status.js'), require('./mcp-results.js'));
  } else {
    root.ChatMCP = factory(root.ChatUtils, root.ChatI18n, root.ChatIcons, root.ChatDefaults, root.ChatMcpStatus, root.ChatMcpResults);
  }
})(typeof self !== 'undefined' ? self : this, function (Utils, I18n, Icons, Defaults, McpStatus, McpResults) {
  'use strict';

  const { fetchWithTimeout, resolveDep } = Utils;
  const { formatToolCallResult, formatMcpMarkdown, getResultText } = McpResults;

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
  const LOCAL_WAIT_TOOL = 'check_command';

  /**
   * Las herramientas del servidor local actúan en su directorio: solo están disponibles con el servidor
   * conectado y si la conversación activa es de ese proyecto (o aún no tiene ninguno). Así una conversación
   * cuyo proyecto ya no existe nunca actúa en otra carpeta.
   */
  function localToolsAvailable() {
    const State = getState();
    const mcp = State.get('mcp');
    if (mcp.status !== 'connected') return false;
    const { activeId, list } = State.get('sessions');
    const project = list.find(session => session.id === activeId)?.project;
    return !project || project === mcp.serverInfo?.cwd;
  }
  const BROWSER_ACTION_TOOL = 'browser_action';
  const PLAYWRIGHT_SERVER_ID = 'playwright';

  /** Playwright del servicio instalado según el último latido; null mientras no se sabe. */
  const playwrightInstalled = () => getState().get('mcp').playwright?.installed ?? null;
  /** browser_action se puede usar ahora: Playwright instalado y un Chromium con el que navegar. */
  const browserActionAvailable = () => getState().get('mcp').playwright?.browserAction?.available === true;
  const HEARTBEAT_INTERVAL_MS = 10000;
  // Código con el que el servidor avisa de que la carpeta del proyecto de la pestaña ya no existe.
  const PROJECT_GONE_CODE = -32003;
  const HEARTBEAT_FAST_INTERVAL_MS = 1000;
  // Plazo de los sondeos al servidor local (conexión, comprobación y reconexión del latido).
  const PROBE_TIMEOUT_MS = 1500;
  // Lo que el servidor local informa en vivo, vacío mientras no hay conexión.
  const LIVE_RESET = Object.freeze({ serverInfo: null, tools: [], externalServers: [], externalTools: [], commandJobs: [], exitOnClose: false, playwright: null, serverRuns: [], focusRun: null });
  const UNREACHABLE_SERVER_ERROR = 'Cannot reach the local server at that address and port. Make sure zerochat is running in your terminal.';

  const getAgentCore = () => resolveDep('ChatAgentCore', './agent-core.js');
  const getState = () => resolveDep('ChatState', './state.js');
  const getCommandCard = () => resolveDep('ChatCommandCard', './command-card.js');
  const getToolCards = () => resolveDep('ChatToolCards', './tool-cards.js');
  const getSecurity = () => resolveDep('ChatToolSecurity', './tool-security.js');
  const getMcpExternal = () => resolveDep('ChatMcpExternal', './mcp-external.js');
  const getProfiles = () => resolveDep('ChatProfileRepository', './profile-repository.js');

  /** Cabeceras del proxy inverso: X-ZeroChat-Proxy enruta hacia zerochat.py y Authorization lleva su clave. */
  const proxyHeaders = proxyKey => (proxyKey === null ? {} : { 'X-ZeroChat-Proxy': '1', Authorization: `Bearer ${proxyKey}` });

  /**
   * El proyecto es de la pestaña: viaja en cada petición al servidor local, que lo usa como carpeta de
   * trabajo y no lo guarda. Sin proyecto todavía (la primera conexión), el servidor usa el suyo por defecto.
   */
  function projectHeaders() {
    const cwd = getState().get('mcp').serverInfo?.cwd;
    return cwd ? { 'X-ZeroChat-Project': encodeURIComponent(cwd) } : {};
  }
  // Un 401 (sin token, caducado o de otro día) pide identificarse con la cuenta del sistema.
  const failureStatus = error => (error?.status === 401 ? 'login_required' : 'error');

  // Escrituras del servidor local cuyo resultado lleva la ruta absoluta del fichero (botón Diff).
  const FILE_WRITE_TOOLS = new Set(['write_file', 'edit_file']);
  const WEB_FETCH_CONTROL_MARGIN_MS = 5000;
  // Plazo de la instalación de webdiff en el backend (120 s) más margen para recibir su error.
  const DIFF_TOOL_SETUP_TIMEOUT_MS = 130000;

  /**
   * Sondea de forma no destructiva un endpoint MCP para verificar conectividad y latencia.
   */
  async function probeConnection(url, options = {}) {
    const timeoutMs = options.timeoutMs || 4000;
    const startTime = performance.now();
    const normalizedUrl = (url || '').trim();
    if (!normalizedUrl) return { success: false, error: 'Invalid or empty URL', latencyMs: 0 };

    const client = new McpClient({ url: normalizedUrl, timeoutMs, token: options.token, headers: options.headers });
    const latency = () => Math.max(1, Math.round(performance.now() - startTime));
    const describe = message => (/Failed to fetch|NetworkError|ECONNREFUSED/.test(message) ? UNREACHABLE_SERVER_ERROR : message);
    try {
      const initResult = await client.initialize({ timeoutMs });
      if (initResult.success) {
        return { success: true, latencyMs: latency(), serverInfo: initResult.serverInfo, capabilities: initResult.capabilities, liveState: initResult.liveState };
      }
      return { success: false, error: describe(initResult.error), status: initResult.status, latencyMs: latency() };
    } catch (err) {
      return { success: false, error: describe(err.message || 'Connection error'), latencyMs: latency() };
    }
  }

  /** La conexión con el servidor local se ha perdido: fallo de red o de servidor, o 401 (el token caducó). */
  function isTransportFailure(error) {
    if (!error || error.name === 'AbortError') return false;
    if (error.status === 401) return true;
    const message = String(error.message || error).toLowerCase();
    return /network|fetch|econnrefused|timeout|http 5\d\d/.test(message);
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
      this.headers = config.headers || {};
      this.timeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS;
      this.token = config.token || null;
      this.requestId = 1;
      this.serverCapabilities = null;
      this.serverInfo = null;
    }

    /** Solo el servidor local procesa llamadas internas con privilegios de sistema. */
    get isLocalServer() {
      return this.id === PROXY_ID || this.id === EXTERNAL_ID;
    }

    /**
     * Construye las cabeceras HTTP necesarias, incluyendo autenticación si está configurada.
     */
    buildHeaders() {
      const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-ZeroChat-Client': '1'
      };
      if (this.token) {
        headers['Authorization'] = `Bearer ${this.token}`;
        headers['X-ZeroChat-Token'] = this.token;
      }
      return Object.assign(headers, this.headers, this.isLocalServer ? projectHeaders() : {});
    }

    buildRequestHeaders(targetUrl, body, options) {
      const headers = this.buildHeaders();
      if (options?.headers) {
        Object.assign(headers, options.headers);
      }
      return headers;
    }

    /**
     * Despacha una petición JSON-RPC 2.0 al endpoint del servidor MCP.
     */
    async request(method, params = {}, options = {}) {
      if (!this.url) throw new Error(`MCP server '${this.name}' has no URL.`);
      const id = this.requestId++;
      const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      // Con señal propia (las herramientas) cancela quien llama: un comando puede durar minutos.
      const res = await fetchWithTimeout(this.url, {
        method: 'POST',
        headers: await this.buildRequestHeaders(this.url, body, options),
        body,
        signal: options.signal
      }, options.signal ? 0 : options.timeoutMs || this.timeoutMs);
      if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        throw Object.assign(new Error(`MCP server responded with HTTP ${res.status}: ${errorText.slice(0, 200)}`), { status: res.status });
      }
      const data = await res.json();
      if (data.error) throw Object.assign(new Error(formatJsonRpcError(data.error)), { rpcError: data.error });
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
        return { success: false, error: err.message, status: err.status };
      }

      this.serverCapabilities = result?.capabilities || {};
      this.serverInfo = result?.serverInfo || { name: this.name, version: 'unknown' };
      await this.notify('notifications/initialized', {});
      return { success: true, serverInfo: this.serverInfo, capabilities: this.serverCapabilities, liveState: result?.liveState || null };
    }

    /**
     * Envía una notificación JSON-RPC (sin esperar resultado).
     */
    async notify(method, params = {}) {
      try {
        await fetch(this.url, {
          method: 'POST',
          headers: this.buildHeaders(),
          body: JSON.stringify({ jsonrpc: '2.0', method, params })
        });
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
      const params = {
        name,
        arguments: args,
        ...(options.meta ? { _meta: options.meta } : {})
      };
      const result = await this.request('tools/call', params, options);
      const elapsed = parseFloat((performance.now() - startTime).toFixed(2));
      return formatToolCallResult(result, { name, serverName: this.name, args, elapsed });
    }
  }

  /**
   * Ejecuta una petición de run_command del servidor local deteniendo su trabajo si se aborta:
   * el comando sigue vivo aunque se cancele la petición, y el servidor conoce la clave de la
   * invocación antes de devolver su job_id.
   */
  async function withCommandJobStop(client, jobKey, signal, run, stopMethod = 'zerochat/jobs/stop') {
    if (!jobKey) return run();
    const stopJob = () => {
      client.request(stopMethod, { key: jobKey }).catch(() => {});
    };
    signal?.addEventListener('abort', stopJob, { once: true });
    try {
      return await run();
    } finally {
      signal?.removeEventListener('abort', stopJob);
    }
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
        // check_command: su tarjeta muestra la espera y abortar el turno corta la espera, no el comando.
        const isLocalWait = isProxy && toolName === LOCAL_WAIT_TOOL;
        const isBrowserAction = isProxy && toolName === BROWSER_ACTION_TOOL;
        const usesBrowser = isBrowserAction || (external && sourceServer === PLAYWRIGHT_SERVER_ID);
        const namespacedName = publicToolName(isProxy ? null : sourceServer, toolName);
        if (external && rt.name !== namespacedName) throw new Error('Invalid external MCP public name');
        if (toolInstances.some(tool => tool.name === namespacedName)) throw new Error('Duplicate MCP public name');

        toolInstances.push(new Tool({
          // El nombre público ya identifica el servidor; repetirlo en la descripción gasta contexto.
          definition: { name: namespacedName, description: rt.description || toolName, parameters: rt.inputSchema },
          category: 'mcp',
          // Una espera tiene que verse sin desplegarla.
          displayMode: isLocalWait ? 'expanded' : undefined,
          isAvailable: () => (!isProxy || localToolsAvailable()) && (!isBrowserAction || browserActionAvailable()),
          settings: { showInSettings: true },
          metadata: {
            iconSvg: Icons.get('plug', { size: 14 }),
            mcpServerName: serverName,
            mcpServerUrl: this.serverUrl,
            originalName: toolName,
            mcpServerId: sourceServer,
            localCommand: isLocalCommand,
            description: rt.description || ''
          },
          execute: async (args, context) => {
            const jobKey = isLocalCommand || isLocalWait ? context.invocationId : null;
            // Un navegador lo usa una conversación cada vez: el servidor necesita saber cuál lo pide.
            const conversationId = usesBrowser ? getState().get('sessions').activeId : null;
            const meta = { ...(jobKey ? { zerochatJobKey: jobKey } : {}), ...(conversationId ? { zerochatConversationId: conversationId } : {}) };
            try {
              return await withCommandJobStop(this.client, jobKey, context.signal, () => this.client.callTool(rt.name, args, {
                signal: context.signal,
                timeoutMs: options.timeoutMs,
                meta: Object.keys(meta).length ? meta : undefined
              }), isLocalWait ? 'zerochat/jobs/end_wait' : undefined);
            } catch (error) {
              if (isProxy && isTransportFailure(error)) await this.onTransportFailure?.(error);
              throw error;
            }
          },
          result: {
            toModel: (args, result) => getResultText(result),
            toMarkdown: (args, result) => formatMcpMarkdown(toolName, args, result, serverName)
          },
          view: isLocalCommand
            ? getCommandCard().createView()
            : isLocalWait
              ? getCommandCard().createWaitView()
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

  /**
   * Conexión con el servidor local: sus herramientas, las de los servicios MCP externos que gestiona,
   * los comandos en segundo plano y el directorio del proyecto.
   */
  class McpManager {
    constructor() {
      this.clients = new Map();
      this.sessionToken = null;
      this.healthCheckPromise = null;
      this.projectRecovery = null;
      // Destino de la conexión ({ url, proxyKey }), que el latido vigila aunque la conexión falle.
      this.target = null;
      this.heartbeatTimer = null;
      this.heartbeatIntervalMs = null;
      this.heartbeatCheckInFlight = false;
      this.liveStateSeq = 0;
      // Si el último servidor conectado se detiene al cerrar el navegador; null mientras no se sabe.
      this.serverExitsOnClose = null;
      // Últimos servicios externos que informó el servidor, para no pisar en cada latido lo que la
      // interfaz muestra de una acción en curso, y cuáles estaban en marcha.
      this.liveServers = null;
      this.liveRunning = null;
    }

    setSessionToken(token) {
      this.sessionToken = token ? String(token).trim() : null;
      for (const client of this.clients.values()) client.token = this.sessionToken;
    }

    /** Cierra el cliente y retira del registro las herramientas de su proveedor. */
    dropClient(clientId) {
      if (clientId === PROXY_ID) {
        getSecurity().manager.setMcpClient(null);
      }
      getAgentCore().registry.unregisterProvider(`mcp_prov_${clientId}`);
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
     * Publica en ChatState el estado vivo que informa el servidor local, en initialize, en el latido o
     * en la respuesta de un control: el directorio del proyecto (que siguen el modo proyecto y la regla de lectura por
     * defecto), los comandos en segundo plano en marcha (los esperados ya se ven en su tarjeta), si el
     * servidor se detiene al cerrar el navegador, Playwright (instalado y browser_action disponible)
     * y los servicios externos, cuyas herramientas se vuelven a registrar si cambian los que están en
     * marcha. Solo lee los campos presentes y solo escribe los que cambian, no en cada latido.
     */
    async applyLiveState(payload) {
      const State = getState();
      const current = State.get('mcp');
      if (current.status !== 'connected' || !payload) return false;
      if (typeof payload.exit_on_close === 'boolean') {
        this.serverExitsOnClose = payload.exit_on_close;
      }
      const next = {};
      const cwd = typeof payload.cwd === 'string' ? payload.cwd.trim() : '';
      if (cwd && current.serverInfo && current.serverInfo.cwd !== cwd) {
        getSecurity().manager.refresh().catch(() => {});
        next.serverInfo = { ...current.serverInfo, cwd };
      }
      if (Array.isArray(payload.jobs)) {
        const jobs = payload.jobs
          .filter(job => job && Number.isInteger(job.id) && job.status === 'running' && job.background === true)
          .map(job => ({
            id: job.id,
            command: typeof job.command === 'string' ? job.command : '',
            startedAt: Number.isFinite(job.started_at) ? job.started_at : Date.now(),
            lastLine: typeof job.last_line === 'string' ? job.last_line : ''
          }));
        if (JSON.stringify(jobs) !== JSON.stringify(current.commandJobs)) next.commandJobs = jobs;
      }
      let serverRuns = current.serverRuns;
      if (Array.isArray(payload.runs)) {
        serverRuns = payload.runs
          .filter(run => run && typeof run.conversation_id === 'string' && typeof run.status === 'string')
          .map(run => ({
            conversationId: run.conversation_id,
            runId: typeof run.run_id === 'string' ? run.run_id : '',
            status: run.status
          }));
        if (JSON.stringify(serverRuns) !== JSON.stringify(current.serverRuns)) next.serverRuns = serverRuns;
      }
      if ('focus_run' in payload) {
        const focusRun = payload.focus_run && typeof payload.focus_run === 'object' ? payload.focus_run : null;
        if (JSON.stringify(focusRun) !== JSON.stringify(current.focusRun)) next.focusRun = focusRun;
      }
      const hasRunningServerRuns = Array.isArray(serverRuns) && serverRuns.some(run => run.status === 'running');
      if (hasRunningServerRuns) {
        this.setHeartbeatTimer(Boolean(this.target), HEARTBEAT_FAST_INTERVAL_MS);
      } else if (typeof payload.exit_on_close === 'boolean' || Array.isArray(payload.runs)) {
        this.setHeartbeatTimer(this.serverExitsOnClose !== false && Boolean(this.target), HEARTBEAT_INTERVAL_MS);
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
        running = payload.servers.filter(server => McpStatus.isRunning(server?.status)).map(server => `${server.id}:${server.toolCount}`).join();
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
      getState().set('mcp', { status: failureStatus(error), error: message });
      return { success: false, error: message };
    }

    async verifyProxyConnection({ timeoutMs = PROBE_TIMEOUT_MS } = {}) {
      if (this.healthCheckPromise) return this.healthCheckPromise;
      const State = getState();
      const current = State.get('mcp');
      if (current.status !== 'connected') return { success: false, skipped: true };
      const run = (async () => {
        State.set('mcp', { status: 'checking', error: null });
        const probe = await this.probeTarget(timeoutMs);
        if (!probe.success) {
          await this.markProxyUnavailable(Object.assign(new Error(probe.error), { status: probe.status }));
          return { success: false, probe };
        }
        State.set('mcp', { status: 'connected', serverInfo: probe.serverInfo, latencyMs: probe.latencyMs, error: null });
        await this.applyLiveState(probe.liveState);
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
     * Con auto-cierre, o mientras no se sabe, el latido de 10 s mantiene vivo el servidor, lee su
     * estado y reconecta en cuanto vuelve; sin auto-cierre no hay temporizador (onPageVisible).
     */
    setHeartbeatTimer(enabled, intervalMs = HEARTBEAT_INTERVAL_MS) {
      if (enabled && (!this.heartbeatTimer || this.heartbeatIntervalMs !== intervalMs)) {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatIntervalMs = intervalMs;
        this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), intervalMs);
      }
      if (!enabled && this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
        this.heartbeatIntervalMs = null;
      }
    }

    /** Sin latido periódico, al volver a la pestaña se relee el estado vivo o se reconecta. */
    async onPageVisible() {
      if (!this.heartbeatTimer) await this.sendHeartbeat();
    }

    /**
     * Conecta con zerochat.py en el host y puerto indicados, registra sus herramientas y publica el
     * estado vivo de initialize. Con silentOnFailure (la comprobación del arranque) un servidor apagado
     * deja el estado en 'disconnected' en lugar de 'error'. Con sesión, el latido (o la vuelta a la
     * pestaña) vigila este destino aunque falle: conecta en cuanto el servidor arranca o vuelve.
     */
    /** Sondea el destino de la conexión con el token de la sesión. */
    probeTarget(timeoutMs = PROBE_TIMEOUT_MS) {
      return probeConnection(this.target.url, { timeoutMs, token: this.sessionToken, headers: { ...proxyHeaders(this.target.proxyKey), ...projectHeaders() } });
    }

    /**
     * Conecta con zerochat.py en `url` (con `proxyKey`, a través del proxy inverso), registra sus
     * herramientas y publica el estado vivo de initialize. Un 401 deja el estado en 'login_required'.
     * Con silentOnFailure (la conexión del arranque) un servidor apagado deja el estado en
     * 'disconnected' en lugar de 'error'. El latido (o la vuelta a la pestaña) vigila este destino
     * aunque falle: conecta en cuanto el servidor arranca o vuelve.
     */
    async connectProxy({ url, proxyKey = null, timeoutMs = PROBE_TIMEOUT_MS, silentOnFailure = false, token = null }) {
      if (token) this.setSessionToken(token);
      this.target = { url, proxyKey };
      this.setHeartbeatTimer(this.serverExitsOnClose !== false);
      const State = getState();
      if (!silentOnFailure) State.set('mcp', { status: 'connecting', endpoint: url, error: null });

      const probe = await this.probeTarget(timeoutMs);
      if (!probe.success) {
        if (this.clients.has(PROXY_ID)) await this.disconnectProxy();
        const status = probe.status === 401 ? 'login_required' : silentOnFailure ? 'disconnected' : 'error';
        State.set('mcp', {
          status,
          endpoint: url,
          error: status === 'disconnected' ? null : probe.error,
          latencyMs: status === 'disconnected' ? null : probe.latencyMs,
          ...LIVE_RESET
        });
        return { success: false, available: false, probe, error: probe.error };
      }

      this.dropClient(PROXY_ID);
      const client = new McpClient({ id: PROXY_ID, name: probe.serverInfo.name || 'zerochat', url, token: this.sessionToken, headers: proxyHeaders(proxyKey) });
      let tools = [];
      let error = null;
      try {
        tools = await this.registerClient(client, { onTransportFailure: failure => this.markProxyUnavailable(failure) });
        getSecurity().manager.setMcpClient(client);
        await getSecurity().manager.refresh().catch(err => {
          console.warn('[MCP] Could not sync security policies from backend:', err?.message || err);
        });
      } catch (err) {
        error = err.message;
      }

      State.set('mcp', {
        status: error ? 'error' : 'connected',
        endpoint: url,
        serverInfo: probe.serverInfo,
        tools,
        latencyMs: probe.latencyMs,
        error
      });
      if (error) return { success: false, available: true, probe, error, tools };

      // initialize trae los servicios externos y el resto del estado vivo.
      this.liveServers = null;
      this.liveRunning = null;
      await this.applyLiveState(probe.liveState);
      return { success: true, available: true, probe, tools };
    }

    /**
     * Desconecta el servidor local y sus servicios externos y deja el estado en desconectado.
     */
    async disconnectProxy() {
      this.dropClient(PROXY_ID);
      this.dropClient(EXTERNAL_ID);
      getProfiles().clearSessionProfile();
      getState().set('mcp', { status: 'disconnected', latencyMs: null, error: null, ...LIVE_RESET });
      return { success: true };
    }

    /**
     * Lee el latido (zerochat/heartbeat) y publica su estado vivo; devuelve lo leído o falla si el
     * servidor no responde. La lectura no dura más que el intervalo: una colgada (un túnel SSH sin red)
     * bloquearía los latidos siguientes.
     */
    async readLiveState() {
      const seq = ++this.liveStateSeq;
      const focusId = getState().get('sessions')?.activeId || null;
      const params = focusId ? { focus_conversation_id: focusId } : {};
      const payload = await this.requestExternalControl('zerochat/heartbeat', params, { timeoutMs: HEARTBEAT_INTERVAL_MS });
      if (seq !== this.liveStateSeq) return payload;
      // Otra pestaña, el modelo o una instalación pueden haber cambiado el estado del servidor.
      await this.applyLiveState(payload);
      return payload;
    }

    /**
     * Latido al servidor local, cada 10 s o al volver a la pestaña. Conectado, publica su estado vivo
     * (applyLiveState) y, si no responde, comprueba la conexión. Sin conexión, sondea el destino y
     * reconecta si responde; el sondeo previo evita que cada intento fallido de connectProxy reescriba
     * el estado.
     */
    async sendHeartbeat() {
      if (this.heartbeatCheckInFlight) return;
      this.heartbeatCheckInFlight = true;
      let reconnect = false;
      try {
        if (this.isProxyConnected()) {
          try {
            await this.readLiveState();
          } catch (_) {
            await this.verifyProxyConnection();
          }
        } else if (this.target) {
          const probe = await this.probeTarget();
          reconnect = probe.success;
          // Muestra la causa actual: tras un reinicio otro día, el 401 del token caducado y no el fallo de red anterior.
          const status = failureStatus(probe);
          const current = getState().get('mcp');
          if (!probe.success && (probe.error !== current.error || status !== current.status)) getState().set('mcp', { status, error: probe.error });
        }
      } finally {
        this.heartbeatCheckInFlight = false;
      }
      // Fuera del bloqueo, para que connectProxy publique el estado vivo de la nueva conexión.
      if (reconnect) await this.connectProxy({ ...this.target, silentOnFailure: true });
    }

    /**
     * La carpeta del proyecto de la pestaña ya no existe: vuelve al proyecto por defecto del servidor
     * (initialize lo devuelve cuando falta la carpeta) y avisa con `onProjectLost`, que fija la interfaz.
     * Las conversaciones del proyecto perdido se quedan sin herramientas locales.
     */
    recoverLostProject() {
      // Varias peticiones pueden fallar a la vez: una sola recuperación y un solo aviso.
      this.projectRecovery ||= (async () => {
        const lost = getState().get('mcp').serverInfo?.cwd || '';
        const probe = await this.probeTarget();
        if (!probe.success) {
          await this.verifyProxyConnection();
          return false;
        }
        getState().set('mcp', { serverInfo: probe.serverInfo });
        await this.applyLiveState(probe.liveState);
        this.onProjectLost?.({ project: lost, fallback: probe.serverInfo?.cwd || '' });
        return true;
      })().finally(() => { this.projectRecovery = null; });
      return this.projectRecovery;
    }

    /**
     * Se identifica en el destino de la conexión con el usuario y la contraseña de la cuenta del
     * sistema que ejecuta zerochat.py (zerochat/login) y devuelve el token diario. La contraseña no se
     * guarda. Un error de identificación lleva en `rpcError` su código (-32001 fallo, -32002 bloqueo).
     */
    async login(user, password) {
      const client = new McpClient({ url: this.target.url, headers: proxyHeaders(this.target.proxyKey) });
      const result = await client.request('zerochat/login', { user, password });
      if (typeof result?.token !== 'string' || !result.token) throw new Error('The local server did not return a session token.');
      return result.token;
    }

    /** Petición de control al servidor local (comandos, servicios externos, proyecto). */
    async requestExternalControl(method, params = {}, options = {}) {
      const client = this.clients.get(PROXY_ID);
      if (!client) throw new Error('The local tool server is not connected.');
      try {
        return await client.request(method, params, options);
      } catch (error) {
        // El servidor rechaza la petición antes de atenderla: tras volver al proyecto por defecto se repite.
        if (error?.rpcError?.code !== PROJECT_GONE_CODE || !await this.recoverLostProject()) throw error;
        return client.request(method, params, options);
      }
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
      return getCommandCard().buildCommandNotes(
        messages,
        ids => this.requestExternalControl('zerochat/jobs/report', { ids }, { timeoutMs: 3000 })
      );
    }

    /** Cambia el proyecto de esta pestaña (las demás siguen en el suyo): a petición del usuario o al abrir una conversación de otro proyecto. */
    async setProjectDirectory(path) {
      const result = await this.requestExternalControl('zerochat/project/set_directory', { path });
      await this.applyLiveState({ cwd: result?.cwd });
      await getSecurity().manager.refresh().catch(() => {});
      return result;
    }

    /**
     * Lanza en segundo plano en el servidor local un turno de continuación (`zerochat --conversation <id>`).
     * Actualiza el estado vivo de `serverRuns` y activa el latido rápido (1 s).
     */
    async startServerRun({ conversationId, profile, prompt = null, toolSecurity = null }) {
      const params = {
        conversation_id: conversationId,
        profile,
        ...(prompt ? { prompt } : {}),
        ...(toolSecurity ? { tool_security: toolSecurity } : {})
      };
      const result = await this.requestExternalControl('zerochat/run/start', params);
      this.liveStateSeq += 1;
      const State = getState();
      const current = State.get('mcp');
      const runEntry = {
        conversationId: result?.conversation_id || conversationId,
        runId: result?.run_id || '',
        status: result?.status || 'running'
      };
      const nextRuns = [
        ...current.serverRuns.filter(item => item.conversationId !== runEntry.conversationId),
        runEntry
      ];
      const nextState = { serverRuns: nextRuns };
      if (State.get('sessions')?.activeId === runEntry.conversationId) {
        nextState.focusRun = {
          conversation_id: runEntry.conversationId,
          run_id: runEntry.runId,
          status: runEntry.status,
          step_text: '',
          assistant_text: '',
          reasoning_text: ''
        };
      }
      State.set('mcp', nextState);
      this.setHeartbeatTimer(Boolean(this.target), HEARTBEAT_FAST_INTERVAL_MS);
      return result;
    }

    /** Cancela una ejecución de conversación en marcha en el servidor local (`zerochat/run/cancel`). */
    async cancelServerRun(conversationId) {
      const result = await this.requestExternalControl('zerochat/run/cancel', { conversation_id: conversationId });
      await this.readLiveState().catch(() => {});
      return result;
    }

    /** Carga los perfiles de conexión almacenados en el backend local (SQLite). */
    async listServerProfiles() {
      const client = this.clients.get(PROXY_ID);
      if (!client) return [];
      try {
        const result = await client.request('zerochat/profiles/list', {});
        return Array.isArray(result?.profiles) ? result.profiles : [];
      } catch (err) {
        console.warn('[ChatMCP] Could not fetch server profiles:', err);
        return [];
      }
    }

    /** Guarda (crea o actualiza) un perfil en el backend local. */
    async saveServerProfile(profileData) {
      const client = this.clients.get(PROXY_ID);
      if (!client) throw new Error('No local server connection.');
      const result = await client.request('zerochat/profiles/save', { profile: profileData });
      if (!result?.profile) throw new Error('Invalid profile response from server.');
      return result.profile;
    }

    /** Elimina un perfil en el backend local. */
    async deleteServerProfile(profileId) {
      const client = this.clients.get(PROXY_ID);
      if (!client) throw new Error('No local server connection.');
      const result = await client.request('zerochat/profiles/delete', { id: profileId });
      return result?.deleted === true;
    }

    /** Importa un perfil del servidor al repositorio local del cliente. */
    async importServerProfile(serverProfile, options = {}) {
      return getProfiles().importServerProfile(serverProfile, options);
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

    refreshExternalTools(anyRunning) {
      return getMcpExternal().refreshExternalTools(this, anyRunning, { externalId: EXTERNAL_ID, proxyId: PROXY_ID, McpClient });
    }

    startExternalServer(serverId, onWait, options) {
      return getMcpExternal().startExternalServer(this, serverId, onWait, options);
    }

    stopExternalServer(serverId) {
      return getMcpExternal().stopExternalServer(this, serverId);
    }

    configureExternalServer(serverId, options) {
      return getMcpExternal().configureExternalServer(this, serverId, options);
    }

    runExternalServerAction(serverId, action, options) {
      return getMcpExternal().runExternalServerAction(this, serverId, action, options);
    }

    withExternalServerStopped(serverId, action) {
      return getMcpExternal().withExternalServerStopped(this, serverId, action);
    }

    startProfileServers(appConfig) {
      return getMcpExternal().startProfileServers(this, appConfig);
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
    withCommandJobStop,
    LOCAL_COMMAND_TOOL
  };
});
