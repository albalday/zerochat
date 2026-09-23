/** Tool autocontenida: finish_task. */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') module.exports = factory();
  else root.ChatBuiltinFinishTaskTool = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const definition = {
    name: 'finish_task',
    description: 'Formally signals task completion by the agent, summarizing the work done and verification performed.',
    parameters: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'Detailed summary of the changes made, tests executed, and validation results.'
        }
      },
      required: ['summary']
    }
  };

  const FINISH_ICON_SVG = '<svg class="ui-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 14 14"></polyline></svg>';

  function createCardWrapper(ui) {
    if (ui?.createCardWrapper) return ui.createCardWrapper();
    const doc = ui?.document || (typeof document !== 'undefined' ? document : null);
    if (!doc) return null;
    const cardDiv = doc.createElement('div');
    cardDiv.className = 'tool-card-wrapper';
    return cardDiv;
  }

  const safeEscapeHtml = (value) => String(value || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function createLiveCard(args, ui) {
    const cardDiv = createCardWrapper(ui);
    if (!cardDiv) return null;
    const Markdown = ui?.markdown || (typeof window !== 'undefined' && window.ChatMarkdown) || (typeof window !== 'undefined' && window.ChatUtils) || { escapeHtml: safeEscapeHtml };
    const t = ui?.t || ((key) => key);
    const spinner = ui?.SPINNER_SVG || '';
    const chevron = ui?.CHEVRON_SVG || '';
    const title = t('tool_finish_task_title') || 'Finalización de tarea';
    const statusText = t('tool_finish_task_loading') || 'Cerrando tarea...';

    cardDiv.innerHTML = `<div class="tool-execution-card agent-finish-card"><div class="tool-card-header"><div class="tool-card-title"><span>${FINISH_ICON_SVG}</span><span>${title}</span></div><div class="tool-card-header-actions"><span class="tool-card-badge status-loading">${spinner} <span>${statusText}</span></span><button type="button" class="btn-tool-collapse" title="${t('tool_btn_collapse') || 'Minimizar'}">${chevron}</button></div></div><div class="tool-card-collapsible-body"><div class="tool-card-result"><div class="finish-summary-label" style="font-weight: 600; opacity: 0.85; margin-bottom: 4px;">${t('tool_finish_task_summary') || 'Resumen de ejecución:'}</div><div class="finish-summary-text" style="white-space: pre-wrap; font-size: 0.9em;">${Markdown.escapeHtml(args?.summary || '')}</div></div></div></div>`;
    return cardDiv;
  }

  function updateLiveCard(cardDiv, args, result = {}, elapsedMs = 0, ui) {
    if (!cardDiv) return;
    const Markdown = ui?.markdown || (typeof window !== 'undefined' && window.ChatMarkdown) || (typeof window !== 'undefined' && window.ChatUtils) || { escapeHtml: safeEscapeHtml };
    const t = ui?.t || ((key) => key);
    const checkSvg = ui?.CHECK_SVG || '';
    const errorSvg = ui?.ERROR_SVG || '';
    const success = result?.success !== false && !result?.error;
    const summary = result?.summary || args?.summary || '';

    const badge = cardDiv.querySelector('.tool-card-badge');
    if (badge) {
      badge.className = `tool-card-badge ${success ? 'status-success' : 'status-error'}`;
      const label = success
        ? (t('tool_finish_task_completed') || 'Tarea finalizada con éxito')
        : (result?.error || 'Error');
      badge.innerHTML = success
        ? `${checkSvg} <span>${label} (${elapsedMs || 0}ms)</span>`
        : `${errorSvg} <span>${result?.error || 'Error'}</span>`;
    }

    const body = cardDiv.querySelector('.tool-card-result');
    if (body) {
      body.innerHTML = `<div class="finish-summary-label" style="font-weight: 600; opacity: 0.85; margin-bottom: 4px;">${t('tool_finish_task_summary') || 'Resumen de ejecución:'}</div><div class="finish-summary-text" style="white-space: pre-wrap; font-size: 0.9em;">${Markdown.escapeHtml(summary)}</div>`;
    }
  }

  function renderHistoricalCard(cardDiv, args, result = {}, ui) {
    return updateLiveCard(cardDiv, args, result, 0, ui);
  }

  function createTool(Tool) {
    if (typeof Tool !== 'function') throw new Error('La clase Tool es necesaria para crear finish_task.');
    return new Tool({
      name: definition.name,
      category: 'builtin',
      description: definition.description,
      parameters: definition.parameters,
      settings: {
        id: definition.name,
        titleKey: 'tool_finish_task_title',
        descKey: 'tool_finish_task_loading',
        defaultEnabled: true
      },
      promptGuide: () => '- `finish_task(summary="...")`: Signals successful completion of the user request and summarizes actions performed.',
      async execute(args) {
        const summary = typeof args?.summary === 'string' ? args.summary.trim() : '';
        if (!summary) {
          return {
            success: false,
            error: 'summary is required to complete the task.'
          };
        }

        return {
          success: true,
          finishTask: true,
          summary
        };
      },
      result: {
        toModel: (_args, result) => typeof result === 'string' ? result : JSON.stringify(result || {}),
        toMarkdown: (args, result) => {
          const text = result?.summary || args?.summary || '';
          return `> **finish_task** [Completado]\n> ${text}\n\n`;
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

