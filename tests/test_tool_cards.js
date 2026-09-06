const test = require('node:test');
const assert = require('node:assert');
const ChatToolCards = require('../js/tool-cards.js');

test('ChatToolCards - Normalización de nombres de herramientas', () => {
  assert.equal(ChatToolCards.normalizeName('execute_javascript'), 'executejavascript');
  assert.equal(ChatToolCards.normalizeName('SEARCH_WEB'), 'searchweb');
  assert.equal(ChatToolCards.normalizeName('fetch_web_page'), 'fetchwebpage');
  assert.equal(ChatToolCards.normalizeName('download_pdf'), 'downloadpdf');
});

test('ChatToolCards - resuelve la vista declarada por la tool registrada', () => {
  const previousWindow = global.window;
  const view = { createLiveCard: () => null };
  global.window = {
    ChatAgentCore: {
      registry: {
        getTool: (name) => name === 'view_tool' ? { view } : null
      }
    }
  };

  try {
    assert.equal(ChatToolCards.resolveToolView('view_tool'), view);
    assert.equal(ChatToolCards.resolveToolView('unknown_tool'), null);
  } finally {
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
  }
});

test('ChatToolCards - Métodos de renderizado y actualización expuestos', () => {
  assert.equal(typeof ChatToolCards.updateLiveToolCard, 'function');
  assert.equal(typeof ChatToolCards.createLiveToolCard, 'function');
  assert.equal(typeof ChatToolCards.renderHistoricalToolCard, 'function');
});

