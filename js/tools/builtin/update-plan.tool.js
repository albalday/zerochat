/** Tool autocontenida: update_plan. */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') module.exports = factory();
  else root.ChatBuiltinUpdatePlanTool = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const definition = {
    name: 'update_plan',
    description: 'Updates the visible agent work plan and task statuses to track progress in the UI.',
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          description: 'Ordered list of tasks with title and status.',
          items: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
                description: 'Description of the specific goal or task.'
              },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'completed', 'failed'],
                description: 'Current execution status of the task.'
              }
            },
            required: ['title', 'status']
          }
        }
      },
      required: ['tasks']
    }
  };

  const PLAN_ICON_SVG = '<svg class="ui-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"></path><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path></svg>';
  const TASK_COMPLETED_SVG = '<svg class="ui-icon status-icon-completed" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--success-color, #22c55e)" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>';
  const TASK_IN_PROGRESS_SVG = '<svg class="ui-icon status-icon-progress" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--primary-color, #3b82f6)" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>';
  const TASK_PENDING_SVG = '<svg class="ui-icon status-icon-pending" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted, #94a3b8)" stroke-width="2"><circle cx="12" cy="12" r="9"></circle></svg>';
  const TASK_FAILED_SVG = '<svg class="ui-icon status-icon-failed" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--error-color, #ef4444)" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>';

  function createCardWrapper(ui) {
    if (ui?.createCardWrapper) return ui.createCardWrapper();
    const doc = ui?.document || (typeof document !== 'undefined' ? document : null);
    if (!doc) return null;
    const cardDiv = doc.createElement('div');
    cardDiv.className = 'tool-card-wrapper';
    return cardDiv;
  }

  const safeEscapeHtml = (value) => String(value || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function getStatusIcon(status) {
    switch (status) {
      case 'completed': return TASK_COMPLETED_SVG;
      case 'in_progress': return TASK_IN_PROGRESS_SVG;
      case 'failed': return TASK_FAILED_SVG;
      default: return TASK_PENDING_SVG;
    }
  }

  function renderTaskListHtml(tasks, Markdown) {
    if (!Array.isArray(tasks) || tasks.length === 0) {
      return '<div class="plan-empty" style="font-size: 0.9em; opacity: 0.7;">(Sin tareas registradas)</div>';
    }
    const items = tasks.map((t, idx) => {
      const icon = getStatusIcon(t.status);
      const title = Markdown.escapeHtml(t.title || `Tarea ${idx + 1}`);
      const isCompleted = t.status === 'completed';
      const textStyle = isCompleted ? 'text-decoration: line-through; opacity: 0.75;' : '';
      return `<li class="plan-task-item plan-status-${safeEscapeHtml(t.status)}" style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px; font-size: 0.88em;"><span class="task-status-icon">${icon}</span><span class="task-title" style="${textStyle}">${title}</span></li>`;
    });
    return `<ul class="plan-task-list" style="list-style: none; padding-left: 0; margin: 4px 0;">${items.join('')}</ul>`;
  }

  function createLiveCard(args, ui) {
    const cardDiv = createCardWrapper(ui);
    if (!cardDiv) return null;
    const Markdown = ui?.markdown || (typeof window !== 'undefined' && window.ChatMarkdown) || (typeof window !== 'undefined' && window.ChatUtils) || { escapeHtml: safeEscapeHtml };
    const t = ui?.t || ((key) => key);
    const spinner = ui?.SPINNER_SVG || '';
    const chevron = ui?.CHEVRON_SVG || '';
    const title = t('tool_update_plan_title') || 'Plan de trabajo del agente';
    const statusText = t('tool_update_plan_loading') || 'Actualizando plan de tareas...';
    const rawTasks = Array.isArray(args?.tasks) ? args.tasks : [];

    cardDiv.innerHTML = `<div class="tool-execution-card agent-plan-card"><div class="tool-card-header"><div class="tool-card-title"><span>${PLAN_ICON_SVG}</span><span>${title}</span></div><div class="tool-card-header-actions"><span class="tool-card-badge status-loading">${spinner} <span>${statusText}</span></span><button type="button" class="btn-tool-collapse" title="${t('tool_btn_collapse') || 'Minimizar'}">${chevron}</button></div></div><div class="tool-card-collapsible-body"><div class="tool-card-result">${renderTaskListHtml(rawTasks, Markdown)}</div></div></div>`;
    return cardDiv;
  }

  function updateLiveCard(cardDiv, args, result = {}, elapsedMs = 0, ui) {
    if (!cardDiv) return;
    const Markdown = ui?.markdown || (typeof window !== 'undefined' && window.ChatMarkdown) || (typeof window !== 'undefined' && window.ChatUtils) || { escapeHtml: safeEscapeHtml };
    const t = ui?.t || ((key) => key);
    const checkSvg = ui?.CHECK_SVG || '';
    const errorSvg = ui?.ERROR_SVG || '';
    const tasks = Array.isArray(result?.tasks) ? result.tasks : (Array.isArray(args?.tasks) ? args.tasks : []);
    const success = result?.success !== false && !result?.error;
    const completedCount = tasks.filter(t => t.status === 'completed').length;

    const badge = cardDiv.querySelector('.tool-card-badge');
    if (badge) {
      badge.className = `tool-card-badge ${success ? 'status-success' : 'status-error'}`;
      const label = success
        ? `${t('tool_update_plan_updated') || 'Plan actualizado'} (${completedCount}/${tasks.length})`
        : (result?.error || 'Error');
      badge.innerHTML = success
        ? `${checkSvg} <span>${label} (${elapsedMs || 0}ms)</span>`
        : `${errorSvg} <span>${result?.error || 'Error'}</span>`;
    }

    const body = cardDiv.querySelector('.tool-card-result');
    if (body) {
      body.innerHTML = renderTaskListHtml(tasks, Markdown);
    }
  }

  function renderHistoricalCard(cardDiv, args, result = {}, ui) {
    return updateLiveCard(cardDiv, args, result, 0, ui);
  }

  function createTool(Tool) {
    if (typeof Tool !== 'function') throw new Error('La clase Tool es necesaria para crear update_plan.');
    return new Tool({
      name: definition.name,
      category: 'builtin',
      description: definition.description,
      parameters: definition.parameters,
      settings: {
        id: definition.name,
        titleKey: 'tool_update_plan_title',
        descKey: 'tool_update_plan_loading',
        defaultEnabled: true
      },
      promptGuide: () => '- `update_plan(tasks=[{"title": "...", "status": "pending|in_progress|completed|failed"}])`: Updates the visible agent work plan and task checklist.',
      async execute(args, context = {}) {
        if (!args || !Array.isArray(args.tasks)) {
          return {
            success: false,
            error: 'tasks debe ser un array con objetos { title: string, status: string }'
          };
        }

        const validStatuses = new Set(['pending', 'in_progress', 'completed', 'failed']);
        const normalizedTasks = args.tasks.map(t => ({
          title: String(t?.title || '').trim(),
          status: validStatuses.has(t?.status) ? t.status : 'pending'
        })).filter(t => t.title.length > 0);

        const stateService = context?.services?.state || (typeof window !== 'undefined' && window.ChatState);
        if (stateService && typeof stateService.setAgentPlan === 'function') {
          try {
            stateService.setAgentPlan(normalizedTasks);
          } catch (_) {}
        }

        return {
          success: true,
          tasks: normalizedTasks,
          count: normalizedTasks.length,
          completed: normalizedTasks.filter(t => t.status === 'completed').length
        };
      },
      result: {
        toModel: (_args, result) => typeof result === 'string' ? result : JSON.stringify(result || {}),
        toMarkdown: (_args, result) => {
          const tasks = Array.isArray(result?.tasks) ? result.tasks : [];
          const lines = tasks.map(t => {
            const marker = t.status === 'completed' ? '[x]' : (t.status === 'in_progress' ? '[-]' : '[ ]');
            return `> - ${marker} ${t.title} (${t.status})`;
          });
          return `> **update_plan** [${result?.completed || 0}/${tasks.length} completadas]\n${lines.join('\n')}\n\n`;
        }
      },
      displayMode: 'collapsed',
      view: {
        id: definition.name,
        displayMode: 'collapsed',
        createLiveCard,
        updateLiveCard,
        renderHistoricalCard
      }
    });
  }

  const toolModule = {
    id: definition.name,
    definition,
    displayMode: 'collapsed',
    createTool,
    view: {
      id: definition.name,
      displayMode: 'collapsed',
      createLiveCard,
      updateLiveCard,
      renderHistoricalCard
    }
  };

  let manifestApi = null;
  if (typeof window !== 'undefined' && window.ChatToolManifest) {
    manifestApi = window.ChatToolManifest;
  } else if (typeof require !== 'undefined') {
    try {
      manifestApi = require('../tool-manifest.js');
    } catch (e) {}
  }

  if (manifestApi?.builtin && !manifestApi.builtin.has(toolModule.id)) {
    manifestApi.builtin.register(toolModule);
  }

  return toolModule;
});

