const { test } = require('node:test');
const assert = require('node:assert/strict');

test('TokenTelemetry - BaseProviderAdapter inyecta requestUsageStatistics en streaming independiente de promptCaching', () => {
  const { BaseProviderAdapter } = require('../../js/providers.js');
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
  const { ClaudeProviderAdapter } = require('../../js/providers.js');
  const adapter = new ClaudeProviderAdapter();

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
  const { BaseProviderAdapter, OllamaProviderAdapter } = require('../../js/providers.js');
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
