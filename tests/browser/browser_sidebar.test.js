const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTestBrowser, closeGlobalBrowser, seedConnectionProfiles, getBundleUrl, getIndexUrl } = require('../helpers/browser-env.js');

describe('Browser UI - sidebar', { concurrency: 2 }, () => {
  after(async () => {
    await closeGlobalBrowser();
  });

test('Browser UI - Fase 5: Barra Lateral de Conversaciones Moderna, Grupos y Drawer', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const filePath = 'file://' + path.resolve(__dirname, '../../zerochat.html');
    await page.goto(filePath, { waitUntil: 'load' });
    await page.waitForSelector('#welcome-banner');

    // 1. Validar que la barra lateral está abierta por defecto
    const isSidebarVisible = await page.$eval('#chat-sidebar', el => getComputedStyle(el).display === 'flex');
    assert.ok(isSidebarVisible, 'El sidebar debe mostrarse con display flex');

    // 2. Validar botón de nueva conversación como icono en la cabecera
    const newChatBtnInfo = await page.evaluate(() => {
      const btn = document.getElementById('btn-sidebar-new-chat');
      const style = getComputedStyle(btn);
      return {
        exists: !!btn,
        text: btn.textContent.trim(),
        hasSvg: !!btn.querySelector('svg'),
        isInActions: !!btn.closest('.sidebar-header-actions'),
        width: parseFloat(style.width),
        height: parseFloat(style.height)
      };
    });
    assert.ok(newChatBtnInfo.exists, 'El botón #btn-sidebar-new-chat debe existir');
    assert.ok(newChatBtnInfo.hasSvg, 'El botón de nueva conversación debe contener un icono SVG');
    assert.ok(newChatBtnInfo.isInActions, 'El botón de nueva conversación debe estar en las acciones de la cabecera del sidebar');
    assert.ok(newChatBtnInfo.width > 0 && newChatBtnInfo.height > 0, 'El botón de nueva conversación debe tener dimensiones renderizadas');

    // 3. Validar buscador de historial con icono
    const searchInfo = await page.evaluate(() => {
      const input = document.getElementById('sidebar-search-input');
      const icon = document.querySelector('.sidebar-search-icon');
      return {
        hasInput: !!input,
        hasIcon: !!icon,
        placeholder: input.getAttribute('placeholder')
      };
    });
    assert.ok(searchInfo.hasInput, 'El input de búsqueda debe existir');
    assert.ok(searchInfo.hasIcon, 'El icono de búsqueda debe existir');

    // 4. Inyectar sesiones de prueba con diferentes fechas para probar agrupación cronológica
    await page.evaluate(() => {
      const now = Date.now();
      const mockSessions = [
        { id: 'chat-today-1', title: 'Plan de Refactorización UI', updatedAt: now },
        { id: 'chat-yesterday-1', title: 'Consulta de Base de Datos', updatedAt: now - 86400000 },
        { id: 'chat-older-1', title: 'Diseño de Algoritmos Inicial', updatedAt: now - (45 * 86400000) }
      ];
      const elements = {
        sidebarChatsList: document.getElementById('sidebar-chats-list'),
        sidebarSearchInput: document.getElementById('sidebar-search-input')
      };
      window.ChatUISidebar.renderSidebarChats(elements, mockSessions, 'chat-today-1', {}, { groupByDate: true });
    });

    // Validar cabeceras de grupos cronológicos
    const groupHeaders = await page.$$eval('.sidebar-group-header', els => els.map(e => e.textContent.trim()));
    assert.ok(groupHeaders.length >= 2, 'Deben existir cabeceras de agrupación cronológica');
    assert.ok(groupHeaders.includes('Hoy'), 'Debe incluir grupo Hoy');
    assert.ok(groupHeaders.includes('Ayer'), 'Debe incluir grupo Ayer');

    // Validar chat activo
    const activeItem = await page.$eval('.sidebar-chat-item.active', el => el.getAttribute('data-session-id'));
    assert.equal(activeItem, 'chat-today-1', 'El chat actual debe tener la clase .active');

    // 5. Validar filtrado dinámico mediante buscador
    await page.fill('#sidebar-search-input', 'Refactorización');
    await page.evaluate(() => {
      const now = Date.now();
      const mockSessions = [
        { id: 'chat-today-1', title: 'Plan de Refactorización UI', updatedAt: now },
        { id: 'chat-yesterday-1', title: 'Consulta de Base de Datos', updatedAt: now - 86400000 }
      ];
      const elements = {
        sidebarChatsList: document.getElementById('sidebar-chats-list'),
        sidebarSearchInput: document.getElementById('sidebar-search-input')
      };
      window.ChatUISidebar.renderSidebarChats(elements, mockSessions, 'chat-today-1', {}, { groupByDate: true });
    });

    const filteredCount = await page.$$eval('.sidebar-chat-item', els => els.length);
    assert.equal(filteredCount, 1, 'Solo debe coincidir 1 chat con el filtro');

    // 6. Validar comportamiento responsive en móvil (Drawer Mode)
    await page.setViewportSize({ width: 500, height: 800 });
    const mobileSidebarStyle = await page.$eval('#chat-sidebar', el => {
      const s = getComputedStyle(el);
      return {
        position: s.position,
        zIndex: parseInt(s.zIndex, 10)
      };
    });
    assert.equal(mobileSidebarStyle.position, 'fixed', 'En móvil, el sidebar debe posicionarse como fixed drawer');
    assert.ok(mobileSidebarStyle.zIndex >= 100, 'En móvil, el zIndex debe ser elevado para superponerse al chat');
  } finally {
    await browser.close();
  }
});

