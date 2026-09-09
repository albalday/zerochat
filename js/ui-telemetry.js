/**
 * Módulo de Interfaz de Usuario para Telemetría de Contexto y Tokens (ChatUITelemetry).
 * ZeroChat - js/ui-telemetry.js
 *
 * Responsabilidades:
 * - Formateo de números de tokens (compacto y legible).
 * - Clasificación semafórica de la capacidad de contexto (óptimo, aviso, crítico).
 * - Generación de ViewModel desacoplado para vista de badge y popover.
 * - Renderizado eficiente del badge y renderizado perezoso (lazy) del popover.
 * - Limpieza y reseteo integral de telemetría entre sesiones.
 * - Enlace de eventos accesibles para apertura y cierre del popover.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.ChatUITelemetry = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function resolveDep(globalName, relPath) {
    if (typeof window !== 'undefined' && window[globalName]) return window[globalName];
    if (typeof require !== 'undefined') {
      try { return require(relPath); } catch (e) { return null; }
    }
    return null;
  }

  const getI18n = () => resolveDep('ChatI18n', './i18n.js');
  const getContextManager = () => resolveDep('ChatContextManager', './context-manager.js');

  function t(key, params) {
    const I18n = getI18n();
    if (I18n && typeof I18n.t === 'function') return I18n.t(key, params);
    return key;
  }

  /**
   * Formatea un conteo numérico de tokens de manera compacta (ej: 0, 850, 12.5k, 128k, 1.2M).
   * @param {number|string} num
   * @returns {string}
   */
  function formatTokenCount(num) {
    const val = Number(num);
    if (!val || isNaN(val) || val <= 0) return '0';
    if (val >= 1000000) {
      return (val / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    }
    if (val >= 1000) {
      return (val / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    }
    return String(Math.round(val));
  }

  function formatContextCapacity(num) {
    const value = Number(num);
    if (!Number.isFinite(value) || value <= 0) return '0';
    if (value < 1000) return String(Math.round(value));
    return `${(value / 1000).toFixed(3).replace(/\.?0+$/, '')}K`;
  }

  function parseContextCapacity(value) {
    const match = String(value || '').trim().match(/^(\d+(?:[.,]\d+)?)\s*([km]?)$/i);
    if (!match) return null;
    const amount = Number(match[1].replace(',', '.'));
    const multiplier = match[2].toLowerCase() === 'k' ? 1000 : (match[2].toLowerCase() === 'm' ? 1000000 : 1);
    const limit = Math.floor(amount * multiplier);
    return Number.isFinite(limit) && limit >= 1024 ? limit : null;
  }

  /**
   * Clasifica la salud del contexto según el porcentaje de ventana consumido.
   * @param {number} percentUsed
   * @returns {'ok'|'warning'|'critical'}
   */
  function getContextHealthStatus(percentUsed) {
    const pct = Number(percentUsed) || 0;
    if (pct >= 85) return 'critical';
    if (pct >= 60) return 'warning';
    return 'ok';
  }

  /**
   * Genera un ViewModel desacoplado de telemetría con todas las métricas procesadas.
   * @param {Object} params
   * @param {Object} [params.stats] - Estadísticas del último turno o streaming en curso.
   * @param {Object} [params.diagnostics] - Diagnósticos previos de ContextManager.
   * @param {Object} [params.config] - Configuración de modelo y proveedor.
   * @param {Array} [params.chatHistory] - Mensajes de la conversación activa.
   * @param {Object} [params.contextManager] - Instancia de ChatContextManager inyectable.
   * @returns {Object} ViewModel completo para consumo de vistas y tests.
   */
  function computeTelemetryViewModel({ stats, diagnostics, config, chatHistory, contextManager } = {}) {
    const CM = contextManager || getContextManager();
    const cfg = config || {};
    const model = cfg.model || '';
    const apiType = cfg.apiType || 'openai';

    const sPrompt = (stats && typeof stats === 'object') ? (stats.promptTokens || 0) : 0;
    const sCached = (stats && typeof stats === 'object') ? (stats.cachedTokens || 0) : 0;
    const sCacheCreate = (stats && typeof stats === 'object') ? (stats.cacheCreationTokens || 0) : 0;
    const sCompletion = (stats && typeof stats === 'object') ? (stats.completionTokens || stats.tokens || 0) : 0;
    const sSpeed = (stats && stats.tokensPerSec) ? stats.tokensPerSec : null;
    const sLatency = (stats && stats.ttftSec) ? stats.ttftSec : null;

    let diag = diagnostics;
    if (!diag && CM && typeof CM.getContextDiagnostics === 'function') {
      diag = CM.getContextDiagnostics(chatHistory || [], {
        model,
        providerType: apiType,
        totalContextLimit: cfg.modelContextLimit || cfg.contextLimitOverride,
        usedTokens: sPrompt > 0 ? sPrompt : null
      });
    }

    const configuredLimit = cfg.modelContextLimit || cfg.contextLimitOverride;
    const totalLimit = diag?.totalLimit || (CM && typeof CM.getModelContextLimit === 'function'
      ? CM.getModelContextLimit(model, apiType, configuredLimit)
      : (CM?.DEFAULT_CONTEXT_LIMIT || 0));
    const usedTokens = diag?.usedTokens ?? sPrompt;
    const percentUsed = diag?.percentUsed ?? (totalLimit > 0 ? Number(((usedTokens / totalLimit) * 100).toFixed(1)) : 0);
    const remainingTokens = Math.max(0, totalLimit - usedTokens);
    const isEstimated = diag?.isEstimated ?? (sPrompt <= 0);

    const prefix = (isEstimated && usedTokens > 0) ? '~' : '';
    const usedFormatted = prefix + formatTokenCount(usedTokens);
    const limitFormatted = formatTokenCount(totalLimit);
    const contextLimitSource = cfg.modelContextLimit ? 'server' : (cfg.contextLimitOverride ? 'manual' : 'assumed');
    const badgeText = `${usedFormatted} / ${limitFormatted}${contextLimitSource === 'assumed' ? '*' : ''}`;
    const healthStatus = getContextHealthStatus(percentUsed);

    return {
      model,
      apiType,
      usedTokens,
      totalLimit,
      remainingTokens,
      percentUsed,
      isEstimated,
      prefix,
      badgeText,
      healthStatus,
      contextLimitSource,
      cachedTokens: sCached,
      cachedFormatted: formatTokenCount(sCached),
      cacheCreationTokens: sCacheCreate,
      cacheCreationFormatted: formatTokenCount(sCacheCreate),
      turnPrompt: sPrompt,
      turnCompletion: sCompletion,
      turnSpeed: sSpeed,
      turnLatency: sLatency
    };
  }

  /**
   * Actualiza el indicador visual del badge en el composer.
   * @param {Object} elements - Referencias a elementos DOM de telemetría.
   * @param {Object} vm - ViewModel generado por computeTelemetryViewModel.
   * @param {Function} [customT] - Función traductora opcional.
   */
  function updateBadge(elements, vm, customT) {
    if (!elements || !elements.connectionTokensBadge) return;
    const translate = customT || t;

    // 1. Texto de tokens
    if (elements.connectionTokensText) {
      elements.connectionTokensText.textContent = vm.badgeText;
    }

    // 2. Semáforo visual en el botón
    elements.connectionTokensBadge.classList.remove('status-warning', 'status-critical');
    if (vm.healthStatus === 'critical') {
      elements.connectionTokensBadge.classList.add('status-critical');
    } else if (vm.healthStatus === 'warning') {
      elements.connectionTokensBadge.classList.add('status-warning');
    }

    // 3. Píldora de tokens en caché
    if (elements.contextHubCachePill) {
      if (vm.cachedTokens > 0) {
        let cacheVal = elements.contextHubCacheVal;
        if (!cacheVal && elements.contextHubCachePill.querySelector) {
          cacheVal = elements.contextHubCachePill.querySelector('#context-hub-cache-val');
        }
        if (cacheVal) {
          cacheVal.textContent = vm.cachedFormatted;
        }
        elements.contextHubCachePill.style.display = 'inline-flex';
      } else {
        elements.contextHubCachePill.style.display = 'none';
      }
    }

    // 4. Tooltip accesible
    const titleText = translate('context_hub_btn_title') ||
      `Ventana de contexto: ${vm.usedTokens.toLocaleString()} de ${vm.totalLimit.toLocaleString()} tokens (${vm.percentUsed}%)`;
    elements.connectionTokensBadge.setAttribute('title', titleText);
    elements.connectionTokensBadge.style.display = 'inline-flex';
  }

  /**
   * Actualiza los valores detallados en el Popover flotante.
   * @param {Object} elements - Referencias a elementos DOM del popover.
   * @param {Object} vm - ViewModel generado por computeTelemetryViewModel.
   * @param {Function} [customT] - Función traductora opcional.
   */
  function updatePopover(elements, vm, customT) {
    if (!elements || !elements.contextHubPopover) return;
    const translate = customT || t;

    // 1. Barra de progreso
    if (elements.contextProgressBar) {
      elements.contextProgressBar.classList.remove('warning', 'critical');
      if (vm.healthStatus === 'critical') {
        elements.contextProgressBar.classList.add('critical');
      } else if (vm.healthStatus === 'warning') {
        elements.contextProgressBar.classList.add('warning');
      }
      elements.contextProgressBar.style.width = `${Math.min(100, Math.max(0, vm.percentUsed))}%`;
    }

    // 2. Cuadrícula de contexto global
    if (elements.contextMetricUsedVal) {
      elements.contextMetricUsedVal.textContent = `${vm.usedTokens.toLocaleString()} tok` + (vm.isEstimated && vm.usedTokens > 0 ? ' (est.)' : '');
    }
    if (elements.contextMetricLimitVal) {
      elements.contextMetricLimitVal.textContent = `${formatContextCapacity(vm.totalLimit)} tok`;
    }
    if (elements.contextLimitSource) {
      const sourceKey = vm.contextLimitSource === 'server'
        ? 'context_limit_source_server'
        : (vm.contextLimitSource === 'manual' ? 'context_limit_source_manual' : 'context_limit_source_assumed');
      elements.contextLimitSource.textContent = translate(sourceKey);
    }
    if (elements.contextLimitOverrideInput) {
      const input = elements.contextLimitOverrideInput;
      const isFocused = typeof document !== 'undefined' && document.activeElement === input;
      if (!isFocused) input.value = vm.contextLimitSource === 'server' ? '' : formatContextCapacity(vm.totalLimit);
      input.disabled = vm.contextLimitSource === 'server';
    }
    if (elements.btnSaveContextLimitOverride) {
      elements.btnSaveContextLimitOverride.disabled = vm.contextLimitSource === 'server';
    }
    if (elements.contextMetricFreeVal) {
      elements.contextMetricFreeVal.textContent = `${formatContextCapacity(vm.remainingTokens)} tok`;
    }
    if (elements.contextMetricStatusVal) {
      elements.contextMetricStatusVal.className = 'context-metric-val';
      if (vm.healthStatus === 'critical') {
        elements.contextMetricStatusVal.classList.add('status-critical');
        elements.contextMetricStatusVal.textContent = translate('context_status_critical') || 'Crítico';
      } else if (vm.healthStatus === 'warning') {
        elements.contextMetricStatusVal.classList.add('status-warning');
        elements.contextMetricStatusVal.textContent = translate('context_status_warning') || 'Elevado';
      } else {
        elements.contextMetricStatusVal.classList.add('status-ok');
        elements.contextMetricStatusVal.textContent = translate('context_status_ok') || 'Óptimo';
      }
    }

    // 3. Métricas de caché (Prompt / KV)
    if (elements.contextMetricCachedReadVal) {
      elements.contextMetricCachedReadVal.textContent = `${vm.cachedTokens.toLocaleString()} tok`;
    }
    if (elements.contextMetricCachedWriteVal) {
      elements.contextMetricCachedWriteVal.textContent = `${vm.cacheCreationTokens.toLocaleString()} tok`;
    }

    // 4. Métricas del turno generado
    if (elements.contextMetricTurnPromptVal) {
      elements.contextMetricTurnPromptVal.textContent = vm.turnPrompt > 0 ? `${vm.turnPrompt.toLocaleString()} tok` : '-';
    }
    if (elements.contextMetricTurnCompletionVal) {
      elements.contextMetricTurnCompletionVal.textContent = vm.turnCompletion > 0 ? `${vm.turnCompletion.toLocaleString()} tok` : '-';
    }
    if (elements.contextMetricTurnSpeedVal) {
      elements.contextMetricTurnSpeedVal.textContent = vm.turnSpeed ? `${vm.turnSpeed} tok/s` : '-';
    }
    if (elements.contextMetricTurnLatencyVal) {
      elements.contextMetricTurnLatencyVal.textContent = vm.turnLatency ? `${vm.turnLatency}s` : '-';
    }
  }

  /**
   * Renderiza la telemetría completa aplicando renderizado perezoso (Lazy Rendering).
   * El badge siempre se actualiza; el popover solo se actualiza si está abierto o si se solicita forzarlo.
   * @param {Object} elements - Referencias a elementos DOM.
   * @param {Object} vm - ViewModel generado.
   * @param {Object} [options={}] - Opciones de renderizado ({ forcePopover: boolean }).
   * @param {Function} [customT] - Función traductora opcional.
   */
  function renderTelemetry(elements, vm, options = {}, customT) {
    if (!elements) return;
    updateBadge(elements, vm, customT);

    const isPopoverOpen = elements.contextHubPopover &&
      elements.contextHubPopover.style.display !== 'none' &&
      elements.contextHubPopover.style.display !== '';

    if (options.forcePopover || isPopoverOpen) {
      updatePopover(elements, vm, customT);
    }
  }

  /**
   * Restaura la telemetría a estado neutro limpio para una nueva conversación o al alternar sesiones.
   * @param {Object} elements - Referencias a elementos DOM.
   * @param {Object} config - Configuración actual de la app.
   * @param {Array} [chatHistory=[]] - Mensajes de la nueva sesión cargada (vacío por defecto).
   * @param {Object} [contextManager] - Instancia de ChatContextManager opcional.
   * @param {Function} [customT] - Función traductora opcional.
   */
  function resetTelemetry(elements, config, chatHistory = [], contextManager, customT) {
    const vm = computeTelemetryViewModel({
      stats: null,
      diagnostics: null,
      config,
      chatHistory,
      contextManager
    });

    renderTelemetry(elements, vm, { forcePopover: true }, customT);
  }

  /**
   * Vincula los eventos de apertura, cierre y accesibilidad ARIA para el Popover.
   * @param {Object} elements - Contenedor con connectionTokensBadge, contextHubPopover y btnCloseContextPopover.
   * @param {Function} [onOpenCallback] - Callback invocado cuando el usuario abre el popover (útil para lazy update).
   */
  function bindPopoverEvents(elements, onOpenCallback) {
    if (!elements || !elements.connectionTokensBadge) return;

    const badge = elements.connectionTokensBadge;
    const popover = elements.contextHubPopover;
    const btnClose = elements.btnCloseContextPopover;

    function closePopover() {
      if (popover) popover.style.display = 'none';
      badge.setAttribute('aria-expanded', 'false');
      badge.classList.remove('active');
    }

    function togglePopover(e) {
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
      if (!popover) return;
      const isHidden = popover.style.display === 'none' || !popover.style.display;
      popover.style.display = isHidden ? 'flex' : 'none';
      badge.setAttribute('aria-expanded', isHidden ? 'true' : 'false');
      badge.classList.toggle('active', isHidden);

      if (isHidden && typeof onOpenCallback === 'function') {
        onOpenCallback();
      }
    }

    badge.addEventListener('click', togglePopover);

    if (btnClose) {
      btnClose.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        closePopover();
      });
    }

    if (typeof document !== 'undefined') {
      document.addEventListener('click', function (e) {
        if (popover && popover.style.display !== 'none') {
          if (!popover.contains(e.target) && !badge.contains(e.target)) {
            closePopover();
          }
        }
      });

      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && popover && popover.style.display !== 'none') {
          closePopover();
        }
      });
    }

    return {
      closePopover,
      togglePopover
    };
  }

  return {
    formatTokenCount,
    formatContextCapacity,
    parseContextCapacity,
    getContextHealthStatus,
    computeTelemetryViewModel,
    updateBadge,
    updatePopover,
    renderTelemetry,
    resetTelemetry,
    bindPopoverEvents
  };
});
