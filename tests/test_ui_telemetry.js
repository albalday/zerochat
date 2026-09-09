const { test } = require('node:test');
const assert = require('node:assert/strict');
const UITelemetry = require('../js/ui-telemetry.js');

test('UITelemetry - formatTokenCount formatea de forma compacta y legible', () => {
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
});

test('UITelemetry - formatContextCapacity usa K para capacidades de contexto', () => {
  assert.equal(UITelemetry.formatContextCapacity(90112), '90.112K');
  assert.equal(UITelemetry.formatContextCapacity(1000000), '1000K');
});

test('UITelemetry - parseContextCapacity acepta capacidad compacta sin perder precisión', () => {
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

test('UITelemetry - computeTelemetryViewModel sintetiza métricas de servidor y de contexto', () => {
  const fakeContextManager = {
    getContextDiagnostics: (history, opts) => ({
      model: opts.model,
      providerType: opts.providerType,
      totalLimit: 128000,
      usedTokens: opts.usedTokens || 32000,
      remainingTokens: 96000,
      percentUsed: 25.0,
      isEstimated: false
    }),
    getModelContextLimit: () => 128000
  };

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
    chatHistory: [{ role: 'user', content: 'test' }],
    contextManager: fakeContextManager
  });

  assert.equal(vm.usedTokens, 32000);
  assert.equal(vm.totalLimit, 128000);
  assert.equal(vm.remainingTokens, 96000);
  assert.equal(vm.percentUsed, 25.0);
  assert.equal(vm.healthStatus, 'ok');
  assert.equal(vm.cachedTokens, 16000);
  assert.equal(vm.cachedFormatted, '16k');
  assert.equal(vm.cacheCreationTokens, 4000);
  assert.equal(vm.cacheCreationFormatted, '4k');
  assert.equal(vm.turnPrompt, 32000);
  assert.equal(vm.turnCompletion, 800);
  assert.equal(vm.turnSpeed, '74.2');
  assert.equal(vm.turnLatency, '0.45');
  assert.equal(vm.badgeText, '32k / 128k');
  assert.equal(vm.contextLimitSource, 'server');
});

test('UITelemetry - computeTelemetryViewModel maneja estimación cuando no hay tokens de servidor', () => {
  const fakeContextManager = {
    getContextDiagnostics: (history, opts) => ({
      model: opts.model,
      providerType: opts.providerType,
      totalLimit: 200000,
      usedTokens: 1500,
      remainingTokens: 198500,
      percentUsed: 0.8,
      isEstimated: true
    }),
    getModelContextLimit: () => 200000
  };

  const vm = UITelemetry.computeTelemetryViewModel({
    stats: null,
    config: { model: 'claude-3-5-sonnet', apiType: 'claude', contextLimitOverride: 200000 },
    chatHistory: [{ role: 'user', content: 'Hola' }],
    contextManager: fakeContextManager
  });

  assert.equal(vm.isEstimated, true);
  assert.equal(vm.badgeText, '~1.5k / 200k');
  assert.equal(vm.contextLimitSource, 'manual');
  assert.equal(vm.cachedTokens, 0);
  assert.equal(vm.cachedFormatted, '0');
});

test('UITelemetry - marca como asumida la capacidad cuando no la publica el servidor', () => {
  const fakeContextManager = {
    getContextDiagnostics: () => ({ totalLimit: 1000000, usedTokens: 1200, percentUsed: 0.1, isEstimated: true }),
    getModelContextLimit: () => 1000000
  };

  const vm = UITelemetry.computeTelemetryViewModel({
    config: { model: 'unknown-model', apiType: 'openai' },
    chatHistory: [],
    contextManager: fakeContextManager
  });

  assert.equal(vm.contextLimitSource, 'assumed');
  assert.equal(vm.badgeText, '~1.2k / 1M*');
});

