/**
 * UI for the local ZeroChat MCP host. External MCP products are discovered
 * through the downloaded host; this bundle contains no product recipe or
 * process implementation.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') module.exports = factory(require('./utils.js'), require('./i18n.js'), require('./icons.js'));
  else root.ChatUIMcp = factory(root.ChatUtils, root.ChatI18n, root.ChatIcons);
})(typeof self !== 'undefined' ? self : this, function (Utils, I18n, Icons) {
  'use strict';

  const { resolveDep, escapeHtml, clearElement, appendTextElement, copyToClipboard } = Utils;
  const { t } = I18n;
  const getState = () => resolveDep('ChatState', './state.js');
  const getMCP = () => resolveDep('ChatMCP', './mcp.js');
  const getConfig = () => resolveDep('ChatConfig', './config-store.js');
  const getSecurity = () => resolveDep('ChatToolSecurity', './tool-security.js').manager;
  const getDialogs = () => resolveDep('ChatDialogs', './ui-dialogs.js');
  const getAgentCore = () => resolveDep('ChatAgentCore', './agent-core.js');

  const UNIX_TERMINAL_COMMAND = 'pip install zerochat\nzerochat';
  // En Windows, `zerochat` suele no estar en el PATH y PowerShell 5 no admite `&&`; el lanzador py funciona siempre.
  const WINDOWS_TERMINAL_COMMAND = 'py -m pip install zerochat\npy -m zerochat';

  function isWindowsPlatform(nav = navigator) {
    const platform = nav.userAgentData?.platform || nav.platform || '';
    return /^win/i.test(platform) || /Windows NT/.test(nav.userAgent || '');
  }

  function generateTerminalCommand(nav) {
    return isWindowsPlatform(nav) ? WINDOWS_TERMINAL_COMMAND : UNIX_TERMINAL_COMMAND;
  }

  function isBrowserActionActive(enabledTools, browserTool) {
    return enabledTools.browser_action !== false && Boolean(browserTool) && browserTool.available !== false;
  }

  function isBrowserActionCurrentlyActive() {
    const browserTool = getState().get('mcp').tools.find(tool => tool.name === 'browser_action');
    return isBrowserActionActive(getConfig().getActive().enabledTools, browserTool);
  }

  function getAllMcpTools(state) {
    return [...state.tools, ...state.externalTools];
  }

  /** Herramientas de la sesión conectada; vacío sin conexión. */
  function getConnectedTools() {
    const state = getState().get('mcp');
    return state.status === 'connected' ? getAllMcpTools(state) : [];
  }

  /** Texto en el idioma de la interfaz de un campo bilingüe de service.json. */
  function localized(value, language) {
    return value && typeof value === 'object' ? value[language] || value.es || value.en : value;
  }

  // `help` is the standard optional service.json field shown on an MCP card.
  // Keep arbitrary schemes out of an HTML attribute even though the value is escaped.
  function getServiceHelp(help, language) {
    if (!help || typeof help !== 'object') return null;
    const rawUrl = typeof help.url === 'string' ? help.url.trim() : '';
    const isHttpUrl = /^https?:\/\//i.test(rawUrl);
    const isSafeRelativeUrl = /^(?!\/\/)[a-zA-Z0-9][a-zA-Z0-9._~!$&'()*+,;=@\/?#%-]*$/.test(rawUrl);
    if (!isHttpUrl && !isSafeRelativeUrl) return null;
    const label = localized(help.label, language) || t('mcp_external_help');
    if (typeof label !== 'string' || !label.trim()) return null;
    return { url: rawUrl, label: label.trim() };
  }

  function getServiceName(server, language) {
    return String(localized(server.displayName, language) || server.id || '');
  }

  function updateToolEnabledState(toolId, enabled) {
    const Config = getConfig();
    try {
      Config.updateRuntime({ enabledTools: { ...Config.getActive().enabledTools, [toolId]: enabled } });
      return true;
    } catch (error) {
      console.error('[MCP UI] Error updating enabled tool state:', error);
      return false;
    }
  }

  function copyCommandToClipboard(text, button) {
    return copyToClipboard(text, button, `${Icons.get('check', { size: 14 })} <span>${escapeHtml(t('mcp_cmd_copied'))}</span>`);
  }

  const policyClass = policy => `status-${policy === 'allow' ? 'allowed' : (policy === 'deny' ? 'denied' : 'ask')}`;

  function renderToolAuthorization(tool, serverName, originalName) {
    const security = getSecurity();
    const allowed = escapeHtml(t('mcp_security_badge_allowed'));
    if (security.getGlobalMcpPolicy() === 'allow_all') {
      return `<span class="mcp-auth-badge status-allowed" title="${escapeHtml(t('mcp_security_policy_allow_all'))}">${allowed} (Global)</span>`;
    }
    const policy = security.getToolPolicy(tool.name) || 'ask';
    const serverId = tool.metadata.mcpServerId;
    if (serverId && security.getServerPolicy(serverId) === 'allow' && policy === 'ask') {
      return `<span class="mcp-auth-badge status-allowed" title="${escapeHtml(t('mcp_security_trusted_server'))}">${allowed} (${escapeHtml(t('mcp_security_badge_server'))})</span>`;
    }
    const constraints = security.getToolConstraints(tool.name);
    const constrained = Boolean(constraints?.command) && policy === 'allow';
    const selectTitle = escapeHtml(t('mcp_security_select_title'));
    const option = (value, label) => `<option value="${value}"${policy === value ? ' selected' : ''}>${label}</option>`;
    return `
      <select class="mcp-auth-select ${policyClass(policy)}" data-tool-id="${escapeHtml(tool.name)}" data-server-name="${escapeHtml(serverName)}" data-orig-name="${escapeHtml(originalName)}" title="${selectTitle}" aria-label="${selectTitle}">
        ${option('ask', escapeHtml(t('mcp_security_badge_ask')))}
        ${option('allow', `${allowed}${constrained ? ` (${escapeHtml(t('mcp_security_constrained'))})` : ''}`)}
        ${option('deny', escapeHtml(t('tool_auth_denied_badge')))}
      </select>`;
  }

  function renderToolsList(container, tools, enabledTools) {
    if (tools.length === 0) {
      const msg = getState().get('mcp').status === 'connected' ? t('mcp_tools_empty_connected') : t('mcp_tools_empty_disconnected');
      container.innerHTML = `<div class="mcp-tools-empty">${Icons.get('plug', { size: 24 })}<p>${escapeHtml(msg)}</p></div>`;
      return;
    }

    const plug16 = Icons.get('plug', { size: 16 });
    const badgeText = escapeHtml(t('mcp_tool_badge'));
    const AgentCore = getAgentCore();
    const items = tools.map(tool => {
      const isChecked = tool.available !== false && AgentCore.isToolEnabled(enabledTools, tool.name);
      const schema = tool.inputSchema || {};
      const required = Array.isArray(schema.required) ? schema.required : [];
      const paramsHint = Object.entries(schema.properties || {})
        .map(([key, value]) => `${key}${required.includes(key) ? '' : '?'}: ${value.type || 'any'}`).join(', ');
      const serverName = tool.metadata.mcpServerName || '';
      const originalName = tool.metadata.originalName || tool.name;
      return `
        <div class="mcp-tool-card" data-tool-id="${escapeHtml(tool.name)}">
          <div class="mcp-tool-info">
            <div class="mcp-tool-title-row">
              <span class="mcp-tool-icon">${plug16}</span>
              <span class="mcp-tool-name">${escapeHtml(tool.name)}</span>
              <span class="mcp-tool-badge">${badgeText}</span>
              ${renderToolAuthorization(tool, serverName, originalName)}
            </div>
            <p class="mcp-tool-desc">${escapeHtml(tool.description || '')}</p>
            ${paramsHint ? `<div class="mcp-tool-params"><code>${escapeHtml(paramsHint)}</code></div>` : ''}
          </div>
          <div class="mcp-tool-action">
            <label class="switch">
              <input type="checkbox" class="agent-tool-checkbox mcp-tool-checkbox" data-tool-id="${escapeHtml(tool.name)}" ${isChecked ? 'checked' : ''}>
              <span class="slider"></span>
            </label>
          </div>
        </div>`;
    }).join('');

    container.innerHTML = `
      <div class="mcp-tools-header">
        <div class="mcp-tools-title">${Icons.get('terminal', { size: 16 })}<span data-i18n="mcp_tools_section_title">${escapeHtml(t('mcp_tools_section_title'))}</span></div>
        <span class="mcp-tools-counter">${escapeHtml(t('mcp_tools_count', { count: tools.length }))}</span>
      </div>
      <div class="mcp-tools-list">${items}</div>`;

    container.querySelectorAll('.mcp-auth-select').forEach(select => {
      select.addEventListener('change', () => {
        const toolId = select.getAttribute('data-tool-id');
        const policy = select.value;
        if (policy === 'ask') {
          getSecurity().revokeToolPolicy(toolId);
        } else {
          getSecurity().setToolPolicy(toolId, policy, {
            serverName: select.getAttribute('data-server-name'),
            originalName: select.getAttribute('data-orig-name')
          });
        }
        select.className = `mcp-auth-select ${policyClass(policy)}`;
        renderSavedAuthorizations();
      });
    });

    container.querySelectorAll('.mcp-tool-checkbox').forEach(checkbox => {
      checkbox.addEventListener('change', async () => {
        const toolId = checkbox.getAttribute('data-tool-id');
        if (toolId === 'browser_action' && checkbox.checked) {
          let availability = { available: false };
          try {
            availability = await getMCP().manager.requestExternalControl('tools/availability', { name: 'browser_action' });
          } catch (error) { /* sin respuesta del servidor: se considera no disponible */ }
          if (!availability.available) {
            checkbox.checked = false;
            await getDialogs().alert(t('browser_action_requirements_notice'), { type: 'info' });
            return;
          }
        }
        updateToolEnabledState(toolId, checkbox.checked);
      });
    });
  }

  function renderServerOptions(server, language) {
    const options = (server.options || []).filter(option => option.type === 'boolean');
    if (options.length === 0) return '';
    return `<div class="mcp-server-options">${options.map(option => {
      const description = localized(option.description, language);
      const value = server.userOptions && option.id in server.userOptions ? server.userOptions[option.id] : option.default;
      return `
        <div class="mcp-server-option-row">
          <label class="switch switch-sm">
            <input type="checkbox" class="mcp-server-option-checkbox" data-server-id="${escapeHtml(server.id)}" data-option-id="${escapeHtml(option.id)}" ${value ? 'checked' : ''}>
            <span class="slider round"></span>
          </label>
          <div class="mcp-server-option-meta">
            <span class="mcp-server-option-label">${escapeHtml(localized(option.label, language) || option.id)}</span>
            ${description ? `<span class="label-hint">${escapeHtml(description)}</span>` : ''}
          </div>
        </div>`;
    }).join('')}</div>`;
  }

  function renderServer(server, language, browserActionActive) {
    const isRunning = server.status === 'running';
    const isBusy = server.status === 'starting' || server.status === 'installing';
    const statusClass = isRunning ? 'status-running' : (isBusy ? 'status-starting' : (server.status === 'error' ? 'status-error' : 'status-stopped'));
    const statusLabel = t(`mcp_external_status_${server.status || 'stopped'}`);
    const startLabel = server.status === 'starting' && server.startWait
      ? t('mcp_external_start_wait_attempt', server.startWait)
      : (isBusy ? statusLabel : t('mcp_btn_start_server'));
    const description = localized(server.description, language) || '';
    const help = getServiceHelp(server.help, language);
    const remote = server.remote?.type === 'mcp-remote' ? server.remote : null;
    let remoteEndpoint = '';
    try {
      const endpoint = new URL(remote?.url);
      remoteEndpoint = endpoint.protocol === 'https:' ? endpoint.host : '';
    } catch (_) { /* URL remota ausente o inválida: no se muestra el endpoint */ }
    const trusted = getSecurity().getServerPolicy(server.id) === 'allow';
    const trustText = escapeHtml(t(trusted ? 'mcp_security_trusted_server' : 'mcp_security_trust_server'));
    const id = escapeHtml(server.id);

    return `
      <div class="mcp-server-item" data-server-id="${id}">
        <div class="mcp-server-info">
          <div class="mcp-server-title-row">
            <strong class="mcp-server-name">${escapeHtml(getServiceName(server, language))}</strong>
            <span class="mcp-server-badge ${statusClass}" role="status" aria-live="polite">${escapeHtml(statusLabel)}</span>
            ${server.toolCount ? `<span class="mcp-server-tool-count">${escapeHtml(t('mcp_servers_count_tools', { count: server.toolCount }))}</span>` : ''}
          </div>
          ${description ? `<p class="mcp-server-desc">${escapeHtml(description)}</p>` : ''}
          ${remote ? `<p class="mcp-server-remote"><span class="mcp-server-remote-badge">${escapeHtml(t('mcp_remote_transport'))}</span>${remoteEndpoint ? ` <span>${escapeHtml(remoteEndpoint)}</span>` : ''}</p>` : ''}
          ${help ? `<p class="mcp-server-help"><a href="${escapeHtml(help.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(help.label)}</a></p>` : ''}
          ${server.id === 'playwright' ? `<p class="mcp-server-replacement-notice">${escapeHtml(t(browserActionActive ? 'mcp_playwright_browser_action_active' : 'mcp_playwright_browser_action_inactive'))}</p>` : ''}
          ${server.error ? `<div class="mcp-server-error"><p>${escapeHtml(server.error)}</p><a href="help/mcp.html" target="_blank" rel="noopener noreferrer">${escapeHtml(t('mcp_external_help'))}</a></div>` : ''}
          ${server.oauthUrl ? `<div class="mcp-server-oauth-banner"><p class="mcp-server-oauth-msg">${escapeHtml(t('mcp_oauth_required_msg'))}</p><a class="btn-secondary btn-mcp-oauth-open" href="${escapeHtml(server.oauthUrl)}" target="_blank" rel="noopener noreferrer" data-server-id="${id}">${escapeHtml(t('mcp_btn_oauth_authorize'))}</a></div>` : ''}
          ${renderServerOptions(server, language)}
        </div>
        <div class="mcp-server-actions">
          <button type="button" class="btn-mcp-server-trust${trusted ? ' active' : ''}" data-server-id="${id}" title="${trustText}">
            ${Icons.get('shield', { size: 12 })} <span>${trustText}</span>
          </button>
          <button type="button" class="btn-mcp-server-toggle ${isRunning ? 'btn-danger-outline' : 'btn-secondary'}" data-server-id="${id}" data-action="${isRunning ? 'stop' : 'start'}" ${isBusy ? 'disabled aria-busy="true"' : ''}>
            ${escapeHtml(isRunning ? t('mcp_btn_stop_server') : startLabel)}
          </button>
        </div>
      </div>`;
  }

  function renderExternalServers(container, servers) {
    if (servers.length === 0) {
      container.innerHTML = `<div class="mcp-servers-empty label-hint">${escapeHtml(t('mcp_servers_empty'))}</div>`;
      return;
    }
    const language = I18n.getLanguage();
    const browserActionActive = isBrowserActionCurrentlyActive();
    container.innerHTML = servers.map(server => renderServer(server, language, browserActionActive)).join('');

    container.querySelectorAll('.btn-mcp-server-trust').forEach(button => {
      button.addEventListener('click', () => {
        const serverId = button.getAttribute('data-server-id');
        if (getSecurity().getServerPolicy(serverId) === 'allow') getSecurity().revokeServerPolicy(serverId);
        else getSecurity().setServerPolicy(serverId, 'allow', { serverName: serverId });
        renderExternalServers(container, servers);
        renderSavedAuthorizations();
      });
    });

    container.querySelectorAll('.mcp-server-option-checkbox').forEach(checkbox => {
      checkbox.addEventListener('change', async () => {
        const manager = getMCP().manager;
        checkbox.disabled = true;
        try {
          await manager.configureExternalServer(checkbox.getAttribute('data-server-id'), { [checkbox.getAttribute('data-option-id')]: checkbox.checked });
          getState().set('mcp', { externalServers: (await manager.fetchExternalServers()).servers });
        } catch (error) {
          console.error('[MCP UI] Error configuring server option:', error);
          checkbox.checked = !checkbox.checked;
        } finally {
          checkbox.disabled = false;
        }
      });
    });

    container.querySelectorAll('.btn-mcp-server-toggle').forEach(button => {
      button.addEventListener('click', () => runExternalServerAction(
        button.getAttribute('data-server-id'), button.getAttribute('data-action'), { browserActionActive, button }));
    });
  }

  function updateExternalServerState(serverId, changes) {
    getState().set('mcp', current => ({
      ...current,
      externalServers: current.externalServers.map(server => (server.id === serverId ? { ...server, ...changes } : server))
    }));
  }

  /**
   * Inicia o detiene un servicio MCP gestionado reflejando el progreso en su tarjeta.
   * Devuelve true si la acción terminó correctamente.
   */
  async function runExternalServerAction(serverId, action, { browserActionActive = false, button = null } = {}) {
    let browserActionDisabled = false;
    if (serverId === 'playwright' && action === 'start' && browserActionActive) {
      const accepted = await getDialogs().confirm(t('mcp_playwright_replacement_confirm'), {
        type: 'warning',
        title: t('mcp_playwright_replacement_title'),
        acceptText: t('mcp_playwright_replacement_accept'),
        cancelText: t('notice_cancel')
      });
      if (!accepted) return false;
      browserActionDisabled = updateToolEnabledState('browser_action', false);
      if (!browserActionDisabled) {
        await getDialogs().alert(t('mcp_external_action_error'), { type: 'error' });
        return false;
      }
    }
    const pendingStatus = action === 'start' ? 'starting' : 'stopped';
    if (button) {
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      button.textContent = t(`mcp_external_status_${pendingStatus}`);
    }
    updateExternalServerState(serverId, { status: pendingStatus, error: null, startWait: null, oauthUrl: null });
    let didAutoOpenOAuth = false;
    const reportStartWait = (attempt, total, status = 'starting', serverData = null) => {
      const oauthUrl = serverData?.oauthUrl || null;
      if (oauthUrl && !didAutoOpenOAuth) {
        didAutoOpenOAuth = true;
        window.open(oauthUrl, '_blank');
      }
      updateExternalServerState(serverId, { status, ...(oauthUrl ? { oauthUrl } : {}), error: null, startWait: { attempt, total } });
    };
    const manager = getMCP().manager;
    try {
      if (action === 'start') await manager.startExternalServer(serverId, reportStartWait);
      else await manager.stopExternalServer(serverId);
      return true;
    } catch (error) {
      const stillPending = action === 'start' && (error.code === 'EXTERNAL_START_WAIT_TIMEOUT' ||
        (error.code === 'EXTERNAL_START_STATUS_UNAVAILABLE' && !error.externalServer));
      if (!error.code?.startsWith('EXTERNAL_START_')) console.error(`[MCP UI] Error trying to ${action} external server:`, error);
      updateExternalServerState(serverId, {
        status: error.externalServer?.status || (stillPending ? 'starting' : (action === 'start' ? 'stopped' : 'running')),
        startWait: null,
        error: t(stillPending ? 'mcp_external_start_wait_timeout' : 'mcp_external_action_error'),
        ...(error.externalServer?.oauthUrl ? { oauthUrl: error.externalServer.oauthUrl } : {})
      });
      if (browserActionDisabled && !stillPending) updateToolEnabledState('browser_action', true);
      return false;
    } finally {
      if (button) {
        button.disabled = false;
        button.removeAttribute('aria-busy');
      }
    }
  }

  /**
   * Ofrece iniciar los servicios activos en la sesión anterior que siguen detenidos.
   * El usuario puede quitar de la lista los que no quiera iniciar.
   */
  async function offerStoppedExternalServices(servers) {
    const language = I18n.getLanguage();
    const items = servers
      .filter(server => server?.enabled === true && server.status === 'stopped' && typeof server.id === 'string' && server.id)
      .slice(0, 50)
      .map(server => ({ id: server.id, label: getServiceName(server, language) }));
    if (items.length === 0) return [];
    const Dialogs = getDialogs();
    const selected = await Dialogs.confirm(t('mcp_external_restore_message'), {
      type: 'info',
      title: t('mcp_external_restore_title'),
      acceptText: t('mcp_btn_start_server'),
      cancelText: t('mcp_external_restore_skip'),
      items
    });
    if (!Array.isArray(selected) || selected.length === 0) return [];
    const failed = [];
    for (const id of selected) {
      const current = getState().get('mcp').externalServers.find(server => server.id === id);
      // El usuario pudo iniciarlo desde Ajustes mientras el diálogo seguía abierto.
      if (current?.status !== 'stopped') continue;
      const ok = await runExternalServerAction(id, 'start', { browserActionActive: isBrowserActionCurrentlyActive() });
      if (!ok) failed.push(items.find(item => item.id === id).label);
    }
    if (failed.length > 0) {
      await Dialogs.alert(t('mcp_external_restore_failed', { names: failed.join(', ') }), { type: 'error' });
    }
    return selected;
  }

  function renderConnectionStatus(elements, state) {
    const status = state.status;
    const isConnected = status === 'connected';

    elements.statusBadge.className = `mcp-status-badge mcp-status-${status}`;
    elements.statusText.setAttribute('data-i18n', `mcp_status_${status}`);
    elements.statusText.textContent = t(`mcp_status_${status}`);

    elements.serverDetails.hidden = !isConnected;
    clearElement(elements.serverDetails);
    if (isConnected) {
      const version = state.serverInfo?.version ? ` v${state.serverInfo.version}` : '';
      const latency = Number(state.latencyMs) > 0 ? ` · ${state.latencyMs}ms` : '';
      const count = getAllMcpTools(state).length;
      elements.serverDetails.title = `${state.serverInfo?.name || 'zerochat'}${version}${latency}`;
      appendTextElement(elements.serverDetails, 'span', count > 0 ? t('mcp_tools_discovered', { count }) : t('mcp_no_tools'), { className: 'mcp-detail-item' });
    }

    elements.bootstrapCard.hidden = isConnected;
    elements.reconnectHint.hidden = status !== 'disconnected';
    elements.reconnectHint.setAttribute('data-i18n', 'mcp_reconnect_after_restart');
    elements.reconnectHint.textContent = t('mcp_reconnect_after_restart');
    elements.commandSnippet.textContent = generateTerminalCommand();
    renderCurrentToolsList(elements);
    renderExternalServers(elements.serversList, isConnected ? state.externalServers : []);
  }

  function renderSavedAuthorizations() {
    const container = document.getElementById('mcp-saved-auths-list');
    const btnClear = document.getElementById('btn-mcp-clear-auths');
    const security = getSecurity();
    const tools = security.listAuthorizedTools();
    const servers = security.listAuthorizedServers();

    if (tools.length === 0 && servers.length === 0) {
      container.innerHTML = `<div class="mcp-no-auths-msg label-hint">${escapeHtml(t('mcp_security_no_saved_auths'))}</div>`;
      btnClear.hidden = true;
      return;
    }
    btnClear.hidden = false;

    const trashIcon = Icons.get('trash', { size: 12 });
    const revokeLabel = escapeHtml(t('mcp_security_btn_revoke'));
    const badge = item => {
      const allowed = item.policy === 'allow';
      return { className: allowed ? 'status-allowed' : 'status-denied', text: escapeHtml(t(allowed ? 'mcp_security_badge_allowed' : 'tool_auth_denied_badge')) };
    };
    const scopeBadge = item => (item.scope === 'session' ? `<span class="mcp-auth-scope-badge">${escapeHtml(t('mcp_security_scope_session'))}</span>` : '');

    const serverItems = servers.map(item => {
      const { className, text } = badge(item);
      const serverId = escapeHtml(item.serverId);
      return `
        <div class="mcp-auth-item" data-server-id="${serverId}">
          <button type="button" class="btn-revoke-server-auth" data-server-id="${serverId}" title="${revokeLabel}" aria-label="${revokeLabel}">${trashIcon}</button>
          <div class="mcp-auth-item-info">
            <span class="mcp-auth-server-icon">${Icons.get('server', { size: 12 })}</span>
            <strong class="mcp-auth-item-name">${escapeHtml(item.serverName || item.serverId)}</strong>
            <span class="mcp-auth-badge ${className}">${text} (${escapeHtml(t('mcp_security_badge_server'))})</span>
            ${scopeBadge(item)}
          </div>
        </div>`;
    });

    const toolItems = tools.map(item => {
      const { className } = badge(item);
      let { text } = badge(item);
      const parts = [];
      const prefixes = [...new Set((item.constraints?.command?.allowedPrefixes || []).map(prefix => String(prefix).trim()).filter(Boolean))];
      if (prefixes.length) parts.push(prefixes.map(prefix => `${prefix} *`).join(', '));
      if (parts.length) text += ` (${escapeHtml(t('mcp_security_constrained'))})`;
      const constraint = escapeHtml(parts.join(' | '));
      const toolId = escapeHtml(item.toolId);
      return `
        <div class="mcp-auth-item" data-tool-id="${toolId}">
          <button type="button" class="btn-revoke-auth" data-tool-id="${toolId}" title="${revokeLabel}" aria-label="${revokeLabel}">${trashIcon}</button>
          <div class="mcp-auth-item-info">
            <strong class="mcp-auth-item-name">${escapeHtml(item.originalName || item.toolId)}</strong>
            <span class="mcp-auth-badge ${className}">${text}</span>
            ${scopeBadge(item)}
            ${parts.length ? `<span class="mcp-auth-constraint-tag" title="${constraint}">${constraint}</span>` : ''}
          </div>
        </div>`;
    });

    container.innerHTML = serverItems.join('') + toolItems.join('');
    // Revocar re-renderiza los ajustes MCP a través de la suscripción a ChatToolSecurity.
    container.querySelectorAll('.btn-revoke-auth').forEach(button => {
      button.addEventListener('click', () => security.revokeToolPolicy(button.getAttribute('data-tool-id')));
    });
    container.querySelectorAll('.btn-revoke-server-auth').forEach(button => {
      button.addEventListener('click', () => security.revokeServerPolicy(button.getAttribute('data-server-id')));
    });
  }

  function renderCurrentToolsList(elements) {
    renderToolsList(elements.toolsContainer, getConnectedTools(), getConfig().getActive().enabledTools);
  }

  function syncSecurityControls(elements) {
    const security = getSecurity();
    const policy = security.getGlobalMcpPolicy();
    const radios = { ask: 'mcp-policy-ask', workspace_trust: 'mcp-policy-workspace-trust', allow_all: 'mcp-policy-allow-all' };
    for (const [value, id] of Object.entries(radios)) {
      const radio = document.getElementById(id);
      radio.checked = policy === value;
      if (radio.dataset.mcpBound) continue;
      radio.dataset.mcpBound = 'true';
      radio.addEventListener('change', () => {
        if (radio.checked) security.setGlobalMcpPolicy(value);
      });
    }

    const rulesInput = document.getElementById('mcp-directory-rules');
    const rulesError = document.getElementById('mcp-directory-rules-error');
    if (document.activeElement !== rulesInput) rulesInput.value = security.getDirectoryRules().join('\n');
    if (!rulesInput.dataset.mcpBound) {
      rulesInput.dataset.mcpBound = 'true';
      const onRulesChange = () => {
        try {
          security.setDirectoryRules(rulesInput.value.split(/\r?\n/).map(rule => rule.trim()).filter(Boolean));
          rulesError.textContent = '';
        } catch (err) {
          rulesError.textContent = err.message || t('mcp_directory_rules_invalid');
        }
      };
      rulesInput.addEventListener('change', onRulesChange);
      rulesInput.addEventListener('input', onRulesChange);
    }

    const btnClearAuths = document.getElementById('btn-mcp-clear-auths');
    if (!btnClearAuths.dataset.mcpBound) {
      btnClearAuths.dataset.mcpBound = 'true';
      btnClearAuths.addEventListener('click', () => security.clearAllAuthorizations());
    }

    renderSavedAuthorizations();
    renderCurrentToolsList(elements);
  }

  function initMcpUI(elements) {
    const State = getState();
    const render = () => renderConnectionStatus(elements, State.get('mcp'));
    const unsubscribeSecurity = getSecurity().subscribe(() => syncSecurityControls(elements));
    elements.btnCopyCmd.addEventListener('click', () => copyCommandToClipboard(generateTerminalCommand(), elements.btnCopyCmd));
    const unsubscribeState = State.subscribe('mcp', state => renderConnectionStatus(elements, state));
    render();
    syncSecurityControls(elements);

    const unsubscribeLanguage = I18n.onChange(() => {
      render();
      renderSavedAuthorizations();
      if (State.get('mcp').status === 'connected') {
        getMCP().manager.syncExternalServers().catch(error => console.warn('[MCP UI] syncExternalServers failed:', error));
      }
    });

    return {
      destroy: () => {
        unsubscribeState();
        unsubscribeSecurity();
        unsubscribeLanguage();
      }
    };
  }

  function verifyActiveConnection() {
    return getMCP().manager.verifyProxyConnection({ timeoutMs: 1500 });
  }

  return {
    generateTerminalCommand,
    isBrowserActionActive,
    getAllMcpTools,
    getServiceHelp,
    copyCommandToClipboard,
    renderConnectionStatus,
    renderToolsList,
    renderCurrentToolsList,
    renderExternalServers,
    renderSavedAuthorizations,
    runExternalServerAction,
    offerStoppedExternalServices,
    syncSecurityControls,
    initMcpUI,
    verifyActiveConnection
  };
});
