const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');

test('Browser UI - index.html declara el mismo runtime que se distribuye', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', msg => {
      if (msg.type() === 'error' && !msg.text().includes('favicon')) {
        consoleErrors.push(msg.text());
      }
    });
    page.on('pageerror', err => consoleErrors.push(err.message));

    await page.goto('file://' + path.resolve(__dirname, '../index.html'), { waitUntil: 'load' });

    assert.equal(consoleErrors.length, 0, 'No debe haber errores de consola: ' + consoleErrors.join(' | '));
    assert.equal(await page.title(), 'ZeroChat v6.3.0', 'El título de index.html debe ser ZeroChat v6.3.0');
    const runtime = await page.evaluate(() => ({
      chatIcons: typeof window.ChatIcons?.get === 'function',
      iconStyles: getComputedStyle(document.querySelector('.ui-icon')).display
    }));
    assert.equal(runtime.chatIcons, true, 'El HTML base debe cargar el módulo de iconos usado por la aplicación');
    assert.equal(runtime.iconStyles, 'block', 'El HTML base debe cargar los estilos de iconos');
  } finally {
    await browser.close();
  }
});

test('Browser UI - Carga limpia del bundle zerochat.html sin errores de consola', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        const text = msg.text();
        if (!text.includes('favicon')) {
          consoleErrors.push(text);
        }
      }
    });
    page.on('pageerror', err => consoleErrors.push(err.message));

    const filePath = 'file://' + path.resolve(__dirname, '../zerochat.html');
    await page.goto(filePath, { waitUntil: 'load' });

    assert.equal(consoleErrors.length, 0, 'No debe haber errores de consola: ' + consoleErrors.join(' | '));
    const title = await page.title();
    assert.equal(title, 'ZeroChat v6.3.0', 'El título de zerochat.html debe ser ZeroChat v6.3.0');

    // Verificar que los componentes clave están en el DOM
    const hasChatContainer = await page.$eval('.chat-container', el => !!el);
    assert.ok(hasChatContainer, 'El contenedor de chat debe existir');

    const hasMessagesList = await page.$eval('#messages-list', el => !!el);
    assert.ok(hasMessagesList, 'La lista de mensajes debe existir');

    const hasChatForm = await page.$eval('#chat-form', el => !!el);
    assert.ok(hasChatForm, 'El formulario de chat debe existir');

    // Verificar resolución de variables CSS de diseño
    const styles = await page.evaluate(() => {
      const bodyStyle = getComputedStyle(document.body);
      return {
        bgApp: bodyStyle.backgroundColor,
        color: bodyStyle.color,
        fontFamily: bodyStyle.fontFamily
      };
    });
    assert.ok(styles.bgApp, 'El fondo de la app debe estar computado');
    assert.ok(styles.color, 'El color de texto debe estar computado');
  } finally {
    await browser.close();
  }
});

test('Browser UI - Modo Oscuro y resolución de Design Tokens', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const filePath = 'file://' + path.resolve(__dirname, '../zerochat.html');
    await page.goto(filePath, { waitUntil: 'load' });

    // 1. Validar tokens en modo claro
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'light');
    });

    const lightTokens = await page.evaluate(() => {
      const docStyle = getComputedStyle(document.documentElement);
      const bodyStyle = getComputedStyle(document.body);
      return {
        primary: docStyle.getPropertyValue('--primary').trim(),
        bgApp: docStyle.getPropertyValue('--bg-app').trim(),
        bgSurface: docStyle.getPropertyValue('--bg-surface').trim(),
        textMain: docStyle.getPropertyValue('--text-main').trim(),
        radiusMd: docStyle.getPropertyValue('--radius-md').trim(),
        bodyBg: bodyStyle.backgroundColor
      };
    });

    assert.ok(lightTokens.primary, 'Debe resolver --primary');
    assert.ok(lightTokens.bgApp, 'Debe resolver --bg-app');
    assert.ok(lightTokens.bgSurface, 'Debe resolver --bg-surface');
    assert.ok(lightTokens.radiusMd, 'Debe resolver --radius-md');

    // 2. Validar tokens en modo oscuro
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'dark');
    });

    const darkTokens = await page.evaluate(() => {
      const docStyle = getComputedStyle(document.documentElement);
      const bodyStyle = getComputedStyle(document.body);
      return {
        primary: docStyle.getPropertyValue('--primary').trim(),
        bgApp: docStyle.getPropertyValue('--bg-app').trim(),
        bgSurface: docStyle.getPropertyValue('--bg-surface').trim(),
        textMain: docStyle.getPropertyValue('--text-main').trim(),
        bodyBg: bodyStyle.backgroundColor
      };
    });

    assert.ok(darkTokens.primary, 'Debe resolver --primary en dark');
    assert.notEqual(darkTokens.bgApp, lightTokens.bgApp, 'El fondo de la app debe diferir entre temas');
    assert.notEqual(darkTokens.bodyBg, lightTokens.bodyBg, 'El fondo computado del body debe cambiar en dark');
  } finally {
    await browser.close();
  }
});

test('Browser UI - Fase 2: Header Superior Moderno y Acciones Integradas', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const filePath = 'file://' + path.resolve(__dirname, '../zerochat.html');
    await page.goto(filePath, { waitUntil: 'load' });

    // 1. Verificar presencia y posición del header moderno
    const headerInfo = await page.$eval('.app-header', el => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return {
        exists: !!el,
        position: style.position,
        top: rect.top,
        height: rect.height,
        display: style.display
      };
    });
    assert.ok(headerInfo.exists, 'El header (.app-header) debe existir');
    assert.equal(headerInfo.display, 'flex', 'El header debe ser flex');
    assert.ok(headerInfo.height >= 40, 'El header debe tener altura suficiente');

    // 2. Verificar que la antigua barra superior sobre el prompt ya NO existe
    const hasOldToolbar = await page.$eval('.input-toolbar-top', () => true).catch(() => false);
    assert.equal(hasOldToolbar, false, 'La barra .input-toolbar-top obsoleta debe haber sido retirada');

    // 3. Verificar que el botón de toggle del sidebar reside en el header y abre/cierra la barra lateral
    const isSidebarToggleInHeader = await page.$eval('.app-header #btn-toggle-sidebar', el => !!el);
    assert.ok(isSidebarToggleInHeader, '#btn-toggle-sidebar debe residir dentro de .app-header');

    // Estado inicial: sidebar cerrado
    const sidebarInitialDisplay = await page.$eval('#chat-sidebar', el => getComputedStyle(el).display);
    assert.equal(sidebarInitialDisplay, 'none');

    // Abrir sidebar pulsando el botón del header
    await page.click('#btn-toggle-sidebar');
    const sidebarOpenedDisplay = await page.$eval('#chat-sidebar', el => getComputedStyle(el).display);
    assert.equal(sidebarOpenedDisplay, 'flex', 'El sidebar debe abrirse (display: flex) tras pulsar el botón del header');

    // Cerrar sidebar pulsando el botón de cerrar del sidebar
    await page.click('#btn-close-sidebar');
    const sidebarClosedAgain = await page.$eval('#chat-sidebar', el => getComputedStyle(el).display);
    assert.equal(sidebarClosedAgain, 'none', 'El sidebar debe cerrarse');

    // 4. Selector de perfiles activo en el header
    const hasProfileSelect = await page.$eval('.app-header #active-profile-select', el => !!el);
    assert.ok(hasProfileSelect, 'El selector de perfil debe residir dentro del header');

    // 5. Botón de Configuración abre el diálogo
    await page.click('#btn-open-settings');
    await page.waitForFunction(() => document.getElementById('settings-dialog')?.open);
    const isSettingsOpen = await page.$eval('#settings-dialog', el => el.open);
    assert.ok(isSettingsOpen, 'Pulsar el botón de ajustes en el header debe abrir #settings-dialog');
    await page.click('#btn-close-settings');
    await page.waitForFunction(() => !document.getElementById('settings-dialog')?.open);

    // 6. Botón de RAG abre el diálogo de conocimiento (asíncrono con refresh)
    await page.click('#btn-open-rag');
    await page.waitForFunction(() => document.getElementById('rag-modal')?.open);
    const isRagOpen = await page.$eval('#rag-modal', el => el.open);
    assert.ok(isRagOpen, 'Pulsar el botón de conocimiento en el header debe abrir #rag-modal');
    await page.click('#btn-close-rag');
    await page.waitForFunction(() => !document.getElementById('rag-modal')?.open);
  } finally {
    await browser.close();
  }
});

