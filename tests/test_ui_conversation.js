const test = require('node:test');
const assert = require('node:assert/strict');
const UIConversation = require('../js/ui-conversation.js');

function createMockElement(tag, className = '') {
  const children = [];
  const attributes = {};
  const listeners = {};

  let _className = className;
  const el = {
    tagName: tag.toUpperCase(),
    get className() { return _className; },
    set className(val) { _className = val || ''; },
    classList: {
      add: (...cls) => {
        const set = new Set(_className ? _className.split(' ').filter(Boolean) : []);
        cls.forEach(c => set.add(c));
        _className = Array.from(set).join(' ');
      },
      remove: (...cls) => {
        const set = new Set(_className ? _className.split(' ').filter(Boolean) : []);
        cls.forEach(c => set.delete(c));
        _className = Array.from(set).join(' ');
      },
      contains: (c) => {
        const set = new Set(_className ? _className.split(' ').filter(Boolean) : []);
        return set.has(c);
      }
    },
    id: '',
    style: {},
    dataset: {},
    innerHTML: '',
    textContent: '',
    children,
    parentNode: null,
    ownerDocument: null,
    getAttribute(k) { return attributes[k] !== undefined ? attributes[k] : null; },
    setAttribute(k, v) { attributes[k] = String(v); },
    hasAttribute(k) { return attributes[k] !== undefined; },
    removeAttribute(k) { delete attributes[k]; },
    appendChild(child) {
      children.push(child);
      child.parentNode = el;
      return child;
    },
    removeChild(child) {
      const idx = children.indexOf(child);
      if (idx !== -1) {
        children.splice(idx, 1);
        child.parentNode = null;
      }
      return child;
    },
    remove() {
      if (el.parentNode) {
        el.parentNode.removeChild(el);
      }
    },
    addEventListener(evt, fn) {
      listeners[evt] = listeners[evt] || [];
      listeners[evt].push(fn);
    },
    removeEventListener(evt, fn) {
      if (!listeners[evt]) return;
      listeners[evt] = listeners[evt].filter(f => f !== fn);
    },
    querySelector(sel) {
      if (sel === '.message-content') return children.find(c => c.className?.includes('message-content'));
      if (sel === '.btn-delete') return children.find(c => c.className?.includes('btn-delete'));
      if (sel === 'img') return children.find(c => c.tagName === 'IMG');
      return null;
    },
    querySelectorAll(sel) {
      if (sel === '.message-wrapper') return children.filter(c => c.className?.includes('message-wrapper'));
      return [];
    }
  };

  return el;
}

function createMockDocument() {
  const doc = {
    createElement(tag) {
      const el = createMockElement(tag);
      el.ownerDocument = doc;
      return el;
    }
  };
  return doc;
}

test('UIConversation - extractBaseId removes turn/tool suffixes', () => {
  assert.equal(UIConversation.extractBaseId('msg_ast_123_turn_0_assistant'), 'msg_ast_123');
  assert.equal(UIConversation.extractBaseId('msg_ast_123_turn_0_tool_call_1'), 'msg_ast_123');
  assert.equal(UIConversation.extractBaseId('msg_ast_123_final'), 'msg_ast_123');
  assert.equal(UIConversation.extractBaseId('msg_usr_456'), 'msg_usr_456');
});

test('UIConversation - isDateTimeInitialTurn detects date anchors', () => {
  assert.equal(UIConversation.isDateTimeInitialTurn({ role: 'user', content: 'La fecha y hora actual es: lunes' }), true);
  assert.equal(UIConversation.isDateTimeInitialTurn({ role: 'user', content: 'The current date and time is: Mon' }), true);
  assert.equal(UIConversation.isDateTimeInitialTurn({ role: 'user', content: 'Hola, ¿cómo estás?' }), false);
  assert.equal(UIConversation.isDateTimeInitialTurn({ role: 'assistant', content: 'OK' }), false);
});

