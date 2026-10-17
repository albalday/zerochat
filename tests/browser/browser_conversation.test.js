const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestBrowser, closeGlobalBrowser, seedConnectionProfiles, getIndexUrl, waitForAppReady, openSavedSession } = require('../helpers/browser-env.js');

describe('Browser UI - conversation', { concurrency: 2 }, () => {
  after(async () => {
    await closeGlobalBrowser();
  });

test('Browser UI - mensajes nuevos e históricos comparten copia y bloques seguros', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);
    const result = await page.evaluate(async () => {
      const ui = window.ChatUIConversation;
      const copied = [];
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => copied.push(text) } });
      const container = document.createElement('div');
      const welcomeBanner = document.createElement('div');
      document.body.appendChild(container);
      const callbacks = { onReuse() {}, onDelete() {}, onBranch() {}, resetTelemetry() {}, updateTelemetry() {} };
      ui.appendUserMessage(container, welcomeBanner, { text: 'Visible text', originalPrompt: 'Original prompt' }, callbacks);
      await container.querySelector('.btn-copy-user').onclick();
      ui.renderSessionMessages({ messagesList: container, welcomeBanner }, [
        { id: 'user-1', role: 'user', content: 'Question' },
        { id: 'reply_turn_0_assistant', role: 'assistant', content: '**First**' },
        { id: 'reply_final', role: 'assistant', content: 'Final' }
      ], callbacks);
      await container.querySelector('.btn-copy-full').onclick();
      const historicalBlocks = [...container.querySelectorAll('.agentic-turn-block')].map(el => el.innerHTML);
      const live = ui.createAssistantBlock(container);
      ui.renderAssistantBlock(live, '**First**', { streaming: true });
      const cursorDuringStream = !!live.querySelector('.streaming-cursor');
      ui.renderAssistantBlock(live, '**First**');
      const sameMarkup = historicalBlocks[0] === live.innerHTML;
      const cursorAfterStream = !!live.querySelector('.streaming-cursor');
      ui.renderAssistantBlock(live, '### Header\n![Logo](data:image/svg+xml,%3Csvg%20xmlns="http://www.w3.org/2000/svg"%3E%3C/svg%3E)', { streaming: true });
      const imgRef = live.querySelector('img.chat-embedded-image');
      ui.renderAssistantBlock(live, '### Header\n![Logo](data:image/svg+xml,%3Csvg%20xmlns="http://www.w3.org/2000/svg"%3E%3C/svg%3E)\n\nMore text...', { streaming: true });
      const sameImgNode = imgRef === live.querySelector('img.chat-embedded-image');
      const hostile = '<img src=x onerror="window.__dupliXss=true">';
      const parts = ui.createAssistantMessagePlaceholder(container, 'msg_error', callbacks);
      ui.renderConnectionError(parts, hostile, hostile);
      const safeError = !parts.content.querySelector('img') && parts.content.textContent.includes(hostile);
      container.remove();
      return { copied, historicalCount: historicalBlocks.length, cursorDuringStream, cursorAfterStream, sameMarkup, sameImgNode, safeError, xss: !!window.__dupliXss };
    });
    assert.deepEqual(result.copied, ['Original prompt', '**First**\n\nFinal']);
    assert.equal(result.historicalCount, 2);
    assert.equal(result.cursorDuringStream, true);
    assert.equal(result.cursorAfterStream, false);
    assert.equal(result.sameMarkup, true);
    assert.equal(result.sameImgNode, true);
    assert.equal(result.safeError, true);
    assert.equal(result.xss, false);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('Browser UI - pintado de mensajes: bloques independientes, acciones, error escapado, imágenes saneadas y resumen plegado', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);
    const result = await page.evaluate(() => {
      const ui = window.ChatUIConversation;
      const out = {};
      const messagesList = document.createElement('div');
      const welcomeBanner = document.createElement('div');
      document.body.append(messagesList);
      const calls = { reused: null, deleted: null, branched: null, telemetry: [] };
      const callbacks = {
        onReuse: text => { calls.reused = text; },
        onDelete: wrapper => { calls.deleted = wrapper; },
        onBranch: wrapper => { calls.branched = wrapper; },
        resetTelemetry: () => calls.telemetry.push('reset'),
        updateTelemetry: () => calls.telemetry.push('update')
      };

      // Cada bloque se pinta sin tocar los demás.
      const blocks = document.createElement('div');
      const first = ui.createAssistantBlock(blocks);
      const second = ui.createAssistantBlock(blocks);
      ui.renderAssistantBlock(first, '**First**', { streaming: true });
      ui.renderAssistantBlock(second, 'Other response');
      const untouched = second.innerHTML;
      ui.renderAssistantBlock(first, '**Finished**');
      out.blocks = { count: blocks.children.length, untouched: second.innerHTML === untouched, finished: first.querySelector('strong')?.textContent };

      // Indicador de escritura único.
      ui.showTypingIndicator(messagesList);
      ui.showTypingIndicator(messagesList);
      out.typing = [messagesList.querySelectorAll('#typing-indicator-wrapper').length];
      ui.removeTypingIndicator();
      out.typing.push(messagesList.querySelectorAll('#typing-indicator-wrapper').length);

      // Mensaje del usuario con sus acciones e imágenes adjuntas saneadas.
      const msgId = ui.appendUserMessage(messagesList, welcomeBanner, {
        text: 'Hola mundo',
        originalPrompt: 'Hola mundo prompt',
        attachedImages: [
          { name: 'segura.png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' },
          { name: 'peligrosa.png', dataUrl: 'javascript:alert(1)' },
          { name: 'xss.png', dataUrl: 'data:text/html,<script>alert(1)</script>' }
        ]
      }, callbacks);
      const user = messagesList.querySelector(`[data-msg-id="${msgId}"]`);
      const [reuse, copy, remove] = user.querySelectorAll('.message-actions button');
      reuse.click();
      remove.click();
      out.user = {
        idPrefix: msgId.startsWith('msg_usr_'),
        welcomeHidden: welcomeBanner.hidden,
        text: user.querySelector('.message-content').textContent.trim().startsWith('Hola mundo'),
        copyButton: copy.classList.contains('btn-copy-user'),
        reused: calls.reused,
        deleted: calls.deleted === user,
        imageItems: user.querySelectorAll('.message-images-grid .message-image-item').length,
        images: [...user.querySelectorAll('.message-images-grid img')].map(img => [img.getAttribute('src'), img.getAttribute('alt')]),
        scripts: user.querySelectorAll('script').length
      };

      // Marcador del asistente y su tarjeta de error.
      const parts = ui.createAssistantMessagePlaceholder(messagesList, 'test_ast_1', callbacks);
      parts.wrapper.querySelector('.btn-branch-conversation').click();
      out.placeholder = {
        msgId: parts.wrapper.getAttribute('data-msg-id'),
        baseId: parts.wrapper.getAttribute('data-base-id'),
        cursor: Boolean(parts.content.querySelector('.initial-cursor')),
        actionsHidden: parts.actions.hidden,
        statsInFooter: parts.statsContainer.parentNode === parts.footerRow,
        branched: calls.branched === parts.wrapper
      };
      const payload = '<img src=x onerror="window.__probe=true">';
      ui.renderConnectionError(parts, payload, payload);
      out.error = {
        img: Boolean(parts.content.querySelector('img')),
        escaped: (parts.content.innerHTML.match(/&lt;img/g) || []).length,
        title: Boolean(parts.content.querySelector('.message-error-card strong')),
        rowError: parts.row.classList.contains('message-error'),
        actionsHidden: parts.actions.hidden
      };

      // Sesión con resumen plegado y turnos.
      const elements = { messagesList, welcomeBanner };
      ui.renderSessionMessages(elements, [
        { id: 's1', role: 'system', content: 'Prompt base' },
        { id: 's2', role: 'system', content: 'Resumen **previo** <img src=x onerror="window.__probe=true">', _isSummaryBlock: true },
        { id: 'u1', role: 'user', content: 'Pregunta' },
        { id: 'a1_turn_0_assistant', role: 'assistant', content: 'Última respuesta del asistente' }
      ], callbacks);
      const banner = messagesList.querySelector('details.branch-summary-banner');
      const assistant = messagesList.querySelector('.message-wrapper.assistant');
      out.session = {
        bannerOpen: banner.open,
        header: Boolean(banner.querySelector('summary.branch-summary-header')),
        markdown: banner.querySelector('strong')?.textContent,
        img: Boolean(banner.querySelector('img')),
        welcomeHidden: welcomeBanner.hidden,
        baseId: assistant.getAttribute('data-base-id'),
        msgIds: assistant.getAttribute('data-msg-ids'),
        telemetry: [...calls.telemetry]
      };

      // Sin turnos vuelve la bienvenida y se reinicia la telemetría.
      calls.telemetry.length = 0;
      ui.renderSessionMessages(elements, [{ id: 's1', role: 'system', content: 'Prompt base' }], callbacks);
      out.empty = { welcome: welcomeBanner.parentNode === messagesList, telemetry: [...calls.telemetry] };

      messagesList.remove();
      out.probe = Boolean(window.__probe);
      return out;
    });
    assert.deepEqual(result.blocks, { count: 2, untouched: true, finished: 'Finished' });
    assert.deepEqual(result.typing, [1, 0]);
    assert.deepEqual(result.user, {
      idPrefix: true, welcomeHidden: true, text: true, copyButton: true, reused: 'Hola mundo prompt', deleted: true,
      imageItems: 3, images: [['data:image/png;base64,iVBORw0KGgo=', 'segura.png']], scripts: 0
    });
    assert.deepEqual(result.placeholder, { msgId: 'test_ast_1', baseId: 'test_ast_1', cursor: true, actionsHidden: true, statsInFooter: true, branched: true });
    assert.deepEqual(result.error, { img: false, escaped: 2, title: true, rowError: true, actionsHidden: false });
    assert.deepEqual(result.session, {
      bannerOpen: false, header: true, markdown: 'previo', img: false, welcomeHidden: true,
      baseId: 'a1', msgIds: 'a1_turn_0_assistant', telemetry: ['update']
    });
    assert.deepEqual(result.empty, { welcome: true, telemetry: ['reset'] });
    assert.equal(result.probe, false);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('Browser UI - el streaming actualiza el texto junto a imágenes en listas y párrafos sin recrearlas', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);
    await page.route(/^https:\/\/x\.org\//, route => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg"/>' }));
    const result = await page.evaluate(() => {
      const ui = window.ChatUIConversation;
      const container = document.createElement('div');
      document.body.append(container);
      const list = ui.createAssistantBlock(container);
      ui.renderAssistantBlock(list, '- foo ![a](https://x.org/a.png) bar', { streaming: true });
      const listImg = list.querySelector('img.chat-embedded-image');
      const initial = list.textContent.includes('foo') && list.textContent.includes('bar');
      ui.renderAssistantBlock(list, '- foo ![a](https://x.org/a.png) bar BAZ\n\nfin', { streaming: true });
      const streamed = { sameImg: listImg === list.querySelector('img.chat-embedded-image'), baz: list.textContent.includes('BAZ'), fin: list.textContent.includes('fin') };
      ui.renderAssistantBlock(list, '- foo ![a](https://x.org/a.png) bar BAZ COMPLETO\n\nfin');
      const final = { sameImg: listImg === list.querySelector('img.chat-embedded-image'), text: list.textContent.includes('BAZ COMPLETO') };

      const paragraph = ui.createAssistantBlock(container);
      ui.renderAssistantBlock(paragraph, 'Inicio ![b](https://x.org/b.png) medio', { streaming: true });
      const paragraphImg = paragraph.querySelector('img.chat-embedded-image');
      ui.renderAssistantBlock(paragraph, 'Inicio ![b](https://x.org/b.png) medio EXPANDIDO');
      const inline = { sameImg: paragraphImg === paragraph.querySelector('img.chat-embedded-image'), text: paragraph.textContent.includes('EXPANDIDO') };
      container.remove();
      return { hasImg: Boolean(listImg), initial, streamed, final, inline };
    });
    assert.deepEqual(result, {
      hasImg: true,
      initial: true,
      streamed: { sameImg: true, baz: true, fin: true },
      final: { sameImg: true, text: true },
      inline: { sameImg: true, text: true }
    });
  } finally { await browser.close(); }
});

