/**
 * UI for the local ZeroChat MCP host. External MCP products are discovered
 * through the downloaded host; this bundle contains no product recipe or
 * process implementation.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') module.exports = factory(require('./utils.js'), require('./i18n.js'), require('./icons.js'), require('./mcp-status.js'));
  else root.ChatUIMcp = factory(root.ChatUtils, root.ChatI18n, root.ChatIcons, root.ChatMcpStatus);
})(typeof self !== 'undefined' ? self : this, function (Utils, I18n, Icons, McpStatus) {
  'use strict';

  const { resolveDep, escapeHtml, clearElement, appendTextElement, copyToClipboard, setText } = Utils;
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
  let cachedElements = null;

  function isWindowsPlatform(nav = navigator) {
    const platform = nav.userAgentData?.platform || nav.platform || '';
    return /^win/i.test(platform) || /Windows NT/.test(nav.userAgent || '');
  }

  function generateTerminalCommand(nav) {
    return isWindowsPlatform(nav) ? WINDOWS_TERMINAL_COMMAND : UNIX_TERMINAL_COMMAND;
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

  async function updateToolEnabledState(checkbox) {
    const toolId = checkbox.getAttribute('data-tool-id');
    const enabled = Boolean(checkbox.checked);
    const Config = getConfig();
    const previous = { ...Config.getActive().enabledTools };
    const enabledTools = { ...previous, [toolId]: enabled };
    try {
      Config.updateRuntime({ enabledTools });
      await getMCP()?.manager?.saveProjectEnvironment?.({ enabledTools });
      return true;
    } catch (error) {
      console.warn('[MCP UI] Error updating enabled tool state:', error);
      Config.updateRuntime({ enabledTools: previous });
      checkbox.checked = !enabled;
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
    if (security.getAllowAll()) {
      return `<span class="mcp-auth-badge status-allowed" title="${escapeHtml(t('mcp_security_allow_all'))}">${allowed} (${escapeHtml(t('mcp_security_badge_project'))})</span>`;
    }
    const policy = security.getToolPolicy(tool.name) || 'ask';
    const serverId = tool.metadata.mcpServerId;
    if (serverId && security.getServerPolicy(serverId) === 'allow' && policy === 'ask') {
      return `<span class="mcp-auth-badge status-allowed" title="${escapeHtml(t('mcp_security_trusted_server'))}">${allowed} (${escapeHtml(t('mcp_security_badge_server'))})</span>`;
    }
    // run_command solo se permite siempre con patrones, que se conceden desde la tarjeta o el editor.
    const canAllow = policy === 'allow' || tool.name !== getMCP().LOCAL_COMMAND_TOOL;
    const selectTitle = escapeHtml(t('mcp_security_select_title'));
    const option = (value, label) => `<option value="${value}"${policy === value ? ' selected' : ''}>${label}</option>`;
    return `
      <select class="mcp-auth-select ${policyClass(policy)}" data-tool-id="${escapeHtml(tool.name)}" data-server-name="${escapeHtml(serverName)}" data-orig-name="${escapeHtml(originalName)}" title="${selectTitle}" aria-label="${selectTitle}">
        ${option('ask', escapeHtml(t('mcp_security_badge_ask')))}
        ${canAllow ? option('allow', allowed) : ''}
        ${option('deny', escapeHtml(t('tool_auth_denied_badge')))}
      </select>`;
  }

  /**
   * Lista de herramientas MCP con su interruptor; las de navegador (browser_action y Playwright MCP)
   * no tienen interruptor propio porque se eligen en Ajustes › Navegador.
   */
  function renderToolsList(container, tools, appConfig) {
    if (tools.length === 0) {
      const msg = getState().get('mcp').status === 'connected' ? t('mcp_tools_empty_connected') : t('mcp_tools_empty_disconnected');
      container.innerHTML = `<div class="mcp-tools-empty">${Icons.get('plug', { size: 24 })}<p>${escapeHtml(msg)}</p></div>`;
      return;
    }

    const plug16 = Icons.get('plug', { size: 16 });
    const badgeText = escapeHtml(t('mcp_tool_badge'));
    const AgentCore = getAgentCore();
    const items = tools.map(tool => {
      const browser = AgentCore.browserOfTool(tool);
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
            ${browser ? `<p class="label-hint">${escapeHtml(t('mcp_tool_browser_setting'))}</p>` : ''}
          </div>
          ${browser ? '' : `<div class="mcp-tool-action">
            <label class="switch">
              <input type="checkbox" class="agent-tool-checkbox mcp-tool-checkbox" data-tool-id="${escapeHtml(tool.name)}" ${AgentCore.isToolEnabled(appConfig.enabledTools, tool.name, tool.defaultEnabled !== false) ? 'checked' : ''}>
              <span class="slider"></span>
            </label>
          </div>`}
        </div>`;
    }).join('');

    container.innerHTML = `
      <div class="mcp-tools-header">
        <div class="mcp-tools-title">${Icons.get('terminal', { size: 16 })}<span data-i18n="mcp_tools_section_title">${escapeHtml(t('mcp_tools_section_title'))}</span></div>
        <span class="mcp-tools-counter">${escapeHtml(t('mcp_tools_count', { count: tools.length }))}</span>
      </div>
      <div class="mcp-tools-list">${items}</div>`;

  }

  /** Cambio en la lista de herramientas: política de autorización o activación de una herramienta. */
  async function handleToolsChange(target) {
    if (target.matches('.mcp-auth-select')) {
      const toolId = target.getAttribute('data-tool-id');
      const policy = target.value;
      try {
        if (policy === 'ask') {
          await getSecurity().revokeToolPolicy(toolId);
        } else {
          await getSecurity().setToolPolicy(toolId, policy, {
            serverName: target.getAttribute('data-server-name'),
            originalName: target.getAttribute('data-orig-name')
          });
        }
      } catch (err) {
        // El backend rechazó el cambio: el selector vuelve a la política vigente.
        console.warn('[MCP] Could not update tool policy:', err?.message || err);
        target.value = getSecurity().getToolPolicy(toolId) || 'ask';
      }
      target.className = `mcp-auth-select ${policyClass(target.value)}`;
      renderSavedAuthorizations();
      return;
    }
    if (!target.matches('.mcp-tool-checkbox')) return;
    await updateToolEnabledState(target);
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

  /** Secretos que declara el servicio: solo si están guardados, con botones para guardarlos o borrarlos (nunca su valor). */
  function renderServerSecrets(server, language) {
    const secrets = server.secrets || [];
    if (secrets.length === 0) return '';
    const id = escapeHtml(server.id);
    return `<div class="mcp-server-secrets">${secrets.map(secret => {
      const name = escapeHtml(secret.name);
      const label = escapeHtml(localized(secret.label, language) || secret.name);
      return `
        <div class="mcp-server-secret-row">
          <span class="mcp-server-option-label">${label}</span>
          <span class="mcp-server-secret-status${secret.configured ? ' configured' : ''}">${escapeHtml(t(secret.configured ? 'mcp_secret_configured' : 'mcp_secret_missing'))}</span>
          <button type="button" class="btn-secondary btn-mcp-secret-set" data-server-id="${id}" data-secret-name="${name}" data-secret-label="${label}">${escapeHtml(t('mcp_secret_set'))}</button>
          ${secret.configured ? `<button type="button" class="btn-danger-outline btn-mcp-secret-delete" data-server-id="${id}" data-secret-name="${name}" data-secret-label="${label}">${escapeHtml(t('mcp_secret_delete'))}</button>` : ''}
        </div>`;
    }).join('')}</div>`;
  }

  function renderServer(server, language) {
    const status = server.status || 'stopped';
    const isRunning = McpStatus.isRunning(status);
    const isBusy = McpStatus.isBusy(status);
    const statusClass = `status-${isBusy ? 'starting' : status}`;
    const statusLabel = t(`mcp_external_status_${status}`);
    // Durante la instalación no se cuentan intentos.
    const startLabel = status === 'starting' && server.startWait
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
          ${server.id === 'playwright' ? `<p class="label-hint mcp-server-browser-notice">${escapeHtml(t('mcp_playwright_browser_notice'))}</p>` : ''}
          ${server.error ? `<div class="mcp-server-error"><p>${escapeHtml(server.error)}</p><a href="help/mcp.html" target="_blank" rel="noopener noreferrer">${escapeHtml(t('mcp_external_help'))}</a></div>` : ''}
          ${server.oauthUrl ? `<div class="mcp-server-oauth-banner"><p class="mcp-server-oauth-msg">${escapeHtml(t('mcp_oauth_required_msg'))}</p><a class="btn-secondary btn-mcp-oauth-open" href="${escapeHtml(server.oauthUrl)}" target="_blank" rel="noopener noreferrer" data-server-id="${id}">${escapeHtml(t('mcp_btn_oauth_authorize'))}</a></div>` : ''}
          ${renderServerSecrets(server, language)}
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
    container.innerHTML = servers.map(server => renderServer(server, language)).join('');

  }

  /** Clic en la lista de servidores: confiar en el servidor o iniciarlo/detenerlo. */
  async function handleServersClick(container, target) {
    const trust = target.closest('.btn-mcp-server-trust');
    if (trust) {
      const serverId = trust.getAttribute('data-server-id');
      if (getSecurity().getServerPolicy(serverId) === 'allow') await getSecurity().revokeServerPolicy(serverId);
      else await getSecurity().setServerPolicy(serverId, 'allow', { serverName: serverId });
      renderExternalServers(container, getState().get('mcp').externalServers);
      renderSavedAuthorizations();
      return;
    }
    const toggle = target.closest('.btn-mcp-server-toggle');
    if (toggle) {
      const serverId = toggle.getAttribute('data-server-id');
      const action = toggle.getAttribute('data-action');
      const ok = await getMCP().manager.runExternalServerAction(serverId, action);
      if (ok) {
        const Config = getConfig();
        const current = Config.getActive().mcpServers || [];
        const mcpServers = action === 'start'
          ? (current.includes(serverId) ? current : [...current, serverId])
          : current.filter(id => id !== serverId);
        Config.updateRuntime({ mcpServers });
        getMCP().manager.saveProjectEnvironment?.({ mcpServers })
          ?.catch?.(error => console.warn('[MCP UI] Could not save project MCP servers:', error));
      }
    }
    const secretButton = target.closest('.btn-mcp-secret-set, .btn-mcp-secret-delete');
    if (secretButton) await handleServerSecret(secretButton);
  }

  /** Guarda o borra un secreto del servicio: se pide en un diálogo de contraseña y el servidor no lo devuelve nunca. */
  async function handleServerSecret(button) {
    const Dialogs = getDialogs();
    const name = button.getAttribute('data-secret-label');
    let value = null;
    if (button.matches('.btn-mcp-secret-set')) {
      value = await Dialogs.prompt(t('mcp_secret_prompt', { name }), '', { inputType: 'password', title: name });
      if (value === null || !value.trim()) return;
    } else if (!await Dialogs.confirm(t('mcp_secret_delete_confirm', { name }))) {
      return;
    }
    try {
      await getMCP().manager.setExternalServerSecret(button.getAttribute('data-server-id'), button.getAttribute('data-secret-name'), value);
    } catch (error) {
      await Dialogs.alert(error?.message || String(error), { type: 'error' });
    }
  }

  /** Cambio de una opción booleana de un servidor: se guarda y la respuesta trae la lista de servidores. */
  async function handleServerOptionChange(checkbox) {
    if (!checkbox.matches('.mcp-server-option-checkbox')) return;
    checkbox.disabled = true;
    try {
      await getMCP().manager.configureExternalServer(checkbox.getAttribute('data-server-id'), { [checkbox.getAttribute('data-option-id')]: checkbox.checked });
    } catch (error) {
      console.error('[MCP UI] Error configuring server option:', error);
      checkbox.checked = !checkbox.checked;
    } finally {
      checkbox.disabled = false;
    }
  }

  /**
   * Concilia en silencio los servicios externos con el entorno del proyecto activo;
   * solo avisa si alguno de los requeridos falla al arrancar.
   */
  async function reconcileProjectServices(servers) {
    const { started, failed } = await getMCP().manager.reconcileProjectServers(getConfig().getActive(), servers);
    if (failed.length > 0) {
      const language = I18n.getLanguage();
      const allServers = getState().get('mcp').externalServers || servers || [];
      const names = failed.map(id => {
        const server = allServers.find(item => item?.id === id) || { id };
        return getServiceName(server, language);
      });
      await getDialogs().alert(t('mcp_external_restore_failed', { names: names.join(', ') }), { type: 'error' });
    }
    return started;
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
    elements.commandSnippet.textContent = generateTerminalCommand();
    renderCurrentToolsList(elements);
    renderExternalServers(elements.serversList, isConnected ? state.externalServers : []);
  }

  function renderSavedAuthorizations(elements = cachedElements) {
    const el = elements || cachedElements;
    const container = el?.savedAuthsList;
    const btnClear = el?.btnClearAuths;
    if (!container || !btnClear) return;
    const security = getSecurity();
    const tools = security.listAuthorizedTools();
    const servers = security.listAuthorizedServers();
    const patterns = security.getCommandPatterns();
    const hasPatterns = Boolean(patterns.global.length || patterns.project.length || patterns.session.length);

    if (tools.length === 0 && servers.length === 0 && !hasPatterns) {
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
    const scopeBadge = item => `<span class="mcp-auth-scope-badge">${escapeHtml(t(item.scope === 'session' ? 'mcp_security_scope_session' : 'mcp_security_scope_permanent'))}</span>`;

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
      const { className, text } = badge(item);
      const toolId = escapeHtml(item.toolId);
      return `
        <div class="mcp-auth-item" data-tool-id="${toolId}">
          <button type="button" class="btn-revoke-auth" data-tool-id="${toolId}" title="${revokeLabel}" aria-label="${revokeLabel}">${trashIcon}</button>
          <div class="mcp-auth-item-info">
            <strong class="mcp-auth-item-name">${escapeHtml(item.originalName || item.toolId)}</strong>
            <span class="mcp-auth-badge ${className}">${text}</span>
            ${scopeBadge(item)}
          </div>
        </div>`;
    });

    container.innerHTML = serverItems.join('') + toolItems.join('') + (hasPatterns ? renderCommandPatterns(patterns, revokeLabel, trashIcon) : '');
  }

  /**
   * Patrones de comando de run_command, una fila por alcance: etiqueta a la izquierda y sus patrones a la
   * derecha. Los globales y del proyecto actual se quitan uno a uno; los de sesión duran hasta que se cierra
   * ZeroChat o se cambia de proyecto. La papelera quita todos los guardados del alcance visible.
   */
  function renderCommandPatterns(patterns, revokeLabel, trashIcon) {
    const addLabel = escapeHtml(t('mcp_security_add_pattern_label'));
    const projectDir = String(getState().get('mcp').serverInfo?.cwd || '').trim();
    const folderName = dir => dir.split(/[\\/]+/).filter(Boolean).pop() || dir;
    const projectLabel = projectDir ? t('mcp_security_scope_this_project', { name: folderName(projectDir) }) : t('tool_auth_cmd_project');
    const chip = (pattern, scope) => {
      const removeLabel = escapeHtml(t('mcp_security_remove_pattern', { cmd: pattern }));
      return `<span class="mcp-auth-constraint-tag mcp-auth-cmd-chip"><code>${escapeHtml(pattern)}</code><button type="button" class="btn-remove-cmd-pattern" data-pattern="${escapeHtml(pattern)}" data-scope="${scope}" title="${removeLabel}" aria-label="${removeLabel}">${Icons.get('close', { size: 10 })}</button></span>`;
    };
    const sessionChip = pattern => `<span class="mcp-auth-constraint-tag mcp-auth-cmd-chip is-session"><code>${escapeHtml(pattern)}</code></span>`;
    const group = (icon, label, title, chips) => `
              <span class="mcp-auth-cmd-scope" title="${escapeHtml(title)}">${icon}<span class="mcp-auth-cmd-scope-label">${escapeHtml(label)}</span></span>
              <div class="mcp-auth-cmd-chips">${chips}</div>`;
    const scopeOptions = [
      `<option value="global">${escapeHtml(t('mcp_security_scope_global'))}</option>`,
      `<option value="project">${escapeHtml(projectLabel)}</option>`
    ].join('');
    const toolName = escapeHtml(getMCP().LOCAL_COMMAND_TOOL);
    return `
        <div class="mcp-auth-item" data-tool-id="${toolName}">
          <button type="button" class="btn-revoke-cmd-patterns" title="${revokeLabel}" aria-label="${revokeLabel}">${trashIcon}</button>
          <div class="mcp-auth-item-info">
            <strong class="mcp-auth-item-name">${toolName}</strong>
            <span class="mcp-auth-badge status-allowed">${escapeHtml(t('mcp_security_badge_allowed'))} (${escapeHtml(t('mcp_security_constrained'))})</span>
          </div>
            <div class="mcp-auth-cmd-patterns">
              ${patterns.global.length ? group(Icons.get('globe', { size: 12 }), t('mcp_security_scope_global'), t('mcp_security_scope_global'), patterns.global.map(pattern => chip(pattern, 'global')).join('')) : ''}
              ${patterns.project.length ? group(Icons.get('folder', { size: 12 }), projectLabel, projectDir || projectLabel, patterns.project.map(pattern => chip(pattern, 'project')).join('')) : ''}
              ${patterns.session.length ? group(Icons.get('clock', { size: 12 }), t('mcp_security_scope_session'), t('tool_auth_cmd_session_title'), patterns.session.map(sessionChip).join('')) : ''}
              <div class="mcp-auth-cmd-add">
                <select class="mcp-auth-cmd-scope-select" aria-label="${escapeHtml(t('mcp_security_add_scope_label'))}">${scopeOptions}</select>
                <div class="mcp-auth-cmd-add-line">
                  <input type="text" class="mcp-auth-cmd-input" placeholder="${addLabel}" aria-label="${addLabel}" spellcheck="false" autocomplete="off">
                  <button type="button" class="btn-add-cmd-pattern">${escapeHtml(t('mcp_security_add_pattern'))}</button>
                </div>
              </div>
              <p class="mcp-auth-cmd-error" role="alert" hidden></p>
            </div>
        </div>`;
  }

  /**
   * Cambia los patrones guardados: `change` recibe y devuelve `{ global, project }`.
   * Un rechazo del backend se muestra junto al editor.
   */
  async function updateCommandPatterns(origin, change) {
    const security = getSecurity();
    const errorEl = origin.closest('.mcp-auth-cmd-patterns')?.querySelector('.mcp-auth-cmd-error');
    const { global, project } = security.getCommandPatterns();
    try {
      await security.setCommandPatterns(change({ global, project }));
    } catch (err) {
      if (!errorEl) throw err;
      setText(errorEl, err?.message || String(err));
      errorEl.hidden = false;
    }
  }

  /** Añade el patrón del editor al alcance elegido: todos los proyectos o el proyecto actual. */
  async function addCommandPattern(editor) {
    const value = editor?.querySelector('.mcp-auth-cmd-input').value.trim();
    if (!value) return;
    const scope = editor.querySelector('.mcp-auth-cmd-scope-select').value;
    await updateCommandPatterns(editor, current => (scope === 'project'
      ? { ...current, project: [...current.project, value] }
      : { ...current, global: [...current.global, value] }));
  }

  function renderCurrentToolsList(elements) {
    const el = elements || cachedElements;
    if (el?.toolsContainer) {
      renderToolsList(el.toolsContainer, getConnectedTools(), getConfig().getActive());
    }
  }

  /**
   * Pinta las autorizaciones guardadas y las herramientas con el estado de ChatToolSecurity. La política
   * global y las reglas de directorios las carga y guarda el diálogo de ajustes.
   */
  function syncSecurityControls(elements = cachedElements) {
    const el = elements || cachedElements;
    if (!el) return;
    renderSavedAuthorizations(el);
    renderCurrentToolsList(el);
  }

  /** Monta la sección MCP: enlaza una sola vez sus eventos, delegados en cada contenedor. */
  function initMcpUI(elements) {
    cachedElements = elements;
    const State = getState();
    const security = getSecurity();
    const listeners = Utils.createListenerGroup();
    const on = listeners.listen;
    const render = () => renderConnectionStatus(elements, State.get('mcp'));

    on(elements.btnCopyCmd, 'click', () => copyCommandToClipboard(generateTerminalCommand(), elements.btnCopyCmd));
    on(elements.toolsContainer, 'change', event => handleToolsChange(event.target));
    on(elements.serversList, 'click', event => handleServersClick(elements.serversList, event.target));
    on(elements.serversList, 'change', event => handleServerOptionChange(event.target));
    // Revocar re-renderiza los ajustes MCP a través de la suscripción a ChatToolSecurity.
    on(elements.savedAuthsList, 'click', async event => {
      const tool = event.target.closest('.btn-revoke-auth');
      if (tool) await security.revokeToolPolicy(tool.getAttribute('data-tool-id'));
      const server = event.target.closest('.btn-revoke-server-auth');
      if (server) await security.revokeServerPolicy(server.getAttribute('data-server-id'));
      if (event.target.closest('.btn-revoke-cmd-patterns')) await security.setCommandPatterns({ global: [], project: [] });
      const removePattern = event.target.closest('.btn-remove-cmd-pattern');
      if (removePattern) {
        const pattern = removePattern.getAttribute('data-pattern');
        const scope = removePattern.getAttribute('data-scope');
        await updateCommandPatterns(removePattern, current => (scope === 'project'
          ? { ...current, project: current.project.filter(p => p !== pattern) }
          : { ...current, global: current.global.filter(p => p !== pattern) }));
      }
      const addPattern = event.target.closest('.btn-add-cmd-pattern');
      if (addPattern) await addCommandPattern(addPattern.closest('.mcp-auth-cmd-add'));
    });
    // La lista vive dentro del formulario de ajustes: Enter añade el patrón y no envía ese formulario.
    on(elements.savedAuthsList, 'keydown', async event => {
      if (event.key !== 'Enter' || !event.target.matches('.mcp-auth-cmd-input')) return;
      event.preventDefault();
      await addCommandPattern(event.target.closest('.mcp-auth-cmd-add'));
    });
    on(elements.btnClearAuths, 'click', async () => await security.clearAllAuthorizations());

    const unsubscribeSecurity = security.subscribe(() => syncSecurityControls(elements));
    const unsubscribeState = State.subscribe('mcp', state => renderConnectionStatus(elements, state));
    render();
    syncSecurityControls(elements);

    const unsubscribeLanguage = I18n.onChange(() => {
      render();
      renderSavedAuthorizations(elements);
    });

    return {
      destroy: () => {
        cachedElements = null;
        listeners.dispose();
        unsubscribeState();
        unsubscribeSecurity();
        unsubscribeLanguage();
      }
    };
  }

  function verifyActiveConnection() {
    return getMCP().manager.verifyProxyConnection();
  }

  return {
    generateTerminalCommand,
    getServiceHelp,
    getServiceName,
    renderConnectionStatus,
    renderToolsList,
    renderExternalServers,
    renderSavedAuthorizations,
    reconcileProjectServices,
    syncSecurityControls,
    initMcpUI,
    verifyActiveConnection
  };
});
