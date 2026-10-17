const test = require('node:test');
const assert = require('node:assert');
const ChatToolCards = require('../../js/tool-cards.js');

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
