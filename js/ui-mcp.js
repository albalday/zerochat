/**
 * Módulo de Presentación e Interfaz de Usuario para MCP (Model Context Protocol).
 * ZeroChat - js/ui-mcp.js
 *
 * Responsabilidades:
 * - Generación de comando terminal reactivo para el entorno privado de mcp-proxy.
 * - Saneamiento y construcción normalizada de endpoints HTTP/SSE.
 * - Renderizado de estado de conexión (badge, semáforo, latencia, herramientas).
 * - Copia accesible al portapapeles con confirmación visual.
 * - Vinculación de eventos de conexión/desconexión con ChatState y ChatMCP.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.ChatUIMcp = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULT_HOST = '127.0.0.1';
  const DEFAULT_PORT = 6388;

  const resolveDep = (name, path) => (typeof window !== 'undefined' && window[name]) || (typeof require !== 'undefined' ? (() => { try { return require(path); } catch (e) { return null; } })() : null);
  const getI18n = () => resolveDep('ChatI18n', './i18n.js');
  const getIcons = () => resolveDep('ChatIcons', './icons.js');
  const getState = () => resolveDep('ChatState', './state.js');
  const getMCP = () => resolveDep('ChatMCP', './mcp.js');
  const getConfig = () => resolveDep('ChatConfig', './config-store.js');

  const t = (k, p) => getI18n()?.t ? getI18n().t(k, p) : k;
  const escapeHtml = (s) => s == null ? '' : String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function sanitizePort(port) {
    const p = parseInt(port, 10);
    return (Number.isInteger(p) && p >= 1024 && p <= 65535) ? p : DEFAULT_PORT;
  }

  function sanitizeHost(host) {
    return String(host || '').trim() || DEFAULT_HOST;
  }

  function buildMcpEndpoint(host, port, path = '/sse') {
    const p = path ? (path.startsWith('/') ? path : `/${path}`) : '/sse';
    return `http://${sanitizeHost(host)}:${sanitizePort(port)}${p}`;
  }

  function generateTerminalCommand(port) {
    return `mkdir -p ~/.zerochat && python3 -m venv ~/.zerochat/mcp-env && ~/.zerochat/mcp-env/bin/pip install -U "mcp<2" mcp-proxy && ([ -f scripts/mcp_server.py ] && cp scripts/mcp_server.py ~/.zerochat/server.py || true) && ~/.zerochat/mcp-env/bin/mcp-proxy --port ${sanitizePort(port)} --allow-origin="*" -- ~/.zerochat/mcp-env/bin/python3 ~/.zerochat/server.py`;
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
      setTimeout(() => { btnElement.innerHTML = orig; btnElement.classList.remove('btn-copied'); }, 2000);
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

      return `
        <div class="mcp-tool-card" data-tool-id="${escapeHtml(id)}">
          <div class="mcp-tool-info">
            <div class="mcp-tool-title-row">
              <span class="mcp-tool-icon">${plug16}</span>
              <span class="mcp-tool-name">${escapeHtml(tool.name)}</span>
              <span class="mcp-tool-badge">${badgeText}</span>
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

  function renderConnectionStatus(elements, mcpState, translator = t) {
    if (!elements) return;
    const state = mcpState || { status: 'disconnected', host: DEFAULT_HOST, port: DEFAULT_PORT, tools: [] };
    const status = state.status || 'disconnected';
    const isConn = status === 'connected';
    const isConnecting = status === 'connecting';
    const Icons = getIcons();

    if (elements.statusBadge) elements.statusBadge.className = `mcp-status-badge mcp-status-${status}`;
    if (elements.statusText) elements.statusText.textContent = translator(`mcp_status_${status}`);

    if (elements.btnConnect) {
      elements.btnConnect.style.display = isConn ? 'none' : 'inline-flex';
      elements.btnConnect.disabled = isConnecting;
      const icon = isConnecting ? (Icons?.get?.('spinner', { size: 14, className: 'spinning' }) || '') : (Icons?.get?.('plug', { size: 14 }) || '');
      const label = translator(isConnecting ? 'mcp_btn_connecting' : 'mcp_btn_connect');
      elements.btnConnect.innerHTML = `${icon} <span>${label}</span>`;
    }

    if (elements.btnDisconnect) elements.btnDisconnect.style.display = isConn ? 'inline-flex' : 'none';

    if (elements.serverDetails) {
      elements.serverDetails.style.display = isConn ? 'flex' : 'none';
      if (isConn) {
        const name = state.serverInfo?.name || 'mcp-proxy';
        const ver = state.serverInfo?.version ? ` v${state.serverInfo.version}` : '';
        const lat = state.latencyMs ? ` · ${state.latencyMs}ms` : '';
        const count = state.tools?.length || 0;
        const toolLabel = count > 0 ? translator('mcp_tools_discovered', { count }) : translator('mcp_no_tools');
        elements.serverDetails.innerHTML = `
          <span class="mcp-detail-item"><strong>${name}${ver}</strong></span>
          ${lat ? `<span class="mcp-detail-item mcp-latency-tag">${lat}</span>` : ''}
          <span class="mcp-detail-item mcp-tools-tag">${toolLabel}</span>`;
      } else {
        elements.serverDetails.innerHTML = '';
      }
    }

    if (elements.errorMessage) {
      const showErr = status === 'error' && state.error;
      elements.errorMessage.style.display = showErr ? 'flex' : 'none';
      elements.errorMessage.innerHTML = showErr ? `${Icons?.get?.('alert-circle', { size: 16 }) || ''} <span>${state.error}</span>` : '';
    }

    const host = elements.hostInput?.value || state.host || DEFAULT_HOST;
    const port = elements.portInput?.value || state.port || DEFAULT_PORT;
    if (elements.commandSnippet) elements.commandSnippet.textContent = generateTerminalCommand(port);
    if (elements.endpointPreview) elements.endpointPreview.textContent = buildMcpEndpoint(host, port);

    if (elements.toolsContainer) {
      const currentConfig = getConfig()?.get?.() || {};
      renderToolsList(elements.toolsContainer, isConn ? (state.tools || []) : [], currentConfig.enabledTools || {}, translator);
    }
  }

  function initMcpUI(elements, options = {}) {
    ensureDialogMarkup();
    if (!elements) return null;
    const State = getState();
    const MCP = getMCP();
    const Config = getConfig();

    const currentConfig = Config?.get?.() || {};
    if (elements.hostInput && !elements.hostInput.value) elements.hostInput.value = currentConfig.mcpHost || DEFAULT_HOST;
    if (elements.portInput && !elements.portInput.value) elements.portInput.value = currentConfig.mcpPort || DEFAULT_PORT;

    function updateCommandAndEndpoint() {
      const host = elements.hostInput?.value || DEFAULT_HOST;
      const port = elements.portInput?.value || DEFAULT_PORT;
      if (elements.commandSnippet) elements.commandSnippet.textContent = generateTerminalCommand(port);
      if (elements.endpointPreview) elements.endpointPreview.textContent = buildMcpEndpoint(host, port);
      Config?.update?.({ mcpHost: host, mcpPort: sanitizePort(port) });
    }

    elements.portInput?.addEventListener?.('input', updateCommandAndEndpoint);
    elements.hostInput?.addEventListener?.('input', updateCommandAndEndpoint);

    const openModal = () => elements.mcpSetupDialog?.showModal?.();
    const closeModal = () => elements.mcpSetupDialog?.close?.();
    elements.btnConfigure?.addEventListener?.('click', openModal);
    elements.btnCloseSetup?.addEventListener?.('click', closeModal);
    elements.btnCloseSetupFooter?.addEventListener?.('click', closeModal);
    elements.mcpSetupDialog?.addEventListener?.('click', (e) => { if (e.target === elements.mcpSetupDialog) closeModal(); });

    elements.btnCopyCmd?.addEventListener?.('click', () => {
      const cmd = elements.commandSnippet?.textContent || generateTerminalCommand(elements.portInput?.value);
      copyCommandToClipboard(cmd, elements.btnCopyCmd, t);
    });

    elements.btnConnect?.addEventListener?.('click', async () => {
      const host = elements.hostInput?.value || DEFAULT_HOST;
      const port = sanitizePort(elements.portInput?.value || DEFAULT_PORT);
      await MCP?.manager?.connectProxy?.({ host, port, endpoint: buildMcpEndpoint(host, port) });
    });

    elements.btnDisconnect?.addEventListener?.('click', () => MCP?.manager?.disconnectProxy?.());

    const unsubscribe = State?.subscribe?.('mcp', (newState) => renderConnectionStatus(elements, newState, t));
    renderConnectionStatus(elements, State?.get?.('mcp'), t);
    updateCommandAndEndpoint();

    return {
      updateCommandAndEndpoint,
      openSetupModal: openModal,
      closeSetupModal: closeModal,
      render: () => renderConnectionStatus(elements, State?.get?.('mcp'), t),
      destroy: () => { if (typeof unsubscribe === 'function') unsubscribe(); }
    };
  }

  function getMcpSetupDialogHTML() {
    return `<div class="modal-header">
      <div class="modal-title">
        <svg class="ui-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-settings"></use></svg>
        <h3 data-i18n="mcp_setup_modal_title">Configuración de MCP (mcp-proxy)</h3>
      </div>
      <button id="btn-close-mcp-setup" type="button" class="btn-close" data-i18n-aria="modal_close_aria" aria-label="Cerrar modal">
        <svg class="ui-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-close"></use></svg>
      </button>
    </div>
    <div class="modal-body" style="padding: 1.25rem;">
      <!-- Configuración de Host y Puerto (Rango 63xx) -->
      <div class="mcp-config-card">
        <div class="mcp-fields-grid">
          <div class="form-field">
            <label for="mcp-host-input" data-i18n="mcp_field_host">Host del proxy</label>
            <input type="text" id="mcp-host-input" class="form-input" value="127.0.0.1" placeholder="127.0.0.1" autocomplete="off" spellcheck="false">
          </div>
          <div class="form-field">
            <label for="mcp-port-input" data-i18n="mcp_field_port">Puerto (Rango 63xx recomendado)</label>
            <input type="number" id="mcp-port-input" class="form-input" value="6388" min="1024" max="65535" placeholder="6388">
          </div>
        </div>
        <div class="mcp-endpoint-row">
          <span class="label-hint">Endpoint:</span>
          <code id="mcp-endpoint-preview" class="mcp-endpoint-preview">http://127.0.0.1:6388/sse</code>
        </div>
      </div>

      <!-- Instrucciones de Descarga, Actualización y Arranque (Ayuda) -->
      <div class="mcp-instructions-card">
        <div class="mcp-instructions-header">
          <span class="mcp-instructions-icon">
            <svg class="ui-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-terminal"></use></svg>
          </span>
          <div>
            <strong data-i18n="mcp_instructions_title">Instrucciones de Instalación y Arranque</strong>
            <p class="label-hint" style="margin-top: 0.15rem;" data-i18n="mcp_instructions_desc">
              Ejecuta el siguiente comando en tu terminal para instalar/actualizar y arrancar mcp-proxy en un entorno Python privado (~/.zerochat/mcp-env):
            </p>
          </div>
        </div>

        <div class="mcp-command-wrapper">
          <pre class="mcp-command-box"><code id="mcp-terminal-command">mkdir -p ~/.zerochat && python3 -m venv ~/.zerochat/mcp-env && ~/.zerochat/mcp-env/bin/pip install -U "mcp<2" mcp-proxy && ([ -f scripts/mcp_server.py ] && cp scripts/mcp_server.py ~/.zerochat/server.py || true) && ~/.zerochat/mcp-env/bin/mcp-proxy --port 6388 --allow-origin="*" -- ~/.zerochat/mcp-env/bin/python3 ~/.zerochat/server.py</code></pre>
          <button type="button" id="btn-mcp-copy-cmd" class="btn-secondary btn-copy-mcp-cmd" data-i18n-title="mcp_btn_copy_cmd" title="Copiar comando">
            <svg class="ui-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-copy"></use></svg>
            <span data-i18n="mcp_btn_copy_cmd">Copiar comando</span>
          </button>
        </div>
      </div>
    </div>
    <div class="modal-footer">
      <div class="footer-actions-right" style="margin-left: auto;">
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
    sanitizePort,
    sanitizeHost,
    buildMcpEndpoint,
    generateTerminalCommand,
    copyCommandToClipboard,
    renderConnectionStatus,
    renderToolsList,
    initMcpUI,
    autoConnectIfAvailable,
    ensureDialogMarkup,
    getMcpSetupDialogHTML
  };
});