test('Browser UI - agrupa llamadas consecutivas de herramientas y conserva su detalle desplegable', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);
    const result = await page.evaluate(() => {
      const ToolCards = window.ChatToolCards;
      const container = document.createElement('div');
      document.body.appendChild(container);
      const first = ToolCards.createLiveToolCard('generic_one', { value: 1 });
      const second = ToolCards.createLiveToolCard('generic_two', { value: 2 });
      ToolCards.appendToolCard(container, first);
      // El runtime crea este bloque vacío entre pasos; no debe partir el grupo.
      const emptyTurn = document.createElement('div');
      emptyTurn.className = 'agentic-turn-block';
      container.appendChild(emptyTurn);
      ToolCards.appendToolCard(container, second);
      const group = container.querySelector('.tool-call-group');
      const history = group.querySelector('.tool-call-group-history');
      const running = {
        groups: container.querySelectorAll('.tool-call-group').length,
        isOpen: history.open,
        hasEmptySeparator: !!container.querySelector('.agentic-turn-block'),
        activeCards: group.querySelectorAll('.tool-call-group-active-cards .tool-card-wrapper').length,
        visibleActiveCards: [...group.querySelectorAll('.tool-call-group-active-cards .tool-card-wrapper')].filter(el => el.getClientRects().length > 0).length
      };
      history.open = true;
      ToolCards.completeToolCard(first, { success: true });
      ToolCards.completeToolCard(second, { success: false });
      const completed = {
        isOpen: history.open,
        status: group.querySelector('.tool-call-group-status').textContent,
        cards: group.querySelectorAll('.tool-card-wrapper').length,
        hasError: group.classList.contains('has-error')
      };
      const expandedCards = group.querySelectorAll('.tool-call-group-cards .tool-card-wrapper').length;
      container.remove();
      return { running, completed, expandedCards };
    });
    assert.deepEqual(result.running, { groups: 1, isOpen: false, hasEmptySeparator: false, activeCards: 2, visibleActiveCards: 2 });
    assert.equal(result.completed.isOpen, true);
    assert.match(result.completed.status, /2/);
    assert.equal(result.completed.cards, 2);
    assert.equal(result.completed.hasError, true);
    assert.equal(result.expandedCards, 2);
  } finally { await browser.close(); }
});

