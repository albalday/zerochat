/** UI del selector compacto de intensidad de razonamiento. */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') module.exports = factory();
  else root.ChatUIReasoning = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const INTENSITY_LEVELS = Object.freeze(['none', 'low', 'medium', 'high', 'xhigh']);

  function resolveDep(globalName, relPath) {
    if (typeof window !== 'undefined' && window[globalName]) return window[globalName];
    if (typeof require !== 'undefined') { try { return require(relPath); } catch (_) { return null; } }
    return null;
  }

  function t(key, params) {
    const I18n = resolveDep('ChatI18n', './i18n.js');
    return I18n?.t ? I18n.t(key, params) : key;
  }

  function getReasoningIntensity(level) {
    const normalized = String(level || 'none').toLowerCase().trim();
    const index = INTENSITY_LEVELS.indexOf(normalized === 'off' ? 'none' : normalized);
    return index >= 0 ? index : 0;
  }

  function getReasoningLevelFromIntensity(intensity) {
    const parsed = Number.parseInt(intensity, 10);
    const index = Math.max(0, Math.min(INTENSITY_LEVELS.length - 1, Number.isFinite(parsed) ? parsed : 0));
    return INTENSITY_LEVELS[index];
  }

  function getReasoningLevelLabel(level) {
    const labels = { none: 'reasoning_intensity_none', low: 'reasoning_level_low', medium: 'reasoning_level_medium', high: 'reasoning_level_high', xhigh: 'reasoning_intensity_max' };
    return t(labels[getReasoningLevelFromIntensity(getReasoningIntensity(level))]);
  }

  function syncReasoningIntensity(elements, level) {
    const intensity = getReasoningIntensity(level);
    const label = getReasoningLevelLabel(level);
    if (elements?.reasoningIntensity) {
      elements.reasoningIntensity.value = String(intensity);
      elements.reasoningIntensity.style?.setProperty?.('--reasoning-intensity', `${intensity * 25}%`);
      elements.reasoningIntensity.setAttribute?.('aria-valuetext', label);
    }
    if (elements?.reasoningIntensityValue) elements.reasoningIntensityValue.textContent = label;
    return intensity;
  }

  function syncReasoningGauge(elements, level) {
    const needle = elements?.btnReasoning?.querySelector?.('#reasoning-gauge-needle');
    if (needle) needle.setAttribute('transform', `rotate(${-60 + (getReasoningIntensity(level) * 30)} 12 15)`);
  }

  function positionReasoningMenu(elements) {
    if (!elements?.reasoningMenu || !elements?.btnReasoning || elements.reasoningMenu.style.display === 'none') return;
    const rect = elements.btnReasoning.getBoundingClientRect?.() || { top: 0, left: 0 };
    const win = elements.reasoningMenu.ownerDocument?.defaultView || window;
    const width = Math.min(290, (win?.innerWidth || 1200) - 16);
    const left = Math.max(8, Math.min(rect.left, (win?.innerWidth || 1200) - width - 8));
    elements.reasoningMenu.style.position = 'fixed';
    elements.reasoningMenu.style.left = `${Math.round(left)}px`;
    elements.reasoningMenu.style.width = `${Math.round(width)}px`;
    elements.reasoningMenu.style.bottom = `${Math.round(Math.max(8, (win?.visualViewport?.height || win?.innerHeight || 800) - rect.top + 8))}px`;
    elements.reasoningMenu.style.top = 'auto';
  }

  function closeReasoningMenu(elements) {
    if (!elements?.reasoningMenu) return;
    elements.reasoningMenu.style.display = 'none';
    elements.btnReasoning?.setAttribute?.('aria-expanded', 'false');
  }

  function syncCheckpointToggle(elements, enabled, onToggleCheckpoint) {
    const checkbox = elements?.chkReasoningAgentCheckpoint;
    if (!checkbox) return;
    checkbox.checked = Boolean(enabled);
    checkbox._onToggleCheckpoint = onToggleCheckpoint;
    if (!checkbox._hasReasoningListener) {
      checkbox._hasReasoningListener = true;
      checkbox.addEventListener('change', event => checkbox._onToggleCheckpoint?.(event.target.checked));
    }
  }

  function openReasoningMenu(elements, appConfig, onSelect, onToggleCheckpoint) {
    if (!elements?.reasoningMenu) return;
    elements.reasoningMenu.style.display = 'flex';
    elements.btnReasoning?.setAttribute?.('aria-expanded', 'true');
    syncReasoningIntensity(elements, appConfig?.reasoningEffort || 'none');
    syncCheckpointToggle(elements, Boolean(appConfig?.enabledTools?.agent_checkpoint), onToggleCheckpoint);
    const slider = elements.reasoningIntensity;
    if (slider) {
      slider._onReasoningIntensityChange = onSelect;
      if (!slider._hasReasoningListener) {
        slider._hasReasoningListener = true;
        slider.addEventListener('input', event => {
          const level = getReasoningLevelFromIntensity(event.target.value);
          syncReasoningIntensity(elements, level);
          updateReasoningUI(elements, level);
          event.target._onReasoningIntensityChange?.(level);
        });
      }
    }
    if (elements.btnCloseReasoning && !elements.btnCloseReasoning._hasReasoningListener) {
      elements.btnCloseReasoning._hasReasoningListener = true;
      elements.btnCloseReasoning.addEventListener('click', () => closeReasoningMenu(elements));
    }
    if (!elements.reasoningMenu._hasEscapeListener) {
      elements.reasoningMenu._hasEscapeListener = true;
      elements.reasoningMenu.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        closeReasoningMenu(elements);
        elements.btnReasoning?.focus?.();
      });
    }
    positionReasoningMenu(elements);
    slider?.focus?.();
  }

  function toggleReasoningMenu(elements, appConfig, onSelect, onToggleCheckpoint) {
    if (!elements?.reasoningMenu) return;
    if (elements.reasoningMenu.style.display === 'flex') closeReasoningMenu(elements);
    else openReasoningMenu(elements, appConfig, onSelect, onToggleCheckpoint);
  }

  function updateReasoningUI(elements, level) {
    const normalized = getReasoningLevelFromIntensity(getReasoningIntensity(level));
    if (elements?.reasoningLabel) elements.reasoningLabel.textContent = getReasoningLevelLabel(normalized);
    if (elements?.btnReasoning?.classList) {
      elements.btnReasoning.classList.toggle('active', normalized !== 'none');
      INTENSITY_LEVELS.forEach(name => elements.btnReasoning.classList.toggle(`active-${name}`, normalized === name && name !== 'none'));
    }
    syncReasoningIntensity(elements, normalized);
    syncReasoningGauge(elements, normalized);
  }

  function selectReasoningLevel(elements, _appConfig, level, onLevelChanged) {
    const normalized = getReasoningLevelFromIntensity(getReasoningIntensity(level));
    updateReasoningUI(elements, normalized);
    closeReasoningMenu(elements);
    onLevelChanged?.(normalized);
  }

  return { getReasoningIntensity, getReasoningLevelFromIntensity, getReasoningLevelLabel, syncReasoningIntensity, positionReasoningMenu, openReasoningMenu, closeReasoningMenu, toggleReasoningMenu, selectReasoningLevel, updateReasoningUI, syncCheckpointToggle };
});
