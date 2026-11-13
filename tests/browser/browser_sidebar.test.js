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
      const elements = { sidebarChatsList: document.getElementById('sidebar-chats-list'), sidebarSearchInput: document.getElementById('sidebar-search-input'), sidebarProjectFilter: document.getElementById('sidebar-project-filter') };
      ChatUISidebar.renderSidebarChats(elements, ChatState.get('sessions').list.filter(session => session.id === 'chat-options'), '');
      return ChatState.get('sessions').activeId;
    });
    const trigger = page.locator('.btn-chat-menu');
    assert.equal(await trigger.isVisible(), true);
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
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
const sidebarHeaders = page => page.$$eval('#sidebar-chats-list .sidebar-group-label', labels => labels.map(label => label.textContent));

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

test('Browser UI - con proyecto la barra muestra sus conversaciones y, con todos, las agrupa por proyecto', async () => {
  await withTestApp(async page => {
    const render = project => page.evaluate(project => {
      const elements = {
        sidebarChatsList: document.getElementById('sidebar-chats-list'),
        sidebarSearchInput: document.getElementById('sidebar-search-input'),
        sidebarProjectFilter: document.getElementById('sidebar-project-filter')
      };
      const now = Date.now();
      const sessions = [
        { id: 'a1', title: 'A reciente', project: '/repo/app', updatedAt: now },
        { id: 'n1', title: 'Sin proyecto', updatedAt: now - 1000 },
        { id: 'b1', title: 'B', project: '/repo/lib/', updatedAt: now - 2000 },
        { id: 'a2', title: 'A antigua', project: '/repo/app', updatedAt: now - 3000 }
      ];
      window.ChatUISidebar.renderSidebarChats(elements, sessions, '', [], project);
    }, project);

    await render('/repo/app');
    assert.equal(await page.isVisible('#sidebar-project-filter'), true);
    assert.equal(await page.$eval('#sidebar-project-filter option[value="current"]', option => option.textContent),
      await page.evaluate(() => window.ChatI18n.t('sidebar_project_current', { name: 'app' })));
    // Las que no tienen proyecto (anteriores a esta función) siguen a la vista, al final
    assert.deepEqual(await sidebarTitles(page), ['A reciente', 'A antigua', 'Sin proyecto']);
    assert.deepEqual(await sidebarHeaders(page), await page.evaluate(() => [window.ChatI18n.t('sidebar_group_today'), window.ChatI18n.t('sidebar_no_project')]));

    await page.selectOption('#sidebar-project-filter', 'all');
    await render('/repo/app');
    assert.deepEqual(await sidebarTitles(page), ['A reciente', 'A antigua', 'B', 'Sin proyecto']);
    assert.deepEqual(await sidebarHeaders(page), ['app', 'lib', await page.evaluate(() => window.ChatI18n.t('sidebar_no_project'))]);

    await page.selectOption('#sidebar-project-filter', 'current');
    await render('/repo/vacio');
    assert.deepEqual(await sidebarTitles(page), ['Sin proyecto']);

    // Sin servidor no hay proyecto: se ven todas y no hay selector
    await render('');
    assert.equal(await page.isVisible('#sidebar-project-filter'), false);
    assert.equal((await sidebarTitles(page)).length, 4);
  });
});

const visibleTitles = page => page.$$eval('#sidebar-chats-list .sidebar-chat-title', titles => titles.filter(title => !title.closest('[hidden]')).map(title => title.textContent));