test('Browser UI - completing one tool preserves user-opened groups and previous executions', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const result = await page.evaluate(() => {
      const cards = ChatToolCards;
      const container = document.createElement('div');
      document.body.appendChild(container);
      const isCollapsed = card => card.querySelector('.tool-execution-card').classList.contains('collapsed');
      const create = name => {
        const card = cards.createLiveToolCard(name, { value: 1 });
        cards.appendToolCard(container, card);
        ChatMarkdown.attachContentListeners(card);
        return card;
      };
      const finish = (card, name, success = true) => {
        const output = { success };
        cards.updateLiveToolCard(card, name, {}, output, 1);
        cards.completeToolCard(card, output);
        ChatMarkdown.attachContentListeners(card);
      };
      const first = create('first_execution');
      const second = create('second_execution');
      finish(first, 'first_execution');
      finish(second, 'second_execution');
      const group = first.closest('.tool-call-group');
      const history = group.querySelector('details');
      const untouched = !history.open && isCollapsed(first) && isCollapsed(second);
      history.querySelector('summary').click();
      first.querySelector('.tool-card-header').click();
      second.querySelector('.btn-tool-collapse').click();
      const userOpened = history.open && !isCollapsed(first) && !isCollapsed(second);
      const third = create('third_execution');
      const fourth = create('fourth_execution');
      const activeUnaffected = !isCollapsed(fourth);
      finish(third, 'third_execution');
      const afterThird = history.open && !isCollapsed(first) && !isCollapsed(second)
        && isCollapsed(third) && !isCollapsed(fourth);
      third.querySelector('.btn-tool-collapse').click();
      finish(fourth, 'fourth_execution', false);
      const afterFourth = history.open && !isCollapsed(first) && !isCollapsed(second)
        && !isCollapsed(third) && isCollapsed(fourth);
      // A separate group also retains its automatic closed state.
      const separator = document.createElement('p');
      separator.textContent = 'Assistant response';
      container.appendChild(separator);
      const fifth = create('fifth_execution');
      finish(fifth, 'fifth_execution');
      const otherHistory = fifth.closest('.tool-call-group').querySelector('details');
      const independentGroups = !otherHistory.open && isCollapsed(fifth) && history.open
        && !isCollapsed(first) && !isCollapsed(second) && !isCollapsed(third);
      history.querySelector('summary').click();
      const sixth = create('sixth_execution');
      finish(sixth, 'sixth_execution');
      const userClosed = !history.open && !isCollapsed(first) && !isCollapsed(second)
        && !isCollapsed(third) && !otherHistory.open;
      container.remove();
      return { untouched, userOpened, activeUnaffected, afterThird, afterFourth, independentGroups, userClosed };
    });
    for (const [name, value] of Object.entries(result)) assert.equal(value, true, name);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('Browser UI - el botón para volver al final aparece solo fuera del final y lleva a él', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await seedConnectionProfiles(page);
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);
    const button = page.locator('#btn-scroll-bottom');
    assert.equal(await button.isHidden(), true, 'Sin conversación no hay nada debajo');
    await page.evaluate(() => {
      const list = document.getElementById('messages-list');
      const ui = window.ChatUIConversation;
      const { content } = ui.createAssistantMessagePlaceholder(list, 'scroll_msg', { onReuse() {}, onDelete() {}, onBranch() {} });
      ui.renderAssistantBlock(ui.createAssistantBlock(content), 'Línea.\n\n'.repeat(80));
      list.scrollTo({ top: list.scrollHeight, behavior: 'instant' });
    });
    await page.waitForTimeout(100);
    assert.equal(await button.isHidden(), true, 'Al final no se muestra');
    await page.evaluate(() => document.getElementById('messages-list').scrollTo({ top: 0, behavior: 'instant' }));
    await button.waitFor({ state: 'visible', timeout: 3000 });
    await button.click();
    await button.waitFor({ state: 'hidden', timeout: 3000 });
    const atBottom = await page.evaluate(() => {
      const list = document.getElementById('messages-list');
      return list.scrollHeight - list.scrollTop - list.clientHeight <= 1;
    });
    assert.equal(atBottom, true);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('Browser UI - desplegar una herramienta la deja visible cada vez, no solo la primera', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await seedConnectionProfiles(page);
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);
    await page.evaluate(() => {
      const list = document.getElementById('messages-list');
      const ui = window.ChatUIConversation;
      const callbacks = { onReuse() {}, onDelete() {}, onBranch() {} };
      const { content } = ui.createAssistantMessagePlaceholder(list, 'reveal_msg', callbacks);
      ui.renderAssistantBlock(ui.createAssistantBlock(content), 'Texto previo.\n\n'.repeat(60));
      const cards = window.ChatToolCards;
      const card = cards.createLiveToolCard('reveal_check', { value: 1 });
      card.id = 'reveal-card';
      cards.appendToolCard(content, card);
      const output = { success: true, result: 'line\n'.repeat(40) };
      cards.updateLiveToolCard(card, 'reveal_check', {}, output, 1);
      cards.completeToolCard(card, output);
      window.ChatMarkdown.attachContentListeners(card);
      card.closest('.tool-call-group').querySelector('details').open = true;
      list.scrollTo({ top: list.scrollHeight, behavior: 'instant' });
    });
    const header = '#reveal-card .tool-card-header';
    const cardVisible = () => page.waitForFunction(() => {
      const list = document.getElementById('messages-list');
      const card = document.querySelector('#reveal-card .tool-execution-card');
      return !card.classList.contains('collapsed')
        && card.getBoundingClientRect().bottom <= list.getBoundingClientRect().bottom;
    }, null, { timeout: 3000 });
    await page.click(header);
    await cardVisible();
    await page.click(header);
    await page.click(header);
    await cardVisible();
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});


