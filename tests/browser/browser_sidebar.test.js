const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const { withTestApp, createTestBrowser, closeGlobalBrowser, openSavedSession, startStaticServer, stopStaticServer, waitForAppReady } = require('../helpers/browser-env.js');

describe('Browser UI - sidebar', { concurrency: 2 }, () => {
  after(async () => {
    await closeGlobalBrowser();
  });

test('Browser UI - en móvil la barra ocupa toda la pantalla, deja el chat inerte y el menú contextual es táctil', async () => {
  await withTestApp({ viewport: { width: 390, height: 800 }, isMobile: true }, async page => {
    const state = () => page.evaluate(() => ({
      visible: document.getElementById('chat-sidebar').classList.contains('sidebar-visible'),
      inert: document.getElementById('chat-container').hasAttribute('inert'),
      toggleHidden: document.getElementById('btn-toggle-sidebar').hidden
    }));
    await page.click('#btn-toggle-sidebar');
    assert.deepEqual(await state(), { visible: true, inert: true, toggleHidden: true });
    await page.waitForFunction(() => document.getElementById('chat-sidebar').getBoundingClientRect().left === 0);
    assert.equal(await page.evaluate(() => document.getElementById('chat-sidebar').getBoundingClientRect().width), 390);

    const activeSessionId = await page.evaluate(() => {
      ChatState.saveSessionMetadata({ id: 'chat-options', title: 'Opciones táctiles', updatedAt: Date.now() });
      return ChatState.get('sessions').activeId;
    });
    await renderSidebar(page, [{ id: 'chat-options', title: 'Opciones táctiles', updatedAt: Date.now() }]);
    const trigger = page.locator('.btn-chat-menu');
    assert.equal(await trigger.isVisible(), true);
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
    await trigger.click();
    assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('.sidebar-chat-actions').isVisible(), true);
    await page.locator('.btn-rename').click();
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

    await page.click('#btn-close-sidebar');
    assert.deepEqual(await state(), { visible: false, inert: false, toggleHidden: false });
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

/** Pinta la barra directamente con `sessions`, sin el estado de la aplicación. */
function renderSidebar(page, sessions, { currentSessionId = '', runs = [], project = '' } = {}) {
  return page.evaluate(({ sessions, currentSessionId, runs, project }) => {
    const byId = id => document.getElementById(id);
    window.ChatUISidebar.renderSidebarChats({
      sidebarChatsList: byId('sidebar-chats-list'),
      sidebarSearchInput: byId('sidebar-search-input'),
      sidebarProjectFilter: byId('sidebar-project-filter'),
      sidebarHistorySwitch: byId('sidebar-history-switch'),
      btnDeleteAllChats: byId('btn-delete-all-chats')
    }, sessions, currentSessionId, runs, project);
  }, { sessions, currentSessionId, runs, project });
}

/** Repinta la barra desde el estado de la aplicación, como hace ella al escribir en el buscador. */
const repaintSidebar = page => page.evaluate(() => document.getElementById('sidebar-search-input').dispatchEvent(new Event('input')));

const sidebarTitles = page => page.$$eval('#sidebar-chats-list .sidebar-chat-title', titles => titles.map(title => title.textContent));
const sidebarHeaders = page => page.$$eval('#sidebar-chats-list .sidebar-group-label', labels => labels.map(label => label.textContent));

test('Browser UI - la barra agrupa las conversaciones por fecha, marca la activa y filtra por título sin cabeceras de fecha', async () => {
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
    assert.deepEqual(await sidebarHeaders(page), [], 'Al filtrar no quedan cabeceras de fecha');

    // Buscar por contenido de mensajes (sin coincidir en el título) actualiza la lista tras el debounce.
    await page.evaluate(async () => {
      await window.ChatStorage.saveConversation(
        { id: 'c', title: 'Semana', createdAt: Date.now(), updatedAt: Date.now() },
        [{ id: 'm1', role: 'user', content: 'Contiene término oculto en mensaje' }]
      );
    });
    await page.fill('#sidebar-search-input', 'término oculto');
    await page.waitForFunction(() => [...document.querySelectorAll('#sidebar-chats-list .sidebar-chat-title')].some(el => el.textContent === 'Semana'));
    assert.deepEqual(await sidebarTitles(page), ['Semana']);

    await page.fill('#sidebar-search-input', 'nada');
    await page.waitForFunction(() => document.querySelector('#sidebar-chats-list .sidebar-no-chats'));
    assert.equal(await page.textContent('#sidebar-chats-list .sidebar-no-chats'), await page.evaluate(() => window.ChatI18n.t('sidebar_no_chats')));
  });
});

test('Browser UI - el selector muestra el proyecto actual, general, todos agrupados por proyecto o las tareas pendientes', async () => {
  await withTestApp(async page => {
    const now = Date.now();
    const sessions = [
      { id: 'a1', title: 'A reciente', project: '/repo/app', updatedAt: now },
      { id: 'n1', title: 'Sin proyecto', updatedAt: now - 1000 },
      { id: 'b1', title: 'B', project: '/repo/lib/', updatedAt: now - 2000 },
      { id: 'a2', title: 'A antigua', project: '/repo/app', updatedAt: now - 3000 }
    ];
    const render = (project, runs = []) => renderSidebar(page, sessions, { runs, project });
    const currentLabel = () => page.$eval('#sidebar-project-filter option[value="current"]', option => option.textContent);
    // Sin evento change: la aplicación repintaría con su propio estado, sin servidor.
    const choose = value => page.$eval('#sidebar-project-filter', (select, value) => { select.value = value; }, value);
    const noneHidden = () => page.$eval('#sidebar-project-filter option[value="none"]', option => option.hidden);

    await render('/repo/app');
    assert.equal(await currentLabel(), await page.evaluate(() => window.ChatI18n.t('sidebar_project_current', { name: 'app' })));
    assert.deepEqual(await sidebarTitles(page), ['A reciente', 'A antigua']);
    assert.deepEqual(await sidebarHeaders(page), await page.evaluate(() => [window.ChatI18n.t('sidebar_group_today')]));

    await choose('none');
    await render('/repo/app');
    assert.deepEqual(await sidebarTitles(page), ['Sin proyecto']);

    await choose('all');
    await render('/repo/app');
    // Todos empiezan plegados, también el actual, y un grupo plegado no pinta sus conversaciones.
    assert.deepEqual(await sidebarTitles(page), []);
    assert.deepEqual(await sidebarHeaders(page), ['app', 'lib', 'general']);

    // Al buscar, cada resultado sigue bajo su proyecto, aunque esté plegado.
    const search = text => page.$eval('#sidebar-search-input', (input, text) => { input.value = text; }, text);
    await search('n');
    await render('/repo/lib');
    assert.deepEqual(await sidebarTitles(page), ['A reciente', 'A antigua', 'Sin proyecto']);
    assert.deepEqual(await sidebarHeaders(page), ['app', 'general']);
    await search('');

    await choose('current');
    await render('/repo/vacio');
    assert.equal(await page.textContent('#sidebar-chats-list .sidebar-no-chats'), await page.evaluate(() => window.ChatI18n.t('sidebar_no_project_chats')));
    assert.equal(await page.isDisabled('#btn-delete-all-chats'), true, 'Una vista vacía no se borra en bloque');

    // Tareas pendientes: las que esperan respuesta del usuario o fallaron, de todos los proyectos y desplegadas; en
    // marcha o paradas por un límite no lo son. No se borran en bloque y, sin ninguna, la vista vuelve al proyecto actual.
    const runs = [
      { conversationId: 'a2', runId: 'r1', status: 'limit' },
      { conversationId: 'n1', runId: 'r2', status: 'error' },
      { conversationId: 'b1', runId: 'r3', status: 'needs_input' },
      { conversationId: 'otra', runId: 'r4', status: 'running' }
    ];
    const pendingOption = () => page.$eval('#sidebar-project-filter option[value="pending"]', option => ({ hidden: option.hidden, text: option.textContent }));
    await render('/repo/app', runs);
    assert.deepEqual(await pendingOption(), { hidden: false, text: await page.evaluate(() => window.ChatI18n.t('sidebar_project_pending', { count: 2 })) });
    await choose('pending');
    await render('/repo/app', runs);
    const pendingItems = () => page.$$eval('#sidebar-chats-list .sidebar-chat-item', items => items.map(item => [
      item.dataset.sessionId, item.querySelector('.sidebar-chat-status-icon').getAttribute('class').split(' ').at(-1)]));
    assert.deepEqual(await pendingItems(), [['b1', 'needs-input'], ['n1', 'error']]);
    assert.deepEqual(await sidebarHeaders(page), ['lib', 'general']);
    assert.equal(await page.isDisabled('#btn-delete-all-chats'), true);
    await search('nada');
    await render('/repo/app', runs);
    assert.equal(await page.textContent('#sidebar-chats-list .sidebar-no-chats'), await page.evaluate(() => window.ChatI18n.t('sidebar_no_chats')));
    await search('');
    await render('/repo/app');
    assert.equal((await pendingOption()).hidden, true);
    assert.equal(await page.$eval('#sidebar-project-filter', select => select.value), 'current');
    assert.equal(await page.isDisabled('#btn-delete-all-chats'), false);

    // Sin servidor el proyecto actual es general: el selector sigue a la vista, sin repetirlo
    await choose('none');
    await render('');
    assert.equal(await page.isVisible('#sidebar-project-filter'), true);
    assert.equal(await currentLabel(), await page.evaluate(() => window.ChatI18n.t('sidebar_project_current', { name: 'general' })));
    assert.equal(await noneHidden(), true);
    assert.equal(await page.$eval('#sidebar-project-filter', select => select.value), 'current');
    assert.deepEqual(await sidebarTitles(page), ['Sin proyecto']);
  });
});

test('Browser UI - en la vista de todos los proyectos empiezan plegados y vuelven a plegarse al elegirla otra vez', async () => {
  await withTestApp(async page => {
    // Plegar repinta desde el estado de la aplicación: las conversaciones y el proyecto van en él.
    await page.evaluate(() => {
      const now = Date.now();
      const list = [
        { id: 'a1', title: 'A', project: '/repo/app', updatedAt: now },
        { id: 'b1', title: 'B', project: '/repo/lib', updatedAt: now - 1000 },
        { id: 'c1', title: 'C', project: '/repo/web', updatedAt: now - 2000 },
        { id: 'n1', title: 'N', updatedAt: now - 3000 }
      ];
      window.ChatState.set('sessions', { ...window.ChatState.get('sessions'), activeId: 'c1', list });
      window.ChatState.set('mcp', { ...window.ChatState.get('mcp'), status: 'connected', serverInfo: { name: 'ZeroChat', cwd: '/repo/app' } });
    });
    const expandedHeaders = () => page.$$eval('.sidebar-group-toggle', toggles => toggles.map(toggle => `${toggle.textContent}:${toggle.getAttribute('aria-expanded')}`));

    await page.selectOption('#sidebar-project-filter', 'all');
    assert.deepEqual(await sidebarTitles(page), []);
    assert.deepEqual(await expandedHeaders(), ['app1:false', 'lib1:false', 'web1:false', 'general1:false']);

    await page.click('.sidebar-group-toggle[data-group-key="/repo/lib"]');
    await page.click('.sidebar-group-toggle[data-group-key="/repo/web"]');
    await page.click('.sidebar-group-toggle[data-group-key="/repo/web"]');
    assert.deepEqual(await sidebarTitles(page), ['B']);

    // Al volver a pintar (otra conversación abierta) se respeta lo desplegado.
    await page.evaluate(() => window.ChatState.set('sessions', { ...window.ChatState.get('sessions'), activeId: 'a1' }));
    await repaintSidebar(page);
    assert.deepEqual(await sidebarTitles(page), ['B']);
    await page.focus('.sidebar-group-toggle[data-group-key=""]');
    await page.keyboard.press('Enter');
    assert.deepEqual(await sidebarTitles(page), ['B', 'N']);

    // Elegir otra vista y volver a la de todos los pliega todos: sirve de selector de proyecto.
    await page.selectOption('#sidebar-project-filter', 'current');
    await page.selectOption('#sidebar-project-filter', 'all');
    assert.deepEqual(await sidebarTitles(page), []);
  });
});

test('Browser UI - el historial de agentes va aparte de los chats, cada conversación con el nombre de su agente, y sigue a la conversación activa', async () => {
  await withTestApp(async page => {
    await page.evaluate(day => {
      const now = Date.now();
      const list = [
        { id: 'h1', title: 'Humana hoy', project: '/repo/app', updatedAt: now },
        { id: 'ag1', title: 'Informe lunes', project: '/repo/app', agent: 'informes.diario', updatedAt: now - 500 },
        { id: 'ag2', title: 'Informe martes', project: '/repo/app', agent: 'informes.diario', updatedAt: now - 1000 },
        { id: 'ag3', title: 'Resumen', project: '/repo/app', agent: 'informes.semanal', updatedAt: now - 3 * day },
        { id: 'h2', title: 'Humana antigua', project: '/repo/app', updatedAt: now - 3 * day }
      ];
      window.ChatState.set('sessions', { ...window.ChatState.get('sessions'), activeId: 'h1', list });
      window.ChatState.set('mcp', {
        ...window.ChatState.get('mcp'), status: 'connected', serverInfo: { name: 'ZeroChat', cwd: '/repo/app' },
        serverRuns: [{ conversationId: 'ag2', runId: 'r1', status: 'needs_input' }, { conversationId: 'ag1', runId: 'r2', status: 'running' }]
      });
    }, DAY_MS);
    await repaintSidebar(page);
    const shownIds = () => page.$$eval('#sidebar-chats-list .sidebar-chat-item', items => items.map(item => item.dataset.sessionId));
    const t = key => page.evaluate(key => window.ChatI18n.t(key), key);
    const historySwitch = () => page.$eval('#sidebar-history-switch', group => ({
      hidden: group.hidden,
      pressed: group.querySelector('[aria-pressed="true"]').dataset.history,
      waiting: [...group.querySelectorAll('.has-pending')].map(button => button.dataset.history)
    }));
    const setActive = async id => {
      await page.evaluate(id => window.ChatState.set('sessions', { ...window.ChatState.get('sessions'), activeId: id }), id);
      await repaintSidebar(page);
    };
    const dateHeaders = async () => [await t('sidebar_group_today'), await t('sidebar_group_last7days')];

    // Chats: solo las humanas por fecha; el botón de agentes avisa de que uno espera respuesta.
    assert.deepEqual(await historySwitch(), { hidden: false, pressed: 'user', waiting: ['agents'] });
    assert.deepEqual(await sidebarHeaders(page), await dateHeaders());
    assert.deepEqual(await shownIds(), ['h1', 'h2']);

    // Agentes: por fecha como los chats, sin niveles; cada una se llama como su agente, con el título de descripción.
    await page.click('#sidebar-history-switch [data-history="agents"]');
    assert.deepEqual(await historySwitch(), { hidden: false, pressed: 'agents', waiting: [] });
    // Las de agentes no se renombran: se ven con el nombre de su agente.
    assert.equal(await page.$$eval('#sidebar-chats-list .sidebar-chat-item', items => items.filter(item => item.querySelector('.btn-rename')).length), 0);
    assert.deepEqual(await sidebarHeaders(page), await dateHeaders());
    assert.deepEqual(await page.$$eval('#sidebar-chats-list .sidebar-chat-title', titles => titles.map(title => [title.lastChild.textContent, title.title])),
      [['informes.diario', 'Informe lunes'], ['informes.diario', 'Informe martes'], ['informes.semanal', 'Resumen']]);

    // El buscador también encuentra por identificador de agente.
    await page.fill('#sidebar-search-input', 'semanal');
    assert.deepEqual(await shownIds(), ['ag3']);
    await page.fill('#sidebar-search-input', '');

    // Tareas pendientes: solo el agente que espera respuesta, no el que sigue en marcha.
    await page.selectOption('#sidebar-project-filter', 'pending');
    assert.deepEqual(await shownIds(), ['ag2']);

    // En los chats nadie espera respuesta: la vista de pendientes desaparece y vuelve al proyecto actual.
    await page.click('#sidebar-history-switch [data-history="user"]');
    assert.equal(await page.$eval('#sidebar-project-filter', select => select.value), 'current');
    assert.deepEqual(await shownIds(), ['h1', 'h2']);

    // Viendo los agentes, el botón de chats avisa si un chat espera respuesta.
    await page.click('#sidebar-history-switch [data-history="agents"]');
    // Sin quitar las de agentes: una ejecución que desaparece se da por terminada y la app recarga la lista.
    await page.evaluate(() => {
      const mcp = window.ChatState.get('mcp');
      window.ChatState.set('mcp', { ...mcp, serverRuns: [...mcp.serverRuns, { conversationId: 'h2', runId: 'r3', status: 'needs_input' }] });
    });
    await repaintSidebar(page);
    assert.deepEqual((await historySwitch()).waiting, ['user']);

    // Abrir una conversación de agente pasa a su historial. Una nueva aún sin guardar, como la que sustituye a la
    // activa al borrarla, no lo cambia; al guardarse como chat, el historial pasa a los chats.
    await setActive('ag3');
    assert.equal((await historySwitch()).pressed, 'agents');
    await setActive('session_nueva');
    assert.equal((await historySwitch()).pressed, 'agents');
    await page.evaluate(() => {
      const sessions = window.ChatState.get('sessions');
      window.ChatState.set('sessions', { ...sessions, list: [{ id: 'session_nueva', title: 'Nueva', project: '/repo/app', updatedAt: Date.now() }, ...sessions.list] });
    });
    await repaintSidebar(page);
    assert.equal((await historySwitch()).pressed, 'user');

    // Sin conversaciones de agentes no hay conmutador.
    await page.evaluate(() => {
      const sessions = window.ChatState.get('sessions');
      window.ChatState.set('sessions', { ...sessions, list: sessions.list.filter(session => !session.agent) });
    });
    await repaintSidebar(page);
    assert.equal((await historySwitch()).hidden, true);
  });
});

test('Browser UI - cada grupo pinta 50 conversaciones y "Mostrar más" añade el resto', async () => {
  await withTestApp(async page => {
    const render = async count => {
      await page.evaluate(count => {
        const now = Date.now();
        const list = Array.from({ length: count }, (_, index) => ({ id: `s${index}`, title: `Chat ${index}`, updatedAt: now - index * 1000 }));
        window.ChatState.set('sessions', { ...window.ChatState.get('sessions'), activeId: null, list });
      }, count);
      await repaintSidebar(page);
    };
    const showMore = () => page.$$eval('.sidebar-show-more', buttons => buttons.map(button => button.textContent));

    await render(50);
    assert.equal((await sidebarTitles(page)).length, 50);
    assert.deepEqual(await showMore(), []);

    await render(51);
    assert.equal((await sidebarTitles(page)).length, 50);
    assert.deepEqual(await showMore(), [await page.evaluate(() => window.ChatI18n.t('sidebar_show_more', { count: 1 }))]);
    await page.click('.sidebar-show-more');
    assert.equal((await sidebarTitles(page)).at(-1), 'Chat 50');
    assert.deepEqual(await showMore(), []);
  });
});

test('Browser UI - confirmar cambio de proyecto al abrir chat, enlace de ficheros en cabecera y nueva pestaña con proyecto actual', async () => {
  await withTestApp(async page => {
    const noProjectDir = '/home/u/zerochat/general';
    assert.equal(await page.locator('#btn-open-project-files').isHidden(), true, 'El icono de carpeta está oculto sin conexión');

    await page.evaluate(async noProjectDir => {
      for (const [id, project] of [['p_ok', '/repo/b'], ['p_gone', '/repo/borrado']]) {
        await window.ChatStorage.saveConversation({ id, title: id, project, createdAt: Date.now(), updatedAt: Date.now() }, [{ id: `${id}_m`, role: 'user', content: 'hola' }]);
      }
      await window.ChatStorage.saveConversation({ id: 'n_1', title: 'N', createdAt: Date.now(), updatedAt: Date.now() }, [{ id: 'n_1_m', role: 'user', content: 'hola' }]);
      window.ChatState.set('sessions', { ...window.ChatState.get('sessions'), list: await window.ChatStorage.getConversationsList() });
      window.ChatState.set('mcp', { ...window.ChatState.get('mcp'), status: 'connected', serverInfo: { name: 'ZeroChat', cwd: '/repo/a', noProjectDir } });
      window.__dirs = [];
      window.ChatMCP.manager.setProjectDirectory = async path => {
        window.__dirs.push(path);
        if (path === '/repo/borrado') throw new Error('Error MCP (-32602): no existe');
        window.ChatMCP.manager.recordProjectContext(path, { status: 'missing' });
        await window.ChatMCP.manager.applyLiveState({ cwd: path });
        return { cwd: path };
      };
    }, noProjectDir);

    const headerFilesLink = () => page.evaluate(() => {
      const link = document.getElementById('btn-open-project-files');
      return {
        hidden: link.hidden,
        href: link.getAttribute('href'),
        target: link.target,
        rel: link.rel,
        label: link.getAttribute('aria-label'),
        icon: Boolean(link.querySelector('svg'))
      };
    });
    assert.deepEqual(await headerFilesLink(), {
      hidden: false,
      href: 'files.html?project=%2Frepo%2Fa',
      target: '_blank',
      rel: 'noopener',
      label: 'Ficheros de a',
      icon: true
    });

    await page.selectOption('#sidebar-project-filter', 'all');

    // Abrir un chat de otro proyecto pide confirmación; cancelar conserva el proyecto actual.
    const beforeId = await page.evaluate(() => window.ChatState.get('sessions').activeId);
    await page.click('.sidebar-group-toggle[data-group-key="/repo/b"]');
    await page.locator('.sidebar-chat-item[data-session-id="p_ok"]').click();
    await page.waitForFunction(() => document.getElementById('notice-dialog').open);
    assert.match(await page.textContent('#notice-message'), /\bb\b/);
    await page.click('#notice-cancel');
    await page.waitForFunction(() => !document.getElementById('notice-dialog').open);
    assert.equal(await page.evaluate(() => window.ChatState.get('sessions').activeId), beforeId);
    assert.equal(await page.evaluate(() => window.ChatState.get('mcp').serverInfo.cwd), '/repo/a');
    assert.equal(await page.evaluate(() => window.__dirs.length), 0);

    // Aceptar cambia de chat y de proyecto, actualizando el icono de carpeta y el enlace de nueva pestaña.
    await page.locator('.sidebar-chat-item[data-session-id="p_ok"]').click();
    await page.waitForFunction(() => document.getElementById('notice-dialog').open);
    await page.click('#notice-accept');
    await page.waitForFunction(() => window.__dirs.length === 1);
    assert.equal(await page.evaluate(() => window.ChatState.get('mcp').serverInfo.cwd), '/repo/b');
    assert.deepEqual(await headerFilesLink(), {
      hidden: false,
      href: 'files.html?project=%2Frepo%2Fb',
      target: '_blank',
      rel: 'noopener',
      label: 'Ficheros de b',
      icon: true
    });
    assert.match(await page.getAttribute('#btn-sidebar-new-tab', 'href'), /\?project=%2Frepo%2Fb$/);

    // Proyecto borrado: tras confirmar el cambio avisa de que la carpeta no existe.
    await page.click('.sidebar-group-toggle[data-group-key="/repo/borrado"]');
    await page.locator('.sidebar-chat-item[data-session-id="p_gone"]').click();
    await page.waitForFunction(() => document.getElementById('notice-dialog').open);
    await page.click('#notice-accept');
    await page.waitForFunction(() => document.getElementById('notice-dialog').open && /no existe/.test(document.getElementById('notice-dialog').textContent));
    const notice = await page.textContent('#notice-dialog');
    assert.ok(notice.includes('/repo/borrado') && notice.includes('no existe'), notice);
    assert.equal(await page.evaluate(() => window.ChatState.get('mcp').serverInfo.cwd), '/repo/b');
    await page.click('#notice-accept');
    await page.waitForFunction(() => !document.getElementById('notice-dialog').open);

    // Abrir un chat de general: confirma cambio, actualiza el icono de carpeta a noProjectDir y desactiva modo proyecto.
    await page.click('.sidebar-group-toggle[data-group-key=""]');
    await page.locator('.sidebar-chat-item[data-session-id="n_1"]').click();
    await page.waitForFunction(() => document.getElementById('notice-dialog').open);
    assert.match(await page.textContent('#notice-message'), /\bgeneral\b/);
    await page.click('#notice-accept');
    await page.waitForFunction(dir => window.ChatState.get('mcp').serverInfo.cwd === dir, noProjectDir);
    assert.deepEqual(await headerFilesLink(), {
      hidden: false,
      href: `files.html?project=${encodeURIComponent(noProjectDir)}`,
      target: '_blank',
      rel: 'noopener',
      label: 'Ficheros de general',
      icon: true
    });
    assert.equal(await page.$eval('#sidebar-project-filter option[value="none"]', option => option.hidden), true);

    // En general el interruptor del modo proyecto está desactivado y no se puede cambiar.
    await page.click('#btn-reasoning');
    assert.equal(await page.locator('#chk-project-mode').isChecked(), false);
    assert.equal(await page.locator('#chk-project-mode').isDisabled(), true);
    await page.locator('#project-mode-panel .switch').click({ force: true });
    assert.equal(await page.locator('#chk-project-mode').isChecked(), false);
    assert.equal(await page.evaluate(() => window.ChatConfig.getActive().projectMode), true);

    // «Subagentes», apagado por defecto, se enciende y se apaga desde el mismo panel y se refleja en #btn-reasoning.
    assert.equal(await page.locator('#chk-subagents').isChecked(), false);
    assert.equal(await page.locator('#btn-reasoning').getAttribute('data-subagents'), null);
    assert.equal(await page.locator('#reasoning-subagents-badge').isHidden(), true);
    await page.locator('#chk-subagents').evaluate(input => input.click());
    assert.equal(await page.evaluate(() => window.ChatConfig.getActive().subagents), true);
    assert.equal(await page.locator('#btn-reasoning').getAttribute('data-subagents'), '');
    assert.equal(await page.locator('#reasoning-subagents-badge').getAttribute('hidden'), null);
    assert.match(await page.locator('#btn-reasoning').getAttribute('title'), /Subagentes|Subagents/);
    await page.click('#btn-close-reasoning');
    assert.equal(await page.locator('#reasoning-subagents-badge').isVisible(), true);
    await page.click('#btn-reasoning');
    assert.equal(await page.locator('#chk-subagents').isChecked(), true);
    await page.locator('#chk-subagents').evaluate(input => input.click());
    assert.equal(await page.evaluate(() => window.ChatConfig.getActive().subagents), false);
    assert.equal(await page.locator('#btn-reasoning').getAttribute('data-subagents'), null);
    assert.equal(await page.locator('#reasoning-subagents-badge').isHidden(), true);
  });
});

test('Browser UI - abrir nueva pestaña desde el icono usa el proyecto actual', async () => {
  const server = await startStaticServer();
  const browser = await createTestBrowser();
  const context = await browser.newContext();
  try {
    const initHeaders = [];
    await context.route('http://127.0.0.1:6398/**', async route => {
      const request = route.request();
      const body = JSON.parse(request.postData() || '{}');
      const project = decodeURIComponent(request.headers()['x-zerochat-project'] || '/repo/a');
      if (body.method === 'initialize') initHeaders.push(project);
      const result = body.method === 'initialize'
        ? {
          protocolVersion: '2024-11-05',
          serverInfo: { name: 'ZeroChat', cwd: project, noProjectDir: '/home/u/zerochat/general' },
          capabilities: { tools: {} },
          tools: [],
          policies: { allowAll: false, tools: {}, servers: {}, directoryRules: [], commandPatterns: { global: [], project: [], session: [] } },
          liveState: { cwd: project, servers: [], jobs: [], runs: [] }
        }
        : body.method === 'zerochat/project/set_directory'
          ? { cwd: body.params.path }
          : body.method === 'zerochat/conversations/list'
            ? { conversations: [] }
            : {};
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result }) });
    });

    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/zerochat.html#token=tok-tab&host=127.0.0.1&port=6398`, { waitUntil: 'load' });
    await waitForAppReady(page);
    await page.waitForFunction(() => window.ChatState.get('mcp').status === 'connected');
    await page.evaluate(() => window.ChatMCP.manager.setProjectDirectory('/repo/b'));
    await page.waitForFunction(() => window.ChatState.get('mcp').serverInfo?.cwd === '/repo/b');
    assert.match(await page.getAttribute('#btn-sidebar-new-tab', 'href'), /\?project=%2Frepo%2Fb$/);

    const [newPage] = await Promise.all([context.waitForEvent('page'), page.click('#btn-sidebar-new-tab')]);
    await newPage.waitForFunction(() => window.ChatState?.get('mcp')?.status === 'connected');
    assert.deepEqual(initHeaders, ['/repo/a', '/repo/b']);
    assert.equal(await newPage.evaluate(() => window.ChatState.get('mcp').serverInfo.cwd), '/repo/b');
  } finally {
    await context.close();
    await browser.close();
    await stopStaticServer(server);
  }
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
    });
    await repaintSidebar(page);

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

    // En la interfaz deben verse ambas conversaciones en la barra lateral sin perder la activa, y la local se sube
    await page.waitForSelector('.sidebar-chat-item[data-session-id="chat_remote_1"]');
    await page.waitForSelector('.sidebar-chat-item[data-session-id="chat_local_1"].active');
    assert.deepEqual(await page.evaluate(() => window.__savedToBackend), ['chat_local_1']);

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

