const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const { withTestApp, closeGlobalBrowser, openSavedSession } = require('../helpers/browser-env.js');

describe('Browser UI - sidebar', { concurrency: 2 }, () => {
  after(async () => {
    await closeGlobalBrowser();
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

test('Browser UI - --app-height sigue la altura visible del viewport', async () => {
  await withTestApp({ viewport: { width: 1280, height: 800 } }, async page => {
    const appHeight = () => page.evaluate(() => document.documentElement.style.getPropertyValue('--app-height'));
    assert.equal(await appHeight(), '800px');
    await page.setViewportSize({ width: 1280, height: 640 });
    await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--app-height') === '640px');
  });
});
/** Abre el menú de la conversación, pulsa Exportar y descarga con el formato pedido. */
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

    // El tope exacto se prueba en tests/unit/test_attachments.js; aquí basta un archivo que lo supera.
    const maxBytes = await page.evaluate(() => window.ChatAttachments.MAX_FILE_SIZE);
    await importFile(page, { name: 'enorme.json', size: maxBytes + 1 });
    assert.match(await noticeText(page), /"enorme\.json" supera el tamaño máximo permitido \(50(?:\.0)? MB\)/);
    assert.equal((await sessionIds()).length, 1, 'Los archivos rechazados no crean conversaciones');
  });
});

test('Browser UI - sincroniza conversaciones locales y remotas al conectar desde el panel de Conexión', async () => {
  await withTestApp(async page => {
    // 1. Fase offline: guardar conversación local en IndexedDB y activarla
    await page.evaluate(async () => {
      const session = { id: 'chat_local_1', title: 'Conversación Local', createdAt: Date.now() - 5000, updatedAt: Date.now() - 5000, messageCount: 1 };
      const messages = [{ id: 'msg_loc_1', role: 'user', content: 'Mensaje creado sin conexión' }];
      await window.ChatStorage.saveConversation(session, messages);
      const list = await window.ChatStorage.getConversationsList();
      window.ChatState.replaceConversation({ sessionId: 'chat_local_1', messages, sessions: list });
      window.ChatUISidebar.renderSidebarChats({
        sidebarChatsList: document.getElementById('sidebar-chats-list'),
        sidebarSearchInput: document.getElementById('sidebar-search-input')
      }, list, 'chat_local_1');
    });

    await page.waitForSelector('.sidebar-chat-item[data-session-id="chat_local_1"].active');
    assert.equal(await page.locator('.sidebar-chat-item[data-session-id="chat_local_1"] .sidebar-chat-title').textContent(), 'Conversación Local');

    // 2. Preparar backend simulado y conectar desde el panel de Conexión (#btn-backend-connect)
    await page.evaluate(() => {
      const backendStore = new Map([
        ['chat_remote_1', {
          id: 'chat_remote_1',
          title: 'Conversación Remota',
          createdAt: Date.now() - 1000,
          updatedAt: Date.now() - 1000,
          messageCount: 1,
          history: [{ id: 'msg_rem_1', role: 'user', content: 'Mensaje traído desde SQLite' }]
        }]
      ]);
      window.__savedToBackend = [];
      let connected = false;

      const mcpManager = window.ChatMCP.manager;
      mcpManager.isProxyConnected = () => connected;
      mcpManager.connectProxy = async () => {
        connected = true;
        window.ChatState.set('mcp', { status: 'connected', endpoint: 'http://127.0.0.1:6388' });
        return { success: true };
      };
      mcpManager.requestExternalControl = async (method, params) => {
        if (method === 'zerochat/conversations/list') {
          return {
            conversations: Array.from(backendStore.values()).map(({ history, ...header }) => header)
          };
        }
        if (method === 'zerochat/conversations/get') {
          return { conversation: backendStore.get(params.id) || null };
        }
        if (method === 'zerochat/conversations/save') {
          window.__savedToBackend.push(params.conversation.id);
          const history = params.messages || [];
          const record = { ...params.conversation, messageCount: history.length, history };
          backendStore.set(record.id, record);
          return { conversation: record };
        }
        return {};
      };
    });

    await page.click('#btn-open-connection');
    await page.click('#btn-backend-connect');

    // En la interfaz deben verse ambas conversaciones en la barra lateral sin perder la activa y sin subir las locales
    await page.waitForSelector('.sidebar-chat-item[data-session-id="chat_remote_1"]');
    await page.waitForSelector('.sidebar-chat-item[data-session-id="chat_local_1"].active');
    assert.deepEqual(await page.evaluate(() => window.__savedToBackend), []);

    // Cerrar el diálogo de Conexión y cambiar entre conversaciones en la barra lateral
    await page.click('#btn-close-settings');
    await page.locator('.sidebar-chat-item[data-session-id="chat_remote_1"]').click();
    await page.waitForSelector('.sidebar-chat-item[data-session-id="chat_remote_1"].active');
    assert.equal(await page.locator('#messages-list').textContent(), 'Mensaje traído desde SQLite');

    await page.locator('.sidebar-chat-item[data-session-id="chat_local_1"]').click();
    await page.waitForSelector('.sidebar-chat-item[data-session-id="chat_local_1"].active');
    assert.equal(await page.locator('#messages-list').textContent(), 'Mensaje creado sin conexión');
  });
});

});
