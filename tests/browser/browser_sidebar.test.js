const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestBrowser, closeGlobalBrowser, getIndexUrl, waitForAppReady, openSavedSession } = require('../helpers/browser-env.js');

describe('Browser UI - sidebar', { concurrency: 2 }, () => {
  after(async () => {
    await closeGlobalBrowser();
  });

test('Browser UI - el sidebar es panel en escritorio y drawer cerrado en móvil', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);
    const display = () => page.$eval('#chat-sidebar', el => getComputedStyle(el).display);

    assert.equal(await display(), 'flex', 'El sidebar debe estar abierto por defecto en escritorio');
    await page.click('#btn-close-sidebar');
    assert.equal(await display(), 'none', 'El sidebar debe cerrarse');
    await page.click('#btn-toggle-sidebar');
    assert.equal(await display(), 'flex', 'El botón de la cabecera debe reabrir el sidebar');

    await page.setViewportSize({ width: 500, height: 800 });
    const drawer = await page.$eval('#chat-sidebar', el => ({ position: getComputedStyle(el).position, zIndex: parseInt(getComputedStyle(el).zIndex, 10) }));
    assert.equal(drawer.position, 'fixed', 'En móvil, el sidebar debe posicionarse como fixed drawer');
    assert.ok(drawer.zIndex >= 100, 'En móvil, el drawer debe superponerse al chat');

    const mobile = await browser.newPage({ viewport: { width: 500, height: 800 }, isMobile: true });
    await mobile.goto(getIndexUrl(), { waitUntil: 'load' });
    await mobile.waitForSelector('#welcome-banner');
    assert.equal(await mobile.locator('#chat-sidebar').evaluate(el => el.classList.contains('sidebar-hidden')), true, 'En móvil el drawer debe comenzar cerrado');
    await mobile.click('#btn-toggle-sidebar');
    await mobile.waitForFunction(() => document.getElementById('chat-sidebar').classList.contains('sidebar-visible'));
  } finally {
    await browser.close();
  }
});

test('Browser UI - el menú contextual de un chat es táctil y no activa la conversación', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 800 }, isMobile: true });
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);
    await page.click('#btn-toggle-sidebar');
    await page.waitForFunction(() => !document.getElementById('chat-sidebar').classList.contains('sidebar-hidden'));
    const activeSessionId = await page.evaluate(() => {
      ChatState.saveSessionMetadata({ id: 'chat-options', title: 'Opciones táctiles', updatedAt: Date.now() });
      const elements = { sidebarChatsList: document.getElementById('sidebar-chats-list'), sidebarSearchInput: document.getElementById('sidebar-search-input') };
      ChatUISidebar.renderSidebarChats(elements, ChatState.get('sessions').list.filter(session => session.id === 'chat-options'), '');
      return ChatState.get('sessions').activeId;
    });
    const trigger = page.locator('.btn-chat-menu');
    assert.equal(await trigger.isVisible(), true);
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(await trigger.evaluate(button => button.getBoundingClientRect().width), 44);
    await trigger.click();
    assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('.sidebar-chat-actions').isVisible(), true);
    await page.locator('.btn-rename').click();
    // Renombrar pide el título nuevo sin cambiar de conversación.
    await page.waitForFunction(() => document.getElementById('notice-dialog').open);
    const actionResult = await page.evaluate(() => ({
      prompt: document.getElementById('notice-input').value,
      currentId: ChatState.get('sessions').activeId,
      menuOpen: document.querySelector('.sidebar-chat-actions')?.hidden === false
    }));
    assert.equal(actionResult.prompt, 'Opciones táctiles');
    assert.equal(actionResult.currentId, activeSessionId);
    assert.equal(actionResult.menuOpen, false);
    await page.click('#notice-cancel');
  } finally {
    await browser.close();
  }
});

test('Browser UI - borrar la conversación activa carga la siguiente y limpia su historial visible', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);

    const activeId = 'test_session_active';
    const nextId = 'test_session_next';
    await page.evaluate(async ({ activeId, nextId }) => {
      await window.ChatStorage.saveConversation({ id: activeId, title: 'Activa', createdAt: Date.now(), updatedAt: Date.now() },
        [{ id: 'active_message', role: 'user', content: 'Conversación que se elimina' }]);
      await window.ChatStorage.saveConversation({ id: nextId, title: 'Siguiente', createdAt: Date.now() - 1, updatedAt: Date.now() - 1 },
        [{ id: 'next_message', role: 'user', content: 'Conversación que debe mostrarse' }]);
    }, { activeId, nextId });
    await openSavedSession(page, activeId);

    // Borrar desde el menú de la entrada activa y confirmar en el diálogo.
    await page.locator(`.sidebar-chat-item[data-session-id="${activeId}"] .btn-delete`).evaluate(button => button.click());
    await page.locator('#notice-accept').click();
    await page.waitForFunction(id => window.ChatState.get('sessions').activeId === id && document.getElementById('messages-list').textContent.includes('debe mostrarse'), nextId);

    const result = await page.evaluate(async activeId => ({
      activeId: window.ChatState.get('sessions').activeId,
      listedIds: window.ChatState.get('sessions').list.map(session => session.id),
      messageIds: window.ChatState.get('messages').map(message => message.id),
      deletedConversation: await window.ChatStorage.getConversation(activeId),
      visibleText: document.getElementById('messages-list').textContent
    }), activeId);

    assert.equal(result.activeId, result.listedIds[0], 'La siguiente sesión debe quedar activa');
    assert.equal(result.listedIds.length, 1, 'La conversación eliminada debe desaparecer de la lista');
    assert.deepEqual(result.messageIds, ['next_message'], 'Debe cargarse el historial de la siguiente conversación');
    assert.equal(result.deletedConversation, null, 'La conversación eliminada no debe permanecer en IndexedDB');
    assert.match(result.visibleText, /Conversación que debe mostrarse/, 'La vista debe reemplazar el chat eliminado');
    assert.doesNotMatch(result.visibleText, /Conversación que se elimina/, 'La vista no debe conservar el chat eliminado');
  } finally {
    await browser.close();
  }
});
});
