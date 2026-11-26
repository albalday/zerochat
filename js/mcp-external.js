/**
 * Ciclo de vida de los servicios MCP externos gestionados por el servidor local:
 * registro de herramientas, arranque con long-poll por fases y OAuth, parada y configuración.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./utils.js'), require('./i18n.js'), require('./mcp-status.js'));
  } else {
    root.ChatMcpExternal = factory(root.ChatUtils, root.ChatI18n, root.ChatMcpStatus);
  }
})(typeof self !== 'undefined' ? self : this, function (Utils, I18n, McpStatus) {
  'use strict';

  const { resolveDep, LONG_POLL_WAIT_MS, LONG_POLL_MARGIN_MS } = Utils;

  const EXTERNAL_START_WAIT_MS = LONG_POLL_WAIT_MS;
  const EXTERNAL_START_TIMEOUT_MS = LONG_POLL_WAIT_MS + LONG_POLL_MARGIN_MS;
  const EXTERNAL_START_MAX_MS = 150000;
  // Cubre los límites del backend (npm install y descarga del navegador, 600 s cada uno)
  // y la espera de la autorización OAuth.
  const EXTERNAL_LONG_START_MAX_MS = 1200000;

  const getAgentCore = () => resolveDep('ChatAgentCore', './agent-core.js');
  const getConfig = () => resolveDep('ChatConfig', './config-store.js');
  const getState = () => resolveDep('ChatState', './state.js');

  /** Cambia en ChatState los campos de un servicio externo; su tarjeta en Ajustes › MCP los pinta. */
  function updateExternalServerState(serverId, changes) {
    getState().set('mcp', current => ({
      ...current,
      externalServers: current.externalServers.map(server => (server.id === serverId ? { ...server, ...changes } : server))
    }));
  }

  /** Vuelve a registrar las herramientas de los servicios externos, o las retira si no hay ninguno en marcha. */
  async function refreshExternalTools(manager, anyRunning, rawTools, { externalProviderId, proxyId, McpToolProvider, summarizeTool }) {
    getAgentCore().registry.unregisterProvider(externalProviderId);
    let tools = [];
    const control = manager.clients.get(proxyId);
    if (anyRunning && control) {
      try {
        const provider = new McpToolProvider(control, {
          id: externalProviderId,
          name: 'ZeroChat External MCP Host',
          onTransportFailure: failure => manager.markProxyUnavailable(failure)
        });
        const discovered = await provider.discoverTools({ tools: rawTools });
        getAgentCore().registry.registerProvider(provider);
        tools = discovered.map(summarizeTool);
      } catch (error) {
        console.warn('[MCP] Could not list the external MCP tools:', error);
      }
    }
    getState().set('mcp', { externalTools: tools });
  }

  /** Arranca un servicio externo y sigue su progreso con long-poll hasta estar en marcha. */
  async function startExternalServer(manager, serverId, onWait) {
    const checkStatus = async status => {
      await manager.applyLiveState(status);
      const server = (status?.servers || []).find(item => item?.id === serverId);
      if (McpStatus.isRunning(server?.status)) return { done: true, server };
      if (!McpStatus.isBusy(server?.status)) {
        const error = new Error(`MCP server '${serverId}' did not start: ${server?.status || 'unknown'}`);
        error.code = 'EXTERNAL_START_STATUS_UNAVAILABLE';
        error.externalServer = server;
        throw error;
      }
      return { done: false, server };
    };

    let currentServer = null;
    let sinceRev = null;
    try {
      const started = await manager.requestExternalControl(
        'zerochat/external/servers/start',
        { serverId, wait_ms: EXTERNAL_START_WAIT_MS },
        { timeoutMs: EXTERNAL_START_TIMEOUT_MS }
      );
      if (started) {
        const checked = await checkStatus(started);
        if (checked.done) return started;
        currentServer = checked.server;
        sinceRev = started.rev ?? null;
      }
    } catch (error) {
      // El timeout inicial no implica fallo: el backend puede seguir instalando o esperando OAuth.
      if (error.name !== 'AbortError' && error.code !== 'MCP_REQUEST_TIMEOUT') throw error;
    }

    // Cada fase (installing, starting) dispone de su propio presupuesto de espera.
    let phase = currentServer?.status ?? null;
    let phaseStartedAt = Date.now();
    let attempt = 0;
    for (;;) {
      if (currentServer) {
        if (currentServer.status !== phase) {
          phase = currentServer.status;
          phaseStartedAt = Date.now();
          attempt = 0;
        }
        const maxMs = currentServer.oauthUrl || currentServer.status === 'installing'
          ? EXTERNAL_LONG_START_MAX_MS
          : EXTERNAL_START_MAX_MS;
        const maxAttempts = Math.ceil(maxMs / EXTERNAL_START_WAIT_MS);
        if (attempt >= maxAttempts || Date.now() - phaseStartedAt >= maxMs) {
          const error = new Error(`MCP server '${serverId}' is still starting after ${maxAttempts} waits.`);
          error.code = 'EXTERNAL_START_WAIT_TIMEOUT';
          error.externalServer = currentServer;
          throw error;
        }
        attempt += 1;
        onWait?.(attempt, maxAttempts, currentServer.status, currentServer);
      }
      let status;
      try {
        const params = sinceRev === null
          ? { serverId, wait_ms: EXTERNAL_START_WAIT_MS }
          : { serverId, since_rev: sinceRev, wait_ms: EXTERNAL_START_WAIT_MS };
        status = await manager.requestExternalControl(
          'zerochat/external/servers/wait',
          params,
          { timeoutMs: EXTERNAL_START_TIMEOUT_MS }
        );
      } catch (cause) {
        const error = new Error('Unable to check MCP startup status.', { cause });
        error.code = 'EXTERNAL_START_STATUS_UNAVAILABLE';
        throw error;
      }
      sinceRev = status?.rev ?? sinceRev;
      const checked = await checkStatus(status);
      if (checked.done) return status;
      currentServer = checked.server;
    }
  }

  async function stopExternalServer(manager, serverId) {
    const result = await manager.requestExternalControl('zerochat/external/servers/stop', { serverId });
    await manager.applyLiveState(result);
    return result;
  }

  async function configureExternalServer(manager, serverId, options) {
    const result = await manager.requestExternalControl('zerochat/external/servers/configure', { serverId, options });
    await manager.applyLiveState(result);
    return result;
  }

  /** Guarda (o borra con `value` null) un secreto que declara el servicio; la respuesta trae la lista sin valores. */
  async function setExternalServerSecret(manager, serverId, name, value) {
    const result = await manager.requestExternalControl('zerochat/external/servers/secret', { serverId, name, value });
    await manager.applyLiveState(result);
    return result;
  }

  /**
   * Inicia o detiene un servicio externo y refleja el progreso en ChatState. La autorización OAuth que
   * pida el arranque se abre una vez en otra pestaña. Devuelve true si la acción terminó correctamente.
   */
  async function runExternalServerAction(manager, serverId, action) {
    updateExternalServerState(serverId, { status: action === 'start' ? 'starting' : 'stopped', error: null, startWait: null, oauthUrl: null });
    let didAutoOpenOAuth = false;
    const reportStartWait = (attempt, total, status = 'starting', serverData = null) => {
      const oauthUrl = serverData?.oauthUrl || null;
      if (oauthUrl && !didAutoOpenOAuth && /^https?:\/\//i.test(oauthUrl)) {
        didAutoOpenOAuth = true;
        window.open(oauthUrl, '_blank', 'noopener,noreferrer');
      }
      updateExternalServerState(serverId, { status, ...(oauthUrl ? { oauthUrl } : {}), error: null, startWait: { attempt, total } });
    };
    try {
      if (action === 'start') await manager.startExternalServer(serverId, reportStartWait);
      else await manager.stopExternalServer(serverId);
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
   * Ejecuta `action` con el servicio detenido y lo vuelve a arrancar si estaba en marcha.
   * Devuelve false si no se pudo detener o volver a arrancar.
   */
  async function withExternalServerStopped(manager, serverId, action = async () => {}) {
    const server = getState().get('mcp').externalServers.find(item => item.id === serverId);
    const wasRunning = McpStatus.isRunning(server?.status);
    if (wasRunning && !await manager.runExternalServerAction(serverId, 'stop')) return false;
    let restarted = true;
    try {
      await action();
    } finally {
      if (wasRunning) restarted = await manager.runExternalServerAction(serverId, 'start');
    }
    return restarted;
  }

  const reconcileQueues = new WeakMap();

  /** Identificadores de servicios MCP externos requeridos por el entorno del proyecto activo. */
  function desiredExternalServers(appConfig = getConfig().getActive()) {
    const ids = Array.isArray(appConfig?.mcpServers) ? appConfig.mcpServers : [];
    const desired = ids.filter(id => typeof id === 'string' && id.trim()).map(id => id.trim());
    if (appConfig?.browser === 'playwright' && !desired.includes('playwright')) desired.push('playwright');
    return [...new Set(desired)];
  }

  /**
   * Concilia en serie los servicios externos en ejecución con el proyecto activo: detiene los que
   * sobran (incluido Playwright si se cambia a otro navegador) y arranca los habilitados que siguen
   * detenidos. Devuelve `{ started, stopped, failed }` con sus ids.
   */
  function reconcileProjectServers(manager, appConfig = getConfig().getActive(), servers = getState().get('mcp').externalServers) {
    const prev = reconcileQueues.get(manager) || Promise.resolve();
    const run = prev.catch(() => {}).then(async () => {
      const State = getState();
      const started = [];
      const stopped = [];
      const failed = [];
      if (State.get('mcp').status !== 'connected') return { started, stopped, failed };

      const desired = new Set(desiredExternalServers(appConfig));
      const initialServers = (servers || State.get('mcp').externalServers || []).slice(0, 50);

      for (const server of initialServers) {
        if (!server?.id || desired.has(server.id)) continue;
        if (!McpStatus.isRunning(server.status) && !McpStatus.isBusy(server.status)) continue;
        if (await manager.runExternalServerAction(server.id, 'stop')) stopped.push(server.id);
      }

      for (const serverId of desired) {
        const liveList = State.get('mcp').externalServers || [];
        const current = liveList.find(item => item?.id === serverId) || initialServers.find(item => item?.id === serverId);
        if (!current || !McpStatus.canStart(current.status)) continue;
        if (await manager.runExternalServerAction(serverId, 'start')) started.push(serverId);
        else failed.push(serverId);
      }

      return { started, stopped, failed };
    });
    reconcileQueues.set(manager, run);
    return run;
  }

  return {
    refreshExternalTools,
    startExternalServer,
    stopExternalServer,
    configureExternalServer,
    setExternalServerSecret,
    runExternalServerAction,
    withExternalServerStopped,
    reconcileProjectServers
  };
});
