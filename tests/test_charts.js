const { test } = require('node:test');
const assert = require('node:assert/strict');
const Charts = require('../js/charts.js');

test('Charts - Generación de tarjetas de gráficos SVG (bar, line, pie)', () => {
  const cases = [
    {
      type: 'bar',
      spec: {
        type: 'bar',
        title: 'Ventas Trimestrales',
        labels: ['Q1', 'Q2', 'Q3', 'Q4'],
        datasets: [{ label: 'Ingresos', data: [100, 200, 150, 300] }]
      },
      check: (html) => {
        assert.ok(html.includes('<svg'), 'Debe generar una etiqueta <svg>');
        assert.ok(html.includes('Ventas Trimestrales'), 'Debe incluir el título');
        assert.ok(html.includes('chat-chart-card'), 'Debe tener contenedor de gráfico');
      }
    },
    {
      type: 'line',
      spec: {
        type: 'line',
        title: 'Tendencia',
        labels: ['Ene', 'Feb', 'Mar'],
        datasets: [{ label: 'Usuarios', data: [10, 25, 40] }]
      },
      check: (html) => {
        assert.ok(html.includes('<svg') && (html.includes('<path') || html.includes('<polyline') || html.includes('<circle')), 'Debe generar líneas de gráfico');
      }
    },
    {
      type: 'pie',
      spec: {
        type: 'pie',
        title: 'Distribución',
        labels: ['A', 'B'],
        datasets: [{ data: [60, 40] }]
      },
      check: (html) => {
        assert.ok(html.includes('<svg'), 'Debe generar svg para pie chart');
      }
    }
  ];

  for (const c of cases) {
    const html = Charts.renderChartCard(c.spec);
    c.check(html);
  }
});
