/** Herramienta nativa execute_javascript: ejecuta el código en el sandbox aislado de ChatSandbox. */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') module.exports = factory(require('../../utils.js'), require('../../icons.js'));
  else root.ChatBuiltinExecuteJavascriptTool = factory(root.ChatUtils, root.ChatIcons);
})(typeof self !== 'undefined' ? self : this, function (Utils, Icons) {
  'use strict';

  const { escapeHtml, resolveDep } = Utils;
  const getCards = () => resolveDep('ChatToolCards', './tool-cards.js');

  const JS_ICON_SVG = Icons.get('terminal', { size: 14 });

  function getCode(args) {
    const raw = args.code || args.javascript || args.js || args.script || args.input || '';
    if (typeof raw !== 'string') return '';
    const code = raw.trim();
    return code.startsWith('```') ? code.replace(/^```(?:javascript|js)?\s*\n?/, '').replace(/\n?```\s*$/, '') : code;
  }

  /** Salida que recibe el modelo; en el historial queda solo ese texto (`content`). */
  function getOutput(result) {
    if (result.success === false || result.error) return `Error: ${result.error || 'Execution error'}`;
    if (result.result !== undefined && result.result !== '') return String(result.result);
    if (result.logs?.length) return result.logs.join('\n');
    return result.content ?? 'undefined';
  }

  function createLiveCard(args, ui) {
    const cardDiv = ui.createCardWrapper();
    cardDiv.innerHTML = getCards().renderCardHtml({
      titleHtml: `<span>${JS_ICON_SVG}</span><span>${ui.t('tool_js_title_running')}</span>`,
      badgeHtml: `<span class="tool-card-badge status-loading">${ui.SPINNER_SVG} <span>${ui.t('tool_badge_executing')}</span></span>`,
      bodyHtml: `<pre class="tool-card-code"><code>${escapeHtml(getCode(args))}</code></pre><div class="tool-card-result"><div class="tool-loading-placeholder">${ui.SPINNER_SVG} <span>${ui.t('tool_loading_js')}</span></div></div>`
    });
    return cardDiv;
  }

  function updateLiveCard(cardDiv, _args, result, elapsedMs, ui) {
    const success = result.success !== false && !result.error;
    getCards().renderStatusBadge(cardDiv.querySelector('.tool-card-badge'), success, success
      ? `${ui.t('tool_status_success')} (${elapsedMs}ms)`
      : ui.t('tool_status_error', { ms: elapsedMs }));
    cardDiv.querySelector('.tool-card-result').innerHTML = `<div class="tool-result-label">${ui.t('tool_sandbox_output')}</div><pre class="tool-result-pre"><code>${escapeHtml(getOutput(result).trim())}</code></pre>`;
  }

  return {
    definition: {
      name: 'execute_javascript',
      description: 'Executes JavaScript code in an isolated local worker to assist with calculations and data processing under technical user supervision. Always use return <value> or console.log() to emit the result.',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'Executable JS code. Always use return <value> or console.log() to emit output.' }
        },
        required: ['code']
      }
    },
    aliases: ['execute_js', 'run_javascript', 'run_js', 'javascript', 'evaljs', 'eval_javascript'],
    category: 'computation',
    settings: { titleKey: 'agent_js_title', descKey: 'agent_js_desc' },
    promptGuide: '- `execute_javascript(code="...")`: Runs JavaScript locally in an isolated worker to assist with calculations and logic. Always use `return <value>` or `console.log(...)` to output results.',
    execute: (args, context) => context.services.sandbox.execute(getCode(args)),
    result: {
      toModel: (_args, result) => getOutput(result),
      toMarkdown: (args, result) => `> ⚡ **execute_javascript**\n> \`\`\`javascript\n> ${getCode(args).split('\n').join('\n> ')}\n> \`\`\`\n> \`\`\`\n> ${getOutput(result).split('\n').join('\n> ')}\n> \`\`\``
    },
    view: { createLiveCard, updateLiveCard }
  };
});
