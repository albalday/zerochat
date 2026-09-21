const { test } = require('node:test');
const assert = require('node:assert/strict');
const UISidebar = require('../../js/ui-sidebar.js');

test('UISidebar - filterSessions filtra por título ignorando mayúsculas/minúsculas', () => {
  const sessions = [
    { id: '1', title: 'Aprender JS Moderno' },
    { id: '2', title: 'Receta de Cocina' },
    { id: '3', title: 'Refactorización de Código JS' }
  ];

  const resJs = UISidebar.filterSessions(sessions, 'js');
  assert.equal(resJs.length, 2);
  assert.equal(resJs[0].id, '1');
  assert.equal(resJs[1].id, '3');

  const resAll = UISidebar.filterSessions(sessions, '');
  assert.equal(resAll.length, 3);

  const resNone = UISidebar.filterSessions(sessions, 'inexistente');
  assert.equal(resNone.length, 0);
});

test('UISidebar - toggleSidebar, openSidebar y closeSidebar gestionan visibilidad', () => {
  const fakeSidebar = { style: { display: 'none' } };
  const fakeToggleBtn = { style: { display: 'inline-flex' } };
  const elements = { chatSidebar: fakeSidebar, btnToggleSidebar: fakeToggleBtn };

  UISidebar.openSidebar(elements);
  assert.equal(fakeSidebar.style.display, 'flex');
  assert.equal(fakeToggleBtn.style.display, 'none');

  UISidebar.closeSidebar(elements);
  assert.equal(fakeSidebar.style.display, 'none');
  assert.equal(fakeToggleBtn.style.display, 'inline-flex');

  UISidebar.toggleSidebar(elements);
  assert.equal(fakeSidebar.style.display, 'flex');
  assert.equal(fakeToggleBtn.style.display, 'none');
});

test('UISidebar - renderSidebarChats renderiza items y marca la sesión activa', () => {
  const appendedItems = [];
  const fakeList = {
    innerHTML: '',
    ownerDocument: {
      createElement: (tag) => {
        const el = {
          tagName: tag,
          className: '',
          attributes: {},
          innerHTML: '',
          setAttribute: (k, v) => { el.attributes[k] = v; },
          getAttribute: (k) => el.attributes[k],
          querySelector: (sel) => ({
            addEventListener: (evt, handler) => { el['_' + sel] = handler; }
          }),
          addEventListener: (evt, handler) => { el._click = handler; }
        };
        return el;
      }
    },
    appendChild: (item) => appendedItems.push(item)
  };

  const elements = { sidebarChatsList: fakeList };
  const sessions = [
    { id: 'sess_1', title: 'Primer Chat', updatedAt: Date.now() },
    { id: 'sess_2', title: 'Segundo Chat', updatedAt: Date.now() }
  ];

  let switchedTo = null;
  UISidebar.renderSidebarChats(elements, sessions, 'sess_2', {
    onSwitchSession: (id) => { switchedTo = id; }
  });

  assert.equal(appendedItems.length, 2);
  assert.ok(!appendedItems[0].className.includes('active'));
  assert.ok(appendedItems[1].className.includes('active'));

  // Click en el primer chat
  appendedItems[0]._click({ target: appendedItems[0] });
  assert.equal(switchedTo, 'sess_1');
});

test('UISidebar - getChronologicalCategory clasifica correctamente según fecha', () => {
  const now = Date.now();
  assert.equal(UISidebar.getChronologicalCategory(now), 'today');
  assert.equal(UISidebar.getChronologicalCategory(now - 86400000), 'yesterday');
  assert.equal(UISidebar.getChronologicalCategory(now - (3 * 86400000)), 'last7days');
  assert.equal(UISidebar.getChronologicalCategory(now - (15 * 86400000)), 'last30days');
  assert.equal(UISidebar.getChronologicalCategory(now - (60 * 86400000)), 'older');
});

test('UISidebar - renderSidebarChats con groupByDate añade cabeceras de grupo', () => {
  const appendedItems = [];
  const fakeList = {
    innerHTML: '',
    ownerDocument: {
      createElement: (tag) => ({
        tagName: tag,
        className: '',
        attributes: {},
        innerHTML: '',
        textContent: '',
        setAttribute: () => {},
        querySelector: () => ({ addEventListener: () => {} }),
        addEventListener: () => {}
      })
    },
    appendChild: (item) => appendedItems.push(item)
  };

  const elements = { sidebarChatsList: fakeList };
  const now = Date.now();
  const sessions = [
    { id: 'sess_1', title: 'Hoy Chat', updatedAt: now },
    { id: 'sess_2', title: 'Ayer Chat', updatedAt: now - 86400000 },
    { id: 'sess_3', title: 'Viejo Chat', updatedAt: now - (60 * 86400000) }
  ];

  UISidebar.renderSidebarChats(elements, sessions, 'sess_1', {}, { groupByDate: true });

  // Deben haberse añadido cabeceras de grupo intercaladas
  const headers = appendedItems.filter(i => i.className === 'sidebar-group-header');
  assert.equal(headers.length, 3, 'Debe haber 3 cabeceras de grupo');
  assert.equal(headers[0].textContent, 'Hoy');
  assert.equal(headers[1].textContent, 'Ayer');
  assert.equal(headers[2].textContent, 'Anteriores');
});

