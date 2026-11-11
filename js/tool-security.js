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

  const POLICIES = Object.freeze({
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
          if (item && typeof item === 'object') {
            this.tools.set(id, {
              policy: item.policy || POLICIES.ASK,
              scope: item.scope === SCOPES.SESSION ? SCOPES.SESSION : SCOPES.PERMANENT,
              grantedAt: Number(item.grantedAt) || 0,
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
          if (item && typeof item === 'object') {
            this.servers.set(id, {
              policy: item.policy || POLICIES.ASK,
              scope: item.scope === SCOPES.SESSION ? SCOPES.SESSION : SCOPES.PERMANENT,
              grantedAt: Number(item.grantedAt) || 0,
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
      // La tarjeta devuelve el tipo de decisión o un objeto con sus restricciones o regla de directorio.
      const { decision: decType, constraints, directoryRule } = (typeof decision === 'object' && decision !== null)
        ? decision
        : { decision };

      const params = {
        challengeId,
        decision: decType,
        ...(constraints ? { constraints } : {}),
        ...(directoryRule ? { directoryRule } : {})
      };
      const reqOptions = options.signal ? { signal: options.signal } : undefined;
      const result = await this.mcpClient.request('zerochat/security/authorize', params, reqOptions);
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

    _cleanId(kind, id) {
      if (!id || typeof id !== 'string') return '';
      return kind === 'servers' ? id.trim() : id;
    }

    _findEntry(kind, id, keyProp) {
      const clean = this._cleanId(kind, id);
      const map = kind === 'tools' ? this.tools : this.servers;
      if (!clean || !map.has(clean)) return null;
      return { [keyProp]: clean, entry: map.get(clean) };
    }

    async _setPolicy(kind, id, policy, buildEntry) {
      const clean = this._cleanId(kind, id);
      if (!clean) return;
      const cleanPolicy = policy === POLICIES.ALLOW || policy === POLICIES.DENY ? policy : POLICIES.ASK;
      if (cleanPolicy === POLICIES.ASK) {
        return this._revokePolicy(kind, clean);
      }
      await this._patchBackend({ [kind]: { [clean]: buildEntry(clean, cleanPolicy) } });
    }

    async _revokePolicy(kind, id) {
      const clean = this._cleanId(kind, id);
      if (!clean) return false;
      await this._patchBackend({ [kind]: { [clean]: null } });
      return true;
    }

    _listAuthorized(map, keyProp) {
      const list = [];
      map.forEach((val, key) => {
        list.push({ [keyProp]: key, ...val });
      });
      return list.sort((a, b) => (b.grantedAt || 0) - (a.grantedAt || 0));
    }

    findToolEntry(toolId) {
      return this._findEntry('tools', toolId, 'toolId');
    }

    getToolPolicy(toolId) {
      const found = this.findToolEntry(toolId);
      return found ? found.entry.policy : null;
    }

    getToolConstraints(toolId) {
      const found = this.findToolEntry(toolId);
      return found ? (found.entry.constraints || null) : null;
    }

    async setToolPolicy(toolId, policy, meta = {}) {
      return this._setPolicy('tools', toolId, policy, (clean, cleanPolicy) => ({
        policy: cleanPolicy,
        constraints: meta.constraints !== undefined ? meta.constraints : null,
        serverName: meta.serverName || '',
        originalName: meta.originalName || clean
      }));
    }

    async revokeToolPolicy(toolId) {
      return this._revokePolicy('tools', toolId);
    }

    findServerEntry(serverId) {
      return this._findEntry('servers', serverId, 'serverId');
    }

    getServerPolicy(serverId) {
      const found = this.findServerEntry(serverId);
      return found ? found.entry.policy : null;
    }

    async setServerPolicy(serverId, policy, meta = {}) {
      return this._setPolicy('servers', serverId, policy, (clean, cleanPolicy) => ({
        policy: cleanPolicy,
        serverName: meta.serverName || clean
      }));
    }

    async revokeServerPolicy(serverId) {
      return this._revokePolicy('servers', serverId);
    }

    async clearAllAuthorizations() {
      const toolsPatch = {};
      this.tools.forEach((_, id) => { toolsPatch[id] = null; });
      const serversPatch = {};
      this.servers.forEach((_, id) => { serversPatch[id] = null; });
      await this._patchBackend({ tools: toolsPatch, servers: serversPatch });
    }

    listAuthorizedTools() {
      return this._listAuthorized(this.tools, 'toolId');
    }

    listAuthorizedServers() {
      return this._listAuthorized(this.servers, 'serverId');
    }
  }

  const manager = new ToolSecurityManager();

  return {
    GLOBAL_POLICIES,
    POLICIES,
    SCOPES,
    ToolSecurityManager,
    manager
  };
});
