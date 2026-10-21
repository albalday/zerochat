/**
 * Núcleo agéntico de ZeroChat (ChatAgentCore).
 *
 * Model -> AgentRuntime -> ToolExecutor -> ToolRegistry -> Tool
 */

(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./utils.js'));
  } else {
    root.ChatAgentCore = factory(root.ChatUtils);
  }
})(typeof self !== 'undefined' ? self : this, function (Utils) {
  'use strict';

  const { resolveDep, createId } = Utils;

  const getAPI = () => resolveDep('ChatAPI', './api.js');
  const getContextManager = () => resolveDep('ChatContextManager', './context-manager.js');
  const getToolSecurity = () => resolveDep('ChatToolSecurity', './tool-security.js');

  const BUILTIN_TOOL_MODULES = [
    ['ChatBuiltinExecuteJavascriptTool', './tools/builtin/execute-javascript.tool.js'],
    ['ChatBuiltinSearchWebTool', './tools/builtin/search-web.tool.js'],
    ['ChatBuiltinFetchWebPageTool', './tools/builtin/fetch-web-page.tool.js'],
    ['ChatBuiltinDownloadDocTool', './tools/builtin/download-doc.tool.js'],
    ['ChatBuiltinDownloadImageTool', './tools/builtin/download-image.tool.js'],
    ['ChatBuiltinRenderChartTool', './tools/builtin/render-chart.tool.js'],
    ['ChatBuiltinListDocumentsTool', './tools/builtin/list-documents.tool.js'],
    ['ChatBuiltinSearchKnowledgeBaseTool', './tools/builtin/search-knowledge-base.tool.js'],
    ['ChatBuiltinReadKnowledgeChunkTool', './tools/builtin/read-knowledge-chunk.tool.js'],
    ['ChatBuiltinReadKnowledgeImageTool', './tools/builtin/read-knowledge-image.tool.js'],
    ['ChatBuiltinAskUserTool', './tools/builtin/ask-user.tool.js'],
    ['ChatBuiltinDelegateTaskTool', './tools/builtin/delegate-task.tool.js']
  ];

  // Dependencias que las herramientas reciben en context.services.
  const TOOL_SERVICES = {
    sandbox: ['ChatSandbox', './sandbox.js'],
    webSearch: ['ChatWebSearch', './web-search.js'],
    webBrowser: ['ChatWebBrowser', './web-browser.js'],
    ragService: ['ChatRagService', './rag-service.js'],
    agent: ['ChatAgentCore', './agent-core.js'],
    engine: ['ChatEngine', './chat-engine.js'],
    profiles: ['ChatProfileRepository', './profile-repository.js'],
    profilesUI: ['ChatUIProfiles', './ui-profiles.js']
  };

  /** Servicios resueltos al usarlos. */
  function createToolServices() {
    const services = {};
    for (const [name, [globalName, modulePath]] of Object.entries(TOOL_SERVICES)) {
      Object.defineProperty(services, name, {
        enumerable: true,
        get: () => resolveDep(globalName, modulePath)
      });
    }
    return services;
  }

  const TOOL_WORKFLOW_INSTRUCTION = "*Workflow instruction:* After using tools, answer the user's question directly, clearly, and concisely. Use findings only as evidence, citing sources briefly or via inline links. Avoid lengthy or redundant summaries of consulted sources and do not show raw tool output.";

  // Texto que acompaña a una llamada emitida como texto: no es respuesta para el usuario.
  const TOOL_CALL_TEXT = /^(?:<\||<tool_call|<function_call|call:|\{"name"|```json\n\{"name")/;

  const createCancelledError = () => new Error('Agent execution cancelled by the user.');

  /** Interruptor de una herramienta en la configuración, o su valor por defecto. */
  function isToolEnabled(enabledTools = {}, name, defaultEnabled = true) {
    return enabledTools[name] !== undefined ? enabledTools[name] !== false : defaultEnabled;
  }

  /**
   * Navegador al que pertenece una herramienta: browser_action del servidor local o las de
   * Playwright MCP. Ajustes › Navegador elige uno solo; null para el resto de herramientas.
   */
  function browserOfTool(tool) {
    if (tool.name === 'browser_action') return 'browser_action';
    if (tool.metadata.mcpServerId === 'playwright') return 'playwright';
    return null;
  }

  /** Herramienta de navegación activa: Playwright MCP si el perfil lo exige; si no, la de Ajustes › Navegador. */
  const activeBrowserTool = appConfig => (appConfig.playwrightBrowser ? 'playwright' : appConfig.browser);

  function withoutReasoningReplay(message) {
    if (!message.reasoningReplay) return message;
    const { reasoningReplay, ...rest } = message;
    return rest;
  }

  const quote = text => String(text).split('\n').join('\n> ');

  /** Herramienta registrable: definición Function Calling, ejecución, serialización y vista opcional. */
  class Tool {
    constructor({ definition, aliases = [], category = 'general', metadata = {}, settings = {}, promptGuide = null, isAvailable = () => true, execute, result = {}, displayMode = 'collapsed', view = null }) {
      if (!definition?.name) throw new Error('A tool needs a definition with a name.');
      if (typeof execute !== 'function') throw new Error(`Tool ${definition.name} needs an execute function.`);
      this.name = definition.name;
      // Un servidor MCP puede publicar herramientas sin descripción: se usa el nombre.
      this.description = definition.description || this.name;
      this.parameters = definition.parameters || { type: 'object', properties: {} };
      this.aliases = aliases;
      this.category = category;
      this.metadata = metadata;
      this.settings = {
        titleKey: settings.titleKey || `agent_${this.name}_title`,
        descKey: settings.descKey || `agent_${this.name}_desc`,
        defaultEnabled: settings.defaultEnabled !== false,
        showInSettings: settings.showInSettings !== false
      };
      this.promptGuide = promptGuide;
      this.isAvailable = isAvailable;
      this.execute = execute;
      this.result = result;
      this.displayMode = displayMode;
      this.view = view;
    }

    getDefinition() {
      return { type: 'function', function: { name: this.name, description: this.description, parameters: this.parameters } };
    }

    /** Línea de la herramienta en la guía del prompt de sistema. */
    getPromptGuide() {
      return this.promptGuide || `- \`${this.name}\`: ${this.description}`;
    }

    /** Contenido del mensaje `tool` que recibe el modelo. */
    toModel(args, result) {
      if (this.result.toModel) return this.result.toModel(args, result);
      return typeof result === 'object' ? JSON.stringify(result) : String(result ?? '');
    }

    /** Bloque Markdown de la llamada para copiar y exportar la respuesta. */
    toMarkdown(args, result) {
      if (this.result.toMarkdown) return this.result.toMarkdown(args, result);
      return `> ⚙️ **${this.name}**\n> \`\`\`json\n> ${quote(JSON.stringify(result, null, 2))}\n> \`\`\``;
    }
  }

  /** Herramientas nativas: cada módulo exporta la especificación de su Tool. */
  const builtinProvider = {
    id: 'builtin',
    tools: null,
    getTools() {
      this.tools ||= BUILTIN_TOOL_MODULES.map(([globalName, modulePath]) => new Tool(resolveDep(globalName, modulePath)));
      return this.tools;
    }
  };

  const normalizeAlias = name => String(name).trim().toLowerCase().replace(/[^a-z0-9_]/g, '');

  /** Registro de herramientas por proveedor. Las MCP se resuelven solo por su nombre exacto. */
  class ToolRegistry {
    constructor() {
      this.tools = new Map();
      this.aliasMap = new Map();
      this.providers = new Map();
      this.registerProvider(builtinProvider);
    }

    registerProvider(provider) {
      this.providers.set(provider.id, provider);
      provider.getTools().forEach(tool => this.registerTool(tool));
    }

    registerTool(tool) {
      if (!(tool instanceof Tool)) throw new Error('Only Tool instances can be registered.');
      this.tools.set(tool.name, tool);
      if (tool.category === 'mcp') return tool;
      for (const alias of [tool.name, ...tool.aliases].map(normalizeAlias)) {
        this.aliasMap.set(alias, tool.name);
        this.aliasMap.set(alias.replace(/_/g, ''), tool.name);
      }
      return tool;
    }

    /** Herramienta por su nombre o, si no es MCP, por un alias con o sin guiones bajos. */
    getTool(rawName) {
      const exactName = String(rawName || '').trim();
      if (this.tools.has(exactName)) return this.tools.get(exactName);
      const alias = normalizeAlias(exactName);
      const name = this.aliasMap.get(alias) || this.aliasMap.get(alias.replace(/_/g, ''));
      return name ? this.tools.get(name) : null;
    }

    unregisterProvider(providerId) {
      const provider = this.providers.get(providerId);
      if (!provider) return;
      this.providers.delete(providerId);
      provider.getTools().forEach(tool => this.unregisterTool(tool.name));
    }

    unregisterTool(name) {
      const tool = this.tools.get(name);
      if (!tool) return;
      this.tools.delete(name);
      for (const [alias, target] of this.aliasMap) {
        if (target === name) this.aliasMap.delete(alias);
      }
    }

    /**
     * Una herramienta está activa si está disponible en su contexto (por ejemplo, RAG exige una
     * rama activa) y, cuando se configura en la interfaz, si su interruptor está encendido; las de
     * navegador, si son de la herramienta de navegación elegida en Ajustes › Navegador.
     */
    isToolActive(tool, appConfig) {
      if (!tool.isAvailable(appConfig)) return false;
      const browser = browserOfTool(tool);
      if (browser) return browser === activeBrowserTool(appConfig);
      if (!tool.settings.showInSettings) return true;
      return isToolEnabled(appConfig.enabledTools, tool.name, tool.settings.defaultEnabled);
    }

    getActiveTools(appConfig) {
      return this.listTools().filter(tool => this.isToolActive(tool, appConfig));
    }

    /** Definiciones Function Calling de las herramientas activas según la configuración. */
    getActiveDefinitions(appConfig) {
      return this.getActiveTools(appConfig).map(tool => tool.getDefinition());
    }

    /** Guía textual de las herramientas activas para el prompt de sistema. */
    getActivePromptGuide(appConfig) {
      const guides = this.getActiveTools(appConfig).map(tool => tool.getPromptGuide());
      if (guides.length === 0) return '';
      return `\n\n[AVAILABLE TOOLS AND FUNCTIONS]:\nYou can use the following tools when needed to answer accurately:\n${guides.join('\n')}\n${TOOL_WORKFLOW_INSTRUCTION}`;
    }

    listTools() {
      return Array.from(this.tools.values());
    }
  }

  /** Ejecuta llamadas a herramientas tras pasar la política de ChatToolSecurity. */
  class ToolExecutor {
    constructor(registry) {
      this.registry = registry;
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
      const security = getToolSecurity().manager;
      const authEval = security.evaluateAuthorization(tool, args, context);

      if (authEval.status === 'deny') {
        return { allowed: false, error: 'Tool blocked by security policy.' };
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
      if (security.evaluateAuthorization(tool, args, context).status === 'deny') {
        return { allowed: false, error: 'Tool blocked by security policy.' };
      }

      const allowedDecisions = new Set([
        'allow_once',
        'allow_session',
        'allow_always',
        'allow_server_always'
      ]);

      if (!allowedDecisions.has(decisionType)) {
        return { allowed: false, error: 'Execution denied by the user.' };
      }

      if (typeof decision === 'object' && decision !== null && decision.directoryRule) {
        try {
          security.addDirectoryRule(decision.directoryRule);
        } catch (error) {
          return { allowed: false, error: error?.message || 'Execution denied by the user.' };
        }
      }

      security.recordDecision(decision, authEval, tool.name);

      return { allowed: true };
    }

    /**
     * Ejecuta una llamada a herramienta y mide su duración. Los errores se devuelven en el
     * resultado, nunca se lanzan.
     */
    async executeToolCall(toolCall, context = {}) {
      const rawName = toolCall?.function?.name || '';
      const tool = this.registry.getTool(rawName);
      const failure = (error, extra = {}) => ({ success: false, toolName: tool?.name || rawName, error, result: null, executionTimeMs: 0, ...extra });
      if (!tool) return failure(`Tool '${rawName}' is not registered.`);

      // Valor estable: el diálogo de autorización puede esperar al usuario.
      const parsed = this.parseArguments(toolCall.function.arguments);
      const args = parsed && Utils.clone(parsed);
      const base = { tool, displayMode: tool.displayMode, args };
      if (!args) return failure('Invalid tool arguments: expected a JSON object. The tool was not executed.', base);

      const startTime = performance.now();
      const elapsed = () => parseFloat((performance.now() - startTime).toFixed(2));
      try {
        const authorization = await this._authorizeToolCall(tool, args, toolCall, context);
        if (!authorization.allowed) return failure(authorization.error, base);
        if (context.signal?.aborted) throw new Error('Tool execution cancelled by the user.');

        const result = await tool.execute(args, {
          ...context,
          language: context.language || 'es',
          services: createToolServices(),
          toolAuthorization: true
        });
        return { ...base, success: result?.success !== false, toolName: tool.name, result, error: result?.error, executionTimeMs: elapsed() };
      } catch (err) {
        return failure(err.message || String(err), { ...base, executionTimeMs: elapsed() });
      }
    }

    /**
     * Ejecuta una llamada con su tarjeta en vivo: la abre en la vista `cards` del turno, pide en
     * ella la autorización, la completa con el resultado y prepara el texto para el modelo y el
     * Markdown. La herramienta recibe su tarjeta en `context.toolCard`.
     */
    async dispatchToolCall(toolCall, options = {}) {
      const { cards, onLog } = options;
      const rawFuncName = toolCall?.function?.name || '';
      const parsedArgs = this.parseArguments(toolCall?.function?.arguments) || {};
      // Identifica esta invocación ante la herramienta y su tarjeta mientras se ejecuta.
      const invocationId = createId();
      const toolCard = cards ? cards.open(rawFuncName, parsedArgs, invocationId) : null;

      onLog?.('tool', `${rawFuncName}:\n${JSON.stringify(parsedArgs, null, 2)}`);
      onLog?.('raw', `>>> TOOL CALL ${rawFuncName}:\n${JSON.stringify(parsedArgs, null, 2)}`);

      const execRes = await this.executeToolCall(toolCall, {
        ...options,
        invocationId,
        toolCard,
        requestToolAuthorization: toolCard
          ? (pendingToolCall, authorization) => toolCard.requestAuthorization(pendingToolCall, authorization)
          : undefined
      });
      const shownResult = execRes.result || { success: false, error: execRes.error };
      toolCard?.complete(shownResult, execRes.executionTimeMs, execRes.displayMode);

      const tool = execRes.tool;
      let resultText;
      try {
        resultText = tool ? tool.toModel(parsedArgs, execRes.result) : execRes.error;
        if (typeof resultText !== 'string') resultText = JSON.stringify(resultText);
      } catch (err) {
        resultText = `Error serializing result of ${rawFuncName}: ${err.message || String(err)}`;
      }

      onLog?.('tool', `${rawFuncName} output (${execRes.executionTimeMs}ms):\n${resultText.substring(0, 300)}`);
      onLog?.('raw', `<<< TOOL RESULT ${rawFuncName} (${execRes.executionTimeMs}ms):\n${resultText}`);

      let markdownBlock;
      try {
        markdownBlock = tool
          ? tool.toMarkdown(parsedArgs, shownResult)
          : `> ⚙️ **${rawFuncName}**\n> \`\`\`\n> ${quote(resultText.slice(0, 300))}\n> \`\`\``;
      } catch (err) {
        markdownBlock = `> ❌ **${rawFuncName}**: ${err.message || String(err)}`;
      }

      return { ...execRes, args: parsedArgs, resultText, markdownBlock };
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
   * Contenido del mensaje `tool` de una ejecución. Las imágenes (de RAG o capturas del servidor
   * local, cuyo texto ya describe el base64) viajan como metadatos del mensaje y ChatEngine las
   * envía como evidencia visual en la siguiente petición.
   */
  function toToolMessageContent(execResult) {
    const { success, result, resultText, tool, args } = execResult;
    if (!success || result === undefined) {
      return { content: JSON.stringify({ success: false, error: execResult.error || 'Unknown error executing tool.' }), images: null };
    }
    const content = resultText ?? tool.toModel(args, result);
    if (result?.dataUrl && result.mimeType) {
      return { content, images: [{ dataUrl: result.dataUrl, imageRef: result.imageRef, documentTitle: result.documentTitle, page: result.page, url: result.url, mimeType: result.mimeType, byteSize: result.byteSize }] };
    }
    if (!result?.image_base64) return { content, images: null };
    const mimeType = result.mime_type || 'image/png';
    const dataUrl = result.image_base64.startsWith('data:') ? result.image_base64 : `data:${mimeType};base64,${result.image_base64}`;
    return { content, images: [{ dataUrl, mimeType, action: result.action || 'screenshot', url: result.url }] };
  }

  /**
   * Bucle agéntico (ReAct): pide al modelo, ejecuta sus herramientas y repite. No hay límite de
   * pasos: termina con la respuesta final, un bucle, una herramienta que cede el turno
   * (ask_user), la cancelación o un error.
   */
  class AgentRuntime {
    constructor({ registry, executor }) {
      this.registry = registry;
      this.executor = executor;
    }

    /** Huella de una llamada (nombre y argumentos con las claves ordenadas) para detectar bucles. */
    getToolCallFingerprint(toolCall) {
      const rawArgs = toolCall.function?.arguments;
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
      return `${toolCall.function?.name || ''}:${args}`;
    }

    getToolBatchFingerprint(toolCalls) {
      return JSON.stringify(toolCalls.map(toolCall => this.getToolCallFingerprint(toolCall)));
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
     * Control de bucles de un turno: devuelve una función que registra cada lote de herramientas y
     * devuelve el periodo del bucle en que ha entrado (0 si no hay). Un texto nuevo para el usuario
     * reinicia el historial; la misma frase repetida en cada paso ("Voy a buscar...") no lo reinicia.
     */
    createLoopGuard() {
      let history = [];
      let lastResetText = null;
      return (text, toolCalls) => {
        const visibleText = (text || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (visibleText && visibleText !== lastResetText) {
          history = [];
          lastResetText = visibleText;
        }
        history.push(this.getToolBatchFingerprint(toolCalls));
        if (history.length > LOOP_HISTORY_SIZE) history.shift();
        return this.detectLoop(history);
      };
    }

    /**
     * Ejecuta en orden las llamadas de un paso hasta que se cancele el turno. Devuelve los
     * resultados, los mensajes tool para el historial y el registro de ejecuciones.
     */
    async executeToolBatch(toolCalls, { stepIndex, params, signal, dispatchToolCall, createMessageId, callbacks }) {
      const results = [];
      const toolMessages = [];
      const executions = [];

      for (const [toolIndex, call] of toolCalls.entries()) {
        if (signal.aborted) break;
        const toolFnName = call.function?.name || 'tool';
        callbacks.onToolStart?.(call, stepIndex);

        const toolContext = { signal, ...params };
        const execResult = dispatchToolCall
          ? await dispatchToolCall(call, toolContext)
          : await this.executor.executeToolCall(call, toolContext);
        results.push(execResult);

        const { content, images } = toToolMessageContent(execResult);
        callbacks.onToolComplete?.(call, execResult, content, stepIndex);

        executions.push({
          step: stepIndex,
          toolName: toolFnName,
          args: execResult.args || call.function?.arguments,
          result: execResult.result,
          success: execResult.success,
          executionTimeMs: execResult.executionTimeMs || 0,
          error: execResult.error || null
        });

        const toolMessage = {
          id: createMessageId('tool', { stepIndex, toolCall: call, toolIndex }),
          role: 'tool',
          tool_call_id: call.id || createId('call'),
          name: toolFnName,
          content
        };
        if (images) toolMessage.images = images;
        toolMessages.push(toolMessage);
      }

      return { results, toolMessages, executions };
    }

    /** Texto de un paso con herramientas que solo repite la llamada emitida como texto. */
    isToolCallText(text) {
      const trimmed = text.trim();
      return TOOL_CALL_TEXT.test(trimmed) || Boolean(this.registry.getTool(trimmed.match(/^([a-z_]+)\(/)?.[1]));
    }

    async execute(params = {}) {
      const {
        apiUrl,
        apiType,
        apiKey,
        model,
        messages = [],
        temperature = 0.7,
        reasoningEffort = 'medium',
        signal = null,
        prepareMessages = null,
        resolveToolDefinitions = null,
        dispatchToolCall = null,
        summarizeHistory = null,
        contextOptions = {},
        createMessageId = kind => createId(`msg_${kind}`),
        appendFinalMessage = false,
        onBeforeRequest = null,
        callbacks = {}
      } = params;

      const API = getAPI();
      const ContextManager = getContextManager();
      const startTime = performance.now();

      // Sin signal externo se usa uno que nunca se aborta.
      const abortSignal = signal || new AbortController().signal;

      let stepIndex = 0;
      let workingMessages = [...messages];
      let finalAccumulatedText = '';
      let finalReasoningText = '';
      let lastStats = null;
      const toolExecutions = [];
      const trackToolBatch = this.createLoopGuard();
      let compressionUnavailable = false;
      let status = 'completed';
      let executionError = null;
      let yieldedToUser = false;
      // Algún paso del turno terminó en el límite de tokens de salida.
      let truncated = false;
      // Un servidor que rechaza el parámetro de razonamiento lo rechazaría en cada paso: tras el
      // primer rechazo, el resto del turno se envía sin él.
      let stepReasoningEffort = reasoningEffort;

      while (true) {
        if (abortSignal.aborted) {
          status = 'cancelled';
          executionError = createCancelledError();
          break;
        }

        callbacks.onStepStart?.(stepIndex);

        // La compactación sustituye de una vez el punto de control anterior y el diálogo posterior.
        const compactionOptions = { ...contextOptions, model, providerType: apiType };
        if (!compressionUnavailable && summarizeHistory && ContextManager.shouldCompress(workingMessages, compactionOptions)) {
          callbacks.onCompactionStart?.(stepIndex);
          const compacted = await ContextManager.compressHistory({
            messages: workingMessages,
            summarizeFn: summarizeHistory,
            options: compactionOptions
          });
          if (compacted.compressed) {
            workingMessages = compacted.messages;
          } else {
            // Un resumen que falla no avanzará en esta ejecución: repetirlo en cada paso solo añade llamadas.
            compressionUnavailable = true;
          }
        }

        const stepMessages = prepareMessages ? (await prepareMessages(workingMessages)).messages : workingMessages;
        const activeToolDefs = resolveToolDefinitions ? await resolveToolDefinitions({ stepIndex, workingMessages }) : [];

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
            reasoningEffort: stepReasoningEffort,
            tools: activeToolDefs,
            signal: abortSignal,
            onBeforeRequest,
            onGenerationStatus: status => callbacks.onGenerationStatus?.(status),

            onReasoningChunk: (chunk, accumulated) => {
              currentStepReasoning = accumulated;
              callbacks.onReasoningChunk?.(chunk, accumulated, stepIndex);
            },
            onLog: logData => callbacks.onLog?.(logData),
            onChunk: (fullTextSoFar, delta, stats) => {
              currentStepText = fullTextSoFar;
              callbacks.onChunk?.(fullTextSoFar, delta, stats, stepIndex);
            },
            onError: error => { streamError = error; }
          });

          if (streamError) {
            status = abortSignal.aborted ? 'cancelled' : 'error';
            executionError = abortSignal.aborted ? createCancelledError() : streamError;
            break;
          }

          currentStepText = streamResult.accumulatedText || currentStepText;
          currentStepReasoning = streamResult.accumulatedReasoning || currentStepReasoning;
          stepReasoningReplay = streamResult.reasoningReplay || null;
          stepToolCalls = streamResult.toolCalls;
          stepStats = streamResult.stats;
          if (streamResult.truncated) truncated = true;
          if (streamResult.recoveredReason === 'reasoning_rejected' && stepReasoningEffort) {
            stepReasoningEffort = '';
            callbacks.onLog?.({ type: 'warning', text: 'The server rejected the reasoning parameter: the rest of this turn is sent without it.' });
          }

          if (abortSignal.aborted) {
            if (!currentStepText) {
              status = 'cancelled';
              executionError = createCancelledError();
              break;
            }
            // Al detener se conserva como respuesta el texto recibido, sin ejecutar herramientas.
            stepToolCalls = null;
          }

          lastStats = stepStats || lastStats;
          if (currentStepReasoning) {
            finalReasoningText += (finalReasoningText ? '\n' : '') + currentStepReasoning;
          }

          // Caso A: Sin llamadas a herramientas -> Turno final
          if (!stepToolCalls || stepToolCalls.length === 0) {
            if (!currentStepText?.trim() && workingMessages.at(-1)?.role === 'tool') {
              callbacks.onLog?.({ type: 'warning', text: 'Model ended the tool loop without producing a response.' });
            }

            finalAccumulatedText = currentStepText;
            if (appendFinalMessage) {
              workingMessages.push({ id: createMessageId('final', { stepIndex }), role: 'assistant', content: currentStepText });
            }
            callbacks.onStepDone?.(stepIndex, { type: 'final_response', text: currentStepText, stats: lastStats });
            status = 'completed';
            break;
          }

          // El nombre que se guarda y se reenvía es el registrado, aunque el modelo use un alias.
          for (const call of stepToolCalls) {
            const tool = this.registry.getTool(call.function?.name);
            if (tool) call.function.name = tool.name;
          }
          if (this.isToolCallText(currentStepText || '')) currentStepText = '';

          const loopPeriod = trackToolBatch(currentStepText, stepToolCalls);

          if (loopPeriod > 0) {
            status = 'loop_detected';
            callbacks.onLoopDetected?.(stepToolCalls[0], loopPeriod, stepIndex);
            currentStepText = `${currentStepText || ''}\n\n> ⚠️ *[Infinite Loop Protection]*: Tools were invoked in a repeating pattern with the same arguments without progress. Halting agent turn loop.`;
            finalAccumulatedText = currentStepText;
            const finalMsg = { id: createMessageId('final', { stepIndex }), role: 'assistant', content: currentStepText };
            if (appendFinalMessage) workingMessages.push(finalMsg);
            callbacks.onStepDone?.(stepIndex, { type: 'loop_detected', text: currentStepText, assistantMsg: finalMsg });
            break;
          }

          const batch = await this.executeToolBatch(stepToolCalls, {
            stepIndex, params, signal: abortSignal, dispatchToolCall, createMessageId, callbacks
          });
          toolExecutions.push(...batch.executions);

          // Cada assistant con tool_calls va seguido de los mensajes tool de sus resultados.
          const assistantMsg = {
            id: createMessageId('assistant', { stepIndex }),
            role: 'assistant',
            content: currentStepText || null,
            tool_calls: stepToolCalls
          };
          // Solo vive durante el turno: buildEffectiveMessages lo reenvía y el historial devuelto lo omite.
          if (stepReasoningReplay) assistantMsg.reasoningReplay = stepReasoningReplay;
          workingMessages.push(assistantMsg, ...batch.toolMessages);
          callbacks.onStepDone?.(stepIndex, { type: 'tool_execution', assistantMsg });

          stepIndex++;

          // Una herramienta puede ceder el turno al usuario (ask_user): el bucle termina
          // y la respuesta del usuario llega como el siguiente mensaje.
          if (batch.results.some(r => r.success && r.result?.endTurn === true)) {
            yieldedToUser = true;
            status = 'completed';
            break;
          }
        } catch (err) {
          status = abortSignal.aborted ? 'cancelled' : 'error';
          executionError = abortSignal.aborted ? createCancelledError() : err;
          break;
        }
      }

      const totalElapsedMs = Math.round(performance.now() - startTime);
      callbacks.onDone?.(finalAccumulatedText, lastStats, stepIndex);

      return {
        success: status === 'completed' || status === 'loop_detected',
        status,
        finalText: finalAccumulatedText,
        reasoningText: finalReasoningText,
        stepsCount: stepIndex,
        loopDetected: status === 'loop_detected',
        truncated,
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

  const registry = new ToolRegistry();
  const executor = new ToolExecutor(registry);
  const runtime = new AgentRuntime({ registry, executor });

  return {
    TOOL_WORKFLOW_INSTRUCTION,
    isToolEnabled,
    browserOfTool,
    activeBrowserTool,
    Tool,
    ToolRegistry,
    ToolExecutor,
    AgentRuntime,
    registry,
    executor,
    runtime,
    dispatchToolCall: (toolCall, options) => executor.dispatchToolCall(toolCall, options)
  };
});