test('Browser UI - borrar la conversación activa carga la siguiente y limpia su historial visible', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    await page.goto('file://' + path.resolve(__dirname, '../../zerochat.html'), { waitUntil: 'load' });

    const result = await page.evaluate(async () => {
      const suffix = Date.now().toString();
      const activeId = `test_session_active_${suffix}`;
      const nextId = `test_session_next_${suffix}`;
      const activeHistory = [{ id: 'active_message', role: 'user', content: 'Conversación que se elimina' }];
      const nextHistory = [{ id: 'next_message', role: 'user', content: 'Conversación que debe mostrarse' }];
      const sessions = [
        { id: activeId, title: 'Activa', createdAt: Date.now(), updatedAt: Date.now() },
        { id: nextId, title: 'Siguiente', createdAt: Date.now() - 1, updatedAt: Date.now() - 1 }
      ];

      await window.ChatStorage.saveConversation(sessions[0], activeHistory);
      await window.ChatStorage.saveConversation(sessions[1], nextHistory);
      window.ChatState.initializeConversation({ sessionId: nextId, sessions, messages: nextHistory });
      await window.ChatApp.switchToSession(activeId);

      const originalConfirm = window.ChatDialogs.confirm;
      window.ChatDialogs.confirm = async () => true;
      try {
        await window.ChatApp.deleteSession(activeId);
      } finally {
        window.ChatDialogs.confirm = originalConfirm;
      }

      return {
        activeId: window.ChatState.get('sessions').activeId,
        listedIds: window.ChatState.get('sessions').list.map(session => session.id),
        messageIds: window.ChatState.get('messages').map(message => message.id),
        deletedConversation: await window.ChatStorage.getConversation(activeId),
        visibleText: document.getElementById('messages-list').textContent
      };
    });

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

test('Browser UI - ChatState como fuente única de verdad en ciclo de vida y sesiones', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        const text = msg.text();
        if (!text.includes('favicon') && !text.includes('ERR_CONNECTION_REFUSED')) {
          consoleErrors.push(text);
        }
      }
    });
    page.on('pageerror', err => consoleErrors.push(err.message));

    const filePath = 'file://' + path.resolve(__dirname, '../../zerochat.html');
    await page.goto(filePath, { waitUntil: 'load' });
    await page.waitForSelector('#welcome-banner');

    // 1. Verificar contrato inicial de ChatState en el navegador
    const stateAudit = await page.evaluate(() => {
      const State = window.ChatState;
      if (!State) return { ok: false, reason: 'no-state' };
      const slices = State.CANONICAL_SLICES || [];
      const state = State.getState();
      const hasAllSlices = slices.every(k => k in state);
      return {
        ok: true,
        hasAllSlices,
        hasToolSecurity: 'toolSecurity' in state,
        hasAttachedFiles: Array.isArray(state.ui?.attachedFiles),
        hasSessions: Array.isArray(state.sessions?.list),
        hasMessages: Array.isArray(state.messages),
        hasMutators: typeof State.replaceConversation === 'function' &&
                     typeof State.appendMessage === 'function' &&
                     typeof State.removeTurn === 'function' &&
                     typeof State.saveSessionMetadata === 'function' &&
                     typeof State.removeSession === 'function' &&
                     typeof State.importConversation === 'function' &&
                     typeof State.setAttachments === 'function' &&
                     typeof State.clearAttachments === 'function'
      };
    });

    assert.equal(stateAudit.ok, true, 'ChatState debe estar disponible en window');
    assert.equal(stateAudit.hasAllSlices, true, 'Todos los slices canónicos deben estar presentes');
    assert.equal(stateAudit.hasToolSecurity, true, 'toolSecurity debe estar declarado en el estado');
    assert.equal(stateAudit.hasAttachedFiles, true, 'ui.attachedFiles debe ser un array');
    assert.equal(stateAudit.hasMutators, true, 'Todos los mutadores de dominio deben estar implementados');

    // 2. Verificar sincronización de adjuntos sin estado local en ChatAttachments
    await page.evaluate(() => {
      window.ChatAttachments.addFile({ name: 'doc_browser.txt', size: 120, type: 'text', content: 'hola' });
    });
    const attachedCount = await page.evaluate(() => window.ChatState.get('ui').attachedFiles.length);
    assert.equal(attachedCount, 1, 'ChatAttachments debe actualizar ChatState.ui.attachedFiles directamente');

    await page.evaluate(() => {
      window.ChatAttachments.clearFiles();
    });
    const attachedAfterClear = await page.evaluate(() => window.ChatState.get('ui').attachedFiles.length);
    assert.equal(attachedAfterClear, 0, 'clearFiles debe vaciar ChatState.ui.attachedFiles');

    // 3. Probar mutación de turnos a través de ChatState
    const turnTest = await page.evaluate(() => {
      const State = window.ChatState;
      State.appendMessage({ role: 'user', content: 'Pregunta en browser' });
      const count1 = State.get('messages').length;
      State.removeTurn((m) => m.content === 'Pregunta en browser');
      const count2 = State.get('messages').length;
      return { count1, count2 };
    });
    assert.ok(turnTest.count1 > turnTest.count2, 'removeTurn debe reducir la lista de mensajes en ChatState');

    assert.equal(consoleErrors.length, 0, 'No debe haber errores de consola: ' + consoleErrors.join(' | '));
  } finally {
    await browser.close();
  }
});
});
