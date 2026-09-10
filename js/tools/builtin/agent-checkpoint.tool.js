/** Tool autocontenida: agent_checkpoint. */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') module.exports = factory();
  else root.ChatBuiltinAgentCheckpointTool = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const definition = {
    name: 'agent_checkpoint',
    description: 'Agentic checkpoint for consolidating findings and recording the next step: invoke it after querying sources, verifying whether information is sufficient, or validating the final answer.',
    parameters: {
      type: 'object',
      properties: {
        findings: {
          type: 'string',
          description: 'Structured, concise summary of the data, figures, or confirmed facts gathered so far (working memory).'
        },
        ready_to_respond: {
          type: 'boolean',
          description: 'Whether enough information is available to formulate the final answer to the user (true) or more queries are still needed (false).'
        },
        missing_info: {
          type: 'string',
          description: 'Specific data or contrasts that still need to be investigated (only when ready_to_respond is false).'
        },
        next_action: {
          type: 'string',
          description: 'Next hypothesis, tool, or specific query planned (only when ready_to_respond is false).'
        }
      },
      required: ['findings', 'ready_to_respond']
    }
  };

  const CHECKPOINT_ICON_SVG = '<svg class="ui-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6H5a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h13l4-3.5L18 6Z"></path><line x1="12" y1="13" x2="12" y2="21"></line></svg>';

  function createCardWrapper(ui) {
    if (ui?.createCardWrapper) return ui.createCardWrapper();
    const doc = ui?.document || (typeof document !== 'undefined' ? document : null);
    if (!doc) return null;
    const cardDiv = doc.createElement('div');
    cardDiv.className = 'tool-card-wrapper';
    return cardDiv;
  }

  function createLiveCard(args, ui) {
    const cardDiv = createCardWrapper(ui);
    if (!cardDiv) return null;
    const Markdown = ui?.markdown || { escapeHtml: (v) => String(v || '') };
    const t = ui?.t || ((key) => key);
    const spinner = ui?.SPINNER_SVG || '';
    const chevron = ui?.CHEVRON_SVG || '';
    const title = t('tool_agent_checkpoint_title') || 'Punto de control agéntico';
    const statusText = t('tool_agent_checkpoint_loading') || 'Consolidando hallazgos...';

    cardDiv.innerHTML = `<div class="tool-execution-card agent-checkpoint-card"><div class="tool-card-header"><div class="tool-card-title"><span>${CHECKPOINT_ICON_SVG}</span><span>${title}</span></div><div class="tool-card-header-actions"><span class="tool-card-badge status-loading">${spinner} <span>${statusText}</span></span><button type="button" class="btn-tool-collapse" title="${t('tool_btn_collapse') || 'Minimizar'}">${chevron}</button></div></div><div class="tool-card-collapsible-body"><div class="tool-card-result"><div class="checkpoint-findings"><strong>${t('tool_agent_checkpoint_findings') || 'Hallazgos clave:'}</strong><div class="checkpoint-findings-text">${Markdown.escapeHtml(args?.findings || '')}</div></div></div></div></div>`;
    return cardDiv;
  }

  function updateLiveCard(cardDiv, args, result = {}, elapsedMs = 0, ui) {
    if (!cardDiv) return;
    const Markdown = ui?.markdown || { escapeHtml: (v) => String(v || '') };
    const t = ui?.t || ((key) => key);
    const checkSvg = ui?.CHECK_SVG || '';
    const errorSvg = ui?.ERROR_SVG || '';
    const isReady = result?.action === 'conclude' || args?.ready_to_respond === true || args?.ready_to_respond === 'true';
    const success = result?.success !== false && !result?.error;

    const badge = cardDiv.querySelector('.tool-card-badge');
    if (badge) {
      badge.className = `tool-card-badge ${success ? 'status-success' : 'status-error'}`;
      const label = isReady
        ? (t('tool_agent_checkpoint_ready') || 'Listo para responder')
        : (t('tool_agent_checkpoint_continue') || 'Continuando análisis');
      badge.innerHTML = success
        ? `${checkSvg} <span>${label} (${elapsedMs || 0}ms)</span>`
        : `${errorSvg} <span>${result?.error || 'Error'}</span>`;
    }

    const body = cardDiv.querySelector('.tool-card-result');
    if (body) {
      const findings = result?.findings || args?.findings || '';
      const missing = result?.missing_info || args?.missing_info || '';
      const nextAction = result?.next_action || args?.next_action || '';
      const guidance = result?.guidance || '';

      let contentHtml = `<div class="checkpoint-findings" style="margin-bottom: 6px;"><div class="checkpoint-label" style="font-weight: 600; opacity: 0.85; margin-bottom: 2px;">${t('tool_agent_checkpoint_findings') || 'Hallazgos clave:'}</div><div class="checkpoint-text" style="white-space: pre-wrap; font-size: 0.9em;">${Markdown.escapeHtml(findings)}</div></div>`;

      if (missing) {
        contentHtml += `<div class="checkpoint-missing" style="margin-bottom: 6px; font-size: 0.88em;"><span style="font-weight: 600; opacity: 0.85;">${t('tool_agent_checkpoint_missing') || 'Información faltante:'} </span><span>${Markdown.escapeHtml(missing)}</span></div>`;
      }

      if (nextAction) {
        contentHtml += `<div class="checkpoint-next" style="margin-bottom: 6px; font-size: 0.88em;"><span style="font-weight: 600; opacity: 0.85;">${t('tool_agent_checkpoint_next') || 'Siguiente hipótesis / paso:'} </span><span>${Markdown.escapeHtml(nextAction)}</span></div>`;
      }

      if (guidance) {
        contentHtml += `<div class="checkpoint-guidance" style="padding-top: 4px; border-top: 1px dashed var(--border-color, #444); font-size: 0.85em; opacity: 0.9;"><em>${Markdown.escapeHtml(guidance)}</em></div>`;
      }

      body.innerHTML = contentHtml;
    }
  }

  function renderHistoricalCard(args, toolMessage, ui) {
    const cardDiv = createLiveCard(args, ui);
    if (!cardDiv) return null;
    let result = {};
    if (toolMessage?.content) {
      try {
        result = JSON.parse(toolMessage.content);
      } catch (e) {
        result = { findings: toolMessage.content };
      }
    }
    updateLiveCard(cardDiv, args, result, 0, ui);
    return cardDiv;
  }

  function createTool(Tool) {
    if (typeof Tool !== 'function') throw new Error('La clase Tool es necesaria para crear agent_checkpoint.');
    return new Tool({
      id: definition.name,
      definition,
      aliases: ['checkpoint', 'agentcheckpoint', 'checkpoint_agent', 'punto_control'],
      category: 'agent',
      metadata: { icon: 'milestone', label: definition.name },
      settings: {
        titleKey: 'agent_checkpoint_title',
        titleFallback: 'Punto de Control Agéntico',
        descKey: 'agent_checkpoint_desc',
        descFallback: 'Permite al modelo consolidar hallazgos, solicitar asistencia y registrar el siguiente paso para razonar sin pérdida de foco.',
        icon: 'milestone',
        defaultEnabled: false,
        showInSettings: true
      },
      promptGuide: () => '- `agent_checkpoint(findings="...", ready_to_respond=true|false, missing_info="...", next_action="...")`: Consolidates multi-step findings, records the current plan, and verifies whether to conclude or continue searching.',
      execute: async (args = {}, context = {}) => {
        const isReady = args.ready_to_respond === true || args.ready_to_respond === 'true';
        const findings = String(args.findings || args.summary || args.state || '').trim();
        const missingInfo = String(args.missing_info || args.missing || '').trim();
        const nextAction = String(args.next_action || args.hypothesis || args.next || '').trim();

        if (isReady) {
          return {
            success: true,
            status: 'acknowledged',
            action: 'conclude',
            findings,
            guidance: 'Findings consolidated and verified. Proceed immediately to formulate your complete, structured, and detailed final answer to the user.'
          };
        }

        return {
          success: true,
          status: 'acknowledged',
          action: 'continue',
          findings,
          missing_info: missingInfo,
          next_action: nextAction,
          guidance: `Checkpoint recorded. Proceed with your planned next action: ${nextAction || 'perform the pending query.'}`
        };
      },
      result: {
        toModel: (_args, result) => typeof result === 'string' ? result : JSON.stringify(result || {}),
        toMarkdown: (args, result) => {
          const status = result?.action === 'conclude' ? 'Listo para responder' : 'Continuar análisis';
          return `> **agent_checkpoint** [${status}]\n> *Hallazgos:* ${args.findings || ''}\n\n`;
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