test('Browser UI - Borrado de respuesta de asistente con tools elimina completamente las respuestas de tools y sanea chatHistory', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);

    const sessionId = 'test_session_delete_tools';
    const baseId = 'msg_ast_interactive_test';
    const history = [
      { id: 'usr_msg_1', role: 'user', content: '¿Qué hora es?' },
      {
        id: `${baseId}_turn_0_assistant`,
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_time_ui', type: 'function', function: { name: 'execute_javascript', arguments: '{"code":"2+2"}' } }]
      },
      { id: `${baseId}_turn_0_tool_call_time_ui`, role: 'tool', tool_call_id: 'call_time_ui', name: 'execute_javascript', content: '4' },
      { id: `${baseId}_final`, role: 'assistant', content: 'Son exactamente las 12:00 UTC.' }
    ];
    await page.evaluate(({ sessionId, history }) => window.ChatStorage.saveConversation({ id: sessionId, title: 'Test Delete Tools' }, history), { sessionId, history });
    await page.reload({ waitUntil: 'load' });
    await waitForAppReady(page);
    // Estado transitorio de la conversación anterior que no debe pasar a la restaurada.
    await page.evaluate(() => {
      window.ChatState.set('telemetry', { stats: { tokens: 99 } });
      window.ChatAttachments.addFile({ name: 'stale.txt', type: 'text', size: 1, content: 'x' });
    });
    await page.locator(`.sidebar-chat-item[data-session-id="${sessionId}"]`).evaluate(item => item.click());
    await page.waitForSelector('.message-wrapper.assistant .btn-delete');

    const restored = await page.evaluate(() => ({
      messages: window.ChatState.get('messages'),
      telemetry: window.ChatState.get('telemetry'),
      attachedFilesCount: window.ChatAttachments.getFiles().length
    }));
    assert.equal(restored.messages.length, 4, 'Debe restaurar todos los mensajes del turno guardado');
    assert.deepEqual(restored.messages[1].tool_calls, history[1].tool_calls);
    assert.deepEqual(restored.telemetry, { stats: null });
    assert.equal(restored.attachedFilesCount, 0, 'Los adjuntos transitorios no deben filtrarse al chat restaurado');

    await page.locator('.message-wrapper.assistant .btn-delete').click();
    await page.waitForFunction(async id => (await window.ChatStorage.getConversation(id)).history.length === 1, sessionId);
    const after = await page.evaluate(async id => ({
      hasAssistantWrapper: !!document.querySelector('.message-wrapper.assistant'),
      roles: (await window.ChatStorage.getConversation(id)).history.map(message => message.role)
    }), sessionId);
    assert.equal(after.hasAssistantWrapper, false, 'El wrapper del asistente debe haber desaparecido del DOM');
    assert.deepEqual(after.roles, ['user'], 'Solo debe quedar el mensaje del usuario');
  } finally {
    await browser.close();
  }
});