test('Browser UI - el botón de sincronizar y conversationsRev muestran conversaciones nuevas de --prompt', async () => {
  await withTestApp(async page => {
    assert.equal(await page.locator('#btn-sync-chats').isHidden(), true, 'Oculto sin conexión');

    await page.evaluate(() => {
      window.__backendChats = [];
      const mcp = window.ChatMCP.manager;
      mcp.isProxyConnected = () => true;
      mcp.requestExternalControl = async method => (
        method === 'zerochat/conversations/list' ? { conversations: window.__backendChats } : {}
      );
      window.ChatState.set('mcp', { status: 'connected', endpoint: 'http://127.0.0.1:6388', conversationsRev: '1:100:100' });
    });

    assert.equal(await page.locator('#btn-sync-chats').isVisible(), true, 'Visible al conectar');

    // Simular chat añadido por zerochat --prompt y pulsar el botón de sincronizar
    await page.evaluate(() => {
      window.__backendChats = [{ id: 'chat_prompt_1', title: 'Desde --prompt manual', createdAt: 200, updatedAt: 200, messageCount: 2 }];
    });
    await page.click('#btn-sync-chats');
    await page.waitForSelector('.sidebar-chat-item[data-session-id="chat_prompt_1"]');

    // Simular otro chat añadido por zerochat --prompt detectado en el latido (conversations_rev)
    await page.evaluate(async () => {
      window.__backendChats = [
        { id: 'chat_prompt_2', title: 'Desde --prompt latido', createdAt: 300, updatedAt: 300, messageCount: 2 },
        ...window.__backendChats
      ];
      await window.ChatMCP.manager.applyLiveState({ conversations_rev: '2:300:500' });
    });
    await page.waitForSelector('.sidebar-chat-item[data-session-id="chat_prompt_2"]');
  });
});

});
