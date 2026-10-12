/** Menú de intensidad de razonamiento y panel del modo proyecto, junto al botón del compositor. */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') module.exports = factory(require('./utils.js'), require('./i18n.js'), require('./icons.js'));
  else root.ChatUIReasoning = factory(root.ChatUtils, root.ChatI18n, root.ChatIcons);
})(typeof self !== 'undefined' ? self : this, function (Utils, I18n, Icons) {
  'use strict';

  const { escapeHtml } = Utils;
  const { t } = I18n;

  const INTENSITY_LEVELS = Object.freeze(['none', 'low', 'medium', 'high', 'xhigh']);
  const LEVEL_LABEL_KEYS = { none: 'reasoning_intensity_none', low: 'reasoning_level_low', medium: 'reasoning_level_medium', high: 'reasoning_level_high', xhigh: 'reasoning_intensity_max' };
  // Acciones cuyo nombre no basta para saber qué hacen.
  const PROJECT_ACTION_TITLES = Object.freeze({ reload: 'project_action_reload_title' });
  // Carpeta personal en Linux, macOS, Termux y Windows: se muestra como ~ para acortar la ruta.
  const HOME_PREFIX = /^(?:\/home\/[^/]+|\/Users\/[^/]+|\/data\/data\/com\.termux\/files\/home|[A-Za-z]:\\Users\\[^\\]+)(?=$|[\\/])/;

  // Manejadores del modo proyecto, fijados en mount().
  let projectHandlers = {};

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

  /** Sitúa el menú encima del botón, dentro de la ventana. */
  function positionReasoningMenu(elements) {
    const menu = elements.reasoningMenu;
    if (menu.style.display === 'none') return;
    const rect = elements.btnReasoning.getBoundingClientRect();
    const width = Math.min(290, window.innerWidth - 16);
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    const viewportHeight = window.visualViewport?.height || window.innerHeight;
    Object.assign(menu.style, {
      position: 'fixed',
      left: `${Math.round(left)}px`,
      width: `${Math.round(width)}px`,
      bottom: `${Math.round(Math.max(8, viewportHeight - rect.top + 8))}px`,
      top: 'auto'
    });
  }

  function closeReasoningMenu(elements) {
    elements.reasoningMenu.style.display = 'none';
    elements.btnReasoning.setAttribute('aria-expanded', 'false');
  }

  function openReasoningMenu(elements, appConfig) {
    elements.reasoningMenu.style.display = 'flex';
    elements.btnReasoning.setAttribute('aria-expanded', 'true');
    syncReasoningIntensity(elements, appConfig.reasoningEffort || 'medium');
    positionReasoningMenu(elements);
    elements.reasoningIntensity.focus();
  }

  function toggleReasoningMenu(elements, appConfig) {
    if (elements.reasoningMenu.style.display === 'flex') closeReasoningMenu(elements);
    else openReasoningMenu(elements, appConfig);
  }

  const shortenHomePath = path => String(path || '').replace(HOME_PREFIX, '~');

  function projectName(cwd) {
    const parts = String(cwd || '').split(/[\\/]+/).filter(Boolean);
    return parts[parts.length - 1] || String(cwd || '');
  }

  /** Acciones disponibles para cada estado del modo proyecto (initialize solo si se puede escribir). */
  function getProjectActions(project, canInitialize) {
    switch (project.status) {
      case 'missing': return [...(canInitialize ? ['initialize'] : []), 'decline'];
      case 'declined': return ['reactivate'];
      case 'ready':
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

  /** Pie del menú: interruptor del modo proyecto, su estado, el directorio y las acciones del estado. */
  function renderProjectPanel(elements, { config, project, canInitialize, canChangeDirectory, busy }) {
    const enabled = config.projectMode === true;
    const actions = enabled ? getProjectActions(project, canInitialize) : [];
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
   * Conecta el menú: el control deslizante llama a `onSelectLevel` con el nivel elegido y el panel
   * del proyecto a `handlers` (toggle, initialize, decline, reactivate, reload, changeDirectory).
   */
  function mount(elements, { onSelectLevel, handlers }) {
    projectHandlers = handlers;
    elements.reasoningIntensity.addEventListener('input', event => {
      const level = getReasoningLevelFromIntensity(event.target.value);
      updateReasoningUI(elements, level);
      onSelectLevel(level);
    });
    elements.btnCloseReasoning.addEventListener('click', () => closeReasoningMenu(elements));
    elements.reasoningMenu.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeReasoningMenu(elements);
      elements.btnReasoning.focus();
    });
    elements.projectModePanel.addEventListener('change', event => {
      if (event.target.id === 'chk-project-mode') projectHandlers.toggle(event.target.checked);
    });
    elements.projectModePanel.addEventListener('click', event => {
      const action = event.target.closest('[data-project-action]')?.dataset.projectAction;
      if (action) projectHandlers[action]();
    });
  }

  return {
    mount,
    getReasoningLevelLabel,
    positionReasoningMenu,
    closeReasoningMenu,
    toggleReasoningMenu,
    updateReasoningUI,
    renderProjectPanel,
    syncProjectIndicator
  };
});
