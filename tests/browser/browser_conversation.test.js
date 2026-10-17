const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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

test('Browser UI - copiar usa el texto del momento, vuelve al icono original y un fallo del portapapeles no se da por copiado', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);
    await page.clock.install();
    const copied = await page.evaluate(async () => {
      const copied = [];
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { copied.push(text); } } });
      const button = document.createElement('button');
      button.id = 'copy-probe';
      button.innerHTML = '<span>copy</span>';
      document.body.append(button);
      window.__copyText = 'Original';
      window.ChatUIConversation.bindMessageCopy(button, () => window.__copyText);
      const results = [await button.onclick()];
      window.__copyText = 'Updated';
      results.push(await button.onclick());
      return { results, copied, copiedClass: button.classList.contains('copied') };
    });
    assert.deepEqual(copied, { results: [true, true], copied: ['Original', 'Updated'], copiedClass: true });
    await page.clock.runFor(2000);
    assert.deepEqual(await page.$eval('#copy-probe', button => [button.classList.contains('copied'), button.innerHTML]), [false, '<span>copy</span>']);

    const failed = await page.evaluate(async () => {
      const warnings = [];
      const originalWarn = console.warn;
      console.warn = (...args) => warnings.push(args);
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Clipboard denied'); } } });
      const button = document.createElement('button');
      window.ChatUIConversation.bindMessageCopy(button, () => 'Text');
      const result = await button.onclick();
      console.warn = originalWarn;
      return { result, copied: button.classList.contains('copied'), warnings: warnings.length };
    });
    assert.deepEqual(failed, { result: false, copied: false, warnings: 1 });
  } finally { await browser.close(); }
});

test('Browser UI - borrar el último turno lo quita del historial y del chat, guarda y muestra la bienvenida', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);
    const result = await page.evaluate(() => {
      const ui = window.ChatUIConversation;
      const messagesList = document.createElement('div');
      const welcomeBanner = document.createElement('div');
      document.body.append(messagesList);
      window.ChatState.replaceConversation({ sessionId: 'session_remove', messages: [{ id: 'msg_to_delete', role: 'user', content: 'Borrar' }] });
      ui.appendUserMessage(messagesList, welcomeBanner, { text: 'Borrar', existingMsgId: 'msg_to_delete' }, { onReuse() {}, onDelete() {} });
      const wrapper = messagesList.querySelector('[data-msg-id="msg_to_delete"]');
      let saved = false;
      ui.removeMessage(wrapper, { messagesList, welcomeBanner, saveSession: () => { saved = true; } });
      const out = {
        messages: window.ChatState.get('messages').length,
        connected: wrapper.isConnected,
        saved,
        welcomeInList: welcomeBanner.parentNode === messagesList,
        welcomeHidden: welcomeBanner.hidden
      };
      messagesList.remove();
      return out;
    });
    assert.deepEqual(result, { messages: 0, connected: false, saved: true, welcomeInList: true, welcomeHidden: false });
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

test('Browser UI - en móvil el estado de una herramienta larga se muestra bajo su nombre', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);
    const layout = await page.evaluate(() => {
      const card = window.ChatToolCards.createLiveToolCard('composio_COMPOSIO_MULTI_EXECUTE_TOOL', { value: 1 });
      document.body.appendChild(card);
      window.ChatToolCards.updateLiveToolCard(card, 'composio_COMPOSIO_MULTI_EXECUTE_TOOL', { value: 1 }, { success: true }, 12);
      const header = card.querySelector('.tool-card-header');
      const title = card.querySelector('.tool-card-title');
      const badge = card.querySelector('.tool-card-badge');
      const collapse = card.querySelector('.btn-tool-collapse');
      const result = {
        grid: getComputedStyle(header).display,
        badgeBelowTitle: badge.getBoundingClientRect().top >= title.getBoundingClientRect().bottom,
        collapseAtRight: collapse.getBoundingClientRect().left > title.getBoundingClientRect().right,
        titleLines: Math.round(title.querySelector('span:last-child').getBoundingClientRect().height / parseFloat(getComputedStyle(title).lineHeight))
      };
      card.remove();
      return result;
    });
    assert.equal(layout.grid, 'grid');
    assert.equal(layout.badgeBelowTitle, true);
    assert.equal(layout.collapseAtRight, true);
    assert.ok(layout.titleLines <= 2);
  } finally { await browser.close(); }
});

