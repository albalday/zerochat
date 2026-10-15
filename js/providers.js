/**
 * Módulo de Adaptadores y Capacidades de Proveedores LLM (ChatProviders).
 * Separa la lógica específica de cada proveedor (OpenAI, Claude, Gemini, Ollama, OpenRouter, Custom)
 * de la capa común de transporte HTTP/SSE mediante un sistema declarativo de capacidades (Capabilities).
 * Compatible con file://, http:// y Node.js.
 */

(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./message-turns.js'), require('./text-tool-calls.js'), require('./utils.js'));
  } else {
    root.ChatProviders = factory(root.ChatMessageTurns, root.ChatTextToolCalls, root.ChatUtils);
  }
})(typeof self !== 'undefined' ? self : this, function (MessageTurns, TextToolCalls, Utils) {
  'use strict';

  /**
   * Esquema estándar de capacidades soportadas por adaptadores de modelos LLM.
   */
  const DEFAULT_CAPABILITIES = {
    streaming: true,      // Soporte para streaming de respuestas vía SSE
    vision: true,         // Soporte para procesamiento de imágenes multimodales
    tools: true,          // Soporte para Function / Tool Calling
    textTools: false,     // Herramientas mediante bloques <tool_call> en texto cuando no hay soporte nativo
    reasoning: true,      // Soporte para control de razonamiento (thinking / reasoning_effort)
    temperature: true,    // Admite el parámetro de muestreo temperature
    jsonMode: true,       // Soporte para structured outputs / response_format: { type: "json_object" }
    promptCaching: true,  // Soporte para Context / Prompt Caching efímero o persistente
    embeddings: true,     // Soporte para endpoints de generación de embeddings
    modelListing: true    // Soporte para descubrimiento automático de modelos (/models, /api/tags)
  };

  // Campos de los mensajes del asistente en los que los servidores compatibles con OpenAI
  // devuelven y aceptan el razonamiento: reasoning_content (llama.cpp, vLLM, DeepSeek) y
  // reasoning (Ollama, OpenRouter).
  const REASONING_REPLAY_FIELDS = ['reasoning_content', 'reasoning'];

  const { serializeContent, fetchWithTimeout } = Utils;

  // Capacidades que el inspector infiere del nombre de los modelos.
  const MODEL_NAME_INFERENCES = [
    ['vision', /(?:-vl|-vision|vision|4o|sonnet|opus|flash|pixtral|llava|cogvlm|gemini|qwen.*vl)/i, 'inspector_detail_vision_inferred'],
    ['reasoning', /(?:-r1|r1|qwq|o1|o3|reasoning|thinking|gemma-4|deepseek)/i, 'inspector_detail_reasoning_inferred'],
    ['embeddings', /(?:embedding|embed|bge|nomic|e5|text-embedding)/i, 'inspector_detail_embeddings_inferred']
  ];

  /**
   * Visión que el servidor declara para un modelo: true, false o null si no la declara. Lee
   * architecture.input_modalities (llama.cpp, OpenRouter), type de LM Studio (vlm, llm) y
   * capabilities de Ollama (vision).
   */
  function declaredVision(details) {
    if (!details || typeof details !== 'object') return null;
    const inputs = details.architecture?.input_modalities;
    if (Array.isArray(inputs)) return inputs.includes('image');
    if (details.type === 'vlm') return true;
    if (details.type === 'llm') return false;
    if (Array.isArray(details.capabilities)) return details.capabilities.includes('vision');
    return null;
  }

  /** Mensaje de un error que el servidor envía dentro del streaming: texto u objeto con message o type. */
  function streamErrorMessage(error) {
    if (typeof error === 'string') return error;
    return error.message || error.type || JSON.stringify(error);
  }

  /** Copia en el resultado del chunk el uso de tokens y los tokens leídos y escritos en caché. */
  function readUsage(result, usage) {
    result.usage = usage;
    if (usage.prompt_tokens_details?.cached_tokens) result.cachedTokens = usage.prompt_tokens_details.cached_tokens;
    if (usage.cache_read_input_tokens) result.cachedTokens = usage.cache_read_input_tokens;
    if (usage.cache_creation_input_tokens) result.cacheCreationTokens = usage.cache_creation_input_tokens;
  }

  /** Estado de una capacidad en el informe del inspector; la interfaz traduce `detailKey`. */
  const capability = (status, detailKey, detailParams, source) => ({ status, detailKey, detailParams, source });


  /** Marca como punto de caché efímero el último bloque de un contenido (Anthropic y OpenRouter). */
  function attachCacheControl(content) {
    if (typeof content === 'string') {
      return [{ type: 'text', text: content, cache_control: { type: 'ephemeral' } }];
    }
    if (Array.isArray(content) && content.length > 0) {
      const updated = [...content];
      updated[updated.length - 1] = { ...updated[updated.length - 1], cache_control: { type: 'ephemeral' } };
      return updated;
    }
    return content;
  }

  /** Último turno procesable (user o tool): ancla el punto dinámico de caché. */
  function findLastProcessableIndex(messages) {
    return messages.findLastIndex(m => m.role === 'user' || m.role === 'tool');
  }

  /**
   * Adaptador Base genérico (compatible con OpenAI, LM Studio, vLLM, LocalAI, DeepSeek).
   */
  class BaseProviderAdapter {
    constructor(options = {}) {
      this.id = options.id || 'openai';
      this.label = options.label || 'OpenAI / LM Studio';
      this.reasoningLevels = options.reasoningLevels || ['none', 'low', 'medium', 'high', 'xhigh'];
      this.connection = {
        endpoint: options.connection?.endpoint || 'http://localhost:1234/v1',
        knownEndpoints: Array.isArray(options.connection?.knownEndpoints) ? [...options.connection.knownEndpoints] : [],
        endpointReadOnly: options.connection?.endpointReadOnly === true,
        credentials: options.connection?.credentials !== false,
        localModelManagement: options.connection?.localModelManagement === true
      };
      this.capabilities = {
        ...DEFAULT_CAPABILITIES,
        ...(options.capabilities || {})
      };
    }

    /**
     * Obtiene el conjunto de capacidades del adaptador, permitiendo ajustes según el modelo.
     */
    getCapabilities(model) {
      return { ...this.capabilities };
    }

    getConnectionConfig() {
      return { ...this.connection, knownEndpoints: [...this.connection.knownEndpoints] };
    }

    async deactivate() {}

    /**
     * Normaliza la URL base al endpoint de chat del proveedor.
     */
    normalizeEndpoint(rawUrl) {
      let url = (rawUrl || 'http://localhost:1234/v1').trim();
      if (url.endsWith('/')) url = url.slice(0, -1);
      if (url.endsWith('/chat/completions')) return url;
      if (url.endsWith('/v1')) return `${url}/chat/completions`;
      return `${url}/v1/chat/completions`;
    }

    /**
     * Construye las cabeceras HTTP necesarias para la petición.
     */
    buildHeaders(apiKey) {
      const headers = { 'Content-Type': 'application/json' };
      if (apiKey && apiKey.trim() !== '') {
        headers['Authorization'] = `Bearer ${apiKey.trim()}`;
      }
      return headers;
    }

    /**
     * Adapta y formatea la lista de mensajes (filtrando imágenes si vision está deshabilitado).
     */
    formatMessages(messages, capabilities) {
      const caps = capabilities || this.getCapabilities();
      if (caps.vision) {
        return messages;
      }
      // Si el proveedor no soporta visión, degradar imágenes a texto plano
      return messages.map(m => {
        if (Array.isArray(m.content)) {
          const textOnly = m.content
            .filter(part => part.type === 'text')
            .map(part => part.text)
            .join('\n');
          return { ...m, content: textOnly };
        }
        return m;
      });
    }

    /**
     * Normaliza el nivel elegido y lo aplica si el modelo razona. "none" se pide de forma explícita:
     * sin parámetro el modelo razona según su valor por defecto. Un servidor que no admite apagarlo
     * lo rechaza y handleHttpError reintenta sin él.
     */
    applyReasoningEffort(payload, capabilities, reasoningEffort) {
      const effort = String(reasoningEffort || '').toLowerCase().trim();
      if (capabilities.reasoning && effort) this.applyReasoning(payload, effort);
    }

    /** Aplica al payload un nivel de razonamiento ya normalizado y no vacío. */
    applyReasoning(payload, effort) {
      payload.reasoning_effort = effort;
    }

    supportsUsageStatistics() {
      const id = String(this.id || '').toLowerCase();
      return id !== 'ollama' && id !== 'gemini' && id !== 'claude';
    }

    /**
     * Aplica la solicitud de métricas detalladas de tokens si se trata de streaming.
     */
    requestUsageStatistics(payload, stream = true) {
      if (stream !== false && this.supportsUsageStatistics()) {
        payload.stream_options = { include_usage: true };
      }
    }

    /**
     * Aplica opciones específicas de caché de contexto (Prompt / KV Caching).
     * En OpenAI/v1 compatible, la caché es gestionada automáticamente por el servidor según el prefijo,
     * y las métricas se obtienen a través de requestUsageStatistics.
     */
    applyContextCache(payload, options = {}) {
      this.requestUsageStatistics(payload, options.stream !== false);
    }

    /**
     * Aplica el modo de respuesta estructurada en formato JSON.
     */
    applyJsonMode(payload) {
      payload.response_format = { type: 'json_object' };
    }

    /**
     * Inyecta las definiciones de herramientas agénticas.
     */
    applyTools(payload, toolsList, toolChoice = 'auto') {
      if (toolsList && toolsList.length > 0) {
        payload.tools = toolsList;
        payload.tool_choice = toolChoice;
      }
    }

    /**
     * Construye el payload completo para la petición HTTP de Chat Completion.
     */
    buildPayload(params) {
      const {
        model = '',
        messages = [],
        temperature = 0.7,
        reasoningEffort = 'medium',
        toolsList = [],
        toolChoice = 'auto',
        stream = true,
        jsonMode = false
      } = params;

      const capabilities = this.getCapabilities(model);
      const usesTextTools = !capabilities.tools && capabilities.textTools && TextToolCalls;
      const formattedMessages = usesTextTools
        ? TextToolCalls.prepareMessages(this.formatMessages(messages, capabilities), toolsList)
        : this.formatMessages(messages, capabilities);

      const payload = {
        model: (model || '').trim(),
        messages: formattedMessages
      };
      if (capabilities.temperature !== false) {
        payload.temperature = parseFloat(temperature) || 0.7;
      }

      if (capabilities.streaming && stream !== false) {
        payload.stream = true;
        if (this.supportsUsageStatistics()) {
          this.requestUsageStatistics(payload, true);
        }
      }

      this.applyReasoningEffort(payload, capabilities, reasoningEffort);

      if (capabilities.tools && toolsList && toolsList.length > 0) {
        this.applyTools(payload, toolsList, toolChoice);
      }

      if (capabilities.promptCaching) {
        this.applyContextCache(payload, { toolsList, messages: formattedMessages, stream: stream !== false });
      }

      if (capabilities.jsonMode && jsonMode) {
        this.applyJsonMode(payload);
      }

      return payload;
    }

    /**
     * Parsea un evento SSE (data JSON) para extraer deltas de texto, pensamiento, tools y usage.
     */
    parseStreamChunk(parsed, state) {
      const result = {
        textChunk: '',
        reasoningChunk: '',
        toolCallDeltas: [],
        usage: null,
        cachedTokens: 0,
        cacheCreationTokens: 0
      };

      const choice = parsed.choices?.[0];
      const delta = choice?.delta;

      // Un servidor que ya respondió 200 solo puede avisar de un fallo dentro del propio flujo.
      if (parsed.error) result.error = streamErrorMessage(parsed.error);
      // Motivo de fin cuando el servidor cortó la respuesta en el límite de tokens de salida.
      if (choice?.finish_reason === 'length') result.truncatedBy = 'length';

      if (delta) {
        // Tokens de razonamiento específicos
        const rChunk = delta.reasoning_content || delta.reasoning || delta.thinking || delta.thought || '';
        if (rChunk) {
          result.reasoningChunk = rChunk;
          // Campo en el que el servidor acepta de vuelta el razonamiento dentro del bucle de herramientas.
          const field = REASONING_REPLAY_FIELDS.find(name => typeof delta[name] === 'string' && delta[name]);
          if (field) result.reasoningField = field;
        }

        // Contenido textual normal
        const text = delta.content || delta.text || '';
        if (text) {
          result.textChunk = text;
        }

        // Llamadas a herramientas
        if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
          result.toolCallDeltas = delta.tool_calls;
        }

        // Thought signature de Gemini / Google
        const sig = delta.thought_signature || delta.extra_content?.google?.thought_signature || choice?.thought_signature || parsed.thought_signature;
        if (sig) {
          result.thoughtSignature = sig;
        }
      }

      // Usage / Context Caching (OpenAI, Anthropic, Ollama)
      let usage = parsed.usage || parsed.message?.usage;
      if (!usage && (parsed.prompt_eval_count !== undefined || parsed.eval_count !== undefined)) {
        const pEval = parsed.prompt_eval_count ?? 0;
        const cEval = parsed.eval_count ?? 0;
        usage = {
          prompt_tokens: pEval,
          completion_tokens: cEval,
          total_tokens: pEval + cEval
        };
      }

      if (usage) readUsage(result, usage);

      return result;
    }

    /**
     * Evalúa si un error HTTP 400 permite auto-recuperación (reintento sin params rechazados).
     */
    handleHttpError(status, serverErrorMsg, payload) {
      const errLower = (serverErrorMsg || '').toLowerCase();

      // Va antes que la regla de parámetros: un rechazo del razonamiento reenviado en los mensajes
      // también menciona "reasoning" y quitar reasoning_effort no lo resolvería. "reasoning" es
      // además un parámetro raíz (OpenRouter), así que solo cuenta si el error habla de mensajes.
      const replayFields = REASONING_REPLAY_FIELDS.filter(field =>
        Array.isArray(payload.messages) && payload.messages.some(m => m && m.role === 'assistant' && field in m));
      const rejectsReplay = replayFields.some(field => field === 'reasoning'
        ? errLower.includes('message') && errLower.includes(field)
        : errLower.includes(field));
      if (status === 400 && rejectsReplay) {
        payload.messages = payload.messages.map(m => {
          if (!m || m.role !== 'assistant') return m;
          const clean = { ...m };
          replayFields.forEach(field => { delete clean[field]; });
          return clean;
        });
        return { retry: true, reason: 'reasoning_history_rejected' };
      }

      if (status === 400 && (payload.reasoning_effort || payload.thinking || payload.reasoning)) {
        if (errLower.includes('reasoning') || errLower.includes('thinking') || errLower.includes('unexpected') || errLower.includes('unrecognized') || errLower.includes('extra') || errLower.includes('unknown')) {
          delete payload.reasoning_effort;
          delete payload.thinking;
          delete payload.reasoning;
          return { retry: true, reason: 'reasoning_rejected' };
        }
      }

      if (status === 400 && payload.tools) {
        if (errLower.includes('tool') || errLower.includes('function') || errLower.includes('unexpected') || errLower.includes('unrecognized')) {
          delete payload.tools;
          delete payload.tool_choice;
          return { retry: true, reason: 'tools_rejected' };
        }
      }

      return { retry: false };
    }

    /**
     * Devuelve endpoints candidatos para consultar modelos disponibles.
     */
    getModelEndpoints(cleanUrl) {
      const v1Url = cleanUrl.endsWith('/v1') ? cleanUrl : `${cleanUrl}/v1`;
      const baseWithoutV1 = cleanUrl.replace(/\/v1$/, '');
      // LM Studio exposes the active context length only through /api/v0/models.
      return [`${baseWithoutV1}/api/v0/models`, `${v1Url}/models`];
    }

    /**
     * Petición con los detalles de un modelo cuando el listado no los incluye; null si el servidor
     * no la tiene.
     */
    getModelInfoRequest() {
      return null;
    }

    /**
     * Parsea la respuesta del endpoint de modelos.
     */
    parseModelsResponse(data) {
      if (data && Array.isArray(data.data)) {
        return data.data.map(item => {
          if (typeof item === 'string') return { id: item, name: item };
          return {
            id: item.id || item.name || '',
            name: item.id || item.name || '',
            owned_by: item.owned_by,
            details: item
          };
        }).filter(m => !!m.id);
      }
      if (Array.isArray(data)) {
        return data.map(item => {
          if (typeof item === 'string') return { id: item, name: item };
          return {
            id: item.id || item.name || '',
            name: item.id || item.name || '',
            details: item
          };
        }).filter(m => !!m.id);
      }
      return [];
    }

    /**
     * Diagnostica el endpoint y sus capacidades. Cada capacidad lleva su estado ('declared' por el
     * adaptador, 'inferred' por el nombre de los modelos, 'confirmed' o 'unsupported' por una sonda
     * con max_tokens: 1, o 'unknown') y la clave i18n que lo explica.
     */
    async inspect({ apiUrl = '', apiKey = '', model = '', runProbes = true, timeoutMs = 6000 } = {}) {
      const startTime = performance.now();
      const normalizedEndpoint = this.normalizeEndpoint(apiUrl);
      const cleanBase = apiUrl.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
      const adapterCaps = this.getCapabilities(model);
      const headers = this.buildHeaders(apiKey);

      const declared = (supported, otherwise = 'unsupported') => supported
        ? capability('declared', 'inspector_detail_declared', {}, 'adapter')
        : capability(otherwise, otherwise === 'unknown' ? 'inspector_detail_undetermined' : 'inspector_detail_unsupported', {}, 'adapter');
      const capabilities = {
        streaming: declared(adapterCaps.streaming),
        tools: declared(adapterCaps.tools),
        vision: declared(adapterCaps.vision),
        reasoning: declared(adapterCaps.reasoning),
        jsonMode: declared(adapterCaps.jsonMode),
        promptCaching: declared(adapterCaps.promptCaching, 'unknown'),
        embeddings: declared(adapterCaps.embeddings, 'unknown'),
        modelListing: declared(adapterCaps.modelListing)
      };

      let discoveredModels = [];
      let connectionSuccess = false;
      let authError = null;
      let lastNetworkError = null;
      let lastHttpStatus = null;

      /** Petición de una sonda; un 401/403 se recuerda como error de autenticación. */
      const request = async (url, init) => {
        try {
          const res = await fetchWithTimeout(url, { ...init, headers: { ...init.headers, ...headers } }, timeoutMs);
          if (res.status !== 404) lastHttpStatus = res.status;
          if (res.status === 401 || res.status === 403) authError = `Authentication error (HTTP ${res.status}): invalid API key or access denied.`;
          return res;
        } catch (error) {
          lastNetworkError = error;
          return null;
        }
      };

      if (runProbes) {
        for (const endpoint of this.getModelEndpoints(cleanBase)) {
          const res = await request(endpoint, { method: 'GET', headers: { Accept: 'application/json' } });
          if (!res?.ok) continue;
          connectionSuccess = true;
          const parsed = this.parseModelsResponse(await res.json());
          if (parsed.length > 0) {
            discoveredModels = parsed;
            capabilities.modelListing = capability('confirmed', 'inspector_detail_models_found', { count: parsed.length, endpoint }, 'probe');
            break;
          }
        }
        if (!discoveredModels.length && adapterCaps.modelListing) {
          capabilities.modelListing = capability('unknown', 'inspector_detail_models_unavailable', {}, 'probe');
        }
      }

      // Inferencias por el modelo elegido y los nombres del catálogo.
      const probeModel = model || discoveredModels[0]?.id || '';
      const modelNames = [probeModel, ...discoveredModels.map(item => item.id || item.name || '')].join(' ').toLowerCase().trim();
      for (const [key, pattern, detailKey] of MODEL_NAME_INFERENCES) {
        if (modelNames && pattern.test(modelNames)) capabilities[key] = capability('inferred', detailKey, {}, 'model_name');
      }

      // La visión que declara el servidor manda sobre la inferida por el nombre.
      let vision = declaredVision(discoveredModels.find(item => item.id === probeModel)?.details);
      const infoRequest = vision === null && connectionSuccess && probeModel ? this.getModelInfoRequest(cleanBase, probeModel) : null;
      if (infoRequest) {
        const res = await request(infoRequest.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(infoRequest.body) });
        if (res?.ok) vision = declaredVision(await res.json().catch(() => null));
      }
      if (vision !== null) {
        capabilities.vision = vision
          ? capability('confirmed', 'inspector_detail_vision_server', {}, 'server')
          : capability('unsupported', 'inspector_detail_vision_text_only', {}, 'server');
      }

      if (runProbes) {
        /** Sonda de chat: un 200 confirma la capacidad y un 400/422 que menciona `rejectWords` la descarta. */
        const chatProbe = async (key, payloadOptions, rejectWords, confirmedKey, confirmed = () => true) => {
          const payload = this.buildPayload({ model: probeModel, messages: [{ role: 'user', content: 'hi' }], ...payloadOptions });
          payload.max_tokens = 1;
          if (payloadOptions.toolsList) payload.tool_choice = 'none';
          const res = await request(normalizedEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
          if (!res) return;
          if (res.ok) {
            connectionSuccess = true;
            if (confirmed(res)) capabilities[key] = capability('confirmed', confirmedKey, {}, 'probe');
          } else if (res.status === 400 || res.status === 422) {
            connectionSuccess = true;
            const errText = (await res.text().catch(() => '')).toLowerCase();
            if (rejectWords.some(word => errText.includes(word))) {
              capabilities[key] = capability('unsupported', 'inspector_detail_rejected', { error: errText.substring(0, 80) }, 'probe');
            }
          }
        };
        await chatProbe('streaming', { stream: true, temperature: 0.1, reasoningEffort: '' }, ['stream'], 'inspector_detail_streaming_confirmed',
          res => (res.headers.get('content-type') || '').includes('event-stream') || Boolean(res.body));
        await chatProbe('tools', {
          stream: false,
          toolsList: [{ type: 'function', function: { name: 'ping_test', description: 'Inspector ping test', parameters: { type: 'object', properties: {} } } }]
        }, ['tool', 'function', 'schema'], 'inspector_detail_tools_confirmed');
        await chatProbe('jsonMode', { stream: false, jsonMode: true }, ['response_format', 'json'], 'inspector_detail_json_confirmed');

        // La sonda de embeddings no cuenta como conexión fallida: muchos servidores no la tienen.
        const embUrl = cleanBase.endsWith('/v1') ? `${cleanBase}/embeddings` : `${cleanBase}/v1/embeddings`;
        const previousError = lastNetworkError;
        const res = await request(embUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: 'ping', model: probeModel }) });
        lastNetworkError = previousError;
        if (res?.ok) {
          connectionSuccess = true;
          capabilities.embeddings = capability('confirmed', 'inspector_detail_embeddings_confirmed', { endpoint: embUrl }, 'probe');
        } else if (res?.status === 404) {
          capabilities.embeddings = capability('unsupported', 'inspector_detail_embeddings_missing', { endpoint: embUrl }, 'probe');
        } else if (res?.status === 400 || res?.status === 422) {
          connectionSuccess = true;
        }
      }

      // Resultado estructurado de la inspección, sin apiKey.
      const buildInspection = ({ discovered, ...status }) => ({
        ...status,
        provider: { id: this.id, label: this.label },
        endpoint: { raw: apiUrl, normalized: normalizedEndpoint, base: cleanBase },
        model: { selected: probeModel, totalDiscovered: discovered.length, discovered },
        capabilities,
        inspectionTimeMs: Math.round(performance.now() - startTime)
      });

      if (runProbes && !connectionSuccess) {
        let errorMsg;
        if (authError) errorMsg = authError;
        else if (lastNetworkError) errorMsg = `Connection error: could not reach the server at ${normalizedEndpoint} (${lastNetworkError.message || String(lastNetworkError)}). Check that the server is running and the URL is correct.`;
        else if (lastHttpStatus) errorMsg = `Connection error: the server answered HTTP ${lastHttpStatus} at ${normalizedEndpoint}. Check the endpoint and the configuration.`;
        else errorMsg = `Connection error: could not communicate with the server at ${normalizedEndpoint}.`;
        for (const key of Object.keys(capabilities)) capabilities[key] = capability('unknown', 'inspector_detail_not_checked', {}, 'probe');
        return buildInspection({ success: false, connected: false, error: errorMsg, discovered: [], probesRun: true });
      }

      return buildInspection({ success: true, connected: runProbes ? true : null, discovered: discoveredModels, probesRun: runProbes });
    }
  }

  // Salida máxima por petición en la Messages API, donde max_tokens es obligatorio.
  const CLAUDE_MAX_TOKENS = 32000;

  // tool_choice de OpenAI ('auto', 'none', 'required' o una función concreta) en la Messages API.
  function toClaudeToolChoice(choice) {
    if (choice === 'auto' || choice === 'none') return { type: choice };
    if (choice === 'required') return { type: 'any' };
    if (choice && choice.type === 'function' && choice.function?.name) return { type: 'tool', name: choice.function.name };
    return null;
  }

  // tool_use exige un objeto como input: unos argumentos ilegibles se reenvían como objeto vacío,
  // porque el resultado de esa herramienta ya le explica el error al modelo.
  function parseToolInput(args) {
    if (args && typeof args === 'object') return args;
    try {
      const parsed = JSON.parse(args || '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (err) {
      return {};
    }
  }

  // input_tokens de la Messages API excluye lo leído y escrito en caché; el contexto es la suma.
  function withClaudePromptTokens(usage) {
    if (usage.input_tokens === undefined) return usage;
    const promptTokens = usage.input_tokens + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
    return { ...usage, prompt_tokens: promptTokens };
  }

  function clampThinkingBudget(budget, maxTokens) {
    if (maxTokens && budget >= maxTokens) {
      return Math.floor(maxTokens / 2);
    }
    return budget;
  }

  /**
   * Adaptador para Anthropic Claude (/v1/messages).
   */
  class ClaudeProviderAdapter extends BaseProviderAdapter {
    constructor() {
      super({
        id: 'claude',
        label: 'Anthropic Claude',
        connection: { endpoint: 'https://api.anthropic.com/v1' },
        reasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh'],
        capabilities: {
          streaming: true,
          vision: true,
          tools: true,
          reasoning: true,
          jsonMode: false,
          promptCaching: true,
          embeddings: false,
          modelListing: true
        }
      });
      this.effectiveMaxTokens = new Map();
    }

    normalizeEndpoint(rawUrl) {
      let url = (rawUrl || 'https://api.anthropic.com/v1').trim();
      if (url.endsWith('/')) url = url.slice(0, -1);
      if (url.endsWith('/v1/messages') || url.endsWith('/messages') || url.endsWith('/chat/completions')) return url;
      if (url.endsWith('/v1')) return `${url}/messages`;
      return `${url}/v1/messages`;
    }

    /**
     * Construye las cabeceras HTTP necesarias para Anthropic directo o proxies.
     */
    buildHeaders(apiKey) {
      const headers = super.buildHeaders(apiKey);
      // Cabecera obligatoria de versión para API directa de Anthropic (https://api.anthropic.com/v1)
      headers['anthropic-version'] = '2023-06-01';
      if (apiKey && apiKey.trim() !== '') {
        headers['x-api-key'] = apiKey.trim();
      }
      return headers;
    }

    /**
     * Traduce el historial en formato OpenAI a bloques de la Messages API: imágenes base64, assistant
     * con thinking, text y tool_use, y resultados de herramientas como tool_result en un turno user.
     */
    formatMessages(messages, capabilities) {
      const caps = capabilities || this.getCapabilities();
      const formatted = [];
      messages.forEach(m => {
        if (m.role === 'tool') {
          const block = { type: 'tool_result', tool_use_id: m.tool_call_id, content: serializeContent(m.content) };
          const previous = formatted[formatted.length - 1];
          // Los resultados de llamadas paralelas van juntos en el turno user que sigue al assistant.
          if (previous && previous.role === 'user' && Array.isArray(previous.content) && previous.content.every(part => part.type === 'tool_result')) {
            previous.content.push(block);
          } else {
            formatted.push({ role: 'user', content: [block] });
          }
        } else if (m.role === 'assistant') {
          formatted.push(this.formatAssistantMessage(m));
        } else if (Array.isArray(m.content)) {
          const claudeParts = m.content.map(part => {
            if (caps.vision && part.type === 'image_url' && part.image_url && part.image_url.url) {
              const match = part.image_url.url.match(/^data:([^;]+);base64,(.+)$/);
              if (match) {
                return {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: match[1],
                    data: match[2]
                  }
                };
              }
            }
            return part;
          }).filter(part => part.type === 'text' || (caps.vision && part.type === 'image'));
          formatted.push({ ...m, content: claudeParts });
        } else {
          formatted.push(m);
        }
      });
      return formatted;
    }

    formatAssistantMessage(m) {
      const hasToolCalls = Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
      const hasThinking = typeof m.thinking === 'string' && m.thinking !== '';
      if (!hasToolCalls && !hasThinking) return { role: 'assistant', content: m.content ?? '' };

      const blocks = [];
      if (hasThinking) {
        const thinking = { type: 'thinking', thinking: m.thinking };
        if (typeof m.reasoning_signature === 'string') thinking.signature = m.reasoning_signature;
        blocks.push(thinking);
      }
      if (Array.isArray(m.content)) {
        blocks.push(...m.content);
      } else if (typeof m.content === 'string' && m.content.trim() !== '') {
        blocks.push({ type: 'text', text: m.content });
      }
      (m.tool_calls || []).forEach(call => {
        blocks.push({
          type: 'tool_use',
          id: call.id,
          name: call.function?.name || '',
          input: parseToolInput(call.function?.arguments)
        });
      });
      return { role: 'assistant', content: blocks };
    }

    buildPayload(params) {
      const {
        model = '',
        messages = [],
        temperature = 0.7,
        reasoningEffort = 'medium',
        toolsList = [],
        toolChoice = 'auto',
        stream = true
      } = params;

      const capabilities = this.getCapabilities(model);
      const formattedMessages = this.formatMessages(messages, capabilities);

      // Separar system prompt (requerido a nivel raíz en Claude Messages API)
      const systemMessages = formattedMessages.filter(m => m.role === 'system');
      const nonSystemMessages = formattedMessages.filter(m => m.role !== 'system');

      let systemContent = '';
      if (systemMessages.length > 0) {
        systemContent = systemMessages.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n\n');
      }

      // max_tokens es obligatorio y limita razonamiento y respuesta juntos; un modelo con menos
      // salida máxima lo rechaza indicando su límite y handleHttpError reintenta con él.
      const endpointKey = (params.endpoint || this.connection?.endpoint || '').trim();
      const modelKey = (model || '').trim();
      const cacheKey = `${endpointKey}::${modelKey}`;
      const effectiveMaxTokens = this.effectiveMaxTokens.get(cacheKey) || CLAUDE_MAX_TOKENS;
      const payload = {
        model: modelKey,
        messages: nonSystemMessages,
        temperature: parseFloat(temperature) || 0.7,
        max_tokens: effectiveMaxTokens
      };
      Object.defineProperty(payload, '_endpoint', {
        value: endpointKey,
        enumerable: false,
        writable: true,
        configurable: true
      });

      if (systemContent) {
        if (capabilities.promptCaching) {
          payload.system = [{ type: 'text', text: systemContent, cache_control: { type: 'ephemeral' } }];
        } else {
          payload.system = systemContent;
        }
      }

      if (capabilities.streaming && stream !== false) {
        payload.stream = true;
      }

      this.applyReasoningEffort(payload, capabilities, reasoningEffort);

      if (capabilities.tools && toolsList && toolsList.length > 0) {
        payload.tools = toolsList.map(t => {
          if (t.type === 'function' && t.function) {
            return {
              name: t.function.name,
              description: t.function.description || '',
              input_schema: t.function.parameters || { type: 'object', properties: {} }
            };
          }
          return { ...t };
        });
        const choice = toClaudeToolChoice(toolChoice);
        if (choice) payload.tool_choice = choice;
      }

      if (capabilities.promptCaching) {
        this.applyContextCache(payload, { messages: nonSystemMessages });
      }

      return payload;
    }

    /** El razonamiento se activa con un presupuesto y "none" lo desactiva de forma explícita. */
    applyReasoning(payload, effort) {
      if (effort === 'none') {
        payload.thinking = { type: 'disabled' };
        return;
      }
      let budget = 2048;
      if (effort === 'low' || effort === 'minimal') budget = 1024;
      else if (effort === 'high') budget = 4096;
      else if (effort === 'xhigh') budget = 8192;

      budget = clampThinkingBudget(budget, payload.max_tokens);

      payload.thinking = {
        type: 'enabled',
        budget_tokens: budget
      };
      payload.temperature = 1.0;
    }

    applyContextCache(payload, options = {}) {
      const { messages = [] } = options;

      if (Array.isArray(payload.tools) && payload.tools.length > 0) {
        payload.tools[payload.tools.length - 1].cache_control = { type: 'ephemeral' };
      }

      // El sistema va en payload.system con su propio punto de caché; aquí solo hay turnos.
      const lastProcessableIdx = findLastProcessableIndex(messages);
      payload.messages = messages.map((m, idx) => (idx === lastProcessableIdx ? { ...m, content: attachCacheControl(m.content) } : m));
    }

    handleHttpError(status, serverErrorMsg, payload) {
      // Anthropic: "max_tokens: 32000 > 8192, which is the maximum allowed number of output tokens".
      const limit = Number((String(serverErrorMsg || '').match(/max_tokens\D*\d+\s*>\s*(\d+)/i) || [])[1]);
      if (status === 400 && limit > 0 && limit < payload.max_tokens) {
        payload.max_tokens = limit;
        if (payload.model) {
          const endpointKey = (payload._endpoint || this.connection?.endpoint || '').trim();
          const cacheKey = `${endpointKey}::${payload.model}`;
          this.effectiveMaxTokens.set(cacheKey, limit);
        }
        if (payload.thinking) {
          payload.thinking.budget_tokens = clampThinkingBudget(payload.thinking.budget_tokens, limit);
        }
        return { retry: true, reason: 'max_tokens_rejected' };
      }
      return super.handleHttpError(status, serverErrorMsg, payload);
    }

    parseStreamChunk(parsed, state) {
      // Los eventos de la Messages API llevan type; sin él es Claude servido en formato OpenAI (OpenRouter).
      if (!parsed.type) return super.parseStreamChunk(parsed, state);

      const result = {
        textChunk: '',
        reasoningChunk: '',
        toolCallDeltas: [],
        usage: null,
        cachedTokens: 0,
        cacheCreationTokens: 0
      };

      if (parsed.type === 'error') result.error = streamErrorMessage(parsed.error || 'error');
      if (parsed.type === 'message_delta' && parsed.delta?.stop_reason === 'max_tokens') {
        result.truncatedBy = 'max_tokens';
      }

      const usage = parsed.type === 'message_start' ? parsed.message?.usage
        : (parsed.type === 'message_delta' ? parsed.usage : null);
      if (usage) readUsage(result, withClaudePromptTokens(usage));

      // Cada bloque tool_use se acumula por el índice de su bloque de contenido.
      if (parsed.type === 'content_block_start' && parsed.content_block?.type === 'tool_use') {
        const block = parsed.content_block;
        const input = block.input && typeof block.input === 'object' && Object.keys(block.input).length > 0
          ? JSON.stringify(block.input)
          : '';
        result.toolCallDeltas = [{ index: parsed.index, id: block.id, function: { name: block.name || '', arguments: input } }];
      }

      if (parsed.type === 'content_block_delta') {
        if (parsed.delta?.type === 'thinking_delta' && parsed.delta?.thinking) {
          result.reasoningChunk = parsed.delta.thinking;
          result.reasoningField = 'thinking';
        } else if (parsed.delta?.type === 'signature_delta' && typeof parsed.delta.signature === 'string') {
          result.reasoningSignature = parsed.delta.signature;
        } else if (parsed.delta?.type === 'text_delta' && parsed.delta?.text) {
          result.textChunk = parsed.delta.text;
        } else if (parsed.delta?.type === 'input_json_delta' && parsed.delta.partial_json) {
          result.toolCallDeltas = [{ index: parsed.index, function: { arguments: parsed.delta.partial_json } }];
        }
      }

      return result;
    }

    getModelEndpoints(cleanUrl) {
      const v1Url = cleanUrl.endsWith('/v1') ? cleanUrl : `${cleanUrl}/v1`;
      return [`${v1Url}/models`];
    }
  }

  /**
   * Adaptador para Google Gemini (Endpoint OpenAI compatible).
   */
  class GeminiProviderAdapter extends BaseProviderAdapter {
    constructor() {
      super({
        id: 'gemini',
        label: 'Google Gemini',
        connection: { endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai' },
        reasoningLevels: ['none', 'low', 'medium', 'high'],
        capabilities: {
          streaming: true,
          vision: true,
          tools: true,
          // Google rechazará temperature, top_p y top_k en los próximos modelos Gemini
          temperature: false,
          jsonMode: true,
          promptCaching: true,
          embeddings: true,
          modelListing: true
        }
      });
    }

    /** reasoning_effort de Gemini no tiene nivel por encima de high: Máximo pide high. */
    applyReasoning(payload, effort) {
      super.applyReasoning(payload, effort === 'xhigh' ? 'high' : effort);
    }

    /**
     * En el endpoint OpenAI de Gemini (/v1beta/openai), la caché es implícita en servidor.
     * No se inyecta stream_options para no causar rechazos con stream: false o endpoints estrictos.
     */
    applyContextCache(payload, options = {}) {
      // Gemini maneja context caching automáticamente a nivel de servidor.
    }

    normalizeEndpoint(rawUrl) {
      let url = (rawUrl || 'https://generativelanguage.googleapis.com/v1beta/openai').trim();
      if (url.endsWith('/')) url = url.slice(0, -1);
      if (url.endsWith('/chat/completions')) return url;
      if (url.endsWith('/v1')) return `${url}/chat/completions`;
      return `${url}/chat/completions`;
    }

    getModelEndpoints(cleanUrl) {
      const v1Url = cleanUrl.endsWith('/v1') ? cleanUrl : `${cleanUrl}/v1`;
      return [`${v1Url}/models`, `${cleanUrl}/models`];
    }

    parseModelsResponse(data) {
      if (!data) return [];
      let list = [];
      if (Array.isArray(data.data)) {
        list = data.data;
      } else if (Array.isArray(data.models)) {
        list = data.models;
      }

      return list
        .map(m => {
          let id = m.id || m.name || '';
          if (id.startsWith('models/')) id = id.substring(7);
          return {
            id: id,
            name: m.displayName || id,
            description: m.description || ''
          };
        })
        .filter(m => m.id && (m.id.includes('gemini') || m.id.includes('gemma')));
    }

    formatMessages(messages, capabilities) {
      const formatted = [];
      (messages || []).forEach(m => {
        if (!m || !m.role) return;

        if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
          const cleanToolCalls = m.tool_calls.map(tc => {
            const rawArgs = typeof tc.function?.arguments === 'string'
              ? tc.function.arguments
              : JSON.stringify(tc.function?.arguments || {});

            let safeArgs = rawArgs;
            try {
              JSON.parse(rawArgs);
            } catch (e) {
              const matches = rawArgs.match(/\{[^{}]*"[a-zA-Z0-9_]+"[^{}]*\}/g);
              if (matches && matches.length > 0) {
                try {
                  JSON.parse(matches[0]);
                  safeArgs = matches[0];
                } catch (e2) {
                  safeArgs = '{}';
                }
              } else {
                safeArgs = '{}';
              }
            }

            const out = {
              id: tc.id || `call_${Date.now()}`,
              type: 'function',
              function: {
                name: tc.function?.name || tc.name || '',
                arguments: safeArgs
              }
            };

            const sig = tc.thought_signature || tc.extra_content?.google?.thought_signature;
            if (sig) {
              out.extra_content = { google: { thought_signature: sig } };
            } else if (tc.extra_content) {
              out.extra_content = tc.extra_content;
            }

            return out;
          });

          // Regla Gemini: Un turno assistant con tool_calls NUNCA puede ir inmediatamente después de system
          const prevMsg = formatted.length > 0 ? formatted[formatted.length - 1] : null;
          if (!prevMsg || prevMsg.role === 'system') {
            formatted.push({ role: 'user', content: 'Continue' });
          }

          formatted.push({
            role: 'assistant',
            content: m.content || null,
            tool_calls: cleanToolCalls
          });
        } else if (m.role === 'tool') {
          const toolCallId = m.tool_call_id || `call_${Date.now()}`;
          const toolName = m.name || 'tool';
          const toolContent = serializeContent(m.content);

          if (!MessageTurns.hasMatchingToolCall(formatted, { tool_call_id: toolCallId, name: toolName })) {
            const prevMsg = formatted.length > 0 ? formatted[formatted.length - 1] : null;
            // Si el mensaje anterior a este asistente autogenerado es system, insertar user primero
            if (!prevMsg || prevMsg.role === 'system') {
              formatted.push({ role: 'user', content: 'Continue' });
            }
            formatted.push({
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: toolCallId,
                type: 'function',
                function: {
                  name: toolName,
                  arguments: '{}'
                }
              }]
            });
          }

          formatted.push({
            role: 'tool',
            tool_call_id: toolCallId,
            name: toolName,
            content: toolContent
          });
        } else if (m.role === 'assistant') {
          // Si el mensaje es assistant (texto) y va inmediatamente después de system, insertar user antes
          const prevMsg = formatted.length > 0 ? formatted[formatted.length - 1] : null;
          if (!prevMsg || prevMsg.role === 'system') {
            formatted.push({ role: 'user', content: 'Continue' });
          }
          formatted.push(m);
        } else if (m.role === 'user') {
          // Regla Gemini: Un turno 'user' NUNCA puede ir inmediatamente después de un turno 'tool'
          const prevMsg = formatted.length > 0 ? formatted[formatted.length - 1] : null;
          if (prevMsg && prevMsg.role === 'tool') {
            formatted.push({ role: 'assistant', content: 'Tool information received.' });
          }
          formatted.push(m);
        } else {
          formatted.push(m);
        }
      });
      return formatted;
    }

    buildPayload(params) {
      const payload = super.buildPayload(params);
      // El endpoint OpenAI de Gemini requiere el nombre del modelo sin el prefijo "models/"
      if (payload.model && payload.model.startsWith('models/')) {
        payload.model = payload.model.substring(7);
      }
      return payload;
    }
  }

  /**
   * Adaptador para Ollama (/api/chat, /api/tags).
   */
  class OllamaProviderAdapter extends BaseProviderAdapter {
    constructor() {
      super({
        id: 'ollama',
        label: 'Ollama',
        connection: { endpoint: 'http://localhost:11434' },
        reasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh'],
        capabilities: {
          streaming: true,
          vision: true,
          tools: true,
          reasoning: true,
          jsonMode: true,
          promptCaching: false,
          embeddings: true,
          modelListing: true
        }
      });
    }

    normalizeEndpoint(rawUrl) {
      let url = (rawUrl || 'http://localhost:11434').trim();
      if (url.endsWith('/')) url = url.slice(0, -1);
      if (url.endsWith('/api/chat') || url.endsWith('/chat/completions')) return url;
      if (url.endsWith('/v1')) return `${url}/chat/completions`;
      return `${url}/v1/chat/completions`;
    }

    getModelEndpoints(cleanUrl) {
      const baseWithoutV1 = cleanUrl.replace(/\/v1$/, '');
      const v1Url = cleanUrl.endsWith('/v1') ? cleanUrl : `${cleanUrl}/v1`;
      return [`${baseWithoutV1}/api/tags`, `${v1Url}/models`];
    }

    /** /api/tags no incluye las capacidades del modelo; /api/show sí. */
    getModelInfoRequest(cleanUrl, model) {
      return { url: `${cleanUrl.replace(/\/v1$/, '')}/api/show`, body: { model } };
    }

    parseModelsResponse(data) {
      if (data && Array.isArray(data.models)) {
        return data.models.map(item => {
          if (typeof item === 'string') return { id: item, name: item };
          return {
            id: item.name || item.model || item.id || '',
            name: item.name || item.model || item.id || '',
            details: item
          };
        }).filter(m => !!m.id);
      }
      return super.parseModelsResponse(data);
    }
  }

  /**
   * Adaptador para OpenRouter (https://openrouter.ai/api/v1).
   */
  class OpenRouterProviderAdapter extends BaseProviderAdapter {
    constructor() {
      super({
        id: 'openrouter',
        label: 'OpenRouter',
        connection: { endpoint: 'https://openrouter.ai/api/v1' },
        reasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh'],
        capabilities: {
          streaming: true,
          vision: true,
          tools: true,
          reasoning: true,
          jsonMode: true,
          promptCaching: true,
          embeddings: false,
          modelListing: true
        }
      });
    }

    normalizeEndpoint(rawUrl) {
      let url = (rawUrl || 'https://openrouter.ai/api/v1').trim();
      if (url.endsWith('/')) url = url.slice(0, -1);
      if (url.endsWith('/chat/completions')) return url;
      if (url.endsWith('/v1')) return `${url}/chat/completions`;
      return `${url}/v1/chat/completions`;
    }

    applyReasoning(payload, effort) {
      payload.reasoning = { effort };
      payload.reasoning_effort = effort;
    }

    applyContextCache(payload, options = {}) {
      super.applyContextCache(payload, options);
      // Inyectar cache_control con límite estricto de máximo 4 puntos efímeros (política OpenRouter / Anthropic)
      const { toolsList = [], messages = [] } = options;
      let usedBreakpoints = 0;
      const MAX_BREAKPOINTS = 4;

      // 1. Marcar la última herramienta si hay tools (1 punto)
      if (toolsList.length > 0 && usedBreakpoints < MAX_BREAKPOINTS) {
        if (!toolsList[toolsList.length - 1].cache_control) {
          toolsList[toolsList.length - 1].cache_control = { type: 'ephemeral' };
        }
        usedBreakpoints++;
      }

      // 2. Último system prompt consolidado (1 punto) y 3. último turno procesable (1 punto)
      const lastSystemIdx = messages.findLastIndex(m => m.role === 'system');
      const lastProcessableIdx = findLastProcessableIndex(messages);

      payload.messages = messages.map((m, idx) => {
        if (idx === lastSystemIdx && usedBreakpoints < MAX_BREAKPOINTS) {
          usedBreakpoints++;
          return { ...m, content: attachCacheControl(m.content) };
        }

        if (idx === lastProcessableIdx && usedBreakpoints < MAX_BREAKPOINTS) {
          usedBreakpoints++;
          return { ...m, content: attachCacheControl(m.content) };
        }

        return m;
      });
    }

    getModelEndpoints(cleanUrl) {
      const v1Url = cleanUrl.endsWith('/v1') ? cleanUrl : `${cleanUrl}/v1`;
      return [`${v1Url}/models`];
    }
  }

  /**
   * Registro central de adaptadores de proveedor (ProviderRegistry).
   */
  class MirrorProviderAdapter extends BaseProviderAdapter {
    constructor() {
      super({ id: 'mirror', label: 'Espejo', connection: { endpoint: 'mirror://local', endpointReadOnly: true, credentials: false }, capabilities: { modelListing: false, embeddings: false } });
    }

    normalizeEndpoint() { return 'mirror://local'; }

    async inspect() {
      return { success: false, error: 'Mirror is a local request preview and has no server to inspect.' };
    }
  }

  class ProviderRegistry {
    constructor() {
      this.adapters = new Map();
      this.defaultAdapter = new BaseProviderAdapter();

      // Registro inicial de adaptadores oficiales
      this.register(new BaseProviderAdapter({ id: 'openai', label: 'OpenAI / LM Studio', connection: { endpoint: 'http://localhost:1234/v1', knownEndpoints: ['https://api.openai.com/v1'] } }));
      this.register(new ClaudeProviderAdapter());
      this.register(new GeminiProviderAdapter());
      this.register(new OllamaProviderAdapter());
      this.register(new OpenRouterProviderAdapter());
      this.register(new BaseProviderAdapter({ id: 'custom', label: 'Personalizado' }));
      this.register(new MirrorProviderAdapter());
    }

    /**
     * Registra un adaptador de proveedor.
     */
    register(adapter) {
      if (adapter && adapter.id) {
        this.adapters.set(adapter.id.toLowerCase(), adapter);
      }
    }

    /**
     * Obtiene un adaptador por su ID.
     */
    get(id) {
      if (!id) return this.defaultAdapter;
      return this.adapters.get(String(id).toLowerCase()) || this.defaultAdapter;
    }

    /**
     * Detecta el proveedor adecuado a partir de la URL del servidor o tipo explícito.
     */
    detect(rawUrl, explicitType) {
      if (explicitType && explicitType !== 'auto') {
        return String(explicitType).toLowerCase();
      }
      const url = (rawUrl || '').toLowerCase().trim();
      if (url.includes('11434') || url.includes('ollama')) return 'ollama';
      if (url.includes('openrouter.ai')) return 'openrouter';
      if (url.includes('anthropic.com')) return 'claude';
      if (url.includes('googleapis.com') || url.includes('gemini')) return 'gemini';
      return 'openai';
    }

    /**
     * Resuelve y devuelve la instancia del adaptador para una URL y tipo dados.
     */
    resolve(rawUrl, explicitType) {
      const type = this.detect(rawUrl, explicitType);
      return this.get(type);
    }

    /**
     * Obtiene las capacidades de un proveedor o modelo dado.
     */
    getCapabilities(rawUrlOrType, model, explicitType) {
      const adapter = this.resolve(rawUrlOrType, explicitType);
      return adapter.getCapabilities(model);
    }

    getConnectionEndpoints() {
      return Array.from(this.adapters.values())
        .flatMap(adapter => {
          const connection = adapter.getConnectionConfig?.() || {};
          return [connection.endpoint, ...(connection.knownEndpoints || [])];
        })
        .filter(Boolean);
    }

    /**
     * Inspecciona y diagnostica el endpoint del proveedor delegando en el adaptador correspondiente.
     */
    async inspect(rawUrl, apiKey, model, explicitType, options = {}) {
      const adapter = this.resolve(rawUrl, explicitType);
      return adapter.inspect({
        ...options,
        apiUrl: rawUrl,
        apiKey: apiKey,
        model: model
      });
    }
  }

  const registry = new ProviderRegistry();

  return {
    DEFAULT_CAPABILITIES,
    BaseProviderAdapter,
    MirrorProviderAdapter,
    ClaudeProviderAdapter,
    GeminiProviderAdapter,
    OllamaProviderAdapter,
    OpenRouterProviderAdapter,
    ProviderRegistry,
    registry
  };
});
