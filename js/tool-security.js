/**
 * Módulo de Seguridad y Autorización de Herramientas (ChatToolSecurity) para ZeroChat.
 *
 * Responsabilidades:
 * - Evaluación jerárquica de permisos para herramientas y servidores MCP.
 * - Ámbitos de autorización: Global, Servidor MCP, Herramienta individual y Workspace.
 * - Ciclos de vida claros: Permanente (persistido) y Sesión (en memoria/ChatState).
 * - Autorización determinista sin falsos positivos heurísticos ni bloqueos automáticos.
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

  const STORAGE_KEY = 'tool_security';
  const STORAGE_VERSION = 4;

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

  const DIRECTORY_RULE_PATTERN = /^(R|W|RW):(.+)$/;

  function containsUnresolvedReference(value) {
    if (typeof value !== 'string') return false;
    const trimmed = value.trim();
    if (!trimmed) return false;
    if (trimmed.startsWith('~')) return true;
    return /\$(?:\{[^}]+\}|[A-Za-z_][A-Za-z0-9_]*)/.test(trimmed);
  }

  function normalizeDirectoryPath(value) {
    if (typeof value !== 'string' || !value.trim() || value.includes('\0')) return '';
    // ~, ~usuario y $VAR no se resuelven en el navegador: devolver '' para que nunca encajen
    // contra una regla y la evaluación pida confirmación (T01).
    if (containsUnresolvedReference(value)) return '';
    const isAbsolute = /^[\\/]/.test(value.trim());
    const parts = [];
    for (const part of value.trim().replace(/\\/g, '/').split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') {
        if (parts.length) parts.pop();
        else return '';
      } else {
        parts.push(part);
      }
    }
    return `${isAbsolute ? '/' : ''}${parts.join('/')}` || (isAbsolute ? '/' : '.');
  }

  function parseDirectoryRule(rawRule) {
    if (typeof rawRule !== 'string') return null;
    const match = rawRule.trim().match(DIRECTORY_RULE_PATTERN);
    if (!match) return null;
    const path = normalizeDirectoryPath(match[2]);
    if (!path) return null;
    return { access: match[1], path, rule: `${match[1]}:${path}` };
  }

  const { resolveDep } = Utils;

  function getStorage() {
    return resolveDep('ChatStorage', './storage.js');
  }

  function getState() {
    return resolveDep('ChatState', './state.js');
  }

  function getAgentCore() {
    return resolveDep('ChatAgentCore', './agent-core.js');
  }

  /**
   * Administrador de Seguridad y Políticas de Ejecución de ZeroChat.
   */
  class ToolSecurityManager {
    constructor() {
      this.sessionToken = null;
      this.mcpClient = null;
      this.globalMcpPolicy = GLOBAL_POLICIES.ASK;
      // El backend local informa del directorio real al conectarse (setStartupDirectory).
      this.startupDirectory = normalizeDirectoryPath('.');
      this.tools = new Map();
      this.servers = new Map();
      this.directoryRules = [];
      this.listeners = new Set();
      this.load();
    }

    setSessionToken(token) {
      if (!token || typeof token !== 'string') return;
      if (this.sessionToken === token) return;
      this.sessionToken = token;

      // Limpiar autorizaciones acotadas exclusivamente a la sesión anterior
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

    /**
     * Carga las políticas persistidas desde el almacenamiento local seguro.
     */
    load() {
      try {
        const raw = getStorage().getStorageItem(STORAGE_KEY);

        if (raw) {
          const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
          // Solo se carga el formato vigente: otra versión se descarta y rigen los valores por defecto.
          if (parsed && typeof parsed === 'object' && parsed.version === STORAGE_VERSION) {
            if (Object.values(GLOBAL_POLICIES).includes(parsed.globalMcpPolicy)) {
              this.globalMcpPolicy = parsed.globalMcpPolicy;
            }
            if (parsed.tools && typeof parsed.tools === 'object') {
              Object.entries(parsed.tools).forEach(([id, item]) => {
                if (item && typeof item === 'object') {
                  const constraints = item.constraints ? { ...item.constraints } : null;
                  this.tools.set(id, {
                    policy: item.policy || TOOL_POLICIES.ASK,
                    scope: SCOPES.PERMANENT,
                    grantedAt: item.grantedAt || Date.now(),
                    lastUsedAt: item.lastUsedAt || null,
                    serverName: item.serverName || '',
                    originalName: item.originalName || id,
                    constraints
                  });
                }
              });
            }
            if (parsed.servers && typeof parsed.servers === 'object') {
              Object.entries(parsed.servers).forEach(([id, item]) => {
                if (item && typeof item === 'object') {
                  this.servers.set(id, {
                    policy: item.policy || SERVER_POLICIES.ASK,
                    scope: SCOPES.PERMANENT,
                    grantedAt: item.grantedAt || Date.now(),
                    lastUsedAt: item.lastUsedAt || null,
                    serverName: item.serverName || id
                  });
                }
              });
            }
            if (Array.isArray(parsed.directoryRules)) {
              this.directoryRules = parsed.directoryRules.map(parseDirectoryRule).filter(Boolean).map(item => item.rule);
            }
          }
        }
      } catch (err) {
        console.warn('[ToolSecurity] Could not load the saved policies:', err?.message || err);
      }
      if (!this.directoryRules.length) {
        this.directoryRules = [this.getDefaultDirectoryRule()];
      }
      this.syncWithState();
    }

    /**
     * Guarda las políticas permanentes en el almacenamiento local seguro.
     */
    save() {
      try {
        if (!this.directoryRules.length) {
          this.directoryRules = [this.getDefaultDirectoryRule()];
        }
        const Storage = getStorage();
        const permanentTools = {};
        this.tools.forEach((val, key) => {
          if (val.scope !== SCOPES.SESSION) {
            permanentTools[key] = {
              policy: val.policy,
              grantedAt: val.grantedAt,
              lastUsedAt: val.lastUsedAt,
              serverName: val.serverName,
              originalName: val.originalName,
              constraints: val.constraints
            };
          }
        });

        const permanentServers = {};
        this.servers.forEach((val, key) => {
          if (val.scope !== SCOPES.SESSION) {
            permanentServers[key] = {
              policy: val.policy,
              grantedAt: val.grantedAt,
              lastUsedAt: val.lastUsedAt,
              serverName: val.serverName
            };
          }
        });

        const payload = {
          version: STORAGE_VERSION,
          globalMcpPolicy: this.globalMcpPolicy,
          tools: permanentTools,
          servers: permanentServers,
          directoryRules: this.directoryRules,
          updatedAt: Date.now()
        };

        Storage.setStorageItem(STORAGE_KEY, JSON.stringify(payload));
      } catch (err) {
        console.warn('[ToolSecurity] Could not save the policies:', err?.message || err);
      }

      this.syncWithState();
      this.notifyListeners();
      if (this.mcpClient) {
        this.syncToBackend().catch(() => {});
      }
    }

    setMcpClient(client) {
      this.mcpClient = client || null;
    }

    /**
     * Sincroniza las políticas de seguridad desde el backend local.
     */
    async syncFromBackend() {
      if (!this.mcpClient) return null;
      try {
        const res = await this.mcpClient.request('zerochat/security/get', {});
        const policies = res?.policies;
        if (policies && typeof policies === 'object') {
          if (Object.values(GLOBAL_POLICIES).includes(policies.globalMcpPolicy)) {
            this.globalMcpPolicy = policies.globalMcpPolicy;
          }
          if (Array.isArray(policies.directoryRules)) {
            this.directoryRules = policies.directoryRules.map(parseDirectoryRule).filter(Boolean).map(item => item.rule);
          }
          if (policies.tools && typeof policies.tools === 'object') {
            this.tools.clear();
            Object.entries(policies.tools).forEach(([id, item]) => {
              if (item && typeof item === 'object') {
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
              if (item && typeof item === 'object') {
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
      } catch (err) {
        console.warn('[ToolSecurity] Failed to sync policies from backend:', err?.message || err);
      }
      return null;
    }

    /**
     * Sincroniza las políticas permanentes actuales hacia el backend local.
     */
    async syncToBackend() {
      if (!this.mcpClient) return null;
      try {
        const permanentTools = {};
        this.tools.forEach((val, key) => {
          if (val.scope !== SCOPES.SESSION) {
            permanentTools[key] = {
              policy: val.policy,
              grantedAt: val.grantedAt,
              lastUsedAt: val.lastUsedAt,
              serverName: val.serverName,
              originalName: val.originalName,
              constraints: val.constraints
            };
          }
        });

        const permanentServers = {};
        this.servers.forEach((val, key) => {
          if (val.scope !== SCOPES.SESSION) {
            permanentServers[key] = {
              policy: val.policy,
              grantedAt: val.grantedAt,
              lastUsedAt: val.lastUsedAt,
              serverName: val.serverName
            };
          }
        });

        const payload = {
          globalMcpPolicy: this.globalMcpPolicy,
          tools: permanentTools,
          servers: permanentServers,
          directoryRules: this.directoryRules
        };
        return await this.mcpClient.request('zerochat/security/update', payload);
      } catch (err) {
        console.warn('[ToolSecurity] Failed to sync policies to backend:', err?.message || err);
      }
      return null;
    }

    /**
     * Resuelve un reto de autorización interactivo en el backend.
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
        ...(directoryRule ? { directoryRule } : {}),
        ...(options.execute ? { execute: true } : {})
      };
      const result = await this.mcpClient.request('zerochat/security/authorize', params);
      if (decType === 'allow_always' || decType === 'allow_server_always' || directoryRule) {
        await this.syncFromBackend().catch(() => {});
      }
      return result;
    }

    /**
     * Sincroniza el estado reactivo con ChatState.
     */
    syncWithState() {
      getState().set('toolSecurity', {
        globalMcpPolicy: this.globalMcpPolicy,
        authorizedCount: this.tools.size + this.servers.size,
        tools: Object.fromEntries(this.tools),
        servers: Object.fromEntries(this.servers),
        directoryRules: this.directoryRules
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

    setGlobalMcpPolicy(policy) {
      if (!Object.values(GLOBAL_POLICIES).includes(policy)) {
        throw new Error(`Invalid global policy: ${policy}`);
      }
      this.globalMcpPolicy = policy;
      this.save();
      return this.globalMcpPolicy;
    }

    getStartupDirectory() {
      return this.startupDirectory || '.';
    }

    getDefaultDirectoryRule() {
      const dir = normalizeDirectoryPath(this.getStartupDirectory());
      return dir ? `R:${dir}` : 'R:.';
    }

    setStartupDirectory(dir) {
      const norm = normalizeDirectoryPath(dir);
      if (!norm || norm === this.startupDirectory) return;
      const oldDefault = this.getDefaultDirectoryRule();
      this.startupDirectory = norm;
      const newDefault = this.getDefaultDirectoryRule();

      if (!this.directoryRules.length || (this.directoryRules.length === 1 && this.directoryRules[0] === oldDefault)) {
        this.directoryRules = [newDefault];
        this.save();
      } else {
        this.syncWithState();
      }
    }

    getDirectoryRules() {
      if (!this.directoryRules.length) {
        this.directoryRules = [this.getDefaultDirectoryRule()];
      }
      return [...this.directoryRules];
    }

    setDirectoryRules(rules) {
      if (!Array.isArray(rules)) throw new Error('Las reglas de directorio deben ser una lista.');
      const hasUnresolvedRule = rules.some(raw => {
        if (typeof raw !== 'string') return false;
        const match = raw.trim().match(DIRECTORY_RULE_PATTERN);
        return Boolean(match && containsUnresolvedReference(match[2]));
      });
      const normalized = rules.map(parseDirectoryRule);
      if (normalized.some(rule => !rule)) {
        throw new Error(hasUnresolvedRule
          ? 'Invalid directory rule: ~ and variables are not resolved in the browser. Use an absolute path.'
          : 'Invalid directory rule. Use R:, W: or RW: followed by a path.');
      }
      let uniqueRules = [...new Set(normalized.map(rule => rule.rule))];
      if (uniqueRules.length === 0) {
        uniqueRules = [this.getDefaultDirectoryRule()];
      }
      this.directoryRules = uniqueRules;
      this.save();
      return this.getDirectoryRules();
    }

    addDirectoryRule(rule) {
      return this.setDirectoryRules([...this.directoryRules, rule]);
    }

    findToolEntry(toolIdOrName, tool = null) {
      if (!toolIdOrName && !tool) return null;
      const id = tool ? tool.name : toolIdOrName;
      if (typeof id === 'string') {
        if (this.tools.has(id)) {
          return { toolId: id, entry: this.tools.get(id) };
        }
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


    setToolPolicy(toolId, policy, meta = {}) {
      if (!toolId) return;
      const cleanPolicy = policy === TOOL_POLICIES.ALLOW || policy === TOOL_POLICIES.DENY
        ? policy
        : TOOL_POLICIES.ASK;

      if (cleanPolicy === TOOL_POLICIES.ASK) {
        this.revokeToolPolicy(toolId);
        return;
      }

      const scope = meta.scope === SCOPES.SESSION ? SCOPES.SESSION : SCOPES.PERMANENT;
      const found = this.findToolEntry(toolId);
      const targetId = found ? found.toolId : toolId;
      const existing = found ? found.entry : (this.tools.get(targetId) || {});

      const constraints = meta.constraints !== undefined ? meta.constraints : (existing.constraints || null);

      const entry = {
        policy: cleanPolicy,
        scope,
        grantedAt: existing.grantedAt || Date.now(),
        lastUsedAt: Date.now(),
        serverName: meta.serverName || existing.serverName || '',
        originalName: meta.originalName || existing.originalName || toolId,
        constraints
      };

      this.tools.set(targetId, entry);
      this.save();
    }

    revokeToolPolicy(toolId) {
      if (!toolId) return false;
      let deleted = false;
      const found = this.findToolEntry(toolId);
      if (found) {
        deleted = this.tools.delete(found.toolId) || deleted;
      }
      deleted = this.tools.delete(toolId) || deleted;
      if (deleted) {
        this.save();
        return true;
      }
      return false;
    }

    findServerEntry(serverId) {
      if (!serverId || typeof serverId !== 'string') return null;
      const clean = serverId.trim();
      if (this.servers.has(clean)) {
        return { serverId: clean, entry: this.servers.get(clean) };
      }
      const lower = clean.toLowerCase();
      for (const [id, entry] of this.servers.entries()) {
        if (id.toLowerCase() === lower) {
          return { serverId: id, entry };
        }
      }
      return null;
    }

    getServerPolicy(serverId) {
      const found = this.findServerEntry(serverId);
      return found ? found.entry.policy : null;
    }

    setServerPolicy(serverId, policy, meta = {}) {
      if (!serverId || typeof serverId !== 'string') return;
      const clean = serverId.trim();
      const cleanPolicy = policy === SERVER_POLICIES.ALLOW || policy === SERVER_POLICIES.DENY
        ? policy
        : SERVER_POLICIES.ASK;

      if (cleanPolicy === SERVER_POLICIES.ASK) {
        this.revokeServerPolicy(clean);
        return;
      }

      const scope = meta.scope === SCOPES.SESSION ? SCOPES.SESSION : SCOPES.PERMANENT;
      const found = this.findServerEntry(clean);
      const targetId = found ? found.serverId : clean;
      const existing = found ? found.entry : (this.servers.get(targetId) || {});

      const entry = {
        policy: cleanPolicy,
        scope,
        grantedAt: existing.grantedAt || Date.now(),
        lastUsedAt: Date.now(),
        serverName: meta.serverName || existing.serverName || clean
      };

      this.servers.set(targetId, entry);
      this.save();
    }

    revokeServerPolicy(serverId) {
      if (!serverId) return false;
      const found = this.findServerEntry(serverId);
      const targetId = found ? found.serverId : serverId;
      const deleted = this.servers.delete(targetId);
      if (deleted) {
        this.save();
        return true;
      }
      return false;
    }

    clearAllAuthorizations() {
      this.tools.clear();
      this.servers.clear();
      this.save();
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
    STORAGE_KEY,
    ToolSecurityManager,
    manager
  };
});