test('Browser UI - Borrado de mensaje durante streaming no modifica DOM ni estado', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    const filePath = getIndexUrl();
    await page.goto(filePath, { waitUntil: 'load' });
    await waitForAppReady(page);

    const sessionId = 'test_session_delete_streaming';
    await page.evaluate(id => window.ChatStorage.saveConversation({ id, title: 'Test Delete Streaming' }, [
      { id: 'usr_streaming_1', role: 'user', content: 'Mensaje que no debe borrarse' },
      { id: 'ast_streaming_1', role: 'assistant', content: 'Respuesta previa' }
    ]), sessionId);
    await openSavedSession(page, sessionId);
    await page.waitForSelector('.message-wrapper.user .btn-delete');

    const result = await page.evaluate(async id => {
      window.ChatState.set('streaming', { isGenerating: true });
      document.querySelector('.message-wrapper.user .btn-delete').click();
      await new Promise(resolve => setTimeout(resolve, 100));
      const persisted = await window.ChatStorage.getConversation(id);
      const stateMessages = window.ChatState.get('messages');
      window.ChatState.set('streaming', { isGenerating: false });
      return {
        userWrapperPresent: !!document.querySelector('.message-wrapper.user'),
        stateIds: stateMessages.map(message => message.id),
        persistedIds: persisted.history.map(message => message.id)
      };
    }, sessionId);

    assert.equal(result.userWrapperPresent, true, 'El mensaje debe permanecer visible durante streaming');
    assert.deepEqual(result.stateIds, ['usr_streaming_1', 'ast_streaming_1'], 'El estado no debe modificarse durante streaming');
    assert.deepEqual(result.persistedIds, ['usr_streaming_1', 'ast_streaming_1'], 'La conversación persistida no debe modificarse durante streaming');
  } finally {
    await browser.close();
  }
});

