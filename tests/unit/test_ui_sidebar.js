const { test } = require('node:test');
const assert = require('node:assert/strict');
const UISidebar = require('../../js/ui-sidebar.js');
const I18n = require('../../js/i18n.js');
const { installDom, getAppElements } = require('../helpers/dom-env.js');

const DAY_MS = 86400000;

/** Barra lateral real montada con callbacks que registran sus llamadas. */
function setup(t, { width = 1280 } = {}) {
  const dom = installDom({ app: true });
  dom.window.innerWidth = width;
  const elements = getAppElements(document);
  const calls = [];
  const record = name => (...args) => calls.push([name, ...args.filter(arg => typeof arg !== 'object')]);
  UISidebar.mount(elements, {
    onSwitchSession: record('switch'),
    onRenameSession: record('rename'),
    onDeleteSession: record('delete'),
    onExportSession: record('export'),
    onNewSession: record('new'),
    onSearchInput: record('search'),
    onDeleteAllSessions: record('deleteAll'),
    onOpenSettingsMode: record('openSettings'),
    onBackToChats: record('backToChats'),
    onSelectSettingsSection: record('section')
  });
  t.after(() => dom.restore());
  return { elements, calls };
}

const titles = elements => [...elements.sidebarChatsList.querySelectorAll('.sidebar-chat-title')].map(title => title.textContent);
const headers = elements => [...elements.sidebarChatsList.querySelectorAll('.sidebar-group-header')].map(header => header.textContent);

test('UISidebar - agrupa por fecha, marca la activa y filtra por título sin agrupar', t => {
  const { elements } = setup(t);
  const now = Date.now();
  const sessions = [
    { id: 'a', title: 'Hoy <b>', updatedAt: now },
    { id: 'b', title: 'Ayer', updatedAt: now - DAY_MS - 1000 },
    { id: 'c', title: 'Semana', updatedAt: now - 3 * DAY_MS },
    { id: 'd', title: 'Mes', updatedAt: now - 20 * DAY_MS },
    { id: 'e', title: 'Antiguo', updatedAt: now - 90 * DAY_MS }
  ];
  UISidebar.renderSidebarChats(elements, sessions, 'b');
  assert.deepEqual(headers(elements), ['sidebar_group_today', 'sidebar_group_yesterday', 'sidebar_group_last7days', 'sidebar_group_last30days', 'sidebar_group_older'].map(key => I18n.t(key)));
  assert.deepEqual(titles(elements), ['Hoy <b>', 'Ayer', 'Semana', 'Mes', 'Antiguo'], 'Los títulos se muestran como texto');
  assert.equal(elements.sidebarChatsList.querySelector('.sidebar-chat-item.active').dataset.sessionId, 'b');

  elements.sidebarSearchInput.value = 'AYE';
  UISidebar.renderSidebarChats(elements, sessions, 'b');
  assert.deepEqual(titles(elements), ['Ayer']);
  assert.deepEqual(headers(elements), []);

  elements.sidebarSearchInput.value = 'nada';
  UISidebar.renderSidebarChats(elements, sessions, 'b');
  assert.equal(elements.sidebarChatsList.querySelector('.sidebar-no-chats').textContent, I18n.t('sidebar_no_chats'));
});

test('UISidebar - el menú de una conversación ejecuta su acción sin cambiar a ella', t => {
  const { elements, calls } = setup(t);
  UISidebar.renderSidebarChats(elements, [{ id: 's1', title: 'Uno', updatedAt: Date.now() }, { id: 's2', title: 'Dos', updatedAt: Date.now() }], 's1');
  const item = elements.sidebarChatsList.querySelector('[data-session-id="s2"]');
  const menuButton = item.querySelector('.btn-chat-menu');

  menuButton.click();
  assert.equal(menuButton.getAttribute('aria-expanded'), 'true');
  assert.equal(item.querySelector('.sidebar-chat-actions').hidden, false);
  for (const [className, name] of [['.btn-export', 'export'], ['.btn-rename', 'rename'], ['.btn-delete', 'delete']]) {
    menuButton.click();
    item.querySelector(className).click();
    assert.deepEqual(calls.at(-1), [name, 's2']);
    assert.equal(item.querySelector('.sidebar-chat-actions').hidden, true, 'La acción cierra el menú');
  }
  assert.equal(calls.some(([name]) => name === 'switch'), false);

  item.querySelector('.sidebar-chat-title').click();
  assert.deepEqual(calls.at(-1), ['switch', 's2']);

  menuButton.click();
  item.querySelector('.btn-rename').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(item.querySelector('.sidebar-chat-actions').hidden, true, 'Escape cierra el menú');
});

test('UISidebar - abrir y cerrar la barra en móvil deja el chat inerte detrás del fondo', t => {
  const { elements } = setup(t, { width: 390 });
  // En móvil la aplicación arranca con la barra cerrada.
  UISidebar.closeSidebar(elements);
  elements.btnToggleSidebar.click();
  assert.ok(elements.chatSidebar.classList.contains('sidebar-visible'));
  assert.ok(elements.chatContainer.hasAttribute('inert'));
  assert.ok(elements.sidebarBackdrop.classList.contains('visible'));
  assert.equal(elements.btnToggleSidebar.style.display, 'none');

  elements.sidebarBackdrop.click();
  assert.ok(elements.chatSidebar.classList.contains('sidebar-hidden'));
  assert.equal(elements.chatContainer.hasAttribute('inert'), false);
  assert.equal(elements.sidebarBackdrop.classList.contains('visible'), false);
});

test('UISidebar - navega entre las conversaciones y las secciones de ajustes', t => {
  const { elements, calls } = setup(t);
  elements.btnOpenSettings.click();
  assert.equal(elements.sidebarViewSettings.hidden, false);
  assert.equal(elements.sidebarViewChat.hidden, true);
  assert.ok(elements.chatSidebar.classList.contains('mode-settings'));

  const item = elements.sidebarSettingsItems[0];
  const withoutSection = [...elements.sidebarSettingsItems].find(button => !button.dataset.section);
  withoutSection.click();
  assert.deepEqual(calls.map(([name]) => name), ['openSettings'], 'Un botón sin sección no abre ninguna');
  item.click();
  assert.deepEqual(calls.at(-1), ['section', item.dataset.section]);
  UISidebar.setActiveSettingsSection(elements, item.dataset.section);
  assert.ok(item.classList.contains('active'));

  elements.btnSidebarBackToChats.click();
  assert.equal(elements.sidebarViewChat.hidden, false);
  assert.equal(item.classList.contains('active'), false, 'Volver a las conversaciones quita la sección activa');
  assert.deepEqual(calls.map(([name]) => name), ['openSettings', 'section', 'backToChats']);

  elements.btnSidebarNewChat.click();
  elements.sidebarSearchInput.value = 'abc';
  elements.sidebarSearchInput.dispatchEvent(new Event('input'));
  elements.btnDeleteAllChats.click();
  assert.deepEqual(calls.slice(-3), [['new'], ['search', 'abc'], ['deleteAll']]);
});
