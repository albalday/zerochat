const test = require('node:test');
const assert = require('node:assert');
const ChatToolCards = require('../../js/tool-cards.js');
const AgentCore = require('../../js/agent-core.js');
const { installDom } = require('../helpers/dom-env.js');

/** Registra en el registro real una herramienta de prueba con su vista y la retira al terminar. */
function registerTool(t, options) {
  const { name, ...rest } = options;
  const tool = new AgentCore.Tool({ definition: { name }, execute: async () => ({ success: true }), ...rest });
  const provider = { id: `test_provider_${options.name}`, getTools: () => [tool] };
  AgentCore.registry.registerProvider(provider);
  t.after(() => AgentCore.registry.unregisterProvider(provider.id));
  return tool;
}

function setup(t) {
  const dom = installDom();
  t.after(() => dom.restore());
}

const isCollapsed = card => card.querySelector('.tool-execution-card, .chat-chart-card').classList.contains('collapsed');

test('ChatToolCards - usa la vista declarada por la herramienta y una genérica si no la tiene', t => {
  setup(t);
  const view = {
    createLiveCard: (args, ui) => {
      const card = ui.createCardWrapper('own-view');
      card.innerHTML = ChatToolCards.renderCardHtml({ titleHtml: 'Propia', badgeHtml: '<span class="tool-card-badge"></span>' });
      return card;
    },
    updateLiveCard: card => { card.querySelector('.tool-card-badge').textContent = 'hecho'; }
  };
  registerTool(t, { name: 'view_tool', view });

  const own = ChatToolCards.createLiveToolCard('view_tool', {});
  assert.ok(own.classList.contains('own-view'));
  ChatToolCards.updateLiveToolCard(own, 'view_tool', {}, { success: true }, 1);
  assert.equal(own.querySelector('.tool-card-badge').textContent, 'hecho');

  const generic = ChatToolCards.createLiveToolCard('unknown_tool', { a: 1 });
  assert.match(generic.querySelector('.tool-card-title').textContent, /unknown_tool/);
  assert.match(generic.querySelector('.tool-card-code').textContent, /"a": 1/);
});

test('ChatToolCards - Las herramientas aparecen minimizadas (collapsed) tras su ejecución', t => {
  setup(t);
  const liveCard = ChatToolCards.createLiveToolCard('generic_tool', { param: 'val' });
  assert.equal(isCollapsed(liveCard), false, 'Live card inicial no debe estar colapsada');

  ChatToolCards.updateLiveToolCard(liveCard, 'generic_tool', { param: 'val' }, { success: true }, 50);
  assert.equal(isCollapsed(liveCard), true, 'Live card post-ejecución debe estar colapsada');

  const histCard = ChatToolCards.renderHistoricalToolCard({ function: { name: 'generic_tool', arguments: '{"foo":"bar"}' } }, { content: '{"success":true}' });
  assert.equal(isCollapsed(histCard), true, 'Historical card debe aparecer colapsada');
});

test('ChatToolCards - Herramientas con displayMode: expanded permanecen abiertas tras ejecución e histórico', t => {
  setup(t);
  const args = { type: 'bar', title: 'Test', data: [{ label: 'A', value: 1 }] };
  const liveCard = ChatToolCards.createLiveToolCard('render_chart', args);
  ChatToolCards.updateLiveToolCard(liveCard, 'render_chart', args, { success: true }, 30, { displayMode: 'expanded' });
  assert.equal(isCollapsed(liveCard), false, 'Tarjeta con displayMode expanded no debe estar colapsada');

  const histCard = ChatToolCards.renderHistoricalToolCard({ function: { name: 'render_chart', arguments: JSON.stringify(args) } }, { content: '{"success":true}' });
  assert.equal(isCollapsed(histCard), false, 'Tarjeta histórica con displayMode expanded debe mantenerse abierta');
});

test('ChatToolCards - common frame escapes attributes and keeps internal safe slots', () => {
  const html = ChatToolCards.renderCardHtml({
    className: 'web-search-card" onclick="bad',
    titleHtml: '<span>&lt;script&gt;</span>',
    badgeHtml: '<span class="tool-card-badge status-error">Error</span>',
    bodyHtml: '<code>&lt;img onerror=bad&gt;</code>',
    buttonTitle: '" onclick="bad', collapsed: true
  });
  assert.ok(html.includes('tool-execution-card'));
  assert.ok(html.includes('tool-card-header'));
  assert.ok(html.includes('tool-card-collapsible-body'));
  assert.ok(html.includes('collapsed'));
  assert.ok(html.includes('&quot;'));
  assert.ok(!html.includes(' onclick="bad'));
  assert.ok(!html.includes('<script>'));
});
