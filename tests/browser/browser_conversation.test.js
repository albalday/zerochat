const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTestBrowser, closeGlobalBrowser, seedConnectionProfiles, getBundleUrl, getIndexUrl } = require('../helpers/browser-env.js');

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
    await page.goto('file://' + path.resolve(__dirname, '../../zerochat.html'), { waitUntil: 'load' });
    await page.waitForFunction(() => document.documentElement.classList.contains('zerochat-ready'));
    const result = await page.evaluate(async () => {
      const ui = window.ChatUIConversation;
      const copied = [];
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => copied.push(text) } });
      const container = document.createElement('div');
      document.body.appendChild(container);
      ui.appendUserMessage(container, null, { text: 'Visible text', originalPrompt: 'Original prompt' });
      await container.querySelector('.btn-copy-user').onclick();
      ui.renderSessionMessages({ messagesList: container }, [
        { id: 'user-1', role: 'user', content: 'Question' },
        { id: 'reply_turn_0_assistant', role: 'assistant', content: '**First**' },
        { id: 'reply_final', role: 'assistant', content: 'Final' }
      ]);
      await container.querySelector('.btn-copy-full').onclick();
      const historicalBlocks = [...container.querySelectorAll('.agentic-turn-block')].map(el => el.innerHTML);
      const live = ui.createAssistantBlock(container);
      ui.renderAssistantBlock(live, '**First**', { streaming: true });
      const cursorDuringStream = !!live.querySelector('.streaming-cursor');
      ui.renderAssistantBlock(live, '**First**');
      const sameMarkup = historicalBlocks[0] === live.innerHTML;
      const cursorAfterStream = !!live.querySelector('.streaming-cursor');
      const content = document.createElement('div');
      const hostile = '<img src=x onerror="window.__dupliXss=true">';
      ui.renderConnectionError({ content }, hostile, hostile);
      const safeError = !content.querySelector('img') && content.textContent.includes(hostile);
      container.remove();
      return { copied, historicalCount: historicalBlocks.length, cursorDuringStream, cursorAfterStream, sameMarkup, safeError, xss: !!window.__dupliXss };
    });
    assert.deepEqual(result.copied, ['Original prompt', '**First**\n\nFinal']);
    assert.equal(result.historicalCount, 2);
    assert.equal(result.cursorDuringStream, true);
    assert.equal(result.cursorAfterStream, false);
    assert.equal(result.sameMarkup, true);
    assert.equal(result.safeError, true);
    assert.equal(result.xss, false);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('Browser UI - Fase 3: Canvas de Mensajes Centrado, Tipografía y Markdown', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const filePath = 'file://' + path.resolve(__dirname, '../../zerochat.html');
    await page.goto(filePath, { waitUntil: 'load' });

    // Esperar a que la inicialización asíncrona de sesión en IndexedDB concluya
    await page.waitForSelector('#welcome-banner');
    await new Promise(r => setTimeout(r, 200));

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

    // 5. Validar que las acciones de mensaje y las estadísticas usan SVG limpios sin emojis
    const msgActionsInfo = await page.evaluate(() => {
      const actionBtns = Array.from(document.querySelectorAll('.btn-msg-action'));
      const statItems = Array.from(document.querySelectorAll('.stat-item'));
      const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;
      
      const allActionBtnsHaveSvg = actionBtns.every(btn => btn.querySelector('svg.ui-icon'));
      const noActionBtnHasEmoji = actionBtns.every(btn => !emojiRegex.test(btn.textContent));
      const allActionBtnsIconOnly = actionBtns.every(btn => !btn.querySelector('span') && !btn.textContent.trim());
      const allStatsHaveSvg = statItems.every(item => item.querySelector('svg.ui-icon'));
      const noStatHasEmoji = statItems.every(item => !emojiRegex.test(item.textContent));

      return {
        allActionBtnsHaveSvg,
        noActionBtnHasEmoji,
        allActionBtnsIconOnly,
        allStatsHaveSvg,
        noStatHasEmoji,
        actionBtnCount: actionBtns.length,
        statCount: statItems.length
      };
    });

    assert.ok(msgActionsInfo.actionBtnCount > 0, 'Deben existir botones de acción de mensaje');
    const branchButton = await page.$('.message-wrapper.assistant .btn-branch-conversation');
    assert.ok(branchButton, 'Las respuestas deben incluir una acción para crear una rama');
    const userCopyButton = await page.$('.message-wrapper.user .btn-copy-user');
    assert.ok(userCopyButton, 'Los mensajes de usuario deben incluir una acción para copiar');
    assert.ok(msgActionsInfo.allActionBtnsHaveSvg, 'Todos los botones de acción deben contener un SVG .ui-icon');
    assert.ok(msgActionsInfo.allActionBtnsIconOnly, 'Todos los botones de acción deben ser únicamente icono sin texto');
    assert.ok(msgActionsInfo.noActionBtnHasEmoji, 'Ningún botón de acción debe tener emojis en su texto');
    assert.ok(msgActionsInfo.statCount > 0, 'Deben existir items de estadísticas');
    assert.ok(msgActionsInfo.allStatsHaveSvg, 'Todos los items de estadísticas deben contener un SVG .ui-icon');
    assert.ok(msgActionsInfo.noStatHasEmoji, 'Ningún item de estadísticas debe tener emojis en su texto');
  } finally {
    await browser.close();
  }
});

