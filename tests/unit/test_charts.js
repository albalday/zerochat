const test = require('node:test');
const assert = require('node:assert/strict');
const ChatCharts = require('../../js/charts.js');

// Coordenadas y alturas de las barras y puntos del SVG, en el orden en que se dibujan.
const numbers = (svg, pattern) => [...svg.matchAll(pattern)].map(match => Number(match[1]));

test('ChatCharts - un tipo que no es texto no rompe la tarjeta y los valores negativos quedan dentro del área del gráfico', () => {
  assert.match(ChatCharts.renderChartCard({ type: 7, labels: ['A'], datasets: [{ label: 'a', data: [1] }] }), /<svg/);

  const spec = { labels: ['A', 'B'], datasets: [{ label: 'a', data: [10, -10] }] };
  const bar = ChatCharts.renderChartCard({ ...spec, type: 'bar' });
  const [, , height] = bar.match(/<svg viewBox="0 0 (\d+) (\d+)" class="chat-chart-svg"/).map(Number);
  const ys = numbers(bar, /<rect x="[^"]+" y="([^"]+)"/g);
  const heights = numbers(bar, /<rect [^>]*height="([^"]+)"/g);
  assert.equal(ys.length, 2);
  ys.forEach((y, idx) => assert.ok(y >= 0 && y + heights[idx] <= height, `barra ${idx}: y=${y} alto=${heights[idx]}`));
  assert.equal(heights[0], heights[1], '10 y -10 miden lo mismo desde el cero');
  assert.equal(ys[1], ys[0] + heights[0], 'la barra negativa empieza en la línea del cero');

  const line = ChatCharts.renderChartCard({ ...spec, type: 'line' });
  const points = numbers(line, /<circle [^>]*cy="([^"]+)"/g);
  assert.equal(points.length, 2);
  points.forEach(cy => assert.ok(cy >= 0 && cy <= height, `cy=${cy}`));
});
