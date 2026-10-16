const { test } = require('node:test');
const assert = require('node:assert/strict');
const UITelemetry = require('../../js/ui-telemetry.js');
const ContextManager = require('../../js/context-manager.js');
const I18n = require('../../js/i18n.js');
const { installDom, getAppElements } = require('../helpers/dom-env.js');

/** Sustituye los diagnósticos de ChatContextManager por unos fijos. */
function useDiagnostics(t, diagnostics) {
  t.mock.method(ContextManager, 'getContextDiagnostics', (history, options) => ({ ...diagnostics, options }));
}

function setupDom(t) {
  const dom = installDom({ app: true });
  t.after(() => dom.restore());
  return getAppElements(document);
}

test('UITelemetry - formatea y parsea recuentos de tokens y capacidades de contexto', () => {
  assert.equal(UITelemetry.formatTokenCount(0), '0');
  assert.equal(UITelemetry.formatTokenCount(null), '0');
  assert.equal(UITelemetry.formatTokenCount(undefined), '0');
  assert.equal(UITelemetry.formatTokenCount('abc'), '0');
  assert.equal(UITelemetry.formatTokenCount(-50), '0');

  assert.equal(UITelemetry.formatTokenCount(120), '120');
  assert.equal(UITelemetry.formatTokenCount(999), '999');
  assert.equal(UITelemetry.formatTokenCount(1000), '1k');
  assert.equal(UITelemetry.formatTokenCount(1200), '1.2k');
  assert.equal(UITelemetry.formatTokenCount(128000), '128k');
  assert.equal(UITelemetry.formatTokenCount(200000), '200k');

  assert.equal(UITelemetry.formatTokenCount(1000000), '1M');
  assert.equal(UITelemetry.formatTokenCount(1500000), '1.5M');
  assert.equal(UITelemetry.formatTokenCount(2000000), '2M');

  assert.equal(UITelemetry.formatContextCapacity(90112), '90.112K');
  assert.equal(UITelemetry.formatContextCapacity(1000000), '1000K');

  assert.equal(UITelemetry.parseContextCapacity('90.112K'), 90112);
  assert.equal(UITelemetry.parseContextCapacity('1M'), 1000000);
  assert.equal(UITelemetry.parseContextCapacity('64000'), 64000);
  assert.equal(UITelemetry.parseContextCapacity('1K'), null);
  assert.equal(UITelemetry.parseContextCapacity('unknown'), null);
});

test('UITelemetry - getContextHealthStatus evalúa umbrales de advertencia y crítico', () => {
  assert.equal(UITelemetry.getContextHealthStatus(0), 'ok');
  assert.equal(UITelemetry.getContextHealthStatus(25), 'ok');
  assert.equal(UITelemetry.getContextHealthStatus(59.9), 'ok');

  assert.equal(UITelemetry.getContextHealthStatus(60), 'warning');
  assert.equal(UITelemetry.getContextHealthStatus(75), 'warning');
  assert.equal(UITelemetry.getContextHealthStatus(84.9), 'warning');

  assert.equal(UITelemetry.getContextHealthStatus(85), 'critical');
  assert.equal(UITelemetry.getContextHealthStatus(95), 'critical');
  assert.equal(UITelemetry.getContextHealthStatus(100), 'critical');
});

test('UITelemetry - computeTelemetryViewModel sintetiza métricas de servidor y de contexto', t => {
  useDiagnostics(t, { totalLimit: 128000, usedTokens: 32000, percentUsed: 25.0, isEstimated: false });

  const stats = {
    promptTokens: 32000,
    completionTokens: 800,
    cachedTokens: 16000,
    cacheCreationTokens: 4000,
    tokensPerSec: '74.2',
    ttftSec: '0.45'
  };

  const vm = UITelemetry.computeTelemetryViewModel({
    stats,
    config: { model: 'gpt-4o', apiType: 'openai', modelContextLimit: 128000 },
    chatHistory: [{ role: 'user', content: 'test' }]
  });

  assert.equal(vm.usedTokens, 32000);
  assert.equal(vm.totalLimit, 128000);
  assert.equal(vm.remainingTokens, 96000);
  assert.equal(vm.percentUsed, 25.0);
  assert.equal(vm.healthStatus, 'ok');
  assert.equal(vm.cachedTokens, 16000);
  assert.equal(vm.cachedFormatted, '16k');
  assert.equal(vm.cacheCreationTokens, 4000);
  assert.equal(vm.turnPrompt, 32000);
  assert.equal(vm.turnCompletion, 800);
  assert.equal(vm.turnSpeed, '74.2');
  assert.equal(vm.turnLatency, '0.45');
  assert.equal(vm.badgeText, '32k / 128k');
  assert.equal(vm.contextLimitSource, 'server');
  assert.equal(ContextManager.getContextDiagnostics.mock.calls[0].arguments[1].usedTokens, 32000, 'Usa los tokens de prompt del servidor');
});

test('UITelemetry - computeTelemetryViewModel maneja estimación cuando no hay tokens de servidor', t => {
  useDiagnostics(t, { totalLimit: 200000, usedTokens: 1500, percentUsed: 0.8, isEstimated: true });

  const vm = UITelemetry.computeTelemetryViewModel({
    stats: null,
    config: { model: 'claude-3-5-sonnet', apiType: 'claude', contextLimitOverride: 200000 },
    chatHistory: [{ role: 'user', content: 'Hola' }]
  });

  assert.equal(vm.isEstimated, true);
  assert.equal(vm.badgeText, '~1.5k / 200k');
  assert.equal(vm.contextLimitSource, 'manual');
  assert.equal(vm.cachedTokens, 0);
  assert.equal(vm.cachedFormatted, '0');
});

