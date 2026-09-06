const { test } = require('node:test');
const assert = require('node:assert/strict');
const UIReasoning = require('../js/ui-reasoning.js');

test('UIReasoning - Formateo de etiquetas de nivel de razonamiento', () => {
  const none = UIReasoning.getReasoningLevelLabel('none');
  assert.equal(none.icon, '⚪');
  assert.ok(none.label);

  const low = UIReasoning.getReasoningLevelLabel('low');
  assert.equal(low.icon, '🟢');

  const med = UIReasoning.getReasoningLevelLabel('medium');
  assert.equal(med.icon, '🟡');

  const high = UIReasoning.getReasoningLevelLabel('high');
  assert.equal(high.icon, '🔴');

  const xhigh = UIReasoning.getReasoningLevelLabel('xhigh');
  assert.equal(xhigh.icon, '🔥');
});

test('UIReasoning - renderReasoningMenuOptions crea botones interactivos', () => {
  const createdButtons = [];
  const fakeContainer = {
    innerHTML: '',
    ownerDocument: {
      createElement: (tag) => {
        const el = {
          tagName: tag,
          type: '',
          className: '',
          attributes: {},
          classList: {
            add: (cls) => { el.className += ' ' + cls; },
            remove: () => {}
          },
          setAttribute: (name, val) => { el.attributes[name] = val; },
          getAttribute: (name) => el.attributes[name],
          addEventListener: (event, handler) => { el._handler = handler; }
        };
        return el;
      }
    },
    appendChild: (child) => {
      createdButtons.push(child);
    }
  };

  const elements = { reasoningOptionsContainer: fakeContainer };
  const reasoningInfo = { levels: ['off', 'low', 'medium', 'high'] };

  let selectedLevel = null;
  UIReasoning.renderReasoningMenuOptions(elements, reasoningInfo, 'low', (lvl) => {
    selectedLevel = lvl;
  });

  assert.equal(createdButtons.length, 4);
  assert.equal(createdButtons[1].attributes['data-level'], 'low');
  assert.ok(createdButtons[1].className.includes('active'));

  // Simular click
  createdButtons[2]._handler({ stopPropagation: () => {} });
  assert.equal(selectedLevel, 'medium');
});

test('UIReasoning - selectReasoningLevel normaliza y emite la intención sin mutar configuración', () => {
  const appConfig = { reasoningEffort: 'none' };
  const labelEl = { textContent: '' };
  const btnEl = {
    classList: {
      classes: new Set(),
      add: function (...cls) { cls.forEach(c => this.classes.add(c)); },
      remove: function (...cls) { cls.forEach(c => this.classes.delete(c)); }
    }
  };
  const menuEl = { style: {} };

  const elements = {
    reasoningLabel: labelEl,
    btnReasoning: btnEl,
    reasoningMenu: menuEl
  };

  let callbackCalledWith = null;
  UIReasoning.selectReasoningLevel(elements, appConfig, 'high', (norm) => {
    callbackCalledWith = norm;
  });

  assert.equal(appConfig.reasoningEffort, 'none');
  assert.equal(callbackCalledWith, 'high');
  assert.equal(labelEl.textContent, 'High');
  assert.ok(btnEl.classList.classes.has('active'));
  assert.ok(btnEl.classList.classes.has('active-high'));
  assert.equal(menuEl.style.display, 'none');

  // Seleccionar 'off' normaliza a 'none'
  UIReasoning.selectReasoningLevel(elements, appConfig, 'off');
  assert.equal(appConfig.reasoningEffort, 'none');
  assert.equal(labelEl.textContent, 'None');
  assert.ok(!btnEl.classList.classes.has('active'));
});

test('UIReasoning - renderReasoningMenuOptions genera atributos ARIA estándar y checkmark SVG', () => {
  const createdButtons = [];
  const fakeContainer = {
    innerHTML: '',
    ownerDocument: {
      createElement: (tag) => {
        const el = {
          tagName: tag,
          type: '',
          className: '',
          attributes: {},
          classList: {
            add: (cls) => { el.className += ' ' + cls; },
            remove: (cls) => { el.className = el.className.replace(cls, '').trim(); }
          },
          setAttribute: (name, val) => { el.attributes[name] = val; },
          getAttribute: (name) => el.attributes[name],
          addEventListener: (event, handler) => { el._handler = handler; }
        };
        return el;
      }
    },
    appendChild: (child) => {
      createdButtons.push(child);
    }
  };

  const elements = { reasoningOptionsContainer: fakeContainer };
  const reasoningInfo = { levels: ['off', 'low', 'medium', 'high'] };

  UIReasoning.renderReasoningMenuOptions(elements, reasoningInfo, 'high', () => {});

  assert.equal(createdButtons.length, 4);
  createdButtons.forEach(btn => {
    assert.equal(btn.attributes['role'], 'menuitemradio');
    assert.ok(btn.innerHTML.includes('option-check'));
    assert.ok(btn.innerHTML.includes('<svg'));
  });

  // El botón 'high' debe tener aria-checked="true"
  const highBtn = createdButtons.find(b => b.attributes['data-level'] === 'high');
  assert.equal(highBtn.attributes['aria-checked'], 'true');
  assert.ok(highBtn.className.includes('active'));

  // Los demás deben tener aria-checked="false"
  const lowBtn = createdButtons.find(b => b.attributes['data-level'] === 'low');
  assert.equal(lowBtn.attributes['aria-checked'], 'false');
});

test('UIReasoning - openReasoningMenu y closeReasoningMenu actualizan aria-expanded', () => {
  const btnEl = {
    attributes: {},
    setAttribute: function(name, val) { this.attributes[name] = val; },
    getAttribute: function(name) { return this.attributes[name]; },
    getBoundingClientRect: () => ({ top: 100, left: 100, width: 80, height: 32 })
  };
  const menuEl = {
    style: {},
    addEventListener: () => {}
  };
  const fakeContainer = {
    innerHTML: '',
    ownerDocument: {
      createElement: () => ({
        attributes: {},
        classList: { add: () => {}, remove: () => {} },
        setAttribute: () => {},
        getAttribute: () => '',
        addEventListener: () => {}
      })
    },
    appendChild: () => {},
    querySelector: () => null
  };

  const elements = {
    btnReasoning: btnEl,
    reasoningMenu: menuEl,
    reasoningOptionsContainer: fakeContainer
  };

  UIReasoning.openReasoningMenu(elements, { apiType: 'openai', reasoningEffort: 'low' });
  assert.equal(btnEl.attributes['aria-expanded'], 'true');
  assert.equal(menuEl.style.display, 'flex');

  UIReasoning.closeReasoningMenu(elements);
  assert.equal(btnEl.attributes['aria-expanded'], 'false');
  assert.equal(menuEl.style.display, 'none');
});
