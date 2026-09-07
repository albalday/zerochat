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

    if (commandConstraints.allowChaining === false) {
      // Encadenamiento peligroso: ejecución secuencial (;), condicional (&&, ||), o sustitución de subshell (` o $()`)
      const isSequentialOrCond = /(?:;|&&|\|\||`|\$\()/.test(trimmed);
      // Background execution: & que NO sea parte de una redirección de descriptor (como 2>&1, >&2, &>, &>>)
      const isBackgroundAmp = /(?<!>|\d)&(?!\d|>)/.test(trimmed);

      // Si allowPipes es explícitamente false, se prohíben tuberías |. Por defecto o si allowPipes es true, se permiten pipes.
      const hasUnauthorizedPipe = commandConstraints.allowPipes === false && trimmed.includes('|');

      if (isSequentialOrCond || isBackgroundAmp || hasUnauthorizedPipe) {
        return {
          allowed: false,
          denied: false,
          reason: 'command_chaining_requires_approval',
          details: `Comando contiene encadenamiento o operadores de shell no autorizados: ${trimmed}`
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
        const cleanPrefix = prefix.trim();
        if (
          trimmed === cleanPrefix ||
          trimmed.startsWith(cleanPrefix + ' ') ||
          trimmed.startsWith(cleanPrefix + '\t') ||
          trimmed.startsWith('/usr/bin/' + cleanPrefix + ' ') ||
          trimmed.startsWith('/bin/' + cleanPrefix + ' ') ||
          trimmed.startsWith('/usr/local/bin/' + cleanPrefix + ' ')
        ) {
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
      } catch (err) {
        console.warn('[ToolSecurity] Error al persistir políticas de seguridad:', err?.message || err);
      }

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
     * Resuelve la regla de autorización asociada a una herramienta, admitiendo
     * coincidencia por ID canónico, alias, nombre original o nombres namespaced.
     * @param {string} toolIdOrName 
     * @param {object|null} [tool=null] 
     * @returns {{ toolId: string, entry: object }|null}
     */
    findToolEntry(toolIdOrName, tool = null) {
      if (!toolIdOrName && !tool) return null;

      const candidates = [];
      if (typeof toolIdOrName === 'string' && toolIdOrName.trim()) {
        candidates.push(toolIdOrName.trim());
      }
      if (tool && typeof tool === 'object') {
        if (tool.id && !candidates.includes(tool.id)) candidates.push(tool.id);
        if (tool.name && !candidates.includes(tool.name)) candidates.push(tool.name);
        const orig = tool.metadata?.originalName;
        if (orig && !candidates.includes(orig)) candidates.push(orig);
        if (Array.isArray(tool.aliases)) {
          for (const a of tool.aliases) {
            if (a && !candidates.includes(a)) candidates.push(a);
          }
        }
      }

      // 1. Comprobación directa por candidatos exactos
      for (const id of candidates) {
        if (this.tools.has(id)) {
          return { toolId: id, entry: this.tools.get(id) };
        }
      }

      // 2. Comprobación cruzada contra las entradas existentes
      for (const [savedId, entry] of this.tools.entries()) {
        const savedOrig = entry.originalName || savedId;
        for (const cand of candidates) {
          if (cand === savedOrig) {
            return { toolId: savedId, entry };
          }
          if (savedId.endsWith('__' + cand) || savedId.endsWith('_' + cand)) {
            return { toolId: savedId, entry };
          }
          if (cand.endsWith('__' + savedOrig) || cand.endsWith('_' + savedOrig)) {
            return { toolId: savedId, entry };
          }
        }
      }

      return null;
    }

    /**
     * Obtiene la política específica para una herramienta.
     * @param {string} toolId
     * @returns {'allow'|'deny'|'ask'|null}
     */
    getToolPolicy(toolId) {
      if (!toolId) return null;
      const found = this.findToolEntry(toolId);
      return found ? found.entry.policy : null;
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

      const found = this.findToolEntry(toolId);
      const targetId = found ? found.toolId : toolId;
      const existing = found ? found.entry : (this.tools.get(targetId) || {});

      this.tools.set(targetId, {
        policy: cleanPolicy,
        grantedAt: existing.grantedAt || Date.now(),
        lastUsedAt: Date.now(),
        serverName: meta.serverName || existing.serverName || '',
        originalName: meta.originalName || existing.originalName || toolId,
        constraints: meta.constraints !== undefined ? meta.constraints : (existing.constraints || null)
      });

      this.save();
    }

    /**
     * Obtiene los metadatos completos y restricciones de una herramienta registrada.
     * @param {string} toolId
     */
    getToolEntry(toolId) {
      const found = this.findToolEntry(toolId);
      return found ? found.entry : null;
    }

    /**
     * Obtiene las restricciones configuradas para una herramienta.
     * @param {string} toolId
     * @returns {object|null}
     */
    getToolConstraints(toolId) {
      const found = this.findToolEntry(toolId);
      return found ? (found.entry.constraints || null) : null;
    }

    /**
     * Establece o actualiza las restricciones de una herramienta.
     * @param {string} toolId
     * @param {object|null} constraints
     */
    setToolConstraints(toolId, constraints) {
      const found = this.findToolEntry(toolId);
      if (found) {
        found.entry.constraints = constraints || null;
        this.save();
        return true;
      }
      return false;
    }

    /**
     * Revoca la autorización guardada de una herramienta individual.
     * @param {string} toolId
     */
    revokeToolPolicy(toolId) {
      if (!toolId) return false;
      const found = this.findToolEntry(toolId);
      if (found) {
        this.tools.delete(found.toolId);
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
     * @returns {Array<{ toolId: string, policy: string, grantedAt: number, lastUsedAt?: number, serverName?: string, originalName?: string, constraints?: object }>}
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
     * @returns {{ requiresApproval: boolean, status: 'allow'|'deny'|'ask', reason: string, toolId: string, serverName: string, originalName: string, details?: string }}
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

      // 3. Herramientas MCP con regla granular específica guardada (resolución robusta)
      const foundEntry = this.findToolEntry(toolId, tool);
      if (foundEntry) {
        const rule = foundEntry.entry;
        const resolvedToolId = foundEntry.toolId;

        if (rule.policy === TOOL_POLICIES.ALLOW) {
          // Evaluar restricciones granulares si existen
          if (rule.constraints) {
            const constraintEval = evaluateConstraints(rule.constraints, args);
            if (constraintEval.status === TOOL_POLICIES.DENY) {
              return {
                requiresApproval: false,
                status: TOOL_POLICIES.DENY,
                reason: constraintEval.reason || 'constraint_violation_denied',
                toolId: resolvedToolId,
                serverName,
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
                originalName,
                details: constraintEval.details
              };
            }
          }

          // Registrar último uso
          rule.lastUsedAt = Date.now();
          return {
            requiresApproval: false,
            status: TOOL_POLICIES.ALLOW,
            reason: 'granular_allow_rule',
            toolId: resolvedToolId,
            serverName,
            originalName,
            constraints: rule.constraints || null
          };
        }
        if (rule.policy === TOOL_POLICIES.DENY) {
          return {
            requiresApproval: false,
            status: TOOL_POLICIES.DENY,
            reason: 'granular_deny_rule',
            toolId: resolvedToolId,
            serverName,
            originalName
          };
        }
        // Si explícitamente se configuró como 'ask'
        return {
          requiresApproval: true,
          status: TOOL_POLICIES.ASK,
          reason: 'granular_ask_rule',
          toolId: resolvedToolId,
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
    evaluatePathConstraint,
    evaluateCommandConstraint,
    evaluateConstraints,
    manager
  };
});

