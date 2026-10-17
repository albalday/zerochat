const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createTestBrowser, withTestApp, closeGlobalBrowser, getIndexUrl, waitForAppReady, openSavedSession } = require('../helpers/browser-env.js');

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
  await withTestApp({ viewport: { width: 390, height: 800 }, isMobile: true }, async page => {
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
  });
});

test('Browser UI - borrar la conversación activa carga la siguiente y limpia su historial visible', async () => {
  await withTestApp(async page => {
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
  });
});
const DAY_MS = 86400000;

/** Guarda conversaciones con su fecha de actualización y abre `activeId`. */
async function seedSessions(page, sessions, activeId) {
  await page.evaluate(async sessions => {
    for (const { id, title, ageMs } of sessions) {
      const updatedAt = Date.now() - ageMs;
      await window.ChatStorage.saveConversation({ id, title, createdAt: updatedAt, updatedAt }, [{ id: `${id}_msg`, role: 'user', content: `Mensaje de ${title}` }]);
    }
  }, sessions);
  await openSavedSession(page, activeId);
}

const sidebarTitles = page => page.$$eval('#sidebar-chats-list .sidebar-chat-title', titles => titles.map(title => title.textContent));
const sidebarHeaders = page => page.$$eval('#sidebar-chats-list .sidebar-group-header', headers => headers.map(header => header.textContent));

test('Browser UI - la barra agrupa las conversaciones por fecha, marca la activa y filtra por título sin agrupar', async () => {
  await withTestApp(async page => {
    await seedSessions(page, [
      { id: 'a', title: 'Hoy <b>', ageMs: 0 },
      { id: 'b', title: 'Ayer', ageMs: DAY_MS + 1000 },
      { id: 'c', title: 'Semana', ageMs: 3 * DAY_MS },
      { id: 'd', title: 'Mes', ageMs: 20 * DAY_MS },
      { id: 'e', title: 'Antiguo', ageMs: 90 * DAY_MS }
    ], 'b');
    const groups = await page.evaluate(() => ['sidebar_group_today', 'sidebar_group_yesterday', 'sidebar_group_last7days', 'sidebar_group_last30days', 'sidebar_group_older'].map(key => window.ChatI18n.t(key)));
    assert.deepEqual(await sidebarHeaders(page), groups);
    assert.deepEqual(await sidebarTitles(page), ['Hoy <b>', 'Ayer', 'Semana', 'Mes', 'Antiguo'], 'Los títulos se muestran como texto');
    assert.equal(await page.$eval('#sidebar-chats-list .sidebar-chat-item.active', item => item.dataset.sessionId), 'b');

    await page.fill('#sidebar-search-input', 'AYE');
    assert.deepEqual(await sidebarTitles(page), ['Ayer']);
    assert.deepEqual(await sidebarHeaders(page), [], 'Al filtrar no se agrupa');

    await page.fill('#sidebar-search-input', 'nada');
    assert.equal(await page.textContent('#sidebar-chats-list .sidebar-no-chats'), await page.evaluate(() => window.ChatI18n.t('sidebar_no_chats')));
  });
});

test('Browser UI - el menú de una conversación exporta, renombra y borra sin cambiar a ella, y Escape lo cierra', async () => {
  await withTestApp(async page => {
    await seedSessions(page, [{ id: 's1', title: 'Uno', ageMs: 0 }, { id: 's2', title: 'Dos', ageMs: 1000 }], 's1');
    const item = page.locator('.sidebar-chat-item[data-session-id="s2"]');
    const menuButton = item.locator('.btn-chat-menu');
    const actions = item.locator('.sidebar-chat-actions');
    const activeId = () => page.evaluate(() => window.ChatState.get('sessions').activeId);

    await menuButton.click();
    assert.equal(await menuButton.getAttribute('aria-expanded'), 'true');
    await item.locator('.btn-export').click();
    await page.waitForFunction(() => document.getElementById('export-modal').open);
    assert.equal(await actions.isHidden(), true, 'La acción cierra el menú');
    await page.click('#btn-close-export');
    await page.waitForFunction(() => !document.getElementById('export-modal').open);

    await menuButton.click();
    await item.locator('.btn-rename').click();
    await page.waitForFunction(() => document.getElementById('notice-dialog').open);
    assert.equal(await page.inputValue('#notice-input'), 'Dos');
    await page.click('#notice-cancel');
    await page.waitForFunction(() => !document.getElementById('notice-dialog').open);

    await menuButton.click();
    await item.locator('.btn-delete').click();
    await page.waitForFunction(() => document.getElementById('notice-dialog').open);
    await page.click('#notice-cancel');
    await page.waitForFunction(() => !document.getElementById('notice-dialog').open);
    assert.deepEqual(await sidebarTitles(page), ['Uno', 'Dos'], 'Cancelar el borrado conserva la conversación');
    assert.equal(await activeId(), 's1', 'Las acciones del menú no cambian de conversación');

    await menuButton.click();
    await item.locator('.btn-rename').focus();
    await page.keyboard.press('Escape');
    assert.equal(await actions.isHidden(), true, 'Escape cierra el menú');
    assert.equal(await menuButton.evaluate(button => button === document.activeElement), true, 'y devuelve el foco a su botón');

    await item.locator('.sidebar-chat-title').click();
    await page.waitForFunction(() => window.ChatState.get('sessions').activeId === 's2');
  });
});