test('Browser UI - el autoscroll sigue el final salvo que el usuario suba por rueda, arrastre, teclas o toque, y lo retoma al volver o con force', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage({ hasTouch: true });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);
    const result = await page.evaluate(async () => {
      const ui = window.ChatUIConversation;
      const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      // Contenedor con layout real: 200 px visibles y líneas de 40 px.
      const createContainer = async (lines = 20) => {
        const container = document.createElement('div');
        container.tabIndex = 0;
        container.style.cssText = 'position:fixed;top:0;left:0;width:300px;height:200px;overflow-y:auto;scroll-behavior:smooth';
        document.body.appendChild(container);
        container.addLines = n => {
          for (let i = 0; i < n; i++) {
            const line = document.createElement('p');
            line.style.cssText = 'height:40px;margin:0';
            container.appendChild(line);
          }
        };
        container.addLines(lines);
        ui.scrollToBottom(container);
        await frame();
        return container;
      };
      const atBottom = container => container.scrollHeight - container.scrollTop - container.clientHeight <= 1;
      /** El usuario se desplaza a `top` (rueda, barra o dedo): el navegador emite scroll. */
      const userScrollTo = async (container, top) => {
        container.scrollTo({ top, behavior: 'instant' });
        await frame();
      };
      /** Llega un chunk nuevo y la aplicación pide seguir el final. */
      const stream = container => {
        container.addLines(10);
        ui.scrollToBottom(container);
        return container.scrollTop;
      };
      const out = {};

      const follow = await createContainer();
      out.followed = atBottom(follow);
      stream(follow);
      out.followedNewContent = atBottom(follow);

      const wheel = await createContainer();
      wheel.dispatchEvent(new WheelEvent('wheel', { deltaY: -120 }));
      await userScrollTo(wheel, 100);
      out.wheelKept = stream(wheel);

      const dragged = await createContainer();
      await userScrollTo(dragged, 300);
      out.dragKept = stream(dragged);

      const keyed = await createContainer();
      keyed.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }));
      await userScrollTo(keyed, 120);
      out.keyKept = stream(keyed);

      const touched = await createContainer();
      const touch = clientY => [new Touch({ identifier: 1, target: touched, clientY })];
      touched.dispatchEvent(new TouchEvent('touchstart', { touches: touch(100) }));
      touched.dispatchEvent(new TouchEvent('touchmove', { touches: touch(180) }));
      await userScrollTo(touched, 80);
      out.touchKept = stream(touched);

      const back = await createContainer();
      back.dispatchEvent(new WheelEvent('wheel', { deltaY: -120 }));
      await userScrollTo(back, 100);
      await userScrollTo(back, back.scrollHeight);
      stream(back);
      out.resumedAtBottom = atBottom(back);

      back.dispatchEvent(new WheelEvent('wheel', { deltaY: -120 }));
      await userScrollTo(back, 40);
      ui.scrollToBottom(back, { force: true });
      out.forced = atBottom(back);

      document.querySelectorAll('body > div[tabindex="0"]').forEach(container => container.remove());
      return out;
    });
    assert.deepEqual(result, {
      followed: true,
      followedNewContent: true,
      wheelKept: 100,
      dragKept: 300,
      keyKept: 120,
      touchKept: 80,
      resumedAtBottom: true,
      forced: true
    });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('Browser UI - ask_user habilita solo la pregunta pendiente y envía la opción elegida', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);
    await page.evaluate(() => {
      const ask = (id, question, options) => [
        { id: `${id}_turn_0_assistant`, role: 'assistant', content: null, tool_calls: [{ id: `call_${id}`, type: 'function', function: { name: 'ask_user', arguments: JSON.stringify({ question, options }) } }] },
        { id: `${id}_tool`, role: 'tool', tool_call_id: `call_${id}`, name: 'ask_user', content: '{"status":"shown_to_user"}' }
      ];
      const history = [
        { id: 'u1', role: 'user', content: 'Revisa' },
        ...ask('a1', '¿Primera?', ['Uno', 'Dos']),
        { id: 'u2', role: 'user', content: 'Uno' },
        ...ask('a2', '¿Aplico <b>el</b> cambio?', [{ label: 'Aplicar', description: 'Escribe AGENTS.md' }, { label: 'Cancelar' }])
      ];
      window.ChatState.replaceMessages(history);
      window.ChatUIConversation.renderSessionMessages({
        messagesList: document.getElementById('messages-list'),
        welcomeBanner: document.getElementById('welcome-banner')
      }, history, { onReuse() {}, onDelete() {}, onBranch() {}, resetTelemetry() {}, updateTelemetry() {} });
    });
    await page.waitForFunction(() => document.querySelectorAll('.ask-user-card [data-ask-option]:not(:disabled)').length === 2);
    const cards = await page.evaluate(() => [...document.querySelectorAll('.ask-user-card')].map(card => ({
      answered: card.classList.contains('ask-user-answered'),
      enabled: [...card.querySelectorAll('[data-ask-option]')].filter(button => !button.disabled).map(button => button.dataset.askOption),
      grouped: !!card.closest('.tool-call-group'),
      question: card.querySelector('.ask-user-question').textContent.trim()
    })));
    assert.deepEqual(cards.map(card => card.answered), [true, false]);
    assert.deepEqual(cards[1].enabled, ['Aplicar', 'Cancelar']);
    assert.equal(cards[1].question, '¿Aplico <b>el</b> cambio?', 'La pregunta se muestra como texto');
    assert.equal(cards.some(card => card.grouped), false, 'La pregunta queda fuera de los grupos de herramientas');

    await page.fill('#user-input', 'con una nota');
    await page.click('.ask-user-card:last-of-type [data-ask-option="Aplicar"]');
    await page.waitForFunction(() => window.ChatState.get('messages').some(message => message.role === 'user' && message.content.startsWith('Aplicar')));
    const sent = await page.evaluate(() => ({
      content: window.ChatState.get('messages').filter(message => message.role === 'user').pop().content,
      enabled: document.querySelectorAll('.ask-user-card [data-ask-option]:not(:disabled)').length
    }));
    assert.equal(sent.content, 'Aplicar\n\ncon una nota');
    assert.equal(sent.enabled, 0, 'Tras responder no queda ninguna opción activa');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