test('UIConversation - showTypingIndicator and removeTypingIndicator manage typing dot element', () => {
  const doc = createMockDocument();
  const container = doc.createElement('div');

  UIConversation.showTypingIndicator(container);
  assert.equal(container.children.length, 1);
  assert.equal(container.children[0].id, 'typing-indicator-wrapper');

  // Calling it again should not add a second one
  UIConversation.showTypingIndicator(container);
  assert.equal(container.children.length, 1);

  UIConversation.removeTypingIndicator();
  assert.equal(container.children.length, 0);
});

test('UIConversation - appendUserMessage builds user message DOM and handles actions', () => {
  const doc = createMockDocument();
  const container = doc.createElement('div');
  const welcomeBanner = doc.createElement('div');
  container.appendChild(welcomeBanner);

  let reusedText = '';
  const msgId = UIConversation.appendUserMessage(container, welcomeBanner, {
    text: 'Hola mundo',
    originalPrompt: 'Hola mundo prompt',
    attachedImages: [{ name: 'foto.png', dataUrl: 'data:image/png;base64,abc' }]
  }, {
    onReuse: (txt) => { reusedText = txt; }
  });

  assert.ok(msgId.startsWith('msg_usr_'));
  assert.equal(welcomeBanner.style.display, 'none');

  const wrapper = container.children.find(c => c.className?.includes('message-wrapper user'));
  assert.ok(wrapper);
  assert.equal(wrapper.getAttribute('data-msg-id'), msgId);
});

test('UIConversation - createAssistantMessagePlaceholder builds assistant message DOM structure', () => {
  const doc = createMockDocument();
  const container = doc.createElement('div');

  let branched = false;
  const result = UIConversation.createAssistantMessagePlaceholder(container, 'test_ast_1', {
    onBranch: () => { branched = true; }
  });

  assert.ok(result.wrapper);
  assert.equal(result.wrapper.getAttribute('data-msg-id'), 'test_ast_1');
  assert.equal(result.wrapper.getAttribute('data-base-id'), 'test_ast_1');
  assert.ok(result.content);
  assert.ok(result.actions);
});

test('UIConversation - removeMessage blocks removal when conversation is busy', () => {
  const doc = createMockDocument();
  const container = doc.createElement('div');
  const wrapper = doc.createElement('div');
  wrapper.className = 'message-wrapper user';
  wrapper.setAttribute('data-msg-id', 'msg_to_delete');
  container.appendChild(wrapper);

  let saved = false;
  let turnsRemoved = 0;
  UIConversation.removeMessage(wrapper, {
    isBusy: () => true,
    removeTurn: () => { turnsRemoved++; return { ok: true, removedCount: 1 }; },
    saveSession: () => { saved = true; },
    messagesList: container
  });

  assert.equal(turnsRemoved, 0, 'No debe eliminar turno si la conversación está ocupada');
  assert.equal(container.children.length, 1, 'El elemento no debe borrarse del DOM');
  assert.equal(saved, false);
});

test('UIConversation - removeMessage removes turn, removes from DOM, and shows welcomeBanner if empty', () => {
  const doc = createMockDocument();
  const container = doc.createElement('div');
  const welcomeBanner = doc.createElement('div');
  const wrapper = doc.createElement('div');
  wrapper.className = 'message-wrapper user';
  wrapper.setAttribute('data-msg-id', 'msg_to_delete');
  container.appendChild(wrapper);

  let saved = false;
  let turnsRemoved = 0;
  UIConversation.removeMessage(wrapper, {
    isBusy: () => false,
    removeTurn: ({ msgId }) => {
      assert.equal(msgId, 'msg_to_delete');
      turnsRemoved++;
      return { ok: true, removedCount: 1 };
    },
    saveSession: () => { saved = true; },
    messagesList: container,
    welcomeBanner
  });

  assert.equal(turnsRemoved, 1);
  assert.equal(container.children.includes(wrapper), false);
  assert.equal(saved, true);
  assert.equal(container.children.includes(welcomeBanner), true);
  assert.equal(welcomeBanner.style.display, '');
});
