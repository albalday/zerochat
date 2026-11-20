/**
 * Sección Navegador de los ajustes: la herramienta de navegación (configuración del cliente) y,
 * con Playwright MCP, su navegador (guardado en SQLite del servidor local): el propio de ZeroChat
 * con sus motores y sus datos, o el del usuario (Chrome, Edge o Chromium) mediante la extensión de Playwright.
 * Se organiza en tres zonas: el modelo (estado de la sección y consultas al estado MCP), la vista
 * (plantillas que pintan ese estado) y el controlador (acciones, peticiones al servidor local y
 * eventos delegados del montaje).
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./utils.js'), require('./i18n.js'), require('./icons.js'), require('./defaults.js'), require('./mcp-status.js'));
  } else {
    root.ChatUIBrowser = factory(root.ChatUtils, root.ChatI18n, root.ChatIcons, root.ChatDefaults, root.ChatMcpStatus);
  }
})(typeof self !== 'undefined' ? self : this, function (Utils, I18n, Icons, Defaults, McpStatus) {
  'use strict';

  const { resolveDep, escapeHtml } = Utils;
  const { t } = I18n;
  const getState = () => resolveDep('ChatState', './state.js');
  const getMCP = () => resolveDep('ChatMCP', './mcp.js');
  const getConfig = () => resolveDep('ChatConfig', './config-store.js');
  const getDialogs = () => resolveDep('ChatDialogs', './ui-dialogs.js');

  // ==========================================================================
  // 1. Modelo: estado y consultas
  // ==========================================================================

  const ENGINE_NAMES = { chromium: 'Chromium', firefox: 'Firefox', webkit: 'WebKit' };
  const { USER_BROWSERS } = Defaults;
  const ENGINE_WAIT_MS = 25000;
  const CONFIG_KEYS = ['mode', 'engine', 'userBrowser', 'headless', 'extensionToken'];
  // La extensión muestra el token como variable de entorno: se admite pegar la línea entera.
  const TOKEN_ENV_PREFIX = /^PLAYWRIGHT_MCP_EXTENSION_TOKEN\s*=\s*/;
  const TOKEN_PATTERN = /^[A-Za-z0-9_-]{0,256}$/;

  // Lo que muestra la sección: la herramienta y la configuración en edición, la guardada y los motores.
  let section = { tool: null, config: null, savedConfig: null, engines: null, notice: null };
  let waitAbort = null;
  // Fijados al montar: el contenedor que se pinta y cómo abrir otra sección de los ajustes.
  let container = null;
  let openSection = null;

  const request = (method, params = {}, options = {}) => getMCP().manager.requestExternalControl(method, params, options);
  const isConnected = () => getState().get('mcp').status === 'connected';
  const playwrightStatus = () => getState().get('mcp').externalServers.find(server => server.id === 'playwright')?.status || null;

  /** Playwright en el servidor local según el estado global de MCP: 'disconnected', 'loading', 'missing' o 'installed'. */
  function playwrightState() {
    if (!isConnected()) return 'disconnected';
    const installed = getMCP().playwrightInstalled();
    if (installed === null) return 'loading';
    return installed ? 'installed' : 'missing';
  }

  /** browser_action y Playwright MCP solo se eligen con Playwright instalado; mientras se consulta se respeta la elección. */
  function selectable(tool) {
    const state = playwrightState();
    if (tool === 'none' || state === 'loading') return true;
    return state === 'installed' && (tool !== 'browser_action' || getMCP().browserActionAvailable());
  }

  // Si no se puede elegir se muestra «Ninguna», pero se conserva la elección guardada para cuando se pueda.
  const shownTool = () => (selectable(section.tool) ? section.tool : 'none');
  const sameConfig = (a, b) => CONFIG_KEYS.every(key => a[key] === b[key]);
  const tokenValid = config => TOKEN_PATTERN.test(config.extensionToken);
  const normalizeExtensionToken = value => value.trim().replace(TOKEN_ENV_PREFIX, '').replace(/^(["'])(.*)\1$/, '$2').trim();

  /**
   * Qué hace Guardar en la sección según lo elegido y el estado de Playwright MCP en el servidor
   * (`status`, null sin conexión). La configuración del navegador solo se valida y se envía con
   * Playwright MCP elegido; un cambio con el servidor en marcha ofrece reiniciarlo. El arranque y la
   * parada de Playwright MCP los concilia `reconcileProjectServers`.
   */
  function getSavePlan({ tool, config, savedConfig }, status) {
    const plan = { tokenInvalid: false, setConfig: false, offerRestart: false };
    if (tool !== 'playwright') return plan;
    if (config && !tokenValid(config)) return { ...plan, tokenInvalid: true };
    const setConfig = Boolean(config && savedConfig) && !sameConfig(config, savedConfig);
    return {
      ...plan,
      setConfig,
      offerRestart: setConfig && McpStatus.isRunning(status)
    };
  }

  function getTool() {
    return section.tool ?? getConfig().getActive().browser;
  }

  // ==========================================================================
  // 2. Vista: plantillas y DOM
  // ==========================================================================

  const card = (selected, body) => `<div class="browser-card${selected ? ' is-selected' : ''}">${body}</div>`;
  const choice = (name, value, checked, title, hint, disabled = false) => `<label class="browser-choice">
      <input type="radio" name="${name}" value="${escapeHtml(value)}"${checked ? ' checked' : ''}${disabled ? ' disabled' : ''}>
      <span class="browser-choice-text"><strong>${escapeHtml(title)}</strong><span class="label-hint">${escapeHtml(hint)}</span></span>
    </label>`;
  const openMcpButton = () => `<button type="button" class="btn-secondary" data-browser-action="open-mcp">${escapeHtml(t('browser_open_mcp'))}</button>`;

  function renderEngine(engine) {
    const installing = engine.status === 'installing';
    const statusClass = installing ? 'status-starting' : (engine.status === 'error' ? 'status-error' : (engine.installed ? 'status-running' : 'status-stopped'));
    const statusText = installing ? t('browser_engine_installing', { percent: engine.percent || 0 })
      : t(engine.status === 'error' ? 'browser_engine_error' : (engine.installed ? 'browser_engine_installed' : 'browser_engine_missing'));
    const detail = installing && engine.download ? t('browser_engine_download', { name: engine.download }) : (engine.error || engine.title);
    const checked = section.config.engine === engine.id;
    const name = ENGINE_NAMES[engine.id];
    return `<div class="browser-row${checked ? ' is-selected' : ''}">
        <input type="radio" name="browser-engine" value="${escapeHtml(engine.id)}" aria-label="${escapeHtml(name)}"${checked ? ' checked' : ''}${engine.installed ? '' : ' disabled'}>
        <span class="browser-row-text"><strong>${escapeHtml(name)}</strong><span class="label-hint">${escapeHtml(detail)}</span></span>
        <span class="mcp-server-badge ${statusClass}" role="status">${escapeHtml(statusText)}</span>
        <button type="button" class="btn-secondary" data-browser-action="${engine.installed ? 'remove' : 'install'}" data-engine="${escapeHtml(engine.id)}"${installing ? ' disabled' : ''}>${escapeHtml(t(engine.installed ? 'browser_engine_remove' : 'browser_engine_install'))}</button>
      </div>`;
  }

  function renderOwnMode() {
    return `${choice('browser-mode', 'own', section.config.mode === 'own', t('browser_mode_own'), t('browser_mode_own_hint'))}
      <div class="browser-card-body">
        <span class="label-hint">${escapeHtml(t('browser_engines_hint'))}</span>${section.engines.engines.map(renderEngine).join('')}
        <div class="browser-row">
          <span class="browser-row-text"><strong>${escapeHtml(t('browser_data_title'))}</strong><span class="label-hint">${escapeHtml(t('browser_data_hint', { name: ENGINE_NAMES[section.config.engine] }))}</span></span>
          <button type="button" class="btn-secondary" data-browser-action="clear">${escapeHtml(t('browser_data_clear'))}</button>
        </div>
        <label class="browser-check"><input type="checkbox" name="browser-show-window"${section.config.headless ? '' : ' checked'}>${escapeHtml(t('browser_show_window'))}</label>
      </div>`;
  }

  function renderUserMode() {
    const detected = section.engines.systemBrowsers;
    const options = USER_BROWSERS.map(id => {
      const label = t(detected[id] ? `browser_user_${id}` : 'browser_user_not_found', { name: t(`browser_user_${id}`) });
      return `<option value="${id}"${section.config.userBrowser === id ? ' selected' : ''}${detected[id] ? '' : ' disabled'}>${escapeHtml(label)}</option>`;
    }).join('') + `<option value="firefox" disabled>${escapeHtml(t('browser_user_firefox'))}</option>`;
    const noneDetected = !USER_BROWSERS.some(id => detected[id]);
    const extensionInstalled = section.engines.extensions[section.config.userBrowser] === true;
    const extensionHelp = extensionInstalled ? ''
      : `<a href="${escapeHtml(t('browser_extension_help_href'))}" target="_blank" rel="noopener noreferrer">${escapeHtml(t('browser_extension_help'))}</a>`;
    const tokenError = tokenValid(section.config) ? ''
      : `<p id="browser-extension-token-error" class="server-query-status status-error" role="alert">${escapeHtml(t('browser_extension_token_invalid'))}</p>`;
    return `${choice('browser-mode', 'user', section.config.mode === 'user', t('browser_mode_user'), t('browser_mode_user_hint'))}
      <div class="browser-card-body">
        <div class="form-field">
          <label for="browser-user-browser"><strong>${escapeHtml(t('browser_user_browser'))}</strong><span class="label-hint">${escapeHtml(t(noneDetected ? 'browser_user_none' : 'browser_user_browser_hint'))}</span></label>
          <select id="browser-user-browser" name="browser-user-browser">${options}</select>
        </div>
        <div class="browser-row">
          <span class="browser-row-text"><strong>${escapeHtml(t('browser_extension_title'))}</strong><span class="label-hint">${escapeHtml(t(extensionInstalled ? 'browser_extension_installed' : 'browser_extension_hint'))}</span></span>
          ${extensionHelp}
        </div>
        <div class="form-field">
          <label for="browser-extension-token"><strong>${escapeHtml(t('browser_extension_token'))}</strong><span class="label-hint">${escapeHtml(t('browser_extension_token_hint'))}</span></label>
          <input type="password" id="browser-extension-token" name="browser-extension-token" value="${escapeHtml(section.config.extensionToken)}" autocomplete="new-password" spellcheck="false"${tokenValid(section.config) ? '' : ' aria-invalid="true" aria-describedby="browser-extension-token-error"'}>
          ${tokenError}
        </div>
        <p class="browser-warning">${Icons.get('alert-triangle', { size: 14 })}<span>${escapeHtml(t('browser_user_warning'))}</span></p>
      </div>`;
  }

  function renderPlaywright() {
    if (!section.config || !section.engines) return `<p class="label-hint">${escapeHtml(t('browser_loading'))}</p>`;
    return `<div class="browser-modes" role="radiogroup" aria-label="${escapeHtml(t('browser_mode_aria'))}">
        ${card(section.config.mode === 'own', renderOwnMode())}
        ${card(section.config.mode === 'user', renderUserMode())}
      </div>
      <p class="label-hint">${escapeHtml(t('browser_save_note'))}</p>`;
  }

  function render() {
    if (!container || section.tool === null) return;
    const shown = shownTool();
    const tools = Defaults.BROWSER_TOOLS.map(tool => {
      const unavailable = !selectable(tool);
      // Con Playwright instalado, browser_action aún necesita un Chromium con el que navegar.
      const hint = unavailable && tool === 'browser_action' && playwrightState() === 'installed' ? 'browser_tool_browser_action_unavailable' : `browser_tool_${tool}_hint`;
      return card(shown === tool, choice('browser-tool', tool, shown === tool, t(`browser_tool_${tool}`), t(hint), unavailable));
    }).join('');
    const missingKey = { disconnected: 'browser_needs_server', missing: 'browser_playwright_missing' }[playwrightState()];
    const missing = missingKey ? `<div class="browser-notice"><span>${escapeHtml(t(missingKey))}</span>${openMcpButton()}</div>` : '';
    const notice = section.notice ? `<p class="server-query-status status-${section.notice.type}" role="status">${escapeHtml(section.notice.text)}</p>` : '';
    container.innerHTML = `<div class="browser-section">
        <div class="browser-tools" role="radiogroup" aria-label="${escapeHtml(t('browser_tool_title'))}">
          <strong>${escapeHtml(t('browser_tool_title'))}</strong>
          <div class="browser-tool-grid">${tools}</div>
        </div>
        ${missing}
        ${notice}
        ${shown === 'playwright' ? renderPlaywright() : `<p class="label-hint">${escapeHtml(t(`browser_other_${shown}`))}</p>`}
      </div>`;
  }

  // ==========================================================================
  // 3. Controlador: acciones y eventos
  // ==========================================================================

  /** Consulta la lista de motores y sigue sus cambios por long-poll mientras alguno se esté instalando. */
  async function refreshEngines() {
    waitAbort?.abort();
    const abortController = new AbortController();
    waitAbort = abortController;
    try {
      section.engines = await request('zerochat/browser/engines/list', {}, { signal: abortController.signal });
      if (abortController.signal.aborted) return;
      if (section.engines?.config && !section.savedConfig) {
        section.savedConfig = section.engines.config;
        section.config = { ...section.engines.config };
      }
      render();
      while (!abortController.signal.aborted && section.engines?.engines?.some(engine => engine.status === 'installing')) {
        const startedAt = Date.now();
        const prevRev = section.engines.rev;
        const update = await request(
          'zerochat/browser/engines/list',
          { since_rev: prevRev, wait_ms: ENGINE_WAIT_MS, engines_only: true },
          { signal: abortController.signal, timeoutMs: ENGINE_WAIT_MS + 5000 }
        );
        if (abortController.signal.aborted) return;
        section.engines = { ...section.engines, ...update };
        render();
        if (update?.rev === prevRev && Date.now() - startedAt < 50) {
          await new Promise(resolve => { setTimeout(resolve, 500); });
        }
      }
    } catch (error) {
      if (!abortController.signal.aborted) throw error;
    } finally {
      if (waitAbort === abortController) waitAbort = null;
    }
  }

  /** Configuración guardada y motores: solo con Playwright instalado y con la sección abierta. */
  async function refreshServerData() {
    if (section.tool === null || playwrightState() !== 'installed') return;
    await refreshEngines();
  }

  function showError(error) {
    section.notice = { type: 'error', text: error?.message || String(error) };
    render();
  }

  /** Carga la sección al abrir los ajustes con la herramienta de navegación de la configuración. */
  function load(tool, { fetch = true } = {}) {
    waitAbort?.abort();
    section = { tool, config: null, savedConfig: null, engines: null, notice: null };
    render();
    if (fetch) refreshServerData().catch(showError);
  }

  function ensureLoaded() {
    if (!section.engines) refreshServerData().catch(showError);
  }

  async function handleAction(button) {
    const action = button.dataset.browserAction;
    if (action === 'open-mcp') {
      openSection('mcp');
      return;
    }
    const engine = button.dataset.engine || section.config.engine;
    const name = ENGINE_NAMES[engine];
    section.notice = null;
    try {
      if (action === 'install') {
        await request('zerochat/browser/engines/install', { engine });
        await refreshEngines();
      } else if (action === 'remove') {
        if (!await getDialogs().confirm(t('browser_engine_remove_confirm', { name }), { type: 'warning', acceptText: t('browser_engine_remove') })) return;
        await getMCP().manager.withExternalServerStopped('playwright', async () => {
          section.engines = await request('zerochat/browser/engines/remove', { engine });
          // El servidor pasa la configuración guardada a otro motor instalado.
          section.savedConfig = section.engines.config;
          if (section.config.engine === engine) section.config.engine = section.savedConfig.engine;
        });
        render();
      } else if (action === 'clear') {
        if (!await getDialogs().confirm(t('browser_data_clear_confirm', { name }), { type: 'warning', acceptText: t('browser_data_clear') })) return;
        await getMCP().manager.withExternalServerStopped('playwright', () => request('zerochat/browser/data/clear', { engine }));
        section.notice = { type: 'success', text: t('browser_data_cleared', { name }) };
        render();
      }
    } catch (error) {
      showError(error);
    }
  }

  function handleChange(target) {
    if (target.name === 'browser-tool') {
      section.tool = target.value;
    } else if (target.name === 'browser-mode') section.config.mode = target.value;
    else if (target.name === 'browser-engine') section.config.engine = target.value;
    else if (target.name === 'browser-user-browser') section.config.userBrowser = target.value;
    else if (target.name === 'browser-show-window') section.config.headless = !target.checked;
    else if (target.name === 'browser-extension-token') section.config.extensionToken = normalizeExtensionToken(target.value);
    else return;
    render();
  }

  function validate() {
    const plan = getSavePlan(section, isConnected() ? playwrightStatus() : null);
    if (!plan.tokenInvalid) return true;
    render();
    container.querySelector('#browser-extension-token')?.focus();
    return false;
  }

  /**
   * Guarda la configuración del navegador al guardar los ajustes; la herramienta la guarda la
   * configuración del cliente. Devuelve false si el token no es válido o el servidor rechaza la configuración.
   */
  async function save() {
    if (!validate()) return false;
    const manager = getMCP().manager;
    const plan = getSavePlan(section, isConnected() ? playwrightStatus() : null);
    if (plan.setConfig) {
      try {
        section.savedConfig = await request('zerochat/browser/config/set', { config: section.config });
      } catch (error) {
        showError(new Error(t('browser_save_error', { err: error?.message || String(error) })));
        return false;
      }
    }
    if (plan.offerRestart && await getDialogs().confirm(t('browser_restart_confirm'), {
      type: 'info', acceptText: t('browser_restart'), cancelText: t('browser_restart_later')
    })) {
      manager.withExternalServerStopped('playwright');
    }
    return true;
  }

  /**
   * Monta la sección: eventos delegados en su contenedor y repintado al cambiar conexión o idioma.
   * `onOpenSection(id)` abre otra sección de los ajustes.
   */
  function mountBrowserUI(element, onOpenSection) {
    container = element;
    openSection = onOpenSection;
    container.addEventListener('change', event => handleChange(event.target));
    container.addEventListener('click', event => {
      const button = event.target.closest('[data-browser-action]');
      if (button) handleAction(button);
    });
    // Se repinta al cambiar la conexión o Playwright; los datos de Playwright se piden al quedar instalado.
    const snapshot = () => `${playwrightState()}|${getMCP().browserActionAvailable()}`;
    let last = snapshot();
    getState().subscribe('mcp', () => {
      const next = snapshot();
      if (next === last) return;
      const installedNow = playwrightState() === 'installed' && !last.startsWith('installed|');
      last = next;
      render();
      if (installedNow) refreshServerData().catch(showError);
    });
    I18n.onChange(render);
  }

  return {
    getSavePlan, normalizeExtensionToken,
    load, ensureLoaded, getTool, validate, save, mountBrowserUI
  };
});
