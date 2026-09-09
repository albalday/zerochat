const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  BaseProviderAdapter,
  ClaudeProviderAdapter,
  GeminiProviderAdapter,
  OllamaProviderAdapter,
  OpenRouterProviderAdapter
} = require('../js/providers.js');
const ChatAPI = require('../js/api.js');
const ChatContextManager = require('../js/context-manager.js');
const ChatEngine = require('../js/chat-engine.js');

test('TokenTelemetry - BaseProviderAdapter inyecta requestUsageStatistics en streaming independiente de promptCaching', () => {
  const adapter = new BaseProviderAdapter();
  const payload = adapter.buildPayload({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'Hola' }],
    stream: true
  });
  assert.ok(payload.stream_options, 'Debe incluir stream_options en streaming');
  assert.equal(payload.stream_options.include_usage, true, 'Debe solicitar include_usage: true');

  const payloadSync = adapter.buildPayload({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'Hola' }],
    stream: false
  });
  assert.equal(payloadSync.stream_options, undefined, 'No debe inyectar stream_options en síncrono');
});

test('TokenTelemetry - ClaudeProviderAdapter captura message_start y message_delta preservando input y output tokens', () => {
  const adapter = new ClaudeProviderAdapter();

  // 1. message_start con input_tokens y caché
  const startChunk = {
    type: 'message_start',
    message: {
      usage: {
        input_tokens: 1500,
        cache_read_input_tokens: 1200,
        cache_creation_input_tokens: 300
      }
    }
  };
  const parsedStart = adapter.parseStreamChunk(startChunk);
  assert.equal(parsedStart.cachedTokens, 1200);
  assert.equal(parsedStart.cacheCreationTokens, 300);
  assert.equal(parsedStart.usage.input_tokens, 1500);

  // 2. message_delta con output_tokens
  const deltaChunk = {
    type: 'message_delta',
    usage: {
      output_tokens: 250
    }
  };
  const parsedDelta = adapter.parseStreamChunk(deltaChunk);
  assert.ok(parsedDelta.usage, 'Debe capturar el objeto usage en message_delta');
  assert.equal(parsedDelta.usage.output_tokens, 250);
});

test('TokenTelemetry - BaseProviderAdapter y Ollama parsean prompt_eval_count y eval_count nativos', () => {
  const adapter = new OllamaProviderAdapter();
  const ollamaDoneChunk = {
    done: true,
    prompt_eval_count: 85,
    eval_count: 140
  };
  const parsed = adapter.parseStreamChunk(ollamaDoneChunk);
  assert.ok(parsed.usage, 'Debe sintetizar el objeto usage para Ollama');
  assert.equal(parsed.usage.prompt_tokens, 85);
  assert.equal(parsed.usage.completion_tokens, 140);
  assert.equal(parsed.usage.total_tokens, 225);
});

test('TokenTelemetry - ChatContextManager.getContextDiagnostics calcula ventana global y porcentajes', () => {
  const messages = [
    { role: 'user', content: 'Explícame qué es la teoría de la relatividad' },
    { role: 'assistant', content: 'La teoría de la relatividad fue desarrollada por Albert Einstein...' }
  ];

  // Caso 1: Con tokens reales del servidor
  const diagServer = ChatContextManager.getContextDiagnostics(messages, {
    model: 'gpt-4o',
    providerType: 'openai',
    totalContextLimit: 128000,
    usedTokens: 12800
  });

  assert.equal(diagServer.totalLimit, 128000);
  assert.equal(diagServer.usedTokens, 12800);
  assert.equal(diagServer.percentUsed, 10.0);
  assert.equal(diagServer.remainingTokens, 115200);
  assert.equal(diagServer.isEstimated, false);

  // Caso 2: Sin tokens reales (modo estimación local)
  const diagEst = ChatContextManager.getContextDiagnostics(messages, {
    model: 'claude-3-5-sonnet',
    providerType: 'claude',
    totalContextLimit: 200000
  });

  assert.equal(diagEst.totalLimit, 200000);
  assert.ok(diagEst.usedTokens > 0, 'Debe estimar tokens en base al historial');
  assert.equal(diagEst.isEstimated, true);
  assert.ok(diagEst.percentUsed >= 0 && diagEst.percentUsed <= 100);
});

test('TokenTelemetry - ChatEngine preserva diagnósticos de contexto en buildEffectiveMessages', () => {
  const history = [
    { role: 'user', content: 'Hola mundo' }
  ];
  const config = {
    model: 'gpt-4o-mini',
    apiType: 'openai',
    systemPrompt: 'Instrucción de prueba'
  };

  const effective = ChatEngine.buildEffectiveMessages(history, config);
  assert.ok(Array.isArray(effective));

  const diag = ChatEngine.getLastContextDiagnostics();
  assert.ok(diag, 'Debe guardar lastContextDiagnostics');
  assert.equal(diag.budget > 0, true);
  assert.equal(diag.totalTokens > 0, true);
  assert.equal(diag.strategy, 'full_history');
});