test('Browser UI - native, MCP and historical cards share mobile layout; charts stay outside groups', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    const result = await page.evaluate(async () => {
      const provider = new ChatMCP.McpToolProvider({
        id: 'mobile', name: 'Long server label',
        initialize: async () => ({ success: true }),
        listTools: async () => [{ name: 'LONG_TOOL_NAME_WITH_MANY_CHARACTERS', inputSchema: { type: 'object' } }]
      });
      const tools = await provider.discoverTools();
      const mcp = tools[0];
      ChatAgentCore.registry.registerTool(mcp);
      const container = document.createElement('div');
      container.style.width = '350px';
      document.body.appendChild(container);
      const cases = [
        ['search_web', { query: '<img src=x onerror=alert(1)>' }, { success: true, count: 1, results: [{ title: '<script>bad</script>', url: 'javascript:alert(1)', snippet: '<img src=x>' }] }],
        ['fetch_web_page', { url: 'https://example.com' }, { success: false, error: 'Failed' }],
        ['download_doc', { url: 'https://example.com/a.pdf' }, { success: true, text: 'PDF' }],
        ['execute_javascript', { code: 'return 1' }, { success: true, result: '1' }],
        ['read_knowledge_image', { imageRef: 'rag-image://doc:image' }, { success: true, documentTitle: '<script>bad</script>' }],
        [mcp.name, { input: 'value' }, { success: true, content: '<script>bad</script>' }]
      ];
      const layouts = [];
      for (const [name, args, output] of cases) {
        const card = ChatToolCards.createLiveToolCard(name, args);
        ChatToolCards.appendToolCard(container, card);
        ChatToolCards.updateLiveToolCard(card, name, args, output, 15);
        ChatToolCards.completeToolCard(card, output);
        const group = card.closest('.tool-call-group-history');
        group.open = true;
        const header = card.querySelector('.tool-card-header');
        const title = card.querySelector('.tool-card-title');
        const badge = card.querySelector('.tool-card-badge');
        layouts.push({ name, grid: getComputedStyle(header).display,
          below: badge.getBoundingClientRect().top >= title.getBoundingClientRect().bottom,
          collapsed: card.querySelector('.tool-execution-card').classList.contains('collapsed'),
          unsafe: !!card.querySelector('script, img[onerror], a[href^="javascript:"]') });
        const historical = ChatToolCards.renderHistoricalToolCard({ function: { name, arguments: JSON.stringify(args) } }, { content: JSON.stringify(output) });
        layouts.push({ name: name + ' history', canonical: !!historical.querySelector('.tool-card-header'),
          collapsed: historical.querySelector('.tool-execution-card').classList.contains('collapsed') });
      }
      ChatMarkdown.attachContentListeners(container);
      const first = container.querySelector('.tool-execution-card');
      first.querySelector('.btn-tool-collapse').click();
      const toggles = !first.classList.contains('collapsed');
      const chartArgs = { type: 'bar', title: 'Chart', labels: ['a'], datasets: [{ label: 'Data', data: [1] }] };
      const chart = ChatToolCards.createLiveToolCard('render_chart', chartArgs);
      ChatToolCards.appendToolCard(container, chart);
      ChatToolCards.updateLiveToolCard(chart, 'render_chart', chartArgs, { success: true }, 1);
      const chartOutside = chart.parentNode === container && !chart.querySelector('.collapsed');
      const chartHistory = ChatToolCards.renderHistoricalToolCard({ function: { name: 'render_chart', arguments: JSON.stringify(chartArgs) } }, { content: '{}' });
      ChatToolCards.appendToolCard(container, chartHistory, { completed: true });
      const chartHistoryOutside = chartHistory.parentNode === container && !chartHistory.querySelector('.collapsed');
      // Conversaciones guardadas con herramientas retiradas siguen mostrando una tarjeta genérica.
      for (const [name, args] of [['update_plan', { tasks: [{ title: '<b>x</b>', status: 'pending' }] }], ['finish_task', { summary: 'ok' }]]) {
        const historical = ChatToolCards.renderHistoricalToolCard({ function: { name, arguments: JSON.stringify(args) } }, { content: '{}' });
        layouts.push({ name: name + ' retired history', canonical: !!historical.querySelector('.tool-card-header'),
          collapsed: historical.querySelector('.tool-execution-card').classList.contains('collapsed') });
      }
      container.remove();
      return { layouts, toggles, chartOutside, chartHistoryOutside };
    });
    for (const layout of result.layouts) {
      assert.equal(layout.collapsed, true, layout.name);
      if (layout.canonical !== undefined) assert.equal(layout.canonical, true, layout.name);
      else {
        assert.equal(layout.grid, 'grid', layout.name);
        assert.equal(layout.below, true, layout.name);
        assert.equal(layout.unsafe, false, layout.name);
      }
    }
    assert.equal(result.toggles, true);
    assert.equal(result.chartOutside, true);
    assert.equal(result.chartHistoryOutside, true);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('Browser UI - canvas de mensajes centrado, respuestas sin marco, razonamiento plegable, código y tablas', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const filePath = getIndexUrl();
    await page.goto(filePath, { waitUntil: 'load' });

    await waitForAppReady(page);

    // Simular renderizado de un mensaje de usuario y uno del asistente
    await page.evaluate(() => {
      const messagesList = document.getElementById('messages-list');
      const editSvg = window.ChatIcons?.get('edit', { size: 12 }) || '';
      const brainSvg = window.ChatIcons?.get('brain', { size: 13 }) || '';
      const zapSvg = window.ChatIcons?.get('zap', { size: 11 }) || '';
      const copySvg = window.ChatIcons?.get('copy', { size: 12 }) || '';
      const branchSvg = window.ChatIcons?.get('git-branch', { size: 12 }) || '';
      
      // Mensaje de Usuario
      const userMsg = document.createElement('div');
      userMsg.className = 'message-wrapper user';
      userMsg.innerHTML = `
        <div class="message-row user">
          <div class="message-content-wrapper">
            <div class="message-content">Hola ZeroChat, muéstrame una tabla y código.</div>
            <div class="message-footer-row">
              <div class="message-actions">
                <button class="btn-msg-action" aria-label="Editar" title="Editar">${editSvg}</button>
                <button class="btn-msg-action btn-copy-user" aria-label="Copiar" title="Copiar">${copySvg}</button>
              </div>
            </div>
          </div>
        </div>
      `;
      messagesList.appendChild(userMsg);

      // Mensaje de Asistente con Razonamiento, Tabla y Código
      const astMsg = document.createElement('div');
      astMsg.className = 'message-wrapper assistant';
      astMsg.innerHTML = `
        <div class="message-row assistant">
          <div class="message-content-wrapper">
            <div class="message-content">
              <details class="thought-block" open>
                <summary class="thought-summary">${brainSvg} Proceso de razonamiento</summary>
                <div class="thought-content">Analizando la solicitud para generar la respuesta estructurada...</div>
              </details>
              <p>Aquí tienes los datos solicitados en formato de tabla y código:</p>
              <div class="table-container">
                <table class="markdown-table">
                  <thead><tr><th>Parámetro</th><th>Valor</th><th>Estado</th></tr></thead>
                  <tbody>
                    <tr><td>Modelo</td><td>Gemini 2.5</td><td>Activo</td></tr>
                    <tr><td>Tokens</td><td>1.2k</td><td>OK</td></tr>
                  </tbody>
                </table>
              </div>
              <div class="code-block-container">
                <div class="code-block-header">
                  <span class="code-lang">javascript</span>
                  <div class="code-block-actions">
                    <button class="btn-copy-code">Copiar</button>
                  </div>
                </div>
                <pre><code>console.log("Canvas moderno activo");</code></pre>
              </div>
            </div>
            <div class="message-footer-row">
              <div class="message-stats">
                <span class="stat-item">${zapSvg} <span>45 t/s</span></span>
              </div>
              <div class="message-actions">
                <button class="btn-msg-action btn-branch-conversation" aria-label="Crear rama" title="Crear rama">${branchSvg}</button>
                <button class="btn-msg-action" aria-label="Copiar" title="Copiar">${copySvg}</button>
              </div>
            </div>
          </div>
        </div>
      `;
      messagesList.appendChild(astMsg);
    });

    // 1. Validar centrado y ancho máximo del canvas de mensajes
    const canvasMetrics = await page.evaluate(() => {
      const userWrapper = document.querySelector('.message-wrapper.user');
      const astWrapper = document.querySelector('.message-wrapper.assistant');
      const rectUser = userWrapper.getBoundingClientRect();
      const rectAst = astWrapper.getBoundingClientRect();
      return {
        userWidth: rectUser.width,
        astWidth: rectAst.width
      };
    });

    assert.ok(canvasMetrics.userWidth <= 1120 && canvasMetrics.userWidth > 900, `El ancho de mensaje (${canvasMetrics.userWidth}px) debe respetar el canvas de lectura ampliado max-width: 68rem`);
    assert.ok(canvasMetrics.astWidth <= 1120 && canvasMetrics.astWidth > 900, `El ancho del asistente (${canvasMetrics.astWidth}px) debe respetar el canvas de lectura ampliado max-width: 68rem`);

    // Validar ausencia de enmarcado en respuestas del asistente
    const astFraming = await page.evaluate(() => {
      const astContent = document.querySelector('.message-row.assistant .message-content');
      const style = getComputedStyle(astContent);
      return {
        borderStyle: style.borderStyle,
        borderWidth: style.borderWidth,
        backgroundColor: style.backgroundColor
      };
    });
    assert.ok(astFraming.borderWidth === '0px' || astFraming.borderStyle === 'none', 'La respuesta del asistente no debe tener borde/enmarcado');
    assert.ok(astFraming.backgroundColor === 'rgba(0, 0, 0, 0)' || astFraming.backgroundColor === 'transparent', 'La respuesta del asistente debe tener fondo transparente sin enmarcado');

    // 2. Validar acordeón de razonamiento plegable
    const thoughtInfo = await page.evaluate(() => {
      const block = document.querySelector('.thought-block');
      return {
        isOpen: block.open,
        hasBorderAccent: getComputedStyle(block).borderLeftWidth !== '0px'
      };
    });
    assert.ok(thoughtInfo.isOpen, 'El bloque de razonamiento debe renderizarse inicialmente desplegado');
    assert.ok(thoughtInfo.hasBorderAccent, 'El bloque de razonamiento debe tener borde de acento');

    // Plegar el acordeón haciendo click en el summary
    await page.click('.thought-summary');
    const isNowClosed = await page.$eval('.thought-block', el => !el.open);
    assert.ok(isNowClosed, 'Pulsar en el summary del pensamiento debe plegar el acordeón');

    // 3. Validar bloque de código
    const codeBlockInfo = await page.evaluate(() => {
      const codeBlock = document.querySelector('.code-block-container');
      const copyBtn = document.querySelector('.btn-copy-code');
      const pre = document.querySelector('.code-block-container pre');
      return {
        hasCodeBlock: !!codeBlock,
        hasCopyBtn: !!copyBtn,
        preOverflow: getComputedStyle(pre).overflowX
      };
    });
    assert.ok(codeBlockInfo.hasCodeBlock, 'El bloque de código debe existir');
    assert.ok(codeBlockInfo.hasCopyBtn, 'El botón de copiar código debe existir');
    assert.equal(codeBlockInfo.preOverflow, 'auto', 'El bloque pre debe tener overflow-x: auto');

    // 4. Validar tabla GFM
    const tableInfo = await page.evaluate(() => {
      const table = document.querySelector('.markdown-table');
      const container = document.querySelector('.table-container');
      return {
        rows: table.querySelectorAll('tr').length,
        hasBorder: getComputedStyle(container).borderWidth !== '0px'
      };
    });
    assert.equal(tableInfo.rows, 3, 'La tabla debe tener 3 filas (1 thead + 2 tbody)');
    assert.ok(tableInfo.hasBorder, 'El contenedor de tabla debe tener borde');

  } finally {
    await browser.close();
  }
});