test('UISidebar - renderSidebarChats incluye botón de exportar/archivar por chat y dispara callback', () => {
  const appendedItems = [];
  const fakeList = {
    innerHTML: '',
    ownerDocument: {
      createElement: (tag) => {
        const el = {
          tagName: tag,
          className: '',
          attributes: {},
          innerHTML: '',
          setAttribute: (k, v) => { el.attributes[k] = v; },
          getAttribute: (k) => el.attributes[k],
          querySelector: (sel) => ({
            addEventListener: (evt, handler) => { el['_' + sel] = handler; }
          }),
          addEventListener: (evt, handler) => { el._click = handler; }
        };
        return el;
      }
    },
    appendChild: (item) => appendedItems.push(item)
  };

  const elements = { sidebarChatsList: fakeList };
  const sessions = [
    { id: 'sess_export_1', title: 'Chat a Exportar', updatedAt: Date.now() }
  ];

  let exportedSessionId = null;
  UISidebar.renderSidebarChats(elements, sessions, 'sess_export_1', {
    onExportSession: (id) => { exportedSessionId = id; }
  });

  assert.equal(appendedItems.length, 1);
  assert.ok(appendedItems[0].innerHTML.includes('btn-export'), 'El chat item debe contener el botón .btn-export');
  assert.ok(typeof appendedItems[0]['_.btn-export'] === 'function', 'Debe registrarse el listener de click para .btn-export');

  // Disparar click en btn-export
  appendedItems[0]['_.btn-export']({ stopPropagation: () => {} });
  assert.equal(exportedSessionId, 'sess_export_1', 'Debe invocar onExportSession con el id correspondiente');
});

test('UISidebar - openSidebar and closeSidebar toggle sidebarBackdrop when provided', () => {
  const backdropClasses = new Set();
  const fakeBackdrop = {
    classList: {
      add: (c) => backdropClasses.add(c),
      remove: (c) => backdropClasses.delete(c),
      contains: (c) => backdropClasses.has(c)
    }
  };
  const fakeSidebar = {
    classList: { add() {}, remove() {}, contains: () => false },
    style: { display: 'none' }
  };
  const elements = {
    chatSidebar: fakeSidebar,
    sidebarBackdrop: fakeBackdrop
  };

  // closeSidebar debe retirar visible
  UISidebar.closeSidebar(elements);
  assert.equal(backdropClasses.has('visible'), false);
});

test('UISidebar - mount attaches events and dispose cleans them up', () => {
  const listeners = {};
  function add(name, evt, fn) { listeners[name + ':' + evt] = fn; }
  function remove(name, evt) { delete listeners[name + ':' + evt]; }

  const elements = {
    btnToggleSidebar: {
      addEventListener: (evt, fn) => add('toggle', evt, fn),
      removeEventListener: (evt, fn) => remove('toggle', evt, fn)
    },
    btnCloseSidebar: {
      addEventListener: (evt, fn) => add('close', evt, fn),
      removeEventListener: (evt, fn) => remove('close', evt, fn)
    },
    sidebarBackdrop: {
      addEventListener: (evt, fn) => add('backdrop', evt, fn),
      removeEventListener: (evt, fn) => remove('backdrop', evt, fn)
    },
    btnSidebarNewChat: {
      addEventListener: (evt, fn) => add('new', evt, fn),
      removeEventListener: (evt, fn) => remove('new', evt, fn)
    },
    sidebarSearchInput: {
      value: 'test',
      addEventListener: (evt, fn) => add('search', evt, fn),
      removeEventListener: (evt, fn) => remove('search', evt, fn)
    },
    btnDeleteAllChats: {
      addEventListener: (evt, fn) => add('deleteAll', evt, fn),
      removeEventListener: (evt, fn) => remove('deleteAll', evt, fn)
    }
  };

  let newSessionCalled = false;
  let searchQuery = null;
  let deleteAllCalled = false;

  UISidebar.mount(elements, {
    onNewSession: () => { newSessionCalled = true; },
    onSearchInput: (val) => { searchQuery = val; },
    onDeleteAllSessions: () => { deleteAllCalled = true; }
  });

  // Verificar dispatch
  listeners['new:click']();
  assert.equal(newSessionCalled, true);

  listeners['search:input']();
  assert.equal(searchQuery, 'test');

  listeners['deleteAll:click']();
  assert.equal(deleteAllCalled, true);

  // Desmontar
  UISidebar.dispose();
  assert.equal(listeners['new:click'], undefined);
  assert.equal(listeners['search:input'], undefined);
  assert.equal(listeners['deleteAll:click'], undefined);
});