test('UITelemetry - marca como asumida la capacidad cuando no la publica el servidor', t => {
  useDiagnostics(t, { totalLimit: 1000000, usedTokens: 1200, percentUsed: 0.1, isEstimated: true });

  const vm = UITelemetry.computeTelemetryViewModel({
    config: { model: 'unknown-model', apiType: 'openai' },
    chatHistory: []
  });

  assert.equal(vm.contextLimitSource, 'assumed');
  assert.equal(vm.badgeText, '~1.2k / 1M*');
});

test('UITelemetry - el botón muestra el uso, el semáforo y la píldora de caché', t => {
  const elements = setupDom(t);
  const vm = { badgeText: '90k / 128k', healthStatus: 'warning', cachedTokens: 2500, cachedFormatted: '2.5k' };
  UITelemetry.renderTelemetry(elements, vm);
  assert.equal(elements.connectionTokensText.textContent, '90k / 128k');
  assert.ok(elements.connectionTokensBadge.classList.contains('status-warning'));
  assert.equal(elements.connectionTokensBadge.hidden, false);
  assert.equal(elements.connectionTokensBadge.title, I18n.t('context_hub_btn_title'));
  assert.equal(elements.contextHubCachePill.hidden, false);
  assert.equal(elements.contextHubCacheVal.textContent, '2.5k');

  UITelemetry.renderTelemetry(elements, { ...vm, badgeText: '120k / 128k', healthStatus: 'critical', cachedTokens: 0, cachedFormatted: '0' });
  assert.ok(!elements.connectionTokensBadge.classList.contains('status-warning'));
  assert.ok(elements.connectionTokensBadge.classList.contains('status-critical'));
  assert.equal(elements.contextHubCachePill.hidden, true);
});

test('UITelemetry - el panel solo se rellena abierto y el botón lo abre y cierra', t => {
  const elements = setupDom(t);
  useDiagnostics(t, { totalLimit: 128000, usedTokens: 10000, percentUsed: 7.8, isEstimated: false });
  const vm = UITelemetry.computeTelemetryViewModel({ stats: { promptTokens: 10000 }, config: { model: 'm', modelContextLimit: 128000 }, chatHistory: [] });
  let opened = 0;
  UITelemetry.mount(elements, () => { opened++; UITelemetry.renderTelemetry(elements, vm, { forcePopover: true }); });

  const initialUsed = elements.contextMetricUsedVal.textContent;
  UITelemetry.renderTelemetry(elements, vm);
  assert.equal(elements.contextMetricUsedVal.textContent, initialUsed, 'No actualiza el panel oculto');

  elements.connectionTokensBadge.click();
  assert.equal(elements.contextHubPopover.hidden, false);
  assert.equal(elements.connectionTokensBadge.getAttribute('aria-expanded'), 'true');
  assert.equal(opened, 1);
  assert.equal(elements.contextMetricUsedVal.textContent, `${(10000).toLocaleString()} tok`);
  assert.equal(elements.contextProgressBar.style.width, '7.8%');
  assert.equal(elements.contextLimitOverrideInput.disabled, true, 'La capacidad del servidor no se edita');
  assert.equal(elements.contextMetricStatusVal.textContent, I18n.t('context_status_ok'));

  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(elements.contextHubPopover.hidden, true);
  elements.connectionTokensBadge.click();
  document.body.click();
  assert.equal(elements.contextHubPopover.hidden, true, 'Un clic fuera lo cierra');
});

test('UITelemetry - resetTelemetry deja el estado neutro de una conversación nueva', t => {
  const elements = setupDom(t);
  useDiagnostics(t, { totalLimit: 128000, usedTokens: 0, percentUsed: 0, isEstimated: false });
  UITelemetry.resetTelemetry(elements, { model: 'gpt-4o', modelContextLimit: 128000 }, []);
  assert.equal(elements.connectionTokensText.textContent, '0 / 128k');
  assert.equal(elements.contextHubCachePill.hidden, true);
  assert.equal(elements.contextProgressBar.style.width, '0%');
  assert.equal(elements.contextMetricTurnPromptVal.textContent, '-');
});

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

test('TokenTelemetry - ChatContextManager.getContextDiagnostics calcula ventana global y porcentajes', () => {
  const messages = [
    { role: 'user', content: 'Explícame qué es la teoría de la relatividad' },
    { role: 'assistant', content: 'La teoría de la relatividad fue desarrollada por Albert Einstein...' }
  ];

  const diagServer = ContextManager.getContextDiagnostics(messages, {
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

  const diagEst = ContextManager.getContextDiagnostics(messages, {
    model: 'claude-3-5-sonnet',
    providerType: 'claude',
    totalContextLimit: 200000
  });

  assert.equal(diagEst.totalLimit, 200000);
  assert.ok(diagEst.usedTokens > 0, 'Debe estimar tokens en base al historial');
  assert.equal(diagEst.isEstimated, true);
  assert.ok(diagEst.percentUsed >= 0 && diagEst.percentUsed <= 100);
});
