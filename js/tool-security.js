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

  const STORAGE_KEY = 'zc_tool_security_v3';
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

  // Solo se puede crear una regla para rutas que el navegador resuelve: sin ~, variables
  // ni ".." por encima de la raíz.
  function canBuildDirectoryRule(path) {
    return Boolean(normalizeDirectoryPath(path));
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
    if (!pattern.includes('*')) {
      if (path === pattern) return true;
      const prefix = pattern.endsWith('/') ? pattern : `${pattern}/`;
      if (path.startsWith(prefix)) return true;
    }
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

  // Sintaxis de shell que ejecuta otro comando: ; && || & ` $( <( >( y saltos de línea (T02).
  function hasCommandChaining(cmd) {
    return /[;\n\r`]|&&|\|\||\$\(|[<>]\(/.test(cmd) || /(?<!>|\d)&(?!\d|>)/.test(cmd);
  }

  // Redirecciones a ficheros; solo se admiten las que duplican descriptores o descartan salida.
  const SAFE_REDIRECTION_PATTERN = /&>\s*\/dev\/null|\d?>>?\s*\/dev\/null|\d?>&\d/g;

  function hasFileRedirection(cmd) {
    return /[<>]/.test(cmd.replace(SAFE_REDIRECTION_PATTERN, ' '));
  }

  // "cd <dir> && <cmd>": separa la navegación inicial para validar el directorio y el comando
  // por separado. Un directorio con variables, sustituciones u otros separadores no encaja.
  function splitLeadingCd(cmd) {
    const match = /^cd\s+("[^"$`\\]*"|'[^']*'|[^\s;&|<>`$()'"\\]+)\s*&&\s*(\S[\s\S]*)$/.exec(cmd);
    if (!match) return null;
    return { directory: match[1].replace(/^(["'])(.*)\1$/, '$2'), command: match[2].trim() };
  }

  // Programa que ejecuta realmente el comando, omitiendo un "cd <dir> &&" inicial.
  function getCommandBaseName(cmd) {
    const trimmed = String(cmd || '').trim();
    const leadingCd = splitLeadingCd(trimmed);
    return (leadingCd ? leadingCd.command : trimmed).split(/\s+/)[0] || '';
  }

  // workspace_trust solo confía en comandos simples: sin encadenar, redirigir ni sustituir, sin
  // rutas absolutas, ~, variables ni "..", y con tuberías únicamente hacia filtros de texto (T02).
  const WORKSPACE_TRUST_PIPE_FILTERS = new Set([
    'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'wc', 'sort', 'uniq', 'cut', 'tr', 'column', 'nl', 'cat', 'jq'
  ]);
  const WORKSPACE_TRUST_GLOBAL_COMMANDS = /(?:^|\s)(?:sudo|su|doas|mkfs|reboot|shutdown|systemctl)\b/;
  const WORKSPACE_TRUST_OUTSIDE_REFERENCE = /(?:^|[\s=:'"])(?:[\\/~]|[A-Za-z]:[\\/])|\$|(?:^|[\s=:'"\\/])\.\.(?=[\s\\/'"]|$)/;

  function isWorkspaceLocalCommand(cmd) {
    if (!cmd || hasCommandChaining(cmd) || hasFileRedirection(cmd)) return false;
    const pipedStages = cmd.split('|').slice(1);
    if (pipedStages.some(stage => !WORKSPACE_TRUST_PIPE_FILTERS.has(stage.trim().split(/\s+/)[0]))) return false;
    return !WORKSPACE_TRUST_GLOBAL_COMMANDS.test(cmd) && !WORKSPACE_TRUST_OUTSIDE_REFERENCE.test(cmd);
  }

  const { resolveDep } = Utils;

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

  function matchesCommandPrefix(command, prefix) {
    const cleanPrefix = String(prefix).replace(/\*+$/, '').trim();
    return command === cleanPrefix ||
      (cleanPrefix.endsWith('/') && command.startsWith(cleanPrefix)) ||
      command.startsWith(cleanPrefix + ' ') ||
      command.startsWith(cleanPrefix + '\t') ||
      command.startsWith('/usr/bin/' + cleanPrefix + ' ') ||
      command.startsWith('/bin/' + cleanPrefix + ' ') ||
      command.startsWith('/usr/local/bin/' + cleanPrefix + ' ');
  }

  function evaluateCommandConstraint(cmdVal, commandConstraints) {
    if (!cmdVal || typeof cmdVal !== 'string') return { allowed: true };
    if (!commandConstraints || typeof commandConstraints !== 'object') return { allowed: true };

    const trimmed = cmdVal.trim();
    // Un "cd <dir> &&" inicial no cuenta como encadenamiento: se valida el comando que le sigue.
    // El directorio lo comprueba evaluateCommandDirectories contra las reglas de directorio.
    const leadingCd = splitLeadingCd(trimmed);
    const command = leadingCd ? leadingCd.command : trimmed;

    if (commandConstraints.allowChaining !== true) {
      const hasUnauthorizedPipe = commandConstraints.allowPipes !== true && command.includes('|');

      if (hasCommandChaining(command) || hasFileRedirection(command) || hasUnauthorizedPipe) {
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
        if (matchesCommandPrefix(command, prefix)) {
          matched = true;
          break;
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
      this.startupDirectory = normalizeDirectoryPath(
        options.startupDirectory ||
        (typeof process !== 'undefined' && process?.cwd && typeof process.cwd === 'function' ? process.cwd() : '.')
      );
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
          } catch (_) { /* almacenamiento bloqueado: se usa la configuración por defecto */ }
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
                  // Hasta la versión 3, "Permitir siempre <cmd>" y el prefijo cd guardaban
                  // encadenamiento y tuberías sin que el usuario lo pidiera (T02).
                  if (constraints?.command && !(parsed.version >= STORAGE_VERSION)) {
                    constraints.command = {
                      ...constraints.command,
                      allowChaining: false,
                      allowPipes: false
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

        const serialized = JSON.stringify(payload);
        if (typeof localStorage !== 'undefined' && localStorage?.setItem) {
          try {
            localStorage.setItem(this.storageKey, serialized);
          } catch (error) {
            console.warn('[ChatToolSecurity] Could not persist the tool security policy:', error);
          }
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
          authorizedCount: this.tools.size + this.servers.size,
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
        try { fn(this); } catch (e) { console.warn('[ChatToolSecurity] Listener failed:', e); }
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
          ? 'Regla de directorio inválida: ~ y variables no se resuelven en el navegador. Usa una ruta absoluta.'
          : 'Regla de directorio inválida. Usa R:, W: o RW: seguido de una ruta.');
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

    evaluateDirectoryRule(access, path) {
      if (containsUnresolvedReference(path)) {
        // El navegador no puede resolver ~ ni variables: nunca encajarlas contra una regla (T01).
        return { allowed: false, rule: null };
      }
      const normalizedPath = normalizeDirectoryPath(path);
      if (!normalizedPath) return { allowed: false, rule: null };
      const startupDir = this.getStartupDirectory();
      let resolvedAbsolute = null;
      if (!normalizedPath.startsWith('/') && startupDir && startupDir.startsWith('/')) {
        resolvedAbsolute = normalizeDirectoryPath(normalizedPath === '.' ? startupDir : `${startupDir}/${normalizedPath}`);
      }
      const match = this.directoryRules.map(parseDirectoryRule).find(rule => {
        if (!rule || (rule.access !== access && rule.access !== 'RW')) return false;
        if (matchesDirectoryPattern(normalizedPath, rule.path)) return true;
        if (resolvedAbsolute && matchesDirectoryPattern(resolvedAbsolute, rule.path)) return true;
        return false;
      });
      return { allowed: Boolean(match), rule: match?.rule || null, path: normalizedPath };
    }

    /**
     * Comprueba los directorios en que se ejecutará un comando (argumento cwd y "cd <dir> &&"
     * inicial): cada uno debe estar cubierto por alguna regla de directorio (T01/T02).
     */
    evaluateCommandDirectories(args = {}) {
      const cmdVal = String(args.command || args.cmd || args.script || '').trim();
      const cwd = typeof args.cwd === 'string' && args.cwd.trim() !== '.' ? args.cwd.trim() : '';
      const leadingCd = splitLeadingCd(cmdVal);
      const directories = cwd ? [cwd] : [];
      if (leadingCd) {
        const isRelative = !/^[\\/~$]/.test(leadingCd.directory);
        directories.push(cwd && isRelative ? `${cwd}/${leadingCd.directory}` : leadingCd.directory);
      }
      const outside = directories.find(dir =>
        !this.evaluateDirectoryRule('R', dir).allowed && !this.evaluateDirectoryRule('W', dir).allowed);
      return outside ? { allowed: false, directory: outside } : { allowed: true };
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
          if (rule.constraints.command) {
            const directoryEval = this.evaluateCommandDirectories(args);
            if (!directoryEval.allowed) {
              return {
                requiresApproval: true,
                status: TOOL_POLICIES.ASK,
                reason: 'command_directory_outside_rules',
                toolId: resolvedToolId,
                serverName,
                serverId,
                originalName,
                details: `El comando se ejecuta fuera de las reglas de directorio: ${directoryEval.directory}`
              };
            }
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
          // Resolver ".." antes de comparar: "/workspace/../home" no es el espacio de trabajo.
          const resolved = normalizeDirectoryPath(path);
          const isInsideWorkspace = Boolean(resolved) && !/^[A-Za-z]:/.test(path) &&
            (!resolved.startsWith('/') || resolved === '/workspace' || resolved.startsWith('/workspace/'));
          if (isInsideWorkspace) {
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
          directoryAccess: directoryEval.path ? pathAccess : '',
          directoryPath: directoryEval.path || ''
        };
      }

      if ((toolName === 'execute_command' || toolName === 'bash' || originalName === 'execute_command' || originalName === 'bash')
          && this.globalMcpPolicy === GLOBAL_POLICIES.WORKSPACE_TRUST) {
        const cmdVal = String(args.command || args.cmd || args.script || '').trim();
        const leadingCd = splitLeadingCd(cmdVal);
        const isLocal = isWorkspaceLocalCommand(leadingCd ? leadingCd.command : cmdVal) &&
          this.evaluateCommandDirectories(args).allowed;

        if (isLocal) {
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
    getCommandBaseName,
    canBuildDirectoryRule,
    manager
  };
});
