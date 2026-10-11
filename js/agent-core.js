/**
 * Módulo de Núcleo Agéntico y Sistema Modular de Herramientas (ChatAgentCore) para ZeroChat.
 *
 * Arquitectura:
 * Model -> AgentCore -> ToolRegistry -> Tool -> ToolExecutor
 *
 * Preparado para MCP (Model Context Protocol) y herramientas extensibles.
 * Compatible con entornos file://, http:// y Node.js.
 */

(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.ChatAgentCore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Resolutores perezosos de dependencias del entorno
  function getBuiltinToolModule(globalName, modulePath) {
    if (typeof window !== 'undefined' && window[globalName]) {
      return window[globalName];
    }
    if (typeof require !== 'undefined') {
      try { return require(modulePath); } catch (e) { /* módulo opcional: no disponible en este entorno */ }
    }
    return null;
  }

  function getBuiltinToolManifest() {
    if (typeof window !== 'undefined' && window.ChatToolManifest) return window.ChatToolManifest.builtin;
    if (typeof require !== 'undefined') {
      try { return require('./tools/tool-manifest.js').builtin; } catch (e) { /* módulo opcional: no disponible en este entorno */ }
    }
    return null;
  }

  function createBuiltinTool(toolId, globalName, modulePath) {
    const builtinManifest = getBuiltinToolManifest();
    const toolModule = builtinManifest?.get(toolId) || getBuiltinToolModule(globalName, modulePath);
    if (!toolModule || typeof toolModule.createTool !== 'function') {
      throw new Error(`No se pudo cargar el módulo de la herramienta ${toolId}.`);
    }
    return toolModule.createTool(Tool);
  }

  function getAPI() {
    if (typeof window !== 'undefined' && window.ChatAPI) return window.ChatAPI;
    if (typeof require !== 'undefined') {
      try { return require('./api.js'); } catch (e) { /* módulo opcional: no disponible en este entorno */ }
    }
    return null;
  }

  function getContextManager() {
    if (typeof window !== 'undefined' && window.ChatContextManager) return window.ChatContextManager;
    if (typeof require !== 'undefined') {
      try { return require('./context-manager.js'); } catch (e) { /* módulo opcional: no disponible en este entorno */ }
    }
    return null;
  }

  function getToolRuntime() {
    if (typeof window !== 'undefined' && window.ChatToolRuntime) return window.ChatToolRuntime;
    if (typeof require !== 'undefined') {
      try { return require('./tools/tool-runtime.js'); } catch (e) { /* módulo opcional: no disponible en este entorno */ }
    }
    return null;
  }

  function getToolSecurity() {
    if (typeof window !== 'undefined' && window.ChatToolSecurity) return window.ChatToolSecurity;
    if (typeof require !== 'undefined') {
      try { return require('./tool-security.js'); } catch (e) { /* módulo opcional: no disponible en este entorno */ }
    }
    return null;
  }

  function getToolCards() {
    if (typeof window !== 'undefined' && window.ChatToolCards) return window.ChatToolCards;
    if (typeof require !== 'undefined') {
      try { return require('./tool-cards.js'); } catch (e) { /* módulo opcional: no disponible en este entorno */ }
    }
    return null;
  }

  function getI18n() {
    if (typeof window !== 'undefined' && window.ChatI18n) return window.ChatI18n;
    if (typeof require !== 'undefined') {
      try { return require('./i18n.js'); } catch (e) { /* módulo opcional: no disponible en este entorno */ }
    }
    return null;
  }

  function createCancelledError() {
    return new Error('Ejecución agéntica cancelada por el usuario.');
  }

  /** Interruptor de una herramienta: por id, por nombre o su valor por defecto. */
  function isToolEnabled(enabledTools = {}, { id, name, defaultEnabled = true }) {
    const key = id || name;
    if (enabledTools[key] !== undefined) return enabledTools[key] !== false;
    if (enabledTools[name] !== undefined) return enabledTools[name] !== false;
    return defaultEnabled !== false;
  }

  function withoutReasoningReplay(message) {
    if (!message || !message.reasoningReplay) return message;
    const { reasoningReplay, ...rest } = message;
    return rest;
  }

  function createInvocationId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return `inv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }

  /**
   * Versión del contrato público que deben implementar las herramientas.
   *
   * Una herramienta puede exponerse como una instancia de Tool (adaptador de
   * compatibilidad) o como un módulo que implemente los mismos métodos. Las
   * futuras herramientas autocontenidas usarán este contrato directamente.
   */
  const TOOL_CONTRACT_VERSION = 1;

  /**
   * Resultado normalizado de una ejecución. Mantiene el resultado nativo en
   * `data` para no alterar el comportamiento de las herramientas existentes.
   */
  class ToolOutcome {
    constructor(options = {}) {
      this.ok = options.ok !== false;
      this.data = options.data === undefined ? null : options.data;
      this.error = options.error || null;
      this.meta = options.meta || {};
    }

    static fromExecution(result, meta = {}) {
      const ok = result?.success !== false;
      return new ToolOutcome({
        ok,
        data: result,
        error: result?.error || null,
        meta
      });
    }

    static fromError(error, meta = {}) {
      return new ToolOutcome({
        ok: false,
        data: null,
        error: error?.message || String(error || 'Error de ejecución de herramienta.'),
        meta
      });
    }
  }

  /**
   * Valida el contrato mínimo de una herramienta antes de registrarla.
   * La vista es opcional: sin ella se usa el renderer genérico.
   */
  function validateToolContract(tool) {
    const errors = [];
    if (!tool || typeof tool !== 'object') {
      return { valid: false, errors: ['La herramienta debe ser un objeto.'] };
    }
    if (!tool.id || typeof tool.id !== 'string') errors.push('Falta un id de herramienta válido.');
    if (!tool.name || typeof tool.name !== 'string') errors.push('Falta un nombre de función válido.');
    if (!tool.description || typeof tool.description !== 'string') errors.push('Falta una descripción válida.');
    if (!tool.parameters || tool.parameters.type !== 'object') errors.push('El esquema parameters debe ser un objeto JSON Schema.');
    if (typeof tool.getDefinition !== 'function') errors.push('Falta getDefinition().');
    if (typeof tool.execute !== 'function') errors.push('Falta execute(args, context).');
    if (typeof tool.isAvailable !== 'function') errors.push('Falta isAvailable(context).');
    if (typeof tool.serializeResultForModel !== 'function') errors.push('Falta serializeResultForModel(args, result).');
    if (typeof tool.formatMarkdownResult !== 'function') errors.push('Falta formatMarkdownResult(args, result).');
    if (typeof tool.formatDispatchMarkdown !== 'function') errors.push('Falta formatDispatchMarkdown(args, result).');
    if (!tool.settings || typeof tool.settings !== 'object') errors.push('Falta descriptor settings.');

    return { valid: errors.length === 0, errors };
  }

  /**
   * Representa una herramienta individual ejecutable y adapta la API histórica
   * al contrato ToolModule v1.
   */
  class Tool {
    constructor(options = {}) {
      const definition = options.definition || {};
      this.contractVersion = options.contractVersion || TOOL_CONTRACT_VERSION;
      this.id = options.id || definition.id || definition.name || options.name || '';
      this.name = definition.name || options.name || '';
      // Un servidor MCP puede publicar herramientas sin descripción: se usa el nombre.
      this.description = definition.description || options.description || this.name;
      this.parameters = definition.parameters || options.parameters || { type: 'object', properties: {} };
      this.aliases = Array.isArray(options.aliases) ? options.aliases : [];
      this.category = options.category || 'general';
      this.metadata = options.metadata || {};
      const settings = options.settings || {};
      this.settings = {
        titleKey: settings.titleKey || `agent_${this.name}_title`,
        titleFallback: settings.titleFallback || options.metadata?.label || this.name,
        descKey: settings.descKey || `agent_${this.name}_desc`,
        descFallback: settings.descFallback || this.description,
        defaultEnabled: settings.defaultEnabled !== false,
        showInSettings: settings.showInSettings !== false
      };
      this.executeHandler = options.execute || null;
      this.result = options.result || {};
      this.formatter = options.formatter || null;
      this.promptGuide = options.promptGuide || options.getSystemPromptGuide || null;
      this.isAvailable = typeof options.isAvailable === 'function' ? options.isAvailable : (() => true);
      this.displayMode = options.displayMode || options.view?.displayMode || options.metadata?.displayMode || options.definition?.displayMode || 'collapsed';
      this.view = options.view ? { displayMode: this.displayMode, ...options.view } : { id: this.name, displayMode: this.displayMode };
    }

    /**
     * Devuelve la definición en formato estándar Function Calling (OpenAI, Claude, Gemini).
     */
    getDefinition() {
      return {
        type: 'function',
        function: {
          name: this.name,
          description: this.description,
          parameters: this.parameters
        }
      };
    }

    /**
     * Devuelve la línea descriptiva de la herramienta para el System Prompt (guía de texto plano).
     */
    getSystemPromptGuide(lang = 'es') {
      if (typeof this.promptGuide === 'function') {
        return this.promptGuide(lang);
      }
      return `- \`${this.name}\`: ${this.description}`;
    }

    /**
     * Ejecuta la herramienta asíncronamente.
     */
    async execute(args, context = {}) {
      if (typeof this.executeHandler === 'function') {
        return this.executeHandler(args, context);
      }
      throw new Error(`La herramienta ${this.name} no tiene handler de ejecución implementado.`);
    }

    /**
     * Serializa una salida para el mensaje con rol `tool` que consume el LLM.
     */
    serializeResultForModel(args, result, outcome) {
      if (typeof this.result.toModel === 'function') {
        return this.result.toModel(args, result, outcome);
      }
      return typeof result === 'object' ? JSON.stringify(result) : String(result ?? '');
    }

    /**
     * Formatea el resultado en Markdown para su inserción en el historial o exportación.
     */
    formatMarkdownResult(args, result, outcome) {
      if (typeof this.formatter === 'function') {
        return this.formatter(args, result, outcome);
      }
      const output = typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result);
      return `> ⚙️ **${this.name}**\n> \`\`\`json\n> ${output.split('\n').join('\n> ')}\n> \`\`\``;
    }

    /**
     * Formato resumido que se añade al despacho y a la exportación de chat.
     * Puede diferir del formato detallado conservado por la API histórica.
     */
    formatDispatchMarkdown(args, result, outcome) {
      if (typeof this.result.toMarkdown === 'function') {
        return this.result.toMarkdown(args, result, outcome);
      }
      return this.formatMarkdownResult(args, result, outcome);
    }
  }

  /**
   * Clase base para proveedores de herramientas (ToolProvider).
   */
  class BaseToolProvider {
    constructor(options = {}) {
      this.id = options.id || 'base';
      this.name = options.name || 'Base Tool Provider';
    }

    /**
     * Devuelve el array de instancias Tool provistas por este proveedor.
     */
    getTools() {
      return [];
    }
  }

  /**
   * Proveedor de herramientas nativas de ZeroChat (BuiltinToolProvider).
   * Provee las herramientas nativas registradas en módulos autocontenidos.
   */
  class BuiltinToolProvider extends BaseToolProvider {
    constructor() {
      super({ id: 'builtin', name: 'ZeroChat Built-in Tools' });
    }

    getTools() {
      const tools = [];

      // 1. Herramienta execute_javascript (módulo autocontenido)
      tools.push(createBuiltinTool('execute_javascript', 'ChatBuiltinExecuteJavascriptTool', './tools/builtin/execute-javascript.tool.js'));

      // 2-4. Herramientas web autocontenidas
      tools.push(createBuiltinTool('search_web', 'ChatBuiltinSearchWebTool', './tools/builtin/search-web.tool.js'));
      tools.push(createBuiltinTool('fetch_web_page', 'ChatBuiltinFetchWebPageTool', './tools/builtin/fetch-web-page.tool.js'));
      tools.push(createBuiltinTool('download_pdf', 'ChatBuiltinDownloadPdfTool', './tools/builtin/download-pdf.tool.js'));

      // 5-8. Gráficos y RAG como módulos autocontenidos.
      tools.push(createBuiltinTool('render_chart', 'ChatBuiltinRenderChartTool', './tools/builtin/render-chart.tool.js'));
      tools.push(createBuiltinTool('list_documents', 'ChatBuiltinListDocumentsTool', './tools/builtin/list-documents.tool.js'));
      tools.push(createBuiltinTool('search_knowledge_base', 'ChatBuiltinSearchKnowledgeBaseTool', './tools/builtin/search-knowledge-base.tool.js'));
      tools.push(createBuiltinTool('read_knowledge_chunk', 'ChatBuiltinReadKnowledgeChunkTool', './tools/builtin/read-knowledge-chunk.tool.js'));
      tools.push(createBuiltinTool('read_knowledge_image', 'ChatBuiltinReadKnowledgeImageTool', './tools/builtin/read-knowledge-image.tool.js'));

      // 9. Interacción: pregunta con opciones que cede el turno al usuario.
      tools.push(createBuiltinTool('ask_user', 'ChatBuiltinAskUserTool', './tools/builtin/ask-user.tool.js'));

      // 10. Subagente de solo lectura con contexto propio.
      tools.push(createBuiltinTool('delegate_task', 'ChatBuiltinDelegateTaskTool', './tools/builtin/delegate-task.tool.js'));

      return tools;
    }
  }

  /**
   * Registro central de herramientas y proveedores (ToolRegistry).
   */
  class ToolRegistry {
    constructor() {
      this.tools = new Map();
      this.aliasMap = new Map();
      this.providers = new Map();

      // Registrar proveedor de herramientas nativas por defecto
      this.registerProvider(new BuiltinToolProvider());
    }

    /**
     * Registra un proveedor de herramientas.
     */
    registerProvider(provider) {
      if (!provider || !provider.id) return;
      this.providers.set(provider.id, provider);
      const tools = provider.getTools();
      if (Array.isArray(tools)) {
        tools.forEach(tool => this.registerTool(tool));
      }
    }

    /**
     * Registra una herramienta individual.
     */
    registerTool(tool) {
      const validation = validateToolContract(tool);
      if (!validation.valid) {
        throw new Error(`Contrato de herramienta inválido: ${validation.errors.join(' ')}`);
      }
      const canonicalName = tool.category === 'mcp' ? tool.name.trim() : tool.name.trim().toLowerCase();
      this.tools.set(canonicalName, tool);

      if (tool.category === 'mcp') return tool;

      // Mapear nombre canónico normalizado sin guiones bajos
      this.aliasMap.set(canonicalName.replace(/_/g, ''), canonicalName);

      // Mapear alias declarados
      if (Array.isArray(tool.aliases)) {
        tool.aliases.forEach(alias => {
          const cleanAlias = String(alias).trim().toLowerCase();
          this.aliasMap.set(cleanAlias, canonicalName);
          this.aliasMap.set(cleanAlias.replace(/_/g, ''), canonicalName);
        });
      }
      return tool;
    }

    /**
     * Obtiene una herramienta por su nombre canónico o alias.
     */
    getTool(rawName) {
      if (!rawName) return null;
      const exactName = String(rawName).trim();
      if (this.tools.has(exactName)) {
        return this.tools.get(exactName);
      }
      const clean = exactName.toLowerCase();
      if (this.tools.has(clean)) {
        const tool = this.tools.get(clean);
        return tool.category === 'mcp' ? null : tool;
      }
      const canonical = this.aliasMap.get(clean) || this.aliasMap.get(clean.replace(/_/g, ''));
      if (canonical && this.tools.has(canonical) && this.tools.get(canonical).category !== 'mcp') {
        return this.tools.get(canonical);
      }
      return null;
    }

    /**
     * Comprueba si una herramienta está registrada.
     */
    hasTool(name) {
      return !!this.getTool(name);
    }

    /**
     * Desregistra un proveedor y todas las herramientas que expone.
     */
    unregisterProvider(providerId) {
      if (!providerId || !this.providers.has(providerId)) return;
      const provider = this.providers.get(providerId);
      this.providers.delete(providerId);
      const tools = typeof provider.getTools === 'function' ? provider.getTools() : [];
      if (Array.isArray(tools)) {
        tools.forEach(tool => {
          if (tool && tool.name) {
            this.unregisterTool(tool.name);
          }
        });
      }
    }

    /**
     * Desregistra una herramienta individual y sus alias.
     */
    unregisterTool(name) {
      if (!name) return;
      const exactName = String(name).trim();
      const clean = exactName.toLowerCase();
      const tool = this.tools.get(exactName) || this.tools.get(clean);
      if (tool) {
        this.tools.delete(tool.category === 'mcp' ? exactName : clean);
        this.aliasMap.delete(clean.replace(/_/g, ''));
        if (Array.isArray(tool.aliases)) {
          tool.aliases.forEach(alias => {
            const cleanAlias = String(alias).trim().toLowerCase();
            this.aliasMap.delete(cleanAlias);
            this.aliasMap.delete(cleanAlias.replace(/_/g, ''));
          });
        }
      }
    }

    /**
     * Devuelve las herramientas visibles para la UI de Configuración.
     * @param {string} [filterCategory=null] - Opcional: filtrar por categoría ('builtin', 'mcp', etc.)
     */
    listToolsForUI(filterCategory = null) {
      const list = [];
      for (const tool of this.tools.values()) {
        if (tool.settings && tool.settings.showInSettings !== false) {
          if (filterCategory && tool.category !== filterCategory) {
            continue;
          }
          list.push({
            id: tool.id || tool.name,
            name: tool.name,
            category: tool.category,
            titleKey: tool.settings.titleKey,
            descKey: tool.settings.descKey,
            defaultEnabled: tool.settings.defaultEnabled !== false
          });
        }
      }
      return list;
    }

    /**
     * Una herramienta está activa si está disponible en su contexto (por ejemplo, RAG exige una
     * rama activa) y, cuando se configura en la interfaz, si su interruptor está encendido.
     */
    isToolActive(tool, appConfig = {}) {
      if (typeof tool.isAvailable === 'function' && !tool.isAvailable(appConfig)) return false;
      if (!tool.settings || tool.settings.showInSettings === false) return true;
      return isToolEnabled(appConfig.enabledTools, { id: tool.id, name: tool.name, defaultEnabled: tool.settings.defaultEnabled });
    }

    /** Definiciones Function Calling de las herramientas activas según la configuración. */
    getActiveDefinitions(appConfig = {}) {
      return [...this.tools.values()].filter(tool => this.isToolActive(tool, appConfig)).map(tool => tool.getDefinition());
    }

    /**
     * Genera la guía textual de herramientas para el System Prompt.
     */
    getActivePromptGuide(appConfig = {}) {
      const guides = [];

      for (const tool of this.tools.values()) {
        if (!this.isToolActive(tool, appConfig)) continue;

        if (typeof tool.getSystemPromptGuide === 'function') {
          const guideStr = tool.getSystemPromptGuide('en');
          if (guideStr && typeof guideStr === 'string') {
            guides.push(guideStr);
          }
        }
      }

      if (guides.length === 0) return '';

      return `\n\n[AVAILABLE TOOLS AND FUNCTIONS]:\nYou can use the following tools when needed to answer accurately:\n${guides.join('\n')}\n*Workflow instruction:* After using tools, answer the user's question directly, clearly, and concisely. Use findings only as evidence, citing sources briefly or via inline links. Avoid lengthy or redundant summaries of consulted sources and do not show raw tool output.`;
    }

    /**
     * Lista todas las herramientas registradas con sus metadatos.
     */
    listTools() {
      return Array.from(this.tools.values());
    }
  }

  /**
   * Motor de ejecución seguro para llamadas a herramientas (ToolExecutor).
   */
  class ToolExecutor {
    constructor(registry) {
      this.registry = registry || new ToolRegistry();
    }

    /**
     * Parsea los argumentos de una llamada a herramienta. Devuelve `null` si no
     * son un objeto JSON válido: nunca se adivinan argumentos que el modelo no emitió.
     */
    parseArguments(rawArgs) {
      if (rawArgs === undefined || rawArgs === null || rawArgs === '') return {};
      if (typeof rawArgs === 'object') return Array.isArray(rawArgs) ? null : rawArgs;

      const str = String(rawArgs).trim();
      if (!str) return {};
      try {
        const parsed = JSON.parse(str);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
      } catch (e) {
        return null;
      }
    }

    /**
     * Aplica la política de ejecución antes de invocar una herramienta. La UI
     * puede aportar `requestToolAuthorization`, pero no puede omitir este
     * punto de control.
     * @private
     */
    async _authorizeToolCall(tool, args, toolCall, context) {
      const ToolSecurity = getToolSecurity();
      const I18n = getI18n();
      const t = (key, fallback) => (I18n?.t ? I18n.t(key) : fallback);
      const authEval = ToolSecurity?.manager?.evaluateAuthorization
        ? ToolSecurity.manager.evaluateAuthorization(tool, args, context)
        : { status: 'deny', requiresApproval: true };

      if (authEval.status === 'deny') {
        return { allowed: false, error: t('tool_security_policy_blocked', 'Herramienta bloqueada por política de seguridad.') };
      }

      if (!authEval.requiresApproval) {
        return { allowed: true };
      }

      if (typeof context.requestToolAuthorization !== 'function') {
        return { allowed: false, error: 'The tool requires explicit user authorization.' };
      }

      const decision = await context.requestToolAuthorization(toolCall, {
        args,
        serverName: authEval.serverName,
        serverId: authEval.serverId,
        toolName: tool.name,
        directoryAccess: authEval.directoryAccess,
        directoryPath: authEval.directoryPath,
        signal: context.signal
      });
      const decisionType = (typeof decision === 'object' && decision !== null) ? decision.decision : decision;

      if (context.signal?.aborted) return { allowed: false, error: 'Tool execution cancelled.' };
      if (ToolSecurity?.manager?.evaluateAuthorization(tool, args, context).status === 'deny') {
        return { allowed: false, error: t('tool_security_policy_blocked', 'Tool blocked by security policy.') };
      }

      const allowedDecisions = new Set([
        'allow_once',
        'allow_session',
        'allow_always',
        'allow_server_always'
      ]);

      if (!allowedDecisions.has(decisionType)) {
        return { allowed: false, error: t('tool_auth_denied_msg', 'Ejecución denegada por el usuario.') };
      }

      if (typeof decision === 'object' && decision !== null && decision.directoryRule) {
        try {
          ToolSecurity?.manager?.addDirectoryRule?.(decision.directoryRule);
        } catch (error) {
          return { allowed: false, error: error?.message || t('tool_auth_denied_msg', 'Ejecución denegada por el usuario.') };
        }
      }

      const targetToolId = authEval.toolId || tool.name;

      if (decisionType === 'allow_session') {
        ToolSecurity?.manager?.setToolPolicy?.(targetToolId, 'allow', {
          scope: 'session',
          serverName: authEval.serverName,
          originalName: authEval.originalName
        });
      } else if (decisionType === 'allow_server_always') {
        const targetServerId = decision?.serverId || authEval.serverId;
        if (targetServerId) {
          ToolSecurity?.manager?.setServerPolicy?.(targetServerId, 'allow', {
            scope: 'permanent',
            serverName: authEval.serverName
          });
        }
      } else if (decisionType === 'allow_always') {
        const requestedConstraints = (typeof decision === 'object' && decision !== null) ? (decision.constraints || null) : null;
        const existingConstraints = ToolSecurity.manager.getToolConstraints?.(targetToolId) || null;
        let mergedPrefixes = undefined;
        if (requestedConstraints?.command?.allowedPrefixes || existingConstraints?.command?.allowedPrefixes) {
          const rawList = [
            ...(Array.isArray(existingConstraints?.command?.allowedPrefixes) ? existingConstraints.command.allowedPrefixes : []),
            ...(Array.isArray(requestedConstraints?.command?.allowedPrefixes) ? requestedConstraints.command.allowedPrefixes : [])
          ];
          const seen = new Set();
          mergedPrefixes = [];
          for (const p of rawList) {
            if (typeof p !== 'string') continue;
            const clean = p.trim();
            if (!clean || seen.has(clean)) continue;
            seen.add(clean);
            mergedPrefixes.push(p);
          }
        }

        // Encadenamiento y tuberías solo se conservan si la nueva autorización y la existente
        // los conceden explícitamente; al fusionar prevalece siempre la opción más restrictiva.
        const grantsSyntax = (key) => requestedConstraints.command[key] === true &&
          (!existingConstraints?.command || existingConstraints.command[key] === true);

        const constraints = requestedConstraints?.command
          ? {
            ...(existingConstraints?.command ? existingConstraints : {}),
            ...requestedConstraints,
            command: {
              ...(existingConstraints?.command || {}),
              ...requestedConstraints.command,
              ...(mergedPrefixes ? { allowedPrefixes: mergedPrefixes } : {}),
              allowChaining: grantsSyntax('allowChaining'),
              allowPipes: grantsSyntax('allowPipes')
            }
          }
          : requestedConstraints;

        ToolSecurity.manager.setToolPolicy(targetToolId, 'allow', {
          scope: 'permanent',
          serverName: authEval.serverName,
          originalName: authEval.originalName,
          constraints
        });
      }

      return { allowed: true };
    }

    /**
     * Ejecuta una llamada a herramienta con control de tiempo, métricas y manejo de errores.
     */
    async executeToolCall(toolCall, context = {}) {
      const rawName = toolCall?.function?.name || '';
      const tool = this.registry.getTool(rawName);
      // Work from a stable value: the authorization dialog may await user input.
      const parsedArgs = JSON.parse(JSON.stringify(this.parseArguments(toolCall?.function?.arguments)));

      if (!tool) {
        const error = `Herramienta '${rawName}' no encontrada en el registro.`;
        return {
          success: false,
          toolName: rawName,
          error,
          executionTimeMs: 0,
          result: null,
          outcome: ToolOutcome.fromError(error, {
            toolId: null,
            toolName: rawName,
            contractVersion: TOOL_CONTRACT_VERSION,
            executionTimeMs: 0
          })
        };
      }

      const displayMode = tool.displayMode || tool.view?.displayMode || 'collapsed';
      if (!parsedArgs) {
        const error = 'Invalid tool arguments: expected a JSON object. The tool was not executed.';
        return {
          success: false,
          tool,
          toolName: tool.name,
          displayMode,
          args: null,
          error,
          executionTimeMs: 0,
          result: null,
          outcome: ToolOutcome.fromError(error, {
            toolId: tool.id,
            toolName: tool.name,
            contractVersion: tool.contractVersion || TOOL_CONTRACT_VERSION,
            executionTimeMs: 0
          })
        };
      }

      const startTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const measureExecution = () => {
        const endTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
        const elapsed = parseFloat((endTime - startTime).toFixed(2));
        const meta = { toolId: tool.id, toolName: tool.name, contractVersion: tool.contractVersion || TOOL_CONTRACT_VERSION, executionTimeMs: elapsed, displayMode };
        return { elapsed, meta };
      };

      try {
        const authorization = await this._authorizeToolCall(tool, parsedArgs, toolCall, context);
        if (!authorization.allowed) {
          return {
            success: false,
            tool,
            toolName: tool.name,
            displayMode,
            args: parsedArgs,
            error: authorization.error,
            executionTimeMs: 0,
            result: null,
            outcome: ToolOutcome.fromError(authorization.error, {
              toolId: tool.id,
              toolName: tool.name,
              contractVersion: tool.contractVersion || TOOL_CONTRACT_VERSION,
              executionTimeMs: 0
            })
          };
        }
        if (context.signal && context.signal.aborted) {
          throw new Error('Ejecución de herramienta cancelada por el usuario.');
        }

        const ToolRuntime = getToolRuntime();
        const executionContext = ToolRuntime?.createToolExecutionContext
          ? ToolRuntime.createToolExecutionContext({ displayMode, ...context, toolAuthorization: true })
          : { displayMode, ...context, toolAuthorization: true };
        const execResult = await tool.execute(parsedArgs, executionContext);
        const { elapsed, meta } = measureExecution();
        return {
          success: execResult?.success !== false,
          tool: tool,
          toolName: tool.name,
          displayMode,
          args: parsedArgs,
          result: execResult,
          outcome: ToolOutcome.fromExecution(execResult, meta),
          executionTimeMs: elapsed,
          error: execResult?.error
        };
      } catch (err) {
        const { elapsed, meta } = measureExecution();
        return {
          success: false,
          tool: tool,
          toolName: tool.name,
          displayMode,
          args: parsedArgs,
          error: err.message || String(err),
          executionTimeMs: elapsed,
          result: null,
          outcome: ToolOutcome.fromError(err, meta)
        };
      }
    }

    /**
     * Despacha una llamada a herramienta gestionando el ciclo completo:
     * - Parseo seguro de argumentos
     * - Creación inicial e inserción de la tarjeta DOM en vivo
     * - Logging previo a consola de depuración
     * - Ejecución asíncrona a través de executeToolCall
     * - Actualización reactiva de la tarjeta DOM con los resultados
     * - Formateo de la respuesta textual para el historial del chat y markdown
     */
    async dispatchToolCall(toolCall, options = {}) {
      const {
        container,
        onLog,
        attachListeners,
        scrollToBottom,
        language = 'es'
      } = options;

      const rawFuncName = toolCall?.function?.name || '';
      const parsedArgs = this.parseArguments(toolCall?.function?.arguments) || {};
      const ToolCards = getToolCards();
      // Identifica esta invocación ante la herramienta y su tarjeta mientras se ejecuta.
      const invocationId = createInvocationId();

      // 1. Crear e insertar la tarjeta DOM en vivo con estado de carga
      let cardEl = null;
      if (ToolCards && ToolCards.createLiveToolCard && container && typeof document !== 'undefined') {
        cardEl = ToolCards.createLiveToolCard(rawFuncName, parsedArgs, { invocationId });
        if (cardEl) {
          cardEl.dataset.invocationId = invocationId;
          if (ToolCards.appendToolCard) ToolCards.appendToolCard(container, cardEl);
          else container.appendChild(cardEl);
          if (typeof attachListeners === 'function') attachListeners(cardEl);
          if (typeof scrollToBottom === 'function') scrollToBottom();
        }
      }

      // 2. Logging previo
      if (typeof onLog === 'function') {
        onLog('tool', `${rawFuncName}:\n${JSON.stringify(parsedArgs, null, 2)}`);
        onLog('raw', `>>> TOOL CALL ${rawFuncName}:\n${JSON.stringify(parsedArgs, null, 2)}`);
      }

      // 3. Ejecutar la herramienta a través de executeToolCall
      const execRes = await this.executeToolCall(toolCall, {
        lang: language,
        ...options,
        invocationId,
        requestToolAuthorization: ToolCards?.promptToolAuthorization
          ? async (pendingToolCall, authorization) => {
            if (typeof scrollToBottom === 'function') scrollToBottom();
            return ToolCards.promptToolAuthorization(cardEl, pendingToolCall, authorization);
          }
          : undefined
      });

      // 4. Actualizar la tarjeta DOM con el resultado
      if (ToolCards && ToolCards.updateLiveToolCard && cardEl) {
        ToolCards.updateLiveToolCard(cardEl, rawFuncName, parsedArgs, execRes.result || execRes, execRes.executionTimeMs, {
          displayMode: execRes.displayMode || execRes.tool?.displayMode,
          outcome: execRes.outcome
        });
        ToolCards.completeToolCard?.(cardEl, execRes.result || execRes);
        if (typeof attachListeners === 'function') attachListeners(cardEl);
        if (typeof scrollToBottom === 'function') scrollToBottom();
      }

      // 5. Formatear la salida para el mensaje `tool` sin conocer tipos concretos.
      const resolvedTool = execRes.tool;
      let resultText = '';
      try {
        const serialized = resolvedTool
          ? resolvedTool.serializeResultForModel(parsedArgs, execRes.result, execRes.outcome)
          : (execRes.error || 'Tool execution error.');
        resultText = typeof serialized === 'string' ? serialized : JSON.stringify(serialized);
      } catch (err) {
        resultText = `Error serializing result of ${rawFuncName}: ${err.message || String(err)}`;
      }

      // 6. Logging posterior
      if (typeof onLog === 'function') {
        onLog('tool', `${rawFuncName} output (${execRes.executionTimeMs || 0}ms):\n${String(resultText).substring(0, 300)}`);
        onLog('raw', `<<< TOOL RESULT ${rawFuncName} (${execRes.executionTimeMs || 0}ms):\n${resultText}`);
      }

      // 7. Formatear bloque Markdown para portapapeles/exportación desde la tool.
      let toolMd = '';
      try {
        toolMd = resolvedTool
          ? resolvedTool.formatDispatchMarkdown(parsedArgs, execRes.result, execRes.outcome)
          : `> ⚙️ **${rawFuncName}**\n> \`\`\`\n> ${String(resultText).slice(0, 300)}\n> \`\`\``;
      } catch (err) {
        toolMd = `> ❌ **${rawFuncName}**: ${err.message || String(err)}`;
      }

      return {
        success: execRes.success !== false,
        result: execRes.result,
        resultText,
        markdownBlock: toolMd,
        cardElement: cardEl,
        executionTimeMs: execRes.executionTimeMs,
        error: execRes.error,
        toolName: rawFuncName,
        args: parsedArgs
      };
    }
  }

  // Un bucle es el mismo lote de herramientas repetido 5 veces seguidas (aaaaa) o dos
  // lotes alternados 5 veces (ababababab). Ciclos como test -> editar -> test no cuentan
  // porque cada edición cambia los argumentos, y un texto nuevo para el usuario entre
  // pasos reinicia el control.
  const LOOP_REPETITIONS = 5;
  const LOOP_MAX_PERIOD = 2;
  const LOOP_HISTORY_SIZE = LOOP_REPETITIONS * LOOP_MAX_PERIOD;

  /**
   * Entorno de ejecución agéntico avanzado (AgentRuntime).
   * Orquesta el ciclo de vida de razonamiento y acción (ReAct), múltiples pasos,
   * cancelación,
   * detección de bucles infinitos y presupuestos de tokens. No hay límite de pasos:
   * el ciclo termina con la respuesta final, un bucle, ask_user, cancelación o error.
   */
  class AgentRuntime {
    constructor(options = {}) {
      this.registry = options.registry || new ToolRegistry();
      this.executor = options.executor || new ToolExecutor(this.registry);
    }

    /**
     * Genera una huella única para la llamada a herramienta para detectar repeticiones cíclicas.
     */
    getToolCallFingerprint(toolCall) {
      if (!toolCall || !toolCall.function) return '';
      const name = toolCall.function.name || '';
      const rawArgs = toolCall.function.arguments;
      let args = rawArgs;
      if (typeof rawArgs === 'string') {
        const trimmed = rawArgs.trim();
        try { args = JSON.parse(trimmed); } catch (_) { args = trimmed; }
      }
      const canonicalize = value => {
        if (Array.isArray(value)) return value.map(canonicalize);
        if (value && typeof value === 'object') {
          return Object.keys(value).sort().reduce((result, key) => {
            result[key] = canonicalize(value[key]);
            return result;
          }, {});
        }
        return value;
      };
      args = typeof args === 'string' ? args : JSON.stringify(canonicalize(args));
      return `${name}:${args}`;
    }

    getToolBatchFingerprint(toolCalls) {
      return JSON.stringify((toolCalls || []).map(toolCall => this.getToolCallFingerprint(toolCall)));
    }

    /**
     * Devuelve el periodo del ciclo con que termina el historial de lotes
     * (1 = aaaaa, 2 = ababababab) o 0 si no termina en bucle.
     */
    detectLoop(fingerprints) {
      for (let period = 1; period <= LOOP_MAX_PERIOD; period++) {
        const span = period * LOOP_REPETITIONS;
        if (fingerprints.length < span) continue;
        const tail = fingerprints.slice(-span);
        if (tail.every((fp, i) => fp === tail[i % period])) return period;
      }
      return 0;
    }

    /**
     * Ejecuta el ciclo completo de ejecución agéntica multi-turno.
     */
    async execute(params = {}) {
      const {
        apiUrl,
        apiType,
        apiKey,
        model,
        messages = [],
        temperature = 0.7,
        reasoningEffort = 'medium',
        reasoningTransport = 'auto',
        enableTools = true,
        toolFilterOptions = {},
        signal = null,
        api: customApi = null,
        prepareMessages = null,
        resolveToolDefinitions = null,
        dispatchToolCall = null,
        summarizeHistory = null,
        contextOptions = {},
        createMessageId = null,
        appendFinalMessage = false,
        onBeforeRequest = null,
        callbacks = {}
      } = params;

      const API = customApi || getAPI();
      if (!API || !API.streamChatCompletion) {
        throw new Error('Módulo ChatAPI no disponible para ejecución agéntica.');
      }

      const ContextManager = getContextManager();
      const safeContextOptions = contextOptions && typeof contextOptions === 'object'
        ? contextOptions
        : {};

      const startTime = typeof performance !== 'undefined' ? performance.now() : Date.now();

      // Sin signal externo se usa uno que nunca se aborta.
      const abortSignal = signal || new AbortController().signal;

      let stepIndex = 0;
      let workingMessages = [...messages];
      let finalAccumulatedText = '';
      let finalReasoningText = '';
      let lastStats = null;
      const toolExecutions = [];
      let toolBatchHistory = [];
      let lastResetText = null;
      let compressionUnavailable = false;
      let status = 'completed';
      let executionError = null;
      let yieldedToUser = false;

      while (true) {
        if (abortSignal.aborted) {
          status = 'cancelled';
          executionError = createCancelledError();
          break;
        }

        if (callbacks.onStepStart) {
          callbacks.onStepStart(stepIndex);
        }

        // Automatic context compaction replaces the previous checkpoint and later
        // dialogue atomically.
        if (!compressionUnavailable && ContextManager && typeof ContextManager.shouldCompress === 'function' &&
          typeof ContextManager.compressHistory === 'function' &&
          typeof summarizeHistory === 'function' &&
          ContextManager.shouldCompress(workingMessages, { ...safeContextOptions, model, providerType: apiType })) {
          if (callbacks.onCompactionStart) callbacks.onCompactionStart(stepIndex);
          const compacted = await ContextManager.compressHistory({
            messages: workingMessages,
            summarizeFn: summarizeHistory,
            options: { ...safeContextOptions, model, providerType: apiType }
          });
          if (callbacks.onCompactionEnd) callbacks.onCompactionEnd(compacted, stepIndex);
          if (compacted.compressed) {
            workingMessages = compacted.messages;
          } else {
            // A failed or unavailable summarizer cannot make progress during
            // this execution; retrying it before every agent step only adds calls.
            compressionUnavailable = true;
          }
        }

        // 1. Optimización dinámica de presupuesto de contexto (Context Budget)
        let stepMessages = workingMessages;
        let contextDiagnostics = null;
        if (typeof prepareMessages === 'function') {
          const prepared = await prepareMessages(workingMessages);
          if (Array.isArray(prepared)) {
            stepMessages = prepared;
          } else if (prepared && Array.isArray(prepared.messages)) {
            stepMessages = prepared.messages;
            contextDiagnostics = prepared.diagnostics || null;
          }
        }
        if (callbacks.onContextPrepared) callbacks.onContextPrepared(contextDiagnostics, stepIndex);

        // 2. Definición de herramientas activas
        const activeToolDefs = enableTools
          ? (typeof resolveToolDefinitions === 'function'
            ? await resolveToolDefinitions({ stepIndex, workingMessages })
            : this.registry.getActiveDefinitions(toolFilterOptions))
          : [];

        let currentStepText = '';
        let currentStepReasoning = '';
        let stepReasoningReplay = null;
        let stepToolCalls = null;
        let stepStats = null;
        let streamError = null;

        try {
          const streamResult = await API.streamChatCompletion({
            apiUrl,
            apiType,
            apiKey,
            model,
            messages: stepMessages,
            temperature,
            reasoningEffort,
            reasoningTransport,
            tools: activeToolDefs,
            enableTools: activeToolDefs.length > 0,
            signal: abortSignal,
            onBeforeRequest,
            onGenerationStatus: status => callbacks.onGenerationStatus?.(status),

            onReasoningChunk: (chunk, accumulated) => {
              currentStepReasoning = accumulated;
              if (callbacks.onReasoningChunk) callbacks.onReasoningChunk(chunk, accumulated, stepIndex);
            },
            onLog: (logData) => {
              if (callbacks.onLog) callbacks.onLog(logData);
            },
            onChunk: (fullTextSoFar, delta, stats) => {
              currentStepText = fullTextSoFar;
              if (callbacks.onChunk) callbacks.onChunk(fullTextSoFar, delta, stats, stepIndex);
            },
            onDone: (finalText, stats, toolCalls, reasoning) => {
              currentStepText = finalText || currentStepText;
              currentStepReasoning = reasoning || currentStepReasoning;
              stepStats = stats;
              stepToolCalls = toolCalls;
            },
            onError: (error) => {
              streamError = error;
              if (callbacks.onError) callbacks.onError(error);
            }
          });

          if (streamError) {
            if (abortSignal.aborted) {
              status = 'cancelled';
              executionError = createCancelledError();
            } else {
              status = 'error';
              executionError = streamError;
              if (callbacks.onError) callbacks.onError(streamError);
            }
            break;
          }

          if (streamResult) {
            currentStepText = streamResult.accumulatedText || currentStepText;
            currentStepReasoning = streamResult.accumulatedReasoning || currentStepReasoning;
            stepReasoningReplay = streamResult.reasoningReplay || null;
            stepToolCalls = streamResult.toolCalls || stepToolCalls;
            stepStats = streamResult.stats || stepStats;
          }

          lastStats = stepStats || lastStats;
          if (currentStepReasoning) {
            finalReasoningText += (finalReasoningText ? '\n' : '') + currentStepReasoning;
          }

          // Caso A: Sin llamadas a herramientas -> Turno final
          if (!stepToolCalls || stepToolCalls.length === 0) {
            // If the model returned empty text after a tool turn, log it and move on
            if ((!currentStepText || currentStepText.trim() === '') && stepIndex > 0 && workingMessages.length > 0 && workingMessages[workingMessages.length - 1].role === 'tool') {
              if (callbacks.onLog) callbacks.onLog({ type: 'warn', text: 'Model ended the tool loop without producing a response.' });
            }

            finalAccumulatedText = currentStepText;
            if (appendFinalMessage) {
              workingMessages.push({
                id: typeof createMessageId === 'function'
                  ? createMessageId('final', { stepIndex })
                  : `msg_turn_${stepIndex}_final`,
                role: 'assistant',
                content: currentStepText
              });
            }
            if (callbacks.onStepDone) {
              callbacks.onStepDone(stepIndex, {
                type: 'final_response',
                text: currentStepText,
                stats: lastStats
              });
            }
            status = 'completed';
            break;
          }

          // Caso B: Llamadas a herramientas detectadas (soporte para llamadas individuales y en paralelo)
          const trimmedStepText = (currentStepText || '').trim();
          if (
            trimmedStepText.startsWith('<|') ||
            trimmedStepText.startsWith('<tool_call') ||
            trimmedStepText.startsWith('<function_call') ||
            trimmedStepText.startsWith('call:') ||
            trimmedStepText.startsWith('{"name"') ||
            trimmedStepText.startsWith('```json\n{"name"') ||
            trimmedStepText.startsWith('download_pdf(') ||
            trimmedStepText.startsWith('downloadpdf(') ||
            trimmedStepText.startsWith('fetch_web_page(') ||
            trimmedStepText.startsWith('fetchwebpage(') ||
            trimmedStepText.startsWith('search_web(') ||
            trimmedStepText.startsWith('searchweb(') ||
            trimmedStepText.startsWith('execute_javascript(') ||
            trimmedStepText.startsWith('executejs(')
          ) {
            currentStepText = '';
          }

          // Un texto nuevo para el usuario reinicia el control de bucles. La misma frase
          // repetida en cada paso ("Voy a buscar...") no lo reinicia.
          const visibleText = (currentStepText || '').replace(/\s+/g, ' ').trim().toLowerCase();
          if (visibleText && visibleText !== lastResetText) {
            toolBatchHistory = [];
            lastResetText = visibleText;
          }
          toolBatchHistory.push(this.getToolBatchFingerprint(stepToolCalls));
          if (toolBatchHistory.length > LOOP_HISTORY_SIZE) toolBatchHistory.shift();
          const loopPeriod = this.detectLoop(toolBatchHistory);

          if (loopPeriod > 0) {
            status = 'loop_detected';
            if (callbacks.onLoopDetected) {
              callbacks.onLoopDetected(stepToolCalls[0], loopPeriod, stepIndex);
            }
            const loopWarning = '\n\n> ⚠️ *[Infinite Loop Protection]*: Tools were invoked in a repeating pattern with the same arguments without progress. Halting agent turn loop.';
            currentStepText = (currentStepText || '') + loopWarning;
            finalAccumulatedText = currentStepText;
            const finalMsg = {
              id: typeof createMessageId === 'function'
                ? createMessageId('final', { stepIndex })
                : `msg_turn_${stepIndex}_final`,
              role: 'assistant',
              content: currentStepText
            };
            if (appendFinalMessage) workingMessages.push(finalMsg);
            if (callbacks.onStepDone) {
              callbacks.onStepDone(stepIndex, {
                type: 'loop_detected',
                text: currentStepText,
                assistantMsg: finalMsg
              });
            }
            break;
          }

          const executedToolMessages = [];
          const stepExecResults = [];

          for (let i = 0; i < stepToolCalls.length; i++) {
            if (abortSignal.aborted) break;
            const call = stepToolCalls[i];
            const toolFnName = call.function?.name || '';

            if (callbacks.onToolStart) {
              const toolInstance = this.registry.getTool(toolFnName);
              callbacks.onToolStart(call, toolInstance, stepIndex);
            }

            const toolContext = {
              signal: abortSignal,
              ...params
            };
            const execResult = typeof dispatchToolCall === 'function'
              ? await dispatchToolCall(call, toolContext)
              : await this.executor.executeToolCall(call, toolContext);
            stepExecResults.push(execResult);

            let toolResponseContent = '';
            let toolImages = null;
            if (execResult.success && execResult.result !== undefined) {
              const serialized = execResult.resultText !== undefined
                ? execResult.resultText
                : execResult.tool.serializeResultForModel(execResult.args, execResult.result, execResult.outcome);
              const serializedText = typeof serialized === 'string' ? serialized : JSON.stringify(serialized);

              // Las imágenes RAG y capturas de browser_action se preservan como metadatos del mensaje de herramienta.
              // ChatEngine las transforma en evidencia multimodal en la siguiente petición.
              const ragDataUrl = execResult.result?.dataUrl;
              const ragMimeType = execResult.result?.mimeType;
              let imgBase64 = execResult.result?.image_base64 || execResult.result?.imageData;
              let imgMime = execResult.result?.mime_type || execResult.result?.mimeType || 'image/png';

              if (!imgBase64 && typeof execResult.result === 'string') {
                try {
                  const parsed = JSON.parse(execResult.result);
                  if (parsed && parsed.image_base64) {
                    imgBase64 = parsed.image_base64;
                    imgMime = parsed.mime_type || imgMime;
                  }
                } catch (e) { /* el resultado no es JSON: se conserva como texto */ }
              }

              if (ragDataUrl && ragMimeType) {
                toolResponseContent = serializedText;
                toolImages = [{
                  dataUrl: ragDataUrl,
                  imageRef: execResult.result.imageRef,
                  documentTitle: execResult.result.documentTitle,
                  page: execResult.result.page
                }];
              } else if (imgBase64) {
                const dataUrl = imgBase64.startsWith('data:') ? imgBase64 : `data:${imgMime};base64,${imgBase64}`;
                let textForModel = serializedText;
                try {
                  let parsedObj = typeof execResult.result === 'object' && execResult.result !== null
                    ? { ...execResult.result }
                    : JSON.parse(serializedText);
                  if (parsedObj && parsedObj.image_base64) {
                    parsedObj.image_base64 = `[Base64 image (${imgMime}), length: ${imgBase64.length} chars - injected as visual evidence]`;
                    textForModel = JSON.stringify(parsedObj, null, 2);
                  }
                } catch (e) { /* el resultado no es JSON: se conserva como texto */ }
                toolResponseContent = textForModel;
                toolImages = [{
                  dataUrl,
                  mimeType: imgMime,
                  action: execResult.result?.action || 'screenshot',
                  url: execResult.result?.url
                }];
              } else {
                toolResponseContent = serializedText;
              }

            } else {
              toolResponseContent = JSON.stringify({
                success: false,
                error: execResult.error || 'Unknown error executing tool.'
              });
              if (callbacks.onToolError) {
                callbacks.onToolError(call, execResult.error, stepIndex);
              }
            }

            if (callbacks.onToolComplete) {
              callbacks.onToolComplete(call, execResult, toolResponseContent, stepIndex);
            }

            toolExecutions.push({
              step: stepIndex,
              toolName: toolFnName || 'tool',
              args: execResult.args || call.function?.arguments,
              result: execResult.result,
              success: execResult.success,
              executionTimeMs: execResult.executionTimeMs || 0,
              error: execResult.error || null
            });

            const toolMessage = {
              id: typeof createMessageId === 'function'
                ? createMessageId('tool', { stepIndex, toolCall: call, toolIndex: i })
                : `msg_turn_${stepIndex}_tool_${call.id || i}_${Date.now()}`,
              role: 'tool',
              tool_call_id: call.id || `call_${Date.now()}_${i}`,
              name: toolFnName || 'tool',
              content: toolResponseContent
            };
            if (toolImages) toolMessage.images = toolImages;
            executedToolMessages.push(toolMessage);
          }

          // Actualizar historial asegurando el emparejamiento estricto assistant(tool_calls) <-> tool(results)
          const assistantMsg = {
            id: typeof createMessageId === 'function'
              ? createMessageId('assistant', { stepIndex })
              : `msg_turn_${stepIndex}_assistant`,
            role: 'assistant',
            content: currentStepText || null,
            tool_calls: stepToolCalls
          };
          // Solo vive durante el turno: buildEffectiveMessages lo reenvía y el historial devuelto lo omite.
          if (stepReasoningReplay) assistantMsg.reasoningReplay = stepReasoningReplay;

          workingMessages.push(assistantMsg);
          for (const tMsg of executedToolMessages) {
            workingMessages.push(tMsg);
          }

          if (callbacks.onStepDone) {
            callbacks.onStepDone(stepIndex, {
              type: 'tool_execution',
              toolCall: stepToolCalls[0],
              toolCalls: stepToolCalls,
              execResult: stepExecResults[0],
              execResults: stepExecResults,
              assistantMsg,
              toolMsg: executedToolMessages[0],
              toolMsgs: executedToolMessages
            });
          }

          stepIndex++;

          // Una herramienta puede ceder el turno al usuario (ask_user): el bucle termina
          // y la respuesta del usuario llega como el siguiente mensaje.
          if (stepExecResults.some(r => r?.success && r?.result?.endTurn === true)) {
            yieldedToUser = true;
            status = 'completed';
            break;
          }
        } catch (err) {
          if (abortSignal.aborted) {
            status = 'cancelled';
            executionError = createCancelledError();
          } else {
            status = 'error';
            executionError = err;
            if (callbacks.onError) callbacks.onError(err);
          }
          break;
        }
      }

      const endTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const totalElapsedMs = Math.round(endTime - startTime);

      if (callbacks.onDone) {
        callbacks.onDone(finalAccumulatedText, lastStats, stepIndex);
      }

      return {
        success: status === 'completed' || status === 'loop_detected',
        status,
        finalText: finalAccumulatedText,
        reasoningText: finalReasoningText,
        stepsCount: stepIndex,
        loopDetected: status === 'loop_detected',
        awaitingUser: yieldedToUser,
        toolExecutions,
        history: workingMessages.map(withoutReasoningReplay),
        stats: {
          totalTimeMs: totalElapsedMs,
          tokens: lastStats?.tokens || 0,
          tokensPerSec: lastStats?.tokensPerSec || 0,
          cachedTokens: lastStats?.cachedTokens || 0,
          cacheCreationTokens: lastStats?.cacheCreationTokens || 0,
          promptTokens: lastStats?.promptTokens || 0,
          completionTokens: lastStats?.completionTokens || 0,
          totalTokens: lastStats?.totalTokens || 0,
          reasoningTokens: lastStats?.reasoningTokens || 0,
          ttftSec: lastStats?.ttftSec || 0,
          totalSec: lastStats?.totalSec || ((totalElapsedMs / 1000).toFixed(2)),
          isEstimated: lastStats?.isEstimated ?? true
        },
        error: executionError
      };
    }
  }

  const globalRegistry = new ToolRegistry();
  const globalExecutor = new ToolExecutor(globalRegistry);
  const globalRuntime = new AgentRuntime({ registry: globalRegistry, executor: globalExecutor });

  return {
    TOOL_CONTRACT_VERSION,
    ToolOutcome,
    validateToolContract,
    isToolEnabled,
    Tool,
    BaseToolProvider,
    BuiltinToolProvider,
    ToolRegistry,
    ToolExecutor,
    AgentRuntime,
    registry: globalRegistry,
    executor: globalExecutor,
    runtime: globalRuntime,
    dispatchToolCall: (toolCall, options) => globalExecutor.dispatchToolCall(toolCall, options),
    executeToolCall: (toolCall, context) => globalExecutor.executeToolCall(toolCall, context)
  };
});