test('Browser UI - importar un JSON desde la barra lateral crea una única conversación activa', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);
    const sessionsBefore = await page.evaluate(() => window.ChatState.get('sessions').list.length);

    const payload = JSON.stringify({
      session: {
        title: 'Conversación importada de prueba',
        history: [
          { id: 'imported_user', role: 'user', content: 'Pregunta importada' },
          { id: 'imported_assistant', role: 'assistant', content: 'Respuesta importada' }
        ]
      }
    });
    await page.locator('#import-json-input').setInputFiles({
      name: 'importada.json', mimeType: 'application/json', buffer: Buffer.from(payload)
    });
    await page.waitForFunction(() => document.getElementById('notice-dialog').open);

    const result = await page.evaluate(() => {
      const sessions = window.ChatState.get('sessions');
      return {
        noticeType: document.getElementById('notice-dialog').getAttribute('data-type'),
        sessionCount: sessions.list.length,
        activeTitle: sessions.list.find(session => session.id === sessions.activeId)?.title,
        contents: window.ChatState.get('messages').map(message => message.content),
        inputValue: document.getElementById('import-json-input').value
      };
    });
    assert.equal(result.noticeType, 'success');
    assert.equal(result.sessionCount, sessionsBefore + 1, 'La importación debe ejecutarse una sola vez');
    assert.equal(result.activeTitle, 'Conversación importada de prueba');
    assert.ok(result.contents.includes('Respuesta importada'));
    assert.equal(result.inputValue, '');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