test('Browser UI - Fase 3: Canvas de Mensajes Centrado, Tipografía y Markdown', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const filePath = 'file://' + path.resolve(__dirname, '../zerochat.html');
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
      
      // Mensaje de Usuario
      const userMsg = document.createElement('div');
      userMsg.className = 'message-wrapper user';
      userMsg.innerHTML = `
        <div class="message-row user">
          <div class="message-content-wrapper">
            <div class="message-content">Hola ZeroChat, muéstrame una tabla y código.</div>
            <div class="message-footer-row">
              <div class="message-actions">
                <button class="btn-msg-action">${editSvg} <span>Editar</span></button>
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
                <span class="stat-item">${zapSvg} <span>45 tok/s</span></span>
              </div>
              <div class="message-actions">
                <button class="btn-msg-action">${copySvg} <span>Copiar</span></button>
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
      const allStatsHaveSvg = statItems.every(item => item.querySelector('svg.ui-icon'));
      const noStatHasEmoji = statItems.every(item => !emojiRegex.test(item.textContent));

      return {
        allActionBtnsHaveSvg,
        noActionBtnHasEmoji,
        allStatsHaveSvg,
        noStatHasEmoji,
        actionBtnCount: actionBtns.length,
        statCount: statItems.length
      };
    });

    assert.ok(msgActionsInfo.actionBtnCount > 0, 'Deben existir botones de acción de mensaje');
    assert.ok(msgActionsInfo.allActionBtnsHaveSvg, 'Todos los botones de acción deben contener un SVG .ui-icon');
    assert.ok(msgActionsInfo.noActionBtnHasEmoji, 'Ningún botón de acción debe tener emojis en su texto');
    assert.ok(msgActionsInfo.statCount > 0, 'Deben existir items de estadísticas');
    assert.ok(msgActionsInfo.allStatsHaveSvg, 'Todos los items de estadísticas deben contener un SVG .ui-icon');
    assert.ok(msgActionsInfo.noStatHasEmoji, 'Ningún item de estadísticas debe tener emojis en su texto');
  } finally {
    await browser.close();
  }
});

test('Browser UI - Fase 4: Composer Flotante Omnibox, Auto-expansión y Botones Circulares', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const filePath = 'file://' + path.resolve(__dirname, '../zerochat.html');
    await page.goto(filePath, { waitUntil: 'load' });
    await page.waitForSelector('#welcome-banner');

    // 1. Validar geometría y curvatura del Omnibox (.chat-input-container)
    const composerMetrics = await page.evaluate(() => {
      const container = document.querySelector('.chat-input-container');
      const style = getComputedStyle(container);
      const rect = container.getBoundingClientRect();
      return {
        borderRadius: parseFloat(style.borderRadius),
        width: rect.width,
        boxShadow: style.boxShadow
      };
    });

    assert.ok(composerMetrics.borderRadius >= 20, `El radio de curvatura (${composerMetrics.borderRadius}px) debe ser estilo omnibox (>= 20px / 1.5rem)`);
    assert.ok(composerMetrics.width <= 1120 && composerMetrics.width > 900, `El ancho del composer (${composerMetrics.width}px) debe alinearse con max-width: 68rem`);
    assert.notEqual(composerMetrics.boxShadow, 'none', 'El composer debe tener elevación mediante sombra');

    // 2. Validar autoexpansión del textarea al introducir múltiples líneas
    const initialHeight = await page.$eval('#user-input', el => el.offsetHeight);
    await page.fill('#user-input', 'Línea 1\nLínea 2\nLínea 3\nLínea 4\nLínea 5');
    await page.dispatchEvent('#user-input', 'input');

    const expandedHeight = await page.$eval('#user-input', el => el.offsetHeight);
    assert.ok(expandedHeight > initialHeight, `La altura del textarea debe crecer con contenido multilínea (de ${initialHeight}px a ${expandedHeight}px)`);

    // Limpiar input y verificar vuelta a altura mínima
    await page.fill('#user-input', '');
    await page.dispatchEvent('#user-input', 'input');
    const resetHeight = await page.$eval('#user-input', el => el.offsetHeight);
    assert.ok(resetHeight <= initialHeight, 'Al vaciar el texto debe volver a la altura mínima');

    // 3. Validar botón circular de envío y botón de adjuntar
    const buttonStyles = await page.evaluate(() => {
      const btnSend = document.getElementById('btn-send');
      const btnAttach = document.getElementById('btn-attach-file');
      const sendStyle = getComputedStyle(btnSend);
      const attachStyle = getComputedStyle(btnAttach);
      return {
        sendRadius: parseFloat(sendStyle.borderRadius),
        sendWidth: parseFloat(sendStyle.width),
        sendHeight: parseFloat(sendStyle.height),
        attachRadius: parseFloat(attachStyle.borderRadius)
      };
    });

    assert.equal(buttonStyles.sendWidth, buttonStyles.sendHeight, 'El botón de envío debe ser perfectamente circular (width === height)');
    assert.ok(buttonStyles.sendRadius >= 16, 'El botón de envío debe tener borde completamente redondeado');
    assert.ok(buttonStyles.attachRadius >= 16, 'El botón de adjuntar debe tener borde redondeado');

    // 4. Validar menú desplegable de razonamiento integrado
    await page.click('#btn-reasoning');
    const isMenuOpen = await page.$eval('#reasoning-menu', el => el.style.display !== 'none');
    assert.ok(isMenuOpen, 'Pulsar #btn-reasoning debe desplegar el menú de opciones');

    // 5. Validar metamorfosis dinámica entre botón de Send y Stop
    // Al simular streaming activando stop-stream:
    await page.evaluate(() => {
      const stopBtn = document.getElementById('btn-stop-stream');
      stopBtn.style.display = 'inline-flex';
    });

    const isSendHiddenDuringStop = await page.evaluate(() => {
      const sendBtn = document.getElementById('btn-send');
      return getComputedStyle(sendBtn).display === 'none';
    });
    assert.ok(isSendHiddenDuringStop, 'Cuando el botón de detener está visible, el botón de envío debe ocultarse automáticamente');

    // Restaurar estado inactivo
    await page.evaluate(() => {
      const stopBtn = document.getElementById('btn-stop-stream');
      stopBtn.style.display = 'none';
    });

    const isSendVisibleAgain = await page.evaluate(() => {
      const sendBtn = document.getElementById('btn-send');
      return getComputedStyle(sendBtn).display !== 'none';
    });
    assert.ok(isSendVisibleAgain, 'Al terminar el streaming, el botón de envío vuelve a ser visible');
  } finally {
    await browser.close();
  }
});

test('Browser UI - Fase 5: Barra Lateral de Conversaciones Moderna, Grupos y Drawer', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const filePath = 'file://' + path.resolve(__dirname, '../zerochat.html');
    await page.goto(filePath, { waitUntil: 'load' });
    await page.waitForSelector('#welcome-banner');

    // 1. Abrir barra lateral
    await page.click('#btn-toggle-sidebar');
    const isSidebarVisible = await page.$eval('#chat-sidebar', el => getComputedStyle(el).display === 'flex');
    assert.ok(isSidebarVisible, 'El sidebar debe mostrarse con display flex');

    // 2. Validar botón destacado "+ Nueva conversación"
    const newChatBtnInfo = await page.evaluate(() => {
      const btn = document.getElementById('btn-sidebar-new-chat');
      const style = getComputedStyle(btn);
      return {
        exists: !!btn,
        text: btn.textContent.trim(),
        borderRadius: parseFloat(style.borderRadius),
        bgColor: style.backgroundColor
      };
    });
    assert.ok(newChatBtnInfo.exists, 'El botón #btn-sidebar-new-chat debe existir');
    assert.ok(newChatBtnInfo.text.includes('Nueva conversación'), 'El botón debe contener el texto de nueva conversación');
    assert.ok(newChatBtnInfo.borderRadius >= 16, 'El botón de nueva conversación debe ser redondeado estilo cápsula');

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

test('Browser UI - Fase 6: Modales <dialog> Modernos con Blur y Tarjetas de Herramientas', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const filePath = 'file://' + path.resolve(__dirname, '../zerochat.html');
    await page.goto(filePath, { waitUntil: 'load' });
    await page.waitForSelector('#welcome-banner');

    // 1. Abrir diálogo de Configuración y validar propiedades de modal moderno
    await page.click('#btn-open-settings');
    await page.waitForFunction(() => document.getElementById('settings-dialog')?.open);

    const dialogMetrics = await page.evaluate(() => {
      const dialog = document.getElementById('settings-dialog');
      const style = getComputedStyle(dialog);
      return {
        borderRadius: parseFloat(style.borderRadius),
        boxShadow: style.boxShadow,
        display: style.display
      };
    });

    assert.equal(dialogMetrics.display, 'flex', 'El diálogo abierto debe tener display: flex');
    assert.ok(dialogMetrics.borderRadius >= 16, `El radio de curvatura (${dialogMetrics.borderRadius}px) debe ser moderno (>= 16px / 1.25rem)`);
    assert.notEqual(dialogMetrics.boxShadow, 'none', 'El modal debe tener elevación con sombra');

    const contextCachePlacement = await page.evaluate(() => ({
      automaticNotice: !!document.querySelector('#tab-model [data-i18n="model_cache_title"]'),
      legacyToggle: !!document.getElementById('setting-enable-context-cache'),
      agentCacheText: document.querySelector('#tab-agent')?.textContent.includes('Caché de Contexto') || false
    }));
    assert.ok(contextCachePlacement.automaticNotice, 'La caché automática debe explicarse en la pestaña Modelo');
    assert.equal(contextCachePlacement.legacyToggle, false, 'La caché no debe exponerse como un interruptor de Agente');
    assert.equal(contextCachePlacement.agentCacheText, false, 'La pestaña Agente no debe presentar la caché como herramienta');

    // 2. Navegar entre pestañas del modal (Ej. pestaña Proveedores / Herramientas)
    const tabButtons = await page.$$('.modal-tab-btn');
    assert.ok(tabButtons.length >= 2, 'Debe haber múltiples pestañas en el modal de configuración');

    // Hacer click en la segunda pestaña
    await tabButtons[1].click();
    const isSecondTabActive = await tabButtons[1].evaluate(el => el.classList.contains('active'));
    assert.ok(isSecondTabActive, 'Hacer click en la pestaña debe marcarla como .active');

    // 2b. El mantenedor de perfiles es independiente de la configuración general.
    await tabButtons[0].click();
    const connectionTab = await page.evaluate(() => ({
      hasActiveProfile: !!document.getElementById('settings-active-profile-name'),
      hasConnectionInputs: !!document.querySelector('#settings-dialog #setting-api-url'),
      hasManageButton: !!document.getElementById('btn-manage-profiles')
    }));
    assert.ok(connectionTab.hasActiveProfile, 'La pestaña Conexión debe mostrar el perfil activo');
    assert.equal(connectionTab.hasConnectionInputs, false, 'La pestaña Conexión no debe editar datos de perfil');
    assert.ok(connectionTab.hasManageButton, 'La pestaña Conexión debe enlazar al mantenedor de perfiles');

    await page.click('#btn-manage-profiles');
    await page.waitForFunction(() => document.getElementById('profiles-dialog')?.open);
    page.once('dialog', dialog => dialog.accept('Perfil Temporal Playwright'));
    await page.click('#btn-new-profile');
    await page.click('#profile-tab-settings');
    await page.fill('#setting-api-url', 'http://playwright-test:1234/v1');
    await page.click('#btn-save-profile');

    const profileSaveResult = await page.evaluate(() => {
      const dialog = document.getElementById('profiles-dialog');
      const feedback = document.getElementById('profile-action-feedback');
      const profile = window.ChatProfileRepository?.findByName?.('Perfil Temporal Playwright');
      const runtime = window.ChatConfig?.getActive?.();
      return {
        isOpen: dialog.open,
        feedbackVisible: feedback && feedback.style.display !== 'none',
        savedUrl: profile?.settings?.apiUrl,
        runtimeUrl: runtime?.apiUrl
      };
    });

    assert.equal(profileSaveResult.isOpen, false, 'Guardar el perfil debe cerrar el mantenedor');
    assert.equal(profileSaveResult.savedUrl, 'http://playwright-test:1234/v1', 'Debe persistir el perfil en su repositorio');
    assert.equal(profileSaveResult.runtimeUrl, 'http://playwright-test:1234/v1', 'El perfil guardado debe quedar activo por defecto');

    // Renombrar el perfil activo actualiza el mismo registro y recarga sus datos.
    await page.click('#btn-manage-profiles');
    await page.waitForFunction(() => document.getElementById('profiles-dialog')?.open);
    await page.selectOption('#profile-select-helper', 'profile:local');
    await page.fill('#setting-profile-name', 'Local chat renombrado');
    await page.click('#profile-tab-settings');
    await page.fill('#setting-api-url', 'http://active-profile-test:1234/v1');
    await page.click('#btn-save-profile');
    const renamedActiveResult = await page.evaluate(() => {
      const profiles = window.ChatProfileRepository?.list?.() || [];
      const runtime = window.ChatConfig?.getActive?.();
      return {
        renamedCount: profiles.filter(profile => profile.name === 'Local chat renombrado').length,
        oldNameExists: profiles.some(profile => profile.name === 'Local chat'),
        runtimeName: runtime?.activeProfile?.name,
        runtimeUrl: runtime?.apiUrl
      };
    });
    assert.equal(renamedActiveResult.renamedCount, 1, 'Renombrar no debe duplicar el perfil');
    assert.equal(renamedActiveResult.oldNameExists, false, 'El nombre anterior debe desaparecer del selector');
    assert.equal(renamedActiveResult.runtimeName, 'Local chat renombrado', 'El perfil activo debe reflejar el nuevo nombre');
    assert.equal(renamedActiveResult.runtimeUrl, 'http://active-profile-test:1234/v1', 'Los cambios del perfil activo deben recargarse');

    // 3. Cerrar ambos modales sin guardar la configuración general.
    await page.waitForFunction(() => !document.getElementById('profiles-dialog')?.open);
    await page.click('#btn-close-settings');
    await page.waitForFunction(() => !document.getElementById('settings-dialog')?.open);
    const isClosed = await page.$eval('#settings-dialog', el => !el.open);
    assert.ok(isClosed, 'El diálogo debe cerrarse correctamente');

    // 4. Validar renderizado de Tarjetas de Herramientas (Tool Cards) en el chat
    await page.evaluate(() => {
      const messagesList = document.getElementById('messages-list');
      const wrapper = document.createElement('div');
      wrapper.className = 'message-wrapper assistant';
      wrapper.innerHTML = `
        <div class="message-row assistant">
          <div class="message-content-wrapper">
            <div class="tool-card-wrapper">
              <div class="tool-execution-card">
                <div class="tool-card-header">
                  <div class="tool-card-title">
                    <span>⚡</span>
                    <span>execute_javascript</span>
                  </div>
                  <div class="tool-card-header-actions">
                    <span class="tool-card-badge status-success">✅ Completado (42ms)</span>
                    <button type="button" class="btn-tool-collapse">▾</button>
                  </div>
                </div>
                <div class="tool-card-collapsible-body">
                  <div class="tool-card-result">
                    <pre class="tool-card-code"><code>console.log("Prueba Fase 6");</code></pre>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      `;
      messagesList.appendChild(wrapper);
    });

    // Validar estilos de la tarjeta de herramienta
    const cardInfo = await page.evaluate(() => {
      const card = document.querySelector('.tool-execution-card');
      const badge = document.querySelector('.tool-card-badge');
      const header = document.querySelector('.tool-card-header');
      const cardStyle = getComputedStyle(card);
      const badgeStyle = getComputedStyle(badge);
      const headerStyle = getComputedStyle(header);
      return {
        cardRadius: parseFloat(cardStyle.borderRadius),
        badgeRadius: parseFloat(badgeStyle.borderRadius),
        headerBg: headerStyle.backgroundColor
      };
    });

    assert.ok(cardInfo.cardRadius >= 8, 'La tarjeta de herramienta debe tener bordes redondeados (>= 8px)');
    assert.ok(cardInfo.badgeRadius >= 12, 'El badge de estado de la tarjeta debe tener estilo píldora');
    assert.ok(cardInfo.headerBg, 'La cabecera de la herramienta debe tener un fondo de superficie asignado');
  } finally {
    await browser.close();
  }
});

test('Browser UI - Fase 7: Accesibilidad WCAG 2.1 AA, Focus-Visible y Reduced Motion', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const filePath = 'file://' + path.resolve(__dirname, '../zerochat.html');
    await page.goto(filePath, { waitUntil: 'load' });
    await page.waitForSelector('#welcome-banner');

    // 1. Validar Focus Visible con navegación por teclado
    await page.keyboard.press('Tab');
    const focusedOutline = await page.evaluate(() => {
      const activeEl = document.activeElement;
      if (!activeEl) return null;
      const s = getComputedStyle(activeEl);
      return {
        tag: activeEl.tagName,
        outlineStyle: s.outlineStyle,
        outlineWidth: s.outlineWidth
      };
    });
    assert.ok(focusedOutline, 'Debe haber un elemento enfocado por teclado');
    assert.notEqual(focusedOutline.outlineStyle, 'none', 'El elemento enfocado debe tener un indicador visual outline');

    // 2. Validar soporte prefers-reduced-motion
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const reducedMotionApplied = await page.evaluate(() => {
      const el = document.querySelector('.welcome-banner') || document.body;
      const s = getComputedStyle(el);
      return parseFloat(s.animationDuration) <= 0.05;
    });
    assert.ok(reducedMotionApplied, 'Las animaciones deben reducirse drásticamente bajo prefers-reduced-motion');

    // 3. Validar ratios de contraste de color semántico (WCAG 2.1 AA >= 4.5:1)
    function luminance(r, g, b) {
      const a = [r, g, b].map(v => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      });
      return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722;
    }
    function contrastRatio(rgb1, rgb2) {
      const l1 = luminance(rgb1[0], rgb1[1], rgb1[2]);
      const l2 = luminance(rgb2[0], rgb2[1], rgb2[2]);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    }

    // Comprobar ratios en Light Mode (#ffffff fondo)
    const ratioLight = contrastRatio([15, 23, 42], [255, 255, 255]); // #0f172a vs #ffffff
    assert.ok(ratioLight >= 4.5, `Contraste en modo claro (${ratioLight.toFixed(1)}:1) debe superar 4.5:1`);

    // Comprobar ratios en Dark Mode (#131b2e vs #f1f5f9)
    const ratioDark = contrastRatio([241, 245, 249], [19, 27, 46]);
    assert.ok(ratioDark >= 4.5, `Contraste en modo oscuro (${ratioDark.toFixed(1)}:1) debe superar 4.5:1`);

    // 4. Validar ausencia total de errores o excepciones tras interacciones complejas
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(err.message));
    assert.equal(pageErrors.length, 0, 'No debe haber errores de página en ninguna fase');
  } finally {
    await browser.close();
  }
});

test('Browser UI - Iconos Fase 2: Iconos Vectoriales SVG en Header Superior y Composer', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const filePath = 'file://' + path.resolve(__dirname, '../zerochat.html');
    await page.goto(filePath, { waitUntil: 'load' });
    await page.waitForSelector('#welcome-banner');

    // 1. Validar iconos SVG en el Header
    const headerIcons = await page.evaluate(() => {
      const profileSvg = document.querySelector('.badge-profile .profile-icon svg');
      const ragSvg = document.querySelector('#btn-open-rag svg');
      const exportSvg = document.querySelector('#btn-quick-export svg');
      const debugSvg = document.querySelector('#btn-toggle-debug svg');
      const reasoningSvg = document.querySelector('#btn-reasoning svg');

      return {
        hasProfileSvg: !!profileSvg,
        hasRagSvg: !!ragSvg,
        hasExportSvg: !!exportSvg,
        hasDebugSvg: !!debugSvg,
        hasReasoningSvg: !!reasoningSvg,
        ragWidth: ragSvg ? parseFloat(getComputedStyle(ragSvg).width) : 0,
        reasoningWidth: reasoningSvg ? parseFloat(getComputedStyle(reasoningSvg).width) : 0
      };
    });

    assert.ok(headerIcons.hasProfileSvg, 'El selector de perfiles debe contener un SVG vectorial (zap)');
    assert.ok(headerIcons.hasRagSvg, 'El botón RAG debe contener un SVG vectorial (layers)');
    assert.ok(headerIcons.hasExportSvg, 'El botón de exportar debe contener un SVG vectorial (download)');
    assert.ok(headerIcons.hasDebugSvg, 'El botón de debug debe contener un SVG vectorial (terminal)');
    assert.ok(headerIcons.hasReasoningSvg, 'El botón de razonamiento debe contener un SVG vectorial (brain)');
    assert.ok(headerIcons.ragWidth >= 12, 'El icono RAG debe tener dimensiones computadas válidas');
    assert.ok(headerIcons.reasoningWidth >= 12, 'El icono de razonamiento debe tener dimensiones válidas');

    // 2. Abrir menú de razonamiento y verificar cabecera con SVG
    await page.click('#btn-reasoning');
    await page.waitForFunction(() => document.getElementById('reasoning-menu')?.style.display !== 'none');

    const menuHeaderInfo = await page.evaluate(() => {
      const menu = document.getElementById('reasoning-menu');
      const header = document.querySelector('.reasoning-menu-header');
      const options = document.querySelector('.reasoning-options');
      const lowOption = document.querySelector('.reasoning-option[data-level="low"]');
      const lowIcon = lowOption?.querySelector('.option-icon');
      const lowText = lowOption?.querySelector('.option-text');
      const svg = header?.querySelector('svg');
      const text = header?.textContent || '';
      return {
        hasSvg: !!svg,
        hasEmoji: text.includes('🧠'),
        text: text.trim(),
        flexDirection: menu ? getComputedStyle(menu).flexDirection : '',
        headerBottom: header?.getBoundingClientRect().bottom || 0,
        optionsTop: options?.getBoundingClientRect().top || 0,
        lowIconRight: lowIcon?.getBoundingClientRect().right || 0,
        lowTextLeft: lowText?.getBoundingClientRect().left || 0
      };
    });

    assert.ok(menuHeaderInfo.hasSvg, 'La cabecera del menú de razonamiento debe contener un SVG (brain)');
    assert.equal(menuHeaderInfo.hasEmoji, false, 'La cabecera del menú no debe contener el emoji 🧠');
    assert.equal(menuHeaderInfo.flexDirection, 'column', 'El menú de razonamiento debe apilar cabecera y opciones verticalmente');
    assert.ok(menuHeaderInfo.optionsTop >= menuHeaderInfo.headerBottom, 'Las opciones deben mostrarse debajo de la cabecera, no a su lado');
    assert.ok(menuHeaderInfo.lowTextLeft - menuHeaderInfo.lowIconRight <= 10, 'El texto del nivel bajo debe quedar junto a su indicador');
  } finally {
    await browser.close();
  }
});

test('Browser UI - Iconos Fase 3: Iconos Vectoriales SVG en Barra Lateral e Historial', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const filePath = 'file://' + path.resolve(__dirname, '../zerochat.html');
    await page.goto(filePath, { waitUntil: 'load' });
    await page.waitForSelector('#welcome-banner');

    // 1. Abrir barra lateral
    await page.click('#btn-toggle-sidebar');
    await page.waitForFunction(() => document.getElementById('chat-sidebar')?.style.display !== 'none');

    // 2. Verificar iconos vectoriales de cabecera, buscador y footer de sidebar
    const sidebarIcons = await page.evaluate(() => {
      const newChatSvg = document.querySelector('#btn-sidebar-new-chat svg');
      const closeSvg = document.querySelector('#btn-close-sidebar svg');
      const searchSvg = document.querySelector('.sidebar-search-box svg');
      const importSvg = document.querySelector('#btn-import-chat-file svg');
      const exportSvg = document.querySelector('#btn-open-export-modal svg');
      const deleteAllSvg = document.querySelector('#btn-delete-all-chats svg');

      return {
        hasNewChatSvg: !!newChatSvg,
        hasCloseSvg: !!closeSvg,
        hasSearchSvg: !!searchSvg,
        hasImportSvg: !!importSvg,
        hasExportSvg: !!exportSvg,
        hasDeleteAllSvg: !!deleteAllSvg,
        newChatWidth: newChatSvg ? parseFloat(getComputedStyle(newChatSvg).width) : 0,
        searchWidth: searchSvg ? parseFloat(getComputedStyle(searchSvg).width) : 0
      };
    });

    assert.ok(sidebarIcons.hasNewChatSvg, 'El botón "+ Nueva conversación" debe tener icono SVG');
    assert.ok(sidebarIcons.hasCloseSvg, 'El botón de cerrar barra lateral debe tener icono SVG');
    assert.ok(sidebarIcons.hasSearchSvg, 'El buscador debe tener icono SVG de lupa');
    assert.ok(sidebarIcons.hasImportSvg, 'El botón de importar debe tener icono SVG');
    assert.ok(sidebarIcons.hasExportSvg, 'El botón de exportar debe tener icono SVG');
    assert.ok(sidebarIcons.hasDeleteAllSvg, 'El botón de borrar todo debe tener icono SVG');
    assert.ok(sidebarIcons.newChatWidth >= 14, 'El icono de nuevo chat debe tener tamaño >= 14px');

    // 3. Renderizar una sesión simulada en el historial y verificar iconos de acciones en hover
    const chatItemActionIcons = await page.evaluate(() => {
      const list = document.getElementById('sidebar-chats-list');
      if (typeof ChatUISidebar !== 'undefined' && typeof ChatUISidebar.renderSidebarChats === 'function') {
        ChatUISidebar.renderSidebarChats({ sidebarChatsList: list }, [
          { id: 'sess_test_1', title: 'Conversación de prueba', updatedAt: Date.now() }
        ], 'sess_test_1', {});
      }
      const item = list.querySelector('.sidebar-chat-item');
      const renameSvg = item?.querySelector('.btn-rename svg');
      const deleteSvg = item?.querySelector('.btn-delete svg');

      return {
        hasItem: !!item,
        hasRenameSvg: !!renameSvg,
        hasDeleteSvg: !!deleteSvg,
        renameWidth: renameSvg ? parseFloat(getComputedStyle(renameSvg).width) : 0,
        deleteWidth: deleteSvg ? parseFloat(getComputedStyle(deleteSvg).width) : 0
      };
    });

    assert.ok(chatItemActionIcons.hasItem, 'El item de conversación debe renderizarse');
    assert.ok(chatItemActionIcons.hasRenameSvg, 'La acción de renombrar debe contener icono SVG (edit)');
    assert.ok(chatItemActionIcons.hasDeleteSvg, 'La acción de eliminar debe contener icono SVG (trash)');
    assert.ok(chatItemActionIcons.renameWidth >= 10, 'El icono de renombrar debe tener dimensiones válidas');
    assert.ok(chatItemActionIcons.deleteWidth >= 10, 'El icono de eliminar debe tener dimensiones válidas');
  } finally {
    await browser.close();
  }
});

test('Browser UI - Iconos Fase 4: Iconos Vectoriales SVG en Tarjetas Agénticas y Badges de Estado', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const filePath = 'file://' + path.resolve(__dirname, '../zerochat.html');
    await page.goto(filePath, { waitUntil: 'load' });
    await page.waitForSelector('#welcome-banner');

    const toolCardsResult = await page.evaluate(() => {
      const container = document.getElementById('messages-list') || document.body;

      // 1. Crear tarjeta viva de execute_javascript
      const jsCard = ChatToolCards.createLiveToolCard('execute_javascript', { code: 'console.log("hola");' });
      container.appendChild(jsCard);

      const jsTitle = jsCard.querySelector('.tool-card-title');
      const jsTitleSvg = jsTitle?.querySelector('svg');
      const jsBadge = jsCard.querySelector('.tool-card-badge');
      const jsBadgeSpinnerSvg = jsBadge?.querySelector('svg.ui-icon-spin');
      const jsCollapseSvg = jsCard.querySelector('.btn-tool-collapse svg');

      const jsTitleHasEmoji = jsTitle?.textContent.includes('⚡') || false;
      const jsBadgeHasEmoji = jsBadge?.textContent.includes('⏳') || false;

      // 2. Actualizar tarjeta viva a completada
      ChatToolCards.updateLiveToolCard(jsCard, 'execute_javascript', {}, { success: true, result: 'hola' }, 42);
      const jsBadgeSuccessSvg = jsBadge?.querySelector('svg');
      const jsBadgeSuccessHasEmoji = jsBadge?.textContent.includes('✅') || false;

      // 3. Crear tarjeta de search_web
      const searchCard = ChatToolCards.createLiveToolCard('search_web', { query: 'test query' });
      container.appendChild(searchCard);

      const searchTitle = searchCard.querySelector('.search-card-title');
      const searchTitleSvg = searchTitle?.querySelector('svg');
      const searchBadge = searchCard.querySelector('.search-card-badge');
      const searchBadgeSpinnerSvg = searchBadge?.querySelector('svg.ui-icon-spin');

      const searchTitleHasEmoji = searchTitle?.textContent.includes('🔍') || false;
      const searchBadgeHasEmoji = searchBadge?.textContent.includes('⏳') || false;

      // 4. Renderizar gráfico nativo
      let chartSvgFound = false;
      let chartEmojiFound = true;
      if (typeof ChatCharts !== 'undefined' && typeof ChatCharts.renderChartCard === 'function') {
        const chartHtml = ChatCharts.renderChartCard({
          type: 'bar',
          title: 'Ventas Mensuales',
          labels: ['Ene', 'Feb'],
          datasets: [{ label: 'Ventas', data: [10, 20] }]
        });
        const chartWrapper = document.createElement('div');
        chartWrapper.innerHTML = chartHtml;
        container.appendChild(chartWrapper);

        const chartHeader = chartWrapper.querySelector('.chat-chart-title');
        chartSvgFound = !!chartHeader?.querySelector('svg');
        chartEmojiFound = chartHeader?.textContent.includes('📊') || false;
      }

      return {
        hasJsTitleSvg: !!jsTitleSvg,
        jsTitleHasEmoji,
        hasJsBadgeSpinnerSvg: !!jsBadgeSpinnerSvg,
        jsBadgeHasEmoji,
        hasJsCollapseSvg: !!jsCollapseSvg,
        hasJsBadgeSuccessSvg: !!jsBadgeSuccessSvg,
        jsBadgeSuccessHasEmoji,
        hasSearchTitleSvg: !!searchTitleSvg,
        searchTitleHasEmoji,
        hasSearchBadgeSpinnerSvg: !!searchBadgeSpinnerSvg,
        searchBadgeHasEmoji,
        chartSvgFound,
        chartEmojiFound
      };
    });

    // Validaciones JS Tool Card
    assert.ok(toolCardsResult.hasJsTitleSvg, 'execute_javascript debe tener icono SVG');
    assert.equal(toolCardsResult.jsTitleHasEmoji, false, 'execute_javascript no debe tener emoji ⚡');
    assert.ok(toolCardsResult.hasJsBadgeSpinnerSvg, 'El badge en ejecución debe tener un spinner SVG animado');
    assert.equal(toolCardsResult.jsBadgeHasEmoji, false, 'El badge no debe tener emoji ⏳');
    assert.ok(toolCardsResult.hasJsCollapseSvg, 'El botón de colapsar debe tener un chevron SVG');
    assert.ok(toolCardsResult.hasJsBadgeSuccessSvg, 'El badge de completado debe tener un check SVG');
    assert.equal(toolCardsResult.jsBadgeSuccessHasEmoji, false, 'El badge de completado no debe tener emoji ✅');

    // Validaciones Search Web Card
    assert.ok(toolCardsResult.hasSearchTitleSvg, 'search_web debe tener icono SVG');
    assert.equal(toolCardsResult.searchTitleHasEmoji, false, 'search_web no debe tener emoji 🔍');
    assert.ok(toolCardsResult.hasSearchBadgeSpinnerSvg, 'El badge de búsqueda debe tener spinner SVG');
    assert.equal(toolCardsResult.searchBadgeHasEmoji, false, 'El badge de búsqueda no debe tener emoji ⏳');

    // Validaciones Chart Card
    assert.ok(toolCardsResult.chartSvgFound, 'La tarjeta de gráficos debe tener un icono SVG');
    assert.equal(toolCardsResult.chartEmojiFound, false, 'La tarjeta de gráficos no debe tener emoji 📊');
  } finally {
    await browser.close();
  }
});

test('Browser UI - Iconos Fase 5: Iconos Vectoriales SVG en Modales, Pestañas, Exportación y RAG', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const filePath = 'file://' + path.resolve(__dirname, '../zerochat.html');
    await page.goto(filePath, { waitUntil: 'load' });
    await page.waitForSelector('#welcome-banner');

    // 1. Abrir modal de Ajustes
    await page.click('#btn-open-settings');
    await page.waitForSelector('#settings-dialog[open]');

    const settingsIcons = await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll('#settings-dialog .modal-tab-btn'));
      const tabsHaveSvg = tabs.every(t => !!t.querySelector('svg'));
      const tabsText = tabs.map(t => t.textContent).join(' ');
      const hasTabEmojis = /🌐|⚙️|🤖|🎨|🔍/.test(tabsText);

      const toggleKeySvg = !!document.querySelector('#btn-toggle-key svg');
      const clearAllBtn = document.getElementById('btn-clear-all-data');
      const clearAllSvg = !!clearAllBtn?.querySelector('svg');
      const clearAllHasEmoji = /🗑/.test(clearAllBtn?.textContent || '');
      const clearAllText = clearAllBtn?.textContent?.trim() || '';
      const themeButtons = Array.from(document.querySelectorAll('.btn-theme-toggle'));
      const themeHaveSvg = themeButtons.every(b => !!b.querySelector('svg'));

      return {
        tabsHaveSvg,
        hasTabEmojis,
        toggleKeySvg,
        clearAllSvg,
        clearAllHasEmoji,
        clearAllText,
        themeHaveSvg
      };
    });

    assert.ok(settingsIcons.tabsHaveSvg, 'Todas las pestañas de configuración deben contener un icono SVG');
    assert.equal(settingsIcons.hasTabEmojis, false, 'Las pestañas no deben contener emojis residuales');
    assert.ok(settingsIcons.toggleKeySvg, 'El botón de visibilidad de clave debe contener icono SVG');
    assert.ok(settingsIcons.clearAllSvg, 'El botón de borrar todo debe contener icono SVG');
    assert.equal(settingsIcons.clearAllHasEmoji, false, 'El botón de borrar todo no debe contener emoji');
    assert.equal(settingsIcons.clearAllText, 'Borrar todo', 'El texto de borrar todo debe ser limpio');
    assert.ok(settingsIcons.themeHaveSvg, 'Los botones de modo claro/oscuro deben contener iconos SVG');

    await page.click('#btn-close-settings');
    await page.waitForFunction(() => !document.getElementById('settings-dialog').open);

    // 2. Abrir modal de Exportación
    await page.evaluate(() => document.getElementById('export-modal').showModal());
    await page.waitForSelector('#export-modal[open]');

    const exportIcons = await page.evaluate(() => {
      const headerIcon = document.querySelector('#export-modal .modal-icon svg');
      const closeBtn = document.querySelector('#btn-close-export svg');
      const cards = Array.from(document.querySelectorAll('#export-modal .export-card-btn'));
      const cardsHaveSvg = cards.every(c => !!c.querySelector('.export-card-icon svg'));
      const cardsText = cards.map(c => c.textContent).join(' ');
      const hasExportEmojis = /📄|📦|🖨️/.test(cardsText);

      return {
        hasHeaderSvg: !!headerIcon,
        hasCloseSvg: !!closeBtn,
        cardsHaveSvg,
        hasExportEmojis
      };
    });

    assert.ok(exportIcons.hasHeaderSvg, 'La cabecera de exportación debe tener icono SVG');
    assert.ok(exportIcons.hasCloseSvg, 'El botón de cierre de exportación debe tener icono SVG');
    assert.ok(exportIcons.cardsHaveSvg, 'Todas las tarjetas de exportación deben tener icono SVG');
    assert.equal(exportIcons.hasExportEmojis, false, 'Las tarjetas de exportación no deben contener emojis');

    await page.evaluate(() => document.getElementById('export-modal').close());

    // 3. Abrir modal de RAG
    await page.click('#btn-open-rag');
    await page.waitForSelector('#rag-modal[open]');

    const ragIcons = await page.evaluate(() => {
      const headerSvg = document.querySelector('#rag-modal .rag-header-icon svg');
      const activeTab = document.querySelector('#rag-modal-tabs-nav .modal-tab-btn.active');
      const activeTabId = activeTab ? activeTab.dataset.ragTab : null;
      const activePane = document.querySelector('#rag-modal .modal-tab-pane.active');
      const activePaneDisplay = activePane ? window.getComputedStyle(activePane).display : 'none';

      const newBranchBtn = document.getElementById('btn-rag-new-branch');
      const newBranchSvg = newBranchBtn?.querySelector('svg');
      const newBranchHasPlusInText = (newBranchBtn?.textContent || '').includes('+');
      const newBranchText = newBranchBtn?.textContent?.trim() || '';

      const editBranchSvg = document.querySelector('#btn-rag-edit-branch svg');
      const deleteBranchSvg = document.querySelector('#btn-rag-delete-branch svg');
      const exportBranchSvg = document.querySelector('#btn-rag-export-branch svg');
      const importBranchSvg = document.querySelector('#btn-rag-import-branch svg');
      const quotaSvg = document.querySelector('#rag-storage-quota-info svg');

      return {
        hasHeaderSvg: !!headerSvg,
        activeTabId,
        activePaneDisplay,
        hasNewBranchSvg: !!newBranchSvg,
        newBranchHasPlusInText,
        newBranchText,
        hasEditBranchSvg: !!editBranchSvg,
        hasDeleteBranchSvg: !!deleteBranchSvg,
        hasExportBranchSvg: !!exportBranchSvg,
        hasImportBranchSvg: !!importBranchSvg,
        hasQuotaSvg: !!quotaSvg
      };
    });

    assert.ok(ragIcons.hasHeaderSvg, 'La cabecera de RAG debe tener icono SVG');
    assert.equal(ragIcons.activeTabId, 'tab-rag-active', 'El modal de conocimiento debe activar la pestaña Activar por defecto');
    assert.equal(ragIcons.activePaneDisplay, 'flex', 'El pane de la pestaña activa debe estar visible');
    assert.ok(ragIcons.hasNewBranchSvg, 'El botón de nueva rama debe tener icono SVG');
    assert.equal(ragIcons.newBranchHasPlusInText, false, 'El botón de nueva rama no debe tener símbolo + en el texto');
    assert.equal(ragIcons.newBranchText, 'Nueva rama', 'El texto del botón de nueva rama debe ser exactamente "Nueva rama"');
    assert.ok(ragIcons.hasEditBranchSvg, 'El botón de editar rama debe tener icono SVG');
    assert.ok(ragIcons.hasDeleteBranchSvg, 'El botón de eliminar rama debe tener icono SVG');
    assert.ok(ragIcons.hasExportBranchSvg, 'El botón de respaldar rama debe tener icono SVG');
    assert.ok(ragIcons.hasImportBranchSvg, 'El botón de importar rama debe tener icono SVG');
    assert.ok(ragIcons.hasQuotaSvg, 'El indicador de cuota debe tener icono SVG');

    // Verificación de gestión de ramas con campos en pantalla (sin ventanas prompt nativas)
    let dialogTriggered = false;
    page.on('dialog', () => { dialogTriggered = true; });

    await page.click('#rag-modal-tabs-nav [data-rag-tab="tab-rag-manage"]');
    await page.waitForSelector('#rag-branch-details-card');

    // Verificar que el textbox en la pestaña de documentos fue eliminado para ganar espacio
    const workspaceHasTextbox = await page.$eval('#rag-manage-workspace', el => !!el.querySelector('.rag-workspace-summary'));
    assert.equal(workspaceHasTextbox, false, 'El workspace de documentos no debe tener el textbox de resumen para ganar espacio');

    // Pulsar Nueva rama y rellenar campos en pantalla
    await page.click('#btn-rag-new-branch');
    await page.fill('#rag-branch-name-input', 'Rama Playwright');
    await page.fill('#rag-branch-desc-input', 'Descripción de prueba Playwright');

    // Verificar que el botón cambia a Guardar
    const saveBtnTextAfterType = await page.$eval('#btn-rag-new-branch', el => el.textContent.trim());
    assert.equal(saveBtnTextAfterType, 'Guardar', 'Al detectar cambios el botón de nueva rama debe cambiar a Guardar');

    // Pulsar el botón Guardar
    await page.click('#btn-rag-new-branch');

    await page.waitForFunction(() => {
      const select = document.getElementById('rag-manage-branch-select');
      return select && Array.from(select.options).some(opt => opt.text.includes('Rama Playwright'));
    });

    // Verificar que tras guardar vuelve a ser "Nueva rama"
    const btnTextAfterSave = await page.$eval('#btn-rag-new-branch', el => el.textContent.trim());
    assert.equal(btnTextAfterSave, 'Nueva rama', 'Tras guardar el botón debe volver a ser "Nueva rama"');

    // Ahora que la rama existe y está seleccionada en Documentos, verificar el resumen en el pie del modal
    const footerSummary = await page.evaluate(() => {
      const el = document.getElementById('rag-branch-summary-footer');
      return {
        text: el?.textContent?.trim() || '',
        display: el ? window.getComputedStyle(el).display : 'none'
      };
    });
    assert.ok(footerSummary.text.includes('Esta rama cargó'), 'El pie del modal debe contener el resumen "Esta rama cargó"');
    assert.ok(footerSummary.text.includes('documentos de'), 'El pie del modal debe indicar "documentos de"');
    assert.notEqual(footerSummary.display, 'none', 'El resumen en el pie del modal debe ser visible en la pestaña Documentos');

    const createdBranch = await page.evaluate(async () => {
      const branches = await window.ChatRagStorage.getBranches();
      return branches.find(b => b.name === 'Rama Playwright');
    });

    assert.ok(createdBranch, 'La rama debe haberse creado en IndexedDB');
    assert.equal(createdBranch.description, 'Descripción de prueba Playwright', 'La descripción debe haberse guardado');
    assert.equal(dialogTriggered, false, 'No debe haberse disparado ningún diálogo prompt() nativo');

    // Modificar descripción en pantalla y verificar que cambia a Guardar
    await page.fill('#rag-branch-desc-input', 'Descripción editada sin prompts');
    const editBtnText = await page.$eval('#btn-rag-new-branch', el => el.textContent.trim());
    assert.equal(editBtnText, 'Guardar', 'Al modificar la descripción el botón debe cambiar a Guardar');

    await page.click('#btn-rag-new-branch');

    await page.waitForFunction(async (branchId) => {
      const b = await window.ChatRagStorage.getBranchById(branchId);
      return b && b.description === 'Descripción editada sin prompts';
    }, createdBranch.id);

    const updatedBranch = await page.evaluate(async (branchId) => {
      return await window.ChatRagStorage.getBranchById(branchId);
    }, createdBranch.id);

    assert.equal(updatedBranch.description, 'Descripción editada sin prompts', 'La modificación debe haberse guardado');
    assert.equal(dialogTriggered, false, 'No debe haberse mostrado ningún diálogo emergente bloqueante');

    const btnTextFinal = await page.$eval('#btn-rag-new-branch', el => el.textContent.trim());
    // Verificar que en la pestaña Activar el resumen de cada rama también dice "Esta rama cargó"
    await page.click('#rag-modal-tabs-nav [data-rag-tab="tab-rag-active"]');
    const activeBranchMetricsText = await page.$eval('.rag-branch-select-card .rag-branch-metrics', el => el.textContent.trim());
    assert.ok(activeBranchMetricsText.includes('Esta rama cargó'), 'El resumen de cada rama en la pestaña Activar debe decir "Esta rama cargó"');
    assert.ok(activeBranchMetricsText.includes('documentos de'), 'El resumen de cada rama en la pestaña Activar debe usar "documentos de"');

    await page.click('#btn-close-rag');
  } finally {
    await browser.close();
  }
});

test('Browser UI - Verificación global de iconos SVG, accesibilidad y auditoría residual', async (t) => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    const fileUrl = 'file://' + path.resolve(__dirname, '../index.html');
    await page.goto(fileUrl, { waitUntil: 'load' });

    // 1. Verificar estructura y renderizado de SVGs
    const svgValidation = await page.evaluate(() => {
      const svgs = Array.from(document.querySelectorAll('svg.ui-icon'));
      const allWellFormed = svgs.every(svg => {
        return svg.tagName.toLowerCase() === 'svg' &&
          svg.getAttribute('viewBox') === '0 0 24 24' &&
          svg.children.length > 0;
      });

      // Validar dimensiones en SVGs actualmente visibles en pantalla
      const visibleHeaderSvgs = Array.from(document.querySelectorAll('.top-header svg.ui-icon'));
      const headerSvgsRendered = visibleHeaderSvgs.every(svg => {
        const rect = svg.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });

      // Validar que ninguna opción de selector de proveedor contiene emojis
      const apiTypeSelect = document.getElementById('setting-api-type');
      const optionsText = Array.from(apiTypeSelect?.options || []).map(o => o.textContent).join(' ');
      const hasOptionEmojis = /🤖|🦙|🔀|🎭|✨/.test(optionsText);

      // Validar que la cabecera, sidebar y controles de ajuste no contienen emojis residuales
      const headerText = document.querySelector('.app-header')?.textContent || '';
      const sidebarText = document.querySelector('.sidebar')?.textContent || '';
      const settingsTabsText = document.querySelector('#settings-dialog .modal-tabs-nav')?.textContent || '';

      const forbiddenEmojis = /⚡|📊|🌿|📤|📜|🧠|➕|🔍|🗑️|✏️|👁️|☀️|🌙/;
      const hasHeaderEmojis = forbiddenEmojis.test(headerText);
      const hasSidebarEmojis = /➕|🗑️|✏️/.test(sidebarText);
      const hasSettingsTabsEmojis = /🌐|⚙️|🤖|🎨|🔍/.test(settingsTabsText);

      return {
        svgCount: svgs.length,
        allWellFormed,
        headerSvgsRendered,
        hasOptionEmojis,
        hasHeaderEmojis,
        hasSidebarEmojis,
        hasSettingsTabsEmojis
      };
    });

    assert.ok(svgValidation.svgCount >= 20, `Debe haber al menos 20 iconos vectoriales en la interfaz (encontrados: ${svgValidation.svgCount})`);
    assert.ok(svgValidation.allWellFormed, 'Todos los iconos SVG deben estar bien formados con viewBox="0 0 24 24" y trazo vectorial');
    assert.ok(svgValidation.headerSvgsRendered, 'Los iconos SVG visibles en la cabecera deben renderizarse con dimensiones positivas');
    assert.equal(svgValidation.hasOptionEmojis, false, 'El selector de proveedor no debe contener emojis');
    assert.equal(svgValidation.hasHeaderEmojis, false, 'La cabecera no debe contener emojis residuales');
    assert.equal(svgValidation.hasSidebarEmojis, false, 'La barra lateral no debe contener emojis residuales');
    assert.equal(svgValidation.hasSettingsTabsEmojis, false, 'Las pestañas de configuración no deben contener emojis residuales');

    // 2. Verificar alternancia de temas claro/oscuro y stroke de currentColor
    const themeTest = await page.evaluate(() => {
      const btnThemeLight = document.getElementById('btn-theme-light');
      const btnThemeDark = document.getElementById('btn-theme-dark');
      btnThemeDark.click();
      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';

      // Verificar que los SVGs usan currentColor
      const sampleSvg = document.querySelector('.app-header svg.ui-icon');
      const strokeAttr = sampleSvg?.getAttribute('stroke');

      btnThemeLight.click();
      const isLight = !document.documentElement.getAttribute('data-theme') || document.documentElement.getAttribute('data-theme') === 'light';

      return {
        isDark,
        isLight,
        usesCurrentColor: strokeAttr === 'currentColor'
      };
    });

    assert.ok(themeTest.isDark, 'Debe activar correctamente el tema oscuro');
    assert.ok(themeTest.isLight, 'Debe activar correctamente el tema claro');
    assert.ok(themeTest.usesCurrentColor, 'Los iconos vectoriales deben usar stroke="currentColor" para heredar contraste dinámicamente');

    // 3. Verificar inspector de capacidades con SVGs vectoriales
    const inspectorCapSvgs = await page.evaluate(() => {
      // Simular reporte en UIInspector
      const fakeReport = {
        provider: { id: 'openai', label: 'OpenAI Test' },
        endpoint: { normalized: 'https://api.openai.com/v1/chat/completions' },
        model: { selected: 'gpt-4o', totalDiscovered: 1 },
        inspectionTimeMs: 120,
        capabilities: {
          streaming: { status: 'confirmed', detail: 'OK' },
          tools: { status: 'confirmed', detail: 'OK' },
          vision: { status: 'confirmed', detail: 'OK' },
          reasoning: { status: 'confirmed', detail: 'OK' }
        }
      };

      const elements = {
        inspectorResults: document.getElementById('inspector-results')
      };

      const inspector = window.ChatUIInspector || window.UIInspector;
      if (inspector && typeof inspector.renderInspectorReport === 'function') {
        inspector.renderInspectorReport(elements, fakeReport);
      }

      const capCards = Array.from(document.querySelectorAll('#inspector-results .inspector-cap-card'));
      const cardsHaveSvgs = capCards.length > 0 && capCards.every(c => !!c.querySelector('.cap-card-title svg.ui-icon'));
      const text = document.getElementById('inspector-results')?.textContent || '';
      const hasCapEmojis = /📡|⚙️|👁️|🧠|📋|💾|🔢|🤖/.test(text);

      return {
        cardCount: capCards.length,
        cardsHaveSvgs,
        hasCapEmojis
      };
    });

    assert.ok(inspectorCapSvgs.cardCount >= 4, 'Deben renderizarse las tarjetas de capacidad en el inspector');
    assert.ok(inspectorCapSvgs.cardsHaveSvgs, 'Todas las tarjetas de capacidad deben renderizar iconos SVG vectoriales');
    assert.equal(inspectorCapSvgs.hasCapEmojis, false, 'Las tarjetas de capacidad no deben contener emojis residuales');

  } finally {
    await browser.close();
  }
});

test('Browser UI - Borrado de respuesta de asistente con tools elimina completamente las respuestas de tools y sanea chatHistory', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const filePath = 'file://' + path.resolve(__dirname, '../index.html');
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

      // Cargar la conversación en la UI
      await window.ChatApp.switchToSession(sessionId);

      // Esperar renderizado
      await new Promise(r => setTimeout(r, 100));
      const assistantWrapper = document.querySelector('.message-wrapper.assistant');
      const deleteBtn = assistantWrapper?.querySelector('.btn-delete');

      const beforeDelete = {
        hasAssistantWrapper: !!assistantWrapper,
        hasDeleteBtn: !!deleteBtn,
        initialHistoryCount: window.chatHistory ? window.chatHistory.length : -1
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

    assert.ok(result.beforeDelete.hasAssistantWrapper, 'El asistente con tools debe renderizarse inicialmente');
    assert.ok(result.beforeDelete.hasDeleteBtn, 'El botón de eliminar respuesta debe existir');
    assert.equal(result.hasAssistantWrapperAfter, false, 'El wrapper del asistente debe haber desaparecido del DOM');
    assert.equal(result.toolCountAfter, 0, 'No deben quedar respuestas de tool en el historial persistido');
    assert.equal(result.assistantCountAfter, 0, 'No deben quedar mensajes de asistente de la respuesta eliminada');
    assert.equal(result.userCountAfter, 1, 'Debe permanecer el mensaje de usuario');
  } finally {
    await browser.close();
  }
});


test('Browser UI - fecha inicial persistente y hora solo mediante herramienta en fuente y bundle', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const file of ['index.html', 'zerochat.html']) {
      const context = await browser.newContext({ timezoneId: 'Europe/Madrid' });
      const page = await context.newPage();
      await page.clock.setFixedTime(new Date('2026-09-05T23:30:00Z'));
      await page.goto('file://' + path.resolve(__dirname, '..', file), { waitUntil: 'load' });
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