/** Utilidades de las pruebas del subagente: distinguen sus peticiones y simulan la respuesta del proveedor. */
async function installSubagentTestHelpers(page) {
  await page.evaluate(() => {
    window.__subagentTest = {
      isSubagent: params => params.messages.some(message => typeof message.content === 'string' && message.content.startsWith('[Subagent task]')),
      reply: (params, text, toolCalls = []) => {
        return { accumulatedText: text, toolCalls, stats: null };
      }
    };
  });
}

test('Browser UI - el subagente de delegate_task muestra sus herramientas en su tarjeta y devuelve solo el informe', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await page.setViewportSize({ width: 400, height: 800 });
    await waitForAppReady(page);
    await installSubagentTestHelpers(page);
    const result = await page.evaluate(async () => {
      const { isSubagent, reply } = window.__subagentTest;
      const API = window.ChatAPI;
      const original = API.streamChatCompletion;
      const subagentRequests = [];
      let parentRequests = 0;
      API.streamChatCompletion = async params => {
        if (isSubagent(params)) {
          subagentRequests.push({ messages: params.messages.map(message => ({ role: message.role, content: message.content })), tools: params.tools.map(tool => tool.function.name) });
          return subagentRequests.length === 1
            ? reply(params, 'Calculo el valor.', [{ id: 'sub_1', type: 'function', function: { name: 'execute_javascript', arguments: JSON.stringify({ code: 'return 6 * 7;' }) } }])
            : reply(params, 'El valor es **42**.');
        }
        parentRequests++;
        return parentRequests === 1
          ? reply(params, '', [
            { id: 'parent_1', type: 'function', function: { name: 'delegate_task', arguments: JSON.stringify({ task: 'Compute 6 * 7 <b>now</b>.' }) } },
            { id: 'parent_2', type: 'function', function: { name: 'execute_javascript', arguments: JSON.stringify({ code: 'return 1;' }) } }
          ])
          : reply(params, 'Listo.');
      };
      const container = document.createElement('div');
      document.getElementById('messages-list').appendChild(container);
      try {
        const loop = await window.ChatEngine.executeAgentTurnLoop({
          chatHistory: [{ role: 'user', content: 'Mensaje privado del agente principal' }],
          appConfig: window.ChatConfig.normalize({ apiUrl: 'http://127.0.0.1:9/v1', apiType: 'openai', model: 'test-model', systemPrompt: 'Main system prompt', enabledTools: { execute_javascript: true, search_web: false, fetch_web_page: false, download_doc: false, download_image: false, render_chart: true, delegate_task: true } }),
          assistantMsgId: 'asst_subagent',
          view: window.ChatUIConversation.createTurnView(container, { scrollToBottom() {} }),
          onReasoningChunk() {},
          onLog() {},
          onStats() {},
          onGenerationStatus() {}
        });
        const card = [...container.querySelectorAll('.subagent-card')];
        const outer = card[0]?.closest('.tool-card-wrapper');
        const steps = card[0]?.querySelector('.subagent-steps');
        const topGroup = container.querySelector(':scope > .tool-call-group');
        return {
          topGroupStatus: topGroup?.querySelector('.tool-call-group-status')?.textContent,
          parentCardsInTopGroup: topGroup?.querySelectorAll(':scope > .tool-call-group-history > .tool-call-group-cards > .tool-card-wrapper').length,
          finalText: loop.finalAssistantText,
          delegated: loop.chatHistory.find(message => message.role === 'tool' && message.name === 'delegate_task')?.content,
          parentSawSubagentTool: loop.chatHistory.some(message => message.tool_call_id === 'sub_1'),
          cards: card.length,
          outerStandalone: outer?.parentElement === container && !outer.closest('.tool-call-group'),
          stepTextBeforeTools: steps?.firstElementChild?.classList.contains('subagent-step-text') && steps.firstElementChild.nextElementSibling?.classList.contains('tool-call-group'),
          emptyStepBlocks: [...(steps?.querySelectorAll('.subagent-step-text') || [])].filter(block => !block.textContent.trim()).length,
          nestedCards: steps?.querySelectorAll('.tool-call-group .tool-card-wrapper').length,
          stepText: steps?.querySelector('.subagent-step-text')?.textContent.trim(),
          task: card[0]?.querySelector('.subagent-task')?.innerHTML,
          report: card[0]?.querySelector('.subagent-report strong')?.textContent,
          badge: card[0]?.querySelector('.tool-card-badge')?.className,
          collapsed: card[0]?.classList.contains('collapsed'),
          modelTagDisplay: getComputedStyle(card[0].querySelector('.subagent-model')).display,
          subagentRequests
        };
      } finally {
        API.streamChatCompletion = original;
        container.remove();
      }
    });
    assert.equal(result.finalText, 'Listo.');
    assert.equal(result.delegated, 'El valor es **42**.');
    assert.equal(result.parentSawSubagentTool, false, 'Los pasos del subagente no entran en el historial principal');
    assert.equal(result.cards, 1);
    assert.equal(result.outerStandalone, true, 'El subagente no se mete en el grupo de llamadas: ya agrupa las suyas');
    assert.match(result.topGroupStatus, /^1\b/, 'El grupo principal no cuenta las herramientas del subagente');
    assert.equal(result.parentCardsInTopGroup, 1, 'La llamada siguiente del agente principal no cae dentro de la tarjeta del subagente');
    assert.equal(result.stepTextBeforeTools, true, 'El texto de cada paso precede a sus herramientas');
    assert.equal(result.emptyStepBlocks, 0);
    assert.equal(result.nestedCards, 1, 'La herramienta del subagente se pinta dentro de su tarjeta');
    assert.equal(result.stepText, 'Calculo el valor.');
    assert.equal(result.task, 'Compute 6 * 7 &lt;b&gt;now&lt;/b&gt;.');
    assert.equal(result.report, '42');
    assert.match(result.badge, /status-success/);
    assert.equal(result.collapsed, true);
    assert.equal(result.modelTagDisplay, 'none', 'Sin perfil «Subagente» no hay etiqueta de modelo, tampoco en móvil');
    const [first] = result.subagentRequests;
    assert.deepEqual(first.tools, ['execute_javascript']);
    assert.equal(first.messages[0].role, 'system');
    assert.match(first.messages[0].content, /Main system prompt/, 'Comparte el prompt de sistema del agente principal');
    assert.equal(first.messages.some(message => String(message.content).includes('Mensaje privado')), false);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

});
