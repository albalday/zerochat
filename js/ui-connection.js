/**
 * Panel de Conexión (icono de la cabecera de la barra lateral) y el diálogo de identificación. El panel
 * usa por defecto el servidor local de este equipo; sin él, guarda la URL de otro servidor y, si está
 * detrás de un proxy inverso, «Usar proxy» con su clave. Conectar lo aplica y prueba la conexión. El
 * diálogo pide el usuario y la contraseña de la cuenta del sistema que ejecuta zerochat.py cuando el
 * servidor responde 401 (sin token o caducado); la contraseña solo viaja en zerochat/login.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./utils.js'), require('./i18n.js'));
  } else {
    root.ChatUIConnection = factory(root.ChatUtils, root.ChatI18n);
  }
})(typeof self !== 'undefined' ? self : this, function (Utils, I18n) {
  'use strict';

  const { resolveDep, normalizeBackendUrl, setText } = Utils;
  const { t } = I18n;
  const getState = () => resolveDep('ChatState', './state.js');
  const getConfig = () => resolveDep('ChatConfig', './config-store.js');

  // Errores de zerochat/login: usuario o contraseña incorrectos, y demasiados intentos fallidos.
  const LOGIN_FAILED = -32001;
  const LOGIN_LOCKED = -32002;

  /** Mensaje para el usuario de un fallo de identificación. */
  function loginErrorMessage(error) {
    const code = error?.rpcError?.code;
    if (code === LOGIN_FAILED) return t('login_failed');
    if (code === LOGIN_LOCKED) return t('login_locked', { minutes: Math.max(1, Math.ceil((error.rpcError.data?.retryAfter || 0) / 60)) });
    return error?.message || String(error);
  }

  /**
   * Valida los campos de la sección: devuelve `{ config }` con los ajustes de conexión o `{ error }`.
   * Con la conexión local los datos del servidor remoto se guardan como estén, para recuperarlos al desactivarla.
   */
  function readConnectionForm({ local, url, useProxy, proxyKey }) {
    const backendUrl = normalizeBackendUrl(url);
    const key = proxyKey.trim();
    if (!local && !backendUrl) return { error: t('connection_invalid_url') };
    if (!local && useProxy && !key) return { error: t('connection_proxy_key_missing') };
    return { config: { localBackend: local, backendUrl: backendUrl || '', useProxy, proxyKey: key } };
  }

  /** Estado de la conexión con el servidor local en una línea: estado, destino y detalle. */
  function describeConnection(mcp) {
    const parts = [t(`mcp_status_${mcp.status}`), mcp.endpoint];
    if (mcp.status === 'connected' && mcp.serverInfo) parts.push(`${mcp.serverInfo.name} ${mcp.serverInfo.version || ''}`.trim(), `${mcp.latencyMs} ms`);
    else if (mcp.error) parts.push(mcp.error);
    return parts.join(' · ');
  }

  let els = null;
  let callbacks = null;

  const formValues = () => ({ local: els.local.checked, url: els.url.value, useProxy: els.useProxy.checked, proxyKey: els.proxyKey.value });

  /** La conexión local oculta los datos del servidor remoto; sin proxy, su clave. */
  function syncFields() {
    els.remoteFields.hidden = els.local.checked;
    els.proxyKeyField.hidden = !els.useProxy.checked;
  }

  /** Pinta los ajustes de conexión guardados. */
  function load(config) {
    els.local.checked = config.localBackend;
    els.url.value = config.backendUrl;
    els.useProxy.checked = config.useProxy;
    els.proxyKey.value = config.proxyKey;
    syncFields();
    setText(els.error, '');
  }

  /** Ajustes de conexión del formulario para Guardar; con un campo no válido muestra el error y devuelve null. */
  function read() {
    const { config, error } = readConnectionForm(formValues());
    setText(els.error, error || '');
    return config || null;
  }

  async function connect() {
    const config = read();
    if (!config) return;
    getConfig().updateRuntime(config);
    els.connect.disabled = true;
    try {
      await callbacks.connect();
    } finally {
      els.connect.disabled = false;
    }
  }

  function openLogin() {
    if (els.loginDialog.open) return;
    setText(els.loginDesc, t('login_desc', { url: getState().get('mcp').endpoint }));
    setText(els.loginError, '');
    els.loginPassword.value = '';
    els.loginDialog.showModal();
    (els.loginUser.value ? els.loginPassword : els.loginUser).focus();
  }

  async function submitLogin(event) {
    event.preventDefault();
    const user = els.loginUser.value.trim();
    const password = els.loginPassword.value;
    if (!user || !password) return;
    els.loginSubmit.disabled = true;
    setText(els.loginError, t('login_checking'));
    try {
      await callbacks.login(user, password);
      els.loginDialog.close();
    } catch (error) {
      setText(els.loginError, loginErrorMessage(error));
    } finally {
      els.loginPassword.value = '';
      els.loginSubmit.disabled = false;
    }
  }

  /**
   * Conecta la sección y el diálogo. `callbacks.connect()` conecta con el backend guardado y
   * `callbacks.login(user, password)` se identifica en el destino de la conexión y conecta.
   */
  function mount(elements, mountCallbacks) {
    els = elements;
    callbacks = mountCallbacks;
    els.local.addEventListener('change', syncFields);
    els.useProxy.addEventListener('change', syncFields);
    els.connect.addEventListener('click', connect);
    els.loginForm.addEventListener('submit', submitLogin);
    els.loginCancel.addEventListener('click', () => els.loginDialog.close());
    const State = getState();
    let lastStatus = State.get('mcp').status;
    const render = () => {
      const mcp = State.get('mcp');
      setText(els.status, describeConnection(mcp));
      // El punto del icono de la barra lateral muestra el estado sin abrir el panel.
      const label = t('btn_connection_status', { status: t(`mcp_status_${mcp.status}`) });
      els.openButton.dataset.status = mcp.status;
      els.openButton.title = label;
      els.openButton.setAttribute('aria-label', label);
    };
    State.subscribe('mcp', mcp => {
      render();
      // Se pide identificarse al pasar a login_required, no en cada latido que lo confirma.
      if (mcp.status === 'login_required' && lastStatus !== 'login_required') openLogin();
      lastStatus = mcp.status;
    });
    I18n.onChange(render);
    render();
  }

  return { loginErrorMessage, readConnectionForm, describeConnection, load, read, mount };
});
