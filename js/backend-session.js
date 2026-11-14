/**
 * Sesión con el backend local (zerochat.py): adopta el fragmento de arranque con que zerochat.py abre la
 * página, resuelve el destino configurado (servidor local o remoto, con la clave del proxy si lo usa),
 * conecta con el token guardado de ese destino, se identifica cuando el servidor lo pide y guarda la
 * sesión: en la cookie del mismo origen o, en la pestaña de una ejecución (--prompt), solo en memoria.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./utils.js'));
  } else {
    root.ChatBackendSession = factory(root.ChatUtils);
  }
}(typeof self !== 'undefined' ? self : this, function (Utils) {
  'use strict';

  const { resolveDep, readLaunchFragment, normalizeConnectionSettings } = Utils;
  const getStorage = () => resolveDep('ChatStorage', './storage.js');
  const getConfig = () => resolveDep('ChatConfig', './config-store.js');
  const getDefaults = () => resolveDep('ChatDefaults', './defaults.js');
  const getMcpManager = () => resolveDep('ChatMCP', './mcp.js').manager;
  const getToolSecurity = () => resolveDep('ChatToolSecurity', './tool-security.js').manager;

  const LOCAL_HOSTS = ['127.0.0.1', 'localhost'];

  /**
   * Sesión del fragmento de arranque: null sin token; si no, `{ session, run }`. zerochat.py abre la
   * página con un servidor de este equipo, así que `session` es null si el fragmento apunta a otro.
   */
  function parseLaunchSession(hash) {
    const params = readLaunchFragment(hash);
    const token = params.get('token');
    if (!token) return null;
    const host = params.get('host');
    const port = Number(params.get('port'));
    const local = LOCAL_HOSTS.includes(host) && Number.isInteger(port) && port > 0 && port < 65536;
    return {
      session: local ? getStorage().normalizeBackendSession({ token, url: `http://${host}:${port}` }) : null,
      run: params.has('run')
    };
  }

  /** Destino de una configuración: el servidor local (`localUrl`) o el remoto, con la clave del proxy si lo usa. */
  function connectionTarget(config, localUrl) {
    const settings = normalizeConnectionSettings(config);
    if (settings.localBackend) return { url: localUrl, proxyKey: null };
    return { url: settings.backendUrl, proxyKey: settings.useProxy ? settings.proxyKey : null };
  }

  /**
   * Conexión de una sesión guardada: su URL y su token, con la clave del proxy solo si la sesión es del
   * destino configurado. Null sin sesión.
   */
  function sessionConnection(session, config, localUrl) {
    if (!session) return null;
    const target = connectionTarget(config, localUrl);
    return { url: session.url, token: session.token, proxyKey: session.url === target.url ? target.proxyKey : null };
  }

  /** Destino de la conexión configurada en esta página. */
  function configuredTarget() {
    return connectionTarget(getConfig().getActive(), getDefaults().LOCAL_BACKEND_URL);
  }

  /**
   * Sesión de esta página. `loadSessions` recarga la lista de conversaciones tras conectar, porque el
   * servidor también guarda conversaciones.
   */
  function create({ loadSessions }) {
    // El servidor de --prompt puede estar en otro puerto y termina con la ejecución: su conexión queda
    // en esta página y la cookie sigue apuntando las demás pestañas al servidor normal.
    let runSession = null;

    // El fragmento se usa exclusivamente para el primer arranque desde zerochat.py.
    // Después la sesión se resuelve mediante una cookie del mismo origen.
    function adoptLaunchFragment() {
      const launch = parseLaunchSession(location.hash);
      if (!launch) return;
      if (launch.run) {
        runSession = launch.session;
      } else if (launch.session && !getStorage().setBackendSession(launch.session)) {
        console.warn('[BackendSession] Could not persist the initial backend session.');
      }
      history.replaceState(null, '', location.pathname + location.search);
    }

    /** Guarda la sesión: en la pestaña de una ejecución solo en memoria, para no pisar la cookie de las demás. */
    function save(session) {
      if (runSession) runSession = session;
      else if (!getStorage().setBackendSession(session)) console.warn('[BackendSession] Could not persist the backend session.');
    }

    /**
     * Conecta al arrancar si hay sesión guardada (sin ella no sondea el equipo, para no disparar el
     * aviso de acceso a la red local del navegador); devuelve el resultado de la conexión.
     */
    function connectStartup() {
      adoptLaunchFragment();
      const connection = sessionConnection(runSession || getStorage().getBackendSession(), getConfig().getActive(), getDefaults().LOCAL_BACKEND_URL);
      if (!connection) return Promise.resolve({ success: false });
      getToolSecurity().setSessionToken(connection.token);
      return getMcpManager().connectProxy(connection).then(async result => {
        if (result.success) await loadSessions();
        return result;
      }).catch(error => {
        console.warn('[BackendSession] Could not connect to the local server on startup:', error);
        return { success: false };
      });
    }

    /** Conecta con el destino configurado, con el token de la sesión si es de esa URL; un 401 pide identificarse. */
    async function connectConfigured() {
      const target = configuredTarget();
      const session = getStorage().getBackendSession();
      const token = session?.url === target.url ? session.token : null;
      const mcp = getMcpManager();
      mcp.setSessionToken(token);
      if (token) getToolSecurity().setSessionToken(token);
      const result = await mcp.connectProxy({ ...target, token });
      await loadSessions();
      return result;
    }

    /** Se identifica en el destino de la conexión, guarda el token diario en la sesión y conecta con él. */
    async function login(user, password) {
      const mcp = getMcpManager();
      const { url, proxyKey } = mcp.target;
      const token = await mcp.login(user, password);
      save({ token, url });
      getToolSecurity().setSessionToken(token);
      const result = await mcp.connectProxy({ url, proxyKey, token });
      await loadSessions();
      return result;
    }

    return { connectStartup, connectConfigured, login };
  }

  return { parseLaunchSession, connectionTarget, sessionConnection, create };
}));
