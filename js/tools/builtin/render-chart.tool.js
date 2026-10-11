/** Tool autocontenida: render_chart. */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') module.exports = factory(require('../../utils.js'));
  else root.ChatBuiltinRenderChartTool = factory(root.ChatUtils);
})(typeof self !== 'undefined' ? self : this, function (Utils) {
  'use strict';

  const { resolveDep } = Utils;

  const definition = {
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
  };

  function renderChart(args, ui) {
    return ui.charts.renderChartCard(args);
  }

  function createLiveCard(args, ui) {
    const cardDiv = ui.createCardWrapper();
    cardDiv.innerHTML = renderChart(args, ui);
    return cardDiv;
  }

  function updateLiveCard(cardDiv, args, _result, _elapsedMs, ui) {
    if (cardDiv) cardDiv.innerHTML = renderChart(args, ui);
  }

  function renderHistoricalCard(args, _toolMessage, ui) {
    return createLiveCard(args, ui);
  }

  function createTool(Tool) {
    if (typeof Tool !== 'function') throw new Error('La clase Tool es necesaria para crear render_chart.');
    return new Tool({
      id: definition.name,
      definition,
      aliases: ['renderchart', 'draw_chart', 'create_chart', 'plot_chart', 'generate_chart', 'show_chart', 'chart', 'grafico'],
      category: 'charts',
      metadata: { label: definition.name },
      settings: { titleKey: 'agent_chart_title', descKey: 'agent_chart_desc', defaultEnabled: true, showInSettings: true },
      promptGuide: () => '- `render_chart(type="...", title="...", labels=[...], datasets=[...])`: Generates and displays native interactive SVG charts (bar, line, pie, doughnut).',
      execute: async (args, context = {}) => {
        const svgHtml = context.services.charts.renderChartCard(args);
        return { success: true, svg: svgHtml, chartData: args, title: args.title || 'Chart' };
      },
      result: {
        toModel: (args, _result, outcome) => JSON.stringify({ success: outcome?.ok !== false, type: args.type || 'bar', title: args.title || 'Chart' }),
        toMarkdown: (args) => `> **render_chart** (${args.type || 'bar'})\n> Título: "${args.title || 'Gráfico'}"\n\n`
      },
      displayMode: 'expanded',
      view: { id: definition.name, displayMode: 'expanded', createLiveCard, updateLiveCard, renderHistoricalCard }
    });
  }

  const toolModule = { id: definition.name, definition, displayMode: 'expanded', createTool, view: { id: definition.name, displayMode: 'expanded', createLiveCard, updateLiveCard, renderHistoricalCard } };
  const manifestApi = resolveDep('ChatToolManifest', './tools/tool-manifest.js');
  if (manifestApi?.builtin && !manifestApi.builtin.has(toolModule.id)) manifestApi.builtin.register(toolModule);
  return toolModule;
});
