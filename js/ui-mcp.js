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
  const escapeHtml = value => getUtils()?.escapeHtml ? getUtils().escapeHtml(value) : '';

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

  function generateTerminalCommand() {
    return 'pip install zerochat && zerochat';
  }

  async function copyCommandToClipboard(text, btnElement, translator = t) {
    if (!text) return false;
    let ok = false;
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(text); ok = true; } catch (e) {}
    }
    if (!ok && typeof document !== 'undefined' && document.body) {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      try { ok = document.execCommand('copy'); } catch (e) {}
      textarea.remove();
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

  function renderExternalServers(container, servers, translator = t) {
    if (!container) return;
    if (!Array.isArray(servers) || servers.length === 0) {
      container.innerHTML = `<div class="mcp-servers-empty label-hint">${escapeHtml(translator('mcp_servers_empty'))}</div>`;
      return;
    }
    const language = getI18n()?.getLanguage?.() || 'es';
    container.innerHTML = servers.map(server => {
      const isRunning = server.status === 'running';
      const isStarting = server.status === 'starting';
      const isInstalling = server.status === 'installing';
      const isBusy = isStarting || isInstalling;
      const statusClass = isRunning ? 'status-running' : (isBusy ? 'status-starting' : (server.status === 'error' ? 'status-error' : 'status-stopped'));
      const statusLabel = translator(`mcp_external_status_${server.status || 'stopped'}`);
      const desc = escapeHtml(server.description?.[language] || server.description?.es || server.description || '');
      const err = server.error ? `<p class="mcp-server-error">${escapeHtml(server.error)}</p>` : '';
      let optionsHtml = '';
      if (Array.isArray(server.options) && server.options.length > 0) {
        optionsHtml = `<div class="mcp-server-options">` + server.options.map(opt => {
          const optLabel = escapeHtml(opt.label?.[language] || opt.label?.es || opt.label || opt.id);
          const optDesc = opt.description ? `<span class="label-hint">${escapeHtml(opt.description?.[language] || opt.description?.es || opt.description || '')}</span>` : '';
          const userVal = server.userOptions && opt.id in server.userOptions ? server.userOptions[opt.id] : opt.default;
          if (opt.type === 'boolean') {
            const isChecked = Boolean(userVal);
            return `
              <div class="mcp-server-option-row">
                <label class="switch switch-sm">
                  <input type="checkbox" class="mcp-server-option-checkbox" data-server-id="${escapeHtml(server.id)}" data-option-id="${escapeHtml(opt.id)}" ${isChecked ? 'checked' : ''}>
                  <span class="slider round"></span>
                </label>
                <div class="mcp-server-option-meta">
                  <span class="mcp-server-option-label">${optLabel}</span>
                  ${optDesc}
                </div>
              </div>`;
          }
          return '';
        }).join('') + `</div>`;
      }

      return `
        <div class="mcp-server-item" data-server-id="${escapeHtml(server.id)}">
          <div class="mcp-server-info">
            <div class="mcp-server-title-row">
              <strong class="mcp-server-name">${escapeHtml(server.displayName?.[language] || server.displayName?.es || server.displayName || server.id)}</strong>
              <span class="mcp-server-badge ${statusClass}">${escapeHtml(statusLabel)}</span>
              ${server.toolCount ? `<span class="mcp-server-tool-count">${escapeHtml(translator('mcp_servers_count_tools', { count: server.toolCount }))}</span>` : ''}
            </div>
            ${desc ? `<p class="mcp-server-desc">${desc}</p>` : ''}
            ${err}
            ${optionsHtml}
          </div>
          <div class="mcp-server-actions">
            <button type="button" class="btn-mcp-server-toggle ${isRunning ? 'btn-danger' : 'btn-secondary'}" data-server-id="${escapeHtml(server.id)}" data-action="${isRunning ? 'stop' : 'start'}" ${isBusy ? 'disabled' : ''}>
              ${escapeHtml(isRunning ? translator('mcp_btn_stop_server') : translator('mcp_btn_start_server'))}
            </button>
          </div>
        </div>`;
    }).join('');

    container.querySelectorAll?.('.mcp-server-option-checkbox').forEach(cb => {
      cb.addEventListener?.('change', async () => {
        const sid = cb.getAttribute?.('data-server-id');
        const optId = cb.getAttribute?.('data-option-id');
        if (!sid || !optId) return;
        cb.disabled = true;
        const MCP = getMCP();
        try {
          await MCP?.manager?.configureExternalServer?.(sid, {
            options: { [optId]: cb.checked }
          });
          const updated = await MCP?.manager?.fetchExternalServers?.();
          const State = getState();
          if (updated && State?.set) {
            const current = State.get('mcp') || {};
            State.set('mcp', {
              ...current,
              externalHost: updated.host || 'running',
              externalServers: updated.servers || []
            });
          }
        } catch (e) {
          console.error('[MCP UI] Error configuring server option:', e);
          cb.checked = !cb.checked;
        } finally {
          cb.disabled = false;
        }
      });
    });

    container.querySelectorAll?.('.btn-mcp-server-toggle').forEach(btn => {
      btn.addEventListener?.('click', async () => {
        const sid = btn.getAttribute?.('data-server-id');
        const action = btn.getAttribute?.('data-action');
        if (!sid) return;
        btn.disabled = true;
        const MCP = getMCP();
        try {
          if (action === 'start') {
            await MCP?.manager?.startExternalServer?.(sid);
          } else {
            await MCP?.manager?.stopExternalServer?.(sid);
          }
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

    if (elements.statusBadge) elements.statusBadge.className = `mcp-status-badge mcp-status-${status}`;
    if (elements.statusText) {
      if (typeof elements.statusText.setAttribute === 'function') {
        elements.statusText.setAttribute('data-i18n', `mcp_status_${status}`);
      }
      elements.statusText.textContent = translator(`mcp_status_${status}`);
    }

    if (elements.serverDetails) {
      elements.serverDetails.style.display = isConn ? 'inline-flex' : 'none';
      clearSafeContent(elements.serverDetails);
      if (isConn) {
        const name = state.serverInfo?.name || 'mcp-proxy';
        const ver = state.serverInfo?.version ? ` v${state.serverInfo.version}` : '';
        const latency = Number(state.latencyMs);
        const lat = Number.isFinite(latency) && latency > 0 ? ` · ${latency}ms` : '';
        const count = Array.isArray(state.tools) ? state.tools.length : 0;
        const toolLabel = count > 0 ? translator('mcp_tools_discovered', { count }) : translator('mcp_no_tools');
        const titleStr = `${name}${ver}${lat}`.trim();
        if (typeof elements.serverDetails.setAttribute === 'function') {
          elements.serverDetails.setAttribute('title', titleStr);
        }
        elements.serverDetails.title = titleStr;
        appendSafeText(elements.serverDetails, 'span', toolLabel, { className: 'mcp-detail-item' });
      }
    }

    if (elements.bootstrapCard) elements.bootstrapCard.style.display = isConn ? 'none' : 'block';
    if (elements.reconnectHint) {
      elements.reconnectHint.style.display = status === 'disconnected' ? 'block' : 'none';
      if (typeof elements.reconnectHint.setAttribute === 'function') {
        elements.reconnectHint.setAttribute('data-i18n', 'mcp_reconnect_after_restart');
      }
      elements.reconnectHint.textContent = translator('mcp_reconnect_after_restart');
    }
    if (elements.commandSnippet) elements.commandSnippet.textContent = generateTerminalCommand();

    if (elements.toolsContainer) {
      const currentConfig = getConfig()?.get?.() || {};
      const allTools = isConn ? (state.tools || []) : [];
      renderToolsList(elements.toolsContainer, allTools, currentConfig.enabledTools || {}, translator);
    }

    if (elements.serversList) {
      const servers = isConn ? (state.externalServers || []) : [];
      renderExternalServers(elements.serversList, servers, translator);
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
            const allTools = state.tools || [];
            renderToolsList(elements.toolsContainer, allTools, currentConfig.enabledTools || {}, translator);
          }
        }
      });
    });
  }

  function initMcpUI(elements, options = {}) {
    if (!elements) return null;
    const State = getState();
    const Security = getSecurity();

    // Controles de Seguridad MCP
    const radioAsk = elements.mcpSetupDialog?.querySelector?.('#mcp-policy-ask') || (typeof document !== 'undefined' ? document.getElementById('mcp-policy-ask') : null);
    const radioAllowAll = elements.mcpSetupDialog?.querySelector?.('#mcp-policy-allow-all') || (typeof document !== 'undefined' ? document.getElementById('mcp-policy-allow-all') : null);
    const btnClearAuths = elements.mcpSetupDialog?.querySelector?.('#btn-mcp-clear-auths') || (typeof document !== 'undefined' ? document.getElementById('btn-mcp-clear-auths') : null);

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
        const allTools = st.tools || [];
        renderToolsList(elements.toolsContainer, allTools, currentCfg.enabledTools || {}, t);
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

    elements.btnCopyCmd?.addEventListener?.('click', () => {
      copyCommandToClipboard(generateTerminalCommand(), elements.btnCopyCmd, t);
    });


    const unsubscribe = State?.subscribe?.('mcp', (newState) => {
      renderConnectionStatus(elements, newState, t);
    });
    renderConnectionStatus(elements, State?.get?.('mcp'), t);
    syncSecurityControls();

    async function syncExternalServers() {
      if (!elements.serversList) return;
      const MCP = getMCP();
      const State = getState();
      if (State?.get?.('mcp')?.status !== 'connected') {
        renderExternalServers(elements.serversList, [], t);
        return;
      }
      try {
        await MCP?.manager?.syncExternalServers?.();
      } catch (e) {
        console.warn('[MCP UI] syncExternalServers failed:', e);
      }
    }

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
      syncSecurityControls,
      syncExternalServers,
      render: () => renderConnectionStatus(elements, State?.get?.('mcp'), t),
      destroy: () => {
        if (typeof unsubscribe === 'function') unsubscribe();
        if (typeof unsubscribeSecurity === 'function') unsubscribeSecurity();
        if (typeof unsubscribeLang === 'function') unsubscribeLang();
      }
    };
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

  async function verifyActiveConnection(options = {}) {
    const MCP = getMCP();
    return MCP?.manager?.verifyProxyConnection
      ? MCP.manager.verifyProxyConnection({ timeoutMs: options.timeoutMs || 1500 })
      : { success: false, skipped: true };
  }

  return {
    DEFAULT_HOST,
    DEFAULT_PORT,
    sanitizePort,
    sanitizeHost,
    buildMcpEndpoint,
    generateTerminalCommand,
    copyCommandToClipboard,
    renderConnectionStatus,
    renderToolsList,
    renderExternalServers,
    initMcpUI,
    autoConnectIfAvailable,
    verifyActiveConnection
  };
});