async function seedParent(page, parent, history) {
  await page.evaluate(({ parent, history }) => window.ChatStorage.saveConversation(parent, history), { parent, history });
  await openSavedSession(page, parent.id);
}

async function branchFrom(page, messageId) {
  const previousId = await page.evaluate(() => window.ChatState.get('sessions').activeId);
  await page.locator(`.message-wrapper.assistant[data-msg-ids="${messageId}"] .btn-branch-conversation`).click();
  return previousId;
}

test('Browser UI - crear una rama conserva el origen y corta el nuevo historial en la respuesta seleccionada', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);
    const parentId = 'session_branch_parent_test';
    const history = [
      { id: 'system_parent', role: 'system', content: 'System prompt' },
      { id: 'user_parent_1', role: 'user', content: 'Pregunta inicial' },
      { id: 'assistant_parent_1', role: 'assistant', content: 'Respuesta para bifurcar' },
      { id: 'user_parent_2', role: 'user', content: 'Pregunta posterior' },
      { id: 'assistant_parent_2', role: 'assistant', content: 'Respuesta posterior' }
    ];
    await seedParent(page, { id: parentId, title: 'Conversación origen', createdAt: Date.now(), updatedAt: Date.now() }, history);
    await branchFrom(page, 'assistant_parent_1');
    await page.waitForFunction(id => window.ChatState.get('sessions').activeId !== id, parentId);

    const result = await page.evaluate(async parentId => {
      const childId = window.ChatState.get('sessions').activeId;
      return {
        childId,
        childTitle: window.ChatState.get('sessions').list.find(session => session.id === childId)?.title,
        childHistory: (await window.ChatStorage.getConversation(childId)).history,
        sourceHistory: (await window.ChatStorage.getConversation(parentId)).history
      };
    }, parentId);

    assert.equal(result.childTitle, 'Rama: Conversación origen', 'La rama debe identificarse a partir del chat de origen');
    assert.equal(result.childHistory.length, 3, 'La rama debe incluir solo el historial hasta la respuesta seleccionada');
    assert.equal(result.sourceHistory.length, 5, 'La conversación de origen debe conservar todos sus mensajes');
    assert.notEqual(result.childHistory[2].id, 'assistant_parent_1', 'Los mensajes de la rama deben tener IDs propios para no sobrescribir el origen');
  } finally {
    await browser.close();
  }
});

