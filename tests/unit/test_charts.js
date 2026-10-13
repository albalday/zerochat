const { test } = require('node:test');
const assert = require('node:assert/strict');
const Charts = require('../../js/charts.js');

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

test('Charts - los argumentos del modelo no crean nodos ni atributos al pintarse', () => {
  const { installDom } = require('../helpers/dom-env.js');
  const dom = installDom();
  try {
    const payload = '"/><img src=x onerror="window.__chartXss=1">';
    for (const type of ['bar', 'line', 'pie']) {
      const host = dom.document.createElement('div');
      host.innerHTML = Charts.renderChartCard({
        type,
        title: payload,
        labels: [payload, 'B'],
        datasets: [
          { label: payload, data: [payload, 2], color: payload },
          { label: 'ok', data: [1, 2], color: 'rgb(10, 20, 30)' }
        ]
      });
      assert.equal(host.querySelector('img'), null, type);
      const handlers = [...host.querySelectorAll('*')].flatMap(el => [...el.attributes].filter(attr => attr.name.startsWith('on')));
      assert.deepEqual(handlers, [], type);
      assert.ok(host.textContent.includes('onerror'), `${type}: el payload se conserva como texto`);
    }
    const host = dom.document.createElement('div');
    host.innerHTML = Charts.renderChartCard({ type: 'bar', labels: ['A'], datasets: [{ label: 'a', data: [1], color: '#ff0000' }, { label: 'b', data: [2], color: payload }] });
    const fills = [...host.querySelectorAll('rect[fill]')].map(rect => rect.getAttribute('fill'));
    assert.ok(fills.includes('#ff0000'), 'Un color válido se respeta');
    assert.equal(fills.some(fill => fill.includes('<') || fill.includes('"')), false);
  } finally {
    dom.restore();
  }
});
