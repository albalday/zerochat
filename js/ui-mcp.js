/**
 * UI for the local ZeroChat MCP host. External MCP products are discovered
 * through the downloaded host; this bundle contains no product recipe or
 * process implementation.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') module.exports = factory();
  else root.ChatUIMcp = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const DEFAULT_HOST = '127.0.0.1';
  const DEFAULT_PORT = 6388;
  const DEFAULT_OPERATING_SYSTEM = 'linux';
  const resolveDep = (name, path) => (typeof window !== 'undefined' && window.ChatUtils?.resolveDep
    ? window.ChatUtils.resolveDep(name, path)
    : ((typeof window !== 'undefined' && window[name]) || (typeof require !== 'undefined'
      ? (() => { try { return require(path); } catch (_) { return null; } })() : null)));
  const getUtils = () => resolveDep('ChatUtils', './utils.js');
  const getI18n = () => resolveDep('ChatI18n', './i18n.js');
  const getIcons = () => resolveDep('ChatIcons', './icons.js');
  const getState = () => resolveDep('ChatState', './state.js');
  const getMCP = () => resolveDep('ChatMCP', './mcp.js');
  const getConfig = () => resolveDep('ChatConfig', './config-store.js');
  const getSecurity = () => resolveDep('ChatToolSecurity', './tool-security.js');
  const t = (key, params) => getI18n()?.t ? getI18n().t(key, params) : key;
  const escapeHtml = value => getUtils()?.escapeHtml
    ? getUtils().escapeHtml(value)
    : (value == null ? '' : String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'));

  function clearSafeContent(element) {
    const utils = getUtils();
    if (utils?.clearElement) return utils.clearElement(element);
    if (element) element.textContent = '';
    return element;
  }
  function appendSafeText(parent, tagName, value, options) {
    const utils = getUtils();
    const child = utils?.appendTextElement?.(parent, tagName, value, options);
    if (!child && parent) parent.textContent = `${parent.textContent || ''}${value == null ? '' : String(value)}`;
    return child;
  }
  function appendTrustedIcon(parent, icon) {
    if (!parent || !icon || typeof document === 'undefined') return;
    const host = document.createElement('span');
    host.setAttribute('aria-hidden', 'true');
    const utils = getUtils();
    if (utils?.setTrustedHtml) utils.setTrustedHtml(host, icon);
    else host.innerHTML = icon;
    parent.appendChild(host);
  }
  function sanitizePort(port) {
    const parsed = parseInt(port, 10);
    return Number.isInteger(parsed) && parsed >= 1024 && parsed <= 65535 ? parsed : DEFAULT_PORT;
  }
  function sanitizeHost(host) { return String(host || '').trim() || DEFAULT_HOST; }
  function buildMcpEndpoint(host, port, path = '/sse') {
    const suffix = path ? (path.startsWith('/') ? path : `/${path}`) : '/sse';
    return `http://${sanitizeHost(host)}:${sanitizePort(port)}${suffix}`;
  }
  function generateMcpServerScript() {
    const localServerPayload = typeof globalThis !== 'undefined' ? globalThis.__ZMCP_LOCAL_SERVER_B64__ : null;
    if (!localServerPayload) {
      throw new Error('This ZeroChat bundle does not include its local MCP server');
    }
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(localServerPayload, 'base64').toString('utf8');
    }
    if (typeof atob === 'function') {
      const binary = atob(localServerPayload);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return new TextDecoder('utf-8').decode(bytes);
    }
    return '';
  }

  function downloadMcpServerScript(options = {}) {
    const host = sanitizeHost(options.host);
    const port = sanitizePort(options.port);
    const content = generateMcpServerScript({ host, port });
    const filename = 'zmcp.py';

    if (typeof document !== 'undefined' && typeof Blob !== 'undefined' && typeof URL !== 'undefined') {
      try {
        const blob = new Blob([content], { type: 'text/x-python;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} }, 3000);
        return true;
      } catch (e) {
        return false;
      }
    }
    return false;
  }

  function sanitizeOperatingSystem(operatingSystem) {
    return ['linux', 'windows', 'android'].includes(String(operatingSystem || '').toLowerCase())
      ? String(operatingSystem).toLowerCase()
      : DEFAULT_OPERATING_SYSTEM;
  }

  function generateTerminalCommand(port, operatingSystem = DEFAULT_OPERATING_SYSTEM) {
    const normalizedPort = sanitizePort(port);
    const os = sanitizeOperatingSystem(operatingSystem);
    const executable = os === 'windows' ? 'py' : 'python3';
    const portArgument = normalizedPort === DEFAULT_PORT ? '' : ` --port ${normalizedPort}`;
    return `${executable} zmcp.py${portArgument}`;
  }

  function getOperatingSystemHelpKey(operatingSystem) {
    const os = sanitizeOperatingSystem(operatingSystem);
    return os === 'windows' ? 'mcp_copy_help_windows' : (os === 'android' ? 'mcp_copy_help_android' : 'mcp_copy_help_linux');
  }

  function generateOperatingSystemInstructions(operatingSystem = DEFAULT_OPERATING_SYSTEM, translator = t) {
    return translator(getOperatingSystemHelpKey(operatingSystem));
  }

  function generateClipboardCommand(port, operatingSystem = DEFAULT_OPERATING_SYSTEM, translator = t) {
    const os = sanitizeOperatingSystem(operatingSystem);
    return `${generateOperatingSystemInstructions(os, translator)}\n\n${generateTerminalCommand(port, os)}`;
  }

  async function copyCommandToClipboard(text, btnElement, translator = t) {
    if (!text) return false;
    let ok = false;
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(text); ok = true; } catch (e) {}
    }
    if (btnElement && ok) {
      const orig = btnElement.innerHTML;
      const check = getIcons()?.get ? getIcons().get('check', { size: 14 }) : '';
      btnElement.innerHTML = `${check} <span>${translator('mcp_cmd_copied')}</span>`;
      btnElement.classList.add('btn-copied');
      const timer = setTimeout(() => { btnElement.innerHTML = orig; btnElement.classList.remove('btn-copied'); }, 2000);
      if (typeof timer?.unref === 'function') timer.unref();
    }
    return ok;
  }

  function renderToolsList(container, tools, currentEnabledTools = {}, translator = t) {
    if (!container) return;
    const Icons = getIcons();
    container.style.display = 'block';

    if (!Array.isArray(tools) || tools.length === 0) {
      const isConnected = getState()?.get ? getState().get('mcp')?.status === 'connected' : false;
      const msg = isConnected ? translator('mcp_tools_empty_connected') : translator('mcp_tools_empty_disconnected');
      const plug = Icons?.get ? Icons.get('plug', { size: 24 }) : '<svg class="ui-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22v-5"></path><path d="M9 8V2"></path><path d="M15 8V2"></path><path d="M18 8v5a6 6 0 0 1-12 0V8z"></path></svg>';
      container.innerHTML = `<div class="mcp-tools-empty">${plug}<p>${msg}</p></div>`;
      return;
    }

    const plug16 = Icons?.get ? Icons.get('plug', { size: 16 }) : '';
    const term16 = Icons?.get ? Icons.get('terminal', { size: 16 }) : '';
    const badgeText = escapeHtml(translator('mcp_tool_badge'));

    const Security = getSecurity();
    const globalPolicy = Security?.manager?.getGlobalMcpPolicy ? Security.manager.getGlobalMcpPolicy() : 'ask';

    const items = tools.map(tool => {
      const id = tool.id || tool.name;
      const isChecked = currentEnabledTools[id] !== undefined ? currentEnabledTools[id] !== false : (currentEnabledTools[tool.name] !== undefined ? currentEnabledTools[tool.name] !== false : true);
      const desc = escapeHtml(tool.descFallback || tool.description || '');

      let paramsHint = '';
      const props = tool.inputSchema?.properties || tool.parameters?.properties;
      if (props && typeof props === 'object') {
        const req = Array.isArray(tool.inputSchema?.required || tool.parameters?.required) ? (tool.inputSchema?.required || tool.parameters?.required) : [];
        paramsHint = Object.entries(props).map(([k, v]) => `${k}${req.includes(k) ? '' : '?'}: ${v.type || 'any'}`).join(', ');
      }

      const serverName = tool.metadata?.mcpServerName || '';
      const originalName = tool.metadata?.originalName || tool.name;
      const toolRule = Security?.manager?.getToolPolicy ? Security.manager.getToolPolicy(id) : null;
      const toolConstraints = Security?.manager?.getToolConstraints ? Security.manager.getToolConstraints(id) : null;
      const hasConstraints = !!(toolConstraints && (toolConstraints.command || toolConstraints.path));
      const effectivePolicy = toolRule || 'ask';

      let authTagHtml = '';
      if (globalPolicy === 'allow_all') {
        authTagHtml = `<span class="mcp-auth-badge status-allowed" title="${escapeHtml(translator('mcp_security_policy_allow_all'))}">${escapeHtml(translator('mcp_security_badge_allowed'))} (Global)</span>`;
      } else {
        const selectTitle = escapeHtml(translator('mcp_security_select_title'));
        const optAsk = escapeHtml(translator('mcp_security_badge_ask'));
        let optAllowed = escapeHtml(translator('mcp_security_badge_allowed'));
        if (hasConstraints && effectivePolicy === 'allow') {
          optAllowed += ` (${escapeHtml(translator('mcp_security_constrained') || 'Acotada')})`;
        }
        const optDenied = escapeHtml(translator('tool_auth_denied_badge'));
        const statusClass = effectivePolicy === 'allow' ? 'status-allowed' : (effectivePolicy === 'deny' ? 'status-denied' : 'status-ask');

        authTagHtml = `
          <select class="mcp-auth-select ${statusClass}" data-tool-id="${escapeHtml(id)}" data-server-name="${escapeHtml(serverName)}" data-orig-name="${escapeHtml(originalName)}" title="${selectTitle}" aria-label="${selectTitle}">
            <option value="ask" ${effectivePolicy === 'ask' ? 'selected' : ''}>${optAsk}</option>
            <option value="allow" ${effectivePolicy === 'allow' ? 'selected' : ''}>${optAllowed}</option>
            <option value="deny" ${effectivePolicy === 'deny' ? 'selected' : ''}>${optDenied}</option>
          </select>`;
      }

      return `
        <div class="mcp-tool-card" data-tool-id="${escapeHtml(id)}">
          <div class="mcp-tool-info">
            <div class="mcp-tool-title-row">
              <span class="mcp-tool-icon">${plug16}</span>
              <span class="mcp-tool-name">${escapeHtml(tool.name)}</span>
              <span class="mcp-tool-badge">${badgeText}</span>
              ${authTagHtml}
            </div>
            <p class="mcp-tool-desc">${desc}</p>
            ${paramsHint ? `<div class="mcp-tool-params"><code>${escapeHtml(paramsHint)}</code></div>` : ''}
          </div>
          <div class="mcp-tool-action">
            <label class="switch">
              <input type="checkbox" class="agent-tool-checkbox mcp-tool-checkbox" data-tool-id="${escapeHtml(id)}" ${isChecked ? 'checked' : ''}>
              <span class="slider"></span>
            </label>
          </div>
        </div>`;
    }).join('');

    container.innerHTML = `
      <div class="mcp-tools-header">
        <div class="mcp-tools-title">${term16}<span data-i18n="mcp_tools_section_title">${translator('mcp_tools_section_title')}</span></div>
        <span class="mcp-tools-counter">${translator('mcp_tools_count', { count: tools.length })}</span>
      </div>
      <div class="mcp-tools-list">${items}</div>`;

    container.querySelectorAll?.('.mcp-auth-select').forEach(sel => {
      sel.addEventListener?.('change', () => {
        const tid = sel.getAttribute?.('data-tool-id');
        if (!tid) return;
        const newPolicy = sel.value;
        const sName = sel.getAttribute?.('data-server-name') || '';
        const oName = sel.getAttribute?.('data-orig-name') || tid;

        if (Security?.manager) {
          if (newPolicy === 'ask') {
            Security.manager.revokeToolPolicy(tid);
          } else {
            Security.manager.setToolPolicy(tid, newPolicy, {
              serverName: sName,
              originalName: oName
            });
          }
        }

        // Actualizar clase visual del select según la nueva opción
        sel.className = `mcp-auth-select status-${newPolicy === 'allow' ? 'allowed' : (newPolicy === 'deny' ? 'denied' : 'ask')}`;

        // Sincronizar lista de autorizaciones guardadas en el modal si está disponible
        const savedListEl = typeof document !== 'undefined' ? document.getElementById('mcp-saved-auths-list') : null;
        if (savedListEl && typeof renderSavedAuthorizations === 'function') {
          renderSavedAuthorizations({
            savedAuthsList: savedListEl,
            btnClearAuths: document.getElementById('btn-mcp-clear-auths')
          }, translator);
        }
      });
    });

    container.querySelectorAll?.('.mcp-tool-checkbox').forEach(cb => {
      cb.addEventListener?.('change', () => {
        const tid = cb.getAttribute?.('data-tool-id');
        if (!tid) return;
        const Config = getConfig();
        if (Config) {
          const curr = (Config.get?.() || Config.getActive?.())?.enabledTools || {};
          (Config.updateRuntime || Config.update)?.call(Config, { enabledTools: { ...curr, [tid]: cb.checked } });
        }
      });
    });
  }

  function renderExternalServers(container, servers, hostState, translator = t) {
    if (!container) return;
    if (hostState !== 'running') {
      container.innerHTML = `<div class="mcp-servers-empty label-hint">${escapeHtml(translator('mcp_external_stopped'))}</div>`;
      return;
    }
    if (!Array.isArray(servers) || servers.length === 0) {
      container.innerHTML = `<div class="mcp-servers-empty label-hint">${escapeHtml(translator('mcp_servers_empty'))}</div>`;
      return;
    }

    container.innerHTML = servers.map(server => {
      const isRunning = server.status === 'running';
      const statusText = escapeHtml(translator(`mcp_external_status_${server.status || 'available'}`));
      const btnText = escapeHtml(isRunning ? translator('mcp_btn_stop_server') : translator('mcp_btn_start_server'));
      const toolCount = server.toolCount || 0;
      const toolCountHtml = isRunning && toolCount > 0 ? `<span class="mcp-server-tool-count">${escapeHtml(translator('mcp_servers_count_tools', { count: toolCount }))}</span>` : '';
      const language = getI18n()?.getLanguage?.() || 'es';
      const desc = escapeHtml(server.description?.[language] || server.description?.es || server.description || '');
      const err = server.error ? `<p class="mcp-server-error">${escapeHtml(server.error)}</p>` : '';

      return `
        <div class="mcp-server-item" data-server-id="${escapeHtml(server.id)}">
          <div class="mcp-server-info">
            <div class="mcp-server-title-row">
              <strong class="mcp-server-name">${escapeHtml(server.displayName?.[language] || server.displayName?.es || server.name || server.id)}</strong>
              <span class="mcp-server-badge status-${escapeHtml(server.status || 'available')}">${statusText}</span>
              ${toolCountHtml}
            </div>
            ${desc ? `<p class="mcp-server-desc">${desc}</p>` : ''}
            ${err}
          </div>
          <div class="mcp-server-actions">
            <button type="button" class="btn-mcp-server-toggle ${isRunning ? 'btn-danger' : 'btn-secondary'}" data-server-id="${escapeHtml(server.id)}" data-action="${isRunning ? 'stop' : 'start'}">
              ${btnText}
            </button>
          </div>
        </div>`;
    }).join('');

    container.querySelectorAll?.('.btn-mcp-server-toggle').forEach(btn => {
      btn.addEventListener?.('click', async () => {
        const sid = btn.getAttribute?.('data-server-id');
        const act = btn.getAttribute?.('data-action');
        if (!sid) return;
        btn.disabled = true;
        const MCP = getMCP();
        try {
          if (act === 'start') {
            await MCP?.manager?.startExternalServer?.(sid);
          } else {
            await MCP?.manager?.stopExternalServer?.(sid);
          }
          const updated = await MCP?.manager?.fetchExternalServers?.();
          const State = getState();
          if (updated && State?.set) {
            const current = State.get('mcp') || {};
            State.set('mcp', {
              ...current,
              externalHost: updated.host || 'stopped',
              externalServers: updated.servers || []
            });
          }
          renderExternalServers(container, updated?.servers || [], updated?.host || 'stopped', translator);

          const toolsContainer = typeof document !== 'undefined' ? document.getElementById('mcp-tools-container') : null;
          if (toolsContainer) {
            const currentConfig = getConfig()?.get?.() || {};
            const st = getState()?.get?.('mcp') || {};
            renderToolsList(toolsContainer, [...(st.tools || []), ...(st.externalTools || [])], currentConfig.enabledTools || {}, translator);
          }
        } catch (e) {
          console.error('[MCP UI] Error toggling server:', e);
        } finally {
          btn.disabled = false;
        }
      });
    });
  }

  function renderConnectionStatus(elements, mcpState, translator = t) {
    if (!elements) return;
    const State = getState();
    const state = mcpState || State?.get?.('mcp') || { status: 'disconnected', host: DEFAULT_HOST, port: DEFAULT_PORT, tools: [] };
    const status = state.status || 'disconnected';
    const isConn = status === 'connected';
    const isConnecting = status === 'connecting';
    const Icons = getIcons();

    if (elements.statusBadge) elements.statusBadge.className = `mcp-status-badge mcp-status-${status}`;
    if (elements.statusText) {
      if (typeof elements.statusText.setAttribute === 'function') {
        elements.statusText.setAttribute('data-i18n', `mcp_status_${status}`);
      }
      elements.statusText.textContent = translator(`mcp_status_${status}`);
    }

    if (elements.btnConnect) {
      elements.btnConnect.style.display = isConn ? 'none' : 'inline-flex';
      elements.btnConnect.disabled = isConnecting;
      const icon = isConnecting ? (Icons?.get?.('spinner', { size: 14, className: 'spinning' }) || '') : (Icons?.get?.('plug', { size: 14 }) || '');
      const labelKey = isConnecting ? 'mcp_btn_connecting' : 'mcp_btn_connect';
      const label = translator(labelKey);
      elements.btnConnect.innerHTML = `${icon} <span data-i18n="${labelKey}">${label}</span>`;
    }

    if (elements.btnDisconnect) elements.btnDisconnect.style.display = isConn ? 'inline-flex' : 'none';
    if (elements.btnMcpStartExternal || elements.btnStartExternal) {
      (elements.btnMcpStartExternal || elements.btnStartExternal).disabled = !isConn;
    }
    if (elements.btnMcpStopExternal || elements.btnStopExternal) {
      (elements.btnMcpStopExternal || elements.btnStopExternal).disabled = !isConn;
    }
    const serversCard = elements.mcpServersCard || (typeof document !== 'undefined' ? document.getElementById('mcp-servers-card') : null);
    if (serversCard) serversCard.hidden = !isConn;

    if (elements.serverDetails) {
      elements.serverDetails.style.display = isConn ? 'flex' : 'none';
      clearSafeContent(elements.serverDetails);
      if (isConn) {
        const name = state.serverInfo?.name || 'mcp-proxy';
        const ver = state.serverInfo?.version ? ` v${state.serverInfo.version}` : '';
        const latency = Number(state.latencyMs);
        const lat = Number.isFinite(latency) && latency > 0 ? ` · ${latency}ms` : '';
        const count = Array.isArray(state.tools) ? state.tools.length : 0;
        const toolLabel = count > 0 ? translator('mcp_tools_discovered', { count }) : translator('mcp_no_tools');
        const nameItem = appendSafeText(elements.serverDetails, 'span', '', { className: 'mcp-detail-item' });
        appendSafeText(nameItem || elements.serverDetails, 'strong', `${name}${ver}`);
        if (lat) appendSafeText(elements.serverDetails, 'span', lat, { className: 'mcp-detail-item mcp-latency-tag' });
        appendSafeText(elements.serverDetails, 'span', toolLabel, { className: 'mcp-detail-item mcp-tools-tag' });
      }
    }

    if (elements.errorMessage) {
      const showErr = status === 'error' && state.error;
      elements.errorMessage.style.display = showErr ? 'flex' : 'none';
      clearSafeContent(elements.errorMessage);
      if (showErr) {
        appendTrustedIcon(elements.errorMessage, Icons?.get?.('alert-circle', { size: 16 }) || '');
        appendSafeText(elements.errorMessage, 'span', state.error);
      }
    }

    const host = elements.hostInput?.value || state.host || DEFAULT_HOST;
    const port = elements.portInput?.value || state.port || DEFAULT_PORT;
    const operatingSystem = elements.osInput?.value || elements.mcpOsSelect?.value || DEFAULT_OPERATING_SYSTEM;
    if (elements.commandSnippet) elements.commandSnippet.textContent = generateTerminalCommand(port, operatingSystem);
    if (elements.endpointPreview) elements.endpointPreview.textContent = buildMcpEndpoint(host, port);

    if (elements.toolsContainer) {
      const currentConfig = getConfig()?.get?.() || {};
      renderToolsList(elements.toolsContainer, isConn ? (state.tools || []) : [], currentConfig.enabledTools || {}, translator);
    }

    const serversListEl = elements.mcpServersList || elements.serversList || (typeof document !== 'undefined' ? document.getElementById('mcp-servers-list') : null);
    if (serversListEl) {
      renderExternalServers(serversListEl, state.externalServers || [], state.externalHost || 'stopped', translator);
      if (isConn) {
        const MCP = getMCP();
        MCP?.manager?.fetchExternalServers?.().then(res => {
          if (res && res.servers) {
            renderExternalServers(serversListEl, res.servers, res.host, translator);
          }
        }).catch(() => {});
      }
    }
  }

  function renderSavedAuthorizations(elements, translator = t) {
    if (!elements && typeof document === 'undefined') return;
    const container = elements?.savedAuthsList || (typeof document !== 'undefined' ? document.getElementById('mcp-saved-auths-list') : null);
    const btnClear = elements?.btnClearAuths || (typeof document !== 'undefined' ? document.getElementById('btn-mcp-clear-auths') : null);
    if (!container) return;

    const Security = getSecurity();
    const authorized = Security?.manager?.listAuthorizedTools ? Security.manager.listAuthorizedTools() : [];

    if (!authorized || authorized.length === 0) {
      container.innerHTML = `<div class="mcp-no-auths-msg label-hint">${escapeHtml(translator('mcp_security_no_saved_auths'))}</div>`;
      if (btnClear) btnClear.style.display = 'none';
      return;
    }

    if (btnClear) btnClear.style.display = 'inline-flex';

    const Icons = getIcons();
    const trashIcon = Icons?.get ? Icons.get('trash', { size: 12 }) : '';

    container.innerHTML = authorized.map(item => {
      const toolId = escapeHtml(item.toolId);
      const origName = escapeHtml(item.originalName || item.toolId);
      const isAllowed = item.policy === 'allow';
      const badgeClass = isAllowed ? 'status-allowed' : 'status-denied';
      let badgeText = escapeHtml(isAllowed ? translator('mcp_security_badge_allowed') : translator('tool_auth_denied_badge'));
      const revokeLabel = escapeHtml(translator('mcp_security_btn_revoke'));

      let constraintTag = '';
      if (item.constraints) {
        const parts = [];
        if (item.constraints.command?.allowedPrefixes) {
          parts.push(item.constraints.command.allowedPrefixes.join(', '));
        }
        if (item.constraints.path?.allowedDirectories) {
          parts.push(item.constraints.path.allowedDirectories.join(', '));
        }
        if (parts.length > 0) {
          badgeText += ` (${escapeHtml(translator('mcp_security_constrained') || 'Acotada')})`;
          constraintTag = `<span class="mcp-auth-constraint-tag" title="${escapeHtml(parts.join(' | '))}">${escapeHtml(parts.join(' | '))}</span>`;
        }
      }

      return `
        <div class="mcp-auth-item" data-tool-id="${toolId}">
          <div class="mcp-auth-item-info">
            <strong class="mcp-auth-item-name">${origName}</strong>
            <span class="mcp-auth-badge ${badgeClass}">${badgeText}</span>
            ${constraintTag}
          </div>
          <button type="button" class="btn-revoke-auth" data-tool-id="${toolId}" title="${revokeLabel}">
            ${trashIcon} <span>${revokeLabel}</span>
          </button>
        </div>`;
    }).join('');

    container.querySelectorAll('.btn-revoke-auth').forEach(btn => {
      btn.addEventListener('click', () => {
        const tid = btn.getAttribute('data-tool-id');
        if (tid && Security?.manager?.revokeToolPolicy) {
          Security.manager.revokeToolPolicy(tid);
          renderSavedAuthorizations(elements, translator);
          if (elements?.toolsContainer) {
            const currentConfig = getConfig()?.get?.() || {};
            const state = getState()?.get?.('mcp') || {};
            renderToolsList(elements.toolsContainer, state.tools || [], currentConfig.enabledTools || {}, translator);
          }
        }
      });
    });
  }

  function initMcpUI(elements, options = {}) {
    ensureDialogMarkup();
    if (!elements) return null;
    const State = getState();
    const MCP = getMCP();
    const Config = getConfig();
    const Security = getSecurity();

    const currentConfig = Config?.get?.() || {};
    if (elements.hostInput && !elements.hostInput.value) elements.hostInput.value = currentConfig.mcpHost || DEFAULT_HOST;
    if (elements.portInput && !elements.portInput.value) elements.portInput.value = currentConfig.mcpPort || DEFAULT_PORT;
    const getOsInput = () => elements.osInput || elements.mcpOsSelect || (typeof document !== 'undefined' ? document.getElementById('mcp-os-select') : null);
    const getOsInstructions = () => elements.osInstructions || (typeof document !== 'undefined' ? document.getElementById('mcp-os-instructions') : null);

    function updateCommandAndEndpoint() {
      const host = elements.hostInput?.value || DEFAULT_HOST;
      const port = elements.portInput?.value || DEFAULT_PORT;
      const operatingSystem = getOsInput()?.value || DEFAULT_OPERATING_SYSTEM;
      if (elements.commandSnippet) elements.commandSnippet.textContent = generateTerminalCommand(port, operatingSystem);
      const instructions = getOsInstructions();
      if (instructions) instructions.textContent = generateOperatingSystemInstructions(operatingSystem, t);
      if (elements.endpointPreview) elements.endpointPreview.textContent = buildMcpEndpoint(host, port);
      Config?.update?.({ mcpHost: host, mcpPort: sanitizePort(port) });
    }

    elements.portInput?.addEventListener?.('input', updateCommandAndEndpoint);
    elements.hostInput?.addEventListener?.('input', updateCommandAndEndpoint);
    getOsInput()?.addEventListener?.('change', updateCommandAndEndpoint);

    const openModal = () => {
      elements.mcpSetupDialog?.showModal?.();
      syncSecurityControls();
      syncExternalServers();
    };
    const closeModal = () => elements.mcpSetupDialog?.close?.();
    elements.btnConfigure?.addEventListener?.('click', openModal);
    elements.btnCloseSetup?.addEventListener?.('click', closeModal);
    elements.btnCloseSetupFooter?.addEventListener?.('click', closeModal);
    elements.mcpSetupDialog?.addEventListener?.('click', (e) => { if (e.target === elements.mcpSetupDialog) closeModal(); });

    // Controles de Seguridad MCP
    const radioAsk = elements.mcpSetupDialog?.querySelector?.('#mcp-policy-ask') || (typeof document !== 'undefined' ? document.getElementById('mcp-policy-ask') : null);
    const radioAllowAll = elements.mcpSetupDialog?.querySelector?.('#mcp-policy-allow-all') || (typeof document !== 'undefined' ? document.getElementById('mcp-policy-allow-all') : null);
    const btnClearAuths = elements.mcpSetupDialog?.querySelector?.('#btn-mcp-clear-auths') || (typeof document !== 'undefined' ? document.getElementById('btn-mcp-clear-auths') : null);

    function syncExternalServers() {
      const serversListEl = elements.mcpSetupDialog?.querySelector?.('#mcp-servers-list') || (typeof document !== 'undefined' ? document.getElementById('mcp-servers-list') : null);
      if (serversListEl) {
        const st = State?.get?.('mcp') || {};
        const isConn = st.status === 'connected';
        renderExternalServers(serversListEl, st.externalServers || [], st.externalHost || 'stopped', t);
        if (isConn) {
          MCP?.manager?.fetchExternalServers?.().then(res => {
            if (res && res.servers) {
              renderExternalServers(serversListEl, res.servers, res.host, t);
            }
          }).catch(() => {});
        }
      }
    }

    function syncSecurityControls() {
      const currentGlobalPolicy = Security?.manager?.getGlobalMcpPolicy ? Security.manager.getGlobalMcpPolicy() : 'ask';
      if (radioAsk) radioAsk.checked = (currentGlobalPolicy === 'ask');
      if (radioAllowAll) radioAllowAll.checked = (currentGlobalPolicy === 'allow_all');
      renderSavedAuthorizations(elements, t);
    }

    function renderCurrentToolsList() {
      if (elements.toolsContainer) {
        const currentCfg = getConfig()?.get?.() || {};
        const st = State?.get?.('mcp') || {};
        renderToolsList(elements.toolsContainer, st.tools || [], currentCfg.enabledTools || {}, t);
      }
    }

    radioAsk?.addEventListener?.('change', () => {
      if (radioAsk.checked && Security?.manager?.setGlobalMcpPolicy) {
        Security.manager.setGlobalMcpPolicy('ask');
        renderCurrentToolsList();
      }
    });

    radioAllowAll?.addEventListener?.('change', () => {
      if (radioAllowAll.checked && Security?.manager?.setGlobalMcpPolicy) {
        Security.manager.setGlobalMcpPolicy('allow_all');
        renderCurrentToolsList();
      }
    });

    btnClearAuths?.addEventListener?.('click', () => {
      if (Security?.manager?.clearAllAuthorizations) {
        Security.manager.clearAllAuthorizations();
        renderSavedAuthorizations(elements, t);
        renderCurrentToolsList();
      }
    });

    const unsubscribeSecurity = Security?.manager?.subscribe ? Security.manager.subscribe(() => {
      syncSecurityControls();
      renderCurrentToolsList();
    }) : null;

    let pollTimer = null;
    function startAutoConnectPolling() {
      if (pollTimer) clearInterval(pollTimer);
      let attempts = 0;
      pollTimer = setInterval(async () => {
        attempts++;
        if (attempts > 40 || State?.get?.('mcp')?.status === 'connected') {
          clearInterval(pollTimer);
          pollTimer = null;
          return;
        }
        const host = elements.hostInput?.value || DEFAULT_HOST;
        const port = sanitizePort(elements.portInput?.value || DEFAULT_PORT);
        try {
          const res = await autoConnectIfAvailable({ host, port, timeoutMs: 1200 });
          if (res && res.available && res.success) {
            clearInterval(pollTimer);
            pollTimer = null;
          }
        } catch (e) {}
      }, 1500);
    }

    const btnDownload = elements.btnDownloadScript || (typeof document !== 'undefined' ? document.getElementById('btn-mcp-download-script') : null);
    btnDownload?.addEventListener?.('click', () => {
      const host = elements.hostInput?.value || DEFAULT_HOST;
      const port = sanitizePort(elements.portInput?.value || DEFAULT_PORT);
      downloadMcpServerScript({ host, port });
      startAutoConnectPolling();
    });

    const btnStartExternal = elements.btnMcpStartExternal || elements.btnStartExternal || (typeof document !== 'undefined' ? document.getElementById('btn-mcp-start-external') : null);
    const btnStopExternal = elements.btnMcpStopExternal || elements.btnStopExternal || (typeof document !== 'undefined' ? document.getElementById('btn-mcp-stop-external') : null);
    const bootstrapStatus = elements.bootstrapStatus || (typeof document !== 'undefined' ? document.getElementById('mcp-bootstrap-status') : null);
    let bootstrapPollTimer = null;

    function renderBootstrapStatus(status) {
      if (!bootstrapStatus) return;
      const message = String(status?.message || '').trim();
      bootstrapStatus.hidden = !message;
      bootstrapStatus.textContent = message;
    }

    function stopBootstrapPolling() {
      if (bootstrapPollTimer) clearInterval(bootstrapPollTimer);
      bootstrapPollTimer = null;
    }

    async function refreshExternalHost() {
      const snapshot = await MCP?.manager?.fetchExternalServers?.();
      if (snapshot && State?.set) {
        const current = State.get('mcp') || {};
        State.set('mcp', { ...current, externalHost: snapshot.host, externalServers: snapshot.servers || [] });
      }
      syncExternalServers();
      return snapshot;
    }

    async function pollBootstrapStatus() {
      try {
        const status = await MCP?.manager?.fetchExternalBootstrapStatus?.();
        if (!status) return;
        renderBootstrapStatus(status);
        if (status.state === 'running') return;
        stopBootstrapPolling();
        btnStartExternal.disabled = false;
        if (status.state === 'completed') {
          await MCP?.manager?.refreshExternalProvider?.();
          await refreshExternalHost();
        }
      } catch (_) {
        stopBootstrapPolling();
        btnStartExternal.disabled = false;
        renderBootstrapStatus({ message: t('mcp_bootstrap_status_unavailable') });
      }
    }

    function startBootstrapPolling() {
      stopBootstrapPolling();
      pollBootstrapStatus();
      bootstrapPollTimer = setInterval(pollBootstrapStatus, 1000);
    }

    btnStartExternal?.addEventListener?.('click', async () => {
      btnStartExternal.disabled = true;
      try {
        const status = await MCP?.manager?.startExternalHost?.();
        renderBootstrapStatus(status);
        if (status?.state === 'running') startBootstrapPolling();
        else {
          btnStartExternal.disabled = false;
          if (status?.state === 'completed') {
            await MCP?.manager?.refreshExternalProvider?.();
            await refreshExternalHost();
          }
        }
      } catch (_) {
        btnStartExternal.disabled = false;
        renderBootstrapStatus({ message: t('mcp_bootstrap_status_unavailable') });
      }
    });
    btnStopExternal?.addEventListener?.('click', async () => {
      btnStopExternal.disabled = true;
      try { await MCP?.manager?.stopExternalHost?.(); await refreshExternalHost(); }
      finally { btnStopExternal.disabled = false; }
    });

    function persistMcpAutoConnect(enabled, host = null, port = null) {
      const Config = getConfig();
      if (!Config) return;
      const patch = { mcpAutoConnect: enabled === true };
      if (host) patch.mcpHost = host;
      if (port) patch.mcpPort = sanitizePort(port);
      (Config.updateRuntime || Config.update)?.call(Config, patch);
    }

    elements.btnCopyCmd?.addEventListener?.('click', () => {
      const operatingSystem = getOsInput()?.value || DEFAULT_OPERATING_SYSTEM;
      const cmd = generateClipboardCommand(elements.portInput?.value, operatingSystem, t);
      copyCommandToClipboard(cmd, elements.btnCopyCmd, t);
    });

    elements.btnConnect?.addEventListener?.('click', async () => {
      const host = elements.hostInput?.value || DEFAULT_HOST;
      const port = sanitizePort(elements.portInput?.value || DEFAULT_PORT);
      persistMcpAutoConnect(true, host, port);
      await MCP?.manager?.connectProxy?.({ host, port, endpoint: buildMcpEndpoint(host, port) });
    });

    elements.btnDisconnect?.addEventListener?.('click', async () => {
      persistMcpAutoConnect(false);
      await MCP?.manager?.disconnectProxy?.();
    });

    const unsubscribe = State?.subscribe?.('mcp', (newState) => {
      if (newState?.status === 'connected') {
        persistMcpAutoConnect(true, newState.host, newState.port);
      }
      renderConnectionStatus(elements, newState, t);
    });
    renderConnectionStatus(elements, State?.get?.('mcp'), t);
    updateCommandAndEndpoint();
    syncSecurityControls();

    const handleLanguageChange = () => {
      renderConnectionStatus(elements, State?.get?.('mcp'), t);
      renderSavedAuthorizations(elements, t);
      syncExternalServers();
    };
    const I18n = getI18n();
    let unsubscribeLang = null;
    if (I18n?.onChange) {
      unsubscribeLang = I18n.onChange(handleLanguageChange);
    } else if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('zerochat:languagechange', handleLanguageChange);
      unsubscribeLang = () => window.removeEventListener('zerochat:languagechange', handleLanguageChange);
    }

    return {
      updateCommandAndEndpoint,
      openSetupModal: openModal,
      closeSetupModal: closeModal,
      startAutoConnectPolling,
      syncSecurityControls,
      syncExternalServers,
      render: () => renderConnectionStatus(elements, State?.get?.('mcp'), t),
      destroy: () => {
        if (pollTimer) clearInterval(pollTimer);
        stopBootstrapPolling();
        if (typeof unsubscribe === 'function') unsubscribe();
        if (typeof unsubscribeSecurity === 'function') unsubscribeSecurity();
        if (typeof unsubscribeLang === 'function') unsubscribeLang();
      }
    };
  }

  function getMcpSetupDialogHTML() {
    return `<div class="modal-header">
      <div class="modal-title">
        <svg class="ui-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-settings"></use></svg>
        <h3 data-i18n="mcp_setup_modal_title">Configuración del Servidor Local (MCP)</h3>
      </div>
      <button id="btn-close-mcp-setup" type="button" class="btn-close" data-i18n-aria="modal_close_aria" aria-label="Cerrar modal">
        <svg class="ui-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-close"></use></svg>
      </button>
    </div>
    <div class="modal-body mcp-setup-modal-body">
      <!-- Configuración de Host y Puerto (Rango 63xx) -->
      <div class="mcp-config-card">
        <div class="mcp-fields-grid">
          <div class="form-field">
            <label for="mcp-host-input" data-i18n="mcp_field_host">Host del servidor</label>
            <input type="text" id="mcp-host-input" class="form-input" value="127.0.0.1" placeholder="127.0.0.1" autocomplete="off" spellcheck="false">
          </div>
          <div class="form-field">
            <label for="mcp-port-input" data-i18n="mcp_field_port">Puerto (Rango 63xx recomendado)</label>
            <input type="number" id="mcp-port-input" class="form-input" value="6388" min="1024" max="65535" placeholder="6388">
          </div>
          <div class="form-field">
            <label for="mcp-os-select" data-i18n="mcp_field_os">Sistema operativo local</label>
            <select id="mcp-os-select" class="combobox-select-helper form-input" style="width: 100%; max-width: 100%;">
              <option value="linux" data-i18n="mcp_os_linux">Linux</option>
              <option value="windows" data-i18n="mcp_os_windows">Windows</option>
              <option value="android" data-i18n="mcp_os_android">Android / Termux</option>
            </select>
          </div>
        </div>
        <div class="mcp-endpoint-row">
          <span class="label-hint">Endpoint:</span>
          <code id="mcp-endpoint-preview" class="mcp-endpoint-preview">http://127.0.0.1:6388/sse</code>
        </div>
      </div>

      <!-- Instrucciones de Descarga y Arranque -->
      <div class="mcp-instructions-card">
        <div class="mcp-instructions-header">
          <span class="mcp-instructions-icon">
            <svg class="ui-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-terminal"></use></svg>
          </span>
          <div>
            <strong data-i18n="mcp_instructions_title">Instalación y Arranque del Servidor</strong>
            <p class="label-hint mcp-section-hint" data-i18n="mcp_instructions_desc">
              Descarga el servidor Python autogenerado y ejecútalo en tu terminal con python3 zmcp.py:
            </p>
          </div>
        </div>

        <div class="mcp-download-actions">
          <button type="button" id="btn-mcp-download-script" class="btn-primary btn-mcp-download" data-i18n-title="mcp_btn_download_title">
            <svg class="ui-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-download"></use></svg>
            <span data-i18n="mcp_btn_download_server">Descargar servidor (zmcp.py)</span>
          </button>
        </div>

        <div class="mcp-command-wrapper">
          <span class="label-hint" data-i18n="mcp_run_instruction">Comando de ejecución:</span>
          <div class="mcp-cmd-row">
            <pre class="mcp-command-box mcp-cmd-box-flex"><code id="mcp-terminal-command">python3 zmcp.py</code></pre>
            <button type="button" id="btn-mcp-copy-cmd" class="btn-secondary btn-copy-mcp-cmd" data-i18n-title="mcp_btn_copy_cmd" title="Copiar comando">
              <svg class="ui-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-copy"></use></svg>
              <span data-i18n="mcp_btn_copy_cmd">Copiar comando</span>
            </button>
          </div>
          <pre id="mcp-os-instructions" class="mcp-command-box mcp-os-instructions"></pre>
        </div>
      </div>
    </div>
    <div class="modal-footer">
      <div class="footer-actions-right mcp-modal-footer-end">
        <button type="button" id="btn-close-mcp-setup-footer" class="btn-primary" data-i18n="btn_close">Cerrar</button>
      </div>
    </div>`;
  }

  function ensureDialogMarkup() {
    if (typeof document === 'undefined') return;
    const dialog = document.getElementById('mcp-setup-dialog');
    if (dialog && !dialog.firstElementChild) {
      dialog.innerHTML = getMcpSetupDialogHTML();
    }
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', ensureDialogMarkup);
    } else {
      ensureDialogMarkup();
    }
  }

  async function autoConnectIfAvailable(options = {}) {
    const Config = getConfig();
    const MCP = getMCP();
    const currentConfig = Config?.get?.() || Config?.getActive?.() || {};
    const host = options.host || currentConfig.mcpHost || DEFAULT_HOST;
    const port = sanitizePort(options.port || currentConfig.mcpPort || DEFAULT_PORT);
    const timeoutMs = options.timeoutMs || 1500;

    if (MCP?.manager?.autoConnectIfAvailable) {
      return await MCP.manager.autoConnectIfAvailable({ host, port, timeoutMs });
    }
    return { success: false, available: false };
  }

  return {
    DEFAULT_HOST,
    DEFAULT_PORT,
    DEFAULT_OPERATING_SYSTEM,
    sanitizePort,
    sanitizeHost,
    sanitizeOperatingSystem,
    buildMcpEndpoint,
    generateTerminalCommand,
    generateOperatingSystemInstructions,
    generateClipboardCommand,
    generateMcpServerScript,
    downloadMcpServerScript,
    copyCommandToClipboard,
    renderConnectionStatus,
    renderToolsList,
    renderExternalServers,
    initMcpUI,
    autoConnectIfAvailable,
    ensureDialogMarkup,
    getMcpSetupDialogHTML
  };
});