test('Browser UI - Bifurcación con resumen crea rama compactada y renderiza banner colapsable', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);
    const parentId = 'session_branch_summarize_parent';
    const history = [
      { id: 'system_p', role: 'system', content: 'System prompt' },
      { id: 'user_p_1', role: 'user', content: 'Pregunta 1' },
      { id: 'asst_p_1', role: 'assistant', content: 'Respuesta 1' },
      { id: 'user_p_2', role: 'user', content: 'Pregunta 2' },
      { id: 'asst_p_2', role: 'assistant', content: 'Respuesta 2 para bifurcar' }
    ];
    await seedParent(page, { id: parentId, title: 'Chat largo previo', createdAt: Date.now(), updatedAt: Date.now() }, history);
    // El proveedor es la frontera externa: devuelve el resumen sin red.
    await page.evaluate(() => {
      window.ChatAPI.streamChatCompletion = async () => ({ accumulatedText: 'Resumen sintetizado del diálogo previo' });
    });
    await branchFrom(page, 'asst_p_2');
    // El diálogo ofrece resumir con la casilla marcada por defecto.
    await page.locator('#notice-accept').click();
    await page.waitForFunction(id => window.ChatState.get('sessions').activeId !== id && document.querySelector('.branch-summary-banner'), parentId);

    const childHistory = await page.evaluate(async () => (await window.ChatStorage.getConversation(window.ChatState.get('sessions').activeId)).history);
    assert.ok(childHistory.some(m => m._isSummaryBlock && m.content === 'Resumen sintetizado del diálogo previo'), 'Debe contener el bloque de resumen');
    assert.equal(childHistory[childHistory.length - 1].content, 'Respuesta 2 para bifurcar', 'Debe conservar la respuesta de anclaje');

    assert.equal(await page.locator('.branch-summary-banner').count(), 1, 'Debe renderizarse el banner de resumen en la UI');
    const body = page.locator('.branch-summary-body');
    assert.equal(await body.isVisible(), false, 'El cuerpo del resumen debe estar colapsado inicialmente');
    await page.locator('.branch-summary-header').click();
    assert.equal(await body.isVisible(), true, 'Al hacer clic debe expandirse el resumen');
    assert.match(await body.textContent(), /Resumen sintetizado/, 'Debe mostrar el contenido del resumen');
  } finally {
    await browser.close();
  }
});