test('Browser UI - en la vista de todos los proyectos se pliegan salvo el actual y el de la conversación abierta, y la elección se recuerda', async () => {
  await withTestApp(async page => {
    const render = currentSessionId => page.evaluate(currentSessionId => {
      const elements = {
        sidebarChatsList: document.getElementById('sidebar-chats-list'),
        sidebarSearchInput: document.getElementById('sidebar-search-input'),
        sidebarProjectFilter: document.getElementById('sidebar-project-filter')
      };
      elements.sidebarProjectFilter.value = 'all';
      const now = Date.now();
      const sessions = [
        { id: 'a1', title: 'A', project: '/repo/app', updatedAt: now },
        { id: 'b1', title: 'B', project: '/repo/lib', updatedAt: now - 1000 },
        { id: 'c1', title: 'C', project: '/repo/web', updatedAt: now - 2000 },
        { id: 'n1', title: 'N', updatedAt: now - 3000 }
      ];
      window.ChatUISidebar.renderSidebarChats(elements, sessions, currentSessionId, [], '/repo/app');
    }, currentSessionId);
    const expandedHeaders = () => page.$$eval('.sidebar-group-toggle', toggles => toggles.map(toggle => `${toggle.textContent}:${toggle.getAttribute('aria-expanded')}`));

    await render('c1');
    assert.deepEqual(await visibleTitles(page), ['A', 'C']);
    assert.deepEqual(await expandedHeaders(), ['app1:true', 'lib1:false', 'web1:true', `${await page.evaluate(() => window.ChatI18n.t('sidebar_no_project'))}1:false`]);

    await page.click('.sidebar-group-toggle[data-group-key="/repo/lib"]');
    await page.click('.sidebar-group-toggle[data-group-key="/repo/app"]');
    assert.deepEqual(await visibleTitles(page), ['B', 'C']);
    assert.deepEqual(JSON.parse(await page.evaluate(() => window.ChatStorage.getStorageItem('sidebar_project_groups'))), { '/repo/lib': true, '/repo/app': false });

    // Al volver a pintar (otra conversación abierta) se respeta lo elegido.
    await render('a1');
    assert.deepEqual(await visibleTitles(page), ['B']);
    await page.focus('.sidebar-group-toggle[data-group-key=""]');
    await page.keyboard.press('Enter');
    assert.deepEqual(await visibleTitles(page), ['B', 'N']);
  });
});

test('Browser UI - abrir una conversación de otro proyecto lleva el servidor a su carpeta y, si no existe, avisa', async () => {
  await withTestApp(async page => {
    await page.evaluate(async () => {
      for (const [id, project] of [['p_ok', '/repo/b'], ['p_gone', '/repo/borrado']]) {
        await window.ChatStorage.saveConversation({ id, title: id, project, createdAt: Date.now(), updatedAt: Date.now() }, [{ id: `${id}_m`, role: 'user', content: 'hola' }]);
      }
      window.ChatState.set('sessions', { ...window.ChatState.get('sessions'), list: await window.ChatStorage.getConversationsList() });
      window.ChatState.set('mcp', { ...window.ChatState.get('mcp'), status: 'connected', serverInfo: { name: 'ZeroChat', cwd: '/repo/a' } });
      window.__dirs = [];
      window.ChatMCP.manager.setProjectDirectory = async path => {
        window.__dirs.push(path);
        if (path === '/repo/borrado') throw new Error('Error MCP (-32602): no existe');
        window.ChatState.set('mcp', { ...window.ChatState.get('mcp'), serverInfo: { name: 'ZeroChat', cwd: path } });
        return { cwd: path };
      };
    });
    await page.selectOption('#sidebar-project-filter', 'all');
    // Los proyectos que no son el actual aparecen plegados.
    await page.click('.sidebar-group-toggle[data-group-key="/repo/b"]');
    await page.locator('.sidebar-chat-item[data-session-id="p_ok"]').click();
    await page.waitForFunction(() => window.__dirs.length === 1);
    assert.equal(await page.evaluate(() => window.ChatState.get('mcp').serverInfo.cwd), '/repo/b');

    await page.click('.sidebar-group-toggle[data-group-key="/repo/borrado"]');
    await page.locator('.sidebar-chat-item[data-session-id="p_gone"]').click();
    await page.waitForFunction(() => document.getElementById('notice-dialog').open);
    const notice = await page.textContent('#notice-dialog');
    assert.ok(notice.includes('/repo/borrado') && notice.includes('no existe'), notice);
    assert.equal(await page.evaluate(() => window.ChatState.get('mcp').serverInfo.cwd), '/repo/b', 'No se queda en otra carpeta: sigue la anterior y sin herramientas');
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
        sidebarSearchInput: document.getElementById('sidebar-search-input'),
        sidebarProjectFilter: document.getElementById('sidebar-project-filter')
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
