/**
 * Tool autocontenida: execute_javascript.
 *
 * La dependencia del ejecutor de JavaScript se recibe desde ToolExecutionContext.services;
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

  const getCards = () => typeof window !== 'undefined' && window.ChatToolCards || require('../../tool-cards.js');

  const definition = {
    name: 'execute_javascript',
    description: 'Executes JavaScript code in an isolated local worker to assist with calculations and data processing under technical user supervision. Always use return <value> or console.log() to emit the result.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Executable JS code. Always use return <value> or console.log() to emit output.' }
      },
      required: ['code']
    }
  };

  function getCode(args) {
    const raw = args?.code || args?.javascript || args?.js || args?.script || args?.input || (typeof args === 'string' ? args : '');
    if (typeof raw !== 'string') return '';
    let code = raw.trim();
    if (code.startsWith('```')) {
      code = code.replace(/^```(?:javascript|js)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }
    return code;
  }

  function toModel(_args, result, outcome) {
    return result?.success
      ? (result.result || (result.logs && result.logs.length > 0 ? result.logs.join('\n') : 'undefined'))
      : `Error: ${result?.error || outcome?.error || 'Execution error'}`;
  }

  function toMarkdown(args, result, outcome) {
    const code = getCode(args);
    const output = toModel(args, result, outcome);
    return `> ⚡ **execute_javascript**\n> \`\`\`javascript\n> ${code.split('\n').join('\n> ')}\n> \`\`\`\n> \`\`\`\n> ${String(output).split('\n').join('\n> ')}\n> \`\`\``;
  }


  function getUiHelpers(ui) {
    return {
      Markdown: ui.markdown,
      t: ui?.t || ((key) => key),
      spinner: ui?.SPINNER_SVG || '',
      checkSvg: ui?.CHECK_SVG || '',
      errorSvg: ui?.ERROR_SVG || ''
    };
  }

  const Icons = (typeof window !== 'undefined' && window.ChatIcons) || require('../../icons.js');
  const JS_ICON_SVG = Icons.get('terminal', { size: 14 });

  function createLiveCard(args, ui) {
    const cardDiv = getCards().createCardWrapper(ui);
    if (!cardDiv) return null;
    const { Markdown, t, spinner } = getUiHelpers(ui);
    const code = getCode(args);
    cardDiv.innerHTML = getCards().renderCardHtml({
      className: '',
      titleHtml: `<span>${JS_ICON_SVG}</span>
            <span>${t('tool_js_title_running')}</span>`,
      badgeHtml: `<span class="tool-card-badge status-loading">${spinner} <span>${t('tool_badge_executing')}</span></span>`,
      bodyHtml: `<pre class="tool-card-code"><code>${Markdown.escapeHtml(code)}</code></pre>
          <div class="tool-card-result">
            <div class="tool-loading-placeholder">${spinner} <span>${t('tool_loading_js')}</span></div>
          </div>`
    }, ui);
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
        ? `${checkSvg} <span>${t('tool_status_success')} (${elapsedMs || 0}ms)</span>`
        : `${errorSvg} <span>Error (${elapsedMs || 0}ms)</span>`;
    }
    const resContainer = cardDiv.querySelector('.tool-card-result');
    if (resContainer) {
      const output = isSuccess
        ? (result.result || (result.logs && result.logs.length > 0 ? result.logs.join('\n') : 'undefined'))
        : `Error: ${result.error || 'Error de ejecución'}`;
      const cleanOutput = String(output ?? '').trim();
      resContainer.innerHTML = `<div class="tool-result-label">${t('tool_sandbox_output')}</div><pre class="tool-result-pre"><code>${Markdown.escapeHtml(cleanOutput)}</code></pre>`;
    }
  }

  function renderHistoricalCard(args, toolMessage, ui) {
    const cardDiv = getCards().createCardWrapper(ui);
    if (!cardDiv) return null;
    const { Markdown, t, checkSvg } = getUiHelpers(ui);
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
    cardDiv.innerHTML = getCards().renderCardHtml({
      className: '',
      titleHtml: `<span>${JS_ICON_SVG}</span><span>${t('tool_js_title_running')}</span>`,
      badgeHtml: `<span class="tool-card-badge status-success">${checkSvg} <span>${t('tool_status_success')}</span></span>`,
      bodyHtml: `<pre class="tool-card-code"><code>${Markdown.escapeHtml(getCode(args).trim())}</code></pre>
          <div class="tool-card-result"><div class="tool-result-label">${t('tool_sandbox_output')}</div><pre class="tool-result-pre"><code>${Markdown.escapeHtml(cleanOutput)}</code></pre></div>`
    }, ui);
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
      category: 'computation',
      metadata: { label: definition.name },
      settings: {
        titleKey: 'agent_js_title',
        descKey: 'agent_js_desc',
        defaultEnabled: true,
        showInSettings: true
      },
      promptGuide: () => '- `execute_javascript(code="...")`: Runs JavaScript locally in an isolated worker to assist with calculations and logic. Always use `return <value>` or `console.log(...)` to output results.',
      execute: async (args, context = {}) => {
        const Sandbox = context.services?.sandbox;
        if (!Sandbox || !Sandbox.execute) {
          return { success: false, error: 'JavaScript execution module not available.' };
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
      try { manifestApi = require('../tool-manifest.js'); } catch (e) { /* módulo opcional: no disponible en este entorno */ }
    }
    if (manifestApi?.builtin && !manifestApi.builtin.has(toolModule.id)) {
      manifestApi.builtin.register(toolModule);
    }
  }

  registerWithBuiltinManifest();
  return toolModule;
});
