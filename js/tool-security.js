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
    module.exports = factory();
  } else {
    root.ChatToolSecurity = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STORAGE_KEY = 'zc_tool_security_v3';

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

  function normalizeDirectoryPath(value) {
    if (typeof value !== 'string' || !value.trim() || value.includes('\0')) return '';
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

  function matchesDirectoryPattern(path, pattern) {
    if (pattern.endsWith('/**') && path === pattern.slice(0, -3)) return true;
    const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
      .replace(/\*\*/g, '\u0000')
      .replace(/\*/g, '[^/]*');
    return new RegExp(`^${escaped.replace(/\u0000/g, '.*')}$`).test(path);
  }

  const LOCAL_MANAGED_TOOLS = new Set([
    'read_file', 'list_directory', 'search_files', 'get_diagnostics',
    'edit_file', 'write_file', 'execute_command', 'bash'
  ]);

  function getIntegratedPathAccess(toolName) {
    if (toolName === 'read_file' || toolName === 'list_directory' || toolName === 'search_files' || toolName === 'get_diagnostics') return 'R';
    if (toolName === 'edit_file' || toolName === 'write_file') return 'W';
    return '';
  }

  const COMMAND_TOOLS = new Set(['execute_command', 'bash']);

  function resolveDep(name, path) {
    if (typeof window !== 'undefined' && window.ChatUtils?.resolveDep) {
      return window.ChatUtils.resolveDep(name, path);
    }
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

  function normalizePath(p) {
    if (typeof p !== 'string') return '';
    let norm = p.replace(/\\/g, '/');
    norm = norm.replace(/\/+/g, '/');
    return norm;
  }

  function isPathTraversal(norm) {
    const segments = norm.split('/');
    let depth = 0;
    for (const seg of segments) {
      if (seg === '..') {
        depth--;
        if (depth < 0) return true;
      } else if (seg && seg !== '.') {
        depth++;
      }
    }
    return false;
  }

  function extractServerId(tool, toolName) {
    if (tool?.metadata?.mcpServerId) return String(tool.metadata.mcpServerId);
    const name = toolName || tool?.name || '';
    if (name.startsWith('mcp_')) {
      const parts = name.split('_');
      if (parts.length >= 3) {
        return parts[1];
      }
    }
    if (tool?.metadata?.mcpServerName) return String(tool.metadata.mcpServerName);
    return '';
  }

  function evaluatePathConstraint(pathVal, pathConstraints) {
    if (!pathVal || typeof pathVal !== 'string') return { allowed: true };
    if (!pathConstraints || typeof pathConstraints !== 'object') return { allowed: true };

    const norm = normalizePath(pathVal);

    if (pathConstraints.preventTraversal) {
      if (norm.includes('../') || norm.startsWith('..') || norm.endsWith('/..')) {
        if (isPathTraversal(norm)) {
          return {
            allowed: false,
            denied: true,
            reason: 'path_traversal_detected',
            details: `Navegación de directorios no permitida: ${pathVal}`
          };
        }
      }
    }

    if (Array.isArray(pathConstraints.deniedDirectories)) {
      for (const denied of pathConstraints.deniedDirectories) {
        const normDenied = normalizePath(denied);
        if (norm.startsWith(normDenied) || norm === normDenied || norm.includes(normDenied)) {
          return {
            allowed: false,
            denied: true,
            reason: 'path_in_denied_directory',
            details: `Ruta denegada por lista negra: ${pathVal}`
          };
        }
      }
    }

    if (Array.isArray(pathConstraints.allowedDirectories) && pathConstraints.allowedDirectories.length > 0) {
      let matched = false;
      for (const allowed of pathConstraints.allowedDirectories) {
        const normAllowed = normalizePath(allowed);
        if (normAllowed === './' || normAllowed === '.') {
          if (!norm.startsWith('/') && !norm.startsWith('~')) {
            matched = true;
            break;
          }
        } else if (norm.startsWith(normAllowed)) {
          matched = true;
          break;
        }
      }
      if (!matched) {
        return {
          allowed: false,
          denied: false,
          reason: 'path_outside_allowed_directories',
          details: `Ruta fuera de las carpetas autorizadas: ${pathVal}`
        };
      }
    }

    return { allowed: true };
  }

  function evaluateCommandConstraint(cmdVal, commandConstraints) {
    if (!cmdVal || typeof cmdVal !== 'string') return { allowed: true };
    if (!commandConstraints || typeof commandConstraints !== 'object') return { allowed: true };

    const trimmed = cmdVal.trim();

    // cd es intrínsecamente una instrucción de navegación que requiere encadenar (cd <dir> && <cmd>).
    // Si la lista de prefijos autorizados incluye 'cd', el encadenamiento está implícitamente habilitado.
    const hasCdPrefix = Array.isArray(commandConstraints.allowedPrefixes) &&
      commandConstraints.allowedPrefixes.some(p => String(p).replace(/\*+$/, '').trim() === 'cd');

    const allowChaining = commandConstraints.allowChaining !== false || hasCdPrefix;

    if (!allowChaining) {
      const isSequentialOrCond = /(?:;|&&|\|\||`|\$\()/.test(trimmed);
      const isBackgroundAmp = /(?<!>|\d)&(?!\d|>)/.test(trimmed);
      const hasUnauthorizedPipe = commandConstraints.allowPipes === false && trimmed.includes('|');

      if (isSequentialOrCond || isBackgroundAmp || hasUnauthorizedPipe) {
        return {
          allowed: false,
          denied: false,
          reason: 'command_chaining_requires_approval',
          details: `Comando contiene encadenamiento no autorizado: ${trimmed}`
        };
      }
    }

    if (Array.isArray(commandConstraints.deniedPatterns)) {
      for (const pattern of commandConstraints.deniedPatterns) {
        if (typeof pattern === 'string' && trimmed.includes(pattern)) {
          return {
            allowed: false,
            denied: true,
            reason: 'command_matches_denied_pattern',
            details: `Comando contiene un patrón bloqueado (${pattern}): ${trimmed}`
          };
        }
      }
    }

    if (Array.isArray(commandConstraints.allowedPrefixes) && commandConstraints.allowedPrefixes.length > 0) {
      let matched = false;
      for (const prefix of commandConstraints.allowedPrefixes) {
        const cleanPrefix = String(prefix).replace(/\*+$/, '').trim();
        if (
          trimmed === cleanPrefix ||
          ((cleanPrefix.endsWith('/') || cleanPrefix.endsWith(' ')) && trimmed.startsWith(cleanPrefix)) ||
          trimmed.startsWith(cleanPrefix + ' ') ||
          trimmed.startsWith(cleanPrefix + '\t') ||
          trimmed.startsWith(cleanPrefix + ' &&') ||
          trimmed.startsWith(cleanPrefix + ' ;') ||
          trimmed.startsWith('/usr/bin/' + cleanPrefix + ' ') ||
          trimmed.startsWith('/bin/' + cleanPrefix + ' ') ||
          trimmed.startsWith('/usr/local/bin/' + cleanPrefix + ' ')
        ) {
          matched = true;
          break;
        }
      }

      // Si no coincide directamente con el comando completo, comprobar si navega con cd a una carpeta
      // y luego ejecuta un comando con prefijo autorizado (e.g. "cd /repo && git status")
      if (!matched) {
        const cdChainedMatch = trimmed.match(/^cd\s+[^;&|]+(?:\s*&&\s*|\s*;\s*)(.+)$/s);
        if (cdChainedMatch && cdChainedMatch[1]) {
          const subCmd = cdChainedMatch[1].trim();
          for (const prefix of commandConstraints.allowedPrefixes) {
            const cleanPrefix = String(prefix).replace(/\*+$/, '').trim();
            if (
              subCmd === cleanPrefix ||
              ((cleanPrefix.endsWith('/') || cleanPrefix.endsWith(' ')) && subCmd.startsWith(cleanPrefix)) ||
              subCmd.startsWith(cleanPrefix + ' ') ||
              subCmd.startsWith(cleanPrefix + '\t') ||
              subCmd.startsWith('/usr/bin/' + cleanPrefix + ' ') ||
              subCmd.startsWith('/bin/' + cleanPrefix + ' ') ||
              subCmd.startsWith('/usr/local/bin/' + cleanPrefix + ' ')
            ) {
              matched = true;
              break;
            }
          }
        }
      }

      if (!matched) {
        return {
          allowed: false,
          denied: false,
          reason: 'command_outside_allowed_prefixes',
          details: `Comando fuera de los prefijos autorizados: ${trimmed}`
        };
      }
    }

    return { allowed: true };
  }

  function evaluateConstraints(constraints, args = {}) {
    if (!constraints || typeof constraints !== 'object') {
      return { status: 'allow' };
    }

    if (constraints.command) {
      const cmdVal = args.command || args.cmd || args.script || '';
      if (cmdVal) {
        const cmdRes = evaluateCommandConstraint(cmdVal, constraints.command);
        if (cmdRes.denied) {
          return { status: 'deny', reason: cmdRes.reason, details: cmdRes.details };
        }
        if (!cmdRes.allowed) {
          return { status: 'ask', reason: cmdRes.reason, details: cmdRes.details };
        }
      }
    }

    if (constraints.path) {
      const pathVal = args.path || args.filepath || args.file || args.directory || args.dir || args.cwd || '';
      if (pathVal) {
        const pathRes = evaluatePathConstraint(pathVal, constraints.path);
        if (pathRes.denied) {
          return { status: 'deny', reason: pathRes.reason, details: pathRes.details };
        }
        if (!pathRes.allowed) {
          return { status: 'ask', reason: pathRes.reason, details: pathRes.details };
        }
      }
    }

    return { status: 'allow' };
  }

  /**
   * Administrador de Seguridad y Políticas de Ejecución de ZeroChat.
   */
  class ToolSecurityManager {
    constructor(options = {}) {
      this.explicitStorageKey = options.storageKey || null;
      this.storageKey = this.explicitStorageKey || STORAGE_KEY;
      this.sessionToken = options.sessionToken || null;
      this.globalMcpPolicy = GLOBAL_POLICIES.ASK;
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
        const Storage = getStorage();
        let raw = null;
        if (typeof localStorage !== 'undefined' && localStorage?.getItem) {
          try {
            raw = localStorage.getItem(this.storageKey);
          } catch (_) {}
        }
        if (!raw && Storage?.getStorageItem) {
          raw = Storage.getStorageItem(this.storageKey);
        }

        if (raw) {
          const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
          if (parsed && typeof parsed === 'object') {
            if (Object.values(GLOBAL_POLICIES).includes(parsed.globalMcpPolicy)) {
              this.globalMcpPolicy = parsed.globalMcpPolicy;
            }
            if (parsed.tools && typeof parsed.tools === 'object') {
              Object.entries(parsed.tools).forEach(([id, item]) => {
                if (item && typeof item === 'object') {
                  const constraints = item.constraints ? { ...item.constraints } : null;
                  if (constraints?.command?.allowedPrefixes?.some(p => String(p).replace(/\*+$/, '').trim() === 'cd')) {
                    constraints.command = {
                      ...constraints.command,
                      allowChaining: true
                    };
                  }
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
        console.warn('[ToolSecurity] Error al cargar políticas guardadas:', err?.message || err);
      }
      this.syncWithState();
    }

    /**
     * Guarda las políticas permanentes en el almacenamiento local seguro.
     */
    save() {
      try {
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
          version: 3,
          globalMcpPolicy: this.globalMcpPolicy,
          tools: permanentTools,
          servers: permanentServers,
          directoryRules: this.directoryRules,
          updatedAt: Date.now()
        };

        const serialized = JSON.stringify(payload);
        if (typeof localStorage !== 'undefined' && localStorage?.setItem) {
          try {
            localStorage.setItem(this.storageKey, serialized);
          } catch (_) {}
        }
        if (Storage?.setStorageItem) {
          Storage.setStorageItem(this.storageKey, serialized);
        }
      } catch (err) {
        console.warn('[ToolSecurity] Error al persistir políticas:', err?.message || err);
      }

      this.syncWithState();
      this.notifyListeners();
    }

    /**
     * Sincroniza el estado reactivo con ChatState.
     */
    syncWithState() {
      const State = getState();
      if (State && typeof State.set === 'function') {
        const toolsObj = {};
        this.tools.forEach((val, key) => { toolsObj[key] = val; });
        const serversObj = {};
        this.servers.forEach((val, key) => { serversObj[key] = val; });

        State.set('toolSecurity', {
          globalMcpPolicy: this.globalMcpPolicy,
          authorizedCount: this.listAuthorizedTools().length + this.listAuthorizedServers().length,
          tools: toolsObj,
          servers: serversObj,
          directoryRules: this.directoryRules
        });
      }
    }

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

    getGlobalMcpPolicy() {
      return this.globalMcpPolicy;
    }

    setGlobalMcpPolicy(policy) {
      if (!Object.values(GLOBAL_POLICIES).includes(policy)) {
        throw new Error(`Política global no válida: ${policy}`);
      }
      this.globalMcpPolicy = policy;
      this.save();
      return this.globalMcpPolicy;
    }

    getDirectoryRules() {
      return [...this.directoryRules];
    }

    setDirectoryRules(rules) {
      if (!Array.isArray(rules)) throw new Error('Las reglas de directorio deben ser una lista.');
      const normalized = rules.map(parseDirectoryRule);
      if (normalized.some(rule => !rule)) throw new Error('Regla de directorio inválida. Usa R:, W: o RW: seguido de una ruta.');
      this.directoryRules = [...new Set(normalized.map(rule => rule.rule))];
      this.save();
      return this.getDirectoryRules();
    }

    addDirectoryRule(rule) {
      return this.setDirectoryRules([...this.directoryRules, rule]);
    }

    evaluateDirectoryRule(access, path) {
      const normalizedPath = normalizeDirectoryPath(path);
      if (!normalizedPath) return { allowed: false, rule: null };
      const match = this.directoryRules.map(parseDirectoryRule).find(rule =>
        rule && (rule.access === access || rule.access === 'RW') && matchesDirectoryPattern(normalizedPath, rule.path)
      );
      return { allowed: Boolean(match), rule: match?.rule || null, path: normalizedPath };
    }

    findToolEntry(toolIdOrName, tool = null) {
      if (!toolIdOrName && !tool) return null;
      const id = tool ? (tool.id || tool.name) : toolIdOrName;
      if (typeof id === 'string') {
        if (this.tools.has(id)) {
          return { toolId: id, entry: this.tools.get(id) };
        }
        if (COMMAND_TOOLS.has(id)) {
          for (const sibling of COMMAND_TOOLS) {
            if (this.tools.has(sibling)) {
              return { toolId: sibling, entry: this.tools.get(sibling) };
            }
          }
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

    setToolConstraints(toolId, constraints) {
      const found = this.findToolEntry(toolId);
      if (found) {
        found.entry.constraints = constraints || null;
        this.save();
        return true;
      }
      return false;
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

      let constraints = meta.constraints !== undefined ? meta.constraints : (existing.constraints || null);
      if (constraints?.command?.allowedPrefixes?.some(p => String(p).replace(/\*+$/, '').trim() === 'cd')) {
        constraints = {
          ...constraints,
          command: {
            ...constraints.command,
            allowChaining: true
          }
        };
      }

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

      if (COMMAND_TOOLS.has(targetId)) {
        for (const sibling of COMMAND_TOOLS) {
          if (sibling !== targetId) {
            this.tools.set(sibling, {
              ...entry,
              originalName: sibling
            });
          }
        }
      }

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
      if (COMMAND_TOOLS.has(toolId) || (found && COMMAND_TOOLS.has(found.toolId))) {
        for (const sibling of COMMAND_TOOLS) {
          deleted = this.tools.delete(sibling) || deleted;
        }
      }
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

    /**
     * Evalúa la autorización de una herramienta aplicando la jerarquía determinista.
     *
     * Jerarquía:
     * 1. Herramientas integradas seguras (no MCP ni managed) -> allow
     * 2. Lista negra de bloqueo explícito (deny en tool o server) -> deny
     * 3. Política global allow_all -> allow incondicional
     * 4. Política individual de herramienta -> allow (respetando constraints si existen)
     * 5. Política de Servidor MCP completo -> allow incondicional para sus herramientas
     * 6. Reglas de Directorio / Workspace Trust -> allow si está dentro del ámbito
     * 7. Por defecto -> ask (solicitar confirmación)
     */
    evaluateAuthorization(toolOrName, rawArgs = {}) {
      let tool = null;
      let toolName = '';

      if (typeof toolOrName === 'string') {
        toolName = toolOrName;
        const AgentCore = getAgentCore();
        if (AgentCore?.registry?.getTool) {
          tool = AgentCore.registry.getTool(toolName);
        }
      } else if (toolOrName && typeof toolOrName === 'object') {
        tool = toolOrName;
        toolName = tool.name || tool.id || '';
      }

      const toolId = (tool && (tool.id || tool.name)) || toolName;
      const rawId = tool?.id || '';
      const serverName = tool?.metadata?.mcpServerName || '';
      const originalName = tool?.metadata?.originalName || toolName;
      const serverId = extractServerId(tool, toolName);

      const isMcp = tool?.category === 'mcp' ||
        Boolean(tool?.metadata?.mcpServerId) ||
        Boolean(tool?.metadata?.mcpServerName) ||
        Boolean(serverId) ||
        /^mcp_/i.test(toolName) ||
        /^mcp_/i.test(rawId) ||
        LOCAL_MANAGED_TOOLS.has(toolName) ||
        LOCAL_MANAGED_TOOLS.has(rawId);

      // 1. Herramientas nativas y seguras (search_web, execute_javascript, etc.)
      if (!isMcp) {
        return {
          requiresApproval: false,
          status: TOOL_POLICIES.ALLOW,
          reason: 'builtin_tool',
          toolId,
          serverName: '',
          serverId: '',
          originalName: toolName
        };
      }

      const args = { ...rawArgs };
      if ((toolName === 'list_directory' || originalName === 'list_directory') && !args.path && !args.directory && !args.dir) {
        args.path = '.';
      }

      // 2. Denegación explícita (Blacklist) a nivel de herramienta o servidor
      const foundTool = this.findToolEntry(toolId, tool);
      if (foundTool?.entry?.policy === TOOL_POLICIES.DENY) {
        return {
          requiresApproval: false,
          status: TOOL_POLICIES.DENY,
          reason: 'granular_deny_rule',
          toolId: foundTool.toolId,
          serverName,
          serverId,
          originalName
        };
      }

      if (serverId) {
        const foundServer = this.findServerEntry(serverId);
        if (foundServer?.entry?.policy === SERVER_POLICIES.DENY) {
          return {
            requiresApproval: false,
            status: TOOL_POLICIES.DENY,
            reason: 'server_deny_rule',
            toolId,
            serverName,
            serverId,
            originalName
          };
        }
      }

      // 3. Modo global allow_all: TODO permitido
      if (this.globalMcpPolicy === GLOBAL_POLICIES.ALLOW_ALL) {
        return {
          requiresApproval: false,
          status: TOOL_POLICIES.ALLOW,
          reason: 'mcp_global_allow_all',
          toolId,
          serverName,
          serverId,
          originalName
        };
      }

      // 4. Herramienta individual expresamente permitida (allow permanente o sesión)
      if (foundTool?.entry?.policy === TOOL_POLICIES.ALLOW) {
        const rule = foundTool.entry;
        const resolvedToolId = foundTool.toolId;

        if (rule.constraints) {
          const constraintEval = evaluateConstraints(rule.constraints, args);
          if (constraintEval.status === TOOL_POLICIES.DENY) {
            return {
              requiresApproval: false,
              status: TOOL_POLICIES.DENY,
              reason: constraintEval.reason || 'constraint_violation_denied',
              toolId: resolvedToolId,
              serverName,
              serverId,
              originalName,
              details: constraintEval.details
            };
          }
          if (constraintEval.status === TOOL_POLICIES.ASK) {
            return {
              requiresApproval: true,
              status: TOOL_POLICIES.ASK,
              reason: constraintEval.reason || 'constraint_outside_scope',
              toolId: resolvedToolId,
              serverName,
              serverId,
              originalName,
              details: constraintEval.details
            };
          }
        }

        rule.lastUsedAt = Date.now();
        return {
          requiresApproval: false,
          status: TOOL_POLICIES.ALLOW,
          reason: 'granular_allow_rule',
          toolId: resolvedToolId,
          serverName,
          serverId,
          originalName,
          scope: rule.scope || SCOPES.PERMANENT,
          constraints: rule.constraints || null
        };
      }

      // 5. Servidor MCP completo expresamente permitido (allow permanente o sesión)
      if (serverId) {
        const foundServer = this.findServerEntry(serverId);
        if (foundServer?.entry?.policy === SERVER_POLICIES.ALLOW) {
          foundServer.entry.lastUsedAt = Date.now();
          return {
            requiresApproval: false,
            status: TOOL_POLICIES.ALLOW,
            reason: 'server_allow_rule',
            toolId,
            serverName,
            serverId,
            originalName,
            scope: foundServer.entry.scope || SCOPES.PERMANENT
          };
        }
      }

      // 6. Reglas de Directorio y Workspace Trust
      const pathAccess = getIntegratedPathAccess(toolName) || getIntegratedPathAccess(originalName);
      const rawPath = args.path || args.filepath || args.file || args.directory || args.dir || '';

      if (pathAccess && typeof rawPath === 'string' && rawPath.trim()) {
        const path = rawPath.trim();
        const directoryEval = this.evaluateDirectoryRule(pathAccess, path);
        if (directoryEval.allowed) {
          return {
            requiresApproval: false,
            status: TOOL_POLICIES.ALLOW,
            reason: 'directory_rule_allow',
            toolId,
            serverName,
            serverId,
            originalName,
            directoryRule: directoryEval.rule
          };
        }

        // Si workspace_trust está activo y no es escape traversal
        if (this.globalMcpPolicy === GLOBAL_POLICIES.WORKSPACE_TRUST) {
          const norm = normalizePath(path);
          if (!isPathTraversal(norm) && (!norm.startsWith('/') || norm.startsWith('/workspace'))) {
            return {
              requiresApproval: false,
              status: TOOL_POLICIES.ALLOW,
              reason: 'workspace_trust_allow',
              toolId,
              serverName,
              serverId,
              originalName
            };
          }
        }

        return {
          requiresApproval: true,
          status: TOOL_POLICIES.ASK,
          reason: 'directory_rule_required',
          toolId,
          serverName,
          serverId,
          originalName,
          details: `La ruta no coincide con una regla ${pathAccess}: ${path}`,
          directoryAccess: pathAccess,
          directoryPath: directoryEval.path || path
        };
      }

      if ((toolName === 'execute_command' || toolName === 'bash' || originalName === 'execute_command' || originalName === 'bash')
          && this.globalMcpPolicy === GLOBAL_POLICIES.WORKSPACE_TRUST) {
        const cmdVal = String(args.command || args.cmd || args.script || '').trim();
        const isGlobalOrExternal =
          /(?:^|\s)(?:sudo|su|mkfs|reboot|shutdown|systemctl)\b/.test(cmdVal) ||
          /(?:^|\s)(?:\/etc\/|\/var\/|\/usr\/|\/root\/|\/boot\/)/.test(cmdVal) ||
          /\.\.\//.test(cmdVal);

        if (!isGlobalOrExternal) {
          return {
            requiresApproval: false,
            status: TOOL_POLICIES.ALLOW,
            reason: 'workspace_trust_command',
            toolId,
            serverName,
            serverId,
            originalName
          };
        }

        return {
          requiresApproval: true,
          status: TOOL_POLICIES.ASK,
          reason: 'workspace_trust_external_or_global_command',
          toolId,
          serverName,
          serverId,
          originalName,
          details: 'El comando accede a recursos globales o rutas fuera del espacio de trabajo.'
        };
      }

      // 7. Por defecto en MCP: solicitar confirmación interactiva
      return {
        requiresApproval: true,
        status: TOOL_POLICIES.ASK,
        reason: 'mcp_default_ask',
        toolId,
        serverName,
        serverId,
        originalName
      };
    }
  }

  const manager = new ToolSecurityManager();

  return {
    STORAGE_KEY,
    GLOBAL_POLICIES,
    TOOL_POLICIES,
    SERVER_POLICIES,
    SCOPES,
    ToolSecurityManager,
    evaluatePathConstraint,
    evaluateCommandConstraint,
    evaluateConstraints,
    manager
  };
});
