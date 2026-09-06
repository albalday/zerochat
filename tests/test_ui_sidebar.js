const { test } = require('node:test');
const assert = require('node:assert/strict');
const UISidebar = require('../js/ui-sidebar.js');

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
