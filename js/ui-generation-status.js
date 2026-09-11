/**
 * General-purpose progress status indicator for the composer.
 * Displays brief, non-sensitive progress messages announced by any module
 * (providers, RAG, tools, MCP, agent loop) during an active chat cycle.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') module.exports = factory();
  else root.ChatUIGenerationStatus = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  let elapsedTimer = null;

  function resolveI18n() {
    if (typeof window !== 'undefined') return window.ChatI18n;
    if (typeof require !== 'undefined') { try { return require('./i18n.js'); } catch (_) {} }
    return null;
  }

  function t(key, params) {
    return resolveI18n()?.t?.(key, params) || key;
  }

  function getViewModel(status = {}, now = Date.now()) {
    const raw = typeof status === 'string' ? { text: status } : (status || {});
    const phase = String(raw.phase || (raw.text || raw.message ? 'custom' : 'idle'));
    const percent = raw.percent != null && raw.percent !== '' && Number.isFinite(Number(raw.percent))
      ? Math.round(Math.max(0, Math.min(100, Number(raw.percent))))
      : null;
    const elapsed = phase === 'thinking' && raw.startedAt != null && raw.startedAt !== '' && Number.isFinite(Number(raw.startedAt))
      ? Math.max(0, Math.floor((now - Number(raw.startedAt)) / 1000)) : null;
    const labels = {
      connecting: t('generation_status_connecting'),
      preparing: t('generation_status_preparing'),
      'main-thread-fallback': t('generation_status_preparing'),
      loading: t('generation_status_loading'),
      compiling: t('generation_status_compiling'),
      ready: t('generation_status_generating'),
      thinking: t('generation_status_thinking'),
      generating: t('generation_status_generating'),
      rag: t('generation_status_rag')
    };
    let text = raw.text || raw.message || labels[phase] || (phase !== 'idle' ? t('generation_status_generating') : '');
    if (phase === 'idle') text = '';
    if (text && percent !== null) text = t('generation_status_percent', { text, percent });
    if (text && elapsed !== null) text = t('generation_status_elapsed', { text, seconds: elapsed });
    const active = Boolean(text) && phase !== 'idle';
    return { active, phase, percent, text };
  }

  function render(element, status) {
    if (!element) return;
    const view = getViewModel(status);
    element.hidden = !view.active;
    if (!view.active) {
      if (elapsedTimer) clearInterval(elapsedTimer);
      elapsedTimer = null;
      return;
    }
    element.dataset.phase = view.phase;
    const text = element.querySelector?.('.generation-status-text');
    if (text) text.textContent = view.text;
    const progress = element.querySelector?.('.generation-status-progress');
    if (progress) {
      progress.hidden = view.percent === null;
      if (view.percent !== null) progress.value = view.percent;
    }
    if (elapsedTimer) clearInterval(elapsedTimer);
    elapsedTimer = null;
    if (view.phase === 'thinking') {
      elapsedTimer = setInterval(() => render(element, status), 1000);
    }
  }

  return { getViewModel, render };
}));