test('Browser UI - crear una rama conserva el origen y corta el nuevo historial en la respuesta seleccionada', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    await page.goto('file://' + path.resolve(__dirname, '../../zerochat.html'), { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.ChatApp && !!window.ChatState && !!window.ChatStorage);
    await new Promise(resolve => setTimeout(resolve, 200));

    const result = await page.evaluate(async () => {
      const parentId = 'session_branch_parent_test';
      const history = [
        { id: 'system_parent', role: 'system', content: 'System prompt' },
        { id: 'user_parent_1', role: 'user', content: 'Pregunta inicial' },
        { id: 'assistant_parent_1', role: 'assistant', content: 'Respuesta para bifurcar' },
        { id: 'user_parent_2', role: 'user', content: 'Pregunta posterior' },
        { id: 'assistant_parent_2', role: 'assistant', content: 'Respuesta posterior' }
      ];
      const parent = { id: parentId, title: 'Conversación origen', createdAt: Date.now(), updatedAt: Date.now(), messageCount: history.length };
      window.ChatState.replaceConversation({ sessionId: parentId, messages: history });
      window.ChatState.saveSessionMetadata(parent);
      await window.ChatStorage.saveConversation(parent, history);

      const wrapper = document.createElement('div');
      wrapper.setAttribute('data-msg-id', 'assistant_parent_1');
      wrapper.setAttribute('data-msg-ids', 'assistant_parent_1');
      const created = await window.ChatApp.createConversationBranch(wrapper);
      const childId = window.ChatState.get('sessions').activeId;
      const child = await window.ChatStorage.getConversation(childId);
      const source = await window.ChatStorage.getConversation(parentId);
      return {
        created,
        childId,
        childTitle: window.ChatState.get('sessions').list.find(session => session.id === childId)?.title,
        childHistory: child?.history || [],
        sourceHistory: source?.history || []
      };
    });

    assert.equal(result.created, true, 'La rama debe crearse correctamente');
    assert.notEqual(result.childId, 'session_branch_parent_test', 'La rama debe tener una sesión distinta');
    assert.equal(result.childTitle, 'Rama: Conversación origen', 'La rama debe identificarse a partir del chat de origen');
    assert.equal(result.childHistory.length, 3, 'La rama debe incluir solo el historial hasta la respuesta seleccionada');
    assert.equal(result.sourceHistory.length, 5, 'La conversación de origen debe conservar todos sus mensajes');
    assert.notEqual(result.childHistory[2].id, 'assistant_parent_1', 'Los mensajes de la rama deben tener IDs propios para no sobrescribir el origen');
  } finally {
    await browser.close();
  }
});

