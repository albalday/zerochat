/**
 * General-purpose progress status indicator for the composer.
 * Displays brief, non-sensitive progress messages announced by any module
 * (providers, RAG, tools, MCP, agent loop) during an active chat cycle.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') module.exports = factory(require('./utils.js'), require('./i18n.js'));
  else root.ChatUIGenerationStatus = factory(root.ChatUtils, root.ChatI18n);
}(typeof self !== 'undefined' ? self : this, function (Utils, I18n) {
  'use strict';

  const { resolveDep } = Utils;
  const { t } = I18n;
  let elapsedTimer = null;

  function getViewModel(status = {}, now = Date.now(), options = {}) {
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
      loading: t('generation_status_loading'),
      compiling: t('generation_status_compiling'),
      ready: t('generation_status_generating'),
      thinking: t(options.compact ? 'generation_status_thinking_short' : 'generation_status_thinking'),
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

  function isCompactViewport() {
    return window.matchMedia('(max-width: 640px)').matches;
  }

  function render(element, status) {
    const view = getViewModel(status, Date.now(), { compact: isCompactViewport() });
    element.hidden = !view.active;
    if (!view.active) {
      if (elapsedTimer) clearInterval(elapsedTimer);
      elapsedTimer = null;
      return;
    }
    element.dataset.phase = view.phase;
    element.querySelector('.generation-status-text').textContent = view.text;
    const progress = element.querySelector('.generation-status-progress');
    progress.hidden = view.percent === null;
    if (view.percent !== null) progress.value = view.percent;
    if (elapsedTimer) clearInterval(elapsedTimer);
    elapsedTimer = null;
    if (view.phase === 'thinking') {
      elapsedTimer = setInterval(() => render(element, status), 1000);
    }
  }

  const getState = () => resolveDep('ChatState', './state.js');

  function setStatus(element, update = {}) {
    const State = getState();
    const raw = typeof update === 'string' ? { text: update } : update;
    const phase = String(raw.phase || (raw.text || raw.message ? 'custom' : 'idle'));
    // Si no se está procesando un ciclo de chat, el indicador permanece invisible y no se reactiva.
    if (!State.isConversationBusy() && phase !== 'idle') return;
    const next = State.setGenerationStatus(raw);
    render(element, next);
    return next;
  }

  function clearStatus(element) {
    getState().clearGenerationStatus();
    render(element, { phase: 'idle' });
  }

  return { getViewModel, render, setStatus, clearStatus };
}));
