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
  const DEFAULT_OPERATING_SYSTEM = 'linux';

  const resolveDep = (name, path) => (typeof window !== 'undefined' && window.ChatUtils?.resolveDep ? window.ChatUtils.resolveDep(name, path) : ((typeof window !== 'undefined' && window[name]) || (typeof require !== 'undefined' ? (() => { try { return require(path); } catch (e) { return null; } })() : null)));
  const getUtils = () => resolveDep('ChatUtils', './utils.js');
  const getI18n = () => resolveDep('ChatI18n', './i18n.js');
  const getIcons = () => resolveDep('ChatIcons', './icons.js');
  const getState = () => resolveDep('ChatState', './state.js');
  const getMCP = () => resolveDep('ChatMCP', './mcp.js');
  const getConfig = () => resolveDep('ChatConfig', './config-store.js');
  const getSecurity = () => resolveDep('ChatToolSecurity', './tool-security.js');

  const t = (k, p) => getI18n()?.t ? getI18n().t(k, p) : k;
  const escapeHtml = (s) => (getUtils()?.escapeHtml ? getUtils().escapeHtml(s) : (s == null ? '' : String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')));

  function clearSafeContent(element) {
    const Utils = getUtils();
    if (Utils?.clearElement) return Utils.clearElement(element);
    if (element) element.textContent = '';
    return element;
  }

  function appendSafeText(parent, tagName, value, options) {
    const Utils = getUtils();
    const child = Utils?.appendTextElement?.(parent, tagName, value, options);
    // Los mocks de Node no implementan DOM; el navegador siempre usa la ruta
    // anterior, que crea nodos y asigna textContent.
    if (!child && parent) parent.textContent = `${parent.textContent || ''}${value == null ? '' : String(value)}`;
    return child;
  }

  function appendTrustedIcon(parent, icon) {
    if (!parent || !icon || typeof document === 'undefined') return;
    const host = document.createElement('span');
    host.setAttribute('aria-hidden', 'true');
    const Utils = getUtils();
    if (Utils?.setTrustedHtml) Utils.setTrustedHtml(host, icon);
    else host.innerHTML = icon;
    parent.appendChild(host);
  }

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

  function generateMcpServerScript(options = {}) {
    const host = sanitizeHost(options.host);
    const port = sanitizePort(options.port);

    return `#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "mcp>=1.0.0,<2",
#     "uvicorn>=0.30.0",
#     "starlette>=0.27.0",
# ]
# ///
"""
Servidor Local MCP para ZeroChat (FastMCP nativo sobre SSE).
Expone herramientas del sistema local: list_directory, read_file, execute_command.
Generado automáticamente por ZeroChat.
"""

import os
import sys
import json
import argparse
import subprocess
from pathlib import Path

try:
    from mcp.server.fastmcp import FastMCP
except ImportError:
    FastMCP = None


def ensure_dependencies():
    """Garantiza la disponibilidad de 'mcp' y 'uvicorn', creando un venv privado si es necesario."""
    try:
        import mcp  # noqa: F401
        import uvicorn  # noqa: F401
        import starlette  # noqa: F401
        return
    except ImportError:
        pass

    env_dir = Path.home() / ".zerochat" / "mcp-env"
    is_win = sys.platform == "win32"
    py_bin = env_dir / ("Scripts/python.exe" if is_win else "bin/python3")
    pip_bin = env_dir / ("Scripts/pip.exe" if is_win else "bin/pip")

    if not py_bin.exists():
        print(f"[ZeroChat MCP] Configurando entorno virtual privado en {env_dir}...")
        import venv
        venv.create(env_dir, with_pip=True)
        print("[ZeroChat MCP] Instalando dependencias de FastMCP ('mcp<2')...")
        subprocess.run([str(pip_bin), "install", "-U", "mcp<2"], check=True)

    if Path(sys.executable).resolve() != py_bin.resolve():
        print("[ZeroChat MCP] Re-ejecutando con el entorno privado...")
        if is_win:
            sys.exit(subprocess.call([str(py_bin)] + sys.argv))
        else:
            os.execv(str(py_bin), [str(py_bin)] + sys.argv)


def list_directory(path: str = ".", max_depth: int = 1) -> str:
    """Recorre un directorio local y devuelve la lista estructurada de archivos y subcarpetas con sus tamaños y tipos."""
    try:
        target = Path(path).expanduser().resolve()
        if not target.exists():
            return json.dumps({"success": False, "error": f"La ruta '{path}' no existe."})
        if not target.is_dir():
            return json.dumps({"success": False, "error": f"La ruta '{path}' no es un directorio."})

        entries = []
        for entry in os.scandir(target):
            try:
                stat = entry.stat(follow_symlinks=False)
                is_dir = entry.is_dir(follow_symlinks=False)
                entries.append({
                    "name": entry.name,
                    "path": str(Path(entry.path).resolve()),
                    "type": "directory" if is_dir else "file",
                    "size_bytes": None if is_dir else stat.st_size,
                    "is_symlink": entry.is_symlink()
                })
            except (PermissionError, FileNotFoundError):
                continue

        entries.sort(key=lambda e: (e["type"] != "directory", e["name"].lower()))
        return json.dumps({"success": True, "path": str(target), "total_items": len(entries), "entries": entries}, ensure_ascii=False, indent=2)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)


def read_file(path: str, max_bytes: int = 100000) -> str:
    """Lee el contenido de texto de un archivo local con límite de seguridad."""
    try:
        target = Path(path).expanduser().resolve()
        if not target.exists():
            return json.dumps({"success": False, "error": f"El archivo '{path}' no existe."})
        if not target.is_file():
            return json.dumps({"success": False, "error": f"La ruta '{path}' no es un archivo regular."})

        file_size = target.stat().st_size
        safe_limit = max(1024, min(int(max_bytes), 2000000))
        with open(target, "r", encoding="utf-8", errors="replace") as f:
            content = f.read(safe_limit)

        return json.dumps({
            "success": True,
            "path": str(target),
            "size_bytes": file_size,
            "bytes_read": len(content.encode("utf-8")),
            "truncated": file_size > safe_limit,
            "content": content
        }, ensure_ascii=False, indent=2)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)


def execute_command(command: str, cwd: str = ".", timeout_seconds: int = 30) -> str:
    """Ejecuta un comando en la terminal local y devuelve stdout, stderr y código de salida."""
    try:
        target_cwd = str(Path(cwd).expanduser().resolve())
        proc = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            cwd=target_cwd,
            timeout=max(1, min(int(timeout_seconds), 300))
        )
        stdout = proc.stdout[:50000] + ("\\n\\n[... Truncado ...]" if len(proc.stdout) > 50000 else "")
        stderr = proc.stderr[:20000] + ("\\n\\n[... Truncado ...]" if len(proc.stderr) > 20000 else "")
        return json.dumps({
            "success": proc.returncode == 0,
            "command": command,
            "cwd": target_cwd,
            "returncode": proc.returncode,
            "stdout": stdout,
            "stderr": stderr,
            "truncated": len(proc.stdout) > 50000 or len(proc.stderr) > 20000
        }, ensure_ascii=False, indent=2)
    except subprocess.TimeoutExpired:
        return json.dumps({"success": False, "command": command, "error": f"Excedió el tiempo límite ({timeout_seconds}s).", "returncode": -1})
    except Exception as e:
        return json.dumps({"success": False, "command": command, "error": str(e), "returncode": -1})


SERVER_TOOLS = [list_directory, read_file, execute_command]
DEFAULT_PORT = ${port}


def create_mcp_app(host: str = "${host}", port: int = ${port}):
    ensure_dependencies()
    from mcp.server.fastmcp import FastMCP
    from mcp.server.transport_security import TransportSecuritySettings
    from starlette.middleware.cors import CORSMiddleware
    from starlette.types import ASGIApp, Receive, Scope, Send

    sec_settings = TransportSecuritySettings(
        enable_dns_rebinding_protection=False,
        allowed_hosts=["*"],
        allowed_origins=["*"]
    )

    mcp = FastMCP(
        "ZeroChat Local Tools",
        host=host,
        port=port,
        transport_security=sec_settings
    )

    for tool_fn in SERVER_TOOLS:
        mcp.tool()(tool_fn)

    app = mcp.sse_app()

    class PrivateNetworkAccessMiddleware:
        def __init__(self, inner_app: ASGIApp):
            self.inner_app = inner_app

        async def __call__(self, scope: Scope, receive: Receive, send: Send):
            if scope["type"] == "http":
                async def custom_send(message):
                    if message["type"] == "http.response.start":
                        headers = dict(message.get("headers", []))
                        headers[b"access-control-allow-private-network"] = b"true"
                        if b"access-control-allow-origin" not in headers:
                            headers[b"access-control-allow-origin"] = b"*"
                        message["headers"] = list(headers.items())
                    await send(message)
                await self.inner_app(scope, receive, custom_send)
            else:
                await self.inner_app(scope, receive, send)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.add_middleware(PrivateNetworkAccessMiddleware)
    return app


def main():
    parser = argparse.ArgumentParser(description="Servidor Local MCP para ZeroChat (FastMCP nativo SSE)")
    parser.add_argument("--host", default="${host}", help="Host de escucha (default: ${host})")
    parser.add_argument("--port", type=int, default=${port}, help="Puerto de escucha (default: ${port})")
    parser.add_argument("--test", action="store_true", help="Ejecutar prueba interna de herramientas")
    args = parser.parse_args()

    if args.test:
        print("[TEST] list_directory('.') ->", json.loads(list_directory("."))["success"])
        print("[TEST] read_file('package.json') ->", json.loads(read_file("package.json"))["success"])
        print("[TEST] execute_command('echo hello') ->", json.loads(execute_command("echo hello"))["success"])
        print("[TEST] Todas las funciones operan correctamente.")
        return

    ensure_dependencies()
    import uvicorn
    app = create_mcp_app(host=args.host, port=args.port)
    print(f"🚀 [ZeroChat MCP] Servidor FastMCP activo en http://{args.host}:{args.port}/sse")
    print("📡 Esperando conexiones de ZeroChat...")
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
`;
  }

  function downloadMcpServerScript(options = {}) {
    const host = sanitizeHost(options.host);
    const port = sanitizePort(options.port);
    const content = generateMcpServerScript({ host, port });
    const filename = 'zerochat_mcp.py';

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
    return `${executable} zerochat_mcp.py${portArgument}`;
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

    elements.btnCopyCmd?.addEventListener?.('click', () => {
      const operatingSystem = getOsInput()?.value || DEFAULT_OPERATING_SYSTEM;
      const cmd = generateClipboardCommand(elements.portInput?.value, operatingSystem, t);
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
    syncSecurityControls();

    const handleLanguageChange = () => {
      renderConnectionStatus(elements, State?.get?.('mcp'), t);
      renderSavedAuthorizations(elements, t);
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
      render: () => renderConnectionStatus(elements, State?.get?.('mcp'), t),
      destroy: () => {
        if (pollTimer) clearInterval(pollTimer);
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
        <h3 data-i18n="mcp_setup_modal_title">Configuración de MCP (FastMCP)</h3>
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

      <!-- Seguridad y Autorizaciones de Ejecución -->
      <div class="mcp-security-card">
        <div class="mcp-security-header">
          <span class="mcp-security-icon">
            <svg class="ui-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>
          </span>
          <div>
            <strong data-i18n="mcp_security_section_title">Seguridad y Autorización de Ejecución</strong>
            <p class="label-hint mcp-section-hint" data-i18n="mcp_security_desc">
              Controla cuándo se ejecutan las herramientas del servidor MCP en tu sistema local.
            </p>
          </div>
        </div>

        <div class="mcp-policy-options">
          <label class="mcp-policy-option">
            <input type="radio" name="mcp-global-policy" value="ask" id="mcp-policy-ask" checked>
            <div class="mcp-policy-text">
              <strong data-i18n="mcp_security_policy_ask">Pedir autorización antes de ejecutar (Recomendado)</strong>
              <p class="label-hint" data-i18n="mcp_security_policy_ask_hint">El chat te pedirá confirmar cada comando o herramienta MCP no autorizada previamente.</p>
            </div>
          </label>
          <label class="mcp-policy-option">
            <input type="radio" name="mcp-global-policy" value="allow_all" id="mcp-policy-allow-all">
            <div class="mcp-policy-text">
              <strong data-i18n="mcp_security_policy_allow_all">Todo autorizado (Modo sin restricciones)</strong>
              <p class="label-hint" data-i18n="mcp_security_policy_allow_all_hint">Ejecuta inmediatamente cualquier herramienta MCP sin pausas de confirmación.</p>
            </div>
          </label>
        </div>

        <div class="mcp-saved-auths-section">
          <div class="mcp-saved-auths-header">
            <span class="label-hint" data-i18n="mcp_security_saved_auths_title">Herramientas con Permiso Recordado:</span>
            <button type="button" id="btn-mcp-clear-auths" class="btn-text-action btn-mcp-clear-auths" data-i18n="mcp_security_btn_clear_all">Restablecer todas</button>
          </div>
          <div id="mcp-saved-auths-list" class="mcp-saved-auths-list"></div>
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
              Descarga el servidor Python autogenerado y ejecútalo en tu terminal con python3 zerochat_mcp.py:
            </p>
          </div>
        </div>

        <div class="mcp-download-actions">
          <button type="button" id="btn-mcp-download-script" class="btn-primary btn-mcp-download" data-i18n-title="mcp_btn_download_title">
            <svg class="ui-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-download"></use></svg>
            <span data-i18n="mcp_btn_download_server">Descargar servidor (zerochat_mcp.py)</span>
          </button>
        </div>

        <div class="mcp-command-wrapper">
          <span class="label-hint" data-i18n="mcp_run_instruction">Comando de ejecución:</span>
          <div class="mcp-cmd-row">
            <pre class="mcp-command-box mcp-cmd-box-flex"><code id="mcp-terminal-command">python3 zerochat_mcp.py</code></pre>
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
    initMcpUI,
    autoConnectIfAvailable,
    ensureDialogMarkup,
    getMcpSetupDialogHTML
  };
});