test('Browser UI - Borrado de respuesta de asistente con tools elimina completamente las respuestas de tools y sanea chatHistory', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    const filePath = 'file://' + path.resolve(__dirname, '../../zerochat.html');
    await page.goto(filePath, { waitUntil: 'load' });

    const result = await page.evaluate(async () => {
      const sessionId = 'test_session_delete_tools_' + Date.now();
      const baseId = 'msg_ast_interactive_test';
      const history = [
        { id: 'usr_msg_1', role: 'user', content: '¿Qué hora es?' },
        {
          id: `${baseId}_turn_0_assistant`,
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_time_ui', type: 'function', function: { name: 'execute_javascript', arguments: '{"code":"2+2"}' } }]
        },
        {
          id: `${baseId}_turn_0_tool_call_time_ui`,
          role: 'tool',
          tool_call_id: 'call_time_ui',
          name: 'execute_javascript',
          content: '4'
        },
        {
          id: `${baseId}_final`,
          role: 'assistant',
          content: 'Son exactamente las 12:00 UTC.'
        }
      ];

      // Guardar conversación en el almacenamiento
      await window.ChatStorage.saveConversation({ id: sessionId, title: 'Test Delete Tools' }, history);
      window.ChatState.setState({
        agent: { activeTurnIndex: 3, currentTool: 'execute_javascript', loopWarning: true, ragSystemContext: 'stale context' },
        telemetry: { stats: { tokens: 99 }, diagnostics: { used: 99 }, lastTurnStats: { tokens: 42 } },
        ui: { reasoningMenuOpen: true, debugPanelOpen: true, attachedFiles: [{ name: 'stale.txt' }] }
      });
      window.ChatAttachments.addFile({ name: 'stale.txt', type: 'text', size: 1, content: 'x' });

      // Cargar la conversación en la UI
      const switched = await window.ChatApp.switchToSession(sessionId);

      // Esperar renderizado
      await new Promise(r => setTimeout(r, 100));
      const assistantWrapper = document.querySelector('.message-wrapper.assistant');
      const deleteBtn = assistantWrapper?.querySelector('.btn-delete');

      const beforeDelete = {
        switched,
        hasAssistantWrapper: !!assistantWrapper,
        hasDeleteBtn: !!deleteBtn,
        restoredMessages: window.ChatState.get('messages'),
        restoredAgent: window.ChatState.get('agent'),
        restoredTelemetry: window.ChatState.get('telemetry'),
        restoredUi: window.ChatState.get('ui'),
        attachedFilesCount: window.ChatAttachments.getFiles().length
      };

      if (deleteBtn) {
        deleteBtn.click();
      }

      // Esperar microtask / actualización de storage
      await new Promise(r => setTimeout(r, 100));

      const loadedAfter = await window.ChatStorage.getConversation(sessionId);
      const afterHistory = loadedAfter ? loadedAfter.history : [];
      const remainingWrappers = document.querySelectorAll('.message-wrapper');

      return {
        beforeDelete,
        remainingWrappersCount: remainingWrappers.length,
        hasAssistantWrapperAfter: !!document.querySelector('.message-wrapper.assistant'),
        afterHistoryLength: afterHistory.length,
        toolCountAfter: afterHistory.filter(m => m.role === 'tool').length,
        assistantCountAfter: afterHistory.filter(m => m.role === 'assistant').length,
        userCountAfter: afterHistory.filter(m => m.role === 'user').length
      };
    });

    assert.equal(result.beforeDelete.switched, true, 'La conversación guardada debe restaurarse desde el historial');
    assert.ok(result.beforeDelete.hasAssistantWrapper, 'El asistente con tools debe renderizarse inicialmente');
    assert.ok(result.beforeDelete.hasDeleteBtn, 'El botón de eliminar respuesta debe existir');
    assert.equal(result.beforeDelete.restoredMessages.length, 4, 'Debe restaurar todos los mensajes del turno guardado');
    assert.deepEqual(result.beforeDelete.restoredMessages[1].tool_calls, [{ id: 'call_time_ui', type: 'function', function: { name: 'execute_javascript', arguments: '{"code":"2+2"}' } }]);
    assert.deepEqual(result.beforeDelete.restoredAgent, { activeTurnIndex: 0, currentTool: null, loopWarning: false, ragSystemContext: '' });
    assert.deepEqual(result.beforeDelete.restoredTelemetry, { stats: null, diagnostics: null, lastTurnStats: null });
    assert.equal(result.beforeDelete.restoredUi.reasoningMenuOpen, false);
    assert.equal(result.beforeDelete.restoredUi.debugPanelOpen, false);
    assert.equal(result.beforeDelete.attachedFilesCount, 0, 'Los adjuntos transitorios no deben filtrarse al chat restaurado');
    assert.equal(result.hasAssistantWrapperAfter, false, 'El wrapper del asistente debe haber desaparecido del DOM');
    assert.equal(result.toolCountAfter, 0, 'No deben quedar respuestas de tool en el historial persistido');
    assert.equal(result.assistantCountAfter, 0, 'No deben quedar mensajes de asistente de la respuesta eliminada');
    assert.equal(result.userCountAfter, 1, 'Debe permanecer el mensaje de usuario');
  } finally {
    await browser.close();
  }
});

