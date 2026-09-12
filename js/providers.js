/**
 * Módulo de Adaptadores y Capacidades de Proveedores LLM (ChatProviders).
 * Separa la lógica específica de cada proveedor (OpenAI, Claude, Gemini, Ollama, OpenRouter, Custom)
 * de la capa común de transporte HTTP/SSE mediante un sistema declarativo de capacidades (Capabilities).
 * Compatible con file://, http:// y Node.js.
 */

(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.ChatProviders = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * Esquema estándar de capacidades soportadas por adaptadores de modelos LLM.
   */
  const DEFAULT_CAPABILITIES = {
    streaming: true,      // Soporte para streaming de respuestas vía SSE
    vision: true,         // Soporte para procesamiento de imágenes multimodales
    tools: true,          // Soporte para Function / Tool Calling
    reasoning: true,      // Soporte para control de razonamiento (thinking / reasoning_effort)
    jsonMode: true,       // Soporte para structured outputs / response_format: { type: "json_object" }
    promptCaching: true,  // Soporte para Context / Prompt Caching efímero o persistente
    embeddings: true,     // Soporte para endpoints de generación de embeddings
    modelListing: true    // Soporte para descubrimiento automático de modelos (/models, /api/tags)
  };

  function serializeContent(content) {
    if (typeof content === 'string') return content;
    if (content === undefined) return '';
    if (typeof content === 'object') return JSON.stringify(content);
    return String(content);
  }

  /**
   * Adaptador Base genérico (compatible con OpenAI, LM Studio, vLLM, LocalAI, DeepSeek).
   */
  class BaseProviderAdapter {
    constructor(options = {}) {
      this.id = options.id || 'openai';
      this.label = options.label || 'OpenAI / LM Studio';
      this.description = options.description || 'Estándar OpenAI / LM Studio (reasoning_effort: none, low, medium, high, xhigh)';
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
     * Aplica la configuración de razonamiento / pensamiento al payload.
     */
    applyReasoning(payload, effortLevel) {
      let effort = String(effortLevel || 'none').toLowerCase().trim();
      if (effort === 'off') effort = 'none';
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
        reasoningEffort = 'none',
        reasoningTransport = 'auto',
        toolsList = [],
        toolChoice = 'auto',
        stream = true,
        jsonMode = false
      } = params;

      const capabilities = this.getCapabilities(model);
      const formattedMessages = this.formatMessages(messages, capabilities);

      const payload = {
        model: (model || '').trim(),
        messages: formattedMessages,
        temperature: parseFloat(temperature) || 0.7
      };

      if (capabilities.streaming && stream !== false) {
        payload.stream = true;
        if (this.supportsUsageStatistics()) {
          this.requestUsageStatistics(payload, true);
        }
      }

      if (capabilities.reasoning || (reasoningTransport === 'send-none' && String(reasoningEffort).toLowerCase() === 'none')) {
        this.applyReasoning(payload, reasoningEffort);
      }

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

      if (delta) {
        // Tokens de razonamiento específicos
        const rChunk = delta.reasoning_content || delta.reasoning || delta.thinking || delta.thought || '';
        if (rChunk) {
          result.reasoningChunk = rChunk;
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

      if (usage) {
        result.usage = usage;
        if (usage.prompt_tokens_details?.cached_tokens) {
          result.cachedTokens = usage.prompt_tokens_details.cached_tokens;
        }
        if (usage.cache_read_input_tokens) {
          result.cachedTokens = usage.cache_read_input_tokens;
        }
        if (usage.cache_creation_input_tokens) {
          result.cacheCreationTokens = usage.cache_creation_input_tokens;
        }
      }

      return result;
    }

    /**
     * Evalúa si un error HTTP 400 permite auto-recuperación (reintento sin params rechazados).
     */
    handleHttpError(status, serverErrorMsg, payload) {
      const errLower = (serverErrorMsg || '').toLowerCase();

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
     * Devuelve metadatos para la configuración de razonamiento.
     */
    getReasoningConfig() {
      return {
        type: this.id,
        label: this.label,
        levels: this.reasoningLevels,
        transportOptions: this.capabilities.reasoning ? [] : ['omit', 'send-none'],
        description: this.description
      };
    }

    /**
     * Inspecciona y diagnostica el endpoint del proveedor para determinar sus capacidades reales.
     * Distingue entre:
     * - 'declared': Declarada por el ProviderAdapter.
     * - 'inferred': Inferida por heurística de nombres de modelos / endpoints.
     * - 'confirmed': Comprobada mediante una prueba HTTP/SSE activa ultra-ligera (max_tokens: 1).
     * - 'unsupported': Rechazada explícitamente o no soportada.
     * - 'unknown': No determinada.
     */
    async inspect(params = {}) {
      const {
        apiUrl = '',
        apiKey = '',
        model = '',
        runProbes = true,
        timeoutMs = 6000
      } = params;

      const startTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const normalizedEndpoint = this.normalizeEndpoint(apiUrl);
      let cleanBase = (apiUrl || '').trim().replace(/\/+$/, '');
      if (cleanBase.endsWith('/chat/completions')) cleanBase = cleanBase.replace(/\/chat\/completions$/, '');

      const adapterCaps = this.getCapabilities(model);

      // 1. Inicializar matriz de capacidades con el estado 'declared' o 'unsupported' según el adaptador
      const capabilities = {
        streaming: {
          status: adapterCaps.streaming ? 'declared' : 'unsupported',
          detail: adapterCaps.streaming ? 'Declarada en el adaptador' : 'No soportada según adaptador',
          source: 'adapter'
        },
        tools: {
          status: adapterCaps.tools ? 'declared' : 'unsupported',
          detail: adapterCaps.tools ? 'Declarada en el adaptador' : 'No soportada según adaptador',
          source: 'adapter'
        },
        vision: {
          status: adapterCaps.vision ? 'declared' : 'unsupported',
          detail: adapterCaps.vision ? 'Declarada en el adaptador' : 'No soportada según adaptador',
          source: 'adapter'
        },
        reasoning: {
          status: adapterCaps.reasoning ? 'declared' : 'unsupported',
          detail: adapterCaps.reasoning ? 'Declarada en el adaptador' : 'No soportada según adaptador',
          source: 'adapter'
        },
        jsonMode: {
          status: adapterCaps.jsonMode ? 'declared' : 'unsupported',
          detail: adapterCaps.jsonMode ? 'Declarada en el adaptador' : 'No soportada según adaptador',
          source: 'adapter'
        },
        promptCaching: {
          status: adapterCaps.promptCaching ? 'declared' : 'unknown',
          detail: adapterCaps.promptCaching ? 'Declarada en el adaptador' : 'Soporte no determinado',
          source: 'adapter'
        },
        embeddings: {
          status: adapterCaps.embeddings ? 'declared' : 'unknown',
          detail: adapterCaps.embeddings ? 'Declarada en el adaptador' : 'Soporte no determinado',
          source: 'adapter'
        },
        modelListing: {
          status: adapterCaps.modelListing ? 'declared' : 'unsupported',
          detail: adapterCaps.modelListing ? 'Declarada en el adaptador' : 'No soportada según adaptador',
          source: 'adapter'
        }
      };

      let discoveredModels = [];
      let modelListSuccess = false;
      let connectionAttempted = false;
      let connectionSuccess = false;
      let authError = null;
      let lastNetworkError = null;
      let lastHttpStatus = null;

      // 2. Comprobar listado de modelos y realizar inferencias
      const modelEndpoints = this.getModelEndpoints(cleanBase);
      const headers = this.buildHeaders(apiKey);

      if (runProbes && typeof fetch === 'function') {
        for (const endpoint of modelEndpoints) {
          connectionAttempted = true;
          let timer = null;
          try {
            const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
            if (controller) {
              timer = setTimeout(() => controller.abort(), timeoutMs);
              if (typeof timer?.unref === 'function') timer.unref();
            }
            const res = await fetch(endpoint, {
              method: 'GET',
              headers: { Accept: 'application/json', ...headers },
              signal: controller ? controller.signal : undefined
            });

            lastHttpStatus = res.status;
            if (res.ok) {
              connectionSuccess = true;
              const data = await res.json();
              const parsed = this.parseModelsResponse(data);
              if (Array.isArray(parsed) && parsed.length > 0) {
                discoveredModels = parsed;
                modelListSuccess = true;
                capabilities.modelListing = {
                  status: 'confirmed',
                  detail: `${parsed.length} modelo(s) descubierto(s) en ${endpoint}`,
                  source: 'probe'
                };
                break;
              }
            } else if (res.status === 401 || res.status === 403) {
              authError = `Error de autenticación (HTTP ${res.status}): Clave de API no válida o acceso denegado.`;
            }
          } catch (e) {
            lastNetworkError = e;
          } finally {
            if (timer) clearTimeout(timer);
          }
        }
      }

      if (!modelListSuccess && adapterCaps.modelListing) {
        capabilities.modelListing = {
          status: 'unknown',
          detail: 'No se pudo consultar el listado de modelos en los endpoints estándar',
          source: 'probe'
        };
      }

      // Inferencias por nombre de modelo seleccionado o lista de modelos descubiertos
      const targetModel = (model || (discoveredModels[0] && discoveredModels[0].id) || '').toLowerCase();
      const allModelNames = discoveredModels.map(m => (m.id || m.name || '').toLowerCase()).join(' ');
      const combinedModelContext = (targetModel + ' ' + allModelNames).trim();

      if (combinedModelContext) {
        // Inferencia de Visión
        if (/(?:-vl|-vision|vision|4o|sonnet|opus|flash|pixtral|llava|cogvlm|gemini|qwen.*vl)/i.test(combinedModelContext)) {
          capabilities.vision = {
            status: 'inferred',
            detail: 'Inferida por identificador multimodal detectado en los modelos',
            source: 'model_name'
          };
        }

        // Inferencia de Razonamiento
        if (/(?:-r1|r1|qwq|o1|o3|reasoning|thinking|gemma-4|deepseek)/i.test(combinedModelContext)) {
          capabilities.reasoning = {
            status: 'inferred',
            detail: 'Inferida por identificador de modelo con razonamiento/pensamiento',
            source: 'model_name'
          };
        }

        // Inferencia de Embeddings
        if (/(?:embedding|embed|bge|nomic|e5|text-embedding)/i.test(combinedModelContext)) {
          capabilities.embeddings = {
            status: 'inferred',
            detail: 'Inferida por modelos de embeddings presentes en el catálogo',
            source: 'model_name'
          };
        }
      }

      // 3. Pruebas activas controladas (Micro-sondas seguras con max_tokens: 1)
      const probeModel = model || (discoveredModels[0] && discoveredModels[0].id) || '';
      let probesRun = false;

      if (runProbes && typeof fetch === 'function') {
        probesRun = true;

        // Micro-sonda A: Streaming & Chat básico
        connectionAttempted = true;
        let timerA = null;
        try {
          const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
          if (controller) {
            timerA = setTimeout(() => controller.abort(), timeoutMs);
            if (typeof timerA?.unref === 'function') timerA.unref();
          }
          
          const probePayload = this.buildPayload({
            model: probeModel,
            messages: [{ role: 'user', content: 'hi' }],
            stream: true,
            temperature: 0.1,
            reasoningEffort: 'none'
          });
          probePayload.max_tokens = 1;

          const res = await fetch(normalizedEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify(probePayload),
            signal: controller ? controller.signal : undefined
          });

          lastHttpStatus = res.status;
          if (res.ok) {
            connectionSuccess = true;
            const contentType = res.headers && res.headers.get ? (res.headers.get('content-type') || '') : '';
            if (contentType.includes('event-stream') || res.body) {
              capabilities.streaming = {
                status: 'confirmed',
                detail: 'Respuesta de streaming SSE (HTTP 200) verificada exitosamente',
                source: 'probe'
              };
            }
          } else if (res.status === 401 || res.status === 403) {
            authError = `Error de autenticación (HTTP ${res.status}): Clave de API no válida o acceso denegado.`;
          } else if (res.status === 400 || res.status === 422) {
            connectionSuccess = true;
            const errText = await res.text().catch(() => '');
            if (errText.toLowerCase().includes('stream')) {
              capabilities.streaming = {
                status: 'unsupported',
                detail: `Servidor rechazó streaming: ${errText.substring(0, 80)}`,
                source: 'probe'
              };
            }
          }
        } catch (probeErr) {
          lastNetworkError = probeErr;
        } finally {
          if (timerA) clearTimeout(timerA);
        }

        // Micro-sonda B: Tools / Function Calling
        connectionAttempted = true;
        let timerB = null;
        try {
          const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
          if (controller) {
            timerB = setTimeout(() => controller.abort(), timeoutMs);
            if (typeof timerB?.unref === 'function') timerB.unref();
          }

          const toolPayload = this.buildPayload({
            model: probeModel,
            messages: [{ role: 'user', content: 'hi' }],
            stream: false,
            toolsList: [{
              type: 'function',
              function: {
                name: 'ping_test',
                description: 'Inspector ping test',
                parameters: { type: 'object', properties: {} }
              }
            }]
          });
          toolPayload.max_tokens = 1;
          toolPayload.tool_choice = 'none';

          const res = await fetch(normalizedEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify(toolPayload),
            signal: controller ? controller.signal : undefined
          });

          lastHttpStatus = res.status;
          if (res.ok) {
            connectionSuccess = true;
            capabilities.tools = {
              status: 'confirmed',
              detail: 'El servidor aceptó el esquema de tools/functions (HTTP 200)',
              source: 'probe'
            };
          } else if (res.status === 401 || res.status === 403) {
            authError = `Error de autenticación (HTTP ${res.status}): Clave de API no válida o acceso denegado.`;
          } else if (res.status === 400 || res.status === 422) {
            connectionSuccess = true;
            const errText = await res.text().catch(() => '');
            if (errText.toLowerCase().includes('tool') || errText.toLowerCase().includes('function') || errText.toLowerCase().includes('schema')) {
              capabilities.tools = {
                status: 'unsupported',
                detail: `Servidor rechazó tools: ${errText.substring(0, 80)}`,
                source: 'probe'
              };
            }
          }
        } catch (e) {
          lastNetworkError = e;
        } finally {
          if (timerB) clearTimeout(timerB);
        }

        // Micro-sonda C: JSON Mode
        connectionAttempted = true;
        let timerC = null;
        try {
          const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
          if (controller) {
            timerC = setTimeout(() => controller.abort(), timeoutMs);
            if (typeof timerC?.unref === 'function') timerC.unref();
          }

          const jsonPayload = this.buildPayload({
            model: probeModel,
            messages: [{ role: 'user', content: 'hi' }],
            stream: false,
            jsonMode: true
          });
          jsonPayload.max_tokens = 1;

          const res = await fetch(normalizedEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify(jsonPayload),
            signal: controller ? controller.signal : undefined
          });

          lastHttpStatus = res.status;
          if (res.ok) {
            connectionSuccess = true;
            capabilities.jsonMode = {
              status: 'confirmed',
              detail: 'El servidor aceptó response_format: json_object (HTTP 200)',
              source: 'probe'
            };
          } else if (res.status === 401 || res.status === 403) {
            authError = `Error de autenticación (HTTP ${res.status}): Clave de API no válida o acceso denegado.`;
          } else if (res.status === 400 || res.status === 422) {
            connectionSuccess = true;
            const errText = await res.text().catch(() => '');
            if (errText.toLowerCase().includes('response_format') || errText.toLowerCase().includes('json')) {
              capabilities.jsonMode = {
                status: 'unsupported',
                detail: `Servidor rechazó json_object: ${errText.substring(0, 80)}`,
                source: 'probe'
              };
            }
          }
        } catch (e) {
          lastNetworkError = e;
        } finally {
          if (timerC) clearTimeout(timerC);
        }

        // Micro-sonda D: Embeddings endpoint check
        let timerD = null;
        try {
          const embUrl = cleanBase.endsWith('/v1') ? `${cleanBase}/embeddings` : `${cleanBase}/v1/embeddings`;
          const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
          if (controller) {
            timerD = setTimeout(() => controller.abort(), timeoutMs);
            if (typeof timerD?.unref === 'function') timerD.unref();
          }

          const res = await fetch(embUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify({ input: 'ping', model: probeModel }),
            signal: controller ? controller.signal : undefined
          });

          if (res.ok) {
            connectionSuccess = true;
            capabilities.embeddings = {
              status: 'confirmed',
              detail: `Endpoint ${embUrl} responde correctamente (HTTP 200)`,
              source: 'probe'
            };
          } else if (res.status === 404) {
            capabilities.embeddings = {
              status: 'unsupported',
              detail: `Endpoint ${embUrl} no encontrado (404)`,
              source: 'probe'
            };
          } else if (res.status === 401 || res.status === 403) {
            authError = `Error de autenticación (HTTP ${res.status}): Clave de API no válida o acceso denegado.`;
          } else if (res.status === 400 || res.status === 422) {
            connectionSuccess = true;
          }
        } catch (e) {} finally {
          if (timerD) clearTimeout(timerD);
        }
      }

      const endTime = typeof performance !== 'undefined' ? performance.now() : Date.now();

      // Si se intentó conectar mediante sondas y ninguna tuvo éxito, informar fallo de conexión
      if (runProbes && connectionAttempted && !connectionSuccess) {
        let errorMsg;
        if (authError) {
          errorMsg = authError;
        } else if (lastNetworkError) {
          const netMsg = lastNetworkError.message || String(lastNetworkError);
          errorMsg = `Error de conexión: No se pudo conectar con el servidor en ${normalizedEndpoint} (${netMsg}). Verifica que el servidor esté activo y la URL sea correcta.`;
        } else if (lastHttpStatus) {
          errorMsg = `Error de conexión: El servidor respondió con error HTTP ${lastHttpStatus} en ${normalizedEndpoint}. Verifica el endpoint y la configuración.`;
        } else {
          errorMsg = `Error de conexión: No se pudo establecer comunicación con el servidor en ${normalizedEndpoint}.`;
        }

        Object.keys(capabilities).forEach(k => {
          capabilities[k] = {
            status: 'unknown',
            detail: 'No comprobada: fallo de conexión con el servidor',
            source: 'probe'
          };
        });

        return {
          success: false,
          connected: false,
          error: errorMsg,
          provider: {
            id: this.id,
            label: this.label,
            description: this.description
          },
          endpoint: {
            raw: apiUrl,
            normalized: normalizedEndpoint,
            base: cleanBase
          },
          model: {
            selected: probeModel,
            totalDiscovered: 0,
            discovered: []
          },
          capabilities: capabilities,
          probesRun: true,
          inspectionTimeMs: Math.round(endTime - startTime)
        };
      }

      // Devolver resultado estructurado de la inspección SIN apiKey
      return {
        success: true,
        connected: runProbes ? true : null,
        provider: {
          id: this.id,
          label: this.label,
          description: this.description
        },
        endpoint: {
          raw: apiUrl,
          normalized: normalizedEndpoint,
          base: cleanBase
        },
        model: {
          selected: probeModel,
          totalDiscovered: discoveredModels.length,
          discovered: discoveredModels
        },
        capabilities: capabilities,
        probesRun: probesRun,
        inspectionTimeMs: Math.round(endTime - startTime)
      };
    }
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
        description: 'Estándar Claude (thinking budget: disabled, 1k, 2k, 4k, 8k tokens)',
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

    formatMessages(messages, capabilities) {
      const caps = capabilities || this.getCapabilities();
      return messages.map(m => {
        if (Array.isArray(m.content)) {
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
          }).filter(part => caps.vision || part.type !== 'image');
          return { ...m, content: claudeParts };
        }
        return m;
      });
    }

    buildPayload(params) {
      const {
        model = '',
        messages = [],
        temperature = 0.7,
        reasoningEffort = 'none',
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

      const payload = {
        model: (model || '').trim(),
        messages: nonSystemMessages,
        temperature: parseFloat(temperature) || 0.7,
        max_tokens: 4096
      };

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

      if (capabilities.reasoning) {
        this.applyReasoning(payload, reasoningEffort);
      }

      if (capabilities.tools && toolsList && toolsList.length > 0) {
        payload.tools = toolsList.map(t => {
          if (t.type === 'function' && t.function) {
            return {
              name: t.function.name,
              description: t.function.description || '',
              input_schema: t.function.parameters || { type: 'object', properties: {} }
            };
          }
          return t;
        });
        if (capabilities.promptCaching && payload.tools.length > 0) {
          payload.tools[payload.tools.length - 1].cache_control = { type: 'ephemeral' };
        }
      }

      if (capabilities.promptCaching) {
        this.applyContextCache(payload, { toolsList, messages: nonSystemMessages });
      }

      return payload;
    }

    applyReasoning(payload, effortLevel) {
      let effort = String(effortLevel || 'none').toLowerCase().trim();
      if (effort === 'off') effort = 'none';

      if (effort !== 'none') {
        let budget = 2048;
        if (effort === 'low' || effort === 'minimal') budget = 1024;
        else if (effort === 'medium') budget = 2048;
        else if (effort === 'high') budget = 4096;
        else if (effort === 'xhigh') budget = 8192;

        payload.thinking = {
          type: 'enabled',
          budget_tokens: budget
        };
        payload.temperature = 1.0;
        payload.max_tokens = Math.max(4096, budget + 1024);
      } else {
        payload.thinking = { type: 'disabled' };
      }
    }

    applyContextCache(payload, options = {}) {
      const { toolsList = [], messages = [] } = options;

      if (toolsList.length > 0 && !toolsList[toolsList.length - 1].cache_control) {
        toolsList[toolsList.length - 1].cache_control = { type: 'ephemeral' };
      }

      // Localizar el último turno procesable (user o tool) para anclar el punto dinámico de caché
      let lastProcessableIdx = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user' || messages[i].role === 'tool') {
          lastProcessableIdx = i;
          break;
        }
      }

      payload.messages = messages.map((m, idx) => {
        if (m.role === 'system') {
          if (typeof m.content === 'string') {
            return {
              ...m,
              content: [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }]
            };
          } else if (Array.isArray(m.content) && m.content.length > 0) {
            const updated = [...m.content];
            updated[updated.length - 1] = {
              ...updated[updated.length - 1],
              cache_control: { type: 'ephemeral' }
            };
            return { ...m, content: updated };
          }
        }

        if (idx === lastProcessableIdx) {
          if (typeof m.content === 'string') {
            return {
              ...m,
              content: [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }]
            };
          } else if (Array.isArray(m.content) && m.content.length > 0) {
            const updated = [...m.content];
            updated[updated.length - 1] = {
              ...updated[updated.length - 1],
              cache_control: { type: 'ephemeral' }
            };
            return { ...m, content: updated };
          }
        }

        return m;
      });
    }

    parseStreamChunk(parsed, state) {
      const result = {
        textChunk: '',
        reasoningChunk: '',
        toolCallDeltas: [],
        usage: null,
        cachedTokens: 0,
        cacheCreationTokens: 0
      };

      if (parsed.type === 'message_start' && parsed.message?.usage) {
        result.usage = parsed.message.usage;
        if (parsed.message.usage.cache_read_input_tokens) {
          result.cachedTokens = parsed.message.usage.cache_read_input_tokens;
        }
        if (parsed.message.usage.cache_creation_input_tokens) {
          result.cacheCreationTokens = parsed.message.usage.cache_creation_input_tokens;
        }
      }

      if (parsed.type === 'message_delta' && parsed.usage) {
        result.usage = parsed.usage;
      }

      if (parsed.type === 'content_block_delta') {
        if (parsed.delta?.type === 'thinking_delta' && parsed.delta?.thinking) {
          result.reasoningChunk = parsed.delta.thinking;
        } else if (parsed.delta?.type === 'text_delta' && parsed.delta?.text) {
          result.textChunk = parsed.delta.text;
        }
      }

      // Fallback a formato choices por si OpenRouter sirve Claude en formato OpenAI
      if (parsed.choices?.[0] || parsed.usage) {
        const baseRes = super.parseStreamChunk(parsed, state);
        if (baseRes.textChunk) result.textChunk = baseRes.textChunk;
        if (baseRes.reasoningChunk) result.reasoningChunk = baseRes.reasoningChunk;
        if (baseRes.toolCallDeltas.length > 0) result.toolCallDeltas = baseRes.toolCallDeltas;
        if (baseRes.cachedTokens > 0) result.cachedTokens = baseRes.cachedTokens;
        if (baseRes.cacheCreationTokens > 0) result.cacheCreationTokens = baseRes.cacheCreationTokens;
        if (baseRes.usage && !result.usage) result.usage = baseRes.usage;
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
        description: 'Google Gemini (OpenAI compatible endpoint)',
        reasoningLevels: ['none'],
        capabilities: {
          streaming: true,
          vision: true,
          tools: true,
          reasoning: false,
          jsonMode: true,
          promptCaching: true,
          embeddings: true,
          modelListing: true
        }
      });
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

          // Validar que el mensaje previo sea un assistant con la llamada correspondiente
          let prevMsg = formatted.length > 0 ? formatted[formatted.length - 1] : null;
          const hasMatchingToolCall = prevMsg && prevMsg.role === 'assistant' && Array.isArray(prevMsg.tool_calls) &&
            prevMsg.tool_calls.some(tc => tc.id === toolCallId || (tc.function && tc.function.name === toolName));

          if (!hasMatchingToolCall) {
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
        description: 'Estándar Ollama (reasoning_effort: none, low, medium, high, xhigh)',
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
        description: 'Estándar OpenRouter (reasoning.effort: none, low, medium, high, xhigh)',
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

    applyReasoning(payload, effortLevel) {
      let effort = String(effortLevel || 'none').toLowerCase().trim();
      if (effort === 'off') effort = 'none';
      payload.reasoning = { effort: effort };
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

      // 2. Identificar el último system prompt consolidado (1 punto)
      let lastSystemIdx = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'system') {
          lastSystemIdx = i;
          break;
        }
      }

      // 3. Identificar el último turno procesable (user o tool) (1 punto)
      let lastProcessableIdx = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user' || messages[i].role === 'tool') {
          lastProcessableIdx = i;
          break;
        }
      }

      function attachCacheControl(content) {
        if (typeof content === 'string') {
          return [{ type: 'text', text: content, cache_control: { type: 'ephemeral' } }];
        } else if (Array.isArray(content) && content.length > 0) {
          const updated = [...content];
          const lastItem = updated[updated.length - 1];
          updated[updated.length - 1] = {
            ...lastItem,
            cache_control: { type: 'ephemeral' }
          };
          return updated;
        }
        return content;
      }

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

    /**
     * Obtiene todos los modos de razonamiento registrados para la UI.
     */
    getReasoningModes() {
      const modes = {};
      for (const [id, adapter] of this.adapters.entries()) {
        modes[id] = adapter.getReasoningConfig();
      }
      return modes;
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
