const test = require('node:test');
const assert = require('node:assert');
const ChatToolCards = require('../../js/tool-cards.js');
const AgentCore = require('../../js/agent-core.js');
const { installDom } = require('../helpers/dom-env.js');

/** Registra en el registro real una herramienta de prueba con su vista y la retira al terminar. */
function registerTool(t, options) {
  const tool = new AgentCore.Tool({ execute: async () => ({ success: true }), ...options });
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

test('ChatToolCards - resuelve la vista declarada por la tool registrada', t => {
  const view = { id: 'view_tool', createLiveCard: () => null };
  registerTool(t, { name: 'view_tool', view });
  assert.equal(ChatToolCards.resolveToolView('view_tool').createLiveCard, view.createLiveCard);
  assert.equal(ChatToolCards.resolveToolView('unknown_tool'), null);
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
  assert.equal(ChatToolCards.resolveToolDisplayMode('render_chart'), 'expanded');
  assert.equal(ChatToolCards.resolveToolDisplayMode('other_tool'), null);

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
