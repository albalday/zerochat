/**
 * Ciclo de vida de los servicios MCP externos gestionados por el servidor local:
 * registro de herramientas, arranque con polling por fases y OAuth, parada y configuración.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./utils.js'), require('./i18n.js'), require('./mcp-status.js'));
  } else {
    root.ChatMcpExternal = factory(root.ChatUtils, root.ChatI18n, root.ChatMcpStatus);
  }
})(typeof self !== 'undefined' ? self : this, function (Utils, I18n, McpStatus) {
  'use strict';

  const { resolveDep } = Utils;

  const PLAYWRIGHT_SERVER_ID = 'playwright';
  const EXTERNAL_START_POLL_ATTEMPTS = 10;
  const EXTERNAL_START_POLL_INTERVAL_MS = 15000;
  // Cubre los límites del backend (npm install y descarga del navegador, 600 s cada uno)
  // y la espera de la autorización OAuth.
  const EXTERNAL_LONG_START_POLL_ATTEMPTS = 80;

  const getAgentCore = () => resolveDep('ChatAgentCore', './agent-core.js');
  const getState = () => resolveDep('ChatState', './state.js');
  const getConfig = () => resolveDep('ChatConfig', './config-store.js');

  /** Cambia en ChatState los campos de un servicio externo; su tarjeta en Ajustes › MCP los pinta. */
  function updateExternalServerState(serverId, changes) {
    getState().set('mcp', current => ({
      ...current,
      externalServers: current.externalServers.map(server => (server.id === serverId ? { ...server, ...changes } : server))
    }));
  }

  /** El Playwright MCP en marcha usa otro navegador o almacenamiento del que exige el perfil, o no muestra la ventana que pide. */
  function usesOtherBrowser(server, required) {
    return server.id === PLAYWRIGHT_SERVER_ID && Boolean(required) && McpStatus.isRunning(server.status)
      && (server.browser?.mode !== required.mode || server.browser.engine !== required.engine || server.browser.userBrowser !== required.userBrowser
        || (server.browser.storage || '') !== (required.storage || '')
        || (required.headless === false && server.browser.headless !== false));
  }

  /** Vuelve a registrar las herramientas de los servicios externos, o las retira si no hay ninguno en marcha. */
  async function refreshExternalTools(manager, anyRunning, { externalId, proxyId, McpClient }) {
    manager.dropClient(externalId);
    let tools = [];
    const control = manager.clients.get(proxyId);
    if (anyRunning && control) {
      const client = new McpClient({
        id: externalId,
        name: 'ZeroChat External MCP Host',
        url: `${control.url}/mcp/external`,
        token: manager.sessionToken,
        headers: control.headers
      });
      try {
        tools = await manager.registerClient(client);
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
  async function startExternalServer(manager, serverId, onWait, { remember, browser = null }) {
    let result = null;
    try {
      result = await manager.requestExternalControl('zerochat/external/servers/start', { serverId, remember, ...(browser ? { browser } : {}) });
    } catch (error) {
      // El timeout inicial no implica fallo: el backend puede estar aún
      // iniciando el servicio (p. ej. esperando la autorización OAuth).
      if (error.name !== 'AbortError' && error.code !== 'MCP_REQUEST_TIMEOUT') throw error;
    }
    if (result) {
      await manager.applyLiveState(result);
      return result;
    }
    // Cada fase (installing, starting) dispone de su propio presupuesto de esperas.
    let phase = null;
    let attempt = 0;
    for (;;) {
      let status;
      try {
        status = await manager.readLiveState();
      } catch (cause) {
        const error = new Error('Unable to check MCP startup status.', { cause });
        error.code = 'EXTERNAL_START_STATUS_UNAVAILABLE';
        throw error;
      }
      const server = (status?.servers || []).find(item => item?.id === serverId);
      if (McpStatus.isRunning(server?.status)) return status;
      if (!McpStatus.isBusy(server?.status)) {
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

  /**
   * Inicia o detiene un servicio externo y refleja el progreso en ChatState. Playwright MCP arranca
   * con el navegador que exija el perfil activo, y la autorización OAuth que pida el arranque se abre
   * una vez en otra pestaña. Devuelve true si la acción terminó correctamente.
   */
  async function runExternalServerAction(manager, serverId, action, { remember = true } = {}) {
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
      const browser = serverId === PLAYWRIGHT_SERVER_ID ? getConfig().getActive().playwrightBrowser : null;
      if (action === 'start') await manager.startExternalServer(serverId, reportStartWait, { remember, ...(browser ? { browser } : {}) });
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
   * Ejecuta `action` con el servicio detenido y lo vuelve a arrancar si estaba en marcha, sin cambiar
   * si queda recordado para la siguiente sesión (detenerlo lo desmarca). Devuelve false si no se pudo
   * detener o volver a arrancar.
   */
  async function withExternalServerStopped(manager, serverId, action = async () => {}) {
    const server = getState().get('mcp').externalServers.find(item => item.id === serverId);
    const wasRunning = McpStatus.isRunning(server?.status);
    const remember = server?.enabled === true;
    if (wasRunning && !await manager.runExternalServerAction(serverId, 'stop')) return false;
    let restarted = true;
    try {
      await action();
    } finally {
      if (wasRunning) restarted = await manager.runExternalServerAction(serverId, 'start', { remember });
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
  async function startProfileServers(manager, appConfig) {
    const State = getState();
    const started = [];
    const unavailable = [];
    if (State.get('mcp').status !== 'connected') return { started, unavailable };
    const ids = getAgentCore().activeBrowserTool(appConfig) === 'playwright' ? [...appConfig.mcpServers, PLAYWRIGHT_SERVER_ID] : appConfig.mcpServers;
    for (const id of ids) {
      const server = State.get('mcp').externalServers.find(item => item.id === id);
      if (!server) {
        unavailable.push(id);
        continue;
      }
      if (usesOtherBrowser(server, appConfig.playwrightBrowser)) {
        (await manager.withExternalServerStopped(id) ? started : unavailable).push(id);
        continue;
      }
      if (McpStatus.isActive(server.status)) continue;
      (await manager.runExternalServerAction(id, 'start', { remember: false }) ? started : unavailable).push(id);
    }
    return { started, unavailable };
  }

  return {
    refreshExternalTools,
    startExternalServer,
    stopExternalServer,
    configureExternalServer,
    runExternalServerAction,
    withExternalServerStopped,
    startProfileServers
  };
});
