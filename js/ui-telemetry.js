/**
 * Telemetría de contexto y tokens del compositor (ChatUITelemetry): el botón con el uso del
 * contexto y su semáforo, y el panel con el detalle, que solo se rellena mientras está abierto.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./utils.js'), require('./i18n.js'));
  } else {
    root.ChatUITelemetry = factory(root.ChatUtils, root.ChatI18n);
  }
})(typeof self !== 'undefined' ? self : this, function (Utils, I18n) {
  'use strict';

  const { resolveDep } = Utils;
  const { t } = I18n;

  const getContextManager = () => resolveDep('ChatContextManager', './context-manager.js');
  const STATUS_CLASSES = ['status-warning', 'status-critical'];
  const LIMIT_SOURCE_KEYS = { server: 'context_limit_source_server', manual: 'context_limit_source_manual', assumed: 'context_limit_source_assumed' };
  const HEALTH_KEYS = { ok: 'context_status_ok', warning: 'context_status_warning', critical: 'context_status_critical' };

  /** Recuento compacto de tokens: 850, 12.5k, 128k, 1.2M. */
  function formatTokenCount(num) {
    const val = Number(num);
    if (!val || val <= 0) return '0';
    if (val >= 1000000) return `${(val / 1000000).toFixed(1).replace(/\.0$/, '')}M`;
    if (val >= 1000) return `${(val / 1000).toFixed(1).replace(/\.0$/, '')}k`;
    return String(Math.round(val));
  }

  /** Capacidad de contexto exacta en miles: 90112 → 90.112K. */
  function formatContextCapacity(num) {
    const value = Number(num);
    if (!Number.isFinite(value) || value <= 0) return '0';
    if (value < 1000) return String(Math.round(value));
    return `${(value / 1000).toFixed(3).replace(/\.?0+$/, '')}K`;
  }

  /** Lee una capacidad escrita por el usuario (64000, 90.112K, 1M); null si no es válida o es menor de 1024. */
  function parseContextCapacity(value) {
    const match = String(value || '').trim().match(/^(\d+(?:[.,]\d+)?)\s*([km]?)$/i);
    if (!match) return null;
    const multiplier = { k: 1000, m: 1000000 }[match[2].toLowerCase()] || 1;
    const limit = Math.floor(Number(match[1].replace(',', '.')) * multiplier);
    return Number.isFinite(limit) && limit >= 1024 ? limit : null;
  }

  function getContextHealthStatus(percentUsed) {
    const pct = Number(percentUsed) || 0;
    if (pct >= 85) return 'critical';
    if (pct >= 60) return 'warning';
    return 'ok';
  }

  /**
   * Métricas para el botón y el panel. Los diagnósticos los calcula ChatContextManager con los
   * tokens de prompt que haya informado el servidor.
   */
  function computeTelemetryViewModel({ stats, config, chatHistory }) {
    const promptTokens = stats?.promptTokens || 0;
    const configuredLimit = config.modelContextLimit || config.contextLimitOverride;
    const diag = getContextManager().getContextDiagnostics(chatHistory, {
      model: config.model || '',
      providerType: config.apiType || 'openai',
      totalContextLimit: configuredLimit,
      usedTokens: promptTokens > 0 ? promptTokens : null
    });
    const { totalLimit, usedTokens, percentUsed, isEstimated } = diag;
    const contextLimitSource = config.modelContextLimit ? 'server' : (config.contextLimitOverride ? 'manual' : 'assumed');
    const prefix = isEstimated && usedTokens > 0 ? '~' : '';
    const cachedTokens = stats?.cachedTokens || 0;

    return {
      usedTokens,
      totalLimit,
      remainingTokens: Math.max(0, totalLimit - usedTokens),
      percentUsed,
      isEstimated,
      badgeText: `${prefix}${formatTokenCount(usedTokens)} / ${formatTokenCount(totalLimit)}${contextLimitSource === 'assumed' ? '*' : ''}`,
      healthStatus: getContextHealthStatus(percentUsed),
      contextLimitSource,
      cachedTokens,
      cachedFormatted: formatTokenCount(cachedTokens),
      cacheCreationTokens: stats?.cacheCreationTokens || 0,
      turnPrompt: promptTokens,
      turnCompletion: stats?.completionTokens || stats?.tokens || 0,
      turnSpeed: stats?.tokensPerSec || null,
      turnLatency: stats?.ttftSec || null
    };
  }

  const tokens = value => `${value.toLocaleString()} tok`;

  function setHealthClass(element, healthStatus) {
    element.classList.remove(...STATUS_CLASSES);
    if (healthStatus !== 'ok') element.classList.add(`status-${healthStatus}`);
  }

  function updateBadge(elements, vm) {
    elements.connectionTokensText.textContent = vm.badgeText;
    setHealthClass(elements.connectionTokensBadge, vm.healthStatus);
    elements.contextHubCacheVal.textContent = vm.cachedFormatted;
    elements.contextHubCachePill.hidden = vm.cachedTokens <= 0;
    elements.connectionTokensBadge.title = t('context_hub_btn_title');
    elements.connectionTokensBadge.hidden = false;
  }

  function updatePopover(elements, vm) {
    const bar = elements.contextProgressBar;
    bar.classList.remove('warning', 'critical');
    if (vm.healthStatus !== 'ok') bar.classList.add(vm.healthStatus);
    bar.style.width = `${Math.min(100, Math.max(0, vm.percentUsed))}%`;

    elements.contextMetricUsedVal.textContent = tokens(vm.usedTokens) + (vm.isEstimated && vm.usedTokens > 0 ? ' (est.)' : '');
    elements.contextMetricLimitVal.textContent = `${formatContextCapacity(vm.totalLimit)} tok`;
    elements.contextLimitSource.textContent = t(LIMIT_SOURCE_KEYS[vm.contextLimitSource]);
    const fromServer = vm.contextLimitSource === 'server';
    const input = elements.contextLimitOverrideInput;
    if (document.activeElement !== input) input.value = fromServer ? '' : formatContextCapacity(vm.totalLimit);
    input.disabled = fromServer;
    elements.btnSaveContextLimitOverride.disabled = fromServer;
    elements.contextMetricFreeVal.textContent = `${formatContextCapacity(vm.remainingTokens)} tok`;

    const status = elements.contextMetricStatusVal;
    status.className = `context-metric-val status-${vm.healthStatus}`;
    status.textContent = t(HEALTH_KEYS[vm.healthStatus]);

    elements.contextMetricCachedReadVal.textContent = tokens(vm.cachedTokens);
    elements.contextMetricCachedWriteVal.textContent = tokens(vm.cacheCreationTokens);
    elements.contextMetricTurnPromptVal.textContent = vm.turnPrompt > 0 ? tokens(vm.turnPrompt) : '-';
    elements.contextMetricTurnCompletionVal.textContent = vm.turnCompletion > 0 ? tokens(vm.turnCompletion) : '-';
    elements.contextMetricTurnSpeedVal.textContent = vm.turnSpeed ? `${vm.turnSpeed} t/s` : '-';
    elements.contextMetricTurnLatencyVal.textContent = vm.turnLatency ? `${vm.turnLatency}s` : '-';
  }

  /** Actualiza siempre el botón; el panel, solo si está abierto o se pide con `forcePopover`. */
  function renderTelemetry(elements, vm, { forcePopover = false } = {}) {
    updateBadge(elements, vm);
    if (forcePopover || !elements.contextHubPopover.hidden) updatePopover(elements, vm);
  }

  /** Deja la telemetría en el estado de una conversación sin estadísticas del servidor. */
  function resetTelemetry(elements, config, chatHistory = []) {
    renderTelemetry(elements, computeTelemetryViewModel({ stats: null, config, chatHistory }), { forcePopover: true });
  }

  /**
   * Conecta la apertura y el cierre del panel (botón, cerrar, clic fuera y Escape). `onOpen` se
   * llama al abrirlo para rellenarlo.
   */
  function mount(elements, onOpen) {
    const badge = elements.connectionTokensBadge;
    const popover = elements.contextHubPopover;

    // En móvil el panel ocupa el área del chat: desde la cabecera hasta el compositor.
    function fitPopoverToChatArea() {
      const composer = popover.closest('.chat-input-container');
      const header = document.querySelector('.app-header');
      popover.style.setProperty('--context-hub-top', `${Math.max(0, header.getBoundingClientRect().bottom)}px`);
      popover.style.setProperty('--context-hub-bottom', `${Math.max(0, window.innerHeight - composer.getBoundingClientRect().top)}px`);
    }

    function setOpen(open) {
      if (open) fitPopoverToChatArea();
      popover.hidden = !open;
      badge.setAttribute('aria-expanded', String(open));
      badge.classList.toggle('active', open);
      if (open) onOpen();
    }

    badge.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      setOpen(popover.hidden);
    });
    elements.btnCloseContextPopover.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    });
    document.addEventListener('click', event => {
      if (!popover.hidden && !popover.contains(event.target) && !badge.contains(event.target)) setOpen(false);
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !popover.hidden) setOpen(false);
    });
    window.addEventListener('resize', () => {
      if (!popover.hidden) fitPopoverToChatArea();
    });
  }

  return {
    formatContextCapacity,
    parseContextCapacity,
    computeTelemetryViewModel,
    renderTelemetry,
    resetTelemetry,
    mount
  };
});
