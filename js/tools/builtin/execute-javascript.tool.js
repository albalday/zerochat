/**
 * Tool autocontenida: execute_javascript.
 *
 * La dependencia de Sandbox se recibe desde ToolExecutionContext.services;
 * este módulo no depende de globals ni de resolutores del núcleo agéntico.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.ChatBuiltinExecuteJavascriptTool = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const definition = {
    name: 'execute_javascript',
    description: 'Executes JavaScript locally in a sandbox. Always use return or console.log() to emit the result.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Executable JS code. Always use return <value> or console.log() to emit output.' }
      },
      required: ['code']
    }
  };

  function getCode(args) {
    return args?.code || args?.javascript || args?.js || args?.script || args?.input || (typeof args === 'string' ? args : '');
  }

  function toModel(_args, result, outcome) {
    return result?.success
      ? (result.result || (result.logs && result.logs.length > 0 ? result.logs.join('\n') : 'undefined'))
      : `Error: ${result?.error || outcome?.error || 'Error de ejecución'}`;
  }

  function toMarkdown(args, result, outcome) {
    const code = getCode(args);
    const output = toModel(args, result, outcome);
    return `> ⚡ **execute_javascript**\n> \`\`\`javascript\n> ${code.split('\n').join('\n> ')}\n> \`\`\`\n> \`\`\`\n> ${String(output).split('\n').join('\n> ')}\n> \`\`\``;
  }

  function createCardWrapper(ui) {
    if (ui?.createCardWrapper) return ui.createCardWrapper();
    const doc = ui?.document || (typeof document !== 'undefined' ? document : null);
    if (!doc) return null;
    const cardDiv = doc.createElement('div');
    cardDiv.className = 'tool-card-wrapper';
    return cardDiv;
  }

  const safeEscapeHtml = (value) => String(value || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function getUiHelpers(ui) {
    return {
      Markdown: ui?.markdown || (typeof window !== 'undefined' && window.ChatMarkdown) || (typeof window !== 'undefined' && window.ChatUtils) || { escapeHtml: safeEscapeHtml },
      t: ui?.t || ((key) => key),
      spinner: ui?.SPINNER_SVG || '',
      checkSvg: ui?.CHECK_SVG || '',
      errorSvg: ui?.ERROR_SVG || '',
      chevron: ui?.CHEVRON_SVG || ''
    };
  }

  const JS_ICON_SVG = '<svg class="ui-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>';

  function createLiveCard(args, ui) {
    const cardDiv = createCardWrapper(ui);
    if (!cardDiv) return null;
    const { Markdown, t, spinner, chevron } = getUiHelpers(ui);
    const code = getCode(args);
    cardDiv.innerHTML = `
      <div class="tool-execution-card">
        <div class="tool-card-header">
          <div class="tool-card-title">
            <span>${JS_ICON_SVG}</span>
            <span>${t('tool_js_title_running') || 'execute_javascript'}</span>
          </div>
          <div class="tool-card-header-actions">
            <span class="tool-card-badge status-loading">${spinner} <span>${t('tool_badge_executing') || 'Ejecutando...'}</span></span>
            <button type="button" class="btn-tool-collapse" title="${t('tool_btn_collapse') || 'Minimizar'}">${chevron}</button>
          </div>
        </div>
        <div class="tool-card-collapsible-body">
          <pre class="tool-card-code"><code>${Markdown.escapeHtml(code)}</code></pre>
          <div class="tool-card-result">
            <div class="tool-loading-placeholder">${spinner} <span>${t('tool_loading_js') || 'Ejecutando código en sandbox local...'}</span></div>
          </div>
        </div>
      </div>
    `;
    return cardDiv;
  }

  function updateLiveCard(cardDiv, _args, result = {}, elapsedMs = 0, ui) {
    if (!cardDiv) return;
    const { Markdown, t, checkSvg, errorSvg } = getUiHelpers(ui);
    const isSuccess = result?.success !== false && !result?.error;
    const badgeEl = cardDiv.querySelector('.tool-card-badge');
    if (badgeEl) {
      badgeEl.className = `tool-card-badge ${isSuccess ? 'status-success' : 'status-error'}`;
      badgeEl.innerHTML = isSuccess
        ? `${checkSvg} <span>${t('tool_status_success') || 'Completado'} (${elapsedMs || 0}ms)</span>`
        : `${errorSvg} <span>Error (${elapsedMs || 0}ms)</span>`;
    }
    const resContainer = cardDiv.querySelector('.tool-card-result');
    if (resContainer) {
      const output = isSuccess
        ? (result.result || (result.logs && result.logs.length > 0 ? result.logs.join('\n') : 'undefined'))
        : `Error: ${result.error || 'Error de ejecución'}`;
      const cleanOutput = String(output ?? '').trim();
      resContainer.innerHTML = `<div class="tool-result-label">${t('tool_sandbox_output') || 'Salida del Sandbox:'}</div><pre class="tool-result-pre"><code>${Markdown.escapeHtml(cleanOutput)}</code></pre>`;
    }
  }

  function renderHistoricalCard(args, toolMessage, ui) {
    const cardDiv = createCardWrapper(ui);
    if (!cardDiv) return null;
    const { Markdown, t, checkSvg, chevron } = getUiHelpers(ui);
    let output = '';
    if (toolMessage?.content) {
      try {
        const parsed = JSON.parse(toolMessage.content);
        output = parsed.result || (parsed.logs && parsed.logs.length > 0
          ? parsed.logs.join('\n')
          : (parsed.error ? `Error: ${parsed.error}` : toolMessage.content));
      } catch (e) {
        output = toolMessage.content;
      }
    }
    const cleanOutput = String(output ?? '').trim();
    cardDiv.innerHTML = `
      <div class="tool-execution-card">
        <div class="tool-card-header">
          <div class="tool-card-title"><span>${JS_ICON_SVG}</span><span>${t('tool_js_title_running') || 'execute_javascript'}</span></div>
          <div class="tool-card-header-actions">
            <span class="tool-card-badge status-success">${checkSvg} <span>${t('tool_status_success') || 'Completado'}</span></span>
            <button type="button" class="btn-tool-collapse" title="${t('tool_btn_collapse') || 'Minimizar'}">${chevron}</button>
          </div>
        </div>
        <div class="tool-card-collapsible-body">
          <pre class="tool-card-code"><code>${Markdown.escapeHtml(getCode(args).trim())}</code></pre>
          <div class="tool-card-result"><div class="tool-result-label">${t('tool_sandbox_output') || 'Salida del Sandbox:'}</div><pre class="tool-result-pre"><code>${Markdown.escapeHtml(cleanOutput)}</code></pre></div>
        </div>
      </div>
    `;
    return cardDiv;
  }

  function createTool(Tool) {
    if (typeof Tool !== 'function') {
      throw new Error('La clase Tool es necesaria para crear execute_javascript.');
    }

    return new Tool({
      id: definition.name,
      definition,
      aliases: ['executejs', 'execute_js', 'run_javascript', 'run_js', 'javascript', 'evaljs'],
      category: 'sandbox',
      metadata: { icon: 'zap', label: definition.name },
      settings: {
        titleKey: 'agent_js_title',
        titleFallback: 'Ejecución de JavaScript Local (Sandbox)',
        descKey: 'agent_js_desc',
        descFallback: 'Permite al modelo invocar execute_javascript para calcular, procesar datos o validar algoritmos directamente en el navegador (seguridad estándar del navegador).',
        icon: 'zap',
        defaultEnabled: true,
        showInSettings: true
      },
      promptGuide: () => '- `execute_javascript(code="...")`: Runs JavaScript locally in sandbox. Always use `return <value>` or `console.log(...)` to output results.',
      execute: async (args, context = {}) => {
        const Sandbox = context.services?.sandbox;
        if (!Sandbox || !Sandbox.execute) {
          return { success: false, error: 'Módulo Sandbox no disponible.' };
        }
        const timeoutMs = typeof context.timeoutMs === 'number'
          ? context.timeoutMs
          : (typeof context.options?.timeoutMs === 'number' ? context.options.timeoutMs : undefined);
        return Sandbox.execute(getCode(args), timeoutMs);
      },
      result: { toModel, toMarkdown },
      displayMode: 'collapsed',
      view: { id: 'execute_javascript', displayMode: 'collapsed', createLiveCard, updateLiveCard, renderHistoricalCard }
    });
  }

  const toolModule = {
    id: definition.name,
    definition,
    displayMode: 'collapsed',
    createTool,
    getCode,
    toModel,
    toMarkdown,
    view: { id: 'execute_javascript', displayMode: 'collapsed', createLiveCard, updateLiveCard, renderHistoricalCard }
  };

  function registerWithBuiltinManifest() {
    let manifestApi = null;
    if (typeof window !== 'undefined' && window.ChatToolManifest) {
      manifestApi = window.ChatToolManifest;
    } else if (typeof require !== 'undefined') {
      try { manifestApi = require('../tool-manifest.js'); } catch (e) {}
    }
    if (manifestApi?.builtin && !manifestApi.builtin.has(toolModule.id)) {
      manifestApi.builtin.register(toolModule);
    }
  }

  registerWithBuiltinManifest();
  return toolModule;
});
