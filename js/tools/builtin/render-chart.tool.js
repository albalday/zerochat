/** Tool autocontenida: render_chart. */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') module.exports = factory();
  else root.ChatBuiltinRenderChartTool = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const definition = {
    name: 'render_chart',
    description: 'Genera y visualiza un gráfico interactivo (barras, líneas, donut o sectores) a partir de datos numéricos o tablas.',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['bar', 'line', 'pie', 'doughnut'], description: 'Tipo de gráfico.' },
        title: { type: 'string', description: 'Título descriptivo del gráfico.' },
        description: { type: 'string', description: 'Breve explicación de los datos.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Etiquetas del eje X o categorías.' },
        datasets: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, data: { type: 'array', items: { type: 'number' } }, color: { type: 'string' } }, required: ['label', 'data'] }, description: 'Series de datos numéricos.' }
      },
      required: ['type', 'title', 'labels', 'datasets']
    }
  };

  function createCardWrapper(ui) {
    if (ui?.createCardWrapper) return ui.createCardWrapper();
    const doc = ui?.document || (typeof document !== 'undefined' ? document : null);
    if (!doc) return null;
    const cardDiv = doc.createElement('div');
    cardDiv.className = 'tool-card-wrapper';
    return cardDiv;
  }

  function renderChart(args, ui) {
    const Charts = ui?.charts || null;
    if (Charts?.renderChartCard) return Charts.renderChartCard(args);
    const escapeHtml = ui?.markdown?.escapeHtml || ((value) => String(value || ''));
    const chartIconSvg = '<svg class="ui-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="20" x2="12" y2="10"></line><line x1="18" y1="20" x2="18" y2="4"></line><line x1="6" y1="20" x2="6" y2="16"></line></svg>';
    return `<div class="chat-chart-card">${chartIconSvg} ${escapeHtml(args.title || 'Gráfico')}</div>`;
  }

  function updateLiveCard(cardDiv, args, _result, _elapsedMs, ui) {
    if (cardDiv) cardDiv.innerHTML = renderChart(args, ui);
  }

  function renderHistoricalCard(args, _toolMessage, ui) {
    const cardDiv = createCardWrapper(ui);
    if (cardDiv) cardDiv.innerHTML = renderChart(args, ui);
    return cardDiv;
  }

  function createTool(Tool) {
    if (typeof Tool !== 'function') throw new Error('La clase Tool es necesaria para crear render_chart.');
    return new Tool({
      id: definition.name,
      definition,
      aliases: ['renderchart', 'draw_chart', 'create_chart', 'plot_chart', 'generate_chart', 'show_chart', 'chart', 'grafico'],
      category: 'charts',
      metadata: { icon: '📊', label: definition.name },
      settings: { titleKey: 'agent_chart_title', titleFallback: 'Visualización de Datos y Gráficos Nativos (SVG)', descKey: 'agent_chart_desc', descFallback: 'Permite al modelo invocar render_chart para generar y mostrar gráficos interactivos de barras, líneas o sectores sin librerías externas.', icon: '📊', defaultEnabled: true, showInSettings: true },
      promptGuide: (lang) => lang === 'en'
        ? '- `render_chart(type="...", title="...", labels=[...], datasets=[...])`: Generates and displays native interactive SVG charts (bar, line, pie, doughnut).'
        : '- `render_chart(type="...", title="...", labels=[...], datasets=[...])`: Genera y visualiza gráficos SVG nativos interactivos (barras, líneas, sectores, donut).',
      execute: async (args, context = {}) => {
        const Charts = context.services?.charts;
        if (!Charts || (!Charts.renderChartCard && !Charts.renderBarChart)) return { success: false, error: 'Módulo Charts no disponible.' };
        const svgHtml = Charts.renderChartCard ? Charts.renderChartCard(args) : Charts.renderBarChart(args.labels, args.datasets);
        return { success: true, svg: svgHtml, chartData: args, title: args.title || 'Gráfico' };
      },
      result: {
        toModel: (args, _result, outcome) => JSON.stringify({ success: outcome?.ok !== false, type: args.type || 'bar', title: args.title || 'Gráfico' }),
        toMarkdown: (args) => `> 📊 **render_chart** (${args.type || 'bar'})\n> Título: "${args.title || 'Gráfico'}"\n\n`
      },
      displayMode: 'expanded',
      view: { id: definition.name, displayMode: 'expanded', updateLiveCard, renderHistoricalCard }
    });
  }

  const toolModule = { id: definition.name, definition, displayMode: 'expanded', createTool, view: { id: definition.name, displayMode: 'expanded', updateLiveCard, renderHistoricalCard } };
  let manifestApi = null;
  if (typeof window !== 'undefined' && window.ChatToolManifest) manifestApi = window.ChatToolManifest;
  else if (typeof require !== 'undefined') { try { manifestApi = require('../tool-manifest.js'); } catch (e) {} }
  if (manifestApi?.builtin && !manifestApi.builtin.has(toolModule.id)) manifestApi.builtin.register(toolModule);
  return toolModule;
});