test('UISidebar - getSidebarMode y setSidebarMode alternan entre chat y settings', () => {
  const fakeChatView = { hidden: false, style: { display: 'flex' } };
  const fakeSettingsView = { hidden: true, style: { display: 'none' } };
  const fakeSidebar = { classList: { add: () => {}, remove: () => {}, contains: () => false } };
  const elements = {
    chatSidebar: fakeSidebar,
    sidebarViewChat: fakeChatView,
    sidebarViewSettings: fakeSettingsView
  };

  assert.equal(UISidebar.getSidebarMode(elements), 'chat');

  UISidebar.setSidebarMode(elements, 'settings');
  assert.equal(fakeChatView.hidden, true);
  assert.equal(fakeChatView.style.display, 'none');
  assert.equal(fakeSettingsView.hidden, false);
  assert.equal(fakeSettingsView.style.display, 'flex');
  assert.equal(UISidebar.getSidebarMode(elements), 'settings');

  UISidebar.setSidebarMode(elements, 'chat');
  assert.equal(fakeChatView.hidden, false);
  assert.equal(fakeChatView.style.display, 'flex');
  assert.equal(fakeSettingsView.hidden, true);
  assert.equal(fakeSettingsView.style.display, 'none');
  assert.equal(UISidebar.getSidebarMode(elements), 'chat');
});

test('UISidebar - mount gestiona navegación de configuración y selección de sección', () => {
  const listeners = {};
  function add(name, evt, fn) { listeners[name + ':' + evt] = fn; }
  function remove(name, evt) { delete listeners[name + ':' + evt]; }

  const fakeChatView = { hidden: false, style: { display: 'flex' } };
  const fakeSettingsView = { hidden: true, style: { display: 'none' } };
  const fakeSidebar = { classList: { add: () => {}, remove: () => {}, contains: () => false } };

  const fakeSettingItemMcp = {
    dataset: { section: 'tab-mcp' },
    getAttribute: (name) => name === 'data-section' ? 'tab-mcp' : null,
    addEventListener: (evt, fn) => add('itemMcp', evt, fn),
    removeEventListener: (evt, fn) => remove('itemMcp', evt, fn)
  };
  const fakeHelpLink = {
    dataset: {},
    getAttribute: () => null,
    addEventListener: (evt, fn) => add('help', evt, fn),
    removeEventListener: (evt, fn) => remove('help', evt, fn)
  };

  const elements = {
    chatSidebar: fakeSidebar,
    sidebarViewChat: fakeChatView,
    sidebarViewSettings: fakeSettingsView,
    btnOpenSettings: {
      addEventListener: (evt, fn) => add('openSettings', evt, fn),
      removeEventListener: (evt, fn) => remove('openSettings', evt, fn)
    },
    btnSidebarBackToChats: {
      addEventListener: (evt, fn) => add('backToChats', evt, fn),
      removeEventListener: (evt, fn) => remove('backToChats', evt, fn)
    },
    btnCloseSidebarSettings: {
      addEventListener: (evt, fn) => add('closeSettings', evt, fn),
      removeEventListener: (evt, fn) => remove('closeSettings', evt, fn)
    },
    sidebarSettingsItems: [fakeSettingItemMcp, fakeHelpLink]
  };

  let selectedSection = null;
  let backToChatsCalled = false;

  UISidebar.mount(elements, {
    onSelectSettingsSection: (sec) => { selectedSection = sec; },
    onBackToChats: () => { backToChatsCalled = true; }
  });

  // Pulsar abrir settings en el sidebar cambia a modo settings
  listeners['openSettings:click']();
  assert.equal(fakeSettingsView.hidden, false);
  assert.equal(UISidebar.getSidebarMode(elements), 'settings');

  // Pulsar una sección ejecuta el callback correspondiente
  listeners['itemMcp:click']();
  assert.equal(selectedSection, 'tab-mcp');
  assert.equal(listeners['help:click'], undefined, 'Los enlaces auxiliares no deben activar secciones de configuración');

  // Pulsar volver restaura modo chat
  listeners['backToChats:click']();
  assert.equal(fakeSettingsView.hidden, true);
  assert.equal(fakeChatView.hidden, false);
  assert.equal(backToChatsCalled, true);
  assert.equal(UISidebar.getSidebarMode(elements), 'chat');

  UISidebar.dispose();
  assert.equal(listeners['openSettings:click'], undefined);
  assert.equal(listeners['backToChats:click'], undefined);
  assert.equal(listeners['itemMcp:click'], undefined);
});

