/**
 * Módulo de Seguridad y Autorización de Herramientas (ChatToolSecurity) para ZeroChat.
 *
 * Responsabilidades:
 * - Caché local en memoria de las políticas de seguridad del backend (SQLite).
 * - Lectura síncrona de permisos (global, herramientas, servidores, directorios).
 * - Escritura asíncrona mediante parches parciales al backend (security/update).
 * - Sin persistencia local ni utilidades de resolución divergentes.
 * - Sincronización reactiva con ChatState y compatibilidad isomórfica (Node.js y navegador).
 */

(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./utils.js'));
  } else {
    root.ChatToolSecurity = factory(root.ChatUtils);
  }
})(typeof self !== 'undefined' ? self : this, function (Utils) {
  'use strict';

  const GLOBAL_POLICIES = Object.freeze({
    ASK: 'ask',
    ALLOW_ALL: 'allow_all',
    WORKSPACE_TRUST: 'workspace_trust'
  });

  const TOOL_POLICIES = Object.freeze({
    ALLOW: 'allow',
    DENY: 'deny',
    ASK: 'ask'
  });

  const SERVER_POLICIES = Object.freeze({
    ALLOW: 'allow',
    DENY: 'deny',
    ASK: 'ask'
  });

  const SCOPES = Object.freeze({
    PERMANENT: 'permanent',
    SESSION: 'session'
  });

  const { resolveDep } = Utils;

  function getState() {
    return resolveDep('ChatState', './state.js');
  }

  /**
   * Administrador de Seguridad y Políticas de Ejecución de ZeroChat (Caché del backend).
   */
  class ToolSecurityManager {
    constructor() {
      this.sessionToken = null;
      this.mcpClient = null;
      this.globalMcpPolicy = GLOBAL_POLICIES.ASK;
      this.defaultDirectoryRule = '';
      this.tools = new Map();
      this.servers = new Map();
      this.directoryRules = [];
      this.listeners = new Set();
    }

    setSessionToken(token) {
      if (!token || typeof token !== 'string') return;
      if (this.sessionToken === token) return;
      this.sessionToken = token;

      let changed = false;
      for (const [id, item] of this.tools.entries()) {
        if (item.scope === SCOPES.SESSION) {
          this.tools.delete(id);
          changed = true;
        }
      }
      for (const [id, item] of this.servers.entries()) {
        if (item.scope === SCOPES.SESSION) {
          this.servers.delete(id);
          changed = true;
        }
      }

      if (changed) {
        this.syncWithState();
        this.notifyListeners();
      }
    }

    setMcpClient(client) {
      this.mcpClient = client || null;
    }

    /**
     * Aplica el estado completo de políticas recibido del backend o de una sesión.
     */
    applyPolicies(policies) {
      if (!policies || typeof policies !== 'object') return null;
      if (typeof policies.globalMcpPolicy === 'string' && Object.values(GLOBAL_POLICIES).includes(policies.globalMcpPolicy)) {
        this.globalMcpPolicy = policies.globalMcpPolicy;
      }
      if (typeof policies.defaultDirectoryRule === 'string') {
        this.defaultDirectoryRule = policies.defaultDirectoryRule;
      }
      if (Array.isArray(policies.directoryRules)) {
        this.directoryRules = policies.directoryRules.map(r => String(r || '').trim()).filter(Boolean);
      }
      if (policies.tools && typeof policies.tools === 'object') {
        this.tools.clear();
        Object.entries(policies.tools).forEach(([id, item]) => {
          if (typeof item === 'string') {
            this.tools.set(id, {
              policy: item,
              scope: SCOPES.SESSION,
              grantedAt: Date.now(),
              lastUsedAt: null,
              serverName: '',
              originalName: id,
              constraints: null
            });
          } else if (item && typeof item === 'object') {
            this.tools.set(id, {
              policy: item.policy || TOOL_POLICIES.ASK,
              scope: item.scope === SCOPES.SESSION ? SCOPES.SESSION : SCOPES.PERMANENT,
              grantedAt: item.grantedAt || Date.now(),
              lastUsedAt: item.lastUsedAt || null,
              serverName: item.serverName || '',
              originalName: item.originalName || id,
              constraints: item.constraints ? { ...item.constraints } : null
            });
          }
        });
      }
      if (policies.servers && typeof policies.servers === 'object') {
        this.servers.clear();
        Object.entries(policies.servers).forEach(([id, item]) => {
          if (typeof item === 'string') {
            this.servers.set(id, {
              policy: item,
              scope: SCOPES.SESSION,
              grantedAt: Date.now(),
              lastUsedAt: null,
              serverName: id
            });
          } else if (item && typeof item === 'object') {
            this.servers.set(id, {
              policy: item.policy || SERVER_POLICIES.ASK,
              scope: item.scope === SCOPES.SESSION ? SCOPES.SESSION : SCOPES.PERMANENT,
              grantedAt: item.grantedAt || Date.now(),
              lastUsedAt: item.lastUsedAt || null,
              serverName: item.serverName || id
            });
          }
        });
      }
      this.syncWithState();
      this.notifyListeners();
      return policies;
    }

    /**
     * Refresca el estado completo de políticas consultando al backend local.
     */
    async refresh() {
      if (!this.mcpClient) return null;
      try {
        const res = await this.mcpClient.request('zerochat/security/get', {});
        return this.applyPolicies(res?.policies);
      } catch (err) {
        console.warn('[ToolSecurity] Failed to refresh policies from backend:', err?.message || err);
        return null;
      }
    }

    /**
     * Envía un parche parcial al backend y actualiza la caché local con la respuesta.
     */
    async _patchBackend(patch) {
      if (!this.mcpClient) {
        throw new Error('Local server connection is required to update security policies.');
      }
      const res = await this.mcpClient.request('zerochat/security/update', patch);
      this.applyPolicies(res?.policies);
      return res?.policies;
    }

    /**
     * Resuelve un reto de autorización interactivo en el backend y refresca las políticas.
     */
    async authorizeChallenge(challengeId, decision, options = {}) {
      if (!this.mcpClient) {
        throw new Error('Local server connection is required to authorize challenges.');
      }
      const decType = (typeof decision === 'object' && decision !== null) ? decision.decision : decision;
      const constraints = options.constraints || (typeof decision === 'object' && decision !== null ? decision.constraints : null);
      const directoryRule = options.directoryRule || (typeof decision === 'object' && decision !== null ? decision.directoryRule : null);

      const params = {
        challengeId,
        decision: decType,
        ...(constraints ? { constraints } : {}),
        ...(directoryRule ? { directoryRule } : {})
      };
      const result = await this.mcpClient.request('zerochat/security/authorize', params);
      await this.refresh().catch(() => {});
      return result;
    }

    syncWithState() {
      getState().set('toolSecurity', {
        globalMcpPolicy: this.globalMcpPolicy,
        authorizedCount: this.tools.size + this.servers.size,
        tools: Object.fromEntries(this.tools),
        servers: Object.fromEntries(this.servers),
        directoryRules: this.directoryRules,
        defaultDirectoryRule: this.defaultDirectoryRule
      });
    }

    subscribe(listener) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }

    notifyListeners() {
      this.listeners.forEach(fn => {
        try { fn(this); } catch (e) { console.warn('[ChatToolSecurity] Listener failed:', e); }
      });
    }

    getGlobalMcpPolicy() {
      return this.globalMcpPolicy;
    }

    async setGlobalMcpPolicy(policy) {
      if (!Object.values(GLOBAL_POLICIES).includes(policy)) {
        throw new Error(`Invalid global policy: ${policy}`);
      }
      await this._patchBackend({ globalMcpPolicy: policy });
      return this.globalMcpPolicy;
    }

    getDirectoryRules() {
      return [...this.directoryRules];
    }

    async setDirectoryRules(rules) {
      if (!Array.isArray(rules)) throw new Error('Las reglas de directorio deben ser una lista.');
      await this._patchBackend({ directoryRules: rules });
      return this.getDirectoryRules();
    }

    async addDirectoryRule(rule) {
      const current = this.getDirectoryRules();
      return this.setDirectoryRules([...current, rule]);
    }

    findToolEntry(toolId) {
      if (!toolId || typeof toolId !== 'string') return null;
      if (this.tools.has(toolId)) {
        return { toolId, entry: this.tools.get(toolId) };
      }
      return null;
    }

    getToolPolicy(toolId) {
      if (!toolId) return null;
      const found = this.findToolEntry(toolId);
      return found ? found.entry.policy : null;
    }

    getToolConstraints(toolId) {
      const found = this.findToolEntry(toolId);
      return found ? (found.entry.constraints || null) : null;
    }

    async setToolPolicy(toolId, policy, meta = {}) {
      if (!toolId) return;
      const cleanPolicy = policy === TOOL_POLICIES.ALLOW || policy === TOOL_POLICIES.DENY
        ? policy
        : TOOL_POLICIES.ASK;

      if (cleanPolicy === TOOL_POLICIES.ASK) {
        return this.revokeToolPolicy(toolId);
      }

      const constraints = meta.constraints !== undefined ? meta.constraints : null;
      const entry = {
        policy: cleanPolicy,
        constraints,
        serverName: meta.serverName || '',
        originalName: meta.originalName || toolId
      };

      await this._patchBackend({
        tools: {
          [toolId]: entry
        }
      });
    }

    async revokeToolPolicy(toolId) {
      if (!toolId) return false;
      await this._patchBackend({
        tools: {
          [toolId]: null
        }
      });
      return true;
    }

    findServerEntry(serverId) {
      if (!serverId || typeof serverId !== 'string') return null;
      const clean = serverId.trim();
      if (this.servers.has(clean)) {
        return { serverId: clean, entry: this.servers.get(clean) };
      }
      return null;
    }

    getServerPolicy(serverId) {
      const found = this.findServerEntry(serverId);
      return found ? found.entry.policy : null;
    }

    async setServerPolicy(serverId, policy, meta = {}) {
      if (!serverId || typeof serverId !== 'string') return;
      const clean = serverId.trim();
      const cleanPolicy = policy === SERVER_POLICIES.ALLOW || policy === SERVER_POLICIES.DENY
        ? policy
        : SERVER_POLICIES.ASK;

      if (cleanPolicy === SERVER_POLICIES.ASK) {
        return this.revokeServerPolicy(clean);
      }

      const entry = {
        policy: cleanPolicy,
        serverName: meta.serverName || clean
      };

      await this._patchBackend({
        servers: {
          [clean]: entry
        }
      });
    }

    async revokeServerPolicy(serverId) {
      if (!serverId) return false;
      await this._patchBackend({
        servers: {
          [serverId.trim()]: null
        }
      });
      return true;
    }

    async clearAllAuthorizations() {
      const toolsPatch = {};
      this.tools.forEach((_, id) => { toolsPatch[id] = null; });
      const serversPatch = {};
      this.servers.forEach((_, id) => { serversPatch[id] = null; });
      await this._patchBackend({ tools: toolsPatch, servers: serversPatch });
    }

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

    listAuthorizedServers() {
      const list = [];
      this.servers.forEach((val, key) => {
        list.push({
          serverId: key,
          ...val
        });
      });
      return list.sort((a, b) => (b.grantedAt || 0) - (a.grantedAt || 0));
    }
  }

  const manager = new ToolSecurityManager();

  return {
    GLOBAL_POLICIES,
    TOOL_POLICIES,
    SERVER_POLICIES,
    SCOPES,
    ToolSecurityManager,
    manager
  };
});
