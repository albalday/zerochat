/**
 * Sección Navegador de los ajustes: la herramienta de navegación (configuración del cliente) y,
 * con Playwright MCP, su navegador (config/browser.json del servidor local): el propio de ZeroChat
 * con sus motores y sus datos, o el del usuario mediante la extensión de Playwright.
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
  const getUIMcp = () => resolveDep('ChatUIMcp', './ui-mcp.js');
  const getDialogs = () => resolveDep('ChatDialogs', './ui-dialogs.js');

  const ENGINE_NAMES = { chromium: 'Chromium', firefox: 'Firefox', webkit: 'WebKit' };
  const USER_BROWSERS = ['chrome', 'msedge'];
  const ENGINE_POLL_MS = 1000;
  const CONFIG_KEYS = ['mode', 'engine', 'userBrowser', 'headless'];

  let container = null;
  // Lo que muestra la sección: la herramienta y la configuración en edición, la guardada y los motores.
  let view = { tool: null, savedTool: null, config: null, savedConfig: null, engines: null, notice: null };
  let pollTimer = null;
  let openSection = null;

  const request = (method, params = {}) => getMCP().manager.requestExternalControl(method, params);
  const isConnected = () => getState().get('mcp').status === 'connected';
  const playwrightStatus = () => getState().get('mcp').externalServers.find(server => server.id === 'playwright')?.status || null;
  const sameConfig = (a, b) => CONFIG_KEYS.every(key => a[key] === b[key]);

  const card = (selected, body) => `<div class="browser-card${selected ? ' is-selected' : ''}">${body}</div>`;
  const choice = (name, value, checked, title, hint) => `<label class="browser-choice">
      <input type="radio" name="${name}" value="${escapeHtml(value)}"${checked ? ' checked' : ''}>
      <span class="browser-choice-text"><strong>${escapeHtml(title)}</strong><span class="label-hint">${escapeHtml(hint)}</span></span>
    </label>`;
  const openMcpButton = () => `<button type="button" class="btn-secondary" data-browser-action="open-mcp">${escapeHtml(t('browser_open_mcp'))}</button>`;

  function renderEngine(engine) {
    const installing = engine.status === 'installing';
    const statusClass = installing ? 'status-starting' : (engine.status === 'error' ? 'status-error' : (engine.installed ? 'status-running' : 'status-stopped'));
    const statusText = installing ? t('browser_engine_installing', { percent: engine.percent || 0 })
      : t(engine.status === 'error' ? 'browser_engine_error' : (engine.installed ? 'browser_engine_installed' : 'browser_engine_missing'));
    const detail = installing && engine.download ? t('browser_engine_download', { name: engine.download }) : (engine.error || engine.title);
    const checked = view.config.engine === engine.id;
    const name = ENGINE_NAMES[engine.id];
    return `<div class="browser-row${checked ? ' is-selected' : ''}">
        <input type="radio" name="browser-engine" value="${escapeHtml(engine.id)}" aria-label="${escapeHtml(name)}"${checked ? ' checked' : ''}${engine.installed ? '' : ' disabled'}>
        <span class="browser-row-text"><strong>${escapeHtml(name)}</strong><span class="label-hint">${escapeHtml(detail)}</span></span>
        <span class="mcp-server-badge ${statusClass}" role="status">${escapeHtml(statusText)}</span>
        <button type="button" class="btn-secondary" data-browser-action="${engine.installed ? 'remove' : 'install'}" data-engine="${escapeHtml(engine.id)}"${installing ? ' disabled' : ''}>${escapeHtml(t(engine.installed ? 'browser_engine_remove' : 'browser_engine_install'))}</button>
      </div>`;
  }

  function renderOwnMode() {
    const engines = view.engines;
    const enginesHtml = engines.available
      ? `<span class="label-hint">${escapeHtml(t('browser_engines_hint'))}</span>${engines.engines.map(renderEngine).join('')}`
      : `<div class="browser-notice"><span>${escapeHtml(t('browser_playwright_missing'))}</span>${openMcpButton()}</div>`;
    return `${choice('browser-mode', 'own', view.config.mode === 'own', t('browser_mode_own'), t('browser_mode_own_hint'))}
      <div class="browser-card-body">
        ${enginesHtml}
        <div class="browser-row">
          <span class="browser-row-text"><strong>${escapeHtml(t('browser_data_title'))}</strong><span class="label-hint">${escapeHtml(t('browser_data_hint', { name: ENGINE_NAMES[view.config.engine] }))}</span></span>
          <button type="button" class="btn-secondary" data-browser-action="clear">${escapeHtml(t('browser_data_clear'))}</button>
        </div>
        <label class="browser-check"><input type="checkbox" name="browser-show-window"${view.config.headless ? '' : ' checked'}>${escapeHtml(t('browser_show_window'))}</label>
      </div>`;
  }

  function renderUserMode() {
    const detected = view.engines.systemBrowsers;
    const options = USER_BROWSERS.map(id => {
      const label = t(detected[id] ? `browser_user_${id}` : 'browser_user_not_found', { name: t(`browser_user_${id}`) });
      return `<option value="${id}"${view.config.userBrowser === id ? ' selected' : ''}${detected[id] ? '' : ' disabled'}>${escapeHtml(label)}</option>`;
    }).join('') + `<option value="firefox" disabled>${escapeHtml(t('browser_user_firefox'))}</option>`;
    const noneDetected = !USER_BROWSERS.some(id => detected[id]);
    return `${choice('browser-mode', 'user', view.config.mode === 'user', t('browser_mode_user'), t('browser_mode_user_hint'))}
      <div class="browser-card-body">
        <div class="form-field">
          <label for="browser-user-browser"><strong>${escapeHtml(t('browser_user_browser'))}</strong><span class="label-hint">${escapeHtml(t(noneDetected ? 'browser_user_none' : 'browser_user_browser_hint'))}</span></label>
          <select id="browser-user-browser" name="browser-user-browser">${options}</select>
        </div>
        <div class="browser-row">
          <span class="browser-row-text"><strong>${escapeHtml(t('browser_extension_title'))}</strong><span class="label-hint">${escapeHtml(t('browser_extension_hint'))}</span></span>
          <a href="${escapeHtml(t('browser_extension_help_href'))}" target="_blank" rel="noopener noreferrer">${escapeHtml(t('browser_extension_help'))}</a>
        </div>
        <p class="browser-warning">${Icons.get('alert-triangle', { size: 14 })}<span>${escapeHtml(t('browser_user_warning'))}</span></p>
      </div>`;
  }

  function renderPlaywright() {
    if (!isConnected()) return `<div class="browser-notice"><span>${escapeHtml(t('browser_needs_server'))}</span>${openMcpButton()}</div>`;
    if (!view.config || !view.engines) return `<p class="label-hint">${escapeHtml(t('browser_loading'))}</p>`;
    return `<div class="browser-modes" role="radiogroup" aria-label="${escapeHtml(t('browser_mode_aria'))}">
        ${card(view.config.mode === 'own', renderOwnMode())}
        ${card(view.config.mode === 'user', renderUserMode())}
      </div>
      <p class="label-hint">${escapeHtml(t('browser_save_note'))}</p>`;
  }

  function render() {
    if (!container || view.tool === null) return;
    const tools = Defaults.BROWSER_TOOLS.map(tool => card(view.tool === tool,
      choice('browser-tool', tool, view.tool === tool, t(`browser_tool_${tool}`), t(`browser_tool_${tool}_hint`)))).join('');
    const notice = view.notice ? `<p class="server-query-status status-${view.notice.type}" role="status">${escapeHtml(view.notice.text)}</p>` : '';
    container.innerHTML = `<div class="browser-section">
        <div class="browser-tools" role="radiogroup" aria-label="${escapeHtml(t('browser_tool_title'))}">
          <strong>${escapeHtml(t('browser_tool_title'))}</strong>
          <div class="browser-tool-grid">${tools}</div>
        </div>
        ${notice}
        ${view.tool === 'playwright' ? renderPlaywright() : `<p class="label-hint">${escapeHtml(t(`browser_other_${view.tool}`))}</p>`}
      </div>`;
  }

  /** Consulta la lista de motores y la repite mientras alguno se esté instalando. */
  async function refreshEngines() {
    clearTimeout(pollTimer);
    view.engines = await request('zerochat/browser/engines/list');
    render();
    if (view.engines.engines.some(engine => engine.status === 'installing')) {
      pollTimer = setTimeout(() => refreshEngines().catch(showError), ENGINE_POLL_MS);
    }
  }

  /** Configuración guardada y motores: solo se piden cuando se muestran las opciones de Playwright. */
  async function refreshServerData() {
    if (!isConnected() || view.tool !== 'playwright') return;
    const saved = await request('zerochat/browser/config/get');
    view.savedConfig = saved;
    view.config = { ...saved };
    await refreshEngines();
  }

  function showError(error) {
    view.notice = { type: 'error', text: error?.message || String(error) };
    render();
  }

  /** Carga la sección al abrir los ajustes con la herramienta de navegación de la configuración. */
  function load(tool) {
    view = { tool, savedTool: tool, config: null, savedConfig: null, engines: null, notice: null };
    render();
    refreshServerData().catch(showError);
  }

  function getTool() {
    return view.tool ?? getConfig().getActive().browser;
  }

  /** Ejecuta `action` con Playwright MCP detenido y lo vuelve a arrancar si estaba en marcha. */
  async function withPlaywrightStopped(action) {
    const UIMcp = getUIMcp();
    const wasRunning = playwrightStatus() === 'running';
    if (wasRunning && !await UIMcp.runExternalServerAction('playwright', 'stop')) return;
    try {
      await action();
    } finally {
      if (wasRunning) UIMcp.runExternalServerAction('playwright', 'start');
    }
  }

  async function handleAction(button) {
    const action = button.dataset.browserAction;
    if (action === 'open-mcp') {
      openSection('mcp');
      return;
    }
    const engine = button.dataset.engine || view.config.engine;
    const name = ENGINE_NAMES[engine];
    view.notice = null;
    try {
      if (action === 'install') {
        await request('zerochat/browser/engines/install', { engine });
        await refreshEngines();
      } else if (action === 'remove') {
        if (!await getDialogs().confirm(t('browser_engine_remove_confirm', { name }), { type: 'warning', acceptText: t('browser_engine_remove') })) return;
        await withPlaywrightStopped(async () => {
          view.engines = await request('zerochat/browser/engines/remove', { engine });
          // El servidor pasa la configuración guardada a otro motor instalado.
          view.savedConfig = await request('zerochat/browser/config/get');
          if (view.config.engine === engine) view.config.engine = view.savedConfig.engine;
        });
        render();
      } else if (action === 'clear') {
        if (!await getDialogs().confirm(t('browser_data_clear_confirm', { name }), { type: 'warning', acceptText: t('browser_data_clear') })) return;
        await withPlaywrightStopped(() => request('zerochat/browser/data/clear', { engine }));
        view.notice = { type: 'success', text: t('browser_data_cleared', { name }) };
        render();
      }
    } catch (error) {
      showError(error);
    }
  }

  function handleChange(target) {
    if (target.name === 'browser-tool') {
      view.tool = target.value;
      if (!view.config) refreshServerData().catch(showError);
    } else if (target.name === 'browser-mode') view.config.mode = target.value;
    else if (target.name === 'browser-engine') view.config.engine = target.value;
    else if (target.name === 'browser-user-browser') view.config.userBrowser = target.value;
    else if (target.name === 'browser-show-window') view.config.headless = !target.checked;
    else return;
    render();
  }

  /**
   * Guarda la configuración del navegador al guardar los ajustes; la herramienta la guarda la
   * configuración del cliente. Devuelve false si el servidor rechaza la configuración.
   */
  async function save() {
    const UIMcp = getUIMcp();
    const status = isConnected() ? playwrightStatus() : null;
    if (view.config && view.savedConfig && !sameConfig(view.config, view.savedConfig)) {
      try {
        view.savedConfig = await request('zerochat/browser/config/set', { config: view.config });
      } catch (error) {
        showError(new Error(t('browser_save_error', { err: error?.message || String(error) })));
        return false;
      }
      if (status === 'running' && await getDialogs().confirm(t('browser_restart_confirm'), {
        type: 'info', acceptText: t('browser_restart'), cancelText: t('browser_restart_later')
      })) {
        UIMcp.runExternalServerAction('playwright', 'stop').then(ok => ok && UIMcp.runExternalServerAction('playwright', 'start'));
      }
    }
    // Al elegir Playwright MCP se arranca si está detenido; queda recordado para la siguiente sesión.
    if (view.tool === 'playwright' && view.savedTool !== 'playwright' && ['stopped', 'error'].includes(status)) {
      UIMcp.runExternalServerAction('playwright', 'start');
    }
    view.savedTool = view.tool;
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
    let wasConnected = isConnected();
    getState().subscribe('mcp', () => {
      if (isConnected() === wasConnected) return;
      wasConnected = isConnected();
      if (wasConnected) refreshServerData().catch(showError);
      else render();
    });
    I18n.onChange(render);
  }

  return { load, getTool, save, mountBrowserUI };
});
