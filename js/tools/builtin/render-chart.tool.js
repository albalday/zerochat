/** Herramienta nativa render_chart: muestra el gráfico en el chat y queda desplegada. */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') module.exports = factory();
  else root.ChatBuiltinRenderChartTool = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function createLiveCard(args, ui) {
    const cardDiv = ui.createCardWrapper();
    cardDiv.innerHTML = ui.charts.renderChartCard(args);
    return cardDiv;
  }

  function updateLiveCard(cardDiv, args, _result, _elapsedMs, ui) {
    cardDiv.innerHTML = ui.charts.renderChartCard(args);
  }

  return {
    definition: {
      name: 'render_chart',
      description: 'Show an interactive chart from numeric data.',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['bar', 'line', 'pie', 'doughnut'] },
          title: { type: 'string' },
          description: { type: 'string', description: 'Short note on the data.' },
          labels: { type: 'array', items: { type: 'string' }, description: 'Categories or X-axis labels.' },
          datasets: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, data: { type: 'array', items: { type: 'number' } }, color: { type: 'string' } }, required: ['label', 'data'] }, description: 'Series; one value per label.' }
        },
        required: ['type', 'title', 'labels', 'datasets']
      }
    },
    aliases: ['draw_chart', 'create_chart', 'plot_chart', 'generate_chart', 'show_chart', 'chart', 'grafico'],
    category: 'charts',
    settings: { titleKey: 'agent_chart_title', descKey: 'agent_chart_desc' },
    promptGuide: '- `render_chart(type="...", title="...", labels=[...], datasets=[...])`: Generates and displays native interactive SVG charts (bar, line, pie, doughnut).',
    // El gráfico se dibuja en la tarjeta; el modelo solo necesita saber que se mostró.
    execute: async args => ({ success: true, type: args.type || 'bar', title: args.title || 'Chart' }),
    result: {
      toModel: (_args, result) => JSON.stringify(result),
      toMarkdown: args => `> **render_chart** (${args.type || 'bar'})\n> Title: "${args.title || 'Chart'}"\n\n`
    },
    displayMode: 'expanded',
    view: { createLiveCard, updateLiveCard }
  };
});
