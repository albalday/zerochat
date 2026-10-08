const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTestBrowser, closeGlobalBrowser, seedConnectionProfiles, getIndexUrl, waitForAppReady } = require('../helpers/browser-env.js');

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
        ChatMarkdown.attachCopyCodeListeners(card);
        return card;
      };
      const finish = (card, name, success = true) => {
        const output = { success };
        cards.updateLiveToolCard(card, name, {}, output, 1);
        cards.completeToolCard(card, output);
        ChatMarkdown.attachCopyCodeListeners(card);
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
        initialize: async () => {},
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
        ['download_pdf', { url: 'https://example.com/a.pdf' }, { success: true, text: 'PDF' }],
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
      ChatMarkdown.attachCopyCodeListeners(container);
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

test('Browser UI - crear una rama conserva el origen y corta el nuevo historial en la respuesta seleccionada', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);

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

test('Browser UI - Bifurcación con resumen crea rama compactada y renderiza banner colapsable', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);

    const result = await page.evaluate(async () => {
      const parentId = 'session_branch_summarize_parent';
      const history = [
        { id: 'system_p', role: 'system', content: 'System prompt' },
        { id: 'user_p_1', role: 'user', content: 'Pregunta 1' },
        { id: 'asst_p_1', role: 'assistant', content: 'Respuesta 1' },
        { id: 'user_p_2', role: 'user', content: 'Pregunta 2' },
        { id: 'asst_p_2', role: 'assistant', content: 'Respuesta 2 para bifurcar' }
      ];
      const parent = { id: parentId, title: 'Chat largo previo', createdAt: Date.now(), updatedAt: Date.now(), messageCount: history.length };
      window.ChatState.replaceConversation({ sessionId: parentId, messages: history });
      window.ChatState.saveSessionMetadata(parent);
      await window.ChatStorage.saveConversation(parent, history);

      const wrapper = document.createElement('div');
      wrapper.setAttribute('data-msg-id', 'asst_p_2');
      wrapper.setAttribute('data-msg-ids', 'asst_p_2');
      const created = await window.ChatApp.createConversationBranch(wrapper, {
        summarize: true,
        summarizeHistory: async () => 'Resumen sintetizado del diálogo previo'
      });
      const childId = window.ChatState.get('sessions').activeId;
      const child = await window.ChatStorage.getConversation(childId);
      const childSession = window.ChatState.get('sessions').list.find(s => s.id === childId);
      return {
        created,
        childId,
        childMetadata: childSession?.metadata || child?.metadata || {},
        childHistory: child?.history || []
      };
    });

    assert.equal(result.created, true, 'La rama con resumen debe crearse correctamente');
    assert.equal(result.childMetadata.isSummarizedBranch, true, 'Debe marcarse como rama resumida');
    assert.ok(result.childHistory.some(m => m._isSummaryBlock && m.content === 'Resumen sintetizado del diálogo previo'), 'Debe contener el bloque de resumen');
    assert.equal(result.childHistory[result.childHistory.length - 1].content, 'Respuesta 2 para bifurcar', 'Debe conservar la respuesta de anclaje');

    // Verificar renderizado en el DOM
    const banner = await page.locator('.branch-summary-banner');
    assert.equal(await banner.count(), 1, 'Debe renderizarse el banner de resumen en la UI');

    const toggle = page.locator('.branch-summary-header');
    const body = page.locator('.branch-summary-body');
    assert.equal(await body.isVisible(), false, 'El cuerpo del resumen debe estar colapsado inicialmente');

    await toggle.click();
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
      const placeholder = window.ChatUIConversation.createAssistantMessagePlaceholder(messagesList, 'test_msg_branch_load');
      placeholder.actions.style.display = 'inline-flex';
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
    const filePath = getIndexUrl();
    await page.goto(filePath, { waitUntil: 'load' });
    await waitForAppReady(page);

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

      for (let i = 0; i < 100 && !document.querySelector('.message-wrapper.assistant .btn-delete'); i++) {
        await new Promise(r => setTimeout(r, 20));
      }
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

      for (let i = 0; i < 100 && (await window.ChatStorage.getConversation(sessionId))?.history.length === history.length; i++) {
        await new Promise(r => setTimeout(r, 20));
      }

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
    const filePath = getIndexUrl();
    await page.goto(filePath, { waitUntil: 'load' });
    await waitForAppReady(page);

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
test('Browser UI - el autoscroll respeta al usuario que sube durante la generación', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);
    const result = await page.evaluate(() => {
      const ui = window.ChatUIConversation;
      const container = document.createElement('div');
      container.style.cssText = 'position:fixed;top:0;left:0;width:300px;height:200px;overflow-y:auto;scroll-behavior:smooth';
      document.body.appendChild(container);
      const addLines = n => {
        for (let i = 0; i < n; i++) {
          const line = document.createElement('p');
          line.style.cssText = 'height:40px;margin:0';
          container.appendChild(line);
        }
      };
      const atBottom = () => container.scrollHeight - container.scrollTop - container.clientHeight <= 1;
      addLines(20);
      ui.scrollToBottom(container);
      const followed = atBottom();
      container.dispatchEvent(new WheelEvent('wheel', { deltaY: -120 }));
      container.scrollTo({ top: 100, behavior: 'instant' });
      addLines(10);
      ui.scrollToBottom(container);
      const kept = container.scrollTop;
      ui.scrollToBottom(container, { force: true });
      const forced = atBottom();
      container.remove();
      return { followed, kept, forced };
    });
    assert.equal(result.followed, true);
    assert.equal(result.kept, 100);
    assert.equal(result.forced, true);
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
      window.ChatUIConversation.renderSessionMessages({ messagesList: document.getElementById('messages-list') }, history);
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

});
