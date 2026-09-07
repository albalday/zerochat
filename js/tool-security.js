/**
 * Módulo de Seguridad y Autorización de Herramientas (ChatToolSecurity) para ZeroChat.
 *
 * Responsabilidades:
 * - Evaluación de políticas de ejecución para herramientas agénticas y servidores MCP.
 * - Registro persistente de autorizaciones de grano fino por toolId.
 * - Control global de autorización MCP (restringido a la configuración global).
 * - Desacoplamiento e isomorfismo (Node.js y navegador).
 */

(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.ChatToolSecurity = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STORAGE_KEY = 'chat_tool_security';

  const GLOBAL_POLICIES = Object.freeze({
    ASK: 'ask',
    ALLOW_ALL: 'allow_all'
  });

  const TOOL_POLICIES = Object.freeze({
    ALLOW: 'allow',
    DENY: 'deny',
    ASK: 'ask'
  });

  function resolveDep(name, path) {
    if (typeof window !== 'undefined' && window[name]) return window[name];
    if (typeof require !== 'undefined') {
      try { return require(path); } catch (e) { return null; }
    }
    return null;
  }

  function getStorage() {
    return resolveDep('ChatStorage', './cookies.js');
  }

  function getState() {
    return resolveDep('ChatState', './state.js');
  }

  function getAgentCore() {
    return resolveDep('ChatAgentCore', './agent-core.js');
  }

  /**
   * Administrador de Seguridad y Políticas de Ejecución.
   */
  class ToolSecurityManager {
    constructor(options = {}) {
      this.storageKey = options.storageKey || STORAGE_KEY;
      this.globalMcpPolicy = GLOBAL_POLICIES.ASK;
      this.tools = new Map();
      this.listeners = new Set();
      this.load();
    }

    /**
     * Carga el estado persistido desde almacenamiento local.
     */
    load() {
      try {
        const Storage = getStorage();
        let raw = null;
        if (Storage && typeof Storage.getStorageItem === 'function') {
          raw = Storage.getStorageItem(this.storageKey);
        } else if (typeof localStorage !== 'undefined') {
          raw = localStorage.getItem(this.storageKey);
        }

        if (raw) {
          const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
          if (parsed && typeof parsed === 'object') {
            if (parsed.globalMcpPolicy === GLOBAL_POLICIES.ALLOW_ALL || parsed.globalMcpPolicy === GLOBAL_POLICIES.ASK) {
              this.globalMcpPolicy = parsed.globalMcpPolicy;
            }
            if (parsed.tools && typeof parsed.tools === 'object') {
              this.tools.clear();
              Object.entries(parsed.tools).forEach(([id, item]) => {
                if (item && typeof item === 'object') {
                  this.tools.set(id, {
                    policy: item.policy || TOOL_POLICIES.ASK,
                    grantedAt: item.grantedAt || Date.now(),
                    lastUsedAt: item.lastUsedAt || null,
                    serverName: item.serverName || '',
                    originalName: item.originalName || id,
                    constraints: item.constraints || null
                  });
                }
              });
            }
          }
        }
      } catch (err) {
        // En caso de corrupción, mantener estado seguro por defecto
        this.globalMcpPolicy = GLOBAL_POLICIES.ASK;
        this.tools.clear();
      }
      this.syncWithState();
    }

    /**
     * Guarda el estado en almacenamiento local y sincroniza el store reactivo.
     */
    save() {
      try {
        const Storage = getStorage();
        const toolsObj = {};
        this.tools.forEach((val, key) => {
          toolsObj[key] = val;
        });

        const payload = {
          version: 1,
          globalMcpPolicy: this.globalMcpPolicy,
          tools: toolsObj,
          updatedAt: Date.now()
        };

        const serialized = JSON.stringify(payload);
        if (Storage && typeof Storage.setStorageItem === 'function') {
          Storage.setStorageItem(this.storageKey, serialized);
        } else if (typeof localStorage !== 'undefined') {
          localStorage.setItem(this.storageKey, serialized);
        }
      } catch (err) {}

      this.syncWithState();
      this.notifyListeners();
    }

    /**
     * Sincroniza las políticas con ChatState si está disponible.
     */
    syncWithState() {
      const State = getState();
      if (State && typeof State.set === 'function') {
        const toolsObj = {};
        this.tools.forEach((val, key) => { toolsObj[key] = val; });
        State.set('toolSecurity', {
          globalMcpPolicy: this.globalMcpPolicy,
          authorizedCount: this.tools.size,
          tools: toolsObj
        });
      }
    }

    /**
     * Registra un observador para cambios en políticas de seguridad.
     */
    subscribe(listener) {
      if (typeof listener === 'function') {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      }
      return () => {};
    }

    notifyListeners() {
      this.listeners.forEach(fn => {
        try { fn(this); } catch (e) {}
      });
    }

    /**
     * Obtiene la política global para herramientas MCP.
     * @returns {'ask'|'allow_all'}
     */
    getGlobalMcpPolicy() {
      return this.globalMcpPolicy;
    }

    /**
     * Establece la política global para herramientas MCP.
     * SOLO debe ser invocado desde la interfaz de configuración global de MCP.
     * @param {'ask'|'allow_all'} policy
     */
    setGlobalMcpPolicy(policy) {
      if (policy !== GLOBAL_POLICIES.ASK && policy !== GLOBAL_POLICIES.ALLOW_ALL) {
        throw new Error(`Política global no válida: ${policy}`);
      }
      this.globalMcpPolicy = policy;
      this.save();
      return this.globalMcpPolicy;
    }

    /**
     * Obtiene la política específica para una herramienta.
     * @param {string} toolId
     * @returns {'allow'|'deny'|'ask'|null}
     */
    getToolPolicy(toolId) {
      if (!toolId) return null;
      const rule = this.tools.get(toolId);
      return rule ? rule.policy : null;
    }

    /**
     * Establece la política de grano fino para una herramienta individual.
     * @param {string} toolId - Identificador único de la herramienta (ej: 'mcp__mcp_proxy__read_file').
     * @param {'allow'|'deny'|'ask'} policy - Decisión de autorización.
     * @param {object} [meta={}] - Metadatos auxiliares (serverName, originalName, etc.).
     */
    setToolPolicy(toolId, policy, meta = {}) {
      if (!toolId) return;
      const cleanPolicy = policy === TOOL_POLICIES.ALLOW || policy === TOOL_POLICIES.DENY
        ? policy
        : TOOL_POLICIES.ASK;

      const existing = this.tools.get(toolId) || {};
      this.tools.set(toolId, {
        policy: cleanPolicy,
        grantedAt: existing.grantedAt || Date.now(),
        lastUsedAt: Date.now(),
        serverName: meta.serverName || existing.serverName || '',
        originalName: meta.originalName || existing.originalName || toolId,
        constraints: meta.constraints || existing.constraints || null
      });

      this.save();
    }

    /**
     * Revoca la autorización guardada de una herramienta individual.
     * @param {string} toolId
     */
    revokeToolPolicy(toolId) {
      if (toolId && this.tools.has(toolId)) {
        this.tools.delete(toolId);
        this.save();
        return true;
      }
      return false;
    }

    /**
     * Restablece todas las autorizaciones guardadas.
     */
    clearAllAuthorizations() {
      this.tools.clear();
      this.save();
    }

    /**
     * Lista todas las herramientas con autorizaciones individuales registradas.
     * @returns {Array<{ toolId: string, policy: string, grantedAt: number, lastUsedAt?: number, serverName?: string, originalName?: string }>}
     */
    listAuthorizedTools() {
      const list = [];
      this.tools.forEach((val, key) => {
        list.push({
          toolId: key,
          ...val
        });
      });
      return list.sort((a, b) => (b.grantedAt || 0) - (a.grantedAt || 0));
    }

    /**
     * Evalúa si una llamada a herramienta puede ejecutarse o requiere autorización del usuario.
     *
     * @param {object|string} toolOrName - Instancia de Tool o nombre de la herramienta.
     * @param {object} [args={}] - Argumentos de la llamada.
     * @param {object} [options={}] - Opciones de contexto.
     * @returns {{ requiresApproval: boolean, status: 'allow'|'deny'|'ask', reason: string, toolId: string, serverName: string, originalName: string }}
     */
    evaluateAuthorization(toolOrName, args = {}, options = {}) {
      let tool = null;
      let toolName = '';

      if (typeof toolOrName === 'string') {
        toolName = toolOrName;
        const AgentCore = getAgentCore();
        if (AgentCore && AgentCore.registry && typeof AgentCore.registry.getTool === 'function') {
          tool = AgentCore.registry.getTool(toolName);
        }
      } else if (toolOrName && typeof toolOrName === 'object') {
        tool = toolOrName;
        toolName = tool.name || tool.id || '';
      }

      const toolId = (tool && (tool.id || tool.name)) || toolName;
      const category = tool?.category || (toolName.startsWith('mcp_') || toolName.startsWith('mcp__') ? 'mcp' : 'other');
      const isMcp = category === 'mcp' || toolName.startsWith('mcp_') || toolName.startsWith('mcp__');

      const serverName = tool?.metadata?.mcpServerName || '';
      const originalName = tool?.metadata?.originalName || toolName;

      // 1. Herramientas integradas (no MCP): permitidas por defecto
      if (!isMcp) {
        return {
          requiresApproval: false,
          status: TOOL_POLICIES.ALLOW,
          reason: 'builtin_tool',
          toolId,
          serverName: '',
          originalName: toolName
        };
      }

      // 2. Herramientas MCP con modo global 'allow_all'
      if (this.globalMcpPolicy === GLOBAL_POLICIES.ALLOW_ALL) {
        return {
          requiresApproval: false,
          status: TOOL_POLICIES.ALLOW,
          reason: 'mcp_global_allow_all',
          toolId,
          serverName,
          originalName
        };
      }

      // 3. Herramientas MCP con regla granular específica guardada
      if (this.tools.has(toolId)) {
        const rule = this.tools.get(toolId);
        if (rule.policy === TOOL_POLICIES.ALLOW) {
          // Registrar último uso
          rule.lastUsedAt = Date.now();
          return {
            requiresApproval: false,
            status: TOOL_POLICIES.ALLOW,
            reason: 'granular_allow_rule',
            toolId,
            serverName,
            originalName
          };
        }
        if (rule.policy === TOOL_POLICIES.DENY) {
          return {
            requiresApproval: false,
            status: TOOL_POLICIES.DENY,
            reason: 'granular_deny_rule',
            toolId,
            serverName,
            originalName
          };
        }
        // Si explícitamente se configuró como 'ask'
        return {
          requiresApproval: true,
          status: TOOL_POLICIES.ASK,
          reason: 'granular_ask_rule',
          toolId,
          serverName,
          originalName
        };
      }

      // 4. Por defecto en MCP: solicitar autorización interactiva
      return {
        requiresApproval: true,
        status: TOOL_POLICIES.ASK,
        reason: 'mcp_default_ask',
        toolId,
        serverName,
        originalName
      };
    }
  }

  const manager = new ToolSecurityManager();

  return {
    STORAGE_KEY,
    GLOBAL_POLICIES,
    TOOL_POLICIES,
    ToolSecurityManager,
    manager
  };
});