test('Browser UI - en móvil abrir la barra deja el chat inerte detrás del fondo y el fondo la cierra', async () => {
  await withTestApp({ viewport: { width: 390, height: 800 }, isMobile: true }, async page => {
    const state = () => page.evaluate(() => ({
      visible: document.getElementById('chat-sidebar').classList.contains('sidebar-visible'),
      inert: document.getElementById('chat-container').hasAttribute('inert'),
      backdrop: document.getElementById('sidebar-backdrop').classList.contains('visible'),
      toggleHidden: document.getElementById('btn-toggle-sidebar').hidden
    }));
    await page.click('#btn-toggle-sidebar');
    assert.deepEqual(await state(), { visible: true, inert: true, backdrop: true, toggleHidden: true });
    await page.locator('#sidebar-backdrop').click({ position: { x: 380, y: 400 } });
    assert.deepEqual(await state(), { visible: false, inert: false, backdrop: false, toggleHidden: false });
  });
});

test('Browser UI - la barra pasa a los ajustes, marca la sección abierta y vuelve a las conversaciones', async () => {
  await withTestApp({ viewport: { width: 1280, height: 800 } }, async page => {
    await seedSessions(page, [{ id: 'guardada', title: 'Guardada', ageMs: 0 }], 'guardada');
    await page.click('#btn-open-settings');
    assert.deepEqual(await page.evaluate(() => ({
      settings: !document.getElementById('sidebar-view-settings').hidden,
      chats: !document.getElementById('sidebar-view-chat').hidden,
      mode: document.getElementById('chat-sidebar').classList.contains('mode-settings')
    })), { settings: true, chats: false, mode: true });

    const agent = page.locator('#sidebar-settings-nav .sidebar-settings-item[data-section="agent"]');
    await agent.click();
    await page.waitForFunction(() => document.getElementById('settings-dialog').open);
    assert.equal(await agent.evaluate(item => item.classList.contains('active')), true);
    await page.click('#btn-close-settings');
    await page.waitForFunction(() => !document.getElementById('settings-dialog').open);

    await page.click('#btn-sidebar-back-to-chats');
    assert.equal(await page.locator('#sidebar-view-chat').isVisible(), true);
    assert.equal(await agent.evaluate(item => item.classList.contains('active')), false, 'Volver a las conversaciones quita la sección activa');

    const before = await page.evaluate(() => window.ChatState.get('sessions').activeId);
    await page.click('#btn-sidebar-new-chat');
    await page.waitForFunction(id => window.ChatState.get('sessions').activeId !== id, before);
    await page.click('#btn-delete-all-chats');
    await page.waitForFunction(() => document.getElementById('notice-dialog').open);
    await page.click('#notice-cancel');
    await page.waitForFunction(() => !document.getElementById('notice-dialog').open);
    assert.deepEqual(await sidebarTitles(page), ['Guardada'], 'Cancelar no borra las conversaciones');
  });
});

test('Browser UI - --app-height sigue la altura visible del viewport', async () => {
  await withTestApp({ viewport: { width: 1280, height: 800 } }, async page => {
    const appHeight = () => page.evaluate(() => document.documentElement.style.getPropertyValue('--app-height'));
    assert.equal(await appHeight(), '800px');
    await page.setViewportSize({ width: 1280, height: 640 });
    await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--app-height') === '640px');
  });
});
/** Abre el menú de la conversación, pulsa Exportar y descarga con el formato pedido. */
async function exportFromSidebar(page, sessionId, formatButton) {
  const item = page.locator(`.sidebar-chat-item[data-session-id="${sessionId}"]`);
  await item.locator('.btn-chat-menu').click();
  await item.locator('.btn-export').click();
  await page.waitForFunction(() => document.getElementById('export-modal').open);
  const [download] = await Promise.all([page.waitForEvent('download'), page.click(formatButton)]);
  return { filename: download.suggestedFilename(), content: fs.readFileSync(await download.path(), 'utf8') };
}