test('UITelemetry - updateBadge actualiza clases de semáforo, texto y pill de caché', () => {
  function makeMockElement(initial = {}) {
    const classes = new Set();
    return {
      textContent: '',
      style: {},
      attributes: {},
      classList: {
        add: (...cls) => cls.forEach(c => classes.add(c)),
        remove: (...cls) => cls.forEach(c => classes.delete(c)),
        contains: (cls) => classes.has(cls)
      },
      setAttribute: function (k, v) { this.attributes[k] = v; },
      ...initial
    };
  }

  const badgeEl = makeMockElement();
  const textEl = makeMockElement();
  const cachePillEl = makeMockElement({ style: { display: 'none' } });
  const cacheValEl = makeMockElement();

  const elements = {
    connectionTokensBadge: badgeEl,
    connectionTokensText: textEl,
    contextHubCachePill: cachePillEl,
    contextHubCacheVal: cacheValEl
  };

  const vmWarning = {
    badgeText: '90k / 128k',
    healthStatus: 'warning',
    cachedTokens: 2500,
    cachedFormatted: '2.5k',
    usedTokens: 90000,
    totalLimit: 128000,
    percentUsed: 70.3
  };

  UITelemetry.updateBadge(elements, vmWarning, (k) => k);

  assert.equal(textEl.textContent, '90k / 128k');
  assert.ok(badgeEl.classList.contains('status-warning'));
  assert.ok(!badgeEl.classList.contains('status-critical'));
  assert.equal(cachePillEl.style.display, 'inline-flex');
  assert.equal(cacheValEl.textContent, '2.5k');
  assert.equal(badgeEl.style.display, 'inline-flex');

  // Caso Crítico sin caché
  const vmCritical = {
    badgeText: '120k / 128k',
    healthStatus: 'critical',
    cachedTokens: 0,
    cachedFormatted: '0',
    usedTokens: 120000,
    totalLimit: 128000,
    percentUsed: 93.8
  };

  UITelemetry.updateBadge(elements, vmCritical, (k) => k);

  assert.equal(textEl.textContent, '120k / 128k');
  assert.ok(!badgeEl.classList.contains('status-warning'));
  assert.ok(badgeEl.classList.contains('status-critical'));
  assert.equal(cachePillEl.style.display, 'none');
});

test('UITelemetry - renderTelemetry respeta lazy rendering del Popover', () => {
  const elements = {
    connectionTokensBadge: {
      classList: { remove: () => {}, add: () => {} },
      setAttribute: () => {},
      style: {}
    },
    connectionTokensText: { textContent: '' },
    contextHubPopover: { style: { display: 'none' } },
    contextProgressBar: { style: {}, classList: { remove: () => {}, add: () => {} } },
    contextMetricUsedVal: { textContent: '' }
  };

  const vm = {
    badgeText: '10k / 128k',
    healthStatus: 'ok',
    percentUsed: 7.8,
    usedTokens: 10000,
    totalLimit: 128000,
    remainingTokens: 118000,
    cachedTokens: 0,
    cacheCreationTokens: 0
  };

  // Popover cerrado -> no escribe en contextMetricUsedVal
  UITelemetry.renderTelemetry(elements, vm);
  assert.equal(elements.contextMetricUsedVal.textContent, '', 'No debe actualizar el popover si está oculto');

  // Popover abierto -> sí escribe en contextMetricUsedVal
  elements.contextHubPopover.style.display = 'flex';
  UITelemetry.renderTelemetry(elements, vm);
  assert.ok(elements.contextMetricUsedVal.textContent.includes('tok'));
  assert.ok(elements.contextMetricUsedVal.textContent.includes('10'));
});

test('UITelemetry - resetTelemetry restaura a estado neutro limpio para nueva sesión', () => {
  const elements = {
    connectionTokensBadge: {
      classList: { remove: () => {}, add: () => {} },
      setAttribute: () => {},
      style: {}
    },
    connectionTokensText: { textContent: '' },
    contextHubCachePill: { style: {} },
    contextHubPopover: { style: { display: 'none' } },
    contextProgressBar: { style: {}, classList: { remove: () => {}, add: () => {} } },
    contextMetricUsedVal: { textContent: '' },
    contextMetricLimitVal: { textContent: '' }
  };

  const fakeContextManager = {
    getContextDiagnostics: () => ({
      totalLimit: 128000,
      usedTokens: 0,
      remainingTokens: 128000,
      percentUsed: 0,
      isEstimated: false
    }),
    getModelContextLimit: () => 128000
  };

  UITelemetry.resetTelemetry(elements, { model: 'gpt-4o', modelContextLimit: 128000 }, [], fakeContextManager);

  assert.equal(elements.connectionTokensText.textContent, '0 / 128k');
  assert.equal(elements.contextHubCachePill.style.display, 'none');
  assert.equal(elements.contextProgressBar.style.width, '0%');
});
