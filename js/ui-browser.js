/**
 * Sección Navegador de los ajustes: la herramienta de navegación (configuración del cliente) y,
 * con Playwright MCP, su navegador (config/browser.json del servidor local): el propio de ZeroChat
 * con sus motores y sus datos, o el del usuario (Chrome, Edge o Chromium) mediante la extensión de Playwright.
 * Incluye también el capítulo Navegador del editor de perfiles. Se organiza en tres zonas: el modelo
 * (estado de la sección y del capítulo y consultas al estado MCP), la vista (plantillas que pintan ese
 * estado) y el controlador (acciones, peticiones al servidor local y eventos delegados del montaje).
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./utils.js'), require('./i18n.js'), require('./icons.js'), require('./defaults.js'));
  } else {
    root.ChatUIBrowser = factory(root.ChatUtils, root.ChatI18n, root.ChatIcons, root.ChatDefaults);
  }
})(typeof self !== 'undefined' ? self : this, function (Utils, I18n, Icons, Defaults) {
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
  const { USER_BROWSERS, PLAYWRIGHT_ENGINES } = Defaults;
  const ENGINE_POLL_MS = 1000;
  const CONFIG_KEYS = ['mode', 'engine', 'userBrowser', 'headless', 'extensionToken'];
  // La extensión muestra el token como variable de entorno: se admite pegar la línea entera.
  const TOKEN_ENV_PREFIX = /^PLAYWRIGHT_MCP_EXTENSION_TOKEN\s*=\s*/;
  const TOKEN_PATTERN = /^[A-Za-z0-9_-]{0,256}$/;

  // Lo que muestra la sección: la herramienta y la configuración en edición, la guardada y los motores.
  let section = { tool: null, savedTool: null, config: null, savedConfig: null, engines: null, notice: null };
  let pollTimer = null;
  // Capítulo Navegador del editor de perfiles: el perfil puede necesitar Playwright MCP con un navegador
  // instalado y, con el propio, su ventana visible; sin necesitarlo usa lo de Ajustes › Navegador.
  let profileChapter = { value: null, engines: null, disabled: false };
  // Fijados al montar: los contenedores que se pintan y cómo abrir otra sección de los ajustes.
  let container = null;
  let profileContainer = null;
  let openSection = null;

  const request = (method, params = {}) => getMCP().manager.requestExternalControl(method, params);
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
   * Playwright MCP elegido; un cambio con el servidor en marcha ofrece reiniciarlo y elegirlo de nuevo
   * lo arranca si está detenido.
   */
  function getSavePlan({ tool, savedTool, config, savedConfig }, status) {
    const plan = { tokenInvalid: false, setConfig: false, offerRestart: false, start: false };
    if (tool !== 'playwright') return plan;
    if (config && !tokenValid(config)) return { ...plan, tokenInvalid: true };
    const setConfig = Boolean(config && savedConfig) && !sameConfig(config, savedConfig);
    return {
      ...plan,
      setConfig,
      offerRestart: setConfig && status === 'running',
      start: savedTool !== 'playwright' && ['stopped', 'error'].includes(status)
    };
  }

  function getTool() {
    return section.tool ?? getConfig().getActive().browser;
  }

  /** Navegadores que se pueden exigir en cada modo: motores instalados o navegadores detectados; null sin servidor. */
  function installedChoices(mode) {
    const engines = profileChapter.engines;
    if (!engines) return null;
    if (mode === 'own') return engines.engines.filter(engine => engine.installed).map(engine => engine.id);
    return USER_BROWSERS.filter(id => engines.systemBrowsers[id]);
  }

  const choiceOf = (mode, id) => (mode === 'own' ? { mode, engine: id } : { mode, userBrowser: id });
  const idOf = choice => choice.engine || choice.userBrowser;

  /** Primer navegador que se puede exigir en el modo, o el predeterminado si no se sabe o no hay ninguno. */
  function defaultChoice(mode) {
    const installed = installedChoices(mode);
    return choiceOf(mode, installed?.[0] || (mode === 'own' ? PLAYWRIGHT_ENGINES[0] : USER_BROWSERS[0]));
  }

  const getProfileBrowser = () => (profileChapter.value ? { ...profileChapter.value } : null);

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

  /** Nombre de un navegador de Playwright MCP: «Chromium propio», «Chromium propio con ventana» o «tu Chrome». */
  function describeBrowser(choice) {
    if (choice.mode === 'user') return t('browser_choice_user', { name: t(`browser_user_${choice.userBrowser}`) });
    const own = t('browser_choice_own', { name: ENGINE_NAMES[choice.engine] });
    return choice.headless === false ? t('browser_choice_visible', { browser: own }) : own;
  }

  /** Aviso de que el perfil activo exige Playwright MCP, que manda sobre la herramienta elegida aquí. */
  function renderProfileRequirement() {
    const config = getConfig().getActive();
    if (!config.playwrightBrowser) return '';
    return `<p class="browser-notice">${escapeHtml(t('browser_profile_required', {
      profile: config.activeProfile?.name || '', browser: describeBrowser(config.playwrightBrowser)
    }))}</p>`;
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
        ${renderProfileRequirement()}
        ${notice}
        ${shown === 'playwright' ? renderPlaywright() : `<p class="label-hint">${escapeHtml(t(`browser_other_${shown}`))}</p>`}
      </div>`;
  }

  function renderProfileBrowser() {
    if (!profileContainer) return;
    const value = profileChapter.value;
    const disabled = profileChapter.disabled ? ' disabled' : '';
    let body = '';
    if (value) {
      const installed = installedChoices(value.mode);
      const ids = installed && installed.includes(idOf(value)) ? installed : [...(installed || []), idOf(value)];
      const missing = installed !== null && !installed.includes(idOf(value));
      const options = ids.map(id => {
        const label = value.mode === 'own' ? ENGINE_NAMES[id] : t(`browser_user_${id}`);
        const text = installed && !installed.includes(id) ? t('profile_browser_not_installed', { name: label }) : label;
        return `<option value="${escapeHtml(id)}"${id === idOf(value) ? ' selected' : ''}>${escapeHtml(text)}</option>`;
      }).join('');
      const modes = ['own', 'user'].map(mode => `<label class="browser-check"><input type="radio" name="profile-browser-mode" value="${mode}"${value.mode === mode ? ' checked' : ''}${disabled}>${escapeHtml(t(`browser_mode_${mode}`))}</label>`).join('');
      body = `<div class="browser-card-body">
          <div role="radiogroup" aria-label="${escapeHtml(t('browser_mode_aria'))}">${modes}</div>
          <div class="form-field">
            <label for="profile-browser-name"><strong>${escapeHtml(t('profile_browser_name'))}</strong></label>
            <select id="profile-browser-name" name="profile-browser-name"${disabled}>${options}</select>
          </div>
          ${value.mode === 'own' ? `<label class="browser-check"><input type="checkbox" name="profile-browser-show-window"${value.headless === false ? ' checked' : ''}${disabled}>${escapeHtml(t('browser_show_window'))}</label>` : ''}
          ${installed === null ? `<p class="label-hint">${escapeHtml(t('profile_browser_disconnected'))}</p>` : ''}
          ${missing ? `<p class="browser-warning">${Icons.get('alert-triangle', { size: 14 })}<span>${escapeHtml(t('profile_browser_missing'))}</span></p>` : ''}
        </div>`;
    }
    profileContainer.innerHTML = `<p class="label-hint">${escapeHtml(t('profile_browser_hint'))}</p>
      <label class="browser-choice"><input type="checkbox" name="profile-browser-required"${value ? ' checked' : ''}${disabled}><span class="browser-choice-text"><strong>${escapeHtml(t('profile_browser_required'))}</strong><span class="label-hint">${escapeHtml(t('profile_browser_required_hint'))}</span></span></label>
      ${body}
      <p class="label-hint">${escapeHtml(t('profile_browser_settings'))}</p>`;
  }

  const profileBrowserSummary = () => (profileChapter.value
    ? t('profile_summary_browser_required', { browser: describeBrowser(profileChapter.value) })
    : t('profile_summary_browser_settings'));

  // ==========================================================================
  // 3. Controlador: acciones y eventos
  // ==========================================================================

  /** Consulta la lista de motores y la repite mientras alguno se esté instalando. */
  async function refreshEngines() {
    clearTimeout(pollTimer);
    section.engines = await request('zerochat/browser/engines/list');
    render();
    if (section.engines.engines.some(engine => engine.status === 'installing')) {
      pollTimer = setTimeout(() => refreshEngines().catch(showError), ENGINE_POLL_MS);
    }
  }

  /** Configuración guardada y motores: solo con Playwright instalado, que es cuando se muestran. */
  async function refreshServerData() {
    if (playwrightState() !== 'installed') return;
    const saved = await request('zerochat/browser/config/get');
    section.savedConfig = saved;
    section.config = { ...saved };
    await refreshEngines();
  }

  function showError(error) {
    section.notice = { type: 'error', text: error?.message || String(error) };
    render();
  }

  /** Carga la sección al abrir los ajustes con la herramienta de navegación de la configuración. */
  function load(tool) {
    section = { tool, savedTool: tool, config: null, savedConfig: null, engines: null, notice: null };
    render();
    refreshServerData().catch(showError);
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
          section.savedConfig = await request('zerochat/browser/config/get');
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

  /**
   * Guarda la configuración del navegador al guardar los ajustes; la herramienta la guarda la
   * configuración del cliente. Devuelve false si el token no es válido o el servidor rechaza la configuración.
   */
  async function save() {
    const manager = getMCP().manager;
    const plan = getSavePlan(section, isConnected() ? playwrightStatus() : null);
    if (plan.tokenInvalid) {
      render();
      container.querySelector('#browser-extension-token')?.focus();
      return false;
    }
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
    // Arrancado al elegirlo, queda recordado para la siguiente sesión.
    if (plan.start) manager.runExternalServerAction('playwright', 'start');
    section.savedTool = section.tool;
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

  function handleProfileBrowserChange(target) {
    if (target.name === 'profile-browser-required') profileChapter.value = target.checked ? defaultChoice('own') : null;
    else if (target.name === 'profile-browser-mode') profileChapter.value = defaultChoice(target.value);
    else if (target.name === 'profile-browser-name') {
      // Al cambiar de motor se conserva la ventana visible.
      const visible = profileChapter.value.headless === false ? { headless: false } : {};
      profileChapter.value = { ...choiceOf(profileChapter.value.mode, target.value), ...visible };
    }
    else if (target.name === 'profile-browser-show-window') {
      const { headless, ...rest } = profileChapter.value;
      profileChapter.value = target.checked ? { ...rest, headless: false } : rest;
    }
    else return;
    renderProfileBrowser();
  }

  /** Muestra el navegador que exige el perfil y pide al servidor local los navegadores instalados. */
  function loadProfileBrowser(value) {
    profileChapter = { value: value ? { ...value } : null, engines: null, disabled: profileChapter.disabled };
    renderProfileBrowser();
    if (!isConnected()) return;
    request('zerochat/browser/engines/list').then(engines => {
      profileChapter.engines = engines;
      renderProfileBrowser();
    }).catch(error => console.warn('[UIBrowser] Could not list the browsers for the profile:', error));
  }

  /** Perfil bloqueado o de solo lectura: el capítulo se muestra sin poder cambiarlo. */
  function setProfileBrowserDisabled(disabled) {
    if (profileChapter.disabled === disabled) return;
    profileChapter.disabled = disabled;
    renderProfileBrowser();
  }

  function mountProfileBrowser(element) {
    profileContainer = element;
    profileContainer.addEventListener('change', event => handleProfileBrowserChange(event.target));
    I18n.onChange(renderProfileBrowser);
  }

  return {
    getSavePlan, normalizeExtensionToken,
    load, getTool, save, mountBrowserUI,
    loadProfileBrowser, getProfileBrowser, profileBrowserSummary, setProfileBrowserDisabled, mountProfileBrowser
  };
});
