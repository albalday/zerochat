/** Menú de intensidad de razonamiento, interruptor «Subagentes» y panel del modo proyecto, junto al botón del compositor. */
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
    updateRules: 'project_action_updateRules_title',
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
    elements.chkSubagents.checked = appConfig.subagents === true;
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
      case 'missing': return canInitialize ? ['initialize'] : [];
      // Escribir normas o memoria necesita las herramientas de escritura; leerlas se refresca solo (antes de cada turno).
      case 'ready': return canCompact ? ['updateRules', 'compact'] : [];
      default: return [];
    }
  }

  function getProjectStatusText(config, project) {
    // Sin servidor local no hay carpeta ni herramientas de archivos: se dice aunque el modo proyecto esté apagado.
    if (!project.cwd) return t('project_status_offline');
    if (project.status === 'no_project') return t('project_status_no_project', { name: projectName(project.cwd) });
    if (config.projectMode !== true) return t('project_status_disabled');
    return t(`project_status_${project.status || 'unavailable'}`, { name: projectName(project.cwd), error: project.error || '' });
  }

  /** Marca del botón de razonamiento: ready (proyecto inyectado), warning (activo pero ilegible) o ''. */
  function getProjectIndicator(config, project) {
    if (config.projectMode !== true) return '';
    if (project.status === 'ready') return 'ready';
    return project.status === 'error' || project.status === 'no_access' ? 'warning' : '';
  }

  /** Refleja el proyecto y «Subagentes» en el botón (marca, icono, nombre accesible y tooltip) sin abrir el panel. */
  function syncProjectIndicator(elements, config, project) {
    const button = elements.btnReasoning;
    const indicator = getProjectIndicator(config, project);
    if (indicator) button.setAttribute('data-project-indicator', indicator);
    else button.removeAttribute('data-project-indicator');
    const subagentsOn = config.subagents === true;
    button.toggleAttribute('data-subagents', subagentsOn);
    elements.reasoningSubagentsBadge.toggleAttribute('hidden', !subagentsOn);
    const projectText = indicator ? getProjectStatusText(config, project) : '';
    const subagentsText = subagentsOn ? t('agent_delegate_task_title') : '';
    elements.reasoningProjectLabel.textContent = projectText;
    elements.reasoningSubagentsLabel.textContent = subagentsText;
    const titleParts = [t('reasoning_btn_title'), projectText, subagentsText].filter(Boolean);
    button.setAttribute('title', titleParts.join(' · '));
  }

  /** Página de un chat vacío: proyecto del servidor (ruta completa en el tooltip) y modo proyecto activado o no. */
  function syncWelcomeProject(elements, config, project) {
    const enabled = config.projectMode === true && project.status !== 'no_project';
    const cwd = String(project.cwd || '');
    const place = cwd ? t('welcome_project', { name: projectName(cwd) }) : t('welcome_no_project');
    elements.welcomeProjectText.textContent = `${place} · ${t(enabled ? 'welcome_project_mode_on' : 'welcome_project_mode_off')}`;
    elements.welcomeProject.title = cwd;
    elements.welcomeProject.toggleAttribute('data-project-mode-off', !enabled);
  }

  /** Cuerpo de proyecto del modal: tarjetas de directorio actual y normas en sistema. */
  function renderProjectPanel(elements, { config, project, canInitialize, canCompact, canChangeDirectory, canDeleteProject, busy }) {
    const connected = Boolean(project.cwd);
    const supported = connected && project.status !== 'no_project';
    const enabled = supported && config.projectMode === true;
    const actions = enabled ? getProjectActions(project, { canInitialize, canCompact }) : [];
    const cwd = String(project.cwd || '');
    const changeLabel = escapeHtml(t('project_action_change_directory'));
    const changeButton = canChangeDirectory
      ? `<button type="button" class="btn-project-directory" data-project-action="changeDirectory" title="${changeLabel}" aria-label="${changeLabel}"${busy ? ' disabled' : ''}>${Icons.get('folder', { size: 15 })}</button>`
      : '';
    const deleteLabel = escapeHtml(t('project_action_deleteProject'));
    const deleteButton = canDeleteProject
      ? `<button type="button" class="btn-project-directory btn-project-delete" data-project-action="deleteProject" title="${deleteLabel}" aria-label="${deleteLabel}"${busy ? ' disabled' : ''}>${Icons.get('trash', { size: 15 })}</button>`
      : '';
    const directoryCardHtml = cwd
      ? `<div class="settings-section-card">
        <div class="reasoning-agent-toggle-title">${Icons.get('folder', { size: 13 })}<span>${escapeHtml(t('project_directory_heading'))}</span></div>
        <div class="project-mode-directory"><span class="project-mode-path" title="${escapeHtml(cwd)}">${escapeHtml(shortenHomePath(cwd))}</span>${changeButton}${deleteButton}</div>
      </div>`
      : '';
    let actionsHtml = '';
    if (enabled && project.status === 'missing' && canInitialize) {
      const modeLabel = escapeHtml(t('project_init_mode_label'));
      actionsHtml = `<div class="project-init-controls">
        <select id="project-init-template" class="settings-select" aria-label="${modeLabel}">
          <option value="default">${escapeHtml(t('project_init_mode_software'))}</option>
          <option value="agent">${escapeHtml(t('project_init_mode_agent'))}</option>
        </select>
        <div class="project-mode-actions">
          <button type="button" class="btn-secondary" data-project-action="initialize">${escapeHtml(t('project_action_initialize'))}</button>
        </div>
      </div>`;
    } else if (actions.length) {
      actionsHtml = `<div class="project-mode-actions">${actions.map(action =>
        `<button type="button" class="btn-secondary" data-project-action="${action}"${PROJECT_ACTION_TITLES[action] ? ` title="${escapeHtml(t(PROJECT_ACTION_TITLES[action]))}"` : ''}>${escapeHtml(t(`project_action_${action}`))}</button>`).join('')}</div>`;
    }
    const statusText = getProjectStatusText(config, project);
    const statusAttr = !connected ? 'offline' : (supported ? (enabled ? project.status || '' : 'disabled') : 'no_project');
    const switchTitle = supported ? t('project_mode_tooltip') : statusText;
    elements.projectModePanel.innerHTML = `
      ${directoryCardHtml}
      <div class="settings-section-card">
        <div class="reasoning-agent-toggle-wrapper">
          <div class="reasoning-agent-toggle-info">
            <div class="reasoning-agent-toggle-title">${Icons.get('layers', { size: 13 })}<span>${escapeHtml(t('project_mode_title'))}</span></div>
            <div class="reasoning-agent-toggle-desc project-mode-status" data-project-status="${escapeHtml(statusAttr)}" aria-live="polite">${escapeHtml(statusText)}</div>
          </div>
          <label class="switch switch-sm" title="${escapeHtml(switchTitle)}">
            <input type="checkbox" id="chk-project-mode" aria-label="${escapeHtml(switchTitle)}"${config.projectMode === true && project.status !== 'no_project' ? ' checked' : ''}${supported ? '' : ' disabled'}>
            <span class="slider"></span>
          </label>
        </div>
        ${actionsHtml}
      </div>`;
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
   * Conecta el panel modal: el control deslizante llama a `onSelectLevel` con el nivel elegido, el interruptor
   * «Subagentes» a `onToggleSubagents` y el panel del proyecto a `handlers` (toggle, initialize, compact,
   * updateRules, changeDirectory, deleteProject).
   */
  function mount(elements, { onSelectLevel, onToggleSubagents, handlers }) {
    projectHandlers = handlers;
    const modal = getModal(elements);
    elements.reasoningIntensity.addEventListener('input', event => {
      const level = getReasoningLevelFromIntensity(event.target.value);
      updateReasoningUI(elements, level);
      onSelectLevel(level);
    });
    elements.btnCloseReasoning.addEventListener('click', () => closeReasoningMenu(elements));
    elements.chkSubagents.addEventListener('change', event => onToggleSubagents(event.target.checked));
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
      if (event.target.id === 'chk-project-mode' && !event.target.disabled) projectHandlers.toggle(event.target.checked);
    });
    elements.projectModePanel.addEventListener('click', event => {
      const action = event.target.closest('[data-project-action]')?.dataset.projectAction;
      if (!action) return;
      if (['changeDirectory', 'deleteProject', 'initialize', 'compact', 'updateRules'].includes(action)) {
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
