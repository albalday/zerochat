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

test('ChatToolCards - Las herramientas aparecen minimizadas (collapsed) tras su ejecución', () => {
  function createMockElement(tag) {
    let _innerHtml = '';
    const children = [];
    const el = {
      tagName: tag.toUpperCase(),
      className: '',
      children,
      classList: {
        contains: (cls) => (el.className || '').split(' ').includes(cls),
        add: (cls) => {
          const classes = (el.className || '').split(' ').filter(Boolean);
          if (!classes.includes(cls)) classes.push(cls);
          el.className = classes.join(' ');
        },
        remove: (cls) => {
          el.className = (el.className || '').split(' ').filter(c => c !== cls).join(' ');
        }
      },
      get innerHTML() { return _innerHtml; },
      set innerHTML(val) {
        _innerHtml = val;
        children.length = 0;
        if (typeof val === 'string' && val.includes('tool-execution-card')) {
          const child = createMockElement('div');
          child.className = val.includes('collapsed') ? 'tool-execution-card collapsed' : 'tool-execution-card';
          children.push(child);
        }
      },
      querySelector: (sel) => {
        if (sel.includes('tool-execution-card')) {
          for (const c of children) {
            if (c.classList.contains('tool-execution-card')) return c;
          }
          if (el.classList.contains('tool-execution-card')) return el;
          return null;
        }
        if (sel.includes('.tool-card-badge')) return { className: '', innerHTML: '' };
        if (sel.includes('.btn-tool-collapse')) return { title: '' };
        return null;
      }
    };
    return el;
  }

  const fakeDoc = {
    createElement: (tag) => createMockElement(tag)
  };

  const previousDoc = global.document;
  global.document = fakeDoc;

  try {
    // 1. Live card fallback
    const liveCard = ChatToolCards.createLiveToolCard('generic_tool', { param: 'val' });
    assert.ok(liveCard);
    const innerCard = liveCard.querySelector('.tool-execution-card');
    assert.equal(innerCard?.classList.contains('collapsed'), false, 'Live card inicial no debe estar colapsada');

    // 2. updateLiveToolCard colapsa la tarjeta post-ejecución
    ChatToolCards.updateLiveToolCard(liveCard, 'generic_tool', { param: 'val' }, { success: true }, 50);
    assert.equal(innerCard?.classList.contains('collapsed'), true, 'Live card post-ejecución debe estar colapsada');

    // 3. renderHistoricalToolCard genera tarjeta colapsada
    const histCard = ChatToolCards.renderHistoricalToolCard({
      function: { name: 'generic_tool', arguments: '{"foo":"bar"}' }
    }, { content: '{"success":true}' });
    assert.ok(histCard);
    const histInner = histCard.querySelector('.tool-execution-card');
    assert.equal(histInner?.classList.contains('collapsed'), true, 'Historical card debe aparecer colapsada');
  } finally {
    if (previousDoc === undefined) delete global.document;
    else global.document = previousDoc;
  }
});


