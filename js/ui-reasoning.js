/** Menú de intensidad de razonamiento y panel del modo proyecto, junto al botón del compositor. */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') module.exports = factory(require('./utils.js'), require('./i18n.js'), require('./icons.js'));
  else root.ChatUIReasoning = factory(root.ChatUtils, root.ChatI18n, root.ChatIcons);
})(typeof self !== 'undefined' ? self : this, function (Utils, I18n, Icons) {
  'use strict';

  const { escapeHtml, projectName } = Utils;
  const { t } = I18n;

  const INTENSITY_LEVELS = Object.freeze(['none', 'low', 'medium', 'high', 'xhigh']);
  const LEVEL_LABEL_KEYS = { none: 'reasoning_intensity_none', low: 'reasoning_level_low', medium: 'reasoning_level_medium', high: 'reasoning_level_high', xhigh: 'reasoning_intensity_max' };
  // Acciones cuyo nombre no basta para saber qué hacen.
  const PROJECT_ACTION_TITLES = Object.freeze({
    reload: 'project_action_reload_title',
    compact: 'project_action_compact_title'
  });
  // Carpeta personal en Linux, macOS, Termux y Windows: se muestra como ~ para acortar la ruta.
  const HOME_PREFIX = /^(?:\/home\/[^/]+|\/Users\/[^/]+|\/data\/data\/com\.termux\/files\/home|[A-Za-z]:\\Users\\[^\\]+)(?=$|[\\/])/;

  // Manejadores del modo proyecto, fijados en mount().
  let projectHandlers = {};

  const getModal = elements => elements?.reasoningModal;

  function getReasoningIntensity(level) {
    const index = INTENSITY_LEVELS.indexOf(String(level || 'none').toLowerCase().trim());
    return index >= 0 ? index : 0;
  }

  function getReasoningLevelFromIntensity(intensity) {
    const parsed = Number.parseInt(intensity, 10);
    return INTENSITY_LEVELS[Math.max(0, Math.min(INTENSITY_LEVELS.length - 1, Number.isFinite(parsed) ? parsed : 0))];
  }

  const normalizeLevel = level => getReasoningLevelFromIntensity(getReasoningIntensity(level));
  const getReasoningLevelLabel = level => t(LEVEL_LABEL_KEYS[normalizeLevel(level)]);

  function syncReasoningIntensity(elements, level) {
    const intensity = getReasoningIntensity(level);
    const label = getReasoningLevelLabel(level);
    elements.reasoningIntensity.value = String(intensity);
    elements.reasoningIntensity.style.setProperty('--reasoning-intensity', `${intensity * 25}%`);
    elements.reasoningIntensity.setAttribute('aria-valuetext', label);
    elements.reasoningIntensityValue.textContent = label;
  }

  function closeReasoningMenu(elements) {
    const modal = getModal(elements);
    if (modal) {
      if (typeof modal.close === 'function' && modal.open) {
        modal.close();
      }
      modal.hidden = true;
    }
    elements.btnReasoning.setAttribute('aria-expanded', 'false');
  }

  function openReasoningMenu(elements, appConfig) {
    const modal = getModal(elements);
    if (!modal) return;
    modal.hidden = false;
    if (typeof modal.showModal === 'function' && !modal.open) {
      modal.showModal();
    }
    elements.btnReasoning.setAttribute('aria-expanded', 'true');
    syncReasoningIntensity(elements, appConfig.reasoningEffort || 'medium');
    elements.reasoningIntensity.focus();
  }

  function toggleReasoningMenu(elements, appConfig) {
    const modal = getModal(elements);
    const isOpen = modal && (modal.open || !modal.hidden);
    if (isOpen) closeReasoningMenu(elements);
    else openReasoningMenu(elements, appConfig);
  }

  const shortenHomePath = path => String(path || '').replace(HOME_PREFIX, '~');

  /** Acciones disponibles para cada estado del modo proyecto (initialize y compact solo si se puede escribir). */
  function getProjectActions(project, { canInitialize = false, canCompact = false } = {}) {
    switch (project.status) {
      case 'missing': return [...(canInitialize ? ['initialize'] : []), 'decline'];
      case 'declined': return ['reactivate'];
      case 'ready': return ['reload', ...(canCompact ? ['compact'] : [])];
      case 'error':
      case 'no_access': return ['reload'];
      default: return [];
    }
  }

  function getProjectStatusText(config, project) {
    if (config.projectMode !== true) return t('project_status_disabled');
    return t(`project_status_${project.status || 'unavailable'}`, { name: projectName(project.cwd), error: project.error || '' });
  }

  /** Marca del botón de razonamiento: ready (proyecto inyectado), warning (activo pero ilegible) o ''. */
  function getProjectIndicator(config, project) {
    if (config.projectMode !== true) return '';
    if (project.status === 'ready') return 'ready';
    return project.status === 'error' || project.status === 'no_access' ? 'warning' : '';
  }

  /** Refleja el estado del proyecto en el botón (punto, nombre accesible y tooltip) sin abrir el panel. */
  function syncProjectIndicator(elements, config, project) {
    const button = elements.btnReasoning;
    const indicator = getProjectIndicator(config, project);
    if (indicator) button.setAttribute('data-project-indicator', indicator);
    else button.removeAttribute('data-project-indicator');
    const text = indicator ? getProjectStatusText(config, project) : '';
    elements.reasoningProjectLabel.textContent = text;
    const baseTitle = t('reasoning_btn_title');
    button.setAttribute('title', text ? `${baseTitle} · ${text}` : baseTitle);
  }

  /** Página de un chat vacío: proyecto del servidor (ruta completa en el tooltip) y modo proyecto activado o no. */
  function syncWelcomeProject(elements, config, project) {
    const enabled = config.projectMode === true;
    const cwd = String(project.cwd || '');
    const place = cwd ? t('welcome_project', { name: projectName(cwd) }) : t('welcome_no_project');
    elements.welcomeProjectText.textContent = `${place} · ${t(enabled ? 'welcome_project_mode_on' : 'welcome_project_mode_off')}`;
    elements.welcomeProject.title = cwd;
    elements.welcomeProject.toggleAttribute('data-project-mode-off', !enabled);
  }

  /** Pie del modal: interruptor del modo proyecto, su estado, el directorio y las acciones del estado. */
  function renderProjectPanel(elements, { config, project, canInitialize, canCompact, canChangeDirectory, busy }) {
    const enabled = config.projectMode === true;
    const actions = enabled ? getProjectActions(project, { canInitialize, canCompact }) : [];
    // El directorio es la base de todas las herramientas locales: se muestra aunque el modo esté apagado.
    const cwd = String(project.cwd || '');
    const changeLabel = escapeHtml(t('project_action_change_directory'));
    const changeButton = canChangeDirectory
      ? `<button type="button" class="btn-project-directory" data-project-action="changeDirectory" title="${changeLabel}" aria-label="${changeLabel}"${busy ? ' disabled' : ''}>${Icons.get('edit', { size: 15 })}</button>`
      : '';
    const directoryHtml = cwd
      ? `<div class="project-mode-directory"><span class="project-mode-path" title="${escapeHtml(cwd)}">${escapeHtml(shortenHomePath(cwd))}</span>${changeButton}</div>`
      : '';
    const actionsHtml = actions.length
      ? `<div class="project-mode-actions">${actions.map(action =>
        `<button type="button" class="btn-secondary" data-project-action="${action}"${PROJECT_ACTION_TITLES[action] ? ` title="${escapeHtml(t(PROJECT_ACTION_TITLES[action]))}"` : ''}>${escapeHtml(t(`project_action_${action}`))}</button>`).join('')}</div>`
      : '';
    elements.projectModePanel.innerHTML = `
      <div class="reasoning-agent-toggle-wrapper">
        <div class="reasoning-agent-toggle-info">
          <div class="reasoning-agent-toggle-title">${Icons.get('folder', { size: 13 })}<span>${escapeHtml(t('project_mode_title'))}</span></div>
          <div class="reasoning-agent-toggle-desc project-mode-status" data-project-status="${escapeHtml(enabled ? project.status || '' : 'disabled')}" aria-live="polite">${escapeHtml(getProjectStatusText(config, project))}</div>
        </div>
        <label class="switch switch-sm" title="${escapeHtml(t('project_mode_tooltip'))}">
          <input type="checkbox" id="chk-project-mode" aria-label="${escapeHtml(t('project_mode_tooltip'))}"${enabled ? ' checked' : ''}>
          <span class="slider"></span>
        </label>
      </div>
      ${directoryHtml}
      ${actionsHtml}`;
  }

  function updateReasoningUI(elements, level) {
    const normalized = normalizeLevel(level);
    elements.reasoningLabel.textContent = getReasoningLevelLabel(normalized);
    elements.btnReasoning.classList.toggle('active', normalized !== 'none');
    INTENSITY_LEVELS.forEach(name => elements.btnReasoning.classList.toggle(`active-${name}`, normalized === name && name !== 'none'));
    syncReasoningIntensity(elements, normalized);
    elements.btnReasoning.querySelector('#reasoning-gauge-needle').setAttribute('transform', `rotate(${-60 + getReasoningIntensity(normalized) * 30} 12 15)`);
  }

  /**
   * Conecta el panel modal: el control deslizante llama a `onSelectLevel` con el nivel elegido y el panel
   * del proyecto a `handlers` (toggle, initialize, compact, decline, reactivate, reload, changeDirectory).
   */
  function mount(elements, { onSelectLevel, handlers }) {
    projectHandlers = handlers;
    const modal = getModal(elements);
    elements.reasoningIntensity.addEventListener('input', event => {
      const level = getReasoningLevelFromIntensity(event.target.value);
      updateReasoningUI(elements, level);
      onSelectLevel(level);
    });
    elements.btnCloseReasoning.addEventListener('click', () => closeReasoningMenu(elements));
    if (modal) {
      modal.addEventListener('cancel', event => {
        event.preventDefault();
        closeReasoningMenu(elements);
        elements.btnReasoning.focus();
      });
      modal.addEventListener('close', () => {
        closeReasoningMenu(elements);
      });
      modal.addEventListener('click', event => {
        if (event.target === modal) {
          closeReasoningMenu(elements);
          elements.btnReasoning.focus();
        }
      });
    }
    elements.projectModePanel.addEventListener('change', event => {
      if (event.target.id === 'chk-project-mode') projectHandlers.toggle(event.target.checked);
    });
    elements.projectModePanel.addEventListener('click', event => {
      const action = event.target.closest('[data-project-action]')?.dataset.projectAction;
      if (!action) return;
      if (['decline', 'changeDirectory', 'initialize', 'compact'].includes(action)) {
        closeReasoningMenu(elements);
      }
      projectHandlers[action]?.();
    });
  }

  return {
    mount,
    getReasoningLevelLabel,
    closeReasoningMenu,
    toggleReasoningMenu,
    updateReasoningUI,
    renderProjectPanel,
    syncProjectIndicator,
    syncWelcomeProject
  };
});
