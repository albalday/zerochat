/**
 * Módulo de Seguridad y Autorización de Herramientas (ChatToolSecurity) para ZeroChat.
 *
 * Caché en memoria del estado de permisos que exporta el backend (SQLite y capa de sesión):
 * - Lecturas síncronas sobre el último estado recibido, sin decisiones propias ni normalización.
 * - Escrituras como parches parciales a `zerochat/security/update`, adoptando el estado que devuelve.
 * - Sin persistencia local. Isomórfico (Node.js y navegador).
 */

(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.ChatToolSecurity = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Claves del estado exportado por el backend que guarda la caché.
  const POLICY_KEYS = ['globalMcpPolicy', 'defaultDirectoryRule', 'directoryRules', 'tools', 'servers', 'commandPatterns'];

  const emptyPolicies = () => ({
    globalMcpPolicy: 'ask',
    defaultDirectoryRule: '',
    directoryRules: [],
    tools: {},
    servers: {},
    commandPatterns: { global: [], projects: {}, session: [] }
  });

  const entryOf = (map, id) => (typeof id === 'string' && Object.hasOwn(map, id) ? map[id] : null);

  const listOf = (map, keyProp) => Object.entries(map)
    .map(([key, entry]) => ({ [keyProp]: key, ...entry }))
    .sort((a, b) => (b.grantedAt || 0) - (a.grantedAt || 0));

  class ToolSecurityManager {
    constructor() {
      this.sessionToken = null;
      this.mcpClient = null;
      this.policies = emptyPolicies();
      this.listeners = new Set();
    }

    setSessionToken(token) {
      if (!token || typeof token !== 'string' || this.sessionToken === token) return;
      this.sessionToken = token;
      // El backend descarta las autorizaciones de sesión al cambiar el token: se relee su estado.
      return this.refresh();
    }

    setMcpClient(client) {
      this.mcpClient = client || null;
    }

    /** Adopta el estado de políticas del backend o de una ejecución; solo cambian las claves presentes. */
    applyPolicies(policies) {
      if (!policies || typeof policies !== 'object') return null;
      for (const key of POLICY_KEYS) {
        if (policies[key] !== undefined) this.policies[key] = policies[key];
      }
      this.listeners.forEach(fn => {
        try { fn(this); } catch (e) { console.warn('[ChatToolSecurity] Listener failed:', e); }
      });
      return policies;
    }

    /** Copia del estado para enviarla a una ejecución en servidor. */
    snapshot() {
      return structuredClone(this.policies);
    }

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

    _client(action) {
      if (!this.mcpClient) throw new Error(`Local server connection is required to ${action}.`);
      return this.mcpClient;
    }

    async _patchBackend(patch) {
      const res = await this._client('update security policies').request('zerochat/security/update', patch);
      this.applyPolicies(res?.policies);
    }

    /**
     * Resuelve un reto en el backend y refresca las políticas. La tarjeta devuelve el tipo de decisión
     * o un objeto con su patrón de comando o regla de directorio.
     */
    async authorizeChallenge(challengeId, decision, options = {}) {
      const client = this._client('authorize challenges');
      const { decision: decType, commandPattern, directoryRule } = (typeof decision === 'object' && decision !== null)
        ? decision
        : { decision };
      const params = {
        challengeId,
        decision: decType,
        ...(commandPattern ? { commandPattern } : {}),
        ...(directoryRule ? { directoryRule } : {})
      };
      const result = await client.request('zerochat/security/authorize', params, options.signal ? { signal: options.signal } : undefined);
      await this.refresh();
      return result;
    }

    subscribe(listener) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }

    getGlobalMcpPolicy() {
      return this.policies.globalMcpPolicy;
    }

    async setGlobalMcpPolicy(policy) {
      await this._patchBackend({ globalMcpPolicy: policy });
    }

    getDirectoryRules() {
      return [...this.policies.directoryRules];
    }

    /** Regla del proyecto actual, calculada por el backend y de solo lectura. */
    getDefaultDirectoryRule() {
      return this.policies.defaultDirectoryRule;
    }

    async setDirectoryRules(rules) {
      await this._patchBackend({ directoryRules: rules });
    }

    async addDirectoryRule(rule) {
      await this._patchBackend({ addDirectoryRules: [rule] });
    }

    getToolPolicy(toolId) {
      return entryOf(this.policies.tools, toolId)?.policy || null;
    }

    /** 'ask' revoca la política guardada; 'allow' o 'deny' la concede. */
    async setToolPolicy(toolId, policy, { serverName = '', originalName = toolId } = {}) {
      if (policy === 'ask') return this.revokeToolPolicy(toolId);
      await this._patchBackend({ tools: { [toolId]: { policy, serverName, originalName } } });
    }

    async revokeToolPolicy(toolId) {
      await this._patchBackend({ tools: { [toolId]: null } });
    }

    getServerPolicy(serverId) {
      return entryOf(this.policies.servers, serverId)?.policy || null;
    }

    async setServerPolicy(serverId, policy, { serverName = serverId } = {}) {
      await this._patchBackend({ servers: { [serverId]: { policy, serverName } } });
    }

    async revokeServerPolicy(serverId) {
      await this._patchBackend({ servers: { [serverId]: null } });
    }

    /** Patrones de comando que rigen: de todos los proyectos, por proyecto y de la sesión. */
    getCommandPatterns() {
      const { global = [], projects = {}, session = [] } = this.policies.commandPatterns || {};
      return { global: [...global], projects: { ...projects }, session: [...session] };
    }

    /** Sustituye los patrones de comando guardados (`global` y `projects`); los de sesión no se guardan. */
    async setCommandPatterns({ global = [], projects = {} } = {}) {
      await this._patchBackend({ commandPatterns: { global, projects } });
    }

    async clearAllAuthorizations() {
      const revokeAll = map => Object.fromEntries(Object.keys(map).map(id => [id, null]));
      await this._patchBackend({
        tools: revokeAll(this.policies.tools),
        servers: revokeAll(this.policies.servers),
        commandPatterns: { global: [], projects: {} }
      });
    }

    listAuthorizedTools() {
      return listOf(this.policies.tools, 'toolId');
    }

    listAuthorizedServers() {
      return listOf(this.policies.servers, 'serverId');
    }
  }

  return {
    ToolSecurityManager,
    manager: new ToolSecurityManager()
  };
});
