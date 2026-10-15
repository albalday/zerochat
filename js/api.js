/**
 * Módulo para interactuar con la API compatible de OpenAI, Claude, Gemini, Ollama y OpenRouter (ChatAPI).
 * Actúa como orquestador común de transporte HTTP/SSE delegando las particularidades en los adaptadores (ChatProviders).
 * Compatible con file://, http:// y Node.js.
 */

(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./utils.js'), require('./i18n.js'));
  } else {
    root.ChatAPI = factory(root.ChatUtils, root.ChatI18n);
  }
})(typeof self !== 'undefined' ? self : this, function (Utils, I18n) {
  'use strict';

  const { resolveDep } = Utils;

  const { registry } = resolveDep('ChatProviders', './providers.js');
  const TextToolCalls = resolveDep('ChatTextToolCalls', './text-tool-calls.js');

  /** Error que el servidor envía dentro del streaming, después de haber respondido 200. */
  class StreamServerError extends Error {
    constructor(serverMessage) {
      super(`The server reported an error during the response: ${serverMessage}`);
      this.name = 'StreamServerError';
      this.serverMessage = serverMessage;
    }
  }

  function mirrorResponse(payload) {
    const i18n = I18n;
    const guidance = [
      i18n.t('mirror_response_intro'),
      i18n.t('mirror_response_about'),
      i18n.t('mirror_response_profile'),
      i18n.t('mirror_response_webllm'),
      i18n.t('mirror_response_request')
    ].join('\n\n');
    return `${guidance}\n\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``;
  }

  function getContextManager() {
    return resolveDep('ChatContextManager', './context-manager.js');
  }

  /**
   * Estimación aproximada de tokens para textos, delegada en ChatContextManager.
   */
  function estimateTokens(text, chunkCount) {
    if (!text) return 0;
    const estimated = getContextManager().estimateTextTokens(text);
    return chunkCount > 0 ? Math.max(chunkCount, estimated) : estimated;
  }

  /**
   * Consulta los modelos disponibles en el servidor delegando en el adaptador.
   */
  async function fetchServerModels(rawUrl, apiKey, explicitType) {
    const resolvedApiKey = String(apiKey || '').trim();
    let cleanUrl = (rawUrl || 'http://localhost:1234/v1').trim();
    if (cleanUrl.endsWith('/')) cleanUrl = cleanUrl.slice(0, -1);
    if (cleanUrl.endsWith('/chat/completions')) cleanUrl = cleanUrl.replace(/\/chat\/completions$/, '');

    const adapter = registry.resolve(cleanUrl, explicitType);
    if (adapter.getCapabilities().modelListing === false) {
      return {
        success: false,
        error: 'The configured provider does not support model discovery.'
      };
    }
    if (typeof adapter.listModels === 'function') {
      return adapter.listModels();
    }
    const candidateEndpoints = adapter.getModelEndpoints(cleanUrl);

    const headers = { ...adapter.buildHeaders(resolvedApiKey), Accept: 'application/json' };

    let lastError = null;

    for (const endpoint of candidateEndpoints) {
      let timeoutId = null;
      try {
        const controller = new AbortController();
        timeoutId = setTimeout(() => controller.abort(), 8000);

        const response = await fetch(endpoint, {
          method: 'GET',
          headers: headers,
          signal: controller.signal
        });

        if (!response.ok) {
          lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);
          continue;
        }

        const data = await response.json();
        const extractedModels = adapter.parseModelsResponse(data);

        if (extractedModels && extractedModels.length > 0) {
          extractedModels.sort((a, b) => a.id.localeCompare(b.id));
          return {
            success: true,
            endpoint: endpoint,
            models: extractedModels,
            count: extractedModels.length,
            raw: data
          };
        }
      } catch (err) {
        lastError = err;
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    }

    return {
      success: false,
      error: lastError ? (lastError.message || String(lastError)) : 'Could not get the model list from the queried endpoints.'
    };
  }

  async function downloadLocalModel(model, onProgress, providerId = 'webllm') {
    const adapter = registry.get(providerId);
    if (typeof adapter.downloadModel !== 'function') {
      throw new Error('The configured provider does not support local model downloads.');
    }
    return adapter.downloadModel(model, onProgress);
  }

  async function deleteLocalModel(model, providerId = 'webllm') {
    const adapter = registry.get(providerId);
    if (typeof adapter.deleteModel !== 'function') {
      throw new Error('The configured provider does not support deleting local models.');
    }
    return adapter.deleteModel(model);
  }

  async function cancelLocalModelOperation(model, providerId = 'webllm') {
    const adapter = registry.get(providerId);
    if (typeof adapter.cancelModelOperation !== 'function') return;
    return adapter.cancelModelOperation(model);
  }

  function streamResult({
    accumulatedText = '',
    accumulatedReasoning = '',
    reasoningReplay = null,
    stats = null,
    toolCalls = null,
    truncated = false,
    recoveredReason = ''
  } = {}) {
    return { accumulatedText, accumulatedReasoning, reasoningReplay, stats, toolCalls, truncated, recoveredReason };
  }

  /**
   * Orquestador común de streaming HTTP/SSE. Devuelve { accumulatedText, accumulatedReasoning,
   * reasoningReplay, stats, toolCalls, truncated, recoveredReason }, también al cancelar (con lo recibido hasta entonces); un
   * error se entrega a onError y devuelve null.
   */
  async function streamChatCompletion(params) {
    const {
      apiUrl,
      apiType,
      apiKey,
      model,
      messages,
      temperature = 0.7,
      reasoningEffort = 'medium',
      toolChoice = 'auto',
      signal,
      onBeforeRequest,
      onChunk,
      onReasoningChunk,
      onGenerationStatus,
      onToolCallDelta,
      onLog,
      onError
    } = params;

    const effectiveApiKey = String(apiKey || '').trim();

    const adapter = registry.resolve(apiUrl, apiType);
    const endpoint = adapter.normalizeEndpoint(apiUrl);
    const detectedType = adapter.id;
    const headers = adapter.buildHeaders(effectiveApiKey);

    const toolsList = params.tools || [];
    const payload = adapter.buildPayload({
      model,
      messages,
      temperature,
      reasoningEffort,
      toolsList,
      toolChoice: toolChoice || 'auto'
    });

    if (onBeforeRequest) {
      try {
        const debugResult = await onBeforeRequest({ endpoint, headers, payload });
        if (debugResult && debugResult.cancel) {
          onLog?.({ type: 'info', text: 'Request cancelled by the user in the message debugger.' });
          onError?.(new Error('Request cancelled in the message debugger.'));
          return null;
        }
        if (debugResult && debugResult.modifiedPayload) {
          Object.keys(payload).forEach(k => delete payload[k]);
          Object.assign(payload, debugResult.modifiedPayload);
        }
      } catch (err) {
        console.warn('[ChatAPI] onBeforeRequest failed:', err);
      }
    }

    if (signal?.aborted) {
      return streamResult();
    }

    if (detectedType === 'mirror') {
      const accumulatedText = mirrorResponse(payload);
      const stats = {
        ttftSec: '0.00', generationSec: '0.00', totalSec: '0.00',
        tokens: estimateTokens(accumulatedText, 1), tokensPerSec: '0.0',
        cachedTokens: 0, cacheCreationTokens: 0, promptTokens: 0,
        completionTokens: 0, totalTokens: 0, reasoningTokens: 0, isEstimated: true
      };
      if (onLog) {
        onLog({ type: 'network', text: `MIRROR POST ${endpoint} [OPENAI] | The request was not sent.` });
        onLog({ type: 'raw', subtype: 'outgoing', text: `>>> MIRROR POST ${endpoint}\n${accumulatedText}` });
      }
      if (onChunk) onChunk(accumulatedText, accumulatedText, stats);
      return streamResult({ accumulatedText, stats });
    }

    if (onLog) {
      onLog({
        type: 'network',
        text: `POST ${endpoint} [${detectedType.toUpperCase()}] | Model: ${model || '(none)'} | Reasoning: ${reasoningEffort || 'off'} | Temp: ${payload.temperature ?? '-'}`
      });
      onLog({
        type: 'raw',
        subtype: 'outgoing',
        text: `>>> OUTGOING POST ${endpoint}\n${JSON.stringify(payload, null, 2)}`
      });
    }

    let accumulatedText = '';
    let accumulatedReasoning = '';
    // Razonamiento recibido en un campo propio del delta; el agente lo reenvía dentro del turno.
    let replayReasoning = '';
    let replayReasoningField = '';
    // Firma con la que la Messages API valida el bloque thinking reenviado; puede llegar vacía.
    let replaySignature = null;
    const getReasoningReplay = () => {
      if (!replayReasoningField || !replayReasoning) return null;
      const replay = { field: replayReasoningField, text: replayReasoning };
      if (replaySignature !== null) replay.signature = replaySignature;
      return replay;
    };
    // El servidor cortó la respuesta en el límite de tokens de salida.
    let truncated = false;
    // Parámetro que el servidor rechazó y sin el que se repitió la petición.
    let recoveredReason = '';
    let accumulatedToolCalls = {};
    let chunkCount = 0;
    let activeReasoningTag = null;
    let serverCachedTokens = 0;
    let serverCacheCreationTokens = 0;
    let serverPromptTokens = 0;
    let serverCompletionTokens = 0;
    let serverTotalTokens = 0;
    let serverReasoningTokens = 0;
    const requestStartTime = performance.now();
    let firstTokenTime = null;
    let generationStatus = { phase: '', percent: null, detail: '' };
    function publishGenerationStatus(update = {}) {
      const next = { ...generationStatus, ...update };
      if (next.phase === generationStatus.phase && next.percent === generationStatus.percent && next.detail === generationStatus.detail) return;
      generationStatus = next;
      onGenerationStatus?.(next);
    }
    publishGenerationStatus({ phase: 'connecting' });

    function getStats() {
      const now = performance.now();
      const totalElapsedSec = ((now - requestStartTime) / 1000).toFixed(2);
      const isEstimated = serverCompletionTokens <= 0;
      const tokens = serverCompletionTokens > 0
        ? serverCompletionTokens
        : estimateTokens(accumulatedText + accumulatedReasoning, chunkCount);

      if (firstTokenTime) {
        const ttftSec = ((firstTokenTime - requestStartTime) / 1000).toFixed(2);
        const generationElapsedMs = Math.max(now - firstTokenTime, 10);
        const generationElapsedSec = generationElapsedMs / 1000;
        const tokensPerSec = tokens > 0 ? (tokens / generationElapsedSec).toFixed(1) : '0.0';

        return {
          ttftSec: ttftSec,
          generationSec: generationElapsedSec.toFixed(2),
          totalSec: totalElapsedSec,
          tokens: tokens,
          tokensPerSec: tokensPerSec,
          cachedTokens: serverCachedTokens,
          cacheCreationTokens: serverCacheCreationTokens,
          promptTokens: serverPromptTokens,
          completionTokens: serverCompletionTokens,
          totalTokens: serverTotalTokens,
          reasoningTokens: serverReasoningTokens,
          isEstimated: isEstimated
        };
      } else {
        return {
          ttftSec: totalElapsedSec,
          generationSec: '0.00',
          totalSec: totalElapsedSec,
          tokens: tokens,
          tokensPerSec: '0.0',
          cachedTokens: serverCachedTokens,
          cacheCreationTokens: serverCacheCreationTokens,
          promptTokens: serverPromptTokens,
          completionTokens: serverCompletionTokens,
          totalTokens: serverTotalTokens,
          reasoningTokens: serverReasoningTokens,
          isEstimated: isEstimated
        };
      }
    }

    // Con herramientas activas, los bloques <tool_call> del texto se ocultan y se
    // interpretan como llamadas si el proveedor no devolvió llamadas nativas.
    const parsesTextToolCalls = toolsList.length > 0;
    let textToolCalls = null;
    let lastVisibleText = '';

    function emitText(piece) {
      accumulatedText += piece;
      chunkCount++;
      if (!onChunk) return;
      if (!parsesTextToolCalls) {
        onChunk(accumulatedText, piece, getStats());
        return;
      }
      const previousVisible = lastVisibleText;
      lastVisibleText = TextToolCalls.visibleText(accumulatedText);
      if (lastVisibleText === previousVisible) return;
      onChunk(lastVisibleText, lastVisibleText.startsWith(previousVisible) ? lastVisibleText.slice(previousVisible.length) : lastVisibleText, getStats());
    }

    function getFinalToolCalls() {
      const callIndices = Object.keys(accumulatedToolCalls);
      if (callIndices.length > 0) {
        return callIndices.map(idx => accumulatedToolCalls[idx]);
      }
      if (parsesTextToolCalls) {
        if (textToolCalls) return textToolCalls;
        const extracted = TextToolCalls.extractToolCalls(accumulatedText);
        if (extracted.toolCalls) {
          accumulatedText = extracted.text;
          textToolCalls = extracted.toolCalls;
          if (onLog) onLog({ type: 'info', text: `Tool calls extracted from the text: ${textToolCalls.map(call => call.function.name).join(', ')}` });
        } else {
          // Igual que durante el streaming: un bloque <tool_call> inválido o sin cerrar no se muestra.
          const visible = TextToolCalls.visibleText(accumulatedText).trim();
          if (visible !== accumulatedText.trim() && onLog) {
            onLog({ type: 'warning', text: 'Invalid <tool_call> block removed from the response.' });
          }
          accumulatedText = visible;
        }
        return textToolCalls;
      }
      return null;
    }

    function buildResult() {
      // Las llamadas en texto se extraen antes porque recortan accumulatedText.
      const toolCalls = getFinalToolCalls();
      return streamResult({ accumulatedText, accumulatedReasoning, reasoningReplay: getReasoningReplay(), stats: getStats(), toolCalls, truncated, recoveredReason });
    }

    try {
      let response = adapter.createStreamResponse
        ? await adapter.createStreamResponse({
          payload,
          signal,
          onProgress: progress => {
            publishGenerationStatus(progress);
            onLog?.({ type: 'info', text: `${adapter.label || adapter.id}: ${String(progress?.detail || progress?.phase || 'preparing')}` });
          }
        })
        : await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(payload), signal });

      if (!response.ok) {
        let serverErrorMsg = '';
        try {
          const rawError = await response.text();
          try {
            const errorJson = JSON.parse(rawError);
            serverErrorMsg = (errorJson && (errorJson.error?.message || errorJson.message || errorJson.error)) || rawError;
          } catch (jsonErr) {
            serverErrorMsg = rawError;
          }
        } catch (readErr) {
          serverErrorMsg = response.statusText;
        }

        // Auto-recuperación delegando en el adaptador
        const recovery = adapter.handleHttpError(response.status, serverErrorMsg, payload);
        if (recovery && recovery.retry) {
          recoveredReason = recovery.reason || '';
          if (onLog) {
            onLog({
              type: 'error',
              text: `HTTP 400: the server rejected a parameter (${recovery.reason || 'incompatible parameter'}). Retrying without it...`
            });
          }
          response = await fetch(endpoint, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(payload),
            signal: signal
          });
        }

        if (!response.ok) {
          let errorMessage = serverErrorMsg || `HTTP error ${response.status}: ${response.statusText}`;
          if (response.status === 401) {
            errorMessage = 'Invalid or unauthorized API key (401). Check the API key in Settings.';
          } else if (response.status === 404) {
            errorMessage = `Endpoint not found (404). Check the server URL: ${endpoint}`;
          }
          if (onLog) {
            onLog({ type: 'error', text: errorMessage });
            onLog({ type: 'raw', subtype: 'incoming', text: `<<< INCOMING HTTP ${response.status} ${response.statusText}\n${serverErrorMsg || errorMessage}` });
          }
          throw new Error(errorMessage);
        }
      }

      if (!response.body) {
        throw new Error('The server response does not support streaming.');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (let i = 0; i < lines.length; i++) {
          const rawLine = lines[i];
          const trimmedLine = rawLine.trim();
          if (!trimmedLine) continue;

          if (onLog) {
            onLog({
              type: 'raw',
              subtype: 'incoming',
              text: rawLine
            });
          }

          if (trimmedLine.startsWith(':')) continue;

          if (trimmedLine.startsWith('data: ')) {
            const dataStr = trimmedLine.substring(6).trim();

            if (dataStr === '[DONE]') {
              const result = buildResult();
              if (onLog) {
                const { stats } = result;
                const cacheInfo = stats.cachedTokens > 0 ? ` | ⚡ Cache: ${stats.cachedTokens} tok` : '';
                onLog({
                  type: 'stats',
                  text: `Streaming finished [DONE] | Total: ${stats.tokens} tokens | ${stats.tokensPerSec} t/s | TTFT: ${stats.ttftSec}s${cacheInfo}`
                });
              }
              return result;
            }

            let streamFailure = '';
            try {
              const parsed = JSON.parse(dataStr);
              const chunkData = adapter.parseStreamChunk(parsed, { firstTokenTime, accumulatedReasoning, accumulatedText });

              if (chunkData.cachedTokens > 0) serverCachedTokens = chunkData.cachedTokens;
              if (chunkData.cacheCreationTokens > 0) serverCacheCreationTokens = chunkData.cacheCreationTokens;
              if (typeof chunkData.reasoningSignature === 'string') replaySignature = (replaySignature || '') + chunkData.reasoningSignature;
              if (chunkData.error) streamFailure = chunkData.error;
              if (chunkData.truncatedBy && !truncated) {
                truncated = true;
                onLog?.({ type: 'warning', text: `The server cut the response at the output token limit (${chunkData.truncatedBy}).` });
              }

              // Tokens de razonamiento específicos
              if (chunkData.reasoningChunk) {
                publishGenerationStatus({ phase: 'thinking', percent: null, detail: '' });
                if (!firstTokenTime) firstTokenTime = performance.now();
                accumulatedReasoning += chunkData.reasoningChunk;
                if (chunkData.reasoningField) {
                  replayReasoningField = chunkData.reasoningField;
                  replayReasoning += chunkData.reasoningChunk;
                }
                if (onReasoningChunk) {
                  onReasoningChunk(chunkData.reasoningChunk, accumulatedReasoning);
                } else if (onLog) {
                  onLog({ type: 'thinking', text: chunkData.reasoningChunk });
                }
              }

              // Contenido textual con soporte de etiquetas <think>, <thought>, <reasoning>
              const textChunk = chunkData.textChunk;
              if (textChunk) {
                if (!firstTokenTime) firstTokenTime = performance.now();

                let remaining = textChunk;
                while (remaining.length > 0) {
                  if (!activeReasoningTag) {
                    const openMatch = remaining.match(/<(think|thought|reasoning)>/i);
                    if (openMatch) {
                      const preText = remaining.slice(0, openMatch.index);
                      if (preText) {
                        publishGenerationStatus({ phase: 'generating', percent: null, detail: '' });
                        emitText(preText);
                      }
                      activeReasoningTag = openMatch[1].toLowerCase();
                      remaining = remaining.slice(openMatch.index + openMatch[0].length);
                      publishGenerationStatus({ phase: 'thinking', percent: null, detail: '' });
                    } else {
                      publishGenerationStatus({ phase: 'generating', percent: null, detail: '' });
                      emitText(remaining);
                      remaining = '';
                    }
                  } else {
                    const closeRegex = new RegExp(`<\/${activeReasoningTag}>`, 'i');
                    const closeMatch = remaining.match(closeRegex);
                    if (closeMatch) {
                      const rText = remaining.slice(0, closeMatch.index);
                      if (rText) {
                        publishGenerationStatus({ phase: 'thinking', percent: null, detail: '' });
                        accumulatedReasoning += rText;
                        if (onReasoningChunk) {
                          onReasoningChunk(rText, accumulatedReasoning);
                        } else if (onLog) {
                          onLog({ type: 'thinking', text: rText });
                        }
                      }
                      activeReasoningTag = null;
                      remaining = remaining.slice(closeMatch.index + closeMatch[0].length);
                    } else {
                      publishGenerationStatus({ phase: 'thinking', percent: null, detail: '' });
                      accumulatedReasoning += remaining;
                      if (onReasoningChunk) {
                        onReasoningChunk(remaining, accumulatedReasoning);
                      } else if (onLog) {
                        onLog({ type: 'thinking', text: remaining });
                      }
                      remaining = '';
                    }
                  }
                }
              }

              // Tool Call Deltas
              if (chunkData.toolCallDeltas && chunkData.toolCallDeltas.length > 0) {
                if (!firstTokenTime) firstTokenTime = performance.now();
                chunkData.toolCallDeltas.forEach(tc => {
                  const idx = tc.index ?? 0;
                  if (!accumulatedToolCalls[idx]) {
                    accumulatedToolCalls[idx] = {
                      id: tc.id || `call_${Date.now()}_${idx}`,
                      type: 'function',
                      function: {
                        name: tc.function?.name || '',
                        arguments: ''
                      }
                    };
                  }
                  if (tc.id) accumulatedToolCalls[idx].id = tc.id;
                  if (tc.function?.name) accumulatedToolCalls[idx].function.name = tc.function.name;
                  if (tc.function?.arguments) accumulatedToolCalls[idx].function.arguments += tc.function.arguments;
                  if (tc.thought_signature) accumulatedToolCalls[idx].thought_signature = tc.thought_signature;
                  if (tc.extra_content) accumulatedToolCalls[idx].extra_content = tc.extra_content;
                  if (tc.provider_specific_fields) accumulatedToolCalls[idx].provider_specific_fields = tc.provider_specific_fields;
                  if (chunkData.thoughtSignature && !accumulatedToolCalls[idx].thought_signature) {
                    accumulatedToolCalls[idx].thought_signature = chunkData.thoughtSignature;
                  }

                  if (onToolCallDelta) onToolCallDelta(accumulatedToolCalls[idx]);
                });
              }

              // Usage logging si viene en el chunk (OpenAI prompt_tokens / Anthropic input_tokens / Ollama)
              const streamUsage = chunkData.usage || parsed.usage;
              if (streamUsage) {
                const pTokens = streamUsage.prompt_tokens ?? streamUsage.input_tokens ?? streamUsage.prompt_eval_count ?? 0;
                const cTokens = streamUsage.completion_tokens ?? streamUsage.output_tokens ?? streamUsage.eval_count ?? 0;
                const rTokens = streamUsage.completion_tokens_details?.reasoning_tokens ?? streamUsage.reasoning_tokens ?? 0;

                if (pTokens > 0) serverPromptTokens = pTokens;
                if (cTokens > 0) serverCompletionTokens = cTokens;
                if (rTokens > 0) serverReasoningTokens = rTokens;

                if (streamUsage.total_tokens && streamUsage.total_tokens > 0) {
                  serverTotalTokens = Math.max(streamUsage.total_tokens, (serverPromptTokens + serverCompletionTokens));
                } else if (serverPromptTokens > 0 || serverCompletionTokens > 0) {
                  serverTotalTokens = serverPromptTokens + serverCompletionTokens;
                }

                if (onLog) {
                  const cacheLog = serverCachedTokens > 0 ? ` (⚡ Cache: ${serverCachedTokens} tok)` : '';
                  onLog({
                    type: 'stats',
                    text: `Token usage: Prompt=${serverPromptTokens}, Completion=${serverCompletionTokens}, Total=${serverTotalTokens}${serverReasoningTokens ? ` (Reasoning: ${serverReasoningTokens})` : ''}${cacheLog}`
                  });
                }
              }

            } catch (jsonErr) {
              console.warn('[ChatAPI] Ignored unreadable stream chunk:', jsonErr);
              if (onLog) onLog({ type: 'warning', text: `Ignored unreadable stream chunk: ${jsonErr?.message || String(jsonErr)}` });
            }
            if (streamFailure) {
              reader.cancel().catch(() => {});
              throw new StreamServerError(streamFailure);
            }
          }
        }
      }

      // Vaciar buffer residual de TextDecoder si quedaron bytes en streaming
      try {
        const flushText = decoder.decode();
        if (flushText && onLog) {
          onLog({ type: 'raw', subtype: 'incoming', text: flushText });
        }
      } catch (e) { /* bytes residuales no decodificables: no afectan a la respuesta */ }

      return buildResult();
    } catch (err) {
      if (err.name === 'AbortError') {
        return buildResult();
      }
      console.error('[ChatAPI] streamChatCompletion failed:', err);
      onError?.(err);
      return null;
    }
  }

  /**
   * Obtiene las capacidades del proveedor resuelto para una URL o tipo de API.
   */
  function getProviderCapabilities(rawUrl, explicitType, model) {
    return registry.getCapabilities(rawUrl, model, explicitType);
  }

  /**
   * Diagnostica el endpoint del proveedor y analiza sus capacidades declaradas, inferidas y comprobadas.
   */
  async function inspectProvider(config = {}, options = {}) {
    const { apiUrl, apiType, apiKey, model } = config;
    return registry.inspect(apiUrl, String(apiKey || '').trim(), model, apiType, options);
  }

  return {
    fetchServerModels,
    downloadLocalModel,
    deleteLocalModel,
    cancelLocalModelOperation,
    streamChatCompletion,
    estimateTokens,
    getProviderCapabilities,
    inspectProvider,
    registry
  };
});