test('Browser UI - Bifurcar con resumen muestra indicador de carga visual en el botón y píldora en el mensaje', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    const filePath = getIndexUrl();
    await page.goto(filePath, { waitUntil: 'load' });
    await waitForAppReady(page);

    await page.evaluate(() => {
      const messagesList = document.getElementById('messages-list');
      const placeholder = window.ChatUIConversation.createAssistantMessagePlaceholder(messagesList, 'test_msg_branch_load', { onBranch() {}, onDelete() {} });
      placeholder.actions.hidden = false;
      window.ChatUIConversation.showBranchLoadingIndicator(placeholder.wrapper, 'Resumiendo contexto previo...');
    });

    const btnBranch = page.locator('[data-msg-id="test_msg_branch_load"] .btn-branch-conversation');
    assert.equal(await btnBranch.isDisabled(), true, 'El botón de rama debe quedar deshabilitado');
    const btnClass = await btnBranch.getAttribute('class');
    assert.ok(btnClass.includes('is-loading'), 'El botón debe tener clase is-loading');

    const indicator = page.locator('[data-msg-id="test_msg_branch_load"] .branch-progress-indicator');
    assert.equal(await indicator.isVisible(), true, 'El indicador debe ser visible');
    assert.ok((await indicator.textContent()).includes('Resumiendo contexto previo...'));

    const spinIcon = page.locator('[data-msg-id="test_msg_branch_load"] .branch-progress-indicator svg.ui-icon-spin');
    assert.equal(await spinIcon.count(), 1, 'Debe incluir el icono vectorial con animación de giro');

    // Ahora ocultar el indicador y verificar restauración
    await page.evaluate(() => {
      const wrapper = document.querySelector('[data-msg-id="test_msg_branch_load"]');
      window.ChatUIConversation.hideBranchLoadingIndicator(wrapper);
    });

    assert.equal(await indicator.count(), 0, 'El indicador debe removerse del DOM');
    assert.equal(await btnBranch.isDisabled(), false, 'El botón debe reactivarse');
    const restoredClass = await btnBranch.getAttribute('class');
    assert.ok(!restoredClass.includes('is-loading'), 'La clase is-loading debe retirarse');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
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

test('Browser UI - fecha inicial persistente y hora solo mediante herramienta', async () => {
  const browser = await createTestBrowser();
  try {
    for (const file of ['zerochat.html']) {
      const context = await browser.newContext({ timezoneId: 'Europe/Madrid' });
      const page = await context.newPage();
      await page.clock.setFixedTime(new Date('2026-09-05T23:30:00Z'));
      await page.goto('file://' + path.resolve(__dirname, '../..', file), { waitUntil: 'load' });
      await page.waitForFunction(() => !!window.ChatEngine?.ensureConversationDate);
      const initial = await page.evaluate(async () => {
        const history = [{ id: 'system_root', role: 'system', content: 'Sistema' }, { role: 'user', content: 'Hola' }];
        const anchor = ChatEngine.ensureConversationDate(history);
        const messages = ChatEngine.buildEffectiveMessages(history, ChatConfig.getActive());
        await ChatStorage.saveConversation({ id: 'temporal_browser', title: 'Fecha fija', createdAt: Date.now() }, history);
        return { anchor, messages };
      });
      assert.match(initial.anchor, /2026-09-06/);
      await page.clock.setFixedTime(new Date('2026-09-08T10:00:00Z'));
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(() => !!window.ChatEngine?.ensureConversationDate);
      const restored = await page.evaluate(async () => {
        const session = await ChatStorage.getConversation('temporal_browser');
        const messages = ChatEngine.buildEffectiveMessages(session.history, ChatConfig.getActive());
        return { messages, fresh: ChatEngine.getConversationDateAnchor() };
      });
      assert.deepEqual(restored.messages, initial.messages, file);
      assert.equal(restored.messages[1].content, 'Hola');
      assert.ok(!JSON.stringify(restored.messages).includes('[Context Time:'));
      assert.match(restored.fresh, /2026-09-08/);
      await context.close();
    }
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

test('Browser UI - inicializar el modo proyecto envía el prompt de arranque como mensaje del usuario', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);
    await page.evaluate(() => {
      const ProjectContext = window.ChatProjectContext;
      ProjectContext.refresh = async () => window.ChatState.get('project');
      ProjectContext.canInitialize = () => true;
      ProjectContext.initialize = async ({ sendPrompt }) => sendPrompt('Initialize project mode for /tmp/demo');
      window.ChatConfig.updateRuntime({ projectMode: true });
      window.ChatState.setProjectContext({ cwd: '/tmp/demo', status: 'missing' });
    });
    await page.click('#btn-reasoning');
    await page.click('[data-project-action="initialize"]');
    await page.waitForFunction(() => window.ChatState.get('messages').some(message => message.role === 'user'));
    const state = await page.evaluate(() => ({
      sent: window.ChatState.get('messages').filter(message => message.role === 'user').pop().content,
      menuOpen: !document.getElementById('reasoning-menu').hidden
    }));
    assert.equal(state.sent, 'Initialize project mode for /tmp/demo');
    assert.equal(state.menuOpen, false, 'El menú de razonamiento se cierra al enviar');
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

test('Browser UI - el subagente usa el perfil de conexión «Subagente» si existe', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem('zerochat_profiles_v1', JSON.stringify({
        schemaVersion: 1,
        profiles: [{ id: 'profile:Subagente', name: 'Subagente', settings: { apiUrl: 'http://127.0.0.1:9/sub', apiType: 'openai', model: 'sub-model' } }]
      }));
    });
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);
    await installSubagentTestHelpers(page);
    const result = await page.evaluate(async () => {
      const { isSubagent, reply } = window.__subagentTest;
      const API = window.ChatAPI;
      const original = API.streamChatCompletion;
      const requests = [];
      let parentRequests = 0;
      API.streamChatCompletion = async params => {
        const subagent = isSubagent(params);
        requests.push({ subagent, model: params.model, apiUrl: params.apiUrl });
        if (subagent) return reply(params, 'Informe');
        return ++parentRequests === 1
          ? reply(params, '', [{ id: 'parent_1', type: 'function', function: { name: 'delegate_task', arguments: JSON.stringify({ task: 'Investigate' }) } }])
          : reply(params, 'Listo.');
      };
      const container = document.createElement('div');
      document.getElementById('messages-list').appendChild(container);
      try {
        await window.ChatEngine.executeAgentTurnLoop({
          chatHistory: [{ role: 'user', content: 'Hola' }],
          appConfig: window.ChatConfig.normalize({ apiUrl: 'http://127.0.0.1:9/main', apiType: 'openai', model: 'main-model', enabledTools: { execute_javascript: true, search_web: false, fetch_web_page: false, download_doc: false, download_image: false, render_chart: false, delegate_task: true } }),
          assistantMsgId: 'asst_subagent',
          view: window.ChatUIConversation.createTurnView(container, { scrollToBottom() {} }),
          onReasoningChunk() {},
          onLog() {},
          onStats() {},
          onGenerationStatus() {}
        });
        const label = container.querySelector('.subagent-card .subagent-model');
        return { requests, label: label?.textContent, labelTitle: label?.title, labelHidden: label?.hidden };
      } finally {
        API.streamChatCompletion = original;
        container.remove();
      }
    });
    assert.deepEqual(result.requests.filter(request => request.subagent).map(request => request.model), ['sub-model']);
    assert.equal(result.requests.find(request => request.subagent).apiUrl, 'http://127.0.0.1:9/sub');
    assert.ok(result.requests.filter(request => !request.subagent).every(request => request.model === 'main-model'));
    assert.equal(result.label, 'sub-model', 'La tarjeta indica el modelo del perfil');
    assert.match(result.labelTitle, /Subagente/);
    assert.equal(result.labelHidden, false);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

});
