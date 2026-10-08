const test = require('node:test');
const assert = require('node:assert/strict');
const UIConversation = require('../../js/ui-conversation.js');

function createMockElement(tag, className = '') {
  const children = [];
  const attributes = {};
  const listeners = {};

  let _className = className;
  let _textContent = '';
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
      },
      toggle: (c, force) => {
        const set = new Set(_className ? _className.split(' ').filter(Boolean) : []);
        const enabled = force === undefined ? !set.has(c) : Boolean(force);
        if (enabled) set.add(c); else set.delete(c);
        _className = Array.from(set).join(' ');
        return enabled;
      }
    },
    id: '',
    style: {},
    dataset: {},
    innerHTML: '',
    get textContent() {
      if (children.length > 0) {
        return children.map(c => c.textContent || '').join('');
      }
      return _textContent;
    },
    set textContent(val) {
      _textContent = String(val || '');
      children.length = 0;
    },
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
    insertBefore(newChild, refChild) {
      const idx = children.indexOf(refChild);
      if (idx !== -1) {
        children.splice(idx, 0, newChild);
      } else {
        children.push(newChild);
      }
      newChild.parentNode = el;
      return newChild;
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
    emit(evt, data) {
      if (listeners[evt]) listeners[evt].forEach(fn => fn(data));
    },
    click() {
      if (listeners['click']) listeners['click'].forEach(fn => fn({ type: 'click' }));
    },
    querySelector(sel) {
      function findDeep(node) {
        for (const c of node.children) {
          if (sel.startsWith('.')) {
            const targetClass = sel.slice(1);
            const classes = (c.className || '').split(' ').filter(Boolean);
            if (classes.includes(targetClass)) return c;
          }
          if (sel === 'img' && c.tagName === 'IMG') return c;
          if (c.children?.length) {
            const found = findDeep(c);
            if (found) return found;
          }
        }
        return null;
      }
      return findDeep(el);
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

test('UIConversation - shared response blocks render final and streaming text without duplicating siblings', () => {
  const doc = createMockDocument();
  const container = doc.createElement('div');
  const first = UIConversation.createAssistantBlock(container);
  const second = UIConversation.createAssistantBlock(container);
  let attached = 0;
  UIConversation.renderAssistantBlock(first, '**First**', { streaming: true, attachListeners: () => attached++ });
  UIConversation.renderAssistantBlock(second, 'Other response');
  const untouched = second.innerHTML;
  assert.match(first.innerHTML, /<strong>First/);
  assert.match(first.innerHTML, /streaming-cursor/);
  UIConversation.renderAssistantBlock(first, '**Finished**', { attachListeners: () => attached++ });
  assert.doesNotMatch(first.innerHTML, /streaming-cursor/);
  assert.match(first.innerHTML, /Finished/);
  assert.equal(second.innerHTML, untouched);
  assert.equal(container.children.length, 2);
  assert.equal(attached, 2);
});

test('UIConversation - connection errors escape remote details and URLs while retaining translated markup', () => {
  const doc = createMockDocument();
  const row = doc.createElement('div');
  const content = doc.createElement('div');
  const actions = doc.createElement('div');
  const payload = '<img src=x onerror="probe()">';
  UIConversation.renderConnectionError({ row, content, actions }, payload, payload);
  assert.doesNotMatch(content.innerHTML, /<img/);
  assert.equal((content.innerHTML.match(/&lt;img/g) || []).length, 2);
  assert.match(content.innerHTML, /<strong>/);
  assert.equal(row.classList.contains('message-error'), true);
  assert.equal(actions.style.display, 'inline-flex');
});

test('UIConversation - shared copy keeps current text and restores the correct label', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const descriptor = Object.getOwnPropertyDescriptor(global, 'navigator');
  const copied = [];
  Object.defineProperty(global, 'navigator', { configurable: true, value: { clipboard: { writeText: async text => copied.push(text) } } });
  t.after(() => {
    if (descriptor) Object.defineProperty(global, 'navigator', descriptor);
    else delete global.navigator;
  });
  const button = createMockElement('button');
  let text = 'Original';
  const dispose = UIConversation.bindMessageCopy(button, () => text, 'btn_copy_user_title');
  assert.equal(await button.onclick(), true);
  assert.equal(button.classList.contains('copied'), true);
  text = 'Updated';
  assert.equal(await button.onclick(), true);
  assert.deepEqual(copied, ['Original', 'Updated']);
  t.mock.timers.tick(2000);
  assert.equal(button.classList.contains('copied'), false);
  assert.equal(button.title, require('../../js/i18n.js').t('btn_copy_user_title'));
  dispose();
  assert.equal(button.onclick, null);
});

test('UIConversation - failed, unavailable or disposed clipboard operations never report success', async t => {
  const descriptor = Object.getOwnPropertyDescriptor(global, 'navigator');
  const nav = {};
  Object.defineProperty(global, 'navigator', { configurable: true, value: nav });
  t.after(() => {
    if (descriptor) Object.defineProperty(global, 'navigator', descriptor);
    else delete global.navigator;
  });
  const errors = t.mock.method(console, 'error', () => {});
  const button = createMockElement('button');
  const dispose = UIConversation.bindMessageCopy(button, () => 'Text');
  assert.equal(await button.onclick(), false);
  nav.clipboard = { writeText: async () => { throw new Error('Clipboard denied'); } };
  assert.equal(await button.onclick(), false);
  assert.equal(errors.mock.callCount(), 1);
  let complete;
  nav.clipboard.writeText = () => new Promise(resolve => { complete = resolve; });
  const pending = button.onclick();
  dispose();
  complete();
  assert.equal(await pending, false);
  assert.equal(button.classList.contains('copied'), false);
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

test('UIConversation - renderiza imágenes adjuntas de forma segura sanitizando URLs y evitando inyección', () => {
  const doc = createMockDocument();
  const container = doc.createElement('div');
  const attachedImages = [
    { name: 'segura.png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' },
    { name: 'peligrosa.png', dataUrl: 'javascript:alert(1)' },
    { name: 'xss.png', dataUrl: 'data:text/html,<script>alert(1)</script>' }
  ];

  const msgId = UIConversation.appendUserMessage(container, null, {
    text: 'Mensaje con imágenes',
    attachedImages
  });
  assert.ok(msgId, 'Debe devolver un id de mensaje');

  const wrapper = container.children[0];
  const grid = wrapper.querySelector('.message-content').children.find(c => c.className === 'message-images-grid');
  assert.ok(grid, 'Debe crear la rejilla de imágenes');
  // Solo la imagen válida data:image/png debe producir un elemento IMG
  const itemDivs = grid.children;
  assert.equal(itemDivs.length, 3);

  const safeItem = itemDivs[0];
  const safeImg = safeItem.children.find(c => c.tagName === 'IMG');
  assert.ok(safeImg, 'La imagen segura debe renderizar un elemento IMG');
  assert.equal(safeImg.getAttribute('src'), 'data:image/png;base64,iVBORw0KGgo=');
  assert.equal(safeImg.getAttribute('alt'), 'segura.png');

  const unsafeItem1 = itemDivs[1];
  const unsafeImg1 = unsafeItem1.children.find(c => c.tagName === 'IMG');
  assert.equal(unsafeImg1, undefined, 'La URL javascript: no debe generar elemento IMG');

  const unsafeItem2 = itemDivs[2];
  const unsafeImg2 = unsafeItem2.children.find(c => c.tagName === 'IMG');
  assert.equal(unsafeImg2, undefined, 'La URL data:text/html no debe generar elemento IMG');
});

function createScrollContainer({ scrollHeight = 1000, clientHeight = 200 } = {}) {
  const listeners = {};
  const container = {
    scrollHeight,
    clientHeight,
    scrollTop: scrollHeight - clientHeight,
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    emit(type, event = {}) { (listeners[type] || []).forEach(fn => fn(event)); },
    userScrollTo(top) { container.scrollTop = top; container.emit('scroll'); }
  };
  return container;
}

test('UIConversation - scrollToBottom sigue el final salvo que el usuario suba por arrastre, teclas o toque, y lo retoma al volver o con force', () => {
  {
    const container = createScrollContainer();
    UIConversation.scrollToBottom(container);
    container.scrollHeight = 1400;
    UIConversation.scrollToBottom(container);
    assert.equal(container.scrollTop, 1400);
  }

  {
    const container = createScrollContainer();
    UIConversation.scrollToBottom(container);
    container.emit('wheel', { deltaY: -100 });
    container.scrollTop = 300;
    container.scrollHeight = 1400;
    UIConversation.scrollToBottom(container);
    assert.equal(container.scrollTop, 300);
  }

  {
    const dragged = createScrollContainer();
    UIConversation.scrollToBottom(dragged);
    dragged.userScrollTo(500);
    UIConversation.scrollToBottom(dragged);
    assert.equal(dragged.scrollTop, 500);

    const keyed = createScrollContainer();
    UIConversation.scrollToBottom(keyed);
    keyed.emit('keydown', { key: 'PageUp' });
    keyed.scrollTop = 100;
    UIConversation.scrollToBottom(keyed);
    assert.equal(keyed.scrollTop, 100);

    const touched = createScrollContainer();
    UIConversation.scrollToBottom(touched);
    touched.emit('touchstart', { touches: [{ clientY: 100 }] });
    touched.emit('touchmove', { touches: [{ clientY: 180 }] });
    touched.scrollTop = 50;
    UIConversation.scrollToBottom(touched);
    assert.equal(touched.scrollTop, 50);
  }

  {
    const container = createScrollContainer();
    UIConversation.scrollToBottom(container);
    container.emit('wheel', { deltaY: -100 });
    container.userScrollTo(790);
    container.scrollHeight = 1400;
    UIConversation.scrollToBottom(container);
    assert.equal(container.scrollTop, 1400);

    container.emit('wheel', { deltaY: -100 });
    container.scrollTop = 200;
    UIConversation.scrollToBottom(container, { force: true });
    assert.equal(container.scrollTop, 1400);
  }
});

test('UIConversation - renderContextSummaryBanner pinta el resumen plegado como Markdown saneado', () => {
  const doc = createMockDocument();
  const container = doc.createElement('div');
  const summaryBlock = {
    role: 'system',
    content: 'Resumen **previo** <img src=x onerror="alert(1)">',
    _isSummaryBlock: true
  };

  const banner = UIConversation.renderContextSummaryBanner(container, summaryBlock);
  assert.ok(banner);
  assert.equal(banner.tagName, 'DETAILS');
  assert.equal(banner.className, 'branch-summary-banner');
  assert.equal(banner.open, undefined, 'Debe estar plegado por defecto');
  assert.match(banner.innerHTML, /<summary class="branch-summary-header">/);
  assert.match(banner.innerHTML, /<strong>previo<\/strong>/);
  assert.doesNotMatch(banner.innerHTML, /<img src=x/);
  assert.match(banner.innerHTML, /&lt;img/);
  assert.equal(UIConversation.renderContextSummaryBanner(container, { content: '' }), null);
});

test('UIConversation - renderSessionMessages incluye el banner de resumen cuando hay un bloque de síntesis', () => {
  const doc = createMockDocument();
  const messagesList = doc.createElement('div');
  const welcomeBanner = doc.createElement('div');
  const elements = { messagesList, welcomeBanner };

  const history = [
    { id: 's1', role: 'system', content: 'Prompt base' },
    { id: 's2', role: 'system', content: 'Resumen consolidado', _isSummaryBlock: true },
    { id: 'a1', role: 'assistant', content: 'Última respuesta del asistente' }
  ];

  UIConversation.renderSessionMessages(elements, history);
  const banner = messagesList.querySelector('.branch-summary-banner');
  assert.ok(banner, 'El banner de resumen debe estar presente en el contenedor de mensajes');
  assert.equal(welcomeBanner.style.display, 'none');
});

test('UIConversation - showBranchLoadingIndicator y hideBranchLoadingIndicator actualizan el DOM y el botón', () => {
  const doc = createMockDocument();
  const wrapper = doc.createElement('div');
  wrapper.className = 'message-wrapper assistant';

  const contentWrapper = doc.createElement('div');
  contentWrapper.className = 'message-content-wrapper';
  const content = doc.createElement('div');
  content.className = 'message-content';
  content.textContent = 'Mensaje de prueba';
  const footerRow = doc.createElement('div');
  footerRow.className = 'message-footer-row';

  const btnBranch = doc.createElement('button');
  btnBranch.className = 'btn-msg-action btn-branch-conversation';
  btnBranch.title = 'Crear una rama desde esta respuesta';
  footerRow.appendChild(btnBranch);

  contentWrapper.appendChild(content);
  contentWrapper.appendChild(footerRow);
  wrapper.appendChild(contentWrapper);

  // 1. Mostrar indicador de carga
  UIConversation.showBranchLoadingIndicator(wrapper, 'Resumiendo contexto previo...');

  assert.equal(btnBranch.disabled, true, 'El botón debe quedar deshabilitado');
  assert.ok(btnBranch.classList.contains('is-loading'), 'El botón debe tener la clase is-loading');
  assert.equal(btnBranch.title, 'Resumiendo contexto previo...');

  const indicator = wrapper.querySelector('.branch-progress-indicator');
  assert.ok(indicator, 'Debe crearse el indicador de progreso');
  assert.equal(indicator.getAttribute('role'), 'status');
  assert.equal(indicator.getAttribute('aria-live'), 'polite');
  assert.ok(indicator.textContent.includes('Resumiendo contexto previo...'));

  // Llamada idempotente (no duplica)
  UIConversation.showBranchLoadingIndicator(wrapper, 'Resumiendo contexto previo...');
  const allIndicators = contentWrapper.children.filter(c => c.className?.includes('branch-progress-indicator'));
  assert.equal(allIndicators.length, 1, 'No debe duplicar el indicador');

  // 2. Ocultar indicador de carga
  UIConversation.hideBranchLoadingIndicator(wrapper);

  assert.equal(btnBranch.disabled, false, 'El botón debe volver a estar habilitado');
  assert.equal(btnBranch.classList.contains('is-loading'), false, 'Debe removerse la clase is-loading');
  assert.equal(btnBranch.title, 'Crear una rama desde esta respuesta', 'Debe restaurarse el título del botón');
  assert.equal(btnBranch.getAttribute('aria-label'), 'Crear una rama desde esta respuesta');
  assert.doesNotMatch(btnBranch.innerHTML, /ui-icon-spin/, 'Debe retirarse el spinner');
  assert.equal(wrapper.querySelector('.branch-progress-indicator'), null, 'El indicador debe haberse eliminado del DOM');
});