test('Browser UI - exporta en Markdown la conversación activa y en JSON otra guardada', async () => {
  await withTestApp(async page => {
    await seedSessions(page, [{ id: 's1', title: 'Activa', ageMs: 0 }, { id: 's2', title: 'Guardada', ageMs: 1000 }], 's1');

    const markdown = await exportFromSidebar(page, 's1', '#btn-export-markdown');
    assert.match(markdown.filename, /^Activa_\d{4}-\d{2}-\d{2}\.md$/);
    assert.match(markdown.content, /# Activa[\s\S]*Mensaje de Activa/);
    await page.waitForFunction(() => !document.getElementById('export-modal').open);

    const json = await exportFromSidebar(page, 's2', '#btn-export-json');
    assert.match(json.filename, /\.json$/);
    const exported = JSON.parse(json.content);
    assert.equal(exported.session.title, 'Guardada');
    assert.deepEqual(exported.session.history.map(message => message.content), ['Mensaje de Guardada']);
    await page.waitForFunction(() => !document.getElementById('export-modal').open);
    assert.equal(await page.$eval('#export-modal', dialog => dialog.dataset.sessionId), undefined, 'Cerrar olvida la conversación elegida');
    assert.equal(await page.evaluate(() => window.ChatState.get('sessions').activeId), 's1', 'Exportar no cambia de conversación');
  });
});

/** Entrega un archivo al selector de importación como lo haría el navegador. */
function importFile(page, { name, content = '', size = 0 }) {
  return page.evaluate(({ name, content, size }) => {
    const input = document.getElementById('import-json-input');
    const transfer = new DataTransfer();
    transfer.items.add(new File([size ? new Uint8Array(size) : content], name, { type: 'application/json' }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change'));
  }, { name, content, size });
}

async function noticeText(page) {
  await page.waitForFunction(() => document.getElementById('notice-dialog').open);
  const text = await page.textContent('#notice-message');
  await page.click('#notice-accept');
  await page.waitForFunction(() => !document.getElementById('notice-dialog').open);
  return text;
}

test('Browser UI - importar asigna un id nuevo y rechaza JSON inválidos y archivos por encima del tope', async () => {
  await withTestApp(async page => {
    const sessionIds = () => page.evaluate(() => window.ChatState.get('sessions').list.map(session => session.id));
    const exported = JSON.stringify({ session: { id: 'original', title: 'Copia', history: [{ role: 'user', content: 'Hola' }] } });
    await importFile(page, { name: 'copia.json', content: exported });
    await noticeText(page);
    const ids = await sessionIds();
    assert.equal(ids.length, 1);
    assert.notEqual(ids[0], 'original', 'La conversación importada recibe un id nuevo');
    assert.equal(await page.inputValue('#import-json-input'), '');

    await importFile(page, { name: 'mal.json', content: '{"invalido":true}' });
    assert.match(await noticeText(page), /valid chat history/);

    const maxBytes = await page.evaluate(() => window.ChatAttachments.MAX_FILE_SIZE);
    await importFile(page, { name: 'borde.json', size: maxBytes });
    assert.doesNotMatch(await noticeText(page), /supera el tamaño máximo/, 'En el tope exacto se lee el archivo');
    await importFile(page, { name: 'enorme.json', size: maxBytes + 1 });
    assert.match(await noticeText(page), /"enorme\.json" supera el tamaño máximo permitido \(50(?:\.0)? MB\)/);
    assert.equal((await sessionIds()).length, 1, 'Los archivos rechazados no crean conversaciones');
  });
});

test('Browser UI - no importa mientras hay una generación en curso', async () => {
  await withTestApp(async page => {
    await page.evaluate(() => {
      window.ChatAPI.streamChatCompletion = ({ signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    });
    await page.fill('#user-input', 'Espera');
    await page.click('#btn-send');
    await page.waitForFunction(() => window.ChatState.get('streaming').isGenerating);
    const before = await page.evaluate(() => window.ChatState.get('sessions').list.length);

    await importFile(page, { name: 'chat.json', content: JSON.stringify({ session: { title: 'X', history: [] } }) });
    assert.match(await noticeText(page), /mientras se está generando/);
    assert.equal(await page.evaluate(() => window.ChatState.get('sessions').list.length), before);
    await page.click('#btn-stop-stream');
  });
});
});
