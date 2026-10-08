/** UI del selector compacto de intensidad de razonamiento. */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') module.exports = factory(require('./utils.js'));
  else root.ChatUIReasoning = factory(root.ChatUtils);
})(typeof self !== 'undefined' ? self : this, function (Utils) {
  'use strict';

  const INTENSITY_LEVELS = Object.freeze(['none', 'low', 'medium', 'high', 'xhigh']);

  const { resolveDep, escapeHtml } = Utils;

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

  function openReasoningMenu(elements, appConfig, onSelect) {
    if (!elements?.reasoningMenu) return;
    elements.reasoningMenu.style.display = 'flex';
    elements.btnReasoning?.setAttribute?.('aria-expanded', 'true');
    syncReasoningIntensity(elements, appConfig?.reasoningEffort || 'medium');
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

  function toggleReasoningMenu(elements, appConfig, onSelect) {
    if (!elements?.reasoningMenu) return;
    if (elements.reasoningMenu.style.display === 'flex') closeReasoningMenu(elements);
    else openReasoningMenu(elements, appConfig, onSelect);
  }

  function projectName(cwd) {
    const parts = String(cwd || '').split(/[\\/]+/).filter(Boolean);
    return parts[parts.length - 1] || String(cwd || '');
  }

  /** Acciones disponibles para cada estado del modo proyecto (initialize solo si se puede escribir). */
  function getProjectActions(project = {}, options = {}) {
    switch (project.status) {
      case 'missing': return [...(options.canInitialize ? ['initialize'] : []), 'decline'];
      case 'declined': return ['reactivate'];
      case 'ready':
      case 'error':
      case 'no_access': return ['reload'];
      default: return [];
    }
  }

  function getProjectStatusText(config = {}, project = {}) {
    if (config.projectMode !== true) return t('project_status_disabled');
    const params = { name: projectName(project.cwd), error: project.error || '' };
    return t(`project_status_${project.status || 'unavailable'}`, params);
  }

  /** Marca del botón de razonamiento: ready (proyecto inyectado), warning (activo pero ilegible) o ''. */
  function getProjectIndicator(config = {}, project = {}) {
    if (config.projectMode !== true) return '';
    if (project.status === 'ready') return 'ready';
    if (project.status === 'error' || project.status === 'no_access') return 'warning';
    return '';
  }

  /** Refleja el estado del proyecto en el botón (punto, nombre accesible y tooltip) sin abrir el panel. */
  function syncProjectIndicator(elements, config = {}, project = {}) {
    const button = elements?.btnReasoning;
    if (!button) return;
    const indicator = getProjectIndicator(config, project);
    if (indicator) button.setAttribute('data-project-indicator', indicator);
    else button.removeAttribute('data-project-indicator');
    const text = indicator ? getProjectStatusText(config, project) : '';
    if (elements.reasoningProjectLabel) elements.reasoningProjectLabel.textContent = text;
    const baseTitle = t('reasoning_btn_title');
    button.setAttribute('title', text ? `${baseTitle} · ${text}` : baseTitle);
  }

  /**
   * Pinta el pie del panel de razonamiento con el interruptor del modo proyecto, su estado y
   * las acciones del estado actual. Los manejadores se enlazan una vez por delegación.
   */
  function renderProjectPanel(elements, { config = {}, project = {}, canInitialize = false, handlers = {} } = {}) {
    const panel = elements?.projectModePanel;
    if (!panel) return;
    panel._projectHandlers = handlers;
    const Icons = resolveDep('ChatIcons', './icons.js');
    const icon = Icons?.get ? Icons.get('folder', { size: 13 }) : '';
    const enabled = config.projectMode === true;
    const actions = enabled ? getProjectActions(project, { canInitialize: canInitialize && typeof handlers.initialize === 'function' }) : [];
    panel.innerHTML = `
      <div class="reasoning-agent-toggle-wrapper">
        <div class="reasoning-agent-toggle-info">
          <div class="reasoning-agent-toggle-title">${icon}<span>${escapeHtml(t('project_mode_title'))}</span></div>
          <div class="reasoning-agent-toggle-desc project-mode-status" data-project-status="${escapeHtml(enabled ? project.status || '' : 'disabled')}" aria-live="polite">${escapeHtml(getProjectStatusText(config, project))}</div>
        </div>
        <label class="switch switch-sm" title="${escapeHtml(t('project_mode_tooltip'))}">
          <input type="checkbox" id="chk-project-mode" aria-label="${escapeHtml(t('project_mode_tooltip'))}"${enabled ? ' checked' : ''}>
          <span class="slider"></span>
        </label>
      </div>
      ${actions.length ? `<div class="project-mode-actions">${actions.map(action =>
        `<button type="button" class="btn-secondary" data-project-action="${action}">${escapeHtml(t(`project_action_${action}`))}</button>`).join('')}</div>` : ''}`;
    if (!panel._hasProjectListeners) {
      panel._hasProjectListeners = true;
      panel.addEventListener('change', event => {
        if (event.target?.id === 'chk-project-mode') panel._projectHandlers?.toggle?.(event.target.checked);
      });
      panel.addEventListener('click', event => {
        const action = event.target?.closest?.('[data-project-action]')?.dataset?.projectAction;
        if (action) panel._projectHandlers?.[action]?.();
      });
    }
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

  return { getReasoningIntensity, getReasoningLevelFromIntensity, getReasoningLevelLabel, syncReasoningIntensity, positionReasoningMenu, openReasoningMenu, closeReasoningMenu, toggleReasoningMenu, selectReasoningLevel, updateReasoningUI, getProjectActions, getProjectStatusText, renderProjectPanel, getProjectIndicator, syncProjectIndicator };
});
