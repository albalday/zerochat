/**
 * Módulo de Visualización y Gráficos Nativos en SVG (ChatCharts) para ZeroChat.
 * - Soporta gráficos de Barras, Líneas, Donut y Sectores (Pie) con SVG puro sin dependencias externas.
 * - Totalmente interactivo, accesible y adaptado a temas claro y oscuro.
 * - Compatible con file:// y http://.
 */

(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.ChatCharts = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const COLOR_PALETTE = [
    '#3b82f6', // blue
    '#10b981', // emerald
    '#f59e0b', // amber
    '#8b5cf6', // purple
    '#ec4899', // pink
    '#06b6d4', // cyan
    '#f97316', // orange
    '#6366f1', // indigo
    '#14b8a6', // teal
    '#84cc16'  // lime
  ];

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  /**
   * Genera un gráfico de barras verticales en SVG.
   */
  function renderBarChart(labels, datasets, width = 640, height = 340) {
    const padding = { top: 40, right: 30, bottom: 60, left: 60 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;

    const allValues = datasets.flatMap(d => d.data || []);
    const maxVal = Math.max(...allValues, 1);
    const minVal = Math.min(0, ...allValues);
    const valRange = maxVal - minVal;

    // Ejes y cuadrícula horizontal
    const numTicks = 5;
    let gridLines = '';
    for (let i = 0; i <= numTicks; i++) {
      const val = minVal + (valRange * (numTicks - i)) / numTicks;
      const y = padding.top + (chartHeight * i) / numTicks;
      gridLines += `
        <line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" stroke="currentColor" stroke-opacity="0.12" stroke-dasharray="3,3"/>
        <text x="${padding.left - 8}" y="${y + 4}" font-size="11" text-anchor="end" fill="currentColor" opacity="0.65">${val.toLocaleString()}</text>
      `;
    }

    // Barras
    const groupWidth = chartWidth / labels.length;
    const barPadding = groupWidth * 0.2;
    const availableBarWidth = groupWidth - barPadding;
    const singleBarWidth = availableBarWidth / datasets.length;

    let bars = '';
    let xLabels = '';

    labels.forEach((label, groupIdx) => {
      const groupX = padding.left + groupIdx * groupWidth + barPadding / 2;
      const labelX = groupX + availableBarWidth / 2;
      
      xLabels += `
        <text x="${labelX}" y="${height - padding.bottom + 20}" font-size="11" text-anchor="middle" fill="currentColor" opacity="0.8" transform="rotate(-15, ${labelX}, ${height - padding.bottom + 20})">
          ${escapeHtml(label.length > 14 ? label.slice(0, 12) + '…' : label)}
        </text>
      `;

      datasets.forEach((ds, dsIdx) => {
        const val = (ds.data && ds.data[groupIdx] !== undefined) ? ds.data[groupIdx] : 0;
        const barH = (val / (maxVal || 1)) * chartHeight;
        const barX = groupX + dsIdx * singleBarWidth;
        const barY = padding.top + chartHeight - barH;
        const color = ds.color || COLOR_PALETTE[dsIdx % COLOR_PALETTE.length];

        bars += `
          <g class="chart-bar-group">
            <rect x="${barX}" y="${barY}" width="${Math.max(singleBarWidth - 2, 2)}" height="${Math.max(barH, 2)}" fill="${color}" rx="3">
              <title>${escapeHtml(label)} (${escapeHtml(ds.label || 'Valor')}): ${val.toLocaleString()}</title>
            </rect>
            <text x="${barX + singleBarWidth / 2}" y="${barY - 5}" font-size="10" font-weight="600" text-anchor="middle" fill="${color}">
              ${val >= 1000 ? (val / 1000).toFixed(1) + 'k' : val}
            </text>
          </g>
        `;
      });
    });

    return `
      <svg viewBox="0 0 ${width} ${height}" class="chat-chart-svg" style="width:100%; height:auto; max-height:360px;">
        ${gridLines}
        ${bars}
        ${xLabels}
      </svg>
    `;
  }

  /**
   * Genera un gráfico de líneas en SVG.
   */
  function renderLineChart(labels, datasets, width = 640, height = 340) {
    const padding = { top: 40, right: 30, bottom: 60, left: 60 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;

    const allValues = datasets.flatMap(d => d.data || []);
    const maxVal = Math.max(...allValues, 1);
    const minVal = Math.min(0, ...allValues);
    const valRange = maxVal - minVal;

    let gridLines = '';
    const numTicks = 5;
    for (let i = 0; i <= numTicks; i++) {
      const val = minVal + (valRange * (numTicks - i)) / numTicks;
      const y = padding.top + (chartHeight * i) / numTicks;
      gridLines += `
        <line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" stroke="currentColor" stroke-opacity="0.12" stroke-dasharray="3,3"/>
        <text x="${padding.left - 8}" y="${y + 4}" font-size="11" text-anchor="end" fill="currentColor" opacity="0.65">${val.toLocaleString()}</text>
      `;
    }

    let paths = '';
    let dots = '';
    let xLabels = '';

    const stepX = labels.length > 1 ? chartWidth / (labels.length - 1) : chartWidth / 2;

    labels.forEach((label, idx) => {
      const x = labels.length > 1 ? padding.left + idx * stepX : padding.left + chartWidth / 2;
      xLabels += `
        <text x="${x}" y="${height - padding.bottom + 20}" font-size="11" text-anchor="middle" fill="currentColor" opacity="0.8" transform="rotate(-15, ${x}, ${height - padding.bottom + 20})">
          ${escapeHtml(label.length > 14 ? label.slice(0, 12) + '…' : label)}
        </text>
      `;
    });

    datasets.forEach((ds, dsIdx) => {
      const color = ds.color || COLOR_PALETTE[dsIdx % COLOR_PALETTE.length];
      const points = (ds.data || []).map((val, idx) => {
        const x = labels.length > 1 ? padding.left + idx * stepX : padding.left + chartWidth / 2;
        const y = padding.top + chartHeight - (val / (maxVal || 1)) * chartHeight;
        return { x, y, val, label: labels[idx] };
      });

      if (points.length === 0) return;

      const pathData = points.reduce((acc, pt, i) => `${acc} ${i === 0 ? 'M' : 'L'} ${pt.x} ${pt.y}`, '');
      const areaData = `${pathData} L ${points[points.length - 1].x} ${padding.top + chartHeight} L ${points[0].x} ${padding.top + chartHeight} Z`;

      paths += `
        <path d="${areaData}" fill="${color}" fill-opacity="0.12" />
        <path d="${pathData}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
      `;

      points.forEach(pt => {
        dots += `
          <circle cx="${pt.x}" cy="${pt.y}" r="4.5" fill="${color}" stroke="#ffffff" stroke-width="1.5">
            <title>${escapeHtml(pt.label)}: ${pt.val.toLocaleString()}</title>
          </circle>
          <text x="${pt.x}" y="${pt.y - 8}" font-size="10" font-weight="600" text-anchor="middle" fill="${color}">
            ${pt.val >= 1000 ? (pt.val / 1000).toFixed(1) + 'k' : pt.val}
          </text>
        `;
      });
    });

    return `
      <svg viewBox="0 0 ${width} ${height}" class="chat-chart-svg" style="width:100%; height:auto; max-height:360px;">
        ${gridLines}
        ${paths}
        ${dots}
        ${xLabels}
      </svg>
    `;
  }

  /**
   * Genera un gráfico de donut o sectores (Pie) en SVG.
   */
  function renderPieOrDonutChart(labels, dataset, isDonut = true, width = 500, height = 300) {
    const data = dataset.data || [];
    const total = data.reduce((acc, v) => acc + (Number(v) || 0), 0) || 1;

    const centerX = 160;
    const centerY = height / 2;
    const outerRadius = 110;
    const innerRadius = isDonut ? 60 : 0;

    let startAngle = 0;
    let slices = '';
    let legendItems = '';

    data.forEach((val, idx) => {
      const percentage = (val / total) * 100;
      const angle = (val / total) * 2 * Math.PI;
      const endAngle = startAngle + angle;
      const color = COLOR_PALETTE[idx % COLOR_PALETTE.length];
      const label = labels[idx] || `Item ${idx + 1}`;

      // Coordenadas del arco
      const x1 = centerX + outerRadius * Math.sin(startAngle);
      const y1 = centerY - outerRadius * Math.cos(startAngle);
      const x2 = centerX + outerRadius * Math.sin(endAngle);
      const y2 = centerY - outerRadius * Math.cos(endAngle);

      const largeArcFlag = angle > Math.PI ? 1 : 0;

      let pathD = '';
      if (isDonut) {
        const ix1 = centerX + innerRadius * Math.sin(startAngle);
        const iy1 = centerY - innerRadius * Math.cos(startAngle);
        const ix2 = centerX + innerRadius * Math.sin(endAngle);
        const iy2 = centerY - innerRadius * Math.cos(endAngle);

        pathD = `M ${x1} ${y1} A ${outerRadius} ${outerRadius} 0 ${largeArcFlag} 1 ${x2} ${y2} L ${ix2} ${iy2} A ${innerRadius} ${innerRadius} 0 ${largeArcFlag} 0 ${ix1} ${iy1} Z`;
      } else {
        pathD = `M ${centerX} ${centerY} L ${x1} ${y1} A ${outerRadius} ${outerRadius} 0 ${largeArcFlag} 1 ${x2} ${y2} Z`;
      }

      slices += `
        <path d="${pathD}" fill="${color}" stroke="#ffffff" stroke-width="1.5" opacity="0.95">
          <title>${escapeHtml(label)}: ${val.toLocaleString()} (${percentage.toFixed(1)}%)</title>
        </path>
      `;

      // Leyenda
      const legendY = 40 + idx * 24;
      if (legendY < height - 10) {
        legendItems += `
          <g transform="translate(300, ${legendY})">
            <rect x="0" y="-8" width="12" height="12" rx="3" fill="${color}"/>
            <text x="18" y="2" font-size="11" fill="currentColor" opacity="0.9">${escapeHtml(label.slice(0, 16))}</text>
            <text x="180" y="2" font-size="11" font-weight="600" text-anchor="end" fill="${color}">${percentage.toFixed(1)}%</text>
          </g>
        `;
      }

      startAngle = endAngle;
    });

    return `
      <svg viewBox="0 0 ${width} ${height}" class="chat-chart-svg" style="width:100%; height:auto; max-height:320px;">
        <g class="pie-slices">${slices}</g>
        <g class="pie-legend">${legendItems}</g>
      </svg>
    `;
  }

  /**
   * Renderiza el contenedor completo de la tarjeta de gráfico interactivo.
   */
  function renderChartCard(config) {
    const type = (config.type || 'bar').toLowerCase();
    const title = config.title || 'Visualización de Datos';
    const description = config.description || '';
    const labels = config.labels || [];
    const datasets = config.datasets || (config.data ? [{ label: title, data: config.data }] : []);

    let chartSvg = '';
    if (type === 'line') {
      chartSvg = renderLineChart(labels, datasets);
    } else if (type === 'pie') {
      chartSvg = renderPieOrDonutChart(labels, datasets[0] || { data: [] }, false);
    } else if (type === 'donut' || type === 'doughnut') {
      chartSvg = renderPieOrDonutChart(labels, datasets[0] || { data: [] }, true);
    } else {
      chartSvg = renderBarChart(labels, datasets);
    }

    // Leyendas superiores para barras y líneas si hay múltiples datasets
    let topLegend = '';
    if ((type === 'bar' || type === 'line') && datasets.length > 1) {
      topLegend = '<div class="chart-legend-top">' + datasets.map((ds, idx) => `
        <span class="chart-legend-item">
          <span class="chart-legend-dot" style="background-color:${ds.color || COLOR_PALETTE[idx % COLOR_PALETTE.length]}"></span>
          ${escapeHtml(ds.label || `Serie ${idx + 1}`)}
        </span>
      `).join('') + '</div>';
    }

    const chartIconSvg = '<svg class="ui-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="20" x2="12" y2="10"></line><line x1="18" y1="20" x2="18" y2="4"></line><line x1="6" y1="20" x2="6" y2="16"></line></svg>';
    const chevronSvg = '<svg class="ui-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>';

    return `
      <div class="chat-chart-card">
        <div class="chat-chart-header">
          <div class="chat-chart-title">
            <span>${chartIconSvg}</span>
            <strong>${escapeHtml(title)}</strong>
          </div>
          <div class="tool-card-header-actions">
            <span class="chat-chart-badge">${escapeHtml(type.toUpperCase())}</span>
            <button type="button" class="btn-tool-collapse" title="Minimizar / Expandir gráfico">${chevronSvg}</button>
          </div>
        </div>
        <div class="tool-card-collapsible-body">
          ${description ? `<div class="chat-chart-description">${escapeHtml(description)}</div>` : ''}
          ${topLegend}
          <div class="chat-chart-body">
            ${chartSvg}
          </div>
        </div>
      </div>
    `;
  }

  return {
    renderBarChart,
    renderLineChart,
    renderPieOrDonutChart,
    renderChartCard
  };
});