test('Browser UI - Borrado de mensaje durante streaming no modifica DOM ni estado', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    const filePath = 'file://' + path.resolve(__dirname, '../../zerochat.html');
    await page.goto(filePath, { waitUntil: 'load' });

    const result = await page.evaluate(async () => {
      const sessionId = 'test_session_delete_streaming_' + Date.now();
      const history = [
        { id: 'usr_streaming_1', role: 'user', content: 'Mensaje que no debe borrarse' },
        { id: 'ast_streaming_1', role: 'assistant', content: 'Respuesta previa' }
      ];

      await window.ChatStorage.saveConversation({ id: sessionId, title: 'Test Delete Streaming' }, history);
      await window.ChatApp.switchToSession(sessionId);
      window.ChatState.set('streaming', { isGenerating: true, status: 'streaming' });

      const userWrapper = document.querySelector('.message-wrapper.user');
      userWrapper?.querySelector('.btn-delete')?.click();
      await new Promise(resolve => setTimeout(resolve, 100));

      const persisted = await window.ChatStorage.getConversation(sessionId);
      const stateMessages = window.ChatState.get('messages');
      window.ChatState.set('streaming', { isGenerating: false, status: 'idle' });
      return {
        userWrapperPresent: !!document.querySelector('.message-wrapper.user'),
        stateIds: stateMessages.map(message => message.id),
        persistedIds: (persisted?.history || []).map(message => message.id)
      };
    });

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
        const anchor = ChatEngine.ensureConversationDate(history, 'es');
        const messages = ChatEngine.buildEffectiveMessages(history);
        await ChatStorage.saveConversation({ id: 'temporal_browser', title: 'Fecha fija', createdAt: Date.now() }, history);
        return { anchor, messages };
      });
      assert.match(initial.anchor, /2026-09-06/);
      await page.clock.setFixedTime(new Date('2026-09-08T10:00:00Z'));
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(() => !!window.ChatEngine?.ensureConversationDate);
      const restored = await page.evaluate(async () => {
        const session = await ChatStorage.getConversation('temporal_browser');
        const messages = ChatEngine.buildEffectiveMessages(session.history);
        return { messages, fresh: ChatEngine.getConversationDateAnchor('es') };
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
});
